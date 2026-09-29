# Agentes interactivos (te esperan, proyectos y retomar, traer a la oficina) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la oficina del navegador sea usable con todos los agentes de la máquina: avisa quién te espera y por qué, lanza o retoma sesiones de cualquier proyecto, y trae a una consola propia cualquier agente que corre en otra terminal.

**Architecture:** Un rastreador puro de atención en la webview (`AttentionTracker`) alimentado por los mensajes que ya llegan, con contador en el título y barra "Te esperan". En el servidor, `MachineSessions` lista proyectos y sesiones de `~/.claude/projects`, el provider aprende a construir `claude --resume <id>`, el runtime retoma una sesión en una consola (`launchOfficeAgent({ resumeSessionId })`) y "trae" un agente externo esperando su `SessionEnd` para retomarlo **en el mismo agente** (`requestTakeover`).

**Tech Stack:** TypeScript, Fastify/WS, node-pty, React 19, xterm.js, Vitest, Playwright, AsyncAPI 3.0 + Modelina.

**Spec:** `docs/superpowers/specs/2026-09-29-agentes-interactivos-design.md` (y su base `2026-09-28-office-terminals-design.md`).

## Global Constraints

- Solo standalone para consolas/traer/retomar; la extensión de VS Code no cambia (en VS Code, "Te esperan" funciona y su clic enfoca la terminal como hoy).
- Mensajes nuevos cliente→servidor **privilegiados**: nunca en `VIEWER_MESSAGES` (`server/src/clientMessageHandler.ts`); y solo con consolas disponibles (`runtime.ptyHost`).
- Contenido de transcript (títulos de sesión, rutas de proyecto) solo a conexiones privilegiadas.
- Traer nunca mata un proceso ajeno: espera `SessionEnd` o la confirmación explícita del operador.
- `resumeSessionId` validado con `isSafeSessionId` (`server/src/sessionRouter.ts`) y resuelto a un transcript bajo `HookProvider.getAllSessionRoots()`; el `cwd` sale del transcript, nunca del cliente.
- Lecturas de transcript acotadas (cabeza/cola), nunca el archivo entero; sin seguir symlinks.
- Constantes en `server/src/constants.ts` / `webview-ui/src/constants.ts`; colores solo en `webview-ui/src/constants.ts`; `var(--pixel-shadow)`; FS Pixel Sans; `import type`; sin `enum`; imports `.js` en server.
- `core/src/messages.ts` se genera (`npm run asyncapi:generate`), nunca a mano; CLAUDE.md lleva el conteo de variantes.
- Vitest del server desde `server/`; nunca correr el CLI contra el HOME real ni lanzar el `claude` real (e2e: `PIXEL_AGENTS_CLAUDE_COMMAND` + `PIXEL_AGENTS_MOCK_CONSOLE`).
- Commits en español `tipo: Descripción` + trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; rama `feature/agent-tree-scope-offices`; sin push.

## Review Focus

1. **Un agente que pide permiso y enseguida sigue** (el permiso se resolvió en la terminal): la entrada de "Te esperan" desaparece con el siguiente `agentToolStart`/`agentStatus active` — test en Task 1.
2. **Traer a un agente que en su terminal hace `/clear` en vez de `/exit`**: no se retoma hasta que la sesión termine de verdad; la marca sobrevive al cambio de session id — test en Task 7.
3. **Retomar una sesión reciente cuyo `cwd` ya no existe o cuyo transcript se borró**: `launchResult { ok: false }` con motivo legible, sin agente ni pty — tests en Task 3.
4. **`resumeSessionId` malicioso** (`../x`, id de otra raíz): rechazado sin tocar disco fuera de las raíces — test en Task 3.
5. **Proyecto con cientos de transcripts o transcripts enormes**: la lista responde acotada y rápida (solo el más reciente por carpeta, lectura de cola acotada) — test en Task 4.

---

## File Structure

| Archivo                                                                                                                                         | Responsabilidad                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `webview-ui/src/office/attention.ts` (nuevo)                                                                                                    | `AttentionTracker` puro: quién espera y por qué                                                         |
| `webview-ui/src/office/attendTarget.ts` (nuevo)                                                                                                 | Adónde lleva el clic de "Te esperan" (consola / pantalla / enfocar)                                     |
| `webview-ui/src/components/AttentionBar.tsx` (nuevo)                                                                                            | Botón + lista "Te esperan"                                                                              |
| `server/src/terminals/sessionTranscript.ts` (nuevo)                                                                                             | `readSessionCwd`, `readSessionTitle` (lecturas acotadas)                                                |
| `server/src/terminals/machineSessions.ts` (nuevo)                                                                                               | Proyectos y sesiones recientes de la máquina                                                            |
| `core/src/provider.ts`, `server/src/providers/hook/claude/claude.ts`                                                                            | `buildLaunchCommand(..., { resume })`                                                                   |
| `server/src/agentRuntime.ts`                                                                                                                    | `launchOfficeAgent({ resumeSessionId })`, `requestTakeover`, `cancelTakeover`, retoma en `onSessionEnd` |
| `server/src/clientMessageHandler.ts`                                                                                                            | `launchOptions` nuevo, `requestLaunchOptions`, `takeOverAgent`, `cancelTakeover`                        |
| `core/asyncapi.yaml` → `core/src/messages.ts`                                                                                                   | Mensajes nuevos/cambiados                                                                               |
| `webview-ui/src/components/LaunchDialog.tsx`                                                                                                    | Pestañas Proyectos / Sesiones recientes                                                                 |
| `webview-ui/src/office/components/ToolOverlay.tsx`, `webview-ui/src/components/AgentScreenModal.tsx`, `webview-ui/src/components/DebugView.tsx` | Botón Traer, estado pendiente, confirmación en Debug View                                               |
| `e2e/tests/standalone/interactive.spec.ts` (nuevo)                                                                                              | E2E de las tres piezas                                                                                  |

---

### Task 1: `AttentionTracker` (webview, puro)

**Files:**

- Create: `webview-ui/src/office/attention.ts`
- Modify: `webview-ui/src/constants.ts`
- Test: `webview-ui/test/attention.test.ts`

