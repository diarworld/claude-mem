import { presentSync, type SyncPresentation, type SyncStatusForDisplay } from '../../../viewer/utils/sync-presentation.ts'
import type { ViewerS3SyncState, ViewerS3SyncStatus } from '../../../../shared/viewer-sync-status.js'

// Typed copy of claude-mem v15.0.1 plugin/ui/work-view/live-status.js (getConnectionStatus).
// Connection freshness is measured on the browser's monotonic clock. Server
// wall time is displayed as evidence, never used as an agent-presence signal.
export const LOCAL_FEED_STALE_AFTER_MS = 35_000 // Two 15-second heartbeats + margin.
const ACTIVITY_STALE_AFTER_MS = 125_000 // WorkViewRoutes' 120-second activity cache plus one check margin.

export type ConnectionState = 'connecting' | 'reconnecting' | 'stale' | 'unavailable' | 'live'
export type ConnectionTone = 'neutral' | 'warning' | 'positive'

export interface ConnectionStatusInput {
  transportConnected?: boolean
  reconnecting?: boolean
  now: number
  lastEventAt?: number | null
  sourceConnected?: boolean | null
  lastSuccessfulCheckAt?: string | null
  lastSuccessfulCheckReceivedAt?: number | null
  wallNow?: number | null
  staleAfterMs?: number
  /** Where the page is served: the worker on this computer, or the cloud viewer that pulls your synced devices. */
  where?: 'local' | 'cloud'
  /** The worker's sync evidence; the S3 Sync v2 dimension rides inside it (s3). */
  sync?: (SyncStatusForDisplay & { s3?: ViewerS3SyncStatus | null }) | null
  syncReceivedAt?: number | null
  activityCheckedAt?: string | null
  activityAgeAtReceipt?: number | null
  activityReceivedAt?: number | null
}

export interface ConnectionStatus {
  state: ConnectionState
  label: string
  detail: string
  tone: ConnectionTone
  isLive: boolean
  eventAgeMs: number | null
  sourceAgeMs: number | null
  lastSuccessfulCheckAt: string | null
  /** When the saved activity was last inspected (an ISO time), for the Live popover's details; null when unknown. */
  activityCheckedAt: string | null
  clockSkew: boolean
  staleAfterMs: number
  tooltip: string
  /** Separately measured upstream synchronization; feed liveness does not imply this is current. */
  sync?: SyncPresentation
  /** The S3 memory sync dimension (S3 Sync v2); null when S3 Sync is off, in which case the popover renders the Cloud copy row as today. */
  s3?: S3SyncPresentation | null
}

function age(now: number, at: number | null): number | null {
  if (at === null || !Number.isFinite(now) || !Number.isFinite(at) || now < 0 || at < 0 || at > now + 1000) return null
  return Math.max(0, now - at)
}

// --- The S3 memory sync row (S3 Sync v2) ------------------------------------

/**
 * The S3 merge dimension's row words, ONE table keyed by the shared union
 * (imported from src/shared/viewer-sync-status.js — never re-typed here), so a
 * future state fails the typecheck until it is worded here. The words are the
 * i18n source strings: `t()` reads them.
 */
export const S3_SYNC_STATE_WORDS: Record<ViewerS3SyncState, { label: string; tone: ConnectionTone }> = {
  current: { label: 'Current', tone: 'positive' },
  // A steady, explainable state, not a problem: enabled and waiting for the
  // first merge (or for any device to push a snapshot). Never a chip problem.
  stale: { label: 'Waiting for the first merge', tone: 'neutral' },
  error: { label: 'Merge error', tone: 'warning' },
}

/** The memory sync row's presentation: the row's state words plus the raw evidence the popover composes with. */
export interface S3SyncPresentation {
  state: ViewerS3SyncState
  label: string
  tone: ConnectionTone
  /** The deciding outcome's time (epoch ms). In 'stale' this is the last ACTIVITY, not a merge. */
  lastMergeAt: number | null
  /** The last discovery's peer snapshot; null = never discovered (the row says so distinctly from an empty list). */
  mergedPeers: string[] | null
  /** The worker's most recent peer error (error state); rendered raw in the Details fold. */
  lastError: string | null
}

/**
 * The S3 dimension rides in the worker's sync payload (recordSync keeps the
 * whole object after isSyncStatus). A payload without it, or with a state the
 * shared union does not name (a new state must be worded in
 * S3_SYNC_STATE_WORDS first, so this is unreachable for known states), leaves
 * the field null and the popover renders today's Cloud copy row.
 */
function presentS3Sync(s3: ViewerS3SyncStatus | null | undefined): S3SyncPresentation | null {
  if (!s3 || typeof s3.state !== 'string' || !(s3.state in S3_SYNC_STATE_WORDS)) return null
  const words = S3_SYNC_STATE_WORDS[s3.state]
  return {
    state: s3.state,
    label: words.label,
    tone: words.tone,
    lastMergeAt: typeof s3.lastMergeAt === 'number' && Number.isFinite(s3.lastMergeAt) ? s3.lastMergeAt : null,
    mergedPeers: Array.isArray(s3.mergedPeers) ? s3.mergedPeers : null,
    lastError: typeof s3.lastError === 'string' ? s3.lastError : null,
  }
}

