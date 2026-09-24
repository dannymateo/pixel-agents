import type { Frame, Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

import type { ClaudeMockScenarioBuilder } from './mock-claude';
import { buildAssistantToolUseRecord, buildUserToolResultRecord } from './team';

/**
 * Spawn-tree helpers (docs/adr/0002): every sidecar-backed spawn — nested or
 * not — is a derived Agent with its own character. On disk the CLI writes them
 * FLAT under `<projectDir>/<sessionId>/subagents/agent-<key>.jsonl` plus an
 * `agent-<key>.meta.json` sidecar; the tree lives only in the sidecar
 * (`spawnDepth`, and `parentAgentId` from depth 2 on).
 */

type OverlaySurface = Frame | Page;

const SPAWN_TREE_TIMEOUT_MS = 20_000;

// ── Scenario builders (mock side) ────────────────────────────────────────────

/** Session alias under which a sub-agent's transcript is appended. */
export function subagentAlias(agentKey: string): string {
  return `subagent-${agentKey}`;
}

function subagentRelPath(agentKey: string, ext: '.jsonl' | '.meta.json'): string {
  return `{{sessionId}}/subagents/agent-${agentKey}${ext}`;
}

/**
 * Declare the transcript of a sub-agent so `.appendJsonl(record, { session:
 * subagentAlias(key) })` grows it append-only. Nothing is written until the
 * first append — the file appears when the scenario says so.
 */
export function withSubagentTranscript(
  builder: ClaudeMockScenarioBuilder,
  agentKey: string,
): ClaudeMockScenarioBuilder {
  return builder.defineSession(subagentAlias(agentKey), '{{sessionId}}', {
    transcriptPathTemplate: `{{projectDir}}/${subagentRelPath(agentKey, '.jsonl')}`,
  });
}

export interface SpawnSidecar {
  agentKey: string;
  agentType: string;
  description: string;
  toolUseId: string;
  spawnDepth: number;
  /** `<key>` of the spawning sub-agent; absent at depth 1 (spawned by the root). */
  parentAgentId?: string;
}

function sidecarJson(spawn: SpawnSidecar): Record<string, unknown> {
  const json: Record<string, unknown> = {
    agentType: spawn.agentType,
    description: spawn.description,
    toolUseId: spawn.toolUseId,
    spawnDepth: spawn.spawnDepth,
  };
  if (spawn.parentAgentId !== undefined) json['parentAgentId'] = spawn.parentAgentId;
  return json;
}

/** The first record of every real sub-agent transcript: the spawn prompt. */
function subagentPromptRecord(agentKey: string, prompt: string): Record<string, unknown> {
  return {
    type: 'user',
    isSidechain: true,
    agentId: agentKey,
    sessionId: '{{sessionId}}',
    message: { role: 'user', content: prompt },
  };
}

/** Tag a record as written inside sub-agent `agentKey` (real transcripts do). */
export function inSubagent(
  agentKey: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  return { ...record, isSidechain: true, agentId: agentKey, sessionId: '{{sessionId}}' };
}

/**
 * At `atMs`, the CLI materializes a spawn the way Claude Code does: the
 * sidecar first, then the transcript opening with the spawn prompt.
 */
export function writeSpawnFiles(
  builder: ClaudeMockScenarioBuilder,
  atMs: number,
  spawn: SpawnSidecar,
): ClaudeMockScenarioBuilder {
  return builder
    .at(atMs)
    .writeFile(subagentRelPath(spawn.agentKey, '.meta.json'), sidecarJson(spawn))
    .at(atMs)
    .appendJsonl(subagentPromptRecord(spawn.agentKey, spawn.description), {
      session: subagentAlias(spawn.agentKey),
    });
}

/** Foreground spawn tool call: an `Agent` tool_use that stays open until its result. */
export function buildAgentSpawnRecord(
  toolUseId: string,
  description: string,
  subagentType: string,
  extraInput: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildAssistantToolUseRecord(toolUseId, 'Agent', {
    description,
    subagent_type: subagentType,
    prompt: `${description}: do the work`,
    ...extraInput,
  });
}

/** The spawn's tool_result: closes a foreground spawn (and with it the subtree). */
export function buildAgentSpawnResultRecord(toolUseId: string): Record<string, unknown> {
  return buildUserToolResultRecord(toolUseId, [{ type: 'text', text: 'Done.' }]);
}

/** Async spawn result as the CLI writes it for a background `Agent` call. */
export function buildAsyncSpawnResultRecord(
  toolUseId: string,
  agentKey: string,
): Record<string, unknown> {
  return buildUserToolResultRecord(toolUseId, [
    { type: 'text', text: `Async agent launched successfully.\nagentId: ${agentKey}` },
  ]);
}

// ── Assertions (Playwright side) ─────────────────────────────────────────────

/**
 * Overlays of real agents only. Sub-agent "Subtask" sprites carry negative
 * ids; derived agents are real store agents with positive ids, so excluding
 * the negative ones is what separates "the spawn became a derived agent" from
 * "the parent's spawn tool drew a transient Subtask".
 */
export function getAgentCharacterOverlays(frame: OverlaySurface): Locator {
  return frame.locator('[data-testid="agent-overlay"]:not([data-agent-id^="-"])');
}

/**
 * The derived agent's overlay, found by its visible name — the sidecar
 * `description`, rendered as its own line. Exact text, so a parent whose
 * status reads "Subtask: <description>" never matches.
 */
export function getDerivedAgentOverlay(frame: OverlaySurface, label: string): Locator {
  return getAgentCharacterOverlays(frame).filter({
    has: frame.getByText(label, { exact: true }),
  });
}

export async function expectDerivedAgentVisible(
  frame: OverlaySurface,
  label: string,
  timeout = SPAWN_TREE_TIMEOUT_MS,
): Promise<void> {
  await expect(getDerivedAgentOverlay(frame, label)).toHaveCount(1, { timeout });
}

export async function expectDerivedAgentActivity(
  frame: OverlaySurface,
  label: string,
  activity: string,
  timeout = SPAWN_TREE_TIMEOUT_MS,
): Promise<void> {
  await expect(getDerivedAgentOverlay(frame, label)).toContainText(activity, { timeout });
}

export async function expectDerivedAgentGone(
  frame: OverlaySurface,
  label: string,
  timeout = SPAWN_TREE_TIMEOUT_MS,
): Promise<void> {
  await expect(getDerivedAgentOverlay(frame, label)).toHaveCount(0, { timeout });
}

export async function expectAgentCharacterCount(
  frame: OverlaySurface,
  count: number,
  timeout = SPAWN_TREE_TIMEOUT_MS,
): Promise<void> {
  await expect(getAgentCharacterOverlays(frame)).toHaveCount(count, { timeout });
}

/**
 * Id of the one real agent that is none of the given derived agents — the
 * root session's character. Call once every derived agent is visible.
 */
export async function readRootAgentId(
  frame: OverlaySurface,
  derivedLabels: string[],
): Promise<number> {
  const derivedIds = new Set<string>();
  for (const label of derivedLabels) {
    const id = await getDerivedAgentOverlay(frame, label).getAttribute('data-agent-id');
    if (id !== null) derivedIds.add(id);
  }
  const allIds = await getAgentCharacterOverlays(frame).evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-agent-id')),
  );
  const rootIds = allIds.filter((id): id is string => id !== null && !derivedIds.has(id));
  if (rootIds.length !== 1) {
    throw new Error(
      `Expected exactly one root agent besides ${JSON.stringify(derivedLabels)}, got ids ${JSON.stringify(allIds)}`,
    );
  }
  return Number(rootIds[0]);
}

