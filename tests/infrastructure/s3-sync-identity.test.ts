import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3SyncManager } from '../../src/services/s3sync/S3SyncManager.js';
import type { S3Transport } from '../../src/services/s3sync/s3-transport.js';
import { ORIGIN_DEVICE_ID_MAX_BYTES } from '../../src/shared/cloud-sync-limits.js';

class FakeS3 implements S3Transport {
  objects = new Map<string, Buffer>();
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
    const dir = mkdtempSync(join(tmpdir(), 's3sync-identity-'));
    return (async () => {
      try {
        await run(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();
  };
}

describe('s3 sync identity', () => {
  test('a fresh manager mints a UUID-shaped sync identity within ORIGIN_DEVICE_ID_MAX_BYTES', withTempDir(dir => {
    const manager = makeManager(dir);
    const identity = manager.status().syncIdentity;
    expect(identity).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(Buffer.byteLength(identity, 'utf-8')).toBeLessThanOrEqual(ORIGIN_DEVICE_ID_MAX_BYTES);
  }));

  test('the identity is stable across manager re-creation on the same data dir', withTempDir(async dir => {
    const first = makeManager(dir);
    const minted = first.status().syncIdentity;
    await first.stop();
    const second = makeManager(dir);
    expect(second.status().syncIdentity).toBe(minted);
  }));

  test('different data dirs mint different identities', withTempDir(async dir => {
    const otherDir = mkdtempSync(join(tmpdir(), 's3sync-identity-'));
    try {
      const first = makeManager(dir);
      const second = makeManager(otherDir);
      expect(second.status().syncIdentity).not.toBe(first.status().syncIdentity);
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  }));

  test('the identity is written to the persisted state file', withTempDir(dir => {
    const manager = makeManager(dir);
    const identity = manager.status().syncIdentity;
    const statePath = join(dir, 'state', 's3sync', 'state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as { syncIdentity?: string };
    expect(state.syncIdentity).toBe(identity);
  }));
});
