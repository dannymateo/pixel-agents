/**
 * Session Detection: Dual-Mode Architecture
 *
 * HOOKS MODE (preferred): Claude Code Hooks API delivers instant, reliable events
 * for session lifecycle (SessionStart, SessionEnd, Stop, PermissionRequest, etc.).
 * When hooks work, per-agent heuristic timers and terminal adoption scans are
 * suppressed. The hookDelivered flag per agent and hooksEnabledRef globally
 * control the switch.
 *
 * HEURISTIC MODE (fallback): For environments without hooks (other providers,
 * hooks disabled, older Claude versions). Uses:
 * - Per-agent 500ms JSONL polling for tool activity and /clear detection
 * - 1s main scanner for terminal adoption
 * - 30s stale check for orphaned external agents
 * - Multiple dismissal systems to prevent re-adoption races
 *
 * EXTERNAL SESSION DISCOVERY: The 3s external scanner runs in both hooks and
 * heuristic modes because not every JSONL producer emits Claude Code hooks.
 *
 * JSONL POLLING (always active): readNewLines + processTranscriptLine run in both
 * modes. They provide tool content (status text, animations) that hooks don't carry.
 * Only their timer logic (permission 7s, text-idle 5s) is suppressed by hookDelivered.
 */
import * as fs from 'fs';
import * as path from 'path';
import type * as vscode from 'vscode';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

import type { HookProvider } from '../../core/src/provider.js';
import type { TeamProvider } from '../../core/src/teamProvider.js';
import type { ITerminalAdapter } from '../../core/src/terminalAdapter.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  CLEAR_IDLE_THRESHOLD_MS,
  DEFAULT_MAX_CONTEXT_TOKENS,
  EXTERNAL_ACTIVE_THRESHOLD_MS,
  EXTERNAL_SCAN_INTERVAL_MS,
  EXTERNAL_STALE_CHECK_INTERVAL_MS,
  FILE_WATCHER_POLL_INTERVAL_MS,
  GLOBAL_SCAN_ACTIVE_MAX_AGE_MS,
  GLOBAL_SCAN_ACTIVE_MIN_SIZE,
  MAX_DERIVED_AGENTS_PER_TREE,
  MAX_PENDING_WORKFLOW_LAUNCHES,
  MAX_SPAWN_DEPTH,
  PROJECT_SCAN_INTERVAL_MS,
  RESTORED_SPAWN_MAX_IDLE_MS,
  SPAWN_SEED_MAX_BYTES,
  SPAWN_SEED_READ_CHUNK_BYTES,
  SPAWN_SIBLING_HUE_STEP_DEG,
} from './constants.js';
import { seedContextUsage } from './contextUsage.js';
import type { DismissalTracker } from './dismissalTracker.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import { PathSet, pathsMatch } from './pathKey.js';
// The one Claude-specific import of the runtime: the run-directory ↔ session
// binding the workflow launch gate needs (TeamProvider exposes no such check).
import type { SpawnEntry, SpawnTreeNode } from './spawnTree.js';
import { planSpawnTree } from './spawnTree.js';
import { cancelPermissionTimer, cancelWaitingTimer, clearAgentActivity } from './timerManager.js';
import type { SeededSpawnCandidate } from './transcriptParser.js';
import {
  getHookProvider,
  processTranscriptLine,
  seedSpawnsFromHistory,
} from './transcriptParser.js';
import type { AgentState } from './types.js';

/** Dismissal tracker instance. Set once at startup via setDismissalTracker().
 *  Replaces the former module-global dismissedJsonlFiles, clearDismissedFiles,
 *  seededMtimes, and pendingClearFiles Maps/Sets. */
let dismissalTracker: DismissalTracker | null = null;

/** Register the DismissalTracker instance. Called from PixelAgentsViewProvider at startup. */
export function setDismissalTracker(tracker: DismissalTracker): void {
  dismissalTracker = tracker;
}

/** Get the active DismissalTracker (for PixelAgentsViewProvider direct access).
 *
 * @public
 */
export function getDismissalTracker(): DismissalTracker | null {
  return dismissalTracker;
}

/** Terminal adapter for matching terminals to agents. Set once at startup. */
let terminalAdapter: ITerminalAdapter | null = null;

/** Register the terminal adapter (VS Code terminals, standalone = null). */
export function setTerminalAdapter(adapter: ITerminalAdapter): void {
  terminalAdapter = adapter;
}

/** Agent removal callback. Injected by PixelAgentsViewProvider to avoid a
 *  server/src/ → src/ back-import on agentManager.ts. The ViewProvider closure
 *  captures the store and timer Maps, so only the agent ID is needed. */
let agentRemovalCallback: ((id: number) => void) | null = null;

/** Register the agent removal callback. Called by PixelAgentsViewProvider. */
export function setAgentRemovalCallback(cb: typeof agentRemovalCallback): void {
  agentRemovalCallback = cb;
}

/** Dependencies for per-agent /clear detection in readNewLines polling.
 *  Set once by ensureProjectScan; used by startFileWatching's poll loop. */
let clearDetectionDeps: {
  projectDir: string;
  knownJsonlFiles: Set<string>;
  activeAgentIdRef: { current: number | null };
  fileWatchers: Map<number, fs.FSWatcher>;
  pollingTimers: Map<number, ReturnType<typeof setInterval>>;
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  persistAgents: () => void;
} | null = null;

export function startFileWatching(
  agentId: number,
  _filePath: string,
  agents: AgentStateStore,
  _fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  // Every watched agent passes through here, so this is the one place that can
  // give an agent adopted or restored mid-session a context gauge without
  // replaying its whole transcript.
  seedContextUsage(agentId, agents, getHookProvider());
  // Same seam, same reason: the spawns it left running before watching starts
  // would otherwise never join its spawn tree (plan T18).
  seedLiveSpawns(agentId, agents);

  // Single polling approach: reliable on all platforms (macOS, Linux, WSL2, Windows).
  // Previously used triple-redundant fs.watch + fs.watchFile + setInterval, but
  // fs.watch is unreliable on macOS/WSL2 and the redundancy created 3 timers per
  // agent doing synchronous I/O. The manual poll at 500ms is fast enough for a
  // pixel art visualization and works everywhere.
  const interval = setInterval(() => {
    if (!agents.has(agentId)) {
      clearInterval(interval);
      return;
    }
    const agent = agents.get(agentId)!;
    const prevOffset = agent.fileOffset;
    readNewLines(agentId, agents, waitingTimers, permissionTimers);

    // HEURISTIC FALLBACK: Per-agent /clear detection (skipped when hooks handle sessions).
    // When hooks are active, SessionEnd+SessionStart handle /clear reliably.
    if (
      !agent.hookDelivered &&
      clearDetectionDeps &&
      agent.fileOffset === prevOffset &&
      agent.terminalRef &&
      !agent.isExternal &&
      ![...agents.values()].some((a) => a.isExternal) &&
      agent.linesProcessed > 0 &&
      clearDetectionDeps.activeAgentIdRef.current === agentId &&
      Date.now() - agent.lastDataAt > CLEAR_IDLE_THRESHOLD_MS
    ) {
      const deps = clearDetectionDeps;
      try {
        const dirFiles = fs
          .readdirSync(deps.projectDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => path.join(deps.projectDir, f));
        // Find the first untracked, non-dismissed file NOT already in knownJsonlFiles.
        // knownJsonlFiles blocks seeded files (startup) and adopted files.
        // dismissedJsonlFiles blocks old files from previous /clears.
        // The main scanner does NOT add non-adopted files to knownJsonlFiles,
        // so /clear files remain findable here.
        for (const file of dirFiles) {
          if (deps.knownJsonlFiles.has(file)) continue;
          if (dismissalTracker!.isDismissed(file)) continue;
          let tracked = false;
          for (const a of agents.values()) {
            if (pathsMatch(a.jsonlFile, file)) {
              tracked = true;
              break;
            }
          }
          if (tracked) continue;
          // Content-based /clear detection: only claim files with the /clear command
          // record. Dropped "last-prompt" check because it also appears in --resume
          // sessions. "/clear</command-name>" is specific to /clear (~1.5KB in file).
          try {
            const buf = Buffer.alloc(8192);
            const fd = fs.openSync(file, 'r');
            const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
            fs.closeSync(fd);
            if (!buf.toString('utf-8', 0, bytesRead).includes('/clear</command-name>')) continue;
          } catch {
            continue;
          }
          // Found a /clear file (has last-prompt) → claim it
          deps.knownJsonlFiles.add(file);
          console.log(
            `[Pixel Agents] Watcher: Agent ${agentId} - /clear detected, reassigning to ${path.basename(file)}`,
          );
          reassignAgentToFile(
            agentId,
            file,
            agents,
            deps.fileWatchers,
            deps.pollingTimers,
            deps.waitingTimers,
            deps.permissionTimers,
            deps.persistAgents,
          );
          break; // Only claim one file per poll
        }
      } catch {
        /* ignore dir read errors */
      }
    }
  }, FILE_WATCHER_POLL_INTERVAL_MS);
  pollingTimers.set(agentId, interval);
}

/** Agents already seeded, with the transcript they were seeded from: watching
 *  restarted on the same file never pays for (or re-applies) the history twice. */
const spawnSeededFiles = new WeakMap<AgentState, string>();

/**
 * Seed the live spawns of an agent watched from the END of its transcript
 * (adopted or restored mid-session) from one bounded read of its history. An
 * agent watched from the start replays everything and needs none of this —
 * derived agents are watched that way, so their subtrees come back as their
 * replay reaches each spawn.
 */
