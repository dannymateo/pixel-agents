/**
 * AgentRuntime: shared agent lifecycle core for VS Code and standalone modes.
 *
 * Owns all infrastructure that both PixelAgentsViewProvider (VS Code) and the
 * standalone CLI need: timer Maps, file watchers, HookEventHandler, DismissalTracker,
 * session scanning, and agent removal. Adapters (VS Code, CLI) create an instance
 * and register platform-specific lifecycle callbacks.
 *
 * This is the single source of truth for agent lifecycle wiring. No duplication.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import { clampIdleToLoungeMinutes } from './configPersistence.js';
import { DEFAULT_MAX_CONTEXT_TOKENS, IDLE_TO_LOUNGE_MS_DEFAULT } from './constants.js';
import { DismissalTracker } from './dismissalTracker.js';
import {
  adoptExternalSessionFromHook,
  ensureProjectScan,
  isTrackedProjectDir,
  notifyDerivedRemoved,
  reassignAgentToFile,
  registerWorkflowLaunch,
  restorableSpawnToolIds,
  rootOf,
  scanForTeammateFiles,
  scanSpawnTree,
  setAgentRemovalCallback,
  setDismissalTracker,
  setHookProvider as setFileWatcherHookProvider,
  setSpawnTreeCallbacks,
  setTeammateRegisterCallback,
  setTeammateRemovalCallback,
  setTeamProvider,
  startExternalSessionScanning,
  startFileWatching,
  startStaleExternalAgentCheck,
} from './fileWatcher.js';
import type { HookEvent } from './hookEventHandler.js';
import { HookEventHandler } from './hookEventHandler.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import { PathSet, pathsMatch } from './pathKey.js';
import { IDLE_TO_LOUNGE_SETTING_KEY, PresenceTracker } from './presence.js';
import { SessionRouter } from './sessionRouter.js';
import { subtreeRemovalOrder } from './spawnTree.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import {
  clearSpawnFinished,
  releaseBackgroundSpawn,
  setAgentPromptedCallback,
  setBackgroundAgentCompletedCallback,
  setBackgroundAgentDetectedCallback,
  setHookProvider,
  setSpawnFinishedCallback,
  setSpawnToolClosedCallback,
  setTeamSwitchCallback,
  setWorkflowLaunchedCallback,
} from './transcriptParser.js';
import type { AgentState } from './types.js';

/** Callbacks that adapters register for platform-specific behavior. */
export interface RuntimeLifecycleCallbacks {
  /** Called after an agent is removed. Adapters use this to dismiss JSONL files, etc. */
  onAgentRemoved?: (agentId: number, agent: AgentState) => void;
  /** Called when a teammate is removed. */
  onTeammateRemoved?: (teammateId: number, agent: AgentState, source: string) => void;
}

export class AgentRuntime {
  // Per-agent timer Maps (shared by all fileWatcher/hookEventHandler operations)
  readonly fileWatchers = new Map<number, fs.FSWatcher>();
  readonly pollingTimers = new Map<number, ReturnType<typeof setInterval>>();
  readonly waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  readonly jsonlPollTimers = new Map<number, ReturnType<typeof setInterval>>();

  // Scanning state. PathSet (not Set) so a transcript adopted via hooks is still
  // recognized as known when a scanner rebuilds the path from the workspace folder
  // -- the two spellings differ by drive-letter case on Windows.
  readonly knownJsonlFiles = new PathSet();
  readonly projectScanTimer = { current: null as ReturnType<typeof setInterval> | null };
  readonly activeAgentId = { current: null as number | null };
  private externalScanTimer: ReturnType<typeof setInterval> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;

  // Configuration refs (mutable, shared with scanners)
  readonly watchAllSessions = { current: false };
  readonly hooksEnabled = { current: true };

