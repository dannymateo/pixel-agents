import { pickDiversePalette } from '../../../../core/src/paletteUtils.js';
import {
  AUTO_ON_FACING_DEPTH,
  AUTO_ON_SIDE_DEPTH,
  CHARACTER_HIT_HALF_WIDTH,
  CHARACTER_HIT_HEIGHT,
  CHARACTER_SITTING_OFFSET_PX,
  CONVERSATION_ENVELOPE_SEC,
  CONVERSATION_SPOT_MAX_DIST,
  CONVERSATION_TALK_HOLD_MAX_MS,
  DISMISS_BUBBLE_FAST_FADE_SEC,
  DOOR_OPEN_HOLD_MS,
  FURNITURE_ANIM_INTERVAL_SEC,
  GOODBYE_BUBBLE_MS,
  GREETER_ID,
  GREETER_TILE_MARGIN,
  INACTIVE_SEAT_TIMER_MIN_SEC,
  INACTIVE_SEAT_TIMER_RANGE_SEC,
  LEISURE_ELECTRONICS_GROUPS,
  MATRIX_EFFECT_DURATION_SEC,
  MAX_PET_ID_LENGTH,
  PET_HIT_HALF_WIDTH,
  PET_HIT_HEIGHT,
  WAITING_BUBBLE_DURATION_SEC,
} from '../../constants.js';
import {
  getAnimationFrames,
  getCatalogEntry,
  getOnStateType,
  getOpenStateType,
} from '../layout/furnitureCatalog.js';
import {
  createDefaultLayout,
  getBlockedTiles,
  layoutToFurnitureInstances,
  layoutToSeats,
  layoutToTileMap,
} from '../layout/layoutSerializer.js';
import { findPath, getWalkableTiles, isWalkable } from '../layout/tileMap.js';
import { getPetCount, getPetName } from '../sprites/petSpriteData.js';
import { getLoadedCharacterCount } from '../sprites/spriteData.js';
import type {
  Character,
  FurnitureInstance,
  OfficeLayout,
  Pet,
  PlacedFurniture,
  PlacedPet,
  Seat,
  TileType as TileTypeVal,
} from '../types.js';
import { CharacterState, Direction, PetState, TILE_SIZE } from '../types.js';
import { createCharacter, updateCharacter } from './characters.js';
import type { SceneHost } from './conversationScene.js';
import { advanceMatrixEffect, startMatrixEffect } from './matrixEffectState.js';
import { createPet, updatePet } from './petEntity.js';
import { anchorTile, closestFreeSeat } from './seatPlacement.js';

/** Presence as the server broadcasts it (core AgentPresence). */
export type LivingPresence = 'working' | 'available' | 'lounge' | 'leaving';

/** Where the living office's lifecycle scenes happen — the `door` and
 *  `loungeSeats` of a composed LivingOffice (office/living/composeOffice.ts). */
export interface LivingTargets {
  /** The floor tile in front of the door (the walk target), and the door
   *  furniture's uid (the item that swaps to its open variant). */
  door: { col: number; row: number; uid: string };
  /** Seat uids that are rest seats. Never handed out as desks. */
  loungeSeats: string[];
}

/**
 * One lifecycle scene steering a character (docs/adr/0003). While a scene is
 * live the character is `scripted`: the FSM only walks the path it was given,
 * and OfficeState decides what happens on arrival.
 *
 *   enter:  door tile → own seat, then back to the FSM.
 *   lounge: desk → a free rest seat (or beside the lounge), then rests there.
 *   return: wherever → own seat, then back to the FSM.
 *   leave:  → door tile, goodbye bubble, fade out, deleted, onGone.
 *   talk:   → a free tile beside another agent's desk, then stands there
 *           (`hold`) until the conversation director sends it back
 *           (returnToSeat → a `return` scene, or back to the lounge).
 */
interface LifecycleScene {
  kind: 'enter' | 'lounge' | 'return' | 'leave' | 'talk';
  phase: 'walk' | 'rest' | 'goodbye' | 'exit' | 'hold';
  /** Seconds left in the goodbye / exit phase; seconds spent holding (talk). */
  timer: number;
  /** The rest seat this character holds (lounge scene only). */
  loungeSeat: string | null;
  /** talk only: the listener, and the tile the speaker stands on. */
  partnerId?: number;
  target?: { col: number; row: number };
}

/** The direction to face from (fc,fr) to look at (tc,tr): the dominant axis,
 *  horizontal on a tie. */
function directionToward(fc: number, fr: number, tc: number, tr: number): Direction {
  const dc = tc - fc;
  const dr = tr - fr;
  if (dc === 0 && dr === 0) return Direction.DOWN;
  if (Math.abs(dc) >= Math.abs(dr)) return dc > 0 ? Direction.RIGHT : Direction.LEFT;
  return dr > 0 ? Direction.DOWN : Direction.UP;
}

/**
 * The open variant of a door type: its catalog `closed`→`open` pair (the
 * bundled DOOR), else an `off`→`on` pair (a custom door drawn with the
 * electronics convention). Returns the type unchanged when there is no open
 * variant, so an unknown door simply never swaps.
 */
function openDoorType(type: string): string {
  const open = getOpenStateType(type);
  return open !== type ? open : getOnStateType(type);
}

/** Electronics that are play, not work (the lounge's arcade and console):
 *  never a "PC seat", never switched on by a working agent's auto-state. */
function isLeisureElectronics(type: string): boolean {
  const base = type.split(':')[0];
  for (const group of LEISURE_ELECTRONICS_GROUPS) {
    if (base === group || base.startsWith(`${group}_`)) return true;
  }
  return false;
}

/** Internal helper: facing-tile coords for a seat. Returns null for invalid direction. */
function seatFacingOffset(direction: Direction): { dCol: number; dRow: number } {
  if (direction === Direction.RIGHT) return { dCol: 1, dRow: 0 };
  if (direction === Direction.LEFT) return { dCol: -1, dRow: 0 };
  if (direction === Direction.DOWN) return { dCol: 0, dRow: 1 };
  return { dCol: 0, dRow: -1 };
}

export class OfficeState implements SceneHost {
  layout: OfficeLayout;
  tileMap: TileTypeVal[][];
  seats: Map<string, Seat>;
  blockedTiles: Set<string>;
  furniture: FurnitureInstance[];
  walkableTiles: Array<{ col: number; row: number }>;
  characters: Map<number, Character> = new Map();
  pets: Pet[] = [];
  /** Accumulated time for furniture animation frame cycling */
  furnitureAnimTimer = 0;
  selectedAgentId: number | null = null;
  cameraFollowId: number | null = null;
  hoveredAgentId: number | null = null;
  hoveredTile: { col: number; row: number } | null = null;
  /** Maps "parentId:toolId" → sub-agent character ID (negative) */
  subagentIdMap: Map<string, number> = new Map();
  /** Reverse lookup: sub-agent character ID → parent info */
  subagentMeta: Map<number, { parentAgentId: number; parentToolId: string }> = new Map();
  private nextSubagentId = -1;

  /**
   * folderName → list of Area labels that workspace folder belongs to.
   * Populated by useExtensionMessages on `areaMappingsLoaded`. Consulted by
   * `findFreeSeat()` to bias new agents toward seats inside their folder's Area.
   */
  areaMappings: Record<string, string[]> = {};

  /**
   * The first-run consent greeter, deliberately NOT in `characters`.
   *
   * `characters` means "agents": everything that iterates it — seat
   * assignment, palette diversity, the wander FSM, hit-testing, the seat
   * payload the webview persists — is asking an agent question the greeter has
   * no answer to. Holding it here instead of tagging it with a flag makes
   * every one of those loops correct by default, rather than correct as long
   * as each remembers an `isGreeter` guard. It is drawn because
   * `getCharacters()` appends it, and that is the only place it joins the
   * others.
   */
  greeter: Character | null = null;

  /** World-space point the camera drifts to while the greeter is up
   *  (the bubble overlay recomputes it every frame: the combined center of the
   *  character and its speech bubble). An explicit cameraFollowId outranks it. */
  greeterCameraTarget: { x: number; y: number } | null = null;
  /** Latched by a manual pan during the ask: the user took the camera, so the
   *  overlay's per-frame updates stop re-centering. Reset on spawn/despawn. */
  private greeterCameraCancelled = false;

  // ── Living office (docs/adr/0003) ──
  /** Door + rest seats of the composed office; null until S8 wires them. */
  private livingTargets: LivingTargets | null = null;
  private loungeSeatSet: Set<string> = new Set();
  /** Live lifecycle scenes, by character id. */
  private scenes: Map<number, LifecycleScene> = new Map();
  /** Callbacks to fire once a leaving character is actually gone. */
  private goneCallbacks: Map<number, Array<() => void>> = new Map();
  /** Seconds the door stays open after its tile was last occupied. */
  private doorHoldTimer = 0;
  private doorOpen = false;
  /** Area labels the composition added (team modules, the generated lounge):
   *  drawn even with Show Areas off — they name the teams. */
  livingAreaLabels: ReadonlySet<string> = new Set();
  /** Furniture uids the living office composed (module chairs, lounge seats):
   *  their seats are the composition's to hand out, never a user-office desk.
   *  The exact set, not a uid prefix — a user's own `living-…` uid stays theirs. */
  private composedUids: ReadonlySet<string> = new Set();
  /** Characters no rebuild may hand a seat to: module members while the editor
   *  shows only the user's layout (their desks come back when it closes). */
  private seatlessHold: ReadonlySet<number> = new Set();

  setAreaMappings(mappings: Record<string, string[]>): void {
    this.areaMappings = mappings;
  }

