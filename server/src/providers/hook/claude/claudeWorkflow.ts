import * as fs from 'fs';
import * as path from 'path';

import type { TeamProvider } from '../../../../../core/src/teamProvider.js';
import { WORKFLOW_LABEL_MAX_CHARS } from '../../../constants.js';
import { sanitizeFeedText } from '../../../feedDiff.js';
import { normalizeClaudeAgentKey } from './claudeTeamProvider.js';
import {
  CLAUDE_AGENT_KEY_PATTERN,
  SIDECAR_COLD_READS_PER_SCAN,
  SIDECAR_MAX_BYTES,
} from './constants.js';

/**
 * Claude Code's `Workflow` tool (spec §2.1b): a script that orchestrates
 * agents in the background. The launch is only visible through the tool's
 * result text; the run's agents write `agent-<key>.jsonl` + a `.meta.json`
 * sidecar (`agentType`, `spawnDepth`, optionally `parentAgentId`) under
 * `<projectDir>/<sessionId>/subagents/workflows/wf_<id>/`.
 *
 * Everything read here is untrusted: the result text quotes the script's own
 * description (model-authored) and the run directory's files are read from
 * a path taken from that text.
 */

type WorkflowLaunch = ReturnType<NonNullable<TeamProvider['extractWorkflowLaunch']>>;
type WorkflowAgent = ReturnType<NonNullable<TeamProvider['discoverWorkflowAgents']>>[number];

const WORKFLOW_TOOL_NAME = 'Workflow';
/** The result must OPEN with this: a quoted "Workflow launched" further down is not a launch. */
const LAUNCH_PREFIX_PATTERN = /^\s*Workflow launched\b/;
/** Line prefixes of the launch result. Lines are split on `\n` only: a regex
 *  `^` under the `m` flag also starts a line after U+2028/U+2029, which the
 *  model-authored Summary could carry. */
const TRANSCRIPT_DIR_PREFIX = 'Transcript dir:';
const SUMMARY_PREFIX = 'Summary:';
const SCRIPT_FILE_PREFIX = 'Script file:';
/** Suffix the CLI appends to a script file's name: `<meta.name>-wf_<runId>.js`. */
const SCRIPT_FILE_RUN_SUFFIX_PATTERN = /-wf_[A-Za-z0-9-]{1,64}$/;
/** Run directory basename, as the CLI names it (`wf_9b94fdcd-8af`). */
const RUN_DIR_BASENAME_PATTERN = /^wf_[A-Za-z0-9-]{1,64}$/;
const RUN_DIR_PARENT = 'workflows';
const RUN_DIR_GRANDPARENT = 'subagents';
/** Longest run directory accepted -- far beyond any real path, short enough to bound the checks. */
const RUN_DIR_MAX_CHARS = 4096;
/** Longest result accepted as a launch; the real result is well under 2 KB. A
 *  longer one is refused outright rather than scanned in part: a window would
 *  let an oversized Summary push the real `Transcript dir:` line out of sight
 *  and leave only an injected one to count. */
