import {
  ASK_USER_QUESTION_STATUS,
  ASK_USER_QUESTION_TOOL,
  ATTENTION_TITLE_BASE,
} from '../constants.js';

/**
 * Who in the office is waiting on the user, and why (spec "Te esperan"). Fed
 * from the same wire messages that animate the characters; DOM-free.
 * Priority when several apply: permission > question > waiting.
 */
export type AttentionReason = 'permission' | 'question' | 'waiting';

export interface AttentionEntry {
  id: number;
  reason: AttentionReason;
  since: number;
}

const RANK: Record<AttentionReason, number> = { permission: 3, question: 2, waiting: 1 };

export function attentionTitle(count: number, base: string = ATTENTION_TITLE_BASE): string {
  return count > 0 ? `(${count}) ${base}` : base;
}

/** What the browser tab title should read for the "Te esperan" counter (spec
 *  §3), or `null` when it must not be touched at all — VS Code owns its own
 *  panel title. An untokened browser viewer has no `consoleCapable` (no
 *  `providerCapabilities`), so it can't answer anyone: it sees neither the
 *  bar nor the counter, just the base title. */
export function tabTitle(
  count: number,
  { isBrowser, consoleCapable }: { isBrowser: boolean; consoleCapable: boolean },
): string | null {
  if (!isBrowser) return null;
  return consoleCapable ? attentionTitle(count) : ATTENTION_TITLE_BASE;
}

/** An `agentToolStart`/`subagentToolStart` that asks the user a question
 *  (AskUserQuestion). A sub-agent's start carries no tool name, only the
 *  status the provider formats for it. */
export function isQuestionToolStart(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'agentToolStart' && m.type !== 'subagentToolStart') return false;
  if (typeof m.toolId !== 'string') return false;
  return m.toolName === ASK_USER_QUESTION_TOOL || m.status === ASK_USER_QUESTION_STATUS;
}

