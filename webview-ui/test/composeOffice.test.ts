import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  AREA_DEFAULT_COLORS,
  LOUNGE_AREA_LABEL,
  MAX_COLS,
  MAX_ROWS,
  MODULE_AREA_COLORS,
  MODULE_GAP_COLS,
} from '../src/constants.js';
import type { LoadedAssetData } from '../src/office/layout/furnitureCatalog.js';
import { buildDynamicCatalog, getCatalogEntry } from '../src/office/layout/furnitureCatalog.js';
import {
  getBlockedTiles,
  getSeatTiles,
  layoutToSeats,
  layoutToTileMap,
} from '../src/office/layout/layoutSerializer.js';
import { findPath } from '../src/office/layout/tileMap.js';
import type { LivingOffice, TeamSpec } from '../src/office/living/composeOffice.js';
import {
  composeLivingOffice,
  LIVING_ASSET_TYPES,
  MODULE_LABEL_MAX_CHARS,
  sanitizeModuleLabel,
  teamsFromDirectory,
} from '../src/office/living/composeOffice.js';
import { AgentDirectory } from '../src/office/scope/agentDirectory.js';
import { scopeLayoutCapacity } from '../src/office/scope/scopeLayoutGenerator.js';
import type {
  OfficeLayout,
  PlacedFurniture,
  TileType as TileTypeVal,
} from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

// ── Catalog: the bundled manifests, plus stand-ins for the living-office assets
// (T20) when they are not on disk yet. Stand-ins use the footprints T20 specifies.

interface ManifestNode {
  id?: string;
  category?: string;
  footprintW?: number;
  footprintH?: number;
  orientation?: string;
  state?: string;
  backgroundTiles?: number;
  canPlaceOnSurfaces?: boolean;
  canPlaceOnWalls?: boolean;
  mirrorSide?: boolean;
  members?: ManifestNode[];
}

const FURNITURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../public/assets/furniture',
);

function loadCatalog(): LoadedAssetData {
  const catalog: LoadedAssetData['catalog'] = [];
  const sprites: LoadedAssetData['sprites'] = {};
  for (const dir of fs.readdirSync(FURNITURE_ROOT)) {
    const file = path.join(FURNITURE_ROOT, dir, 'manifest.json');
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
        ...(node.mirrorSide ? { mirrorSide: true } : {}),
      });
      sprites[node.id] = [['']];
    };
    walk(manifest);
  }
  const standIns: Array<[string, string, number, number]> = [
    [LIVING_ASSET_TYPES.doorClosed, 'wall', 1, 2],
    [LIVING_ASSET_TYPES.doorOpen, 'wall', 1, 2],
    [LIVING_ASSET_TYPES.arcade, 'electronics', 1, 2],
    [LIVING_ASSET_TYPES.gameConsole, 'electronics', 2, 1],
    [LIVING_ASSET_TYPES.beanbag, 'chairs', 1, 1],
  ];
  for (const [id, category, w, h] of standIns) {
    if (catalog.some((e) => e.id === id)) continue;
    catalog.push({
      id,
      label: id,
      category,
      width: w * 16,
      height: h * 16,
      footprintW: w,
      footprintH: h,
      isDesk: false,
      ...(category === 'wall' ? { canPlaceOnWalls: true } : {}),
    });
    sprites[id] = [['']];
  }
  return { catalog, sprites };
}

beforeAll(() => {
  expect(buildDynamicCatalog(loadCatalog())).toBe(true);
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const W = TileType.WALL;
const F = TileType.FLOOR_2;
const V = TileType.VOID;

/** A walled room: VOID headroom row, a wall ring, floor inside, one desk + chair. */
function userRoom(cols = 12, rows = 10, extra: PlacedFurniture[] = []): OfficeLayout {
  const tiles: TileTypeVal[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r === 0) tiles.push(V);
      else if (r === 1 || r === rows - 1 || c === 0 || c === cols - 1) tiles.push(W);
      else tiles.push(F);
    }
  }
  return {
    version: 1,
    cols,
    rows,
    tiles,
    tileColors: tiles.map((t) => (t === F ? { h: 10, s: 20, b: 0, c: 0 } : null)),
    furniture: [
      { uid: 'u-desk', type: 'DESK_FRONT', col: 2, row: 3 },
      { uid: 'u-chair', type: 'CUSHIONED_CHAIR_BACK', col: 3, row: 5 },
      ...extra,
    ],
    pets: [],
  };
}

const team = (
  ownerId: number,
  members: Array<[number, number]>,
  label = `Fase ${ownerId}`,
): TeamSpec => ({
  ownerId,
  label,
  members: members.map(([id, parentId]) => ({ id, parentId })),
});

const tileAt = (l: OfficeLayout, c: number, r: number) => l.tiles[r * l.cols + c];
const areaAt = (l: OfficeLayout, c: number, r: number) => l.areaTiles?.[r * l.cols + c] ?? null;

function seatUids(o: LivingOffice): Set<string> {
  return new Set(o.modules.flatMap((m) => [...m.seatByAgent.values()]));
}