**Interfaces:**

- Produces: `type AttentionReason = 'permission' | 'question' | 'waiting'`; `interface AttentionEntry { id: number; reason: AttentionReason; since: number }`; `class AttentionTracker { constructor(now?: () => number); apply(msg: unknown): boolean; list(): AttentionEntry[]; readonly size: number }`; `function attentionTitle(count: number, base?: string): string`; constante `ASK_USER_QUESTION_STATUS = 'Waiting for your answer'` (debe coincidir con `formatToolStatus` de `server/src/providers/hook/claude/claude.ts` para `AskUserQuestion`), `ATTENTION_TITLE_BASE = 'Pixel Agents'`.

- [ ] **Step 1: Test que falla**

`webview-ui/test/attention.test.ts`:

```ts
import { expect, test } from 'vitest';

import { AttentionTracker, attentionTitle } from '../src/office/attention.js';

function tracker() {
  let t = 1000;
  const tr = new AttentionTracker(() => t);
  return { tr, tick: (ms: number) => (t += ms) };
}

test('a permission request puts the agent on the list', () => {
  const { tr } = tracker();
  expect(tr.apply({ type: 'agentToolPermission', id: 1 })).toBe(true);
  expect(tr.list()).toEqual([{ id: 1, reason: 'permission', since: 1000 }]);
});

test('the permission clears when resolved or when the agent moves on', () => {
  const { tr } = tracker();
  tr.apply({ type: 'agentToolPermission', id: 1 });
  tr.apply({ type: 'agentToolPermissionClear', id: 1 });
  expect(tr.size).toBe(0);
  tr.apply({ type: 'agentToolPermission', id: 2 });
  tr.apply({ type: 'agentToolStart', id: 2, toolId: 't', status: 'Reading x', toolName: 'Read' });
  expect(tr.size).toBe(0);
  tr.apply({ type: 'agentToolPermission', id: 3 });
  tr.apply({ type: 'agentStatus', id: 3, status: 'active' });
  expect(tr.size).toBe(0);
});

test('AskUserQuestion is a question until its tool is done', () => {
  const { tr } = tracker();
  tr.apply({
    type: 'agentToolStart',
    id: 1,
    toolId: 'q1',
    status: 'Waiting for your answer',
    toolName: 'AskUserQuestion',
  });
  expect(tr.list()[0]).toMatchObject({ id: 1, reason: 'question' });
  tr.apply({ type: 'agentToolDone', id: 1, toolId: 'q1' });
  expect(tr.size).toBe(0);
});

test('a sub-agent question (status only, no toolName) counts on the parent id it arrives with', () => {
  const { tr } = tracker();
  tr.apply({
    type: 'subagentToolStart',
    id: 7,
    parentToolId: 'p',
    toolId: 's1',
    status: 'Waiting for your answer',
  });
  expect(tr.list()[0]).toMatchObject({ id: 7, reason: 'question' });
  tr.apply({ type: 'subagentToolDone', id: 7, parentToolId: 'p', toolId: 's1' });
  expect(tr.size).toBe(0);
});

test('waiting for input: set by waiting, cleared by active; never downgrades a permission', () => {
  const { tr } = tracker();
  tr.apply({ type: 'agentStatus', id: 1, status: 'waiting' });
  expect(tr.list()[0]).toMatchObject({ reason: 'waiting' });
  tr.apply({ type: 'agentStatus', id: 1, status: 'active' });
  expect(tr.size).toBe(0);
  tr.apply({ type: 'agentToolPermission', id: 2 });
  tr.apply({ type: 'agentStatus', id: 2, status: 'waiting' });
  expect(tr.list()[0]).toMatchObject({ id: 2, reason: 'permission' });
});

test('closing the agent or clearing its tools removes it; oldest first; unknown junk ignored', () => {
  const { tr, tick } = tracker();
  tr.apply({ type: 'agentToolPermission', id: 1 });
  tick(10);
  tr.apply({ type: 'agentStatus', id: 2, status: 'waiting' });
  expect(tr.list().map((e) => e.id)).toEqual([1, 2]);
  tr.apply({ type: 'agentClosed', id: 1 });
  tr.apply({ type: 'agentToolsClear', id: 2 });
  expect(tr.size).toBe(0);
  expect(tr.apply(null)).toBe(false);
  expect(tr.apply({ type: 'agentToolPermission', id: 'x' })).toBe(false);
});

test('attentionTitle', () => {
  expect(attentionTitle(0)).toBe('Pixel Agents');
  expect(attentionTitle(2)).toBe('(2) Pixel Agents');
});
```

- [ ] **Step 2: Verificar que falla** — Run: `cd webview-ui && npx vitest run test/attention.test.ts` · Expected: FAIL, módulo inexistente.

- [ ] **Step 3: Constantes** — en `webview-ui/src/constants.ts`:

```ts
// ── Te esperan (attention) ──
/** Status text the server formats for AskUserQuestion (server/src/providers/hook/claude/claude.ts
 *  formatToolStatus). Sub-agent tool starts carry only this text, no tool name. */
export const ASK_USER_QUESTION_STATUS = 'Waiting for your answer';
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';
export const ATTENTION_TITLE_BASE = 'Pixel Agents';
```

- [ ] **Step 4: Implementación** — `webview-ui/src/office/attention.ts`:

