import { expect, test } from '../../fixtures/standalone';
import { claudeScenario } from '../../helpers/mock-claude';
import { selectCharacter } from '../../helpers/office';
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
import { buildAssistantToolUseRecord, buildUserToolResultRecord } from '../../helpers/team';
import { setSettings } from '../../helpers/webview';

// The agent screen (spec §4): an agent's transcript as a live feed — diffs of
// its edits, output of its commands. It carries code, so only a connection that
// proved the server token (the URL the CLI printed) may see it.

const SESSION_ID = 'standalone-agent-screen-session';
const LEAD_SPAWN = 'toolu_screen_spawn';
const DEV = { key: 'd5c4', label: 'Pantalla de prueba', type: 'desarrollador' };
const ADDED_LINE = 'const feedProbe = true;';
const BASH_OUTPUT = 'feed-probe-output-42';
const SCREEN_TIMEOUT_MS = 20_000;

/** The test hooks this spec drives (webview-ui/src/testHooks.ts). */
interface ScreenTestWindow {
  __pixelAgentsTestHooks?: {
    selectAgent?: (id: number | null) => void;
    monitorClientPoint?: (agentId: number) => { x: number; y: number } | null;
  };
}

function agentScreenScenario() {
  let scenario = withSubagentTranscript(claudeScenario('agent screen feed'), DEV.key);
  scenario = scenario.at(1_000).appendJsonl(buildAgentSpawnRecord(LEAD_SPAWN, DEV.label, DEV.type));
  scenario = writeSpawnFiles(scenario, 1_500, {
    agentKey: DEV.key,
    agentType: DEV.type,
    description: DEV.label,
    toolUseId: LEAD_SPAWN,
    spawnDepth: 1,
  });
  const inDev = { session: subagentAlias(DEV.key) };
  return (
    scenario
      .at(2_500)
      .appendJsonl(
        inSubagent(
          DEV.key,
          buildAssistantToolUseRecord('toolu_edit', 'Edit', {
            file_path: '/repo/feed-probe.ts',
            old_string: 'const feedProbe = false;',
            new_string: ADDED_LINE,
          }),
        ),
        inDev,
      )
      .at(3_000)
      .appendJsonl(inSubagent(DEV.key, buildUserToolResultRecord('toolu_edit')), inDev)
      .at(3_500)
      .appendJsonl(
        inSubagent(
          DEV.key,
          buildAssistantToolUseRecord('toolu_bash', 'Bash', { command: 'echo feed-probe' }),
        ),
        inDev,
      )
      .at(4_000)
      .appendJsonl(inSubagent(DEV.key, buildUserToolResultRecord('toolu_bash', BASH_OUTPUT)), inDev)
      // The spawn never returns while the test runs: the sub-agent stays seated.
      .holdOpenFor(90_000)
      .build()
  );
}

test.describe('Standalone / agent screen', () => {
  test('agent screen shows a sub-agent diff and command output, only to the tokened page @area:standalone', async ({
    page,
    standalone,
  }) => {
    // Heuristic mode: the mocked session is adopted from its transcript and
    // the spawn tree from its sidecar (no hook events in this scenario).
    await setSettings(page, {
      hooksEnabled: false,
      watchAllSessions: true,
      alwaysShowLabels: true,
    });

    const mock = await spawnStandaloneClaudeScenario(standalone, agentScreenScenario(), SESSION_ID);
    try {
      await expectDerivedAgentVisible(page, DEV.label, 30_000);
      const devId = Number(
        await getDerivedAgentOverlay(page, DEV.label).getAttribute('data-agent-id'),
      );
      expect(devId).toBeGreaterThan(0);

      // 1. The "Ver pantalla" button on the selected agent's overlay.
      await selectCharacter(page, devId);
      await page
        .locator(`[data-testid="agent-overlay"][data-agent-id="${devId}"]`)
        .getByTestId('agent-screen-open')
        .click();
      const screen = page.getByTestId('agent-screen');
      await expect(screen).toBeVisible();
      const feed = screen.getByTestId('agent-screen-feed');
      await expect(feed.getByText(`+${ADDED_LINE}`, { exact: true })).toBeVisible({
        timeout: SCREEN_TIMEOUT_MS,
      });
      await expect(feed).toContainText(BASH_OUTPUT, { timeout: SCREEN_TIMEOUT_MS });

      await page.keyboard.press('Escape');
      await expect(screen).toHaveCount(0);

      // 2. The monitor at its desk opens the same screen. Deselect first: the
      //    selected agent's overlay floats right over its monitor and takes
      //    the click (an unselected overlay lets clicks through).
      await page.evaluate(() => {
        (window as unknown as ScreenTestWindow).__pixelAgentsTestHooks?.selectAgent?.(null);
      });
      // The point exists once the agent sits at its desk (not while walking in).
      const monitorPoint = () =>
        page.evaluate(
          (id) =>
            (window as unknown as ScreenTestWindow).__pixelAgentsTestHooks?.monitorClientPoint?.(
              id,
            ) ?? null,
          devId,
        );
      await expect.poll(monitorPoint, { timeout: SCREEN_TIMEOUT_MS }).not.toBeNull();
      const point = await monitorPoint();
      expect(point).not.toBeNull();
      await page.mouse.click(point!.x, point!.y);
      await expect(screen).toBeVisible();
      await expect(screen.getByTestId('agent-screen-feed')).toContainText(ADDED_LINE, {
        timeout: SCREEN_TIMEOUT_MS,
      });
      await page.keyboard.press('Escape');
      await expect(screen).toHaveCount(0);

      // 3. A page opened WITHOUT the token watches the office but is refused
      //    the screen, and never receives a line of it.
      const bareUrl = new URL(page.url());
      bareUrl.search = '';
      const spectator = await page.context().newPage();
      try {
        // The e2e flag is per page: without it the spectator has no test hooks.
        await spectator.addInitScript(() => {
          (window as unknown as { __PIXEL_AGENTS_E2E?: boolean }).__PIXEL_AGENTS_E2E = true;
        });
        await spectator.goto(bareUrl.toString());
        await expect(spectator.getByRole('button', { name: 'Settings' })).toBeVisible({
          timeout: 30_000,
        });
        await expect(
          spectator.locator(`[data-testid="agent-overlay"][data-agent-id="${devId}"]`),
        ).toHaveCount(1, { timeout: SCREEN_TIMEOUT_MS });
        await selectCharacter(spectator, devId);
        await spectator
          .locator(`[data-testid="agent-overlay"][data-agent-id="${devId}"]`)
          .getByTestId('agent-screen-open')
          .click();
        const spectatorScreen = spectator.getByTestId('agent-screen');
        await expect(spectatorScreen.getByTestId('agent-screen-denied')).toBeVisible({
          timeout: SCREEN_TIMEOUT_MS,
        });
        await expect(spectatorScreen).not.toContainText(ADDED_LINE);
        await expect(spectatorScreen).not.toContainText(BASH_OUTPUT);
      } finally {
        await spectator.close();
      }
    } finally {
      await stopStandaloneClaudeScenario(mock);
    }
  });
});
