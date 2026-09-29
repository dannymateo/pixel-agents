import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '../src/constants.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { PtyHost } from '../src/terminals/ptyHost.js';
import type { PtyFactory, PtyProcess } from '../src/terminals/ptyTypes.js';
import type { AgentState } from '../src/types.js';

const testHome = vi.hoisted(() => ({ dir: '' }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const homedir = (): string => {
    if (!testHome.dir) throw new Error('os.homedir() called before a test home was set');
    return testHome.dir;
  };
  return { ...actual, homedir, default: { ...actual, homedir } };
});

class FakePty implements PtyProcess {
  readonly pid = 1;
  killed = false;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;
  onData() {
    return { dispose() {} };
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb;
    return {
      dispose: () => {
        if (this.exitCb === cb) this.exitCb = null;
      },
    };
  }
  write() {}
  resize() {}
  kill() {
    this.killed = true;
    this.exitCb?.({ exitCode: 1 });
  }
}

const SID = '5b3c1f0e-2a4d-4e8f-9c1b-7d6e5f4a3b2c';
const AGENT_ID = 7;

describe('AgentRuntime: bring an external agent into the office (takeover)', () => {
  let tmp: string;
  let workDir: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let spawned: Array<{ file: string; args: string[]; cwd: string }>;
  let broadcasts: Array<Record<string, unknown>>;
  let failSpawn: boolean;

  function seedTranscript(record: Record<string, unknown>): string {
    const projectDir = path.join(testHome.dir, '.claude', 'projects', 'C--proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, `${SID}.jsonl`);
    fs.writeFileSync(file, JSON.stringify(record) + '\n');
    return file;
  }

  function addExternalAgent(overrides: Partial<AgentState> = {}): AgentState {
    const jsonlFile = seedTranscript({ type: 'user', cwd: workDir });
    const agent: AgentState = {
      id: AGENT_ID,
      sessionId: SID,
      isExternal: true,
      projectDir: path.dirname(jsonlFile),
      jsonlFile,
      fileOffset: fs.statSync(jsonlFile).size,
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
      hookDelivered: true,
      contextTokens: 0,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      palette: 3,
      hueShift: 0,
      ...overrides,
    };
    store.set(AGENT_ID, agent);
    runtime.registerAgent(SID, AGENT_ID);
    return agent;
  }

  const sessionEnd = (reason = 'prompt_input_exit') =>
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: SID,
      reason,
    });

  const statuses = () => broadcasts.filter((m) => m.type === 'takeoverStatus');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-takeover-'));
    testHome.dir = path.join(tmp, 'home');
    fs.mkdirSync(testHome.dir);
    workDir = path.join(tmp, 'Mis Proyectos');
    fs.mkdirSync(workDir);
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    spawned = [];
    broadcasts = [];
    failSpawn = false;
    store.on('broadcast', (m: Record<string, unknown>) => broadcasts.push(m));
    const factory: PtyFactory = (file, args, o) => {
      if (failSpawn) throw new Error('claude did not start');
      spawned.push({ file, args, cwd: o.cwd });
      return new FakePty();
    };
    runtime.attachPtyHost(new PtyHost(factory));
  });

  afterEach(() => {
    runtime.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('marks the agent as waiting for its session to end, spawning nothing yet', () => {
    addExternalAgent();
    runtime.requestTakeover(AGENT_ID);
    expect(statuses()).toEqual([{ type: 'takeoverStatus', id: AGENT_ID, state: 'waitingExit' }]);
    expect(spawned).toEqual([]);
    expect(store.get(AGENT_ID)?.isExternal).toBe(true);
  });

  it('SessionEnd of a pending agent resumes it in an office console, in the SAME agent', () => {
    const before = addExternalAgent();
    runtime.requestTakeover(AGENT_ID);
    sessionEnd();

    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toContain('--resume');
    expect(spawned[0].args).toContain(SID);
    expect(spawned[0].cwd).toBe(fs.realpathSync.native(workDir));

    const agent = store.get(AGENT_ID)!;
    expect(agent).toBe(before);
    expect(agent.isExternal).toBe(false);
    expect(agent.terminalId).toBeTruthy();
    expect(agent.palette).toBe(3);
    expect(runtime.agentIdForTerminal(agent.terminalId!)).toBe(AGENT_ID);
    expect(statuses().at(-1)).toEqual({
      type: 'takeoverStatus',
      id: AGENT_ID,
      state: 'done',
      terminalId: agent.terminalId,
    });
    expect(broadcasts.some((m) => m.type === 'agentClosed')).toBe(false);
  });

  it('after the takeover its session stays routed: a second SessionEnd no longer retakes it', () => {
    addExternalAgent();
    runtime.requestTakeover(AGENT_ID);
    sessionEnd();
    // The resumed claude's own SessionEnd: an internal agent keeps its console
    // (the console exiting is what removes it), and no second spawn happens.
    sessionEnd();
    expect(spawned).toHaveLength(1);
    expect(store.get(AGENT_ID)?.terminalId).toBeTruthy();
  });

  it('without a mark, SessionEnd retires the external agent as before', () => {
    addExternalAgent();
    sessionEnd();
    expect(store.get(AGENT_ID)).toBeUndefined();
    expect(spawned).toEqual([]);
  });

  it('confirmClosed resumes at once, without waiting for SessionEnd', () => {
    addExternalAgent();
    runtime.requestTakeover(AGENT_ID, { confirmClosed: true });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toContain('--resume');
    expect(store.get(AGENT_ID)?.isExternal).toBe(false);
    expect(statuses().map((s) => s.state)).toEqual(['done']);
  });

  it('refuses an unknown agent', () => {
    runtime.requestTakeover(99);
    expect(statuses()).toEqual([
      expect.objectContaining({ id: 99, state: 'refused', reason: expect.any(String) }),
    ]);
  });

  it('refuses a derived agent (sub-agent or teammate)', () => {
    addExternalAgent({ parentAgentId: 1 });
    runtime.requestTakeover(AGENT_ID);
    expect(statuses()).toEqual([expect.objectContaining({ state: 'refused' })]);
    store.delete(AGENT_ID);
    broadcasts = [];
    addExternalAgent({ leadAgentId: 1 });
    runtime.requestTakeover(AGENT_ID, { confirmClosed: true });
    expect(statuses()).toEqual([expect.objectContaining({ state: 'refused' })]);
    expect(spawned).toEqual([]);
  });

  it('refuses an agent that already has an office console', () => {
    addExternalAgent({ terminalId: 't-x', isExternal: false });
    runtime.requestTakeover(AGENT_ID, { confirmClosed: true });
    expect(statuses()).toEqual([expect.objectContaining({ state: 'refused' })]);
    expect(spawned).toEqual([]);
  });

  it('refuses when office consoles are unavailable', () => {
    const bareStore = new AgentStateStore();
    const bare = new AgentRuntime(bareStore, claudeProvider);
    const got: Array<Record<string, unknown>> = [];
    bareStore.on('broadcast', (m: Record<string, unknown>) => got.push(m));
    const jsonlFile = seedTranscript({ type: 'user', cwd: workDir });
    bareStore.set(AGENT_ID, {
      ...(store.get(AGENT_ID) ?? ({} as AgentState)),
      id: AGENT_ID,
      sessionId: SID,
      isExternal: true,
      jsonlFile,
    } as AgentState);
    try {
      bare.requestTakeover(AGENT_ID);
      expect(got.filter((m) => m.type === 'takeoverStatus')).toEqual([
        expect.objectContaining({ state: 'refused' }),
      ]);
    } finally {
      bare.dispose();
    }
  });

  it('refuses when the transcript records no cwd', () => {
    addExternalAgent();
    seedTranscript({ type: 'user' });
    runtime.requestTakeover(AGENT_ID);
    expect(statuses()).toEqual([expect.objectContaining({ state: 'refused' })]);
    sessionEnd();
    expect(spawned).toEqual([]);
    expect(store.get(AGENT_ID)).toBeUndefined();
  });

  it('cancelTakeover drops the mark: a later SessionEnd retires the agent', () => {
    addExternalAgent();
    runtime.requestTakeover(AGENT_ID);
    runtime.cancelTakeover(AGENT_ID);
    expect(statuses().at(-1)).toEqual({ type: 'takeoverStatus', id: AGENT_ID, state: 'cancelled' });
    sessionEnd();
    expect(spawned).toEqual([]);
    expect(store.get(AGENT_ID)).toBeUndefined();
  });

  it('a failed resume reports failed and the agent leaves like a normal SessionEnd', () => {
    addExternalAgent();
    runtime.requestTakeover(AGENT_ID);
    failSpawn = true;
    sessionEnd();
    expect(statuses().at(-1)).toEqual(
      expect.objectContaining({ id: AGENT_ID, state: 'failed', reason: expect.any(String) }),
    );
    expect(store.get(AGENT_ID)).toBeUndefined();
    expect(runtime.ptyHost!.size).toBe(0);
  });

  it('confirmClosed ends the old session tree too: its derived child leaves, the root resumes', () => {
    const root = addExternalAgent();
    const CHILD_ID = 8;
    store.set(CHILD_ID, {
      ...root,
      id: CHILD_ID,
      parentAgentId: AGENT_ID,
      spawnAgentKey: 'a1b2c3',
      depth: 1,
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      seenUnknownRecordTypes: new Set(),
    });
    runtime.requestTakeover(AGENT_ID, { confirmClosed: true });
    const child = store.get(CHILD_ID);
    expect(child === undefined || child.presence === 'leaving').toBe(true);
    expect(store.get(AGENT_ID)?.terminalId).toBeTruthy();
    expect(spawned).toHaveLength(1);
  });

  it('the resumed claude announcing the same session (SessionStart resume) adds no second agent', () => {
    addExternalAgent();
    runtime.requestTakeover(AGENT_ID);
    sessionEnd();
    const terminalId = store.get(AGENT_ID)!.terminalId;
    const size = store.size;
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: SID,
      source: 'resume',
      transcript_path: store.get(AGENT_ID)!.jsonlFile,
      cwd: workDir,
    });
    expect(store.size).toBe(size);
    expect(store.get(AGENT_ID)?.terminalId).toBe(terminalId);
    expect(spawned).toHaveLength(1);
  });

  it('a /clear in the external terminal keeps the mark: the NEW session is the one resumed', () => {
    const root = addExternalAgent();
    runtime.requestTakeover(AGENT_ID);
    const NEW_SID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
    const newFile = path.join(path.dirname(root.jsonlFile), `${NEW_SID}.jsonl`);
    fs.writeFileSync(newFile, JSON.stringify({ type: 'user', cwd: workDir }) + '\n');
    sessionEnd('clear');
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: NEW_SID,
      source: 'clear',
      transcript_path: newFile,
      cwd: workDir,
    });
    expect(store.get(AGENT_ID)?.sessionId).toBe(NEW_SID);
    expect(spawned).toEqual([]);
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: NEW_SID,
      reason: 'prompt_input_exit',
    });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args).toEqual(expect.arrayContaining(['--resume', NEW_SID]));
    expect(store.get(AGENT_ID)?.terminalId).toBeTruthy();
  });

  it('a failure after the console opened closes it instead of orphaning it', () => {
    addExternalAgent();
    runtime.requestTakeover(AGENT_ID);
    vi.spyOn(store, 'persist').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    sessionEnd();
    expect(spawned).toHaveLength(1);
    expect(runtime.ptyHost!.size).toBe(0);
    expect(statuses().at(-1)).toEqual(
      expect.objectContaining({ id: AGENT_ID, state: 'failed', reason: 'disk full' }),
    );
    expect(store.get(AGENT_ID)).toBeUndefined();
  });

  it('cancelling with no pending mark broadcasts nothing', () => {
    addExternalAgent();
    runtime.cancelTakeover(AGENT_ID);
    expect(statuses()).toEqual([]);
  });

  it('an agent removed by another path loses its mark', () => {
    addExternalAgent();
    runtime.requestTakeover(AGENT_ID);
    runtime.removeAgent(AGENT_ID);
    // Same id comes back (e.g. re-adopted): its old mark must not survive.
    addExternalAgent();
    sessionEnd();
    expect(spawned).toEqual([]);
    expect(store.get(AGENT_ID)).toBeUndefined();
  });
});
