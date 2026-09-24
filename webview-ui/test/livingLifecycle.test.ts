/**
 * The living office's motion layer (docs/adr/0003): a derived agent ENTERS
 * through the door and walks to its desk, walks to the LOUNGE when the server
 * says it is resting, is walked BACK by any activity, and LEAVES through the
 * door with a goodbye bubble. The server owns presence; this is the OfficeState
 * half that animates it.
 *
 * Like greeter.test.ts, this tests the OfficeState DOMAIN MODEL on a real
 * instance: tile positions, seat reservations, door state and callback timing
 * are invariants e2e can only observe indirectly.
 *
 * The catalog is built by hand so the tests don't depend on sprite loading.
 * The door mirrors the bundled DOOR manifest (ids DOOR_CLOSED / DOOR_OPEN,
 * states `closed` / `open` — which the catalog does NOT pair, since it only
 * pairs on/off); a second door uses an on/off pair, the catalog's own
 * convention. A last test pins the bundled manifest to the ids assumed here.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, test } from 'vitest';

import {
  DOOR_OPEN_HOLD_MS,
  GOODBYE_BUBBLE_MS,
  MATRIX_EFFECT_DURATION_SEC,
} from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { CharacterState, Direction, TileType } from '../src/office/types.js';

// Distinct one-pixel "sprites" so a furniture instance tells which variant it is.
const DOOR_CLOSED_SPRITE = [['door-closed']];
const DOOR_OPEN_SPRITE = [['door-open']];
const ALT_DOOR_OFF_SPRITE = [['alt-door-off']];
const ALT_DOOR_ON_SPRITE = [['alt-door-on']];

beforeAll(() => {
  const entry = (
    id: string,
    category: string,
    extra: Partial<LoadedAssetData['catalog'][number]> = {},
  ): LoadedAssetData['catalog'][number] => ({
    id,
    label: id,
    category,
    width: 16,
    height: 16,
    footprintW: 1,
    footprintH: 1,
    isDesk: category === 'desks',
    ...extra,
  });
  const catalog: LoadedAssetData['catalog'] = [
    entry('TEST_DESK', 'desks'),
    entry('TEST_CHAIR', 'chairs'),
    entry('TEST_BEANBAG', 'chairs'),
    entry('DOOR_CLOSED', 'wall', {
      groupId: 'DOOR',
      orientation: 'front',
      state: 'closed',
      footprintH: 2,
      height: 32,
      canPlaceOnWalls: true,
    }),
    entry('DOOR_OPEN', 'wall', {
      groupId: 'DOOR',
      orientation: 'front',
      state: 'open',
      footprintH: 2,
      height: 32,
      canPlaceOnWalls: true,
    }),
    entry('ALT_DOOR_OFF', 'wall', {
      groupId: 'ALT_DOOR',
      state: 'off',
      footprintH: 2,
      height: 32,
      canPlaceOnWalls: true,
    }),
    entry('ALT_DOOR_ON', 'wall', {
      groupId: 'ALT_DOOR',
      state: 'on',
      footprintH: 2,
      height: 32,
      canPlaceOnWalls: true,
    }),
  ];
  const sprites: LoadedAssetData['sprites'] = {
    TEST_DESK: [['']],
    TEST_CHAIR: [['']],
    TEST_BEANBAG: [['']],
    DOOR_CLOSED: DOOR_CLOSED_SPRITE,
    DOOR_OPEN: DOOR_OPEN_SPRITE,
    ALT_DOOR_OFF: ALT_DOOR_OFF_SPRITE,
    ALT_DOOR_ON: ALT_DOOR_ON_SPRITE,
  };
  assert.equal(buildDynamicCatalog({ catalog, sprites }), true);
});

const COLS = 12;
const ROWS = 9;
/** Walk target: the floor tile in front of the door. */
const DOOR = { col: 2, row: 2, uid: 'door' };
const DESK_A = 'chair-a';
const DESK_B = 'chair-b';
const LOUNGE = ['bean-1', 'bean-2'];

/**
 * Rows 0-1 are wall (the door hangs there, footprint 1×2, bottom row on the
 * wall); rows 2..8 are floor. Two desks with a chair below each (seat faces UP),
 * and two beanbags in the bottom-left corner as the lounge.
 */
