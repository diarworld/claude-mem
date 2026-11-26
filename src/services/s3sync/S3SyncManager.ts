/**
 * S3 Sync: scheduled and on-demand push of snapshot sets to an own
 * S3-compatible bucket, plus the pull staging used by /api/s3sync/pull.
 *
 * The schedule loop and single-flight guard follow BackupManager (SyncClient's
 * self-rescheduling unref'd setTimeout chain; no setInterval, no queues).
 * Per-set run facts persist in state/s3sync/state.json, so status survives
 * restarts and a push that just ran is not repeated by the next boot.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'crypto';
import path from 'node:path';
import os from 'node:os';
import { paths, USER_SETTINGS_PATH } from '../../shared/paths.js';
import { parseJsonWithBom, writeJsonFileAtomic } from '../../shared/atomic-json.js';
import { loadClaudeMemEnv } from '../../shared/EnvManager.js';
import { ORIGIN_DEVICE_ID_MAX_BYTES } from '../../shared/cloud-sync-limits.js';
import { logger } from '../../utils/logger.js';
import { BunS3Transport, type S3Transport } from './s3-transport.js';
import { S3_SYNC_SETS, S3_SYNC_ROOT, isValidGenerationStamp, peersFromKeys, type S3SyncManifest, type S3SyncManifestFile, type S3SyncSet,
  changedFiles, generationPrefix, generationStamp, latestMarkerPayload, latestObjectKey,
  manifestObjectKey, parseLatestMarker, pruneGenerations, sanitizeDeviceName, setPrefix, sha256File } from './manifest.js';
import { buildChromaSnapshotSet, buildDbSnapshotSet, gunzipFile, type SnapshotEntry, type SnapshotInput } from './snapshot.js';
import { stagePendingChromaRestore, stagePendingRestore } from '../backup/snapshot-files.js';
import { ChromaSyncState } from '../sync/ChromaSyncState.js';
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
  /** Where staged pulled-db snapshots are written. MUST be the directory
   * applyPendingRestore searches at boot (paths.backups() = backups/auto,
   * BackupManager's auto-snapshot nest), or the boot restore never finds the
   * file. Defaults to paths.backups(). */
  backupsDir?: string;
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
  /** 'all' only on the combined runNow('all') outcome; a per-set push names its set. */
  set: S3SyncSet | 'all';
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
  /** When this set last staged a pull (freshness of the pulled copy). */
  lastPullAt: number | null;
  nextRunAt: number | null;
}

export interface S3SyncPullRequest {
  set: S3SyncSet | 'all';
  /** Pull a specific generation instead of the set's remote LATEST. */
  generation?: string;
  /** Stage a chroma index even when its paired db generation mismatches the pulled db (flags every project for rebuild). */
  force?: boolean;
}

export interface S3SyncPullSetResult {
  set: S3SyncSet;
  /** 'pulled' = every file verified and a restore staged; 'skipped' = nothing to pull. */
  status: 'pulled' | 'skipped';
  /** Resolved remote generation (absent when skipped). */
  generation?: string;
  /** db set: staged snapshot basename; chroma set: the staging dir path. */
  staged?: string;
  /** chroma set only: the db generation the staged index is paired with. */
  pairedDbGeneration?: string;
  /** Why the set was skipped. */
  reason?: string;
}

export interface S3SyncPullResult {
  /** One outcome per set, in the order the sets ran. */
  sets: S3SyncPullSetResult[];
  lastPullAt: number;
}

const DEFAULT_INITIAL_DELAY_MS = 5 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface PersistedSetState { lastPushAt: number | null; lastGeneration: string | null; lastError: string | null; lastPullAt: number | null; }

/** Last-merge outcome per peer, for status/UI (S3 Sync v2 Task 3). */
export interface MergePeerState {
  state: 'ok' | 'error' | 'skipped';
  applied: number;
  lastMergeAt: number;
  lastError: string | null;
}

interface PersistedState {
  version: 1;
  db: PersistedSetState;
  chroma: PersistedSetState;
  /** This device's stable replica-row identity, minted once (see ensureSyncIdentity). Optional only for state files written before it existed. */
  syncIdentity?: string;
  /**
   * Per-peer merge watermark: the last LATEST generation stamp successfully
   * merged from that peer. Key = the peer's device ROOT (the sanitized
   * bucket path segment from discovery), NOT a sync identity — the bucket
   * routes storage, the identity names the replica. Optional only for state
   * files written before merges existed.
   */
  mergedGenerations?: Record<string, string>;
  /** Per-peer last-merge outcome for status/UI. Optional only for pre-merge state files. */
  mergeState?: Record<string, MergePeerState>;
}

