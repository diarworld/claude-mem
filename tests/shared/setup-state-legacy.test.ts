import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hasExistingConfiguration, readSetupState } from '../../src/shared/setup-state.js';
import { parseSetupEvent } from '../../src/shared/setup-funnel.js';
import { isCmemGatewayUrl } from '../../src/shared/cmem-gateway.js';

// The local-only installer collapsed the funnel to the home branch (remove-cmem-auth-open plan, Task 5). Machines
// that upgrade with pending setup still carry state files written by older builds: a `branch: 'go'` choice, a
// `checkout` object, a standalone `cloudSyncOffer`. Reading them must never throw, and the dropped fields are
// ignored — the saved choice itself passes through so a resumed installer can finish the interrupted run.
const scratch = join(import.meta.dir, '..', '..', '.scratch', 'test-runs');
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(join(scratch, 'setup-state-legacy-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const writeLegacyState = (): string => {
  const path = join(dir, randomUUID(), 'setup-state.json');
  mkdirSync(join(path, '..'), { recursive: true });
  // Shaped exactly as an older build wrote it, fields this build dropped included.
  writeFileSync(path, JSON.stringify({
    status: 'pending',
    choice: {
      branch: 'go',
      memoryBilling: 'existing',
      cloudSyncOffer: 'cloud_sync_annual',
      shareWorkView: true,
      chosenAt: '2026-01-01T00:00:00.000Z',
    },
    installer: { stage: 'go-awaiting-checkout', error: null, updatedAt: '2026-01-01T00:00:00.000Z' },
    checkout: { state: 'requested', requests: 1, error: null, updatedAt: '2026-01-01T00:00:00.000Z' },
    tools: ['claude-code'],
    completedAt: null,
  }));
  return path;
};

describe('legacy setup state files', () => {
  it('read without throwing and keep the saved choice while dropping the checkout hand-off', () => {
    const state = readSetupState(writeLegacyState());
    expect(state.status).toBe('pending');
    expect(state.choice).not.toBeNull();
    expect((state.choice as { branch?: unknown }).branch).toBe('go');
    expect(state.installer?.stage).toBe('go-awaiting-checkout');
    expect(state.tools).toEqual(['claude-code']);
    // The checkout object is no longer part of the state file: it is neither read nor written back.
    expect((state as { checkout?: unknown }).checkout).toBeUndefined();
  });
  it('reject telemetry events that still carry the retired cloud_sync_offer key', () => {
    const event = {
      event: 'setup_step_action' as const, event_id: randomUUID(), setup_funnel_version: 2,
      setup_flow_id: randomUUID(), already_pro: false, visit_id: randomUUID(), step: 'choice' as const,
      action: 'choose_memory' as const, branch: 'home' as const, branch_confirmed: true, occurred_at: Date.now(),
    };
    expect(parseSetupEvent(event)).not.toBeNull();
    // The key left the closed schema with the hosted funnel: any event carrying it is rejected.
    expect(parseSetupEvent({ ...event, cloud_sync_offer: 'cloud_sync_monthly' })).toBeNull();
  });
});

describe('hasExistingConfiguration keeps any working openrouter observer or cloud sync', () => {
  it('accepts a non-empty base URL whatever endpoint it names, not only the cmem.ai gateway', () => {
    const gpuStack = {
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-local-1',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'http://gpustack.lan.local/v1',
    };
    expect(hasExistingConfiguration(gpuStack)).toBe(true);
    expect(isCmemGatewayUrl(gpuStack.CLAUDE_MEM_OPENROUTER_BASE_URL)).toBe(false);
  });
  it('still accepts the cmem.ai gateway tuple', () => {
    expect(hasExistingConfiguration({
      CLAUDE_MEM_PROVIDER: 'openrouter',
      CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-cmem-1',
      CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://api.cmem.ai/v1',
    })).toBe(true);
  });
  it('requires a key with the base URL, and all three cloud sync settings together', () => {
    expect(hasExistingConfiguration({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-1' })).toBe(false);
    expect(hasExistingConfiguration({ CLAUDE_MEM_PROVIDER: 'openrouter', CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://api.cmem.ai/v1' })).toBe(false);
    expect(hasExistingConfiguration({
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 't', CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'u', CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.cmem.ai',
    })).toBe(true);
    expect(hasExistingConfiguration({ CLAUDE_MEM_CLOUD_SYNC_TOKEN: 't', CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'u' })).toBe(false);
    expect(hasExistingConfiguration({})).toBe(false);
  });
});
