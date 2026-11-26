/**
 * Terminal I/O primitives shared by the installer's modules: the TTY check and
 * the interactive-aware log wrapper. They moved verbatim out of
 * install/pairing.ts so any install module can print through the same
 * contract without depending on the pairing client.
 */

import * as p from '@clack/prompts';

export const isInteractive = process.stdin.isTTY === true;

export const log = {
  info: (msg: string) => isInteractive ? p.log.info(msg) : console.log(`  ${msg}`),
  success: (msg: string) => isInteractive ? p.log.success(msg) : console.log(`  ${msg}`),
  warn: (msg: string) => isInteractive ? p.log.warn(msg) : console.warn(`  ${msg}`),
  error: (msg: string) => isInteractive ? p.log.error(msg) : console.error(`  ${msg}`),
};
