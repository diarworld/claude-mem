/**
 * S3 Sync v2 — snapshot→op transformer. Opens a peer's snapshot database
 * READ-ONLY and converts its observation rows into the SyncOp[] shape
 * SyncApply.applyOps consumes, so a peer's memory can be applied through the
 * exact same writer the hub client uses (rev guards, stub sessions, content
 * dupe DO NOTHING, per-op quarantine).
 *
 * Purity contract: this module only reads a db and returns ops — no manager
 * state, no transport, no writes. The manager (Task 4) downloads the verified
 * snapshot, calls this, assigns the synthetic seq space, and applies.
 *
 * Identity: op.origin_device carries the peer's SYNC IDENTITY (the minted
 * UUID, S3SyncManager.ensureSyncIdentity) for the peer's own rows, and each
 * replica row's ORIGINAL origin verbatim — convergence is transitive and
 * idempotent (a row the peer itself once merged from a third device flows
 * through with its first origin, so all devices converge on one identity).
 * It is never the sanitized device-name bucket prefix.
 *
 * Body fidelity: every op goes through the PRODUCTION canonical builders —
 * buildContentOperation validates the payload against CanonicalContent
 * (required fields, string arrays, decimal strings, the stableDocumentId
 * invariant, CONTENT_BODY_MAX_BYTES) and decodeChanges performs the same
 * canonical→local translation the hub client uses (decimal strings → numbers,
 * arrays/metadata → canonical JSON strings, entity_id = stableDocumentId).
 * The transformer therefore cannot drift from the wire format: a body that
 * would be rejected on apply is rejected HERE, as a per-row skip.
 */
import { Database } from 'bun:sqlite';
import { ORIGIN_DEVICE_ID_MAX_BYTES } from '../../shared/cloud-sync-limits.js';
import { buildContentOperation } from '../sync/CanonicalContent.js';
import { decodeChanges } from '../sync/SyncClient.js';
import type { SyncOp } from '../sync/SyncApply.js';

export interface TransformResult {
  ops: SyncOp[];
  /** Rows that produced no op, each with the reason (the offending field is named). */
  skipped: Array<{ id: number; reason: string }>;
  /**
   * Rows that PRODUCED an op, by source class: own = the peer's own rows
   * (tagged with the peer sync id), replica = rows the peer had already
   * merged from another device (original origin preserved). counts plus
   * skipped.length equals the number of rows read.
   */
  counts: { own: number; replica: number };
}

/** Column name → the canonical payload key it feeds (SyncApply BODY FIELD MAPPING, kind 'observation'). */
const JSON_LIST_COLUMNS = ['facts', 'concepts', 'files_read', 'files_modified'] as const;
type JsonListColumn = (typeof JSON_LIST_COLUMNS)[number];

interface SnapshotRow {
  id: number;
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  discovery_tokens: number | null;
  created_at: string;
  created_at_epoch: number;
  content_hash: string | null;
  generated_by_model: string | null;
  merged_into_project: string | null;
  agent_type: string | null;
  agent_id: string | null;
  metadata: string | null;
  origin_device_id: string | null;
  origin_local_id: string | null;
  sync_rev: string;
}

/** Parse a JSON-string column that must become a string array (or stay null). */
function parseJsonList(column: JsonListColumn, raw: string | null): { ok: true; value: string[] | null } | { ok: false; error: string } {
  if (raw === null || raw === '') return { ok: true, value: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return { ok: false, error: `${column} is not a JSON array` };
    if (parsed.some(entry => typeof entry !== 'string')) return { ok: false, error: `${column} must be a JSON array of strings` };
    return { ok: true, value: parsed as string[] };
  } catch {
    return { ok: false, error: `${column} is not parseable JSON` };
  }
}

/** Parse the metadata JSON-string column into an object (or stay null). */
function parseMetadata(raw: string | null): { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string } {
  if (raw === null || raw === '') return { ok: true, value: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'metadata is not a JSON object' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, error: 'metadata is not parseable JSON' };
  }
}

