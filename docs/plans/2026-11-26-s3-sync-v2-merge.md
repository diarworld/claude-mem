# S3 Sync v2: multi-device merge — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Devices converge automatically — an observation recorded on any device appears on all others via the owner's own S3 bucket, applying records through upstream's `SyncApply` (exactly-once, replica-row discipline), with a truthful sync status in the work-viewer UI.

**Architecture:** Snapshot transport (v1, already live) + a merge tick: discover peer device roots by bucket listing, download peers' newer LATEST snapshots, transform their own-rows into canonical `SyncOp`s, and hand them to `SyncApply.applyOps` — the single writer of replica rows. Chroma embeds incrementally via the existing pending-id mechanism. The work-viewer connection popover shows the truthful sync state (S3 merge vs cmem cloud vs neither).

**Tech Stack:** TypeScript (Bun runtime), better SQLite3 via bun:sqlite, existing `SyncApply`/`CanonicalContent`/`ChromaSyncState`/`S3SyncManager`, FakeS3 test pattern, bun test + npm typecheck.

**Authoritative design:** `docs/plans/2026-11-26-s3-sync-v2-merge-design.md` (owner-approved; decisions 1–5 and the out-of-scope list are binding).

---

## Controller-verified facts (anchors — read before coding, they are load-bearing)

- **`SyncApply`** (`src/services/sync/SyncApply.ts`): `new SyncApply(db, { deviceId, chromaSync?, now? })` — deviceId is REQUIRED and must be the device's stable sync identity. `applyOps(ops, { epoch?, requireContiguous? })` → `ApplyResult { applied, skippedOwn, skippedStale, skippedCursor, quarantined, cursor, epochReset }`. Ops are `{ seq, kind, origin_device, origin_id, ...body }`; kind `'observation'` bodies are validated field-by-field (`fieldString`/`fieldNumber` — wrong-typed fields are malformed ops → quarantine). The class owns cursor/epoch in `sync_state` (key `'cursor'`), stub-creates `sdk_sessions` (`ensureSessionForMemoryId`), parks titles, and fires a `chromaSync` forwarder after commit. **Read the observation-op apply path and the REV MINTING RULES header comment in full before Task 2.**
- **`CanonicalContent`** (`src/services/sync/CanonicalContent.ts`): canonical field list for observation records + `stableDocumentId(kind, originDeviceId, originLocalId)` + `assertDeviceId`. The op body MUST carry these fields; a mismatch between `record.id` and `stableDocumentId(...)` is rejected.
- **`ORIGIN_DEVICE_ID_MAX_BYTES`** (`src/shared/cloud-sync-limits.ts`): max UTF-8 bytes for an origin device id.
- **Replica-row discipline**: partial unique indexes `(origin_device_id, origin_local_id) WHERE origin_device_id IS NOT NULL` on observations/summaries/prompts; all local edit/delete paths guard `AND origin_device_id IS NULL`. Never write `origin_device_id` on a row without `origin_local_id` (and vice versa).
- **`ChromaSyncState`** (`src/services/sync/ChromaSyncState.ts`): per-project watermark + pending per-row id lists (`markPending(kind, id)` semantics around lines 460–560); rows are embedded incrementally; `markAllForRebuild` exists but is NOT used on the merge path.
- **`S3SyncManager`** (`src/services/s3sync/S3SyncManager.ts`): persisted state via `loadState/saveState`; per-set persisted fields (lastPushAt/lastGeneration/lastError/lastPullAt); `start(): void` schedules guarded, non-throwing ticks; single-flight via `pushPromises` map (registration BEFORE first await); `sweepPullLeftovers` runs at boot; `isValidGenerationStamp` guards every generation that becomes a path segment; `BunS3Transport.listKeys({ prefix, maxKeys, continuationToken })` paginates via `nextContinuationToken` (NO delimiter support — peer discovery walks key paths and extracts distinct device segments).
- **Existing tests**: `tests/infrastructure/s3-sync-{manifest,snapshot,push,pull}.test.ts` — FakeS3 in-memory transport, mutable `now` clock seam, `makeManager` fixture injecting every dir. New tests follow these patterns; manager tests never touch the real `~/.claude-mem` (inject dirs; spy `paths` methods only as insurance).
- **UI chain**: worker `ViewerSyncService` (worker-service.ts:389-396) computes `sync` from `cloud` + `pull`, broadcasts SSE `sync_status` on change; viewer `src/ui/my-work/src/live/local-source.ts` (listener ~line 648) → `connection-status.ts` (labels/tones) → `bits.tsx` LiveIndicator popover (~line 593, the "Cloud copy" StatusRow) → `live-chip.ts` (problem selection; "cloud sync off is not a problem" today).
- **Cloud Sync coupling**: `applyOps` advances the `cursor` key in `sync_state`, shared with the hub client. v1 rule: **S3 merge refuses to run when Cloud Sync is configured** (how CloudSync reports "configured": see `dbManager.getCloudSync()` construction and its settings gate — find it and mirror the check).

