/**
 * Wires the living office (docs/adr/0003, spec §3) into the running office:
 * keeps the agent tree (AgentDirectory) current, recomposes the office when the
 * tree changes — the user's layout plus one module per team, a default door and
 * lounge — and animates the derived agents' lives on it: they enter through the
 * door to their desk, rest in the lounge, walk back, and leave waving.
 *
 * DOM-free: it drives an OfficeState and nothing else, so it runs under the
 * Node test runner. The React side (useExtensionMessages, useEditorActions,
 * App) only forwards wire messages and editor transitions to it.
 *
 * Invariants:
 * - The user's layout is kept apart from the composed one. Only the user's
 *   layout is ever handed out for saving (`savableLayout`), and the editor sees
 *   only it (`enterEditMode`).
 * - Nothing composes before the furniture catalog is loaded (footprints and
 *   seats come from it) or while nobody derived is in the office: without a
 *   derived agent there is nobody to enter, rest or leave, so the office stays
 *   exactly the user's.
 * - Session roots keep their own lifecycle (matrix spawn / despawn). Presence
 *   is only animated for derived agents; a root is never sent out the door.
 * - Recomposition is event-driven and idempotent: the same tree composes to the
 *   same office, and an unchanged team list does not rebuild anything.
 */
import {
  IDLE_TO_LOUNGE_MINUTES_MAX,
  IDLE_TO_LOUNGE_MINUTES_MIN,
  LEAVE_WALK_MAX_MS,
  LOUNGE_TO_LEAVE_MINUTES_MAX,
  LOUNGE_TO_LEAVE_MINUTES_MIN,
} from '../../constants.js';
import type { LivingPresence, OfficeState } from '../engine/officeState.js';
import { AgentDirectory } from '../scope/agentDirectory.js';
import type { OfficeLayout } from '../types.js';
import type { LivingOffice, TeamSpec } from './composeOffice.js';
import { composeLivingOffice, teamsFromDirectory } from './composeOffice.js';

/** How a derived agent joins the office. */
export type DerivedEntrance = 'enter' | 'restore';

/** What the office needs to draw a derived agent. */
export interface DerivedAgentInit {
  parentAgentId: number;
  palette?: number;
  hueShift?: number;
  folderName?: string;
  /** Name over its head (treeDisplayName). */
  agentName?: string;
  teamName?: string;
  /** Its last desk (existingAgents), kept when it has no module desk. */
  seatId?: string;
}

/** Tree fields `upsertAgent` accepts (the directory's own mergeable fields). */
export type AgentTreeFields = Parameters<AgentDirectory['upsert']>[1];

const PRESENCES: ReadonlySet<string> = new Set(['working', 'available', 'lounge', 'leaving']);

/** A presence value off the wire, or undefined when it is not one. */
export function parsePresence(value: unknown): LivingPresence | undefined {
  return typeof value === 'string' && PRESENCES.has(value) ? (value as LivingPresence) : undefined;
}

/** A wire agent id we accept: a positive safe integer. Server agent ids start
 *  at 1; zero and negatives belong to the office itself (sub-agent sprites
 *  count down from -1, the greeter), so a message must never address them. */
export function isWireAgentId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Typed minutes (plain decimal digits) clamped to [min, max], or null for anything else. */
function clampTypedMinutes(raw: string, min: number, max: number): number | null {
  const text = raw.trim();
  if (!/^\d{1,6}$/.test(text)) return null;
  return Math.min(max, Math.max(min, Number(text)));
}

/** Typed idle-to-lounge minutes clamped to the server's range, or null for anything else. */
export function clampIdleToLoungeMinutes(raw: string): number | null {
  return clampTypedMinutes(raw, IDLE_TO_LOUNGE_MINUTES_MIN, IDLE_TO_LOUNGE_MINUTES_MAX);
}

/** Typed lounge-to-leave minutes clamped to the server's range, or null for anything else. */
export function clampLoungeToLeaveMinutes(raw: string): number | null {
  return clampTypedMinutes(raw, LOUNGE_TO_LEAVE_MINUTES_MIN, LOUNGE_TO_LEAVE_MINUTES_MAX);
}

