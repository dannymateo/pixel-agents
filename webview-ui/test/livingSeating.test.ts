/**
 * Desk assignment and auto-state in the living office (docs/adr/0003):
 * - the composition's seats (uid `living-…`: team modules, the generated
 *   lounge) are never handed out to an agent of the user's office;
 * - the lounge's arcade and console are play, not work: never a "PC seat",
 *   never switched on by a working agent — only by someone resting in front.
 * Real catalog (bundled manifests), real OfficeState.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildFurnitureCatalog } from '../../core/src/assets/build.ts';
import { decodeAllFurniture } from '../../core/src/assets/loader.ts';
import { OfficeState } from '../src/office/engine/officeState.js';
import { buildDynamicCatalog, getCatalogEntry } from '../src/office/layout/furnitureCatalog.js';
import type { OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

const assetsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'assets',
);

beforeAll(() => {
  const catalog = buildFurnitureCatalog(assetsDir);
  const sprites = decodeAllFurniture(assetsDir, catalog);
  expect(buildDynamicCatalog({ catalog, sprites })).toBe(true);
});

afterEach(() => vi.restoreAllMocks());

/** 12×8 floor room, top row wall. */
function room(furniture: PlacedFurniture[]): OfficeLayout {
  const cols = 12;
  const rows = 8;
  const tiles: TileType[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) tiles.push(r === 0 ? TileType.WALL : TileType.FLOOR_1);
  }
  return { version: 1, cols, rows, tiles, furniture };
}

const CHAIR = 'WOODEN_CHAIR_BACK'; // faces UP (the item above it is in front)

function hasType(id: string): boolean {
  return getCatalogEntry(id) !== undefined;
}

describe('living seats are never a user-office desk', () => {
  it('recognizes exactly the composed uids, never a user uid that merely looks alike', () => {
    const os = new OfficeState(room([]));
    os.setComposedUids(['living-10-scope-chair-3', 'living-lounge-beanbag-0']);
    expect(os.isComposedSeat('living-10-scope-chair-3')).toBe(true);
    expect(os.isComposedSeat('living-10-scope-chair-3:1')).toBe(true); // multi-tile seat
    expect(os.isComposedSeat('living-my-own-chair')).toBe(false);
    expect(os.isComposedSeat('chair-1')).toBe(false);
  });

  it('a user chair whose uid starts with living- is still a desk', () => {
    const os = new OfficeState(room([{ uid: 'living-room-chair', type: CHAIR, col: 8, row: 5 }]));
    os.addAgent(1, 0, 0, undefined, true);
    expect(os.characters.get(1)!.seatId).toBe('living-room-chair');
  });

  it('a new agent takes the user desk even when the only PC seat is a module seat', () => {
    expect(hasType(CHAIR)).toBe(true);
    const os = new OfficeState(
      room([
        { uid: 'living-7-pc', type: 'PC_FRONT_OFF', col: 2, row: 1 },
        { uid: 'living-7-scope-chair-1', type: CHAIR, col: 2, row: 3 },
        { uid: 'user-chair', type: CHAIR, col: 8, row: 5 },
      ]),
    );
    os.setComposedUids(['living-7-pc', 'living-7-scope-chair-1']);
    for (let i = 0; i < 20; i++) {
      os.addAgent(100 + i, 0, 0, undefined, true);
      const seat = os.characters.get(100 + i)!.seatId;
      if (i === 0) expect(seat).toBe('user-chair');
      else expect(seat === null || !os.isComposedSeat(seat)).toBe(true);
    }
    expect(os.pickDeskSeat()).toBeNull();
    // ...and nobody may be sent there by hand either.
    expect(os.canAssignSeatByHand('living-7-scope-chair-1')).toBe(false);
    expect(os.canAssignSeatByHand('user-chair')).toBe(true);
  });
});

