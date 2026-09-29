/**
 * The office console's wire logic, DOM-free so it is testable without xterm:
 * what each console event does to the screen, which typed data reaches the
 * server, and when the console must re-attach (spec §5: a dropped WebSocket
 * leaves the terminal alive; on reconnect the snapshot comes again).
 */
import { TRANSPORT_STATE_CONNECTED } from '../../../core/src/constants.js';
import type { TransportState } from '../../../core/src/transport.js';
import { CONSOLE_EXIT_CODE_UNAVAILABLE } from '../constants.js';
import type { ConsoleEvent } from './consoleRouting.js';

/** The slice of xterm's Terminal the session drives. `write`'s callback runs
 *  once the data has been parsed. */
export interface ConsoleScreen {
  reset(): void;
  write(data: string, done?: () => void): void;
}

export class ConsoleSession {
  /** Bumped per snapshot; only the newest replay's completion reopens input. */
  private replayGen = 0;
  private replaying = false;
  private lastState: TransportState;
  private readonly screen: ConsoleScreen;
  private readonly sendInput: (data: string) => void;

  constructor(
    screen: ConsoleScreen,
    sendInput: (data: string) => void,
    initialState: TransportState,
  ) {
    this.screen = screen;
    this.sendInput = sendInput;
    this.lastState = initialState;
  }

  apply(ev: ConsoleEvent): void {
    if (ev.kind === 'snapshot') {
      // Replaying an old buffer makes xterm re-answer the terminal queries in
      // it (DA, DSR/CPR, OSC 10/11) through onData; those answers must not be
      // typed into the live claude, so input is dropped until it is parsed.
      const gen = ++this.replayGen;
      this.replaying = true;
      this.screen.reset();
      this.screen.write(ev.data, () => {
        if (gen === this.replayGen) this.replaying = false;
      });
      if (ev.exited) this.screen.write('\r\n[sesión terminada]\r\n');
    } else if (ev.kind === 'output') {
      this.screen.write(ev.data);
    } else if (ev.exitCode === CONSOLE_EXIT_CODE_UNAVAILABLE) {
      this.screen.write('\r\n[sesión no disponible]\r\n');
    } else {
      this.screen.write(`\r\n[sesión terminada · código ${ev.exitCode}]\r\n`);
    }
  }

  /** xterm's onData: the user's keys, or xterm's answers to terminal queries. */
  input(data: string): void {
    // While the socket is down the server has forgotten this attachment: keys
    // the transport queued would be dropped on arrival anyway.
    if (this.replaying || this.lastState !== TRANSPORT_STATE_CONNECTED) return;
    this.sendInput(data);
  }

  /** Feed every transport state change; true when the console must attach
   *  again (the server forgot this connection's attachment with the socket). */
  reattachOn(next: TransportState): boolean {
    const back = next === TRANSPORT_STATE_CONNECTED && this.lastState !== TRANSPORT_STATE_CONNECTED;
    this.lastState = next;
    return back;
  }
}