## Workflow (per task, same as v1)

Implementer subagent → spec reviewer (does the diff match the task text?) → quality reviewer (session `ses_deada7714ffeu1RSPiaNt4HCvl`) → controller fixes gaps in fix rounds. Implementers commit ONLY the files their task names (`git add <files>`, never `-A`); new commits, never amend; work in **C:\Users\dmitry\Projects\claude-mem-s3sync** (worktree, branch `feat/s3-sync-v2`); never touch `C:\Users\dmitry\Projects\claude-mem` or the `claude-mem-maincheck` worktree. `npm run typecheck` (root + viewer) must exit 0 at every task end.

---

### Task 1: Sync identity (mint, persist, validate, surface)

**Files:**
- Modify: `src/services/s3sync/S3SyncManager.ts` (state + status)
- Test: `tests/infrastructure/s3-sync-identity.test.ts` (new)

**Steps:**
1. Write failing tests: (a) a fresh manager mints a sync identity — a UUID-shaped string within `ORIGIN_DEVICE_ID_MAX_BYTES`; (b) the identity is stable across manager re-creation on the same data dir (persisted state round-trip); (c) `status()` includes `syncIdentity`; (d) two managers on DIFFERENT data dirs mint different identities.
2. Implement: on state load, if `syncIdentity` is absent → mint `crypto.randomUUID()`, persist. Expose in `status()`. No case normalization anywhere.
3. `bun test tests/infrastructure/s3-sync-identity.test.ts` → pass; run the four existing s3-sync suites → 0 fail (state shape grew — persisted-state tests must stay green).
4. Commit: `git add src/services/s3sync/S3SyncManager.ts tests/infrastructure/s3-sync-identity.test.ts && git commit -m "feat(s3-sync-v2): persistent local sync identity"`

### Task 2: Snapshot→op transformer (the heart)

**Files:**
- Create: `src/services/s3sync/merge.ts` (transformer only this task)
- Test: `tests/infrastructure/s3-sync-merge-transform.test.ts` (new)

**Steps:**
1. Read `SyncApply.ts` observation apply path + REV MINTING RULES + `CanonicalContent.ts` in full. Report the exact op-body field list you implement against (quote it) — the controller verified the mechanism, not every field name.
2. Write failing tests with FIXTURE DATABASES built by bun:sqlite (mirror the real columns — copy the CREATE TABLE column list from the migration at SessionStore.ts:1330 or read the live schema shape from the fixture builder used in backup tests):
   - a foreign db with two own-rows (`origin_device_id IS NULL`) + one replica-row (`origin_device_id = 'other-third', origin_local_id = 7`) → transform yields exactly 2 ops tagged with the peer's sync id, plus 1 op for the replica-row preserving origin `'other-third'`/`7`;
   - an observation whose `memory_session_id` has no matching sdk_sessions row → still transformed (SyncApply stubs the session; assert the op carries `memory_session_id`);
   - a row with a NULL/empty required field per CanonicalContent's rules → either skipped with a per-row reason (preferred: collect and report, never throw the whole batch) or quarantinable — pick one, document, and test it;
   - idempotence: transforming the same db twice yields identical op lists (deterministic order — ORDER BY id).
3. Implement `transformSnapshotToOps(dbPath: string, peerSyncId: string, options?: { signal? }): { ops: SyncOp[]; skipped: Array<{ id: number; reason: string }>; counts: { own: number; replica: number } }` — open read-only (`new Database(path, { readonly: true })`), single pass, deterministic order. SyncOp import is type-only.
4. Tests pass; typecheck exit 0.
5. Commit: `git add src/services/s3sync/merge.ts tests/infrastructure/s3-sync-merge-transform.test.ts && git commit -m "feat(s3-sync-v2): transform peer snapshots into canonical sync ops"`

### Task 3: Peer discovery + per-peer watermarks + merge state

**Files:**
- Modify: `src/services/s3sync/manifest.ts` (if a device-root helper belongs there — judge; else keep in merge.ts)
- Modify: `src/services/s3sync/S3SyncManager.ts` (state: `mergedGenerations: Record<string, string>`, `mergeState: Record<string, { state: 'ok'|'error'|'skipped'; applied: number; lastMergeAt: number; lastError: string | null }>`)
- Modify: `src/services/s3sync/s3-transport.ts` ONLY if listing needs a walk helper (listKeys already paginates)
- Test: `tests/infrastructure/s3-sync-merge-discovery.test.ts` (new)

