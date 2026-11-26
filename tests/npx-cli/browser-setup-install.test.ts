import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

// The installer's TTY flag and settings paths are read at import, so the cases run in a fresh Bun process
// (the same pattern as combined-installer-boundaries.test.ts). The child drives the public install command through
// controlled prompts and an in-process worker that serves the real setup endpoints, and plays the browser itself.
if (process.env.CLAUDE_MEM_BROWSER_SETUP_FIXTURE_CHILD !== import.meta.path) {
  describe('isolated browser-setup installer fixture', () => {
    it('passes every case in a fresh Bun process', () => {
      const child = Bun.spawnSync({
        cmd: [process.execPath, 'test', '--timeout', '30000', import.meta.path],
        cwd: join(import.meta.dir, '..', '..'),
        env: { ...process.env, CLAUDE_MEM_BROWSER_SETUP_FIXTURE_CHILD: import.meta.path },
        stdout: 'pipe', stderr: 'pipe', timeout: 180_000,
      });
      if (child.stdout) process.stdout.write(child.stdout);
      if (child.stderr) process.stderr.write(child.stderr);
      expect(child.exitCode).toBe(0);
    }, 210_000);
  });
} else {
// Project-local scratch (gitignored), never the system temp folder.
const scratchRoot = join(import.meta.dir, '..', '..', '.scratch', 'test-runs');
mkdirSync(scratchRoot, { recursive: true });
const fixture = mkdtempSync(join(scratchRoot, 'browser-setup-install-'));
const hostHome = join(fixture, 'host-home');
const data = join(fixture, 'data');
const bin = join(fixture, 'bin');
for (const dir of [hostHome, data, bin]) mkdirSync(dir, { recursive: true });
const realOs = { ...await import('node:os') };
const scopedOs = { ...realOs, homedir: () => hostHome };
const originalOsDefault = Object.getOwnPropertyDescriptor(realOs, 'default');
if (originalOsDefault) Object.defineProperty(scopedOs, 'default', { ...originalOsDefault, value: { ...originalOsDefault.value, homedir: scopedOs.homedir } });
mock.module('os', () => scopedOs);
mock.module('node:os', () => scopedOs);
Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
// The browser-open wait listens for Return/Ctrl-C in raw mode, as on a real terminal.
if (typeof (process.stdin as { setRawMode?: unknown }).setRawMode !== 'function') {
  Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: () => process.stdin });
}
process.env.CLAUDE_MEM_DATA_DIR = data;
process.env.CLAUDE_CONFIG_DIR = join(fixture, 'claude');
process.env.CLAUDE_MEM_ENV_FILE = join(data, '.env');
process.env.PATH = `${bin}:/usr/bin:/bin`;
process.env.DO_NOT_TRACK = '1';
// CI hides the optional email question; these cases play a person at a terminal.
delete process.env.CI;
delete process.env.CLAUDE_MEM_ONLINE_OPTIN;
const signupUrl = 'https://signup.example.test/signup';
process.env.CLAUDE_MEM_SIGNUP_URL = signupUrl;
for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_MEM_PROVIDER', 'CLAUDE_MEM_OPENROUTER_API_KEY']) delete process.env[key];

// A free loopback port for the fixture worker.
const port = await new Promise<number>((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
  });
});
const workerBase = `http://127.0.0.1:${port}`;
const settingsPath = join(data, 'settings.json');
const statePath = join(data, 'setup-state.json');
const sessionPath = join(data, 'setup-session.json');
const intentCredentialsPath = join(data, 'intent-install.json');
const intentCredentials = { install_id: '1'.repeat(32), intent_token: '2'.repeat(64) };
// The worker is managed "externally" so the installer never tries to stop it: the fixture owns its lifecycle.
const baseSettings = { CLAUDE_MEM_WORKER_PORT: String(port), CLAUDE_MEM_WORKER_AUTOSTART: 'false' };

const prompts = { ...await import('@clack/prompts') };
const banner = { ...await import('../../src/npx-cli/banner.js') };
const spawnGate = { ...await import('../../src/shared/worker-spawn-gate.js') };
const spawner = { ...await import('../../src/services/worker-spawner.js') };
const cliPaths = { ...await import('../../src/npx-cli/utils/paths.js') };
const memoryCredentials = { ...await import('../../src/npx-cli/cmem-memory-credentials.js') };
const browserSetup = { ...await import('../../src/npx-cli/install/browser-setup.js') };
const skillSelection = { ...await import('../../src/shared/skill-selection.js') };
mock.module('../../src/shared/skill-selection.js', () => ({ ...skillSelection, applyConfiguredSkillSelection: () => ({ disabled: [], enabled: [], warnings: [] }) }));
let backgroundPolls = 0;
mock.module('../../src/npx-cli/install/browser-setup.js', () => ({
  ...browserSetup,
  runBrowserSetup: (deps: Parameters<typeof browserSetup.runBrowserSetup>[0]) => browserSetup.runBrowserSetup({ ...deps, pollIntervalMs: 10 }),
  waitForBackgroundWorkToFinish: (deps: Parameters<typeof browserSetup.waitForBackgroundWorkToFinish>[0]) => browserSetup.waitForBackgroundWorkToFinish({
    ...deps, pollIntervalMs: 10,
    sleep: async (ms) => { backgroundPolls++; await new Promise(resolve => setTimeout(resolve, ms)); },
  }),
}));
const packageVersion = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8')).version;
mock.module('../../src/npx-cli/utils/paths.js', () => ({ ...cliPaths, readPluginVersion: () => packageVersion, npmPackagePluginDirectory: () => join(import.meta.dir, '..', '..', 'plugin') }));