```ts
import {
  ASK_USER_QUESTION_STATUS,
  ASK_USER_QUESTION_TOOL,
  ATTENTION_TITLE_BASE,
} from '../constants.js';

/**
 * Who in the office is waiting on the user, and why (spec "Te esperan"). Fed
 * from the same wire messages that animate the characters; DOM-free.
 * Priority when several apply: permission > question > waiting.
 */
export type AttentionReason = 'permission' | 'question' | 'waiting';

export interface AttentionEntry {
  id: number;
  reason: AttentionReason;
  since: number;
}

const RANK: Record<AttentionReason, number> = { permission: 3, question: 2, waiting: 1 };

export function attentionTitle(count: number, base: string = ATTENTION_TITLE_BASE): string {
  return count > 0 ? `(${count}) ${base}` : base;
}

export class AttentionTracker {
  private readonly entries = new Map<number, AttentionEntry>();
  /** Open question tool ids per agent (AskUserQuestion, own or sub-agent's). */
  private readonly questions = new Map<number, Set<string>>();

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.entries.size;
  }

  list(): AttentionEntry[] {
    return [...this.entries.values()].sort((a, b) => a.since - b.since);
  }

  apply(msg: unknown): boolean {
    if (!msg || typeof msg !== 'object') return false;
    const m = msg as Record<string, unknown>;
    const id = m.id;
    if (typeof id !== 'number' || !Number.isFinite(id)) return false;
    switch (m.type) {
      case 'agentToolPermission':
      case 'subagentToolPermission':
        return this.raise(id, 'permission');
      case 'agentToolPermissionClear':
        return this.drop(id, 'permission');
      case 'agentToolStart':
      case 'subagentToolStart': {
        const isQuestion =
          m.toolName === ASK_USER_QUESTION_TOOL || m.status === ASK_USER_QUESTION_STATUS;
        if (isQuestion && typeof m.toolId === 'string') {
          let open = this.questions.get(id);
          if (!open) this.questions.set(id, (open = new Set()));
          open.add(m.toolId);
          return this.raise(id, 'question', true);
        }
        // Any other tool: the agent is working again.
        return this.dropUnlessQuestion(id);
      }
      case 'agentToolDone':
      case 'subagentToolDone': {
        const open = this.questions.get(id);
        if (!open || typeof m.toolId !== 'string' || !open.delete(m.toolId)) return false;
        if (open.size > 0) return false;
        this.questions.delete(id);
        return this.drop(id, 'question');
      }
      case 'agentToolsClear':
      case 'agentClosed':
        this.questions.delete(id);
        return this.entries.delete(id);
      case 'agentStatus':
        if (m.status === 'waiting') return this.raise(id, 'waiting');
        if (m.status === 'active') return this.dropUnlessQuestion(id);
        return false;
      default:
        return false;
    }
  }

  private raise(id: number, reason: AttentionReason, force = false): boolean {
    const current = this.entries.get(id);
    if (current && !force && RANK[current.reason] >= RANK[reason]) return false;
    if (current?.reason === reason) return false;
    this.entries.set(id, { id, reason, since: current?.since ?? this.now() });
    return true;
  }

  private drop(id: number, reason: AttentionReason): boolean {
    if (this.entries.get(id)?.reason !== reason) return false;
    this.entries.delete(id);
    return true;
  }

  private dropUnlessQuestion(id: number): boolean {
    const current = this.entries.get(id);
    if (!current || this.questions.get(id)?.size) return false;
    this.entries.delete(id);
    return true;
  }
}
```

- [ ] **Step 5: Verificar** — `cd webview-ui && npx vitest run test/attention.test.ts` → PASS (7). Luego `npm run check-types` y `npx eslint webview-ui/src/office/attention.ts`.

- [ ] **Step 6: Commit** — `feat: Rastreador de agentes que te esperan`

---

### Task 2: "Te esperan" en la interfaz (título, barra, clic) + confirmación en Debug View

**Files:**

- Create: `webview-ui/src/office/attendTarget.ts`, `webview-ui/src/components/AttentionBar.tsx`
- Modify: `webview-ui/src/hooks/useExtensionMessages.ts`, `webview-ui/src/App.tsx`, `webview-ui/src/components/BottomToolbar.tsx`, `webview-ui/src/components/DebugView.tsx`
- Test: `webview-ui/test/attendTarget.test.ts`

**Interfaces:**

- Consumes: `AttentionTracker`, `attentionTitle` (Task 1); `AgentDirectory.get(id)?.parentAgentId` (`webview-ui/src/office/scope/agentDirectory.ts`); `OfficeState.subagentMeta` (Task-era subs) y `characters.get(id)?.terminalId`; `closeClickStep` (`webview-ui/src/console/closeConfirm.ts`, ya usado por `ToolOverlay`).
- Produces: `resolveAttendTarget(id, lookup): { kind: 'console'; rootId: number; terminalId: string } | { kind: 'screen'; id: number } | { kind: 'focus'; id: number }` con `lookup = { parentOf(id): number | undefined; terminalOf(id): string | undefined; isBrowser: boolean }`; `useExtensionMessages` devuelve `attention: AttentionEntry[]`.

- [ ] **Step 1: Test que falla** — `webview-ui/test/attendTarget.test.ts`:

```ts
import { expect, test } from 'vitest';

import { resolveAttendTarget } from '../src/office/attendTarget.js';

const lookup = (
  parents: Record<number, number>,
  terminals: Record<number, string>,
  isBrowser = true,
) => ({
  parentOf: (id: number) => parents[id],
  terminalOf: (id: number) => terminals[id],
  isBrowser,
});

test('an office agent opens its own console', () => {
  expect(resolveAttendTarget(1, lookup({}, { 1: 't1' }))).toEqual({
    kind: 'console',
    rootId: 1,
    terminalId: 't1',
  });
});

test('a sub-agent of an office agent opens its root console (any depth)', () => {
  expect(resolveAttendTarget(9, lookup({ 9: 5, 5: 1 }, { 1: 't1' }))).toEqual({
    kind: 'console',
    rootId: 1,
    terminalId: 't1',
  });
});

test('an external agent opens its screen in the browser, focuses its terminal in VS Code', () => {
  expect(resolveAttendTarget(4, lookup({}, {}))).toEqual({ kind: 'screen', id: 4 });
  expect(resolveAttendTarget(4, lookup({}, {}, false))).toEqual({ kind: 'focus', id: 4 });
});

test('a parent cycle never loops', () => {
  expect(resolveAttendTarget(2, lookup({ 2: 3, 3: 2 }, {}))).toEqual({ kind: 'screen', id: 2 });
});
```

- [ ] **Step 2: Verificar que falla** — `cd webview-ui && npx vitest run test/attendTarget.test.ts` → FAIL.

- [ ] **Step 3: `attendTarget.ts`**

