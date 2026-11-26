# Local-Only Installer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove every cmem.ai contact from the installer (`npx claude-mem install` / `update`): no OAuth sign-in, no checkout, no "On The Go" cloud branch, no waitlist POST — the install is fully local and never opens a cmem.ai page.

**Architecture:** Extract the OAuth pairing client into `src/npx-cli/install/pairing.ts` (teambrain still needs it), delete all installer call sites, collapse the setup funnel to the `home` branch, and shrink the shared contract (`setup-funnel.ts`, `setup-state.ts`, worker routes, viewer setup UI). Existing configured installs survive reinstall: a persisted provider is kept, never wiped.

**Tech Stack:** TypeScript (Bun), clack prompts, React (viewer setup UI), Bun test.

**Worktree:** `C:\Users\dmitry\Projects\claude-mem-localinstall`, branch `feat/local-install`.

**Design doc:** `docs/plans/2026-11-26-local-install-design.md` (approved).

**Ground rules for every task:**
- After code changes run `npm run typecheck` (root + viewer) and the named test file(s) via `bun test <file>` before committing.
- `plugin/scripts/*.cjs(+.map)` are generated bundles — never hand-edit; regenerated once in Task 10.
- `waitForReturnToOpenBrowser`, `openBrowser`, the pairing client, and `TrialReadyResult` move out of `install.ts` — they are kept because `teambrain.ts` (explicit user command, out of scope) imports them.
- Telemetry consent machinery (`claude-mem telemetry`) stays; only the installer OAuth/checkout/waitlist events are removed.

---

### Task 1: Extract the pairing stack into `src/npx-cli/install/pairing.ts`

teambrain.ts imports these from `./install.js` (teambrain.ts:47-58); deleting them from install.ts would break it. Move, don't delete.

**Files:**
- Create: `src/npx-cli/install/open-browser.ts`
- Create: `src/npx-cli/install/pairing.ts`
- Delete: `src/npx-cli/cmem-pro-costs.ts` (contents absorbed)
- Modify: `src/npx-cli/commands/install.ts`, `src/npx-cli/commands/teambrain.ts`, `src/npx-cli/cmem-memory-credentials.ts`
- Test: `tests/npx-cli/teambrain-command.test.ts` (import path update only)

**Step 1: Create `open-browser.ts`** — move from install.ts:
- `openBrowser` (install.ts:1349-1364 approx, incl. Windows `cmd /c start`, darwin `open`, `xdg-open` fallback and the headless comment)
- `waitForReturnToOpenBrowser` (install.ts:2365-2388 approx)
Export both. install.ts and pairing.ts import from `./open-browser.js` / `../install/open-browser.js`.

**Step 2: Create `pairing.ts`** — move from install.ts verbatim (no behavior change):
- OAuth constants `CMEM_INSTALLER_OAUTH_START_URL`, `CMEM_INSTALLER_OAUTH_POLL_URL`, `CMEM_PRO_BASE_URL`, `CMEM_PRO_MODEL`, `CMEM_PRO_ORIGIN`, `OAUTH_*` timeouts (install.ts:1693-1702, cmem-pro-costs.ts:44-51)
- Types: `InstallerOAuthPairing` (install.ts:~1717+), `InstallerPairingPhase` (1711), `OAuthStartFailure` (1883), `TrialPlan` (1706), `TrialReadyResult`, `DeliveredCmemMemoryCredentials` import
- Functions: `startInstallerOAuthPairing` (1937), `pollInstallerPairingOnce` (2142), `parseTrialReadyBody` (2074), `waitForInstallerPairing`, `completeInstallerOAuthLogin`, `saveReadyPairing`, `pairingAcceptsReady`, `lastOAuthStartFailure`/`lastOAuthStartErrorMessage` (1885+), `noteDeviceCode` (2466), `joinFailedMessage` (2136) + `JOIN_FAILED_FALLBACKS` (2128), `buildSyncConnectionSettings`, `parseBrowserUrl`, `relayedLine` helper (install.ts:64 import moves here)
- The poll stage messages (2221-2233), timeout copy (2275-2303), `installer_oauth_*` telemetry emitters STAY with these functions but events may be trimmed: keep `installer_oauth_start_failed`/`installer_oauth_started`/`installer_oauth_timeout`/`installer_oauth_completed` emitters inside pairing.ts (teambrain join still reports them).
- `PRO_TRIAL_LABEL` + `proTrialUrl` move here too (teambrain + pairing copy).
Export everything teambrain needs (teambrain.ts:47-58 list).

