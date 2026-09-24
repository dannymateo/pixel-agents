import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { FeedEntry } from '../../core/src/messages.js';
import type { AgentHeader } from '../src/components/feedFormat.js';
import { FEED_COLLAPSED_LINES } from '../src/constants.js';
import type { AgentFeedState } from '../src/hooks/useAgentFeed.js';

interface ViewProps {
  header: AgentHeader;
  contextPct: number | null;
  feed: AgentFeedState;
  onClose: () => void;
}
// Loaded through a non-literal specifier: vitest compiles the TSX at runtime,
// while this test project's tsc (tsconfig.node.json: no JSX, no DOM lib) never
// has to type-check the component itself.
const MODAL_MODULE = '../src/components/AgentScreenModal.js';
const { AgentScreenView } = (await import(/* @vite-ignore */ MODAL_MODULE)) as {
  AgentScreenView: FunctionComponent<ViewProps>;
};

const header: AgentHeader = {
  known: true,
  role: 'qa',
  label: 'QA login',
  parent: 'Líder F1',
  presence: 'working',
  status: 'active',
  permission: false,
};

function render(
  entries: FeedEntry[],
  over: Partial<AgentFeedState> = {},
  h: AgentHeader = header,
  contextPct: number | null = 42,
): string {
  const feed: AgentFeedState = { entries, truncated: false, denied: null, loaded: true, ...over };
  return renderToStaticMarkup(
    createElement(AgentScreenView, { header: h, contextPct, feed, onClose: () => {} }),
  );
}

const XSS = '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:x">l</a>';

describe('AgentScreenView', () => {
  it('shows role, label, parent, context and state in the header', () => {
    const html = render([]);
    expect(html).toContain('>qa<');
    expect(html).toContain('>QA login<');
    expect(html).toContain('Padre: Líder F1');
    expect(html).toContain('Contexto: 42%');
    expect(html).toContain('Estado: Trabajando');
  });

  it('omits parent and context when there are none', () => {
    const html = render([], {}, { ...header, parent: null }, null);
    expect(html).not.toContain('Padre:');
    expect(html).not.toContain('Contexto:');
  });

  it('renders feed text, summaries, diffs and output as escaped text, never markup', () => {
    const html = render([
      { seq: 1, ts: '', kind: 'text', summary: XSS },
      {
        seq: 2,
        ts: '',
        kind: 'tool',
        toolId: 't',
        toolName: 'Edit',
        summary: XSS,
        detail: { type: 'diff', lines: [{ op: 'add', text: XSS }] },
      },
      {
        seq: 3,
        ts: '',
        kind: 'toolResult',
        toolId: 't',
        summary: XSS,
        detail: { type: 'output', text: XSS },
      },
    ]);
    expect(html).not.toMatch(/<img|<script|<a /);
    expect(html).toContain('&lt;img src=x onerror=');
    expect(html).not.toMatch(/href="/);
  });

  it('never lets bidi overrides reach the DOM', () => {
    const html = render([
      { seq: 1, ts: '', kind: 'text', summary: 'a\u202eb' },
      {
        seq: 2,
        ts: '',
        kind: 'tool',
        summary: 'c\u2066d',
        detail: { type: 'diff', lines: [{ op: 'remove', text: 'e\u202df' }] },
      },
    ]);
    expect(html).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
  });

  it('prefixes diff lines and marks the tool state', () => {
    const html = render([
      {
        seq: 1,
        ts: '',
        kind: 'tool',
        toolId: 'a',
        summary: 'Edit x.ts',
        detail: {
          type: 'diff',
          lines: [
            { op: 'remove', text: 'old' },
            { op: 'add', text: 'new' },
            { op: 'context', text: 'same' },
          ],
        },
      },
      { seq: 2, ts: '', kind: 'tool', toolId: 'b', summary: 'Bash: ls' },
      { seq: 3, ts: '', kind: 'tool', toolId: 'c', summary: 'Bash: false' },
      { seq: 4, ts: '', kind: 'toolResult', toolId: 'a', summary: '' },
      { seq: 5, ts: '', kind: 'toolResult', toolId: 'c', summary: 'boom', isError: true },
    ]);
    expect(html).toContain('-old');
    expect(html).toContain('+new');
    expect(html).toContain(' same');
    expect(html).toContain('✓');
    expect(html).toContain('⟳');
    expect(html).toContain('✗');
  });

  it('collapses long output and offers "ver más"', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n');
    const html = render([
      { seq: 1, ts: '', kind: 'toolResult', summary: 'x', detail: { type: 'output', text } },
    ]);
    expect(html).toContain(`line-${FEED_COLLAPSED_LINES - 1}`);
    expect(html).not.toContain(`line-${FEED_COLLAPSED_LINES}\n`);
    expect(html).not.toContain('line-29');
    expect(html).toContain(`ver más (${30 - FEED_COLLAPSED_LINES} líneas)`);
  });

  it('flags truncated details and a truncated snapshot', () => {
    const html = render(
      [
        {
          seq: 1,
          ts: '',
          kind: 'toolResult',
          summary: 'x',
          detail: { type: 'output', text: 'a', truncated: true },
        },
      ],
      { truncated: true },
    );
    expect(html).toContain('truncado');
    expect(html).toContain('Se muestran solo las actividades más recientes.');
  });

  it('explains the unprivileged denial and shows nothing of the feed', () => {
    const html = render([], { denied: 'unprivileged' });
    expect(html).toContain('Abre la oficina con el enlace con token');
  });

  it('says the agent is gone only when it left the office', () => {
    expect(render([], {}, { ...header, known: false })).toContain('Este agente ya no está.');
    const live = render([], { denied: 'unknownAgent' });
    expect(live).not.toContain('Este agente ya no está.');
    expect(live).toContain('aún no está disponible');
  });

  it('offers "ver más" for a single diff line longer than a collapsed block', () => {
    const html = render([
      {
        seq: 1,
        ts: '',
        kind: 'tool',
        summary: 'Write min.js',
        detail: { type: 'diff', lines: [{ op: 'add', text: 'A'.repeat(5000) + 'TAILMARK' }] },
      },
    ]);
    expect(html).not.toContain('TAILMARK');
    expect(html).toContain('ver más');
  });

  it('keeps showing held entries with a reconnecting notice', () => {
    const html = render([{ seq: 1, ts: '', kind: 'text', summary: 'hola' }], { loaded: false });
    expect(html).toContain('hola');
    expect(html).toContain('Reconectando');
  });

  it('shows loading and empty states', () => {
    expect(render([], { loaded: false })).toContain('Conectando con la pantalla');
    expect(render([])).toContain('Sin actividad todavía.');
  });
});