function assertGrid(o: LivingOffice): void {
  const l = o.layout;
  expect(l.cols).toBeLessThanOrEqual(MAX_COLS);
  expect(l.rows).toBeLessThanOrEqual(MAX_ROWS);
  expect(l.tiles).toHaveLength(l.cols * l.rows);
  expect(l.tileColors).toHaveLength(l.cols * l.rows);
  expect(l.areaTiles).toHaveLength(l.cols * l.rows);
  const uids = l.furniture.map((f) => f.uid);
  expect(new Set(uids).size).toBe(uids.length);
  const labels = (l.areas ?? []).map((a) => a.label);
  expect(new Set(labels).size).toBe(labels.length);
  for (const m of o.modules) {
    expect(m.col).toBeGreaterThanOrEqual(o.userCols + MODULE_GAP_COLS);
    expect(m.col + m.cols).toBeLessThanOrEqual(MAX_COLS);
    expect(m.row + m.rows).toBeLessThanOrEqual(MAX_ROWS);
  }
}

/** Every module seat and every lounge seat can be walked to from the door. */
function assertReachable(o: LivingOffice): void {
  const l = o.layout;
  const seats = layoutToSeats(l.furniture);
  const blocked = getBlockedTiles(l.furniture, getSeatTiles(seats));
  const map = layoutToTileMap(l);
  const targets = [...seatUids(o), ...o.loungeSeats];
  for (const uid of targets) {
    const seat = seats.get(uid);
    expect(seat, uid).toBeDefined();
    const route = findPath(o.door.col, o.door.row, seat!.seatCol, seat!.seatRow, map, blocked);
    expect(route.length, `path door → ${uid}`).toBeGreaterThan(0);
  }
}

// ── (a) the user's layout ───────────────────────────────────────────────────

describe('composeLivingOffice — (a) the user layout stays theirs', () => {
  it('keeps every user tile in [0, userCols) except the one-row passage to the modules', () => {
    const user = userRoom();
    const o = composeLivingOffice(user, [team(10, [[11, 10]])]);
    expect(o.userCols).toBe(user.cols);
    const changed: Array<[number, number]> = [];
    for (let r = 0; r < user.rows; r++) {
      for (let c = 0; c < user.cols; c++) {
        if (tileAt(o.layout, c, r) !== user.tiles[r * user.cols + c]) changed.push([c, r]);
      }
    }
    // The passage: one row, from the room's east floor to the east edge, only
    // through wall/void — never through the room itself.
    expect(changed.length).toBeGreaterThan(0);
    const row = changed[0][1];
    expect(changed.every(([, r]) => r === row)).toBe(true);
    for (const [c] of changed) {
      expect([W, V]).toContain(user.tiles[row * user.cols + c]);
      expect(c).toBeGreaterThan(0);
    }
    expect(Math.max(...changed.map(([c]) => c))).toBe(user.cols - 1);
  });

  it('keeps the user furniture, pets and colors untouched and does not mutate the input', () => {
    const user = userRoom();
    const snapshot = JSON.stringify(user);
    const o = composeLivingOffice(user, [team(10, [[11, 10]])]);
    expect(JSON.stringify(user)).toBe(snapshot);
    for (const f of user.furniture) expect(o.layout.furniture).toContainEqual(f);
    expect(o.layout.pets).toEqual(user.pets);
    for (let r = 2; r < user.rows - 1; r++) {
      for (let c = 1; c < user.cols - 1; c++) {
        expect(o.layout.tileColors?.[r * o.layout.cols + c]).toEqual(
          user.tileColors?.[r * user.cols + c],
        );
      }
    }
  });

  it('without teams (and with a user lounge + door) the office is the user layout itself', () => {
    const user = userRoom(12, 10, [
      { uid: 'u-door', type: LIVING_ASSET_TYPES.doorClosed, col: 5, row: 0 },
      { uid: 'u-rest', type: 'CUSHIONED_CHAIR_FRONT', col: 8, row: 3 },
    ]);
    user.areas = [{ label: LOUNGE_AREA_LABEL, color: AREA_DEFAULT_COLORS[0] }];
    user.areaTiles = user.tiles.map((_, i) => (i === 3 * 12 + 8 ? LOUNGE_AREA_LABEL : null));
    const o = composeLivingOffice(user, []);
    expect(o.layout.cols).toBe(user.cols);
    expect(o.layout.rows).toBe(user.rows);
    expect(o.layout.tiles).toEqual(user.tiles);
    expect(o.layout.furniture).toEqual(user.furniture);
    expect(o.modules).toEqual([]);
  });
});

// ── (b) one module per team ─────────────────────────────────────────────────

describe('composeLivingOffice — (b) modules and their Areas', () => {
  it('gives each team a module to the right with its own labeled, colored Area', () => {
    const user = userRoom();
    const o = composeLivingOffice(user, [
      team(10, [[11, 10]], 'Fase 1 · Auth'),
      team(20, [[21, 20]], 'Fase 2 · Pagos'),
    ]);
    assertGrid(o);
    expect(o.modules.map((m) => m.ownerId)).toEqual([10, 20]);
    expect(o.modules.map((m) => m.label)).toEqual(['Fase 1 · Auth', 'Fase 2 · Pagos']);
    for (const m of o.modules) {
      expect(MODULE_AREA_COLORS).toContain(m.color);
      expect(o.layout.areas).toContainEqual({ label: m.label, color: m.color });
      let painted = 0;
      for (let r = m.row; r < m.row + m.rows; r++) {
        for (let c = m.col; c < m.col + m.cols; c++)
          if (areaAt(o.layout, c, r) === m.label) painted++;
      }
      expect(painted).toBeGreaterThan(0);
      // No tile of the module's Area lies outside the module.
      for (let r = 0; r < o.layout.rows; r++) {
        for (let c = 0; c < o.layout.cols; c++) {
          if (areaAt(o.layout, c, r) !== m.label) continue;
          expect(c >= m.col && c < m.col + m.cols && r >= m.row && r < m.row + m.rows).toBe(true);
        }
      }
    }
    assertReachable(o);
  });

  it('colors are deterministic per owner', () => {
    const a = composeLivingOffice(userRoom(), [team(10, [[11, 10]]), team(20, [[21, 20]])]);
    const b = composeLivingOffice(userRoom(), [team(20, [[21, 20]])]);
    expect(b.modules[0].color).toBe(a.modules[1].color);
  });

  it('is pure and deterministic', () => {
    const teams = [team(10, [[11, 10]]), team(20, [[21, 20]])];
    expect(composeLivingOffice(userRoom(), teams)).toEqual(composeLivingOffice(userRoom(), teams));
  });
});

