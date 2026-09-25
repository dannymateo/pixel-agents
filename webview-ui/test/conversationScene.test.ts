/**
 * The conversation director (spec §4b): a pure state machine that turns
 * `agentConversation` events into scenes — the speaker walks to the listener,
 * talks (typewriter bubble), and walks back. It drives the office through the
 * SceneHost seam only; here a fake host records every call, so the scene rules
 * are pinned without an OfficeState (conversationHost.test.ts covers that half).
 *
 * Run with: npm test
 */

import assert from 'node:assert/strict';

import { test } from 'vitest';

import {
  CONVERSATION_RECENT_IDS_MAX,
  CONVERSATION_STAGE_GRACE_MS,
  CONVERSATION_STARTS_PER_FRAME,
} from '../src/constants.js';
import type { ConversationEvent, SceneHost } from '../src/office/engine/conversationScene.js';
import { ConversationDirector } from '../src/office/engine/conversationScene.js';

const CPS = 80;
const MAX_MS = 15000;
const READ_HOLD_MS = 2000;
const WALK_MAX_MS = 20000;

/** A host whose answers the test sets, and which logs every call. */
class FakeHost implements SceneHost {
  calls: string[] = [];
  stageable = true;
  walkable = true;
  arrived = new Set<number>();
  seated = new Set<number>();
  gone = new Set<number>();

  canStage(fromId: number, toId: number | undefined): boolean {
    this.calls.push(`canStage ${fromId}->${toId}`);
    return this.stageable;
  }
  walkNextTo(fromId: number, toId: number): boolean {
    this.calls.push(`walk ${fromId}->${toId}`);
    return this.walkable;
  }
  hasArrived(fromId: number): boolean {
    return this.arrived.has(fromId);
  }
  faceEachOther(fromId: number, toId: number): void {
    this.calls.push(`face ${fromId}<->${toId}`);
  }
  returnToSeat(fromId: number): void {
    this.calls.push(`return ${fromId}`);
  }
  isSeated(fromId: number): boolean {
    return this.seated.has(fromId);
  }
  showEnvelope(fromId: number): void {
    this.calls.push(`envelope ${fromId}`);
  }
  isPresent(id: number): boolean {
    return !this.gone.has(id);
  }
}

function director(host: SceneHost): ConversationDirector {
  return new ConversationDirector(host, {
    cps: CPS,
    maxMs: MAX_MS,
    readHoldMs: READ_HOLD_MS,
    walkMaxMs: WALK_MAX_MS,
  });
}

function ev(id: string, fromId: number, toId?: number, text?: string): ConversationEvent {
  return { conversationId: id, fromId, toId, kind: 'message', text };
}

/** Enqueue + first update: the scene starts walking. */
function startWalking(d: ConversationDirector, e: ConversationEvent): void {
  d.enqueue(e);
  d.update(0);
}

/** Walk it all the way to `talking`. */
function startTalking(d: ConversationDirector, host: FakeHost, e: ConversationEvent): void {
  startWalking(d, e);
  host.arrived.add(e.fromId);
  d.update(0);
  assert.equal(d.views()[0]?.phase, 'talking', 'precondition: talking');
}

test('a stageable scene walks the speaker next to the listener', () => {
  const host = new FakeHost();
  const d = director(host);
  d.enqueue(ev('c1', 1, 2, 'hola'));
  assert.equal(d.views().length, 0, 'queued scenes are not rendered');
  d.update(0);
  assert.deepEqual(host.calls, ['canStage 1->2', 'walk 1->2']);
  const [v] = d.views();
  assert.equal(v.phase, 'walking');
  assert.equal(v.visibleText, '', 'nothing is said while walking');
  assert.equal(d.isBusy(1), true, 'the speaker is busy');
  assert.equal(d.isBusy(2), true, 'the listener is busy');
  assert.equal(d.isBusy(3), false);
});