/**
 * Transform one peer snapshot database into sync ops. Deterministic: rows are
 * read `ORDER BY id` and op.seq is the row id (ascending, gapless within the
 * batch) — Task 4's merge tick re-seats ops into its synthetic seq space
 * (per-run counter seeded from the stored cursor) before applying.
 *
 * A row that can never become a valid op (malformed JSON columns, a missing
 * required field, a rev that is not a positive decimal, a body over
 * CONTENT_BODY_MAX_BYTES) is SKIPPED with a per-row reason naming the field —
 * one bad row never fails the batch, mirroring SyncApply's per-op quarantine.
 *
 * @param peerSyncId the peer's sync identity (a UUID minted by
 *   S3SyncManager.ensureSyncIdentity); tagged onto the peer's own rows.
 * @param options.signal checked between rows; an aborted transform throws.
 */
export function transformSnapshotToOps(dbPath: string, peerSyncId: string, options?: { signal?: AbortSignal }): TransformResult {
  if (typeof peerSyncId !== 'string' || peerSyncId.length === 0) {
    throw new Error('transformSnapshotToOps requires a non-empty peerSyncId');
  }
  if (Buffer.byteLength(peerSyncId, 'utf8') > ORIGIN_DEVICE_ID_MAX_BYTES) {
    throw new Error(`peerSyncId exceeds ORIGIN_DEVICE_ID_MAX_BYTES (${ORIGIN_DEVICE_ID_MAX_BYTES})`);
  }

  const ops: SyncOp[] = [];
  const skipped: Array<{ id: number; reason: string }> = [];
  const counts = { own: 0, replica: 0 };

  // Read-only: a snapshot is a restore point, never a working database —
  // the transformer must not be able to write it even by accident.
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT * FROM observations ORDER BY id').all() as unknown as SnapshotRow[];
    for (const row of rows) {
      options?.signal?.throwIfAborted();

      const replica = row.origin_device_id !== null && row.origin_device_id !== undefined;
      const originDevice = replica ? row.origin_device_id! : peerSyncId;
      // The empty-string fallback fails the decimal check below (a replica row
      // without an origin_local_id is a corrupt snapshot row, skipped).
      const originLocalId: string = replica ? row.origin_local_id ?? '' : String(row.id);
      const skip = (reason: string): void => {
        skipped.push({ id: row.id, reason });
      };

      // Origin validation. Replica passthrough is verbatim, so an origin the
      // protocol could not have produced (empty, oversized, non-decimal
      // local id) is a corrupt snapshot row, not something to repair here.
      if (originDevice.length === 0 || Buffer.byteLength(originDevice, 'utf8') > ORIGIN_DEVICE_ID_MAX_BYTES) {
        skip(`origin_device_id must be a non-empty string of at most ${ORIGIN_DEVICE_ID_MAX_BYTES} UTF-8 bytes`);
        continue;
      }
      if (!/^(?:0|[1-9][0-9]*)$/.test(originLocalId)) {
        skip(`origin_local_id must be an unsigned base-10 string without leading zeroes`);
        continue;
      }
      // sync_rev is the op's entity_rev: the peer's minted revision for
      // pushed rows (default '1' — the column is NOT NULL DEFAULT '1'), so a
      // replica that already has the row at that revision skips it stale
      // (idempotence). A non-positive or garbage rev can never apply.
      if (!/^(?:0|[1-9][0-9]*)$/.test(row.sync_rev ?? '') || row.sync_rev === '0') {
        skip(`sync_rev must be a positive decimal string, got ${JSON.stringify(row.sync_rev ?? null)}`);
        continue;
      }

      // JSON-string columns → canonical payload shapes. A malformed column
      // names itself in the skip reason.
      let fatal: string | null = null;
      const lists = {} as Record<JsonListColumn, string[] | null>;
      for (const column of JSON_LIST_COLUMNS) {
        const parsed = parseJsonList(column, row[column]);
        if (!parsed.ok) {
          fatal = parsed.error;
          break;
        }
        lists[column] = parsed.value;
      }
      if (fatal !== null) {
        skip(fatal);
        continue;
      }
      const metadata = parseMetadata(row.metadata);
      if (!metadata.ok) {
        skip(metadata.error);
        continue;
      }
      // Decimal columns travel as canonical decimal strings on the wire
      // (CanonicalContent.PAYLOAD_DECIMAL_FIELDS); a garbage number cannot
      // become one.
      const decimal = (name: 'prompt_number' | 'discovery_tokens' | 'created_at_epoch', value: number | null): string | null | { error: string } => {
        if (value === null || value === undefined) return null;
        if (typeof value !== 'number' || !Number.isFinite(value)) return { error: `${name} must be a finite number` };
        return String(value);
      };
      const epoch = decimal('created_at_epoch', row.created_at_epoch);
      if (typeof epoch === 'object' && epoch !== null && 'error' in epoch) {
        skip(epoch.error);
        continue;
      }
      const promptNumber = decimal('prompt_number', row.prompt_number ?? null);
      if (typeof promptNumber === 'object' && promptNumber !== null && 'error' in promptNumber) {
        skip(promptNumber.error);
        continue;
      }
      const discoveryTokens = decimal('discovery_tokens', row.discovery_tokens ?? null);
      if (typeof discoveryTokens === 'object' && discoveryTokens !== null && 'error' in discoveryTokens) {
        skip(discoveryTokens.error);
        continue;
      }

      // Canonical payload (CanonicalContent PAYLOAD_FIELDS.observation — the
      // 21 fields the hub accepts; device-local bookkeeping is excluded).
      const payload: Record<string, unknown> = {
        agent_id: row.agent_id,
        agent_type: row.agent_type,
        concepts: lists.concepts,
        content_hash: row.content_hash,
        created_at: row.created_at,
        created_at_epoch: epoch,
        discovery_tokens: discoveryTokens,
        facts: lists.facts,
        files_modified: lists.files_modified,
        files_read: lists.files_read,
        generated_by_model: row.generated_by_model,
        memory_session_id: row.memory_session_id,
        merged_into_project: row.merged_into_project,
        metadata: metadata.value,
        narrative: row.narrative,
        project: row.project,
        prompt_number: promptNumber,
        subtitle: row.subtitle,
        text: row.text,
        title: row.title,
        type: row.type,
      };

      // The production validator: required fields, string arrays, decimal
      // strings, filterable limits, the stableDocumentId invariant and the
      // body-size cap. A failure message names the field — it becomes the
      // skip reason verbatim.
      let wire: { body: string; operation_sha256: string };
      try {
        wire = buildContentOperation({
          kind: 'observation',
          originDeviceId: originDevice,
          originLocalId,
          entityRev: row.sync_rev,
          payload,
        });
      } catch (error) {
        skip(error instanceof Error ? error.message : String(error));
        continue;
      }

      // The production decode: canonical body → the local-body SyncOp
      // (decimal strings → numbers, arrays/metadata → JSON strings,
      // entity_id = stableDocumentId) — the exact translation the hub client
      // feeds applyOps. A row that fails here (cannot happen for a body
      // buildContentOperation just built) is skipped like any other.
      const [op] = decodeChanges([{ seq: String(row.id), body: wire.body, operation_sha256: wire.operation_sha256 }]);
      if (op === undefined || 'undecodable' in op) {
        skip(op && 'undecodable' in op ? op.undecodable : 'op was dropped by the decoder');
        continue;
      }
      ops.push(op);
      if (replica) counts.replica++;
      else counts.own++;
    }
  } finally {
    db.close();
  }

  return { ops, skipped, counts };
}
