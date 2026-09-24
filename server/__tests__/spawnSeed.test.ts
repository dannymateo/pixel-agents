/**
 * Spawn seeding from history (plan T18). An agent adopted or restored
 * mid-session is watched from the END of its transcript, so spawns opened
 * before that point were never seen live and the spawn tree could not
 * materialize them. Watching starts with one bounded read of the history that
 * seeds the agent's still-live spawns — without replaying their activity.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  MAX_DERIVED_AGENTS_PER_TREE,
  RESTORED_SPAWN_MAX_IDLE_MS,
  SPAWN_SEED_MAX_BYTES,
} from '../src/constants.js';
import { readNewLines, scanAllTeammateFiles, startFileWatching } from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import type { AgentState } from '../src/types.js';

const SESSION = '5eed0000-1111-4222-8333-944445555666';
const RUN_ID = 'wf_5eed0000-abc';

// ── Record builders (real shapes, anonymized) ──

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

function toolUse(toolId: string, name: string, input: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolId, name, input }] },
  });
}

function toolResult(toolId: string, text = 'Here is my report.'): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: text }] },
  });
}

function asyncLaunchResult(toolId: string, key: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolId,
          content: [
            {
              type: 'text',
              text: `Async agent launched successfully.\nagentId: ${key} (internal ID)\nThe agent is working in the background.`,
            },
          ],
        },
      ],
    },
  });
}

/** Current CLI completion notice: only the task id, no tool-use id. */
function taskIdCompletion(taskId: string, status = 'completed'): string {
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    content: `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>Agent "x" ${status}</summary>\n</task-notification>`,
  });
}

function userPrompt(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

function turnEnd(): string {
  return JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 10 });
}

function workflowToolUse(toolId: string, name = 'fase-1'): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: toolId,
          name: 'Workflow',
          input: {
            script: `export const meta = {\n  name: '${name}',\n  description: 'x',\n};\nexport default async function run(ctx) {}\n`,
          },
        },
      ],
    },
  });
}

function workflowLaunched(toolId: string, runDir: string): string {
  return JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        {
          tool_use_id: toolId,
          type: 'tool_result',
          content:
            'Workflow launched in background. Task ID: wseed1\n' +
            'Summary: Fase uno\n' +
            `Transcript dir: ${runDir}\n` +
            'Script file: fase-1-wf_5eed0000-abc.js\n',
        },
      ],
    },
  });
}

