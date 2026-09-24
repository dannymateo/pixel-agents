/**
 * The living office (docs/adr/0003, spec §3.1–§3.2): the user's own layout,
 * untouched, plus one generated team module per team to its right, a default
 * entrance and a default lounge when the user has none. DOM-free and pure —
 * the result depends only on the arguments and the loaded furniture catalog
 * (footprints, seats). Nothing here is ever saved: the editor edits only the
 * user's part, `[0, userCols)`.
 *
 * Geometry. Modules share one width (the scope generator's), so the space to
 * the right of the user's layout is split into fixed columns separated by
 * MODULE_GAP_COLS. Modules stack top-down inside a column, first fit, in a
 * stable order (the previous composition's, newcomers last). Everything is
 * connected for walking: a corridor runs down every gap column, every module
 * opens its side walls on its walkway row (the free row under its top wall),
 * and one passage is opened through the user's east wall — the only user
 * tiles the composition changes, and only in memory.
 */
import {
  AREA_DEFAULT_COLORS,
  LOUNGE_AREA_LABEL,
  MAX_COLS,
  MAX_ROWS,
  MODULE_AREA_COLORS,
  MODULE_GAP_COLS,
} from '../../constants.js';
import { getCatalogEntry } from '../layout/furnitureCatalog.js';
import { getBlockedTiles, layoutToSeats, migrateLayoutColors } from '../layout/layoutSerializer.js';
import type { AgentDirectory } from '../scope/agentDirectory.js';
import {
  DEFAULT_SCOPE_KIT,
  generateScopeLayout,
  scopeLayoutCapacity,
} from '../scope/scopeLayoutGenerator.js';
import { WORKFLOW_NODE_PREFIX } from '../scope/treeDisplay.js';
import type {
  AreaDefinition,
  CarpetTile,
  ColorValue,
  OfficeLayout,
  PlacedFurniture,
  TileType as TileTypeVal,
} from '../types.js';
import { TileType } from '../types.js';
import { seatTeam } from './moduleSeating.js';

// ── Public shapes (consumed by the engine and the webview integration) ──────

export interface TeamSpec {
  ownerId: number;
  label: string;
  /** The owner's subtree (owner excluded; tolerated if present), BFS order. */
  members: Array<{ id: number; parentId: number }>;
}

export interface LivingModule {
  ownerId: number;
  /** Sanitized, distinct Area label. */
  label: string;
  color: string;
  col: number;
  row: number;
  cols: number;
  rows: number;
  /** agent id → seat uid (a chair uid, stable while the agent stays). */
  seatByAgent: Map<number, string>;
}

export interface LivingOffice {
  /** User layout + modules (+ default door / lounge when missing), areas/areaTiles filled. */
  layout: OfficeLayout;
  modules: LivingModule[];
  /** Tile in front of the door (walk target) and the door furniture uid
   *  ('' only when no wall anywhere can hold a door). */
  door: { col: number; row: number; uid: string };
  /** Seat uids that are rest seats — never to be assigned as desks. Lounge
   *  seats first (the user's lounge Area, else the generated lounge), then
   *  every other beanbag/sofa seat of the user's layout. */
  loungeSeats: string[];
  /** Modules start after this column; the editor edits only [0, userCols). */
  userCols: number;
  /** Owners whose module did not fit (64×64), in team order. */
  queued: number[];
}

// ── Asset ids (T20) ─────────────────────────────────────────────────────────

/**
 * Furniture type ids of the living-office assets. DOOR, ARCADE, GAME_CONSOLE
 * and BEANBAG are created by T20 (`public/assets/furniture/<ID>/manifest.json`,
 * ids verified against its manifests: a single orientation, so no orientation
 * segment — `{BASE}[_{STATE}]`); COFFEE is bundled already. The off/closed
 * variant is placed; the engine toggles the state.
 */
export const LIVING_ASSET_TYPES = {
  doorClosed: 'DOOR_CLOSED',
  doorOpen: 'DOOR_OPEN',
  arcade: 'ARCADE_OFF',
  gameConsole: 'GAME_CONSOLE_OFF',
  beanbag: 'BEANBAG',
  coffee: 'COFFEE',
  smallTable: 'SMALL_TABLE_FRONT',
} as const;

/** Rest-seat families (never desks): matched on the type id's base. */
const REST_SEAT_TYPE_PREFIXES = ['BEANBAG', 'SOFA_'] as const;

const DOOR_TYPES: ReadonlySet<string> = new Set([
  LIVING_ASSET_TYPES.doorClosed,
  LIVING_ASSET_TYPES.doorOpen,
]);

/** Door height when the catalog does not know it (T20: 1×2). */
const DOOR_FALLBACK_HEIGHT = 2;

// ── Labels ──────────────────────────────────────────────────────────────────

/** Longest module label, in code points (ellipsis included). A module is 18
 *  tiles wide; ~28 characters of the pixel font fit across it at any zoom. */
