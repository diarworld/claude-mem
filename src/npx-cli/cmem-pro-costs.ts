/**
 * Provider-choice copy shared by the installer and its contract tests. Keep
 * this file static: the provider screen must render even before the worker is
 * running and must not depend on a pricing API. The OAuth pairing endpoints
 * and the CMEM Pro inference settings live in install/pairing.ts.
 */

import { PRO_TRIAL_LABEL } from '../shared/pro-promo.js';

export const PROVIDER_PROMPT_MESSAGE =
  'Select Provider:\n================';

export interface ProviderLabels {
  cmem: string;
  cmemHint: string;
  claude: string;
  claudeHint: string;
}

/**
 * The description rides in the LABEL, not in clack's `hint`.
 *
 * clack's multiselect renders a hint only for the focused, selected, or
 * disabled row — a plain unselected row renders label only. Since this prompt
 * opens with nothing selected, hints would reveal one description at a time as
 * the user arrows around, instead of showing both choices side by side. The
 * parentheses are ours for the same reason: clack adds its own `(...)` around a
 * hint, but never around a label.
 */
export function buildProviderLabels(): ProviderLabels {
  return {
    cmem: `CMEM Pro (${PRO_TRIAL_LABEL}: Tokens for Observations + Real-Time Cloud Sync `
      + 'for Claude.ai, ChatGPT.com, anything that accepts an MCP Connector)',
    cmemHint: '',
    claude: 'Use your Anthropic Max Plan (no cloud sync, uses tokens for observations)',
    claudeHint: '',
  };
}