```ts
export interface AttendLookup {
  parentOf(id: number): number | undefined;
  terminalOf(id: number): string | undefined;
  isBrowser: boolean;
}

export type AttendTarget =
  | { kind: 'console'; rootId: number; terminalId: string }
  | { kind: 'screen'; id: number }
  | { kind: 'focus'; id: number };

/** Where answering an agent that waits on the user happens: the console of
 *  its root (office sessions — sub-agents are reached through their root), else
 *  its screen in the browser (where it can be brought to the office), else its
 *  VS Code terminal. */
export function resolveAttendTarget(id: number, lookup: AttendLookup): AttendTarget {
  let root = id;
  const seen = new Set<number>([id]);
  for (let p = lookup.parentOf(id); p !== undefined && !seen.has(p); p = lookup.parentOf(p)) {
    seen.add(p);
    root = p;
  }
  const terminalId = lookup.terminalOf(root);
  if (terminalId) return { kind: 'console', rootId: root, terminalId };
  return lookup.isBrowser ? { kind: 'screen', id: root } : { kind: 'focus', id: root };
}
```

- [ ] **Step 4: Verificar** — PASS (4).

- [ ] **Step 5: Cableado**
  1. `useExtensionMessages.ts`: crear un `AttentionTracker` (ref, una vez); en el `handler` de mensajes, antes del `switch` existente, `if (tracker.apply(msg)) setAttention(tracker.list());`. Exponer `attention` en el objeto devuelto. En `existingAgents` (reconexión) no hay estado de atención previo que restaurar: el servidor reenvía permiso/espera en `resendAgentActivity`, y el tracker los procesa igual.
  2. `App.tsx`: `useEffect(() => { document.title = attentionTitle(attention.length); }, [attention.length]);` (solo en navegador: `if (isBrowserRuntime)`). `handleAttend(id)`: `resolveAttendTarget(id, { parentOf: (x) => livingOffice.directory.get(x)?.parentAgentId ?? os.subagentMeta.get(x)?.parentAgentId, terminalOf: (x) => os.characters.get(x)?.terminalId, isBrowser: isBrowserRuntime })` → `console`: `setConsoleTerminal({ id: terminalId, title: \`Agente #${rootId}\` })`; `screen`: `setScreenAgentId(id)`; `focus`: `transport.send({ type: 'focusAgent', id })`.
  3. `AttentionBar.tsx`: botón `Te esperan (n)` (oculto con n = 0) en la barra inferior; al pulsar, lista con una fila por entrada: nombre del agente (usar la etiqueta que ya muestra el overlay/directorio: `directory.get(id)` label/role o `Agente #id`), motivo con icono (`permission` ⚠ "Permiso", `question` ? "Pregunta", `waiting` … "Espera tu respuesta") y hace cuánto (`Math.round((Date.now()-since)/60000)` min). Clic en fila → `onAttend(id)` y cierra la lista. `data-testid="attention-bar"` en el botón y `data-testid="attention-item"` en cada fila. Estilo: clases existentes (`pixel-panel`, `Button`, `Dropdown`/`DropdownItem` de `BottomToolbar`), sin colores inline.
  4. `BottomToolbar.tsx`: renderizar `<AttentionBar attention={attention} onAttend={onAttend} labelOf={labelOf} />`; se muestra en VS Code siempre y en navegador solo si `consoleCapable` (visor sin token no la ve).
  5. `DebugView.tsx`: su ✕ (≈ líneas 118-129) usa `closeClickStep` igual que `ToolOverlay` cuando el agente tiene `terminalId` (primer clic pide confirmación "¿Cerrar? Termina la sesión", segundo confirma); sin consola sigue siendo un clic.

- [ ] **Step 6: Verificar** — `npm run check-types && npx eslint webview-ui/src && npm run test:webview && npm run compile`.

- [ ] **Step 7: Commit** — `feat: Barra y contador de agentes que te esperan`

---

### Task 3: Retomar una sesión en una consola (`--resume`)

**Files:**

- Create: `server/src/terminals/sessionTranscript.ts`
- Modify: `core/src/provider.ts`, `server/src/providers/hook/claude/claude.ts`, `server/src/agentRuntime.ts`, `server/src/constants.ts`
- Test: `server/__tests__/sessionTranscript.test.ts`, `server/__tests__/officeAgentLaunch.test.ts` (añadir), `server/__tests__/claude.test.ts` (añadir)

**Interfaces:**

- Produces:
  - `buildLaunchCommand(sessionId, cwd, opts?: { bypassPermissions?: boolean; resume?: boolean })` — con `resume: true` los args son `['--resume', sessionId]` (+ bypass).
  - `readSessionCwd(jsonlFile: string): string | undefined` — último `cwd` string de los últimos `SESSION_TAIL_READ_BYTES` (64 KB) del archivo; `lstat` + solo archivo regular.
  - `readSessionTitle(jsonlFile: string): string | undefined` — primer mensaje de usuario de texto (string o bloque `text`) en los primeros `SESSION_HEAD_READ_BYTES` (64 KB), una línea, saneado con `sanitizeFeedText` (`server/src/feedDiff.ts`) y acotado a `SESSION_TITLE_MAX_CHARS` (120).
  - `findSessionTranscript(sessionId: string, roots: string[]): string | undefined` — busca `<root>/<projectDir>/<sessionId>.jsonl` (una sola profundidad); `undefined` si `!isSafeSessionId(sessionId)`.
  - `AgentRuntime.launchOfficeAgent(opts: { cwd?: string; bypassPermissions?: boolean; resumeSessionId?: string })`: con `resumeSessionId`, resuelve transcript y `cwd` con las funciones anteriores (el `cwd` del cliente se ignora), usa `resume: true`, y el agente usa **ese** session id y **ese** transcript (su `fileOffset` empieza al final del archivo, como un agente adoptado: `fs.statSync(jsonl).size`). Errores legibles: `Unknown session`, `Session folder no longer exists: <cwd>`, `Session is already open in the office` (si algún agente del store tiene ese `sessionId`: dos procesos no pueden llevar la misma sesión).
  - Constantes: `SESSION_TAIL_READ_BYTES = 64 * 1024`, `SESSION_HEAD_READ_BYTES = 64 * 1024`, `SESSION_TITLE_MAX_CHARS = 120`.