export const MODULE_LABEL_MAX_CHARS = 28;
/** Consecutive combining marks kept per base character (defuses "zalgo"). */
const MAX_COMBINING_MARKS = 2;
const ELLIPSIS = '…';
/** Label of a team with nothing to show: `#<ownerId>`. */
const OWNER_FALLBACK_PREFIX = '#';
/** Letters that render blank (Hangul fillers, the blank Braille pattern). */
const BLANK_FILLERS = /[ᅟᅠㅤﾠ⠀]/gu;
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;

/** Collision key: labels that read alike (compatibility forms, case) collide. */
function labelKey(label: string): string {
  return label.normalize('NFKC').toLowerCase();
}

/**
 * Canvas-safe label: drops control/format characters (bidi overrides,
 * zero-width joiners, NULs), line separators and surplus combining marks,
 * collapses whitespace, and truncates by code point. Lone surrogates and
 * blank-looking fillers count as nothing; a label with no visible letter,
 * digit, symbol or punctuation is ''. Non-strings → ''.
 */
export function sanitizeModuleLabel(raw: string): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/gu, ' ')
    .replace(BLANK_FILLERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const out: string[] = [];
  let marks = 0;
  for (const ch of cleaned) {
    if (/\p{M}/u.test(ch)) {
      if (out.length === 0 || ++marks > MAX_COMBINING_MARKS) continue;
    } else {
      marks = 0;
    }
    out.push(ch);
  }
  if (!out.some((ch) => VISIBLE.test(ch))) return '';
  if (out.length <= MODULE_LABEL_MAX_CHARS) return out.join('');
  return (
    out
      .slice(0, MODULE_LABEL_MAX_CHARS - 1)
      .join('')
      .trimEnd() + ELLIPSIS
  );
}

/** First candidate whose key is not in `taken` (a set of labelKey()s): base,
 *  then `base #owner`, then `base #owner-2`… */
function distinctLabel(base: string, ownerId: number, taken: Set<string>): string {
  if (!taken.has(labelKey(base))) return base;
  const suffix = ` ${OWNER_FALLBACK_PREFIX}${ownerId}`;
  for (let n = 1; ; n++) {
    const tail = n === 1 ? suffix : `${suffix}-${n}`;
    const head = [...base].slice(0, Math.max(0, MODULE_LABEL_MAX_CHARS - [...tail].length));
    const candidate = head.join('').trimEnd() + tail;
    if (!taken.has(labelKey(candidate))) return candidate;
  }
}

/** True when `label` is what distinctLabel() makes of `base` for this owner. */
function isSuffixedFrom(label: string, base: string, ownerId: number): boolean {
  const at = label.lastIndexOf(` ${OWNER_FALLBACK_PREFIX}${ownerId}`);
  if (at < 0) return false;
  const tail = label.slice(at + ` ${OWNER_FALLBACK_PREFIX}${ownerId}`.length);
  return /^(-\d+)?$/.test(tail) && base.startsWith(label.slice(0, at));
}

function colorForOwner(ownerId: number): string {
  const n = Number.isFinite(ownerId) ? Math.trunc(ownerId) : 0;
  const len = MODULE_AREA_COLORS.length;
  return MODULE_AREA_COLORS[((n % len) + len) % len];
}

/** The generated lounge's Area color (a green of the editor's area palette). */
const LOUNGE_AREA_COLOR = AREA_DEFAULT_COLORS[3];

// ── Teams from the agent tree ───────────────────────────────────────────────

const WORKFLOW_ROLE = 'workflow';

/**
 * One team per direct child of a root that has children of its own, and per
 * workflow node (even before its agents appear). A root's childless child is in
 * no team: it sits in the user's office until its first child is born. Members
 * are the owner's subtree in BFS order, capped at the seats a module has.
 */
export function teamsFromDirectory(dir: AgentDirectory): TeamSpec[] {
  const roots = dir.membersOf('root');
  const rootSet = new Set(roots);
  const maxMembers = scopeLayoutCapacity() - 1;
  const teams: TeamSpec[] = [];
  const owned = new Set<number>();
  for (const root of roots) {
    for (const ownerId of dir.childrenOf(root)) {
      if (rootSet.has(ownerId) || owned.has(ownerId)) continue;
      const owner = dir.get(ownerId);
      if (!owner) continue;
      const isWorkflow = owner.role === WORKFLOW_ROLE;
      const kids = dir.childrenOf(ownerId).filter((k) => !rootSet.has(k));
      if (kids.length === 0 && !isWorkflow) continue;
      owned.add(ownerId);

      const members: TeamSpec['members'] = [];
      const visited = new Set<number>([ownerId]);
      const queue = kids.map((id) => ({ id, parentId: ownerId }));
      for (let i = 0; i < queue.length && members.length < maxMembers; i++) {
        const next = queue[i];
        if (visited.has(next.id) || rootSet.has(next.id)) continue;
        visited.add(next.id);
        members.push(next);
        for (const child of dir.childrenOf(next.id)) {
          if (!visited.has(child)) queue.push({ id: child, parentId: next.id });
        }
      }

      const base = owner.label || owner.role || owner.agentName || '';
      teams.push({ ownerId, label: (isWorkflow ? WORKFLOW_NODE_PREFIX : '') + base, members });
    }
  }
  return teams;
}

