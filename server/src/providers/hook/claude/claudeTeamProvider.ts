import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { TeamProvider } from '../../../../../core/src/teamProvider.js';
import { sanitizeFeedText } from '../../../feedDiff.js';
import {
  discoverClaudeWorkflowAgents,
  extractClaudeWorkflowLaunch,
  isWorkflowRunDirOfSession,
} from './claudeWorkflow.js';
import {
  CLAUDE_AGENT_KEY_PATTERN,
  CLAUDE_TEAM_NAME_MAX_CHARS,
  IDENTIFIER_MAX_CHARS,
  SIDECAR_COLD_READS_PER_SCAN,
  SIDECAR_MAX_BYTES,
  SUMMARY_MAX_CHARS,
} from './constants.js';

/**
 * Claude Code implementation of the TeamProvider interface.
 *
 * Encapsulates every Claude-specific path, field name, and tool identifier
 * for the Agent Teams feature. Adding support for a new CLI means creating a
 * sibling file; no changes to hookEventHandler.ts or fileWatcher.ts.
 */

// ── Internal helpers (not exposed on the public TeamProvider interface) ──

/** Claude stores teammate metadata in a sidecar `<file>.meta.json`. */
function sidecarPath(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/, '.meta.json');
}

/** Parsed sidecar metadata. `parentAgentKey` / `depth` place the spawn in the
 *  spawn tree (docs/adr/0002): the CLI records `spawnDepth` on every sidecar and
 *  `parentAgentId` (the `<key>` of the spawning agent) from depth 2 on. */
interface SidecarMeta {
  agentType: string;
  toolUseId?: string;
  description?: string;
  name?: string;
  parentAgentKey?: string;
  depth?: number;
}

/** Sidecars are written once and never change, and a long session accumulates
 *  hundreds of them (342 in one real session) -- re-parsing all of them on every
 *  1 s scan is pure waste. Keyed by sidecar path, invalidated when mtime OR size
 *  changes (a sidecar caught mid-write parses as null; the completed write grows
 *  it even if the filesystem's mtime granularity hides the second write). */
const sidecarCache = new Map<string, { mtimeMs: number; size: number; meta: SidecarMeta | null }>();

/** Forget cached sidecars of `dir` that its latest listing no longer holds, so
 *  the cache tracks what is on disk instead of every sidecar ever seen. */
function evictStaleSidecars(dir: string, liveMetaPaths: ReadonlySet<string>): void {
  const prefix = dir + path.sep;
  for (const metaPath of sidecarCache.keys()) {
    if (
      metaPath.startsWith(prefix) &&
      !metaPath.slice(prefix.length).includes(path.sep) &&
      !liveMetaPaths.has(metaPath)
    ) {
      sidecarCache.delete(metaPath);
    }
  }
}

/** Normalize an untrusted spawn key: trimmed, then accepted only when it matches
 *  CLAUDE_AGENT_KEY_PATTERN. Returns undefined for anything else (non-strings
 *  included). Shared with `normalizeHookEvent` so both ends of the
 *  hook `agent_id` ↔ sidecar key join apply the same rule. */
export function normalizeClaudeAgentKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim();
  return CLAUDE_AGENT_KEY_PATTERN.test(key) ? key : undefined;
}

/** Characters a team name may never hold: path separators (both, on every OS),
 *  the rest of Windows' invalid filename set (`:` also opens drive-relative
 *  paths and alternate data streams), C0/C1 controls (NUL truncates, newlines
 *  forge log lines), invisible format characters (bidi overrides, zero-width
 *  spaces) and line/paragraph separators. The zero-width JOINER stays: it
 *  builds composed emoji (as in sidecarText). Windows' rules apply on every OS
 *  on purpose: the same name is read on every surface, and a name that is not
 *  a valid Windows directory name is read as "no team" everywhere. */
