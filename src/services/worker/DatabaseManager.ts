
import { Database } from 'bun:sqlite';
import { SessionStore } from '../sqlite/SessionStore.js';
import { SessionSearch } from '../sqlite/SessionSearch.js';
import { openGuardedSqliteDatabase } from '../sqlite/connection.js';
import { ChromaSync } from '../sync/ChromaSync.js';
import { CloudSync, isCloudSyncConfigured } from '../sync/CloudSync.js';
import { BackupManager } from '../backup/BackupManager.js';
import { S3SyncManager } from '../s3sync/S3SyncManager.js';
import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH, DB_PATH, DATA_DIR, ensurePrivateDir } from '../../shared/paths.js';
import { MediaStore } from '../media/store.js';
import { MediaCloudClient, MediaCloudReplicaResolver, MediaCloudSync, mediaCloudUploadsEnabled } from '../media/cloud.js';
import { cmemProOrigin } from '../../shared/cmem-gateway.js';
import { MediaError } from '../../shared/media-contract.js';
import { logger } from '../../utils/logger.js';
import { clearSyncHealth, defaultSyncHealthFilePath } from '../../shared/sync-health.js';
import { purgeUndrainableSyncOutbox } from '../sync/outbox-purge.js';
import { purgeLinkedToolUses } from '../sqlite/tool-uses.js';
import { parseRetentionDays } from '../../shared/retention-days.js';
import type { DBSession } from '../worker-types.js';
import { ensureLocalDeviceIdentity } from '../sync/local-device-identity.js';
import { SyncRecoveryReader } from '../sync/SyncRecoveryReader.js';
import { initializeConflictRecoverySchema, SyncConflictRecovery } from '../sync/SyncConflictRecovery.js';

/**
 * The S3 Sync settings a manager construction bakes in: a change to any of
 * them needs a fresh manager, not just a tick (the tick re-reads nothing).
 * The identity the setup page's save is judged against.
 */
function s3SyncConstructionKey(settings: {
  CLAUDE_MEM_S3_SYNC_ENDPOINT?: string;
  CLAUDE_MEM_S3_SYNC_BUCKET?: string;
  CLAUDE_MEM_S3_SYNC_REGION?: string;
  CLAUDE_MEM_S3_SYNC_INCLUDE_CHROMA?: string;
  CLAUDE_MEM_S3_SYNC_DEVICE?: string;
  CLAUDE_MEM_S3_SYNC_MERGE_INTERVAL_MINUTES?: string;
}): string {
  return [
    settings.CLAUDE_MEM_S3_SYNC_ENDPOINT ?? '',
    settings.CLAUDE_MEM_S3_SYNC_BUCKET ?? '',
    settings.CLAUDE_MEM_S3_SYNC_REGION ?? '',
    settings.CLAUDE_MEM_S3_SYNC_INCLUDE_CHROMA ?? '',
    settings.CLAUDE_MEM_S3_SYNC_DEVICE ?? '',
    settings.CLAUDE_MEM_S3_SYNC_MERGE_INTERVAL_MINUTES ?? '',
  ].join('|');
}

export class DatabaseManager {
  private db: Database | null = null;
  private sessionStore: SessionStore | null = null;
  private sessionSearch: SessionSearch | null = null;
  private chromaSync: ChromaSync | null = null;
  private cloudSync: CloudSync | null = null;
  private syncRecoveryReader: SyncRecoveryReader | null = null;
  private syncConflictRecovery: SyncConflictRecovery | null = null;
  private backupManager: BackupManager | null = null;
  private s3SyncManager: S3SyncManager | null = null;
  /** The enabling settings the running manager was constructed from (ensureS3SyncManager's replace test). */
  private s3SyncConstructionKey: string | null = null;
  private mediaStore: MediaStore | null = null;
  private mediaCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private mediaCloudSync: MediaCloudSync | null = null;
  private mediaReplicaResolver: MediaCloudReplicaResolver | null = null;

  private rawSearchEnabled = false;
  private rawSearchAbort = new AbortController();

