import { describe, expect, it } from 'vitest';

import { PtyHost } from '../src/terminals/ptyHost.js';
import type { PtyFactory, PtyProcess } from '../src/terminals/ptyTypes.js';
import { TerminalHub } from '../src/terminals/terminalHub.js';

class FakePty implements PtyProcess {
  readonly pid = 1;
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;
  onData(cb: (d: string) => void) {
    this.dataCb = cb;
    return { dispose() {} };
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb;
    return { dispose() {} };
  }
  write() {}
  resize() {}
  kill() {}
  emit(d: string) {
    this.dataCb?.(d);
  }
  exit(c: number) {
    this.exitCb?.({ exitCode: c });
  }
}

function setup() {
  const ptys: FakePty[] = [];
  const factory: PtyFactory = () => {
    const p = new FakePty();
    ptys.push(p);
    return p;
  };
  const host = new PtyHost(factory);
  const queued: Array<() => void> = [];
  const hub = new TerminalHub(host, (fn) => queued.push(fn));
  const flush = () => queued.splice(0).forEach((fn) => fn());
  const id = host.open({ file: 'claude', args: [], cwd: '/w', env: {} });
  return { host, hub, ptys, id, flush };
}

describe('TerminalHub', () => {
  it('attach sends the snapshot, then coalesced live output to that connection only', () => {
    const { hub, ptys, id, flush } = setup();
    ptys[0].emit('antes\n');
    const a: Array<Record<string, unknown>> = [];
    const b: Array<Record<string, unknown>> = [];
    expect(hub.attach('c1', id, (m) => a.push(m))).toBe(true);
    expect(a).toEqual([
      { type: 'terminalSnapshot', terminalId: id, data: 'antes\n', exited: false },
    ]);
    ptys[0].emit('uno');
    ptys[0].emit('dos');
    flush();
    expect(a[1]).toEqual({ type: 'terminalOutput', terminalId: id, data: 'unodos' });
    expect(a).toHaveLength(2);
    expect(b).toEqual([]);
  });

  it('attach to an unknown console is refused', () => {
    const { hub } = setup();
    expect(hub.attach('c1', 'nope', () => {})).toBe(false);
  });

  it('exit is delivered after pending output', () => {
    const { hub, ptys, id, flush } = setup();
    const a: Array<Record<string, unknown>> = [];
    hub.attach('c1', id, (m) => a.push(m));
    ptys[0].emit('fin');
    ptys[0].exit(3);
    flush();
    expect(a.slice(1)).toEqual([
      { type: 'terminalOutput', terminalId: id, data: 'fin' },
      { type: 'terminalExit', terminalId: id, exitCode: 3 },
    ]);
  });

  it('detach and dropConnection stop delivery', () => {
    const { hub, ptys, id, flush } = setup();
    const a: Array<Record<string, unknown>> = [];
    hub.attach('c1', id, (m) => a.push(m));
    hub.detach('c1', id);
    expect(hub.isAttached('c1', id)).toBe(false);
    ptys[0].emit('x');
    flush();
    expect(a).toHaveLength(1);
    hub.attach('c1', id, (m) => a.push(m));
    hub.dropConnection('c1');
    ptys[0].emit('y');
    flush();
    expect(a).toHaveLength(2);
  });
});