function seedLiveSpawns(agentId: number, agents: AgentStateStore): void {
  const agent = agents.get(agentId);
  if (!agent || !agent.jsonlFile || agent.nodeKind === 'workflow' || agent.fileOffset <= 0) return;
  if (spawnSeededFiles.get(agent) === agent.jsonlFile) return;
  spawnSeededFiles.set(agent, agent.jsonlFile);
  const end = agent.fileOffset;
  const start = Math.max(0, end - SPAWN_SEED_MAX_BYTES);
  const seedWindow = { lastLineEnd: -1 };
  try {
    seedSpawnsFromHistory(
      agentId,
      readTranscriptWindow(agent.jsonlFile, start, end, seedWindow),
      agents,
      (candidates) => freshSeededSpawns(agent, candidates, agents),
    );
    // A record still being written at adoption: let the live stream read it
    // whole from its start instead of a headless fragment it would drop (a
    // spawn's tool_result lost that way would keep the spawn alive).
    if (
      seedWindow.lastLineEnd > start &&
      seedWindow.lastLineEnd < end &&
      agent.fileOffset === end
    ) {
      agent.fileOffset = seedWindow.lastLineEnd;
      agent.lineBuffer = '';
    }
  } catch (e) {
    console.log(`[Pixel Agents] Watcher: Agent ${agentId} - spawn seeding skipped: ${e}`);
  }
}

/**
 * The complete lines of `file` between byte `start` and `end`, streamed in
 * SPAWN_SEED_READ_CHUNK_BYTES chunks. A window opening mid-record drops that
 * fragment; an unterminated last line is a record still being written, left
 * to the live stream (seedLiveSpawns rewinds the offset to its start).
 */
function* readTranscriptWindow(
  file: string,
  start: number,
  end: number,
  /** Out: file position right after the window's last newline, or -1. */
  out: { lastLineEnd: number },
): Generator<string> {
  const fd = fs.openSync(file, 'r');
  try {
    // Start one byte early: when that byte is a newline the window opens on a
    // record boundary and the dropped "fragment" is empty.
    let pos = start > 0 ? start - 1 : 0;
    let skipFirst = start > 0;
    const chunk = Buffer.alloc(Math.max(1, Math.min(SPAWN_SEED_READ_CHUNK_BYTES, end - pos)));
    let carry = Buffer.alloc(0);
    while (pos < end) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, end - pos), pos);
      if (n <= 0) break;
      const dataStart = pos - carry.length;
      pos += n;
      const data =
        carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      let from = 0;
      for (let nl = data.indexOf(0x0a); nl !== -1; nl = data.indexOf(0x0a, from)) {
        if (skipFirst) skipFirst = false;
        else if (nl > from) yield data.toString('utf8', from, nl);
        from = nl + 1;
      }
      if (from > 0) out.lastLineEnd = dataStart + from;
      // Copied: `chunk` is reused by the next read.
      carry = Buffer.from(data.subarray(from));
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Whether `file` was written within RESTORED_SPAWN_MAX_IDLE_MS of `now`. */
function writtenRecently(file: string, now: number): boolean {
  try {
    return now - fs.statSync(file).mtimeMs <= RESTORED_SPAWN_MAX_IDLE_MS;
  } catch {
    return false;
  }
}

/**
 * The seeded spawns worth keeping. A history can say a spawn never finished
 * only because the CLI died (or exited and was resumed later, writing on in
 * the same transcript), so:
 *
 * - a foreground spawn follows the restore rule (restorableSpawnToolIds): a
 *   fresh transcript keeps it — it ends with its turn anyway;
 * - a background spawn or workflow launch needs evidence of its own, whatever
 *   the agent's freshness: its own transcript (found through its sidecar) or,
 *   for a workflow, one of its run's transcripts written recently. The newest
 *   MAX_PENDING_WORKFLOW_LAUNCHES launches are checked, one discovery per run.
 */
function freshSeededSpawns(
  agent: AgentState,
  candidates: readonly SeededSpawnCandidate[],
  agents: AgentStateStore,
): Set<string> {
  const root = sessionRootOf(agent.id, agents);
  if (!root) return new Set();
  const now = Date.now();
  const foreground: string[] = [];
  const background = new Set<string>();
  const workflows: SeededSpawnCandidate[] = [];
  for (const c of candidates) {
    if (c.workflowRunDir !== undefined) workflows.push(c);
    else if (c.background) background.add(c.toolUseId);
    else foreground.push(c.toolUseId);
  }
  const kept = restorableSpawnToolIds(
    { jsonlFile: agent.jsonlFile, projectDir: root.projectDir, sessionId: root.sessionId },
    foreground,
    now,
  );
  if (background.size > 0 && teamProvider) {
    for (const t of teamProvider.discoverTeammates(root.projectDir, root.sessionId)) {
      if (t.toolUseId && background.has(t.toolUseId) && writtenRecently(t.jsonlPath, now)) {
        kept.add(t.toolUseId);
      }
    }
  }
  const runFresh = new PathSet();
  const runChecked = new PathSet();
  for (const { toolUseId, workflowRunDir: runDir } of workflows.slice(
    -MAX_PENDING_WORKFLOW_LAUNCHES,
  )) {
    if (!runChecked.has(runDir!)) {
      runChecked.add(runDir!);
      if (workflowRunWrittenRecently(runDir!, root, now)) runFresh.add(runDir!);
    }
    if (runFresh.has(runDir!)) kept.add(toolUseId);
  }
  return kept;
}

/** Whether a run of `root`'s session has a transcript written recently. The
 *  directory comes from transcript text: it is checked against the session
 *  before anything in it is read. */
function workflowRunWrittenRecently(runDir: string, root: AgentState, now: number): boolean {
  if (!isWorkflowRunDirOfSession(runDir, root.projectDir, root.sessionId)) return false;
  const entries = teamProvider?.discoverWorkflowAgents?.(runDir) ?? [];
  return entries.some(
    (e) => isRunTranscript(e.jsonlPath, runDir) && writtenRecently(e.jsonlPath, now),
  );
}

