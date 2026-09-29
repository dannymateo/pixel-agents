import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { RECENT_SESSION_LIVE_WINDOW_MS } from '../src/constants.js';
import { listMachineProjects, listRecentSessions } from '../src/terminals/machineSessions.js';

let root: string;
let tmp: string;

const line = (o: unknown) => JSON.stringify(o) + '\n';
const uuid = (n: number) => `5b3c1f0e-2a4d-4e8f-9c1b-7d6e5f4a3${n.toString().padStart(3, '0')}`;

/** Long enough ago to sit outside RECENT_SESSION_LIVE_WINDOW_MS. */
const OLD_ENOUGH_MS = RECENT_SESSION_LIVE_WINDOW_MS + 5 * 60_000;

function writeTranscript(file: string, opts: { cwd?: string; mtimeMsAgo: number; text?: string }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record: Record<string, unknown> = {
    type: 'user',
    message: { content: opts.text ?? 'hola' },
  };
  if (opts.cwd !== undefined) record.cwd = opts.cwd;
  fs.writeFileSync(file, line(record));
  const mtime = new Date(Date.now() - opts.mtimeMsAgo);
  fs.utimesSync(file, mtime, mtime);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-machine-'));
  root = path.join(tmp, 'projects');
  fs.mkdirSync(root);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

it('lists one machine project per folder, the newest transcript cwd, newest first, skipping a nonexistent cwd', () => {
  const cwdA = fs.mkdtempSync(path.join(tmp, 'cwdA-'));
  const cwdOldA = fs.mkdtempSync(path.join(tmp, 'cwdOldA-'));
  const cwdB = fs.mkdtempSync(path.join(tmp, 'cwdB-'));
  const cwdOldB = fs.mkdtempSync(path.join(tmp, 'cwdOldB-'));
  const cwdMissing = path.join(tmp, 'does-not-exist');

  const projA = path.join(root, 'C--projA');
  const projB = path.join(root, 'C--projB');
  const projC = path.join(root, 'C--projC');

  writeTranscript(path.join(projA, `${uuid(1)}.jsonl`), {
    cwd: cwdOldA,
    mtimeMsAgo: OLD_ENOUGH_MS + 3_000_000,
  });
  writeTranscript(path.join(projA, `${uuid(2)}.jsonl`), {
    cwd: cwdA,
    mtimeMsAgo: OLD_ENOUGH_MS + 1_000_000, // newest in projA
  });

  writeTranscript(path.join(projB, `${uuid(3)}.jsonl`), {
    cwd: cwdOldB,
    mtimeMsAgo: OLD_ENOUGH_MS + 2_500_000,
  });
  writeTranscript(path.join(projB, `${uuid(4)}.jsonl`), {
    cwd: cwdB,
    mtimeMsAgo: OLD_ENOUGH_MS + 2_000_000, // newest in projB, but older than projA's newest
  });

  // Only session in projC points at a cwd that no longer exists -> excluded entirely.
  writeTranscript(path.join(projC, `${uuid(5)}.jsonl`), {
    cwd: cwdMissing,
    mtimeMsAgo: OLD_ENOUGH_MS + 500_000,
  });

  const projects = listMachineProjects([root]);

  expect(projects.map((p) => p.cwd)).toEqual([cwdA, cwdB]);
  expect(projects.map((p) => p.name)).toEqual([path.basename(cwdA), path.basename(cwdB)]);
  expect(projects.every((p) => Number.isFinite(p.lastUsed))).toBe(true);
  expect(projects[0].lastUsed).toBeGreaterThan(projects[1].lastUsed);
});

it('lists recent sessions ordered by mtime, respects exclude, ignores subagent transcripts, brings titles', () => {
  const cwdA = fs.mkdtempSync(path.join(tmp, 'cwdA-'));
  const projA = path.join(root, 'C--projA');

  const sidOld = uuid(10);
  const sidNew = uuid(11);
  const sidExcluded = uuid(12);

  writeTranscript(path.join(projA, `${sidOld}.jsonl`), {
    cwd: cwdA,
    mtimeMsAgo: OLD_ENOUGH_MS + 3_000_000,
    text: 'arregla el login viejo',
  });
  writeTranscript(path.join(projA, `${sidNew}.jsonl`), {
    cwd: cwdA,
    mtimeMsAgo: OLD_ENOUGH_MS + 1_000_000,
    text: 'arregla el login nuevo',
  });
  writeTranscript(path.join(projA, `${sidExcluded}.jsonl`), {
    cwd: cwdA,
    mtimeMsAgo: OLD_ENOUGH_MS + 500_000,
    text: 'ya tiene agente vivo',
  });

  // Sub-agent transcript: newer than everything above, must never be listed
  // as a top-level session.
  writeTranscript(path.join(projA, sidNew, 'subagents', 'agent-xyz.jsonl'), {
    mtimeMsAgo: OLD_ENOUGH_MS,
    text: 'no soy una sesion de nivel superior',
  });

  const sessions = listRecentSessions([root], { exclude: new Set([sidExcluded]) });

  expect(sessions.map((s) => s.sessionId)).toEqual([sidNew, sidOld]);
  expect(sessions[0].cwd).toBe(cwdA);
  expect(sessions[0].name).toBe(path.basename(cwdA));
  expect(sessions[0].title).toBe('arregla el login nuevo');
  expect(sessions[1].title).toBe('arregla el login viejo');
});

it('excludes a session transcript modified within the live window (still open elsewhere)', () => {
  const cwdA = fs.mkdtempSync(path.join(tmp, 'cwdA-'));
  const projA = path.join(root, 'C--projA');

  const sidLive = uuid(20);
  const sidStale = uuid(21);

  writeTranscript(path.join(projA, `${sidLive}.jsonl`), {
    cwd: cwdA,
    mtimeMsAgo: 1_000, // well within RECENT_SESSION_LIVE_WINDOW_MS
    text: 'sesion probablemente abierta en otra terminal',
  });
  writeTranscript(path.join(projA, `${sidStale}.jsonl`), {
    cwd: cwdA,
    mtimeMsAgo: OLD_ENOUGH_MS,
    text: 'sesion vieja, segura de retomar',
  });

  const sessions = listRecentSessions([root]);

  expect(sessions.map((s) => s.sessionId)).toEqual([sidStale]);
});

it('bounds the result: 30 transcripts with max 5 returns 5', () => {
  const cwdA = fs.mkdtempSync(path.join(tmp, 'cwdA-'));
  const projA = path.join(root, 'C--projA');

  const sids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const sid = `5b3c1f0e-2a4d-4e8f-9c1b-${(700 + i).toString().padStart(12, '0')}`;
    sids.push(sid);
    writeTranscript(path.join(projA, `${sid}.jsonl`), {
      cwd: cwdA,
      mtimeMsAgo: OLD_ENOUGH_MS + i * 60_000, // i=0 newest
      text: `prompt ${i}`,
    });
  }

  const sessions = listRecentSessions([root], { max: 5 });

  expect(sessions.length).toBe(5);
  expect(sessions.map((s) => s.sessionId)).toEqual(sids.slice(0, 5));
});

it('listMachineProjects and listRecentSessions ignore unreadable/missing roots', () => {
  expect(listMachineProjects([path.join(tmp, 'nope')])).toEqual([]);
  expect(listRecentSessions([path.join(tmp, 'nope')])).toEqual([]);
});