const LAUNCH_RESULT_MAX_CHARS = 16384;
/** Script text examined for `meta.name`; `export const meta` opens the script. */
const SCRIPT_META_SCAN_CHARS = 8192;
const SCRIPT_META_START_PATTERN = /\bmeta\s*=\s*\{/;
/** Value of `meta.name` right after the key: a one-line quoted literal of up to 120 characters. */
const SCRIPT_META_NAME_VALUE_PATTERN = /^\s*:\s*(['"])([^'"\\\n]{1,120})\1/;
/** Head of an agent transcript read for its task line (the first `user` record). */
const LABEL_SCAN_BYTES = 16384;
/** Agents taken from one run per scan. The scan is synchronous on the event
 *  loop: a directory stuffed with thousands of transcripts must not stall
 *  every hook and socket (real runs hold 6-14 agents). */
const RUN_MAX_AGENTS = 256;
/** Directory entries examined per scan (each agent has a transcript and a sidecar). */
const RUN_MAX_ENTRIES = RUN_MAX_AGENTS * 4;
/** Sidecar / label cache entries kept; the oldest are evicted first. Sized so
 *  several live runs at RUN_MAX_AGENTS never evict each other on every scan. */
const CACHE_MAX_ENTRIES = 4096;
/** Invisible or direction-changing characters the shared sanitizer lets
 *  through (ALM, zero-width, LRM/RLM, word joiner, BOM), dropped from labels;
 *  line/paragraph separators become spaces. */
const LABEL_INVISIBLE_RE = /[\u061c\u200b-\u200f\u2060\ufeff]/g;
const LABEL_LINE_SEPARATOR_RE = /[\t\n\u2028\u2029]+/g;
/** A UTF-16 surrogate without its pair (a cut or hostile `\ud800` escape). */
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

const TRANSCRIPT_PREFIX = 'agent-';
const TRANSCRIPT_SUFFIX = '.jsonl';

// ── Text helpers ──

/** Flatten a tool_result content value (string or content-block array) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { text?: unknown }).text === 'string'
        ? (item as { text: string }).text
        : '',
    )
    .join('\n');
}

/** Display-safe single line: sanitized, tabs as spaces, trimmed, capped to
 *  WORKFLOW_LABEL_MAX_CHARS code points (never half a surrogate pair).
 *  Undefined when nothing printable is left. */
function cleanLabel(raw: string): string | undefined {
  // Sanitizing only shrinks text: bounding the input first bounds the work.
  // Leading blanks go first, or a long indent would eat the whole budget.
  const bounded = raw.trimStart().slice(0, WORKFLOW_LABEL_MAX_CHARS * 8);
  const line = sanitizeFeedText(bounded)
    .replace(LONE_SURROGATE_RE, '\ufffd')
    .replace(LABEL_INVISIBLE_RE, '')
    .replace(LABEL_LINE_SEPARATOR_RE, ' ')
    .trim();
  if (!line) return undefined;
  const chars = Array.from(line);
  return chars.length <= WORKFLOW_LABEL_MAX_CHARS
    ? line
    : chars.slice(0, WORKFLOW_LABEL_MAX_CHARS).join('').trimEnd();
}

/** First non-empty line of `text`, cleaned. */
function firstLineLabel(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const label = cleanLabel(line);
    if (label) return label;
  }
  return undefined;
}

// ── Launch ──

/**
 * A run directory is accepted only when it has the exact shape the CLI writes:
 * an absolute local path ending `…/subagents/workflows/wf_<id>`, with no `.`
 * or `..` segment anywhere and no UNC / device-namespace prefix. The text it
 * comes from quotes model-authored content, so anything looser would let a
 * transcript point the scanner at an arbitrary directory. Returns the
 * normalized path, or undefined.
 */
export function validateWorkflowRunDir(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > RUN_DIR_MAX_CHARS) return undefined;
  // Controls (NUL included) never appear in a real path.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return undefined;
  // UNC shares (`\\host\share`) and device paths (`\\?\`, `\\.\`) reach other
  // machines or raw devices; a double leading slash is refused on every OS.
  if (/^[\\/]{2}/.test(raw)) return undefined;
  if (!path.isAbsolute(raw)) return undefined;
  // Windows: a drive-letter path only (`\Users\…` is relative to the current drive).
  if (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(raw)) return undefined;
  const trimmed = raw.replace(/[\\/]+$/, '');
  // Split on BOTH separators: on POSIX a backslash is a filename character, so
  // this only ever refuses more, never less.
  const segments = trimmed.split(/[\\/]+/);
  if (segments.some((s) => s === '.' || s === '..')) return undefined;
  // On Windows a colon past the drive letter names an alternate data stream.
  if (process.platform === 'win32' && trimmed.indexOf(':', 2) !== -1) return undefined;
  if (segments.length < 4) return undefined;
  const [grandparent, parent, base] = segments.slice(-3);
  if (!RUN_DIR_BASENAME_PATTERN.test(base)) return undefined;
  if (parent !== RUN_DIR_PARENT || grandparent !== RUN_DIR_GRANDPARENT) return undefined;
  return path.normalize(trimmed);
}

/**
 * Whether `runDir` is the workflow run directory of THAT session:
 * exactly `<projectDir>/<sessionId>/subagents/workflows/wf_<id>`. The launch
 * text alone only proves the path's shape; a transcript could name another
 * project's or session's run. Hosts gate discovery on this (spec §2.1b, T17):
 * the extractor cannot, it never learns the session. Compared whole, never by
 * prefix, and case-insensitively where the filesystem is (Windows, macOS).
 * Does not resolve symlinks or junctions in the ancestors.
 */
export function isWorkflowRunDirOfSession(
  runDir: string,
  projectDir: string,
  sessionId: string,
): boolean {
  const valid = validateWorkflowRunDir(runDir);
  if (!valid) return false;
  const expected = path.join(
    path.normalize(projectDir),
    sessionId,
    RUN_DIR_GRANDPARENT,
    RUN_DIR_PARENT,
    path.basename(valid),
  );
  const fold = (p: string): string =>
    process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
  return fold(expected) === fold(valid);
}

/** Clean `meta.name` from the text right after its key, or undefined. */
function metaNameValue(rest: string): string | undefined {
  const value = SCRIPT_META_NAME_VALUE_PATTERN.exec(rest);
  return value ? cleanLabel(value[2]) : undefined;
}

/**
 * `meta.name` of a Workflow script (`export const meta = { name: '…', … }`):
 * the `name` key at the TOP level of the meta object only. A light JS walk
 * (strings, template literals and comments skipped, bracket depth tracked)
 * keeps a `name:` inside `phases`, inside a string, or past the object's
 * closing brace from being taken for it. Bounded to SCRIPT_META_SCAN_CHARS.
 */
function scriptMetaName(script: unknown): string | undefined {
  if (typeof script !== 'string') return undefined;
  const head = script.slice(0, SCRIPT_META_SCAN_CHARS);
  const start = SCRIPT_META_START_PATTERN.exec(head);
  if (!start) return undefined;
  const n = head.length;
  let i = start.index + start[0].length; // just past the opening brace
  let depth = 1;
  let atKey = true; // right after `{` or a top-level `,`
  while (i < n) {
    const c = head[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '/' && (head[i + 1] === '/' || head[i + 1] === '*')) {
      const close = head[i + 1] === '/' ? '\n' : '*/';
      const end = head.indexOf(close, i + 2);
      i = end === -1 ? n : end + close.length;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && head[j] !== c) j += head[j] === '\\' ? 2 : 1;
      const literal = head.slice(i + 1, j);
      i = j + 1;
      if (depth === 1 && atKey && c !== '`' && literal === 'name')
        return metaNameValue(head.slice(i));
      atKey = false;
      continue;
    }
    if (depth === 1 && atKey && /[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(head[j])) j++;
      const ident = head.slice(i, j);
      i = j;
      if (ident === 'name') return metaNameValue(head.slice(i));
      atKey = false;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') {
      depth++;
    } else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) return undefined; // the meta object closed without a name
    } else if (c === ',' && depth === 1) {
      i++;
      atKey = true;
      continue;
    }
    atKey = false;
    i++;
  }
  return undefined;
}