export function readNewLines(
  agentId: number,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  try {
    const stat = fs.statSync(agent.jsonlFile);
    if (stat.size <= agent.fileOffset) return;

    // Cap single read at 64KB to prevent blocking on massive JSONL dumps.
    // Remaining data will be picked up on the next poll cycle.
    const MAX_READ_BYTES = 65536;
    const bytesToRead = Math.min(stat.size - agent.fileOffset, MAX_READ_BYTES);
    const buf = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(agent.jsonlFile, 'r');
    fs.readSync(fd, buf, 0, buf.length, agent.fileOffset);
    fs.closeSync(fd);
    agent.fileOffset += bytesToRead;

    const text = agent.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n');
    agent.lineBuffer = lines.pop() || '';

    const hasLines = lines.some((l) => l.trim());
    if (hasLines) {
      // New data arriving — cancel timers (data flowing means agent is still active).
      // When hooks are active, don't clear permission state here — the hook gave us a
      // definitive signal that permission is needed. Only a new user prompt or tool_result
      // (processed in transcriptParser) should clear it.
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);
      if (agent.permissionSent && !agent.hookDelivered && !agent.leadAgentId) {
        agent.permissionSent = false;
        agents.broadcast({ type: 'agentToolPermissionClear', id: agentId });
      }
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers);
    }
  } catch (e) {
    // ENOENT is expected for hook-detected agents where the JSONL file hasn't been created yet
    if (e instanceof Error && 'code' in e && (e as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.log(`[Pixel Agents] Watcher: Agent ${agentId} - read error: ${e}`);
  }
}

// Track all project directories to scan (supports multi-root workspaces)
const trackedProjectDirs = new Set<string>();

/** Check if a project dir is tracked by the workspace scanner. */
export function isTrackedProjectDir(dir: string): boolean {
  if (trackedProjectDirs.has(dir)) return true;
  // Case-insensitive fallback for Windows (drive letter casing: c:\ vs C:\)
  for (const tracked of trackedProjectDirs) {
    if (pathsMatch(tracked, dir)) return true;
  }
  return false;
}

/**
 * Seed a project directory's known files and register it for periodic scanning.
 * Can be called multiple times with different directories — all will be scanned
 * by the single shared interval timer.
 */
export function ensureProjectScan(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  _onAgentCreated?: (agent: AgentState) => void,
  hooksEnabledRef?: { current: boolean },
): void {
  // Set deps for per-agent /clear detection (only on first call)
  if (!clearDetectionDeps) {
    clearDetectionDeps = {
      projectDir,
      knownJsonlFiles,
      activeAgentIdRef,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
    };
  }

  // Always seed this directory's files (supports multi-root workspaces).
  try {
    const files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
    for (const f of files) {
      // Seed all files and track mtime. External scanner detects --resume
      // by comparing current mtime to seeded mtime (changed = new writes).
      knownJsonlFiles.add(f);
      try {
        const stat = fs.statSync(f);
        dismissalTracker!.seedMtime(f, stat.mtimeMs);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* dir may not exist yet */
  }

  // Register for periodic scanning
  trackedProjectDirs.add(projectDir);

  // Start the shared timer only once
  if (projectScanTimerRef.current) return;
  projectScanTimerRef.current = setInterval(() => {
    // Teammate scanning runs in BOTH modes (hooks + heuristic).
    // In hooks mode, SubagentStart triggers immediate scanning, but the periodic
    // fallback catches teammates that hooks missed (e.g. hook arrived before JSONL).
    scanAllTeammateFiles(
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
    );

    // Check team config files to detect dismissed teammates (authoritative source
    // of truth for team membership). Removes teammates no longer in members list.
    const toRemove = scanTeamConfigsForRemovals(agents);
    for (const id of toRemove) {
      teammateRemovalCallback?.(id);
    }

    // When hooks are active, SessionStart handles new file detection.
    if (hooksEnabledRef?.current) return;

    for (const dir of trackedProjectDirs) {
      scanForNewJsonlFiles(
        dir,
        knownJsonlFiles,
        activeAgentIdRef,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
      );
    }
  }, PROJECT_SCAN_INTERVAL_MS);
}

export function scanForNewJsonlFiles(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  let files: string[];
  try {
    files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
  } catch {
    return;
  }

  for (const file of files) {
    if (knownJsonlFiles.has(file)) continue;

    // Main scanner does NOT do /clear detection. /clear is handled per-agent
    // in startFileWatching's poll loop (500ms, requires CURRENT terminal focus).
    // Only add to knownJsonlFiles when the file is CLAIMED (terminal adopted).
    // Non-adopted files stay OUT of knownJsonlFiles so the per-agent /clear
    // check can find them when the idle check passes (up to 5s later).

    // Try to adopt the focused terminal (only if it's a Claude-named terminal).
    // Cast to vscode.Terminal because the adapter returns the real object at runtime;
    // the TerminalHandle type is the minimal interface for the adapter contract.
    const activeTerminal = terminalAdapter?.activeTerminal() as vscode.Terminal | undefined;
    if (
      activeTerminal &&
      hookProvider?.terminalNamePrefix &&
      activeTerminal.name.startsWith(hookProvider.terminalNamePrefix)
    ) {
      let owned = false;
      for (const agent of agents.values()) {
        if (agent.terminalRef === activeTerminal) {
          owned = true;
          break;
        }
      }
      if (!owned) {
        knownJsonlFiles.add(file); // Claimed by terminal adoption
        adoptTerminalForFile(
          activeTerminal,
          file,
          projectDir,
          nextAgentIdRef,
          agents,
          activeAgentIdRef,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          persistAgents,
        );
      } else {
        // Active terminal is owned -- scan for untracked Claude-named terminals.
        // Only adopt terminals with TERMINAL_NAME_PREFIX to avoid grabbing
        // pre-existing shells ("zsh", "bash") for /clear files.
        for (const terminal of (terminalAdapter?.allTerminals() ?? []) as vscode.Terminal[]) {
          if (
            !hookProvider?.terminalNamePrefix ||
            !terminal.name.startsWith(hookProvider.terminalNamePrefix)
          )
            continue;
          let owned = false;
          for (const agent of agents.values()) {
            if (agent.terminalRef === terminal) {
              owned = true;
              break;
            }
          }
          if (!owned) {
            knownJsonlFiles.add(file); // Claimed by terminal adoption
            adoptTerminalForFile(
              terminal,
              file,
              projectDir,
              nextAgentIdRef,
              agents,
              activeAgentIdRef,
              fileWatchers,
              pollingTimers,
              waitingTimers,
              permissionTimers,
              persistAgents,
              onAgentCreated,
            );
            break;
          }
        }
      }
    }
  }

  // Clean up orphaned agents whose terminals have been closed (skip external agents)
  for (const [id, agent] of agents) {
    if (agent.isExternal) continue;
    if (agent.terminalRef && agent.terminalRef.exitStatus !== undefined) {
      console.log(`[Pixel Agents] Watcher: Agent ${id} - terminal closed, cleaning up orphan`);
      agentRemovalCallback?.(id);
    }
  }
}

function adoptTerminalForFile(
  terminal: vscode.Terminal,
  jsonlFile: string,
  projectDir: string,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  activeAgentIdRef: { current: number | null },
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  const id = nextAgentIdRef.current++;
  const sessionId = path.basename(jsonlFile, '.jsonl');
  // Skip to end of file -- adopted terminals show live activity only, not replay history
  let fileOffset = 0;
  try {
    const stat = fs.statSync(jsonlFile);
    fileOffset = stat.size;
  } catch {
    /* start from beginning if stat fails */
  }
  const agent: AgentState = {
    id,
    sessionId,
    terminalRef: terminal,
    isExternal: false,
    projectDir,
    jsonlFile,
    fileOffset,
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
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  };

  assignPaletteIfNeeded(agent, agents);
  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();
  onAgentCreated?.(agent);

  console.log(
    `[Pixel Agents] Watcher: Agent ${id} - adopted terminal "${terminal.name}" for ${path.basename(jsonlFile)}`,
  );

  startFileWatching(
    id,
    jsonlFile,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
  );
  readNewLines(id, agents, waitingTimers, permissionTimers);
}

// ── Lead + Teammates support (provider-driven) ──

/** Known teammate JSONL files (prevents re-adoption). */
const knownTeammateFiles = new Set<string>();

/** Callback to remove a teammate agent when detected as dismissed via team config. */
let teammateRemovalCallback: ((teammateAgentId: number) => void) | null = null;

/** Team provider: supplies all CLI-specific paths, parsers, and tool names.
 *  Set once at startup via setTeamProvider(). Module functions assume it's set
 *  by the time they're called. */
let teamProvider: TeamProvider | null = null;

/** A workflow run directory counts only when the active provider vouches for
 *  it; a provider without the check gets no workflow nodes (fail closed). */
function isWorkflowRunDirOfSession(runDir: string, projectDir: string, sessionId: string): boolean {
  return teamProvider?.isWorkflowRunDirOfSession?.(runDir, projectDir, sessionId) === true;
}

/** Hook provider: supplies non-team capabilities fileWatcher needs (all-session
 *  roots for global discovery, launch command, etc.). Set once at startup. */
let hookProvider: HookProvider | null = null;

/** Register the callback used to remove teammates detected as dismissed via team config polling. */
export function setTeammateRemovalCallback(cb: (teammateAgentId: number) => void): void {
  teammateRemovalCallback = cb;
}

/** Callback that registers a teammate's OWN session with the hook router.
 *  Only invoked for teammates that run independent sessions (new-style implicit
 *  teams); inline teammates share the lead's session and are never registered. */
let teammateRegisterCallback: ((sessionId: string, agentId: number) => void) | null = null;

/** Register the callback used to route an own-session teammate's hook events to it. */
export function setTeammateRegisterCallback(
  cb: (sessionId: string, agentId: number) => void,
): void {
  teammateRegisterCallback = cb;
}

/** Register the TeamProvider that describes the active CLI's Lead+Teammates pattern. */
export function setTeamProvider(provider: TeamProvider): void {
  teamProvider = provider;
}

/** Lifecycle hooks for derived agents (docs/adr/0002). The runtime registers
 *  them to route hook events by `(sessionId, agentKey)`. */
export interface SpawnTreeCallbacks {
  onDerivedCreated(agent: AgentState): void;
  onDerivedRemoved(agent: AgentState): void;
}

let spawnTreeCallbacks: SpawnTreeCallbacks | null = null;

/** Register the derived-agent lifecycle callbacks (null to clear). */
export function setSpawnTreeCallbacks(cbs: SpawnTreeCallbacks | null): void {
  spawnTreeCallbacks = cbs;
}

/** Tell the registered callbacks a derived agent left the store. Called by the
 *  runtime's removal path, the only place derived agents are removed. */
export function notifyDerivedRemoved(agent: AgentState): void {
  spawnTreeCallbacks?.onDerivedRemoved(agent);
}

/** Register the active HookProvider for non-team capabilities (session roots, etc.). */
export function setHookProvider(provider: HookProvider): void {
  hookProvider = provider;
}

/**
 * Resolves an external agent's `cwd`/`projectDir` to its `WorkspaceFolder.name` —
 * the label the Areas UI keys on. Registered by the VS Code adapter; unset in
 * standalone, which falls back to basename.
 */
export type FolderNameResolver = (ctx: { cwd?: string; projectDir?: string }) => string | undefined;

let folderNameResolver: FolderNameResolver | null = null;

/** Register the host's cwd/projectDir → WorkspaceFolder.name resolver (VS Code only). */
export function setFolderNameResolver(resolver: FolderNameResolver): void {
  folderNameResolver = resolver;
}

/**
 * Scan the provider's teammate transcripts for a given lead session.
 * Each teammate gets its own independent agent (positive ID) with file watching.
 *
 * Called from two paths:
 * 1. Hooks-triggered (immediate): onTeammateDetected callback from SubagentStart
 * 2. Periodic fallback: ensureProjectScan timer (heuristic mode)
 */
export function scanForTeammateFiles(
  projectDir: string,
  sessionId: string,
  parentAgentId: number,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  if (!teamProvider) return;
  const parentAgent = agents.get(parentAgentId);
  // teamName lets the provider also find new-style teammates: independent
  // top-level sessions tagged with the team, not files under the lead's dir.
  const teammates = teamProvider.discoverTeammates(projectDir, sessionId, parentAgent?.teamName);

  const treeLiveSpawnIds = parentAgent ? liveSpawnToolIdsOfTree(parentAgentId, agents) : null;
  for (const {
    jsonlPath: file,
    teammateName,
    sessionId: ownSessionId,
    toolUseId,
    parentAgentKey,
  } of teammates) {
    // A sidecar spawned by another spawned agent (depth >= 2) is never an Agent
    // Teams teammate of the lead: it belongs to scanSpawnTree under its parent.
    if (parentAgentKey !== undefined) continue;
    // Live-spawn sidecars (they carry the toolUseId of a spawn some node of
    // this tree is running) belong to scanSpawnTree, which materializes them
    // as derived agents under the right parent. Adopting them here would race
    // it and mint a spurious teammate of the lead.
    if (toolUseId && treeLiveSpawnIds?.has(toolUseId)) continue;
    if (knownTeammateFiles.has(file)) continue;

    // Also check if any existing agent already tracks this file
    let alreadyTracked = false;
    for (const a of agents.values()) {
      if (pathsMatch(a.jsonlFile, file)) {
        alreadyTracked = true;
        break;
      }
    }
    if (alreadyTracked) continue;

    knownTeammateFiles.add(file);

    // Deduplicate by teammate name per parent: if we already have a live agent
    // with the same name for this parent, reassign it to the new JSONL file
    // (Claude may restart a teammate, creating a new .jsonl for the same role).
    let existingTeammate: AgentState | undefined;
    for (const a of agents.values()) {
      // Derived agents (docs/adr/0002) are keyed by their own sidecar; a
      // same-named historical transcript must never take one over.
      if (a.spawnAgentKey !== undefined || a.parentAgentId !== undefined) continue;
      if (a.leadAgentId === parentAgentId && a.agentName === teammateName) {
        existingTeammate = a;
        break;
      }
    }
    if (existingTeammate) {
      if (debug)
        console.log(
          `[Pixel Agents] Teammate ${JSON.stringify(teammateName)} already exists (Agent ${existingTeammate.id}), reassigning to ${path.basename(file)}`,
        );
      // Reassign to new JSONL file -- stop old polling, start new
      const oldTimer = pollingTimers.get(existingTeammate.id);
      if (oldTimer) clearInterval(oldTimer);
      pollingTimers.delete(existingTeammate.id);
      existingTeammate.jsonlFile = file;
      existingTeammate.fileOffset = 0;
      existingTeammate.lineBuffer = '';
      existingTeammate.lastDataAt = Date.now();
      existingTeammate.linesProcessed = 0;
      existingTeammate.isWaiting = false;
      existingTeammate.teamUsesTmux = parentAgent?.teamUsesTmux;
      if (ownSessionId && existingTeammate.sessionId !== ownSessionId) {
        existingTeammate.sessionId = ownSessionId;
        teammateRegisterCallback?.(ownSessionId, existingTeammate.id);
      }
      startFileWatching(
        existingTeammate.id,
        file,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
      );
      readNewLines(existingTeammate.id, agents, waitingTimers, permissionTimers);
      continue;
    }

    const id = nextAgentIdRef.current++;
    // Read from start -- teammate JSONL is usually small and we want full tool history
    // New-style teammates carry their own session id; inline teammates share the lead's.
    const agent: AgentState = {
      id,
      sessionId: ownSessionId ?? sessionId,
      terminalRef: undefined,
      isExternal: true,
      projectDir,
      jsonlFile: file,
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
      // Keep hookDelivered false: teammates need JSONL-based tool tracking
      // (agentToolStart messages). Permission events are routed from the lead's
      // hooks via handlePermissionRequest forwarding.
      hookDelivered: false,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      contextTokens: 0,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      // Agent Teams fields
      agentName: teammateName,
      leadAgentId: parentAgentId,
      teamName: parentAgent?.teamName,
      teamUsesTmux: parentAgent?.teamUsesTmux,
    };

    if (parentAgent?.palette !== undefined) {
      agent.palette = parentAgent.palette;
      agent.hueShift = parentAgent.hueShift ?? 0;
    } else {
      assignPaletteIfNeeded(agent, agents);
    }
    agents.set(id, agent);
    persistAgents();

    console.log(
      `[Pixel Agents] Teammate detected: ${JSON.stringify(teammateName)} (Agent ${id}) for parent Agent ${parentAgentId} (${path.basename(file)})`,
    );

    // Own-session teammates get registered so their hook events route directly
    // to them. Inline teammates share the lead's session and must NOT be
    // registered -- they would overwrite the lead in the session router.
    if (ownSessionId) {
      teammateRegisterCallback?.(ownSessionId, id);
    }

    onAgentCreated?.(agent);

    startFileWatching(
      id,
      file,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
    );
    readNewLines(id, agents, waitingTimers, permissionTimers);
  }
}

/** All of an agent's LIVE spawn tool ids: background spawns (kept alive past
 *  their tool_result, until the completion queue-operation) plus still-open
 *  foreground spawn tools (Agent run_in_background:false — same sidecar shape
 *  on current harnesses, closes with its tool_result). A sidecar only ever
 *  materializes when its toolUseId is one of these on ITS OWN parent. */
function liveSpawnToolIds(agent: AgentState): Set<string> {
  const ids = new Set(agent.backgroundAgentToolIds);
  for (const toolId of agent.activeToolIds) {
    const toolName = agent.activeToolNames.get(toolId);
    if (toolName && hookProvider?.subagentToolNames.has(toolName)) {
      ids.add(toolId);
    }
  }
  return ids;
}

/** The root and every agent below it, found in one O(n) pass over a
 *  parent→children index (BFS; cycle-safe via the visited set). */
function treeMembers(rootId: number, agents: AgentStateStore): AgentState[] {
  const root = agents.get(rootId);
  if (!root) return [];
  const children = new Map<number, AgentState[]>();
  for (const a of agents.values()) {
    if (a.parentAgentId === undefined) continue;
    const list = children.get(a.parentAgentId);
    if (list) list.push(a);
    else children.set(a.parentAgentId, [a]);
  }
  const out: AgentState[] = [root];
  const visited = new Set<number>([rootId]);
  for (let i = 0; i < out.length; i++) {
    for (const child of children.get(out[i].id) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      out.push(child);
    }
  }
  return out;
}

/** Union of the live spawn tool ids of every node in `rootId`'s tree. */
function liveSpawnToolIdsOfTree(rootId: number, agents: AgentStateStore): Set<string> {
  const ids = new Set<string>();
  for (const a of treeMembers(rootId, agents)) {
    for (const t of liveSpawnToolIds(a)) ids.add(t);
  }
  return ids;
}

/**
 * The session root of an agent's spawn tree: climbs `parentAgentId` until an
 * agent without one. Cycle-safe: a corrupt chain stops at the first repeat and
 * returns an agent that still has a parent, which no caller treats as a root.
 * A dangling parent id is returned as-is, so it matches no live root either.
 */
export function rootOf(agentId: number, agents: AgentStateStore): number {
  const seen = new Set<number>();
  let id = agentId;
  for (;;) {
    const a = agents.get(id);
    if (!a || a.parentAgentId === undefined || seen.has(id)) return id;
    seen.add(id);
    id = a.parentAgentId;
  }
}

/**
 * The persisted live spawn ids a restored root may keep. When the CLI dies
 * without SessionEnd its background agents die too and their completion
 * queue-operation never comes, so restoring every id would bring the tree back
 * immortal. Activity decides, per spawn:
 *
 * - root transcript written within RESTORED_SPAWN_MAX_IDLE_MS → all kept;
 * - otherwise a spawn is kept only while ITS OWN transcript (found through its
 *   sidecar) was written within the window — a lead that ended its turn and
 *   waits on a long background agent writes nothing, but the agent does.
 *
 * An unreadable root transcript keeps nothing.
 */
export function restorableSpawnToolIds(
  root: { jsonlFile: string; projectDir: string; sessionId?: string },
  persisted: readonly string[] | undefined,
  now = Date.now(),
): Set<string> {
  if (!persisted || persisted.length === 0) return new Set();
  const isFresh = (file: string): boolean => writtenRecently(file, now);
  try {
    fs.statSync(root.jsonlFile);
  } catch {
    return new Set();
  }
  if (isFresh(root.jsonlFile)) return new Set(persisted);
  if (!teamProvider || !root.sessionId || !root.projectDir) return new Set();
  const wanted = new Set(persisted);
  const kept = new Set<string>();
  for (const t of teamProvider.discoverTeammates(root.projectDir, root.sessionId)) {
    if (t.toolUseId && wanted.has(t.toolUseId) && isFresh(t.jsonlPath)) kept.add(t.toolUseId);
  }
  return kept;
}

/** Hue for a new child of `parent`: the parent's hue rotated by the first
 *  multiple of SPAWN_SIBLING_HUE_STEP_DEG no live sibling uses, so a sibling
 *  born after another one left never repeats a hue still on screen. */
function siblingHueShift(parent: AgentState, parentId: number, agents: AgentStateStore): number {
  const base = parent.hueShift ?? 0;
  const used = new Set<number>();
  let siblings = 0;
  for (const a of agents.values()) {
    if (a.parentAgentId !== parentId) continue;
    siblings++;
    if (a.hueShift !== undefined) used.add(a.hueShift);
  }
  const steps = Math.floor(360 / SPAWN_SIBLING_HUE_STEP_DEG);
  for (let k = 1; k <= steps; k++) {
    const hue = (base + SPAWN_SIBLING_HUE_STEP_DEG * k) % 360;
    if (!used.has(hue)) return hue;
  }
  // Every step is taken (more siblings than hues): repeats are unavoidable.
  return (base + SPAWN_SIBLING_HUE_STEP_DEG * (siblings + 1)) % 360;
}

/** Re-entrancy guard: creating a node reads its transcript, which may open a
 *  spawn tool and ask for another scan mid-pass. Nested requests are queued
 *  and run once the current pass is done. */
let spawnScanActive = false;
const spawnRescanRoots = new Set<number>();
/** Roots already warned about hitting a spawn-tree cap (one warning each).
 *  Keyed by the agent object, so an id reused by a later root warns again and
 *  a removed root is garbage-collected with its entry. */
const spawnCapWarnedRoots = new WeakSet<AgentState>();

/**
 * Materialize the spawn tree under a session root (docs/adr/0002). Every
 * sidecar-backed spawn whose toolUseId is a live spawn of its own parent node
 * becomes a derived agent, named or not; a name only adds the Teammate
 * identity (agentName + leadAgentId, the spawner badged as Lead). Children of
 * a node that does not exist yet wait for a later scan. Recursion is natural:
 * a new node's own spawn tools make its children eligible on the next scan.
 *
 * Derived agents are never persisted and never registered as sessions; the
 * registered SpawnTreeCallbacks route their hook events by agent key.
 */
export function scanSpawnTree(
  rootId: number,
  agents: AgentStateStore,
  nextAgentIdRef: { current: number },
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  onAgentCreated?: (agent: AgentState) => void,
  /** Also discover the agents of the tree's live workflow runs. Only the 1 s
   *  periodic scan passes true: cold run discovery costs ~20 ms per agent, far
   *  too much to pay synchronously on every spawn tool or hook event. */
  includeWorkflowRuns = false,
): void {
  if (spawnScanActive) {
    spawnRescanRoots.add(rootId);
    return;
  }
  spawnScanActive = true;
  try {
    let next: number | undefined = rootId;
    let withRuns = includeWorkflowRuns;
    while (next !== undefined) {
      spawnRescanRoots.delete(next);
      scanSpawnTreeOnce(
        next,
        agents,
        nextAgentIdRef,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        onAgentCreated,
      );
      if (withRuns) {
        scanWorkflowRunsOnce(
          next,
          agents,
          nextAgentIdRef,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          onAgentCreated,
        );
      }
      // Rescans queued by nested requests are event-driven: no run discovery.
      withRuns = false;
      next = spawnRescanRoots.values().next().value;
    }
  } finally {
    spawnScanActive = false;
    spawnRescanRoots.clear();
  }
}

/** "Is this spawn transcript off limits?" for one scan: already watched by
 *  some agent (O(1): the tracked set is built once), or dismissed by the user.
 *  A transcript the user dismissed (closed the character) is off limits while
 *  its spawn is live; the dismissal is made permanent for it — a spawn
 *  transcript belongs to one spawn, so there is nothing to re-adopt later, and
 *  the 3-minute cooldown must not bring it back. */
function spawnTranscriptTaken(agents: AgentStateStore): (p: string) => boolean {
  const trackedPaths = new PathSet();
  for (const a of agents.values()) {
    if (a.jsonlFile) trackedPaths.add(a.jsonlFile);
  }
  return (p: string): boolean => {
    if (trackedPaths.has(p) || dismissalTracker?.isPermanentlyDismissed(p)) return true;
    if (!dismissalTracker?.isDismissed(p)) return false;
    dismissalTracker.permanentlyDismiss(p);
    return true;
  };
}

/** The fields every derived agent starts with. It shares the root's session: a
 *  spawned agent has no session of its own and is NEVER registered with the
 *  session router as one. */
function derivedAgentShell(id: number, root: AgentState, jsonlFile: string): AgentState {
  return {
    id,
    sessionId: root.sessionId,
    terminalRef: undefined,
    isExternal: true,
    projectDir: root.projectDir,
    jsonlFile,
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
    hookDelivered: false,
    lastDataAt: Date.now(),
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    contextTokens: 0,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  };
}

function scanSpawnTreeOnce(
  rootId: number,
  agents: AgentStateStore,
  nextAgentIdRef: { current: number },
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  if (!teamProvider) return;
  const root = agents.get(rootId);
  if (!root || !root.sessionId || !root.projectDir || root.parentAgentId !== undefined) return;

  // The tree as it stands: the root plus every derived agent that climbs to it.
  const nodes = new Map<number, SpawnTreeNode>();
  let anyLive = false;
  for (const a of treeMembers(rootId, agents)) {
    const live = liveSpawnToolIds(a);
    if (live.size > 0) anyLive = true;
    nodes.set(a.id, {
      id: a.id,
      spawnAgentKey: a.spawnAgentKey,
      liveSpawnToolIds: live,
      parentId: a.parentAgentId,
      spawnToolUseId: a.spawnToolUseId,
    });
  }
  // No node is running a spawn: nothing can materialize, skip the disk scan.
  if (!anyLive) return;

  const entries: SpawnEntry[] = [];
  for (const t of teamProvider.discoverTeammates(root.projectDir, root.sessionId)) {
    if (!t.agentKey || !t.toolUseId) continue;
    entries.push({
      jsonlPath: t.jsonlPath,
      agentKey: t.agentKey,
      parentAgentKey: t.parentAgentKey,
      toolUseId: t.toolUseId,
      depth: t.depth ?? 1,
      agentType: t.agentType ?? t.teammateName,
      description: t.description,
      name: t.name,
    });
  }
  if (entries.length === 0) return;

  // Only plan.create is consumed; plan.deferred is recomputed every scan.
  const plan = planSpawnTree(rootId, nodes, entries, spawnTranscriptTaken(agents));
  if (plan.create.length === 0) return;

  // Create every node BEFORE reading any transcript: a read can re-enter the
  // scan, which must then see all of this pass's nodes as existing.
  const created: AgentState[] = [];
  let derivedCount = nodes.size - 1;
  let capped = false;
  for (const { entry, parentId } of plan.create) {
    const parent = agents.get(parentId);
    if (!parent) continue;
    // Guards against a runaway (or hostile) transcript: past the caps the
    // entry is deferred — re-offered every scan, created once room frees up.
    const depth = (parent.parentAgentId === undefined ? 0 : (parent.depth ?? 0)) + 1;
    if (derivedCount >= MAX_DERIVED_AGENTS_PER_TREE || depth > MAX_SPAWN_DEPTH) {
      capped = true;
      continue;
    }
    derivedCount++;
    const id = nextAgentIdRef.current++;
    const agent: AgentState = {
      ...derivedAgentShell(id, root, entry.jsonlPath),
      spawnToolUseId: entry.toolUseId,
      spawnAgentKey: entry.agentKey,
      parentAgentId: parentId,
      role: entry.agentType,
      label: entry.description,
      // From the tree, never from the sidecar: the root counts as depth 0.
      depth,
      // A name makes it a Teammate (CONTEXT.md). Derived team: NO teamName, so
      // team-config polling stays away.
      ...(entry.name ? { agentName: entry.name, leadAgentId: parentId } : {}),
    };
    if (parent.palette !== undefined) {
      agent.palette = parent.palette;
      agent.hueShift = siblingHueShift(parent, parentId, agents);
    } else {
      assignPaletteIfNeeded(agent, agents);
    }
    agents.set(id, agent);
    created.push(agent);
    // A sidecar-backed spawn belongs to the tree for good: once it is (or was)
    // a derived agent, flat teammate discovery must never adopt its transcript.
    knownTeammateFiles.add(entry.jsonlPath);

    // Derived team: spawning a named agent makes the spawner a Lead, whether
    // or not the CLI registered a team.
    if (entry.name && !parent.isTeamLead) {
      parent.isTeamLead = true;
      agents.broadcast({
        type: 'agentTeamInfo',
        id: parentId,
        teamName: parent.teamName,
        agentName: parent.agentName,
        isTeamLead: true,
        leadAgentId: parent.leadAgentId,
      });
      agents.persist();
    }

    console.log(
      `[Pixel Agents] Spawn tree: Agent ${id} derived from Agent ${parentId} (depth ${agent.depth}, ${path.basename(entry.jsonlPath)})`,
    );

    // The parent's transient Subtask sprite for this spawn is superseded.
    agents.broadcast({ type: 'subagentClear', id: parentId, parentToolId: entry.toolUseId });
    spawnTreeCallbacks?.onDerivedCreated(agent);
    onAgentCreated?.(agent);
  }

  if (capped) warnSpawnCap(root, rootId);

  watchCreated(created, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers);
}

/** One warning per root when a spawn-tree cap defers something. */
function warnSpawnCap(root: AgentState, rootId: number): void {
  if (spawnCapWarnedRoots.has(root)) return;
  spawnCapWarnedRoots.add(root);
  console.warn(
    `[Pixel Agents] Spawn tree of Agent ${rootId}: more than ${MAX_DERIVED_AGENTS_PER_TREE} live agents or deeper than ${MAX_SPAWN_DEPTH} levels; the excess is not shown`,
  );
}

/** Start watching freshly created derived agents, once all of them exist. */
function watchCreated(
  created: readonly AgentState[],
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  for (const agent of created) {
    // A callback may have removed it meanwhile.
    if (agents.get(agent.id) !== agent) continue;
    startFileWatching(
      agent.id,
      agent.jsonlFile,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
    );
    readNewLines(agent.id, agents, waitingTimers, permissionTimers);
  }
}

// ── Workflow nodes (spec §2.1b) ──
//
// A `Workflow` launch is a derived node with no transcript: identity = the
// launch tool call (the caller's live background spawn), `workflowRunDir` only
// says where its agents write. The run's agents hang below it; their sidecars
// carry no spawn tool id, so the gate is the node itself being alive.

type WorkflowRunEntry = ReturnType<NonNullable<TeamProvider['discoverWorkflowAgents']>>[number];

/** A launch seen on a transcript whose node does not exist yet. */
interface WorkflowLaunch {
  runDir: string;
  name?: string;
}

/** Launches waiting for their node, per launching agent (keyed by the agent
 *  object: an id reused by a later store never inherits them, and a removed
 *  agent's launches are garbage-collected with it). Normally a launch lives
 *  here for one call; it stays only while a tree cap defers its node. */
const pendingWorkflowLaunches = new WeakMap<AgentState, Map<string, WorkflowLaunch>>();

/** Run directories already reported as foreign, so a replayed transcript
 *  doesn't flood the log. Bounded; past the bound refusals go unlogged. */
const foreignRunDirsLogged = new Set<string>();
const FOREIGN_RUN_DIRS_LOG_MAX = 256;

/** The session root an agent's spawns belong to, or undefined when the chain
 *  does not end at a real root (corrupt or dangling). */
function sessionRootOf(agentId: number, agents: AgentStateStore): AgentState | undefined {
  const root = agents.get(rootOf(agentId, agents));
  return root && root.parentAgentId === undefined && root.sessionId && root.projectDir
    ? root
    : undefined;
}

/**
 * A `Workflow` launch on `ownerId`'s transcript. The run directory must be
 * this very session's own (`<projectDir>/<sessionId>/subagents/workflows/
 * wf_<id>`): the launch text quotes model-authored content and could name any
 * directory. Returns false (nothing created, logged once) when it is not;
 * otherwise creates the node now — cheap, no disk access — or, past a tree
 * cap, leaves it to a later 1 s scan.
 */
export function registerWorkflowLaunch(
  ownerId: number,
  toolUseId: string,
  launch: WorkflowLaunch,
  agents: AgentStateStore,
  nextAgentIdRef: { current: number },
): boolean {
  const owner = agents.get(ownerId);
  const root = sessionRootOf(ownerId, agents);
  if (!owner || !root) return false;
  if (!isWorkflowRunDirOfSession(launch.runDir, root.projectDir, root.sessionId)) {
    if (
      !foreignRunDirsLogged.has(launch.runDir) &&
      foreignRunDirsLogged.size < FOREIGN_RUN_DIRS_LOG_MAX
    ) {
      foreignRunDirsLogged.add(launch.runDir);
      console.log(
        `[Pixel Agents] Workflow launch ${toolUseId} on Agent ${ownerId} ignored: its run directory is not in session ${root.sessionId.slice(0, 8)}...`,
      );
    }
    return false;
  }
  let launches = pendingWorkflowLaunches.get(owner);
  if (!launches) {
    launches = new Map();
    pendingWorkflowLaunches.set(owner, launches);
  }
  // Launches only wait here while a tree cap defers them; a transcript
  // replaying launch after launch must not grow this (nor the owner's
  // persisted live spawn ids) without bound.
  if (!launches.has(toolUseId) && launches.size >= MAX_PENDING_WORKFLOW_LAUNCHES) {
    warnSpawnCap(root, root.id);
    return false;
  }
  launches.set(toolUseId, { runDir: launch.runDir, name: launch.name });
  materializeWorkflowNodes(root, agents, nextAgentIdRef, owner);
  return true;
}

/** Create the nodes of `root`'s tree whose launches are pending and still
 *  live, within the tree caps — only `onlyOwner`'s when given (a fresh launch
 *  never pays for the others). Launches whose spawn is no longer live (the run
 *  completed, the session ended) are dropped. */
function materializeWorkflowNodes(
  root: AgentState,
  agents: AgentStateStore,
  nextAgentIdRef: { current: number },
  onlyOwner?: AgentState,
): void {
  const members = treeMembers(root.id, agents);
  let derivedCount = members.length - 1;
  let capped = false;
  // Spawn tool calls that already have a node (see spawnCallSlot).
  const materialized = new Set<string>();
  for (const a of members) {
    if (a.parentAgentId !== undefined && a.spawnToolUseId !== undefined) {
      materialized.add(spawnCallSlot(a.parentAgentId, a.spawnToolUseId));
    }
  }
  for (const owner of onlyOwner ? [onlyOwner] : members) {
    const launches = pendingWorkflowLaunches.get(owner);
    if (!launches) continue;
    for (const [toolUseId, launch] of launches) {
      if (
        !owner.backgroundAgentToolIds.has(toolUseId) ||
        materialized.has(spawnCallSlot(owner.id, toolUseId))
      ) {
        launches.delete(toolUseId);
        continue;
      }
      const depth = (owner.parentAgentId === undefined ? 0 : (owner.depth ?? 0)) + 1;
      if (derivedCount >= MAX_DERIVED_AGENTS_PER_TREE || depth > MAX_SPAWN_DEPTH) {
        capped = true;
        continue;
      }
      derivedCount++;
      launches.delete(toolUseId);
      materialized.add(spawnCallSlot(owner.id, toolUseId));
      const id = nextAgentIdRef.current++;
      const node: AgentState = {
        // No transcript of its own: nothing is ever watched for it.
        ...derivedAgentShell(id, root, ''),
        spawnToolUseId: toolUseId,
        parentAgentId: owner.id,
        role: 'workflow',
        label: launch.name,
        depth,
        nodeKind: 'workflow',
        workflowRunDir: launch.runDir,
        // Derived status: idle until one of its agents works.
        isWaiting: true,
      };
      assignChildPalette(node, owner, agents);
      agents.set(id, node);
      console.log(
        `[Pixel Agents] Spawn tree: Agent ${id} is workflow ${JSON.stringify(launch.name ?? toolUseId)} of Agent ${owner.id} (depth ${depth})`,
      );
      agents.broadcast({ type: 'agentStatus', id, status: 'waiting', awaitingInput: false });
      spawnTreeCallbacks?.onDerivedCreated(node);
    }
    if (launches.size === 0) pendingWorkflowLaunches.delete(owner);
  }
  if (capped) warnSpawnCap(root, root.id);
}

/** Set key of one spawn tool call of one parent. */
function spawnCallSlot(parentId: number, toolUseId: string): string {
  return `${parentId}\n${toolUseId}`;
}

/** Palette of a new child: the parent's, with a hue no live sibling uses. */
function assignChildPalette(child: AgentState, parent: AgentState, agents: AgentStateStore): void {
  if (parent.palette !== undefined) {
    child.palette = parent.palette;
    child.hueShift = siblingHueShift(parent, parent.id, agents);
  } else {
    assignPaletteIfNeeded(child, agents);
  }
}

/** A run transcript is watched only when it is a regular file (no symlink,
 *  FIFO or directory) sitting directly in its run's directory — checked by
 *  the host itself right before watching, whatever the provider reported. */
function isRunTranscript(jsonlPath: string, runDir: string): boolean {
  if (!pathsMatch(path.dirname(jsonlPath), runDir)) return false;
  try {
    return fs.lstatSync(jsonlPath).isFile();
  } catch {
    return false;
  }
}

/**
 * Materialize the agents of every live workflow run of `rootId`'s tree (1 s
 * scan only). An agent hangs from the node, or — when its sidecar names a
 * parent — from the agent of the SAME run holding that key; a parent key not
 * (yet) in the run waits for a later scan and is never guessed, never the root.
 * Same caps, dismissal and one-agent-per-key rules as every spawn.
 */
function scanWorkflowRunsOnce(
  rootId: number,
  agents: AgentStateStore,
  nextAgentIdRef: { current: number },
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  const discover = teamProvider?.discoverWorkflowAgents?.bind(teamProvider);
  const root = agents.get(rootId);
  if (!discover || !root || root.parentAgentId !== undefined) return;
  if (!root.sessionId || !root.projectDir) return;
  // Launches a cap deferred get their chance first.
  materializeWorkflowNodes(root, agents, nextAgentIdRef);

  const members = treeMembers(rootId, agents);
  const workflowNodes = members.filter((a) => a.nodeKind === 'workflow' && a.workflowRunDir);
  if (workflowNodes.length === 0) return;

  let derivedCount = members.length - 1;
  // A tree at its cap can create nothing: don't pay for any run discovery.
  if (derivedCount >= MAX_DERIVED_AGENTS_PER_TREE) {
    warnSpawnCap(root, rootId);
    return;
  }
  const keysInTree = new Set<string>();
  for (const a of members) if (a.spawnAgentKey !== undefined) keysInTree.add(a.spawnAgentKey);
  const isTaken = spawnTranscriptTaken(agents);
  const created: AgentState[] = [];
  let capped = false;

  // One discovery per run directory per scan, whatever the number of nodes.
  const discoveredRunDirs = new PathSet();
  for (const node of workflowNodes) {
    if (derivedCount >= MAX_DERIVED_AGENTS_PER_TREE) {
      capped = true;
      break;
    }
    const runDir = node.workflowRunDir!;
    if (discoveredRunDirs.has(runDir)) continue;
    discoveredRunDirs.add(runDir);
    // Re-checked every scan (cheap, no I/O): the node must only ever read
    // its own session's run directory.
    if (!isWorkflowRunDirOfSession(runDir, root.projectDir, root.sessionId)) continue;
    // This run's agents by key: the only parents a run agent may name.
    const runByKey = new Map<string, AgentState>();
    for (const a of treeMembers(node.id, agents)) {
      if (a.spawnAgentKey !== undefined) runByKey.set(a.spawnAgentKey, a);
    }
    let remaining: WorkflowRunEntry[] = discover(runDir);
    // Several passes so a parent created in this scan adopts its children in
    // the same scan; each pass either creates something or stops.
    for (let progress = true; progress && remaining.length > 0;) {
      progress = false;
      const deferred: WorkflowRunEntry[] = [];
      for (const entry of remaining) {
        if (keysInTree.has(entry.agentKey) || entry.parentAgentKey === entry.agentKey) continue;
        const parent =
          entry.parentAgentKey === undefined ? node : runByKey.get(entry.parentAgentKey);
        if (!parent) {
          deferred.push(entry);
          continue;
        }
        if (isTaken(entry.jsonlPath) || !isRunTranscript(entry.jsonlPath, runDir)) continue;
        const depth = (parent.depth ?? 0) + 1;
        if (derivedCount >= MAX_DERIVED_AGENTS_PER_TREE || depth > MAX_SPAWN_DEPTH) {
          capped = true;
          continue;
        }
        derivedCount++;
        const id = nextAgentIdRef.current++;
        const agent: AgentState = {
          ...derivedAgentShell(id, root, entry.jsonlPath),
          spawnAgentKey: entry.agentKey,
          parentAgentId: parent.id,
          role: entry.agentType,
          label: entry.label,
          depth,
        };
        assignChildPalette(agent, parent, agents);
        agents.set(id, agent);
        created.push(agent);
        keysInTree.add(entry.agentKey);
        runByKey.set(entry.agentKey, agent);
        // Flat teammate discovery must never adopt it.
        knownTeammateFiles.add(entry.jsonlPath);
        progress = true;
        console.log(
          `[Pixel Agents] Spawn tree: Agent ${id} is an agent of workflow Agent ${node.id} under Agent ${parent.id} (depth ${depth}, ${path.basename(entry.jsonlPath)})`,
        );
        spawnTreeCallbacks?.onDerivedCreated(agent);
        onAgentCreated?.(agent);
      }
      remaining = deferred;
    }
  }

  if (capped) warnSpawnCap(root, rootId);
  watchCreated(created, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers);
}

/**
 * Scan team config files (via the active TeamProvider) to detect teammate
 * dismissals. A teammate is considered dismissed if:
 *   - The team config no longer lists them in members, OR
 *   - The team config file is missing/unreadable (team dissolved)
 *
 * This is the authoritative source of truth for Agent Teams membership.
 * Returns the IDs of teammates that should be removed.
 */
export function scanTeamConfigsForRemovals(agents: AgentStateStore): number[] {
  const toRemove: number[] = [];
  if (!teamProvider) return toRemove;
  // Group teammates by their teamName for efficient config lookups
  const teammatesByTeam = new Map<string, Array<{ id: number; agent: AgentState }>>();
  for (const [id, agent] of agents) {
    if (agent.leadAgentId === undefined || agent.teamUsesTmux || !agent.teamName) continue;
    let list = teammatesByTeam.get(agent.teamName);
    if (!list) {
      list = [];
      teammatesByTeam.set(agent.teamName, list);
    }
    list.push({ id, agent });
  }

  for (const [teamName, members] of teammatesByTeam) {
    // Provider owns both the read and parse -- returns null on any failure (team dissolved)
    const memberNames = teamProvider.getTeamMembers(teamName);

    for (const { id, agent } of members) {
      if (memberNames === null) {
        toRemove.push(id);
      } else if (agent.agentName && !memberNames.has(agent.agentName)) {
        toRemove.push(id);
      }
    }
  }

  return toRemove;
}

/**
 * Scan all tracked project dirs for teammate JSONL files.
 * Called periodically as a fallback when hooks are disabled.
 */
export function scanAllTeammateFiles(
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  // For each known lead agent, ask the provider to scan for teammate transcripts.
  // CRITICAL: only scan agents that JSONL has confirmed as team leads (teamName set).
  // Without this gate we'd pick up basic subagents' JSONL files (which some CLIs also
  // write to the same teammate directory) and create spurious teammate characters for
  // them when the Agent Teams feature is OFF.
  // Snapshot: the scans below add agents while we iterate.
  for (const [agentId, agent] of [...agents]) {
    // Derived agents are scanned as part of their root's tree, never as roots.
    if (agent.parentAgentId !== undefined) continue;
    if (!agent.sessionId || !agent.projectDir) continue;
    // Spawn tree (docs/adr/0002): sidecar-backed spawns at any depth, each gated
    // by its own parent's live spawn tools; no-ops instantly when no node of
    // the tree runs a spawn. The spawn-tool callback gives low latency, this
    // periodic pass gives robustness (sidecars can land after the tool_use).
    scanSpawnTree(
      agentId,
      agents,
      nextAgentIdRef,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      onAgentCreated,
      true,
    );
    // Teammates are roots of their own spawn trees (scanned above) but never
    // leads to discover teammates for.
    if (agent.leadAgentId !== undefined) continue;
    // Gate: basic-mode agents never get teamName set. Real team leads do, via JSONL.
    if (!agent.teamName) continue;

    scanForTeammateFiles(
      agent.projectDir,
      agent.sessionId,
      agentId,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
      onAgentCreated,
    );
  }
}

// ── External session support (VS Code extension panel, etc.) ──

/**
 * Adopt an external session detected via hooks (SessionStart for unknown session_id).
 * Thinner wrapper than filesystem-based adoptExternalSession: hooks provide
 * transcript_path and cwd directly, no scanning needed.
 */
export function adoptExternalSessionFromHook(
  sessionId: string,
  transcriptPath: string | undefined,
  cwd: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  if (transcriptPath) {
    // File-based provider (Claude, Codex): adopt with JSONL file watching
    // Guard: don't adopt if file is already tracked by an agent
    for (const agent of agents.values()) {
      if (pathsMatch(agent.jsonlFile, transcriptPath)) return;
    }
    // Don't check knownJsonlFiles here -- hooks confirmed this is a real session,
    // and seeded files at startup are in knownJsonlFiles but may become active later.
    if (dismissalTracker!.isDismissed(transcriptPath)) return;
    if (dismissalTracker!.isPermanentlyDismissed(transcriptPath)) return;

    knownJsonlFiles.add(transcriptPath);
    const projectDir = path.dirname(transcriptPath);
    const folderName =
      folderNameResolver?.({ cwd, projectDir }) ??
      folderNameFromProjectDir(path.basename(projectDir));

    adoptExternalSession(
      transcriptPath,
      projectDir,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
      folderName,
    );

    const adoptedAgent = [...agents.values()].find((a) => pathsMatch(a.jsonlFile, transcriptPath));
    if (adoptedAgent && debug) {
      console.log(
        `[Pixel Agents] Hook: Agent ${adoptedAgent.id} - detected external session ${path.basename(transcriptPath)}${adoptedAgent.folderName ? ` (${adoptedAgent.folderName})` : ''}`,
      );
    }
    if (adoptedAgent) {
      adoptedAgent.sessionId = sessionId;
      adoptedAgent.hookDelivered = true;
      onAgentCreated?.(adoptedAgent);
    }
  } else {
    // Hooks-only provider (OpenCode, Copilot): no transcript file, all state from hooks
    const id = nextAgentIdRef.current++;
    const folderName = folderNameResolver?.({ cwd }) ?? (cwd ? path.basename(cwd) : undefined);
    const agent: AgentState = {
      id,
      sessionId,
      terminalRef: undefined,
      isExternal: true,
      projectDir: cwd,
      jsonlFile: '',
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
      hookDelivered: true,
      hooksOnly: true,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      folderName,
      contextTokens: 0,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    };
    assignPaletteIfNeeded(agent, agents);
    agents.set(id, agent);
    persistAgents();
    if (debug) {
      console.log(
        `[Pixel Agents] Hook: Agent ${id} - detected hooks-only external session${folderName ? ` (${folderName})` : ''}`,
      );
    }
    onAgentCreated?.(agent);
  }
}

function adoptExternalSession(
  jsonlFile: string,
  projectDir: string,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  folderName?: string,
): void {
  const id = nextAgentIdRef.current++;
  // Decide whether to replay the existing file content or skip to its end.
  //
  // The external scanner runs every EXTERNAL_SCAN_INTERVAL_MS. A freshly-created
  // session writes its first records in the gap between scanner ticks (typical
  // mock-claude scenarios: tool_use at t=1s, scanner ticks at t=3s). If we
  // unconditionally skip to the end of the file, those pre-adoption records
  // are silently discarded — the agent character appears but its tool history
  // and active tools never surface, producing a "stuck on Idle" UI and flaky
  // e2e failures whose mode depends entirely on scanner-tick alignment.
  //
  // Heuristic: a file whose birthtime is inside the scan window (2× the
  // interval, for one missed tick of margin) is "a session we just watched
  // come to life" — replay it from the start so no records are lost. Older
  // files are ongoing sessions the user already had running before adoption;
  // for those we keep the original skip-to-end behavior so an hours-long
  // session doesn't flash hundreds of past tool overlays through the UI.
  //
  // birthtimeMs is reliable on macOS APFS, Windows NTFS, and modern Linux
  // ext4. On filesystems that don't track it, Node returns the epoch (0) —
  // we treat that as "very old" and skip to end, matching prior behavior.
  let fileOffset = 0;
  try {
    const stat = fs.statSync(jsonlFile);
    const ageMs = stat.birthtimeMs > 0 ? Date.now() - stat.birthtimeMs : Number.POSITIVE_INFINITY;
    const freshnessWindowMs = EXTERNAL_SCAN_INTERVAL_MS * 2;
    fileOffset = ageMs <= freshnessWindowMs ? 0 : stat.size;
  } catch {
    /* start from beginning if stat fails */
  }
  const agent: AgentState = {
    id,
    sessionId: path.basename(jsonlFile, '.jsonl'),
    terminalRef: undefined,
    isExternal: true,
    projectDir,
    jsonlFile,
    fileOffset,
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
    hookDelivered: false,
    lastDataAt: Date.now(),
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    folderName,
    contextTokens: 0,
    maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
  };

  assignPaletteIfNeeded(agent, agents);
  agents.set(id, agent);
  persistAgents();

  // Log is emitted by the caller (adoptExternalSessionFromHook or scanExternalDir)
  // to use the correct prefix (Hook: vs Watcher:).

  startFileWatching(
    id,
    jsonlFile,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
  );
  readNewLines(id, agents, waitingTimers, permissionTimers);
}

/**
 * Periodically scans for external sessions (VS Code extension panel, etc.)
 * that produce JSONL files without an associated terminal.
 */
export function startExternalSessionScanning(
  _projectDir: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  _jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,

  persistAgents: () => void,
  watchAllSessionsRef?: { current: boolean },
  hooksEnabledRef?: { current: boolean },
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    // Scan all tracked project dirs in both hooks and heuristic modes. Hooks are
    // a fast path for producers that emit hook events; polling remains the
    // discovery path for workspace JSONL sessions created without hooks.
    for (const dir of trackedProjectDirs) {
      scanExternalDir(
        dir,
        knownJsonlFiles,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
        hooksEnabledRef,
      );
    }
    // If "Watch All Sessions" is ON, also scan all global project dirs
    if (watchAllSessionsRef?.current) {
      scanGlobalProjectDirs(
        knownJsonlFiles,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
      );
    }
  }, EXTERNAL_SCAN_INTERVAL_MS);
}

/** Scan a single project dir for external sessions. */
export function scanExternalDir(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
  /** True when hooks are delivering. Only then does the hook-driven fast-attach
   *  own teammate sessions; with hooks off this scan IS their discovery path. */
  hooksEnabledRef?: { current: boolean },
): void {
  let files: string[];
  try {
    files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
  } catch {
    return;
  }

  const now = Date.now();

  // If an internal agent in this projectDir is still waiting for its JSONL file
  // (file doesn't exist), skip all adoptions. The agent may have done /resume,
  // and agentManager will detect and reassign it. Prevents the scanner from
  // stealing the file as a new external agent.
  const hasOrphanedInternal = [...agents.values()].some((a) => {
    if (a.isExternal || !pathsMatch(a.projectDir, projectDir)) return false;
    try {
      fs.statSync(a.jsonlFile);
      return false;
    } catch {
      return true;
    }
  });
  if (hasOrphanedInternal) return;

  // SessionEnd(clear/resume) marks the current agent pending before SessionStart
  // reassigns it. Do not let the external scanner steal the replacement file in
  // that brief window.
  const hasPendingReassignment = [...agents.values()].some(
    (agent) => agent.pendingClear && pathsMatch(agent.projectDir, projectDir),
  );
  if (hasPendingReassignment) return;

  for (const file of files) {
    // --resume detection: seeded files whose mtime changed have new data.
    // Adopt directly, bypassing content check (old /clear files have
    // /clear content but should still be adoptable when resumed).
    // File stays in knownJsonlFiles (safe from per-agent /clear stealing).
    const seededMtime = dismissalTracker!.getSeededMtime(file);
    if (seededMtime !== undefined) {
      // Seeded files are pre-existing at extension startup. If mtime changed,
      // it could be --resume or internal agent activity. Don't adopt or reassign
      // here (too ambiguous, causes cascading stealing). Just remove from tracking
      // so the file can be handled through normal adoption if appropriate.
      try {
        const stat = fs.statSync(file);
        if (stat.mtimeMs > seededMtime) {
          dismissalTracker!.clearSeededMtime(file);
          knownJsonlFiles.delete(file);
        }
      } catch {
        /* ignore */
      }
      continue;
    }

    // Skip files already known (seeded or adopted).
    if (knownJsonlFiles.has(file)) continue;

    // Skip files permanently dismissed by /clear (never re-adopted)
    if (dismissalTracker!.isPermanentlyDismissed(file)) continue;

    // Skip files recently dismissed by the user (closed via X).
    // isDismissed() handles the 3-minute cooldown and auto-expires old entries.
    if (dismissalTracker!.isDismissed(file)) continue;

    // Check if already tracked by an agent (normalize paths for comparison).
    // This prevents the external scanner from adopting /clear files (already
    // reassigned to a terminal agent) while allowing untracked files through.
    let tracked = false;
    for (const agent of agents.values()) {
      if (pathsMatch(agent.jsonlFile, file)) {
        tracked = true;
        break;
      }
    }
    if (tracked) continue;

    // WITH HOOKS ON, teammate sessions belong to team discovery, not to generic
    // external adoption. Newer harnesses run each spawned agent as its own
    // top-level session inside the LEAD's projectDir, so this scan sees it too
    // -- and since workspace polling now runs under hooks as well, it can win
    // the race against the hook-driven fast-attach. Adopting it here would strip
    // the teammate identity (no leadAgentId, generic seat instead of the seat
    // closest to its lead).
    //
    // WITH HOOKS OFF there is no fast-attach, so this scan is the ONLY discovery
    // path for tmux teammates and must keep adopting them (they self-identify
    // from their record tags afterwards). Hence the hooksEnabledRef gate.
    //
    // Skip only when the lead is actually tracked; an orphan team session still
    // falls through to normal adoption.
    const teamMeta = hooksEnabledRef?.current
      ? teamProvider?.getTeamMetadataForSession(file)
      : null;
    if (teamMeta?.teamName && teamMeta.agentName) {
      let leadTracked = false;
      for (const agent of agents.values()) {
        if (agent.teamName === teamMeta.teamName && agent.leadAgentId === undefined) {
          leadTracked = true;
          break;
        }
      }
      if (leadTracked) continue;
    }

    // Only adopt recently-active files (modified within threshold).
    try {
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs > EXTERNAL_ACTIVE_THRESHOLD_MS) continue;
    } catch {
      continue;
    }

    // Content check with two-tick delay for /clear files:
    // First tick: skip /clear files (give per-agent 3s to claim for internal /clear).
    // Second tick: per-agent didn't claim → adopt as new external agent.
    try {
      const buf = Buffer.alloc(8192);
      const fd = fs.openSync(file, 'r');
      const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      if (buf.toString('utf-8', 0, bytesRead).includes('/clear</command-name>')) {
        if (!dismissalTracker!.hasPendingClear(file)) {
          dismissalTracker!.registerPendingClear(file);
          continue; // First tick: skip, give per-agent a chance
        }
        dismissalTracker!.clearPendingClear(file);
        // Second tick: per-agent didn't claim → fall through to adopt
      }
    } catch {
      continue;
    }

    knownJsonlFiles.add(file);
    console.log(`[Pixel Agents] Watcher: detected external session ${path.basename(file)}`);
    adoptExternalSession(
      file,
      projectDir,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      persistAgents,
    );
  }
}

