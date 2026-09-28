# Consolas en la oficina — Fase 1 (consola real y lanzar) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Desde el navegador (standalone), lanzar una sesión de Claude Code en una pseudo-terminal que posee el servidor y usarla como la consola real (escribir, permisos, preguntas, `/comandos`) en un modal con xterm.js; al cerrar el navegador la sesión sigue viva y se reengancha.

**Architecture:** `PtyHost` (servidor) crea pseudo-terminales con `node-pty` inyectado y guarda un búfer circular por terminal. `TerminalHub` reparte la salida punto a punto a las conexiones enganchadas (patrón de `AgentFeedHub`). `AgentRuntime.launchOfficeAgent` crea el agente interno con `terminalId` y lo engancha al watcher como hace VS Code. La webview abre un `ConsoleModal` (xterm.js) al hacer clic en un agente con `terminalId`, y un `LaunchDialog` reemplaza al "+ Agent" oculto en modo navegador.

**Tech Stack:** TypeScript, Fastify + `@fastify/websocket`, `node-pty` 1.1.0, React 19, `@xterm/xterm` 6 + `@xterm/addon-fit`, Vitest, Playwright, AsyncAPI 3.0 + Modelina.

**Spec:** `docs/superpowers/specs/2026-09-28-office-terminals-design.md` (esta es la Fase 1 de su §5; la sala por sesión, la pizarra, el puente de permisos y "te esperan" son planes posteriores).

## Global Constraints

- Solo standalone (`server/src/cli.ts`); la extensión de VS Code no cambia de comportamiento.
- Todo mensaje nuevo cliente→servidor es **privilegiado**: no entra en `VIEWER_MESSAGES` de `server/src/clientMessageHandler.ts`.
- La salida de una terminal **nunca** pasa por `store.broadcast`: solo punto a punto a conexiones con token enganchadas.
- Consolas y lanzamiento solo con el servidor en loopback (`127.0.0.1`, `::1`, `localhost`); con otro `--host`, `providerCapabilities.terminals = false` y los mensajes se rechazan.
- `node-pty` que no carga no impide arrancar el servidor: `terminals = false`.
- Constantes nuevas en `server/src/constants.ts` / `webview-ui/src/constants.ts` (política de constantes del repo); colores solo en `webview-ui/src/constants.ts` (lint `no-inline-colors`), sombra `var(--pixel-shadow)`, fuente FS Pixel Sans.
- Imports relativos con `.js` en server; `import type` para tipos; sin `enum`.
- Vitest del server siempre desde `server/` (las scripts npm lo hacen): aísla HOME.
- Nunca correr el CLI de la rama contra el HOME real; en e2e el servidor lanza **mock-claude**, nunca el `claude` real.
- Commits en español, formato `tipo: Descripción`, con `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; rama `feature/agent-tree-scope-offices`; sin push salvo que el usuario lo pida.

## Review Focus

1. **Carpeta con espacios o caracteres especiales en Windows** (`C:\Mis Proyectos\app`): `claude` debe arrancar en esa carpeta (el `cwd` va por la opción `cwd` de la pty, nunca concatenado a una línea de comandos) — test en Task 4.
2. **Ráfaga de salida enorme** (un `cat` de un archivo grande): el búfer queda acotado y la salida se agrupa en mensajes (no uno por chunk) — tests en Task 3 (búfer) y Task 6 (coalescencia).
3. **Mensaje de terminal de un cliente que no se enganchó, con un `terminalId` inexistente o de un visor**: no hace nada y no filtra salida — tests en Task 6.
4. **Detener el servidor con consolas vivas**: todas las pty se matan (sin procesos `claude` huérfanos) — test en Task 3 y cableado en Task 7.
5. **Snapshot al reengancharse tras recortar el búfer**: empieza en un límite de línea, no a mitad de una secuencia de escape — test en Task 3.

---

## File Structure

| Archivo                                                                                                            | Responsabilidad                                                                |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `server/src/terminals/ptyTypes.ts` (nuevo)                                                                         | Interfaces `PtyProcess`, `PtyFactory` (lo que usamos de node-pty)              |
| `server/src/terminals/ringBuffer.ts` (nuevo)                                                                       | Búfer circular de texto acotado, recorte en límite de línea                    |
| `server/src/terminals/ptyHost.ts` (nuevo)                                                                          | Ciclo de vida de pseudo-terminales, límites, eventos                           |
| `server/src/terminals/launchCommand.ts` (nuevo)                                                                    | `[file, args]` para lanzar claude por plataforma + override de e2e             |
| `server/src/terminals/terminalHub.ts` (nuevo)                                                                      | Suscripciones por conexión, snapshot + salida agrupada punto a punto           |
| `server/src/terminals/loadNodePty.ts` (nuevo)                                                                      | Carga opcional de `node-pty` → `PtyFactory \| null`                            |
| `server/src/agentRuntime.ts`                                                                                       | `launchOfficeAgent`, `ptyHost`, `terminalHub`, fin de terminal → cerrar agente |
| `server/src/clientMessageHandler.ts`                                                                               | `launchAgent` y `terminal*` (privilegiados), `launchOptions` en webviewReady   |
| `server/src/httpServer.ts`                                                                                         | Liberar suscripciones de terminal al cerrar el socket                          |
| `server/src/cli.ts`                                                                                                | Crear `PtyHost` si hay node-pty y loopback; matar todo al salir                |
| `server/src/configPersistence.ts`                                                                                  | `recentLaunchDirs` (acotado)                                                   |
| `server/src/types.ts`                                                                                              | `AgentState.terminalId?`                                                       |
| `server/src/agentMessages.ts`                                                                                      | `terminalId` en `agentCreated` / `agentMeta` (solo privilegiados)              |
| `core/asyncapi.yaml` → `core/src/messages.ts`                                                                      | Mensajes nuevos                                                                |
| `webview-ui/src/console/consoleRouting.ts` (nuevo)                                                                 | Filtro puro de mensajes de una terminal                                        |
| `webview-ui/src/components/ConsoleModal.tsx` (nuevo)                                                               | xterm.js + attach/input/resize                                                 |
| `webview-ui/src/components/LaunchDialog.tsx` (nuevo)                                                               | Carpeta + saltar permisos + lanzar                                             |
| `webview-ui/src/components/BottomToolbar.tsx`, `App.tsx`, `hooks/useExtensionMessages.ts`                          | Cableado                                                                       |
| `e2e/fixtures/mock-claude-runner.cjs`, `e2e/helpers/standalone.ts`, `e2e/tests/standalone/console.spec.ts` (nuevo) | E2E                                                                            |

---

### Task 1: Dependencias y empaquetado

**Files:**

- Modify: `package.json` (dependencies), `esbuild.js:141`, `webview-ui/package.json`

**Interfaces:**

- Produces: `node-pty` resoluble en runtime por `dist/cli.js`; `@xterm/xterm` y `@xterm/addon-fit` importables en la webview.

- [ ] **Step 1: Añadir dependencias**

```bash
npm install node-pty@1.1.0 --save
npm install @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 --workspace webview-ui --save
```

- [ ] **Step 2: Marcar `node-pty` como externa del bundle del CLI**

En `esbuild.js`, la línea del bundle del CLI:

```js
    external: ['fastify', '@fastify/websocket', '@fastify/static', '@fastify/cors', 'node-pty'],
```

- [ ] **Step 3: Verificar que compila y que el CLI no incrusta node-pty**

Run: `npm run compile && grep -c "node-pty" dist/cli.js`
Expected: compile exit 0; el grep cuenta ≥1 solo por `require("node-pty")` (no el código de la librería). Todavía nadie lo importa, así que puede ser 0; lo importante es exit 0.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json esbuild.js webview-ui/package.json
git commit -m "chore: Añadir node-pty y xterm para las consolas de la oficina"
```

---

### Task 2: Protocolo (AsyncAPI)

**Files:**

- Modify: `core/asyncapi.yaml`
- Regenerate: `core/src/messages.ts` (no editar a mano)

**Interfaces:**

- Produces (generados en `core/src/messages.ts`): `TerminalAttach`, `TerminalDetach`, `TerminalInput`, `TerminalResize`, `TerminalClose` (cliente), `TerminalSnapshot`, `TerminalOutput`, `TerminalExit`, `LaunchResult`, `LaunchOptions` (servidor); `ProviderCapabilities.terminals?: boolean`; `AgentCreated.terminalId?: string`; `AgentSeatMeta.terminalId?: string`.

- [ ] **Step 1: Añadir a las uniones**

En `ServerMessage.oneOf`, tras `AgentConversation`:

```yaml
# Office consoles (point-to-point, privileged connections only)
- $ref: '#/components/schemas/TerminalSnapshot'
- $ref: '#/components/schemas/TerminalOutput'
- $ref: '#/components/schemas/TerminalExit'
- $ref: '#/components/schemas/LaunchResult'
- $ref: '#/components/schemas/LaunchOptions'
```

En `ClientMessage.oneOf`, tras `SetLoungeToLeaveMinutes`:

```yaml
- $ref: '#/components/schemas/TerminalAttach'
- $ref: '#/components/schemas/TerminalDetach'
- $ref: '#/components/schemas/TerminalInput'
- $ref: '#/components/schemas/TerminalResize'
- $ref: '#/components/schemas/TerminalClose'
```

- [ ] **Step 2: Campo `terminals` en `ProviderCapabilities`**

Dentro de `ProviderCapabilities.properties`:

```yaml
terminals:
  type: boolean
  description: >-
    True when this connection may launch agents and use office consoles
    (privileged, standalone, loopback bind, node-pty loaded).
```

- [ ] **Step 3: `terminalId` en `AgentCreated` y `AgentSeatMeta`**

En `AgentCreated.properties` y en `AgentSeatMeta.properties`:

```yaml
terminalId:
  type: string
  description: Office console of this agent. Sent only to privileged connections.
```

- [ ] **Step 4: Esquemas nuevos** (junto a los de feed, antes de los mensajes de cliente)

```yaml
TerminalSnapshot:
  description: Buffered output of an office console, sent point-to-point on terminalAttach.
  type: object
  additionalProperties: false
  required: [type, terminalId, data, exited]
  properties:
    type:
      const: terminalSnapshot
    terminalId:
      type: string
    data:
      type: string
    exited:
      type: boolean

TerminalOutput:
  description: New output of an attached office console (point-to-point, coalesced).
  type: object
  additionalProperties: false
  required: [type, terminalId, data]
  properties:
    type:
      const: terminalOutput
    terminalId:
      type: string
    data:
      type: string

TerminalExit:
  description: The console's process ended.
  type: object
  additionalProperties: false
  required: [type, terminalId, exitCode]
  properties:
    type:
      const: terminalExit
    terminalId:
      type: string
    exitCode:
      type: integer

LaunchResult:
  description: Reply to launchAgent (point-to-point).
  type: object
  additionalProperties: false
  required: [type, ok]
  properties:
    type:
      const: launchResult
    ok:
      type: boolean
    agentId:
      type: integer
    terminalId:
      type: string
    error:
      type: string

LaunchOptions:
  description: Defaults for the launch dialog (privileged connections only).
  type: object
  additionalProperties: false
  required: [type, defaultCwd, recentDirs]
  properties:
    type:
      const: launchOptions
    defaultCwd:
      type: string
    recentDirs:
      type: array
      items:
        type: string
```

