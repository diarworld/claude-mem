// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'bun:test';
import {
  buildAnthropicMaxLocalSettings,
} from '../../src/npx-cli/cmem-memory-credentials.js';

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
});
