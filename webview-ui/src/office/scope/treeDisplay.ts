// Display naming for spawn-tree nodes (docs/adr/0002). DOM-free.

/** Prefix that marks a workflow node (a scripted multi-agent run). */
export const WORKFLOW_NODE_PREFIX = '⚙ ';

/** Tree fields the server sends on agentCreated / existingAgents.agentMeta. */
export interface TreeNodeFields {
  parentAgentId?: number;
  teammateName?: string;
  label?: string;
  role?: string;
  nodeKind?: 'agent' | 'workflow';
}

/**
 * The name shown over a spawned agent: a teammate's own name first, then its
 * task label (only privileged connections receive it), then its spawn type.
 * Workflow nodes carry the ⚙ prefix. Undefined when there is nothing to show.
 */
export function treeDisplayName(node: TreeNodeFields): string | undefined {
  const base = node.teammateName || node.label || node.role;
  if (!base) return undefined;
  return node.nodeKind === 'workflow' ? WORKFLOW_NODE_PREFIX + base : base;
}
