/**
 * ConsoleModal — the office console (spec §2): the real `claude` interface
 * rendered with xterm.js. It owns the keyboard while open — Esc and Ctrl+C
 * belong to Claude, not the office's own shortcuts — so it closes only via
 * its own ✕ button, never on backdrop click or Escape.
 */
import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

import { consoleMessageFor } from '../console/consoleRouting.js';
import {
  CONSOLE_FONT_FAMILY,
  CONSOLE_FONT_SIZE,
  CONSOLE_SCROLLBACK_LINES,
  CONSOLE_THEME,
} from '../constants.js';
import type { MessageTransport } from '../transport/types.js';
import { Button } from './ui/Button.js';

export interface ConsoleModalProps {
  terminalId: string;
  title: string;
  transport: MessageTransport;
  onClose: () => void;
}

export function ConsoleModal({ terminalId, title, transport, onClose }: ConsoleModalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const term = new Terminal({
      theme: CONSOLE_THEME,
      fontFamily: CONSOLE_FONT_FAMILY,
      fontSize: CONSOLE_FONT_SIZE,
      scrollback: CONSOLE_SCROLLBACK_LINES,
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    term.focus();

    const offMessage = transport.onMessage((msg) => {
      const ev = consoleMessageFor(msg, terminalId);
      if (!ev) return;
      if (ev.kind === 'snapshot') {
        term.reset();
        term.write(ev.data);
        if (ev.exited) term.write('\r\n[sesión terminada]\r\n');
      } else if (ev.kind === 'output') {
        term.write(ev.data);
      } else {
        term.write(`\r\n[sesión terminada · código ${ev.exitCode}]\r\n`);
      }
    });
    const inputSub = term.onData((data) =>
      transport.send({ type: 'terminalInput', terminalId, data }),
    );
    const sendSize = () => {
      fit.fit();
      transport.send({ type: 'terminalResize', terminalId, cols: term.cols, rows: term.rows });
    };
    const ro = new ResizeObserver(sendSize);
    ro.observe(el);

    transport.send({ type: 'terminalAttach', terminalId });
    sendSize();

    // Keys typed in the console never reach the office's own shortcuts.
    const stop = (e: KeyboardEvent) => e.stopPropagation();
    el.addEventListener('keydown', stop);

    return () => {
      el.removeEventListener('keydown', stop);
      ro.disconnect();
      inputSub.dispose();
      offMessage();
      transport.send({ type: 'terminalDetach', terminalId });
      term.dispose();
    };
  }, [terminalId, transport]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="pixel-panel flex flex-col w-[92vw] h-[88vh]">
        <div className="flex items-center justify-between py-4 px-10 border-b-2 border-border">
          <span className="text-accent-bright text-xl">{title}</span>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Cerrar consola">
            ✕
          </Button>
        </div>
        <div ref={hostRef} data-testid="office-console" className="flex-1 min-h-0 p-8" />
      </div>
    </div>
  );
}