function livingLayout(doorType = 'DOOR_CLOSED'): OfficeLayout {
  const tiles: TileType[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      tiles.push(r < 2 ? TileType.WALL : TileType.FLOOR_1);
    }
  }
  const furniture: PlacedFurniture[] = [
    { uid: 'door', type: doorType, col: 2, row: 0 },
    { uid: 'desk-a', type: 'TEST_DESK', col: 8, row: 4 },
    { uid: DESK_A, type: 'TEST_CHAIR', col: 8, row: 5 },
    { uid: 'desk-b', type: 'TEST_DESK', col: 10, row: 4 },
    { uid: DESK_B, type: 'TEST_CHAIR', col: 10, row: 5 },
    { uid: 'bean-1', type: 'TEST_BEANBAG', col: 1, row: 7 },
    { uid: 'bean-2', type: 'TEST_BEANBAG', col: 3, row: 7 },
  ];
  return { version: 1, cols: COLS, rows: ROWS, tiles, furniture };
}

function livingOffice(): OfficeState {
  const os = new OfficeState(livingLayout());
  os.setLivingTargets({ door: DOOR, loungeSeats: LOUNGE });
  return os;
}

/** Advance the simulation in small frames, like the rAF loop does. */
function run(os: OfficeState, seconds: number): void {
  const dt = 0.05;
  for (let t = 0; t < seconds; t += dt) os.update(dt);
}

function doorSprite(os: OfficeState): 'open' | 'closed' | 'missing' {
  for (const f of os.furniture) {
    if (f.sprite === DOOR_OPEN_SPRITE || f.sprite === ALT_DOOR_ON_SPRITE) return 'open';
    if (f.sprite === DOOR_CLOSED_SPRITE || f.sprite === ALT_DOOR_OFF_SPRITE) return 'closed';
  }
  return 'missing';
}

function at(os: OfficeState, id: number): { col: number; row: number } {
  const ch = os.characters.get(id)!;
  return { col: ch.tileCol, row: ch.tileRow };
}

function seatTile(os: OfficeState, uid: string): { col: number; row: number } {
  const s = os.seats.get(uid)!;
  return { col: s.seatCol, row: s.seatRow };
}

/** An agent that entered and is now seated at its desk, idle between turns. */
function seatedAgent(os: OfficeState, id: number, seat: string): void {
  os.enterThroughDoor(id, seat);
  run(os, 10);
  os.setAgentActive(id, false);
  assert.deepEqual(at(os, id), seatTile(os, seat), 'precondition: seated at its desk');
}

// ── Entering ────────────────────────────────────────────────────

test('entering: appears at the door without the matrix effect, walks to its seat and sits', () => {
  const os = livingOffice();
  os.enterThroughDoor(1, DESK_A);

  const ch = os.characters.get(1)!;
  assert.ok(ch, 'enterThroughDoor creates the character');
  assert.deepEqual(at(os, 1), { col: DOOR.col, row: DOOR.row }, 'spawns on the door tile');
  assert.equal(ch.matrixEffect, null, 'derived agents use the door, not the matrix rain');
  assert.equal(ch.scripted, true, 'the FSM does not steer it while it walks in');
  assert.equal(ch.seatId, DESK_A);
  assert.equal(os.seats.get(DESK_A)!.assigned, true, 'its desk is reserved on the way in');

  run(os, 10);
  assert.deepEqual(at(os, 1), seatTile(os, DESK_A), 'reaches its seat');
  assert.equal(ch.state, CharacterState.TYPE, 'sits down');
  assert.equal(ch.dir, Direction.UP, 'faces the desk');
  assert.equal(ch.scripted, false, 'hands control back to the FSM once seated');
});

test('entering an existing character re-enters it through the door onto the given seat', () => {
  const os = livingOffice();
  os.addAgent(2, 0, 0, DESK_B, true);
  os.enterThroughDoor(2, DESK_A);
  assert.equal(os.characters.size, 1, 'no duplicate character');
  assert.deepEqual(at(os, 2), { col: DOOR.col, row: DOOR.row });
  assert.equal(os.seats.get(DESK_B)!.assigned, false, 'the old seat is released');
  run(os, 10);
  assert.deepEqual(at(os, 2), seatTile(os, DESK_A));
});

