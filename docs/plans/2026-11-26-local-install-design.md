# Local-only installer: remove all cmem.ai sign-in logic from install

- **Date:** 2026-11-26
- **Status:** Approved (user confirmed "да, верно")
- **Scope:** Fork-only change on `feat/local-install` (from `fork/main` 49519e720). This touches the hosted-service boundary (`src/npx-cli/commands/install.ts`, sign-in and activation steps), so it must NOT be offered upstream.
- **Problem:** When installing claude-mem, the installer opens the cmem.ai authorization page (browser OAuth/checkout). In the target environment the hosted service is not wanted: the install must be fully local.

## Goal

`npx claude-mem install` (and `update`) never contacts cmem.ai and never opens it: no OAuth pairing, no checkout, no cloud "On The Go" branch in the setup GUI. The install is fully local. An existing configured install must survive reinstall/update with its provider configuration intact.

## Current cmem.ai touch points (to remove)

1. **Terminal flow** (`src/npx-cli/commands/install.ts`):
   - `requireInstallerOAuthLogin` → `openBrowser(pairing.authorizationUrl)` (cmem.ai login page).
   - `completeCmemTrialPairing` → `openBrowser(pairing.checkoutUrl)` (checkout page).
   - Gate `providerNeedsAccount` runs the login up front for `codex|gemini|openrouter` and for the CMEM Pro prompt choice.
   - `offerDeferredLogin` (non-interactive): starts a pairing against cmem.ai and prints the link. Never opens a browser but still contacts the host.
   - `completeUpdateProviderSetup` cmemGateway branch repairs a missing key via OAuth login.
2. **GUI funnel** (browser setup):
   - Choice screen offers "On The Go" (`branch: 'go'`); picking it starts `startOnTheGoPairing` and the checkout hand-off opens cmem.ai.
   - `applyChoice` 'go' branch, `deps.checkout` (`BrowserCheckout`), `startOnTheGoPairing`, `activateBrowserEnrollment`.
   - `setup-page.tsx` defaults an alreadyPro machine to `branch: 'go'` (keep-existing-plan); this is the only thing protecting an existing Pro config on reinstall.
3. **Shared funnel types** (`src/shared/setup-funnel.ts`): `SETUP_BRANCHES = ['home','go']`, `SETUP_CLOUD_SYNC_OFFERS`, `DEFAULT_CLOUD_SYNC_OFFER`, `CLOUD_SYNC_OFFER_TERMS`, `cloud_sync_offer` on choices.
4. **Modules**: `src/npx-cli/install/usage-summary.ts` (usage summary sent with each pairing start), OAuth pairing functions in `install.ts`.

## Design

### 1. Terminal flow (`install.ts`)

- `promptProvider`: remove the `cmem` option and the whole CMEM Pro branch (`completeCmemTrialPairing`, `resolveCmemMemoryCredentials` promotion, `buildProviderLabels` cmem labels). Remaining choices: `claude` (default, logged-in Anthropic plan) and explicit flags `codex|gemini|openrouter|host`.
- Replace the `providerNeedsAccount` login gate with a local key check:
  - `gemini` / `openrouter` without a held key → local interactive prompt "Paste your API key" (reuse the existing password-prompt pattern from `completeUpdateProviderSetup`); non-interactive keeps the existing ABORT validation.
  - `claude` / `host` / `codex` → nothing.
- `completeUpdateProviderSetup`: drop the `cmemGateway` OAuth repair branch; instead a clear error tells the user to keep the persisted key or switch with `--provider claude`.
- `offerDeferredLogin`: deleted entirely.
- `requireInstallerOAuthLogin`, `startInstallerOAuthPairing`, `completeCmemTrialPairing`, `startOnTheGoPairing`, `activateBrowserEnrollment`, `noteDeviceCode`, `waitForReturnToOpenBrowser` (if no remaining callers): deleted.
- Copy: `index.ts` help line about cmem.ai sign-in; "Skipping claude-mem login" messages reworded. Passive text links (installer summary) are intentionally left: they open nothing.

### 2. GUI funnel

- `setup-funnel.ts`: `SETUP_BRANCHES = ['home']`. Parsing of saved states still accepts legacy `branch: 'go'` and treats it as "keep existing configuration" so a live install is not broken by the upgrade. Cloud-sync offer types and validation removed.
- `browser-setup.ts`: `BrowserCheckout` and the checkout loop removed; `applyChoice` home branch keeps a persisted provider (`providerSource: 'persisted'`) instead of forcing `claude` (today `useSubscriptionAuth()` would wipe a Pro config).
- Viewer UI:
  - `choice-screen.tsx`: only the "This computer" card remains.
  - `setup-page.tsx`: no `onStartTrial`, no auto-'go' for alreadyPro; alreadyPro goes straight to home keeping the existing config.
  - `finish-setup-screen.tsx`: `branch === 'go'` conditionals removed.
  - Locale files keep now-unused keys (harmless); no locale churn.

### 3. Deleted modules

- `src/npx-cli/install/usage-summary.ts` and its tests.
- All installer OAuth tests: `install-trial-contract.test.ts`, `browser-setup-checkout.test.ts`, `provider-account-gate.test.ts`, `usage-summary.test.ts`, `telemetry/setup-funnel.test.ts`; go-branch cases inside `browser-setup*.test.ts` and `install-update-keeps-provider.test.ts`.

### 4. Out of scope

- `teambrain join` (explicit command that opens cmem.ai by user action).
- Worker-side cloud sync.
- Viewer/header cmem.ai notices outside the installer.

### 5. New tests

- Home branch preserves a persisted provider on reinstall (config not wiped).
- Non-interactive install completes with no network access to cmem.ai (no pairing start attempted).
- Local key prompt path for `gemini`/`openrouter` with missing key.
- Legacy saved state with `branch: 'go'` parses and maps to keep-existing.

### 6. Verification

- `npm test` (fast lane), root typecheck, viewer typecheck, `npm run build`, commit bundles — the standard fork cycle before publishing to Artifactory.
