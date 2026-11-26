/** Public, credential-free sync evidence. Transport liveness is not replica freshness. */
export interface SyncDownloadStatus {
  started: boolean;
  inFlight: boolean;
  suspended: boolean;
  authPaused: boolean;
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  nextRetryAt: number | null;
  epoch: string | null;
  cursor: string;
  mode: 'polling' | 'realtime';
  realtimeAvailable: boolean | null;
  socketLive: boolean;
  caughtUp: boolean;
}

export interface ViewerSyncStatus {
  configured: boolean;
  state: 'unconfigured' | 'unknown' | 'current' | 'catching-up' | 'paused' | 'offline' | 'partial' | 'stale';
  mode: 'polling' | 'realtime' | 'disabled';
  checkedAt: number | null;
  observedAt: number;
  message: string;
  upload: { pending: number; lastSuccessAt: number | null; error: string | null };
  download: SyncDownloadStatus | null;
  projection: { epoch: string | null; headSeq: string | null; projectedSeq: string | null; remaining: string | null };
  completeness: { pushQuarantine: number; pullQuarantine: number; excludedNative: number | null; scope: 'eligible' | 'local-history-excluded' | 'unknown' };
  /** S3 Sync v2 merge dimension; null when S3 Sync is disabled/unconfigured (the viewer keeps today's rendering). */
  s3: ViewerS3SyncStatus | null;
}

export interface SyncUploadEvidence {
  configured: boolean;
  pending: Record<string, number>;
  lastFlushAt: number | null;
  lastError: string | null;
  authError: unknown | null;
  quarantine: { count: number };
  pullQuarantine: { count: number };
  queue?: { blockedMutation: { pendingPrerequisites: number } | null };
  hub: { checkedAt: number | null; reachable: boolean | null; epoch: string | null; headSeq: string | null; projectedSeq: string | null };
}

// --- S3 Sync v2: the s3 dimension of sync_status ---------------------------

/**
 * ONE definition of the S3 merge dimension's state (house state-machine rule):
 * every consumer imports this type; the worker payload stays words-free and
 * the viewer (Task 7) owns the label table.
 */
export type ViewerS3SyncState = 'current' | 'stale' | 'error';

/**
 * Raw evidence the S3SyncManager's status() exposes (structural subset — the
 * worker hands `() => manager?.status() ?? null` to ViewerSyncService).
 */
export interface S3SyncEvidence {
  merge: {
    /** The last discovery's peer snapshot; null = never discovered (unknown, not empty). */
    peers: string[] | null;
    mergedGenerations: Record<string, string>;
    mergeState: Record<string, {
      state: 'ok' | 'error' | 'skipped';
      applied: number;
      lastMergeAt: number;
      lastError: string | null;
    }>;
  };
}

export interface ViewerS3SyncStatus {
  state: ViewerS3SyncState;
  /** When the reported state was established (the deciding outcome's timestamp). */
  lastMergeAt: number | null;
  /** The last discovery's peer snapshot, verbatim; null = never discovered. */
  mergedPeers: string[] | null;
  /** The most recent peer error (error state only; a superseded error is not kept). */
  lastError: string | null;
  /** The latest merged generation (ISO stamps are lexicographically time-ordered). */
  lastGenerationMerged: string | null;
}

/**
 * Map the manager's merge evidence to the viewer dimension. The rule, honestly:
 * - healthy evidence per peer = mergeState 'ok', OR 'skipped' WITH a watermark
 *   (mergedGenerations[peer]) — a watermark-backed skip is the CONVERGED steady
 *   state (nothing new to merge; the peer is fully merged), so it must read
 *   current, never stale. A skip WITHOUT a watermark means the peer was
 *   discovered but never pushed anything: no freshness evidence either way.
 * - 'error' when the latest error is at least as recent as the latest healthy
 *   evidence (ties → error: a real peer failure deserves attention; the next
 *   healthy tick clears it).
 * - else 'current' when any healthy evidence exists; else 'stale' (enabled but
 *   never merged — including the Cloud-Sync exclusivity refusal, where merges
 *   never run; the viewer renders the cloud source in that case anyway).
 */