/**
 * Workflow name from the result's `Script file:` line, for invocations that
 * pass `{scriptPath}` instead of an inline script. The CLI names the file
 * `<meta.name>-wf_<runId>.js`, so the name is its basename without extension
 * and without that run suffix. The value is TEXT only -- split on either
 * separator, never resolved, read or validated as a path -- so a hostile
 * value can at most choose a display name. Undefined unless exactly one such
 * line exists (a second one could only come from the quoted Summary).
 */
function scriptFileName(lines: readonly string[]): string | undefined {
  const fileLines = lines.filter((line) => line.startsWith(SCRIPT_FILE_PREFIX));
  if (fileLines.length !== 1) return undefined;
  const value = fileLines[0].slice(SCRIPT_FILE_PREFIX.length).trim();
  const base = value.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  // A leading dot is the whole stem (`.js`): nothing left to name the run.
  const stem = dot === -1 ? base : base.slice(0, dot);
  return cleanLabel(stem.replace(SCRIPT_FILE_RUN_SUFFIX_PATTERN, ''));
}

/**
 * Recognize a `Workflow` launch from its tool_result:
 *
 *     Workflow launched in background. Task ID: w4eubwvnv
 *     Summary: <meta.description>
 *     Transcript dir: <…>\subagents\workflows\wf_9b94fdcd-8af
 *     Script file: …
 *
 * `runDir` is the `Transcript dir:` value; the result is refused when that
 * line is missing, appears more than once (the Summary quotes model-authored
 * text, so a second line is an injection, and there is no telling which is
 * real), or names a directory of the wrong shape. `name` is, in order: the
 * inline script's `meta.name`, the `Script file:` basename (`{scriptPath}`
 * invocations carry no inline script), the Summary.
 */
