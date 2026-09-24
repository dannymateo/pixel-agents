import type { FeedDetail, FeedDiffLine } from '../../core/src/messages.js';
import { FEED_ENTRY_DETAIL_MAX_BYTES } from './constants.js';

/**
 * Terminal escape sequences, in order:
 *  - CSI (7-bit `ESC [` or C1 `0x9B`);
 *  - control strings — OSC, DCS, SOS, PM, APC in 7-bit (`ESC ] P X ^ _`) or
 *    C1 form — up to BEL or ST (`ESC \` / `0x9C`);
 *  - any other ESC sequence (charset designators, keypad modes, ...).
 * Each class is disjoint from the one after it, and a control string's body
 * excludes every introducer, so a failed match stops at the next candidate
 * start: the whole replace stays linear on hostile input.
 */
const ANSI_RE =
  /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]|(?:\u001b[\]PX^_]|[\u0090\u0098\u009d-\u009f])[^\u0007\u001b\u0090\u0098\u009c-\u009f]*(?:\u0007|\u001b\\|\u009c)|\u001b[ -/]*[0-~]/g;
/** C0/C1 controls and DEL, except tab and newline. */
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/** Bidi embedding/override/isolate controls ("Trojan Source"), made visible. */
const BIDI_RE = /[‪-‮⁦-⁩]/g;
const BIDI_MARKER = '�';

/**
 * Wire cost of one diff line beyond its text: the JSON wrapper around it
 * (`{"op":"context","text":""},`). Counting it keeps a detail made of
 * thousands of empty lines as bounded on the wire as one made of text.
 */
const DIFF_LINE_OVERHEAD_BYTES = JSON.stringify({ op: 'context', text: '' }).length + 1;

/**
 * Raw input examined per field before sanitizing and capping. Sanitizing only
 * ever shrinks text, so twice the cap leaves room for escape codes while
 * keeping the work per record bounded no matter how large the record is.
 */
export const FEED_INPUT_SCAN_BYTES = FEED_ENTRY_DETAIL_MAX_BYTES * 2;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/**
 * Plain, display-safe text: no escape sequences, carriage-return progress
 * redraws collapsed to what the terminal would finally show, no other control
 * characters (tab and newline stay), bidi controls made visible. Still plain
 * text — the UI must render it as text, never as HTML.
 */
export function sanitizeFeedText(text: string): string {
  let out = stripAnsi(text).replace(/\r\n/g, '\n');
  if (out.includes('\r')) {
    out = out
      .split('\n')
      .map((line) => {
        const segments = line.split('\r');
        for (let i = segments.length - 1; i >= 0; i--) if (segments[i]) return segments[i];
        return '';
      })
      .join('\n');
  }
  return out.replace(CONTROL_RE, '').replace(BIDI_RE, BIDI_MARKER);
}

/**
 * Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`, cut on a
 * character boundary (never half a code point, never a lone surrogate).
 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  // Every UTF-16 unit encodes to at least one byte, so a `maxBytes`-unit
  // prefix already holds more than the budget; no need to encode the rest.
  let head = text.slice(0, maxBytes);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  const buf = Buffer.from(head, 'utf8');
  if (buf.length <= maxBytes) return head;
  let end = maxBytes;
  // buf[end] is the first byte left out: if it continues a character, that
  // character straddles the cut, so back off to its lead byte.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/** Lines of a snippet; one trailing newline ends the last line, it does not open a new one. */
function splitLines(text: string): string[] {
  return text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
}

/** Edit snippets are small; a prefix/suffix trim reads well and never explodes. */
export function snippetDiff(oldText: string, newText: string): FeedDiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const line = (op: FeedDiffLine['op']) => (text: string) => ({ op, text });
  return [
    ...a.slice(0, pre).map(line('context')),
    ...a.slice(pre, a.length - suf).map(line('remove')),
    ...b.slice(pre, b.length - suf).map(line('add')),
    ...a.slice(a.length - suf).map(line('context')),
  ];
}

/**
 * Bounds a detail to FEED_ENTRY_DETAIL_MAX_BYTES and flags the cut with
 * `truncated`. Output is measured in UTF-8 bytes; diff lines also pay their
 * JSON wrapper (DIFF_LINE_OVERHEAD_BYTES), and the line that crosses the
 * budget is kept as a clipped prefix so a single huge line (minified file)
 * still shows something. Once sanitized, the serialized detail stays within
 * roughly twice the cap even if every character needs a JSON escape (`"`, `\`).
 */
export function capDetail(detail: FeedDetail): FeedDetail {
  if (detail.type === 'output' && detail.text !== undefined) {
    const text = truncateUtf8(detail.text, FEED_ENTRY_DETAIL_MAX_BYTES);
    return text === detail.text ? detail : { ...detail, text, truncated: true };
  }
  if (detail.type === 'diff' && detail.lines) {
    let bytes = 0;
    const kept: FeedDiffLine[] = [];
    for (const l of detail.lines) {
      const size = Buffer.byteLength(l.text, 'utf8') + DIFF_LINE_OVERHEAD_BYTES;
      if (bytes + size > FEED_ENTRY_DETAIL_MAX_BYTES) {
        const clipped = truncateUtf8(
          l.text,
          FEED_ENTRY_DETAIL_MAX_BYTES - bytes - DIFF_LINE_OVERHEAD_BYTES,
        );
        if (clipped) kept.push({ op: l.op, text: clipped });
        return { ...detail, lines: kept, truncated: true };
      }
      bytes += size;
      kept.push(l);
    }
  }
  return detail;
}
