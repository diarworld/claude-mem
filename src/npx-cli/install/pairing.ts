/**
 * The claude-mem sign-in client shared by the installer's terminal flow and
 * `npx claude-mem teambrain join`: start an OAuth pairing on cmem.ai, show the
 * device code, poll until the browser flow answers, and apply what a ready
 * poll delivers (cloud sync connection, memory credentials, plan).
 *
 * The bodies below moved verbatim out of commands/install.ts, which imports
 * them back from here; teambrain joins a team through the same pairing, so
 * trimming the installer's own call sites must not take this client away.
 */

import * as p from '@clack/prompts';
import { styleText } from 'node:util';
import { hostname } from 'os';
import { captureCliEvent } from '../../services/telemetry/cli-telemetry.js';
import { loadTelemetryConfig, resolveTelemetryConsent } from '../../services/telemetry/consent.js';
import { CANONICAL_CLOUD_SYNC_HUB_URL } from '../../shared/SettingsDefaultsManager.js';
import { cmemProOrigin } from '../../shared/cmem-gateway.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { updateSettingsDocument } from '../../shared/settings-document.js';
import { intentCredentialHeaders, readIntentCredentials } from '../../shared/intent-credentials.js';
import { relayedLine } from '../../shared/relayed-text.js';
import { CLOUD_SYNC_SETUP_CONTRACT, isSetupId, type SetupCloudSyncOffer } from '../../shared/setup-funnel.js';
import { parseTeamBrainTeamRef, type TeamBrainTeamRef } from '../../shared/teambrain.js';
import type { DeliveredCmemMemoryCredentials } from '../cmem-memory-credentials.js';
import type { UsageSummary } from './usage-summary.js';

export const isInteractive = process.stdin.isTTY === true;

export const log = {
  info: (msg: string) => isInteractive ? p.log.info(msg) : console.log(`  ${msg}`),
  success: (msg: string) => isInteractive ? p.log.success(msg) : console.log(`  ${msg}`),
  warn: (msg: string) => isInteractive ? p.log.warn(msg) : console.warn(`  ${msg}`),
  error: (msg: string) => isInteractive ? p.log.error(msg) : console.error(`  ${msg}`),
};

/**
 * Merge installer settings into settings.json through the shared settings
 * document boundary. The whole document is kept (a Claude-Code-style `env`
 * wrapper and its root peers survive). An unreadable file is no longer reset
 * to `{}`: it is moved aside to `settings.json.corrupt-<epoch-ms>` (the user's
 * bytes are kept) and a fresh document is written, so a corrupt file can never
 * stop setup or drop the sign-in's memory key. Returns false only when the
 * write itself fails; the worker and hooks refuse-and-report instead. The
 * boundary writes settings.json owner-only from the first byte (it can carry
 * the CMEM Pro setup token and provider API keys).
 */
export function mergeSettings(
  updates: Record<string, string>,
  settingsPath: string = USER_SETTINGS_PATH,
  mutate?: (target: Record<string, unknown>) => void,
): boolean {
  const result = updateSettingsDocument(settingsPath, updates, {}, mutate, { quarantineCorrupt: true });
  if (result.status === 'refused') {
    const reason = result.error instanceof Error ? result.error.message : String(result.error);
    // A quarantined file is moved back when the fresh write fails; quarantinedTo
    // survives only if even that move failed, so say where the bytes are.
    log.error(result.quarantinedTo
      ? `Failed to write settings to ${settingsPath}: ${reason}. Its unreadable previous contents are in ${result.quarantinedTo}.`
      : `Failed to write settings to ${settingsPath}: ${reason}`);
    return false;
  }
  if (result.quarantinedTo) {
    log.warn(`${settingsPath} could not be read, so it was moved to ${result.quarantinedTo} and a fresh settings file was started. Copy back any settings you still need from it.`);
  }
  return true;
}

// --- claude-mem OAuth pairing ----------------------------------------------
// Every installer authenticates through the same GitHub/Google OAuth screen as
// cmem.ai. Login only proves account ownership; provider selection happens
// afterward, and only the CMEM Pro choice continues into trial enrollment.

function nonEmptyTrimmedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Overridable so the OAuth pairing flow can be tested against a dev server. */
const CMEM_PRO_ORIGIN = cmemProOrigin();

