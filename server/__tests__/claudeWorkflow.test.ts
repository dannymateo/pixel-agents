import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WORKFLOW_LABEL_MAX_CHARS } from '../src/constants.js';
import {
  discoverClaudeWorkflowAgents,
  extractClaudeWorkflowLaunch,
  isWorkflowRunDirOfSession,
  validateWorkflowRunDir,
} from '../src/providers/hook/claude/claudeWorkflow.js';
import {
  SIDECAR_COLD_READS_PER_SCAN,
  SIDECAR_MAX_BYTES,
} from '../src/providers/hook/claude/constants.js';

/** What the PROVIDER read: `readFileSync` paths and `readSync` byte counts per
 *  fd path. A pass-through module mock is the only seam that reaches the
 *  provider's `import * as fs` binding (see claudeTeamProvider.test.ts). */
const fsReads = vi.hoisted(() => ({
  files: [] as string[],
  bytes: new Map<string, number>(),
  fdPath: new Map<number, string>(),
  /** openSync calls (every file the provider opens, sidecars and transcripts). */
  opens: 0,
  /** Next openSync of each path throws EBUSY (a transient Windows lock). */
  failOnce: new Set<string>(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    fsReads.files.push(String(args[0]));
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    const p = String(args[0]);
    if (fsReads.failOnce.delete(p)) {
      const err = new Error(`EBUSY: simulated lock, open '${p}'`) as NodeJS.ErrnoException;
      err.code = 'EBUSY';
      throw err;
    }
    fsReads.opens++;
    const fd = actual.openSync(...args);
    fsReads.fdPath.set(fd, String(args[0]));
    return fd;
  }) as typeof actual.openSync;
  const readSync = ((...args: Parameters<typeof actual.readSync>) => {
    const n = actual.readSync(...args);
    const p = fsReads.fdPath.get(args[0] as number) ?? '?';
    fsReads.bytes.set(p, (fsReads.bytes.get(p) ?? 0) + n);
    return n;
  }) as typeof actual.readSync;
  const mocked = { ...actual, readFileSync, openSync, readSync };
  return { ...mocked, default: mocked };
});

const WIN = process.platform === 'win32';
/** A platform-native absolute prefix, so the same fixtures run on every OS. */
const ABS = WIN
  ? 'C:\\Users\\someone\\.claude\\projects\\C--repo'
  : '/home/someone/.claude/projects/-repo';
const SEP = WIN ? '\\' : '/';
const SESSION = '3e007f79-d1f2-4c65-81d0-7c5acbf43666';
const runDirUnder = (base: string, id = 'wf_9b94fdcd-8af'): string =>
  [base, SESSION, 'subagents', 'workflows', id].join(SEP);

/** Real shape of the Workflow tool_use input (anonymized). */
const REAL_SCRIPT =
  "export const meta = {\n  name: 'transferencias-fase-1-lectura',\n  description: 'Implementa 3 endpoints de lectura de transferencias en paralelo, cada uno con QA y pentester que retroalimentan al desarrollador',\n  phases: [\n    { title: 'Descubrimiento', detail: 'Leer columnas de los cursores' },\n    { title: 'Construccion', detail: 'tres rebanadas' },\n  ],\n};\n\nexport default async function run(ctx) {\n  const dev = await ctx.agent({ name: 'dev-1', prompt: 'x' });\n}\n";

/** Real shape of the Workflow tool_result (anonymized). */
function realResult(runDir: string): string {
  const scriptFile = [
    ABS,
    SESSION,
    'workflows',
    'scripts',
    'transferencias-fase-1-lectura-wf_9b94fdcd-8af.js',
  ].join(SEP);
  return (
    'Workflow launched in background. Task ID: w4eubwvnv\n' +
    'Summary: Implementa 3 endpoints de lectura de transferencias en paralelo, cada uno con QA y pentester que retroalimentan al desarrollador\n' +
    `Transcript dir: ${runDir}\n` +
    `Script file: ${scriptFile}\n` +
    `(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "${scriptFile}"} to iterate.)`
  );
}

