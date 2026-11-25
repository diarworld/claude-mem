/**
 * Push-pipeline phase of one S3 Sync set (docs/architecture/state-machines.md):
 * the one definition. S3SyncManager is the single writer; the CLI and any UI
 * import the list and the wording table from here, never re-typing either.
 *
 *   idle ──run──▶ snapshotting ──▶ uploading ──▶ ok
 *                    │               │
 *                    └──▶ error ◀────┘
 * A failure at any step lands in error; the next run starts again at
 * snapshotting. ok returns to idle only when the next run begins.
 */
export const S3_SYNC_PUSH_PHASES = ['idle', 'snapshotting', 'uploading', 'ok', 'error'] as const;
export type S3SyncPushPhase = (typeof S3_SYNC_PUSH_PHASES)[number];

export const S3_SYNC_PUSH_PHASE_LABELS: Record<S3SyncPushPhase, string> = {
  idle: 'Not started yet',
  snapshotting: 'Creating local snapshot',
  uploading: 'Uploading to S3',
  ok: 'Up to date',
  error: 'Last push failed',
};

export function isS3SyncPushPhase(value: unknown): value is S3SyncPushPhase {
  return typeof value === 'string' && (S3_SYNC_PUSH_PHASES as readonly string[]).includes(value);
}