test('the door opens while someone stands in it and closes DOOR_OPEN_HOLD_MS after', () => {
  const os = livingOffice();
  os.update(0.01);
  assert.equal(os.isDoorOpen(), false, 'closed with nobody around');
  assert.equal(doorSprite(os), 'closed');

  os.enterThroughDoor(1, DESK_A);
  os.update(0.01);
  assert.equal(os.isDoorOpen(), true, 'opens while the newcomer is on its tile');
  assert.equal(doorSprite(os), 'open', 'the open variant is what gets drawn');

  // Walk off the door tile, then wait just under the hold: still open.
  let t = 0;
  while (at(os, 1).col === DOOR.col && at(os, 1).row === DOOR.row && t < 5) {
    os.update(0.01);
    t += 0.01;
  }
  run(os, DOOR_OPEN_HOLD_MS / 1000 - 0.2);
  assert.equal(os.isDoorOpen(), true, 'held open for DOOR_OPEN_HOLD_MS after it is vacated');
  run(os, 0.4);
  assert.equal(os.isDoorOpen(), false, 'closes once the hold runs out');
  assert.equal(doorSprite(os), 'closed');
  assert.equal(
    os.layout.furniture.find((f) => f.uid === 'door')!.type,
    'DOOR_CLOSED',
    'opening is render-time only — the layout is never rewritten',
  );
});

test('a door paired the catalog way (off/on) opens too', () => {
  const os = new OfficeState(livingLayout('ALT_DOOR_OFF'));
  os.setLivingTargets({ door: DOOR, loungeSeats: LOUNGE });
  os.update(0.01);
  assert.equal(doorSprite(os), 'closed');
  os.enterThroughDoor(1, DESK_A);
  os.update(0.01);
  assert.equal(doorSprite(os), 'open');
});

test('the bundled DOOR manifest keeps the closed/open ids the engine opens by name', () => {
  const file = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../public/assets/furniture/DOOR/manifest.json',
  );
  if (!fs.existsSync(file)) return; // assets not landed in this checkout
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    members?: Array<{ id?: string; state?: string }>;
  };
  const byState = new Map((manifest.members ?? []).map((m) => [m.state, m.id]));
  assert.equal(byState.get('closed'), 'DOOR_CLOSED');
  assert.equal(byState.get('open'), 'DOOR_OPEN');
});

// ── Lounge ──────────────────────────────────────────────────────

test('going to the lounge takes a free rest seat, keeps the desk, and stays there', () => {
  const os = livingOffice();
  seatedAgent(os, 1, DESK_A);
  seatedAgent(os, 2, DESK_B);

  os.goToLounge(1);
  os.goToLounge(2);
  run(os, 12);

  const spots = [at(os, 1), at(os, 2)].map((p) => `${p.col},${p.row}`).sort();
  assert.deepEqual(
    spots,
    LOUNGE.map((uid) => seatTile(os, uid))
      .map((p) => `${p.col},${p.row}`)
      .sort(),
    'each takes a DIFFERENT free rest seat',
  );
  for (const uid of LOUNGE) assert.equal(os.seats.get(uid)!.assigned, true, `${uid} reserved`);
  assert.equal(os.characters.get(1)!.seatId, DESK_A, 'its desk stays its own while it rests');
  assert.equal(os.seats.get(DESK_A)!.assigned, true, 'nobody else can take the desk meanwhile');
  assert.equal(os.characters.get(1)!.state, CharacterState.TYPE, 'sits (or plays) on the seat');

  // The wander FSM must not drag it back to its desk or around the office.
  run(os, 120);
  assert.deepEqual(
    [at(os, 1), at(os, 2)].map((p) => `${p.col},${p.row}`).sort(),
    spots,
    'still resting two minutes later',
  );
});

test('with every rest seat taken, a third resting agent stands by the lounge instead', () => {
  const os = new OfficeState(livingLayout());
  os.setLivingTargets({ door: DOOR, loungeSeats: ['bean-1'] });
  seatedAgent(os, 1, DESK_A);
  seatedAgent(os, 2, DESK_B);
  os.goToLounge(1);
  run(os, 12);
  os.goToLounge(2);
  run(os, 12);
  assert.deepEqual(at(os, 1), seatTile(os, 'bean-1'));
  const p = at(os, 2);
  const bean = seatTile(os, 'bean-1');
  assert.notDeepEqual(p, bean, 'does not share the occupied seat');
  assert.ok(Math.abs(p.col - bean.col) + Math.abs(p.row - bean.row) <= 2, 'waits beside it');
});