**Step 3: Re-point importers**
- teambrain.ts: import pairing symbols from `../install/pairing.js`, `openBrowser`/`waitForReturnToOpenBrowser` from `../install/open-browser.js`.
- install.ts: import `openBrowser` from `../install/open-browser.js` (it still opens the LOCAL setup page at runBrowserSetup dep, install.ts:3666).
- cmem-memory-credentials.ts:5: `CMEM_PRO_BASE_URL, CMEM_PRO_MODEL` now from `./install/pairing.js`.
- `tests/npx-cli/teambrain-command.test.ts:13`: update import path.

**Step 4: Delete `src/npx-cli/cmem-pro-costs.ts`** — `buildProviderLabels`, `ProviderLabels`, `PROVIDER_PROMPT_MESSAGE` die in Task 2; nothing else may import the file after Step 3 (verify with grep).

**Step 5: Verify**

Run: `npm run typecheck && bun test tests/npx-cli/teambrain-command.test.ts`
Expected: typecheck OK, tests PASS.

**Step 6: Commit** — `refactor(installer): move OAuth pairing client to install/pairing.ts (teambrain keeps it)`

---

### Task 2: install.ts — terminal flow goes local-only

**Files:**
- Modify: `src/npx-cli/commands/install.ts`
- Modify: `src/npx-cli/installer-provider-choice.ts`, `src/npx-cli/index.ts`
- Delete: `src/npx-cli/install/usage-summary.ts`, email-waitlist block
- Test: rewrite/delete as listed

**Step 1: Delete installer-only OAuth flow functions from install.ts**
- `requireInstallerOAuthLogin` (2390-2419), `offerDeferredLogin` (2432-2464), `startOnTheGoPairing` (3220-3240), `completeCmemTrialPairing` (2492-~2530), `activateBrowserEnrollment` (2484-2490)
- All `installer_oauth_*`/`trial_activated` emitters remaining in install.ts (2395, 2415, 2446, 2460, 2525, 3226) — pairing.ts has its own.
- Email opt-in block: `DEFAULT_SIGNUP_ENDPOINT`…`promptEmailOptIn` (2533-~2660) and its call site (3391) + `applyLegacyBrowserEmail` if it only serves the waitlist email (check its body; if it writes settings only for the funnel email, delete with its call at 3708). Delete `tests/npx-cli/install-email-optin.test.ts`.

**Step 2: `promptProvider` (1366-~1500) — remove the CMEM Pro option**
- Delete the `cmem` multiselect option and the whole `selectedProvider === 'cmem'` branch (1445-~1500).
- New behavior: with no `options.provider` and interactive, no prompt is needed — the only choice is local. Set `options.providerSource = 'default'`, log `Memory runs on your logged-in Claude account (local).`, return `'claude'`. Keep the `persisted` early-return (1400-1402) unchanged.
- Delete `ProviderChoice` 'cmem' member and any `labels.cmem` remnants.

