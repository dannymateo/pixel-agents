import { describe, expect, it } from 'vitest';

import { FEED_ENTRY_DETAIL_MAX_BYTES } from '../src/constants.js';
import {
  capDetail,
  sanitizeFeedText,
  snippetDiff,
  stripAnsi,
  truncateUtf8,
} from '../src/feedDiff.js';

describe('snippetDiff', () => {
  it('keeps common prefix/suffix lines as context and marks the middle', () => {
    expect(snippetDiff('a\nb\nc', 'a\nX\nc')).toEqual([
      { op: 'context', text: 'a' },
      { op: 'remove', text: 'b' },
      { op: 'add', text: 'X' },
      { op: 'context', text: 'c' },
    ]);
  });

  it('treats an empty old text as a pure addition', () => {
    expect(snippetDiff('', 'x\ny')).toEqual([
      { op: 'add', text: 'x' },
      { op: 'add', text: 'y' },
    ]);
  });

  it('treats an empty new text as a pure removal', () => {
    expect(snippetDiff('x\ny', '')).toEqual([
      { op: 'remove', text: 'x' },
      { op: 'remove', text: 'y' },
    ]);
  });

  it('returns no lines when both sides are empty', () => {
    expect(snippetDiff('', '')).toEqual([]);
  });

  it('marks identical texts as pure context', () => {
    expect(snippetDiff('a\nb', 'a\nb')).toEqual([
      { op: 'context', text: 'a' },
      { op: 'context', text: 'b' },
    ]);
  });

  it('does not let prefix and suffix overlap on repeated lines', () => {
    // Old "a a", new "a a a": one inserted "a", never a negative middle.
    expect(snippetDiff('a\na', 'a\na\na')).toEqual([
      { op: 'context', text: 'a' },
      { op: 'context', text: 'a' },
      { op: 'add', text: 'a' },
    ]);
  });

  it('normalizes CRLF line endings', () => {
    expect(snippetDiff('a\r\nb', 'a\r\nc')).toEqual([
      { op: 'context', text: 'a' },
      { op: 'remove', text: 'b' },
      { op: 'add', text: 'c' },
    ]);
  });

  it('does not turn a trailing newline into a phantom empty line', () => {
    expect(snippetDiff('', 'x\ny\n')).toEqual([
      { op: 'add', text: 'x' },
      { op: 'add', text: 'y' },
    ]);
    expect(snippetDiff('a\nb\r\n', 'a\nc\r\n')).toEqual([
      { op: 'context', text: 'a' },
      { op: 'remove', text: 'b' },
      { op: 'add', text: 'c' },
    ]);
    expect(snippetDiff('', '\n')).toEqual([{ op: 'add', text: '' }]);
  });

  it('stays linear on large inputs', () => {
    const big = Array.from({ length: 200_000 }, (_, i) => `line ${i}`).join('\n');
    const start = Date.now();
    const lines = snippetDiff(big, big.replace('line 100000', 'changed'));
    expect(Date.now() - start).toBeLessThan(2000);
    expect(lines.filter((l) => l.op !== 'context')).toEqual([
      { op: 'remove', text: 'line 100000' },
      { op: 'add', text: 'changed' },
    ]);
  });
});

describe('truncateUtf8', () => {
  it('returns the text untouched when it fits', () => {
    expect(truncateUtf8('héllo', 100)).toBe('héllo');
  });

  it('never cuts a multi-byte character in half', () => {
    // "é" is 2 bytes, "😀" is 4 bytes.
    expect(truncateUtf8('aé', 2)).toBe('a');
    expect(truncateUtf8('a😀', 4)).toBe('a');
    expect(truncateUtf8('a😀', 5)).toBe('a😀');
  });

  it('keeps a genuine trailing replacement character', () => {
    expect(truncateUtf8('ok�zz', 5)).toBe('ok�');
  });

  it('handles a zero budget', () => {
    expect(truncateUtf8('abc', 0)).toBe('');
  });
});

