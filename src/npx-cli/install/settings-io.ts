/**
 * Installer settings writes. mergeSettings moved verbatim out of
 * install/pairing.ts: it is the generic settings-merge boundary the whole
 * terminal flow shares, not something owned by the pairing client.
 */

import { log } from './cli-io.js';
import { USER_SETTINGS_PATH } from '../../shared/paths.js';
import { updateSettingsDocument } from '../../shared/settings-document.js';

/**
 * Merge installer settings into settings.json through the shared settings
 * document boundary. The whole document is kept (a Claude-Code-style `env`
 * wrapper and its root peers survive). An unreadable file is no longer reset
 * to `{}`: it is moved aside to `settings.json.corrupt-<epoch-ms>` (the user's
 * bytes are kept) and a fresh document is written, so a corrupt file can never
 * stop setup or drop the sign-in's memory key. Returns false only when the
 * write itself fails; the worker and hooks refuse-and-report instead. The
 * boundary writes settings.json owner-only from the first byte (it can carry
 * the CMEM Pro setup token and provider API keys).
 */
export function mergeSettings(
  updates: Record<string, string>,
  settingsPath: string = USER_SETTINGS_PATH,
  mutate?: (target: Record<string, unknown>) => void,
): boolean {
  const result = updateSettingsDocument(settingsPath, updates, {}, mutate, { quarantineCorrupt: true });
  if (result.status === 'refused') {
    const reason = result.error instanceof Error ? result.error.message : String(result.error);
    // A quarantined file is moved back when the fresh write fails; quarantinedTo
    // survives only if even that move failed, so say where the bytes are.
    log.error(result.quarantinedTo
      ? `Failed to write settings to ${settingsPath}: ${reason}. Its unreadable previous contents are in ${result.quarantinedTo}.`
      : `Failed to write settings to ${settingsPath}: ${reason}`);
    return false;
  }
  if (result.quarantinedTo) {
    log.warn(`${settingsPath} could not be read, so it was moved to ${result.quarantinedTo} and a fresh settings file was started. Copy back any settings you still need from it.`);
  }
  return true;
}
