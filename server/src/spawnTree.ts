/**
 * Pure planning for the spawn tree (docs/adr/0002). The runtime hands in the
 * current tree nodes and the provider's spawn entries; this decides which
 * entries become derived agents now, under which parent, and which must wait
 * for their parent node to exist. No I/O, no store access.
 */

/** One spawned agent as the provider reports it (read from its sidecar). */
export interface SpawnEntry {
  jsonlPath: string;
  agentKey: string;
  parentAgentKey?: string;
  toolUseId: string;
  depth: number;
  agentType: string;
  description?: string;
  name?: string;
}

/** An agent already in the tree: the root session agent or a derived agent. */
export interface SpawnTreeNode {
  id: number;
  /** undefined for the root session agent */
  spawnAgentKey?: string;
  liveSpawnToolIds: ReadonlySet<string>;
  /**
   * Optional, for derived nodes: the parent node id and the spawn tool call
   * that started this node. When given, a later sidecar claiming the same
   * `(parentId, spawnToolUseId)` is refused across scans, not only within one.
   */
  parentId?: number;
  spawnToolUseId?: string;
}

export interface SpawnPlan {
  create: Array<{ entry: SpawnEntry; parentId: number }>;
  /**
   * Entries whose parent node does not exist yet — retry next scan.
   * Informational: recomputed from scratch every call, never accumulate it.
   */
  deferred: SpawnEntry[];
}

/**
 * Decides which spawn entries materialize now and under which parent.
 *
 * - Parent = the node whose `spawnAgentKey` equals the entry's `parentAgentKey`;
 *   an entry with no parent key hangs from the root. An unknown (or ambiguous)
 *   parent key is DEFERRED — never guessed, never attached to the root.
 * - Anti-spurious gate: the entry's `toolUseId` must be a live spawn of THAT
 *   parent. Historical sidecars and entries claiming someone else's spawn are
 *   dropped silently (they are re-offered every scan anyway).
 * - One spawn tool call starts exactly one agent. A `(parent, toolUseId)` that
 *   already has a node (see `SpawnTreeNode.spawnToolUseId`) is refused; two new
 *   entries contesting the same one are BOTH refused rather than letting
 *   directory order pick the winner.
 * - At most one agent per `agentKey`; a key that already is a node is skipped.
 *
 * O(nodes + entries) plus one `isTracked` call per entry that passed the gate —
 * pass an O(1) `isTracked` (e.g. a Set of normalized paths).
 */
export function planSpawnTree(
  rootId: number,
  nodes: ReadonlyMap<number, SpawnTreeNode>,
  entries: readonly SpawnEntry[],
  isTracked: (jsonlPath: string) => boolean,
): SpawnPlan {
  const plan: SpawnPlan = { create: [], deferred: [] };
  const root = nodes.get(rootId);
  if (!root) return plan;

  // Keys already materialized (any node, root included) — never created twice.
  const existingKeys = new Set<string>();
  // Parent lookup by key; a key held by two nodes is ambiguous and resolves to nothing.
  const byKey = new Map<string, SpawnTreeNode>();
  const ambiguousKeys = new Set<string>();
  // Spawn tool calls that already produced a node, as `${parentId}\n${toolUseId}`.
  const materializedSpawns = new Set<string>();
  for (const n of nodes.values()) {
    if (n.parentId !== undefined && n.spawnToolUseId !== undefined) {
      materializedSpawns.add(spawnSlot(n.parentId, n.spawnToolUseId));
    }
    if (n.spawnAgentKey === undefined) continue;
    existingKeys.add(n.spawnAgentKey);
    // The root is reached only through an absent parent key, never by key.
    if (n.id === rootId || n.spawnAgentKey === '') continue;
    if (byKey.has(n.spawnAgentKey)) ambiguousKeys.add(n.spawnAgentKey);
    else byKey.set(n.spawnAgentKey, n);
  }

  // Pass 1: resolve the parent and apply the live-spawn gate.
  const candidates: Array<{ entry: SpawnEntry; parentId: number; slot: string }> = [];
  const claimsPerSlot = new Map<string, number>();
  const deferredKeys = new Set<string>();
  for (const entry of entries) {
    if (existingKeys.has(entry.agentKey)) continue;
    // A sidecar naming itself as its parent can never materialize.
    if (entry.parentAgentKey === entry.agentKey) continue;

    let parent: SpawnTreeNode | undefined;
    if (entry.parentAgentKey === undefined) {
      parent = root;
    } else if (!ambiguousKeys.has(entry.parentAgentKey)) {
      parent = byKey.get(entry.parentAgentKey);
    }
    if (!parent) {
      if (!deferredKeys.has(entry.agentKey)) {
        deferredKeys.add(entry.agentKey);
        plan.deferred.push(entry);
      }
      continue;
    }

    // Anti-spurious gate: only a spawn its parent is running RIGHT NOW.
    if (!parent.liveSpawnToolIds.has(entry.toolUseId)) continue;
    const slot = spawnSlot(parent.id, entry.toolUseId);
    if (materializedSpawns.has(slot)) continue;
    candidates.push({ entry, parentId: parent.id, slot });
    claimsPerSlot.set(slot, (claimsPerSlot.get(slot) ?? 0) + 1);
  }

  // Pass 2: drop contested spawns, duplicate keys and already-tracked transcripts.
  const createdKeys = new Set<string>();
  for (const { entry, parentId, slot } of candidates) {
    if (claimsPerSlot.get(slot) !== 1) continue;
    if (createdKeys.has(entry.agentKey)) continue;
    if (isTracked(entry.jsonlPath)) continue;
    plan.create.push({ entry, parentId });
    createdKeys.add(entry.agentKey);
  }
  return plan;
}

function spawnSlot(parentId: number, toolUseId: string): string {
  return `${parentId}\n${toolUseId}`;
}

/**
 * Removal order for `rootOfRemoval` and its whole subtree: every node comes
 * after all of its descendants (leaves first), `rootOfRemoval` last. The id is
 * returned even when absent from `parentOf` — the caller decides whether it
 * exists. Iterative and cycle-safe: each id is listed at most once, so a
 * corrupt `parentOf` can neither hang nor overflow the stack.
 */
export function subtreeRemovalOrder(
  rootOfRemoval: number,
  parentOf: ReadonlyMap<number, number | undefined>,
): number[] {
  const children = new Map<number, number[]>();
  for (const [id, parent] of parentOf) {
    if (parent === undefined || parent === id) continue;
    const list = children.get(parent);
    if (list) list.push(id);
    else children.set(parent, [id]);
  }

  // Iterative post-order DFS.
  const order: number[] = [];
  const visited = new Set<number>([rootOfRemoval]);
  const stack: Array<{ id: number; next: number }> = [{ id: rootOfRemoval, next: 0 }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const kids = children.get(frame.id);
    if (kids && frame.next < kids.length) {
      const child = kids[frame.next++];
      if (!visited.has(child)) {
        visited.add(child);
        stack.push({ id: child, next: 0 });
      }
      continue;
    }
    stack.pop();
    order.push(frame.id);
  }
  return order;
}