const lines: string[] = [];
const questions: string[] = [];
const textAnswers: string[] = [];
const ranTasks: string[] = [];
const offeredTasks: string[] = [];
let workerStarts = 0;
const workerStartStates: unknown[] = [];
const workerStartSessions: unknown[] = [];
const workerStartSettings: unknown[] = [];
let fixtureWorkerResult: 'ready' | 'dead' = 'ready';
let passwordAnswer: string | symbol = 'new-provider-key';
mock.module('@clack/prompts', () => ({
  ...prompts,
  intro: () => {}, outro: (value: string) => lines.push(value), cancel: (value: string) => lines.push(value),
  note: (value: string, title?: string) => lines.push(`${title}\n${value}`),
  spinner: () => ({ start: (value: string) => lines.push(value), stop: (value: string) => lines.push(value), message: () => {} }),
  multiselect: async (options: { message: string; options: Array<{ value: string }>; initialValues: string[] }) => {
    questions.push(options.message);
    // The agent-selection multiselects; the provider question is gone (a fresh
    // install defaults to the internal model gateway).
    return ['claude-code'];
  },
  select: async (options: { message: string }) => {
    questions.push(options.message);
    if (options.message.startsWith('Which runtime')) return 'worker';
    if (options.message.startsWith('Disable Claude Code auto-memory')) return 'leave-enabled';
    return 'claude-haiku-4-5-20251001';
  },
  confirm: async (options: { message: string }) => { questions.push(options.message); return false; },
  text: async (options: { message: string }) => { questions.push(options.message); return textAnswers.shift() ?? ''; },
  password: async (options: { message: string }) => { questions.push(options.message); return passwordAnswer; },
  // Plugin copy and dependency installs are other suites' business; IDE hooks and the worker start run for real.
  tasks: async (tasks: Array<{ title: string; task: (message: (value: string) => void) => Promise<string> }>) => {
    for (const task of tasks) {
      offeredTasks.push(task.title);
      if (!/^(Starting worker daemon|Claude Code)/.test(task.title)) continue;
      ranTasks.push(task.title);
      lines.push(await task.task((value) => lines.push(value)));
    }
  },
  log: Object.fromEntries(['info', 'success', 'warn', 'error', 'message', 'step'].map(key => [key, (value: string) => lines.push(value)])),
}));
mock.module('../../src/npx-cli/banner.js', () => ({ ...banner, playBanner: async () => {} }));
// Host mode probes for an observer the user already runs; the host case only needs the settings it writes.
mock.module('../../src/npx-cli/cmem-memory-credentials.js', () => ({
  ...memoryCredentials,
  buildHostObserverSettings: () => ({ CLAUDE_MEM_PROVIDER: 'openrouter' }),
}));
mock.module('../../src/shared/worker-spawn-gate.js', () => ({ ...spawnGate, holdSpawnLock: async () => () => {} }));

// The fixture worker: the real WorkViewRoutes setup endpoints on the configured port.
const express = (await import('express')).default;
const { WorkViewRoutes } = await import('../../src/services/worker/http/routes/WorkViewRoutes.js');
let worker: { server: Server; routes: InstanceType<typeof WorkViewRoutes> } | null = null;
/** The extraction run (the automatic refresh) as the routes see it: 'running' in this process until a case ends it. */
const extraction = {
  running: false,
  restartsWhileRunning: 0,
  status() { return this.running ? { state: 'running', pid: process.pid, reason: 'setup-scan', startedAt: new Date().toISOString() } : null; },
  start() {}, close() {}, async runNow() { return 'idle'; },
};
async function startFixtureWorker(): Promise<void> {
  if (worker) return;
  const routes = new WorkViewRoutes({
    databasePath: join(import.meta.dir, '..', 'fixtures', 'prompt-import', 'home', 'no-work-state.db'),
    reviewPath: ':memory:', humanCopy: null, ledgerDir: null, setupScan: null, setupStatePath: statePath, settingsPath,
    autoRefresh: extraction as never,
  });
  const app = express();
  app.use(express.json());
  app.get('/api/health', (_req, res) => { res.json({ port }); });
  routes.setupRoutes(app);
  const server = await new Promise<Server>((resolve) => { const s = app.listen(port, '127.0.0.1', () => resolve(s)); });
  worker = { server, routes };
}
async function stopFixtureWorker(): Promise<void> {
  if (!worker) return;
  worker.routes.close();
  await new Promise<void>((resolve) => worker!.server.close(() => resolve()));
  worker = null;
}
mock.module('../../src/services/worker-spawner.js', () => ({
  ...spawner,
  ensureWorkerStarted: async () => {
    workerStarts++;
    workerStartStates.push(existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null);
    workerStartSessions.push(existsSync(sessionPath) ? JSON.parse(readFileSync(sessionPath, 'utf8')) : null);
    workerStartSettings.push(JSON.parse(readFileSync(settingsPath, 'utf8')));
    if (extraction.running) extraction.restartsWhileRunning++;
    if (fixtureWorkerResult === 'dead') return 'dead';
    await startFixtureWorker();
    return 'ready';
  },
  getLastWorkerBootFailure: () => undefined,
}));

