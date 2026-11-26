import { describe, expect, test } from 'bun:test';
import { composeS3SyncStatus, composeViewerSyncStatus, type S3SyncEvidence } from '../../src/shared/viewer-sync-status.js';
import { ViewerSyncService } from '../../src/services/sync/ViewerSyncService.js';
import type { ViewerSyncStatus } from '../../src/shared/viewer-sync-status.js';

// --- evidence builders ------------------------------------------------------

type MergePeerState = S3SyncEvidence['merge']['mergeState'][string];

function mergeState(state: MergePeerState['state'], lastMergeAt: number, lastError: string | null = null): MergePeerState {
  return { state, applied: state === 'ok' ? 1 : 0, lastMergeAt, lastError };
}

function evidence(parts: {
  peers?: string[] | null;
  mergedGenerations?: Record<string, string>;
  mergeState?: Record<string, MergePeerState>;
}): S3SyncEvidence {
  return {
    merge: {
      peers: parts.peers ?? null,
      mergedGenerations: parts.mergedGenerations ?? {},
      mergeState: parts.mergeState ?? {},
    },
  };
}

describe('composeS3SyncStatus (the s3 dimension of sync_status)', () => {
  test('S3 disabled (no evidence) → the dimension is null', () => {
    expect(composeS3SyncStatus(null)).toBeNull();
    // The full composer embeds null the same way when no accessor is wired.
    expect(composeViewerSyncStatus(null, null, null, 1000).s3).toBeNull();
  });

  test('enabled, never merged → stale with nulls', () => {
    expect(composeS3SyncStatus(evidence({}))).toEqual({
      state: 'stale',
      lastMergeAt: null,
      mergedPeers: null,
      lastError: null,
      lastGenerationMerged: null,
    });
  });

  test('one peer ok → current, truthful peers/lastMergeAt', () => {
    const value = composeS3SyncStatus(evidence({
      peers: ['device-a'],
      mergedGenerations: { 'device-a': '2025-11-26T10-00-00-000Z' },
      mergeState: { 'device-a': mergeState('ok', 5000) },
    }));
    expect(value).toEqual({
      state: 'current',
      lastMergeAt: 5000,
      mergedPeers: ['device-a'],
      lastError: null,
      lastGenerationMerged: '2025-11-26T10-00-00-000Z',
    });
  });

  test('a peer error later than the ok → error with the error message', () => {
    const value = composeS3SyncStatus(evidence({
      peers: ['device-a'],
      mergedGenerations: { 'device-a': '2025-11-26T10-00-00-000Z' },
      mergeState: { 'device-a': mergeState('error', 6000, 'downloaded file does not match the manifest: claude-mem.db.gz') },
    }));
    expect(value).toMatchObject({ state: 'error', lastMergeAt: 6000, lastError: 'downloaded file does not match the manifest: claude-mem.db.gz' });
  });

  test('an ok later than the error → back to current, lastError cleared', () => {
    const value = composeS3SyncStatus(evidence({
      peers: ['device-a'],
      mergedGenerations: { 'device-a': '2025-11-26T11-00-00-000Z' },
      mergeState: { 'device-a': mergeState('ok', 7000) },
    }));
    expect(value).toMatchObject({ state: 'current', lastMergeAt: 7000, lastError: null });
  });

  test('an error tied with the latest ok → error (conservative tie rule, documented)', () => {
    const value = composeS3SyncStatus(evidence({
      peers: ['device-a', 'device-b'],
      mergedGenerations: { 'device-a': '2025-11-26T10-00-00-000Z' },
      mergeState: {
        'device-a': mergeState('ok', 5000),
        'device-b': mergeState('error', 5000, 'peer db LATEST marker is unreadable'),
      },
    }));
    expect(value).toMatchObject({ state: 'error', lastError: 'peer db LATEST marker is unreadable' });
  });

  test('a skipped peer WITH a watermark is healthy evidence — the converged steady state stays current', () => {
    // After convergence every tick skips (nothing new); the watermark proves
    // the peer is fully merged, so this must read current, never stale.
    const value = composeS3SyncStatus(evidence({
      peers: ['device-a'],
      mergedGenerations: { 'device-a': '2025-11-26T10-00-00-000Z' },
      mergeState: { 'device-a': mergeState('skipped', 9000) },
    }));
    expect(value).toMatchObject({ state: 'current', lastMergeAt: 9000, lastError: null });
  });

  test('a skipped peer WITHOUT a watermark is not healthy evidence', () => {
    // A skip with no watermark means the peer was discovered but has never
    // pushed a snapshot — nothing merged, no freshness evidence.
    const value = composeS3SyncStatus(evidence({
      peers: ['device-a'],
      mergeState: { 'device-a': mergeState('skipped', 9000) },
    }));
    expect(value).toMatchObject({ state: 'stale', lastMergeAt: 9000 });
  });

  test('a watermarkless skip does not mask a peer error', () => {
    const value = composeS3SyncStatus(evidence({
      peers: ['device-a', 'device-b'],
      mergedGenerations: { 'device-a': '2025-11-26T10-00-00-000Z' },
      mergeState: {
        'device-a': mergeState('error', 5000, 'failed to read peer snapshot for device-a'),
        'device-b': mergeState('skipped', 6000),
      },
    }));
    expect(value).toMatchObject({ state: 'error', lastError: 'failed to read peer snapshot for device-a' });
  });

  test('lastGenerationMerged is the latest generation lexicographically', () => {
    const value = composeS3SyncStatus(evidence({
      mergedGenerations: {
        'device-a': '2025-11-25T10-00-00-000Z',
        'device-b': '2025-11-26T09-00-00-000Z',
      },
      mergeState: { 'device-a': mergeState('ok', 5000), 'device-b': mergeState('ok', 4000) },
    }));
    expect(value).toMatchObject({ state: 'current', lastGenerationMerged: '2025-11-26T09-00-00-000Z' });
  });

  test('the full composer embeds the mapped s3 dimension without touching the cloud state', () => {
    const value = composeViewerSyncStatus(null, null, null, 1000, evidence({
      peers: ['device-a'],
      mergedGenerations: { 'device-a': '2025-11-26T10-00-00-000Z' },
      mergeState: { 'device-a': mergeState('ok', 5000) },
    }));
    expect(value.state).toBe('unconfigured'); // cloud state untouched
    expect(value.s3).toMatchObject({ state: 'current', mergedPeers: ['device-a'] });
  });
});

