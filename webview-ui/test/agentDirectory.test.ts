import { describe, expect, it } from 'vitest';

import { AgentDirectory } from '../src/office/scope/agentDirectory.js';

function tree(): AgentDirectory {
  const d = new AgentDirectory();
  d.upsert(1, {}); // root session
  d.upsert(10, { parentAgentId: 1 }); // lider F1
  d.upsert(11, { parentAgentId: 10 }); // dev a
  d.upsert(12, { parentAgentId: 11 }); // qa of dev a
  d.upsert(2, {}); // another root session
  return d;
}

describe('AgentDirectory', () => {
  it('root scope holds only top-level agents', () => {
    expect(tree().membersOf('root').sort()).toEqual([1, 2]);
  });
  it('a scope holds its owner and direct children only', () => {
    expect(tree().membersOf(10)).toEqual([10, 11]);
  });
  it('counts live direct children', () => {
    expect(tree().liveChildCount(1)).toBe(1);
    expect(tree().liveChildCount(12)).toBe(0);
  });
  it('bubbles a permission request up to every ancestor', () => {
    const d = tree();
    d.setPermission(12, true);
    expect(d.hasPermissionBelow(1)).toBe(true);
    expect(d.hasPermissionBelow(10)).toBe(true);
    expect(d.hasPermissionBelow(12)).toBe(false);
    expect(d.hasPermissionBelow(2)).toBe(false);
  });
  it('bounces to the nearest living ancestor when a scope owner disappears', () => {
    const d = tree();
    const parents = new Map<number, number | undefined>([
      [11, 10],
      [10, 1],
    ]);
    d.remove(12);
    d.remove(11);
    expect(d.nearestLiveScope(11, parents)).toBe(10);
    d.remove(10);
    expect(d.nearestLiveScope(11, parents)).toBe(1);
    d.remove(1);
    expect(d.nearestLiveScope(11, parents)).toBe('root');
  });
  it('tracks running tools for replay', () => {
    const d = tree();
    d.toolStart(11, 't1', 'Editing Login.java', 'Edit');
    d.toolStart(11, 't2', 'Running mvn test', 'Bash');
    d.toolDone(11, 't1');
    expect([...d.get(11)!.tools.keys()]).toEqual(['t2']);
    d.toolsClear(11);
    expect(d.get(11)!.tools.size).toBe(0);
  });
});

describe('AgentDirectory — upsert and state', () => {
  it('creates with defaults and merges later fields without losing earlier ones', () => {
    const d = new AgentDirectory();
    const a = d.upsert(5, { role: 'qa' });
    expect(a).toMatchObject({ id: 5, role: 'qa', status: null, permission: false });
    expect(a.tools.size).toBe(0);
    d.toolStart(5, 't', 'Reading x');
    d.upsert(5, { label: 'check auth' });
    expect(d.get(5)).toMatchObject({ role: 'qa', label: 'check auth' });
    expect(d.get(5)!.tools.size).toBe(1);
  });
  it('never lets fields overwrite the id or the tool map', () => {
    const d = new AgentDirectory();
    d.toolStart(5, 't', 'x'); // unknown id: no-op
    d.upsert(5, {});
    d.toolStart(5, 't', 'x');
    const hostile = { id: 99, tools: new Map() } as unknown as Record<string, never>;
    d.upsert(5, hostile);
    expect(d.get(5)!.id).toBe(5);
    expect(d.get(5)!.tools.size).toBe(1);
  });
  it('ignores a __proto__ key from wire JSON', () => {
    const d = new AgentDirectory();
    const fields = JSON.parse('{"__proto__": {"permission": true}, "role": "dev"}') as Record<
      string,
      never
    >;
    const a = d.upsert(7, fields);
    expect(Object.getPrototypeOf(a)).toBe(Object.prototype);
    expect(a.role).toBe('dev');
    expect(a.permission).toBe(false);
  });
  it('mutations on unknown agents are no-ops, not phantom entries', () => {
    const d = new AgentDirectory();
    d.setStatus(3, 'active');
    d.toolStart(3, 't', 'x');
    d.toolDone(3, 't');
    d.toolsClear(3);
    d.setPermission(3, true);
    expect(d.get(3)).toBeUndefined();
    expect(d.membersOf('root')).toEqual([]);
  });
  it('records status and permission', () => {
    const d = tree();
    d.setStatus(11, 'waiting');
    d.setPermission(11, true);
    expect(d.get(11)).toMatchObject({ status: 'waiting', permission: true });
    d.setPermission(11, false);
    expect(d.hasPermissionBelow(1)).toBe(false);
  });
  it('an owner that is not in the directory has no scope members', () => {
    expect(tree().membersOf(404)).toEqual([]);
  });
});