describe('extractClaudeWorkflowLaunch', () => {
  const runDir = runDirUnder(ABS);

  it('recognizes the real launch shape, name from meta.name of the script', () => {
    expect(
      extractClaudeWorkflowLaunch('Workflow', { script: REAL_SCRIPT }, realResult(runDir)),
    ).toEqual({
      runDir,
      name: 'transferencias-fase-1-lectura',
    });
  });

  it('accepts content-block arrays', () => {
    const content = [{ type: 'text', text: realResult(runDir) }];
    expect(extractClaudeWorkflowLaunch('Workflow', { script: REAL_SCRIPT }, content)?.runDir).toBe(
      runDir,
    );
  });

  /** Real `{scriptPath, args}` re-invocation result (anonymized): the Script
   *  file belongs to an EARLIER run, the Transcript dir to this one. */
  function scriptPathResult(scriptFileLine: string | null): string {
    return (
      'Workflow launched in background. Task ID: w9zwcnr5q\n' +
      'Summary: Construir GET /transfers/setup y /bulk-uploads/formats con QA adversarial y pentest, sin commitear\n' +
      `Transcript dir: ${runDir}\n` +
      (scriptFileLine === null ? '' : `${scriptFileLine}\n`) +
      '(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "…"} to iterate.)'
    );
  }
  const REAL_SCRIPT_FILE = `Script file: ${[ABS, SESSION, 'workflows', 'scripts', 'transfers-setup-mvp-wf_30100c59-417.js'].join(SEP)}`;
  const SCRIPT_PATH_INPUT = {
    scriptPath: 'C:\\x\\transfers-setup-mvp-wf_30100c59-417.js',
    args: '{}',
  };

  it('names a `scriptPath` invocation from the Script file basename (real shape)', () => {
    const launch = extractClaudeWorkflowLaunch(
      'Workflow',
      SCRIPT_PATH_INPUT,
      scriptPathResult(REAL_SCRIPT_FILE),
    );
    expect(launch).toEqual({ runDir, name: 'transfers-setup-mvp' });
  });

  it('prefers the inline meta.name over the Script file line', () => {
    expect(
      extractClaudeWorkflowLaunch('Workflow', { script: REAL_SCRIPT }, realResult(runDir))?.name,
    ).toBe('transferencias-fase-1-lectura');
    expect(
      extractClaudeWorkflowLaunch(
        'Workflow',
        { script: REAL_SCRIPT },
        scriptPathResult(REAL_SCRIPT_FILE),
      )?.name,
    ).toBe('transferencias-fase-1-lectura');
  });

  it('falls back to Summary without a Script file line', () => {
    expect(
      extractClaudeWorkflowLaunch('Workflow', SCRIPT_PATH_INPUT, scriptPathResult(null))?.name,
    ).toBe(
      'Construir GET /transfers/setup y /bulk-uploads/formats con QA adversarial y pentest, sin commitear'.slice(
        0,
        WORKFLOW_LABEL_MAX_CHARS,
      ),
    );
  });

  it.each([
    ['a basename without the run suffix', 'Script file: /a/b/mi-flujo.js', 'mi-flujo'],
    ['a basename without extension', 'Script file: C:\\a\\mi-flujo', 'mi-flujo'],
    ['mixed separators', 'Script file: C:\\a/b\\c/mi-flujo-wf_abc-123.mjs', 'mi-flujo'],
    [
      'a traversal path (basename used as text only)',
      'Script file: ../../../../etc/passwd',
      'passwd',
    ],
    ['a UNC path (never opened)', 'Script file: \\\\attacker\\share\\evil-name.js', 'evil-name'],
    ['a relative path', 'Script file: scripts/x.js', 'x'],
    ['a dotted name', 'Script file: /a/release.v2-wf_30100c59-417.js', 'release.v2'],
    ['a -wf_ inside the name', 'Script file: /a/deploy-wf_v2-wf_abc-1.js', 'deploy-wf_v2'],
  ])('takes the Script file name from %s', (_label, line, expected) => {
    expect(extractClaudeWorkflowLaunch('Workflow', {}, scriptPathResult(line))?.name).toBe(
      expected,
    );
  });

  it('never reads or stats the Script file path', () => {
    const statSpy = vi.spyOn(fs, 'statSync');
    const before = fsReads.files.length;
    const probe = path.join(os.tmpdir(), 'pa-never-read', 'probe-wf_abc.js');
    extractClaudeWorkflowLaunch('Workflow', {}, scriptPathResult(`Script file: ${probe}`));
    expect(fsReads.files.length).toBe(before);
    expect([...fsReads.fdPath.values()]).not.toContain(probe);
    expect(statSpy).not.toHaveBeenCalled();
    statSpy.mockRestore();
  });

  it('sanitizes and truncates the Script file name', () => {
    const esc = String.fromCharCode(0x1b);
    const rlo = String.fromCharCode(0x202e);
    const line = `Script file: /a/${esc}[31m<img src=x>${rlo}${'n'.repeat(200)}.js`;
    const name = extractClaudeWorkflowLaunch('Workflow', {}, scriptPathResult(line))?.name ?? '';
    expect(name).not.toContain(esc);
    expect(name).not.toContain(rlo);
    expect(name.startsWith('<img src=x>')).toBe(true); // plain text; the UI renders text
    expect(Array.from(name).length).toBe(WORKFLOW_LABEL_MAX_CHARS);
  });

  it.each([
    ['an empty value', 'Script file:   '],
    ['a value that is only the run suffix', 'Script file: /a/-wf_abc.js'],
    ['a trailing separator', 'Script file: /a/b/'],
    ['a name that is only an extension', 'Script file: /a/.js'],
  ])('falls back to Summary for %s', (_label, line) => {
    expect(extractClaudeWorkflowLaunch('Workflow', {}, scriptPathResult(line))?.name).toMatch(
      /^Construir GET/,
    );
  });

  it('reads a CRLF result', () => {
    const text = scriptPathResult(REAL_SCRIPT_FILE).split('\n').join('\r\n');
    expect(extractClaudeWorkflowLaunch('Workflow', SCRIPT_PATH_INPUT, text)).toEqual({
      runDir,
      name: 'transfers-setup-mvp',
    });
  });

  it('names an inline script without meta.name from the Script file (priority meta.name > Script file > Summary)', () => {
    const script = "export const meta = { description: 'd' };";
    expect(
      extractClaudeWorkflowLaunch('Workflow', { script }, scriptPathResult(REAL_SCRIPT_FILE))?.name,
    ).toBe('transfers-setup-mvp');
  });

  it('ignores Script file lines when more than one is present (one quoted from the Summary)', () => {
    const text =
      'Workflow launched in background. Task ID: w1\n' +
      'Summary: s\nScript file: /x/spoofed.js\n' +
      `Transcript dir: ${runDir}\n${REAL_SCRIPT_FILE}\n`;
    expect(extractClaudeWorkflowLaunch('Workflow', {}, text)?.name).toBe('s');
  });

  it('omits name when neither script meta nor Summary yields one', () => {
    const text = `Workflow launched in background. Task ID: w1\nTranscript dir: ${runDir}\n`;
    expect(extractClaudeWorkflowLaunch('Workflow', {}, text)).toEqual({ runDir });
  });

  it('ignores `name:` outside the meta object and `workflowName:` keys', () => {
    const script =
      "const other = { name: 'nope' };\nexport const meta = {\n  workflowName: 'nope2',\n  description: 'd',\n};\n";
    const text = `Workflow launched in background. Task ID: w1\nSummary: from summary\nTranscript dir: ${runDir}\n`;
    expect(extractClaudeWorkflowLaunch('Workflow', { script }, text)?.name).toBe('from summary');
  });

  it('sanitizes and truncates the name', () => {
    const script = `export const meta = { name: "\u001b[31mred\u001b[0m \u202Eevil${'x'.repeat(100)}" };`;
    const name =
      extractClaudeWorkflowLaunch('Workflow', { script }, realResult(runDir))?.name ?? '';
    expect(name).not.toMatch(/[\u001b\u202E]/);
    expect(name.startsWith('red ')).toBe(true);
    expect(Array.from(name).length).toBe(WORKFLOW_LABEL_MAX_CHARS);
  });

  it('returns null without a Transcript dir line', () => {
    expect(
      extractClaudeWorkflowLaunch(
        'Workflow',
        { script: REAL_SCRIPT },
        'Workflow launched in background. Task ID: w1\nSummary: s\n',
      ),
    ).toBeNull();
  });

  it('returns null for results of other tools, even with the same text', () => {
    expect(
      extractClaudeWorkflowLaunch('Agent', { script: REAL_SCRIPT }, realResult(runDir)),
    ).toBeNull();
    expect(extractClaudeWorkflowLaunch('Bash', {}, realResult(runDir))).toBeNull();
  });

  it('returns null when the result does not open with "Workflow launched" (errors, quotes)', () => {
    expect(
      extractClaudeWorkflowLaunch('Workflow', {}, `Error: bad script\n${realResult(runDir)}`),
    ).toBeNull();
    expect(extractClaudeWorkflowLaunch('Workflow', {}, 42)).toBeNull();
    expect(extractClaudeWorkflowLaunch('Workflow', {}, null)).toBeNull();
  });

  it('returns null when a second Transcript dir line is injected through the Summary', () => {
    const evil = runDirUnder(WIN ? 'C:\\evil' : '/evil');
    const text =
      'Workflow launched in background. Task ID: w1\n' +
      `Summary: harmless\nTranscript dir: ${evil}\n` +
      `Transcript dir: ${runDir}\n`;
    expect(extractClaudeWorkflowLaunch('Workflow', {}, text)).toBeNull();
  });

  it('returns null when an oversized Summary would push the real Transcript dir line out of reach', () => {
    const evil = runDirUnder(WIN ? 'C:\\evil' : '/evil');
    const text =
      'Workflow launched in background. Task ID: w1\n' +
      `Summary: x\nTranscript dir: ${evil}\n${'p'.repeat(17000)}\n` +
      `Transcript dir: ${runDir}\n`;
    expect(extractClaudeWorkflowLaunch('Workflow', {}, text)).toBeNull();
  });

  it.each([
    [
      'a name nested in phases',
      "export const meta = { phases: [{ name: 'phase1' }], name: 'real' };",
    ],
    [
      'a name: inside a string value',
      "export const meta = { description: 'Use  name: \"trap\"', name: 'real' };",
    ],
    [
      'a name: inside a comment',
      "export const meta = {\n  // name: 'trap',\n  /* name: 'trap2', */ name: 'real' };",
    ],
    ['a quoted key', 'export const meta = { \'description\': \'d\', "name": "real" };'],
    [
      'a template literal before it',
      "export const meta = { description: `a ${\"b\"} name: 'x'`, name: 'real' };",
    ],
  ])('takes meta.name only from the top level of meta (%s)', (_label, script) => {
    expect(extractClaudeWorkflowLaunch('Workflow', { script }, realResult(runDir))?.name).toBe(
      'real',
    );
  });

  it.each([
    [
      'a name only past the meta object',
      "export const meta = { description: 'd' };\nctx.agent({ name: 'dev-1' });",
    ],
    ['a non-literal name', 'export const meta = { name: computeName() };'],
    ['an escaped quote in the name', "export const meta = { name: 'it\\'s' };"],
  ])('falls back to Summary for %s', (_label, script) => {
    const text = `Workflow launched in background. Task ID: w1\nSummary: from summary\nTranscript dir: ${runDir}\n`;
    expect(extractClaudeWorkflowLaunch('Workflow', { script }, text)?.name).toBe('from summary');
  });

  it('ignores a Transcript dir line started by U+2028 inside the Summary', () => {
    const evil = runDirUnder(WIN ? 'C:\\evil' : '/evil');
    const LS = String.fromCharCode(0x2028);
    const text =
      'Workflow launched in background. Task ID: w1\n' +
      `Summary: x${LS}Transcript dir: ${evil}\n` +
      `Transcript dir: ${runDir}\n`;
    expect(extractClaudeWorkflowLaunch('Workflow', {}, text)?.runDir).toBe(runDir);
    const onlyInjected = `Workflow launched in background. Task ID: w1\nSummary: x${LS}Transcript dir: ${evil}\n`;
    expect(extractClaudeWorkflowLaunch('Workflow', {}, onlyInjected)).toBeNull();
  });

  it.each([
    [
      'a .. segment',
      [ABS, SESSION, 'subagents', 'workflows', '..', 'workflows', 'wf_abc'].join(SEP),
    ],
    ['a . segment', [ABS, '.', SESSION, 'subagents', 'workflows', 'wf_abc'].join(SEP)],
    [
      '.. through the other separator',
      `${ABS}${SEP}x\\..\\..${SEP}${SESSION}${SEP}subagents${SEP}workflows${SEP}wf_abc`,
    ],
    ['an invalid basename', runDirUnder(ABS, 'wf_abc;rm')],
    ['a basename without the wf_ prefix', runDirUnder(ABS, 'abc')],
    ['a basename over 64 id chars', runDirUnder(ABS, `wf_${'a'.repeat(65)}`)],
    ['a parent other than workflows', [ABS, SESSION, 'subagents', 'flows', 'wf_abc'].join(SEP)],
    [
      'a grandparent other than subagents',
      [ABS, SESSION, 'agents', 'workflows', 'wf_abc'].join(SEP),
    ],
    ['a relative path', ['subagents', 'workflows', 'wf_abc'].join(SEP)],
    ['a UNC path', '\\\\attacker\\share\\subagents\\workflows\\wf_abc'],
    ['a device-namespace path', '\\\\?\\C:\\x\\subagents\\workflows\\wf_abc'],
    ['a double-slash path', '//attacker/share/subagents/workflows/wf_abc'],
    ['a NUL byte', `${runDirUnder(ABS)}\u0000`],
    ['an overlong path', runDirUnder(`${ABS}${SEP}${'a'.repeat(5000)}`)],
  ])('refuses a runDir with %s', (_label, dir) => {
    const text = `Workflow launched in background. Task ID: w1\nTranscript dir: ${dir}\n`;
    expect(extractClaudeWorkflowLaunch('Workflow', {}, text)).toBeNull();
    expect(validateWorkflowRunDir(dir)).toBeUndefined();
  });

  it.runIf(WIN)('refuses drive-relative and alternate-data-stream paths on Windows', () => {
    expect(validateWorkflowRunDir('\\Users\\x\\subagents\\workflows\\wf_abc')).toBeUndefined();
    expect(validateWorkflowRunDir('C:\\x:ads\\subagents\\workflows\\wf_abc')).toBeUndefined();
    expect(validateWorkflowRunDir('C:\\x/subagents/workflows/wf_abc')).toBe(
      'C:\\x\\subagents\\workflows\\wf_abc',
    );
  });

  it('binds a run directory to its own session only', () => {
    const projectDir = ABS;
    expect(isWorkflowRunDirOfSession(runDir, projectDir, SESSION)).toBe(true);
    expect(isWorkflowRunDirOfSession(runDir, projectDir, 'other-session')).toBe(false);
    expect(isWorkflowRunDirOfSession(runDir, `${projectDir}-other`, SESSION)).toBe(false);
    expect(isWorkflowRunDirOfSession(runDirUnder(`${ABS}${SEP}nested`), projectDir, SESSION)).toBe(
      false,
    );
    expect(isWorkflowRunDirOfSession(`${runDir}${SEP}..`, projectDir, SESSION)).toBe(false);
    if (WIN)
      expect(isWorkflowRunDirOfSession(runDirUnder(ABS.toUpperCase()), projectDir, SESSION)).toBe(
        true,
      );
  });

  it('trims the value and a trailing separator', () => {
    const text = `Workflow launched in background. Task ID: w1\nTranscript dir:   ${runDir}${SEP}  \n`;
    expect(extractClaudeWorkflowLaunch('Workflow', {}, text)?.runDir).toBe(runDir);
  });
});

