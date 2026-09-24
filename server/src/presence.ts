/**
 * Presence: where a derived agent is in its living-office life (docs/adr/0003).
 *
 * `working` at its desk → `available` once it finished (its parent may resume
 * it) → `lounge` after `idleToLoungeMs` available → back to `working` on any
 * activity. `leaving` is final: it is entered on a real exit signal, or after
 * `loungeToLeaveMs` resting unused (with its subtree, once none of it is
 * working); the agent walks out (staggered, leaves first when a subtree goes)
 * and is removed after LEAVE_ANIMATION_MAX_MS whether or not any client
 * animated it.
 *
 * The server decides, every client animates the same answer (`agentPresence`
 * broadcasts). Session roots have no presence: they keep their own lifecycle.
 * Nothing here is persisted.
 */
import type { AgentStateStore } from './agentStateStore.js';
import {
  LEAVE_ANIMATION_MAX_MS,
  LEAVE_QUEUE_MAX_MS,
  LEAVE_STAGGER_MS,
  LOUNGE_TO_LEAVE_MS_DEFAULT,
  PRESENCE_TICK_MS,
} from './constants.js';
import { subtreeRemovalOrder } from './spawnTree.js';
import type { AgentState } from './types.js';

export type AgentPresence = NonNullable<AgentState['presence']>;

/** Adapter setting (per namespace) holding the idle-to-lounge minutes. */
export const IDLE_TO_LOUNGE_SETTING_KEY = 'pixel-agents.idleToLoungeMinutes';
/** Adapter setting (per namespace) holding the lounge-to-leave minutes. */
export const LOUNGE_TO_LEAVE_SETTING_KEY = 'pixel-agents.loungeToLeaveMinutes';

/** The two living-office delays, in ms. */
export interface PresenceTimings {
  idleToLoungeMs: number;
  loungeToLeaveMs: number;
}

/**
 * Where an agent that finished at `finishedAt` belongs `now` (the
 * reappearance window): at its desk within `idleToLoungeMs`, in the lounge
 * until `idleToLoungeMs + loungeToLeaveMs`, gone (undefined) past both. A
 * finish time in the future counts as now: a skewed or forged timestamp buys
 * no longer stay than a fresh finish.
 */
export function finishedPresence(
  finishedAt: number,
  now: number,
  t: PresenceTimings,
): 'available' | 'lounge' | undefined {
  const elapsed = Math.max(0, now - finishedAt);
  if (elapsed < t.idleToLoungeMs) return 'available';
  if (elapsed < t.idleToLoungeMs + t.loungeToLeaveMs) return 'lounge';
  return undefined;
}

export interface PresenceTrackerOptions {
  /** Current available → lounge delay (a user setting, read on every tick). */
  idleToLoungeMs: () => number;
  /** Current lounge → leaving delay (a user setting, read on every tick).
   *  Defaults to LOUNGE_TO_LEAVE_MS_DEFAULT. */
  loungeToLeaveMs?: () => number;
  /** Whether an unused rester may leave on its own (default: every derived
   *  agent). The runtime keeps a workflow's node and run agents: their run's
   *  notice ends them, and a run agent's transcript would be re-adopted. */
  canLeaveUnused?: (agent: AgentState) => boolean;
  /** Walks a rester that stayed unused too long out, with its subtree. The
   *  runtime ends its spawn (so nothing re-materializes it); without it the
   *  tracker walks the subtree out itself (tests only). */
  leave?: (id: number) => void;
  /** Clock (ms since epoch); injectable for tests. */
  now?: () => number;
  /** Removes a departed agent for good. Without it the tracker deletes it from
   *  the store itself (no watcher/timer cleanup — tests only). */
  remove?: (id: number) => void;
}

/** Only derived agents (docs/adr/0002) have a presence. */
function hasPresence(agent: AgentState | undefined): agent is AgentState {
  return agent !== undefined && agent.parentAgentId !== undefined;
}

export class PresenceTracker {
  private readonly now: () => number;
  /** Pending timers of each leaving agent (its departure, then its removal). */
  private readonly leaveTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** When the next departure may start: exits queue up instead of overlapping. */
  private nextDepartureAt = 0;
  /** When each resting agent entered the lounge (its exit counts from there). */
  private readonly loungeSince = new Map<number, number>();
  /** The lounge clock; runs only while some agent is available or resting. */
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  /** Agents whose task finished (completed/failed notice), with when. Their
   *  task is over: late activity from the rest of their transcript (read after
   *  the notice, or replayed) must not put them back to work — only a new
   *  prompt written after that moment (their parent resuming them) does. */
  private readonly finishedAt = new Map<number, number>();

