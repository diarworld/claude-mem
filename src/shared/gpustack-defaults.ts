/**
 * GPUStack fresh-install defaults: the internal model gateway a fresh install
 * runs memory on. Shared by the terminal installer (install.ts) and the setup
 * page's integrations step (services/work-view/setup-integrations.ts), which
 * must fill the same keys the same way — one definition here.
 *
 * Written only into keys still empty or still holding the shipped default — a
 * value this machine chose, an exported environment value and the gateway key
 * are never touched: the key is never hardcoded, only asked for or read
 * (CLAUDE_MEM_OPENROUTER_API_KEY).
 */
export const GPUSTACK_DEFAULT_BASE_URL = 'https://gpustack.data.lmru.tech/v1';
export const GPUSTACK_DEFAULT_MODEL = 'glm-5.3-flash';

/** The provider keys the GPUStack defaults fill, with their values. */
export const GPUSTACK_DEFAULTS: Record<string, string> = {
  CLAUDE_MEM_PROVIDER: 'openrouter',
  CLAUDE_MEM_OPENROUTER_BASE_URL: GPUSTACK_DEFAULT_BASE_URL,
  CLAUDE_MEM_OPENROUTER_MODEL: GPUSTACK_DEFAULT_MODEL,
};

/**
 * The GPUStack keys a submitted configuration may write, computed against the
 * persisted settings: a value differing from the shipped default was chosen on
 * this machine and is never overwritten, an exported environment value always
 * wins and is never copied to disk, and the gateway key is never one of the
 * returned keys.
 *
 * Returns `null` when nothing may be written (the caller then writes only the
 * key). The `~/.claude-mem/.env` leg of the usual key lookups is absent on
 * purpose: that file holds only unprefixed credential names, so none of these
 * keys can ever be set there and checking it would be dead code.
 */
export function gpustackDefaultUpdates(
  persisted: object,
  shipped: object,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | null {
  const current = persisted as Record<string, unknown>;
  const shippedMap = shipped as Record<string, unknown>;
  const updates: Record<string, string> = {};
  for (const [name, value] of Object.entries(GPUSTACK_DEFAULTS)) {
    // An environment value wins without being copied to disk.
    if (env[name]) continue;
    const held = current[name];
    const atShippedDefault = typeof held === 'string'
      && held.trim() === String(shippedMap[name] ?? '').trim();
    // Empty, or still the shipped default the settings seeder wrote: writable.
    if (typeof held === 'string' && held.trim() !== '' && !atShippedDefault) continue;
    updates[name] = value;
  }
  return Object.keys(updates).length === 0 ? null : updates;
}