// ── Composition ─────────────────────────────────────────────────────────────

/** Uid namespace for generated furniture; lengthened if the user's layout
 *  already uses it, so generated uids can never collide with theirs. */
const UID_NAMESPACE = 'living-';
const LOUNGE_KEY = 'lounge';
const DOOR_UID_SUFFIX = 'door';
const CHAIR_UID_INFIX = '-scope-chair-';

/** Row inside a module (and the lounge) left free under the top wall: the
 *  side-wall openings sit on it, so it is the module's through-walkway. */
const WALKWAY_ROW = 1;

/** Generated lounge: one module wide, a wall on top and on both sides. */
const LOUNGE_ROWS = 6;
const LOUNGE_ITEMS: ReadonlyArray<{ key: string; type: string; col: number; row: number }> = [
  { key: 'arcade', type: LIVING_ASSET_TYPES.arcade, col: 2, row: 2 },
  { key: 'console', type: LIVING_ASSET_TYPES.gameConsole, col: 6, row: 4 },
  // Beanbags face the console from the row above (one free row between).
  { key: 'beanbag-0', type: LIVING_ASSET_TYPES.beanbag, col: 5, row: 2 },
  { key: 'beanbag-1', type: LIVING_ASSET_TYPES.beanbag, col: 7, row: 2 },
  { key: 'beanbag-2', type: LIVING_ASSET_TYPES.beanbag, col: 9, row: 2 },
  // Coffee is a surface item: it stands on a small table (like the default layout's).
  { key: 'table', type: LIVING_ASSET_TYPES.smallTable, col: 12, row: 2 },
  { key: 'coffee', type: LIVING_ASSET_TYPES.coffee, col: 12, row: 3 },
];
const LOUNGE_ANCHOR = LOUNGE_ITEMS[0];

type EntryKey = number | typeof LOUNGE_KEY;
interface Placement {
  column: number;
  row: number;
}

const isFloor = (t: TileTypeVal | undefined): boolean =>
  t !== undefined && t !== TileType.WALL && t !== TileType.VOID;

function isRestSeatType(type: string): boolean {
  return REST_SEAT_TYPE_PREFIXES.some((p) => type.startsWith(p));
}

function footprint(type: string): { w: number; h: number } {
  const e = getCatalogEntry(type);
  return { w: e?.footprintW ?? 1, h: e?.footprintH ?? 1 };
}

function uidNamespace(user: OfficeLayout): string {
  let ns = UID_NAMESPACE;
  const uids = user.furniture.map((f) => String(f.uid));
  while (uids.some((u) => u.startsWith(ns))) ns = `_${ns}`;
  return ns;
}

const intOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback;

/**
 * The user layout as composition reads it: arrays where arrays are expected,
 * and only furniture that lies inside the user's own grid (a hand-edited or
 * imported layout could otherwise put a chair or a door inside a module).
 */
function normalizeUser(raw: OfficeLayout, userCols: number, userRows: number): OfficeLayout {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Partial<OfficeLayout>;
  const furniture = (Array.isArray(src.furniture) ? src.furniture : []).filter((f) => {
    if (!f || typeof f !== 'object' || typeof f.type !== 'string') return false;
    if (typeof f.col !== 'number' || typeof f.row !== 'number') return false;
    const { w, h } = footprint(f.type);
    return f.col >= 0 && f.col + w <= userCols && f.row + h > 0 && f.row < userRows;
  });
  return {
    ...(src as OfficeLayout),
    version: 1,
    cols: typeof src.cols === 'number' ? src.cols : 0,
    rows: typeof src.rows === 'number' ? src.rows : 0,
    tiles: Array.isArray(src.tiles) ? src.tiles : [],
    furniture,
    areas: Array.isArray(src.areas)
      ? src.areas.filter((a) => a && typeof a.label === 'string')
      : undefined,
    areaTiles: Array.isArray(src.areaTiles) ? src.areaTiles : undefined,
    tileColors: Array.isArray(src.tileColors) ? src.tileColors : undefined,
    carpetTiles: Array.isArray(src.carpetTiles) ? src.carpetTiles : undefined,
    pets: Array.isArray(src.pets) ? src.pets : [],
  };
}

/** A previous composition's module, if it has the shape we produced. */
function isModuleLike(m: unknown): m is LivingModule {
  if (!m || typeof m !== 'object') return false;
  const x = m as Partial<LivingModule>;
  return (
    typeof x.ownerId === 'number' &&
    typeof x.col === 'number' &&
    typeof x.row === 'number' &&
    x.seatByAgent instanceof Map
  );
}

