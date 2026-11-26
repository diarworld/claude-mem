// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The GPUStack fresh-install defaults: a fresh openrouter install (the default
// path, the grok-bot implicit choice, or an explicit --provider openrouter)
// fills only the empty provider keys with the internal gateway's endpoint and
// model, asks for the missing key locally, and never touches a machine that
// already holds a provider or a key.
//
// Every case runs in its own Bun process: the TTY flag and the password prompt
// are decided at import time (and bun test shares one process across files, so
// neither may be mocked or flipped here). The child gets an isolated HOME, so
// it reads and writes no real settings.json or ~/.claude-mem/.env.

const repoRoot = join(import.meta.dir, '..', '..');

interface CaseSpec {
  tty?: boolean;
  settings?: Record<string, unknown>;
  env?: Record<string, string>;
  options?: Record<string, unknown>;
  passwordAnswer?: string | null;
  /** 'promptProvider' (default) or 'validate' — which exported step drives the case. */
  step?: 'promptProvider' | 'validate';
}

interface CaseResult {
  error?: string;
  remediation?: string;
  provider?: string;
  providerSource?: string;
  passwordCalls?: string[];
  settings?: Record<string, unknown>;
}

function runCase(spec: CaseSpec): CaseResult {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-gpustack-'));
  try {
    const child = Bun.spawnSync([process.execPath, '-e', `
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const { mock } = await import('bun:test');
      const spec = JSON.parse(process.env.GPUSTACK_CASE);
      if (spec.tty) Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
      // USER_SETTINGS_PATH is the data dir's settings.json (CLAUDE_MEM_DATA_DIR
      // points inside the isolated HOME the spawner set).
      const settingsPath = path.join(process.env.CLAUDE_MEM_DATA_DIR ?? path.join(os.homedir(), '.claude-mem'), 'settings.json');
      if (spec.settings !== undefined) {
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify(spec.settings, null, 2));
      }
      for (const [key, value] of Object.entries(spec.env ?? {})) process.env[key] = value;
      const passwordCalls: string[] = [];
      if (spec.passwordAnswer !== undefined && spec.passwordAnswer !== null) {
        const prompts = { ...await import('@clack/prompts') };
        mock.module('@clack/prompts', () => ({ ...prompts,
          password: async (options: { message: string }) => { passwordCalls.push(options.message); return spec.passwordAnswer; } }));
      }
      const { promptProvider, validateNonInteractiveProvider } = await import(${JSON.stringify(join(repoRoot, 'src', 'npx-cli', 'commands', 'install.js'))});
      const { createInstallSummary } = await import(${JSON.stringify(join(repoRoot, 'src', 'npx-cli', 'install', 'error-reporter.js'))});
      const read = () => { try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return null; } };
      try {
        if (spec.step === 'validate') {
          validateNonInteractiveProvider(spec.options as never, createInstallSummary());
        } else {
          const options = { ...(spec.options ?? {}) };
          const provider = await promptProvider(options as never);
          console.log('RESULT:' + JSON.stringify({ provider, providerSource: options.providerSource, passwordCalls, settings: read() }));
        }
      } catch (error) {
        const err = error as { remediation?: string; message?: string };
        console.log('RESULT:' + JSON.stringify({ error: err.message ?? String(error), remediation: err.remediation }));
      }
    `], {
      env: {
        ...process.env,
        GPUSTACK_CASE: JSON.stringify(spec),
        HOME: root, USERPROFILE: root,
        CLAUDE_CONFIG_DIR: join(root, 'claude'),
        CLAUDE_MEM_DATA_DIR: join(root, 'data'),
        CLAUDE_MEM_ENV_FILE: join(root, 'data', '.env'),
        // A held gateway key in the developer's environment would defeat the
        // "no key" cases; cases that need one pass it via spec.env.
        CLAUDE_MEM_PROVIDER: undefined, CLAUDE_MEM_OPENROUTER_API_KEY: undefined,
        CLAUDE_MEM_OPENROUTER_API_KEYS: undefined, CLAUDE_MEM_OPENROUTER_BASE_URL: undefined,
        CLAUDE_MEM_OPENROUTER_MODEL: undefined, CLAUDE_MEM_GEMINI_API_KEY: undefined,
        CLAUDE_MEM_GEMINI_API_KEYS: undefined,
      } as NodeJS.ProcessEnv,
      stdout: 'pipe', stderr: 'pipe', timeout: 60_000,
    });
    const output = new TextDecoder().decode(child.stdout) + new TextDecoder().decode(child.stderr);
    const line = output.split('\n').find(l => l.startsWith('RESULT:'));
    if (!line) throw new Error('case produced no result:\n' + output);
    return JSON.parse(line.slice('RESULT:'.length)) as CaseResult;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const GPUSTACK_URL = 'https://gpustack.data.lmru.tech/v1';
const GPUSTACK_MODEL = 'glm-5.3-flash';

describe('GPUStack fresh-install defaults', () => {
  it('a fresh install writes the gateway defaults and asks for the missing key locally', () => {
    const result = runCase({ tty: true, settings: {}, passwordAnswer: 'gpustack-key' });
    expect(result.error).toBeUndefined();
    expect(result.provider).toBe('openrouter');
    expect(result.providerSource).toBe('default');
    expect(result.passwordCalls).toEqual(['Paste your GPUStack API key:']);
    expect(result.settings).toMatchObject({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_BASE_URL: GPUSTACK_URL,
      CLAUDE_MEM_OPENROUTER_MODEL: GPUSTACK_MODEL,
      CLAUDE_MEM_OPENROUTER_API_KEY: 'gpustack-key',
    });
  });

  it('never overwrites a held environment key or existing endpoint and model, and prompts nothing', () => {
    const settings = {
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://personal.example.test/v1',
      CLAUDE_MEM_OPENROUTER_MODEL: 'my-model',
    };
    const result = runCase({
      tty: true, settings,
      env: { CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-v1-exported' },
      options: { provider: 'openrouter', providerSource: 'flag' },
    });
    expect(result.error).toBeUndefined();
    expect(result.provider).toBe('openrouter');
    expect(result.passwordCalls).toEqual([]);
    // The provider joins the held endpoint and model; the key stays exported,
    // never copied to disk.
    expect(result.settings).toEqual({ ...settings, CLAUDE_MEM_PROVIDER: 'openrouter' });
  });

  it('aborts a non-interactive openrouter install with no key, pointing at the env var', () => {
    const result = runCase({
      settings: {},
      options: { provider: 'openrouter', providerSource: 'flag' },
      step: 'validate',
    });
    expect(result.error).toContain('openrouter requires a preconfigured personal API key when stdin is not interactive.');
    expect(result.remediation).toBe('Set CLAUDE_MEM_OPENROUTER_API_KEY (env or ~/.claude-mem/.env) or pass --provider claude.');
  });

  it('leaves a persisted provider and its settings untouched', () => {
    const settings = {
      CLAUDE_MEM_PROVIDER: 'claude',
      CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription',
      CLAUDE_MEM_MODEL: 'keep-model',
    };
    const result = runCase({
      tty: true, settings,
      options: { provider: 'claude', providerSource: 'persisted' },
    });
    expect(result.error).toBeUndefined();
    expect(result.provider).toBe('claude');
    expect(result.passwordCalls).toEqual([]);
    expect(result.settings).toEqual(settings);
  });
});
