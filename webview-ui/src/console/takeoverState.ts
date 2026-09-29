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

/** `state` after applying a wire message; the SAME Map reference when nothing
 *  changes, so a caller wiring this into `setState` never triggers an
 *  unnecessary re-render. */
export function applyTakeover(
  state: Map<number, TakeoverView>,
  msg: unknown,
): Map<number, TakeoverView> {
  if (!msg || typeof msg !== 'object') return state;
  const m = msg as Record<string, unknown>;
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