export function composeS3SyncStatus(evidence: S3SyncEvidence | null): ViewerS3SyncStatus | null {
  if (!evidence) return null;
  const { peers, mergedGenerations, mergeState } = evidence.merge;

  let latestError: { lastMergeAt: number; lastError: string | null } | null = null;
  let latestHealthyAt: number | null = null;
  let latestActivityAt: number | null = null;
  for (const [peer, entry] of Object.entries(mergeState)) {
    if (latestActivityAt === null || entry.lastMergeAt > latestActivityAt) latestActivityAt = entry.lastMergeAt;
    if (entry.state === 'error') {
      if (latestError === null || entry.lastMergeAt >= latestError.lastMergeAt) latestError = entry;
      continue;
    }
    const healthy = entry.state === 'ok' || mergedGenerations[peer] !== undefined;
    if (healthy && (latestHealthyAt === null || entry.lastMergeAt > latestHealthyAt)) latestHealthyAt = entry.lastMergeAt;
  }

  const state: ViewerS3SyncState = latestError !== null && (latestHealthyAt === null || latestError.lastMergeAt >= latestHealthyAt)
    ? 'error'
    : latestHealthyAt !== null ? 'current' : 'stale';
  const lastGenerationMerged = Object.values(mergedGenerations).sort().at(-1) ?? null;
  return {
    state,
    lastMergeAt: state === 'error' ? latestError!.lastMergeAt : state === 'current' ? latestHealthyAt : latestActivityAt,
    mergedPeers: peers,
    lastError: state === 'error' ? latestError!.lastError : null,
    lastGenerationMerged,
  };
}

const decimal = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
const lag = (head: string | null, cursor: string | null): string | null => decimal(head) && decimal(cursor) && BigInt(head) >= BigInt(cursor)
  ? (BigInt(head) - BigInt(cursor)).toString() : null;

/** Pure composition: never probes, schedules, repairs or writes sync state. */
export function composeViewerSyncStatus(upload: SyncUploadEvidence | null, download: SyncDownloadStatus | null, excludedNative: number | null, now = Date.now(), s3: S3SyncEvidence | null = null): ViewerSyncStatus {
  const hub = upload?.hub;
  const pending = Object.values(upload?.pending ?? {}).reduce((sum, value) => sum + (Number.isSafeInteger(value) && value > 0 ? value : 0), 0);
  const remaining = hub?.reachable === true && hub.epoch !== null && hub.epoch === download?.epoch ? lag(hub.headSeq, download.cursor) : null;
  const projected = hub?.reachable === true ? lag(hub.headSeq, hub.projectedSeq) : null;
  const value: ViewerSyncStatus = {
    configured: upload?.configured === true,
    state: 'unconfigured', mode: upload?.configured ? download?.mode ?? 'polling' : 'disabled', checkedAt: hub?.checkedAt ?? null, observedAt: now,
    message: 'Cloud sync is not configured.',
    upload: { pending, lastSuccessAt: upload?.lastFlushAt ?? null, error: upload?.lastError ?? null }, download,
    projection: { epoch: hub?.epoch ?? null, headSeq: hub?.headSeq ?? null, projectedSeq: hub?.projectedSeq ?? null, remaining },
    completeness: { pushQuarantine: upload?.quarantine.count ?? 0, pullQuarantine: upload?.pullQuarantine.count ?? 0, excludedNative,
      scope: excludedNative === null ? 'unknown' : excludedNative > 0 ? 'local-history-excluded' : 'eligible' },
    s3: composeS3SyncStatus(s3),
  };
  const state = (name: ViewerSyncStatus['state'], message: string) => Object.assign(value, { state: name, message });
  if (!value.configured) return value;
  if (upload?.authError || download?.authPaused) return state('paused', 'Cloud sync is paused after authentication or subscription was refused.');
  if (download?.suspended || (download && !download.started)) return state('paused', 'Incoming cloud updates are paused on this device.');
  if (download?.lastError || upload?.lastError || hub?.reachable === false) return state('offline', 'Cloud sync could not finish its latest request. Saved work remains on this device.');
  if (!download || download.lastSuccessAt === null || hub?.reachable !== true || remaining === null || projected === null) return state('unknown', 'Cloud freshness has not been confirmed.');
  if (hub.checkedAt === null || now < hub.checkedAt || now - hub.checkedAt > 60_000 || now < download.lastSuccessAt) return state('stale', 'The last cloud freshness check is old.');
  if (upload?.queue?.blockedMutation) return state('catching-up', 'Some updates are waiting for earlier changes to upload.');
  if (pending > 0 || remaining !== '0' || projected !== '0' || download.inFlight || !download.caughtUp) return state('catching-up', 'Cloud updates are being synchronized.');
  if (value.completeness.pushQuarantine || value.completeness.pullQuarantine) return state('partial', 'Some records need attention before this device is fully synchronized.');
  if (excludedNative === null) return state('unknown', 'Recent updates are current; historical synchronization scope is not yet known.');
  if (excludedNative > 0) return state('partial', 'Recent updates are current. Older local history is outside the selected sync scope.');
  return state('current', 'Shared records are current with the last confirmed cloud check.');
}
