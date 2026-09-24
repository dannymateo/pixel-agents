/**
 * Presence: where a derived agent is in its living-office life (docs/adr/0003).
 *
 * `working` at its desk → `available` once it finished (its parent may resume
 * it) → `lounge` after `idleToLoungeMs` available → back to `working` on any
 * activity. `leaving` is final: it is only entered on a real exit signal, the
 * agent walks out (staggered, leaves first when a subtree goes) and is removed
 * after LEAVE_ANIMATION_MAX_MS whether or not any client animated it.
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
  PRESENCE_TICK_MS,
} from './constants.js';
import type { AgentState } from './types.js';

export type AgentPresence = NonNullable<AgentState['presence']>;

/** Adapter setting (per namespace) holding the idle-to-lounge minutes. */
export const IDLE_TO_LOUNGE_SETTING_KEY = 'pixel-agents.idleToLoungeMinutes';

export interface PresenceTrackerOptions {
  /** Current available → lounge delay (a user setting, read on every tick). */
  idleToLoungeMs: () => number;
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
  /** The lounge clock; runs only while some agent is available. */
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
    // Born available (its spawn finished before it materialized).
    if (hasPresence(agent) && agent.presence === 'available') {
      agent.availableSince ??= this.now();
      this.finishedAt.set(agent.id, agent.availableSince);
      this.ensureTicking();
    }
  };

  private readonly onRemoved = (id: number): void => {
    this.clearLeaveTimer(id);
    this.finishedAt.delete(id);
  };

  constructor(
    private readonly store: AgentStateStore,
    private readonly opts: PresenceTrackerOptions,
  ) {
    this.now = opts.now ?? Date.now;
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

  /** available → lounge once available for `idleToLoungeMs`. Stops the clock
   *  when nobody is left available. */
  tick(): void {
    const limit = this.opts.idleToLoungeMs();
    const now = this.now();
    let anyAvailable = false;
    for (const agent of this.store.values()) {
      if (!hasPresence(agent) || agent.presence !== 'available') continue;
      if (agent.availableSince !== undefined && now - agent.availableSince >= limit) {
        this.set(agent, 'lounge');
      } else {
        anyAvailable = true;
      }
    }
    if (!anyAvailable) this.stopTicking();
  }

  dispose(): void {
    this.disposed = true;
    this.store.off('broadcast', this.onBroadcast);
    this.store.off('agentAdded', this.onAdded);
    this.store.off('agentRemoved', this.onRemoved);
    for (const timer of this.leaveTimers.values()) clearTimeout(timer);
    this.leaveTimers.clear();
    this.finishedAt.clear();
    this.stopTicking();
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