  async initializeToolUseSearch(): Promise<void> {
    await this.sessionSearch?.configureToolUseIndex(this.rawSearchEnabled, this.rawSearchAbort.signal);
  }

  async initialize(): Promise<void> {
    // The runtime hands this manager an already-open database, so the SessionStore and SessionSearch
    // constructors never take their path-based branch here. Tighten the directory that is about to
    // hold the database, its WAL files and the settings before anything opens it.
    ensurePrivateDir(DATA_DIR);
    // Guard before pragmas: journal_mode = WAL persistently rewrites the file,
    // so a database whose schema is newer than this binary's chain must be
    // refused before the shared open touches it (#3609 step 2).
    this.db = openGuardedSqliteDatabase(DB_PATH);

    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    this.rawSearchEnabled = settings.CLAUDE_MEM_TOOL_USES_SEARCH_ENABLED === 'true';
    // Shared local work has an origin before credentials exist. Later cloud
    // configuration reuses this identity rather than orphaning its records.
    settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID = ensureLocalDeviceIdentity(this.db, USER_SETTINGS_PATH, settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID);

    // Cloud sync is active iff token, user id, and Hub URL are all non-empty
    // (CloudSync.isConfigured's exact predicate). Evaluated once here and
    // shared with SessionStore: sync_outbox rows are only ever deleted by
    // CloudSync's ack path, so an install without a CloudSync must not
    // produce mutation ops either — they would accumulate forever.
    const cloudSyncConfigured = isCloudSyncConfigured(settings);

    // The launch schema is SyncHub-native. SessionStore marks any pre-launch
    // local corpus as a nonqueued baseline once; only subsequent writes enter
    // the canonical v2 outbox.
    this.sessionStore = new SessionStore(this.db, { syncOpsEnabled: cloudSyncConfigured });
    this.sessionSearch = new SessionSearch(this.db);
    this.mediaStore = new MediaStore(this.db, DATA_DIR);
    const reconcileMedia = () => {
      // Cleanup rows stay durable on failure and are retried next interval.
      // Only the bounded code is logged: storage errors can contain paths.
      try { this.mediaStore?.reconcile(); }
      catch (error) {
        logger.warn('DB', 'Media cleanup remains pending', {
          code: error instanceof MediaError ? error.code : 'storage_unavailable',
        });
      }
    };
    reconcileMedia();
    this.mediaCleanupTimer = setInterval(reconcileMedia, 30_000);
    this.mediaCleanupTimer.unref?.();

    // Media upload/deletion runs beside, never inside, native text sync.
    // Queued cloud deletions drain whenever sync credentials exist; uploads
    // additionally require CLAUDE_MEM_MEDIA_CAPTURE_ENABLED.
    const mediaCloudClient = cloudSyncConfigured
      ? new MediaCloudClient({ baseUrl: cmemProOrigin(), token: settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN })
      : null;
    this.mediaReplicaResolver = new MediaCloudReplicaResolver(this.mediaStore, mediaCloudClient);
    if (mediaCloudClient) {
      this.mediaCloudSync = new MediaCloudSync(this.db, this.mediaStore, mediaCloudClient, {
        // Read fresh each drain (every 30 s): the "Keep images" switch saves
        // to settings.json and must take effect without a restart.
        uploadsEnabled: () => mediaCloudUploadsEnabled(SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)),
      });
      this.mediaCloudSync.start();
    }

    const chromaEnabled = settings.CLAUDE_MEM_CHROMA_ENABLED !== 'false';
    if (chromaEnabled) {
      this.chromaSync = new ChromaSync('claude-mem');
    } else {
      logger.info('DB', 'Chroma disabled via CLAUDE_MEM_CHROMA_ENABLED=false, using SQLite-only search');
    }