describe('s3 rides the existing sync_status broadcast path', () => {
  test('publish() fires onChange when the s3 evidence changes and stays quiet when it does not', () => {
    let current: S3SyncEvidence | null = evidence({});
    const broadcasts: ViewerSyncStatus[] = [];
    const service = new ViewerSyncService({
      cloud: () => null,
      pull: () => null,
      s3: () => current,
      hasViewers: () => true,
      now: () => 1000,
      onChange: value => broadcasts.push(value),
    });
    // The 5-second interval drives publish() in production; what Task 6 pins
    // is the signature-diff contract — s3 changes must ride the same path —
    // so the test drives publish() directly (house private-access precedent).
    const publish = (service as unknown as { publish: () => void }).publish;
    publish.call(service);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].s3).toMatchObject({ state: 'stale' });

    publish.call(service); // identical evidence → no rebroadcast
    expect(broadcasts).toHaveLength(1);

    current = evidence({ // a peer merged → the signature changes → rebroadcast
      peers: ['device-a'],
      mergedGenerations: { 'device-a': '2025-11-26T10-00-00-000Z' },
      mergeState: { 'device-a': mergeState('ok', 5000) },
    });
    publish.call(service);
    expect(broadcasts).toHaveLength(2);
    expect(broadcasts[1].s3).toMatchObject({ state: 'current' });
    service.close();
  });
});
