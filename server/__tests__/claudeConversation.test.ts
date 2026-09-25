/**
 * Claude transcript records → conversations between agents (plan T13): who
 * assigns work (Agent/Task), who reports back (SubagentHandback) and who
 * messages whom (SendMessage). Pure parsing; the ConversationTracker resolves
 * recipients and decides when to emit.
 */
import { describe, expect, it } from 'vitest';

import { CONVERSATION_TEXT_MAX_BYTES, CONVERSATIONS_PER_RECORD_MAX } from '../src/constants.js';
import { parseClaudeConversations } from '../src/providers/hook/claude/claudeConversation.js';

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  uuid: 'u-1',
  timestamp: '2026-09-25T10:00:00.000Z',
  message: { role: 'assistant', content },
  ...extra,
});
const toolUse = (name: string, input: unknown, id = 'toolu_1') => ({
  type: 'tool_use',
  id,
  name,
  input,
});

describe('parseClaudeConversations', () => {
  it('an Agent spawn is an assign carrying its prompt and spawn id', () => {
    const out = parseClaudeConversations(
      assistant([
        toolUse(
          'Agent',
          { description: 'Revisar', subagent_type: 'qa', prompt: 'Revisa el diff' },
          'toolu_A',
        ),
      ]),
    );
    expect(out).toEqual([{ kind: 'assign', text: 'Revisa el diff', spawnToolUseId: 'toolu_A' }]);
  });

  it('a Task spawn (older CLIs) is an assign too', () => {
    const out = parseClaudeConversations(
      assistant([toolUse('Task', { prompt: 'Busca el bug' }, 'toolu_T')]),
    );
    expect(out).toEqual([{ kind: 'assign', text: 'Busca el bug', spawnToolUseId: 'toolu_T' }]);
  });

  it('a spawn without a usable tool id is dropped: nothing could ever emit it', () => {
    expect(parseClaudeConversations(assistant([toolUse('Agent', { prompt: 'x' }, '')]))).toEqual(
      [],
    );
    expect(
      parseClaudeConversations(
        assistant([{ type: 'tool_use', id: 42, name: 'Agent', input: { prompt: 'x' } }]),
      ),
    ).toEqual([]);
    expect(
      parseClaudeConversations(assistant([toolUse('Agent', { prompt: 'x' }, 'a'.repeat(500))])),
    ).toEqual([]);
  });

  it('a SubagentHandback is a report', () => {
    const out = parseClaudeConversations(
      assistant([toolUse('SubagentHandback', { message: '## Hecho\nTodo verde' })]),
    );
    expect(out).toEqual([{ kind: 'report', text: '## Hecho\nTodo verde' }]);
  });

  it('SendMessage with to + message is a message', () => {
    const out = parseClaudeConversations(
      assistant([
        toolUse('SendMessage', {
          to: 'a2f66b77eeed7903f',
          summary: 'Consolidar',
          message: 'Buen trabajo',
        }),
      ]),
    );
    expect(out).toEqual([{ kind: 'message', text: 'Buen trabajo', to: 'a2f66b77eeed7903f' }]);
  });

  it('SendMessage with recipient + content is a message', () => {
    const out = parseClaudeConversations(
      assistant([toolUse('SendMessage', { recipient: 'researcher', content: 'Sigue' })]),
    );
    expect(out).toEqual([{ kind: 'message', text: 'Sigue', to: 'researcher' }]);
  });

  it('SendMessage addressed by agentId (sub-agent to sibling) is a message', () => {
    const out = parseClaudeConversations(
      assistant([
        toolUse('SendMessage', {
          agentId: 'ac69e7b7610039937',
          message: 'Sin conflicto',
          summary: 's',
        }),
      ]),
    );
    expect(out).toEqual([{ kind: 'message', text: 'Sin conflicto', to: 'ac69e7b7610039937' }]);
  });

  it('an object message becomes its text field, or short JSON', () => {
    const [withReason] = parseClaudeConversations(
      assistant([
        toolUse('SendMessage', {
          to: 'researcher',
          message: { type: 'shutdown_request', reason: 'Terminamos' },
        }),
      ]),
    );
    expect(withReason).toEqual({ kind: 'message', text: 'Terminamos', to: 'researcher' });

    const [asJson] = parseClaudeConversations(
      assistant([toolUse('SendMessage', { to: 'x', message: { type: 'ping', n: 1 } })]),
    );
    expect(asJson.text).toBe('{"type":"ping","n":1}');
  });

  it('a SendMessage without a usable recipient still reports, without `to`', () => {
    const [noTo] = parseClaudeConversations(
      assistant([toolUse('SendMessage', { message: 'hola' })]),
    );
    expect(noTo).toEqual({ kind: 'message', text: 'hola' });
    const [numericTo] = parseClaudeConversations(
      assistant([toolUse('SendMessage', { to: 7, message: 'hola' })]),
    );
    expect(numericTo).toEqual({ kind: 'message', text: 'hola' });
    const [hugeTo] = parseClaudeConversations(
      assistant([toolUse('SendMessage', { to: 'n'.repeat(1000), message: 'hola' })]),
    );
    expect(hugeTo).toEqual({ kind: 'message', text: 'hola' });
  });

  it('several calls in one record come out in order', () => {
    const out = parseClaudeConversations(
      assistant([
        { type: 'text', text: 'Reparto el trabajo' },
        toolUse('Agent', { prompt: 'uno' }, 'toolu_1'),
        toolUse('Bash', { command: 'ls' }, 'toolu_2'),
        toolUse('Agent', { prompt: 'dos' }, 'toolu_3'),
      ]),
    );
    expect(out.map((c) => c.spawnToolUseId)).toEqual(['toolu_1', 'toolu_3']);
  });

  it('text is sanitized and capped at a UTF-8 boundary', () => {
    const [clean] = parseClaudeConversations(
      assistant([toolUse('SubagentHandback', { message: '\u001b[31mrojo\u001b[0m\u0007 ok' })]),
    );
    expect(clean.text).toBe('rojo ok');

    const big = 'ñ'.repeat(CONVERSATION_TEXT_MAX_BYTES);
    const [capped] = parseClaudeConversations(
      assistant([toolUse('SubagentHandback', { message: big })]),
    );
    expect(Buffer.byteLength(capped.text, 'utf8')).toBeLessThanOrEqual(CONVERSATION_TEXT_MAX_BYTES);
    expect(capped.text).toBe('ñ'.repeat(CONVERSATION_TEXT_MAX_BYTES / 2));
  });

  it('records it does not understand yield nothing, never throw', () => {
    const junk: unknown[] = [
      null,
      'x',
      42,
      [],
      {},
      { type: 'user', message: { content: [toolUse('SendMessage', { to: 'a', message: 'b' })] } },
      { type: 'assistant' },
      { type: 'assistant', message: null },
      { type: 'assistant', message: { content: 'text only' } },
      { type: 'assistant', message: { content: [null, 1, 'x', { type: 'tool_use' }] } },
      assistant([toolUse('SendMessage', null)]),
      assistant([toolUse('SubagentHandback', 'plain')]),
      assistant([toolUse('Agent', { prompt: 3 }, 'toolu_X')]),
      // A sub-agent's call replayed inside the parent's progress record (Task
      // era) belongs to the sub-agent, not to the parent.
      {
        type: 'progress',
        data: {
          type: 'agent_progress',
          message: assistant([toolUse('SubagentHandback', { message: 'x' })]),
        },
      },
    ];
    for (const r of junk) {
      expect(parseClaudeConversations(r as Record<string, unknown>)).toEqual([]);
    }
  });

  it('prototype-named keys are plain data', () => {
    const record = JSON.parse(
      '{"type":"assistant","uuid":"u","message":{"content":[{"type":"tool_use","id":"t","name":"SendMessage","input":{"to":"__proto__","message":{"__proto__":{"text":"x"},"constructor":"y"}}}]}}',
    ) as Record<string, unknown>;
    const [c] = parseClaudeConversations(record);
    expect(c.to).toBe('__proto__');
    expect(typeof c.text).toBe('string');
    expect(({} as Record<string, unknown>).text).toBeUndefined();
  });

  it('bounds the number of conversations taken from one record', () => {
    const blocks = Array.from({ length: CONVERSATIONS_PER_RECORD_MAX + 50 }, (_, i) =>
      toolUse('SendMessage', { to: 'a', message: `m${i}` }, `toolu_${i}`),
    );
    expect(parseClaudeConversations(assistant(blocks))).toHaveLength(CONVERSATIONS_PER_RECORD_MAX);
  });
});
