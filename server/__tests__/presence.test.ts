/**
 * The living office's lifecycle (docs/adr/0003, plan T19): finishing is not
 * leaving. A derived agent is `working`, `available` once it finished (its
 * parent may resume it), `lounge` after a while available, and `leaving` only
 * on a real exit signal — after which it is removed whatever the clients do.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookProvider } from '../../core/src/provider.js';
import type { TeamProvider } from '../../core/src/teamProvider.js';
import { agentCreatedMessage, agentTreeMeta } from '../src/agentMessages.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { handleClientMessage } from '../src/clientMessageHandler.js';
import {
  IDLE_TO_LOUNGE_MINUTES_MAX,
  IDLE_TO_LOUNGE_MINUTES_MIN,
  IDLE_TO_LOUNGE_MS_DEFAULT,
  LEAVE_ANIMATION_MAX_MS,
  LEAVE_QUEUE_MAX_MS,
  LEAVE_STAGGER_MS,
  LOUNGE_TO_LEAVE_MINUTES_MAX,
  LOUNGE_TO_LEAVE_MINUTES_MIN,
  LOUNGE_TO_LEAVE_MS_DEFAULT,
  MAX_DERIVED_AGENTS_PER_TREE,
  PRESENCE_TICK_MS,
  TEXT_IDLE_DELAY_MS,
} from '../src/constants.js';
import { readNewLines, scanAllTeammateFiles, scanSpawnTree } from '../src/fileWatcher.js';
import { finishedPresence, PresenceTracker } from '../src/presence.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { claudeTeamProvider } from '../src/providers/hook/claude/claudeTeamProvider.js';
import {
  discoverClaudeWorkflowAgents,
  extractClaudeWorkflowLaunch,
} from '../src/providers/hook/claude/claudeWorkflow.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

const LEAD_SESSION = '3e007f79-d1f2-4c65-81d0-7c5acbf43666';

function agentShell(id: number, overrides: Partial<AgentState> = {}): AgentState {
  return {
    id,
    sessionId: LEAD_SESSION,
    terminalRef: undefined,
    isExternal: false,
    projectDir: '',
    jsonlFile: '',
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
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

function presenceMessages(messages: Array<Record<string, unknown>>, id?: number): string[] {
  return messages
    .filter((m) => m.type === 'agentPresence' && (id === undefined || m.id === id))
    .map((m) => `${m.id}:${m.presence}`);
}

// ── PresenceTracker on its own ─────────────────────────────────

describe('PresenceTracker', () => {
  let store: AgentStateStore;
  let messages: Array<Record<string, unknown>>;
  let removed: number[];
  let now: number;
  let tracker: PresenceTracker;
  let idleMs: number;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new AgentStateStore();
    messages = [];
    removed = [];
    now = 1_000_000;
    idleMs = 60_000;
    store.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
    store.set(1, agentShell(1));
    store.set(2, agentShell(2, { parentAgentId: 1, presence: 'working' }));
    store.set(3, agentShell(3, { parentAgentId: 2, presence: 'working' }));
    store.set(4, agentShell(4, { parentAgentId: 3, presence: 'working' }));
    tracker = new PresenceTracker(store, {
      idleToLoungeMs: () => idleMs,
      now: () => now,
      remove: (id) => {
        removed.push(id);
        store.delete(id);
      },
    });
  });

  afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
  });

  it('available, then lounge after the idle time, then working on activity', () => {
    tracker.markAvailable(2);
    expect(store.get(2)).toMatchObject({ presence: 'available', availableSince: now });
    now += idleMs - 1;
    tracker.tick();
    expect(store.get(2)!.presence).toBe('available');
    now += 1;
    tracker.tick();
    expect(store.get(2)!.presence).toBe('lounge');
    tracker.markActivity(2);
    expect(store.get(2)).toMatchObject({ presence: 'working', availableSince: undefined });
    expect(presenceMessages(messages)).toEqual(['2:available', '2:lounge', '2:working']);
  });

  it('a repeated finish keeps the original availability (and a lounging agent stays there)', () => {
    tracker.markAvailable(2);
    const since = store.get(2)!.availableSince;
    now += 10;
    tracker.markAvailable(2);
    expect(store.get(2)!.availableSince).toBe(since);
    now += idleMs;
    tracker.tick();
    tracker.markAvailable(2);
    expect(store.get(2)!.presence).toBe('lounge');
    expect(presenceMessages(messages)).toEqual(['2:available', '2:lounge']);
  });

  it('follows the store: agentStatus active/waiting and permission bubbles drive it', () => {
    store.broadcast({ type: 'agentStatus', id: 2, status: 'waiting', awaitingInput: false });
    expect(store.get(2)!.presence).toBe('available');
    store.broadcast({ type: 'agentToolPermission', id: 2 });
    expect(store.get(2)!.presence).toBe('working');
    store.broadcast({ type: 'agentStatus', id: 2, status: 'waiting', awaitingInput: false });
    store.broadcast({ type: 'agentStatus', id: 2, status: 'active' });
    expect(store.get(2)!.presence).toBe('working');
  });

  it('session roots have no presence: they keep their own (matrix) lifecycle', () => {
    tracker.markAvailable(1);
    tracker.markActivity(1);
    tracker.beginLeave([1]);
    expect(store.get(1)!.presence).toBeUndefined();
    vi.advanceTimersByTime(LEAVE_ANIMATION_MAX_MS * 2);
    expect(removed).toEqual([]);
    expect(presenceMessages(messages)).toEqual([]);
  });

  it('leaves in the given order, staggered, and removes each after the animation cap', () => {
    tracker.beginLeave([4, 3, 2]);
    // All three are committed to leaving at once (nothing can revert them)…
    expect([2, 3, 4].map((id) => store.get(id)!.presence)).toEqual([
      'leaving',
      'leaving',
      'leaving',
    ]);
    // …but they walk out one by one.
    expect(presenceMessages(messages)).toEqual(['4:leaving']);
    vi.advanceTimersByTime(LEAVE_STAGGER_MS);
    expect(presenceMessages(messages)).toEqual(['4:leaving', '3:leaving']);
    vi.advanceTimersByTime(LEAVE_STAGGER_MS);
    expect(presenceMessages(messages)).toEqual(['4:leaving', '3:leaving', '2:leaving']);
    expect(removed).toEqual([]);
    vi.advanceTimersByTime(LEAVE_ANIMATION_MAX_MS - 2 * LEAVE_STAGGER_MS);
    expect(removed).toEqual([4]);
    vi.advanceTimersByTime(2 * LEAVE_STAGGER_MS);
    expect(removed).toEqual([4, 3, 2]);
  });

  it('leaving cannot be reverted by activity, availability or the lounge clock', () => {
    tracker.markAvailable(2);
    tracker.beginLeave([2]);
    tracker.markActivity(2);
    tracker.markAvailable(2);
    now += idleMs * 10;
    tracker.tick();
    store.broadcast({ type: 'agentStatus', id: 2, status: 'active' });
    expect(store.get(2)!.presence).toBe('leaving');
    // A second exit signal does not schedule a second departure.
    tracker.beginLeave([2]);
    vi.advanceTimersByTime(LEAVE_ANIMATION_MAX_MS * 3);
    expect(removed).toEqual([2]);
  });

  it('a burst never queues a departure longer than LEAVE_QUEUE_MAX_MS', () => {
    for (let id = 10; id < 60; id++) store.set(id, agentShell(id, { parentAgentId: 1 }));
    const ids = Array.from({ length: 50 }, (_, i) => 10 + i);
    tracker.beginLeave(ids);
    tracker.beginLeave([2]);
    vi.advanceTimersByTime(LEAVE_QUEUE_MAX_MS);
    expect(presenceMessages(messages).filter((m) => m.endsWith('leaving'))).toHaveLength(51);
    vi.advanceTimersByTime(LEAVE_ANIMATION_MAX_MS);
    expect(removed).toHaveLength(51);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('back-to-back exits queue behind each other instead of overlapping', () => {
    tracker.beginLeave([4]);
    tracker.beginLeave([3]);
    expect(presenceMessages(messages)).toEqual(['4:leaving']);
    vi.advanceTimersByTime(LEAVE_STAGGER_MS);
    expect(presenceMessages(messages)).toEqual(['4:leaving', '3:leaving']);
  });

  it('an agent removed some other way drops its pending departure (no leaked timers)', () => {
    tracker.beginLeave([4, 3]);
    store.delete(3);
    store.delete(4);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(LEAVE_ANIMATION_MAX_MS * 2);
    expect(removed).toEqual([]);
  });

  it('dispose cancels every pending departure and the lounge clock', () => {
    tracker.markAvailable(2);
    tracker.beginLeave([4, 3]);
    tracker.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(LEAVE_ANIMATION_MAX_MS * 2);
    expect(removed).toEqual([]);
  });

  it('ticks by itself only while someone is available or resting', () => {
    expect(vi.getTimerCount()).toBe(0);
    tracker.markAvailable(4);
    expect(vi.getTimerCount()).toBe(1);
    now += idleMs;
    vi.advanceTimersByTime(PRESENCE_TICK_MS);
    expect(store.get(4)!.presence).toBe('lounge');
    // Still resting: the clock keeps running for its exit.
    expect(vi.getTimerCount()).toBe(1);
    tracker.markActivity(4);
    vi.advanceTimersByTime(PRESENCE_TICK_MS);
    // Nobody left to send to the lounge or out: the clock stops.
    expect(vi.getTimerCount()).toBe(0);
  });

  // ── Unused rest ends too (T24) ──

  function trackerWithLeave(leaveMs: number): PresenceTracker {
    tracker.dispose();
    tracker = new PresenceTracker(store, {
      idleToLoungeMs: () => idleMs,
      loungeToLeaveMs: () => leaveMs,
      now: () => now,
      remove: (id) => {
        removed.push(id);
        store.delete(id);
      },
    });
    return tracker;
  }

  it('(a) resting LOUNGE_TO_LEAVE_MS unused: it says goodbye, walks out and is removed', () => {
    const leaveMs = 120_000;
    trackerWithLeave(leaveMs);
    tracker.markAvailable(4);
    now += idleMs;
    tracker.tick();
    expect(store.get(4)!.presence).toBe('lounge');
    now += leaveMs - 1;
    tracker.tick();
    expect(store.get(4)!.presence).toBe('lounge');
    now += 1;
    tracker.tick();
    expect(store.get(4)!.presence).toBe('leaving');
    expect(presenceMessages(messages, 4)).toEqual(['4:available', '4:lounge', '4:leaving']);
    vi.advanceTimersByTime(LEAVE_ANIMATION_MAX_MS);
    expect(removed).toEqual([4]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('(b) resumed in the lounge before the limit it works again, with both clocks restarted', () => {
    const leaveMs = 120_000;
    trackerWithLeave(leaveMs);
    tracker.markAvailable(4);
    now += idleMs;
    tracker.tick();
    now += leaveMs - 1000;
    tracker.markActivity(4);
    expect(store.get(4)).toMatchObject({ presence: 'working', availableSince: undefined });
    // Finishes again: a full idle period at the desk, then a full rest.
    tracker.markAvailable(4);
    now += idleMs - 1;
    tracker.tick();
    expect(store.get(4)!.presence).toBe('available');
    now += 1;
    tracker.tick();
    expect(store.get(4)!.presence).toBe('lounge');
    now += leaveMs - 1;
    tracker.tick();
    expect(store.get(4)!.presence).toBe('lounge');
    now += 1;
    tracker.tick();
    expect(store.get(4)!.presence).toBe('leaving');
  });

  it('a rester leaves with its subtree, leaves first', () => {
    const leaveMs = 120_000;
    trackerWithLeave(leaveMs);
    for (const id of [4, 3, 2]) tracker.markAvailable(id);
    now += idleMs + leaveMs;
    tracker.tick();
    expect([2, 3, 4].map((id) => store.get(id)!.presence)).toEqual([
      'leaving',
      'leaving',
      'leaving',
    ]);
    vi.advanceTimersByTime(2 * LEAVE_STAGGER_MS + LEAVE_ANIMATION_MAX_MS);
    expect(removed).toEqual([4, 3, 2]);
  });

  it('a rester whose subtree still works waits for it (nobody leaves mid-task)', () => {
    const leaveMs = 120_000;
    trackerWithLeave(leaveMs);
    tracker.markAvailable(3);
    now += idleMs + leaveMs;
    tracker.tick();
    // 4 (below 3) is still working: 3 keeps resting, 4 keeps working.
    expect(store.get(3)!.presence).toBe('lounge');
    expect(store.get(4)!.presence).toBe('working');
    tracker.markAvailable(4);
    now += idleMs + leaveMs;
    tracker.tick();
    expect(store.get(3)!.presence).toBe('leaving');
    expect(store.get(4)!.presence).toBe('leaving');
  });

  it('born resting (finished long ago): its exit counts from its real finish time', () => {
    const leaveMs = 120_000;
    trackerWithLeave(leaveMs);
    const finishedAt = now - idleMs - 30_000;
    store.set(
      9,
      agentShell(9, { parentAgentId: 1, presence: 'lounge', availableSince: finishedAt }),
    );
    expect(vi.getTimerCount()).toBe(1);
    now = finishedAt + idleMs + leaveMs - 1;
    tracker.tick();
    expect(store.get(9)!.presence).toBe('lounge');
    now += 1;
    tracker.tick();
    expect(store.get(9)!.presence).toBe('leaving');
    // Old replayed activity does not wake it (it is finished)…
    store.set(
      10,
      agentShell(10, { parentAgentId: 1, presence: 'lounge', availableSince: finishedAt }),
    );
    store.broadcast({ type: 'agentStatus', id: 10, status: 'active' });
    expect(store.get(10)!.presence).toBe('lounge');
    // …a prompt written after its finish does.
    expect(tracker.markPrompted(10, finishedAt + 1)).toBe(true);
    expect(store.get(10)!.presence).toBe('working');
  });

  it('the lounge-to-leave delay defaults to LOUNGE_TO_LEAVE_MS_DEFAULT', () => {
    tracker.markAvailable(4);
    now += idleMs + LOUNGE_TO_LEAVE_MS_DEFAULT - 1;
    tracker.tick();
    tracker.tick();
    expect(store.get(4)!.presence).toBe('lounge');
    now += 1;
    tracker.tick();
    expect(store.get(4)!.presence).toBe('leaving');
  });
});

describe('finishedPresence (reappearance window)', () => {
  const timings = { idleToLoungeMs: 30 * 60_000, loungeToLeaveMs: 60 * 60_000 };
  const now = 10_000_000_000;
  it('desk inside the idle window, lounge after it, gone past both', () => {
    expect(finishedPresence(now - 10 * 60_000, now, timings)).toBe('available');
    expect(finishedPresence(now - 45 * 60_000, now, timings)).toBe('lounge');
    expect(finishedPresence(now - 90 * 60_000, now, timings)).toBeUndefined();
    expect(finishedPresence(now - 120 * 60_000, now, timings)).toBeUndefined();
  });
  it('a finish time in the future counts as now (a skewed or forged mtime buys no extra stay)', () => {
    expect(finishedPresence(now + 365 * 24 * 3600_000, now, timings)).toBe('available');
  });
});

// ── The runtime's lifecycle rules ──────────────────────────────

function toolUse(toolId: string, name: string, input: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolId, name, input }] },
  });
}

function spawnToolUse(toolId: string, input: Record<string, unknown> = {}): string {
  return toolUse(toolId, 'Agent', { description: 'do work', subagent_type: 'x', ...input });
}

function toolResult(toolId: string, text = 'Here is my report.'): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: text }] },
  });
}

function asyncLaunchResult(toolId: string, key: string): string {
  return toolResult(
    toolId,
    `Async agent launched successfully.\nagentId: ${key} (internal ID - do not mention to user.)`,
  );
}

function notice(opts: { taskId?: string; toolUseId?: string; status?: string }): string {
  const parts = ['<task-notification>'];
  if (opts.taskId) parts.push(`<task-id>${opts.taskId}</task-id>`);
  if (opts.toolUseId) parts.push(`<tool-use-id>${opts.toolUseId}</tool-use-id>`);
  if (opts.status) parts.push(`<status>${opts.status}</status>`);
  parts.push('<summary>Agent "x" finished</summary>', '</task-notification>');
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    content: parts.join('\n'),
  });
}

function userPrompt(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

describe('living office lifecycle (runtime)', () => {
  let tmpRoot: string;
  let subagentsDir: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let lead: AgentState;
  let messages: Array<Record<string, unknown>>;
  let discoverCalls: number;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-presence-'));
    subagentsDir = path.join(tmpRoot, LEAD_SESSION, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    discoverCalls = 0;
    const team: TeamProvider = {
      ...claudeTeamProvider,
      discoverTeammates: (...args) => {
        discoverCalls++;
        return claudeTeamProvider.discoverTeammates(...args);
      },
      extractWorkflowLaunch: extractClaudeWorkflowLaunch,
      discoverWorkflowAgents: discoverClaudeWorkflowAgents,
    };
    const provider: HookProvider = { ...claudeProvider, team };
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, provider);
    lead = agentShell(1, {
      projectDir: tmpRoot,
      jsonlFile: path.join(tmpRoot, `${LEAD_SESSION}.jsonl`),
      isExternal: true,
      palette: 2,
      hueShift: 0,
    });
    store.set(1, lead);
    store.nextAgentId.current = 2;
    messages = [];
    store.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
  });

  afterEach(() => {
    runtime.dispose();
    vi.useRealTimers();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeSidecar(key: string, meta: Record<string, unknown>, lines: string[] = []): void {
    fs.writeFileSync(
      path.join(subagentsDir, `agent-${key}.jsonl`),
      lines.length > 0 ? lines.join('\n') + '\n' : '',
    );
    fs.writeFileSync(path.join(subagentsDir, `agent-${key}.meta.json`), JSON.stringify(meta));
  }

  function appendLine(key: string, line: string): void {
    fs.appendFileSync(path.join(subagentsDir, `agent-${key}.jsonl`), line + '\n');
    readNewLines(byKey(key).id, store, runtime.waitingTimers, runtime.permissionTimers);
  }

  function byKey(key: string): AgentState {
    const found = maybeByKey(key);
    if (!found) throw new Error(`no agent for key ${key}`);
    return found;
  }

  function maybeByKey(key: string): AgentState | undefined {
    return [...store.values()].find((a) => a.spawnAgentKey === key);
  }

  function lineOf(id: number, line: string): void {
    processTranscriptLine(id, line, store, runtime.waitingTimers, runtime.permissionTimers);
  }

  function leadLine(line: string): void {
    lineOf(1, line);
  }

  function scan(rootId = 1): void {
    scanSpawnTree(
      rootId,
      store,
      store.nextAgentId,
      runtime.fileWatchers,
      runtime.pollingTimers,
      runtime.waitingTimers,
      runtime.permissionTimers,
    );
  }

  /** lead → aaa (background) → bbb → ccc (both foreground, still open). */
  function backgroundTree(): void {
    leadLine(spawnToolUse('toolu_L'));
    writeSidecar('aaa', { agentType: 'lider-fase', toolUseId: 'toolu_L', spawnDepth: 1 });
    scan();
    leadLine(asyncLaunchResult('toolu_L', 'aaa'));
    appendLine('aaa', spawnToolUse('toolu_A'));
    writeSidecar('bbb', {
      agentType: 'desarrollador',
      toolUseId: 'toolu_A',
      parentAgentId: 'aaa',
      spawnDepth: 2,
    });
    scan();
    appendLine('bbb', spawnToolUse('toolu_B'));
    writeSidecar('ccc', {
      agentType: 'qa-revisor',
      toolUseId: 'toolu_B',
      parentAgentId: 'bbb',
      spawnDepth: 3,
    });
    scan();
    expect(byKey('ccc').parentAgentId).toBe(byKey('bbb').id);
  }

  /** Two background children of the lead: aaa and sib. */
  function twoBackgroundChildren(): void {
    leadLine(spawnToolUse('toolu_L'));
    leadLine(spawnToolUse('toolu_S'));
    writeSidecar('aaa', { agentType: 'dev', toolUseId: 'toolu_L', spawnDepth: 1 });
    writeSidecar('sib', { agentType: 'dev', toolUseId: 'toolu_S', spawnDepth: 1 });
    scan();
    leadLine(asyncLaunchResult('toolu_L', 'aaa'));
    leadLine(asyncLaunchResult('toolu_S', 'sib'));
  }

  it('a derived agent is born working; the root has no presence', () => {
    twoBackgroundChildren();
    expect(byKey('aaa').presence).toBe('working');
    expect(lead.presence).toBeUndefined();
  });

  // (a)
  it('(a) completed does not remove the agent: it becomes available and its spawn stays live', () => {
    twoBackgroundChildren();
    const aaa = byKey('aaa');
    leadLine(notice({ taskId: 'aaa', status: 'completed' }));
    expect(store.get(aaa.id)).toBe(aaa);
    expect(aaa.presence).toBe('available');
    expect(presenceMessages(messages, aaa.id)).toEqual([`${aaa.id}:available`]);
    // Still a live spawn of the lead: resumable, and a rescan never duplicates it.
    expect(lead.backgroundAgentToolIds.has('toolu_L')).toBe(true);
    scan();
    expect([...store.values()].filter((a) => a.spawnAgentKey === 'aaa')).toHaveLength(1);
    // The lead no longer runs it as a tool.
    expect(lead.activeToolIds.has('toolu_L')).toBe(false);
  });

  it('(a) failed and legacy notices without a status also leave it available', () => {
    twoBackgroundChildren();
    leadLine(notice({ toolUseId: 'toolu_L', status: 'failed' }));
    leadLine(notice({ toolUseId: 'toolu_S' }));
    expect(byKey('aaa').presence).toBe('available');
    expect(byKey('sib').presence).toBe('available');
  });

  // (b)
  it('(b) resumed with SendMessage it works again, and a repeated completed only makes it available', () => {
    twoBackgroundChildren();
    const aaa = byKey('aaa');
    leadLine(notice({ taskId: 'aaa', toolUseId: 'toolu_L', status: 'completed' }));
    leadLine(toolUse('toolu_SM', 'SendMessage', { to: 'aaa', message: 'one more thing' }));
    appendLine('aaa', userPrompt('one more thing'));
    expect(aaa.presence).toBe('working');
    appendLine('aaa', toolUse('toolu_x', 'Bash', { command: 'ls' }));
    expect(aaa.presence).toBe('working');
    // The CLI names the SendMessage call in <tool-use-id>; <task-id> still names the agent.
    leadLine(notice({ taskId: 'aaa', toolUseId: 'toolu_SM', status: 'completed' }));
    expect(store.get(aaa.id)).toBe(aaa);
    expect(aaa.presence).toBe('available');
    expect(presenceMessages(messages, aaa.id)).toEqual([
      `${aaa.id}:available`,
      `${aaa.id}:working`,
      `${aaa.id}:available`,
    ]);
  });

  // (c)
  it('(c) killed walks the agent and its subtree out, leaves first and staggered, then removes them', () => {
    backgroundTree();
    const [aaa, bbb, ccc] = ['aaa', 'bbb', 'ccc'].map(byKey);
    leadLine(notice({ taskId: 'aaa', status: 'killed' }));
    expect([aaa, bbb, ccc].map((a) => a.presence)).toEqual(['leaving', 'leaving', 'leaving']);
    expect(presenceMessages(messages).filter((m) => m.endsWith('leaving'))).toEqual([
      `${ccc.id}:leaving`,
    ]);
    vi.advanceTimersByTime(2 * LEAVE_STAGGER_MS);
    expect(presenceMessages(messages).filter((m) => m.endsWith('leaving'))).toEqual([
      `${ccc.id}:leaving`,
      `${bbb.id}:leaving`,
      `${aaa.id}:leaving`,
    ]);
    // The spawn is over: no longer live on the lead.
    expect(lead.backgroundAgentToolIds.has('toolu_L')).toBe(false);
    expect(store.get(aaa.id)).toBe(aaa);
    vi.advanceTimersByTime(LEAVE_ANIMATION_MAX_MS);
    for (const a of [aaa, bbb, ccc]) expect(store.get(a.id)).toBeUndefined();
    expect(store.get(1)).toBe(lead);
    // Nothing comes back on the next scan.
    scan();
    expect(maybeByKey('aaa')).toBeUndefined();
  });

  it('(c) stopped also ends it; a leaving agent stops being read', () => {
    twoBackgroundChildren();
    const aaa = byKey('aaa');
    leadLine(notice({ toolUseId: 'toolu_L', status: 'stopped' }));
    expect(aaa.presence).toBe('leaving');
    expect(runtime.pollingTimers.has(aaa.id)).toBe(false);
    expect(byKey('sib').presence).toBe('working');
  });

  // (d)
  it('(d) a TaskStop naming the child key walks only that child out', () => {
    twoBackgroundChildren();
    const aaa = byKey('aaa');
    const sib = byKey('sib');
    leadLine(toolUse('toolu_stop', 'TaskStop', { task_id: 'aaa' }));
    // Acted on once the CLI carried it out (its result), not on the call.
    expect(aaa.presence).toBe('working');
    leadLine(toolResult('toolu_stop', 'Successfully stopped task aaa'));
    expect(aaa.presence).toBe('leaving');
    expect(sib.presence).toBe('working');
    expect(lead.backgroundAgentToolIds.has('toolu_L')).toBe(false);
    expect(lead.backgroundAgentToolIds.has('toolu_S')).toBe(true);
    vi.advanceTimersByTime(LEAVE_ANIMATION_MAX_MS);
    expect(store.get(aaa.id)).toBeUndefined();
    expect(store.get(sib.id)).toBe(sib);
  });

  it('(d) a TaskStop also stops an available (completed) child', () => {
    twoBackgroundChildren();
    leadLine(notice({ taskId: 'aaa', status: 'completed' }));
    leadLine(toolUse('toolu_stop', 'TaskStop', { task_id: 'aaa' }));
    leadLine(toolResult('toolu_stop', 'stopped'));
    expect(byKey('aaa').presence).toBe('leaving');
  });

  it('(d) a denied or failed TaskStop leaves the task running', () => {
    twoBackgroundChildren();
    leadLine(toolUse('toolu_stop', 'TaskStop', { task_id: 'aaa' }));
    leadLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_stop',
              is_error: true,
              content: "The user doesn't want to proceed with this tool use.",
            },
          ],
        },
      }),
    );
    expect(byKey('aaa').presence).toBe('working');
    expect(lead.backgroundAgentToolIds.has('toolu_L')).toBe(true);
    // Its real completion still finds it.
    leadLine(notice({ taskId: 'aaa', status: 'completed' }));
    expect(byKey('aaa').presence).toBe('available');
  });

  // (e)
  it('(e) a TaskStop with a foreign or unknown task id does nothing', () => {
    twoBackgroundChildren();
    // Another root session with its own child "zzz".
    const otherDir = path.join(tmpRoot, 'other-session', 'subagents');
    fs.mkdirSync(otherDir, { recursive: true });
    const other = agentShell(50, {
      sessionId: 'other-session',
      projectDir: tmpRoot,
      jsonlFile: path.join(tmpRoot, 'other-session.jsonl'),
      isExternal: true,
    });
    store.set(50, other);
    lineOf(50, spawnToolUse('toolu_O'));
    fs.writeFileSync(path.join(otherDir, 'agent-zzz.jsonl'), '');
    fs.writeFileSync(
      path.join(otherDir, 'agent-zzz.meta.json'),
      JSON.stringify({ agentType: 'x', toolUseId: 'toolu_O', spawnDepth: 1 }),
    );
    scan(50);
    lineOf(50, asyncLaunchResult('toolu_O', 'zzz'));
    const zzz = byKey('zzz');
    expect(zzz.parentAgentId).toBe(50);

    // The lead stops a task that is not its own: another root's child, a
    // grandchild of its own tree, and an unknown id.
    leadLine(toolUse('toolu_s1', 'TaskStop', { task_id: 'zzz' }));
    leadLine(toolUse('toolu_s2', 'TaskStop', { task_id: 'nope' }));
    leadLine(toolUse('toolu_s3', 'TaskStop', { task_id: '../aaa' }));
    for (const id of ['toolu_s1', 'toolu_s2', 'toolu_s3']) leadLine(toolResult(id, 'ok'));
    expect(zzz.presence).toBe('working');
    expect(other.backgroundAgentToolIds.has('toolu_O')).toBe(true);
    expect(byKey('aaa').presence).toBe('working');
    expect(byKey('sib').presence).toBe('working');
    // A killed notice on the lead naming the other root's child is inert too.
    leadLine(notice({ taskId: 'zzz', status: 'killed' }));
    expect(zzz.presence).toBe('working');
  });

  it('(e) a TaskStop by a child for its SIBLING key does nothing (only its own spawns)', () => {
    twoBackgroundChildren();
    lineOf(byKey('aaa').id, toolUse('toolu_x', 'TaskStop', { task_id: 'sib' }));
    lineOf(byKey('aaa').id, toolResult('toolu_x', 'ok'));
    expect(byKey('sib').presence).toBe('working');
  });

  // (f)
  it('(f) available long enough goes to the lounge; activity brings it back to work', () => {
    twoBackgroundChildren();
    runtime.setIdleToLoungeMinutes(1);
    const aaa = byKey('aaa');
    leadLine(notice({ taskId: 'aaa', status: 'completed' }));
    vi.advanceTimersByTime(60_000 - PRESENCE_TICK_MS);
    expect(aaa.presence).toBe('available');
    vi.advanceTimersByTime(PRESENCE_TICK_MS);
    expect(aaa.presence).toBe('lounge');
    appendLine('aaa', userPrompt('wake up'));
    expect(aaa.presence).toBe('working');
  });

  it('(f) the lounge delay defaults to IDLE_TO_LOUNGE_MS_DEFAULT', () => {
    expect(runtime.idleToLoungeMs()).toBe(IDLE_TO_LOUNGE_MS_DEFAULT);
    runtime.setIdleToLoungeMinutes(IDLE_TO_LOUNGE_MINUTES_MAX + 50);
    expect(runtime.idleToLoungeMs()).toBe(IDLE_TO_LOUNGE_MINUTES_MAX * 60_000);
    runtime.setIdleToLoungeMinutes(0);
    expect(runtime.idleToLoungeMs()).toBe(IDLE_TO_LOUNGE_MINUTES_MIN * 60_000);
  });

  // T24: unused rest ends too
  it('the lounge-to-leave delay defaults, clamps, and every change broadcasts the effective timings', () => {
    expect(runtime.loungeToLeaveMs()).toBe(LOUNGE_TO_LEAVE_MS_DEFAULT);
    expect(runtime.setLoungeToLeaveMinutes(LOUNGE_TO_LEAVE_MINUTES_MAX + 50)).toBe(
      LOUNGE_TO_LEAVE_MINUTES_MAX,
    );
    expect(runtime.loungeToLeaveMs()).toBe(LOUNGE_TO_LEAVE_MINUTES_MAX * 60_000);
    runtime.setLoungeToLeaveMinutes(0);
    expect(runtime.loungeToLeaveMs()).toBe(LOUNGE_TO_LEAVE_MINUTES_MIN * 60_000);
    runtime.setLoungeToLeaveMinutes(Number.NaN); // junk changes nothing
    expect(runtime.loungeToLeaveMs()).toBe(LOUNGE_TO_LEAVE_MINUTES_MIN * 60_000);
    runtime.setIdleToLoungeMinutes(12);
    expect(messages.filter((m) => m.type === 'livingOfficeSettings')).toEqual([
      {
        type: 'livingOfficeSettings',
        idleToLoungeMinutes: IDLE_TO_LOUNGE_MS_DEFAULT / 60_000,
        loungeToLeaveMinutes: LOUNGE_TO_LEAVE_MINUTES_MAX,
      },
      {
        type: 'livingOfficeSettings',
        idleToLoungeMinutes: IDLE_TO_LOUNGE_MS_DEFAULT / 60_000,
        loungeToLeaveMinutes: LOUNGE_TO_LEAVE_MINUTES_MIN,
      },
      {
        type: 'livingOfficeSettings',
        idleToLoungeMinutes: 12,
        loungeToLeaveMinutes: LOUNGE_TO_LEAVE_MINUTES_MIN,
      },
    ]);
  });

  it('(f) a parent resting unused leaves with its finished children, leaves first, and its spawn ends', () => {
    runtime.setIdleToLoungeMinutes(1);
    runtime.setLoungeToLeaveMinutes(2);
    leadLine(spawnToolUse('toolu_L'));
    writeSidecar('aaa', { agentType: 'lider-fase', toolUseId: 'toolu_L', spawnDepth: 1 });
    scan();
    leadLine(asyncLaunchResult('toolu_L', 'aaa'));
    appendLine('aaa', spawnToolUse('toolu_A'));
    writeSidecar('bbb', {
      agentType: 'desarrollador',
      toolUseId: 'toolu_A',
      parentAgentId: 'aaa',
      spawnDepth: 2,
    });
    scan();
    appendLine('aaa', asyncLaunchResult('toolu_A', 'bbb'));
    const [aaa, bbb] = ['aaa', 'bbb'].map(byKey);
    expect(bbb.parentAgentId).toBe(aaa.id);
    appendLine('aaa', notice({ taskId: 'bbb', status: 'completed' }));
    leadLine(notice({ taskId: 'aaa', status: 'completed' }));
    expect([aaa.presence, bbb.presence]).toEqual(['available', 'available']);
    vi.advanceTimersByTime(60_000);
    expect([aaa.presence, bbb.presence]).toEqual(['lounge', 'lounge']);
    vi.advanceTimersByTime(2 * 60_000 - PRESENCE_TICK_MS);
    expect([aaa.presence, bbb.presence]).toEqual(['lounge', 'lounge']);
    vi.advanceTimersByTime(PRESENCE_TICK_MS);
    expect([aaa.presence, bbb.presence]).toEqual(['leaving', 'leaving']);
    expect(presenceMessages(messages).filter((m) => m.endsWith('leaving'))).toEqual([
      `${bbb.id}:leaving`,
    ]);
    vi.advanceTimersByTime(LEAVE_STAGGER_MS);
    expect(presenceMessages(messages).filter((m) => m.endsWith('leaving'))).toEqual([
      `${bbb.id}:leaving`,
      `${aaa.id}:leaving`,
    ]);
    // Its spawn is over: nothing re-materializes it.
    expect(lead.backgroundAgentToolIds.has('toolu_L')).toBe(false);
    vi.advanceTimersByTime(LEAVE_ANIMATION_MAX_MS);
    scan();
    expect(maybeByKey('aaa')).toBeUndefined();
    expect(maybeByKey('bbb')).toBeUndefined();
  });

  it('a spawn that finished longer ago than both windows is not materialized (and stops being live)', () => {
    leadLine(spawnToolUse('toolu_L'));
    leadLine(asyncLaunchResult('toolu_L', 'aaa'));
    leadLine(notice({ taskId: 'aaa', status: 'completed' }));
    writeSidecar('aaa', { agentType: 'dev', toolUseId: 'toolu_L', spawnDepth: 1 });
    const old = new Date(
      Date.now() - IDLE_TO_LOUNGE_MS_DEFAULT - LOUNGE_TO_LEAVE_MS_DEFAULT - 1000,
    );
    fs.utimesSync(path.join(subagentsDir, 'agent-aaa.jsonl'), old, old);
    scan();
    expect(maybeByKey('aaa')).toBeUndefined();
    expect(lead.backgroundAgentToolIds.has('toolu_L')).toBe(false);
    const before = discoverCalls;
    scan();
    expect(discoverCalls).toBe(before);
  });

  // (g)
  it('(g) the root session ending walks every derived agent out, then removes them', () => {
    backgroundTree();
    const ids = ['ccc', 'bbb', 'aaa'].map((k) => byKey(k).id);
    runtime.registerAgent(LEAD_SESSION, 1);
    lead.isExternal = false; // a terminal agent: the root itself stays
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: LEAD_SESSION,
      reason: 'exit',
    });
    for (const id of ids) expect(store.get(id)!.presence).toBe('leaving');
    vi.advanceTimersByTime(ids.length * LEAVE_STAGGER_MS + LEAVE_ANIMATION_MAX_MS);
    expect([...store.values()].filter((a) => a.parentAgentId !== undefined)).toEqual([]);
    expect(store.get(1)).toBe(lead);
  });

  it('(g) an external root removed at session end goes now; its tree still walks out', () => {
    backgroundTree();
    const ids = ['ccc', 'bbb', 'aaa'].map((k) => byKey(k).id);
    runtime.registerAgent(LEAD_SESSION, 1);
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: LEAD_SESSION,
      reason: 'exit',
    });
    expect(store.get(1)).toBeUndefined();
    for (const id of ids) expect(store.get(id)?.presence).toBe('leaving');
    vi.advanceTimersByTime(ids.length * LEAVE_STAGGER_MS + LEAVE_ANIMATION_MAX_MS);
    expect(store.size).toBe(0);
  });

  it('(g) the user closing a derived agent walks it (and its subtree) out', () => {
    backgroundTree();
    const bbb = byKey('bbb');
    const ccc = byKey('ccc');
    runtime.closeAgent(bbb.id);
    expect(bbb.presence).toBe('leaving');
    expect(ccc.presence).toBe('leaving');
    expect(byKey('aaa').presence).toBe('working');
    vi.advanceTimersByTime(LEAVE_STAGGER_MS + LEAVE_ANIMATION_MAX_MS);
    expect(maybeByKey('bbb')).toBeUndefined();
    expect(maybeByKey('ccc')).toBeUndefined();
  });

  it('(g) closeAgent from the office UI walks a derived agent out instead of removing it', () => {
    // The wire path (clientMessageHandler), not just the runtime method.
    backgroundTree();
    const bbb = byKey('bbb');
    handleClientMessage({ type: 'closeAgent', id: bbb.id }, () => {}, {
      store,
      runtime,
      cache: null,
    });
    expect(store.get(bbb.id)?.presence).toBe('leaving');
    vi.advanceTimersByTime(2 * LEAVE_STAGGER_MS + LEAVE_ANIMATION_MAX_MS);
    expect(maybeByKey('bbb')).toBeUndefined();
  });

  it('(g) the user closing a root removes it now and walks its tree out', () => {
    backgroundTree();
    runtime.closeAgent(1);
    expect(store.get(1)).toBeUndefined();
    expect(byKey('aaa').presence).toBe('leaving');
    vi.advanceTimersByTime(3 * LEAVE_STAGGER_MS + LEAVE_ANIMATION_MAX_MS);
    expect(store.size).toBe(0);
  });

  // (h)
  it('(h) a foreground spawn result walks its agent out (it cannot be resumed)', () => {
    leadLine(spawnToolUse('toolu_F'));
    writeSidecar('fff', { agentType: 'Explore', toolUseId: 'toolu_F', spawnDepth: 1 });
    scan();
    const fff = byKey('fff');
    leadLine(toolResult('toolu_F'));
    expect(fff.presence).toBe('leaving');
    expect(store.get(fff.id)).toBe(fff);
    vi.advanceTimersByTime(LEAVE_ANIMATION_MAX_MS);
    expect(store.get(fff.id)).toBeUndefined();
  });

  it('(h) a foreground spawn dropped at turn end walks its agent out too', () => {
    leadLine(spawnToolUse('toolu_F'));
    writeSidecar('fff', { agentType: 'Explore', toolUseId: 'toolu_F', spawnDepth: 1 });
    scan();
    leadLine(JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 5 }));
    expect(byKey('fff').presence).toBe('leaving');
  });

  // (i)
  it('(i) a completed workflow walks its agents out first, then its node', () => {
    const runDir = path.join(subagentsDir, 'workflows', 'wf_run-1');
    fs.mkdirSync(runDir, { recursive: true });
    leadLine(
      toolUse('toolu_W', 'Workflow', {
        script: "export const meta = { name: 'fase-1' };\nexport default async function run() {}\n",
      }),
    );
    leadLine(
      toolResult(
        'toolu_W',
        `Workflow launched in background. Task ID: wtask1\nSummary: s\nTranscript dir: ${runDir}\n`,
      ),
    );
    for (const key of ['a0939d8552f9f51b5', 'a125d7b36e0d1d5ea']) {
      fs.writeFileSync(
        path.join(runDir, `agent-${key}.jsonl`),
        JSON.stringify({ type: 'user', message: { role: 'user', content: `Tarea ${key}` } }) + '\n',
      );
      fs.writeFileSync(
        path.join(runDir, `agent-${key}.meta.json`),
        JSON.stringify({ agentType: 'dev', spawnDepth: 1 }),
      );
    }
    scanAllTeammateFiles(
      store.nextAgentId,
      store,
      runtime.fileWatchers,
      runtime.pollingTimers,
      runtime.waitingTimers,
      runtime.permissionTimers,
      () => store.persist(),
    );
    const node = [...store.values()].find((a) => a.nodeKind === 'workflow')!;
    const runAgents = [...store.values()].filter((a) => a.parentAgentId === node.id);
    expect(runAgents).toHaveLength(2);
    // A run agent that finished its turn stays, available, until the run completes.
    store.broadcast({
      type: 'agentStatus',
      id: runAgents[0].id,
      status: 'waiting',
      awaitingInput: false,
    });
    expect(runAgents[0].presence).toBe('available');

    leadLine(notice({ taskId: 'wtask1', status: 'completed' }));
    for (const a of [...runAgents, node]) expect(a.presence).toBe('leaving');
    const order = presenceMessages(messages).filter((m) => m.endsWith('leaving'));
    expect(order[0]).not.toBe(`${node.id}:leaving`);
    vi.advanceTimersByTime(3 * LEAVE_STAGGER_MS);
    expect(
      presenceMessages(messages)
        .filter((m) => m.endsWith('leaving'))
        .pop(),
    ).toBe(`${node.id}:leaving`);
    vi.advanceTimersByTime(LEAVE_ANIMATION_MAX_MS);
    expect([...store.values()].filter((a) => a.parentAgentId !== undefined)).toEqual([]);
    expect(lead.backgroundAgentToolIds.has('toolu_W')).toBe(false);
  });

  it('a workflow run agent resting unused stays until its run ends (never re-adopted in a loop)', () => {
    runtime.setIdleToLoungeMinutes(1);
    runtime.setLoungeToLeaveMinutes(1);
    const runDir = path.join(subagentsDir, 'workflows', 'wf_run-2');
    fs.mkdirSync(runDir, { recursive: true });
    leadLine(
      toolUse('toolu_W2', 'Workflow', {
        script: "export const meta = { name: 'fase-2' };\nexport default async function run() {}\n",
      }),
    );
    leadLine(
      toolResult(
        'toolu_W2',
        `Workflow launched in background. Task ID: wtask2\nSummary: s\nTranscript dir: ${runDir}\n`,
      ),
    );
    for (const key of ['b0939d8552f9f51b5', 'b125d7b36e0d1d5ea']) {
      fs.writeFileSync(
        path.join(runDir, `agent-${key}.jsonl`),
        JSON.stringify({ type: 'user', message: { role: 'user', content: `Tarea ${key}` } }) + '\n',
      );
      fs.writeFileSync(
        path.join(runDir, `agent-${key}.meta.json`),
        JSON.stringify({ agentType: 'dev', spawnDepth: 1 }),
      );
    }
    const tick = (): void =>
      scanAllTeammateFiles(
        store.nextAgentId,
        store,
        runtime.fileWatchers,
        runtime.pollingTimers,
        runtime.waitingTimers,
        runtime.permissionTimers,
        () => store.persist(),
      );
    tick();
    const node = [...store.values()].find((a) => a.nodeKind === 'workflow')!;
    const [done, busy] = [...store.values()].filter((a) => a.parentAgentId === node.id);
    store.broadcast({ type: 'agentStatus', id: done.id, status: 'waiting', awaitingInput: false });
    expect(done.presence).toBe('available');
    vi.advanceTimersByTime(10 * 60_000);
    tick();
    // Resting far past the limit, but its run is still going: it stays.
    expect(done.presence).toBe('lounge');
    expect(store.get(done.id)).toBe(done);
    expect(busy.presence).toBe('working');
    expect([...store.values()].filter((a) => a.parentAgentId === node.id)).toHaveLength(2);
  });

  it('a finished spawn resumed before it materialized is born, then works, and never leaves mid-task', () => {
    runtime.setIdleToLoungeMinutes(1);
    runtime.setLoungeToLeaveMinutes(1);
    const t0 = Date.now();
    leadLine(spawnToolUse('toolu_L'));
    leadLine(asyncLaunchResult('toolu_L', 'aaa'));
    // Its task ended long ago (the notice carries its time)…
    leadLine(stamped(notice({ taskId: 'aaa', status: 'completed' }), t0 - 3 * 3600_000));
    // …and its parent resumed it since: its transcript is being written now.
    writeSidecar('aaa', { agentType: 'dev', toolUseId: 'toolu_L', spawnDepth: 1 }, [
      stamped(userPrompt('la tarea original'), t0 - 3 * 3600_000 - 60_000),
      stamped(userPrompt('una cosa más'), t0 - 1000),
      stamped(toolUse('toolu_b', 'Bash', { command: 'make' }), t0 - 500),
    ]);
    scan();
    const aaa = byKey('aaa');
    expect(aaa.presence).toBe('working');
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(5000);
      appendLine('aaa', stamped(toolUse(`toolu_x${i}`, 'Bash', { command: 'ls' }), Date.now()));
    }
    expect(store.get(aaa.id)).toBe(aaa);
    expect(aaa.presence).toBe('working');
  });

  it('nothing about presence is persisted; derived agents still never are', () => {
    const saved: unknown[][] = [];
    store.setAdapter({
      loadAgents: () => [],
      saveAgents: (agents) => saved.push(agents as unknown[]),
      loadSeats: () => ({}),
      saveSeats: () => {},
      getSetting: <T>(_k: string, d: T) => d,
      setSetting: () => {},
    });
    twoBackgroundChildren();
    leadLine(notice({ taskId: 'aaa', status: 'completed' }));
    store.persist();
    const last = saved[saved.length - 1] as Array<Record<string, unknown>>;
    expect(last.map((a) => a.id)).toEqual([1]);
    expect(JSON.stringify(last)).not.toContain('"presence"');
    expect(JSON.stringify(last)).not.toContain('"availableSince"');
  });

  it('finished agents never keep the disk scan busy once every spawn has its agent', () => {
    twoBackgroundChildren();
    leadLine(notice({ taskId: 'aaa', status: 'completed' }));
    leadLine(notice({ taskId: 'sib', status: 'completed' }));
    const before = discoverCalls;
    scan();
    scan();
    expect(discoverCalls).toBe(before);
    // A new spawn does scan again.
    leadLine(spawnToolUse('toolu_N'));
    expect(discoverCalls).toBeGreaterThan(before);
  });

  it('a full tree lets its longest-resting finished agent go to make room for a working one', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const n = MAX_DERIVED_AGENTS_PER_TREE;
      const blocks = [];
      const results = [];
      for (let i = 0; i < n; i++) {
        writeSidecar(`k${i}`, { agentType: 'dev', toolUseId: `toolu_${i}`, spawnDepth: 1 });
        blocks.push({ type: 'tool_use', id: `toolu_${i}`, name: 'Agent', input: {} });
        results.push({
          type: 'tool_result',
          tool_use_id: `toolu_${i}`,
          content: `Async agent launched successfully.\nagentId: k${i} (internal)`,
        });
      }
      leadLine(JSON.stringify({ type: 'assistant', message: { content: blocks } }));
      leadLine(JSON.stringify({ type: 'user', message: { content: results } }));
      expect([...store.values()].filter((a) => a.parentAgentId !== undefined)).toHaveLength(n);
      for (let i = 0; i < n; i++) {
        vi.advanceTimersByTime(10);
        leadLine(notice({ taskId: `k${i}`, status: 'completed' }));
      }
      // A working spawn arrives while every seat is taken by finished agents.
      writeSidecar('fresh', { agentType: 'dev', toolUseId: 'toolu_fresh', spawnDepth: 1 });
      leadLine(spawnToolUse('toolu_fresh'));
      expect(maybeByKey('fresh')).toBeUndefined();
      // The one that finished first walks out; only one makes room.
      expect(byKey('k0').presence).toBe('leaving');
      expect([...store.values()].filter((a) => a.presence === 'leaving')).toHaveLength(1);
      expect(lead.backgroundAgentToolIds.has('toolu_0')).toBe(false);
      scan(); // still waiting: no second eviction for the same need
      expect([...store.values()].filter((a) => a.presence === 'leaving')).toHaveLength(1);
      vi.advanceTimersByTime(LEAVE_ANIMATION_MAX_MS);
      scan();
      expect(byKey('fresh').presence).toBe('working');
      expect(maybeByKey('k0')).toBeUndefined();
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  }, 120_000);

  it('what an agent keeps alive after finishing is bounded (oldest let go)', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const n = 257;
      const blocks = [];
      const results = [];
      for (let i = 0; i < n; i++) {
        blocks.push({ type: 'tool_use', id: `toolu_${i}`, name: 'Agent', input: {} });
        results.push({
          type: 'tool_result',
          tool_use_id: `toolu_${i}`,
          content: `Async agent launched successfully.\nagentId: k${i} (internal)`,
        });
      }
      leadLine(JSON.stringify({ type: 'assistant', message: { content: blocks } }));
      leadLine(JSON.stringify({ type: 'user', message: { content: results } }));
      for (let i = 0; i < n; i++) {
        leadLine(notice({ taskId: `k${i}`, toolUseId: `toolu_${i}`, status: 'completed' }));
      }
      expect(lead.backgroundAgentToolIds.size).toBe(256);
      expect(lead.backgroundAgentToolIds.has('toolu_0')).toBe(false);
      expect(lead.backgroundAgentToolIds.has('toolu_256')).toBe(true);
    } finally {
      log.mockRestore();
    }
  });

  it('an agent materialized after its task ended (no finished mark) still settles as available', () => {
    leadLine(spawnToolUse('toolu_L'));
    leadLine(asyncLaunchResult('toolu_L', 'aaa'));
    // Its transcript already ran to the end of its task.
    writeSidecar('aaa', { agentType: 'dev', toolUseId: 'toolu_L', spawnDepth: 1 }, [
      userPrompt('haz algo'),
      toolUse('toolu_b', 'Bash', { command: 'ls' }),
      toolResult('toolu_b', 'ok'),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Listo.' }] },
      }),
    ]);
    scan();
    expect(byKey('aaa').presence).toBe('working');
    vi.advanceTimersByTime(TEXT_IDLE_DELAY_MS);
    expect(byKey('aaa').presence).toBe('available');
  });

  function stamped(line: string, at: number): string {
    return JSON.stringify({ ...JSON.parse(line), timestamp: new Date(at).toISOString() });
  }

  it('a finished agent born from a full transcript stays available in hooks mode (no replay flip)', () => {
    const t0 = Date.now();
    leadLine(spawnToolUse('toolu_L'));
    leadLine(asyncLaunchResult('toolu_L', 'aaa'));
    leadLine(notice({ taskId: 'aaa', status: 'completed' }));
    writeSidecar('aaa', { agentType: 'dev', toolUseId: 'toolu_L', spawnDepth: 1 }, [
      stamped(userPrompt('haz algo'), t0 - 60_000),
      stamped(toolUse('toolu_b', 'Bash', { command: 'ls' }), t0 - 50_000),
      stamped(toolResult('toolu_b', 'ok'), t0 - 40_000),
    ]);
    const created: number[] = [];
    store.on('agentAdded', (id, a) => {
      a.hookDelivered = true; // its keyed hooks flow (no text-idle fallback)
      created.push(id);
    });
    scan();
    const aaa = byKey('aaa');
    expect(aaa.presence).toBe('available');
    vi.advanceTimersByTime(PRESENCE_TICK_MS);
    expect(presenceMessages(messages, aaa.id)).toEqual([]);
    expect(aaa.presence).toBe('available');
  });

  it('the rest of a finished agent’s transcript read after its notice does not put it back to work', () => {
    twoBackgroundChildren();
    const aaa = byKey('aaa');
    aaa.hookDelivered = true;
    leadLine(notice({ taskId: 'aaa', status: 'completed' }));
    appendLine('aaa', toolUse('toolu_last', 'Bash', { command: 'git status' }));
    appendLine('aaa', toolResult('toolu_last', 'clean'));
    store.broadcast({ type: 'agentToolPermission', id: aaa.id });
    expect(aaa.presence).toBe('available');
    // A prompt written later (SendMessage) resumes it.
    appendLine('aaa', stamped(userPrompt('una cosa más'), Date.now() + 1000));
    expect(aaa.presence).toBe('working');
    appendLine('aaa', toolUse('toolu_more', 'Bash', { command: 'ls' }));
    expect(aaa.presence).toBe('working');
    // A resumed agent's spawn no longer counts as finished: re-born, it would work.
    leadLine(notice({ taskId: 'aaa', status: 'completed' }));
    expect(aaa.presence).toBe('available');
  });

  it('an old prompt replayed after the notice is not a resumption', () => {
    twoBackgroundChildren();
    const aaa = byKey('aaa');
    leadLine(notice({ taskId: 'aaa', status: 'completed' }));
    appendLine('aaa', stamped(userPrompt('la tarea original'), Date.now() - 60_000));
    expect(aaa.presence).toBe('available');
  });

  it('closing a background derived agent ends its spawn (nothing keeps scanning for it)', () => {
    twoBackgroundChildren();
    const aaa = byKey('aaa');
    runtime.closeAgent(aaa.id);
    expect(aaa.presence).toBe('leaving');
    expect(lead.backgroundAgentToolIds.has('toolu_L')).toBe(false);
    vi.advanceTimersByTime(LEAVE_ANIMATION_MAX_MS);
    scan();
    expect(maybeByKey('aaa')).toBeUndefined();
  });

  it('a killed named teammate walks out and the lead badge drops when its walk ends', () => {
    leadLine(spawnToolUse('toolu_T', { name: 'revisor' }));
    writeSidecar('ttt', { agentType: 'qa', toolUseId: 'toolu_T', spawnDepth: 1, name: 'revisor' });
    scan();
    leadLine(asyncLaunchResult('toolu_T', 'ttt'));
    expect(lead.isTeamLead).toBe(true);
    const onTeammateRemoved = vi.fn();
    runtime.setLifecycleCallbacks({ onTeammateRemoved });
    leadLine(notice({ taskId: 'ttt', status: 'killed' }));
    runtime.removeTeammate(byKey('ttt').id, 'test');
    runtime.removeTeammate(byKey('ttt').id, 'test');
    expect(onTeammateRemoved).not.toHaveBeenCalled(); // already leaving: no repeats
    expect(lead.isTeamLead).toBe(true);
    vi.advanceTimersByTime(LEAVE_ANIMATION_MAX_MS);
    expect(maybeByKey('ttt')).toBeUndefined();
    expect(lead.isTeamLead).toBeUndefined();
  });

  it('dispose leaves no presence timer behind', () => {
    backgroundTree();
    leadLine(notice({ taskId: 'aaa', status: 'killed' }));
    runtime.dispose();
    expect(store.size).toBe(0);
    vi.advanceTimersByTime(10 * LEAVE_ANIMATION_MAX_MS);
    expect(store.size).toBe(0);
  });

  // (k)
  it('(k) agentCreated and existingAgents meta carry the presence', () => {
    twoBackgroundChildren();
    leadLine(notice({ taskId: 'aaa', status: 'completed' }));
    const aaa = byKey('aaa');
    expect(agentCreatedMessage(aaa, false).presence).toBe('available');
    expect(agentTreeMeta(aaa, false).presence).toBe('available');
    expect(agentCreatedMessage(byKey('sib'), true).presence).toBe('working');
    expect(agentCreatedMessage(lead, true).presence).toBeUndefined();
  });

  it('(k) a spawn that completed before its agent materialized is born available', () => {
    leadLine(spawnToolUse('toolu_L'));
    leadLine(asyncLaunchResult('toolu_L', 'aaa'));
    leadLine(notice({ taskId: 'aaa', status: 'completed' }));
    writeSidecar('aaa', { agentType: 'dev', toolUseId: 'toolu_L', spawnDepth: 1 });
    const created: Array<Record<string, unknown>> = [];
    store.on('agentAdded', (_id, a) => created.push(agentCreatedMessage(a, false)));
    scan();
    expect(byKey('aaa').presence).toBe('available');
    expect(created[0]).toMatchObject({ presence: 'available' });
  });
});