    // Inactive installs get null so the write-site `getCloudSync()?.notify()`
    // nudges are free no-ops.
    if (cloudSyncConfigured) {
      this.cloudSync = new CloudSync(this.db, settings, { healthFilePath: defaultSyncHealthFilePath() });
      const deviceId = this.cloudSync.status().deviceId;
      this.syncRecoveryReader = new SyncRecoveryReader(DB_PATH, deviceId, () => this.cloudSync!.recoveryFlags());
      initializeConflictRecoverySchema(this.db);
      this.syncConflictRecovery = new SyncConflictRecovery(this.db, {
        deviceId, userId: settings.CLAUDE_MEM_CLOUD_SYNC_USER_ID,
        hubUrl: settings.CLAUDE_MEM_CLOUD_SYNC_HUB_URL, authToken: settings.CLAUDE_MEM_CLOUD_SYNC_TOKEN,
        readEvidence: (kind, originLocalId) => this.syncRecoveryReader!.conflictEvidence(kind, originLocalId),
        listEvidence: limit => this.syncRecoveryReader!.conflicts(limit),
      });
    } else {
      // Sync is off: no banner for a feature not in use, and no queue that
      // nothing will ever drain (#4228).
      clearSyncHealth();
      purgeUndrainableSyncOutbox(this.db);
    }
    // Work-state reads fold native rows as this device's writes (the order
    // other devices and cmem.ai use), under the id CloudSync resolved.
    this.sessionStore.setLocalSyncDeviceId(this.cloudSync?.status().deviceId ?? settings.CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID);

    purgeLinkedToolUses(this.db, parseRetentionDays(settings.CLAUDE_MEM_TOOL_USES_RETENTION_DAYS));

    // Automatic local snapshots are opt-in. Disabled installs get null so the
    // lifecycle `getBackupManager()?.start()` call is a free no-op.
    if (settings.CLAUDE_MEM_BACKUP_ENABLED === 'true') {
      this.backupManager = new BackupManager(settings);
    }

    // S3 Sync is opt-in too. Disabled installs get null so the lifecycle
    // `getS3SyncManager()?.start()` call is a free no-op and the routes
    // answer {configured: false}.
    if (settings.CLAUDE_MEM_S3_SYNC_ENABLED === 'true') {
      this.s3SyncManager = new S3SyncManager(settings, {
        // The tick's SyncApply merges into the SAME shared connection the
        // worker uses (S3 Sync v2 Task 6 wiring). The manager never opens a
        // second writable connection to the live db.
        db: this.db,
        // The real ChromaSync forwarder (null when chroma is disabled —
        // merged rows then skip chroma and the boot backfill reconciles).
        // close() nulls THIS field before the s3 manager stops, but the
        // manager holds its own captured reference and the object is never
        // closed — an in-flight merge's forwarder keeps working through
        // stop(), and a straggling fire-and-forget chroma job past db close
        // lands in SyncApply's logged .catch (it cannot crash the tick).
        chromaSync: this.chromaSync,
      });
      this.s3SyncConstructionKey = s3SyncConstructionKey(settings);
    }

