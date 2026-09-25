import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { claudeScenario } from '../../helpers/mock-claude';
import {
  buildAgentSpawnRecord,
  expectDerivedAgentVisible,
  getDerivedAgentOverlay,
  inSubagent,
  subagentAlias,
  withSubagentTranscript,
  writeSpawnFiles,
} from '../../helpers/spawnTree';
import {
  spawnStandaloneClaudeScenario,
  stopStandaloneClaudeScenario,
} from '../../helpers/standalone';
import { buildAssistantToolUseRecord } from '../../helpers/team';
import { setSettings } from '../../helpers/webview';

// Conversations between agents (spec §4b): the lead assigning work walks to
// the new sub-agent and says the prompt; the sub-agent's handback walks it to
// the lead and says its report. The words are transcript content, so a page
// opened without the server token sees the same scenes with "…".
//
// Only live records speak (history is never replayed), so the spawn comes
// well after the session is adopted (external scan every 3 s), and every
// record carries the write-time `timestamp` real transcripts have.
//
// Budget: the sub-agent walks in from the door (~20 s on a loaded machine),
// the speaker walks to the listener and types at 80 chars/s. Waits get 90 s.

const SESSION_ID = 'standalone-conversations-session';
const LEAD_SPAWN = 'toolu_conv_spawn';
const DEV = { key: 'c0a1', label: 'Login con PKCE', type: 'desarrollador' };
const PROMPT = 'Implementa el login OAuth con PKCE y sus pruebas';
const REPORT = 'Listo: login OAuth con PKCE, pruebas en verde';
const SCENE_TIMEOUT_MS = 90_000;

const stamped = (record: Record<string, unknown>) => ({ ...record, timestamp: '{{now}}' });

function conversationScenario() {
  let scenario = withSubagentTranscript(claudeScenario('agent conversations'), DEV.key);
  scenario = scenario
    .at(10_000)
    .appendJsonl(
      stamped(buildAgentSpawnRecord(LEAD_SPAWN, DEV.label, DEV.type, { prompt: PROMPT })),
    );
  scenario = writeSpawnFiles(scenario, 10_500, {
    agentKey: DEV.key,
    agentType: DEV.type,
    description: DEV.label,
    toolUseId: LEAD_SPAWN,
    spawnDepth: 1,
  });
  return (
    scenario
      .at(30_000)
      .appendJsonl(
        stamped(
          inSubagent(
            DEV.key,
            buildAssistantToolUseRecord('toolu_handback', 'SubagentHandback', { message: REPORT }),
          ),
        ),
        { session: subagentAlias(DEV.key) },
      )
      // The spawn never returns while the test runs: nobody leaves.
      .holdOpenFor(150_000)
      .build()
  );
}

function bubble(page: Page, kind: 'assign' | 'report') {
  return page.locator(`[data-testid="conversation-bubble"][data-kind="${kind}"]`);
}

test.describe('Standalone / conversations', () => {
  test('agents walk over and talk: assignment and report, text only to the tokened page @area:standalone', async ({
    page,
    standalone,
  }) => {
    test.setTimeout(240_000);
    await setSettings(page, {
      hooksEnabled: false,
      watchAllSessions: true,
      alwaysShowLabels: true,
    });

    // The spectator is open before anything is said: scenes are live only.
    const bareUrl = new URL(page.url());
    bareUrl.search = '';
    const spectator = await page.context().newPage();
    await spectator.addInitScript(() => {
      (window as unknown as { __PIXEL_AGENTS_E2E?: boolean }).__PIXEL_AGENTS_E2E = true;
    });
    await spectator.goto(bareUrl.toString());
    await expect(spectator.getByRole('button', { name: 'Settings' })).toBeVisible({
      timeout: 30_000,
    });

    const mock = await spawnStandaloneClaudeScenario(
      standalone,
      conversationScenario(),
      SESSION_ID,
    );
    try {
      // 1. Assignment: the lead says the prompt to the new sub-agent.
      const assign = bubble(page, 'assign');
      await expect(assign.getByTestId('conversation-text')).toContainText(PROMPT.slice(0, 20), {
        timeout: SCENE_TIMEOUT_MS,
      });
      await expectDerivedAgentVisible(page, DEV.label, 30_000);
      const devId = await getDerivedAgentOverlay(page, DEV.label).getAttribute('data-agent-id');
      expect(await assign.getAttribute('data-agent-id')).not.toBe(devId);

      // 2. Report: the sub-agent walks to the lead and says its handback.
      const report = bubble(page, 'report');
      await expect(report.getByTestId('conversation-text')).toContainText(REPORT.slice(0, 20), {
        timeout: SCENE_TIMEOUT_MS,
      });
      expect(await report.getAttribute('data-agent-id')).toBe(devId);

      // 3. The untokened page saw the report scene too, without its words.
      const spectatorReport = bubble(spectator, 'report');
      await expect(spectatorReport).toHaveCount(1, { timeout: SCENE_TIMEOUT_MS });
      await expect(spectatorReport.getByTestId('conversation-text')).toHaveText('…');
      await expect(spectator.locator('body')).not.toContainText(REPORT.slice(0, 20));
      await expect(spectator.locator('body')).not.toContainText(PROMPT.slice(0, 20));
    } finally {
      await stopStandaloneClaudeScenario(mock);
      await spectator.close();
    }
  });
});
