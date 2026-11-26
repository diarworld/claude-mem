/**
 * S3 Sync: scheduled and on-demand push of snapshot sets to an own
 * S3-compatible bucket, plus the pull staging used by /api/s3sync/pull.
 *
 * The schedule loop and single-flight guard follow BackupManager (SyncClient's
 * self-rescheduling unref'd setTimeout chain; no setInterval, no queues).
 * Per-set run facts persist in state/s3sync/state.json, so status survives
 * restarts and a push that just ran is not repeated by the next boot.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { paths, USER_SETTINGS_PATH } from '../../shared/paths.js';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { loadClaudeMemEnv } from '../../shared/EnvManager.js';
import { logger } from '../../utils/logger.js';
import { BunS3Transport, type S3Transport } from './s3-transport.js';
import { S3_SYNC_SETS, type S3SyncManifest, type S3SyncManifestFile, type S3SyncSet,
  changedFiles, generationPrefix, generationStamp, latestMarkerPayload, latestObjectKey,
  manifestObjectKey, pruneGenerations, sanitizeDeviceName, setPrefix, sha256File } from './manifest.js';
import { buildChromaSnapshotSet, buildDbSnapshotSet, type SnapshotEntry, type SnapshotInput } from './snapshot.js';
import type { S3SyncPushPhase } from './push-phase.js';

export interface S3SyncSettingKeys {
  CLAUDE_MEM_S3_SYNC_ENABLED?: string;
  CLAUDE_MEM_S3_SYNC_ENDPOINT?: string;
  CLAUDE_MEM_S3_SYNC_BUCKET?: string;
  CLAUDE_MEM_S3_SYNC_REGION?: string;
  CLAUDE_MEM_S3_SYNC_DB_INTERVAL_HOURS?: string;
  CLAUDE_MEM_S3_SYNC_CHROMA_INTERVAL_HOURS?: string;
  CLAUDE_MEM_S3_SYNC_KEEP_GENERATIONS?: string;
  CLAUDE_MEM_S3_SYNC_INCLUDE_ENV?: string;
  CLAUDE_MEM_S3_SYNC_INCLUDE_CHROMA?: string;
  CLAUDE_MEM_S3_SYNC_DEVICE?: string;
}

export interface S3SyncManagerOptions {
  transport?: S3Transport;
  dataDir?: string;
  dbPath?: string;
  reviewsDbPath?: string;
  chromaDir?: string;
  settingsPath?: string;
  envPath?: string;
  stateDir?: string;
  now?: () => number;
  initialDelayMs?: number;
  jitterFraction?: number;
  /** Test seam: credential env override (defaults to loadClaudeMemEnv()). */
  env?: { S3_SYNC_ACCESS_KEY_ID?: string; S3_SYNC_SECRET_ACCESS_KEY?: string };
}

export interface S3SyncPushOutcome {
  set: S3SyncSet;
  generation: string;
  uploaded: number;
  bytes: number;
  pruned: string[];
}

export interface S3SyncSetStatus {
  phase: S3SyncPushPhase;
  lastPushAt: number | null;
  lastGeneration: string | null;
  lastError: string | null;
  nextRunAt: number | null;
}

const DEFAULT_INITIAL_DELAY_MS = 5 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface PersistedSetState { lastPushAt: number | null; lastGeneration: string | null; lastError: string | null; lastPullAt: number | null; }
interface PersistedState { version: 1; db: PersistedSetState; chroma: PersistedSetState; }

function emptySetState(): PersistedSetState {
  return { lastPushAt: null, lastGeneration: null, lastError: null, lastPullAt: null };
}

export class S3SyncManager {
  private readonly settings: S3SyncSettingKeys;
  private readonly transport: S3Transport;
  private readonly dataDir: string;
  private readonly dbPath: string;
  private readonly reviewsDbPath: string;
  private readonly chromaDir: string;
  private readonly settingsPath: string;
  private readonly envPath: string;
  private readonly stateDir: string;
  private readonly s3syncDir: string;
  private readonly now: () => number;
  private readonly initialDelayMs: number;
  private readonly jitterFraction: number;
  private readonly device: string;

  private started = false;
  private stopped = false;
  private readonly running = new Set<S3SyncSet>();
  private readonly phases = new Map<S3SyncSet, S3SyncPushPhase>([['db', 'idle'], ['chroma', 'idle']]);
  private readonly timers = new Map<S3SyncSet, ReturnType<typeof setTimeout>>();
  private readonly nextRunAt = new Map<S3SyncSet, number | null>();
  private readonly controllers = new Map<S3SyncSet, AbortController>();

