/**
 * Best-effort browser hand-off helpers shared by the pairing flows: open a
 * URL in the user's browser, and hold the terminal until the user is back and
 * presses Return so the opener fires at the right moment. Both live apart
 * from the pairing client so any terminal flow can hand off to the browser
 * without taking on the pairing state.
 */

import { spawnSync } from 'child_process';
import { isInteractive, log } from './pairing.js';

/**
 * Best-effort "open this URL in the user's browser". Every failure mode is
 * non-fatal — the caller has already printed the URL, so the worst case is the
 * user clicks it themselves.
 */
export function openBrowser(url: string): void {
  try {
    if (process.platform === 'darwin') {
      spawnSync('open', [url], { stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
    } else {
      spawnSync('xdg-open', [url], { stdio: 'ignore' });
    }
  } catch {
    // [ANTI-PATTERN IGNORED]: opening a browser is a convenience, not a step of the
    // install; the recovery is the URL already printed above this call, which the
    // user can open by hand. A headless box legitimately has no opener at all.
  }
}

/**
 * Holds until the user presses Return, then the caller opens the browser. The
 * URL is printed BEFORE this, so a user who cannot use an opener (headless box,
 * SSH) is never blocked — they can open it by hand and the wait still clears on
 * Return. Ctrl-C falls through to the normal SIGINT handling.
 *
 * Raw mode mirrors waitForInstallerPairing: only toggled when this call turned
 * it on, and always restored.
 */
export async function waitForReturnToOpenBrowser(message: string): Promise<void> {
  if (!isInteractive || process.stdin.isTTY !== true) return;
  log.info(message);
  await new Promise<void>((resolve) => {
    const wasRaw = process.stdin.isRaw === true;
    let changedRawMode = false;
    const finish = (): void => {
      process.stdin.off('data', onData);
      if (changedRawMode) process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text.includes('\r') || text.includes('\n') || text.includes('\x03')) finish();
    };
    if (!wasRaw) {
      process.stdin.setRawMode(true);
      changedRawMode = true;
    }
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}
