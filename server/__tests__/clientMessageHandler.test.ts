import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  type AssetCache,
  type ClientMessageContext,
  handleClientMessage,
} from '../src/clientMessageHandler.js';
import {
  addRecentLaunchDir,
  getHooksEnabled,
  readConfig,
  setHooksEnabled,
} from '../src/configPersistence.js';
import {
  IDLE_TO_LOUNGE_MINUTES_MAX,
  IDLE_TO_LOUNGE_MINUTES_MIN,
  IDLE_TO_LOUNGE_MS_DEFAULT,
  LOUNGE_TO_LEAVE_MINUTES_MAX,
  LOUNGE_TO_LEAVE_MINUTES_MIN,
  LOUNGE_TO_LEAVE_MS_DEFAULT,
  RECENT_SESSION_LIVE_WINDOW_MS,
} from '../src/constants.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { CLAUDE_HOOK_EVENTS } from '../src/providers/hook/claude/constants.js';
import { PtyHost } from '../src/terminals/ptyHost.js';
import type { AgentState } from '../src/types.js';

// Redirect os.homedir() to a per-test temp dir. Overriding process.env.HOME is
// not portable: on Windows os.homedir() reads USERPROFILE, so a HOME-only
// override read and wrote the developer's REAL ~/.pixel-agents/config.json and
// ~/.claude/settings.json. The mock throws while no test home is set, so a
// call can't fall back to a CWD-relative path; after a test it keeps pointing
// at that test's (deleted) temp dir, so a late async write lands in
// os.tmpdir(). Both the named export and `default` are patched, so
// `import * as os`, `import { homedir }` and `import os from 'os'` all see it
// (a createRequire('os') in src would still bypass it — src doesn't do that).
const testHome = vi.hoisted(() => ({ dir: '' }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const homedir = (): string => {
    if (!testHome.dir) throw new Error('os.homedir() called before a test home was set');
    return testHome.dir;
  };
  return { ...actual, homedir, default: { ...actual, homedir } };
});

/** Let the setHooksEnabled dispatch's async chain (side effect →
 *  areHooksInstalled → persist → send) run to completion. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: 'sess-1',
    terminalRef: undefined,
    isExternal: false,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    contextTokens: 0,
    maxContextTokens: 200_000,
    ...overrides,
  } as AgentState;
}

/**
 * These tests exercise the area-related dispatch branches and the load-order
 * invariant in handleWebviewReady. They isolate the on-disk config + state
 * files by redirecting os.homedir() to a fresh temp dir for every test, so the
 * standalone adapter writes its config.json there.
 */
