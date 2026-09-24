/**
 * Who sits where inside a team module (see CONTEXT.md → Team module). DOM-free
 * and pure: the result depends only on the team and the previous seating.
 *
 * Slots are the workstation indices of `generateScopeLayout`: slot 0 is the
 * head workstation (the team owner's, alone on the top band); slots 1.. fill
 * bands of SCOPE_SLOTS_PER_ROW workstations, row-major. A slot's position
 * depends only on its index, so a kept slot is a kept seat.
 *
 * Placement:
 * - the owner takes slot 0;
 * - a direct member (child of the owner) starts a band of its own, so the
 *   agents it spawns can sit right next to it (the "review" workstations);
 * - anyone deeper sits at the free workstation nearest to its parent — same
 *   band first, right side before left — so a reviewer's own helpers group
 *   under it too;
 * - everyone already seated keeps their slot (joining or leaving never moves
 *   anybody else); past the generator's capacity, members stay unseated.
 */
import { SCOPE_SLOTS_PER_ROW } from '../../constants.js';
import { scopeLayoutCapacity } from '../scope/scopeLayoutGenerator.js';
import type { TeamSpec } from './composeOffice.js';

export interface TeamSeating {
  /** agent id → workstation slot (owner → 0). */
  slotByAgent: Map<number, number>;
  /** Workstations the module needs: highest used slot + 1 (≥ 1). */
  slotCount: number;
  /** Members that got no workstation (module full), in team order. */
  unseated: number[];
}

const HEAD_SLOT = 0;

function bandOf(slot: number): number {
  return Math.floor((slot - 1) / SCOPE_SLOTS_PER_ROW);
}

function columnOf(slot: number): number {
  return (slot - 1) % SCOPE_SLOTS_PER_ROW;
}

/** Normalizes the member list of an untyped caller: drops non-objects,
 *  non-numeric ids, the owner itself and repeated ids (first wins). */
function normalizeMembers(team: TeamSpec): Array<{ id: number; parentId: number | undefined }> {
  const out: Array<{ id: number; parentId: number | undefined }> = [];
  const members: unknown = team.members;
  if (!Array.isArray(members)) return out;
  const seen = new Set<number>([team.ownerId]);
  for (const raw of members as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const { id, parentId } = raw as { id?: unknown; parentId?: unknown };
    if (typeof id !== 'number' || !Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, parentId: typeof parentId === 'number' ? parentId : undefined });
  }
  return out;
}

export function seatTeam(team: TeamSpec, previousSlots?: ReadonlyMap<number, number>): TeamSeating {
  const capacity = scopeLayoutCapacity();
  const bands = Math.ceil((capacity - 1) / SCOPE_SLOTS_PER_ROW);
  const slotByAgent = new Map<number, number>([[team.ownerId, HEAD_SLOT]]);
  const taken = new Set<number>([HEAD_SLOT]);
  const unseated: number[] = [];
  const members = normalizeMembers(team);

  // 1) Everyone keeps a valid previous workstation (first claim wins a slot).
  for (const m of members) {
    const prev = previousSlots?.get(m.id);
    if (
      typeof prev !== 'number' ||
      !Number.isInteger(prev) ||
      prev <= HEAD_SLOT ||
      prev >= capacity ||
      taken.has(prev)
    ) {
      continue;
    }
    slotByAgent.set(m.id, prev);
    taken.add(prev);
  }

  const firstEmptyBand = (): number | undefined => {
    for (let b = 0; b < bands; b++) {
      const start = 1 + b * SCOPE_SLOTS_PER_ROW;
      let empty = true;
      for (let s = start; s < start + SCOPE_SLOTS_PER_ROW && s < capacity; s++) {
        if (taken.has(s)) {
          empty = false;
          break;
        }
      }
      if (empty && start < capacity) return start;
    }
    return undefined;
  };

  const firstFree = (): number | undefined => {
    for (let s = 1; s < capacity; s++) if (!taken.has(s)) return s;
    return undefined;
  };

  /** Free slot nearest to `anchor`: fewest bands away, then fewest columns,
   *  right before left; ties to the lower slot index. */
  const nearestFree = (anchor: number): number | undefined => {
    let best: number | undefined;
    let bestCost = Number.POSITIVE_INFINITY;
    for (let s = 1; s < capacity; s++) {
      if (taken.has(s)) continue;
      const db = Math.abs(bandOf(s) - bandOf(anchor));
      const dc = columnOf(s) - columnOf(anchor);
      const cost = db * (2 * SCOPE_SLOTS_PER_ROW + 1) + (dc > 0 ? 2 * dc - 1 : -2 * dc);
      if (cost < bestCost) {
        bestCost = cost;
        best = s;
      }
    }
    return best;
  };

  // 2) Newcomers, in team (BFS) order.
  for (const m of members) {
    if (slotByAgent.has(m.id)) continue;
    if (taken.size >= capacity) {
      unseated.push(m.id);
      continue;
    }
    const parentSlot = m.parentId === undefined ? undefined : slotByAgent.get(m.parentId);
    const slot =
      parentSlot === undefined || parentSlot === HEAD_SLOT
        ? (firstEmptyBand() ?? firstFree())
        : nearestFree(parentSlot);
    if (slot === undefined) {
      unseated.push(m.id);
      continue;
    }
    slotByAgent.set(m.id, slot);
    taken.add(slot);
  }

  let slotCount = 1;
  for (const s of taken) slotCount = Math.max(slotCount, s + 1);
  return { slotByAgent, slotCount, unseated };
}
