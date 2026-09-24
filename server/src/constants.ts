// ── JSONL File Watching ─────────────────────────────────────
export const JSONL_POLL_INTERVAL_MS = 1000;
export const FILE_WATCHER_POLL_INTERVAL_MS = 500;
export const PROJECT_SCAN_INTERVAL_MS = 1000;

// ── Heuristic Agent Status Detection ────────────────────────
// These timers are the fallback when CLI hooks are not active
// (hookDelivered = false). When hooks are working, these are
// suppressed and the server receives instant events instead.
/** Delay before sending agentToolDone (prevents UI flicker on rapid tool transitions) */
export const TOOL_DONE_DELAY_MS = 300;
/** Heuristic: time after a non-exempt tool starts before showing permission bubble.
 *  Not used for teammates -- false positives on slow tools (WebFetch/WebSearch).
 *  Teammates rely on the lead's routed Notification(permission_prompt) hook. */
export const PERMISSION_TIMER_DELAY_MS = 7000;
/** Heuristic: silence duration before marking a text-only turn as complete */
export const TEXT_IDLE_DELAY_MS = 5000;
/** Heuristic: idle threshold for per-agent /clear detection (content check prevents stealing) */
export const CLEAR_IDLE_THRESHOLD_MS = 2000;

// ── External Session Detection ──────────────────────────────
export const EXTERNAL_SCAN_INTERVAL_MS = 3000;
/** Only adopt JSONL files modified within this window */
export const EXTERNAL_ACTIVE_THRESHOLD_MS = 120_000; // 2 minutes
/** Remove external agents after this much inactivity */
// export const EXTERNAL_STALE_TIMEOUT_MS = 300_000; // 5 minutes - deprecated
export const EXTERNAL_STALE_CHECK_INTERVAL_MS = 30_000;
/** Cooldown after user closes an agent via X. Must be > EXTERNAL_ACTIVE_THRESHOLD_MS
 *  so the file's mtime becomes stale before the dismissal expires. */
export const DISMISSED_COOLDOWN_MS = 180_000; // 3 minutes

// ── Context Window Usage ────────────────────────────────────
/** Window size assumed until a transcript proves otherwise. Transcripts never
 *  state the model's context limit, so this is the floor, not the truth. */
export const DEFAULT_MAX_CONTEXT_TOKENS = 200_000;
/** Known window sizes, ascending. The smallest tier that fits the largest
 *  context observed so far wins; beyond the last tier we round up to a whole
 *  multiple of it, so an unknown future window still reads under 100%. */
export const CONTEXT_WINDOW_TIERS = [200_000, 1_000_000] as const;
/** How much of a transcript's tail to read when seeding an agent's context on
 *  adoption or restore. Comfortably more than one turn's worth of records. */
export const CONTEXT_SEED_TAIL_BYTES = 256 * 1024;

// ── Global Session Scanning ─────────────────────────────────
/** Only adopt global JSONL files larger than this (filters out empty/init-only sessions) */
export const GLOBAL_SCAN_ACTIVE_MIN_SIZE = 3_072; // 3KB
/** Only adopt global JSONL files modified within this window */
export const GLOBAL_SCAN_ACTIVE_MAX_AGE_MS = 600_000; // 10 minutes

// ── Display Truncation + Pixel Agents Server paths ──────────
// Centralized in core/src/constants.ts; re-exported here for back-compat.
export {
  BASH_COMMAND_DISPLAY_MAX_LENGTH,
  HOOK_API_PREFIX,
  HOOK_SCRIPTS_DIR,
  SERVER_JSON_DIR,
  SERVER_JSON_NAME,
  TASK_DESCRIPTION_DISPLAY_MAX_LENGTH,
} from '../../core/src/constants.js';

// ── Multi-Server Discovery ──────────────────────────────────
/** Subdirectory (under SERVER_JSON_DIR) holding one registry entry per live
 *  server, so a hook event can fan out to every running instance instead of
 *  only the single legacy server.json pointer. See server/src/server.ts. */
export const SERVERS_DIR = 'servers';
/** Valid explicit TCP port range. Port 0 remains an internal-only signal for
 *  OS-assigned ephemeral binding and is never accepted from persisted records
 *  or the CLI's --port option. */
export const MIN_PORT = 1;
export const MAX_PORT = 65_535;
/** Format version stamped on every registry entry (both the per-server records
 *  and the legacy server.json). Bump on breaking field changes; additive
 *  fields (servesSpa, protocol itself) don't require a bump -- readers already
 *  tolerate unknown/missing fields (see ServerConfig.debugLog precedent). */
export const SERVER_REGISTRY_PROTOCOL_VERSION = 1;

// ── WebSocket close codes (application range 4000-4999) ────
/** Embedded mode: Bearer token missing or wrong. */
export const WS_CLOSE_UNAUTHORIZED = 4001;
/** Standalone mode: the handshake's Origin is not this server's own origin.
 *  WebSocket connects bypass CORS, so this is the only thing standing between
 *  a drive-by web page and the privileged client-message channel. */
export const WS_CLOSE_FORBIDDEN_ORIGIN = 4003;

export const HOOK_EVENT_BUFFER_MS = 5_000;
/** Cap on hook events waiting for their agent, across all sessions. The
 *  oldest is dropped past it, so a burst can't grow memory without bound. */
export const MAX_BUFFERED_HOOK_EVENTS = 500;
/** Cap per (session, spawned-agent key) pair, oldest dropped first. */
export const MAX_BUFFERED_HOOK_EVENTS_PER_SPAWN = 50;
/** Grace period after SessionEnd(reason=clear/resume) before triggering onSessionEnd.
 *  /clear and /resume fire SessionEnd then SessionStart within ms. This timeout is a
 *  safety net: if SessionStart never arrives (e.g. the CLI crashes mid-transition),
 *  the agent is cleaned up instead of staying as a zombie with pendingClear forever. */
