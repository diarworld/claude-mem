# S3 Sync — design

Date: 2026-11-26
Status: approved

## Problem

claude-mem ships Cloud Sync as a hosted CMEM Pro feature (hub at `sync.cmem.ai`).
We want the same "carry my memory and configuration" capability against our own
S3-compatible storage (Yandex Object Storage, bucket `d-dp-test`), without a hub
and without new runtime dependencies.

## Non-goals

- No record-level two-lane sync protocol (that is the existing hub-based
  `src/services/sync/` feature; we do not touch it).
- No concurrent multi-machine merge. The unit of sync is a whole snapshot;
  last write wins. Restoring on a second machine replaces its local state.
- No encryption. Snapshots upload as plaintext; the private bucket is the only
  protection. Snapshots include `.env` (API keys) — documented risk.
- No new npm dependencies. The worker runs under Bun, so `Bun.S3Client`
  (validated against Yandex Object Storage: list/put/get/delete OK) covers
  transport, including multipart upload for large files.

## Naming

The setting prefix `CLAUDE_MEM_CLOUD_SYNC_*` belongs to the existing Pro hub
sync. This feature is **S3 Sync**: command `claude-mem s3sync`, settings
`CLAUDE_MEM_S3_SYNC_*`, service directory `src/services/s3sync/`, docs
`docs/public/s3-sync.mdx`.

## Architecture

Everything runs inside the worker (Bun runtime). The CLI is a thin HTTP client,
same pattern as `backup`/`restore` (npx-cli runs under Node and must not touch
SQLite or S3 directly).

| Component | Path | Role |
|---|---|---|
| `S3SyncManager` | `src/services/s3sync/S3SyncManager.ts` | scheduler + push pipeline; guards against overlapping runs |
| `S3SyncSnapshot` | `src/services/s3sync/snapshot.ts` | builds a snapshot set: DB via `runSqliteFileJob({kind:'snapshot'})`, chroma under the worker's chroma writer lock, config files copied directly |
| `S3SyncManifest` | `src/services/s3sync/manifest.ts` | generation manifest (files, sizes, SHA-256); diff against previous generation uploads only changed objects |
| `S3Transport` | `src/services/s3sync/s3-transport.ts` | thin wrapper over `Bun.S3Client` behind an interface, so tests inject an in-memory fake |
| `S3SyncRoutes` | `src/services/worker/http/routes/S3SyncRoutes.ts` | `/api/s3sync/status|push|pull`, modeled on `BackupRoutes` |
| CLI command | `src/npx-cli/commands/s3sync.ts` | `claude-mem s3sync push|pull|status` |
| Device identity | reuse `src/services/sync/local-device-identity.ts` | hostname/device prefix inside the bucket |

## Layout in the bucket

Two independent sets with different cadence, under one device prefix:

```
claude-mem-sync/<hostname>/
  db/LATEST                    # pointer to the last fully uploaded generation
  db/gen/<timestamp>/
    manifest.json              # files, sizes, sha256, device, created
    db.sqlite.gz               # VACUUM INTO snapshot, gzip (74 MB -> ~20 MB)
    settings.json
    env                        # copy of .env (see risk note)
    work-view-reviews.db.gz, state/*.json, MY-RULES.md
  chroma/LATEST
  chroma/gen/<timestamp>/
    manifest.json
    chroma.sqlite3.gz          # consistent copy via VACUUM INTO on a readonly connection
    <collection-uuid>/data_level0.bin …   # HNSW files, stored raw
```

`LATEST` is written **last** (S3 has no atomic rename; a present LATEST means
"this generation is complete"). Logs and derived caches (`logs/`,
`context-cache/`, `tree-sitter-libs/`, spool files) never sync.

## Data flow

### Push (worker)

1. Snapshot DB: `runSqliteFileJob({kind:'snapshot'})` in a child Bun process
   (`VACUUM INTO` → `quick_check`). The live `claude-mem.db` is never copied raw.
2. Copy small files: `settings.json`, `.env`, `MY-RULES.md`, `state/*.json`,
   `work-view-reviews.db` (VACUUM INTO as well).
3. Chroma (when its cadence is due): the worker already holds the chroma writer
   lock, so no other writer exists. `chroma.sqlite3` via VACUUM INTO on a
   readonly connection; HNSW files copied directly.