describe('the arcade and the console are not anybody’s PC', () => {
  it('a seat facing an arcade is not preferred as a PC seat', () => {
    // Two chairs: one facing an arcade, one facing a real PC. PC-bias must pick
    // the PC chair every time.
    const os = () =>
      new OfficeState(
        room([
          { uid: 'arcade', type: 'ARCADE_OFF', col: 2, row: 1 },
          { uid: 'arcade-chair', type: CHAIR, col: 2, row: 3 },
          { uid: 'pc', type: 'PC_FRONT_OFF', col: 8, row: 1 },
          { uid: 'pc-chair', type: CHAIR, col: 8, row: 3 },
        ]),
      );
    for (const r of [0, 0.49, 0.51, 0.99]) {
      vi.spyOn(Math, 'random').mockReturnValue(r);
      const o = os();
      o.addAgent(1, 0, 0, undefined, true);
      expect(o.characters.get(1)!.seatId).toBe('pc-chair');
      vi.restoreAllMocks();
    }
  });

  it('a working agent facing the arcade does not switch it on; a PC does', () => {
    const os = new OfficeState(
      room([
        { uid: 'arcade', type: 'ARCADE_OFF', col: 2, row: 1 },
        { uid: 'arcade-chair', type: CHAIR, col: 2, row: 3 },
        { uid: 'pc', type: 'PC_FRONT_OFF', col: 8, row: 1 },
        { uid: 'pc-chair', type: CHAIR, col: 8, row: 3 },
      ]),
    );
    os.addAgent(1, 0, 0, 'arcade-chair', true);
    os.addAgent(2, 0, 0, 'pc-chair', true);
    os.setAgentActive(1, true);
    os.setAgentActive(2, true);
    const types = drawnTypes(os);
    expect(types).toContain('ARCADE_OFF');
    expect(types.some((t) => t.startsWith('PC_FRONT_ON'))).toBe(true);
  });
});

/** Furniture types as drawn this frame (auto-state applied), by sprite identity. */
function drawnTypes(os: OfficeState): string[] {
  const out: string[] = [];
  for (const inst of os.furniture) {
    for (const t of [
      'ARCADE_OFF',
      'ARCADE_ON_1',
      'ARCADE_ON_2',
      'PC_FRONT_OFF',
      'PC_FRONT_ON_1',
      'PC_FRONT_ON_2',
      'PC_FRONT_ON_3',
      'GAME_CONSOLE_OFF',
      'GAME_CONSOLE_ON_1',
      'GAME_CONSOLE_ON_2',
    ]) {
      const e = getCatalogEntry(t);
      if (e && inst.sprite === e.sprite) out.push(t);
    }
  }
  return out;
}

describe('the console plays while someone rests in front of it', () => {
  it('switches on for a rester on a lounge seat facing it, off when they leave', () => {
    const os = new OfficeState(
      room([
        { uid: 'tv', type: 'GAME_CONSOLE_OFF', col: 5, row: 2 },
        { uid: 'bean', type: 'BEANBAG_BACK', col: 5, row: 4 },
        { uid: 'desk-chair', type: CHAIR, col: 10, row: 6 },
      ]),
    );
    os.setLivingTargets({ door: { col: 1, row: 1, uid: '' }, loungeSeats: ['bean'] });
    os.addAgent(1, 0, 0, 'desk-chair', true);
    os.setAgentActive(1, false);
    expect(drawnTypes(os)).toContain('GAME_CONSOLE_OFF');
    os.setPresence(1, 'lounge');
    for (let i = 0; i < 400; i++) os.update(0.05);
    const ch = os.characters.get(1)!;
    expect([ch.tileCol, ch.tileRow]).toEqual([5, 4]);
    expect(drawnTypes(os).some((t) => t.startsWith('GAME_CONSOLE_ON'))).toBe(true);
    os.setPresence(1, 'working');
    for (let i = 0; i < 10; i++) os.update(0.05);
    expect(drawnTypes(os)).toContain('GAME_CONSOLE_OFF');
  });
});
