import express, { Request, Response } from 'express';
import { logger } from '../../../../utils/logger.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import type { DatabaseManager } from '../../DatabaseManager.js';
import { isForeignLoopbackBrowserWrite } from './SettingsRoutes.js';
import { S3_SYNC_SETS } from '../../../../services/s3sync/manifest.js';
import type { S3SyncPushOutcome } from '../../../../services/s3sync/S3SyncManager.js';

/**
 * S3 Sync endpoints.
 *
 * Registered unconditionally (BackupRoutes pattern): a disabled install
 * (CLAUDE_MEM_S3_SYNC_ENABLED !== 'true', so getS3SyncManager() is null)
 * still answers status with `{configured: false}`.
 *
 * GET  /api/s3sync/status - manager status (or {configured: false})
 * POST /api/s3sync/push   - {set?: 'db'|'chroma'|'all'} push now (409 if busy)
 * POST /api/s3sync/pull   - {set?, generation?, force?} download + verify + stage
 *
 * There is no restore endpoint: pull stages, and the next worker boot applies
 * the database (restore-swap) and the chroma dir (chroma-restore).
 */
export class S3SyncRoutes extends BaseRouteHandler {
  /** Pull single-flight: concurrent pulls of the same set would race on the
   * shared incoming dir, and the manager intentionally has no pull guard
   * (push has one). Set synchronously before the first await, so two
   * requests can never both pass the check. */
  private pullInFlight: Promise<unknown> | null = null;

  constructor(
    private dbManager: DatabaseManager,
  ) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/s3sync/status', this.handleGetStatus.bind(this));
    app.post('/api/s3sync/push', this.handlePush.bind(this));
    app.post('/api/s3sync/pull', this.handlePull.bind(this));
  }

  private parseSet(body: unknown): 'db' | 'chroma' | 'all' {
    const set = (body as { set?: string } | undefined)?.set ?? 'all';
    if (set === 'all' || (S3_SYNC_SETS as readonly string[]).includes(set)) return set as 'db' | 'chroma' | 'all';
    throw new Error(`invalid set: ${set}`);
  }

  private handleGetStatus = this.wrapHandler(async (_req: Request, res: Response): Promise<void> => {
    const manager = this.dbManager.getS3SyncManager();
    if (!manager) {
      logger.debug('S3SYNC', 'Status requested but S3 Sync is not enabled');
      res.json({ configured: false });
      return;
    }
    res.json(manager.status());
  });

  private handlePush = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    // A push uploads the local database and chroma snapshots: refuse it from
    // other localhost pages, as settings writes are. Origin-less clients (the
    // CLI, curl) keep the loopback-trust model.
    if (isForeignLoopbackBrowserWrite(req)) {
      res.status(403).json({ error: 'S3 Sync pushes from a different localhost origin are not allowed' });
      return;
    }
    const manager = this.dbManager.getS3SyncManager();
    if (!manager) {
      res.status(400).json({ error: 'S3 Sync is not enabled (set CLAUDE_MEM_S3_SYNC_ENABLED to "true", add the bucket keys to .env, and restart the worker)' });
      return;
    }
    let set: 'db' | 'chroma' | 'all';
    try {
      set = this.parseSet(req.body);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }
    let outcome: S3SyncPushOutcome | null;
    try {
      outcome = await manager.runNow(set);
    } catch (error) {
      // runNow throws for a stopped manager or a set gated by
      // CLAUDE_MEM_S3_SYNC_INCLUDE_CHROMA=false — "not possible", not a
      // server fault, so answer 400 rather than letting wrapHandler 500 it.
      logger.warn('S3SYNC', 'Push failed', { set }, error instanceof Error ? error : new Error(String(error)));
      res.status(400).json({ error: (error as Error).message });
      return;
    }
    if (outcome === null) {
      res.status(409).json({ error: 'An S3 Sync push is already running' });
      return;
    }
    res.json({ success: true, outcome });
  });

  private handlePull = this.wrapHandler(async (req: Request, res: Response): Promise<void> => {
    if (isForeignLoopbackBrowserWrite(req)) {
      res.status(403).json({ error: 'S3 Sync pulls from a different localhost origin are not allowed' });
      return;
    }
    const manager = this.dbManager.getS3SyncManager();
    if (!manager) {
      res.status(400).json({ error: 'S3 Sync is not enabled (set CLAUDE_MEM_S3_SYNC_ENABLED to "true", add the bucket keys to .env, and restart the worker)' });
      return;
    }
    const body = (req.body ?? {}) as { set?: string; generation?: string; force?: boolean };
    let set: 'db' | 'chroma' | 'all';
    try {
      set = this.parseSet(body);
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
      return;
    }
    if (this.pullInFlight) {
      res.status(409).json({ error: 'An S3 Sync pull is already running' });
      return;
    }
    const pull = manager.pull({
      set,
      generation: typeof body.generation === 'string' && body.generation ? body.generation : undefined,
      force: body.force === true,
    });
    this.pullInFlight = pull;
    try {
      const outcome = await pull;
      res.json({ success: true, outcome, note: 'Restart the worker to apply the staged restore (claude-mem s3sync pull restarts it for you).' });
    } catch (error) {
      logger.warn('S3SYNC', 'Pull failed', { set: body.set }, error instanceof Error ? error : new Error(String(error)));
      res.status(400).json({ error: (error as Error).message });
    } finally {
      if (this.pullInFlight === pull) this.pullInFlight = null;
    }
  });
}