const TEAM_NAME_FORBIDDEN = /[/\\:*?"<>|\p{Cc}\p{Zl}\p{Zp}]|(?!‍)\p{Cf}/u;
/** Unpaired UTF-16 surrogates: not text, and not a filename on any volume. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Windows device names, reserved in every directory and with any extension. */
const WINDOWS_RESERVED_NAME =
  /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;

/**
 * True when an untrusted team name (from a transcript tag, a spawn tool_result,
 * or persisted state) is safe to use as ONE directory name under
 * `~/.claude/teams/`. Everything else is treated as "no team" by the provider.
 *
 * Refused: non-strings, empty, over CLAUDE_TEAM_NAME_MAX_CHARS, `.`/`..` and
 * any dots-only name, leading/trailing whitespace or a trailing dot (Windows
 * strips those, so `.. ` and `team.` would alias `..` and `team`), the
 * characters in TEAM_NAME_FORBIDDEN, lone surrogates, and Windows device
 * names. Percent-encoding is never decoded anywhere, so `%2e%2e` is a literal
 * (harmless) directory name.
 */
export function isSafeTeamName(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > CLAUDE_TEAM_NAME_MAX_CHARS) return false;
  if (/^\.+$/.test(value)) return false;
  if (value !== value.trim() || value.endsWith('.')) return false;
  if (TEAM_NAME_FORBIDDEN.test(value) || LONE_SURROGATE.test(value)) return false;
  return !WINDOWS_RESERVED_NAME.test(value);
}

/** `~/.claude/teams/<teamName>/config.json`, or null when the name is unsafe or
 *  the resolved path would not be exactly one directory below teams/ (defense
 *  in depth: isSafeTeamName already rules that out). */
function teamConfigPath(teamName: string): string | null {
  if (!isSafeTeamName(teamName)) return null;
  const teamsRoot = path.resolve(os.homedir(), '.claude', 'teams');
  const teamDir = path.resolve(teamsRoot, teamName);
  if (path.dirname(teamDir) !== teamsRoot || path.basename(teamDir) !== teamName) return null;
  return path.join(teamDir, 'config.json');
}

/** Raw characters of a sidecar text field ever looked at: anything past the cap
 *  is dropped anyway, and the file itself is already size-capped. */
const SIDECAR_TEXT_SCAN_CHARS = 4096;

/** A sidecar text field made safe to display and log: control/ANSI/bidi
 *  sequences neutralized (sanitizeFeedText), line breaks folded to spaces,
 *  trimmed, and clipped to `max` UTF-16 units without splitting a surrogate
 *  pair. Non-strings and blank results read as absent. */
function sidecarText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = sanitizeFeedText(value.slice(0, SIDECAR_TEXT_SCAN_CHARS))
    // Invisible format characters (zero-width, weak bidi marks, BOM) would let
    // two labels look identical; lone surrogates are not text at all. The
    // zero-width JOINER stays: it builds composed emoji (👨‍💻) in names.
    .replace(/(?!\u200D)\p{Cf}/gu, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    // One line: every line/paragraph break and tab folds to a single space.
    .replace(/\s*[\n\t\u2028\u2029]\s*/g, ' ')
    .trim();
  if (!text) return undefined;
  if (text.length <= max) return text;
  let head = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return head;
}

/** Result of looking a sidecar up: settled (from cache, or refused/missing
 *  without opening it), or in need of a read — the costly part. */
type SidecarProbe =
  | { settled: true; meta: SidecarMeta | null }
  | { settled: false; metaPath: string; stat: fs.Stats };

/** Stat a sidecar and answer from the cache when it is unchanged. Opening a
 *  file is what costs (a freshly written one can take milliseconds on Windows
 *  while antivirus scans it), so this never opens anything. */
function probeSidecar(jsonlPath: string): SidecarProbe {
  const metaPath = sidecarPath(jsonlPath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(metaPath);
  } catch {
    sidecarCache.delete(metaPath);
    return { settled: true, meta: null };
  }
  const cached = sidecarCache.get(metaPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { settled: true, meta: cached.meta };
  }
  return { settled: false, metaPath, stat };
}

/** Parse a sidecar's metadata: `agentType` (required), plus `toolUseId`,
 *  `description`, and `name` when present (background agents record the first
 *  three; a NAMED teamless spawn additionally records `name`), and the spawn-tree
 *  fields `parentAgentId` / `spawnDepth`. Sidecar content is untrusted: a field
 *  of the wrong type is dropped, never coerced. Called for a probe that needs a read. */
