import { describe, expect, test, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3SyncManager } from '../../src/services/s3sync/S3SyncManager.js';
import type { ChromaSyncLike } from '../../src/services/sync/SyncApply.js';
import type { S3Transport } from '../../src/services/s3sync/s3-transport.js';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';

const NOW = 1764000000000;

class FakeS3 implements S3Transport {
  objects = new Map<string, Buffer>();
  order: string[] = [];
  /** Artificial download latency so a test can observe an in-flight merge. */
  downloadDelayMs = 0;
  async upload(localPath: string, key: string): Promise<void> {
    this.order.push(`up:${key}`);
    this.objects.set(key, readFileSync(localPath));
  }
  async download(key: string, localPath: string): Promise<void> {
    this.order.push(`down:${key}`);
    if (this.downloadDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.downloadDelayMs));
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

/** ChromaSyncLike stub that records which local row ids the forwarder received. */
class RecordingChroma implements ChromaSyncLike {
  observationIds: number[] = [];
  summaryIds: number[] = [];
  promptIds: number[] = [];
  async syncObservation(observationId: number): Promise<void> {
    this.observationIds.push(observationId);
  }
  async syncSummary(summaryId: number): Promise<void> {
    this.summaryIds.push(summaryId);
  }
  async syncUserPrompt(promptId: number): Promise<void> {
    this.promptIds.push(promptId);
  }
}

// --- device fixtures ------------------------------------------------------
// Each device gets a temp dir with a PRODUCTION-schema database (full
// SessionStore migration chain: origin columns, the (origin_device_id,
// origin_local_id) unique index, sync_state, quarantine, FTS triggers), so
// A's pushed snapshot carries canonically-valid rows and B's SyncApply writes
// against the real schema.

interface DeviceFixture {
  dir: string;
  db: Database;
}

const openDbs: Database[] = [];
const cleanupDirs: string[] = [];

function makeDevice(label: string): DeviceFixture {
  const dir = mkdtempSync(join(tmpdir(), `s3sync-merge-${label}-`));
  cleanupDirs.push(dir);
  const db = new Database(join(dir, 'claude-mem.db'));
  openDbs.push(db);
  new SessionStore(db); // production migrations, in place
  writeFileSync(join(dir, 'settings.json'), '{}', 'utf-8');
  return { dir, db };
}

function insertSession(db: Database, memorySessionId: string, contentSessionId: string): void {
  // FKs are ON (SessionStore pragmas): sessions are inserted before the rows that reference them.
  db.prepare(`
    INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
    VALUES (?, ?, 'demo', 'claude', '2026-11-26T03:00:00.000Z', ?, 'completed')
  `).run(contentSessionId, memorySessionId, NOW);
}

function insertObservation(db: Database, memorySessionId: string, text: string, type = 'bugfix'): void {
  db.prepare(`
    INSERT INTO observations
      (memory_session_id, project, text, type, title, facts, concepts, files_read, files_modified,
       prompt_number, discovery_tokens, created_at, created_at_epoch, content_hash)
    VALUES (?, 'demo', ?, ?, ?, '["f1.txt"]', '["perf"]', '["src/a.ts"]', '["src/b.ts"]',
            3, 120, '2026-11-26T03:00:00.000Z', ?, ?)
  `).run(memorySessionId, text, type, `title for ${text}`, NOW - 60_000, `hash-${text}`);
}

function observationRows(db: Database): Array<{ id: number; text: string; origin_device_id: string | null; memory_session_id: string; synced_at: number | null }> {
  return db.prepare('SELECT id, text, origin_device_id, memory_session_id, synced_at FROM observations ORDER BY id').all() as never;
}

function clearWatermark(dir: string, peerRoot: string): void {
  // Simulate the documented lost-watermark recovery path by editing the
  // persisted state the way an operator (or a corrupted write) would.
  const statePath = join(dir, 'state', 's3sync', 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf-8')) as { mergedGenerations?: Record<string, string> };
  delete state.mergedGenerations?.[peerRoot];
  writeFileSync(statePath, JSON.stringify(state), 'utf-8');
}

function makeManager(
  dir: string,
  transport: S3Transport,
  opts: {
    device: string;
    db?: Database;
    chromaSync?: ChromaSyncLike;
    settingsOverrides?: Record<string, string>;
    /** Mutable test clock (a second push from one device needs a later stamp). */
    now?: () => number;
  },
): S3SyncManager {
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
      CLAUDE_MEM_S3_SYNC_DEVICE: opts.device,
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: '',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: '',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: '',
      // Most tests merge on demand; scheduling tests override this.
      CLAUDE_MEM_S3_SYNC_MERGE_INTERVAL_MINUTES: '0',
      ...opts.settingsOverrides,
    },
    {
      transport,
      dataDir: dir,
      dbPath: join(dir, 'claude-mem.db'),
      reviewsDbPath: join(dir, 'missing.db'),
      chromaDir: join(dir, 'chroma'),
      backupsDir: join(dir, 'backups', 'auto'),
      settingsPath: join(dir, 'settings.json'),
      envPath: join(dir, '.env'),
      stateDir: join(dir, 'state'),
      now: opts.now ?? (() => NOW),
      initialDelayMs: 3_600_000,
      jitterFraction: 0,
      env: { S3_SYNC_ACCESS_KEY_ID: 'k', S3_SYNC_SECRET_ACCESS_KEY: 's' },
      db: opts.db,
      chromaSync: opts.chromaSync,
    },
  );
}

