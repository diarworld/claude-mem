// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The local-only installer's contract: the interactive key prompt is a local
// transaction. Nothing on the GPUStack key path — prompt, save, or the cancel
// that aborts it — may contact cmem.ai, and a completed run holds its key in
// ~/.claude-mem/settings.json and nowhere else.
//
// Every case runs in its own Bun process (the install-gpustack-defaults.test
// harness, plus a fetch guard): the TTY flag and the password prompt are
// decided at import time (and bun test shares one process across files, so
// neither may be mocked or flipped here). The child gets an isolated HOME, so
// it reads and writes no real settings.json or ~/.claude-mem/.env. Its fetch
// throws on any cmem.ai URL and records the attempt, so a run that reached for
// the hosted service would fail this file instead of hanging on the network.

const repoRoot = join(import.meta.dir, '..', '..');

interface CaseSpec {
  tty?: boolean;
  settings?: Record<string, unknown>;
  env?: Record<string, string>;
  options?: Record<string, unknown>;
  passwordAnswer?: string | null;
}

interface CaseResult {
  error?: string;
  remediation?: string;
  provider?: string;
  providerSource?: string;
  passwordCalls?: string[];
  settings?: Record<string, unknown>;
  cmemFetches?: string[];
}

function runCase(spec: CaseSpec): CaseResult {
  const root = mkdtempSync(join(tmpdir(), 'claude-mem-local-contract-'));
  try {
    const child = Bun.spawnSync([process.execPath, '-e', `
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const { mock, spyOn } = await import('bun:test');
      const spec = JSON.parse(process.env.LOCAL_CONTRACT_CASE);
      if (spec.tty) Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
      // USER_SETTINGS_PATH is the data dir's settings.json (CLAUDE_MEM_DATA_DIR
      // points inside the isolated HOME the spawner set).
      const settingsPath = path.join(process.env.CLAUDE_MEM_DATA_DIR ?? path.join(os.homedir(), '.claude-mem'), 'settings.json');
      if (spec.settings !== undefined) {
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        fs.writeFileSync(settingsPath, JSON.stringify(spec.settings, null, 2));
      }
      for (const [key, value] of Object.entries(spec.env ?? {})) process.env[key] = value;
      const passwordCalls = [];
      if (spec.passwordAnswer !== undefined && spec.passwordAnswer !== null) {
        const prompts = { ...await import('@clack/prompts') };
        mock.module('@clack/prompts', () => ({ ...prompts,
          password: async (options) => { passwordCalls.push(options.message); return spec.passwordAnswer; } }));
      }
      // The guard the contract is about: any cmem.ai request is recorded and
      // fails the request, so the run can only complete through local means.
      const cmemFetches = [];
      const realFetch = globalThis.fetch;
      spyOn(globalThis, 'fetch').mockImplementation(((input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('cmem.ai')) {
          cmemFetches.push(url);
          return Promise.reject(new Error('The local-only installer must not contact cmem.ai (' + url + ')'));
        }
        return realFetch(input, init);
      }));
      const { promptProvider } = await import(${JSON.stringify(join(repoRoot, 'src', 'npx-cli', 'commands', 'install.js'))});
      const read = () => { try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return null; } };
      try {
        const options = { ...(spec.options ?? {}) };
        const provider = await promptProvider(options);
        console.log('RESULT:' + JSON.stringify({ provider, providerSource: options.providerSource, passwordCalls, settings: read(), cmemFetches }));
      } catch (error) {
        const err = error;
        console.log('RESULT:' + JSON.stringify({ error: err.message ?? String(error), remediation: err.remediation, passwordCalls, settings: read(), cmemFetches }));
      }
    `], {
      env: {
        ...process.env,
        LOCAL_CONTRACT_CASE: JSON.stringify(spec),
        HOME: root, USERPROFILE: root,
        CLAUDE_CONFIG_DIR: join(root, 'claude'),
        CLAUDE_MEM_DATA_DIR: join(root, 'data'),
        CLAUDE_MEM_ENV_FILE: join(root, 'data', '.env'),
        // A held gateway key in the developer's environment would defeat the
        // "no key" case; this spec needs the key held nowhere.
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

describe('the interactive key path makes no cmem.ai request', () => {
  it('a fresh install with no held key prompts locally, saves the key to settings.json and never contacts cmem.ai', () => {
    const result = runCase({ tty: true, settings: {}, passwordAnswer: 'gpustack-key' });
    expect(result.error).toBeUndefined();
    expect(result.provider).toBe('openrouter');
    expect(result.providerSource).toBe('default');
    // The only question is the local paste; the run completes through the key
    // save and the GPUStack defaults, all on this machine.
    expect(result.passwordCalls).toEqual(['Paste your GPUStack API key:']);
    expect(result.settings).toMatchObject({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_BASE_URL: GPUSTACK_URL,
      CLAUDE_MEM_OPENROUTER_MODEL: GPUSTACK_MODEL,
      CLAUDE_MEM_OPENROUTER_API_KEY: 'gpustack-key',
    });
    expect(result.cmemFetches).toEqual([]);
  });
});