function readSidecarMeta(metaPath: string, stat: fs.Stats): SidecarMeta | null {
  let meta: SidecarMeta | null = null;
  // The scan is synchronous on the server's event loop: a FIFO or device (e.g. a
  // symlink to /dev/zero) would block or never end, and a huge file would stall
  // every hook and socket while it parses. Refused -- and cached as refused, so
  // the next scan does not retry it -- without being opened.
  if (!stat.isFile() || stat.size > SIDECAR_MAX_BYTES) {
    console.warn(
      `[Pixel Agents] Ignoring sidecar ${metaPath}: ${stat.isFile() ? `larger than ${SIDECAR_MAX_BYTES} bytes` : 'not a regular file'}`,
    );
    sidecarCache.set(metaPath, { mtimeMs: stat.mtimeMs, size: stat.size, meta: null });
    return null;
  }
  // A failed READ is transient (EBUSY/EPERM while antivirus or the indexer holds
  // the file on Windows, EMFILE under load) and must not be cached: sidecars never
  // change after being written, so a cached null would hide the spawn forever.
  // Only deterministic outcomes of the CONTENT (parsed, invalid JSON, wrong
  // shape) are cached below.
  let text: string;
  try {
    text = fs.readFileSync(metaPath, 'utf-8');
  } catch {
    sidecarCache.delete(metaPath);
    return null;
  }
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const d = data as Record<string, unknown>;
      // Only an ABSENT parentAgentId means "spawned by the session root". A
      // present-but-invalid one must not be read as absent -- that would hang
      // the spawn off the root -- so the whole sidecar is refused instead.
      const parentAgentKey = normalizeClaudeAgentKey(d.parentAgentId);
      const parentInvalid = d.parentAgentId !== undefined && parentAgentKey === undefined;
      // agentType is required: one that sanitizes to nothing is as absent as a
      // non-string one, so the sidecar is refused.
      const agentType = sidecarText(d.agentType, IDENTIFIER_MAX_CHARS);
      if (agentType !== undefined && !parentInvalid) {
        const depth = d.spawnDepth;
        meta = {
          agentType,
          toolUseId: typeof d.toolUseId === 'string' ? d.toolUseId : undefined,
          description: sidecarText(d.description, SUMMARY_MAX_CHARS),
          name: sidecarText(d.name, IDENTIFIER_MAX_CHARS),
          parentAgentKey,
          depth:
            typeof depth === 'number' && Number.isSafeInteger(depth) && depth >= 1
              ? depth
              : undefined,
        };
      }
    }
  } catch {
    meta = null;
  }
  sidecarCache.set(metaPath, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
  return meta;
}

/** Spawn key of a sidecar-backed transcript: `<key>` of `agent-<key>.jsonl`
 *  (equal to the hook `agent_id` of events fired inside that agent). Taken
 *  verbatim, never trimmed: a file named `agent- x.jsonl` gets NO key rather
 *  than aliasing the file `agent-x.jsonl` (a hook's `agent_id` IS trimmed, but
 *  the result must still be a valid key, so it can only name a valid file). */
const SPAWN_TRANSCRIPT_PREFIX = 'agent-';
const TRANSCRIPT_SUFFIX = '.jsonl';
function spawnKeyFromFileName(fileName: string): string | undefined {
  if (!fileName.startsWith(SPAWN_TRANSCRIPT_PREFIX) || !fileName.endsWith(TRANSCRIPT_SUFFIX)) {
    return undefined;
  }
  const key = fileName.slice(SPAWN_TRANSCRIPT_PREFIX.length, -TRANSCRIPT_SUFFIX.length);
  return CLAUDE_AGENT_KEY_PATTERN.test(key) ? key : undefined;
}

/** Claude stores teammate JSONL files at `<projectDir>/<leadSessionId>/subagents/`. */
function teammateDir(projectDir: string, leadSessionId: string): string {
  return path.join(projectDir, leadSessionId, 'subagents');
}

/** Spawn tool_result line identifying the spawned agent: `agent_id: <name>@<team>`.
 *  Newer Claude harnesses run every Agent spawn in the background and this result
 *  line is the ONLY lead-side evidence of the (implicit) team. */
const AGENT_ID_RESULT_PATTERN = /agent_id:\s*([^\s@]+)@(\S+)/;

/** Flatten a tool_result content value (string or content-block array) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
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
  return '';
}

/**
 * Read the first few records of a transcript and return its team tags.
 * Newer harnesses open teammate transcripts with setting records (`agent-setting`,
 * `mode`, `permission-mode`) that carry no team fields -- the tags appear on the
 * first user/assistant record -- so scanning just line 1 is not enough.
 *
 * Returns:
 *  - `{ teamName, agentName }` when a record carries team tags
 *  - `null` (definitive) when a user/assistant record appears without them
 *  - `undefined` (indeterminate) when only setting records exist so far
 */