- [ ] **Step 1: Tests que fallan**

`server/__tests__/sessionTranscript.test.ts` (HOME no se toca: usa `fs.mkdtempSync(os.tmpdir())`):

```ts
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
```

En `server/__tests__/claude.test.ts`: `buildLaunchCommand('abc', '/w', { resume: true })` → `args` `['--resume', 'abc']`; con `bypassPermissions` también incluye `--dangerously-skip-permissions`.

En `server/__tests__/officeAgentLaunch.test.ts` (el harness ya aísla HOME con `testHome` y tiene `FakePty`): crear `<testHome>/.claude/projects/C--proj/<SID>.jsonl` con un registro `{ cwd: workDir }`, y:

- `launchOfficeAgent({ resumeSessionId: SID })` → spawn con `--resume` y `SID`, `cwd` = `realpathSync.native(workDir)`, agente con `sessionId === SID`, `jsonlFile` = ese archivo, `fileOffset` = tamaño del archivo.
- `resumeSessionId` desconocido → throw `/Unknown session/`, `store.size === 0`, ningún spawn.
- transcript cuyo `cwd` ya no existe → throw `/no longer exists/`.
- `resumeSessionId: '../x'` → throw `/Unknown session/` sin leer fuera (ningún spawn).
- con un agente ya en el store con ese `sessionId` → throw `/already open/`, ningún spawn.

- [ ] **Step 2: Verificar que fallan** — desde `server/`: `npx vitest run __tests__/sessionTranscript.test.ts __tests__/claude.test.ts __tests__/officeAgentLaunch.test.ts`.

- [ ] **Step 3: Implementación**
  - `core/src/provider.ts`: añadir `resume?: boolean` al tipo de `opts` de `buildLaunchCommand`, con doc: "continue that session (`claude --resume <id>`) instead of starting one with that id".
  - `claude.ts` `buildLaunchCommand`: `const args = opts?.resume ? ['--resume', sessionId] : ['--session-id', sessionId];`.
  - `sessionTranscript.ts`: lecturas con `fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))` tras `lstat().isFile()`; cola: leer los últimos N bytes, partir en líneas, recorrer de la última a la primera, `JSON.parse` en try, devolver el primer `cwd` string; cabeza: leer los primeros N bytes, líneas completas, primer `type: 'user'` cuyo `message.content` sea string o tenga un bloque `{ type: 'text', text }` (ignorar `tool_result`), `sanitizeFeedText`, colapsar espacios/saltos, `slice(0, SESSION_TITLE_MAX_CHARS)`. `findSessionTranscript`: `if (!isSafeSessionId(id)) return undefined;` por cada root, `readdirSync(root, { withFileTypes: true })` → directorios → `path.join(root, d.name, id + '.jsonl')` si `lstat` es archivo regular.
  - `agentRuntime.launchOfficeAgent`: al principio, si `opts.resumeSessionId`: `jsonl = findSessionTranscript(id, this.provider.getAllSessionRoots?.() ?? [])` → si no, `throw new Error('Unknown session')`; `cwd = readSessionCwd(jsonl)`; si no hay o no es directorio → `throw new Error(\`Session folder no longer exists: ${cwd ?? '(unknown)'}\`)`. Continuar el flujo existente con ese `cwd`, `sessionId = resumeSessionId`, `resume: true`, `jsonlFile = jsonl`, `projectDir = path.dirname(jsonl)`, `fileOffset = fs.statSync(jsonl).size`. Si no hay `resumeSessionId`, `cwd` es obligatorio (mismo error de hoy si falta).

- [ ] **Step 4: Verificar** — los tres archivos PASS; `npm run test:server`; `npm run check-types`.

- [ ] **Step 5: Commit** — `feat: Retomar una sesión en una consola de la oficina`

---

### Task 4: `MachineSessions` — proyectos y sesiones recientes de la máquina

**Files:**

- Create: `server/src/terminals/machineSessions.ts`
- Modify: `server/src/constants.ts`
- Test: `server/__tests__/machineSessions.test.ts`

**Interfaces:**

- Consumes: `readSessionCwd`, `readSessionTitle` (Task 3).
- Produces: `listMachineProjects(roots: string[], opts?: { max?: number }): Array<{ cwd: string; name: string; lastUsed: number }>` y `listRecentSessions(roots: string[], opts?: { max?: number; exclude?: ReadonlySet<string> }): Array<{ sessionId: string; cwd: string; name: string; lastUsed: number; title?: string }>`. Constantes `MACHINE_PROJECTS_MAX = 50`, `RECENT_SESSIONS_MAX = 20`.
  - Proyectos: por cada carpeta de cada root, el `*.jsonl` de nivel superior con mayor `mtime` → su `cwd` (`readSessionCwd`); solo si el `cwd` existe como directorio; `name = path.basename(cwd)`; dedupe por `cwd` (case-insensitive en win32); orden `lastUsed` desc; acotado.
  - Sesiones: todos los `*.jsonl` de nivel superior (nunca `subagents/`), orden `mtime` desc, se procesan solo los primeros `max * 2` (para saltar excluidos o sin cwd), excluye `exclude` (session ids con agente vivo), `sessionId = basename sin .jsonl` y `isSafeSessionId`; `title` con `readSessionTitle`.
  - Cache interna por `(file, mtimeMs)` para `cwd`/`title` (Map acotado a 500 entradas).

- [ ] **Step 1: Test que falla** — `server/__tests__/machineSessions.test.ts` con un root temporal: dos carpetas de proyecto con transcripts (uno viejo y uno nuevo por carpeta, `fs.utimesSync` para fijar mtimes), `cwd`s que existen (dirs temporales) y uno que no:
  - `listMachineProjects` devuelve un proyecto por carpeta, el `cwd` del transcript más nuevo, el más reciente primero, sin el de `cwd` inexistente, `name` = basename.
  - `listRecentSessions` devuelve sesiones ordenadas por mtime, respeta `exclude`, ignora `subagents/agent-*.jsonl`, trae `title`.
  - Acotado: con 30 transcripts y `max: 5` devuelve 5.

