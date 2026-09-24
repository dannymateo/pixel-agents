import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { scanSpawnTree } from '../src/fileWatcher.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

const LEAD_SESSION = 'lead-session-1';
const SPAWN_TOOL_ID = 'toolu_01LMvN98KN4sn1fmvftm7vhk';
const SUB_TOOL_ID = 'toolu_sub_01';

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

/** Records shaped like the background-agent flow (Claude 2.1.x, teams OFF):
 *  unflagged Agent tool_use, "Async agent launched" result, queue-operation
 *  completion. */
function agentSpawnRecord(): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: SPAWN_TOOL_ID,
          name: 'Agent',
          input: { description: 'Say hello', subagent_type: 'general-purpose' },
        },
      ],
    },
  });
}

function namedAgentSpawnRecord(): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: SPAWN_TOOL_ID,
          name: 'Agent',
          input: {
            description: 'ghost writer probe',
            name: 'ghost-writer',
            subagent_type: 'general-purpose',
          },
        },
      ],
    },
  });
}

function asyncLaunchResultRecord(): string {
  return JSON.stringify({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: SPAWN_TOOL_ID,
          content: [
            {
              type: 'text',
              text: 'Async agent launched successfully. (This tool result is internal metadata.)\nagentId: a4cb86c99458dbe55 (internal)',
            },
          ],
        },
      ],
    },
  });
}

function queueOpCompletionRecord(status?: string): string {
  const statusTag = status ? `<status>${status}</status> ` : '';
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    content: `<task-notification> <task-id>a4cb86c99458dbe55</task-id> <tool-use-id>${SPAWN_TOOL_ID}</tool-use-id> ${statusTag}<output>done</output>`,
  });
}

/** Lines for the SPAWN's OWN transcript (watched by the shadow store). */
function subToolUseLine(): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: SUB_TOOL_ID, name: 'Read', input: { file_path: '/tmp/x.ts' } },
      ],
    },
  });
}

function subToolResultLine(): string {
  return JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: SUB_TOOL_ID, content: 'ok' }] },
  });
}

function subTurnDurationLine(): string {
  return JSON.stringify({ type: 'system', subtype: 'turn_duration' });
}