function checkTime(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

/**
 * now, lastEventAt and lastSuccessfulCheckReceivedAt use performance.now().
 * Update lastEventAt only for a valid work-view/heartbeat SSE message.
 * Save lastSuccessfulCheckAt (source.lastCheckedAt) and its receipt time only
 * when that payload's source.connected === true: lastCheckedAt also advances
 * on failed backend reads. HTTP snapshots may seed the successful check, but
 * cannot establish that the event feed is live.
 */
export function getConnectionStatus({
  transportConnected = false,
  reconnecting = false,
  now,
  lastEventAt = null,
  sourceConnected = null,
  lastSuccessfulCheckAt = null,
  lastSuccessfulCheckReceivedAt = null,
  wallNow = null,
  staleAfterMs = LOCAL_FEED_STALE_AFTER_MS,
  where = 'local',
  sync = null,
  syncReceivedAt = null,
  activityCheckedAt = null,
  activityAgeAtReceipt = null,
  activityReceivedAt = null,
}: ConnectionStatusInput): ConnectionStatus {
  const cloud = where === 'cloud'
  const feed = cloud ? 'cloud feed' : 'local feed'
  const Feed = cloud ? 'Cloud feed' : 'Local feed'
  const threshold = Number.isFinite(staleAfterMs) && staleAfterMs > 0 ? staleAfterMs : LOCAL_FEED_STALE_AFTER_MS
  const eventAgeMs = age(now, lastEventAt)
  const sourceAgeMs = age(now, lastSuccessfulCheckReceivedAt)
  const successfulCheckAt = checkTime(lastSuccessfulCheckAt)
  const clockSkew = successfulCheckAt !== null && wallNow !== null && Number.isFinite(wallNow) && sourceAgeMs !== null
    && Math.abs(wallNow - Date.parse(successfulCheckAt) - sourceAgeMs) > 60_000
  let state: ConnectionState = 'connecting'
  let label = `Connecting to ${feed}`
  let detail = cloud ? 'Waiting for updates synced from your computers.' : 'Waiting for updates from this computer.'
  let tone: ConnectionTone = 'neutral'

  if (!transportConnected) {
    if (reconnecting && eventAgeMs !== null && eventAgeMs > threshold) {
      state = 'stale'; label = `${Feed} stale`; tone = 'warning'
      detail = `Reconnecting to ${cloud ? 'your cloud viewer' : 'this computer'}. No fresh update has arrived; showing the last received work.`
    } else if (reconnecting) {
      state = 'reconnecting'; label = `Reconnecting to ${feed}`; tone = 'warning'
      detail = `Connection interrupted. Showing the last received work while the ${feed} reconnects.`
    }
  } else if (eventAgeMs === null || eventAgeMs > threshold) {
    if (lastEventAt !== null) {
      state = 'stale'; label = `${Feed} stale`; tone = 'warning'
      detail = `${cloud ? 'Cloud' : 'Local'} updates have stopped arriving. Showing the last received work.`
    }
  } else if (sourceConnected === false) {
    state = 'unavailable'; label = `${cloud ? 'Cloud' : 'Local'} source unavailable`; tone = 'warning'
    detail = 'Connected, but saved work cannot be read right now. Showing the last received work.'
  } else if (sourceConnected === true && successfulCheckAt !== null && sourceAgeMs !== null) {
    if (sourceAgeMs > threshold) {
      state = 'stale'; label = `${Feed} stale`; tone = 'warning'
      detail = 'Connected, but the saved work has not been refreshed. Showing the last received work.'
    } else {
      state = 'live'; label = 'Live updates'; tone = 'positive'
      detail = cloud
        ? 'Connected to the cloud viewer. Incoming synchronization is reported separately.'
        : 'Updates are arriving from this computer. Each card shows when its work was last updated.'
    }
  }

  const activityElapsed = age(now, activityReceivedAt)
  const activityAge = activityAgeAtReceipt === null || activityElapsed === null ? null : activityAgeAtReceipt + activityElapsed
  if (state === 'live' && activityCheckedAt !== null && (activityAge === null || activityAge < 0 || !Number.isFinite(activityAge))) {
    state = 'stale'; label = 'Activity freshness unknown'; tone = 'warning'
    detail = 'The feed is connected, but the age of its saved activity could not be confirmed.'
  } else if (state === 'live' && activityAge !== null && activityAge > ACTIVITY_STALE_AFTER_MS) {
    state = 'stale'; label = 'Saved activity stale'; tone = 'warning'
    detail = 'The feed is connected, but its activity projection has not been refreshed. Showing the last received work.'
  }
  const tooltip = `Last successful ${cloud ? 'cloud' : 'local'} check: ${successfulCheckAt ?? 'not yet confirmed'}. `
    + (activityCheckedAt ? `Activity last inspected: ${activityCheckedAt}. ` : '')
    + (clockSkew ? 'Source and browser clocks differ; freshness uses received heartbeats. ' : '')
    + 'Connection status does not indicate an agent is running.'
  return { state, label, detail, tone, isLive: state === 'live', eventAgeMs, sourceAgeMs,
    lastSuccessfulCheckAt: successfulCheckAt, activityCheckedAt: checkTime(activityCheckedAt), clockSkew, staleAfterMs: threshold, tooltip,
    sync: presentSync(sync, syncReceivedAt, now),
    s3: presentS3Sync(sync?.s3) }
}
