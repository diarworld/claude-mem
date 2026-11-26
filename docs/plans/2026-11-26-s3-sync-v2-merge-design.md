# S3 Sync v2: multi-device merge — design

Date: 2026-11-26
Status: approved (controller + owner)
Supersedes: the "no multi-device merge" limitation of S3 Sync v1 (docs/plans/2026-11-26-s3-sync-design.md). v1 remains shipped as-is for backup/restore; v2 adds record-level convergence on top of the same bucket transport.

## Problem

S3 Sync v1 syncs whole snapshots per device root (`claude-mem-sync/<device>/…`): a pull restores the newest foreign snapshot wholesale. Two live devices overwrite each other — memory created on device B between B's pushes is destroyed when A's snapshot is restored on B. The owner wants all their devices to converge: an observation recorded anywhere appears everywhere, automatically.

Snapshot swap cannot converge diverged databases by construction; convergence requires record-level apply.

## Discovery that shapes this design

The codebase already contains upstream Cloud Sync's record-level substrate (built for the cmem.ai hub), and it is transport-agnostic on the apply side:

- `observations`, `session_summaries`, `user_prompts` carry `origin_device_id` + `origin_local_id` with unique partial indexes `(origin_device_id, origin_local_id) WHERE origin_device_id IS NOT NULL` (SessionStore.ts:867). Replica rows (`origin_device_id NOT NULL`) are protected from local edits and deletes everywhere (`AND origin_device_id IS NULL` guards).
- `SyncApply.applyOps` (src/services/sync/SyncApply.ts) is the crash-safe, exactly-once writer of remote records: cursor + rev guards + content-dupe `DO NOTHING`, per-op quarantine (`sync_pull_quarantine`) for deterministically unapplicable ops, `ensureSessionForMemoryId` creates stub `sdk_sessions` rows for foreign observations, parked-title handling, project remaps, context invalidation, and an optional `chromaSync` forwarder fired after commit.
- `ChromaSyncState` tracks per-project watermarks plus **pending per-row ids** — newly inserted rows (including ids lower than the watermark) are embedded incrementally; a full rebuild is never required for a merge.
- `CanonicalContent.ts` defines the canonical record format and `stableDocumentId(kind, originDeviceId, originLocalId)`.
- v1 already built and shipped the S3 transport, per-device prefixes, manifests, SHA-256-verified downloads, and scheduling.

Therefore v2 does not invent a merge engine: **the S3 bucket replaces the hub's transport, and `SyncApply` remains the single writer of replica rows.**

## Decisions (owner-approved)

