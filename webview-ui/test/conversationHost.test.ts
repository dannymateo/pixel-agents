/**
 * OfficeState as the conversation SceneHost (spec §4b): the speaker walks to a
 * free tile next to the listener's desk, both face each other, and the speaker
 * walks back. The walk is purely visual — presence and activity never change —
 * and while it lasts the FSM must not pull the speaker back to its seat.
 *
 * Like livingLifecycle.test.ts this tests the OfficeState DOMAIN MODEL on a
 * real instance (tiles, seats, scripted flags); the catalog is built by hand so
 * nothing depends on sprite loading.
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { beforeAll, test } from 'vitest';

import {
  CONVERSATION_ENVELOPE_SEC,
  CONVERSATION_MAX_MS,
  CONVERSATION_TALK_HOLD_MAX_MS,
} from '../src/constants.js';
import { ConversationDirector } from '../src/office/engine/conversationScene.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import { isWalkable } from '../src/office/layout/tileMap.js';
import type { OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { CharacterState, Direction, TileType } from '../src/office/types.js';

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
  ];
  const sprites: LoadedAssetData['sprites'] = {
    TEST_DESK: [['']],
    TEST_CHAIR: [['']],
    TEST_BEANBAG: [['']],
    DOOR_CLOSED: [['']],
    DOOR_OPEN: [['']],
  };
  assert.equal(buildDynamicCatalog({ catalog, sprites }), true);
});

const COLS = 14;
const ROWS = 9;
const DOOR = { col: 2, row: 2, uid: 'door' };
const DESK_A = 'chair-a';
const DESK_B = 'chair-b';
const DESK_C = 'chair-c';
const LOUNGE = ['bean-1', 'bean-2'];

/** Rows 0-1 wall (door on it), floor below. Three desks with a chair below
 *  each (seats face UP), two beanbags bottom-left as the lounge. */
function layout(): OfficeLayout {
  const tiles: TileType[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) tiles.push(r < 2 ? TileType.WALL : TileType.FLOOR_1);
  }
  const furniture: PlacedFurniture[] = [
    { uid: 'door', type: 'DOOR_CLOSED', col: 2, row: 0 },
    { uid: 'desk-a', type: 'TEST_DESK', col: 6, row: 4 },
    { uid: DESK_A, type: 'TEST_CHAIR', col: 6, row: 5 },
    { uid: 'desk-b', type: 'TEST_DESK', col: 11, row: 4 },
    { uid: DESK_B, type: 'TEST_CHAIR', col: 11, row: 5 },
    { uid: 'desk-c', type: 'TEST_DESK', col: 9, row: 4 },
    { uid: DESK_C, type: 'TEST_CHAIR', col: 9, row: 5 },
    { uid: 'bean-1', type: 'TEST_BEANBAG', col: 1, row: 7 },
    { uid: 'bean-2', type: 'TEST_BEANBAG', col: 3, row: 7 },
  ];
  return { version: 1, cols: COLS, rows: ROWS, tiles, furniture };
}

/** An office with two root agents seated and working: 1 at A, 2 at B. */
function office(): OfficeState {
  const os = new OfficeState(layout());
  os.setLivingTargets({ door: DOOR, loungeSeats: LOUNGE });
  os.addAgent(1, 0, 0, DESK_A, true);
  os.addAgent(2, 1, 0, DESK_B, true);
  return os;
}

function run(os: OfficeState, seconds: number, director?: ConversationDirector): void {
  const dt = 0.05;
  for (let t = 0; t < seconds; t += dt) {
    os.update(dt);
    director?.update(dt);
  }
}

function at(os: OfficeState, id: number): { col: number; row: number } {
  const ch = os.characters.get(id)!;
  return { col: ch.tileCol, row: ch.tileRow };
}

function seatTile(os: OfficeState, uid: string): { col: number; row: number } {
  const s = os.seats.get(uid)!;
  return { col: s.seatCol, row: s.seatRow };
}

function manhattan(a: { col: number; row: number }, b: { col: number; row: number }): number {
  return Math.abs(a.col - b.col) + Math.abs(a.row - b.row);
}

// ── Walking up ──────────────────────────────────────────────────