/** The effective timings a `livingOfficeSettings` (or `settingsLoaded`)
 *  message carries: each one only when it is an integer inside its range. */
export function parseLivingOfficeTimings(msg: Record<string, unknown>): {
  idleToLoungeMinutes?: number;
  loungeToLeaveMinutes?: number;
} {
  const minutes = (v: unknown, min: number, max: number): number | undefined =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
  return {
    idleToLoungeMinutes: minutes(
      msg.idleToLoungeMinutes,
      IDLE_TO_LOUNGE_MINUTES_MIN,
      IDLE_TO_LOUNGE_MINUTES_MAX,
    ),
    loungeToLeaveMinutes: minutes(
      msg.loungeToLeaveMinutes,
      LOUNGE_TO_LEAVE_MINUTES_MIN,
      LOUNGE_TO_LEAVE_MINUTES_MAX,
    ),
  };
}

export interface LivingOfficeControllerOptions {
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

function teamsSignature(teams: TeamSpec[]): string {
  return JSON.stringify(
    teams.map((t) => [t.ownerId, t.label, t.members.map((m) => [m.id, m.parentId])]),
  );
}

export class LivingOfficeController {
  readonly directory = new AgentDirectory();
  private userLayout: OfficeLayout | null = null;
  /** The last composition. Kept while editing (the next one stays stable with it). */
  private living: LivingOffice | null = null;
  private lastSignature = '';
  private catalogReady = false;
  private editing = false;
  /** Owners that have a module: they keep it until they leave themselves. */
  private keepOwners = new Set<number>();
  /** Furniture uids the last composition generated (never the user's). */
  private generatedUids = new Set<string>();
  /** Every composed layout ever put on screen, and every uid any composition
   *  generated: savableLayout recognizes a composed layout (or one derived from
   *  it) even after the composition that made it was dropped. */
  private readonly composedLayouts = new WeakSet<OfficeLayout>();
  private readonly everGeneratedUids = new Set<string>();
  /** Agents placed as derived. Fixed at creation: a later message giving a
   *  root a parent never turns it into something that can be walked out. */
  private readonly derivedIds = new Set<number>();
  /** Derived agents announced before the user's layout was known. */
  private readonly pending = new Map<number, { init: DerivedAgentInit; how: DerivedEntrance }>();
  /** Leavers' safety timers: a walk-out that outlasts LEAVE_WALK_MAX_MS is cut to the fade. */
  private readonly leaveTimers = new Map<number, unknown>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private readonly getOfficeState: () => OfficeState;

