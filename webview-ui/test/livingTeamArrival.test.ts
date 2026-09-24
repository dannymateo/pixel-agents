/**
 * A team that finishes before (or right after) reaching its desks (T25).
 *
 * Real sequence from the browser: a lead, two background devs and one QA each,
 * born in a burst (agentCreated × 5, one tick apart), all `completed` within
 * ~20 s — so `agentPresence 'available'` (and the turn-end agentStatus
 * 'waiting' → setAgentActive(false)) lands while they still walk in from the
 * door, or just after they sat down. Spec §3.3: an available agent waits AT
 * ITS DESK. The inherited idle FSM stood them up 3–5 s after they sat and
 * wandered them over the whole composed office, leaving the module empty.
 *
 * Real OfficeState, real catalog, the shipped default layout as the user's
 * office. No React: the controller is what useExtensionMessages forwards to.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildFurnitureCatalog } from '../../core/src/assets/build.ts';
import { decodeAllFurniture } from '../../core/src/assets/loader.ts';
import { createCharacter, updateCharacter } from '../src/office/engine/characters.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import * as tileMapModule from '../src/office/layout/tileMap.js';
import { LivingOfficeController } from '../src/office/living/livingOfficeController.js';
import type { OfficeLayout, Seat } from '../src/office/types.js';
import { CharacterState, Direction, TileType } from '../src/office/types.js';

// Pass-through spy: counts path searches without changing them.
vi.mock('../src/office/layout/tileMap.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/office/layout/tileMap.js')>();
  return { ...real, findPath: vi.fn(real.findPath) };
});

const here = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(here, '..', 'public', 'assets');
const DEFAULT_LAYOUT = JSON.parse(
  fs.readFileSync(path.join(assetsDir, 'default-layout-1.json'), 'utf8'),
) as OfficeLayout;

beforeAll(() => {
  const catalog = buildFurnitureCatalog(assetsDir);
  const sprites = decodeAllFurniture(assetsDir, catalog);
  expect(buildDynamicCatalog({ catalog, sprites })).toBe(true);
});

const ROOT = 1;
const LEAD = 14;
/** [id, parent]: lead → 2 devs → 1 QA each, in the order the server announces them. */
const TEAM: ReadonlyArray<readonly [number, number]> = [
  [LEAD, ROOT],
  [15, LEAD],
  [16, LEAD],
  [17, 15],
  [18, 16],
];
const FRAME = 1 / 60;

let os: OfficeState;
let living: LivingOfficeController;
let clock = 0;

beforeEach(() => {
  os = new OfficeState();
  living = new LivingOfficeController(() => os, { setTimer: () => 0, clearTimer: () => {} });
  living.markCatalogReady();
  living.setUserLayout(structuredClone(DEFAULT_LAYOUT));
  living.directory.upsert(ROOT, {});
  os.addAgent(ROOT, 0, 0, undefined, true);
  clock = 0;
});

function tick(seconds: number): void {
  for (let t = 0; t < seconds; t += FRAME) os.update(FRAME);
  clock += seconds;
}

/** agentCreated + its first agentToolStart, as useExtensionMessages forwards them. */
function born(id: number, parent: number): void {
  living.upsertAgent(id, { parentAgentId: parent, presence: 'working' });
  living.placeDerived(id, { parentAgentId: parent }, 'enter');
  os.setAgentActive(id, true);
}

/** The member finished: turn-end agentStatus 'waiting', then agentPresence 'available'. */
function finished(id: number): void {
  os.setAgentActive(id, false);
  living.setPresence(id, 'available');
}

function moduleSeat(id: number): string | undefined {
  for (const m of living.getLiving()?.modules ?? []) {
    const uid = m.seatByAgent.get(id);
    if (uid !== undefined) return uid;
  }
  return undefined;
}

/** Where each member is, when it is not sitting at its module chair. */
function offDesk(): string[] {
  const out: string[] = [];
  for (const [id] of TEAM) {
    const ch = os.characters.get(id);
    const want = moduleSeat(id);
    const seat = want ? os.seats.get(want) : undefined;
    const seated =
      !!ch &&
      !!seat &&
      ch.seatId === want &&
      ch.tileCol === seat.seatCol &&
      ch.tileRow === seat.seatRow &&
      ch.state === CharacterState.TYPE;
    if (!seated) {
      out.push(
        `t=${clock.toFixed(0)}s #${id} ${ch?.state} at ${ch?.tileCol},${ch?.tileRow} seat=${ch?.seatId} want=${want}`,
      );
    }
  }
  return out;
}

/** Sample once a second for `seconds`: every member must stay seated at its module chair. */
function expectSeatedThroughout(seconds: number): void {
  const misses: string[] = [];
  for (let s = 0; s < seconds; s++) {
    tick(1);
    misses.push(...offDesk());
  }
  expect(misses.slice(0, 5)).toEqual([]);
}

