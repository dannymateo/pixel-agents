const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  MAX_DERIVED_AGENTS_PER_TREE,
  TEXT_IDLE_DELAY_MS,
  TOOL_DONE_DELAY_MS,
} from './constants.js';
import { updateContextUsage } from './contextUsage.js';
import { hasHookAmbiguousTeammates, hasPromotedBackgroundAgent } from './teamUtils.js';
import {
  cancelPermissionTimer,
  cancelWaitingTimer,
  clearAgentActivity,
  startPermissionTimer,
  startWaitingTimer,
} from './timerManager.js';
import type { AgentState } from './types.js';

/** Empty set used as safe fallback when no HookProvider is registered. */
const EMPTY_EXEMPT_TOOLS: ReadonlySet<string> = new Set();

/** Hook provider: supplies formatToolStatus + team.extractTeamMetadataFromRecord.
 *  Registered once at startup via setHookProvider(). Functions below assume it's set. */
let hookProvider: HookProvider | null = null;

/** Permission-exempt tools come from the active provider. Fail-open if unset. */
function exemptTools(): ReadonlySet<string> {
  return hookProvider?.permissionExemptTools ?? EMPTY_EXEMPT_TOOLS;
}

/** Whether the given tool name spawns a sub-agent according to the active provider. */
function isSubagentTool(toolName: string | null | undefined): boolean {
  if (!toolName || !hookProvider) return false;
  return hookProvider.subagentToolNames.has(toolName);
}

/** Register the HookProvider that owns CLI-specific formatting and team metadata extraction. */
export function setHookProvider(provider: HookProvider): void {
  hookProvider = provider;
}

/** The registered provider, for modules that need it outside line parsing
 *  (fileWatcher seeds context gauges before any line has been read). */
export function getHookProvider(): HookProvider | null {
  return hookProvider;
}

/** Called when any agent (session root or derived) opens a spawn tool, and
 *  again when a spawn's tool_result reports an async launch. The host reacts by
 *  scanning the agent's spawn tree for sidecars to materialize as derived
 *  agents (fileWatcher.scanSpawnTree, docs/adr/0002). */
let backgroundAgentDetectedCallback: ((agentId: number) => void) | null = null;

export function setBackgroundAgentDetectedCallback(cb: (agentId: number) => void): void {
  backgroundAgentDetectedCallback = cb;
}

/** Called when a queue-operation record marks a background spawn finished, or
 *  a foreground spawn is dropped at turn end without a tool_result. The host
 *  removes the spawn's derived agent and its subtree. */
let backgroundAgentCompletedCallback: ((agentId: number, toolUseId: string) => void) | null = null;

export function setBackgroundAgentCompletedCallback(
  cb: (agentId: number, toolUseId: string) => void,
): void {
  backgroundAgentCompletedCallback = cb;
}

/** Notify the host that a spawn tool finished, so it can remove the spawn's
 *  derived agent (and subtree). Exported for hookEventHandler, which clears
 *  foreground tools on the Stop hook. Safe to fire for spawns that never
 *  materialized — the host's lookup simply misses. */
export function notifyBackgroundAgentCompleted(agentId: number, toolUseId: string): void {
  backgroundAgentCompletedCallback?.(agentId, toolUseId);
}

/** Called when the tool_result of a FOREGROUND spawn tool arrives (the tool is
 *  not a live background spawn): the spawned agent is done, so the host removes
 *  its derived agent and subtree. */
let spawnToolClosedCallback: ((agentId: number, toolUseId: string) => void) | null = null;

export function setSpawnToolClosedCallback(
  cb: ((agentId: number, toolUseId: string) => void) | null,
): void {
  spawnToolClosedCallback = cb;
}

/** Called when a tool_result reports a scripted multi-agent run launch (Claude:
 *  `Workflow`). The launch tool id is already a live background spawn of the
 *  agent when this fires; the host creates the workflow node and returns true,
 *  or refuses the launch (e.g. a run directory of another session) and returns
 *  false, after which the id is dropped again. */
let workflowLaunchedCallback:
  | ((agentId: number, toolUseId: string, launch: { runDir: string; name?: string }) => boolean)
  | null = null;

export function setWorkflowLaunchedCallback(cb: typeof workflowLaunchedCallback): void {
  workflowLaunchedCallback = cb;
}

/** Name + input of an agent's open tool calls, kept only while the provider
 *  can recognize workflow launches: the launch is only visible in the
 *  tool_result, but its display name lives in the tool_use input. The name is
 *  kept too because a Stop hook or a new prompt may clear the tool from
 *  activeToolNames before the polled tool_result is parsed. Spawn tools are
 *  never kept (they can stay open for a whole background run, prompt and all);
 *  the rest is pruned to the agent's open tools on every tool_use record. */
const openToolInputs = new WeakMap<
  AgentState,
  Map<string, { name: string; input: Record<string, unknown> }>
>();

/** An agent of a workflow run: derived, keyed, but started by no spawn tool
 *  call of its parent. Its transcript never carries a turn_duration record and
 *  its SubagentStop hook goes to the session root, so neither turn-end signal
 *  ever reaches it. */
function isWorkflowRunAgent(agent: AgentState): boolean {
  return (
    agent.parentAgentId !== undefined &&
    agent.spawnAgentKey !== undefined &&
    agent.spawnToolUseId === undefined
  );
}

/** Called when a lead's spawn result names a DIFFERENT team than the one it is
 *  latched to. Every CLI run of a session mints a fresh implicit team, so a
 *  resumed lead that spawns again belongs to the new team; the host removes
 *  the defunct team's teammate characters. */
let teamSwitchCallback: ((leadAgentId: number, previousTeamName: string) => void) | null = null;

export function setTeamSwitchCallback(
  cb: (leadAgentId: number, previousTeamName: string) => void,
): void {
  teamSwitchCallback = cb;
}

/** Format a tool status line. Delegates to the active HookProvider's formatToolStatus.
 *  Invariant: a provider is registered before any transcript lines are parsed. */