test('walkNextTo walks the speaker to a free walkable tile next to the listener desk', () => {
  const os = office();
  assert.equal(os.canStage(1, 2), true);
  assert.equal(os.walkNextTo(1, 2), true);
  const a = os.characters.get(1)!;
  assert.equal(a.scripted, true, 'the scene steers it, not the FSM');
  assert.equal(os.hasArrived(1), false);
  run(os, 5);
  assert.equal(os.hasArrived(1), true);
  const spot = at(os, 1);
  assert.equal(manhattan(spot, seatTile(os, DESK_B)), 1, 'right next to the listener desk');
  assert.ok(isWalkable(spot.col, spot.row, os.tileMap, os.blockedTiles), 'on a floor tile');
  assert.notDeepEqual(spot, at(os, 2), 'not on top of the listener');
  assert.equal(a.state, CharacterState.IDLE, 'stands while talking');
  assert.equal(a.seatId, DESK_A, 'keeps its own desk');
  assert.equal(os.seats.get(DESK_A)!.assigned, true, 'its desk stays reserved');
});

test('while the scene steers it, activity does not send the speaker back to its seat', () => {
  const os = office();
  os.walkNextTo(1, 2);
  run(os, 5);
  const spot = at(os, 1);
  os.setAgentActive(1, true); // agentToolStart
  os.setAgentTool(1, 'Bash');
  run(os, 3);
  assert.deepEqual(at(os, 1), spot, 'stays by the listener');
  os.setAgentActive(1, false); // turn end
  run(os, 3);
  assert.deepEqual(at(os, 1), spot, 'an idle turn does not make it wander off either');
  assert.equal(os.characters.get(1)!.scripted, true);
});

test('faceEachOther turns the speaker toward the listener and the seated listener toward it', () => {
  const os = office();
  os.walkNextTo(1, 2);
  run(os, 5);
  os.faceEachOther(1, 2);
  const a = os.characters.get(1)!;
  const b = os.characters.get(2)!;
  const aAt = at(os, 1);
  const bAt = at(os, 2);
  const expectA =
    bAt.col > aAt.col
      ? Direction.RIGHT
      : bAt.col < aAt.col
        ? Direction.LEFT
        : bAt.row > aAt.row
          ? Direction.DOWN
          : Direction.UP;
  assert.equal(a.dir, expectA, 'speaker faces the listener');
  const opposite: Record<number, number> = {
    [Direction.RIGHT]: Direction.LEFT,
    [Direction.LEFT]: Direction.RIGHT,
    [Direction.UP]: Direction.DOWN,
    [Direction.DOWN]: Direction.UP,
  };
  assert.equal(b.dir, opposite[expectA], 'listener faces the speaker');
});

test('returnToSeat walks it back, sits it down, clears scripted; the listener faces its desk again', () => {
  const os = office();
  os.walkNextTo(1, 2);
  run(os, 5);
  os.faceEachOther(1, 2);
  os.returnToSeat(1);
  assert.equal(os.isSeated(1), false, 'on its way back');
  run(os, 6);
  assert.equal(os.isSeated(1), true);
  const a = os.characters.get(1)!;
  assert.deepEqual(at(os, 1), seatTile(os, DESK_A));
  assert.equal(a.scripted, false, 'back to the FSM');
  assert.equal(a.state, CharacterState.TYPE, 'sits');
  assert.equal(a.dir, os.seats.get(DESK_A)!.facingDir);
  assert.equal(os.characters.get(2)!.dir, os.seats.get(DESK_B)!.facingDir, 'listener back at work');
});

test('the walk changes neither presence nor activity', () => {
  const os = office();
  os.setPresence(1, 'available');
  os.setAgentActive(1, false);
  os.walkNextTo(1, 2);
  run(os, 5);
  os.returnToSeat(1);
  run(os, 6);
  const a = os.characters.get(1)!;
  assert.equal(a.presence, 'available');
  assert.equal(a.isActive, false);
});

test('a speaker with no way to the listener: walkNextTo returns false and nothing moves', () => {
  // Wall in desk A's chair (desk above, walls left, right and below).
  const l = layout();
  for (const [c, r] of [
    [5, 5],
    [7, 5],
    [6, 6],
  ]) {
    l.tiles[r * COLS + c] = TileType.WALL;
  }
  const os = new OfficeState(l);
  os.addAgent(1, 0, 0, DESK_A, true);
  os.addAgent(2, 1, 0, DESK_B, true);
  const before = at(os, 1);
  assert.equal(os.walkNextTo(1, 2), false);
  assert.equal(os.characters.get(1)!.scripted ?? false, false);
  run(os, 2);
  assert.deepEqual(at(os, 1), before);
});

