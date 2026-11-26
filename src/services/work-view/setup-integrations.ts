/**
 * The setup page's integrations step (the choice screen's GPUStack and S3
 * blocks): validate what the browser submitted, then write it where it lives.
 *
 * Two destinations, one request:
 *  - settings.json — the GPUStack provider tuple (key written only when
 *    submitted; endpoint/model filled by the same rule the terminal installer
 *    uses, shared/gpustack-defaults.ts) and the four S3 Sync settings keys.
 *  - ~/.claude-mem/.env — the S3 bucket credentials (S3_SYNC_ACCESS_KEY_ID,
 *    S3_SYNC_SECRET_ACCESS_KEY), through saveClaudeMemEnv's whitelist.
 *
 * The worker route (WorkViewRoutes POST /api/setup/integrations) owns the
 * loopback/origin guards and the zod body; this module owns the rules and the
 * writes, so they are unit-testable without the server.
 */

import { SettingsDefaultsManager } from '../../shared/SettingsDefaultsManager.js';
import { updateSettingsDocument } from '../../shared/settings-document.js';
import { saveClaudeMemEnv } from '../../shared/EnvManager.js';
import { gpustackDefaultUpdates } from '../../shared/gpustack-defaults.js';
import type { SetupStateView } from '../../shared/setup-state.js';
import { logger } from '../../utils/logger.js';

/** What the choice screen's integrations blocks submit. Absent fields mean "leave as they are". */
export interface SetupIntegrationsRequest {
  /** The GPUStack (OpenRouter-shaped) gateway key. Written only when submitted. */
  gpuStackApiKey?: string;
  /**
   * The gateway endpoint the key will be sent to. The form prefills the
   * stored value or the GPUStack default, so a first save writes it
   * explicitly — a key must never ride a base URL this machine did not choose.
   */
  gpuStackEndpoint?: string;
  s3Sync?: {
    enabled: boolean;
    /** The S3 endpoint; always sent (the form prefills the stored default). */
    endpoint?: string;
    bucket?: string;
    region?: string;
    /** Bucket credentials. Sent only when the person typed them; empty fields never blank stored keys. */
    accessKeyId?: string;
    secretAccessKey?: string;
  };
}

/** Where the settings write lands (injectable for tests; the .env write resolves its own path). */
export interface SetupIntegrationsPaths {
  settingsPath: string;
}

/** What the person will see on the form, as GET /api/settings shows it (environment overrides applied). */
export type SetupIntegrationsView = NonNullable<SetupStateView['integrations']>;

/** The S3 settings keys this step owns. */
const S3_SETTING_KEYS = [
  'CLAUDE_MEM_S3_SYNC_ENABLED',
  'CLAUDE_MEM_S3_SYNC_ENDPOINT',
  'CLAUDE_MEM_S3_SYNC_BUCKET',
  'CLAUDE_MEM_S3_SYNC_REGION',
] as const;

/**
 * Why the submission cannot be applied, in plain words, or null when it can.
 * An enabled S3 block needs an endpoint and a bucket, and bucket credentials
 * either submitted now or already stored in ~/.claude-mem/.env — a sync
 * enabled without them would only fail every tick.
 */
export function validateSetupIntegrations(
  request: SetupIntegrationsRequest,
  storedEnv: { S3_SYNC_ACCESS_KEY_ID?: string; S3_SYNC_SECRET_ACCESS_KEY?: string },
): string | null {
  const s3 = request.s3Sync;
  if (!s3?.enabled) return null;
  const endpoint = s3.endpoint?.trim() ?? '';
  if (!/^https?:\/\/.+/.test(endpoint)) return 'The S3 endpoint must be an http(s) URL.';
  if (!s3.bucket?.trim()) return 'The S3 bucket name is required.';
  const hasCredsNow = !!s3.accessKeyId?.trim() && !!s3.secretAccessKey?.trim();
  const hasCredsStored = !!storedEnv.S3_SYNC_ACCESS_KEY_ID?.trim() && !!storedEnv.S3_SYNC_SECRET_ACCESS_KEY?.trim();
  if (!hasCredsNow && !hasCredsStored) return 'The bucket access key and secret key are required.';
  return null;
}

