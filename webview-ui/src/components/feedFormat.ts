/**
 * Pure helpers behind the agent screen (AgentScreenModal): merging the feed,
 * pairing tools with their results, validating what arrives from the wire and
 * making it safe to DISPLAY. DOM-free and React-free, so it runs under the Node
 * test runner.
 *
 * The feed carries arbitrary code and command output. It is plain text end to
 * end: nothing here produces markup, and the modal renders every string as a
 * React text child. `displaySafe` covers what text rendering alone does not —
 * control characters and bidi overrides that would make a line read
 * differently from what it is ("Trojan Source").
 */
import type {
  FeedDetail,
  FeedDiffLine,
  FeedDiffOp,
  FeedEntry,
} from '../../../core/src/messages.js';
import {
  FEED_DIFF_MAX_LINES,
  FEED_ENTRY_MAX_CHARS,
  FEED_FIELD_MAX_CHARS,
  FEED_HEADER_FIELD_MAX_CHARS,
  FEED_IDENTIFIER_MAX_CHARS,
} from '../constants.js';
import type { AgentDirectory, DirectoryAgent } from '../office/scope/agentDirectory.js';

export type ToolRowState = 'running' | 'done' | 'error';

/** State of every tool id in `entries`, in one pass. A tool with no result is running. */
export function toolStates(entries: readonly FeedEntry[]): Map<string, ToolRowState> {
  const states = new Map<string, ToolRowState>();
  for (const e of entries) {
    if (e.toolId === undefined) continue;
    if (e.kind === 'tool') {
      if (!states.has(e.toolId)) states.set(e.toolId, 'running');
    } else if (e.kind === 'toolResult') {
      states.set(e.toolId, e.isError === true ? 'error' : 'done');
    }
  }
  return states;
}

/** ⟳ running (no result yet) / ✓ done / ✗ error, for the tool `toolId`. */
export function toolRowState(entries: FeedEntry[], toolId: string): ToolRowState {
  return toolStates(entries).get(toolId) ?? 'running';
}

/**
 * `prev` + `incoming`, deduplicated by `seq` (the incoming copy wins), ordered
 * by `seq`, trimmed to the newest `max`. Unchanged entries keep their object
 * identity, which is what lets memoized rows skip re-rendering on an append.
 */
export function mergeFeed(prev: FeedEntry[], incoming: FeedEntry[], max: number): FeedEntry[] {
  if (max <= 0) return [];
  // Fast path — the common append: strictly after everything we hold, in order.
  let inOrder = true;
  let last = prev.length > 0 ? prev[prev.length - 1].seq : -Infinity;
  for (const e of incoming) {
    if (!(e.seq > last)) {
      inOrder = false;
      break;
    }
    last = e.seq;
  }
  let merged: FeedEntry[];
  if (inOrder) {
    merged = prev.concat(incoming);
  } else {
    const bySeq = new Map<number, FeedEntry>();
    for (const e of prev) bySeq.set(e.seq, e);
    for (const e of incoming) bySeq.set(e.seq, e);
    merged = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }
  return merged.length > max ? merged.slice(merged.length - max) : merged;
}

// ── Wire validation ────────────────────────────────────────────

const KINDS = new Set<string>(['text', 'tool', 'toolResult']);
const OPS = new Set<string>(['context', 'add', 'remove']);

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Characters an entry may still hold (summary + detail text + every diff line). */
interface Budget {
  left: number;
  cut: boolean;
}

/** `text` within what the entry's budget has left; spends it. */
function take(text: string, budget: Budget): string {
  const max = Math.min(FEED_FIELD_MAX_CHARS, budget.left);
  if (text.length <= max) {
    budget.left -= text.length;
    return text;
  }
  budget.cut = true;
  const head = clipChars(text, Math.max(0, max));
  budget.left -= head.length;
  return head;
}

function validDetail(raw: unknown, budget: Budget): FeedDetail | undefined {
  if (!isObj(raw)) return undefined;
  const flagged = raw.truncated === true;
  if (raw.type === 'output') {
    if (typeof raw.text !== 'string') return undefined;
    const text = take(raw.text, budget);
    return { type: 'output', text, ...(flagged || budget.cut ? { truncated: true } : {}) };
  }
  if (raw.type === 'diff') {
    if (!Array.isArray(raw.lines)) return undefined;
    const lines: FeedDiffLine[] = [];
    for (const l of raw.lines) {
      if (lines.length >= FEED_DIFF_MAX_LINES || budget.left <= 0) {
        budget.cut = true;
        break;
      }
      if (!isObj(l) || typeof l.op !== 'string' || !OPS.has(l.op) || typeof l.text !== 'string') {
        continue;
      }
      lines.push({ op: l.op as FeedDiffOp, text: take(l.text, budget) });
    }
    return { type: 'diff', lines, ...(flagged || budget.cut ? { truncated: true } : {}) };
  }
  return undefined;
}

