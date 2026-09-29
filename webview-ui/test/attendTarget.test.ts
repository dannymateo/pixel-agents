import { expect, test } from 'vitest';

import { resolveAttendTarget } from '../src/office/attendTarget.js';

const lookup = (
  parents: Record<number, number>,
  terminals: Record<number, string>,
  isBrowser = true,
) => ({
  parentOf: (id: number) => parents[id],
  terminalOf: (id: number) => terminals[id],
  isBrowser,
});

test('an office agent opens its own console', () => {
  expect(resolveAttendTarget(1, lookup({}, { 1: 't1' }))).toEqual({
    kind: 'console',
    rootId: 1,
    terminalId: 't1',
  });
});

test('a sub-agent of an office agent opens its root console (any depth)', () => {
  expect(resolveAttendTarget(9, lookup({ 9: 5, 5: 1 }, { 1: 't1' }))).toEqual({
    kind: 'console',
    rootId: 1,
    terminalId: 't1',
  });
});

test('an external agent opens its screen in the browser, focuses its terminal in VS Code', () => {
  expect(resolveAttendTarget(4, lookup({}, {}))).toEqual({ kind: 'screen', id: 4 });
  expect(resolveAttendTarget(4, lookup({}, {}, false))).toEqual({ kind: 'focus', id: 4 });
});

test('a parent cycle never loops', () => {
  expect(resolveAttendTarget(2, lookup({ 2: 3, 3: 2 }, {}))).toEqual({ kind: 'screen', id: 2 });
});
