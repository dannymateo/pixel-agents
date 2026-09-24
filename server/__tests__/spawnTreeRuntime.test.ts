import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  MAX_DERIVED_AGENTS_PER_TREE,
  MAX_SPAWN_DEPTH,
  RESTORED_SPAWN_MAX_IDLE_MS,
  SPAWN_SIBLING_HUE_STEP_DEG,
} from '../src/constants.js';
import {
  readNewLines,
  restorableSpawnToolIds,
  rootOf,
  scanAllTeammateFiles,
  scanSpawnTree,
  setSpawnTreeCallbacks,
} from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { claudeTeamProvider } from '../src/providers/hook/claude/claudeTeamProvider.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

const LEAD_SESSION = 'lead-session-tree';

// Helpers copied from backgroundAgents.test.ts on purpose (tests don't import tests).
function createLeadAgent(projectDir: string): AgentState {
  return {
    id: 1,
    sessionId: LEAD_SESSION,
    terminalRef: undefined,
    isExternal: false,
    projectDir,
    jsonlFile: path.join(projectDir, `${LEAD_SESSION}.jsonl`),
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
  } as AgentState;
}

function spawnToolUse(toolId: string, input: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: toolId,
          name: 'Agent',
          input: { description: 'do work', subagent_type: 'general-purpose', ...input },
        },
      ],
    },
  });
}

function toolResult(toolId: string, text = 'Here is my report.'): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: text }] },
  });
}

function asyncLaunchResult(toolId: string): string {
  return toolResult(toolId, 'Async agent launched successfully.\nagentId: aaa (internal)');
}

function queueOpCompletion(toolId: string, status?: string): string {
  const statusTag = status ? `<status>${status}</status> ` : '';
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    content: `<task-notification> <tool-use-id>${toolId}</tool-use-id> ${statusTag}<output>done</output>`,
  });
}

function fakeAdapter(): StateAdapter & { saved: unknown[][] } {
  const saved: unknown[][] = [];
  return {
    saved,
    loadAgents: () => [] as never,
    saveAgents: (agents) => {
      saved.push(agents as unknown[]);
    },
    loadSeats: () => ({}),
    saveSeats: () => {},
    getSetting: <T>(_key: string, defaultValue: T) => defaultValue,
    setSetting: () => {},
  };
}