test('arriving turns both to face each other and starts talking', () => {
  const host = new FakeHost();
  const d = director(host);
  startWalking(d, ev('c1', 1, 2, 'hola'));
  d.update(0.1);
  assert.equal(d.views()[0].phase, 'walking', 'still on the way');
  host.arrived.add(1);
  d.update(0.1);
  assert.equal(d.views()[0].phase, 'talking');
  assert.ok(host.calls.includes('face 1<->2'));
});

test('FIFO per speaker: the second scene waits until the first is done', () => {
  const host = new FakeHost();
  const d = director(host);
  d.enqueue(ev('c1', 1, 2, 'a'));
  d.enqueue(ev('c2', 1, 3, 'b'));
  d.update(0);
  assert.deepEqual(
    d.views().map((v) => v.conversationId),
    ['c1'],
    'only the first scene of the speaker runs',
  );
  // Finish c1: arrive, talk it out, walk back, sit.
  host.arrived.add(1);
  d.update(0);
  d.skip('c1');
  d.skip('c1'); // second click on a complete bubble ends the talk
  assert.equal(d.views()[0].phase, 'returning');
  assert.ok(!host.calls.includes('walk 1->3'), 'c2 does not start while c1 is returning');
  host.seated.add(1);
  host.arrived.delete(1);
  d.update(0);
  assert.equal(
    d.views().find((v) => v.conversationId === 'c1'),
    undefined,
    'c1 is done',
  );
  d.update(0);
  assert.deepEqual(
    d.views().map((v) => [v.conversationId, v.phase]),
    [['c2', 'walking']],
  );
  assert.ok(host.calls.includes('walk 1->3'));
});

test('a busy listener holds back a scene aimed at it; other speakers run in parallel', () => {
  const host = new FakeHost();
  const d = director(host);
  d.enqueue(ev('c1', 1, 2, 'a'));
  d.enqueue(ev('c2', 3, 1, 'b')); // 1 is busy speaking
  d.enqueue(ev('c3', 4, 5, 'c'));
  d.update(0);
  assert.deepEqual(
    d
      .views()
      .map((v) => v.conversationId)
      .sort(),
    ['c1', 'c3'],
  );
  assert.equal(d.isBusy(3), false, 'queued scenes do not make anyone busy');
});

test('canStage=false: retried for the grace period, then the envelope, never a walk', () => {
  const host = new FakeHost();
  host.stageable = false;
  const d = director(host);
  d.enqueue(ev('c1', 1, 2, 'hola'));
  d.update(0);
  d.update((CONVERSATION_STAGE_GRACE_MS - 100) / 1000);
  assert.ok(!host.calls.includes('envelope 1'), 'still waiting for the listener to arrive');
  d.update(0.2);
  assert.ok(host.calls.includes('envelope 1'));
  assert.ok(!host.calls.some((c) => c.startsWith('walk')));
  assert.equal(d.views().length, 0);
  assert.equal(d.isBusy(1), false);
});

test('a listener that arrives within the grace period gets the walk (assign racing the child)', () => {
  const host = new FakeHost();
  host.stageable = false;
  const d = director(host);
  d.enqueue(ev('c1', 1, 2, 'hola'));
  d.update(0.5);
  host.stageable = true;
  d.update(0.05);
  assert.ok(host.calls.includes('walk 1->2'));
  assert.ok(!host.calls.includes('envelope 1'));
  assert.equal(d.views()[0].phase, 'walking');
});

test('no toId (unresolved recipient) shows the envelope', () => {
  const host = new FakeHost();
  const d = director(host);
  d.enqueue(ev('c1', 1, undefined, 'hola'));
  d.update(0);
  assert.ok(host.calls.includes('envelope 1'));
  assert.ok(!host.calls.some((c) => c.startsWith('walk')));
  assert.equal(d.views().length, 0);
});