const TEAM_METADATA_SCAN_BYTES = 16384;
function readTeamMetadata(
  jsonlPath: string,
): { teamName: string; agentName?: string } | null | undefined {
  let raw: string;
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const buf = Buffer.alloc(TEAM_METADATA_SCAN_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      raw = buf.toString('utf-8', 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // partial trailing line or mid-write garbage
    }
    if (typeof record.teamName === 'string') {
      // An unsafe name is read as untagged: definitively not a team transcript.
      if (!isSafeTeamName(record.teamName)) return null;
      return {
        teamName: record.teamName,
        agentName: typeof record.agentName === 'string' ? record.agentName : undefined,
      };
    }
    // A conversational record without team tags means this transcript will
    // never gain them (tags are stamped on every user/assistant record).
    if (record.type === 'user' || record.type === 'assistant') return null;
  }
  return undefined;
}

/** Transcripts confirmed to have NO team tags (first user/assistant record was
 *  untagged). Definitive -- never re-read these on subsequent discovery scans.
 *  Indeterminate files (only setting records so far) are NOT cached and get
 *  re-checked until a conversational record lands. */
const confirmedNonTeamFiles = new Set<string>();

/** Session-transcript filename: `<uuid>.jsonl`. Anything else in the project dir
 *  (sidecars, editor droppings) is not a candidate teammate transcript. */
const SESSION_FILE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

// ── Public TeamProvider implementation ──

const TEAMMATE_SPAWN_TOOLS: ReadonlySet<string> = new Set(['Agent']);

/** The tool a parent ends one of its background tasks with. */
const SPAWN_STOP_TOOL = 'TaskStop';
/** Task ids as the CLI mints them (agent keys, workflow task ids). */
const TASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
/** The first `<status>` of a task notice (it precedes the model-authored summary). */
const NOTICE_STATUS_PATTERN = /<status>([a-z]{1,16})<\/status>/;
/** Where a notice's model-authored body starts (its header ends). */
const NOTICE_BODY_TAGS = ['<summary>', '<result>', '<output>'];
const NOTICE_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'killed', 'stopped']);
type NoticeStatus = 'completed' | 'failed' | 'killed' | 'stopped';