// ── (c) stability ───────────────────────────────────────────────────────────

describe('composeLivingOffice — (c) stability', () => {
  it('adding a team never moves the existing modules nor their seats', () => {
    const user = userRoom();
    const a = composeLivingOffice(user, [team(10, [[11, 10]]), team(20, [[21, 20]])]);
    const b = composeLivingOffice(
      user,
      [team(10, [[11, 10]]), team(20, [[21, 20]]), team(30, [[31, 30]])],
      a,
    );
    for (const prev of a.modules) {
      const next = b.modules.find((m) => m.ownerId === prev.ownerId)!;
      expect({ col: next.col, row: next.row }).toEqual({ col: prev.col, row: prev.row });
      expect(next.seatByAgent).toEqual(prev.seatByAgent);
    }
    // Their furniture is untouched too.
    const moduleFurniture = (o: LivingOffice) =>
      o.layout.furniture.filter((f) => /-(10|20)-scope-/.test(f.uid));
    expect(moduleFurniture(b)).toEqual(moduleFurniture(a));
  });

  it('adding a team in front of the list (new order) still keeps the existing ones in place', () => {
    const user = userRoom();
    const a = composeLivingOffice(user, [team(10, [[11, 10]])]);
    const b = composeLivingOffice(user, [team(30, [[31, 30]]), team(10, [[11, 10]])], a);
    expect(b.modules.find((m) => m.ownerId === 10)).toMatchObject({
      col: a.modules[0].col,
      row: a.modules[0].row,
    });
  });

  it('a member joining keeps everyone else in their seat', () => {
    const user = userRoom();
    const a = composeLivingOffice(user, [
      team(10, [
        [11, 10],
        [12, 10],
      ]),
    ]);
    const b = composeLivingOffice(
      user,
      [
        team(10, [
          [11, 10],
          [12, 10],
          [13, 11],
        ]),
      ],
      a,
    );
    for (const [id, uid] of a.modules[0].seatByAgent)
      expect(b.modules[0].seatByAgent.get(id)).toBe(uid);
  });

  it('freeing a module closes its gap without changing anybody’s seat uid', () => {
    const user = userRoom();
    const teams = [
      team(10, [
        [11, 10],
        [12, 10],
      ]),
      team(20, [[21, 20]]),
      team(30, [
        [31, 30],
        [32, 31],
      ]),
    ];
    const a = composeLivingOffice(user, teams);
    const b = composeLivingOffice(user, teams.slice(1), a);
    for (const owner of [20, 30]) {
      const prev = a.modules.find((m) => m.ownerId === owner)!;
      const next = b.modules.find((m) => m.ownerId === owner)!;
      expect(next.seatByAgent).toEqual(prev.seatByAgent);
      expect(next.col * MAX_ROWS + next.row).toBeLessThanOrEqual(prev.col * MAX_ROWS + prev.row);
    }
    // What sat below the freed module in its column (here the lounge) moved up.
    const freed = a.modules.find((m) => m.ownerId === 10)!;
    const bean = (o: LivingOffice) =>
      o.layout.furniture.find((f) => f.type === LIVING_ASSET_TYPES.beanbag)!;
    expect(bean(a).col).toBeGreaterThanOrEqual(freed.col);
    expect(bean(a).col).toBeLessThan(freed.col + freed.cols);
    expect(bean(b).row).toBe(bean(a).row - freed.rows);
    expect(bean(b).col).toBe(bean(a).col);
    assertGrid(b);
    assertReachable(b);
  });

  it('the office contracts back to the user layout when every team has left', () => {
    const user = userRoom(12, 10, [
      { uid: 'u-door', type: LIVING_ASSET_TYPES.doorClosed, col: 5, row: 0 },
      { uid: 'u-rest', type: 'CUSHIONED_CHAIR_FRONT', col: 8, row: 3 },
    ]);
    user.areas = [{ label: LOUNGE_AREA_LABEL, color: AREA_DEFAULT_COLORS[0] }];
    user.areaTiles = user.tiles.map((_, i) => (i === 3 * 12 + 8 ? LOUNGE_AREA_LABEL : null));
    const a = composeLivingOffice(user, [team(10, [[11, 10]])]);
    expect(a.layout.cols).toBeGreaterThan(user.cols);
    const b = composeLivingOffice(user, [], a);
    expect(b.layout.cols).toBe(user.cols);
    expect(b.layout.tiles).toEqual(user.tiles);
  });
});

// ── (d) seating by hierarchy ────────────────────────────────────────────────

