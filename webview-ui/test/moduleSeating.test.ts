import { describe, expect, it } from 'vitest';

import { SCOPE_SLOTS_PER_ROW } from '../src/constants.js';
import type { TeamSpec } from '../src/office/living/composeOffice.js';
import { seatTeam } from '../src/office/living/moduleSeating.js';
import { scopeLayoutCapacity } from '../src/office/scope/scopeLayoutGenerator.js';

/** Band (row of workstations) and column of a child slot (slot 0 is the owner's). */
const band = (slot: number) => Math.floor((slot - 1) / SCOPE_SLOTS_PER_ROW);
const colOf = (slot: number) => (slot - 1) % SCOPE_SLOTS_PER_ROW;

const team = (ownerId: number, members: Array<[number, number]>): TeamSpec => ({
  ownerId,
  label: 'T',
  members: members.map(([id, parentId]) => ({ id, parentId })),
});

describe('seatTeam — hierarchy (d)', () => {
  it('seats the owner at the head workstation (slot 0)', () => {
    const s = seatTeam(team(1, []));
    expect(s.slotByAgent.get(1)).toBe(0);
    expect(s.slotCount).toBe(1);
  });

  it('gives every direct member its own row and puts its children right next to it', () => {
    // Leader 1 with devs 2 and 3; dev 2 has QA 4 and pentester 5; dev 3 has QA 6.
    const s = seatTeam(
      team(1, [
        [2, 1],
        [3, 1],
        [4, 2],
        [5, 2],
        [6, 3],
      ]),
    );
    const slot = (id: number) => s.slotByAgent.get(id)!;
    expect(band(slot(2))).not.toBe(band(slot(3)));
    for (const [child, parent] of [
      [4, 2],
      [5, 2],
      [6, 3],
    ]) {
      expect(band(slot(child))).toBe(band(slot(parent)));
    }
    // Reviewers are to the right of the member they review, contiguous.
    expect(colOf(slot(4))).toBe(colOf(slot(2)) + 1);
    expect(colOf(slot(5))).toBe(colOf(slot(2)) + 2);
    expect(colOf(slot(6))).toBe(colOf(slot(3)) + 1);
    expect(s.unseated).toEqual([]);
  });

  it('groups deeper levels under their parent inside the same module', () => {
    // 2 (member) → 3 (reviewer) → 4 (reviewer's own helper)
    const s = seatTeam(
      team(1, [
        [2, 1],
        [3, 2],
        [4, 3],
      ]),
    );
    const slot = (id: number) => s.slotByAgent.get(id)!;
    expect(band(slot(4))).toBe(band(slot(3)));
    expect(Math.abs(colOf(slot(4)) - colOf(slot(3)))).toBe(1);
  });

  it('a member whose row is full spills to the nearest free workstation', () => {
    const members: Array<[number, number]> = [[2, 1]];
    for (let id = 10; id < 10 + SCOPE_SLOTS_PER_ROW; id++) members.push([id, 2]);
    const s = seatTeam(team(1, members));
    const spill = s.slotByAgent.get(10 + SCOPE_SLOTS_PER_ROW - 1)!;
    expect(Math.abs(band(spill) - band(s.slotByAgent.get(2)!))).toBe(1);
  });

  it('is deterministic', () => {
    const t = team(1, [
      [2, 1],
      [3, 2],
      [4, 1],
    ]);
    expect(seatTeam(t)).toEqual(seatTeam(t));
  });
});