export function formatToolStatus(toolName: string, input: Record<string, unknown>): string {
  return hookProvider?.formatToolStatus(toolName, input) ?? `Using ${toolName}`;
}

export function processTranscriptLine(
  agentId: number,
  line: string,
  agents: AgentStateStore,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  agent.lastDataAt = Date.now();
  agent.linesProcessed++;
  try {
    const record = JSON.parse(line);

    // -- Agent Teams: extract team metadata via the active provider --
    // The provider reads its CLI's own field names (Claude: record.teamName + record.agentName).
    // Other CLIs would implement this differently or not at all.
    const teamMeta = hookProvider?.team?.extractTeamMetadataFromRecord(record);
    if (teamMeta?.teamName && teamMeta.teamName !== agent.teamName) {
      agent.teamName = teamMeta.teamName;
      agent.teamNameFromTags = true;
      agent.agentName = teamMeta.agentName;
      agent.isTeamLead = undefined;
      agent.leadAgentId = undefined;
      if (debug) {
        console.log(
          `[Pixel Agents] Agent ${agentId} team metadata: team=${agent.teamName}, role=${agent.agentName ?? 'lead'}`,
        );
      }
      // Link teammates to leads within the same team
      linkTeammates(agentId, agent, agents);

      agents.broadcast({
        type: 'agentTeamInfo',
        id: agentId,
        teamName: agent.teamName,
        agentName: agent.agentName,
        isTeamLead: agent.isTeamLead,
        leadAgentId: agent.leadAgentId,
      });
    }

    // -- Context window usage (drives every agent's context gauge) --
    updateContextUsage(agentId, agent, agents, record, hookProvider);

    // Resilient content extraction: support both record.message.content and record.content
    // Claude Code may change the JSONL structure across versions
    const assistantContent = record.message?.content ?? record.content;

    if (record.type === 'assistant' && Array.isArray(assistantContent)) {
      const blocks = assistantContent as Array<{
        type: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      const hasToolUse = blocks.some((b) => b.type === 'tool_use');

      if (hasToolUse) {
        cancelWaitingTimer(agentId, waitingTimers);
        agent.isWaiting = false;
        agent.hadToolsInTurn = true;
        agents.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
        let hasNonExemptTool = false;
        let openedSpawn = false;
        let inputs: Map<string, { name: string; input: Record<string, unknown> }> | undefined;
        if (hookProvider?.team?.extractWorkflowLaunch) {
          inputs = openToolInputs.get(agent);
          if (inputs) {
            for (const id of inputs.keys()) if (!agent.activeToolIds.has(id)) inputs.delete(id);
          } else {
            inputs = new Map();
            openToolInputs.set(agent, inputs);
          }
        }
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id) {
            const toolName = block.name || '';
            const status = formatToolStatus(toolName, block.input || {});
            if (
              inputs &&
              block.input &&
              typeof block.input === 'object' &&
              !isSubagentTool(toolName)
            ) {
              inputs.set(block.id, { name: toolName, input: block.input });
            }
            console.log(
              `[Pixel Agents] JSONL: Agent ${agentId} - tool start: ${block.id} ${status}`,
            );
            agent.activeToolIds.add(block.id);
            agent.activeToolStatuses.set(block.id, status);
            agent.activeToolNames.set(block.id, toolName);
            if (!exemptTools().has(toolName)) {
              hasNonExemptTool = true;
            }
            // Detect tmux vs inline team mode from the team provider's spawn predicate.
            if (
              agent.teamName &&
              hookProvider?.team?.isTeammateSpawnCall(toolName, block.input ?? {}) &&
              !agent.teamUsesTmux
            ) {
              agent.teamUsesTmux = true;
              agents.broadcast({
                type: 'agentTeamInfo',
                id: agentId,
                teamName: agent.teamName,
                agentName: agent.agentName,
                isTeamLead: agent.isTeamLead,
                leadAgentId: agent.leadAgentId,
                teamUsesTmux: true,
              });
              for (const [id, teammate] of agents) {
                if (id === agentId || teammate.leadAgentId !== agentId) continue;
                teammate.teamUsesTmux = true;
                agents.broadcast({
                  type: 'agentTeamInfo',
                  id,
                  teamName: teammate.teamName,
                  agentName: teammate.agentName,
                  isTeamLead: teammate.isTeamLead,
                  leadAgentId: teammate.leadAgentId,
                  teamUsesTmux: true,
                });
              }
            }
            // Skip webview message when hooks handle tool visuals (PreToolUse sent it instantly).
            // EXCEPTION: subagent-spawn tools (Task/Agent) ALWAYS use JSONL so the sub-agent
            // character is created with the REAL tool id. SubagentStop and subagentClear use
            // the real id -- a synthetic-id sub-agent from PreToolUse could never be matched.
            // EXCEPTION: inline teammates need JSONL tool events even in hooks mode so their
            // tool activity is displayed correctly.
            const isSubagentSpawn = isSubagentTool(toolName);
            if (isSubagentSpawn) openedSpawn = true;
            // A spawn call carrying a `name` is a Teammate-to-be: flag it so
            // the webview never creates a Subtask ghost that the teammate
            // character replaces seconds later.
            const isTeammateSpawn =
              isSubagentSpawn &&
              typeof block.input?.name === 'string' &&
              block.input.name.length > 0;
            if (isTeammateSpawn) {
              (agent.teammateSpawnToolIds ??= new Set()).add(block.id);
            }
            const useJsonlToolEvents =
              agent.hookDelivered && hasHookAmbiguousTeammates(agentId, agents);
            if (!agent.hookDelivered || useJsonlToolEvents || isSubagentSpawn) {
              const runInBackground = isSubagentSpawn && block.input?.run_in_background === true;
              agents.broadcast({
                type: 'agentToolStart',
                id: agentId,
                toolId: block.id,
                status,
                toolName,
                permissionActive: agent.permissionSent,
                runInBackground,
                isTeammateSpawn: isTeammateSpawn || undefined,
              });
            }
          }
        }
        // Skip heuristic timer when hooks are active OR for teammates.
        // Teammate tools (WebFetch, WebSearch) are naturally slow; the heuristic
        // produces false positives. Permission on teammates comes from the lead's
        // routed Notification(permission_prompt) hook — slower but accurate.
        if (hasNonExemptTool && !agent.hookDelivered && !agent.leadAgentId) {
          startPermissionTimer(agentId, agents, permissionTimers, exemptTools());
        }
        // Any node of a spawn tree (root or derived, foreground or not) opening
        // a spawn: scan now rather than wait for the periodic tick. The
        // agentToolStart above went out first, so the Subtask sprite it creates
        // is the one the materialized agent's subagentClear supersedes.
        if (openedSpawn) {
          backgroundAgentDetectedCallback?.(agentId);
        }
      } else if (blocks.some((b) => b.type === 'text') && !agent.hadToolsInTurn) {
        // Text-only response in a turn that hasn't used any tools.
        // turn_duration handles tool-using turns reliably but is never
        // emitted for text-only turns, so we use a silence-based timer:
        // if no new JSONL data arrives within TEXT_IDLE_DELAY_MS, mark as waiting.
        // Skip when hooks are active — Stop hook handles this exactly.
        if (!agent.hookDelivered) {
          startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers);
        }
      }
    } else if (record.type === 'assistant' && typeof assistantContent === 'string') {
      // Text-only assistant response (content is a string, not an array)
      if (!agent.hadToolsInTurn && !agent.hookDelivered) {
        startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers);
      }
    } else if (record.type === 'assistant' && assistantContent === undefined) {
      // Assistant record with no recognizable content structure
      console.warn(
        `[Pixel Agents] Agent ${agentId}: assistant record has no content. Keys: ${Object.keys(record).join(', ')}`,
      );
    } else if (record.type === 'progress') {
      processProgressRecord(agentId, record, agents, waitingTimers, permissionTimers);
    } else if (record.type === 'user') {
      const content = record.message?.content ?? record.content;
      if (Array.isArray(content)) {
        const blocks = content as Array<{ type: string; tool_use_id?: string; content?: unknown }>;
        const hasToolResult = blocks.some((b) => b.type === 'tool_result');
        if (hasToolResult) {
          for (const block of blocks) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const completedToolId = block.tool_use_id;
              const completedToolName = agent.activeToolNames.get(completedToolId);
              const openTool = openToolInputs.get(agent)?.get(completedToolId);
              openToolInputs.get(agent)?.delete(completedToolId);

              // Scripted multi-agent run (spec §2.1b): the launch becomes a
              // workflow node, alive as a background spawn of this agent until
              // its completion queue-operation. The tool itself is done: it
              // falls through to normal tool-done handling, so it never lingers
              // as an open non-exempt tool that arms the permission timer.
              const launchToolName = completedToolName ?? openTool?.name;
              const workflowLaunch =
                launchToolName && !isSubagentTool(launchToolName)
                  ? hookProvider?.team?.extractWorkflowLaunch?.(
                      launchToolName,
                      openTool?.input ?? {},
                      block.content,
                    )
                  : null;
              if (workflowLaunch && !agent.backgroundAgentToolIds.has(completedToolId)) {
                agent.backgroundAgentToolIds.add(completedToolId);
                if (!workflowLaunchedCallback?.(agentId, completedToolId, workflowLaunch)) {
                  agent.backgroundAgentToolIds.delete(completedToolId);
                }
              }
              // Remember the task id the launch result names, so a completion
              // notice that carries only <task-id> still finds this spawn.
              if (workflowLaunch || (launchToolName && isSubagentTool(launchToolName))) {
                noteSpawnTaskId(agent, completedToolId, block.content);
              }

              // Teammate spawn result (newer harnesses: every Agent spawn is a
              // background teammate of an implicit team; the lead's own records
              // carry no team tags, so this result line is the only lead-side
              // signal). Marks the agent as lead so teammate discovery engages,
              // then falls through to normal tool-done handling -- the teammate
              // character replaces the transient Subtask one.
              const teammateSpawn = completedToolName
                ? hookProvider?.team?.extractTeammateSpawnFromToolResult?.(
                    completedToolName,
                    block.content,
                  )
                : null;
              if (
                teammateSpawn &&
                !agent.teamNameFromTags &&
                !agent.leadAgentId &&
                agent.teamName !== teammateSpawn.teamName
              ) {
                // Last-wins for tag-less LEADS: a resumed session's transcript
                // carries spawn results from several team generations (each CLI
                // run mints a fresh session-<8hex> team). Re-latch to the
                // newest team and drop the defunct team's teammates. Tag-
                // derived identity (tmux/inline, teammate sessions) stays.
                //
                // `!agent.leadAgentId` keeps a TEAMMATE that spawns its own
                // named Agent from re-latching itself out of its team: it would
                // flip to the nested team, set isTeamLead, and linkTeammates
                // would then detach it from its real lead (phantom LEAD, broken
                // click-to-focus). An agent that already has a lead is never a
                // re-latch candidate, whatever its teamNameFromTags says.
                if (agent.teamName) {
                  teamSwitchCallback?.(agentId, agent.teamName);
                }
                agent.teamName = teammateSpawn.teamName;
                agent.isTeamLead = true;
                if (debug) {
                  console.log(
                    `[Pixel Agents] Agent ${agentId} spawned teammate "${teammateSpawn.teammateName}" -> lead of team ${teammateSpawn.teamName}`,
                  );
                }
                linkTeammates(agentId, agent, agents);
                agents.broadcast({
                  type: 'agentTeamInfo',
                  id: agentId,
                  teamName: agent.teamName,
                  agentName: agent.agentName,
                  isTeamLead: agent.isTeamLead,
                  leadAgentId: agent.leadAgentId,
                });
              }

              // Detect background agent launches — keep the tool alive until queue-operation
              if (
                !teammateSpawn &&
                isSubagentTool(completedToolName) &&
                isAsyncAgentResult(block)
              ) {
                console.log(
                  `[Pixel Agents] Agent ${agentId} background agent launched: ${completedToolId}`,
                );
                agent.backgroundAgentToolIds.add(completedToolId);
                // Current harnesses OMIT run_in_background from the tool_use
                // input, so the spawn's original agentToolStart went out
                // unflagged. Re-broadcast it flagged now that the result
                // proves it's background: the webview marks the Subtask as
                // background-parented BEFORE the first turn-end clear, or the
                // sub-character gets removed and recreated at a new tile.
                // Skipped once the spawn is its own derived character: the
                // flagged start would recreate a Subtask ghost beside it.
                const spawnStatus = agent.activeToolStatuses.get(completedToolId);
                if (spawnStatus && !hasPromotedBackgroundAgent(agentId, completedToolId, agents)) {
                  agents.broadcast({
                    type: 'agentToolStart',
                    id: agentId,
                    toolId: completedToolId,
                    status: spawnStatus,
                    toolName: completedToolName,
                    runInBackground: true,
                    isTeammateSpawn: agent.teammateSpawnToolIds?.has(completedToolId) || undefined,
                  });
                }
                // Scan the tree right away (sidecar may lag; the periodic
                // scan retries until it lands).
                backgroundAgentDetectedCallback?.(agentId);
                continue; // don't mark as done yet
              }

              console.log(
                `[Pixel Agents] JSONL: Agent ${agentId} - tool done: ${block.tool_use_id}`,
              );
              // If the completed tool spawned a subagent, clear its subagent tools
              if (isSubagentTool(completedToolName)) {
                agent.activeSubagentToolIds.delete(completedToolId);
                agent.activeSubagentToolNames.delete(completedToolId);
                agents.broadcast({
                  type: 'subagentClear',
                  id: agentId,
                  parentToolId: completedToolId,
                });
                // A foreground spawn is done: its derived agent (and subtree) goes.
                if (!agent.backgroundAgentToolIds.has(completedToolId)) {
                  spawnToolClosedCallback?.(agentId, completedToolId);
                }
              } else if (
                completedToolName === undefined &&
                !agent.backgroundAgentToolIds.has(completedToolId)
              ) {
                // The tool was already forgotten (a user prompt mid-spawn
                // cleared foreground activity) but its result still closes the
                // spawn: a derived agent for it must not outlive it. The host's
                // lookup misses for anything that never was a spawn.
                spawnToolClosedCallback?.(agentId, completedToolId);
              }
              agent.activeToolIds.delete(completedToolId);
              agent.activeToolStatuses.delete(completedToolId);
              agent.activeToolNames.delete(completedToolId);
              // Send agentToolDone when hooks are off, or for Task/Agent tools
              // (which always use JSONL path for consistent sub-agent lifecycle).
              const isCompletedAgentTool =
                completedToolName === 'Task' || completedToolName === 'Agent';
              const useJsonlToolEvents =
                agent.hookDelivered && hasHookAmbiguousTeammates(agentId, agents);
              if (!agent.hookDelivered || useJsonlToolEvents || isCompletedAgentTool) {
                const toolId = completedToolId;
                setTimeout(() => {
                  agents.broadcast({
                    type: 'agentToolDone',
                    id: agentId,
                    toolId,
                  });
                }, TOOL_DONE_DELAY_MS);
              }
            }
          }
          // All tools completed — allow text-idle timer as fallback
          // for turn-end detection when turn_duration is not emitted
          if (agent.activeToolIds.size === 0) {
            agent.hadToolsInTurn = false;
            // A workflow run agent gets no turn-end signal at all (see
            // isWorkflowRunAgent): idle once nothing new arrives for a while
            // after its last tool finished. Any tool_use cancels it.
            if (isWorkflowRunAgent(agent)) {
              startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agents, waitingTimers);
            }
          }
        } else {
          // New user text prompt — new turn starting
          cancelWaitingTimer(agentId, waitingTimers);
          clearAgentActivity(agent, agentId, agents, permissionTimers);
          agent.hadToolsInTurn = false;
        }
      } else if (typeof content === 'string' && content.trim()) {
        // New user text prompt — new turn starting
        cancelWaitingTimer(agentId, waitingTimers);
        clearAgentActivity(agent, agentId, agents, permissionTimers);
        agent.hadToolsInTurn = false;
      }
    } else if (record.type === 'queue-operation' && record.operation === 'enqueue') {
      // Background agent completed — parse tool-use-id from XML content
      const content = record.content as string | undefined;
      if (content) {
        // Only a CLI task notification completes a spawn: a queued user prompt
        // is written as the same record and merely quoting the tag must not
        // end a live background agent or workflow.
        const completedToolId =
          typeof content === 'string' && content.startsWith('<task-notification>')
            ? completedSpawnToolId(agent, agentId, content, agents)
            : undefined;
        if (completedToolId !== undefined) {
          if (agent.backgroundAgentToolIds.has(completedToolId)) {
            console.log(
              `[Pixel Agents] Agent ${agentId} background agent done: ${completedToolId}`,
            );
            agent.backgroundAgentToolIds.delete(completedToolId);
            agent.activeSubagentToolIds.delete(completedToolId);
            agent.activeSubagentToolNames.delete(completedToolId);
            agents.broadcast({
              type: 'subagentClear',
              id: agentId,
              parentToolId: completedToolId,
            });
            agent.activeToolIds.delete(completedToolId);
            agent.activeToolStatuses.delete(completedToolId);
            agent.activeToolNames.delete(completedToolId);
            // Remove the spawn's derived agent and its subtree.
            backgroundAgentCompletedCallback?.(agentId, completedToolId);
            if (!agent.hookDelivered) {
              const toolId = completedToolId;
              setTimeout(() => {
                agents.broadcast({
                  type: 'agentToolDone',
                  id: agentId,
                  toolId,
                });
              }, TOOL_DONE_DELAY_MS);
            }
          }
        }
      }
    } else if (record.type === 'system' && record.subtype === 'turn_duration') {
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);

      // Definitive turn-end: clean up any stale tool state, but preserve background agents.
      // When hooks are active, the Stop hook already handled the status change,
      // but we still perform state cleanup here as a safety net.
      // Counted per id, not by comparing sizes: a background spawn is not
      // always an open tool (a workflow launch's tool is done at launch; a
      // restored agent's live spawns were never opened in this process).
      let hasForegroundTools = false;
      for (const toolId of agent.activeToolIds) {
        if (!agent.backgroundAgentToolIds.has(toolId)) {
          hasForegroundTools = true;
          break;
        }
      }
      if (hasForegroundTools) {
        // Remove only non-background tool state
        for (const toolId of agent.activeToolIds) {
          if (agent.backgroundAgentToolIds.has(toolId)) continue;
          agent.activeToolIds.delete(toolId);
          agent.activeToolStatuses.delete(toolId);
          const toolName = agent.activeToolNames.get(toolId);
          agent.activeToolNames.delete(toolId);
          if (isSubagentTool(toolName)) {
            agent.activeSubagentToolIds.delete(toolId);
            agent.activeSubagentToolNames.delete(toolId);
            // A foreground spawn dropped at turn end without a tool_result:
            // remove its derived agent too, or it lingers until sessionEnd.
            backgroundAgentCompletedCallback?.(agentId, toolId);
          }
        }
        if (!agent.hookDelivered) {
          agents.broadcast({ type: 'agentToolsClear', id: agentId });
        }
        // Re-send background agent tools so webview keeps their sub-agents alive.
        // toolName + runInBackground are REQUIRED: without them the webview can't
        // recognize the re-sent tool as a subagent spawn and never recreates the
        // Subtask sub-character. Skip tools whose agent was promoted to its own
        // character -- re-sending would spawn a ghost Subtask alongside it.
        for (const toolId of agent.backgroundAgentToolIds) {
          if (hasPromotedBackgroundAgent(agentId, toolId, agents)) continue;
          const status = agent.activeToolStatuses.get(toolId);
          if (status) {
            agents.broadcast({
              type: 'agentToolStart',
              id: agentId,
              toolId,
              status,
              toolName: agent.activeToolNames.get(toolId),
              runInBackground: true,
              isTeammateSpawn: agent.teammateSpawnToolIds?.has(toolId) || undefined,
            });
          }
        }
      }

      agent.isWaiting = true;
      agent.permissionSent = false;
      agent.hadToolsInTurn = false;
      // Skip status post when hooks already handled it
      if (!agent.hookDelivered) {
        agents.broadcast({
          type: 'agentStatus',
          id: agentId,
          status: 'waiting',
          // turn_duration = the turn completed, so this is "Done".
          awaitingInput: false,
        });
      }
    } else if (record.type && !agent.seenUnknownRecordTypes.has(record.type)) {
      // Log first occurrence of unrecognized record types to help diagnose issues
      // where Claude Code changes JSONL format. Known types we intentionally skip:
      // file-history-snapshot, queue-operation (non-enqueue), etc.
      const knownSkippableTypes = new Set(['file-history-snapshot', 'system', 'queue-operation']);
      if (!knownSkippableTypes.has(record.type)) {
        agent.seenUnknownRecordTypes.add(record.type);
        if (debug) {
          console.log(
            `[Pixel Agents] JSONL: Agent ${agentId} - unrecognized record type '${record.type}'. ` +
              `Keys: ${Object.keys(record).join(', ')}`,
          );
        }
      }
    }
  } catch {
    // Ignore malformed lines
  }
}