/** A short identifier field, or undefined when missing or implausibly long. */
function shortField(v: unknown): string | undefined {
  return typeof v === 'string' && v.length <= FEED_IDENTIFIER_MAX_CHARS ? v : undefined;
}

/**
 * The well-formed entries of a wire `entries` field, rebuilt field by field (an
 * allowlist — never a spread of wire JSON). A malformed entry is dropped; a
 * malformed optional field is dropped from an otherwise good entry. Each entry
 * holds at most FEED_ENTRY_MAX_CHARS characters in total, whatever the server
 * sent (it caps a detail at 64 KiB; this is the backstop against any server).
 */
export function validFeedEntries(raw: unknown): FeedEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: FeedEntry[] = [];
  for (const r of raw) {
    if (!isObj(r)) continue;
    if (typeof r.seq !== 'number' || !Number.isFinite(r.seq)) continue;
    if (typeof r.kind !== 'string' || !KINDS.has(r.kind)) continue;
    if (typeof r.summary !== 'string') continue;
    const budget: Budget = { left: FEED_ENTRY_MAX_CHARS, cut: false };
    const entry: FeedEntry = {
      seq: r.seq,
      ts: shortField(r.ts) ?? '',
      kind: r.kind as FeedEntry['kind'],
      summary: take(r.summary, budget),
    };
    // The detail reports only its own cut, not the summary's.
    budget.cut = false;
    const toolId = shortField(r.toolId);
    if (toolId !== undefined) entry.toolId = toolId;
    const toolName = shortField(r.toolName);
    if (toolName !== undefined) entry.toolName = toolName;
    if (r.isError === true) entry.isError = true;
    const detail = validDetail(r.detail, budget);
    if (detail) entry.detail = detail;
    out.push(entry);
  }
  return out;
}

// ── Rows ───────────────────────────────────────────────────────

export type FeedRow =
  | { kind: 'text'; key: number; entry: FeedEntry }
  | { kind: 'tool'; key: number; entry: FeedEntry; result?: FeedEntry; state: ToolRowState }
  /** A result whose tool is not in the window (trimmed, or never seen). */
  | { kind: 'result'; key: number; entry: FeedEntry };

/**
 * What the screen draws: text rows, tool rows with their result folded in
 * (state + output under the tool that produced it), and orphan results.
 */
export function buildFeedRows(entries: readonly FeedEntry[]): FeedRow[] {
  const toolIds = new Set<string>();
  const results = new Map<string, FeedEntry>();
  for (const e of entries) {
    if (e.toolId === undefined) continue;
    if (e.kind === 'tool') toolIds.add(e.toolId);
    else if (e.kind === 'toolResult') results.set(e.toolId, e);
  }
  const rows: FeedRow[] = [];
  for (const e of entries) {
    if (e.kind === 'text') {
      rows.push({ kind: 'text', key: e.seq, entry: e });
    } else if (e.kind === 'tool') {
      const result = e.toolId !== undefined ? results.get(e.toolId) : undefined;
      const state: ToolRowState = !result ? 'running' : result.isError ? 'error' : 'done';
      rows.push({ kind: 'tool', key: e.seq, entry: e, result, state });
    } else if (e.toolId === undefined || !toolIds.has(e.toolId)) {
      rows.push({ kind: 'result', key: e.seq, entry: e });
    }
  }
  return rows;
}

// ── Display ────────────────────────────────────────────────────

/** C0/C1 controls and DEL, except tab and newline. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/**
 * Characters that change how a line READS without being seen, made visible:
 * every format control (\p{Cf}: bidi embeddings/overrides/isolates and marks,
 * zero-width space/joiners, word joiner, BOM, soft hyphen, interlinear
 * annotation, Unicode tags, ...), plus invisible fillers that are not Cf
 * (combining grapheme joiner, Hangul fillers) and the line/paragraph
 * separators. The cost: an emoji ZWJ sequence shows its parts with markers
 * between them — acceptable for a screen of code and command output.
 */
const INVISIBLE_RE = /[\p{Cf}\u034f\u115f\u1160\u3164\uffa0\u2028\u2029]/gu;
/** Same marker the server uses for bidi controls (server/src/feedDiff.ts). */
const INVISIBLE_MARKER = '\ufffd';