test('talking to oneself is not staged (envelope)', () => {
  const host = new FakeHost();
  const d = director(host);
  d.enqueue(ev('c1', 1, 1, 'hola'));
  d.update(0);
  assert.ok(host.calls.includes('envelope 1'));
  assert.ok(!host.calls.some((c) => c.startsWith('walk')));
});

test('walkNextTo=false (no path) shows the envelope', () => {
  const host = new FakeHost();
  host.walkable = false;
  const d = director(host);
  d.enqueue(ev('c1', 1, 2, 'hola'));
  d.update(0);
  assert.deepEqual(host.calls, ['canStage 1->2', 'walk 1->2', 'envelope 1']);
  assert.equal(d.views().length, 0);
  assert.equal(d.isBusy(1), false);
});

test('typewriter: after 0.5 s at 80 cps, 40 characters are visible', () => {
  const host = new FakeHost();
  const d = director(host);
  const text = 'x'.repeat(200);
  startTalking(d, host, ev('c1', 1, 2, text));
  d.update(0.5);
  const [v] = d.views();
  assert.equal(v.visibleText.length, 40);
  assert.equal(v.complete, false);
});

test('typewriter counts code points: an emoji is never split in half', () => {
  const host = new FakeHost();
  const d = director(host);
  startTalking(d, host, ev('c1', 1, 2, '😀😀😀😀'));
  d.update(1 / CPS); // exactly one character
  assert.equal(d.views()[0].visibleText, '😀');
});

test('skip reveals the whole text at once; a second skip ends the talk', () => {
  const host = new FakeHost();
  const d = director(host);
  const text = 'y'.repeat(500);
  startTalking(d, host, ev('c1', 1, 2, text));
  d.update(0.1);
  d.skip('c1');
  let [v] = d.views();
  assert.equal(v.complete, true);
  assert.equal(v.visibleText, text);
  assert.equal(v.phase, 'talking', 'the first click only reveals');
  d.skip('c1');
  [v] = d.views();
  assert.equal(v.phase, 'returning');
  assert.ok(host.calls.includes('return 1'));
});

test('skip while walking shows the full text as soon as it talks; unknown ids are ignored', () => {
  const host = new FakeHost();
  const d = director(host);
  startWalking(d, ev('c1', 1, 2, 'hola mundo'));
  d.skip('nope');
  d.skip('c1');
  host.arrived.add(1);
  d.update(0);
  const [v] = d.views();
  assert.equal(v.phase, 'talking');
  assert.equal(v.visibleText, 'hola mundo');
  assert.equal(v.complete, true);
});

test('a text that finishes typing lingers READ_HOLD_MS, then the speaker walks back', () => {
  const host = new FakeHost();
  const d = director(host);
  startTalking(d, host, ev('c1', 1, 2, 'hola')); // 4 chars = 50 ms
  d.update(0.1);
  assert.equal(d.views()[0].complete, true);
  assert.equal(d.views()[0].truncated, false);
  d.update((READ_HOLD_MS - 200) / 1000);
  assert.equal(d.views()[0].phase, 'talking', 'still lingering');
  d.update(0.2);
  assert.equal(d.views()[0].phase, 'returning');
  assert.ok(host.calls.includes('return 1'));
});

test('past maxMs in talking: complete, marked truncated ("…ver completo"), walks back', () => {
  const host = new FakeHost();
  const d = director(host);
  const text = 'z'.repeat(1900); // 1900 chars at 80 cps = 23.75 s > 15 s
  startTalking(d, host, ev('c1', 1, 2, text));
  for (let i = 0; i < 149; i++) d.update(0.1);
  assert.equal(d.views()[0].phase, 'talking', 'just under the cap');
  d.update(0.2);
  const [v] = d.views();
  assert.equal(v.phase, 'returning');
  assert.equal(v.complete, true);
  assert.equal(v.truncated, true, 'cut by the cap: the bubble offers the full screen');
  assert.equal(v.visibleText, text, 'the whole text is revealed');
});