function processProgressRecord(
  agentId: number,
  record: Record<string, unknown>,
  agents: AgentStateStore,
  _waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  const parentToolId = record.parentToolUseID as string | undefined;
  if (!parentToolId) return;

  const data = record.data as Record<string, unknown> | undefined;
  if (!data) return;

  // bash_progress / mcp_progress: tool is actively executing, not stuck on permission.
  // Restart the permission timer to give the running tool another window.
  // Skip when hooks are active — Notification hook handles permission detection exactly.
  const dataType = data.type as string | undefined;
  if (dataType === 'bash_progress' || dataType === 'mcp_progress') {
    if (agent.activeToolIds.has(parentToolId) && !agent.hookDelivered && !agent.leadAgentId) {
      startPermissionTimer(agentId, agents, permissionTimers, exemptTools());
    }
    return;
  }

  // Verify parent is an active subagent-spawning tool (agent_progress handling)
  const parentToolName = agent.activeToolNames.get(parentToolId);
  if (!isSubagentTool(parentToolName)) return;

  const msg = data.message as Record<string, unknown> | undefined;
  if (!msg) return;

  const msgType = msg.type as string;
  const innerMsg = msg.message as Record<string, unknown> | undefined;
  const content = innerMsg?.content;
  if (!Array.isArray(content)) return;

  if (msgType === 'assistant') {
    let hasNonExemptSubTool = false;
    for (const block of content) {
      if (block.type === 'tool_use' && block.id) {
        const toolName = block.name || '';
        const status = formatToolStatus(toolName, block.input || {});
        console.log(
          `[Pixel Agents] Agent ${agentId} subagent tool start: ${block.id} ${status} (parent: ${parentToolId})`,
        );

        // Track sub-tool IDs
        let subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (!subTools) {
          subTools = new Set();
          agent.activeSubagentToolIds.set(parentToolId, subTools);
        }
        subTools.add(block.id);

        // Track sub-tool names (for permission checking)
        let subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (!subNames) {
          subNames = new Map();
          agent.activeSubagentToolNames.set(parentToolId, subNames);
        }
        subNames.set(block.id, toolName);

        if (!exemptTools().has(toolName)) {
          hasNonExemptSubTool = true;
        }

        agents.broadcast({
          type: 'subagentToolStart',
          id: agentId,
          parentToolId,
          toolId: block.id,
          status,
        });
      }
    }
    if (hasNonExemptSubTool && !agent.hookDelivered) {
      startPermissionTimer(agentId, agents, permissionTimers, exemptTools());
    }
  } else if (msgType === 'user') {
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        console.log(
          `[Pixel Agents] Agent ${agentId} subagent tool done: ${block.tool_use_id} (parent: ${parentToolId})`,
        );

        // Remove from tracking
        const subTools = agent.activeSubagentToolIds.get(parentToolId);
        if (subTools) {
          subTools.delete(block.tool_use_id);
        }
        const subNames = agent.activeSubagentToolNames.get(parentToolId);
        if (subNames) {
          subNames.delete(block.tool_use_id);
        }

        const toolId = block.tool_use_id;
        setTimeout(() => {
          agents.broadcast({
            type: 'subagentToolDone',
            id: agentId,
            parentToolId,
            toolId,
          });
        }, 300);
      }
    }
    // If there are still active non-exempt sub-agent tools, restart the permission timer
    // (handles the case where one sub-agent completes but another is still stuck)
    let stillHasNonExempt = false;
    for (const [, subNames] of agent.activeSubagentToolNames) {
      for (const [, toolName] of subNames) {
        if (!exemptTools().has(toolName)) {
          stillHasNonExempt = true;
          break;
        }
      }
      if (stillHasNonExempt) break;
    }
    if (stillHasNonExempt && !agent.hookDelivered) {
      startPermissionTimer(agentId, agents, permissionTimers, exemptTools());
    }
  }
}