test('rest seats are never handed out as desks', () => {
  const os = livingOffice();
  os.addAgent(1, 0, 0, undefined, true);
  os.addAgent(2, 0, 0, undefined, true);
  os.addAgent(3, 0, 0, undefined, true);
  const seats = [1, 2, 3].map((id) => os.characters.get(id)!.seatId);
  assert.deepEqual(seats.slice(0, 2).sort(), [DESK_A, DESK_B]);
  assert.equal(seats[2], null, 'a third agent gets no seat rather than a beanbag');
});

// ── Returning ───────────────────────────────────────────────────

test('activity in the lounge walks it back to its desk first', () => {
  const os = livingOffice();
  seatedAgent(os, 1, DESK_A);
  os.goToLounge(1);
  run(os, 12);
  const bean = os.getSeatAtTile(at(os, 1).col, at(os, 1).row)!;
  assert.ok(LOUNGE.includes(bean), 'precondition: resting');

  os.setAgentActive(1, true); // what an agentToolStart does
  assert.equal(os.seats.get(bean)!.assigned, false, 'the rest seat is released at once');
  run(os, 12);
  const ch = os.characters.get(1)!;
  assert.deepEqual(at(os, 1), seatTile(os, DESK_A), 'back at its desk');
  assert.equal(ch.state, CharacterState.TYPE, 'working');
  assert.equal(ch.scripted, false);
});

test('returnToDesk walks a resting agent back and hands it to the FSM', () => {
  const os = livingOffice();
  seatedAgent(os, 1, DESK_A);
  os.goToLounge(1);
  run(os, 12);
  os.returnToDesk(1);
  // Once back, an idle agent belongs to the FSM again, whose random wander may
  // walk it off the desk before any fixed deadline: assert it ARRIVED.
  const desk = JSON.stringify(seatTile(os, DESK_A));
  let arrived = false;
  for (let step = 0; step < 120 && !arrived; step++) {
    run(os, 0.1);
    arrived = JSON.stringify(at(os, 1)) === desk;
  }
  assert.ok(arrived, 'walked back to its desk');
  run(os, 0.1);
  assert.equal(os.characters.get(1)!.scripted, false);
});

// ── Leaving ─────────────────────────────────────────────────────

test('leaving walks to the door, waves goodbye, fades out, then calls onGone once', () => {
  const os = livingOffice();
  seatedAgent(os, 1, DESK_A);
  let gone = 0;
  os.leaveThroughDoor(1, () => gone++);
  assert.equal(os.seats.get(DESK_A)!.assigned, false, 'its desk is free for the next agent');

  // Orders to move are ignored while it leaves.
  os.returnToDesk(1);
  os.goToLounge(1);
  os.sendToSeat(1);
  assert.equal(os.walkToTile(1, 6, 7), false, 'walk commands are refused');
  os.enterThroughDoor(1, DESK_B);
  os.setAgentActive(1, true);

  let t = 0;
  while (os.characters.get(1)?.bubbleType !== 'goodbye' && t < 10) {
    os.update(0.05);
    t += 0.05;
  }
  const ch = os.characters.get(1)!;
  assert.equal(ch.bubbleType, 'goodbye', 'shows the goodbye bubble');
  assert.deepEqual(at(os, 1), { col: DOOR.col, row: DOOR.row }, 'at the door when it waves');
  assert.equal(os.isDoorOpen(), true);
  assert.equal(os.seats.get(DESK_B)!.assigned, false, 're-entering was ignored');
  assert.equal(gone, 0, 'not gone yet');

  run(os, GOODBYE_BUBBLE_MS / 1000 - 0.2);
  assert.equal(gone, 0, 'the goodbye lasts GOODBYE_BUBBLE_MS');
  assert.ok(os.characters.has(1));

  run(os, 0.2 + MATRIX_EFFECT_DURATION_SEC + 0.2);
  assert.equal(gone, 1, 'onGone fires after the fade');
  assert.equal(os.characters.has(1), false, 'the character is gone');
  run(os, 2);
  assert.equal(gone, 1, 'exactly once');
  assert.equal(os.isDoorOpen(), false, 'and the door closes behind it');
});

test('a leaving agent in the lounge releases its rest seat and still exits', () => {
  const os = livingOffice();
  seatedAgent(os, 1, DESK_A);
  os.goToLounge(1);
  run(os, 12);
  let gone = 0;
  os.leaveThroughDoor(1, () => gone++);
  for (const uid of LOUNGE) assert.equal(os.seats.get(uid)!.assigned, false);
  run(os, 20);
  assert.equal(gone, 1);
});

