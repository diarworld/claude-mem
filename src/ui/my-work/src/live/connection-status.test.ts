// Ported from claude-mem v15.0.1 tests/ui/work-view-live-status.test.ts (bun:test → node:test).
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { getConnectionStatus, LOCAL_FEED_STALE_AFTER_MS } from './connection-status.ts'

const wallNow = Date.parse('2026-10-17T12:00:00.000Z')
const check = '2026-10-17T11:59:59.000Z'
const live = { transportConnected: true, now: 100_000, lastEventAt: 99_000,
  sourceConnected: true, lastSuccessfulCheckAt: check, lastSuccessfulCheckReceivedAt: 99_000, wallNow }

describe('local feed status', () => {
  it('requires both a fresh SSE signal and a successful local check', () => {
    const status = getConnectionStatus(live)
    assert.equal(status.state, 'live')
    assert.equal(status.label, 'Live updates')
    assert.equal(status.isLive, true)
    assert.equal(status.eventAgeMs, 1000)
    assert.equal(status.clockSkew, false)
    assert.ok(status.tooltip.includes(`Last successful local check: ${check}`))
  })
  it('starts connecting with no implied presence', () => {
    assert.equal(getConnectionStatus({ now: 0 }).label, 'Connecting to local feed')
    assert.equal(getConnectionStatus({ now: 0 }).isLive, false)
  })
  it('does not use an HTTP snapshot as proof of a live event feed', () => {
    assert.equal(getConnectionStatus({ ...live, lastEventAt: null }).state, 'connecting')
    assert.equal(getConnectionStatus({ ...live, transportConnected: false }).isLive, false)
  })
  it('shows reconnecting immediately even if the last signal is fresh', () => {
    const status = getConnectionStatus({ ...live, transportConnected: false, reconnecting: true })
    assert.equal(status.label, 'Reconnecting to local feed')
    assert.equal(status.isLive, false)
    assert.ok(status.tooltip.includes(check))
  })
  it('expires a silent open event stream after two heartbeats plus margin', () => {
    assert.equal(getConnectionStatus({ ...live, now: live.lastEventAt + LOCAL_FEED_STALE_AFTER_MS }).isLive, true)
    assert.equal(getConnectionStatus({ ...live, now: live.lastEventAt + LOCAL_FEED_STALE_AFTER_MS + 1 }).label, 'Local feed stale')
  })
  it('marks retained work stale when reconnecting exceeds the freshness window', () => {
    const status = getConnectionStatus({ ...live, transportConnected: false, reconnecting: true,
      now: live.lastEventAt + LOCAL_FEED_STALE_AFTER_MS + 1 })
    assert.equal(status.state, 'stale')
    assert.equal(status.isLive, false)
    assert.ok(status.detail.includes('Reconnecting'))
    assert.ok(status.tooltip.includes(check))
  })
  it('reports an unreadable source even while heartbeats arrive', () => {
    const status = getConnectionStatus({ ...live, sourceConnected: false })
    assert.equal(status.label, 'Local source unavailable')
    assert.equal(status.isLive, false)
    assert.equal(status.lastSuccessfulCheckAt, check)
  })
  it('does not reuse a stale source success just because messages arrive', () => {
    assert.equal(getConnectionStatus({ ...live, lastSuccessfulCheckReceivedAt: 1 }).state, 'stale')
  })
  it('does not infer source health from an unknown source flag', () => {
    assert.equal(getConnectionStatus({ ...live, sourceConnected: null }).isLive, false)
  })
  it('requires a valid successful-check timestamp for the evidence tooltip', () => {
    for (const stamp of [null, 'yesterday', '123', '<script>']) {
      const status = getConnectionStatus({ ...live, lastSuccessfulCheckAt: stamp })
      assert.equal(status.isLive, false)
      assert.ok(status.tooltip.includes('not yet confirmed'))
    }
  })
  it('uses monotonic receipt age when the source clock is ahead or behind', () => {
    for (const offset of [-3_600_000, 3_600_000]) {
      const stamp = new Date(Date.parse(check) + offset).toISOString()
      const status = getConnectionStatus({ ...live, lastSuccessfulCheckAt: stamp })
      assert.equal(status.state, 'live')
      assert.equal(status.clockSkew, true)
      assert.ok(status.tooltip.includes(stamp))
      assert.ok(status.tooltip.includes('freshness uses received heartbeats'))
    }
  })
  it('does not extend liveness when the wall clock jumps after receipt', () => {
    assert.equal(getConnectionStatus({ ...live, now: 200_000, wallNow: wallNow - 3_600_000 }).state, 'stale')
  })
  it('rejects mismatched clock origins instead of keeping future events live forever', () => {
    assert.equal(getConnectionStatus({ ...live, lastEventAt: wallNow }).state, 'stale')
    assert.equal(getConnectionStatus({ ...live, now: NaN }).isLive, false)
  })
  it('can be live while recorded work is old or quiet', () => {
    const status = getConnectionStatus(live)
    assert.equal(status.state, 'live')
    assert.ok(status.tooltip.includes('does not indicate an agent is running'))
  })
  it('falls back to the documented threshold for invalid configuration', () => {
    assert.equal(getConnectionStatus({ ...live, staleAfterMs: -1 }).staleAfterMs, 35_000)
  })
})

