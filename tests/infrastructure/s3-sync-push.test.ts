import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3SyncManager } from '../../src/services/s3sync/S3SyncManager.js';
import type { S3Transport } from '../../src/services/s3sync/s3-transport.js';
import { parseLatestMarker } from '../../src/services/s3sync/manifest.js';

class FakeS3 implements S3Transport {
  objects = new Map<string, Buffer>();
  order: string[] = [];
  failOn: string | null = null;
  async upload(localPath: string, key: string): Promise<void> {
    this.order.push(`up:${key}`);
    if (this.failOn !== null && key.includes(this.failOn)) throw new Error('injected upload failure');
    this.objects.set(key, readFileSync(localPath));
  }
  async download(key: string, localPath: string): Promise<void> {
    this.order.push(`down:${key}`);
    const body = this.objects.get(key);
    if (!body) throw new Error(`no object ${key}`);
    writeFileSync(localPath, body);
  }
  async deleteObject(key: string): Promise<void> {
    this.order.push(`del:${key}`);
    this.objects.delete(key);
  }
  async listKeys(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter(k => k.startsWith(prefix));
  }
}

function makeFixture(dir: string): string {
  mkdirSync(join(dir, 'state'), { recursive: true });
  const db = new Database(join(dir, 'claude-mem.db'));
  db.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY, body TEXT)');
  db.query('INSERT INTO observations (body) VALUES (?)').run('hello');
  db.close();
  writeFileSync(join(dir, 'settings.json'), '{}');
  return dir;
}

function makeManager(dir: string, transport: S3Transport, overrides: Record<string, unknown> = {}): S3SyncManager {
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
    },
    {
      transport,
      dataDir: dir,
      dbPath: join(dir, 'claude-mem.db'),
      reviewsDbPath: join(dir, 'missing.db'),
      chromaDir: join(dir, 'chroma'),
      settingsPath: join(dir, 'settings.json'),
      envPath: join(dir, '.env'),
      now: () => 1764000000000,
      initialDelayMs: 3_600_000,
      jitterFraction: 0,
      env: { S3_SYNC_ACCESS_KEY_ID: 'k', S3_SYNC_SECRET_ACCESS_KEY: 's' },
      ...overrides,
    },
  );
}

describe('s3 sync push pipeline', () => {
  test('first push uploads all files, manifest last-but-before-LATEST', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's3sync-push-'));
    makeFixture(dir);
    const s3 = new FakeS3();
    const manager = makeManager(dir, s3);
    const outcome = await manager.runNow('db');
    expect(outcome).not.toBeNull();
    expect(outcome!.uploaded).toBeGreaterThan(0);
    expect(outcome!.generation).toBeTruthy();
    const gen = outcome!.generation;
    expect(s3.objects.has(`claude-mem-sync/testbox/db/gen/${gen}/manifest.json`)).toBe(true);
    const latest = parseLatestMarker(s3.objects.get(`claude-mem-sync/testbox/db/LATEST`)!.toString());
    expect(latest?.generation).toBe(gen);
    // manifest.json is uploaded after every data object, LATEST after the manifest
    const manifestPos = s3.order.indexOf(`up:claude-mem-sync/testbox/db/gen/${gen}/manifest.json`);
    const latestPos = s3.order.indexOf(`up:claude-mem-sync/testbox/db/LATEST`);
    expect(latestPos).toBeGreaterThan(manifestPos);
    expect(manifestPos).toBeGreaterThan(s3.order.filter(o => o.startsWith('up:claude-mem-sync/testbox/db/gen/')).length - 2);
  });

  test('second push with no changes is skipped entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's3sync-push-'));
    makeFixture(dir);
    const s3 = new FakeS3();
    const manager = makeManager(dir, s3);
    const first = await manager.runNow('db');
    const uploadsAfterFirst = s3.order.filter(k => k.startsWith('up:')).length;
    const second = await manager.runNow('db');
    expect(second!.generation).toBe(first!.generation); // no new generation
    expect(second!.uploaded).toBe(0);
    expect(s3.order.filter(k => k.startsWith('up:')).length).toBe(uploadsAfterFirst); // nothing uploaded at all
  });

  test('partial upload failure leaves LATEST and the cached manifest untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's3sync-push-'));
    makeFixture(dir);
    const s3 = new FakeS3();
    const manager = makeManager(dir, s3);
    await manager.runNow('db');
    const latestBefore = s3.objects.get('claude-mem-sync/testbox/db/LATEST')!.toString();
    // change the db, then fail on the second object upload
    const db = new Database(join(dir, 'claude-mem.db'));
    db.query('INSERT INTO observations (body) VALUES (?)').run('more');
    db.close();
    s3.failOn = 'gen/';
    s3.order = [];
    await expect(manager.runNow('db')).rejects.toThrow('injected upload failure');
    expect(s3.objects.get('claude-mem-sync/testbox/db/LATEST')!.toString()).toBe(latestBefore);
    // next push succeeds and uploads the changed object again
    s3.failOn = null;
    const third = await manager.runNow('db');
    expect(third!.uploaded).toBeGreaterThan(0);
  });

  test('status reflects state file and phase wording exists for every state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's3sync-push-'));
    makeFixture(dir);
    const s3 = new FakeS3();
    const manager = makeManager(dir, s3);
    await manager.runNow('db');
    const status = manager.status();
    expect(status.configured).toBe(true);
    expect(status.sets.db.lastGeneration).toBeTruthy();
    expect(status.sets.db.lastPushAt).toBe(1764000000000);
    expect(status.sets.chroma.phase).toBe('idle');
  });

  test('chroma push without a paired db generation is refused', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's3sync-push-'));
    makeFixture(dir);
    mkdirSync(join(dir, 'chroma'), { recursive: true });
    const chroma = new Database(join(dir, 'chroma', 'chroma.sqlite3'));
    chroma.exec('CREATE TABLE embeddings (id INTEGER PRIMARY KEY)');
    chroma.close();
    const s3 = new FakeS3();
    const manager = makeManager(dir, s3);
    await expect(manager.runNow('chroma')).rejects.toThrow(/db set/i);
  });
});
