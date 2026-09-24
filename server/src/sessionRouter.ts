import {
  HOOK_EVENT_BUFFER_MS,
  MAX_BUFFERED_HOOK_EVENTS,
  MAX_BUFFERED_HOOK_EVENTS_PER_SPAWN,
} from './constants.js';

/** Pending external session info (waiting for confirmation event before creating agent). */
export interface PendingExternalSession {
  sessionId: string;
  /** Transcript file path. Undefined for providers without transcripts (OpenCode, Copilot). */
  transcriptPath: string | undefined;
  cwd: string;
}

/** An event waiting to be dispatched once its agent registers. */
export interface BufferedEvent {
  providerId: string;
  event: { session_id: string; [key: string]: unknown };
  /** Set when the event fired inside a spawned (derived) agent; such events only
   *  ever flush to that agent via registerSpawn, never to the session root. */
  agentKey?: string;
  timestamp: number;
}

/**
 * Maps session IDs to agent IDs, manages pending external sessions, and
 * buffers events that arrive before their agent registers.
 *
 * Extracted from HookEventHandler to separate session-routing concerns
 * from event dispatch and webview messaging.
 */
export class SessionRouter {
  private sessionToAgentId = new Map<string, number>();
  /** sessionId → agentKey → agentId for derived agents. Every agent spawned
   *  inside a session shares the root's session_id, so the pair is the identity.
   *  Nested maps (not a joined string key) so no session/key content can alias
   *  another pair. */
  private spawnToAgentId = new Map<string, Map<string, number>>();
  private pendingSessions = new Map<string, PendingExternalSession>();
  private buffer: BufferedEvent[] = [];
  private bufferTimer: ReturnType<typeof setInterval> | null = null;

  // ── Session → Agent mapping ────────────────────────────────────────

  /** Register a session→agent mapping. Returns any buffered events for this
   *  session so the caller can re-dispatch them. */
  register(sessionId: string, agentId: number): BufferedEvent[] {
    this.sessionToAgentId.set(sessionId, agentId);
    return this.flushBuffered(sessionId);
  }

  unregister(sessionId: string): void {
    this.sessionToAgentId.delete(sessionId);
  }

