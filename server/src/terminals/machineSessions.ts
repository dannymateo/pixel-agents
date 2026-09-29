/**
 * Machine-wide project + session discovery for the office console launch
 * dialog: "recent projects" (one entry per Claude project folder, its most
 * recently used cwd) and "recent sessions" (individual transcripts, newest
 * first) to resume. Reads only top-level `<projectDir>/<sessionId>.jsonl`
 * transcripts -- a project dir's `<sessionId>/subagents/...` sub-directory is
 * never descended into, so sub-agent and workflow transcripts never surface
 * here.
 *
 * Uses `readSessionCwd`/`readSessionTitle` (sessionTranscript.ts) for the two
 * bounded reads this needs per file, cached by `(file, mtimeMs)` so a repeat
 * call (the launch dialog reopening) does not re-read every transcript that
 * has not changed since.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  MACHINE_PROJECTS_MAX,
  RECENT_SESSION_LIVE_WINDOW_MS,
  RECENT_SESSIONS_MAX,
} from '../constants.js';
import { isSafeSessionId } from '../sessionRouter.js';
import { readSessionCwd, readSessionTitle } from './sessionTranscript.js';

export interface MachineProject {
  cwd: string;
  name: string;
  lastUsed: number;
}

export interface MachineSession {
  sessionId: string;
  cwd: string;
  name: string;
  lastUsed: number;
  title?: string;
}

/** Cached per-file read of the two things this module ever pulls out of a
 *  transcript, keyed by (file, mtimeMs) so a change on disk invalidates it. */
interface CacheEntry {
  mtimeMs: number;
  cwd: string | undefined;
  cwdRead: boolean;
  title: string | undefined;
  titleRead: boolean;
}

/** Bounded to the size documented in the task brief: a machine can carry
 *  thousands of transcripts, and this cache only needs to cover one launch
 *  dialog's worth of reads at a time. Eviction is FIFO (oldest-inserted),
 *  which is enough to bound memory without the complexity of true LRU. */
const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, CacheEntry>();