test('the spot is never far from the listener: behind a wall is no spot at all', () => {
  // Desk B's chair walled in on every side; the nearest open floor is further
  // than CONVERSATION_SPOT_MAX_DIST away.
  const l = layout();
  for (let r = 2; r < ROWS; r++) {
    for (let c = 8; c < COLS; c++) {
      const inner = c >= 10 && c <= 12 && r >= 3 && r <= 7;
      if (!inner || c === 10 || c === 12 || r === 3 || r === 7) {
        if (!(c === 11 && r === 4)) l.tiles[r * COLS + c] = TileType.WALL;
      }
    }
  }
  l.tiles[5 * COLS + 11] = TileType.FLOOR_1; // the chair
  const os = new OfficeState(l);
  os.addAgent(1, 0, 0, DESK_A, true);
  os.addAgent(2, 1, 0, DESK_B, true);
  assert.equal(os.walkNextTo(1, 2), false);
});

test('the spot next to the listener avoids another speaker already heading there', () => {
  const os = office();
  os.addAgent(3, 2, 0, DESK_C, true);
  os.walkNextTo(1, 2);
  os.walkNextTo(3, 2);
  run(os, 6);
  assert.notDeepEqual(at(os, 1), at(os, 3), 'two speakers never share a tile');
});

// ── Envelope ────────────────────────────────────────────────────

test('showEnvelope puts the envelope over the speaker, and it fades away', () => {
  const os = office();
  os.showEnvelope(1);
  const a = os.characters.get(1)!;
  assert.equal(a.envelopeTimer, CONVERSATION_ENVELOPE_SEC);
  run(os, CONVERSATION_ENVELOPE_SEC + 0.2);
  assert.equal(a.envelopeTimer ?? 0, 0);
  os.showEnvelope(999); // unknown: no-op
});

// ── Who can take part ───────────────────────────────────────────

test('canStage: both present; not an unknown, leaving or despawning character', () => {
  const os = office();
  assert.equal(os.canStage(1, undefined), false, 'no listener');
  assert.equal(os.canStage(1, 1), false, 'not with itself');
  assert.equal(os.canStage(1, 42), false, 'unknown listener');
  assert.equal(os.canStage(42, 1), false, 'unknown speaker');
  os.addAgent(3, 2, 0, DESK_C, true);
  os.leaveThroughDoor(3, () => {});
  assert.equal(os.canStage(1, 3), false, 'a leaving listener');
  assert.equal(os.canStage(3, 1), false, 'a leaving speaker');
  assert.equal(os.isPresent(3), false);
  os.showEnvelope(3);
  assert.equal(os.characters.get(3)!.envelopeTimer ?? 0, 0, 'a leaver gets no envelope');
  os.removeAgent(2);
  assert.equal(os.canStage(1, 2), false, 'a despawning listener');
  assert.equal(os.isPresent(2), false);
  assert.equal(os.isPresent(1), true);
});

// ── Lounge ──────────────────────────────────────────────────────

test('a listener resting in the lounge first walks back to its desk, and returns to rest after', () => {
  const os = office();
  os.setPresence(2, 'lounge');
  run(os, 8);
  assert.notDeepEqual(at(os, 2), seatTile(os, DESK_B), 'precondition: resting');
  assert.equal(os.walkNextTo(1, 2), true);
  run(os, 10);
  assert.deepEqual(at(os, 2), seatTile(os, DESK_B), 'the listener is back at its desk');
  assert.equal(manhattan(at(os, 1), seatTile(os, DESK_B)), 1, 'the speaker stands beside it');
  assert.equal(os.characters.get(2)!.presence, 'lounge', 'presence untouched');
  os.returnToSeat(1);
  run(os, 12);
  assert.ok(LOUNGE.map((u) => seatTile(os, u)).some((t) => manhattan(t, at(os, 2)) === 0));
});

test('a speaker resting in the lounge walks from there, then goes back to rest', () => {
  const os = office();
  os.setPresence(1, 'lounge');
  run(os, 8);
  assert.equal(os.walkNextTo(1, 2), true);
  run(os, 10);
  assert.equal(manhattan(at(os, 1), seatTile(os, DESK_B)), 1);
  os.returnToSeat(1);
  run(os, 12);
  assert.ok(LOUNGE.map((u) => seatTile(os, u)).some((t) => manhattan(t, at(os, 1)) === 0));
  assert.equal(os.isSeated(1), true);
});

test('a lounge presence arriving mid-talk waits until the talk is over', () => {
  const os = office();
  os.walkNextTo(1, 2);
  run(os, 5);
  const spot = at(os, 1);
  os.setPresence(1, 'lounge');
  run(os, 2);
  assert.deepEqual(at(os, 1), spot, 'keeps talking');
  os.returnToSeat(1);
  run(os, 12);
  assert.ok(LOUNGE.map((u) => seatTile(os, u)).some((t) => manhattan(t, at(os, 1)) === 0));
});

// ── Assign: the child walks in through the door ─────────────────