describe('AgentDirectory — malformed trees', () => {
  it('an orphan (parent unknown) is shown in the root office rather than lost', () => {
    const d = tree();
    d.upsert(50, { parentAgentId: 777 });
    expect(d.membersOf('root').sort((a, b) => a - b)).toEqual([1, 2, 50]);
    d.upsert(777, {});
    expect(d.membersOf('root').sort((a, b) => a - b)).toEqual([1, 2, 777]);
    expect(d.membersOf(777)).toEqual([777, 50]);
  });
  it('a self-parented agent is top-level and not its own child', () => {
    const d = new AgentDirectory();
    d.upsert(4, { parentAgentId: 4 });
    expect(d.childrenOf(4)).toEqual([]);
    expect(d.membersOf(4)).toEqual([4]);
    expect(d.membersOf('root')).toEqual([4]);
    d.setPermission(4, true);
    expect(d.hasPermissionBelow(4)).toBe(false);
  });
  it('a parent cycle terminates and stays reachable from root', () => {
    const d = new AgentDirectory();
    d.upsert(1, { parentAgentId: 2 });
    d.upsert(2, { parentAgentId: 3 });
    d.upsert(3, { parentAgentId: 1 });
    d.upsert(4, { parentAgentId: 3 });
    d.setPermission(4, true);
    expect(d.hasPermissionBelow(1)).toBe(true);
    expect(d.hasPermissionBelow(4)).toBe(false);
    expect(d.membersOf('root').length).toBeGreaterThan(0);
    expect(d.membersOf('root')).not.toContain(4);
  });
  it('a permission deep in a long chain is found without recursion limits', () => {
    const d = new AgentDirectory();
    const depth = 20_000;
    d.upsert(0, {});
    for (let i = 1; i <= depth; i++) d.upsert(i, { parentAgentId: i - 1 });
    d.setPermission(depth, true);
    expect(d.hasPermissionBelow(0)).toBe(true);
    expect(d.membersOf('root')).toEqual([0]);
  });
  it('nearestLiveScope survives a cycle in the last-known parents', () => {
    const d = new AgentDirectory();
    const parents = new Map<number, number | undefined>([
      [8, 9],
      [9, 8],
    ]);
    expect(d.nearestLiveScope(8, parents)).toBe('root');
  });
  it('nearestLiveScope keeps a scope whose owner still exists, and root as root', () => {
    const d = tree();
    expect(d.nearestLiveScope(10, new Map())).toBe(10);
    expect(d.nearestLiveScope('root', new Map())).toBe('root');
    expect(d.nearestLiveScope(404, new Map())).toBe('root');
  });
  it('merges nodeKind and presence like any other field', () => {
    const d = new AgentDirectory();
    d.upsert(1, { nodeKind: 'workflow', presence: 'available' });
    d.upsert(1, { presence: 'lounge' });
    expect(d.get(1)).toMatchObject({ nodeKind: 'workflow', presence: 'lounge' });
  });
  it('keeps its child index in step with re-parenting and removal', () => {
    const d = tree();
    d.upsert(13, { parentAgentId: 10 });
    expect(d.childrenOf(10)).toEqual([11, 13]);
    d.upsert(13, { parentAgentId: 11 }); // re-parented
    expect(d.childrenOf(10)).toEqual([11]);
    expect(d.childrenOf(11)).toEqual([12, 13]);
    d.upsert(13, { parentAgentId: undefined }); // cleared: top level
    expect(d.childrenOf(11)).toEqual([12]);
    expect(d.membersOf('root')).toContain(13);
    d.remove(12);
    expect(d.childrenOf(11)).toEqual([]);
    expect(d.liveChildCount(11)).toBe(0);
    // Orphans stay listed under their removed parent, as before.
    d.remove(10);
    expect(d.childrenOf(10)).toEqual([11]);
    // A self-parent is never its own child.
    d.upsert(20, { parentAgentId: 20 });
    expect(d.childrenOf(20)).toEqual([]);
  });
  it('childrenOf is linear in the children, not the directory', () => {
    const d = new AgentDirectory();
    d.upsert(0, {});
    for (let i = 1; i <= 50_000; i++) d.upsert(i, { parentAgentId: i % 2 === 0 ? 0 : 1 });
    const started = performance.now();
    for (let i = 0; i < 1_000; i++) d.childrenOf(3);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
