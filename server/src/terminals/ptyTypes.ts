/** The slice of node-pty's IPty the office uses. Injected, so tests run without
 *  native code and a host without node-pty still starts (no consoles). */
export interface PtyProcess {
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  readonly pid: number;
}

export type PtyFactory = (
  file: string,
  args: string[],
  opts: { cwd: string; cols: number; rows: number; env: Record<string, string> },
) => PtyProcess;
