/**
 * The living office wired to a running OfficeState (docs/adr/0003, spec §3):
 * the tree recomposes the office, derived agents enter through the door to
 * their module desk, presence is animated, leavers walk out before they are
 * dropped from the tree, the editor and the save path only ever see the user's
 * layout.
 *
 * Real OfficeState, real catalog (the bundled manifests), the shipped default
 * layout as the user's office. No React: the controller is what
 * useExtensionMessages / useEditorActions forward to.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildFurnitureCatalog } from '../../core/src/assets/build.ts';
import { decodeAllFurniture } from '../../core/src/assets/loader.ts';
import { LOUNGE_AREA_LABEL } from '../src/constants.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { buildDynamicCatalog } from '../src/office/layout/furnitureCatalog.js';
import {
  clampIdleToLoungeMinutes,
  clampLoungeToLeaveMinutes,
  type DerivedAgentInit,
  isWireAgentId,
  LivingOfficeController,
  parseLivingOfficeTimings,
  parsePresence,
} from '../src/office/living/livingOfficeController.js';
import { scopeLayoutCapacity } from '../src/office/scope/scopeLayoutGenerator.js';
import type { OfficeLayout } from '../src/office/types.js';
import { CharacterState } from '../src/office/types.js';

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

function userLayout(): OfficeLayout {
  return structuredClone(DEFAULT_LAYOUT);
}

/** Manual timers: the leave safety net fires only when a test says so. */
class FakeTimers {
  private next = 1;
  readonly pending = new Map<number, () => void>();
  set = (fn: () => void): unknown => {
    const id = this.next++;
    this.pending.set(id, fn);
    return id;
  };
  clear = (h: unknown): void => {
    this.pending.delete(h as number);
  };
  fireAll(): void {
    const fns = [...this.pending.values()];
    this.pending.clear();
    for (const fn of fns) fn();
  }
}

let os: OfficeState;
let timers: FakeTimers;
let living: LivingOfficeController;

const ROOT = 1;

function setup(opts: { catalog?: boolean; layout?: boolean } = {}): void {
  os = new OfficeState();
  timers = new FakeTimers();
  living = new LivingOfficeController(() => os, { setTimer: timers.set, clearTimer: timers.clear });
  if (opts.catalog !== false) living.markCatalogReady();
  if (opts.layout !== false) living.setUserLayout(userLayout());
  // The root session, as useExtensionMessages adds it (matrix spawn).
  living.directory.upsert(ROOT, {});
  os.addAgent(ROOT, 0, 0, undefined, true);
}

/** agentCreated for a derived agent, the way useExtensionMessages forwards it. */
function spawn(
  id: number,
  parentAgentId: number,
  how: 'enter' | 'restore' = 'enter',
  fields: { label?: string; presence?: 'working' | 'available' | 'lounge' | 'leaving' } = {},
): void {
  living.directory.upsert(id, { parentAgentId, ...fields });
  const init: DerivedAgentInit = { parentAgentId, agentName: fields.label };
  living.placeDerived(id, init, how);
}

function tick(seconds: number, step = 0.05): void {
  for (let t = 0; t < seconds; t += step) os.update(step);
}

function moduleOf(ownerId: number) {
  return living.getLiving()?.modules.find((m) => m.ownerId === ownerId);
}

beforeEach(() => setup());

