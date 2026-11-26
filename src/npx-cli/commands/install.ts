import * as p from '@clack/prompts';
import { styleText } from 'node:util';
import { spawnSync } from 'child_process';
import { explainTelemetryConsent, loadTelemetryConfig, recordTelemetryDecision } from '../../services/telemetry/consent.js';
import { captureCliEvent } from '../../services/telemetry/cli-telemetry.js';
import { spawnHidden } from '../../shared/spawn.js';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { applyConfiguredSkillSelection, readDisabledSkills, skillSelectionFailureMessage } from '../../shared/skill-selection.js';
import { RUNTIME_REQUIRED_SKILLS } from '../../shared/runtime-skills.js';
import type { SetupInstallCatalog, SetupInstallSelection, SetupMode } from '../../shared/setup-install.js';
import { readProjectAttribution, replaceOwnedFiles } from '../../shared/owned-file-install.js';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { SettingsDefaultsManager, type SettingsDefaults } from '../../shared/SettingsDefaultsManager.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { loadClaudeMemEnv, saveClaudeMemEnv } from '../../shared/EnvManager.js';
import { ensureWorkerStarted, getLastWorkerBootFailure, type WorkerStartResult } from '../../services/worker-spawner.js';
import { formatHostForUrl } from '../../shared/worker-utils.js';
import { readLocalApiToken } from '../../shared/hook-settings.js';
import { localApiTokenHeadersFor } from '../../shared/local-api-token.js';
import {
  ensureBun,
  ensureUv,
  installPluginDependencies,
  provisionTreeSitterCli,
  writeInstallMarker,
  isInstallCurrent,
  getBunPath,
} from '../install/setup-runtime.js';
import { playBanner } from '../banner.js';
import { normalizeRuntimeFlag } from './server-runtime-setup.js';
import { ErrorSeverity } from '../install/error-taxonomy.js';
import {
  clearLastInstallError,
  createInstallSummary,
  flushSummary,
  installerError,
  InstallAbortError,
  type InstallSummary,
} from '../install/error-reporter.js';
import { extractEresolveBlock, isEresolve, npmErrorCode, runNpmStrict } from '../install/npm-install-helper.js';
import { openBrowser } from '../install/open-browser.js';
import { isInteractive, log } from '../install/cli-io.js';
import { mergeSettings } from '../install/settings-io.js';
import { isCmemGatewayUrl } from '../../shared/cmem-gateway.js';
import {
  buildAnthropicMaxLocalSettings,
  buildHostObserverSettings,
} from '../cmem-memory-credentials.js';
import { endSetupSession, hasExistingConfiguration, INITIAL_SETUP_STATE, readSetupState, startSetupSession, writeSetupState } from '../../shared/setup-state.js';
import { AGENT_BROWSER_SETUP_HINT, runBrowserSetup, settingsChangesNeedingRestart, shouldPrintAgentBrowserSetupHint, shouldUseBrowserSetup, waitForBackgroundWorkToFinish, type BrowserSetupOutcome } from '../install/browser-setup.js';

function getSetting<K extends keyof SettingsDefaults>(key: K): SettingsDefaults[K] {
  return SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH)[key];
}

/** How long `install` waits for the tree-sitter CLI download before warning and moving on. */
const TREE_SITTER_INSTALL_BUDGET_MS = 2 * 60 * 1000;

/**
 * Which package manager launched this CLI (npx / bunx / pnpm / yarn), parsed
 * from npm_config_user_agent ("npm/10.8.2 node/v22.14.0 darwin arm64 ...").
 * Bounded enum for telemetry — never raw user-agent content.
 */
function detectInstallMethod(): string {
  const agent = process.env.npm_config_user_agent ?? '';
  const name = agent.split('/')[0]?.trim().toLowerCase();
  if (name === 'npm' || name === 'bun' || name === 'pnpm' || name === 'yarn') return name;
  if (process.versions.bun) return 'bun';
  return 'unknown';
}

interface TaskDescriptor {
  title: string;
  task: (message: (msg: string) => void) => Promise<string>;
}

async function runTasks(tasks: TaskDescriptor[]): Promise<void> {
  if (isInteractive) {
    await p.tasks(tasks);
  } else {
    for (const t of tasks) {
      const result = await t.task((msg: string) => console.log(`  ${msg}`));
      console.log(`  ${result}`);
    }
  }
}

/**
 * Tick a task's spinner message with elapsed seconds. The multi-minute
 * dependency installs used to sit on one static message (and previously a
 * blocked event loop), which read as a stalled install. Returns a stop
 * function for a finally block. Non-interactive runs get the label once —
 * a per-second console.log line would spam CI logs.
 */
function startHeartbeat(message: (msg: string) => void, label: string): () => void {
  message(label);
  if (!isInteractive) return () => {};
  const started = Date.now();
  const timer = setInterval(() => {
    const elapsed = Math.round((Date.now() - started) / 1000);
    message(`${label} ${styleText('dim', `(${elapsed}s — still working)`)}`);
  }, 1000);
  return () => clearInterval(timer);
}

async function bufferConsole<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
  if (!isInteractive) {
    const result = await fn();
    return { result, output: '' };
  }
  let buffer = '';
  const append = (...args: unknown[]) => {
    buffer += args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n';
  };
  const orig = { log: console.log, error: console.error, warn: console.warn };
  console.log = append;
  console.error = append;
  console.warn = append;
  try {
    const result = await fn();
    return { result, output: buffer };
  } finally {
    console.log = orig.log;
    console.error = orig.error;
    console.warn = orig.warn;
  }
}

import {
  claudeSettingsPath,
  ensureDirectoryExists,
  installedPluginsPath,
  IS_WINDOWS,
  knownMarketplacesPath,
  marketplaceDirectory,
  npmPackagePluginDirectory,
  npmPackageRootDirectory,
  pluginCacheDirectory,
  pluginsDirectory,
  readPluginVersion,
  writeJsonFileAtomic,
} from '../utils/paths.js';
import { describeProcessNameOverride, describePrunedVersion, prunePluginCacheSafely } from '../utils/prune-cache.js';
import { isUserScopeRegistration } from '../../shared/claude-code-plugin-paths.js';
import { readJsonSafe } from '../../utils/json-utils.js';
import { clearClaudeAutoMemoryOverride } from '../utils/claude-auto-memory.js';
import { readFlatSettings } from '../utils/settings.js';
import { shutdownWorkerAndWait, type ShutdownBlocker } from '../../services/install/shutdown-helper.js';
import { holdSpawnLock, SPAWN_LOCK_STALE_MS } from '../../shared/worker-spawn-gate.js';
import { readOwnedWorkerPidInfo, type PidInfo } from '../../supervisor/process-registry.js';
import { isWorkerAutostartDisabled } from '../../shared/worker-autostart.js';
import { isInstallRunByAutoUpdate } from '../../shared/auto-update-install-run.js';
import { stripLegacyClaudeMemAlias } from './uninstall.js';
import { detectInstalledIDEs } from './ide-detection.js';
import { initialIDESelection } from './ide-detection.js';
import { canonicalIntegrationId } from '../../shared/integration-id.js';
import { checkWindowsGitBash } from '../utils/windows-git-bash-preflight.js';
import { claudeCodeVersionTooOldWarning, detectClaudeCodeVersion } from '../install/claude-code-version.js';
import { ensureLauncherOnPath, ensureLocalBinOnShellPath } from '../../launcher/install-launcher.js';

/**
 * Records the thedotmack marketplace in Claude Code's known_marketplaces.json
 * on every install and update. Exported, as registerPlugin is, so tests pin
 * what it writes (tests/services/auto-update/auto-update-check.test.ts). The
 * auto-updater leaves an entry this would not write as it is
 * (auto-update-check.ts claudeMemMarketplaceEntryDifference).
 */
export function registerMarketplace(): void {
  const knownMarketplaces = readJsonSafe<Record<string, any>>(knownMarketplacesPath(), {});

  knownMarketplaces['thedotmack'] = {
    source: {
      source: 'github',
      repo: 'thedotmack/claude-mem',
    },
    installLocation: marketplaceDirectory(),
    lastUpdated: new Date().toISOString(),
    autoUpdate: claudeCodeBackgroundUpdateToRegister(knownMarketplaces['thedotmack']),
  };

  ensureDirectoryExists(pluginsDirectory());
  writeJsonFileAtomic(knownMarketplacesPath(), knownMarketplaces);
}

/**
 * The autoUpdate registerMarketplace records for Claude Code's background
 * update of the thedotmack marketplace: an existing entry's autoUpdate as it
 * is, unset included, and true for a new entry, what every install recorded
 * before claude-mem had its own updater. The installer never turns it off.
 * Only the worker does (auto-update-check.ts settleClaudeCodeBackgroundUpdate),
 * once its own updater has shown it works on this machine: a check read the
 * promoted file and npm's metadata from here, and npx is on the worker's PATH.
 * Nothing the installer can read shows either, and turning Claude Code's update
 * off where claude-mem's cannot work would leave the install with no updater.
 * Keeping an existing value also keeps a false the worker wrote, so an update,
 * the auto-updater's own installer run included, never turns Claude Code's
 * update back on.
 */
function claudeCodeBackgroundUpdateToRegister(existingEntry: unknown): unknown {
  const isEntry = typeof existingEntry === 'object' && existingEntry !== null && !Array.isArray(existingEntry);
  return isEntry ? (existingEntry as Record<string, unknown>).autoUpdate : true;
}

/**
 * Every install writes this entry, for every host (the task list in
 * runInstallCommandInner registers the plugin whatever --ide selects). The
 * auto-updater reads its presence as "still installed" (auto-update-check.ts
 * readClaudeCodePluginState), which tests pin against this function.
 *
 * Only the user-scope entry is this installer's (claude-code-plugin-paths.ts
 * isUserScopeRegistration): it replaces that one, where it was, or adds it
 * when there is none. Every other entry of claude-mem@thedotmack, a project's
 * or a local install Claude Code registered at a version of its own, is kept
 * exactly as read and in its place, so an update, including an unattended
 * one the auto-updater runs, never unregisters it. Any further user-scope
 * entry is dropped, as before: an install has one.
 */
export function registerPlugin(version: string): void {
  const installedPlugins = readJsonSafe<Record<string, any>>(installedPluginsPath(), {});

  if (!installedPlugins.version) installedPlugins.version = 2;
  if (!installedPlugins.plugins) installedPlugins.plugins = {};

  const cachePath = pluginCacheDirectory(version);
  const now = new Date().toISOString();
  const userScopeEntry = {
    scope: 'user',
    installPath: cachePath,
    version,
    installedAt: now,
    lastUpdated: now,
  };

  const registered: unknown = installedPlugins.plugins['claude-mem@thedotmack'];
  const entriesAsRead: unknown[] = Array.isArray(registered) ? registered : [];
  const userScopeIndex = entriesAsRead.findIndex(isUserScopeRegistration);
  installedPlugins.plugins['claude-mem@thedotmack'] = userScopeIndex === -1
    ? [...entriesAsRead, userScopeEntry]
    : entriesAsRead.flatMap((entry, index) => {
        if (index === userScopeIndex) return [userScopeEntry];
        return isUserScopeRegistration(entry) ? [] : [entry];
      });

  writeJsonFileAtomic(installedPluginsPath(), installedPlugins);
}

function enablePluginInClaudeSettings(): void {
  const settings = readJsonSafe<Record<string, any>>(claudeSettingsPath(), {});

  if (!settings.enabledPlugins) settings.enabledPlugins = {};
  settings.enabledPlugins['claude-mem@thedotmack'] = true;

  writeJsonFileAtomic(claudeSettingsPath(), settings);
}

/**
 * Disable Claude Code's built-in auto-memory by setting CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
 * in ~/.claude/settings.json `env` block. claude-mem provides its own persistent memory
 * via plugin hooks; the built-in MEMORY.md system creates shadow state outside the user's
 * control and competes with claude-mem for context window tokens.
 *
 * Per anthropics/claude-code#23544, the env var is the only supported toggle.
 *
 * Idempotent: only writes when not already set, preserves existing env vars and other
 * settings keys, and merges atomically. Returns true when a write happened (for the
 * caller to surface in the install summary).
 */
