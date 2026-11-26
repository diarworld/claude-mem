/**
 * The claude-mem sign-in client for `npx claude-mem teambrain join`: start an
 * OAuth pairing on cmem.ai, show the device code, poll until the browser flow
 * answers, and apply what a ready poll delivers (cloud sync connection,
 * memory credentials, plan).
 *
 * The bodies below moved verbatim out of commands/install.ts, which no longer
 * imports them; teambrain joins a team through the same pairing, so trimming
 * the installer's own call sites must not take this client away.
 */

import * as p from '@clack/prompts';
import { styleText } from 'node:util';
import { hostname } from 'os';
import { captureCliEvent } from '../../services/telemetry/cli-telemetry.js';
import { cmemProOrigin } from '../../shared/cmem-gateway.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { intentCredentialHeaders, readIntentCredentials } from '../../shared/intent-credentials.js';
import { relayedLine } from '../../shared/relayed-text.js';
import { parseTeamBrainTeamRef, type TeamBrainTeamRef } from '../../shared/teambrain.js';
import type { DeliveredCmemMemoryCredentials } from '../cmem-memory-credentials.js';
import { isInteractive, log } from './cli-io.js';
import { mergeSettings } from './settings-io.js';

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
 * cmem.ai used to copy the setup episode the installer sent (`setup_flow_id`) into both claim URLs. This build sends
 * no episode, so a claim URL that still carries one is not ours: reject it rather than check a shape we cannot match.
 * Returns null when the URL names any episode.
 */
function withoutEchoedSetupFlowId(url: URL): URL | null {
  if (url.searchParams.getAll('setup_flow_id').length === 0) return url;
  return null;
}

/**
 * Pure parser used by the mock-server contract tests.
 */
export function parseInstallerOAuthStartBody(body: unknown): InstallerOAuthPairing | null {
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
  const loginClaim = parsedLoginClaim ? withoutEchoedSetupFlowId(parsedLoginClaim) : null;
  const checkoutClaim = withoutEchoedSetupFlowId(checkoutUrl);
  // The standalone Cloud Sync contract is gone from this client: a server answering with its offer fields, or a
  // checkout claim naming a product/offer, is not the plain Pro checkout this parser accepts.
  const correctCheckout = checkoutClaim && b.cloud_sync_contract === undefined && b.cloud_sync_offer === undefined
    && hasPairingAndTrialParams(checkoutClaim, pairingId);
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

/**
 * Pure: the JSON body for POST /api/installer/oauth/start. `teamInvite` is
 * the TeamBrain invite token a `teambrain_join` pairing carries; it travels
 * only in this POST body, never in a URL.
 */
export function buildInstallerOAuthStartBody(
  source: string,
  deviceName: string,
  teamInvite?: string,
): Record<string, unknown> {
  return {
    source,
    device_name: deviceName,
    ...(teamInvite ? { team_invite: teamInvite } : {}),
  };
}

/**
 * Starts an OAuth pairing. The pairing takes no email address or identity from
 * the CLI: the terminal asks for nothing, and the browser signs in directly.
 */
export async function startInstallerOAuthPairing(
  opts: { source?: string; timeoutMs?: number; teamInvite?: string } = {},
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
  const startBody = buildInstallerOAuthStartBody(source, hostname(), opts.teamInvite);
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
    const pairing = parseInstallerOAuthStartBody(body);
    if (!pairing) {
      lastStartFailure = 'bad_body';
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
  const rerun = phase === 'teambrain_join' ? 'Run npx claude-mem teambrain join again' : 'Run the installer again';
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
        : 'Waiting for CMEM Pro setup in the browser…',
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

/**
 * Apply the new Work View choice only after the owner has approved this device.
 * The hub's independent work_state capability still gates every reserved record.
 *
 * The standalone Cloud Sync offer (and with it the Work View opt-in this
 * function once applied) is gone from this client, so a ready pairing only
 * writes the account's own connection settings.
 */
export function saveReadyPairing(result: TrialReadyResult): boolean {
  return mergeSettings(buildTrialReadySettings(result), USER_SETTINGS_PATH);
}

/** Required account step. OAuth completes before provider choice and never chooses a paid provider. */
export async function completeInstallerOAuthLogin(
  pairing: InstallerOAuthPairing,
  version: string,
): Promise<boolean> {
  const result = await waitForInstallerPairing(pairing, 'login', version);
  if (!result) return false;
  if (result.kind === 'ready') {
    if (!saveReadyPairing(result)) return false;
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
