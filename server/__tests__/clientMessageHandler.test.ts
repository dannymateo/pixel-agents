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
import { getHooksEnabled, readConfig, setHooksEnabled } from '../src/configPersistence.js';
import {
  IDLE_TO_LOUNGE_MINUTES_MAX,
  IDLE_TO_LOUNGE_MINUTES_MIN,
  IDLE_TO_LOUNGE_MS_DEFAULT,
} from '../src/constants.js';
import { FileStateAdapter } from '../src/fileStateAdapter.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { CLAUDE_HOOK_EVENTS } from '../src/providers/hook/claude/constants.js';
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
    return { store, cache };
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
    return { store, cache };
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
