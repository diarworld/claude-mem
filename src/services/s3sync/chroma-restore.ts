/**
 * Boot-time chroma directory restore, staged by an S3 Sync pull. Runs in
 * worker-service.ts right after applyPendingRestore, before ChromaMcpManager
 * is constructed and before anything opens the vector store. Apply-once like
 * the database restore: the marker is cleared as soon as it is read. The
 * previous chroma dir is renamed aside as chroma-pre-restore-<ts> and kept.
 */
import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger.js';
import { renameWithWindowsRetry } from '../../shared/atomic-json.js';
import { paths } from '../../shared/paths.js';
import { clearPendingChromaRestore, readPendingChromaRestore } from '../backup/snapshot-files.js';

export interface ChromaRestoreResult {
  ok: boolean;
  error: string | null;
  preRestoreDir: string | null;
}

export function applyPendingChromaRestore(chromaDir: string, markerPath = paths.pendingChromaRestore()): ChromaRestoreResult | null {
  let pending;
  try {
    pending = readPendingChromaRestore(markerPath);
  } catch (error) {
    logger.error('S3SYNC', 'Chroma restore marker is unreadable; leaving chroma untouched', { markerPath }, error instanceof Error ? error : new Error(String(error)));
    return { ok: false, error: (error as Error).message, preRestoreDir: null };
  }
  if (pending === null) return null;
  clearPendingChromaRestore(markerPath);
  const preRestoreDir = path.join(path.dirname(chromaDir), `chroma-pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  try {
    if (!existsSync(pending.stagingDir)) throw new Error(`chroma staging dir is missing: ${pending.stagingDir}`);
    if (existsSync(chromaDir)) renameSync(chromaDir, preRestoreDir);
    try {
      renameWithWindowsRetry(pending.stagingDir, chromaDir);
    } catch (error) {
      // put the old dir back; nothing was overwritten
      if (existsSync(preRestoreDir)) renameSync(preRestoreDir, chromaDir);
      throw error;
    }
    logger.info('S3SYNC', 'Chroma directory restored from S3 staging', { stagingDir: pending.stagingDir, preRestoreDir, pairedDbGeneration: pending.pairedDbGeneration });
    return { ok: true, error: null, preRestoreDir };
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    logger.error('S3SYNC', 'Chroma restore FAILED; the worker starts with the unchanged chroma directory', { stagingDir: pending.stagingDir }, normalized);
    return { ok: false, error: normalized.message, preRestoreDir: null };
  }
}