describe('composition follows the tree', () => {
  it('stays the plain user layout while nobody derived is in the office', () => {
    expect(living.isComposed()).toBe(false);
    expect(os.getLayout().cols).toBe(DEFAULT_LAYOUT.cols);
    expect(os.getLayout().areas ?? []).toEqual(DEFAULT_LAYOUT.areas ?? []);
    expect(os.livingAreaLabels.size).toBe(0);
  });

  it('a lone derived agent enters through the door to a desk of the user office', () => {
    spawn(10, ROOT);
    expect(living.isComposed()).toBe(true);
    const lounge = (os.getLayout().areas ?? []).find((a) => a.label === LOUNGE_AREA_LABEL);
    expect(lounge).toBeDefined(); // the generated lounge
    const ch = os.characters.get(10)!;
    const door = living.getLiving()!.door;
    expect([ch.tileCol, ch.tileRow]).toEqual([door.col, door.row]);
    expect(ch.seatId).not.toBeNull();
    expect(os.isComposedSeat(ch.seatId!)).toBe(false); // no team: the user's office
    expect(os.isLeavingAgent(10)).toBe(false);
  });

  it('a team gets a named module; its members walk in to their module desks', () => {
    spawn(10, ROOT, 'enter', { label: 'Fase 1 · Auth' });
    living.directory.upsert(10, { label: 'Fase 1 · Auth' });
    spawn(11, 10);
    const m = moduleOf(10)!;
    expect(m.label).toBe('Fase 1 · Auth');
    expect(os.livingAreaLabels.has('Fase 1 · Auth')).toBe(true);
    expect(os.characters.get(11)!.seatId).toBe(m.seatByAgent.get(11));
    // The owner, already inside, is sent to its head desk (it walks, no teleport).
    expect(os.characters.get(10)!.seatId).toBe(m.seatByAgent.get(10));
    expect(os.seatZone(m.seatByAgent.get(11)!)).toBe('Fase 1 · Auth');
  });

  it('an owner that gets its first child walks to its module — nobody is teleported', () => {
    spawn(10, ROOT);
    tick(20); // walked in, seated in the user office
    const before = os.characters.get(10)!;
    const at = [before.tileCol, before.tileRow];
    expect(os.isComposedSeat(before.seatId!)).toBe(false);
    spawn(11, 10);
    const owner = os.characters.get(10)!;
    expect([owner.tileCol, owner.tileRow]).toEqual(at); // same tile right after the rebuild
    expect(owner.seatId).toBe(moduleOf(10)!.seatByAgent.get(10));
    expect(owner.state).toBe(CharacterState.WALK);
    tick(30);
    const seat = os.seats.get(owner.seatId!)!;
    expect([owner.tileCol, owner.tileRow]).toEqual([seat.seatCol, seat.seatRow]);
  });

  it('an unchanged tree does not rebuild (no recomposition loop)', () => {
    spawn(10, ROOT);
    spawn(11, 10);
    const layout = os.getLayout();
    living.setPresence(11, 'available');
    living.setPresence(11, 'working');
    living.placeDerived(11, { parentAgentId: 10 }, 'enter'); // already here: no-op
    expect(os.getLayout()).toBe(layout);
  });

  it('members past a module capacity sit in the user office', () => {
    spawn(10, ROOT);
    const capacity = scopeLayoutCapacity();
    for (let i = 0; i < capacity + 2; i++) spawn(100 + i, 10, 'restore');
    const m = moduleOf(10)!;
    const overflow = 100 + capacity + 1;
    expect(m.seatByAgent.has(overflow)).toBe(false);
    const seat = os.characters.get(overflow)!.seatId;
    if (seat !== null) expect(os.isComposedSeat(seat)).toBe(false);
  });

  it('restored derived agents sit straight at their desks (no door walk)', () => {
    spawn(10, ROOT, 'restore');
    spawn(11, 10, 'restore');
    const ch = os.characters.get(11)!;
    const seat = os.seats.get(ch.seatId!)!;
    expect([ch.tileCol, ch.tileRow]).toEqual([seat.seatCol, seat.seatRow]);
  });

  it('waits for the catalog before composing, then walks everyone to their modules', () => {
    setup({ catalog: false });
    spawn(10, ROOT);
    spawn(11, 10);
    expect(living.isComposed()).toBe(false);
    expect(os.characters.has(11)).toBe(true); // placed the ordinary way meanwhile
    living.markCatalogReady();
    expect(living.isComposed()).toBe(true);
    expect(os.characters.get(11)!.seatId).toBe(moduleOf(10)!.seatByAgent.get(11));
  });

  it('holds derived agents announced before the layout until flushPending', () => {
    setup({ layout: false });
    spawn(10, ROOT);
    expect(os.characters.has(10)).toBe(false);
    living.setUserLayout(userLayout());
    living.flushPending();
    expect(os.characters.has(10)).toBe(true);
  });
});

