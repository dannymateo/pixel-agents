/**
 * Closing an agent from the office (the overlay's ×). An office console's
 * agent is a live `claude` owned by the server: closing it kills the session,
 * so spec §2 asks for a confirmation first. Any other agent closes at once.
 */
export type CloseStep = 'close' | 'ask';

export function closeClickStep(hasConsole: boolean, confirming: boolean): CloseStep {
  return hasConsole && !confirming ? 'ask' : 'close';
}