    logger.info('DB', 'Database initialized (shared connection)');
  }

  async close(): Promise<void> {
    // Stop any index build in flight, then arm a fresh signal: a busy init
    // retry (db-init-retry.ts) calls initialize() again on this manager.
    this.rawSearchAbort.abort();
    this.rawSearchAbort = new AbortController();
    if (this.mediaCleanupTimer) clearInterval(this.mediaCleanupTimer);
    this.mediaCleanupTimer = null;
    this.mediaCloudSync?.stop();
    this.mediaCloudSync = null;
    this.mediaReplicaResolver = null;
    this.mediaStore = null;
    this.chromaSync = null;

    this.cloudSync?.stop();
    this.cloudSync = null;
    this.syncRecoveryReader?.close();
    this.syncRecoveryReader = null;
    this.syncConflictRecovery = null;

    await this.backupManager?.stop();
    this.backupManager = null;

    await this.s3SyncManager?.stop();
    this.s3SyncManager = null;

    // The store prepares hot-path statements on this shared connection. Bun
    // keeps the connection and the database file alive until they are
    // finalized, so drain the cache before the close below.
    this.sessionStore?.finalizeCachedStatements();
    this.sessionStore = null;
    this.sessionSearch = null;

    if (this.db) {
      this.db.close();
      this.db = null;
    }
    logger.info('DB', 'Database closed');
  }

  getSessionStore(): SessionStore {
    if (!this.sessionStore) {
      throw new Error('Database not initialized');
    }
    return this.sessionStore;
  }

  getMediaStore(): MediaStore {
    if (!this.mediaStore) throw new Error('Database not initialized');
    return this.mediaStore;
  }

  /** Lazy second-device media resolution for viewer reads (no-op for native media). */
  getMediaReplicaResolver(): MediaCloudReplicaResolver {
    if (!this.mediaReplicaResolver) throw new Error('Database not initialized');
    return this.mediaReplicaResolver;
  }

  getSessionSearch(): SessionSearch {
    if (!this.sessionSearch) {
      throw new Error('Database not initialized');
    }
    return this.sessionSearch;
  }

  getChromaSync(): ChromaSync | null {
    return this.chromaSync;
  }

  getCloudSync(): CloudSync | null {
    return this.cloudSync;
  }

  getSyncRecoveryReader(): SyncRecoveryReader | null { return this.syncRecoveryReader; }
  getSyncConflictRecovery(): SyncConflictRecovery | null { return this.syncConflictRecovery; }

  getBackupManager(): BackupManager | null {
    return this.backupManager;
  }

  getS3SyncManager(): S3SyncManager | null {
    return this.s3SyncManager;
  }

  /**
   * The S3 Sync manager for the settings NOW on disk, constructing and starting
   * it when the setup page enabled (or re-pointed) sync after this boot: the
   * manager above is built once at init, so a choice-screen save would
   * otherwise stay unapplied until the next worker restart. The mirror case is
   * handled too: a save that disables sync stops the running manager instead
   * of leaving it ticking until the next boot.
   *
   * Returns the running manager, or null when settings do not enable sync. A
   * replacement stops the old scheduler in the background (an in-flight push
   * settles; the new manager's first tick waits out its staggered initial
   * delay) — the wizard's one-shot enable, the common case, never replaces
   * anything.
   */
  ensureS3SyncManager(): S3SyncManager | null {
    if (!this.db) return this.s3SyncManager;
    const settings = SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH);
    if (settings.CLAUDE_MEM_S3_SYNC_ENABLED !== 'true') {
      const previous = this.s3SyncManager;
      if (!previous) return null;
      this.s3SyncManager = null;
      this.s3SyncConstructionKey = null;
      void previous.stop().catch((error: unknown) => {
        logger.warn('DB', 'The disabled S3 Sync manager did not stop cleanly', {}, error instanceof Error ? error : new Error(String(error)));
      });
      logger.info('DB', 'S3 Sync manager stopped: the settings no longer enable it');
      return null;
    }
    const constructionKey = s3SyncConstructionKey(settings);
    if (this.s3SyncManager && this.s3SyncConstructionKey === constructionKey) return this.s3SyncManager;
    const replaced = this.s3SyncManager;
    if (replaced) {
      void replaced.stop().catch((error: unknown) => {
        logger.warn('DB', 'The replaced S3 Sync manager did not stop cleanly', {}, error instanceof Error ? error : new Error(String(error)));
      });
    }
    this.s3SyncManager = new S3SyncManager(settings, { db: this.db, chromaSync: this.chromaSync });
    this.s3SyncConstructionKey = constructionKey;
    this.s3SyncManager.start();
    logger.info('DB', 'S3 Sync manager started from the setup page\'s saved settings');
    return this.s3SyncManager;
  }

  getConnection(): Database {
    if (!this.db) {
      throw new Error('Database not initialized');
    }
    return this.db;
  }

  getSessionById(sessionDbId: number): {
    id: number;
    content_session_id: string;
    memory_session_id: string | null;
    project: string;
    platform_source: string;
    user_prompt: string;
    custom_title: string | null;
    status: string;
    observed_model: string | null;
    observed_billing: string | null;
  } {
    const session = this.getSessionStore().getSessionById(sessionDbId);
    if (!session) {
      throw new Error(`Session ${sessionDbId} not found`);
    }
    return session;
  }

}
