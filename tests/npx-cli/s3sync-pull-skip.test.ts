import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const command = fileURLToPath(new URL('../../src/npx-cli/commands/s3sync.ts', import.meta.url));

function runS3SyncPull(body: object) {
  return spawnSync(process.execPath, ['-e', `
    import { runS3SyncCommand } from ${JSON.stringify(command)};
    globalThis.fetch = async () => Response.json(${JSON.stringify(body)}, { status: 200 });
    await runS3SyncCommand(['pull']);
  `], {
    env: { ...process.env, CLAUDE_MEM_WORKER_URL: 'http://127.0.0.1:1' },
    encoding: 'utf8',
    timeout: 5_000,
  });
}

it('skips the restart when every set was skipped (nothing to pull)', () => {
  const result = runS3SyncPull({
    success: true,
    outcome: {
      sets: [
        { set: 'db', status: 'skipped', reason: 'no remote LATEST (empty remote state)' },
        { set: 'chroma', status: 'skipped', reason: 'no remote LATEST (empty remote state)' },
      ],
      lastPullAt: 1764000000000,
    },
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Nothing to pull from S3.');
  expect(result.stdout).toContain('no remote LATEST (empty remote state)');
  expect(result.stdout).not.toContain('Restore staged from S3.');
  expect(result.stdout).not.toContain('Restarting the worker');
});
