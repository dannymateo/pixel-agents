import { expect, test } from '../../../fixtures/pixel-agents';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import { arrangeNextClaudeInvocation, claudeScenario } from '../../../helpers/mock-claude';
import { expectOverlayCount, getOverlayByAgentId, getOverlayByText } from '../../../helpers/office';
import {
  buildAgentSpawnRecord,
  buildAgentSpawnResultRecord,
  buildAsyncSpawnResultRecord,
  expectAgentCharacterCount,
  expectDerivedAgentActivity,
  expectDerivedAgentGone,
  expectDerivedAgentVisible,
  getAgentCharacterOverlays,
  getDerivedAgentOverlay,
  inSubagent,
  readRootAgentId,
  subagentAlias,
  withSubagentTranscript,
  writeSpawnFiles,
} from '../../../helpers/spawnTree';
import {
  buildAssistantToolUseRecord,
  buildBackgroundAgentDoneRecord,
  buildUserToolResultRecord,
} from '../../../helpers/team';
import { getPixelAgentsFrame, openPixelAgentsPanel, setSettings } from '../../../helpers/webview';

// Every sidecar-backed spawn is a derived agent with its own character
// (docs/adr/0002). Hooks are OFF throughout: there is no SubagentStart, no
// agent_id on any event — the tree is read from the flat sidecars under
// <projectDir>/<sessionId>/subagents/ and each node's own transcript.
//
// Budget: each level needs one project scan (1 s) to materialize plus one
// transcript poll (500 ms) to see its own spawn call, so a depth-3 chain lands
// several seconds after its last file; timeouts are >= 20 s to absorb CI load.
const CASCADE_TIMEOUT_MS = 30_000;
/** How long removed derived agents must stay gone while their sidecars remain on disk. */
const STABILITY_WINDOW_MS = 3_000;

const LEAD_SPAWN = 'toolu_L';
const PHASE = { key: 'aaa', label: 'Fase 1', type: 'lider-fase', spawn: 'toolu_A' };
const DEV = { key: 'bbb', label: 'Implementar login', type: 'desarrollador', spawn: 'toolu_B' };
const QA = { key: 'ccc', label: 'Revisar login', type: 'qa-revisor' };
const QA_READ_STATUS = 'Reading spawn-tree-probe.ts';

