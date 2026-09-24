import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { claudeTeamProvider } from '../src/providers/hook/claude/claudeTeamProvider.js';

/** Paths the PROVIDER passed to readFileSync. `vi.spyOn(require('fs'), ...)`
 *  does not reach the provider's `import * as fs` binding, so a pass-through
 *  module mock is the only seam that observes its reads. `failOnce` makes the
 *  next read of that exact path throw EBUSY (a transient Windows lock). */
const fsReads = vi.hoisted(() => ({ paths: [] as string[], failOnce: new Set<string>() }));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const p = String(args[0]);
    fsReads.paths.push(p);
    if (fsReads.failOnce.delete(p)) {
      const err = new Error(`EBUSY: simulated lock, open '${p}'`) as NodeJS.ErrnoException;
      err.code = 'EBUSY';
      throw err;
    }
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

// Redirect os.homedir() to a per-test temp dir (same pattern as
// configPersistence.test.ts). getTeamMembers reads ~/.claude/teams/<name>/, and
// overriding HOME is not portable (Windows reads USERPROFILE), so the suite used
// to write and delete under the developer's REAL ~/.claude/teams. The mock
// throws while no test home is set, so nothing can fall back to the real home.
const testHome = vi.hoisted(() => ({ dir: '' }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const homedir = (): string => {
    if (!testHome.dir) throw new Error('os.homedir() called before a test home was set');
    return testHome.dir;
  };
  return { ...actual, homedir, default: { ...actual, homedir } };
});