/** Starts a terminal/browser pairing without accepting an email address. */
export const CMEM_INSTALLER_OAUTH_START_URL = `${CMEM_PRO_ORIGIN}/api/installer/oauth/start`;

/** Reads authentication and, after Pro selection, enrollment progress. */
export const CMEM_INSTALLER_OAUTH_POLL_URL = `${CMEM_PRO_ORIGIN}/api/pro/trial/poll`;

/** Generic OpenAI-compatible settings used by the CMEM observer. */
export const CMEM_PRO_BASE_URL = `${CMEM_PRO_ORIGIN}/api/inference/v1`;
export const CMEM_PRO_MODEL = 'cmem-observer';

const OAUTH_START_TIMEOUT_MS = 10_000;
const OAUTH_POLL_TIMEOUT_MS = 10_000;
// Fallback budget when the server does not report `expires_in`. The server
// pairing lives 30 minutes; polling past that only yields `gone`.
const OAUTH_POLL_BUDGET_MS = 240_000;
const OAUTH_POLL_BUDGET_MAX_MS = 30 * 60 * 1000;
const OAUTH_DEFAULT_POLL_INTERVAL_S = 3;

type InstallerPollStage = 'awaiting_login' | 'awaiting_checkout' | 'awaiting_approval';
/** `teambrain_seat`: a TeamBrain seat, which grants cloud sync and no CMEM Pro observer. */
type TrialPlan = 'trial' | 'pro' | 'none' | 'teambrain_seat' | 'cloud_sync';
/**
 * What a poll loop waits for. `login` returns once the browser signs in;
 * `enrollment` (CMEM Pro) and `teambrain_join` only once credentials are ready.
 */
export type InstallerPairingPhase = 'login' | 'enrollment' | 'teambrain_join';

export interface InstallerOAuthPairing {
  pairingId: string;
  secret: string;
  userCode: string;
  authorizationUrl: string;
  checkoutUrl: string;
  /** Present only after the server confirms the separate Cloud Sync contract and chosen offer. */
  cloudSyncOffer?: SetupCloudSyncOffer;
  /** Local opt-in, retained with the selected plan across pairing retries. */
  shareWorkView?: true;
  pollIntervalMs: number;
  /**
   * Absolute epoch ms after which polling stops, derived from the server's
   * `expires_in` at parse time and clamped to OAUTH_POLL_BUDGET_MAX_MS.
   * Undefined when the server did not report one (fallback budget applies).
   */
  expiresAt?: number;
  /** Defensive compatibility for a server that returns ready during login. */
  delivered?: TrialReadyResult;
}

