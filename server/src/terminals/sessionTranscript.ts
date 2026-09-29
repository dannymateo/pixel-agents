/**
 * Resolve a Claude session id to its transcript, and pull the two things a
 * "Resume" launch needs from it without reading the whole file: the cwd to
 * relaunch in (tail) and a human title for the launch list (head).
 *
 * House pattern for reading an untrusted, possibly-growing file (see
 * `fileWatcher.ts` `readNewLines`): `lstat` first and require a regular file,
 * open with O_NOFOLLOW so a swapped-in symlink is never read, and never read
 * past the bounded window.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  SESSION_HEAD_READ_BYTES,
  SESSION_TAIL_READ_BYTES,
  SESSION_TITLE_MAX_CHARS,
} from '../constants.js';
import { sanitizeFeedText } from '../feedDiff.js';
import { isSafeSessionId } from '../sessionRouter.js';

/** Open flags for a bounded, symlink-safe read of a transcript file. */
const TRANSCRIPT_OPEN_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/** Open `file` for reading if (and only if) it is a regular file, not a
 *  symlink. Returns undefined on any error (missing file, not a regular
 *  file, permission, ...). Caller must close the returned fd. */
function openRegularFile(file: string): number | undefined {
  try {
    const linkStat = fs.lstatSync(file);
    if (!linkStat.isFile()) return undefined;
    const fd = fs.openSync(file, TRANSCRIPT_OPEN_FLAGS);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.ino !== linkStat.ino || stat.dev !== linkStat.dev) {
      fs.closeSync(fd);
      return undefined;
    }
    return fd;
  } catch {
    return undefined;
  }
}

/** Read up to `maxBytes` from the END of `file`. Undefined if the file is
 *  missing, not a regular file, or empty. */
function readTail(file: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openRegularFile(file);
    if (fd === undefined) return undefined;
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return undefined;
    const bytesToRead = Math.min(size, maxBytes);
    const buf = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buf, 0, bytesToRead, size - bytesToRead);
    return buf.toString('utf-8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Read up to `maxBytes` from the START of `file`. Undefined if the file is
 *  missing, not a regular file, or empty. */
function readHead(file: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openRegularFile(file);
    if (fd === undefined) return undefined;
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return undefined;
    const bytesToRead = Math.min(size, maxBytes);
    const buf = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buf, 0, bytesToRead, 0);
    return buf.toString('utf-8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Last `cwd` string recorded in the transcript, read from at most the last
 * `SESSION_TAIL_READ_BYTES` of the file. Undefined when the file is missing,
 * unreadable, or carries no `cwd` field within that window.
 */
export function readSessionCwd(jsonlFile: string): string | undefined {
  const tail = readTail(jsonlFile, SESSION_TAIL_READ_BYTES);
  if (!tail) return undefined;
  const lines = tail.split('\n').filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const record = JSON.parse(lines[i]) as Record<string, unknown>;
      if (typeof record.cwd === 'string' && record.cwd.length > 0) return record.cwd;
    } catch {
      /* malformed / partial line — skip */
    }
  }
  return undefined;
}

/** One text block's `text` field, if it carries one (ignores `tool_result`
 *  and other non-text blocks). */
function textFromBlock(block: unknown): string | undefined {
  if (!block || typeof block !== 'object') return undefined;
  const b = block as Record<string, unknown>;
  if (b.type === 'text' && typeof b.text === 'string') return b.text;
  return undefined;
}

/** The first user-authored text prompt in a `message.content`: either the
 *  content itself (string) or the first `{ type: 'text', text }` block. */
function firstUserText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const text = textFromBlock(block);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

/** Extracts the `<command-args>` block's text from a slash-command record's
 *  raw content (e.g. `/equipo arregla el login` -> "arregla el login"). */
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

/**
 * First user text prompt in the transcript, read from at most the first
 * `SESSION_HEAD_READ_BYTES` of the file: sanitized, collapsed to one line,
 * and bounded to `SESSION_TITLE_MAX_CHARS`. Undefined when the file is
 * missing, unreadable, or carries no user text prompt within that window.
 *
 * Skips records that are not a real user prompt: `isMeta`/`isCompactSummary`
 * injected records, and caveat/local-command text (`<local-command-...`,
 * `<system-reminder...`). A slash-command record (`<command-...`) yields its
 * `<command-args>` text when non-empty (e.g. `/equipo arregla el login` ->
 * "arregla el login"); otherwise it is skipped and the search continues.
 */
export function readSessionTitle(jsonlFile: string): string | undefined {
  const head = readHead(jsonlFile, SESSION_HEAD_READ_BYTES);
  if (!head) return undefined;
  const lines = head.split('\n');
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // possibly a partial trailing line within the window
    }
    if (record.type !== 'user') continue;
    if (record.isMeta === true || record.isCompactSummary === true) continue;
    const message = record.message as Record<string, unknown> | undefined;
    const text = firstUserText(message?.content);
    if (text === undefined) continue;
    const leading = text.trimStart();
    if (leading.startsWith('<local-command-') || leading.startsWith('<system-reminder')) {
      continue;
    }
    let candidate = text;
    if (leading.startsWith('<command-')) {
      const args = COMMAND_ARGS_RE.exec(text)?.[1]?.trim();
      if (!args) continue; // no usable args -- keep looking for the next real prompt
      candidate = args;
    }
    const oneLine = sanitizeFeedText(candidate).replace(/\s+/g, ' ').trim();
    if (!oneLine) continue;
    return oneLine.slice(0, SESSION_TITLE_MAX_CHARS);
  }
  return undefined;
}

/**
 * Find `<sessionId>.jsonl` one directory level under one of `roots` (Claude:
 * `~/.claude/projects/<project-dir>/<sessionId>.jsonl`). Undefined when the
 * id is unsafe (never touches disk in that case) or no root has it.
 */
export function findSessionTranscript(sessionId: string, roots: string[]): string | undefined {
  if (!isSafeSessionId(sessionId)) return undefined;
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, `${sessionId}.jsonl`);
      try {
        if (fs.lstatSync(candidate).isFile()) return candidate;
      } catch {
        /* not present here — keep looking */
      }
    }
  }
  return undefined;
}