/**
 * Link teammates within the same team.
 * The lead is the agent with no agentName (or one already marked isTeamLead).
 * Teammates get leadAgentId pointing to the lead. If only named teammates are
 * tracked, linking waits until the lead is detected.
 */
function linkTeammates(_agentId: number, agent: AgentState, agents: AgentStateStore): void {
  const teamName = agent.teamName;
  if (!teamName) return;

  // Find all agents in this team
  const teamAgents: AgentState[] = [];
  for (const a of agents.values()) {
    if (a.teamName === teamName) {
      teamAgents.push(a);
    }
  }

  // Determine lead: always prefer the agent WITHOUT agentName (the real lead has agentName=null).
  // This handles the case where a teammate is detected first and temporarily marked as lead,
  // then the real lead joins later.
  let lead: AgentState | undefined;
  for (const a of teamAgents) {
    if (!a.agentName) {
      lead = a;
      break;
    }
  }
  if (!lead) {
    // No agent without agentName -- an already-marked lead may carry one
    for (const a of teamAgents) {
      if (a.isTeamLead) {
        lead = a;
        break;
      }
    }
  }
  if (!lead) {
    // Every tracked member carries an agentName: they are all teammates and
    // the real lead's session isn't tracked (yet). Don't badge a teammate as
    // LEAD -- this re-runs and links properly once the lead is detected.
    return;
  }

  // Update all team members: mark lead, clear stale lead flags, link teammates
  for (const a of teamAgents) {
    if (a.id === lead.id) {
      a.isTeamLead = true;
      a.leadAgentId = undefined;
    } else {
      a.isTeamLead = false;
      a.leadAgentId = lead.id;
    }
  }
}