export const SESSION_END_GRACE_MS = 2000;
export const MAX_HOOK_BODY_SIZE = 65_536; // 64KB

// ── Layout/Config Persistence ──────────────────────────────
export const LAYOUT_FILE_DIR = '.pixel-agents';
export const LAYOUT_FILE_NAME = 'layout.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;
export const LAYOUT_REVISION_KEY = 'layoutRevision';
export const CONFIG_FILE_NAME = 'config.json';

// ── Avatar Customization ────────────────────────────────────
/** Number of pre-colored bundled character palettes (char_0.png–char_5.png).
 *  Mirrors `PALETTE_COUNT` in webview-ui/src/constants.ts; kept separate
 *  because the server has no DOM/sprite access and cannot import the webview
 *  constant. The two values must stay in sync. */
export const PALETTE_COUNT = 6;
/** Inclusive upper bound for a valid agent hue shift, in degrees. Used by
 *  clientMessageHandler to guard saveAgentSeats payloads from a remote or
 *  hand-edited source corrupting the stored values with out-of-range values. */
export const HUE_SHIFT_MAX_DEG = 360;
/** Derived agents inherit their parent's palette; each sibling rotates the
 *  hue by this step so a scope office tells them apart. */
export const SPAWN_SIBLING_HUE_STEP_DEG = 40;

// ── Agent screen feed ───────────────────────────────────────
/** Newest feed entries sent on subscribe (mirrored by FEED_MAX_ENTRIES in
 *  webview-ui/src/constants.ts; the two values must stay in sync). */
export const FEED_SNAPSHOT_MAX_ENTRIES = 200;
/** Per-entry detail cap (diff lines / command output), in bytes. */
export const FEED_ENTRY_DETAIL_MAX_BYTES = 65536;
/** Bytes read from the end of a transcript to build a feed snapshot. */
export const FEED_TAIL_READ_BYTES = 1_048_576;
/** Agents one connection may watch the screen of at once; subscribing past it
 *  drops that connection's oldest subscription (one open screen is the norm). */
export const FEED_MAX_SUBSCRIPTIONS_PER_CONNECTION = 8;
/** Record uuids remembered per watched agent to drop the duplicate records
 *  real transcripts contain (oldest forgotten first). A snapshot spans at most
 *  FEED_SNAPSHOT_MAX_ENTRIES records, so this covers it several times over. */
export const FEED_SEEN_UUIDS_MAX = 2048;
/** A record uuid longer than this is not remembered (no dedup for it). */
export const FEED_UUID_MAX_CHARS = 128;
/** Workflow node labels and workflow-agent task lines are clipped to this. */
export const WORKFLOW_LABEL_MAX_CHARS = 80;
/** Spawn-tree guards against a runaway or hostile transcript: derived agents
 *  past these are deferred (one warning), never materialized. */
export const MAX_DERIVED_AGENTS_PER_TREE = 200;
export const MAX_SPAWN_DEPTH = 16;
/** Workflow launches of one agent allowed to wait for their node while a
 *  tree cap defers them; past this a launch is refused outright. */
export const MAX_PENDING_WORKFLOW_LAUNCHES = 16;
/** On restore, a root whose transcript has not been written for this long is
 *  assumed dead (the CLI died without SessionEnd): its persisted live spawn ids
 *  are dropped so its tree does not come back immortal. */
export const RESTORED_SPAWN_MAX_IDLE_MS = 10 * 60_000;
/** History read, once, when an agent is watched from the END of its transcript
 *  (adopted or restored mid-session), to seed the spawns still live there:
 *  without it a tree already running before adoption never materializes. A
 *  longer transcript is read from its last SPAWN_SEED_MAX_BYTES only (a spawn
 *  opened before that stays unseen, as before seeding). 8 MiB covers a whole
 *  multi-hour orchestrating lead (a real `/equipo` lead measured 6.2 MB) and
 *  costs ~40 ms of synchronous reading once per adoption; a bigger window
 *  would let one pathological transcript stall the event loop longer. */
export const SPAWN_SEED_MAX_BYTES = 8 * 1024 * 1024;
/** Chunk size of that history read (bounds the memory held at once). */
export const SPAWN_SEED_READ_CHUNK_BYTES = 1024 * 1024;

// ── Living office (docs/adr/0003) ───────────────────────────
/** Default minutes an available agent waits at its desk before the lounge. */
export const IDLE_TO_LOUNGE_MS_DEFAULT = 30 * 60_000;
/** Bounds for the user's idle-to-lounge setting, in minutes. */
export const IDLE_TO_LOUNGE_MINUTES_MIN = 1;
export const IDLE_TO_LOUNGE_MINUTES_MAX = 240;
/** A leaving agent is removed after this even if no client animated it. */
export const LEAVE_ANIMATION_MAX_MS = 6000;
/** Gap between consecutive departures when a whole subtree leaves. */
export const LEAVE_STAGGER_MS = 400;
/** Longest a departure waits its turn; a bigger burst leaves together at the end. */
export const LEAVE_QUEUE_MAX_MS = 10 * LEAVE_STAGGER_MS;
/** How often presence timers (available → lounge) are evaluated. */
export const PRESENCE_TICK_MS = 5000;
/** Default minutes an unused agent rests in the lounge before it leaves. */
export const LOUNGE_TO_LEAVE_MS_DEFAULT = 60 * 60_000;
/** Bounds for the user's lounge-to-leave setting, in minutes. */
export const LOUNGE_TO_LEAVE_MINUTES_MIN = 1;
export const LOUNGE_TO_LEAVE_MINUTES_MAX = 480;