describe('clientMessageHandler: areas + carpet wire ordering', () => {
  let tempHome: string;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let ctx: ClientMessageContext;

  function freshCtx(cache: AssetCache | null = null): ClientMessageContext {
    return { store, cache, privileged: true };
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-test-'));
    testHome.dir = tempHome;

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    ctx = freshCtx();
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  // ── saveAreaMappings ─────────────────────────────────────────

  describe('saveAreaMappings', () => {
    it('persists a valid mapping payload to cfg.standalone.areaMappings', () => {
      handleClientMessage(
        {
          type: 'saveAreaMappings',
          mappings: { frontend: ['Engineering'], design: ['Engineering', 'Design'] },
        },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({
        frontend: ['Engineering'],
        design: ['Engineering', 'Design'],
      });
    });

    it('is a no-op when mappings is missing or not an object', () => {
      handleClientMessage({ type: 'saveAreaMappings' }, (m) => sent.push(m), ctx);
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: 'not-an-object' },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({});
    });

    it('does not leak into the vscode namespace', () => {
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: { frontend: ['Engineering'] } },
        (m) => sent.push(m),
        ctx,
      );

      const cfg = readConfig();
      expect(cfg.standalone.areaMappings).toEqual({ frontend: ['Engineering'] });
      expect(cfg.vscode.areaMappings).toEqual({});
    });
  });

  // ── setShowAreas ─────────────────────────────────────────────

  describe('setShowAreas', () => {
    it('persists the boolean via the adapter (standalone namespace)', () => {
      handleClientMessage({ type: 'setShowAreas', enabled: true }, (m) => sent.push(m), ctx);

      const adapter = store.getAdapter()!;
      expect(adapter.getSetting('pixel-agents.showAreas', false)).toBe(true);

      handleClientMessage({ type: 'setShowAreas', enabled: false }, (m) => sent.push(m), ctx);
      expect(adapter.getSetting('pixel-agents.showAreas', true)).toBe(false);
    });
  });

  // ── setIdleToLoungeMinutes (living office, docs/adr/0003) ────

  describe('setIdleToLoungeMinutes', () => {
    const minutesOf = (): unknown => readConfig().standalone.idleToLoungeMinutes;
    const settingsLoaded = (): Record<string, unknown> => {
      sent = [];
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);
      return sent.find((m) => m.type === 'settingsLoaded')!;
    };

    it('defaults to 30 minutes in settingsLoaded', () => {
      expect(settingsLoaded().idleToLoungeMinutes).toBe(IDLE_TO_LOUNGE_MS_DEFAULT / 60_000);
    });

    it('persists per namespace, clamped to [MIN, MAX] and rounded', () => {
      ctx.privileged = true;
      const set = (minutes: unknown): void =>
        handleClientMessage({ type: 'setIdleToLoungeMinutes', minutes }, (m) => sent.push(m), ctx);
      set(5);
      expect(minutesOf()).toBe(5);
      expect(settingsLoaded().idleToLoungeMinutes).toBe(5);
      set(100_000);
      expect(minutesOf()).toBe(IDLE_TO_LOUNGE_MINUTES_MAX);
      set(-3);
      expect(minutesOf()).toBe(IDLE_TO_LOUNGE_MINUTES_MIN);
      set(2.6);
      expect(minutesOf()).toBe(3);
      // Junk changes nothing.
      for (const junk of ['10', null, undefined, Number.NaN, Infinity, { n: 1 }]) set(junk);
      expect(minutesOf()).toBe(3);
      // Only this namespace.
      expect(readConfig().vscode.idleToLoungeMinutes).toBe(IDLE_TO_LOUNGE_MS_DEFAULT / 60_000);
    });

    it('updates the running runtime too', () => {
      const runtime = new AgentRuntime(store, claudeProvider);
      try {
        ctx = { store, cache: null, runtime, privileged: true };
        handleClientMessage(
          { type: 'setIdleToLoungeMinutes', minutes: 7 },
          (m) => sent.push(m),
          ctx,
        );
        expect(runtime.idleToLoungeMs()).toBe(7 * 60_000);
        expect(minutesOf()).toBe(7);
      } finally {
        runtime.dispose();
      }
    });

    it('is ignored from a connection without the server token', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      ctx.privileged = false;
      handleClientMessage({ type: 'setIdleToLoungeMinutes', minutes: 1 }, (m) => sent.push(m), ctx);
      warn.mockRestore();
      expect(minutesOf()).toBe(IDLE_TO_LOUNGE_MS_DEFAULT / 60_000);
      expect(fs.existsSync(path.join(tempHome, '.pixel-agents', 'config.json'))).toBe(false);
    });

    it('a hand-edited config out of range is clamped on read', () => {
      fs.mkdirSync(path.join(tempHome, '.pixel-agents'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.pixel-agents', 'config.json'),
        JSON.stringify({ standalone: { idleToLoungeMinutes: 99_999 }, vscode: {} }),
      );
      expect(minutesOf()).toBe(IDLE_TO_LOUNGE_MINUTES_MAX);
      expect(settingsLoaded().idleToLoungeMinutes).toBe(IDLE_TO_LOUNGE_MINUTES_MAX);
    });
  });

  // ── setLoungeToLeaveMinutes + livingOfficeSettings (T24) ──────

  describe('setLoungeToLeaveMinutes and the effective timings', () => {
    const minutesOf = (): unknown => readConfig().standalone.loungeToLeaveMinutes;
    let broadcasts: Array<Record<string, unknown>>;
    const timingsBroadcasts = (): Array<Record<string, unknown>> =>
      broadcasts.filter((m) => m.type === 'livingOfficeSettings');
    const handshake = (): Array<Record<string, unknown>> => {
      sent = [];
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);
      return sent;
    };

    beforeEach(() => {
      broadcasts = [];
      store.on('broadcast', (m) => broadcasts.push(m as Record<string, unknown>));
    });

    it('(e) the handshake sends the effective timings (livingOfficeSettings + settingsLoaded)', () => {
      const msgs = handshake();
      expect(msgs.find((m) => m.type === 'livingOfficeSettings')).toEqual({
        type: 'livingOfficeSettings',
        idleToLoungeMinutes: IDLE_TO_LOUNGE_MS_DEFAULT / 60_000,
        loungeToLeaveMinutes: LOUNGE_TO_LEAVE_MS_DEFAULT / 60_000,
      });
      expect(msgs.find((m) => m.type === 'settingsLoaded')).toMatchObject({
        idleToLoungeMinutes: IDLE_TO_LOUNGE_MS_DEFAULT / 60_000,
        loungeToLeaveMinutes: LOUNGE_TO_LEAVE_MS_DEFAULT / 60_000,
      });
      // Point-to-point: connecting tells nobody else.
      expect(timingsBroadcasts()).toEqual([]);
    });

    it('(d) persists per namespace, clamped and rounded, and broadcasts the effective value to every client', () => {
      ctx.privileged = true;
      const set = (minutes: unknown): void =>
        handleClientMessage({ type: 'setLoungeToLeaveMinutes', minutes }, (m) => sent.push(m), ctx);
      set(90);
      expect(minutesOf()).toBe(90);
      set(100_000);
      expect(minutesOf()).toBe(LOUNGE_TO_LEAVE_MINUTES_MAX);
      set(0);
      expect(minutesOf()).toBe(LOUNGE_TO_LEAVE_MINUTES_MIN);
      set(2.6);
      expect(minutesOf()).toBe(3);
      expect(timingsBroadcasts().map((m) => m.loungeToLeaveMinutes)).toEqual([
        90,
        LOUNGE_TO_LEAVE_MINUTES_MAX,
        LOUNGE_TO_LEAVE_MINUTES_MIN,
        3,
      ]);
      // Junk changes (and announces) nothing.
      for (const junk of ['10', null, undefined, Number.NaN, Infinity, { n: 1 }]) set(junk);
      expect(minutesOf()).toBe(3);
      expect(timingsBroadcasts()).toHaveLength(4);
      // Only this namespace; the next handshake reports it.
      expect(readConfig().vscode.loungeToLeaveMinutes).toBe(LOUNGE_TO_LEAVE_MS_DEFAULT / 60_000);
      expect(handshake().find((m) => m.type === 'livingOfficeSettings')).toMatchObject({
        loungeToLeaveMinutes: 3,
      });
    });

    it('(d) is ignored from a connection without the server token', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      ctx.privileged = false;
      handleClientMessage(
        { type: 'setLoungeToLeaveMinutes', minutes: 5 },
        (m) => sent.push(m),
        ctx,
      );
      handleClientMessage({ type: 'setIdleToLoungeMinutes', minutes: 5 }, (m) => sent.push(m), ctx);
      warn.mockRestore();
      expect(minutesOf()).toBe(LOUNGE_TO_LEAVE_MS_DEFAULT / 60_000);
      expect(timingsBroadcasts()).toEqual([]);
      expect(fs.existsSync(path.join(tempHome, '.pixel-agents', 'config.json'))).toBe(false);
    });

    it('(d) setIdleToLoungeMinutes echoes the effective timings to every client too', () => {
      ctx.privileged = true;
      handleClientMessage(
        { type: 'setIdleToLoungeMinutes', minutes: 9999 },
        (m) => sent.push(m),
        ctx,
      );
      expect(timingsBroadcasts()).toEqual([
        {
          type: 'livingOfficeSettings',
          idleToLoungeMinutes: IDLE_TO_LOUNGE_MINUTES_MAX,
          loungeToLeaveMinutes: LOUNGE_TO_LEAVE_MS_DEFAULT / 60_000,
        },
      ]);
    });

    it('with a running runtime: updates it, persists, and the runtime broadcasts once', () => {
      const runtime = new AgentRuntime(store, claudeProvider);
      try {
        ctx = { store, cache: null, runtime, privileged: true };
        handleClientMessage(
          { type: 'setLoungeToLeaveMinutes', minutes: 45 },
          (m) => sent.push(m),
          ctx,
        );
        handleClientMessage(
          { type: 'setIdleToLoungeMinutes', minutes: 7 },
          (m) => sent.push(m),
          ctx,
        );
        expect(runtime.loungeToLeaveMs()).toBe(45 * 60_000);
        expect(minutesOf()).toBe(45);
        expect(timingsBroadcasts()).toEqual([
          { type: 'livingOfficeSettings', idleToLoungeMinutes: 30, loungeToLeaveMinutes: 45 },
          { type: 'livingOfficeSettings', idleToLoungeMinutes: 7, loungeToLeaveMinutes: 45 },
        ]);
        expect(handshake().find((m) => m.type === 'livingOfficeSettings')).toEqual({
          type: 'livingOfficeSettings',
          idleToLoungeMinutes: 7,
          loungeToLeaveMinutes: 45,
        });
      } finally {
        runtime.dispose();
      }
    });

    it('a hand-edited config out of range is clamped on read', () => {
      fs.mkdirSync(path.join(tempHome, '.pixel-agents'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.pixel-agents', 'config.json'),
        JSON.stringify({ standalone: { loungeToLeaveMinutes: -40 }, vscode: {} }),
      );
      expect(minutesOf()).toBe(LOUNGE_TO_LEAVE_MINUTES_MIN);
      expect(handshake().find((m) => m.type === 'livingOfficeSettings')).toMatchObject({
        loungeToLeaveMinutes: LOUNGE_TO_LEAVE_MINUTES_MIN,
      });
    });
  });

  // ── hooksStatus (actual install state, not the hooksEnabled setting) ──

  describe('hooksStatus', () => {
    it('webviewReady reports installed: false when no hooks are in settings.json', async () => {
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);
      // The provider check is async; the message lands after the sync handshake.
      await new Promise((r) => setTimeout(r, 0));

      const status = sent.find((m) => m.type === 'hooksStatus');
      expect(status).toEqual({ type: 'hooksStatus', providerId: 'claude', installed: false });
    });

    it('setHooksEnabled reports the actual outcome after the side effect settles', async () => {
      let sideEffectRan = false;
      ctx.privileged = true;
      ctx.onSetHooksEnabled = async () => {
        sideEffectRan = true;
      };
      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(sideEffectRan).toBe(true);
      // The side effect installed nothing (stub), so the truthful answer is false
      // even though the user just toggled the setting ON.
      const status = sent.find((m) => m.type === 'hooksStatus');
      expect(status).toEqual({ type: 'hooksStatus', providerId: 'claude', installed: false });
    });
  });

  // ── setHooksEnabled: preference vs reality ───────────────────

  describe('setHooksEnabled persistence', () => {
    /** Put our command on every installed event, as a real install would. */
    function seedInstalledHooks(): void {
      const command = `node "${path.join(tempHome, '.pixel-agents', 'hooks', 'claude-hook.js')}"`;
      const entry = { matcher: '', hooks: [{ type: 'command', command, timeout: 5 }] };
      fs.mkdirSync(path.join(tempHome, '.claude'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.claude', 'settings.json'),
        JSON.stringify({
          hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((e) => [e, [entry]])),
        }),
      );
    }

    // THE stranding bug: the preference was written BEFORE the uninstall, so a
    // failed removal left the entries on disk and still firing while the
    // persisted hooks-off made the next startup skip the consent/install path
    // entirely — never asked again, no route left to remove them.
    it('does not persist hooks-off when the uninstall failed', async () => {
      seedInstalledHooks();
      ctx.privileged = true;
      ctx.onSetHooksEnabled = () => {
        /* the uninstall failed: settings.json still carries our entries */
      };

      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: false },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      // The preference still says ON, so the next startup re-runs the install
      // path and the user keeps a way to turn hooks off.
      expect(getHooksEnabled('claude')).toBe(true);
      // ...and the checkbox is told the truth: they are still installed.
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: true,
      });
    });

    // The mirror case: an install that did not happen must not persist ON.
    it('does not persist hooks-on when the install failed', async () => {
      setHooksEnabled('claude', false);
      ctx.privileged = true;
      ctx.onSetHooksEnabled = () => {
        /* the install failed: settings.json stays empty */
      };

      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(getHooksEnabled('claude')).toBe(false);
    });

    // The happy path still persists, or the toggle would do nothing at all.
    it('persists the preference when the outcome matches the request', async () => {
      ctx.privileged = true;
      ctx.onSetHooksEnabled = () => seedInstalledHooks();

      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(getHooksEnabled('claude')).toBe(true);
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: true,
      });
    });

    // A non-local client (LAN peer, rebound page) never reaches the side effect
    // at all: granting consent to modify ~/.claude/settings.json is not a
    // decision a remote peer gets to make. See httpServerWs.test.ts.
    it('ignores the toggle entirely when the client is not privileged', async () => {
      let sideEffectRan = false;
      ctx.privileged = false;
      ctx.onSetHooksEnabled = () => {
        sideEffectRan = true;
      };

      handleClientMessage(
        { type: 'setHooksEnabled', providerId: 'claude', enabled: true },
        (m) => sent.push(m),
        ctx,
      );
      await settle();

      expect(sideEffectRan).toBe(false);
      expect(getHooksEnabled('claude')).toBe(true);
      // It still hears the truth, so a LAN viewer's checkbox shows reality
      // rather than appearing to have worked.
      expect(sent.find((m) => m.type === 'hooksStatus')).toEqual({
        type: 'hooksStatus',
        providerId: 'claude',
        installed: false,
      });
    });
  });

  // ── handleWebviewReady ordering ──────────────────────────────

  describe('handleWebviewReady ordering', () => {
    it('emits settingsLoaded with showAreas before areaMappingsLoaded before existingAgents', () => {
      // Seed config so the assertion proves the values round-trip via the
      // dispatch rather than just relying on hard-coded defaults.
      handleClientMessage({ type: 'setShowAreas', enabled: true }, (m) => sent.push(m), ctx);
      handleClientMessage(
        { type: 'saveAreaMappings', mappings: { frontend: ['Engineering'] } },
        (m) => sent.push(m),
        ctx,
      );
      sent = [];

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);

      const iSettings = types.indexOf('settingsLoaded');
      const iAreaMappings = types.indexOf('areaMappingsLoaded');
      const iExistingAgents = types.indexOf('existingAgents');

      expect(iSettings).toBeGreaterThanOrEqual(0);
      expect(iAreaMappings).toBeGreaterThanOrEqual(0);
      expect(iExistingAgents).toBeGreaterThanOrEqual(0);
      expect(iSettings).toBeLessThan(iAreaMappings);
      expect(iAreaMappings).toBeLessThan(iExistingAgents);

      const settings = sent[iSettings] as { showAreas?: boolean };
      expect(settings.showAreas).toBe(true);

      const mappings = sent[iAreaMappings] as { mappings?: Record<string, string[]> };
      expect(mappings.mappings).toEqual({ frontend: ['Engineering'] });
    });

    it('emits layoutLoaded after existingAgents so buffered agents materialize', () => {
      // The webview buffers agents from existingAgents and only materializes
      // them on the next layoutLoaded. If layout arrives first, a client
      // connecting after agents were created never renders their characters.
      store.set(1, createTestAgent({ id: 1 }));

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);
      const iExistingAgents = types.indexOf('existingAgents');
      const iLayout = types.indexOf('layoutLoaded');

      expect(iExistingAgents).toBeGreaterThanOrEqual(0);
      expect(iLayout).toBeGreaterThanOrEqual(0);
      expect(iExistingAgents).toBeLessThan(iLayout);

      const existing = sent[iExistingAgents] as { agents?: number[] };
      expect(existing.agents).toEqual([1]);
    });

    it('carries spawn-tree metadata in existingAgents, label only when privileged', () => {
      // A reconnecting client rebuilds the agent tree from agentMeta; the
      // label is transcript content and stays with privileged connections.
      store.set(1, createTestAgent({ id: 1 }));
      store.set(
        2,
        createTestAgent({
          id: 2,
          parentAgentId: 1,
          spawnAgentKey: 'k',
          spawnToolUseId: 'toolu_x',
          role: 'desarrollador',
          label: 'Implementa el login',
          depth: 1,
          presence: 'lounge',
        }),
      );
      const metaOf = (privileged: boolean): Record<string, Record<string, unknown>> => {
        sent = [];
        ctx.privileged = privileged;
        handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);
        const existing = sent.find((m) => m.type === 'existingAgents') as {
          agentMeta: Record<string, Record<string, unknown>>;
        };
        return existing.agentMeta;
      };

      const privileged = metaOf(true);
      expect(privileged['2']).toMatchObject({
        parentAgentId: 1,
        role: 'desarrollador',
        depth: 1,
        label: 'Implementa el login',
        presence: 'lounge',
      });
      expect(privileged['1'].parentAgentId).toBeUndefined();
      expect(privileged['1'].presence).toBeUndefined();

      const unprivileged = metaOf(false);
      expect(unprivileged['2']).toMatchObject({
        parentAgentId: 1,
        role: 'desarrollador',
        depth: 1,
      });
      expect(unprivileged['2'].label).toBeUndefined();
    });

    it('replays agent activity after layoutLoaded so it lands on real characters', () => {
      // Two things at once, both invisible to the helper's own unit tests:
      // that handleWebviewReady calls the replay at all, and that it runs AFTER
      // layoutLoaded. The characters the replay targets only exist once the
      // layout flush creates them, so an earlier replay is silently dropped and
      // a reconnecting client shows a working agent as Idle.
      store.set(1, createTestAgent({ id: 1, isWaiting: true }));

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);
      const iLayout = types.indexOf('layoutLoaded');
      const iStatus = types.indexOf('agentStatus');

      expect(iLayout).toBeGreaterThanOrEqual(0);
      expect(iStatus).toBeGreaterThanOrEqual(0);
      expect(iLayout).toBeLessThan(iStatus);

      expect(sent[iStatus]).toMatchObject({ type: 'agentStatus', id: 1, status: 'waiting' });
    });

    it('emits carpetTilesLoaded after wallTilesLoaded when both are present in the cache', () => {
      // Hex placeholders are test fixtures, not UI tokens — disable the
      // centralized-color rule just for this cache literal.
      /* eslint-disable pixel-agents/no-inline-colors */
      const cache: AssetCache = {
        characters: null,
        pets: null,
        floorTiles: [[['#000000']]],
        wallTiles: [[[['#aabbcc']]]],
        carpetTiles: [[[['#112233']]]],
        furniture: null,
        defaultLayout: null,
      };
      /* eslint-enable pixel-agents/no-inline-colors */
      ctx = freshCtx(cache);

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const types = sent.map((m) => m.type);
      const iWalls = types.indexOf('wallTilesLoaded');
      const iCarpets = types.indexOf('carpetTilesLoaded');

      expect(iWalls).toBeGreaterThanOrEqual(0);
      expect(iCarpets).toBeGreaterThanOrEqual(0);
      expect(iWalls).toBeLessThan(iCarpets);
    });

    it('skips carpetTilesLoaded when the cache has no carpet sprites', () => {
      const cache: AssetCache = {
        characters: null,
        pets: null,
        floorTiles: null,
        wallTiles: null,
        carpetTiles: null,
        furniture: null,
        defaultLayout: null,
      };
      ctx = freshCtx(cache);

      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const carpetMsgs = sent.filter((m) => m.type === 'carpetTilesLoaded');
      expect(carpetMsgs).toHaveLength(0);
    });

    it('always emits areaMappingsLoaded, even with no persisted mappings (sends {})', () => {
      handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), ctx);

      const areaMsgs = sent.filter((m) => m.type === 'areaMappingsLoaded');
      expect(areaMsgs).toHaveLength(1);
      expect((areaMsgs[0] as { mappings: Record<string, string[]> }).mappings).toEqual({});
    });
  });
});

