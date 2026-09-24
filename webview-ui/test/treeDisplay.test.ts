import { describe, expect, it } from 'vitest';

import { treeDisplayName, WORKFLOW_NODE_PREFIX } from '../src/office/scope/treeDisplay.js';

describe('treeDisplayName', () => {
  it('prefers the teammate name, then the task label, then the spawn type', () => {
    expect(treeDisplayName({ teammateName: 'ana', label: 'Fase 1', role: 'lider-fase' })).toBe(
      'ana',
    );
    expect(treeDisplayName({ label: 'Fase 1', role: 'lider-fase' })).toBe('Fase 1');
    // Unprivileged connections get no label: the spawn type still names it.
    expect(treeDisplayName({ role: 'lider-fase' })).toBe('lider-fase');
    expect(treeDisplayName({})).toBeUndefined();
  });

  it('marks workflow nodes', () => {
    expect(treeDisplayName({ label: 'transferencias-fase-1', nodeKind: 'workflow' })).toBe(
      `${WORKFLOW_NODE_PREFIX}transferencias-fase-1`,
    );
  });
});
