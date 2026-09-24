import { describe, expect, it } from 'vitest';

import type { FeedEntry } from '../../core/src/messages.js';
import {
  buildFeedRows,
  collapseText,
  contextPercent,
  describeAgent,
  diffPrefix,
  displaySafe,
  formatTime,
  mergeFeed,
  statusLabel,
  toolRowState,
  toolStates,
  validFeedEntries,
} from '../src/components/feedFormat.js';
import {
  FEED_ENTRY_MAX_CHARS,
  FEED_HEADER_FIELD_MAX_CHARS,
  FEED_IDENTIFIER_MAX_CHARS,
} from '../src/constants.js';
import { AgentDirectory } from '../src/office/scope/agentDirectory.js';

const text = (seq: number, summary = `t${seq}`): FeedEntry => ({
  seq,
  ts: '',
  kind: 'text',
  summary,
});
const tool = (seq: number, toolId: string): FeedEntry => ({
  seq,
  ts: '',
  kind: 'tool',
  toolId,
  toolName: 'Bash',
  summary: `Bash: ${toolId}`,
});
const result = (seq: number, toolId: string, isError = false): FeedEntry => ({
  seq,
  ts: '',
  kind: 'toolResult',
  toolId,
  summary: 'ok',
  ...(isError ? { isError: true } : {}),
  detail: { type: 'output', text: 'out' },
});

describe('toolRowState', () => {
  it('is running while the tool has no result', () => {
    expect(toolRowState([tool(1, 'a')], 'a')).toBe('running');
  });
  it('is done once a result for the same toolId arrives', () => {
    expect(toolRowState([tool(1, 'a'), result(2, 'a')], 'a')).toBe('done');
  });
  it('is error when the result is flagged isError', () => {
    expect(toolRowState([tool(1, 'a'), result(2, 'a', true)], 'a')).toBe('error');
  });
  it('ignores results of other tools', () => {
    expect(toolRowState([tool(1, 'a'), result(2, 'b')], 'a')).toBe('running');
  });
  it('toolStates maps every tool id in one pass', () => {
    const states = toolStates([tool(1, 'a'), tool(2, 'b'), result(3, 'b', true), tool(4, 'c')]);
    expect(states.get('a')).toBe('running');
    expect(states.get('b')).toBe('error');
    expect(states.get('c')).toBe('running');
  });
});

describe('mergeFeed', () => {
  it('appends in order', () => {
    const merged = mergeFeed([text(1), text(2)], [text(3)], 10);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3]);
  });
  it('deduplicates by seq (incoming wins) and sorts', () => {
    const merged = mergeFeed([text(1), text(3)], [text(2), text(3, 'new')], 10);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(merged[2].summary).toBe('new');
  });
  it('deduplicates repeated seq within the incoming batch', () => {
    expect(mergeFeed([], [text(1), text(1)], 10).map((e) => e.seq)).toEqual([1]);
  });
  it('trims to the newest max entries', () => {
    const merged = mergeFeed([text(1), text(2), text(3)], [text(4), text(5)], 3);
    expect(merged.map((e) => e.seq)).toEqual([3, 4, 5]);
  });
  it('keeps the entry objects (so memoized rows skip re-rendering)', () => {
    const a = text(1);
    const merged = mergeFeed([a], [text(2)], 10);
    expect(merged[0]).toBe(a);
  });
  it('returns an empty list for max <= 0', () => {
    expect(mergeFeed([text(1)], [text(2)], 0)).toEqual([]);
  });
  it('does not mutate its inputs', () => {
    const prev = [text(2)];
    const incoming = [text(1)];
    mergeFeed(prev, incoming, 10);
    expect(prev.map((e) => e.seq)).toEqual([2]);
    expect(incoming.map((e) => e.seq)).toEqual([1]);
  });
});

