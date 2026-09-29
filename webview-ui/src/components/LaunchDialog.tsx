/**
 * LaunchDialog — the standalone browser's "+ Agent": picks a working
 * directory among the machine's known projects (or types one) and an
 * optional bypass-permissions flag, or resumes a recent session, then asks
 * the server to start `claude` in a pseudo-terminal.
 *
 * `launchResult` is NOT listened to here (spec §2): the dialog only sends
 * `launchAgent` and shows the last known error. `App`/`useExtensionMessages`
 * owns the listener so that cancelling this dialog mid-launch doesn't drop a
 * result that arrives afterwards — it still opens the console.
 */
import { useEffect, useState } from 'react';

import type { MachineProject, RecentSession } from '../../../core/src/messages.js';
import { filterProjects, timeAgo } from '../console/launchFilter.js';
import type { MessageTransport } from '../transport/types.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

export interface LaunchDialogProps {
  /** Machine-wide projects and recent sessions (launchOptions), or null before
   *  the server has answered. */
  launchOptions: { projects: MachineProject[]; recentSessions: RecentSession[] } | null;
  transport: MessageTransport;
  onClose: () => void;
  /** The last `launchAgent` failure, if any — kept in App/useExtensionMessages
   *  since a launch started here can still resolve after this dialog closes. */
  launchError: string | null;
}

type Tab = 'projects' | 'sessions';

/** `timeAgo` needs `Date.now()`, an impure call the React Compiler forbids
 *  inline in a component body — isolated here like DebugView's formatTimeAgo. */
function sessionTimeAgo(s: RecentSession): string {
  return timeAgo(s.lastUsed, Date.now());
}

export function LaunchDialog({
  launchOptions,
  transport,
  onClose,
  launchError,
}: LaunchDialogProps) {
  const projects = launchOptions?.projects ?? [];
  const recentSessions = launchOptions?.recentSessions ?? [];

  const [tab, setTab] = useState<Tab>('projects');
  const [search, setSearch] = useState('');
  const [cwd, setCwd] = useState(projects[0]?.cwd ?? '');
  const [cwdTouched, setCwdTouched] = useState(false);
  const [bypass, setBypass] = useState(false);
  const [busy, setBusy] = useState(false);

  // The list is always fresh: ask the server on open rather than trusting
  // whatever launchOptions the last connect happened to carry.
  useEffect(() => {
    transport.send({ type: 'requestLaunchOptions' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Propose the most recently used project once the fresh list arrives — but
  // only until the user types or picks something themselves.
  useEffect(() => {
    if (!cwdTouched) setCwd(projects[0]?.cwd ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects]);

  // A launch is no longer in flight once a result (success or failure)
  // arrives — success closes this dialog from above, failure surfaces here.
  useEffect(() => {
    if (launchError) setBusy(false);
  }, [launchError]);

  const error = busy ? null : launchError;
  const filteredProjects = filterProjects(projects, search);

  const launchFolder = () => {
    setBusy(true);
    transport.send({ type: 'launchAgent', folderPath: cwd.trim(), bypassPermissions: bypass });
  };

  const resumeSession = (sessionId: string) => {
    setBusy(true);
    transport.send({ type: 'launchAgent', resumeSessionId: sessionId, bypassPermissions: bypass });
  };

  return (
    <Modal isOpen onClose={onClose} title="Lanzar agente">
      <div className="flex flex-col gap-8 px-10 pb-10">
        <div className="flex gap-4">
          <Button
            variant={tab === 'projects' ? 'active' : 'default'}
            size="sm"
            onClick={() => setTab('projects')}
          >
            Proyectos
          </Button>
          <Button
            variant={tab === 'sessions' ? 'active' : 'default'}
            size="sm"
            onClick={() => setTab('sessions')}
          >
            Sesiones recientes
          </Button>
        </div>

        {tab === 'projects' ? (
          <>
            <input
              data-testid="launch-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar proyecto..."
              className="text-xs py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
            />
            <div className="flex flex-col gap-2 max-h-40 overflow-y-auto">
              {filteredProjects.map((p) => (
                <button
                  key={p.cwd}
                  data-testid="launch-project"
                  onClick={() => {
                    setCwd(p.cwd);
                    setCwdTouched(true);
                  }}
                  className="flex flex-col items-start text-left py-4 px-6 bg-btn-bg hover:bg-btn-hover border-2 border-transparent rounded-none cursor-pointer"
                >
                  <span className="text-sm">{p.name}</span>
                  <span className="text-xs text-text-muted">{p.cwd}</span>
                </button>
              ))}
            </div>
            <label className="flex flex-col gap-4">
              Carpeta
              <input
                data-testid="launch-cwd"
                value={cwd}
                onChange={(e) => {
                  setCwd(e.target.value);
                  setCwdTouched(true);
                }}
                className="text-xs py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
              />
            </label>
            <label className="flex items-center gap-4">
              <input
                type="checkbox"
                checked={bypass}
                onChange={(e) => setBypass(e.target.checked)}
              />
              Saltar permisos <span className="text-warning">⚠</span>
            </label>
            {error && <span className="text-warning text-sm">{error}</span>}
            <div className="flex gap-8 justify-end">
              <Button onClick={onClose}>Cancelar</Button>
              <Button
                variant={busy || !cwd.trim() ? 'disabled' : 'accent'}
                onClick={launchFolder}
                disabled={busy || !cwd.trim()}
              >
                Lanzar
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-2 max-h-52 overflow-y-auto">
              {recentSessions.length === 0 && (
                <span className="text-xs text-text-muted py-4">No hay sesiones recientes.</span>
              )}
              {recentSessions.map((s) => (
                <div
                  key={s.sessionId}
                  data-testid="launch-session"
                  className="flex items-center justify-between gap-8 py-4 px-6 bg-btn-bg border-2 border-transparent rounded-none"
                >
                  <div className="flex flex-col items-start min-w-0">
                    <span className="text-sm truncate">{s.title || '(sin título)'}</span>
                    <span className="text-xs text-text-muted truncate">
                      {s.name} · {sessionTimeAgo(s)}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant={busy ? 'disabled' : 'accent'}
                    disabled={busy}
                    onClick={() => resumeSession(s.sessionId)}
                    className="shrink-0"
                  >
                    Retomar
                  </Button>
                </div>
              ))}
            </div>
            <label className="flex items-center gap-4">
              <input
                type="checkbox"
                checked={bypass}
                onChange={(e) => setBypass(e.target.checked)}
              />
              Saltar permisos <span className="text-warning">⚠</span>
            </label>
            {error && <span className="text-warning text-sm">{error}</span>}
            <div className="flex gap-8 justify-end">
              <Button onClick={onClose}>Cancelar</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
