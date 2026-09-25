import { describe, expect, it } from 'vitest';

import { describeAgent, statusLabel } from '../src/components/feedFormat.js';
import { applyDirectoryActivity } from '../src/office/living/directoryActivity.js';
import { AgentDirectory } from '../src/office/scope/agentDirectory.js';

/** The agent screen's header state, read exactly as the modal reads it. */
function label(d: AgentDirectory, id: number): string {
  return statusLabel(describeAgent(d, id));
}

function derivedAgent(): AgentDirectory {
  const d = new AgentDirectory();
  d.upsert(1, {});
  d.upsert(2, { parentAgentId: 1, role: 'desarrollador', presence: 'working' });
  return d;
}

describe('applyDirectoryActivity (agent screen header state)', () => {
  it('a working agent running a tool reads "Trabajando", not "Inactivo"', () => {
    const d = derivedAgent();
    applyDirectoryActivity(d, {
      type: 'agentToolStart',
      id: 2,
      toolId: 't1',
      status: 'Running npm test',
      toolName: 'Bash',
    });
    expect(label(d, 2)).toBe('Trabajando');
    expect(d.get(2)!.tools.has('t1')).toBe(true);
  });

  it('stays "Trabajando" between tools inside the turn, like the typing character', () => {
    const d = derivedAgent();
    applyDirectoryActivity(d, { type: 'agentToolStart', id: 2, toolId: 't1', status: 'x' });
    applyDirectoryActivity(d, { type: 'agentToolDone', id: 2, toolId: 't1' });
    expect(d.get(2)!.tools.size).toBe(0);
    expect(label(d, 2)).toBe('Trabajando');
  });

  it('agentStatus drives the turn state', () => {
    const d = derivedAgent();
    applyDirectoryActivity(d, { type: 'agentStatus', id: 2, status: 'active' });
    expect(label(d, 2)).toBe('Trabajando');
    applyDirectoryActivity(d, { type: 'agentStatus', id: 2, status: 'waiting' });
    expect(label(d, 2)).toBe('Esperando');
  });

  it('a turn end clears the running tools and any permission', () => {
    const d = derivedAgent();
    applyDirectoryActivity(d, { type: 'agentToolStart', id: 2, toolId: 't1', status: 'x' });
    applyDirectoryActivity(d, { type: 'agentToolPermission', id: 2 });
    applyDirectoryActivity(d, { type: 'agentToolsClear', id: 2 });
    expect(d.get(2)!.tools.size).toBe(0);
    expect(d.get(2)!.permission).toBe(false);
  });

  it('shows and clears a permission wait', () => {
    const d = derivedAgent();
    applyDirectoryActivity(d, { type: 'agentToolStart', id: 2, toolId: 't1', status: 'x' });
    applyDirectoryActivity(d, { type: 'agentToolPermission', id: 2 });
    expect(label(d, 2)).toBe('Esperando permiso');
    applyDirectoryActivity(d, { type: 'agentToolPermissionClear', id: 2 });
    expect(label(d, 2)).toBe('Trabajando');
  });

  it('a turn ending in waiting drops a stale permission, like the waiting bubble', () => {
    const d = derivedAgent();
    applyDirectoryActivity(d, { type: 'agentToolPermission', id: 2 });
    applyDirectoryActivity(d, { type: 'agentStatus', id: 2, status: 'waiting' });
    expect(label(d, 2)).toBe('Esperando');
  });

  it('a new tool clears the permission unless the hook says it is still pending', () => {
    const d = derivedAgent();
    applyDirectoryActivity(d, { type: 'agentToolPermission', id: 2 });
    applyDirectoryActivity(d, {
      type: 'agentToolStart',
      id: 2,
      toolId: 't1',
      status: 'x',
      permissionActive: true,
    });
    expect(d.get(2)!.permission).toBe(true);
    applyDirectoryActivity(d, { type: 'agentToolStart', id: 2, toolId: 't2', status: 'y' });
    expect(d.get(2)!.permission).toBe(false);
  });

  it('presence still wins once the agent finished: available / lounge / leaving', () => {
    const d = derivedAgent();
    applyDirectoryActivity(d, { type: 'agentToolStart', id: 2, toolId: 't1', status: 'x' });
    d.upsert(2, { presence: 'available' });
    expect(label(d, 2)).toBe('Disponible');
    d.upsert(2, { presence: 'lounge' });
    expect(label(d, 2)).toBe('En descanso');
    d.upsert(2, { presence: 'leaving' });
    expect(label(d, 2)).toBe('Saliendo');
  });

  it('ignores unknown agents, bad ids, bad fields and unrelated messages', () => {
    const d = derivedAgent();
    const before = JSON.stringify(describeAgent(d, 2));
    applyDirectoryActivity(d, { type: 'agentToolStart', id: 99, toolId: 't', status: 'x' });
    applyDirectoryActivity(d, { type: 'agentToolStart', id: -1, toolId: 't', status: 'x' });
    applyDirectoryActivity(d, { type: 'agentToolStart', id: '2', toolId: 't', status: 'x' });
    applyDirectoryActivity(d, { type: 'agentToolStart', id: 2, toolId: 5, status: 'x' });
    applyDirectoryActivity(d, { type: 'agentStatus', id: 2, status: 'bogus' });
    applyDirectoryActivity(d, { type: 'layoutLoaded', id: 2 });
    applyDirectoryActivity(d, null);
    applyDirectoryActivity(d, 'agentStatus');
    expect(d.get(99)).toBeUndefined();
    expect(d.get(2)!.tools.size).toBe(0);
    expect(JSON.stringify(describeAgent(d, 2))).toBe(before);
  });
});
