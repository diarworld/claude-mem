import { describe, expect, it } from 'bun:test';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

// Plan Phase 8: the five-step bar, the bottom row's Back and the screens' own buttons and marks, rendered from the real
// components (no DOM needed). Lists of steps, screens and states come from their one definition (state-machines.md).
const compiled = buildSync({
  stdin: {
    resolveDir: resolve(import.meta.dir, '../../../src/ui/my-work'), loader: 'tsx', contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { SetupStepBar } from './src/setup/screens/step-bar';
      import { InstallScreen } from './src/setup/screens/install-screen';
      import { ScanScreen } from './src/setup/screens/scan-screen';
      import { RevealScreen } from './src/setup/screens/reveal-screen';
      import { ChoiceScreen } from './src/setup/screens/choice-screen';
      import { FinishSetupScreen } from './src/setup/screens/finish-setup-screen';
      import { LaunchScreen } from './src/setup/screens/launch-screen';
      import { WorkspaceScreen } from './src/setup/screens/workspace-screen';
      import { ToolMark } from './src/setup/screens/shared';
      import { SAMPLE_REQUESTS } from './src/data';
      import { SAMPLE_FOCUS_AREAS } from './src/data-goals';
      export { initialFlowState, SETUP_STEPS, SETUP_PROGRESS_STEPS, SETUP_PROGRESS_STATES, PROGRESS_STEP_WORDS, PROGRESS_STEP_OF_SCREEN, SCAN_PHASE_RUNNING } from './src/setup/setup-flow';
      export { SAMPLE_REQUESTS, SAMPLE_FOCUS_AREAS };
      export const renderBar = (step, flow) => renderToStaticMarkup(<SetupStepBar step={step} flow={flow} />);
      export const renderMark = (id, name) => renderToStaticMarkup(<ToolMark id={id} name={name} />);
      const noop = () => {};
      const scan = (phase) => ({ agents: [], percent: 40, phase, done: phase === 'done', error: phase === 'failed' ? 'Failed to fetch' : null, improveProduct: true, uploadedAgents: null });
      export const renderScan = (phase, { retrying = false, back = null } = {}) => renderToStaticMarkup(<ScanScreen scan={scan(phase)} back={back} onImproveProductChange={noop} onConfirmUpload={noop} preferenceError={null} onRetry={noop} retrying={retrying} retryError={null} onSkip={noop} onContinue={noop} />);
      export const renderReveal = (reveal) => renderToStaticMarkup(<RevealScreen agents={[]} reveal={reveal} extraction={{ state: 'ok', step: null }} uploadedAgents={['codex']} recentPrompts={[]} onContinue={noop} />);
      const install = { status: 'ready', error: null, selection: { agents: ['cursor'], skills: [], installClaudeCode: false, disableAutoMemory: false, telemetryEnabled: true },
        catalog: { agents: [{ id: 'cursor', label: 'Cursor', hint: '', detected: true }], skills: [], reinstall: false,
          defaults: { agents: ['cursor'], skills: [], installClaudeCode: false, disableAutoMemory: false, telemetryEnabled: true } } };
      const tool = { id: 'chatgpt', name: 'ChatGPT', kind: 'cloud' };
      export const renderScreens = (back, scanPhase = 'reading') => ({
        install: renderToStaticMarkup(<InstallScreen install={install} onInstall={async () => {}} onContinue={noop} />),
        scan: renderToStaticMarkup(<ScanScreen scan={scan(scanPhase)} back={back} onImproveProductChange={noop} onConfirmUpload={noop} preferenceError={null} onRetry={noop} retrying={false} retryError={null} onSkip={noop} onContinue={noop} />),
        reveal: renderToStaticMarkup(<RevealScreen agents={[]} reveal={{ goals: [], work: [], rules: [], focusAreas: SAMPLE_FOCUS_AREAS, requests: SAMPLE_REQUESTS }} extraction={{ state: 'ok', step: null }} uploadedAgents={['codex']} recentPrompts={[]} back={back} onContinue={noop} />),
        choice: renderToStaticMarkup(<ChoiceScreen branch="home" back={back} onChoose={noop} />),
        'finish-setup': renderToStaticMarkup(<FinishSetupScreen tools={[tool]} selected={['chatgpt']} onSelect={noop} back={back} onContinue={noop} />),
        launch: renderToStaticMarkup(<LaunchScreen tools={[tool]} back={back} onDone={noop} />),
        workspace: renderToStaticMarkup(<WorkspaceScreen suggestions={[]} back={back} search={async () => []} keepNote={async () => 1} forgetNote={async () => {}} onContinue={noop} />),
      });
    `,
  },
  tsconfig: resolve(import.meta.dir, '../../../src/ui/my-work/tsconfig.app.json'),
  bundle: true, write: false, format: 'cjs', platform: 'node',
  loader: { '.webp': 'dataurl', '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' },
}).outputFiles[0].text;

function fixture() {
  const module = { exports: {} as any };
  new Function('module', 'exports', 'require', compiled)(module, module.exports, createRequire(import.meta.url));
  return module.exports;
}

const app = fixture();
/** The bar's names, in its order, from the one definition. */
const NAMES: string[] = app.SETUP_PROGRESS_STEPS.map((step: string) => app.PROGRESS_STEP_WORDS[step]);
const STATES = new RegExp(`<li data-state="(${app.SETUP_PROGRESS_STATES.join('|')})"[^>]*>([\\s\\S]*?)<\\/li>`, 'g');
const items = (html: string) => [...html.matchAll(STATES)].map(([, state, body]) => ({ state, body }));
/** Every scan phase, from the one Record that says which of them run. */
const SCAN_PHASES = Object.keys(app.SCAN_PHASE_RUNNING);
/** Every screen's own buttons in the screen's navy look (`primary` anywhere in the class list). */
const navyButtons = (html: string) => html.match(/<button[^>]*class="[^"]*\bprimary\b[^"]*"[^>]*>/g) ?? [];

describe('setup step bar', () => {
  it('lists every step on each screen, with the screen\'s own step current', () => {
    for (const step of app.SETUP_STEPS) {
      const html = app.renderBar(step, app.initialFlowState(false));
      expect(html).toContain('aria-label="Setup progress"');
      const bar = items(html);
      expect(bar.map(item => item.body.match(/class="step-name">([^<]+)</)?.[1])).toEqual(NAMES);
      expect(html.match(/aria-current="step"/g)).toHaveLength(1);
      expect(bar.find(item => item.state === 'current')?.body).toContain(`>${app.PROGRESS_STEP_WORDS[app.PROGRESS_STEP_OF_SCREEN[step]]}<`);
    }
  });

  it('ticks a step only after the person has done it, and says so in words', () => {
    const start = app.initialFlowState(false);
    const installing = items(app.renderBar('install', { ...start, installationComplete: false }));
    expect(installing.map(item => item.state)).toEqual(['current', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
    expect(installing.some(item => item.body.includes('lucide-check'))).toBe(false);
    const planning = items(app.renderBar('savings', { ...start, scanComplete: true, revealContinued: true, choiceContinued: true }));
    expect(planning.map(item => item.state)).toEqual(['done', 'done', 'current', 'upcoming', 'upcoming']);
    for (const item of planning) {
      expect(item.body.includes('lucide-check')).toBe(item.state === 'done');
      expect(item.body.includes('<span class="sr-only"> (completed)</span>')).toBe(item.state === 'done');
    }
  });
});

describe('setup bottom row Back', () => {
  const back = { onBack: () => {}, waitsFor: null };
  const backButton = (html: string) => html.match(/<button[^>]*setup-back[^>]*>[\s\S]*?<\/button>/)?.[0] ?? null;

  it('is on every screen but the first, in one style, before the forward buttons', () => {
    const screens = app.renderScreens(back);
    for (const [step, html] of Object.entries(screens as Record<string, string>)) {
      const button = backButton(html);
      if (step === 'install') { expect(button, step).toBeNull(); continue; }
      expect(button, step).not.toBeNull();
      expect(button!, step).toContain('>Back</button>');
      expect(button!, step).toContain('text-action setup-back');
      expect(button!, step).not.toContain('aria-disabled="true"');
      // Back sits on the left of the row, so it comes before the row's forward buttons.
      expect(html.indexOf('setup-back'), step).toBeLessThan(html.indexOf('setup-actions-forward'));
    }
  });

  it('is left out where the page has no earlier screen to offer', () => {
    const screens = app.renderScreens(null);
    for (const step of Object.keys(screens)) expect(backButton(screens[step]), step).toBeNull();
  });

  it('waits, with its reason beside it, while the scan runs', () => {
    const scanning = app.renderScreens({ ...back, waitsFor: 'scan' }).scan;
    const button = backButton(scanning)!;
    expect(button).toContain('aria-disabled="true"');
    expect(button).toContain('aria-describedby="setup-waiting-line"');
    expect(scanning).toContain('<p id="setup-waiting-line" class="setup-waiting">Back waits while the scan runs.</p>');
  });

  it('keeps one navy button per screen', () => {
    for (const phase of SCAN_PHASES) {
      for (const [step, html] of Object.entries(app.renderScreens(back, phase) as Record<string, string>)) {
        expect(navyButtons(html).length, `${step} (${phase})`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('setup scan bottom row', () => {
  it('offers nothing to press forward while the scan runs: the page moves on by itself when it finishes', () => {
    const running = app.renderScan('reading', { back: { onBack: () => {}, waitsFor: 'scan' } });
    expect(navyButtons(running)).toEqual([]);
    expect(running).not.toContain('Continue');
    // The done state, seen only on the way Back from the Reveal, has its Continue.
    expect(navyButtons(app.renderScan('done')).join('')).toContain('primary');
    expect(app.renderScan('done')).toContain('Continue');
  });

  it('keeps the sharing choice open while the scan can use it, and read-only once the scan is done', () => {
    // The done scan shows only on the way Back from the Reveal; a change there would send a request after the scan.
    const box = (html: string) => html.match(/<label class="scan-improve-product">[\s\S]*?<\/label>/)?.[0] ?? '';
    for (const phase of SCAN_PHASES) {
      const label = box(app.renderScan(phase));
      expect(label, phase).toContain('type="checkbox"');
      expect(label.includes('disabled=""'), phase).toBe(phase === 'uploading' || phase === 'done');
    }
    expect(box(app.renderScan('done'))).toContain('The scan is done, and this choice was saved with it.');
    for (const phase of SCAN_PHASES) {
      // The upload offer is gone from the scan (local-only build): its cmem.ai note is gone with it.
      expect(box(app.renderScan(phase)), phase).not.toContain('Shared with cmem.ai');
    }
  });

  it('dims "Continue with new work" while "Try again" is starting the scan, and only then', () => {
    const skip = (html: string) => html.match(/<button[^>]*>Continue with new work<\/button>/)?.[0];
    const idle = skip(app.renderScan('failed'));
    const retrying = skip(app.renderScan('failed', { retrying: true }));
    expect(idle).toBeDefined();
    expect(retrying).toBeDefined();
    expect(idle).not.toContain('aria-disabled="true"');
    expect(retrying).toContain('aria-disabled="true"');
    expect(app.renderScan('failed', { retrying: true })).toContain('aria-busy="true"');
  });
});


describe('setup reveal rows', () => {
  const reveal = (requests = app.SAMPLE_REQUESTS) => app.renderReveal({ goals: [], work: [], rules: [], focusAreas: app.SAMPLE_FOCUS_AREAS, requests }) as string;

  it('keeps "Explore this focus" on each row as a quiet action, never a navy button', () => {
    const html = reveal();
    const rows = (html.match(/<li class="reveal-area">/g) ?? []).length;
    expect(rows).toBeGreaterThan(0);
    const explore = html.match(/<button[^>]*>Explore this focus[\s\S]*?<\/button>/g) ?? [];
    expect(explore).toHaveLength(rows);
    for (const button of explore) {
      expect(button).toContain('text-action');
      expect(button).not.toMatch(/class="[^"]*\bprimary\b/);
      // Its row's name is read with it, so each one says which area it opens.
      expect(button).toMatch(/aria-describedby="[^"]+"/);
    }
    expect(navyButtons(html)).toHaveLength(1);
  });

  it('makes "still being sorted" a link on the line with the others, closed until pressed', () => {
    // A request with no recorded area is still being sorted.
    const unsorted = { ...app.SAMPLE_REQUESTS[0], id: 'unsorted-request', focusAreaId: undefined, closed: false };
    const html = reveal([...app.SAMPLE_REQUESTS, unsorted]);
    const links = html.match(/<div class="reveal-links">[\s\S]*?<\/div>/)?.[0] ?? '';
    const sorting = links.match(/<button[^>]*reveal-sorting[^>]*>[\s\S]*?<\/button>/)?.[0];
    expect(sorting).toBeDefined();
    expect(sorting).toMatch(/\d+ still being sorted/);
    expect(sorting).toContain('text-action');
    expect(sorting).toContain('aria-expanded="false"');
    expect(html).not.toContain('reveal-sorting-list');
  });
});

describe('setup tool marks', () => {
  // Marks for the tools a setup screen can list together: the scan's readers, the installer's catalog and Finish
  // Setup's cloud readers (labels from src/services/prompt-import/readers.ts, src/npx-cli/commands/ide-detection.ts
  // and SETUP_TOOLS). A tool named two ways keeps one mark.
  const TOOLS: Array<[string, string]> = [
    ['claude-code', 'Claude Code'], ['claude-ai', 'Claude.ai'], ['codex', 'Codex'], ['codex-cli', 'Codex CLI'], ['chatgpt', 'ChatGPT'],
    ['gemini-cli', 'Gemini CLI'], ['antigravity-cli', 'Antigravity CLI'], ['antigravity', 'Antigravity'], ['opencode', 'OpenCode'],
    ['openclaw', 'OpenClaw'], ['windsurf', 'Windsurf'], ['t3code', 'T3 Code'], ['kimi', 'Kimi Code'], ['devin', 'Devin CLI / Desktop'],
    ['cursor', 'Cursor'], ['grok-bot', 'Grok Bot'], ['copilot-cli', 'Copilot CLI'], ['copilot-vscode', 'Copilot in VS Code'], ['omp', 'OMP'], ['hermes', 'Hermes Agent'], ['pi', 'Pi'],
    ['dsh', 'DeepSeek Harness'], ['goose', 'Goose'], ['roo-code', 'Roo Code'], ['warp', 'Warp'], ['zed', 'Zed'],
  ];
  const SAME_TOOL = [['codex', 'codex-cli'], ['antigravity', 'antigravity-cli']];
  const mark = (id: string, name: string) => app.renderMark(id, name).replace(/data:[^"]+/, (uri: string) => `image:${uri.length}:${uri.slice(-24)}`);

  it('gives Claude Code and Codex marks of their own: no two tools share a logo', () => {
    expect(mark('claude-code', 'Claude Code')).not.toEqual(mark('claude-ai', 'Claude.ai'));
    expect(mark('codex', 'Codex')).not.toEqual(mark('chatgpt', 'ChatGPT'));
    expect(mark('claude-code', 'Claude Code')).toContain('is-letters');
    expect(mark('codex-cli', 'Codex CLI')).toContain('is-letters');
    expect(mark('claude-ai', 'Claude.ai')).toContain('<img');
    expect(mark('chatgpt', 'ChatGPT')).toContain('<img');
  });

  it('never draws the same mark for two different tools', () => {
    const seen = new Map<string, string>();
    for (const [id, name] of TOOLS) {
      const drawn = mark(id, name);
      const same = SAME_TOOL.find(pair => pair.includes(id));
      const earlier = seen.get(drawn);
      if (earlier) expect(same?.includes(earlier), `${name} and ${earlier} share ${drawn}`).toBe(true);
      seen.set(drawn, id);
    }
  });
});

