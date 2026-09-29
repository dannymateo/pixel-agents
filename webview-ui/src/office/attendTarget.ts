/** Where answering an agent that waits on the user happens (spec §3). */
export interface AttendLookup {
  parentOf(id: number): number | undefined;
  terminalOf(id: number): string | undefined;
  isBrowser: boolean;
}

export type AttendTarget =
  | { kind: 'console'; rootId: number; terminalId: string }
  | { kind: 'screen'; id: number }
  | { kind: 'focus'; id: number };

/** Where answering an agent that waits on the user happens: the console of
 *  its root (office sessions — sub-agents are reached through their root), else
 *  its screen in the browser (where it can be brought to the office), else its
 *  VS Code terminal. */
export function resolveAttendTarget(id: number, lookup: AttendLookup): AttendTarget {
  let root = id;
  const seen = new Set<number>([id]);
  let p = lookup.parentOf(id);
  while (p !== undefined) {
    if (seen.has(p)) {
      // A parent cycle: no reliable root above `id` — fall back to it rather
      // than land on an arbitrary member of the cycle (order-dependent).
      root = id;
      break;
    }
    seen.add(p);
    root = p;
    p = lookup.parentOf(p);
  }
  const terminalId = lookup.terminalOf(root);
  if (terminalId) return { kind: 'console', rootId: root, terminalId };
  return lookup.isBrowser ? { kind: 'screen', id: root } : { kind: 'focus', id: root };
}