describe('capDetail', () => {
  it('truncates oversize output and flags it', () => {
    const d = capDetail({ type: 'output', text: 'x'.repeat(FEED_ENTRY_DETAIL_MAX_BYTES + 10) });
    expect(d.truncated).toBe(true);
    expect(Buffer.byteLength(d.text ?? '')).toBeLessThanOrEqual(FEED_ENTRY_DETAIL_MAX_BYTES);
  });

  it('leaves output under the cap untouched (same object)', () => {
    const detail = { type: 'output' as const, text: 'fine' };
    expect(capDetail(detail)).toBe(detail);
  });

  it('truncates multi-byte output on a character boundary', () => {
    const d = capDetail({ type: 'output', text: '😀'.repeat(FEED_ENTRY_DETAIL_MAX_BYTES) });
    const text = d.text ?? '';
    expect(d.truncated).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(FEED_ENTRY_DETAIL_MAX_BYTES);
    expect(text).not.toContain('�');
    expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
  });

  it('drops diff lines past the byte cap and flags it', () => {
    const line = 'y'.repeat(1000);
    const lines = Array.from({ length: 200 }, () => ({ op: 'add' as const, text: line }));
    const d = capDetail({ type: 'diff', lines });
    const kept = d.lines ?? [];
    expect(d.truncated).toBe(true);
    expect(kept.length).toBeLessThan(200);
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(
      FEED_ENTRY_DETAIL_MAX_BYTES,
    );
  });

  it('keeps a clipped prefix of a single oversize diff line', () => {
    const d = capDetail({
      type: 'diff',
      lines: [{ op: 'add', text: 'z'.repeat(FEED_ENTRY_DETAIL_MAX_BYTES * 2) }],
    });
    expect(d.truncated).toBe(true);
    expect(d.lines).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(d.lines))).toBeLessThanOrEqual(
      FEED_ENTRY_DETAIL_MAX_BYTES,
    );
    expect((d.lines?.[0].text ?? '').length).toBeGreaterThan(0);
  });

  it('does not keep an empty clipped line when its first character does not fit', () => {
    // After the first line exactly 1 byte of text room is left; 'é' needs 2.
    const overhead = JSON.stringify({ op: 'context', text: '' }).length + 1;
    const first = 'a'.repeat(FEED_ENTRY_DETAIL_MAX_BYTES - 2 * overhead - 1);
    const d = capDetail({
      type: 'diff',
      lines: [
        { op: 'add', text: first },
        { op: 'add', text: 'éé' },
      ],
    });
    expect(d.truncated).toBe(true);
    expect(d.lines).toEqual([{ op: 'add', text: first }]);
  });

  it('bounds the serialized size of a diff made of empty lines', () => {
    const lines = Array.from({ length: 100_000 }, () => ({ op: 'add' as const, text: '' }));
    const d = capDetail({ type: 'diff', lines });
    expect(d.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(d))).toBeLessThanOrEqual(
      FEED_ENTRY_DETAIL_MAX_BYTES + 100,
    );
  });

  it('leaves a diff under the cap untouched', () => {
    const detail = { type: 'diff' as const, lines: [{ op: 'add' as const, text: 'a' }] };
    expect(capDetail(detail)).toBe(detail);
  });
});

describe('stripAnsi', () => {
  it('removes color codes', () => {
    expect(stripAnsi('\u001b[32mok\u001b[0m')).toBe('ok');
  });

  it('removes cursor/erase CSI sequences with private parameters', () => {
    expect(stripAnsi('\u001b[?25l\u001b[2Kdone\u001b[1A')).toBe('done');
  });

  it('removes OSC hyperlinks terminated by BEL or ST', () => {
    expect(stripAnsi('\u001b]8;;https://x.test\u0007link\u001b]8;;\u0007')).toBe('link');
    expect(stripAnsi('\u001b]0;title\u001b\\body')).toBe('body');
  });

  it('removes C1 CSI and two-character escapes', () => {
    expect(stripAnsi('\u009b31mred\u009b0m')).toBe('red');
    expect(stripAnsi('\u001b(Bplain\u001b=')).toBe('plain');
  });

  it('removes C1 OSC and DCS/APC control strings with their payload', () => {
    expect(stripAnsi('\u009d8;;http://x\u0007link\u009d8;;\u009c')).toBe('link');
    expect(stripAnsi('a\u001bPq#0;2;0;0;0\u001b\\b')).toBe('ab');
    expect(stripAnsi('a\u001b_payload\u001b\\b')).toBe('ab');
    expect(stripAnsi('a\u0090payload\u009cb')).toBe('ab');
  });

  it('leaves the payload of an unterminated OSC as text (pinned)', () => {
    expect(stripAnsi('\u001b]0;title never ends')).toBe('0;title never ends');
  });

  it('keeps ordinary text, tabs and newlines', () => {
    expect(stripAnsi('a\tb\nc [1] {x}')).toBe('a\tb\nc [1] {x}');
  });

  it('is linear on adversarial input', () => {
    const evil =
      ('\u001b[' + '1;'.repeat(50_000)).repeat(4) +
      '\u001b]' +
      'x'.repeat(200_000) +
      '\u0090'.repeat(100_000) +
      '\u009d'.repeat(100_000) +
      ('\u001bP' + 'y'.repeat(1000)).repeat(200);
    const start = Date.now();
    stripAnsi(evil);
    sanitizeFeedText(evil + 'z\r'.repeat(100_000));
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('sanitizeFeedText', () => {
  it('collapses carriage-return progress redraws to the last visible segment', () => {
    expect(sanitizeFeedText('10%\r50%\r100%\ndone')).toBe('100%\ndone');
    expect(sanitizeFeedText('100%\r\nnext')).toBe('100%\nnext');
    expect(sanitizeFeedText('keep\r')).toBe('keep');
  });

  it('drops control characters but keeps tabs and newlines', () => {
    expect(sanitizeFeedText('a\u0000b\u0007c\bd\u007f\te\nf\u0085g')).toBe('abcd\te\nfg');
  });

  it('makes bidi controls visible', () => {
    expect(sanitizeFeedText('evil‮txt.exe')).toBe('evil�txt.exe');
    expect(sanitizeFeedText('⁦x⁩')).toBe('�x�');
  });

  it('strips escape sequences', () => {
    expect(sanitizeFeedText('\u001b]0;pwn\u0007echo \u001b[2Jhi')).toBe('echo hi');
  });
});
