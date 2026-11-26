# Runbook: installing claude-mem on a second computer (S3 Sync + GPUStack)

For an agent performing the install. The first computer already runs claude-mem
with S3 Sync enabled; this runbook brings a second computer to the same state
and verifies that the two can see each other.

Never commit or echo credentials. The Artifactory credentials and the S3/GPUStack
keys are named below by reference; the person supplies the values, or they are
read from the first computer's `~/.claude-mem/.env`.

## 0. What "done" means

- `claude-mem` installed from the private Artifactory registry, worker running.
- The GPUStack gateway key saved (memory writes go to the internal gateway).
- S3 Sync enabled with the same bucket as the first computer; the worker
  reports it in `GET /api/s3sync/status`.
- The first merge has picked up the peer device (the two computers know
  each other by device id).

## 1. Install from Artifactory

The package lives in a private Artifactory registry. Read credentials go in the
user's `.npmrc` (scoped `_auth`), never in the repo, never in a command line
that is logged:

```
@thedotmack:registry=https://artifactory.example/artifactory/api/npm/npm-local/
//artifactory.example/artifactory/api/npm/npm-local/:_auth=<base64 user:password>
```

Install:

```bash
npm install -g claude-mem@16.1.5-ru.4 --registry https://artifactory.example/artifactory/api/npm/npm-local/
claude-mem install
```

**The versioning trap.** `16.1.5-ru.N` sorts as a *prerelease*: the worker
spawn oracle prefers a plain `16.1.5` directory over any `16.1.5-ru.N` when
both are installed (see `compareVersionsDescending`, worker-utils.ts; mirrored
in `src/build/hook-shell-template.ts` — keep in lockstep). After any install:

- check which directory the worker actually executes from:
  `GET /api/health` (or the worker log line naming the script path);
- if both `16.1.5` and `16.1.5-ru.N` exist in the plugin cache, the plain one
  wins and will silently serve old code. Remove the stale plain directory or
  pin with `CLAUDE_MEM_WORKER_SCRIPT_PATH`;
- minimum version for this runbook: `16.1.5-ru.4` (S3 Sync v2 + the setup-page
  integrations step). Earlier ru versions lack the merge pipeline; plain
  `16.1.5` from the public registry lacks S3 Sync entirely.

If the setup wizard is still pending after install (its terminal flow needs a
real TTY; an agent usually has none), finish it through the local worker's page
or endpoints instead — see step 3.

## 2. Configure the GPUStack gateway

The gateway key is `CLAUDE_MEM_OPENROUTER_API_KEY` in `~/.claude-mem/settings.json`
(the provider is OpenRouter-shaped; the base URL points at the internal
GPUStack). Either:

- **Setup page** (worker running, port 37778): open `http://localhost:37778/?setup=1`,
  go to the storage-choice step, type the key into *Integrations → Internal
  model gateway*, press *Use this computer*. Endpoint and model are filled
  automatically when they are still empty (`https://gpustack.data.lmru.tech/v1`,
  `glm-5.3-flash`) — a value this machine already chose is never overwritten.
- **Programmatically** (what an agent does):

```bash
curl -s -X POST http://localhost:37778/api/setup/integrations \
  -H 'Content-Type: application/json' \
  -d '{"gpuStackApiKey":"<key>","gpuStackEndpoint":"https://gpustack.data.lmru.tech/v1"}'
```

The endpoint is loopback-only; run the curl on the second computer itself.

Verify: the answer is the integrations view itself — `openRouterKeyMasked`
shows the key's last four characters — and `~/.claude-mem/settings.json` holds
`CLAUDE_MEM_PROVIDER: "openrouter"`, the endpoint, the model and the key. A
memory save then reports the gateway as its provider (worker log, `OPENROUTER`
lines).

## 3. Enable S3 Sync

The same integrations block carries the S3 Sync settings. Needed values:

- endpoint and region: the shipped defaults are Yandex Object Storage
  (`https://storage.yandexcloud.net`, `ru-central1`); copy the first computer's
  actual values from its `~/.claude-mem/settings.json`
  (`CLAUDE_MEM_S3_SYNC_ENDPOINT` / `_REGION`) when in doubt;
- bucket: the same bucket name as the first computer (`CLAUDE_MEM_S3_SYNC_BUCKET`);
- access key + secret: the bucket credentials. On the first computer they live
  in `~/.claude-mem/.env` as `S3_SYNC_ACCESS_KEY_ID` /
  `S3_SYNC_SECRET_ACCESS_KEY` — copy those two values.

```bash
curl -s -X POST http://localhost:37778/api/setup/integrations \
  -H 'Content-Type: application/json' \
  -d '{"s3Sync":{"enabled":true,"endpoint":"https://storage.yandexcloud.net","bucket":"<bucket>","region":"ru-central1","accessKeyId":"<key id>","secretAccessKey":"<secret>"}}'
```

The worker refuses an enable without credentials (they are neither submitted
nor already in `.env`) with HTTP 400 — that refusal is the check, not a bug.
On success the manager starts immediately; no worker restart is needed
(`DatabaseManager.ensureS3SyncManager` picks the new settings up). The
credentials land in `~/.claude-mem/.env` (mode 0600), the settings in
`~/.claude-mem/settings.json`.

If the setup wizard is mid-flight (install status not `ready`), the
integrations endpoint still accepts the save — the blocks are person settings,
not funnel state. The wizard itself needs its own steps (agent install,
choice, complete) as usual.

## 4. Verify

```bash
curl -s http://localhost:37778/api/s3sync/status
```

Expect: `configured: true`, the manager `running`, this computer's device id,
and `lastPush` per set filling after the first tick (db set interval default
6 h, chroma 24 h — for a first proof use `POST /api/s3sync/push` with
`{"set":"db"}` and then `GET /api/s3sync/status` again).

Cross-device smoke:

1. On the first computer: `POST /api/s3sync/push` with `{"set":"db"}`.
2. On the second computer: `POST /api/s3sync/pull` with `{"set":"db"}`, then
   trigger a merge (`POST /api/s3sync/push` runs discovery and merge before
   pushing; the status answer lists `peers`). The first computer's device id
   must appear in the second computer's peer list.
3. `GET /api/my-work` (or the My Work page) on the second computer shows
   observations that only exist on the first.

Failure quick checks: credentials in `.env` not `settings.json`; the bucket
prefix (`CLAUDE_MEM_S3_SYNC_DEVICE`) differs per machine on purpose (empty =
hostname); a refused push with `refused` in the status means another push is
still running.

## 5. Gotchas

- **Never** point the second computer at the first computer's worker or
  database; devices share the bucket, not the machine.
- `.env` travels inside the db set (`CLAUDE_MEM_S3_SYNC_INCLUDE_ENV=true`) —
  the bucket is private by design; do not loosen the bucket policy instead of
  rotating keys.
- The setup page's blocks are also the *edit* path later: `?setup=1` on a
  configured machine keeps the existing configuration (the page answers the
  waiting installer itself); use the `integrations` endpoint for changes
  without the wizard.
- Keep versions in lockstep across machines when a merge-behavior fix ships:
  a peer on an older version merges with the older rules until it updates.