test('returning ends (done) once the speaker is seated', () => {
  const host = new FakeHost();
  const d = director(host);
  startTalking(d, host, ev('c1', 1, 2, 'a'));
  d.skip('c1');
  d.skip('c1');
  d.update(1);
  assert.equal(d.views()[0].phase, 'returning', 'not seated yet');
  host.seated.add(1);
  d.update(0);
  assert.equal(d.views().length, 0);
  assert.equal(d.isBusy(1), false);
  assert.equal(d.isBusy(2), false);
});

test('a walk or a return that never finishes is capped by walkMaxMs', () => {
  const host = new FakeHost();
  const d = director(host);
  startWalking(d, ev('c1', 1, 2, 'a'));
  d.update(WALK_MAX_MS / 1000 + 0.01);
  assert.equal(d.views()[0].phase, 'talking', 'talks where it stands');
  d.skip('c1');
  d.skip('c1');
  d.update(WALK_MAX_MS / 1000 + 0.01);
  assert.equal(d.views().length, 0, 'a return that never seats still ends');
});

test('no text: the bubble shows "…" at once', () => {
  const host = new FakeHost();
  const d = director(host);
  startTalking(d, host, ev('c1', 1, 2));
  const [v] = d.views();
  assert.equal(v.visibleText, '…');
  assert.equal(v.complete, true);
  assert.equal(v.truncated, false, 'nothing more to see');
});

test('an empty text is treated like no text', () => {
  const host = new FakeHost();
  const d = director(host);
  startTalking(d, host, ev('c1', 1, 2, ''));
  assert.equal(d.views()[0].visibleText, '…');
});

test('a huge text is capped at CONVERSATION_TEXT_MAX_CHARS and marked truncated', () => {
  const host = new FakeHost();
  const d = new ConversationDirector(host, { cps: CPS, maxMs: MAX_MS, textMaxChars: 10 });
  startTalking(d, host, ev('c1', 1, 2, 'a'.repeat(100_000)));
  d.skip('c1');
  const [v] = d.views();
  assert.equal(v.visibleText, 'a'.repeat(10));
  assert.equal(v.truncated, true);
});

test('the speaker removed mid-scene: the scene ends clean, no host calls on it', () => {
  const host = new FakeHost();
  const d = director(host);
  startTalking(d, host, ev('c1', 1, 2, 'hola'));
  host.calls = [];
  host.gone.add(1);
  d.update(0.1);
  assert.equal(d.views().length, 0);
  assert.deepEqual(host.calls, [], 'nothing asked of a character that is gone');
  assert.equal(d.isBusy(2), false);
});

test('the listener removed mid-walk: the speaker walks back', () => {
  const host = new FakeHost();
  const d = director(host);
  startWalking(d, ev('c1', 1, 2, 'hola'));
  host.gone.add(2);
  d.update(0.1);
  assert.equal(d.views()[0].phase, 'returning');
  assert.ok(host.calls.includes('return 1'));
});

test('duplicate conversationIds are ignored', () => {
  const host = new FakeHost();
  const d = director(host);
  d.enqueue(ev('c1', 1, 2, 'a'));
  d.enqueue(ev('c1', 1, 2, 'a'));
  d.update(0);
  assert.equal(host.calls.filter((c) => c.startsWith('walk')).length, 1);
  // Still ignored while it runs.
  d.enqueue(ev('c1', 1, 2, 'a'));
  host.arrived.add(1);
  d.update(0);
  d.skip('c1');
  d.skip('c1');
  host.seated.add(1);
  d.update(0);
  d.update(0);
  assert.equal(d.views().length, 0, 'the duplicate never replays');
});