test.describe('Hooks OFF / spawn tree', () => {
  test('spawn tree three levels deep renders every node and cascades on the root spawn result @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    narrator.step('hooks OFF — the tree comes from sidecars and per-node transcripts only');
    await setSettings(frame, { hooksEnabled: false });

    narrator.step(
      'arranging: lead spawns Fase 1 → it spawns a developer → it spawns a QA that reads a file',
    );
    let scenario = claudeScenario('spawn tree three levels deep');
    for (const key of [PHASE.key, DEV.key, QA.key])
      scenario = withSubagentTranscript(scenario, key);
    scenario = scenario
      .at(1_000)
      .appendJsonl(buildAgentSpawnRecord(LEAD_SPAWN, PHASE.label, PHASE.type));
    scenario = writeSpawnFiles(scenario, 1_500, {
      agentKey: PHASE.key,
      agentType: PHASE.type,
      description: PHASE.label,
      toolUseId: LEAD_SPAWN,
      spawnDepth: 1,
    })
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
      .at(5_500)
      .appendJsonl(
        inSubagent(
          QA.key,
          buildAssistantToolUseRecord('toolu_R', 'Read', {
            file_path: '/repo/spawn-tree-probe.ts',
          }),
        ),
        { session: subagentAlias(QA.key) },
      )
      // The Read returns (no permission wait); the QA stays mid-turn showing it.
      .at(6_500)
      .appendJsonl(inSubagent(QA.key, buildUserToolResultRecord('toolu_R')), {
        session: subagentAlias(QA.key),
      })
      // The lead's spawn returns while the whole subtree is still mid-work.
      // Deliberately NO turn_duration afterwards: turn end also drops open
      // foreground spawns, which would remove the subtree on its own and hide
      // a broken spawn-closed cascade.
      .at(24_000)
      .appendJsonl(buildAgentSpawnResultRecord(LEAD_SPAWN))
      .holdOpenFor(14_000);
    await arrangeNextClaudeInvocation(tmpHome, scenario.build());

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    narrator.step('waiting for all three levels to materialize as their own characters');
    await expectDerivedAgentVisible(panelFrame, PHASE.label);
    await expectDerivedAgentVisible(panelFrame, DEV.label);
    await expectDerivedAgentVisible(panelFrame, QA.label);
    await expectAgentCharacterCount(panelFrame, 4);
    // All overlays, Subtask sprites included: a materialized spawn replaces its
    // Subtask, so a ghost one next to the derived agent would make this 5+.
    await expectOverlayCount(panelFrame, 4);
    narrator.check('lead + Fase 1 + developer + QA — four characters, depth 3 reached');

    // Hooks OFF each node reads only its own transcript, so this is a smoke
    // check of the heuristic path; the hook-routing defect (docs/adr/0002)
    // lives in hooks ON and is covered there.
    narrator.step('the QA reads a file — only the QA may show it');
    await expectDerivedAgentActivity(panelFrame, QA.label, QA_READ_STATUS);
    const leadId = await readRootAgentId(panelFrame, [PHASE.label, DEV.label, QA.label]);
    // Snapshots taken while the QA shows the Read — a retrying matcher could
    // wait out a transient mis-animation of the lead and pass anyway.
    expect(await getOverlayByText(panelFrame, QA_READ_STATUS).count()).toBe(1);
    expect(await getOverlayByAgentId(panelFrame, leadId).textContent()).not.toContain(
      QA_READ_STATUS,
    );
    narrator.check(`"${QA_READ_STATUS}" is on the QA alone — the lead is not animated by it`);

    narrator.step('the lead’s spawn returns — the whole subtree must go with it');
    await expectDerivedAgentGone(panelFrame, QA.label, CASCADE_TIMEOUT_MS);
    await expectDerivedAgentGone(panelFrame, DEV.label);
    await expectDerivedAgentGone(panelFrame, PHASE.label);
    await expectAgentCharacterCount(panelFrame, 1);
    await expectOverlayCount(panelFrame, 1);
    await expect(getOverlayByAgentId(panelFrame, leadId)).toHaveCount(1);
    narrator.check('Fase 1, developer and QA are gone; the lead remains');

    // Stability check: the sidecars are still on disk, so a scan that ignored
    // the closed spawn would resurrect the subtree.
    narrator.step('holding — the closed subtree must not be re-materialized from its sidecars');
    await panelFrame.waitForTimeout(STABILITY_WINDOW_MS);
    await expectAgentCharacterCount(panelFrame, 1, 1_000);
    await expectOverlayCount(panelFrame, 1, 1_000);
    narrator.check('still only the lead');
  });

  test('spawn tree background spawn without SubagentStart materializes from a late sidecar and leaves on completion @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;
    const spawnToolId = 'toolu_BG';
    const explorer = { key: 'e7f3c2a1', label: 'Explorar repo', type: 'Explore' };

    narrator.step('hooks OFF — no SubagentStart will ever announce this spawn');
    await setSettings(frame, { hooksEnabled: false });

    narrator.step(
      'arranging: background spawn, async result, sidecar lands 3 s later, completion at t+20s',
    );
    let scenario = withSubagentTranscript(
      claudeScenario('spawn tree background spawn late sidecar'),
      explorer.key,
    )
      .at(1_000)
      .appendJsonl(
        buildAgentSpawnRecord(spawnToolId, explorer.label, explorer.type, {
          run_in_background: true,
        }),
      )
      .at(1_400)
      .appendJsonl(buildAsyncSpawnResultRecord(spawnToolId, explorer.key));
    // Well after the spawn call was parsed: only the periodic scan can find it.
    scenario = writeSpawnFiles(scenario, 4_500, {
      agentKey: explorer.key,
      agentType: explorer.type,
      description: explorer.label,
      toolUseId: spawnToolId,
      spawnDepth: 1,
    })
      .at(5_500)
      .appendJsonl(
        inSubagent(
          explorer.key,
          buildAssistantToolUseRecord('toolu_G', 'Grep', { pattern: 'login' }),
        ),
        { session: subagentAlias(explorer.key) },
      )
      .at(6_500)
      .appendJsonl(inSubagent(explorer.key, buildUserToolResultRecord('toolu_G')), {
        session: subagentAlias(explorer.key),
      })
      .at(20_000)
      .appendJsonl(buildBackgroundAgentDoneRecord(spawnToolId))
      .holdOpenFor(12_000);
    await arrangeNextClaudeInvocation(tmpHome, scenario.build());

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    narrator.step('waiting for the background spawn to become its own character');
    await expectDerivedAgentVisible(panelFrame, explorer.label);
    await expectDerivedAgentActivity(panelFrame, explorer.label, 'Searching code');
    await expectAgentCharacterCount(panelFrame, 2);
    await expectOverlayCount(panelFrame, 2);
    narrator.check('"Explorar repo" is a character of its own, driven by its own transcript');

    narrator.step('the completion queue-operation lands — the derived agent leaves');
    await expectDerivedAgentGone(panelFrame, explorer.label, CASCADE_TIMEOUT_MS);
    await expectAgentCharacterCount(panelFrame, 1);
    await expectOverlayCount(panelFrame, 1);
    narrator.check('back to the lead alone');

    // Stability check: the sidecar is still on disk; a gate that kept the
    // completed spawn live would re-materialize it on the next scan.
    narrator.step('holding — the completed spawn must not come back from its sidecar');
    await panelFrame.waitForTimeout(STABILITY_WINDOW_MS);
    await expectAgentCharacterCount(panelFrame, 1, 1_000);
    await expectOverlayCount(panelFrame, 1, 1_000);
    narrator.check('still only the lead');
  });

  test('spawn tree grandchild written before its parent appears once the parent exists @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;
    const leadSpawn = 'toolu_L2';
    const parent = { key: 'p1', label: 'Fase 2', type: 'lider-fase', spawn: 'toolu_P' };
    const grandchild = { key: 'g1', label: 'Tarea nieta', type: 'desarrollador' };

    narrator.step('hooks OFF — the grandchild’s files land before its parent’s');
    await setSettings(frame, { hooksEnabled: false });

    narrator.step(
      'arranging: grandchild sidecar at t+2s, parent sidecar at t+5s, parent spawn call at t+14s',
    );
    let scenario = claudeScenario('spawn tree grandchild before parent');
    for (const key of [parent.key, grandchild.key])
      scenario = withSubagentTranscript(scenario, key);
    scenario = scenario
      .at(1_000)
      .appendJsonl(buildAgentSpawnRecord(leadSpawn, parent.label, parent.type));
    scenario = writeSpawnFiles(scenario, 2_000, {
      agentKey: grandchild.key,
      agentType: grandchild.type,
      description: grandchild.label,
      toolUseId: parent.spawn,
      spawnDepth: 2,
      parentAgentId: parent.key,
    })
      .at(2_500)
      .appendJsonl(
        inSubagent(
          grandchild.key,
          buildAssistantToolUseRecord('toolu_E', 'Edit', { file_path: '/repo/nieta.ts' }),
        ),
        { session: subagentAlias(grandchild.key) },
      )
      .at(3_000)
      .appendJsonl(inSubagent(grandchild.key, buildUserToolResultRecord('toolu_E')), {
        session: subagentAlias(grandchild.key),
      });
    scenario = writeSpawnFiles(scenario, 5_000, {
      agentKey: parent.key,
      agentType: parent.type,
      description: parent.label,
      toolUseId: leadSpawn,
      spawnDepth: 1,
    })
      // Late on purpose: until the parent's spawn call is live the grandchild
      // must stay deferred — never attached to the root, never gate-skipped.
      .at(14_000)
      .appendJsonl(
        inSubagent(
          parent.key,
          buildAgentSpawnRecord(parent.spawn, grandchild.label, grandchild.type),
        ),
        { session: subagentAlias(parent.key) },
      )
      // No turn_duration: turn end would remove open foreground spawns by itself.
      .at(28_000)
      .appendJsonl(buildAgentSpawnResultRecord(leadSpawn))
      .holdOpenFor(14_000);
    await arrangeNextClaudeInvocation(tmpHome, scenario.build());

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    narrator.step('waiting for the parent; the grandchild must still be deferred');
    await expectDerivedAgentVisible(panelFrame, parent.label);
    // Snapshot (no retry): the parent's spawn call lands at t+14s, so right now
    // the grandchild's sidecar has no live spawn to hang from.
    expect(await getDerivedAgentOverlay(panelFrame, grandchild.label).count()).toBe(0);
    expect(await getAgentCharacterOverlays(panelFrame).count()).toBe(2);
    narrator.check('parent present, grandchild deferred — not hung from the lead');

    narrator.step('the parent opens its spawn — the grandchild joins');
    await expectDerivedAgentVisible(panelFrame, grandchild.label);
    await expectAgentCharacterCount(panelFrame, 3);
    await expectOverlayCount(panelFrame, 3);
    narrator.check('the grandchild waited for its parent and then joined — three characters');

    narrator.step('the lead’s spawn returns — parent and grandchild leave together');
    await expectDerivedAgentGone(panelFrame, grandchild.label, CASCADE_TIMEOUT_MS);
    await expectDerivedAgentGone(panelFrame, parent.label);
    await expectAgentCharacterCount(panelFrame, 1);
    await expectOverlayCount(panelFrame, 1);
    narrator.check('back to the lead alone');

    narrator.step('holding — neither comes back from the sidecars left on disk');
    await panelFrame.waitForTimeout(STABILITY_WINDOW_MS);
    await expectAgentCharacterCount(panelFrame, 1, 1_000);
    await expectOverlayCount(panelFrame, 1, 1_000);
    narrator.check('still only the lead');
  });
});