**Steps:**
1. Failing tests (FakeS3): (a) discovery from seeded keys `claude-mem-sync/<deviceA>/db/LATEST`, `claude-mem-sync/<deviceB>/chroma/gen/…/manifest.json`, own prefix excluded → `['<deviceA>', '<deviceB>']` (distinct device segments = second path segment after the sync root); (b) watermark: seed `mergedGenerations[peerA] = <gen1>`; peerA's LATEST = gen1 → skipped; LATEST = gen2 → not skipped; (c) watermark + mergeState persist across manager re-creation; (d) `status()` exposes `merge: { peers: …, mergedGenerations, mergeState }`.
2. Implement `discoverPeers(transport, ownDeviceRoot): Promise<string[]>` (walk keys under the sync root, extract second segments, exclude own — own is identified by the device ROOT (sanitized name), NOT by syncIdentity) and the state fields.
3. Tests pass; regression: all 5 existing s3-sync suites 0 fail. Typecheck.
4. Commit: `git add <named files> && git commit -m "feat(s3-sync-v2): peer discovery and per-peer merge watermarks"`

### Task 4: Merge tick (orchestration on the manager)

**Files:**
- Modify: `src/services/s3sync/S3SyncManager.ts` (tick, single-flight, refusal, error isolation)
- Modify: `src/services/s3sync/manifest.ts` (only if a key-layout helper is needed)
- Test: `tests/infrastructure/s3-sync-merge-tick.test.ts` (new)

**Steps:**
1. Read how CloudSync constructs its `SyncApply` (grep `new SyncApply(`) — mirror the chromaSync forwarder wiring; report what you found and reused.
2. Failing tests (two managers over ONE shared FakeS3, fixture db sets pushed by each — reuse the v1 push fixtures):
   - **convergence**: A pushes (2 observations), B merges → B's local db contains A's rows as replica rows (`origin_device_id = A's syncIdentity`) with NEW local ids; chroma pending marks recorded for those ids (assert via ChromaSyncState read API); B's `mergeState[A]` = ok with applied counts; watermark = A's generation.
   - **both directions**: then B pushes its own rows; A merges → A sees B's observations AND (transitively) nothing duplicate; second identical merge → `applied: 0` (idempotence).
   - **resurrection (documented additive semantics)**: delete an observation locally on B, A re-pushes? NO — B merges again from A's unchanged snapshot → the deleted id reappears (assert + comment "additive v1, by design").
   - **error isolation**: peer A's manifest hash tampered → peer A error (state), peer B still merges.
   - **refusal**: construct the manager with cloud-sync-configured settings (find the real gate; simulate it the same way) → merge throws/refuses with a clear message; test pins it.
   - **single-flight + stop**: concurrent merge() calls → one runs; `stop()` during merge is safe (no unhandled rejection; merges settle or are guarded).