/** The values the choice screen prefills, read from the same files the worker serves (read-only: never creates the file). */
export function readSetupIntegrationsView(settingsPath: string): SetupIntegrationsView {
  const settings = SettingsDefaultsManager.loadFromFile(settingsPath, true, { readOnly: true });
  const masked = SettingsDefaultsManager.loadFromFile(settingsPath, false, { readOnly: true });
  const mask = (value: unknown): string => {
    if (typeof value !== 'string' || value === '') return '';
    return value.length <= 4 ? '*'.repeat(value.length) : `${'*'.repeat(value.length - 4)}${value.slice(-4)}`;
  };
  const baseUrl = typeof settings.CLAUDE_MEM_OPENROUTER_BASE_URL === 'string' && settings.CLAUDE_MEM_OPENROUTER_BASE_URL.trim()
    ? settings.CLAUDE_MEM_OPENROUTER_BASE_URL.trim()
    : '';
  return {
    openRouterKeyMasked: mask(masked.CLAUDE_MEM_OPENROUTER_API_KEY),
    openRouterBaseUrl: baseUrl,
    s3: {
      enabled: settings.CLAUDE_MEM_S3_SYNC_ENABLED === 'true',
      endpoint: typeof settings.CLAUDE_MEM_S3_SYNC_ENDPOINT === 'string' ? settings.CLAUDE_MEM_S3_SYNC_ENDPOINT : '',
      bucket: typeof settings.CLAUDE_MEM_S3_SYNC_BUCKET === 'string' ? settings.CLAUDE_MEM_S3_SYNC_BUCKET : '',
      region: typeof settings.CLAUDE_MEM_S3_SYNC_REGION === 'string' ? settings.CLAUDE_MEM_S3_SYNC_REGION : '',
    },
  };
}

export interface SetupIntegrationsOutcome {
  /** Whether the gateway key was written (false when the request carried none). */
  openrouterKeySaved: boolean;
  /** The settings keys actually written. */
  settingsWritten: string[];
  /** Whether the bucket credentials were written to ~/.claude-mem/.env. */
  s3CredentialsSaved: boolean;
}

/**
 * Apply a validated submission. Settings keys an environment variable already
 * owns are skipped without error (the variable is that value's only source,
 * and a written copy would outlive it — the same rule POST /api/settings
 * applies), and the credentials file is only touched when the request names
 * new values.
 */
export function applySetupIntegrations(
  request: SetupIntegrationsRequest,
  paths: SetupIntegrationsPaths,
): SetupIntegrationsOutcome {
  const outcome: SetupIntegrationsOutcome = { openrouterKeySaved: false, settingsWritten: [], s3CredentialsSaved: false };
  const persisted = SettingsDefaultsManager.loadFromFile(paths.settingsPath, false);
  const shipped = SettingsDefaultsManager.getAllDefaults() as unknown as Record<string, unknown>;

  const updates: Record<string, string> = {};
  const requestKey = request.gpuStackApiKey?.trim();
  const requestEndpoint = request.gpuStackEndpoint?.trim();
  if (requestKey) {
    updates.CLAUDE_MEM_OPENROUTER_API_KEY = requestKey;
    // The same fill rule the terminal installer applies (gpustack-defaults.ts):
    // provider, endpoint and model only into keys still empty or at their
    // shipped default — a chosen value is never overwritten.
    const defaults = gpustackDefaultUpdates(persisted, shipped);
    if (defaults) Object.assign(updates, defaults);
  }
  // An explicit endpoint from the form wins over the fill default: the person
  // sees the URL the key will be sent to and can point at a different gateway.
  // It still never lands on disk while an environment variable owns the key.
  if (requestEndpoint) updates.CLAUDE_MEM_OPENROUTER_BASE_URL = requestEndpoint;

  const s3 = request.s3Sync;
  if (s3) {
    updates.CLAUDE_MEM_S3_SYNC_ENABLED = s3.enabled ? 'true' : 'false';
    if (s3.endpoint?.trim()) updates.CLAUDE_MEM_S3_SYNC_ENDPOINT = s3.endpoint.trim();
    if (s3.bucket?.trim()) updates.CLAUDE_MEM_S3_SYNC_BUCKET = s3.bucket.trim();
    if (s3.region?.trim()) updates.CLAUDE_MEM_S3_SYNC_REGION = s3.region.trim();
  }

  // Environment-owned keys are skipped, not written: the variable is that
  // value's only source (SettingsRoutes' withoutEnvironmentEchoes rule).
  const envOwned = (key: string): boolean => process.env[key] !== undefined;
  const writable = Object.fromEntries(Object.entries(updates).filter(([key]) => !envOwned(key)));
  if (Object.keys(writable).length > 0) {
    const result = updateSettingsDocument(paths.settingsPath, {}, SettingsDefaultsManager.getAllDefaults(), target => {
      for (const [key, value] of Object.entries(writable)) {
        target[key] = value;
        outcome.settingsWritten.push(key);
      }
    });
    if (result.status === 'refused') {
      throw new Error(`Settings file could not be updated: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
    }
    outcome.openrouterKeySaved = 'CLAUDE_MEM_OPENROUTER_API_KEY' in writable;
  }

  if (s3?.accessKeyId?.trim() && s3.secretAccessKey?.trim()) {
    saveClaudeMemEnv({ S3_SYNC_ACCESS_KEY_ID: s3.accessKeyId.trim(), S3_SYNC_SECRET_ACCESS_KEY: s3.secretAccessKey.trim() });
    outcome.s3CredentialsSaved = true;
    logger.info('WORKER', 'Setup saved S3 Sync bucket credentials to .env');
  }

  return outcome;
}