describe('background spawns (teams OFF) become derived agents, classified by sidecar name', () => {
  let tmpRoot: string;
  let agents: AgentStateStore;
  let runtime: AgentRuntime;
  let lead: AgentState;
  let messages: Array<Record<string, unknown>>;

  function seedSidecar(opts?: { name?: string; transcriptLines?: string[] }): string {
    const subagentsDir = path.join(tmpRoot, LEAD_SESSION, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    const jsonlPath = path.join(subagentsDir, 'agent-a4cb86c99458dbe55.jsonl');
    const lines = opts?.transcriptLines ?? [];
    fs.writeFileSync(jsonlPath, lines.length > 0 ? lines.join('\n') + '\n' : '');
    fs.writeFileSync(
      path.join(subagentsDir, 'agent-a4cb86c99458dbe55.meta.json'),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'Say hello',
        toolUseId: SPAWN_TOOL_ID,
        spawnDepth: 1,
        ...(opts?.name ? { name: opts.name } : {}),
      }),
    );
    return jsonlPath;
  }

  function line(record: string, id = 1): void {
    processTranscriptLine(id, record, agents, runtime.waitingTimers, runtime.permissionTimers);
  }

  function spawnAndLaunch(): void {
    line(agentSpawnRecord());
    line(asyncLaunchResultRecord());
  }

  function scan(): void {
    scanSpawnTree(
      1,
      agents,
      agents.nextAgentId,
      runtime.fileWatchers,
      runtime.pollingTimers,
      runtime.waitingTimers,
      runtime.permissionTimers,
    );
  }

  function children(): AgentState[] {
    return [...agents.values()].filter((a) => a.parentAgentId === 1);
  }

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-bg-'));
    agents = new AgentStateStore();
    runtime = new AgentRuntime(agents, claudeProvider);
    lead = createLeadAgent(tmpRoot);
    agents.set(1, lead);
    agents.nextAgentId.current = 100;
    messages = [];
    agents.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
  });

  afterEach(() => {
    runtime.dispose();
    vi.useRealTimers();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ── Spawn tool flags ────────────────────────────────────────────────

  it('flags a NAMED spawn as isTeammateSpawn so the webview never creates a Subtask ghost', () => {
    line(namedAgentSpawnRecord());

    const start = messages.find((m) => m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID);
    expect(start).toBeDefined();
    expect(start!.isTeammateSpawn).toBe(true);

    // The async re-broadcast and the turn-end re-send must carry the flag too
    // (a turn can end before the teammate character is discovered).
    line(asyncLaunchResultRecord());
    messages.length = 0;
    line(JSON.stringify({ type: 'system', subtype: 'turn_duration' }));
    for (const m of messages) {
      if (m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID) {
        expect(m.isTeammateSpawn).toBe(true);
      }
    }
  });

  it('does not flag an unnamed spawn as isTeammateSpawn', () => {
    line(agentSpawnRecord());
    const start = messages.find((m) => m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID);
    expect(start).toBeDefined();
    expect(start!.isTeammateSpawn).toBeUndefined();
  });

  it('re-broadcasts the spawn tool flagged runInBackground when the async result lands', () => {
    // The tool_use input OMITS run_in_background on current harnesses, so the
    // original agentToolStart went out unflagged. Without the flagged
    // re-broadcast, the webview removes the Subtask at the first turn-end
    // clear and recreates it at a new tile (the teleport bug). Sidecar not
    // written yet: the Subtask is still the spawn's only representation.
    spawnAndLaunch();

    const flagged = messages.find(
      (m) =>
        m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID && m.runInBackground === true,
    );
    expect(flagged).toBeDefined();
    expect(flagged!.toolName).toBe('Agent');
  });

  // ── Unnamed spawn = Sub-agent (derived agent) ───────────────────────

  it('materializes an unnamed spawn as a derived agent under its spawner', () => {
    const jsonlPath = seedSidecar();
    spawnAndLaunch();

    expect(lead.backgroundAgentToolIds.has(SPAWN_TOOL_ID)).toBe(true);
    const kids = children();
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({
      parentAgentId: 1,
      spawnAgentKey: 'a4cb86c99458dbe55',
      spawnToolUseId: SPAWN_TOOL_ID,
      role: 'general-purpose',
      label: 'Say hello',
      depth: 1,
      jsonlFile: jsonlPath,
    });
    // Unnamed: a Sub-agent, not a Teammate — no name, no lead badge.
    expect(kids[0].agentName).toBeUndefined();
    expect(kids[0].leadAgentId).toBeUndefined();
    expect(lead.isTeamLead).toBeUndefined();
    // The transient Subtask sprite is superseded by the real character.
    expect(
      messages.some((m) => m.type === 'subagentClear' && m.parentToolId === SPAWN_TOOL_ID),
    ).toBe(true);
  });

  it("drives the derived agent's own character from its transcript", () => {
    seedSidecar({
      transcriptLines: [subToolUseLine(), subToolResultLine(), subTurnDurationLine()],
    });
    spawnAndLaunch();
    const child = children()[0];

    const start = messages.find((m) => m.type === 'agentToolStart' && m.toolId === SUB_TOOL_ID);
    expect(start).toBeDefined();
    expect(start!.id).toBe(child.id);
    expect(start!.status).toContain('x.ts');
    expect(
      messages.some((m) => m.type === 'agentStatus' && m.id === child.id && m.status === 'waiting'),
    ).toBe(true);
    // Nothing is translated onto the spawner any more (the shadow store retired).
    expect(messages.some((m) => m.type === 'subagentToolStart')).toBe(false);
    expect(
      messages.some((m) => m.type === 'agentToolStart' && m.id === 1 && m.toolId === SUB_TOOL_ID),
    ).toBe(false);
  });

  it('re-sends a not-yet-materialized spawn tool with toolName + runInBackground at turn end', () => {
    // No sidecar yet: the Subtask sub-character is the spawn's only
    // representation and MUST be recreatable after the turn-end clear.
    spawnAndLaunch();
    line(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_fg', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
    );
    messages.length = 0;
    line(JSON.stringify({ type: 'system', subtype: 'turn_duration' }));
    const resent = messages.find((m) => m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID);
    expect(resent).toBeDefined();
    expect(resent!.toolName).toBe('Agent');
    expect(resent!.runInBackground).toBe(true);
  });

  it('re-sends a not-yet-materialized spawn tool when a new user prompt clears activity', () => {
    // clearAgentActivity used to re-send background tools WITHOUT toolName/
    // runInBackground -- the webview then failed to recreate the Subtask and
    // the sub-character despawned on the next user prompt.
    spawnAndLaunch();
    messages.length = 0;
    line(JSON.stringify({ type: 'user', message: { content: 'now do something else' } }));
    const resent = messages.find((m) => m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID);
    expect(resent).toBeDefined();
    expect(resent!.toolName).toBe('Agent');
    expect(resent!.runInBackground).toBe(true);
  });

  it('does not re-send the spawn tool at turn end once an unnamed spawn is a character', () => {
    seedSidecar();
    spawnAndLaunch();
    line(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_fg', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
    );
    messages.length = 0;
    line(JSON.stringify({ type: 'system', subtype: 'turn_duration' }));
    line(JSON.stringify({ type: 'user', message: { content: 'next' } }));
    expect(messages.some((m) => m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID)).toBe(
      false,
    );
  });

  it('keeps the derived agent, available, when the completion queue-operation lands', () => {
    seedSidecar();
    spawnAndLaunch();
    const child = children()[0];

    line(queueOpCompletionRecord('completed'));

    // Finishing is not leaving (docs/adr/0003): its parent may resume it.
    expect(children()).toEqual([child]);
    expect(child.presence).toBe('available');
    expect(runtime.pollingTimers.has(child.id)).toBe(true);
    expect(lead.backgroundAgentToolIds.has(SPAWN_TOOL_ID)).toBe(true);
  });

  it('walks the derived agent out when the notice says killed, then removes it', () => {
    const jsonlPath = seedSidecar();
    spawnAndLaunch();
    const child = children()[0];
    expect(runtime.pollingTimers.has(child.id)).toBe(true);

    line(queueOpCompletionRecord('killed'));

    expect(child.presence).toBe('leaving');
    expect(runtime.pollingTimers.has(child.id)).toBe(false);
    expect(lead.backgroundAgentToolIds.size).toBe(0);
    runtime.removeAgent(child.id); // its walk out is over (presence.test.ts pins the timing)
    expect(children()).toEqual([]);
    expect([...agents.values()].some((a) => a.jsonlFile === jsonlPath)).toBe(false);
  });

  it('does not create a second derived agent on a re-scan', () => {
    seedSidecar();
    spawnAndLaunch();
    expect(children()).toHaveLength(1);

    scan();
    scan();

    expect(children()).toHaveLength(1);
  });

  // ── Foreground spawns (open Agent tool, no async result) ───────────

  function foregroundResultRecord(): string {
    return JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: SPAWN_TOOL_ID, content: 'Here is my report.' },
        ],
      },
    });
  }

  it('materializes a foreground spawn while its tool is open', () => {
    seedSidecar();
    // No async launch result: the tool is a live FOREGROUND spawn. Opening it
    // scans the tree right away.
    line(agentSpawnRecord());

    const kids = children();
    expect(kids).toHaveLength(1);
    expect(kids[0].spawnToolUseId).toBe(SPAWN_TOOL_ID);
    expect(lead.backgroundAgentToolIds.size).toBe(0);
  });

  it('walks the foreground derived agent out when the spawn tool completes', () => {
    seedSidecar();
    line(agentSpawnRecord());
    expect(children()).toHaveLength(1);

    line(foregroundResultRecord());

    expect(children().map((c) => c.presence)).toEqual(['leaving']);
    expect(
      messages.some((m) => m.type === 'subagentClear' && m.parentToolId === SPAWN_TOOL_ID),
    ).toBe(true);
  });

  // ── Named spawn = Teammate ──────────────────────────────────────────

  it('creates a teammate named from the sidecar name and badges the lead', () => {
    const jsonlPath = seedSidecar({ name: 'ghost-writer' });
    spawnAndLaunch();

    const teammate = [...agents.values()].find((a) => a.leadAgentId === 1);
    expect(teammate).toBeDefined();
    // The sidecar `name` wins over description/agentType.
    expect(teammate!.agentName).toBe('ghost-writer');
    expect(teammate!.parentAgentId).toBe(1);
    expect(teammate!.spawnToolUseId).toBe(SPAWN_TOOL_ID);
    expect(teammate!.jsonlFile).toBe(jsonlPath);
    // Derived team: NO teamName (config polling must stay away), but the
    // spawner becomes a Lead.
    expect(teammate!.teamName).toBeUndefined();
    expect(lead.isTeamLead).toBe(true);
    expect(
      messages.some((m) => m.type === 'agentTeamInfo' && m.id === 1 && m.isTeamLead === true),
    ).toBe(true);
    // The transient Subtask sub-character is superseded by the real character.
    expect(
      messages.some((m) => m.type === 'subagentClear' && m.parentToolId === SPAWN_TOOL_ID),
    ).toBe(true);
  });

  it('does not create a second teammate when the sidecar path is spelled differently', () => {
    // Windows only: the same transcript reaches the runtime spelled two ways
    // (hooks carry Claude's `process.cwd()` casing, scanners build from
    // Uri.fsPath's lowercased drive letter). An exact-string already-tracked
    // check missed and adopted the same background agent twice.
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      const jsonlPath = seedSidecar({ name: 'ghost-writer' });
      spawnAndLaunch();
      const teammates = [...agents.values()].filter((a) => a.leadAgentId === 1);
      expect(teammates).toHaveLength(1);

      // Re-scan with the agent's path stored under the other spelling, and
      // without the key that would otherwise dedupe it on its own.
      teammates[0].jsonlFile = jsonlPath.toUpperCase();
      teammates[0].spawnAgentKey = undefined;
      teammates[0].spawnToolUseId = undefined;
      scan();

      expect([...agents.values()].filter((a) => a.leadAgentId === 1)).toHaveLength(1);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('does not re-send the spawn tool at turn end for a named teammate (no ghost Subtask)', () => {
    seedSidecar({ name: 'ghost-writer' });
    spawnAndLaunch();
    // Add a foreground tool so the turn_duration cleanup branch runs.
    line(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'toolu_fg', name: 'Bash', input: { command: 'ls' } }],
        },
      }),
    );
    messages.length = 0;
    line(JSON.stringify({ type: 'system', subtype: 'turn_duration' }));
    expect(messages.some((m) => m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID)).toBe(
      false,
    );
  });

  it('does not re-send the spawn tool on a new user prompt once a teammate exists', () => {
    seedSidecar({ name: 'ghost-writer' });
    spawnAndLaunch();
    messages.length = 0;
    line(JSON.stringify({ type: 'user', message: { content: 'now do something else' } }));
    expect(messages.some((m) => m.type === 'agentToolStart' && m.toolId === SPAWN_TOOL_ID)).toBe(
      false,
    );
  });

  it('keeps a completed teammate (available) and its lead badge', () => {
    seedSidecar({ name: 'ghost-writer' });
    spawnAndLaunch();

    line(queueOpCompletionRecord());

    const teammate = [...agents.values()].find((a) => a.leadAgentId === 1);
    expect(teammate?.presence).toBe('available');
    expect(lead.isTeamLead).toBe(true);
  });

  it('walks a killed teammate out and drops the badge once it is gone', () => {
    seedSidecar({ name: 'ghost-writer' });
    spawnAndLaunch();
    const teammate = [...agents.values()].find((a) => a.leadAgentId === 1)!;

    line(queueOpCompletionRecord('killed'));

    expect(teammate.presence).toBe('leaving');
    expect(lead.backgroundAgentToolIds.size).toBe(0);
    // Still walking out: still its lead.
    expect(lead.isTeamLead).toBe(true);
    runtime.removeAgent(teammate.id); // its walk out is over
    expect([...agents.values()].some((a) => a.leadAgentId === 1)).toBe(false);
    expect(lead.isTeamLead).toBeUndefined();
  });

  // ── Shared gate ─────────────────────────────────────────────────────

  it('adopts nothing when the sidecar toolUseId matches no live spawn', () => {
    // Stale sidecar from an earlier session: same shape, dead toolUseId.
    const subagentsDir = path.join(tmpRoot, LEAD_SESSION, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(subagentsDir, 'agent-old.jsonl'), '');
    fs.writeFileSync(
      path.join(subagentsDir, 'agent-old.meta.json'),
      JSON.stringify({ agentType: 'general-purpose', toolUseId: 'toolu_dead', name: 'stale' }),
    );
    spawnAndLaunch();
    expect(children()).toEqual([]);
  });
});