test('malformed events are dropped', () => {
  const host = new FakeHost();
  const d = director(host);
  const bad: unknown[] = [
    { conversationId: '', fromId: 1, toId: 2, kind: 'message' },
    { conversationId: 'x'.repeat(10_000), fromId: 1, toId: 2, kind: 'message' },
    { conversationId: 'a', fromId: 1.5, toId: 2, kind: 'message' },
    { conversationId: 'b', fromId: Number.NaN, toId: 2, kind: 'message' },
    { conversationId: 'c', fromId: 1, toId: 2, kind: 'shout' },
    { conversationId: 'd', fromId: 1, toId: '2', kind: 'message' },
    { conversationId: 'e', fromId: 1, toId: 2, kind: 'message', text: 42 },
    { conversationId: 7, fromId: 1, toId: 2, kind: 'message' },
    { conversationId: 'f', fromId: 0, toId: 2, kind: 'message' },
    { conversationId: 'g', fromId: -3, toId: 2, kind: 'message' },
    { conversationId: 'h', fromId: 1, toId: -1, kind: 'message' },
  ];
  for (const b of bad) d.enqueue(b as ConversationEvent);
  d.update(0);
  assert.deepEqual(host.calls, []);
});

test('the queue is bounded per speaker: the oldest waiting scenes are dropped', () => {
  const host = new FakeHost();
  const d = new ConversationDirector(host, { cps: CPS, maxMs: MAX_MS, queueMaxPerAgent: 2 });
  d.enqueue(ev('c0', 1, 2, 'a')); // runs
  d.update(0);
  for (let i = 1; i <= 5; i++) d.enqueue(ev(`c${i}`, 1, 2, 'a'));
  // Finish c0, then see which waiting scene comes next.
  host.arrived.add(1);
  d.update(0);
  d.skip('c0');
  d.skip('c0');
  host.seated.add(1);
  d.update(0);
  d.update(0);
  assert.deepEqual(
    d.views().map((v) => v.conversationId),
    ['c4'],
    'only the two newest waiting scenes (c4, c5) survived',
  );
});

test('the queue is bounded in total', () => {
  const host = new FakeHost();
  host.walkable = false; // every scene that starts ends at once (envelope)
  const d = new ConversationDirector(host, { cps: CPS, maxMs: MAX_MS, queueMaxTotal: 3 });
  for (let i = 0; i < 10; i++) d.enqueue(ev(`c${i}`, 100 + i, 200 + i, 'a'));
  for (let i = 0; i < 5; i++) d.update(0);
  assert.deepEqual(
    host.calls.filter((c) => c.startsWith('envelope')),
    ['envelope 107', 'envelope 108', 'envelope 109'],
  );
});

test('clear() drops everything and releases the walkers; nothing replays', () => {
  const host = new FakeHost();
  const d = director(host);
  startWalking(d, ev('c1', 1, 2, 'a'));
  d.enqueue(ev('c2', 1, 3, 'b'));
  d.enqueue(ev('c3', 4, 5, 'c'));
  d.clear();
  assert.ok(host.calls.includes('return 1'), 'the walking speaker is sent back');
  assert.equal(d.views().length, 0);
  assert.equal(d.isBusy(1), false);
  host.calls = [];
  d.update(1);
  assert.deepEqual(host.calls, [], 'nothing queued survives');
});

test('views() is a snapshot: mutating it does not touch the director', () => {
  const host = new FakeHost();
  const d = director(host);
  startWalking(d, ev('c1', 1, 2, 'a'));
  const v = d.views();
  v[0].phase = 'done';
  v.length = 0;
  assert.equal(d.views()[0].phase, 'walking');
});

test('bad dt values do not corrupt timing', () => {
  const host = new FakeHost();
  const d = director(host);
  startTalking(d, host, ev('c1', 1, 2, 'x'.repeat(100)));
  d.update(Number.NaN);
  d.update(-5);
  d.update(Number.POSITIVE_INFINITY);
  assert.equal(d.views()[0].visibleText.length, 0);
});

test('kind and ids are carried to the view', () => {
  const host = new FakeHost();
  const d = director(host);
  d.enqueue({ conversationId: 'c1', fromId: 7, toId: 9, kind: 'assign', text: 'go' });
  d.update(0);
  const [v] = d.views();
  assert.equal(v.kind, 'assign');
  assert.equal(v.fromId, 7);
  assert.equal(v.toId, 9);
});

