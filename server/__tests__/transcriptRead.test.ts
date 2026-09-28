import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { readNewLines, setTranscriptLineListener } from '../src/fileWatcher.js';
import type { AgentState } from '../src/types.js';

// A small line cap so a test can overflow it; the real one is sized for
// image-bearing records several MB long.
vi.mock('../src/constants.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/constants.js')>()),
  MAX_TRANSCRIPT_LINE_CHARS: 1_000,
}));

let dir: string;
let store: AgentStateStore;
let seen: unknown[];

function record(uuid: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: '2026-09-28T10:00:00.000Z',
    message: { content: [{ type: 'text', text: uuid }] },
  });
}

function makeAgent(jsonlFile: string): AgentState {
  return {
    id: 1,
    sessionId: 'session-1',
    isExternal: true,
    projectDir: dir,
    jsonlFile,
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    hookDelivered: false,
    lastDataAt: Date.now(),
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    contextTokens: 0,
    maxContextTokens: 200_000,
  } as AgentState;
}

/** Read until the watcher has consumed the whole file (64 KB per call). */
function drain(): void {
  const agent = store.get(1)!;
  for (let i = 0; i < 100 && agent.fileOffset < fs.statSync(agent.jsonlFile).size; i++) {
    readNewLines(1, store, new Map(), new Map());
  }
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-transcript-read-'));
  store = new AgentStateStore();
  seen = [];
  setTranscriptLineListener(
    (_id, rec) => seen.push(rec.uuid),
    () => true,
  );
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setTranscriptLineListener(null);
  store.dispose();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readNewLines', () => {
  it('reads a regular transcript', () => {
    const file = path.join(dir, 'a.jsonl');
    fs.writeFileSync(file, record('u1') + '\n');
    store.set(1, makeAgent(file));
    drain();
    expect(seen).toEqual(['u1']);
  });

  it('never reads through a symlink (a transcript swapped for a link to another file)', (ctx) => {
    const outside = path.join(dir, 'outside.jsonl');
    fs.writeFileSync(outside, record('SECRET') + '\n');
    const link = path.join(dir, 'link.jsonl');
    try {
      fs.symlinkSync(outside, link, 'file');
    } catch {
      ctx.skip(); // Windows without symlink privilege
      return;
    }
    store.set(1, makeAgent(link));
    readNewLines(1, store, new Map(), new Map());
    expect(seen).toEqual([]);
    expect(store.get(1)!.fileOffset).toBe(0);
  });

  it('bounds an unterminated line, then resumes at the next complete one', () => {
    const file = path.join(dir, 'a.jsonl');
    // 5x the cap, never terminated while it grows.
    fs.writeFileSync(file, '{"type":"assistant","junk":"' + 'x'.repeat(5_000));
    store.set(1, makeAgent(file));
    drain();
    expect(store.get(1)!.lineBuffer.length).toBeLessThanOrEqual(1_000);

    // The oversized line finally ends — its tail must not parse as a record —
    // and the next record is read normally.
    fs.appendFileSync(file, 'x'.repeat(500) + '"}\n' + record('after') + '\n');
    drain();
    expect(seen).toEqual(['after']);
    expect(store.get(1)!.lineBuffer).toBe('');
  });

  it('a line under the cap split across reads still arrives whole', () => {
    const file = path.join(dir, 'a.jsonl');
    const line = record('split');
    fs.writeFileSync(file, line.slice(0, 20));
    store.set(1, makeAgent(file));
    drain();
    fs.appendFileSync(file, line.slice(20) + '\n');
    drain();
    expect(seen).toEqual(['split']);
  });
});
