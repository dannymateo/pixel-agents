import { describe, expect, it } from 'vitest';

import { FEED_ENTRY_DETAIL_MAX_BYTES } from '../src/constants.js';
import { parseClaudeFeedEntries } from '../src/providers/hook/claude/claudeFeed.js';

const assistant = (content: unknown[]) => ({
  type: 'assistant',
  timestamp: '2026-09-23T10:00:00Z',
  message: { content },
});
const toolUse = (name: string, input: unknown, id = 't1') =>
  parseClaudeFeedEntries(assistant([{ type: 'tool_use', id, name, input }]))[0];
const toolResult = (block: Record<string, unknown>) =>
  parseClaudeFeedEntries({
    type: 'user',
    timestamp: '2026-09-23T10:00:01Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tr', ...block }] },
  })[0];

describe('parseClaudeFeedEntries', () => {
  it('emits assistant text', () => {
    expect(parseClaudeFeedEntries(assistant([{ type: 'text', text: 'Voy a revisar' }]))).toEqual([
      { ts: '2026-09-23T10:00:00Z', kind: 'text', summary: 'Voy a revisar' },
    ]);
  });

  it('emits an Edit as a tool entry with a diff', () => {
    const [e] = parseClaudeFeedEntries(
      assistant([
        {
          type: 'tool_use',
          id: 't1',
          name: 'Edit',
          input: {
            file_path: '/r/src/Login.java',
            old_string: 'return token;',
            new_string: 'return refresh(token);',
          },
        },
      ]),
    );
    expect(e).toMatchObject({
      kind: 'tool',
      toolId: 't1',
      toolName: 'Edit',
      summary: 'Edit Login.java',
    });
    expect(e.detail).toEqual({
      type: 'diff',
      lines: [
        { op: 'remove', text: 'return token;' },
        { op: 'add', text: 'return refresh(token);' },
      ],
    });
  });

  it('emits a Bash tool entry with its command and the result as output', () => {
    const [tool] = parseClaudeFeedEntries(
      assistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'mvn -q test' } }]),
    );
    expect(tool.summary).toBe('Bash: mvn -q test');
    const [res] = parseClaudeFeedEntries({
      type: 'user',
      timestamp: '',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't2',
            content: [{ type: 'text', text: '\u001b[32mTests run: 12\u001b[0m' }],
          },
        ],
      },
    });
    expect(res).toMatchObject({
      kind: 'toolResult',
      toolId: 't2',
      detail: { type: 'output', text: 'Tests run: 12' },
    });
  });

  it('marks failed tool results', () => {
    const [res] = parseClaudeFeedEntries({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'boom' }],
      },
    });
    expect(res.isError).toBe(true);
  });

  it('ignores records it does not understand', () => {
    expect(parseClaudeFeedEntries({ type: 'queue-operation' })).toEqual([]);
    expect(parseClaudeFeedEntries({ type: 'user', message: { content: 'plain prompt' } })).toEqual(
      [],
    );
  });

  describe('tool summaries', () => {
    it('summarizes Windows paths by file name', () => {
      expect(toolUse('Read', { file_path: 'C:\\repo\\src\\Main.ts' }).summary).toBe('Read Main.ts');
    });

    it('summarizes Grep, Glob, Agent, PowerShell, WebFetch and WebSearch', () => {
      expect(toolUse('Grep', { pattern: 'x' }).summary).toBe('Grep "x"');
      expect(toolUse('Glob', { pattern: '**/*.ts' }).summary).toBe('Glob **/*.ts');
      expect(toolUse('Agent', { description: 'Revisar login', subagent_type: 'qa' }).summary).toBe(
        'Agent: Revisar login',
      );
      expect(toolUse('Task', { subagent_type: 'qa' }).summary).toBe('Task: qa');
      expect(toolUse('PowerShell', { command: 'Get-ChildItem' }).summary).toBe(
        'PowerShell: Get-ChildItem',
      );
      expect(toolUse('WebFetch', { url: 'https://a.test/x' }).summary).toBe(
        'WebFetch https://a.test/x',
      );
      expect(toolUse('WebSearch', { query: 'vitest' }).summary).toBe('WebSearch "vitest"');
    });

    it('summarizes NotebookEdit by notebook name', () => {
      expect(toolUse('NotebookEdit', { notebook_path: '/r/a.ipynb' }).summary).toBe(
        'NotebookEdit a.ipynb',
      );
    });

    it('keeps only the first line of a multi-line command', () => {
      expect(toolUse('Bash', { command: 'cat <<EOF\nsecret\nEOF' }).summary).toBe(
        'Bash: cat <<EOF',
      );
    });

    it('clips very long summaries', () => {
      const summary = toolUse('Bash', { command: 'echo ' + 'a'.repeat(10_000) }).summary;
      expect(summary.length).toBeLessThanOrEqual(201);
      expect(summary.endsWith('…')).toBe(true);
    });

    it('falls back to the tool name for unknown tools and odd inputs', () => {
      expect(toolUse('mcp__x__y', { foo: 1 }).summary).toBe('mcp__x__y');
      expect(toolUse('Bash', 'not-an-object').summary).toBe('Bash: ');
      expect(toolUse('Bash', { command: { nested: true } }).summary).toBe('Bash: ');
      expect(toolUse('Read', { file_path: 42 }).summary).toBe('Read');
    });

    it('carries no detail for tools without a diff', () => {
      expect(toolUse('Bash', { command: 'ls' }).detail).toBeUndefined();
    });
  });

  describe('diff details', () => {
    it('renders Write as a pure addition', () => {
      expect(toolUse('Write', { file_path: '/r/a.txt', content: 'x\ny' }).detail).toEqual({
        type: 'diff',
        lines: [
          { op: 'add', text: 'x' },
          { op: 'add', text: 'y' },
        ],
      });
    });

    it('renders every MultiEdit edit and skips malformed ones', () => {
      const e = toolUse('MultiEdit', {
        file_path: '/r/a.ts',
        edits: [
          { old_string: 'a', new_string: 'b' },
          null,
          'junk',
          { old_string: 'c', new_string: 'd' },
        ],
      });
      expect(e.summary).toBe('MultiEdit a.ts');
      expect(e.detail?.lines).toEqual([
        { op: 'remove', text: 'a' },
        { op: 'add', text: 'b' },
        { op: 'remove', text: 'c' },
        { op: 'add', text: 'd' },
      ]);
    });

    it('caps a gigantic Write and flags it', () => {
      const content = Array.from({ length: 50_000 }, (_, i) => `const v${i} = ${i};`).join('\n');
      const detail = toolUse('Write', { file_path: '/r/big.ts', content }).detail;
      expect(detail?.truncated).toBe(true);
      const bytes = (detail?.lines ?? []).reduce((n, l) => n + Buffer.byteLength(l.text) + 1, 0);
      expect(bytes).toBeLessThanOrEqual(FEED_ENTRY_DETAIL_MAX_BYTES);
    });

    it('treats a non-string old_string as empty', () => {
      expect(toolUse('Edit', { file_path: '/r/a', old_string: 5, new_string: 'n' }).detail).toEqual(
        {
          type: 'diff',
          lines: [{ op: 'add', text: 'n' }],
        },
      );
    });
  });

  describe('tool results', () => {
    it('reads string content, strips ANSI and summarizes the first non-blank line', () => {
      const res = toolResult({ content: '\n  \n\u001b[1mBUILD SUCCESS\u001b[0m\nmore' });
      expect(res).toMatchObject({
        ts: '2026-09-23T10:00:01Z',
        kind: 'toolResult',
        toolId: 'tr',
        summary: 'BUILD SUCCESS',
        detail: { type: 'output', text: '\n  \nBUILD SUCCESS\nmore' },
      });
      expect(res.isError).toBeUndefined();
    });

    it('replaces image blocks with a placeholder instead of leaking base64', () => {
      const res = toolResult({
        content: [
          { type: 'text', text: 'Screenshot taken' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo' },
          },
        ],
      });
      expect(res.detail?.text).toBe('Screenshot taken\n[image]');
      expect(JSON.stringify(res)).not.toContain('iVBORw0KGgo');
    });

    it('lists tool_reference blocks by tool name', () => {
      const res = toolResult({
        content: [
          { type: 'tool_reference', tool_name: 'TaskStop' },
          { type: 'tool_reference', tool_name: 'Monitor' },
        ],
      });
      expect(res.detail?.text).toBe('[tool: TaskStop]\n[tool: Monitor]');
      expect(res.summary).toBe('[tool: TaskStop]');
    });

    it('tolerates missing, null and junk content', () => {
      expect(toolResult({}).detail).toEqual({ type: 'output', text: '' });
      expect(toolResult({ content: null }).summary).toBe('');
      expect(toolResult({ content: [null, 7, { type: 'text', text: 3 }] }).detail?.text).toBe('');
    });

    it('caps gigantic output on a byte boundary and clips the summary', () => {
      const res = toolResult({ content: 'é'.repeat(FEED_ENTRY_DETAIL_MAX_BYTES) });
      expect(res.detail?.truncated).toBe(true);
      expect(Buffer.byteLength(res.detail?.text ?? '')).toBeLessThanOrEqual(
        FEED_ENTRY_DETAIL_MAX_BYTES,
      );
      expect(res.detail?.text).not.toContain('\uFFFD');
      expect(res.summary.length).toBeLessThanOrEqual(201);
    });

    it('does not split a surrogate pair when clipping the summary', () => {
      const res = toolResult({ content: 'a' + '😀'.repeat(300) });
      expect(res.summary).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    });
  });

  describe('robustness against real transcript shapes', () => {
    it('ignores thinking, fallback and user text blocks', () => {
      expect(
        parseClaudeFeedEntries(
          assistant([
            { type: 'thinking', thinking: '', signature: 'abc' },
            { type: 'fallback', from: { model: 'm' } },
          ]),
        ),
      ).toEqual([]);
      expect(
        parseClaudeFeedEntries({
          type: 'user',
          message: { content: [{ type: 'text', text: 'hola' }] },
        }),
      ).toEqual([]);
    });

    it('skips blank assistant text but keeps order across mixed blocks', () => {
      const out = parseClaudeFeedEntries(
        assistant([
          { type: 'text', text: '   ' },
          { type: 'text', text: 'first' },
          { type: 'tool_use', id: 'a', name: 'Read', input: { file_path: '/x/y.md' } },
        ]),
      );
      expect(out.map((e) => e.kind)).toEqual(['text', 'tool']);
    });

    it('clips an enormous assistant text on a byte boundary', () => {
      const out = parseClaudeFeedEntries(
        assistant([{ type: 'text', text: '😀'.repeat(FEED_ENTRY_DETAIL_MAX_BYTES) }]),
      );
      expect(Buffer.byteLength(out[0].summary)).toBeLessThanOrEqual(
        FEED_ENTRY_DETAIL_MAX_BYTES + Buffer.byteLength('…'),
      );
      expect(out[0].summary).not.toContain('\uFFFD');
    });

    it('survives null blocks, missing message and non-object records', () => {
      expect(parseClaudeFeedEntries(assistant([null, 1, 'x']))).toEqual([]);
      expect(parseClaudeFeedEntries({ type: 'assistant' })).toEqual([]);
      expect(parseClaudeFeedEntries({ type: 'assistant', message: 'nope' })).toEqual([]);
    });

    it('does not treat a tool_result inside an assistant record as a result', () => {
      expect(
        parseClaudeFeedEntries(
          assistant([{ type: 'tool_result', tool_use_id: 'x', content: 'y' }]),
        ),
      ).toEqual([]);
    });

    it('passes HTML through as plain text for the UI to escape', () => {
      const [e] = parseClaudeFeedEntries(
        assistant([{ type: 'text', text: '<img src=x onerror=1>' }]),
      );
      expect(e.summary).toBe('<img src=x onerror=1>');
    });
  });

  describe('sanitizing every text field', () => {
    it('strips escapes from summaries, assistant text and diff lines', () => {
      expect(toolUse('Bash', { command: '\u001b]0;pwn\u0007echo \u001b[2Jhi' }).summary).toBe(
        'Bash: echo hi',
      );
      const [text] = parseClaudeFeedEntries(assistant([{ type: 'text', text: '\u001b[2J hi' }]));
      expect(text.summary).toBe(' hi');
      expect(
        toolUse('Write', { file_path: '/r/a', content: '\u001b[31mred\u0007' }).detail?.lines,
      ).toEqual([{ op: 'add', text: 'red' }]);
    });

    it('collapses progress redraws in tool output', () => {
      expect(toolResult({ content: '10%\r50%\r100%\nok' }).detail?.text).toBe('100%\nok');
    });

    it('drops an assistant text that is only escape codes', () => {
      expect(parseClaudeFeedEntries(assistant([{ type: 'text', text: '\u001b[0m' }]))).toEqual([]);
    });
  });

  describe('bounded output for hostile records', () => {
    const wireBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

    it('omits toolId when the id is missing or implausibly long', () => {
      expect(
        parseClaudeFeedEntries(assistant([{ type: 'tool_use', name: 'Read', input: {} }]))[0],
      ).not.toHaveProperty('toolId');
      expect(toolUse('Read', {}, 'x'.repeat(5000))).not.toHaveProperty('toolId');
      expect(toolResult({ tool_use_id: undefined })).not.toHaveProperty('toolId');
    });

    it('clips a giant tool name and drops a giant timestamp', () => {
      const [e] = parseClaudeFeedEntries({
        type: 'assistant',
        timestamp: 'x'.repeat(100_000),
        message: {
          content: [{ type: 'tool_use', id: 'a', name: 'N'.repeat(1_000_000), input: {} }],
        },
      });
      expect(e.ts).toBe('');
      expect(e.toolName?.length).toBeLessThanOrEqual(129);
      expect(wireBytes(e)).toBeLessThan(1000);
    });

    it('bounds a Write of millions of empty lines, fast and small on the wire', () => {
      const start = Date.now();
      const detail = toolUse('Write', {
        file_path: '/r/a',
        content: '\n'.repeat(20_000_000),
      }).detail;
      expect(Date.now() - start).toBeLessThan(1500);
      expect(detail?.truncated).toBe(true);
      expect(wireBytes(detail)).toBeLessThanOrEqual(FEED_ENTRY_DETAIL_MAX_BYTES + 100);
    });

    it('bounds a giant Edit and flags it even when the kept part fits', () => {
      const big = 'a'.repeat(10_000_000);
      const start = Date.now();
      const detail = toolUse('Edit', {
        file_path: '/r/a',
        old_string: big,
        new_string: big + 'b',
      }).detail;
      expect(Date.now() - start).toBeLessThan(1500);
      expect(detail?.truncated).toBe(true);
      expect(wireBytes(detail)).toBeLessThanOrEqual(FEED_ENTRY_DETAIL_MAX_BYTES + 100);
    });

    it('stops diffing a MultiEdit once past the budget', () => {
      const edits = Array.from({ length: 200_000 }, (_, i) => ({
        old_string: `old ${i}`,
        new_string: `new ${i}`,
      }));
      const start = Date.now();
      const detail = toolUse('MultiEdit', { file_path: '/r/a', edits }).detail;
      expect(Date.now() - start).toBeLessThan(1500);
      expect(detail?.truncated).toBe(true);
      expect(wireBytes(detail)).toBeLessThanOrEqual(FEED_ENTRY_DETAIL_MAX_BYTES + 100);
    });

    it('bounds giant tool output, string or blocks, and control-char blowup', () => {
      const start = Date.now();
      const asString = toolResult({ content: 'x'.repeat(50_000_000) });
      const asBlocks = toolResult({
        content: Array.from({ length: 10_000 }, () => ({ type: 'text', text: 'y'.repeat(10_000) })),
      });
      const controls = toolResult({ content: '\u0001'.repeat(1_000_000) });
      expect(Date.now() - start).toBeLessThan(1500);
      for (const r of [asString, asBlocks]) {
        expect(r.detail?.truncated).toBe(true);
        expect(wireBytes(r)).toBeLessThanOrEqual(FEED_ENTRY_DETAIL_MAX_BYTES + 1000);
      }
      expect(controls.detail?.text).toBe('');
      expect(controls.detail?.truncated).toBe(true);
    });

    it('keeps a clipped assistant text within the byte cap, ellipsis included', () => {
      const [e] = parseClaudeFeedEntries(assistant([{ type: 'text', text: 'w'.repeat(200_000) }]));
      expect(Buffer.byteLength(e.summary)).toBeLessThanOrEqual(FEED_ENTRY_DETAIL_MAX_BYTES);
      expect(e.summary.endsWith('…')).toBe(true);
    });
  });
});
