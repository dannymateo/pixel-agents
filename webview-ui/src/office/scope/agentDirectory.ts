/**
 * AgentDirectory — DOM-free, always-current view of every agent the server
 * announced, whichever office is on screen. Scope offices are derived from it:
 * the root office shows top-level agents, the office of scope N shows N and its
 * direct children (see CONTEXT.md → Scope, Scope office).
 *
 * The tree comes from the wire, so every walk here tolerates a malformed one:
 * a parent that is not (or no longer) in the directory, an agent that is its
 * own parent, and parent cycles. Walks are iterative with a visited set — no
 * recursion depth, no infinite loop.
 */

export interface DirectoryAgent {
  id: number;
  parentAgentId?: number;
  role?: string;
  label?: string;
  depth?: number;
  /** 'workflow' for a scripted multi-agent run's node; absent = a plain agent. */
  nodeKind?: 'agent' | 'workflow';
  /** Living-office presence (docs/adr/0003); absent = working. */
  presence?: 'working' | 'available' | 'lounge' | 'leaving';
  agentName?: string;
  palette?: number;
  hueShift?: number;
  folderName?: string;
  status: 'active' | 'waiting' | null;
  /** toolId → { status text, toolName } of still-running tools. */
  tools: Map<string, { status: string; toolName?: string }>;
  permission: boolean;
}

export type ScopeId = 'root' | number;

type DirectoryFields = Partial<Omit<DirectoryAgent, 'id' | 'tools'>>;

/** The only fields `upsert` copies. An allowlist, not a spread: the fields may
 *  come straight from parsed wire JSON, where an own `__proto__` key would
 *  re-prototype the entry and `id`/`tools` would clobber identity and state. */
const MERGEABLE_KEYS: ReadonlyArray<keyof DirectoryFields> = [
  'parentAgentId',
  'role',
  'label',
  'depth',
  'nodeKind',
  'presence',
  'agentName',
  'palette',
  'hueShift',
  'folderName',
  'status',
  'permission',
];

export class AgentDirectory {
  private readonly agents = new Map<number, DirectoryAgent>();
  /** parent id -> direct children, in the order they joined that parent. Kept
   *  in step with every parentAgentId change, so child walks are O(children)
   *  rather than a scan of the whole directory. */
  private readonly children = new Map<number, number[]>();

  /** Creates the agent (no status, no tools, no permission) or merges `fields` into it.
   *  A key present with value `undefined` clears that field. */
  upsert(id: number, fields: DirectoryFields): DirectoryAgent {
    let agent = this.agents.get(id);
    if (!agent) {
      agent = { id, status: null, tools: new Map(), permission: false };
      this.agents.set(id, agent);
    }
    const previousParent = agent.parentAgentId;
    const target = agent as unknown as Record<string, unknown>;
    const source = fields as Record<string, unknown>;
    for (const key of MERGEABLE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
    }
    if (agent.parentAgentId !== previousParent) {
      this.unlinkChild(previousParent, id);
      this.linkChild(agent.parentAgentId, id);
    }
    return agent;
  }

  /** Removes only `id`. Its children are the server's to remove (cascade, leaves
   *  first); until they are, they show in the root office as orphans. */
  remove(id: number): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    this.unlinkChild(agent.parentAgentId, id);
    this.agents.delete(id);
  }

  /** Every agent id, in announcement order. */
  ids(): number[] {
    return [...this.agents.keys()];
  }

  private linkChild(parent: number | undefined, id: number): void {
    if (parent === undefined || parent === id) return;
    const list = this.children.get(parent);
    if (list) list.push(id);
    else this.children.set(parent, [id]);
  }

  private unlinkChild(parent: number | undefined, id: number): void {
    if (parent === undefined) return;
    const list = this.children.get(parent);
    if (!list) return;
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.children.delete(parent);
  }

  get(id: number): DirectoryAgent | undefined {
    return this.agents.get(id);
  }

  /** Direct children, in the order they joined `id`. An agent is never its own child. */
  childrenOf(id: number): number[] {
    return [...(this.children.get(id) ?? [])];
  }

  /** root → top-level agents; n → [n, ...childrenOf(n)] ([] if n is unknown). */
  membersOf(scope: ScopeId): number[] {
    if (scope === 'root') return this.topLevelIds();
    if (!this.agents.has(scope)) return [];
    return [scope, ...this.childrenOf(scope)];
  }

  liveChildCount(id: number): number {
    return this.children.get(id)?.length ?? 0;
  }

  /** True when any strict descendant of `id` has permission=true. */
  hasPermissionBelow(id: number): boolean {
    const children = this.children;
    const visited = new Set<number>([id]);
    const stack = [...(children.get(id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      if (visited.has(next)) continue;
      visited.add(next);
      if (this.agents.get(next)?.permission) return true;
      for (const child of children.get(next) ?? []) stack.push(child);
    }
    return false;
  }

  /** Nearest existing ancestor scope for a scope whose owner disappeared ('root' if none).
   *  `lastKnownParents` remembers parents of agents already removed from the directory. */
  nearestLiveScope(
    scope: ScopeId,
    lastKnownParents: ReadonlyMap<number, number | undefined>,
  ): ScopeId {
    if (scope === 'root' || this.agents.has(scope)) return scope;
    const visited = new Set<number>([scope]);
    let cur = lastKnownParents.get(scope);
    while (cur !== undefined && !visited.has(cur)) {
      if (this.agents.has(cur)) return cur;
      visited.add(cur);
      cur = lastKnownParents.get(cur);
    }
    return 'root';
  }

  setStatus(id: number, status: 'active' | 'waiting'): void {
    const agent = this.agents.get(id);
    if (agent) agent.status = status;
  }

  toolStart(id: number, toolId: string, status: string, toolName?: string): void {
    this.agents.get(id)?.tools.set(toolId, { status, toolName });
  }

  toolDone(id: number, toolId: string): void {
    this.agents.get(id)?.tools.delete(toolId);
  }

  toolsClear(id: number): void {
    this.agents.get(id)?.tools.clear();
  }

  setPermission(id: number, on: boolean): void {
    const agent = this.agents.get(id);
    if (agent) agent.permission = on;
  }

  /**
   * Agents the root office shows: no parent, a parent that is not in the
   * directory (orphan — shown rather than lost, a buried permission request
   * included), or an agent on a parent cycle (otherwise no office would show
   * the cycle at all). One pass over the parent links, O(n).
   */
  private topLevelIds(): number[] {
    const ON_PATH = 1;
    const DONE = 2;
    const state = new Map<number, number>();
    const top = new Set<number>();
    for (const start of this.agents.keys()) {
      if (state.has(start)) continue;
      const path: number[] = [];
      let cur: number | undefined = start;
      while (cur !== undefined && !state.has(cur)) {
        state.set(cur, ON_PATH);
        path.push(cur);
        const parent: number | undefined = this.agents.get(cur)?.parentAgentId;
        if (parent === undefined || !this.agents.has(parent)) {
          top.add(cur);
          cur = undefined;
        } else {
          cur = parent;
        }
      }
      if (cur !== undefined && state.get(cur) === ON_PATH) {
        for (let i = path.indexOf(cur); i < path.length; i++) top.add(path[i]);
      }
      for (const id of path) state.set(id, DONE);
    }
    return [...this.agents.keys()].filter((id) => top.has(id));
  }
}