const isAgentId = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export class AttentionTracker {
  private readonly entries = new Map<number, AttentionEntry>();
  /** Open question tool ids per agent (AskUserQuestion, own or sub-agent's). */
  private readonly questions = new Map<number, Set<string>>();
  /** Maps toolId → parentToolId for sub-agent questions (so we can clean them up on subagentClear). */
  private readonly questionParents = new Map<number, Map<string, string>>();
  /** Agents that are not roots (spawned, teammate, or workflow node): their
   *  `waiting` is not the user's business. Learned from agentCreated,
   *  existingAgents.agentMeta and agentTeamInfo. */
  private readonly derived = new Set<number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  get size(): number {
    return this.entries.size;
  }

  list(): AttentionEntry[] {
    return [...this.entries.values()].sort((a, b) => a.since - b.since);
  }

  apply(msg: unknown): boolean {
    if (!msg || typeof msg !== 'object') return false;
    const m = msg as Record<string, unknown>;
    if (m.type === 'existingAgents') return this.applySnapshot(m);
    const id = m.id;
    if (typeof id !== 'number' || !Number.isFinite(id)) return false;
    switch (m.type) {
      case 'agentCreated':
        return this.learnIdentity(id, m);
      case 'agentTeamInfo':
        // A session teammate may be linked to its lead after it was created.
        if (isAgentId(m.leadAgentId) && m.leadAgentId !== id) return this.markDerived(id);
        return false;
      case 'agentToolPermission':
      case 'subagentToolPermission':
        return this.raise(id, 'permission');
      case 'agentToolPermissionClear':
        if (!this.drop(id, 'permission')) return false;
        // A question still open underneath is what the agent waits on now.
        if (this.questions.get(id)?.size) this.raise(id, 'question');
        return true;
      case 'agentToolStart':
      case 'subagentToolStart': {
        if (isQuestionToolStart(m) && typeof m.toolId === 'string') {
          let open = this.questions.get(id);
          if (!open) this.questions.set(id, (open = new Set()));
          open.add(m.toolId);
          // Track parentToolId for sub-agent questions (for cleanup on subagentClear).
          if (m.type === 'subagentToolStart' && typeof m.parentToolId === 'string') {
            let parents = this.questionParents.get(id);
            if (!parents) this.questionParents.set(id, (parents = new Map()));
            parents.set(m.toolId, m.parentToolId);
          }
          // Replaces a `waiting`, never a `permission` (permission > question).
          return this.raise(id, 'question');
        }
        // Any other tool: the agent is working again.
        return this.dropUnlessQuestion(id);
      }
      case 'agentToolDone':
      case 'subagentToolDone': {
        const open = this.questions.get(id);
        if (!open || typeof m.toolId !== 'string' || !open.delete(m.toolId)) return false;
        if (open.size > 0) return false;
        this.questions.delete(id);
        this.questionParents.delete(id);
        return this.drop(id, 'question');
      }
      case 'agentClosed':
        this.derived.delete(id);
        this.questions.delete(id);
        this.questionParents.delete(id);
        return this.entries.delete(id);
      case 'agentToolsClear':
        this.questions.delete(id);
        this.questionParents.delete(id);
        return this.entries.delete(id);
      case 'subagentClear': {
        const parentToolId = m.parentToolId;
        if (typeof parentToolId !== 'string') return false;
        const open = this.questions.get(id);
        const parents = this.questionParents.get(id);
        if (!open || !parents) return false;
        // Remove all toolIds that came from this parentToolId.
        let removed = false;
        for (const [toolId, parent] of parents) {
          if (parent === parentToolId && open.delete(toolId)) {
            parents.delete(toolId);
            removed = true;
          }
        }
        if (!removed) return false;
        if (open.size > 0) return false;
        // No questions left; drop the question reason.
        this.questions.delete(id);
        this.questionParents.delete(id);
        return this.drop(id, 'question');
      }
      case 'agentStatus':
        // Spec §3: "Espera respuesta" is a ROOT's signal. A workflow node, a
        // sub-agent or a teammate going idle is waiting on its parent/lead,
        // not on the user (their permissions and questions still count above).
        if (m.status === 'waiting') return this.derived.has(id) ? false : this.raise(id, 'waiting');
        if (m.status === 'active') return this.dropUnlessQuestion(id);
        return false;
      default:
        return false;
    }
  }

  /** Records whether `id` is a root from its agentCreated / agentMeta fields. */
  private learnIdentity(id: number, fields: Record<string, unknown>): boolean {
    const parent = fields.parentAgentId;
    const isDerived =
      (isAgentId(parent) && parent !== id) ||
      fields.nodeKind === 'workflow' ||
      fields.isTeammate === true;
    if (isDerived) return this.markDerived(id);
    this.derived.delete(id);
    return false;
  }

  private markDerived(id: number): boolean {
    this.derived.add(id);
    return this.drop(id, 'waiting');
  }

  private applySnapshot(m: Record<string, unknown>): boolean {
    const ids = Array.isArray(m.agents) ? m.agents.filter(isAgentId) : [];
    const meta = (m.agentMeta && typeof m.agentMeta === 'object' ? m.agentMeta : {}) as Record<
      string,
      unknown
    >;
    // A (re)connect snapshot: whoever is not in it left while we were away.
    // Agents still here keep their entries; the server replays their live
    // permission/waiting right after (resendAgentActivity).
    let changed = false;
    const present = new Set(ids);
    for (const id of [...this.entries.keys(), ...this.questions.keys(), ...this.derived]) {
      if (present.has(id)) continue;
      if (this.entries.delete(id)) changed = true;
      this.questions.delete(id);
      this.questionParents.delete(id);
      this.derived.delete(id);
    }
    for (const id of ids) {
      const fields = meta[id];
      if (
        this.learnIdentity(
          id,
          fields && typeof fields === 'object' ? (fields as Record<string, unknown>) : {},
        )
      ) {
        changed = true;
      }
    }
    return changed;
  }

  private raise(id: number, reason: AttentionReason): boolean {
    const current = this.entries.get(id);
    if (current && RANK[current.reason] >= RANK[reason]) return false;
    this.entries.set(id, { id, reason, since: current?.since ?? this.now() });
    return true;
  }

  private drop(id: number, reason: AttentionReason): boolean {
    if (this.entries.get(id)?.reason !== reason) return false;
    this.entries.delete(id);
    return true;
  }

  private dropUnlessQuestion(id: number): boolean {
    const current = this.entries.get(id);
    if (!current || this.questions.get(id)?.size) return false;
    this.entries.delete(id);
    return true;
  }
}