export function extractClaudeWorkflowLaunch(
  toolName: string,
  toolInput: Record<string, unknown>,
  resultContent: unknown,
): WorkflowLaunch {
  if (toolName !== WORKFLOW_TOOL_NAME) return null;
  const text = toolResultText(resultContent);
  if (text.length > LAUNCH_RESULT_MAX_CHARS) return null;
  if (!LAUNCH_PREFIX_PATTERN.test(text)) return null;
  const lines = text.split('\n');
  const dirLines = lines.filter((line) => line.startsWith(TRANSCRIPT_DIR_PREFIX));
  if (dirLines.length !== 1) return null;
  const runDir = validateWorkflowRunDir(dirLines[0].slice(TRANSCRIPT_DIR_PREFIX.length).trim());
  if (!runDir) return null;
  const summary = lines.find((line) => line.startsWith(SUMMARY_PREFIX));
  const name =
    scriptMetaName(
      typeof toolInput === 'object' && toolInput !== null ? toolInput.script : undefined,
    ) ??
    scriptFileName(lines) ??
    (summary === undefined ? undefined : cleanLabel(summary.slice(SUMMARY_PREFIX.length)));
  return name ? { runDir, name } : { runDir };
}

// ── Agents ──

/** Sidecar fields a workflow agent needs. */
interface WorkflowSidecar {
  agentType: string;
  parentAgentKey?: string;
}

/** Sidecars never change once written: cached by mtime + size, like the
 *  team provider's cache (a sidecar caught mid-write parses as null, and the
 *  completed write grows it). Only outcomes of the CONTENT are cached; a
 *  failed stat or read is transient and retried next scan. */
const sidecarCache = new Map<
  string,
  { mtimeMs: number; size: number; meta: WorkflowSidecar | null }
>();

/** Task lines are fixed once the first `user` record lands. A DEFINITIVE
 *  result is cached per file identity (dev + ino) so a replaced file is
 *  re-read. An INDETERMINATE one (no `user` record yet) is cached too, but only
 *  for that exact size + mtime: re-reading an unchanged file every scan would
 *  spend the cold-read budget on nothing, and starve unread agents. */
const labelCache = new Map<
  string,
  {
    dev: number;
    ino: number;
    label: string | undefined;
    /** Set only for an indeterminate result: valid while the file is unchanged. */
    pending?: { size: number; mtimeMs: number };
  }
>();

/** Oversized runs already reported, so the 1 s scan does not flood the log. */
const truncatedRunsWarned = new Set<string>();

/** Keep `cache` within CACHE_MAX_ENTRIES by evicting its oldest entries (Map
 *  order is insertion order). Never a wholesale clear: that would make a
 *  cache just over its bound re-read everything on every scan. */
