/** Helpers shared by the isolated-home globalSetup and the per-worker guard. */
import * as os from 'os';
import * as path from 'path';

/** Env var carrying the run's throwaway home, set by the globalSetup. */
export const TEST_HOME_ENV = 'PIXEL_AGENTS_TEST_HOME';
/** Env var carrying the JSON list of the developer's real home paths. */
export const REAL_HOMES_ENV = 'PIXEL_AGENTS_TEST_REAL_HOMES';

/** Case-folded on Windows/macOS, whose default volumes are case-insensitive. */
function normalize(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

/** Every path the real home can be reached by: os.homedir() as the env stands,
 *  the account's profile dir (os.userInfo() ignores HOME/USERPROFILE), and the
 *  raw env vars themselves. */
export function realHomeCandidates(): string[] {
  const candidates = new Set<string>();
  const add = (p: string | undefined): void => {
    if (p && p.trim()) candidates.add(path.resolve(p));
  };
  add(os.homedir());
  try {
    add(os.userInfo().homedir);
  } catch {
    /* no passwd entry (some containers): the other sources still apply */
  }
  add(process.env.HOME);
  add(process.env.USERPROFILE);
  return [...candidates];
}

export function isRealHome(candidate: string, realHomes: readonly string[]): boolean {
  const c = normalize(candidate);
  return realHomes.some((home) => normalize(home) === c);
}
