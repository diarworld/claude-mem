/**
 * Object-key layout, generation manifests and pure helpers for S3 Sync.
 * Node-safe (no Bun imports): the CLI bundle imports this module too.
 *
 * Layout in the bucket:
 *   claude-mem-sync/<device>/<set>/LATEST            {"generation": "...", "createdAt": ...}
 *   claude-mem-sync/<device>/<set>/gen/<stamp>/manifest.json
 *   claude-mem-sync/<device>/<set>/gen/<stamp>/<relative keys…>
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const S3_SYNC_ROOT = 'claude-mem-sync';
export const S3_SYNC_SETS = ['db', 'chroma'] as const;
export type S3SyncSet = (typeof S3_SYNC_SETS)[number];

export interface S3SyncManifestFile {
  /** Key relative to the generation prefix. */
  key: string;
  bytes: number;
  sha256: string;
}

export interface S3SyncManifest {
  version: 1;
  set: S3SyncSet;
  generation: string;
  createdAt: number;
  device: string;
  /**
   * The pushing device's sync identity (S3 Sync v2): peers tag merged rows
   * with it as op.origin_device, so attribution is stable across device
   * renames and never conflated with the sanitized bucket prefix above.
   * Optional only for manifests written before S3 Sync v2 — the merge side
   * refuses peers whose manifest omits it rather than fork attribution.
   */
  syncIdentity?: string;
  /** chroma set only: the db generation this index is consistent with. */
  pairedDbGeneration?: string;
  files: S3SyncManifestFile[];
}

export function sanitizeDeviceName(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || 'device';
}

/** Sanitized ISO stamps contain no ':' or '.', so key order is time order. */
export function generationStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[:.]/g, '-');
}

/** Strict check that a generation string is a stamp produced by generationStamp() —
 *  it becomes a local path segment during pull, so bucket-controlled values
 *  (e.g. '../..') must never pass. */
export function isValidGenerationStamp(generation: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(generation);
}

export function deviceRoot(device: string): string {
  return `${S3_SYNC_ROOT}/${sanitizeDeviceName(device)}`;
}

/**
 * The distinct peer device-root SEGMENTS in a complete key listing under the
 * sync root — the second path segment of every key, `ownDeviceSegment`
 * excluded, sorted. The segment is the sanitized device NAME (what
 * `deviceRoot(device)` embeds), NOT the full `claude-mem-sync/<device>` root
 * and NOT a sync identity. Device names are sanitized, so the segment
 * comparison is exact. Keys that carry no second segment (the bare root key,
 * empty strings) and keys outside the sync root yield nothing; deeper keys
 * still name their device — a device root always carries `<set>/…` below it,
 * so any segment count works.
 */
export function peersFromKeys(keys: readonly string[] | null | undefined, ownDeviceSegment: string): string[] {
  const peers = new Set<string>();
  for (const key of keys ?? []) {
    const parts = key.split('/');
    // [claude-mem-sync, <device>, …]
    if (parts[0] === S3_SYNC_ROOT && parts[1]) peers.add(parts[1]);
  }
  peers.delete(ownDeviceSegment);
  return [...peers].sort();
}

export function setPrefix(device: string, set: S3SyncSet): string {
  return `${deviceRoot(device)}/${set}`;
}

export function generationPrefix(device: string, set: S3SyncSet, generation: string): string {
  return `${setPrefix(device, set)}/gen/${generation}`;
}

export function manifestObjectKey(device: string, set: S3SyncSet, generation: string): string {
  return `${generationPrefix(device, set, generation)}/manifest.json`;
}

export function latestObjectKey(device: string, set: S3SyncSet): string {
  return `${setPrefix(device, set)}/LATEST`;
}

export function latestMarkerPayload(generation: string, createdAt: number): string {
  return JSON.stringify({ generation, createdAt });
}

export function parseLatestMarker(text: string): { generation: string; createdAt: number } | null {
  try {
    const parsed = JSON.parse(text) as { generation?: unknown; createdAt?: unknown };
    if (typeof parsed?.generation !== 'string' || parsed.generation === '') return null;
    return { generation: parsed.generation, createdAt: Number(parsed.createdAt) || 0 };
  } catch {
    return null;
  }
}

export async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Objects that changed since the previous manifest, by relative key + hash.
 * Used by S3SyncManager only as the skip check: an empty result means
 * nothing changed and the push is skipped. Deletions are NOT represented
 * (a file absent from `next` simply drops out) — harmless because every
 * uploaded generation is a complete, self-contained snapshot.
 */
export function changedFiles(previous: S3SyncManifest | null, next: S3SyncManifest): S3SyncManifestFile[] {
  if (!previous || previous.set !== next.set) return next.files;
  const before = new Map(previous.files.map(file => [file.key, file.sha256]));
  return next.files.filter(file => before.get(file.key) !== file.sha256);
}

/**
 * Generations to delete so `keep` newest survive. `freshGeneration` (the one
 * just uploaded) always survives even if the clock moved backward. At least
 * one generation always survives (`keep` is floored at 1).
 */
export function pruneGenerations(keys: string[], set: S3SyncSet, keep: number, freshGeneration?: string): string[] {
  const gens = new Set<string>();
  for (const key of keys) {
    const parts = key.split('/');
    // [claude-mem-sync, <device>, <set>, gen, <stamp>, …] — device names are sanitized, no '/'
    if (parts.length >= 5 && parts[0] === S3_SYNC_ROOT && parts[2] === set && parts[3] === 'gen') {
      gens.add(parts[4]);
    }
  }
  const sorted = [...gens].sort().reverse();
  const survivors = new Set(sorted.slice(0, Math.max(1, keep)));
  if (freshGeneration) survivors.add(freshGeneration);
  return sorted.filter(gen => !survivors.has(gen));
}
