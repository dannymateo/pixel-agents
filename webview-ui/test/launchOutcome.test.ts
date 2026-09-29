import { expect, test } from 'vitest';

import { launchDialogView, type LaunchOutcome } from '../src/console/launchOutcome.js';

const ok = (seq: number): LaunchOutcome => ({ seq, ok: true });
const fail = (seq: number, error: string): LaunchOutcome => ({ seq, ok: false, error });

test('no attempt sent: never busy, never shows an error', () => {
  expect(launchDialogView(null, null)).toEqual({ busy: false, error: null });
  expect(launchDialogView(null, fail(3, 'boom'))).toEqual({ busy: false, error: null });
  expect(launchDialogView(null, ok(3))).toEqual({ busy: false, error: null });
});

test('attempt sent, no newer outcome yet: busy, no error', () => {
  expect(launchDialogView(5, null)).toEqual({ busy: true, error: null });
  // An outcome at or before the marker is not this attempt's answer.
  expect(launchDialogView(5, fail(5, 'stale'))).toEqual({ busy: true, error: null });
  expect(launchDialogView(5, fail(4, 'older'))).toEqual({ busy: true, error: null });
});

test('a newer failed outcome ends busy and shows its error', () => {
  expect(launchDialogView(5, fail(6, 'Choose a folder'))).toEqual({
    busy: false,
    error: 'Choose a folder',
  });
});

test('a newer successful outcome ends busy with no error', () => {
  expect(launchDialogView(5, ok(6))).toEqual({ busy: false, error: null });
});

test('two consecutive failures with the SAME message both resolve busy (seq-driven, not text-driven)', () => {
  // Attempt 1: sent at marker 0, fails at seq 1.
  expect(launchDialogView(0, fail(1, 'No se pudo lanzar'))).toEqual({
    busy: false,
    error: 'No se pudo lanzar',
  });
  // Attempt 2: sent at marker 1 (the seq just observed), fails again at seq 2
  // with the exact same message — must still resolve busy, not get stuck.
  expect(launchDialogView(1, null)).toEqual({ busy: true, error: null });
  expect(launchDialogView(1, fail(2, 'No se pudo lanzar'))).toEqual({
    busy: false,
    error: 'No se pudo lanzar',
  });
});

test('an outcome from before this dialog opened (no attempt sent here) is ignored', () => {
  // A previous, cancelled dialog's launch failed after this one opened.
  expect(launchDialogView(null, fail(9, 'old failure from a cancelled launch'))).toEqual({
    busy: false,
    error: null,
  });
});