test('with no path to the door it fades out where it stands', () => {
  const os = new OfficeState(livingLayout());
  // The door's walk target is a wall tile: unreachable.
  os.setLivingTargets({ door: { col: 5, row: 0, uid: 'door' }, loungeSeats: LOUNGE });
  seatedAgent(os, 1, DESK_A);
  const before = at(os, 1);
  let gone = 0;
  os.leaveThroughDoor(1, () => gone++);
  run(os, 0.5);
  assert.deepEqual(at(os, 1), before, 'never moves');
  run(os, GOODBYE_BUBBLE_MS / 1000 + MATRIX_EFFECT_DURATION_SEC + 0.5);
  assert.equal(gone, 1);
  assert.equal(os.characters.has(1), false);
});

test('without living targets, leaving fades out in place too', () => {
  const os = new OfficeState(livingLayout());
  os.addAgent(1, 0, 0, DESK_A, true);
  let gone = 0;
  os.leaveThroughDoor(1, () => gone++);
  run(os, GOODBYE_BUBBLE_MS / 1000 + MATRIX_EFFECT_DURATION_SEC + 0.5);
  assert.equal(gone, 1);
});

test('removeAgent while leaving finishes the exit and still calls onGone exactly once', () => {
  const os = livingOffice();
  seatedAgent(os, 1, DESK_A);
  let gone = 0;
  os.leaveThroughDoor(1, () => gone++);
  run(os, 0.3); // still walking
  os.removeAgent(1);
  assert.equal(os.characters.get(1)!.matrixEffect, null, 'fades, no matrix rain');
  run(os, MATRIX_EFFECT_DURATION_SEC + 0.3);
  assert.equal(gone, 1);
  assert.equal(os.characters.has(1), false);
  run(os, 5);
  assert.equal(gone, 1);
});

test('leaving a character that does not exist calls onGone immediately', () => {
  const os = livingOffice();
  let gone = 0;
  os.leaveThroughDoor(99, () => gone++);
  assert.equal(gone, 1);
});

// ── setPresence ─────────────────────────────────────────────────

test('setPresence drives lounge, return and leaving', () => {
  const os = livingOffice();
  seatedAgent(os, 1, DESK_A);

  os.setPresence(1, 'available');
  run(os, 1);
  assert.equal(os.characters.get(1)!.presence, 'available');

  os.setPresence(1, 'lounge');
  run(os, 12);
  assert.ok(LOUNGE.includes(os.getSeatAtTile(at(os, 1).col, at(os, 1).row)!), 'rests');

  // In the real flow 'working' arrives with activity (agentToolStart makes the
  // agent active); an idle agent back at its desk would resume the engine's
  // random wander, which made this assertion flaky.
  os.setPresence(1, 'working');
  os.setAgentActive(1, true);
  run(os, 12);
  assert.deepEqual(at(os, 1), seatTile(os, DESK_A), 'back at the desk');
  os.setAgentActive(1, false);

  os.setPresence(1, 'leaving');
  run(os, 20);
  assert.equal(os.characters.has(1), false, 'left the office');
});

test('setPresence on an unknown id is a no-op', () => {
  const os = livingOffice();
  os.setPresence(42, 'lounge');
  os.setPresence(42, 'leaving');
  assert.equal(os.characters.size, 0);
});

// ── Layout rebuilds mid-scene ───────────────────────────────────

test('a layout rebuild does not teleport someone who is walking in or resting', () => {
  const os = livingOffice();
  os.enterThroughDoor(1, DESK_A);
  run(os, 0.3);
  os.rebuildFromLayout(livingLayout());
  assert.notDeepEqual(at(os, 1), seatTile(os, DESK_A), 'not snapped onto its seat');
  run(os, 10);
  assert.deepEqual(at(os, 1), seatTile(os, DESK_A), 'but still arrives');

  os.setAgentActive(1, false);
  os.goToLounge(1);
  run(os, 12);
  const resting = at(os, 1);
  os.rebuildFromLayout(livingLayout());
  assert.deepEqual(at(os, 1), resting, 'a resting agent stays in the lounge');
  const bean = os.getSeatAtTile(resting.col, resting.row)!;
  assert.equal(os.seats.get(bean)!.assigned, true, 'and keeps its rest seat reserved');
  assert.equal(os.seats.get(DESK_A)!.assigned, true, 'and its desk');
  run(os, 60);
  assert.deepEqual(at(os, 1), resting);
});

