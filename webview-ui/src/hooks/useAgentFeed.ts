import { useEffect, useState } from 'react';

import { TRANSPORT_STATE_CONNECTED } from '../../../core/src/constants.js';
import type { FeedEntry, ServerMessage } from '../../../core/src/messages.js';
import { mergeFeed, validFeedEntries } from '../components/feedFormat.js';
import {
  FEED_MAX_ENTRIES,
  FEED_UNAVAILABLE_MAX_RETRIES,
  FEED_UNAVAILABLE_RETRY_MS,
} from '../constants.js';
import type { MessageTransport } from '../transport/types.js';

export type FeedDenied = 'unprivileged' | 'unknownAgent';

export interface AgentFeedState {
  entries: FeedEntry[];
  /** The server's snapshot left older entries out. */
  truncated: boolean;
  denied: FeedDenied | null;
  /** A snapshot or a denial has arrived for the current subscription (false
   *  again while the connection is down: the entries held are not live). */
  loaded: boolean;
}

export const EMPTY_FEED: AgentFeedState = Object.freeze({
  entries: [],
  truncated: false,
  denied: null,
  loaded: false,
}) as AgentFeedState;

/** True when the merge left out an entry older than everything it kept. */
function droppedAny(prev: FeedEntry[], incoming: FeedEntry[], merged: FeedEntry[]): boolean {
  if (merged.length === 0) return false;
  let min = prev.length > 0 ? prev[0].seq : Infinity;
  for (const e of incoming) if (e.seq < min) min = e.seq;
  return min < merged[0].seq;
}

/**
 * Subscribes this connection to `agentId`'s feed and reports every change
 * through `onChange`. The React-free core of `useAgentFeed` (so it runs under
 * the Node test runner). Returns the teardown, which sends
 * `unsubscribeAgentFeed`.
 *
 * The feed is directed at one connection and the server forgets a
 * connection's subscriptions when its socket drops, so a reconnect
 * re-subscribes (the fresh snapshot replaces what we hold).
 */
export function openAgentFeed(
  transport: MessageTransport,
  agentId: number,
  onChange: (state: AgentFeedState) => void,
): () => void {
  let state: AgentFeedState = EMPTY_FEED;
  let disposed = false;
  const set = (next: AgentFeedState): void => {
    state = next;
    onChange(state);
  };

  const offMessage = transport.onMessage((msg: ServerMessage) => {
    if (disposed || typeof msg !== 'object' || msg === null) return;
    if (
      msg.type !== 'agentFeedSnapshot' &&
      msg.type !== 'agentFeedAppend' &&
      msg.type !== 'agentFeedDenied'
    ) {
      return;
    }
    if (msg.id !== agentId) return;
    if (msg.type === 'agentFeedSnapshot') {
      clearRetry();
      retries = 0;
      const incoming = validFeedEntries(msg.entries);
      set({
        entries: mergeFeed([], incoming, FEED_MAX_ENTRIES),
        truncated: msg.truncated === true || incoming.length > FEED_MAX_ENTRIES,
        denied: null,
        loaded: true,
      });
    } else if (msg.type === 'agentFeedAppend') {
      // Nothing accrues behind a refusal.
      if (state.denied === 'unprivileged') return;
      const incoming = validFeedEntries(msg.entries);
      if (incoming.length === 0) return;
      const entries = mergeFeed(state.entries, incoming, FEED_MAX_ENTRIES);
      set({
        ...state,
        entries,
        // Our own trim dropped history too: say so, like a truncated snapshot.
        truncated: state.truncated || droppedAny(state.entries, incoming, entries),
      });
    } else {
      const reason: FeedDenied = msg.reason === 'unknownAgent' ? 'unknownAgent' : 'unprivileged';
      set({
        // A refused connection must not keep showing anything it held.
        entries: reason === 'unprivileged' ? [] : state.entries,
        truncated: reason === 'unprivileged' ? false : state.truncated,
        denied: reason,
        loaded: true,
      });
      // unknownAgent also answers a live agent whose transcript the server
      // cannot read YET (just launched): keep asking while the screen is open.
      if (reason === 'unknownAgent') scheduleRetry();
      else clearRetry();
    }
  });

  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  function clearRetry(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  }
  let retries = 0;
  function scheduleRetry(): void {
    clearRetry();
    // Bounded: an agent that left for good would otherwise be asked forever.
    if (retries >= FEED_UNAVAILABLE_MAX_RETRIES) return;
    retries++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!disposed) subscribe();
    }, FEED_UNAVAILABLE_RETRY_MS);
  }

  const subscribe = (): void => {
    transport.send({ type: 'subscribeAgentFeed', id: agentId });
  };
  let lastState = transport.state;
  const offState = transport.onStateChange((next) => {
    if (disposed) return;
    const reconnected =
      next === TRANSPORT_STATE_CONNECTED && lastState !== TRANSPORT_STATE_CONNECTED;
    lastState = next;
    if (next !== TRANSPORT_STATE_CONNECTED && state.loaded) {
      // The server forgets this subscription with the socket: what we hold is
      // no longer live until the resubscribe answers.
      set({ ...state, loaded: false });
    }
    // Always re-subscribe: a subscribe the transport queued may get flushed
    // too, but the server treats a repeat as a refresh (the new snapshot
    // replaces what we hold), so the duplicate is harmless — and unlike
    // tracking what was queued, this cannot race the socket closing.
    if (reconnected) subscribe();
  });

  subscribe();

  return () => {
    if (disposed) return;
    disposed = true;
    clearRetry();
    offMessage();
    offState();
    transport.send({ type: 'unsubscribeAgentFeed', id: agentId });
  };
}

/**
 * Live feed of one agent's screen. Subscribes on mount / agent change,
 * unsubscribes on unmount / agent change. `agentId === null` subscribes to
 * nothing.
 */
export function useAgentFeed(transport: MessageTransport, agentId: number | null): AgentFeedState {
  // State is tagged with the agent it belongs to, so switching agents never
  // shows the previous agent's feed for a frame.
  const [feed, setFeed] = useState<{ agentId: number | null; state: AgentFeedState }>({
    agentId,
    state: EMPTY_FEED,
  });

  useEffect(() => {
    if (agentId === null) return;
    return openAgentFeed(transport, agentId, (state) => setFeed({ agentId, state }));
  }, [transport, agentId]);

  return feed.agentId === agentId ? feed.state : EMPTY_FEED;
}
