/**
 * Suite-wide home isolation (vitest globalSetup, runs once in the main process
 * before any worker exists).
 *
 * The code under test resolves ~/.pixel-agents and ~/.claude through
 * os.homedir(), which reads HOME on POSIX and USERPROFILE on Windows. Tests that
 * forgot one of the two read and wrote the developer's REAL config.json and
 * ~/.claude/settings.json. This points BOTH at a throwaway directory for the
 * whole run — workers and every child process a test spawns with
 * `{ ...process.env }` inherit it — and aborts the run if os.homedir() still
 * resolves to a real home. Per-file `vi.mock('os')` redirections keep working
 * on top of this; this is the floor they fall back to, not a replacement.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  isRealHome,
  REAL_HOMES_ENV,
  realHomeCandidates,
  TEST_HOME_ENV,
} from './isolatedHome.shared.js';

let testHome: string | undefined;
/** The main process's own values, put back on teardown (watch mode reruns
 *  setup in this same process, and must see the real home as a candidate). */
const ISOLATED_ENV_KEYS = ['HOME', 'USERPROFILE', TEST_HOME_ENV, REAL_HOMES_ENV] as const;
let savedEnv: Partial<Record<(typeof ISOLATED_ENV_KEYS)[number], string | undefined>> | undefined;

export function setup(): void {
  // Captured BEFORE the override: every name the real home goes by.
  const realHomes = realHomeCandidates();

  savedEnv = Object.fromEntries(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-vitest-home-'));
  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  process.env[TEST_HOME_ENV] = testHome;
  process.env[REAL_HOMES_ENV] = JSON.stringify(realHomes);

  const resolved = os.homedir();
  if (isRealHome(resolved, realHomes) || path.resolve(resolved) !== path.resolve(testHome)) {
    teardown();
    throw new Error(
      `[isolatedHome] os.homedir() resolves to ${resolved}, not the isolated test home — ` +
        'aborting so no test can touch the real ~/.pixel-agents or ~/.claude.',
    );
  }
}

export function teardown(): void {
  if (savedEnv) {
    for (const key of ISOLATED_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv = undefined;
  }
  if (!testHome) return;
  const dir = testHome;
  testHome = undefined;
  try {
    // Windows: a child still holding a file open makes rmSync throw EBUSY/EPERM
    // even with force; retry briefly, then leave the dir with a warning rather
    // than failing an otherwise green run.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.warn(`[isolatedHome] could not remove test home ${dir}:`, err);
  }
}
