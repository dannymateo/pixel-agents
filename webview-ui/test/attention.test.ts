import { expect, test } from 'vitest';

import { attentionTitle, AttentionTracker, tabTitle } from '../src/office/attention.js';

function tracker() {
  let t = 1000;
  const tr = new AttentionTracker(() => t);
  return { tr, tick: (ms: number) => (t += ms) };
}

test('a permission request puts the agent on the list', () => {
  const { tr } = tracker();
  expect(tr.apply({ type: 'agentToolPermission', id: 1 })).toBe(true);
  expect(tr.list()).toEqual([{ id: 1, reason: 'permission', since: 1000 }]);
});

test('the permission clears when resolved or when the agent moves on', () => {
  const { tr } = tracker();
  tr.apply({ type: 'agentToolPermission', id: 1 });
  tr.apply({ type: 'agentToolPermissionClear', id: 1 });
  expect(tr.size).toBe(0);
  tr.apply({ type: 'agentToolPermission', id: 2 });
  tr.apply({ type: 'agentToolStart', id: 2, toolId: 't', status: 'Reading x', toolName: 'Read' });
  expect(tr.size).toBe(0);
  tr.apply({ type: 'agentToolPermission', id: 3 });
  tr.apply({ type: 'agentStatus', id: 3, status: 'active' });
  expect(tr.size).toBe(0);
});

test('AskUserQuestion is a question until its tool is done', () => {
  const { tr } = tracker();
  tr.apply({
    type: 'agentToolStart',
    id: 1,
    toolId: 'q1',
    status: 'Waiting for your answer',
    toolName: 'AskUserQuestion',
  });
  expect(tr.list()[0]).toMatchObject({ id: 1, reason: 'question' });
  tr.apply({ type: 'agentToolDone', id: 1, toolId: 'q1' });
  expect(tr.size).toBe(0);
});

test('a sub-agent question (status only, no toolName) counts on the parent id it arrives with', () => {
  const { tr } = tracker();
  tr.apply({
    type: 'subagentToolStart',
    id: 7,
    parentToolId: 'p',
    toolId: 's1',
    status: 'Waiting for your answer',
  });
  expect(tr.list()[0]).toMatchObject({ id: 7, reason: 'question' });
  tr.apply({ type: 'subagentToolDone', id: 7, parentToolId: 'p', toolId: 's1' });
  expect(tr.size).toBe(0);
});

test('waiting for input: set by waiting, cleared by active; never downgrades a permission', () => {
  const { tr } = tracker();
  tr.apply({ type: 'agentStatus', id: 1, status: 'waiting' });
  expect(tr.list()[0]).toMatchObject({ reason: 'waiting' });
  tr.apply({ type: 'agentStatus', id: 1, status: 'active' });
  expect(tr.size).toBe(0);
  tr.apply({ type: 'agentToolPermission', id: 2 });
  tr.apply({ type: 'agentStatus', id: 2, status: 'waiting' });
  expect(tr.list()[0]).toMatchObject({ id: 2, reason: 'permission' });
});

test('closing the agent or clearing its tools removes it; oldest first; unknown junk ignored', () => {
  const { tr, tick } = tracker();
  tr.apply({ type: 'agentToolPermission', id: 1 });
  tick(10);
  tr.apply({ type: 'agentStatus', id: 2, status: 'waiting' });
  expect(tr.list().map((e) => e.id)).toEqual([1, 2]);
  tr.apply({ type: 'agentClosed', id: 1 });
  tr.apply({ type: 'agentToolsClear', id: 2 });
  expect(tr.size).toBe(0);
  expect(tr.apply(null)).toBe(false);
  expect(tr.apply({ type: 'agentToolPermission', id: 'x' })).toBe(false);
});

test('sub-agent question is cleared when the sub-agent itself finishes', () => {
  const { tr } = tracker();
  tr.apply({
    type: 'subagentToolStart',
    id: 5,
    parentToolId: 'p1',
    toolId: 'q1',
    status: 'Waiting for your answer',
  });
  expect(tr.list()[0]).toMatchObject({ id: 5, reason: 'question' });
  tr.apply({ type: 'subagentClear', id: 5, parentToolId: 'p1' });
  expect(tr.size).toBe(0);
});

test('sub-agent clear only removes questions from that parentToolId, not from other parents', () => {
  const { tr } = tracker();
  tr.apply({
    type: 'subagentToolStart',
    id: 6,
    parentToolId: 'p1',
    toolId: 'q1',
    status: 'Waiting for your answer',
  });
  tr.apply({
    type: 'subagentToolStart',
    id: 6,
    parentToolId: 'p2',
    toolId: 'q2',
    status: 'Waiting for your answer',
  });
  expect(tr.size).toBe(1);
  tr.apply({ type: 'subagentClear', id: 6, parentToolId: 'p1' });
  expect(tr.size).toBe(1);
  expect(tr.list()[0]).toMatchObject({ id: 6, reason: 'question' });
  tr.apply({ type: 'subagentClear', id: 6, parentToolId: 'p2' });
  expect(tr.size).toBe(0);
});

