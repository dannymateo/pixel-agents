/** Test-only override: a JSON array `[file, ...leadingArgs]` that replaces the
 *  provider's command (e2e points it at mock-claude so a test never starts the
 *  real CLI). Real users never set it. */
export const CLAUDE_COMMAND_OVERRIDE_ENV = 'PIXEL_AGENTS_CLAUDE_COMMAND';

function parseOverride(raw: string | undefined): string[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s)) {
      return v as string[];
    }
  } catch {
    /* ignored */
  }
  return null;
}

/**
 * The executable and argv an office console runs. The working directory is
 * NOT here: it is the pty's `cwd` option, so a path with spaces is never
 * re-split by a shell. On Windows `claude` is an npm `.cmd` shim, which only
 * cmd.exe can run.
 *
 * Contract: `launch.args` must never carry untrusted text — on Windows they
 * reach `cmd.exe /c`, which gives no injection protection.
 */
export function resolveLaunch(
  launch: { command: string; args: string[] },
  platform: NodeJS.Platform,
  override?: string,
): { file: string; args: string[] } {
  const custom = parseOverride(override);
  if (custom) {
    const [file, ...lead] = custom;
    return { file, args: [...lead, ...launch.args] };
  }
  if (platform === 'win32') {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', launch.command, ...launch.args] };
  }
  return { file: launch.command, args: [...launch.args] };
}
