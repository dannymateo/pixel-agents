import type { AgentCreated, AgentSeatMeta } from '../../core/src/messages.js';
import type { AgentState } from './types.js';

/**
 * Wire shapes of an agent, shared by every surface (standalone WebSocket,
 * VS Code postMessage) so the two never drift.
 *
 * `privileged` decides what transcript-derived text may leave the process: a
 * derived agent's `label` is its task description (for a workflow agent, the
 * first line of its prompt) — transcript content, which only a connection that
 * proved the out-of-band secret may read. Unprivileged viewers still get the
 * tree (parent, role, depth, kind) and the animation.
 */

/** Same shape as the generated interface, as a plain object type so it can be
 *  handed to the surfaces' `Record<string, unknown>` senders. */
type Wire<T> = { [K in keyof T]: T[K] };

/** The agent's parent in the spawn tree; a teammate's lead when it has no tree parent. */
function wireParentId(agent: AgentState): number | undefined {
  return agent.parentAgentId ?? agent.leadAgentId;
}

export function agentCreatedMessage(agent: AgentState, privileged: boolean): Wire<AgentCreated> {
  return {
    type: 'agentCreated',
    id: agent.id,
    folderName: agent.folderName,
    isExternal: agent.isExternal || undefined,
    isTeammate: agent.leadAgentId !== undefined || undefined,
    teammateName: agent.agentName,
    teamName: agent.teamName,
    hooksOnly: agent.hooksOnly || undefined,
    palette: agent.palette,
    hueShift: agent.hueShift,
    parentAgentId: wireParentId(agent),
    role: agent.role,
    label: privileged ? agent.label : undefined,
    depth: agent.depth,
    nodeKind: agent.nodeKind,
    presence: agent.presence,
  };
}

/** Tree metadata for `existingAgents.agentMeta` (seat fields are added by the caller). */
export function agentTreeMeta(
  agent: AgentState,
  privileged: boolean,
): Pick<
  AgentSeatMeta,
  'parentAgentId' | 'role' | 'label' | 'depth' | 'teammateName' | 'nodeKind' | 'presence'
> {
  return {
    parentAgentId: wireParentId(agent),
    role: agent.role,
    label: privileged ? agent.label : undefined,
    depth: agent.depth,
    teammateName: agent.agentName,
    nodeKind: agent.nodeKind,
    presence: agent.presence,
  };
}