/**
 * Text as it may be shown: CRLF → LF, other control characters dropped,
 * invisible/format characters replaced by a visible marker. The server already does this; the
 * client does it again because the modal must be safe against any server.
 */
export function displaySafe(text: string): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(CONTROL_RE, '')
    .replace(INVISIBLE_RE, INVISIBLE_MARKER);
}

/** First `max` UTF-16 units, never ending on half a surrogate pair. */
export function clipChars(text: string, max: number): string {
  let head = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head;
}

export interface Collapsed {
  text: string;
  /** Lines not shown (0 when only the character cap cut the text). */
  hiddenLines: number;
  /** True when anything was left out. */
  clipped: boolean;
}

/** The first `maxLines` lines of `text`, capped at `maxChars` characters. */
export function collapseText(text: string, maxLines: number, maxChars: number): Collapsed {
  // A trailing newline is not a hidden (empty) line.
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  let cut = body;
  let hiddenLines = 0;
  let idx = -1;
  for (let i = 0; i < maxLines; i++) {
    idx = body.indexOf('\n', idx + 1);
    if (idx < 0) break;
  }
  if (idx >= 0) {
    cut = body.slice(0, idx);
    let count = 1;
    for (let j = body.indexOf('\n', idx + 1); j >= 0; j = body.indexOf('\n', j + 1)) count++;
    hiddenLines = count;
  }
  let charCut = false;
  if (cut.length > maxChars) {
    cut = clipChars(cut, maxChars);
    charCut = true;
  }
  return { text: cut, hiddenLines, clipped: hiddenLines > 0 || charCut };
}

export function diffPrefix(op: FeedDiffOp): '+' | '-' | ' ' {
  return op === 'add' ? '+' : op === 'remove' ? '-' : ' ';
}

/** Rounded % of the context window in use; null when there is nothing to show. */
export function contextPercent(tokens: number, max: number): number | null {
  if (!Number.isFinite(tokens) || !Number.isFinite(max) || tokens <= 0 || max <= 0) return null;
  return Math.min(100, Math.round((tokens / max) * 100));
}

// ── Header ─────────────────────────────────────────────────────

export interface AgentHeader {
  /** False when the directory does not (or no longer) know the agent. */
  known: boolean;
  role: string | null;
  label: string;
  /** Parent's label, else its role, else `#id`; null for a top-level agent. */
  parent: string | null;
  presence: DirectoryAgent['presence'] | null;
  status: DirectoryAgent['status'];
  permission: boolean;
}

/** One-word state for the header, in the screen's language (Spanish). */
export function statusLabel(h: Pick<AgentHeader, 'presence' | 'status' | 'permission'>): string {
  if (h.permission) return 'Esperando permiso';
  if (h.presence === 'leaving') return 'Saliendo';
  if (h.presence === 'lounge') return 'En descanso';
  if (h.presence === 'available') return 'Disponible';
  if (h.status === 'active') return 'Trabajando';
  if (h.status === 'waiting') return 'Esperando';
  return 'Inactivo';
}

/** `HH:MM:SS` (local time) of an ISO timestamp; '' when it is not one. */
export function formatTime(ts: string): string {
  if (typeof ts !== 'string' || !ts) return '';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** A header field: display-safe, one line, whitespace collapsed, clipped. */
function headerField(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const one = displaySafe(v.slice(0, FEED_HEADER_FIELD_MAX_CHARS * 4))
    .replace(/\s+/g, ' ')
    .trim();
  if (!one) return null;
  return one.length > FEED_HEADER_FIELD_MAX_CHARS
    ? clipChars(one, FEED_HEADER_FIELD_MAX_CHARS - 1) + '…'
    : one;
}

function nameOf(agent: DirectoryAgent | undefined): string | null {
  return headerField(agent?.label) ?? headerField(agent?.agentName);
}

/** Everything the screen header shows, read from the directory at call time. */
export function describeAgent(directory: AgentDirectory, id: number): AgentHeader {
  const agent = directory.get(id);
  if (!agent) {
    return {
      known: false,
      role: null,
      label: `#${id}`,
      parent: null,
      presence: null,
      status: null,
      permission: false,
    };
  }
  let parent: string | null = null;
  if (agent.parentAgentId !== undefined && agent.parentAgentId !== id) {
    const p = directory.get(agent.parentAgentId);
    parent = nameOf(p) ?? headerField(p?.role) ?? `#${agent.parentAgentId}`;
  }
  return {
    known: true,
    role: headerField(agent.role),
    label: nameOf(agent) ?? `#${id}`,
    parent,
    presence: agent.presence ?? null,
    status: agent.status,
    permission: agent.permission,
  };
}
