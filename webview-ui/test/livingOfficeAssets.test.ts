/**
 * Living-office furniture (DOOR, ARCADE, GAME_CONSOLE, BEANBAG) as the webview
 * sees it: the bundled assets decoded through the same core pipeline the Vite
 * dev server / standalone build uses, fed into the real catalog, editor
 * placement, seat derivation and furniture z-sort. The server side (the
 * extension/CLI loader and the generator drift check) lives in
 * `server/__tests__/livingOfficeAssets.test.ts`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildFurnitureCatalog } from '../../core/src/assets/build.ts';
import { decodeAllFurniture } from '../../core/src/assets/loader.ts';
import { CHARACTER_Z_SORT_OFFSET } from '../src/constants.js';
import { canPlaceFurniture, getWallPlacementRow } from '../src/office/editor/editorActions.js';
import {
  buildDynamicCatalog,
  getAnimationFrames,
  getCatalogByCategory,
  getRotatedType,
  getToggledType,
} from '../src/office/layout/furnitureCatalog.js';
import {
  layoutToFurnitureInstances,
  layoutToSeats,
} from '../src/office/layout/layoutSerializer.js';
import type { OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { Direction, TILE_SIZE, TileType } from '../src/office/types.js';

const assetsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  'assets',
);

/** A room of floor tiles whose top row is wall, big enough for every item. */
function room(furniture: PlacedFurniture[] = []): OfficeLayout {
  const cols = 8;
  const rows = 6;
  const tiles: TileType[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) tiles.push(r === 0 ? TileType.WALL : TileType.FLOOR_1);
  }
  return { version: 1, cols, rows, tiles, furniture };
}

/** Depth of a character seated at `row` (same formula as renderer.ts). */
function seatedCharacterZY(row: number): number {
  const centerY = row * TILE_SIZE + TILE_SIZE / 2;
  return centerY + TILE_SIZE / 2 + CHARACTER_Z_SORT_OFFSET;
}

beforeAll(() => {
  const catalog = buildFurnitureCatalog(assetsDir);
  const sprites = decodeAllFurniture(assetsDir, catalog);
  expect(buildDynamicCatalog({ catalog, sprites })).toBe(true);
});

describe('living-office assets in the editor palette', () => {
  const ids = (category: Parameters<typeof getCatalogByCategory>[0]) =>
    getCatalogByCategory(category).map((e) => e.type);

  it('lists each item once in its category, hiding on-states, animation frames and back views', () => {
    expect(ids('electronics')).toEqual(expect.arrayContaining(['ARCADE_OFF', 'GAME_CONSOLE_OFF']));
    for (const hidden of ['ARCADE_ON_1', 'ARCADE_ON_2', 'GAME_CONSOLE_ON_1', 'GAME_CONSOLE_ON_2']) {
      expect(ids('electronics')).not.toContain(hidden);
    }
    expect(ids('chairs')).toContain('BEANBAG');
    expect(ids('chairs')).not.toContain('BEANBAG_BACK');
    expect(ids('wall')).toContain('DOOR_CLOSED');
  });

  it('KNOWN GAP: the catalog pairs only on/off, so DOOR_OPEN is a second "Door" entry with no T toggle', () => {
    // Pinned so the change is visible when the catalog learns generic state
    // pairs: then DOOR_OPEN should leave the palette and T should toggle.
    expect(ids('wall')).toContain('DOOR_OPEN');
    expect(getToggledType('DOOR_CLOSED')).toBeNull();
  });

  it('pairs off/on for the electronics (T toggles, auto-state animates)', () => {
    expect(getToggledType('ARCADE_OFF')).toBe('ARCADE_ON_1');
    expect(getToggledType('GAME_CONSOLE_OFF')).toBe('GAME_CONSOLE_ON_1');
    expect(getAnimationFrames('ARCADE_ON_1')).toEqual(['ARCADE_ON_1', 'ARCADE_ON_2']);
    expect(getAnimationFrames('GAME_CONSOLE_ON_1')).toEqual([
      'GAME_CONSOLE_ON_1',
      'GAME_CONSOLE_ON_2',
    ]);
  });

  it('rotates the beanbag between its front and back views (R)', () => {
    expect(getRotatedType('BEANBAG', 'cw')).toBe('BEANBAG_BACK');
    expect(getRotatedType('BEANBAG_BACK', 'cw')).toBe('BEANBAG');
  });
});

describe('living-office assets placed in a room', () => {
  it('hangs the door on a wall and stands the rest on the floor', () => {
    const layout = room();
    // Hovering the wall tile (row 0): the door's bottom row lands on it
    const doorRow = getWallPlacementRow('DOOR_CLOSED', 0);
    expect(doorRow).toBe(-1);
    expect(canPlaceFurniture(layout, 'DOOR_CLOSED', 2, doorRow)).toBe(true);
    // ...but never on the floor
    expect(canPlaceFurniture(layout, 'DOOR_CLOSED', 2, getWallPlacementRow('DOOR_CLOSED', 3))).toBe(
      false,
    );
    // The arcade's top row is a background row, so it can back onto the wall
    expect(canPlaceFurniture(layout, 'ARCADE_OFF', 1, 0)).toBe(true);
    expect(canPlaceFurniture(layout, 'GAME_CONSOLE_OFF', 3, 2)).toBe(true);
    expect(canPlaceFurniture(layout, 'BEANBAG', 4, 4)).toBe(true);
    expect(canPlaceFurniture(layout, 'GAME_CONSOLE_OFF', 3, 0)).toBe(false);
    expect(canPlaceFurniture(layout, 'BEANBAG', 4, 0)).toBe(false);
  });

  it('makes each beanbag one seat facing its orientation: front looks down, back looks up (at a TV)', () => {
    const seats = layoutToSeats([
      { uid: 'front', type: 'BEANBAG', col: 2, row: 4 },
      { uid: 'back', type: 'BEANBAG_BACK', col: 4, row: 4 },
    ]);
    expect([...seats.keys()].sort()).toEqual(['back', 'front']);
    expect(seats.get('front')).toMatchObject({ seatCol: 2, seatRow: 4, facingDir: Direction.DOWN });
    expect(seats.get('back')).toMatchObject({ seatCol: 4, seatRow: 4, facingDir: Direction.UP });
  });

  it('draws a seated character in front of the front beanbag and behind the back one', () => {
    const row = 4;
    const [front, back] = layoutToFurnitureInstances([
      { uid: 'front', type: 'BEANBAG', col: 2, row },
      { uid: 'back', type: 'BEANBAG_BACK', col: 4, row },
    ]);
    expect(front.zY).toBeLessThan(seatedCharacterZY(row));
    expect(back.zY).toBeGreaterThan(seatedCharacterZY(row));
  });
});