function parseBrowserUrl(value: unknown, expectedPath: string): URL | null {
  const candidate = nonEmptyTrimmedString(value);
  if (!candidate) return null;
  try {
    const parsed = new URL(candidate);
    const expectedOrigin = new URL(CMEM_INSTALLER_OAUTH_START_URL).origin;
    if (
      parsed.origin !== expectedOrigin
      || parsed.pathname !== expectedPath
      || parsed.username
      || parsed.password
      || parsed.hash
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function hasExactSearchParams(url: URL, expected: Record<string, string>): boolean {
  const entries = [...url.searchParams.entries()];
  const expectedEntries = Object.entries(expected);
  return entries.length === expectedEntries.length
    && expectedEntries.every(([key, value]) => url.searchParams.get(key) === value);
}

/**
 * The checkout URL must carry exactly `pairing` and `trial`, and nothing else —
 * but the trial LENGTH is not the installer's business to pin.
 *
 * This previously required `trial: '7'` exactly. That made the server unable to
 * change the offer without breaking every installer already published: a
 * `trial=30` URL was rejected outright, surfacing as "Could not start OAuth
 * login" with no hint that the length was the reason. The shape stays strict
 * (both params present, pairing must match, no extras); only the number is now
 * the server's to choose.
 */
function hasPairingAndTrialParams(url: URL, pairingId: string): boolean {
  const entries = [...url.searchParams.entries()];
  if (entries.length !== 2) return false;
  if (url.searchParams.get('pairing') !== pairingId) return false;
  const trial = url.searchParams.get('trial');
  if (trial === null || !/^[0-9]{1,3}$/.test(trial)) return false;
  const days = Number(trial);
  return days >= 1 && days <= 365;
}

/**
 * cmem.ai copies the setup episode the installer sent (`setup_flow_id`) into
 * both claim URLs so checkout can be tied to the setup that started it. The
 * strict shape checks below predate that, so every start that sent an episode
 * was rejected as `bad_body` (#5493). Accept the parameter only when it equals
 * the episode this installer sent, then check the rest of the URL as before.
 * Returns null when the URL carries an episode we did not send.
 */
function withoutEchoedSetupFlowId(url: URL, sentSetupFlowId: string | undefined): URL | null {
  const echoed = url.searchParams.getAll('setup_flow_id');
  if (echoed.length === 0) return url;
  if (echoed.length !== 1 || !sentSetupFlowId || echoed[0] !== sentSetupFlowId) return null;
  const stripped = new URL(url.toString());
  stripped.searchParams.delete('setup_flow_id');
  return stripped;
}

/**
 * Pure parser used by the mock-server contract tests. `sentSetupFlowId` is
 * the `setup_flow_id` this installer put in the start request, if any.
 */
export function parseInstallerOAuthStartBody(body: unknown, sentSetupFlowId?: string, cloudSyncOffer?: SetupCloudSyncOffer): InstallerOAuthPairing | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as {
    pairing_id?: unknown;
    secret?: unknown;
    user_code?: unknown;
    authorization_url?: unknown;
    checkout_url?: unknown;
    poll_interval?: unknown;
    expires_in?: unknown;
    cloud_sync_offer?: unknown;
    cloud_sync_contract?: unknown;
  };
  const pairingId = nonEmptyTrimmedString(b.pairing_id);
  const secret = nonEmptyTrimmedString(b.secret);
  const userCode = nonEmptyTrimmedString(b.user_code);
  const authorizationUrl = parseBrowserUrl(b.authorization_url, '/login');
  const checkoutUrl = parseBrowserUrl(b.checkout_url, '/api/pro/trial/claim');
  if (
    !pairingId
    || !/^[0-9a-f]{32}$/.test(pairingId)
    || !secret
    || !/^[0-9a-f]{48}$/.test(secret)
    || !userCode
    || !/^[A-HJ-KM-NP-TV-Z2-9]{4}-[A-HJ-KM-NP-TV-Z2-9]{4}$/.test(userCode)
    || !authorizationUrl
    || !checkoutUrl
  ) return null;

  const expectedOrigin = new URL(CMEM_INSTALLER_OAUTH_START_URL).origin;
  const loginNext = authorizationUrl.searchParams.get('next');
  if (
    !loginNext
    || !loginNext.startsWith('/')
    || loginNext.startsWith('//')
    || !hasExactSearchParams(authorizationUrl, { next: loginNext })
  ) return null;

  const parsedLoginClaim = parseBrowserUrl(`${expectedOrigin}${loginNext}`, '/api/pro/trial/claim');
  const loginClaim = parsedLoginClaim ? withoutEchoedSetupFlowId(parsedLoginClaim, sentSetupFlowId) : null;
  const checkoutClaim = withoutEchoedSetupFlowId(checkoutUrl, sentSetupFlowId);
  // The browser may echo the product on the login continuation too. If present, both values must match.
  if (cloudSyncOffer && loginClaim?.searchParams.has('product')) {
    if (loginClaim.searchParams.getAll('product').length !== 1 || loginClaim.searchParams.get('product') !== 'cloud_sync'
      || loginClaim.searchParams.getAll('offer').length !== 1 || loginClaim.searchParams.get('offer') !== cloudSyncOffer) return null;
    loginClaim.searchParams.delete('product');
    loginClaim.searchParams.delete('offer');
  }
  const correctCheckout = checkoutClaim && (cloudSyncOffer
    ? b.cloud_sync_contract === CLOUD_SYNC_SETUP_CONTRACT && b.cloud_sync_offer === cloudSyncOffer
      && hasExactSearchParams(checkoutClaim, { pairing: pairingId, product: 'cloud_sync', offer: cloudSyncOffer })
    : b.cloud_sync_contract === undefined && b.cloud_sync_offer === undefined && hasPairingAndTrialParams(checkoutClaim, pairingId));
  if (
    !loginClaim
    || !checkoutClaim
    || !hasExactSearchParams(loginClaim, { pairing: pairingId, login_only: '1' })
    || !correctCheckout
  ) return null;

  const pollIntervalS =
    typeof b.poll_interval === 'number' && Number.isFinite(b.poll_interval) && b.poll_interval > 0
      ? Math.min(Math.max(b.poll_interval, 1), 30)
      : OAUTH_DEFAULT_POLL_INTERVAL_S;

  const expiresAt =
    typeof b.expires_in === 'number' && Number.isFinite(b.expires_in) && b.expires_in > 0
      ? Date.now() + Math.min(b.expires_in * 1000, OAUTH_POLL_BUDGET_MAX_MS)
      : undefined;

  return {
    pairingId,
    secret,
    userCode,
    authorizationUrl: authorizationUrl.toString(),
    checkoutUrl: checkoutUrl.toString(),
    ...(cloudSyncOffer ? { cloudSyncOffer } : {}),
    pollIntervalMs: pollIntervalS * 1000,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

export type OAuthStartFailure = 'http_error' | 'network' | 'timeout' | 'bad_body' | 'credentials';

// Why the most recent startInstallerOAuthPairing() returned null. A closed enum
// for the installer_oauth_start_failed telemetry event — never a URL, status
// text, or error message.
let lastStartFailure: OAuthStartFailure | null = null;
let lastStartErrorMessage: string | null = null;
export function lastOAuthStartFailure(): OAuthStartFailure | null {
  return lastStartFailure;
}
/** User-visible server/configuration details stay out of the telemetry failure enum. */
export function lastOAuthStartErrorMessage(): string | null {
  return lastStartErrorMessage;
}

export type InstallState = 'fresh' | 'update';

/**
 * What this install tells cmem.ai alongside the sign-in start request: whether
 * it ran over an existing install, and the numbers-only local usage summary
 * (see install/usage-summary.ts). Set once by the install command before any
 * pairing starts; both are optional on the wire and omitted when unknown.
 */
let signupContext: { installState?: InstallState; usageSummary?: UsageSummary | null } = {};
export function setInstallerSignupContext(ctx: { installState?: InstallState; usageSummary?: UsageSummary | null }): void {
  signupContext = { ...ctx };
}

/**
 * Pure: the JSON body for POST /api/installer/oauth/start. `teamInvite` is
 * the TeamBrain invite token a `teambrain_join` pairing carries; it travels
 * only in this POST body, never in a URL.
 */
export function buildInstallerOAuthStartBody(
  source: string,
  deviceName: string,
  ctx: { installState?: InstallState; usageSummary?: UsageSummary | null; setupFlowId?: string } = {},
  teamInvite?: string,
): Record<string, unknown> {
  return {
    source,
    device_name: deviceName,
    ...(ctx.installState ? { install_state: ctx.installState } : {}),
    ...(ctx.usageSummary ? { usage_summary: ctx.usageSummary } : {}),
    ...(isSetupId(ctx.setupFlowId) ? { setup_flow_id: ctx.setupFlowId } : {}),
    ...(teamInvite ? { team_invite: teamInvite } : {}),
  };
}

/**
 * Starts an OAuth pairing. The pairing takes no email address or identity from
 * the CLI. The only email the CLI ever sends is the optional opt-in
 * (promptEmailOptIn), which goes to the waitlist and is never used to sign in.
 */
export async function startInstallerOAuthPairing(
  opts: { source?: string; timeoutMs?: number; teamInvite?: string; setupFlowId?: string; cloudSyncOffer?: SetupCloudSyncOffer } = {},
): Promise<InstallerOAuthPairing | null> {
  const source = opts.source ?? 'npx-installer';
  lastStartFailure = null;
  lastStartErrorMessage = null;
  let installHeaders: Record<string, string>;
  try {
    // Bind the already-issued installation at sign-in. An invalid explicit
    // identity must stop here, before any request can create another pairing.
    installHeaders = intentCredentialHeaders(readIntentCredentials());
  } catch (error: unknown) {
    lastStartFailure = 'credentials';
    lastStartErrorMessage = error instanceof Error ? error.message : String(error);
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? OAUTH_START_TIMEOUT_MS);
  const startBody = buildInstallerOAuthStartBody(source, hostname(), {
    ...signupContext,
    ...(isSetupId(opts.setupFlowId) && resolveTelemetryConsent(process.env, loadTelemetryConfig()) ? { setupFlowId: opts.setupFlowId } : {}),
  }, opts.teamInvite);
  if (opts.cloudSyncOffer) {
    startBody.cloud_sync_contract = CLOUD_SYNC_SETUP_CONTRACT;
    startBody.cloud_sync_offer = opts.cloudSyncOffer;
  }
  const sentSetupFlowId = typeof startBody.setup_flow_id === 'string' ? startBody.setup_flow_id : undefined;
  try {
    const response = await fetch(CMEM_INSTALLER_OAUTH_START_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...installHeaders },
      body: JSON.stringify(startBody),
      signal: controller.signal,
    });
    if (!response.ok) {
      lastStartFailure = 'http_error';
      try {
        const body: unknown = await response.json();
        if (body && typeof body === 'object') {
          lastStartErrorMessage = nonEmptyTrimmedString((body as { message?: unknown }).message);
        }
      } catch (error: unknown) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
      }
      // Without a server-supplied message, at least name the HTTP answer
      // (#5493): the caller's fallback says "when cmem.ai is reachable", which
      // sent a user with an HTTP 429 refusal hunting for a network problem.
      if (!lastStartErrorMessage) {
        lastStartErrorMessage = `cmem.ai answered HTTP ${response.status}`;
      }
      return null;
    }
    // A 2xx with unparseable JSON is a server-response problem, not a
    // connection failure; keep it out of the `network` bucket.
    let body: unknown;
    try {
      body = await response.json();
    } catch (error: unknown) {
      // The request timer can fire while the body is still streaming; that is
      // the same timeout as a stalled connect, not a malformed response.
      lastStartFailure = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'bad_body';
      return null;
    }
    const pairing = parseInstallerOAuthStartBody(body, sentSetupFlowId, opts.cloudSyncOffer);
    if (!pairing) {
      lastStartFailure = 'bad_body';
      if (opts.cloudSyncOffer) lastStartErrorMessage = 'cmem.ai did not confirm the selected standalone Cloud Sync offer. No bundled checkout was opened. Update Claude-Mem and retry.';
    }
    return pairing;
  } catch (error: unknown) {
    lastStartFailure = error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network';
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Everything a ready poll delivers. The memory credentials are staged before
 * provider activation so one-shot delivery cannot be lost after enrollment.
 */
export interface TrialReadyResult {
  userId: string;
  setupToken: string;
  hubUrl: string;
  /**
   * The CMEM Pro observer credentials, or null when the server sent none: a
   * sync-only account (Cloud Sync or a TeamBrain seat), which keeps its own observer.
   */
  memory: DeliveredCmemMemoryCredentials | null;
  plan: TrialPlan;
  trialEndsAt: string | null;
  /** The TeamBrain team a `teambrain_join` pairing joined, when the server names it. */
  team: TeamBrainTeamRef | null;
  /** Where that team's TeamBrain API lives, when the server says. */
  teambrainUrl: string | null;
}

/**
 * The cloud sync connection every ready poll delivers, seat or Pro: the keys
 * the worker's CloudSync reads, and nothing for the observer. A new pairing
 * starts a new device (CloudSync mints the id on its next start).
 */
export function buildSyncConnectionSettings(
  result: Pick<TrialReadyResult, 'userId' | 'setupToken' | 'hubUrl'>,
  deviceName: string = hostname(),
): Record<string, string> {
  return {
    CLAUDE_MEM_CLOUD_SYNC_TOKEN: result.setupToken,
    CLAUDE_MEM_CLOUD_SYNC_USER_ID: result.userId,
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: result.hubUrl,
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '',
    CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: deviceName,
  };
}

export function buildTrialReadySettings(
  result: TrialReadyResult,
  deviceName: string = hostname(),
): Record<string, string> {
  const syncConnection = buildSyncConnectionSettings(result, deviceName);
  // Without memory credentials there is no CMEM Pro observer to stage, so only
  // the sync connection is written. The provider, a key staged by an earlier
  // pairing and the fallback marker all stay as they are.
  if (!result.memory) return syncConnection;
  return {
    ...syncConnection,
    CLAUDE_MEM_PRO_TRIAL_STATE: 'active',
    CLAUDE_MEM_PRO_TRIAL_ENDS_AT: result.trialEndsAt ?? '',
    CLAUDE_MEM_PRO_PLAN: result.plan,
    CLAUDE_MEM_PRO_MEMORY_KEY: result.memory.memoryKey,
    CLAUDE_MEM_PRO_MEMORY_BASE_URL: result.memory.memoryBaseUrl,
    CLAUDE_MEM_PRO_MEMORY_MODEL: result.memory.memoryModel,
    CLAUDE_MEM_PRO_FALLBACK_AT: '',
  };
}

export function parseTrialReadyBody(body: unknown): TrialReadyResult | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as {
    status?: unknown;
    user_id?: unknown;
    setup_token?: unknown;
    hub_url?: unknown;
    memory_key?: unknown;
    memory_base_url?: unknown;
    memory_model?: unknown;
    plan?: unknown;
    trial?: { ends_at?: unknown };
    team?: unknown;
    teambrain_url?: unknown;
  };
  const userId = nonEmptyTrimmedString(b.user_id);
  const setupToken = nonEmptyTrimmedString(b.setup_token);
  const hubUrl = nonEmptyTrimmedString(b.hub_url);
  if (b.status !== 'ready' || !userId || !setupToken || !hubUrl) return null;

  // Observer credentials come from the server or not at all. A body without a
  // memory key is a sync-only account: nothing may stand in for the key, since
  // the setup token is no gateway key and the gateway refuses an account that
  // is not Pro. Filling it in pointed a seat member's observer at a gateway
  // that turns them away.
  const memoryKey = nonEmptyTrimmedString(b.memory_key);
  return {
    userId,
    setupToken,
    hubUrl,
    memory: memoryKey
      ? {
          memoryKey,
          memoryBaseUrl: nonEmptyTrimmedString(b.memory_base_url) ?? CMEM_PRO_BASE_URL,
          memoryModel: nonEmptyTrimmedString(b.memory_model) ?? CMEM_PRO_MODEL,
        }
      : null,
    plan: b.plan === 'trial' || b.plan === 'pro' || b.plan === 'none' || b.plan === 'teambrain_seat' || b.plan === 'cloud_sync' ? b.plan : 'trial',
    trialEndsAt: nonEmptyTrimmedString(b.trial?.ends_at),
    team: parseTeamBrainTeamRef(b.team),
    teambrainUrl: nonEmptyTrimmedString(b.teambrain_url),
  };
}

export type InstallerPollOutcome =
  | { kind: 'authenticated'; userId: string }
  | { kind: 'pending'; stage: InstallerPollStage }
  | ({ kind: 'ready' } & TrialReadyResult)
  /** The server refused a TeamBrain join (team full, invite no longer valid, ...): final. */
  | { kind: 'join_failed'; reason: string; message: string | null }
  | { kind: 'gone' }
  | { kind: 'unreachable' };

/** What to say for a refused join when the server sent no words of its own. */
const JOIN_FAILED_FALLBACKS: Record<string, string> = {
  team_full: 'the team has no free seat. Ask its owner to add one.',
  invite_invalid: 'the invite is no longer valid. Ask the team owner for a new invite link.',
  team_inactive: 'the team is not active.',
  not_a_member: 'this account is not a member of the team.',
};

/** One line for a refused join: the server's own words when it sent them, and its reason code. */
export function joinFailedMessage(outcome: { reason: string; message: string | null }): string {
  const said = relayedLine(outcome.message) || JOIN_FAILED_FALLBACKS[outcome.reason] || 'cmem.ai refused the join.';
  const reason = relayedLine(outcome.reason);
  return `Could not join the team: ${said}${reason && reason !== 'unknown' ? ` (${reason})` : ''}`;
}

async function pollInstallerPairingOnce(pairing: InstallerOAuthPairing): Promise<InstallerPollOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(CMEM_INSTALLER_OAUTH_POLL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairing_id: pairing.pairingId, secret: pairing.secret }),
      signal: controller.signal,
    });

    const body = await response.json().catch(() => ({})) as {
      status?: unknown;
      stage?: unknown;
      user_id?: unknown;
      reason?: unknown;
      error?: unknown;
    };
    // A refused TeamBrain join also answers 410, so it is told apart from an
    // expired pairing by its body: at sign-in or at device approval, the
    // server says why (team_full, invite_invalid, team_inactive, not_a_member).
    if (body.status === 'join_failed') {
      return {
        kind: 'join_failed',
        reason: nonEmptyTrimmedString(body.reason) ?? 'unknown',
        message: nonEmptyTrimmedString(body.error),
      };
    }
    if (response.status === 404 || response.status === 410) return { kind: 'gone' };
    if (response.status === 202) {
      const stage: InstallerPollStage =
        body.stage === 'awaiting_checkout' || body.stage === 'awaiting_approval'
          ? body.stage
          : 'awaiting_login';
      return { kind: 'pending', stage };
    }
    if (response.ok && body.status === 'authenticated') {
      const userId = nonEmptyTrimmedString(body.user_id);
      return userId ? { kind: 'authenticated', userId } : { kind: 'unreachable' };
    }
    if (response.ok) {
      const ready = parseTrialReadyBody(body);
      return ready ? { kind: 'ready', ...ready } : { kind: 'unreachable' };
    }
    return { kind: 'unreachable' };
  } catch {
    return { kind: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

function sleepUnlessCancelled(ms: number, isCancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (isCancelled() || Date.now() - startedAt >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
  });
}

export async function waitForInstallerPairing(
  pairing: InstallerOAuthPairing,
  phase: InstallerPairingPhase,
  version: string,
): Promise<InstallerPollOutcome | null> {
  const startedAt = Date.now();
  const rerun = phase === 'teambrain_join' ? 'Run npx claude-mem teambrain join again'
    : phase === 'enrollment' && pairing.cloudSyncOffer ? 'Reopen Cloud Sync setup in your installer tab for a fresh code'
      : 'Run the installer again';
  // The login phase must never name CMEM Pro. Logging in is required of every
  // user and happens BEFORE the provider choice, so naming a paid plan here
  // reads as an upsell attached to a mandatory step and muddies the funnel.
  // The poll loop prints whatever stage the server reports, so a server-side
  // 'awaiting_checkout' during login would otherwise leak the Pro wording.
  // A TeamBrain join is neither: the server is adding this account to a team.
  const stageMessages: Record<InstallerPollStage, string> = {
    awaiting_login: phase === 'teambrain_join'
      ? 'Waiting for you to sign in in the browser…'
      : 'Waiting for OAuth login in the browser…',
    awaiting_checkout: phase === 'login'
      ? 'Waiting for the browser to finish signing you in…'
      : phase === 'teambrain_join'
        ? 'Waiting for the browser to finish joining the team…'
        : pairing.cloudSyncOffer ? 'Waiting for Cloud Sync setup in the browser…' : 'Waiting for CMEM Pro setup in the browser…',
    // A join's invite is redeemed at device approval, on a page that names the team.
    awaiting_approval: phase === 'teambrain_join'
      ? `Approve this device on the page (code ${pairing.userCode}) to join the team…`
      : `Enter code ${pairing.userCode} in the browser to approve this device…`,
  };
  let stage: InstallerPollStage = phase === 'enrollment' ? 'awaiting_checkout' : 'awaiting_login';
  log.info(stageMessages[stage]);

  let cancelled = false;
  const onStdinData = (chunk: Buffer | string): void => {
    if (typeof chunk === 'string' ? chunk.includes('\x03') : chunk.includes(0x03)) cancelled = true;
  };
  const onSigint = (): void => {
    cancelled = true;
  };
  const useRawInput = process.stdin.isTTY === true;
  const stdinWasRaw = process.stdin.isRaw === true;
  let changedRawMode = false;
  if (useRawInput) {
    process.stdin.on('data', onStdinData);
    if (!stdinWasRaw) {
      process.stdin.setRawMode(true);
      changedRawMode = true;
    }
    process.stdin.resume();
  }
  process.on('SIGINT', onSigint);

  try {
    let consecutiveFailures = 0;
    // The deadline belongs to the pairing, not the phase: login and enrollment
    // share one pairing, so both poll until the server's own expiry.
    const deadline = pairing.expiresAt ?? (startedAt + OAUTH_POLL_BUDGET_MS);
    while (Date.now() < deadline) {
      if (cancelled) return null;
      const result = await pollInstallerPairingOnce(pairing);
      if (cancelled) return null;

      if (result.kind === 'authenticated' && phase === 'login') return result;
      if (result.kind === 'ready') return result;
      if (result.kind === 'join_failed') {
        log.error(joinFailedMessage(result));
        return null;
      }
      if (result.kind === 'gone') {
        log.error(`This browser authorization expired. ${rerun}.`);
        return null;
      }
      if (result.kind === 'unreachable') {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) {
          log.error(`cmem.ai is not responding. ${rerun} when it is reachable.`);
          return null;
        }
      } else {
        consecutiveFailures = 0;
        if (result.kind === 'pending' && result.stage !== stage) {
          stage = result.stage;
          log.info(stageMessages[stage]);
        }
      }
      await sleepUnlessCancelled(pairing.pollIntervalMs, () => cancelled);
    }

    // The telemetry `phase` enum is the installer's (login / enrollment /
    // deferred); a TeamBrain join is not reported.
    if (phase !== 'teambrain_join') {
      await captureCliEvent('installer_oauth_timeout', {
        version,
        phase,
        duration_ms: Date.now() - startedAt,
      });
    }
    log.error(`Browser authorization timed out. ${rerun}.`);
    return null;
  } finally {
    process.off('SIGINT', onSigint);
    if (useRawInput) {
      process.stdin.off('data', onStdinData);
      if (changedRawMode) process.stdin.setRawMode(false);
      process.stdin.pause();
    }
  }
}