  constructor(settings: S3SyncSettingKeys, options: S3SyncManagerOptions = {}) {
    this.settings = settings;
    this.now = options.now ?? Date.now;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.jitterFraction = options.jitterFraction ?? 0.1;
    this.dataDir = options.dataDir ?? paths.dataDir();
    this.dbPath = options.dbPath ?? paths.database();
    this.reviewsDbPath = options.reviewsDbPath ?? path.join(this.dataDir, 'work-view-reviews.db');
    this.chromaDir = options.chromaDir ?? paths.chroma();
    this.settingsPath = options.settingsPath ?? USER_SETTINGS_PATH;
    this.envPath = options.envPath ?? paths.envFile();
    this.stateDir = options.stateDir ?? path.join(this.dataDir, 'state');
    this.s3syncDir = path.join(this.dataDir, 'state', 's3sync');
    this.device = settings.CLAUDE_MEM_S3_SYNC_DEVICE?.trim() || os.hostname();
    this.transport = options.transport ?? new BunS3Transport({
      endpoint: settings.CLAUDE_MEM_S3_SYNC_ENDPOINT || 'https://storage.yandexcloud.net',
      bucket: settings.CLAUDE_MEM_S3_SYNC_BUCKET || '',
      region: settings.CLAUDE_MEM_S3_SYNC_REGION || 'ru-central1',
      accessKeyId: options.env?.S3_SYNC_ACCESS_KEY_ID ?? loadClaudeMemEnv().S3_SYNC_ACCESS_KEY_ID ?? '',
      secretAccessKey: options.env?.S3_SYNC_SECRET_ACCESS_KEY ?? loadClaudeMemEnv().S3_SYNC_SECRET_ACCESS_KEY ?? '',
    });
  }

  // --- persisted state ---------------------------------------------------

  private statePath(): string {
    return path.join(this.s3syncDir, 'state.json');
  }

  private loadState(): PersistedState {
    try {
      const state = parseJsonWithBom<PersistedState>(readFileSync(this.statePath(), 'utf-8'));
      if (state && state.version === 1 && state.db && state.chroma) return state;
    } catch {
      // Missing or unreadable state falls through to a fresh one.
    }
    return { version: 1, db: emptySetState(), chroma: emptySetState() };
  }

  private saveState(state: PersistedState): void {
    mkdirSync(this.s3syncDir, { recursive: true });
    writeJsonFileAtomic(this.statePath(), state, { mode: 0o600 });
  }

  private cachedManifest(set: S3SyncSet): S3SyncManifest | null {
    try {
      return parseJsonWithBom<S3SyncManifest>(readFileSync(path.join(this.s3syncDir, `last-push-${set}.json`), 'utf-8'));
    } catch {
      return null;
    }
  }

  private saveCachedManifest(set: S3SyncSet, manifest: S3SyncManifest): void {
    writeJsonFileAtomic(path.join(this.s3syncDir, `last-push-${set}.json`), manifest, { mode: 0o600 });
  }

  private input(): SnapshotInput {
    return {
      dbPath: this.dbPath,
      reviewsDbPath: this.reviewsDbPath,
      chromaDir: this.chromaDir,
      settingsPath: this.settingsPath,
      envPath: this.envPath,
      stateDir: this.stateDir,
    };
  }

  private setPhase(set: S3SyncSet, phase: S3SyncPushPhase): void {
    this.phases.set(set, phase);
  }

  private chromaEnabled(): boolean {
    return this.settings.CLAUDE_MEM_S3_SYNC_INCLUDE_CHROMA !== 'false';
  }

