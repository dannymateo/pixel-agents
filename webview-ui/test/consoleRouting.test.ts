import { expect, test } from 'vitest';

import { consoleMessageFor } from '../src/console/consoleRouting.js';

test('picks only this console’s messages', () => {
  expect(consoleMessageFor({ type: 'terminalOutput', terminalId: 't1', data: 'hi' }, 't1')).toEqual(
    { kind: 'output', data: 'hi' },
  );
  expect(consoleMessageFor({ type: 'terminalOutput', terminalId: 't2', data: 'hi' }, 't1')).toBe(
    null,
  );
});

test('snapshot and exit', () => {
  expect(
    consoleMessageFor(
      { type: 'terminalSnapshot', terminalId: 't1', data: 'x', exited: true },
      't1',
    ),
  ).toEqual({ kind: 'snapshot', data: 'x', exited: true });
  expect(consoleMessageFor({ type: 'terminalExit', terminalId: 't1', exitCode: 2 }, 't1')).toEqual({
    kind: 'exit',
    exitCode: 2,
  });
});

test('malformed wire data is ignored', () => {
  expect(consoleMessageFor(null, 't1')).toBe(null);
  expect(consoleMessageFor({ type: 'terminalOutput', terminalId: 't1', data: 5 }, 't1')).toBe(null);
  expect(consoleMessageFor({ type: 'terminalExit', terminalId: 't1' }, 't1')).toBe(null);
});