  private readonly onBroadcast = (msg: Record<string, unknown>): void => {
    if (typeof msg.id !== 'number') return;
    if (msg.type === 'agentStatus') {
      if (msg.status === 'active') {
        if (!this.finishedAt.has(msg.id)) this.markActivity(msg.id);
      } else if (msg.status === 'waiting') this.markAvailable(msg.id);
    } else if (msg.type === 'agentToolPermission') {
      if (!this.finishedAt.has(msg.id)) this.markActivity(msg.id);
    }
  };

  private readonly onAdded = (_id: number, agent: AgentState): void => {
    // Born available or resting (its spawn finished before it materialized;
    // `availableSince` is its real finish time when known, never the future).
    if (!hasPresence(agent)) return;
    if (agent.presence !== 'available' && agent.presence !== 'lounge') return;
    const now = this.now();
    agent.availableSince = Math.min(agent.availableSince ?? now, now);
    // Deaf to activity written before its task ended; a prompt written after
    // its completion notice is its parent resuming it.
    this.finishedAt.set(agent.id, Math.min(agent.finishedNoticeAt ?? agent.availableSince, now));
    agent.finishedNoticeAt = undefined;
    if (agent.presence === 'lounge') {
      this.loungeSince.set(
        agent.id,
        Math.min(agent.availableSince + this.opts.idleToLoungeMs(), now),
      );
    }
    this.ensureTicking();
  };

  private readonly onRemoved = (id: number): void => {
    this.clearLeaveTimer(id);
    this.finishedAt.delete(id);
    this.loungeSince.delete(id);
  };

  constructor(
    private readonly store: AgentStateStore,
    private readonly opts: PresenceTrackerOptions,
  ) {
    this.now = opts.now ?? (() => Date.now());
    store.on('broadcast', this.onBroadcast);
    store.on('agentAdded', this.onAdded);
    store.on('agentRemoved', this.onRemoved);
  }

  /** New work (tool, prompt, permission): back to the desk. */
  markActivity(id: number): void {
    const agent = this.store.get(id);
    if (!hasPresence(agent)) return;
    if (agent.presence !== 'available' && agent.presence !== 'lounge') return;
    agent.availableSince = undefined;
    this.loungeSince.delete(id);
    this.set(agent, 'working');
  }

  /** Its task finished (completed/failed notice): available, and deaf to
   *  late activity until resumed. */
  markFinished(id: number): void {
    const agent = this.store.get(id);
    if (!hasPresence(agent) || agent.presence === 'leaving') return;
    this.finishedAt.set(id, this.now());
    this.markAvailable(id);
  }

  /** A new prompt reached the agent (`at`: when it was written, if known).
   *  Written after its task finished, it is a resumption: back to work.
   *  Returns whether it resumed a finished agent. */
  markPrompted(id: number, at?: number): boolean {
    const since = this.finishedAt.get(id);
    if (since === undefined) {
      this.markActivity(id);
      return false;
    }
    if (at !== undefined && at < since) return false;
    this.finishedAt.delete(id);
    this.markActivity(id);
    return true;
  }

  /** It finished (turn end, completed/failed notice). A repeat keeps the
   *  original availability, and a lounging agent stays in the lounge. */
  markAvailable(id: number): void {
    const agent = this.store.get(id);
    if (!hasPresence(agent)) return;
    if (agent.presence !== undefined && agent.presence !== 'working') return;
    agent.availableSince = this.now();
    this.set(agent, 'available');
    this.ensureTicking();
  }

  /**
   * Walk `ids` out, in the given order (callers pass leaves first), one every
   * LEAVE_STAGGER_MS; each is removed LEAVE_ANIMATION_MAX_MS after it starts.
   * Every id is committed to leaving right away, so nothing can revert it
   * while it waits its turn. Unknown, root and already-leaving ids are skipped.
   */
  beginLeave(ids: readonly number[]): void {
    if (this.disposed) return;
    const now = this.now();
    // The queue never grows past LEAVE_QUEUE_MAX_MS: past it (a burst of
    // hundreds), the rest leave together at its end instead of one by one
    // for minutes while still holding their place in the tree.
    let slot = Math.min(Math.max(now, this.nextDepartureAt), now + LEAVE_QUEUE_MAX_MS);
    for (const id of ids) {
      const agent = this.store.get(id);
      if (!hasPresence(agent) || agent.presence === 'leaving') continue;
      agent.presence = 'leaving';
      agent.availableSince = undefined;
      this.loungeSince.delete(id);
      const delay = slot - now;
      slot = Math.min(slot + LEAVE_STAGGER_MS, now + LEAVE_QUEUE_MAX_MS);
      if (delay <= 0) this.depart(id);
      else
        this.leaveTimers.set(
          id,
          setTimeout(() => this.depart(id), delay),
        );
    }
    this.nextDepartureAt = slot;
  }