function boundCache<T>(cache: Map<string, T>): void {
  for (const key of cache.keys()) {
    if (cache.size <= CACHE_MAX_ENTRIES) return;
    cache.delete(key);
  }
}

/**
 * Read at most `maxBytes` from the start of `filePath`, which the caller has
 * lstat'ed as `stat`. The path may be swapped between that lstat and this
 * open: O_NONBLOCK keeps a FIFO from blocking the event loop, O_NOFOLLOW
 * refuses a symlink at open (both POSIX-only), and the opened file must be the
 * same regular file (dev + ino) everywhere, Windows included.
 * `'refused'` = not that regular file; `'failed'` = transient I/O error.
 */
function readHead(
  filePath: string,
  stat: fs.Stats,
  maxBytes: number,
): { text: string; full: boolean } | 'refused' | 'failed' {
  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = fs.openSync(filePath, flags);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ELOOP' ? 'refused' : 'failed';
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return 'refused';
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    return { text: buf.toString('utf-8', 0, bytesRead), full: bytesRead === maxBytes };
  } catch {
    return 'failed';
  } finally {
    fs.closeSync(fd);
  }
}

/** Forget cache entries of `dir` whose files its latest listing no longer holds. */
function evictStale<T>(cache: Map<string, T>, dir: string, live: ReadonlySet<string>): void {
  const prefix = dir + path.sep;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix) && !key.slice(prefix.length).includes(path.sep) && !live.has(key)) {
      cache.delete(key);
    }
  }
}

/** Parse a workflow agent's sidecar with the team provider's limits -- regular
 *  file only, at most SIDECAR_MAX_BYTES -- and stricter on the file itself: a
 *  symlink is refused (lstat), and the read is bounded even if the file grows
 *  or is swapped after the lstat. Content is untrusted: wrong types dropped; a
 *  present-but-invalid `parentAgentId` refuses the whole sidecar instead of
 *  hanging the agent off the run. */
type SidecarProbe =
  { settled: true; meta: WorkflowSidecar | null } | { settled: false; stat: fs.Stats };

/** Refuse a sidecar for good (until it changes): logged and cached as null. */
function refuseSidecar(metaPath: string, stat: fs.Stats, why: string): null {
  console.warn(`[Pixel Agents] Ignoring workflow sidecar ${metaPath}: ${why}`);
  sidecarCache.set(metaPath, { mtimeMs: stat.mtimeMs, size: stat.size, meta: null });
  return null;
}

/** Everything about a sidecar that needs no open: missing, cached, or refused
 *  on its lstat alone (settled), or else the lstat to open it with. */
function probeSidecar(metaPath: string): SidecarProbe {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(metaPath);
  } catch {
    sidecarCache.delete(metaPath);
    return { settled: true, meta: null };
  }
  const cached = sidecarCache.get(metaPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { settled: true, meta: cached.meta };
  }
  // A FIFO, device or symlink would block the event loop, never end, or read
  // somewhere else; a huge file would stall every hook while it parses.
  if (!stat.isFile())
    return { settled: true, meta: refuseSidecar(metaPath, stat, 'not a regular file') };
  if (stat.size > SIDECAR_MAX_BYTES) {
    return {
      settled: true,
      meta: refuseSidecar(metaPath, stat, `larger than ${SIDECAR_MAX_BYTES} bytes`),
    };
  }
  return { settled: false, stat };
}

