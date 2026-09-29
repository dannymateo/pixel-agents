import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agentCreatedMessage, agentTreeMeta } from '../src/agentMessages.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { PtyHost } from '../src/terminals/ptyHost.js';
import type { PtyFactory, PtyProcess } from '../src/terminals/ptyTypes.js';

const testHome = vi.hoisted(() => ({ dir: '' }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const homedir = (): string => {
    if (!testHome.dir) throw new Error('os.homedir() called before a test home was set');
    return testHome.dir;
  };
  return { ...actual, homedir, default: { ...actual, homedir } };
});

class FakePty implements PtyProcess {
  readonly pid = 1;
  killed = false;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;
  onData() {
    return { dispose() {} };
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb;
    // Like node-pty: a disposed listener hears nothing more.
    return {
      dispose: () => {
        if (this.exitCb === cb) this.exitCb = null;
      },
    };
  }
  write() {}
  resize() {}
  kill() {
    this.killed = true;
    this.exitCb?.({ exitCode: 1 });
  }
  exit(code: number) {
    this.exitCb?.({ exitCode: code });
  }
}

describe('AgentRuntime.launchOfficeAgent', () => {
  let tmp: string;
  let workDir: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let ptys: FakePty[];
  let spawned: Array<{ file: string; args: string[]; cwd: string; env: Record<string, string> }>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-launch-'));
    testHome.dir = path.join(tmp, 'home');
    fs.mkdirSync(testHome.dir);
    workDir = path.join(tmp, 'Mis Proyectos');
    fs.mkdirSync(workDir);
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    ptys = [];
    spawned = [];
    const factory: PtyFactory = (file, args, o) => {
      spawned.push({ file, args, cwd: o.cwd, env: o.env });
      const p = new FakePty();
      ptys.push(p);
      return p;
    };
    runtime.attachPtyHost(new PtyHost(factory));
  });

  afterEach(() => {
    runtime.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates an internal agent bound to its console, with a fresh session id', () => {
    const { agentId, terminalId } = runtime.launchOfficeAgent({ cwd: workDir });
    const agent = store.get(agentId)!;
    expect(agent.terminalId).toBe(terminalId);
    expect(agent.isExternal).toBe(false);
    expect(agent.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(agent.jsonlFile.endsWith(`${agent.sessionId}.jsonl`)).toBe(true);
    expect(spawned[0].cwd).toBe(workDir);
    expect(spawned[0].args).toContain('--session-id');
    expect(spawned[0].args).toContain(agent.sessionId);
    expect(runtime.agentIdForTerminal(terminalId)).toBe(agentId);
  });

  it('passes bypassPermissions through to the launch command', () => {
    runtime.launchOfficeAgent({ cwd: workDir, bypassPermissions: true });
    expect(spawned[0].args).toContain('--dangerously-skip-permissions');
  });

  it('strips only the nested-session markers from the console env', () => {
    const saved = { ...process.env };
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.PIXEL_AGENTS_MOCK_CONSOLE = '1';
    try {
      runtime.launchOfficeAgent({ cwd: workDir });
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
    const env = spawned[0].env;
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    expect(env.PIXEL_AGENTS_MOCK_CONSOLE).toBe('1');
  });

  it('refuses a cwd that is not an existing absolute directory', () => {
    expect(() => runtime.launchOfficeAgent({ cwd: 'relative/dir' })).toThrow(/folder/i);
    expect(() => runtime.launchOfficeAgent({ cwd: path.join(tmp, 'missing') })).toThrow(/folder/i);
    expect(store.size).toBe(0);
  });

  it('refuses when no pty host is attached (terminals unavailable)', () => {
    const bare = new AgentRuntime(new AgentStateStore(), claudeProvider);
    expect(() => bare.launchOfficeAgent({ cwd: workDir })).toThrow(/not available/i);
    bare.dispose();
  });

  it('the console ending removes its agent', () => {
    const { agentId } = runtime.launchOfficeAgent({ cwd: workDir });
    ptys[0].exit(0);
    expect(store.get(agentId)).toBeUndefined();
  });

  it('a cwd with a trailing separator and .. segments resolves to the same project dir as its canonical form', () => {
    fs.mkdirSync(path.join(workDir, 'sub'));
    const messyCwd = path.join(workDir, 'sub', '..') + path.sep;
    const { agentId } = runtime.launchOfficeAgent({ cwd: messyCwd });
    const agent = store.get(agentId)!;
    const canonical = fs.realpathSync.native(workDir);
    expect(spawned[0].cwd).toBe(canonical);
    expect(agent.projectDir).toBe(claudeProvider.getSessionDirs!(canonical)[0]);
  });

  it('removing the agent kills its console and tells attached viewers it is gone', () => {
    const { agentId, terminalId } = runtime.launchOfficeAgent({ cwd: workDir });
    const got: Array<Record<string, unknown>> = [];
    runtime.terminalHub!.attach('c1', terminalId, (m) => got.push(m));
    runtime.removeAgent(agentId);
    expect(ptys[0].killed).toBe(true);
    expect(got.at(-1)).toEqual({ type: 'terminalExit', terminalId, exitCode: -1 });
    expect(runtime.terminalHub!.isAttached('c1', terminalId)).toBe(false);
  });

  it('dispose kills every live console', () => {
    runtime.launchOfficeAgent({ cwd: workDir });
    runtime.launchOfficeAgent({ cwd: workDir });
    runtime.dispose();
    expect(ptys.map((p) => p.killed)).toEqual([true, true]);
  });

  it('a failure after the console opened closes it instead of orphaning it', () => {
    const broken = new AgentRuntime(new AgentStateStore(), {
      ...claudeProvider,
      getSessionDirs: () => {
        throw new Error('boom');
      },
    });
    const brokenPtys: FakePty[] = [];
    const host = new PtyHost(() => {
      const p = new FakePty();
      brokenPtys.push(p);
      return p;
    });
    broken.attachPtyHost(host);
    try {
      expect(() => broken.launchOfficeAgent({ cwd: workDir })).toThrow(/boom/);
      expect(brokenPtys[0].killed).toBe(true);
      expect(host.size).toBe(0);
    } finally {
      broken.dispose();
    }
  });

  it('disposeAndWait kills the consoles and resolves once they exited', async () => {
    runtime.launchOfficeAgent({ cwd: workDir });
    await runtime.disposeAndWait(10_000);
    expect(ptys[0].killed).toBe(true);
    expect(store.size).toBe(0);
  });

  it('terminalId reaches only privileged connections', () => {
    const { agentId, terminalId } = runtime.launchOfficeAgent({ cwd: workDir });
    const agent = store.get(agentId)!;
    expect(agentCreatedMessage(agent, true).terminalId).toBe(terminalId);
    expect(agentCreatedMessage(agent, false).terminalId).toBeUndefined();
    expect(agentTreeMeta(agent, true).terminalId).toBe(terminalId);
    expect(agentTreeMeta(agent, false).terminalId).toBeUndefined();
  });

  describe('resumeSessionId', () => {
    const SID = '5b3c1f0e-2a4d-4e8f-9c1b-7d6e5f4a3b2c';

    function seedTranscript(cwd: string): string {
      const projectDir = path.join(testHome.dir, '.claude', 'projects', 'C--proj');
      fs.mkdirSync(projectDir, { recursive: true });
      const file = path.join(projectDir, `${SID}.jsonl`);
      fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd }) + '\n');
      return file;
    }

    it('resumes an existing session with its own cwd, transcript and file offset', () => {
      const jsonl = seedTranscript(workDir);
      const { agentId } = runtime.launchOfficeAgent({ resumeSessionId: SID });
      const agent = store.get(agentId)!;
      expect(spawned[0].args).toContain('--resume');
      expect(spawned[0].args).toContain(SID);
      expect(spawned[0].cwd).toBe(fs.realpathSync.native(workDir));
      expect(agent.sessionId).toBe(SID);
      expect(agent.jsonlFile).toBe(jsonl);
      expect(agent.fileOffset).toBe(fs.statSync(jsonl).size);
    });

    it('refuses an unknown session id', () => {
      expect(() => runtime.launchOfficeAgent({ resumeSessionId: SID })).toThrow(/Unknown session/);
      expect(store.size).toBe(0);
      expect(spawned.length).toBe(0);
    });

    it('refuses when the transcript cwd no longer exists', () => {
      seedTranscript(path.join(tmp, 'gone'));
      expect(() => runtime.launchOfficeAgent({ resumeSessionId: SID })).toThrow(/no longer exists/);
      expect(store.size).toBe(0);
      expect(spawned.length).toBe(0);
    });

    it('refuses an unsafe session id without reading outside the roots', () => {
      expect(() => runtime.launchOfficeAgent({ resumeSessionId: '../x' })).toThrow(
        /Unknown session/,
      );
      expect(spawned.length).toBe(0);
    });

    it('refuses a session already open in the office', () => {
      const jsonl = seedTranscript(workDir);
      runtime.launchOfficeAgent({ resumeSessionId: SID });
      spawned.length = 0;
      expect(() => runtime.launchOfficeAgent({ resumeSessionId: SID })).toThrow(/already open/);
      expect(spawned.length).toBe(0);
      // still exactly one agent for that session
      expect([...store.values()].filter((a) => a.jsonlFile === jsonl).length).toBe(1);
    });
  });
});
