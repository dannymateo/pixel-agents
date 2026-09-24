import { expect, test } from '../../../fixtures/pixel-agents';
import { readAgentSeats, readAreas } from '../../../helpers/editor';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import { arrangeNextClaudeInvocation, claudeScenario } from '../../../helpers/mock-claude';
import {
  buildAgentSpawnRecord,
  buildAsyncSpawnResultRecord,
  buildTaskNotificationRecord,
  expectDerivedAgentGone,
  expectDerivedAgentVisible,
  getDerivedAgentOverlay,
  inSubagent,
  readCharacterBubble,
  readCharacterIds,
  readCreation,
  subagentAlias,
  withSubagentTranscript,
  writeSpawnFiles,
} from '../../../helpers/spawnTree';
import { buildTurnDurationRecord } from '../../../helpers/team';
import { getPixelAgentsFrame, openPixelAgentsPanel, setSettings } from '../../../helpers/webview';

// The living office (docs/adr/0003): a team gets its own named module beside
// the user's office, derived agents walk in through the door, finishing is not
// leaving, and only a real stop sends them out — waving — after which a team
// that has left frees its module. Hooks are OFF: the tree comes from sidecars,
// the stops from real `<task-notification>` records in each parent's transcript.
//
// Budget: each level needs a project scan (1 s) plus a transcript poll
// (500 ms). A derived agent walks between the door (in the user's office) and
// its module desk at 3 tiles/s — ~60 tiles here, so ~20 s each way — then waves
// 1.5 s and fades. The server drops it from its store 6 s after it started
// leaving; the office lets the walk finish (a slow, loaded machine
// renders fewer frames and walks slower). Waits on a walk get 90 s.
const LIVING_TIMEOUT_MS = 30_000;
const WALK_TIMEOUT_MS = 90_000;

const ROOT_SPAWN = 'toolu_F1';
const LEAD = { key: 'fa11', label: 'Fase 1', type: 'lider-fase' };
const DEV_1 = { key: 'de71', label: 'Implementar login', type: 'desarrollador', spawn: 'toolu_D1' };
const DEV_2 = { key: 'de72', label: 'Implementar pagos', type: 'desarrollador', spawn: 'toolu_D2' };
const QA = { key: 'qa01', label: 'Revisar login', type: 'qa-revisor', spawn: 'toolu_Q1' };
const MEMBERS = [DEV_1, DEV_2, QA];

async function idOf(frame: Parameters<typeof getDerivedAgentOverlay>[0], label: string) {
  const raw = await getDerivedAgentOverlay(frame, label).getAttribute('data-agent-id');
  return Number(raw);
}

/** The session spawns "Fase 1" in the background at +1 s; from +2.5 s it
 *  spawns the two devs and the QA, 600 ms apart (all background). */
function teamScenario(name: string) {
  let scenario = claudeScenario(name);
  for (const node of [LEAD, ...MEMBERS]) scenario = withSubagentTranscript(scenario, node.key);
  scenario = scenario
    .at(1_000)
    .appendJsonl(
      buildAgentSpawnRecord(ROOT_SPAWN, LEAD.label, LEAD.type, { run_in_background: true }),
    )
    .at(1_300)
    .appendJsonl(buildAsyncSpawnResultRecord(ROOT_SPAWN, LEAD.key));
  scenario = writeSpawnFiles(scenario, 1_500, {
    agentKey: LEAD.key,
    agentType: LEAD.type,
    description: LEAD.label,
    toolUseId: ROOT_SPAWN,
    spawnDepth: 1,
  });
  let at = 2_500;
  for (const member of MEMBERS) {
    scenario = scenario
      .at(at)
      .appendJsonl(
        inSubagent(
          LEAD.key,
          buildAgentSpawnRecord(member.spawn, member.label, member.type, {
            run_in_background: true,
          }),
        ),
        { session: subagentAlias(LEAD.key) },
      )
      .at(at + 200)
      .appendJsonl(inSubagent(LEAD.key, buildAsyncSpawnResultRecord(member.spawn, member.key)), {
        session: subagentAlias(LEAD.key),
      });
    scenario = writeSpawnFiles(scenario, at + 400, {
      agentKey: member.key,
      agentType: member.type,
      description: member.label,
      toolUseId: member.spawn,
      spawnDepth: 2,
      parentAgentId: LEAD.key,
    });
    at += 600;
  }
  return scenario;
}