function cacheEntry(file: string, mtimeMs: number): CacheEntry {
  const existing = cache.get(file);
  if (existing && existing.mtimeMs === mtimeMs) return existing;
  const fresh: CacheEntry = {
    mtimeMs,
    cwd: undefined,
    cwdRead: false,
    title: undefined,
    titleRead: false,
  };
  cache.set(file, fresh);
  if (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  return fresh;
}

function cachedCwd(file: string, mtimeMs: number): string | undefined {
  const entry = cacheEntry(file, mtimeMs);
  if (!entry.cwdRead) {
    entry.cwd = readSessionCwd(file);
    entry.cwdRead = true;
  }
  return entry.cwd;
}

function cachedTitle(file: string, mtimeMs: number): string | undefined {
  const entry = cacheEntry(file, mtimeMs);
  if (!entry.titleRead) {
    entry.title = readSessionTitle(file);
    entry.titleRead = true;
  }
  return entry.title;
}

/** Directory entries of `dir`, or `[]` if it cannot be read (missing,
 *  permission denied, not a directory -- never throws). */
function safeReadDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeStat(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

/** True when `dir` exists and is a directory right now. Exported so callers
 *  merging their own cwd list (the launch dialog's recent-launch-dirs,
 *  clientMessageHandler.ts) apply the same existence check this module uses
 *  for `listMachineProjects` -- a deleted folder must not surface as a
 *  launch option. */
export function safeIsDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Every top-level `<sessionId>.jsonl` transcript under every project folder
 *  of every root, with its mtime. Never descends into a project folder's own
 *  `<sessionId>/` sub-directory (that is where sub-agent and workflow
 *  transcripts live). */
function listTopLevelTranscripts(roots: string[]): Array<{ file: string; mtimeMs: number }> {
  const found: Array<{ file: string; mtimeMs: number }> = [];
  for (const root of roots) {
    for (const projectEntry of safeReadDir(root)) {
      if (!projectEntry.isDirectory()) continue;
      const projectDir = path.join(root, projectEntry.name);
      for (const entry of safeReadDir(projectDir)) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const file = path.join(projectDir, entry.name);
        const stat = safeStat(file);
        if (!stat) continue;
        found.push({ file, mtimeMs: stat.mtimeMs });
      }
    }
  }
  return found;
}

/** Case-insensitive on win32 (a case-only difference is the same folder
 *  there), exact everywhere else. Exported so callers merging their own
 *  cwd list against `listMachineProjects` (the launch dialog's `projects`,
 *  clientMessageHandler.ts) dedupe the same way. */
export function cwdDedupeKey(cwd: string): string {
  return process.platform === 'win32' ? cwd.toLowerCase() : cwd;
}

/**
 * One entry per project folder across `roots`: the `cwd` of its most
 * recently modified top-level transcript, provided that `cwd` still exists
 * as a directory. Deduped by `cwd`, newest first, bounded to
 * `opts.max ?? MACHINE_PROJECTS_MAX`.
 */
export function listMachineProjects(roots: string[], opts?: { max?: number }): MachineProject[] {
  const max = opts?.max ?? MACHINE_PROJECTS_MAX;
  const byCwd = new Map<string, MachineProject>();

  for (const root of roots) {
    for (const projectEntry of safeReadDir(root)) {
      if (!projectEntry.isDirectory()) continue;
      const projectDir = path.join(root, projectEntry.name);

      let newestFile: string | undefined;
      let newestMtime = -Infinity;
      for (const entry of safeReadDir(projectDir)) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const file = path.join(projectDir, entry.name);
        const stat = safeStat(file);
        if (!stat || stat.mtimeMs <= newestMtime) continue;
        newestMtime = stat.mtimeMs;
        newestFile = file;
      }
      if (!newestFile) continue;

      const cwd = cachedCwd(newestFile, newestMtime);
      if (!cwd || !safeIsDirectory(cwd)) continue;

      const key = cwdDedupeKey(cwd);
      const existing = byCwd.get(key);
      if (!existing || newestMtime > existing.lastUsed) {
        byCwd.set(key, { cwd, name: path.basename(cwd), lastUsed: newestMtime });
      }
    }
  }

  return [...byCwd.values()].sort((a, b) => b.lastUsed - a.lastUsed).slice(0, max);
}

/**
 * Individual sessions to resume, across `roots`, newest first, bounded to
 * `opts.max ?? RECENT_SESSIONS_MAX`. Excludes session ids in `opts.exclude`
 * (an agent already live for it), ids that fail `isSafeSessionId`, and any
 * transcript modified within `RECENT_SESSION_LIVE_WINDOW_MS` (probably still
 * open in some terminal this server is not tracking). Only the newest
 * `max * 2` candidates (by mtime) are read for `cwd`/`title`, so a huge
 * `~/.claude/projects` never pays for more than a bounded window of reads.
 */
export function listRecentSessions(
  roots: string[],
  opts?: { max?: number; exclude?: ReadonlySet<string> },
): MachineSession[] {
  const max = opts?.max ?? RECENT_SESSIONS_MAX;
  const exclude = opts?.exclude;
  const now = Date.now();

  const candidates = listTopLevelTranscripts(roots)
    .map(({ file, mtimeMs }) => ({ file, mtimeMs, sessionId: path.basename(file, '.jsonl') }))
    .filter((c) => isSafeSessionId(c.sessionId))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const results: MachineSession[] = [];
  for (const candidate of candidates.slice(0, max * 2)) {
    if (results.length >= max) break;
    if (exclude?.has(candidate.sessionId)) continue;
    if (now - candidate.mtimeMs < RECENT_SESSION_LIVE_WINDOW_MS) continue;

    const cwd = cachedCwd(candidate.file, candidate.mtimeMs);
    if (!cwd) continue;

    results.push({
      sessionId: candidate.sessionId,
      cwd,
      name: path.basename(cwd),
      lastUsed: candidate.mtimeMs,
      title: cachedTitle(candidate.file, candidate.mtimeMs),
    });
  }
  return results;
}
