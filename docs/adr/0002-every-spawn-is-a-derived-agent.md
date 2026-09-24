# Every spawn is a derived agent, and the office follows the spawn tree

A session that orchestrates other agents builds a tree: the session spawns agents,
those spawn their own, and so on (a real `/equipo` run goes lead → phase leader →
developer → QA/pentester, depth 3). The office used to show only the first level, and
showed it wrongly. This records the decision to model the whole tree, and what it
costs.

## What the CLI actually gives us

Claude Code writes every agent spawned inside a session — nested or not — flat under
`<projectDir>/<sessionId>/subagents/agent-<key>.jsonl`, each with an
`agent-<key>.meta.json` sidecar carrying `agentType`, `description`, `toolUseId`,
`spawnDepth`, and, from depth 2 on, `parentAgentId` (the parent's `<key>`). Named
spawns add `name`. Hook events fired inside a spawned agent carry the root session's
`session_id` plus `agent_id` (= `<key>`) and `agent_type`; there is no parent id in
the hook payload — the sidecar is where the tree lives.

## What was wrong

- **Activity of a child animated its parent.** The hook handler resolved events by
  `session_id` alone, and every spawned agent shares the root's session, so a
  sub-agent's `PreToolUse` drove the lead's character.
- **Depth ≥ 2 was invisible.** Sidecars were accepted only when their `toolUseId` was a
  live spawn of the _lead_; a grandchild is spawned by a child, so it never matched.
- **A sub-agent could not have children.** It was a transient "Subtask" sprite with
  negative id and a shadow store feeding it translated `subagentTool*` messages — no
  identity the next level could hang from.

## Decision

Every sidecar-backed spawn becomes a **derived Agent**: a real entry in the
`AgentStateStore` with `parentAgentId`, `spawnAgentKey`, `role` (`agentType`), `label`
(`description`) and `depth`. It is materialized when its sidecar appears and its
`toolUseId` is a live spawn of _its own parent_ (the anti-spurious gate, applied
recursively), watched through the ordinary transcript pipeline, and removed when its
spawn closes, its completion `queue-operation` lands, or its parent goes — the whole
subtree, leaves first. Hook events carrying `agent_id` route to it by
`(session_id, agent_id)`; a keyed event that does not resolve is buffered and never
falls through to the root.

Derived agents are **never persisted and never registered as sessions**. After a
reload the scan re-materializes them from the spawns still live.

The name still distinguishes a Sub-agent (unnamed) from a Teammate (named), per
`CONTEXT.md`, but it no longer selects a representation: both are derived agents that
sit in their spawner's **scope office** (the spawner plus its direct children).

## Alternatives rejected

- **A separate tree entity with its own messages.** Keeps `Agent` untouched, but
  duplicates tool tracking, permission bubbles, waiting state and the context gauge for
  a second kind of character — two models to keep in sync forever.
- **Inferring nesting in the UI.** The `subagent*` messages are keyed by
  `(leadId, parentToolId)`; they cannot express depth 2, so the UI would be inventing
  data.

## Consequences

- The shadow store (`subagentWatch.ts`) and its `subagentTool*` translation retire for
  sidecar-backed spawns. Transcripts without sidecars (Task-era `agent_progress`) keep
  the Subtask path as a fallback; a spawn that materializes clears its Subtask with the
  existing `subagentClear`.
- Every derived agent gets permission bubbles, waiting state and a context gauge from
  the shared pipeline, at the cost of one transcript watcher per live node.
- The sidecar format is Claude Code internals and may change; parsing it stays inside
  the Claude provider (`TeamProvider.discoverTeammates` exposes `agentKey`,
  `parentAgentKey`, `depth`, `agentType`).