describe('cloud viewer feed status', () => {
  it('names the cloud feed and your synced computers, never this computer', () => {
    assert.equal(getConnectionStatus({ now: 0, where: 'cloud' }).label, 'Connecting to cloud feed')
    const status = getConnectionStatus({ ...live, where: 'cloud' })
    assert.equal(status.state, 'live')
    assert.equal(status.label, 'Live updates')
    assert.ok(status.detail.includes('Incoming synchronization is reported separately'))
    assert.equal(status.sync?.state, 'unknown')
    assert.ok(status.tooltip.includes(`Last successful cloud check: ${check}`))
    const stale = getConnectionStatus({ ...live, where: 'cloud', transportConnected: false, reconnecting: true, now: 99_000 + LOCAL_FEED_STALE_AFTER_MS + 1 })
    assert.equal(stale.label, 'Cloud feed stale')
    assert.ok(!stale.detail.includes('this computer'))
  })
  it('keeps live feed transport separate from a failed download lane', () => {
    const status = getConnectionStatus({ ...live, where: 'cloud', syncReceivedAt: 99_000,
      sync: { configured: true, state: 'offline', mode: 'polling', observedAt: 100_000, checkedAt: 99_000,
        message: 'Cloud download failed.', download: { lastSuccessAt: 99_000 }, projection: { remaining: null },
        completeness: { pushQuarantine: 0, pullQuarantine: 0, excludedNative: 0, scope: 'eligible' } } })
    assert.equal(status.isLive, true)
    assert.equal(status.sync?.isCurrent, false)
    assert.equal(status.sync?.label, 'Cloud sync unavailable')
  })
  it('fresh heartbeat receipts do not make an old activity projection fresh', () => {
    const status = getConnectionStatus({ ...live, activityCheckedAt: '2026-10-17T11:55:00.000Z',
      activityReceivedAt: 99_000, activityAgeAtReceipt: 130_000 })
    assert.equal(status.state, 'stale')
    assert.equal(status.label, 'Saved activity stale')
    assert.ok(status.tooltip.includes('Activity last inspected'))
  })
  it('does not claim fresh activity when source or browser clock evidence is invalid', () => {
    const status = getConnectionStatus({ ...live, activityCheckedAt: check,
      activityReceivedAt: null, activityAgeAtReceipt: null })
    assert.equal(status.state, 'stale')
    assert.equal(status.label, 'Activity freshness unknown')
  })
})