export function disableClaudeAutoMemory(): boolean {
  const settings = readJsonSafe<Record<string, any>>(claudeSettingsPath(), {});
  const env = (settings.env && typeof settings.env === 'object') ? settings.env : {};

  if (env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1') {
    return false;
  }

  settings.env = { ...env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  writeJsonFileAtomic(claudeSettingsPath(), settings);
  return true;
}

/** The browser checkbox is a reversible setting, including on reinstallation. */
export function enableClaudeAutoMemory(): void {
  const settings = readJsonSafe<Record<string, any>>(claudeSettingsPath(), {});
  if (clearClaudeAutoMemoryOverride(settings)) writeJsonFileAtomic(claudeSettingsPath(), settings);
}

type ClaudeAutoMemoryChoice = 'disable' | 'leave-enabled' | 'not-applicable';

export async function resolveClaudeAutoMemoryChoice(
  selectedIDEs: string[],
  options: InstallOptions,
): Promise<ClaudeAutoMemoryChoice> {
  if (!selectedIDEs.includes('claude-code')) {
    return 'not-applicable';
  }

  if (options.disableAutoMemory) {
    return 'disable';
  }

  // Updating never changes or re-asks this optional preference.
  if (options.update) return 'not-applicable';

  if (!isInteractive) {
    return 'leave-enabled';
  }

  const choice = await p.select<'leave-enabled' | 'disable'>({
    message: 'Disable Claude Code auto-memory?',
    options: [
      {
        value: 'leave-enabled',
        label: 'Leave enabled',
        hint: 'Recommended; keeps Claude Code native memory visible on startup.',
      },
      {
        value: 'disable',
        label: 'Disable auto-memory',
        hint: 'Only if you explicitly want claude-mem to replace native startup memory.',
      },
    ],
    initialValue: 'leave-enabled',
  });

  // @clack/prompts 1.8: isCancel narrows to unique CANCEL_SYMBOL, not generic symbol.
  if (p.isCancel(choice) || typeof choice === 'symbol') {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  return choice;
}

export function makeIDETask(ideId: string, summary: InstallSummary, dshProfile?: string): TaskDescriptor | null {
  const recordFailure = (label: string, output: string) => {
    // Route every per-IDE failure through the central decision point. A single
    // IDE failure is FAIL_LOUD_PER_IDE (partial install); the summary headline
    // and exit code reflect it. The stderr is preserved verbatim in `details`.
    installerError(ErrorSeverity.FAIL_LOUD_PER_IDE, {
      component: label,
      ide: ideId,
      phase: 'ide-install',
      cause: new Error(label),
      details: output && output.trim().length > 0 ? output.trim().slice(0, 4000) : undefined,
    }, summary);
  };

  switch (ideId) {
    case 'claude-code': {
      return {
        title: 'Claude Code: registering plugin',
        task: async () => `Claude Code: plugin registered ${styleText('green', 'OK')}`,
      };
    }

    case 'cursor': {
      return {
        title: 'Cursor: installing hooks + MCP',
        task: async (message) => {
          message('Loading Cursor installer…');
          const { installCursorHooks, configureCursorMcp } = await import('../../services/integrations/CursorHooksInstaller.js');
          message('Installing Cursor hooks…');
          const { result: cursorResult, output: hooksOutput } = await bufferConsole(() => installCursorHooks('user'));
          if (cursorResult !== 0) {
            recordFailure('Cursor: hook installation failed', hooksOutput);
            return `Cursor: hook installation failed ${styleText('red', 'FAIL')}`;
          }
          message('Configuring Cursor MCP…');
          const { result: mcpResult } = await bufferConsole(async () => configureCursorMcp('user'));
          if (mcpResult === 0) {
            return `Cursor: hooks + MCP installed ${styleText('green', 'OK')}`;
          }
          return `Cursor: hooks installed; MCP setup failed — run \`npx claude-mem mcp\` ${styleText('yellow', '!')}`;
        },
      };
    }

    case 'grok-bot': {
      return {
        title: 'Grok Bot: installing transcript watch',
        task: async (message) => {
          message('Configuring Grok Bot transcript watch…');
          const { installGrokBotIntegration } = await import('../../services/integrations/GrokBotInstaller.js');
          const { result, output } = await bufferConsole(async () => installGrokBotIntegration());
          if (result !== 0) {
            recordFailure('Grok Bot: transcript watch installation failed', output);
            return `Grok Bot: transcript watch installation failed ${styleText('red', 'FAIL')}`;
          }
          return `Grok Bot: transcript watch installed ${styleText('green', 'OK')}`;
        },
      };
    }

    case 'kimi': {
      return {
        title: 'Kimi Code: installing hooks + MCP',
        task: async (message) => {
          message('Loading Kimi installer…');
          const { installKimiHooks, configureKimiMcp } = await import('../../services/integrations/KimiHooksInstaller.js');
          message('Installing Kimi hooks…');
          const { result: hooksResult, output: hooksOutput } = await bufferConsole(async () => installKimiHooks());
          if (hooksResult !== 0) {
            recordFailure('Kimi Code: hook installation failed', hooksOutput);
            return `Kimi Code: hook installation failed ${styleText('red', 'FAIL')}`;
          }
          message('Configuring Kimi MCP…');
          const { result: mcpResult } = await bufferConsole(async () => configureKimiMcp());
          if (mcpResult === 0) {
            return `Kimi Code: hooks + MCP installed ${styleText('green', 'OK')}`;
          }
          return `Kimi Code: hooks installed; MCP setup failed — run \`npx claude-mem kimi install\` ${styleText('yellow', '!')}`;
        },
      };
    }

    case 'devin': {
      return {
        title: 'Devin: installing hooks + MCP',
        task: async (message) => {
          message('Loading Devin installer…');
          const { installDevinHooks, configureDevinMcp } = await import('../../services/integrations/DevinHooksInstaller.js');
          message('Installing Devin hooks…');
          const { result, output } = await bufferConsole(async () => installDevinHooks());
          if (result !== 0) {
            recordFailure('Devin: hook installation failed', output);
            return `Devin: hook installation failed ${styleText('red', 'FAIL')}`;
          }
          message('Configuring Devin MCP…');
          const { result: mcpResult, output: mcpOutput } = await bufferConsole(async () => configureDevinMcp());
          if (mcpResult === 0) {
            return `Devin: hooks + MCP installed ${styleText('green', 'OK')}`;
          }
          installerError(ErrorSeverity.WARN_CONTINUE, {
            component: 'devin',
            ide: 'devin',
            phase: 'ide-install',
            cause: new Error('Devin hooks installed, but MCP setup failed.'),
            remediation: 'Fix the problem named above, then run `npx claude-mem devin install`.',
            details: mcpOutput,
          }, summary);
          return `Devin: hooks installed; MCP setup failed — run \`npx claude-mem devin install\` ${styleText('yellow', '!')}`;
        },
      };
    }

    case 'opencode': {
      return {
        title: 'OpenCode: installing plugin',
        task: async (message) => {
          message('Loading OpenCode installer…');
          const {
            installOpenCodeIntegration,
            getOpenCodeAgentsMdPath,
            OPENCODE_MCP_REGISTRATION_INCOMPLETE,
            OPENCODE_OLD_CONTEXT_BLOCK_LEFT,
          } = await import('../../services/integrations/OpenCodeInstaller.js');
          message('Installing OpenCode plugin…');
          const { result, output } = await bufferConsole(() => installOpenCodeIntegration());
          if (result === OPENCODE_MCP_REGISTRATION_INCOMPLETE) {
            // The plugin is installed; only the MCP entry is missing. That is a
            // partial install, not a failed IDE: record a WARN_CONTINUE warning
            // (exit 0) and keep the integration's captured output so its
            // remediation reaches the user after the spinners.
            installerError(ErrorSeverity.WARN_CONTINUE, {
              component: 'opencode',
              phase: 'ide-install',
              cause: new Error('OpenCode plugin installed, but MCP registration is incomplete (mcp-server.cjs not found).'),
              remediation: 'Restore the plugin build, then re-run `npx claude-mem install --ide=opencode` to register the MCP server.',
              details: output,
            }, summary);
            return `OpenCode: plugin installed; MCP registration incomplete ${styleText('yellow', '!')}`;
          }
          if (result === OPENCODE_OLD_CONTEXT_BLOCK_LEFT) {
            // Installed, but the stale memory block an older install wrote into
            // the global AGENTS.md is still there: a warning with the remedy.
            installerError(ErrorSeverity.WARN_CONTINUE, {
              component: 'opencode',
              phase: 'ide-install',
              cause: new Error(`OpenCode plugin installed, but the old claude-mem memory block in ${getOpenCodeAgentsMdPath()} could not be removed; OpenCode shows it in every project.`),
              remediation: 'Delete the <claude-mem-context> block from that file (or fix its permissions and re-run `npx claude-mem install --ide=opencode`).',
              details: output,
            }, summary);
            return `OpenCode: plugin installed; old AGENTS.md memory block left in place ${styleText('yellow', '!')}`;
          }
          if (result !== 0) {
            recordFailure('OpenCode: plugin installation failed', output);
            return `OpenCode: plugin installation failed ${styleText('red', 'FAIL')}`;
          }
          return `OpenCode: plugin installed ${styleText('green', 'OK')}`;
        },
      };
    }

    case 'hermes': {
      return {
        title: 'Hermes Agent: installing memory provider',
        task: async (message) => {
          message('Loading Hermes installer…');
          const { installHermesIntegration } = await import('../../services/integrations/HermesInstaller.js');
          message('Installing the memory provider plugin…');
          const { result, output } = await bufferConsole(async () => installHermesIntegration());
          if (result !== 0) {
            recordFailure('Hermes Agent: memory provider installation failed', output);
            return `Hermes Agent: memory provider installation failed ${styleText('red', 'FAIL')}`;
          }
          return `Hermes Agent: memory provider installed ${styleText('green', 'OK')}`;
        },
      };
    }

    case 'pi': {
      return {
        title: 'Pi: installing memory extension',
        task: async () => {
          const { installPiExtension } = await import('../../services/integrations/PiInstaller.js');
          const { result, output } = await bufferConsole(async () => installPiExtension());
          if (result !== 0) {
            recordFailure('Pi: memory extension installation failed', output);
            return 'Pi: extension installation failed';
          }
          return 'Pi: extension files installed; automatic capture is unverified. Pi 0.79.6 provides manual recall only. ' +
            'Check your Pi version and update Pi if needed: https://github.com/thedotmack/claude-mem/blob/main/docs/pi-native-capture.md';
        },
      };
    }
    case 'dsh': {
      return {
        title: 'DeepSeek Harness: installing native memory',
        task: async () => {
          const { installDeepSeekHarness } = await import('../../services/integrations/DeepSeekHarnessInstaller.js');
          const { result, output } = await bufferConsole(() => installDeepSeekHarness(dshProfile));
          if (result === 2) {
            installerError(ErrorSeverity.WARN_CONTINUE, {
              component: 'dsh', phase: 'ide-install',
              cause: new Error('DeepSeek Harness plugin installed, but transcript capture is incomplete.'),
              remediation: 'Check the transcript config and CLAUDE_MEM_TRANSCRIPTS_ENABLED, then re-run npx claude-mem install --ide dsh --dsh-profile ' + (dshProfile ?? 'web') + '.',
              details: output,
            }, summary);
            return 'DeepSeek Harness: plugin installed; transcript setup incomplete';
          }
          if (result !== 0) {
            recordFailure('DeepSeek Harness: native memory installation failed', output);
            return 'DeepSeek Harness: installation failed';
          }
          return 'DeepSeek Harness: native memory installed';
        },
      };
    }
    case 'omp': {
      return {
        title: 'OMP: installing hooks',
        task: async (message) => {
          message('Loading OMP installer…');
          const { installOmpHooks } = await import('../../services/integrations/OmpHooksInstaller.js');
          message('Installing OMP hooks…');
          const { result, output } = await bufferConsole(() => installOmpHooks());
          if (result !== 0) {
            recordFailure('OMP: hook installation failed', output);
            return `OMP: hook installation failed ${styleText('red', 'FAIL')}`;
          }
          return `OMP: hooks installed ${styleText('green', 'OK')}`;
        },
      };
    }

    case 'windsurf': {
      return {
        title: 'Windsurf: installing hooks',
        task: async (message) => {
          message('Loading Windsurf installer…');
          const { installWindsurfHooks } = await import('../../services/integrations/WindsurfHooksInstaller.js');
          message('Installing Windsurf hooks…');
          const { result, output } = await bufferConsole(() => installWindsurfHooks());
          if (result !== 0) {
            recordFailure('Windsurf: hook installation failed', output);
            return `Windsurf: hook installation failed ${styleText('red', 'FAIL')}`;
          }
          return `Windsurf: hooks installed ${styleText('green', 'OK')}`;
        },
      };
    }

    case 'openclaw': {
      return {
        title: 'OpenClaw: installing plugin',
        task: async (message) => {
          message('Loading OpenClaw installer…');
          const { installOpenClawIntegration } = await import('../../services/integrations/OpenClawInstaller.js');
          message('Copying plugin files…');
          const { result, output } = await bufferConsole(() => installOpenClawIntegration());
          if (result !== 0) {
            recordFailure('OpenClaw: plugin installation failed', output);
            return `OpenClaw: plugin installation failed ${styleText('red', 'FAIL')}`;
          }
          return `OpenClaw: plugin installed ${styleText('green', 'OK')}`;
        },
      };
    }

    case 't3code': {
      return {
        title: 'T3 Code: registering native provider plugins',
        task: async (message) => {
          message('Installing hooks and MCP for T3 Code providers…');
          const { installT3Code } = await import('../../services/integrations/T3CodeInstaller.js');
          const { result, output } = await bufferConsole(() => installT3Code(marketplaceDirectory()));
          if (result !== 0) {
            recordFailure('T3 Code: integration setup failed', output);
            return `T3 Code: integration setup failed ${styleText('red', 'FAIL')}`;
          }
          return `T3 Code: native provider plugins registered ${styleText('green', 'OK')}`;
        },
      };
    }

    case 'codex-cli': {
      return {
        title: 'Codex CLI: registering hooks marketplace',
        task: async (message) => {
          message('Loading Codex CLI installer…');
          const { installCodexCli } = await import('../../services/integrations/CodexCliInstaller.js');
          message('Registering native Codex hooks…');
          const { result, output } = await bufferConsole(() => installCodexCli(marketplaceDirectory()));
          if (result !== 0) {
            recordFailure('Codex CLI: integration setup failed', output);
            return `Codex CLI: integration setup failed ${styleText('red', 'FAIL')}`;
          }
          // The installer's own text with this step is buffered away on success, and Codex
          // skips an untrusted hook without saying so (#6419).
          return `Codex CLI: hooks registered ${styleText('green', 'OK')} — trust them once in interactive ${styleText('bold', 'codex')} when it asks, or with ${styleText('bold', '/hooks')} (${styleText('bold', 'codex exec')} skips untrusted hooks)`;
        },
      };
    }

    case 'antigravity': {
      return {
        title: 'Antigravity: installing hooks + MCP',
        task: async (message) => {
          message('Loading Antigravity CLI installer…');
          const { installAntigravityCliHooks } = await import('../../services/integrations/AntigravityCliHooksInstaller.js');
          message('Installing Antigravity hooks + MCP…');
          const { result, output } = await bufferConsole(() => installAntigravityCliHooks());
          if (result !== 0) {
            recordFailure('Antigravity: hooks + MCP installation failed', output);
            return `Antigravity: hooks + MCP installation failed ${styleText('red', 'FAIL')}`;
          }
          return `Antigravity: hooks + MCP installed ${styleText('green', 'OK')}`;
        },
      };
    }

    case 'copilot-cli':
    case 'copilot-vscode':
    case 'goose':
    case 'roo-code':
    case 'warp':
    case 'zed': {
      const allIDEs = detectInstalledIDEs();
      const ideInfo = allIDEs.find((i) => i.id === ideId);
      const ideLabel = ideInfo?.label ?? ideId;
      return {
        title: `${ideLabel}: installing MCP integration`,
        task: async (message) => {
          message('Loading MCP installer…');
          const { MCP_IDE_INSTALLERS } = await import('../../services/integrations/McpIntegrations.js');
          const mcpInstaller = MCP_IDE_INSTALLERS[ideId];
          if (!mcpInstaller) {
            return `${ideLabel}: MCP installer not found ${styleText('yellow', '!')}`;
          }
          message(`Configuring ${ideLabel} MCP…`);
          const { result, output } = await bufferConsole(() => mcpInstaller());
          if (result !== 0) {
            recordFailure(`${ideLabel}: MCP integration failed`, output);
            return `${ideLabel}: MCP integration failed ${styleText('red', 'FAIL')}`;
          }
          return `${ideLabel}: MCP integration installed ${styleText('green', 'OK')}`;
        },
      };
    }

    default: {
      return null;
    }
  }
}

async function setupIDEs(selectedIDEs: string[], summary: InstallSummary, dshProfile?: string): Promise<string[]> {
  const tasks: TaskDescriptor[] = [];
  for (const ideId of selectedIDEs) {
    const taskDescriptor = makeIDETask(ideId, summary, dshProfile);
    if (taskDescriptor) tasks.push(taskDescriptor);
  }

  if (tasks.length > 0) {
    await runTasks(tasks);
  }

  // FAIL_LOUD_PER_IDE failures were recorded on the summary; if EVERY selected
  // IDE failed, escalate to an ABORT (all-ides-failed) — a fully failed install
  // must not print "Installation Complete".
  if (selectedIDEs.length > 0 && summary.failedIDEs.length === selectedIDEs.length) {
    installerError(ErrorSeverity.ABORT, {
      component: 'all-ides',
      phase: 'ide-install',
      cause: new Error(`All ${selectedIDEs.length} selected agent integrations failed.`),
    }, summary);
  }

  return summary.failedIDEs;
}

function applyClaudeCodePathSetupIfNeeded(): void {
  // Claude Code's native installer drops `claude` in ~/.local/bin; only then
  // does this caller need ~/.local/bin on PATH. The appender itself is shared
  // with the claude-mem launcher setup (src/launcher/install-launcher.ts).
  if (!existsSync(join(homedir(), '.local', 'bin', 'claude'))) return;
  ensureLocalBinOnShellPath({ purposeLabel: 'Claude Code', logger: log });
}

export function claudeCodeInstallCommand(windows = IS_WINDOWS): string {
  return windows
    ? 'powershell -ExecutionPolicy ByPass -c "irm https://claude.ai/install.ps1 | iex"'
    : 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash';
}

async function installClaudeCode(): Promise<boolean> {
  const command = claudeCodeInstallCommand();
  const installShell = IS_WINDOWS ? (process.env.ComSpec ?? 'cmd.exe') : '/bin/bash';

  const spinner = isInteractive ? p.spinner() : null;
  spinner?.start('Installing Claude Code (this can take a few minutes — downloading the native build)…');

  return new Promise<boolean>((resolve) => {
    let captured = '';
    const child = spawnHidden(command, [], {
      shell: installShell,
      stdio: spinner ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    });

    child.stdout?.on('data', (chunk: Buffer) => { captured += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { captured += chunk.toString(); });

    child.on('error', (error: Error) => {
      spinner?.error('Claude Code install failed');
      if (captured) process.stderr.write(captured);
      log.error(`Claude Code install failed: ${error.message}`);
      log.info('You can install it manually later: https://claude.ai/install.sh');
      resolve(false);
    });

    child.on('exit', (code) => {
      if (code !== 0) {
        spinner?.error('Claude Code install failed');
        if (captured) process.stderr.write(captured);
        log.error(`Claude Code install failed (exit ${code ?? 'unknown'})`);
        log.info('You can install it manually later: https://claude.ai/install.sh');
        resolve(false);
        return;
      }
      spinner?.stop('Claude Code installed');
      if (!IS_WINDOWS) {
        try {
          applyClaudeCodePathSetupIfNeeded();
        } catch (error: unknown) {
          // [ANTI-PATTERN IGNORED]: the failure is already surfaced to the user via the interactive-aware log.warn wrapper below (p.log.warn in a TTY, console.warn otherwise); PATH setup is best-effort after a successful install.
          log.warn(`Could not auto-apply PATH setup: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      resolve(true);
    });
  });
}

async function promptForIDESelection(): Promise<string[]> {
  const detectedIDEs = detectInstalledIDEs();
  const detected = detectedIDEs.filter((ide) => ide.detected);

  if (detected.length === 0) {
    log.warn('No supported agents detected — pick the one(s) you plan to use.');
  }

  const options = detectedIDEs.map((ide) => {
    const detectedTag = ide.detected ? ' [detected]' : '';
    return {
      value: ide.id,
      label: ide.label,
      hint: `${ide.hint}${detectedTag}`,
    };
  });

  // Prefer the agents already installed; Claude Code is the fallback when none are detected.
  const preselected = initialIDESelection(detectedIDEs);

  const result = await p.multiselect({
    message: 'Which agents do you use?',
    options,
    initialValues: preselected,
    required: true,
  });

  if (p.isCancel(result)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  const selected = result as string[];
  if (selected.includes('claude-code') && !detectedIDEs.find(ide => ide.id === 'claude-code')?.detected) {
    const installHost = await p.confirm({ message: 'Install Claude Code now?', initialValue: true });
    if (p.isCancel(installHost)) { p.cancel('Installation cancelled.'); process.exit(0); }
    if (installHost && !await installClaudeCode()) {
      log.warn('Claude Code installation failed. Choose an agent again, or decline the host installation to set it up later.');
      return promptForIDESelection();
    }
  }
  return selected;
}

/** The same agent inventory and installed skill preferences are offered in the browser. */
export function browserInstallCatalog(options: InstallOptions, reinstall: boolean): SetupInstallCatalog {
  const agents = detectInstalledIDEs().map(agent => ({ ...agent, hint: agent.hint ?? '' }));
  const skillsRoot = join(npmPackagePluginDirectory(), 'skills');
  const disabled = readDisabledSkills();
  const skills = readdirSync(skillsRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, 'SKILL.md')))
    .map(entry => {
      const source = readFileSync(join(skillsRoot, entry.name, 'SKILL.md'), 'utf8');
      const description = source.match(/^description:\s*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '') ?? '';
      return { id: entry.name, label: entry.name, description, required: RUNTIME_REQUIRED_SKILLS.has(entry.name) };
    }).sort((a, b) => a.id.localeCompare(b.id));
  const consent = explainTelemetryConsent(process.env, loadTelemetryConfig());
  // A saved model outside the accepted set (a gateway model after switching auth, or an old pinned id) would make
  // the browser's At Home step throw in promptClaudeModel; offer the default instead and leave the saved value alone.
  const savedModel = options.model ?? String(getSetting('CLAUDE_MEM_MODEL') || 'haiku');
  const claudeModel = CLAUDE_MODEL_CHOICES.has(savedModel) || resolveClaudeAuthMethod() === 'gateway' ? savedModel : 'haiku';
  return {
    agents, skills, reinstall,
    defaults: {
      agents: options.ide ? [canonicalIntegrationId(options.ide)] : initialIDESelection(agents),
      skills: skills.filter(skill => skill.required || !disabled.has(skill.id)).map(skill => skill.id),
      installClaudeCode: false,
      disableAutoMemory: options.disableAutoMemory === true
        || readJsonSafe<Record<string, any>>(claudeSettingsPath(), {}).env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY === '1',
      telemetryEnabled: consent.enabled,
      claudeModel,
      ...(options.dshProfile ? { dshProfile: options.dshProfile } : {}),
    },
    telemetryLocked: !!process.env.CI || consent.source === 'DO_NOT_TRACK' || consent.source === 'env',
    skillsLocked: process.env.CLAUDE_MEM_SKILLS_DISABLED !== undefined,
    // The terminal never collects an email; the flag stays for older setup pages.
    emailEnabled: false,
  };
}

/** The browser's model counts only when the person changed it; an untouched default keeps the saved setting. */
function browserModelChoice(selection: SetupInstallSelection, catalog: SetupInstallCatalog, current: string | undefined): string | undefined {
  return selection.claudeModel && selection.claudeModel !== catalog.defaults.claudeModel ? selection.claudeModel : current;
}

export function copyPluginToMarketplace(): void {
  const marketplaceDir = marketplaceDirectory();
  const packageRoot = npmPackageRootDirectory();

  const attribution = readProjectAttribution(packageRoot);
  ensureDirectoryExists(marketplaceDir);

  const allowedTopLevelEntries = [
    '.agents',
    '.claude-plugin',
    '.codex-plugin',
    '.cursor-plugin',
    'claude-mem-cursor',
    'claude-mem-grok-bot',
    'plugin',
    'package-lock.json',
    'openclaw',
    'omp',
    'hermes',
    'pi',
    'dsh',
    'dist',
    'README.md',
  ];

  for (const entry of allowedTopLevelEntries) {
    const sourcePath = join(packageRoot, entry);
    const destPath = join(marketplaceDir, entry);
    if (!existsSync(sourcePath)) continue;

    if (existsSync(destPath)) {
      rmSync(destPath, { recursive: true, force: true });
    }
    cpSync(sourcePath, destPath, {
      recursive: true,
      force: true,
    });
  }

  replaceOwnedFiles(marketplaceDir, attribution);

  writeTrimmedMarketplacePackageJson(packageRoot, marketplaceDir);
  writeTrimmedMarketplaceManifest(marketplaceDir);
  applyInstalledSkillSelection(join(marketplaceDir, 'plugin'));
}

/**
 * Keep only the marketplace entries whose local `source` shipped.
 *
 * The repo's root .claude-plugin/marketplace.json also lists cmem-pro
 * (`./cowork`), which the npm package does not ship. Copied verbatim, the
 * manifest would advertise a plugin whose source is missing from the
 * marketplace directory, so drop every entry whose relative source path does
 * not exist there. Non-path sources (a GitHub repo object) are kept as-is.
 */
export function writeTrimmedMarketplaceManifest(marketplaceDir: string): void {
  const manifestPath = join(marketplaceDir, '.claude-plugin', 'marketplace.json');
  if (!existsSync(manifestPath)) return;

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { plugins?: unknown };
  if (!Array.isArray(manifest.plugins)) return;

  const shipped = manifest.plugins.filter((entry) => {
    const source = (entry as { source?: unknown } | null)?.source;
    return typeof source !== 'string' || !source.startsWith('.') || existsSync(join(marketplaceDir, source));
  });
  if (shipped.length === manifest.plugins.length) return;

  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, plugins: shipped }, null, 2)}\n`);
}

/**
 * Write a runtime-only package.json into the marketplace directory.
 *
 * The root package.json declares ~40 dev-only tree-sitter grammars whose peer
 * ranges conflict (@derekstride/tree-sitter-sql wants tree-sitter@^0.21.0 while
 * @tree-sitter-grammars/tree-sitter-lua wants tree-sitter@^0.22.4). Copying it
 * verbatim makes `npm install --omit=dev` still resolve those dev edges and
 * abort with ERESOLVE (#3636). A consumer install needs only the two live
 * runtime deps, so we strip devDependencies and trustedDependencies before npm
 * ever sees the graph.
 */
export function writeTrimmedMarketplacePackageJson(packageRoot: string, marketplaceDir: string): void {
  const sourcePath = join(packageRoot, 'package.json');
  if (!existsSync(sourcePath)) return;

  const pkg = JSON.parse(readFileSync(sourcePath, 'utf-8')) as Record<string, unknown>;
  delete pkg.devDependencies;
  delete pkg.trustedDependencies;

  writeFileSync(join(marketplaceDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * The plugin files are already replaced when this runs, so a bad selection
 * (invalid name, held lock, foreign parked folder) must not stop install or
 * repair before dependencies install: warn loudly and keep the skills as they are.
 */
function applyInstalledSkillSelection(pluginRoot: string): void {
  let result;
  try {
    result = applyConfiguredSkillSelection(pluginRoot);
  } catch (error) {
    // [ANTI-PATTERN IGNORED]: surfaced to the user via log.warn; the skill selection is optional and install must finish.
    log.warn(skillSelectionFailureMessage(error));
    return;
  }
  for (const warning of result.warnings) log.warn(warning);
}

export async function copyPluginToCache(version: string): Promise<void> {
  const sourcePluginDirectory = npmPackagePluginDirectory();
  const cachePath = pluginCacheDirectory(version);

  rmSync(cachePath, { recursive: true, force: true });
  ensureDirectoryExists(cachePath);
  cpSync(sourcePluginDirectory, cachePath, { recursive: true, force: true });
  applyInstalledSkillSelection(cachePath);

  // Prune superseded versions now that the new one has landed. Without this the
  // cache grew one directory per release forever, and every retained directory
  // stayed a runnable old-version worker source (#4105). The safe prune keeps
  // the just-written version plus N-1 and protects any live worker's version —
  // the repair path reaches here without stopping the worker, so a running
  // older worker must never lose its source directory. It also keeps the
  // newest version whose dependencies are complete: the one just copied has
  // none until "Setting up runtime" installs them, and that step can fail.
  // Pruning is housekeeping: it runs inside runTasks, before the provider
  // step, so any failure (a corrupt installed_plugins.json, say) only warns.
  try {
    const pruned = await prunePluginCacheSafely({ additionalProtectedVersions: [version] });
    if (pruned.retainedForLiveWorker) {
      log.info('Skipped cache prune: a worker is running but its version could not be read; retaining all versions.');
    } else if (pruned.removed.length > 0) {
      log.info(`Pruned ${pruned.removed.length} stale plugin cache version(s): ${pruned.removed.map(removed => describePrunedVersion(removed, pruned)).join(', ')}`);
    }
    for (const record of pruned.keptByProcessNameOverride) {
      log.info(describeProcessNameOverride(record));
    }
    for (const failure of pruned.failed) {
      log.warn(`Could not prune cache version ${failure.version}: ${failure.reason}`);
    }
  } catch (error: unknown) {
    log.warn(`Skipped cache prune: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeMarketplaceInstallMarkers(
  marketplaceDir: string,
  version: string,
  bunVersion: string,
  uvVersion: string,
): void {
  writeInstallMarker(marketplaceDir, version, bunVersion, uvVersion);
  // Hooks execute from marketplace/plugin, and Codex caches only that nested
  // directory. Keep the runtime marker beside the package.json the hook reads
  // so SessionStart does not report a completed install as missing.
  writeInstallMarker(join(marketplaceDir, 'plugin'), version, bunVersion, uvVersion);
}

/**
 * Install marketplace dependencies, strict-first.
 *
 * The old code ALWAYS passed
 * `--legacy-peer-deps`, papering over any real peer conflict unconditionally.
 * Now we run strict first and only fall back to `--legacy-peer-deps` on a
 * confirmed ERESOLVE token, announced loudly. `--ignore-scripts` is the default
 * (v12.6.2 lesson: a transitive postinstall can hang the install).
 */
async function runNpmInstallInMarketplace(summary: InstallSummary): Promise<void> {
  const marketplaceDir = marketplaceDirectory();
  const packageJsonPath = join(marketplaceDir, 'package.json');

  if (!existsSync(packageJsonPath)) return;

  const baseFlags = ['install', '--omit=dev', '--ignore-scripts'];
  const strictResult = await runNpmStrict(marketplaceDir, baseFlags);
  if (strictResult.code === 0) return;

  if (strictResult.timedOut) {
    installerError(ErrorSeverity.ABORT, {
      component: 'marketplace-npm-install',
      phase: 'marketplace-deps',
      cause: new Error('npm install timed out'),
      details: strictResult.stderr.slice(0, 4000),
    }, summary);
  }

  if (!isEresolve(strictResult.stderr)) {
    // A strict failure with no ERESOLVE is a real bug — never retry, ABORT.
    // npm's own error code goes in the cause so the taxonomy can name the fix.
    const npmCode = npmErrorCode(strictResult.stderr);
    installerError(ErrorSeverity.ABORT, {
      component: 'marketplace-npm-install',
      phase: 'marketplace-deps',
      cause: new Error(`npm install failed (exit ${strictResult.code})${npmCode ? `: ${npmCode}` : ''}`),
      details: strictResult.stderr.slice(0, 4000),
    }, summary);
  }

  // Confirmed ERESOLVE — log loudly, attempt one fallback with --legacy-peer-deps.
  log.warn('npm reported an ERESOLVE peer-dependency conflict in marketplace deps; retrying once with --legacy-peer-deps.');
  log.warn(extractEresolveBlock(strictResult.stderr));

  const legacyResult = await runNpmStrict(marketplaceDir, [...baseFlags, '--legacy-peer-deps']);
  if (legacyResult.code === 0) {
    summary.warnings.push({
      component: 'marketplace-npm-install',
      message: 'tree-sitter peer-dep ERESOLVE was resolved with the --legacy-peer-deps fallback. Benign for the marketplace install; re-evaluate when tree-sitter peer ranges change.',
      remediation: 'No action required.',
    });
    return;
  }

  installerError(ErrorSeverity.ABORT, {
    component: 'marketplace-npm-install',
    phase: 'marketplace-deps',
    cause: new Error(`npm install --legacy-peer-deps still failed (exit ${legacyResult.code}): ERESOLVE`),
    details: legacyResult.stderr.slice(0, 4000),
  }, summary);
}

type ProviderId = 'claude' | 'codex' | 'gemini' | 'openrouter' | 'openai-compatible' | 'host';
// Phase 1d: Persisted DB literals (`server_beta_schema_migrations`, job_type
// enums, `server-beta-worker` lockedBy marker) are intentionally preserved in
// the source code; runtime-selector dual-accepts both `'server'` and
// `'server-beta'` settings values, but the installer writes the new canonical
// form `'server'` going forward (settings keys: CLAUDE_MEM_SERVER_{URL,
// API_KEY,PROJECT_ID}).
type RuntimeId = 'worker' | 'server';

/** Read only persisted values: environment secrets must never be copied to disk. */
function readPersistedInstallerSettings(): Record<string, unknown> {
  try {
    return readFlatSettings(USER_SETTINGS_PATH) ?? {};
  } catch {
    // settings.json is optional and may be hand-edited; provider prompts retain
    // their normal recovery paths when it cannot be read.
    return {};
  }
}

function readRawStoredAuthMethod(): 'subscription' | 'api-key' | 'gateway' | undefined {
  try {
    const value = readFlatSettings(USER_SETTINGS_PATH)?.CLAUDE_MEM_CLAUDE_AUTH_METHOD;
    if (value === 'subscription' || value === 'api-key' || value === 'gateway') return value;
    return undefined;
  } catch {
    // [ANTI-PATTERN IGNORED]: settings.json is optional and may be absent or hand-edited into invalid JSON; falling back to env-based auth detection in resolveClaudeAuthMethod is the designed recovery.
    return undefined;
  }
}

function resolveClaudeAuthMethod(): 'subscription' | 'api-key' | 'gateway' {
  const stored = readRawStoredAuthMethod();
  if (stored) return stored;
  const env = loadClaudeMemEnv();
  if (env.ANTHROPIC_BASE_URL?.trim()) return 'gateway';
  if (env.ANTHROPIC_API_KEY?.trim()) return 'api-key';
  return 'subscription';
}

const DEFAULT_SERVER_RUNTIME_BASE_URL = 'http://127.0.0.1:37877';

function requireSupportedRuntime(selectedIDEs: string[], runtime: RuntimeId): void {
  if (runtime === 'server' && selectedIDEs.some(id => id === 'pi' || id === 'dsh')) {
    log.error('Pi and DeepSeek Harness currently require --runtime worker.');
    process.exit(1);
  }
}

async function promptRuntime(options: InstallOptions, selectedIDEs: string[]): Promise<RuntimeId> {
  if (options.update && options.runtime === undefined) {
    // Older installs used the worker before this setting existed. In particular,
    // do not run server bootstrap again: that can replace a saved URL or key.
    const stored = readPersistedInstallerSettings().CLAUDE_MEM_RUNTIME;
    const runtime = normalizeRuntimeFlag(typeof stored === 'string' ? stored : 'worker');
    if (runtime !== null) {
      requireSupportedRuntime(selectedIDEs, runtime);
      return runtime;
    }
    // An unrecognised runtime still needs the ordinary selection/validation.
  }
  // #2543 — non-interactive runtime selection via `--runtime`. When the flag is
  // present we never prompt and never fall back to the worker path: we resolve
  // the requested runtime deterministically and, for the server runtime, plan +
  // execute the server-specific setup (Docker stack, key gen, IDE MCP config).
  if (options.runtime !== undefined) {
    const requested = normalizeRuntimeFlag(options.runtime);
    if (requested === null) {
      log.error(`Unknown --runtime: ${options.runtime}. Allowed: worker, server`);
      process.exit(1);
    }
    requireSupportedRuntime(selectedIDEs, requested);
    if (requested === 'server') {
      await setupServerRuntimeNonInteractive(options);
      return 'server';
    }
    mergeSettings({ CLAUDE_MEM_RUNTIME: 'worker' });
    return 'worker';
  }

  if (!isInteractive) {
    mergeSettings({ CLAUDE_MEM_RUNTIME: 'worker' });
    return 'worker';
  }

  const selected = await p.select<RuntimeId>({
    message: 'Which runtime should claude-mem start after install?',
    options: [
      { value: 'worker', label: 'Worker', hint: 'stable compatibility path' },
      { value: 'server', label: 'Server (beta)', hint: 'REST V1, API keys, team-ready storage' },
    ],
    initialValue: 'worker',
  });

  // @clack/prompts 1.8: isCancel narrows to unique CANCEL_SYMBOL, not generic symbol.
  if (p.isCancel(selected) || typeof selected === 'symbol') {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }

  requireSupportedRuntime(selectedIDEs, selected);
  mergeSettings({
    CLAUDE_MEM_RUNTIME: selected,
  });

  if (selected === 'server') {
    await maybeBootstrapServerApiKey();
  }
  return selected;
}

// #2543 — set up the server runtime non-interactively. Docker stack bring-up
// is config-only here (we log the command an operator must run / a CI
// provisioner executes); key generation reuses the same bootstrap path as the
// interactive flow (createServerApiKey via server-bootstrap), and the IDE MCP
// config target is recorded in settings so hooks resolve the server runtime.
async function setupServerRuntimeNonInteractive(options: InstallOptions): Promise<void> {
  const serverBaseUrl = (options.serverUrl ?? '').trim() || DEFAULT_SERVER_RUNTIME_BASE_URL;

  mergeSettings({ CLAUDE_MEM_RUNTIME: 'server', CLAUDE_MEM_SERVER_URL: serverBaseUrl });

  log.info(
    'Server runtime selected. Bring up the bundled stack with '
      + '`docker compose up -d postgres valkey claude-mem-server claude-mem-worker` '
      + `(pg + redis/valkey). The server listens at ${serverBaseUrl}.`,
  );

  // The server mounts its MCP endpoint at `<baseUrl>/v1/mcp` over HTTP (vs. the
  // worker's stdio transport); trailing slashes are trimmed so we never emit
  // `http://host//v1/mcp`.
  log.info(
    `IDE MCP config target for the server runtime: http ${serverBaseUrl.replace(/\/+$/, '')}/v1/mcp`,
  );

  await maybeBootstrapServerApiKey();
}

async function maybeBootstrapServerApiKey(): Promise<void> {
  // Only attempt if Postgres is configured. Without DATABASE_URL we cannot
  // reach the api_keys table — the operator must configure the server first
  // and rerun `claude-mem server keys rotate`.
  if (!process.env.CLAUDE_MEM_SERVER_DATABASE_URL) {
    log.warn(
      'Skipping local hook API key bootstrap: CLAUDE_MEM_SERVER_DATABASE_URL is not set. '
        + 'Run `npx claude-mem server keys rotate` after configuring Postgres to provision a key.',
    );
    return;
  }
  try {
    await bootstrapAndPersistServerApiKey();
  } catch (error: unknown) {
    // [ANTI-PATTERN IGNORED]: the failure is already surfaced to the user via the interactive-aware log.warn wrapper below (p.log.warn in a TTY, console.warn otherwise), including the manual remediation command.
    log.warn(
      `Failed to bootstrap server API key: ${error instanceof Error ? error.message : String(error)}. `
        + 'Hooks will fall back to the worker until you run `npx claude-mem server keys rotate`.',
    );
  }
}

async function bootstrapAndPersistServerApiKey(): Promise<void> {
  const { bootstrapServerApiKey, revokeServerApiKey, persistServerSettings } = await import(
    '../../services/hooks/server-bootstrap.js'
  );
  const result = await bootstrapServerApiKey();
  const persisted = persistServerSettings(USER_SETTINGS_PATH, {
    apiKey: result.rawKey,
    projectId: result.projectId,
  });
  if (persisted) {
    log.info(
      `Provisioned local hook API key (project=${result.projectId.slice(0, 8)}…). `
        + 'Settings saved with mode 0600.',
    );
    return;
  }
  // The key exists server-side but no hook can use it: revoke it rather than
  // leave an orphaned live credential, and say how to recover.
  await revokeServerApiKey(result.apiKeyId).catch((error: unknown) => {
    log.warn(`Could not revoke the unpersisted server API key: ${error instanceof Error ? error.message : String(error)}`);
  });
  log.warn('Server API key was provisioned but settings.json could not be updated. Repair or restore ~/.claude-mem/settings.json and rerun the installer.');
}

/** Exported for tests: the provider step of `install` and `update`. */
export async function promptProvider(options: InstallOptions): Promise<ProviderId> {
  // Captured by runInstallCommandInner before any settings read could seed the
  // settings file; a direct call (tests) computes it here instead.
  const freshInstall = freshProviderInstall ?? isFreshProviderInstall(options);
  const persistedSettings = readPersistedInstallerSettings();

  const useSubscriptionAuth = () => {
    const wrote = mergeSettings(buildAnthropicMaxLocalSettings(persistedSettings));
    if (!wrote) {
      p.cancel('Could not save the local Anthropic Max configuration.');
      process.exit(1);
    }
    saveClaudeMemEnv({
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_AUTH_TOKEN: '',
    });
    log.info('Disabled cloud sync and saved local Anthropic Max configuration.');
    log.info('Configured claude-mem to use your logged-in Claude SDK account.');
  };

  // A provider reused from settings on an update or non-interactive run is already
  // configured. Re-running the claude branch would call useSubscriptionAuth(),
  // which blanks cloud-sync and the Pro memory key — a persisted Pro config
  // must survive a non-TTY `npx claude-mem update` untouched.
  if (options.providerSource === 'persisted' && options.provider) {
    return options.provider;
  }

  let selectedProvider: ProviderId;
  if (options.provider) {
    selectedProvider = options.provider;
  } else {
    // No prompt: the only choice is the internal model gateway. A fresh
    // install fills the empty provider keys with the GPUStack defaults below.
    // A non-TTY run gets here only through the browser funnel (the terminal
    // validation always resolves a provider first); the gateway branch below
    // then resolves the key from the environment, ~/.claude-mem/.env or
    // settings, and aborts with the env-var remediation when it is missing.
    options.providerSource = 'default';
    options.provider = 'openrouter';
    selectedProvider = 'openrouter';
    log.info('Memory runs on the internal model gateway (GPUStack).');
  }

  if (selectedProvider === 'claude') {
    useSubscriptionAuth();
    return 'claude';
  }

  if (selectedProvider === 'codex') {
    const model = options.model?.trim();
    if (options.model !== undefined && !model) {
      throw new Error('Codex model must not be empty. Omit --model to keep the current Codex model setting.');
    }
    const wrote = mergeSettings({
      CLAUDE_MEM_PROVIDER: 'codex',
      ...(model ? { CLAUDE_MEM_CODEX_MODEL: model } : {}),
    });
    if (!wrote) {
      p.cancel('Could not save the Codex provider configuration.');
      process.exit(1);
    }
    log.info('Configured Codex subscription provider. Run `codex login` before starting the worker.');
    return 'codex';
  }

  if (selectedProvider === 'host') {
    const observerModel = options.ide === 'grok-bot' ? 'grok-bot' : 'cursor';
    const wrote = mergeSettings(buildHostObserverSettings(observerModel, persistedSettings));
    if (!wrote) {
      p.cancel('Could not save the host observer configuration.');
      process.exit(1);
    }
    log.info(`Configured host observer for ${observerModel}.`);
    return 'openrouter';
  }

  if (selectedProvider === 'openai-compatible') {
    // Only a persisted configuration carries this provider, and it returned
    // above. The installer has no setup flow for it: the endpoint, model and
    // key are set in ~/.claude-mem/settings.json.
    throw new Error('The openai-compatible provider is configured in ~/.claude-mem/settings.json, not by the installer.');
  }

  if (selectedProvider === 'openrouter') {
    const persistedNow = readPersistedInstallerSettings();
    if (hasPersonalProviderKey('openrouter', persistedNow)) {
      // A held key wins. Fill only the provider keys still at their shipped
      // defaults with the internal gateway's endpoint and model
      // (applyGpustackDefaults never overwrites a chosen value and never
      // writes the key itself).
      applyGpustackDefaults(persistedNow, freshInstall);
      return 'openrouter';
    }
    // A saved configuration pointing at the cmem gateway with no key is kept
    // as it is: a GPUStack key pasted here would be sent to the saved gateway
    // URL, and this local-only build has no account flow to refill the key.
    if (isCmemGatewayUrl(String(persistedNow.CLAUDE_MEM_OPENROUTER_BASE_URL ?? ''))) {
      log.info('Keeping the existing configuration.');
      return 'openrouter';
    }
    // No key held in settings, the environment or ~/.claude-mem/.env. A
    // non-TTY run cannot answer the prompt: the terminal flow was already
    // aborted by validateNonInteractiveProvider with these words, and a
    // non-TTY browser funnel (a resumed deferred setup) aborts here with the
    // same remediation instead of an internal-invariant error.
    if (!isInteractive) {
      throw new Error('Set CLAUDE_MEM_OPENROUTER_API_KEY (env or ~/.claude-mem/.env) or pass --provider claude.');
    }
    const apiKeyResult = await p.password({
      message: 'Paste your GPUStack API key:',
      mask: '*',
      validate: (value?: string) => value?.trim() ? undefined : 'API key required',
    });
    if (p.isCancel(apiKeyResult) || !String(apiKeyResult).trim()) {
      // Nothing has been written yet: the defaults below are applied only once
      // a key is secured, so a cancelled prompt leaves settings as they were.
      throw new Error('Setup cancelled: no GPUStack API key was entered. Run npx claude-mem install again to retry, or pass --provider claude to use your Anthropic plan.');
    }
    // Key secured: fill the provider keys still at their shipped defaults with
    // the gateway defaults and save the key.
    applyGpustackDefaults(persistedNow, freshInstall);
    if (!mergeSettings({ CLAUDE_MEM_OPENROUTER_API_KEY: String(apiKeyResult).trim() })) {
      throw new Error('Could not save the GPUStack API key.');
    }
    log.info('Saved CLAUDE_MEM_OPENROUTER_API_KEY to ~/.claude-mem/settings.json.');
    return 'openrouter';
  }

  // Gemini: bring-your-own key, asked locally.
  const keyEnvName = 'CLAUDE_MEM_GEMINI_API_KEY';
  const existingKey = getSetting(keyEnvName as keyof SettingsDefaults) as string | undefined;
  if (existingKey && existingKey.trim().length > 0) {
    const wrote = mergeSettings({ CLAUDE_MEM_PROVIDER: 'gemini' });
    if (wrote) log.info('Saved provider=gemini to ~/.claude-mem/settings.json');
    return 'gemini';
  }

  if (!isInteractive) {
    throw new Error('Non-interactive Gemini configuration is missing a personal API key.');
  }

  const apiKeyResult = await p.password({
    message: 'Paste your Gemini API key:',
    mask: '*',
    validate: (v?: string) => (!v || v.trim().length === 0) ? 'API key required' : undefined,
  });

  // The owner chose this provider with --provider, so a cancel is a stop, never a request for the
  // Anthropic plan. Nothing is written and nothing is substituted (#5675).
  if (p.isCancel(apiKeyResult)) {
    p.cancel(
      'Gemini setup cancelled: no API key was entered and your provider setting was not changed. '
      + 'Run `npx claude-mem install --provider gemini` to try again, '
      + 'or `--provider claude` to use your Anthropic plan.',
    );
    process.exit(1);
  }

  const apiKey = String(apiKeyResult).trim();
  const wrote = mergeSettings({ CLAUDE_MEM_PROVIDER: 'gemini', [keyEnvName]: apiKey });
  if (wrote) {
    log.info('Saved provider=gemini to ~/.claude-mem/settings.json');
  }
  return 'gemini';
}

/**
 * The Claude models `--model` accepts outside the gateway. Model policy (CLAUDE.md): offer Claude Code's
 * aliases, never dated ids, so every install follows each new and cheaper release. Pinned ids stay accepted.
 */
export const CLAUDE_MODEL_CHOICES: ReadonlySet<string> = new Set([
  'haiku',
  'sonnet',
  'opus',
  'claude-haiku-4-5-20251001',
  'claude-sonnet-5',
  'claude-opus-4-8',
]);

/** `interactive: false` keeps the defaults (or `--model`) without asking: the browser funnel's At Home branch. */
async function promptClaudeModel(options: InstallOptions, interactive: boolean = isInteractive): Promise<void> {
  const allowed = CLAUDE_MODEL_CHOICES;
  const allowCustomModel = resolveClaudeAuthMethod() === 'gateway';

  if (options.model && !allowCustomModel) {
    if (!allowed.has(options.model)) {
      throw new Error(
        `Unknown Claude model: ${options.model}. Allowed: ${[...allowed].join(', ')}`,
      );
    }
    const wrote = mergeSettings({ CLAUDE_MEM_MODEL: options.model });
    if (wrote) {
      log.info(`Saved Claude model=${options.model} to ~/.claude-mem/settings.json`);
    }
    return;
  }
  if (options.model && allowCustomModel) {
    const wrote = mergeSettings({ CLAUDE_MEM_MODEL: options.model });
    if (wrote) {
      log.info(`Saved gateway model=${options.model} to ~/.claude-mem/settings.json`);
    }
    return;
  }

  if (!interactive) return;

  const initialModel = getSetting('CLAUDE_MEM_MODEL');

  if (allowCustomModel) {
    const result = await p.text({
      message: 'Which model should the gateway use?',
      placeholder: 'haiku',
      defaultValue: initialModel || 'haiku',
      validate: (v?: string) => (!v || v.trim().length === 0) ? 'Model required' : undefined,
    });

    if (p.isCancel(result)) {
      p.cancel('Installation cancelled.');
      process.exit(0);
    }

    const selectedModel = String(result).trim();
    const wrote = mergeSettings({ CLAUDE_MEM_MODEL: selectedModel });
    if (wrote) {
      log.info(`Saved gateway model=${selectedModel} to ~/.claude-mem/settings.json`);
    }
    return;
  }

  const initialValue = allowed.has(initialModel) ? initialModel : 'haiku';
  const choices = [
    { value: 'haiku', label: 'Haiku, newest version (recommended — fast, cheap, great for compression)' },
    { value: 'sonnet', label: 'Sonnet, newest version (balanced quality and cost)' },
    { value: 'opus', label: 'Opus, newest version (highest quality, slowest)' },
  ];
  // A pinned id saved by an older install stays selectable, so rerunning the installer can keep it.
  if (!choices.some((o) => o.value === initialValue)) {
    choices.push({ value: initialValue, label: `${initialValue} (your saved pin; never updates)` });
  }

  const result = await p.select<string>({
    message: 'Which Claude model should claude-mem use to compress observations?\nThis runs whenever you and Claude touch a file — keep it cheap and fast.',
    options: choices,
    initialValue,
  });

  if (p.isCancel(result)) {
    p.cancel('Installation cancelled.');
    process.exit(0);
  }
  const selectedModel = result as string;

  const wrote = mergeSettings({ CLAUDE_MEM_MODEL: selectedModel });
  if (wrote) {
    log.info(`Saved Claude model=${selectedModel} to ~/.claude-mem/settings.json`);
  }
}

/**
 * Final step of the install flow: tell the user telemetry is on by default
 * (opt-out) and let them decide. Asked ONCE — a telemetry.json with a recorded
 * enabled decision means the user already chose, and we never re-nag. An
 * installId-only config (written by the worker's ID bootstrap) does NOT count
 * as a decision. Respects DO_NOT_TRACK (skip entirely: they already answered),
 * CI, and non-TTY. See docs/public/telemetry.mdx for what is/isn't collected.
 */
async function promptTelemetryOptIn(): Promise<void> {
  if (!isInteractive) return;
  if (process.env.CI) return;
  const dnt = process.env.DO_NOT_TRACK;
  if (dnt !== undefined && dnt !== '' && dnt !== '0' && dnt !== 'false') return;
  const existing = loadTelemetryConfig();
  if (existing?.enabled !== undefined) return;

  p.log.message(styleText('dim', 
    'Anonymous install ID only — no prompts, file paths, code, or project names, ever.\n'
    + 'Details: https://docs.claude-mem.ai/telemetry · Change anytime: claude-mem telemetry disable',
  ));
  const consent = await p.confirm({
    message: 'Share anonymized usage data with CMEM? It is on by default and helps us make the product better.',
    initialValue: true,
  });
  if (p.isCancel(consent)) return;

  recordTelemetryDecision(consent === true);
  log.success(consent ? 'Thanks! Anonymized usage sharing is on.' : 'No problem — telemetry is off.');
}

/**
 * GPUStack fresh-install defaults: the internal model gateway a fresh install
 * runs memory on. Written only into keys still empty or still holding the
 * shipped default — a value this machine chose, an exported environment value
 * and the gateway key are never touched: the key is never hardcoded, only
 * asked for or read (CLAUDE_MEM_OPENROUTER_API_KEY).
 */
const GPUSTACK_DEFAULT_BASE_URL = 'https://gpustack.data.lmru.tech/v1';
const GPUSTACK_DEFAULT_MODEL = 'glm-5.3-flash';

/** The provider keys the GPUStack defaults fill, with their values. */
const GPUSTACK_DEFAULTS: Record<string, string> = {
  CLAUDE_MEM_PROVIDER: 'openrouter',
  CLAUDE_MEM_OPENROUTER_BASE_URL: GPUSTACK_DEFAULT_BASE_URL,
  CLAUDE_MEM_OPENROUTER_MODEL: GPUSTACK_DEFAULT_MODEL,
};

/**
 * Whether this run installs onto a machine that has never settled a provider:
 * no settings.json yet, or setup never completed and no plugin is installed
 * (an update is never fresh). Read BEFORE any settings read: the first
 * SettingsDefaultsManager.loadFromFile seeds a missing settings.json with the
 * shipped defaults — a provider among them — which erases the evidence this
 * decision needs. Exported for tests; promptProvider falls back to computing
 * it here when the installer never captured it.
 */
export function isFreshProviderInstall(options: Pick<InstallOptions, 'update'>): boolean {
  if (options.update) return false;
  if (!existsSync(USER_SETTINGS_PATH)) return true;
  const alreadyInstalled = existsSync(join(marketplaceDirectory(), 'plugin', '.claude-plugin', 'plugin.json'));
  return !alreadyInstalled && readSetupState().status !== 'complete';
}

/** Captured once at the top of runInstallCommandInner, before any settings read. */
let freshProviderInstall: boolean | null = null;

/**
 * Fill the provider keys a fresh install left empty or at their shipped
 * defaults with the GPUStack values. A value differing from the shipped
 * default was chosen on this machine and is never overwritten, an exported
 * environment value always wins and is never copied to disk, and the gateway
 * key is never one of the written keys.
 *
 * The ~/.claude-mem/.env leg of the usual key lookups is absent on purpose:
 * that file holds only unprefixed credential names (OPENROUTER_API_KEY, not
 * CLAUDE_MEM_OPENROUTER_BASE_URL), so none of these keys can ever be set
 * there and checking it would be dead code.
 */
function applyGpustackDefaults(persisted: Record<string, unknown>, freshInstall: boolean): void {
  if (!freshInstall) return;
  const shipped = SettingsDefaultsManager.getAllDefaults();
  const updates: Record<string, string> = {};
  for (const [name, value] of Object.entries(GPUSTACK_DEFAULTS)) {
    // An environment value wins without being copied to disk.
    if (holdsKey(process.env[name])) continue;
    const current = persisted[name];
    const atShippedDefault = typeof current === 'string'
      && current.trim() === String(shipped[name as keyof SettingsDefaults] ?? '').trim();
    // Empty, or still the shipped default the settings seeder wrote: writable.
    if (holdsKey(current) && !atShippedDefault) continue;
    updates[name] = value;
  }
  if (Object.keys(updates).length === 0) return;
  if (!mergeSettings(updates)) return;
  log.info(`Configured the internal model gateway (GPUStack): ${Object.keys(updates).sort().join(', ')}.`);
}

export interface InstallOptions {
  /** Agent shells can open human setup now, or leave it pending for the first GUI visit. */
  setup?: SetupMode;
  /** Internal command purpose: updates keep configured choices and ask only for missing requirements. */
  update?: boolean;
  ide?: string;
  dshProfile?: string;
  /**
   * `openai-compatible` is never a flag value: it is only ever kept from
   * settings.json by an update or non-interactive run (`providerSource: 'persisted'`).
   */
  provider?: 'claude' | 'codex' | 'gemini' | 'openrouter' | 'openai-compatible' | 'host';
  /**
   * How `provider` was decided. `flag` for an explicit `--provider` (and the
   * grok-bot implicit cmem default set in index.ts), `default` when the run
   * fell back to the shipped choice with no `--provider` (the internal model
   * gateway on a TTY, claude when non-interactive), `persisted` when an update or non-interactive
   * run reused the provider already in settings, `prompt` for the interactive
   * multiselect, `browser` for the install funnel's At Home choice. Reported on
   * install_completed as `provider_source`.
   */
  providerSource?: 'flag' | 'default' | 'persisted' | 'prompt' | 'browser';
  model?: string;
  noAutoStart?: boolean;
  disableAutoMemory?: boolean;
  // #2543 — non-interactive runtime selection. `server` is the operator-facing
  // alias for the canonical `server-beta` runtime id.
  runtime?: 'worker' | 'server' | 'server-beta';
  // Base URL the server runtime (and the injected IDE MCP config) targets.
  serverUrl?: string;
}

/**
 * How the installer reacts when the worker port is not free. This runs before
 * the provider step, which the install must still reach, so it aborts only
 * when a live claude-mem worker demonstrably holds the port: the verified owner
 * of the PID file, the worker the stop targeted, is still alive. Its in-memory
 * configuration would outlive the overwrite. A port some other process holds,
 * or one taken again after that worker exited, only warns. Exported for tests.
 */
export function workerShutdownFailure(
  blocker: ShutdownBlocker,
  port: number | string,
): { severity: ErrorSeverity; cause: string; remediation: string } {
  switch (blocker.kind) {
    case 'port-held-by-other-process':
      return {
        severity: ErrorSeverity.WARN_CONTINUE,
        cause: `Port ${port} is held by a process that is not a claude-mem worker (no live claude-mem worker owns it), so the worker cannot listen there.`,
        remediation: `Stop the process using port ${port}, or set CLAUDE_MEM_WORKER_PORT to a free port in ${USER_SETTINGS_PATH}, then run \`npx claude-mem start\`.`,
      };
    case 'port-rebound': {
      const owner = blocker.ownerPid === null ? 'another process' : `another claude-mem worker (PID ${blocker.ownerPid})`;
      return {
        severity: ErrorSeverity.WARN_CONTINUE,
        cause: `The claude-mem worker stopped, but ${owner} took port ${port} again before the install finished: a hook, the MCP server or a process manager started it, or a leftover process still holds the socket.`,
        remediation: 'When the install finishes, run `npx claude-mem restart` (or restart the worker with whatever manages it) so it runs the new version.',
      };
    }
    case 'worker-still-running': {
      if (blocker.pid === null) {
        // Identified only by its /api/health answers: never name that PID in
        // a kill command (it may belong to a container, or be reused).
        return {
          severity: ErrorSeverity.ABORT,
          cause: 'The running claude-mem worker accepted the shutdown request but was still serving after 10 seconds.',
          remediation: 'Run `npx claude-mem stop`, verify it exits, then run `npx claude-mem install` again.',
        };
      }
      // The PID was verified as ours (PID file plus start token) at the
      // deadline, so naming it cannot point the user at an unrelated process.
      const killCommand = process.platform === 'win32' ? `taskkill /PID ${blocker.pid} /F` : `kill ${blocker.pid}`;
      return {
        severity: ErrorSeverity.ABORT,
        cause: `The claude-mem worker (PID ${blocker.pid}) did not stop within 10 seconds.`,
        remediation: `Run \`npx claude-mem stop\`, or end PID ${blocker.pid} (\`${killCommand}\`), then run \`npx claude-mem install\` again.`,
      };
    }
  }
}

/** Evidence sources for the installer's worker stop, injectable so tests never touch a real worker. */
export interface WorkerStopDeps {
  stopWorker?: typeof shutdownWorkerAndWait;
  /** The live, verified PID-file owner, or null. */
  readOwnedWorker?: () => PidInfo | null;
  /** How long to wait for the spawn lock; defaults to the lock's staleness window. */
  spawnLockWaitMs?: number;
}

/**
 * How long the installer waits for the spawn lock: a launcher normally holds
 * it for seconds, and any lock not refreshed within the staleness window can
 * be broken, so waiting that long gets it from a stuck or crashed holder too.
 */
const INSTALL_SPAWN_LOCK_WAIT_MS = SPAWN_LOCK_STALE_MS + 5_000;

/**
 * Stop the running worker, then overwrite the plugin files, holding the spawn
 * lock from before the stop until the overwrite is done. Without it a hook or
 * the MCP server could lazily start a worker from half-copied files the moment
 * the old one exited; the stop then found the port taken again. Exported for
 * tests.
 */
export async function overwriteWithWorkerStopped(
  port: number | string,
  summary: InstallSummary,
  overwrite: () => Promise<void>,
  deps: WorkerStopDeps = {},
): Promise<void> {
  let releaseSpawnLock = await holdSpawnLock(0);
  if (!releaseSpawnLock) {
    log.info('Waiting for another claude-mem launcher to finish starting the worker…');
    releaseSpawnLock = await holdSpawnLock(deps.spawnLockWaitMs ?? INSTALL_SPAWN_LOCK_WAIT_MS);
  }
  if (!releaseSpawnLock) {
    // Only a holder that keeps refreshing the lock (another install running
    // now) gets here. Aborting is not an option this early, so overwrite
    // and say how to recover if a worker started from the half-copied files.
    installerError(ErrorSeverity.WARN_CONTINUE, {
      component: 'worker-shutdown',
      phase: 'pre-overwrite',
      cause: new Error('Another claude-mem process held the worker spawn lock, so the plugin files were overwritten without it.'),
      remediation: 'When the install finishes, run `npx claude-mem restart` so the worker runs the new files.',
    }, summary);
  }
  try {
    await requireWorkerStopped(port, 'pre-overwrite', summary, deps);
    await overwrite();
  } finally {
    releaseSpawnLock?.();
  }
}

/** The verified PID-file owner on `port`, or null; never throws. */
function readOwnedWorkerOnPort(port: number | string, readOwnedWorker: () => PidInfo | null): PidInfo | null {
  try {
    const owner = readOwnedWorker();
    return owner && (!owner.port || Number(owner.port) === Number(port)) ? owner : null;
  } catch {
    return null;
  }
}

/** Exported for tests. */
export async function requireWorkerStopped(
  port: number | string,
  phase: 'pre-overwrite' | 'provider-cutover',
  summary: InstallSummary,
  deps: WorkerStopDeps = {},
): Promise<void> {
  const stopWorker = deps.stopWorker ?? shutdownWorkerAndWait;
  // CLAUDE_MEM_WORKER_AUTOSTART=false: the worker is managed externally
  // (#2828). claude-mem never stops, kills or recycles it, and its manager
  // would restart it the moment it exited, so leave it running and say once
  // how to load the new version.
  if (isWorkerAutostartDisabled({
    CLAUDE_MEM_WORKER_AUTOSTART: getSetting('CLAUDE_MEM_WORKER_AUTOSTART'),
    CLAUDE_MEM_WORKER_URL: getSetting('CLAUDE_MEM_WORKER_URL'),
  })) {
    if (phase === 'pre-overwrite') {
      installerError(ErrorSeverity.WARN_CONTINUE, {
        component: 'worker-shutdown',
        phase,
        cause: new Error('CLAUDE_MEM_WORKER_AUTOSTART=false or CLAUDE_MEM_WORKER_URL is set: the worker is managed externally, so the installer did not stop it.'),
        remediation: 'When the install finishes, restart the worker with whatever manages it so it runs the new version.',
      }, summary);
    }
    return;
  }

  const spinner = isInteractive ? p.spinner() : null;
  const action = phase === 'pre-overwrite'
    ? 'Stopping running worker (so we can overwrite cleanly)…'
    : 'Confirming the old worker is stopped before provider cutover…';
  spinner?.start(action);

  try {
    const result = await stopWorker(port, 10000);
    if (!result.stopped) {
      const failure = workerShutdownFailure(result.blocker, port);
      if (failure.severity === ErrorSeverity.ABORT) {
        spinner?.error('Running worker did not stop; refusing to overwrite its live configuration.');
      }
      // ABORT throws; WARN_CONTINUE records the warning for the end-of-install summary.
      installerError(failure.severity, {
        component: 'worker-shutdown',
        phase,
        cause: new Error(failure.cause),
        remediation: failure.remediation,
      }, summary);
    }

    const stopMessage = result.stopped
      ? result.workerWasRunning
        ? 'Stopped running worker before configuration cutover.'
        : 'No worker running — proceeding.'
      : result.blocker.kind === 'port-rebound'
        ? `Stopped the running worker, but port ${port} was taken again — proceeding.`
        : `Port ${port} is held by another process, not a claude-mem worker — proceeding.`;
    if (spinner) spinner.stop(stopMessage);
    else if (result.workerWasRunning) log.info(stopMessage);
  } catch (error: unknown) {
    if (error instanceof InstallAbortError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (spinner) spinner.error(`Worker shutdown failed: ${message}`);
    // The stop itself failed, so decide from the ownership record alone: a
    // live, verified worker on this port must not have its files overwritten;
    // with none, nothing shows a claude-mem worker holds the port, and the
    // install must still reach the provider step.
    const owner = readOwnedWorkerOnPort(port, deps.readOwnedWorker ?? readOwnedWorkerPidInfo);
    if (owner) {
      const failure = workerShutdownFailure({ kind: 'worker-still-running', pid: owner.pid }, port);
      // ABORT: throws.
      installerError(failure.severity, { component: 'worker-shutdown', phase, cause: error, remediation: failure.remediation }, summary);
      return;
    }
    installerError(ErrorSeverity.WARN_CONTINUE, {
      component: 'worker-shutdown',
      phase,
      cause: error,
      remediation: 'When the install finishes, run `npx claude-mem restart` so the worker runs the new version.',
    }, summary);
  }
}

function holdsKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(holdsKey);
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * Whether a personal Gemini or OpenRouter setup holds a key the worker can use.
 * The worker reads the single key and the rotation pool (which may hold every
 * key, with the single key left empty) from settings.json, the environment and
 * ~/.claude-mem/.env, so each of those counts. Read for validation only: an
 * exported or .env key is never copied to disk.
 */
function hasPersonalProviderKey(provider: 'gemini' | 'openrouter', persisted: Record<string, unknown>): boolean {
  const vendor = provider === 'gemini' ? 'GEMINI' : 'OPENROUTER';
  const credentials = loadClaudeMemEnv() as Record<string, string | undefined>;
  return [`${vendor}_API_KEY`, `${vendor}_API_KEYS`].some(name =>
    holdsKey(persisted[`CLAUDE_MEM_${name}`])
    || holdsKey(process.env[`CLAUDE_MEM_${name}`])
    || holdsKey(credentials[name]),
  );
}

function isPersistedProvider(value: unknown): value is ProviderId {
  return value === 'claude' || value === 'codex' || value === 'gemini'
    || value === 'openrouter' || value === 'openai-compatible';
}

/** Match the worker's credential lookup, including the saved CMEM gateway tuple lock. */
function missingProviderKey(provider: ProviderId, persisted: Record<string, unknown>): { keyName: string; cmemGateway: boolean } | null {
  if (provider !== 'gemini' && provider !== 'openrouter') return null;
  const keyName = provider === 'gemini' ? 'CLAUDE_MEM_GEMINI_API_KEY' : 'CLAUDE_MEM_OPENROUTER_API_KEY';
  const cmemGateway = provider === 'openrouter'
    && isCmemGatewayUrl(String(persisted.CLAUDE_MEM_OPENROUTER_BASE_URL ?? ''))
    && !Object.prototype.hasOwnProperty.call(process.env, 'CLAUDE_MEM_OPENROUTER_BASE_URL');
  const hasKey = cmemGateway ? holdsKey(persisted[keyName]) : hasPersonalProviderKey(provider, persisted);
  return hasKey ? null : { keyName, cmemGateway };
}

/** An update repairs only the missing credential; it never switches a saved provider on cancellation. */
async function completeUpdateProviderSetup(options: InstallOptions, summary: InstallSummary): Promise<void> {
  if (!options.update || options.providerSource !== 'persisted' || !options.provider) return;
  const missing = missingProviderKey(options.provider, readPersistedInstallerSettings());
  if (!missing) return;
  // A saved openrouter config pointing at the cmem gateway with no key cannot
  // be repaired here: this local-only build has no account flow, so say how
  // the key is restored instead of starting an OAuth login.
  if (missing.cmemGateway) {
    installerError(ErrorSeverity.ABORT, {
      component: 'provider-credentials',
      phase: 'provider-cutover',
      cause: new Error('The saved openrouter gateway key is missing.'),
      remediation: 'The saved openrouter gateway key is missing. Save CLAUDE_MEM_OPENROUTER_API_KEY in ~/.claude-mem/settings.json or pass --provider claude to switch to your Anthropic plan.',
    }, summary);
  }
  if (!isInteractive) throw new Error('Provider credentials are missing. Run npx claude-mem update in an interactive terminal to finish setup.');
  log.info(`The configured ${options.provider} provider needs its missing API key to finish setup.`);
  const apiKey = await p.password({
    message: `Paste your ${options.provider === 'gemini' ? 'Gemini' : 'OpenRouter'} API key:`,
    mask: '*',
    validate: (value?: string) => value?.trim() ? undefined : 'API key required',
  });
  if (p.isCancel(apiKey) || !String(apiKey).trim()) {
    throw new Error('Provider setup cancelled. Your existing provider configuration was kept.');
  }
  // Keep the endpoint, model, sync account and any custom provider settings.
  if (!mergeSettings({ [missing.keyName]: String(apiKey).trim() })) {
    throw new Error('Could not save the missing provider API key.');
  }
}

/** Exported for the non-interactive contract tests; not part of the CLI surface. */
export function validateNonInteractiveProvider(
  options: InstallOptions,
  summary: InstallSummary,
): void {
  if (isInteractive) return;

  if (!options.provider) {
    // No `--provider` on a non-TTY run. Aborting here taught agents to re-run
    // with `--provider claude`, which reached the same place with more friction,
    // so the missing flag now resolves instead of failing.
    //
    // A persisted provider wins: `npx claude-mem update` calls this path with no
    // options, and defaulting an existing Pro (openrouter) config to claude would
    // run useSubscriptionAuth() and wipe cloud sync. A persisted personal
    // provider still needs a non-empty key, or the install would report success
    // with a worker that cannot talk to its provider. Unlike the explicit-flag
    // check below, a cmem gateway URL is accepted here: a persisted Pro config
    // keeps its memory key in CLAUDE_MEM_OPENROUTER_API_KEY by design.
    const persisted = readPersistedInstallerSettings();
    const persistedProvider = persisted.CLAUDE_MEM_PROVIDER;
    if (isPersistedProvider(persistedProvider)) {
      // Codex, like claude, authenticates through a local login rather than a
      // saved key, and openai-compatible may point at a local server that takes
      // no key at all, so there is nothing to validate before keeping them.
      const missing = missingProviderKey(persistedProvider, persisted);
      if (missing) {
        const { keyName: persistedKeyName, cmemGateway: persistedCmemGateway } = missing;
        installerError(ErrorSeverity.ABORT, {
          component: 'provider-credentials',
          phase: 'non-interactive-validation',
          cause: new Error(`The configured ${persistedProvider} provider has no API key saved${persistedCmemGateway ? '' : ' or exported'}, so a non-interactive run cannot keep it.`),
          remediation: persistedCmemGateway
            ? `Save ${persistedKeyName} in ~/.claude-mem/settings.json (the cmem gateway ignores an exported key), pass --provider claude to switch to your Anthropic plan, or run the installer in an interactive terminal.`
            : `Save ${persistedKeyName} in ~/.claude-mem/settings.json or export it in the environment, pass --provider claude to switch to your Anthropic plan, or run the installer in an interactive terminal.`,
        }, summary);
      }
      options.provider = persistedProvider;
      options.providerSource = 'persisted';
      log.info(`Non-interactive run: keeping the configured provider (${persistedProvider}).`);
      return;
    }
    options.provider = 'claude';
    options.providerSource = 'default';
    log.info('No --provider given on a non-interactive run: defaulting to your Anthropic plan (local memory).');
  }

  if (options.provider === 'host') return;
  if (options.provider !== 'gemini' && options.provider !== 'openrouter') return;
  // The worker reads the key from settings.json, the environment and
  // ~/.claude-mem/.env, so all three count here — a key held only in .env, or
  // only in the rotation pool, must not abort a run whose remediation names
  // .env. A saved cmem gateway configuration keeps its key in settings.json
  // by design (the gateway ignores an exported key), so its check stays
  // persisted-only via missingProviderKey's tuple lock.
  const missing = missingProviderKey(options.provider, readPersistedInstallerSettings());
  if (missing) {
    installerError(ErrorSeverity.ABORT, {
      component: 'provider-credentials',
      phase: 'non-interactive-validation',
      cause: new Error(`${options.provider} requires a preconfigured personal API key when stdin is not interactive.`),
      remediation: options.provider === 'openrouter'
        ? 'Set CLAUDE_MEM_OPENROUTER_API_KEY (env or ~/.claude-mem/.env) or pass --provider claude.'
        : `Save ${missing.keyName} first, or run the installer in an interactive terminal so it can ask securely.`,
    }, summary);
  }
}

/**
 * Compiles the version-stable hook launcher from the freshly cached plugin and
 * puts `claude-mem` on PATH (plan-17 #3605, Phase 3). Skips the compile when the
 * placed binary already prints the current LAUNCHER_PROTOCOL, but still checks
 * PATH. A failure warns
 * and continues: `doctor` reports the gap and the plugin's SessionStart
 * self-heal (scripts/ensure-launcher.cjs) retries on the next session.
 * Runs inside a spinner task, so lines are returned or queued on the summary,
 * never printed live. Returns the one-line status for the task result.
 */
function placeHookLauncherOnPath(pluginRoot: string, summary: InstallSummary): string {
  const warnHookLauncher = (cause: Error, remediation?: string) => installerError(ErrorSeverity.WARN_CONTINUE, {
    component: 'hook-launcher',
    phase: 'setup-runtime',
    cause,
    remediation: remediation ?? 'Re-run `npx claude-mem install`; `npx claude-mem doctor` shows the hook launcher row.',
  }, summary);
  const launcherStatusLines: string[] = [];
  try {
    const ensureResult = ensureLauncherOnPath({
      pluginRoot,
      // ensureBun ran just before this step and aborts the install without Bun.
      resolveBunPath: getBunPath,
      invocationContext: 'npx-installer',
      logger: {
        info: (line) => launcherStatusLines.push(line),
        success: (line) => launcherStatusLines.push(line),
        warn: (line) => warnHookLauncher(new Error(line)),
      },
    });
    if (ensureResult.status === 'already-current') {
      launcherStatusLines.unshift(`claude-mem launcher already current at ${ensureResult.binaryPath}`);
    } else if (ensureResult.status === 'newer-protocol-kept') {
      launcherStatusLines.unshift(`claude-mem launcher at ${ensureResult.binaryPath} is newer than this installer; kept`);
    } else if (ensureResult.status === 'foreign-binary-kept') {
      return `claude-mem launcher not placed (${ensureResult.binaryPath} is another program; see warnings below)`;
    } else if (ensureResult.status === 'bun-not-found') {
      warnHookLauncher(new Error('Bun not found, the claude-mem launcher was not compiled'));
      return 'claude-mem launcher not placed (Bun not found)';
    }
    return launcherStatusLines.join('\n  ');
  } catch (error: unknown) {
    warnHookLauncher(error instanceof Error ? error : new Error(String(error)));
    return 'claude-mem launcher not placed (see warnings below)';
  }
}

/**
 * The worker script the installer starts: the plugin cache copy for this
 * version, because that is the root "Setting up runtime" runs `bun install` in.
 * The marketplace clone has no node_modules, so a worker started there cannot
 * load its native dependencies (sharp resolved to its wasm build and froze the
 * worker, #5601). The marketplace copy is used only when the cache has none.
 */
export function installedWorkerScriptPath(
  version: string,
  locations: { cacheDirectory: string; marketplaceDirectory: string } = {
    cacheDirectory: pluginCacheDirectory(version),
    marketplaceDirectory: marketplaceDirectory(),
  },
): string {
  const cacheScriptPath = join(locations.cacheDirectory, 'scripts', 'worker-service.cjs');
  if (existsSync(cacheScriptPath)) return cacheScriptPath;
  return join(locations.marketplaceDirectory, 'plugin', 'scripts', 'worker-service.cjs');
}

/**
 * The browser funnel's early worker start, before any login or provider
 * question. Same steps as the final "Starting worker daemon" task.
 */
async function startInstallWorker(version: string, summary: InstallSummary, message: (msg: string) => void): Promise<WorkerStartResult> {
  const port = Number(getSetting('CLAUDE_MEM_WORKER_PORT'));
  const scriptPath = installedWorkerScriptPath(version);
  message(workerStartProgressMessage(isInstallWorkerManagedExternally()));
  await requireWorkerStopped(port, 'provider-cutover', summary);
  return ensureWorkerStarted(port, scriptPath);
}

/**
 * CLAUDE_MEM_WORKER_AUTOSTART=false or CLAUDE_MEM_WORKER_URL: its own manager runs
 * the worker, so the installer only checks it and never launches one.
 */
function isInstallWorkerManagedExternally(): boolean {
  return isWorkerAutostartDisabled({
    CLAUDE_MEM_WORKER_AUTOSTART: getSetting('CLAUDE_MEM_WORKER_AUTOSTART'),
    CLAUDE_MEM_WORKER_URL: getSetting('CLAUDE_MEM_WORKER_URL'),
  });
}

/** The worker ensureWorkerStarted probes: CLAUDE_MEM_WORKER_URL when set, else CLAUDE_MEM_WORKER_HOST on the port. */
function installWorkerBaseUrl(port: number | string): string {
  const explicitWorkerUrl = getSetting('CLAUDE_MEM_WORKER_URL').trim().replace(/\/+$/, '');
  return explicitWorkerUrl || `http://${formatHostForUrl(getSetting('CLAUDE_MEM_WORKER_HOST'))}:${port}`;
}

/** The worker task's progress line. An externally managed worker is checked, not spawned (#6419). */
export function workerStartProgressMessage(managedExternally: boolean): string {
  const port = getSetting('CLAUDE_MEM_WORKER_PORT');
  return managedExternally
    ? `Checking the externally managed worker at ${installWorkerBaseUrl(port)}...`
    : `Spawning worker on port ${port}...`;
}

export function describeWorkerStart(result: WorkerStartResult): string {
  const port = getSetting('CLAUDE_MEM_WORKER_PORT');
  switch (result) {
    case 'ready':
      return `Worker ready at ${installWorkerBaseUrl(port)} ${styleText('green', 'OK')}`;
    case 'warming':
      return `Worker starting on port ${port} — finishing in background ${styleText('yellow', '⏳')}`;
    case 'dead': {
      const startFailure = getLastWorkerBootFailure()?.split('\n')[0];
      return `Worker did not start${startFailure ? ` (${startFailure})` : ''} ${styleText('red', '✗')}`;
    }
  }
}

/** Finish Setup's local tool ids (setup-data.ts SETUP_TOOLS) and the installer IDE each one is. */
const FINISH_SETUP_LOCAL_TOOL_IDES: Record<string, string> = { 'claude-code': 'claude-code', codex: 'codex-cli' };

function readSettingsSnapshot(): string {
  return existsSync(USER_SETTINGS_PATH) ? readFileSync(USER_SETTINGS_PATH, 'utf8') : '';
}

/**
 * Whether the installer leaves the worker for the user to start. A fresh
 * non-interactive install skips it, but an update or reinstall must not: the
 * overwrite already stopped the old worker, so skipping would leave none
 * running. Exported for tests.
 */
export function shouldSkipWorkerAutostart(input: {
  interactive: boolean;
  noAutoStart?: boolean;
  runtime: RuntimeId;
  alreadyInstalled: boolean;
}): boolean {
  // The server runtime is brought up via its own stack (Docker pg+redis +
  // `claude-mem server start`), never the worker-service spawner (#2543).
  if (input.noAutoStart || input.runtime === 'server') return true;
  return !input.interactive && !input.alreadyInstalled;
}

export async function runInstallCommand(options: InstallOptions = {}): Promise<void> {
  const summary = createInstallSummary();
  try {
    await runInstallCommandInner(options, summary);
    clearLastInstallError();
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (err instanceof InstallAbortError) {
      // err.category.id is OUR taxonomy id (error-taxonomy.ts), never a message.
      await captureInstallFailed({
        error_category: err.category.id,
        interactive: isInteractive,
        install_method: detectInstallMethod(),
        claude_code_version: detectClaudeCodeVersion(),
      });
      // Flush whatever warnings accrued before the abort, then print the
      // remediation headline and exit non-zero. ABORT must never reach the
      // "Installation Complete" path.
      flushSummary(summary, (line) => (isInteractive ? p.log.message(line) : console.error(`  ${line}`)));
      const headline = `Installation Aborted: ${err.category.id}`;
      if (isInteractive) {
        p.log.error(headline);
        p.log.error(err.remediation);
        p.outro(styleText('red', 'claude-mem installation aborted.'));
      } else {
        console.error(`\n  ${headline}`);
        console.error(`  ${err.remediation}`);
        console.error(`  ${err.message}`);
      }
      process.exit(1);
    }
    throw error;
  }
}

async function runInstallCommandInner(options: InstallOptions, summary: InstallSummary): Promise<void> {
  // Before any settings read (see isFreshProviderInstall): later reads seed a
  // missing settings.json with the shipped defaults and erase the evidence
  // the GPUStack defaults decision needs.
  freshProviderInstall = isFreshProviderInstall(options);

  // Explicit host/runtime incompatibility must refuse before provider getters,
  // runtime settings persistence, or server API-key bootstrap.
  if (options.ide && options.runtime !== undefined) {
    const requested = normalizeRuntimeFlag(options.runtime);
    if (requested !== null) requireSupportedRuntime([canonicalIntegrationId(options.ide)], requested);
  }

  const installStartedAt = Date.now();
  const version = readPluginVersion();
  // Snapshot before settings getters can fill defaults. A legacy install has
  // no browser completion marker; its saved provider still counts as setup.
  const savedSetup = readSetupState();
  if (options.update && !options.provider) {
    const persisted = readPersistedInstallerSettings();
    const provider = persisted.CLAUDE_MEM_PROVIDER;
    const legacyDefault = provider === undefined && !savedSetup.install
      && existsSync(join(marketplaceDirectory(), 'plugin', '.claude-plugin', 'plugin.json'));
    if ((isInteractive && isPersistedProvider(provider)) || legacyDefault) {
      options.provider = isPersistedProvider(provider) ? provider : 'claude';
      options.providerSource = 'persisted';
    }
  }
  const resumeSetup = options.setup === 'resume';
  const defaultDeferredSetup = !isInteractive && !options.update && !options.provider && !options.ide && !options.noAutoStart
    && (!options.runtime || options.runtime === 'worker') && !isInstallRunByAutoUpdate();
  const deferSetup = options.setup === 'defer' || (!options.setup && defaultDeferredSetup);
  if (!deferSetup && options.setup !== 'browser' && !resumeSetup) validateNonInteractiveProvider(options, summary);
  // Captured by the runtime-setup task below; reported on install_completed
  // so funnel dropoff can be sliced by toolchain versions.
  let installedBunVersion: string | undefined;
  let installedUvVersion: string | undefined;

  if (isInteractive) {
    if (!options.update) await playBanner();
    p.intro(styleText(['bgCyan', 'black'], options.update ? ' claude-mem update ' : ' claude-mem install '));
  } else {
    console.log(options.update ? 'claude-mem update' : 'claude-mem install');
  }
  const marketplaceDir = marketplaceDirectory();
  const alreadyInstalled = existsSync(join(marketplaceDir, 'plugin', '.claude-plugin', 'plugin.json'));

  let existingVersion: string | undefined;
  if (alreadyInstalled) {
    try {
      const existingPluginJson = JSON.parse(
        readFileSync(join(marketplaceDir, 'plugin', '.claude-plugin', 'plugin.json'), 'utf-8'),
      );
      existingVersion = existingPluginJson.version ?? undefined;
    } catch (error: unknown) {
      console.warn('[install] Failed to read existing plugin version:', error instanceof Error ? error.message : String(error));
    }
  }

  const dot = styleText('dim', '·');
  const segments = [`${styleText('bold', 'claude-mem')} ${styleText('cyan', `v${version}`)}`];
  if (existingVersion && existingVersion !== version) {
    segments.push(`installed ${styleText('yellow', `v${existingVersion}`)}`);
  } else if (existingVersion) {
    segments.push(styleText('dim', 'reinstall'));
  }
  log.info(segments.join(` ${dot} `));

  // Runtime hooks run the on-PATH claude-mem launcher in exec form, with no
  // shell. Only the Setup hook (version-check.js) still declares
  // `"shell": "bash"`, and Claude Code fires it only for `claude --init` /
  // `--maintenance`; on Windows it resolves bash through Git for Windows with
  // no WSL fallback. A warning, not a hard stop: memory capture works without
  // Git Bash, and Git for Windows can be installed later without a reinstall.
  if (IS_WINDOWS) {
    const gitBash = checkWindowsGitBash();
    if (!gitBash.ok) {
      log.warn(gitBash.detail);
    }
  }

  // An older Claude Code ignores the hooks' `args` and runs bare `claude-mem`,
  // which captures nothing and tells no one, so say it here.
  const claudeCodeTooOldWarning = claudeCodeVersionTooOldWarning(detectClaudeCodeVersion());
  if (claudeCodeTooOldWarning) log.warn(claudeCodeTooOldWarning);

  const setupComplete = savedSetup.status === 'complete';
  const browserSetup = deferSetup || resumeSetup || options.setup === 'browser' || shouldUseBrowserSetup({
    interactive: isInteractive, provider: options.provider, noAutoStart: options.noAutoStart,
    runtime: normalizeRuntimeFlag(options.runtime ?? 'worker') ?? 'worker', setupComplete, update: options.update,
  });
  const resumedState = resumeSetup ? readSetupState() : null;
  if (resumeSetup && !resumedState?.install) throw new Error('There is no deferred setup to resume.');
  const installCatalog = resumedState?.install?.catalog ?? (browserSetup ? browserInstallCatalog(options, alreadyInstalled) : null);

  if (alreadyInstalled && !browserSetup && !options.update) {
    if (process.stdin.isTTY) {
      const shouldContinue = await p.confirm({
        message: 'Overwrite existing installation?',
        initialValue: true,
      });

      if (p.isCancel(shouldContinue) || !shouldContinue) {
        p.cancel('Installation cancelled.');
        process.exit(0);
      }
    }
  }

  // A pre-12.4.7 `alias claude-mem=` in the shell rc beats PATH, so it shadows
  // the launcher and roots the CLI — and, through `start`, the worker — in
  // the marketplace clone (#6228). Uninstall already strips it; install and
  // update are the commands a user carrying the alias actually runs, so strip
  // it here too. The strip runs only after the overwrite confirmation above:
  // declining or cancelling a reinstall must leave the user's shell files
  // exactly as they were. The strip prints one line per file it rewrites.
  stripLegacyClaudeMemAlias();

  let selectedIDEs: string[];
  if (options.ide) {
    const ideId = canonicalIntegrationId(options.ide);
    selectedIDEs = [ideId];
    const allIDEs = detectInstalledIDEs();
    const match = allIDEs.find((i) => i.id === ideId);
    if (!match) {
      log.error(`Unknown agent for --ide: ${options.ide}`);
      log.info(`Available --ide values: ${allIDEs.map((i) => i.id).join(', ')}`);
      process.exit(1);
    }
  } else if (browserSetup) {
    selectedIDEs = [];
  } else if (options.update && (alreadyInstalled || setupComplete || savedSetup.install?.selection || options.providerSource === 'persisted')) {
    const savedAgents = savedSetup.install?.selection?.agents ?? [];
    const savedTools = (savedSetup.tools ?? []).map(tool => FINISH_SETUP_LOCAL_TOOL_IDES[tool]).filter(Boolean);
    selectedIDEs = [...new Set([...savedAgents, ...savedTools].map(canonicalIntegrationId))];
    // Legacy installers did not record agent selections. Refresh the shared
    // plugin without opting into every agent merely detected on the machine.
    if (!selectedIDEs.length) selectedIDEs = ['claude-code'];
    options.dshProfile ??= savedSetup.install?.selection?.dshProfile;
  } else if (process.stdin.isTTY) {
    selectedIDEs = await promptForIDESelection();
  } else {
    selectedIDEs = ['claude-code'];
  }

  const selectedRuntime = browserSetup ? 'worker' : await promptRuntime(options, selectedIDEs);
  if (browserSetup && !mergeSettings({ CLAUDE_MEM_RUNTIME: 'worker' })) throw new Error('Could not configure the worker runtime.');

  let workerStartResult: WorkerStartResult = 'dead';
  // Claude Code consumes the marketplace plugin system directly, so any selection
  // (claude-code or otherwise) needs the marketplace + plugin registration steps.
  // The only time we'd skip is a hypothetical no-IDE install, which the prompt above
  // doesn't allow today.
  const needsMarketplace = browserSetup || selectedIDEs.length > 0;

  if (!resumeSetup) {
    const tasks: TaskDescriptor[] = [
      {
        title: 'Caching plugin version',
        task: async (message) => {
          message(`Caching v${version}...`);
          await copyPluginToCache(version);
          return `Plugin cached (v${version}) ${styleText('green', 'OK')}`;
        },
      },
      {
        title: 'Setting up runtime (first install can take ~30s)',
        task: async (message) => {
          message('Checking Bun…');
          const { version: bunVersion } = await ensureBun(summary);
          message('Checking uv…');
          const { version: uvVersion } = await ensureUv(summary);
          installedBunVersion = bunVersion;
          installedUvVersion = uvVersion;
          const cacheDir = pluginCacheDirectory(version);
          if (!isInstallCurrent(cacheDir, version)) {
            const { bunPath } = await ensureBun();
            const stopHeartbeat = startHeartbeat(message, 'Installing plugin dependencies (bun install)…');
            try {
              await installPluginDependencies(cacheDir, bunPath);
            } finally {
              stopHeartbeat();
            }
            writeInstallMarker(cacheDir, version, bunVersion, uvVersion);
          }
          // Installs run with lifecycle scripts suppressed, so tree-sitter-cli's
          // own download never ran (#2910). This runs before the provider
          // step, so a failure only warns and a stalled download is cut off at
          // TREE_SITTER_INSTALL_BUDGET_MS; `npx claude-mem repair` retries it
          // with the full dependency timeout.
          const stopTreeSitterHeartbeat = startHeartbeat(message, 'Checking the tree-sitter CLI…');
          try {
            await provisionTreeSitterCli(cacheDir, ErrorSeverity.WARN_CONTINUE, summary, TREE_SITTER_INSTALL_BUDGET_MS);
          } finally {
            stopTreeSitterHeartbeat();
          }
          writeInstallMarker(join(marketplaceDirectory(), 'plugin'), version, bunVersion, uvVersion);
          message('Placing the claude-mem hook launcher on PATH…');
          const launcherStatus = placeHookLauncherOnPath(cacheDir, summary);
          return `Runtime ready (Bun ${bunVersion}, uv ${uvVersion}) ${styleText('green', 'OK')}\n  ${launcherStatus}`;
        },
      },
    ];

    if (!browserSetup) tasks.splice(1, 0,
      {
        title: 'Registering marketplace',
        task: async () => {
          registerMarketplace();
          return `Marketplace registered ${styleText('green', 'OK')}`;
        },
      },
      {
        title: 'Registering plugin',
        task: async () => {
          registerPlugin(version);
          return `Plugin registered ${styleText('green', 'OK')}`;
        },
      },
      {
        title: 'Enabling plugin in Claude settings',
        task: async () => {
          if (options.update && alreadyInstalled) return 'Keeping Claude Code plugin preferences';
          enablePluginInClaudeSettings();
          return `Plugin enabled ${styleText('green', 'OK')}`;
        },
      },
    );

    if (needsMarketplace) {
      tasks.unshift({
        title: 'Copying plugin files to marketplace',
        task: async (message) => {
          message('Copying to marketplace directory...');
          copyPluginToMarketplace();
          return `Plugin files copied ${styleText('green', 'OK')}`;
        },
      });
      tasks.push({
        title: 'Installing marketplace dependencies',
        task: async (message) => {
          // runNpmInstallInMarketplace throws InstallAbortError on a real
          // failure (non-ERESOLVE, or ERESOLVE that --legacy-peer-deps could
          // not fix). We deliberately do NOT swallow it here — the top-level
          // handler turns it into "Installation Aborted" + exit 1.
          const stopHeartbeat = startHeartbeat(message, 'Running npm install…');
          try {
            await runNpmInstallInMarketplace(summary);
            writeMarketplaceInstallMarkers(
              marketplaceDirectory(),
              version,
              installedBunVersion ?? 'unknown',
              installedUvVersion ?? 'unknown',
            );
          } finally {
            stopHeartbeat();
          }
          return `Dependencies installed ${styleText('green', 'OK')}`;
        },
      });
    }

    if (needsMarketplace) {
      await overwriteWithWorkerStopped(getSetting('CLAUDE_MEM_WORKER_PORT'), summary, () => runTasks(tasks));
    } else {
      await runTasks(tasks);
    }
  }

  if (deferSetup) {
    writeSetupState({ ...INITIAL_SETUP_STATE, install: { status: 'waiting', catalog: installCatalog!, selection: null, error: null } });
    if (!options.noAutoStart) {
      await runTasks([{
        title: 'Starting worker daemon',
        task: async message => {
          workerStartResult = await startInstallWorker(version, summary, message);
          return describeWorkerStart(workerStartResult);
        },
      }]);
    }
    if (!options.noAutoStart && (workerStartResult as WorkerStartResult) === 'dead') {
      // The setup page is served by the worker, so a saved setup with no worker is not "waiting" for anyone.
      // --no-auto-start skips the start on purpose; that run leaves the worker to the caller.
      log.error('Setup is saved, but the worker did not start, so the setup page is not available. Run npx claude-mem doctor, then retry npx claude-mem install --setup defer.');
      process.exitCode = 1;
      return;
    }
    log.info(`Installed. Setup is waiting at http://127.0.0.1:${getSetting('CLAUDE_MEM_WORKER_PORT')}/?setup=1`);
    log.info('AGENT: If the user is available, run npx claude-mem install --setup browser. Otherwise leave setup pending for their first visit.');
    return;
  }

  if (resumedState?.install?.status === 'ready' && resumedState.install.selection) {
    selectedIDEs = [...resumedState.install.selection.agents];
    options.model = browserModelChoice(resumedState.install.selection, resumedState.install.catalog, options.model);
  }

  const failedIDEs = browserSetup ? [] : await setupIDEs(selectedIDEs, summary, options.dshProfile);

  // Optionally disable Claude Code's built-in auto-memory (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1)
  // when the user explicitly opts in, either through the interactive prompt or
  // via --disable-auto-memory. claude-mem's hook-based memory is the intended
  // source of cross-session context, but we no longer mutate settings.json silently.
  // Four-state so the summary can distinguish "wrote", "already set", "left enabled",
  // and "failed". A boolean would conflate the error path with a deliberate no-op.
  let autoMemoryStatus: 'disabled' | 'already-disabled' | 'left-enabled' | 'failed' | null = null;
  const autoMemoryChoice = browserSetup ? 'not-applicable' : await resolveClaudeAutoMemoryChoice(selectedIDEs, options);
  if (autoMemoryChoice === 'disable') {
    try {
      const wrote = disableClaudeAutoMemory();
      autoMemoryStatus = wrote ? 'disabled' : 'already-disabled';
      if (wrote) {
        log.success('Claude Code: auto-memory disabled (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1).');
      } else {
        log.info('Claude Code: auto-memory already disabled, leaving settings.json untouched.');
      }
    } catch (error: unknown) {
      // Don't fail the install over this — WARN_CONTINUE via the central handler.
      autoMemoryStatus = 'failed';
      const err = error instanceof Error ? error : new Error(String(error));
      // [ANTI-PATTERN IGNORED]: recorded via installerError(WARN_CONTINUE) and flushed after the spinners; a direct console call would be clobbered by the clack UI.
      installerError(ErrorSeverity.WARN_CONTINUE, {
        component: 'auto-memory',
        phase: 'post-ide',
        cause: err,
      }, summary);
    }
  } else if (autoMemoryChoice === 'leave-enabled') {
    autoMemoryStatus = 'left-enabled';
    log.info('Claude Code: leaving native auto-memory enabled unless you explicitly opt in to disabling it.');
  }

  // Browser funnel (GUI mode): the worker starts before any provider
  // question, the setup page opens, and the terminal waits on the worker's
  // setup state with no time limit. Every choice is local; there is no login.
  let browserProvider: ProviderId = (getSetting('CLAUDE_MEM_PROVIDER') as ProviderId) || 'claude';
  let browserOutcome: BrowserSetupOutcome | null = null;
  let settingsBeforeBrowserSetup: string | null = null;
  if (browserSetup) {
    startSetupSession(undefined, hasExistingConfiguration(SettingsDefaultsManager.loadFromFile(USER_SETTINGS_PATH, true, { readOnly: true }) as unknown as Record<string, unknown>));
    const setupStateBeforeBrowser = readSetupState();
    try {
      // Mark this GUI setup before the worker's first refresh tick: its scan uses hosted extraction,
      // so existing prompts must not launch a local agent while the browser is still opening.
      if (!resumeSetup) writeSetupState({ ...INITIAL_SETUP_STATE });
      settingsBeforeBrowserSetup = readSettingsSnapshot();
      if (resumeSetup) workerStartResult = 'ready';
      else await runTasks([{
        title: 'Starting worker daemon',
        task: async (message) => {
          workerStartResult = await startInstallWorker(version, summary, message);
          return describeWorkerStart(workerStartResult);
        },
      }]);
      if ((workerStartResult as WorkerStartResult) === 'dead') {
        throw new Error('The setup page needs the worker, which did not start. Run npx claude-mem doctor, then retry npx claude-mem install.');
      } else {
        browserOutcome = await runBrowserSetup({
          workerBaseUrl: `http://127.0.0.1:${getSetting('CLAUDE_MEM_WORKER_PORT')}`,
          resume: resumeSetup,
          openBrowser,
          log,
          install: {
            catalog: installCatalog!,
            apply: async (served) => {
              // The worker never serves the email or note, so read the submitted selection from the state file.
              const stored = readSetupState().install?.selection;
              const selection = { ...served, email: stored?.email, note: stored?.note };
              // The worker validates against this run's catalog; keep the CLI boundary safe too.
              if (!selection.agents.length || selection.agents.some(id => !installCatalog!.agents.some(agent => agent.id === id))) {
                throw new Error('Choose at least one supported agent.');
              }
              if (selection.installClaudeCode && selection.agents.includes('claude-code') && !await installClaudeCode()) {
                throw new Error('Claude Code could not be installed. Try again, or turn off Install Claude Code and install it later.');
              }
              const disabledSkills = installCatalog!.skills
                .filter(skill => !skill.required && !selection.skills.includes(skill.id)).map(skill => skill.id);
              if (!installCatalog!.skillsLocked && !mergeSettings({ CLAUDE_MEM_SKILLS_DISABLED: disabledSkills.join(',') })) {
                throw new Error('Could not save the selected skills.');
              }
              for (const root of [pluginCacheDirectory(version), join(marketplaceDirectory(), 'plugin')]) {
                const applied = applyConfiguredSkillSelection(root);
                for (const warning of applied.warnings) log.warn(warning);
              }
              registerMarketplace();
              registerPlugin(version);
              if (selection.agents.includes('claude-code')) enablePluginInClaudeSettings();
              const attempt = createInstallSummary();
              await setupIDEs(selection.agents, attempt, selection.dshProfile ?? options.dshProfile);
              if (attempt.failedIDEs.length) {
                throw new Error(`Could not finish setup for ${attempt.failedIDEs.join(', ')}. ${attempt.warnings.map(w => w.message).join(' ')}`);
              }
              summary.warnings.push(...attempt.warnings);
              selectedIDEs = [...selection.agents];
              options.model = browserModelChoice(selection, installCatalog!, options.model);
              if (selectedIDEs.includes('claude-code')) {
                autoMemoryStatus = selection.disableAutoMemory
                  ? disableClaudeAutoMemory() ? 'disabled' : 'already-disabled'
                  : 'left-enabled';
                if (!selection.disableAutoMemory) enableClaudeAutoMemory();
              }
              if (!installCatalog!.telemetryLocked) recordTelemetryDecision(selection.telemetryEnabled);
            },
          },
          applyChoice: async (choice, chosen) => {
            // A machine with an existing configuration keeps it untouched (design 4a): no provider
            // question is re-answered and nothing is written over it, and the funnel names that
            // outcome `home-kept-existing` (the setup page and the summary read the stage).
            if (chosen.alreadyPro) {
              options.providerSource = 'persisted';
              return 'home-kept-existing';
            }
            // A fresh machine lands in the same state as a fresh terminal install (design 4a):
            // the internal model gateway with its GPUStack defaults, the key read from the
            // environment, ~/.claude-mem/.env or settings, or asked for in this terminal while
            // the browser waits. promptProvider applies the shipped defaults itself, so nothing
            // is duplicated here; an explicit --provider flag keeps winning over the funnel.
            const funnelChoosesProvider = options.providerSource !== 'flag';
            if (funnelChoosesProvider) {
              options.provider = undefined;
              options.providerSource = 'browser';
            }
            browserProvider = await promptProvider(options);
            // promptProvider words a no-flag resolution 'default'; the funnel keeps its own source.
            if (funnelChoosesProvider) options.providerSource = 'browser';
            await promptClaudeModel(options, false);
            return 'home-ready';
          },
        });
      }
    } catch (error) {
      // A reinstall that fails before its install hand-off exists must not leave a machine that completed
      // onboarding reading as pending with nothing to resume. Once the hand-off is written, keep it: My Work and
      // SessionStart then point back to the pending choices.
      const current = readSetupState();
      if (setupStateBeforeBrowser.status === 'complete' && current.status !== 'complete' && !current.install) {
        writeSetupState(setupStateBeforeBrowser);
      }
      throw error;
    } finally {
      // Preserve saved choices and errors, but release the local-work pause on every hand-off exit.
      endSetupSession();
    }
  }

  // Finish Setup's picked local tools that this run did not install yet are set up now, the same way.
  const pickedTools = (browserOutcome as BrowserSetupOutcome | null)?.state.tools ?? [];
  const newlyPickedIDEs = pickedTools.map((tool) => FINISH_SETUP_LOCAL_TOOL_IDES[tool]).filter((ide): ide is string => Boolean(ide) && !selectedIDEs.includes(ide!));
  if (newlyPickedIDEs.length) {
    // Failures land on summary.failedIDEs, the same list the summary reads.
    await setupIDEs(newlyPickedIDEs, summary, options.dshProfile);
    selectedIDEs = [...selectedIDEs, ...newlyPickedIDEs];
  }

  // The terminal flow: non-TTY (agent-run) installs, --provider, --no-auto-start,
  // the server runtime, and machines that already finished the funnel.
  const terminalAccountAndProvider = async (): Promise<ProviderId> => {
    // An update with a persisted provider repairs only a missing credential
    // (completeUpdateProviderSetup); everything else keeps its configuration.
    await completeUpdateProviderSetup(options, summary);
    // This build installs fully locally: there is no claude-mem sign-in, no
    // browser OAuth and no account step, whatever provider is resolved. The
    // provider step below applies the GPUStack defaults for a fresh openrouter
    // install and asks for a missing gateway key locally.
    log.info('Skipping claude-mem sign-in: this build installs fully locally.');
    const selectedProvider = await promptProvider(options);
    if (selectedProvider === 'claude') {
      await promptClaudeModel(options, isInteractive && !(options.update && options.providerSource === 'persisted'));
    }
    return selectedProvider;
  };
  const selectedProvider = browserOutcome ? browserProvider : await terminalAccountAndProvider();
  const cloudSyncConfigured = [
    getSetting('CLAUDE_MEM_CLOUD_SYNC_TOKEN'),
    getSetting('CLAUDE_MEM_CLOUD_SYNC_USER_ID'),
    getSetting('CLAUDE_MEM_CLOUD_SYNC_HUB_URL'),
  ].every((value) => typeof value === 'string' && value.trim().length > 0);

  const autoStartSkipped = shouldSkipWorkerAutostart({
    interactive: isInteractive,
    noAutoStart: options.noAutoStart,
    runtime: selectedRuntime,
    alreadyInstalled,
  });
  // CLAUDE_MEM_WORKER_AUTOSTART=false: its own manager runs the worker, so a
  // worker that is not up yet is that manager's to start, not an install failure.
  const workerManagedExternally = isInstallWorkerManagedExternally();

  await runTasks([
    {
      title: selectedRuntime === 'server' ? 'Starting server daemon' : 'Starting worker daemon',
      task: async (message) => {
        if (selectedRuntime === 'server') {
          return `Server runtime selected — start it with ${styleText('bold', 'npx claude-mem server start')} ${styleText('dim', '(or via Docker compose)')}`;
        }
        if (autoStartSkipped) {
          return options.noAutoStart
            ? `Skipped (--no-auto-start)`
            : `Skipped (non-TTY)`;
        }
        // The browser funnel started the worker already. It reads the provider and model live, so it restarts only
        // for settings it reads at boot (cloud sync, when a saved configuration carries it), and never while it is extracting
        // goals, work and rules or importing history: the restart waits for that work, however long it takes.
        if (browserOutcome) {
          const needRestart = settingsChangesNeedingRestart(settingsBeforeBrowserSetup ?? '', readSettingsSnapshot());
          if (!needRestart.length) return describeWorkerStart(workerStartResult);
          message('Waiting for the worker to finish its setup work before it restarts...');
          await waitForBackgroundWorkToFinish({ workerBaseUrl: `http://127.0.0.1:${getSetting('CLAUDE_MEM_WORKER_PORT')}`, log: { info: message, warn: message } });
        }
        const port = Number(getSetting('CLAUDE_MEM_WORKER_PORT'));
        const scriptPath = installedWorkerScriptPath(version);
        // selectedRuntime is narrowed to 'worker' here: the server case
        // returned above and never reaches the worker-service spawner.
        message(workerStartProgressMessage(workerManagedExternally));
        // Stop any worker that came up during install with the previous
        // provider so the RAM queue cannot mix old/new settings. Runtime
        // POST /api/settings still must not recycle a healthy worker.
        await requireWorkerStopped(port, 'provider-cutover', summary);
        workerStartResult = await ensureWorkerStarted(port, scriptPath);
        return describeWorkerStart(workerStartResult);
      },
    },
  ]);

  // "Installation Complete" only when no ABORT fired (we'd have thrown) AND no
  // IDE failed. Any failed IDE => "Installation Partial". Reads summary.failedIDEs
  // (which captures failures that happen AFTER bufferConsole returns), not a
  // stale local count.
  const hasFailures = summary.failedIDEs.length > 0;
  const installStatus = options.update
    ? hasFailures ? 'Update Partial' : 'Update Complete'
    : hasFailures ? 'Installation Partial' : 'Installation Complete';
  // No account step exists in this local-only build. The browser funnel's kept-existing
  // run sets providerSource 'persisted' (applyChoice), so the mapping below already words
  // both outcomes: 'Kept existing configuration', or the fresh local install's.
  // The provider this run ended up with: the default openrouter path sets it,
  // and a named provider wins, because host reports its transport (openrouter).
  const summaryProvider = options.provider ?? selectedProvider;
  // A no-flag run (terminal or browser funnel) ends on the shipped gateway
  // defaults, so the summary names it; an explicit --provider openrouter may
  // point at any OpenRouter-compatible endpoint, so it keeps the neutral line.
  const accountStatus = options.providerSource === 'persisted'
    ? 'Kept existing configuration'
    : summaryProvider === 'host' ? 'Not required (host observer)'
    : summaryProvider === 'openrouter' && (options.providerSource === 'default' || options.providerSource === 'browser')
      ? 'Internal model gateway (GPUStack)'
      : 'Not required (local install)';
  const summaryLines = [
    `Version:     ${styleText('cyan', version)}`,
    `Plugin dir:  ${styleText('cyan', marketplaceDir)}`,
    `Agents:      ${styleText('cyan', selectedIDEs.join(', '))}`,
  ];
  summaryLines.push(`Account:     ${styleText('cyan', accountStatus)}`);
  summaryLines.push(`Cloud sync:  ${styleText('cyan', cloudSyncConfigured ? 'ON' : 'OFF (local)')}`);
  if (autoMemoryStatus === 'disabled') {
    summaryLines.push(`Auto-memory: ${styleText('cyan', 'disabled')} (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1)`);
  } else if (autoMemoryStatus === 'already-disabled') {
    summaryLines.push(`Auto-memory: ${styleText('cyan', 'already disabled')} (CLAUDE_CODE_DISABLE_AUTO_MEMORY=1)`);
  } else if (autoMemoryStatus === 'left-enabled') {
    summaryLines.push(`Auto-memory: ${styleText('cyan', 'left enabled')} (native Claude Code memory preserved)`);
  } else if (autoMemoryStatus === 'failed') {
    summaryLines.push(`Auto-memory: ${styleText('red', 'write failed')} (see warning above)`);
  }
  if (failedIDEs.length > 0) {
    summaryLines.push(`Failed:      ${styleText('red', failedIDEs.join(', '))}`);
  }

  if (isInteractive) {
    p.note(summaryLines.join('\n'), installStatus);
  } else {
    console.log(`\n  ${installStatus}`);
    summaryLines.forEach(l => console.log(`  ${l}`));
  }

  // Flush all WARN_CONTINUE / FAIL_LOUD_PER_IDE warnings + remediation AFTER the
  // spinners and summary note (a live print would be clobbered by clack).
  flushSummary(summary, (line) => (isInteractive ? p.log.message(line) : console.log(`  ${line}`)));

  const workerHost = getSetting('CLAUDE_MEM_WORKER_HOST');
  const workerUrlHost = formatHostForUrl(workerHost);
  const workerPort = getSetting('CLAUDE_MEM_WORKER_PORT');

  let actualPort: number | string = workerPort;
  let workerReady = false;
  // Don't poll the worker or imply it's "still starting" when autostart was
  // intentionally skipped (--no-auto-start, or non-interactive default). The
  // user knows they have to start it themselves; lying about a starting worker
  // is misleading.
  if (!autoStartSkipped) {
    const healthSpinner = isInteractive ? p.spinner() : null;
    healthSpinner?.start(`Verifying worker on port ${workerPort}…`);
    try {
      const healthResponse = await fetch(`http://${workerUrlHost}:${workerPort}/api/health`, {
        signal: AbortSignal.timeout(3000),
      });
      if (healthResponse.ok) {
        workerReady = true;
        try {
          const body = await healthResponse.json() as { port?: number | string };
          if (body && (typeof body.port === 'number' || typeof body.port === 'string')) {
            actualPort = body.port;
          }
        } catch {
          // Health endpoint returned non-JSON — keep using the requested port.
        }
      }
      healthSpinner?.stop(
        workerReady
          ? `Worker ready at http://${workerUrlHost}:${actualPort}`
          : `Worker reachable but not ready on port ${workerPort}`,
      );
    } catch {
      healthSpinner?.stop(`Worker not yet responding on port ${workerPort} (still starting)`);
    }

    // Cloud-sync settings the worker booted with may predate this run (saved
    // by an older install), so one cheap read of /api/sync/status confirms
    // sync is really configured.
    // Purely informational and fail-soft — a warming worker legitimately
    // can't answer yet, and the state is always visible via the cloud-sync skill.
    if (cloudSyncConfigured && workerReady) {
      try {
        // /api/sync/status takes the local API token when that mode is on (#5141).
        // The installer passes no remote token host, so the shared rule (#6390) never
        // carries the token to another machine from here: a remote worker is read by the
        // clients that the person opted in, not by the installer.
        const syncOrigin = `http://${workerUrlHost}:${actualPort}`;
        const syncHeaders = localApiTokenHeadersFor({
          token: readLocalApiToken(),
          workerOrigin: syncOrigin,
          localOrigin: syncOrigin,
          configuredHost: workerHost,
          remoteTokenHost: '',
        });
        const syncResponse = await fetch(`${syncOrigin}/api/sync/status`, {
          ...(Object.keys(syncHeaders).length > 0 ? { headers: syncHeaders } : {}),
          signal: AbortSignal.timeout(3000),
        });
        if (syncResponse.ok) {
          const sync = await syncResponse.json() as { configured?: boolean };
          if (sync && sync.configured === false) {
            log.warn('Cloud sync: worker has not picked up the sync settings yet — it will on its next restart.');
          } else {
            log.success('Cloud sync: configured — the worker is reporting sync status.');
          }
        }
      } catch {
        // [ANTI-PATTERN IGNORED]: this read-through is purely informational; a worker still warming up legitimately can't answer, and sync state stays visible via the cloud-sync skill.
      }
    }
  }

  const finalWorkerState = workerStartResult as WorkerStartResult;
  const workerAlive = finalWorkerState !== 'dead' || workerReady;
  const workerFailedToStart = !autoStartSkipped && !workerManagedExternally && !workerAlive;
  const workerBootFailure = workerFailedToStart ? getLastWorkerBootFailure() : undefined;
  const runtimeLabel = selectedRuntime === 'server' ? 'Server' : 'Worker';
  const runtimeStartCommand = selectedRuntime === 'server' ? 'npx claude-mem server start' : 'npx claude-mem start';
  const workerBaseUrl = `http://${workerUrlHost}:${actualPort}`;
  const configuredWorkerBaseUrl = `http://${workerUrlHost}:${workerPort}`;
  const workerHeadline = autoStartSkipped
    ? `${styleText('yellow', '!')} ${runtimeLabel} autostart skipped — start it manually with ${styleText('bold', runtimeStartCommand)}`
    : workerReady || finalWorkerState === 'ready'
      ? `${styleText('green', '✓')} ${runtimeLabel} running at ${styleText('underline', workerBaseUrl)}`
      : `${styleText('yellow', '⏳')} ${runtimeLabel} starting at ${styleText('underline', workerBaseUrl)} — give it ~30s, then refresh`;
  const nextStepsHeadline = workerFailedToStart
    ? `${styleText('red', '✗')} Worker did not start on port ${styleText('cyan', String(workerPort))}${workerBootFailure ? `: ${workerBootFailure}` : ''} — run ${styleText('bold', 'npx claude-mem doctor')}, then ${styleText('bold', 'npx claude-mem start')}`
    : autoStartSkipped || workerAlive
      ? workerHeadline
      : `${styleText('yellow', '!')} Worker not yet ready on port ${styleText('cyan', String(workerPort))} -- still starting up; check ${styleText('bold', 'claude-mem status')} later, or start manually: ${styleText('bold', 'npx claude-mem start')}`;
  const firstSuccessOpener = autoStartSkipped
    ? `once the worker is running, keep ${styleText('underline', configuredWorkerBaseUrl)} open in a browser`
    : workerAlive
      ? 'keep that URL open in a browser'
      : `keep ${styleText('underline', configuredWorkerBaseUrl)} open in a browser`;
  // Last screen of the funnel: it should read as an invitation to start, not a
  // manual. Everything here has to earn its line.
  //
  // Cut deliberately: the WELCOME_HINT_ENABLED env var (opting out of a hint
  // they have not seen yet), the uninstall warning (uninstall trivia on the
  // install screen), and the A/B "two paths" framing that dressed up "just
  // start working" as a decision the user has to make.
  const nextSteps = options.update ? [nextStepsHeadline] : [
    nextStepsHeadline,
    ``,
    `${styleText('bold', 'Start working.')} Memory builds passively from your first prompt — observations stream in as your agent reads, edits, and runs commands.`,
    `To watch them live, ${firstSuccessOpener}.`,
    ``,
    `Memory injection starts on your second session in a project.`,
    cloudSyncConfigured
      ? 'Saved memories sync across your connected agents and devices.'
      : `Everything stays in ${styleText('cyan', '~/.claude-mem')} on this machine. Memory runs on the internal model gateway; nothing is sent to external services (telemetry is separate: npx claude-mem telemetry).`,
    ``,
    `${styleText('dim', `Optional: ${'/learn-codebase'} ingests a whole repo up front (~5 min)   ·   How it works: /how-it-works`)}`,
  ];

  if (isInteractive) {
    p.note(nextSteps.join('\n'), 'Next Steps');
    // Deliberately the last interaction of the flow: consent is asked after
    // the product is installed and working, never as a gate in front of it.
    if (!browserSetup && !options.update) await promptTelemetryOptIn();
    if (workerFailedToStart) {
      p.outro(styleText('red', 'claude-mem installed, but the worker did not start.'));
      process.exitCode = 1;
    } else if (failedIDEs.length > 0) {
      p.outro(styleText('yellow', 'claude-mem installed, but setup failed for some agents.'));
    } else {
      p.outro(styleText('green', options.update ? 'claude-mem updated successfully!' : 'claude-mem installed successfully!'));
    }
  } else {
    console.log('\n  Next Steps');
    nextSteps.forEach(l => console.log(`  ${l}`));
    if (workerFailedToStart) {
      console.error('\nclaude-mem installed, but the worker did not start.');
      process.exitCode = 1;
    } else if (failedIDEs.length > 0) {
      console.log('\nclaude-mem installed, but setup failed for some agents.');
      process.exitCode = 1;
    } else {
      console.log(options.update ? '\nclaude-mem updated successfully!' : '\nclaude-mem installed successfully!');
    }
    if (shouldPrintAgentBrowserSetupHint({
      ci: Boolean(process.env.CI),
      alreadyInstalled,
      setupComplete,
      failedIdeCount: failedIDEs.length,
      providerSource: options.providerSource,
      runtime: selectedRuntime,
      noAutoStart: options.noAutoStart,
    })) {
      log.info(AGENT_BROWSER_SETUP_HINT);
    }
  }

  // After promptTelemetryOptIn so a just-made consent choice is honored.
  // ide/provider/runtime_mode/install_method are installer enums, the
  // *_version values are tool version strings — never user data.
  await captureInstallCompleted({
    ide: selectedIDEs.join(','),
    provider: selectedProvider,
    provider_source: options.providerSource ?? 'prompt',
    runtime_mode: selectedRuntime,
    is_update: alreadyInstalled,
    outcome: failedIDEs.length > 0 ? 'partial' : 'ok',
    duration_ms: Date.now() - installStartedAt,
    interactive: isInteractive,
    install_method: detectInstallMethod(),
    bun_version: installedBunVersion,
    uv_version: installedUvVersion,
    claude_code_version: detectClaudeCodeVersion(),
  });
}

/**
 * The install funnel's last event. An installer run the auto-updater started
 * sends none: it is not a person installing, and the supervisor's
 * auto_update_applied / auto_update_failed events report it
 * (shared/auto-update-install-run.ts).
 */
export async function captureInstallCompleted(properties: Record<string, unknown>): Promise<void> {
  if (isInstallRunByAutoUpdate()) return;
  await captureCliEvent('install_completed', properties, { person: true });
}

/**
 * The install funnel's event for an aborted install. Skipped for an installer
 * run the auto-updater started, as install_completed is: the supervisor's
 * auto_update_failed reports that run, with the stage it failed at
 * (shared/auto-update-install-run.ts).
 */
export async function captureInstallFailed(properties: Record<string, unknown>): Promise<void> {
  if (isInstallRunByAutoUpdate()) return;
  await captureCliEvent('install_failed', properties, { person: true });
}

async function runRepairCommandInner(summary: InstallSummary): Promise<void> {
  const version = readPluginVersion();
  const cacheDir = pluginCacheDirectory(version);
  const marketplaceDir = marketplaceDirectory();
  let bunVersion = 'unknown';
  let uvVersion = 'unknown';

  if (isInteractive) {
    p.intro(styleText(['bgCyan', 'black'], ' claude-mem repair '));
  } else {
    console.log('claude-mem repair');
  }
  log.info(`Version: ${styleText('cyan', version)}`);

  await runTasks([
    {
      title: 'Setting up runtime',
      task: async (message) => {
        message('Checking Bun…');
        const bun = await ensureBun(summary);
        bunVersion = bun.version;
        message('Checking uv…');
        const uv = await ensureUv(summary);
        uvVersion = uv.version;
        // Repair must regenerate the cache if it was wiped (e.g. user ran
        // `rm -rf ~/.claude/plugins/cache`). Without this, bun install would
        // fail immediately with no package.json to install against.
        if (!existsSync(join(cacheDir, 'package.json'))) {
          message('Cache missing — repopulating from npm package…');
          await copyPluginToCache(version);
        }
        applyInstalledSkillSelection(cacheDir);
        message('Reinstalling plugin dependencies…');
        const { bunPath } = bun;
        await installPluginDependencies(cacheDir, bunPath);
        message('Provisioning the tree-sitter CLI…');
        await provisionTreeSitterCli(cacheDir, ErrorSeverity.ABORT, summary);
        writeInstallMarker(cacheDir, version, bunVersion, uvVersion);
        message('Placing the claude-mem hook launcher on PATH…');
        const launcherStatus = placeHookLauncherOnPath(cacheDir, summary);
        return `Runtime ready (Bun ${bunVersion}, uv ${uvVersion}) ${styleText('green', 'OK')}\n  ${launcherStatus}`;
      },
    },
    {
      title: 'Repairing marketplace runtime',
      task: async (message) => {
        message('Repopulating marketplace root from npm package…');
        copyPluginToMarketplace();
        message('Reinstalling marketplace dependencies…');
        const stopHeartbeat = startHeartbeat(message, 'Running npm install…');
        try {
          await runNpmInstallInMarketplace(summary);
          writeMarketplaceInstallMarkers(marketplaceDir, version, bunVersion, uvVersion);
        } finally {
          stopHeartbeat();
        }
        return `Marketplace runtime ready ${styleText('green', 'OK')}`;
      },
    },
  ]);

  flushSummary(summary, (line) => (isInteractive ? p.log.message(line) : console.log(`  ${line}`)));

  if (isInteractive) {
    p.outro(styleText('green', 'claude-mem repair complete.'));
  } else {
    console.log('claude-mem repair complete.');
  }
}

export async function runRepairCommand(): Promise<void> {
  const summary = createInstallSummary();
  try {
    await runRepairCommandInner(summary);
    clearLastInstallError();
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (err instanceof InstallAbortError) {
      flushSummary(summary, (line) => (isInteractive ? p.log.message(line) : console.error(`  ${line}`)));
      const headline = `Repair Aborted: ${err.category.id}`;
      if (isInteractive) {
        p.log.error(headline);
        p.log.error(err.remediation);
        p.outro(styleText('red', 'claude-mem repair aborted.'));
      } else {
        console.error(`\n  ${headline}`);
        console.error(`  ${err.remediation}`);
        console.error(`  ${err.message}`);
      }
      process.exit(1);
    }
    throw error;
  }
}
