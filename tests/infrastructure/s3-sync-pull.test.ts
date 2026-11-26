import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../../src/shared/paths.js';
import { S3SyncManager } from '../../src/services/s3sync/S3SyncManager.js';
import type { S3Transport } from '../../src/services/s3sync/s3-transport.js';
import { applyPendingChromaRestore } from '../../src/services/s3sync/chroma-restore.js';
import {
  readPendingChromaRestore, readPendingRestore, stagePendingChromaRestore,
} from '../../src/services/backup/snapshot-files.js';

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
  writeFileSync(join(dir, '.env'), 'TEST_PULL_SIDECAR=1\n');
  mkdirSync(join(dir, 'chroma'), { recursive: true });
  const chroma = new Database(join(dir, 'chroma', 'chroma.sqlite3'));
  chroma.exec('CREATE TABLE embeddings (id INTEGER PRIMARY KEY)');
  chroma.close();
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

interface Isolated {
  dir: string;
  cleanup(): void;
}

/**
 * Redirect every real-dir touchpoint the pull flow could reach through the
 * paths object into a temp dir, so no test ever reads or writes the real
 * ~/.claude-mem. The manager itself gets the temp dir injected; the spies are
 * the proof that nothing falls back to the globals.
 */
function isolate(): Isolated {
  const dir = mkdtempSync(join(tmpdir(), 's3sync-pull-'));
  const previousDataDir = process.env.CLAUDE_MEM_DATA_DIR;
  process.env.CLAUDE_MEM_DATA_DIR = dir;
  const pendingSpy = spyOn(paths, 'pendingRestore').mockReturnValue(join(dir, 'backups', 'restore-pending.json'));
  const pendingChromaSpy = spyOn(paths, 'pendingChromaRestore').mockReturnValue(join(dir, 'backups', 'restore-chroma-pending.json'));
  const incomingSpy = spyOn(paths, 's3syncIncoming').mockReturnValue(join(dir, 'backups', 's3sync-incoming'));
  return {
    dir,
    cleanup() {
      pendingSpy.mockRestore();
      pendingChromaSpy.mockRestore();
      incomingSpy.mockRestore();
      if (previousDataDir === undefined) delete process.env.CLAUDE_MEM_DATA_DIR;
      else process.env.CLAUDE_MEM_DATA_DIR = previousDataDir;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Push both sets so the FakeS3 bucket holds one db and one chroma generation. */
async function pushBothSets(dir: string, s3: FakeS3): Promise<{ dbGen: string; chromaGen: string }> {
  makeFixture(dir);
  const manager = makeManager(dir, s3);
  const db = await manager.runNow('db');
  const chroma = await manager.runNow('chroma');
  return { dbGen: db!.generation, chromaGen: chroma!.generation };
}

describe('boot-time chroma restore', () => {
  let isolated: Isolated;

  afterEach(() => {
    if (isolated) isolated.cleanup();
  });

  test('swaps the chroma dir with the staged one, clears the marker, keeps the pre-restore copy', () => {
    isolated = isolate();
    const dir = isolated.dir;
    const chromaDir = join(dir, 'chroma');
    mkdirSync(chromaDir, { recursive: true });
    writeFileSync(join(chromaDir, 'old.txt'), 'old');
    const staging = join(dir, 'state', 's3sync', 'chroma-restore-g1');
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, 'chroma.sqlite3'), 'new db');
    const marker = join(dir, 'backups', 'restore-chroma-pending.json');
    stagePendingChromaRestore(staging, 'g1', marker);

    const result = applyPendingChromaRestore(chromaDir, marker);

    expect(result?.ok).toBe(true);
    expect(existsSync(join(chromaDir, 'chroma.sqlite3'))).toBe(true);
    expect(existsSync(join(chromaDir, 'old.txt'))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    const preRestore = readdirSync(dir).filter(name => name.startsWith('chroma-pre-restore-'));
    expect(preRestore.length).toBe(1);
    expect(existsSync(join(dir, preRestore[0], 'old.txt'))).toBe(true);
  });

  test('no marker → null, nothing touched', () => {
    isolated = isolate();
    const dir = isolated.dir;
    const chromaDir = join(dir, 'chroma');
    mkdirSync(chromaDir, { recursive: true });
    writeFileSync(join(chromaDir, 'old.txt'), 'old');
    const marker = join(dir, 'backups', 'restore-chroma-pending.json');

    const result = applyPendingChromaRestore(chromaDir, marker);

    expect(result).toBeNull();
    expect(existsSync(join(chromaDir, 'old.txt'))).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(dir).filter(name => name.startsWith('chroma-pre-restore-')).length).toBe(0);
  });

  test('failed swap (staging missing) keeps the old chroma dir', () => {
    isolated = isolate();
    const dir = isolated.dir;
    const chromaDir = join(dir, 'chroma');
    mkdirSync(chromaDir, { recursive: true });
    writeFileSync(join(chromaDir, 'old.txt'), 'old');
    const marker = join(dir, 'backups', 'restore-chroma-pending.json');
    stagePendingChromaRestore(join(dir, 'state', 's3sync', 'chroma-restore-gone'), undefined, marker);

    const result = applyPendingChromaRestore(chromaDir, marker);

    expect(result?.ok).toBe(false);
    expect(result?.error).toContain('staging dir is missing');
    expect(existsSync(join(chromaDir, 'old.txt'))).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(dir).filter(name => name.startsWith('chroma-pre-restore-')).length).toBe(0);
  });
});

