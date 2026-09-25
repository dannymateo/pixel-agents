/**
 * Feeds the AgentDirectory's per-agent activity (turn status, running tools,
 * permission wait) from the same server messages that animate the character.
 *
 * The directory is what the agent screen's header reads (`describeAgent`);
 * without this feed its `status` stayed null and a working agent read
 * "Inactivo". The rules mirror the character's: a tool start makes the agent
 * active (it types/reads) and clears a permission wait unless the hook says it
 * is still pending; `agentStatus` sets the turn state; a turn end
 * (`agentToolsClear`) drops the running tools and the permission wait.
 *
 * DOM-free and defensive: messages are wire JSON, so every field is checked and
 * an unknown agent is a no-op (the directory ignores ids it does not hold).
 */

import type { AgentDirectory } from '../scope/agentDirectory.js';
import { isWireAgentId } from './livingOfficeController.js';

export function applyDirectoryActivity(directory: AgentDirectory, msg: unknown): void {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as Record<string, unknown>;
  const id = m.id;
  if (!isWireAgentId(id) || !directory.get(id)) return;
  switch (m.type) {
    case 'agentToolStart': {
      if (typeof m.toolId !== 'string' || typeof m.status !== 'string') return;
      const toolName = typeof m.toolName === 'string' ? m.toolName : undefined;
      directory.toolStart(id, m.toolId, m.status, toolName);
      directory.setStatus(id, 'active');
      if (m.permissionActive !== true) directory.setPermission(id, false);
      return;
    }
    case 'agentToolDone':
      if (typeof m.toolId === 'string') directory.toolDone(id, m.toolId);
      return;
    case 'agentToolsClear':
      directory.toolsClear(id);
      directory.setPermission(id, false);
      return;
    case 'agentStatus':
      if (m.status === 'active' || m.status === 'waiting') directory.setStatus(id, m.status);
      // The character's waiting bubble replaces a permission bubble; so here.
      if (m.status === 'waiting') directory.setPermission(id, false);
      return;
    case 'agentToolPermission':
      directory.setPermission(id, true);
      return;
    case 'agentToolPermissionClear':
      directory.setPermission(id, false);
      return;
    default:
      return;
  }
}