4. gzip → SHA-256 → diff against the last uploaded manifest (cached in
   `state/s3sync/`) → upload changed objects only; large objects use the
   built-in multipart writer.
5. Upload `manifest.json`, then `LATEST`.
6. Prune generations beyond `KEEP_GENERATIONS`.

### Pull (CLI → worker)

`claude-mem s3sync pull [--set db|chroma|all] [--generation ts]`:

1. Worker reads `LATEST` + manifest, downloads objects into
   `backups/s3sync-incoming/`, verifies every SHA-256 **before** staging.
2. DB and chroma stage through the existing `backups/restore-pending.json`
   mechanism and apply at next worker boot (`restore-swap.ts`), before the
   worker opens the DB or chroma.
3. `settings.json` / `.env` overwrite in place, previous files kept as `.bak`.
4. CLI prints "restart the worker to apply" — same UX as `claude-mem restore`.

### Scheduling

On worker boot, if `CLAUDE_MEM_S3_SYNC_ENABLED=true`: interval scheduler with
`DB_INTERVAL_HOURS=6` and `CHROMA_INTERVAL_HOURS=24`, ±10% jitter, last-run
timestamps in `state/s3sync/`. A push that happened recently is skipped.
No in-memory queues, no retry stores — only last-attempt state.

### Error handling

- Push failure → log + `state/s3sync-health.json` (pattern of `sync-health.ts`),
  retry on the next interval.
- Partial push is harmless: objects re-upload on the next push, `LATEST` is
  untouched, the previous generation stays consistent.
- Pull with a SHA-256 mismatch aborts staging entirely; local files untouched.
- Sync never blocks the observation pipeline (outside the observer lifecycle).

## Configuration

In `settings.json` (defaults registered once in `SettingsDefaultsManager.ts`):

```
CLAUDE_MEM_S3_SYNC_ENABLED=false
CLAUDE_MEM_S3_SYNC_ENDPOINT=https://storage.yandexcloud.net
CLAUDE_MEM_S3_SYNC_BUCKET=d-dp-test
CLAUDE_MEM_S3_SYNC_REGION=ru-central1
CLAUDE_MEM_S3_SYNC_DB_INTERVAL_HOURS=6
CLAUDE_MEM_S3_SYNC_CHROMA_INTERVAL_HOURS=24
CLAUDE_MEM_S3_SYNC_KEEP_GENERATIONS=5
CLAUDE_MEM_S3_SYNC_INCLUDE_ENV=true
CLAUDE_MEM_S3_SYNC_INCLUDE_CHROMA=true
CLAUDE_MEM_S3_SYNC_DEVICE=<hostname, auto>
```

In `.env` (secrets, like the other credentials):

```
CLAUDE_MEM_S3_SYNC_ACCESS_KEY_ID=…
CLAUDE_MEM_S3_SYNC_SECRET_ACCESS_KEY=…
```

Push status states (`idle | snapshotting | uploading | ok | error`) are defined
once in a shared type with a `Record<State, …>` wording table per
`docs/architecture/state-machines.md`; routes, CLI and tests import that
definition and never re-type it.

## Testing

Repo patterns: DI seams (`options.now`), injectable transport, no network in
tests.

- `tests/infrastructure/s3-sync-manifest.test.ts` — manifest build/diff,
  retention pruning, key layout.
- `tests/infrastructure/s3-sync-push.test.ts` — push pipeline against an
  in-memory S3 fake: idempotent second push (0 objects), manifest-before-LATEST
  order, partial failure leaves LATEST untouched.
- `tests/infrastructure/s3-sync-pull.test.ts` — download, SHA-256 verification,
  restore-pending staging, abort on hash mismatch.
- Manual smoke against the real bucket: push, then pull into a clean data dir.

## Shipping checks

Per `AGENTS.md`: `npm run typecheck`, the relevant bun test lanes, and
`npm run build` — the worker executes from bundles, a source-only change is not
shipped.

## Docs

`docs/public/s3-sync.mdx` + nav entry in `docs/public/docs.json`, changelog
entry in `docs/CHANGELOG.md`. The doc states the plaintext-snapshot risk and
the last-write-wins multi-machine semantics.