describe('composeLivingOffice — (d) seating', () => {
  it('owner at the head desk, members below, reviewers at the desk next to their member', () => {
    const o = composeLivingOffice(userRoom(), [
      team(10, [
        [11, 10],
        [12, 10],
        [13, 11],
        [14, 11],
      ]),
    ]);
    const seats = layoutToSeats(o.layout.furniture);
    const m = o.modules[0];
    const pos = (id: number) => seats.get(m.seatByAgent.get(id)!)!;
    for (const id of [11, 12, 13, 14]) expect(pos(id).seatRow).toBeGreaterThan(pos(10).seatRow);
    expect(pos(11).seatRow).not.toBe(pos(12).seatRow);
    for (const reviewer of [13, 14]) expect(pos(reviewer).seatRow).toBe(pos(11).seatRow);
    expect([pos(13).seatCol, pos(14).seatCol].sort((x, y) => x - y)).toEqual([
      pos(11).seatCol + 4,
      pos(11).seatCol + 8,
    ]);
    // Every seated agent is inside its module's rectangle.
    for (const uid of m.seatByAgent.values()) {
      const s = seats.get(uid)!;
      expect(s.seatCol).toBeGreaterThanOrEqual(m.col);
      expect(s.seatCol).toBeLessThan(m.col + m.cols);
      expect(s.seatRow).toBeGreaterThanOrEqual(m.row);
      expect(s.seatRow).toBeLessThan(m.row + m.rows);
    }
  });

  it('an agent listed in two teams is seated once (first team wins)', () => {
    const o = composeLivingOffice(userRoom(), [
      team(10, [[11, 10]]),
      team(20, [
        [11, 20],
        [21, 20],
      ]),
    ]);
    const holders = o.modules.filter((m) => m.seatByAgent.has(11)).map((m) => m.ownerId);
    expect(holders).toEqual([10]);
  });

  it('a duplicated owner gets one module', () => {
    const o = composeLivingOffice(userRoom(), [team(10, [[11, 10]]), team(10, [[12, 10]])]);
    expect(o.modules.map((m) => m.ownerId)).toEqual([10]);
  });
});

// ── (e) door and lounge ─────────────────────────────────────────────────────

describe('composeLivingOffice — (e) entrance and lounge', () => {
  it('adds a default door on the first exterior wall with a walkable tile below it', () => {
    const user = userRoom();
    const o = composeLivingOffice(user, [team(10, [[11, 10]])]);
    const door = o.layout.furniture.find((f) => f.uid === o.door.uid)!;
    expect(door.type).toBe(LIVING_ASSET_TYPES.doorClosed);
    expect(user.furniture.some((f) => f.uid === door.uid)).toBe(false);
    const h = getCatalogEntry(door.type)?.footprintH ?? 2;
    // Bottom row sits on a wall tile; the walk target is the floor right below it.
    expect(tileAt(o.layout, door.col, door.row + h - 1)).toBe(W);
    expect(o.door).toMatchObject({ col: door.col, row: door.row + h });
    expect(o.door.col).toBeLessThan(user.cols);
    expect(tileAt(o.layout, o.door.col, o.door.row)).toBe(F);
    assertReachable(o);
  });

  it('uses the user’s own door when there is one', () => {
    const user = userRoom(12, 10, [
      { uid: 'my-door', type: LIVING_ASSET_TYPES.doorClosed, col: 7, row: 0 },
    ]);
    const o = composeLivingOffice(user, [team(10, [[11, 10]])]);
    expect(o.door).toEqual({ col: 7, row: 2, uid: 'my-door' });
    expect(o.layout.furniture.filter((f) => f.type === LIVING_ASSET_TYPES.doorClosed)).toHaveLength(
      1,
    );
  });

  it('generates a lounge with an arcade, a console, three beanbags and coffee when the user has none', () => {
    const o = composeLivingOffice(userRoom(), [team(10, [[11, 10]])]);
    const types = o.layout.furniture.map((f) => f.type);
    expect(types).toContain(LIVING_ASSET_TYPES.arcade);
    expect(types).toContain(LIVING_ASSET_TYPES.gameConsole);
    expect(types).toContain(LIVING_ASSET_TYPES.coffee);
    const beanbags = o.layout.furniture.filter((f) => f.type === LIVING_ASSET_TYPES.beanbag);
    expect(beanbags).toHaveLength(3);
    for (const b of beanbags) {
      expect(o.loungeSeats).toContain(b.uid);
      expect(b.col).toBeGreaterThanOrEqual(o.userCols);
      expect(areaAt(o.layout, b.col, b.row)).toBe(LOUNGE_AREA_LABEL);
    }
    expect(o.layout.areas?.some((a) => a.label === LOUNGE_AREA_LABEL)).toBe(true);
    assertReachable(o);
  });

  it('still generates the lounge (and door) with no teams at all', () => {
    const o = composeLivingOffice(userRoom(), []);
    expect(o.loungeSeats.length).toBe(3);
    expect(o.modules).toEqual([]);
    assertGrid(o);
    assertReachable(o);
  });

  it('uses the user’s "Descanso" Area when it exists, and generates no lounge', () => {
    const user = userRoom(12, 10, [
      { uid: 'u-sofa', type: 'SOFA_FRONT', col: 7, row: 6 },
      { uid: 'u-lounge-chair', type: 'CUSHIONED_CHAIR_FRONT', col: 9, row: 3 },
    ]);
    user.areas = [{ label: LOUNGE_AREA_LABEL, color: AREA_DEFAULT_COLORS[0] }];
    user.areaTiles = user.tiles.map((_, i) => {
      const c = i % 12;
      const r = Math.floor(i / 12);
      return c >= 7 && c <= 10 && r >= 2 && r <= 4 ? LOUNGE_AREA_LABEL : null;
    });
    const o = composeLivingOffice(user, [team(10, [[11, 10]])]);
    expect(o.layout.furniture.some((f) => f.type === LIVING_ASSET_TYPES.arcade)).toBe(false);
    expect(o.loungeSeats[0]).toBe('u-lounge-chair');
    // The sofa outside the area is still a rest seat (never a desk).
    expect(o.loungeSeats).toContain('u-sofa');
    expect(o.loungeSeats).toContain('u-sofa:1');
    expect(o.loungeSeats).not.toContain('u-chair');
  });

  it('keeps the lounge in place when a team joins after it', () => {
    const user = userRoom();
    const a = composeLivingOffice(user, [team(10, [[11, 10]])]);
    const b = composeLivingOffice(user, [team(10, [[11, 10]]), team(20, [[21, 20]])], a);
    const lounge = (o: LivingOffice) =>
      o.layout.furniture.filter(
        (f) => o.loungeSeats.includes(f.uid) || f.type === LIVING_ASSET_TYPES.arcade,
      );
    expect(lounge(b)).toEqual(lounge(a));
  });
});

