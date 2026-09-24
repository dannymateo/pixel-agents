import { describe, expect, it } from 'vitest';

import {
  planSpawnTree,
  type SpawnEntry,
  type SpawnTreeNode,
  subtreeRemovalOrder,
} from '../src/spawnTree.js';

const e = (
  agentKey: string,
  toolUseId: string,
  depth: number,
  parentAgentKey?: string,
): SpawnEntry => ({
  jsonlPath: `/p/s/subagents/agent-${agentKey}.jsonl`,
  agentKey,
  parentAgentKey,
  toolUseId,
  depth,
  agentType: 'general-purpose',
});
const node = (id: number, live: string[], spawnAgentKey?: string): SpawnTreeNode => ({
  id,
  spawnAgentKey,
  liveSpawnToolIds: new Set(live),
});

describe('planSpawnTree', () => {
  it('creates a depth-1 child under the root when its spawn tool is live', () => {
    const nodes = new Map([[1, node(1, ['t1'])]]);
    const plan = planSpawnTree(1, nodes, [e('a', 't1', 1)], () => false);
    expect(plan.create).toEqual([{ entry: e('a', 't1', 1), parentId: 1 }]);
    expect(plan.deferred).toEqual([]);
  });

  it('skips entries whose spawn tool is not live (historical sidecars)', () => {
    const nodes = new Map([[1, node(1, [])]]);
    const dead = Array.from({ length: 300 }, (_, i) => e(`d${i}`, `t${i}`, 1));
    expect(planSpawnTree(1, nodes, dead, () => false)).toEqual({ create: [], deferred: [] });
  });

  it('attaches a grandchild to its derived parent by key, gated by the PARENT live tools', () => {
    const nodes = new Map([
      [1, node(1, ['t1'])],
      [5, node(5, ['t2'], 'a')],
    ]);
    const plan = planSpawnTree(1, nodes, [e('b', 't2', 2, 'a')], (p) =>
      p.endsWith('agent-a.jsonl'),
    );
    expect(plan.create).toEqual([{ entry: e('b', 't2', 2, 'a'), parentId: 5 }]);
  });

  it('never hangs an entry with an unknown parent key off the root: it is deferred', () => {
    const nodes = new Map([[1, node(1, ['t2'])]]);
    const plan = planSpawnTree(1, nodes, [e('b', 't2', 2, 'a')], () => false);
    expect(plan.create).toEqual([]);
    expect(plan.deferred).toEqual([e('b', 't2', 2, 'a')]);
  });

  it('skips already tracked transcripts', () => {
    const nodes = new Map([[1, node(1, ['t1'])]]);
    expect(planSpawnTree(1, nodes, [e('a', 't1', 1)], () => true).create).toEqual([]);
  });

  // ── Anti-spurious gate: the spawn must be live on ITS OWN parent ──

  it('does not attach a grandchild whose tool is live on the ROOT but not on its declared parent', () => {
    const nodes = new Map([
      [1, node(1, ['t2'])],
      [5, node(5, [], 'a')],
    ]);
    expect(planSpawnTree(1, nodes, [e('b', 't2', 2, 'a')], () => false)).toEqual({
      create: [],
      deferred: [],
    });
  });

  it('does not attach a depth-1 entry (no parent key) whose tool is live only on a derived node', () => {
    const nodes = new Map([
      [1, node(1, [])],
      [5, node(5, ['t2'], 'a')],
    ]);
    expect(planSpawnTree(1, nodes, [e('b', 't2', 1)], () => false)).toEqual({
      create: [],
      deferred: [],
    });
  });

  it('attaches a whole depth-3 chain at once when every level already exists', () => {
    const nodes = new Map([
      [1, node(1, ['tL'])],
      [10, node(10, ['tA'], 'aaa')],
      [11, node(11, ['tB'], 'bbb')],
    ]);
    const entries = [e('aaa', 'tL', 1), e('bbb', 'tA', 2, 'aaa'), e('ccc', 'tB', 3, 'bbb')];
    const tracked = new Set([entries[0].jsonlPath, entries[1].jsonlPath]);
    const plan = planSpawnTree(1, nodes, entries, (p) => tracked.has(p));
    expect(plan.create).toEqual([{ entry: entries[2], parentId: 11 }]);
    expect(plan.deferred).toEqual([]);
  });

  it('defers a grandchild whose parent is created in the same plan (it lands next scan)', () => {
    const nodes = new Map([[1, node(1, ['tL'])]]);
    const entries = [e('aaa', 'tL', 1), e('bbb', 'tA', 2, 'aaa')];
    const plan = planSpawnTree(1, nodes, entries, () => false);
    expect(plan.create).toEqual([{ entry: entries[0], parentId: 1 }]);
    expect(plan.deferred).toEqual([entries[1]]);
  });

  // ── Malformed / adversarial entries ──

  it('returns an empty plan when the root node does not exist', () => {
    const nodes = new Map([[5, node(5, ['t2'], 'a')]]);
    const entries = [e('x', 't1', 1), e('b', 't2', 2, 'a')];
    expect(planSpawnTree(1, nodes, entries, () => false)).toEqual({ create: [], deferred: [] });
  });

  it('creates at most one agent per agentKey when the same key is listed twice', () => {
    const nodes = new Map([[1, node(1, ['t1', 't2'])]]);
    const first = e('a', 't1', 1);
    const dup = { ...e('a', 't2', 1), jsonlPath: '/other/agent-a.jsonl' };
    const plan = planSpawnTree(1, nodes, [first, dup], () => false);
    expect(plan.create).toEqual([{ entry: first, parentId: 1 }]);
  });

  it('creates NO agent when two new sidecars contest the same spawn (directory order never picks)', () => {
    const nodes = new Map([[1, node(1, ['t1'])]]);
    expect(
      planSpawnTree(1, nodes, [e('0evil', 't1', 1), e('a', 't1', 1)], () => false).create,
    ).toEqual([]);
    expect(
      planSpawnTree(1, nodes, [e('a', 't1', 1), e('0evil', 't1', 1)], () => false).create,
    ).toEqual([]);
  });

  it('refuses a second agent for a spawn that already has a node (across scans)', () => {
    // Scan 1 created `a` for t1 under the root; t1 is still live on scan 2.
    const nodes = new Map<number, SpawnTreeNode>([
      [1, node(1, ['t1'])],
      [5, { ...node(5, [], 'a'), parentId: 1, spawnToolUseId: 't1' }],
    ]);
    expect(planSpawnTree(1, nodes, [e('zz', 't1', 1)], () => false)).toEqual({
      create: [],
      deferred: [],
    });
  });

  it('only blocks the exact (parent, spawn) slot: the same toolUseId under another parent still passes', () => {
    const nodes = new Map<number, SpawnTreeNode>([
      [1, node(1, ['t1'])],
      [5, { ...node(5, ['t1'], 'a'), parentId: 1, spawnToolUseId: 't1' }],
    ]);
    const plan = planSpawnTree(1, nodes, [e('b', 't1', 2, 'a')], () => false);
    expect(plan.create).toEqual([{ entry: e('b', 't1', 2, 'a'), parentId: 5 }]);
  });

  it('a deferred entry does not block a later valid entry with the same agentKey', () => {
    const nodes = new Map([[1, node(1, ['t1'])]]);
    const ghost = e('a', 't9', 2, 'ghost');
    const valid = e('a', 't1', 1);
    const plan = planSpawnTree(1, nodes, [ghost, valid], () => false);
    expect(plan.create).toEqual([{ entry: valid, parentId: 1 }]);
    expect(plan.deferred).toEqual([ghost]);
  });

  it('lists a deferred agentKey once', () => {
    const nodes = new Map([[1, node(1, [])]]);
    const plan = planSpawnTree(1, nodes, [e('b', 't2', 2, 'x'), e('b', 't3', 2, 'y')], () => false);
    expect(plan.deferred).toEqual([e('b', 't2', 2, 'x')]);
  });

  it('only asks isTracked about entries that passed the gate', () => {
    const nodes = new Map([[1, node(1, ['t1'])]]);
    const entries = [
      e('a', 't1', 1),
      ...Array.from({ length: 300 }, (_, i) => e(`d${i}`, `x${i}`, 1)),
    ];
    entries.push(e('n', 't5', 2, 'gone'));
    const asked: string[] = [];
    planSpawnTree(1, nodes, entries, (p) => {
      asked.push(p);
      return false;
    });
    expect(asked).toEqual([entries[0].jsonlPath]);
  });

  it('does not re-create an agentKey that is already a node, even under another path', () => {
    const nodes = new Map([
      [1, node(1, ['t1'])],
      [5, node(5, [], 'a')],
    ]);
    const moved = { ...e('a', 't1', 1), jsonlPath: '/elsewhere/agent-a.jsonl' };
    expect(planSpawnTree(1, nodes, [moved], () => false)).toEqual({ create: [], deferred: [] });
  });

  it('drops an entry that names itself as its parent (never materializable)', () => {
    const nodes = new Map([[1, node(1, ['t1'])]]);
    expect(planSpawnTree(1, nodes, [e('a', 't1', 2, 'a')], () => false)).toEqual({
      create: [],
      deferred: [],
    });
  });

  it('defers instead of guessing when two nodes share the parent key', () => {
    const nodes = new Map([
      [1, node(1, [])],
      [5, node(5, ['t2'], 'a')],
      [6, node(6, ['t2'], 'a')],
    ]);
    const plan = planSpawnTree(1, nodes, [e('b', 't2', 2, 'a')], () => false);
    expect(plan.create).toEqual([]);
    expect(plan.deferred).toEqual([e('b', 't2', 2, 'a')]);
  });

  it('treats an empty-string parent key as unknown (deferred), not as the root', () => {
    const nodes = new Map([[1, node(1, ['t1'])]]);
    const plan = planSpawnTree(1, nodes, [e('b', 't1', 2, '')], () => false);
    expect(plan.create).toEqual([]);
    expect(plan.deferred).toEqual([e('b', 't1', 2, '')]);
  });

  it('never resolves a parent key to the root node itself', () => {
    // A root carrying a spawnAgentKey (should not happen) must not be reachable by key.
    const nodes = new Map([[1, node(1, ['t1'], 'r')]]);
    const plan = planSpawnTree(1, nodes, [e('b', 't1', 2, 'r')], () => false);
    expect(plan.create).toEqual([]);
  });

  it('plans hundreds of entries in linear time', () => {
    const nodes = new Map<number, SpawnTreeNode>([[1, node(1, ['t0'])]]);
    for (let i = 0; i < 500; i++) nodes.set(100 + i, node(100 + i, [`c${i}`], `k${i}`));
    const entries: SpawnEntry[] = [];
    // i < 500: live spawn of an existing parent; the rest: dead spawns or unknown parents.
    for (let i = 0; i < 5000; i++)
      entries.push(e(`g${i}`, i < 500 ? `c${i}` : `x${i}`, 2, `k${i % 700}`));
    const t0 = performance.now();
    const plan = planSpawnTree(1, nodes, entries, () => false);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(plan.create).toHaveLength(500);
  });
});