3. Implement the tick: interval default 60 min via `CLAUDE_MEM_S3_SYNC_MERGE_INTERVAL_MINUTES` (0 = disabled — no schedule; document the coercion: invalid/≤0 → disabled, mirroring v1's interval clamp honesty), runs AFTER push ticks are safe to coexist with (independent single-flight), per-peer flow exactly per the design's data-flow diagram, download through the existing verified path (LATEST temp file in finally, manifest+files verified before opening the snapshot db), open read-only, transform, `applyOps`, update watermark ONLY on a fully successful peer (transform+apply completed; quarantine is NOT failure), persist state, broadcast nothing yet (Task 6).
4. Tests pass (this is the big one — expect iteration); regression: all s3-sync suites 0 fail; typecheck.
5. Commit: `git add <named files> && git commit -m "feat(s3-sync-v2): scheduled multi-device merge via SyncApply"`

### Task 5: Chroma handoff verification

**Files:**
- Modify (only if needed): `src/services/s3sync/S3SyncManager.ts` / `merge.ts`
- Test: extend `tests/infrastructure/s3-sync-merge-tick.test.ts`

**Steps:**
1. Trace: after `applyOps` inserts replica observations, WHAT makes chroma embed them? (a) does the CloudSync chromaSync forwarder already mark pending ids (read its implementation — grep the ChromaSyncLike implementation CloudSync passes)? (b) does the incremental chroma sweep pick up ids above the watermark automatically (ChromaSyncState bump semantics) — including ids LOWER than the watermark (pending list)?
2. Write the test FIRST for the outcome: after a merge, the inserted local ids are marked pending (or covered by a watermark bump) such that the next chroma sweep embeds them — assert via the ChromaSyncState read/pending API. If the forwarder already delivers this, the test pins it (no new code); if not, add the explicit `markPending` calls in the merge path.
3. If no code changed: commit nothing; report. If code changed: commit `feat(s3-sync-v2): chroma pending marks for merged observations`.

### Task 6: Worker wiring + `sync.s3` in sync_status

**Files:**
- Modify: `src/services/worker-service.ts` (ViewerSyncService s3 dimension; SyncApply construction context if the manager needs the worker's db handle — judge: the manager already owns its db access pattern; if SyncApply must be constructed per-merge with the worker db, wire it where v1 wired the manager)
- Modify: `src/services/worker/sync/ViewerSyncService.ts` (or wherever the sync payload is shaped — read it first)
- Test: `tests/infrastructure/s3-sync-status-broadcast.test.ts` (new; worker-level test following existing worker-service test patterns if any exist — else test the payload-shaping function directly)

**Steps:**
1. Read `ViewerSyncService` + how `sync` is shaped and consumed. Extend with `s3: { enabled, state: 'current'|'stale'|'error', lastMergeAt, mergedPeers, lastError } | null` — null when S3 Sync disabled (viewer keeps today's rendering).
2. State mapping: merge ran clean within the last interval → 'current'; merge error → 'error'; enabled but never merged → 'stale'; broadcast on change (reuse onChange plumbing).
3. Test: shaping function maps manager status → payload truthfully (all four cases). Typecheck.
4. Commit: `git add <named files> && git commit -m "feat(s3-sync-v2): surface merge state in sync_status"`

### Task 7: Viewer — truthful sync row

**Files:**
- Modify: `src/ui/my-work/src/live/connection-status.ts` (state mapping)
- Modify: `src/ui/my-work/src/components/bits.tsx` (~line 593 StatusRow + live-chip integration if a merge error should surface as a chip problem)
- Modify: `src/ui/i18n/*` — EN source keys only; note in the task report that ru translations for the new keys must ride the i18n branch merge
- Test: extend `src/ui/my-work/src/live/live-chip.test.ts` / connection-status tests (follow their file conventions)

**Steps:**
1. Failing tests: (a) s3 enabled + current → sync row label is the S3 current wording with peer count and relative time; (b) s3 error → warning tone + lastError in details; (c) s3 enabled + cloud unconfigured → NO "cloud sync is disabled" text anywhere in the row (the owner's exact complaint); (d) s3 off → today's rendering byte-identical; (e) chip problem selection unchanged for the s3-off case; decide + test whether an s3 error is a chip problem (recommendation: yes, after feed problems, before nothing).
2. Implement the mapping + StatusRow content. Keep the row title "Cloud copy" only if s3 is off; when s3 is the truth, prefer a distinct title (e.g. 'Memory sync') — new i18n key, EN now.
3. Tests pass; typecheck (viewer included).
4. Commit: `git add <named files> && git commit -m "feat(s3-sync-v2): truthful sync status in the work-viewer"`

### Task 8: CLI status surfacing

**Files:**
- Modify: `src/npx-cli/commands/s3sync.ts` (status prints merge info)
- Modify: `src/services/s3sync/S3SyncManager.ts` (only if status() needs a merge-shaped accessor)
- Test: extend `tests/npx-cli/s3sync-pull-skip.test.ts` style file or a new `s3sync-status-merge.test.ts`

**Steps:**
1. `status` output gains a `Merge` block: peers, per-peer state/counts, lastMergeAt, lastError (fmtTime/phaseLabel conventions as v1).
2. Test via the established spawnSync+stubbed-fetch pattern: s3 payload with two peers renders the block; disabled renders nothing new.
3. Typecheck; commit: `feat(s3-sync-v2): merge state in s3sync status`.

### Task 9: Documentation

**Files:**
- Modify: `docs/public/s3-sync.mdx` (Multi-device section: how it works, additive semantics, resurrection caveat, cloud-sync exclusivity, merge interval setting, UI status)
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/plans/2026-11-26-s3-sync.md` (only to point v1's "no multi-device merge" at the v2 doc)

**Steps:**
1. Write the section (verify every claim against the implementation — defaults, key names, behaviors; the v1 lesson: the doc describes reality, not the plan).
2. CHANGELOG bullets in the existing format. Commit: `docs: S3 Sync v2 multi-device merge`.

### Task 10: Full verification + push + merge

**Steps:**
1. `bun test tests/infrastructure/s3-sync-*.test.ts` → all pass. 2. `npm run test:infra` → compare failures against the v1 baseline (17 known Windows/environment fails recorded in the session; anything NEW is a regression — investigate, never wave off). 3. `bun test tests/backup/` → 0 fail. 4. `npm run typecheck` → 0. 5. `npm run build` + commit regenerated `plugin/` bundles. 6. Live smoke (controller, this machine + second computer): enable merge on both, push from each, observe cross-device convergence in `s3sync status` and the viewer popover. 7. `git push fork feat/s3-sync-v2`. 8. Merge `--no-ff` into fork/main from the `claude-mem-maincheck` worktree (it holds main), push.

---

## Execution

Subagent-driven in this session (the v1 pattern, proven): fresh implementer per task, spec + quality review between tasks, controller folds review outcomes into the plan.
