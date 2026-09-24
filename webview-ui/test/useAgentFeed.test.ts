import { describe, expect, it, vi } from 'vitest';

import type { ClientMessage, FeedEntry, ServerMessage } from '../../core/src/messages.js';
import type { MessageTransport, TransportState } from '../../core/src/transport.js';
import {
  FEED_MAX_ENTRIES,
  FEED_UNAVAILABLE_MAX_RETRIES,
  FEED_UNAVAILABLE_RETRY_MS,
} from '../src/constants.js';
import { type AgentFeedState, openAgentFeed } from '../src/hooks/useAgentFeed.js';

class FakeTransport implements MessageTransport {
  sent: ClientMessage[] = [];
  state: TransportState = 'connected';
  private handlers: Array<(m: ServerMessage) => void> = [];
  private stateHandlers: Array<(s: TransportState) => void> = [];
  readonly ready = Promise.resolve();
  send(message: ClientMessage): void {
    this.sent.push(message);
  }
  onMessage(handler: (m: ServerMessage) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }
  onStateChange(handler: (s: TransportState) => void): () => void {
    this.stateHandlers.push(handler);
    return () => {
      this.stateHandlers = this.stateHandlers.filter((h) => h !== handler);
    };
  }
  deliver(msg: unknown): void {
    for (const h of this.handlers) h(msg as ServerMessage);
  }
  setState(s: TransportState): void {
    this.state = s;
    for (const h of this.stateHandlers) h(s);
  }
  get listenerCount(): number {
    return this.handlers.length + this.stateHandlers.length;
  }
  dispose(): void {}
}

const e = (seq: number, kind: FeedEntry['kind'] = 'text'): FeedEntry => ({
  seq,
  ts: '',
  kind,
  summary: `s${seq}`,
});

function open(t: FakeTransport, id = 7) {
  const states: AgentFeedState[] = [];
  const close = openAgentFeed(t, id, (s) => states.push(s));
  const last = () => states[states.length - 1];
  return { close, states, last };
}