test('assign: the speaker walks to the child desk even while the child is still walking in', () => {
  const os = office();
  os.enterThroughDoor(5, DESK_C);
  assert.equal(os.canStage(1, 5), true);
  assert.equal(os.walkNextTo(1, 5), true);
  run(os, 10);
  assert.deepEqual(at(os, 5), seatTile(os, DESK_C), 'the child reached its desk');
  assert.equal(manhattan(at(os, 1), seatTile(os, DESK_C)), 1, 'the speaker stands by it');
});

// ── Interruptions ───────────────────────────────────────────────

test('the speaker removed mid-scene: no crash, not present, the host calls are no-ops', () => {
  const os = office();
  os.walkNextTo(1, 2);
  run(os, 1);
  os.removeAgent(1);
  assert.equal(os.isPresent(1), false);
  os.faceEachOther(1, 2);
  os.returnToSeat(1);
  run(os, 2);
  assert.equal(os.characters.has(1), false, 'despawned');
  assert.equal(os.isSeated(1), true, 'nothing left to wait for');
  assert.equal(os.hasArrived(1), true);
});

test('leaving wins over a conversation', () => {
  const os = office();
  os.walkNextTo(1, 2);
  run(os, 1);
  let gone = false;
  os.leaveThroughDoor(1, () => (gone = true));
  run(os, 15);
  assert.equal(gone, true);
});

test('a layout rebuild mid-walk re-routes the speaker to the listener', () => {
  const os = office();
  os.walkNextTo(1, 2);
  run(os, 0.3);
  os.rebuildFromLayout(layout(), undefined, { preservePositions: true });
  run(os, 6);
  assert.equal(manhattan(at(os, 1), seatTile(os, DESK_B)), 1);
  assert.equal(os.hasArrived(1), true);
});

// ── End to end with the director ────────────────────────────────

test('a whole scene: walk, talk, walk back — then the next scene of the speaker runs', () => {
  const os = office();
  os.addAgent(3, 2, 0, DESK_C, true);
  const d = new ConversationDirector(os, { cps: 80, maxMs: CONVERSATION_MAX_MS });
  d.enqueue({ conversationId: 'c1', fromId: 1, toId: 2, kind: 'message', text: 'hola' });
  d.enqueue({ conversationId: 'c2', fromId: 1, toId: 3, kind: 'message', text: 'chao' });
  run(os, 0.1, d);
  assert.equal(d.views()[0].phase, 'walking');
  const seen: string[] = [];
  const order: string[] = [];
  let said = '';
  for (let t = 0; t < 40; t += 0.05) {
    os.update(0.05);
    d.update(0.05);
    for (const v of d.views()) {
      if (order[order.length - 1] !== v.conversationId) order.push(v.conversationId);
      if (v.conversationId !== 'c1') continue;
      if (seen[seen.length - 1] !== v.phase) seen.push(v.phase);
      if (v.phase === 'talking') {
        said = v.visibleText;
        assert.equal(manhattan(at(os, 1), seatTile(os, DESK_B)), 1, 'talks beside the listener');
      }
    }
    assert.ok(d.views().length <= 1, 'one scene at a time for this speaker');
  }
  assert.deepEqual(seen, ['walking', 'talking', 'returning']);
  assert.equal(said, 'hola', 'the bubble typed the whole text');
  assert.deepEqual(order, ['c1', 'c2'], 'the second scene ran after the first');
  assert.equal(d.views().length, 0);
  assert.deepEqual(at(os, 1), seatTile(os, DESK_A), 'back at its desk');
  assert.equal(os.characters.get(1)!.scripted, false);
});

test('a scene with no reachable listener ends with the envelope', () => {
  const os = office();
  const d = new ConversationDirector(os, { cps: 80, maxMs: CONVERSATION_MAX_MS });
  d.enqueue({ conversationId: 'c1', fromId: 1, kind: 'report', text: 'listo' });
  run(os, 0.1, d);
  assert.equal(d.views().length, 0);
  assert.ok((os.characters.get(1)!.envelopeTimer ?? 0) > 0);
});

// ── However a talk ends, the listener is let go ─────────────────

function onRestSeat(os: OfficeState, id: number): boolean {
  return LOUNGE.map((u) => seatTile(os, u)).some((t) => manhattan(t, at(os, id)) === 0);
}

/** Listener 2 rests; speaker 1 walked up to it and holds there. */
function talkToResting(): OfficeState {
  const os = office();
  os.setPresence(2, 'lounge');
  run(os, 8);
  assert.equal(os.walkNextTo(1, 2), true);
  run(os, 10);
  assert.deepEqual(at(os, 2), seatTile(os, DESK_B), 'precondition: listener at its desk');
  return os;
}

