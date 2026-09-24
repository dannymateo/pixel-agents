/**
 * AgentScreenModal — the agent's screen, enlarged: header (role · label ·
 * parent · context % · state) and the live feed (assistant text, tool calls
 * with ⟳/✓/✗, diffs, command output).
 *
 * SECURITY: the feed carries arbitrary code and command output. Every string
 * is rendered as a React text child after `displaySafe` — never as HTML
 * (no dangerouslySetInnerHTML, no syntax highlighting that emits markup, no
 * autolinking). Keep it that way.
 *
 * Copy is in Spanish on purpose: this screen was asked for by, and is read by,
 * a Spanish-speaking user (the rest of the UI is still English).
 */
import type { ReactNode } from 'react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type {
  FeedDetail,
  FeedDiffLine,
  FeedEntry,
  ServerMessage,
} from '../../../core/src/messages.js';
import {
  AGENT_SCREEN_HEADER_REFRESH_MS,
  AGENT_SCREEN_Z_INDEX,
  FEED_COLLAPSED_LINES,
  FEED_COLLAPSED_MAX_CHARS,
  FEED_DIFF_ADD_BG,
  FEED_DIFF_ADD_COLOR,
  FEED_DIFF_REMOVE_BG,
  FEED_DIFF_REMOVE_COLOR,
  FEED_STICKY_BOTTOM_PX,
} from '../constants.js';
import { type AgentFeedState, useAgentFeed } from '../hooks/useAgentFeed.js';
import type { AgentDirectory } from '../office/scope/agentDirectory.js';
import type { MessageTransport } from '../transport/types.js';
import {
  type AgentHeader,
  buildFeedRows,
  clipChars,
  collapseText,
  contextPercent,
  describeAgent,
  diffPrefix,
  displaySafe,
  type FeedRow,
  formatTime,
  statusLabel,
  type ToolRowState,
} from './feedFormat.js';
import { Button } from './ui/Button.js';

const STATE_ICON: Record<ToolRowState, string> = { running: '⟳', done: '✓', error: '✗' };
const STATE_COLOR: Record<ToolRowState, string> = {
  running: 'var(--color-status-active)',
  done: 'var(--color-status-success)',
  error: 'var(--color-status-error)',
};
const STATE_TITLE: Record<ToolRowState, string> = {
  running: 'En curso',
  done: 'Terminada',
  error: 'Terminó con error',
};

const NO_LINES: FeedDiffLine[] = [];

const MONO = 'font-mono text-2xs whitespace-pre-wrap break-all m-0';

// ── Blocks ─────────────────────────────────────────────────────

function ExpandToggle({
  expanded,
  hiddenLines,
  onToggle,
}: {
  expanded: boolean;
  hiddenLines: number;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="mt-2 text-2xs text-accent-bright bg-transparent border-0 p-0 cursor-pointer hover:underline"
    >
      {expanded ? 'ver menos' : hiddenLines > 0 ? `ver más (${hiddenLines} líneas)` : 'ver más'}
    </button>
  );
}

function TruncatedNote() {
  return (
    <div className="text-2xs text-warning mt-2">
      (truncado: el contenido completo es más largo de lo que se envía a la pantalla)
    </div>
  );
}

