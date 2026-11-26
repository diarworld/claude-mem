// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  buildAnthropicMaxLocalSettings,
  buildNonInteractiveOpenRouterSettings,
  buildPersonalOpenRouterSettings,
} from '../../src/npx-cli/cmem-memory-credentials.js';
import { CMEM_PRO_BASE_URL, CMEM_PRO_MODEL } from '../../src/npx-cli/install/pairing.js';

const configuredCmemSettings = {
  CLAUDE_MEM_OPENROUTER_API_KEY: 'cm_pro_configured',
  CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai/api/inference/v1',
  CLAUDE_MEM_OPENROUTER_MODEL: 'configured-observer',
};

describe('cmem memory credential retention', () => {
  describe('buildAnthropicMaxLocalSettings', () => {
    it('turns off old cloud sync and removes CMEM credentials on a local switch', () => {
      expect(buildAnthropicMaxLocalSettings({
        ...configuredCmemSettings,
        CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'sync-secret',
        CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'user-id',
        CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://sync.cmem.ai',
        CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'device-id',
        CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'old-device',
        CLAUDE_MEM_PRO_MEMORY_KEY: 'cm_pro_staged',
        CLAUDE_MEM_PRO_MEMORY_BASE_URL: 'https://cmem.ai/api/inference/v1',
        CLAUDE_MEM_PRO_MEMORY_MODEL: 'cmem-observer',
      })).toEqual({
        CLAUDE_MEM_PROVIDER: 'claude',
        CLAUDE_MEM_CLAUDE_AUTH_METHOD: 'subscription',
        CLAUDE_MEM_CLOUD_SYNC_TOKEN: '',
        CLAUDE_MEM_CLOUD_SYNC_USER_ID: '',
        CLAUDE_MEM_CLOUD_SYNC_HUB_URL: '',
        CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: '',
        CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: '',
        CLAUDE_MEM_PRO_MEMORY_KEY: '',
        CLAUDE_MEM_PRO_MEMORY_BASE_URL: '',
        CLAUDE_MEM_PRO_MEMORY_MODEL: '',
        CLAUDE_MEM_OPENROUTER_API_KEY: '',
        CLAUDE_MEM_OPENROUTER_BASE_URL: '',
        CLAUDE_MEM_OPENROUTER_MODEL: '',
      });
    });

    it('does not erase an unrelated personal OpenRouter key', () => {
      const updates = buildAnthropicMaxLocalSettings({
        CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-personal',
        CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
        CLAUDE_MEM_OPENROUTER_MODEL: 'personal-model',
      });

      expect(updates).not.toHaveProperty('CLAUDE_MEM_OPENROUTER_API_KEY');
      expect(updates).not.toHaveProperty('CLAUDE_MEM_OPENROUTER_BASE_URL');
      expect(updates).not.toHaveProperty('CLAUDE_MEM_OPENROUTER_MODEL');
      expect(updates.CLAUDE_MEM_CLOUD_SYNC_TOKEN).toBe('');
    });
  });

  describe('buildPersonalOpenRouterSettings', () => {
    it('resets the CMEM endpoint/model and moves the only CMEM key into staging', () => {
      const updates = buildPersonalOpenRouterSettings(
        '  sk-or-personal  ',
        configuredCmemSettings,
        'openrouter/default-model',
      );

      expect(updates).toEqual({
        CLAUDE_MEM_PROVIDER: 'openrouter',
        CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-personal',
        CLAUDE_MEM_OPENROUTER_BASE_URL: '',
        CLAUDE_MEM_OPENROUTER_MODEL: 'openrouter/default-model',
        CLAUDE_MEM_PRO_MEMORY_KEY: 'cm_pro_configured',
        CLAUDE_MEM_PRO_MEMORY_BASE_URL: 'https://cmem.ai/api/inference/v1',
        CLAUDE_MEM_PRO_MEMORY_MODEL: 'configured-observer',
      });
      expect(Object.values(updates).filter(value => value === 'cm_pro_configured')).toHaveLength(1);
      expect(Object.values(updates).filter(value => value === 'sk-or-personal')).toHaveLength(1);
    });

    it('retains a newer staged one-shot key instead of replacing it with the active CMEM key', () => {
      const updates = buildPersonalOpenRouterSettings(
        'sk-or-personal',
        {
          ...configuredCmemSettings,
          CLAUDE_MEM_PRO_MEMORY_KEY: 'cm_pro_one_shot',
          CLAUDE_MEM_PRO_MEMORY_BASE_URL: 'https://cmem.ai/new/v1',
          CLAUDE_MEM_PRO_MEMORY_MODEL: 'new-observer',
        },
        'openrouter/default-model',
      );

      expect(updates.CLAUDE_MEM_OPENROUTER_API_KEY).toBe('sk-or-personal');
      expect(updates.CLAUDE_MEM_OPENROUTER_BASE_URL).toBe('');
      expect(updates.CLAUDE_MEM_OPENROUTER_MODEL).toBe('openrouter/default-model');
      expect(updates.CLAUDE_MEM_PRO_MEMORY_KEY).toBe('cm_pro_one_shot');
      expect(updates.CLAUDE_MEM_PRO_MEMORY_BASE_URL).toBe('https://cmem.ai/new/v1');
      expect(updates.CLAUDE_MEM_PRO_MEMORY_MODEL).toBe('new-observer');
      expect(Object.values(updates).filter(value => value === 'cm_pro_one_shot')).toHaveLength(1);
      expect(Object.values(updates)).not.toContain('cm_pro_configured');
    });

    it('does not stage a personal key from a deceptive CMEM-looking endpoint', () => {
      const updates = buildPersonalOpenRouterSettings(
        'sk-or-replacement',
        {
          CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-existing',
          CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://cmem.ai.evil.example/api/inference/v1',
          CLAUDE_MEM_OPENROUTER_MODEL: 'evil-model',
        },
        'openrouter/default-model',
      );

      expect(updates.CLAUDE_MEM_OPENROUTER_BASE_URL).toBe('');
      expect(updates.CLAUDE_MEM_OPENROUTER_MODEL).toBe('openrouter/default-model');
      expect(updates.CLAUDE_MEM_PRO_MEMORY_KEY).toBe('');
      expect(updates.CLAUDE_MEM_PRO_MEMORY_BASE_URL).toBe('');
      expect(updates.CLAUDE_MEM_PRO_MEMORY_MODEL).toBe('');
    });
  });

  describe('buildNonInteractiveOpenRouterSettings', () => {
    it('stages an active CMEM key and resets its endpoint before a personal env key can be used', () => {
      const updates = buildNonInteractiveOpenRouterSettings(
        configuredCmemSettings,
        'openrouter/default-model',
      );

      expect(updates).toEqual({
        CLAUDE_MEM_PROVIDER: 'openrouter',
        CLAUDE_MEM_OPENROUTER_API_KEY: '',
        CLAUDE_MEM_OPENROUTER_BASE_URL: '',
        CLAUDE_MEM_OPENROUTER_MODEL: 'openrouter/default-model',
        CLAUDE_MEM_PRO_MEMORY_KEY: 'cm_pro_configured',
        CLAUDE_MEM_PRO_MEMORY_BASE_URL: 'https://cmem.ai/api/inference/v1',
        CLAUDE_MEM_PRO_MEMORY_MODEL: 'configured-observer',
      });
    });

    it('leaves personal and custom OpenRouter configuration untouched', () => {
      expect(buildNonInteractiveOpenRouterSettings({
        CLAUDE_MEM_OPENROUTER_API_KEY: 'sk-or-existing',
        CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://openrouter.ai/api/v1',
        CLAUDE_MEM_OPENROUTER_MODEL: 'existing-model',
      }, 'openrouter/default-model')).toEqual({
        CLAUDE_MEM_PROVIDER: 'openrouter',
      });
    });
  });
});
