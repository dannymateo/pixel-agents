import { describe, expect, it } from 'vitest';

import { PtyHost } from '../src/terminals/ptyHost.js';
import type { PtyFactory, PtyProcess } from '../src/terminals/ptyTypes.js';
import { RingBuffer } from '../src/terminals/ringBuffer.js';

class FakePty implements PtyProcess {
  readonly pid = 4242;
  written: string[] = [];
  size = { cols: 0, rows: 0 };
  killed = false;
  private dataCbs: Array<(d: string) => void> = [];
  private exitCbs: Array<(e: { exitCode: number }) => void> = [];
  onData(cb: (d: string) => void) {
    this.dataCbs.push(cb);
    return { dispose: () => (this.dataCbs = this.dataCbs.filter((c) => c !== cb)) };
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb);
    return { dispose: () => (this.exitCbs = this.exitCbs.filter((c) => c !== cb)) };
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(cols: number, rows: number) {
    this.size = { cols, rows };
  }
  kill() {
    this.killed = true;
    this.emitExit(1);
  }
  emit(d: string) {
    for (const cb of this.dataCbs) cb(d);
  }
  emitExit(exitCode: number) {
    for (const cb of this.exitCbs) cb({ exitCode });
  }
}

function host(opts?: { maxTerminals?: number; bufferChars?: number }) {
  const ptys: FakePty[] = [];
  const spawned: Array<{ file: string; args: string[]; cwd: string }> = [];
  const factory: PtyFactory = (file, args, o) => {
    spawned.push({ file, args, cwd: o.cwd });
    const p = new FakePty();
    ptys.push(p);
    return p;
  };
  return { h: new PtyHost(factory, opts), ptys, spawned };
}

const SPEC = { file: 'claude', args: ['--session-id', 'x'], cwd: '/tmp/w', env: {} };

describe('RingBuffer', () => {
  it('keeps everything under the cap', () => {
    const b = new RingBuffer(100);
    b.append('a\n');
    b.append('b\n');
    expect(b.read()).toBe('a\nb\n');
  });

  it('past the cap drops the oldest text and restarts at a line boundary', () => {
    const b = new RingBuffer(10);
    b.append('\u001b[31mred line\n');
    b.append('ok\n');
    // Never starts mid-line (a cut escape sequence would garble xterm).
    expect(b.read()).toBe('ok\n');
    expect(b.read().length).toBeLessThanOrEqual(10);
  });

  it('a single line longer than the cap keeps only its tail', () => {
    const b = new RingBuffer(5);
    b.append('abcdefghij');
    expect(b.read()).toBe('fghij');
  });
});

describe('PtyHost', () => {
  it('opens a console in the requested cwd and buffers its output', () => {
    const { h, ptys, spawned } = host();
    const id = h.open(SPEC);
    expect(spawned[0]).toEqual({ file: 'claude', args: ['--session-id', 'x'], cwd: '/tmp/w' });
    ptys[0].emit('hola\n');
    expect(h.snapshot(id)).toEqual({ data: 'hola\n', exited: false });
  });

  it('forwards output and exit to listeners', () => {
    const { h, ptys } = host();
    const out: string[] = [];
    const exits: number[] = [];
    h.onOutput((_id, d) => out.push(d));
    h.onExit((_id, code) => exits.push(code));
    h.open(SPEC);
    ptys[0].emit('x');
    ptys[0].emitExit(0);
    expect(out).toEqual(['x']);
    expect(exits).toEqual([0]);
  });

  it('an exited console keeps its snapshot, marked exited, and refuses input', () => {
    const { h, ptys } = host();
    const id = h.open(SPEC);
    ptys[0].emit('bye\n');
    ptys[0].emitExit(0);
    expect(h.snapshot(id)).toEqual({ data: 'bye\n', exited: true });
    expect(h.write(id, 'x')).toBe(false);
  });

  it('writes and clamps resizes', () => {
    const { h, ptys } = host();
    const id = h.open(SPEC);
    expect(h.write(id, 'ls\r')).toBe(true);
    expect(ptys[0].written).toEqual(['ls\r']);
    expect(h.resize(id, 99999, 0)).toBe(true);
    expect(ptys[0].size).toEqual({ cols: 500, rows: 1 });
  });

  it('unknown ids are no-ops', () => {
    const { h } = host();
    expect(h.write('nope', 'x')).toBe(false);
    expect(h.resize('nope', 80, 24)).toBe(false);
    expect(h.close('nope')).toBe(false);
    expect(h.snapshot('nope')).toBeUndefined();
  });

  it('refuses to open past maxTerminals', () => {
    const { h } = host({ maxTerminals: 1 });
    h.open(SPEC);
    expect(() => h.open(SPEC)).toThrow(/too many/i);
  });

  it('close kills the process and forgets the console', () => {
    const { h, ptys } = host();
    const id = h.open(SPEC);
    expect(h.close(id)).toBe(true);
    expect(ptys[0].killed).toBe(true);
    expect(h.has(id)).toBe(false);
  });

  it('closeAll kills every live console (server shutdown leaves no orphans)', () => {
    const { h, ptys } = host();
    h.open(SPEC);
    h.open(SPEC);
    h.closeAll();
    expect(ptys.every((p) => p.killed)).toBe(true);
    expect(h.size).toBe(0);
  });
});
