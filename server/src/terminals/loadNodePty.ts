import type { PtyFactory } from './ptyTypes.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Office consoles only on a loopback bind: exposed to a network, a console is
 *  a remote shell for whoever holds the token (spec §1, security). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

/** node-pty is optional at runtime: a platform without its prebuilt binary
 *  still gets the office, just without consoles. */
export function loadNodePty(): PtyFactory | null {
  try {
    // The CLI bundle is CJS (esbuild format 'cjs', no "type": "module"), and
    // node-pty is an external resolved at runtime — a plain require.
    const pty = require('node-pty') as typeof import('node-pty');
    return (file, args, opts) =>
      pty.spawn(file, args, {
        name: 'xterm-256color',
        cwd: opts.cwd,
        cols: opts.cols,
        rows: opts.rows,
        env: opts.env,
      });
  } catch (err) {
    console.warn(
      `[Pixel Agents] Office consoles unavailable: node-pty did not load (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}
