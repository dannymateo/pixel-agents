/**
 * Which agent a monitor belongs to — the "click the monitor" entry to the
 * agent screen (spec §4). DOM-free and catalog-free (the footprint lookup is
 * passed in), so it runs under the Node test runner.
 *
 * A monitor (`PC_*` furniture) belongs to the seat whose facing region it sits
 * in — the same region auto-state uses to switch a seated agent's electronics
 * on: straight ahead up to AUTO_ON_FACING_DEPTH tiles, one tile to each side
 * up to AUTO_ON_SIDE_DEPTH. When several seats reach it (desks side by side),
 * the nearest wins — straight ahead before diagonal — whether or not that seat
 * is taken: a monitor in front of an EMPTY desk never opens the neighbour's
 * screen. The owner is whoever sits in that seat.
 */

import { AUTO_ON_FACING_DEPTH, AUTO_ON_SIDE_DEPTH, MONITOR_TYPE_PREFIX } from '../../constants.js';
import type { PlacedFurniture, Seat } from '../types.js';
import { Direction } from '../types.js';

export type FootprintOf = (type: string) => { w: number; h: number } | undefined;

export function isMonitorType(type: string): boolean {
  return type.startsWith(MONITOR_TYPE_PREFIX);
}

/** The monitor whose footprint covers (col, row), topmost first. */
export function monitorAt(
  furniture: readonly PlacedFurniture[],
  col: number,
  row: number,
  footprintOf: FootprintOf,
): PlacedFurniture | null {
  for (let i = furniture.length - 1; i >= 0; i--) {
    const f = furniture[i];
    if (!isMonitorType(f.type)) continue;
    const fp = footprintOf(f.type);
    if (!fp) continue;
    if (col >= f.col && col < f.col + fp.w && row >= f.row && row < f.row + fp.h) return f;
  }
  return null;
}

/** How far a tile is from a seat inside its facing region (lower = closer),
 *  or null when the tile is outside it. */
function facingScore(seat: Seat, col: number, row: number): number | null {
  const dCol = seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0;
  const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0;
  const relCol = col - seat.seatCol;
  const relRow = row - seat.seatRow;
  // Depth along the facing direction, lateral offset across it.
  const depth = relCol * dCol + relRow * dRow;
  const lateral = Math.abs(dCol !== 0 ? relRow : relCol);
  if (depth < 1) return null;
  if (lateral === 0 && depth <= AUTO_ON_FACING_DEPTH) return depth * 2;
  if (lateral === 1 && depth <= AUTO_ON_SIDE_DEPTH) return depth * 2 + 1;
  return null;
}

/** The seat a monitor belongs to: the nearest seat whose facing region holds
 *  any tile of its footprint. */
export function monitorSeat(
  monitor: PlacedFurniture,
  seats: Iterable<Seat>,
  footprintOf: FootprintOf,
): Seat | null {
  const fp = footprintOf(monitor.type);
  if (!fp) return null;
  let best: Seat | null = null;
  let bestScore = Infinity;
  for (const seat of seats) {
    for (let r = monitor.row; r < monitor.row + fp.h; r++) {
      for (let c = monitor.col; c < monitor.col + fp.w; c++) {
        const score = facingScore(seat, c, r);
        if (score !== null && score < bestScore) {
          bestScore = score;
          best = seat;
        }
      }
    }
  }
  return best;
}

/**
 * The agent whose monitor covers (col, row), or null — no monitor there, the
 * monitor belongs to no seat, or its seat is empty.
 * `occupantOf(seatId)` = the id of the character sitting in that seat.
 */
export function monitorOwnerAt(
  col: number,
  row: number,
  furniture: readonly PlacedFurniture[],
  seats: Iterable<Seat>,
  occupantOf: (seatId: string) => number | null,
  footprintOf: FootprintOf,
): number | null {
  const monitor = monitorAt(furniture, col, row, footprintOf);
  if (!monitor) return null;
  const seat = monitorSeat(monitor, seats, footprintOf);
  return seat ? occupantOf(seat.uid) : null;
}
