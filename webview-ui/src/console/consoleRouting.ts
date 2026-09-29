/** The console events for one terminal out of the wire stream. DOM-free and
 *  defensive: messages are wire JSON, every field is checked. */
export type ConsoleEvent =
  | { kind: 'snapshot'; data: string; exited: boolean }
  | { kind: 'output'; data: string }
  | { kind: 'exit'; exitCode: number };

export function consoleMessageFor(msg: unknown, terminalId: string): ConsoleEvent | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m.terminalId !== terminalId) return null;
  switch (m.type) {
    case 'terminalSnapshot':
      return typeof m.data === 'string'
        ? { kind: 'snapshot', data: m.data, exited: m.exited === true }
        : null;
    case 'terminalOutput':
      return typeof m.data === 'string' ? { kind: 'output', data: m.data } : null;
    case 'terminalExit':
      return typeof m.exitCode === 'number' ? { kind: 'exit', exitCode: m.exitCode } : null;
    default:
      return null;
  }
}
