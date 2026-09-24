import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOOK_EVENT_BUFFER_MS,
  MAX_BUFFERED_HOOK_EVENTS,
  MAX_BUFFERED_HOOK_EVENTS_PER_SPAWN,
} from '../src/constants.js';
import { SessionRouter } from '../src/sessionRouter.js';

describe('SessionRouter', () => {
  let router: SessionRouter;

  beforeEach(() => {
    vi.useFakeTimers();
    router = new SessionRouter();
  });

  afterEach(() => {
    router.dispose();
    vi.useRealTimers();
  });

  // ── Session → Agent mapping ────────────────────────────────────────

  describe('session mapping', () => {
    it('register + resolve returns the agentId', () => {
      router.register('sess-1', 42);
      expect(router.resolve('sess-1')).toBe(42);
    });

    it('unregister removes the mapping', () => {
      router.register('sess-1', 42);
      router.unregister('sess-1');
      expect(router.resolve('sess-1')).toBeUndefined();
    });

    it('resolve returns undefined for unknown sessions', () => {
      expect(router.resolve('unknown')).toBeUndefined();
    });

    it('hasSession checks existence', () => {
      router.register('sess-1', 1);
      expect(router.hasSession('sess-1')).toBe(true);
      expect(router.hasSession('sess-2')).toBe(false);
    });
  });

  // ── Pending external sessions ──────────────────────────────────────

  describe('pending external sessions', () => {
    const pending = { sessionId: 'sess-ext', transcriptPath: '/a/b.jsonl', cwd: '/a' };

    it('storePending + confirmPending returns the info and removes it', () => {
      router.storePending('sess-ext', pending);
      expect(router.hasPending('sess-ext')).toBe(true);

      const confirmed = router.confirmPending('sess-ext');
      expect(confirmed).toEqual(pending);
      expect(router.hasPending('sess-ext')).toBe(false);
    });

    it('confirmPending returns undefined for unknown sessions', () => {
      expect(router.confirmPending('unknown')).toBeUndefined();
    });

    it('discardPending removes without returning', () => {
      router.storePending('sess-ext', pending);
      router.discardPending('sess-ext');
      expect(router.hasPending('sess-ext')).toBe(false);
    });
  });

  // ── Event buffering ────────────────────────────────────────────────

  describe('event buffering', () => {
    it('bufferEvent stores events for later', () => {
      router.bufferEvent('claude', { session_id: 'sess-1', hook_event_name: 'Stop' });
      expect(router.hasBuffered('sess-1')).toBe(true);
      expect(router.hasBuffered('sess-2')).toBe(false);
    });

    it('register flushes buffered events for that session', () => {
      router.bufferEvent('claude', { session_id: 'sess-1', hook_event_name: 'Stop' });
      router.bufferEvent('claude', { session_id: 'sess-1', hook_event_name: 'PermissionRequest' });

      const flushed = router.register('sess-1', 1);

      expect(flushed).toHaveLength(2);
      expect(flushed[0].event.hook_event_name).toBe('Stop');
      expect(flushed[1].event.hook_event_name).toBe('PermissionRequest');
      expect(router.hasBuffered('sess-1')).toBe(false);
    });

    it('register does not flush events for other sessions', () => {
      router.bufferEvent('claude', { session_id: 'sess-1', hook_event_name: 'Stop' });
      router.bufferEvent('claude', { session_id: 'sess-2', hook_event_name: 'Stop' });

      const flushed = router.register('sess-1', 1);

      expect(flushed).toHaveLength(1);
      expect(router.hasBuffered('sess-2')).toBe(true);
    });

    it('pruneExpired removes old events', () => {
      router.bufferEvent('claude', { session_id: 'sess-old', hook_event_name: 'Stop' });
      vi.advanceTimersByTime(6_000); // > HOOK_EVENT_BUFFER_MS (5s)
      router.pruneExpired();
      expect(router.hasBuffered('sess-old')).toBe(false);
    });

    it('preserves recent events during prune', () => {
      router.bufferEvent('claude', { session_id: 'sess-new', hook_event_name: 'Stop' });
      vi.advanceTimersByTime(1_000); // < HOOK_EVENT_BUFFER_MS
      router.pruneExpired();
      expect(router.hasBuffered('sess-new')).toBe(true);
    });
  });

  // ── Spawn routing (session, agentKey) ──────────────────────────────

  describe('spawn routing', () => {
    it('resolves a derived agent by (session, agentKey)', () => {
      router.register('s1', 1);
      router.registerSpawn('s1', 'bbb222', 7);
      expect(router.resolveSpawn('s1', 'bbb222')).toBe(7);
      expect(router.resolveSpawn('s1', 'zzz')).toBeUndefined();
      expect(router.resolve('s1')).toBe(1);
    });

    it('keeps keyed events buffered until their node registers, never flushing them to the root', () => {
      router.bufferEvent('claude', { session_id: 's1', hook_event_name: 'PreToolUse' }, 'bbb222');
      router.bufferEvent('claude', { session_id: 's1', hook_event_name: 'Stop' });
      const rootFlush = router.register('s1', 1);
      expect(rootFlush).toHaveLength(1);
      expect(rootFlush[0].agentKey).toBeUndefined();
      expect(rootFlush[0].event.hook_event_name).toBe('Stop');
      const spawnFlush = router.registerSpawn('s1', 'bbb222', 7);
      expect(spawnFlush).toHaveLength(1);
      expect(spawnFlush[0].agentKey).toBe('bbb222');
      expect(spawnFlush[0].event.hook_event_name).toBe('PreToolUse');
    });

    it('re-registering the root never flushes keyed events', () => {
      router.register('s1', 1);
      router.bufferEvent('claude', { session_id: 's1', hook_event_name: 'PreToolUse' }, 'k');
      expect(router.register('s1', 1)).toHaveLength(0);
      expect(router.registerSpawn('s1', 'k', 7)).toHaveLength(1);
    });

    it('registerSpawn does not flush unkeyed root events', () => {
      router.bufferEvent('claude', { session_id: 's1', hook_event_name: 'Stop' });
      expect(router.registerSpawn('s1', 'k', 7)).toHaveLength(0);
      expect(router.register('s1', 1)).toHaveLength(1);
    });

    it('registerSpawn only flushes its own key and session', () => {
      router.bufferEvent('claude', { session_id: 's1', hook_event_name: 'A' }, 'k1');
      router.bufferEvent('claude', { session_id: 's1', hook_event_name: 'B' }, 'k2');
      router.bufferEvent('claude', { session_id: 's2', hook_event_name: 'C' }, 'k1');
      const flushed = router.registerSpawn('s1', 'k1', 7);
      expect(flushed.map((b) => b.event.hook_event_name)).toEqual(['A']);
      expect(router.registerSpawn('s1', 'k2', 8).map((b) => b.event.hook_event_name)).toEqual([
        'B',
      ]);
      expect(router.registerSpawn('s2', 'k1', 9).map((b) => b.event.hook_event_name)).toEqual([
        'C',
      ]);
    });

    it('does not collide keys across sessions', () => {
      router.registerSpawn('s1', 'k', 7);
      router.registerSpawn('s2', 'k', 8);
      expect(router.resolveSpawn('s1', 'k')).toBe(7);
      expect(router.resolveSpawn('s2', 'k')).toBe(8);
      router.unregisterSpawn('s1', 'k');
      expect(router.resolveSpawn('s1', 'k')).toBeUndefined();
      expect(router.resolveSpawn('s2', 'k')).toBe(8);
    });

    it('does not collide when session and key contain a separator-like boundary', () => {
      // "a:b" + "c" must never equal "a" + "b:c" (or any concatenation alias).
      router.registerSpawn('a:b', 'c', 1);
      expect(router.resolveSpawn('a', 'b:c')).toBeUndefined();
      router.registerSpawn('ab', 'c', 2);
      expect(router.resolveSpawn('a', 'bc')).toBeUndefined();
      expect(router.resolveSpawn('a:b', 'c')).toBe(1);
      // Hook payloads are attacker-shaped JSON: a NUL in either half must not alias.
      router.registerSpawn('x\u0000y', 'z', 3);
      expect(router.resolveSpawn('x', 'y\u0000z')).toBeUndefined();
    });

    it('spawn mapping is independent of the root session mapping', () => {
      router.registerSpawn('s1', 'k', 7);
      expect(router.resolve('s1')).toBeUndefined();
      expect(router.hasSession('s1')).toBe(false);
      router.register('s1', 1);
      router.unregister('s1');
      expect(router.resolveSpawn('s1', 'k')).toBe(7);
    });

    it('expires keyed buffered events after HOOK_EVENT_BUFFER_MS', () => {
      router.bufferEvent('claude', { session_id: 's1' }, 'bbb222');
      vi.advanceTimersByTime(HOOK_EVENT_BUFFER_MS + 1);
      router.pruneExpired();
      expect(router.registerSpawn('s1', 'bbb222', 7)).toHaveLength(0);
    });

    it('the periodic prune timer expires keyed events without an explicit call', () => {
      router.bufferEvent('claude', { session_id: 's1' }, 'k');
      vi.advanceTimersByTime(HOOK_EVENT_BUFFER_MS * 2 + 1);
      expect(router.hasBuffered('s1')).toBe(false);
      expect(router.registerSpawn('s1', 'k', 7)).toHaveLength(0);
    });

    it('hasBuffered still reports keyed events for the session', () => {
      router.bufferEvent('claude', { session_id: 's1' }, 'k');
      expect(router.hasBuffered('s1')).toBe(true);
    });

    it('re-registering a (session, agentKey) pair overwrites the agentId (last wins)', () => {
      router.registerSpawn('s1', 'k', 7);
      router.registerSpawn('s1', 'k', 9);
      expect(router.resolveSpawn('s1', 'k')).toBe(9);
    });

    it('an empty agentKey is still a key: it never flushes to the root', () => {
      // Normalizing "" to undefined is the provider's job (T1/T7), not the router's.
      router.bufferEvent('claude', { session_id: 's1' }, '');
      expect(router.register('s1', 1)).toHaveLength(0);
      expect(router.registerSpawn('s1', '', 7)).toHaveLength(1);
    });

    it('unregisterSpawn forgets the node', () => {
      router.registerSpawn('s1', 'k', 7);
      router.unregisterSpawn('s1', 'k');
      expect(router.resolveSpawn('s1', 'k')).toBeUndefined();
    });

    it('hasBufferedRoot only counts events without an agentKey', () => {
      router.bufferEvent('claude', { session_id: 's1' }, 'k');
      expect(router.hasBufferedRoot('s1')).toBe(false);
      expect(router.hasBuffered('s1')).toBe(true);
      router.bufferEvent('claude', { session_id: 's1' });
      expect(router.hasBufferedRoot('s1')).toBe(true);
      expect(router.hasBufferedRoot('s2')).toBe(false);
      router.register('s1', 1);
      expect(router.hasBufferedRoot('s1')).toBe(false);
    });

    it('clearSpawns forgets every spawn of the session and drops its keyed events only', () => {
      router.register('s1', 1);
      router.registerSpawn('s1', 'k1', 7);
      router.registerSpawn('s1', 'k2', 8);
      router.registerSpawn('s2', 'k1', 9);
      router.bufferEvent('claude', { session_id: 's1', hook_event_name: 'K' }, 'k3');
      router.bufferEvent('claude', { session_id: 's1', hook_event_name: 'Root' });
      router.bufferEvent('claude', { session_id: 's2', hook_event_name: 'Other' }, 'k4');

      router.clearSpawns('s1');

      expect(router.resolveSpawn('s1', 'k1')).toBeUndefined();
      expect(router.resolveSpawn('s1', 'k2')).toBeUndefined();
      expect(router.resolveSpawn('s2', 'k1')).toBe(9);
      expect(router.resolve('s1')).toBe(1);
      expect(router.registerSpawn('s1', 'k3', 10)).toHaveLength(0);
      expect(router.hasBufferedRoot('s1')).toBe(true);
      expect(router.registerSpawn('s2', 'k4', 11)).toHaveLength(1);
    });

    it('clearSpawns on an unknown session is a no-op', () => {
      router.bufferEvent('claude', { session_id: 's1' });
      router.clearSpawns('nope');
      expect(router.hasBuffered('s1')).toBe(true);
    });

    it('caps buffered events per (session, agentKey), dropping the oldest', () => {
      for (let i = 0; i < MAX_BUFFERED_HOOK_EVENTS_PER_SPAWN + 5; i++) {
        router.bufferEvent('claude', { session_id: 's1', n: i }, 'k');
      }
      router.bufferEvent('claude', { session_id: 's1', n: 'other' }, 'k2');
      router.bufferEvent('claude', { session_id: 's1', n: 'root' });

      const flushed = router.registerSpawn('s1', 'k', 7);
      expect(flushed).toHaveLength(MAX_BUFFERED_HOOK_EVENTS_PER_SPAWN);
      expect(flushed[0].event.n).toBe(5);
      expect(flushed[flushed.length - 1].event.n).toBe(MAX_BUFFERED_HOOK_EVENTS_PER_SPAWN + 4);
      // Other pairs and the root are untouched by that pair's cap.
      expect(router.registerSpawn('s1', 'k2', 8)).toHaveLength(1);
      expect(router.register('s1', 1)).toHaveLength(1);
    });

    it('the per-spawn cap does not apply across sessions sharing a key', () => {
      for (let i = 0; i < MAX_BUFFERED_HOOK_EVENTS_PER_SPAWN; i++) {
        router.bufferEvent('claude', { session_id: 's1' }, 'k');
        router.bufferEvent('claude', { session_id: 's2' }, 'k');
      }
      expect(router.registerSpawn('s1', 'k', 7)).toHaveLength(MAX_BUFFERED_HOOK_EVENTS_PER_SPAWN);
      expect(router.registerSpawn('s2', 'k', 8)).toHaveLength(MAX_BUFFERED_HOOK_EVENTS_PER_SPAWN);
    });

    it('caps the whole buffer, dropping the oldest events keyed or not', () => {
      router.bufferEvent('claude', { session_id: 'first' }, 'k');
      router.bufferEvent('claude', { session_id: 'second' });
      // Distinct sessions so the per-spawn cap never kicks in.
      for (let i = 0; i < MAX_BUFFERED_HOOK_EVENTS; i++) {
        router.bufferEvent('claude', { session_id: `s${i}` }, i % 2 === 0 ? 'k' : undefined);
      }
      expect(router.hasBuffered('first')).toBe(false);
      expect(router.hasBuffered('second')).toBe(false);
      expect(router.hasBuffered('s0')).toBe(true);
      expect(router.hasBuffered(`s${MAX_BUFFERED_HOOK_EVENTS - 1}`)).toBe(true);
      let total = 0;
      for (let i = 0; i < MAX_BUFFERED_HOOK_EVENTS; i++) {
        total +=
          i % 2 === 0
            ? router.registerSpawn(`s${i}`, 'k', i).length
            : router.register(`s${i}`, i).length;
      }
      expect(total).toBe(MAX_BUFFERED_HOOK_EVENTS);
    });

    it('applies the per-spawn cap before the global one, dropping a single event per arrival', () => {
      const unkeyed = MAX_BUFFERED_HOOK_EVENTS - MAX_BUFFERED_HOOK_EVENTS_PER_SPAWN;
      for (let i = 0; i < unkeyed; i++) router.bufferEvent('claude', { session_id: `x${i}` });
      for (let i = 0; i <= MAX_BUFFERED_HOOK_EVENTS_PER_SPAWN; i++) {
        router.bufferEvent('claude', { session_id: 's1', n: i }, 'k');
      }
      // Full buffer + one over the pair cap: only the pair's oldest goes.
      expect(router.hasBuffered('x0')).toBe(true);
      const flushed = router.registerSpawn('s1', 'k', 7);
      expect(flushed).toHaveLength(MAX_BUFFERED_HOOK_EVENTS_PER_SPAWN);
      expect(flushed[0].event.n).toBe(1);
    });

    it('stops the prune timer when clearSpawns or registerSpawn empties the buffer', () => {
      router.bufferEvent('claude', { session_id: 's1' }, 'k');
      expect(vi.getTimerCount()).toBe(1);
      router.clearSpawns('s1');
      expect(vi.getTimerCount()).toBe(0);

      router.bufferEvent('claude', { session_id: 's1' }, 'k');
      router.bufferEvent('claude', { session_id: 's1' });
      router.clearSpawns('s1');
      expect(vi.getTimerCount()).toBe(1); // root event still waiting
      router.register('s1', 1);
      expect(vi.getTimerCount()).toBe(0);

      router.bufferEvent('claude', { session_id: 's2' }, 'k');
      router.registerSpawn('s2', 'k', 7);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('dispose clears spawn mappings', () => {
      router.registerSpawn('s1', 'k', 7);
      router.bufferEvent('claude', { session_id: 's1' }, 'k2');
      router.dispose();
      expect(router.resolveSpawn('s1', 'k')).toBeUndefined();
      expect(router.registerSpawn('s1', 'k2', 8)).toHaveLength(0);
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────────────

  describe('dispose', () => {
    it('clears all state', () => {
      router.register('sess-1', 1);
      router.storePending('sess-ext', {
        sessionId: 'sess-ext',
        transcriptPath: undefined,
        cwd: '/',
      });
      router.bufferEvent('claude', { session_id: 'sess-2', hook_event_name: 'Stop' });

      router.dispose();

      expect(router.resolve('sess-1')).toBeUndefined();
      expect(router.hasPending('sess-ext')).toBe(false);
      expect(router.hasBuffered('sess-2')).toBe(false);
    });
  });
});
