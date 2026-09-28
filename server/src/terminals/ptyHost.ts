import * as crypto from 'crypto';

import {
  MAX_OFFICE_TERMINALS,
  TERMINAL_BUFFER_CHARS,
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
} from '../constants.js';
import type { PtyFactory, PtyProcess } from './ptyTypes.js';
import { RingBuffer } from './ringBuffer.js';

interface Console {
  pty: PtyProcess;
  buffer: RingBuffer;
  exited: boolean;
}

export interface OpenSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

const clamp = (n: number, max: number): number =>
  Math.min(max, Math.max(1, Math.floor(Number.isFinite(n) ? n : 1)));

/**
 * Owns the office's pseudo-terminals (spec §2). Output is buffered for
 * re-attaching and handed to listeners; who receives it is TerminalHub's
 * business, never a broadcast.
 */
export class PtyHost {
  private readonly consoles = new Map<string, Console>();
  private readonly outputCbs = new Set<(id: string, data: string) => void>();
  private readonly exitCbs = new Set<(id: string, exitCode: number) => void>();
  private readonly maxTerminals: number;
  private readonly bufferChars: number;

  constructor(
    private readonly factory: PtyFactory,
    opts: { maxTerminals?: number; bufferChars?: number } = {},
  ) {
    this.maxTerminals = opts.maxTerminals ?? MAX_OFFICE_TERMINALS;
    this.bufferChars = opts.bufferChars ?? TERMINAL_BUFFER_CHARS;
  }

  get size(): number {
    return this.consoles.size;
  }

  open(spec: OpenSpec): string {
    let live = 0;
    for (const c of this.consoles.values()) if (!c.exited) live++;
    if (live >= this.maxTerminals) {
      throw new Error(`Too many office consoles (max ${this.maxTerminals})`);
    }
    const pty = this.factory(spec.file, spec.args, {
      cwd: spec.cwd,
      cols: clamp(spec.cols ?? TERMINAL_DEFAULT_COLS, TERMINAL_MAX_COLS),
      rows: clamp(spec.rows ?? TERMINAL_DEFAULT_ROWS, TERMINAL_MAX_ROWS),
      env: spec.env,
    });
    const id = crypto.randomUUID();
    const entry: Console = { pty, buffer: new RingBuffer(this.bufferChars), exited: false };
    this.consoles.set(id, entry);
    pty.onData((data) => {
      entry.buffer.append(data);
      for (const cb of this.outputCbs) cb(id, data);
    });
    pty.onExit(({ exitCode }) => {
      if (entry.exited) return;
      entry.exited = true;
      for (const cb of this.exitCbs) cb(id, exitCode);
    });
    return id;
  }

  has(id: string): boolean {
    return this.consoles.has(id);
  }

  snapshot(id: string): { data: string; exited: boolean } | undefined {
    const c = this.consoles.get(id);
    return c ? { data: c.buffer.read(), exited: c.exited } : undefined;
  }

  write(id: string, data: string): boolean {
    const c = this.consoles.get(id);
    if (!c || c.exited) return false;
    c.pty.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const c = this.consoles.get(id);
    if (!c || c.exited) return false;
    c.pty.resize(clamp(cols, TERMINAL_MAX_COLS), clamp(rows, TERMINAL_MAX_ROWS));
    return true;
  }

  close(id: string): boolean {
    const c = this.consoles.get(id);
    if (!c) return false;
    this.consoles.delete(id);
    if (!c.exited) {
      try {
        c.pty.kill();
      } catch {
        /* already gone */
      }
    }
    return true;
  }

  closeAll(): void {
    for (const id of [...this.consoles.keys()]) this.close(id);
  }

  onOutput(cb: (id: string, data: string) => void): () => void {
    this.outputCbs.add(cb);
    return () => this.outputCbs.delete(cb);
  }

  onExit(cb: (id: string, exitCode: number) => void): () => void {
    this.exitCbs.add(cb);
    return () => this.exitCbs.delete(cb);
  }
}