test('waiting counts only for roots: a workflow node waiting on its children is not waiting on the user', () => {
  const { tr } = tracker();
  tr.apply({ type: 'agentCreated', id: 1 });
  tr.apply({ type: 'agentCreated', id: 2, parentAgentId: 1, nodeKind: 'workflow' });
  expect(tr.apply({ type: 'agentStatus', id: 2, status: 'waiting' })).toBe(false);
  expect(tr.size).toBe(0);
  // A workflow node with no parent on the wire is still not a root.
  tr.apply({ type: 'agentCreated', id: 3, nodeKind: 'workflow' });
  tr.apply({ type: 'agentStatus', id: 3, status: 'waiting' });
  expect(tr.size).toBe(0);
  // The root itself still counts.
  tr.apply({ type: 'agentStatus', id: 1, status: 'waiting' });
  expect(tr.list()).toEqual([{ id: 1, reason: 'waiting', since: 1000 }]);
});

test('waiting counts only for roots: an idle teammate or sub-agent waits on its lead, not on the user', () => {
  const { tr } = tracker();
  tr.apply({ type: 'agentCreated', id: 1 });
  tr.apply({
    type: 'agentCreated',
    id: 4,
    parentAgentId: 1,
    isTeammate: true,
    teammateName: 'ana',
  });
  tr.apply({ type: 'agentStatus', id: 4, status: 'waiting' });
  expect(tr.size).toBe(0);
  // Learned from the reconnect snapshot too.
  tr.apply({
    type: 'existingAgents',
    agents: [1, 4, 5],
    agentMeta: { 5: { parentAgentId: 1 } },
    folderNames: {},
    externalAgents: {},
  });
  tr.apply({ type: 'agentStatus', id: 5, status: 'waiting' });
  expect(tr.size).toBe(0);
  // A session teammate linked to its lead later (agentTeamInfo): a waiting
  // entry it already had is dropped, and new ones are ignored.
  tr.apply({ type: 'agentCreated', id: 6 });
  tr.apply({ type: 'agentStatus', id: 6, status: 'waiting' });
  expect(tr.size).toBe(1);
  expect(tr.apply({ type: 'agentTeamInfo', id: 6, teamName: 't', leadAgentId: 1 })).toBe(true);
  expect(tr.size).toBe(0);
  tr.apply({ type: 'agentStatus', id: 6, status: 'waiting' });
  expect(tr.size).toBe(0);
});

test('derived agents still count for permissions and questions (answered in their root)', () => {
  const { tr } = tracker();
  tr.apply({ type: 'agentCreated', id: 4, parentAgentId: 1 });
  tr.apply({ type: 'agentToolPermission', id: 4 });
  expect(tr.list()[0]).toMatchObject({ id: 4, reason: 'permission' });
  tr.apply({
    type: 'agentToolStart',
    id: 7,
    toolId: 'q',
    status: 'Waiting for your answer',
    toolName: 'AskUserQuestion',
  });
  tr.apply({ type: 'agentCreated', id: 7, parentAgentId: 1, nodeKind: 'agent' });
  expect(tr.list().map((e) => e.reason)).toEqual(['permission', 'question']);
});

test('a permission outranks a question: a later question never replaces it', () => {
  const { tr } = tracker();
  tr.apply({ type: 'agentToolPermission', id: 1 });
  expect(
    tr.apply({
      type: 'subagentToolStart',
      id: 1,
      parentToolId: 'p',
      toolId: 'q',
      status: 'Waiting for your answer',
    }),
  ).toBe(false);
  expect(tr.list()[0]).toMatchObject({ id: 1, reason: 'permission' });
  // Once the permission is answered, the still-open question is what remains.
  tr.apply({ type: 'agentToolPermissionClear', id: 1 });
  expect(tr.list()[0]).toMatchObject({ id: 1, reason: 'question' });
});

test('a question still replaces a plain waiting', () => {
  const { tr } = tracker();
  tr.apply({ type: 'agentStatus', id: 1, status: 'waiting' });
  tr.apply({
    type: 'agentToolStart',
    id: 1,
    toolId: 'q',
    status: 'Waiting for your answer',
    toolName: 'AskUserQuestion',
  });
  expect(tr.list()[0]).toMatchObject({ id: 1, reason: 'question' });
});

test('attentionTitle', () => {
  expect(attentionTitle(0)).toBe('Pixel Agents');
  expect(attentionTitle(2)).toBe('(2) Pixel Agents');
});

test('tabTitle: VS Code owns its own panel title, so the tab is never touched', () => {
  expect(tabTitle(3, { isBrowser: false, consoleCapable: false })).toBeNull();
  expect(tabTitle(3, { isBrowser: false, consoleCapable: true })).toBeNull();
});

test('tabTitle: an untokened browser viewer sees neither the bar nor the counter', () => {
  expect(tabTitle(3, { isBrowser: true, consoleCapable: false })).toBe('Pixel Agents');
  expect(tabTitle(0, { isBrowser: true, consoleCapable: false })).toBe('Pixel Agents');
});

test('tabTitle: a browser operator sees the counter', () => {
  expect(tabTitle(3, { isBrowser: true, consoleCapable: true })).toBe('(3) Pixel Agents');
  expect(tabTitle(0, { isBrowser: true, consoleCapable: true })).toBe('Pixel Agents');
});