describe('presence and leaving', () => {
  it('never walks a root out the door', () => {
    living.setPresence(ROOT, 'leaving');
    expect(os.isLeavingAgent(ROOT)).toBe(false);
    living.setPresence(ROOT, 'lounge');
    expect(os.characters.get(ROOT)!.presence).toBeUndefined();
  });

  it('available keeps the agent at its desk; lounge walks it to a rest seat', () => {
    spawn(10, ROOT);
    spawn(11, 10);
    tick(30);
    const desk = os.characters.get(11)!.seatId;
    living.setPresence(11, 'available');
    expect(os.characters.get(11)!.seatId).toBe(desk);
    expect(os.characters.get(11)!.scripted).toBeFalsy();
    living.setPresence(11, 'lounge');
    expect(os.characters.get(11)!.scripted).toBe(true);
    tick(40);
    const ch = os.characters.get(11)!;
    const rest = living.getLiving()!.loungeSeats.map((uid) => os.seats.get(uid)!);
    expect(rest.some((s) => s.seatCol === ch.tileCol && s.seatRow === ch.tileRow)).toBe(true);
    expect(ch.seatId).toBe(desk); // keeps the desk to come back to
  });

  it('a leaver walks out, and only then leaves the tree; the module is freed with the team', () => {
    spawn(10, ROOT, 'enter', { label: 'Fase 1' });
    spawn(11, 10);
    spawn(12, 10);
    tick(30);
    living.setPresence(11, 'leaving');
    expect(os.isLeavingAgent(11)).toBe(true);
    // The server removes it while it is still walking: the walk is not cut.
    living.agentClosed(11);
    expect(os.characters.has(11)).toBe(true);
    expect(os.characters.get(11)!.state).toBe(CharacterState.WALK);
    expect(living.directory.get(11)).toBeDefined();
    tick(40);
    expect(os.characters.has(11)).toBe(false);
    expect(living.directory.get(11)).toBeUndefined();
    expect(moduleOf(10)).toBeDefined(); // owner and 12 are still here

    living.setPresence(12, 'leaving');
    tick(40);
    // The owner keeps its module while it stays (its desk does not move away).
    expect(moduleOf(10)).toBeDefined();
    living.setPresence(10, 'leaving');
    tick(40);
    expect(moduleOf(10)).toBeUndefined();
    // Nobody derived left: the office is the user's again.
    expect(living.isComposed()).toBe(false);
    expect(os.getLayout().cols).toBe(DEFAULT_LAYOUT.cols);
  });

  it('a walk-out that runs too long is cut to the fade by the safety timer', () => {
    spawn(10, ROOT);
    tick(30);
    living.setPresence(10, 'leaving');
    expect(timers.pending.size).toBe(1);
    timers.fireAll();
    tick(1);
    expect(os.characters.has(10)).toBe(false);
    expect(living.directory.get(10)).toBeUndefined();
  });

  it('agentClosed of a root rains it out and forgets it', () => {
    living.agentClosed(ROOT);
    expect(os.characters.get(ROOT)?.matrixEffect).toBe('despawn');
    expect(living.directory.get(ROOT)).toBeUndefined();
  });

  it('an agent restored resting (it finished long ago) appears in the lounge, never walking there', () => {
    spawn(10, ROOT, 'restore', { presence: 'lounge' });
    const ch = os.characters.get(10)!;
    const rest = living.getLiving()!.loungeSeats.map((uid) => os.seats.get(uid)!);
    expect(rest.some((s) => s.seatCol === ch.tileCol && s.seatRow === ch.tileRow)).toBe(true);
    expect(ch.state).not.toBe(CharacterState.WALK);
    expect(ch.path).toEqual([]);
    expect(ch.seatId).not.toBeNull(); // it keeps a desk to come back to
    // A live one entering resting still walks in from the door.
    spawn(11, ROOT, 'enter', { presence: 'lounge' });
    const door = living.getLiving()!.door;
    const entering = os.characters.get(11)!;
    expect([entering.tileCol, entering.tileRow]).toEqual([door.col, door.row]);
  });

  it('a derived agent born leaving walks straight out', () => {
    spawn(10, ROOT, 'restore', { presence: 'leaving' });
    expect(os.isLeavingAgent(10)).toBe(true);
  });
});

describe('the user layout is the only one saved or edited', () => {
  it('savableLayout swaps a composed layout (or one derived from it) for the user layout', () => {
    const user = userLayout();
    living.setUserLayout(user);
    spawn(10, ROOT);
    spawn(11, 10);
    const composed = os.getLayout();
    expect(composed).not.toBe(user);
    expect(living.savableLayout(composed)).toBe(user);
    const derivedFromComposed = { ...composed, furniture: composed.furniture.slice(1) };
    expect(living.savableLayout(derivedFromComposed)).toBe(user);
    const edited = { ...user, furniture: user.furniture.slice(1) };
    expect(living.savableLayout(edited)).toBe(edited);
  });

  it('edit mode shows only the user layout and recomposes on exit', () => {
    const user = userLayout();
    living.setUserLayout(user);
    spawn(10, ROOT);
    spawn(11, 10);
    living.enterEditMode();
    expect(os.getLayout()).toBe(user);
    expect(os.livingAreaLabels.size).toBe(0);
    expect(living.isComposed()).toBe(false);
    // A save while editing is the user's layout, untouched.
    expect(living.savableLayout(os.getLayout())).toBe(user);
    const edited = { ...user, furniture: user.furniture.slice(0, -1) };
    living.exitEditMode(edited);
    expect(living.isComposed()).toBe(true);
    expect(living.getUserLayout()).toBe(edited);
    expect(os.characters.get(11)!.seatId).toBe(moduleOf(10)!.seatByAgent.get(11));
  });
});