// ── Spawn completion notices ─────────────────────────────────
//
// A background spawn ends with a `<task-notification>` queue-operation. Older
// CLIs name the spawn call (`<tool-use-id>`); current ones only name the task
// (`<task-id>`): the spawned agent's key for an Agent spawn, or the run's task
// id for a Workflow. The launch result names that task id too ("agentId: <key>"
// / "Task ID: <id>"), so it is recorded per agent when the result is parsed.

const TASK_ID_RESULT_PATTERN = /(?:agentId|Task ID):\s*([A-Za-z0-9_-]{1,128})/;
const TASK_ID_NOTICE_PATTERN = /<task-id>([A-Za-z0-9_-]{1,128})<\/task-id>/;
const TOOL_USE_ID_NOTICE_PATTERN = /<tool-use-id>(.*?)<\/tool-use-id>/;
/** Launch results scanned for the task id are short; never scan a huge one. */
const TASK_ID_SCAN_CHARS = 4096;
/** Task ids remembered per agent (oldest dropped): only live spawns matter. */
const TASK_IDS_PER_AGENT_MAX = 256;

/** Per agent: task id named by a spawn's launch result → the spawn's tool_use id. */
const spawnTaskIds = new WeakMap<AgentState, Map<string, string>>();

function toolResultHead(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, TASK_ID_SCAN_CHARS);
  if (!Array.isArray(content)) return '';
  let text = '';
  for (const item of content) {
    if (typeof item === 'object' && item !== null) {
      const t = (item as Record<string, unknown>).text;
      if (typeof t === 'string') text += `${t}\n`;
    }
    if (text.length >= TASK_ID_SCAN_CHARS) break;
  }
  return text.slice(0, TASK_ID_SCAN_CHARS);
}

