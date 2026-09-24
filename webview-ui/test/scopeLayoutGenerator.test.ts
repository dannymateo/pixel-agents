import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MAX_COLS, MAX_ROWS, SCOPE_SLOTS_PER_ROW } from '../src/constants.js';
import { canPlaceFurniture } from '../src/office/editor/editorActions.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import {
  buildDynamicCatalog,
  getCatalogEntry,
  getOnStateType,
} from '../src/office/layout/furnitureCatalog.js';
import {
  getBlockedTiles,
  getSeatTiles,
  layoutToSeats,
  layoutToTileMap,
} from '../src/office/layout/layoutSerializer.js';
import { findPath } from '../src/office/layout/tileMap.js';
import {
  DEFAULT_SCOPE_KIT,
  generateScopeLayout,
  scopeLayoutCapacity,
} from '../src/office/scope/scopeLayoutGenerator.js';
import type { OfficeLayout, PlacedFurniture } from '../src/office/types.js';
import { Direction, TileType } from '../src/office/types.js';

const chairs = (n: number) =>
  generateScopeLayout(n, DEFAULT_SCOPE_KIT).furniture.filter(
    (f) => f.type === DEFAULT_SCOPE_KIT.chair,
  );

const tileAt = (l: OfficeLayout, col: number, row: number) => l.tiles[row * l.cols + col];

const byUid = (l: OfficeLayout, uid: string): PlacedFurniture => {
  const f = l.furniture.find((x) => x.uid === uid);
  if (!f) throw new Error(`missing ${uid}`);
  return f;
};

describe('generateScopeLayout', () => {
  it('has one workstation per member', () => {
    for (const n of [1, 2, 3, 5, 9, 17]) expect(chairs(n)).toHaveLength(n);
  });
  it('is deterministic (same input, same uids and positions)', () => {
    expect(generateScopeLayout(4, DEFAULT_SCOPE_KIT)).toEqual(
      generateScopeLayout(4, DEFAULT_SCOPE_KIT),
    );
  });
  it('keeps existing workstation uids when it grows', () => {
    const small = new Set(chairs(3).map((f) => `${f.uid}@${f.col},${f.row}`));
    const big = new Set(chairs(3 + SCOPE_SLOTS_PER_ROW).map((f) => `${f.uid}@${f.col},${f.row}`));
    for (const k of small) expect(big.has(k)).toBe(true);
  });
  it('fits the grid limits and has a wall top row', () => {
    const l = generateScopeLayout(17, DEFAULT_SCOPE_KIT);
    expect(l.cols).toBeLessThanOrEqual(64);
    expect(l.rows).toBeLessThanOrEqual(64);
    expect(l.tiles.slice(0, l.cols).every((t) => t === TileType.WALL)).toBe(true);
    expect(l.tiles.length).toBe(l.cols * l.rows);
  });
});

describe('generateScopeLayout — workstation geometry', () => {
  it('puts the monitor on the desk and the chair right below it, facing the desk', () => {
    const l = generateScopeLayout(6, DEFAULT_SCOPE_KIT);
    for (let slot = 0; slot < 6; slot++) {
      const desk = byUid(l, `scope-desk-${slot}`);
      const pc = byUid(l, `scope-pc-${slot}`);
      const chair = byUid(l, `scope-chair-${slot}`);
      expect(desk.type).toBe('DESK_FRONT');
      expect(pc.type).toBe('PC_FRONT_OFF');
      // Same geometry the bundled default layout uses (DESK_FRONT 3x2, PC on its middle column).
      expect(pc.col).toBe(desk.col + 1);
      expect(pc.row).toBe(desk.row);
      // Back-facing chair directly under the desk's bottom row: layoutToSeats maps
      // orientation "back" to Direction.UP, i.e. the sitter faces the desk.
      expect(chair.type).toBe('CUSHIONED_CHAIR_BACK');
      expect(chair.col).toBe(desk.col + 1);
      expect(chair.row).toBe(desk.row + 2);
    }
  });
  it('seats the owner above every child', () => {
    const l = generateScopeLayout(9, DEFAULT_SCOPE_KIT);
    const owner = byUid(l, 'scope-chair-0');
    for (let slot = 1; slot < 9; slot++) {
      expect(byUid(l, `scope-chair-${slot}`).row).toBeGreaterThan(owner.row);
    }
  });
  it('places every furniture piece on floor inside the room, never overlapping another workstation', () => {
    const l = generateScopeLayout(scopeLayoutCapacity(), DEFAULT_SCOPE_KIT);
    const occupied = new Set<string>();
    for (const f of l.furniture.filter((x) => x.type !== DEFAULT_SCOPE_KIT.monitor)) {
      const [w, h] = f.type === DEFAULT_SCOPE_KIT.desk ? [3, 2] : [1, 1];
      for (let dr = 0; dr < h; dr++) {
        for (let dc = 0; dc < w; dc++) {
          const key = `${f.col + dc},${f.row + dr}`;
          expect(occupied.has(key)).toBe(false);
          occupied.add(key);
          expect(tileAt(l, f.col + dc, f.row + dr)).toBe(TileType.FLOOR_1);
        }
      }
    }
  });
  it('leaves the tile below each chair walkable (aisle)', () => {
    const l = generateScopeLayout(scopeLayoutCapacity(), DEFAULT_SCOPE_KIT);
    const blocked = new Set(
      l.furniture.flatMap((f) =>
        f.type === DEFAULT_SCOPE_KIT.desk
          ? [0, 1, 2].flatMap((dc) => [`${f.col + dc},${f.row + 1}`])
          : f.type === DEFAULT_SCOPE_KIT.chair
            ? [`${f.col},${f.row}`]
            : [],
      ),
    );
    for (const c of l.furniture.filter((f) => f.type === DEFAULT_SCOPE_KIT.chair)) {
      expect(blocked.has(`${c.col},${c.row + 1}`)).toBe(false);
      expect(tileAt(l, c.col, c.row + 1)).toBe(TileType.FLOOR_1);
    }
  });
  it('uses the kit it is given', () => {
    const kit = { desk: 'D', chair: 'C', monitor: 'M' };
    const types = new Set(generateScopeLayout(2, kit).furniture.map((f) => f.type));
    expect(types).toEqual(new Set(['D', 'C', 'M']));
  });
});

