import { describe, expect, it } from 'vitest';

import { resolveLaunch } from '../src/terminals/launchCommand.js';

const LAUNCH = { command: 'claude', args: ['--session-id', 'abc'] };

describe('resolveLaunch', () => {
  it('runs claude directly on POSIX', () => {
    expect(resolveLaunch(LAUNCH, 'linux')).toEqual({
      file: 'claude',
      args: ['--session-id', 'abc'],
    });
  });

  it('goes through cmd.exe on Windows (claude is a .cmd shim)', () => {
    expect(resolveLaunch(LAUNCH, 'win32')).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', 'claude', '--session-id', 'abc'],
    });
  });

  it('never puts the working directory on the command line', () => {
    // cwd travels as the pty option; a path with spaces must not be split.
    const r = resolveLaunch(LAUNCH, 'win32');
    expect(r.args.join(' ')).not.toContain('Mis Proyectos');
  });

  it('an e2e override (JSON array) replaces the claude binary and keeps the args', () => {
    const override = JSON.stringify(['C:\\node.exe', 'C:\\e2e\\mock-claude-runner.cjs']);
    expect(resolveLaunch(LAUNCH, 'win32', override)).toEqual({
      file: 'C:\\node.exe',
      args: ['C:\\e2e\\mock-claude-runner.cjs', '--session-id', 'abc'],
    });
  });

  it('a malformed override is ignored', () => {
    expect(resolveLaunch(LAUNCH, 'linux', 'not json')).toEqual({
      file: 'claude',
      args: ['--session-id', 'abc'],
    });
    expect(resolveLaunch(LAUNCH, 'linux', '[]')).toEqual({
      file: 'claude',
      args: ['--session-id', 'abc'],
    });
  });
});