Mensajes de cliente (junto a `SubscribeAgentFeed`):

```yaml
TerminalAttach:
  description: Receive an office console's snapshot and live output (privileged).
  type: object
  additionalProperties: false
  required: [type, terminalId]
  properties:
    type:
      const: terminalAttach
    terminalId:
      type: string

TerminalDetach:
  description: Stop receiving an office console's output.
  type: object
  additionalProperties: false
  required: [type, terminalId]
  properties:
    type:
      const: terminalDetach
    terminalId:
      type: string

TerminalInput:
  description: Keystrokes for an attached office console (privileged).
  type: object
  additionalProperties: false
  required: [type, terminalId, data]
  properties:
    type:
      const: terminalInput
    terminalId:
      type: string
    data:
      type: string

TerminalResize:
  description: New size of an attached office console (privileged).
  type: object
  additionalProperties: false
  required: [type, terminalId, cols, rows]
  properties:
    type:
      const: terminalResize
    terminalId:
      type: string
    cols:
      type: integer
    rows:
      type: integer

TerminalClose:
  description: Kill an office console and its agent (privileged).
  type: object
  additionalProperties: false
  required: [type, terminalId]
  properties:
    type:
      const: terminalClose
    terminalId:
      type: string
```

Y actualizar la descripción de `LaunchAgent`: `description: Launch a new Claude agent (VS Code: in a terminal; standalone: in an office console, folderPath = its working directory).`

- [ ] **Step 5: Validar, regenerar y comprobar tipos**

Run: `npm run asyncapi:validate && npm run asyncapi:generate && npm run check-types`
Expected: validación OK (la nota informativa de 3.1.0 es esperada), `core/src/messages.ts` con las interfaces nuevas, check-types exit 0.

- [ ] **Step 6: Actualizar el conteo de variantes en CLAUDE.md**

En la sección "AsyncAPI Protocol Contract": `37 ServerMessage variants` → `42`, `26 ClientMessage variants` → `31`.

- [ ] **Step 7: Commit**

```bash
git add core/asyncapi.yaml core/src/messages.ts CLAUDE.md
git commit -m "feat: Protocolo de consolas de la oficina"
```

---

### Task 3: Búfer circular y `PtyHost`

**Files:**

- Create: `server/src/terminals/ptyTypes.ts`, `server/src/terminals/ringBuffer.ts`, `server/src/terminals/ptyHost.ts`
- Modify: `server/src/constants.ts`
- Test: `server/__tests__/ptyHost.test.ts`

**Interfaces:**

- Produces:
  - `interface PtyProcess { onData(cb: (d: string) => void): { dispose(): void }; onExit(cb: (e: { exitCode: number }) => void): { dispose(): void }; write(d: string): void; resize(cols: number, rows: number): void; kill(): void; readonly pid: number }`
  - `type PtyFactory = (file: string, args: string[], opts: { cwd: string; cols: number; rows: number; env: Record<string, string> }) => PtyProcess`
  - `class RingBuffer { constructor(maxChars: number); append(s: string): void; read(): string }`
  - `class PtyHost { constructor(factory: PtyFactory, opts?: { maxTerminals?: number; bufferChars?: number }); open(spec: { file: string; args: string[]; cwd: string; env: Record<string, string>; cols?: number; rows?: number }): string /* terminalId */; has(id: string): boolean; snapshot(id: string): { data: string; exited: boolean } | undefined; write(id: string, data: string): boolean; resize(id: string, cols: number, rows: number): boolean; close(id: string): boolean; closeAll(): void; onOutput(cb: (id: string, data: string) => void): () => void; onExit(cb: (id: string, exitCode: number) => void): () => void; readonly size: number }`
  - Constantes: `MAX_OFFICE_TERMINALS = 8`, `TERMINAL_BUFFER_CHARS = 256 * 1024`, `TERMINAL_DEFAULT_COLS = 120`, `TERMINAL_DEFAULT_ROWS = 32`, `TERMINAL_MAX_COLS = 500`, `TERMINAL_MAX_ROWS = 200`.

- [ ] **Step 1: Constantes**

Al final de `server/src/constants.ts`:

```ts
// ── Office consoles (docs/superpowers/specs/2026-09-28-office-terminals-design.md) ──
/** Live office consoles at once; a launch past this is refused. */
export const MAX_OFFICE_TERMINALS = 8;
/** Output kept per console for re-attaching (UTF-16 chars). */
export const TERMINAL_BUFFER_CHARS = 256 * 1024;
export const TERMINAL_DEFAULT_COLS = 120;
export const TERMINAL_DEFAULT_ROWS = 32;
/** A resize past these is clamped: a client cannot ask for a giant screen. */
export const TERMINAL_MAX_COLS = 500;
export const TERMINAL_MAX_ROWS = 200;
```

- [ ] **Step 2: Test que falla**

`server/__tests__/ptyHost.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { RingBuffer } from '../src/terminals/ringBuffer.js';
import { PtyHost } from '../src/terminals/ptyHost.js';
import type { PtyFactory, PtyProcess } from '../src/terminals/ptyTypes.js';

class FakePty implements PtyProcess {
  readonly pid = 4242;
  written: string[] = [];
  size = { cols: 0, rows: 0 };
  killed = false;
  private dataCbs: Array<(d: string) => void> = [];
  private exitCbs: Array<(e: { exitCode: number }) => void> = [];
  onData(cb: (d: string) => void) {
    this.dataCbs.push(cb);
    return { dispose: () => (this.dataCbs = this.dataCbs.filter((c) => c !== cb)) };
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb);
    return { dispose: () => (this.exitCbs = this.exitCbs.filter((c) => c !== cb)) };
  }
  write(d: string) {
    this.written.push(d);
  }
  resize(cols: number, rows: number) {
    this.size = { cols, rows };
  }
  kill() {
    this.killed = true;
    this.emitExit(1);
  }
  emit(d: string) {
    for (const cb of this.dataCbs) cb(d);
  }
  emitExit(exitCode: number) {
    for (const cb of this.exitCbs) cb({ exitCode });
  }
}

function host(opts?: { maxTerminals?: number; bufferChars?: number }) {
  const ptys: FakePty[] = [];
  const spawned: Array<{ file: string; args: string[]; cwd: string }> = [];
  const factory: PtyFactory = (file, args, o) => {
    spawned.push({ file, args, cwd: o.cwd });
    const p = new FakePty();
    ptys.push(p);
    return p;
  };
  return { h: new PtyHost(factory, opts), ptys, spawned };
}

const SPEC = { file: 'claude', args: ['--session-id', 'x'], cwd: '/tmp/w', env: {} };

describe('RingBuffer', () => {
  it('keeps everything under the cap', () => {
    const b = new RingBuffer(100);
    b.append('a\n');
    b.append('b\n');
    expect(b.read()).toBe('a\nb\n');
  });

  it('past the cap drops the oldest text and restarts at a line boundary', () => {
    const b = new RingBuffer(10);
    b.append('\u001b[31mred line\n');
    b.append('ok\n');
    // Never starts mid-line (a cut escape sequence would garble xterm).
    expect(b.read()).toBe('ok\n');
    expect(b.read().length).toBeLessThanOrEqual(10);
  });

  it('a single line longer than the cap keeps only its tail', () => {
    const b = new RingBuffer(5);
    b.append('abcdefghij');
    expect(b.read()).toBe('fghij');
  });
});

describe('PtyHost', () => {
  it('opens a console in the requested cwd and buffers its output', () => {
    const { h, ptys, spawned } = host();
    const id = h.open(SPEC);
    expect(spawned[0]).toEqual({ file: 'claude', args: ['--session-id', 'x'], cwd: '/tmp/w' });
    ptys[0].emit('hola\n');
    expect(h.snapshot(id)).toEqual({ data: 'hola\n', exited: false });
  });

  it('forwards output and exit to listeners', () => {
    const { h, ptys } = host();
    const out: string[] = [];
    const exits: number[] = [];
    h.onOutput((_id, d) => out.push(d));
    h.onExit((_id, code) => exits.push(code));
    h.open(SPEC);
    ptys[0].emit('x');
    ptys[0].emitExit(0);
    expect(out).toEqual(['x']);
    expect(exits).toEqual([0]);
  });

  it('an exited console keeps its snapshot, marked exited, and refuses input', () => {
    const { h, ptys } = host();
    const id = h.open(SPEC);
    ptys[0].emit('bye\n');
    ptys[0].emitExit(0);
    expect(h.snapshot(id)).toEqual({ data: 'bye\n', exited: true });
    expect(h.write(id, 'x')).toBe(false);
  });

  it('writes and clamps resizes', () => {
    const { h, ptys } = host();
    const id = h.open(SPEC);
    expect(h.write(id, 'ls\r')).toBe(true);
    expect(ptys[0].written).toEqual(['ls\r']);
    expect(h.resize(id, 99999, 0)).toBe(true);
    expect(ptys[0].size).toEqual({ cols: 500, rows: 1 });
  });

  it('unknown ids are no-ops', () => {
    const { h } = host();
    expect(h.write('nope', 'x')).toBe(false);
    expect(h.resize('nope', 80, 24)).toBe(false);
    expect(h.close('nope')).toBe(false);
    expect(h.snapshot('nope')).toBeUndefined();
  });

  it('refuses to open past maxTerminals', () => {
    const { h } = host({ maxTerminals: 1 });
    h.open(SPEC);
    expect(() => h.open(SPEC)).toThrow(/too many/i);
  });

  it('close kills the process and forgets the console', () => {
    const { h, ptys } = host();
    const id = h.open(SPEC);
    expect(h.close(id)).toBe(true);
    expect(ptys[0].killed).toBe(true);
    expect(h.has(id)).toBe(false);
  });

  it('closeAll kills every live console (server shutdown leaves no orphans)', () => {
    const { h, ptys } = host();
    h.open(SPEC);
    h.open(SPEC);
    h.closeAll();
    expect(ptys.every((p) => p.killed)).toBe(true);
    expect(h.size).toBe(0);
  });
});
```

- [ ] **Step 3: Verificar que falla**

Run: `cd server && npx vitest run __tests__/ptyHost.test.ts`
Expected: FAIL — `Cannot find module '../src/terminals/ringBuffer.js'`.