describe('claudeTeamProvider', () => {
  describe('identity', () => {
    it('has providerId "claude"', () => {
      expect(claudeTeamProvider.providerId).toBe('claude');
    });

    it('spawns teammates via "Agent" tool', () => {
      expect(claudeTeamProvider.teammateSpawnTools.has('Agent')).toBe(true);
    });

    it('uses "Task" for within-turn subagents', () => {
      expect(claudeTeamProvider.withinTurnSubagentTools.has('Task')).toBe(true);
    });
  });

  describe.each([
    { tool: 'Agent', input: { run_in_background: true }, expected: true },
    { tool: 'Agent', input: { run_in_background: false }, expected: false },
    { tool: 'Agent', input: {}, expected: false },
    // Non-boolean run_in_background must not trigger the teammate path.
    { tool: 'Agent', input: { run_in_background: 'true' }, expected: false },
    { tool: 'Agent', input: { run_in_background: 1 }, expected: false },
    // Task/arbitrary tools never spawn teammates regardless of flags.
    { tool: 'Task', input: { run_in_background: true }, expected: false },
    { tool: 'Read', input: {}, expected: false },
    { tool: 'WebSearch', input: { run_in_background: true }, expected: false },
  ])('isTeammateSpawnCall($tool, $input)', ({ tool, input, expected }) => {
    it(`returns ${expected}`, () => {
      expect(claudeTeamProvider.isTeammateSpawnCall(tool, input)).toBe(expected);
    });
  });

  describe('extractTeammateNameFromEvent', () => {
    it('reads current teammate_name when present', () => {
      expect(
        claudeTeamProvider.extractTeammateNameFromEvent({ teammate_name: 'web-researcher' }),
      ).toBe('web-researcher');
    });

    it('falls back to agent_type for SubagentStart compatibility', () => {
      expect(
        claudeTeamProvider.extractTeammateNameFromEvent({ agent_type: 'web-researcher' }),
      ).toBe('web-researcher');
    });

    it('prefers teammate_name when both names are present', () => {
      expect(
        claudeTeamProvider.extractTeammateNameFromEvent({
          teammate_name: 'web-researcher',
          agent_type: 'legacy-agent-type',
        }),
      ).toBe('web-researcher');
    });

    it('falls back when teammate_name is not a string', () => {
      expect(
        claudeTeamProvider.extractTeammateNameFromEvent({
          teammate_name: 42,
          agent_type: 'web-researcher',
        }),
      ).toBe('web-researcher');
    });

    it('returns undefined when teammate identity is missing or malformed', () => {
      expect(claudeTeamProvider.extractTeammateNameFromEvent({})).toBeUndefined();
      expect(
        claudeTeamProvider.extractTeammateNameFromEvent({ teammate_name: null, agent_type: 42 }),
      ).toBeUndefined();
    });
  });

  describe('discoverTeammates', () => {
    const fsMod = require('fs') as typeof import('fs');
    const tmpRoot = path.join(os.tmpdir(), 'pixel-agents-discover-' + Date.now());

    afterEach(() => {
      try {
        fsMod.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('returns empty array when teammate directory does not exist', () => {
      const result = claudeTeamProvider.discoverTeammates(tmpRoot, 'nonexistent-sess');
      expect(result).toEqual([]);
    });

    it('skips jsonl files without a valid sidecar', () => {
      const sessDir = path.join(tmpRoot, 'sess-1', 'subagents');
      fsMod.mkdirSync(sessDir, { recursive: true });
      fsMod.writeFileSync(path.join(sessDir, 'orphan.jsonl'), '{}');
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-1')).toEqual([]);
    });

    it('returns jsonlPath + teammateName for each valid teammate', () => {
      const sessDir = path.join(tmpRoot, 'sess-1', 'subagents');
      fsMod.mkdirSync(sessDir, { recursive: true });
      const agentA = path.join(sessDir, 'agent-a.jsonl');
      const agentB = path.join(sessDir, 'agent-b.jsonl');
      fsMod.writeFileSync(agentA, '');
      fsMod.writeFileSync(
        agentA.replace(/\.jsonl$/, '.meta.json'),
        '{"agentType":"web-researcher"}',
      );
      fsMod.writeFileSync(agentB, '');
      fsMod.writeFileSync(
        agentB.replace(/\.jsonl$/, '.meta.json'),
        '{"agentType":"code-reviewer"}',
      );
      const result = claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-1');
      expect(result.map((t) => t.teammateName).sort()).toEqual(['code-reviewer', 'web-researcher']);
      expect(result.every((t) => t.jsonlPath.endsWith('.jsonl'))).toBe(true);
    });

    it('exposes the sidecar name when present (named background spawn)', () => {
      const sessDir = path.join(tmpRoot, 'sess-1', 'subagents');
      fsMod.mkdirSync(sessDir, { recursive: true });
      const agentA = path.join(sessDir, 'agent-a.jsonl');
      fsMod.writeFileSync(agentA, '');
      fsMod.writeFileSync(
        agentA.replace(/\.jsonl$/, '.meta.json'),
        '{"agentType":"general-purpose","toolUseId":"toolu_1","description":"Write a haiku","name":"ghost-writer"}',
      );
      const result = claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-1');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('ghost-writer');
      expect(result[0].toolUseId).toBe('toolu_1');
      expect(result[0].description).toBe('Write a haiku');
    });

    it('leaves name undefined when absent or malformed (unnamed spawn)', () => {
      const sessDir = path.join(tmpRoot, 'sess-1', 'subagents');
      fsMod.mkdirSync(sessDir, { recursive: true });
      const unnamed = path.join(sessDir, 'agent-a.jsonl');
      fsMod.writeFileSync(unnamed, '');
      fsMod.writeFileSync(
        unnamed.replace(/\.jsonl$/, '.meta.json'),
        '{"agentType":"general-purpose","toolUseId":"toolu_1"}',
      );
      const malformed = path.join(sessDir, 'agent-b.jsonl');
      fsMod.writeFileSync(malformed, '');
      fsMod.writeFileSync(
        malformed.replace(/\.jsonl$/, '.meta.json'),
        '{"agentType":"general-purpose","toolUseId":"toolu_2","name":42}',
      );
      const result = claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-1');
      expect(result).toHaveLength(2);
      expect(result.every((t) => t.name === undefined)).toBe(true);
    });

    it('exposes spawn-tree keys from sidecars', () => {
      const dir = path.join(tmpRoot, 'sess-tree', 'subagents');
      fsMod.mkdirSync(dir, { recursive: true });
      fsMod.writeFileSync(path.join(dir, 'agent-aaa111.jsonl'), '');
      fsMod.writeFileSync(
        path.join(dir, 'agent-aaa111.meta.json'),
        JSON.stringify({
          agentType: 'lider-fase',
          description: 'Fase 1',
          toolUseId: 'toolu_1',
          spawnDepth: 1,
        }),
      );
      fsMod.writeFileSync(path.join(dir, 'agent-bbb222.jsonl'), '');
      fsMod.writeFileSync(
        path.join(dir, 'agent-bbb222.meta.json'),
        JSON.stringify({
          agentType: 'desarrollador',
          description: 'dev auth',
          toolUseId: 'toolu_2',
          parentAgentId: 'aaa111',
          spawnDepth: 2,
        }),
      );
      const entries = claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-tree');
      const byKey = new Map(entries.map((e) => [e.agentKey, e]));
      expect(byKey.get('aaa111')).toMatchObject({
        depth: 1,
        agentType: 'lider-fase',
        parentAgentKey: undefined,
        toolUseId: 'toolu_1',
        description: 'Fase 1',
      });
      expect(byKey.get('bbb222')).toMatchObject({
        depth: 2,
        agentType: 'desarrollador',
        parentAgentKey: 'aaa111',
        toolUseId: 'toolu_2',
      });
    });

    it('leaves depth undefined when spawnDepth is malformed (entry kept)', () => {
      const dir = path.join(tmpRoot, 'sess-bad', 'subagents');
      fsMod.mkdirSync(dir, { recursive: true });
      const cases: Record<string, unknown>[] = [
        { agentType: 'x', spawnDepth: '2' },
        { agentType: 'x', spawnDepth: 0 },
        { agentType: 'x', spawnDepth: 1.5 },
        { agentType: 'x', spawnDepth: -1 },
        { agentType: 'x', spawnDepth: Number.MAX_SAFE_INTEGER + 2 },
        { agentType: 'x', spawnDepth: null },
        { agentType: 'x', spawnDepth: [2] },
      ];
      cases.forEach((meta, i) => {
        fsMod.writeFileSync(path.join(dir, `agent-k${i}.jsonl`), '');
        fsMod.writeFileSync(path.join(dir, `agent-k${i}.meta.json`), JSON.stringify(meta));
      });
      const entries = claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-bad');
      expect(entries).toHaveLength(cases.length);
      for (const e of entries) {
        expect(e.parentAgentKey).toBeUndefined();
        expect(e.depth).toBeUndefined();
        expect(e.agentType).toBe('x');
      }
    });

    it('omits a sidecar whose parentAgentId is present but invalid (never re-parented to the root)', () => {
      const dir = path.join(tmpRoot, 'sess-badparent', 'subagents');
      fsMod.mkdirSync(dir, { recursive: true });
      const invalidParents: unknown[] = [
        42,
        '',
        '   ',
        null,
        false,
        '../aaa111',
        'a/b',
        'a.b',
        'a'.repeat(129),
        ['aaa111'],
        { id: 'aaa111' },
      ];
      invalidParents.forEach((parentAgentId, i) => {
        fsMod.writeFileSync(path.join(dir, `agent-p${i}.jsonl`), '');
        fsMod.writeFileSync(
          path.join(dir, `agent-p${i}.meta.json`),
          JSON.stringify({ agentType: 'x', parentAgentId, spawnDepth: 2 }),
        );
      });
      // Control: ABSENT parentAgentId = child of the root, kept.
      fsMod.writeFileSync(path.join(dir, 'agent-root1.jsonl'), '');
      fsMod.writeFileSync(
        path.join(dir, 'agent-root1.meta.json'),
        JSON.stringify({ agentType: 'x', spawnDepth: 1 }),
      );
      const entries = claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-badparent');
      expect(entries.map((e) => e.agentKey)).toEqual(['root1']);
      expect(entries[0].parentAgentKey).toBeUndefined();
    });

    it('trims a sidecar parentAgentId the same way hook agent_ids are', () => {
      const dir = path.join(tmpRoot, 'sess-trim', 'subagents');
      fsMod.mkdirSync(dir, { recursive: true });
      fsMod.writeFileSync(path.join(dir, 'agent-c1.jsonl'), '');
      fsMod.writeFileSync(
        path.join(dir, 'agent-c1.meta.json'),
        JSON.stringify({ agentType: 'x', parentAgentId: ' aaa111\n', spawnDepth: 2 }),
      );
      const [entry] = claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-trim');
      expect(entry.parentAgentKey).toBe('aaa111');
    });

    it('skips sidecars whose JSON is not an object', () => {
      const dir = path.join(tmpRoot, 'sess-shapes', 'subagents');
      fsMod.mkdirSync(dir, { recursive: true });
      ['null', '"agentType"', '[{"agentType":"x"}]', '42', '', '{"agentType":"x"'].forEach(
        (body, i) => {
          fsMod.writeFileSync(path.join(dir, `agent-s${i}.jsonl`), '');
          fsMod.writeFileSync(path.join(dir, `agent-s${i}.meta.json`), body);
        },
      );
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-shapes')).toEqual([]);
    });

    it('never opens an oversized or non-regular sidecar, and does not retry it', () => {
      const dir = path.join(tmpRoot, 'sess-huge', 'subagents');
      fsMod.mkdirSync(dir, { recursive: true });
      fsMod.writeFileSync(path.join(dir, 'agent-h1.jsonl'), '');
      fsMod.writeFileSync(
        path.join(dir, 'agent-h1.meta.json'),
        JSON.stringify({ agentType: 'x', description: 'y'.repeat(70 * 1024) }),
      );
      fsMod.writeFileSync(path.join(dir, 'agent-h2.jsonl'), '');
      fsMod.mkdirSync(path.join(dir, 'agent-h2.meta.json')); // a directory, not a file
      fsReads.paths.length = 0;
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-huge')).toEqual([]);
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-huge')).toEqual([]);
      expect(fsReads.paths.filter((p) => p.endsWith('.meta.json'))).toEqual([]);
    });

    it('does not cache a transient read failure (sidecar found on the next scan)', () => {
      const dir = path.join(tmpRoot, 'sess-busy', 'subagents');
      fsMod.mkdirSync(dir, { recursive: true });
      const meta = path.join(dir, 'agent-b1.meta.json');
      fsMod.writeFileSync(path.join(dir, 'agent-b1.jsonl'), '');
      fsMod.writeFileSync(meta, '{"agentType":"x"}');
      fsReads.failOnce.add(meta);
      // Same mtime and size on both scans: only a non-cached failure is retried.
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-busy')).toEqual([]);
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-busy')).toHaveLength(1);
    });

    it('re-reads a sidecar that left the listing and came back (cache evicted)', () => {
      const dir = path.join(tmpRoot, 'sess-evict', 'subagents');
      fsMod.mkdirSync(dir, { recursive: true });
      const jsonl = path.join(dir, 'agent-e1.jsonl');
      const meta = path.join(dir, 'agent-e1.meta.json');
      fsMod.writeFileSync(jsonl, '');
      fsMod.writeFileSync(meta, '{"agentType":"x"}');
      claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-evict');
      // Transcript leaves the listing: its cache entry must go with it.
      fsMod.rmSync(jsonl);
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-evict')).toEqual([]);
      fsMod.writeFileSync(jsonl, '');
      fsReads.paths.length = 0;
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-evict')).toHaveLength(1);
      expect(fsReads.paths.filter((p) => p === meta)).toHaveLength(1);
    });

    it('sets agentKey only for agent-<key>.jsonl transcripts', () => {
      const dir = path.join(tmpRoot, 'sess-names', 'subagents');
      fsMod.mkdirSync(dir, { recursive: true });
      const tooLong = `agent-${'a'.repeat(129)}`;
      const maxLen = `agent-${'a'.repeat(128)}`;
      const bases = [
        'agent-k1',
        'agent-aside_question-9f3e',
        maxLen,
        'other',
        'agent-',
        'agent-a.b',
        'agent-a b',
        'agent- k2',
        tooLong,
      ];
      for (const base of bases) {
        fsMod.writeFileSync(path.join(dir, `${base}.jsonl`), '');
        fsMod.writeFileSync(path.join(dir, `${base}.meta.json`), '{"agentType":"x"}');
      }
      const entries = claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-names');
      // Every sidecar-backed transcript is still discovered; only the KEY is withheld.
      expect(entries).toHaveLength(bases.length);
      const keys = new Map(entries.map((e) => [path.basename(e.jsonlPath), e.agentKey]));
      expect(keys.get('agent-k1.jsonl')).toBe('k1');
      expect(keys.get('agent-aside_question-9f3e.jsonl')).toBe('aside_question-9f3e');
      expect(keys.get(`${maxLen}.jsonl`)).toBe('a'.repeat(128));
      expect(keys.get('other.jsonl')).toBeUndefined();
      expect(keys.get('agent-.jsonl')).toBeUndefined();
      expect(keys.get('agent-a.b.jsonl')).toBeUndefined();
      expect(keys.get('agent-a b.jsonl')).toBeUndefined();
      // Filenames are taken verbatim, never trimmed (` k2` must not alias `k2`).
      expect(keys.get('agent- k2.jsonl')).toBeUndefined();
      expect(keys.get(`${tooLong}.jsonl`)).toBeUndefined();
    });

    it('does not re-parse an unchanged sidecar on every scan', () => {
      // 300 dead sidecars, scanned twice: the second scan must not read them again.
      const dir = path.join(tmpRoot, 'sess-many', 'subagents');
      fsMod.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 300; i++) {
        fsMod.writeFileSync(path.join(dir, `agent-d${i}.jsonl`), '');
        fsMod.writeFileSync(
          path.join(dir, `agent-d${i}.meta.json`),
          JSON.stringify({ agentType: 'Explore', toolUseId: `toolu_d${i}`, spawnDepth: 1 }),
        );
      }
      const metaReads = () => fsReads.paths.filter((p) => p.endsWith('.meta.json')).length;
      // Control: the cold scan IS observed (proves the seam reaches the
      // provider's fs, so the zero below is not vacuous).
      fsReads.paths.length = 0;
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-many')).toHaveLength(300);
      expect(metaReads()).toBe(300);
      fsReads.paths.length = 0;
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-many')).toHaveLength(300);
      expect(metaReads()).toBe(0);
    }, 60_000); // 600 file writes: slow on Windows (real-time AV scanning)

    it('serves an unchanged sidecar (same mtime and size) from the cache', () => {
      // Behavioral twin of the spy test: swap the content in place and restore the
      // exact mtime -- a cache hit keeps returning the first parse.
      const dir = path.join(tmpRoot, 'sess-cache', 'subagents');
      fsMod.mkdirSync(dir, { recursive: true });
      const meta = path.join(dir, 'agent-c1.meta.json');
      fsMod.writeFileSync(path.join(dir, 'agent-c1.jsonl'), '');
      const stamp = new Date('2026-01-01T00:00:00Z');
      fsMod.writeFileSync(meta, '{"agentType":"aaaa"}');
      fsMod.utimesSync(meta, stamp, stamp);
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-cache')[0].agentType).toBe('aaaa');
      fsMod.writeFileSync(meta, '{"agentType":"bbbb"}');
      fsMod.utimesSync(meta, stamp, stamp);
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-cache')[0].agentType).toBe('aaaa');
    });

    it('re-parses a sidecar whose mtime or size changed', () => {
      // A sidecar caught mid-write parses as null; once completed it must be picked up.
      const dir = path.join(tmpRoot, 'sess-grow', 'subagents');
      fsMod.mkdirSync(dir, { recursive: true });
      const meta = path.join(dir, 'agent-g1.meta.json');
      fsMod.writeFileSync(path.join(dir, 'agent-g1.jsonl'), '');
      const stamp = new Date('2026-01-01T00:00:00Z');
      fsMod.writeFileSync(meta, '{"agentType":');
      fsMod.utimesSync(meta, stamp, stamp);
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-grow')).toEqual([]);
      // Same mtime, different size: still re-read.
      fsMod.writeFileSync(meta, '{"agentType":"late"}');
      fsMod.utimesSync(meta, stamp, stamp);
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-grow')[0]?.agentType).toBe('late');
      // Same size, different mtime: re-read.
      fsMod.writeFileSync(meta, '{"agentType":"lat2"}');
      const later = new Date('2026-01-02T00:00:00Z');
      fsMod.utimesSync(meta, later, later);
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-grow')[0]?.agentType).toBe('lat2');
    });

    it('drops a sidecar that disappears between scans', () => {
      const dir = path.join(tmpRoot, 'sess-gone', 'subagents');
      fsMod.mkdirSync(dir, { recursive: true });
      const meta = path.join(dir, 'agent-x1.meta.json');
      fsMod.writeFileSync(path.join(dir, 'agent-x1.jsonl'), '');
      fsMod.writeFileSync(meta, '{"agentType":"x"}');
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-gone')).toHaveLength(1);
      fsMod.rmSync(meta);
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-gone')).toEqual([]);
    });
  });

  describe('extractTeammateSpawnFromToolResult', () => {
    const spawnText =
      'Spawned successfully. (This tool result is internal metadata.)\n' +
      'agent_id: wa-broadcast-safety-research@session-029c4a18\nname: wa-broadcast-safety-research';

    it('extracts teammate name + team from an Agent spawn result (block array)', () => {
      expect(
        claudeTeamProvider.extractTeammateSpawnFromToolResult!('Agent', [
          { type: 'text', text: spawnText },
        ]),
      ).toEqual({
        teammateName: 'wa-broadcast-safety-research',
        teamName: 'session-029c4a18',
      });
    });

    it('extracts from plain string content', () => {
      expect(claudeTeamProvider.extractTeammateSpawnFromToolResult!('Agent', spawnText)).toEqual({
        teammateName: 'wa-broadcast-safety-research',
        teamName: 'session-029c4a18',
      });
    });

    it('returns null for non-spawn tools even when the text matches', () => {
      expect(claudeTeamProvider.extractTeammateSpawnFromToolResult!('Task', spawnText)).toBeNull();
      expect(claudeTeamProvider.extractTeammateSpawnFromToolResult!('Read', spawnText)).toBeNull();
    });

    it('returns null for Agent results without an agent_id line', () => {
      expect(
        claudeTeamProvider.extractTeammateSpawnFromToolResult!('Agent', [
          { type: 'text', text: 'Async agent launched successfully.' },
        ]),
      ).toBeNull();
      expect(claudeTeamProvider.extractTeammateSpawnFromToolResult!('Agent', undefined)).toBeNull();
    });
  });

  describe('discoverTeammates (new-style: top-level tagged sessions)', () => {
    const fsMod = require('fs') as typeof import('fs');
    const tmpRoot = path.join(os.tmpdir(), 'pixel-agents-discover-new-' + Date.now());
    const LEAD_SESSION = '11111111-1111-4111-8111-111111111111';
    const MATE_SESSION = '22222222-2222-4222-8222-222222222222';
    const TEAM = 'session-abc12345';

    /** Teammate transcript as newer harnesses write it: setting records first
     *  (no team tags), tags appear on the first user record. */
    function writeTeammateFile(sessionId: string, teamName: string, agentName: string): string {
      const p = path.join(tmpRoot, `${sessionId}.jsonl`);
      fsMod.writeFileSync(
        p,
        JSON.stringify({ type: 'agent-setting', agentSetting: 'general-purpose', sessionId }) +
          '\n' +
          JSON.stringify({ type: 'mode', mode: 'default' }) +
          '\n' +
          JSON.stringify({
            type: 'user',
            teamName,
            agentName,
            message: { role: 'user', content: 'go' },
          }) +
          '\n',
      );
      return p;
    }

    afterEach(() => {
      try {
        fsMod.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('finds top-level teammate sessions tagged with the team, with their own sessionId', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      // Lead's own transcript: untagged user record, must never be a teammate.
      fsMod.writeFileSync(
        path.join(tmpRoot, `${LEAD_SESSION}.jsonl`),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + '\n',
      );
      writeTeammateFile(MATE_SESSION, TEAM, 'wa-research');

      const result = claudeTeamProvider.discoverTeammates(tmpRoot, LEAD_SESSION, TEAM);
      expect(result).toEqual([
        {
          jsonlPath: path.join(tmpRoot, `${MATE_SESSION}.jsonl`),
          teammateName: 'wa-research',
          sessionId: MATE_SESSION,
        },
      ]);
    });

    it('ignores sessions tagged with a different team', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      writeTeammateFile(MATE_SESSION, 'session-other000', 'stranger');
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, LEAD_SESSION, TEAM)).toEqual([]);
    });

    it('skips new-style scanning entirely when teamName is not provided', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      writeTeammateFile(MATE_SESSION, TEAM, 'wa-research');
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, LEAD_SESSION)).toEqual([]);
    });

    it('re-checks settings-only files on later scans (tags arrive after creation)', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      const p = path.join(tmpRoot, `${MATE_SESSION}.jsonl`);
      // Freshly created transcript: only setting records so far.
      fsMod.writeFileSync(
        p,
        JSON.stringify({ type: 'agent-setting', agentSetting: 'general-purpose' }) + '\n',
      );
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, LEAD_SESSION, TEAM)).toEqual([]);
      // Tagged user record lands -> next scan must pick it up.
      fsMod.appendFileSync(
        p,
        JSON.stringify({
          type: 'user',
          teamName: TEAM,
          agentName: 'late-bloomer',
          message: { role: 'user', content: 'go' },
        }) + '\n',
      );
      const result = claudeTeamProvider.discoverTeammates(tmpRoot, LEAD_SESSION, TEAM);
      expect(result.map((t) => t.teammateName)).toEqual(['late-bloomer']);
    });

    it('combines old-style sidecar teammates with new-style tagged sessions', () => {
      const sessDir = path.join(tmpRoot, LEAD_SESSION, 'subagents');
      fsMod.mkdirSync(sessDir, { recursive: true });
      const oldStyle = path.join(sessDir, 'agent-a.jsonl');
      fsMod.writeFileSync(oldStyle, '');
      fsMod.writeFileSync(
        oldStyle.replace(/\.jsonl$/, '.meta.json'),
        '{"agentType":"web-researcher"}',
      );
      writeTeammateFile(MATE_SESSION, TEAM, 'wa-research');

      const result = claudeTeamProvider.discoverTeammates(tmpRoot, LEAD_SESSION, TEAM);
      expect(result.map((t) => t.teammateName).sort()).toEqual(['wa-research', 'web-researcher']);
      const oldEntry = result.find((t) => t.teammateName === 'web-researcher')!;
      expect(oldEntry.sessionId).toBeUndefined();
    });
  });

  describe('getTeamMetadataForSession', () => {
    const fsMod = require('fs') as typeof import('fs');
    const tmpRoot = path.join(os.tmpdir(), 'pixel-agents-meta-' + Date.now());

    afterEach(() => {
      try {
        fsMod.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('returns null when file does not exist', () => {
      expect(
        claudeTeamProvider.getTeamMetadataForSession(path.join(tmpRoot, 'missing.jsonl')),
      ).toBeNull();
    });

    it('returns null when first line has no teamName', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      const p = path.join(tmpRoot, 'no-team.jsonl');
      fsMod.writeFileSync(p, JSON.stringify({ other: 'value' }) + '\n');
      expect(claudeTeamProvider.getTeamMetadataForSession(p)).toBeNull();
    });

    it('extracts teamName + agentName from the first JSONL line', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      const p = path.join(tmpRoot, 'teammate.jsonl');
      fsMod.writeFileSync(
        p,
        JSON.stringify({ teamName: 'research', agentName: 'web-researcher' }) +
          '\n' +
          JSON.stringify({ other: 'should-be-ignored' }) +
          '\n',
      );
      expect(claudeTeamProvider.getTeamMetadataForSession(p)).toEqual({
        teamName: 'research',
        agentName: 'web-researcher',
      });
    });

    it('agentName is undefined for the lead (no agentName field)', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      const p = path.join(tmpRoot, 'lead.jsonl');
      fsMod.writeFileSync(p, JSON.stringify({ teamName: 'research' }) + '\n');
      expect(claudeTeamProvider.getTeamMetadataForSession(p)).toEqual({
        teamName: 'research',
        agentName: undefined,
      });
    });

    it('scans past untagged setting records to find team tags (newer harnesses)', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      const p = path.join(tmpRoot, 'new-style.jsonl');
      fsMod.writeFileSync(
        p,
        JSON.stringify({ type: 'agent-setting', agentSetting: 'general-purpose' }) +
          '\n' +
          JSON.stringify({ type: 'mode', mode: 'default' }) +
          '\n' +
          JSON.stringify({ type: 'user', teamName: 'session-abc12345', agentName: 'researcher' }) +
          '\n',
      );
      expect(claudeTeamProvider.getTeamMetadataForSession(p)).toEqual({
        teamName: 'session-abc12345',
        agentName: 'researcher',
      });
    });

    it('returns null when the first conversational record is untagged', () => {
      fsMod.mkdirSync(tmpRoot, { recursive: true });
      const p = path.join(tmpRoot, 'plain-session.jsonl');
      fsMod.writeFileSync(
        p,
        JSON.stringify({ type: 'mode', mode: 'default' }) +
          '\n' +
          JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) +
          '\n' +
          JSON.stringify({ type: 'assistant', teamName: 'too-late' }) +
          '\n',
      );
      expect(claudeTeamProvider.getTeamMetadataForSession(p)).toBeNull();
    });
  });

  describe('getTeamMembers', () => {
    // Writes under <temp home>/.claude/teams/<TEAM_NAME>/ (os.homedir is mocked
    // above) and removes the whole temp home in afterEach.
    const fs = require('fs') as typeof import('fs');
    const TEAM_NAME = 'test-team-' + Date.now();

    beforeEach(() => {
      testHome.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-teams-home-'));
    });

    afterEach(() => {
      try {
        fs.rmSync(testHome.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('reads team configs from the (mocked) home, never the real one', () => {
      expect(os.homedir()).toBe(testHome.dir);
      expect(testHome.dir.startsWith(os.tmpdir())).toBe(true);
    });

    it('returns null when the team config does not exist', () => {
      const result = claudeTeamProvider.getTeamMembers('nonexistent-team-xyz-' + Date.now());
      expect(result).toBeNull();
    });

    it('returns members when config is well-formed', () => {
      const teamDir = path.join(os.homedir(), '.claude', 'teams', TEAM_NAME);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          members: [{ name: 'team-lead' }, { name: 'web-researcher' }],
        }),
      );
      const result = claudeTeamProvider.getTeamMembers(TEAM_NAME);
      expect(result).not.toBeNull();
      expect([...result!].sort()).toEqual(['team-lead', 'web-researcher']);
    });

    it('returns null when config is not valid JSON', () => {
      const teamDir = path.join(os.homedir(), '.claude', 'teams', TEAM_NAME);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(path.join(teamDir, 'config.json'), 'not json');
      expect(claudeTeamProvider.getTeamMembers(TEAM_NAME)).toBeNull();
    });

    it('excludes members marked isActive:false (finished one-shot teammates)', () => {
      const teamDir = path.join(os.homedir(), '.claude', 'teams', TEAM_NAME);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          members: [
            { name: 'team-lead' },
            { name: 'still-running', isActive: true },
            { name: 'finished', isActive: false },
          ],
        }),
      );
      const result = claudeTeamProvider.getTeamMembers(TEAM_NAME);
      expect([...result!].sort()).toEqual(['still-running', 'team-lead']);
    });

    it('skips members without a string name', () => {
      const teamDir = path.join(os.homedir(), '.claude', 'teams', TEAM_NAME);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          members: [
            { name: 'valid' },
            { agentType: 'no-name' },
            { name: 42 },
            { name: 'also-valid' },
          ],
        }),
      );
      const result = claudeTeamProvider.getTeamMembers(TEAM_NAME);
      expect([...result!].sort()).toEqual(['also-valid', 'valid']);
    });
  });

  describe('extractTeamMetadataFromRecord', () => {
    it('returns teamName + agentName when both present', () => {
      expect(
        claudeTeamProvider.extractTeamMetadataFromRecord({
          teamName: 'research',
          agentName: 'web-researcher',
        }),
      ).toEqual({ teamName: 'research', agentName: 'web-researcher' });
    });

    it('returns teamName with undefined agentName for the lead', () => {
      expect(claudeTeamProvider.extractTeamMetadataFromRecord({ teamName: 'research' })).toEqual({
        teamName: 'research',
        agentName: undefined,
      });
    });

    it('returns null when teamName is missing', () => {
      expect(claudeTeamProvider.extractTeamMetadataFromRecord({})).toBeNull();
    });

    it('returns null when teamName is not a string', () => {
      expect(claudeTeamProvider.extractTeamMetadataFromRecord({ teamName: 42 })).toBeNull();
    });
  });
});
