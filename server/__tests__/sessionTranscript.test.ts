import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  findSessionTranscript,
  readSessionCwd,
  readSessionTitle,
} from '../src/terminals/sessionTranscript.js';

const SID = '5b3c1f0e-2a4d-4e8f-9c1b-7d6e5f4a3b2c';
let root: string;
let file: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-sess-'));
  fs.mkdirSync(path.join(root, 'C--proj'));
  file = path.join(root, 'C--proj', `${SID}.jsonl`);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const line = (o: unknown) => JSON.stringify(o) + '\n';

it('reads the last cwd of the transcript', () => {
  fs.writeFileSync(
    file,
    line({ type: 'user', cwd: 'C:\\old', message: { content: 'hola' } }) +
      line({ type: 'assistant', cwd: 'C:\\new' }),
  );
  expect(readSessionCwd(file)).toBe('C:\\new');
});

it('the title is the first user text prompt, one line, bounded', () => {
  fs.writeFileSync(
    file,
    line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } }) +
      line({ type: 'user', message: { content: 'Arregla\nel login ' + 'x'.repeat(300) } }),
  );
  const t = readSessionTitle(file)!;
  expect(t.startsWith('Arregla el login')).toBe(true);
  expect(t.length).toBeLessThanOrEqual(120);
});

it('skips isMeta records when picking the title', () => {
  fs.writeFileSync(
    file,
    line({ type: 'user', isMeta: true, message: { content: 'caveat: be careful' } }) +
      line({ type: 'user', message: { content: 'arregla el login' } }),
  );
  expect(readSessionTitle(file)).toBe('arregla el login');
});

it('skips isCompactSummary records when picking the title', () => {
  fs.writeFileSync(
    file,
    line({ type: 'user', isCompactSummary: true, message: { content: 'resumen previo' } }) +
      line({ type: 'user', message: { content: 'arregla el login' } }),
  );
  expect(readSessionTitle(file)).toBe('arregla el login');
});

it('skips local-command text when picking the title', () => {
  fs.writeFileSync(
    file,
    line({
      type: 'user',
      message: { content: '<local-command-stdout>ok</local-command-stdout>' },
    }) + line({ type: 'user', message: { content: 'arregla el login' } }),
  );
  expect(readSessionTitle(file)).toBe('arregla el login');
});

it('skips system-reminder text when picking the title', () => {
  fs.writeFileSync(
    file,
    line({ type: 'user', message: { content: '<system-reminder>caveat text</system-reminder>' } }) +
      line({ type: 'user', message: { content: 'arregla el login' } }),
  );
  expect(readSessionTitle(file)).toBe('arregla el login');
});

it('a slash command with args uses the command-args text', () => {
  fs.writeFileSync(
    file,
    line({
      type: 'user',
      message: {
        content:
          '<command-name>/equipo</command-name>\n' +
          '<command-message>equipo</command-message>\n' +
          '<command-args>arregla el login</command-args>',
      },
    }),
  );
  expect(readSessionTitle(file)).toBe('arregla el login');
});

it('a slash command with empty args is skipped, keeps looking for the next prompt', () => {
  fs.writeFileSync(
    file,
    line({
      type: 'user',
      message: {
        content:
          '<command-name>/clear</command-name>\n' +
          '<command-message>clear</command-message>\n' +
          '<command-args></command-args>',
      },
    }) + line({ type: 'user', message: { content: 'arregla el login' } }),
  );
  expect(readSessionTitle(file)).toBe('arregla el login');
});

it('missing file or no cwd → undefined', () => {
  expect(readSessionCwd(path.join(root, 'nope.jsonl'))).toBeUndefined();
  fs.writeFileSync(file, line({ type: 'user', message: { content: 'hola' } }));
  expect(readSessionCwd(file)).toBeUndefined();
});

it('findSessionTranscript finds it under a root and refuses unsafe ids', () => {
  fs.writeFileSync(file, line({ type: 'user' }));
  expect(findSessionTranscript(SID, [root])).toBe(file);
  expect(findSessionTranscript('../C--proj/' + SID, [root])).toBeUndefined();
  expect(findSessionTranscript('00000000-0000-0000-0000-000000000000', [root])).toBeUndefined();
});