**Step 3: Replace the `providerNeedsAccount` login gate (3773-3815)**
- Delete `providerNeedsAccount` (2729-2731).
- Fresh-install defaults (no persisted provider): write into settings ONLY empty keys — `CLAUDE_MEM_PROVIDER=openrouter`, `CLAUDE_MEM_OPENROUTER_BASE_URL=https://gpustack.data.lmru.tech/v1`, `CLAUDE_MEM_OPENROUTER_MODEL=glm-5.3-flash`. Env (`CLAUDE_MEM_OPENROUTER_BASE_URL`/`_MODEL` in process.env or `~/.claude-mem/.env`) and existing non-empty settings always win — never overwrite. This applies to the terminal default path AND the funnel home choice (Task 7); a fresh machine's `providerSource` becomes `'default'` with provider `'openrouter'`.
- Key handling after the defaults write:
  - `openrouter` with no held key (`hasPersonalProviderKey` false — env/.env/settings all empty): interactive → password prompt `Paste your GPUStack API key:` (reuse the pattern from `completeUpdateProviderSetup` 3011-3022, saving to `CLAUDE_MEM_OPENROUTER_API_KEY`); non-interactive → the existing ABORT validation fires with remediation `Set CLAUDE_MEM_OPENROUTER_API_KEY (env or ~/.claude-mem/.env) or pass --provider claude.`; the non-TTY funnel run warns in the summary instead of prompting (never hangs).
  - `gemini` without a held key: same local prompt pattern with its own key name.
  - `claude` / `host` / `codex` → nothing.
- Log copy for the skip cases: `Skipping claude-mem sign-in: this build installs fully locally.`
- `completeUpdateProviderSetup` (2997-3024): delete the `missing.cmemGateway` OAuth branch (3003-3010); replace with `installerError(ABORT, …)` remediation: `The saved openrouter gateway key is missing. Save <key> in ~/.claude-mem/settings.json or pass --provider claude to switch to your Anthropic plan.`

**Step 4: Summary lines (3890-3910)**
- Delete `browserAccountStatus` checkout stages; new mapping:
```ts
const accountStatus = options.providerSource === 'persisted'
  ? 'Kept existing configuration'
  : summaryProvider === 'host' ? 'Not required (host observer)' : 'Not required (local install)';
```

**Step 5: CLI copy**
- index.ts:40 help line → `…codex, gemini and openrouter are bring-your-own providers; a fresh install defaults to the internal model gateway (openrouter transport)`.
- index.ts:148-161 + `installer-provider-choice.ts`: grok-bot implicit default `'cmem'` → the GPUStack default (resolve to `'openrouter'` — the defaults write supplies URL/model); update the doc comment (no installer OAuth).
- Delete `tests/npx-cli/provider-account-gate.test.ts`; rewrite `tests/npx-cli/grok-bot-install-default.test.ts` for the GPUStack openrouter default.

