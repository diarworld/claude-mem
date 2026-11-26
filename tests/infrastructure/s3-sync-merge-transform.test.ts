import { describe, expect, test, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transformSnapshotToOps } from '../../src/services/s3sync/merge.js';
import { stableDocumentId } from '../../src/services/sync/CanonicalContent.js';

// Columns copied verbatim from the live schema (sqlite_master of a real
// ~/.claude-mem/claude-mem.db, identical to the SessionStore migration).
const OBSERVATIONS_DDL = `CREATE TABLE "observations" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  text TEXT,
  type TEXT NOT NULL,
  title TEXT,
  subtitle TEXT,
  facts TEXT,
  narrative TEXT,
  concepts TEXT,
  files_read TEXT,
  files_modified TEXT,
  prompt_number INTEGER,
  discovery_tokens INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  content_hash TEXT,
  generated_by_model TEXT,
  relevance_count INTEGER DEFAULT 0,
  merged_into_project TEXT,
  agent_type TEXT,
  agent_id TEXT,
  metadata TEXT,
  synced_at INTEGER,
  origin_device_id TEXT,
  origin_local_id TEXT,
  sync_rev TEXT NOT NULL DEFAULT '1',
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  title_norm_key TEXT,
  reinforcement_dates TEXT,
  last_reinforced TEXT,
  FOREIGN KEY(memory_session_id) REFERENCES sdk_sessions(memory_session_id) ON DELETE CASCADE ON UPDATE CASCADE
)`;

const SDK_SESSIONS_DDL = `CREATE TABLE sdk_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT NOT NULL,
  memory_session_id TEXT UNIQUE,
  project TEXT NOT NULL,
  platform_source TEXT NOT NULL DEFAULT 'claude',
  user_prompt TEXT,
  started_at TEXT NOT NULL,
  started_at_epoch INTEGER NOT NULL,
  completed_at TEXT,
  completed_at_epoch INTEGER,
  status TEXT CHECK(status IN ('active', 'completed', 'failed')) NOT NULL DEFAULT 'active'
)`;

interface ObservationRow {
  memory_session_id: string;
  project: string;
  type: string;
  text?: string | null;
  title?: string | null;
  subtitle?: string | null;
  facts?: string | null;
  narrative?: string | null;
  concepts?: string | null;
  files_read?: string | null;
  files_modified?: string | null;
  prompt_number?: number | null;
  discovery_tokens?: number | null;
  created_at: string;
  created_at_epoch: number;
  content_hash?: string | null;
  metadata?: string | null;
  merged_into_project?: string | null;
  origin_device_id?: string | null;
  origin_local_id?: string | null;
  sync_rev?: string;
}

