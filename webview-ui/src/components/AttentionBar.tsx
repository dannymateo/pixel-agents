import { useEffect, useRef, useState } from 'react';

import type { AttentionEntry, AttentionReason } from '../office/attention.js';
import { Button } from './ui/Button.js';

const REASON_ICON: Record<AttentionReason, string> = {
  permission: '⚠',
  question: '?',
  waiting: '…',
};

const REASON_LABEL: Record<AttentionReason, string> = {
  permission: 'Permiso',
  question: 'Pregunta',
  waiting: 'Espera tu respuesta',
};

function minutesAgo(since: number): number {
  return Math.max(0, Math.round((Date.now() - since) / 60000));
}

interface AttentionBarProps {
  attention: AttentionEntry[];
  /** Answer this agent (spec §3): opens its console, its screen, or focuses
   *  its terminal, depending on where it lives (see `resolveAttendTarget`). */
  onAttend: (id: number) => void;
  /** The agent's display name — same rule as the overlay/directory: a
   *  teammate's own name, its task label, its role, or `Agente #id`. */
  labelOf: (id: number) => string;
}

/** "Te esperan" (spec §3): a counter button in the bottom bar that opens the
 *  list of agents waiting on the user — why, and for how long. Hidden while
 *  nobody is waiting. */
export function AttentionBar({ attention, onAttend, labelOf }: AttentionBarProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen]);

  // Nobody left waiting while the list was open: close it rather than show an
  // empty panel.
  useEffect(() => {
    if (attention.length === 0) setIsOpen(false);
  }, [attention.length]);

  if (attention.length === 0) return null;

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant={isOpen ? 'active' : 'default'}
        onClick={() => setIsOpen((v) => !v)}
        title="Agentes que esperan tu respuesta"
        data-testid="attention-bar"
      >
        Te esperan ({attention.length})
      </Button>
      {isOpen && (
        <div className="absolute bottom-full left-0 pb-10 z-10">
          <div className="bg-bg border-2 border-border rounded-none shadow-pixel p-4 min-w-192 flex flex-col gap-2">
            {attention.map((entry) => (
              <button
                key={entry.id}
                data-testid="attention-item"
                onClick={() => {
                  setIsOpen(false);
                  onAttend(entry.id);
                }}
                className="flex items-center gap-6 text-left w-full py-4 px-8 bg-transparent border-none rounded-none cursor-pointer whitespace-nowrap hover:bg-btn-bg text-base"
              >
                <span aria-hidden="true">{REASON_ICON[entry.reason]}</span>
                <span className="flex-1 overflow-hidden text-ellipsis">{labelOf(entry.id)}</span>
                <span className="text-2xs text-text-muted shrink-0">
                  {REASON_LABEL[entry.reason]}
                </span>
                <span className="text-2xs text-text-muted shrink-0">
                  {minutesAgo(entry.since)} min
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