// The browser opener, observed instead of launching anything.
const childProcess = await import('node:child_process');
const realSpawnSync = childProcess.spawnSync;
const opened: string[] = [];
const questionsAtOpen: string[][] = [];
const spawnSyncSpy = spyOn(childProcess, 'spawnSync').mockImplementation(((command: string, args: string[], options: any) => {
  if (['open', 'xdg-open', 'cmd'].includes(command)) {
    opened.push(args[args.length - 1]);
    questionsAtOpen.push([...questions]);
    return { status: 0 } as any;
  }
  return realSpawnSync(command, args, options);
}) as typeof childProcess.spawnSync);

// Loopback to the fixture worker is real. Signup and account pairing are recorded locally.
const realFetch = globalThis.fetch;
const { CMEM_INSTALLER_OAUTH_START_URL, CMEM_INSTALLER_OAUTH_POLL_URL } = await import('../../src/npx-cli/install/pairing.js');
const pairingStarts: number[] = [];
const pairingStartHeaders: Headers[] = [];
/** What cmem.ai's pairing poll answers next, in order (a 410 is a cancelled or expired checkout). */
const pollAnswers: Array<{ status: number; body: unknown }> = [];
const setupRequests: string[] = [];
const signupRequests: Array<Record<string, unknown>> = [];
const unexpected: string[] = [];
const pairingId = 'a'.repeat(32);
const startOrigin = new URL(CMEM_INSTALLER_OAUTH_START_URL).origin;
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: any, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith(workerBase)) {
    if (url.includes('/api/setup/')) setupRequests.push(url.slice(workerBase.length));
    return realFetch(input, init);
  }
  if (url === signupUrl) {
    signupRequests.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  }
  if (url === CMEM_INSTALLER_OAUTH_POLL_URL) {
    const answer = pollAnswers.shift() ?? { status: 202, body: { status: 'pending', stage: 'awaiting_checkout' } };
    return Response.json(answer.body, { status: answer.status });
  }
  if (url === CMEM_INSTALLER_OAUTH_START_URL) {
    pairingStarts.push(Date.now());
    pairingStartHeaders.push(new Headers(init?.headers));
    return Response.json({
      pairing_id: pairingId, secret: 'b'.repeat(48), user_code: 'ABCD-EFGH', poll_interval: 3, expires_in: 900,
      authorization_url: `${startOrigin}/login?next=${encodeURIComponent(`/api/pro/trial/claim?pairing=${pairingId}&login_only=1`)}`,
      checkout_url: `${startOrigin}/api/pro/trial/claim?pairing=${pairingId}&trial=1`,
    });
  }
  unexpected.push(url);
  throw new Error(`Unexpected HTTP ${url}`);
}) as typeof fetch);
const exit = spyOn(process, 'exit').mockImplementation((code?: string | number | null): never => { throw new Error('EXIT_' + code); });

const { runInstallCommand, promptProvider } = await import('../../src/npx-cli/commands/install.js');

beforeEach(async () => {
  await stopFixtureWorker();
  rmSync(statePath, { force: true });
  rmSync(sessionPath, { force: true });
  rmSync(intentCredentialsPath, { force: true });
  writeFileSync(settingsPath, JSON.stringify(baseSettings, null, 2));
  lines.length = 0; questions.length = 0; ranTasks.length = 0; offeredTasks.length = 0; opened.length = 0;
  textAnswers.length = 0; questionsAtOpen.length = 0; signupRequests.length = 0;
  pairingStarts.length = 0; pairingStartHeaders.length = 0; setupRequests.length = 0; unexpected.length = 0; workerStarts = 0; pollAnswers.length = 0;
  workerStartStates.length = 0;
  workerStartSessions.length = 0;
  workerStartSettings.length = 0;
  backgroundPolls = 0;
  fixtureWorkerResult = 'ready';
  passwordAnswer = 'new-provider-key';
  extraction.running = false; extraction.restartsWhileRunning = 0;
});
afterAll(async () => {
  await stopFixtureWorker();
  spawnSyncSpy.mockRestore(); fetchSpy.mockRestore(); exit.mockRestore();
  rmSync(fixture, { recursive: true, force: true });
});

