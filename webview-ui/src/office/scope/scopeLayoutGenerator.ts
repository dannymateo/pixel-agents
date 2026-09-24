import { MAX_ROWS, SCOPE_SLOT_H, SCOPE_SLOT_W, SCOPE_SLOTS_PER_ROW } from '../../constants.js';
import type { OfficeLayout, PlacedFurniture, TileType as TileTypeVal } from '../types.js';
import { TileType } from '../types.js';

/** Asset type ids of one workstation. The geometry assumes the default kit's
 *  footprints: a 3×2 front desk, a 1-wide monitor on its middle column, a 1×1
 *  chair. */
export interface ScopeFurnitureKit {
  desk: string;
  chair: string;
  monitor: string;
}

/**
 * The bundled default layout's workstation (DESK_FRONT + PC_FRONT_OFF on its
 * middle column), with a back-facing chair right under the desk: layoutToSeats
 * turns chair orientation "back" into Direction.UP, so the sitter faces the desk
 * and the chair back renders in front of them.
 */
export const DEFAULT_SCOPE_KIT: ScopeFurnitureKit = {
  desk: 'DESK_FRONT',
  chair: 'CUSHIONED_CHAIR_BACK',
  monitor: 'PC_FRONT_OFF',
};

// Room geometry, in tiles. Local to this generator: they only mean something
// together with the slot constants and the kit footprints above.
/** Wall column on each side. */
const SIDE_WALL = 1;
/** Top wall row plus one free row in front of it. */
const TOP_MARGIN = 2;
/** Free row below the last workstation band. */
const BOTTOM_MARGIN = 1;
/** Monitor and chair sit on the desk's middle column. */
const MIDDLE_COL = 1;
/** Chair row = desk row + desk footprint height. */
const CHAIR_ROW_OFFSET = 2;

/** Child bands that fit under the owner's band without exceeding MAX_ROWS. */
const MAX_CHILD_BANDS = Math.floor((MAX_ROWS - TOP_MARGIN - BOTTOM_MARGIN) / SCOPE_SLOT_H) - 1;

/** Most workstations a scope office can hold (owner + children). Members past
 *  it get no workstation; the room never outgrows the editor grid limits. */
export function scopeLayoutCapacity(): number {
  return 1 + MAX_CHILD_BANDS * SCOPE_SLOTS_PER_ROW;
}

/** Normalizes any count to an integer in [1, capacity] — total, even for a
 *  non-number that slipped past the types (wire data): unusable → 1 workstation. */
function clampMemberCount(memberCount: number): number {
  const n = typeof memberCount === 'number' ? Math.floor(memberCount) : Number.NaN;
  if (Number.isNaN(n)) return 1;
  return Math.min(scopeLayoutCapacity(), Math.max(1, n));
}

/** Slot 0 is the scope owner's (top band); slots 1.. are children, filled
 *  row-major below it. Slot positions depend only on the slot index and the
 *  row width, so growing the room never moves an existing workstation. */
export function generateScopeLayout(memberCount: number, kit: ScopeFurnitureKit): OfficeLayout {
  const count = clampMemberCount(memberCount);
  const perRow = SCOPE_SLOTS_PER_ROW;
  const childBands = Math.ceil((count - 1) / perRow);
  const cols = 2 * SIDE_WALL + perRow * SCOPE_SLOT_W;
  const rows = TOP_MARGIN + (1 + childBands) * SCOPE_SLOT_H + BOTTOM_MARGIN;

  const tiles: TileTypeVal[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const wall = r === 0 || c < SIDE_WALL || c >= cols - SIDE_WALL;
      tiles.push(wall ? TileType.WALL : TileType.FLOOR_1);
    }
  }

  const furniture: PlacedFurniture[] = [];
  const place = (slot: number, col: number, row: number): void => {
    furniture.push({ uid: `scope-desk-${slot}`, type: kit.desk, col, row });
    furniture.push({ uid: `scope-pc-${slot}`, type: kit.monitor, col: col + MIDDLE_COL, row });
    furniture.push({
      uid: `scope-chair-${slot}`,
      type: kit.chair,
      col: col + MIDDLE_COL,
      row: row + CHAIR_ROW_OFFSET,
    });
  };

  place(0, SIDE_WALL + Math.floor((perRow - 1) / 2) * SCOPE_SLOT_W, TOP_MARGIN);
  for (let i = 1; i < count; i++) {
    const k = i - 1;
    place(
      i,
      SIDE_WALL + (k % perRow) * SCOPE_SLOT_W,
      TOP_MARGIN + (1 + Math.floor(k / perRow)) * SCOPE_SLOT_H,
    );
  }

  return { version: 1, cols, rows, tiles, furniture, pets: [] };
}
