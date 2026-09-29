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

export class AttentionTracker {
  private readonly entries = new Map<number, AttentionEntry>();
  /** Open question tool ids per agent (AskUserQuestion, own or sub-agent's). */
  private readonly questions = new Map<number, Set<string>>();

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.entries.size;
  }

  list(): AttentionEntry[] {
    return [...this.entries.values()].sort((a, b) => a.since - b.since);
  }

  apply(msg: unknown): boolean {
    if (!msg || typeof msg !== 'object') return false;
    const m = msg as Record<string, unknown>;
    const id = m.id;
    if (typeof id !== 'number' || !Number.isFinite(id)) return false;
    switch (m.type) {
      case 'agentToolPermission':
      case 'subagentToolPermission':
        return this.raise(id, 'permission');
      case 'agentToolPermissionClear':
        return this.drop(id, 'permission');
      case 'agentToolStart':
      case 'subagentToolStart': {
        const isQuestion =
          m.toolName === ASK_USER_QUESTION_TOOL || m.status === ASK_USER_QUESTION_STATUS;
        if (isQuestion && typeof m.toolId === 'string') {
          let open = this.questions.get(id);
          if (!open) this.questions.set(id, (open = new Set()));
          open.add(m.toolId);
          return this.raise(id, 'question', true);
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
        return this.drop(id, 'question');
      }
      case 'agentToolsClear':
      case 'agentClosed':
        this.questions.delete(id);
        return this.entries.delete(id);
      case 'agentStatus':
        if (m.status === 'waiting') return this.raise(id, 'waiting');
        if (m.status === 'active') return this.dropUnlessQuestion(id);
        return false;
      default:
        return false;
    }
  }

  private raise(id: number, reason: AttentionReason, force = false): boolean {
    const current = this.entries.get(id);
    if (current && !force && RANK[current.reason] >= RANK[reason]) return false;
    if (current?.reason === reason) return false;
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
