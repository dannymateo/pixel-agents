/**
 * Workflow nodes in the spawn tree (spec §2.1b, plan T17): a `Workflow` launch
 * becomes a derived node with no transcript of its own; the run's agents hang
 * under it. Fixtures follow the real on-disk shape (anonymized) of
 * `<projectDir>/<sessionId>/subagents/workflows/wf_<id>/`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { TeamProvider } from '../../core/src/teamProvider.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  MAX_DERIVED_AGENTS_PER_TREE,
  MAX_PENDING_WORKFLOW_LAUNCHES,
  PERMISSION_TIMER_DELAY_MS,
  TEXT_IDLE_DELAY_MS,
} from '../src/constants.js';
import { readNewLines, scanAllTeammateFiles } from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { claudeTeamProvider } from '../src/providers/hook/claude/claudeTeamProvider.js';
import {
  discoverClaudeWorkflowAgents,
  extractClaudeWorkflowLaunch,
} from '../src/providers/hook/claude/claudeWorkflow.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

const LEAD_SESSION = '3e007f79-d1f2-4c65-81d0-7c5acbf43666';
const RUN_ID = 'wf_9b94fdcd-8af';
const WF_TOOL = 'toolu_01RV541Va7hFfbnXVQvZ7pk2';

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
    palette: 2,
    hueShift: 0,
  } as AgentState;
}

/** Real shape of the Workflow tool_use (script trimmed). */
function workflowToolUse(toolId: string, name = 'transferencias-fase-1-lectura'): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: toolId,
          name: 'Workflow',
          input: {
            script: `export const meta = {\n  name: '${name}',\n  description: 'Implementa 3 endpoints',\n};\n\nexport default async function run(ctx) {}\n`,
          },
        },
      ],
    },
  });
}

/** Real shape of the Workflow tool_result. */
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
            'Workflow launched in background. Task ID: w4eubwvnv\n' +
            'Summary: Implementa 3 endpoints de lectura de transferencias en paralelo\n' +
            `Transcript dir: ${runDir}\n` +
            'Script file: transferencias-fase-1-lectura-wf_9b94fdcd-8af.js\n',
        },
      ],
    },
  });
}

/** Real shape of the completion notification (status completed or failed). */
function workflowCompleted(toolId: string, status = 'completed'): string {
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    sessionId: LEAD_SESSION,
    content: `<task-notification>\n<task-id>w4eubwvnv</task-id>\n<tool-use-id>${toolId}</tool-use-id>\n<status>${status}</status>\n<summary>Dynamic workflow "x" ${status}</summary>\n</task-notification>`,
  });
}

function toolUse(toolId: string, name: string, input: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: toolId, name, input }] },
  });
}

function turnEnd(): string {
  return JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 10 });
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