test('the total bound evicts from the speaker with the most waiting scenes', () => {
  const host = new FakeHost();
  const d = new ConversationDirector(host, { cps: CPS, maxMs: MAX_MS, queueMaxTotal: 4 });
  d.enqueue(ev('busy', 1, 2, 'a'));
  d.update(0); // 1 is now busy: its later scenes wait
  d.enqueue(ev('x1', 1, 2, 'a'));
  d.enqueue(ev('y1', 5, 6, 'a'));
  d.enqueue(ev('x2', 1, 2, 'a'));
  d.enqueue(ev('x3', 1, 2, 'a'));
  d.enqueue(ev('x4', 1, 2, 'a')); // 5 waiting > 4: one of speaker 1's goes
  d.update(0);
  assert.ok(host.calls.includes('walk 5->6'), 'the other speaker kept its scene');
});

test('only a few scenes start per frame (each start is a path search)', () => {
  const host = new FakeHost();
  const d = director(host);
  for (let i = 0; i < 10; i++) d.enqueue(ev(`c${i}`, 10 + i, 30 + i, 'a'));
  d.update(0);
  assert.equal(d.views().length, CONVERSATION_STARTS_PER_FRAME);
  d.update(0);
  assert.equal(d.views().length, CONVERSATION_STARTS_PER_FRAME * 2);
});

test('a speaker walking back no longer holds its listener', () => {
  const host = new FakeHost();
  const d = director(host);
  startTalking(d, host, ev('c1', 1, 2, 'a'));
  d.enqueue(ev('c2', 3, 2, 'b'));
  d.update(0);
  assert.ok(!host.calls.includes('walk 3->2'), 'waits while 1 talks to 2');
  d.skip('c1');
  d.skip('c1'); // 1 walks back
  assert.equal(d.isBusy(2), false, 'the listener is free');
  assert.equal(d.isBusy(1), true, 'the speaker is still walking back');
  d.update(0);
  assert.ok(host.calls.includes('walk 3->2'));
});

test('a finished conversationId never replays; the memory is bounded', () => {
  const host = new FakeHost();
  host.walkable = false; // ends at once with the envelope
  const d = director(host);
  for (let i = 0; i < 5; i++) {
    d.enqueue(ev('same', 1, 2, 'a'));
    d.update(0);
  }
  assert.equal(host.calls.filter((c) => c === 'envelope 1').length, 1);
  // Past the cap the oldest ids are forgotten (and may play again).
  for (let i = 0; i < CONVERSATION_RECENT_IDS_MAX; i++) {
    d.enqueue(ev(`n${i}`, 100 + (i % 50), 2, 'a'));
    d.update(0);
    d.update(0);
  }
  d.enqueue(ev('same', 1, 2, 'a'));
  d.update(0);
  assert.equal(host.calls.filter((c) => c === 'envelope 1').length, 2);
});

test('clear() remembers what it dropped: a resend after reconnecting does not replay', () => {
  const host = new FakeHost();
  const d = director(host);
  startWalking(d, ev('c1', 1, 2, 'a'));
  d.clear();
  host.calls = [];
  d.enqueue(ev('c1', 1, 2, 'a'));
  d.update(0);
  assert.deepEqual(host.calls, []);
});

test('bad options fall back to the defaults: no scene can talk forever', () => {
  const host = new FakeHost();
  const d = new ConversationDirector(host, {
    cps: 1e-9,
    maxMs: Number.NaN,
    readHoldMs: -1,
    walkMaxMs: Number.POSITIVE_INFINITY,
  });
  startTalking(d, host, ev('c1', 1, 2, 'x'.repeat(100)));
  for (let i = 0; i < 200; i++) d.update(0.1); // 20 s: past the default maxMs
  assert.equal(d.views()[0]?.phase, 'returning', 'the talk ended');
  for (let i = 0; i < 250; i++) d.update(0.1); // past the default walkMaxMs
  assert.equal(d.views().length, 0, 'and so did the walk back');
});

