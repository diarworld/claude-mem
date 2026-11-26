/**
 * `npx claude-mem s3sync [status|push|pull]`: snapshot sets to an own
 * S3-compatible bucket. A thin client over the worker's /api/s3sync/*
 * endpoints; the worker owns the snapshot engine, the S3 transport and the
 * restore staging.
 */

import { styleText } from 'node:util';
import { getWorkerBaseUrl, withWorkerAuth } from '../../shared/worker-utils.js';
import { runRestartCommand } from './runtime.js';
import { S3_SYNC_PUSH_PHASE_LABELS, isS3SyncPushPhase } from '../../services/s3sync/push-phase.js';

function printUsage(): void {
  console.error('Usage: npx claude-mem s3sync [status|push|pull]');
  console.error('  push  [--set db|chroma|all]   push snapshot sets now (default: all)');
  console.error('  pull  [--set db|chroma|all] [--generation <ts>] [--force]');
  console.error('                                restore from the bucket, then restart the worker');
}

// readOnly: the CLI never seeds settings.json (safe for POSTs too — it only
// governs settings.json seeding and token-cache freshness).
function workerBaseUrl(): string {
  return getWorkerBaseUrl({ readOnly: true });
}

/**
 * Fetch a worker /api/s3sync/* endpoint, exiting with the standard
 * "Worker is not running." message on ECONNREFUSED (backup.ts pattern).
 */