function noteSpawnTaskId(agent: AgentState, toolUseId: string, content: unknown): void {
  const match = TASK_ID_RESULT_PATTERN.exec(toolResultHead(content));
  if (!match) return;
  let ids = spawnTaskIds.get(agent);
  if (!ids) {
    ids = new Map();
    spawnTaskIds.set(agent, ids);
  }
  ids.set(match[1], toolUseId);
  if (ids.size > TASK_IDS_PER_AGENT_MAX) {
    const oldest = ids.keys().next().value;
    if (oldest !== undefined) ids.delete(oldest);
  }
}

/** The live background spawn of `agent` a completion notice refers to, or
 *  undefined. Only this agent's own spawns can match: a notice naming another
 *  agent's child (or a forged id) is inert.
 *
 *  `<tool-use-id>` wins only when it names one of the agent's live spawns
 *  (`isLive`): an agent continued with SendMessage completes with the
 *  SendMessage call's id there, and only `<task-id>` still names the spawn. */
function completedSpawnToolId(
  agent: AgentState,
  agentId: number,
  notice: string,
  agents: AgentStateStore,
  isLive: (toolUseId: string) => boolean = (id) => agent.backgroundAgentToolIds.has(id),
): string | undefined {
  const byToolUseId = TOOL_USE_ID_NOTICE_PATTERN.exec(notice)?.[1];
  if (byToolUseId !== undefined && isLive(byToolUseId)) return byToolUseId;
  const byTaskId = completedSpawnByTaskId(agent, agentId, notice, agents);
  return byTaskId ?? byToolUseId;
}

