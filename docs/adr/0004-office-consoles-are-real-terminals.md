# Office consoles are real terminals

The office only watched. To work a session without leaving it, it needs a way
back into Claude Code. Three were weighed:

- **A chat over the Claude Agent SDK** (`canUseTool` for permissions and
  AskUserQuestion). Structured, office-native buttons — but it reimplements the
  CLI's interface and loses its `/commands`.
- **`claude -p --input-format stream-json`**. Rejected: the input protocol is
  undocumented.
- **A real pseudo-terminal the server owns** (`node-pty`) shown with xterm.js.
  Chosen: full parity with the console for free.

## Decision

Standalone only. `+ Agent` launches `claude --session-id <uuid>` in a pty owned by
the server; the browser attaches to it. Its transcript and hooks feed the office
like any session. Consoles are privileged (token), point-to-point (never
broadcast), and only exist on a loopback bind — on a network bind a console is a
remote shell for whoever holds the token. `node-pty` is optional at runtime: a
host without its prebuilt binary gets the office without consoles.

## Consequences

Questions and permissions of office sessions are answered in their console, not
as office buttons. Sessions opened in other terminals stay observe-only here;
answering their permissions from the office is the permission bridge (next
phase). Stopping the server kills its consoles; the work survives in the
transcript.

`node-pty` ships as an `optionalDependency` of the npm package, not a hard one: a
platform with no prebuilt binary and no build toolchain would otherwise fail the
whole `npx pixel-agents` install over a feature it can still run without.
`server/src/terminals/loadNodePty.ts` already degrades at runtime (`require` in a
try/catch) — the dependency type just lets npm itself degrade the same way.
