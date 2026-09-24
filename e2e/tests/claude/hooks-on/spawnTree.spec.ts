import { test } from '../../../fixtures/pixel-agents';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  waitForClaudeHookSetup,
} from '../../../helpers/mock-claude';
import { expectOverlayCount, getAgentOverlays, getOverlayByAgentId } from '../../../helpers/office';
import {
  buildAgentSpawnRecord,
  expectAgentCharacterCount,
  expectDerivedAgentActivity,
  expectDerivedAgentVisible,
  expectTextNeverAppears,
  inSubagent,
  readRootAgentId,
  subagentAlias,
  subagentToolHook,
  withSubagentTranscript,
  writeSpawnFiles,
} from '../../../helpers/spawnTree';
import { buildAssistantToolUseRecord, buildUserToolResultRecord } from '../../../helpers/team';
import { getPixelAgentsFrame, openPixelAgentsPanel } from '../../../helpers/webview';

// Hooks ON variant of hooks-off/spawnTree.spec.ts. This is where the defect of
// docs/adr/0002 lives: a tool hook fired inside a spawned agent carries the
// ROOT's session_id (plus agent_id/agent_type), so resolving by session alone
// animated the lead. It must route to the node whose key is agent_id, and an
// agent_id that resolves to no node must never fall through to the root.

const LEAD_SPAWN = 'toolu_L';
const PHASE = { key: 'aaa', label: 'Fase 1', type: 'lider-fase', spawn: 'toolu_A' };
const DEV = { key: 'bbb', label: 'Implementar login', type: 'desarrollador', spawn: 'toolu_B' };
const QA = { key: 'ccc', label: 'Revisar login', type: 'qa-revisor' };
const READ_INPUT = { file_path: '/repo/spawn-tree-hooked.ts' };
const QA_READ_STATUS = 'Reading spawn-tree-hooked.ts';
const GHOST_COMMAND = 'npm run ghost-agent';
const MARKER_COMMAND = 'npm run after-ghost';

/** SubagentStart as Claude Code fires it: root session_id + the child's key and type. */
function subagentStartHook(agent: { key: string; type: string }): Record<string, unknown> {
  return {
    session_id: '{{sessionId}}',
    hook_event_name: 'SubagentStart',
    agent_id: agent.key,
    agent_type: agent.type,
  };
}