- [ ] **Step 2: Verificar que falla**, **Step 3: Implementar** según las interfaces, **Step 4: Verificar** (desde `server/`), `npm run check-types`.

- [ ] **Step 5: Commit** — `feat: Proyectos y sesiones recientes de la máquina`

---

### Task 5: Protocolo y handler — opciones de lanzamiento, retomar

**Files:**

- Modify: `core/asyncapi.yaml` (regenerar `core/src/messages.ts`), `server/src/clientMessageHandler.ts`, `webview-ui/src/hooks/useExtensionMessages.ts`, `webview-ui/src/components/LaunchDialog.tsx` (adaptación mínima), `webview-ui/src/App.tsx`, `CLAUDE.md` (conteos)
- Test: `server/__tests__/clientMessageHandler.test.ts` (añadir)

**Interfaces:**

- Protocolo:
  - `LaunchOptions` → `{ type, projects: MachineProject[], recentSessions: RecentSession[] }` (quita `defaultCwd`, `recentDirs`); esquemas `MachineProject { cwd: string, name: string, lastUsed: integer }` y `RecentSession { sessionId: string, cwd: string, name: string, lastUsed: integer, title?: string }` (componentes reutilizables, no mensajes).
  - `LaunchAgent` gana `resumeSessionId?: string`.
  - Nuevo cliente→servidor `RequestLaunchOptions { type }` (privilegiado).
