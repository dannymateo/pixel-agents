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
  let spawned: Array<{ file: string; args: string[]; cwd: string }>;

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
      spawned.push({ file, args, cwd: o.cwd });
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

  it('terminalId reaches only privileged connections', () => {
    const { agentId, terminalId } = runtime.launchOfficeAgent({ cwd: workDir });
    const agent = store.get(agentId)!;
    expect(agentCreatedMessage(agent, true).terminalId).toBe(terminalId);
    expect(agentCreatedMessage(agent, false).terminalId).toBeUndefined();
    expect(agentTreeMeta(agent, true).terminalId).toBe(terminalId);
    expect(agentTreeMeta(agent, false).terminalId).toBeUndefined();
  });
});
