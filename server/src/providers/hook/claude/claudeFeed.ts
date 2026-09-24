import type { FeedDetail, FeedDiffLine, FeedEntry } from '../../../../../core/src/messages.js';
import { FEED_ENTRY_DETAIL_MAX_BYTES } from '../../../constants.js';
import {
  capDetail,
  FEED_INPUT_SCAN_BYTES,
  sanitizeFeedText,
  snippetDiff,
  truncateUtf8,
} from '../../../feedDiff.js';
import {
  IDENTIFIER_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  SUMMARY_SCAN_CHARS,
  TIMESTAMP_MAX_CHARS,
} from './constants.js';

/**
 * Claude transcript records → entries of an agent's screen feed. Pure: one
 * JSONL record in, zero or more entries out (the feed hub assigns `seq`).
 *
 * Every string field is sanitized (no escape sequences or control characters)
 * and bounded, however large the record is. It is still plain text: the UI
 * must render it as text, never as HTML. Records and blocks it does not
 * understand (thinking, attachments, user prompts, ...) yield nothing rather
 * than throwing.
 */

type Draft = Omit<FeedEntry, 'seq'>;
type Obj = Record<string, unknown>;

const ELLIPSIS = '…';

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function clip(text: string, max = SUMMARY_MAX_CHARS): string {
  if (text.length <= max) return text;
  let head = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head + ELLIPSIS;
}

/** First line of a raw field, sanitized: the building block of every summary. */
function oneLine(v: unknown): string {
  const raw = str(v).slice(0, SUMMARY_SCAN_CHARS);
  return sanitizeFeedText(raw.split(/\r?\n/, 1)[0] ?? '');
}

/** File name of a POSIX or Windows path, whatever platform we run on. */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? '';
}

function toolSummary(name: string, input: Obj): string {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return clip(`${name}: ${oneLine(input.command)}`);
    case 'Grep':
      return clip(`Grep "${oneLine(input.pattern)}"`);
    case 'Glob':
      return clip(`Glob ${oneLine(input.pattern)}`);
    case 'WebFetch':
      return clip(`WebFetch ${oneLine(input.url)}`);
    case 'WebSearch':
      return clip(`WebSearch "${oneLine(input.query)}"`);
    case 'Agent':
    case 'Task':
      return clip(`${name}: ${oneLine(input.description) || oneLine(input.subagent_type)}`);
    default: {
      const file = baseName(oneLine(input.file_path) || oneLine(input.notebook_path));
      return clip(file ? `${name} ${file}` : name);
    }
  }
}

/** A diff-side field, bounded before any splitting and sanitized. */
function diffSide(v: unknown, budget: { cut: boolean }): string {
  const raw = str(v);
  const head = truncateUtf8(raw, FEED_INPUT_SCAN_BYTES);
  if (head !== raw) budget.cut = true;
  return sanitizeFeedText(head);
}

function diffDetail(lines: FeedDiffLine[], cut: boolean): FeedDetail {
  const detail = capDetail({ type: 'diff', lines });
  return cut && !detail.truncated ? { ...detail, truncated: true } : detail;
}

function toolDetail(name: string, input: Obj): FeedDetail | undefined {
  const budget = { cut: false };
  switch (name) {
    case 'Edit':
      return diffDetail(
        snippetDiff(diffSide(input.old_string, budget), diffSide(input.new_string, budget)),
        budget.cut,
      );
    case 'MultiEdit': {
      if (!Array.isArray(input.edits)) return undefined;
      const lines: FeedDiffLine[] = [];
      let scanned = 0;
      for (const e of input.edits) {
        if (!isObj(e)) continue;
        if (scanned > FEED_INPUT_SCAN_BYTES) {
          // Past the budget capDetail would drop these anyway; don't diff them.
          budget.cut = true;
          break;
        }
        const oldText = diffSide(e.old_string, budget);
        const newText = diffSide(e.new_string, budget);
        scanned += oldText.length + newText.length;
        lines.push(...snippetDiff(oldText, newText));
      }
      return diffDetail(lines, budget.cut);
    }
    case 'Write':
      return diffDetail(snippetDiff('', diffSide(input.content, budget)), budget.cut);
    default:
      return undefined;
  }
}