test('zero-width / whitespace-only text is treated as no text', () => {
  const host = new FakeHost();
  const d = director(host);
  startTalking(d, host, ev('c1', 1, 2, '\u200B'.repeat(70_000) + '  \n\u2060'));
  const [v] = d.views();
  assert.equal(v.visibleText, '…');
  assert.equal(v.complete, true);
});

test('control characters and bidi overrides are stripped; tabs and newlines kept', () => {
  const host = new FakeHost();
  const d = director(host);
  startTalking(d, host, ev('c1', 1, 2, 'a\u202Eb\u0007c\u001B[31md\u2066e\n\tf\u009B'));
  d.skip('c1');
  assert.equal(d.views()[0].visibleText, 'abc[31mde\n\tf');
});

test('combining-mark runs ("Zalgo") are cut to a few marks per character', () => {
  const host = new FakeHost();
  const d = director(host);
  startTalking(d, host, ev('c1', 1, 2, 'a' + '\u0301'.repeat(500) + 'b'));
  d.skip('c1');
  const text = d.views()[0].visibleText;
  assert.ok(text.length <= 6, `cut: ${text.length}`);
  assert.ok(text.startsWith('a\u0301') && text.endsWith('b'));
});

test('the typewriter never splits an emoji sequence', () => {
  const host = new FakeHost();
  const d = director(host);
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
  startTalking(d, host, ev('c1', 1, 2, family + family));
  d.update(1 / CPS);
  assert.equal(d.views()[0].visibleText, family);
});

test('showBubble: hidden while walking, shown while talking', () => {
  const host = new FakeHost();
  const d = director(host);
  startWalking(d, ev('c1', 1, 2, 'hola'));
  assert.equal(d.views()[0].showBubble, false);
  host.arrived.add(1);
  d.update(0);
  assert.equal(d.views()[0].showBubble, true);
  d.skip('c1');
  d.skip('c1');
  assert.equal(d.views()[0].phase, 'returning');
  assert.equal(d.views()[0].showBubble, false, 'a complete text closes with the talk');
});

test('a cut-short bubble lingers readHoldMs while walking back, and a click closes it', () => {
  const host = new FakeHost();
  const d = director(host);
  startTalking(d, host, ev('c1', 1, 2, 'z'.repeat(1900)));
  d.update(MAX_MS / 1000 + 0.1);
  let [v] = d.views();
  assert.equal(v.phase, 'returning');
  assert.equal(v.showBubble, true, '"…ver completo" stays clickable');
  host.seated.add(1);
  d.update(0.1);
  assert.equal(d.views().length, 1, 'seated at once, but the link lingers');
  d.update(READ_HOLD_MS / 1000);
  assert.equal(d.views().length, 0, 'gone after the linger');

  const d2 = director(host);
  host.seated.delete(1);
  startTalking(d2, host, ev('c2', 1, 2, 'z'.repeat(1900)));
  d2.update(MAX_MS / 1000 + 0.1);
  d2.skip('c2');
  [v] = d2.views();
  assert.equal(v.showBubble, false, 'clicked closed');
  host.seated.add(1);
  d2.update(0);
  assert.equal(d2.views().length, 0, 'no linger once closed');
});

test('a text cut by the work budget never ends in half an emoji', () => {
  const host = new FakeHost();
  const d = director(host);
  const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
  startTalking(d, host, ev('c1', 1, 2, 'ab' + family.repeat(2000)));
  d.skip('c1');
  const text = d.views()[0].visibleText;
  assert.ok(!/[\uD800-\uDBFF]$/.test(text), 'no lone high surrogate at the end');
  assert.ok(text.endsWith(family), 'ends on a whole grapheme');
  assert.equal(d.views()[0].truncated, true);
});
