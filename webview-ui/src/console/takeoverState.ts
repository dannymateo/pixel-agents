/**
 * "Traer a la oficina" (spec §1): client-side state for an in-flight takeover,
 * keyed by agent id. `waitingExit` is shown while the server waits for the
 * external session to close; `failed`/`refused` stay until the user dismisses
 * them or moves on to another agent (the component only renders them for the
 * currently selected/open agent, so switching away already hides them —
 * `dismissTakeover` in useExtensionMessages clears the entry outright).
 * `done`/`cancelled` remove the entry: `done` hands the agent a `terminalId`
 * and opens its console (handled by the caller, not here).
 *
 * A pure reducer, DOM-free, so it runs under the Node test runner.
 */
export interface TakeoverView {
  state: 'waitingExit' | 'failed' | 'refused';
  reason?: string;
}

const CLEARING_STATES = new Set(['done', 'cancelled']);
const PERSISTENT_STATES = new Set(['failed', 'refused']);
/** States that end a locally-tracked takeover request (see
 *  `takeoverRequestSettledId`), i.e. every terminal `takeoverStatus`. */
const SETTLED_STATES = new Set(['done', 'cancelled', 'failed', 'refused']);

/** `state` after applying a wire message; the SAME Map reference when nothing
 *  changes, so a caller wiring this into `setState` never triggers an
 *  unnecessary re-render. */
export function applyTakeover(
  state: Map<number, TakeoverView>,
  msg: unknown,
): Map<number, TakeoverView> {
  if (!msg || typeof msg !== 'object') return state;
  const m = msg as Record<string, unknown>;

  // Full resync on (re)connect: the server's pending takeover marks live only
  // in memory (spec §1) and don't survive a restart, so anything we were
  // still tracking is stale the moment a fresh `existingAgents` snapshot
  // arrives — a lingering `waitingExit`/`failed` panel would otherwise sit
  // there forever with no message ever going to clear it. A reconnect WITHOUT
  // a restart keeps its marks: the server re-sends `waitingExit` for each one
  // right after this snapshot (handleWebviewReady step 9).
  if (m.type === 'existingAgents') {
    return state.size === 0 ? state : new Map();
  }

  const id = m.id;
  if (typeof id !== 'number' || !Number.isFinite(id)) return state;

  if (m.type === 'takeoverStatus') {
    const takeoverState = m.state;
    if (takeoverState === 'waitingExit') {
      const next = new Map(state);
      next.set(id, { state: 'waitingExit' });
      return next;
    }
    if (typeof takeoverState === 'string' && CLEARING_STATES.has(takeoverState)) {
      if (!state.has(id)) return state;
      const next = new Map(state);
      next.delete(id);
      return next;
    }
    if (typeof takeoverState === 'string' && PERSISTENT_STATES.has(takeoverState)) {
      const next = new Map(state);
      const reason = typeof m.reason === 'string' ? m.reason : undefined;
      next.set(id, { state: takeoverState as 'failed' | 'refused', reason });
      return next;
    }
    return state;
  }

  if (m.type === 'agentClosed') {
    if (!state.has(id)) return state;
    const next = new Map(state);
    next.delete(id);
    return next;
  }

  return state;
}

/** Whether "Traer a la oficina" can be offered for an agent: a root (no
 *  parent, no team lead) that has no console of its own yet, and only when
 *  the connection is capable of opening one (privileged + a live pty host). */
export function canOfferTakeover(
  agent: { parentAgentId?: number | null; leadAgentId?: number; terminalId?: string },
  consoleCapable: boolean,
): boolean {
  const isRoot =
    (agent.parentAgentId === null || agent.parentAgentId === undefined) &&
    agent.leadAgentId === undefined;
  return consoleCapable && isRoot && !agent.terminalId;
}

/**
 * Multi-tab ruling: several operator tabs can watch the same office, but only
 * the ONE that sent `takeOverAgent` for this id should pop its console open on
 * `done` — every other tab just gets the character's `terminalId` set (via
 * `os.setTerminalId`, called unconditionally by the caller) so clicking the
 * character opens it instead. `requestedIds` is the calling tab's own set of
 * ids it has asked to take over (tracked in useExtensionMessages: added when
 * it sends `takeOverAgent`, removed once the request settles — see
 * `takeoverRequestSettledId`).
 */
export function shouldOpenConsoleOnDone(requestedIds: ReadonlySet<number>, msg: unknown): boolean {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'takeoverStatus' || m.state !== 'done') return false;
  const id = m.id;
  if (typeof id !== 'number' || !Number.isFinite(id)) return false;
  return requestedIds.has(id);
}

/**
 * The agent id whose locally-tracked "I asked for this" request should be
 * forgotten, or `null` when `msg` doesn't end one: every terminal
 * `takeoverStatus` (`done`/`cancelled`/`failed`/`refused`) or the agent
 * disappearing outright (`agentClosed`). `waitingExit` does NOT settle it —
 * that's the request still in flight.
 */
export function takeoverRequestSettledId(msg: unknown): number | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  const id = m.id;
  if (typeof id !== 'number' || !Number.isFinite(id)) return null;
  if (m.type === 'takeoverStatus' && typeof m.state === 'string' && SETTLED_STATES.has(m.state)) {
    return id;
  }
  if (m.type === 'agentClosed') return id;
  return null;
}