/**
 * Text of a tool_result: a string, or an array of blocks. Images become a
 * placeholder (never their base64 payload); tool_reference blocks (ToolSearch)
 * are listed by name; anything else is dropped. Stops collecting once past
 * FEED_INPUT_SCAN_BYTES and reports the cut.
 */
function resultText(content: unknown): { text: string; cut: boolean } {
  if (typeof content === 'string') {
    const text = truncateUtf8(content, FEED_INPUT_SCAN_BYTES);
    return { text, cut: text !== content };
  }
  if (!Array.isArray(content)) return { text: '', cut: false };
  const parts: string[] = [];
  let size = 0;
  for (const b of content) {
    if (size > FEED_INPUT_SCAN_BYTES) return { text: parts.join('\n'), cut: true };
    if (!isObj(b)) continue;
    let part: string | undefined;
    if (b.type === 'text' && typeof b.text === 'string')
      part = b.text.slice(0, FEED_INPUT_SCAN_BYTES);
    else if (b.type === 'image') part = '[image]';
    else if (b.type === 'tool_reference' && typeof b.tool_name === 'string') {
      part = `[tool: ${b.tool_name.slice(0, IDENTIFIER_MAX_CHARS)}]`;
    }
    if (part === undefined) continue;
    parts.push(part);
    size += part.length + 1;
  }
  const text = parts.join('\n');
  const head = truncateUtf8(text, FEED_INPUT_SCAN_BYTES);
  return { text: head, cut: head !== text };
}

function textSummary(text: string): string {
  const clean = sanitizeFeedText(truncateUtf8(text, FEED_INPUT_SCAN_BYTES));
  const cut = truncateUtf8(clean, FEED_ENTRY_DETAIL_MAX_BYTES);
  if (cut === clean) return clean;
  return truncateUtf8(clean, FEED_ENTRY_DETAIL_MAX_BYTES - Buffer.byteLength(ELLIPSIS)) + ELLIPSIS;
}

/** A tool id, or nothing when it's missing or implausible (keeps entries from colliding on ''). */
function toolIdOf(v: unknown): { toolId?: string } {
  const id = sanitizeFeedText(str(v).slice(0, IDENTIFIER_MAX_CHARS + 1));
  return id && id.length <= IDENTIFIER_MAX_CHARS ? { toolId: id } : {};
}

export function parseClaudeFeedEntries(record: Record<string, unknown>): Draft[] {
  if (!isObj(record) || (record.type !== 'assistant' && record.type !== 'user')) return [];
  const message = record.message;
  if (!isObj(message) || !Array.isArray(message.content)) return [];
  const rawTs = str(record.timestamp);
  const ts = rawTs.length <= TIMESTAMP_MAX_CHARS ? sanitizeFeedText(rawTs) : '';
  const out: Draft[] = [];
  for (const block of message.content) {
    if (!isObj(block)) continue;
    if (record.type === 'assistant') {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        const summary = textSummary(block.text);
        if (summary.trim()) out.push({ ts, kind: 'text', summary });
      } else if (block.type === 'tool_use') {
        const name = clip(oneLine(block.name), IDENTIFIER_MAX_CHARS);
        const input = isObj(block.input) ? block.input : {};
        const detail = toolDetail(name, input);
        out.push({
          ts,
          kind: 'tool',
          ...toolIdOf(block.id),
          toolName: name,
          summary: toolSummary(name, input),
          ...(detail ? { detail } : {}),
        });
      }
    } else if (block.type === 'tool_result') {
      const { text, cut } = resultText(block.content);
      const capped = capDetail({ type: 'output', text: sanitizeFeedText(text) });
      const detail = cut && !capped.truncated ? { ...capped, truncated: true } : capped;
      const headline = (detail.text ?? '').split('\n').find((l) => l.trim()) ?? '';
      out.push({
        ts,
        kind: 'toolResult',
        ...toolIdOf(block.tool_use_id),
        summary: clip(headline.trim()),
        ...(block.is_error === true ? { isError: true } : {}),
        detail,
      });
    }
  }
  return out;
}