// ── (f) 64×64 and the queue ─────────────────────────────────────────────────

describe('composeLivingOffice — (f) grid limits', () => {
  it('never exceeds 64×64; teams that do not fit are queued, in order, and the lounge keeps its place', () => {
    const teams: TeamSpec[] = [];
    for (let i = 0; i < 40; i++) {
      const owner = 100 + i * 10;
      teams.push(
        team(owner, [
          [owner + 1, owner],
          [owner + 2, owner],
        ]),
      );
    }
    const o = composeLivingOffice(userRoom(), teams);
    assertGrid(o);
    expect(o.queued.length).toBeGreaterThan(0);
    expect(o.modules.length + o.queued.length).toBe(40);
    const placed = new Set(o.modules.map((m) => m.ownerId));
    for (const q of o.queued) expect(placed.has(q)).toBe(false);
    expect(o.loungeSeats.length).toBe(3);
    assertReachable(o);
  });

  it('a queued team takes the space a freed module leaves', () => {
    const teams: TeamSpec[] = [];
    for (let i = 0; i < 40; i++) {
      const owner = 100 + i * 10;
      teams.push(team(owner, [[owner + 1, owner]]));
    }
    const a = composeLivingOffice(userRoom(), teams);
    const firstQueued = a.queued[0];
    const b = composeLivingOffice(userRoom(), teams.slice(1), a);
    expect(b.modules.some((m) => m.ownerId === firstQueued)).toBe(true);
  });

  it('a user layout as wide as the grid leaves no room: every team is queued', () => {
    const o = composeLivingOffice(userRoom(MAX_COLS, 12), [team(10, [[11, 10]])]);
    expect(o.modules).toEqual([]);
    expect(o.queued).toEqual([10]);
    expect(o.layout.cols).toBe(MAX_COLS);
    assertGrid(o);
  });

  it('the biggest possible team fits', () => {
    const members: Array<[number, number]> = [];
    for (let id = 11; id < 11 + scopeLayoutCapacity() + 20; id++) members.push([id, 10]);
    const o = composeLivingOffice(userRoom(), [team(10, members)]);
    assertGrid(o);
    expect(o.modules).toHaveLength(1);
    expect(o.modules[0].seatByAgent.size).toBe(scopeLayoutCapacity());
  });

  it('survives a malformed user layout (short tiles, missing colors, odd sizes)', () => {
    const bad = { version: 1, cols: 5, rows: 5, tiles: [W, F], furniture: [] } as OfficeLayout;
    const o = composeLivingOffice(bad, [team(10, [[11, 10]])]);
    assertGrid(o);
  });
});

// ── (g) rest seats are never desks ──────────────────────────────────────────

describe('composeLivingOffice — (g) rest seats', () => {
  it('lounge seats never overlap desk seats, and every sofa/beanbag is a lounge seat', () => {
    const user = userRoom(12, 10, [
      { uid: 'u-sofa', type: 'SOFA_FRONT', col: 7, row: 6 },
      { uid: 'u-bean', type: LIVING_ASSET_TYPES.beanbag, col: 9, row: 3 },
    ]);
    const o = composeLivingOffice(user, [
      team(10, [
        [11, 10],
        [12, 11],
      ]),
      team(20, [[21, 20]]),
    ]);
    const desks = seatUids(o);
    for (const s of o.loungeSeats) expect(desks.has(s)).toBe(false);
    for (const s of ['u-sofa', 'u-sofa:1', 'u-bean']) expect(o.loungeSeats).toContain(s);
    expect(o.loungeSeats).not.toContain('u-chair');
    expect(new Set(o.loungeSeats).size).toBe(o.loungeSeats.length);
  });
});

// ── Labels ──────────────────────────────────────────────────────────────────