describe('wire guards', () => {
  it('accepts only safe integer ids and known presences', () => {
    expect(isWireAgentId(3)).toBe(true);
    for (const bad of ['3', 3.5, NaN, Infinity, null, undefined, {}, 2 ** 60, 0, -1, -1e9]) {
      expect(isWireAgentId(bad)).toBe(false);
    }
    expect(parsePresence('lounge')).toBe('lounge');
    expect(parsePresence('__proto__')).toBeUndefined();
    expect(parsePresence(1)).toBeUndefined();
  });

  it('clamps the idle-to-lounge minutes to the server range', () => {
    expect(clampIdleToLoungeMinutes('0')).toBe(1);
    expect(clampIdleToLoungeMinutes('999')).toBe(240);
    expect(clampIdleToLoungeMinutes(' 45 ')).toBe(45);
    for (const junk of ['12.6', '0x10', '1e3', '-5', '9999999']) {
      expect(clampIdleToLoungeMinutes(junk)).toBeNull();
    }
    expect(clampIdleToLoungeMinutes('')).toBeNull();
    expect(clampIdleToLoungeMinutes('abc')).toBeNull();
  });

  it('clamps the lounge-to-leave minutes to the server range (1–480)', () => {
    expect(clampLoungeToLeaveMinutes('0')).toBe(1);
    expect(clampLoungeToLeaveMinutes('999')).toBe(480);
    expect(clampLoungeToLeaveMinutes('300')).toBe(300);
    for (const junk of ['12.6', '0x10', '1e3', '-5', '9999999', '', 'abc']) {
      expect(clampLoungeToLeaveMinutes(junk)).toBeNull();
    }
  });

  it('reads only well-formed effective timings off the wire', () => {
    expect(
      parseLivingOfficeTimings({
        type: 'livingOfficeSettings',
        idleToLoungeMinutes: 12,
        loungeToLeaveMinutes: 90,
      }),
    ).toEqual({ idleToLoungeMinutes: 12, loungeToLeaveMinutes: 90 });
    expect(
      parseLivingOfficeTimings({ idleToLoungeMinutes: 241, loungeToLeaveMinutes: 481 }),
    ).toEqual({ idleToLoungeMinutes: undefined, loungeToLeaveMinutes: undefined });
    for (const junk of [0, -1, 1.5, NaN, Infinity, '30', null, undefined, 2 ** 60]) {
      expect(
        parseLivingOfficeTimings({ idleToLoungeMinutes: junk, loungeToLeaveMinutes: junk }),
      ).toEqual({ idleToLoungeMinutes: undefined, loungeToLeaveMinutes: undefined });
    }
  });
});