describe('workflow nodes (spec §2.1b)', () => {
  let tmpRoot: string;
  let runDir: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let lead: AgentState;
  let messages: Array<Record<string, unknown>>;
  let adapter: ReturnType<typeof fakeAdapter>;
  /** Overridable discovery, so a test can hand the host hostile entries. */
  let discover: (runDir: string) => ReturnType<NonNullable<TeamProvider['discoverWorkflowAgents']>>;
  let provider: HookProvider;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-wf-'));
    runDir = path.join(tmpRoot, LEAD_SESSION, 'subagents', 'workflows', RUN_ID);
    fs.mkdirSync(runDir, { recursive: true });
    discover = discoverClaudeWorkflowAgents;
    // S2 registers these on claudeTeamProvider; until then the test wires them.
    const team: TeamProvider = {
      ...claudeTeamProvider,
      extractWorkflowLaunch: extractClaudeWorkflowLaunch,
      discoverWorkflowAgents: (dir) => discover(dir),
    };
    provider = { ...claudeProvider, team };
    store = new AgentStateStore();
    adapter = fakeAdapter();
    store.setAdapter(adapter);
    runtime = new AgentRuntime(store, provider);
    lead = createLeadAgent(tmpRoot);
    store.set(1, lead);
    store.nextAgentId.current = 2;
    messages = [];
    store.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
  });

  afterEach(() => {
    vi.useRealTimers();
    runtime.dispose();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function leadLine(line: string): void {
    processTranscriptLine(1, line, store, runtime.waitingTimers, runtime.permissionTimers);
  }

  function agentLine(id: number, line: string): void {
    processTranscriptLine(id, line, store, runtime.waitingTimers, runtime.permissionTimers);
  }

  /** The 1 s project-scan tick (the only place runs are scanned). */
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

  function writeRunAgent(
    key: string,
    agentType: string,
    opts: { parentAgentId?: string; prompt?: string; dir?: string } = {},
  ): string {
    const dir = opts.dir ?? runDir;
    const jsonlPath = path.join(dir, `agent-${key}.jsonl`);
    const first = {
      parentUuid: null,
      isSidechain: true,
      agentId: key,
      type: 'user',
      message: { role: 'user', content: opts.prompt ?? `Tarea de ${key}\nDetalle largo` },
    };
    fs.writeFileSync(jsonlPath, JSON.stringify(first) + '\n');
    const meta: Record<string, unknown> = { agentType, spawnDepth: 1 };
    if (opts.parentAgentId) meta.parentAgentId = opts.parentAgentId;
    fs.writeFileSync(path.join(dir, `agent-${key}.meta.json`), JSON.stringify(meta));
    return jsonlPath;
  }

  function launch(toolId = WF_TOOL, dir = runDir, name?: string): void {
    leadLine(workflowToolUse(toolId, name));
    leadLine(workflowLaunched(toolId, dir));
  }

  function workflowNode(toolId = WF_TOOL): AgentState | undefined {
    return [...store.values()].find(
      (a) => a.nodeKind === 'workflow' && a.spawnToolUseId === toolId,
    );
  }

  function byKey(key: string): AgentState | undefined {
    return [...store.values()].find((a) => a.spawnAgentKey === key);
  }

  function derived(): AgentState[] {
    return [...store.values()].filter((a) => a.parentAgentId !== undefined);
  }

  /** Derived agents still staying (a leaving one walks out and is removed
   *  after LEAVE_ANIMATION_MAX_MS — docs/adr/0003, pinned in presence.test.ts). */
  function staying(): AgentState[] {
    return derived().filter((a) => a.presence !== 'leaving');
  }

  // ── (a) ───────────────────────────────────────────────────────

  it('(a) a "Workflow launched" result creates a workflow node under the caller, with no watcher', () => {
    launch();
    const node = workflowNode();
    expect(node).toBeDefined();
    expect(node).toMatchObject({
      nodeKind: 'workflow',
      parentAgentId: 1,
      label: 'transferencias-fase-1-lectura',
      role: 'workflow',
      depth: 1,
      spawnToolUseId: WF_TOOL,
      sessionId: LEAD_SESSION,
    });
    expect(path.normalize(node!.workflowRunDir!)).toBe(path.normalize(runDir));
    expect(node!.spawnAgentKey).toBeUndefined();
    expect(node!.jsonlFile).toBe('');
    // No transcript of its own: nothing is watched for it.
    expect(runtime.pollingTimers.has(node!.id)).toBe(false);
    expect(runtime.fileWatchers.has(node!.id)).toBe(false);
    // The launch is a live background spawn of the caller.
    expect(lead.backgroundAgentToolIds.has(WF_TOOL)).toBe(true);
    // Idle until one of its agents works.
    expect(node!.isWaiting).toBe(true);
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'agentStatus', id: node!.id, status: 'waiting' }),
    );
  });

  it('(a) a launch result of another tool name, or without launch text, creates nothing', () => {
    leadLine(toolUse('toolu_x', 'Bash', { command: 'echo' }));
    leadLine(workflowLaunched('toolu_x', runDir));
    leadLine(workflowToolUse('toolu_y'));
    leadLine(
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_y', content: 'Error: bad script' }],
        },
      }),
    );
    expect(derived()).toEqual([]);
    expect(lead.backgroundAgentToolIds.size).toBe(0);
  });

  it('(a) a derived agent launching a Workflow gets the node below itself (depth + 1)', () => {
    launch();
    writeRunAgent('a0939d8552f9f51b5', 'backend-java');
    tick();
    const runAgent = byKey('a0939d8552f9f51b5')!;
    const innerDir = path.join(tmpRoot, LEAD_SESSION, 'subagents', 'workflows', 'wf_inner-1');
    fs.mkdirSync(innerDir, { recursive: true });
    agentLine(runAgent.id, workflowToolUse('toolu_inner', 'inner'));
    agentLine(runAgent.id, workflowLaunched('toolu_inner', innerDir));
    expect(workflowNode('toolu_inner')).toMatchObject({
      parentAgentId: runAgent.id,
      depth: 3,
      label: 'inner',
    });
  });

  // ── (b) ───────────────────────────────────────────────────────

  it('(b) the 1 s scan materializes the run agents under the node (role, label, depth)', () => {
    launch();
    writeRunAgent('a0939d8552f9f51b5', 'backend-java', { prompt: 'Eres el desarrollador T7\nmas' });
    writeRunAgent('a125d7b36e0d1d5ea', 'general-purpose');
    writeRunAgent('a14d90a5c5a78405c', 'general-purpose');
    const node = workflowNode()!;

    // Event-driven scans never touch runs (cold discovery costs ~20 ms/agent).
    runtime.scanTree(1);
    expect(derived().filter((a) => a.parentAgentId === node.id)).toEqual([]);

    tick();
    const kids = derived().filter((a) => a.parentAgentId === node.id);
    expect(kids).toHaveLength(3);
    expect(byKey('a0939d8552f9f51b5')).toMatchObject({
      parentAgentId: node.id,
      role: 'backend-java',
      label: 'Eres el desarrollador T7',
      depth: 2,
      sessionId: LEAD_SESSION,
    });
    for (const k of kids) {
      expect(k.depth).toBe(2);
      expect(runtime.pollingTimers.has(k.id)).toBe(true);
    }
    // Idempotent.
    tick();
    expect(derived().filter((a) => a.parentAgentId === node.id)).toHaveLength(3);
  });

  it('(b) a run agent with parentAgentId hangs from that run agent; an unknown parent key waits, never the root', () => {
    launch();
    writeRunAgent('parentkey1', 'orquestador');
    writeRunAgent('childkey1', 'qa', { parentAgentId: 'parentkey1' });
    writeRunAgent('orphan1', 'qa', { parentAgentId: 'nobodyhere' });
    tick();
    const node = workflowNode()!;
    const parent = byKey('parentkey1')!;
    expect(parent.parentAgentId).toBe(node.id);
    expect(byKey('childkey1')).toMatchObject({ parentAgentId: parent.id, depth: 3 });
    expect(byKey('orphan1')).toBeUndefined();
    // The unknown parent shows up later: the orphan attaches to it.
    writeRunAgent('nobodyhere', 'dev');
    tick();
    expect(byKey('orphan1')?.parentAgentId).toBe(byKey('nobodyhere')!.id);
  });

  it('(b) a parent key naming an agent OUTSIDE the run is never followed', () => {
    // A regular (non-workflow) derived agent with key `outside1` exists in the tree.
    leadLine(toolUse('toolu_L', 'Agent', { description: 'x' }));
    const subDir = path.join(tmpRoot, LEAD_SESSION, 'subagents');
    fs.writeFileSync(path.join(subDir, 'agent-outside1.jsonl'), '');
    fs.writeFileSync(
      path.join(subDir, 'agent-outside1.meta.json'),
      JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_L', spawnDepth: 1 }),
    );
    runtime.scanTree(1);
    expect(byKey('outside1')).toBeDefined();
    launch();
    writeRunAgent('sneaky1', 'qa', { parentAgentId: 'outside1' });
    tick();
    expect(byKey('sneaky1')).toBeUndefined();
  });

  it('(b) the tree caps apply to run agents too (a gigantic run is clipped, one warning)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    launch();
    const entries: ReturnType<typeof discover> = [];
    for (let i = 0; i < MAX_DERIVED_AGENTS_PER_TREE + 20; i++) {
      const key = `k${i}`;
      const p = path.join(runDir, `agent-${key}.jsonl`);
      fs.writeFileSync(p, '');
      entries.push({ jsonlPath: p, agentKey: key, agentType: 'general-purpose' });
    }
    discover = () => entries;
    tick();
    tick();
    expect(derived()).toHaveLength(MAX_DERIVED_AGENTS_PER_TREE);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('Spawn tree'))).toHaveLength(1);
    warn.mockRestore();
  });

  // ── (c) and the session gate ──────────────────────────────────

  it('(c) a run whose launch already completed creates nothing', () => {
    writeRunAgent('a0939d8552f9f51b5', 'backend-java');
    launch();
    leadLine(workflowCompleted(WF_TOOL));
    tick();
    // Only the node itself, walking out: none of its run's agents appears.
    expect(staying()).toEqual([]);
    expect(derived().map((a) => a.nodeKind)).toEqual(['workflow']);
  });

  it('(c) run directories on disk without a live launch create nothing', () => {
    writeRunAgent('a0939d8552f9f51b5', 'backend-java');
    tick();
    runtime.scanTree(1);
    expect(derived()).toEqual([]);
  });

  it('a run directory of ANOTHER session (or project) is refused: no node, no live spawn, one log', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const otherDir = path.join(tmpRoot, 'other-session', 'subagents', 'workflows', RUN_ID);
    fs.mkdirSync(otherDir, { recursive: true });
    writeRunAgent('a0939d8552f9f51b5', 'backend-java', { dir: otherDir });
    launch(WF_TOOL, otherDir);
    launch('toolu_again', otherDir);
    tick();
    expect(derived()).toEqual([]);
    expect(lead.backgroundAgentToolIds.size).toBe(0);
    expect(log.mock.calls.filter((c) => String(c[0]).includes('not in session'))).toHaveLength(1);
    log.mockRestore();
  });

  it('a discovered transcript that is not a regular file directly in the run dir is never watched', (ctx) => {
    launch();
    const outsideFile = path.join(tmpRoot, 'outside.jsonl');
    fs.writeFileSync(outsideFile, '');
    const dirAsTranscript = path.join(runDir, 'agent-dirkey.jsonl');
    fs.mkdirSync(dirAsTranscript);
    const entries: ReturnType<typeof discover> = [
      { jsonlPath: outsideFile, agentKey: 'outkey', agentType: 'x' },
      { jsonlPath: dirAsTranscript, agentKey: 'dirkey', agentType: 'x' },
    ];
    const linkPath = path.join(runDir, 'agent-linkkey.jsonl');
    let haveLink = false;
    try {
      fs.symlinkSync(outsideFile, linkPath, 'file');
      haveLink = true;
      entries.push({ jsonlPath: linkPath, agentKey: 'linkkey', agentType: 'x' });
    } catch {
      /* symlinks need privileges on Windows: covered by the other two entries */
    }
    discover = () => entries;
    tick();
    expect(derived().filter((a) => a.nodeKind !== 'workflow')).toEqual([]);
    if (!haveLink) ctx.annotate('symlink case skipped (no privilege)');
  });

  // ── (d) ───────────────────────────────────────────────────────

  it('(d) the completion queue-operation walks the node and its whole subtree out', () => {
    launch();
    writeRunAgent('parentkey1', 'orquestador');
    writeRunAgent('childkey1', 'qa', { parentAgentId: 'parentkey1' });
    tick();
    expect(derived()).toHaveLength(3);
    const ids = derived().map((a) => a.id);
    leadLine(workflowCompleted(WF_TOOL, 'failed'));
    expect(staying()).toEqual([]);
    for (const id of ids) expect(runtime.pollingTimers.has(id)).toBe(false);
    expect(lead.backgroundAgentToolIds.has(WF_TOOL)).toBe(false);
    // Nothing comes back on the next tick.
    tick();
    expect(staying()).toEqual([]);
    expect(derived()).toHaveLength(3);
  });

  it('(d) a completion notice carrying only <task-id> (current CLI) ends the node', () => {
    // The launch result says "Task ID: w4eubwvnv"; current notices omit
    // <tool-use-id> and name only that task id.
    launch();
    writeRunAgent('parentkey1', 'orquestador');
    tick();
    expect(derived()).toHaveLength(2);
    leadLine(
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content:
          '<task-notification>\n<task-id>w4eubwvnv</task-id>\n<status>completed</status>\n<summary>Dynamic workflow "x" completed</summary>\n</task-notification>',
      }),
    );
    expect(staying()).toEqual([]);
    expect(lead.backgroundAgentToolIds.has(WF_TOOL)).toBe(false);
  });

  it('(d) the node dies with its parent', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    launch();
    writeRunAgent('a0939d8552f9f51b5', 'backend-java');
    tick();
    runtime.removeAgent(1);
    expect(store.get(1)).toBeUndefined();
    expect(staying()).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(store.size).toBe(0);
  });

  it('(d) the node dies when the root session ends (no immortal node without completion)', () => {
    launch();
    tick();
    runtime.registerAgent(LEAD_SESSION, 1);
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: LEAD_SESSION,
      reason: 'exit',
    });
    expect(staying()).toEqual([]);
    tick();
    expect(staying()).toEqual([]);
  });

  // ── (e) ───────────────────────────────────────────────────────

  it('(e) node status is derived: any child active ⇒ active; all waiting ⇒ waiting', () => {
    launch();
    writeRunAgent('kid1', 'dev');
    writeRunAgent('kid2', 'qa');
    tick();
    const node = workflowNode()!;
    const kid1 = byKey('kid1')!;
    const kid2 = byKey('kid2')!;
    const nodeStatuses = () =>
      messages.filter((m) => m.type === 'agentStatus' && m.id === node.id).map((m) => m.status);

    // Created waiting; its agents' task prompts start their turns ⇒ active.
    expect(nodeStatuses()).toEqual(['waiting', 'active']);
    expect(node.isWaiting).toBe(false);

    messages.length = 0;
    agentLine(kid1.id, toolUse('t1', 'Read', { file_path: '/a' }));
    agentLine(kid1.id, turnEnd());
    expect(nodeStatuses()).toEqual([]); // kid2 still works

    agentLine(kid2.id, turnEnd());
    expect(nodeStatuses()).toEqual(['waiting']);
    expect(node.isWaiting).toBe(true);

    // A working child leaving the run re-derives the status.
    agentLine(kid1.id, toolUse('t3', 'Read', { file_path: '/c' }));
    expect(nodeStatuses()).toEqual(['waiting', 'active']);
    expect(node.isWaiting).toBe(false);
    runtime.removeAgent(kid1.id);
    expect(nodeStatuses()).toEqual(['waiting', 'active', 'waiting']);
  });

  // ── (f) ───────────────────────────────────────────────────────

  it('(f) neither the node nor its agents are persisted, and a restore does not recreate them', () => {
    launch();
    writeRunAgent('kid1', 'dev');
    tick();
    store.persist();
    const last = adapter.saved[adapter.saved.length - 1] as Array<Record<string, unknown>>;
    expect(last.map((p) => p.id)).toEqual([1]);
    expect(JSON.stringify(last)).not.toContain('workflow');
    expect(JSON.stringify(last)).not.toContain(RUN_ID);

    // Restart: the root's live spawn id survives (existing restore rule), the
    // node does not come back from disk.
    fs.writeFileSync(lead.jsonlFile, '');
    const restoredStore = new AgentStateStore();
    restoredStore.setAdapter({
      ...fakeAdapter(),
      loadAgents: () =>
        [
          {
            id: 7,
            sessionId: LEAD_SESSION,
            terminalName: '',
            isExternal: true,
            jsonlFile: lead.jsonlFile,
            projectDir: tmpRoot,
            backgroundAgentToolIds: [WF_TOOL],
          },
        ] as never,
    });
    const restoredRuntime = new AgentRuntime(restoredStore, provider);
    try {
      restoredRuntime.restoreExternalAgents();
      scanAllTeammateFiles(
        restoredStore.nextAgentId,
        restoredStore,
        restoredRuntime.fileWatchers,
        restoredRuntime.pollingTimers,
        restoredRuntime.waitingTimers,
        restoredRuntime.permissionTimers,
        () => restoredStore.persist(),
      );
      expect([...restoredStore.values()].filter((a) => a.parentAgentId !== undefined)).toEqual([]);
    } finally {
      restoredRuntime.dispose();
    }
  });

  // ── (g) ───────────────────────────────────────────────────────

  it('(g) a launched Workflow is not left as an active tool that fires the permission timer', () => {
    vi.useFakeTimers();
    launch();
    expect(lead.activeToolIds.has(WF_TOOL)).toBe(false);
    vi.advanceTimersByTime(PERMISSION_TIMER_DELAY_MS + 1_000);
    expect(messages.some((m) => m.type === 'agentToolPermission' && m.id === 1)).toBe(false);
    // A later non-exempt tool still arms the timer normally, without the Workflow.
    leadLine(toolUse('toolu_bash', 'Bash', { command: 'sleep' }));
    leadLine(
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'ok' }] },
      }),
    );
    vi.advanceTimersByTime(PERMISSION_TIMER_DELAY_MS + 1_000);
    expect(messages.some((m) => m.type === 'agentToolPermission' && m.id === 1)).toBe(false);
  });

  it('(g) turn end with only the workflow live clears foreground tools and keeps the node', () => {
    launch();
    leadLine(toolUse('toolu_read', 'Read', { file_path: '/a' }));
    leadLine(turnEnd());
    expect(lead.activeToolIds.size).toBe(0);
    expect(lead.backgroundAgentToolIds.has(WF_TOOL)).toBe(true);
    expect(workflowNode()).toBeDefined();
    // No Subtask re-send for the Workflow tool.
    expect(
      messages.some(
        (m) => m.type === 'agentToolStart' && m.toolId === WF_TOOL && m.runInBackground === true,
      ),
    ).toBe(false);
  });

  // ── Review round (QA / pentester) ─────────────────────────────

  /** Real tail of a run agent's transcript: text, StructuredOutput, its
   *  result, end of file (no turn_duration record, ever). */
  function toolResultLine(toolId: string): string {
    return JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] },
    });
  }

  function realTail(id: number, n: string): void {
    agentLine(
      id,
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Listo, informe:' }] },
      }),
    );
    agentLine(id, toolUse(`so_${n}`, 'StructuredOutput', { informe: 'x' }));
    agentLine(
      id,
      JSON.stringify({
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: `so_${n}`, content: 'ok' }],
        },
      }),
    );
  }

  it('a run agent whose transcript just ends (real tail) goes idle, and so does the node', () => {
    vi.useFakeTimers();
    launch();
    writeRunAgent('kid1', 'dev');
    writeRunAgent('kid2', 'qa');
    tick();
    const node = workflowNode()!;
    const kid1 = byKey('kid1')!;
    const kid2 = byKey('kid2')!;
    agentLine(kid1.id, toolUse('r1', 'Read', { file_path: '/a' }));
    agentLine(kid1.id, toolResultLine('r1'));
    realTail(kid1.id, '1');
    // kid2 has been mid-work all along: the node stays active.
    agentLine(kid2.id, toolUse('r2', 'Bash', { command: 'mvn test' }));
    vi.advanceTimersByTime(TEXT_IDLE_DELAY_MS + 100);
    expect(kid1.isWaiting).toBe(true);
    expect(node.isWaiting).toBe(false);
    agentLine(
      kid2.id,
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'r2', content: 'ok' }] },
      }),
    );
    realTail(kid2.id, '2');
    vi.advanceTimersByTime(TEXT_IDLE_DELAY_MS + 100);
    expect(kid2.isWaiting).toBe(true);
    expect(node.isWaiting).toBe(true);
    // Resuming work cancels the idle and re-derives the node.
    agentLine(kid1.id, toolUse('r3', 'Read', { file_path: '/b' }));
    expect(node.isWaiting).toBe(false);
  });

  it('the idle fallback also covers run agents fed by hooks (their SubagentStop goes to the root)', () => {
    vi.useFakeTimers();
    launch();
    writeRunAgent('kid1', 'dev');
    tick();
    const kid1 = byKey('kid1')!;
    kid1.hookDelivered = true;
    agentLine(kid1.id, toolUse('r1', 'Read', { file_path: '/a' }));
    agentLine(kid1.id, toolResultLine('r1'));
    realTail(kid1.id, '1');
    vi.advanceTimersByTime(TEXT_IDLE_DELAY_MS + 100);
    expect(kid1.isWaiting).toBe(true);
    expect(workflowNode()!.isWaiting).toBe(true);
  });

  it('a queued prompt merely quoting the tag does not complete the workflow', () => {
    launch();
    leadLine(
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: `revisa esto <tool-use-id>${WF_TOOL}</tool-use-id> por favor`,
      }),
    );
    expect(workflowNode()).toBeDefined();
    expect(lead.backgroundAgentToolIds.has(WF_TOOL)).toBe(true);
  });

  it('a Stop hook clearing the tool before its result is parsed does not lose the launch', () => {
    runtime.registerAgent(LEAD_SESSION, 1);
    leadLine(workflowToolUse(WF_TOOL));
    runtime.handleHookEvent('claude', { hook_event_name: 'Stop', session_id: LEAD_SESSION });
    expect(lead.activeToolNames.has(WF_TOOL)).toBe(false);
    leadLine(workflowLaunched(WF_TOOL, runDir));
    expect(workflowNode()).toMatchObject({ label: 'transferencias-fase-1-lectura' });
  });

  it('launches deferred by a full tree are bounded; the excess is refused, not kept live', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Fill the tree to its cap with plain derived agents.
    for (let i = 0; i < MAX_DERIVED_AGENTS_PER_TREE; i++) {
      store.set(1000 + i, {
        ...createLeadAgent(tmpRoot),
        id: 1000 + i,
        parentAgentId: 1,
        depth: 1,
      });
    }
    for (let i = 0; i < MAX_PENDING_WORKFLOW_LAUNCHES + 10; i++) launch(`toolu_w${i}`);
    expect(derived().filter((a) => a.nodeKind === 'workflow')).toEqual([]);
    expect(lead.backgroundAgentToolIds.size).toBe(MAX_PENDING_WORKFLOW_LAUNCHES);
    // Room frees up: the deferred launches materialize on the 1 s scan.
    runtime.removeAgent(1000);
    tick();
    expect(derived().filter((a) => a.nodeKind === 'workflow')).toHaveLength(1);
    warn.mockRestore();
  });

  it('a tree at its cap pays for no run discovery; one discovery per run directory per scan', () => {
    const spy = vi.fn(discoverClaudeWorkflowAgents);
    discover = spy;
    launch(WF_TOOL);
    launch('toolu_same_dir'); // a second launch naming the same run directory
    tick();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let i = 0; i < MAX_DERIVED_AGENTS_PER_TREE; i++) {
      store.set(1000 + i, {
        ...createLeadAgent(tmpRoot),
        id: 1000 + i,
        parentAgentId: 1,
        depth: 1,
      });
    }
    tick();
    expect(spy).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // ── Hook routing ──────────────────────────────────────────────

  it('hooks keyed with a run agent go to that agent, never to the root or the node', () => {
    launch();
    writeRunAgent('a0939d8552f9f51b5', 'backend-java');
    tick();
    runtime.registerAgent(LEAD_SESSION, 1);
    const node = workflowNode()!;
    const runAgent = byKey('a0939d8552f9f51b5')!;
    messages.length = 0;
    runtime.handleHookEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: LEAD_SESSION,
      agent_id: 'a0939d8552f9f51b5',
      agent_type: 'backend-java',
      tool_name: 'Bash',
      tool_input: { command: 'mvn -q test' },
    });
    expect(messages.some((m) => m.type === 'agentToolStart' && m.id === runAgent.id)).toBe(true);
    expect(messages.filter((m) => m.id === 1 || m.id === node.id)).toEqual(
      // The node's own derived status follows its child; the root sees nothing.
      messages.filter((m) => m.id === node.id && m.type === 'agentStatus'),
    );
    expect(messages.some((m) => m.id === 1)).toBe(false);
  });

  it('SubagentStart/SubagentStop keyed with a run agent resolve to the ROOT as spawner (T7 design): no activity, no Subtask', () => {
    launch();
    writeRunAgent('a0939d8552f9f51b5', 'backend-java');
    tick();
    runtime.registerAgent(LEAD_SESSION, 1);
    const node = workflowNode()!;
    messages.length = 0;
    for (const hook_event_name of ['SubagentStart', 'SubagentStop']) {
      runtime.handleHookEvent('claude', {
        hook_event_name,
        session_id: LEAD_SESSION,
        agent_id: 'a0939d8552f9f51b5',
        agent_type: 'backend-java',
      });
    }
    // The node has no key of its own, so the router cannot name it as the
    // spawner; the root is. Nothing visible happens on either.
    const visible = new Set([
      'agentToolStart',
      'agentStatus',
      'subagentToolStart',
      'agentToolDone',
    ]);
    expect(
      messages.filter((m) => (m.id === 1 || m.id === node.id) && visible.has(String(m.type))),
    ).toEqual([]);
    expect(lead.hookDelivered).toBe(true);
  });

  it('hooks for a run agent arriving before the 1 s scan are delivered once it materializes', () => {
    launch();
    writeRunAgent('a0939d8552f9f51b5', 'backend-java');
    runtime.registerAgent(LEAD_SESSION, 1);
    messages.length = 0;
    runtime.handleHookEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: LEAD_SESSION,
      agent_id: 'a0939d8552f9f51b5',
      tool_name: 'Read',
      tool_input: { file_path: '/a' },
    });
    expect(messages.some((m) => m.type === 'agentToolStart' && m.id === 1)).toBe(false);
    tick();
    const runAgent = byKey('a0939d8552f9f51b5')!;
    expect(messages.some((m) => m.type === 'agentToolStart' && m.id === runAgent.id)).toBe(true);
  });

  it('keeps reading run transcripts through the ordinary pipeline', () => {
    launch();
    const p = writeRunAgent('kid1', 'dev');
    tick();
    const kid = byKey('kid1')!;
    fs.appendFileSync(p, toolUse('t9', 'Edit', { file_path: '/x.ts' }) + '\n');
    messages.length = 0;
    readNewLines(kid.id, store, runtime.waitingTimers, runtime.permissionTimers);
    expect(messages.some((m) => m.type === 'agentToolStart' && m.id === kid.id)).toBe(true);
  });
});