describe('a team that finishes around its arrival ends seated in its module', () => {
  // Door → module is ~52–60 tiles (~17–20 s at walking speed): 3 and 8 s land
  // mid-walk, 14 s as the first ones sit, 20 and 30 s after everyone sat.
  it.each([3, 8, 14, 20, 30])(
    'burst-born, available %i s later: everyone sits and waits at its module desk',
    (delay) => {
      for (const [id, parent] of TEAM) {
        born(id, parent);
        tick(FRAME); // each agentCreated in its own tick
      }
      tick(delay);
      for (const [id] of TEAM) finished(id);
      // Every member has a module chair of the lead's team.
      for (const [id] of TEAM) expect(moduleSeat(id)).toBeDefined();
      tick(Math.max(0, 35 - delay)); // the walk in is over for everyone
      expect(offDesk()).toEqual([]);
      // Waiting, not wandering: several minutes later they are all still there
      // (the inherited idle FSM stood them up after 3–5 s).
      expectSeatedThroughout(300);
    },
  );

  it('born slowly (each seated before the next is born), then available: all wait seated', () => {
    for (const [id, parent] of TEAM) {
      born(id, parent);
      tick(30);
    }
    expect(offDesk()).toEqual([]);
    for (const [id] of TEAM) finished(id);
    expectSeatedThroughout(300);
  });

  it('an idle member already wandering walks back to its desk once available', () => {
    for (const [id, parent] of TEAM) {
      born(id, parent);
      tick(FRAME);
    }
    tick(35);
    // Turn ended (idle) while still `working`: the inherited FSM may wander.
    for (const [id] of TEAM) os.setAgentActive(id, false);
    tick(40);
    for (const [id] of TEAM) living.setPresence(id, 'available');
    tick(60); // longest way back across the office
    expect(offDesk()).toEqual([]);
    expectSeatedThroughout(120);
  });

  it('back to work after waiting: it types at the same desk', () => {
    for (const [id, parent] of TEAM) {
      born(id, parent);
      tick(FRAME);
    }
    tick(35);
    for (const [id] of TEAM) finished(id);
    tick(10);
    living.setPresence(15, 'working');
    os.setAgentActive(15, true);
    tick(2);
    const ch = os.characters.get(15)!;
    expect(ch.seatId).toBe(moduleSeat(15));
    expect(ch.state).toBe(CharacterState.TYPE);
  });
});

describe('waiting at the desk: edges (QA review)', () => {
  /** Seated, idle while still working (they wander), then available: they
   *  walk back through the idle FSM — whose arrival sets a 2–4 min seat rest. */
  function wanderThenWait(): void {
    tick(35);
    for (const [id] of TEAM) os.setAgentActive(id, false);
    tick(40);
    for (const [id] of TEAM) living.setPresence(id, 'available');
    tick(60);
  }

  it('while the editor hides the modules, a waiting member stands up at once (no frozen rest)', () => {
    for (const [id, parent] of TEAM) {
      born(id, parent);
      tick(FRAME);
    }
    wanderThenWait();
    expect(offDesk()).toEqual([]);
    living.enterEditMode(); // module chairs gone: no desk to wait at
    tick(3);
    for (const [id] of TEAM) {
      const ch = os.characters.get(id)!;
      expect(ch.seatId).toBeNull();
      // Not stuck "typing" on the bare floor for the minutes of a seat rest.
      expect(ch.state).not.toBe(CharacterState.TYPE);
    }
    living.exitEditMode(living.getUserLayout());
    tick(60);
    expect(offDesk()).toEqual([]);
  });

  it('available, then working but still idle: it stands up like any idle agent', () => {
    for (const [id, parent] of TEAM) {
      born(id, parent);
      tick(FRAME);
    }
    wanderThenWait();
    living.setPresence(15, 'working'); // e.g. a SendMessage arrives, no tool yet
    tick(1);
    expect(os.characters.get(15)!.state).not.toBe(CharacterState.TYPE);
  });

  it('a waiting agent with no way to its desk does not search a path every frame', () => {
    // 7×7 floor; the desk at (5,5) is walled in by blocked tiles.
    const size = 7;
    const tileMap = Array.from({ length: size }, () =>
      Array.from({ length: size }, () => TileType.FLOOR_1),
    );
    const blocked = new Set(['4,4', '5,4', '6,4', '4,5', '4,6']);
    const seat: Seat = {
      uid: 'desk',
      seatCol: 5,
      seatRow: 5,
      facingDir: Direction.UP,
      assigned: true,
    };
    const seats = new Map([['desk', seat]]);
    const walkable: Array<{ col: number; row: number }> = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++)
        if (!blocked.has(`${c},${r}`)) walkable.push({ col: c, row: r });
    }
    const ch = createCharacter(99, 0, 'desk', null);
    ch.isActive = false;
    ch.presence = 'available';
    ch.state = CharacterState.IDLE;
    const findPath = vi.mocked(tileMapModule.findPath);
    findPath.mockClear();
    const frames = 600; // 10 s
    for (let i = 0; i < frames; i++) {
      updateCharacter(ch, FRAME, walkable, seats, tileMap, blocked);
    }
    // One try per DESK_RETRY_SEC plus the odd wander, not one per frame.
    expect(findPath.mock.calls.length).toBeLessThan(30);
  });
});
