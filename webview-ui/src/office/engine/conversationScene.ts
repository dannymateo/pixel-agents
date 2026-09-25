/**
 * Conversation scenes (spec §4b): one agent addresses another — assigns work,
 * reports back, sends a message — and the office acts it out. The speaker
 * walks up to the listener, both turn to face each other, the text appears in
 * a bubble as a typewriter, and the speaker walks back to its desk.
 *
 * This module is the pure director: it owns the queue, the phases and the
 * typewriter clock, and moves characters only through the {@link SceneHost}
 * seam (OfficeState implements it). No DOM, no timers of its own — the game
 * loop calls {@link ConversationDirector.update} every frame.
 *
 * Rules:
 * - One scene at a time per character: a speaker's scenes run in FIFO order,
 *   and a scene starts only when neither its speaker nor its listener is in
 *   another active scene.
 * - A scene that cannot be staged (no listener, listener not in the office,
 *   leaving, or no path to it) shows the ✉ envelope over the speaker instead.
 * - The walk is purely visual: presence and status are never touched here.
 * - The text is transcript content: it is only ever handed out as a plain
 *   string (rendered as React children), capped in length, and absent on
 *   unprivileged connections (the bubble shows "…").
 */

import {
  CONVERSATION_ID_MAX_LENGTH,
  CONVERSATION_MARKS_PER_CHAR,
  CONVERSATION_MAX_MS,
  CONVERSATION_QUEUE_MAX_PER_AGENT,
  CONVERSATION_QUEUE_MAX_TOTAL,
  CONVERSATION_READ_HOLD_MS,
  CONVERSATION_RECENT_IDS_MAX,
  CONVERSATION_STAGE_GRACE_MS,
  CONVERSATION_STARTS_PER_FRAME,
  CONVERSATION_TEXT_MAX_CHARS,
  CONVERSATION_TYPE_CPS,
  CONVERSATION_WALK_MAX_MS,
} from '../../constants.js';

export type ScenePhase = 'queued' | 'walking' | 'talking' | 'returning' | 'done';

export type ConversationKind = 'assign' | 'report' | 'message';

export interface ConversationEvent {
  conversationId: string;
  fromId: number;
  toId?: number;
  kind: ConversationKind;
  text?: string;
}

export interface SceneView {
  conversationId: string;
  fromId: number;
  toId?: number;
  phase: ScenePhase;
  /** What the bubble shows now ('…' when the text is absent). Plain text. */
  visibleText: string;
  /** The whole (capped) text is visible. */
  complete: boolean;
  /** There is more than the bubble shows: the text was capped, or the scene
   *  hit `maxMs` before it finished typing. The bubble offers "…ver completo". */
  truncated: boolean;
  /** Draw the speaker's bubble: while talking, and — cut short, not yet
   *  closed — while it walks back, so "…ver completo" stays clickable. */
  showBubble: boolean;
  kind: ConversationKind;
}

export interface SceneHost {
  /** Both characters present in the office and able to take part? */
  canStage(fromId: number, toId: number | undefined): boolean;
  /** Start walking `fromId` next to `toId`; false if no path. */
  walkNextTo(fromId: number, toId: number): boolean;
  hasArrived(fromId: number): boolean;
  faceEachOther(fromId: number, toId: number): void;
  returnToSeat(fromId: number): void;
  isSeated(fromId: number): boolean;
  showEnvelope(fromId: number): void;
  /** Whether a character is still in the office (not removed, not leaving). */
  isPresent(id: number): boolean;
}

export interface ConversationDirectorOptions {
  /** Typewriter speed, characters (code points) per second. */
  cps: number;
  /** Longest a scene talks; past it the text is revealed and the scene closes. */
  maxMs: number;
  /** Linger after the whole text is shown, before walking back. */
  readHoldMs?: number;
  /** Cap on a walk there (and on the walk back). */
  walkMaxMs?: number;
  /** Code points a bubble ever holds. */
  textMaxChars?: number;
  /** Waiting scenes per speaker (oldest dropped). */
  queueMaxPerAgent?: number;
  /** Waiting scenes in total (oldest dropped). */
  queueMaxTotal?: number;
}

const NO_TEXT = '…';
const KINDS: ReadonlySet<string> = new Set(['assign', 'report', 'message']);

interface Scene {
  conversationId: string;
  fromId: number;
  toId?: number;
  kind: ConversationKind;
  /** The capped text, as user-perceived characters (graphemes: never split a
   *  surrogate pair or an emoji sequence). */
  chars: string[];
  /** The text was absent or empty: show '…'. */
  noText: boolean;
  /** `chars` is shorter than the original text. */
  capped: boolean;
  phase: ScenePhase;
  /** ms in the current phase. */
  elapsedMs: number;
  /** ms into `talking` at which the whole text was visible, or null. */
  completeAtMs: number | null;
  /** Clicked: reveal everything. */
  skipped: boolean;
  /** Closed by `maxMs` before the text finished typing. */
  timedOut: boolean;
  /** The bubble was clicked closed while walking back. */
  dismissed: boolean;
  /** ms spent waiting for a speaker / listener not in the office yet. */
  waitedMs: number;
}