/** Derive a readable folder name from the Claude project dir hash. */
function folderNameFromProjectDir(dirName: string): string {
  const parts = dirName.replace(/^-+/, '').split('-');
  return parts[parts.length - 1] || dirName;
}

/** Scan every session root the active provider exposes for active sessions
 *  (global discovery — powers the "Watch All Sessions" toggle). */
function scanGlobalProjectDirs(
  knownJsonlFiles: Set<string>,
  nextAgentIdRef: { current: number },
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
): void {
  const roots = hookProvider?.getAllSessionRoots?.() ?? [];
  if (roots.length === 0) return;

  const projectDirs: string[] = [];
  for (const root of roots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) projectDirs.push(path.join(root, entry.name));
      }
    } catch {
      // root missing / unreadable -> skip
    }
  }

  const now = Date.now();
  for (const dirPath of projectDirs) {
    // Skip directories already tracked by workspace scanning
    if (isTrackedProjectDir(dirPath)) continue;

    let files: string[];
    try {
      files = fs
        .readdirSync(dirPath)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dirPath, f));
    } catch {
      continue;
    }

    for (const file of files) {
      if (knownJsonlFiles.has(file)) continue;
      let tracked = false;
      for (const agent of agents.values()) {
        if (pathsMatch(agent.jsonlFile, file)) {
          tracked = true;
          break;
        }
      }
      if (tracked) continue;
      // Activity filter: >3KB AND modified within 10 minutes
      try {
        const stat = fs.statSync(file);
        if (stat.size < GLOBAL_SCAN_ACTIVE_MIN_SIZE) continue;
        if (now - stat.mtimeMs > GLOBAL_SCAN_ACTIVE_MAX_AGE_MS) continue;
      } catch {
        continue;
      }

      const folderName =
        folderNameResolver?.({ projectDir: dirPath }) ??
        folderNameFromProjectDir(path.basename(dirPath));
      knownJsonlFiles.add(file);
      console.log(
        `[Pixel Agents] Watcher: detected global session ${path.basename(file)} (${folderName})`,
      );
      adoptExternalSession(
        file,
        dirPath,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        persistAgents,
        folderName,
      );
    }
  }
}