const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, string>;
async function browserState(): Promise<any> {
  return (await realFetch(`${workerBase}/api/setup/state`)).json();
}
async function waitForInstall(status: string): Promise<any> {
  for (;;) {
    try { const state = await browserState(); if (state.install?.status === status) return state; } catch { /* worker not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function waitForStage(stage: string): Promise<any> {
  for (;;) {
    try {
      const state = await browserState();
      if (stage === 'waiting-for-choice' && state.install?.status === 'waiting') {
        const response = await browserPost('/api/setup/install', { ...state.install.catalog.defaults, agents: ['claude-code'], installClaudeCode: false });
        expect(response.status).toBe(200);
      }
      if (state.installer?.stage === stage && (stage !== 'waiting-for-choice' || state.install?.status === 'ready')) return state;
    } catch { /* worker not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
const browserPost = (path: string, body: unknown) => realFetch(`${workerBase}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: workerBase }, body: JSON.stringify(body),
});

describe('install in GUI mode (interactive TTY, no --provider)', () => {
  it('lets the browser restore native auto-memory without removing other Claude settings', async () => {
    const { claudeSettingsPath } = cliPaths;
    mkdirSync(join(fixture, 'claude'), { recursive: true });
    writeFileSync(claudeSettingsPath(), JSON.stringify({ env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', OTHER_SETTING: 'keep' } }));
    const installing = runInstallCommand({});
    const waiting = await waitForInstall('waiting');
    const skillSource = readFileSync(join(import.meta.dir, '..', '..', 'plugin', 'skills', 'mem-search', 'SKILL.md'), 'utf8');
    const frontmatter = skillSource.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const metadata = Bun.YAML.parse(frontmatter![1]) as { description: string };
    expect(waiting.install.catalog.skills.find((skill: { id: string }) => skill.id === 'mem-search')?.description)
      .toBe(metadata.description);
    expect(waiting.install.catalog.defaults.disableAutoMemory).toBe(true);
    expect(offeredTasks).not.toContain('Claude Code: registering plugin');
    expect((await browserPost('/api/setup/install', { ...waiting.install.catalog.defaults, agents: ['claude-code'], disableAutoMemory: false })).status).toBe(200);
    await waitForInstall('ready');
    expect(JSON.parse(readFileSync(claudeSettingsPath(), 'utf8')).env).toEqual({ OTHER_SETTING: 'keep' });
    await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await waitForStage('home-ready');
    await browserPost('/api/setup/complete', {});
    await installing;
    expect(questions).toEqual([]);
  });

  it('offers the default model when the saved one is not allowed outside the gateway, and At Home still finishes', async () => {
    writeFileSync(settingsPath, JSON.stringify({ ...baseSettings, CLAUDE_MEM_MODEL: 'my-gateway-model', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription' }, null, 2));
    const installing = runInstallCommand({});
    const waiting = await waitForInstall('waiting');
    expect(waiting.install.catalog.defaults.claudeModel).toBe('haiku');
    expect((await browserPost('/api/setup/install', { ...waiting.install.catalog.defaults, agents: ['claude-code'] })).status).toBe(200);
    await waitForInstall('ready');
    await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await waitForStage('home-ready');
    await browserPost('/api/setup/complete', {});
    await installing;
    // The untouched default changes nothing: the saved value stays as it was, and nothing threw.
    expect(readSettings().CLAUDE_MEM_MODEL).toBe('my-gateway-model');
  });

  it('leaves all choices pending when deferred, then resumes without stopping or copying the worker', async () => {
    await runInstallCommand({ setup: 'defer' });
    const deferred = await browserState();
    expect(deferred.status).toBe('pending');
    expect(deferred.install.status).toBe('waiting');
    expect(deferred.install.catalog.emailEnabled).toBe(false);
    expect(deferred.install.selection).toBeNull();
    expect(questions).toEqual([]);
    expect(offeredTasks).not.toContain('Claude Code: registering plugin');
    expect(opened).toEqual([]);
    expect(existsSync(sessionPath)).toBe(false);

    const selected = { ...deferred.install.catalog.defaults, agents: ['codex-cli'], claudeModel: 'sonnet' };
    writeFileSync(statePath, JSON.stringify({ ...deferred, install: { ...deferred.install, status: 'installing', selection: selected } }));
    offeredTasks.length = 0;
    const resume = runInstallCommand({ setup: 'resume' });
    await waitForStage('waiting-for-choice');
    expect(offeredTasks).not.toContain('Caching plugin version');
    expect(offeredTasks).not.toContain('Starting worker daemon');
    expect(workerStarts).toBe(1);
    expect(opened).toEqual([]);
    expect(questions).toEqual([]);
    const ready = await browserState();
    expect(ready.install.selection.agents).toEqual(['codex-cli']);
    expect(offeredTasks.some(task => task.startsWith('Codex CLI'))).toBe(true);
    await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await waitForStage('home-ready');
    await browserPost('/api/setup/complete', {});
    await resume;
    expect(readSettings().CLAUDE_MEM_MODEL).toBe('sonnet');
  });

  it('At Home: starts the worker, opens the setup page, asks for no login, and finishes when the page does', async () => {
    const install = runInstallCommand({});
    await waitForStage('waiting-for-choice');
    // The worker is up before any login or provider question, and the page is open.
    expect(workerStarts).toBe(1);
    expect(workerStartStates).toEqual([{ status: 'pending', choice: null, installer: null, tools: null, completedAt: null }]);
    expect(workerStartSessions).toMatchObject([{ pid: process.pid, already_pro: false }]);
    expect((workerStartSessions[0] as { setup_flow_id: string }).setup_flow_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(opened).toEqual([`${workerBase}/?setup=1`]);
    expect(pairingStarts).toEqual([]);

    expect((await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' })).status).toBe(200);
    await waitForStage('home-ready');
    expect((await browserPost('/api/setup/complete', {})).status).toBe(200);
    await install;

    // useSubscriptionAuth(): local, logged-in Claude SDK account; no claude-mem login at all.
    expect(readSettings()).toMatchObject({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription', CLAUDE_MEM_CLOUD_SYNC_TOKEN: '' });
    expect(pairingStarts).toEqual([]);
    // No terminal questions at all: no email opt-in, no provider menu.
    expect(questionsAtOpen).toEqual([[]]);
    expect(questions).toEqual([]);
    expect(signupRequests).toEqual([]);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ status: 'complete', choice: { branch: 'home' }, installer: { stage: 'home-ready' } });
    // A fresh At Home run applied the local provider itself: the honest account line (home-kept-existing, a machine
    // whose existing configuration the installer kept, is the one that says "Kept existing configuration").
    expect(lines.join('\n')).toContain('Account:     Not required (local install)');
    expect(lines.join('\n')).not.toContain('cmem.ai');
    expect(lines.join('\n')).toContain('claude-mem installed successfully!');
    expect(existsSync(sessionPath)).toBe(false);
    expect(ranTasks).toContain('Claude Code: registering plugin');
    expect(unexpected).toEqual([]);
  });

  it('clears an interrupted GUI hand-off before the worker starts', async () => {
    writeFileSync(statePath, JSON.stringify({ status: 'pending', choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'earlier' },
      installer: { stage: 'home-ready', error: null, updatedAt: 'earlier' }, tools: ['codex'], completedAt: null }));
    const install = runInstallCommand({});
    await waitForStage('waiting-for-choice');
    expect(workerStartStates[0]).toEqual({ status: 'pending', choice: null, installer: null, tools: null, completedAt: null });
    expect(pairingStarts).toEqual([]);
    await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await waitForStage('home-ready');
    await browserPost('/api/setup/complete', {});
    await install;
  });

  it('Finish Setup: local tools picked in the browser that this run did not install are set up after the page finishes', async () => {
    const install = runInstallCommand({});
    await waitForStage('waiting-for-choice');
    await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await waitForStage('home-ready');
    expect(offeredTasks.filter(title => title.startsWith('Codex CLI'))).toEqual([]);
    expect((await browserPost('/api/setup/complete', { tools: ['claude-code', 'codex', 'chatgpt'] })).status).toBe(200);
    await install;
    // Claude Code was already installed by this run; Codex is new; ChatGPT is a cloud reader with nothing to install.
    expect(offeredTasks.filter(title => title.startsWith('Codex CLI'))).toHaveLength(1);
    expect(offeredTasks.filter(title => title === 'Claude Code: registering plugin')).toHaveLength(1);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).tools).toEqual(['claude-code', 'codex', 'chatgpt']);
    expect(lines.join('\n')).toMatch(/Agents: .*claude-code, codex-cli/);
  });

  it('the hosted branch is gone from the wire: no pairing, no checkout route, no cmem.ai request', async () => {
    writeFileSync(intentCredentialsPath, JSON.stringify(intentCredentials), { mode: 0o600 });
    const install = runInstallCommand({});
    await waitForStage('waiting-for-choice');
    expect(pairingStarts).toEqual([]);
    // The checkout hand-off left with the hosted funnel: the route is unregistered and go choices are refused.
    expect((await browserPost('/api/setup/checkout', {})).status).toBe(404);
    expect((await browserPost('/api/setup/choice', { branch: 'go', memoryBilling: 'hosted' })).status).toBe(400);
    expect((await browserState()).choice).toBeNull();
    await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await waitForStage('home-ready');
    expect(pairingStarts).toEqual([]);
    expect(opened).toEqual([`${workerBase}/?setup=1`]);
    expect(unexpected).toEqual([]);
    // useSubscriptionAuth() ran during the choice, exactly as the home funnel always resolved it.
    expect(readSettings()).toMatchObject({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription' });
    expect((await browserPost('/api/setup/complete', {})).status).toBe(200);
    await install;
    expect(JSON.parse(readFileSync(intentCredentialsPath, 'utf8'))).toEqual(intentCredentials);
    // A fresh At Home run resolves the local provider in the page, so the account line names the local install.
    expect(lines.join('\n')).toContain('Account:     Not required (local install)');
    expect(lines.join('\n')).not.toContain('cmem.ai');
    expect(unexpected).toEqual([]);
  });

  it('At Home: Finish Setup while the extraction runs finishes the terminal without restarting the worker, so the run goes on', async () => {
    const install = runInstallCommand({});
    await waitForStage('waiting-for-choice');
    await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await waitForStage('home-ready');
    extraction.running = true;
    expect((await browserState()).backgroundWorkRunning).toEqual(['extraction']);
    expect((await browserPost('/api/setup/complete', {})).status).toBe(200);
    await install;
    // The provider and auth method changed, but the worker reads them live: the one start is the funnel's own.
    expect(readSettings()).toMatchObject({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription' });
    expect(workerStarts).toBe(1);
    expect(extraction.restartsWhileRunning).toBe(0);
    expect(extraction.running).toBe(true);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).status).toBe('complete');
    expect(lines.join('\n')).toContain('claude-mem installed successfully!');
  });

  it('a machine with a saved signup reopens the GUI without repeating the terminal questions', async () => {
    writeFileSync(settingsPath, JSON.stringify({ ...baseSettings, CLAUDE_MEM_ONLINE_SIGNUP_EMAIL: 'saved@example.com', CLAUDE_MEM_ONLINE_SIGNUP_SENT: 'true' }));
    writeFileSync(statePath, JSON.stringify({ status: 'complete', choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'x' }, installer: null, completedAt: 'x' }));
    const install = runInstallCommand({});
    const state = await waitForStage('waiting-for-choice');
    expect(state.install.status).toBe('ready');
    expect(questions).toEqual([]);
    expect(signupRequests).toEqual([]);
    await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' });
    await waitForStage('home-ready');
    await browserPost('/api/setup/complete', {});
    await install;
    expect(opened).toEqual([`${workerBase}/?setup=1`]);
  });

  it('a machine with a working configuration keeps it: the choice reports home-kept-existing and nothing rewrites the settings', async () => {
    // The kept-existing path (design 4a): a persisted provider is never
    // re-answered — no useSubscriptionAuth wipe, no GPUStack defaults rewrite —
    // and the funnel names that outcome home-kept-existing.
    writeFileSync(settingsPath, JSON.stringify({
      ...baseSettings,
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_API_KEY: 'kept-gateway-key',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://gpustack.data.lmru.tech/v1',
      CLAUDE_MEM_OPENROUTER_MODEL: 'glm-5.3-flash',
    }, null, 2));
    const install = runInstallCommand({});
    await waitForStage('waiting-for-choice');
    // The worker serves the machine as already configured: the page answers the choice itself.
    expect((await browserState()).alreadyPro).toBe(true);
    // The agent-install hand-off may write its own keys; the choice application must not.
    const beforeChoice = readFileSync(settingsPath, 'utf8');
    expect((await browserPost('/api/setup/choice', { branch: 'home', memoryBilling: 'existing' })).status).toBe(200);
    await waitForStage('home-kept-existing');
    expect(readFileSync(settingsPath, 'utf8')).toBe(beforeChoice);
    expect((await browserPost('/api/setup/complete', {})).status).toBe(200);
    await install;
    expect(readFileSync(settingsPath, 'utf8')).toBe(beforeChoice);
    expect(pairingStarts).toEqual([]);
    expect(questions).toEqual([]);
    expect(unexpected).toEqual([]);
    expect(lines.join('\n')).toContain('Account:     Kept existing configuration');
  });

  it('a --provider host install says no account is needed', async () => {
    await runInstallCommand({ provider: 'host' });
    expect(pairingStarts).toEqual([]);
    expect(lines.join('\n')).toContain('Not required (host observer)');
  });

  it('a deferred install whose worker does not start fails instead of pointing at a dead setup page', async () => {
    fixtureWorkerResult = 'dead';
    const previousExitCode = process.exitCode;
    try {
      await runInstallCommand({ setup: 'defer' });
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = previousExitCode ?? 0; }
    expect(lines.join('\n')).toContain('the worker did not start');
    expect(lines.join('\n')).not.toContain('Setup is waiting at');
  });

  it('a deferred install with --no-auto-start leaves the worker to the caller and still succeeds', async () => {
    fixtureWorkerResult = 'dead';
    const previousExitCode = process.exitCode;
    try {
      await runInstallCommand({ setup: 'defer', noAutoStart: true });
      expect(process.exitCode ?? 0).toBe(0);
    } finally { process.exitCode = previousExitCode ?? 0; }
    expect(workerStarts).toBe(0);
    expect(lines.join('\n')).toContain('Setup is waiting at');
  });

  it('a reinstall whose worker does not start keeps a completed setup complete', async () => {
    const completed = { status: 'complete', choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'earlier' },
      installer: { stage: 'home-ready', error: null, updatedAt: 'earlier' }, checkout: null, tools: null, completedAt: 'earlier' };
    writeFileSync(statePath, JSON.stringify(completed));
    fixtureWorkerResult = 'dead';
    await expect(runInstallCommand({})).rejects.toThrow('The setup page needs the worker');
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({ status: 'complete', completedAt: 'earlier' });
  });

  it('releases the GUI session when the worker fails while preserving saved setup state', async () => {
    fixtureWorkerResult = 'dead';
    await expect(runInstallCommand({})).rejects.toThrow('The setup page needs the worker');
    expect(workerStartStates[0]).toMatchObject({ status: 'pending' });
    expect(workerStartSessions[0]).toMatchObject({ pid: process.pid, already_pro: false });
    expect(JSON.parse(readFileSync(statePath, 'utf8')).status).toBe('pending');
    expect(existsSync(sessionPath)).toBe(false);
    expect(opened).toEqual([]);
    expect(questions).toEqual([]);
  });

  it('releases the GUI session when the browser handoff fails and propagates the server error', async () => {
    fetchSpy.mockImplementationOnce(async () => {
      expect(JSON.parse(readFileSync(sessionPath, 'utf8'))).toMatchObject({ pid: process.pid, already_pro: false });
      return Response.json({ error: 'This setup session was refused by the worker.' }, { status: 403 });
    });
    await expect(runInstallCommand({})).rejects.toThrow('This setup session was refused by the worker.');
    expect(JSON.parse(readFileSync(statePath, 'utf8')).status).toBe('pending');
    expect(existsSync(sessionPath)).toBe(false);
  });
});

describe('update keeps completed setup and asks only for missing requirements', () => {
  const complete = { status: 'complete', choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'earlier' },
    installer: null, checkout: null, tools: ['claude-code'], completedAt: 'earlier' };
  const account = { CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'keep-sync', CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'keep-user',
    CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.example.test', CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'keep-device' };
  const provision = (settings: Record<string, string>, state: unknown = complete) => {
    writeFileSync(settingsPath, JSON.stringify({ ...baseSettings, ...settings }));
    if (state) writeFileSync(statePath, JSON.stringify(state));
  };
  const expectPureUpdate = () => {
    expect(questions).toEqual([]);
    expect(opened).toEqual([]);
    expect(setupRequests).toEqual([]);
    expect(pairingStarts).toEqual([]);
    expect(offeredTasks).toContain('Caching plugin version');
    expect(offeredTasks).toContain('Copying plugin files to marketplace');
    expect(lines.join('\n')).toContain('claude-mem updated successfully!');
    expect(lines.join('\n')).not.toContain('Memory injection starts on your second session');
  };

  it('updates a completed Pro setup without login, checkout, preferences or onboarding', async () => {
    const settings = { ...account, CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_API_KEY: 'keep-memory-key',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/gateway/v1', CLAUDE_MEM_OPENROUTER_MODEL: 'keep-model',
      CLAUDE_MEM_SKILLS_DISABLED: 'review', CLAUDE_MEM_RUNTIME: 'worker' };
    provision(settings);
    const before = readFileSync(statePath, 'utf8');
    await runInstallCommand({ update: true });
    expectPureUpdate();
    expect(readSettings()).toMatchObject(settings);
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    expect(workerStarts).toBe(1);
  });

  it('keeps Claude auth, its custom model and cloud sync without rewriting local credentials', async () => {
    const settings = { ...account, CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'gateway',
      CLAUDE_MEM_MODEL: 'my-custom-model' };
    provision(settings);
    const envPath = process.env.CLAUDE_MEM_ENV_FILE!;
    writeFileSync(envPath, 'ANTHROPIC_API_KEY=keep-key\nANTHROPIC_BASE_URL=https://gateway.example.test\n');
    try {
      const before = readFileSync(envPath, 'utf8');
      await runInstallCommand({ update: true });
      expectPureUpdate();
      expect(readSettings()).toMatchObject(settings);
      expect(readFileSync(envPath, 'utf8')).toBe(before);
    } finally { rmSync(envPath, { force: true }); }
  });

  it('updates a legacy default-Claude installation without an overwrite or onboarding prompt', async () => {
    const markerDir = join(cliPaths.marketplaceDirectory(), 'plugin', '.claude-plugin');
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, 'plugin.json'), JSON.stringify({ version: '1.0.0' }));
    provision(account, null);
    try {
      const before = readFileSync(settingsPath, 'utf8');
      const options: import('../../src/npx-cli/commands/install.js').InstallOptions = { update: true };
      await runInstallCommand(options);
      expectPureUpdate();
      expect(readFileSync(settingsPath, 'utf8')).toBe(before);
      expect(options.provider).toBe('claude');
    } finally { rmSync(join(markerDir, 'plugin.json'), { force: true }); }
  });

  for (const provider of ['codex', 'gemini', 'openai-compatible']) {
    it(`keeps a legacy ${provider} setup without a browser completion marker`, async () => {
      const settings = { ...account, CLAUDE_MEM_PROVIDER: provider, CLAUDE_MEM_GEMINI_API_KEYS: 'one,two',
        CLAUDE_MEM_OPENAI_COMPAT_PRESET: 'ollama', CLAUDE_MEM_CODEX_MODEL: 'keep-pin' };
      provision(settings, null);
      await runInstallCommand({ update: true });
      expectPureUpdate();
      expect(readSettings()).toMatchObject(settings);
      expect(existsSync(statePath)).toBe(false);
    });
  }

  for (const runtime of ['server', 'server-beta']) {
    it(`keeps the saved ${runtime} endpoint and credentials without bootstrap or a worker start`, async () => {
      const settings = { CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_RUNTIME: runtime,
        CLAUDE_MEM_SERVER_URL: 'https://my-server.example.test', CLAUDE_MEM_SERVER_API_KEY: 'keep-server-key',
        CLAUDE_MEM_SERVER_PROJECT_ID: 'keep-project' };
      provision(settings);
      await runInstallCommand({ update: true });
      expectPureUpdate();
      expect(readSettings()).toMatchObject(settings);
      expect(workerStarts).toBe(0);
      expect(unexpected).toEqual([]);
    });
  }

  it('refreshes the saved agent selection and preserves unfinished browser progress', async () => {
    const state = { ...complete, status: 'pending', completedAt: null,
      install: { status: 'ready', selection: { agents: ['cursor'], dshProfile: 'saved-profile' } }, tools: ['codex'] };
    provision({ CLAUDE_MEM_PROVIDER: 'claude' }, state);
    await runInstallCommand({ update: true });
    expectPureUpdate();
    expect(offeredTasks).toContain('Cursor: installing hooks + MCP');
    expect(offeredTasks.some(title => title.startsWith('Codex'))).toBe(true);
    expect(questions).not.toContain('Which agents do you use?');
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(state);
  });

  it('asks only for the missing Gemini key and keeps the rest of the configuration', async () => {
    const settings = { ...account, CLAUDE_MEM_PROVIDER: 'gemini', CLAUDE_MEM_GEMINI_MODEL: 'keep-model' };
    provision(settings);
    await runInstallCommand({ update: true });
    expect(questions).toEqual(['Paste your Gemini API key:']);
    expect(readSettings()).toMatchObject({ ...settings, CLAUDE_MEM_GEMINI_API_KEY: 'new-provider-key' });
    expect(pairingStarts).toEqual([]);
    expect(opened).toEqual([]);
    // The repaired field counts as completed on the next update.
    questions.length = 0;
    await runInstallCommand({ update: true });
    expect(questions).toEqual([]);
  });

  it('keeps a personal endpoint and model when repairing its missing OpenRouter key', async () => {
    const settings = { ...account, CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://personal.example.test/v1', CLAUDE_MEM_OPENROUTER_MODEL: 'custom-model' };
    provision(settings);
    await runInstallCommand({ update: true });
    expect(questions).toEqual(['Paste your OpenRouter API key:']);
    expect(readSettings()).toMatchObject({ ...settings, CLAUDE_MEM_OPENROUTER_API_KEY: 'new-provider-key' });
    expect(pairingStarts).toEqual([]);
  });

  it('does not switch providers or erase sync when missing-key setup is cancelled', async () => {
    const settings = { ...account, CLAUDE_MEM_PROVIDER: 'gemini' };
    provision(settings);
    passwordAnswer = prompts.CANCEL_SYMBOL;
    await expect(runInstallCommand({ update: true })).rejects.toThrow('Provider setup cancelled');
    expect(readSettings()).toMatchObject(settings);
    expect(lines.join('\n')).not.toContain('updated successfully');
  });

  it('aborts an update whose saved gateway key is missing, without touching the configuration', async () => {
    provision({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/gateway/v1' });
    // The local-only build has no account flow to refill a gateway key: say how
    // to restore it instead of starting an OAuth login.
    await expect(runInstallCommand({ update: true })).rejects.toThrow('EXIT_1');
    expect(questions).toEqual([]);
    expect(setupRequests).toEqual([]);
    expect(pairingStarts).toEqual([]);
    expect(opened).toEqual([]);
    expect(lines.join('\n')).toContain('Save CLAUDE_MEM_OPENROUTER_API_KEY in ~/.claude-mem/settings.json');
    expect(lines.join('\n')).not.toContain('updated successfully');
    expect(readSettings().CLAUDE_MEM_OPENROUTER_API_KEY).toBeUndefined();
    expect(readSettings().CLAUDE_MEM_PROVIDER).toBe('openrouter');
  });

  it('asks for an unconfigured provider without replaying completed agent setup', async () => {
    provision({});
    await runInstallCommand({ update: true });
    // No provider menu any more: an interactive run with no provider goes to
    // the internal model gateway and asks for the missing key in the terminal.
    expect(questions).toEqual(['Paste your GPUStack API key:']);
    expect(setupRequests).toEqual([]);
    expect(opened).toEqual([]);
    // Completed setup is a chosen machine: an update saves only the key it
    // asked for and never rewrites the provider keys — the GPUStack defaults
    // are for machines that never finished setup (isFreshProviderInstall).
    expect(readSettings()).toMatchObject({ CLAUDE_MEM_OPENROUTER_API_KEY: 'new-provider-key' });
    expect(readSettings().CLAUDE_MEM_PROVIDER).toBeUndefined();
    expect(readSettings().CLAUDE_MEM_OPENROUTER_BASE_URL).toBeUndefined();
    expect(readSettings().CLAUDE_MEM_OPENROUTER_MODEL).toBeUndefined();
  });
});

describe('install with --provider claude (interactive TTY)', () => {
  it('preserves interrupted browser progress and leaves local work unpaused', async () => {
    const saved = { status: 'pending', choice: { branch: 'home', memoryBilling: 'existing', chosenAt: 'earlier' },
      installer: { stage: 'home-ready', error: null, updatedAt: 'earlier' }, checkout: null, tools: ['codex'], completedAt: null };
    writeFileSync(statePath, JSON.stringify(saved));
    writeFileSync(sessionPath, JSON.stringify({ pid: 2 ** 22 + 12345 }));
    await runInstallCommand({ provider: 'claude', providerSource: 'flag' });
    expect(opened).toEqual([]);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual(saved);
    expect((worker!.routes as unknown as { setupIsActive: () => boolean }).setupIsActive()).toBe(false);
  });

  it('keeps the terminal flow: no setup page, no login, the model question in the terminal', async () => {
    await runInstallCommand({ provider: 'claude', providerSource: 'flag' });
    expect(opened).toEqual([]);
    expect(setupRequests).toEqual([]);
    expect(pairingStarts).toEqual([]);
    expect(questions.some(q => q.startsWith('Which Claude model'))).toBe(true);
    expect(readSettings()).toMatchObject({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription' });
    expect(lines.join('\n')).toContain('Skipping claude-mem sign-in: this build installs fully locally.');
    expect(existsSync(statePath)).toBe(false);
    expect(workerStartStates.every(state => state === null)).toBe(true);
    expect(workerStartSettings).not.toHaveLength(0);
    for (const settings of workerStartSettings) {
      expect(settings).toMatchObject({ CLAUDE_MEM_PROVIDER: 'claude', CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription' });
    }
  });
});

// #5675 site 3: the owner chose a personal key with --provider. Cancelling the key prompt is a stop,
// never a request for the Anthropic plan.
describe('install with --provider gemini|openrouter and no key (interactive TTY)', () => {
  for (const [provider, label] of [['gemini', 'Gemini'], ['openrouter', 'GPUStack']] as const) {
    it(`cancelling the ${label} key prompt stops the install and writes no provider`, async () => {
      const before = readFileSync(settingsPath, 'utf8');
      passwordAnswer = prompts.CANCEL_SYMBOL;
      if (provider === 'gemini') {
        // The owner named gemini with --provider: a cancel prints a cancel line and exits 1.
        await expect(promptProvider({ provider, providerSource: 'flag' })).rejects.toThrow('EXIT_1');
        expect(lines.join('\n')).toContain('Gemini setup cancelled');
      } else {
        // The gateway prompt throws its remediation without touching settings.
        await expect(promptProvider({ provider, providerSource: 'flag' }))
          .rejects.toThrow('Setup cancelled: no GPUStack API key was entered');
      }
      expect(questions).toEqual([`Paste your ${label} API key:`]);
      expect(readFileSync(settingsPath, 'utf8')).toBe(before);
      expect(readSettings().CLAUDE_MEM_PROVIDER).toBeUndefined();
      expect(lines.join('\n')).not.toContain('falling back to Claude');
    });

    it(`a pasted ${label} key still saves the chosen provider`, async () => {
      await promptProvider({ provider, providerSource: 'flag' });
      expect(readSettings().CLAUDE_MEM_PROVIDER).toBe(provider);
    });
  }
});

}
