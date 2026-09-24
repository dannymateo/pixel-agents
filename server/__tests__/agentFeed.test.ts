/**
 * AgentFeedHub (plan T11): per-connection subscriptions to an agent's screen
 * feed. The feed exposes code and command output, so it is never broadcast and
 * only privileged connections ever get a byte of it.
 */
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeedEntry } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { FeedSend } from '../src/agentFeed.js';
import { AgentFeedHub } from '../src/agentFeed.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  FEED_MAX_SUBSCRIPTIONS_PER_CONNECTION,
  FEED_SEEN_UUIDS_MAX,
  FEED_SNAPSHOT_MAX_ENTRIES,
  FEED_TAIL_READ_BYTES,
} from '../src/constants.js';
import { readNewLines, setTranscriptLineListener } from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';

/** Every fs call that could touch a transcript, counted. */
const fsCalls = vi.hoisted(() => ({ count: 0, reads: 0, openFlags: [] as unknown[] }));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const counted = <T extends (...args: never[]) => unknown>(fn: T): T =>
    ((...args: Parameters<T>) => {
      fsCalls.count++;
      return fn(...args);
    }) as T;
  return {
    ...actual,
    readFileSync: counted(actual.readFileSync),
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      fsCalls.count++;
      fsCalls.openFlags.push(args[1]);
      return actual.openSync(...args);
    }) as typeof actual.openSync,
    readSync: ((...args: Parameters<typeof actual.readSync>) => {
      fsCalls.count++;
      fsCalls.reads++;
      return actual.readSync(...args);
    }) as typeof actual.readSync,
    statSync: counted(actual.statSync),
    lstatSync: counted(actual.lstatSync),
    fstatSync: counted(actual.fstatSync),
    createReadStream: counted(actual.createReadStream),
  };
});

// Imported after the mock so the test writes through the real module.
const fs = await vi.importActual<typeof import('fs')>('fs');

// ── Fixtures ──

let dir: string;

function textRecord(uuid: string, text: string): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-09-24T10:00:00.000Z',
    message: { content: [{ type: 'text', text }] },
  };
}

function bashRecord(uuid: string, toolId: string, command: string): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-09-24T10:00:01.000Z',
    message: { content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command } }] },
  };
}

function writeTranscript(name: string, records: Array<Record<string, unknown> | string>): string {
  const file = path.join(dir, name);
  const body = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
  fs.writeFileSync(file, body + '\n');
  return file;
}

function appendRecords(file: string, records: Array<Record<string, unknown>>): void {
  fs.appendFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function makeAgent(id: number, jsonlFile: string, extra: Partial<AgentState> = {}): AgentState {
  const size = jsonlFile && fs.existsSync(jsonlFile) ? fs.statSync(jsonlFile).size : 0;
  return {
    id,
    sessionId: `session-${id}`,
    isExternal: true,
    projectDir: dir,
    jsonlFile,
    fileOffset: size,
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
    ...extra,
  };
}

type Msg = Parameters<FeedSend>[0];

function recorder(): { send: FeedSend; msgs: Msg[] } {
  const msgs: Msg[] = [];
  return { send: (m) => msgs.push(m), msgs };
}

function seqs(entries: FeedEntry[]): number[] {
  return entries.map((e) => e.seq);
}

function expectStrictlyIncreasing(values: number[]): void {
  for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
}

let store: AgentStateStore;
let hub: AgentFeedHub;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-feed-'));
  store = new AgentStateStore();
  hub = new AgentFeedHub(store, claudeProvider);
  fsCalls.count = 0;
  fsCalls.reads = 0;
  fsCalls.openFlags = [];
});