function buildSnapshotDb(dbPath: string, rows: ObservationRow[]): void {
  const db = new Database(dbPath);
  db.exec(OBSERVATIONS_DDL);
  db.exec(SDK_SESSIONS_DDL);
  const insert = db.prepare(`
    INSERT INTO observations
      (memory_session_id, project, text, type, title, subtitle, facts, narrative, concepts,
       files_read, files_modified, prompt_number, discovery_tokens, created_at, created_at_epoch,
       content_hash, metadata, merged_into_project, origin_device_id, origin_local_id, sync_rev)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.memory_session_id, row.project, row.text ?? null, row.type, row.title ?? null, row.subtitle ?? null,
      row.facts ?? null, row.narrative ?? null, row.concepts ?? null,
      row.files_read ?? null, row.files_modified ?? null, row.prompt_number ?? null, row.discovery_tokens ?? null,
      row.created_at, row.created_at_epoch, row.content_hash ?? null, row.metadata ?? null,
      row.merged_into_project ?? null, row.origin_device_id ?? null, row.origin_local_id ?? null, row.sync_rev ?? '1',
    );
  }
  db.close();
}

const OWN_A: ObservationRow = {
  memory_session_id: 'sess-1', project: 'demo', type: 'bugfix', text: 'alpha body',
  title: 'Alpha', facts: '["f1.txt"]', concepts: '["perf"]', files_read: '["src/a.ts"]',
  files_modified: '["src/b.ts"]', prompt_number: 3, discovery_tokens: 120,
  created_at: '2026-11-26T03:00:00.000Z', created_at_epoch: 1764000000000,
  content_hash: 'hash-a', metadata: '{"task":"Task 4 s3-transport"}',
};
const OWN_B: ObservationRow = {
  memory_session_id: 'sess-1', project: 'demo', type: 'decision', text: 'beta body',
  title: 'Beta', concepts: '[]',
  created_at: '2026-11-26T03:05:00.000Z', created_at_epoch: 1764000300000,
  content_hash: 'hash-b', sync_rev: '2',
};
const REPLICA: ObservationRow = {
  memory_session_id: 'sess-9', project: 'demo', type: 'bugfix', text: 'from a third device',
  title: 'Third', created_at: '2026-11-26T03:10:00.000Z', created_at_epoch: 1764000600000,
  content_hash: 'hash-c', origin_device_id: 'third-dev', origin_local_id: '7', sync_rev: '5',
};

// bun:sqlite on Windows releases the file handle lazily after close(), so the
// temp dir can be EBUSY for a moment: cleanup runs in afterEach (outside the
// test's error path, the s3-sync-manifest house pattern) with rm retries —
// a cleanup hiccup must never mask an assertion failure.
const tempDirs: string[] = [];

function withTempDb(rows: ObservationRow[], run: (dbPath: string) => void | Promise<void>): () => void | Promise<void> {
  return () => {
    const dir = mkdtempSync(join(tmpdir(), 's3sync-merge-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'claude-mem.db');
    buildSnapshotDb(dbPath, rows);
    return run(dbPath);
  };
}

const PEER = '0f8f2b9e-1111-4222-8333-444455556666';

describe('s3 sync merge transformer', () => {
  afterEach(() => {
    // bun:sqlite on Windows keeps the readonly database mapped until the
    // object is finalized — an explicit close() is not enough, so force a
    // sweep before removing the dirs (probe: without this, EBUSY forever).
    Bun.gc(true);
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  });

  test('own-rows become ops tagged with the peer sync id; replica-rows keep their origin verbatim', withTempDb([OWN_A, OWN_B, REPLICA], dbPath => {
    const result = transformSnapshotToOps(dbPath, PEER);

    expect(result.ops).toHaveLength(3);
    expect(result.skipped).toEqual([]);
    expect(result.counts).toEqual({ own: 2, replica: 1 });

    const [first, second, third] = result.ops;
    // own-rows: origin_device = the peer's sync identity, origin_id = the peer's local row id
    expect(first.origin_device).toBe(PEER);
    expect(first.origin_id).toBe('1');
    expect(second.origin_device).toBe(PEER);
    expect(second.origin_id).toBe('2');
    // replica-row: original origin preserved verbatim (transitive convergence)
    expect(third.origin_device).toBe('third-dev');
    expect(third.origin_id).toBe('7');

    // revs come from the peer rows' sync_rev
    expect(first.rev).toBe('1');
    expect(second.rev).toBe('2');
    expect(third.rev).toBe('5');

    // deterministic seq space: ascending row ids
    expect(result.ops.map(op => op.seq)).toEqual(['1', '2', '3']);
    expect(result.ops.every(op => op.kind === 'observation')).toBe(true);
    expect(result.ops.every(op => op.deleted === false)).toBe(true);
  }));

  test('op bodies carry the canonical observation fields in the local column shapes', withTempDb([OWN_A], dbPath => {
    const { ops } = transformSnapshotToOps(dbPath, PEER);
    expect(ops).toHaveLength(1);
    const body = JSON.parse(ops[0]!.body) as Record<string, unknown>;

    // values exactly as stored: JSON-string columns stay JSON strings, epoch is a number
    expect(body.memory_session_id).toBe('sess-1');
    expect(body.project).toBe('demo');
    expect(body.type).toBe('bugfix');
    expect(body.text).toBe('alpha body');
    expect(body.title).toBe('Alpha');
    expect(body.facts).toBe('["f1.txt"]');
    expect(body.concepts).toBe('["perf"]');
    expect(body.files_read).toBe('["src/a.ts"]');
    expect(body.files_modified).toBe('["src/b.ts"]');
    expect(body.prompt_number).toBe(3);
    expect(body.discovery_tokens).toBe(120);
    expect(body.created_at).toBe('2026-11-26T03:00:00.000Z');
    expect(body.created_at_epoch).toBe(1764000000000);
    expect(body.content_hash).toBe('hash-a');

    // device-local bookkeeping NEVER travels (SyncApply header: excluded from every row body)
    for (const absent of ['id', 'synced_at', 'origin_device_id', 'origin_local_id', 'sync_rev', 'relevance_count', 'occurrence_count', 'title_norm_key', 'reinforcement_dates', 'last_reinforced']) {
      expect(Object.hasOwn(body, absent)).toBe(false);
    }
  }));

  test('an observation whose session is absent from sdk_sessions is still transformed', withTempDb([{
    ...OWN_A, memory_session_id: 'ghost-session',
  }], dbPath => {
    const { ops, skipped, counts } = transformSnapshotToOps(dbPath, PEER);
    expect(skipped).toEqual([]);
    expect(counts).toEqual({ own: 1, replica: 0 });
    const body = JSON.parse(ops[0]!.body) as Record<string, unknown>;
    expect(body.memory_session_id).toBe('ghost-session');
  }));

  test('a malformed row is skipped with a reason naming the field; other rows are unaffected', withTempDb([
    { ...OWN_A, concepts: 'not-json{' },
    { ...OWN_B },
  ], dbPath => {
    const result = transformSnapshotToOps(dbPath, PEER);

    expect(result.ops).toHaveLength(1);
    expect(result.ops[0]!.origin_id).toBe('2'); // the healthy row went through
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.id).toBe(1);
    expect(result.skipped[0]!.reason).toContain('concepts');
    expect(result.counts).toEqual({ own: 1, replica: 0 });
  }));

  test('a row violating a canonical requirement is skipped with the canonical reason', withTempDb([
    { ...OWN_A, project: '' }, // required non-empty per CanonicalContent
  ], dbPath => {
    const result = transformSnapshotToOps(dbPath, PEER);
    expect(result.ops).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain('project');
  }));

  test('transforming the same db twice yields deep-equal op lists (deterministic ORDER BY id)', withTempDb([OWN_A, REPLICA, OWN_B], dbPath => {
    const first = transformSnapshotToOps(dbPath, PEER);
    const second = transformSnapshotToOps(dbPath, PEER);
    expect(second.ops).toEqual(first.ops);
    expect(second.skipped).toEqual(first.skipped);
    expect(second.counts).toEqual(first.counts);
  }));

  test('a pre-aborted signal throws instead of transforming', withTempDb([OWN_A], dbPath => {
    const controller = new AbortController();
    controller.abort();
    expect(() => transformSnapshotToOps(dbPath, PEER, { signal: controller.signal })).toThrow();
  }));

  test('every op id recomputes to stableDocumentId(observation, origin_device, origin_id)', withTempDb([OWN_A, OWN_B, REPLICA], dbPath => {
    const { ops } = transformSnapshotToOps(dbPath, PEER);
    for (const op of ops) {
      expect(op.entity_id).toBe(stableDocumentId('observation', op.origin_device, op.origin_id));
    }
  }));
});
