/**
 * ConversationTracker (plan T13): turns the conversations a provider finds in
 * transcript records into `agentConversation` broadcasts — assignments when
 * the child materializes, reports back to the parent (handback, or the spawn's
 * result as fallback), and messages resolved inside the sender's tree. Only
 * what happens while the office watches is a scene: history read on adoption
 * or restore stays silent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConversation } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  CONVERSATION_FUTURE_SKEW_MS,
  CONVERSATION_PENDING_ASSIGN_TTL_MS,
  CONVERSATION_PENDING_ASSIGNS_MAX,
  CONVERSATION_SEEN_IDS_MAX,
  CONVERSATION_TEXT_MAX_BYTES,
} from '../src/constants.js';
import { ConversationTracker } from '../src/conversations.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { parseClaudeConversations } from '../src/providers/hook/claude/claudeConversation.js';
import type { AgentState } from '../src/types.js';

// The tracker only needs parseConversations; S6 registers it on claudeProvider.
const provider: HookProvider = { ...claudeProvider, parseConversations: parseClaudeConversations };

const T0 = Date.parse('2026-09-25T10:00:00.000Z');
/** ISO timestamp `sec` seconds after T0 (negative = before the office saw it). */
const at = (sec: number) => new Date(T0 + sec * 1000).toISOString();

let seq = 0;
function assistant(content: unknown[], sec = 1, uuid = `u${++seq}`): Record<string, unknown> {
  return { type: 'assistant', uuid, timestamp: at(sec), message: { role: 'assistant', content } };
}
const spawn = (toolUseId: string, prompt: string, sec = 1, uuid?: string) =>
  assistant(
    [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description: 'd', prompt } }],
    sec,
    uuid,
  );
const handback = (message: string, sec = 1, uuid?: string) =>
  assistant(
    [{ type: 'tool_use', id: `hb${++seq}`, name: 'SubagentHandback', input: { message } }],
    sec,
    uuid,
  );
const sendMessage = (to: string, message: string, sec = 1, uuid?: string) =>
  assistant(
    [{ type: 'tool_use', id: `sm${++seq}`, name: 'SendMessage', input: { to, message } }],
    sec,
    uuid,
  );
function spawnResult(toolUseId: string, content: unknown, sec = 2): Record<string, unknown> {
  return {
    type: 'user',
    uuid: `r${++seq}`,
    timestamp: at(sec),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  };
}

function makeAgent(id: number, extra: Partial<AgentState> = {}): AgentState {
  return {
    id,
    sessionId: `s${id}`,
    isExternal: true,
    projectDir: '/p',
    jsonlFile: `/p/${id}.jsonl`,
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
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...extra,
  } as AgentState;
}

let store: AgentStateStore;
let tracker: ConversationTracker;
let sent: AgentConversation[];