/** Let the seeding's deferred materialization (a microtask) run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeAdapter(loadAgents: () => unknown[] = () => []): StateAdapter {
  return {
    loadAgents: loadAgents as never,
    saveAgents: () => {},
    loadSeats: () => ({}),
    saveSeats: () => {},
    getSetting: <T>(_key: string, defaultValue: T) => defaultValue,
    setSetting: () => {},
  };
}

describe('spawn seeding from history (T18)', () => {
  let tmpRoot: string;
  let subagentsDir: string;
  let runDir: string;
  let rootJsonl: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let messages: Array<Record<string, unknown>>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-seed-'));
    subagentsDir = path.join(tmpRoot, SESSION, 'subagents');
    runDir = path.join(subagentsDir, 'workflows', RUN_ID);
    fs.mkdirSync(runDir, { recursive: true });
    rootJsonl = path.join(tmpRoot, `${SESSION}.jsonl`);
    store = new AgentStateStore();
    store.setAdapter(fakeAdapter());
    runtime = new AgentRuntime(store, claudeProvider);
    store.nextAgentId.current = 2;
    messages = [];
    store.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
  });

  afterEach(() => {
    runtime.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── Helpers ──

  function writeRootHistory(lines: string[]): void {
    fs.writeFileSync(rootJsonl, lines.map((l) => l + '\n').join(''));
  }

  function writeSidecar(key: string, meta: Record<string, unknown>, lines: string[] = []): string {
    const jsonlPath = path.join(subagentsDir, `agent-${key}.jsonl`);
    fs.writeFileSync(jsonlPath, lines.map((l) => l + '\n').join(''));
    fs.writeFileSync(path.join(subagentsDir, `agent-${key}.meta.json`), JSON.stringify(meta));
    return jsonlPath;
  }

  function writeRunAgent(key: string, agentType: string): string {
    const jsonlPath = path.join(runDir, `agent-${key}.jsonl`);
    const first = {
      isSidechain: true,
      agentId: key,
      type: 'user',
      message: { role: 'user', content: `Tarea de ${key}` },
    };
    fs.writeFileSync(jsonlPath, JSON.stringify(first) + '\n');
    fs.writeFileSync(
      path.join(runDir, `agent-${key}.meta.json`),
      JSON.stringify({ agentType, spawnDepth: 1 }),
    );
    return jsonlPath;
  }

  function rootShell(fileOffset: number): AgentState {
    return {
      id: 1,
      sessionId: SESSION,
      terminalRef: undefined,
      isExternal: true,
      projectDir: tmpRoot,
      jsonlFile: rootJsonl,
      fileOffset,
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
      palette: 1,
      hueShift: 0,
    } as AgentState;
  }

  /** Adopt the root the way the adoption paths do: offset at end-of-file,
   *  then watching starts. */
  async function adoptRoot(): Promise<AgentState> {
    const root = rootShell(fs.statSync(rootJsonl).size);
    store.set(1, root);
    startFileWatching(
      1,
      rootJsonl,
      store,
      runtime.fileWatchers,
      runtime.pollingTimers,
      runtime.waitingTimers,
      runtime.permissionTimers,
    );
    await flush();
    return root;
  }

  /** The 1 s project-scan tick (the only place workflow runs are scanned). */
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

  function maybeByKey(key: string): AgentState | undefined {
    return [...store.values()].find((a) => a.spawnAgentKey === key);
  }

  function derived(): AgentState[] {
    return [...store.values()].filter((a) => a.parentAgentId !== undefined);
  }

  function makeOld(file: string): void {
    const old = new Date(Date.now() - RESTORED_SPAWN_MAX_IDLE_MS - 60_000);
    fs.utimesSync(file, old, old);
  }

  // ── (1) foreground spawn still open ──

  it('(1) an adopted root with an open foreground spawn gets its derived agent', async () => {
    writeRootHistory([userPrompt('go'), spawnToolUse('toolu_F')]);
    writeSidecar('aaa1', { agentType: 'desarrollador', toolUseId: 'toolu_F', spawnDepth: 1 });
    const root = await adoptRoot();
    expect(root.activeToolIds.has('toolu_F')).toBe(true);
    expect(maybeByKey('aaa1')).toMatchObject({ parentAgentId: 1, role: 'desarrollador', depth: 1 });
    // Its tool_result arriving live closes it like any spawn: it walks out.
    fs.appendFileSync(rootJsonl, toolResult('toolu_F') + '\n');
    readNewLines(1, store, runtime.waitingTimers, runtime.permissionTimers);
    expect(maybeByKey('aaa1')?.presence).toBe('leaving');
  });

  it('(1) the restore path seeds too (standalone restoreExternalAgents)', async () => {
    writeRootHistory([userPrompt('go'), spawnToolUse('toolu_R')]);
    writeSidecar('aaa2', { agentType: 'Explore', toolUseId: 'toolu_R', spawnDepth: 1 });
    const restoredStore = new AgentStateStore();
    restoredStore.setAdapter(
      fakeAdapter(() => [
        {
          id: 5,
          sessionId: SESSION,
          terminalName: '',
          isExternal: true,
          jsonlFile: rootJsonl,
          projectDir: tmpRoot,
        },
      ]),
    );
    const restoredRuntime = new AgentRuntime(restoredStore, claudeProvider);
    try {
      restoredRuntime.restoreExternalAgents();
      await flush();
      const child = [...restoredStore.values()].find((a) => a.spawnAgentKey === 'aaa2');
      expect(child).toMatchObject({ parentAgentId: 5 });
    } finally {
      restoredRuntime.dispose();
    }
  });

  // ── (2) spawn already closed ──

  it('(2) a spawn whose tool_result is already in the history does not appear', async () => {
    writeRootHistory([spawnToolUse('toolu_D'), toolResult('toolu_D')]);
    writeSidecar('aaa3', { agentType: 'Explore', toolUseId: 'toolu_D', spawnDepth: 1 });
    const root = await adoptRoot();
    tick();
    expect(derived()).toEqual([]);
    expect(root.activeToolIds.size).toBe(0);
  });

  it('(2) a foreground spawn dropped at turn end or by a new prompt is not live', async () => {
    writeRootHistory([
      spawnToolUse('toolu_T1'),
      turnEnd(),
      spawnToolUse('toolu_T2'),
      userPrompt('otra'),
    ]);
    writeSidecar('aaa4', { agentType: 'Explore', toolUseId: 'toolu_T1', spawnDepth: 1 });
    writeSidecar('aaa5', { agentType: 'Explore', toolUseId: 'toolu_T2', spawnDepth: 1 });
    await adoptRoot();
    tick();
    expect(derived()).toEqual([]);
  });

  // ── (3) background spawns ──

  it('(3) an async spawn completed by <task-id> in the history comes back available (docs/adr/0003)', async () => {
    writeRootHistory([
      spawnToolUse('toolu_B1'),
      asyncLaunchResult('toolu_B1', 'bbb1'),
      taskIdCompletion('bbb1'),
    ]);
    writeSidecar('bbb1', { agentType: 'Explore', toolUseId: 'toolu_B1', spawnDepth: 1 });
    const root = await adoptRoot();
    tick();
    // Finishing is not leaving: still live on the root, resumable, at its desk.
    expect(root.backgroundAgentToolIds.has('toolu_B1')).toBe(true);
    expect(root.activeToolIds.has('toolu_B1')).toBe(false);
    expect(derived()).toHaveLength(1);
    expect(maybeByKey('bbb1')).toMatchObject({ parentAgentId: 1, presence: 'available' });
  });

  it('(3) an async spawn killed or stopped in the history does not appear', async () => {
    writeRootHistory([
      spawnToolUse('toolu_K1'),
      asyncLaunchResult('toolu_K1', 'kil1'),
      spawnToolUse('toolu_K2'),
      asyncLaunchResult('toolu_K2', 'kil2'),
      taskIdCompletion('kil1', 'killed'),
      taskIdCompletion('kil2', 'completed'),
      taskIdCompletion('kil2', 'stopped'),
    ]);
    writeSidecar('kil1', { agentType: 'Explore', toolUseId: 'toolu_K1', spawnDepth: 1 });
    writeSidecar('kil2', { agentType: 'Explore', toolUseId: 'toolu_K2', spawnDepth: 1 });
    const root = await adoptRoot();
    tick();
    expect(derived()).toEqual([]);
    expect(root.backgroundAgentToolIds.size).toBe(0);
  });

  it('(3) a spawn its parent stopped with TaskStop in the history does not appear', async () => {
    writeRootHistory([
      spawnToolUse('toolu_T1'),
      asyncLaunchResult('toolu_T1', 'tst1'),
      taskIdCompletion('tst1'),
      toolUse('toolu_stop', 'TaskStop', { task_id: 'tst1' }),
      toolResult('toolu_stop', 'stopped'),
      spawnToolUse('toolu_T2'),
      asyncLaunchResult('toolu_T2', 'tst2'),
      toolUse('toolu_stop2', 'TaskStop', { task_id: 'someone-else' }),
      toolResult('toolu_stop2', 'stopped'),
      // A denied stop leaves its task alive.
      toolUse('toolu_stop3', 'TaskStop', { task_id: 'tst2' }),
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_stop3', is_error: true, content: 'denied' },
          ],
        },
      }),
    ]);
    writeSidecar('tst1', { agentType: 'Explore', toolUseId: 'toolu_T1', spawnDepth: 1 });
    writeSidecar('tst2', { agentType: 'Explore', toolUseId: 'toolu_T2', spawnDepth: 1 }, [
      userPrompt('trabaja'),
    ]);
    const root = await adoptRoot();
    tick();
    expect(maybeByKey('tst1')).toBeUndefined();
    expect(maybeByKey('tst2')).toBeDefined();
    expect([...root.backgroundAgentToolIds]).toEqual(['toolu_T2']);
  });

  it('(3) a stop whose result lands after adoption is settled live', async () => {
    writeRootHistory([
      spawnToolUse('toolu_P1'),
      asyncLaunchResult('toolu_P1', 'pst1'),
      toolUse('toolu_stopP', 'TaskStop', { task_id: 'pst1' }),
    ]);
    writeSidecar('pst1', { agentType: 'Explore', toolUseId: 'toolu_P1', spawnDepth: 1 }, [
      userPrompt('trabaja'),
    ]);
    const root = await adoptRoot();
    tick();
    expect(maybeByKey('pst1')?.presence).toBe('working');
    fs.appendFileSync(rootJsonl, toolResult('toolu_stopP', 'stopped') + '\n');
    readNewLines(1, store, runtime.waitingTimers, runtime.permissionTimers);
    expect(maybeByKey('pst1')?.presence).toBe('leaving');
    expect(root.backgroundAgentToolIds.size).toBe(0);
  });

  it('(3) an async spawn without completion appears; live, completed keeps it and killed ends it', async () => {
    writeRootHistory([spawnToolUse('toolu_B2'), asyncLaunchResult('toolu_B2', 'bbb2'), turnEnd()]);
    writeSidecar('bbb2', { agentType: 'Explore', toolUseId: 'toolu_B2', spawnDepth: 1 });
    const root = await adoptRoot();
    expect(root.backgroundAgentToolIds.has('toolu_B2')).toBe(true);
    expect(maybeByKey('bbb2')).toMatchObject({
      parentAgentId: 1,
      spawnToolUseId: 'toolu_B2',
      presence: 'working',
    });
    fs.appendFileSync(rootJsonl, taskIdCompletion('bbb2') + '\n');
    readNewLines(1, store, runtime.waitingTimers, runtime.permissionTimers);
    expect(maybeByKey('bbb2')?.presence).toBe('available');
    expect(root.backgroundAgentToolIds.size).toBe(1);
    fs.appendFileSync(rootJsonl, taskIdCompletion('bbb2', 'killed') + '\n');
    readNewLines(1, store, runtime.waitingTimers, runtime.permissionTimers);
    expect(maybeByKey('bbb2')?.presence).toBe('leaving');
    expect(root.backgroundAgentToolIds.size).toBe(0);
  });

  // ── (4) a tree already three levels deep ──

  it('(4) a three-level tree in progress reappears whole', async () => {
    writeRootHistory([userPrompt('equipo'), spawnToolUse('toolu_L')]);
    writeSidecar('ccc1', { agentType: 'lider-fase', toolUseId: 'toolu_L', spawnDepth: 1 }, [
      userPrompt('fase'),
      spawnToolUse('toolu_A'),
    ]);
    writeSidecar(
      'ccc2',
      { agentType: 'desarrollador', toolUseId: 'toolu_A', parentAgentId: 'ccc1', spawnDepth: 2 },
      [
        userPrompt('tarea'),
        spawnToolUse('toolu_Bq', { run_in_background: true }),
        asyncLaunchResult('toolu_Bq', 'ccc3'),
      ],
    );
    writeSidecar('ccc3', {
      agentType: 'qa-revisor',
      toolUseId: 'toolu_Bq',
      parentAgentId: 'ccc2',
      spawnDepth: 3,
    });
    await adoptRoot();
    const l1 = maybeByKey('ccc1');
    const l2 = maybeByKey('ccc2');
    const l3 = maybeByKey('ccc3');
    expect(l1).toMatchObject({ parentAgentId: 1, depth: 1 });
    expect(l2).toMatchObject({ parentAgentId: l1!.id, depth: 2 });
    expect(l3).toMatchObject({ parentAgentId: l2!.id, depth: 3 });
  });

  // ── (5) workflow runs ──

  it('(5) a launched, uncompleted Workflow brings back its node and its agents', async () => {
    writeRootHistory([workflowToolUse('toolu_W'), workflowLaunched('toolu_W', runDir), turnEnd()]);
    writeRunAgent('ddd1', 'backend-java');
    const root = await adoptRoot();
    const node = [...store.values()].find((a) => a.nodeKind === 'workflow');
    expect(node).toMatchObject({ parentAgentId: 1, spawnToolUseId: 'toolu_W', label: 'fase-1' });
    expect(root.backgroundAgentToolIds.has('toolu_W')).toBe(true);
    tick();
    expect(maybeByKey('ddd1')).toMatchObject({ parentAgentId: node!.id });
  });

  it('(5) a completed Workflow does not come back', async () => {
    writeRootHistory([
      workflowToolUse('toolu_W2'),
      workflowLaunched('toolu_W2', runDir),
      taskIdCompletion('wseed1'),
    ]);
    writeRunAgent('ddd2', 'backend-java');
    await adoptRoot();
    tick();
    expect(derived()).toEqual([]);
  });

  // ── (6) history larger than the cap ──

  it('(6) a history larger than the cap is read from its tail only, and never throws', async () => {
    const filler = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'x'.repeat(4000) }] },
    });
    const lines: string[] = [spawnToolUse('toolu_OLD'), 'not json {{{'];
    let size = 0;
    while (size < SPAWN_SEED_MAX_BYTES + 256 * 1024) {
      lines.push(filler);
      size += filler.length + 1;
    }
    lines.push('{"type":"assistant","message":'); // malformed
    lines.push(spawnToolUse('toolu_NEW'));
    writeRootHistory(lines);
    writeSidecar('eee1', { agentType: 'Explore', toolUseId: 'toolu_OLD', spawnDepth: 1 });
    writeSidecar('eee2', { agentType: 'Explore', toolUseId: 'toolu_NEW', spawnDepth: 1 });
    const started = Date.now();
    const root = await adoptRoot();
    expect(Date.now() - started).toBeLessThan(2000);
    // The old spawn is outside the window: unseen, like before T18.
    expect(root.activeToolIds.has('toolu_OLD')).toBe(false);
    expect(maybeByKey('eee1')).toBeUndefined();
    expect(maybeByKey('eee2')).toBeDefined();
  });

  // ── (7) no replay of history ──

  it('(7) seeding broadcasts no historical activity and arms no timers', async () => {
    writeRootHistory([
      userPrompt('go'),
      toolUse('toolu_bash', 'Bash', { command: 'sleep 100' }),
      spawnToolUse('toolu_S'),
    ]);
    writeSidecar('fff1', { agentType: 'Explore', toolUseId: 'toolu_S', spawnDepth: 1 });
    const root = await adoptRoot();
    expect(maybeByKey('fff1')).toBeDefined();
    const rootMessages = messages.filter((m) => m.id === 1);
    expect(rootMessages.filter((m) => m.type === 'agentToolStart')).toEqual([]);
    expect(rootMessages.filter((m) => m.type === 'agentStatus')).toEqual([]);
    expect(runtime.permissionTimers.has(1)).toBe(false);
    expect(runtime.waitingTimers.has(1)).toBe(false);
    // Only spawns are seeded: the open Bash stays unseen.
    expect(root.activeToolIds.has('toolu_bash')).toBe(false);
  });

  // ── (8) dismissal ──

  it('(8) a derived agent the user closed does not come back', async () => {
    writeRootHistory([spawnToolUse('toolu_X')]);
    const childJsonl = writeSidecar('ggg1', {
      agentType: 'Explore',
      toolUseId: 'toolu_X',
      spawnDepth: 1,
    });
    await adoptRoot();
    const child = maybeByKey('ggg1')!;
    expect(child).toBeDefined();
    // The user closes the character.
    runtime.dismissalTracker.dismiss(childJsonl);
    runtime.removeAgent(child.id);
    tick();
    expect(maybeByKey('ggg1')).toBeUndefined();
    // Re-adopting the root seeds the same live spawn again: still gone.
    runtime.removeAgent(1);
    await adoptRoot();
    tick();
    expect(maybeByKey('ggg1')).toBeUndefined();
  });

  // ── Dead trees and duplicates ──

  it('a dead session (root and spawn quiet for long) is not resurrected', async () => {
    writeRootHistory([spawnToolUse('toolu_Z'), asyncLaunchResult('toolu_Z', 'hhh1')]);
    const childJsonl = writeSidecar('hhh1', {
      agentType: 'Explore',
      toolUseId: 'toolu_Z',
      spawnDepth: 1,
    });
    makeOld(rootJsonl);
    makeOld(childJsonl);
    const root = await adoptRoot();
    tick();
    expect(derived()).toEqual([]);
    expect(root.backgroundAgentToolIds.size).toBe(0);
  });

  it('a quiet root waiting on a busy background spawn keeps it', async () => {
    writeRootHistory([spawnToolUse('toolu_Y'), asyncLaunchResult('toolu_Y', 'iii1'), turnEnd()]);
    writeSidecar('iii1', { agentType: 'Explore', toolUseId: 'toolu_Y', spawnDepth: 1 }, [
      userPrompt('trabajo'),
    ]);
    makeOld(rootJsonl);
    await adoptRoot();
    expect(maybeByKey('iii1')).toBeDefined();
  });

  it('a restored persisted spawn completed while the server was down comes back available', async () => {
    writeRootHistory([
      spawnToolUse('toolu_P'),
      asyncLaunchResult('toolu_P', 'jjj1'),
      turnEnd(),
      taskIdCompletion('jjj1'),
    ]);
    writeSidecar('jjj1', { agentType: 'Explore', toolUseId: 'toolu_P', spawnDepth: 1 });
    const restoredStore = new AgentStateStore();
    restoredStore.setAdapter(
      fakeAdapter(() => [
        {
          id: 5,
          sessionId: SESSION,
          terminalName: '',
          isExternal: true,
          jsonlFile: rootJsonl,
          projectDir: tmpRoot,
          backgroundAgentToolIds: ['toolu_P'],
        },
      ]),
    );
    const restoredRuntime = new AgentRuntime(restoredStore, claudeProvider);
    try {
      restoredRuntime.restoreExternalAgents();
      await flush();
      expect([...restoredStore.get(5)!.backgroundAgentToolIds]).toEqual(['toolu_P']);
      const kids = [...restoredStore.values()].filter((a) => a.parentAgentId !== undefined);
      expect(kids.map((k) => k.presence)).toEqual(['available']);
    } finally {
      restoredRuntime.dispose();
    }
  });

  it('a restored persisted spawn killed while the server was down is dropped', async () => {
    writeRootHistory([
      spawnToolUse('toolu_P'),
      asyncLaunchResult('toolu_P', 'jjj1'),
      turnEnd(),
      taskIdCompletion('jjj1', 'killed'),
    ]);
    writeSidecar('jjj1', { agentType: 'Explore', toolUseId: 'toolu_P', spawnDepth: 1 });
    const restoredStore = new AgentStateStore();
    restoredStore.setAdapter(
      fakeAdapter(() => [
        {
          id: 5,
          sessionId: SESSION,
          terminalName: '',
          isExternal: true,
          jsonlFile: rootJsonl,
          projectDir: tmpRoot,
          backgroundAgentToolIds: ['toolu_P'],
        },
      ]),
    );
    const restoredRuntime = new AgentRuntime(restoredStore, claudeProvider);
    try {
      restoredRuntime.restoreExternalAgents();
      await flush();
      expect(restoredStore.get(5)!.backgroundAgentToolIds.size).toBe(0);
      restoredRuntime.scanTree(5);
      expect([...restoredStore.values()].filter((a) => a.parentAgentId !== undefined)).toEqual([]);
    } finally {
      restoredRuntime.dispose();
    }
  });

  it('seeding never duplicates a derived agent (repeat watch + periodic scans)', async () => {
    writeRootHistory([spawnToolUse('toolu_U')]);
    writeSidecar('kkk1', { agentType: 'Explore', toolUseId: 'toolu_U', spawnDepth: 1 });
    await adoptRoot();
    // Watching restarts on the same agent (e.g. the VS Code restore retry).
    startFileWatching(
      1,
      rootJsonl,
      store,
      runtime.fileWatchers,
      runtime.pollingTimers,
      runtime.waitingTimers,
      runtime.permissionTimers,
    );
    tick();
    tick();
    expect([...store.values()].filter((a) => a.spawnAgentKey === 'kkk1')).toHaveLength(1);
  });

  it('an agent watched from the start of its transcript is not seeded (it replays)', async () => {
    writeRootHistory([spawnToolUse('toolu_V'), toolResult('toolu_V')]);
    const root = rootShell(0);
    store.set(1, root);
    startFileWatching(
      1,
      rootJsonl,
      store,
      runtime.fileWatchers,
      runtime.pollingTimers,
      runtime.waitingTimers,
      runtime.permissionTimers,
    );
    expect(root.activeToolIds.size).toBe(0);
    expect(root.backgroundAgentToolIds.size).toBe(0);
  });

  // ── Review follow-ups ──

  it('restore with low persisted ids: seeded children never take a root id', async () => {
    const other = path.join(tmpRoot, 'other-root.jsonl');
    fs.writeFileSync(other, userPrompt('hola') + '\n');
    writeRootHistory([spawnToolUse('toolu_R1'), spawnToolUse('toolu_R2')]);
    writeSidecar('lll1', { agentType: 'Explore', toolUseId: 'toolu_R1', spawnDepth: 1 });
    writeSidecar('lll2', { agentType: 'Explore', toolUseId: 'toolu_R2', spawnDepth: 1 });
    const restoredStore = new AgentStateStore();
    restoredStore.setAdapter(
      fakeAdapter(() => [
        {
          id: 1,
          sessionId: SESSION,
          terminalName: '',
          isExternal: true,
          jsonlFile: rootJsonl,
          projectDir: tmpRoot,
        },
        {
          id: 2,
          sessionId: 'other-root',
          terminalName: '',
          isExternal: true,
          jsonlFile: other,
          projectDir: tmpRoot,
        },
      ]),
    );
    const restoredRuntime = new AgentRuntime(restoredStore, claudeProvider);
    try {
      restoredRuntime.restoreExternalAgents();
      await flush();
      expect(restoredStore.get(1)).toMatchObject({ jsonlFile: rootJsonl });
      expect(restoredStore.get(1)!.parentAgentId).toBeUndefined();
      expect(restoredStore.get(2)).toMatchObject({ jsonlFile: other });
      const kids = [...restoredStore.values()].filter((a) => a.parentAgentId !== undefined);
      expect(kids.map((k) => k.spawnAgentKey).sort()).toEqual(['lll1', 'lll2']);
      for (const k of kids) {
        expect(k.id).toBeGreaterThan(2);
        expect(k.parentAgentId).toBe(1);
      }
    } finally {
      restoredRuntime.dispose();
    }
  });

  it('a spawn continued with SendMessage completes by <task-id>, not the SendMessage id', async () => {
    const notice = (taskId: string, toolId: string): string =>
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolId}</tool-use-id>\n<status>completed</status>\n</task-notification>`,
      });
    writeRootHistory([
      spawnToolUse('toolu_S1'),
      asyncLaunchResult('toolu_S1', 'sss1'),
      toolUse('toolu_SM1', 'SendMessage', { to: 'sss1', message: 'sigue' }),
      toolResult('toolu_SM1', 'sent'),
      notice('sss1', 'toolu_SM1'),
      spawnToolUse('toolu_S2'),
      asyncLaunchResult('toolu_S2', 'sss2'),
    ]);
    writeSidecar('sss1', { agentType: 'Explore', toolUseId: 'toolu_S1', spawnDepth: 1 });
    writeSidecar('sss2', { agentType: 'Explore', toolUseId: 'toolu_S2', spawnDepth: 1 });
    const root = await adoptRoot();
    // Completed (after its SendMessage) = available, not gone (docs/adr/0003).
    expect(maybeByKey('sss1')?.presence).toBe('available');
    expect(maybeByKey('sss2')?.presence).toBe('working');
    // Live, the same notice shape finishes the running one.
    fs.appendFileSync(
      rootJsonl,
      toolUse('toolu_SM2', 'SendMessage', { to: 'sss2' }) +
        '\n' +
        toolResult('toolu_SM2', 'sent') +
        '\n' +
        notice('sss2', 'toolu_SM2') +
        '\n',
    );
    readNewLines(1, store, runtime.waitingTimers, runtime.permissionTimers);
    expect(maybeByKey('sss2')?.presence).toBe('available');
    expect(root.backgroundAgentToolIds.size).toBe(2);
  });

  it('a record half-written at adoption is read whole by the live stream', async () => {
    const result = toolResult('toolu_H');
    const half = Math.floor(result.length / 2);
    fs.writeFileSync(rootJsonl, spawnToolUse('toolu_H') + '\n' + result.slice(0, half));
    writeSidecar('mmm1', { agentType: 'Explore', toolUseId: 'toolu_H', spawnDepth: 1 });
    await adoptRoot();
    expect(maybeByKey('mmm1')).toBeDefined();
    fs.appendFileSync(rootJsonl, result.slice(half) + '\n');
    readNewLines(1, store, runtime.waitingTimers, runtime.permissionTimers);
    expect(maybeByKey('mmm1')?.presence).toBe('leaving');
  });

  it('a named spawn is seeded as a teammate spawn and its seat is a Teammate', async () => {
    writeRootHistory([spawnToolUse('toolu_N', { name: 'revisor' })]);
    writeSidecar('nnn1', {
      agentType: 'Explore',
      toolUseId: 'toolu_N',
      spawnDepth: 1,
      name: 'revisor',
    });
    const root = await adoptRoot();
    expect(root.teammateSpawnToolIds?.has('toolu_N')).toBe(true);
    expect(root.hadToolsInTurn).toBe(true);
    expect(maybeByKey('nnn1')).toMatchObject({ agentName: 'revisor', leadAgentId: 1 });
  });

  it('only the newest MAX_DERIVED_AGENTS_PER_TREE live spawns are seeded', async () => {
    const lines: string[] = [];
    for (let i = 0; i < MAX_DERIVED_AGENTS_PER_TREE + 5; i++)
      lines.push(spawnToolUse(`toolu_c${i}`));
    writeRootHistory(lines);
    const root = await adoptRoot();
    expect(root.activeToolIds.size).toBe(MAX_DERIVED_AGENTS_PER_TREE);
    expect(root.activeToolIds.has('toolu_c0')).toBe(false);
    expect(root.activeToolIds.has(`toolu_c${MAX_DERIVED_AGENTS_PER_TREE + 4}`)).toBe(true);
  });

  it('a background spawn of an earlier CLI run (resumed session) is not resurrected', async () => {
    // Launched, the CLI exited (its background agent died, no notice), then
    // `--resume` kept writing to the same transcript: the root is fresh.
    writeRootHistory([
      userPrompt('go'),
      spawnToolUse('toolu_OLDRUN'),
      asyncLaunchResult('toolu_OLDRUN', 'ooo1'),
      turnEnd(),
      userPrompt('resumed'),
      turnEnd(),
    ]);
    const childJsonl = writeSidecar('ooo1', {
      agentType: 'Explore',
      toolUseId: 'toolu_OLDRUN',
      spawnDepth: 1,
    });
    makeOld(childJsonl);
    const root = await adoptRoot();
    tick();
    expect(maybeByKey('ooo1')).toBeUndefined();
    expect(root.backgroundAgentToolIds.size).toBe(0);
  });

  it('a workflow run whose agents went quiet long ago is not resurrected', async () => {
    writeRootHistory([workflowToolUse('toolu_WOLD'), workflowLaunched('toolu_WOLD', runDir)]);
    makeOld(writeRunAgent('qqq1', 'backend-java'));
    const root = await adoptRoot();
    tick();
    expect(derived()).toEqual([]);
    expect(root.backgroundAgentToolIds.size).toBe(0);
  });
});
