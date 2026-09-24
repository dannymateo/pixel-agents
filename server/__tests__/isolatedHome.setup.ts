/**
 * Per-worker guard (vitest setupFile, runs before every test file). Fails the
 * file before a single test runs unless the isolated-home globalSetup is in
 * effect in THIS worker: HOME/USERPROFILE point at the run's throwaway home and
 * the real os.homedir() does too. The same check runs again around every test,
 * so a test that repoints HOME/USERPROFILE mid-file (and would hand that to the
 * next test or to spawned children) fails instead of silently escaping. The
 * real `os` is loaded through createRequire so a test file's own
 * `vi.mock('os')` can't mask the check.
 */
import { createRequire } from 'module';
import * as path from 'path';
import { afterEach, beforeEach } from 'vitest';

import { isRealHome, REAL_HOMES_ENV, TEST_HOME_ENV } from './isolatedHome.shared.js';

const realOs = createRequire(import.meta.url)('os') as typeof import('os');

const testHome = process.env[TEST_HOME_ENV];
const realHomes = JSON.parse(process.env[REAL_HOMES_ENV] ?? '[]') as string[];

function assertIsolatedHome(when: string): void {
  const resolved = realOs.homedir();
  if (
    !testHome ||
    realHomes.length === 0 ||
    isRealHome(resolved, realHomes) ||
    path.resolve(resolved) !== path.resolve(testHome) ||
    process.env.HOME !== testHome ||
    process.env.USERPROFILE !== testHome
  ) {
    throw new Error(
      `[isolatedHome] ${when}: os.homedir() is ${resolved} (HOME=${process.env.HOME}, ` +
        `USERPROFILE=${process.env.USERPROFILE}), expected the isolated test home ` +
        `${testHome ?? '(unset — is the globalSetup wired in vitest.config.ts?)'}; ` +
        'refusing to run tests that could touch the real ~/.pixel-agents or ~/.claude.',
    );
  }
}

assertIsolatedHome('before loading the test file');
beforeEach(() => assertIsolatedHome('before the test'));
afterEach(() => assertIsolatedHome('after the test (it left HOME/USERPROFILE changed)'));