/** Open and parse a sidecar that probeSidecar could not settle. */
function readSidecar(metaPath: string, stat: fs.Stats): WorkflowSidecar | null {
  const refuse = (why: string): null => refuseSidecar(metaPath, stat, why);
  // One byte past the limit tells a file that grew after the lstat.
  const head = readHead(metaPath, stat, SIDECAR_MAX_BYTES + 1);
  if (head === 'failed') {
    // Transient (EBUSY/EPERM under antivirus on Windows, EMFILE): never cached,
    // or a sidecar that never changes would stay hidden for good.
    sidecarCache.delete(metaPath);
    return null;
  }
  if (head === 'refused') return refuse('not a regular file');
  if (head.full) return refuse(`larger than ${SIDECAR_MAX_BYTES} bytes`);
  let meta: WorkflowSidecar | null = null;
  try {
    const data: unknown = JSON.parse(head.text);
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      const parentAgentKey = normalizeClaudeAgentKey(d.parentAgentId);
      const parentInvalid = d.parentAgentId !== undefined && parentAgentKey === undefined;
      const agentType = typeof d.agentType === 'string' ? cleanLabel(d.agentType) : undefined;
      if (agentType && !parentInvalid) {
        meta = parentAgentKey ? { agentType, parentAgentKey } : { agentType };
      }
    }
  } catch {
    meta = null;
  }
  sidecarCache.set(metaPath, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
  return meta;
}

/** Text of a `user` message's content: a string, or its first text block. */
function userContentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
    ) {
      return (block as { text: string }).text;
    }
  }
  return undefined;
}

/**
 * Tolerant scan of a record cut off mid-line. Real task prompts often make the
 * first record longer than the bytes we read (half the records of one real run
 * were 17-70 KB), so a complete JSON parse would leave those agents without a
 * label. Walks the top-level object and returns `type`, `message.role` and the
 * (possibly partial) `message.content` string -- whatever the prefix holds.
 * Linear in the prefix; never throws. Known limit: a cut-off record whose
 * content is a block ARRAY yields no content (real workflow prompts are
 * strings; a complete record of either form is handled by JSON.parse).
 */
function scanRecordPrefix(text: string): { type?: string; role?: string; content?: string } {
  const out: { type?: string; role?: string; content?: string } = {};
  let i = 0;
  const n = text.length;
  const ws = (): void => {
    while (i < n && /\s/.test(text[i])) i++;
  };
  /** Decode a JSON string starting at `"`; `done` is false when the prefix ends inside it. */
  const str = (): { value: string; done: boolean } => {
    i++; // opening quote
    let value = '';
    while (i < n) {
      const c = text[i];
      if (c === '"') {
        i++;
        return { value, done: true };
      }
      if (c !== '\\') {
        value += c;
        i++;
        continue;
      }
      if (i + 1 >= n) break;
      const e = text[i + 1];
      if (e === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        value += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      }
      const simple: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        b: '\b',
        f: '\f',
        '"': '"',
        '\\': '\\',
        '/': '/',
      };
      if (!(e in simple)) break;
      value += simple[e];
      i += 2;
    }
    i = n;
    return { value, done: false };
  };
  /** Skip any value; false when the prefix ends inside it. */
  const skip = (): boolean => {
    ws();
    if (i >= n) return false;
    if (text[i] === '"') return str().done;
    if (text[i] === '{' || text[i] === '[') {
      let depth = 0;
      while (i < n) {
        const c = text[i];
        if (c === '"') {
          if (!str().done) return false;
          continue;
        }
        if (c === '{' || c === '[') depth++;
        else if (c === '}' || c === ']') {
          depth--;
          if (depth === 0) {
            i++;
            return true;
          }
        }
        i++;
      }
      return false;
    }
    while (i < n && !/[,}\]\s]/.test(text[i])) i++;
    return i < n;
  };
  /** Walk an object's members, handing each key to `onKey` positioned at its value. */
  const object = (onKey: (key: string) => boolean): void => {
    ws();
    if (text[i] !== '{') return;
    i++;
    while (i < n) {
      ws();
      if (text[i] === '}') {
        i++;
        return;
      }
      if (text[i] !== '"') return;
      const key = str();
      if (!key.done) return;
      ws();
      if (text[i] !== ':') return;
      i++;
      ws();
      if (!onKey(key.value)) return;
      ws();
      if (text[i] === ',') i++;
    }
  };
  object((key) => {
    if (key === 'type' && text[i] === '"') {
      const v = str();
      if (v.done) out.type = v.value;
      return v.done;
    }
    if (key === 'message' && text[i] === '{') {
      object((inner) => {
        if (inner === 'role' && text[i] === '"') {
          const v = str();
          if (v.done) out.role = v.value;
          return v.done;
        }
        if (inner === 'content' && text[i] === '"') {
          const v = str();
          out.content = v.value;
          return v.done;
        }
        return skip();
      });
      return i < n;
    }
    return skip();
  });
  return out;
}