  // Dependencies
  readonly dismissalTracker = new DismissalTracker();
  private hookEventHandler: HookEventHandler;
  private lifecycleCallbacks: RuntimeLifecycleCallbacks = {};
  /** Roots with a coalesced tree scan queued (see scheduleTreeScan). */
  private readonly pendingTreeScans = new Set<number>();
  /** Children of workflow nodes: their workflow node and whether their last
   *  reported status was active. A workflow node's own status is derived
   *  from these (active if any child is, else waiting). */
  private readonly workflowChildren = new Map<number, { nodeId: number; active: boolean }>();
  private readonly onStoreBroadcast = (msg: Record<string, unknown>): void => {
    if (msg.type !== 'agentStatus' || typeof msg.id !== 'number') return;
    const nodeId = this.store.get(msg.id)?.parentAgentId;
    if (nodeId === undefined || this.store.get(nodeId)?.nodeKind !== 'workflow') return;
    this.workflowChildren.set(msg.id, { nodeId, active: msg.status === 'active' });
    this.refreshWorkflowStatus(nodeId);
  };
  private readonly onStoreAgentRemoved = (id: number): void => {
    const child = this.workflowChildren.get(id);
    if (!child) return;
    this.workflowChildren.delete(id);
    this.refreshWorkflowStatus(child.nodeId);
  };
  private disposed = false;
  /** Living-office presence of every derived agent (docs/adr/0003). */
  readonly presence: PresenceTracker;
  /** The user's idle-to-lounge setting, read from the adapter on first use. */
  private idleToLoungeMinutes: number | undefined;

