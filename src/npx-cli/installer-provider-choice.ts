type InstallerProviderId = 'claude' | 'gemini' | 'openrouter' | 'host';

/**
 * Implicit provider when `--provider` is omitted.
 * Grok Bot's user-facing default is the internal model gateway (openrouter
 * transport; a fresh install fills the empty provider keys with the GPUStack
 * endpoint/model defaults — see applyGpustackDefaults in commands/install.ts).
 * `--provider host` stays an explicit loopback-shim opt-in. Other IDEs have no
 * non-interactive implicit provider.
 *
 * Applied at the CLI boundary in `src/npx-cli/index.ts` for non-TTY
 * `install --ide grok-bot`. There is no installer OAuth: a non-interactive
 * run without a held gateway key aborts with the env-var remediation.
 */
export function resolveInstallerProviderChoice(
  options: { ide?: string; provider?: InstallerProviderId },
): InstallerProviderId | undefined {
  if (options.provider) return options.provider;
  if (options.ide === 'grok-bot') return 'openrouter';
  return undefined;
}