/** Plain text (assistant text, command output), collapsed to FEED_COLLAPSED_LINES. */
function TextBlock({ text, mono, error }: { text: string; mono: boolean; error?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const safe = useMemo(() => displaySafe(text), [text]);
  const collapsed = useMemo(
    () => collapseText(safe, FEED_COLLAPSED_LINES, FEED_COLLAPSED_MAX_CHARS),
    [safe],
  );
  const shown = expanded || !collapsed.clipped ? safe : collapsed.text;
  const className = mono
    ? `${MONO} bg-bg-dark border-2 border-border p-4 ${error ? 'text-danger' : ''}`
    : 'text-xs whitespace-pre-wrap break-words m-0';
  return (
    <div>
      {mono ? <pre className={className}>{shown}</pre> : <p className={className}>{shown}</p>}
      {collapsed.clipped && (
        <ExpandToggle
          expanded={expanded}
          hiddenLines={collapsed.hiddenLines}
          onToggle={() => setExpanded((v) => !v)}
        />
      )}
    </div>
  );
}

function DiffBlock({ detail }: { detail: FeedDetail }) {
  const [expanded, setExpanded] = useState(false);
  const lines = detail.lines ?? NO_LINES;
  const hiddenLines = Math.max(0, lines.length - FEED_COLLAPSED_LINES);
  // Collapsed also when a single line is longer than a collapsed block shows
  // (a minified file): otherwise its tail would vanish with no "ver más".
  const clipped = hiddenLines > 0 || lines.some((l) => l.text.length > FEED_COLLAPSED_MAX_CHARS);
  // Sanitized once per state: collapsed = the first lines, each clipped BEFORE
  // sanitizing (a huge line costs nothing until expanded); expanded = all of it.
  const visible = useMemo(
    () =>
      (expanded || !clipped ? lines : lines.slice(0, FEED_COLLAPSED_LINES)).map((l) => ({
        op: l.op,
        text: displaySafe(expanded ? l.text : clipChars(l.text, FEED_COLLAPSED_MAX_CHARS)),
      })),
    [lines, expanded, clipped],
  );
  return (
    <div>
      <div className={`${MONO} bg-bg-dark border-2 border-border p-4`}>
        {visible.map((l, i) => {
          const style =
            l.op === 'add'
              ? { color: FEED_DIFF_ADD_COLOR, background: FEED_DIFF_ADD_BG }
              : l.op === 'remove'
                ? { color: FEED_DIFF_REMOVE_COLOR, background: FEED_DIFF_REMOVE_BG }
                : undefined;
          return (
            <div key={i} style={style}>
              {diffPrefix(l.op)}
              {l.text}
            </div>
          );
        })}
      </div>
      {clipped && (
        <ExpandToggle
          expanded={expanded}
          hiddenLines={hiddenLines}
          onToggle={() => setExpanded((v) => !v)}
        />
      )}
      {detail.truncated && <TruncatedNote />}
    </div>
  );
}

function Detail({ detail, error }: { detail: FeedDetail; error?: boolean }) {
  if (detail.type === 'diff') return <DiffBlock detail={detail} />;
  return (
    <div>
      <TextBlock text={detail.text ?? ''} mono error={error} />
      {detail.truncated && <TruncatedNote />}
    </div>
  );
}

// ── Rows ───────────────────────────────────────────────────────

function Time({ entry }: { entry: FeedEntry }) {
  const t = formatTime(entry.ts);
  return t ? <span className="text-2xs text-text-muted shrink-0">{t}</span> : null;
}

function FeedRowViewInner({ row }: { row: FeedRow }) {
  const { entry } = row;
  if (row.kind === 'text') {
    return (
      <div className="py-4 px-8 border-b border-border" data-feed-kind="text">
        <div className="flex gap-8 items-start">
          <div className="flex-1 min-w-0">
            <TextBlock text={entry.summary} mono={false} />
          </div>
          <Time entry={entry} />
        </div>
      </div>
    );
  }
  if (row.kind === 'tool') {
    const { result, state } = row;
    return (
      <div className="py-4 px-8 border-b border-border" data-feed-kind="tool">
        <div className="flex gap-8 items-start">
          <span
            className="shrink-0 text-xs"
            style={{ color: STATE_COLOR[state] }}
            title={STATE_TITLE[state]}
            role="img"
            aria-label={STATE_TITLE[state]}
          >
            {STATE_ICON[state]}
          </span>
          <span className="flex-1 min-w-0 text-xs break-all">
            {clipChars(displaySafe(entry.summary), FEED_COLLAPSED_MAX_CHARS)}
          </span>
          <Time entry={entry} />
        </div>
        {entry.detail && (
          <div className="mt-4 ml-16">
            <Detail detail={entry.detail} />
          </div>
        )}
        {result?.detail && (
          <div className="mt-4 ml-16">
            <Detail detail={result.detail} error={result.isError} />
          </div>
        )}
      </div>
    );
  }
  // Orphan result: its tool fell out of the window.
  const state: ToolRowState = entry.isError ? 'error' : 'done';
  return (
    <div className="py-4 px-8 border-b border-border" data-feed-kind="result">
      <div className="flex gap-8 items-start">
        <span
          className="shrink-0 text-xs"
          style={{ color: STATE_COLOR[state] }}
          title={STATE_TITLE[state]}
          role="img"
          aria-label={STATE_TITLE[state]}
        >
          {STATE_ICON[state]}
        </span>
        <span className="flex-1 min-w-0 text-xs text-text-muted break-all">
          {entry.summary
            ? `Resultado: ${clipChars(displaySafe(entry.summary), FEED_COLLAPSED_MAX_CHARS)}`
            : 'Resultado'}
        </span>
        <Time entry={entry} />
      </div>
      {entry.detail && (
        <div className="mt-4 ml-16">
          <Detail detail={entry.detail} error={entry.isError} />
        </div>
      )}
    </div>
  );
}

/** Rows are rebuilt on every append, but the entries they hold keep their
 *  identity (mergeFeed), so an unchanged row skips rendering. */
const FeedRowView = memo(
  FeedRowViewInner,
  (a, b) =>
    a.row.entry === b.row.entry &&
    (a.row.kind !== 'tool' ||
      (b.row.kind === 'tool' && a.row.result === b.row.result && a.row.state === b.row.state)),
);

// ── View ───────────────────────────────────────────────────────

export interface AgentScreenViewProps {
  header: AgentHeader;
  contextPct: number | null;
  feed: AgentFeedState;
  onClose: () => void;
}

/** Presentational half of the screen (no transport, no directory). */
export function AgentScreenView({ header, contextPct, feed, onClose }: AgentScreenViewProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [following, setFollowing] = useState(true);
  const rows = useMemo(() => buildFeedRows(feed.entries), [feed.entries]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= FEED_STICKY_BOTTOM_PX;
    stickRef.current = atBottom;
    setFollowing(atBottom);
  }, []);

  const scrollToEnd = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickRef.current = true;
    setFollowing(true);
  }, []);

  // Follow the feed unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [rows]);

  // Focus moves into the dialog and returns to whatever opened it.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (listRef.current ?? dialogRef.current)?.focus();
    return () => opener?.focus();
  }, []);

  let body: ReactNode;
  if (feed.denied === 'unprivileged') {
    body = (
      <div className="p-16 text-sm" data-testid="agent-screen-denied">
        <p className="m-0 mb-8">
          Abre la oficina con el enlace con token para ver la pantalla de los agentes.
        </p>
        <p className="m-0 text-xs text-text-muted">
          La pantalla muestra código y salidas de comandos, así que solo se envía a conexiones
          autorizadas: usa la dirección con <span className="font-mono">?token=</span> que imprime
          pixel-agents al arrancar.
        </p>
      </div>
    );
  } else if (!feed.loaded && rows.length === 0) {
    body = <div className="p-16 text-sm text-text-muted">Conectando con la pantalla…</div>;
  } else if (rows.length === 0 && feed.denied === null) {
    body = <div className="p-16 text-sm text-text-muted">Sin actividad todavía.</div>;
  } else {
    body = (
      <>
        {!feed.loaded && (
          <div
            className="px-8 py-4 text-2xs text-warning border-b border-border"
            data-testid="agent-screen-reconnecting"
          >
            Reconectando… lo que ves puede no estar al día.
          </div>
        )}
        {feed.truncated && (
          <div className="px-8 py-4 text-2xs text-text-muted border-b border-border">
            Se muestran solo las actividades más recientes.
          </div>
        )}
        {rows.map((row) => (
          <FeedRowView key={row.key} row={row} />
        ))}
      </>
    );
  }

  // unknownAgent for an agent the office still shows = its transcript is not
  // readable (yet); the hook keeps asking. "Gone" only when it left the office.
  const gone = !header.known;
  const unavailable = header.known && feed.denied === 'unknownAgent';

  return (
    <>
      <div
        className="fixed inset-0 bg-black/50"
        style={{ zIndex: AGENT_SCREEN_Z_INDEX }}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-screen-title"
        tabIndex={-1}
        data-testid="agent-screen"
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-bg border-2 border-border rounded-none shadow-pixel flex flex-col outline-none w-[min(1100px,94vw)] h-[88vh]"
        style={{ zIndex: AGENT_SCREEN_Z_INDEX + 1 }}
      >
        <div className="flex items-start justify-between gap-8 py-4 px-10 border-b-2 border-border">
          <div className="min-w-0">
            <div id="agent-screen-title" className="text-accent-bright text-xl break-all">
              {header.role !== null && (
                <>
                  <span className="text-text-muted">{header.role}</span>
                  <span className="text-text-muted"> · </span>
                </>
              )}
              <span>{header.label}</span>
            </div>
            <div className="text-2xs text-text-muted flex flex-wrap gap-x-12">
              {header.parent !== null && <span>Padre: {header.parent}</span>}
              {contextPct !== null && <span>Contexto: {contextPct}%</span>}
              <span>Estado: {statusLabel(header)}</span>
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Cerrar">
            x
          </Button>
        </div>
        {gone && (
          <div
            className="px-10 py-4 text-xs text-warning border-b border-border"
            data-testid="agent-screen-gone"
          >
            Este agente ya no está.
          </div>
        )}
        {unavailable && (
          <div
            className="px-10 py-4 text-xs text-warning border-b border-border"
            data-testid="agent-screen-unavailable"
          >
            La pantalla de este agente aún no está disponible (todavía no hay registro de su
            actividad). Se reintenta automáticamente.
          </div>
        )}
        <div
          ref={listRef}
          onScroll={onScroll}
          // Focusable so arrows / PageUp / PageDown scroll the feed.
          tabIndex={0}
          aria-label="Actividad del agente"
          className="flex-1 min-h-0 overflow-y-auto"
          data-testid="agent-screen-feed"
        >
          {body}
        </div>
        {!following && feed.denied !== 'unprivileged' && (
          <div className="border-t border-border px-10 py-4 flex justify-end">
            <Button size="sm" onClick={scrollToEnd}>
              Ir al final ↓
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

// ── Container ──────────────────────────────────────────────────

function sameHeader(a: AgentHeader, b: AgentHeader): boolean {
  return (
    a.known === b.known &&
    a.role === b.role &&
    a.label === b.label &&
    a.parent === b.parent &&
    a.presence === b.presence &&
    a.status === b.status &&
    a.permission === b.permission
  );
}

/** The directory is a mutable class, not React state: re-read it on a short interval. */
function useDirectoryHeader(directory: AgentDirectory, agentId: number): AgentHeader {
  // Tagged with its agent: switching agents never shows the previous header.
  const [state, setState] = useState(() => ({
    agentId,
    header: describeAgent(directory, agentId),
  }));
  useEffect(() => {
    const refresh = () =>
      setState((prev) => {
        const next = describeAgent(directory, agentId);
        return prev.agentId === agentId && sameHeader(prev.header, next)
          ? prev
          : { agentId, header: next };
      });
    refresh();
    const timer = setInterval(refresh, AGENT_SCREEN_HEADER_REFRESH_MS);
    return () => clearInterval(timer);
  }, [directory, agentId]);
  return state.agentId === agentId ? state.header : describeAgent(directory, agentId);
}

/** Context gauge: the caller's last known value, then live `agentContextUsage`. */
function useContextPercent(
  transport: MessageTransport,
  agentId: number,
  initial?: { tokens: number; max: number },
): number | null {
  const initialPct = initial ? contextPercent(initial.tokens, initial.max) : null;
  const [live, setLive] = useState<{ agentId: number; pct: number | null } | null>(null);
  useEffect(() => {
    return transport.onMessage((msg: ServerMessage) => {
      if (typeof msg !== 'object' || msg === null) return;
      if (msg.type !== 'agentContextUsage' || msg.id !== agentId) return;
      setLive({ agentId, pct: contextPercent(msg.contextTokens, msg.maxContextTokens) });
    });
  }, [transport, agentId]);
  return live && live.agentId === agentId && live.pct !== null ? live.pct : initialPct;
}

/** Keeps Tab focus cycling inside the open agent screen. */
function trapTab(e: KeyboardEvent): void {
  const dialog = document.querySelector<HTMLElement>('[data-testid="agent-screen"]');
  if (!dialog) return;
  const focusables = [
    ...dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
  if (focusables.length === 0) {
    e.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  if (!dialog.contains(active)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && (active === first || active === dialog)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

export interface AgentScreenModalProps {
  agentId: number;
  directory: AgentDirectory;
  transport: MessageTransport;
  onClose: () => void;
  /** Last known context usage of the agent (the character's contextTokens /
   *  maxContextTokens); live updates arrive over the transport afterwards. */
  context?: { tokens: number; max: number };
}

export function AgentScreenModal({
  agentId,
  directory,
  transport,
  onClose,
  context,
}: AgentScreenModalProps) {
  const feed = useAgentFeed(transport, agentId);
  const header = useDirectoryHeader(directory, agentId);
  const contextPct = useContextPercent(transport, agentId, context);

  // The screen is modal for the keyboard too. Capture phase on window +
  // stopPropagation: no key reaches the office's own handlers behind it
  // (editor Esc/Delete/R/T/undo, intro bubble). Default actions (scrolling,
  // activating the focused button) still happen. Esc closes; Tab stays inside.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Editor/host shortcuts with a modifier (VS Code's Ctrl+P, Ctrl+`, ...)
      // must still reach the host; only the office's own undo/redo is held.
      const mod = e.ctrlKey || e.metaKey || e.altKey;
      const k = e.key.toLowerCase();
      if (mod && k !== 'z' && k !== 'y') return;
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'Tab') {
        trapTab(e);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  return (
    <AgentScreenView
      // A different agent is a different screen: fresh scroll/expand state.
      key={agentId}
      header={header}
      contextPct={contextPct}
      feed={feed}
      onClose={onClose}
    />
  );
}
