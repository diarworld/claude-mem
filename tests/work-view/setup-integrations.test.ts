import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { applySetupIntegrations, readSetupIntegrationsView, validateSetupIntegrations, type SetupIntegrationsRequest } from '../../src/services/work-view/setup-integrations.js';

// The writes land in a temp settings file and a temp .env (EnvManager resolves
// CLAUDE_MEM_ENV_FILE at call time). Every settings key this module may write
// is cleared from the environment first: an exported value on this machine
// would otherwise win over the request and break the expectations.
const GUARDED_ENV_KEYS = [
  'CLAUDE_MEM_ENV_FILE',
  'CLAUDE_MEM_PROVIDER',
  'CLAUDE_MEM_OPENROUTER_API_KEY',
  'CLAUDE_MEM_OPENROUTER_BASE_URL',
  'CLAUDE_MEM_OPENROUTER_MODEL',
  'CLAUDE_MEM_S3_SYNC_ENABLED',
  'CLAUDE_MEM_S3_SYNC_ENDPOINT',
  'CLAUDE_MEM_S3_SYNC_BUCKET',
  'CLAUDE_MEM_S3_SYNC_REGION',
] as const;

describe('setup integrations (the choice screen\'s GPUStack and S3 blocks)', () => {
  let dir = '';
  let settingsPath = '';
  let savedEnv: Record<string, string | undefined> = {};

  const readSettings = (): Record<string, unknown> => JSON.parse(readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cmem-setup-integrations-'));
    settingsPath = join(dir, 'settings.json');
    savedEnv = {};
    for (const key of GUARDED_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.CLAUDE_MEM_ENV_FILE = join(dir, '.env');
    // Seeds the file with the shipped defaults (the settings seeder's write).
    SettingsDefaultsManager.loadFromFile(settingsPath);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const key of GUARDED_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  describe('validateSetupIntegrations', () => {
    it('accepts a request with nothing in it', () => {
      expect(validateSetupIntegrations({}, {})).toBeNull();
      expect(validateSetupIntegrations({ gpuStackApiKey: 'sk-1' }, {})).toBeNull();
    });

    it('refuses an enabled S3 block without an endpoint or a bucket', () => {
      expect(validateSetupIntegrations({ s3Sync: { enabled: true, bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' } }, {}))
        .toBe('The S3 endpoint must be an http(s) URL.');
      expect(validateSetupIntegrations({ s3Sync: { enabled: true, endpoint: 'https://s3.example.com', accessKeyId: 'a', secretAccessKey: 's' } }, {}))
        .toBe('The S3 bucket name is required.');
    });

    it('refuses an enabled block whose credentials are neither submitted nor stored', () => {
      expect(validateSetupIntegrations({ s3Sync: { enabled: true, endpoint: 'https://s3.example.com', bucket: 'b' } }, {}))
        .toBe('The bucket access key and secret key are required.');
    });

    it('accepts an enabled block with submitted credentials or with credentials already in .env', () => {
      expect(validateSetupIntegrations({ s3Sync: { enabled: true, endpoint: 'https://s3.example.com', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' } }, {})).toBeNull();
      expect(validateSetupIntegrations({ s3Sync: { enabled: true, endpoint: 'https://s3.example.com', bucket: 'b' } },
        { S3_SYNC_ACCESS_KEY_ID: 'stored', S3_SYNC_SECRET_ACCESS_KEY: 'stored-secret' })).toBeNull();
    });

    it('accepts a disabled block regardless of credentials', () => {
      expect(validateSetupIntegrations({ s3Sync: { enabled: false } }, {})).toBeNull();
    });
  });

  describe('applySetupIntegrations', () => {
    it('writes the gateway key and fills the GPUStack defaults into empty keys', () => {
      const outcome = applySetupIntegrations({ gpuStackApiKey: 'sk-test-1234' }, { settingsPath });
      expect(outcome.openrouterKeySaved).toBe(true);
      const settings = readSettings();
      expect(settings.CLAUDE_MEM_OPENROUTER_API_KEY).toBe('sk-test-1234');
      expect(settings.CLAUDE_MEM_PROVIDER).toBe('openrouter');
      expect(settings.CLAUDE_MEM_OPENROUTER_BASE_URL).toBe('https://gpustack.data.lmru.tech/v1');
      expect(settings.CLAUDE_MEM_OPENROUTER_MODEL).toBe('glm-5.3-flash');
    });

    it('never overwrites a base URL this machine chose', () => {
      // A value hand-written into settings.json (as a person or another tool would leave it).
      const seeded = readSettings();
      seeded.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://chosen.example/v1';
      writeFileSync(settingsPath, JSON.stringify(seeded, null, 2), 'utf-8');
      const outcome = applySetupIntegrations({ gpuStackApiKey: 'sk-test-1234' }, { settingsPath });
      expect(readSettings().CLAUDE_MEM_OPENROUTER_BASE_URL).toBe('https://chosen.example/v1');
      expect(outcome.settingsWritten).not.toContain('CLAUDE_MEM_OPENROUTER_BASE_URL');
    });

    it('skips keys an environment variable owns instead of copying the value to disk', () => {
      process.env.CLAUDE_MEM_OPENROUTER_BASE_URL = 'https://env.example/v1';
      const outcome = applySetupIntegrations({ gpuStackApiKey: 'sk-test-1234' }, { settingsPath });
      expect(outcome.settingsWritten).not.toContain('CLAUDE_MEM_OPENROUTER_BASE_URL');
      // The fill default is dropped with the write: the variable stays that value's only source.
      expect(readSettings().CLAUDE_MEM_OPENROUTER_BASE_URL).toBe('');
    });

    it('writes an explicit endpoint from the form over the fill default', () => {
      applySetupIntegrations({ gpuStackApiKey: 'sk-test-1234', gpuStackEndpoint: 'https://internal.gateway/v1' }, { settingsPath });
      expect(readSettings().CLAUDE_MEM_OPENROUTER_BASE_URL).toBe('https://internal.gateway/v1');
    });

    it('enables S3 Sync, writes its settings and the bucket credentials to .env', () => {
      const outcome = applySetupIntegrations({
        s3Sync: { enabled: true, endpoint: 'https://s3.example.com', bucket: 'mem-bucket', region: 'eu-central-2', accessKeyId: 'AKIA-test', secretAccessKey: 'secret-test' },
      }, { settingsPath });
      expect(outcome.s3CredentialsSaved).toBe(true);
      const settings = readSettings();
      expect(settings.CLAUDE_MEM_S3_SYNC_ENABLED).toBe('true');
      expect(settings.CLAUDE_MEM_S3_SYNC_ENDPOINT).toBe('https://s3.example.com');
      expect(settings.CLAUDE_MEM_S3_SYNC_BUCKET).toBe('mem-bucket');
      expect(settings.CLAUDE_MEM_S3_SYNC_REGION).toBe('eu-central-2');
      const envFile = readFileSync(process.env.CLAUDE_MEM_ENV_FILE!, 'utf-8');
      expect(envFile).toContain('S3_SYNC_ACCESS_KEY_ID=AKIA-test');
      expect(envFile).toContain('S3_SYNC_SECRET_ACCESS_KEY=secret-test');
    });

    it('disabling writes false and never blanks the stored credentials', () => {
      applySetupIntegrations({ s3Sync: { enabled: true, endpoint: 'https://s3.example.com', bucket: 'b', accessKeyId: 'AKIA-test', secretAccessKey: 'secret-test' } }, { settingsPath });
      const outcome = applySetupIntegrations({ s3Sync: { enabled: false } }, { settingsPath });
      expect(outcome.s3CredentialsSaved).toBe(false);
      expect(readSettings().CLAUDE_MEM_S3_SYNC_ENABLED).toBe('false');
      expect(readFileSync(process.env.CLAUDE_MEM_ENV_FILE!, 'utf-8')).toContain('S3_SYNC_ACCESS_KEY_ID=AKIA-test');
    });

    it('leaves settings alone when the request carries nothing', () => {
      const outcome = applySetupIntegrations({}, { settingsPath });
      expect(outcome.settingsWritten).toEqual([]);
      expect(outcome.openrouterKeySaved).toBe(false);
      expect(outcome.s3CredentialsSaved).toBe(false);
    });
  });

  describe('readSetupIntegrationsView', () => {
    it('masks the stored key with its last four characters and prefills the S3 defaults', () => {
      applySetupIntegrations({ gpuStackApiKey: 'sk-test-1234' }, { settingsPath });
      const view = readSetupIntegrationsView(settingsPath);
      expect(view.openRouterKeyMasked).toBe('********1234');
      expect(view.s3.enabled).toBe(false);
      expect(view.s3.endpoint).toBe('https://storage.yandexcloud.net');
      expect(view.s3.region).toBe('ru-central1');
    });

    it('answers an empty mask when no key is stored', () => {
      const view = readSetupIntegrationsView(settingsPath);
      expect(view.openRouterKeyMasked).toBe('');
      expect(view.openRouterBaseUrl).toBe('');
    });

    it('reports the stored sync settings after an enable', () => {
      applySetupIntegrations({ s3Sync: { enabled: true, endpoint: 'https://s3.example.com', bucket: 'b' } }, { settingsPath });
      const view = readSetupIntegrationsView(settingsPath);
      expect(view.s3.enabled).toBe(true);
      expect(view.s3.bucket).toBe('b');
      expect(existsSync(process.env.CLAUDE_MEM_ENV_FILE!)).toBe(false);
    });
  });
});
