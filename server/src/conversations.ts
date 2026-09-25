import type { AgentConversation, ConversationKind } from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  CONVERSATION_FUTURE_SKEW_MS,
  CONVERSATION_PENDING_ASSIGN_TTL_MS,
  CONVERSATION_PENDING_ASSIGNS_MAX,
  CONVERSATION_SEEN_IDS_MAX,
  CONVERSATION_TEXT_MAX_BYTES,
} from './constants.js';
import { sanitizeFeedText, truncateUtf8 } from './feedDiff.js';
import { rootOf } from './fileWatcher.js';

/**
 * Conversations between agents (spec §4b, plan T13): turns what the provider
 * recognizes in transcript records into `agentConversation` broadcasts.
 *
 * - `assign` (parent → child): the spawn call's prompt is kept by its tool id
 *   and goes out when the child materializes, addressed to it.
 * - `report` (child → parent): the child's handback; when a foreground spawn
 *   closes with no handback, its tool_result is the report (fallback). One
 *   report per round — a message from the parent to the child opens the next.
 * - `message` (any → recipient): resolved by spawn key, then by name, among
 *   the agents of the sender's tree (or its team, for own-session teammates);
 *   unresolved goes out without `toId`.
 *
 * Only what happens while the office watches is a scene. Anything written
 * before the office saw an agent is history and stays silent, decided three
 * ways (docs: T13 report):
 *  1. the caller flags a record `{ initial: true }` (history seeding paths);
 *  2. every agent starts "replaying" when it enters the store (and whoever is
 *     already there when the tracker is built): its records dated before that
 *     moment are history; the first record dated at or after it ends the
 *     replay for good. Transcripts read again from the start re-arm it with
 *     `beginReplay`;
 *  3. a child whose spawn call was read live skips the replay: its whole
 *     transcript is new.
 *
 * The text is transcript content: sanitized and capped here whatever the
 * provider returned, and stripped by the send layer for unprivileged
 * connections (httpServer.ts). Every index is a Map/Set keyed by agent id and
 * bounded; an agent's state goes with it when it leaves the store.
 */

/** Longest record uuid / tool id used to build a conversation id. */
const CONVERSATION_ID_PART_MAX_CHARS = 128;
/** Conversation ids reach unprivileged connections: only id-shaped text. */
const ID_PART_RE = /^[A-Za-z0-9_.:-]+$/;
/** Longest timestamp string parsed (ISO 8601 is 24 characters). */
const TIMESTAMP_MAX_CHARS = 64;
/** Raw text examined before sanitizing (sanitizing only shrinks). */
const CONVERSATION_SCAN_BYTES = CONVERSATION_TEXT_MAX_BYTES * 2;

const KINDS: ReadonlySet<string> = new Set<ConversationKind>(['assign', 'report', 'message']);

type Rec = Record<string, unknown>;

export interface ConversationReadOptions {
  /** The record is history (seeding / catch-up read): remember it, never emit. */
  initial?: boolean;
}

interface PendingAssign {
  conversationId: string;
  text: string;
  /** When it was stored (ms), for CONVERSATION_PENDING_ASSIGN_TTL_MS. */
  at: number;
}

const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

function idPart(v: unknown): string | undefined {
  return typeof v === 'string' &&
    v.length > 0 &&
    v.length <= CONVERSATION_ID_PART_MAX_CHARS &&
    ID_PART_RE.test(v)
    ? v
    : undefined;
}

function cleanText(v: unknown): string {
  if (typeof v !== 'string') return '';
  return truncateUtf8(
    sanitizeFeedText(truncateUtf8(v, CONVERSATION_SCAN_BYTES)),
    CONVERSATION_TEXT_MAX_BYTES,
  );
}

function recordTime(record: Rec): number {
  const ts = record.timestamp;
  if (typeof ts !== 'string' || ts.length > TIMESTAMP_MAX_CHARS) return NaN;
  return Date.parse(ts);
}

