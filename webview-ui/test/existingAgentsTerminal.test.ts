/**
 * Regression for a reload losing an agent's office console (task 8 review,
 * critical finding): `handleWebviewReady` (server/src/clientMessageHandler.ts)
 * always sends `existingAgents` BEFORE `layoutLoaded`. On a fresh page load
 * the layout isn't ready yet, so `reconcileExistingAgents` buffers every
 * restored agent into `pendingAgents` instead of creating its character —
 * and the character (with its `terminalId`) is only created later, when
 * `layoutLoaded` flushes that buffer. If `terminalId` doesn't ride along on
 * the buffered `PendingAgent`, the flush creates the character with no
 * console, and clicking it can never reopen the terminal that was left
 * running server-side.
 *
 * This drives the exact two-call production sequence (`reconcileExistingAgents`
 * then `flushPendingAgents`, both used verbatim by useExtensionMessages.ts)
 * and asserts the character that comes out the other end still carries its
 * terminalId.
 */
import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { ExistingAgentMeta, PendingAgent } from '../src/office/engine/existingAgents.js';
import {
  flushPendingAgents,
  reconcileExistingAgents,
} from '../src/office/engine/existingAgents.js';

interface FakeCharacter {
  id: number;
  terminalId?: string;
}

/** Mirrors OfficeState just enough to drive reconcileExistingAgents +
 *  flushPendingAgents: addAgent creates the character, setTerminalId mutates
 *  it (a no-op if it doesn't exist yet — same contract as OfficeState). */
function fakeOffice() {
  const characters = new Map<number, FakeCharacter>();
  return {
    characters: { has: (id: number) => characters.has(id) },
    addAgent: (id: number) => {
      characters.set(id, { id });
    },
    setHeadless: () => {},
    setTerminalId: (id: number, terminalId: string) => {
      const ch = characters.get(id);
      if (ch) ch.terminalId = terminalId;
    },
    get: (id: number) => characters.get(id),
  };
}

test('reload: terminalId survives the pending buffer and the layoutLoaded flush', () => {
  const os = fakeOffice();
  const pending: PendingAgent[] = [];
  const meta: Record<number, ExistingAgentMeta> = {
    5: { seatId: 'seat-a', terminalId: 'term-5' },
  };

  // existingAgents arrives first, before the layout — buffered, not created.
  const addedDirectly = reconcileExistingAgents(os, [5], meta, {}, false, pending);
  assert.equal(addedDirectly, false);
  assert.equal(os.get(5), undefined, 'not created yet — still pending');
  assert.equal(
    pending[0]?.terminalId,
    'term-5',
    'terminalId must ride along on the buffered PendingAgent',
  );

  // layoutLoaded arrives next — the hook flushes every buffered agent.
  flushPendingAgents(os, pending);

  assert.equal(
    os.get(5)?.terminalId,
    'term-5',
    'the character must carry its console once the flush creates it',
  );
});

test('immediate add (layout already ready): terminalId is applied without a flush', () => {
  const os = fakeOffice();
  const pending: PendingAgent[] = [];
  const meta: Record<number, ExistingAgentMeta> = {
    5: { seatId: 'seat-a', terminalId: 'term-5' },
  };

  const addedDirectly = reconcileExistingAgents(os, [5], meta, {}, true, pending);

  assert.equal(addedDirectly, true);
  assert.equal(pending.length, 0);
  assert.equal(os.get(5)?.terminalId, 'term-5');
});
