# The living office: finishing is not leaving

Once every spawn became a derived agent (docs/adr/0002), the office could show a
whole team — but it treated "the task finished" as "the agent is gone", and it
planned to show deep teams by drilling into separate scope offices. Both read
wrong against how people actually run teams of agents. This records the
replacement: one living office where agents enter, work, rest, and leave on real
signals.

## What the CLI actually tells us

A background spawn ends with a `<task-notification>` carrying a `<status>`. In the
user's transcripts: `completed` (2604), `failed` (212), `killed` (251), `stopped`
(4). A completed agent is **not** dead: Claude Code lets its parent write to it
again (`SendMessage`), and the same task id notifies again when it stops. A parent
ends a spawn for good with `TaskStop` (`input.task_id`). A foreground spawn ends
with its `tool_result` and cannot be resumed.

## Decision

- **Finishing ≠ leaving.** `completed`/`failed` make the agent **available**: it
  stays at its desk. After `IDLE_TO_LOUNGE_MS` (30 min by default, a user setting)
  without activity it walks to the **lounge**; any new activity walks it back.
- **Unused rest ends too.** An agent that rests in the lounge for
  `LOUNGE_TO_LEAVE_MS` (60 min by default, a user setting) without being resumed
  says goodbye and leaves: leads rarely `TaskStop` a finished agent, and without
  this a long session's office grows forever. On adoption only agents finished
  within both windows come back, placed where their real finish time puts them.
- **Leaving needs a real signal**: `killed`/`stopped`, a parent's `TaskStop` for
  its task id, the user closing it, its foreground spawn's result, or its root
  session ending (the subtree leaves leaves-first, staggered). A leaving agent
  walks to the **entrance**, says goodbye, and goes; the server removes it after
  `LEAVE_ANIMATION_MAX_MS` whether or not a client animated it.
- **The server owns presence** (`working | available | lounge | leaving`,
  broadcast as `agentPresence`); clients only animate it, so every open view
  agrees.
- **One office.** Each team (a root's direct child that has children, or a
  workflow node) gets a generated **team module** beside the user's own layout,
  named with an Area label. The user's layout stays theirs and editable; modules,
  a default entrance and a default lounge are composed in memory and never saved.

## Alternatives rejected

- **Navigable scope offices** (double-click into a team's own room, breadcrumbs
  back). Hides the whole picture behind navigation and makes cross-team walking —
  the point of agents talking to each other — impossible.
- **Removing agents on completion.** Contradicts the CLI: completed agents are
  resumable, and the office would show a team emptying out while its lead is still
  directing it.
- **Client-side idle timers.** Two views of one office would disagree about who
  is resting.

## Consequences

- Delivery 1's rule "a background spawn dies on its completion notice" is replaced
  by the status-aware rule above.
- New furniture assets (door, arcade, console, beanbag); beanbags and sofas are
  rest seats, never desks.
- The editor edits only the user's part of the composed office.