describe('validFeedEntries', () => {
  it('keeps well-formed entries and drops malformed ones', () => {
    const raw: unknown = [
      text(1),
      null,
      'x',
      { seq: 'nope', ts: '', kind: 'text', summary: 'a' },
      { seq: Number.NaN, ts: '', kind: 'text', summary: 'a' },
      { seq: 2, ts: '', kind: 'weird', summary: 'a' },
      { seq: 3, ts: '', kind: 'text', summary: 42 },
      tool(4, 'a'),
    ];
    expect(validFeedEntries(raw).map((e) => e.seq)).toEqual([1, 4]);
  });
  it('returns [] for a non-array', () => {
    expect(validFeedEntries({ seq: 1 })).toEqual([]);
    expect(validFeedEntries(undefined)).toEqual([]);
  });
  it('drops a malformed detail but keeps the entry', () => {
    const [e] = validFeedEntries([
      { seq: 1, ts: '', kind: 'toolResult', summary: 's', detail: { type: 'output', text: 5 } },
    ]);
    expect(e.detail).toBeUndefined();
  });
  it('keeps only well-formed diff lines', () => {
    const [e] = validFeedEntries([
      {
        seq: 1,
        ts: '',
        kind: 'tool',
        summary: 's',
        detail: {
          type: 'diff',
          lines: [{ op: 'add', text: 'a' }, { op: 'bogus', text: 'b' }, null, { op: 'remove' }],
        },
      },
    ]);
    expect(e.detail?.lines).toEqual([{ op: 'add', text: 'a' }]);
  });
  it('drops non-string toolId/toolName and ignores a non-boolean isError', () => {
    const [e] = validFeedEntries([
      { seq: 1, ts: 5, kind: 'tool', summary: 's', toolId: {}, toolName: 3, isError: 'yes' },
    ]);
    expect(e.toolId).toBeUndefined();
    expect(e.toolName).toBeUndefined();
    expect(e.isError).toBeUndefined();
    expect(e.ts).toBe('');
  });
  it('caps gigantic fields and diffs client-side and flags them truncated', () => {
    const [out, diff] = validFeedEntries([
      {
        seq: 1,
        ts: '',
        kind: 'toolResult',
        summary: 's',
        detail: { type: 'output', text: 'x'.repeat(500_000) },
      },
      {
        seq: 2,
        ts: '',
        kind: 'tool',
        summary: 's',
        detail: {
          type: 'diff',
          lines: Array.from({ length: 9000 }, () => ({ op: 'add', text: 'a' })),
        },
      },
    ]);
    expect(out.detail?.text?.length).toBeLessThan(500_000);
    expect(out.detail?.truncated).toBe(true);
    expect(diff.detail?.lines?.length).toBeLessThan(9000);
    expect(diff.detail?.truncated).toBe(true);
  });
  it('bounds the whole entry, not just each field', () => {
    const big = 'x'.repeat(120_000);
    const [e] = validFeedEntries([
      {
        seq: 1,
        ts: '',
        kind: 'tool',
        summary: big,
        detail: {
          type: 'diff',
          lines: Array.from({ length: 50 }, () => ({ op: 'add', text: big })),
        },
      },
    ]);
    const total = e.summary.length + (e.detail?.lines ?? []).reduce((n, l) => n + l.text.length, 0);
    expect(total).toBeLessThanOrEqual(FEED_ENTRY_MAX_CHARS);
    expect(e.detail?.truncated).toBe(true);
  });
  it('drops implausibly long ts / toolId / toolName', () => {
    const long = 'a'.repeat(FEED_IDENTIFIER_MAX_CHARS + 1);
    const [e] = validFeedEntries([
      { seq: 1, ts: long, kind: 'tool', summary: 's', toolId: long, toolName: long },
    ]);
    expect(e.ts).toBe('');
    expect(e.toolId).toBeUndefined();
    expect(e.toolName).toBeUndefined();
  });
  it('does not copy unknown keys (no prototype games)', () => {
    const raw = JSON.parse('[{"seq":1,"ts":"","kind":"text","summary":"a","__proto__":{"x":1}}]');
    const [e] = validFeedEntries(raw);
    expect((e as unknown as Record<string, unknown>).x).toBeUndefined();
    expect(Object.getPrototypeOf(e)).toBe(Object.prototype);
  });
});