  constructor(
    private readonly store: AgentStateStore,
    private readonly provider: HookProvider,
  ) {
    // Wire module-level dependencies
    setDismissalTracker(this.dismissalTracker);
    setHookProvider(provider);
    setFileWatcherHookProvider(provider);
    if (provider.team) {
      setTeamProvider(provider.team);
    }
    this.presence = new PresenceTracker(store, {
      idleToLoungeMs: () => this.idleToLoungeMs(),
      // A departed agent goes for good once its walk out is over.
      remove: (id) => this.removeAgent(id),
    });
    setAgentRemovalCallback((id) => this.removeAgent(id));
    setTeammateRemovalCallback((id) => this.removeTeammate(id, 'team-config'));
    // New-style teammates run their own sessions; registering routes their hook
    // events (PreToolUse, Stop, SessionEnd) directly to the teammate agent.
    setTeammateRegisterCallback((sessionId, agentId) => this.registerAgent(sessionId, agentId));
    // Spawn tree (docs/adr/0002): any node opening a spawn tool (or a spawn
    // turning out to be a background launch) scans its whole tree. Living
    // office (docs/adr/0003): a background agent that finishes stays,
    // available; the spawn ending for good — killed/stopped notice, TaskStop,
    // workflow completion, foreground tool_result, or a foreground spawn
    // dropped at turn end — walks its derived subtree out.
    setBackgroundAgentDetectedCallback((agentId) => this.scanTree(rootOf(agentId, this.store)));
    setBackgroundAgentCompletedCallback((agentId, toolUseId) =>
      this.leaveSpawnChild(agentId, toolUseId, 'spawn-ended'),
    );
    setSpawnToolClosedCallback((agentId, toolUseId) =>
      this.leaveSpawnChild(agentId, toolUseId, 'spawn-closed'),
    );
    setSpawnFinishedCallback((agentId, toolUseId) => {
      const child = this.spawnChild(agentId, toolUseId);
      if (child) this.presence.markFinished(child.id);
    });
    // A prompt written after a derived agent finished is its parent resuming
    // it (SendMessage): back to work, and its spawn no longer counts as done.
    setAgentPromptedCallback((agentId, at) => {
      if (!this.presence.markPrompted(agentId, at)) return;
      const agent = this.store.get(agentId);
      const parent =
        agent?.parentAgentId !== undefined ? this.store.get(agent.parentAgentId) : undefined;
      if (parent && agent?.spawnToolUseId) clearSpawnFinished(parent, agent.spawnToolUseId);
    });
    // A Workflow launch becomes a node of the tree (spec §2.1b); it leaves
    // through the background-completion path above, like any background spawn.
    setWorkflowLaunchedCallback((agentId, toolUseId, launch) =>
      registerWorkflowLaunch(agentId, toolUseId, launch, this.store, this.store.nextAgentId),
    );
    store.on('broadcast', this.onStoreBroadcast);
    store.on('agentRemoved', this.onStoreAgentRemoved);
    // Hook events carrying an agent key route to the derived agent they name.
    setSpawnTreeCallbacks({
      onDerivedCreated: (a) => {
        if (a.spawnAgentKey)
          this.hookEventHandler.registerSpawn(a.sessionId, a.spawnAgentKey, a.id);
      },
      onDerivedRemoved: (a) => {
        if (a.spawnAgentKey) this.hookEventHandler.unregisterSpawn(a.sessionId, a.spawnAgentKey);
      },
      onTreeFull: (rootId, deferred) => this.makeRoomInTree(rootId, deferred),
    });
    // A resumed lead that spawns again belongs to a freshly minted implicit
    // team; its previous team's teammates are defunct. Promoted anonymous
    // background agents (leadAgentId but no teamName) are left untouched.
    setTeamSwitchCallback((leadId, previousTeamName) => {
      const stale = [...this.store].filter(
        ([, a]) => a.leadAgentId === leadId && a.teamName === previousTeamName,
      );
      for (const [id] of stale) {
        this.removeTeammate(id, 'team-switch');
      }
    });

    this.hookEventHandler = new HookEventHandler(
      store,
      this.waitingTimers,
      this.permissionTimers,
      provider,
      new SessionRouter(),
      this.watchAllSessions,
    );

    // Wire hook lifecycle callbacks to shared agent operations
    this.hookEventHandler.setLifecycleCallbacks({
      onExternalSessionDetected: (sessionId, transcriptPath, cwd) => {
        const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
        // Teammate session of a tracked lead? Attach it as a teammate character
        // instead of adopting a generic external agent -- and regardless of the
        // Watch All Sessions setting: tracking the lead is the opt-in for its
        // team. (Newer harnesses run every spawned agent as an independent
        // top-level session that fires its own hooks.)
        if (transcriptPath) {
          const teamMeta = provider.team?.getTeamMetadataForSession(transcriptPath);
          if (teamMeta?.teamName && teamMeta.agentName) {
            for (const [leadId, lead] of this.store) {
              if (lead.teamName !== teamMeta.teamName || lead.leadAgentId !== undefined) continue;
              console.log(
                `[Pixel Agents] Hook: session ${sessionId.slice(0, 8)}... is teammate "${teamMeta.agentName}" of Agent ${leadId}, attaching`,
              );
              scanForTeammateFiles(
                lead.projectDir,
                lead.sessionId,
                leadId,
                this.store.nextAgentId,
                this.store,
                this.fileWatchers,
                this.pollingTimers,
                this.waitingTimers,
                this.permissionTimers,
                () => this.store.persist(),
                undefined,
              );
              break;
            }
            // Done only if discovery actually adopted this transcript. Old-style
            // tmux teammates (non-UUID transcript names outside discovery's scan)
            // fall through to normal external adoption and self-identify from
            // their record tags.
            for (const a of this.store.values()) {
              if (pathsMatch(a.jsonlFile, transcriptPath)) return;
            }
          }
        }
        if (!isTrackedProjectDir(projectDir) && !this.watchAllSessions.current) {
          console.log(
            `[Pixel Agents] Hook: external session ${sessionId.slice(0, 8)}... not adopted ` +
              `(project untracked, Watch All Sessions off)`,
          );
          return;
        }
        adoptExternalSessionFromHook(
          sessionId,
          transcriptPath,
          cwd,
          this.knownJsonlFiles,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          (agent) => this.registerAgent(agent.sessionId, agent.id),
        );
      },
      onSessionClear: (agentId, newSessionId, newTranscriptPath) => {
        // The old session's spawn tree ends with it: drop every derived agent
        // (and its key routing) BEFORE the root moves to the new session, or
        // they would linger under a session that no longer exists.
        const previous = this.store.get(agentId);
        if (previous) {
          this.forgetSpawns(previous, agentId);
          this.leaveSubtree(agentId, false);
          this.hookEventHandler.clearSpawns(previous.sessionId);
        }
        if (newTranscriptPath) {
          this.knownJsonlFiles.add(newTranscriptPath);
          reassignAgentToFile(
            agentId,
            newTranscriptPath,
            this.store,
            this.fileWatchers,
            this.pollingTimers,
            this.waitingTimers,
            this.permissionTimers,
            () => this.store.persist(),
          );
        }
        const agent = this.store.get(agentId);
        if (agent) {
          this.unregisterAgent(agent.sessionId);
          agent.sessionId = newSessionId;
          this.registerAgent(agent.sessionId, agent.id);
        }
      },
      onSessionResume: (transcriptPath) => {
        this.dismissalTracker.clearDismissal(transcriptPath);
        this.dismissalTracker.clearSeededMtime(transcriptPath);
        this.knownJsonlFiles.delete(transcriptPath);
      },
      onTeammateDetected: (parentAgentId, sessionId, _agentType) => {
        const parentAgent = this.store.get(parentAgentId);
        if (!parentAgent) return;
        scanForTeammateFiles(
          parentAgent.projectDir,
          sessionId,
          parentAgentId,
          this.store.nextAgentId,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
          () => this.store.persist(),
          // Don't register inline teammates: they share the lead's sessionId
          // and registering them would overwrite the lead in the session router.
          undefined,
        );
      },
      onTeammateRemoved: (teammateAgentId) => {
        this.removeTeammate(teammateAgentId, 'hooks');
      },
      // SubagentStart arrives in bursts (one per child): coalesced per root.
      onSpawnObserved: (agentId) => this.scheduleTreeScan(rootOf(agentId, this.store)),
      onSessionEnd: (agentId) => {
        const agent = this.store.get(agentId);
        if (!agent) return;
        this.dismissalTracker.clearSeededMtime(agent.jsonlFile);
        this.dismissalTracker.dismiss(agent.jsonlFile);
        // Every agent it spawned leaves with the session, whole subtrees,
        // leaves first — even when the session agent itself stays (terminal
        // agents).
        this.forgetSpawns(agent, agentId);
        this.leaveSubtree(agentId, false);
        // Covers real team leads AND leads of background teammates (which
        // have children but no teamName). No-op when childless.
        this.removeTeammates(agentId);
        this.hookEventHandler.clearSpawns(agent.sessionId);
        if (agent.isExternal) {
          this.unregisterAgent(agent.sessionId);
          this.removeAgent(agentId);
        }
      },
    });
  }

