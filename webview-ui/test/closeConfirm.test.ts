import { expect, test } from 'vitest';

import { closeClickStep } from '../src/console/closeConfirm.js';

test('an agent without an office console closes on the first click', () => {
  expect(closeClickStep(false, false)).toBe('close');
});

test('an office console asks first, then closes on the confirmation', () => {
  expect(closeClickStep(true, false)).toBe('ask');
  expect(closeClickStep(true, true)).toBe('close');
});