describe('buildFeedRows', () => {
  it('folds a tool result into its tool row', () => {
    const r = result(2, 'a');
    const rows = buildFeedRows([text(0), tool(1, 'a'), r]);
    expect(rows.map((row) => row.kind)).toEqual(['text', 'tool']);
    const toolRow = rows[1];
    expect(toolRow.kind === 'tool' && toolRow.result).toBe(r);
    expect(toolRow.kind === 'tool' && toolRow.state).toBe('done');
  });
  it('keeps an orphan result (its tool fell out of the window) as its own row', () => {
    const rows = buildFeedRows([result(5, 'gone', true)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('result');
  });
  it('a tool without an id is running and never absorbs results', () => {
    const noId: FeedEntry = { seq: 1, ts: '', kind: 'tool', summary: 'x' };
    const rows = buildFeedRows([noId, result(2, 'a')]);
    expect(rows.map((row) => row.kind)).toEqual(['tool', 'result']);
    expect(rows[0].kind === 'tool' && rows[0].state).toBe('running');
  });
  it('keys rows by the entry seq', () => {
    expect(buildFeedRows([text(7), tool(9, 'a')]).map((r) => r.key)).toEqual([7, 9]);
  });
});

describe('displaySafe', () => {
  it('leaves plain text, tabs and newlines alone', () => {
    expect(displaySafe('a\tb\nc <b>x</b>')).toBe('a\tb\nc <b>x</b>');
  });
  it('turns CRLF into LF and drops other control characters', () => {
    expect(displaySafe('a\r\nb\u0007c\u001b[31md\u009be')).toBe('a\nbc[31mde');
  });
  it('makes bidi controls visible instead of letting them reorder the line', () => {
    const out = displaySafe('ok\u202eevil\u2066x\u2069\u200f');
    expect(out).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/);
    expect(out).toContain('\ufffd');
  });
  it('makes zero-width, tag, filler and separator characters visible', () => {
    const sneaky = [
      '@200b',
      '@200c',
      '@200d',
      '@2060',
      '@feff',
      '@00ad',
      '@2028',
      '@2029',
      '@034f',
      '@3164',
      '@180e',
      '@fff9',
    ];
    for (const c of sneaky) {
      const ch = String.fromCharCode(parseInt(c.slice(1), 16));
      expect(displaySafe(`a${ch}b`)).toBe('a\uFFFDb');
    }
    // Unicode tag characters (hidden text) are astral: U+E0041 'TAG LATIN CAPITAL A'.
    expect(displaySafe(`a${String.fromCodePoint(0xe0041)}b`)).toBe('a\uFFFDb');
  });
  it('coerces non-strings to empty', () => {
    expect(displaySafe(undefined as unknown as string)).toBe('');
  });
});

describe('collapseText', () => {
  it('does not collapse short text', () => {
    expect(collapseText('a\nb', 12, 1000)).toEqual({
      text: 'a\nb',
      hiddenLines: 0,
      clipped: false,
    });
  });
  it('collapses to the first N lines and counts the rest', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const c = collapseText(lines, 12, 10_000);
    expect(c.text.split('\n')).toHaveLength(12);
    expect(c.hiddenLines).toBe(8);
    expect(c.clipped).toBe(true);
  });
  it('also clips a single gigantic line by characters', () => {
    const c = collapseText('x'.repeat(50_000), 12, 100);
    expect(c.text.length).toBeLessThanOrEqual(100);
    expect(c.clipped).toBe(true);
  });
  it('a trailing newline after exactly N lines is not a hidden line', () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n') + '\n';
    expect(collapseText(lines, 12, 10_000)).toMatchObject({ hiddenLines: 0, clipped: false });
  });
  it('never splits a surrogate pair', () => {
    const c = collapseText('a' + '😀'.repeat(10), 12, 4);
    expect(/[\uD800-\uDBFF]$/.test(c.text)).toBe(false);
  });
});

describe('diffPrefix', () => {
  it('maps ops to unified-diff prefixes', () => {
    expect(diffPrefix('add')).toBe('+');
    expect(diffPrefix('remove')).toBe('-');
    expect(diffPrefix('context')).toBe(' ');
  });
});

