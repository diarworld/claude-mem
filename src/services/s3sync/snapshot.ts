/**
 * Local snapshot sets for S3 Sync. The SQLite copies go through
 * runSqliteFileJob (VACUUM INTO → standalone → quick_check) exactly like
 * BackupManager — a live db is never copied raw. chroma.sqlite3 gets the same
 * treatment; the HNSW binary files are copied directly under the worker's
 * chroma writer lock with a stability check (size+mtime read before and after
 * the copy; a change means the index was written mid-copy → retry once, then
 * fail the chroma set; the db set is unaffected and chroma is rebuildable).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { runSqliteFileJob } from '../backup/sqlite-file-job.js';

export interface SnapshotInput {
  dbPath: string;
  reviewsDbPath: string;
  chromaDir: string;
  dataDir: string;
  settingsPath: string;
  envPath: string;
  stateDir: string;
}

export interface SnapshotEntry {
  /** File on disk (inside the work dir), ready to upload. */
  absolutePath: string;
  /** Key relative to the generation prefix. */
  key: string;
  bytes: number;
}

export async function gzipFile(src: string, dst: string): Promise<void> {
  await pipeline(createReadStream(src), createGzip({ level: 6 }), createWriteStream(dst));
}

export async function gunzipFile(src: string, dst: string): Promise<void> {
  await pipeline(createReadStream(src), createGunzip(), createWriteStream(dst));
}

async function snapshotAndGzip(source: string, workDir: string, key: string, signal?: AbortSignal): Promise<SnapshotEntry> {
  const raw = path.join(workDir, path.basename(key).replace(/\.gz$/, ''));
  const gz = path.join(workDir, key.split('/').pop()!);
  await runSqliteFileJob({ kind: 'snapshot', source, target: raw }, signal);
  await gzipFile(raw, gz);
  unlinkSync(raw);
  return { absolutePath: gz, key, bytes: statSync(gz).size };
}

function copyIfExists(src: string, key: string, workDir: string): SnapshotEntry | null {
  if (!existsSync(src)) return null;
  const dst = path.join(workDir, key);
  mkdirSync(path.dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return { absolutePath: dst, key, bytes: statSync(dst).size };
}

export async function buildDbSnapshotSet(
  workDir: string,
  input: SnapshotInput,
  options: { includeEnv: boolean; signal?: AbortSignal },
): Promise<SnapshotEntry[]> {
  mkdirSync(workDir, { recursive: true });
  const entries: SnapshotEntry[] = [];
  entries.push(await snapshotAndGzip(input.dbPath, workDir, 'claude-mem.db.gz', options.signal));
  if (existsSync(input.reviewsDbPath)) {
    entries.push(await snapshotAndGzip(input.reviewsDbPath, workDir, 'work-view-reviews.db.gz', options.signal));
  }
  for (const [src, key] of [
    [input.settingsPath, 'settings.json'],
    [path.join(path.dirname(input.settingsPath), 'MY-RULES.md'), 'MY-RULES.md'],
    [path.join(path.dirname(input.settingsPath), 'chroma-sync-state.json'), 'chroma-sync-state.json'],
  ] as const) {
    const copied = copyIfExists(src, key, workDir);
    if (copied) entries.push(copied);
  }
  if (options.includeEnv) {
    const env = copyIfExists(input.envPath, 'env', workDir);
    if (env) entries.push(env);
  }
  if (existsSync(input.stateDir)) {
    for (const name of readdirSync(input.stateDir, { withFileTypes: true })) {
      if (!name.isFile() || !name.name.endsWith('.json')) continue;
      const copied = copyIfExists(path.join(input.stateDir, name.name), `state/${name.name}`, workDir);
      if (copied) entries.push(copied);
    }
  }
  return entries;
}

/** Copy an HNSW file, refusing a torn copy: size+mtime must be identical before and after. */
async function copyStable(src: string, dst: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = statSync(src);
    copyFileSync(src, dst);
    const after = statSync(src);
    if (before.size === after.size && before.mtimeMs === after.mtimeMs) return;
    await sleep(250);
  }
  throw new Error(`chroma index file changed during copy: ${src} (another writer? is the chroma writer lock held?)`);
}

export async function buildChromaSnapshotSet(
  workDir: string,
  input: SnapshotInput,
  options: { signal?: AbortSignal } = {},
): Promise<SnapshotEntry[]> {
  mkdirSync(workDir, { recursive: true });
  const chromaDbPath = path.join(input.chromaDir, 'chroma.sqlite3');
  if (!existsSync(chromaDbPath)) throw new Error(`chroma.sqlite3 not found at ${chromaDbPath}`);
  const entries: SnapshotEntry[] = [];
  entries.push(await snapshotAndGzip(chromaDbPath, workDir, 'chroma/chroma.sqlite3.gz', options.signal));
  for (const entry of readdirSync(input.chromaDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of readdirSync(path.join(input.chromaDir, entry.name), { withFileTypes: true })) {
      if (!file.isFile()) continue;
      const relKey = `chroma/${entry.name}/${file.name}`;
      const dst = path.join(workDir, relKey);
      mkdirSync(path.dirname(dst), { recursive: true });
      await copyStable(path.join(input.chromaDir, entry.name, file.name), dst);
      entries.push({ absolutePath: dst, key: relKey, bytes: statSync(dst).size });
    }
  }
  return entries;
}