function completedSpawnByTaskId(
  agent: AgentState,
  agentId: number,
  notice: string,
  agents: AgentStateStore,
): string | undefined {
  const taskId = TASK_ID_NOTICE_PATTERN.exec(notice)?.[1];
  if (taskId === undefined) return undefined;
  const recorded = spawnTaskIds.get(agent)?.get(taskId);
  if (recorded !== undefined) {
    spawnTaskIds.get(agent)?.delete(taskId);
    return recorded;
  }
  for (const child of agents.values()) {
    if (child.parentAgentId === agentId && child.spawnAgentKey === taskId) {
      return child.spawnToolUseId;
    }
  }
  return undefined;
}

// ── Seeding live spawns from history (plan T18) ──────────────
//
// An agent adopted or restored mid-session is watched from the END of its
// transcript, so the spawns it opened before then were never seen live and
// its spawn tree could not grow. When watching starts, its history is read
// once — lightly, not replayed — for the spawns still live at that point, and
// the agent is left as if it had read them live: open foreground spawns in
// its active tools, background launches in backgroundAgentToolIds, workflow
// launches registered as nodes. Nothing is broadcast and no timer is armed
// for the past; the ordinary scan then materializes the tree.

/** A spawn the history leaves live, offered to the host's freshness check. */
export interface SeededSpawnCandidate {
  toolUseId: string;
  /** Set for a scripted-run launch: its freshness is judged by the run. */
  workflowRunDir?: string;
  /** A background launch: kept only on evidence of its own. */
  background?: boolean;
}

type HistorySpawn =
  | { kind: 'foreground' | 'background'; name: string; status: string; named: boolean }
  | { kind: 'workflow'; launch: { runDir: string; name?: string } };

/** A line holding none of these cannot change which spawns are live, so it is
 *  never parsed (assistant text, progress, snapshots…). */
const SEED_LINE_MARKERS = [
  '"tool_use"',
  '"tool_result"',
  '"user"',
  'turn_duration',
  'task-notification',
];
/** Non-spawn tool inputs kept while their result is pending (workflow launch
 *  names live in the tool_use input); oldest dropped past this. */
const SEED_OPEN_INPUTS_MAX = 256;
/** Pending non-spawn inputs handed to the live parser, so a Workflow launch
 *  whose result lands right after adoption is still recognized. */
const SEED_HANDOFF_INPUTS_MAX = 16;
/** Tool ids as the API writes them; anything else is never seeded or logged. */
const SEED_TOOL_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isTaskNotice(record: Record<string, unknown>): string | undefined {
  if (record.type !== 'queue-operation' || record.operation !== 'enqueue') return undefined;
  const content = record.content;
  return typeof content === 'string' && content.startsWith('<task-notification>')
    ? content
    : undefined;
}

/**
 * Seed `agentId`'s live spawns from `lines` (its history, oldest first, up to
 * where live reading starts). Liveness follows the live parser exactly: a
 * spawn tool_use without its tool_result is live until the turn ends or a new
 * prompt starts; an async launch result or a workflow launch keeps it live
 * until its completion notice (`<tool-use-id>` or `<task-id>`). The survivors
 * pass through `keep` (the host's freshness rule: history alone must not
 * resurrect a dead session's tree), newest `MAX_DERIVED_AGENTS_PER_TREE`
 * only. A persisted live spawn the history shows finished is forgotten.
 * Returns the number of spawns seeded.
 */
