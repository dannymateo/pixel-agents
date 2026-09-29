/**
 * "Traer a la oficina" (spec §1): the button, the `waitingExit` state with its
 * two actions, and the `failed`/`refused` notice — shared by the character
 * overlay (`ToolOverlay`, `variant="overlay"`) and the agent screen
 * (`AgentScreenModal`, `variant="header"`) so the privilege gate below lives
 * in exactly one place.
 *
 * SECURITY (spec §5): `takeoverStatus` broadcasts reach every connection,
 * privileged or not — a token-less viewer sees the same `{type,id,state}` an
 * operator does. Every branch below (not just the initial button) is gated on
 * `consoleCapable`, which is only ever true for a privileged connection with a
 * live pty host (`providerCapabilities.terminals`, server-side). Never render
 * any of this without that check.
 */
import { useEffect, useState } from 'react';

import { canOfferTakeover, type TakeoverView } from '../console/takeoverState.js';
import { Button } from './ui/Button.js';

export interface TakeoverAgentLike {
  parentAgentId?: number | null;
  leadAgentId?: number;
  terminalId?: string;
}

export interface TakeoverControlsProps {
  agent: TakeoverAgentLike;
  /** Whether THIS connection can open an office console at all (privileged +
   *  a live pty host). Gates every piece of this component, not just the
   *  button — see the SECURITY note above. */
  consoleCapable: boolean;
  /** In-flight takeover state for this agent, if any. */
  takeoverView: TakeoverView | undefined;
  onTakeOver: () => void;
  onConfirmTakeoverClosed: () => void;
  onCancelTakeover: () => void;
  onDismissTakeover: () => void;
  /** `overlay`: compact, centered panel for the character overlay.
   *  `header`: full-width banner row for the agent screen. */
  variant: 'overlay' | 'header';
}

function isRootAgent(agent: TakeoverAgentLike): boolean {
  return (
    (agent.parentAgentId === null || agent.parentAgentId === undefined) &&
    agent.leadAgentId === undefined
  );
}

const HELP_TEXT = 'Escribe /exit en su terminal; la retomo aquí.';
const REPIN_WARNING = 'Si sigue abierta en su terminal, las dos se pisarán.';
const DEFAULT_REASON = 'No se pudo traer el agente.';

export function TakeoverControls({
  agent,
  consoleCapable,
  takeoverView,
  onTakeOver,
  onConfirmTakeoverClosed,
  onCancelTakeover,
  onDismissTakeover,
  variant,
}: TakeoverControlsProps) {
  // Two-step confirm for "Ya la cerré" (same pattern as the overlay's ×).
  // Reset whenever the takeover leaves `waitingExit` — done/cancelled clear
  // it, failed/refused replace it, and a later retry starts clean.
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (takeoverView?.state !== 'waitingExit') setConfirming(false);
  }, [takeoverView?.state]);

  // Privileged + root gate for the WHOLE control (spec §5): a token-less
  // viewer receives the exact same `takeoverStatus` broadcasts an operator
  // does, so nothing here — button or panel — may render without
  // `consoleCapable`. A derived agent (has a parent or a team lead) never has
  // any of this state to begin with, but the check costs nothing to keep.
  if (!consoleCapable || !isRootAgent(agent)) return null;

  if (!takeoverView) {
    if (!canOfferTakeover(agent, consoleCapable)) return null;
    return variant === 'overlay' ? (
      <Button
        variant="default"
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          onTakeOver();
        }}
        className="mt-2 shrink-0 leading-none"
        data-testid="takeover"
      >
        Traer a la oficina
      </Button>
    ) : (
      <div className="px-10 py-4 border-b border-border flex justify-end">
        <Button
          variant="default"
          size="sm"
          onClick={onTakeOver}
          className="shrink-0 leading-none"
          data-testid="takeover"
        >
          Traer a la oficina
        </Button>
      </div>
    );
  }

  const confirmClick = () => {
    if (confirming) {
      setConfirming(false);
      onConfirmTakeoverClosed();
    } else {
      setConfirming(true);
    }
  };
  const cancelClick = () => {
    setConfirming(false);
    onCancelTakeover();
  };

  if (takeoverView.state === 'waitingExit') {
    return variant === 'overlay' ? (
      <div
        className="mt-2 flex flex-col items-center gap-2 border-border px-8 py-4 pixel-panel max-w-2xs"
        data-testid="takeover-waiting"
      >
        <span className="text-sm leading-none text-center">Esperando que la cierres…</span>
        <span className="text-2xs text-text-muted leading-none text-center">{HELP_TEXT}</span>
        {confirming && (
          <span className="text-2xs text-danger leading-none text-center">{REPIN_WARNING}</span>
        )}
        <div className="flex gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              confirmClick();
            }}
            className={`leading-none ${confirming ? 'text-danger' : ''}`}
            data-testid="takeover-confirm-closed"
          >
            Ya la cerré
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              cancelClick();
            }}
            className="leading-none"
            data-testid="takeover-cancel"
          >
            Cancelar
          </Button>
        </div>
      </div>
    ) : (
      <div
        className="px-10 py-4 border-b border-border flex flex-wrap items-center justify-between gap-8"
        data-testid="takeover-waiting"
      >
        <div className="min-w-0">
          <div className="text-sm leading-none">Esperando que la cierres…</div>
          <div className="text-2xs text-text-muted leading-none mt-2">{HELP_TEXT}</div>
          {confirming && (
            <div className="text-2xs text-danger leading-none mt-2">{REPIN_WARNING}</div>
          )}
        </div>
        <div className="flex gap-4 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={confirmClick}
            className={`leading-none ${confirming ? 'text-danger' : ''}`}
            data-testid="takeover-confirm-closed"
          >
            Ya la cerré
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={cancelClick}
            className="leading-none"
            data-testid="takeover-cancel"
          >
            Cancelar
          </Button>
        </div>
      </div>
    );
  }

  // failed / refused
  const reason = takeoverView.reason ?? DEFAULT_REASON;
  return variant === 'overlay' ? (
    <div
      className="mt-2 flex flex-col items-center gap-2 border-border px-8 py-4 pixel-panel max-w-2xs"
      data-testid="takeover-failed"
    >
      <span className="text-sm text-danger leading-none text-center">{reason}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={(e) => {
          e.stopPropagation();
          onDismissTakeover();
        }}
        className="leading-none"
        data-testid="takeover-dismiss"
      >
        Descartar
      </Button>
    </div>
  ) : (
    <div
      className="px-10 py-4 border-b border-border flex flex-wrap items-center justify-between gap-8"
      data-testid="takeover-failed"
    >
      <span className="text-xs text-danger">{reason}</span>
      <Button
        variant="ghost"
        size="sm"
        onClick={onDismissTakeover}
        className="leading-none shrink-0"
        data-testid="takeover-dismiss"
      >
        Descartar
      </Button>
    </div>
  );
}
