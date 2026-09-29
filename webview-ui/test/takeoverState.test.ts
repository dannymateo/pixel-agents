import { expect, test } from 'vitest';

import { applyTakeover, canOfferTakeover } from '../src/console/takeoverState.js';

test('waitingExit puts the agent on the map', () => {
  const state = applyTakeover(new Map(), { type: 'takeoverStatus', id: 1, state: 'waitingExit' });
  expect(state.get(1)).toEqual({ state: 'waitingExit' });
});

test('done removes the entry', () => {
  const withEntry = new Map([[1, { state: 'waitingExit' as const }]]);
  const state = applyTakeover(withEntry, {
    type: 'takeoverStatus',
    id: 1,
    state: 'done',
    terminalId: 't1',
  });
  expect(state.has(1)).toBe(false);
});

test('cancelled removes the entry', () => {
  const withEntry = new Map([[1, { state: 'waitingExit' as const }]]);
  const state = applyTakeover(withEntry, { type: 'takeoverStatus', id: 1, state: 'cancelled' });
  expect(state.has(1)).toBe(false);
});

test('failed puts the agent on the map with its reason', () => {
  const state = applyTakeover(new Map(), {
    type: 'takeoverStatus',
    id: 2,
    state: 'failed',
    reason: 'cwd ya no existe',
  });
  expect(state.get(2)).toEqual({ state: 'failed', reason: 'cwd ya no existe' });
});

test('refused puts the agent on the map, reason optional (viewer filtering strips it)', () => {
  const state = applyTakeover(new Map(), { type: 'takeoverStatus', id: 3, state: 'refused' });
  expect(state.get(3)).toEqual({ state: 'refused', reason: undefined });
});

test('agentClosed removes any takeover state for that agent', () => {
  const withEntry = new Map([[1, { state: 'failed' as const, reason: 'boom' }]]);
  const state = applyTakeover(withEntry, { type: 'agentClosed', id: 1 });
  expect(state.has(1)).toBe(false);
});

test('is pure: returns the SAME map reference when nothing changes', () => {
  const state = new Map([[1, { state: 'failed' as const }]]);
  // done for an id with no entry: no-op
  expect(applyTakeover(state, { type: 'takeoverStatus', id: 99, state: 'done' })).toBe(state);
  // agentClosed for an id with no entry: no-op
  expect(applyTakeover(state, { type: 'agentClosed', id: 99 })).toBe(state);
  // unrelated message type: no-op
  expect(applyTakeover(state, { type: 'agentStatus', id: 1, status: 'active' })).toBe(state);
  // malformed input: no-op
  expect(applyTakeover(state, null)).toBe(state);
  expect(applyTakeover(state, { type: 'takeoverStatus', id: 'x', state: 'waitingExit' })).toBe(
    state,
  );
});

test('several agents track independently', () => {
  let state = new Map<number, { state: 'waitingExit' | 'failed' | 'refused'; reason?: string }>();
  state = applyTakeover(state, { type: 'takeoverStatus', id: 1, state: 'waitingExit' });
  state = applyTakeover(state, { type: 'takeoverStatus', id: 2, state: 'failed', reason: 'x' });
  expect(state.size).toBe(2);
  state = applyTakeover(state, { type: 'takeoverStatus', id: 1, state: 'cancelled' });
  expect(state.size).toBe(1);
  expect(state.get(2)).toEqual({ state: 'failed', reason: 'x' });
});

// ── canOfferTakeover ───────────────────────────────────────────

test('canOfferTakeover: a root agent with no console, when the connection can open one', () => {
  expect(canOfferTakeover({ parentAgentId: null }, true)).toBe(true);
  expect(canOfferTakeover({}, true)).toBe(true);
});

test('canOfferTakeover: never without console capability', () => {
  expect(canOfferTakeover({ parentAgentId: null }, false)).toBe(false);
});

test('canOfferTakeover: never for a derived agent (parent or team lead)', () => {
  expect(canOfferTakeover({ parentAgentId: 1 }, true)).toBe(false);
  expect(canOfferTakeover({ leadAgentId: 1 }, true)).toBe(false);
});

test('canOfferTakeover: never once it already has a console', () => {
  expect(canOfferTakeover({ parentAgentId: null, terminalId: 't1' }, true)).toBe(false);
});
