import { expect, test } from '@playwright/test';

import { launchStandalone } from '../../helpers/standalone';

/** The test hook this spec drives (webview-ui/src/testHooks.ts), to click the
 *  launched agent's character on the canvas and reopen its console. */
interface ConsoleTestWindow {
  __pixelAgentsTestHooks?: {
    characterClientPoint?: (agentId: number) => { x: number; y: number } | null;
    selectAgent?: (agentId: number) => void;
  };
}

test.describe('Standalone / office console', () => {
  test('launch an agent from the browser and type into its console @area:standalone', async ({
    page,
  }) => {
    const session = await launchStandalone(page, { mockClaudeConsoles: true });
    try {
      await page.getByRole('button', { name: '+ Agent' }).click();

      // A fresh e2e HOME has no ~/.claude/projects, so the launch dialog's
      // project list is empty and the server no longer offers a default
      // folder (spec §2 — it used to be the server's own process.cwd(),
      // which on Windows service installs is C:\). Fill the workspace dir
      // the test itself spawned the server in.
      const cwdInput = page.getByTestId('launch-cwd');
      await expect(cwdInput).toHaveValue('');
      await cwdInput.fill(session.workspaceDir);

      await page.getByRole('button', { name: 'Lanzar' }).click();

      const console = page.getByTestId('office-console');
      await expect(console).toBeVisible();
      await expect(console).toContainText('mock-claude listo', { timeout: 15_000 });

      // The console's title ("Agente #<id>") is the only DOM-visible handle to
      // the launched agent's id without hovering/selecting its (otherwise
      // hidden) canvas overlay.
      const titleText = await page
        .getByText(/^Agente #\d+$/)
        .first()
        .textContent();
      const agentId = Number(titleText?.replace('Agente #', ''));
      expect(Number.isFinite(agentId)).toBe(true);

      await console.click();
      await page.keyboard.type('hola oficina');
      await page.keyboard.press('Enter');
      await expect(console).toContainText('mock-claude recibió: hola oficina', {
        timeout: 10_000,
      });

      // Closing the browser view keeps the console alive: re-open shows the snapshot.
      await page.getByRole('button', { name: 'Cerrar consola' }).click();
      await expect(console).toHaveCount(0);

      // Re-attach by clicking the agent's character on the canvas — the same
      // production path App.tsx's handleClick uses (an agent with a
      // terminalId reopens its console instead of focusing a VS Code
      // terminal). Wait until it's seated: a walking character's sprite
      // position is a moving target for the click.
      const characterPoint = () =>
        page.evaluate((id) => {
          const hooks = (window as unknown as ConsoleTestWindow).__pixelAgentsTestHooks;
          return hooks?.characterClientPoint?.(id) ?? null;
        }, agentId);
      await expect.poll(characterPoint, { timeout: 20_000 }).not.toBeNull();
      const point = await characterPoint();
      await page.mouse.click(point!.x, point!.y);

      await expect(console).toBeVisible();
      await expect(console).toContainText('mock-claude recibió: hola oficina', {
        timeout: 10_000,
      });
      await page.getByRole('button', { name: 'Cerrar consola' }).click();

      // Closing the agent from the office kills a live claude: the × asks
      // first, and only the confirmation closes it (spec §2).
      await page.evaluate((id) => {
        const hooks = (window as unknown as ConsoleTestWindow).__pixelAgentsTestHooks;
        hooks?.selectAgent?.(id);
      }, agentId);
      const overlay = page.locator(`[data-testid="agent-overlay"][data-agent-id="${agentId}"]`);
      await overlay.locator('button[title="Close agent"]').click();
      await expect(overlay.getByTestId('close-confirm')).toBeVisible();
      await expect(overlay).toHaveCount(1);
      await overlay.getByTestId('agent-close').click();
      await expect(overlay).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await session.cleanup();
    }
  });
});
