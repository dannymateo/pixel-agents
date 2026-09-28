import { TERMINAL_OUTPUT_FLUSH_MS } from '../constants.js';
import type { PtyHost } from './ptyHost.js';

type Send = (m: Record<string, unknown>) => void;

interface Sub {
  send: Send;
  pending: string;
  scheduled: boolean;
  /** Set once this subscription is detached, dropped, or superseded by a
   *  re-attach of the same connId — a flush or exit already scheduled for it
   *  must then deliver nothing (React StrictMode's attach→detach→attach can
   *  otherwise double-deliver output already folded into the new snapshot). */
  dead: boolean;
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
      const conns = this.subs.get(id);
      for (const [, sub] of conns ?? []) {
        this.schedule(() => {
          if (sub.dead) return;
          this.flush(id, sub);
          sub.send({ type: 'terminalExit', terminalId: id, exitCode });
        }, TERMINAL_OUTPUT_FLUSH_MS);
      }
      // Nothing further can attach to an exited console's dead subs -- the
      // scheduled callbacks above hold their own `sub` reference, so removing
      // the map entry now (rather than waiting for them to run) is safe and
      // caps memory at one exited console instead of retaining it forever.
      this.subs.delete(id);
    });
  }

  private flush(id: string, sub: Sub): void {
    sub.scheduled = false;
    if (sub.dead || !sub.pending) return;
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
    // A re-attach of the same connId (React StrictMode's double-mount) must
    // not let a flush or exit already scheduled for the PREVIOUS subscription
    // deliver again -- the new snapshot below already carries that output.
    const previous = conns.get(connId);
    if (previous) previous.dead = true;
    conns.set(connId, { send, pending: '', scheduled: false, dead: false });
    send({ type: 'terminalSnapshot', terminalId, data: snap.data, exited: snap.exited });
    return true;
  }

  isAttached(connId: string, terminalId: string): boolean {
    return this.subs.get(terminalId)?.has(connId) === true;
  }

  detach(connId: string, terminalId: string): void {
    const conns = this.subs.get(terminalId);
    const sub = conns?.get(connId);
    if (!sub) return;
    sub.dead = true;
    conns?.delete(connId);
    if (conns && conns.size === 0) this.subs.delete(terminalId);
  }

  dropConnection(connId: string): void {
    for (const [terminalId, conns] of this.subs) {
      const sub = conns.get(connId);
      if (!sub) continue;
      sub.dead = true;
      conns.delete(connId);
      if (conns.size === 0) this.subs.delete(terminalId);
    }
  }

  dispose(): void {
    this.offOutput();
    this.offExit();
    this.subs.clear();
  }
}
