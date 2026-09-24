import * as fs from 'fs';

import type {
  AgentFeedAppend,
  AgentFeedDenied,
  AgentFeedSnapshot,
  FeedEntry,
} from '../../core/src/messages.js';
import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  FEED_MAX_SUBSCRIPTIONS_PER_CONNECTION,
  FEED_SEEN_UUIDS_MAX,
  FEED_SNAPSHOT_MAX_ENTRIES,
  FEED_TAIL_READ_BYTES,
  FEED_UUID_MAX_CHARS,
} from './constants.js';
import type { AgentState } from './types.js';

/**
 * The agent screen feed (spec §4): an agent's transcript as a live list of
 * entries, sent ONLY to the connections that subscribed to that agent.
 *
 * It exposes code and command output, so:
 * - it is never broadcast — every message goes to one subscriber's `send`;
 * - only privileged connections subscribe (the same proof `setHooksEnabled`
 *   needs: Bearer embedded, `?token=` standalone). An unprivileged request is
 *   denied before anything else, so it can't even learn whether the agent
 *   exists, and never causes a transcript read;
 * - a connection watches at most FEED_MAX_SUBSCRIPTIONS_PER_CONNECTION agents.
 *
 * Wiring (host): the transcript watcher feeds records through
 * `setTranscriptLineListener(hub.onRecord, hub.hasSubscribers)` — both are
 * pre-bound — and the connection layer calls `dropConnection` on close.
 *
 * `seq` is per agent and strictly increasing across the snapshot and the
 * appends. A record is known by its `uuid`: real transcripts repeat records,
 * and a record the client already has is never sent again as an append; a
 * later snapshot gives it back with the seq it had. A snapshot REPLACES the
 * client's list for that agent.
 *
 * Invariant relied on: the watcher never moves `fileOffset` BACK on the same
 * file while it is watched (it only rewinds during spawn seeding, before any
 * subscriber can exist); records re-read after such a rewind would be dropped
 * as already seen. When the agent's transcript FILE changes (/clear, teammate
 * reassignment) the next record re-sends every subscriber a fresh snapshot of
 * the new file, so the old session's entries don't run into the new one's.
 *
 * A removed agent's subscribers get nothing from the feed — the client already
 * receives `agentClosed` — and every structure of the agent is freed.
 */

export type FeedSend = (msg: AgentFeedSnapshot | AgentFeedAppend | AgentFeedDenied) => void;

interface AgentFeed {
  /** The transcript the remembered state belongs to. */
  file: string;
  /** connId → that connection's send. */
  subs: Map<string, FeedSend>;
  /** Record uuid → seq of its first entry, oldest first (bounded). */
  seen: Map<string, number>;
  /** The parsed tail of the last snapshot, reused while the transcript window
   *  is unchanged: re-subscribing to an idle agent costs a stat, not a
   *  re-read and re-parse of FEED_TAIL_READ_BYTES. */
  tail?: ParsedTail;
}

interface ParsedTail {
  key: string;
  kept: TailRecord[];
  skipInFirst: number;
  truncated: boolean;
}

type Draft = Omit<FeedEntry, 'seq'>;

interface TailRecord {
  uuid: string | undefined;
  drafts: Draft[];
}

interface TailRead {
  lines: string[];
  windowed: boolean;
  /** Identity of the window read (file + end + size + mtime); none = nothing readable. */
  key?: string;
  /** The window matches `knownKey`: nothing was read. */
  unchanged?: boolean;
}

const EMPTY_TAIL: TailRead = { lines: [], windowed: false };

/** Open flags for the tail read: never follow a final symlink and never
 *  block on a FIFO swapped in after the lstat (POSIX; Windows has neither). */
const TAIL_OPEN_FLAGS =
  fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

export class AgentFeedHub {
  /** Only agents someone watches have a feed. */
  private readonly feeds = new Map<number, AgentFeed>();
  /** Next seq per agent. Outlives unsubscribes so a later subscription never
   *  reuses a seq; freed when the agent is removed. */
  private readonly nextSeq = new Map<number, number>();
  /** connId → agents it watches, oldest subscription first. */
  private readonly connections = new Map<string, Set<number>>();
  private readonly onAgentRemoved = (id: number): void => this.forgetAgent(id);
  private disposed = false;