/** Cached task line of this very file (same dev + ino): a settled one, or a
 *  pending "none yet" while the file is unchanged. */
function cachedTaskLabel(
  jsonlPath: string,
  stat: fs.Stats,
): { hit: true; label: string | undefined } | { hit: false } {
  const cached = labelCache.get(jsonlPath);
  if (!cached || cached.dev !== stat.dev || cached.ino !== stat.ino) return { hit: false };
  if (
    cached.pending &&
    (cached.pending.size !== stat.size || cached.pending.mtimeMs !== stat.mtimeMs)
  ) {
    return { hit: false };
  }
  return { hit: true, label: cached.label };
}

/**
 * Task line of a workflow agent: the first non-empty line of its first `user`
 * record, reading at most LABEL_SCAN_BYTES of the transcript. Definitive
 * results (label or no label) are cached; indeterminate ones (no `user`
 * record yet, or a short file ending mid-record) are cached until the file
 * changes, then read again. A failed or refused open is not cached.
 */
function readTaskLabel(jsonlPath: string, stat: fs.Stats): string | undefined {
  const head = readHead(jsonlPath, stat, LABEL_SCAN_BYTES);
  if (typeof head === 'string') return undefined; // swapped or unreadable: retry next scan
  const raw = head.text;
  const bufferFull = head.full;

  const settle = (label: string | undefined): string | undefined => {
    labelCache.set(jsonlPath, { dev: stat.dev, ino: stat.ino, label });
    return label;
  };
  const notYet = (): undefined => {
    labelCache.set(jsonlPath, {
      dev: stat.dev,
      ino: stat.ino,
      label: undefined,
      pending: { size: stat.size, mtimeMs: stat.mtimeMs },
    });
    return undefined;
  };
  const lines = raw.split('\n');
  const last = lines.length - 1;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    if (!line.trim()) continue;
    const complete = idx < last;
    if (complete) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // corrupt line: not the record we are looking for
      }
      if (typeof record !== 'object' || record === null) continue;
      const r = record as { type?: unknown; message?: { content?: unknown } };
      if (r.type !== 'user') continue;
      const text = userContentText(r.message?.content);
      return settle(text === undefined ? undefined : firstLineLabel(text));
    }
    // Unterminated tail. Scan it tolerantly when the read budget cut it; a
    // short file ending mid-record is still being written -- retry later.
    if (!bufferFull) return notYet();
    const partial = scanRecordPrefix(line);
    if (partial.type !== undefined && partial.type !== 'user') return settle(undefined);
    if (partial.type === undefined && partial.role !== 'user') return settle(undefined);
    return settle(partial.content === undefined ? undefined : firstLineLabel(partial.content));
  }
  // Budget spent on non-user records: the task line is out of reach, for good.
  return bufferFull ? settle(undefined) : notYet();
}

/**
 * Agents of the workflow run at `runDir`: every `agent-<key>.jsonl` with a
 * valid key, a regular file (no symlink, FIFO, device), and a parseable
 * sidecar. `runDir` is re-validated (same rule as the launch) and must itself
 * be a real directory, not a symlink. Newest transcript first; a cold run
 * comes back over several calls (SIDECAR_COLD_READS_PER_SCAN opens each).
 */
