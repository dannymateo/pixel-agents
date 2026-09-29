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
    return { dispose() {} };
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
});