  constructor(
    private readonly store: AgentStateStore,
    private readonly provider: HookProvider,
  ) {
    store.on('agentRemoved', this.onAgentRemoved);
    // Handed to the watcher as bare callbacks.
    this.onRecord = this.onRecord.bind(this);
    this.hasSubscribers = this.hasSubscribers.bind(this);
  }

  subscribe(connId: string, agentId: number, privileged: boolean, send: FeedSend): void {
    if (this.disposed || typeof connId !== 'string' || !Number.isSafeInteger(agentId)) return;
    // First, before any lookup: an unprivileged client learns nothing.
    if (privileged !== true) {
      deliver(send, { type: 'agentFeedDenied', id: agentId, reason: 'unprivileged' });
      return;
    }
    const agent = this.store.get(agentId);
    if (!agent || !agent.jsonlFile || agent.hooksOnly || agent.nodeKind === 'workflow') {
      deliver(send, { type: 'agentFeedDenied', id: agentId, reason: 'unknownAgent' });
      return;
    }

    let watched = this.connections.get(connId);
    if (!watched) {
      watched = new Set();
      this.connections.set(connId, watched);
    }
    if (watched.has(agentId)) {
      watched.delete(agentId); // refreshed: now the newest
    } else {
      for (const oldest of watched) {
        if (watched.size < FEED_MAX_SUBSCRIPTIONS_PER_CONNECTION) break;
        this.detach(connId, oldest);
        watched.delete(oldest);
      }
    }
    watched.add(agentId);

    let feed = this.feeds.get(agentId);
    if (!feed) {
      feed = { file: agent.jsonlFile, subs: new Map(), seen: new Map() };
      this.feeds.set(agentId, feed);
    }
    feed.subs.set(connId, send);
    // A transcript switch noticed here restarts the other subscribers too.
    const switched = feed.file !== agent.jsonlFile;
    if (switched) this.switchFile(agent, feed);

    const { entries, truncated } = this.snapshot(agentId, agent, feed);
    const msg: AgentFeedSnapshot = { type: 'agentFeedSnapshot', id: agentId, entries, truncated };
    for (const target of switched ? [...feed.subs.values()] : [send]) deliver(target, msg);
  }

  unsubscribe(connId: string, agentId: number): void {
    const watched = this.connections.get(connId);
    if (watched?.delete(agentId) && watched.size === 0) this.connections.delete(connId);
    this.detach(connId, agentId);
  }

  dropConnection(connId: string): void {
    const watched = this.connections.get(connId);
    if (!watched) return;
    this.connections.delete(connId);
    for (const agentId of watched) this.detach(connId, agentId);
  }

  /** Whether anyone watches `agentId` — the watcher's gate: records of other
   *  agents are not even parsed for the feed. */
  hasSubscribers(agentId: number): boolean {
    return (this.feeds.get(agentId)?.subs.size ?? 0) > 0;
  }

  /** Called for every transcript record the runtime parses. */
  onRecord(agentId: number, record: Record<string, unknown>): void {
    const feed = this.feeds.get(agentId);
    if (!feed || feed.subs.size === 0) return;
    const agent = this.store.get(agentId);
    if (agent && agent.jsonlFile && agent.jsonlFile !== feed.file) {
      // A new transcript: every subscriber starts over from its snapshot
      // (which may already hold this record — then it's dropped below).
      this.switchFile(agent, feed);
      const { entries, truncated } = this.snapshot(agentId, agent, feed);
      const msg: AgentFeedSnapshot = { type: 'agentFeedSnapshot', id: agentId, entries, truncated };
      for (const send of [...feed.subs.values()]) deliver(send, msg);
    }
    const uuid = uuidOf(record);
    if (uuid !== undefined && feed.seen.has(uuid)) return;
    const drafts = this.parse(agentId, record);
    if (drafts.length === 0) return;
    const base = this.allocate(agentId, drafts.length);
    if (uuid !== undefined) remember(feed, uuid, base);
    const msg: AgentFeedAppend = {
      type: 'agentFeedAppend',
      id: agentId,
      entries: drafts.map((d, i) => ({ ...d, seq: base + i })),
    };
    // A copy: a send may unsubscribe synchronously.
    for (const send of [...feed.subs.values()]) deliver(send, msg);
  }