test('the speaker leaves mid-talk: the listener pulled from the lounge goes back to rest', () => {
  const os = talkToResting();
  os.leaveThroughDoor(1, () => {});
  run(os, 12);
  assert.ok(onRestSeat(os, 2));
});

test('the speaker is removed mid-talk: the listener goes back to rest', () => {
  const os = talkToResting();
  os.removeAgent(1);
  run(os, 12);
  assert.ok(onRestSeat(os, 2));
});

test('the user sends the speaker to its seat mid-talk: the listener goes back to rest', () => {
  const os = talkToResting();
  os.sendToSeat(1);
  run(os, 12);
  assert.ok(onRestSeat(os, 2));
  assert.deepEqual(at(os, 1), seatTile(os, DESK_A));
});

test('a listener told to rest mid-talk keeps listening, then goes to rest', () => {
  const os = office();
  os.walkNextTo(1, 2);
  run(os, 5);
  os.setPresence(2, 'lounge');
  run(os, 3);
  assert.deepEqual(at(os, 2), seatTile(os, DESK_B), 'still at its desk, listening');
  os.returnToSeat(1);
  run(os, 12);
  assert.ok(onRestSeat(os, 2));
});

test('a talk nobody ends still lets go of its speaker (safety net)', () => {
  const os = office();
  os.walkNextTo(1, 2);
  run(os, CONVERSATION_TALK_HOLD_MAX_MS / 1000 + 8);
  const a = os.characters.get(1)!;
  assert.equal(a.scripted, false);
  assert.deepEqual(at(os, 1), seatTile(os, DESK_A));
});

test('a rebuild that walls the spot a speaker holds moves it to a walkable one', () => {
  const os = office();
  os.walkNextTo(1, 2);
  run(os, 5);
  const spot = at(os, 1);
  const l = layout();
  l.tiles[spot.row * COLS + spot.col] = TileType.WALL;
  os.rebuildFromLayout(l, undefined, { preservePositions: true });
  run(os, 5);
  const now = at(os, 1);
  assert.ok(isWalkable(now.col, now.row, os.tileMap, os.blockedTiles), 'off the wall');
  assert.ok(manhattan(now, seatTile(os, DESK_B)) <= 3, 'still beside the listener');
  assert.equal(os.hasArrived(1), true);
});

test('a walled-off listener in a big office fails fast (one flood fill, not a search per tile)', () => {
  const size = 64;
  const tiles: TileType[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) tiles.push(r < 2 ? TileType.WALL : TileType.FLOOR_1);
  }
  // A closed ring of wall around the listener's desk, 3 tiles out.
  for (let r = 27; r <= 37; r++) {
    for (let c = 27; c <= 37; c++) {
      if (r === 27 || r === 37 || c === 27 || c === 37) tiles[r * size + c] = TileType.WALL;
    }
  }
  const furniture: PlacedFurniture[] = [
    { uid: 'desk-a', type: 'TEST_DESK', col: 5, row: 4 },
    { uid: DESK_A, type: 'TEST_CHAIR', col: 5, row: 5 },
    { uid: 'desk-b', type: 'TEST_DESK', col: 32, row: 31 },
    { uid: DESK_B, type: 'TEST_CHAIR', col: 32, row: 32 },
  ];
  const os = new OfficeState({ version: 1, cols: size, rows: size, tiles, furniture });
  os.addAgent(1, 0, 0, DESK_A, true);
  os.addAgent(2, 1, 0, DESK_B, true);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) assert.equal(os.walkNextTo(1, 2), false);
  const perCall = (performance.now() - t0) / 20;
  assert.ok(perCall < 15, `one failed plan took ${perCall.toFixed(1)} ms`);
});

test('a freed rest seat skips a resting listener until its talk is over', () => {
  const os = office();
  os.addAgent(3, 2, 0, DESK_C, true);
  os.addAgent(4, 3, 0, undefined, true); // no desk left
  for (const id of [2, 3]) os.setPresence(id, 'lounge');
  run(os, 10);
  os.setPresence(4, 'lounge'); // both rest seats taken: stands beside the lounge
  run(os, 10);
  assert.equal(os.walkNextTo(1, 4), true);
  run(os, 1);
  os.setPresence(2, 'working'); // frees a rest seat
  run(os, 1);
  const four = os.characters.get(4)!;
  assert.equal(four.scripted, true, 'still in its lounge scene while listened to');
  os.returnToSeat(1);
  run(os, 10);
  assert.ok(onRestSeat(os, 4), 'sits down once the talk is over');
});
