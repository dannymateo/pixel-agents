# Bringing a session to the office

The office could launch its own consoles (docs/adr/0004) and read anyone else's
session, but never write into one it didn't start. People run Claude Code in
terminals all over the machine; asking them to leave a session and relaunch it
loses the character, the seat, and the conversation the office already knows
about it. The office needed a way to keep working with an agent that is already
running, without fighting its original process for the session.

Two processes cannot hold the same session: both would append to the same
transcript, and Claude Code itself assumes one writer. So "bringing a session
in" can never mean the office reaching into a foreign process's terminal, or
killing that process to free the session up — either corrupts the transcript or
destroys work the office does not own.

## Decision

- **Bring to the office** marks the agent pending, in memory only (lost on a
  restart; the agent stays external), and waits for that session's own
  `SessionEnd` — the operator types `/exit` in its own terminal. The office
  never kills a process it does not own.
- On that `SessionEnd` (for any reason other than `clear`/`resume`, which mean
  the session keeps going somewhere else), the server resumes the **same**
  agent — same id, character, seat — with `claude --resume <sessionId>` in a
  fresh office console, in the `cwd` read from the session's own transcript,
  never from the client. `--resume` continues that exact session id; only
  `--fork-session` would mint a new one (verified against CLI 2.1.284).
- **Confirmation stands in for the signal** when there is none: a session
  without hooks installed never sends `SessionEnd`, and an operator who has
  already closed a hooked session shouldn't have to wait for one anyway.
  Either way, an explicit "I already closed it" resumes at once — the UI warns
  first that a session still open elsewhere will fight the new console for the
  same transcript.
- Cancelling just drops the pending mark; the agent stays exactly as external
  as before.
- A failed resume (claude doesn't start, the folder is gone) reports back and
  the agent leaves the way any other `SessionEnd` would have taken it.

## Consequences

- A brought-in agent's sub-agents still have no session or console of their
  own (docs/adr/0002); they are addressed through their root's console exactly
  as before the takeover.
- Because the id, character, and seat never change, a resumed agent survives a
  server restart the same way an office-launched one does — the console just
  reconnects to the same persisted agent.
- The office still cannot write into a session left running somewhere else
  without moving it here first. Answering its permissions in place, without a
  takeover, is the permission bridge — still the next phase.