/** The honest runtime shape: loadState guarantees these, whatever the file held. */
type HydratedState = PersistedState & {
  syncIdentity: string;
  mergedGenerations: Record<string, string>;
  mergeState: Record<string, MergePeerState>;
};

/** A hand-edited/corrupt state file may hold garbage where a map belongs — that reads as empty, never crashes. */
function recordOrEmpty<T>(value: unknown): Record<string, T> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, T>) : {};
}

/**
 * The distinct peer device-root segments in one sync-root listing, own
 * excluded, sorted. `ownDeviceSegment` is the SANITIZED device name segment
 * (`sanitizeDeviceName(device)` — what deviceRoot() embeds), never the full
 * root and never a sync identity. The transport contract
 * (S3Transport.listKeys) already walks pagination and returns the COMPLETE
 * key list, so nothing is paginated here; a listing that is empty or
 * (type-lying) undefined yields no peers.
 */
export async function discoverPeers(transport: S3Transport, ownDeviceSegment: string): Promise<string[]> {
  return peersFromKeys(await transport.listKeys(`${S3_SYNC_ROOT}/`), ownDeviceSegment);
}

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
  private readonly backupsDir: string;
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

  /** In-flight push promise per set, registered synchronously at pushSet
   * entry (before the pipeline's first await) so stop() can always observe
   * and settle an in-flight push. */
  private readonly pushPromises = new Map<S3SyncSet, Promise<unknown>>();

  /** Peers from the most recent discovery; null = never discovered (status reports unknown, not empty). */
  private lastMergePeers: string[] | null = null;

  constructor(settings: S3SyncSettingKeys, options: S3SyncManagerOptions = {}) {
    this.settings = settings;
    this.now = options.now ?? Date.now;
    this.initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.jitterFraction = options.jitterFraction ?? 0.1;
    this.dataDir = options.dataDir ?? paths.dataDir();
    this.dbPath = options.dbPath ?? paths.database();
    this.reviewsDbPath = options.reviewsDbPath ?? path.join(this.dataDir, 'work-view-reviews.db');
    this.chromaDir = options.chromaDir ?? paths.chroma();
    // The boot restore (applyPendingRestore) searches exactly paths.backups()
    // (= <dataDir>/backups/auto, BackupManager's auto-snapshot nest) for the
    // staged snapshot, so a pulled db MUST land there — a snapshot elsewhere
    // makes boot report "snapshot not found" and start unchanged (live-bucket
    // smoke bug). Pulled snapshots therefore participate in BackupManager's
    // retention and are listed as restorable snapshots.
    this.backupsDir = options.backupsDir ?? paths.backups();
    this.settingsPath = options.settingsPath ?? USER_SETTINGS_PATH;
    this.envPath = options.envPath ?? paths.envFile();
    this.stateDir = options.stateDir ?? path.join(this.dataDir, 'state');
    this.s3syncDir = path.join(this.dataDir, 'state', 's3sync');
    this.device = settings.CLAUDE_MEM_S3_SYNC_DEVICE?.trim() || os.hostname();
    const fileEnv = loadClaudeMemEnv();
    this.transport = options.transport ?? new BunS3Transport({
      endpoint: settings.CLAUDE_MEM_S3_SYNC_ENDPOINT || 'https://storage.yandexcloud.net',
      bucket: settings.CLAUDE_MEM_S3_SYNC_BUCKET || '',
      region: settings.CLAUDE_MEM_S3_SYNC_REGION || 'ru-central1',
      accessKeyId: options.env?.S3_SYNC_ACCESS_KEY_ID ?? fileEnv.S3_SYNC_ACCESS_KEY_ID ?? '',
      secretAccessKey: options.env?.S3_SYNC_SECRET_ACCESS_KEY ?? fileEnv.S3_SYNC_SECRET_ACCESS_KEY ?? '',
    });
    // Rehydrate the phase from the persisted run facts: a set that already
    // pushed resumes as ok (or error when its last run failed); idle is only
    // the value for a set that never pushed. Keeps CLI status truthful after
    // a restart. setPhase stays the single writer of this.phases.
    const persisted = this.loadState();
    for (const set of S3_SYNC_SETS) {
      if (persisted[set].lastGeneration !== null) {
        this.setPhase(set, persisted[set].lastError ? 'error' : 'ok');
      }
    }
  }

  // --- persisted state ---------------------------------------------------

  private statePath(): string {
    return path.join(this.s3syncDir, 'state.json');
  }

  private loadState(): HydratedState {
    try {
      const state = parseJsonWithBom<PersistedState>(readFileSync(this.statePath(), 'utf-8'));
      if (state && state.version === 1 && state.db && state.chroma) return this.hydrateState(state);
    } catch {
      // Missing or unreadable state falls through to a fresh one.
    }
    return this.hydrateState({ version: 1, db: emptySetState(), chroma: emptySetState() });
  }

  /** ensureSyncIdentity plus merge-map normalization: absent or non-object maps read as {} (honest required-at-runtime shape). */
  private hydrateState(state: PersistedState): HydratedState {
    const withIdentity = this.ensureSyncIdentity(state);
    return {
      ...withIdentity,
      mergedGenerations: recordOrEmpty<string>(withIdentity.mergedGenerations),
      mergeState: recordOrEmpty<MergePeerState>(withIdentity.mergeState),
    };
  }

  /**
   * The sync identity is this device's stable replica-row identity for
   * SyncApply (S3 Sync v2): ops carry it verbatim as `origin_device_id`, and
   * convergence keys on it — so it is minted once (`crypto.randomUUID()`)
   * and persisted with the rest of the state. It is NOT the sanitized
   * device-name bucket prefix (sanitizeDeviceName case-mangles a path
   * component) and must never be derived from it: the bucket prefix routes
   * storage, the sync identity names the replica. Byte length is validated
   * against ORIGIN_DEVICE_ID_MAX_BYTES at mint — unreachable for a UUID, but
   * the guard documents the constraint SyncApply enforces downstream.
   */
  private ensureSyncIdentity(state: PersistedState): PersistedState & { syncIdentity: string } {
    // A truthy non-string (hand-edited/corrupt state) must re-mint, not leak
    // into ops typed as a string.
    if (typeof state.syncIdentity === 'string' && state.syncIdentity) return state as PersistedState & { syncIdentity: string };
    const syncIdentity = randomUUID();
    if (Buffer.byteLength(syncIdentity, 'utf-8') > ORIGIN_DEVICE_ID_MAX_BYTES) {
      throw new Error(`sync identity exceeds ORIGIN_DEVICE_ID_MAX_BYTES (${ORIGIN_DEVICE_ID_MAX_BYTES}): ${syncIdentity}`);
    }
    try {
      this.saveState({ ...state, syncIdentity });
    } catch (error) {
      // First construction-time write in either manager: a silent failure
      // would mint a new identity every boot — duplicate replica rows in the
      // merge layer. Loud, with the cause attached.
      throw new Error('failed to persist the S3 sync identity', { cause: error });
    }
    return { ...state, syncIdentity };
  }

  private saveState(state: PersistedState): void {
    mkdirSync(this.s3syncDir, { recursive: true });
    writeJsonFileAtomic(this.statePath(), state, { mode: 0o600 });
  }

  // --- merge state (S3 Sync v2) -------------------------------------------
  //
  // Per-peer watermarks and outcomes, keyed by the peer's device ROOT (the
  // sanitized bucket segment discoverPeers yields) — never by a sync
  // identity. Every write goes load-fresh → mutate → atomic save, the same
  // discipline as the per-set facts above.

  /** Discover peers through this manager's transport and cache the result for status(). */
  async discoverMergePeers(): Promise<string[]> {
    const peers = await discoverPeers(this.transport, sanitizeDeviceName(this.device));
    this.lastMergePeers = peers;
    return peers;
  }

  /**
   * The last LATEST generation successfully merged from a peer (its
   * watermark), or null. A persisted value that is not a valid stamp (hand
   * -edited state) reads as null — it must never drive a comparison; status
   * keeps showing the persisted truth. A LOST watermark is safe by design:
   * the next tick re-merges the peer's current snapshot, which SyncApply
   * absorbs idempotently (stable entity ids, rev guards, DO NOTHING) — do
   * not harden this null into an error.
   */
  private peerWatermark(peerRoot: string): string | null {
    const stored = this.loadState().mergedGenerations[peerRoot];
    return typeof stored === 'string' && isValidGenerationStamp(stored) ? stored : null;
  }

  private setMergeState(peerRoot: string, entry: MergePeerState): void {
    if (!peerRoot) return;
    const state = this.loadState();
    state.mergeState[peerRoot] = entry;
    this.saveState(state);
  }

  /**
   * Record a fully successful peer merge: the watermark advances to
   * `generation` and the outcome is 'ok' with the applied count. A generation
   * that is not a valid stamp (malformed, path-traversal) is IGNORED with no
   * state change — a stamp that could never be safely compared must not
   * become a watermark (same clamp honesty as v1's interval handling). The
   * stamp format is validated again at read (peerWatermark).
   */
  private recordPeerMerged(peerRoot: string, generation: string, applied: number): void {
    if (!peerRoot || !isValidGenerationStamp(generation)) return;
    const state = this.loadState();
    state.mergedGenerations[peerRoot] = generation;
    state.mergeState[peerRoot] = { state: 'ok', applied, lastMergeAt: this.now(), lastError: null };
    this.saveState(state);
  }

  /** A peer merge attempt failed (download/verify/apply); its watermark stays untouched. */
  private recordPeerError(peerRoot: string, error: string): void {
    this.setMergeState(peerRoot, { state: 'error', applied: 0, lastMergeAt: this.now(), lastError: error });
  }

  /** A peer had nothing to merge (its LATEST is at or below the watermark). */
  private recordPeerSkipped(peerRoot: string): void {
    this.setMergeState(peerRoot, { state: 'skipped', applied: 0, lastMergeAt: this.now(), lastError: null });
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

  // Fully synchronous (guarded sweeps + schedule arming), so a `void` return
  // is honest: if a later edit adds an await, the floating promise becomes a
  // visible type error instead of a silent unhandled rejection.
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.sweepStaleStaging();
    this.sweepPullLeftovers();
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

  /**
   * Boot-time sweep of pull leftovers, in the same guarded style as
   * sweepStaleStaging: a sweep failure must never prevent start().
   *
   * Ordering note: worker-service.ts applies both pending-restore markers
   * (applyPendingRestore, then applyPendingChromaRestore — apply-once) BEFORE
   * the managers are constructed and start() runs. Anything still on disk is
   * therefore orphaned:
   * - state/s3sync/chroma-restore-<gen>: a newer pull overwrote the chroma
   *   marker, so this older staging tree is never swapped in;
   * - backups/s3sync-incoming/*: download landings; boot means nothing is in
   *   flight.
   * The chroma-pre-restore-<ts> trees are different: the boot swap moves the
   * previous index aside deliberately. They are kept as a bounded history of
   * the newest 2 (BackupManager's retention philosophy) — unbounded, each
   * restore would pin another full chroma tree (~1.4 GB) forever.
   */
  private sweepPullLeftovers(): void {
    this.sweepNamedDirs(this.s3syncDir, name => name.startsWith('chroma-restore-'), 0, 'orphaned chroma restore staging');
    this.sweepNamedDirs(path.join(this.dataDir, 'backups', 's3sync-incoming'), () => true, 0, 'incoming pull downloads');
    this.sweepNamedDirs(path.dirname(this.chromaDir), name => name.startsWith('chroma-pre-restore-'), 2, 'pre-restore chroma copies');
  }

  /** Remove matching directories under `parentDir`, keeping only the `keep` newest by name (stamp names sort in time order); never throws. */
  private sweepNamedDirs(parentDir: string, matches: (name: string) => boolean, keep: number, label: string): void {
    try {
      if (!existsSync(parentDir)) return;
      const stale = readdirSync(parentDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && matches(entry.name))
        .map(entry => entry.name).sort().reverse()
        .slice(keep);
      for (const name of stale) {
        try {
          rmSync(path.join(parentDir, name), { recursive: true, force: true });
        } catch {
          // A directory that vanished mid-sweep needs no cleanup.
        }
      }
    } catch (error) {
      logger.warn('S3SYNC', `Sweep of ${label} failed; leaving them in place`, { parentDir },
        error instanceof Error ? error : new Error(String(error)));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    // Graceful shutdown lets the aborted pushes run their teardown (state
    // persist, work-dir cleanup) instead of abandoning them mid-flight.
    // Mirrors BackupManager.stop's allSettled. Idempotent: a second call
    // finds an empty map and resolves immediately.
    await Promise.allSettled([...this.pushPromises.values()]);
  }

  // --- schedule loop (shape copied from BackupManager.schedule/tick) -----

  private intervalMs(set: S3SyncSet): number {
    const defaultHours = set === 'db' ? 6 : 24;
    const parsed = Number(set === 'db'
      ? this.settings.CLAUDE_MEM_S3_SYNC_DB_INTERVAL_HOURS
      : this.settings.CLAUDE_MEM_S3_SYNC_CHROMA_INTERVAL_HOURS);
    // Negatives, zero, NaN and garbage all fall back to the default cadence.
    // (`Number('-1')` is truthy, so an `|| default` fallback alone would accept
    // it and the 1 ms floor below would turn one operator typo into
    // back-to-back full pushes — a VACUUM plus paid uploads on every tick.)
    const hours = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultHours;
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

  /**
   * On-demand push. Resolves `null` when the set is already running (the
   * route answers 409); throws when the manager is stopped, or when an
   * explicit 'chroma' request names a set disabled by
   * CLAUDE_MEM_S3_SYNC_INCLUDE_CHROMA=false (the route answers 400 — "busy"
   * and "gated" must not share a status). 'all' keeps the scheduled path's
   * semantics: a gated chroma is silently skipped, because the caller asked
   * for everything that is pushable, not for chroma specifically. When both
   * sets push, the outcome is combined (uploaded/bytes/pruned summed; the
   * printed generation is the db's — the memory db is the primary artifact).
   */
  async runNow(set: S3SyncSet | 'all'): Promise<S3SyncPushOutcome | null> {
    if (this.stopped) throw new Error('S3 sync manager stopped');
    if (set === 'all') {
      const db = await this.pushSet('db');
      const chroma = this.chromaEnabled() ? await this.pushSet('chroma') : null;
      if (!db || !chroma) return db ?? chroma;
      return {
        set: 'all',
        generation: db.generation, // the memory db is the primary artifact
        uploaded: db.uploaded + chroma.uploaded,
        bytes: db.bytes + chroma.bytes,
        pruned: [...db.pruned, ...chroma.pruned],
      };
    }
    if (set === 'chroma' && !this.chromaEnabled()) {
      throw new Error('chroma sync is disabled by CLAUDE_MEM_S3_SYNC_INCLUDE_CHROMA=false');
    }
    return this.pushSet(set);
  }

  // --- push pipeline -----------------------------------------------------

  /**
   * Push one set on demand (runNow) or on schedule (tick). Single-flight per
   * set: a second request while one is running resolves `null` (the route
   * answers 409). The in-flight promise is registered synchronously — before
   * the pipeline's first await — so a concurrent stop() always sees it and
   * can settle it.
   */
  private async pushSet(set: S3SyncSet): Promise<S3SyncPushOutcome | null> {
    if (this.running.has(set)) return null;
    const push = this.executePushSet(set);
    this.pushPromises.set(set, push);
    try {
      return await push;
    } finally {
      if (this.pushPromises.get(set) === push) this.pushPromises.delete(set);
    }
  }

  /**
   * Push one set: snapshot → upload → manifest → LATEST → prune. The bucket
   * order is enforced (all data files, then manifest.json, then LATEST) so a
   * reader never sees LATEST pointing at an incomplete generation. Local
   * facts (cached manifest, state.json) are written only after every upload
   * succeeded, so a partial failure leaves them describing the last good
   * generation. Aborts die between files; the in-flight Bun upload completes
   * (the transport has no signal support).
   */
  private async executePushSet(set: S3SyncSet): Promise<S3SyncPushOutcome | null> {
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
        // changedFiles() sees only the local cache, so a bucket wiped by an
        // operator or a lifecycle rule would stay "Up to date" forever while
        // the objects are gone. Skip only while the bucket still holds this
        // set; an empty bucket falls through to the full push below and
        // repushes everything (self-heal).
        const bucketHasObjects = (await this.transport.listKeys(setPrefix(this.device, set))).length > 0;
        if (bucketHasObjects) {
          const state = this.loadState();
          state[set].lastPushAt = this.now();
          this.saveState(state);
          rmSync(workDir, { recursive: true, force: true });
          this.setPhase(set, 'ok');
          return { set, generation: cached.generation, uploaded: 0, bytes: 0, pruned: [] };
        }
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
      // Invalid or zero → default 5: `Number('0') || 5` intentionally lands on
      // the default rather than flooring 0 to 1 (keep=0 would mean "keep none").
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

  // --- pull pipeline ------------------------------------------------------

  /**
   * Pull one or both sets from the bucket: resolve the remote generation →
   * download every manifest file into backups/s3sync-incoming/<set>-<gen>/ →
   * verify sha256 and size against the manifest → stage a restore. Nothing is
   * staged until every file of the set matched, and a pull never overwrites a
   * live file: the db lands as a snapshot plus a boot-time restore marker,
   * settings.json/.env only as `.bak-s3sync` sidecars, and the chroma tree as
   * a staging dir plus its own boot-time marker (chroma-restore.ts swaps it
   * in at boot, the sqlite db already decompressed and ready to use).
   *
   * Generation resolution: an explicit `generation` names the requested set;
   * with set='all' it applies to the db set while chroma resolves its own
   * LATEST (the two sets stamp independently). A missing or unreadable LATEST
   * is empty remote state — the set is skipped, not an error, so a first pull
   * from a fresh bucket succeeds. An explicitly requested generation that has
   * since vanished (pruned mid-pull by a concurrent push) is a hard error.
   *
   * For set='all' the sets run in order (db, then chroma) and the first
   * failure is logged and rethrown, stopping the pull; the db restore of an
   * earlier set stays staged.
   *
   * Include gating: CLAUDE_MEM_S3_SYNC_INCLUDE_CHROMA=false gates pull
   * exactly like push (controller amendment). An explicit chroma pull throws
   * the same error as runNow('chroma'); inside 'all' the chroma set is
   * SKIPPED with that reason — nothing is downloaded or staged for it and
   * its persisted lastPullAt stays untouched — while the db set proceeds, so
   * an operator who disabled chroma never gets the bucket's index swapped in
   * at boot (enable it temporarily to restore an index explicitly).
   */
  async pull(request: S3SyncPullRequest): Promise<S3SyncPullResult> {
    if (this.stopped) throw new Error('S3 sync manager stopped');
    const sets: S3SyncSet[] = request.set === 'all' ? [...S3_SYNC_SETS] : [request.set];
    const results: S3SyncPullSetResult[] = [];
    let stagedDbGeneration: string | null = null;
    for (const set of sets) {
      if (set === 'chroma' && !this.chromaEnabled()) {
        if (request.set === 'chroma') {
          throw new Error('chroma sync is disabled by CLAUDE_MEM_S3_SYNC_INCLUDE_CHROMA=false');
        }
        results.push({ set: 'chroma', status: 'skipped', reason: 'chroma sync is disabled by CLAUDE_MEM_S3_SYNC_INCLUDE_CHROMA=false' });
        continue;
      }
      try {
        const result = await this.pullSet(set, request, stagedDbGeneration);
        if (result.status === 'pulled' && set === 'db' && result.generation) stagedDbGeneration = result.generation;
        results.push(result);
      } catch (error) {
        logger.warn('S3SYNC', `${set} pull failed`, {}, error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
    }
    return { sets: results, lastPullAt: this.now() };
  }

  private async pullSet(set: S3SyncSet, request: S3SyncPullRequest, stagedDbGeneration: string | null): Promise<S3SyncPullSetResult> {
    // An explicit generation names the requested set; with set='all' it is
    // applied to the db set and chroma follows its own LATEST.
    const explicitGeneration = request.set === 'all' && set === 'chroma' ? undefined : request.generation;

    let generation: string;
    if (explicitGeneration) {
      generation = explicitGeneration;
    } else {
      const tempLatest = path.join(this.s3syncDir, `pull-latest-${set}-${generationStamp(this.now())}.json`);
      mkdirSync(this.s3syncDir, { recursive: true });
      let parsed: ReturnType<typeof parseLatestMarker>;
      try {
        await this.transport.download(latestObjectKey(this.device, set), tempLatest);
        parsed = parseLatestMarker(readFileSync(tempLatest, 'utf-8'));
      } catch (error) {
        // No LATEST = nothing was ever pushed (or the bucket is gone): a
        // pull has nothing to do, which is not an error.
        logger.warn('S3SYNC', `${set} pull skipped: no remote LATEST (empty remote state)`, {},
          error instanceof Error ? error : new Error(String(error)));
        return { set, status: 'skipped', reason: 'no remote LATEST (empty remote state)' };
      } finally {
        rmSync(tempLatest, { force: true });
      }
      if (parsed === null) {
        logger.warn('S3SYNC', `${set} pull skipped: remote LATEST is unreadable`, {});
        return { set, status: 'skipped', reason: 'remote LATEST marker is unreadable' };
      }
      generation = parsed.generation;
    }
    // The generation becomes local path segments; a bucket-controlled `../..`
    // must never pass this line.
    if (!isValidGenerationStamp(generation)) throw new Error(`invalid generation: ${generation}`);

    const incomingDir = path.join(this.dataDir, 'backups', 's3sync-incoming', `${set}-${generation}`);
    mkdirSync(incomingDir, { recursive: true });
    try {
      let manifest: S3SyncManifest;
      try {
        const manifestPath = path.join(incomingDir, 'manifest.json');
        await this.transport.download(manifestObjectKey(this.device, set, generation), manifestPath);
        manifest = parseJsonWithBom<S3SyncManifest>(readFileSync(manifestPath, 'utf-8'));
      } catch (error) {
        if (explicitGeneration) {
          throw new Error(`generation no longer present: ${generation}`);
        }
        throw error;
      }

      // Download and verify everything before anything is staged: a single
      // mismatch aborts the set with no marker and no moved file.
      const incomingRoot = path.resolve(incomingDir);
      for (const file of manifest.files) {
        const resolved = path.resolve(incomingDir, file.key);
        if (resolved !== incomingRoot && !resolved.startsWith(incomingRoot + path.sep)) {
          throw new Error(`manifest key escapes the incoming dir: ${file.key}`);
        }
        mkdirSync(path.dirname(resolved), { recursive: true });
        await this.transport.download(`${generationPrefix(this.device, set, generation)}/${file.key}`, resolved);
        if (await sha256File(resolved) !== file.sha256 || statSync(resolved).size !== file.bytes) {
          throw new Error(`downloaded file does not match the manifest: ${file.key}`);
        }
      }

      if (set === 'db') {
        return await this.stageDbPull(generation, manifest, incomingDir);
      }
      return await this.stageChromaPull(generation, request.force === true, stagedDbGeneration, manifest, incomingDir);
    } catch (error) {
      // Nothing staged: the incoming dir is disposable.
      rmSync(incomingDir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Gunzip the verified db into the backups dir and stage the boot-time restore. Live settings/env are never touched — sidecars only. */
  private async stageDbPull(generation: string, manifest: S3SyncManifest, incomingDir: string): Promise<S3SyncPullSetResult> {
    const files = manifest.files;
    const dbGz = files.find(file => file.key === 'claude-mem.db.gz');
    if (!dbGz) throw new Error(`db manifest has no claude-mem.db.gz: ${generation}`);
    // this.backupsDir MUST be the directory applyPendingRestore searches at
    // boot (paths.backups() = <dataDir>/backups/auto — BackupManager's
    // auto-snapshot nest), so the staged file is found and applied, and
    // participates in BackupManager's retention/listing. Never derive it as
    // <dataDir>/backups — that is the parent, not the search root.
    const backupsDir = this.backupsDir;
    mkdirSync(backupsDir, { recursive: true });
    const stagedName = `claude-mem-${generation}-from-s3.db`;
    const stagedPath = path.join(backupsDir, stagedName);
    // Written under a .partial name (outside SNAPSHOT_FILE_PATTERN's `.db$`
    // anchor) and renamed only once gunzip succeeded, so list, retention and
    // restore never see a truncated download (BackupManager's snapshot rule).
    const partialPath = `${stagedPath}.partial`;
    try {
      await gunzipFile(path.join(incomingDir, 'claude-mem.db.gz'), partialPath);
      renameSync(partialPath, stagedPath);
    } catch (error) {
      // A leftover .partial never matches SNAPSHOT_FILE_PATTERN, so it is
      // harmless — but remove what we can instead of leaving litter.
      for (const leftover of [partialPath, `${partialPath}-wal`, `${partialPath}-shm`, `${partialPath}-journal`]) {
        if (existsSync(leftover)) {
          try {
            unlinkSync(leftover);
          } catch {
            // Best effort.
          }
        }
      }
      throw error;
    }
    // The marker path must NOT follow backupsDir: boot reads exactly
    // paths.pendingRestore() = <dataDir>/backups/restore-pending.json, while
    // backupsDir is backups/auto. (Equals paths.pendingRestore() in
    // production; tests inject the temp-dir root.)
    stagePendingRestore(stagedName, path.join(this.dataDir, 'backups', 'restore-pending.json'));

    for (const [key, sidecarName] of [['settings.json', 'settings.json.bak-s3sync'], ['env', '.env.bak-s3sync']] as const) {
      if (!files.some(file => file.key === key)) continue;
      const sidecar = path.join(this.dataDir, sidecarName);
      copyFileSync(path.join(incomingDir, key), sidecar);
      logger.info('S3SYNC', `Pulled ${key} staged as a sidecar; applying it stays a manual step`, { sidecar });
    }

    const state = this.loadState();
    state.db.lastPullAt = this.now();
    this.saveState(state);
    logger.info('S3SYNC', 'db pull complete', { generation, staged: stagedName });
    return { set: 'db', status: 'pulled', generation, staged: stagedName };
  }

  /** Move the verified chroma tree into a staging dir (chroma/ prefix stripped, sqlite gunzipped) and stage the boot-time swap. */
  private async stageChromaPull(generation: string, force: boolean, stagedDbGeneration: string | null, manifest: S3SyncManifest, incomingDir: string): Promise<S3SyncPullSetResult> {
    const files = manifest.files;
    const paired = manifest.pairedDbGeneration;
    if (paired && stagedDbGeneration && stagedDbGeneration !== paired) {
      if (!force) {
        throw new Error(`chroma index is paired with db generation ${paired}, pulled db is ${stagedDbGeneration}`);
      }
      // The operator forced a mismatched index in; the local vector state can
      // only recover by rebuilding from the restored database.
      ChromaSyncState.markAllForRebuild();
    }

    const stagingDir = path.join(this.s3syncDir, `chroma-restore-${generation}`);
    rmSync(stagingDir, { recursive: true, force: true }); // a leftover from an earlier pull must never reach the swap
    mkdirSync(stagingDir, { recursive: true });
    for (const file of files) {
      const rel = file.key.startsWith('chroma/') ? file.key.slice('chroma/'.length) : file.key;
      const dst = path.join(stagingDir, rel);
      mkdirSync(path.dirname(dst), { recursive: true });
      renameSync(path.join(incomingDir, file.key), dst);
    }
    // The push gzips chroma.sqlite3; decompress it here so the boot swap
    // installs a ready-to-use directory. HNSW binaries are copied as-is.
    const stagedGz = path.join(stagingDir, 'chroma.sqlite3.gz');
    if (existsSync(stagedGz)) {
      await gunzipFile(stagedGz, path.join(stagingDir, 'chroma.sqlite3'));
      rmSync(stagedGz, { force: true });
    }
    stagePendingChromaRestore(stagingDir, paired, path.join(this.dataDir, 'backups', 'restore-chroma-pending.json'));

    const state = this.loadState();
    state.chroma.lastPullAt = this.now();
    this.saveState(state);
    logger.info('S3SYNC', 'chroma pull complete', { generation, staged: stagingDir, pairedDbGeneration: paired });
    return { set: 'chroma', status: 'pulled', generation, staged: stagingDir, pairedDbGeneration: paired };
  }

  // --- status ------------------------------------------------------------

  status(): {
    configured: true;
    enabled: true;
    endpoint: string;
    bucket: string;
    device: string;
    /** This device's stable replica-row identity (see ensureSyncIdentity). */
    syncIdentity: string;
    sets: Record<S3SyncSet, S3SyncSetStatus>;
    /** Multi-device merge (S3 Sync v2): peers null = never discovered yet (unknown, not empty). */
    merge: {
      peers: string[] | null;
      mergedGenerations: Record<string, string>;
      mergeState: Record<string, MergePeerState>;
    };
  } {
    const persisted = this.loadState();
    const fromState = (set: S3SyncSet): S3SyncSetStatus => ({
      phase: this.phases.get(set) ?? 'idle',
      nextRunAt: this.nextRunAt.get(set) ?? null,
      lastPushAt: persisted[set].lastPushAt,
      lastGeneration: persisted[set].lastGeneration,
      lastError: persisted[set].lastError,
      lastPullAt: persisted[set].lastPullAt,
    });
    return {
      configured: true,
      enabled: true,
      endpoint: this.settings.CLAUDE_MEM_S3_SYNC_ENDPOINT || 'https://storage.yandexcloud.net',
      bucket: this.settings.CLAUDE_MEM_S3_SYNC_BUCKET || '',
      device: this.device,
      syncIdentity: persisted.syncIdentity, // loadState guarantees presence
      sets: { db: fromState('db'), chroma: fromState('chroma') },
      merge: {
        // peers is the LAST DISCOVERY's snapshot; mergedGenerations/mergeState
        // are live and may name peers from earlier discoveries.
        peers: this.lastMergePeers,
        mergedGenerations: persisted.mergedGenerations,
        mergeState: persisted.mergeState,
      },
    };
  }
}