describe('generateScopeLayout — bounds', () => {
  it('never exceeds the editor grid limits, however many members', () => {
    for (const n of [scopeLayoutCapacity(), scopeLayoutCapacity() + 1, 1_000, 1e9]) {
      const l = generateScopeLayout(n, DEFAULT_SCOPE_KIT);
      expect(l.cols).toBeLessThanOrEqual(MAX_COLS);
      expect(l.rows).toBeLessThanOrEqual(MAX_ROWS);
      expect(l.tiles.length).toBe(l.cols * l.rows);
    }
  });
  it('caps workstations at the capacity and keeps growth stable up to it', () => {
    const cap = scopeLayoutCapacity();
    expect(cap).toBeGreaterThan(SCOPE_SLOTS_PER_ROW);
    expect(chairs(cap)).toHaveLength(cap);
    expect(chairs(cap + 50)).toHaveLength(cap);
    const prev = new Set(chairs(cap - 1).map((f) => `${f.uid}@${f.col},${f.row}`));
    const full = new Set(chairs(cap).map((f) => `${f.uid}@${f.col},${f.row}`));
    for (const k of prev) expect(full.has(k)).toBe(true);
  });
  it('treats zero, negative, fractional and non-finite counts as sane values', () => {
    expect(chairs(0)).toHaveLength(1);
    expect(chairs(-5)).toHaveLength(1);
    expect(chairs(2.7)).toHaveLength(2);
    expect(chairs(Number.NaN)).toHaveLength(1);
    expect(chairs(Number.POSITIVE_INFINITY)).toHaveLength(scopeLayoutCapacity());
    expect(chairs(Number.NEGATIVE_INFINITY)).toHaveLength(1);
  });
  it('a non-number count (untyped wire data) still yields a consistent one-seat room', () => {
    for (const bad of [undefined, null, 'abc', '12', {}] as unknown as number[]) {
      const l = generateScopeLayout(bad, DEFAULT_SCOPE_KIT);
      expect(Number.isInteger(l.rows)).toBe(true);
      expect(l.tiles.length).toBe(l.cols * l.rows);
      expect(l.furniture.filter((f) => f.type === DEFAULT_SCOPE_KIT.chair)).toHaveLength(1);
    }
  });
  it('declares no pets so migration leaves the layout untouched there', () => {
    expect(generateScopeLayout(1, DEFAULT_SCOPE_KIT).pets).toEqual([]);
  });
});

// ── Against the real catalog and seat/pathing code ───────────────────────────

interface ManifestNode {
  type?: string;
  id?: string;
  category?: string;
  footprintW?: number;
  footprintH?: number;
  orientation?: string;
  state?: string;
  backgroundTiles?: number;
  canPlaceOnSurfaces?: boolean;
  canPlaceOnWalls?: boolean;
  members?: ManifestNode[];
}

/** Flattens the bundled furniture manifests the way the asset loader does
 *  (footprints, inherited orientation/state, isDesk = category "desks"). */