- Handler:
  - `launchOptions` (en `webviewReady` cuando `terminals`, y en respuesta a `requestLaunchOptions`): `projects` = unión de `recentLaunchDirs` existentes (primero, como `{ cwd, name: basename, lastUsed: 0 }` si existen) y `listMachineProjects(roots)`, sin duplicados; `recentSessions = listRecentSessions(roots, { exclude: sesiones de agentes vivos en el store })`.
  - `launchAgent` con `resumeSessionId` string → `runtime.launchOfficeAgent({ resumeSessionId, bypassPermissions })` (ignora `folderPath`); sin él, igual que hoy (`folderPath` obligatorio en navegador: si falta, `launchResult { ok: false, error: 'Choose a folder' }` en vez de caer a `process.cwd()`, que en el servicio de Windows es `C:\`).
- Webview (mínimo para compilar; el diálogo completo es la Task 6): `launchOptions` guarda `{ projects, recentSessions }`; `LaunchDialog` recibe `projects` y usa `projects[0]?.cwd ?? ''` como valor inicial y `projects.map(p => p.cwd)` en el `datalist`.

- [ ] **Step 1: Tests que fallan** (en el describe `office consoles`, que ya aísla HOME y tiene runtime con pty falso): con transcripts sintéticos en `<testHome>/.claude/projects/...`:
  - `webviewReady` privilegiado → `launchOptions.projects` incluye el `cwd` del transcript; `recentSessions` incluye su sessionId con `title`.
  - `requestLaunchOptions` privilegiado → responde `launchOptions`; de un visor → nada (gate central).
  - `launchAgent { resumeSessionId }` → `launchResult ok` y el spawn lleva `--resume <id>`.
  - `launchAgent {}` sin `folderPath` → `ok: false` "Choose a folder".
  - `recentSessions` excluye una sesión con agente vivo en el store.

- [ ] **Step 2-4:** yaml (`required` y tipos exactos arriba; `additionalProperties: false`), `npm run asyncapi:validate && npm run asyncapi:generate`, handler, webview mínimo, CLAUDE.md conteos (Server +0, Client +1 → 32), tests PASS, `npm run test:server`, `npm run test:webview`, `npm run compile`.

- [ ] **Step 5: Commit** — `feat: Opciones de lanzamiento de toda la máquina y retomar sesiones`

---

### Task 6: Diálogo de lanzar — Proyectos y Sesiones recientes

**Files:**

- Modify: `webview-ui/src/components/LaunchDialog.tsx`, `webview-ui/src/App.tsx`
- Create: `webview-ui/src/console/launchFilter.ts`
- Test: `webview-ui/test/launchFilter.test.ts`

**Interfaces:**

- Produces: `filterProjects(projects, query): MachineProject[]` (coincidencia sin mayúsculas/acentos en `name` o `cwd`, conserva el orden) y `timeAgo(lastUsed: number, now: number): string` ("hace 5 min", "hace 3 h", "hace 2 d", "" si `lastUsed` es 0).
- Diálogo:
  - Al abrir envía `requestLaunchOptions` y usa la respuesta (lista siempre fresca).
  - Pestaña **Proyectos**: buscador (`data-testid="launch-search"`), lista filtrada (`data-testid="launch-project"`, clic la elige y rellena el campo), campo de ruta libre (`data-testid="launch-cwd"`, se mantiene), "Saltar permisos", **Lanzar** → `launchAgent { folderPath, bypassPermissions }`.
  - Pestaña **Sesiones recientes**: filas (`data-testid="launch-session"`) con título (o "(sin título)"), `name` del proyecto y `timeAgo`; botón **Retomar** → `launchAgent { resumeSessionId, bypassPermissions }`.
  - `launchResult` como hoy (abre la consola / muestra error). Cancelar durante un lanzamiento en curso ya no descarta el resultado: el diálogo se cierra pero `App` sigue escuchando `launchResult` y abre la consola (mover la escucha de `launchResult` a `App`/`useExtensionMessages`).

- [ ] **Step 1:** test de `filterProjects`/`timeAgo` (casos: acentos "Álvaro" vs "alvaro", vacío devuelve todo, `timeAgo(0)` = ""), FAIL → implementar → PASS.
- [ ] **Step 2:** diálogo y `App` según arriba; estilos existentes (pestañas con `Button` variante activa), sin colores inline.
- [ ] **Step 3:** `npm run check-types && npx eslint webview-ui/src && npm run test:webview && npm run compile`.
- [ ] **Step 4: Commit** — `feat: Elegir proyecto o retomar sesión al lanzar desde la oficina`

---

### Task 7: Traer a la oficina — servidor

**Files:**

- Modify: `core/asyncapi.yaml` (+ regenerar), `server/src/agentRuntime.ts`, `server/src/clientMessageHandler.ts`, `CLAUDE.md` (conteos)
- Test: `server/__tests__/takeover.test.ts` (nuevo), `server/__tests__/clientMessageHandler.test.ts` (añadir)

**Interfaces:**

- Protocolo:
  - Cliente: `TakeOverAgent { type, id: integer, confirmClosed?: boolean }`, `CancelTakeover { type, id: integer }` (privilegiados).
  - Servidor: `TakeoverStatus { type, id: integer, state: 'waitingExit' | 'done' | 'cancelled' | 'refused' | 'failed', reason?: string, terminalId?: string }` — se **difunde** (`store.broadcast`) porque el estado del personaje lo ven todas las pestañas del operador; como `reason` puede nombrar rutas, el `httpServer` lo filtra para visores igual que `agentConversation`: a un visor solo le llegan `type, id, state`. (Añadir `TAKEOVER_VIEWER_FIELDS` junto a `conversationForViewer` en `server/src/agentMessages.ts` y usarlo en `onBroadcast`.)
- Runtime:
  - `requestTakeover(id: number, opts?: { confirmClosed?: boolean }): void`
    - rechaza (`refused` con `reason`): no existe; tiene `terminalId`; es derivado (`parentAgentId !== undefined` o `leadAgentId !== undefined`); sin `ptyHost`; sin `cwd` (`readSessionCwd(agent.jsonlFile)`).
    - `confirmClosed` → retoma ya (`resumeAgentInConsole`).
    - si no, marca `pendingTakeover` (Set de ids) y difunde `waitingExit`.
  - `cancelTakeover(id)`: quita la marca, difunde `cancelled`.
  - `onSessionEnd(agentId)` (callback existente de `HookEventHandler`): si `pendingTakeover.has(agentId)` → hacer la limpieza de spawns que ya hace (forgetSpawns/leaveSubtree/removeTeammates/clearSpawns) **sin** `dismiss`/`unregisterAgent`/`removeAgent`, y llamar `resumeAgentInConsole(agentId)`. Los `SessionEnd` con razón `clear`/`resume` ya solo llegan a `onSessionEnd` si no hubo `SessionStart` detrás (sesión realmente terminada), así que no requieren caso especial; si hubo `/clear`, el agente ya fue reasignado a la nueva sesión (`agent.sessionId` actual) y la marca se conserva por id.
  - `resumeAgentInConsole(agentId)` (privado): `cwd = readSessionCwd(agent.jsonlFile)` canonicalizado; `buildLaunchCommand(agent.sessionId, cwd, { resume: true })`; `ptyHost.open` (entorno saneado como `launchOfficeAgent`, reutilizar el helper existente); `agent.terminalId = terminalId; agent.isExternal = false; agentByTerminal.set(...)`; asegurar `registerAgent(agent.sessionId, agentId)`; quitar la marca; difundir `takeoverStatus { id, state: 'done', terminalId }` (el filtro de visores le quita `terminalId`). Las reconexiones lo reciben por `agentCreated`/`existingAgents`, que ya incluyen `agent.terminalId` para privilegiados. Errores → `failed` con `reason`, se quita la marca y el agente sale como un `SessionEnd` normal (`removeAgent`).
  - Si el agente desaparece por otra vía (`removeAgent`), borrar su marca.
- Handler: `takeOverAgent` → `runtime.requestTakeover(msg.id, { confirmClosed: msg.confirmClosed === true })` (valida `id` entero); `cancelTakeover` → `runtime.cancelTakeover(msg.id)`.

- [ ] **Step 1: Tests que fallan** — `server/__tests__/takeover.test.ts` (harness como `officeAgentLaunch.test.ts`: HOME aislado, `FakePty`, runtime real con `claudeProvider`). Crear un agente externo raíz en el store con `jsonlFile` real (transcript con `cwd` = dir temporal) registrado por `runtime.registerAgent(sessionId, id)`; capturar difusiones con `store.on('broadcast')`:
  - `requestTakeover(id)` → difunde `waitingExit`; ningún spawn.
  - `runtime.handleHookEvent('claude', { hook_event_name: 'SessionEnd', session_id, reason: 'prompt_input_exit' })` → spawn con `--resume <sessionId>` en el `cwd`; el **mismo** agente (`store.get(id)`) tiene `terminalId` e `isExternal === false`; difunde `done` con ese `terminalId`; el agente no se retiró.
  - Sin marca, el mismo `SessionEnd` retira al agente como hoy.
  - `confirmClosed: true` → spawn inmediato.
  - Rechazos: agente derivado, agente con `terminalId`, sin pty host, transcript sin `cwd`.
  - `cancelTakeover` → `cancelled`, y un `SessionEnd` posterior retira al agente.
  - Fallo del spawn (factory que lanza) → `failed` y el agente se retira.
  - En `clientMessageHandler.test.ts`: un visor no puede `takeOverAgent`/`cancelTakeover` (nada cambia, nada se envía); el filtro de visor de `takeoverStatus` quita `reason` y `terminalId` (test en `httpServerWs.test.ts` siguiendo el de `agentConversation`).

- [ ] **Step 2-4:** protocolo + regenerar + conteos (Server +1 → 43, Client +2 → 34), runtime, handler, filtro; tests PASS; `npm run test:server`; `npm run check-types`; `npm run compile`.

- [ ] **Step 5: Commit** — `feat: Traer a la oficina un agente de otra terminal`

---

### Task 8: Traer a la oficina — interfaz

**Files:**

- Modify: `webview-ui/src/office/components/ToolOverlay.tsx`, `webview-ui/src/components/AgentScreenModal.tsx`, `webview-ui/src/hooks/useExtensionMessages.ts`, `webview-ui/src/App.tsx`, `webview-ui/src/office/types.ts` (si hace falta estado en `Character`)
- Create: `webview-ui/src/console/takeoverState.ts`
- Test: `webview-ui/test/takeoverState.test.ts`

**Interfaces:**

- `takeoverState.ts`: reducer puro `applyTakeover(state: Map<number, TakeoverView>, msg): Map` con `TakeoverView = { state: 'waitingExit' | 'failed' | 'refused'; reason?: string }` — `waitingExit` lo pone, `done`/`cancelled` lo quitan, `failed`/`refused` lo ponen (se muestran hasta que el usuario los descarte o cambie el agente), `agentClosed` lo quita.
- Botón **Traer a la oficina** (`data-testid="takeover"`): en el overlay del personaje seleccionado y en la cabecera de `AgentScreenModal`, solo si el agente es raíz, no tiene `terminalId`, y `consoleCapable`.
- Con `waitingExit`: el botón pasa a mostrar "Esperando que la cierres…" con el texto de ayuda _"Escribe `/exit` en su terminal; la retomo aquí."_ y dos acciones: **Ya la cerré** (confirmación en dos pasos con el aviso _"Si sigue abierta en su terminal, las dos se pisarán."_, reutilizar el patrón de `closeConfirm`) → `takeOverAgent { id, confirmClosed: true }`; **Cancelar** → `cancelTakeover { id }`.
- `done` con `terminalId`: guardar `terminalId` en el personaje (`os.setTerminalId`) y abrir la consola (`setConsoleTerminal({ id: terminalId, title: \`Agente #${id}\` })`), cerrando la pantalla del agente si estaba abierta.
- `failed`/`refused`: mostrar `reason` en el overlay/pantalla con botón para descartar.

- [ ] **Step 1:** test del reducer, FAIL → implementar → PASS.
- [ ] **Step 2:** UI según arriba (estilos existentes, sin colores inline).
- [ ] **Step 3:** `npm run check-types && npx eslint webview-ui/src && npm run test:webview && npm run compile`.
- [ ] **Step 4: Commit** — `feat: Botón para traer un agente a la oficina`

---

### Task 9: E2E

**Files:**

- Create: `e2e/tests/standalone/interactive.spec.ts`
- Modify: `e2e/fixtures/mock-claude-runner.cjs` (si hace falta: registrar `--resume <id>` en el log de invocaciones — ya registra `args`), `e2e/helpers/standalone.ts` (si hace falta)
- Regenerate: `e2e/README.md`

Escenarios (todos con `launchStandalone(page, { mockClaudeConsoles: true })`, HOME aislado, nunca el `claude` real):

1. **Te esperan**: una sesión externa mock con hooks (`spawnExternalClaudeScenario` con `sessionStartStartup` + `preToolUseBash` + `permissionRequest`, como en `e2e/tests/claude/hooks-on/basic.spec.ts` y `e2e/tests/standalone/hooks.spec.ts`) → `attention-bar` muestra `1` y `page.title()` empieza por `(1)`; clic en el item abre su pantalla (externo) — y tras `stop`/`PostToolUse` la barra vuelve a 0.
2. **Retomar**: sembrar en el HOME aislado `~/.claude/projects/<dir>/<uuid>.jsonl` con un registro `{ type: 'user', cwd: <workspaceDir>, message: { content: 'Arregla el login' } }` → abrir el diálogo → pestaña Sesiones recientes muestra "Arregla el login" → **Retomar** → se abre la consola (`mock-claude listo`) y el log de invocaciones del mock contiene `--resume <uuid>`.
3. **Traer a la oficina**: sesión externa mock con hooks que registra `SessionStart` y un `PreToolUse` (queda viva con `holdOpenFor`) → seleccionar su personaje → `takeover` → estado "Esperando…" → el test envía el hook `SessionEnd` (reason `prompt_input_exit`) por `sendHookEvent` → aparece la consola del **mismo** personaje (`mock-claude listo`) y el log del mock tiene `--resume <sessionId>`.

- [ ] **Step 1:** escribir los tres tests; `npm run compile`; `npm run e2e -- --workers=1 --retries=0 e2e/tests/standalone/interactive.spec.ts` → verde.
- [ ] **Step 2:** demostrar rojo del 3: comentar temporalmente la llamada a `resumeAgentInConsole` en `onSessionEnd`, recompilar, ver fallar, restaurar, recompilar, `git diff` limpio de ese archivo.
- [ ] **Step 3:** `npm run e2e -- --workers=1 e2e/tests/standalone` completo y `npm run e2e:inventory`.
- [ ] **Step 4: Commit** — `test(e2e): Te esperan, retomar y traer a la oficina`

---

### Task 10: Documentación

**Files:**

- Create: `docs/adr/0005-bringing-a-session-to-the-office.md`
- Modify: `CONTEXT.md`, `CLAUDE.md`, `docs/pendientes-y-roadmap.md` (no se commitea: es un archivo sin trackear del usuario)

- ADR 0005 (en inglés, estilo de 0003/0004): contexto (la oficina no posee procesos ajenos; dos procesos no pueden llevar una sesión); decisión (traer = esperar `SessionEnd` y retomar con `claude --resume <id>` en el mismo agente; confirmación explícita para sesiones sin hooks; nunca matar un proceso ajeno; `--resume` conserva el id, verificado en CLI 2.1.284); consecuencias (sub-agentes se atienden por su raíz; retomar también recupera consolas tras reiniciar; el puente de permisos sigue siendo la opción para no mover la sesión).
- `CONTEXT.md`, bajo "Agent Lifecycle": **Bring to the office** (_Avoid_: takeover, adopt — adopt ya significa otra cosa), **Waiting on you** ("Te esperan"; motivos: permiso, pregunta, espera tu respuesta), **Recent session**.
- `CLAUDE.md`: en el párrafo de consolas, añadir `requestLaunchOptions`, `takeOverAgent`, `cancelTakeover` (privilegiados), `launchAgent.resumeSessionId` (id validado, cwd del transcript), `takeoverStatus` filtrado para visores; `server/src/terminals/{sessionTranscript,machineSessions}.ts`.
- Commit — `docs: ADR y glosario de traer a la oficina y te esperan`
