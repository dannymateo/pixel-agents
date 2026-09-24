import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MOCK_CLAUDE_RUNNER = path.join(__dirname, '../../e2e/fixtures/mock-claude-runner.cjs');

let tmpBase: string;
let tmpHome: string;
let workspaceDir: string;

/** A shell command line the way the real installer writes one: paths wrapped in
 *  plain double quotes, NOT JSON-escaped. JSON.stringify doubles every Windows
 *  backslash, which the runner's path normalization turns into `//`, so the
 *  Pixel Agents hook was never recognized as ours on Windows. */
function makeNodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`;
}

function writeHookScript(scriptPath: string, outputPath: string): void {
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(
    scriptPath,
    [
      "const fs = require('fs');",
      'let input = "";',
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      `process.stdin.on('end', () => fs.writeFileSync(${JSON.stringify(outputPath)}, input));`,
    ].join('\n'),
  );
}

function writeScenarioQueue(homeDir: string, queue: unknown[]): void {
  const queuePath = path.join(homeDir, '.claude-mock', 'scenario-queue.json');
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
}

function writeSettings(
  homeDir: string,
  hooks: Record<
    string,
    Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>
  >,
): void {
  const settingsPath = path.join(homeDir, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ hooks }, null, 2));
}

function runMockClaude(
  sessionId = 'test-session',
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MOCK_CLAUDE_RUNNER, '--session-id', sessionId], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('mock-claude-runner hook execution', () => {
  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-mock-runner-'));
    tmpHome = path.join(tmpBase, 'home');
    workspaceDir = path.join(tmpBase, 'workspace');

    fs.mkdirSync(tmpHome, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    // macOS /var → /private/var symlink: the runner sees the resolved cwd via
    // process.cwd(), so its project hash and our expected paths must use the
    // same realpath. Without this, fs.existsSync below sometimes returns false
    // on the symlinked path even though the file exists on the resolved path.
    tmpHome = fs.realpathSync.native(tmpHome);
    workspaceDir = fs.realpathSync.native(workspaceDir);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('executes only Pixel Agents hooks from ~/.claude/settings.json', async () => {
    const pixelOutput = path.join(tmpBase, 'pixel-hook.json');
    const thirdPartyOutput = path.join(tmpBase, 'third-party-hook.json');
    const pixelHookPath = path.join(tmpHome, '.pixel-agents', 'hooks', 'claude-hook.js');
    const thirdPartyHookPath = path.join(tmpHome, '.claude', 'third-party-hook.js');

    writeHookScript(pixelHookPath, pixelOutput);
    writeHookScript(thirdPartyHookPath, thirdPartyOutput);
    writeSettings(tmpHome, {
      Notification: [
        {
          matcher: '',
          hooks: [
            {
              type: 'command',
              command: makeNodeCommand(thirdPartyHookPath),
            },
            {
              type: 'command',
              command: makeNodeCommand(pixelHookPath),
            },
          ],
        },
      ],
    });
    writeScenarioQueue(tmpHome, [
      {
        schemaVersion: 1,
        autoInit: false,
        holdOpenMs: 0,
        sessions: [],
        actions: [
          {
            kind: 'emitHook',
            atMs: 0,
            payload: {
              session_id: 'test-session',
              hook_event_name: 'Notification',
              notification_type: 'idle_prompt',
            },
          },
        ],
      },
    ]);

    const { code, stderr } = await runMockClaude();

    expect(code, stderr).toBe(0);
    expect(fs.existsSync(pixelOutput)).toBe(true);
    expect(fs.existsSync(thirdPartyOutput)).toBe(false);
    expect(JSON.parse(fs.readFileSync(pixelOutput, 'utf8'))).toMatchObject({
      session_id: 'test-session',
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
    });
  });

  it('writes configured sidecar metadata next to custom transcript paths', async () => {
    writeScenarioQueue(tmpHome, [
      {
        schemaVersion: 1,
        autoInit: false,
        holdOpenMs: 0,
        sessions: [
          {
            alias: 'teammate',
            sessionIdTemplate: 'agent-web-researcher',
            transcriptPathTemplate:
              '{{projectDir}}/{{sessionId}}/subagents/agent-web-researcher.jsonl',
            sidecarPathTemplate:
              '{{projectDir}}/{{sessionId}}/subagents/agent-web-researcher.meta.json',
            sidecarJson: {
              agentType: 'web-researcher',
            },
          },
        ],
        actions: [
          {
            kind: 'appendJsonl',
            atMs: 0,
            session: 'teammate',
            record: {
              type: 'system',
              teamName: 'research',
              agentName: 'web-researcher',
            },
          },
        ],
      },
    ]);

    const { code, stderr } = await runMockClaude('lead-session');

    expect(code, stderr).toBe(0);

    const transcriptPath = path.join(
      tmpHome,
      '.claude',
      'projects',
      workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-'),
      'lead-session',
      'subagents',
      'agent-web-researcher.jsonl',
    );
    const sidecarPath = transcriptPath.replace(/\.jsonl$/, '.meta.json');

    expect(fs.existsSync(transcriptPath)).toBe(true);
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(sidecarPath, 'utf8'))).toEqual({
      agentType: 'web-researcher',
    });
  });

  it('writes timed JSON files with template paths', async () => {
    const configPath = path.join(tmpHome, '.claude', 'teams', 'research', 'config.json');

    writeScenarioQueue(tmpHome, [
      {
        schemaVersion: 1,
        autoInit: false,
        holdOpenMs: 0,
        sessions: [],
        actions: [
          {
            kind: 'writeJson',
            atMs: 0,
            filePath: configPath,
            value: {
              members: [{ name: 'lead' }],
            },
          },
        ],
      },
    ]);

    const { code, stderr } = await runMockClaude('lead-session');

    expect(code, stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual({
      members: [{ name: 'lead' }],
    });
  });

  describe('writeFile', () => {
    const projectDirOf = () =>
      path.join(tmpHome, '.claude', 'projects', workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-'));

    function writeFileScenario(relPath: string, content: unknown = 'x'): void {
      writeScenarioQueue(tmpHome, [
        {
          schemaVersion: 1,
          autoInit: false,
          holdOpenMs: 0,
          sessions: [],
          actions: [{ kind: 'writeFile', atMs: 0, relPath, content }],
        },
      ]);
    }

    function actionsLog(): string {
      try {
        return fs.readFileSync(path.join(tmpHome, '.claude-mock', 'actions.log'), 'utf8');
      } catch {
        return '';
      }
    }

    it('writes timed sidecars and transcripts under the project dir, in scenario order', async () => {
      writeScenarioQueue(tmpHome, [
        {
          schemaVersion: 1,
          autoInit: false,
          holdOpenMs: 0,
          sessions: [
            {
              alias: 'aaa',
              sessionIdTemplate: '{{sessionId}}',
              transcriptPathTemplate: '{{projectDir}}/{{sessionId}}/subagents/agent-aaa.jsonl',
            },
          ],
          actions: [
            {
              kind: 'writeFile',
              atMs: 200,
              relPath: '{{sessionId}}/subagents/agent-aaa.meta.json',
              content: {
                agentType: 'lider-fase',
                description: 'Fase 1',
                toolUseId: 'toolu_L',
                spawnDepth: 1,
                note: 'root {{sessionId}}',
              },
            },
            {
              kind: 'appendJsonl',
              atMs: 200,
              session: 'aaa',
              record: { type: 'user', isSidechain: true, agentId: 'aaa' },
            },
            {
              kind: 'writeFile',
              atMs: 0,
              relPath: 'notes/plain.txt',
              content: 'plain text',
            },
          ],
        },
      ]);

      const startedAt = Date.now();
      const { code, stderr } = await runMockClaude('lead-session');

      expect(code, stderr).toBe(0);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
      const subagentsDir = path.join(projectDirOf(), 'lead-session', 'subagents');
      expect(
        JSON.parse(fs.readFileSync(path.join(subagentsDir, 'agent-aaa.meta.json'), 'utf8')),
      ).toEqual({
        agentType: 'lider-fase',
        description: 'Fase 1',
        toolUseId: 'toolu_L',
        spawnDepth: 1,
        note: 'root lead-session',
      });
      expect(fs.readFileSync(path.join(subagentsDir, 'agent-aaa.jsonl'), 'utf8')).toBe(
        `${JSON.stringify({ type: 'user', isSidechain: true, agentId: 'aaa' })}\n`,
      );
      expect(fs.readFileSync(path.join(projectDirOf(), 'notes', 'plain.txt'), 'utf8')).toBe(
        'plain text',
      );

      // Scenario order: the t=0 file first, then the sidecar BEFORE its transcript line.
      const log = actionsLog();
      const plainAt = log.indexOf('plain.txt');
      const metaAt = log.indexOf('agent-aaa.meta.json');
      const appendAt = log.indexOf('appendJsonl aaa');
      expect(plainAt).toBeGreaterThanOrEqual(0);
      expect(metaAt).toBeGreaterThan(plainAt);
      expect(appendAt).toBeGreaterThan(metaAt);
    });

    // A backslash is a separator only on Windows; on POSIX `..\x` is a filename.
    const WINDOWS_ONLY_ESCAPES: Array<[string, string, RegExp]> = [
      ['a backslash parent-dir escape', '..\\escaped.txt', /escapes the project dir/],
    ];

    it.each<[string, string, RegExp]>([
      ['a parent-dir escape', '../escaped.txt', /escapes the project dir/],
      ['a nested parent-dir escape', 'sub/../../escaped.txt', /escapes the project dir/],
      [
        'a template that resolves to an escape',
        '{{sessionId}}/../../escaped.txt',
        /escapes the project dir/,
      ],
      [
        'a template that resolves to an absolute path',
        '{{cwd}}/../escaped.txt',
        /must be relative to the project dir/,
      ],
      ['an empty path', '', /invalid relative path/],
      ['a path with a NUL byte', 'a\0b.txt', /invalid relative path/],
      ['a drive-relative path', 'C:escaped.txt', /must be relative to the project dir/],
      ['a UNC path', '\\\\localhost\\c$\\escaped.txt', /must be relative to the project dir/],
      ...(process.platform === 'win32' ? WINDOWS_ONLY_ESCAPES : []),
    ])('refuses %s and writes nothing outside the project dir', async (_label, relPath, reason) => {
      writeFileScenario(relPath);

      const { code } = await runMockClaude('lead-session');

      expect(code).toBe(1);
      expect(actionsLog()).toMatch(reason);
      expect(fs.existsSync(path.join(path.dirname(projectDirOf()), 'escaped.txt'))).toBe(false);
      expect(fs.existsSync(path.join(tmpBase, 'escaped.txt'))).toBe(false);
    });

    it('refuses an absolute path', async () => {
      const outside = path.join(tmpBase, 'absolute-escape.txt');
      writeFileScenario(outside);

      const { code } = await runMockClaude('lead-session');

      expect(code).toBe(1);
      expect(actionsLog()).toMatch(/must be relative to the project dir/);
      expect(fs.existsSync(outside)).toBe(false);
    });

    it('refuses to write through a symlinked directory that points outside', async () => {
      const outsideDir = path.join(tmpBase, 'outside');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.mkdirSync(projectDirOf(), { recursive: true });
      // A junction needs no elevation on Windows; elsewhere the type is ignored.
      fs.symlinkSync(outsideDir, path.join(projectDirOf(), 'link'), 'junction');
      writeFileScenario('link/nested/escaped.txt');

      const { code } = await runMockClaude('lead-session');

      expect(code).toBe(1);
      expect(actionsLog()).toMatch(/resolves outside the project dir/);
      expect(fs.readdirSync(outsideDir)).toEqual([]);
    });

    it('accepts names that merely start with two dots', async () => {
      writeFileScenario('..cache/kept.txt', 'kept');

      const { code, stderr } = await runMockClaude('lead-session');

      expect(code, stderr).toBe(0);
      expect(fs.readFileSync(path.join(projectDirOf(), '..cache', 'kept.txt'), 'utf8')).toBe(
        'kept',
      );
    });

    it('refuses to replace a directory', async () => {
      fs.mkdirSync(path.join(projectDirOf(), 'occupied'), { recursive: true });
      writeFileScenario('occupied');

      const { code } = await runMockClaude('lead-session');

      expect(code).toBe(1);
      expect(actionsLog()).toMatch(/refusing to replace a non-regular file/);
    });

    it('replaces a hard-linked target without rewriting the outside file', async () => {
      const outside = path.join(tmpBase, 'victim.txt');
      fs.writeFileSync(outside, 'original');
      fs.mkdirSync(projectDirOf(), { recursive: true });
      fs.linkSync(outside, path.join(projectDirOf(), 'victim.txt'));
      writeFileScenario('victim.txt', 'scenario');

      const { code, stderr } = await runMockClaude('lead-session');

      expect(code, stderr).toBe(0);
      expect(fs.readFileSync(outside, 'utf8')).toBe('original');
      expect(fs.readFileSync(path.join(projectDirOf(), 'victim.txt'), 'utf8')).toBe('scenario');
    });

    it('replaces a symlinked target without writing through it', async (ctx) => {
      const outside = path.join(tmpBase, 'link-victim.txt');
      fs.writeFileSync(outside, 'original');
      fs.mkdirSync(projectDirOf(), { recursive: true });
      try {
        fs.symlinkSync(outside, path.join(projectDirOf(), 'link.txt'), 'file');
      } catch {
        ctx.skip(); // file symlinks need Developer Mode / elevation on Windows
      }
      writeFileScenario('link.txt', 'scenario');

      const { code } = await runMockClaude('lead-session');

      expect(code).toBe(1);
      expect(actionsLog()).toMatch(/refusing to replace a non-regular file/);
      expect(fs.readFileSync(outside, 'utf8')).toBe('original');
    });
  });

  it('deletes configured paths with template values', async () => {
    writeScenarioQueue(tmpHome, [
      {
        schemaVersion: 1,
        autoInit: true,
        holdOpenMs: 0,
        sessions: [],
        actions: [
          {
            kind: 'deletePath',
            atMs: 0,
            filePath: '{{transcriptPath}}',
          },
        ],
      },
    ]);

    const { code, stderr } = await runMockClaude('delete-session');

    expect(code, stderr).toBe(0);
    const transcriptPath = path.join(
      tmpHome,
      '.claude',
      'projects',
      workspaceDir.replace(/[^a-zA-Z0-9-]/g, '-'),
      'delete-session.jsonl',
    );
    expect(fs.existsSync(transcriptPath)).toBe(false);
  });
});