/** Agent ids are positive (negative ids are local Subtask sprites). */
function isValidId(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

/** A positive finite option, or its default. */
function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

// Control characters (but tab / newline) and bidi overrides / isolates. The
// server strips them already; the bubble does not rely on it.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g;
/** Runs of combining marks past CONVERSATION_MARKS_PER_CHAR ("Zalgo"). */
const MARK_RUNS = new RegExp(`(\\p{M}{${CONVERSATION_MARKS_PER_CHAR}})\\p{M}+`, 'gu');
/** Nothing visible: format characters (zero-width…) and whitespace only. */
const INVISIBLE_ONLY = /^[\p{Cf}\s]*$/u;

const segmenter =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** Clean `raw` and cut it to at most `max` graphemes. */
function splitText(raw: string, max: number): { chars: string[]; capped: boolean } {
  // Bounded work: no grapheme we keep needs more code units than this.
  const budget = max * (2 + 2 * CONVERSATION_MARKS_PER_CHAR);
  let head = raw.length > budget ? raw.slice(0, budget) : raw;
  // Never keep half a surrogate pair from the cut.
  if (head.length < raw.length && /[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  const clean = head.replace(UNSAFE_CHARS, '').replace(MARK_RUNS, '$1');
  if (INVISIBLE_ONLY.test(clean)) return { chars: [], capped: false };
  const chars: string[] = [];
  const cut = head.length < raw.length;
  let capped = cut;
  const parts = segmenter
    ? Array.from(segmenter.segment(clean), (seg) => seg.segment)
    : Array.from(clean);
  // The budget cut may have split the last grapheme.
  if (cut) parts.pop();
  for (const part of parts) {
    if (chars.length >= max) {
      capped = true;
      break;
    }
    chars.push(part);
  }
  return { chars, capped };
}

export class ConversationDirector {
  private readonly host: SceneHost;
  private readonly cps: number;
  private readonly maxMs: number;
  private readonly readHoldMs: number;
  private readonly walkMaxMs: number;
  private readonly textMaxChars: number;
  private readonly queueMaxPerAgent: number;
  private readonly queueMaxTotal: number;

  /** Waiting scenes, in arrival order. */
  private queue: Scene[] = [];
  /** Running scenes (walking / talking / returning), in start order. */
  private active: Scene[] = [];
  /** Ids of scenes already played or dropped (bounded, oldest forgotten
   *  first): a repeated id never plays twice. */
  private recentIds = new Set<string>();

  constructor(host: SceneHost, opts: ConversationDirectorOptions) {
    this.host = host;
    // Options fail closed: a bad value falls back to the default, so no scene
    // can talk (and hold its characters) forever.
    this.cps = positive(opts.cps, CONVERSATION_TYPE_CPS);
    this.maxMs = positive(opts.maxMs, CONVERSATION_MAX_MS);
    this.readHoldMs = positive(opts.readHoldMs, CONVERSATION_READ_HOLD_MS);
    this.walkMaxMs = positive(opts.walkMaxMs, CONVERSATION_WALK_MAX_MS);
    this.textMaxChars = Math.ceil(positive(opts.textMaxChars, CONVERSATION_TEXT_MAX_CHARS));
    this.queueMaxPerAgent = Math.ceil(
      positive(opts.queueMaxPerAgent, CONVERSATION_QUEUE_MAX_PER_AGENT),
    );
    this.queueMaxTotal = Math.ceil(positive(opts.queueMaxTotal, CONVERSATION_QUEUE_MAX_TOTAL));
  }

  /** Queue a scene (FIFO per speaker). Malformed events and ids already
   *  queued, running or recently played are ignored. */
  enqueue(ev: ConversationEvent): void {
    if (!ev || typeof ev !== 'object') return;
    const { conversationId, fromId, toId, kind, text } = ev;
    if (
      typeof conversationId !== 'string' ||
      conversationId.length === 0 ||
      conversationId.length > CONVERSATION_ID_MAX_LENGTH
    ) {
      return;
    }
    if (!isValidId(fromId)) return;
    if (toId !== undefined && !isValidId(toId)) return;
    if (typeof kind !== 'string' || !KINDS.has(kind)) return;
    if (text !== undefined && typeof text !== 'string') return;
    if (this.recentIds.has(conversationId) || this.find(conversationId)) return;

    const { chars, capped } = splitText(text ?? '', this.textMaxChars);
    const noText = chars.length === 0;

    this.queue.push({
      conversationId,
      fromId,
      toId,
      kind,
      chars: noText ? [NO_TEXT] : chars,
      noText,
      capped: !noText && capped,
      phase: 'queued',
      elapsedMs: 0,
      completeAtMs: null,
      skipped: false,
      timedOut: false,
      dismissed: false,
      waitedMs: 0,
    });
    this.trimQueue(fromId);
  }

  /** Advance every running scene by `dtSec`, then start what can start. */
  update(dtSec: number): void {
    const dtMs = Number.isFinite(dtSec) && dtSec > 0 ? dtSec * 1000 : 0;
    for (const scene of [...this.active]) this.advance(scene, dtMs);
    this.active = this.active.filter((s) => {
      if (s.phase !== 'done') return true;
      this.remember(s.conversationId);
      return false;
    });
    this.startQueued(dtMs);
  }

  /** Click on the bubble: reveal the whole text; on a complete bubble, end
   *  the talk now; walking back, close it. Before talking, the text will
   *  show whole once it does. */
  skip(conversationId: string): void {
    const scene = this.active.find((s) => s.conversationId === conversationId);
    if (!scene) return;
    if (scene.phase === 'walking') {
      scene.skipped = true;
      return;
    }
    if (scene.phase === 'returning') {
      scene.dismissed = true;
      return;
    }
    if (scene.phase !== 'talking') return;
    if (this.isComplete(scene)) {
      this.goBack(scene);
      return;
    }
    scene.skipped = true;
    scene.completeAtMs = scene.elapsedMs;
  }

  /** Running scenes, for rendering. A fresh snapshot every call. */
  views(): SceneView[] {
    return this.active.map((s) => ({
      conversationId: s.conversationId,
      fromId: s.fromId,
      toId: s.toId,
      phase: s.phase,
      visibleText: s.phase === 'walking' ? '' : this.visibleChars(s).join(''),
      complete: s.phase !== 'walking' && this.isComplete(s),
      truncated: s.capped || s.timedOut,
      showBubble: s.phase === 'talking' || this.lingers(s),
      kind: s.kind,
    }));
  }

  /** Speaker of a running scene, or listener of one still walking up or
   *  talking (a speaker walking back no longer holds its listener). */
  isBusy(agentId: number): boolean {
    return this.active.some((s) => s.fromId === agentId || this.holdsListener(s, agentId));
  }

  /** Drop everything (reload / reconnection): no scene replays. A speaker
   *  still on its way or talking is sent back to its desk. */
  clear(): void {
    const running = this.active;
    for (const s of [...running, ...this.queue]) this.remember(s.conversationId);
    this.active = [];
    this.queue = [];
    for (const s of running) {
      if ((s.phase === 'walking' || s.phase === 'talking') && this.host.isPresent(s.fromId)) {
        this.host.returnToSeat(s.fromId);
      }
    }
  }

  // ── internals ──────────────────────────────────────────────────

  private find(conversationId: string): Scene | undefined {
    return (
      this.active.find((s) => s.conversationId === conversationId) ??
      this.queue.find((s) => s.conversationId === conversationId)
    );
  }

  private holdsListener(s: Scene, agentId: number): boolean {
    return s.toId === agentId && (s.phase === 'walking' || s.phase === 'talking');
  }

  /** Mark an id as played / dropped; the oldest is forgotten past the cap. */
  private remember(conversationId: string): void {
    this.recentIds.delete(conversationId);
    this.recentIds.add(conversationId);
    if (this.recentIds.size > CONVERSATION_RECENT_IDS_MAX) {
      const oldest = this.recentIds.values().next().value;
      if (oldest !== undefined) this.recentIds.delete(oldest);
    }
  }

  /** Enforce the per-speaker and total bounds on waiting scenes. Past the
   *  total, the speaker with the most waiting scenes loses its oldest one:
   *  one chatty agent cannot push everyone else's scenes out. */
  private trimQueue(fromId: number): void {
    const drop = (speaker: number) => {
      const idx = this.queue.findIndex((s) => s.fromId === speaker);
      const [dropped] = this.queue.splice(idx, 1);
      this.remember(dropped.conversationId);
    };
    let mine = 0;
    for (const s of this.queue) if (s.fromId === fromId) mine++;
    while (mine > this.queueMaxPerAgent) {
      drop(fromId);
      mine--;
    }
    while (this.queue.length > this.queueMaxTotal) {
      const counts = new Map<number, number>();
      let top = this.queue[0].fromId;
      for (const s of this.queue) {
        const n = (counts.get(s.fromId) ?? 0) + 1;
        counts.set(s.fromId, n);
        if (n > (counts.get(top) ?? 0)) top = s.fromId;
      }
      drop(top);
    }
  }

  private visibleChars(s: Scene): string[] {
    if (s.skipped || s.timedOut || s.noText) return s.chars;
    const n = Math.min(s.chars.length, Math.floor((s.elapsedMs / 1000) * this.cps));
    return s.chars.slice(0, n);
  }

  private isComplete(s: Scene): boolean {
    return s.skipped || s.timedOut || s.noText || s.completeAtMs !== null;
  }

  /** Walking back with a cut-short bubble still open ("…ver completo"). */
  private lingers(s: Scene): boolean {
    return s.phase === 'returning' && (s.capped || s.timedOut) && !s.dismissed;
  }

  private startQueued(dtMs: number): void {
    const busy = new Set<number>();
    for (const s of this.active) {
      busy.add(s.fromId);
      if (s.toId !== undefined && this.holdsListener(s, s.toId)) busy.add(s.toId);
    }
    /** Speakers whose earlier scene is still waiting (FIFO per speaker). */
    const blocked = new Set<number>();
    const waiting: Scene[] = [];
    // Staging costs path searches: only a few scenes start per frame, the
    // rest wait for the next one (a burst never stalls a frame).
    let budget = CONVERSATION_STARTS_PER_FRAME;
    for (const s of this.queue) {
      const listenerBusy = s.toId !== undefined && busy.has(s.toId);
      if (budget <= 0 || blocked.has(s.fromId) || busy.has(s.fromId) || listenerBusy) {
        blocked.add(s.fromId);
        waiting.push(s);
        continue;
      }
      const addressed = s.toId !== undefined && s.toId !== s.fromId;
      const stageable = addressed && this.host.canStage(s.fromId, s.toId);
      if (addressed && !stageable) {
        // Not in the office (yet): an assign can race the child's arrival.
        s.waitedMs += dtMs;
        if (s.waitedMs < CONVERSATION_STAGE_GRACE_MS) {
          blocked.add(s.fromId);
          waiting.push(s);
          continue;
        }
      }
      budget--;
      if (this.start(s, stageable)) {
        busy.add(s.fromId);
        if (s.toId !== undefined) busy.add(s.toId);
        this.active.push(s);
      } else {
        // Could not be staged: it ended with the envelope (done).
        this.remember(s.conversationId);
      }
    }
    this.queue = waiting;
  }

  /** Begin a scene (`stageable`: canStage said yes); false when it ended at
   *  once with the envelope. */
  private start(s: Scene, stageable: boolean): boolean {
    const staged = stageable && s.toId !== undefined && this.host.walkNextTo(s.fromId, s.toId);
    if (!staged) {
      this.host.showEnvelope(s.fromId);
      s.phase = 'done';
      return false;
    }
    s.phase = 'walking';
    s.elapsedMs = 0;
    return true;
  }

  private advance(s: Scene, dtMs: number): void {
    if (!this.host.isPresent(s.fromId)) {
      // The speaker left mid-scene: nothing to walk back.
      s.phase = 'done';
      return;
    }
    const listenerGone = s.toId !== undefined && !this.host.isPresent(s.toId);
    switch (s.phase) {
      case 'walking':
        s.elapsedMs += dtMs;
        if (listenerGone) {
          this.goBack(s);
        } else if (this.host.hasArrived(s.fromId) || s.elapsedMs >= this.walkMaxMs) {
          this.host.faceEachOther(s.fromId, s.toId!);
          s.phase = 'talking';
          s.elapsedMs = 0;
          if (this.isComplete(s)) s.completeAtMs = 0;
        }
        return;
      case 'talking':
        if (listenerGone) {
          this.goBack(s);
          return;
        }
        s.elapsedMs += dtMs;
        if (
          s.completeAtMs === null &&
          Math.floor((s.elapsedMs / 1000) * this.cps) >= s.chars.length
        ) {
          s.completeAtMs = s.elapsedMs;
        }
        if (s.completeAtMs !== null && s.elapsedMs - s.completeAtMs >= this.readHoldMs) {
          this.goBack(s);
        } else if (s.elapsedMs >= this.maxMs) {
          if (s.completeAtMs === null) s.timedOut = true;
          this.goBack(s);
        }
        return;
      case 'returning':
        s.elapsedMs += dtMs;
        if (
          (this.host.isSeated(s.fromId) || s.elapsedMs >= this.walkMaxMs) &&
          // A cut-short bubble stays up at least readHoldMs for its link.
          (!this.lingers(s) || s.elapsedMs >= this.readHoldMs)
        ) {
          s.phase = 'done';
        }
        return;
      default:
        return;
    }
  }

  private goBack(s: Scene): void {
    this.host.returnToSeat(s.fromId);
    s.phase = 'returning';
    s.elapsedMs = 0;
  }
}
