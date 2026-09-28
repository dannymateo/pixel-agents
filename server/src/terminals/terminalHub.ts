import { TERMINAL_OUTPUT_FLUSH_MS } from '../constants.js';
import type { PtyHost } from './ptyHost.js';

type Send = (m: Record<string, unknown>) => void;

interface Sub {
  send: Send;
  pending: string;
  scheduled: boolean;
}

/**
 * Who receives which office console (spec §2). Point-to-point like the agent
 * screen feed: a console's output is code and command output, so it only ever
 * reaches the privileged connections that attached to it — never a broadcast.
 * Output is coalesced per connection (TERMINAL_OUTPUT_FLUSH_MS).
 */
export class TerminalHub {
  /** terminalId → connId → subscription */
  private readonly subs = new Map<string, Map<string, Sub>>();
  private readonly offOutput: () => void;
  private readonly offExit: () => void;

  constructor(
    private readonly host: PtyHost,
    private readonly schedule: (fn: () => void, ms: number) => unknown = (fn, ms) =>
      setTimeout(fn, ms),
  ) {
    this.offOutput = host.onOutput((id, data) => {
      for (const [, sub] of this.subs.get(id) ?? []) {
        sub.pending += data;
        if (!sub.scheduled) {
          sub.scheduled = true;
          this.schedule(() => this.flush(id, sub), TERMINAL_OUTPUT_FLUSH_MS);
        }
      }
    });
    this.offExit = host.onExit((id, exitCode) => {
      for (const [, sub] of this.subs.get(id) ?? []) {
        this.schedule(() => {
          this.flush(id, sub);
          sub.send({ type: 'terminalExit', terminalId: id, exitCode });
        }, TERMINAL_OUTPUT_FLUSH_MS);
      }
    });
  }

  private flush(id: string, sub: Sub): void {
    sub.scheduled = false;
    if (!sub.pending) return;
    const data = sub.pending;
    sub.pending = '';
    sub.send({ type: 'terminalOutput', terminalId: id, data });
  }

  attach(connId: string, terminalId: string, send: Send): boolean {
    const snap = this.host.snapshot(terminalId);
    if (!snap) return false;
    let conns = this.subs.get(terminalId);
    if (!conns) {
      conns = new Map();
      this.subs.set(terminalId, conns);
    }
    conns.set(connId, { send, pending: '', scheduled: false });
    send({ type: 'terminalSnapshot', terminalId, data: snap.data, exited: snap.exited });
    return true;
  }

  isAttached(connId: string, terminalId: string): boolean {
    return this.subs.get(terminalId)?.has(connId) === true;
  }

  detach(connId: string, terminalId: string): void {
    this.subs.get(terminalId)?.delete(connId);
  }

  dropConnection(connId: string): void {
    for (const conns of this.subs.values()) conns.delete(connId);
  }

  dispose(): void {
    this.offOutput();
    this.offExit();
    this.subs.clear();
  }
}