describe('the S3 memory sync row (s3 dimension of the sync payload)', () => {
  /** A wire `sync` payload like the worker sends, with an s3 dimension attached. */
  const cloudSync = (state: 'unconfigured' | 'current') => ({
    configured: state !== 'unconfigured', state, mode: 'polling' as const, observedAt: 100_000,
    checkedAt: state === 'unconfigured' ? null : 99_000, message: `Cloud sync is ${state}.`,
    download: { lastSuccessAt: state === 'unconfigured' ? null : 99_000 }, projection: { remaining: null },
    completeness: { pushQuarantine: 0, pullQuarantine: 0, excludedNative: 0, scope: 'eligible' as const },
  })
  const s3 = (parts: {
    state: 'current' | 'stale' | 'error'
    lastMergeAt?: number | null
    mergedPeers?: string[] | null
    lastError?: string | null
  }) => ({ lastMergeAt: null, mergedPeers: null, lastError: null, lastGenerationMerged: null, ...parts })

  it('presents the S3 truth for a current merge, keyed by the shared union words', () => {
    const status = getConnectionStatus({ ...live, syncReceivedAt: 99_000,
      sync: { ...cloudSync('current'), s3: s3({ state: 'current', lastMergeAt: 90_000, mergedPeers: ['device-a', 'device-b'] }) } })
    assert.deepEqual(status.s3, {
      state: 'current', label: 'Current', tone: 'positive',
      lastMergeAt: 90_000, mergedPeers: ['device-a', 'device-b'], lastError: null,
    })
  })

  it('presents stale with its two distinct sub-cases: never discovered vs discovered-none-pushed', () => {
    const neverDiscovered = getConnectionStatus({ ...live, syncReceivedAt: 99_000,
      sync: { ...cloudSync('unconfigured'), s3: s3({ state: 'stale', lastMergeAt: 90_000, mergedPeers: null }) } })
    assert.equal(neverDiscovered.s3?.label, 'Waiting for the first merge')
    assert.equal(neverDiscovered.s3?.tone, 'neutral')
    assert.equal(neverDiscovered.s3?.mergedPeers, null)
    assert.equal(neverDiscovered.s3?.lastMergeAt, 90_000)

    const discoveredNone = getConnectionStatus({ ...live, syncReceivedAt: 99_000,
      sync: { ...cloudSync('unconfigured'), s3: s3({ state: 'stale', lastMergeAt: 90_000, mergedPeers: [] }) } })
    assert.deepEqual(discoveredNone.s3?.mergedPeers, [])
    assert.equal(discoveredNone.s3?.label, 'Waiting for the first merge')
  })

  it('presents an error with the worker error in tow, warning tone', () => {
    const status = getConnectionStatus({ ...live, syncReceivedAt: 99_000,
      sync: { ...cloudSync('current'), s3: s3({ state: 'error', lastMergeAt: 95_000,
        lastError: 'downloaded file does not match the manifest: claude-mem.db.gz' }) } })
    assert.equal(status.s3?.state, 'error')
    assert.equal(status.s3?.tone, 'warning')
    assert.equal(status.s3?.lastError, 'downloaded file does not match the manifest: claude-mem.db.gz')
  })

  it('keeps the s3 row even when cloud sync is unconfigured — the owner’s complaint never renders again', () => {
    // s3 enabled + cloud unconfigured: the sync row is the Memory sync row
    // (bits.tsx renders it instead of the Cloud copy row), so "cloud sync is
    // disabled" has no row to appear in. The presentation coexists honestly.
    const status = getConnectionStatus({ ...live, syncReceivedAt: 99_000,
      sync: { ...cloudSync('unconfigured'), s3: s3({ state: 'current', lastMergeAt: 90_000, mergedPeers: ['device-a'] }) } })
    assert.equal(status.sync?.label, 'Cloud sync off')
    assert.equal(status.s3?.state, 'current')
  })

  it('yields the row back to cloud when Cloud Sync is configured and s3 shows the refusal shape', () => {
    // Both configured: the merge refuses before discovery (mergedPeers null,
    // mergeState empty, forever) — 'stale' is a permanent refusal, not a
    // wait, and the truthful row is the Cloud copy that IS syncing.
    const status = getConnectionStatus({ ...live, syncReceivedAt: 99_000,
      sync: { ...cloudSync('current'), s3: s3({ state: 'stale', lastMergeAt: 90_000, mergedPeers: null }) } })
    assert.equal(status.sync?.label, 'Cloud data current')
    assert.equal(status.s3, null)
  })

  it('keeps the s3 row under a configured cloud when s3 has its own evidence (error)', () => {
    // The refusal suppression is shape-specific: an s3 ERROR is the S3
    // dimension's own truth even beside a configured cloud.
    const status = getConnectionStatus({ ...live, syncReceivedAt: 99_000,
      sync: { ...cloudSync('current'), s3: s3({ state: 'error', lastMergeAt: 95_000,
        lastError: 'downloaded file does not match the manifest: claude-mem.db.gz' }) } })
    assert.equal(status.s3?.state, 'error')
    assert.equal(status.s3?.lastError, 'downloaded file does not match the manifest: claude-mem.db.gz')
  })

  it('without an s3 dimension the presentation is null and the cloud row is byte-identical to today', () => {
    const status = getConnectionStatus({ ...live, syncReceivedAt: 99_000, sync: cloudSync('current') })
    assert.equal(status.s3, null)
    // The exact pre-change words for the same cloud input (golden) — presentSync
    // joins the state sentence with the delivery-mode sentence.
    assert.deepEqual({ label: status.sync?.label, tone: status.sync?.tone, detail: status.sync?.detail, isCurrent: status.sync?.isCurrent },
      { label: 'Cloud data current', tone: 'positive', detail: 'Cloud sync is current. Mode: HTTP polling.', isCurrent: true })
  })

  it('treats an unknown wire state as no evidence rather than inventing words for it', () => {
    const status = getConnectionStatus({ ...live, syncReceivedAt: 99_000,
      sync: { ...cloudSync('current'), s3: { state: 'mystery', lastMergeAt: 1, mergedPeers: null, lastError: null } as never } })
    assert.equal(status.s3, null)
  })
})

