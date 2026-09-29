import type { ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import {
  permissionRequest,
  preToolUseBash,
  sendHookEvent,
  sessionEndExit,
  sessionEndPromptInputExit,
  sessionStartStartup,
  stop,
} from '../../helpers/hooks';
import {
  claudeScenario,
  type ExternalClaudeSpawn,
  spawnExternalClaudeScenario,
} from '../../helpers/mock-claude';
import { launchStandalone } from '../../helpers/standalone';
import { getClaudeProjectDir } from '../../helpers/team';

/**
 * "agentes interactivos" (spec 2026-09-29): "Te esperan", resuming a recent
 * session, and "Traer a la oficina", proven end to end against the standalone
 * browser server with mock-claude — never the real CLI (see
 * e2e/README.md → "Mocking model & rules"; standalone's one documented
 * exception is `sendHookEvent` for an action that has no terminal to host a
 * scenario step, used below for the operator's own SessionEnd).
 */

/** Same file both an externally-adopted mock session and an office console's
 *  own mock process append their invocation line to (see
 *  e2e/helpers/launch.ts's identical path for the VS Code fixture). */
function invocationLogPath(tmpHome: string): string {
  return path.join(tmpHome, '.claude-mock', 'invocations.log');
}

/** The test hooks this spec drives (webview-ui/src/testHooks.ts): a
 *  point-in-time snapshot of every character (DOM-free, so it works before
 *  "always show labels" would render an overlay) and the same
 *  selection-setting hook console.spec.ts uses to reveal an agent's overlay
 *  controls deterministically. */
interface InteractiveTestWindow {
  __pixelAgentsTestHooks?: {
    getCharacters?: () => Array<{ id: number }>;
    selectAgent?: (id: number) => void;
  };
}

async function getCharacterIds(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const hooks = (window as unknown as InteractiveTestWindow).__pixelAgentsTestHooks;
    return (hooks?.getCharacters?.() ?? []).map((c) => c.id);
  });
}

/**
 * Kill an externally-spawned mock `claude` and wait (bounded) for it to
 * actually be gone, so a later `session.cleanup()` doesn't race a still-open
 * handle on `workspaceDir` (its cwd) — `killTrackedExternalProcesses` alone
 * only signals, it never waits.
 *
 * On Windows `spawnExternalClaudeScenario` spawns with `shell: true`, so
 * `child` is `cmd.exe`, not the mock's own `node` process: `child.kill()`
 * only touches that shell and leaves the actual `mock-claude-runner.cjs`
 * process — and its lock on `workspaceDir` — running as an orphan. `taskkill
 * /t` kills the whole tree; everywhere else a plain signal reaches the real
 * process directly.
 */