  dispose(): void {
    this.disposed = true;
    this.store.off('agentRemoved', this.onAgentRemoved);
    this.feeds.clear();
    this.nextSeq.clear();
    this.connections.clear();
  }

  // ── Internals ──

  /** Forget what belonged to the previous transcript (seqs keep growing). */
  private switchFile(agent: AgentState, feed: AgentFeed): void {
    feed.file = agent.jsonlFile;
    feed.seen.clear();
    feed.tail = undefined;
  }

  private detach(connId: string, agentId: number): void {
    const feed = this.feeds.get(agentId);
    if (!feed) return;
    feed.subs.delete(connId);
    // Nobody watches: stop remembering (nextSeq stays, seqs never go back).
    if (feed.subs.size === 0) this.feeds.delete(agentId);
  }

  private forgetAgent(agentId: number): void {
    this.feeds.delete(agentId);
    this.nextSeq.delete(agentId);
    for (const [connId, watched] of this.connections) {
      if (watched.delete(agentId) && watched.size === 0) this.connections.delete(connId);
    }
  }

  private allocate(agentId: number, count: number): number {
    const base = this.nextSeq.get(agentId) ?? 1;
    this.nextSeq.set(agentId, base + count);
    return base;
  }

  private parse(agentId: number, record: Record<string, unknown>): Draft[] {
    const parseFeedEntries = this.provider.parseFeedEntries;
    if (!parseFeedEntries) return [];
    try {
      const drafts = parseFeedEntries.call(this.provider, record);
      return Array.isArray(drafts) ? drafts : [];
    } catch (e) {
      console.log(`[Pixel Agents] Feed: Agent ${agentId} - record skipped: ${errorText(e)}`);
      return [];
    }
  }

  /** The newest FEED_SNAPSHOT_MAX_ENTRIES entries of the transcript tail, up
   *  to where the watcher has read (later records reach the feed as appends).
   *  `truncated` = older history exists that the snapshot does not carry. */
  private snapshot(
    agentId: number,
    agent: AgentState,
    feed: AgentFeed,
  ): { entries: FeedEntry[]; truncated: boolean } {
    if (!this.provider.parseFeedEntries) return { entries: [], truncated: false };
    const read = readTail(agentId, agent, feed.tail?.key);
    const tail = read.unchanged && feed.tail ? feed.tail : this.parseTail(agentId, read);
    feed.tail = tail.key ? tail : undefined;
    return this.number(agentId, feed, tail);
  }

  /** Parse a tail read into the records a snapshot carries. */
  private parseTail(agentId: number, { lines, windowed, key }: TailRead): ParsedTail {
    const records: TailRecord[] = [];
    const inSnapshot = new Set<string>();
    for (const line of lines) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof record !== 'object' || record === null || Array.isArray(record)) continue;
      const rec = record as Record<string, unknown>;
      const uuid = uuidOf(rec);
      if (uuid !== undefined && inSnapshot.has(uuid)) continue;
      const drafts = this.parse(agentId, rec);
      if (drafts.length === 0) continue;
      if (uuid !== undefined) inSnapshot.add(uuid);
      records.push({ uuid, drafts });
    }

    // Newest first until the budget is spent; the oldest kept record may
    // contribute only its last entries.
    let budget = FEED_SNAPSHOT_MAX_ENTRIES;
    let first = records.length;
    while (first > 0 && budget > 0) {
      first--;
      budget -= records[first].drafts.length;
    }
    const skipInFirst = budget < 0 ? -budget : 0;
    const truncated = windowed || first > 0 || skipInFirst > 0;
    return { key: key ?? '', kept: records.slice(first), skipInFirst, truncated };
  }

  /** Give a parsed tail its seqs. */
  private number(
    agentId: number,
    feed: AgentFeed,
    { kept, skipInFirst, truncated }: ParsedTail,
  ): { entries: FeedEntry[]; truncated: boolean } {
    // A record the client may already have keeps its seq; a new one gets
    // fresh seqs. Should that break the order (a uuid forgotten and its
    // record seen again), the snapshot is renumbered — correct order beats
    // stable numbering.
    const bases = kept.map((r) =>
      r.uuid !== undefined ? feed.seen.get(r.uuid) : (undefined as number | undefined),
    );
    // Fresh seqs exceed every seq ever given, so the order holds iff the
    // known records come first, in increasing seq.
    let reuse = true;
    let last = 0;
    let sawNew = false;
    for (let i = 0; i < kept.length && reuse; i++) {
      const known = bases[i];
      if (known === undefined) sawNew = true;
      else if (sawNew || known <= last) reuse = false;
      else last = known + kept[i].drafts.length - 1;
    }

    const entries: FeedEntry[] = [];
    kept.forEach((r, i) => {
      let base = reuse ? bases[i] : undefined;
      if (base === undefined) {
        base = this.allocate(agentId, r.drafts.length);
        if (r.uuid !== undefined) remember(feed, r.uuid, base);
      }
      const from = i === 0 ? skipInFirst : 0;
      for (let k = from; k < r.drafts.length; k++) entries.push({ ...r.drafts[k], seq: base + k });
    });
    return { entries, truncated };
  }
}

