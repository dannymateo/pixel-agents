import { describe, expect, it } from 'vitest';

import { claudeProvider } from '../src/providers/hook/claude/claude.js';

describe('claudeProvider', () => {
  describe('identity', () => {
    it('has kind "hook"', () => {
      expect(claudeProvider.kind).toBe('hook');
    });
    it('has id "claude"', () => {
      expect(claudeProvider.id).toBe('claude');
    });
    it('has a displayName', () => {
      expect(claudeProvider.displayName).toBe('Claude Code');
    });
    it('has Task and Agent in subagentToolNames', () => {
      expect(claudeProvider.subagentToolNames.has('Task')).toBe(true);
      expect(claudeProvider.subagentToolNames.has('Agent')).toBe(true);
    });
    it('has reading tools Read/Grep/Glob/WebFetch/WebSearch', () => {
      for (const tool of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']) {
        expect(claudeProvider.readingTools.has(tool)).toBe(true);
      }
      expect(claudeProvider.readingTools.has('Edit')).toBe(false);
    });
    it('has protocolVersion 1', () => {
      expect(claudeProvider.protocolVersion).toBe(1);
    });
    it('has a linked TeamProvider', () => {
      expect(claudeProvider.team).toBeDefined();
      expect(claudeProvider.team?.providerId).toBe('claude');
    });
  });

  describe('normalizeHookEvent agentKey (spawned-agent events)', () => {
    it('carries agent_id as agentKey for events fired inside a subagent', () => {
      const r = claudeProvider.normalizeHookEvent({
        hook_event_name: 'PreToolUse',
        session_id: 's1',
        agent_id: 'bbb222',
        agent_type: 'desarrollador',
        tool_name: 'Read',
        tool_input: { file_path: '/x.ts' },
      });
      expect(r?.sessionId).toBe('s1');
      expect(r?.agentKey).toBe('bbb222');
      expect(r?.event.kind).toBe('toolStart');
    });

    it('omits agentKey for the session own events', () => {
      const r = claudeProvider.normalizeHookEvent({ hook_event_name: 'Stop', session_id: 's1' });
      expect(r).not.toBeNull();
      expect(r?.agentKey).toBeUndefined();
      expect(r && 'agentKey' in r).toBe(false);
    });

    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['number', 42],
      ['null', null],
      ['object', { id: 'bbb222' }],
      ['array', ['bbb222']],
      ['boolean', true],
      ['oversized (129 chars)', 'a'.repeat(129)],
      ['path traversal', '../bbb222'],
      ['path separator', 'a/b'],
      ['backslash', 'a\\b'],
      ['inner space', 'a b'],
      ['team-style id', 'dev@session-1234abcd'],
      ['dot', 'a.b'],
      ['non-ASCII', 'agénte'],
      ['control char', 'a\u0000b'],
    ])('drops the event when agent_id is present but unusable (%s)', (_label, id) => {
      // It fired inside SOME spawned agent: falling back to the session's root
      // would animate the wrong character, so the event is discarded.
      for (const hook_event_name of ['Stop', 'PreToolUse', 'SessionEnd']) {
        expect(
          claudeProvider.normalizeHookEvent({
            hook_event_name,
            session_id: 's1',
            agent_id: id,
          }),
        ).toBeNull();
      }
    });

    it('treats an explicitly undefined agent_id as absent', () => {
      const r = claudeProvider.normalizeHookEvent({
        hook_event_name: 'Stop',
        session_id: 's1',
        agent_id: undefined,
      });
      expect(r?.event.kind).toBe('turnEnd');
      expect(r && 'agentKey' in r).toBe(false);
    });

    it.each([
      ['surrounding whitespace is trimmed', '  bbb222\n', 'bbb222'],
      ['128 chars is the limit', 'a'.repeat(128), 'a'.repeat(128)],
      ['underscore and dash', 'aside_question-9f3e', 'aside_question-9f3e'],
      ['mixed case hex', 'A1b2C3', 'A1b2C3'],
    ])('accepts a well-formed agent_id (%s)', (_label, id, expected) => {
      const r = claudeProvider.normalizeHookEvent({
        hook_event_name: 'Stop',
        session_id: 's1',
        agent_id: id,
      });
      expect(r?.agentKey).toBe(expected);
    });

    it.each([
      [{ hook_event_name: 'PreToolUse', tool_name: 'Read' }, 'toolStart'],
      [{ hook_event_name: 'PostToolUse' }, 'toolEnd'],
      [{ hook_event_name: 'PostToolUseFailure' }, 'toolEnd'],
      [{ hook_event_name: 'Stop' }, 'turnEnd'],
      [{ hook_event_name: 'SubagentStart', agent_type: 'Explore' }, 'subagentStart'],
      [{ hook_event_name: 'SubagentStop' }, 'subagentEnd'],
      [{ hook_event_name: 'PermissionRequest' }, 'permissionRequest'],
      [
        { hook_event_name: 'Notification', notification_type: 'permission_prompt' },
        'permissionRequest',
      ],
      [{ hook_event_name: 'Notification', notification_type: 'idle_prompt' }, 'turnEnd'],
      [{ hook_event_name: 'SessionStart' }, 'sessionStart'],
      [{ hook_event_name: 'SessionEnd' }, 'sessionEnd'],
      [{ hook_event_name: 'TeammateIdle' }, 'subagentTurnEnd'],
      [{ hook_event_name: 'TaskCompleted' }, 'subagentTurnEnd'],
    ])('keeps agentKey on every normalized event (%o)', (payload, kind) => {
      const r = claudeProvider.normalizeHookEvent({
        ...payload,
        session_id: 's1',
        agent_id: 'k9',
      });
      expect(r?.event.kind).toBe(kind);
      expect(r?.agentKey).toBe('k9');
      expect(r?.sessionId).toBe('s1');
    });

    it('still drops ignored events even when keyed', () => {
      for (const name of ['UserPromptSubmit', 'TaskCreated', 'SomethingWeird']) {
        expect(
          claudeProvider.normalizeHookEvent({
            hook_event_name: name,
            session_id: 's1',
            agent_id: 'k9',
          }),
        ).toBeNull();
      }
    });

    it('agent_id never replaces the session id (routing stays on session_id)', () => {
      const r = claudeProvider.normalizeHookEvent({
        hook_event_name: 'Stop',
        session_id: 's1',
        agent_id: 's2',
      });
      expect(r?.sessionId).toBe('s1');
    });
  });

  describe('normalizeHookEvent', () => {
    it('returns null when hook_event_name is missing', () => {
      expect(claudeProvider.normalizeHookEvent({ session_id: 'x' })).toBeNull();
    });
    it('returns null when session_id is missing', () => {
      expect(claudeProvider.normalizeHookEvent({ hook_event_name: 'Stop' })).toBeNull();
    });
    it('returns null for unknown hook event names', () => {
      expect(
        claudeProvider.normalizeHookEvent({
          hook_event_name: 'SomethingWeird',
          session_id: 'x',
        }),
      ).toBeNull();
    });

    it('normalizes PreToolUse with tool_name + tool_input', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Read',
        tool_input: { file_path: '/foo.ts' },
      });
      expect(result?.sessionId).toBe('sess-1');
      expect(result?.event.kind).toBe('toolStart');
      if (result?.event.kind === 'toolStart') {
        expect(result.event.toolName).toBe('Read');
        expect(result.event.toolId.startsWith('hook-')).toBe(true);
        expect(result.event.input).toEqual({ file_path: '/foo.ts' });
        expect(result.event.runInBackground).toBe(false);
      }
    });

    it('PreToolUse sets runInBackground when tool_input.run_in_background=true', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Agent',
        tool_input: { run_in_background: true },
      });
      if (result?.event.kind === 'toolStart') {
        expect(result.event.runInBackground).toBe(true);
      } else {
        expect.fail('expected toolStart');
      }
    });

    it('normalizes PostToolUse to toolEnd with sentinel toolId', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'PostToolUse',
        session_id: 'sess-1',
      });
      expect(result?.event.kind).toBe('toolEnd');
    });

    it('normalizes PostToolUseFailure to toolEnd (same as PostToolUse)', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'PostToolUseFailure',
        session_id: 'sess-1',
      });
      expect(result?.event.kind).toBe('toolEnd');
    });

    it('normalizes Stop to turnEnd without awaitingInput (Done, not waiting)', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'Stop',
        session_id: 'sess-1',
      });
      expect(result?.event.kind).toBe('turnEnd');
      if (result?.event.kind === 'turnEnd') {
        expect(result.event.awaitingInput).toBeFalsy();
      }
    });

    it('ignores UserPromptSubmit (no normalized kind yet)', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'sess-1',
      });
      expect(result).toBeNull();
    });

    it('normalizes SubagentStart with agent_type as toolName', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'SubagentStart',
        session_id: 'sess-1',
        agent_type: 'web-researcher',
      });
      expect(result?.event.kind).toBe('subagentStart');
      if (result?.event.kind === 'subagentStart') {
        expect(result.event.toolName).toBe('web-researcher');
        expect(result.event.toolId.startsWith('hook-sub-web-researcher-')).toBe(true);
      }
    });

    it('normalizes SubagentStop to subagentEnd', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'SubagentStop',
        session_id: 'sess-1',
      });
      expect(result?.event.kind).toBe('subagentEnd');
    });

    it('normalizes PermissionRequest to permissionRequest', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'PermissionRequest',
        session_id: 'sess-1',
      });
      expect(result?.event.kind).toBe('permissionRequest');
    });

    it('normalizes Notification(permission_prompt) to permissionRequest', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'Notification',
        session_id: 'sess-1',
        notification_type: 'permission_prompt',
      });
      expect(result?.event.kind).toBe('permissionRequest');
    });

    it('normalizes Notification(idle_prompt) to turnEnd with awaitingInput=true', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'Notification',
        session_id: 'sess-1',
        notification_type: 'idle_prompt',
      });
      expect(result?.event.kind).toBe('turnEnd');
      if (result?.event.kind === 'turnEnd') {
        expect(result.event.awaitingInput).toBe(true);
      }
    });

    it('returns null for Notification with unknown type', () => {
      expect(
        claudeProvider.normalizeHookEvent({
          hook_event_name: 'Notification',
          session_id: 'sess-1',
          notification_type: 'other',
        }),
      ).toBeNull();
    });

    it('normalizes SessionStart with source + transcript_path + cwd', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'SessionStart',
        session_id: 'sess-1',
        source: 'startup',
        transcript_path: '/Users/x/.claude/projects/foo/sess-1.jsonl',
        cwd: '/Users/x/work',
      });
      expect(result?.event.kind).toBe('sessionStart');
      if (result?.event.kind === 'sessionStart') {
        expect(result.event.source).toBe('startup');
        expect(result.event.transcriptPath).toBe('/Users/x/.claude/projects/foo/sess-1.jsonl');
        expect(result.event.cwd).toBe('/Users/x/work');
      }
    });

    it('normalizes SessionEnd with reason', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'SessionEnd',
        session_id: 'sess-1',
        reason: 'clear',
      });
      expect(result?.event.kind).toBe('sessionEnd');
      if (result?.event.kind === 'sessionEnd') {
        expect(result.event.reason).toBe('clear');
      }
    });

    it('normalizes TeammateIdle to subagentTurnEnd with reason=idle', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'TeammateIdle',
        session_id: 'sess-1',
        agent_type: 'web-researcher',
      });
      expect(result?.event.kind).toBe('subagentTurnEnd');
      if (result?.event.kind === 'subagentTurnEnd') {
        expect(result.event.reason).toBe('idle');
      }
    });

    it('normalizes TaskCompleted to subagentTurnEnd with reason=completed', () => {
      const result = claudeProvider.normalizeHookEvent({
        hook_event_name: 'TaskCompleted',
        session_id: 'sess-1',
        subject: 'Code review',
      });
      expect(result?.event.kind).toBe('subagentTurnEnd');
      if (result?.event.kind === 'subagentTurnEnd') {
        expect(result.event.reason).toBe('completed');
      }
    });

    it('returns null for TaskCreated (informational only)', () => {
      expect(
        claudeProvider.normalizeHookEvent({
          hook_event_name: 'TaskCreated',
          session_id: 'sess-1',
          subject: 'Code review',
        }),
      ).toBeNull();
    });
  });

  describe('formatToolStatus', () => {
    it('formats Read', () => {
      expect(claudeProvider.formatToolStatus('Read', { file_path: '/a/b.ts' })).toBe(
        'Reading b.ts',
      );
    });
    it('formats Task/Agent with description', () => {
      expect(claudeProvider.formatToolStatus('Task', { description: 'Code review' })).toBe(
        'Subtask: Code review',
      );
      expect(claudeProvider.formatToolStatus('Agent', { description: 'Research' })).toBe(
        'Subtask: Research',
      );
    });
    it('falls back to "Using X" for unknown tools', () => {
      expect(claudeProvider.formatToolStatus('FancyTool', {})).toBe('Using FancyTool');
    });
    it('handles undefined input', () => {
      expect(claudeProvider.formatToolStatus('Read', undefined)).toBe('Reading ');
    });
  });
});