1. Convergence is fully automatic (scheduled; no manual command required).
2. v1 scope of merge: **observations only** (+ skeleton sessions via `ensureSessionForMemoryId`). Summaries, user prompts, work-state, media: deferred.
3. Deletions: **additive merge** in v1. Implementation reality (verified against `SyncApply`'s `sync_entity_heads` exactly-once ledger, Task 4): replaying an *identical* op after a local row deletion is `skippedStale` — a locally deleted replica does **not** resurrect on re-merge of an unchanged snapshot, and watermark loss cannot resurrect deleted replicas. The row re-appears only if the originating peer still has it and advances `sync_rev` (a re-push at a higher rev) — the additive capability the owner accepted, arriving through the ledger rather than a resurrection-on-every-tick. Tombstones (the `deleted_*_sessions` tables) remain a v2.x follow-up. Accepted by the owner.
4. Architecture: **snapshot transport + SyncApply application** (hybrid). The op-log-over-S3 shape (a full SyncClient-compatible hub replacement) is deferred; the direct-SQL shape (bypassing SyncApply) was rejected because it duplicates apply logic and loses upstream guarantees. The peer's sync identity travels in the snapshot manifest (`manifest.syncIdentity`, optional field added in Task 4; the push path populates it on every manifest) — the bucket prefix must never be used as an origin. A snapshot whose manifest lacks the field is refused ("pre-v2 push?") rather than mis-attributed.
5. The work-viewer UI must show the truthful sync state: when S3 Sync is active, the connection popover's sync row reflects S3 merge state instead of the unhelpful "cloud sync is disabled".

## Architecture

New module `src/services/s3sync/merge.ts` plus minimal extensions to existing pieces.

### Components

1. **Peer discovery** — `listKeys('claude-mem-sync/')` (one level; the existing transport already lists), excluding the own prefix. Each remaining prefix is a peer device root.
2. **Per-peer watermark** — persisted in the manager state: `mergedGenerations: Record<peerSyncId, generationStamp>`. A peer whose LATEST generation is ≤ its watermark is skipped (nothing new to merge; no re-download).
3. **Snapshot→op transformer** — downloads the peer's LATEST snapshot set (existing download + SHA-256/bytes verification), opens the snapshot `claude-mem.db` read-only, selects the peer's own rows (`WHERE origin_device_id IS NULL`), and transforms them into `SyncOp[]`: `origin_device = <peer sync identity>`, `origin_id = <the peer's local row id>`, body = the canonical observation fields (CanonicalContent). Replica rows already present in the peer's snapshot keep their original origin and flow through unchanged — convergence is transitive and idempotent (`skippedOwn` drops our own echoes).
4. **Apply** — `SyncApply.applyOps` (constructed with the worker's database and a chromaSync forwarder). Exactly-once comes from upstream: cursor, rev guards, `(origin_device_id, origin_local_id)` unique index, content-dupe `DO NOTHING`, per-op quarantine.
5. **Chroma** — via the SyncApply chromaSync forwarder / explicit pending-id marks; incremental embedding of the new local ids. No `markAllForRebuild` on the merge path.
6. **Scheduling** — a merge tick in `S3SyncManager`, running after push on its own interval (default 1×/hour, `CLAUDE_MEM_S3_SYNC_MERGE_INTERVAL_MINUTES`, 0 = disabled). Single-flight with the push pipeline's discipline.

### Device identity

`SyncApply` requires a non-empty, stable `deviceId`. S3 Sync v2 mints a **local sync identity**: a random UUID generated once, persisted in the manager state (`syncIdentity`), and used verbatim in ops (no case-mangling — that is `sanitizeDeviceName`'s job for bucket paths, and the two must not be conflated). The identity is validated against `ORIGIN_DEVICE_ID_MAX_BYTES` (src/shared/cloud-sync-limits.ts).

### Cursor policy and Cloud Sync exclusivity

`applyOps` advances the `cursor` in `sync_state` — the same key the hub client uses. v1 therefore makes **S3 merge and Cloud Sync mutually exclusive**: the merge refuses to run when Cloud Sync is configured (clear error, logged once per tick). Merge ops live in a synthetic seq space: a per-run counter seeded from the stored cursor, persisted via the same mechanism. This is documented behavior, revisited if the two transports ever need to coexist.

### Data flow (one merge tick)

```
tick
 → listKeys('claude-mem-sync/') → peers − own prefix
 → for each peer:
     LATEST = parseLatestMarker(peer/<set>/LATEST)
     generation ≤ mergedGenerations[peer] → skip (nothing new)
     download manifest + files (existing verify pipeline; any failure → peer marked error, other peers continue)
     open snapshot db read-only
     SELECT peer own-rows (origin_device_id IS NULL)
     transform to SyncOp[] → SyncApply.applyOps
     chroma via forwarder (incremental)
     mergedGenerations[peer] = generation; persist state
 → broadcast sync_status (UI freshness)
```

The merge result per peer (applied/skipped counts, errors) is kept in manager state and surfaced through `status()`.

## UI: truthful sync state

- `ViewerSyncService` (worker-service.ts:389) gains an `s3` dimension beside `cloud`/`pull`: `{ enabled, state: 'current' | 'stale' | 'error', lastMergeAt, mergedPeers, lastError }`, broadcast on the existing SSE `sync_status` event (field `sync.s3`).
- Viewer (`src/ui/my-work/src/live/connection-status.ts`, `components/bits.tsx:593`): the sync StatusRow renders the truthful source — S3 active → S3 merge state ("Current · devices: 2 · 5 min ago"); cmem Cloud Sync configured → the existing cloud state; neither → the existing "cloud sync is disabled" wording.
- New i18n keys ship in the same change (en source + ru catalog — the ru locale lives on the i18n branch and merges through main).

## Error handling

- Corrupt/failed peer snapshot (hash/bytes mismatch, bad manifest) → peer state `error` with `lastError`, other peers continue, watermark not moved (natural retry next tick).
- Ops set aside in `sync_pull_quarantine` → counted in the merge result and logged; not a failure (upstream's contract).
- Cloud Sync configured → merge refuses with a clear error.
- Peer disappears from the bucket → it simply stops appearing in discovery; its watermark is retained.
- Oversized foreign snapshots → the same manifest-declared size limits as pull; verification before staging.
- The merge tick never blocks or fails the push pipeline (independent single-flight guard, guarded errors, push-style non-throwing tick semantics).

## Testing

- Unit: snapshot→op transformer (fixture foreign db with own-rows, replica-rows, and an sdk-session-less observation); watermark skip; transitive origin preservation; Cloud Sync refusal; identity minting/persistence.
- Integration: two `S3SyncManager` instances over a shared FakeS3 in temp dirs converge in both directions (A's observation appears on B and vice versa); a second identical merge applies 0 ops (idempotence); a deleted-on-B observation resurrects on B (documented additive semantics); chroma pending marks recorded for the inserted ids.
- Live smoke: the owner's machine + the second computer against the real bucket; merge counts observed in `s3sync status`.

## Rollout

Same workflow as v1: design doc (this file) → implementation plan (docs/plans/2026-11-26-s3-sync-v2-merge.md) → per-task implementer/spec-review/quality-review loop → bundles → merge to fork/main. `docs/public/s3-sync.mdx` gains a Multi-device section (additive semantics + resurrection caveat + cloud-sync exclusivity).

## Explicitly out of scope (deferred)

- Merging session summaries, user prompts, work-state, media attachments.
- Tombstones / deletion propagation (the `deleted_*_sessions` tables exist locally; wiring them through the bucket is v2.x).
- S3 op-log transport (segment rotation, cursors per peer, compaction) — revisited only if snapshot downloads become a real cost.
- Coexistence of S3 merge with cmem.ai Cloud Sync.