async function api(pathname: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${workerBaseUrl()}${pathname}`, withWorkerAuth(init, { readOnly: true }));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error instanceof Error ? (error as any).cause : undefined;
    if (cause?.code === 'ECONNREFUSED' || message.includes('ECONNREFUSED')) {
      console.error(styleText('red', 'Worker is not running.'));
      console.error(`Start it with: ${styleText('bold', 'npx claude-mem start')}`);
      process.exit(1);
    }
    console.error(styleText('red', `S3 Sync request failed: ${message}`));
    process.exit(1);
  }
}

async function readJsonOrExit(response: Response, label: string): Promise<Record<string, any>> {
  let data: unknown;
  try {
    data = await response.json();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(styleText('red', `${label} failed: invalid JSON response (${message})`));
    process.exit(1);
  }
  if (typeof data !== 'object' || data === null) {
    console.error(styleText('red', `${label} failed: unexpected response`));
    process.exit(1);
  }
  return data as Record<string, any>;
}

function fmtTime(ms: number | null | undefined): string {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toLocaleString() : 'never';
}

// single source of truth: S3_SYNC_PUSH_PHASE_LABELS (the module is Node-safe,
// so the CLI bundle imports it directly)
function phaseLabel(phase: string): string {
  return isS3SyncPushPhase(phase) ? S3_SYNC_PUSH_PHASE_LABELS[phase] : phase;
}

async function runStatus(): Promise<void> {
  const response = await api('/api/s3sync/status');
  if (!response.ok) {
    let problem = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (body && typeof body === 'object' && typeof body.error === 'string' && body.error) problem = body.error;
    } catch {
      // A non-JSON error body still reports the HTTP status below.
    }
    console.error(styleText('red', `Status failed: ${problem}`));
    process.exit(1);
  }
  const data = await readJsonOrExit(response, 'S3 Sync status');
  if (data.configured === false) {
    console.log(styleText('yellow', 'S3 Sync is not enabled.'));
    console.log(`Enable it by setting ${styleText('bold', 'CLAUDE_MEM_S3_SYNC_ENABLED')} to "true" in ~/.claude-mem/settings.json,`);
    console.log(`adding ${styleText('bold', 'S3_SYNC_ACCESS_KEY_ID')} and ${styleText('bold', 'S3_SYNC_SECRET_ACCESS_KEY')} to ~/.claude-mem/.env, and restarting the worker.`);
    return;
  }
  console.log(styleText('bold', '\nclaude-mem s3sync status\n'));
  console.log(`  Bucket:   ${data.bucket}  (endpoint ${data.endpoint})`);
  console.log(`  Device:   ${data.device}`);
  for (const set of ['db', 'chroma'] as const) {
    const s = data.sets?.[set] ?? {};
    console.log(styleText('bold', `\n  ${set} set`));
    console.log(`    Phase:          ${phaseLabel(String(s.phase ?? 'idle'))}`);
    console.log(`    Last push:      ${fmtTime(s.lastPushAt)}`);
    console.log(`    Last pull:      ${fmtTime(s.lastPullAt)}`);
    console.log(`    Generation:     ${s.lastGeneration ?? '—'}`);
    console.log(`    Next run:       ${fmtTime(s.nextRunAt)}`);
    if (s.lastError) console.log(`    Last error:     ${styleText('red', String(s.lastError))}`);
  }
  console.log(`\nPush now with: ${styleText('bold', 'npx claude-mem s3sync push')}`);
}

function parseArgs(argv: string[]): { set: string; generation?: string; force: boolean } {
  const args = { set: 'all', force: false } as { set: string; generation?: string; force: boolean };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--set') {
      if (argv[i + 1] === undefined) {
        console.error(styleText('red', 'Missing value for --set'));
        printUsage();
        process.exit(1);
      }
      args.set = argv[++i];
    } else if (argv[i] === '--generation') {
      if (argv[i + 1] === undefined) {
        console.error(styleText('red', 'Missing value for --generation'));
        printUsage();
        process.exit(1);
      }
      args.generation = argv[++i];
    } else if (argv[i] === '--force') args.force = true;
  }
  return args;
}

async function runPush(argv: string[]): Promise<void> {
  const { set } = parseArgs(argv);
  const response = await api('/api/s3sync/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ set }),
  });
  const data = await readJsonOrExit(response, 'S3 Sync push');
  if (!response.ok) {
    console.error(styleText('red', `Push failed: ${data.error ?? `HTTP ${response.status}`}`));
    process.exit(1);
  }
  const outcome = data.outcome as { set: string; generation: string; uploaded: number; bytes: number; pruned: string[] };
  const setLabel = outcome.set === 'all' ? 'db and chroma sets' : `${outcome.set} set`;
  console.log(styleText('green', `Pushed the ${setLabel}.`));
  console.log(`  Generation: ${outcome.generation}`);
  console.log(`  Uploaded:   ${outcome.uploaded} object(s)`);
  if (outcome.pruned?.length) console.log(`  Pruned:     ${outcome.pruned.join(', ')}`);
}

async function runPull(argv: string[]): Promise<void> {
  const { set, generation, force } = parseArgs(argv);
  const response = await api('/api/s3sync/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ set, generation, force }),
  });
  const data = await readJsonOrExit(response, 'S3 Sync pull');
  if (!response.ok) {
    console.error(styleText('red', `Pull failed: ${data.error ?? `HTTP ${response.status}`}`));
    process.exit(1);
  }
  // Skip-aware: a successful pull with every set SKIPPED (empty bucket / no
  // remote LATEST) staged nothing, so there is nothing to apply at boot and
  // a restart would be pure downtime. House convention: backup list's
  // "No snapshots yet." + hint. A mixed result still restarts — the staged
  // set applies at boot.
  const sets = Array.isArray(data.outcome?.sets)
    ? (data.outcome.sets as Array<{ set: string; status: string; reason?: string }>)
    : [];
  if (sets.length > 0 && sets.every(s => s.status === 'skipped')) {
    console.log('Nothing to pull from S3.');
    for (const s of sets) {
      console.log(`  ${s.set}: ${s.reason ?? 'nothing to pull'}`);
    }
    return;
  }
  console.log(styleText('green', 'Restore staged from S3.'));
  console.log('  Restarting the worker to apply it; check the result with:');
  console.log(`  ${styleText('bold', 'npx claude-mem s3sync status')}`);
  runRestartCommand();
}

export async function runS3SyncCommand(argv: string[] = []): Promise<void> {
  const subCommand = argv[0]?.toLowerCase() ?? 'status';
  switch (subCommand) {
    case 'status': await runStatus(); break;
    case 'push': await runPush(argv.slice(1)); break;
    case 'pull': await runPull(argv.slice(1)); break;
    case '--help': case '-h': printUsage(); break;
    default:
      console.error(styleText('red', `Unknown s3sync subcommand: ${subCommand}`));
      printUsage();
      process.exit(1);
  }
}