test('a layout rebuild mid-exit does not seat the leaver again', () => {
  const os = livingOffice();
  seatedAgent(os, 1, DESK_A);
  let gone = 0;
  os.leaveThroughDoor(1, () => gone++);
  run(os, 0.3);
  os.rebuildFromLayout(livingLayout());
  assert.equal(os.characters.get(1)!.seatId, null);
  assert.equal(os.seats.get(DESK_A)!.assigned, false);
  run(os, 20);
  assert.equal(gone, 1);
});

// ── QA regressions ──────────────────────────────────────────────

test('a rester whose seat vanishes in a rebuild goes to another free rest seat', () => {
  const os = livingOffice();
  seatedAgent(os, 1, DESK_A);
  os.goToLounge(1);
  run(os, 12);
  assert.deepEqual(at(os, 1), seatTile(os, 'bean-1'), 'precondition: on bean-1');
  const layout = livingLayout();
  layout.furniture = layout.furniture.filter((f) => f.uid !== 'bean-1');
  os.rebuildFromLayout(layout);
  run(os, 12);
  assert.deepEqual(at(os, 1), seatTile(os, 'bean-2'), 'moved to the remaining rest seat');
  assert.equal(os.seats.get('bean-2')!.assigned, true);
});

test('a rest seat is not a desk even when requested or held from before', () => {
  const os = livingOffice();
  os.addAgent(2, 0, 0, 'bean-2', true);
  assert.notEqual(os.characters.get(2)!.seatId, 'bean-2', 'preferred rest seat ignored');

  const before = new OfficeState(livingLayout());
  before.addAgent(3, 0, 0, 'bean-1', true);
  assert.equal(before.characters.get(3)!.seatId, 'bean-1', 'precondition: no targets yet');
  before.setLivingTargets({ door: DOOR, loungeSeats: LOUNGE });
  assert.ok([DESK_A, DESK_B].includes(before.characters.get(3)!.seatId!), 'moved to a desk');
  assert.equal(before.seats.get('bean-1')!.assigned, false);
});

test('removeAgent then enterThroughDoor does not revive the despawning character', () => {
  const os = livingOffice();
  seatedAgent(os, 1, DESK_A);
  os.removeAgent(1);
  let gone = 0;
  os.leaveThroughDoor(1, () => gone++);
  os.enterThroughDoor(1, DESK_B);
  run(os, 2);
  assert.equal(os.characters.has(1), false);
  assert.equal(gone, 1);
});

test('lounge overflow does not stack on one tile, and takes a seat once freed', () => {
  const os = new OfficeState(livingLayout());
  os.setLivingTargets({ door: DOOR, loungeSeats: ['bean-1'] });
  os.addAgent(1, 0, 0, DESK_A, true);
  os.addAgent(2, 0, 0, DESK_B, true);
  os.addAgent(3, 0, 0, undefined, true);
  for (const id of [1, 2, 3]) os.setAgentActive(id, false);
  for (const id of [1, 2, 3]) os.goToLounge(id);
  run(os, 15);
  const tiles = [1, 2, 3].map((id) => `${at(os, id).col},${at(os, id).row}`);
  assert.equal(new Set(tiles).size, 3, `three distinct tiles: ${tiles.join(' ')}`);
  const sitter = [1, 2, 3].find((id) => os.getSeatAtTile(at(os, id).col, at(os, id).row))!;
  os.returnToDesk(sitter);
  run(os, 15);
  const now = [1, 2, 3].filter((id) => id !== sitter).map((id) => at(os, id));
  assert.ok(
    now.some((p) => p.col === seatTile(os, 'bean-1').col && p.row === seatTile(os, 'bean-1').row),
    'a standing rester took the freed seat',
  );
});

test('a lounge presence that arrives before the targets is animated once they land', () => {
  const os = new OfficeState(livingLayout());
  os.addAgent(1, 0, 0, DESK_A, true);
  os.setAgentActive(1, false);
  os.setPresence(1, 'lounge');
  os.setLivingTargets({ door: DOOR, loungeSeats: LOUNGE });
  run(os, 12);
  assert.ok(LOUNGE.includes(os.getSeatAtTile(at(os, 1).col, at(os, 1).row) ?? ''));
});