**Step 6: Telemetry allowlist**
- `src/npx-cli/commands/telemetry.ts:93-98`: remove `installer_oauth_started`, `installer_oauth_completed`, `installer_oauth_timeout`, `installer_oauth_start_failed`, `installer_oauth_deferred`, `trial_activated` from the emitted-event allowlist (pairing.ts's own emitters now fire only for teambrain — if its emitters reference the allowlist, keep the four `installer_oauth_*` names but drop `installer_oauth_deferred` + `trial_activated`).
- `src/services/telemetry/scrub.ts:39-54`: drop `installer_oauth_deferred`/`trial_activated`-related entries (`stage` awaiting_login/checkout/approval, `phase` deferred); keep `phase: login/enrollment` only if pairing.ts still sends them (teambrain).
- Rewrite `tests/npx-cli/telemetry-scrub-installer-keys.test.ts` for the trimmed set.

**Step 7: Verify**

Run: `npm run typecheck && bun test tests/npx-cli/ tests/install-non-tty.test.ts`
Expected: failures ONLY in tests listed for later tasks (install-trial-contract, usage-summary) — delete `tests/npx-cli/install-trial-contract.test.ts` and `tests/npx-cli/usage-summary.test.ts` now if they reference deleted symbols (Task 3 finalizes usage-summary).
Fix `tests/install-non-tty.test.ts` (105-114): remove the deferred-sign-in link assertions; `tests/install-merge-settings.test.ts` (66-89): rewrite the corrupt-file test writing plain settings instead of `buildTrialReadySettings`.
Also update `tests/npx-cli/combined-installer-non-tty-boundaries.test.ts` (238-269): a persisted openrouter account keeps working with NO fetch to cmem.ai (this becomes the no-contact test; strengthen its mock fetch to FAIL the run on any request to cmem.ai).

**Step 8: Commit** — `feat(installer): local-only terminal flow (no cmem.ai sign-in, no waitlist)`

---

### Task 3: Delete `usage-summary.ts` wiring

**Files:**
- Delete: `src/npx-cli/install/usage-summary.ts`, `tests/npx-cli/usage-summary.test.ts`
- Modify: `src/npx-cli/commands/install.ts` (import line 31, the usage-summary collection passed to `startInstallerOAuthPairing` call sites — all gone in Task 2; delete any remaining `buildUsageSummary`/`readUsageSummary` references)

**Verify:** `npm run typecheck && bun test tests/npx-cli/` → PASS.
**Commit:** `refactor(installer): drop usage-summary (was only sent with pairing starts)`

---

### Task 4: browser-setup.ts — remove the checkout hand-off

**Files:**
- Modify: `src/npx-cli/install/browser-setup.ts`
- Delete: `tests/npx-cli/browser-setup-checkout.test.ts`, `tests/fixtures/browser-setup-watcher-failure.ts`
- Modify tests: `tests/npx-cli/browser-setup.test.ts` (delete watcher/checkout its 98-237 + sync-restart its 252 if they use checkout), `tests/npx-cli/browser-setup-deadlines.test.ts:77-118`, `tests/npx-cli/browser-setup-choice-race.test.ts` (`'go-kept-existing-pro'` → `'home-ready'`)

**Steps:**
1. Delete `BrowserCheckout` (16-22), `deps.checkout` (74-75), `checkoutPaid` (85-86), the checkout param of `report` (144-154), and the whole checkout loop (212-252) — the wait loop ends at `state.status === 'complete'` (219-220).
2. `settingsChangesNeedingRestart` (259-281): keep cloud-sync keys (At Home still writes them empty); only remove the "On The Go paid" comment/trigger if present.
3. `BACKGROUND_WORK_LABELS['history-import']` (283-286): KEEP — worker-side history import still exists (out of scope); the installer may still wait for a legacy import.

**Verify:** `npm run typecheck && bun test tests/npx-cli/browser-setup*.test.ts` → PASS.
**Commit:** `refactor(installer): remove checkout hand-off from browser setup`

---

### Task 5: Shared funnel contract — `home` only

**Files:**
- Modify: `src/shared/setup-funnel.ts`, `src/shared/setup-state.ts`, `src/npx-cli/install/pairing.ts`
- Test: `tests/telemetry/setup-funnel.test.ts` (prune 'go'/offer cases; keep step/branch validation), new `tests/shared/setup-state-legacy.test.ts`

**pairing.ts addition (from Task 3 quality review):** pairing.ts:22 imports `CLOUD_SYNC_SETUP_CONTRACT`/`SetupCloudSyncOffer` from setup-funnel.ts — deleted in this task, so trim pairing.ts's funnel plumbing here too: the `cloudSyncOffer` option + mutation in `buildInstallerOAuthStartBody` (~310-313), the setupFlowId/cloudSyncOffer opts if unreachable from teambrain, and the parse-side references (~204-207). Wire bodies must stay byte-identical for the teambrain join (which passes neither field).

**Steps:**
1. `setup-funnel.ts`:
   - `SETUP_BRANCHES = ['home']` (line 10). The `SetupBranch` type collapses to `'home'`.
   - Delete `SETUP_CLOUD_SYNC_OFFERS`, `SetupCloudSyncOffer`, `DEFAULT_CLOUD_SYNC_OFFER`, `CLOUD_SYNC_OFFER_TERMS`, `setupCloudSyncOffer` (18-34), `CLOUD_SYNC_SETUP_CONTRACT` (21) — grep first: install.ts:66 imports it for the checkout header; the checkout is gone.
   - `SETUP_INSTALLER_STAGES` (40): `['waiting-for-choice', 'home-ready', 'home-kept-existing', 'failed']` (was `'go-kept-existing-pro'`/`'go-awaiting-checkout'`).
   - Delete `SetupCheckoutState` (47).
   - `SETUP_ACTIONS` (98): remove `'open_checkout'`, `'view_hosted_plans'`. `SETUP_ERRORS` (100): remove `'checkout_failed'`.
   - `SetupEvent` (105-121): remove `cloud_sync_offer`; keep `already_pro` (session plumbing stays).
   - `parseSetupEvent` (127-144): remove the offer check (140); accept `cloud_sync_offer`/legacy keys on OLD events? No — events are live-only; strict is fine. Keep `member(SETUP_BRANCHES, v.branch)` (now `'home'`-only).
   - Keep `SETUP_STEPS` unchanged (wire contract; old telemetry keeps validating). Keep `PRIVATE_WORK_VIEW_URL` only if still referenced after UI tasks — grep in Task 7; otherwise delete here.
2. `setup-state.ts`:
   - `SetupChoice` (18-27): delete `cloudSyncOffer`, `shareWorkView`.
   - Delete `SetupCheckout` (29), `SetupStateFile.checkout` (37), `SetupCheckoutState` re-export (16).
   - `readSetupState` (110-125): drop `checkout` from the returned object; legacy files with `choice.branch === 'go'` pass through untouched (lenient cast already) — consumers branch on 'go' are deleted in Tasks 6-7.
   - `hasProConfiguration` (148-156): broaden for the kept-existing path — `openrouter` + non-empty `CLAUDE_MEM_OPENROUTER_API_KEY` + ANY non-empty `CLAUDE_MEM_OPENROUTER_BASE_URL` (not only `isCmemGatewayUrl`), or configured cloud sync, counts as an existing configuration the funnel must keep (design 4a). Keep the function name and its cmem-gateway tuple detection working.
3. New test `tests/shared/setup-state-legacy.test.ts`:
   - A state file saved by the OLD build (`choice: { branch: 'go', memoryBilling: 'existing', cloudSyncOffer: 'cloud_sync_monthly', chosenAt: … }`) reads back without throwing, `checkout` key ignored.
   - `parseSetupEvent` rejects a `cloud_sync_offer` action event.
   - `hasProConfiguration` still detects the saved gateway tuple.

**Verify:** `npm run typecheck` — expect viewer/worker breakage ONLY in files Tasks 6-7 fix; `bun test tests/shared/ tests/telemetry/setup-funnel.test.ts`.
**Commit:** `feat(setup): collapse funnel contract to the home branch (legacy go states tolerated)`

---

### Task 6: Worker routes — no checkout, no go choices

**Files:**
- Modify: `src/services/worker/http/routes/WorkViewRoutes.ts`
- Tests: `tests/worker/http/routes/setup-state-routes.test.ts` (rewrite go/checkout its: 103, 405, 413, 423, 442, 453, 470, 492, 551, 564), `tests/worker/http/routes/setup-import-routes.test.ts:77` (`branch: 'go'` → `'home'`)

**Steps:**
1. `setupChoiceBody` (362-374): drop `cloud_sync_offer`/`shareWorkView`/`open_checkout` validation — body is `{ branch: 'home', memoryBilling: 'existing' }`-shaped only.
2. `setupInstallerBody` (375-380): drop the `checkout` enum (379).
3. Delete `requestCheckout` handler (1149-1158) + route (951) + the checkout bootstrap in `saveSetupChoice` (1120-1123) + completion rule branch (1160-1174) requiring paid checkout.
4. `saveSetupChoice`/`saveSetupInstaller` persist the new shape; stage `'go-kept-existing-pro'` in any worker mapping → `'home-kept-existing'`.
5. SSE (1947): remove checkout fields from the state view payload.

**Verify:** `npm run typecheck && bun test tests/worker/http/routes/setup-*.test.ts`.
**Commit:** `feat(worker): setup routes accept home-only choices, drop checkout`

---

### Task 7: Viewer setup UI — one card, no trial, no checkout screens

**Files (all under `src/ui/my-work/src/setup/`):**
- Modify: `setup-flow.ts`, `setup-data.ts`, `setup-telemetry.ts`, `setup-sample.ts`, `setup-page.tsx`, `screens/choice-screen.tsx`, `screens/reveal-screen.tsx`, `screens/finish-setup-screen.tsx`, `screens/shared.tsx`
- Delete: `screens/checkout-screen.tsx`, `screens/savings-screen.tsx`
- Modify in-src tests: `setup-flow.test.ts`, `setup-telemetry.test.ts`
- Locale prune: `src/ui/i18n/setup-{ru,fr,ko,zh,pt-BR}.ts` — remove keys used only by deleted screens (checkout/savings/trial/offer/On-The-Go copy; lists in explore map §5)
- Tests: `tests/ui/my-work/setup-step-bar.test.ts` (delete checkout describe 190-258 + helpers 19/38/52), `tests/ui/my-work/setup-flow.browser.test.ts` (rewrite checkout its 285, 320, 353, 368-371)

**Steps:**
1. `setup-flow.ts`: drop `cloudSyncOffer` state (27-31), `needsCheckout`/`canOfferHosted`/`nextAfterChoice` (55-68) — next is always `finish-setup`; `guardStep` (110-117) drops checkout/savings/'go'-import guards; `SETUP_PROGRESS_STEPS`/`PREVIOUS_STEP` keep words for legacy steps (`checkout`, `savings` stay defined — state-machine rule: screens never reach them, words remain).
2. `setup-page.tsx`: alreadyPro (147-151) → skip choice entirely: auto-submit `{ branch: 'home', memoryBilling: 'existing' }` showing "Keeping your existing configuration."; delete `onStartTrial` (336), `openCheckout` (271-277), checkout effects (155-171), go tool filter (158-159, 194); `submitChoice` (183-185, 238-263) without offer/`open_checkout`; `FinishSetupScreen` without `branch` prop gating (346-347).
3. `choice-screen.tsx`: delete the 'go' card (51-71), offers fieldset (87-95), `ORBIT`/`BRANCH_NAMES.go`/`OFFER_LABELS` (19-33); single 'home' card, submit `Use this computer`; home card copy — memory runs on the internal model gateway (replace the 'Your Claude account writes the memories' line; the terminal applies the GPUStack defaults from design 4a).
4. `checkout-screen.tsx`, `savings-screen.tsx`: DELETE; remove their wiring (setup-page 339-344) and `PrivateWorkViewLink` in `shared.tsx` (18-23).
5. `reveal-screen.tsx`: delete `onStartTrial` prop + trial CTA row (186-226, 262, 284).
6. `finish-setup-screen.tsx`: drop `branch` gating (163, 201, 230) — import offer copy stays hidden (history only existed for 'go').
7. `setup-data.ts`: `checkout` (115, 170, 449), `alreadyPro` (119), `choose(...)`/`checkout()` API (145-147), PLAN legacy receipt (464) — prune to home shape.
8. `setup-telemetry.ts`: `VisitState.branch` type narrows; `action(...)` drops `offer` (54-56).
9. Locale prune (ru/fr/ko/zh/pt-BR): delete keys for checkout/savings/trial/offers (grep each deleted English string; e.g. setup-ru.ts 51, 53, 55, 199-201, 400-401).

**Verify:** `npm run typecheck` (viewer included) && `bun test tests/ui/my-work/` && `bun test src/ui/my-work/src/setup/setup-flow.test.ts`.
**Commit:** `feat(setup-ui): home-only funnel (single local card, no trial/checkout screens)`

---

### Task 8: Install-flow tests — honest local coverage

**Files:**
- Delete: `tests/npx-cli/install-trial-contract.test.ts` (TeamBrain-seat cases 742-785 move into `tests/npx-cli/teambrain-command.test.ts` if not already covered)
- New: `tests/npx-cli/install-local-contract.test.ts`

**New tests (TDD — they must FAIL against any regression that reintroduces a cmem.ai call):**
1. `non-interactive install makes no request to cmem.ai`: run the non-TTY install harness (`combined-installer-non-tty-boundaries` pattern) with a fetch mock that THROWS on any URL containing `cmem.ai` → install completes, provider openrouter (GPUStack defaults) when a key is held in env, or ABORT with the env-var remediation when not.
2. `fresh install writes GPUStack defaults into empty settings only`: no persisted provider → settings gain provider openrouter + `https://gpustack.data.lmru.tech/v1` + `glm-5.3-flash`; with `CLAUDE_MEM_OPENROUTER_BASE_URL` in env or an existing non-empty value, the installer leaves it untouched.
3. `reinstall keeps the persisted provider`: persisted `CLAUDE_MEM_PROVIDER=openrouter` + GPUStack base URL + key in settings → run browser-setup applyChoice home → settings unchanged (no `useSubscriptionAuth` wipe), stage `home-kept-existing`.
4. `legacy go setup state is tolerated`: pre-seed `setup-state.json` with old go choice → install resume path completes.
5. `openrouter/gemini without key prompts locally`: interactive harness → password prompt appears, no fetch to cmem.ai.

**Verify:** `bun test tests/npx-cli/install-local-contract.test.ts` → PASS.
**Commit:** `test(installer): local-only install contract coverage`

---

### Task 9: Full suite + stragglers

**Steps:**
1. Grep sweep for orphans: `grep -rn "installer_oauth\\|startInstallerOAuthPairing\\|completeCmemTrialPairing\\|cloud_sync_offer\\|go-kept-existing-pro\\|go-awaiting-checkout\\|SETUP_CLOUD_SYNC_OFFERS\\|buildProviderLabels\\|offerDeferredLogin\\|usage-summary" src/ tests/ docs/` — every hit must be teambrain/pairing.ts/legacy-tolerance or deleted.
2. Docs: `docs/setup-funnel-analytics.md` + `docs/architecture/state-machines.md:42` — update the funnel contract wording (home-only, stages table).
3. Run: `npm test` (fast lane) → fix fallout. Windows baseline: main had 197 pre-existing fast-lane fails — compare counts, no NEW fails.
4. `npm run typecheck && npm run build`.

**Commit:** `docs+chore: funnel contract docs, orphan sweep for local-only install`

---

### Task 10: Bundles, merge, ship

1. `npm run build` → commit regenerated `plugin/` bundles: `build: regenerate plugin bundles (local-only installer)`.
2. Merge `feat/local-install` → `fork/main` (`--no-ff`), push to fork.
3. Rebuild bundles on fork/main if the merge produced conflicts in generated files, commit, push.
4. Bump version for the Artifactory publish (coordinate with user: current 16.1.5-ru.1 → e.g. `16.1.5-local.1`).
5. Install to the live plugin cache + restart worker; verify: `npx claude-mem install` (interactive) opens ONLY the local setup page and never opens cmem.ai; `s3sync status` still works; RU locale intact.

---

## Verification checklist (definition of done)

- [ ] `npm run typecheck` clean (root + viewer)
- [ ] `npm test` fast lane: no NEW failures vs the 197-fail Windows baseline
- [ ] `npm run build` + bundles committed
- [ ] Fresh interactive install: only `http://127.0.0.1:<port>/?setup=1` opens; choosing the single card completes with provider claude
- [ ] Reinstall on the live machine: existing openrouter/gateway config untouched (stage `home-kept-existing`)
- [ ] Non-interactive install with network blackholed for cmem.ai: completes
- [ ] `claude-mem teambrain join` still compiles and its tests pass (pairing.ts preserved)
- [ ] RU locale still renders the setup page (pruned keys gone, no missing-key fallback spam)