/** Text of the tool_result block answering `toolUseId` in a user record:
 *  string content, or its text blocks joined. Undefined when absent. */
function toolResultText(record: Rec, toolUseId: string): string | undefined {
  const message = record.message;
  if (!isObj(message) || !Array.isArray(message.content)) return undefined;
  for (const block of message.content) {
    if (!isObj(block) || block.type !== 'tool_result' || block.tool_use_id !== toolUseId) continue;
    // An interrupted or refused spawn: harness text, not the child's answer.
    if (block.is_error === true) return undefined;
    const content = block.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts: string[] = [];
    let size = 0;
    for (const part of content) {
      if (!isObj(part) || part.type !== 'text' || typeof part.text !== 'string') continue;
      parts.push(part.text);
      size += part.text.length;
      if (size > CONVERSATION_SCAN_BYTES) break;
    }
    return parts.join('\n');
  }
  return undefined;
}

/** Bounded insertion-ordered set: past `max` the oldest entry goes. */
function rememberBounded(set: Set<string>, value: string, max: number): void {
  set.add(value);
  if (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

export class ConversationTracker {
  /** Agents still reading history: records dated before this ms are silent. */
  private readonly replaySince = new Map<number, number>();
  /** Spawn prompts read live, per parent, by spawn tool id. */
  private readonly pendingAssigns = new Map<number, Map<string, PendingAssign>>();
  /** Conversation ids already handled, per agent that wrote them. */
  private readonly seenIds = new Map<number, Set<string>>();
  /** Per child: how the current round was reported (suppresses the other path). */
  private readonly reported = new Map<number, 'handback' | 'fallback'>();
  /** Ids for messages in records without a uuid (never deduplicated). */
  private undatedSeq = 0;
  private disposed = false;

  private readonly onAgentAdded = (id: number) => {
    this.forget(id);
    this.replaySince.set(id, Date.now());
  };
  private readonly onAgentRemoved = (id: number) => this.forget(id);

  constructor(
    private readonly store: AgentStateStore,
    private readonly provider: HookProvider,
  ) {
    const now = Date.now();
    for (const id of store.keys()) this.replaySince.set(id, now);
    store.on('agentAdded', this.onAgentAdded);
    store.on('agentRemoved', this.onAgentRemoved);
  }

  /** One parsed transcript record of `agentId` (the agent that wrote it). */
  onRecord(agentId: number, record: Record<string, unknown>, opts?: ConversationReadOptions): void {
    if (this.disposed || !this.store.has(agentId) || !isObj(record)) return;
    const parse = this.provider.parseConversations;
    if (!parse) return;
    let found: ReturnType<NonNullable<HookProvider['parseConversations']>>;
    try {
      found = parse.call(this.provider, record);
    } catch (e) {
      console.log(`[Pixel Agents] Conversations: Agent ${agentId} - parse error: ${e}`);
      return;
    }
    if (!Array.isArray(found) || found.length === 0) return;

    const live = this.isLive(agentId, record, opts);
    const uuid = idPart(record.uuid);
    found.forEach((c, i) => {
      if (!isObj(c) || typeof c.kind !== 'string' || !KINDS.has(c.kind)) return;
      const spawnToolUseId = idPart(c.spawnToolUseId);
      const key = uuid !== undefined ? (i === 0 ? uuid : `${uuid}:${i}`) : spawnToolUseId;
      const conversationId = key === undefined ? undefined : `${agentId}:${key}`;
      if (conversationId !== undefined) {
        if (this.seen(agentId).has(conversationId)) return;
        rememberBounded(this.seen(agentId), conversationId, CONVERSATION_SEEN_IDS_MAX);
      }
      const text = cleanText(c.text);
      switch (c.kind as ConversationKind) {
        case 'assign':
          if (live && spawnToolUseId !== undefined && conversationId !== undefined) {
            this.assign(agentId, spawnToolUseId, { conversationId, text, at: Date.now() });
          }
          return;
        case 'report':
          this.handback(agentId, conversationId, text, live);
          return;
        case 'message':
          if (live) this.message(agentId, conversationId, text, c.to);
          return;
      }
    });
  }

  /** A derived agent now exists in the store (call after `agents.set`). Emits
   *  the assignment its parent's live spawn call left for it, if any. */
  onChildMaterialized(parentId: number, childId: number, spawnToolUseId?: string): void {
    if (this.disposed || spawnToolUseId === undefined || !this.store.has(childId)) return;
    const byTool = this.pendingAssigns.get(parentId);
    const pending = byTool?.get(spawnToolUseId);
    if (!byTool || !pending) return;
    byTool.delete(spawnToolUseId);
    if (Date.now() - pending.at > CONVERSATION_PENDING_ASSIGN_TTL_MS) return;
    // Spawned while we watched: everything it wrote is new.
    this.replaySince.delete(childId);
    this.emit(pending.conversationId, parentId, childId, 'assign', pending.text);
  }

  /**
   * A FOREGROUND spawn of `parentId` closed with its tool_result (`record` is
   * the user record carrying it). Report fallback: the child's answer, unless
   * the child already handed back this round. Call before the child is
   * removed — it is looked up in the store. Background spawns' results are
   * launch receipts, not reports: never pass them here.
   */
  onSpawnResult(
    parentId: number,
    spawnToolUseId: string,
    record: Record<string, unknown>,
    opts?: ConversationReadOptions,
  ): void {
    const idTail = idPart(spawnToolUseId);
    if (this.disposed || idTail === undefined || !this.store.has(parentId) || !isObj(record)) {
      return;
    }
    const childId = this.childOf(parentId, spawnToolUseId);
    if (childId === undefined) return;
    const resultText = toolResultText(record, spawnToolUseId);
    if (resultText === undefined) return;
    if (!this.isLive(parentId, record, opts)) return;
    if (this.reported.get(childId) === 'handback') return;
    const conversationId = `${childId}:${idTail}:result`;
    if (this.seen(childId).has(conversationId)) return;
    rememberBounded(this.seen(childId), conversationId, CONVERSATION_SEEN_IDS_MAX);
    this.reported.set(childId, 'fallback');
    this.emit(conversationId, childId, parentId, 'report', cleanText(resultText));
  }

  /** `agentId`'s transcript is read again from the start (reassigned file,
   *  rewound offset): what it re-reads is history until a record dated now. */
  beginReplay(agentId: number, since = Date.now()): void {
    if (this.disposed || !this.store.has(agentId)) return;
    this.replaySince.set(agentId, since);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.store.off('agentAdded', this.onAgentAdded);
    this.store.off('agentRemoved', this.onAgentRemoved);
    this.replaySince.clear();
    this.pendingAssigns.clear();
    this.seenIds.clear();
    this.reported.clear();
  }

  // ── Internals ──

  private isLive(agentId: number, record: Rec, opts?: ConversationReadOptions): boolean {
    if (opts?.initial) return false;
    const since = this.replaySince.get(agentId);
    if (since === undefined) return true;
    const t = recordTime(record);
    if (!Number.isFinite(t) || t < since || t > Date.now() + CONVERSATION_FUTURE_SKEW_MS) {
      return false;
    }
    this.replaySince.delete(agentId);
    return true;
  }

  private assign(parentId: number, spawnToolUseId: string, pending: PendingAssign): void {
    // The child may already exist (scan beat the parent's record): out at once.
    const childId = this.childOf(parentId, spawnToolUseId);
    if (childId !== undefined) {
      // Spawned while we watched, like onChildMaterialized: its records are new.
      this.replaySince.delete(childId);
      this.emit(pending.conversationId, parentId, childId, 'assign', pending.text);
      return;
    }
    let byTool = this.pendingAssigns.get(parentId);
    if (!byTool) {
      byTool = new Map();
      this.pendingAssigns.set(parentId, byTool);
    }
    byTool.delete(spawnToolUseId);
    for (const [id, p] of byTool) {
      if (pending.at - p.at <= CONVERSATION_PENDING_ASSIGN_TTL_MS) break; // oldest first
      byTool.delete(id);
    }
    byTool.set(spawnToolUseId, pending);
    if (byTool.size > CONVERSATION_PENDING_ASSIGNS_MAX) {
      const oldest = byTool.keys().next().value;
      if (oldest !== undefined) byTool.delete(oldest);
    }
  }

  private handback(
    childId: number,
    conversationId: string | undefined,
    text: string,
    live: boolean,
  ): void {
    const child = this.store.get(childId);
    const parentId = child?.parentAgentId ?? child?.leadAgentId;
    if (parentId === undefined || parentId === childId) return;
    // Already reported by the spawn result (its file was polled first).
    if (this.reported.get(childId) === 'fallback') return;
    // Only a handback that became a scene suppresses the fallback: one read as
    // history must not silence a live spawn result.
    if (!live) return;
    this.reported.set(childId, 'handback');
    this.emit(
      conversationId ?? `${childId}:#${this.undatedSeq++}`,
      childId,
      parentId,
      'report',
      text,
    );
  }

  private message(
    fromId: number,
    conversationId: string | undefined,
    text: string,
    to: unknown,
  ): void {
    const toId = typeof to === 'string' ? this.resolve(fromId, to) : undefined;
    // A parent writing to its child opens a new round: it may report again.
    if (toId !== undefined && this.store.get(toId)?.parentAgentId === fromId) {
      this.reported.delete(toId);
    }
    this.emit(conversationId ?? `${fromId}:#${this.undatedSeq++}`, fromId, toId, 'message', text);
  }

  /**
   * The agent `to` names, seen from `fromId`: its tree first (spawn key, then
   * name — the newest when several share it), then its team (own-session
   * teammates are roots of their own). Never the sender itself.
   */
  private resolve(fromId: number, to: string): number | undefined {
    const from = this.store.get(fromId);
    if (!from) return undefined;
    const rootId = rootOf(fromId, this.store);
    const team = from.teamName;
    let byTreeName: number | undefined;
    let byTeamKey: number | undefined;
    let byTeamName: number | undefined;
    for (const a of this.store.values()) {
      if (a.id === fromId) continue;
      const keyMatch = a.spawnAgentKey === to;
      const nameMatch = a.agentName === to;
      if (!keyMatch && !nameMatch) continue;
      if (rootOf(a.id, this.store) === rootId) {
        if (keyMatch) return a.id;
        if (byTreeName === undefined || a.id > byTreeName) byTreeName = a.id;
      } else if (team !== undefined && a.teamName === team && a.projectDir === from.projectDir) {
        if (keyMatch) byTeamKey ??= a.id;
        else if (byTeamName === undefined || a.id > byTeamName) byTeamName = a.id;
      }
    }
    return byTreeName ?? byTeamKey ?? byTeamName;
  }

  /** The derived agent a parent's spawn call produced, if it exists. */
  private childOf(parentId: number, spawnToolUseId: string): number | undefined {
    for (const a of this.store.values()) {
      if (a.parentAgentId === parentId && a.spawnToolUseId === spawnToolUseId) return a.id;
    }
    return undefined;
  }

  private seen(agentId: number): Set<string> {
    let set = this.seenIds.get(agentId);
    if (!set) {
      set = new Set();
      this.seenIds.set(agentId, set);
    }
    return set;
  }

  private forget(agentId: number): void {
    this.replaySince.delete(agentId);
    this.pendingAssigns.delete(agentId);
    this.seenIds.delete(agentId);
    this.reported.delete(agentId);
  }

  private emit(
    conversationId: string,
    fromId: number,
    toId: number | undefined,
    kind: ConversationKind,
    text: string,
  ): void {
    const msg: AgentConversation = { type: 'agentConversation', conversationId, fromId, kind };
    if (toId !== undefined) msg.toId = toId;
    if (text) msg.text = text;
    this.store.broadcast(msg as unknown as Record<string, unknown>);
  }
}