- [ ] **Step 4: Implementación**

`server/src/terminals/ptyTypes.ts`:

```ts
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
```

`server/src/terminals/ringBuffer.ts`:

```ts
/**
 * Bounded text buffer of a console's output, for re-attaching. Past the cap it
 * drops the oldest text and restarts at a line boundary: a snapshot that began
 * mid-line could begin mid escape sequence and garble the terminal.
 */
export class RingBuffer {
  private text = '';

  constructor(private readonly maxChars: number) {}

  append(s: string): void {
    this.text += s;
    if (this.text.length <= this.maxChars) return;
    const tail = this.text.slice(this.text.length - this.maxChars);
    const nl = tail.indexOf('\n');
    // No newline in the kept window: one huge line, keep its tail as is.
    this.text = nl === -1 ? tail : tail.slice(nl + 1);
  }

  read(): string {
    return this.text;
  }
}
```

`server/src/terminals/ptyHost.ts`:

```ts
import * as crypto from 'crypto';

import {
  MAX_OFFICE_TERMINALS,
  TERMINAL_BUFFER_CHARS,
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  TERMINAL_MAX_COLS,
  TERMINAL_MAX_ROWS,
} from '../constants.js';
import type { PtyFactory, PtyProcess } from './ptyTypes.js';
import { RingBuffer } from './ringBuffer.js';

interface Console {
  pty: PtyProcess;
  buffer: RingBuffer;
  exited: boolean;
}

export interface OpenSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

const clamp = (n: number, max: number): number =>
  Math.min(max, Math.max(1, Math.floor(Number.isFinite(n) ? n : 1)));

/**
 * Owns the office's pseudo-terminals (spec §2). Output is buffered for
 * re-attaching and handed to listeners; who receives it is TerminalHub's
 * business, never a broadcast.
 */
export class PtyHost {
  private readonly consoles = new Map<string, Console>();
  private readonly outputCbs = new Set<(id: string, data: string) => void>();
  private readonly exitCbs = new Set<(id: string, exitCode: number) => void>();
  private readonly maxTerminals: number;
  private readonly bufferChars: number;

  constructor(
    private readonly factory: PtyFactory,
    opts: { maxTerminals?: number; bufferChars?: number } = {},
  ) {
    this.maxTerminals = opts.maxTerminals ?? MAX_OFFICE_TERMINALS;
    this.bufferChars = opts.bufferChars ?? TERMINAL_BUFFER_CHARS;
  }

  get size(): number {
    return this.consoles.size;
  }

  open(spec: OpenSpec): string {
    let live = 0;
    for (const c of this.consoles.values()) if (!c.exited) live++;
    if (live >= this.maxTerminals) {
      throw new Error(`Too many office consoles (max ${this.maxTerminals})`);
    }
    const pty = this.factory(spec.file, spec.args, {
      cwd: spec.cwd,
      cols: clamp(spec.cols ?? TERMINAL_DEFAULT_COLS, TERMINAL_MAX_COLS),
      rows: clamp(spec.rows ?? TERMINAL_DEFAULT_ROWS, TERMINAL_MAX_ROWS),
      env: spec.env,
    });
    const id = crypto.randomUUID();
    const entry: Console = { pty, buffer: new RingBuffer(this.bufferChars), exited: false };
    this.consoles.set(id, entry);
    pty.onData((data) => {
      entry.buffer.append(data);
      for (const cb of this.outputCbs) cb(id, data);
    });
    pty.onExit(({ exitCode }) => {
      if (entry.exited) return;
      entry.exited = true;
      for (const cb of this.exitCbs) cb(id, exitCode);
    });
    return id;
  }

  has(id: string): boolean {
    return this.consoles.has(id);
  }

  snapshot(id: string): { data: string; exited: boolean } | undefined {
    const c = this.consoles.get(id);
    return c ? { data: c.buffer.read(), exited: c.exited } : undefined;
  }

  write(id: string, data: string): boolean {
    const c = this.consoles.get(id);
    if (!c || c.exited) return false;
    c.pty.write(data);
    return true;
  }

  resize(id: string, cols: number, rows: number): boolean {
    const c = this.consoles.get(id);
    if (!c || c.exited) return false;
    c.pty.resize(clamp(cols, TERMINAL_MAX_COLS), clamp(rows, TERMINAL_MAX_ROWS));
    return true;
  }

  close(id: string): boolean {
    const c = this.consoles.get(id);
    if (!c) return false;
    this.consoles.delete(id);
    if (!c.exited) {
      try {
        c.pty.kill();
      } catch {
        /* already gone */
      }
    }
    return true;
  }

  closeAll(): void {
    for (const id of [...this.consoles.keys()]) this.close(id);
  }

  onOutput(cb: (id: string, data: string) => void): () => void {
    this.outputCbs.add(cb);
    return () => this.outputCbs.delete(cb);
  }

  onExit(cb: (id: string, exitCode: number) => void): () => void {
    this.exitCbs.add(cb);
    return () => this.exitCbs.delete(cb);
  }
}
```

- [ ] **Step 5: Verificar que pasa**

Run: `cd server && npx vitest run __tests__/ptyHost.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/constants.ts server/src/terminals/ server/__tests__/ptyHost.test.ts
git commit -m "feat: PtyHost y búfer circular de las consolas de la oficina"
```

---

### Task 4: Comando de lanzamiento por plataforma

**Files:**

- Create: `server/src/terminals/launchCommand.ts`
- Test: `server/__tests__/launchCommand.test.ts`

**Interfaces:**

- Consumes: `HookProvider.buildLaunchCommand(sessionId, cwd, { bypassPermissions })` → `{ command, args, env? }` (`core/src/provider.ts`).
- Produces: `resolveLaunch(launch: { command: string; args: string[] }, platform: NodeJS.Platform, override?: string): { file: string; args: string[] }` y la constante `CLAUDE_COMMAND_OVERRIDE_ENV = 'PIXEL_AGENTS_CLAUDE_COMMAND'`.

- [ ] **Step 1: Test que falla**

`server/__tests__/launchCommand.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { resolveLaunch } from '../src/terminals/launchCommand.js';

const LAUNCH = { command: 'claude', args: ['--session-id', 'abc'] };

describe('resolveLaunch', () => {
  it('runs claude directly on POSIX', () => {
    expect(resolveLaunch(LAUNCH, 'linux')).toEqual({
      file: 'claude',
      args: ['--session-id', 'abc'],
    });
  });

  it('goes through cmd.exe on Windows (claude is a .cmd shim)', () => {
    expect(resolveLaunch(LAUNCH, 'win32')).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', 'claude', '--session-id', 'abc'],
    });
  });

  it('never puts the working directory on the command line', () => {
    // cwd travels as the pty option; a path with spaces must not be split.
    const r = resolveLaunch(LAUNCH, 'win32');
    expect(r.args.join(' ')).not.toContain('Mis Proyectos');
  });

  it('an e2e override (JSON array) replaces the claude binary and keeps the args', () => {
    const override = JSON.stringify(['C:\\node.exe', 'C:\\e2e\\mock-claude-runner.cjs']);
    expect(resolveLaunch(LAUNCH, 'win32', override)).toEqual({
      file: 'C:\\node.exe',
      args: ['C:\\e2e\\mock-claude-runner.cjs', '--session-id', 'abc'],
    });
  });

  it('a malformed override is ignored', () => {
    expect(resolveLaunch(LAUNCH, 'linux', 'not json')).toEqual({
      file: 'claude',
      args: ['--session-id', 'abc'],
    });
    expect(resolveLaunch(LAUNCH, 'linux', '[]')).toEqual({
      file: 'claude',
      args: ['--session-id', 'abc'],
    });
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `cd server && npx vitest run __tests__/launchCommand.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: Implementación**

`server/src/terminals/launchCommand.ts`:

```ts
/** Test-only override: a JSON array `[file, ...leadingArgs]` that replaces the
 *  provider's command (e2e points it at mock-claude so a test never starts the
 *  real CLI). Real users never set it. */
export const CLAUDE_COMMAND_OVERRIDE_ENV = 'PIXEL_AGENTS_CLAUDE_COMMAND';

function parseOverride(raw: string | undefined): string[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s)) {
      return v as string[];
    }
  } catch {
    /* ignored */
  }
  return null;
}

/**
 * The executable and argv an office console runs. The working directory is
 * NOT here: it is the pty's `cwd` option, so a path with spaces is never
 * re-split by a shell. On Windows `claude` is an npm `.cmd` shim, which only
 * cmd.exe can run.
 */
export function resolveLaunch(
  launch: { command: string; args: string[] },
  platform: NodeJS.Platform,
  override?: string,
): { file: string; args: string[] } {
  const custom = parseOverride(override);
  if (custom) {
    const [file, ...lead] = custom;
    return { file, args: [...lead, ...launch.args] };
  }
  if (platform === 'win32') {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', launch.command, ...launch.args] };
  }
  return { file: launch.command, args: [...launch.args] };
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `cd server && npx vitest run __tests__/launchCommand.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/terminals/launchCommand.ts server/__tests__/launchCommand.test.ts
git commit -m "feat: Comando de lanzamiento de claude por plataforma"
```

---

### Task 5: `AgentRuntime.launchOfficeAgent` y `terminalId` en el cable

**Files:**

- Modify: `server/src/types.ts`, `server/src/agentRuntime.ts`, `server/src/agentMessages.ts`
- Test: `server/__tests__/officeAgentLaunch.test.ts`

**Interfaces:**

- Consumes: `PtyHost` (Task 3), `resolveLaunch`, `CLAUDE_COMMAND_OVERRIDE_ENV` (Task 4), `startFileWatching` (`server/src/fileWatcher.ts:175`), `assignPaletteIfNeeded` (`server/src/paletteAssigner.js`).
- Produces:
  - `AgentState.terminalId?: string`
  - `AgentRuntime.attachPtyHost(host: PtyHost): void`, `AgentRuntime.ptyHost: PtyHost | null`
  - `AgentRuntime.launchOfficeAgent(opts: { cwd: string; bypassPermissions?: boolean }): { agentId: number; terminalId: string }` (lanza `Error` con mensaje legible si falla)
  - `AgentRuntime.agentIdForTerminal(terminalId: string): number | undefined`
  - `agentCreatedMessage(agent, privileged)` y `agentTreeMeta(agent, privileged)` incluyen `terminalId` solo si `privileged`.

- [ ] **Step 1: Test que falla**

`server/__tests__/officeAgentLaunch.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agentCreatedMessage, agentTreeMeta } from '../src/agentMessages.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { PtyHost } from '../src/terminals/ptyHost.js';
import type { PtyFactory, PtyProcess } from '../src/terminals/ptyTypes.js';