describe('manager pull', () => {
  let isolated: Isolated;

  afterEach(() => {
    if (isolated) isolated.cleanup();
  });

  test('pull all stages a db restore and a ready-to-use chroma staging dir', async () => {
    isolated = isolate();
    const dir = isolated.dir;
    const s3 = new FakeS3();
    const { dbGen, chromaGen } = await pushBothSets(dir, s3);
    const manager = makeManager(dir, s3);

    const result = await manager.pull({ set: 'all' });

    expect(result.sets.map(s => s.set)).toEqual(['db', 'chroma']);
    expect(result.sets.every(s => s.status === 'pulled')).toBe(true);

    // downloaded db files wait in the incoming dir
    const dbIncoming = join(dir, 'backups', 's3sync-incoming', `db-${dbGen}`);
    expect(existsSync(join(dbIncoming, 'claude-mem.db.gz'))).toBe(true);
    expect(existsSync(join(dbIncoming, 'settings.json'))).toBe(true);

    // db: gunzipped snapshot under backups/, opens, holds the pushed row
    const stagedDb = join(dir, 'backups', `claude-mem-${dbGen}-from-s3.db`);
    expect(existsSync(stagedDb)).toBe(true);
    const db = new Database(stagedDb, { readonly: true });
    const rows = db.query('SELECT COUNT(*) AS n FROM observations').get() as { n: number };
    db.close();
    expect(rows.n).toBe(1);

    // db restore marker names that snapshot
    const pending = readPendingRestore(join(dir, 'backups', 'restore-pending.json'));
    expect(pending?.snapshot).toBe(`claude-mem-${dbGen}-from-s3.db`);

    // chroma: staging dir with chroma.sqlite3 at its root (chroma/ stripped, gunzipped)
    const staging = join(dir, 'state', 's3sync', `chroma-restore-${chromaGen}`);
    expect(existsSync(join(staging, 'chroma.sqlite3'))).toBe(true);
    const chromaPending = readPendingChromaRestore(join(dir, 'backups', 'restore-chroma-pending.json'));
    expect(chromaPending?.stagingDir).toBe(staging);
    expect(chromaPending?.pairedDbGeneration).toBe(dbGen);

    // live files were never overwritten — only .bak-s3sync sidecars
    expect(existsSync(join(dir, 'settings.json.bak-s3sync'))).toBe(true);
    expect(existsSync(join(dir, '.env.bak-s3sync'))).toBe(true);
  });

  test('chroma paired with a foreign db generation is refused and stages nothing', async () => {
    isolated = isolate();
    const dir = isolated.dir;
    const s3 = new FakeS3();
    await pushBothSets(dir, s3);
    const manager = makeManager(dir, s3);
    // tamper with the remote chroma manifest: pair it with a db generation no pull produced
    const chromaManifestKey = [...s3.objects.keys()].find(k => k.includes('/chroma/gen/') && k.endsWith('/manifest.json'))!;
    const manifest = JSON.parse(s3.objects.get(chromaManifestKey)!.toString());
    manifest.pairedDbGeneration = '2099-01-01T00-00-00-000Z';
    s3.objects.set(chromaManifestKey, Buffer.from(JSON.stringify(manifest)));

    await expect(manager.pull({ set: 'all' })).rejects.toThrow(/chroma index is paired with db generation/);

    expect(existsSync(join(dir, 'backups', 'restore-chroma-pending.json'))).toBe(false);
  });

  test('pull from an empty bucket resolves without throwing and stages nothing', async () => {
    isolated = isolate();
    const dir = isolated.dir;
    makeFixture(dir);
    const manager = makeManager(dir, new FakeS3()); // fresh, empty bucket

    const result = await manager.pull({ set: 'all' });

    expect(result.sets.every(s => s.status === 'skipped')).toBe(true);
    expect(existsSync(join(dir, 'backups', 'restore-pending.json'))).toBe(false);
    expect(existsSync(join(dir, 'backups', 'restore-chroma-pending.json'))).toBe(false);
    expect(existsSync(join(dir, 'backups', 's3sync-incoming'))).toBe(false);
  });
});