describe('subtreeRemovalOrder', () => {
  it('returns leaves first and the removed node last', () => {
    const parentOf = new Map<number, number | undefined>([
      [1, undefined],
      [5, 1],
      [6, 5],
      [7, 5],
      [8, 6],
    ]);
    const order = subtreeRemovalOrder(5, parentOf);
    expect(order[order.length - 1]).toBe(5);
    expect(order.indexOf(8)).toBeLessThan(order.indexOf(6));
    expect(new Set(order)).toEqual(new Set([5, 6, 7, 8]));
  });

  it('puts every node after all of its descendants', () => {
    const parentOf = new Map<number, number | undefined>([
      [1, undefined],
      [2, 1],
      [3, 2],
      [4, 3],
      [5, 2],
      [6, 1],
    ]);
    const order = subtreeRemovalOrder(1, parentOf);
    expect(order).toHaveLength(6);
    for (const [id, parent] of parentOf) {
      if (parent !== undefined) expect(order.indexOf(id)).toBeLessThan(order.indexOf(parent));
    }
  });

  it('returns just the node when it has no children', () => {
    expect(subtreeRemovalOrder(7, new Map<number, number | undefined>([[7, 1]]))).toEqual([7]);
  });

  it('returns just the requested id when it is not in the map', () => {
    expect(subtreeRemovalOrder(42, new Map<number, number | undefined>([[1, undefined]]))).toEqual([
      42,
    ]);
  });

  it('terminates on a cycle and lists each node once', () => {
    const parentOf = new Map<number, number | undefined>([
      [5, 7],
      [6, 5],
      [7, 6],
    ]);
    const order = subtreeRemovalOrder(5, parentOf);
    expect(order[order.length - 1]).toBe(5);
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set([5, 6, 7]));
  });

  it('terminates on a self-parented node', () => {
    expect(subtreeRemovalOrder(5, new Map<number, number | undefined>([[5, 5]]))).toEqual([5]);
  });

  it('does not overflow the stack on a very deep chain', () => {
    const parentOf = new Map<number, number | undefined>([[0, undefined]]);
    for (let i = 1; i <= 100_000; i++) parentOf.set(i, i - 1);
    const order = subtreeRemovalOrder(0, parentOf);
    expect(order).toHaveLength(100_001);
    expect(order[0]).toBe(100_000);
    expect(order[order.length - 1]).toBe(0);
  });
});