  /** available → lounge once available for `idleToLoungeMs`; lounge →
   *  leaving (with its subtree) once resting `loungeToLeaveMs` unused. Stops
   *  the clock when nobody is left available or resting. */
  tick(): void {
    const idleLimit = this.opts.idleToLoungeMs();
    const leaveLimit = this.opts.loungeToLeaveMs?.() ?? LOUNGE_TO_LEAVE_MS_DEFAULT;
    const now = this.now();
    let anyPending = false;
    const due: AgentState[] = [];
    for (const agent of this.store.values()) {
      if (!hasPresence(agent)) continue;
      if (agent.presence === 'available') {
        if (agent.availableSince === undefined || now - agent.availableSince < idleLimit) {
          anyPending = true;
          continue;
        }
        // Resting since the moment its idle period ran out, not since this tick.
        this.loungeSince.set(agent.id, Math.min(agent.availableSince + idleLimit, now));
        this.set(agent, 'lounge');
      }
      if (agent.presence !== 'lounge') continue;
      anyPending = true;
      let since = this.loungeSince.get(agent.id);
      if (since === undefined) {
        since = now;
        this.loungeSince.set(agent.id, since);
      }
      if (now - since >= leaveLimit && (this.opts.canLeaveUnused?.(agent) ?? true)) {
        due.push(agent);
      }
    }
    if (due.length > 0) this.leaveUnused(due);
    if (!anyPending) this.stopTicking();
  }

  dispose(): void {
    this.disposed = true;
    this.store.off('broadcast', this.onBroadcast);
    this.store.off('agentAdded', this.onAdded);
    this.store.off('agentRemoved', this.onRemoved);
    for (const timer of this.leaveTimers.values()) clearTimeout(timer);
    this.leaveTimers.clear();
    this.finishedAt.clear();
    this.loungeSince.clear();
    this.stopTicking();
  }

  /** Resters whose time is up leave with their subtree — unless something in
   *  it still works (they wait for it: nobody walks out mid-task). One
   *  departure per subtree: a due rester below another due one goes with it. */
  private leaveUnused(due: readonly AgentState[]): void {
    const children = new Map<number, AgentState[]>();
    for (const a of this.store.values()) {
      if (a.parentAgentId === undefined) continue;
      const list = children.get(a.parentAgentId);
      if (list) list.push(a);
      else children.set(a.parentAgentId, [a]);
    }
    const subtreeWorks = (id: number): boolean => {
      const seen = new Set<number>([id]);
      const stack = [...(children.get(id) ?? [])];
      while (stack.length > 0) {
        const a = stack.pop()!;
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        if (a.presence === 'working') return true;
        stack.push(...(children.get(a.id) ?? []));
      }
      return false;
    };
    const leaving = new Set(due.filter((a) => !subtreeWorks(a.id)).map((a) => a.id));
    for (const id of leaving) {
      if (this.hasAncestorIn(id, leaving)) continue; // goes with that ancestor
      console.log(`[Pixel Agents] Agent ${id} rested unused too long: it leaves`);
      if (this.opts.leave) {
        this.opts.leave(id);
      } else {
        const parentOf = new Map<number, number | undefined>();
        for (const [aid, a] of this.store) parentOf.set(aid, a.parentAgentId);
        this.beginLeave(subtreeRemovalOrder(id, parentOf));
      }
    }
  }

  /** Whether some ancestor of `id` is in `ids` (cycle-safe). */
  private hasAncestorIn(id: number, ids: ReadonlySet<number>): boolean {
    const seen = new Set<number>([id]);
    let up = this.store.get(id)?.parentAgentId;
    while (up !== undefined && !seen.has(up)) {
      if (ids.has(up)) return true;
      seen.add(up);
      up = this.store.get(up)?.parentAgentId;
    }
    return false;
  }

  private set(agent: AgentState, presence: AgentPresence): void {
    agent.presence = presence;
    this.store.broadcast({ type: 'agentPresence', id: agent.id, presence });
  }

  /** Its turn came: tell the clients, and remove it once the walk is over. */
  private depart(id: number): void {
    this.leaveTimers.delete(id);
    const agent = this.store.get(id);
    if (!agent || this.disposed) return;
    this.store.broadcast({ type: 'agentPresence', id, presence: 'leaving' });
    this.leaveTimers.set(
      id,
      setTimeout(() => {
        this.leaveTimers.delete(id);
        if (this.disposed || !this.store.has(id)) return;
        if (this.opts.remove) this.opts.remove(id);
        else this.store.delete(id);
      }, LEAVE_ANIMATION_MAX_MS),
    );
  }

  private clearLeaveTimer(id: number): void {
    const timer = this.leaveTimers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.leaveTimers.delete(id);
  }

  private ensureTicking(): void {
    if (this.tickTimer || this.disposed) return;
    this.tickTimer = setInterval(() => this.tick(), PRESENCE_TICK_MS);
    // Never keep a process alive just to send someone to the lounge.
    this.tickTimer.unref?.();
  }

  private stopTicking(): void {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }
}
