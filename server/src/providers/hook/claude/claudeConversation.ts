import { CONVERSATION_TEXT_MAX_BYTES, CONVERSATIONS_PER_RECORD_MAX } from '../../../constants.js';
import { sanitizeFeedText, truncateUtf8 } from '../../../feedDiff.js';
import { IDENTIFIER_MAX_CHARS } from './constants.js';

/**
 * Claude transcript records → conversations between agents (plan T13). Pure:
 * one JSONL record of the agent that WROTE it in, zero or more conversations
 * out. The host (ConversationTracker) resolves `to` inside the sender's tree
 * and decides when each one becomes a scene.
 *
 * - `Agent`/`Task` tool_use → `assign` (text = `input.prompt`, keyed by the
 *   call id so the host can emit it when the child materializes);
 * - `SubagentHandback` tool_use → `report` (text = `input.message`);
 * - `SendMessage` tool_use → `message` (`to`/`recipient`/`agentId`, text =
 *   `input.message`/`input.content`, a string or an object).
 *
 * Only `assistant` records count: a Task-era parent carries its sub-agent's
 * calls inside `progress` records, and those belong to the sub-agent. Text is
 * transcript content — sanitized and capped here, still plain text for the UI.
 */

export interface ClaudeConversation {
  kind: 'assign' | 'report' | 'message';
  text: string;
  to?: string;
  spawnToolUseId?: string;
}

/** Raw text examined before sanitizing: sanitizing only shrinks, so twice the
 *  cap leaves room for escape codes while bounding the work per field. */
const CONVERSATION_SCAN_BYTES = CONVERSATION_TEXT_MAX_BYTES * 2;

/** Fields tried, in order, when a message is an object instead of a string. */
const OBJECT_TEXT_FIELDS = ['text', 'message', 'content', 'reason', 'summary'] as const;

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Own property only: a key like `constructor` must never read the prototype. */
function ownValue(o: Obj, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined;
}

/** Own string property only: a key like `constructor` must never read the prototype. */
function ownString(o: Obj, key: string): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(o, key)) return undefined;
  const v = o[key];
  return typeof v === 'string' ? v : undefined;
}

/** A short identifier (tool id, agent key or name), or undefined. */
function identifier(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= IDENTIFIER_MAX_CHARS ? v : undefined;
}

function cleanText(raw: string): string {
  return truncateUtf8(
    sanitizeFeedText(truncateUtf8(raw, CONVERSATION_SCAN_BYTES)),
    CONVERSATION_TEXT_MAX_BYTES,
  );
}

/** A message payload as text: the string itself, an object's text field, or
 *  (last resort) the object as short JSON. Anything else is no text. */
function payloadText(v: unknown): string {
  if (typeof v === 'string') return cleanText(v);
  if (isObj(v)) {
    for (const key of OBJECT_TEXT_FIELDS) {
      const s = ownString(v, key);
      if (s) return cleanText(s);
    }
    let json: string;
    try {
      json = JSON.stringify(v);
    } catch {
      return '';
    }
    return cleanText(json);
  }
  return '';
}

function fromToolUse(block: Obj): ClaudeConversation | undefined {
  if (block.type !== 'tool_use' || !isObj(block.input)) return undefined;
  const input = block.input;
  switch (block.name) {
    case 'Agent':
    case 'Task': {
      const spawnToolUseId = identifier(block.id);
      const prompt = ownString(input, 'prompt');
      if (!spawnToolUseId || prompt === undefined) return undefined;
      return { kind: 'assign', text: cleanText(prompt), spawnToolUseId };
    }
    case 'SubagentHandback':
      return { kind: 'report', text: payloadText(ownValue(input, 'message')) };
    case 'SendMessage': {
      const to = identifier(
        ownString(input, 'to') ?? ownString(input, 'recipient') ?? ownString(input, 'agentId'),
      );
      const text = payloadText(ownValue(input, 'message') ?? ownValue(input, 'content'));
      return to === undefined ? { kind: 'message', text } : { kind: 'message', text, to };
    }
    default:
      return undefined;
  }
}

export function parseClaudeConversations(record: Record<string, unknown>): ClaudeConversation[] {
  if (!isObj(record) || record.type !== 'assistant') return [];
  const message = record.message;
  if (!isObj(message) || !Array.isArray(message.content)) return [];
  const out: ClaudeConversation[] = [];
  for (const block of message.content) {
    if (out.length >= CONVERSATIONS_PER_RECORD_MAX) break;
    if (!isObj(block)) continue;
    const c = fromToolUse(block);
    if (c) out.push(c);
  }
  return out;
}
