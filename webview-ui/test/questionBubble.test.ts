/**
 * Spec §3 "Personaje": a question (AskUserQuestion) marks the character with
 * the permission-style bubble carrying a "?", until the question's tool is
 * done, the tools clear, or the sub-agent is cleared.
 */
import { expect, test } from 'vitest';

import { isQuestionToolStart } from '../src/office/attention.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import { QuestionBubbles } from '../src/office/questionBubbles.js';
import {
  BUBBLE_PERMISSION_SPRITE,
  BUBBLE_QUESTION_SPRITE,
} from '../src/office/sprites/spriteData.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

function floorLayout(cols = 9, rows = 7): OfficeLayout {
  return {
    version: 1,
    cols,
    rows,
    tiles: new Array<TileType>(cols * rows).fill(TileType.FLOOR_1),
    furniture: [],
  };
}

test('isQuestionToolStart: by tool name, or by the status a sub-agent question carries', () => {
  expect(
    isQuestionToolStart({
      type: 'agentToolStart',
      id: 1,
      toolId: 'q',
      toolName: 'AskUserQuestion',
    }),
  ).toBe(true);
  expect(
    isQuestionToolStart({
      type: 'subagentToolStart',
      id: 1,
      parentToolId: 'p',
      toolId: 'q',
      status: 'Waiting for your answer',
    }),
  ).toBe(true);
  expect(
    isQuestionToolStart({ type: 'agentToolStart', id: 1, toolId: 'r', toolName: 'Read' }),
  ).toBe(false);
  expect(isQuestionToolStart({ type: 'agentToolDone', id: 1, toolId: 'q' })).toBe(false);
  expect(isQuestionToolStart({ type: 'agentToolStart', id: 1, toolName: 'AskUserQuestion' })).toBe(
    false,
  );
});

test('QuestionBubbles: shown per new question, cleared when the last one closes', () => {
  const qb = new QuestionBubbles();
  expect(qb.start(1, 'q1')).toBe(true);
  expect(qb.start(1, 'q1')).toBe(false); // a replay of the same start: no second chime
  expect(qb.start(1, 'q2')).toBe(true);
  expect(qb.done(1, 'q1')).toBe(false);
  expect(qb.has(1)).toBe(true);
  expect(qb.done(1, 'other')).toBe(false);
  expect(qb.done(1, 'q2')).toBe(true);
  expect(qb.has(1)).toBe(false);
});

test('QuestionBubbles: clear forgets every open question of a character', () => {
  const qb = new QuestionBubbles();
  qb.start(-1, 'q1');
  expect(qb.clear(-1)).toBe(true);
  expect(qb.has(-1)).toBe(false);
  expect(qb.clear(-1)).toBe(false);
  expect(qb.done(-1, 'q1')).toBe(false);
});

test('QuestionBubbles: reset (reconnect) returns who had questions, so the replay re-shows them', () => {
  const qb = new QuestionBubbles();
  qb.start(1, 'q1');
  qb.start(-2, 'q2');
  expect(qb.reset().sort()).toEqual([-2, 1]);
  expect(qb.has(1)).toBe(false);
  expect(qb.start(1, 'q1')).toBe(true);
});

test('the question bubble is its own sprite: permission shape with a "?"', () => {
  expect(BUBBLE_QUESTION_SPRITE.length).toBe(BUBBLE_PERMISSION_SPRITE.length);
  expect(BUBBLE_QUESTION_SPRITE[0].length).toBe(BUBBLE_PERMISSION_SPRITE[0].length);
  expect(BUBBLE_QUESTION_SPRITE).not.toEqual(BUBBLE_PERMISSION_SPRITE);
  // Same frame and tail as the permission bubble.
  expect(BUBBLE_QUESTION_SPRITE[0]).toEqual(BUBBLE_PERMISSION_SPRITE[0]);
  expect(BUBBLE_QUESTION_SPRITE.slice(9)).toEqual(BUBBLE_PERMISSION_SPRITE.slice(9));
});

test('OfficeState: question bubble shows, clears, and never displaces a permission', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, 0, 0);
  const ch = os.characters.get(1)!;

  os.showQuestionBubble(1);
  expect(ch.bubbleType).toBe('question');
  // A turn ending while the question is open does not hide it.
  os.showWaitingBubble(1);
  expect(ch.bubbleType).toBe('question');
  // Clearing a permission leaves a question alone.
  os.clearPermissionBubble(1);
  expect(ch.bubbleType).toBe('question');
  os.clearQuestionBubble(1);
  expect(ch.bubbleType).toBeNull();

  os.showPermissionBubble(1);
  os.showQuestionBubble(1);
  expect(ch.bubbleType).toBe('permission');
  os.clearQuestionBubble(1);
  expect(ch.bubbleType).toBe('permission');
});

test('OfficeState: clicking a question bubble dismisses it like a permission', () => {
  const os = new OfficeState(floorLayout());
  os.addAgent(1, 0, 0);
  os.showQuestionBubble(1);
  os.dismissBubble(1);
  expect(os.characters.get(1)!.bubbleType).toBeNull();
});