const NEVER_SAMPLE_MS = 200;

/**
 * Continuous negative: sample `locator` every 200 ms while `during` runs (plus
 * `settleMs` after it) and fail if ANY sample contains `text`. A one-shot
 * snapshot can miss a transient mis-animation, and a retrying matcher waits it
 * out; sampling across the whole window catches both.
 */
export async function expectTextNeverAppears(
  locator: Locator,
  text: string,
  during: () => Promise<void>,
  settleMs = 2_000,
): Promise<void> {
  let done = false;
  let seen: string[] | null = null;
  // Samples that actually found an element: a locator that matches nothing
  // (wrong id, detached frame) would otherwise pass without checking anything.
  let effectiveSamples = 0;
  const sampler = (async () => {
    while (!done) {
      const texts = await locator.allTextContents().catch(() => [] as string[]);
      if (texts.length > 0) effectiveSamples += 1;
      if (texts.some((t) => t.includes(text))) {
        seen = texts;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, NEVER_SAMPLE_MS));
    }
  })();
  try {
    await during();
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  } finally {
    done = true;
    await sampler;
  }
  expect(seen, `"${text}" must never appear here`).toBeNull();
  expect(effectiveSamples, 'the sampled locator never matched an element').toBeGreaterThan(0);
}

/** Hook payload for a tool event fired INSIDE a spawned agent: the root's
 *  session_id plus the spawn's `agent_id` (= its `<key>`) and `agent_type`. */
export function subagentToolHook(
  event: 'PreToolUse' | 'PostToolUse',
  agent: { key: string; type: string },
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    session_id: '{{sessionId}}',
    hook_event_name: event,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
    agent_id: agent.key,
    agent_type: agent.type,
  };
  if (event === 'PostToolUse') payload['tool_response'] = { success: true };
  return payload;
}