export function composeLivingOffice(
  rawUser: OfficeLayout,
  teams: TeamSpec[],
  previous?: LivingOffice,
): LivingOffice {
  const userCols = Math.min(intOr(rawUser?.cols, 0), MAX_COLS);
  const userRows = Math.min(intOr(rawUser?.rows, 0), MAX_ROWS);
  const user = normalizeUser(rawUser, userCols, userRows);
  if (previous !== undefined && (!previous || typeof previous !== 'object')) previous = undefined;
  const ns = uidNamespace(user);
  const gap = Math.max(1, MODULE_GAP_COLS);
  const moduleCols = generateScopeLayout(1, DEFAULT_SCOPE_KIT).cols;
  const pitch = moduleCols + gap;
  const columnX = (k: number) => userCols + gap + k * pitch;
  let columnCount = 0;
  while (columnX(columnCount) + moduleCols <= MAX_COLS) columnCount++;

  const userTile = (c: number, r: number): TileTypeVal =>
    (user.tiles[r * user.cols + c] as TileTypeVal | undefined) ?? TileType.VOID;
  const userArea = (c: number, r: number): string | null =>
    user.areaTiles?.[r * user.cols + c] ?? null;

  // ── Lounge: the user's own, or a generated one ──
  let userHasLounge = false;
  for (let r = 0; r < userRows && !userHasLounge; r++) {
    for (let c = 0; c < userCols; c++) {
      if (userArea(c, r) === LOUNGE_AREA_LABEL) {
        userHasLounge = true;
        break;
      }
    }
  }
  const userDefinesLounge = (user.areas ?? []).some((a) => a.label === LOUNGE_AREA_LABEL);
  userHasLounge &&= userDefinesLounge;
  // A lounge Area with nowhere to sit is no lounge: the generated one is added.
  userHasLounge &&= user.furniture.some((item) =>
    [...layoutToSeats([item]).values()].some(
      (s) => userArea(s.seatCol, s.seatRow) === LOUNGE_AREA_LABEL,
    ),
  );

  // ── Teams: dedupe owners, give each agent to the first team that lists it ──
  const previousModules = new Map<number, LivingModule>();
  for (const m of Array.isArray(previous?.modules) ? previous.modules : []) {
    if (isModuleLike(m)) previousModules.set(m.ownerId, m);
  }
  const specs = new Map<number, TeamSpec>();
  for (const t of Array.isArray(teams) ? teams : []) {
    if (!t || typeof t.ownerId !== 'number' || !Number.isFinite(t.ownerId)) continue;
    if (!specs.has(t.ownerId)) specs.set(t.ownerId, t);
  }

  // Stable order: the previous composition's (per column, top-down), newcomers after.
  const prevPlacement = new Map<EntryKey, Placement>();
  if (previous) {
    const prevUserCols = typeof previous.userCols === 'number' ? previous.userCols : userCols;
    const prevColumn = (x: number) => Math.round((x - (prevUserCols + gap)) / pitch);
    for (const m of previousModules.values()) {
      prevPlacement.set(m.ownerId, { column: prevColumn(m.col), row: m.row });
    }
    const prevFurniture: unknown = previous.layout?.furniture;
    const anchor = (Array.isArray(prevFurniture) ? (prevFurniture as PlacedFurniture[]) : []).find(
      (f) => f?.uid === `${ns}${LOUNGE_KEY}-${LOUNGE_ANCHOR.key}`,
    );
    if (anchor && typeof anchor.col === 'number' && typeof anchor.row === 'number') {
      prevPlacement.set(LOUNGE_KEY, {
        column: prevColumn(anchor.col - LOUNGE_ANCHOR.col),
        row: anchor.row - LOUNGE_ANCHOR.row,
      });
    }
  }
  const wanted = new Set<EntryKey>(specs.keys());
  if (!userHasLounge) wanted.add(LOUNGE_KEY);
  const kept = [...prevPlacement.entries()]
    .filter(([key]) => wanted.has(key))
    .sort((a, b) => a[1].column - b[1].column || a[1].row - b[1].row)
    .map(([key]) => key);
  const order: EntryKey[] = [...kept];
  for (const ownerId of specs.keys()) if (!prevPlacement.has(ownerId)) order.push(ownerId);
  if (!userHasLounge && !prevPlacement.has(LOUNGE_KEY)) order.push(LOUNGE_KEY);

  // Seat every team (in order) so heights are known before packing.
  const seated = new Set<number>();
  const seatings = new Map<number, ReturnType<typeof seatTeam>>();
  for (const key of order) {
    if (key === LOUNGE_KEY) continue;
    const spec = specs.get(key)!;
    if (seated.has(key)) continue; // owner already sits in an earlier team
    const members = (Array.isArray(spec.members) ? spec.members : []).filter(
      (m) => m && !seated.has(m.id),
    );
    const prevSlots = new Map<number, number>();
    const prevModule = previousModules.get(key);
    if (prevModule) {
      const prefix = `${ns}${key}${CHAIR_UID_INFIX}`;
      for (const [agentId, uid] of prevModule.seatByAgent) {
        if (typeof uid !== 'string' || !uid.startsWith(prefix)) continue;
        const slot = Number(uid.slice(prefix.length));
        if (Number.isInteger(slot)) prevSlots.set(agentId, slot);
      }
    }
    const seating = seatTeam({ ...spec, members }, prevSlots);
    for (const id of seating.slotByAgent.keys()) seated.add(id);
    seatings.set(key, seating);
  }
  // Heights, once per key (packing may run several times).
  const heights = new Map<EntryKey, number>([[LOUNGE_KEY, LOUNGE_ROWS]]);
  const rowsBySlotCount = new Map<number, number>();
  for (const [key, seating] of seatings) {
    let h = rowsBySlotCount.get(seating.slotCount);
    if (h === undefined) {
      h = generateScopeLayout(seating.slotCount, DEFAULT_SCOPE_KIT).rows;
      rowsBySlotCount.set(seating.slotCount, h);
    }
    heights.set(key, h);
  }
  const heightOf = (key: EntryKey): number => heights.get(key)!;

  // Modules start level with the top of the user's room.
  let startRow = 0;
  findTop: for (let r = 0; r < userRows; r++) {
    for (let c = 0; c < userCols; c++) {
      if (userTile(c, r) !== TileType.VOID) {
        startRow = r;
        break findTop;
      }
    }
  }

  // Rooms that were placed before keep their column (previous columns
  // compacted, so a column that emptied closes up) and their order in it:
  // growing, shrinking or freeing a room only shifts the rooms below it in
  // its own column. Only newcomers — and a room that no longer fits its
  // column — pick a column.
  const stickyColumn = new Map<EntryKey, number>();
  {
    const prevColumns = [...new Set(kept.map((k) => prevPlacement.get(k)!.column))].sort(
      (a, b) => a - b,
    );
    for (const key of kept) {
      const rank = prevColumns.indexOf(prevPlacement.get(key)!.column);
      if (rank >= 0 && rank < columnCount) stickyColumn.set(key, rank);
    }
  }

  const pack = (keys: EntryKey[]): { placed: Map<EntryKey, Placement>; failed: EntryKey[] } => {
    const cursors: number[] = Array.from({ length: columnCount }, () => startRow);
    const used: boolean[] = Array.from({ length: columnCount }, () => false);
    const placed = new Map<EntryKey, Placement>();
    const failed: EntryKey[] = [];
    const floating: EntryKey[] = [];
    for (const key of keys) {
      const k = stickyColumn.get(key);
      if (k === undefined) {
        floating.push(key);
        continue;
      }
      const h = heightOf(key);
      if (cursors[k] + h > MAX_ROWS) {
        floating.push(key);
        continue;
      }
      placed.set(key, { column: k, row: cursors[k] });
      used[k] = true;
      cursors[k] += h;
    }
    for (const key of floating) {
      const h = heightOf(key);
      // Shortest column first (ties: leftmost), so modules spread to the right
      // before they stack; an empty column that is too short from the user's
      // top row takes a tall module bottom-aligned instead.
      let spot: Placement | undefined;
      for (let k = 0; k < columnCount; k++) {
        if (cursors[k] + h <= MAX_ROWS) {
          if (!spot || cursors[k] < spot.row) spot = { column: k, row: cursors[k] };
        }
      }
      for (let k = 0; k < columnCount && !spot; k++) {
        if (!used[k] && h <= MAX_ROWS) spot = { column: k, row: MAX_ROWS - h };
      }
      if (!spot) {
        failed.push(key);
        continue;
      }
      placed.set(key, spot);
      used[spot.column] = true;
      cursors[spot.column] = spot.row + h;
    }
    return { placed, failed };
  };

  const activeOrder = order.filter((k) => k === LOUNGE_KEY || seatings.has(k));
  let packed = pack(activeOrder);
  // A lounge the office never had outranks newcomers: keep the most newcomers
  // (oldest first) that still leave it room. Binary search — fewer newcomers
  // never leave less room — so O(T log T) packs' worth of work, not O(T²).
  if (!userHasLounge && !prevPlacement.has(LOUNGE_KEY) && packed.failed.includes(LOUNGE_KEY)) {
    const newcomers = activeOrder.filter((k) => k !== LOUNGE_KEY && !prevPlacement.has(k));
    const withNewcomers = (n: number) => {
      const keep = new Set<EntryKey>(newcomers.slice(0, n));
      return activeOrder.filter((k) => k === LOUNGE_KEY || prevPlacement.has(k) || keep.has(k));
    };
    const fits = (n: number) => !pack(withNewcomers(n)).failed.includes(LOUNGE_KEY);
    if (fits(0)) {
      let lo = 0; // fits
      let hi = newcomers.length; // does not fit (checked above)
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      packed = pack(withNewcomers(lo));
    }
    // else: the lounge cannot fit even alone — keep every module that fits.
  }
  const { placed } = packed;
  const queued: number[] = [...specs.keys()].filter((k) => seatings.has(k) && !placed.has(k));

  // ── Composite grid ──
  let cols = userCols;
  let rows = userRows;
  const usedColumns = new Set<number>();
  for (const [key, p] of placed) {
    usedColumns.add(p.column);
    cols = Math.max(cols, columnX(p.column) + moduleCols);
    rows = Math.max(rows, p.row + heightOf(key));
  }
  const size = cols * rows;
  const tiles: TileTypeVal[] = new Array<TileTypeVal>(size).fill(TileType.VOID);
  const tileColors: Array<ColorValue | null> = new Array<ColorValue | null>(size).fill(null);
  const areaTiles: Array<string | null> = new Array<string | null>(size).fill(null);
  const carpetTiles: Array<CarpetTile | null> | undefined = user.carpetTiles
    ? new Array<CarpetTile | null>(size).fill(null)
    : undefined;
  const userColors =
    user.tileColors && user.tileColors.length === user.tiles.length
      ? user.tileColors
      : migrateLayoutColors({ ...user, furniture: [] }).tileColors;
  for (let r = 0; r < userRows; r++) {
    for (let c = 0; c < userCols; c++) {
      const src = r * user.cols + c;
      const dst = r * cols + c;
      tiles[dst] = userTile(c, r);
      tileColors[dst] = userColors?.[src] ?? null;
      areaTiles[dst] = userArea(c, r);
      if (carpetTiles) carpetTiles[dst] = user.carpetTiles?.[src] ?? null;
    }
  }
  const generatedFloorColor =
    migrateLayoutColors({
      version: 1,
      cols: 1,
      rows: 1,
      tiles: [TileType.FLOOR_1],
      furniture: [],
    }).tileColors?.[0] ?? null;
  const setTile = (c: number, r: number, t: TileTypeVal, color: ColorValue | null) => {
    tiles[r * cols + c] = t;
    tileColors[r * cols + c] = color;
  };

  const furniture: PlacedFurniture[] = user.furniture.map((f) => ({ ...f }));
  const areas: AreaDefinition[] = (user.areas ?? []).map((a) => ({ ...a }));
  const takenLabels = new Set<string>(areas.map((a) => labelKey(a.label)));
  takenLabels.add(labelKey(LOUNGE_AREA_LABEL));

  // Stamp a generated room (walls + floor + area) at (x, y).
  const stamp = (
    x: number,
    y: number,
    w: number,
    h: number,
    tileAt: (c: number, r: number) => TileTypeVal,
    area: string,
  ) => {
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const t = tileAt(c, r);
        setTile(x + c, y + r, t, isFloor(t) ? generatedFloorColor : null);
        if (isFloor(t)) areaTiles[(y + r) * cols + x + c] = area;
      }
    }
  };

  // ── Team modules ──
  const modules: LivingModule[] = [];
  for (const key of order) {
    if (key === LOUNGE_KEY) continue;
    const p = placed.get(key);
    const seating = seatings.get(key);
    if (!p || !seating) continue;
    const spec = specs.get(key)!;
    const generated = generateScopeLayout(seating.slotCount, DEFAULT_SCOPE_KIT);
    const x = columnX(p.column);
    const y = p.row;
    const base = sanitizeModuleLabel(spec.label) || `${OWNER_FALLBACK_PREFIX}${key}`;
    // Keep last time's disambiguated name while it is still free, so a module's
    // Area does not rename itself when its namesake leaves.
    const prevLabel = previousModules.get(key)?.label;
    const label =
      typeof prevLabel === 'string' &&
      prevLabel !== base &&
      isSuffixedFrom(prevLabel, base, key) &&
      !takenLabels.has(labelKey(prevLabel))
        ? prevLabel
        : distinctLabel(base, key, takenLabels);
    takenLabels.add(labelKey(label));
    const color = colorForOwner(key);
    areas.push({ label, color });
    stamp(
      x,
      y,
      generated.cols,
      generated.rows,
      (c, r) => generated.tiles[r * generated.cols + c],
      label,
    );
    const prefix = `${ns}${key}-`;
    for (const f of generated.furniture) {
      furniture.push({ ...f, uid: prefix + f.uid, col: f.col + x, row: f.row + y });
    }
    const seatByAgent = new Map<number, string>();
    for (const [agentId, slot] of seating.slotByAgent) {
      seatByAgent.set(agentId, `${ns}${key}${CHAIR_UID_INFIX}${slot}`);
    }
    modules.push({
      ownerId: key,
      label,
      color,
      col: x,
      row: y,
      cols: generated.cols,
      rows: generated.rows,
      seatByAgent,
    });
  }

  // ── Generated lounge ──
  const loungeSeatsGenerated: string[] = [];
  const loungePlace = placed.get(LOUNGE_KEY);
  if (loungePlace) {
    const x = columnX(loungePlace.column);
    const y = loungePlace.row;
    // A seatless user lounge Area already defines the label: the generated room joins it.
    if (!userDefinesLounge) areas.push({ label: LOUNGE_AREA_LABEL, color: LOUNGE_AREA_COLOR });
    stamp(
      x,
      y,
      moduleCols,
      LOUNGE_ROWS,
      (c, r) => (r === 0 || c === 0 || c === moduleCols - 1 ? TileType.WALL : TileType.FLOOR_1),
      LOUNGE_AREA_LABEL,
    );
    for (const item of LOUNGE_ITEMS) {
      const uid = `${ns}${LOUNGE_KEY}-${item.key}`;
      furniture.push({ uid, type: item.type, col: x + item.col, row: y + item.row });
      if (item.type === LIVING_ASSET_TYPES.beanbag) loungeSeatsGenerated.push(uid);
    }
  }

  // ── Walkways: side-wall openings, corridors, the passage from the user's room ──
  const walkwayRows = new Map<number, number[]>(); // column → walkway rows of its rooms
  for (const p of placed.values()) {
    const list = walkwayRows.get(p.column) ?? [];
    list.push(p.row + WALKWAY_ROW);
    walkwayRows.set(p.column, list);
  }
  for (const [column, list] of walkwayRows) {
    const x = columnX(column);
    for (const r of list) {
      setTile(x, r, TileType.FLOOR_1, generatedFloorColor);
      if (usedColumns.has(column + 1))
        setTile(x + moduleCols - 1, r, TileType.FLOOR_1, generatedFloorColor);
    }
  }

  // Footprints of everything placed so far (user + generated), for door/passage checks.
  const occupied = new Set<string>();
  for (const f of furniture) {
    const { w, h } = footprint(f.type);
    for (let dr = 0; dr < h; dr++)
      for (let dc = 0; dc < w; dc++) occupied.add(`${f.col + dc},${f.row + dr}`);
  }

  // ── Door ──
  const tileAt = (c: number, r: number): TileTypeVal | undefined =>
    c >= 0 && c < cols && r >= 0 && r < rows ? tiles[r * cols + c] : undefined;
  const walkBlocked = getBlockedTiles(furniture);
  const walkable = (c: number, r: number) => isFloor(tileAt(c, r)) && !walkBlocked.has(`${c},${r}`);
  let door: LivingOffice['door'] | undefined;
  const userDoor = user.furniture.find((f) => DOOR_TYPES.has(f.type));
  if (userDoor) {
    const target = { col: userDoor.col, row: userDoor.row + footprint(userDoor.type).h };
    // The tile in front must be walkable floor of the user's room; a door
    // hung where nobody can stand in front of it is ignored.
    if (target.row < userRows && walkable(target.col, target.row)) {
      door = { ...target, uid: userDoor.uid };
    }
  }
  const doorH = getCatalogEntry(LIVING_ASSET_TYPES.doorClosed)?.footprintH ?? DOOR_FALLBACK_HEIGHT;
  const placeDefaultDoor = (wall: { col: number; row: number }): LivingOffice['door'] => {
    const uid = `${ns}${DOOR_UID_SUFFIX}`;
    furniture.push({
      uid,
      type: LIVING_ASSET_TYPES.doorClosed,
      col: wall.col,
      row: wall.row - (doorH - 1),
    });
    for (let dr = 0; dr < doorH; dr++) occupied.add(`${wall.col},${wall.row - dr}`);
    return { col: wall.col, row: wall.row + 1, uid };
  };
  const removeDefaultDoor = (d: LivingOffice['door']) => {
    const i = furniture.findIndex((f) => f.uid === d.uid);
    if (i >= 0) furniture.splice(i, 1);
    for (let dr = 0; dr < doorH; dr++) occupied.delete(`${d.col},${d.row - 1 - dr}`);
  };
  let doorIsDefault = false;
  /** First exterior wall tile (nothing but VOID/outside above it) in
   *  [fromCol, toCol) with a walkable tile below and room for the door. */
  const scanForDoorWall = (
    fromCol: number,
    toCol: number,
  ): { col: number; row: number } | undefined => {
    for (let r = 0; r < rows; r++) {
      for (let c = fromCol; c < toCol; c++) {
        if (tileAt(c, r) !== TileType.WALL) continue;
        const above = tileAt(c, r - 1);
        if (above !== undefined && above !== TileType.VOID) continue; // interior wall
        if (!isFloor(tileAt(c, r + 1)) || walkBlocked.has(`${c},${r + 1}`)) continue;
        let free = true;
        for (let dr = 0; dr < doorH && free; dr++) free = !occupied.has(`${c},${r - dr}`);
        if (free) return { col: c, row: r };
      }
    }
    return undefined;
  };
  const scanGenerated = () => scanForDoorWall(userCols, cols);
  if (!door) {
    const wall = scanForDoorWall(0, userCols) ?? scanGenerated();
    if (wall) {
      door = placeDefaultDoor(wall);
      doorIsDefault = true;
    }
  }

  /** Walkable tiles of the user's room reachable from `start` (4-connected). */
  const reachableInUserRoom = (start: { col: number; row: number }): Set<string> => {
    const seen = new Set<string>();
    if (start.col >= userCols || !walkable(start.col, start.row)) return seen;
    const queue = [start];
    seen.add(`${start.col},${start.row}`);
    for (let i = 0; i < queue.length; i++) {
      const { col, row } = queue[i];
      for (const [dc, dr] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const c = col + dc;
        const r = row + dr;
        const key = `${c},${r}`;
        if (c >= userCols || seen.has(key) || !walkable(c, r)) continue;
        seen.add(key);
        queue.push({ col: c, row: r });
      }
    }
    return seen;
  };

  // Passage through the user's east wall, on the row with the shortest dig —
  // from the part of the room the door opens into, so the modules are
  // reachable from the entrance.
  let passageRow: number | undefined;
  if (placed.size > 0 && userCols > 0) {
    const findPassage = (reached: Set<string> | undefined) => {
      let best: { row: number; from: number } | undefined;
      for (let r = 0; r < userRows; r++) {
        let f = userCols - 1;
        while (f >= 0 && !isFloor(userTile(f, r))) f--;
        if (f < 0 || walkBlocked.has(`${f},${r}`)) continue;
        if (reached && !reached.has(`${f},${r}`)) continue;
        let clear = true;
        for (let c = f + 1; c < userCols && clear; c++) clear = !occupied.has(`${c},${r}`);
        if (!clear) continue;
        if (!best || f > best.from) best = { row: r, from: f };
      }
      return best;
    };
    const doorInUserRoom = door !== undefined && door.col < userCols;
    let best = findPassage(doorInUserRoom ? reachableInUserRoom(door!) : undefined);
    if (!best && doorInUserRoom && doorIsDefault) {
      // No passage from the door's side of the room: move our door to the
      // generated rooms instead (the user's own door stays where they hung it).
      removeDefaultDoor(door!);
      const wall = scanGenerated();
      door = wall ? placeDefaultDoor(wall) : undefined;
      best = findPassage(undefined);
    }
    if (best) {
      passageRow = best.row;
      const t = userTile(best.from, best.row);
      const color = tileColors[best.row * cols + best.from];
      for (let c = best.from + 1; c < userCols; c++) setTile(c, best.row, t, color);
    }
  }

  // Corridors: gap column k (left of module column k) joins column k-1's and
  // column k's walkway rows (and the passage, for k = 0).
  for (let k = 0; k < columnCount; k++) {
    if (!usedColumns.has(k)) continue;
    const anchors = [...(walkwayRows.get(k) ?? []), ...(walkwayRows.get(k - 1) ?? [])];
    if (k === 0 && passageRow !== undefined) anchors.push(passageRow);
    if (anchors.length === 0) continue;
    const top = Math.min(...anchors);
    const bottom = Math.max(...anchors);
    for (let c = columnX(k) - gap; c < columnX(k); c++) {
      for (let r = top; r <= bottom; r++) setTile(c, r, TileType.FLOOR_1, generatedFloorColor);
    }
  }

  if (!door) {
    // No wall can hold a door: walk from the first walkable tile.
    const walkBlocked = getBlockedTiles(furniture);
    let spot = { col: 0, row: 0 };
    search: for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (isFloor(tileAt(c, r)) && !walkBlocked.has(`${c},${r}`)) {
          spot = { col: c, row: r };
          break search;
        }
      }
    }
    door = { ...spot, uid: '' };
  }

  // ── Rest seats ──
  const loungeSeats: string[] = [];
  const pushSeat = (uid: string) => {
    if (!loungeSeats.includes(uid)) loungeSeats.push(uid);
  };
  const restElsewhere: string[] = [];
  for (const item of user.furniture) {
    for (const seat of layoutToSeats([item]).values()) {
      if (userHasLounge && userArea(seat.seatCol, seat.seatRow) === LOUNGE_AREA_LABEL) {
        pushSeat(seat.uid);
      } else if (isRestSeatType(item.type)) {
        restElsewhere.push(seat.uid);
      }
    }
  }
  for (const uid of loungeSeatsGenerated) pushSeat(uid);
  for (const uid of restElsewhere) pushSeat(uid);

  const layout: OfficeLayout = {
    ...user,
    cols,
    rows,
    tiles,
    tileColors,
    furniture,
    pets: user.pets ?? [],
    areas,
    areaTiles,
    ...(carpetTiles ? { carpetTiles } : {}),
  };

  return { layout, modules, door, loungeSeats, userCols, queued };
}