  /** Register adapter-specific lifecycle callbacks. */
  setLifecycleCallbacks(callbacks: RuntimeLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  // ── Hook event routing ──

  /** Route an incoming hook event to the appropriate agent. */
  handleHookEvent(providerId: string, event: Record<string, unknown>): void {
    this.hookEventHandler.handleEvent(providerId, event as HookEvent);
  }

  /** Register an agent with the hook event handler for session->agent mapping. */
  registerAgent(sessionId: string, agentId: number): void {
    this.hookEventHandler.registerAgent(sessionId, agentId);
  }

  /** Unregister an agent from the hook event handler. */
  unregisterAgent(sessionId: string): void {
    this.hookEventHandler.unregisterAgent(sessionId);
  }

  // ── Agent removal (shared cleanup) ──

  /**
   * Remove an agent: stop watchers, cancel timers, delete from store. Unknown
   * ids are a no-op.
   *
   * - A session root goes now (it keeps its own effect); every agent below it
   *   walks out through the living office's exit (docs/adr/0003), leaves
   *   first and staggered, and is removed once its walk is over.
   * - A derived agent goes now with its whole spawn subtree, leaves first.
   *   This is the forced path (the end of a walk out, a vanished transcript,
   *   shutdown); an exit the user should see goes through closeAgent.
   */
  removeAgent(id: number): void {
    const target = this.store.get(id);
    if (!target) return;
    if (target.parentAgentId === undefined && !this.disposed) {
      this.leaveSubtree(id, false);
      this.removeSingleAgent(id);
      this.store.persist();
      return;
    }
    const parentOf = new Map<number, number | undefined>();
    for (const [aid, a] of this.store) parentOf.set(aid, a.parentAgentId);
    const leads = new Set<number>();
    for (const victim of subtreeRemovalOrder(id, parentOf)) {
      const removed = this.removeSingleAgent(victim);
      // A named derived agent leaving may empty its spawner's derived team.
      if (removed?.parentAgentId !== undefined && removed.leadAgentId !== undefined) {
        leads.add(removed.leadAgentId);
      }
    }
    this.store.persist();
    for (const leadId of leads) this.demoteLeadIfTeamEmpty(leadId);
  }

  /** Materialize whatever the spawn tree under `rootId` can grow right now. */
  scanTree(rootId: number): void {
    scanSpawnTree(
      rootId,
      this.store,
      this.store.nextAgentId,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
    );
  }

  /** Queue one scan of `rootId`'s tree for the next microtask. Any number of
   *  requests for the same root before then collapse into that single scan. */
  scheduleTreeScan(rootId: number): void {
    if (this.disposed || this.pendingTreeScans.has(rootId)) return;
    this.pendingTreeScans.add(rootId);
    queueMicrotask(() => {
      this.pendingTreeScans.delete(rootId);
      if (!this.disposed) this.scanTree(rootId);
    });
  }

  /** Re-derive a workflow node's status from its children and broadcast it
   *  when it changed: active while any child is active, otherwise waiting. */
  private refreshWorkflowStatus(nodeId: number): void {
    const node = this.store.get(nodeId);
    if (!node || node.nodeKind !== 'workflow') return;
    let active = false;
    for (const [childId, child] of this.workflowChildren) {
      if (child.nodeId === nodeId && child.active && this.store.has(childId)) {
        active = true;
        break;
      }
    }
    if (active === !node.isWaiting) return;
    node.isWaiting = !active;
    this.store.broadcast(
      active
        ? { type: 'agentStatus', id: nodeId, status: 'active' }
        : { type: 'agentStatus', id: nodeId, status: 'waiting', awaitingInput: false },
    );
  }

  /** The user closed an agent. A derived one walks out with its subtree
   *  (docs/adr/0003) and its transcript is dismissed, so the live spawn that
   *  started it cannot bring it back; a session root is removed now, its tree
   *  walking out behind it. */
  closeAgent(id: number): void {
    const agent = this.store.get(id);
    if (!agent) return;
    if (agent.parentAgentId === undefined) {
      this.removeAgent(id);
      return;
    }
    if (agent.jsonlFile) this.dismissalTracker.dismiss(agent.jsonlFile);
    // A background spawn ends with it here too, so its parent stops holding
    // it live (and the tree scan stops looking for it).
    if (
      agent.spawnToolUseId !== undefined &&
      releaseBackgroundSpawn(agent.parentAgentId, agent.spawnToolUseId, this.store)
    ) {
      return;
    }
    this.leaveSubtree(id, true);
  }

  /** The derived agent a spawn tool call of `parentId` started, if any. */
  private spawnChild(parentId: number, toolUseId: string): AgentState | undefined {
    for (const a of this.store.values()) {
      if (a.parentAgentId === parentId && a.spawnToolUseId === toolUseId) return a;
    }
    return undefined;
  }

  /** The spawn ended for good: its derived agent (and subtree) walks out. */
  private leaveSpawnChild(parentId: number, toolUseId: string, source: string): void {
    const child = this.spawnChild(parentId, toolUseId);
    if (!child) return;
    if (child.leadAgentId !== undefined) {
      console.log(`[Pixel Agents] Teammate ${child.id} leaving (source: ${source})`);
    }
    this.leaveSubtree(child.id, true);
  }

  /**
   * Walk every derived agent below `id` (and `id` itself when `includeSelf`)
   * out of the office, leaves first. Each stops being read and spawns nothing
   * more right away; the PresenceTracker removes it once its walk is over.
   * Agents already leaving keep their place in the queue.
   */
  private leaveSubtree(id: number, includeSelf: boolean): void {
    const parentOf = new Map<number, number | undefined>();
    for (const [aid, a] of this.store) parentOf.set(aid, a.parentAgentId);
    const leaving: number[] = [];
    for (const victim of subtreeRemovalOrder(id, parentOf)) {
      if (victim === id && !includeSelf) continue;
      const a = this.store.get(victim);
      if (!a || a.parentAgentId === undefined || a.presence === 'leaving') continue;
      this.quiesce(victim, a);
      leaving.push(victim);
    }
    if (leaving.length > 0) this.presence.beginLeave(leaving);
  }

  /** A leaving agent stops: no more transcript reading, no pending status
   *  timers, no live spawns (nothing new may hang below it). */
  private quiesce(id: number, agent: AgentState): void {
    const pt = this.pollingTimers.get(id);
    if (pt) clearInterval(pt);
    this.pollingTimers.delete(id);
    this.fileWatchers.get(id)?.close();
    this.fileWatchers.delete(id);
    cancelWaitingTimer(id, this.waitingTimers);
    cancelPermissionTimer(id, this.permissionTimers);
    this.forgetSpawns(agent, id, false);
  }

  /**
   * `rootId`'s tree is full while `wanted` spawns wait. Finished background
   * agents resting at the bottom of the tree (lounge first, then the longest
   * available) are let go — their spawn ends and they walk out — so working
   * spawns get their place once the walk is over. Agents already leaving
   * count as room on its way; only background spawns are released (a
   * workflow's agents leave with their run).
   */
  private makeRoomInTree(rootId: number, wanted: number): void {
    const inTree: AgentState[] = [];
    const hasChildren = new Set<number>();
    for (const a of this.store.values()) {
      if (a.parentAgentId === undefined || rootOf(a.id, this.store) !== rootId) continue;
      inTree.push(a);
      hasChildren.add(a.parentAgentId);
    }
    let need = wanted - inTree.filter((a) => a.presence === 'leaving').length;
    if (need <= 0) return;
    const resting = inTree
      .filter(
        (a) =>
          (a.presence === 'lounge' || a.presence === 'available') &&
          a.spawnToolUseId !== undefined &&
          !hasChildren.has(a.id),
      )
      .sort(
        (x, y) =>
          (x.presence === 'lounge' ? 0 : 1) - (y.presence === 'lounge' ? 0 : 1) ||
          (x.availableSince ?? 0) - (y.availableSince ?? 0),
      );
    for (const a of resting) {
      if (need <= 0) break;
      if (releaseBackgroundSpawn(a.parentAgentId!, a.spawnToolUseId!, this.store)) {
        console.log(`[Pixel Agents] Spawn tree of Agent ${rootId} is full: Agent ${a.id} leaves`);
        need--;
      }
    }
  }

  // ── Living office settings ──

  /** How long an available agent waits before the lounge, in ms. */
  idleToLoungeMs(): number {
    if (this.idleToLoungeMinutes === undefined) {
      const fallback = IDLE_TO_LOUNGE_MS_DEFAULT / 60_000;
      this.idleToLoungeMinutes =
        clampIdleToLoungeMinutes(
          this.store.getAdapter()?.getSetting(IDLE_TO_LOUNGE_SETTING_KEY, fallback),
        ) ?? fallback;
    }
    return this.idleToLoungeMinutes * 60_000;
  }

  /** Set (clamped) and persist, per adapter namespace, the idle-to-lounge
   *  minutes. Returns the value kept; a non-number changes nothing. */
  setIdleToLoungeMinutes(minutes: number): number {
    const clamped = clampIdleToLoungeMinutes(minutes);
    if (clamped === undefined) return this.idleToLoungeMs() / 60_000;
    this.idleToLoungeMinutes = clamped;
    this.store.getAdapter()?.setSetting(IDLE_TO_LOUNGE_SETTING_KEY, clamped);
    return clamped;
  }

  /** The session ended: none of its spawns is live any more. Forget them on
   *  the session agent (background launches and still-open spawn tools) so the
   *  periodic scan's live-spawn gate can't re-materialize the children just
   *  removed — the CLI exiting kills background agents, whose completion
   *  queue-operation then never comes. Their Subtask sprites go too. */
  private forgetSpawns(agent: AgentState, agentId: number, persist = true): void {
    const spawnTools = this.provider.subagentToolNames;
    const dropped = new Set(agent.backgroundAgentToolIds);
    for (const toolId of agent.activeToolIds) {
      const name = agent.activeToolNames.get(toolId);
      if (name && spawnTools.has(name)) dropped.add(toolId);
    }
    if (dropped.size === 0) return;
    for (const toolId of dropped) {
      agent.activeToolIds.delete(toolId);
      agent.activeToolStatuses.delete(toolId);
      agent.activeToolNames.delete(toolId);
      agent.activeSubagentToolIds.delete(toolId);
      agent.activeSubagentToolNames.delete(toolId);
      this.store.broadcast({ type: 'subagentClear', id: agentId, parentToolId: toolId });
    }
    agent.backgroundAgentToolIds.clear();
    if (persist) this.store.persist();
  }

  /** Remove exactly one agent (no cascade). Returns it, or undefined when the
   *  id is already gone (a cascade may race another removal). */
  private removeSingleAgent(id: number): AgentState | undefined {
    const agent = this.store.get(id);
    if (!agent) return undefined;

    // Stop JSONL poll timer
    const jpTimer = this.jsonlPollTimers.get(id);
    if (jpTimer) {
      clearInterval(jpTimer);
    }
    this.jsonlPollTimers.delete(id);

    // Stop file watching
    this.fileWatchers.get(id)?.close();
    this.fileWatchers.delete(id);
    const pt = this.pollingTimers.get(id);
    if (pt) {
      clearInterval(pt);
    }
    this.pollingTimers.delete(id);

    // Cancel timers
    cancelWaitingTimer(id, this.waitingTimers);
    cancelPermissionTimer(id, this.permissionTimers);

    // Notify adapter before deleting from store
    this.lifecycleCallbacks.onAgentRemoved?.(id, agent);

    // Derived agents stop receiving hook events routed by their agent key.
    if (agent.spawnAgentKey) notifyDerivedRemoved(agent);

    // Remove from store (fires agentRemoved event); the caller persists.
    this.store.delete(id);
    return agent;
  }

  /** Remove a single teammate agent. A derived teammate (docs/adr/0002) walks
   *  out instead; its lead badge drops once it is actually gone. */
  removeTeammate(teammateId: number, source: string): void {
    const agent = this.store.get(teammateId);
    if (!agent) return;
    if (agent.parentAgentId !== undefined) {
      if (agent.presence === 'leaving') return;
      console.log(`[Pixel Agents] Teammate ${teammateId} leaving (source: ${source})`);
      this.dismissalTracker.dismiss(agent.jsonlFile);
      this.lifecycleCallbacks.onTeammateRemoved?.(teammateId, agent, source);
      this.leaveSubtree(teammateId, true);
      return;
    }
    console.log(`[Pixel Agents] Removing teammate ${teammateId} (source: ${source})`);
    this.dismissalTracker.dismiss(agent.jsonlFile);
    // Background teammates (spawnToolUseId set) share the LEAD's session id;
    // unregistering it would knock the lead itself out of the session router.
    if (!agent.spawnToolUseId) {
      this.unregisterAgent(agent.sessionId);
    }
    this.lifecycleCallbacks.onTeammateRemoved?.(teammateId, agent, source);
    this.removeAgent(teammateId);
    if (agent.leadAgentId !== undefined) {
      this.demoteLeadIfTeamEmpty(agent.leadAgentId);
    }
  }

  /** Drop the LEAD badge when the last teammate leaves. teamName is kept: it
   *  still routes discovery of late-arriving teammates of the same generation
   *  (and linkTeammates / the derived-team path re-badge on the next spawn). */
  private demoteLeadIfTeamEmpty(leadId: number): void {
    const lead = this.store.get(leadId);
    if (!lead || !lead.isTeamLead) return;
    for (const a of this.store.values()) {
      if (a.leadAgentId === leadId) return;
    }
    lead.isTeamLead = undefined;
    this.store.broadcast({
      type: 'agentTeamInfo',
      id: leadId,
      teamName: lead.teamName,
      agentName: lead.agentName,
      isTeamLead: undefined,
      leadAgentId: lead.leadAgentId,
    });
    this.store.persist();
  }

  /** Remove all teammates of a lead agent. */
  removeTeammates(leadId: number): void {
    const teammates: number[] = [];
    for (const [id, agent] of this.store) {
      if (agent.leadAgentId === leadId) {
        teammates.push(id);
      }
    }
    for (const id of teammates) {
      const agent = this.store.get(id);
      if (agent?.parentAgentId !== undefined) {
        // A derived teammate walks out with its spawner's tree.
        this.leaveSubtree(id, true);
      } else if (agent) {
        console.log(`[Pixel Agents] Removing teammate ${id} (lead ${leadId} closed)`);
        this.dismissalTracker.dismiss(agent.jsonlFile);
        if (!agent.spawnToolUseId) {
          this.unregisterAgent(agent.sessionId);
        }
        this.removeAgent(id);
      }
    }
  }

  // ── Scanning ──

  /** Start project-level scanning for a directory. */
  startProjectScan(projectDir: string, onAgentCreated?: (agent: AgentState) => void): void {
    ensureProjectScan(
      projectDir,
      this.knownJsonlFiles,
      this.projectScanTimer,
      this.activeAgentId,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      () => this.store.persist(),
      onAgentCreated ?? ((agent) => this.registerAgent(agent.sessionId, agent.id)),
      this.hooksEnabled,
    );
  }

  /** Start external session scanning (detects sessions from other terminals). */
  startExternalScanning(projectDir: string): void {
    if (this.externalScanTimer) return;

    this.externalScanTimer = startExternalSessionScanning(
      projectDir,
      this.knownJsonlFiles,
      this.store.nextAgentId,
      this.store,
      this.fileWatchers,
      this.pollingTimers,
      this.waitingTimers,
      this.permissionTimers,
      this.jsonlPollTimers,
      () => this.store.persist(),
      this.watchAllSessions,
      this.hooksEnabled,
    );
  }

  /** Start stale external agent check (removes agents whose JSONL files are deleted). */
  startStaleCheck(): void {
    if (this.staleCheckTimer) return;

    this.staleCheckTimer = startStaleExternalAgentCheck(
      this.store,
      this.knownJsonlFiles,
      this.hooksEnabled,
    );
  }

  // ── Restore persisted external agents (standalone) ──

  /**
   * Re-create external agents from the adapter's persistence on startup.
   * Only external agents are restorable here (no terminal to rebind).
   * VS Code uses its own restoreAgents() in agentManager.ts to also handle
   * terminal agents via vscode.window.terminals.
   */
  restoreExternalAgents(): void {
    const adapter = this.store.getAdapter();
    if (!adapter) return;
    const persisted = adapter.loadAgents();
    if (persisted.length === 0) return;

    let maxId = 0;

    for (const p of persisted) {
      if (!p.isExternal) continue;
      // Background-spawn children (a leadAgentId but no teamName) are derived
      // state: the 1s scan re-materializes them from sidecars while their spawn
      // is live. Restoring them directly would resurrect immortal characters
      // (also skips stale entries written by older builds that persisted them).
      if (p.leadAgentId !== undefined && !p.teamName) continue;
      try {
        if (!fs.existsSync(p.jsonlFile)) continue;
      } catch {
        continue;
      }
      if (this.store.has(p.id)) {
        this.knownJsonlFiles.add(p.jsonlFile);
        if (p.id > maxId) maxId = p.id;
        continue;
      }

      const agent: AgentState = {
        id: p.id,
        sessionId: p.sessionId || path.basename(p.jsonlFile, '.jsonl'),
        terminalRef: undefined,
        isExternal: true,
        projectDir: p.projectDir,
        jsonlFile: p.jsonlFile,
        fileOffset: 0,
        lineBuffer: '',
        activeToolIds: new Set(),
        activeToolStatuses: new Map(),
        activeToolNames: new Map(),
        activeSubagentToolIds: new Map(),
        activeSubagentToolNames: new Map(),
        // Live spawn ids survive the restart so the 1s scan can re-adopt the
        // spawns' transcripts and the completion queue-op still matches --
        // unless the session went quiet long ago (died without SessionEnd).
        backgroundAgentToolIds: restorableSpawnToolIds(
          {
            jsonlFile: p.jsonlFile,
            projectDir: p.projectDir,
            sessionId: p.sessionId || path.basename(p.jsonlFile, '.jsonl'),
          },
          p.backgroundAgentToolIds,
        ),
        isWaiting: false,
        permissionSent: false,
        hadToolsInTurn: false,
        lastDataAt: 0,
        linesProcessed: 0,
        seenUnknownRecordTypes: new Set(),
        folderName: p.folderName,
        hookDelivered: false,
        contextTokens: 0,
        maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
        teamName: p.teamName,
        agentName: p.agentName,
        isTeamLead: p.isTeamLead,
        leadAgentId: p.leadAgentId,
        teamUsesTmux: p.teamUsesTmux,
        palette: p.palette,
        hueShift: p.hueShift,
      };

      assignPaletteIfNeeded(agent, this.store);
      this.store.set(p.id, agent);
      this.knownJsonlFiles.add(p.jsonlFile);

      try {
        const stat = fs.statSync(p.jsonlFile);
        agent.fileOffset = stat.size;
        startFileWatching(
          p.id,
          p.jsonlFile,
          this.store,
          this.fileWatchers,
          this.pollingTimers,
          this.waitingTimers,
          this.permissionTimers,
        );
      } catch {
        /* ignore stat errors on restore */
      }

      this.registerAgent(agent.sessionId, agent.id);

      if (p.id > maxId) maxId = p.id;
      console.log(
        `[Pixel Agents] Restored external agent ${p.id} -> ${path.basename(p.jsonlFile)}`,
      );
    }

    if (maxId >= this.store.nextAgentId.current) {
      this.store.nextAgentId.current = maxId + 1;
    }

    this.store.persist();
  }

  // ── Cleanup ──

  /** Clean up all scanners, timers, and agents. Called on shutdown. */
  dispose(): void {
    this.disposed = true;
    this.presence.dispose();
    this.pendingTreeScans.clear();
    this.store.off('broadcast', this.onStoreBroadcast);
    this.store.off('agentRemoved', this.onStoreAgentRemoved);
    this.workflowChildren.clear();
    this.hookEventHandler.dispose();

    if (this.projectScanTimer.current) {
      clearInterval(this.projectScanTimer.current);
      this.projectScanTimer.current = null;
    }
    if (this.externalScanTimer) {
      clearInterval(this.externalScanTimer);
      this.externalScanTimer = null;
    }
    if (this.staleCheckTimer) {
      clearInterval(this.staleCheckTimer);
      this.staleCheckTimer = null;
    }

    for (const id of [...this.store.keys()]) {
      this.removeAgent(id);
    }
  }
}