test.describe('Hooks ON / spawn tree', () => {
  test('spawn tree hooks with agent_id animate only their own node, never the lead @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    await waitForClaudeHookSetup(tmpHome);
    narrator.step(
      'arranging: lead → Fase 1 → developer → QA; the QA reads a file via hooks with agent_id=ccc',
    );
    let scenario = claudeScenario('spawn tree hooks routed by agent_id');
    for (const key of [PHASE.key, DEV.key, QA.key])
      scenario = withSubagentTranscript(scenario, key);
    scenario = scenario
      .at(1_000)
      .emitHook({
        session_id: '{{sessionId}}',
        hook_event_name: 'PreToolUse',
        tool_name: 'Agent',
        tool_input: { description: PHASE.label, subagent_type: PHASE.type },
        tool_use_id: LEAD_SPAWN,
      })
      .at(1_000)
      .appendJsonl(buildAgentSpawnRecord(LEAD_SPAWN, PHASE.label, PHASE.type));
    scenario = writeSpawnFiles(scenario, 1_500, {
      agentKey: PHASE.key,
      agentType: PHASE.type,
      description: PHASE.label,
      toolUseId: LEAD_SPAWN,
      spawnDepth: 1,
    })
      .at(1_500)
      .emitHook(subagentStartHook(PHASE))
      // aaa spawns bbb: keyed PreToolUse Agent (must not draw a ghost Subtask).
      .at(2_500)
      .emitHook(
        subagentToolHook('PreToolUse', PHASE, PHASE.spawn, 'Agent', {
          description: DEV.label,
          subagent_type: DEV.type,
        }),
      )
      .at(2_500)
      .appendJsonl(inSubagent(PHASE.key, buildAgentSpawnRecord(PHASE.spawn, DEV.label, DEV.type)), {
        session: subagentAlias(PHASE.key),
      });
    scenario = writeSpawnFiles(scenario, 3_000, {
      agentKey: DEV.key,
      agentType: DEV.type,
      description: DEV.label,
      toolUseId: PHASE.spawn,
      spawnDepth: 2,
      parentAgentId: PHASE.key,
    })
      .at(3_000)
      .emitHook(subagentStartHook(DEV))
      .at(4_000)
      .emitHook(
        subagentToolHook('PreToolUse', DEV, DEV.spawn, 'Agent', {
          description: QA.label,
          subagent_type: QA.type,
        }),
      )
      .at(4_000)
      .appendJsonl(inSubagent(DEV.key, buildAgentSpawnRecord(DEV.spawn, QA.label, QA.type)), {
        session: subagentAlias(DEV.key),
      });
    scenario = writeSpawnFiles(scenario, 4_500, {
      agentKey: QA.key,
      agentType: QA.type,
      description: QA.label,
      toolUseId: DEV.spawn,
      spawnDepth: 3,
      parentAgentId: DEV.key,
    })
      .at(4_500)
      .emitHook(subagentStartHook(QA))
      // The QA's Read: hook (root session_id + agent_id=ccc) and transcript
      // together, as the CLI does. Held open 10 s so a slow runner still
      // reaches the check while it is live (the hook marks ccc hookDelivered,
      // which suppresses the 7 s heuristic permission timer).
      // Note: ccc's own JSONL alone would also show the Read on ccc — the
      // POSITIVE proof that keyed hooks reach their node is the bbb marker below;
      // this Read's job is the negative on the lead.
      .at(10_000)
      .emitHook(subagentToolHook('PreToolUse', QA, 'toolu_R', 'Read', READ_INPUT))
      .at(10_000)
      .appendJsonl(inSubagent(QA.key, buildAssistantToolUseRecord('toolu_R', 'Read', READ_INPUT)), {
        session: subagentAlias(QA.key),
      })
      .at(20_000)
      .emitHook(subagentToolHook('PostToolUse', QA, 'toolu_R', 'Read', READ_INPUT))
      .at(20_000)
      .appendJsonl(inSubagent(QA.key, buildUserToolResultRecord('toolu_R')), {
        session: subagentAlias(QA.key),
      })
      // A hook from an agent_id no node has: must be dropped/buffered, never
      // routed to the lead. Then a KNOWN key's hook, a visible marker that
      // the ghost hook has already been delivered.
      .at(21_000)
      .emitHook(
        subagentToolHook(
          'PreToolUse',
          { key: 'zzz9', type: 'general-purpose' },
          'toolu_Z',
          'Bash',
          {
            command: GHOST_COMMAND,
          },
        ),
      )
      .at(22_000)
      .emitHook(subagentToolHook('PreToolUse', DEV, 'toolu_M', 'Bash', { command: MARKER_COMMAND }))
      .holdOpenFor(12_000);
    await arrangeNextClaudeInvocation(tmpHome, scenario.build());

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    narrator.step('waiting for all three levels to materialize');
    await expectDerivedAgentVisible(panelFrame, PHASE.label);
    await expectDerivedAgentVisible(panelFrame, DEV.label);
    await expectDerivedAgentVisible(panelFrame, QA.label);
    await expectAgentCharacterCount(panelFrame, 4);
    await expectOverlayCount(panelFrame, 4);
    const leadId = await readRootAgentId(panelFrame, [PHASE.label, DEV.label, QA.label]);
    narrator.check('lead + three derived agents on screen');

    narrator.step('the QA reads via hooks — sampling the lead the whole time');
    await expectTextNeverAppears(getOverlayByAgentId(panelFrame, leadId), QA_READ_STATUS, () =>
      expectDerivedAgentActivity(panelFrame, QA.label, QA_READ_STATUS),
    );
    narrator.check(`"${QA_READ_STATUS}" showed on the QA; the lead never showed it`);

    narrator.step('a hook with an unknown agent_id, then a marker hook on the developer');
    await expectTextNeverAppears(getAgentOverlays(panelFrame), GHOST_COMMAND, () =>
      expectDerivedAgentActivity(panelFrame, DEV.label, `Running: ${MARKER_COMMAND}`),
    );
    await expectAgentCharacterCount(panelFrame, 4, 1_000);
    await expectOverlayCount(panelFrame, 4, 1_000);
    narrator.check('the unknown agent_id animated nobody and spawned no character');
  });
});
