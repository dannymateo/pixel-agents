/**
 * The "click the monitor" entry to the agent screen: which agent a monitor
 * (PC_* furniture) belongs to.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import { monitorAt, monitorOwnerAt, monitorSeat } from '../src/office/layout/monitorOwner.js';
import type { PlacedFurniture, Seat } from '../src/office/types.js';
import { Direction } from '../src/office/types.js';

// PC sprites are 1×2 (the top row is a background row), desks 2×2.
const footprintOf = (type: string) =>
  type.startsWith('PC_') ? { w: 1, h: 2 } : type.startsWith('DESK') ? { w: 2, h: 2 } : undefined;

function pc(uid: string, col: number, row: number, type = 'PC_FRONT_OFF'): PlacedFurniture {
  return { uid, type, col, row };
}

function seat(uid: string, seatCol: number, seatRow: number, facingDir: Seat['facingDir']): Seat {
  return { uid, seatCol, seatRow, facingDir, assigned: false };
}

// A workstation as the default layout builds it: chair below the desk, facing
// UP at the monitor standing on the desk.
//   row 1:  [pc top]
//   row 2:  [pc bottom / desk]
//   row 3:  [chair]
const chairA = seat('chairA', 4, 3, Direction.UP);

test('a click on either footprint tile of a monitor finds it; elsewhere nothing', () => {
  const furniture = [pc('m1', 4, 1)];
  assert.equal(monitorAt(furniture, 4, 1, footprintOf)?.uid, 'm1');
  assert.equal(monitorAt(furniture, 4, 2, footprintOf)?.uid, 'm1');
  assert.equal(monitorAt(furniture, 5, 2, footprintOf), null);
  assert.equal(monitorAt(furniture, 4, 3, footprintOf), null);
});

test('only PC_* furniture counts as a monitor', () => {
  const furniture: PlacedFurniture[] = [{ uid: 'd', type: 'DESK_FRONT', col: 4, row: 1 }];
  assert.equal(monitorAt(furniture, 4, 1, footprintOf), null);
});

test('the seated agent owns the monitor it faces', () => {
  const owner = monitorOwnerAt(
    4,
    1,
    [pc('m1', 4, 1)],
    [chairA],
    (id) => (id === 'chairA' ? 42 : null),
    footprintOf,
  );
  assert.equal(owner, 42);
});

test('a monitor in front of an empty seat opens nobody — not even the neighbour', () => {
  // Two workstations side by side; only the left one is taken. The right
  // monitor is also inside the left seat's side region, but the right seat is
  // nearer to it.
  const chairB = seat('chairB', 5, 3, Direction.UP);
  const furniture = [pc('m1', 4, 1), pc('m2', 5, 1)];
  const occupant = (id: string) => (id === 'chairA' ? 42 : null);
  assert.equal(monitorOwnerAt(5, 1, furniture, [chairA, chairB], occupant, footprintOf), null);
  assert.equal(monitorOwnerAt(4, 1, furniture, [chairA, chairB], occupant, footprintOf), 42);
});

test('the nearest facing seat wins when several reach the monitor', () => {
  // Monitor straight ahead of chairA, diagonal to chairB.
  const chairB = seat('chairB', 5, 3, Direction.UP);
  assert.equal(monitorSeat(pc('m1', 4, 1), [chairB, chairA], footprintOf)?.uid, 'chairA');
});

test('a seat facing away from the monitor does not own it', () => {
  const facingDown = seat('down', 4, 3, Direction.DOWN);
  assert.equal(monitorSeat(pc('m1', 4, 1), [facingDown], footprintOf), null);
});

test('a monitor out of reach belongs to no seat', () => {
  // Four tiles ahead is past the facing depth.
  const far = seat('far', 4, 6, Direction.UP);
  assert.equal(monitorSeat(pc('m1', 4, 1), [far], footprintOf), null);
});

test('side-facing seats reach their monitor too', () => {
  const facingRight = seat('right', 2, 2, Direction.RIGHT);
  assert.equal(
    monitorSeat(pc('m1', 3, 1, 'PC_SIDE_OFF'), [facingRight], footprintOf)?.uid,
    'right',
  );
});

test('a monitor with no known footprint is ignored', () => {
  const unknown = (): undefined => undefined;
  assert.equal(
    monitorOwnerAt(4, 1, [pc('m1', 4, 1)], [chairA], () => 42, unknown),
    null,
  );
});