  constructor(getOfficeState: () => OfficeState, opts: LivingOfficeControllerOptions = {}) {
    this.getOfficeState = getOfficeState;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  // ── Readiness and layout ──────────────────────────────────────

  /** The furniture catalog is (re)built: composition may start. */
  markCatalogReady(): void {
    this.catalogReady = true;
    if (this.userLayout && !this.editing) {
      this.recompose(true);
      this.flushPending();
    }
  }

  /** The user's own layout arrived (layoutLoaded, an import, another window's
   *  save). Rebuilds the office from it — composed when there is a tree.
   *  Derived agents announced earlier wait for `flushPending()`. */
  setUserLayout(layout: OfficeLayout): void {
    this.userLayout = layout;
    this.forgetUserUids(layout);
    const os = this.getOfficeState();
    if (this.editing) {
      os.rebuildFromLayout(layout);
    } else if (this.shouldCompose()) {
      this.recompose(true);
    } else {
      this.dropComposition();
      os.rebuildFromLayout(layout);
    }
  }

  /** The user's layout (never the composed one); falls back to what is shown
   *  before any layoutLoaded. */
  getUserLayout(): OfficeLayout {
    return this.userLayout ?? this.getOfficeState().getLayout();
  }

  /** Whether the office currently shows a composition (modules, door, lounge). */
  isComposed(): boolean {
    return this.living !== null && !this.editing;
  }

  /** The composition on screen, if any (read-only use). */
  getLiving(): LivingOffice | null {
    return this.isComposed() ? this.living : null;
  }

  /**
   * The layout to persist for `layout`: itself when it is the user's, else the
   * user's own. A composed layout (or one derived from it — it carries the
   * composition's generated uids) is never written to layout.json.
   */
  savableLayout(layout: OfficeLayout): OfficeLayout {
    const composed =
      this.composedLayouts.has(layout) ||
      (Array.isArray(layout?.furniture) &&
        this.everGeneratedUids.size > 0 &&
        layout.furniture.some((f) => this.everGeneratedUids.has(String(f?.uid))));
    if (!composed) return layout;
    // A bug upstream handed us the composition: never persist it.
    console.error('[Webview] Refusing to save the composed living office; saving the user layout');
    return (
      this.userLayout ?? {
        ...layout,
        furniture: layout.furniture.filter((f) => !this.everGeneratedUids.has(String(f.uid))),
      }
    );
  }

  /** The editor opens: show the user's layout alone (modules hidden). */
  enterEditMode(): void {
    if (this.editing) return;
    this.editing = true;
    const os = this.getOfficeState();
    os.livingAreaLabels = new Set();
    // Module members lose their desk while the modules are hidden, but must
    // not take the user's desks meanwhile: they get theirs back on exit.
    const inModules = new Set<number>();
    for (const ch of os.characters.values()) {
      if (ch.seatId && os.isComposedSeat(ch.seatId)) inModules.add(ch.id);
    }
    os.clearLivingTargets();
    // Held for the whole edit: every rebuild the editor makes skips them.
    os.setSeatlessHold(inModules);
    if (this.living && this.userLayout) {
      os.rebuildFromLayout(this.userLayout, undefined, { preservePositions: true });
    }
  }

  /** The editor closes with `edited` as the user's layout: recompose around it. */
  exitEditMode(edited: OfficeLayout): void {
    if (!this.editing) return;
    this.editing = false;
    this.getOfficeState().setSeatlessHold([]);
    this.userLayout = edited;
    if (this.shouldCompose()) this.recompose(true);
    else this.dropComposition();
    this.flushPending();
  }

  // ── Agents ────────────────────────────────────────────────────

  /** Whether `id` was placed as a derived agent. */
  isDerived(id: number): boolean {
    return this.derivedIds.has(id);
  }

  /**
   * Record what the wire says about `id` in the tree. Guards the invariants
   * the wire must not break: `leaving` is final (a replayed older presence
   * never revives an agent on its way out), and an agent already on the floor
   * as a root never gains a parent.
   */
  upsertAgent(id: number, fields: AgentTreeFields): void {
    const next: Record<string, unknown> = { ...fields };
    if (this.directory.get(id)?.presence === 'leaving') delete next.presence;
    if (this.getOfficeState().characters.has(id) && !this.derivedIds.has(id)) {
      delete next.parentAgentId;
    }
    this.directory.upsert(id, next as AgentTreeFields);
  }

  /** The tree may have changed for agents already on the floor (a reconnect's
   *  existingAgents): recompose if the teams changed. */
  refresh(): void {
    this.recompose();
  }

  /**
   * Put a derived agent in the office: at its team module's desk when it has a
   * team, else at a free desk of the user's office. `enter` walks it in from
   * the door; `restore` (a reconnect replaying existing agents) seats it at
   * once. Its current presence (from the directory) is animated right after.
   * Upsert the agent into `directory` first.
   */
  placeDerived(id: number, init: DerivedAgentInit, how: DerivedEntrance): void {
    const os = this.getOfficeState();
    if (os.characters.has(id)) return; // already here (a root stays a root)
    this.derivedIds.add(id);
    if (!this.userLayout) {
      this.pending.set(id, { init, how });
      return;
    }
    this.pending.delete(id);
    this.recompose();
    const kept =
      init.seatId !== undefined && os.canAssignSeatByHand(init.seatId) ? init.seatId : undefined;
    const seat = this.seatFor(id) ?? kept;
    if (this.isComposed()) {
      os.addAgent(id, init.palette, init.hueShift, seat, true, init.folderName);
      if (how === 'enter') os.enterThroughDoor(id, os.characters.get(id)?.seatId ?? '');
    } else {
      // No composition (catalog not loaded): the ordinary placement, next to
      // its parent. The catalog's arrival composes and walks it to its module.
      os.addAgent(
        id,
        init.palette,
        init.hueShift,
        undefined,
        how === 'restore',
        init.folderName,
        init.parentAgentId,
      );
    }
    const ch = os.characters.get(id);
    if (ch) {
      ch.leadAgentId = init.parentAgentId;
      if (init.agentName !== undefined) ch.agentName = init.agentName;
      if (init.teamName !== undefined) ch.teamName = init.teamName;
    }
    // A restored agent already resting appears in the lounge (no walk from
    // its desk on opening the office); one entering live walks there.
    this.animatePresence(id, how === 'restore');
  }

  /** The server says `id` is in a new stage of its office life. Roots have no
   *  presence: ignored for them, so a root is never walked out the door. */
  setPresence(id: number, presence: LivingPresence): void {
    const agent = this.directory.get(id);
    if (!agent || !this.derivedIds.has(id)) return;
    if (agent.presence === 'leaving') return; // final
    this.directory.upsert(id, { presence });
    this.animatePresence(id);
  }

  /**
   * The server removed `id`. A root rains out (matrix). A derived agent walks
   * out through the door and says goodbye first — even when the server's
   * removal lands mid-walk: it stays in the tree (its module stays) until it
   * is actually gone.
   */
  agentClosed(id: number): void {
    const os = this.getOfficeState();
    this.pending.delete(id);
    const ch = os.characters.get(id);
    if (this.isDerived(id) && ch && ch.matrixEffect !== 'despawn') {
      this.directory.upsert(id, { presence: 'leaving' });
      this.startLeaving(id);
      return;
    }
    os.removeAgent(id);
    this.forget(id);
  }

  /** Stop every timer (unmount). */
  dispose(): void {
    for (const handle of this.leaveTimers.values()) this.clearTimer(handle);
    this.leaveTimers.clear();
  }

  // ── Internals ─────────────────────────────────────────────────

  private hasDerived(): boolean {
    return this.derivedIds.size > 0;
  }

  /** A uid of the user's own layout is theirs, whatever an earlier composition
   *  generated under that name. */
  private forgetUserUids(layout: OfficeLayout): void {
    if (this.everGeneratedUids.size === 0 || !Array.isArray(layout?.furniture)) return;
    for (const f of layout.furniture) this.everGeneratedUids.delete(String(f?.uid));
  }

  private shouldCompose(): boolean {
    return this.catalogReady && this.userLayout !== null && !this.editing && this.hasDerived();
  }

  /** Seat uid of `id` in its team's module, if it has one. */
  private seatFor(id: number): string | undefined {
    if (!this.isComposed()) return undefined;
    for (const m of this.living!.modules) {
      const uid = m.seatByAgent.get(id);
      if (uid !== undefined) return uid;
    }
    return undefined;
  }

  /** Back to the user's layout alone (no derived agent left, or no catalog). */
  private dropComposition(): void {
    const os = this.getOfficeState();
    os.livingAreaLabels = new Set();
    if (!this.living) return;
    os.clearLivingTargets();
    this.living = null;
    this.lastSignature = '';
    this.keepOwners = new Set();
    this.generatedUids = new Set();
    if (this.userLayout && !this.editing) {
      os.rebuildFromLayout(this.userLayout, undefined, { preservePositions: true });
    }
  }

  /**
   * Compose the office for the current tree and put it on screen, keeping
   * every character where it stands; then walk anyone whose desk changed.
   * Skipped when the team list is unchanged (unless `force`: the layout or the
   * catalog changed).
   */
  private recompose(force = false): void {
    if (!this.userLayout || this.editing) return;
    if (!this.shouldCompose()) {
      this.dropComposition();
      return;
    }
    const keep = new Set([...this.keepOwners].filter((id) => this.directory.get(id)));
    const teams = teamsFromDirectory(this.directory, keep);
    const signature = teamsSignature(teams);
    if (!force && this.living && signature === this.lastSignature) return;

    const next = composeLivingOffice(this.userLayout, teams, this.living ?? undefined);
    this.living = next;
    this.lastSignature = signature;
    this.keepOwners = new Set(next.modules.map((m) => m.ownerId));
    const userUids = new Set(this.userLayout.furniture.map((f) => String(f.uid)));
    this.generatedUids = new Set(
      next.layout.furniture.map((f) => String(f.uid)).filter((uid) => !userUids.has(uid)),
    );
    this.composedLayouts.add(next.layout);
    for (const uid of this.generatedUids) this.everGeneratedUids.add(uid);

    const os = this.getOfficeState();
    // Composed seats are known before the rebuild re-seats anyone, so nobody
    // of the user's office is handed a module chair.
    os.setComposedUids(this.generatedUids);
    os.rebuildFromLayout(next.layout, undefined, { preservePositions: true });
    os.setLivingTargets({ door: next.door, loungeSeats: next.loungeSeats });
    const labels = new Set(next.modules.map((m) => m.label));
    for (const a of next.layout.areas ?? []) {
      if (!(this.userLayout.areas ?? []).some((u) => u.label === a.label)) labels.add(a.label);
    }
    os.livingAreaLabels = labels;
    this.applySeatPlan();
  }

  /** Walk every derived agent whose desk moved (into its module, or out of a
   *  module it no longer belongs to) to its new desk; then give a desk to
   *  anyone still without one (a desk freed up, or the editor just closed). */
  private applySeatPlan(): void {
    const os = this.getOfficeState();
    // Two phases, so two agents trading desks (moving between teams in the same
    // recomposition) never block each other: first everyone who moves lets go
    // of the desk they hold, then everyone takes the new one.
    const moves: Array<{ id: number; want: string | undefined }> = [];
    for (const id of this.derivedIds) {
      const ch = os.characters.get(id);
      if (!ch || os.isLeavingAgent(id)) continue;
      const want = this.seatFor(id);
      if (want !== undefined ? ch.seatId !== want : !ch.seatId || os.isComposedSeat(ch.seatId)) {
        moves.push({ id, want });
        os.releaseSeat(id);
      }
    }
    for (const { id, want } of moves) {
      const ch = os.characters.get(id);
      const desk = want ?? os.pickDeskSeat(ch?.folderName);
      if (desk) os.moveToSeat(id, desk);
    }
    for (const ch of [...os.characters.values()]) {
      if (ch.seatId || ch.isSubagent || ch.matrixEffect === 'despawn') continue;
      if (os.isLeavingAgent(ch.id)) continue;
      const desk = os.pickDeskSeat(ch.folderName);
      if (desk) os.moveToSeat(ch.id, desk);
    }
  }

  private animatePresence(id: number, instant = false): void {
    const presence = this.directory.get(id)?.presence;
    if (presence === undefined) return;
    const os = this.getOfficeState();
    if (!os.characters.has(id)) return;
    if (presence === 'leaving') this.startLeaving(id);
    else os.setPresence(id, presence, instant);
  }

  private startLeaving(id: number): void {
    const os = this.getOfficeState();
    os.leaveThroughDoor(id, () => this.gone(id));
    if (!this.leaveTimers.has(id)) {
      // A walk that runs this long (a very long route) is cut to the fade.
      this.leaveTimers.set(
        id,
        this.setTimer(() => this.getOfficeState().removeAgent(id), LEAVE_WALK_MAX_MS),
      );
    }
  }

  /** A leaver walked out: it leaves the tree now (its module may be freed). */
  private gone(id: number): void {
    this.forget(id);
  }

  private forget(id: number): void {
    const handle = this.leaveTimers.get(id);
    if (handle !== undefined) {
      this.clearTimer(handle);
      this.leaveTimers.delete(id);
    }
    this.derivedIds.delete(id);
    if (!this.directory.get(id)) return;
    this.directory.remove(id);
    this.keepOwners.delete(id);
    this.recompose();
  }

  /** Place the derived agents held back until the user's layout was known.
   *  Call after the restored roots are seated, so none of them loses its desk. */
  flushPending(): void {
    if (!this.userLayout || this.pending.size === 0) return;
    const entries = [...this.pending];
    this.pending.clear();
    for (const [id, { init, how }] of entries) {
      if (this.directory.get(id)) this.placeDerived(id, init, how);
    }
  }
}