describe('contextPercent', () => {
  it('rounds the used share', () => {
    expect(contextPercent(50_000, 200_000)).toBe(25);
  });
  it('is null without usable numbers', () => {
    expect(contextPercent(0, 200_000)).toBeNull();
    expect(contextPercent(10, 0)).toBeNull();
    expect(contextPercent(Number.NaN, 1)).toBeNull();
  });
  it('caps at 100', () => {
    expect(contextPercent(300, 200)).toBe(100);
  });
});

describe('statusLabel', () => {
  const h = (over: Partial<Parameters<typeof statusLabel>[0]>) => ({
    presence: null,
    status: null,
    permission: false,
    ...over,
  });
  it('permission beats everything, then presence, then status', () => {
    expect(statusLabel(h({ permission: true, presence: 'lounge' }))).toBe('Esperando permiso');
    expect(statusLabel(h({ presence: 'lounge', status: 'active' }))).toBe('En descanso');
    expect(statusLabel(h({ presence: 'available' }))).toBe('Disponible');
    expect(statusLabel(h({ presence: 'leaving' }))).toBe('Saliendo');
    expect(statusLabel(h({ presence: 'working', status: 'active' }))).toBe('Trabajando');
    expect(statusLabel(h({ status: 'waiting' }))).toBe('Esperando');
    expect(statusLabel(h({}))).toBe('Inactivo');
  });
});

describe('formatTime', () => {
  it('is empty for missing or invalid timestamps', () => {
    expect(formatTime('')).toBe('');
    expect(formatTime('not a date')).toBe('');
  });
  it('formats a valid timestamp as HH:MM:SS', () => {
    expect(formatTime('2026-09-24T10:11:12.000Z')).toMatch(/^\d\d:\d\d:\d\d$/);
  });
});

describe('describeAgent', () => {
  it('reads role, label, parent and presence from the directory', () => {
    const d = new AgentDirectory();
    d.upsert(1, { role: 'lider', label: 'Líder F1' });
    d.upsert(2, { parentAgentId: 1, role: 'qa', label: 'QA login', presence: 'available' });
    d.setStatus(2, 'active');
    expect(describeAgent(d, 2)).toEqual({
      known: true,
      role: 'qa',
      label: 'QA login',
      parent: 'Líder F1',
      presence: 'available',
      status: 'active',
      permission: false,
    });
  });
  it('falls back to the parent role, then its id', () => {
    const d = new AgentDirectory();
    d.upsert(1, { role: 'lider' });
    d.upsert(2, { parentAgentId: 1 });
    d.upsert(3, { parentAgentId: 99 });
    expect(describeAgent(d, 2).parent).toBe('lider');
    expect(describeAgent(d, 3).parent).toBe('#99');
  });
  it('uses agentName when there is no label, and marks unknown agents', () => {
    const d = new AgentDirectory();
    d.upsert(4, { agentName: 'dev-a' });
    expect(describeAgent(d, 4).label).toBe('dev-a');
    expect(describeAgent(d, 5)).toMatchObject({ known: false, label: '#5', parent: null });
  });
  it('clips header fields and flattens their whitespace', () => {
    const d = new AgentDirectory();
    d.upsert(7, { label: 'Lead\n\nEstado:   Trabajando' + 'x'.repeat(500), role: '  qa\t ' });
    const h = describeAgent(d, 7);
    expect(h.label.length).toBeLessThanOrEqual(FEED_HEADER_FIELD_MAX_CHARS);
    expect(h.label).not.toMatch(/\n/);
    expect(h.label.startsWith('Lead Estado: Trabajando')).toBe(true);
    expect(h.role).toBe('qa');
  });
  it('treats a whitespace-only label as missing', () => {
    const d = new AgentDirectory();
    d.upsert(8, { label: '   ', agentName: 'dev-b' });
    expect(describeAgent(d, 8).label).toBe('dev-b');
  });
  it('sanitizes wire-provided names for display', () => {
    const d = new AgentDirectory();
    d.upsert(6, { label: 'a\u202eb' });
    expect(describeAgent(d, 6).label).not.toContain('\u202e');
  });
});