test.describe('Hooks OFF / living office', () => {
  test('living office: a team gets a named module, completed stays, killed walks out and frees it @area:teams', async ({
    pixelAgents,
  }) => {
    // The door→module walk is ~20 s each way; dev 2 walking out must be fully
    // observed before the lead's kill sends everyone else out.
    test.setTimeout(180_000);
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    narrator.step('hooks OFF — the tree comes from sidecars and per-node transcripts only');
    await setSettings(frame, { hooksEnabled: false });

    narrator.step(
      'arranging: the session spawns "Fase 1" in the background; it spawns two devs and a QA',
    );
    let scenario = teamScenario('living office team module lifecycle');
    scenario = scenario
      // Dev 1 finishes: available, resumable — it must stay at its desk.
      .at(10_000)
      .appendJsonl(buildTaskNotificationRecord(DEV_1.key, DEV_1.spawn, 'completed'), {
        session: subagentAlias(LEAD.key),
      })
      // Dev 2 is killed by its lead once seated: it walks out, waving.
      .at(30_000)
      .appendJsonl(buildTaskNotificationRecord(DEV_2.key, DEV_2.spawn, 'killed'), {
        session: subagentAlias(LEAD.key),
      })
      // The session kills the whole phase: the team leaves, leaves first.
      .at(75_000)
      .appendJsonl(buildTaskNotificationRecord(LEAD.key, ROOT_SPAWN, 'killed'))
      .holdOpenFor(30_000);
    await arrangeNextClaudeInvocation(tmpHome, scenario.build());

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    narrator.step('waiting for "Fase 1" and its three members');
    for (const node of [LEAD, ...MEMBERS]) {
      await expectDerivedAgentVisible(panelFrame, node.label, LIVING_TIMEOUT_MS);
    }
    narrator.check('the lead and its two devs and QA are characters of their own');

    narrator.step('the team has its own module, named after its lead');
    await expect
      .poll(async () => (await readAreas(panelFrame)).map((a) => a.label), {
        timeout: LIVING_TIMEOUT_MS,
      })
      .toContain(LEAD.label);
    const ids = new Map<string, number>();
    for (const node of [LEAD, ...MEMBERS]) ids.set(node.key, await idOf(panelFrame, node.label));
    await expect
      .poll(
        async () => {
          const seats = await readAgentSeats(panelFrame);
          return [LEAD, ...MEMBERS].map(
            (n) => seats.find((s) => s.id === ids.get(n.key))?.areaLabel ?? null,
          );
        },
        { timeout: LIVING_TIMEOUT_MS },
      )
      .toEqual([LEAD.label, LEAD.label, LEAD.label, LEAD.label]);
    narrator.check('module "Fase 1" holds the lead, both devs and the QA');

    narrator.step('derived agents walked in through the door (no matrix rain)');
    for (const member of MEMBERS) {
      expect(await readCreation(panelFrame, ids.get(member.key)!)).toMatchObject({
        skipSpawnEffect: true,
        matrixEffectAtCreation: null,
      });
    }
    narrator.check('every member entered by the door');

    narrator.step('dev 2 is killed — it waves goodbye at the door and leaves');
    const dev2 = ids.get(DEV_2.key)!;
    await expect
      .poll(() => readCharacterBubble(panelFrame, dev2), {
        timeout: WALK_TIMEOUT_MS,
        intervals: [150],
      })
      .toBe('goodbye');
    await expect
      .poll(() => readCharacterIds(panelFrame), { timeout: WALK_TIMEOUT_MS })
      .not.toContain(dev2);
    await expectDerivedAgentGone(panelFrame, DEV_2.label);
    await expect(getDerivedAgentOverlay(panelFrame, QA.label)).toHaveCount(1);
    expect((await readAreas(panelFrame)).map((a) => a.label)).toContain(LEAD.label);
    narrator.check('dev 2 said goodbye and left; the rest of the team and its module remain');

    // Dev 1 completed at t+10s, twenty seconds before dev 2 was even killed —
    // over three times the server's whole leave window: an agent treated as
    // leaving on its completion would be long gone.
    narrator.step('dev 1 completed long ago — finishing is not leaving');
    await expect(getDerivedAgentOverlay(panelFrame, DEV_1.label)).toHaveCount(1);
    expect(await readCharacterIds(panelFrame)).toContain(ids.get(DEV_1.key)!);
    const seats = await readAgentSeats(panelFrame);
    expect(seats.find((s) => s.id === ids.get(DEV_1.key))?.areaLabel).toBe(LEAD.label);
    narrator.check('dev 1 is still at its desk in "Fase 1", available');

    narrator.step('the session kills "Fase 1" — the whole team walks out');
    for (const node of [DEV_1, QA, LEAD]) {
      await expect
        .poll(() => readCharacterIds(panelFrame), { timeout: WALK_TIMEOUT_MS })
        .not.toContain(ids.get(node.key)!);
    }
    for (const node of [DEV_1, QA, LEAD]) await expectDerivedAgentGone(panelFrame, node.label);
    await expect
      .poll(async () => (await readAreas(panelFrame)).map((a) => a.label), {
        timeout: LIVING_TIMEOUT_MS,
      })
      .not.toContain(LEAD.label);
    narrator.check('everyone left and the "Fase 1" module is freed');
  });

  test('living office: a team that finishes before reaching its desks ends seated in its module @area:teams', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile, narrator } = pixelAgents;

    narrator.step('hooks OFF — the tree comes from sidecars and per-node transcripts only');
    await setSettings(frame, { hooksEnabled: false });

    // The walk from the door to the module takes ~20 s; every member ends its
    // turn and completes a few seconds after it is born, so the office sees it
    // go idle (agentStatus 'waiting') and `available` mid-walk. T25: the idle
    // FSM then stood the team up and wandered it off, its module desks empty.
    narrator.step('arranging: "Fase 1", two devs and a QA — all done within ~9 s');
    let scenario = teamScenario('living office team finishes before its desks');
    for (const [i, node] of [...MEMBERS, LEAD].entries()) {
      scenario = scenario
        .at(7_000 + i * 200)
        .appendJsonl(inSubagent(node.key, buildTurnDurationRecord()), {
          session: subagentAlias(node.key),
        });
    }
    for (const [i, member] of MEMBERS.entries()) {
      scenario = scenario
        .at(8_000 + i * 200)
        .appendJsonl(buildTaskNotificationRecord(member.key, member.spawn, 'completed'), {
          session: subagentAlias(LEAD.key),
        });
    }
    scenario = scenario
      .at(9_000)
      .appendJsonl(buildTaskNotificationRecord(LEAD.key, ROOT_SPAWN, 'completed'))
      .holdOpenFor(120_000);
    await arrangeNextClaudeInvocation(tmpHome, scenario.build());

    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);
    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);

    narrator.step('waiting for "Fase 1" and its three members');
    for (const node of [LEAD, ...MEMBERS]) {
      await expectDerivedAgentVisible(panelFrame, node.label, LIVING_TIMEOUT_MS);
    }
    const teamIds = await Promise.all([LEAD, ...MEMBERS].map((n) => idOf(panelFrame, n.label)));
    const moduleSeating = async () => {
      const seats = await readAgentSeats(panelFrame);
      return teamIds.map((id) => {
        const s = seats.find((x) => x.id === id);
        return s
          ? `${s.areaLabel ?? 'no area'}${s.seated ? '' : ` (not seated: ${s.state})`}`
          : 'missing';
      });
    };
    const allSeated = [LEAD.label, LEAD.label, LEAD.label, LEAD.label];

    narrator.step('everyone walks in and sits down at its desk in "Fase 1"');
    await expect
      .poll(moduleSeating, { timeout: WALK_TIMEOUT_MS, intervals: [250] })
      .toEqual(allSeated);
    narrator.check('the whole team sits in its module');

    // Available is "at its desk, waiting" (spec §3.3). The old idle FSM stood
    // an idle agent up 3–5 s after it sat down and wandered it off.
    narrator.step('they wait there — nobody stands up to wander');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      expect(await moduleSeating()).toEqual(allSeated);
      await panelFrame.waitForTimeout(500);
    }
    narrator.check('15 s later every member is still seated in "Fase 1"');
  });
});