function deliver(send: FeedSend, msg: Parameters<FeedSend>[0]): void {
  try {
    send(msg);
  } catch (e) {
    console.log(`[Pixel Agents] Feed: send to a subscriber failed: ${errorText(e)}`);
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The record's uuid, when it is one we can remember. */
function uuidOf(record: Record<string, unknown>): string | undefined {
  const uuid = record.uuid;
  return typeof uuid === 'string' && uuid.length > 0 && uuid.length <= FEED_UUID_MAX_CHARS
    ? uuid
    : undefined;
}

function remember(feed: AgentFeed, uuid: string, seq: number): void {
  feed.seen.delete(uuid);
  feed.seen.set(uuid, seq);
  while (feed.seen.size > FEED_SEEN_UUIDS_MAX) {
    const oldest = feed.seen.keys().next().value;
    if (oldest === undefined) break;
    feed.seen.delete(oldest);
  }
}

/**
 * The complete lines in the last FEED_TAIL_READ_BYTES of the agent's
 * transcript, ending where the watcher has read (`fileOffset`). Only a regular
 * file is read, never through a symlink, and the file opened must be the one
 * checked. That guards the snapshot only: the live appends carry whatever the
 * transcript watcher itself reads (fileWatcher's policy, which follows links). The first line when the window opens mid-record, and an
 * unterminated last line (still being written — the watcher holds it), are
 * dropped. `windowed` = the window does not start at the beginning.
 */
function readTail(agentId: number, agent: AgentState, knownKey?: string): TailRead {
  let fd: number | undefined;
  try {
    const linkStat = fs.lstatSync(agent.jsonlFile);
    if (!linkStat.isFile()) return EMPTY_TAIL;
    fd = fs.openSync(agent.jsonlFile, TAIL_OPEN_FLAGS);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.ino !== linkStat.ino || stat.dev !== linkStat.dev) return EMPTY_TAIL;
    const end = Math.min(Math.max(0, agent.fileOffset), stat.size);
    const start = Math.max(0, end - FEED_TAIL_READ_BYTES);
    if (end <= start) return EMPTY_TAIL;
    const key = [agent.jsonlFile, stat.dev, stat.ino, stat.size, stat.mtimeMs, end].join('|');
    if (key === knownKey) return { lines: [], windowed: false, key, unchanged: true };
    // One byte early: when it is a newline the window opens on a record
    // boundary and the dropped "fragment" is empty.
    const from = start > 0 ? start - 1 : 0;
    const buf = Buffer.alloc(end - from);
    let filled = 0;
    while (filled < buf.length) {
      const n = fs.readSync(fd, buf, filled, buf.length - filled, from + filled);
      if (n <= 0) break;
      filled += n;
    }
    const lines: string[] = [];
    let pos = 0;
    let skipFirst = start > 0;
    for (let nl = buf.indexOf(0x0a, 0); nl !== -1 && nl < filled; nl = buf.indexOf(0x0a, pos)) {
      if (skipFirst) skipFirst = false;
      else if (nl > pos) lines.push(buf.toString('utf8', pos, nl));
      pos = nl + 1;
    }
    return { lines, windowed: start > 0, key };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.log(`[Pixel Agents] Feed: Agent ${agentId} - transcript unreadable: ${errorText(e)}`);
    }
    return EMPTY_TAIL;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}