describe('openAgentFeed', () => {
  it('subscribes on open and unsubscribes (once) on close, removing its listeners', () => {
    const t = new FakeTransport();
    const { close } = open(t);
    expect(t.sent).toEqual([{ type: 'subscribeAgentFeed', id: 7 }]);
    close();
    close();
    expect(t.sent).toEqual([
      { type: 'subscribeAgentFeed', id: 7 },
      { type: 'unsubscribeAgentFeed', id: 7 },
    ]);
    expect(t.listenerCount).toBe(0);
  });

  it('applies a snapshot, then appends in seq order without duplicates', () => {
    const t = new FakeTransport();
    const { last } = open(t);
    t.deliver({ type: 'agentFeedSnapshot', id: 7, entries: [e(1), e(2)], truncated: true });
    expect(last()).toMatchObject({ truncated: true, denied: null, loaded: true });
    t.deliver({ type: 'agentFeedAppend', id: 7, entries: [e(2), e(3)] });
    expect(last().entries.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(last().truncated).toBe(true);
  });

  it('ignores feed messages for other agents and unrelated messages', () => {
    const t = new FakeTransport();
    const { states } = open(t);
    t.deliver({ type: 'agentFeedSnapshot', id: 8, entries: [e(1)], truncated: false });
    t.deliver({ type: 'agentFeedDenied', id: 8, reason: 'unprivileged' });
    t.deliver({ type: 'agentStatus', id: 7, status: 'active' });
    expect(states).toHaveLength(0);
  });

  it('caps at FEED_MAX_ENTRIES', () => {
    const t = new FakeTransport();
    const { last } = open(t);
    const many = Array.from({ length: FEED_MAX_ENTRIES + 50 }, (_, i) => e(i));
    t.deliver({ type: 'agentFeedSnapshot', id: 7, entries: many, truncated: false });
    expect(last().entries).toHaveLength(FEED_MAX_ENTRIES);
    expect(last().entries[0].seq).toBe(50);
  });

  it('a new snapshot replaces what it held (resubscribe after a server restart)', () => {
    const t = new FakeTransport();
    const { last } = open(t);
    t.deliver({ type: 'agentFeedSnapshot', id: 7, entries: [e(50), e(51)], truncated: false });
    t.deliver({ type: 'agentFeedSnapshot', id: 7, entries: [e(1)], truncated: false });
    expect(last().entries.map((x) => x.seq)).toEqual([1]);
  });

  it('unprivileged denial clears everything; unknownAgent keeps what was shown', () => {
    const t = new FakeTransport();
    const { last } = open(t);
    t.deliver({ type: 'agentFeedSnapshot', id: 7, entries: [e(1)], truncated: false });
    t.deliver({ type: 'agentFeedDenied', id: 7, reason: 'unknownAgent' });
    expect(last()).toMatchObject({ denied: 'unknownAgent', loaded: true });
    expect(last().entries).toHaveLength(1);
    t.deliver({ type: 'agentFeedDenied', id: 7, reason: 'unprivileged' });
    expect(last()).toMatchObject({ denied: 'unprivileged', entries: [] });
  });

  it('treats an unrecognized denial reason as unprivileged (fail closed)', () => {
    const t = new FakeTransport();
    const { last } = open(t);
    t.deliver({ type: 'agentFeedDenied', id: 7, reason: 'whatever' });
    expect(last().denied).toBe('unprivileged');
  });

  it('drops malformed wire entries instead of throwing', () => {
    const t = new FakeTransport();
    const { last } = open(t);
    t.deliver({ type: 'agentFeedSnapshot', id: 7, entries: 'nope', truncated: false });
    expect(last().entries).toEqual([]);
    t.deliver({ type: 'agentFeedAppend', id: 7, entries: [null, { seq: 'x' }, e(4)] });
    expect(last().entries.map((x) => x.seq)).toEqual([4]);
  });

  it('re-subscribes after a reconnect (the server dropped the connection)', () => {
    const t = new FakeTransport();
    open(t);
    t.setState('reconnecting');
    t.setState('connected');
    expect(t.sent.filter((m) => m.type === 'subscribeAgentFeed')).toHaveLength(2);
  });

  it('re-subscribes on every reconnect (a repeat is a harmless refresh)', () => {
    const t = new FakeTransport();
    t.state = 'connecting';
    open(t);
    t.setState('connected');
    t.setState('reconnecting');
    t.setState('connected');
    expect(t.sent.filter((m) => m.type === 'subscribeAgentFeed')).toHaveLength(3);
  });

  it('keeps asking while the server says unknownAgent, and stops on close', () => {
    vi.useFakeTimers();
    try {
      const t = new FakeTransport();
      const { close } = open(t);
      t.deliver({ type: 'agentFeedDenied', id: 7, reason: 'unknownAgent' });
      vi.advanceTimersByTime(FEED_UNAVAILABLE_RETRY_MS);
      expect(t.sent.filter((m) => m.type === 'subscribeAgentFeed')).toHaveLength(2);
      t.deliver({ type: 'agentFeedSnapshot', id: 7, entries: [e(1)], truncated: false });
      vi.advanceTimersByTime(FEED_UNAVAILABLE_RETRY_MS * 3);
      expect(t.sent.filter((m) => m.type === 'subscribeAgentFeed')).toHaveLength(2);
      t.deliver({ type: 'agentFeedDenied', id: 7, reason: 'unknownAgent' });
      close(); // before the retry fires: none may follow
      vi.advanceTimersByTime(FEED_UNAVAILABLE_RETRY_MS * 3);
      expect(t.sent.filter((m) => m.type === 'subscribeAgentFeed')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after FEED_UNAVAILABLE_MAX_RETRIES consecutive unknownAgent answers', () => {
    vi.useFakeTimers();
    try {
      const t = new FakeTransport();
      open(t);
      for (let i = 0; i < FEED_UNAVAILABLE_MAX_RETRIES + 5; i++) {
        t.deliver({ type: 'agentFeedDenied', id: 7, reason: 'unknownAgent' });
        vi.advanceTimersByTime(FEED_UNAVAILABLE_RETRY_MS);
      }
      expect(t.sent.filter((m) => m.type === 'subscribeAgentFeed')).toHaveLength(
        1 + FEED_UNAVAILABLE_MAX_RETRIES,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry after an unprivileged denial', () => {
    vi.useFakeTimers();
    try {
      const t = new FakeTransport();
      open(t);
      t.deliver({ type: 'agentFeedDenied', id: 7, reason: 'unprivileged' });
      vi.advanceTimersByTime(FEED_UNAVAILABLE_RETRY_MS * 3);
      expect(t.sent.filter((m) => m.type === 'subscribeAgentFeed')).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('flags truncated when its own trim drops history', () => {
    const t = new FakeTransport();
    const { last } = open(t);
    t.deliver({ type: 'agentFeedSnapshot', id: 7, entries: [e(0)], truncated: false });
    const more = Array.from({ length: FEED_MAX_ENTRIES }, (_, i) => e(i + 1));
    t.deliver({ type: 'agentFeedAppend', id: 7, entries: more });
    expect(last().entries[0].seq).toBe(1);
    expect(last().truncated).toBe(true);
  });

  it('does not flag truncated while nothing was dropped', () => {
    const t = new FakeTransport();
    const { last } = open(t);
    t.deliver({ type: 'agentFeedSnapshot', id: 7, entries: [e(0)], truncated: false });
    t.deliver({ type: 'agentFeedAppend', id: 7, entries: [e(0), e(1)] });
    expect(last().truncated).toBe(false);
  });

  it('ignores appends after an unprivileged denial', () => {
    const t = new FakeTransport();
    const { last } = open(t);
    t.deliver({ type: 'agentFeedDenied', id: 7, reason: 'unprivileged' });
    t.deliver({ type: 'agentFeedAppend', id: 7, entries: [e(1)] });
    expect(last().entries).toEqual([]);
  });

  it('marks held entries as not live while the connection is down', () => {
    const t = new FakeTransport();
    const { last } = open(t);
    t.deliver({ type: 'agentFeedSnapshot', id: 7, entries: [e(1)], truncated: false });
    t.setState('reconnecting');
    expect(last()).toMatchObject({ loaded: false });
    expect(last().entries).toHaveLength(1);
    t.setState('connected');
    t.deliver({ type: 'agentFeedSnapshot', id: 7, entries: [e(1), e(2)], truncated: false });
    expect(last()).toMatchObject({ loaded: true });
  });

  it('survives a null message', () => {
    const t = new FakeTransport();
    open(t);
    expect(() => t.deliver(null)).not.toThrow();
  });

  it('nothing after close reaches the listener', () => {
    const t = new FakeTransport();
    const { close, states } = open(t);
    close();
    t.deliver({ type: 'agentFeedSnapshot', id: 7, entries: [e(1)], truncated: false });
    t.setState('reconnecting');
    t.setState('connected');
    expect(states).toHaveLength(0);
    expect(t.sent.filter((m) => m.type === 'subscribeAgentFeed')).toHaveLength(1);
  });
});