  // --- lifecycle ---------------------------------------------------------

  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    this.sweepStaleStaging();
    for (const set of S3_SYNC_SETS) {
      this.schedule(set, this.jittered(this.initialDelayMs));
    }
  }

  /** A hard-killed worker leaves staging-* work dirs behind; sweep ones older than a day. */
  private sweepStaleStaging(): void {
    try {
      if (!existsSync(this.s3syncDir)) return;
      const cutoff = this.now() - 24 * 3_600_000;
      for (const name of readdirSync(this.s3syncDir)) {
        if (!name.startsWith('staging-')) continue;
        const dir = path.join(this.s3syncDir, name);
        try {
          if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
        } catch {
          // A directory that vanished mid-sweep needs no cleanup.
        }
      }
    } catch (error) {
      logger.warn('S3SYNC', 'Stale staging sweep failed; leaving work dirs in place', {},
        error instanceof Error ? error : new Error(String(error)));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  // --- schedule loop (shape copied from BackupManager.schedule/tick) -----

  private intervalMs(set: S3SyncSet): number {
    const hours = set === 'db'
      ? Number(this.settings.CLAUDE_MEM_S3_SYNC_DB_INTERVAL_HOURS) || 6
      : Number(this.settings.CLAUDE_MEM_S3_SYNC_CHROMA_INTERVAL_HOURS) || 24;
    // Guard against zero/negative/garbage cadences parking the loop.
    return Math.max(1, hours * 3_600_000);
  }

  private jittered(delayMs: number): number {
    return delayMs * (1 - this.jitterFraction + 2 * this.jitterFraction * Math.random());
  }

  private schedule(set: S3SyncSet, delayMs: number): void {
    if (this.stopped) return;
    const existing = this.timers.get(set);
    if (existing) clearTimeout(existing);
    const dueAt = this.now() + delayMs;
    this.nextRunAt.set(set, dueAt);
    this.armTimer(set, dueAt);
  }

  private armTimer(set: S3SyncSet, dueAt: number): void {
    const delayMs = Math.max(0, dueAt - this.now());
    const wait = Math.min(delayMs, MAX_TIMER_DELAY_MS);
    const timer = setTimeout(() => {
      this.timers.delete(set);
      if (delayMs > wait) {
        this.armTimer(set, dueAt); // timers cap at ~24.8 days; re-arm without pushing
        return;
      }
      void this.tick(set);
    }, wait);
    (timer as { unref?: () => void }).unref?.(); // never hold the process open
    this.timers.set(set, timer);
  }

  private async tick(set: S3SyncSet): Promise<void> {
    if (this.stopped) return;
    try {
      const fresh = this.loadState()[set].lastPushAt;
      const freshEnough = fresh !== null && this.now() - fresh < this.intervalMs(set);
      const gated = set === 'chroma' && !this.chromaEnabled();
      if (!freshEnough && !gated) await this.pushSet(set);
    } catch (error) {
      // The loop must survive a bad cycle; pushSet already persisted lastError.
      logger.warn('S3SYNC', `Scheduled ${set} push failed; retrying next interval`, {},
        error instanceof Error ? error : new Error(String(error)));
    }
    if (this.stopped) return;
    this.schedule(set, this.intervalMs(set));
  }

  // --- on-demand runs ----------------------------------------------------

  async runNow(set: S3SyncSet | 'all'): Promise<S3SyncPushOutcome | null> {
    if (set === 'all') {
      const db = await this.pushSet('db');
      const chroma = this.chromaEnabled() ? await this.pushSet('chroma') : null;
      return db ?? chroma;
    }
    if (set === 'chroma' && !this.chromaEnabled()) return null;
    return this.pushSet(set);
  }

  // --- push pipeline -----------------------------------------------------

  /**
   * Push one set: snapshot → upload → manifest → LATEST → prune. The bucket
   * order is enforced (all data files, then manifest.json, then LATEST) so a
   * reader never sees LATEST pointing at an incomplete generation. Local
   * facts (cached manifest, state.json) are written only after every upload
   * succeeded, so a partial failure leaves them describing the last good
   * generation. Aborts die between files; the in-flight Bun upload completes
   * (the transport has no signal support).
   */
  private async pushSet(set: S3SyncSet): Promise<S3SyncPushOutcome | null> {
    if (this.running.has(set)) return null;
    this.running.add(set);
    const controller = new AbortController();
    this.controllers.set(set, controller);
    const signal = controller.signal;
    const workDir = path.join(this.s3syncDir, `staging-${set}-${generationStamp(this.now())}`);
    this.setPhase(set, 'snapshotting');
    try {
      const entries: SnapshotEntry[] = set === 'db'
        ? await buildDbSnapshotSet(workDir, this.input(), {
            includeEnv: this.settings.CLAUDE_MEM_S3_SYNC_INCLUDE_ENV !== 'false',
            signal,
          })
        : await buildChromaSnapshotSet(workDir, this.input(), { signal });
      signal.throwIfAborted();

      const generation = generationStamp(this.now());
      const files: S3SyncManifestFile[] = [];
      let bytes = 0;
      for (const entry of entries) {
        files.push({ key: entry.key, bytes: entry.bytes, sha256: await sha256File(entry.absolutePath) });
        bytes += entry.bytes;
      }
      const manifest: S3SyncManifest = {
        version: 1,
        set,
        generation,
        createdAt: this.now(),
        device: sanitizeDeviceName(this.device),
        files,
      };
      if (set === 'chroma') {
        const pairedDbGeneration = this.cachedManifest('db')?.generation;
        if (!pairedDbGeneration) {
          throw new Error('refusing to push the chroma set before the db set: push the db set first so the index has a db generation to pair with');
        }
        manifest.pairedDbGeneration = pairedDbGeneration;
      }

      // Skip check only: an empty diff means the last generation is still
      // current, so no new generation is opened and nothing is uploaded.
      const cached = this.cachedManifest(set);
      if (cached !== null && changedFiles(cached, manifest).length === 0) {
        const state = this.loadState();
        state[set].lastPushAt = this.now();
        this.saveState(state);
        rmSync(workDir, { recursive: true, force: true });
        this.setPhase(set, 'ok');
        return { set, generation: cached.generation, uploaded: 0, bytes: 0, pruned: [] };
      }

      this.setPhase(set, 'uploading');
      const prefix = generationPrefix(this.device, set, generation);
      for (const entry of entries) {
        await this.transport.upload(entry.absolutePath, `${prefix}/${entry.key}`);
        signal.throwIfAborted();
      }
      // The transport takes a local path, so manifest + LATEST stage as temp
      // files inside the work dir. Order enforced: data → manifest → LATEST.
      const manifestTemp = path.join(workDir, 'upload-manifest.json');
      writeFileSync(manifestTemp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
      await this.transport.upload(manifestTemp, manifestObjectKey(this.device, set, generation));
      signal.throwIfAborted();
      const latestTemp = path.join(workDir, 'upload-latest.json');
      writeFileSync(latestTemp, latestMarkerPayload(generation, this.now()), 'utf-8');
      await this.transport.upload(latestTemp, latestObjectKey(this.device, set));

      const keys = await this.transport.listKeys(setPrefix(this.device, set));
      const keep = Number(this.settings.CLAUDE_MEM_S3_SYNC_KEEP_GENERATIONS) || 5;
      const stale = pruneGenerations(keys, set, keep, generation);
      for (const old of stale) {
        const oldPrefix = `${generationPrefix(this.device, set, old)}/`;
        for (const key of keys) {
          if (key.startsWith(oldPrefix)) await this.transport.deleteObject(key);
        }
      }

      // Every upload succeeded — only now are the local facts updated.
      this.saveCachedManifest(set, manifest);
      const state = this.loadState();
      state[set].lastPushAt = this.now();
      state[set].lastGeneration = generation;
      state[set].lastError = null;
      this.saveState(state);
      rmSync(workDir, { recursive: true, force: true });
      this.setPhase(set, 'ok');
      logger.info('S3SYNC', `${set} push complete`, {
        generation, uploaded: entries.length + 2, bytes, pruned: stale.length,
      });
      return { set, generation, uploaded: entries.length + 2, bytes, pruned: stale };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setPhase(set, 'error');
      try {
        const state = this.loadState();
        state[set].lastError = message;
        this.saveState(state);
      } catch {
        // Persisting the error must not mask the original failure.
      }
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // A stuck work dir is swept by start() after 24 h.
      }
      logger.warn('S3SYNC', `${set} push failed`, {}, error instanceof Error ? error : new Error(message));
      throw error;
    } finally {
      this.running.delete(set);
      this.controllers.delete(set);
    }
  }

  // --- status ------------------------------------------------------------

  status(): {
    configured: true;
    enabled: true;
    endpoint: string;
    bucket: string;
    device: string;
    sets: Record<S3SyncSet, S3SyncSetStatus>;
  } {
    const persisted = this.loadState();
    const fromState = (set: S3SyncSet): S3SyncSetStatus => ({
      phase: this.phases.get(set) ?? 'idle',
      nextRunAt: this.nextRunAt.get(set) ?? null,
      lastPushAt: persisted[set].lastPushAt,
      lastGeneration: persisted[set].lastGeneration,
      lastError: persisted[set].lastError,
    });
    return {
      configured: true,
      enabled: true,
      endpoint: this.settings.CLAUDE_MEM_S3_SYNC_ENDPOINT || 'https://storage.yandexcloud.net',
      bucket: this.settings.CLAUDE_MEM_S3_SYNC_BUCKET || '',
      device: this.device,
      sets: { db: fromState('db'), chroma: fromState('chroma') },
    };
  }
}
