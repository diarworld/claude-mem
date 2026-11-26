import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChromaSnapshotSet, buildDbSnapshotSet, gunzipFile, type SnapshotInput } from '../../src/services/s3sync/snapshot.js';

function makeInput(dir: string): SnapshotInput {
  mkdirSync(join(dir, 'state'), { recursive: true });
  mkdirSync(join(dir, 'chroma', 'col-1'), { recursive: true });
  const db = new Database(join(dir, 'claude-mem.db'));
  db.exec('CREATE TABLE observations (id INTEGER PRIMARY KEY, body TEXT)');
  db.query('INSERT INTO observations (body) VALUES (?)').run('hello');
  db.close();
  const reviews = new Database(join(dir, 'work-view-reviews.db'));
  reviews.exec('CREATE TABLE reviews (id INTEGER PRIMARY KEY)');
  reviews.close();
  const chroma = new Database(join(dir, 'chroma', 'chroma.sqlite3'));
  chroma.exec('CREATE TABLE embeddings (id INTEGER PRIMARY KEY, vec BLOB)');
  chroma.close();
  writeFileSync(join(dir, 'settings.json'), '{"CLAUDE_MEM_MODE":"default"}');
  writeFileSync(join(dir, '.env'), 'S3_SYNC_ACCESS_KEY_ID=x');
  writeFileSync(join(dir, 'MY-RULES.md'), '# rules');
  writeFileSync(join(dir, 'chroma-sync-state.json'), '{}');
  writeFileSync(join(dir, 'state', 'keep.json'), '{"a":1}');
  writeFileSync(join(dir, 'state', 'skip.txt'), 'not json');
  writeFileSync(join(dir, 'chroma', 'col-1', 'data_level0.bin'), Buffer.alloc(1024, 7));
  return {
    dbPath: join(dir, 'claude-mem.db'),
    reviewsDbPath: join(dir, 'work-view-reviews.db'),
    chromaDir: join(dir, 'chroma'),
    settingsPath: join(dir, 'settings.json'),
    envPath: join(dir, '.env'),
    stateDir: join(dir, 'state'),
  };
}

describe('s3 sync snapshot builders', () => {
  test('db set snapshots, gzips and copies the right files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's3sync-snap-'));
    const input = makeInput(dir);
    const work = join(dir, 'work');
    const entries = await buildDbSnapshotSet(work, input, { includeEnv: true });
    const keys = entries.map(e => e.key).sort();
    expect(keys).toContain('claude-mem.db.gz');
    expect(keys).toContain('work-view-reviews.db.gz');
    expect(keys).toContain('settings.json');
    expect(keys).toContain('env');
    expect(keys).toContain('MY-RULES.md');
    expect(keys).toContain('chroma-sync-state.json');
    expect(keys).toContain('state/keep.json');
    expect(keys).not.toContain('state/skip.txt');
    // the gzip output is a real gzip of the standalone snapshot
    const dbEntry = entries.find(e => e.key === 'claude-mem.db.gz')!;
    const out = join(dir, 'roundtrip.db');
    await gunzipFile(dbEntry.absolutePath, out);
    const reopened = new Database(out, { readonly: true });
    expect((reopened.query('SELECT count(*) AS n FROM observations').get() as { n: number }).n).toBe(1);
    reopened.close();
  });

  test('includeEnv=false leaves the env out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's3sync-snap-'));
    const entries = await buildDbSnapshotSet(join(dir, 'work'), makeInput(dir), { includeEnv: false });
    expect(entries.find(e => e.key === 'env')).toBeUndefined();
  });

  test('chroma set snapshots sqlite and copies hnsw files raw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's3sync-snap-'));
    const input = makeInput(dir);
    const entries = await buildChromaSnapshotSet(join(dir, 'work-c'), input);
    expect(entries.find(e => e.key === 'chroma/chroma.sqlite3.gz')).toBeDefined();
    expect(entries.find(e => e.key === 'chroma/col-1/data_level0.bin')).toBeDefined();
  });

  test('chroma set without chroma.sqlite3 rejects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's3sync-snap-'));
    const empty = join(dir, 'chroma-empty');
    mkdirSync(empty, { recursive: true });
    const input: SnapshotInput = {
      dbPath: join(dir, 'claude-mem.db'),
      reviewsDbPath: join(dir, 'work-view-reviews.db'),
      chromaDir: empty,
      settingsPath: join(dir, 'settings.json'),
      envPath: join(dir, '.env'),
      stateDir: join(dir, 'state'),
    };
    await expect(buildChromaSnapshotSet(join(dir, 'work-e'), input)).rejects.toThrow('chroma.sqlite3 not found');
  });
});