describe('seatTeam — stability', () => {
  it('keeps the previous workstation of everyone still in the team when someone joins', () => {
    const before = seatTeam(
      team(1, [
        [2, 1],
        [3, 1],
      ]),
    );
    const after = seatTeam(
      team(1, [
        [2, 1],
        [3, 1],
        [4, 2],
      ]),
      before.slotByAgent,
    );
    expect(after.slotByAgent.get(2)).toBe(before.slotByAgent.get(2));
    expect(after.slotByAgent.get(3)).toBe(before.slotByAgent.get(3));
    expect(band(after.slotByAgent.get(4)!)).toBe(band(after.slotByAgent.get(2)!));
  });

  it('keeps everyone else in place when someone leaves', () => {
    const before = seatTeam(
      team(1, [
        [2, 1],
        [3, 1],
        [4, 2],
        [5, 3],
      ]),
    );
    const after = seatTeam(
      team(1, [
        [3, 1],
        [4, 2],
        [5, 3],
      ]),
      before.slotByAgent,
    );
    for (const id of [3, 4, 5]) expect(after.slotByAgent.get(id)).toBe(before.slotByAgent.get(id));
    expect(after.slotByAgent.has(2)).toBe(false);
  });

  it('shrinks the slot count when the last rows empty', () => {
    const before = seatTeam(
      team(1, [
        [2, 1],
        [3, 1],
      ]),
    );
    const after = seatTeam(team(1, [[2, 1]]), before.slotByAgent);
    expect(after.slotCount).toBeLessThan(before.slotCount);
    expect(after.slotByAgent.get(2)).toBe(before.slotByAgent.get(2));
  });

  it('ignores previous slots that are invalid, out of range, taken, or the owner head', () => {
    const prev = new Map<number, number>([
      [2, 0],
      [3, -1],
      [4, 2.5],
      [5, 10_000],
      [6, Number.NaN],
      [7, 3],
      [8, 3],
    ]);
    const s = seatTeam(
      team(1, [
        [2, 1],
        [3, 1],
        [4, 1],
        [5, 1],
        [6, 1],
        [7, 1],
        [8, 1],
      ]),
      prev,
    );
    const slots = [...s.slotByAgent.values()];
    expect(new Set(slots).size).toBe(slots.length);
    expect(s.slotByAgent.get(1)).toBe(0);
    expect(s.slotByAgent.get(7)).toBe(3);
    for (const v of slots) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(scopeLayoutCapacity());
    }
  });
});

describe('seatTeam — degenerate teams', () => {
  it('tolerates the owner listed as a member, duplicates, self-parents, unknown parents and cycles', () => {
    const s = seatTeam(
      team(1, [
        [1, 1],
        [2, 1],
        [2, 1],
        [3, 3],
        [4, 999],
        [5, 6],
        [6, 5],
      ]),
    );
    expect(s.slotByAgent.get(1)).toBe(0);
    for (const id of [2, 3, 4, 5, 6]) expect(s.slotByAgent.has(id)).toBe(true);
    const slots = [...s.slotByAgent.values()];
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('never seats more than the generator capacity; the rest are unseated, in order', () => {
    const cap = scopeLayoutCapacity();
    const members: Array<[number, number]> = [];
    for (let id = 2; id < 2 + cap + 10; id++) members.push([id, 1]);
    const s = seatTeam(team(1, members));
    expect(s.slotByAgent.size).toBe(cap);
    expect(s.slotCount).toBeLessThanOrEqual(cap);
    expect(s.unseated).toHaveLength(11);
    expect(s.unseated[0]).toBe(2 + cap - 1);
  });

  it('handles a huge flat tree quickly', () => {
    const members: Array<[number, number]> = [];
    for (let id = 2; id < 200_002; id++) members.push([id, 1]);
    const t0 = Date.now();
    const s = seatTeam(team(1, members));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(s.slotByAgent.size).toBe(scopeLayoutCapacity());
  });

  it('handles a huge chain (deep tree) quickly', () => {
    const members: Array<[number, number]> = [];
    for (let id = 2; id < 100_002; id++) members.push([id, id - 1]);
    const t0 = Date.now();
    const s = seatTeam(team(1, members));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(s.slotByAgent.size).toBe(scopeLayoutCapacity());
  });

  it('survives non-array / malformed members from untyped callers', () => {
    const bad = { ownerId: 1, label: 'x', members: null } as unknown as TeamSpec;
    expect(seatTeam(bad).slotByAgent.get(1)).toBe(0);
    const junk = {
      ownerId: 1,
      label: 'x',
      members: [null, { id: 'a' }, { id: 2, parentId: 1 }],
    } as unknown as TeamSpec;
    const s = seatTeam(junk);
    expect([...s.slotByAgent.keys()]).toEqual([1, 2]);
  });
});