// ── discoverClaudeWorkflowAgents ──

let tmp: string;
let runDir: string;

/** First record of a real workflow agent transcript (anonymized). */
function firstUserRecord(content: unknown, agentId = 'a2b61afc27076d8ae'): string {
  return JSON.stringify({
    parentUuid: null,
    isSidechain: true,
    promptId: 'a0e45f61-007d-4ae9-8a9a-c0e2f02ac581',
    agentId,
    type: 'user',
    message: { role: 'user', content },
    uuid: 'u1',
    timestamp: '2026-09-01T12:00:00.000Z',
    userType: 'external',
    entrypoint: 'cli',
    cwd: 'C:/repo',
    sessionId: SESSION,
    version: '2.1.220',
    gitBranch: 'feature/x',
    slug: 's',
  });
}

function writeAgent(key: string, sidecar: unknown, lines: string[]): string {
  const jsonl = path.join(runDir, `agent-${key}.jsonl`);
  fs.writeFileSync(jsonl, lines.map((l) => `${l}\n`).join(''));
  if (sidecar !== undefined) {
    fs.writeFileSync(
      path.join(runDir, `agent-${key}.meta.json`),
      typeof sidecar === 'string' ? sidecar : JSON.stringify(sidecar),
    );
  }
  return jsonl;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-workflow-'));
  runDir = path.join(tmp, 'proj', SESSION, 'subagents', 'workflows', 'wf_9b94fdcd-8af');
  fs.mkdirSync(runDir, { recursive: true });
  fsReads.files.length = 0;
  fsReads.bytes.clear();
  fsReads.fdPath.clear();
  fsReads.opens = 0;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const byKey = (agents: ReturnType<typeof discoverClaudeWorkflowAgents>) =>
  [...agents].sort((a, b) => a.agentKey.localeCompare(b.agentKey));

describe('discoverClaudeWorkflowAgents', () => {
  it('reads the real on-disk shape: key, agentType, task label; ignores journal.jsonl', () => {
    const qa = writeAgent('a2b61afc27076d8ae', { agentType: 'workflow-subagent', spawnDepth: 1 }, [
      firstUserRecord(
        'Eres QA técnico. Tu trabajo NO es aprobar: es encontrar el fallo que el desarrollador no vio.\n\n\nREPO (worktree): C:/repo\n',
      ),
      JSON.stringify({ type: 'attachment', attachment: {} }),
    ]);
    const dev = writeAgent('a3cb96c0fc8d1af08', { agentType: 'backend-java', spawnDepth: 1 }, [
      firstUserRecord('\n\n   \nEres el desarrollador backend de T7.\nMas texto'),
    ]);
    fs.writeFileSync(
      path.join(runDir, 'journal.jsonl'),
      '{"type":"started","agentId":"a2b61afc27076d8ae"}\n',
    );

    expect(byKey(discoverClaudeWorkflowAgents(runDir))).toEqual([
      {
        jsonlPath: qa,
        agentKey: 'a2b61afc27076d8ae',
        agentType: 'workflow-subagent',
        label: 'Eres QA técnico. Tu trabajo NO es aprobar: es encontrar el fallo que el desarrol',
      },
      {
        jsonlPath: dev,
        agentKey: 'a3cb96c0fc8d1af08',
        agentType: 'backend-java',
        label: 'Eres el desarrollador backend de T7.',
      },
    ]);
  });

  it('labels agents whose first record is longer than the 16 KB read (real: up to 70 KB)', () => {
    const prompt = `Eres el mismo desarrollador backend de T7: GET /transfers/{originId}.\n${'contexto \\"citado\\" '.repeat(4000)}`;
    writeAgent('a0939d8552f9f51b5', { agentType: 'backend-java', spawnDepth: 1 }, [
      firstUserRecord(prompt),
    ]);
    const [agent] = discoverClaudeWorkflowAgents(runDir);
    expect(agent.label).toBe(
      'Eres el mismo desarrollador backend de T7: GET /transfers/{originId}.',
    );
  });

  it('decodes escapes in a cut-off record and cuts the label at the first line', () => {
    const prompt = `\t\u00e1\u00e9 "q" \\ tarea \u{1F600}\nsegunda linea ${'y'.repeat(20000)}`;
    writeAgent('abc', { agentType: 't' }, [firstUserRecord(prompt)]);
    const [agent] = discoverClaudeWorkflowAgents(runDir);
    expect(agent.label).toBe('áé "q" \\ tarea \u{1F600}');
  });

  it('decodes \\u escapes (surrogate pairs included) in a cut-off record', () => {
    const line = `{"type":"user","message":{"role":"user","content":"\\u00e1rbol \\ud83d\\ude00 tarea\\nsegunda ${'y'.repeat(20000)}"}}`;
    fs.writeFileSync(path.join(runDir, 'agent-abc.jsonl'), `${line}\n`);
    fs.writeFileSync(path.join(runDir, 'agent-abc.meta.json'), '{"agentType":"t"}');
    expect(discoverClaudeWorkflowAgents(runDir)[0].label).toBe('árbol \u{1F600} tarea');
  });

  it('reads a cut-off record whatever its key order (message before type)', () => {
    const line = `{"message":{"role":"user","content":"orden inverso\\n${'y'.repeat(20000)}"},"type":"user"}`;
    fs.writeFileSync(path.join(runDir, 'agent-abc.jsonl'), `${line}\n`);
    fs.writeFileSync(path.join(runDir, 'agent-abc.meta.json'), '{"agentType":"t"}');
    expect(discoverClaudeWorkflowAgents(runDir)[0].label).toBe('orden inverso');
  });

  it('gives no label when the record cut off by the read budget is not a user record', () => {
    writeAgent('abc', { agentType: 't' }, [
      JSON.stringify({ type: 'attachment', content: 'x'.repeat(20000) }),
      firstUserRecord('fuera de alcance'),
    ]);
    expect(discoverClaudeWorkflowAgents(runDir)[0].label).toBeUndefined();
  });

  it('drops invisible characters and replaces lone surrogates in labels', () => {
    // JSON escapes (backslash, u, 4 hex digits), so the transcript bytes stay ASCII.
    const esc = (code: number): string =>
      `${String.fromCharCode(92)}u${code.toString(16).padStart(4, '0')}`;
    const content = `a${esc(0x200b)}b${esc(0x200f)}c${esc(0x2028)}d ${esc(0xd800)}e${esc(0xfeff)}`;
    const line = `{"type":"user","message":{"role":"user","content":"${content}"}}`;
    fs.writeFileSync(path.join(runDir, 'agent-abc.jsonl'), `${line}\n`);
    fs.writeFileSync(path.join(runDir, 'agent-abc.meta.json'), `{"agentType":"t${esc(0x2060)}x"}`);
    const [agent] = discoverClaudeWorkflowAgents(runDir);
    expect(agent.label).toBe(`abc d ${String.fromCharCode(0xfffd)}e`);
    expect(agent.agentType).toBe('tx');
  });

  /** `count` agents with sidecar + task line; agent k's transcript is the k-th oldest. */
  function writeAgedAgents(count: number): void {
    const base = Date.now() / 1000 - 10_000;
    for (let k = 0; k < count; k++) {
      const jsonl = writeAgent(`k${k}`, { agentType: 't' }, [firstUserRecord(`tarea ${k}`)]);
      fs.utimesSync(jsonl, base + k, base + k);
    }
  }

  it('opens at most SIDECAR_COLD_READS_PER_SCAN files on a cold 256-agent run, newest first', () => {
    const TOTAL = 256;
    writeAgedAgents(TOTAL);
    fsReads.opens = 0;
    const first = discoverClaudeWorkflowAgents(runDir);
    expect(fsReads.opens).toBeLessThanOrEqual(SIDECAR_COLD_READS_PER_SCAN);
    // Each cold agent costs two opens (sidecar + task line).
    expect(first.map((a) => a.agentKey)).toEqual(
      Array.from(
        { length: Math.floor(SIDECAR_COLD_READS_PER_SCAN / 2) },
        (_, i) => `k${TOTAL - 1 - i}`,
      ),
    );
    expect(first.every((a) => a.label === `tarea ${a.agentKey.slice(1)}`)).toBe(true);
  }, 30_000); // 768 files to create: slow under a loaded Windows run

  it('delivers the unread agents on later calls, then answers from cache with no open', () => {
    const TOTAL = 60;
    writeAgedAgents(TOTAL);
    let calls = 0;
    let agents: ReturnType<typeof discoverClaudeWorkflowAgents> = [];
    while (agents.length < TOTAL && calls < 20) {
      fsReads.opens = 0;
      agents = discoverClaudeWorkflowAgents(runDir);
      expect(fsReads.opens).toBeLessThanOrEqual(SIDECAR_COLD_READS_PER_SCAN);
      calls++;
    }
    expect(agents).toHaveLength(TOTAL);
    expect(calls).toBe(Math.ceil((TOTAL * 2) / SIDECAR_COLD_READS_PER_SCAN));
    fsReads.opens = 0;
    expect(discoverClaudeWorkflowAgents(runDir)).toHaveLength(TOTAL);
    expect(fsReads.opens).toBe(0);
  });

  it('does not let transcripts with no user record yet starve an older unread agent', () => {
    const base = Date.now() / 1000 - 10_000;
    const old = writeAgent('old', { agentType: 't' }, [firstUserRecord('la vieja')]);
    fs.utimesSync(old, base, base);
    for (let k = 0; k < SIDECAR_COLD_READS_PER_SCAN; k++) {
      const jsonl = writeAgent(`empty${k}`, { agentType: 't' }, []);
      fs.utimesSync(jsonl, base + 1 + k, base + 1 + k); // all newer than `old`
    }
    let calls = 0;
    let found: ReturnType<typeof discoverClaudeWorkflowAgents>[number] | undefined;
    while (!found && calls < 10) {
      found = discoverClaudeWorkflowAgents(runDir).find((a) => a.agentKey === 'old');
      calls++;
    }
    expect(found?.label).toBe('la vieja');
    expect(calls).toBeLessThanOrEqual(3);
    // Nothing changed on disk: the pending "no user record yet" results are cached.
    fsReads.opens = 0;
    discoverClaudeWorkflowAgents(runDir);
    expect(fsReads.opens).toBe(0);
  });

  it('caps the agents taken from one run', () => {
    // Transcripts without sidecars: cheap to create, and the cap counts them all the same.
    for (let k = 0; k < 300; k++) fs.writeFileSync(path.join(runDir, `agent-k${k}.jsonl`), '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(discoverClaudeWorkflowAgents(runDir).length).toBeLessThanOrEqual(256);
    discoverClaudeWorkflowAgents(runDir);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('skips a long indent before the task line', () => {
    writeAgent('abc', { agentType: 't' }, [
      firstUserRecord(`${' '.repeat(1400)}tarea tras espacios\notra`),
    ]);
    expect(discoverClaudeWorkflowAgents(runDir)[0].label).toBe('tarea tras espacios');
  });

  it('skips setting records before the first user record; takes the first text block of array content', () => {
    writeAgent('abc', { agentType: 't' }, [
      JSON.stringify({ type: 'agent-setting', value: 'x' }),
      firstUserRecord([
        { type: 'image', source: {} },
        { type: 'text', text: 'Tarea desde bloque' },
      ]),
    ]);
    expect(discoverClaudeWorkflowAgents(runDir)[0].label).toBe('Tarea desde bloque');
  });

  it('sanitizes and truncates the label', () => {
    writeAgent('abc', { agentType: '\u001b[2Jrole\u202E' }, [
      firstUserRecord(`\u001b]0;title\u0007\u001b[31m${'z'.repeat(300)}`),
    ]);
    const [agent] = discoverClaudeWorkflowAgents(runDir);
    expect(agent.label).toBe('z'.repeat(WORKFLOW_LABEL_MAX_CHARS));
    expect(agent.agentType).not.toMatch(/[\u001b\u202E]/);
    expect(agent.agentType.startsWith('role')).toBe(true);
  });

  it('omits the label when the transcript has no user record yet, and picks it up once written', () => {
    const jsonl = writeAgent('abc', { agentType: 't' }, []);
    expect(discoverClaudeWorkflowAgents(runDir)[0].label).toBeUndefined();
    fs.appendFileSync(jsonl, `${firstUserRecord('ahora si')}\n`);
    expect(discoverClaudeWorkflowAgents(runDir)[0].label).toBe('ahora si');
  });

  it('omits invalid keys and files that are not agent transcripts', () => {
    writeAgent('good', { agentType: 't' }, [firstUserRecord('x')]);
    fs.writeFileSync(path.join(runDir, 'agent- good.jsonl'), '');
    fs.writeFileSync(path.join(runDir, 'agent- good.meta.json'), '{"agentType":"t"}');
    fs.writeFileSync(path.join(runDir, 'agent-a.b.jsonl'), '');
    fs.writeFileSync(path.join(runDir, 'agent-a.b.meta.json'), '{"agentType":"t"}');
    fs.writeFileSync(path.join(runDir, `agent-${'k'.repeat(129)}.jsonl`), '');
    fs.writeFileSync(path.join(runDir, 'other.jsonl'), '');
    fs.mkdirSync(path.join(runDir, 'agent-dir.jsonl'));
    fs.writeFileSync(path.join(runDir, 'agent-dir.meta.json'), '{"agentType":"t"}');
    expect(discoverClaudeWorkflowAgents(runDir).map((a) => a.agentKey)).toEqual(['good']);
  });

  it('applies the parentAgentId rule: valid ⇒ parentAgentKey, present and invalid ⇒ entry omitted', () => {
    writeAgent('child', { agentType: 't', spawnDepth: 2, parentAgentId: 'a0939d8552f9f51b5' }, []);
    writeAgent('bad', { agentType: 't', parentAgentId: '../x' }, []);
    writeAgent('badtype', { agentType: 't', parentAgentId: 7 }, []);
    writeAgent('root', { agentType: 't', spawnDepth: 1 }, []);
    const agents = byKey(discoverClaudeWorkflowAgents(runDir));
    expect(agents.map((a) => [a.agentKey, a.parentAgentKey])).toEqual([
      ['child', 'a0939d8552f9f51b5'],
      ['root', undefined],
    ]);
    expect('parentAgentKey' in agents[1]).toBe(false);
  });

  it('omits agents whose sidecar is missing, malformed, oversized or lacks agentType', () => {
    writeAgent('nometa', undefined, []);
    writeAgent('garbage', '{not json', []);
    writeAgent('array', '[]', []);
    writeAgent('notype', { spawnDepth: 1 }, []);
    writeAgent('emptytype', { agentType: '\u001b[0m  ' }, []);
    writeAgent('huge', `{"agentType":"t","pad":"${'p'.repeat(SIDECAR_MAX_BYTES)}"}`, []);
    expect(discoverClaudeWorkflowAgents(runDir)).toEqual([]);
    expect(fsReads.bytes.get(path.join(runDir, 'agent-huge.meta.json')) ?? 0).toBe(0);
  });

  it('does not read a 50 MB transcript whole (at most 16 KB of it)', () => {
    const jsonl = writeAgent('big', { agentType: 't' }, [
      JSON.stringify({ type: 'agent-setting' }),
    ]);
    fs.truncateSync(jsonl, 50 * 1024 * 1024);
    const [agent] = discoverClaudeWorkflowAgents(runDir);
    expect(agent.agentKey).toBe('big');
    expect(agent.label).toBeUndefined();
    expect(fsReads.files).not.toContain(jsonl);
    expect(fsReads.bytes.get(jsonl) ?? 0).toBeLessThanOrEqual(16 * 1024);
  });

  it('caches sidecars and definitive labels between scans', () => {
    const jsonl = writeAgent('abc', { agentType: 't' }, [firstUserRecord('tarea')]);
    discoverClaudeWorkflowAgents(runDir);
    fsReads.files.length = 0;
    fsReads.bytes.clear();
    fs.appendFileSync(jsonl, `${JSON.stringify({ type: 'assistant' })}\n`);
    expect(discoverClaudeWorkflowAgents(runDir)[0].label).toBe('tarea');
    expect(fsReads.files).toEqual([]);
    expect(fsReads.bytes.size).toBe(0);
  });

  it('re-reads the label when the transcript is replaced by another file', () => {
    const jsonl = writeAgent('abc', { agentType: 't' }, [firstUserRecord('primera')]);
    expect(discoverClaudeWorkflowAgents(runDir)[0].label).toBe('primera');
    const replacement = path.join(tmp, 'replacement.jsonl');
    fs.writeFileSync(replacement, `${firstUserRecord('segunda')}\n`);
    fs.rmSync(jsonl);
    fs.renameSync(replacement, jsonl);
    expect(discoverClaudeWorkflowAgents(runDir)[0].label).toBe('segunda');
  });

  it('does not cache a transient sidecar read failure', () => {
    writeAgent('abc', { agentType: 't' }, [firstUserRecord('x')]);
    fsReads.failOnce.add(path.join(runDir, 'agent-abc.meta.json'));
    expect(discoverClaudeWorkflowAgents(runDir)).toEqual([]);
    expect(discoverClaudeWorkflowAgents(runDir).map((a) => a.agentKey)).toEqual(['abc']);
  });

  it('returns [] for an invalid, missing or non-directory runDir', () => {
    expect(discoverClaudeWorkflowAgents(path.join(tmp, 'elsewhere'))).toEqual([]);
    expect(discoverClaudeWorkflowAgents(path.join(runDir, '..', 'wf_abc'))).toEqual([]);
    expect(discoverClaudeWorkflowAgents(runDirUnder(path.join(tmp, 'nope')))).toEqual([]);
    const fileRun = path.join(tmp, 'proj', SESSION, 'subagents', 'workflows', 'wf_file');
    fs.writeFileSync(fileRun, '');
    expect(discoverClaudeWorkflowAgents(fileRun)).toEqual([]);
  });

  it('does not follow symlinked transcripts or a symlinked run directory', (ctx) => {
    const outside = path.join(tmp, 'secret.jsonl');
    fs.writeFileSync(outside, `${firstUserRecord('SECRET')}\n`);
    try {
      fs.symlinkSync(outside, path.join(runDir, 'agent-link.jsonl'), 'file');
    } catch {
      ctx.skip(); // Windows without symlink privilege
      return;
    }
    fs.writeFileSync(path.join(runDir, 'agent-link.meta.json'), '{"agentType":"t"}');
    expect(discoverClaudeWorkflowAgents(runDir)).toEqual([]);
    expect(fsReads.bytes.has(outside)).toBe(false);
  });

  it('does not follow a symlinked sidecar', (ctx) => {
    const outside = path.join(tmp, 'meta.json');
    fs.writeFileSync(outside, '{"agentType":"LEAK"}');
    writeAgent('abc', undefined, [firstUserRecord('x')]);
    try {
      fs.symlinkSync(outside, path.join(runDir, 'agent-abc.meta.json'), 'file');
    } catch {
      ctx.skip(); // Windows without symlink privilege
      return;
    }
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(discoverClaudeWorkflowAgents(runDir)).toEqual([]);
    vi.restoreAllMocks();
  });

  it('does not follow a symlinked (or junctioned) run directory', () => {
    writeAgent('abc', { agentType: 't' }, [firstUserRecord('x')]);
    const linkedRun = path.join(tmp, 'proj', SESSION, 'subagents', 'workflows', 'wf_linked');
    // 'junction' needs no privilege on Windows and is ignored elsewhere.
    fs.symlinkSync(runDir, linkedRun, 'junction');
    expect(discoverClaudeWorkflowAgents(runDir)).toHaveLength(1);
    expect(discoverClaudeWorkflowAgents(linkedRun)).toEqual([]);
  });
});