describe('clientMessageHandler: saveAgentSeats palette sync', () => {
  let tempHome: string;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let ctx: ClientMessageContext;

  function freshCtx(cache: AssetCache | null = null): ClientMessageContext {
    return { store, cache, privileged: true };
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-seats-'));
    testHome.dir = tempHome;

    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    sent = [];
    ctx = freshCtx();
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('syncs in-range palette/hueShift onto the matching AgentState', () => {
    store.set(1, createTestAgent({ id: 1 }));
    store.set(2, createTestAgent({ id: 2, palette: 0, hueShift: 0 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: {
          '1': { palette: 4, hueShift: 120, seatId: 'seat-a' },
          '2': { palette: 2, hueShift: 60, seatId: 'seat-b' },
        },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(4);
    expect(store.get(1)?.hueShift).toBe(120);
    expect(store.get(2)?.palette).toBe(2);
    expect(store.get(2)?.hueShift).toBe(60);
  });

  it('drops an out-of-range palette and keeps the existing value', () => {
    store.set(1, createTestAgent({ id: 1, palette: 1, hueShift: 10 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 99, hueShift: 50, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(1);
    // hueShift 50 is in range → still synced.
    expect(store.get(1)?.hueShift).toBe(50);
  });

  it('drops a negative hue shift and keeps the existing value', () => {
    store.set(1, createTestAgent({ id: 1, palette: 0, hueShift: 30 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 2, hueShift: -5, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    // palette 2 is in range → synced.
    expect(store.get(1)?.palette).toBe(2);
    expect(store.get(1)?.hueShift).toBe(30);
  });

  it('drops a non-integer palette and keeps the existing value', () => {
    store.set(1, createTestAgent({ id: 1, palette: 5, hueShift: 0 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 2.5, hueShift: 90, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(5);
    expect(store.get(1)?.hueShift).toBe(90);
  });

  it('accepts the upper hue boundary (360) and lower palette boundary (0)', () => {
    store.set(1, createTestAgent({ id: 1 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 0, hueShift: 360, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(0);
    expect(store.get(1)?.hueShift).toBe(360);
  });

  it('silently skips seat entries for unknown agent ids', () => {
    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '999': { palette: 3, hueShift: 100, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(999)).toBeUndefined();
  });

  it('accepts palette 7 when the cache has 8 character sprites', () => {
    // The guard reads ctx.cache?.characters?.characters.length instead
    // of hardcoding PALETTE_COUNT. With 8 sprites, palette 7 is valid.
    const cache: AssetCache = {
      characters: {
        characters: [
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
          { down: [[[]]], up: [[[]]], right: [[[]]] },
        ],
      },
      pets: null,
      floorTiles: null,
      wallTiles: null,
      carpetTiles: null,
      furniture: null,
      defaultLayout: null,
    };
    ctx = freshCtx(cache);
    store.set(1, createTestAgent({ id: 1 }));

    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 7, hueShift: 90, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );

    expect(store.get(1)?.palette).toBe(7);
    // palette 8 is still out of range for 8 sprites → dropped.
    handleClientMessage(
      {
        type: 'saveAgentSeats',
        seats: { '1': { palette: 8, hueShift: 90, seatId: null } },
      },
      (m) => sent.push(m),
      ctx,
    );
    expect(store.get(1)?.palette).toBe(7);
  });
});

/**
 * An untokened connection is a viewer: it watches the office and nothing more.
 * Every message that writes under ~/.pixel-agents, changes what the server
 * watches, or reads paths off disk needs the operator's token — gated once,
 * before dispatch, so a message added later is closed by default.
 */
describe('clientMessageHandler: an untokened viewer cannot change anything', () => {
  let tempHome: string;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  let ctx: ClientMessageContext;
  const closeAgent = vi.fn();
  const dismiss = vi.fn();
  const requestTakeover = vi.fn();
  const cancelTakeover = vi.fn();

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-viewer-'));
    testHome.dir = tempHome;
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    store.set(1, createTestAgent({ id: 1, palette: 1, hueShift: 10 }));
    sent = [];
    closeAgent.mockClear();
    dismiss.mockClear();
    requestTakeover.mockClear();
    cancelTakeover.mockClear();
    const runtime = {
      closeAgent,
      requestTakeover,
      cancelTakeover,
      dismissalTracker: { dismiss },
      watchAllSessions: { current: false },
    } as unknown as AgentRuntime;
    ctx = { store, cache: null, runtime, privileged: false };
  });

  afterEach(() => {
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  const dispatch = (msg: Record<string, unknown>): void =>
    handleClientMessage(msg, (m) => sent.push(m), ctx);

  it('cannot close an agent', () => {
    dispatch({ type: 'closeAgent', id: 1 });
    expect(closeAgent).not.toHaveBeenCalled();
    expect(dismiss).not.toHaveBeenCalled();
  });

  it('cannot overwrite the layout', () => {
    dispatch({ type: 'saveLayout', layout: { version: 1, cols: 1, rows: 1, tiles: [0] } });
    expect(fs.existsSync(path.join(tempHome, '.pixel-agents', 'layout.json'))).toBe(false);
  });

  it('cannot add or remove an external asset directory', () => {
    dispatch({ type: 'addExternalAssetDirectory', path: '/etc' });
    dispatch({ type: 'removeExternalAssetDirectory', path: '/etc' });
    expect(readConfig().externalAssetDirectories).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('cannot rewrite seats, area mappings or settings', () => {
    dispatch({ type: 'saveAgentSeats', seats: { '1': { palette: 4, hueShift: 90 } } });
    dispatch({ type: 'saveAreaMappings', mappings: { x: ['y'] } });
    dispatch({ type: 'setSoundEnabled', enabled: false });
    expect(store.get(1)?.palette).toBe(1);
    expect(store.get(1)?.hueShift).toBe(10);
    expect(readConfig().standalone.areaMappings).toEqual({});
    expect(store.getAdapter()?.getSetting('pixel-agents.soundEnabled', true)).toBe(true);
  });

  it('cannot make the server watch every session on the machine', () => {
    dispatch({ type: 'setWatchAllSessions', enabled: true });
    expect(ctx.runtime?.watchAllSessions.current).toBe(false);
  });

  it('gets no diagnostics (they carry transcript paths)', () => {
    dispatch({ type: 'requestDiagnostics' });
    expect(sent).toEqual([]);
  });

  it('still connects and watches the office', () => {
    ctx.runtime = undefined;
    dispatch({ type: 'webviewReady' });
    expect(sent.some((m) => m.type === 'existingAgents')).toBe(true);
  });

  it('the operator (tokened) still can', () => {
    ctx.privileged = true;
    dispatch({ type: 'closeAgent', id: 1 });
    expect(closeAgent).toHaveBeenCalledWith(1);
  });

  it('cannot bring an agent into the office nor cancel it', () => {
    dispatch({ type: 'takeOverAgent', id: 1 });
    dispatch({ type: 'takeOverAgent', id: 1, confirmClosed: true });
    dispatch({ type: 'cancelTakeover', id: 1 });
    expect(requestTakeover).not.toHaveBeenCalled();
    expect(cancelTakeover).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('the operator can bring an agent in (integer ids only) and cancel it', () => {
    ctx.privileged = true;
    dispatch({ type: 'takeOverAgent', id: 1 });
    dispatch({ type: 'takeOverAgent', id: 1, confirmClosed: true });
    dispatch({ type: 'takeOverAgent', id: '1' });
    dispatch({ type: 'takeOverAgent', id: 1.5 });
    dispatch({ type: 'cancelTakeover', id: 1 });
    dispatch({ type: 'cancelTakeover', id: 'x' });
    expect(requestTakeover.mock.calls).toEqual([
      [1, { confirmClosed: false }],
      [1, { confirmClosed: true }],
    ]);
    expect(cancelTakeover.mock.calls).toEqual([[1]]);
  });
});

/** Long enough ago to sit outside RECENT_SESSION_LIVE_WINDOW_MS (listRecentSessions
 *  otherwise treats a just-written transcript as probably still open elsewhere). */
const OLD_ENOUGH_MS = RECENT_SESSION_LIVE_WINDOW_MS + 5 * 60_000;

describe('clientMessageHandler: office consoles', () => {
  let tempHome: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let sent: Array<Record<string, unknown>>;
  let written: string[];
  let workDir: string;
  let spawnCalls: Array<{ file: string; args: string[]; cwd: string }>;

  /** A synthetic top-level session transcript under this test's HOME, in the
   *  shape claudeProvider.getAllSessionRoots() (~/.claude/projects) reads: one
   *  `cwd`-carrying JSONL record, aged past RECENT_SESSION_LIVE_WINDOW_MS by
   *  default so listRecentSessions doesn't exclude it as still-open. */
  function writeSyntheticSession(
    sessionId: string,
    opts: { cwd: string; text?: string; mtimeMsAgo?: number },
  ): string {
    const projectDir = path.join(tempHome, '.claude', 'projects', 'synthetic-project');
    fs.mkdirSync(projectDir, { recursive: true });
    const file = path.join(projectDir, `${sessionId}.jsonl`);
    const record = {
      type: 'user',
      cwd: opts.cwd,
      message: { content: opts.text ?? 'hola oficina' },
    };
    fs.writeFileSync(file, `${JSON.stringify(record)}\n`);
    const mtime = new Date(Date.now() - (opts.mtimeMsAgo ?? OLD_ENOUGH_MS));
    fs.utimesSync(file, mtime, mtime);
    return file;
  }

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-console-'));
    testHome.dir = tempHome;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-work-'));
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    runtime = new AgentRuntime(store, claudeProvider);
    written = [];
    spawnCalls = [];
    runtime.attachPtyHost(
      new PtyHost((file, args, opts) => {
        spawnCalls.push({ file, args, cwd: opts.cwd });
        return {
          pid: 1,
          onData: () => ({ dispose() {} }),
          onExit: () => ({ dispose() {} }),
          write: (d: string) => written.push(d),
          resize: () => {},
          kill: () => {},
        };
      }),
    );
    sent = [];
  });

  afterEach(() => {
    runtime.dispose();
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const ctx = (privileged: boolean, connId = 'c1'): ClientMessageContext => ({
    store,
    runtime,
    cache: null,
    privileged,
    connId,
  });
  const dispatch = (msg: Record<string, unknown>, c = ctx(true)) =>
    handleClientMessage(msg, (m) => sent.push(m), c);

  it('launchAgent answers launchResult with the new agent and its console', () => {
    dispatch({ type: 'launchAgent', folderPath: workDir });
    const r = sent.find((m) => m.type === 'launchResult')!;
    expect(r.ok).toBe(true);
    expect(store.get(r.agentId as number)?.terminalId).toBe(r.terminalId);
  });

  it('launchAgent into a missing folder answers ok:false with the reason', () => {
    dispatch({ type: 'launchAgent', folderPath: path.join(workDir, 'nope') });
    expect(sent.find((m) => m.type === 'launchResult')).toMatchObject({ ok: false });
    expect(store.size).toBe(0);
  });

  it('a viewer can neither launch nor attach nor type', () => {
    dispatch({ type: 'launchAgent', folderPath: workDir });
    const id = sent.find((m) => m.type === 'launchResult')!.terminalId as string;
    sent = [];
    dispatch({ type: 'launchAgent', folderPath: workDir }, ctx(false, 'v1'));
    dispatch({ type: 'terminalAttach', terminalId: id }, ctx(false, 'v1'));
    dispatch({ type: 'terminalInput', terminalId: id, data: 'rm -rf /\r' }, ctx(false, 'v1'));
    expect(sent).toEqual([]);
    expect(written).toEqual([]);
    expect(store.size).toBe(1);
  });

  it('input only goes to a console this connection attached to', () => {
    dispatch({ type: 'launchAgent', folderPath: workDir });
    const id = sent.find((m) => m.type === 'launchResult')!.terminalId as string;
    dispatch({ type: 'terminalInput', terminalId: id, data: 'x' }, ctx(true, 'other'));
    expect(written).toEqual([]);
    dispatch({ type: 'terminalAttach', terminalId: id }, ctx(true, 'other'));
    dispatch({ type: 'terminalInput', terminalId: id, data: 'hola\r' }, ctx(true, 'other'));
    expect(written).toEqual(['hola\r']);
  });

  it('oversized or non-string input is dropped; unknown ids are ignored', () => {
    dispatch({ type: 'launchAgent', folderPath: workDir });
    const id = sent.find((m) => m.type === 'launchResult')!.terminalId as string;
    dispatch({ type: 'terminalAttach', terminalId: id });
    dispatch({ type: 'terminalInput', terminalId: id, data: 'x'.repeat(64 * 1024 + 1) });
    dispatch({ type: 'terminalInput', terminalId: id, data: 42 });
    dispatch({ type: 'terminalInput', terminalId: 'nope', data: 'x' });
    expect(written).toEqual([]);
  });

  it('attaching to an unknown or closed console answers that it is gone', () => {
    dispatch({ type: 'terminalAttach', terminalId: 'nope' });
    expect(sent).toEqual([{ type: 'terminalExit', terminalId: 'nope', exitCode: -1 }]);
  });

  it('terminalClose kills the console and removes its agent', () => {
    dispatch({ type: 'launchAgent', folderPath: workDir });
    const r = sent.find((m) => m.type === 'launchResult')!;
    dispatch({ type: 'terminalClose', terminalId: r.terminalId });
    expect(store.get(r.agentId as number)).toBeUndefined();
  });

  it('webviewReady tells a privileged client it may launch, with projects and recent sessions', () => {
    const sessionId = crypto.randomUUID();
    writeSyntheticSession(sessionId, { cwd: workDir, text: 'arregla el login' });

    dispatch({ type: 'webviewReady' });

    expect(sent.find((m) => m.type === 'providerCapabilities')).toMatchObject({ terminals: true });
    const launchOptions = sent.find((m) => m.type === 'launchOptions');
    expect(launchOptions?.projects).toEqual(
      expect.arrayContaining([expect.objectContaining({ cwd: workDir })]),
    );
    expect(launchOptions?.recentSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId, cwd: workDir, title: 'arregla el login' }),
      ]),
    );
  });

  it('webviewReady re-sends a pending takeover to a privileged client, after existingAgents', () => {
    const sessionId = crypto.randomUUID();
    const jsonlFile = writeSyntheticSession(sessionId, { cwd: workDir });
    store.set(
      5,
      createTestAgent({
        id: 5,
        sessionId,
        isExternal: true,
        jsonlFile,
        projectDir: path.dirname(jsonlFile),
      }),
    );
    runtime.requestTakeover(5);
    expect(runtime.pendingTakeoverIds()).toEqual([5]);

    // A WS reconnect without a server restart: the mark is still there.
    dispatch({ type: 'webviewReady' });
    const types = sent.map((m) => m.type);
    const statusAt = types.indexOf('takeoverStatus');
    expect(sent[statusAt]).toEqual({ type: 'takeoverStatus', id: 5, state: 'waitingExit' });
    expect(statusAt).toBeGreaterThan(types.indexOf('existingAgents'));

    // A viewer gets no such resend (its panel shows no takeover controls).
    sent = [];
    dispatch({ type: 'webviewReady' }, ctx(false, 'v1'));
    expect(sent.some((m) => m.type === 'takeoverStatus')).toBe(false);
  });

  it('a viewer is told consoles are unavailable and gets no launch options', () => {
    // The runtime HAS a pty host here: only the privilege check keeps it hidden.
    expect(runtime.ptyHost).toBeTruthy();
    dispatch({ type: 'webviewReady' }, ctx(false, 'v1'));
    expect(sent.some((m) => m.type === 'providerCapabilities')).toBe(true);
    expect(sent.find((m) => m.type === 'providerCapabilities')?.terminals).toBeFalsy();
    expect(sent.some((m) => m.type === 'launchOptions')).toBe(false);
  });

  it('requestLaunchOptions answers a privileged client with launchOptions', () => {
    const sessionId = crypto.randomUUID();
    writeSyntheticSession(sessionId, { cwd: workDir });

    dispatch({ type: 'requestLaunchOptions' });

    const launchOptions = sent.find((m) => m.type === 'launchOptions');
    expect(launchOptions).toBeTruthy();
    expect(launchOptions?.recentSessions).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId })]),
    );
  });

  it('requestLaunchOptions from a viewer answers nothing (central gate)', () => {
    dispatch({ type: 'requestLaunchOptions' }, ctx(false, 'v1'));
    expect(sent).toEqual([]);
  });

  it('launchAgent with resumeSessionId resumes the session with --resume, ignoring folderPath', () => {
    const sessionId = crypto.randomUUID();
    writeSyntheticSession(sessionId, { cwd: workDir });

    dispatch({ type: 'launchAgent', resumeSessionId: sessionId, folderPath: '/should/be/ignored' });

    const result = sent.find((m) => m.type === 'launchResult')!;
    expect(result.ok).toBe(true);
    expect(store.get(result.agentId as number)?.sessionId).toBe(sessionId);
    const spawn = spawnCalls.find((c) => c.args.includes(sessionId));
    expect(spawn?.args).toEqual(expect.arrayContaining(['--resume', sessionId]));
    expect(spawn?.cwd).toBe(fs.realpathSync.native(workDir));
  });

  it('launchAgent without folderPath or resumeSessionId answers "Choose a folder"', () => {
    dispatch({ type: 'launchAgent' });
    expect(sent.find((m) => m.type === 'launchResult')).toMatchObject({
      ok: false,
      error: 'Choose a folder',
    });
    expect(store.size).toBe(0);
  });

  it('recentSessions excludes a session with a live agent already in the store', () => {
    const liveSessionId = crypto.randomUUID();
    writeSyntheticSession(liveSessionId, { cwd: workDir });

    // A live agent for that session, as if it had already been launched/adopted.
    dispatch({ type: 'launchAgent', folderPath: workDir });
    const launched = sent.find((m) => m.type === 'launchResult')!;
    store.get(launched.agentId as number)!.sessionId = liveSessionId;
    sent = [];

    dispatch({ type: 'requestLaunchOptions' });
    const launchOptions = sent.find((m) => m.type === 'launchOptions');
    expect(
      (launchOptions?.recentSessions as Array<{ sessionId: string }>).some(
        (s) => s.sessionId === liveSessionId,
      ),
    ).toBe(false);
  });

  it('a recent launch dir that was deleted is absent from launchOptions.projects', () => {
    const deletedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-deleted-'));
    addRecentLaunchDir(deletedDir);
    addRecentLaunchDir(workDir);
    fs.rmSync(deletedDir, { recursive: true, force: true });

    dispatch({ type: 'requestLaunchOptions' });

    const launchOptions = sent.find((m) => m.type === 'launchOptions');
    const cwds = (launchOptions?.projects as Array<{ cwd: string }>).map((p) => p.cwd);
    expect(cwds).not.toContain(deletedDir);
    expect(cwds).toContain(workDir);
  });

  it('requestLaunchOptions from a privileged connection with no PtyHost sends nothing', () => {
    const runtimeNoPty = new AgentRuntime(store, claudeProvider);
    try {
      expect(runtimeNoPty.ptyHost).toBeNull();
      handleClientMessage({ type: 'requestLaunchOptions' }, (m) => sent.push(m), {
        store,
        runtime: runtimeNoPty,
        cache: null,
        privileged: true,
        connId: 'c1',
      });
      expect(sent).toEqual([]);
    } finally {
      runtimeNoPty.dispose();
    }
  });
});