export function discoverClaudeWorkflowAgents(runDir: string): WorkflowAgent[] {
  const dir = validateWorkflowRunDir(runDir);
  if (!dir) return [];
  const entries: string[] = [];
  let truncated = false;
  try {
    if (!fs.lstatSync(dir).isDirectory()) return [];
    // Iterated, not listed whole: a directory stuffed with entries must not
    // cost more than RUN_MAX_ENTRIES per scan.
    const handle = fs.opendirSync(dir);
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (entries.length >= RUN_MAX_ENTRIES) {
          truncated = true;
          break;
        }
        entries.push(entry.name);
      }
    } finally {
      handle.closeSync();
    }
  } catch {
    return [];
  }
  const result: WorkflowAgent[] = [];
  const liveMeta = new Set<string>();
  const liveTranscripts = new Set<string>();
  const found: Array<{
    key: string;
    jsonlPath: string;
    metaPath: string;
    stat: fs.Stats;
  }> = [];
  for (const entry of entries) {
    if (!entry.startsWith(TRANSCRIPT_PREFIX) || !entry.endsWith(TRANSCRIPT_SUFFIX)) continue;
    // Verbatim, never trimmed: `agent- x.jsonl` must not alias `agent-x.jsonl`.
    const key = entry.slice(TRANSCRIPT_PREFIX.length, -TRANSCRIPT_SUFFIX.length);
    if (!CLAUDE_AGENT_KEY_PATTERN.test(key)) continue;
    if (found.length >= RUN_MAX_AGENTS) {
      truncated = true;
      break;
    }
    const jsonlPath = path.join(dir, entry);
    const metaPath = path.join(dir, `${TRANSCRIPT_PREFIX}${key}.meta.json`);
    liveMeta.add(metaPath);
    liveTranscripts.add(jsonlPath);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(jsonlPath);
    } catch {
      continue;
    }
    if (stat.isFile()) found.push({ key, jsonlPath, metaPath, stat });
  }
  // Opening files is the expensive part and runs on the event loop: a cold
  // run (every sidecar and task line unread) costs seconds on Windows. At most
  // SIDECAR_COLD_READS_PER_SCAN opens per call -- sidecars and transcript heads
  // alike -- NEWEST transcript first (a working agent's transcript is fresh).
  // An agent whose reads do not fit is absent this call, uncached, and read by
  // the next one; one that is fully cached costs nothing.
  found.sort((x, y) => y.stat.mtimeMs - x.stat.mtimeMs);
  let coldReads = SIDECAR_COLD_READS_PER_SCAN;
  for (const { key, jsonlPath, metaPath, stat } of found) {
    const probe = probeSidecar(metaPath);
    if (probe.settled && !probe.meta) continue;
    const cachedLabel = cachedTaskLabel(jsonlPath, stat);
    const cost = (probe.settled ? 0 : 1) + (cachedLabel.hit ? 0 : 1);
    if (cost > coldReads) continue;
    let meta: WorkflowSidecar | null;
    if (probe.settled) {
      meta = probe.meta;
    } else {
      coldReads--;
      meta = readSidecar(metaPath, probe.stat);
    }
    if (!meta) continue;
    const agent: WorkflowAgent = { jsonlPath, agentKey: key, agentType: meta.agentType };
    if (meta.parentAgentKey) agent.parentAgentKey = meta.parentAgentKey;
    let label: string | undefined;
    if (cachedLabel.hit) {
      label = cachedLabel.label;
    } else {
      coldReads--;
      label = readTaskLabel(jsonlPath, stat);
    }
    if (label) agent.label = label;
    result.push(agent);
  }
  if (truncated) {
    // A partial listing proves nothing about what left the directory.
    if (!truncatedRunsWarned.has(dir) && truncatedRunsWarned.size < CACHE_MAX_ENTRIES) {
      truncatedRunsWarned.add(dir);
      console.warn(
        `[Pixel Agents] Workflow run ${dir} holds more entries than scanned; showing at most ${RUN_MAX_AGENTS} agents`,
      );
    }
  } else {
    evictStale(sidecarCache, dir, liveMeta);
    evictStale(labelCache, dir, liveTranscripts);
  }
  boundCache(sidecarCache);
  boundCache(labelCache);
  return result;
}