describe('review regressions', () => {
  /** Rest seats (sofas) of the shipped default layout. */
  function sofaSeats(): string[] {
    return [...os.seats.keys()].filter((uid) => {
      const f = os.getLayout().furniture.find((x) => uid === x.uid || uid.startsWith(`${x.uid}:`));
      return f?.type.startsWith('SOFA_') ?? false;
    });
  }

  it('roots on sofas keep them when composition leaves no free desk, and sofas seat again after', () => {
    const roots: number[] = [];
    for (let i = 0; i < 13; i++) {
      living.directory.upsert(200 + i, {});
      os.addAgent(200 + i, 0, 0, undefined, true);
      roots.push(200 + i);
    }
    const seatless = () => roots.filter((id) => os.characters.get(id)!.seatId === null);
    expect(seatless()).toEqual([]);
    spawn(10, ROOT);
    expect(living.isComposed()).toBe(true);
    // Nobody who had a seat lost it to the composition.
    expect(seatless()).toEqual([]);
    living.setPresence(10, 'leaving');
    tick(60);
    expect(living.isComposed()).toBe(false);
    // The composition is gone: sofas are ordinary seats again.
    expect(sofaSeats().length).toBeGreaterThan(0);
    for (const uid of sofaSeats()) expect(os.canAssignSeatByHand(uid)).toBe(true);
  });

  it('module members take no user desk while the editor is open; a root born meanwhile gets one', () => {
    spawn(10, ROOT);
    for (let i = 0; i < 12; i++) spawn(20 + i, 10, 'restore');
    const userDesks = () =>
      [...os.characters.values()].filter((c) => c.seatId !== null && c.id >= 10 && c.id < 40)
        .length;
    living.enterEditMode();
    expect(userDesks()).toBe(0); // members wait for their module
    living.directory.upsert(2, {});
    os.addAgent(2, 0, 0, undefined, true);
    expect(os.characters.get(2)!.seatId).not.toBeNull(); // desks were left free
    living.exitEditMode(os.getLayout());
    expect(os.characters.get(2)!.seatId).not.toBeNull();
    expect(os.characters.get(21)!.seatId).toBe(moduleOf(10)!.seatByAgent.get(21));
  });

  it('module members stay off the user desks through every rebuild the editor makes', () => {
    spawn(10, ROOT);
    spawn(11, 10, 'restore');
    spawn(12, 10, 'restore');
    living.enterEditMode();
    const user = os.getLayout();
    // An editor edit rebuilds from a new user layout...
    os.rebuildFromLayout({ ...user, furniture: [...user.furniture] });
    expect(os.characters.get(11)!.seatId).toBeNull();
    // ...and so does a layout arriving from another window while editing.
    living.setUserLayout({ ...user, furniture: [...user.furniture] });
    expect(os.characters.get(12)!.seatId).toBeNull();
    living.exitEditMode(os.getLayout());
    expect(os.characters.get(11)!.seatId).toBe(moduleOf(10)!.seatByAgent.get(11));
    expect(os.characters.get(12)!.seatId).toBe(moduleOf(10)!.seatByAgent.get(12));
  });

  it('two members trading teams in one recomposition both reach their new desks', () => {
    spawn(10, ROOT);
    spawn(20, ROOT);
    spawn(11, 10, 'restore');
    spawn(21, 20, 'restore');
    // Each owner needs a second member so both modules survive the trade.
    spawn(12, 10, 'restore');
    spawn(22, 20, 'restore');
    living.upsertAgent(11, { parentAgentId: 20 });
    living.upsertAgent(21, { parentAgentId: 10 });
    living.refresh();
    expect(os.characters.get(11)!.seatId).toBe(moduleOf(20)!.seatByAgent.get(11));
    expect(os.characters.get(21)!.seatId).toBe(moduleOf(10)!.seatByAgent.get(21));
  });

  it('a root re-announced with a parent is never walked out the door', () => {
    living.upsertAgent(ROOT, { parentAgentId: 999 });
    living.placeDerived(ROOT, { parentAgentId: 999 }, 'enter');
    living.setPresence(ROOT, 'leaving');
    living.agentClosed(ROOT);
    expect(os.isLeavingAgent(ROOT)).toBe(false);
    expect(os.characters.get(ROOT)!.matrixEffect).toBe('despawn'); // a root rains out
  });

  it('a replayed presence never revives an agent on its way out', () => {
    spawn(10, ROOT);
    living.setPresence(10, 'leaving');
    living.upsertAgent(10, { parentAgentId: ROOT, presence: 'working' });
    expect(living.directory.get(10)!.presence).toBe('leaving');
    expect(os.isLeavingAgent(10)).toBe(true);
  });

  it('recognizes a composed layout even after its composition was dropped', () => {
    const user = userLayout();
    living.setUserLayout(user);
    spawn(10, ROOT);
    const composed = os.getLayout();
    living.setPresence(10, 'leaving');
    tick(60);
    expect(living.isComposed()).toBe(false);
    expect(living.savableLayout(composed)).toBe(user);
    expect(living.savableLayout(structuredClone(composed))).toBe(user);
  });

  it('a restored derived agent without a team keeps its last desk', () => {
    const desk = os.pickDeskSeat()!;
    living.directory.upsert(10, { parentAgentId: ROOT });
    living.placeDerived(10, { parentAgentId: ROOT, seatId: desk }, 'restore');
    expect(os.characters.get(10)!.seatId).toBe(desk);
  });

  it('refresh recomposes when a reconnect brings a new label for a team owner', () => {
    spawn(10, ROOT, 'enter', { label: 'Fase 1' });
    spawn(11, 10);
    expect(moduleOf(10)!.label).toBe('Fase 1');
    living.upsertAgent(10, { parentAgentId: ROOT, label: 'Fase 1 · Auth' });
    living.refresh();
    expect(moduleOf(10)!.label).toBe('Fase 1 · Auth');
  });
});