function child(
  id: number,
  parentId: number,
  spawnToolUseId: string,
  extra: Partial<AgentState> = {},
) {
  store.set(
    id,
    makeAgent(id, {
      parentAgentId: parentId,
      spawnToolUseId,
      spawnAgentKey: `key${id}`,
      depth: 1,
      ...extra,
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  seq = 0;
  store = new AgentStateStore();
  sent = [];
  store.on('broadcast', (m) => {
    if (m.type === 'agentConversation') sent.push(m as unknown as AgentConversation);
  });
  tracker = new ConversationTracker(store, provider);
  store.set(1, makeAgent(1));
});

afterEach(() => {
  tracker.dispose();
  vi.useRealTimers();
});

describe('assign', () => {
  it('is emitted only when the child materializes, addressed to it', () => {
    tracker.onRecord(1, spawn('toolu_A', 'Revisa el diff', 1, 'uA'));
    expect(sent).toEqual([]);

    child(2, 1, 'toolu_A');
    tracker.onChildMaterialized(1, 2, 'toolu_A');
    expect(sent).toEqual([
      {
        type: 'agentConversation',
        conversationId: '1:uA',
        fromId: 1,
        toId: 2,
        kind: 'assign',
        text: 'Revisa el diff',
      },
    ]);

    // Materializing again (a rescan) never repeats it.
    tracker.onChildMaterialized(1, 2, 'toolu_A');
    expect(sent).toHaveLength(1);
  });

  it('a child whose spawn was never seen live gets no assign', () => {
    child(2, 1, 'toolu_Z');
    tracker.onChildMaterialized(1, 2, 'toolu_Z');
    expect(sent).toEqual([]);
  });

  it('is ignored when the child is not in the store (call after agents.set)', () => {
    tracker.onRecord(1, spawn('toolu_A', 'x'));
    tracker.onChildMaterialized(1, 2, 'toolu_A');
    expect(sent).toEqual([]);
  });

  it('an assign parsed after its child already exists goes out at once', () => {
    child(2, 1, 'toolu_A');
    tracker.onChildMaterialized(1, 2, 'toolu_A');
    tracker.onRecord(1, spawn('toolu_A', 'tarde', 1, 'uA'));
    expect(sent).toEqual([
      expect.objectContaining({ conversationId: '1:uA', fromId: 1, toId: 2, kind: 'assign' }),
    ]);
  });

  it('the child of a live spawn is live from its first record', () => {
    tracker.onRecord(1, spawn('toolu_A', 'x'));
    // The child's transcript may hold records written before the scan found it.
    vi.setSystemTime(T0 + 5000);
    child(2, 1, 'toolu_A');
    tracker.onChildMaterialized(1, 2, 'toolu_A');
    tracker.onRecord(2, handback('listo', 3));
    expect(sent.map((c) => c.kind)).toEqual(['assign', 'report']);
  });

  it('pending assigns are bounded per parent (oldest dropped)', () => {
    for (let i = 0; i <= CONVERSATION_PENDING_ASSIGNS_MAX; i++) {
      tracker.onRecord(1, spawn(`toolu_${i}`, `p${i}`));
    }
    child(2, 1, 'toolu_0');
    tracker.onChildMaterialized(1, 2, 'toolu_0');
    child(3, 1, `toolu_${CONVERSATION_PENDING_ASSIGNS_MAX}`);
    tracker.onChildMaterialized(1, 3, `toolu_${CONVERSATION_PENDING_ASSIGNS_MAX}`);
    expect(sent.map((c) => c.toId)).toEqual([3]);
  });
});

describe('assign expiry', () => {
  it('a prompt whose child never came is dropped after the TTL', () => {
    tracker.onRecord(1, spawn('toolu_A', 'x'));
    vi.setSystemTime(T0 + CONVERSATION_PENDING_ASSIGN_TTL_MS + 1000);
    child(2, 1, 'toolu_A');
    tracker.onChildMaterialized(1, 2, 'toolu_A');
    expect(sent).toEqual([]);
  });

  it('storing a new prompt prunes expired ones', () => {
    tracker.onRecord(1, spawn('toolu_old', 'x'));
    vi.setSystemTime(T0 + CONVERSATION_PENDING_ASSIGN_TTL_MS + 1000);
    tracker.onRecord(1, spawn('toolu_new', 'y', CONVERSATION_PENDING_ASSIGN_TTL_MS / 1000 + 2));
    // Rewind the clock: a pruned prompt stays gone even if it would still fit.
    vi.setSystemTime(T0 + 1000);
    child(2, 1, 'toolu_old');
    tracker.onChildMaterialized(1, 2, 'toolu_old');
    expect(sent).toEqual([]);
  });
});

describe('report', () => {
  beforeEach(() => {
    tracker.onRecord(1, spawn('toolu_A', 'x'));
    child(2, 1, 'toolu_A');
    tracker.onChildMaterialized(1, 2, 'toolu_A');
    sent.length = 0;
  });

  it('a handback in the child transcript goes to its parent', () => {
    tracker.onRecord(2, handback('## Hecho', 3, 'uH'));
    expect(sent).toEqual([
      {
        type: 'agentConversation',
        conversationId: '2:uH',
        fromId: 2,
        toId: 1,
        kind: 'report',
        text: '## Hecho',
      },
    ]);
  });

  it('the spawn result is the fallback report when the child never handed back', () => {
    tracker.onSpawnResult(
      1,
      'toolu_A',
      spawnResult('toolu_A', [{ type: 'text', text: 'Resumen' }]),
    );
    expect(sent).toEqual([
      expect.objectContaining({ fromId: 2, toId: 1, kind: 'report', text: 'Resumen' }),
    ]);
  });

  it('a string tool_result content is the fallback text too', () => {
    tracker.onSpawnResult(1, 'toolu_A', spawnResult('toolu_A', 'plano'));
    expect(sent).toEqual([expect.objectContaining({ kind: 'report', text: 'plano' })]);
  });

  it('the spawn result never duplicates a handback', () => {
    tracker.onRecord(2, handback('hecho', 3));
    tracker.onSpawnResult(1, 'toolu_A', spawnResult('toolu_A', 'hecho', 4));
    expect(sent).toHaveLength(1);
  });

  it('a handback read after its fallback (other file polled first) is not repeated', () => {
    tracker.onSpawnResult(1, 'toolu_A', spawnResult('toolu_A', 'hecho', 4));
    tracker.onRecord(2, handback('hecho', 3));
    expect(sent).toHaveLength(1);
  });

  it('a new message from the parent opens a new round: the child may report again', () => {
    tracker.onRecord(2, handback('uno', 3));
    tracker.onRecord(1, sendMessage('key2', 'sigue', 4));
    tracker.onRecord(2, handback('dos', 5));
    expect(sent.map((c) => `${c.kind}:${c.text}`)).toEqual([
      'report:uno',
      'message:sigue',
      'report:dos',
    ]);
  });

  it('after a new round the spawn result may report again', () => {
    tracker.onRecord(2, handback('uno', 3));
    tracker.onRecord(1, sendMessage('key2', 'sigue', 4));
    tracker.onSpawnResult(1, 'toolu_A', spawnResult('toolu_A', 'final', 5));
    expect(sent.map((c) => `${c.kind}:${c.text}`)).toEqual([
      'report:uno',
      'message:sigue',
      'report:final',
    ]);
  });

  it('a message record without uuid still goes out, with a unique id', () => {
    const a = sendMessage('nadie', 'x');
    const b = sendMessage('nadie', 'y');
    delete a.uuid;
    delete b.uuid;
    tracker.onRecord(1, a);
    tracker.onRecord(1, b);
    expect(new Set(sent.map((c) => c.conversationId)).size).toBe(2);
  });

  it('an errored spawn result (interrupted) is not a report', () => {
    const r = spawnResult('toolu_A', '[Request interrupted by user for tool use]');
    (r.message as { content: Array<Record<string, unknown>> }).content[0].is_error = true;
    tracker.onSpawnResult(1, 'toolu_A', r);
    expect(sent).toEqual([]);
  });

  it('a handback without uuid still reports, and suppresses the fallback', () => {
    const h = handback('hecho', 3);
    delete h.uuid;
    tracker.onRecord(2, h);
    tracker.onSpawnResult(1, 'toolu_A', spawnResult('toolu_A', 'hecho', 4));
    expect(sent).toEqual([expect.objectContaining({ fromId: 2, toId: 1, kind: 'report' })]);
  });

  it('a handback read as history does not silence a live spawn result', () => {
    tracker.onRecord(2, handback('viejo', 3), { initial: true });
    tracker.onSpawnResult(1, 'toolu_A', spawnResult('toolu_A', 'final', 4));
    expect(sent).toEqual([expect.objectContaining({ kind: 'report', text: 'final' })]);
  });

  it('a spawn result with no child, or for another spawn, emits nothing', () => {
    tracker.onSpawnResult(1, 'toolu_Q', spawnResult('toolu_Q', 'x'));
    tracker.onSpawnResult(1, 'toolu_A', spawnResult('toolu_OTHER', 'x'));
    expect(sent).toEqual([]);
  });

  it('a spawn result flagged initial is silent', () => {
    tracker.onSpawnResult(1, 'toolu_A', spawnResult('toolu_A', 'x'), { initial: true });
    expect(sent).toEqual([]);
  });

  it('a spawn result older than a replaying parent is silent', () => {
    vi.setSystemTime(T0 + 60_000);
    tracker.beginReplay(1);
    tracker.onSpawnResult(1, 'toolu_A', spawnResult('toolu_A', 'x', 30));
    expect(sent).toEqual([]);
    tracker.onSpawnResult(1, 'toolu_A', spawnResult('toolu_A', 'y', 61));
    expect(sent).toEqual([expect.objectContaining({ kind: 'report', text: 'y' })]);
  });

  it('a root with no parent reports to no one', () => {
    tracker.onRecord(1, handback('x', 3));
    expect(sent).toEqual([]);
  });
});

describe('message', () => {
  it('resolves the recipient by spawn key, then by name, inside the tree', () => {
    child(2, 1, 'toolu_A', { spawnAgentKey: 'a2f66b77eeed7903f' });
    child(3, 1, 'toolu_B', { agentName: 'researcher' });
    tracker.onRecord(1, sendMessage('a2f66b77eeed7903f', 'por clave', 2, 'm1'));
    tracker.onRecord(1, sendMessage('researcher', 'por nombre', 2, 'm2'));
    expect(sent).toEqual([
      {
        type: 'agentConversation',
        conversationId: '1:m1',
        fromId: 1,
        toId: 2,
        kind: 'message',
        text: 'por clave',
      },
      {
        type: 'agentConversation',
        conversationId: '1:m2',
        fromId: 1,
        toId: 3,
        kind: 'message',
        text: 'por nombre',
      },
    ]);
  });

  it('a child can message its sibling and the key beats a same-named agent', () => {
    child(2, 1, 'toolu_A', { agentName: 'dup' });
    child(3, 1, 'toolu_B', { spawnAgentKey: 'dup' });
    tracker.onRecord(2, sendMessage('dup', 'hola'));
    expect(sent[0]).toEqual(expect.objectContaining({ fromId: 2, toId: 3 }));
  });

  it('an unresolved recipient is emitted without toId', () => {
    tracker.onRecord(1, sendMessage('nadie', 'hola'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty('toId');
    expect(sent[0]).toEqual(expect.objectContaining({ fromId: 1, kind: 'message' }));
  });

  it('never resolves into another root tree', () => {
    store.set(10, makeAgent(10));
    child(11, 10, 'toolu_X', { agentName: 'researcher', spawnAgentKey: 'kx' });
    tracker.onRecord(1, sendMessage('researcher', 'hola'));
    tracker.onRecord(1, sendMessage('kx', 'hola'));
    expect(sent.every((c) => c.toId === undefined)).toBe(true);
  });

  it("reaches a teammate in its own session through the sender's team", () => {
    store.get(1)!.teamName = 'session-ab12cd34';
    store.set(5, makeAgent(5, { teamName: 'session-ab12cd34', agentName: 'researcher' }));
    store.set(6, makeAgent(6, { teamName: 'session-other', agentName: 'researcher' }));
    tracker.onRecord(1, sendMessage('researcher', 'hola'));
    expect(sent[0]).toEqual(expect.objectContaining({ fromId: 1, toId: 5 }));
  });

  it('never resolves by team into another project', () => {
    store.get(1)!.teamName = 'equipo';
    store.set(5, makeAgent(5, { teamName: 'equipo', agentName: 'reviewer', projectDir: '/otro' }));
    tracker.onRecord(1, sendMessage('reviewer', 'hola'));
    expect(sent[0]).not.toHaveProperty('toId');
  });

  it('prototype-named recipients are plain strings', () => {
    tracker.onRecord(1, sendMessage('__proto__', 'x'));
    tracker.onRecord(1, sendMessage('constructor', 'y'));
    expect(sent).toHaveLength(2);
    expect(sent.every((c) => c.toId === undefined)).toBe(true);

    child(2, 1, 'toolu_A', { agentName: '__proto__' });
    tracker.onRecord(1, sendMessage('__proto__', 'z'));
    expect(sent[2]).toEqual(expect.objectContaining({ toId: 2 }));
  });

  it('an empty text goes out without a text field', () => {
    tracker.onRecord(1, sendMessage('nadie', ''));
    expect(sent[0]).not.toHaveProperty('text');
  });
});

describe('dedup and history', () => {
  it('a repeated record is emitted once', () => {
    const r = sendMessage('nadie', 'hola', 1, 'same');
    tracker.onRecord(1, r);
    tracker.onRecord(1, structuredClone(r));
    expect(sent).toHaveLength(1);
  });

  it('several conversations in one record get distinct ids', () => {
    tracker.onRecord(
      1,
      assistant(
        [
          { type: 'tool_use', id: 't1', name: 'SendMessage', input: { to: 'a', message: '1' } },
          { type: 'tool_use', id: 't2', name: 'SendMessage', input: { to: 'b', message: '2' } },
        ],
        1,
        'multi',
      ),
    );
    expect(sent.map((c) => c.conversationId)).toEqual(['1:multi', '1:multi:1']);
  });

  it('records flagged initial never emit, not even when read again later', () => {
    const r = sendMessage('nadie', 'viejo', 1, 'old');
    tracker.onRecord(1, r, { initial: true });
    tracker.onRecord(1, r);
    expect(sent).toEqual([]);
  });

  it('an initial spawn stores no assign for its child', () => {
    tracker.onRecord(1, spawn('toolu_A', 'x'), { initial: true });
    child(2, 1, 'toolu_A');
    tracker.onChildMaterialized(1, 2, 'toolu_A');
    expect(sent).toEqual([]);
  });

  it('records written before the office saw the agent are history', () => {
    // Agent 1 was added at T0: a replay from offset 0 carries older records.
    tracker.onRecord(1, sendMessage('nadie', 'antes', -60));
    tracker.onRecord(1, assistant([], -1)); // no conversation, still history
    expect(sent).toEqual([]);
    tracker.onRecord(1, sendMessage('nadie', 'ahora', 1));
    expect(sent.map((c) => c.text)).toEqual(['ahora']);
  });

  it('a record dated in the future does not end a replay', () => {
    vi.setSystemTime(T0 + 60_000);
    tracker.beginReplay(1);
    const future = (CONVERSATION_FUTURE_SKEW_MS + 60_000 + 3_600_000) / 1000;
    tracker.onRecord(1, sendMessage('nadie', 'futuro', future));
    tracker.onRecord(1, sendMessage('nadie', 'viejo', 30));
    tracker.onRecord(1, sendMessage('nadie', 'ahora', 61));
    expect(sent.map((c) => c.text)).toEqual(['ahora']);
  });

  it('only id-shaped uuids reach the conversation id', () => {
    tracker.onRecord(1, sendMessage('nadie', 'x', 1, 'SECRET-‮[31m-leak'));
    tracker.onRecord(1, sendMessage('nadie', 'y', 1, 'a'.repeat(129)));
    expect(sent.map((c) => c.conversationId)).toEqual(['1:#0', '1:#1']);
  });

  it('once live, an agent stays live (records without a timestamp included)', () => {
    tracker.onRecord(1, sendMessage('nadie', 'ahora', 1));
    const noTs = sendMessage('nadie', 'sin hora');
    delete noTs.timestamp;
    tracker.onRecord(1, noTs);
    expect(sent).toHaveLength(2);
  });

  it('while replaying, an undated record is history', () => {
    const noTs = sendMessage('nadie', 'sin hora');
    delete noTs.timestamp;
    tracker.onRecord(1, noTs);
    expect(sent).toEqual([]);
  });

  it('a replaying child of an unseen spawn stays silent over its history', () => {
    vi.setSystemTime(T0 + 60_000);
    child(2, 1, 'toolu_seeded');
    tracker.onChildMaterialized(1, 2, 'toolu_seeded');
    tracker.onRecord(2, handback('viejo', 30));
    tracker.onRecord(2, sendMessage('nadie', 'nuevo', 61));
    expect(sent.map((c) => c.text)).toEqual(['nuevo']);
  });

  it('beginReplay re-arms history for a transcript read again from the start', () => {
    tracker.onRecord(1, sendMessage('nadie', 'vivo', 1));
    vi.setSystemTime(T0 + 10_000);
    tracker.beginReplay(1);
    tracker.onRecord(1, sendMessage('nadie', 'releido', 2));
    tracker.onRecord(1, sendMessage('nadie', 'nuevo', 11));
    expect(sent.map((c) => c.text)).toEqual(['vivo', 'nuevo']);
  });

  it('agents in the store before the tracker existed start as history', () => {
    tracker.dispose();
    store.set(7, makeAgent(7));
    vi.setSystemTime(T0 + 10_000);
    tracker = new ConversationTracker(store, provider);
    tracker.onRecord(7, sendMessage('nadie', 'antes', 5));
    tracker.onRecord(7, sendMessage('nadie', 'despues', 11));
    expect(sent.map((c) => c.text)).toEqual(['despues']);
  });

  it('the dedup memory is bounded per agent', () => {
    const first = sendMessage('nadie', 'x', 1, 'first');
    tracker.onRecord(1, first);
    for (let i = 0; i < CONVERSATION_SEEN_IDS_MAX; i++) {
      tracker.onRecord(1, sendMessage('nadie', 'x', 1, `fill${i}`));
    }
    expect(sent).toHaveLength(CONVERSATION_SEEN_IDS_MAX + 1);
    // Evicted: a re-read this old is emitted again (bounded memory is the trade).
    tracker.onRecord(1, first);
    expect(sent).toHaveLength(CONVERSATION_SEEN_IDS_MAX + 2);
  });
});

describe('lifecycle and hostile input', () => {
  it('records of agents not in the store are ignored', () => {
    tracker.onRecord(99, sendMessage('nadie', 'x'));
    expect(sent).toEqual([]);
  });

  it("an agent's state goes with it (a reused id starts clean)", () => {
    tracker.onRecord(1, spawn('toolu_A', 'x', 1, 'uA'));
    store.delete(1);
    vi.setSystemTime(T0 + 5000);
    store.set(1, makeAgent(1));
    child(2, 1, 'toolu_A');
    tracker.onChildMaterialized(1, 2, 'toolu_A');
    expect(sent).toEqual([]);
  });

  it('a provider without parseConversations makes the tracker a no-op', () => {
    tracker.dispose();
    const bare: HookProvider = { ...claudeProvider, parseConversations: undefined };
    tracker = new ConversationTracker(store, bare);
    tracker.onRecord(1, sendMessage('nadie', 'x'));
    expect(sent).toEqual([]);
  });

  it('a throwing provider never breaks transcript processing', () => {
    tracker.dispose();
    const bad: HookProvider = {
      ...claudeProvider,
      parseConversations: () => {
        throw new Error('boom');
      },
    };
    tracker = new ConversationTracker(store, bad);
    expect(() => tracker.onRecord(1, sendMessage('nadie', 'x'))).not.toThrow();
    expect(sent).toEqual([]);
  });

  it('re-sanitizes and caps whatever the provider returns', () => {
    tracker.dispose();
    const loose: HookProvider = {
      ...claudeProvider,
      parseConversations: () => [
        { kind: 'message', text: `\u001b[2Jhola\u0000${'x'.repeat(CONVERSATION_TEXT_MAX_BYTES)}` },
        { kind: 'bogus' as 'message', text: 'x' },
        { kind: 'message', text: 42 as unknown as string },
      ],
    };
    tracker = new ConversationTracker(store, loose);
    tracker.onRecord(1, assistant([], 1, 'lx'));
    expect(sent).toHaveLength(2);
    expect(sent[0].text!.startsWith('holax')).toBe(true);
    expect(Buffer.byteLength(sent[0].text!, 'utf8')).toBeLessThanOrEqual(
      CONVERSATION_TEXT_MAX_BYTES,
    );
    expect(sent[1]).not.toHaveProperty('text');
  });

  it('dispose stops listening to the store', () => {
    tracker.dispose();
    store.set(8, makeAgent(8));
    tracker.onRecord(8, sendMessage('nadie', 'x'));
    expect(sent).toEqual([]);
  });
});