describe('background spawn persistence & derived team lifecycle', () => {
  function fakeAdapter(initial: unknown[] = []): StateAdapter & { saved: unknown[][] } {
    const saved: unknown[][] = [];
    return {
      saved,
      loadAgents: () => initial as never,
      saveAgents: (agents) => {
        saved.push(agents as unknown[]);
      },
      loadSeats: () => ({}),
      saveSeats: () => {},
      getSetting: <T>(_key: string, defaultValue: T) => defaultValue,
      setSetting: () => {},
    };
  }

  it('persists the lead backgroundAgentToolIds and never the spawned children', () => {
    const store = new AgentStateStore();
    const adapter = fakeAdapter();
    store.setAdapter(adapter);

    const lead = createLeadAgent('/tmp/proj');
    lead.backgroundAgentToolIds.add(SPAWN_TOOL_ID);
    store.set(1, lead);

    const child = createLeadAgent('/tmp/proj');
    child.id = 2;
    child.agentName = 'ghost-writer';
    child.leadAgentId = 1;
    child.parentAgentId = 1;
    child.spawnToolUseId = SPAWN_TOOL_ID;
    store.set(2, child);

    // Unnamed sub-agent, one level deeper.
    const grandchild = createLeadAgent('/tmp/proj');
    grandchild.id = 3;
    grandchild.parentAgentId = 2;
    grandchild.spawnAgentKey = 'bbb';
    grandchild.spawnToolUseId = 'toolu_child';
    store.set(3, grandchild);

    // A derived node without a spawn tool id (future workflow nodes).
    const node = createLeadAgent('/tmp/proj');
    node.id = 4;
    node.parentAgentId = 1;
    node.nodeKind = 'workflow';
    store.set(4, node);

    store.persist();

    const persisted = adapter.saved.at(-1) as Array<Record<string, unknown>>;
    expect(persisted).toHaveLength(1);
    expect(persisted[0].id).toBe(1);
    expect(persisted[0].backgroundAgentToolIds).toEqual([SPAWN_TOOL_ID]);
  });

  it('drops the LEAD badge when the last teammate leaves', () => {
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, claudeProvider);
    try {
      const lead = createLeadAgent('/tmp/proj');
      lead.isTeamLead = true;
      store.set(1, lead);
      const teammate = createLeadAgent('/tmp/proj');
      teammate.id = 2;
      teammate.agentName = 'ghost-writer';
      teammate.leadAgentId = 1;
      teammate.spawnToolUseId = SPAWN_TOOL_ID;
      store.set(2, teammate);
      const broadcasts: Array<Record<string, unknown>> = [];
      store.on('broadcast', (m) => broadcasts.push(m as Record<string, unknown>));

      runtime.removeTeammate(2, 'test');

      expect(store.has(2)).toBe(false);
      expect(store.get(1)!.isTeamLead).toBeUndefined();
      const demote = broadcasts.find((m) => m.type === 'agentTeamInfo' && m.id === 1);
      expect(demote).toBeDefined();
      expect(demote!.isTeamLead).toBeUndefined();
    } finally {
      runtime.dispose();
    }
  });

  it('keeps the LEAD badge while other teammates remain', () => {
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, claudeProvider);
    try {
      const lead = createLeadAgent('/tmp/proj');
      lead.isTeamLead = true;
      store.set(1, lead);
      for (const [id, name] of [
        [2, 'ghost-writer'],
        [3, 'researcher'],
      ] as const) {
        const teammate = createLeadAgent('/tmp/proj');
        teammate.id = id;
        teammate.agentName = name;
        teammate.leadAgentId = 1;
        teammate.spawnToolUseId = `${SPAWN_TOOL_ID}-${id}`;
        store.set(id, teammate);
      }

      runtime.removeTeammate(2, 'test');

      expect(store.get(1)!.isTeamLead).toBe(true);
    } finally {
      runtime.dispose();
    }
  });

  it('restores the lead set and skips stale child entries (leadAgentId, no teamName)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-bg-restore-'));
    const leadJsonl = path.join(tmpRoot, `${LEAD_SESSION}.jsonl`);
    const childJsonl = path.join(tmpRoot, 'child.jsonl');
    fs.writeFileSync(leadJsonl, '');
    fs.writeFileSync(childJsonl, '');

    const adapter = fakeAdapter([
      {
        id: 1,
        sessionId: LEAD_SESSION,
        terminalName: '',
        isExternal: true,
        jsonlFile: leadJsonl,
        projectDir: tmpRoot,
        backgroundAgentToolIds: [SPAWN_TOOL_ID],
      },
      {
        // Stale background child written by an older build: derived state,
        // must not resurrect as an immortal character.
        id: 2,
        sessionId: LEAD_SESSION,
        terminalName: '',
        isExternal: true,
        jsonlFile: childJsonl,
        projectDir: tmpRoot,
        agentName: 'Say hello',
        leadAgentId: 1,
      },
    ]);

    const store = new AgentStateStore();
    store.setAdapter(adapter);
    const runtime = new AgentRuntime(store, claudeProvider);
    try {
      runtime.restoreExternalAgents();

      expect(store.has(1)).toBe(true);
      expect(store.has(2)).toBe(false);
      expect(store.get(1)!.backgroundAgentToolIds.has(SPAWN_TOOL_ID)).toBe(true);
    } finally {
      runtime.dispose();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
