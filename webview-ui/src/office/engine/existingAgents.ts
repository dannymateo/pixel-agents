// webview-ui/src/office/engine/existingAgents.ts
//
// Pure reconciliation for the `existingAgents` restore message. Extracted from
// useExtensionMessages so it can be unit-tested without React (mirrors
// officeCanvasCursor.ts). The deliberate e2e-over-unit policy forbids unit
// tests against the React message handler itself.
//
// The webview must handle BOTH orders in which the two restore messages arrive:
//   - existingAgents before layoutLoaded → buffer, flush on the next layoutLoaded
//   - layoutLoaded before existingAgents → layout + seats already built, add now
// Depending on layoutLoaded always arriving last stranded restored agents on any
// surface that sends layout first (e.g. the VS Code no-assets path), issue #334.

import type { TreeNodeFields } from '../scope/treeDisplay.js';

/** Per-agent metadata carried by the existingAgents message: seat, plus the
 *  spawn-tree fields a reconnecting client rebuilds the tree from. */
export interface ExistingAgentMeta extends TreeNodeFields {
  palette?: number;
  hueShift?: number;
  seatId?: string;
  depth?: number;
  /** Office console for this agent (privileged clients only). Carried through
   *  the pending buffer too (see PendingAgent): `webviewReady` always sends
   *  `existingAgents` before `layoutLoaded`, so on every fresh page load this
   *  agent is buffered — not created — the moment this metadata arrives. */
  terminalId?: string;
}

/** An agent buffered until the layout (and its seats) has been built. */
export interface PendingAgent {
  id: number;
  palette?: number;
  hueShift?: number;
  seatId?: string;
  folderName?: string;
  isHeadless?: boolean;
  terminalId?: string;
}

/** Minimal structural view of OfficeState this reconciler needs. */
export interface ExistingAgentsOffice {
  characters: { has: (id: number) => boolean };
  addAgent: (
    id: number,
    preferredPalette?: number,
    preferredHueShift?: number,
    preferredSeatId?: string,
    skipSpawnEffect?: boolean,
    folderName?: string,
  ) => void;
  setHeadless: (id: number, headless: boolean) => void;
  /** Applies a console id to an already-created character (a no-op if the
   *  character doesn't exist — every caller here just created it). */
  setTerminalId: (id: number, terminalId: string) => void;
}

/**
 * Reconcile an `existingAgents` payload into the office. When the layout is
 * already built, agents are added immediately (skipping the matrix spawn effect,
 * as restored agents do) unless they already exist; otherwise they are pushed
 * onto `pending` to be flushed by the next `layoutLoaded`. Returns true if any
 * agent was added directly, so the caller can persist seat assignments.
 */
export function reconcileExistingAgents(
  os: ExistingAgentsOffice,
  incoming: number[],
  meta: Record<number, ExistingAgentMeta>,
  folderNames: Record<number, string>,
  layoutReady: boolean,
  pending: PendingAgent[],
  headlessAgents: Record<number, boolean> = {},
): boolean {
  let addedDirectly = false;
  for (const id of incoming) {
    const m = meta[id];
    const p: PendingAgent = {
      id,
      palette: m?.palette,
      hueShift: m?.hueShift,
      seatId: m?.seatId,
      folderName: folderNames[id],
      isHeadless: headlessAgents[id] === true,
      terminalId: m?.terminalId,
    };
    if (layoutReady) {
      if (!os.characters.has(p.id)) {
        os.addAgent(p.id, p.palette, p.hueShift, p.seatId, true, p.folderName);
        if (p.isHeadless) os.setHeadless(p.id, true);
        if (p.terminalId) os.setTerminalId(p.id, p.terminalId);
        addedDirectly = true;
      }
    } else {
      pending.push(p);
    }
  }
  return addedDirectly;
}

/**
 * Adds every agent `reconcileExistingAgents` buffered while the layout wasn't
 * ready yet — the `layoutLoaded` handler's flush. Mirrors the immediate-add
 * branch above (addAgent, then setHeadless/setTerminalId) so a restored
 * agent's console survives regardless of which order `existingAgents` and
 * `layoutLoaded` arrived in. `webviewReady` always sends `existingAgents`
 * first, so this is the path every reload actually takes.
 */
export function flushPendingAgents(os: ExistingAgentsOffice, pending: PendingAgent[]): void {
  for (const p of pending) {
    os.addAgent(p.id, p.palette, p.hueShift, p.seatId, true, p.folderName);
    if (p.isHeadless) os.setHeadless(p.id, true);
    if (p.terminalId) os.setTerminalId(p.id, p.terminalId);
  }
}