/** A Cloud-only intent must never stage or activate a customer's separate hosted memory credentials. */
export function pairingAcceptsReady(pairing: InstallerOAuthPairing, ready: TrialReadyResult): boolean {
  if (!pairing.cloudSyncOffer || (ready.plan === 'cloud_sync' && !ready.memory)) return true;
  log.error('The account did not return the selected Cloud Sync connection. Your existing memory provider was kept.');
  return false;
}

/**
 * Apply the new Work View choice only after the owner has approved this device.
 * The hub's independent work_state capability still gates every reserved record.
 */
export function saveReadyPairing(pairing: InstallerOAuthPairing, result: TrialReadyResult): boolean {
  const selectedWorkView = pairing.cloudSyncOffer && pairing.shareWorkView && result.plan === 'cloud_sync' && !result.memory;
  const canonicalHub = result.hubUrl.replace(/\/+$/, '') === CANONICAL_CLOUD_SYNC_HUB_URL;
  const configuredHub = process.env.CLAUDE_MEM_CLOUD_SYNC_HUB_URL;
  return mergeSettings(buildTrialReadySettings(result), USER_SETTINGS_PATH, target => {
    if (selectedWorkView && canonicalHub && (configuredHub === undefined || configuredHub.replace(/\/+$/, '') === CANONICAL_CLOUD_SYNC_HUB_URL)
      && process.env.CLAUDE_MEM_WORK_VIEW_SHARED_STATE === undefined
      && (target.CLAUDE_MEM_WORK_VIEW_SHARED_STATE === undefined || target.CLAUDE_MEM_WORK_VIEW_SHARED_STATE === '')) {
      target.CLAUDE_MEM_WORK_VIEW_SHARED_STATE = 'true';
    }
  });
}

/** Required account step. OAuth completes before provider choice and never chooses a paid provider. */
export async function completeInstallerOAuthLogin(
  pairing: InstallerOAuthPairing,
  version: string,
): Promise<boolean> {
  const result = await waitForInstallerPairing(pairing, 'login', version);
  if (!result) return false;
  if (result.kind === 'ready') {
    if (!pairingAcceptsReady(pairing, result)) return false;
    if (!saveReadyPairing(pairing, result)) return false;
    pairing.delivered = result;
  }
  log.success('OAuth login complete.');
  await captureCliEvent('installer_oauth_completed', { version });
  return result.kind === 'authenticated' || result.kind === 'ready';
}

export function noteDeviceCode(
  pairing: InstallerOAuthPairing,
  instruction: string = 'Enter this code in the browser to approve this device.',
): void {
  const message = [
    styleText(['bold', 'cyan'], pairing.userCode),
    '',
    instruction,
  ].join('\n');
  if (isInteractive) p.note(message, 'Your device code');
  else log.info(`Device code: ${pairing.userCode}`);
}