export const claudeTeamProvider: TeamProvider = {
  providerId: 'claude',

  teammateSpawnTools: TEAMMATE_SPAWN_TOOLS,
  withinTurnSubagentTools: new Set(['Task']),

  isTeammateSpawnCall(toolName, toolInput) {
    // Claude's Agent tool spawns a teammate ONLY when run_in_background is true.
    // Agent without that flag is a basic within-turn subagent (identical UX to Task).
    return toolName === 'Agent' && toolInput.run_in_background === true;
  },

  extractTeammateNameFromEvent(event) {
    const teammateName = event.teammate_name;
    if (typeof teammateName === 'string') return teammateName;
    const agentType = event.agent_type;
    return typeof agentType === 'string' ? agentType : undefined;
  },

  extractTeammateSpawnFromToolResult(toolName, resultContent) {
    if (!TEAMMATE_SPAWN_TOOLS.has(toolName)) return null;
    const match = AGENT_ID_RESULT_PATTERN.exec(toolResultText(resultContent));
    if (!match || !isSafeTeamName(match[2])) return null;
    return { teammateName: match[1], teamName: match[2] };
  },

  extractSpawnStop(toolName, toolInput) {
    if (toolName !== SPAWN_STOP_TOOL) return null;
    const raw = toolInput.task_id;
    if (typeof raw !== 'string') return null;
    const taskId = raw.trim();
    return TASK_ID_PATTERN.test(taskId) ? taskId : null;
  },

  completionStatus(noticeContent) {
    // Only the notice's own header counts: the summary and result that follow
    // are model-authored and may quote a status tag of their own.
    let headEnd = noticeContent.length;
    for (const tag of NOTICE_BODY_TAGS) {
      const at = noticeContent.indexOf(tag);
      if (at !== -1 && at < headEnd) headEnd = at;
    }
    const status = NOTICE_STATUS_PATTERN.exec(noticeContent.slice(0, headEnd))?.[1];
    return status !== undefined && NOTICE_STATUSES.has(status)
      ? (status as NoticeStatus)
      : undefined;
  },

  extractWorkflowLaunch: extractClaudeWorkflowLaunch,
  discoverWorkflowAgents: discoverClaudeWorkflowAgents,
  isWorkflowRunDirOfSession,

  discoverTeammates(projectDir, leadSessionId, teamName) {
    const result: ReturnType<TeamProvider['discoverTeammates']> = [];

    // Old-style: sidecar-tagged transcripts under <projectDir>/<leadSessionId>/subagents/.
    const dir = teammateDir(projectDir, leadSessionId);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      // directory missing -> no old-style teammates
    }
    const liveMetaPaths = new Set<string>();
    const metaByEntry = new Map<string, SidecarMeta | null>();
    const needRead: Array<{ entry: string; metaPath: string; stat: fs.Stats }> = [];
    for (const entry of entries) {
      if (!entry.endsWith(TRANSCRIPT_SUFFIX)) continue;
      const jsonlPath = path.join(dir, entry);
      liveMetaPaths.add(sidecarPath(jsonlPath));
      const probe = probeSidecar(jsonlPath);
      if (probe.settled) metaByEntry.set(entry, probe.meta);
      else needRead.push({ entry, metaPath: probe.metaPath, stat: probe.stat });
    }
    // Opening sidecars is the expensive part and runs on the event loop: at
    // most SIDECAR_COLD_READS_PER_SCAN per call, NEWEST first (a live spawn's
    // sidecar is fresh; a backlog of historical ones is old). The rest stay
    // uncached and are simply absent this call — the next scan reads them.
    needRead.sort((x, y) => y.stat.mtimeMs - x.stat.mtimeMs);
    for (const { entry, metaPath, stat } of needRead.slice(0, SIDECAR_COLD_READS_PER_SCAN)) {
      metaByEntry.set(entry, readSidecarMeta(metaPath, stat));
    }
    for (const entry of entries) {
      const meta = metaByEntry.get(entry);
      const jsonlPath = path.join(dir, entry);
      if (meta) {
        result.push({
          jsonlPath,
          teammateName: meta.agentType,
          toolUseId: meta.toolUseId,
          description: meta.description,
          name: meta.name,
          agentKey: spawnKeyFromFileName(entry),
          parentAgentKey: meta.parentAgentKey,
          depth: meta.depth,
          agentType: meta.agentType,
        });
      }
    }
    evictStaleSidecars(dir, liveMetaPaths);

    // New-style (implicit teams): teammates are independent TOP-LEVEL sessions in the
    // same project dir, every user/assistant record tagged teamName/agentName. Only
    // scannable once the lead's team is known.
    if (isSafeTeamName(teamName)) {
      let topLevel: string[] = [];
      try {
        topLevel = fs.readdirSync(projectDir);
      } catch {
        return result;
      }
      for (const entry of topLevel) {
        if (!SESSION_FILE_PATTERN.test(entry)) continue;
        const jsonlPath = path.join(projectDir, entry);
        if (confirmedNonTeamFiles.has(jsonlPath)) continue;
        if (jsonlPath === path.join(projectDir, `${leadSessionId}.jsonl`)) continue;
        const meta = readTeamMetadata(jsonlPath);
        if (meta === null) {
          confirmedNonTeamFiles.add(jsonlPath);
          continue;
        }
        if (meta === undefined) continue; // only setting records so far -- recheck next scan
        if (meta.teamName !== teamName || !meta.agentName) continue;
        result.push({
          jsonlPath,
          teammateName: meta.agentName,
          sessionId: entry.slice(0, -'.jsonl'.length),
        });
      }
    }

    return result;
  },

  getTeamMetadataForSession(jsonlPath) {
    // Scan the first few records: newer harnesses open transcripts with setting
    // records that carry no team fields, so line 1 alone is not sufficient.
    return readTeamMetadata(jsonlPath) ?? null;
  },

  extractTeamMetadataFromRecord(record) {
    const teamName = record.teamName;
    if (!isSafeTeamName(teamName)) return null;
    const agentName = record.agentName;
    return {
      teamName,
      agentName: typeof agentName === 'string' ? agentName : undefined,
    };
  },

  getTeamMembers(teamName) {
    // The name may come from persisted state or an older provider build: it is
    // re-checked here, at the one place it becomes a path. Unsafe = unreadable.
    const configPath = teamConfigPath(teamName);
    if (configPath === null) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, 'utf-8');
    } catch {
      return null; // config missing / unreadable -> team dissolved
    }
    try {
      const data = JSON.parse(raw) as { members?: Array<{ name?: unknown; isActive?: unknown }> };
      if (!Array.isArray(data.members)) return null;
      const names = new Set<string>();
      for (const m of data.members) {
        // isActive:false = the CLI marked this one-shot teammate finished (newer
        // harnesses keep finished members listed). Missing isActive = active
        // (older configs never write the field).
        if (m && typeof m.name === 'string' && m.isActive !== false) names.add(m.name);
      }
      return names;
    } catch {
      return null;
    }
  },
};
