/**
 * LaunchDialog — the standalone browser's "+ Agent": picks a working
 * directory (typed, since the browser has no native folder picker) and an
 * optional bypass-permissions flag, then asks the server to start `claude`
 * in a pseudo-terminal. `onLaunched` hands the caller the new agent + console.
 */
import { useEffect, useState } from 'react';

import type { MachineProject } from '../../../core/src/messages.js';
import type { MessageTransport } from '../transport/types.js';
import { Button } from './ui/Button.js';
import { Modal } from './ui/Modal.js';

export interface LaunchDialogProps {
  /** Machine-wide project folders, most recently used first (launchOptions). */
  projects: MachineProject[];
  transport: MessageTransport;
  onClose: () => void;
  onLaunched: (agentId: number, terminalId: string) => void;
}

export function LaunchDialog({ projects, transport, onClose, onLaunched }: LaunchDialogProps) {
  const [cwd, setCwd] = useState(projects[0]?.cwd ?? '');
  const [bypass, setBypass] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      transport.onMessage((msg) => {
        if (msg.type !== 'launchResult') return;
        setBusy(false);
        if (msg.ok && msg.agentId !== undefined && msg.terminalId !== undefined) {
          onLaunched(msg.agentId, msg.terminalId);
        } else {
          setError(msg.error ?? 'No se pudo lanzar');
        }
      }),
    [transport, onLaunched],
  );

  const launch = () => {
    setBusy(true);
    setError(null);
    transport.send({ type: 'launchAgent', folderPath: cwd.trim(), bypassPermissions: bypass });
  };

  return (
    <Modal isOpen onClose={onClose} title="Lanzar agente">
      <div className="flex flex-col gap-8 px-10 pb-10">
        <label className="flex flex-col gap-4">
          Carpeta
          <input
            data-testid="launch-cwd"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            list="launch-recent-dirs"
            className="text-xs py-2 px-4 bg-bg border-2 border-border rounded-none text-text"
          />
          <datalist id="launch-recent-dirs">
            {projects.map((p) => (
              <option key={p.cwd} value={p.cwd} />
            ))}
          </datalist>
        </label>
        <label className="flex items-center gap-4">
          <input type="checkbox" checked={bypass} onChange={(e) => setBypass(e.target.checked)} />
          Saltar permisos <span className="text-warning">⚠</span>
        </label>
        {error && <span className="text-warning text-sm">{error}</span>}
        <div className="flex gap-8 justify-end">
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant={busy || !cwd.trim() ? 'disabled' : 'accent'}
            onClick={launch}
            disabled={busy || !cwd.trim()}
          >
            Lanzar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
