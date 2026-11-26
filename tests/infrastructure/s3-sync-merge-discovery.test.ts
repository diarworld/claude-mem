import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverPeers, S3SyncManager } from '../../src/services/s3sync/S3SyncManager.js';
import type { S3Transport } from '../../src/services/s3sync/s3-transport.js';
import { S3_SYNC_ROOT } from '../../src/services/s3sync/manifest.js';

class FakeS3 implements S3Transport {
  objects = new Map<string, Buffer>();
  /** Seed a bucket object without touching the filesystem. */
  seed(key: string, body: string | Buffer = 'x'): void {
    this.objects.set(key, Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8'));
  }
  async upload(localPath: string, key: string): Promise<void> {
    this.objects.set(key, localPath as unknown as Buffer);
  }
  async download(key: string, localPath: string): Promise<void> {
    const body = this.objects.get(key);
    if (!body) throw new Error(`no object ${key}`);
  }
  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async listKeys(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter(k => k.startsWith(prefix));
  }
}

function makeManager(dir: string, settingsOverrides: Record<string, string> = {}): S3SyncManager {
  return new S3SyncManager(
    {
      CLAUDE_MEM_S3_SYNC_ENABLED: 'true',
      CLAUDE_MEM_S3_SYNC_ENDPOINT: 'https://s3.test',
      CLAUDE_MEM_S3_SYNC_BUCKET: 'bucket',
      CLAUDE_MEM_S3_SYNC_REGION: 'ru-central1',
      CLAUDE_MEM_S3_SYNC_DB_INTERVAL_HOURS: '6',
      CLAUDE_MEM_S3_SYNC_CHROMA_INTERVAL_HOURS: '24',
      CLAUDE_MEM_S3_SYNC_KEEP_GENERATIONS: '2',
      CLAUDE_MEM_S3_SYNC_INCLUDE_ENV: 'true',
      CLAUDE_MEM_S3_SYNC_INCLUDE_CHROMA: 'true',
      CLAUDE_MEM_S3_SYNC_DEVICE: 'testbox',
      ...settingsOverrides,
    },
    {
      transport: new FakeS3(),
      dataDir: dir,
      dbPath: join(dir, 'claude-mem.db'),
      reviewsDbPath: join(dir, 'missing.db'),
      chromaDir: join(dir, 'chroma'),
      backupsDir: join(dir, 'backups', 'auto'),
      settingsPath: join(dir, 'settings.json'),
      envPath: join(dir, '.env'),
      stateDir: join(dir, 'state'),
      now: () => 1764000000000,
      initialDelayMs: 3_600_000,
      jitterFraction: 0,
      env: { S3_SYNC_ACCESS_KEY_ID: 'k', S3_SYNC_SECRET_ACCESS_KEY: 's' },
    },
  );
}

function withTempDir(run: (dir: string) => void | Promise<void>): () => void | Promise<void> {
  return () => {
    const dir = mkdtempSync(join(tmpdir(), 's3sync-merge-disc-'));
    return (async () => {
      try {
        await run(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();
  };
}

// The watermark/merge-state helpers are private manager machinery (Task 4's
// tick is their only caller); the tests drive them through the same `as any`
// seam the pull tests use for private fields, and assert on the OBSERVABLE
// surfaces: status() and the persisted state file.

const NOW = 1764000000000;
const GEN1 = '2026-11-26T01-00-00-000Z';
const GEN2 = '2026-11-26T02-00-00-000Z';

describe('s3 sync peer discovery', () => {
  test('discoverPeers extracts distinct device roots, excludes own, sorted', async () => {
    const s3 = new FakeS3();
    s3.seed(`${S3_SYNC_ROOT}/device-a/db/LATEST`);
    s3.seed(`${S3_SYNC_ROOT}/device-a/db/manifest.json`);
    s3.seed(`${S3_SYNC_ROOT}/device-b/chroma/2026-11-26T00-00-00-000Z/manifest.json`);
    s3.seed(`${S3_SYNC_ROOT}/testbox/db/LATEST`); // own device root — excluded
    // edge keys: deeper than the LATEST/manifest shapes, and the bare root key
    s3.seed(`${S3_SYNC_ROOT}/device-a/db/gen/${GEN1}/part/file.gz`);
    s3.seed(`${S3_SYNC_ROOT}/`);
    expect(await discoverPeers(s3, 'testbox')).toEqual(['device-a', 'device-b']);
  });

  test('discoverPeers on an empty listing returns []', async () => {
    expect(await discoverPeers(new FakeS3(), 'testbox')).toEqual([]);
  });

  test('discoverMergePeers caches the listing into status().merge.peers', withTempDir(async dir => {
    const manager = makeManager(dir);
    // The transport is a private field; the manager builds its own FakeS3 (house fixture).
    const s3 = (manager as unknown as { transport: FakeS3 }).transport;
    s3.seed(`${S3_SYNC_ROOT}/device-a/db/LATEST`);
    s3.seed(`${S3_SYNC_ROOT}/testbox/db/LATEST`);

    expect(manager.status().merge.peers).toBeNull(); // never discovered yet — unknown, not empty

    expect(await manager.discoverMergePeers()).toEqual(['device-a']);
    expect(manager.status().merge.peers).toEqual(['device-a']);
    await manager.stop();
  }));

  test('discoverMergePeers sanitizes the raw device setting before excluding own (production path)', withTempDir(async dir => {
    // Windows hostnames are commonly uppercase and may carry spaces; push
    // writes the SANITIZED segment, so own-exclusion must key on the same
    // sanitized form — not the raw setting.
    const manager = makeManager(dir, { CLAUDE_MEM_S3_SYNC_DEVICE: 'Test Box' });
    const s3 = (manager as unknown as { transport: FakeS3 }).transport;
    s3.seed(`${S3_SYNC_ROOT}/test-box/db/LATEST`); // own, as sanitized
    s3.seed(`${S3_SYNC_ROOT}/device-a/db/LATEST`);

    expect(await manager.discoverMergePeers()).toEqual(['device-a']);
    await manager.stop();
  }));
});

describe('s3 sync per-peer watermarks', () => {
  test('recordPeerMerged sets the watermark + ok state; error/skipped leave the watermark alone', withTempDir(dir => {
    const manager = makeManager(dir);
    const m = manager as unknown as {
      recordPeerMerged(peer: string, generation: string, applied: number): void;
      recordPeerError(peer: string, error: string): void;
      recordPeerSkipped(peer: string): void;
      peerWatermark(peer: string): string | null;
    };

    m.recordPeerMerged('device-a', GEN1, 3);
    expect(m.peerWatermark('device-a')).toBe(GEN1);
    expect(manager.status().merge.mergedGenerations['device-a']).toBe(GEN1);
    expect(manager.status().merge.mergeState['device-a']).toEqual({
      state: 'ok', applied: 3, lastMergeAt: NOW, lastError: null,
    });

    m.recordPeerError('device-a', 'manifest hash mismatch');
    expect(m.peerWatermark('device-a')).toBe(GEN1); // watermark unchanged by an error
    const errorState = manager.status().merge.mergeState['device-a'];
    expect(errorState.state).toBe('error');
    expect(errorState.lastError).toBe('manifest hash mismatch');
    expect(errorState.lastMergeAt).toBe(NOW);

    m.recordPeerSkipped('device-b');
    expect(m.peerWatermark('device-b')).toBeNull();
    expect(manager.status().merge.mergeState['device-b'].state).toBe('skipped');
  }));

  test('an invalid generation never becomes a watermark (ignored, state clean)', withTempDir(dir => {
    const manager = makeManager(dir);
    const m = manager as unknown as {
      recordPeerMerged(peer: string, generation: string, applied: number): void;
      peerWatermark(peer: string): string | null;
    };

    m.recordPeerMerged('device-a', '../../etc/passwd', 1); // path traversal shape
    m.recordPeerMerged('device-a', 'not-a-stamp', 1); // malformed stamp
    expect(m.peerWatermark('device-a')).toBeNull();
    expect(manager.status().merge.mergedGenerations).toEqual({});
    expect(manager.status().merge.mergeState).toEqual({});

    // the peer stays recordable with a valid stamp afterwards
    m.recordPeerMerged('device-a', GEN2, 1);
    expect(m.peerWatermark('device-a')).toBe(GEN2);
  }));

  test('a corrupt persisted watermark reads as null instead of breaking comparisons', withTempDir(async dir => {
    const stateDir = join(dir, 'state', 's3sync');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
      version: 1,
      db: { lastPushAt: null, lastGeneration: null, lastError: null, lastPullAt: null },
      chroma: { lastPushAt: null, lastGeneration: null, lastError: null, lastPullAt: null },
      mergedGenerations: { 'device-a': '../..' },
    }), 'utf-8');
    const manager = makeManager(dir);
    const m = manager as unknown as { peerWatermark(peer: string): string | null };
    expect(m.peerWatermark('device-a')).toBeNull();
    // status keeps showing the persisted truth; the guard is read-side only
    expect(manager.status().merge.mergedGenerations['device-a']).toBe('../..');
    await manager.stop();
  }));
});

describe('s3 sync merge-state persistence', () => {
  test('watermarks and merge state survive manager re-creation on the same dir', withTempDir(async dir => {
    const first = makeManager(dir);
    const m = first as unknown as {
      recordPeerMerged(peer: string, generation: string, applied: number): void;
      recordPeerError(peer: string, error: string): void;
    };
    m.recordPeerMerged('device-a', GEN1, 2);
    m.recordPeerError('device-b', 'bucket unreachable');
    await first.stop();

    const second = makeManager(dir);
    const merge = second.status().merge;
    expect(merge.mergedGenerations['device-a']).toBe(GEN1);
    expect(merge.mergeState['device-a']).toMatchObject({ state: 'ok', applied: 2 });
    expect(merge.mergeState['device-b']).toMatchObject({ state: 'error', lastError: 'bucket unreachable' });
    expect((second as unknown as { peerWatermark(peer: string): string | null }).peerWatermark('device-a')).toBe(GEN1);
    await second.stop();
  }));

  test('a v2 state file with syncIdentity but no merge fields migrates: identity intact, maps empty, records preserve both', withTempDir(async dir => {
    const stateDir = join(dir, 'state', 's3sync');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
      version: 1,
      db: { lastPushAt: 1764000000000, lastGeneration: '2026-11-26T01-07-44-485Z', lastError: null, lastPullAt: null },
      chroma: { lastPushAt: null, lastGeneration: null, lastError: null, lastPullAt: null },
      syncIdentity: '0f8f2b9e-1111-4222-8333-444455556666',
    }), 'utf-8');

    const manager = makeManager(dir);
    expect(manager.status().syncIdentity).toBe('0f8f2b9e-1111-4222-8333-444455556666');
    expect(manager.status().merge.mergedGenerations).toEqual({});
    expect(manager.status().merge.mergeState).toEqual({});

    (manager as unknown as { recordPeerMerged(peer: string, generation: string, applied: number): void })
      .recordPeerMerged('device-a', GEN1, 1);
    const persisted = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf-8')) as {
      syncIdentity?: string;
      mergedGenerations?: Record<string, string>;
    };
    expect(persisted.syncIdentity).toBe('0f8f2b9e-1111-4222-8333-444455556666'); // not disturbed
    expect(persisted.mergedGenerations?.['device-a']).toBe(GEN1);
    await manager.stop();
  }));

  test('a fresh manager reports peers: null with empty maps in status', withTempDir(dir => {
    const manager = makeManager(dir);
    expect(manager.status().merge).toEqual({ peers: null, mergedGenerations: {}, mergeState: {} });
  }));
});