function loadBundledCatalog(): LoadedAssetData {
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../public/assets/furniture',
  );
  const catalog: LoadedAssetData['catalog'] = [];
  const sprites: LoadedAssetData['sprites'] = {};
  for (const dir of fs.readdirSync(root)) {
    const file = path.join(root, dir, 'manifest.json');
    if (!fs.existsSync(file)) continue;
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as ManifestNode;
    const walk = (node: ManifestNode, orientation?: string, state?: string): void => {
      const o = node.orientation ?? orientation;
      const s = node.state ?? state;
      if (node.members) {
        for (const m of node.members) walk(m, o, s);
        return;
      }
      if (!node.id || !node.footprintW || !node.footprintH) return;
      catalog.push({
        id: node.id,
        label: node.id,
        category: manifest.category ?? 'misc',
        width: node.footprintW * 16,
        height: node.footprintH * 16,
        footprintW: node.footprintW,
        footprintH: node.footprintH,
        isDesk: manifest.category === 'desks',
        ...(manifest.id ? { groupId: manifest.id } : {}),
        ...(o ? { orientation: o } : {}),
        ...(s ? { state: s } : {}),
        ...(manifest.backgroundTiles ? { backgroundTiles: manifest.backgroundTiles } : {}),
        ...(manifest.canPlaceOnSurfaces ? { canPlaceOnSurfaces: true } : {}),
        ...(manifest.canPlaceOnWalls ? { canPlaceOnWalls: true } : {}),
      });
      sprites[node.id] = [['']];
    };
    walk(manifest);
  }
  return { catalog, sprites };
}

describe('generateScopeLayout — with the bundled catalog', () => {
  it('the default kit exists in the bundled assets', () => {
    expect(buildDynamicCatalog(loadBundledCatalog())).toBe(true);
    expect(getCatalogEntry(DEFAULT_SCOPE_KIT.desk)).toMatchObject({
      footprintW: 3,
      footprintH: 2,
      isDesk: true,
    });
    expect(getCatalogEntry(DEFAULT_SCOPE_KIT.monitor)).toMatchObject({
      footprintW: 1,
      canPlaceOnSurfaces: true,
    });
    expect(getCatalogEntry(DEFAULT_SCOPE_KIT.chair)).toMatchObject({
      category: 'chairs',
      orientation: 'back',
    });
  });

  it('every member gets exactly one seat, facing the desk', () => {
    buildDynamicCatalog(loadBundledCatalog());
    const n = 11;
    const seats = layoutToSeats(generateScopeLayout(n, DEFAULT_SCOPE_KIT).furniture);
    expect(seats.size).toBe(n);
    for (let slot = 0; slot < n; slot++) {
      expect(seats.get(`scope-chair-${slot}`)?.facingDir).toBe(Direction.UP);
    }
  });

  it('an active sitter faces its own monitor, which has an ON state to switch to', () => {
    buildDynamicCatalog(loadBundledCatalog());
    expect(getOnStateType(DEFAULT_SCOPE_KIT.monitor)).not.toBe(DEFAULT_SCOPE_KIT.monitor);
    const l = generateScopeLayout(6, DEFAULT_SCOPE_KIT);
    const seats = layoutToSeats(l.furniture);
    for (let slot = 0; slot < 6; slot++) {
      const seat = seats.get(`scope-chair-${slot}`)!;
      const pc = byUid(l, `scope-pc-${slot}`);
      const pcH = getCatalogEntry(pc.type)!.footprintH;
      // The tile right in front of the seat (facing UP) is covered by the monitor,
      // so OfficeState's auto-on scan swaps it to its ON sprite.
      expect(seat.seatCol).toBe(pc.col);
      expect(seat.seatRow - 1).toBeGreaterThanOrEqual(pc.row);
      expect(seat.seatRow - 1).toBeLessThan(pc.row + pcH);
    }
  });

  it('the layout editor would accept every piece, placed in the generated order', () => {
    buildDynamicCatalog(loadBundledCatalog());
    const full = generateScopeLayout(scopeLayoutCapacity(), DEFAULT_SCOPE_KIT);
    let built: OfficeLayout = { ...full, furniture: [] };
    for (const f of full.furniture) {
      expect(canPlaceFurniture(built, f.type, f.col, f.row), f.uid).toBe(true);
      built = { ...built, furniture: [...built.furniture, f] };
    }
  });

  it('every seat can be walked to from the room entrance row', () => {
    buildDynamicCatalog(loadBundledCatalog());
    const l = generateScopeLayout(scopeLayoutCapacity(), DEFAULT_SCOPE_KIT);
    const seats = layoutToSeats(l.furniture);
    const blocked = getBlockedTiles(l.furniture, getSeatTiles(seats));
    const map = layoutToTileMap(l);
    const start = { col: 1, row: 1 };
    for (const seat of seats.values()) {
      const route = findPath(start.col, start.row, seat.seatCol, seat.seatRow, map, blocked);
      expect(route.length, seat.uid).toBeGreaterThan(0);
    }
  });
});