export function seedSpawnsFromHistory(
  agentId: number,
  lines: Iterable<string>,
  agents: AgentStateStore,
  keep: (candidates: readonly SeededSpawnCandidate[]) => ReadonlySet<string>,
): number {
  const agent = agents.get(agentId);
  if (!agent || !hookProvider) return 0;
  const team = hookProvider.team;
  const live = new Map<string, HistorySpawn>();
  const inputs = team?.extractWorkflowLaunch
    ? new Map<string, { name: string; input: Record<string, unknown> }>()
    : undefined;
  const persisted = agent.backgroundAgentToolIds;
  const endedPersisted = new Set<string>();
  const ended = (id: string): void => {
    live.delete(id);
    if (persisted.has(id)) endedPersisted.add(id);
  };
  const dropForeground = (): void => {
    for (const [id, s] of live) if (s.kind === 'foreground') live.delete(id);
  };
  /** Bounded while reading: only the newest spawns can ever be seeded. */
  const addLive = (id: string, spawn: HistorySpawn): void => {
    live.set(id, spawn);
    if (live.size > MAX_DERIVED_AGENTS_PER_TREE) {
      const oldest = live.keys().next().value;
      if (oldest !== undefined) live.delete(oldest);
    }
  };

  for (const line of lines) {
    if (!SEED_LINE_MARKERS.some((m) => line.includes(m))) continue;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      record = parsed as Record<string, unknown>;
    } catch {
      continue; // malformed line
    }
    const message = record.message as { content?: unknown } | undefined;
    const content =
      typeof message === 'object' && message !== null && message.content !== undefined
        ? message.content
        : record.content;

    if (record.type === 'assistant' && Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown> | null>) {
        if (!block || block.type !== 'tool_use') continue;
        const id = block.id;
        if (typeof id !== 'string' || !SEED_TOOL_ID_PATTERN.test(id)) continue;
        const name = typeof block.name === 'string' ? block.name : '';
        const input =
          typeof block.input === 'object' && block.input !== null && !Array.isArray(block.input)
            ? (block.input as Record<string, unknown>)
            : {};
        if (isSubagentTool(name)) {
          live.delete(id);
          addLive(id, {
            kind: 'foreground',
            name,
            status: formatToolStatus(name, input),
            named: typeof input.name === 'string' && input.name.length > 0,
          });
        } else if (inputs) {
          inputs.delete(id);
          inputs.set(id, { name, input });
          if (inputs.size > SEED_OPEN_INPUTS_MAX) {
            const oldest = inputs.keys().next().value;
            if (oldest !== undefined) inputs.delete(oldest);
          }
        }
      }
    } else if (record.type === 'user') {
      if (Array.isArray(content)) {
        const blocks = content as Array<Record<string, unknown> | null>;
        if (!blocks.some((b) => b?.type === 'tool_result')) {
          dropForeground(); // a new prompt: foreground activity is over
          continue;
        }
        for (const block of blocks) {
          if (!block || block.type !== 'tool_result') continue;
          const id = block.tool_use_id;
          if (typeof id !== 'string' || !id) continue;
          const spawn = live.get(id);
          const open = inputs?.get(id);
          inputs?.delete(id);
          if (spawn?.kind === 'foreground') {
            noteSpawnTaskId(agent, id, block.content);
            const teammateSpawn = team?.extractTeammateSpawnFromToolResult?.(
              spawn.name,
              block.content,
            );
            if (!teammateSpawn && isAsyncAgentResult(block)) {
              live.set(id, { ...spawn, kind: 'background' });
            } else {
              ended(id);
            }
          } else if (open && !spawn) {
            const launch = team?.extractWorkflowLaunch?.(open.name, open.input, block.content);
            if (launch) {
              addLive(id, {
                kind: 'workflow',
                launch: { runDir: launch.runDir, name: launch.name },
              });
              noteSpawnTaskId(agent, id, block.content);
            }
          } else if (!spawn && persisted.has(id)) {
            // Its tool_use is before the window: remember the task id its
            // launch result names, so a completion notice still finds it.
            noteSpawnTaskId(agent, id, block.content);
          }
        }
      } else if (typeof content === 'string' && content.trim()) {
        dropForeground();
      }
    } else if (record.type === 'system' && record.subtype === 'turn_duration') {
      dropForeground();
    } else {
      const notice = isTaskNotice(record);
      if (notice === undefined) continue;
      const id = completedSpawnToolId(agent, agentId, notice, agents, (t) => {
        const s = live.get(t);
        return s ? s.kind !== 'foreground' : persisted.has(t);
      });
      if (id !== undefined && live.get(id)?.kind !== 'foreground') ended(id);
    }
  }

  for (const id of endedPersisted) agent.backgroundAgentToolIds.delete(id);

  const candidates: SeededSpawnCandidate[] = [];
  for (const [toolUseId, s] of live) {
    candidates.push(
      s.kind === 'workflow'
        ? { toolUseId, workflowRunDir: s.launch.runDir }
        : { toolUseId, background: s.kind === 'background' || undefined },
    );
  }
  const kept = candidates.length > 0 ? keep(candidates) : new Set<string>();

  let seeded = 0;
  let seededAgentSpawn = false;
  const workflowLaunches: Array<{
    toolUseId: string;
    launch: { runDir: string; name?: string };
    had: boolean;
  }> = [];
  for (const { toolUseId } of candidates) {
    const s = live.get(toolUseId);
    if (!s || !kept.has(toolUseId)) continue;
    if (s.kind === 'workflow') {
      // Live from now on (a completion notice read next finds it); its node
      // is registered below, like a launch read live.
      workflowLaunches.push({
        toolUseId,
        launch: s.launch,
        had: agent.backgroundAgentToolIds.has(toolUseId),
      });
      agent.backgroundAgentToolIds.add(toolUseId);
    } else {
      agent.activeToolIds.add(toolUseId);
      agent.activeToolStatuses.set(toolUseId, s.status);
      agent.activeToolNames.set(toolUseId, s.name);
      if (s.named) (agent.teammateSpawnToolIds ??= new Set()).add(toolUseId);
      if (s.kind === 'background') agent.backgroundAgentToolIds.add(toolUseId);
      // As the live parser leaves it: a tool is open in this turn.
      if (s.kind === 'foreground') agent.hadToolsInTurn = true;
      seededAgentSpawn = true;
    }
    seeded++;
  }

  // Hand the still-pending inputs to the live parser (newest few).
  if (inputs && inputs.size > 0) {
    let handoff = openToolInputs.get(agent);
    if (!handoff) {
      handoff = new Map();
      openToolInputs.set(agent, handoff);
    }
    for (const [id, open] of [...inputs].slice(-SEED_HANDOFF_INPUTS_MAX)) handoff.set(id, open);
  }

  if (seeded > 0) {
    console.log(
      `[Pixel Agents] Agent ${agentId}: ${seeded} live spawn(s) seeded from transcript history`,
    );
  }
  // Materialize what the history left running — on the next microtask, not
  // now: creating nodes takes agent ids, and a restore loop that is watching
  // its agents one by one only raises the id counter past the persisted ids
  // once it is done. The microtask still runs before any I/O callback, so no
  // live transcript line can slip in between.
  if (seededAgentSpawn || workflowLaunches.length > 0) {
    queueMicrotask(() => {
      if (agents.get(agentId) !== agent) return;
      for (const { toolUseId, launch, had } of workflowLaunches) {
        if (!agent.backgroundAgentToolIds.has(toolUseId)) continue;
        if (!workflowLaunchedCallback?.(agentId, toolUseId, launch) && !had) {
          agent.backgroundAgentToolIds.delete(toolUseId);
        }
      }
      if (seededAgentSpawn) backgroundAgentDetectedCallback?.(agentId);
    });
  }
  return seeded;
}

/** Check if a tool_result block indicates an async/background agent launch */
function isAsyncAgentResult(block: Record<string, unknown>): boolean {
  const content = block.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).text === 'string' &&
        ((item as Record<string, unknown>).text as string).startsWith(
          'Async agent launched successfully.',
        )
      ) {
        return true;
      }
    }
  } else if (typeof content === 'string') {
    return content.startsWith('Async agent launched successfully.');
  }
  return false;
}