const testHome = vi.hoisted(() => ({ dir: '' }));
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const homedir = (): string => {
    if (!testHome.dir) throw new Error('os.homedir() called before a test home was set');
    return testHome.dir;
  };
  return { ...actual, homedir, default: { ...actual, homedir } };
});

class FakePty implements PtyProcess {
  readonly pid = 1;
  killed = false;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;
  onData() {
    return { dispose() {} };
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb;
    return { dispose() {} };
  }
  write() {}
  resize() {}
  kill() {
    this.killed = true;
    this.exitCb?.({ exitCode: 1 });
  }
  exit(code: number) {
    this.exitCb?.({ exitCode: code });
  }
}

describe('AgentRuntime.launchOfficeAgent', () => {
  let tmp: string;
  let workDir: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let ptys: FakePty[];
  let spawned: Array<{ file: string; args: string[]; cwd: string }>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-launch-'));
    testHome.dir = path.join(tmp, 'home');
    fs.mkdirSync(testHome.dir);
    workDir = path.join(tmp, 'Mis Proyectos');
    fs.mkdirSync(workDir);
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    ptys = [];
    spawned = [];
    const factory: PtyFactory = (file, args, o) => {
      spawned.push({ file, args, cwd: o.cwd });
      const p = new FakePty();
      ptys.push(p);
      return p;
    };
    runtime.attachPtyHost(new PtyHost(factory));
  });

  afterEach(() => {
    runtime.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates an internal agent bound to its console, with a fresh session id', () => {
    const { agentId, terminalId } = runtime.launchOfficeAgent({ cwd: workDir });
    const agent = store.get(agentId)!;
    expect(agent.terminalId).toBe(terminalId);
    expect(agent.isExternal).toBe(false);
    expect(agent.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(agent.jsonlFile.endsWith(`${agent.sessionId}.jsonl`)).toBe(true);
    expect(spawned[0].cwd).toBe(workDir);
    expect(spawned[0].args).toContain('--session-id');
    expect(spawned[0].args).toContain(agent.sessionId);
    expect(runtime.agentIdForTerminal(terminalId)).toBe(agentId);
  });

  it('passes bypassPermissions through to the launch command', () => {
    runtime.launchOfficeAgent({ cwd: workDir, bypassPermissions: true });
    expect(spawned[0].args).toContain('--dangerously-skip-permissions');
  });

  it('refuses a cwd that is not an existing absolute directory', () => {
    expect(() => runtime.launchOfficeAgent({ cwd: 'relative/dir' })).toThrow(/folder/i);
    expect(() => runtime.launchOfficeAgent({ cwd: path.join(tmp, 'missing') })).toThrow(/folder/i);
    expect(store.size).toBe(0);
  });

  it('refuses when no pty host is attached (terminals unavailable)', () => {
    const bare = new AgentRuntime(new AgentStateStore(), claudeProvider);
    expect(() => bare.launchOfficeAgent({ cwd: workDir })).toThrow(/not available/i);
    bare.dispose();
  });

  it('the console ending removes its agent', () => {
    const { agentId } = runtime.launchOfficeAgent({ cwd: workDir });
    ptys[0].exit(0);
    expect(store.get(agentId)).toBeUndefined();
  });

  it('terminalId reaches only privileged connections', () => {
    const { agentId, terminalId } = runtime.launchOfficeAgent({ cwd: workDir });
    const agent = store.get(agentId)!;
    expect(agentCreatedMessage(agent, true).terminalId).toBe(terminalId);
    expect(agentCreatedMessage(agent, false).terminalId).toBeUndefined();
    expect(agentTreeMeta(agent, true).terminalId).toBe(terminalId);
    expect(agentTreeMeta(agent, false).terminalId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `cd server && npx vitest run __tests__/officeAgentLaunch.test.ts`
Expected: FAIL — `runtime.attachPtyHost is not a function`.

- [ ] **Step 3: `AgentState.terminalId`**

En `server/src/types.ts`, tras `terminalRef?`:

```ts
  /** Office console this agent runs in (standalone "+ Agent"); its output is
   *  point-to-point to privileged connections only (TerminalHub). */
  terminalId?: string;
```

- [ ] **Step 4: `terminalId` en `agentMessages.ts`**

En `agentCreatedMessage`, junto a `label`:

```ts
    terminalId: privileged ? agent.terminalId : undefined,
```

En `agentTreeMeta`, añadir `'terminalId'` al `Pick<...>` y al objeto:

```ts
    terminalId: privileged ? agent.terminalId : undefined,
```

- [ ] **Step 5: Runtime**

En `server/src/agentRuntime.ts` añadir imports:

```ts
import * as crypto from 'crypto';

import { DEFAULT_MAX_CONTEXT_TOKENS, JSONL_POLL_INTERVAL_MS } from './constants.js';
import { assignPaletteIfNeeded } from './paletteAssigner.js';
import { CLAUDE_COMMAND_OVERRIDE_ENV, resolveLaunch } from './terminals/launchCommand.js';
import type { PtyHost } from './terminals/ptyHost.js';
```

(Fusionar con los imports existentes de `./constants.js` si ya los hay; verificar que `DEFAULT_MAX_CONTEXT_TOKENS` y `JSONL_POLL_INTERVAL_MS` existen en `constants.ts` — los usa `adapters/vscode/agentManager.ts`.)

Campos y métodos en la clase `AgentRuntime` (junto a los `readonly` de timers):

```ts
  /** Office consoles (standalone). Null when node-pty is unavailable or the
   *  server is not bound to loopback: launching is then refused. */
  ptyHost: PtyHost | null = null;
  private readonly agentByTerminal = new Map<string, number>();
  private unsubscribePtyExit: (() => void) | null = null;

  attachPtyHost(host: PtyHost): void {
    this.ptyHost = host;
    this.unsubscribePtyExit = host.onExit((terminalId) => {
      const agentId = this.agentByTerminal.get(terminalId);
      this.agentByTerminal.delete(terminalId);
      if (agentId !== undefined && this.store.has(agentId)) this.removeAgent(agentId);
    });
  }

  agentIdForTerminal(terminalId: string): number | undefined {
    return this.agentByTerminal.get(terminalId);
  }

  /**
   * Launch `claude` in an office console (spec §2): a fresh session id, an
   * internal agent bound to the console, the expected transcript pre-registered
   * so the project scan never mistakes it for someone else's session.
   */
  launchOfficeAgent(opts: { cwd: string; bypassPermissions?: boolean }): {
    agentId: number;
    terminalId: string;
  } {
    if (!this.ptyHost) throw new Error('Office consoles are not available on this server');
    const cwd = opts.cwd;
    let isDir = false;
    try {
      isDir = path.isAbsolute(cwd) && fs.statSync(cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new Error(`Not an existing folder: ${cwd}`);

    const sessionId = crypto.randomUUID();
    const launch = this.provider.buildLaunchCommand?.(sessionId, cwd, {
      bypassPermissions: opts.bypassPermissions === true,
    });
    if (!launch) throw new Error('This provider cannot launch agents');
    const { file, args } = resolveLaunch(
      launch,
      process.platform,
      process.env[CLAUDE_COMMAND_OVERRIDE_ENV],
    );
    const env = { ...(process.env as Record<string, string>), ...(launch.env ?? {}) };
    const terminalId = this.ptyHost.open({ file, args, cwd, env });

    const projectDir = this.provider.getSessionDirs?.(cwd)[0] ?? cwd;
    const jsonlFile = path.join(projectDir, `${sessionId}.jsonl`);
    this.knownJsonlFiles.add(jsonlFile);
    const id = this.store.nextAgentId.current++;
    const agent: AgentState = {
      id,
      sessionId,
      isExternal: false,
      terminalId,
      projectDir,
      jsonlFile,
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: 0,
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      hookDelivered: false,
      contextTokens: 0,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
    };
    assignPaletteIfNeeded(agent, this.store);
    this.agentByTerminal.set(terminalId, id);
    this.store.set(id, agent);
    this.registerAgent(sessionId, id);
    this.watchWhenTranscriptAppears(id);
    return { agentId: id, terminalId };
  }

  /** Start watching an office agent's transcript once claude creates it. */
  private watchWhenTranscriptAppears(id: number): void {
    const timer = setInterval(() => {
      const agent = this.store.get(id);
      if (!agent) {
        clearInterval(timer);
        this.jsonlPollTimers.delete(id);
        return;
      }
      if (!fs.existsSync(agent.jsonlFile)) return;
      clearInterval(timer);
      this.jsonlPollTimers.delete(id);
      startFileWatching(
        id,
        agent.jsonlFile,
        this.store,
        this.fileWatchers,
        this.pollingTimers,
        this.waitingTimers,
        this.permissionTimers,
      );
    }, JSONL_POLL_INTERVAL_MS);
    this.jsonlPollTimers.set(id, timer);
  }
```

(`this.provider` y `this.store` son los nombres que usa `AgentRuntime` hoy; si el campo del provider se llama distinto, usar el existente. `startFileWatching` ya se importa en `agentRuntime.ts` desde `./fileWatcher.js`; si no, añadirlo.)

Cerrar el agente desde la oficina mata su consola: en `removeAgent(id)` (antes de borrar del store):

```ts
const terminalId = this.store.get(id)?.terminalId;
if (terminalId) {
  this.agentByTerminal.delete(terminalId);
  this.ptyHost?.close(terminalId);
}
```

En `dispose()`, al principio:

```ts
this.unsubscribePtyExit?.();
this.ptyHost?.closeAll();
```

- [ ] **Step 6: Verificar que pasa**

Run: `cd server && npx vitest run __tests__/officeAgentLaunch.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 7: Suite completa del server**

Run: `npm run test:server`
Expected: todo en verde (agentMessages y resend no cambian para agentes sin `terminalId`).

- [ ] **Step 8: Commit**

```bash
git add server/src/types.ts server/src/agentRuntime.ts server/src/agentMessages.ts server/__tests__/officeAgentLaunch.test.ts
git commit -m "feat: Lanzar un agente en una consola de la oficina"
```

---

### Task 6: `TerminalHub` y mensajes de consola en el handler

**Files:**

- Create: `server/src/terminals/terminalHub.ts`
- Modify: `server/src/clientMessageHandler.ts`, `server/src/httpServer.ts`, `server/src/constants.ts`
- Test: `server/__tests__/terminalHub.test.ts`, `server/__tests__/clientMessageHandler.test.ts` (añadir describe)

**Interfaces:**

- Consumes: `PtyHost` (Task 3), `AgentRuntime.ptyHost`, `launchOfficeAgent`, `agentIdForTerminal` (Task 5).
- Produces:
  - `class TerminalHub { constructor(host: PtyHost, schedule?: (fn: () => void, ms: number) => unknown); attach(connId: string, terminalId: string, send: (m: Record<string, unknown>) => void): boolean; detach(connId: string, terminalId: string): void; isAttached(connId: string, terminalId: string): boolean; dropConnection(connId: string): void; dispose(): void }`
  - `AgentRuntime.terminalHub: TerminalHub | null` (creado en `attachPtyHost`)
  - Constantes: `TERMINAL_OUTPUT_FLUSH_MS = 16`, `TERMINAL_INPUT_MAX_CHARS = 64 * 1024`.

- [ ] **Step 1: Constantes**

En `server/src/constants.ts`, bajo el bloque de consolas:

```ts
/** Console output is coalesced per connection for this long: a burst (a big
 *  `cat`) goes out as a few messages, not one per pty chunk. */
export const TERMINAL_OUTPUT_FLUSH_MS = 16;
/** Longest terminalInput accepted in one message (a paste). */
export const TERMINAL_INPUT_MAX_CHARS = 64 * 1024;
```

- [ ] **Step 2: Test del hub que falla**

`server/__tests__/terminalHub.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { PtyHost } from '../src/terminals/ptyHost.js';
import type { PtyFactory, PtyProcess } from '../src/terminals/ptyTypes.js';
import { TerminalHub } from '../src/terminals/terminalHub.js';

class FakePty implements PtyProcess {
  readonly pid = 1;
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number }) => void) | null = null;
  onData(cb: (d: string) => void) {
    this.dataCb = cb;
    return { dispose() {} };
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCb = cb;
    return { dispose() {} };
  }
  write() {}
  resize() {}
  kill() {}
  emit(d: string) {
    this.dataCb?.(d);
  }
  exit(c: number) {
    this.exitCb?.({ exitCode: c });
  }
}

function setup() {
  const ptys: FakePty[] = [];
  const factory: PtyFactory = () => {
    const p = new FakePty();
    ptys.push(p);
    return p;
  };
  const host = new PtyHost(factory);
  const queued: Array<() => void> = [];
  const hub = new TerminalHub(host, (fn) => queued.push(fn));
  const flush = () => queued.splice(0).forEach((fn) => fn());
  const id = host.open({ file: 'claude', args: [], cwd: '/w', env: {} });
  return { host, hub, ptys, id, flush };
}

describe('TerminalHub', () => {
  it('attach sends the snapshot, then coalesced live output to that connection only', () => {
    const { hub, ptys, id, flush } = setup();
    ptys[0].emit('antes\n');
    const a: Array<Record<string, unknown>> = [];
    const b: Array<Record<string, unknown>> = [];
    expect(hub.attach('c1', id, (m) => a.push(m))).toBe(true);
    expect(a).toEqual([
      { type: 'terminalSnapshot', terminalId: id, data: 'antes\n', exited: false },
    ]);
    ptys[0].emit('uno');
    ptys[0].emit('dos');
    flush();
    expect(a[1]).toEqual({ type: 'terminalOutput', terminalId: id, data: 'unodos' });
    expect(a).toHaveLength(2);
    expect(b).toEqual([]);
  });

  it('attach to an unknown console is refused', () => {
    const { hub } = setup();
    expect(hub.attach('c1', 'nope', () => {})).toBe(false);
  });

  it('exit is delivered after pending output', () => {
    const { hub, ptys, id, flush } = setup();
    const a: Array<Record<string, unknown>> = [];
    hub.attach('c1', id, (m) => a.push(m));
    ptys[0].emit('fin');
    ptys[0].exit(3);
    flush();
    expect(a.slice(1)).toEqual([
      { type: 'terminalOutput', terminalId: id, data: 'fin' },
      { type: 'terminalExit', terminalId: id, exitCode: 3 },
    ]);
  });

  it('detach and dropConnection stop delivery', () => {
    const { hub, ptys, id, flush } = setup();
    const a: Array<Record<string, unknown>> = [];
    hub.attach('c1', id, (m) => a.push(m));
    hub.detach('c1', id);
    expect(hub.isAttached('c1', id)).toBe(false);
    ptys[0].emit('x');
    flush();
    expect(a).toHaveLength(1);
    hub.attach('c1', id, (m) => a.push(m));
    hub.dropConnection('c1');
    ptys[0].emit('y');
    flush();
    expect(a).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Verificar que falla**

Run: `cd server && npx vitest run __tests__/terminalHub.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 4: Implementación del hub**

`server/src/terminals/terminalHub.ts`:

```ts
import { TERMINAL_OUTPUT_FLUSH_MS } from '../constants.js';
import type { PtyHost } from './ptyHost.js';

type Send = (m: Record<string, unknown>) => void;

interface Sub {
  send: Send;
  pending: string;
  scheduled: boolean;
}

/**
 * Who receives which office console (spec §2). Point-to-point like the agent
 * screen feed: a console's output is code and command output, so it only ever
 * reaches the privileged connections that attached to it — never a broadcast.
 * Output is coalesced per connection (TERMINAL_OUTPUT_FLUSH_MS).
 */
export class TerminalHub {
  /** terminalId → connId → subscription */
  private readonly subs = new Map<string, Map<string, Sub>>();
  private readonly offOutput: () => void;
  private readonly offExit: () => void;

  constructor(
    private readonly host: PtyHost,
    private readonly schedule: (fn: () => void, ms: number) => unknown = (fn, ms) =>
      setTimeout(fn, ms),
  ) {
    this.offOutput = host.onOutput((id, data) => {
      for (const [, sub] of this.subs.get(id) ?? []) {
        sub.pending += data;
        if (!sub.scheduled) {
          sub.scheduled = true;
          this.schedule(() => this.flush(id, sub), TERMINAL_OUTPUT_FLUSH_MS);
        }
      }
    });
    this.offExit = host.onExit((id, exitCode) => {
      for (const [, sub] of this.subs.get(id) ?? []) {
        this.schedule(() => {
          this.flush(id, sub);
          sub.send({ type: 'terminalExit', terminalId: id, exitCode });
        }, TERMINAL_OUTPUT_FLUSH_MS);
      }
    });
  }

  private flush(id: string, sub: Sub): void {
    sub.scheduled = false;
    if (!sub.pending) return;
    const data = sub.pending;
    sub.pending = '';
    sub.send({ type: 'terminalOutput', terminalId: id, data });
  }

  attach(connId: string, terminalId: string, send: Send): boolean {
    const snap = this.host.snapshot(terminalId);
    if (!snap) return false;
    let conns = this.subs.get(terminalId);
    if (!conns) {
      conns = new Map();
      this.subs.set(terminalId, conns);
    }
    conns.set(connId, { send, pending: '', scheduled: false });
    send({ type: 'terminalSnapshot', terminalId, data: snap.data, exited: snap.exited });
    return true;
  }

  isAttached(connId: string, terminalId: string): boolean {
    return this.subs.get(terminalId)?.has(connId) === true;
  }

  detach(connId: string, terminalId: string): void {
    this.subs.get(terminalId)?.delete(connId);
  }

  dropConnection(connId: string): void {
    for (const conns of this.subs.values()) conns.delete(connId);
  }

  dispose(): void {
    this.offOutput();
    this.offExit();
    this.subs.clear();
  }
}
```

- [ ] **Step 5: Verificar que pasa**

Run: `cd server && npx vitest run __tests__/terminalHub.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: El runtime crea el hub**

En `AgentRuntime`: campo `terminalHub: TerminalHub | null = null;` (import `TerminalHub` desde `./terminals/terminalHub.js`); en `attachPtyHost`, tras asignar `this.ptyHost`:

```ts
this.terminalHub = new TerminalHub(host);
```

y en `dispose()` antes de `closeAll()`: `this.terminalHub?.dispose();`.

- [ ] **Step 7: Tests del handler que fallan**

Añadir a `server/__tests__/clientMessageHandler.test.ts`:

```ts
describe('clientMessageHandler: office consoles', () => {
  let tempHome: string;
  let store: AgentStateStore;
  let runtime: AgentRuntime;
  let sent: Array<Record<string, unknown>>;
  let written: string[];
  let workDir: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-console-'));
    testHome.dir = tempHome;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-cmh-work-'));
    store = new AgentStateStore();
    store.setAdapter(new FileStateAdapter({ namespace: 'standalone' }));
    runtime = new AgentRuntime(store, claudeProvider);
    written = [];
    runtime.attachPtyHost(
      new PtyHost(() => ({
        pid: 1,
        onData: () => ({ dispose() {} }),
        onExit: () => ({ dispose() {} }),
        write: (d: string) => written.push(d),
        resize: () => {},
        kill: () => {},
      })),
    );
    sent = [];
  });

  afterEach(() => {
    runtime.dispose();
    store.dispose();
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  const ctx = (privileged: boolean, connId = 'c1'): ClientMessageContext => ({
    store,
    runtime,
    cache: null,
    privileged,
    connId,
  });
  const dispatch = (msg: Record<string, unknown>, c = ctx(true)) =>
    handleClientMessage(msg, (m) => sent.push(m), c);

  it('launchAgent answers launchResult with the new agent and its console', () => {
    dispatch({ type: 'launchAgent', folderPath: workDir });
    const r = sent.find((m) => m.type === 'launchResult')!;
    expect(r.ok).toBe(true);
    expect(store.get(r.agentId as number)?.terminalId).toBe(r.terminalId);
  });

  it('launchAgent into a missing folder answers ok:false with the reason', () => {
    dispatch({ type: 'launchAgent', folderPath: path.join(workDir, 'nope') });
    expect(sent.find((m) => m.type === 'launchResult')).toMatchObject({ ok: false });
    expect(store.size).toBe(0);
  });

  it('a viewer can neither launch nor attach nor type', () => {
    dispatch({ type: 'launchAgent', folderPath: workDir });
    const id = sent.find((m) => m.type === 'launchResult')!.terminalId as string;
    sent = [];
    dispatch({ type: 'launchAgent', folderPath: workDir }, ctx(false, 'v1'));
    dispatch({ type: 'terminalAttach', terminalId: id }, ctx(false, 'v1'));
    dispatch({ type: 'terminalInput', terminalId: id, data: 'rm -rf /\r' }, ctx(false, 'v1'));
    expect(sent).toEqual([]);
    expect(written).toEqual([]);
    expect(store.size).toBe(1);
  });

  it('input only goes to a console this connection attached to', () => {
    dispatch({ type: 'launchAgent', folderPath: workDir });
    const id = sent.find((m) => m.type === 'launchResult')!.terminalId as string;
    dispatch({ type: 'terminalInput', terminalId: id, data: 'x' }, ctx(true, 'other'));
    expect(written).toEqual([]);
    dispatch({ type: 'terminalAttach', terminalId: id }, ctx(true, 'other'));
    dispatch({ type: 'terminalInput', terminalId: id, data: 'hola\r' }, ctx(true, 'other'));
    expect(written).toEqual(['hola\r']);
  });

  it('oversized or non-string input is dropped; unknown ids are ignored', () => {
    dispatch({ type: 'launchAgent', folderPath: workDir });
    const id = sent.find((m) => m.type === 'launchResult')!.terminalId as string;
    dispatch({ type: 'terminalAttach', terminalId: id });
    dispatch({ type: 'terminalInput', terminalId: id, data: 'x'.repeat(64 * 1024 + 1) });
    dispatch({ type: 'terminalInput', terminalId: id, data: 42 });
    dispatch({ type: 'terminalInput', terminalId: 'nope', data: 'x' });
    expect(written).toEqual([]);
  });

  it('terminalClose kills the console and removes its agent', () => {
    dispatch({ type: 'launchAgent', folderPath: workDir });
    const r = sent.find((m) => m.type === 'launchResult')!;
    dispatch({ type: 'terminalClose', terminalId: r.terminalId });
    expect(store.get(r.agentId as number)).toBeUndefined();
  });
});
```

Imports a añadir al archivo: `import { PtyHost } from '../src/terminals/ptyHost.js';`.

- [ ] **Step 8: Verificar que fallan**

Run: `cd server && npx vitest run __tests__/clientMessageHandler.test.ts -t "office consoles"`
Expected: FAIL — `launchResult` nunca se envía.

- [ ] **Step 9: Cases en `handleClientMessage`**

En `server/src/clientMessageHandler.ts` (dentro del `switch`, tras `closeAgent`). Imports: `TERMINAL_INPUT_MAX_CHARS` desde `./constants.js`, `addRecentLaunchDir` desde `./configPersistence.js` (Task 7 lo crea; en esta task dejar la llamada detrás de Task 7 — ver nota).

```ts
    case 'launchAgent': {
      // Standalone: an office console (spec §2). VS Code handles launchAgent in
      // its own view provider and never reaches this handler.
      if (!runtime?.ptyHost) {
        send({ type: 'launchResult', ok: false, error: 'Office consoles are not available' });
        break;
      }
      const cwd = typeof msg.folderPath === 'string' && msg.folderPath ? msg.folderPath : process.cwd();
      try {
        const { agentId, terminalId } = runtime.launchOfficeAgent({
          cwd,
          bypassPermissions: msg.bypassPermissions === true,
        });
        send({ type: 'launchResult', ok: true, agentId, terminalId });
      } catch (err) {
        send({
          type: 'launchResult',
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      break;
    }

    case 'terminalAttach': {
      const hub = runtime?.terminalHub;
      if (!hub || !ctx.connId || typeof msg.terminalId !== 'string') break;
      hub.attach(ctx.connId, msg.terminalId, send);
      break;
    }

    case 'terminalDetach': {
      if (ctx.connId && typeof msg.terminalId === 'string') {
        runtime?.terminalHub?.detach(ctx.connId, msg.terminalId);
      }
      break;
    }

    case 'terminalInput': {
      const hub = runtime?.terminalHub;
      const id = msg.terminalId;
      if (!hub || !ctx.connId || typeof id !== 'string') break;
      if (typeof msg.data !== 'string' || msg.data.length > TERMINAL_INPUT_MAX_CHARS) break;
      // Only a console this connection attached to: typing blind is refused.
      if (!hub.isAttached(ctx.connId, id)) break;
      runtime?.ptyHost?.write(id, msg.data);
      break;
    }

    case 'terminalResize': {
      const hub = runtime?.terminalHub;
      const id = msg.terminalId;
      if (!hub || !ctx.connId || typeof id !== 'string' || !hub.isAttached(ctx.connId, id)) break;
      if (typeof msg.cols !== 'number' || typeof msg.rows !== 'number') break;
      runtime?.ptyHost?.resize(id, msg.cols, msg.rows);
      break;
    }

    case 'terminalClose': {
      if (!runtime || typeof msg.terminalId !== 'string') break;
      const agentId = runtime.agentIdForTerminal(msg.terminalId);
      if (agentId !== undefined) runtime.removeAgent(agentId);
      else runtime.ptyHost?.close(msg.terminalId);
      break;
    }
```

`launchAgent`, `terminal*` NO se añaden a `VIEWER_MESSAGES`: el gate central ya los rechaza para visores.

- [ ] **Step 10: Liberar suscripciones al cerrar el socket y limitar la tasa**

En `server/src/constants.ts`, bajo el bloque de consolas:

```ts
/** terminalInput + terminalResize accepted per connection per window (typing
 *  and pasting stay far below; a flood is dropped). */
export const TERMINAL_MESSAGE_RATE_MAX = 400;
export const TERMINAL_MESSAGE_RATE_WINDOW_MS = 1_000;
```

En `server/src/httpServer.ts`, generalizar el limitador existente (misma lógica que `feedSubscribeLimiter`, línea ~369):

```ts
function rateLimiter(max: number, windowMs: number): () => boolean {
  const recent: number[] = [];
  return () => {
    const now = Date.now();
    while (recent.length > 0 && now - recent[0] >= windowMs) recent.shift();
    if (recent.length >= max) return false;
    recent.push(now);
    return true;
  };
}

function feedSubscribeLimiter(): () => boolean {
  return rateLimiter(FEED_SUBSCRIBE_RATE_MAX, FEED_SUBSCRIBE_RATE_WINDOW_MS);
}
```

En el handler del socket, junto a `allowFeedSubscribe`:

```ts
const allowTerminalMessage = rateLimiter(
  TERMINAL_MESSAGE_RATE_MAX,
  TERMINAL_MESSAGE_RATE_WINDOW_MS,
);
```

y antes de `handleClientMessage(...)`:

```ts
if ((msg.type === 'terminalInput' || msg.type === 'terminalResize') && !allowTerminalMessage())
  return;
```

Dentro de `release`:

```ts
options.runtime?.terminalHub?.dropConnection(connId);
```

Test en `server/__tests__/httpServerWs.test.ts` (patrón de los tests del feed de ese archivo): con un runtime con `PtyHost` falso y una consola lanzada y enganchada por una conexión con token, enviar `TERMINAL_MESSAGE_RATE_MAX + 50` `terminalInput` seguidos y comprobar que el pty falso recibió exactamente `TERMINAL_MESSAGE_RATE_MAX` escrituras.

- [ ] **Step 11: Verificar y suite completa**

Run: `cd server && npx vitest run __tests__/terminalHub.test.ts __tests__/clientMessageHandler.test.ts && cd .. && npm run test:server`
Expected: PASS; suite completa en verde.

- [ ] **Step 12: Commit**

```bash
git add server/src/terminals/terminalHub.ts server/src/agentRuntime.ts server/src/clientMessageHandler.ts server/src/httpServer.ts server/src/constants.ts server/__tests__/terminalHub.test.ts server/__tests__/clientMessageHandler.test.ts
git commit -m "feat: Consolas punto a punto y lanzar desde el navegador"
```

---

### Task 7: Cableado del CLI, loopback, capacidades y recientes

**Files:**

- Create: `server/src/terminals/loadNodePty.ts`
- Modify: `server/src/cli.ts`, `server/src/clientMessageHandler.ts` (webviewReady), `server/src/configPersistence.ts`
- Test: `server/__tests__/configPersistence.test.ts` (añadir), `server/__tests__/clientMessageHandler.test.ts` (añadir), `server/__tests__/loadNodePty.test.ts`

**Interfaces:**

- Consumes: `PtyHost`, `AgentRuntime.attachPtyHost` (Tasks 3, 5).
- Produces:
  - `loadNodePty(): PtyFactory | null`
  - `isLoopbackHost(host: string): boolean` (en `loadNodePty.ts`)
  - `readRecentLaunchDirs(): string[]`, `addRecentLaunchDir(dir: string): void` en `configPersistence.ts` (máx `RECENT_LAUNCH_DIRS_MAX = 5`, más reciente primero, sin duplicados)
  - En `webviewReady` para conexiones privilegiadas con `runtime.ptyHost`: `providerCapabilities.terminals = true` y `launchOptions { defaultCwd: process.cwd(), recentDirs }`.

- [ ] **Step 1: Tests que fallan**

`server/__tests__/loadNodePty.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { isLoopbackHost } from '../src/terminals/loadNodePty.js';

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', '::1', 'localhost'])('%s is loopback', (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });
  it.each(['0.0.0.0', '::', '', '192.168.1.10', 'my-pc'])('%s is not', (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
});
```

En `server/__tests__/configPersistence.test.ts` (usa su harness de HOME aislado):

```ts
describe('recent launch dirs', () => {
  it('keeps the newest first, without duplicates, capped', () => {
    for (const d of ['/a', '/b', '/c', '/a', '/d', '/e', '/f']) addRecentLaunchDir(d);
    expect(readRecentLaunchDirs()).toEqual(['/f', '/e', '/d', '/a', '/c']);
  });

  it('ignores non-string junk in the file', () => {
    writeConfig({ ...readConfig(), recentLaunchDirs: ['/ok', 42, null] as unknown as string[] });
    expect(readRecentLaunchDirs()).toEqual(['/ok']);
  });
});
```

En `clientMessageHandler.test.ts`, dentro de `office consoles`:

```ts
it('webviewReady tells a privileged client it may launch, with the defaults', () => {
  dispatch({ type: 'webviewReady' });
  expect(sent.find((m) => m.type === 'providerCapabilities')).toMatchObject({ terminals: true });
  expect(sent.find((m) => m.type === 'launchOptions')).toMatchObject({
    defaultCwd: process.cwd(),
  });
});

it('a viewer is told consoles are unavailable and gets no launch options', () => {
  handleClientMessage({ type: 'webviewReady' }, (m) => sent.push(m), {
    ...ctx(false),
    runtime: undefined,
  });
  expect(sent.find((m) => m.type === 'providerCapabilities')?.terminals).toBeFalsy();
  expect(sent.some((m) => m.type === 'launchOptions')).toBe(false);
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `cd server && npx vitest run __tests__/loadNodePty.test.ts __tests__/configPersistence.test.ts __tests__/clientMessageHandler.test.ts`
Expected: FAIL (módulo inexistente / funciones no exportadas / sin `terminals`).

- [ ] **Step 3: `loadNodePty.ts`**

```ts
import type { PtyFactory } from './ptyTypes.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Office consoles only on a loopback bind: exposed to a network, a console is
 *  a remote shell for whoever holds the token (spec §1, security). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

/** node-pty is optional at runtime: a platform without its prebuilt binary
 *  still gets the office, just without consoles. */
export function loadNodePty(): PtyFactory | null {
  try {
    // The CLI bundle is CJS (esbuild format 'cjs', no "type": "module"), and
    // node-pty is an external resolved at runtime — a plain require.
    const pty = require('node-pty') as typeof import('node-pty');
    return (file, args, opts) =>
      pty.spawn(file, args, {
        name: 'xterm-256color',
        cwd: opts.cwd,
        cols: opts.cols,
        rows: opts.rows,
        env: opts.env,
      });
  } catch (err) {
    console.warn(
      `[Pixel Agents] Office consoles unavailable: node-pty did not load (${err instanceof Error ? err.message : String(err)})`,
    );
    return null;
  }
}
```

(Si el lint marca `@typescript-eslint/no-require-imports`, añadir el `eslint-disable-next-line` de esa regla sobre la línea, como en `server/src/hookEventHandler.ts:184`.)

- [ ] **Step 4: Recientes en `configPersistence.ts`**

Añadir a `PixelAgentsConfig`: `recentLaunchDirs: string[];`, al default `recentLaunchDirs: []`, y en el parseo:

```ts
      recentLaunchDirs: Array.isArray(parsed.recentLaunchDirs)
        ? (parsed.recentLaunchDirs as unknown[]).filter((d): d is string => typeof d === 'string')
        : [],
```

Constante en `server/src/constants.ts`: `export const RECENT_LAUNCH_DIRS_MAX = 5;`

Funciones:

```ts
export function readRecentLaunchDirs(): string[] {
  return readConfig().recentLaunchDirs.slice(0, RECENT_LAUNCH_DIRS_MAX);
}

export function addRecentLaunchDir(dir: string): void {
  const cfg = readConfig();
  cfg.recentLaunchDirs = [dir, ...cfg.recentLaunchDirs.filter((d) => d !== dir)].slice(
    0,
    RECENT_LAUNCH_DIRS_MAX,
  );
  writeConfig(cfg);
}
```

En el case `launchAgent` (Task 6), tras un lanzamiento con éxito: `addRecentLaunchDir(cwd);`.

- [ ] **Step 5: `webviewReady`**

En `handleWebviewReady` (`clientMessageHandler.ts`), el mensaje 1:

```ts
const terminals = ctx.privileged === true && !!ctx.runtime?.ptyHost;
send({
  type: 'providerCapabilities',
  readingTools: [...claudeProvider.readingTools],
  subagentToolNames: [...claudeProvider.subagentToolNames],
  terminals,
});
if (terminals) {
  send({ type: 'launchOptions', defaultCwd: process.cwd(), recentDirs: readRecentLaunchDirs() });
}
```

- [ ] **Step 6: `cli.ts`**

Tras crear `runtime` y antes de `server.start(...)`:

```ts
// Office consoles (spec §1): only on a loopback bind, only with node-pty.
if (isLoopbackHost(args.host)) {
  const factory = loadNodePty();
  if (factory) runtime.attachPtyHost(new PtyHost(factory));
} else {
  console.log(
    `[Pixel Agents] Office consoles disabled: the server is bound to ${args.host}, not loopback.`,
  );
}
```

`shutdown()` ya llama `runtime.dispose()`, que mata todas las consolas (Task 5).

- [ ] **Step 7: Verificar**

Run: `cd server && npx vitest run __tests__/loadNodePty.test.ts __tests__/configPersistence.test.ts __tests__/clientMessageHandler.test.ts && cd .. && npm run test:server && npm run compile`
Expected: PASS y compile exit 0.

- [ ] **Step 8: Prueba manual segura (HOME aislado, nunca el real)**

```bash
TMPH=$(mktemp -d); HOME=$TMPH USERPROFILE=$TMPH PIXEL_AGENTS_CLAUDE_COMMAND='["node","-e","process.stdin.on(\"data\",d=>process.stdout.write(\"eco:\"+d))"]' node dist/cli.js --port 3999
```

Expected: arranca e imprime la URL con token; sin errores de node-pty. Ctrl+C lo detiene sin procesos colgados.

- [ ] **Step 9: Commit**

```bash
git add server/src/terminals/loadNodePty.ts server/src/cli.ts server/src/clientMessageHandler.ts server/src/configPersistence.ts server/src/constants.ts server/__tests__/loadNodePty.test.ts server/__tests__/configPersistence.test.ts server/__tests__/clientMessageHandler.test.ts
git commit -m "feat: Activar las consolas en el CLI solo en loopback"
```

---

### Task 8: Webview — modal de consola y diálogo de lanzar

**Files:**

- Create: `webview-ui/src/console/consoleRouting.ts`, `webview-ui/src/components/ConsoleModal.tsx`, `webview-ui/src/components/LaunchDialog.tsx`
- Modify: `webview-ui/src/components/BottomToolbar.tsx`, `webview-ui/src/App.tsx`, `webview-ui/src/hooks/useExtensionMessages.ts`, `webview-ui/src/constants.ts`, `webview-ui/src/office/types.ts` (Character.terminalId), `webview-ui/src/office/engine/officeState.ts` (guardar terminalId)
- Test: `webview-ui/test/consoleRouting.test.ts`

**Interfaces:**

- Consumes: mensajes de Task 2; `transport.send/onMessage` (`MessageTransport`).
- Produces:
  - `consoleMessageFor(msg: unknown, terminalId: string): { kind: 'snapshot'; data: string; exited: boolean } | { kind: 'output'; data: string } | { kind: 'exit'; exitCode: number } | null`
  - `Character.terminalId?: string`
  - `ConsoleModal({ terminalId, title, transport, onClose })`
  - `LaunchDialog({ defaultCwd, recentDirs, transport, onClose, onLaunched(agentId, terminalId) })`

- [ ] **Step 1: Test que falla**

`webview-ui/test/consoleRouting.test.ts`:

```ts
import { expect, test } from 'vitest';

import { consoleMessageFor } from '../src/console/consoleRouting.js';

test('picks only this console\u2019s messages', () => {
  expect(consoleMessageFor({ type: 'terminalOutput', terminalId: 't1', data: 'hi' }, 't1')).toEqual(
    { kind: 'output', data: 'hi' },
  );
  expect(consoleMessageFor({ type: 'terminalOutput', terminalId: 't2', data: 'hi' }, 't1')).toBe(
    null,
  );
});

test('snapshot and exit', () => {
  expect(
    consoleMessageFor(
      { type: 'terminalSnapshot', terminalId: 't1', data: 'x', exited: true },
      't1',
    ),
  ).toEqual({ kind: 'snapshot', data: 'x', exited: true });
  expect(consoleMessageFor({ type: 'terminalExit', terminalId: 't1', exitCode: 2 }, 't1')).toEqual({
    kind: 'exit',
    exitCode: 2,
  });
});

test('malformed wire data is ignored', () => {
  expect(consoleMessageFor(null, 't1')).toBe(null);
  expect(consoleMessageFor({ type: 'terminalOutput', terminalId: 't1', data: 5 }, 't1')).toBe(null);
  expect(consoleMessageFor({ type: 'terminalExit', terminalId: 't1' }, 't1')).toBe(null);
});
```

- [ ] **Step 2: Verificar que falla**

Run: `cd webview-ui && npx vitest run test/consoleRouting.test.ts`
Expected: FAIL — módulo inexistente.

- [ ] **Step 3: `consoleRouting.ts`**

```ts
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
```

- [ ] **Step 4: Verificar que pasa**

Run: `cd webview-ui && npx vitest run test/consoleRouting.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Constantes de la webview**

En `webview-ui/src/constants.ts`:

```ts
// ── Office console (xterm.js) ──
export const CONSOLE_THEME = {
  background: '#1e1e2e',
  foreground: '#e0def4',
  cursor: '#f6c177',
  selectionBackground: '#44415a',
} as const;
export const CONSOLE_FONT_FAMILY = 'Consolas, "Cascadia Mono", Menlo, monospace';
export const CONSOLE_FONT_SIZE = 14;
export const CONSOLE_SCROLLBACK_LINES = 5000;
```

- [ ] **Step 6: `ConsoleModal.tsx`**

```tsx
import '@xterm/xterm/css/xterm.css';

import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

import {
  CONSOLE_FONT_FAMILY,
  CONSOLE_FONT_SIZE,
  CONSOLE_SCROLLBACK_LINES,
  CONSOLE_THEME,
} from '../constants.js';
import { consoleMessageFor } from '../console/consoleRouting.js';
import type { MessageTransport } from '../transport/types.js';

export interface ConsoleModalProps {
  terminalId: string;
  title: string;
  transport: MessageTransport;
  onClose: () => void;
}

/**
 * The office console (spec §2): the real `claude` interface in xterm.js. It
 * owns the keyboard while open — Esc and Ctrl+C belong to Claude, so the modal
 * closes only with its ✕ button.
 */
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
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="pixel-panel flex flex-col" style={{ width: '92vw', height: '88vh' }}>
        <div className="flex items-center justify-between p-4">
          <span className="text-lg">{title}</span>
          <button type="button" aria-label="Cerrar consola" onClick={onClose} className="px-8">
            ✕
          </button>
        </div>
        <div ref={hostRef} data-testid="office-console" className="flex-1 min-h-0 px-4 pb-4" />
      </div>
    </div>
  );
}
```

(Revisar con `npx eslint webview-ui/src/components/ConsoleModal.tsx`: si `bg-black/60` choca con `no-inline-colors`, usar la clase de backdrop que usan `AgentScreenModal` / `SettingsModal`.)

- [ ] **Step 7: `LaunchDialog.tsx`**

```tsx
import { useEffect, useState } from 'react';

import type { MessageTransport } from '../transport/types.js';
import { Button } from './ui/Button.js';

export interface LaunchDialogProps {
  defaultCwd: string;
  recentDirs: string[];
  transport: MessageTransport;
  onClose: () => void;
  onLaunched: (agentId: number, terminalId: string) => void;
}

export function LaunchDialog({
  defaultCwd,
  recentDirs,
  transport,
  onClose,
  onLaunched,
}: LaunchDialogProps) {
  const [cwd, setCwd] = useState(recentDirs[0] ?? defaultCwd);
  const [bypass, setBypass] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      transport.onMessage((msg) => {
        const m = msg as Record<string, unknown>;
        if (m.type !== 'launchResult') return;
        setBusy(false);
        if (m.ok === true && typeof m.agentId === 'number' && typeof m.terminalId === 'string') {
          onLaunched(m.agentId, m.terminalId);
        } else {
          setError(typeof m.error === 'string' ? m.error : 'No se pudo lanzar');
        }
      }),
    [transport, onLaunched],
  );

  const launch = () => {
    setBusy(true);
    setError(null);
    transport.send({ type: 'launchAgent', folderPath: cwd.trim(), bypassPermissions: bypass });
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="pixel-panel flex flex-col gap-8 p-12" style={{ minWidth: 480 }}>
        <span className="text-lg">Lanzar agente</span>
        <label className="flex flex-col gap-4">
          Carpeta
          <input
            data-testid="launch-cwd"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            list="launch-recent-dirs"
            className="pixel-input"
          />
          <datalist id="launch-recent-dirs">
            {recentDirs.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </label>
        <label className="flex items-center gap-4">
          <input type="checkbox" checked={bypass} onChange={(e) => setBypass(e.target.checked)} />
          Saltar permisos <span className="text-warning">⚠</span>
        </label>
        {error && <span className="text-warning">{error}</span>}
        <div className="flex gap-8 justify-end">
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="accent" onClick={launch} disabled={busy || !cwd.trim()}>
            Lanzar
          </Button>
        </div>
      </div>
    </div>
  );
}
```

(Verificar las props de `Button` en `webview-ui/src/components/ui/Button.tsx`; si no admite `disabled`, pasarlo por el atributo HTML que exponga. La clase `pixel-input`: usar la que usen los inputs de `SettingsModal`.)

- [ ] **Step 8: Cableado**

1. `webview-ui/src/office/types.ts`, en `Character`: `/** Office console of this agent (privileged clients only). */ terminalId?: string;`
2. `webview-ui/src/hooks/useExtensionMessages.ts`:
   - Estado `consoleCapable` (bool) y `launchOptions` (`{ defaultCwd: string; recentDirs: string[] } | null`), expuestos en el objeto que devuelve el hook.
   - En `providerCapabilities`: `setConsoleCapable(msg.terminals === true)`.
   - En `launchOptions`: guardar `{ defaultCwd, recentDirs }` validando tipos.
   - En `agentCreated` y en cada entrada de `existingAgents.agentMeta`: si `typeof terminalId === 'string'`, `os.characters.get(id)!.terminalId = terminalId` tras crear el personaje.
3. `BottomToolbar.tsx`: la condición `{!isBrowserRuntime && (` pasa a `{(!isBrowserRuntime || consoleCapable) && (`, con nueva prop `consoleCapable: boolean` y `onOpenLaunchDialog: () => void`; en navegador, `handleAgentClick` llama `onOpenLaunchDialog()` en vez de `onOpenClaude()`, y el dropdown de bypass no se muestra (el diálogo tiene su casilla).
4. `App.tsx`:
   - Estado `consoleTerminal: { id: string; title: string } | null` y `launchOpen: boolean`.
   - Al hacer clic en un personaje con `terminalId` (el handler de clic de agente que hoy abre la pantalla / enfoca): abrir `ConsoleModal` con ese `terminalId` en lugar de la pantalla.
   - `onLaunched(agentId, terminalId)` → cerrar diálogo, abrir consola con título `Agente #${agentId}`.
   - Renderizar `<LaunchDialog>` cuando `launchOpen && launchOptions`, y `<ConsoleModal>` cuando `consoleTerminal`.

- [ ] **Step 9: Verificar tipos, lint y tests**

Run: `npm run check-types && npx eslint webview-ui/src && npm run test:webview && npm run compile`
Expected: todo exit 0.

- [ ] **Step 10: Commit**

```bash
git add webview-ui/src webview-ui/test/consoleRouting.test.ts
git commit -m "feat: Consola real y diálogo de lanzar en la oficina del navegador"
```

---

### Task 9: E2E — lanzar y escribir en la consola

**Files:**

- Modify: `e2e/fixtures/mock-claude-runner.cjs`, `e2e/helpers/standalone.ts`
- Create: `e2e/tests/standalone/console.spec.ts`
- Regenerate: `e2e/README.md` (inventario)

**Interfaces:**

- Consumes: `launchStandalone(page, options)` (`e2e/helpers/standalone.ts:229`), `CLAUDE_COMMAND_OVERRIDE_ENV` (`PIXEL_AGENTS_CLAUDE_COMMAND`).
- Produces: `LaunchStandaloneOptions.mockClaudeConsoles?: boolean`; el runner registra `stdin <json>` en `~/.claude-mock/actions.log` y responde `mock-claude recibió: <texto>` por stdout cuando corre en una TTY.

- [ ] **Step 1: El mock lee stdin en una TTY**

En `e2e/fixtures/mock-claude-runner.cjs`, en `main()` tras `logInvocation(...)`:

```js
// Office consoles (pty): echo what the user types, so e2e can see the
// keystrokes reached "claude". Line-based: one reply per Enter.
if (process.stdin.isTTY) {
  process.stdin.setRawMode?.(false);
  let line = '';
  process.stdin.on('data', (chunk) => {
    const text = chunk.toString();
    logAction(homeDir, `stdin ${JSON.stringify(text)}`);
    line += text;
    const parts = line.split(/\r|\n/);
    line = parts.pop() || '';
    for (const p of parts) {
      if (p) process.stdout.write(`\r\nmock-claude recibió: ${p}\r\n`);
    }
  });
  process.stdout.write('mock-claude listo\r\n');
}
```

- [ ] **Step 2: `launchStandalone` apunta el servidor al mock**

En `LaunchStandaloneOptions` añadir `mockClaudeConsoles?: boolean`. Pasar la opción a `spawnStandaloneHost` y en su `env`:

```ts
        ...(args.mockClaudeConsoles
          ? {
              PIXEL_AGENTS_CLAUDE_COMMAND: JSON.stringify([process.execPath, MOCK_CLAUDE_RUNNER]),
            }
          : {}),
```

(`MOCK_CLAUDE_RUNNER` ya está definido en `standalone.ts:18`.) Así el servidor nunca arranca el `claude` real en e2e.

- [ ] **Step 3: El spec**

`e2e/tests/standalone/console.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

import { launchStandalone } from '../../helpers/standalone';

test.describe('Standalone / office console', () => {
  test('launch an agent from the browser and type into its console @area:standalone', async ({
    page,
  }) => {
    const session = await launchStandalone(page, { mockClaudeConsoles: true });
    try {
      await page.getByRole('button', { name: '+ Agent' }).click();
      await expect(page.getByTestId('launch-cwd')).toHaveValue(session.workspaceDir);
      await page.getByRole('button', { name: 'Lanzar' }).click();

      const console = page.getByTestId('office-console');
      await expect(console).toBeVisible();
      await expect(console).toContainText('mock-claude listo', { timeout: 15_000 });

      await console.click();
      await page.keyboard.type('hola oficina');
      await page.keyboard.press('Enter');
      await expect(console).toContainText('mock-claude recibió: hola oficina', {
        timeout: 10_000,
      });

      // Closing the browser view keeps the console alive: re-open shows the snapshot.
      await page.getByRole('button', { name: 'Cerrar consola' }).click();
      await expect(console).toHaveCount(0);
    } finally {
      await session.cleanup();
    }
  });
});
```

- [ ] **Step 4: Compilar y correr el spec**

Run: `npm run compile && npm run e2e -- --workers=1 --retries=0 e2e/tests/standalone/console.spec.ts`
Expected: 1 passed.

- [ ] **Step 5: Verificar que falla sin la consola** (demostración de que el test mide algo)

Comentar temporalmente `transport.send({ type: 'terminalAttach', terminalId });` en `ConsoleModal.tsx`, `npm run compile`, correr el spec → FAIL en "mock-claude listo". Restaurar la línea y recompilar.

- [ ] **Step 6: Suite standalone y regenerar inventario**

Run: `npm run e2e -- --workers=1 e2e/tests/standalone && npm run e2e:inventory`
Expected: standalone en verde; `e2e/README.md` actualizado con el spec nuevo.

- [ ] **Step 7: Commit**

```bash
git add e2e/fixtures/mock-claude-runner.cjs e2e/helpers/standalone.ts e2e/tests/standalone/console.spec.ts e2e/README.md
git commit -m "test(e2e): Lanzar un agente y escribir en su consola desde el navegador"
```

---

### Task 10: Documentación

**Files:**

- Create: `docs/adr/0004-office-consoles-are-real-terminals.md`
- Modify: `CONTEXT.md`, `CLAUDE.md`, `docs/pendientes-y-roadmap.md`

- [ ] **Step 1: ADR 0004**

```markdown
# Office consoles are real terminals

The office only watched. To work a session without leaving it, it needs a way
back into Claude Code. Three were weighed:

- **A chat over the Claude Agent SDK** (`canUseTool` for permissions and
  AskUserQuestion). Structured, office-native buttons — but it reimplements the
  CLI's interface and loses its `/commands`.
- **`claude -p --input-format stream-json`**. Rejected: the input protocol is
  undocumented.
- **A real pseudo-terminal the server owns** (`node-pty`) shown with xterm.js.
  Chosen: full parity with the console for free.

## Decision

Standalone only. `+ Agent` launches `claude --session-id <uuid>` in a pty owned by
the server; the browser attaches to it. Its transcript and hooks feed the office
like any session. Consoles are privileged (token), point-to-point (never
broadcast), and only exist on a loopback bind — on a network bind a console is a
remote shell for whoever holds the token. `node-pty` is optional at runtime: a
host without its prebuilt binary gets the office without consoles.

## Consequences

Questions and permissions of office sessions are answered in their console, not
as office buttons. Sessions opened in other terminals stay observe-only here;
answering their permissions from the office is the permission bridge (next
phase). Stopping the server kills its consoles; the work survives in the
transcript.
```

- [ ] **Step 2: `CONTEXT.md`** — añadir bajo "Agent Lifecycle":

```markdown
**Office console**:
A real terminal the standalone server owns, running `claude` for an agent launched from the office. Shown in the browser with xterm.js; only the operator (token) can see or type into it.
_Avoid_: shell, tty (implementation words)

**Office session**:
A session launched from the office, bound to its office console. Its agent is internal (not headless).
```

- [ ] **Step 3: `CLAUDE.md`** — en la sección HTTP + WebSocket, tras el párrafo de transcript-derived content:

```markdown
**Office consoles are privileged and loopback-only.** `+ Agent` in standalone launches `claude` in a `node-pty` pseudo-terminal the server owns (`server/src/terminals/`: `PtyHost`, `TerminalHub`, `launchCommand`). `launchAgent` and `terminal*` messages are operator-only (never in `VIEWER_MESSAGES`); console output is point-to-point to attached connections, never broadcast; input is accepted only from a connection attached to that console. Consoles are disabled unless the server binds to loopback, and when `node-pty` fails to load (`providerCapabilities.terminals = false`). E2E never runs the real CLI: `PIXEL_AGENTS_CLAUDE_COMMAND` points the launcher at mock-claude. See docs/adr/0004.
```

Y en "Distribution", añadir `node-pty` a la lista de externas instaladas con el paquete npm.

- [ ] **Step 4: Roadmap** — en `docs/pendientes-y-roadmap.md`, sección "Interactuar", marcar como en curso "Mandarle un mensaje a un agente" con referencia a la spec.

- [ ] **Step 5: Commit**

```bash
git add docs/adr/0004-office-consoles-are-real-terminals.md CONTEXT.md CLAUDE.md docs/pendientes-y-roadmap.md
git commit -m "docs: ADR y glosario de las consolas de la oficina"
```
