import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveInstallerProviderChoice } from '../../src/npx-cli/installer-provider-choice';

const repoRoot = join(__dirname, '..', '..');

describe('grok-bot install default provider', () => {
  it('defaults --ide grok-bot with no --provider to the internal model gateway (openrouter transport)', () => {
    expect(resolveInstallerProviderChoice({ ide: 'grok-bot' })).toBe('openrouter');
  });

  it('keeps --provider host as an explicit grok-bot opt-in', () => {
    expect(resolveInstallerProviderChoice({ ide: 'grok-bot', provider: 'host' })).toBe('host');
  });

  it('does not invent a non-interactive default for other IDEs', () => {
    expect(resolveInstallerProviderChoice({ ide: 'cursor' })).toBeUndefined();
    expect(resolveInstallerProviderChoice({ ide: 'claude-code' })).toBeUndefined();
    expect(resolveInstallerProviderChoice({})).toBeUndefined();
  });

  it('documents the internal gateway as the grok-bot plugin default and host as opt-in', () => {
    const skill = readFileSync(join(repoRoot, 'claude-mem-grok-bot/skills/install/SKILL.md'), 'utf-8');
    const readme = readFileSync(join(repoRoot, 'claude-mem-grok-bot/README.md'), 'utf-8');
    const defaultSection = skill.split('## Optional')[0];

    expect(defaultSection).toContain('npx claude-mem install --ide grok-bot');
    expect(defaultSection).not.toContain('npx claude-mem install --ide grok-bot --provider host');
    // The default observer is the internal model gateway, never the cmem.ai one.
    expect(defaultSection).toContain('https://gpustack.data.lmru.tech/v1');
    expect(defaultSection).toContain('glm-5.3-flash');
    expect(defaultSection).not.toContain('cmem.ai');
    expect(skill).toContain('npx claude-mem install --ide grok-bot --provider host');
    expect(readme).toContain('npx claude-mem install --ide grok-bot');
    expect(readme).not.toContain('npx claude-mem install --ide grok-bot --provider host');
    expect(readme).toContain('GPUStack');
  });
});
