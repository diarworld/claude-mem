import { afterEach, describe, expect, test } from 'bun:test';
import {
  changedFiles,
  generationStamp,
  isValidGenerationStamp,
  latestObjectKey,
  manifestObjectKey,
  generationPrefix,
  parseLatestMarker,
  pruneGenerations,
  sanitizeDeviceName,
  sha256File,
  type S3SyncManifest,
} from '../../src/services/s3sync/manifest.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function manifest(overrides: Partial<S3SyncManifest> = {}): S3SyncManifest {
  return {
    version: 1,
    set: 'db',
    generation: '2026-11-26T10-00-00-000Z',
    createdAt: 1,
    device: 'box',
    files: [{ key: 'claude-mem.db.gz', bytes: 10, sha256: 'aaa' }],
    ...overrides,
  };
}

describe('s3 sync manifest', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('device names are bucket-safe', () => {
    expect(sanitizeDeviceName('DESKTOP-ABC123')).toBe('desktop-abc123');
    expect(sanitizeDeviceName('мой ПК')).toBe('device');
    expect(sanitizeDeviceName('')).toBe('device');
  });

  test('generation stamps sort lexicographically as time', () => {
    const a = generationStamp(new Date('2026-11-26T09:00:00Z').getTime());
    const b = generationStamp(new Date('2026-11-26T10:00:00Z').getTime());
    expect(a < b).toBe(true);
    expect(a).not.toContain(':');
  });

  test('isValidGenerationStamp accepts only generated stamps', () => {
    const stamp = generationStamp(new Date('2026-11-26T09:00:00Z').getTime());
    expect(isValidGenerationStamp(stamp)).toBe(true);
    expect(isValidGenerationStamp('../..')).toBe(false);
    expect(isValidGenerationStamp('')).toBe(false);
    expect(isValidGenerationStamp('2026-11-26T10:00:00Z')).toBe(false);
    expect(isValidGenerationStamp('g1')).toBe(false);
  });

  test('object keys nest under device/set/gen', () => {
    expect(manifestObjectKey('box', 'db', 'g1')).toBe('claude-mem-sync/box/db/gen/g1/manifest.json');
    expect(latestObjectKey('box', 'chroma')).toBe('claude-mem-sync/box/chroma/LATEST');
    expect(generationPrefix('box', 'db', 'g1')).toBe('claude-mem-sync/box/db/gen/g1');
  });

  test('diff returns only changed or new files', () => {
    const prev = manifest({ files: [
      { key: 'a', bytes: 1, sha256: 'same' },
      { key: 'b', bytes: 2, sha256: 'old' },
    ] });
    const next = manifest({ files: [
      { key: 'a', bytes: 1, sha256: 'same' },
      { key: 'b', bytes: 2, sha256: 'new' },
      { key: 'c', bytes: 3, sha256: 'add' },
    ] });
    expect(changedFiles(prev, next).map(f => f.key)).toEqual(['b', 'c']);
    expect(changedFiles(null, next)).toHaveLength(3);
  });

  test('deletions are not reported as changes', () => {
    const prev = manifest({ files: [
      { key: 'stay', bytes: 1, sha256: 'same' },
      { key: 'gone', bytes: 2, sha256: 'old' },
    ] });
    const next = manifest({ files: [{ key: 'stay', bytes: 1, sha256: 'same' }] });
    expect(changedFiles(prev, next).map(f => f.key)).toEqual([]);
  });

  test('prune keeps the newest N generations and never the fresh one', () => {
    const keys = [
      'claude-mem-sync/box/db/gen/g1/x', 'claude-mem-sync/box/db/gen/g2/x',
      'claude-mem-sync/box/db/gen/g3/x', 'claude-mem-sync/box/chroma/gen/g9/x',
    ];
    expect(pruneGenerations(keys, 'db', 2)).toEqual(['g1']);
    expect(pruneGenerations(keys, 'db', 2, 'g1')).toEqual([]);
  });

  test('prune never deletes the last generation, even with keep=0', () => {
    const keys = [
      'claude-mem-sync/box/db/gen/g1/x', 'claude-mem-sync/box/db/gen/g2/x',
      'claude-mem-sync/box/db/gen/g3/x', 'claude-mem-sync/box/chroma/gen/g9/x',
    ];
    expect(pruneGenerations(keys, 'db', 0)).toEqual(['g2', 'g1']);
  });

  test('latest marker round-trips', () => {
    const text = JSON.stringify({ generation: 'g1', createdAt: 5 });
    expect(parseLatestMarker(text)).toEqual({ generation: 'g1', createdAt: 5 });
    expect(parseLatestMarker('garbage')).toBeNull();
  });

  test('sha256File hashes file contents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's3sync-test-'));
    tempDirs.push(dir);
    const file = join(dir, 'f.txt');
    writeFileSync(file, 'hello');
    expect(await sha256File(file)).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  test('sha256File rejects a nonexistent path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's3sync-test-'));
    tempDirs.push(dir);
    await expect(sha256File(join(dir, 'nope.txt'))).rejects.toThrow();
  });
});