async function stopExternalProcess(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } catch {
      // Already exited between the check above and here, or taskkill itself
      // is unavailable — fall back to a plain signal.
      child.kill('SIGTERM');
    }
  } else {
    child.kill('SIGTERM');
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test.describe('Standalone / interactive agents', () => {
  test('"Te esperan" counts a waiting external agent and clears when its session ends @area:standalone', async ({
    page,
  }) => {
    const session = await launchStandalone(page, { mockClaudeConsoles: true });
    let external: ExternalClaudeSpawn | undefined;
    try {
      const sessionId = 'attention-bar-session';
      external = await spawnExternalClaudeScenario({
        tmpHome: session.tmpHome,
        workspaceDir: session.workspaceDir,
        mockLogFile: invocationLogPath(session.tmpHome),
        sessionId,
        // Same shape as hooks-on/basic.spec.ts's "external Claude session
        // adopted via hook confirmation lifecycle": SessionStart -> PreToolUse
        // -> PermissionRequest -> Stop -> SessionEnd(exit). Stop alone does
        // NOT clear "Te esperan": a finished turn still "espera tu respuesta"
        // (office/attention.ts raises `waiting` on ANY agentStatus:'waiting',
        // not just idle_prompt) -- only the session actually ending removes
        // the agent (and its attention entry) outright.
        scenario: claudeScenario('te esperan — permission, stop, session end')
          .at(200)
          .emitHook(
            sessionStartStartup(sessionId, '{{cwd}}', '{{transcriptPath}}') as Record<
              string,
              unknown
            >,
          )
          .at(700)
          .emitHook(preToolUseBash(sessionId, 'npm test') as Record<string, unknown>)
          .at(3_000)
          .emitHook(permissionRequest(sessionId) as Record<string, unknown>)
          // Wide gap before Stop: this test's own dialog/modal interactions
          // (open the bar, open the agent's screen, close it) happen for real
          // in between and must not race the scenario's own timer.
          .at(15_000)
          .emitHook(stop(sessionId) as Record<string, unknown>)
          .at(17_000)
          .emitHook(sessionEndExit(sessionId) as Record<string, unknown>)
          .holdOpenFor(2_000)
          .build(),
      });

      const attentionBar = page.getByTestId('attention-bar');
      await expect(attentionBar).toHaveText(/Te esperan \(1\)/, { timeout: 20_000 });
      await expect.poll(() => page.title(), { timeout: 5_000 }).toMatch(/^\(1\)/);

      await attentionBar.click();
      const item = page.getByTestId('attention-item');
      await expect(item).toBeVisible();
      await item.click();

      // External root, no office console of its own: answering it opens its
      // screen (resolveAttendTarget's `screen` branch), not a console.
      const screen = page.getByTestId('agent-screen');
      await expect(screen).toBeVisible({ timeout: 10_000 });
      await screen.getByRole('button', { name: 'Cerrar' }).click();
      await expect(screen).toHaveCount(0);

      // SessionEnd(exit) at t+17s removes the agent outright (agentClosed),
      // which unconditionally drops its attention entry regardless of the
      // `waiting` reason Stop left behind.
      await expect(attentionBar).toHaveCount(0, { timeout: 20_000 });
      await expect.poll(() => page.title(), { timeout: 5_000 }).toBe('Pixel Agents');
    } finally {
      if (external) await stopExternalProcess(external.process);
      await session.cleanup();
    }
  });

  test('resumes a recent session from the launch dialog @area:standalone', async ({ page }) => {
    const session = await launchStandalone(page, { mockClaudeConsoles: true });
    try {
      const sessionId = crypto.randomUUID();
      const projectDir = getClaudeProjectDir(session.tmpHome, session.workspaceDir);
      fs.mkdirSync(projectDir, { recursive: true });
      const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
      fs.writeFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: 'user',
          cwd: session.workspaceDir,
          message: { content: 'Arregla el login' },
        })}\n`,
      );
      // Older than RECENT_SESSION_LIVE_WINDOW_MS (30s): a fresher mtime reads
      // as "probably still open in some terminal" and is excluded from the
      // resumable list (server/src/terminals/machineSessions.ts).
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(transcriptPath, old, old);

      await page.getByRole('button', { name: '+ Agent' }).click();
      await page.getByRole('button', { name: 'Sesiones recientes' }).click();

      const row = page.getByTestId('launch-session').filter({ hasText: 'Arregla el login' });
      await expect(row).toBeVisible({ timeout: 15_000 });
      await row.getByRole('button', { name: 'Retomar' }).click();

      const officeConsole = page.getByTestId('office-console');
      await expect(officeConsole).toBeVisible();
      await expect(officeConsole).toContainText('mock-claude listo', { timeout: 15_000 });

      const invocationLog = fs.readFileSync(invocationLogPath(session.tmpHome), 'utf8');
      expect(invocationLog).toContain(`--resume ${sessionId}`);
    } finally {
      await session.cleanup();
    }
  });

  test('"Traer a la oficina" resumes the same agent after its external SessionEnd @area:standalone', async ({
    page,
  }) => {
    const session = await launchStandalone(page, { mockClaudeConsoles: true });
    let external: ExternalClaudeSpawn | undefined;
    try {
      const sessionId = 'takeover-session';
      external = await spawnExternalClaudeScenario({
        tmpHome: session.tmpHome,
        workspaceDir: session.workspaceDir,
        mockLogFile: invocationLogPath(session.tmpHome),
        sessionId,
        scenario: claudeScenario('traer a la oficina — waits for SessionEnd')
          .at(200)
          .emitHook(
            sessionStartStartup(sessionId, '{{cwd}}', '{{transcriptPath}}') as Record<
              string,
              unknown
            >,
          )
          // The real CLI stamps `cwd` on every transcript record (spec's own
          // "Hechos verificados"); the mock's autoInit record doesn't. Takeover
          // reads `cwd` back from the TRANSCRIPT, not the SessionStart hook
          // payload (server/src/terminals/sessionTranscript.ts readSessionCwd),
          // so without this line requestTakeover refuses with "Its transcript
          // records no folder".
          .at(400)
          .appendJsonl({ type: 'user', cwd: '{{cwd}}' })
          .at(700)
          .emitHook(preToolUseBash(sessionId, 'npm test') as Record<string, unknown>)
          // No scripted end: the test itself decides when the operator
          // "closed" the external terminal (below), well within this window.
          .holdOpenFor(30_000)
          .build(),
      });

      await expect.poll(() => getCharacterIds(page), { timeout: 15_000 }).toHaveLength(1);
      const [agentId] = await getCharacterIds(page);

      await page.evaluate((id) => {
        const hooks = (window as unknown as InteractiveTestWindow).__pixelAgentsTestHooks;
        hooks?.selectAgent?.(id);
      }, agentId);

      const overlay = page.locator(`[data-testid="agent-overlay"][data-agent-id="${agentId}"]`);
      await expect(overlay).toBeVisible({ timeout: 10_000 });
      await overlay.getByTestId('takeover').click();
      await expect(overlay.getByTestId('takeover-waiting')).toBeVisible();

      // The real operator types /exit in their own terminal; here the test
      // sends the SAME hook the mock's own exit would have produced, directly
      // (e2e/README.md's one standalone exception — no terminal hosts this
      // external session's mock process for a scenario step to run in).
      await sendHookEvent(session.hookServerConfig, sessionEndPromptInputExit(sessionId));

      const officeConsole = page.getByTestId('office-console');
      await expect(officeConsole).toBeVisible({ timeout: 15_000 });
      // Same character, same agent id: the console that opened is its own,
      // not a freshly launched one.
      await expect(page.getByText(`Agente #${agentId}`).first()).toBeVisible();
      await expect(officeConsole).toContainText('mock-claude listo', { timeout: 15_000 });

      const invocationLog = fs.readFileSync(invocationLogPath(session.tmpHome), 'utf8');
      expect(invocationLog).toContain(`--resume ${sessionId}`);
    } finally {
      if (external) await stopExternalProcess(external.process);
      await session.cleanup();
    }
  });
});