describe('spawn tree runtime (docs/adr/0002)', () => {
  let tmpRoot: string;
  let subagentsDir: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let lead: AgentState;
  let messages: Array<Record<string, unknown>>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-tree-'));
    subagentsDir = path.join(tmpRoot, LEAD_SESSION, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    lead = createLeadAgent(tmpRoot);
    lead.palette = 2;
    lead.hueShift = 0;
    store.set(1, lead);
    store.nextAgentId.current = 2;
    messages = [];
    store.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
  });

  afterEach(() => {
    runtime.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeSidecar(
    key: string,
    meta: Record<string, unknown>,
    transcriptLines: string[] = [],
  ): string {
    const jsonlPath = path.join(subagentsDir, `agent-${key}.jsonl`);
    fs.writeFileSync(
      jsonlPath,
      transcriptLines.length > 0 ? transcriptLines.join('\n') + '\n' : '',
    );
    fs.writeFileSync(path.join(subagentsDir, `agent-${key}.meta.json`), JSON.stringify(meta));
    return jsonlPath;
  }

  function appendLine(key: string, line: string): void {
    fs.appendFileSync(path.join(subagentsDir, `agent-${key}.jsonl`), line + '\n');
  }

  function byKey(key: string): AgentState {
    const found = [...store.values()].find((a) => a.spawnAgentKey === key);
    if (!found) throw new Error(`no agent for key ${key}`);
    return found;
  }

  function maybeByKey(key: string): AgentState | undefined {
    return [...store.values()].find((a) => a.spawnAgentKey === key);
  }

  /** Out of the office, or walking out (docs/adr/0003: a leaving agent is
   *  removed once its walk is over — presence.test.ts pins that timing). */
  function gone(key: string): boolean {
    const a = maybeByKey(key);
    return a === undefined || a.presence === 'leaving';
  }

  /** Derived agents still staying in the office (not leaving). */
  function staying(): AgentState[] {
    return [...store.values()].filter(
      (a) => a.parentAgentId !== undefined && a.presence !== 'leaving',
    );
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

  function leadLine(line: string): void {
    processTranscriptLine(1, line, store, runtime.waitingTimers, runtime.permissionTimers);
  }

  /** Builds lead → aaa (lider-fase) → bbb (desarrollador) → ccc (qa-revisor). */
  function buildDepthThree(): void {
    leadLine(spawnToolUse('toolu_L'));
    writeSidecar('aaa', { agentType: 'lider-fase', toolUseId: 'toolu_L', spawnDepth: 1 });
    scan();
    appendLine('aaa', spawnToolUse('toolu_A'));
    readNewLines(byKey('aaa').id, store, runtime.waitingTimers, runtime.permissionTimers);
    writeSidecar('bbb', {
      agentType: 'desarrollador',
      toolUseId: 'toolu_A',
      parentAgentId: 'aaa',
      spawnDepth: 2,
    });
    scan();
    appendLine('bbb', spawnToolUse('toolu_B'));
    readNewLines(byKey('bbb').id, store, runtime.waitingTimers, runtime.permissionTimers);
    writeSidecar('ccc', {
      agentType: 'qa-revisor',
      toolUseId: 'toolu_B',
      parentAgentId: 'bbb',
      spawnDepth: 3,
    });
    scan();
  }

  it('A: materializes a depth-3 tree, each node under its own parent', () => {
    leadLine(spawnToolUse('toolu_L'));
    writeSidecar('aaa', {
      agentType: 'lider-fase',
      description: 'Fase 1',
      toolUseId: 'toolu_L',
      spawnDepth: 1,
    });
    scan();
    expect(byKey('aaa')).toMatchObject({
      parentAgentId: 1,
      spawnAgentKey: 'aaa',
      role: 'lider-fase',
      label: 'Fase 1',
      depth: 1,
      spawnToolUseId: 'toolu_L',
    });
    expect(byKey('aaa').agentName).toBeUndefined();

    buildDepthThreeRest();
    expect(byKey('bbb')).toMatchObject({
      parentAgentId: byKey('aaa').id,
      depth: 2,
      role: 'desarrollador',
    });
    expect(byKey('ccc')).toMatchObject({
      parentAgentId: byKey('bbb').id,
      depth: 3,
      role: 'qa-revisor',
    });
    // The transient Subtask sprite of each spawn is superseded by the real character.
    expect(
      messages.some(
        (m) => m.type === 'subagentClear' && m.id === 1 && m.parentToolId === 'toolu_L',
      ),
    ).toBe(true);
    expect(
      messages.some(
        (m) =>
          m.type === 'subagentClear' && m.id === byKey('aaa').id && m.parentToolId === 'toolu_A',
      ),
    ).toBe(true);
    // Each node is watched through the ordinary pipeline.
    for (const key of ['aaa', 'bbb', 'ccc']) {
      expect(runtime.pollingTimers.has(byKey(key).id)).toBe(true);
    }

    function buildDepthThreeRest(): void {
      appendLine('aaa', spawnToolUse('toolu_A'));
      readNewLines(byKey('aaa').id, store, runtime.waitingTimers, runtime.permissionTimers);
      writeSidecar('bbb', {
        agentType: 'desarrollador',
        toolUseId: 'toolu_A',
        parentAgentId: 'aaa',
        spawnDepth: 2,
      });
      scan();
      appendLine('bbb', spawnToolUse('toolu_B'));
      readNewLines(byKey('bbb').id, store, runtime.waitingTimers, runtime.permissionTimers);
      writeSidecar('ccc', {
        agentType: 'qa-revisor',
        toolUseId: 'toolu_B',
        parentAgentId: 'bbb',
        spawnDepth: 3,
      });
      scan();
    }
  });

  it('A2: depth comes from the parent, never from the sidecar', () => {
    leadLine(spawnToolUse('toolu_L'));
    writeSidecar('aaa', { agentType: 'Explore', toolUseId: 'toolu_L', spawnDepth: 7 });
    scan();
    expect(byKey('aaa').depth).toBe(1);
  });

  it('A3: siblings inherit the parent palette and rotate the hue', () => {
    leadLine(spawnToolUse('toolu_1'));
    leadLine(spawnToolUse('toolu_2'));
    writeSidecar('s1', { agentType: 'Explore', toolUseId: 'toolu_1', spawnDepth: 1 });
    writeSidecar('s2', { agentType: 'Explore', toolUseId: 'toolu_2', spawnDepth: 1 });
    scan();
    const hues = [byKey('s1'), byKey('s2')].map((a) => a.hueShift).sort((x, y) => x! - y!);
    expect(byKey('s1').palette).toBe(2);
    expect(byKey('s2').palette).toBe(2);
    expect(hues).toEqual([SPAWN_SIBLING_HUE_STEP_DEG, 2 * SPAWN_SIBLING_HUE_STEP_DEG]);
  });

  it('A4: a re-scan never creates a second agent for the same spawn', () => {
    buildDepthThree();
    const before = store.size;
    scan();
    scan();
    expect(store.size).toBe(before);
    expect(before).toBe(4);
  });

  it('A5: opening a spawn tool triggers the tree scan (no periodic tick needed)', () => {
    writeSidecar('aaa', { agentType: 'Explore', toolUseId: 'toolu_L', spawnDepth: 1 });
    leadLine(spawnToolUse('toolu_L'));
    expect(maybeByKey('aaa')?.parentAgentId).toBe(1);
  });

  it('A6: named spawns keep the teammate identity and hang from their parent', () => {
    leadLine(spawnToolUse('toolu_L', { name: 'ghost-writer' }));
    writeSidecar('aaa', {
      agentType: 'general-purpose',
      toolUseId: 'toolu_L',
      spawnDepth: 1,
      name: 'ghost-writer',
    });
    scan();
    expect(byKey('aaa')).toMatchObject({
      agentName: 'ghost-writer',
      leadAgentId: 1,
      parentAgentId: 1,
    });
    expect(lead.isTeamLead).toBe(true);
    expect(
      messages.some((m) => m.type === 'agentTeamInfo' && m.id === 1 && m.isTeamLead === true),
    ).toBe(true);
  });

  it('B: removing a node removes its whole subtree, leaves first; the lead stays', () => {
    buildDepthThree();
    const ids = ['aaa', 'bbb', 'ccc'].map((k) => byKey(k).id);
    const removedOrder: number[] = [];
    store.on('agentRemoved', (id) => removedOrder.push(id));

    runtime.removeAgent(ids[0]);

    for (const id of ids) expect(store.get(id)).toBeUndefined();
    expect(removedOrder).toEqual([ids[2], ids[1], ids[0]]);
    expect(store.get(1)).toBe(lead);
    // No orphan watcher or timer survives the cascade.
    for (const id of ids) {
      expect(runtime.pollingTimers.has(id)).toBe(false);
      expect(runtime.waitingTimers.has(id)).toBe(false);
      expect(runtime.permissionTimers.has(id)).toBe(false);
    }
  });

  it('B2: removeAgent tolerates ids that no longer exist', () => {
    buildDepthThree();
    const id = byKey('bbb').id;
    runtime.removeAgent(id);
    expect(() => runtime.removeAgent(id)).not.toThrow();
    expect(() => runtime.removeAgent(9999)).not.toThrow();
    expect(maybeByKey('aaa')).toBeDefined();
  });

  it('C: the root session ending takes every derived agent with it', () => {
    buildDepthThree();
    runtime.registerAgent(LEAD_SESSION, 1);
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: LEAD_SESSION,
      reason: 'exit',
    });
    expect(staying()).toEqual([]);
  });

  it('C2: /clear moves the root to a new session and ends the old spawn tree', () => {
    buildDepthThree();
    lead.isExternal = true;
    runtime.registerAgent(LEAD_SESSION, 1);
    const newTranscript = path.join(tmpRoot, 'new-session.jsonl');
    fs.writeFileSync(newTranscript, '');
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: LEAD_SESSION,
      reason: 'clear',
      transcript_path: lead.jsonlFile,
      cwd: tmpRoot,
    });
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'new-session',
      source: 'clear',
      transcript_path: newTranscript,
      cwd: tmpRoot,
    });
    expect(store.get(1)?.sessionId).toBe('new-session');
    expect(staying()).toEqual([]);
    // The old session's key routing is gone too: a late keyed hook reaches no one.
    messages.length = 0;
    runtime.handleHookEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: LEAD_SESSION,
      agent_id: 'ccc',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(messages).toEqual([]);
  });

  it('coalesces a burst of scan requests for one root into a single scan', async () => {
    const spy = vi.spyOn(runtime, 'scanTree');
    runtime.scheduleTreeScan(1);
    runtime.scheduleTreeScan(1);
    runtime.scheduleTreeScan(1);
    expect(spy).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(1);
    // A later request schedules a fresh scan.
    runtime.scheduleTreeScan(1);
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('a SubagentStart burst triggers one coalesced tree scan', async () => {
    runtime.registerAgent(LEAD_SESSION, 1);
    const spy = vi.spyOn(runtime, 'scanTree');
    for (const key of ['k1', 'k2', 'k3']) {
      runtime.handleHookEvent('claude', {
        hook_event_name: 'SubagentStart',
        session_id: LEAD_SESSION,
        agent_id: key,
        agent_type: 'Explore',
      });
    }
    await Promise.resolve();
    expect(spy.mock.calls.filter(([id]) => id === 1)).toHaveLength(1);
  });

  it('no coalesced scan runs after dispose', async () => {
    const spy = vi.spyOn(runtime, 'scanTree');
    runtime.scheduleTreeScan(1);
    runtime.dispose();
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
  });

  it('routes a hook keyed by agent_id to the derived node, never to the root', () => {
    buildDepthThree();
    runtime.registerAgent(LEAD_SESSION, 1);
    messages.length = 0;
    runtime.handleHookEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: LEAD_SESSION,
      agent_id: 'ccc',
      agent_type: 'qa-revisor',
      tool_name: 'Bash',
      tool_input: { command: 'mvn test' },
    });
    expect(messages.some((m) => m.id === byKey('ccc').id)).toBe(true);
    expect(messages.some((m) => m.id === 1)).toBe(false);
  });

  it('forgets the routing of removed nodes: their keyed hooks never reach the root', () => {
    buildDepthThree();
    runtime.registerAgent(LEAD_SESSION, 1);
    runtime.removeAgent(byKey('aaa').id);
    messages.length = 0;
    runtime.handleHookEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: LEAD_SESSION,
      agent_id: 'ccc',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    expect(messages.some((m) => m.id === 1)).toBe(false);
  });

  it('D: a foreground spawn closing walks its node and subtree out', () => {
    buildDepthThree();
    leadLine(toolResult('toolu_L'));
    expect(gone('aaa')).toBe(true);
    expect(gone('bbb')).toBe(true);
    expect(gone('ccc')).toBe(true);
    expect(store.get(1)).toBe(lead);
  });

  it('D2: a mid-tree spawn closing removes only that branch', () => {
    buildDepthThree();
    const aaaId = byKey('aaa').id;
    appendLine('aaa', toolResult('toolu_A'));
    readNewLines(aaaId, store, runtime.waitingTimers, runtime.permissionTimers);
    expect(gone('bbb')).toBe(true);
    expect(gone('ccc')).toBe(true);
    expect(gone('aaa')).toBe(false);
  });

  it('D3: a background spawn survives its async-launch result and its completion (docs/adr/0003)', () => {
    leadLine(spawnToolUse('toolu_L'));
    writeSidecar('aaa', { agentType: 'Explore', toolUseId: 'toolu_L', spawnDepth: 1 });
    scan();
    leadLine(asyncLaunchResult('toolu_L'));
    expect(maybeByKey('aaa')?.parentAgentId).toBe(1);
    // The async re-broadcast must not resurrect a Subtask ghost next to the character.
    const ghost = messages.filter(
      (m) => m.type === 'agentToolStart' && m.toolId === 'toolu_L' && m.runInBackground === true,
    );
    expect(ghost).toEqual([]);
    // Finishing is not leaving: available, resumable, still live.
    leadLine(queueOpCompletion('toolu_L'));
    expect(maybeByKey('aaa')?.presence).toBe('available');
    expect(lead.backgroundAgentToolIds.has('toolu_L')).toBe(true);
    // Killed: it walks out and the spawn is over.
    leadLine(queueOpCompletion('toolu_L', 'killed'));
    expect(gone('aaa')).toBe(true);
    expect(lead.backgroundAgentToolIds.has('toolu_L')).toBe(false);
  });

  it('D4: a notice keyed by <task-id> (no <tool-use-id>) reaches its node', () => {
    // Current Claude Code writes the notice without <tool-use-id>; <task-id> is
    // the spawned agent's key (the <key> of agent-<key>.jsonl). Seen live on
    // 2026-09-24: derived agents never left the office.
    leadLine(spawnToolUse('toolu_L'));
    writeSidecar('aaa', { agentType: 'Explore', toolUseId: 'toolu_L', spawnDepth: 1 });
    scan();
    leadLine(asyncLaunchResult('toolu_L'));
    expect(maybeByKey('aaa')?.parentAgentId).toBe(1);
    leadLine(
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content:
          '<task-notification>\n<task-id>aaa</task-id>\n<output-file>x.output</output-file>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n</task-notification>',
      }),
    );
    expect(maybeByKey('aaa')?.presence).toBe('available');
    leadLine(
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content:
          '<task-notification>\n<task-id>aaa</task-id>\n<status>killed</status>\n</task-notification>',
      }),
    );
    expect(gone('aaa')).toBe(true);
  });

  it('D5: a <task-id> notice only completes a spawn of the agent that received it', () => {
    leadLine(spawnToolUse('toolu_L'));
    writeSidecar('aaa', { agentType: 'Explore', toolUseId: 'toolu_L', spawnDepth: 1 });
    scan();
    leadLine(asyncLaunchResult('toolu_L'));
    // A notice for an unknown key (another agent's child, or a forged id) is inert.
    leadLine(
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content:
          '<task-notification>\n<task-id>zzz</task-id>\n<status>completed</status>\n</task-notification>',
      }),
    );
    expect(maybeByKey('aaa')?.parentAgentId).toBe(1);
  });

  it('E: nothing derived is ever persisted', () => {
    const adapter = fakeAdapter();
    store.setAdapter(adapter);
    buildDepthThree();
    store.persist();
    const persisted = adapter.saved.at(-1) as Array<Record<string, unknown>>;
    expect(persisted.map((p) => p.id)).toEqual([1]);
  });

  it('F: a grandchild whose parent does not exist yet waits instead of hanging off the lead', () => {
    leadLine(spawnToolUse('toolu_L'));
    writeSidecar('bbb', {
      agentType: 'desarrollador',
      toolUseId: 'toolu_A',
      parentAgentId: 'aaa',
      spawnDepth: 2,
    });
    scan();
    expect(maybeByKey('bbb')).toBeUndefined();

    writeSidecar('aaa', { agentType: 'lider-fase', toolUseId: 'toolu_L', spawnDepth: 1 });
    scan();
    expect(maybeByKey('bbb')).toBeUndefined(); // aaa has not opened toolu_A yet
    appendLine('aaa', spawnToolUse('toolu_A'));
    readNewLines(byKey('aaa').id, store, runtime.waitingTimers, runtime.permissionTimers);
    scan();
    expect(byKey('bbb').parentAgentId).toBe(byKey('aaa').id);
  });

  it('refuses a sidecar claiming a spawn its named parent is not running', () => {
    buildDepthThree();
    // Manipulated sidecar: names aaa as parent but carries the LEAD's spawn id.
    writeSidecar('evil', {
      agentType: 'x',
      toolUseId: 'toolu_L',
      parentAgentId: 'aaa',
      spawnDepth: 2,
    });
    scan();
    expect(maybeByKey('evil')).toBeUndefined();
  });

  it('never hangs a derived agent off another root session', () => {
    const other = createLeadAgent(tmpRoot);
    other.id = 50;
    other.sessionId = 'other-session';
    other.jsonlFile = path.join(tmpRoot, 'other-session.jsonl');
    store.set(50, other);
    processTranscriptLine(
      50,
      spawnToolUse('toolu_L'),
      store,
      runtime.waitingTimers,
      runtime.permissionTimers,
    );
    // Sidecar lives under the LEAD's session dir; the other root shares the tool id.
    leadLine(spawnToolUse('toolu_L'));
    writeSidecar('aaa', { agentType: 'Explore', toolUseId: 'toolu_L', spawnDepth: 1 });
    scan(1);
    scan(50);
    expect(byKey('aaa').parentAgentId).toBe(1);
    expect([...store.values()].filter((a) => a.parentAgentId === 50)).toEqual([]);
  });

  it('spawn tree callbacks fire on create and on removal', () => {
    const created: string[] = [];
    const removed: string[] = [];
    setSpawnTreeCallbacks({
      onDerivedCreated: (a) => created.push(a.spawnAgentKey!),
      onDerivedRemoved: (a) => removed.push(a.spawnAgentKey!),
    });
    buildDepthThree();
    expect(created).toEqual(['aaa', 'bbb', 'ccc']);
    runtime.removeAgent(byKey('aaa').id);
    expect(removed).toEqual(['ccc', 'bbb', 'aaa']);
  });

  it('a derived node without a transcript does not break scanning or removal', () => {
    buildDepthThree();
    // Shape of a future workflow node: derived, no jsonlFile, nothing watched.
    const id = store.nextAgentId.current++;
    const node = createLeadAgent(tmpRoot);
    Object.assign(node, {
      id,
      jsonlFile: '',
      parentAgentId: 1,
      spawnToolUseId: 'toolu_W',
      nodeKind: 'workflow',
      depth: 1,
    });
    store.set(id, node);
    expect(() => scan()).not.toThrow();
    expect(() => runtime.removeAgent(id)).not.toThrow();
    expect(store.get(id)).toBeUndefined();
  });

  /** One periodic 1 s tick of teammate/spawn-tree discovery. */
  function tick(): void {
    scanAllTeammateFiles(
      store.nextAgentId,
      store,
      runtime.fileWatchers,
      runtime.pollingTimers,
      runtime.waitingTimers,
      runtime.permissionTimers,
      () => store.persist(),
    );
  }

  it('C3: children of an ended terminal session never come back on the next tick', () => {
    // Terminal root (not external): it survives SessionEnd, its spawns must not.
    leadLine(spawnToolUse('toolu_L'));
    writeSidecar('aaa', { agentType: 'Explore', toolUseId: 'toolu_L', spawnDepth: 1 });
    leadLine(asyncLaunchResult('toolu_L'));
    leadLine(spawnToolUse('toolu_F'));
    writeSidecar('fff', { agentType: 'Explore', toolUseId: 'toolu_F', spawnDepth: 1 });
    tick();
    expect(maybeByKey('aaa')).toBeDefined();
    expect(maybeByKey('fff')).toBeDefined();

    runtime.registerAgent(LEAD_SESSION, 1);
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: LEAD_SESSION,
      reason: 'exit',
    });
    tick();
    runtime.scanTree(1);

    expect(store.get(1)).toBe(lead);
    expect(staying()).toEqual([]);
    // Nothing new was materialized while they walk out.
    expect([...store.values()].filter((a) => a.parentAgentId !== undefined)).toHaveLength(2);
    expect(lead.backgroundAgentToolIds.size).toBe(0);
  });

  it('a spawn result that lands after a user prompt cleared the tool still removes its node', () => {
    leadLine(spawnToolUse('toolu_L'));
    writeSidecar('aaa', { agentType: 'Explore', toolUseId: 'toolu_L', spawnDepth: 1 });
    scan();
    leadLine(JSON.stringify({ type: 'user', message: { content: 'also do this' } }));
    // The prompt alone does not kill the running spawn.
    expect(maybeByKey('aaa')).toBeDefined();
    leadLine(toolResult('toolu_L'));
    expect(gone('aaa')).toBe(true);
  });

  it('a new sibling never repeats the hue of a live one', () => {
    leadLine(spawnToolUse('toolu_1'));
    leadLine(spawnToolUse('toolu_2'));
    writeSidecar('s1', { agentType: 'Explore', toolUseId: 'toolu_1', spawnDepth: 1 });
    writeSidecar('s2', { agentType: 'Explore', toolUseId: 'toolu_2', spawnDepth: 1 });
    scan();
    leadLine(toolResult(byKey('s1').spawnToolUseId!));
    expect(gone('s1')).toBe(true);
    runtime.removeAgent(byKey('s1').id); // its walk out is over
    leadLine(spawnToolUse('toolu_3'));
    writeSidecar('s3', { agentType: 'Explore', toolUseId: 'toolu_3', spawnDepth: 1 });
    scan();
    expect(byKey('s3').hueShift).not.toBe(byKey('s2').hueShift);
  });

  describe('with a teamed lead (flat teammate discovery also runs)', () => {
    beforeEach(() => {
      lead.teamName = 'session-abcd1234';
    });

    it('a closed foreground spawn is never re-adopted as a flat teammate', () => {
      leadLine(spawnToolUse('toolu_L'));
      writeSidecar('aaa', { agentType: 'Explore', toolUseId: 'toolu_L', spawnDepth: 1 });
      tick();
      expect(maybeByKey('aaa')).toBeDefined();
      leadLine(toolResult('toolu_L'));
      tick();
      tick();
      expect([...store.values()].filter((a) => a.id !== 1)).toEqual([maybeByKey('aaa')]);
      expect(gone('aaa')).toBe(true);
      runtime.removeAgent(byKey('aaa').id); // its walk out is over
      tick();
      tick();
      expect([...store.values()].filter((a) => a.id !== 1)).toEqual([]);
    });

    it('a grandchild sidecar landing before its parent opened the spawn is not a teammate', () => {
      leadLine(spawnToolUse('toolu_L'));
      writeSidecar('aaa', { agentType: 'lider-fase', toolUseId: 'toolu_L', spawnDepth: 1 });
      tick();
      // bbb's sidecar is on disk, but aaa has not read its toolu_A line yet.
      writeSidecar('bbb', {
        agentType: 'desarrollador',
        toolUseId: 'toolu_A',
        parentAgentId: 'aaa',
        spawnDepth: 2,
      });
      appendLine('aaa', spawnToolUse('toolu_A'));
      tick();
      expect(maybeByKey('bbb')).toBeUndefined();
      expect([...store.values()].some((a) => a.leadAgentId === 1)).toBe(false);
      readNewLines(byKey('aaa').id, store, runtime.waitingTimers, runtime.permissionTimers);
      tick();
      expect(byKey('bbb').parentAgentId).toBe(byKey('aaa').id);
    });

    it('a same-named historical sidecar never takes over a named derived agent', () => {
      leadLine(spawnToolUse('toolu_L', { name: 'dev' }));
      const live = writeSidecar('aaa', {
        agentType: 'dev',
        toolUseId: 'toolu_L',
        spawnDepth: 1,
        name: 'dev',
      });
      tick();
      writeSidecar('old', { agentType: 'dev', toolUseId: 'toolu_dead', spawnDepth: 1 });
      tick();
      expect(byKey('aaa').jsonlFile).toBe(live);
    });
  });

  it('an own-session teammate is the root of its own tree on the periodic tick', () => {
    const tm = createLeadAgent(tmpRoot);
    tm.id = 10;
    tm.sessionId = 'tm-session';
    tm.jsonlFile = path.join(tmpRoot, 'tm-session.jsonl');
    tm.leadAgentId = 1;
    tm.agentName = 'researcher';
    store.set(10, tm);
    processTranscriptLine(
      10,
      spawnToolUse('toolu_T'),
      store,
      runtime.waitingTimers,
      runtime.permissionTimers,
    );
    // Sidecar lands after the tool_use: only the tick can pick it up.
    const dir = path.join(tmpRoot, 'tm-session', 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent-ttt.jsonl'), '');
    fs.writeFileSync(
      path.join(dir, 'agent-ttt.meta.json'),
      JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_T', spawnDepth: 1 }),
    );
    tick();
    expect(byKey('ttt').parentAgentId).toBe(10);
  });

  it('a hooks-driven lead with a named derived teammate gets no duplicate JSONL tool starts', () => {
    leadLine(spawnToolUse('toolu_L', { name: 'writer' }));
    writeSidecar('aaa', {
      agentType: 'general-purpose',
      toolUseId: 'toolu_L',
      spawnDepth: 1,
      name: 'writer',
    });
    scan();
    lead.hookDelivered = true;
    messages.length = 0;
    leadLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_R', name: 'Read', input: { file_path: '/a' } }],
        },
      }),
    );
    // Hooks already sent the lead's Read; the JSONL copy would duplicate it.
    expect(messages.some((m) => m.type === 'agentToolStart' && m.toolId === 'toolu_R')).toBe(false);
  });

  // ── Round 2: caps, dismissal, restore ────────────────────────────────

  /** A derived agent placed straight in the store at a given depth, running
   *  one open foreground spawn `openTool`. */
  function seedDerived(key: string, depth: number, openTool: string): AgentState {
    const id = store.nextAgentId.current++;
    const a = createLeadAgent(tmpRoot);
    Object.assign(a, {
      id,
      jsonlFile: path.join(subagentsDir, `agent-${key}.jsonl`),
      spawnAgentKey: key,
      parentAgentId: 1,
      spawnToolUseId: `toolu_seed_${key}`,
      depth,
      isExternal: true,
    });
    a.activeToolIds.add(openTool);
    a.activeToolNames.set(openTool, 'Agent');
    a.activeToolStatuses.set(openTool, 'Subtask: x');
    store.set(id, a);
    return a;
  }

  it(`caps a tree at MAX_DERIVED_AGENTS_PER_TREE and does not block on 1500 spawns`, () => {
    const N = 1500;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (let i = 0; i < N; i++) {
        writeSidecar(`k${i}`, { agentType: 'Explore', toolUseId: `toolu_${i}`, spawnDepth: 1 });
      }
      const blocks = Array.from({ length: N }, (_, i) => ({
        type: 'tool_use',
        id: `toolu_${i}`,
        name: 'Agent',
        input: { description: 'x' },
      }));
      // Reading 1500 freshly written sidecars the first time is pure disk I/O in
      // the provider, spread over calls by its per-call read budget (cached by
      // mtime afterwards; real sidecars arrive one at a time). Drain it here and
      // measure it apart from the runtime's own work, recording the worst call.
      const tCold = performance.now();
      let worstCallMs = 0;
      for (let calls = 0; calls < 100; calls++) {
        const tc = performance.now();
        const n = claudeTeamProvider.discoverTeammates(tmpRoot, LEAD_SESSION).length;
        worstCallMs = Math.max(worstCallMs, performance.now() - tc);
        if (n === N) break;
      }
      const coldIoMs = performance.now() - tCold;
      const t0 = performance.now();
      // One assistant message opening every spawn: triggers the tree scan.
      leadLine(JSON.stringify({ type: 'assistant', message: { content: blocks } }));
      const firstMs = performance.now() - t0;
      const t1 = performance.now();
      scan();
      scan();
      const rescanMs = performance.now() - t1;

      const derived = [...store.values()].filter((a) => a.parentAgentId !== undefined);
      expect(derived).toHaveLength(MAX_DERIVED_AGENTS_PER_TREE);
      const capWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('Spawn tree'));
      expect(capWarnings).toHaveLength(1);
      expect(String(capWarnings[0][0])).toMatch(/^\[Pixel Agents\]/);
      // Pentester measured ~18.8 s for this before the cap; now ~50 ms here.
      // Generous bounds for slow CI: the point is "bounded", not a benchmark.
      process.stdout.write(
        `[spawn-cap] ${N} spawns: cold sidecar I/O ${coldIoMs.toFixed(0)} ms total (worst single call ${worstCallMs.toFixed(0)} ms), parse+scan ${firstMs.toFixed(0)} ms, 2 rescans ${rescanMs.toFixed(0)} ms\n`,
      );
      expect(firstMs).toBeLessThan(2_000);
      // The provider never blocks one call for the whole backlog (~9 s before).
      expect(worstCallMs).toBeLessThan(3_000);
      expect(rescanMs).toBeLessThan(1_000);

      // Room frees up: a spawn COMPLETES, and an entry deferred so far takes
      // its place (not the same one coming back — its spawn is closed).
      const before = new Set(derived.map((a) => a.spawnAgentKey));
      const victim = derived[0];
      leadLine(toolResult(victim.spawnToolUseId!));
      runtime.removeAgent(victim.id); // its walk out is over (docs/adr/0003)
      scan();
      const after = [...store.values()].filter((a) => a.parentAgentId !== undefined);
      expect(after).toHaveLength(MAX_DERIVED_AGENTS_PER_TREE);
      expect(after.some((a) => a.spawnAgentKey === victim.spawnAgentKey)).toBe(false);
      expect(after.filter((a) => !before.has(a.spawnAgentKey))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  }, 120_000);

  it('never materializes a node deeper than MAX_SPAWN_DEPTH', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      seedDerived('edge', MAX_SPAWN_DEPTH - 1, 'toolu_E');
      seedDerived('deep', MAX_SPAWN_DEPTH, 'toolu_D');
      writeSidecar('okchild', {
        agentType: 'x',
        toolUseId: 'toolu_E',
        parentAgentId: 'edge',
        spawnDepth: 2,
      });
      writeSidecar('toodeep', {
        agentType: 'x',
        toolUseId: 'toolu_D',
        parentAgentId: 'deep',
        spawnDepth: 2,
      });
      scan();
      scan();
      expect(byKey('okchild').depth).toBe(MAX_SPAWN_DEPTH);
      expect(maybeByKey('toodeep')).toBeUndefined();
      expect(warn.mock.calls.filter((c) => String(c[0]).includes('Spawn tree'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a derived agent the user closed is not recreated while its spawn is live', () => {
    buildDepthThree();
    const aaa = byKey('aaa');
    // What closeAgent does (clientMessageHandler / VS Code adapter).
    runtime.dismissalTracker.dismiss(aaa.jsonlFile);
    runtime.removeAgent(aaa.id);
    expect([...store.values()].filter((a) => a.parentAgentId !== undefined)).toEqual([]);

    scan();
    expect(maybeByKey('aaa')).toBeUndefined();
    // Past the 3-minute dismissal cooldown, still not back: the spawn is the same.
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000);
    try {
      scan();
    } finally {
      clock.mockRestore();
    }
    expect([...store.values()].filter((a) => a.parentAgentId !== undefined)).toEqual([]);
    expect(store.get(1)).toBe(lead);
  });

  it('restorableSpawnToolIds drops the ids of a root idle past RESTORED_SPAWN_MAX_IDLE_MS', () => {
    const file = path.join(tmpRoot, 'root.jsonl');
    fs.writeFileSync(file, '');
    const root = { jsonlFile: file, projectDir: tmpRoot, sessionId: 'root' };
    const mtime = fs.statSync(file).mtimeMs;
    expect([...restorableSpawnToolIds(root, ['toolu_L'], mtime + 1000)]).toEqual(['toolu_L']);
    expect(
      restorableSpawnToolIds(root, ['toolu_L'], mtime + RESTORED_SPAWN_MAX_IDLE_MS + 1000).size,
    ).toBe(0);
    const missing = { ...root, jsonlFile: path.join(tmpRoot, 'missing.jsonl') };
    expect(restorableSpawnToolIds(missing, ['toolu_L']).size).toBe(0);
    expect(restorableSpawnToolIds(root, undefined).size).toBe(0);
  });

  it('restorableSpawnToolIds keeps the spawn of a quiet root whose own transcript is still active', () => {
    const file = path.join(tmpRoot, 'waiting.jsonl');
    fs.writeFileSync(file, '');
    const old = new Date(Date.now() - RESTORED_SPAWN_MAX_IDLE_MS - 60_000);
    fs.utimesSync(file, old, old);
    const dir = path.join(tmpRoot, 'waiting', 'subagents');
    fs.mkdirSync(dir, { recursive: true });
    // Long background agent, still writing.
    fs.writeFileSync(path.join(dir, 'agent-busy.jsonl'), '{}');
    fs.writeFileSync(
      path.join(dir, 'agent-busy.meta.json'),
      JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_busy', spawnDepth: 1 }),
    );
    // Dead one: its transcript went quiet with the root.
    fs.writeFileSync(path.join(dir, 'agent-dead.jsonl'), '{}');
    fs.utimesSync(path.join(dir, 'agent-dead.jsonl'), old, old);
    fs.writeFileSync(
      path.join(dir, 'agent-dead.meta.json'),
      JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_dead', spawnDepth: 1 }),
    );
    const kept = restorableSpawnToolIds(
      { jsonlFile: file, projectDir: tmpRoot, sessionId: 'waiting' },
      ['toolu_busy', 'toolu_dead', 'toolu_unknown'],
    );
    expect([...kept]).toEqual(['toolu_busy']);
  });

  it('restoring a root that went quiet long ago does not bring its tree back', () => {
    const leadJsonl = path.join(tmpRoot, 'quiet.jsonl');
    fs.writeFileSync(leadJsonl, '');
    const old = new Date(Date.now() - RESTORED_SPAWN_MAX_IDLE_MS - 60_000);
    fs.utimesSync(leadJsonl, old, old);
    const restoreDir = path.join(tmpRoot, 'quiet', 'subagents');
    fs.mkdirSync(restoreDir, { recursive: true });
    fs.writeFileSync(path.join(restoreDir, 'agent-zzz.jsonl'), '');
    // The spawn's own transcript went quiet too: the whole session is dead.
    fs.utimesSync(path.join(restoreDir, 'agent-zzz.jsonl'), old, old);
    fs.writeFileSync(
      path.join(restoreDir, 'agent-zzz.meta.json'),
      JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_Q', spawnDepth: 1 }),
    );

    const restoredStore = new AgentStateStore();
    restoredStore.setAdapter({
      ...fakeAdapter(),
      loadAgents: () =>
        [
          {
            id: 7,
            sessionId: 'quiet',
            terminalName: '',
            isExternal: true,
            jsonlFile: leadJsonl,
            projectDir: tmpRoot,
            backgroundAgentToolIds: ['toolu_Q'],
          },
        ] as never,
    });
    const restoredRuntime = new AgentRuntime(restoredStore, claudeProvider);
    try {
      restoredRuntime.restoreExternalAgents();
      expect(restoredStore.get(7)!.backgroundAgentToolIds.size).toBe(0);
      restoredRuntime.scanTree(7);
      expect([...restoredStore.values()].filter((a) => a.parentAgentId !== undefined)).toEqual([]);
    } finally {
      restoredRuntime.dispose();
    }
  });

  it('rootOf climbs to the session root and survives cycles', () => {
    buildDepthThree();
    expect(rootOf(byKey('ccc').id, store)).toBe(1);
    expect(rootOf(1, store)).toBe(1);
    const a = byKey('aaa');
    const c = byKey('ccc');
    a.parentAgentId = c.id; // corrupt: aaa → ccc → bbb → aaa
    expect(() => rootOf(c.id, store)).not.toThrow();
    expect(() => scan()).not.toThrow();
  });

  it('Task-era: a spawn without sidecars keeps the Subtask path', () => {
    leadLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_T', name: 'Task', input: { description: 'x' } }],
        },
      }),
    );
    leadLine(
      JSON.stringify({
        type: 'progress',
        parentToolUseID: 'toolu_T',
        data: {
          type: 'agent_progress',
          message: {
            type: 'assistant',
            message: {
              content: [{ type: 'tool_use', id: 'toolu_sub', name: 'Read', input: {} }],
            },
          },
        },
      }),
    );
    expect(
      messages.some(
        (m) => m.type === 'subagentToolStart' && m.id === 1 && m.parentToolId === 'toolu_T',
      ),
    ).toBe(true);
    expect([...store.values()].filter((a) => a.parentAgentId !== undefined)).toEqual([]);
  });
});
