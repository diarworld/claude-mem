import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const command = fileURLToPath(new URL('../../src/npx-cli/commands/s3sync.ts', import.meta.url));

function runS3SyncStatus(body: object) {
  return spawnSync(process.execPath, ['-e', `
    import { runS3SyncCommand } from ${JSON.stringify(command)};
    globalThis.fetch = async () => Response.json(${JSON.stringify(body)}, { status: 200 });
    await runS3SyncCommand(['status']);
  `], {
    env: { ...process.env, CLAUDE_MEM_WORKER_URL: 'http://127.0.0.1:1' },
    encoding: 'utf8',
    timeout: 5_000,
  });
}

// The error message is printed through styleText, which may or may not emit
// ANSI codes depending on the captured stream's color depth — strip them so
// the assertions read the words, not the styling.
const plain = (text: string | undefined) => (text ?? '').replace(/\x1b\[[0-9;]*m/g, '');

/** A worker /api/s3sync/status payload (S3SyncRoutes answers manager.status() verbatim). */
function statusPayload(merge?: object) {
  return {
    configured: true,
    bucket: 'claude-mem-test',
    endpoint: 'https://s3.test',
    device: 'test-device',
    sets: {
      db: { phase: 'idle', lastPushAt: null, lastPullAt: null, lastGeneration: null, nextRunAt: null, lastError: null },
      chroma: { phase: 'idle', lastPushAt: null, lastPullAt: null, lastGeneration: null, nextRunAt: null, lastError: null },
    },
    ...(merge === undefined ? {} : { merge }),
  };
}

const T_OK = Date.parse('2025-11-26T10:00:00.000Z');
const T_ERR = Date.parse('2025-11-26T11:30:00.000Z');
const T_SKIP = Date.parse('2025-11-26T09:15:00.000Z');
// The time slot itself cannot be pinned exactly: this process and the spawned
// child each render toLocaleString() with their own Intl locale/timezone
// (observed: parent UTC, child system-local on Windows), and pinning either
// side's rendering would make the test machine-dependent. Everything around
// the slot is exact; the slot asserts "a rendered timestamp is here".

it('renders one line per peer, sorted by name, with times and the merged generation', () => {
  const result = runS3SyncStatus(statusPayload({
    peers: ['device-b', 'device-a'],
    mergedGenerations: { 'device-a': '2025-11-26T10-00-00-000Z' },
    mergeState: {
      'device-b': { state: 'error', applied: 0, lastMergeAt: T_ERR, lastError: 'downloaded file does not match the manifest: claude-mem.db.gz' },
      'device-a': { state: 'ok', applied: 3, lastMergeAt: T_OK, lastError: null },
    },
  }));
  const out = plain(result.stdout);
  expect(result.status).toBe(0);
  expect(out).toContain('\n  Merge');
  // mergeState arrives in insertion order; the block sorts by peer name.
  expect(out.indexOf('device-a: ok')).toBeLessThan(out.indexOf('device-b: error'));
  expect(out).toMatch(/device-a: ok — 3 applied, last merge .+, generation 2025-11-26T10-00-00-000Z/);
  expect(out).toMatch(/device-b: error — downloaded file does not match the manifest: claude-mem\.db\.gz, last attempt .+/);
  // fmtTime's null contract, deterministic: a missing timestamp renders 'never'.
  expect(out).toContain('Last push:      never');
});

it('renders a converged steady state: skipped with a watermark, called an activity, not a merge', () => {
  const result = runS3SyncStatus(statusPayload({
    peers: ['laptop'],
    mergedGenerations: { laptop: '2025-11-26T09-15-00-000Z' },
    mergeState: { laptop: { state: 'skipped', applied: 0, lastMergeAt: T_SKIP, lastError: null } },
  }));
  expect(result.status).toBe(0);
  expect(plain(result.stdout)).toMatch(/laptop: skipped — last activity .+, generation 2025-11-26T09-15-00-000Z/);
});

it('says peers were never discovered rather than inventing an empty roster', () => {
  // The Cloud-Sync exclusivity refusal and a worker that has not run its
  // first tick both look exactly like this.
  const result = runS3SyncStatus(statusPayload({ peers: null, mergedGenerations: {}, mergeState: {} }));
  const out = plain(result.stdout);
  expect(result.status).toBe(0);
  expect(out).toContain('Peers: not discovered yet');
  expect(out).not.toContain('No merges recorded');
  expect(out).not.toContain(': ok —');
});

it('distinguishes an empty roster: discovered, and no other device shares the bucket', () => {
  const result = runS3SyncStatus(statusPayload({ peers: [], mergedGenerations: {}, mergeState: {} }));
  expect(result.status).toBe(0);
  expect(plain(result.stdout)).toContain('Peers: none');
});

it('says no merges were recorded when discovery found peers but no outcome was recorded', () => {
  const result = runS3SyncStatus(statusPayload({
    peers: ['device-a', 'device-b'],
    mergedGenerations: {},
    mergeState: {},
  }));
  const out = plain(result.stdout);
  expect(result.status).toBe(0);
  expect(out).toContain('No merges recorded');
  expect(out).not.toContain('device-a:');
});

it('renders the merge block for persisted outcomes even before this boot discovered peers', () => {
  // lastMergePeers is a runtime field (null until discovery runs) while
  // mergeState is persisted — the hybrid is the normal first seconds of a
  // restarted worker, and both facts render honestly.
  const result = runS3SyncStatus(statusPayload({
    peers: null,
    mergedGenerations: { 'device-a': '2025-11-26T10-00-00-000Z' },
    mergeState: { 'device-a': { state: 'ok', applied: 1, lastMergeAt: T_OK, lastError: null } },
  }));
  const out = plain(result.stdout);
  expect(result.status).toBe(0);
  expect(out).toContain('Peers: not discovered yet');
  expect(out).toMatch(/device-a: ok — 1 applied, last merge .+, generation 2025-11-26T10-00-00-000Z/);
});

it('adds nothing when the payload has no merge dimension (older worker or disabled)', () => {
  const withoutMerge = runS3SyncStatus(statusPayload());
  expect(withoutMerge.status).toBe(0);
  expect(plain(withoutMerge.stdout)).not.toContain('\n  Merge');

  const disabled = runS3SyncStatus({ configured: false });
  expect(disabled.status).toBe(0);
  const out = plain(disabled.stdout);
  expect(out).toContain('S3 Sync is not enabled.');
  expect(out).not.toContain('\n  Merge');
});