/**
 * Periodically removes stale external agents whose JSONL files
 * haven't been modified recently.
 */
export function startStaleExternalAgentCheck(
  agents: AgentStateStore,
  knownJsonlFiles: Set<string>,
  hooksEnabledRef?: { current: boolean },
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    // When hooks are active, SessionEnd handles agent cleanup.
    if (hooksEnabledRef?.current) return;
    const toRemove: number[] = [];

    for (const [id, agent] of agents) {
      if (!agent.isExternal) continue;
      // A workflow node has no transcript by design; it leaves with its run.
      if (agent.nodeKind === 'workflow') continue;

      // Only despawn if the JSONL file has been deleted from disk.
      // Inactive external agents stay alive so they can resume when
      // the session continues (e.g., claude --resume).
      try {
        fs.statSync(agent.jsonlFile);
        // File still exists — keep the agent alive regardless of mtime
      } catch {
        // File deleted — remove agent
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      const agent = agents.get(id);
      if (agent) {
        // Remove from knownJsonlFiles so the file can be re-adopted if it becomes active again
        knownJsonlFiles.delete(agent.jsonlFile);
      }
      console.log(`[Pixel Agents] Watcher: Agent ${id} - removing stale external agent`);
      agentRemovalCallback?.(id);
    }
  }, EXTERNAL_STALE_CHECK_INTERVAL_MS);
}

export function reassignAgentToFile(
  agentId: number,
  newFilePath: string,
  agents: AgentStateStore,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,

  persistAgents: () => void,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  // Stop old file watching
  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
  }
  pollingTimers.delete(agentId);

  // Clear activity
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);
  clearAgentActivity(agent, agentId, agents, permissionTimers);

  // Permanently dismiss old file so scanners never re-adopt it as external
  dismissalTracker!.permanentlyDismiss(agent.jsonlFile);

  // Swap to new file (update sessionId for hook registration).
  // Keep hookDelivered — if hooks worked before /clear, they'll work after.
  agent.sessionId = path.basename(newFilePath, '.jsonl');
  agent.jsonlFile = newFilePath;
  agent.fileOffset = 0;
  agent.lineBuffer = '';
  persistAgents();

  // Start watching new file
  startFileWatching(
    agentId,
    newFilePath,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
  );
  readNewLines(agentId, agents, waitingTimers, permissionTimers);
}