describe('module labels', () => {
  it('strips control, bidi and zero-width characters and collapses whitespace', () => {
    expect(sanitizeModuleLabel('  Fase\n1\t·‮ Auth​  ')).toBe('Fase 1 · Auth');
    expect(sanitizeModuleLabel('\u0000\u0007')).toBe('');
    expect(sanitizeModuleLabel(42 as unknown as string)).toBe('');
  });

  it('truncates long labels by code point, without splitting a surrogate pair', () => {
    const long = '😀'.repeat(200);
    const out = sanitizeModuleLabel(long);
    expect([...out].length).toBeLessThanOrEqual(MODULE_LABEL_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('caps stacked combining marks', () => {
    const zalgo = 'a' + '́'.repeat(500) + 'b';
    expect([...sanitizeModuleLabel(zalgo)].length).toBeLessThanOrEqual(5);
  });

  it('falls back to #owner, keeps labels distinct, and never takes the lounge name', () => {
    const user = userRoom();
    user.areas = [{ label: 'Mine', color: AREA_DEFAULT_COLORS[0] }];
    user.areaTiles = user.tiles.map(() => null);
    const o = composeLivingOffice(user, [
      team(10, [[11, 10]], '​'),
      team(20, [[21, 20]], 'Mine'),
      team(30, [[31, 30]], 'Same'),
      team(40, [[41, 40]], 'Same'),
      team(50, [[51, 50]], LOUNGE_AREA_LABEL),
      team(60, [[61, 60]], '__proto__'),
    ]);
    const labels = o.modules.map((m) => m.label);
    expect(labels[0]).toBe('#10');
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).not.toContain('Mine');
    expect(labels).not.toContain(LOUNGE_AREA_LABEL);
    expect(labels).toContain('Same');
    expect(labels).toContain('__proto__');
    // The user lounge was not "found" in a team module labeled Descanso.
    expect(o.layout.furniture.some((f) => f.type === LIVING_ASSET_TYPES.arcade)).toBe(true);
    assertGrid(o);
  });
});

// ── teamsFromDirectory ──────────────────────────────────────────────────────

describe('teamsFromDirectory', () => {
  it('a team is a root’s direct child with children; its whole subtree, BFS order', () => {
    const d = new AgentDirectory();
    d.upsert(1, {});
    d.upsert(2, { parentAgentId: 1, label: 'Fase 1', role: 'lider' });
    d.upsert(3, { parentAgentId: 1, role: 'Explore' }); // loose: no children
    d.upsert(4, { parentAgentId: 2 });
    d.upsert(5, { parentAgentId: 2 });
    d.upsert(6, { parentAgentId: 4 });
    expect(teamsFromDirectory(d)).toEqual([
      {
        ownerId: 2,
        label: 'Fase 1',
        members: [
          { id: 4, parentId: 2 },
          { id: 5, parentId: 2 },
          { id: 6, parentId: 4 },
        ],
      },
    ]);
  });

  it('a loose child moves into a team once its first child is born', () => {
    const d = new AgentDirectory();
    d.upsert(1, {});
    d.upsert(2, { parentAgentId: 1, label: 'Dev' });
    expect(teamsFromDirectory(d)).toEqual([]);
    d.upsert(3, { parentAgentId: 2 });
    expect(teamsFromDirectory(d).map((t) => t.ownerId)).toEqual([2]);
  });

  it('workflow nodes are teams (even before their agents appear), labeled with ⚙', () => {
    const d = new AgentDirectory();
    d.upsert(1, {});
    d.upsert(2, { parentAgentId: 1, role: 'workflow', label: 'deploy' });
    d.upsert(3, { parentAgentId: 1, role: 'workflow' });
    expect(teamsFromDirectory(d).map((t) => [t.ownerId, t.label])).toEqual([
      [2, '⚙ deploy'],
      [3, '⚙ workflow'],
    ]);
  });

  it('falls back to role, then name, for the label', () => {
    const d = new AgentDirectory();
    d.upsert(1, {});
    d.upsert(2, { parentAgentId: 1, role: 'planner' });
    d.upsert(3, { parentAgentId: 2 });
    d.upsert(4, { parentAgentId: 1, agentName: 'ana' });
    d.upsert(5, { parentAgentId: 4 });
    expect(teamsFromDirectory(d).map((t) => t.label)).toEqual(['planner', 'ana']);
  });

  it('survives cycles, self-parents and orphans', () => {
    const d = new AgentDirectory();
    d.upsert(1, { parentAgentId: 2 });
    d.upsert(2, { parentAgentId: 1 }); // cycle: both are roots
    d.upsert(3, { parentAgentId: 3 }); // self-parent
    d.upsert(4, { parentAgentId: 99 }); // orphan root
    d.upsert(5, { parentAgentId: 4 });
    d.upsert(6, { parentAgentId: 5 });
    const teams = teamsFromDirectory(d);
    expect(teams.map((t) => t.ownerId)).toEqual([5]);
    expect(teams[0].members).toEqual([{ id: 6, parentId: 5 }]);
  });

  it('caps a team at the seats a module has', () => {
    const d = new AgentDirectory();
    d.upsert(1, {});
    d.upsert(2, { parentAgentId: 1 });
    for (let id = 3; id < 3 + 500; id++) d.upsert(id, { parentAgentId: 2 });
    const [t] = teamsFromDirectory(d);
    expect(t.members.length).toBe(scopeLayoutCapacity() - 1);
  });

  it('composes end to end from a directory', () => {
    const d = new AgentDirectory();
    d.upsert(1, {});
    d.upsert(2, { parentAgentId: 1, label: 'Fase 1' });
    d.upsert(3, { parentAgentId: 2 });
    d.upsert(4, { parentAgentId: 3 });
    const o = composeLivingOffice(userRoom(), teamsFromDirectory(d));
    expect([...o.modules[0].seatByAgent.keys()].sort()).toEqual([2, 3, 4]);
    assertReachable(o);
  });
});

// ── The bundled default layout ──────────────────────────────────────────────

describe('composeLivingOffice — the bundled default layout', () => {
  it('composes a reachable office around the shipped default layout', () => {
    const file = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../public/assets/default-layout-1.json',
    );
    const user = JSON.parse(fs.readFileSync(file, 'utf8')) as OfficeLayout;
    const teams = [
      team(10, [
        [11, 10],
        [12, 10],
        [13, 11],
        [14, 11],
        [15, 12],
      ]),
      team(20, [[21, 20]]),
      team(30, [
        [31, 30],
        [32, 30],
      ]),
    ];
    const o = composeLivingOffice(user, teams);
    assertGrid(o);
    expect(o.queued).toEqual([]);
    // Default layout has sofas: they are rest seats.
    const sofas = user.furniture.filter((f) => f.type.startsWith('SOFA_'));
    expect(sofas.length).toBeGreaterThan(0);
    for (const s of sofas) expect(o.loungeSeats).toContain(s.uid);
    assertReachable(o);
  });
});

// ── T20 asset ids ───────────────────────────────────────────────────────────

describe('living-office asset ids', () => {
  const t20Landed = ['DOOR', 'ARCADE', 'GAME_CONSOLE', 'BEANBAG'].every((d) =>
    fs.existsSync(path.join(FURNITURE_ROOT, d, 'manifest.json')),
  );
  it.skipIf(!t20Landed)('match the bundled manifests', () => {
    const ids = new Set(
      ['DOOR', 'ARCADE', 'GAME_CONSOLE', 'BEANBAG', 'COFFEE', 'SMALL_TABLE'].flatMap((d) => {
        const text = fs.readFileSync(path.join(FURNITURE_ROOT, d, 'manifest.json'), 'utf8');
        return [...text.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
      }),
    );
    for (const id of Object.values(LIVING_ASSET_TYPES)) expect(ids.has(id), id).toBe(true);
  });
});

// ── Hardening (pentest) ─────────────────────────────────────────────────────

describe('composeLivingOffice — hostile input', () => {
  it('stays fast when the lounge cannot fit and there are hundreds of teams', () => {
    const teams: TeamSpec[] = [];
    for (let i = 0; i < 400; i++) {
      const owner = 1000 + i * 100;
      const members: Array<[number, number]> = [];
      for (let j = 1; j <= 40; j++) members.push([owner + j, owner]);
      teams.push(team(owner, members));
    }
    for (const cols of [12, 50]) {
      const t0 = Date.now();
      const o = composeLivingOffice(userRoom(cols, 10), teams);
      const again = composeLivingOffice(userRoom(cols, 10), teams, o);
      expect(Date.now() - t0).toBeLessThan(1500);
      assertGrid(again);
    }
  });

  it('labels that only look alike (case, compatibility forms) still get a distinct name', () => {
    const o = composeLivingOffice(userRoom(), [
      team(10, [[11, 10]], 'descanso'),
      team(20, [[21, 20]], 'Ｄｅｓｃａｎｓｏ'),
      team(30, [[31, 30]], 'Alpha'),
      team(40, [[41, 40]], 'ALPHA'),
    ]);
    const labels = o.modules.map((m) => m.label);
    expect(labels[0]).toBe('descanso #10');
    expect(labels[1]).toBe('Ｄｅｓｃａｎｓｏ #20');
    expect(labels[2]).toBe('Alpha');
    expect(labels[3]).toBe('ALPHA #40');
  });

  it('invisible or lone-surrogate labels fall back to #owner', () => {
    expect(sanitizeModuleLabel('ㅤ⠀ ᅟ')).toBe('');
    expect(sanitizeModuleLabel('\uD800x')).toBe('x');
    const o = composeLivingOffice(userRoom(), [team(10, [[11, 10]], 'ㅤㅤ')]);
    expect(o.modules[0].label).toBe('#10');
  });

  it('ignores user furniture outside the user grid (no door or seat inside a module)', () => {
    const user = userRoom(12, 10, [
      { uid: 'far-door', type: LIVING_ASSET_TYPES.doorClosed, col: 40, row: 3 },
      { uid: 'far-chair', type: 'CUSHIONED_CHAIR_BACK', col: 30, row: 12 },
    ]);
    const o = composeLivingOffice(user, [team(10, [[11, 10]])]);
    expect(o.door.uid).not.toBe('far-door');
    expect(o.door.col).toBeLessThan(user.cols);
    expect(o.layout.furniture.some((f) => f.uid.startsWith('far-'))).toBe(false);
  });

  it('does not throw on a malformed user layout or previous composition', () => {
    const junkUsers = [null, {}, { cols: 5, rows: 5 }, { cols: 'x', tiles: 'y', furniture: {} }];
    for (const u of junkUsers) {
      const o = composeLivingOffice(u as unknown as OfficeLayout, [team(10, [[11, 10]])]);
      assertGrid(o);
    }
    const junkPrev = [
      {
        modules: [null, { ownerId: 10, col: 1, row: 1, seatByAgent: {} }],
        layout: { furniture: 3 },
      },
      { modules: 'x', userCols: 'y' },
      42,
    ];
    for (const p of junkPrev) {
      const o = composeLivingOffice(
        userRoom(),
        [team(10, [[11, 10]])],
        p as unknown as LivingOffice,
      );
      assertGrid(o);
    }
  });
});

// ── QA regressions ──────────────────────────────────────────────────────────

describe('composeLivingOffice — growth and shrink stability', () => {
  const four = (tenMembers: Array<[number, number]>) => [
    team(10, tenMembers),
    team(20, [[21, 20]]),
    team(30, [[31, 30]]),
    team(40, [[41, 40]]),
  ];

  it('a module growing a band only pushes down what is below it in its own column', () => {
    const user = userRoom();
    const a = composeLivingOffice(user, four([[11, 10]]));
    const b = composeLivingOffice(
      user,
      four([
        [11, 10],
        [12, 10],
        [13, 10],
      ]),
      a,
    );
    const grown = b.modules.find((m) => m.ownerId === 10)!;
    expect(grown.rows).toBeGreaterThan(a.modules.find((m) => m.ownerId === 10)!.rows);
    for (const prev of a.modules) {
      const next = b.modules.find((m) => m.ownerId === prev.ownerId)!;
      expect(next.col, `owner ${prev.ownerId}`).toBe(prev.col);
      for (const [id, uid] of prev.seatByAgent) expect(next.seatByAgent.get(id)).toBe(uid);
      if (prev.col !== grown.col || prev.row < grown.row) expect(next.row).toBe(prev.row);
      else if (prev.ownerId !== 10) expect(next.row).toBeGreaterThan(prev.row);
    }
    assertGrid(b);
    assertReachable(b);
  });

  it('a module shrinking (its last band leaves) never changes another module’s column', () => {
    const user = userRoom();
    const a = composeLivingOffice(
      user,
      four([
        [11, 10],
        [12, 10],
        [13, 10],
      ]),
    );
    const b = composeLivingOffice(
      user,
      four([
        [11, 10],
        [12, 10],
      ]),
      a,
    );
    for (const prev of a.modules) {
      const next = b.modules.find((m) => m.ownerId === prev.ownerId)!;
      expect(next.col).toBe(prev.col);
      expect(next.row).toBeLessThanOrEqual(prev.row);
    }
    assertReachable(b);
  });

  it('keeps a disambiguated label when its namesake leaves', () => {
    const a = composeLivingOffice(userRoom(), [
      team(10, [[11, 10]], 'Same'),
      team(20, [[21, 20]], 'Same'),
    ]);
    expect(a.modules[1].label).toBe('Same #20');
    const b = composeLivingOffice(userRoom(), [team(20, [[21, 20]], 'Same')], a);
    expect(b.modules[0].label).toBe('Same #20');
    // …but follows a renamed team.
    const c = composeLivingOffice(userRoom(), [team(20, [[21, 20]], 'Other')], b);
    expect(c.modules[0].label).toBe('Other');
  });
});

describe('composeLivingOffice — entrance edge cases', () => {
  /** 16×10 with a sealed top-right room (cols 10-14, rows 2-4): its floor reaches
   *  the east wall on the lowest rows, but nothing connects it to the hall. */
  function twoRooms(extra: PlacedFurniture[] = []): OfficeLayout {
    const l = userRoom(16, 10, extra);
    for (let r = 1; r <= 5; r++) l.tiles[r * 16 + 9] = W;
    for (let c = 9; c < 16; c++) l.tiles[5 * 16 + c] = W;
    return l;
  }

  it('opens the passage from the side of the room the door is in', () => {
    const o = composeLivingOffice(twoRooms(), [team(10, [[11, 10]])]);
    expect(o.door.col).toBeLessThan(9);
    expect(o.door.row).toBeLessThan(5);
    assertReachable(o);
  });

  it('with the user’s door in a room that cannot reach the east edge, everything is still reachable from somewhere sensible', () => {
    const l = twoRooms([{ uid: 'my-door', type: LIVING_ASSET_TYPES.doorClosed, col: 3, row: 0 }]);
    // Seal the left hall off from the east by the interior wall: the user's door stays theirs.
    const o = composeLivingOffice(l, [team(10, [[11, 10]])]);
    expect(o.door.uid).toBe('my-door');
    assertGrid(o);
  });

  it('ignores a user door whose front tile is not walkable floor', () => {
    const user = userRoom(12, 10, [
      { uid: 'side-door', type: LIVING_ASSET_TYPES.doorClosed, col: 11, row: 3 },
    ]);
    const o = composeLivingOffice(user, [team(10, [[11, 10]])]);
    expect(o.door.uid).not.toBe('side-door');
    expect(tileAt(o.layout, o.door.col, o.door.row)).toBe(F);
    assertReachable(o);
  });

  it('a seatless "Descanso" Area does not suppress the generated lounge', () => {
    const user = userRoom();
    user.areas = [{ label: LOUNGE_AREA_LABEL, color: AREA_DEFAULT_COLORS[0] }];
    user.areaTiles = user.tiles.map((_, i) => (i === 3 * 12 + 8 ? LOUNGE_AREA_LABEL : null));
    const o = composeLivingOffice(user, [team(10, [[11, 10]])]);
    expect(o.loungeSeats.length).toBe(3);
    assertGrid(o);
    assertReachable(o);
  });

  it('puts the lounge coffee on a table (it is a surface item)', () => {
    const o = composeLivingOffice(userRoom(), []);
    const coffee = o.layout.furniture.find((f) => f.type === LIVING_ASSET_TYPES.coffee)!;
    const table = o.layout.furniture.find((f) => f.type === LIVING_ASSET_TYPES.smallTable)!;
    const e = getCatalogEntry(table.type)!;
    expect(e.isDesk).toBe(true);
    expect(coffee.col - table.col).toBeGreaterThanOrEqual(0);
    expect(coffee.col - table.col).toBeLessThan(e.footprintW);
    expect(coffee.row - table.row).toBeGreaterThanOrEqual(0);
    expect(coffee.row - table.row).toBeLessThan(e.footprintH);
  });
});