  resolve(sessionId: string): number | undefined {
    return this.sessionToAgentId.get(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessionToAgentId.has(sessionId);
  }

  // ── (Session, agentKey) → derived agent mapping ────────────────────

  /** Register a derived agent spawned inside `sessionId`. Returns the buffered
   *  events carrying that exact (sessionId, agentKey) so the caller can
   *  re-dispatch them. Independent of the root mapping: registering or
   *  unregistering one never touches the other. */
  registerSpawn(sessionId: string, agentKey: string, agentId: number): BufferedEvent[] {
    let byKey = this.spawnToAgentId.get(sessionId);
    if (!byKey) {
      byKey = new Map();
      this.spawnToAgentId.set(sessionId, byKey);
    }
    byKey.set(agentKey, agentId);
    return this.flushWhere((b) => b.event.session_id === sessionId && b.agentKey === agentKey);
  }

  unregisterSpawn(sessionId: string, agentKey: string): void {
    const byKey = this.spawnToAgentId.get(sessionId);
    if (!byKey) return;
    byKey.delete(agentKey);
    if (byKey.size === 0) this.spawnToAgentId.delete(sessionId);
  }

  resolveSpawn(sessionId: string, agentKey: string): number | undefined {
    return this.spawnToAgentId.get(sessionId)?.get(agentKey);
  }

  /** Forget every derived agent of `sessionId` and drop its keyed buffered
   *  events (they could only ever flush to those agents). Meant for the
   *  session root's end (wired by the hook handler / runtime). Unkeyed (root) events and the root mapping are
   *  untouched. */
  clearSpawns(sessionId: string): void {
    this.spawnToAgentId.delete(sessionId);
    this.flushWhere((b) => b.event.session_id === sessionId && b.agentKey !== undefined);
  }

  // ── Pending external sessions ──────────────────────────────────────

  storePending(sessionId: string, info: PendingExternalSession): void {
    this.pendingSessions.set(sessionId, info);
  }

  confirmPending(sessionId: string): PendingExternalSession | undefined {
    const info = this.pendingSessions.get(sessionId);
    if (info) this.pendingSessions.delete(sessionId);
    return info;
  }

  hasPending(sessionId: string): boolean {
    return this.pendingSessions.has(sessionId);
  }

  discardPending(sessionId: string): void {
    this.pendingSessions.delete(sessionId);
  }

  // ── Event buffering ────────────────────────────────────────────────

  /** Buffer an event until its agent registers. Pass `agentKey` when the event
   *  fired inside a spawned agent: it then waits for registerSpawn and is never
   *  handed to the session root; unclaimed events expire after
   *  HOOK_EVENT_BUFFER_MS like any other. Bounded: past
   *  MAX_BUFFERED_HOOK_EVENTS_PER_SPAWN for one (session, agentKey) pair, or
   *  MAX_BUFFERED_HOOK_EVENTS overall, the oldest event of that group is dropped.
   *  The global cap is deliberately blind to session and key: under a burst of
   *  more than MAX_BUFFERED_HOOK_EVENTS within the buffer window, keyed events
   *  can evict a waiting root event (and vice versa). */
  bufferEvent(
    providerId: string,
    event: { session_id: string; [key: string]: unknown },
    agentKey?: string,
  ): void {
    this.buffer.push({ providerId, event, agentKey, timestamp: Date.now() });
    if (agentKey !== undefined) this.enforceSpawnCap(event.session_id, agentKey);
    // Buffer is in arrival order, so the head is the oldest event.
    if (this.buffer.length > MAX_BUFFERED_HOOK_EVENTS) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_HOOK_EVENTS);
    }
    if (!this.bufferTimer) {
      this.bufferTimer = setInterval(() => {
        this.pruneExpired();
      }, HOOK_EVENT_BUFFER_MS);
    }
  }

  hasBuffered(sessionId: string): boolean {
    return this.buffer.some((b) => b.event.session_id === sessionId);
  }

  /** True only when the session has buffered events WITHOUT an agentKey — the
   *  ones that would flush to the root. Keyed events don't count. */
  hasBufferedRoot(sessionId: string): boolean {
    return this.buffer.some((b) => b.event.session_id === sessionId && b.agentKey === undefined);
  }

  pruneExpired(): void {
    const cutoff = Date.now() - HOOK_EVENT_BUFFER_MS;
    this.buffer = this.buffer.filter((b) => b.timestamp > cutoff);
    this.cleanupBufferTimer();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  dispose(): void {
    if (this.bufferTimer) {
      clearInterval(this.bufferTimer);
      this.bufferTimer = null;
    }
    this.sessionToAgentId.clear();
    this.spawnToAgentId.clear();
    this.buffer = [];
    this.pendingSessions.clear();
  }

  // ── Private ────────────────────────────────────────────────────────

  /** Root flush: only events WITHOUT an agentKey — keyed events belong to a
   *  derived agent and must never animate the root. */
  private flushBuffered(sessionId: string): BufferedEvent[] {
    return this.flushWhere((b) => b.event.session_id === sessionId && b.agentKey === undefined);
  }

  private flushWhere(pred: (b: BufferedEvent) => boolean): BufferedEvent[] {
    const toFlush: BufferedEvent[] = [];
    const kept: BufferedEvent[] = [];
    for (const b of this.buffer) (pred(b) ? toFlush : kept).push(b);
    this.buffer = kept;
    this.cleanupBufferTimer();
    return toFlush;
  }

  /** Drop the oldest events of one (session, agentKey) pair past its cap. */
  private enforceSpawnCap(sessionId: string, agentKey: string): void {
    let count = 0;
    for (const b of this.buffer) {
      if (b.event.session_id === sessionId && b.agentKey === agentKey) count++;
    }
    let excess = count - MAX_BUFFERED_HOOK_EVENTS_PER_SPAWN;
    if (excess <= 0) return;
    this.buffer = this.buffer.filter((b) => {
      if (excess > 0 && b.event.session_id === sessionId && b.agentKey === agentKey) {
        excess--;
        return false;
      }
      return true;
    });
  }

  private cleanupBufferTimer(): void {
    if (this.buffer.length === 0 && this.bufferTimer) {
      clearInterval(this.bufferTimer);
      this.bufferTimer = null;
    }
  }
}
