import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { SessionRouter } from '../src/sessionRouter.js';
import type { AgentState } from '../src/types.js';

/** Minimal AgentState for testing. */
function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: '',
    terminalRef: undefined,
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
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
    ...overrides,
  } as AgentState;
}

function createMockWebview() {
  const messages: Array<Record<string, unknown>> = [];
  return {
    postMessage: vi.fn((msg: Record<string, unknown>) => {
      messages.push(msg);
      return Promise.resolve(true);
    }),
    messages,
  };
}

describe('HookEventHandler', () => {
  let agents: AgentStateStore;
  let waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  let permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  let mockWebview: ReturnType<typeof createMockWebview>;
  let handler: HookEventHandler;

  beforeEach(() => {
    agents = new AgentStateStore();
    waitingTimers = new Map();
    permissionTimers = new Map();
    mockWebview = createMockWebview();
    // Wire broadcast subscriber so mockWebview captures store broadcasts
    agents.on('broadcast', (msg) => {
      mockWebview.postMessage(msg);
    });
    handler = new HookEventHandler(
      agents,
      waitingTimers,
      permissionTimers,
      claudeProvider,
      new SessionRouter(),
    );
  });

  // ── PermissionRequest ───────────────────────────────────────

  it('PermissionRequest sends agentToolPermission', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
    });

    const msg = mockWebview.messages.find((m) => m.type === 'agentToolPermission');
    expect(msg).toBeTruthy();
    expect(msg?.id).toBe(1);
  });

  it('PermissionRequest cancels permission timer', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    const timer = setTimeout(() => {}, 10000);
    permissionTimers.set(1, timer);

    handler.handleEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
    });

    expect(permissionTimers.has(1)).toBe(false);
  });

  it('PermissionRequest notifies sub-agents', () => {
    const agent = createTestAgent({ id: 1 });
    agent.activeSubagentToolNames.set('tool-parent', new Map([['sub-1', 'Read']]));
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
    });

    const subMsg = mockWebview.messages.find((m) => m.type === 'subagentToolPermission');
    expect(subMsg).toBeTruthy();
    expect(subMsg?.parentToolId).toBe('tool-parent');
  });

  // ── Notification ────────────────────────────────────────────

  it('Notification permission_prompt sends agentToolPermission', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Notification',
      session_id: 'sess-1',
      notification_type: 'permission_prompt',
    });

    const msg = mockWebview.messages.find((m) => m.type === 'agentToolPermission');
    expect(msg).toBeTruthy();
    expect(agent.permissionSent).toBe(true);
  });

  it('Notification idle_prompt marks agent waiting', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Notification',
      session_id: 'sess-1',
      notification_type: 'idle_prompt',
    });

    expect(agent.isWaiting).toBe(true);
    const msg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'waiting',
    );
    expect(msg).toBeTruthy();
    // idle_prompt = waiting on the user -> awaitingInput true ("Waiting for input")
    expect(msg?.awaitingInput).toBe(true);
  });

  // ── Stop ────────────────────────────────────────────────────

  it('Stop marks agent waiting without awaitingInput (Done)', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.isWaiting).toBe(true);
    const waitMsg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'waiting',
    );
    expect(waitMsg).toBeTruthy();
    // Stop = finished its turn -> awaitingInput falsy ("Done")
    expect(waitMsg?.awaitingInput).toBeFalsy();
  });

  it('Stop clears foreground tools but preserves background agents', () => {
    const agent = createTestAgent({ id: 1 });
    agent.activeToolIds.add('fg-tool');
    agent.activeToolStatuses.set('fg-tool', 'Running');
    agent.activeToolNames.set('fg-tool', 'Bash');
    agent.activeToolIds.add('bg-tool');
    agent.activeToolStatuses.set('bg-tool', 'Background task');
    agent.activeToolNames.set('bg-tool', 'Agent');
    agent.backgroundAgentToolIds.add('bg-tool');
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.activeToolIds.has('fg-tool')).toBe(false);
    expect(agent.activeToolIds.has('bg-tool')).toBe(true);
    const clearMsg = mockWebview.messages.find((m) => m.type === 'agentToolsClear');
    expect(clearMsg).toBeTruthy();
    const reSent = mockWebview.messages.find(
      (m) => m.type === 'agentToolStart' && m.toolId === 'bg-tool',
    );
    expect(reSent).toBeTruthy();
  });

  // ── hookDelivered ───────────────────────────────────────────

  it('sets hookDelivered flag on agent', () => {
    const agent = createTestAgent({ id: 1, hookDelivered: false } as Partial<AgentState>);
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.hookDelivered).toBe(true);
  });

  // ── Buffering ───────────────────────────────────────────────

  it('silently drops events for untracked sessions', () => {
    // No agents, no pending sessions, no prior buffered events
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'unknown-sess',
    });

    // No messages sent, no crash
    expect(mockWebview.messages).toHaveLength(0);
  });

  it('buffers events when unregistered agents exist (internal agent race)', () => {
    // Agent exists in map but not yet registered for hooks
    const agent = createTestAgent({ id: 1, sessionId: 'sess-1' } as Partial<AgentState>);
    agents.set(1, agent);
    // Don't call registerAgent yet (simulates race)

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    // Event should be buffered (auto-discovery finds agent by sessionId and delivers)
    expect(agent.isWaiting).toBe(true);
  });

  it('flushes buffered events on registerAgent', () => {
    // Agent exists with sessionId but not registered
    const agent = createTestAgent({ id: 1, sessionId: 'sess-1' } as Partial<AgentState>);
    agents.set(1, agent);

    // Send event (auto-discovery will find it immediately in this case)
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    // Auto-discovery handles it directly
    const waitMsg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'waiting',
    );
    expect(waitMsg).toBeTruthy();
  });

  it('prunes expired buffered events', async () => {
    // Create agent so events get buffered (unregistered agent exists)
    const agent = createTestAgent({ id: 1, sessionId: 'other-sess' } as Partial<AgentState>);
    agents.set(1, agent);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'expired-sess',
    });

    // Wait well past HOOK_EVENT_BUFFER_MS (5000) + prune interval cycle
    await new Promise((r) => setTimeout(r, 7000));

    // Now register -- event should have been pruned
    const agent2 = createTestAgent({ id: 2 });
    agents.set(2, agent2);
    handler.registerAgent('expired-sess', 2);

    // No messages (event was pruned)
    expect(mockWebview.messages).toHaveLength(0);

    handler.dispose();
  });

  // ── Auto-discovery ──────────────────────────────────────────

  it('auto-discovers agent by sessionId field', () => {
    const agent = createTestAgent({ id: 1, sessionId: 'auto-sess' } as Partial<AgentState>);
    agents.set(1, agent);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'auto-sess',
    });

    expect(agent.isWaiting).toBe(true);
  });

  // ── Dispose ─────────────────────────────────────────────────

  it('dispose cleans up timers and maps', () => {
    handler.registerAgent('sess-1', 1);
    handler.dispose();
    expect(() => handler.dispose()).not.toThrow();
  });

  // ── SessionStart ────────────────────────────────────────────

  it('SessionStart for known agent sets hookDelivered', () => {
    const agent = createTestAgent({ id: 1, hookDelivered: false } as Partial<AgentState>);
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'sess-1',
      source: 'startup',
    });

    expect(agent.hookDelivered).toBe(true);
  });

  it('SessionStart auto-discovers agent by sessionId', () => {
    const agent = createTestAgent({
      id: 1,
      sessionId: 'auto-sess',
      hookDelivered: false,
    } as Partial<AgentState>);
    agents.set(1, agent);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'auto-sess',
      source: 'startup',
    });

    expect(agent.hookDelivered).toBe(true);
  });

  it('SessionStart(source=clear) reassigns agent with pendingClear', () => {
    const agent = createTestAgent({
      id: 1,
      projectDir: '/projects/test',
      pendingClear: true,
    } as Partial<AgentState>);
    agents.set(1, agent);
    handler.registerAgent('old-sess', 1);

    const onSessionClear = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'new-sess',
      source: 'clear',
      transcript_path: '/projects/test/new-sess.jsonl',
    });

    expect(onSessionClear).toHaveBeenCalledWith(1, 'new-sess', '/projects/test/new-sess.jsonl');
    expect(agent.pendingClear).toBe(false);
  });

  it('SessionStart for unknown session stores as pending', () => {
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'ext-sess',
      source: 'startup',
      transcript_path: '/projects/test/ext-sess.jsonl',
      cwd: '/projects/test',
    });

    // No agent created (pending, awaiting confirmation)
    expect(mockWebview.messages).toHaveLength(0);
  });

  // ── SessionEnd ──────────────────────────────────────────────

  it('SessionEnd(reason=clear) sets pendingClear and marks waiting', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'clear',
    });

    expect(agent.pendingClear).toBe(true);
    expect(agent.isWaiting).toBe(true);
  });

  it('SessionEnd(reason=exit) calls onSessionEnd immediately', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionEnd });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'exit',
    });

    // Exit is immediate, no pendingClear delay
    expect(agent.isWaiting).toBe(true);
    expect(onSessionEnd).toHaveBeenCalledWith(1, 'exit');
  });

  it('SessionEnd(reason=resume) delays onSessionEnd for SESSION_END_GRACE_MS', async () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionEnd });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'resume',
    });

    // pendingClear set, onSessionEnd delayed
    expect(agent.pendingClear).toBe(true);
    expect(agent.isWaiting).toBe(true);
    expect(onSessionEnd).not.toHaveBeenCalled();

    // Wait for grace period (2000ms + margin)
    await new Promise((r) => setTimeout(r, 2500));
    expect(onSessionEnd).toHaveBeenCalledWith(1, 'resume');
    expect(agent.pendingClear).toBe(false);
  });

  it('SessionEnd discards pending external session (transient filtering)', () => {
    // Store pending session via SessionStart
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'transient-sess',
      source: 'startup',
      transcript_path: '/projects/test/transient.jsonl',
      cwd: '/projects/test',
    });

    // SessionEnd arrives before confirmation -> discard
    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'transient-sess',
      reason: 'other',
    });

    // No agent created, no messages
    expect(mockWebview.messages).toHaveLength(0);
  });

  // ── PreToolUse / PostToolUse ─────────────────────────────────

  it('PreToolUse sends agentToolStart with formatted status', () => {
    const agent = createTestAgent({ id: 1, isWaiting: true });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Read',
      tool_input: { file_path: '/src/server.ts' },
    });

    const toolMsg = mockWebview.messages.find((m) => m.type === 'agentToolStart');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg?.toolName).toBe('Read');
    expect(toolMsg?.status).toBe('Reading server.ts');
    expect(agent.currentHookToolId).toBeTruthy();
  });

  it('PreToolUse marks agent active and cancels waiting', () => {
    const agent = createTestAgent({ id: 1, isWaiting: true });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    expect(agent.isWaiting).toBe(false);
    expect(agent.hadToolsInTurn).toBe(true);
    const activeMsg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'active',
    );
    expect(activeMsg).toBeTruthy();
  });

  it('PostToolUse sends agentToolDone and clears currentHookToolId', () => {
    const agent = createTestAgent({ id: 1 });
    agent.currentHookToolId = 'hook-123';
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-1',
    });

    const doneMsg = mockWebview.messages.find((m) => m.type === 'agentToolDone');
    expect(doneMsg).toBeTruthy();
    expect(doneMsg?.toolId).toBe('hook-123');
    expect(agent.currentHookToolId).toBeUndefined();
  });

  it('PostToolUseFailure sends agentToolDone', () => {
    const agent = createTestAgent({ id: 1 });
    agent.currentHookToolId = 'hook-456';
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'sess-1',
    });

    const doneMsg = mockWebview.messages.find((m) => m.type === 'agentToolDone');
    expect(doneMsg).toBeTruthy();
    expect(doneMsg?.toolId).toBe('hook-456');
    expect(agent.currentHookToolId).toBeUndefined();
  });

  // ── Pending external session confirmation ────────────────────

  it('confirmation event creates pending external session and delivers event', () => {
    const onExternalSessionDetected = vi.fn();
    handler.setLifecycleCallbacks({ onExternalSessionDetected });

    // SessionStart stores as pending
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'ext-sess',
      source: 'startup',
      transcript_path: '/projects/test/ext-sess.jsonl',
      cwd: '/projects/test',
    });

    expect(onExternalSessionDetected).not.toHaveBeenCalled();

    // Simulate the provider creating the agent (callback side effect)
    onExternalSessionDetected.mockImplementation((sessionId: string) => {
      const agent = createTestAgent({
        id: 2,
        sessionId,
        projectDir: '/projects/test',
      } as Partial<AgentState>);
      agents.set(2, agent);
      handler.registerAgent(sessionId, 2);
    });

    // Stop confirms the session -> creates agent -> re-processes Stop
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'ext-sess',
    });

    expect(onExternalSessionDetected).toHaveBeenCalledWith(
      'ext-sess',
      '/projects/test/ext-sess.jsonl',
      '/projects/test',
    );
    // Stop was re-processed after agent creation
    const agent = agents.get(2);
    expect(agent?.isWaiting).toBe(true);
  });

  // ── Resume ──────────────────────────────────────────────────

  it('SessionStart(source=resume) calls onSessionResume', () => {
    const onSessionResume = vi.fn();
    handler.setLifecycleCallbacks({ onSessionResume });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'resume-sess',
      source: 'resume',
      transcript_path: '/projects/test/resume-sess.jsonl',
      cwd: '/projects/test',
    });

    expect(onSessionResume).toHaveBeenCalledWith('/projects/test/resume-sess.jsonl');
  });

  it('SessionEnd(resume) + SessionStart(resume) reassigns agent within grace period', async () => {
    const agent = createTestAgent({
      id: 1,
      sessionId: 'old-sess',
      projectDir: '/projects/test',
    });
    agents.set(1, agent);
    handler.registerAgent('old-sess', 1);

    const onSessionClear = vi.fn();
    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear, onSessionEnd });

    // SessionEnd(reason=resume) sets pendingClear, starts grace timer
    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'old-sess',
      reason: 'resume',
    });
    expect(agent.pendingClear).toBe(true);

    // SessionStart(source=resume) arrives within grace period -> reassigns
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'new-resume-sess',
      source: 'resume',
      transcript_path: '/projects/test/new-resume-sess.jsonl',
      cwd: '/projects/test',
    });
    expect(agent.pendingClear).toBe(false);
    expect(onSessionClear).toHaveBeenCalledWith(
      1,
      'new-resume-sess',
      '/projects/test/new-resume-sess.jsonl',
    );

    // Grace timer fires but pendingClear is already false -> no-op
    await new Promise((r) => setTimeout(r, 2500));
    expect(onSessionEnd).not.toHaveBeenCalled();
  });

  it('SessionStart(source=resume) reassigns agent with pendingClear, not other agents in same projectDir', () => {
    const onSessionClear = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear });

    // Agent 1: the one that did /resume (has pendingClear from SessionEnd)
    const resumingAgent = createTestAgent({
      id: 1,
      sessionId: 'old-sess-1',
      projectDir: '/projects/test',
      pendingClear: true,
    });
    agents.set(1, resumingAgent);
    handler.registerAgent('old-sess-1', 1);

    // Agent 2: external agent in same projectDir (no pendingClear)
    const externalAgent = createTestAgent({
      id: 2,
      sessionId: 'ext-sess-2',
      projectDir: '/projects/test',
      pendingClear: false,
    });
    agents.set(2, externalAgent);
    handler.registerAgent('ext-sess-2', 2);

    // SessionStart(source=resume) should reassign Agent 1 (pendingClear), NOT Agent 2
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'new-resume-sess',
      source: 'resume',
      transcript_path: '/projects/test/new-resume-sess.jsonl',
      cwd: '/projects/test',
    });

    expect(onSessionClear).toHaveBeenCalledWith(
      1,
      'new-resume-sess',
      '/projects/test/new-resume-sess.jsonl',
    );
    expect(resumingAgent.pendingClear).toBe(false);
    // Agent 2 should be untouched
    expect(externalAgent.pendingClear).toBe(false);
    expect(externalAgent.sessionId).toBe('ext-sess-2');
  });

  // ── Provider-agnostic (optional transcript_path) ────────────

  it('SessionStart stores pending with cwd only (no transcript_path)', () => {
    const onExternalSessionDetected = vi.fn();
    handler.setLifecycleCallbacks({ onExternalSessionDetected });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'no-transcript-sess',
      source: 'startup',
      cwd: '/projects/test',
    });

    // Pending, no agent yet
    expect(onExternalSessionDetected).not.toHaveBeenCalled();

    // Simulate agent creation on confirmation
    onExternalSessionDetected.mockImplementation((sessionId: string) => {
      const agent = createTestAgent({
        id: 2,
        sessionId,
        projectDir: '/projects/test',
      } as Partial<AgentState>);
      agents.set(2, agent);
      handler.registerAgent(sessionId, 2);
    });

    // Confirmation event creates agent
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'no-transcript-sess',
    });

    expect(onExternalSessionDetected).toHaveBeenCalledWith(
      'no-transcript-sess',
      undefined,
      '/projects/test',
    );
  });

  it('SessionStart(source=resume) uses cwd for matching when no transcript_path', () => {
    const onSessionClear = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear });

    const agent = createTestAgent({
      id: 1,
      sessionId: 'old-sess',
      projectDir: '/projects/test',
      pendingClear: true,
    });
    agents.set(1, agent);
    handler.registerAgent('old-sess', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'resumed-sess',
      source: 'resume',
      cwd: '/projects/test',
    });

    expect(onSessionClear).toHaveBeenCalledWith(1, 'resumed-sess', undefined);
    expect(agent.pendingClear).toBe(false);
  });

  it('SessionStart(source=resume) without transcript_path does not call onSessionResume', () => {
    const onSessionResume = vi.fn();
    handler.setLifecycleCallbacks({ onSessionResume });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'resume-no-path',
      source: 'resume',
      cwd: '/projects/test',
    });

    // onSessionResume requires transcript_path to clear dismissals
    expect(onSessionResume).not.toHaveBeenCalled();
  });

  // ── Basic subagent regression (Agent Teams feature OFF) ─────────────
  // These tests pin down the behavior that must NOT change for basic subagents.
  // Basic subagents use Agent or Task tool WITHOUT run_in_background=true.

  // PreToolUse(Agent) sets currentHookIsTeammateSpawn iff run_in_background === true.
  describe.each([
    { label: 'run_in_background=true', toolInput: { run_in_background: true }, expected: true },
    { label: 'run_in_background=false', toolInput: { run_in_background: false }, expected: false },
  ])('PreToolUse(Agent, $label)', ({ toolInput, expected }) => {
    it(`sets currentHookIsTeammateSpawn=${expected}`, () => {
      const agent = createTestAgent({ id: 1 });
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);

      handler.handleEvent('claude', {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Agent',
        tool_input: { description: 'Code review', ...toolInput },
      });

      expect(agent.currentHookIsTeammateSpawn).toBe(expected);
    });
  });

  // SubagentStart routes to teammate discovery ONLY when both conditions hold:
  // currentHookIsTeammateSpawn === true AND agent.teamName is set (JSONL-confirmed lead).
  // Basic subagents (no spawn flag) or the external-session false-positive case
  // (spawn flag set but no teamName) fall through to the basic subagent path.
  describe.each([
    {
      label: 'teammate (spawn flag + teamName)',
      spawn: true,
      teamName: 'research',
      seedActiveTool: false,
      expectTeammateDetected: true,
    },
    {
      label: 'false-positive guard (spawn flag, no teamName)',
      spawn: true,
      teamName: undefined,
      seedActiveTool: true,
      expectTeammateDetected: false,
    },
    {
      label: 'basic subagent from hook before JSONL (no activeToolNames parent)',
      spawn: false,
      teamName: undefined,
      seedActiveTool: false,
      expectTeammateDetected: false,
    },
  ])('SubagentStart: $label', ({ spawn, teamName, seedActiveTool, expectTeammateDetected }) => {
    it(`onTeammateDetected called=${expectTeammateDetected}`, () => {
      const agent = createTestAgent({
        id: 1,
        currentHookIsTeammateSpawn: spawn,
        ...(teamName ? { teamName } : {}),
      });
      if (seedActiveTool) {
        agent.activeToolNames.set('toolu_real', 'Agent');
      } else if (!spawn) {
        agent.currentHookToolId = 'hook-XXX';
        agent.currentHookToolName = 'Agent';
      }
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);

      const onTeammateDetected = vi.fn();
      handler.setLifecycleCallbacks({ onTeammateDetected });

      handler.handleEvent('claude', {
        hook_event_name: 'SubagentStart',
        session_id: 'sess-1',
        agent_type: expectTeammateDetected ? 'web-researcher' : 'general-purpose',
      });

      if (expectTeammateDetected) {
        expect(onTeammateDetected).toHaveBeenCalledWith(1, 'sess-1', 'web-researcher');
        // Teammate path skips subagentToolStart (no ghost sub-agent character).
        expect(mockWebview.messages.find((m) => m.type === 'subagentToolStart')).toBeUndefined();
      } else {
        expect(onTeammateDetected).not.toHaveBeenCalled();
        const msg = mockWebview.messages.find((m) => m.type === 'subagentToolStart');
        if (seedActiveTool) {
          // Basic path with real tool id available.
          expect(msg).toBeTruthy();
          expect(msg?.parentToolId).toBe('toolu_real');
        } else {
          // No real tool id yet -- JSONL will create the sub-agent character.
          expect(msg).toBeUndefined();
        }
      }
    });
  });

  // ── Spawn tree routing by agentKey (docs/adr/0002) ─────────
  // Claude fires tool events from inside a spawned agent with the ROOT's
  // session_id plus agent_id. Resolving by session_id alone animated the root.

  describe('agentKey routing', () => {
    beforeEach(() => {
      agents.set(1, createTestAgent({ id: 1, sessionId: 'sess-1' }));
      handler.registerAgent('sess-1', 1);
    });

    it('a tool event fired inside a subagent never animates the session root', () => {
      handler.handleEvent('claude', {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        agent_id: 'bbb222',
        agent_type: 'desarrollador',
        tool_name: 'Bash',
        tool_input: { command: 'mvn test' },
      });
      expect(
        mockWebview.messages.filter(
          (m) => m.id === 1 && (m.type === 'agentToolStart' || m.type === 'agentStatus'),
        ),
      ).toEqual([]);
    });

    const bashInSub = (agentId: string, sessionId = 'sess-1') => ({
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      agent_id: agentId,
      agent_type: 'desarrollador',
      tool_name: 'Read',
      tool_input: { file_path: '/a.ts' },
    });
    const derived = (id: number, key: string, parentAgentId = 1) =>
      createTestAgent({ id, sessionId: 'sess-1', spawnAgentKey: key, parentAgentId });
    const toolStartsFor = (id: number) =>
      mockWebview.messages.filter((m) => m.id === id && m.type === 'agentToolStart');

    it('buffers an unknown agent_id (never the root) and delivers it once registered', () => {
      agents.set(7, derived(7, 'bbb222'));
      handler.handleEvent('claude', bashInSub('bbb222'));
      expect(mockWebview.messages).toEqual([]); // not registered yet -> buffered

      handler.registerSpawn('sess-1', 'bbb222', 7);
      expect(toolStartsFor(7)).toHaveLength(1);
      expect(toolStartsFor(1)).toEqual([]);
      expect(agents.get(7)!.hookDelivered).toBe(true);
      expect(agents.get(1)!.hookDelivered).toBe(false);
    });

    it('routes a keyed event straight to a registered derived agent', () => {
      agents.set(7, derived(7, 'bbb222'));
      handler.registerSpawn('sess-1', 'bbb222', 7);
      handler.handleEvent('claude', bashInSub('bbb222'));
      expect(toolStartsFor(7)).toHaveLength(1);
      expect(mockWebview.messages.filter((m) => m.id === 1)).toEqual([]);
    });

    it('re-dispatches each buffered event exactly once', () => {
      agents.set(7, derived(7, 'bbb222'));
      handler.handleEvent('claude', bashInSub('bbb222'));
      handler.handleEvent('claude', bashInSub('bbb222'));
      handler.registerSpawn('sess-1', 'bbb222', 7);
      handler.registerSpawn('sess-1', 'bbb222', 7); // idempotent: nothing left to flush
      handler.registerAgent('sess-1', 1); // root re-register must not steal keyed events
      expect(toolStartsFor(7)).toHaveLength(2);
      expect(toolStartsFor(1)).toEqual([]);
    });

    it('keeps other keys buffered when one spawn registers', () => {
      agents.set(7, derived(7, 'bbb222'));
      agents.set(8, derived(8, 'ccc333'));
      handler.handleEvent('claude', bashInSub('bbb222'));
      handler.handleEvent('claude', bashInSub('ccc333'));
      handler.registerSpawn('sess-1', 'bbb222', 7);
      expect(toolStartsFor(8)).toEqual([]);
      handler.registerSpawn('sess-1', 'ccc333', 8);
      expect(toolStartsFor(8)).toHaveLength(1);
      expect(toolStartsFor(7)).toHaveLength(1);
    });

    it('does not resolve a key registered under another session (forged agent_id)', () => {
      agents.set(2, createTestAgent({ id: 2, sessionId: 'sess-2' }));
      handler.registerAgent('sess-2', 2);
      agents.set(7, derived(7, 'bbb222'));
      handler.registerSpawn('sess-1', 'bbb222', 7);
      handler.handleEvent('claude', bashInSub('bbb222', 'sess-2'));
      expect(toolStartsFor(7)).toEqual([]);
      expect(toolStartsFor(2)).toEqual([]);
      expect(toolStartsFor(1)).toEqual([]);
    });

    it('drops keyed events for sessions nobody tracks instead of buffering them', () => {
      handler.handleEvent('claude', bashInSub('bbb222', 'sess-unknown'));
      agents.set(9, createTestAgent({ id: 9, sessionId: 'sess-unknown' }));
      handler.registerSpawn('sess-unknown', 'bbb222', 9);
      expect(mockWebview.messages).toEqual([]);
    });

    it('buffers keyed events of a session whose root is not registered yet', () => {
      // Internal-agent race: the root exists in the store but registerAgent
      // has not run; keyed events of its spawns must still wait.
      agents.set(3, createTestAgent({ id: 3, sessionId: 'sess-3' }));
      handler.handleEvent('claude', bashInSub('bbb222', 'sess-3'));
      agents.set(7, createTestAgent({ id: 7, sessionId: 'sess-3', spawnAgentKey: 'bbb222' }));
      handler.registerSpawn('sess-3', 'bbb222', 7);
      expect(toolStartsFor(7)).toHaveLength(1);
      expect(toolStartsFor(3)).toEqual([]);
    });

    it('drops a keyed event whose derived agent left the store (stale mapping)', () => {
      handler.registerSpawn('sess-1', 'bbb222', 7); // no agent 7 in the store
      handler.handleEvent('claude', bashInSub('bbb222'));
      expect(mockWebview.messages).toEqual([]);
    });

    it('after unregisterSpawn a keyed event buffers again instead of reaching anyone', () => {
      agents.set(7, derived(7, 'bbb222'));
      handler.registerSpawn('sess-1', 'bbb222', 7);
      handler.unregisterSpawn('sess-1', 'bbb222');
      handler.handleEvent('claude', bashInSub('bbb222'));
      expect(mockWebview.messages).toEqual([]);
      handler.registerSpawn('sess-1', 'bbb222', 7);
      expect(toolStartsFor(7)).toHaveLength(1);
    });

    it('clearSpawns forgets the session spawns and their buffered events', () => {
      agents.set(7, derived(7, 'bbb222'));
      handler.registerSpawn('sess-1', 'bbb222', 7);
      handler.handleEvent('claude', bashInSub('ccc333'));
      handler.clearSpawns('sess-1');
      handler.handleEvent('claude', bashInSub('bbb222'));
      expect(mockWebview.messages).toEqual([]); // mapping gone -> buffered, not delivered
      agents.set(8, derived(8, 'ccc333'));
      handler.registerSpawn('sess-1', 'ccc333', 8);
      expect(toolStartsFor(8)).toEqual([]); // its earlier buffered event was dropped
    });

    it('keyed PermissionRequest / Stop act on the derived agent only', () => {
      agents.set(7, derived(7, 'bbb222'));
      handler.registerSpawn('sess-1', 'bbb222', 7);
      handler.handleEvent('claude', {
        hook_event_name: 'PermissionRequest',
        session_id: 'sess-1',
        agent_id: 'bbb222',
      });
      handler.handleEvent('claude', {
        hook_event_name: 'Stop',
        session_id: 'sess-1',
        agent_id: 'bbb222',
      });
      expect(mockWebview.messages.filter((m) => m.id === 1)).toEqual([]);
      expect(mockWebview.messages.filter((m) => m.id === 7).map((m) => m.type)).toEqual([
        'agentToolPermission',
        'agentToolsClear',
        'agentStatus',
      ]);
      expect(agents.get(1)!.isWaiting).toBe(false);
      expect(agents.get(7)!.isWaiting).toBe(true);
    });

    it('a keyed SessionEnd never ends the root session', () => {
      const onSessionEnd = vi.fn();
      handler.setLifecycleCallbacks({ onSessionEnd });
      agents.set(7, derived(7, 'bbb222'));
      handler.registerSpawn('sess-1', 'bbb222', 7);
      handler.handleEvent('claude', {
        hook_event_name: 'SessionEnd',
        session_id: 'sess-1',
        agent_id: 'bbb222',
        reason: 'exit',
      });
      expect(onSessionEnd).not.toHaveBeenCalledWith(1, expect.anything());
      expect(mockWebview.messages.filter((m) => m.id === 1)).toEqual([]);
    });

    it('events without agent_id keep routing to the root as today', () => {
      agents.set(7, derived(7, 'bbb222'));
      handler.registerSpawn('sess-1', 'bbb222', 7);
      handler.handleEvent('claude', {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Read',
        tool_input: {},
      });
      expect(toolStartsFor(1)).toHaveLength(1);
      expect(toolStartsFor(7)).toEqual([]);
    });

    it('a buffered keyed event does not make unknown-session root events buffer', () => {
      // hasBufferedRoot gate: keyed events waiting for a spawn must not turn an
      // otherwise-dropped root event of an unknown session into a buffered one.
      agents.set(4, createTestAgent({ id: 4, sessionId: 'sess-4' }));
      handler.handleEvent('claude', bashInSub('bbb222', 'sess-4')); // buffered (root unregistered)
      handler.registerAgent('sess-4', 4); // registers root; keyed event stays buffered
      handler.unregisterAgent('sess-4');
      agents.delete(4);
      handler.handleEvent('claude', {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-4',
        tool_name: 'Read',
        tool_input: {},
      });
      agents.set(5, createTestAgent({ id: 5, sessionId: 'sess-4' }));
      handler.registerAgent('sess-4', 5);
      expect(toolStartsFor(5)).toEqual([]);
      expect(toolStartsFor(4)).toEqual([]);
    });

    it('a keyed SubagentStart reports the spawn and creates no Subtask', () => {
      const onSpawnObserved = vi.fn();
      handler.setLifecycleCallbacks({ onSpawnObserved });
      const root = agents.get(1)!;
      root.activeToolNames.set('toolu_L', 'Agent');
      handler.handleEvent('claude', {
        hook_event_name: 'SubagentStart',
        session_id: 'sess-1',
        agent_id: 'bbb222',
        agent_type: 'Explore',
      });
      expect(onSpawnObserved).toHaveBeenCalledWith(1);
      expect(mockWebview.messages).toEqual([]);
      expect(root.activeSubagentToolIds.size).toBe(0);
      expect(root.hookDelivered).toBe(true);
    });

    it('an unkeyed SubagentStart creates the Subtask as before and reports no spawn', () => {
      const onSpawnObserved = vi.fn();
      handler.setLifecycleCallbacks({ onSpawnObserved });
      agents.get(1)!.activeToolNames.set('toolu_L', 'Agent');
      handler.handleEvent('claude', {
        hook_event_name: 'SubagentStart',
        session_id: 'sess-1',
        agent_type: 'Explore',
      });
      expect(onSpawnObserved).not.toHaveBeenCalled();
      const sub = mockWebview.messages.find((m) => m.type === 'subagentToolStart');
      expect(sub?.id).toBe(1);
      expect(sub?.parentToolId).toBe('toolu_L');
    });

    it('a keyed SubagentStop of a nested child is handled by its derived parent', () => {
      // bbb222 (id 7) spawned ccc333 (id 8). ccc333 stopping is bbb222's
      // business: bbb222's (unkeyed) inline teammate is marked waiting, the
      // root's is not. No Subtask is cleared anywhere.
      const parent = derived(7, 'bbb222');
      parent.activeToolNames.set('toolu_B', 'Agent');
      parent.activeSubagentToolIds.set('toolu_B', new Set(['sub-x']));
      agents.set(7, parent);
      agents.set(8, derived(8, 'ccc333', 7));
      agents.set(20, createTestAgent({ id: 20, sessionId: 'sess-1', leadAgentId: 7 }));
      agents.set(21, createTestAgent({ id: 21, sessionId: 'sess-1', leadAgentId: 1 }));
      handler.registerSpawn('sess-1', 'bbb222', 7);
      handler.registerSpawn('sess-1', 'ccc333', 8);

      handler.handleEvent('claude', {
        hook_event_name: 'SubagentStop',
        session_id: 'sess-1',
        agent_id: 'ccc333',
        agent_type: 'qa-revisor',
      });
      expect(agents.get(20)!.isWaiting).toBe(true);
      expect(agents.get(21)!.isWaiting).toBe(false);
      expect(mockWebview.messages.filter((m) => m.type === 'subagentClear')).toEqual([]);
      expect(parent.activeSubagentToolIds.has('toolu_B')).toBe(true);
    });

    it('a derived agent outliving its root mapping is never auto-discovered as the root', () => {
      // After /clear the root moves to a new session; its derived agent keeps
      // the old session_id. A late root event on the old session must not
      // register the derived agent as that session's owner.
      agents.set(7, derived(7, 'bbb222'));
      handler.registerSpawn('sess-1', 'bbb222', 7);
      handler.unregisterAgent('sess-1');
      agents.get(1)!.sessionId = 'sess-new';
      handler.registerAgent('sess-new', 1);

      handler.handleEvent('claude', {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Read',
        tool_input: {},
      });
      handler.handleEvent('claude', {
        hook_event_name: 'SessionStart',
        session_id: 'sess-1',
        source: 'resume',
      });
      expect(toolStartsFor(7)).toEqual([]);
      expect(agents.get(7)!.hookDelivered).toBe(false);
      // Mapping not hijacked: a later spawn-less SessionEnd on the old session
      // reaches nobody.
      const onSessionEnd = vi.fn();
      handler.setLifecycleCallbacks({ onSessionEnd });
      handler.handleEvent('claude', {
        hook_event_name: 'SessionEnd',
        session_id: 'sess-1',
        reason: 'exit',
      });
      expect(onSessionEnd).not.toHaveBeenCalled();
    });

    it('an orphaned derived agent does not open the buffer to foreign sessions', () => {
      agents.set(7, derived(7, 'bbb222'));
      handler.unregisterAgent('sess-1'); // root mapping gone, derived still in store
      agents.delete(1);
      handler.handleEvent('claude', {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-foreign',
        tool_name: 'Read',
        tool_input: {},
      });
      handler.handleEvent('claude', bashInSub('ccc333', 'sess-foreign'));
      agents.set(9, createTestAgent({ id: 9, sessionId: 'sess-foreign' }));
      handler.registerAgent('sess-foreign', 9);
      agents.set(
        10,
        createTestAgent({ id: 10, sessionId: 'sess-foreign', spawnAgentKey: 'ccc333' }),
      );
      handler.registerSpawn('sess-foreign', 'ccc333', 10);
      expect(mockWebview.messages).toEqual([]);
    });

    it('a derived agent keeps its own permission and activity when it has a named child', () => {
      agents.set(7, derived(7, 'aaa111'));
      agents.set(
        8,
        createTestAgent({
          id: 8,
          sessionId: 'sess-1',
          spawnAgentKey: 'bbb222',
          parentAgentId: 7,
          agentName: 'reviewer',
          leadAgentId: 7,
        }),
      );
      handler.registerSpawn('sess-1', 'aaa111', 7);
      handler.registerSpawn('sess-1', 'bbb222', 8);
      handler.handleEvent('claude', { ...bashInSub('aaa111') });
      handler.handleEvent('claude', {
        hook_event_name: 'PermissionRequest',
        session_id: 'sess-1',
        agent_id: 'aaa111',
      });
      expect(mockWebview.messages.filter((m) => m.id === 7).map((m) => m.type)).toEqual([
        'agentToolStart',
        'agentStatus',
        'agentToolPermission',
      ]);
      expect(mockWebview.messages.filter((m) => m.id === 8)).toEqual([]);
    });

    it('unkeyed events stay on the root when its only teammate is a derived (keyed) one', () => {
      agents.set(
        7,
        createTestAgent({
          id: 7,
          sessionId: 'sess-1',
          spawnAgentKey: 'bbb222',
          parentAgentId: 1,
          agentName: 'reviewer',
          leadAgentId: 1,
        }),
      );
      handler.registerSpawn('sess-1', 'bbb222', 7);
      handler.handleEvent('claude', {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      });
      handler.handleEvent('claude', { hook_event_name: 'PermissionRequest', session_id: 'sess-1' });
      expect(mockWebview.messages.filter((m) => m.id === 1).map((m) => m.type)).toEqual([
        'agentToolStart',
        'agentStatus',
        'agentToolPermission',
      ]);
      expect(mockWebview.messages.filter((m) => m.id === 7)).toEqual([]);
    });

    it('a classic inline teammate (no agentKey) still absorbs the ambiguous root events', () => {
      agents.set(7, createTestAgent({ id: 7, sessionId: 'sess-1', leadAgentId: 1 }));
      handler.handleEvent('claude', { hook_event_name: 'PermissionRequest', session_id: 'sess-1' });
      expect(mockWebview.messages).toEqual([{ type: 'agentToolPermission', id: 7 }]);
    });

    it('keyed SubagentStart/Stop buffered for an unregistered root flush without Subtask work', () => {
      // Root of sess-6 not in the store yet; an unregistered agent (launch race)
      // opens the buffer. Keyed subagent events buffer as ROOT events and flush
      // on registerAgent -- still without creating or clearing any Subtask.
      const onSpawnObserved = vi.fn();
      handler.setLifecycleCallbacks({ onSpawnObserved });
      agents.set(30, createTestAgent({ id: 30, sessionId: 'sess-racing' }));
      handler.handleEvent('claude', {
        hook_event_name: 'SubagentStart',
        session_id: 'sess-6',
        agent_id: 'bbb222',
        agent_type: 'Explore',
      });
      handler.handleEvent('claude', {
        hook_event_name: 'SubagentStop',
        session_id: 'sess-6',
        agent_id: 'bbb222',
        agent_type: 'Explore',
      });
      const root = createTestAgent({ id: 6, sessionId: 'sess-6' });
      root.activeToolNames.set('toolu_L', 'Agent');
      root.activeSubagentToolIds.set('toolu_L', new Set(['sub-y']));
      agents.set(6, root);
      handler.registerAgent('sess-6', 6);
      expect(mockWebview.messages).toEqual([]);
      expect([...root.activeSubagentToolIds.get('toolu_L')!]).toEqual(['sub-y']);
      expect(onSpawnObserved).toHaveBeenCalledTimes(1);
      expect(onSpawnObserved).toHaveBeenCalledWith(6);
      expect(root.hookDelivered).toBe(true);
    });

    it('keyed SubagentStart/Stop honor the provider.team gate like unkeyed ones', () => {
      const noTeam = new HookEventHandler(
        agents,
        waitingTimers,
        permissionTimers,
        { ...claudeProvider, team: undefined },
        new SessionRouter(),
      );
      const onTeammateDetected = vi.fn();
      const onSpawnObserved = vi.fn();
      noTeam.setLifecycleCallbacks({ onTeammateDetected, onSpawnObserved });
      const root = agents.get(1)!;
      root.teamName = 'research';
      root.currentHookIsTeammateSpawn = true;
      agents.set(20, createTestAgent({ id: 20, sessionId: 'sess-1', leadAgentId: 1 }));
      noTeam.registerAgent('sess-1', 1);
      for (const name of ['SubagentStart', 'SubagentStop']) {
        noTeam.handleEvent('claude', {
          hook_event_name: name,
          session_id: 'sess-1',
          agent_id: 'bbb222',
          agent_type: 'web-researcher',
        });
      }
      expect(onTeammateDetected).not.toHaveBeenCalled();
      expect(agents.get(20)!.isWaiting).toBe(false);
      expect(mockWebview.messages).toEqual([]);
      expect(onSpawnObserved).toHaveBeenCalledWith(1);
      noTeam.dispose();
    });

    it('a keyed tool event does not confirm a pending external session; the root event does', () => {
      const onExternalSessionDetected = vi.fn();
      handler.setLifecycleCallbacks({ onExternalSessionDetected });
      handler.handleEvent('claude', {
        hook_event_name: 'SessionStart',
        session_id: 'sess-ext',
        transcript_path: '/test/sess-ext.jsonl',
        source: 'startup',
      });
      handler.handleEvent('claude', bashInSub('bbb222', 'sess-ext'));
      expect(onExternalSessionDetected).not.toHaveBeenCalled();
      handler.handleEvent('claude', {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-ext',
        tool_name: 'Agent',
        tool_input: {},
      });
      expect(onExternalSessionDetected).toHaveBeenCalledTimes(1);
      // The keyed event is still waiting for its spawn, not handed to anyone.
      agents.set(7, createTestAgent({ id: 7, sessionId: 'sess-ext', spawnAgentKey: 'bbb222' }));
      handler.registerSpawn('sess-ext', 'bbb222', 7);
      expect(toolStartsFor(7)).toHaveLength(1);
    });

    it('SubagentStop does not report a spawn', () => {
      const onSpawnObserved = vi.fn();
      handler.setLifecycleCallbacks({ onSpawnObserved });
      handler.handleEvent('claude', {
        hook_event_name: 'SubagentStop',
        session_id: 'sess-1',
        agent_id: 'bbb222',
        agent_type: 'Explore',
      });
      expect(onSpawnObserved).not.toHaveBeenCalled();
    });

    it('a keyed SubagentStop of a depth-1 child is harmless: no Subtask to clear', () => {
      agents.set(7, derived(7, 'bbb222'));
      handler.registerSpawn('sess-1', 'bbb222', 7);
      const root = agents.get(1)!;
      root.activeToolNames.set('toolu_L', 'Agent');
      root.activeSubagentToolIds.set('toolu_L', new Set(['sub-y']));
      handler.handleEvent('claude', {
        hook_event_name: 'SubagentStop',
        session_id: 'sess-1',
        agent_id: 'bbb222',
        agent_type: 'desarrollador',
      });
      expect(mockWebview.messages).toEqual([]);
      expect(root.activeSubagentToolIds.has('toolu_L')).toBe(true);
      expect(agents.get(7)!.isWaiting).toBe(false);
    });

    it('an unkeyed SubagentStop still clears the Subtask as before', () => {
      const root = agents.get(1)!;
      root.activeToolNames.set('toolu_L', 'Agent');
      root.activeSubagentToolIds.set('toolu_L', new Set(['sub-y']));
      handler.handleEvent('claude', {
        hook_event_name: 'SubagentStop',
        session_id: 'sess-1',
        agent_type: 'Explore',
      });
      expect(mockWebview.messages).toEqual([
        { type: 'subagentClear', id: 1, parentToolId: 'toolu_L' },
      ]);
    });

    it('a keyed grandchild SubagentStart creates no Subtask on the root nor on its parent', () => {
      const onSpawnObserved = vi.fn();
      handler.setLifecycleCallbacks({ onSpawnObserved });
      const root = agents.get(1)!;
      root.activeToolNames.set('toolu_L', 'Agent');
      const parent = derived(7, 'bbb222');
      parent.activeToolNames.set('toolu_B', 'Agent');
      agents.set(7, parent);
      handler.registerSpawn('sess-1', 'bbb222', 7);

      // ccc333 is not registered yet (the usual case at SubagentStart).
      handler.handleEvent('claude', {
        hook_event_name: 'SubagentStart',
        session_id: 'sess-1',
        agent_id: 'ccc333',
        agent_type: 'qa-revisor',
      });
      // ...and once it is, a repeat still creates nothing.
      agents.set(8, derived(8, 'ccc333', 7));
      handler.registerSpawn('sess-1', 'ccc333', 8);
      handler.handleEvent('claude', {
        hook_event_name: 'SubagentStart',
        session_id: 'sess-1',
        agent_id: 'ccc333',
        agent_type: 'qa-revisor',
      });

      expect(mockWebview.messages).toEqual([]);
      expect(root.activeSubagentToolIds.size).toBe(0);
      expect(parent.activeSubagentToolIds.size).toBe(0);
      expect(onSpawnObserved).toHaveBeenCalledTimes(2);
      expect(onSpawnObserved).toHaveBeenCalledWith(1);
    });

    it('a keyed SubagentStart keeps the teammate-discovery path', () => {
      const onTeammateDetected = vi.fn();
      const onSpawnObserved = vi.fn();
      handler.setLifecycleCallbacks({ onTeammateDetected, onSpawnObserved });
      const root = agents.get(1)!;
      root.teamName = 'research';
      root.currentHookIsTeammateSpawn = true;
      handler.handleEvent('claude', {
        hook_event_name: 'SubagentStart',
        session_id: 'sess-1',
        agent_id: 'bbb222',
        agent_type: 'web-researcher',
      });
      expect(onTeammateDetected).toHaveBeenCalledWith(1, 'sess-1', 'web-researcher');
      expect(onSpawnObserved).toHaveBeenCalledWith(1);
    });
  });
});