afterEach(() => {
  hub.dispose();
  setTranscriptLineListener(null);
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Privilege and existence ──

describe('AgentFeedHub — access', () => {
  it('denies an unprivileged connection without ever touching the transcript', () => {
    const file = writeTranscript('a.jsonl', [textRecord('u1', 'secret code here')]);
    store.set(1, makeAgent(1, file));
    fsCalls.count = 0;
    const { send, msgs } = recorder();

    hub.subscribe('c1', 1, false, send);

    expect(msgs).toEqual([{ type: 'agentFeedDenied', id: 1, reason: 'unprivileged' }]);
    expect(fsCalls.count).toBe(0);
    // Nor does it become a subscriber: live records never reach it.
    hub.onRecord(1, textRecord('u2', 'more secrets'));
    expect(msgs).toHaveLength(1);
    expect(hub.hasSubscribers(1)).toBe(false);

    // The spy does see reads: the same request, privileged, reads the file.
    hub.subscribe('c1', 1, true, send);
    expect(fsCalls.count).toBeGreaterThan(0);
  });

  it('denies unprivileged before revealing whether the agent exists', () => {
    const { send, msgs } = recorder();
    hub.subscribe('c1', 999, false, send);
    expect(msgs).toEqual([{ type: 'agentFeedDenied', id: 999, reason: 'unprivileged' }]);
  });

  it('answers unknownAgent for a missing agent', () => {
    const { send, msgs } = recorder();
    hub.subscribe('c1', 42, true, send);
    expect(msgs).toEqual([{ type: 'agentFeedDenied', id: 42, reason: 'unknownAgent' }]);
    expect(hub.hasSubscribers(42)).toBe(false);
  });

  it('answers unknownAgent for an agent with no transcript (workflow node, hooks-only)', () => {
    store.set(2, makeAgent(2, '', { nodeKind: 'workflow' }));
    store.set(3, makeAgent(3, path.join(dir, 'x.jsonl'), { hooksOnly: true }));
    store.set(4, makeAgent(4, path.join(dir, 'y.jsonl'), { nodeKind: 'workflow' }));
    fsCalls.count = 0;
    const { send, msgs } = recorder();
    hub.subscribe('c1', 2, true, send);
    hub.subscribe('c1', 3, true, send);
    hub.subscribe('c1', 4, true, send);
    expect(msgs).toEqual([
      { type: 'agentFeedDenied', id: 2, reason: 'unknownAgent' },
      { type: 'agentFeedDenied', id: 3, reason: 'unknownAgent' },
      { type: 'agentFeedDenied', id: 4, reason: 'unknownAgent' },
    ]);
    expect(fsCalls.count).toBe(0);
  });

  it('ignores a malformed agent id', () => {
    const { send, msgs } = recorder();
    hub.subscribe('c1', Number.NaN, true, send);
    hub.subscribe('c1', 1.5, false, send);
    hub.subscribe('c1', '1' as unknown as number, true, send);
    expect(msgs).toEqual([]);
  });
});

// ── Snapshot ──

describe('AgentFeedHub — snapshot', () => {
  it('sends the tail entries with strictly increasing seq', () => {
    const file = writeTranscript('a.jsonl', [
      { type: 'user', uuid: 'p', message: { content: 'hello' } },
      textRecord('u1', 'Looking at the code'),
      bashRecord('u2', 'toolu_1', 'npm test'),
      {
        type: 'user',
        uuid: 'u3',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
      },
    ]);
    store.set(1, makeAgent(1, file));
    const { send, msgs } = recorder();

    hub.subscribe('c1', 1, true, send);

    expect(msgs).toHaveLength(1);
    const snap = msgs[0];
    expect(snap.type).toBe('agentFeedSnapshot');
    if (snap.type !== 'agentFeedSnapshot') return;
    expect(snap.id).toBe(1);
    expect(snap.truncated).toBe(false);
    expect(snap.entries.map((e) => e.kind)).toEqual(['text', 'tool', 'toolResult']);
    expect(snap.entries[1].summary).toBe('Bash: npm test');
    expectStrictlyIncreasing(seqs(snap.entries));
  });

  it('keeps only the newest FEED_SNAPSHOT_MAX_ENTRIES and flags the cut', () => {
    const total = FEED_SNAPSHOT_MAX_ENTRIES + 50;
    const records = Array.from({ length: total }, (_, i) => textRecord(`u${i}`, `line ${i}`));
    const file = writeTranscript('a.jsonl', records);
    store.set(1, makeAgent(1, file));
    const { send, msgs } = recorder();

    hub.subscribe('c1', 1, true, send);

    const snap = msgs[0];
    if (snap.type !== 'agentFeedSnapshot') throw new Error('expected snapshot');
    expect(snap.entries).toHaveLength(FEED_SNAPSHOT_MAX_ENTRIES);
    expect(snap.truncated).toBe(true);
    expect(snap.entries[0].summary).toBe(`line 50`);
    expect(snap.entries.at(-1)?.summary).toBe(`line ${total - 1}`);
    expectStrictlyIncreasing(seqs(snap.entries));
  });

  it('reads only the last FEED_TAIL_READ_BYTES, dropping the partial first line', () => {
    // A huge first record straddles the tail window: its fragment must be
    // dropped (not parsed as garbage), the complete records after it kept.
    const pad = 'x'.repeat(FEED_TAIL_READ_BYTES);
    const file = writeTranscript('a.jsonl', [
      textRecord('big', pad),
      textRecord('u1', 'after one'),
      textRecord('u2', 'after two'),
    ]);
    store.set(1, makeAgent(1, file));
    const { send, msgs } = recorder();

    hub.subscribe('c1', 1, true, send);

    const snap = msgs[0];
    if (snap.type !== 'agentFeedSnapshot') throw new Error('expected snapshot');
    expect(snap.entries.map((e) => e.summary)).toEqual(['after one', 'after two']);
    // History before the window exists: the client is told it's not the start.
    expect(snap.truncated).toBe(true);
  });

  it('ends at the watcher offset: records past it arrive later as appends, once', () => {
    const file = writeTranscript('a.jsonl', [textRecord('u1', 'one')]);
    const agent = makeAgent(1, file);
    store.set(1, agent);
    appendRecords(file, [textRecord('u2', 'two')]); // not read by the watcher yet
    const { send, msgs } = recorder();

    hub.subscribe('c1', 1, true, send);
    const snap = msgs[0];
    if (snap.type !== 'agentFeedSnapshot') throw new Error('expected snapshot');
    expect(snap.entries.map((e) => e.summary)).toEqual(['one']);

    hub.onRecord(1, textRecord('u2', 'two'));
    const append = msgs[1];
    if (append.type !== 'agentFeedAppend') throw new Error('expected append');
    expect(append.entries.map((e) => e.summary)).toEqual(['two']);
    expect(append.entries[0].seq).toBeGreaterThan(snap.entries[0].seq);
  });

  it('drops the record still being written at the watcher offset', () => {
    const file = path.join(dir, 'a.jsonl');
    fs.writeFileSync(file, JSON.stringify(textRecord('u1', 'one')) + '\n{"type":"assist');
    store.set(1, makeAgent(1, file));
    const { send, msgs } = recorder();
    hub.subscribe('c1', 1, true, send);
    const snap = msgs[0];
    if (snap.type !== 'agentFeedSnapshot') throw new Error('expected snapshot');
    expect(snap.entries.map((e) => e.summary)).toEqual(['one']);
  });

  it('skips malformed lines and records the provider does not understand', () => {
    const file = writeTranscript('a.jsonl', [
      '{not json',
      '[1,2,3]',
      '"a string"',
      { type: 'system', subtype: 'turn_duration', uuid: 's1' },
      textRecord('u1', 'fine'),
    ]);
    store.set(1, makeAgent(1, file));
    const { send, msgs } = recorder();
    hub.subscribe('c1', 1, true, send);
    const snap = msgs[0];
    if (snap.type !== 'agentFeedSnapshot') throw new Error('expected snapshot');
    expect(snap.entries.map((e) => e.summary)).toEqual(['fine']);
  });

  it('deduplicates repeated records by uuid', () => {
    const r1 = textRecord('dup-1', 'first');
    const r2 = bashRecord('dup-2', 'toolu_9', 'ls');
    const file = writeTranscript('a.jsonl', [r1, r1, r2, r1, r2, textRecord('u3', 'last')]);
    store.set(1, makeAgent(1, file));
    const { send, msgs } = recorder();
    hub.subscribe('c1', 1, true, send);
    const snap = msgs[0];
    if (snap.type !== 'agentFeedSnapshot') throw new Error('expected snapshot');
    expect(snap.entries.map((e) => e.summary)).toEqual(['first', 'Bash: ls', 'last']);
    expectStrictlyIncreasing(seqs(snap.entries));
  });

  it('sends an empty snapshot while the transcript does not exist yet', () => {
    store.set(1, makeAgent(1, path.join(dir, 'not-yet.jsonl'), { fileOffset: 0 }));
    const { send, msgs } = recorder();
    hub.subscribe('c1', 1, true, send);
    expect(msgs).toEqual([{ type: 'agentFeedSnapshot', id: 1, entries: [], truncated: false }]);
    expect(hub.hasSubscribers(1)).toBe(true);
  });

  it('does not read a transcript path that is not a regular file', () => {
    const sub = path.join(dir, 'a-directory.jsonl');
    fs.mkdirSync(sub);
    store.set(1, makeAgent(1, sub, { fileOffset: 10 }));
    const { send, msgs } = recorder();
    hub.subscribe('c1', 1, true, send);
    expect(msgs).toEqual([{ type: 'agentFeedSnapshot', id: 1, entries: [], truncated: false }]);
  });

  it('does not follow a symlinked transcript', () => {
    const outside = writeTranscript('outside.jsonl', [textRecord('u1', 'not yours')]);
    const link = path.join(dir, 'link.jsonl');
    try {
      fs.symlinkSync(outside, link, 'file');
    } catch {
      return; // symlinks need privileges on some Windows setups
    }
    store.set(1, makeAgent(1, link, { fileOffset: fs.statSync(outside).size }));
    const { send, msgs } = recorder();
    hub.subscribe('c1', 1, true, send);
    expect(msgs).toEqual([{ type: 'agentFeedSnapshot', id: 1, entries: [], truncated: false }]);
  });

  it('gives a second subscriber the same seq for the same records', () => {
    const file = writeTranscript('a.jsonl', [textRecord('u1', 'one'), textRecord('u2', 'two')]);
    store.set(1, makeAgent(1, file));
    const a = recorder();
    const b = recorder();
    hub.subscribe('c1', 1, true, a.send);
    hub.onRecord(1, textRecord('u3', 'three'));
    appendRecords(file, [textRecord('u3', 'three')]);
    store.get(1)!.fileOffset = fs.statSync(file).size;

    hub.subscribe('c2', 1, true, b.send);

    const snapA = a.msgs[0];
    const appendA = a.msgs[1];
    const snapB = b.msgs[0];
    if (snapA.type !== 'agentFeedSnapshot' || appendA.type !== 'agentFeedAppend')
      throw new Error('unexpected message');
    if (snapB.type !== 'agentFeedSnapshot') throw new Error('unexpected message');
    expect(seqs(snapB.entries)).toEqual([...seqs(snapA.entries), ...seqs(appendA.entries)]);
  });

  it('re-subscribing to an unchanged transcript reuses the parsed tail', () => {
    const file = writeTranscript('a.jsonl', [textRecord('u1', 'one'), textRecord('u2', 'two')]);
    store.set(1, makeAgent(1, file));
    const a = recorder();
    hub.subscribe('c1', 1, true, a.send);
    fsCalls.reads = 0;
    hub.subscribe('c1', 1, true, a.send);
    expect(fsCalls.reads).toBe(0);
    expect(a.msgs[1]).toEqual(a.msgs[0]);

    // Once the watcher has read more, the tail is read again.
    appendRecords(file, [textRecord('u3', 'three')]);
    store.get(1)!.fileOffset = fs.statSync(file).size;
    hub.subscribe('c1', 1, true, a.send);
    expect(fsCalls.reads).toBeGreaterThan(0);
    const snap = a.msgs[2];
    if (snap.type !== 'agentFeedSnapshot') throw new Error('expected snapshot');
    expect(snap.entries.map((e) => e.summary)).toEqual(['one', 'two', 'three']);
    expectStrictlyIncreasing(seqs(snap.entries));
  });

  it('opens the transcript without following links or blocking on a FIFO', () => {
    const file = writeTranscript('a.jsonl', [textRecord('u1', 'one')]);
    store.set(1, makeAgent(1, file));
    hub.subscribe('c1', 1, true, recorder().send);
    const flags = fs.constants.O_NOFOLLOW ?? 0;
    const nonBlock = fs.constants.O_NONBLOCK ?? 0;
    expect(fsCalls.openFlags).toHaveLength(1);
    const used = fsCalls.openFlags[0] as number;
    expect(typeof used).toBe('number');
    expect(used & flags).toBe(flags);
    expect(used & nonBlock).toBe(nonBlock);
  });

  it('renumbers a snapshot whose remembered seqs would break the order', () => {
    // A record without uuid between two known ones: its fresh seq would land
    // after u2's, so the whole snapshot is renumbered for the late subscriber.
    const anon = { ...textRecord('x', 'anon'), uuid: undefined };
    const file = writeTranscript('a.jsonl', [
      textRecord('u1', 'one'),
      anon,
      textRecord('u2', 'two'),
    ]);
    store.set(1, makeAgent(1, file));
    const a = recorder();
    const b = recorder();
    hub.subscribe('c1', 1, true, a.send);
    hub.subscribe('c2', 1, true, b.send);
    const snapA = a.msgs[0];
    const snapB = b.msgs[0];
    if (snapA.type !== 'agentFeedSnapshot' || snapB.type !== 'agentFeedSnapshot') {
      throw new Error('expected snapshots');
    }
    expect(snapB.entries.map((e) => e.summary)).toEqual(['one', 'anon', 'two']);
    expectStrictlyIncreasing(seqs(snapB.entries));
    expect(snapB.entries[0].seq).toBeGreaterThan(snapA.entries.at(-1)!.seq);
    hub.onRecord(1, textRecord('u3', 'three'));
    for (const r of [a, b]) {
      const append = r.msgs.at(-1)!;
      if (append.type !== 'agentFeedAppend') throw new Error('expected append');
      expect(append.entries[0].seq).toBeGreaterThan(snapB.entries.at(-1)!.seq);
    }
  });

  it('cuts the oldest kept record to its newest entries, keeping their seqs', () => {
    const multi = {
      type: 'assistant',
      uuid: 'm',
      message: {
        content: [
          { type: 'text', text: 'm1' },
          { type: 'text', text: 'm2' },
          { type: 'text', text: 'm3' },
        ],
      },
    };
    const rest = Array.from({ length: FEED_SNAPSHOT_MAX_ENTRIES - 1 }, (_, i) =>
      textRecord(`r${i}`, `r ${i}`),
    );
    const file = writeTranscript('a.jsonl', [multi, ...rest]);
    store.set(1, makeAgent(1, file));
    const a = recorder();
    const b = recorder();
    hub.subscribe('c1', 1, true, a.send);
    hub.subscribe('c2', 1, true, b.send);
    const snap = a.msgs[0];
    if (snap.type !== 'agentFeedSnapshot') throw new Error('expected snapshot');
    expect(snap.entries).toHaveLength(FEED_SNAPSHOT_MAX_ENTRIES);
    expect(snap.truncated).toBe(true);
    expect(snap.entries[0].summary).toBe('m3');
    expect(snap.entries[0].seq).toBe(3); // base 1 + index 2
    expectStrictlyIncreasing(seqs(snap.entries));
    expect(b.msgs[0]).toEqual(snap);
  });

  it('keeps the first record when the tail window opens right after a newline', () => {
    // The window starts exactly at the first byte of `first`: the byte before
    // it is a newline, so `first` is no fragment and must be kept.
    const NL = String.fromCharCode(10);
    const head = JSON.stringify(textRecord('h', 'head')) + NL;
    const body =
      JSON.stringify(textRecord('u1', 'first')) +
      NL +
      JSON.stringify(textRecord('u2', 'second')) +
      NL;
    const filler = JSON.stringify(textRecord('f', 'x'.repeat(FEED_TAIL_READ_BYTES))) + NL;
    const file = path.join(dir, 'a.jsonl');
    fs.writeFileSync(file, head + body + filler);
    const firstAt = Buffer.byteLength(head);
    // Window [firstAt, firstAt + TAIL): ends inside the filler (dropped as unterminated).
    store.set(1, makeAgent(1, file, { fileOffset: firstAt + FEED_TAIL_READ_BYTES }));
    const { send, msgs } = recorder();
    hub.subscribe('c1', 1, true, send);
    const snap = msgs[0];
    if (snap.type !== 'agentFeedSnapshot') throw new Error('expected snapshot');
    expect(snap.entries.map((e) => e.summary)).toEqual(['first', 'second']);
    expect(snap.truncated).toBe(true);
  });

  it('re-subscribing the same connection sends a fresh snapshot and evicts nobody', () => {
    const file = writeTranscript('a.jsonl', [textRecord('u1', 'one')]);
    store.set(1, makeAgent(1, file));
    const a = recorder();
    hub.subscribe('c1', 1, true, a.send);
    hub.subscribe('c1', 1, true, a.send);
    expect(a.msgs.map((m) => m.type)).toEqual(['agentFeedSnapshot', 'agentFeedSnapshot']);
    hub.onRecord(1, textRecord('u2', 'two'));
    expect(a.msgs.filter((m) => m.type === 'agentFeedAppend')).toHaveLength(1);
  });

  it('a transcript switch restarts every subscriber from the new file', () => {
    const oldFile = writeTranscript('old.jsonl', [textRecord('o1', 'old one')]);
    const agent = makeAgent(1, oldFile);
    store.set(1, agent);
    const a = recorder();
    hub.subscribe('c1', 1, true, a.send);

    // /clear: the agent moves to a new transcript, read from its start.
    const newFile = writeTranscript('new.jsonl', [
      textRecord('o1', 'reused uuid'),
      textRecord('n2', 'new two'),
    ]);
    agent.jsonlFile = newFile;
    agent.fileOffset = fs.statSync(newFile).size;
    hub.onRecord(1, textRecord('n2', 'new two'));

    const snap = a.msgs[1];
    if (snap.type !== 'agentFeedSnapshot') throw new Error('expected fresh snapshot');
    // The old file's uuids are forgotten: nothing of the new file is dropped.
    expect(snap.entries.map((e) => e.summary)).toEqual(['reused uuid', 'new two']);
    expect(snap.entries[0].seq).toBeGreaterThan(
      (a.msgs[0] as { entries: FeedEntry[] }).entries[0].seq,
    );
    expect(a.msgs).toHaveLength(2); // the record itself was in the snapshot
  });

  it('a provider without a feed yields an empty snapshot and reads nothing', () => {
    const noFeed = { ...claudeProvider, parseFeedEntries: undefined } as HookProvider;
    const plainHub = new AgentFeedHub(store, noFeed);
    const file = writeTranscript('a.jsonl', [textRecord('u1', 'one')]);
    store.set(1, makeAgent(1, file));
    fsCalls.count = 0;
    const { send, msgs } = recorder();
    plainHub.subscribe('c1', 1, true, send);
    expect(msgs).toEqual([{ type: 'agentFeedSnapshot', id: 1, entries: [], truncated: false }]);
    expect(fsCalls.count).toBe(0);
    plainHub.dispose();
  });
});

// ── Live appends ──

describe('AgentFeedHub — appends', () => {
  function setupTwoAgents(): void {
    store.set(1, makeAgent(1, writeTranscript('a.jsonl', [textRecord('a0', 'a zero')])));
    store.set(2, makeAgent(2, writeTranscript('b.jsonl', [textRecord('b0', 'b zero')])));
  }

  it('sends onRecord only to the subscribed connection, continuing the seq', () => {
    setupTwoAgents();
    const c1 = recorder();
    const c2 = recorder();
    const c3 = recorder();
    hub.subscribe('c1', 1, true, c1.send);
    hub.subscribe('c2', 2, true, c2.send);
    hub.subscribe('c3', 2, false, c3.send);

    hub.onRecord(1, textRecord('a1', 'a one'));

    expect(c1.msgs).toHaveLength(2);
    const [snap, append] = c1.msgs;
    if (snap.type !== 'agentFeedSnapshot' || append.type !== 'agentFeedAppend')
      throw new Error('unexpected message');
    expect(append.id).toBe(1);
    expect(append.entries.map((e) => e.summary)).toEqual(['a one']);
    expect(append.entries[0].seq).toBeGreaterThan(snap.entries.at(-1)!.seq);
    expect(c2.msgs).toHaveLength(1); // its own snapshot only
    expect(c3.msgs).toHaveLength(1); // its denial only
  });

  it('sends one append per record with several entries, seq strictly increasing', () => {
    setupTwoAgents();
    const c1 = recorder();
    hub.subscribe('c1', 1, true, c1.send);
    hub.onRecord(1, {
      type: 'assistant',
      uuid: 'multi',
      message: {
        content: [
          { type: 'text', text: 'running it' },
          { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'make' } },
        ],
      },
    });
    const append = c1.msgs[1];
    if (append.type !== 'agentFeedAppend') throw new Error('unexpected message');
    expect(append.entries).toHaveLength(2);
    expectStrictlyIncreasing([
      ...seqs((c1.msgs[0] as { entries: FeedEntry[] }).entries),
      ...seqs(append.entries),
    ]);
  });

  it('stops after unsubscribe and after dropConnection', () => {
    setupTwoAgents();
    const c1 = recorder();
    const c2 = recorder();
    hub.subscribe('c1', 1, true, c1.send);
    hub.subscribe('c2', 1, true, c2.send);
    hub.subscribe('c2', 2, true, c2.send);

    hub.unsubscribe('c1', 1);
    hub.onRecord(1, textRecord('a1', 'a one'));
    expect(c1.msgs).toHaveLength(1);
    expect(c2.msgs).toHaveLength(3); // two snapshots + the append

    hub.dropConnection('c2');
    hub.onRecord(1, textRecord('a2', 'a two'));
    hub.onRecord(2, textRecord('b1', 'b one'));
    expect(c2.msgs).toHaveLength(3);
    expect(hub.hasSubscribers(1)).toBe(false);
    expect(hub.hasSubscribers(2)).toBe(false);
  });

  it('never parses a record of an agent nobody watches', () => {
    const parseFeedEntries = vi.fn(claudeProvider.parseFeedEntries!);
    const spyHub = new AgentFeedHub(store, { ...claudeProvider, parseFeedEntries });
    setupTwoAgents();
    spyHub.onRecord(1, textRecord('a1', 'a one'));
    spyHub.onRecord(99, textRecord('z', 'nobody'));
    expect(parseFeedEntries).not.toHaveBeenCalled();

    spyHub.subscribe('c1', 1, true, recorder().send);
    parseFeedEntries.mockClear();
    spyHub.onRecord(2, textRecord('b1', 'b one'));
    expect(parseFeedEntries).not.toHaveBeenCalled();
    spyHub.dispose();
  });

  it('drops records already sent (snapshot or append) by uuid', () => {
    setupTwoAgents();
    const c1 = recorder();
    hub.subscribe('c1', 1, true, c1.send);
    hub.onRecord(1, textRecord('a0', 'a zero')); // in the snapshot already
    hub.onRecord(1, textRecord('a1', 'a one'));
    hub.onRecord(1, textRecord('a1', 'a one')); // replayed duplicate
    expect(c1.msgs.map((m) => m.type)).toEqual(['agentFeedSnapshot', 'agentFeedAppend']);
  });

  it('bounds the remembered uuids', () => {
    setupTwoAgents();
    const c1 = recorder();
    hub.subscribe('c1', 1, true, c1.send);
    for (let i = 0; i <= FEED_SEEN_UUIDS_MAX; i++) hub.onRecord(1, textRecord(`n${i}`, `n ${i}`));
    // The oldest uuid was forgotten, the newest still deduplicated.
    const before = c1.msgs.length;
    hub.onRecord(1, textRecord(`n${FEED_SEEN_UUIDS_MAX}`, 'again'));
    expect(c1.msgs).toHaveLength(before);
    hub.onRecord(1, textRecord('a0', 'a zero'));
    expect(c1.msgs).toHaveLength(before + 1);
  });

  it('records without a usable uuid are delivered, never deduplicated', () => {
    setupTwoAgents();
    const c1 = recorder();
    hub.subscribe('c1', 1, true, c1.send);
    const noUuid = { ...textRecord('x', 'anon'), uuid: undefined };
    const hugeUuid = textRecord('u'.repeat(10_000), 'huge');
    hub.onRecord(1, noUuid);
    hub.onRecord(1, noUuid);
    hub.onRecord(1, hugeUuid);
    hub.onRecord(1, hugeUuid);
    expect(c1.msgs.filter((m) => m.type === 'agentFeedAppend')).toHaveLength(4);
  });

  it('one failing connection does not starve the others', () => {
    setupTwoAgents();
    const good = recorder();
    let calls = 0;
    const bad: FeedSend = () => {
      calls++;
      if (calls > 1) throw new Error('socket closed');
    };
    hub.subscribe('bad', 1, true, bad);
    hub.subscribe('good', 1, true, good.send);
    expect(() => hub.onRecord(1, textRecord('a1', 'a one'))).not.toThrow();
    expect(good.msgs.map((m) => m.type)).toEqual(['agentFeedSnapshot', 'agentFeedAppend']);
  });

  it('a throwing provider parser drops the record, not the hub', () => {
    const throwing = {
      ...claudeProvider,
      parseFeedEntries: () => {
        throw new Error('boom');
      },
    } as HookProvider;
    const h = new AgentFeedHub(store, throwing);
    setupTwoAgents();
    const c1 = recorder();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    h.subscribe('c1', 1, true, c1.send);
    expect(() => h.onRecord(1, textRecord('a1', 'a one'))).not.toThrow();
    expect(c1.msgs).toEqual([{ type: 'agentFeedSnapshot', id: 1, entries: [], truncated: false }]);
    h.dispose();
  });
});

// ── Limits and lifecycle ──

describe('AgentFeedHub — limits and lifecycle', () => {
  it('caps subscriptions per connection by dropping the oldest', () => {
    const n = FEED_MAX_SUBSCRIPTIONS_PER_CONNECTION + 1;
    for (let id = 1; id <= n; id++) {
      store.set(id, makeAgent(id, writeTranscript(`t${id}.jsonl`, [textRecord(`r${id}`, 'x')])));
    }
    const c1 = recorder();
    for (let id = 1; id <= n; id++) hub.subscribe('c1', id, true, c1.send);

    expect(hub.hasSubscribers(1)).toBe(false);
    for (let id = 2; id <= n; id++) expect(hub.hasSubscribers(id)).toBe(true);
    const count = c1.msgs.length;
    hub.onRecord(1, textRecord('late', 'late'));
    expect(c1.msgs).toHaveLength(count);

    // Re-subscribing to one already watched refreshes it, evicting nothing.
    hub.subscribe('c1', 2, true, c1.send);
    for (let id = 2; id <= n; id++) expect(hub.hasSubscribers(id)).toBe(true);

    // Another connection has its own budget.
    hub.subscribe('c2', 1, true, recorder().send);
    expect(hub.hasSubscribers(1)).toBe(true);
  });

  it('frees a removed agent silently: no message, no further appends', () => {
    store.set(1, makeAgent(1, writeTranscript('a.jsonl', [textRecord('a0', 'x')])));
    const c1 = recorder();
    hub.subscribe('c1', 1, true, c1.send);
    store.delete(1);
    expect(c1.msgs).toHaveLength(1);
    expect(hub.hasSubscribers(1)).toBe(false);
    hub.onRecord(1, textRecord('a1', 'y'));
    expect(c1.msgs).toHaveLength(1);
    // Its slot no longer counts against the connection's cap.
    for (let id = 10; id < 10 + FEED_MAX_SUBSCRIPTIONS_PER_CONNECTION; id++) {
      store.set(id, makeAgent(id, writeTranscript(`t${id}.jsonl`, [textRecord(`r${id}`, 'x')])));
      hub.subscribe('c1', id, true, c1.send);
    }
    expect(hub.hasSubscribers(10)).toBe(true);
  });

  it('dispose detaches from the store and drops every subscription', () => {
    store.set(1, makeAgent(1, writeTranscript('a.jsonl', [textRecord('a0', 'x')])));
    const c1 = recorder();
    hub.subscribe('c1', 1, true, c1.send);
    hub.dispose();
    hub.onRecord(1, textRecord('a1', 'y'));
    expect(c1.msgs).toHaveLength(1);
    expect(hub.hasSubscribers(1)).toBe(false);
  });
});

// ── fileWatcher hook ──

describe('setTranscriptLineListener', () => {
  it('hands every parsed live record to the listener, skipping malformed lines', () => {
    const file = writeTranscript('a.jsonl', [textRecord('u1', 'one')]);
    const agent = makeAgent(1, file, { fileOffset: 0 });
    store.set(1, agent);
    fs.appendFileSync(file, '{broken\n' + JSON.stringify(textRecord('u2', 'two')) + '\n');
    const got: Array<[number, unknown]> = [];
    setTranscriptLineListener(
      (id, record) => got.push([id, record.uuid]),
      () => true,
    );

    readNewLines(1, store, new Map(), new Map());

    expect(got).toEqual([
      [1, 'u1'],
      [1, 'u2'],
    ]);
  });

  it('skips parsing for agents the gate does not want', () => {
    const file = writeTranscript('a.jsonl', [textRecord('u1', 'one')]);
    store.set(1, makeAgent(1, file, { fileOffset: 0 }));
    const listener = vi.fn();
    const parse = vi.spyOn(JSON, 'parse');
    setTranscriptLineListener(listener, () => false);
    readNewLines(1, store, new Map(), new Map());
    expect(listener).not.toHaveBeenCalled();
    // Only the transcript parser's own parse ran for the one line.
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener does not break transcript processing', () => {
    const file = writeTranscript('a.jsonl', [textRecord('u1', 'one'), textRecord('u2', 'two')]);
    const agent = makeAgent(1, file, { fileOffset: 0 });
    store.set(1, agent);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const listener = vi.fn(() => {
      throw new Error('listener bug');
    });
    setTranscriptLineListener(listener, () => true);
    readNewLines(1, store, new Map(), new Map());
    expect(listener).toHaveBeenCalledTimes(2);
    expect(agent.linesProcessed).toBe(2);
    expect(agent.fileOffset).toBe(fs.statSync(file).size);
  });

  it('wires into the hub end to end', () => {
    const file = writeTranscript('a.jsonl', [textRecord('u1', 'one')]);
    const agent = makeAgent(1, file);
    store.set(1, agent);
    setTranscriptLineListener(hub.onRecord, hub.hasSubscribers);
    const c1 = recorder();
    hub.subscribe('c1', 1, true, c1.send);
    appendRecords(file, [textRecord('u2', 'two')]);
    readNewLines(1, store, new Map(), new Map());
    const append = c1.msgs[1];
    if (append?.type !== 'agentFeedAppend') throw new Error('expected append');
    expect(append.entries.map((e) => e.summary)).toEqual(['two']);
  });
});