  constructor(layout?: OfficeLayout) {
    this.layout = layout || createDefaultLayout();
    this.tileMap = layoutToTileMap(this.layout);
    this.seats = layoutToSeats(this.layout.furniture);
    this.blockedTiles = getBlockedTiles(this.layout.furniture);
    this.furniture = layoutToFurnitureInstances(this.layout.furniture);
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);
    // Pets are built last because they need walkableTiles populated for spawn.
    this.rebuildPetsFromLayout(this.layout);
  }

  /** Rebuild all derived state from a new layout. Reassigns existing characters.
   *  @param shift Optional pixel shift to apply when grid expands left/up
   *  @param opts.preservePositions Nobody is snapped: characters stay where they
   *    stand and walk to a seat that changed (the living office recomposes this
   *    way on every tree change — a snap would teleport everyone wandering).
   *  Characters in `seatlessHold` are never handed a new seat here. */
  rebuildFromLayout(
    layout: OfficeLayout,
    shift?: { col: number; row: number },
    opts?: { preservePositions?: boolean },
  ): void {
    const preserve = opts?.preservePositions === true;
    this.layout = layout;
    this.tileMap = layoutToTileMap(layout);
    this.seats = layoutToSeats(layout.furniture);
    this.blockedTiles = getBlockedTiles(layout.furniture);
    this.rebuildFurnitureInstances();
    this.walkableTiles = getWalkableTiles(this.tileMap, this.blockedTiles);

    // Shift character positions when grid expands left/up
    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const ch of this.characters.values()) {
        ch.tileCol += shift.col;
        ch.tileRow += shift.row;
        ch.x += shift.col * TILE_SIZE;
        ch.y += shift.row * TILE_SIZE;
        // Clear path since tile coords changed
        ch.path = [];
        ch.moveProgress = 0;
      }
    }

    // Shift pet positions when grid expands left/up
    if (shift && (shift.col !== 0 || shift.row !== 0)) {
      for (const pet of this.pets) {
        pet.tileCol += shift.col;
        pet.tileRow += shift.row;
        pet.x += shift.col * TILE_SIZE;
        pet.y += shift.row * TILE_SIZE;
        pet.path = [];
        pet.moveProgress = 0;
      }
    }

    // Reassign characters to new seats, preserving existing assignments when possible
    for (const seat of this.seats.values()) {
      seat.assigned = false;
    }

    // Rest seats held by lounge scenes stay held when they survived the rebuild.
    for (const scene of this.scenes.values()) {
      if (!scene.loungeSeat) continue;
      const seat = this.seats.get(scene.loungeSeat);
      if (seat && this.loungeSeatSet.has(scene.loungeSeat)) {
        seat.assigned = true;
      } else {
        // Lost its rest seat: replanScenes() sends it looking for another.
        scene.loungeSeat = null;
        scene.phase = 'walk';
      }
    }

    // First pass: try to keep characters at their existing seats
    for (const ch of this.characters.values()) {
      const scene = this.scenes.get(ch.id);
      if (scene) {
        // Mid-scene characters keep their seat but are NOT snapped onto it —
        // that would teleport someone walking in, resting, or leaving.
        // replanScenes() below re-routes them from where they stand.
        if (scene.kind === 'leave') continue; // a leaver has no seat any more
        const own = ch.seatId ? this.seats.get(ch.seatId) : undefined;
        if (own && !own.assigned) {
          own.assigned = true;
        } else {
          ch.seatId = null;
        }
        continue;
      }
      // A rest seat is kept too: setLivingTargets moves its sitter to a real
      // desk when there is one, and leaves it the sofa rather than none.
      if (ch.seatId && this.seats.has(ch.seatId)) {
        const seat = this.seats.get(ch.seatId)!;
        if (!seat.assigned) {
          seat.assigned = true;
          if (preserve) continue; // keeps its seat; stays where it stands
          // Snap character to seat position
          ch.tileCol = seat.seatCol;
          ch.tileRow = seat.seatRow;
          const cx = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
          const cy = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
          ch.x = cx;
          ch.y = cy;
          ch.dir = seat.facingDir;
          continue;
        }
      }
      ch.seatId = null; // will be reassigned below
    }

    // Second pass: assign remaining characters to free seats
    for (const ch of this.characters.values()) {
      if (ch.seatId) continue;
      if (this.seatlessHold.has(ch.id)) continue; // its desk is elsewhere, for later
      const scene = this.scenes.get(ch.id);
      if (scene?.kind === 'leave') continue;
      const seatId = this.findFreeSeat(ch.folderName);
      if (seatId && scene) {
        // Mid-scene: take the seat, keep walking (no snap).
        this.seats.get(seatId)!.assigned = true;
        ch.seatId = seatId;
        continue;
      }
      if (seatId && preserve) {
        // A new desk: walk there from where it stands (see preserveInPlace).
        this.seats.get(seatId)!.assigned = true;
        ch.seatId = seatId;
        continue;
      }
      if (seatId) {
        this.seats.get(seatId)!.assigned = true;
        ch.seatId = seatId;
        const seat = this.seats.get(seatId)!;
        ch.tileCol = seat.seatCol;
        ch.tileRow = seat.seatRow;
        ch.x = seat.seatCol * TILE_SIZE + TILE_SIZE / 2;
        ch.y = seat.seatRow * TILE_SIZE + TILE_SIZE / 2;
        ch.dir = seat.facingDir;
      }
    }

    if (preserve) this.settleInPlace();

    // Relocate any characters that ended up outside bounds or on non-walkable tiles
    for (const ch of this.characters.values()) {
      if (ch.seatId && !this.scenes.has(ch.id)) continue; // seated characters are fine
      if (
        ch.tileCol < 0 ||
        ch.tileCol >= layout.cols ||
        ch.tileRow < 0 ||
        ch.tileRow >= layout.rows
      ) {
        this.relocateCharacterToWalkable(ch);
      }
    }

    // Re-route every live scene from where its character now stands.
    this.replanScenes();

    // Relocate any pets that ended up outside bounds or on non-walkable tiles
    for (const pet of this.pets) {
      if (
        pet.tileCol < 0 ||
        pet.tileCol >= layout.cols ||
        pet.tileRow < 0 ||
        pet.tileRow >= layout.rows ||
        !isWalkable(pet.tileCol, pet.tileRow, this.tileMap, this.blockedTiles)
      ) {
        if (this.walkableTiles.length > 0) {
          const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)];
          pet.tileCol = spawn.col;
          pet.tileRow = spawn.row;
          pet.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
          pet.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
          pet.path = [];
          pet.moveProgress = 0;
          pet.state = PetState.IDLE;
          pet.frame = 0;
          pet.frameTimer = 0;
          pet.followTargetId = null;
        }
      }
    }

    // Reconcile pets against the layout roster (handles editor add/remove)
    this.rebuildPetsFromLayout(layout);
  }

  /**
   * preservePositions rebuild, for characters no scene steers: whoever stands
   * where the new layout has no floor steps to the nearest walkable tile; a
   * walk in progress is re-routed to its old destination (or stopped when that
   * is gone); a character typing off its seat — the seat moved — walks to it.
   */
  private settleInPlace(): void {
    for (const ch of this.characters.values()) {
      if (this.scenes.has(ch.id) || ch.matrixEffect === 'despawn') continue;
      const seat = ch.seatId ? this.seats.get(ch.seatId) : undefined;
      const onOwnSeat = !!seat && seat.seatCol === ch.tileCol && seat.seatRow === ch.tileRow;
      const inBounds =
        ch.tileRow >= 0 &&
        ch.tileRow < this.tileMap.length &&
        ch.tileCol >= 0 &&
        ch.tileCol < (this.tileMap[0]?.length ?? 0);
      if (
        !onOwnSeat &&
        (!inBounds || !isWalkable(ch.tileCol, ch.tileRow, this.tileMap, this.blockedTiles))
      ) {
        const spot = this.nearestWalkableTile(ch.tileCol, ch.tileRow);
        if (spot) this.placeAt(ch, spot.col, spot.row);
        if (ch.state === CharacterState.WALK) ch.state = CharacterState.IDLE;
      }
      if (ch.path.length > 0) {
        const dest = ch.path[ch.path.length - 1];
        const path = this.withOwnSeatUnblocked(ch, () =>
          findPath(ch.tileCol, ch.tileRow, dest.col, dest.row, this.tileMap, this.blockedTiles),
        );
        ch.path = path;
        ch.moveProgress = 0;
        if (path.length === 0) ch.state = CharacterState.IDLE;
        continue;
      }
      if (seat && !onOwnSeat && ch.state === CharacterState.TYPE) {
        const path = this.withOwnSeatUnblocked(ch, () =>
          findPath(
            ch.tileCol,
            ch.tileRow,
            seat.seatCol,
            seat.seatRow,
            this.tileMap,
            this.blockedTiles,
          ),
        );
        if (path.length > 0) this.startWalk(ch, path);
        else ch.state = CharacterState.IDLE;
      }
    }
  }

  /** Walkable tile closest (Manhattan) to (col,row), occupied or not. */
  private nearestWalkableTile(col: number, row: number): { col: number; row: number } | null {
    let best: { col: number; row: number } | null = null;
    let bestDist = Infinity;
    for (const tile of this.walkableTiles) {
      const d = Math.abs(tile.col - col) + Math.abs(tile.row - row);
      if (d < bestDist) {
        best = tile;
        bestDist = d;
      }
    }
    return best;
  }

  /** Move a character to a random walkable tile */
  private relocateCharacterToWalkable(ch: Character): void {
    if (this.walkableTiles.length === 0) return;
    const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)];
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.path = [];
    ch.moveProgress = 0;
  }

  getLayout(): OfficeLayout {
    return this.layout;
  }

  /** Get the blocked-tile key for a character's own seat, or null */
  private ownSeatKey(ch: Character): string | null {
    if (!ch.seatId) return null;
    const seat = this.seats.get(ch.seatId);
    if (!seat) return null;
    return `${seat.seatCol},${seat.seatRow}`;
  }

  /** Temporarily unblock a character's own seat, run fn, then re-block */
  private withOwnSeatUnblocked<T>(ch: Character, fn: () => T): T {
    const key = this.ownSeatKey(ch);
    if (key) this.blockedTiles.delete(key);
    const result = fn();
    if (key) this.blockedTiles.add(key);
    return result;
  }

  /** Collect every tile occupied by electronics furniture (PCs, monitors, etc.). */
  private buildElectronicsTileSet(): Set<string> {
    const out = new Set<string>();
    for (const item of this.layout.furniture) {
      const entry = getCatalogEntry(item.type);
      if (!entry || entry.category !== 'electronics') continue;
      if (isLeisureElectronics(item.type)) continue; // an arcade is nobody's PC
      for (let dr = 0; dr < entry.footprintH; dr++) {
        for (let dc = 0; dc < entry.footprintW; dc++) {
          out.add(`${item.col + dc},${item.row + dr}`);
        }
      }
    }
    return out;
  }

  /** Find the area label assigned to a seat's tile, or null. Public for e2e
   *  observability (getAgentSeats hook reads a seated agent's area). */
  seatZone(uid: string): string | null {
    const seat = this.seats.get(uid);
    if (!seat) return null;
    const tiles = this.layout.areaTiles;
    if (!tiles || tiles.length === 0) return null;
    const idx = seat.seatRow * this.layout.cols + seat.seatCol;
    if (idx < 0 || idx >= tiles.length) return null;
    return tiles[idx] ?? null;
  }

  /**
   * Does this seat face an electronics tile (PC, monitor)? Mirrors the
   * forward-and-flanking scan used by furniture auto-state.
   */
  private isSeatFacingElectronics(seat: Seat, electronicsTiles: Set<string>): boolean {
    const { dCol, dRow } = seatFacingOffset(seat.facingDir);
    for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
      const tileCol = seat.seatCol + dCol * d;
      const tileRow = seat.seatRow + dRow * d;
      if (electronicsTiles.has(`${tileCol},${tileRow}`)) return true;
      if (dCol !== 0) {
        if (
          electronicsTiles.has(`${tileCol},${tileRow - 1}`) ||
          electronicsTiles.has(`${tileCol},${tileRow + 1}`)
        ) {
          return true;
        }
      } else if (
        electronicsTiles.has(`${tileCol - 1},${tileRow}`) ||
        electronicsTiles.has(`${tileCol + 1},${tileRow}`)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Random-pick a seat from a candidate list, biased toward seats that face an
   * electronics tile. Returns null when the candidate list is empty.
   */
  private pickFromSeats(seatUids: string[], electronicsTiles: Set<string>): string | null {
    if (seatUids.length === 0) return null;
    const pcSeats: string[] = [];
    const otherSeats: string[] = [];
    for (const uid of seatUids) {
      const seat = this.seats.get(uid);
      if (!seat) continue;
      if (this.isSeatFacingElectronics(seat, electronicsTiles)) {
        pcSeats.push(uid);
      } else {
        otherSeats.push(uid);
      }
    }
    if (pcSeats.length > 0) return pcSeats[Math.floor(Math.random() * pcSeats.length)];
    if (otherSeats.length > 0) return otherSeats[Math.floor(Math.random() * otherSeats.length)];
    return null;
  }

  /**
   * 3-stage seat picker for top-level agents.
   *
   *   Stage 1: If `folderName` is given and `areaMappings[folderName]` lists
   *            Area labels, prefer free seats whose tile is labeled with one
   *            of those areas.
   *   Stage 2: Prefer free seats whose tile has NO area label (unzoned).
   *   Stage 3: Any free seat.
   *
   * Each stage routes through `pickFromSeats` for the PC-bias rule. Returns
   * null only when every seat is already occupied. Passing `undefined`
   * preserves pre-Areas single-stage behavior (skips Stage 1; Stage 2 picks
   * unzoned seats from a layout without `areaTiles`, which is every seat).
   */
  private findFreeSeat(folderName?: string): string | null {
    const electronicsTiles = this.buildElectronicsTileSet();
    const freeSeats: string[] = [];
    for (const [uid, seat] of this.seats) {
      // Rest seats are for the lounge, never a desk (docs/adr/0003); module
      // seats belong to their team — the composition hands those out itself.
      if (!seat.assigned && !this.loungeSeatSet.has(uid) && !this.isComposedSeat(uid)) {
        freeSeats.push(uid);
      }
    }
    if (freeSeats.length === 0) return null;

    // Own keys only: a folder named like an Object.prototype member
    // ("constructor") must not read the prototype.
    const areaLabels =
      folderName && Object.prototype.hasOwnProperty.call(this.areaMappings, folderName)
        ? this.areaMappings[folderName]
        : undefined;

    // Stage 1 — in-area seats for the folder's mapped Area labels.
    if (areaLabels && areaLabels.length > 0) {
      const wanted = new Set(areaLabels);
      const inArea = freeSeats.filter((uid) => {
        const label = this.seatZone(uid);
        return label !== null && wanted.has(label);
      });
      const pick = this.pickFromSeats(inArea, electronicsTiles);
      if (pick) return pick;
    }

    // Stage 2 — unzoned seats (no area label, or layout has no areas at all).
    const unzoned = freeSeats.filter((uid) => this.seatZone(uid) === null);
    const pick2 = this.pickFromSeats(unzoned, electronicsTiles);
    if (pick2) return pick2;

    // Stage 3 — any free seat.
    return this.pickFromSeats(freeSeats, electronicsTiles);
  }

  /** Closest walkable tile to (col,row) not occupied by another character, or null. */
  private closestFreeWalkableTile(
    col: number,
    row: number,
    exclude?: ReadonlySet<string>,
  ): { col: number; row: number } | null {
    const occupied = new Set<string>(exclude);
    for (const ch of this.characters.values()) {
      occupied.add(`${ch.tileCol},${ch.tileRow}`);
    }
    let best: { col: number; row: number } | null = null;
    let bestDist = Infinity;
    for (const tile of this.walkableTiles) {
      if (occupied.has(`${tile.col},${tile.row}`)) continue;
      const d = Math.abs(tile.col - col) + Math.abs(tile.row - row);
      if (d < bestDist) {
        best = tile;
        bestDist = d;
      }
    }
    return best;
  }

  /**
   * Pick a diverse palette for a new agent based on currently active agents.
   * First 6 agents each get a unique skin (random order). Beyond 6, skins
   * repeat in balanced rounds with a random hue shift (≥45°).
   */
  private pickDiversePalette(): { palette: number; hueShift: number } {
    // Count how many non-sub-agents use each base palette (0-5)
    const paletteCount = getLoadedCharacterCount();
    const counts = new Array(paletteCount).fill(0) as number[];
    for (const ch of this.characters.values()) {
      if (ch.isSubagent) continue;
      if (ch.palette < paletteCount) counts[ch.palette]++;
    }
    return pickDiversePalette(paletteCount, counts);
  }

  addAgent(
    id: number,
    preferredPalette?: number,
    preferredHueShift?: number,
    preferredSeatId?: string,
    skipSpawnEffect?: boolean,
    folderName?: string,
    nearAgentId?: number,
  ): void {
    if (this.characters.has(id)) return;

    let palette: number;
    let hueShift: number;
    if (preferredPalette !== undefined) {
      palette = preferredPalette;
      hueShift = preferredHueShift ?? 0;
    } else {
      const pick = this.pickDiversePalette();
      palette = pick.palette;
      hueShift = pick.hueShift;
    }

    // Try preferred seat first, then (for teammates) the seat closest to the
    // anchor agent, then any free seat. anchorTile resolves to the anchor's SEAT
    // (stable from creation) rather than its live tile, so a teammate placed while
    // the lead is still walking to its seat still clusters around the final seat.
    const anchor = nearAgentId !== undefined ? this.characters.get(nearAgentId) : undefined;
    const anchorAt = anchorTile(anchor, this.seats);
    let seatId: string | null = null;
    // A rest seat is never a desk, even when restored or requested.
    if (
      preferredSeatId &&
      this.seats.has(preferredSeatId) &&
      !this.loungeSeatSet.has(preferredSeatId)
    ) {
      const seat = this.seats.get(preferredSeatId)!;
      if (!seat.assigned) {
        seatId = preferredSeatId;
      }
    }
    if (!seatId && anchorAt) {
      seatId = closestFreeSeat(this.deskSeats(), anchorAt.col, anchorAt.row);
    }
    if (!seatId) {
      seatId = this.findFreeSeat(folderName);
    }

    let ch: Character;
    if (seatId) {
      const seat = this.seats.get(seatId)!;
      seat.assigned = true;
      ch = createCharacter(id, palette, seatId, seat, hueShift);
    } else {
      // No seats — teammates spawn beside their anchor, others at a random walkable tile
      let spawn = anchorAt ? this.closestFreeWalkableTile(anchorAt.col, anchorAt.row) : null;
      if (!spawn) {
        spawn =
          this.walkableTiles.length > 0
            ? this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)]
            : { col: 1, row: 1 };
      }
      ch = createCharacter(id, palette, null, null, hueShift);
      ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
      ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
      ch.tileCol = spawn.col;
      ch.tileRow = spawn.row;
    }

    if (folderName) {
      ch.folderName = folderName;
    }
    if (!skipSpawnEffect) {
      startMatrixEffect(ch, 'spawn');
    }
    this.characters.set(id, ch);
  }

  // ── Greeter ───────────────────────────────────────────────────
  // The Intro is diegetic: a char_0 character stands near the office's
  // bottom-left corner and "speaks" the tour through a DOM bubble
  // (IntroBubble). It is not an agent — see the `greeter` field.

  /** Spawn the greeter near the office's bottom-left corner: target tile
   *  GREETER_TILE_MARGIN in from the left and bottom edges, falling
   *  back to the closest walkable tile when the target is a seat, furniture,
   *  a wall, or VOID (seat tiles are in blockedTiles, so closestFreeWalkableTile
   *  covers every one of those). Idempotent; a remount mid-despawn (StrictMode)
   *  revives it. */
  spawnGreeter(): void {
    this.greeterCameraCancelled = false;
    if (this.greeter) {
      if (this.greeter.matrixEffect === 'despawn') startMatrixEffect(this.greeter, 'spawn');
      return;
    }
    const spawn = this.closestFreeWalkableTile(
      GREETER_TILE_MARGIN,
      this.layout.rows - 1 - GREETER_TILE_MARGIN,
    );
    if (!spawn) return; // no walkable tile — IntroBubble falls back to a fixed panel
    const ch = createCharacter(GREETER_ID, 0, null, null, 0);
    ch.isGreeter = true;
    ch.state = CharacterState.IDLE;
    ch.isActive = false;
    ch.dir = Direction.DOWN;
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    startMatrixEffect(ch, 'spawn');
    this.greeter = ch;
  }

  /** Start the greeter's despawn effect and release the greeter camera. The
   *  character is dropped once the effect finishes (see update()).
   *  Idempotent — every close path (answer, Escape, hooksStatus) funnels here. */
  despawnGreeter(): void {
    this.greeterCameraTarget = null;
    this.greeterCameraCancelled = false;
    if (!this.greeter || this.greeter.matrixEffect === 'despawn') return;
    startMatrixEffect(this.greeter, 'despawn');
  }

  /** Per-frame update from the bubble overlay; ignored once the user panned. */
  setGreeterCameraTarget(p: { x: number; y: number }): void {
    if (!this.greeterCameraCancelled) this.greeterCameraTarget = p;
  }

  /** Manual pan during the ask: stop re-centering until the next spawn. */
  cancelGreeterCamera(): void {
    this.greeterCameraTarget = null;
    this.greeterCameraCancelled = true;
  }

  removeAgent(id: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    if (ch.matrixEffect === 'despawn') return; // already despawning
    const scene = this.scenes.get(id);
    if (scene?.kind === 'leave') {
      // Removed before its walk-out finished (the server does not wait for the
      // animation): skip straight to the fade. onGone still fires, once.
      if (scene.phase !== 'exit') this.beginExit(ch, scene);
      if (this.selectedAgentId === id) this.selectedAgentId = null;
      if (this.cameraFollowId === id) this.cameraFollowId = null;
      return;
    }
    if (scene) this.dropScene(ch);
    // Free seat and clear selection immediately
    if (ch.seatId) {
      const seat = this.seats.get(ch.seatId);
      if (seat) seat.assigned = false;
    }
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    if (this.cameraFollowId === id) this.cameraFollowId = null;
    // Start despawn animation instead of immediate delete
    startMatrixEffect(ch, 'despawn');
    ch.bubbleType = null;
  }

  /** Find seat uid at a given tile position, or null */
  getSeatAtTile(col: number, row: number): string | null {
    for (const [uid, seat] of this.seats) {
      if (seat.seatCol === col && seat.seatRow === row) return uid;
    }
    return null;
  }

  /** Reassign an agent from their current seat to a new seat */
  reassignSeat(agentId: number, seatId: string): void {
    const ch = this.characters.get(agentId);
    if (!ch) return;
    if (this.isLeaving(agentId)) return; // a leaver takes no more orders
    if (this.scenes.has(agentId)) this.dropScene(ch);
    // Unassign old seat
    if (ch.seatId) {
      const old = this.seats.get(ch.seatId);
      if (old) old.assigned = false;
    }
    // Assign new seat
    const seat = this.seats.get(seatId);
    if (!seat || seat.assigned) return;
    seat.assigned = true;
    ch.seatId = seatId;
    // Pathfind to new seat (unblock own seat tile for this query)
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles),
    );
    if (path.length > 0) {
      ch.path = path;
      ch.moveProgress = 0;
      ch.state = CharacterState.WALK;
      ch.frame = 0;
      ch.frameTimer = 0;
    } else {
      // Already at seat or no path — sit down
      ch.state = CharacterState.TYPE;
      ch.dir = seat.facingDir;
      ch.frame = 0;
      ch.frameTimer = 0;
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC;
      }
    }
  }

  /**
   * Move a just-linked teammate to the free seat closest to its lead, so teams
   * cluster. Only moves when that seat is strictly closer than the teammate's
   * current one — a teammate created as a plain external agent (seated by an
   * arbitrary findFreeSeat) and tagged as a teammate only after tag discovery
   * would otherwise keep its arbitrary seat, unlike an inline teammate seated
   * next to the lead at creation.
   */
  private reseatNextToLead(teammateId: number, leadId: number): void {
    const teammate = this.characters.get(teammateId);
    const lead = this.characters.get(leadId);
    if (!teammate || !lead) return;
    const anchorAt = anchorTile(lead, this.seats);
    if (!anchorAt) return;
    const target = closestFreeSeat(this.deskSeats(), anchorAt.col, anchorAt.row);
    if (!target || target === teammate.seatId) return;
    const targetSeat = this.seats.get(target)!;
    const targetDist =
      Math.abs(targetSeat.seatCol - anchorAt.col) + Math.abs(targetSeat.seatRow - anchorAt.row);
    const currentSeat = teammate.seatId ? this.seats.get(teammate.seatId) : undefined;
    const currentDist = currentSeat
      ? Math.abs(currentSeat.seatCol - anchorAt.col) + Math.abs(currentSeat.seatRow - anchorAt.row)
      : Infinity;
    if (targetDist < currentDist) {
      this.reassignSeat(teammateId, target);
    }
  }

  /** Send an agent back to their currently assigned seat */
  sendToSeat(agentId: number): void {
    const ch = this.characters.get(agentId);
    if (!ch || !ch.seatId) return;
    if (this.isLeaving(agentId)) return;
    const seat = this.seats.get(ch.seatId);
    if (!seat) return;
    if (this.scenes.has(agentId)) {
      // Walking in / resting / walking back: the scene's own route to the desk.
      this.returnToDesk(agentId);
      return;
    }
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, seat.seatCol, seat.seatRow, this.tileMap, this.blockedTiles),
    );
    if (path.length > 0) {
      ch.path = path;
      ch.moveProgress = 0;
      ch.state = CharacterState.WALK;
      ch.frame = 0;
      ch.frameTimer = 0;
    } else {
      // Already at seat — sit down
      ch.state = CharacterState.TYPE;
      ch.dir = seat.facingDir;
      ch.frame = 0;
      ch.frameTimer = 0;
      if (!ch.isActive) {
        ch.seatTimer = INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC;
      }
    }
  }

  /** Walk an agent to an arbitrary walkable tile (right-click command) */
  walkToTile(agentId: number, col: number, row: number): boolean {
    const ch = this.characters.get(agentId);
    if (!ch || ch.isSubagent) return false;
    if (this.isLeaving(agentId)) return false;
    if (!isWalkable(col, row, this.tileMap, this.blockedTiles)) {
      // Also allow walking to own seat tile (blocked for others but not self)
      const key = this.ownSeatKey(ch);
      if (!key || key !== `${col},${row}`) return false;
    }
    const path = this.withOwnSeatUnblocked(ch, () =>
      findPath(ch.tileCol, ch.tileRow, col, row, this.tileMap, this.blockedTiles),
    );
    if (path.length === 0) return false;
    // The user's order outranks a walk-in / lounge / walk-back scene.
    if (this.scenes.has(agentId)) this.dropScene(ch);
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
    return true;
  }

  /** Create a sub-agent character with the parent's palette. Returns the sub-agent ID. */
  addSubagent(parentAgentId: number, parentToolId: string): number {
    const key = `${parentAgentId}:${parentToolId}`;
    if (this.subagentIdMap.has(key)) return this.subagentIdMap.get(key)!;

    const id = this.nextSubagentId--;
    const parentCh = this.characters.get(parentAgentId);
    const palette = parentCh ? parentCh.palette : 0;
    const hueShift = parentCh ? parentCh.hueShift : 0;

    // Find the closest walkable tile to the parent, avoiding tiles occupied by other characters
    const parentCol = parentCh ? parentCh.tileCol : 0;
    const parentRow = parentCh ? parentCh.tileRow : 0;
    let spawn = { col: parentCol, row: parentRow };
    if (this.walkableTiles.length > 0) {
      spawn = this.closestFreeWalkableTile(parentCol, parentRow) ?? this.walkableTiles[0];
    }

    const ch = createCharacter(id, palette, null, null, hueShift);
    ch.x = spawn.col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = spawn.row * TILE_SIZE + TILE_SIZE / 2;
    ch.tileCol = spawn.col;
    ch.tileRow = spawn.row;
    // Face the same direction as the parent agent
    if (parentCh) ch.dir = parentCh.dir;
    ch.isSubagent = true;
    ch.parentAgentId = parentAgentId;
    startMatrixEffect(ch, 'spawn');
    this.characters.set(id, ch);

    this.subagentIdMap.set(key, id);
    this.subagentMeta.set(id, { parentAgentId, parentToolId });
    return id;
  }

  /** Remove a specific sub-agent character and free its seat */
  removeSubagent(parentAgentId: number, parentToolId: string): void {
    const key = `${parentAgentId}:${parentToolId}`;
    const id = this.subagentIdMap.get(key);
    if (id === undefined) return;

    const ch = this.characters.get(id);
    if (ch) {
      if (ch.matrixEffect === 'despawn') {
        // Already despawning — just clean up maps
        this.subagentIdMap.delete(key);
        this.subagentMeta.delete(id);
        return;
      }
      if (ch.seatId) {
        const seat = this.seats.get(ch.seatId);
        if (seat) seat.assigned = false;
      }
      // Start despawn animation — keep character in map for rendering
      startMatrixEffect(ch, 'despawn');
      ch.bubbleType = null;
    }
    // Clean up tracking maps immediately so keys don't collide
    this.subagentIdMap.delete(key);
    this.subagentMeta.delete(id);
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    if (this.cameraFollowId === id) this.cameraFollowId = null;
  }

  /** Remove all sub-agents belonging to a parent agent */
  removeAllSubagents(parentAgentId: number): void {
    const toRemove: string[] = [];
    for (const [key, id] of this.subagentIdMap) {
      const meta = this.subagentMeta.get(id);
      if (meta && meta.parentAgentId === parentAgentId) {
        const ch = this.characters.get(id);
        if (ch) {
          if (ch.matrixEffect === 'despawn') {
            // Already despawning — just clean up maps
            this.subagentMeta.delete(id);
            toRemove.push(key);
            continue;
          }
          if (ch.seatId) {
            const seat = this.seats.get(ch.seatId);
            if (seat) seat.assigned = false;
          }
          // Start despawn animation
          startMatrixEffect(ch, 'despawn');
          ch.bubbleType = null;
        }
        this.subagentMeta.delete(id);
        if (this.selectedAgentId === id) this.selectedAgentId = null;
        if (this.cameraFollowId === id) this.cameraFollowId = null;
        toRemove.push(key);
      }
    }
    for (const key of toRemove) {
      this.subagentIdMap.delete(key);
    }
  }

  /** Look up the sub-agent character ID for a given parent+toolId, or null */
  getSubagentId(parentAgentId: number, parentToolId: string): number | null {
    return this.subagentIdMap.get(`${parentAgentId}:${parentToolId}`) ?? null;
  }

  setAgentActive(id: number, active: boolean): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.isActive = active;
      // A scene owns the path of a scripted character; its end sets seatTimer.
      if (!active && !ch.scripted) {
        // Sentinel -1: signals turn just ended, skip next seat rest timer.
        // Prevents the WALK handler from setting a 2-4 min rest on arrival.
        ch.seatTimer = -1;
        ch.path = [];
        ch.moveProgress = 0;
      }
      // Activity in the lounge (an agentToolStart) walks it back to its desk
      // first; the work animation starts once it sits down.
      if (active && this.scenes.get(id)?.kind === 'lounge') this.returnToDesk(id);
      this.rebuildFurnitureInstances();
    }
  }

  /** Rebuild furniture instances with auto-state applied (active agents turn electronics ON) */
  private rebuildFurnitureInstances(): void {
    // Collect tiles where active agents face desks
    const autoOnTiles = new Set<string>();
    // Tiles resting agents face from a rest seat: leisure electronics there
    // (the arcade, the console) play while someone rests in front of them.
    const playTiles = new Set<string>();
    for (const [id, scene] of this.scenes) {
      if (scene.kind !== 'lounge' || scene.phase !== 'rest' || !scene.loungeSeat) continue;
      const seat = this.seats.get(scene.loungeSeat);
      if (seat && this.characters.has(id)) this.addFacingTiles(seat, playTiles);
    }
    for (const ch of this.characters.values()) {
      if (!ch.isActive || !ch.seatId) continue;
      const seat = this.seats.get(ch.seatId);
      if (!seat) continue;
      this.addFacingTiles(seat, autoOnTiles);
    }

    // The living office's door is never auto-state furniture: it shows its open
    // variant exactly while someone crosses it (+ DOOR_OPEN_HOLD_MS), whatever
    // a seated agent happens to face.
    const doorUid = this.livingTargets?.door.uid;
    if (autoOnTiles.size === 0 && playTiles.size === 0 && !(doorUid && this.doorOpen)) {
      this.furniture = layoutToFurnitureInstances(this.layout.furniture);
      return;
    }

    // Build modified furniture list with auto-state and animation applied
    const animFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    const switchOn = (item: PlacedFurniture): PlacedFurniture => {
      let onType = getOnStateType(item.type);
      if (onType === item.type) return item;
      // Check if the on-state type has animation frames
      const frames = getAnimationFrames(onType);
      if (frames && frames.length > 1) onType = frames[animFrame % frames.length];
      return { ...item, type: onType };
    };
    const overlaps = (item: PlacedFurniture, w: number, h: number, tiles: Set<string>) => {
      for (let dr = 0; dr < h; dr++) {
        for (let dc = 0; dc < w; dc++) {
          if (tiles.has(`${item.col + dc},${item.row + dr}`)) return true;
        }
      }
      return false;
    };
    const modifiedFurniture: PlacedFurniture[] = this.layout.furniture.map((item) => {
      if (doorUid !== undefined && item.uid === doorUid) {
        return this.doorOpen ? { ...item, type: openDoorType(item.type) } : item;
      }
      const entry = getCatalogEntry(item.type);
      if (!entry) return item;
      if (isLeisureElectronics(item.type)) {
        // Not someone's PC: only a rester in front of it switches it on.
        return overlaps(item, entry.footprintW, entry.footprintH, playTiles)
          ? switchOn(item)
          : item;
      }
      return overlaps(item, entry.footprintW, entry.footprintH, autoOnTiles)
        ? switchOn(item)
        : item;
    });

    this.furniture = layoutToFurnitureInstances(modifiedFurniture);
  }

  /** Tiles a seat faces (AUTO_ON_FACING_DEPTH deep, AUTO_ON_SIDE_DEPTH to each side). */
  private addFacingTiles(seat: Seat, out: Set<string>): void {
    // Find the desk tile(s) the agent faces from their seat
    const dCol =
      seat.facingDir === Direction.RIGHT ? 1 : seat.facingDir === Direction.LEFT ? -1 : 0;
    const dRow = seat.facingDir === Direction.DOWN ? 1 : seat.facingDir === Direction.UP ? -1 : 0;
    // Check tiles in the facing direction (desk could be 1-3 tiles deep)
    for (let d = 1; d <= AUTO_ON_FACING_DEPTH; d++) {
      const tileCol = seat.seatCol + dCol * d;
      const tileRow = seat.seatRow + dRow * d;
      out.add(`${tileCol},${tileRow}`);
    }
    // Also check tiles to the sides of the facing direction (desks can be wide)
    for (let d = 1; d <= AUTO_ON_SIDE_DEPTH; d++) {
      const baseCol = seat.seatCol + dCol * d;
      const baseRow = seat.seatRow + dRow * d;
      if (dCol !== 0) {
        // Facing left/right: check tiles above and below
        out.add(`${baseCol},${baseRow - 1}`);
        out.add(`${baseCol},${baseRow + 1}`);
      } else {
        // Facing up/down: check tiles left and right
        out.add(`${baseCol - 1},${baseRow}`);
        out.add(`${baseCol + 1},${baseRow}`);
      }
    }
  }

  setAgentTool(id: number, tool: string | null): void {
    const ch = this.characters.get(id);
    if (ch) {
      ch.currentTool = tool;
    }
  }

  showPermissionBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch && !this.isLeaving(id)) {
      ch.bubbleType = 'permission';
      ch.bubbleTimer = 0;
    }
  }

  clearPermissionBubble(id: number): void {
    const ch = this.characters.get(id);
    if (ch && ch.bubbleType === 'permission') {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    }
  }

  showWaitingBubble(id: number, awaitingInput = false): void {
    const ch = this.characters.get(id);
    if (ch && !this.isLeaving(id)) {
      ch.bubbleType = 'waiting';
      ch.waitingAwaitingInput = awaitingInput;
      ch.bubbleTimer = WAITING_BUBBLE_DURATION_SEC;
    }
  }

  /** Dismiss bubble on click — permission: instant, waiting: quick fade */
  dismissBubble(id: number): void {
    const ch = this.characters.get(id);
    if (!ch || !ch.bubbleType) return;
    if (ch.bubbleType === 'permission') {
      ch.bubbleType = null;
      ch.bubbleTimer = 0;
    } else if (ch.bubbleType === 'waiting') {
      // Trigger immediate fade (0.3s remaining)
      ch.bubbleTimer = Math.min(ch.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC);
    }
  }

  // ── Living office: enter, rest, return, leave (docs/adr/0003) ──
  // The server owns presence; these animate it. Derived agents enter and leave
  // through the door; root sessions keep the matrix effect (addAgent /
  // removeAgent) — which of the two a character gets is the caller's choice.

  /** Door and rest seats of the composed office. Rest seats stop being
   *  offered as desks from here on. */
  setLivingTargets(t: LivingTargets): void {
    this.livingTargets = {
      door: { col: t.door.col, row: t.door.row, uid: t.door.uid },
      loungeSeats: [...t.loungeSeats],
    };
    this.loungeSeatSet = new Set(t.loungeSeats);
    for (const ch of [...this.characters.values()]) {
      if (this.scenes.has(ch.id)) continue;
      // Someone working on what is now a rest seat moves to a real desk —
      // when there is one: without a free desk it keeps the sofa rather than
      // end up with no seat at all.
      if (ch.seatId && this.loungeSeatSet.has(ch.seatId)) {
        const desk = this.findFreeSeat(ch.folderName);
        if (desk) this.reassignSeat(ch.id, desk);
      }
    }
    // A leaver already walking re-routes to the (possibly moved) door.
    for (const [id, scene] of this.scenes) {
      if (scene.kind !== 'leave' || scene.phase !== 'walk') continue;
      const ch = this.characters.get(id);
      if (ch) this.routeToDoor(ch, scene);
    }
    // A lounge presence that arrived before the targets did: it has been
    // resting all along, so it is there already (no walk from its desk).
    for (const ch of [...this.characters.values()]) {
      if (ch.presence === 'lounge' && !this.scenes.has(ch.id)) this.goToLounge(ch.id, true);
    }
    this.rebuildFurnitureInstances();
  }

  /**
   * The office is no longer composed (no derived agent left, or the editor
   * shows the user's layout alone): no door, no rest seats, no composed seats.
   * A leaver still walking waves where it stands; a rester goes back to the FSM.
   */
  clearLivingTargets(): void {
    this.livingTargets = null;
    this.loungeSeatSet = new Set();
    this.composedUids = new Set();
    this.doorOpen = false;
    this.doorHoldTimer = 0;
    for (const [id, scene] of [...this.scenes]) {
      const ch = this.characters.get(id);
      if (!ch) continue;
      if (scene.kind === 'leave') {
        if (scene.phase === 'walk') this.routeToDoor(ch, scene);
      } else if (scene.kind === 'lounge') {
        this.dropScene(ch);
      }
    }
    this.rebuildFurnitureInstances();
  }

  /** Hold these characters seatless through every rebuild until cleared (see seatlessHold). */
  setSeatlessHold(ids: Iterable<number>): void {
    this.seatlessHold = new Set(ids);
  }

  /** Free `id`'s desk without moving it (it is about to get another one). */
  releaseSeat(id: number): void {
    const ch = this.characters.get(id);
    if (!ch?.seatId || this.isLeaving(id)) return;
    const seat = this.seats.get(ch.seatId);
    if (seat) seat.assigned = false;
    ch.seatId = null;
  }

  /** The furniture uids the current composition generated (see composedUids). */
  setComposedUids(uids: Iterable<string>): void {
    this.composedUids = new Set(uids);
  }

  /** Whether a seat belongs to the composition (a module chair, a generated
   *  lounge seat). Multi-tile seats are keyed `uid:n`. */
  isComposedSeat(seatUid: string): boolean {
    if (this.composedUids.size === 0) return false;
    if (this.composedUids.has(seatUid)) return true;
    const at = seatUid.lastIndexOf(':');
    return at > 0 && this.composedUids.has(seatUid.slice(0, at));
  }

  /** Whether the user may send an agent to `seatUid` by hand: never a rest
   *  seat, never a seat of the composition (the teams' desks are theirs). */
  canAssignSeatByHand(seatUid: string): boolean {
    return !this.loungeSeatSet.has(seatUid) && !this.isComposedSeat(seatUid);
  }

  /** Whether the door currently shows its open variant. */
  isDoorOpen(): boolean {
    return this.doorOpen;
  }

  /** Spawn at the door tile (the door opens), walk to `seatId`, sit. Creates
   *  the character when it does not exist yet; an existing one is moved back
   *  to the door, so call it only for NEW derived agents (not on restore /
   *  existingAgents). Without living targets it
   *  falls back to the ordinary placement (matrix spawn at the seat). */
  enterThroughDoor(id: number, seatId: string): void {
    const existing = this.characters.get(id);
    // A leaver, or one already raining out after removeAgent, stays gone.
    if (existing && (this.isLeaving(id) || existing.matrixEffect === 'despawn')) return;
    if (!this.livingTargets) {
      if (!existing) this.addAgent(id, undefined, undefined, seatId);
      else this.reassignSeat(id, seatId);
      return;
    }
    if (!existing) this.addAgent(id, undefined, undefined, seatId, true);
    const ch = this.characters.get(id);
    if (!ch) return;
    if (this.scenes.has(id)) this.dropScene(ch);

    // Move to the requested seat when it is free (or already ours).
    if (seatId !== ch.seatId) {
      const wanted = this.seats.get(seatId);
      if (wanted && !wanted.assigned) {
        if (ch.seatId) {
          const old = this.seats.get(ch.seatId);
          if (old) old.assigned = false;
        }
        wanted.assigned = true;
        ch.seatId = seatId;
      }
    }

    // Appear in the doorway: no matrix rain, a short fade-in instead.
    const door = this.livingTargets.door;
    ch.matrixEffect = null;
    ch.matrixEffectTimer = 0;
    ch.bubbleType = null;
    this.placeAt(ch, door.col, door.row);
    ch.dir = Direction.DOWN;
    ch.state = CharacterState.IDLE;
    ch.sceneAlpha = 0;

    const scene: LifecycleScene = { kind: 'enter', phase: 'walk', timer: 0, loungeSeat: null };
    const seat = ch.seatId ? this.seats.get(ch.seatId) : undefined;
    if (!seat) {
      // No seat anywhere: stand in the office like any seatless agent.
      ch.scripted = false;
      return;
    }
    this.scenes.set(id, scene);
    ch.scripted = true;
    const path = this.scenePath(ch, seat.seatCol, seat.seatRow, scene);
    if (path.length > 0) {
      this.startWalk(ch, path);
    } else {
      // Unreachable from the door: appear at the seat instead.
      this.placeAt(ch, seat.seatCol, seat.seatRow);
      this.arrive(ch, scene);
    }
  }

  /** Stand up and walk to a free rest seat (or beside the lounge when all are
   *  taken), then rest there. Keeps the desk. No-op without a lounge, while
   *  leaving, or when already resting / on the way. `instant`: be there
   *  already (an agent that has been resting since before the office opened). */
  goToLounge(id: number, instant = false): void {
    const ch = this.characters.get(id);
    if (!ch || !this.livingTargets) return;
    const current = this.scenes.get(id);
    if (current?.kind === 'leave' || current?.kind === 'lounge') return;
    // Mid-conversation — speaking or listening: the talk finishes first; the
    // speaker's returnToSeat then takes it (or its listener) to the lounge
    // (the presence already says so).
    if (current?.kind === 'talk' || this.isListening(id)) return;

    let restSeat: string | null = null;
    let anchor: Seat | undefined;
    for (const uid of this.livingTargets.loungeSeats) {
      const seat = this.seats.get(uid);
      if (!seat) continue;
      anchor ??= seat;
      if (!seat.assigned) {
        restSeat = uid;
        break;
      }
    }
    if (!anchor) return; // no rest seat exists in this layout

    let target: { col: number; row: number } | null;
    if (restSeat) {
      const seat = this.seats.get(restSeat)!;
      target = { col: seat.seatCol, row: seat.seatRow };
    } else {
      // Beside the lounge, avoiding tiles other resters are heading to and
      // the door tile (standing there would hold the door open).
      const taken = new Set<string>();
      for (const [otherId, other] of this.scenes) {
        if (other.kind !== 'lounge') continue;
        const och = this.characters.get(otherId);
        const last = och?.path[och.path.length - 1];
        if (last) taken.add(`${last.col},${last.row}`);
      }
      const door = this.livingTargets.door;
      taken.add(`${door.col},${door.row}`);
      target = this.closestFreeWalkableTile(anchor.seatCol, anchor.seatRow, taken);
    }
    if (!target) return;

    const scene: LifecycleScene = { kind: 'lounge', phase: 'walk', timer: 0, loungeSeat: restSeat };
    const path = instant ? [] : this.scenePath(ch, target.col, target.row, scene);
    const already = instant || (ch.tileCol === target.col && ch.tileRow === target.row);
    if (path.length === 0 && !already) return; // unreachable: stay at the desk

    if (current) this.dropScene(ch);
    if (restSeat) this.seats.get(restSeat)!.assigned = true;
    this.scenes.set(id, scene);
    ch.scripted = true;
    if (instant) this.placeAt(ch, target.col, target.row);
    if (path.length > 0) this.startWalk(ch, path);
    else this.arrive(ch, scene);
  }

  /** Walk back to its own seat and hand it back to the FSM. Releases a rest
   *  seat at once. Ignored while leaving. */
  returnToDesk(id: number): void {
    const ch = this.characters.get(id);
    if (!ch || this.isLeaving(id)) return;
    const seat = ch.seatId ? this.seats.get(ch.seatId) : undefined;
    const previous = this.scenes.get(id);
    if (!seat) {
      if (previous) this.dropScene(ch);
      return;
    }
    const scene: LifecycleScene = { kind: 'return', phase: 'walk', timer: 0, loungeSeat: null };
    // Route while the rest seat is still ours (its tile is blocked for others).
    const path = this.scenePath(ch, seat.seatCol, seat.seatRow, previous);
    if (previous) this.dropScene(ch);
    this.scenes.set(id, scene);
    ch.scripted = true;
    if (path.length > 0) {
      this.startWalk(ch, path);
    } else {
      // Already there, or boxed in: sit at the desk either way — it has work.
      this.placeAt(ch, seat.seatCol, seat.seatRow);
      this.arrive(ch, scene);
    }
  }

  /**
   * Walk to the door, wave goodbye for GOODBYE_BUBBLE_MS, fade out through the
   * (open) door, then drop the character and call `onGone` exactly once. Frees
   * the desk and any rest seat immediately. From here on every other movement
   * order is ignored. With no door or no path, it waves and fades where it
   * stands. `onGone` runs at once for an unknown id.
   */
  leaveThroughDoor(id: number, onGone: () => void): void {
    const ch = this.characters.get(id);
    if (!ch) {
      this.safeCall(onGone);
      return;
    }
    const callbacks = this.goneCallbacks.get(id) ?? [];
    callbacks.push(onGone);
    this.goneCallbacks.set(id, callbacks);
    // Already on its way out (door or matrix rain): just wait for it.
    if (this.isLeaving(id) || ch.matrixEffect === 'despawn') return;

    const previous = this.scenes.get(id);
    const scene: LifecycleScene = { kind: 'leave', phase: 'walk', timer: 0, loungeSeat: null };
    // Route before releasing seats: its own seat / rest seat tile is blocked.
    const door = this.livingTargets?.door;
    const path = door ? this.scenePath(ch, door.col, door.row, previous) : [];

    if (previous) this.dropScene(ch);
    if (ch.seatId) {
      const seat = this.seats.get(ch.seatId);
      if (seat) seat.assigned = false;
      ch.seatId = null;
    }
    ch.presence = 'leaving';
    ch.bubbleType = null;
    ch.scripted = true;
    this.scenes.set(id, scene);
    if (path.length > 0) {
      this.startWalk(ch, path);
    } else {
      // At the door already, or no way there: wave and fade in place.
      this.placeAt(ch, ch.tileCol, ch.tileRow);
      this.beginGoodbye(ch, scene);
    }
  }

  /** Animate a presence change broadcast by the server. Leaving is final.
   *  `instant`: a lounge presence the agent already had before the office
   *  showed it — it appears resting instead of walking there. */
  setPresence(id: number, presence: LivingPresence, instant = false): void {
    const ch = this.characters.get(id);
    if (!ch || this.isLeaving(id)) return;
    ch.presence = presence;
    switch (presence) {
      case 'working':
      case 'available':
        if (this.scenes.get(id)?.kind === 'lounge') this.returnToDesk(id);
        break;
      case 'lounge':
        this.goToLounge(id, instant);
        break;
      case 'leaving':
        this.leaveThroughDoor(id, () => {});
        break;
    }
  }

  private isLeaving(id: number): boolean {
    return this.scenes.get(id)?.kind === 'leave';
  }

  /** A free desk of the user's office for an agent of `folderName` (never a
   *  rest seat, never a module seat), or null when every desk is taken. */
  pickDeskSeat(folderName?: string): string | null {
    return this.findFreeSeat(folderName);
  }

  /** Whether `id` is walking out through the door (or waving / fading there).
   *  Such a character removes itself once gone; nothing else should move it. */
  isLeavingAgent(id: number): boolean {
    return this.isLeaving(id);
  }

  /**
   * Give `id` a different desk and walk it there (a derived agent that moves
   * into its team's module, or back to the user's office). A resting agent keeps
   * resting — its new desk is where it will return to. Returns false (nothing
   * changed) for a leaver, an unknown or taken seat, or a rest seat.
   */
  moveToSeat(id: number, seatId: string): boolean {
    const ch = this.characters.get(id);
    if (!ch || this.isLeaving(id) || ch.matrixEffect === 'despawn') return false;
    if (ch.seatId === seatId) return true;
    const seat = this.seats.get(seatId);
    if (!seat || seat.assigned || this.loungeSeatSet.has(seatId)) return false;
    const scene = this.scenes.get(id);
    if (!scene) {
      this.reassignSeat(id, seatId);
      return ch.seatId === seatId;
    }
    if (ch.seatId) {
      const old = this.seats.get(ch.seatId);
      if (old) old.assigned = false;
    }
    seat.assigned = true;
    ch.seatId = seatId;
    // Walking in (or back): re-route to the new desk. Resting: stays put.
    if (scene.kind === 'enter' || scene.kind === 'return') this.returnToDesk(id);
    return true;
  }

  /** Seats that may be handed out as desks: every seat but the rest seats and
   *  the seats of the composed modules (their team's, handed out by the composition). */
  private deskSeats(): Map<string, Seat> {
    const out = new Map<string, Seat>();
    for (const [uid, seat] of this.seats) {
      if (!this.loungeSeatSet.has(uid) && !this.isComposedSeat(uid)) out.set(uid, seat);
    }
    return out;
  }

  /** Path for a scene walk, with the character's own desk tile, the rest seat
   *  its current scene holds, and the target seat (if the target is one)
   *  unblocked for the query. */
  private scenePath(
    ch: Character,
    col: number,
    row: number,
    scene: LifecycleScene | undefined,
  ): Array<{ col: number; row: number }> {
    const keys: string[] = [];
    const own = this.ownSeatKey(ch);
    if (own) keys.push(own);
    if (scene?.loungeSeat) {
      const s = this.seats.get(scene.loungeSeat);
      if (s) keys.push(`${s.seatCol},${s.seatRow}`);
    }
    const targetSeat = this.getSeatAtTile(col, row);
    if (targetSeat) keys.push(`${col},${row}`);
    const removed = keys.filter((k) => this.blockedTiles.delete(k));
    try {
      return findPath(ch.tileCol, ch.tileRow, col, row, this.tileMap, this.blockedTiles);
    } finally {
      for (const k of removed) this.blockedTiles.add(k);
    }
  }

  private placeAt(ch: Character, col: number, row: number): void {
    ch.tileCol = col;
    ch.tileRow = row;
    ch.x = col * TILE_SIZE + TILE_SIZE / 2;
    ch.y = row * TILE_SIZE + TILE_SIZE / 2;
    ch.path = [];
    ch.moveProgress = 0;
  }

  private startWalk(ch: Character, path: Array<{ col: number; row: number }>): void {
    ch.path = path;
    ch.moveProgress = 0;
    ch.state = CharacterState.WALK;
    ch.frame = 0;
    ch.frameTimer = 0;
  }

  /** Sit on a seat tile, facing the seat's direction. */
  private sitOn(ch: Character, seat: Seat): void {
    this.placeAt(ch, seat.seatCol, seat.seatRow);
    ch.state = CharacterState.TYPE;
    ch.dir = seat.facingDir;
    ch.frame = 0;
    ch.frameTimer = 0;
  }

  /** End a scene without finishing it: release its rest seat, hand the
   *  character back to the FSM. Never used on a leaver. */
  private dropScene(ch: Character): void {
    const scene = this.scenes.get(ch.id);
    if (!scene) return;
    this.scenes.delete(ch.id);
    ch.scripted = false;
    // However a conversation ends (sent back, a user order, leaving, removed),
    // its listener is let go.
    if (scene.kind === 'talk') this.releaseListener(scene);
    if (scene.loungeSeat) {
      const seat = this.seats.get(scene.loungeSeat);
      if (seat) seat.assigned = false;
      this.offerRestSeat();
    }
  }

  /** A rest seat was freed: the first rester standing beside the lounge
   *  (every seat was taken when it arrived) goes to sit down. */
  private offerRestSeat(): void {
    for (const [id, scene] of this.scenes) {
      if (scene.kind !== 'lounge' || scene.loungeSeat) continue;
      // Listening to someone: it takes a seat once the talk is over.
      if (this.isListening(id)) continue;
      const ch = this.characters.get(id);
      if (!ch) continue;
      this.dropScene(ch); // holds no rest seat: no recursion
      this.goToLounge(id);
      return;
    }
  }

  /** The walk of a scene ended: what happens at its destination. */
  private arrive(ch: Character, scene: LifecycleScene): void {
    switch (scene.kind) {
      case 'enter':
      case 'return': {
        const seat = ch.seatId ? this.seats.get(ch.seatId) : undefined;
        if (seat) this.sitOn(ch, seat);
        this.scenes.delete(ch.id);
        ch.scripted = false;
        // Same settle-in rule as sendToSeat: an idle agent sits a moment
        // before the FSM lets it wander.
        ch.seatTimer = ch.isActive
          ? 0
          : INACTIVE_SEAT_TIMER_MIN_SEC + Math.random() * INACTIVE_SEAT_TIMER_RANGE_SEC;
        return;
      }
      case 'lounge': {
        scene.phase = 'rest';
        const seat = scene.loungeSeat ? this.seats.get(scene.loungeSeat) : undefined;
        if (seat) {
          this.sitOn(ch, seat); // sits — "plays" when the seat faces the arcade
        } else {
          ch.state = CharacterState.IDLE;
          ch.frame = 0;
        }
        return;
      }
      case 'leave':
        this.beginGoodbye(ch, scene);
        return;
      case 'talk':
        scene.phase = 'hold';
        ch.state = CharacterState.IDLE;
        ch.frame = 0;
        ch.frameTimer = 0;
        if (scene.partnerId !== undefined) this.turnToward(ch, scene.partnerId);
        return;
    }
  }

  private beginGoodbye(ch: Character, scene: LifecycleScene): void {
    scene.phase = 'goodbye';
    scene.timer = GOODBYE_BUBBLE_MS / 1000;
    ch.state = CharacterState.IDLE;
    ch.frame = 0;
    ch.frameTimer = 0;
    ch.dir = Direction.DOWN; // wave at the room
    ch.bubbleType = 'goodbye';
    ch.bubbleTimer = scene.timer;
  }

  private beginExit(ch: Character, scene: LifecycleScene): void {
    scene.phase = 'exit';
    scene.timer = MATRIX_EFFECT_DURATION_SEC; // same beat as a root's despawn
    ch.path = [];
    ch.moveProgress = 0;
    ch.state = CharacterState.IDLE;
    ch.frame = 0;
    ch.bubbleType = null;
    ch.bubbleTimer = 0;
    const door = this.livingTargets?.door;
    if (door && ch.tileCol === door.col && ch.tileRow === door.row) {
      ch.dir = Direction.UP; // turn and step through the door
    }
    ch.sceneAlpha = 1;
  }

  /** Advance one scene by a frame. Returns true when the character is gone. */
  private tickScene(ch: Character, scene: LifecycleScene, dt: number): boolean {
    switch (scene.phase) {
      case 'walk':
        if (ch.state !== CharacterState.WALK) this.arrive(ch, scene);
        return false;
      case 'rest':
        return false;
      case 'hold':
        // Safety net: a talk nobody ends (a director dropped without clear())
        // never leaves its speaker scripted for good.
        scene.timer += dt;
        if (scene.timer * 1000 > CONVERSATION_TALK_HOLD_MAX_MS) this.returnToSeat(ch.id);
        return false;
      case 'goodbye':
        scene.timer -= dt;
        ch.bubbleTimer = Math.max(0, scene.timer);
        if (scene.timer <= 0) this.beginExit(ch, scene);
        return false;
      case 'exit':
        scene.timer -= dt;
        ch.sceneAlpha = Math.max(0, scene.timer / MATRIX_EFFECT_DURATION_SEC);
        return scene.timer <= 0;
    }
  }

  /** Point a walking leaver at the door (again); wave in place if unreachable. */
  private routeToDoor(ch: Character, scene: LifecycleScene): void {
    const door = this.livingTargets?.door;
    const path = door ? this.scenePath(ch, door.col, door.row, scene) : [];
    if (path.length > 0) {
      this.startWalk(ch, path);
    } else {
      this.placeAt(ch, ch.tileCol, ch.tileRow);
      this.beginGoodbye(ch, scene);
    }
  }

  /** After a layout rebuild: every walking scene re-routes from where its
   *  character stands now; a rest that lost its seat goes looking again. */
  private replanScenes(): void {
    for (const [id, scene] of [...this.scenes]) {
      const ch = this.characters.get(id);
      if (!ch) {
        this.scenes.delete(id);
        continue;
      }
      switch (scene.kind) {
        case 'leave':
          if (scene.phase === 'walk') this.routeToDoor(ch, scene);
          break;
        case 'enter':
        case 'return': {
          const seat = ch.seatId ? this.seats.get(ch.seatId) : undefined;
          if (!seat) {
            this.dropScene(ch);
            break;
          }
          const path = this.scenePath(ch, seat.seatCol, seat.seatRow, scene);
          if (path.length > 0) {
            this.startWalk(ch, path);
          } else {
            this.placeAt(ch, seat.seatCol, seat.seatRow);
            this.arrive(ch, scene);
          }
          break;
        }
        case 'lounge': {
          const seat = scene.loungeSeat ? this.seats.get(scene.loungeSeat) : undefined;
          if (seat) {
            if (ch.tileCol === seat.seatCol && ch.tileRow === seat.seatRow) {
              this.sitOn(ch, seat);
              scene.phase = 'rest';
              break;
            }
            const path = this.scenePath(ch, seat.seatCol, seat.seatRow, scene);
            if (path.length > 0) {
              scene.phase = 'walk';
              this.startWalk(ch, path);
              break;
            }
          } else if (scene.phase === 'rest' && !scene.loungeSeat) {
            break; // standing beside the lounge: stays put
          }
          // Listening to someone: it looks for a seat once the talk is over.
          if (this.isListening(id)) break;
          // Lost its rest seat (or its way there): look for another.
          this.dropScene(ch);
          this.goToLounge(id);
          break;
        }
        case 'talk': {
          if (scene.phase === 'walk') {
            this.routeTalk(ch, scene);
            break;
          }
          // Holding: stays unless its tile is gone or the listener's desk moved away.
          const anchor = scene.partnerId !== undefined ? this.talkAnchor(scene.partnerId) : null;
          const tooFar =
            !!anchor &&
            Math.abs(anchor.col - ch.tileCol) + Math.abs(anchor.row - ch.tileRow) >
              CONVERSATION_SPOT_MAX_DIST;
          if (tooFar || !isWalkable(ch.tileCol, ch.tileRow, this.tileMap, this.blockedTiles)) {
            this.routeTalk(ch, scene);
          }
          break;
        }
      }
    }
  }

  /** The door is open while any character stands on its tile, and for
   *  DOOR_OPEN_HOLD_MS after the tile is vacated. */
  private updateDoor(dt: number): void {
    const door = this.livingTargets?.door;
    let occupied = false;
    if (door) {
      for (const ch of this.characters.values()) {
        if (ch.tileCol === door.col && ch.tileRow === door.row) {
          occupied = true;
          break;
        }
      }
    }
    if (occupied) this.doorHoldTimer = DOOR_OPEN_HOLD_MS / 1000;
    else this.doorHoldTimer = Math.max(0, this.doorHoldTimer - dt);
    const open = occupied || this.doorHoldTimer > 0;
    if (open !== this.doorOpen) {
      this.doorOpen = open;
      this.rebuildFurnitureInstances();
    }
  }

  /** A character left the map: forget its scene, selection, and tell whoever
   *  waited on its departure. */
  private finishGone(id: number): void {
    this.scenes.delete(id);
    if (this.selectedAgentId === id) this.selectedAgentId = null;
    if (this.cameraFollowId === id) this.cameraFollowId = null;
    if (this.hoveredAgentId === id) this.hoveredAgentId = null;
    const callbacks = this.goneCallbacks.get(id);
    this.goneCallbacks.delete(id);
    for (const cb of callbacks ?? []) this.safeCall(cb);
  }

  private safeCall(cb: () => void): void {
    try {
      cb();
    } catch (err) {
      console.error('[Webview] living-office onGone callback failed:', err);
    }
  }

  // ── Conversations (spec §4b): the director's SceneHost ────────
  // A conversation is one more scene: the speaker walks (scripted) to a free
  // tile beside the listener's desk, stands there (`hold`) while the director
  // types its bubble, and is sent back by returnToSeat. Purely visual: no
  // presence, activity or seat changes. Leaving always wins over talking.

  /** In the office and free to take part: not removed, not raining out, not leaving. */
  isPresent(id: number): boolean {
    const ch = this.characters.get(id);
    return !!ch && ch.matrixEffect !== 'despawn' && !this.isLeaving(id);
  }

  canStage(fromId: number, toId: number | undefined): boolean {
    if (toId === undefined || toId === fromId) return false;
    return this.isPresent(fromId) && this.isPresent(toId);
  }

  /**
   * Walk `fromId` to the free walkable tile closest to `toId`'s desk (its
   * current tile when it has none). A listener resting in the lounge first
   * walks back to its desk. False — and nothing moves — when there is no way
   * there.
   */
  walkNextTo(fromId: number, toId: number): boolean {
    if (!this.canStage(fromId, toId)) return false;
    const ch = this.characters.get(fromId)!;
    const partner = this.characters.get(toId)!;
    const previous = this.scenes.get(fromId);
    const scene: LifecycleScene = {
      kind: 'talk',
      phase: 'walk',
      timer: 0,
      loungeSeat: null,
      partnerId: toId,
    };
    // Plan before touching anyone: a failed plan must leave both as they were.
    const plan = this.planTalk(ch, scene, previous);
    if (!plan) return false;

    if (previous) this.dropScene(ch);
    scene.target = plan.target;
    this.scenes.set(fromId, scene);
    ch.scripted = true;
    if (plan.path.length > 0) {
      this.startWalk(ch, plan.path);
    } else {
      this.placeAt(ch, plan.target.col, plan.target.row);
      this.arrive(ch, scene);
    }

    // A resting listener comes back to its desk to listen; releaseListener
    // sends it back to rest (its presence still says 'lounge').
    if (this.scenes.get(toId)?.kind === 'lounge' && partner.seatId) this.returnToDesk(toId);
    return true;
  }

  /** Arrived beside the listener — or no longer steered by a conversation
   *  (interrupted, removed): either way there is nothing left to wait for. */
  hasArrived(fromId: number): boolean {
    const scene = this.scenes.get(fromId);
    return scene?.kind !== 'talk' || scene.phase === 'hold';
  }

  /** The speaker looks at the listener; a listener standing or seated (not
   *  walking) looks back. The listener's desk facing returns with returnToSeat. */
  faceEachOther(fromId: number, toId: number): void {
    const speaker = this.characters.get(fromId);
    const listener = this.characters.get(toId);
    if (!speaker || !listener) return;
    if (speaker.state !== CharacterState.WALK) this.turnToward(speaker, toId);
    if (listener.state !== CharacterState.WALK && !listener.scripted) {
      listener.dir = directionToward(
        listener.tileCol,
        listener.tileRow,
        speaker.tileCol,
        speaker.tileRow,
      );
    }
  }

  /** End the conversation walk: back to its desk — or to the lounge when its
   *  presence says it is resting. A listener pulled out of the lounge goes
   *  back to rest; one at its desk faces its desk again. No-op unless a
   *  conversation steers `fromId`. */
  returnToSeat(fromId: number): void {
    const ch = this.characters.get(fromId);
    const scene = this.scenes.get(fromId);
    if (!ch || scene?.kind !== 'talk') return;
    this.releaseListener(scene);
    if (ch.presence === 'lounge' && this.livingTargets) {
      this.dropScene(ch);
      this.goToLounge(fromId);
      if (this.scenes.has(fromId)) return; // on its way to rest
    }
    this.returnToDesk(fromId);
  }

  /** Back where it belongs: no conversation walk and no walk back pending. */
  isSeated(fromId: number): boolean {
    if (!this.characters.has(fromId)) return true;
    const scene = this.scenes.get(fromId);
    if (!scene) return true;
    if (scene.kind === 'lounge') return scene.phase === 'rest';
    return scene.kind !== 'talk' && scene.kind !== 'return';
  }

  /** The ✉ envelope over a speaker that could not walk its conversation. */
  showEnvelope(fromId: number): void {
    const ch = this.characters.get(fromId);
    if (!ch || !this.isPresent(fromId)) return;
    ch.envelopeTimer = CONVERSATION_ENVELOPE_SEC;
  }

  /** Someone is walking up to `id` or talking to it. */
  private isListening(id: number): boolean {
    for (const s of this.scenes.values()) {
      if (s.kind === 'talk' && s.partnerId === id) return true;
    }
    return false;
  }

  /** Where the conversation happens: the listener's desk, or where it stands
   *  when it has none. */
  private talkAnchor(id: number): { col: number; row: number } | null {
    const ch = this.characters.get(id);
    if (!ch) return null;
    const seat = ch.seatId ? this.seats.get(ch.seatId) : undefined;
    return seat ? { col: seat.seatCol, row: seat.seatRow } : { col: ch.tileCol, row: ch.tileRow };
  }

  /** Face `otherId`: where it stands, or its desk while it walks there. */
  private turnToward(ch: Character, otherId: number): void {
    const other = this.characters.get(otherId);
    if (!other) return;
    const look =
      other.state === CharacterState.WALK
        ? this.talkAnchor(otherId)
        : { col: other.tileCol, row: other.tileRow };
    if (look) ch.dir = directionToward(ch.tileCol, ch.tileRow, look.col, look.row);
  }

  /**
   * The speaker's spot: the free walkable tile closest to the listener's
   * anchor (ties: closer to the speaker) that the speaker can reach, skipping
   * the door tile, tiles other characters stand on and tiles other speakers
   * are heading to, no farther than CONVERSATION_SPOT_MAX_DIST. One flood fill
   * decides reachability for every candidate, then one path search walks it —
   * a walled-off listener costs one fill, not a search per candidate.
   */
  private planTalk(
    ch: Character,
    scene: LifecycleScene,
    previous: LifecycleScene | undefined,
  ): { target: { col: number; row: number }; path: Array<{ col: number; row: number }> } | null {
    if (scene.partnerId === undefined) return null;
    const anchor = this.talkAnchor(scene.partnerId);
    if (!anchor) return null;
    const taken = new Set<string>();
    for (const other of this.characters.values()) {
      if (other.id !== ch.id) taken.add(`${other.tileCol},${other.tileRow}`);
    }
    for (const [id, s] of this.scenes) {
      if (id !== ch.id && s.kind === 'talk' && s.target) {
        taken.add(`${s.target.col},${s.target.row}`);
      }
    }
    const door = this.livingTargets?.door;
    if (door) taken.add(`${door.col},${door.row}`);

    const candidates = this.walkableTiles
      .filter((t) => !taken.has(`${t.col},${t.row}`))
      .map((t) => ({
        t,
        d: Math.abs(t.col - anchor.col) + Math.abs(t.row - anchor.row),
        s: Math.abs(t.col - ch.tileCol) + Math.abs(t.row - ch.tileRow),
      }))
      .filter((c) => c.d > 0 && c.d <= CONVERSATION_SPOT_MAX_DIST)
      .sort((a, b) => a.d - b.d || a.s - b.s);
    if (candidates.length === 0) return null;
    const reach = this.reachableFrom(ch, previous);
    const cols = this.tileMap[0]?.length ?? 0;
    for (const { t } of candidates) {
      if (t.col === ch.tileCol && t.row === ch.tileRow) return { target: t, path: [] };
      if (!reach[t.row * cols + t.col]) continue;
      const path = this.scenePath(ch, t.col, t.row, previous);
      if (path.length > 0) return { target: t, path };
    }
    return null;
  }

  /** Tiles `ch` can walk to (flood fill over the same map scenePath uses),
   *  as a row-major bitmap. */
  private reachableFrom(ch: Character, scene: LifecycleScene | undefined): Uint8Array {
    const rows = this.tileMap.length;
    const cols = this.tileMap[0]?.length ?? 0;
    const reach = new Uint8Array(rows * cols);
    if (ch.tileCol < 0 || ch.tileCol >= cols || ch.tileRow < 0 || ch.tileRow >= rows) return reach;
    const keys: string[] = [];
    const own = this.ownSeatKey(ch);
    if (own) keys.push(own);
    if (scene?.loungeSeat) {
      const s = this.seats.get(scene.loungeSeat);
      if (s) keys.push(`${s.seatCol},${s.seatRow}`);
    }
    const removed = keys.filter((k) => this.blockedTiles.delete(k));
    try {
      const queue = new Int32Array(rows * cols);
      let head = 0;
      let tail = 0;
      const start = ch.tileRow * cols + ch.tileCol;
      reach[start] = 1;
      queue[tail++] = start;
      while (head < tail) {
        const cur = queue[head++];
        const col = cur % cols;
        const row = (cur - col) / cols;
        const next: Array<[number, number]> = [
          [col, row - 1],
          [col, row + 1],
          [col - 1, row],
          [col + 1, row],
        ];
        for (const [c, r] of next) {
          if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
          const idx = r * cols + c;
          if (reach[idx]) continue;
          if (!isWalkable(c, r, this.tileMap, this.blockedTiles)) continue;
          reach[idx] = 1;
          queue[tail++] = idx;
        }
      }
    } finally {
      for (const k of removed) this.blockedTiles.add(k);
    }
    return reach;
  }

  /** Re-route a conversation walk after a layout rebuild; with no way to the
   *  listener any more, it talks from where it stands. */
  private routeTalk(ch: Character, scene: LifecycleScene): void {
    const plan = this.planTalk(ch, scene, scene);
    scene.phase = 'walk';
    if (plan && plan.path.length > 0) {
      scene.target = plan.target;
      this.startWalk(ch, plan.path);
      return;
    }
    scene.target = { col: ch.tileCol, row: ch.tileRow };
    this.placeAt(ch, ch.tileCol, ch.tileRow);
    this.arrive(ch, scene);
  }

  /** The conversation is over for the listener: back to rest if it was pulled
   *  out of the lounge, else face its desk again if it sits there. */
  private releaseListener(scene: LifecycleScene): void {
    const id = scene.partnerId;
    if (id === undefined) return;
    scene.partnerId = undefined; // once: the listener is no longer held
    const partner = this.characters.get(id);
    if (!partner || !this.isPresent(id)) return;
    const partnerScene = this.scenes.get(id);
    if (partner.presence === 'lounge' && partnerScene?.kind !== 'lounge') {
      // Pulled out of the lounge for the talk, or told to rest meanwhile.
      this.goToLounge(id);
      return;
    }
    if (partnerScene?.kind === 'lounge') {
      // Rested standing (no seat) while listening: a seat freed meanwhile
      // was held back for after the talk.
      const seatFree = this.livingTargets?.loungeSeats.some(
        (uid) => this.seats.get(uid)?.assigned === false,
      );
      if (!partnerScene.loungeSeat && seatFree) this.offerRestSeat();
      return;
    }
    if (this.scenes.has(id)) return;
    const seat = partner.seatId ? this.seats.get(partner.seatId) : undefined;
    if (
      seat &&
      partner.state === CharacterState.TYPE &&
      partner.tileCol === seat.seatCol &&
      partner.tileRow === seat.seatRow
    ) {
      partner.dir = seat.facingDir;
    }
  }

  // ── Pets ──────────────────────────────────────────────────────

  /**
   * Add a pet to the live runtime. Spawns at a uniformly-random walkable tile.
   * Mirror in `this.layout.pets` so debounced saveLayout serialises the roster.
   * Bounds-checks petType against the loaded sprite count to defend against stale layouts.
   */
  addPet(placedPet: PlacedPet): void {
    // Defensive guards (upstream 5e6c0a0)
    if (
      typeof placedPet.id !== 'string' ||
      placedPet.id.length === 0 ||
      placedPet.id.length > MAX_PET_ID_LENGTH
    ) {
      return;
    }
    if (
      !Number.isInteger(placedPet.petType) ||
      placedPet.petType < 0 ||
      placedPet.petType >= getPetCount()
    ) {
      return;
    }
    if (this.pets.some((p) => p.id === placedPet.id)) return; // de-dupe
    if (this.walkableTiles.length === 0) return; // no spawn space — silently drop

    const spawn = this.walkableTiles[Math.floor(Math.random() * this.walkableTiles.length)];
    const pet = createPet(placedPet.id, placedPet.petType, spawn.col, spawn.row);
    pet.name = getPetName(placedPet.petType);
    this.pets.push(pet);
    this.syncLayoutPets();
  }

  /** Remove a pet by id. Idempotent. */
  removePet(id: string): void {
    const before = this.pets.length;
    this.pets = this.pets.filter((p) => p.id !== id);
    if (this.pets.length !== before) {
      this.syncLayoutPets();
    }
  }

  /** Shallow snapshot for external consumers (renderer, hooks). */
  getPets(): Pet[] {
    return this.pets.slice();
  }

  /** Unique petType values currently placed. Used by the Pets toolbar to mark active rows. */
  getActivePetTypes(): number[] {
    const seen = new Set<number>();
    for (const p of this.pets) seen.add(p.petType);
    return Array.from(seen);
  }

  /**
   * Hit-test pets at a pixel world position. Sorts back-to-front (largest y wins on tie)
   * so the visually-frontmost pet receives the click.
   * Returns the pet id or null.
   */
  getPetAt(worldX: number, worldY: number): string | null {
    const ordered = this.pets.slice().sort((a, b) => b.y - a.y);
    for (const pet of ordered) {
      const left = pet.x - PET_HIT_HALF_WIDTH;
      const right = pet.x + PET_HIT_HALF_WIDTH;
      const top = pet.y - PET_HIT_HEIGHT;
      const bottom = pet.y;
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return pet.id;
      }
    }
    return null;
  }

  /** Show the heart bubble on a pet for WAITING_BUBBLE_DURATION_SEC. */
  showPetBubble(petId: string): void {
    const pet = this.pets.find((p) => p.id === petId);
    if (!pet) return;
    pet.bubbleType = 'heart';
    pet.bubbleTimer = WAITING_BUBBLE_DURATION_SEC;
  }

  /** Dismiss the heart bubble on click; collapses timer to a fast fade. */
  dismissPetBubble(petId: string): void {
    const pet = this.pets.find((p) => p.id === petId);
    if (!pet || !pet.bubbleType) return;
    pet.bubbleTimer = Math.min(pet.bubbleTimer, DISMISS_BUBBLE_FAST_FADE_SEC);
  }

  /**
   * Reconcile `this.pets` to match the layout's placed-pet roster.
   * - Pets in layout but not in runtime → spawn via addPet().
   * - Pets in runtime but not in layout → remove.
   * - Pets in both → keep existing runtime state (position, FSM).
   *
   * Called from constructor and rebuildFromLayout. Always runs AFTER walkableTiles
   * is populated.
   */
  private rebuildPetsFromLayout(layout: OfficeLayout): void {
    const placed = layout.pets ?? [];
    const placedIds = new Set(placed.map((p) => p.id));

    // 1. Remove pets no longer in layout
    this.pets = this.pets.filter((p) => placedIds.has(p.id));

    // 2. Add pets that exist in layout but not in runtime
    const existingIds = new Set(this.pets.map((p) => p.id));
    for (const p of placed) {
      if (existingIds.has(p.id)) continue;
      this.addPet(p); // pushes onto this.pets, calls syncLayoutPets()
    }
    // syncLayoutPets() inside addPet keeps this.layout.pets coherent; one final
    // sync handles the removal-only branch where addPet was never called.
    this.syncLayoutPets();
  }

  /**
   * Re-export the current pet roster into `this.layout.pets`. Called only from
   * mutating methods (addPet / removePet / rebuildPetsFromLayout) — NEVER from
   * getLayout(), which runs on every render frame.
   */
  private syncLayoutPets(): void {
    this.layout.pets = this.pets.map((p) => ({ id: p.id, petType: p.petType }));
  }

  setTeamInfo(
    id: number,
    teamName?: string,
    agentName?: string,
    isTeamLead?: boolean,
    leadAgentId?: number,
    teamUsesTmux?: boolean,
  ): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    const wasUnlinked = ch.leadAgentId === undefined;
    ch.teamName = teamName;
    ch.agentName = agentName;
    ch.isTeamLead = isTeamLead;
    ch.leadAgentId = leadAgentId;
    if (teamUsesTmux !== undefined) {
      ch.teamUsesTmux = teamUsesTmux;
    }
    // A teammate is not a headless agent: clicking it focuses its lead's terminal.
    // Adopted sessions are marked headless at creation and only later discovered
    // to be teammates, so drop the mark once the link lands.
    if (leadAgentId !== undefined) {
      ch.isHeadless = false;
    }
    // A teammate discovered only after its plain external session was adopted is
    // linked here, not at creation, so it never went through the seat-next-to-lead
    // path addAgent runs for inline teammates. Cluster it now, once, on first link.
    if (wasUnlinked && leadAgentId !== undefined && !isTeamLead) {
      this.reseatNextToLead(id, leadAgentId);
    }
  }

  /** Mark an agent as headless (adopted, no terminal to focus). */
  setHeadless(id: number, headless: boolean): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    ch.isHeadless = headless;
  }

  setAgentContext(id: number, contextTokens: number, maxContextTokens: number): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    ch.contextTokens = contextTokens;
    ch.maxContextTokens = maxContextTokens;
  }

  update(dt: number): void {
    // Furniture animation cycling
    const prevFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    this.furnitureAnimTimer += dt;
    const newFrame = Math.floor(this.furnitureAnimTimer / FURNITURE_ANIM_INTERVAL_SEC);
    if (newFrame !== prevFrame) {
      this.rebuildFurnitureInstances();
    }

    // The greeter materializes and dematerializes like anyone else, but runs
    // no FSM — it stands where it spawned for as long as the ask is up.
    if (this.greeter && advanceMatrixEffect(this.greeter, dt) === 'despawned') {
      this.greeter = null;
    }

    const toDelete: number[] = [];
    for (const ch of this.characters.values()) {
      const effect = advanceMatrixEffect(ch, dt);
      if (effect !== 'none') {
        if (effect === 'despawned') toDelete.push(ch.id);
        continue; // skip normal FSM while the effect is (or just was) active
      }

      // Temporarily unblock own seat so character can pathfind to it
      this.withOwnSeatUnblocked(ch, () =>
        updateCharacter(ch, dt, this.walkableTiles, this.seats, this.tileMap, this.blockedTiles),
      );

      // Living-office scene (enter / lounge / return / leave) and door fade-in.
      const scene = this.scenes.get(ch.id);
      if (scene && this.tickScene(ch, scene, dt)) {
        toDelete.push(ch.id);
        continue;
      }
      if (ch.sceneAlpha !== undefined && scene?.phase !== 'exit') {
        ch.sceneAlpha += dt / MATRIX_EFFECT_DURATION_SEC;
        if (ch.sceneAlpha >= 1) ch.sceneAlpha = undefined;
      }

      if (ch.envelopeTimer !== undefined) {
        ch.envelopeTimer -= dt;
        if (ch.envelopeTimer <= 0) ch.envelopeTimer = undefined;
      }

      // Tick bubble timer for waiting bubbles
      if (ch.bubbleType === 'waiting') {
        ch.bubbleTimer -= dt;
        if (ch.bubbleTimer <= 0) {
          ch.bubbleType = null;
          ch.bubbleTimer = 0;
        }
      }
    }
    // Remove characters that finished despawn (matrix rain or door fade)
    for (const id of toDelete) {
      this.characters.delete(id);
      this.finishGone(id);
    }

    this.updateDoor(dt);

    // ── Pet FSM ────────────────────────────────────────────────
    for (const pet of this.pets) {
      updatePet(pet, dt, this.walkableTiles, this.characters, this.tileMap, this.blockedTiles);

      // Tick heart bubble timer (mirrors character waiting-bubble pattern)
      if (pet.bubbleType) {
        pet.bubbleTimer -= dt;
        if (pet.bubbleTimer <= 0) {
          pet.bubbleType = null;
          pet.bubbleTimer = 0;
        }
      }
    }
  }

  /** The `saveAgentSeats` payload: palette, hue and seat for every agent worth
   *  restoring. Sub-agents are excluded because they are derived state the
   *  runtime re-materializes, and the greeter never reaches here at all —
   *  it is not in `characters`. */
  getPersistableSeats(): Record<
    number,
    { palette: number; hueShift: number; seatId: string | null }
  > {
    const seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {};
    for (const ch of this.characters.values()) {
      if (ch.isSubagent || this.isLeaving(ch.id)) continue;
      seats[ch.id] = { palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId };
    }
    return seats;
  }

  /** Everything the renderer draws: the agents plus, while the first-run ask
   *  is up, the consent greeter. This is the ONE place the greeter joins the
   *  agents — every other consumer reads `characters` and gets agents only. */
  getCharacters(): Character[] {
    const chars = Array.from(this.characters.values());
    if (this.greeter) chars.push(this.greeter);
    return chars;
  }

  /** Get character at pixel position (for hit testing). Returns id or null.
   *  Agents only: clicks pass straight through the consent greeter, which is
   *  a prop, not something to select or follow. */
  getCharacterAt(worldX: number, worldY: number): number | null {
    const chars = Array.from(this.characters.values()).sort((a, b) => b.y - a.y);
    for (const ch of chars) {
      // Skip characters that are despawning or fading out through the door
      if (ch.matrixEffect === 'despawn') continue;
      if (this.scenes.get(ch.id)?.phase === 'exit') continue;
      // Character sprite is 16x24, anchored bottom-center
      // Apply sitting offset to match visual position
      const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
      const anchorY = ch.y + sittingOffset;
      const left = ch.x - CHARACTER_HIT_HALF_WIDTH;
      const right = ch.x + CHARACTER_HIT_HALF_WIDTH;
      const top = anchorY - CHARACTER_HIT_HEIGHT;
      const bottom = anchorY;
      if (worldX >= left && worldX <= right && worldY >= top && worldY <= bottom) {
        return ch.id;
      }
    }
    return null;
  }
}