describe('s3 sync merge tick', () => {
  afterEach(() => {
    for (const db of openDbs.splice(0)) {
      try { db.close(); } catch { /* already closed */ }
    }
    // bun:sqlite readonly handles (the transformer's) finalize on GC on Windows.
    Bun.gc(true);
    for (const dir of cleanupDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      } catch {
        // A cleanup hiccup under full-suite GC pressure (an OS-temp dir still
        // held by a lazily-finalized readonly handle) is not signal — the
        // assertions above already ran, and the OS reaps its temp dir.
      }
    }
  });

  test('convergence: A pushes 2 observations, B merges them as replica rows attributed to A', async () => {
    const s3 = new FakeS3();
    const a = makeDevice('a');
    insertSession(a.db, 'mem-a-1', 'content-a-1');
    insertObservation(a.db, 'mem-a-1', 'alpha');
    insertObservation(a.db, 'mem-a-1', 'beta', 'decision');
    const managerA = makeManager(a.dir, s3, { device: 'device-a' });

    const b = makeDevice('b');
    const managerB = makeManager(b.dir, s3, { device: 'device-b', db: b.db });

    const pushed = await managerA.runNow('db');
    expect(pushed).not.toBeNull();
    const aIdentity = managerA.status().syncIdentity;

    const outcome = await managerB.mergeNow();
    expect(outcome).toEqual({ peers: [{ peer: 'device-a', outcome: 'merged', applied: 2 }] });

    const rows = observationRows(b.db);
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.origin_device_id)).toEqual([aIdentity, aIdentity]);
    expect(rows.map(row => row.text).sort()).toEqual(['alpha', 'beta']);
    expect(rows.every(row => row.memory_session_id === 'mem-a-1')).toBe(true);
    // ECHO GUARD pre-stamp: applied rows can never be selected for re-push.
    expect(rows.every(row => row.synced_at !== null)).toBe(true);

    const merge = managerB.status().merge;
    expect(merge.peers).toEqual(['device-a']);
    expect(merge.mergeState['device-a']).toMatchObject({ state: 'ok', applied: 2 });
    expect(merge.mergedGenerations['device-a']).toBe(pushed!.generation);
  });

  test('both directions converge: B pushes back, A merges B and skips its own echoes', async () => {
    const s3 = new FakeS3();
    const a = makeDevice('a');
    insertSession(a.db, 'mem-a-1', 'content-a-1');
    insertObservation(a.db, 'mem-a-1', 'alpha');
    insertObservation(a.db, 'mem-a-1', 'beta');
    const managerA = makeManager(a.dir, s3, { device: 'device-a', db: a.db });

    const b = makeDevice('b');
    insertSession(b.db, 'mem-b-1', 'content-b-1');
    insertObservation(b.db, 'mem-b-1', 'gamma');
    const managerB = makeManager(b.dir, s3, { device: 'device-b', db: b.db });

    await managerA.runNow('db');
    expect(await managerB.mergeNow()).toEqual({ peers: [{ peer: 'device-a', outcome: 'merged', applied: 2 }] });
    const bIdentity = managerB.status().syncIdentity;

    // B pushes its db, which now holds its own row AND A's two replica rows.
    await managerB.runNow('db');
    const outcome = await managerA.mergeNow();
    // A applies only B's own row; A's own rows flow back from B's snapshot as
    // replica ops carrying A's identity — skippedOwn, not re-applied.
    expect(outcome).toEqual({ peers: [{ peer: 'device-b', outcome: 'merged', applied: 1 }] });
    const aRows = a.db.prepare('SELECT text, origin_device_id FROM observations ORDER BY id').all() as Array<{ text: string; origin_device_id: string | null }>;
    expect(aRows).toHaveLength(3);
    expect(aRows[2]).toEqual({ text: 'gamma', origin_device_id: bIdentity });
    expect(aRows.slice(0, 2).every(row => row.origin_device_id === null)).toBe(true); // own rows untouched

    // The loop is closed: B's LATEST is at A's watermark → nothing new.
    expect(await managerA.mergeNow()).toEqual({ peers: [{ peer: 'device-b', outcome: 'skipped' }] });
  });

  test('idempotence: a cleared watermark re-merges the unchanged snapshot with applied 0 and no duplicates', async () => {
    const s3 = new FakeS3();
    const a = makeDevice('a');
    insertSession(a.db, 'mem-a-1', 'content-a-1');
    insertObservation(a.db, 'mem-a-1', 'alpha');
    const managerA = makeManager(a.dir, s3, { device: 'device-a' });
    const b = makeDevice('b');
    const managerB = makeManager(b.dir, s3, { device: 'device-b', db: b.db });
    await managerA.runNow('db');
    await managerB.mergeNow();
    const rowsBefore = observationRows(b.db);
    expect(rowsBefore).toHaveLength(1);

    clearWatermark(b.dir, 'device-a'); // the documented lost-watermark recovery path
    expect(await managerB.mergeNow()).toEqual({ peers: [{ peer: 'device-a', outcome: 'merged', applied: 0 }] });
    expect(observationRows(b.db)).toEqual(rowsBefore); // no duplicate rows
  });

  test('resurrection: an identical replay never resurrects (exactly-once ledger); a peer revision advance does', async () => {
    const s3 = new FakeS3();
    const a = makeDevice('a');
    insertSession(a.db, 'mem-a-1', 'content-a-1');
    insertObservation(a.db, 'mem-a-1', 'alpha');
    // A mutable clock for A: a second push must land on a LATER generation
    // stamp than the first, or B's watermark skip refuses it.
    let clockA = NOW;
    const managerA = makeManager(a.dir, s3, { device: 'device-a', now: () => clockA });
    const b = makeDevice('b');
    const managerB = makeManager(b.dir, s3, { device: 'device-b', db: b.db });
    await managerA.runNow('db');
    await managerB.mergeNow();
    const aIdentity = managerA.status().syncIdentity;

    // The user deletes the replica row locally on B (a legitimate local
    // delete; replica rows are never propagated by the additive v1 lane).
    b.db.prepare('DELETE FROM observations WHERE origin_device_id = ?').run(aIdentity);
    expect(observationRows(b.db)).toHaveLength(0);

    clearWatermark(b.dir, 'device-a'); // even the lost-watermark recovery path
    // DEVIATION FROM PLAN (Task 4 test list expected the deleted id to
    // reappear here): SyncApply's sync_entity_heads ledger pins exactly-once —
    // the head written at first apply survives the row's deletion, so the
    // byte-identical replayed op (same entity_rev, same operation hash) is
    // skippedStale, NOT re-inserted. This is strictly safer than the plan's
    // caveat: watermark loss cannot resurrect deleted replicas. The transform
    // cannot mint fresh revs either — its purity contract requires identical
    // op lists for identical snapshots (plan Task 2).
    expect(await managerB.mergeNow()).toEqual({ peers: [{ peer: 'device-a', outcome: 'merged', applied: 0 }] });
    expect(observationRows(b.db)).toHaveLength(0);

    // The additive-v1 caveat is real, but gated on the PEER's revision: when
    // A's row revision advances (the way conflict recovery advances a rev),
    // the new op beats the stale head and the row is re-created on B.
    clockA = NOW + 60_000;
    a.db.prepare(`UPDATE observations SET sync_rev = '2' WHERE memory_session_id = 'mem-a-1'`).run();
    await managerA.runNow('db'); // new generation carrying sync_rev '2'
    expect(await managerB.mergeNow()).toEqual({ peers: [{ peer: 'device-a', outcome: 'merged', applied: 1 }] });
    const rows = observationRows(b.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ origin_device_id: aIdentity, text: 'alpha' });
  });

  test('error isolation: a tampered peer snapshot errors that peer alone; a healthy peer still merges', async () => {
    const s3 = new FakeS3();
    const a = makeDevice('a');
    insertSession(a.db, 'mem-a-1', 'content-a-1');
    insertObservation(a.db, 'mem-a-1', 'alpha');
    const managerA = makeManager(a.dir, s3, { device: 'device-a' });
    const pushedA = await managerA.runNow('db');

    const c = makeDevice('c');
    insertSession(c.db, 'mem-c-1', 'content-c-1');
    insertObservation(c.db, 'mem-c-1', 'gamma');
    const managerC = makeManager(c.dir, s3, { device: 'device-c' });
    await managerC.runNow('db');

    // Tamper A's uploaded data object: its bytes no longer match the sha256
    // A's manifest declared, so B's verification must reject exactly A.
    const tamperedKey = `claude-mem-sync/device-a/db/gen/${pushedA!.generation}/claude-mem.db.gz`;
    s3.objects.set(tamperedKey, Buffer.concat([s3.objects.get(tamperedKey)!, Buffer.from('tampered')]));

    const b = makeDevice('b');
    const managerB = makeManager(b.dir, s3, { device: 'device-b', db: b.db });
    const outcome = await managerB.mergeNow();
    const byPeer = new Map(outcome.peers.map(entry => [entry.peer, entry]));
    expect(byPeer.get('device-a')).toMatchObject({ outcome: 'error' });
    expect(byPeer.get('device-c')).toMatchObject({ outcome: 'merged', applied: 1 });

    const merge = managerB.status().merge;
    expect(merge.mergeState['device-a'].state).toBe('error');
    expect(merge.mergeState['device-a'].lastError).toContain('manifest');
    expect(merge.mergedGenerations['device-a']).toBeUndefined(); // watermark NOT moved
    expect(merge.mergeState['device-c']).toMatchObject({ state: 'ok', applied: 1 });
  });

  test('refusal: Cloud Sync configured → the merge refuses before any download', async () => {
    const s3 = new FakeS3();
    const a = makeDevice('a');
    insertSession(a.db, 'mem-a-1', 'content-a-1');
    insertObservation(a.db, 'mem-a-1', 'alpha');
    const managerA = makeManager(a.dir, s3, { device: 'device-a' });
    await managerA.runNow('db'); // the bucket holds a mergeable peer

    const b = makeDevice('b');
    const managerB = makeManager(b.dir, s3, {
      device: 'device-b',
      db: b.db,
      settingsOverrides: {
        CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'token',
        CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user',
        CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test',
      },
    });
    s3.order = []; // A's push noise out of the way

    const outcome = await managerB.mergeNow();
    expect(outcome.refused).toContain('Cloud Sync');
    expect(outcome.peers).toEqual([]);
    expect(s3.order.filter(entry => entry.startsWith('down:'))).toEqual([]); // nothing downloaded
    expect(managerB.status().merge.mergeState).toEqual({}); // nothing recorded
    expect(managerB.status().merge.mergedGenerations).toEqual({});
  });

  test('single-flight: a concurrent merge returns null while one is in flight, and the batch runs once', async () => {
    const s3 = new FakeS3();
    const a = makeDevice('a');
    insertSession(a.db, 'mem-a-1', 'content-a-1');
    insertObservation(a.db, 'mem-a-1', 'alpha');
    insertObservation(a.db, 'mem-a-1', 'beta');
    const managerA = makeManager(a.dir, s3, { device: 'device-a' });
    await managerA.runNow('db');

    const b = makeDevice('b');
    const managerB = makeManager(b.dir, s3, { device: 'device-b', db: b.db });
    s3.downloadDelayMs = 30;

    const inFlight = managerB.mergeNow();
    await new Promise(resolve => setTimeout(resolve, 5)); // first merge enters its downloads
    expect(await managerB.mergeNow()).toBeNull(); // push's pattern: busy → null
    expect(await inFlight).toEqual({ peers: [{ peer: 'device-a', outcome: 'merged', applied: 2 }] });
    expect(observationRows(b.db)).toHaveLength(2); // ran exactly once
  });

  test('MERGE_INTERVAL_MINUTES=0 arms no merge timer; the default arms one', async () => {
    const s3 = new FakeS3();
    const disabledDir = makeDevice('d0');
    const disabled = makeManager(disabledDir.dir, s3, {
      device: 'device-b',
      settingsOverrides: { CLAUDE_MEM_S3_SYNC_MERGE_INTERVAL_MINUTES: '0' },
    });
    disabled.start();
    expect((disabled as unknown as { mergeTimer: unknown }).mergeTimer ?? null).toBeNull();

    const defaultDir = makeDevice('d1');
    // Explicitly unset the key (spread overwrites the fixture's '0' with
    // undefined) so this manager exercises the production default (60 min).
    const def = makeManager(defaultDir.dir, s3, {
      device: 'device-c',
      settingsOverrides: { CLAUDE_MEM_S3_SYNC_MERGE_INTERVAL_MINUTES: undefined as unknown as string },
    });
    def.start();
    expect((def as unknown as { mergeTimer: unknown }).mergeTimer).toBeTruthy();
    await disabled.stop();
    await def.stop();
  });

  test('stop() during an in-flight merge settles safely without unhandled rejections', async () => {
    const s3 = new FakeS3();
    const a = makeDevice('a');
    insertSession(a.db, 'mem-a-1', 'content-a-1');
    insertObservation(a.db, 'mem-a-1', 'alpha');
    const managerA = makeManager(a.dir, s3, { device: 'device-a' });
    await managerA.runNow('db');

    const b = makeDevice('b');
    const managerB = makeManager(b.dir, s3, { device: 'device-b', db: b.db });
    s3.downloadDelayMs = 50;
    const inFlight = managerB.mergeNow();
    await new Promise(resolve => setTimeout(resolve, 5));

    // Direct awaits (not expect().resolves): bun's .resolves wrapper hung on
    // this flow during development — the direct form asserts the same facts.
    await managerB.stop(); // settles the in-flight merge
    const outcome = await inFlight; // no unhandled rejection; outcome arrived
    expect(outcome).toBeTruthy();
  }, 15000);

  test('the chromaSync forwarder receives the inserted local ids', async () => {
    const s3 = new FakeS3();
    const a = makeDevice('a');
    insertSession(a.db, 'mem-a-1', 'content-a-1');
    insertObservation(a.db, 'mem-a-1', 'alpha');
    insertObservation(a.db, 'mem-a-1', 'beta');
    const managerA = makeManager(a.dir, s3, { device: 'device-a' });
    await managerA.runNow('db');

    const b = makeDevice('b');
    const chroma = new RecordingChroma();
    const managerB = makeManager(b.dir, s3, { device: 'device-b', db: b.db, chromaSync: chroma });
    await managerB.mergeNow();

    expect(chroma.observationIds).toHaveLength(2);
    expect(chroma.observationIds).toEqual(
      (b.db.prepare('SELECT id FROM observations ORDER BY id').all() as Array<{ id: number }>).map(row => row.id),
    );
  });
});

