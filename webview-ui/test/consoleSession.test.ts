import { expect, test } from 'vitest';

import { ConsoleSession } from '../src/console/consoleSession.js';

/** A fake xterm: writes complete only when the test says so (xterm parses
 *  asynchronously and answers terminal queries from inside that parse). */
function setup() {
  const screen: string[] = [];
  const pending: Array<() => void> = [];
  let resets = 0;
  const sent: string[] = [];
  const session = new ConsoleSession(
    {
      reset: () => {
        resets++;
      },
      write: (data, done) => {
        screen.push(data);
        if (done) pending.push(done);
      },
    },
    (data) => sent.push(data),
    'connected',
  );
  const parse = () => pending.splice(0).forEach((fn) => fn());
  return { session, screen, sent, parse, resets: () => resets };
}

test('input goes to the console once the snapshot replay has been parsed', () => {
  const { session, sent, parse } = setup();
  session.apply({ kind: 'snapshot', data: 'old screen', exited: false });
  // xterm answering a query replayed from the old buffer (DA/DSR/OSC 10/11):
  session.input('\u001b[?1;2c');
  expect(sent).toEqual([]);
  parse();
  session.input('hola');
  expect(sent).toEqual(['hola']);
});

test('input before any snapshot is live typing and goes through', () => {
  const { session, sent } = setup();
  session.input('x');
  expect(sent).toEqual(['x']);
});

test('a newer snapshot keeps the gate closed until ITS replay finishes', () => {
  const sent: string[] = [];
  const pending: Array<() => void> = [];
  const session = new ConsoleSession(
    { reset: () => {}, write: (_d, done) => void (done && pending.push(done)) },
    (d) => sent.push(d),
    'connected',
  );
  session.apply({ kind: 'snapshot', data: 'a', exited: false });
  session.apply({ kind: 'snapshot', data: 'b', exited: false });
  pending[0](); // the first replay finishing must not reopen the gate
  session.input('\u001b[0n');
  expect(sent).toEqual([]);
  pending[1]();
  session.input('y');
  expect(sent).toEqual(['y']);
});

test('a snapshot resets the screen before replaying', () => {
  const { session, screen, resets } = setup();
  session.apply({ kind: 'snapshot', data: 'abc', exited: false });
  expect(resets()).toBe(1);
  expect(screen).toEqual(['abc']);
});

test('an exited snapshot and a real exit say the session ended', () => {
  const { session, screen } = setup();
  session.apply({ kind: 'snapshot', data: '', exited: true });
  session.apply({ kind: 'exit', exitCode: 2 });
  expect(screen.join('')).toContain('[sesión terminada]');
  expect(screen.join('')).toContain('[sesión terminada · código 2]');
});

test('a console the server no longer has says it is unavailable', () => {
  const { session, screen } = setup();
  session.apply({ kind: 'exit', exitCode: -1 });
  expect(screen.join('')).toContain('[sesión no disponible]');
});

test('re-attach only when the transport comes back', () => {
  const { session } = setup();
  expect(session.reattachOn('connected')).toBe(false);
  expect(session.reattachOn('reconnecting')).toBe(false);
  expect(session.reattachOn('connecting')).toBe(false);
  expect(session.reattachOn('connected')).toBe(true);
  expect(session.reattachOn('connected')).toBe(false);
});

test('keys typed while the socket is down are dropped, not queued for a console no longer attached', () => {
  const { session, sent } = setup();
  session.reattachOn('reconnecting');
  session.input('perdido');
  expect(sent).toEqual([]);
  session.reattachOn('connected');
  session.input('ok');
  expect(sent).toEqual(['ok']);
});
