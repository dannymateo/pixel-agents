import type { AgentStateStore } from './agentStateStore.js';
import type { AgentState } from './types.js';

/**
 * Pure helpers for working with Lead + Teammates relationships.
 *
 * These replace the duplicated filter pattern
 *   `a.leadAgentId === agentId && !a.teamUsesTmux`
 *
 * "Inline teammate": a teammate running in-process with the lead (no separate
 * terminal). These share the lead's `session_id` in hook events, so routing
 * logic needs to redirect those events from the lead to the teammate.
 *
 * "Tmux teammate": a teammate running in a separate tmux pane with its own
 * `session_id`. Hooks route to it directly; no redirection needed.
 */

/** Is this agent an inline teammate (non-tmux) of the given lead? */
export function isInlineTeammateOf(agent: AgentState, leadId: number): boolean {
  return agent.leadAgentId === leadId && !agent.teamUsesTmux;
}

/** All inline teammates of a lead. Returns [id, agent] pairs for convenience. */
export function getInlineTeammates(
  leadId: number,
  agents: AgentStateStore,
): Array<[number, AgentState]> {
  const out: Array<[number, AgentState]> = [];
  for (const [id, a] of agents) {
    if (isInlineTeammateOf(a, leadId)) out.push([id, a]);
  }
  return out;
}

/** Does this lead have any active inline teammates? */
export function hasInlineTeammates(leadId: number, agents: AgentStateStore): boolean {
  for (const a of agents.values()) {
    if (isInlineTeammateOf(a, leadId)) return true;
  }
  return false;
}

/** Does this lead have inline teammates whose activity could ride the lead's
 *  own (unkeyed) hook events? Derived teammates (docs/adr/0002, spawnAgentKey
 *  set) never qualify: their hooks carry an agent key and route to them. Same
 *  rule as HookEventHandler's hookAmbiguousTeammates. */
export function hasHookAmbiguousTeammates(leadId: number, agents: AgentStateStore): boolean {
  for (const a of agents.values()) {
    if (a.spawnAgentKey === undefined && isInlineTeammateOf(a, leadId)) return true;
  }
  return false;
}

/** Did this agent's spawn tool call become its own character — a derived
 *  agent (docs/adr/0002), named or not? Used by the turn-end re-send paths: a
 *  background tool whose spawn is a character must NOT be re-broadcast, or the
 *  webview would recreate the Subtask sub-character alongside the real one.
 *  Spawns that never materialized (Task-era transcripts, no sidecar yet) don't
 *  match — their re-send fires by design, keeping the Subtask alive. */
export function hasPromotedBackgroundAgent(
  leadId: number,
  toolUseId: string,
  agents: AgentStateStore,
): boolean {
  for (const a of agents.values()) {
    if (a.spawnToolUseId !== toolUseId) continue;
    if (a.parentAgentId === leadId || a.leadAgentId === leadId) return true;
  }
  return false;
}
