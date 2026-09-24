# Árbol de agentes, oficinas por scope y pantalla ampliada — Plan de implementación

> **Para agentes ejecutores:** este plan se ejecuta con la orquestación `/equipo` (skill `orquestar-equipo`, modo multi-fase). Cada tarea `T<n>` es de UN `desarrollador`, dueño de su ciclo QA (`qa-revisor`) + `pentester`. Las tareas `S<n>` son del **super-líder** (archivos centrales compartidos, en serie). Los pasos usan checkboxes (`- [ ]`). **Commits**: solo el super-líder, en la rama `feature/agent-tree-scope-offices`, tras validar cada tarea (el usuario pidió commits en esta rama; nada de push ni PR sin su visto bueno). Los desarrolladores NO commitean.

**Goal:** Representar cualquier sesión multi-agente como un árbol de profundidad arbitraria, con una oficina navegable por scope y una pantalla ampliada con el feed en vivo de cada agente.

**Architecture:** Todo spawn con sidecar pasa a ser un Agent derivado (`parentAgentId`, `spawnAgentKey`, `role`, `label`, `depth`) creado por un planificador puro recursivo (`spawnTree.ts`) sobre las entradas que expone el proveedor; los hooks con `agent_id` se enrutan al nodo derivado. La webview mantiene la oficina raíz y, como mucho, una oficina de scope activa con layout autogenerado, alimentadas por un directorio de agentes siempre al día. El feed se sirve por suscripción dirigida solo a conexiones privilegiadas.

**Tech Stack:** TypeScript (Node16/ES2022 server, React 19 + Canvas webview), Fastify + WebSocket, AsyncAPI 3.0 + Modelina, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-23-agent-tree-scope-offices-design.md`

## Global Constraints

- Capas: `core/` sin dependencias; `server/` solo de `core/`; `webview-ui/` solo de `core/`; `adapters/vscode/` de `core/` + `server/`. Lo específico de Claude vive SOLO en `server/src/providers/hook/claude/`.
- `core/src/messages.ts` es generado: se cambia `core/asyncapi.yaml` y se corre `npm run asyncapi:generate`. Nunca editar `messages.ts` a mano.
- Sin `enum` (usar `as const`); `import type` para tipos; `.js` en imports relativos de server/adapters; `noUnusedLocals`/`noUnusedParameters`.
- Toda constante mágica en `server/src/constants.ts` / `webview-ui/src/constants.ts` / `core/src/constants.ts`. Colores solo en `webview-ui/src/constants.ts` (regla ESLint `no-inline-colors`); sombras `2px 2px 0px`/`var(--pixel-shadow)`; fuente FS Pixel Sans; `borderRadius: 0`.
- Agentes derivados **nunca** se persisten ni se registran como sesión.
- El feed **nunca** se difunde por broadcast; solo a conexiones con `ctx.privileged === true`.
- `FEED_SNAPSHOT_MAX_ENTRIES = 200`, `FEED_ENTRY_DETAIL_MAX_BYTES = 65536`.
- Logs con prefijo `[Pixel Agents]` (server) / `[Webview]` (webview).
- Cada ola termina con `npm run compile`, `npm test` en verde; las olas con e2e, además `npm run e2e -- --workers=1 --grep "<spec>"` y `npm run e2e:inventory`.

## Review Focus

1. **Sesión con cientos de sidecars históricos** (una real tiene 342): solo los spawns vivos se materializan y el escaneo de 1 s no relee cada `.meta.json` en cada ciclo → test en T1 (caché por ruta+mtime) y en T3 (300 entradas muertas ⇒ 0 creaciones).
2. **Hook con `agent_id` que llega antes de que exista el nodo**: se bufferiza, nunca anima a la raíz, y expira a los `HOOK_EVENT_BUFFER_MS` → tests en T2 y T7.
3. **El líder termina (`/exit`) con el equipo trabajando**: se elimina todo el subárbol, de hojas a raíz, sin personajes huérfanos → test en T6.
4. **Recarga del panel a mitad de un equipo**: `existingAgents` trae `parentAgentId/role/label/depth` y la webview reconstruye el árbol → test en S2 (`existingAgents` meta) y en T9.
5. **Usuario dentro de la oficina de un scope cuyo dueño termina**: vuelve al ancestro vivo más cercano, nunca queda un canvas vacío → test en T9 (`nearestLiveAncestor`) y e2e en S3.

---

## Grafo de olas (DAG)

```
Ola 0  S1 (contrato + interfaces + docs)                                    [super-líder]
          │
Ola 1  T1 proveedor Claude │ T2 SessionRouter │ T3 spawnTree puro │ T4 scope puro (webview) │ T5 feed parser
          │                     │                    │
       S1b contrato nodeKind + interfaces de workflow (super-líder, antes de Ola 2)
          │
Ola 2  T6 runtime árbol (usa T1,T3) │ T7 hooks por agentKey (usa T2) │ T8 e2e árbol (usa S1) │ T16 proveedor workflows (usa S1b)
          │
Ola 2b T17 nodos workflow en el runtime (usa T6, T16; mismos archivos que T6 ⇒ después)
          │
       S2 integración entrega 1 → revisión del usuario (probar en navegador, standalone)
          │
Ola 3  T9 directorio + OfficeRegistry (usa T4) │ T10 UI navegación (usa T4)
       S3 integración entrega 2 (App.tsx) + e2e navegación → revisión del usuario
          │
Ola 4  T11 AgentFeedHub server (usa T5) │ T12 AgentScreenModal UI
       S4 integración entrega 3 + e2e feed + CLAUDE.md → revisión del usuario
          │ (Ola 5 depende de S2 y S3; puede correr en paralelo con Ola 4 salvo S5/S4, que son del super-líder y van en serie)
Ola 5  S5 contrato agentConversation │ T13 detección server │ T14 escena pura (webview) │ T15 motor + burbuja
       S6 integración entrega 4 + e2e conversación → revisión del usuario
```

Archivos reservados al super-líder (ningún dev los toca): `core/asyncapi.yaml`, `core/src/messages.ts`, `core/src/provider.ts`, `core/src/teamProvider.ts`, `server/src/types.ts`, `server/src/constants.ts`, `webview-ui/src/constants.ts`, `server/src/httpServer.ts`, `server/src/clientMessageHandler.ts`, `adapters/vscode/PixelAgentsViewProvider.ts`, `webview-ui/src/App.tsx`, `CONTEXT.md`, `CLAUDE.md`, `docs/adr/*`.

---

## Ola 0

### S1: Contrato, interfaces compartidas y documentación de dominio (super-líder)

**Files:**

- Modify: `core/asyncapi.yaml` (schemas `AgentCreated`, `AgentSeatMeta`; nuevos mensajes y schemas de feed; listas `oneOf` de ServerMessage/ClientMessage)
- Regenerate: `core/src/messages.ts`
- Modify: `core/src/provider.ts:80-83` (envelope de `normalizeHookEvent`) y bloque opcional de feed
- Modify: `core/src/teamProvider.ts` (entrada de `discoverTeammates`)
- Modify: `server/src/types.ts` (`AgentState`)
- Modify: `server/src/constants.ts`, `webview-ui/src/constants.ts`
- Create: `docs/adr/0002-every-spawn-is-a-derived-agent.md`
- Modify: `CONTEXT.md` (Sub-agent, Scope, Oficina de scope)

**Interfaces (Produces — todas las tareas dependen de esto):**

- [ ] **Step 1: `AgentCreated` formaliza los campos que ya se envían y agrega los del árbol**

Hoy `httpServer.ts:172-185` y `PixelAgentsViewProvider.ts:123-136` envían `isTeammate`, `teammateName`, `parentAgentId`, `teamName`, `hooksOnly` fuera del contrato. En `core/asyncapi.yaml`, dentro de `AgentCreated.properties`, después de `hueShift`:

```yaml
isTeammate:
  type: boolean
teammateName:
  type: string
teamName:
  type: string
hooksOnly:
  type: boolean
parentAgentId:
  type: integer
  description: Tree parent (the agent that spawned this one). Absent for top-level sessions.
role:
  type: string
  description: Spawn type label (Claude agentType, e.g. "Explore", "desarrollador"). Display only.
label:
  type: string
  description: Spawn task description. Display only.
depth:
  type: integer
  description: Spawn depth (1 = spawned by a top-level session).
```

Y en `AgentSeatMeta.properties` (usado por `existingAgents.agentMeta`), después de `seatId`: los mismos `parentAgentId`, `role`, `label`, `depth`, más `teammateName` (string).

- [ ] **Step 2: Mensajes de feed**

En `components/schemas` agregar:

```yaml
SubscribeAgentFeed:
  description: Ask for the live activity feed of one agent. Privileged connections only.
  type: object
  additionalProperties: false
  required: [type, id]
  properties:
    type:
      const: subscribeAgentFeed
    id:
      type: integer

UnsubscribeAgentFeed:
  description: Stop receiving an agent's feed.
  type: object
  additionalProperties: false
  required: [type, id]
  properties:
    type:
      const: unsubscribeAgentFeed
    id:
      type: integer

AgentFeedSnapshot:
  description: Point-to-point reply to subscribeAgentFeed with the newest entries.
  type: object
  additionalProperties: false
  required: [type, id, entries, truncated]
  properties:
    type:
      const: agentFeedSnapshot
    id:
      type: integer
    entries:
      type: array
      items:
        $ref: '#/components/schemas/FeedEntry'
    truncated:
      type: boolean
      description: True when older entries exist beyond the snapshot limit.

AgentFeedAppend:
  description: New feed entries for a subscribed agent (point-to-point).
  type: object
  additionalProperties: false
  required: [type, id, entries]
  properties:
    type:
      const: agentFeedAppend
    id:
      type: integer
    entries:
      type: array
      items:
        $ref: '#/components/schemas/FeedEntry'

AgentFeedDenied:
  description: subscribeAgentFeed refused (unprivileged connection or unknown agent).
  type: object
  additionalProperties: false
  required: [type, id, reason]
  properties:
    type:
      const: agentFeedDenied
    id:
      type: integer
    reason:
      type: string
      enum: [unprivileged, unknownAgent]

FeedEntry:
  type: object
  additionalProperties: false
  required: [seq, ts, kind, summary]
  properties:
    seq:
      type: integer
    ts:
      type: string
      description: ISO timestamp from the transcript record (empty when absent).
    kind:
      type: string
      enum: [text, tool, toolResult]
    toolId:
      type: string
    toolName:
      type: string
    summary:
      type: string
    isError:
      type: boolean
    detail:
      $ref: '#/components/schemas/FeedDetail'

FeedDetail:
  type: object
  additionalProperties: false
  required: [type]
  properties:
    type:
      type: string
      enum: [diff, output]
    lines:
      type: array
      description: For diff — one entry per line.
      items:
        $ref: '#/components/schemas/FeedDiffLine'
    text:
      type: string
      description: For output — the (ANSI-stripped) text.
    truncated:
      type: boolean

FeedDiffLine:
  type: object
  additionalProperties: false
  required: [op, text]
  properties:
    op:
      type: string
      enum: [context, add, remove]
    text:
      type: string
```

Añadir `SubscribeAgentFeed` y `UnsubscribeAgentFeed` al `oneOf` de ClientMessage y `AgentFeedSnapshot`, `AgentFeedAppend`, `AgentFeedDenied` al de ServerMessage (seguir el patrón de `$ref` existente en `channels`/`messages`).

- [ ] **Step 3: Regenerar y validar**

Run: `npm run asyncapi:validate && npm run asyncapi:generate && npm run check-types`
Expected: validate OK; `core/src/messages.ts` contiene `interface AgentCreated` con `parentAgentId?: number; role?: string; label?: string; depth?: number;` y los tipos `FeedEntry`, `FeedDetail`, `FeedDiffLine`, `AgentFeedSnapshot`. `check-types` puede fallar solo donde el código enviaba campos que ahora están tipados de otra forma — corregir ahí.

- [ ] **Step 4: Envelope de hooks con `agentKey` y hook opcional de feed en `core/src/provider.ts`**

```ts
  normalizeHookEvent(raw: Record<string, unknown>): {
    sessionId: string;
    /** Provider key of the spawned agent the event came from, when it fired
     *  inside one (Claude: hook `agent_id`, equal to the sidecar file's
     *  `agent-<key>.jsonl`). Absent for the session's own events. A keyed
     *  event must never be applied to the session's root agent. */
    agentKey?: string;
    event: AgentEvent;
  } | null;
```

Y dentro de `HookProvider`, en el bloque de opcionales (antes de `readonly team?`):

```ts
  /** Turn one parsed transcript record into feed entries for the agent screen.
   *  `seq` is assigned by the host. Undefined = this provider has no feed. */
  parseFeedEntries?(record: Record<string, unknown>): Array<Omit<FeedEntry, 'seq'>>;
```

con `import type { FeedEntry } from './messages.js';` al inicio del archivo.

- [ ] **Step 5: Entrada de `discoverTeammates` en `core/src/teamProvider.ts`**

Reemplazar el tipo de retorno por:

```ts
  ): Array<{
    jsonlPath: string;
    teammateName: string;
    sessionId?: string;
    toolUseId?: string;
    description?: string;
    name?: string;
    /** Sidecar-backed spawns: the provider key of this spawned agent (Claude: `<hex>` of `agent-<hex>.jsonl`). */
    agentKey?: string;
    /** Key of the spawned agent that spawned this one; absent when the session root spawned it. */
    parentAgentKey?: string;
    /** Spawn depth: 1 = spawned by the session root. */
    depth?: number;
    /** Spawn type (Claude sidecar `agentType`). */
    agentType?: string;
  }>;
```

- [ ] **Step 6: Campos de árbol en `AgentState` (`server/src/types.ts`)**, después de `teammateSpawnToolIds`:

```ts
  // -- Spawn tree (docs/adr/0002) --
  /** Derived agents only: the provider key of this spawn (Claude sidecar
   *  `<hex>` = hook `agent_id`). Hook events carrying it route here. */
  spawnAgentKey?: string;
  /** Derived agents only: the agent that spawned this one (root session or
   *  another derived agent). Removing a parent removes its whole subtree. */
  parentAgentId?: number;
  /** Spawn type label (display only). */
  role?: string;
  /** Spawn task description (display only). */
  label?: string;
  /** Spawn depth, 1 = spawned by the root session. */
  depth?: number;
```

- [ ] **Step 7: Constantes**

`server/src/constants.ts`:

```ts
/** Agent screen feed: newest entries sent on subscribe. */
export const FEED_SNAPSHOT_MAX_ENTRIES = 200;
/** Agent screen feed: per-entry detail cap (diff/output), bytes. */
export const FEED_ENTRY_DETAIL_MAX_BYTES = 65536;
/** Agent screen feed: bytes read from the transcript tail to build a snapshot. */
export const FEED_TAIL_READ_BYTES = 1_048_576;
/** Derived agents inherit their parent's palette; each sibling rotates the hue by this step so a scope office tells them apart. */
export const SPAWN_SIBLING_HUE_STEP_DEG = 40;
```

`webview-ui/src/constants.ts`:

```ts
// ── Scope offices ──
/** Tiles per workstation slot (desk 3×2 + chair row + aisle). */
export const SCOPE_SLOT_W = 4;
export const SCOPE_SLOT_H = 4;
/** Workstations per row in a generated scope office. */
export const SCOPE_SLOTS_PER_ROW = 4;
/** Delay before leaving a scope whose owner finished. */
export const SCOPE_OWNER_GONE_BOUNCE_MS = 2000;
/** Badge colors (scope child count / descendant waiting on permission). */
export const SCOPE_BADGE_BG = '#2a2a44';
export const SCOPE_BADGE_ALERT_BG = '#c98a1a';
/** Mirror of the server's FEED_SNAPSHOT_MAX_ENTRIES: entries kept in the agent screen. */
export const FEED_MAX_ENTRIES = 200;
/** Agent screen diff colors. */
export const FEED_DIFF_ADD_COLOR = '#4ec96b';
export const FEED_DIFF_REMOVE_COLOR = '#e05a5a';
```

- [ ] **Step 8: ADR 0002 y `CONTEXT.md`**

`docs/adr/0002-every-spawn-is-a-derived-agent.md`: contexto (sidecars planos con `parentAgentId`/`spawnDepth`, defecto de hooks, sub-agentes que no podían tener hijos), decisión (todo spawn con sidecar es un Agent derivado, no persistido, con padre; nombre sigue distinguiendo Sub-agent de Teammate pero no la representación; Scope/oficina de scope), alternativas rechazadas (árbol separado con entidad propia — duplica herramientas/permisos/estado; inferencia solo en UI — el protocolo `(leadId, toolUseId)` no expresa profundidad ≥ 2), consecuencias (shadow store retirado; Task-era sin sidecar conserva el Subtask).

En `CONTEXT.md`, reescribir **Sub-agent**:

```markdown
**Sub-agent**:
An unnamed agent spawned by another agent. A derived agent: no session of its own, never persisted, alive for the duration of its task (which may outlive the parent's turn). It can spawn sub-agents and teammates of its own, to any depth. Having no name is what makes it a sub-agent rather than a teammate; both sit in their spawner's scope office.
_Avoid_: subtask (UI label prefix only, for legacy transcripts without spawn metadata)
```

y añadir bajo "Agents & Teams":

```markdown
**Scope**:
An agent together with the agents it spawned directly. Every agent with children is the owner of one scope.

**Scope office**:
The office that shows one scope: its owner and its direct children, in a generated room. The root office is the user's editable office and shows top-level agents.
_Avoid_: room, sub-office
```

- [ ] **Step 9: Verificar y commitear**

Run: `npm run compile && npm test`
Expected: PASS.

```bash
git add core/asyncapi.yaml core/src/messages.ts core/src/provider.ts core/src/teamProvider.ts server/src/types.ts server/src/constants.ts webview-ui/src/constants.ts docs/adr/0002-every-spawn-is-a-derived-agent.md CONTEXT.md
git commit -m "feat: Agregar contrato e interfaces del árbol de agentes y feed"
```

---

## Ola 1 (paralela)

### T1: Proveedor Claude — metadatos de sidecar y `agent_id` de hooks

**Files:**

- Modify: `server/src/providers/hook/claude/claudeTeamProvider.ts:25-47` (`parseSidecarMeta`), `:185-198` (bucle de sidecars)
- Modify: `server/src/providers/hook/claude/claude.ts:130-135` (`normalizeHookEvent`)
- Test: `server/__tests__/claudeTeamProvider.test.ts`, `server/__tests__/claude.test.ts`

**Interfaces:**

- Consumes: entrada ampliada de `discoverTeammates` y envelope con `agentKey` (S1).
- Produces: `discoverTeammates` devuelve `agentKey`, `parentAgentKey`, `depth`, `agentType` para sidecars; `normalizeHookEvent` devuelve `agentKey` cuando el payload trae `agent_id` string no vacío.

- [ ] **Step 1: Tests que fallan**

En `claudeTeamProvider.test.ts` (usar el mismo patrón de tmp dir del archivo):

```ts
it('exposes spawn-tree keys from sidecars', () => {
  const dir = path.join(projectDir, LEAD, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-aaa111.jsonl'), '');
  fs.writeFileSync(
    path.join(dir, 'agent-aaa111.meta.json'),
    JSON.stringify({
      agentType: 'lider-fase',
      description: 'Fase 1',
      toolUseId: 'toolu_1',
      spawnDepth: 1,
    }),
  );
  fs.writeFileSync(path.join(dir, 'agent-bbb222.jsonl'), '');
  fs.writeFileSync(
    path.join(dir, 'agent-bbb222.meta.json'),
    JSON.stringify({
      agentType: 'desarrollador',
      description: 'dev auth',
      toolUseId: 'toolu_2',
      parentAgentId: 'aaa111',
      spawnDepth: 2,
    }),
  );
  const entries = claudeTeamProvider.discoverTeammates(projectDir, LEAD);
  const byKey = new Map(entries.map((e) => [e.agentKey, e]));
  expect(byKey.get('aaa111')).toMatchObject({
    depth: 1,
    agentType: 'lider-fase',
    parentAgentKey: undefined,
    toolUseId: 'toolu_1',
  });
  expect(byKey.get('bbb222')).toMatchObject({
    depth: 2,
    agentType: 'desarrollador',
    parentAgentKey: 'aaa111',
  });
});

it('does not re-parse an unchanged sidecar on every scan', () => {
  // 300 dead sidecars, scanned twice: the second scan must not call readFileSync on them again.
  const dir = path.join(projectDir, LEAD, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 300; i++) {
    fs.writeFileSync(path.join(dir, `agent-d${i}.jsonl`), '');
    fs.writeFileSync(
      path.join(dir, `agent-d${i}.meta.json`),
      JSON.stringify({ agentType: 'Explore', toolUseId: `toolu_d${i}`, spawnDepth: 1 }),
    );
  }
  claudeTeamProvider.discoverTeammates(projectDir, LEAD);
  const spy = vi.spyOn(fs, 'readFileSync');
  claudeTeamProvider.discoverTeammates(projectDir, LEAD);
  const metaReads = spy.mock.calls.filter(([p]) => String(p).endsWith('.meta.json'));
  expect(metaReads).toHaveLength(0);
  spy.mockRestore();
});
```

En `claude.test.ts`:

```ts
it('carries agent_id as agentKey for events fired inside a subagent', () => {
  const r = claudeProvider.normalizeHookEvent({
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    agent_id: 'bbb222',
    agent_type: 'desarrollador',
    tool_name: 'Read',
    tool_input: { file_path: '/x.ts' },
  });
  expect(r?.agentKey).toBe('bbb222');
  expect(r?.event.kind).toBe('toolStart');
});

it('omits agentKey for the session own events', () => {
  const r = claudeProvider.normalizeHookEvent({ hook_event_name: 'Stop', session_id: 's1' });
  expect(r?.agentKey).toBeUndefined();
});
```

- [ ] **Step 2: Correr y ver fallar**

Run: `npx vitest run server/__tests__/claudeTeamProvider.test.ts server/__tests__/claude.test.ts`
Expected: FAIL (`agentKey`/`depth` undefined; 300 lecturas de meta).

- [ ] **Step 3: Implementar `parseSidecarMeta` con caché por mtime**

```ts
interface SidecarMeta {
  agentType: string;
  toolUseId?: string;
  description?: string;
  name?: string;
  parentAgentKey?: string;
  depth?: number;
}

/** Sidecars never change once written; re-reading 300+ of them every 1 s scan
 *  is pure waste. Keyed by meta path, invalidated by mtime. */
const sidecarCache = new Map<string, { mtimeMs: number; meta: SidecarMeta | null }>();

function parseSidecarMeta(jsonlPath: string): SidecarMeta | null {
  const metaPath = sidecarPath(jsonlPath);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(metaPath).mtimeMs;
  } catch {
    return null;
  }
  const cached = sidecarCache.get(metaPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.meta;
  let meta: SidecarMeta | null = null;
  try {
    const data = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
    if (typeof data.agentType === 'string') {
      meta = {
        agentType: data.agentType,
        toolUseId: typeof data.toolUseId === 'string' ? data.toolUseId : undefined,
        description: typeof data.description === 'string' ? data.description : undefined,
        name: typeof data.name === 'string' ? data.name : undefined,
        parentAgentKey: typeof data.parentAgentId === 'string' ? data.parentAgentId : undefined,
        depth: typeof data.spawnDepth === 'number' ? data.spawnDepth : undefined,
      };
    }
  } catch {
    meta = null;
  }
  sidecarCache.set(metaPath, { mtimeMs, meta });
  return meta;
}
```

En el bucle de `discoverTeammates` (líneas 185-198), el `result.push` pasa a:

```ts
result.push({
  jsonlPath,
  teammateName: meta.agentType,
  toolUseId: meta.toolUseId,
  description: meta.description,
  name: meta.name,
  agentKey: entry.slice('agent-'.length, -'.jsonl'.length),
  parentAgentKey: meta.parentAgentKey,
  depth: meta.depth,
  agentType: meta.agentType,
});
```

(Solo si el nombre empieza por `agent-`; si no, `agentKey` queda `undefined`.)

- [ ] **Step 4: `agentKey` en `normalizeHookEvent`**

`normalizeHookEvent` tiene varios `return { sessionId, event: ... }`. Envolver en un helper al inicio de la función, justo tras validar `eventName`/`sessionId`:

```ts
const agentKey =
  typeof raw.agent_id === 'string' && raw.agent_id.length > 0 ? raw.agent_id : undefined;
const out = (event: AgentEvent) =>
  agentKey ? { sessionId, agentKey, event } : { sessionId, event };
```

y reemplazar cada `return { sessionId, event: X }` por `return out(X)`. **Excepción**: `SubagentStart`/`SubagentStop` describen al hijo pero hoy se enrutan al padre (flujo de teammates); para ellos se conserva `agentKey` igualmente — el enrutado lo decide T7.

- [ ] **Step 5: Tests en verde + suite del proveedor**

Run: `npx vitest run server/__tests__/claudeTeamProvider.test.ts server/__tests__/claude.test.ts server/__tests__/backgroundAgents.test.ts`
Expected: PASS.

- [ ] **Step 6: Reportar al líder** (sin commit). Archivos tocados, resultado de tests, hallazgos QA/pentester.

---

### T2: SessionRouter — resolver por `(sessionId, agentKey)`

**Files:**

- Modify: `server/src/sessionRouter.ts`
- Test: `server/__tests__/sessionRouter.test.ts`

**Interfaces:**

- Produces:
  - `registerSpawn(sessionId: string, agentKey: string, agentId: number): BufferedEvent[]` — registra un nodo derivado y devuelve los eventos bufferizados para ese `(sessionId, agentKey)`.
  - `unregisterSpawn(sessionId: string, agentKey: string): void`
  - `resolveSpawn(sessionId: string, agentKey: string): number | undefined`
  - `bufferEvent(providerId, event, agentKey?)` — firma ampliada; `BufferedEvent` gana `agentKey?: string`.
  - `flushBuffered` de `register(sessionId)` **solo** devuelve eventos SIN `agentKey` (los con clave esperan a su nodo).

- [ ] **Step 1: Tests que fallan**

```ts
describe('spawn routing', () => {
  it('resolves a derived agent by (session, agentKey)', () => {
    const r = new SessionRouter();
    r.register('s1', 1);
    r.registerSpawn('s1', 'bbb222', 7);
    expect(r.resolveSpawn('s1', 'bbb222')).toBe(7);
    expect(r.resolveSpawn('s1', 'zzz')).toBeUndefined();
    expect(r.resolve('s1')).toBe(1);
  });

  it('keeps keyed events buffered until their node registers, never flushing them to the root', () => {
    const r = new SessionRouter();
    r.bufferEvent('claude', { session_id: 's1', hook_event_name: 'PreToolUse' }, 'bbb222');
    r.bufferEvent('claude', { session_id: 's1', hook_event_name: 'Stop' });
    const rootFlush = r.register('s1', 1);
    expect(rootFlush).toHaveLength(1);
    expect(rootFlush[0].agentKey).toBeUndefined();
    const spawnFlush = r.registerSpawn('s1', 'bbb222', 7);
    expect(spawnFlush).toHaveLength(1);
    expect(spawnFlush[0].agentKey).toBe('bbb222');
    r.dispose();
  });

  it('expires keyed buffered events after HOOK_EVENT_BUFFER_MS', () => {
    vi.useFakeTimers();
    const r = new SessionRouter();
    r.bufferEvent('claude', { session_id: 's1' }, 'bbb222');
    vi.advanceTimersByTime(HOOK_EVENT_BUFFER_MS + 1);
    r.pruneExpired();
    expect(r.registerSpawn('s1', 'bbb222', 7)).toHaveLength(0);
    r.dispose();
    vi.useRealTimers();
  });

  it('unregisterSpawn forgets the node', () => {
    const r = new SessionRouter();
    r.registerSpawn('s1', 'k', 7);
    r.unregisterSpawn('s1', 'k');
    expect(r.resolveSpawn('s1', 'k')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Ver fallar** — Run: `npx vitest run server/__tests__/sessionRouter.test.ts` → FAIL (`registerSpawn is not a function`).

- [ ] **Step 3: Implementar**

```ts
export interface BufferedEvent {
  providerId: string;
  event: { session_id: string; [key: string]: unknown };
  /** Set when the event fired inside a spawned agent; such events only ever
   *  flush to that agent, never to the session root. */
  agentKey?: string;
  timestamp: number;
}

  private spawnToAgentId = new Map<string, number>();

  private static spawnKey(sessionId: string, agentKey: string): string {
    return `${sessionId}\u0000${agentKey}`;
  }

  registerSpawn(sessionId: string, agentKey: string, agentId: number): BufferedEvent[] {
    this.spawnToAgentId.set(SessionRouter.spawnKey(sessionId, agentKey), agentId);
    return this.flushWhere((b) => b.event.session_id === sessionId && b.agentKey === agentKey);
  }

  unregisterSpawn(sessionId: string, agentKey: string): void {
    this.spawnToAgentId.delete(SessionRouter.spawnKey(sessionId, agentKey));
  }

  resolveSpawn(sessionId: string, agentKey: string): number | undefined {
    return this.spawnToAgentId.get(SessionRouter.spawnKey(sessionId, agentKey));
  }

  bufferEvent(
    providerId: string,
    event: { session_id: string; [key: string]: unknown },
    agentKey?: string,
  ): void {
    this.buffer.push({ providerId, event, agentKey, timestamp: Date.now() });
    // (resto igual: arrancar el timer de poda)
  }

  private flushBuffered(sessionId: string): BufferedEvent[] {
    return this.flushWhere((b) => b.event.session_id === sessionId && b.agentKey === undefined);
  }

  private flushWhere(pred: (b: BufferedEvent) => boolean): BufferedEvent[] {
    const toFlush = this.buffer.filter(pred);
    this.buffer = this.buffer.filter((b) => !pred(b));
    this.cleanupBufferTimer();
    return toFlush;
  }
```

`dispose()` también limpia `spawnToAgentId`. `hasBuffered(sessionId)` no cambia.

- [ ] **Step 4: Verde** — Run: `npx vitest run server/__tests__/sessionRouter.test.ts server/__tests__/hookEventHandler.test.ts` → PASS.

- [ ] **Step 5: Reportar al líder.**

---

### T3: Planificador puro del árbol de spawns

**Files:**

- Create: `server/src/spawnTree.ts`
- Test: `server/__tests__/spawnTree.test.ts`

**Interfaces:**

- Produces:

```ts
export interface SpawnEntry {
  jsonlPath: string;
  agentKey: string;
  parentAgentKey?: string;
  toolUseId: string;
  depth: number;
  agentType: string;
  description?: string;
  name?: string;
}
export interface SpawnTreeNode {
  id: number;
  /** undefined for the root session agent */
  spawnAgentKey?: string;
  liveSpawnToolIds: ReadonlySet<string>;
}
export interface SpawnPlan {
  create: Array<{ entry: SpawnEntry; parentId: number }>;
  /** Entries whose parent node does not exist yet — retry next scan. */
  deferred: SpawnEntry[];
}
export function planSpawnTree(
  rootId: number,
  nodes: ReadonlyMap<number, SpawnTreeNode>,
  entries: readonly SpawnEntry[],
  isTracked: (jsonlPath: string) => boolean,
): SpawnPlan;
export function subtreeRemovalOrder(
  rootOfRemoval: number,
  parentOf: ReadonlyMap<number, number | undefined>,
): number[]; // leaves first, rootOfRemoval last
```

- [ ] **Step 1: Tests que fallan**

```ts
import { describe, expect, it } from 'vitest';
import {
  planSpawnTree,
  subtreeRemovalOrder,
  type SpawnEntry,
  type SpawnTreeNode,
} from '../src/spawnTree.js';

const e = (
  agentKey: string,
  toolUseId: string,
  depth: number,
  parentAgentKey?: string,
): SpawnEntry => ({
  jsonlPath: `/p/s/subagents/agent-${agentKey}.jsonl`,
  agentKey,
  parentAgentKey,
  toolUseId,
  depth,
  agentType: 'general-purpose',
});
const node = (id: number, live: string[], spawnAgentKey?: string): SpawnTreeNode => ({
  id,
  spawnAgentKey,
  liveSpawnToolIds: new Set(live),
});

describe('planSpawnTree', () => {
  it('creates a depth-1 child under the root when its spawn tool is live', () => {
    const nodes = new Map([[1, node(1, ['t1'])]]);
    const plan = planSpawnTree(1, nodes, [e('a', 't1', 1)], () => false);
    expect(plan.create).toEqual([{ entry: e('a', 't1', 1), parentId: 1 }]);
    expect(plan.deferred).toEqual([]);
  });

  it('skips entries whose spawn tool is not live (historical sidecars)', () => {
    const nodes = new Map([[1, node(1, [])]]);
    const dead = Array.from({ length: 300 }, (_, i) => e(`d${i}`, `t${i}`, 1));
    expect(planSpawnTree(1, nodes, dead, () => false)).toEqual({ create: [], deferred: [] });
  });

  it('attaches a grandchild to its derived parent by key, gated by the PARENT live tools', () => {
    const nodes = new Map([
      [1, node(1, ['t1'])],
      [5, node(5, ['t2'], 'a')],
    ]);
    const plan = planSpawnTree(1, nodes, [e('b', 't2', 2, 'a')], (p) =>
      p.endsWith('agent-a.jsonl'),
    );
    expect(plan.create).toEqual([{ entry: e('b', 't2', 2, 'a'), parentId: 5 }]);
  });

  it('never hangs an entry with an unknown parent key off the root: it is deferred', () => {
    const nodes = new Map([[1, node(1, ['t2'])]]);
    const plan = planSpawnTree(1, nodes, [e('b', 't2', 2, 'a')], () => false);
    expect(plan.create).toEqual([]);
    expect(plan.deferred).toEqual([e('b', 't2', 2, 'a')]);
  });

  it('skips already tracked transcripts', () => {
    const nodes = new Map([[1, node(1, ['t1'])]]);
    expect(planSpawnTree(1, nodes, [e('a', 't1', 1)], () => true).create).toEqual([]);
  });
});

describe('subtreeRemovalOrder', () => {
  it('returns leaves first and the removed node last', () => {
    const parentOf = new Map<number, number | undefined>([
      [1, undefined],
      [5, 1],
      [6, 5],
      [7, 5],
      [8, 6],
    ]);
    const order = subtreeRemovalOrder(5, parentOf);
    expect(order[order.length - 1]).toBe(5);
    expect(order.indexOf(8)).toBeLessThan(order.indexOf(6));
    expect(new Set(order)).toEqual(new Set([5, 6, 7, 8]));
  });
});
```

- [ ] **Step 2: Ver fallar** — Run: `npx vitest run server/__tests__/spawnTree.test.ts` → FAIL (módulo no existe).

- [ ] **Step 3: Implementar `server/src/spawnTree.ts`**

```ts
/**
 * Pure planning for the spawn tree (docs/adr/0002). The runtime hands in the
 * current tree nodes and the provider's spawn entries; this decides which
 * entries become derived agents now, under which parent, and which must wait
 * for their parent node to exist. No I/O, no store access.
 */
export interface SpawnEntry {
  /* como en Interfaces */
}
export interface SpawnTreeNode {
  /* como en Interfaces */
}
export interface SpawnPlan {
  /* como en Interfaces */
}

export function planSpawnTree(
  rootId: number,
  nodes: ReadonlyMap<number, SpawnTreeNode>,
  entries: readonly SpawnEntry[],
  isTracked: (jsonlPath: string) => boolean,
): SpawnPlan {
  const byKey = new Map<string, SpawnTreeNode>();
  for (const n of nodes.values()) if (n.spawnAgentKey) byKey.set(n.spawnAgentKey, n);
  const root = nodes.get(rootId);
  const plan: SpawnPlan = { create: [], deferred: [] };
  if (!root) return plan;

  for (const entry of entries) {
    if (isTracked(entry.jsonlPath)) continue;
    const parent = entry.parentAgentKey === undefined ? root : byKey.get(entry.parentAgentKey);
    if (!parent) {
      plan.deferred.push(entry);
      continue;
    }
    // Anti-spurious gate: only a spawn its parent is running RIGHT NOW.
    if (!parent.liveSpawnToolIds.has(entry.toolUseId)) continue;
    plan.create.push({ entry, parentId: parent.id });
  }
  return plan;
}

export function subtreeRemovalOrder(
  rootOfRemoval: number,
  parentOf: ReadonlyMap<number, number | undefined>,
): number[] {
  const children = new Map<number, number[]>();
  for (const [id, parent] of parentOf) {
    if (parent === undefined) continue;
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }
  const order: number[] = [];
  const visit = (id: number): void => {
    for (const c of children.get(id) ?? []) visit(c);
    order.push(id);
  };
  visit(rootOfRemoval);
  return order;
}
```

- [ ] **Step 4: Verde** — Run: `npx vitest run server/__tests__/spawnTree.test.ts` → PASS.

- [ ] **Step 5: Reportar al líder.**

---

### T4: Modelo de scope y generador de layout (webview, puro)

**Files:**

- Create: `webview-ui/src/office/scope/agentDirectory.ts`
- Create: `webview-ui/src/office/scope/scopeLayoutGenerator.ts`
- Test: `webview-ui/test/agentDirectory.test.ts`, `webview-ui/test/scopeLayoutGenerator.test.ts`

**Interfaces:**

- Produces:

```ts
// agentDirectory.ts — DOM-free, always-current view of every agent the server announced.
export interface DirectoryAgent {
  id: number;
  parentAgentId?: number;
  role?: string;
  label?: string;
  depth?: number;
  agentName?: string;
  palette?: number;
  hueShift?: number;
  folderName?: string;
  status: 'active' | 'waiting' | null;
  /** toolId → { status text, toolName } of still-running tools. */
  tools: Map<string, { status: string; toolName?: string }>;
  permission: boolean;
}
export type ScopeId = 'root' | number;
export class AgentDirectory {
  upsert(id: number, fields: Partial<Omit<DirectoryAgent, 'id' | 'tools'>>): DirectoryAgent;
  remove(id: number): void;
  get(id: number): DirectoryAgent | undefined;
  childrenOf(id: number): number[];
  membersOf(scope: ScopeId): number[]; // root → agents without parent; n → [n, ...childrenOf(n)]
  liveChildCount(id: number): number;
  /** True when any strict descendant of `id` has permission=true. */
  hasPermissionBelow(id: number): boolean;
  /** Nearest existing ancestor scope for a scope whose owner disappeared ('root' if none). */
  nearestLiveScope(
    scope: ScopeId,
    lastKnownParents: ReadonlyMap<number, number | undefined>,
  ): ScopeId;
  setStatus(id: number, status: 'active' | 'waiting'): void;
  toolStart(id: number, toolId: string, status: string, toolName?: string): void;
  toolDone(id: number, toolId: string): void;
  toolsClear(id: number): void;
  setPermission(id: number, on: boolean): void;
}

// scopeLayoutGenerator.ts
export interface ScopeFurnitureKit {
  desk: string;
  chair: string;
  monitor: string;
} // asset type ids
export function generateScopeLayout(memberCount: number, kit: ScopeFurnitureKit): OfficeLayout;
/** Kit from the loaded catalog, or null if a required asset is missing. */
export const DEFAULT_SCOPE_KIT: ScopeFurnitureKit = {
  desk: 'DESK_FRONT',
  chair: 'CUSHIONED_CHAIR_BACK',
  monitor: 'PC_FRONT_OFF',
};
```

- [ ] **Step 1: Tests que fallan** (`webview-ui/test/agentDirectory.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { AgentDirectory } from '../src/office/scope/agentDirectory.js';

function tree(): AgentDirectory {
  const d = new AgentDirectory();
  d.upsert(1, {}); // root session
  d.upsert(10, { parentAgentId: 1 }); // lider F1
  d.upsert(11, { parentAgentId: 10 }); // dev a
  d.upsert(12, { parentAgentId: 11 }); // qa of dev a
  d.upsert(2, {}); // another root session
  return d;
}

describe('AgentDirectory', () => {
  it('root scope holds only top-level agents', () => {
    expect(tree().membersOf('root').sort()).toEqual([1, 2]);
  });
  it('a scope holds its owner and direct children only', () => {
    expect(tree().membersOf(10)).toEqual([10, 11]);
  });
  it('counts live direct children', () => {
    expect(tree().liveChildCount(1)).toBe(1);
    expect(tree().liveChildCount(12)).toBe(0);
  });
  it('bubbles a permission request up to every ancestor', () => {
    const d = tree();
    d.setPermission(12, true);
    expect(d.hasPermissionBelow(1)).toBe(true);
    expect(d.hasPermissionBelow(10)).toBe(true);
    expect(d.hasPermissionBelow(12)).toBe(false);
    expect(d.hasPermissionBelow(2)).toBe(false);
  });
  it('bounces to the nearest living ancestor when a scope owner disappears', () => {
    const d = tree();
    const parents = new Map<number, number | undefined>([
      [11, 10],
      [10, 1],
    ]);
    d.remove(12);
    d.remove(11);
    expect(d.nearestLiveScope(11, parents)).toBe(10);
    d.remove(10);
    expect(d.nearestLiveScope(11, parents)).toBe(1);
    d.remove(1);
    expect(d.nearestLiveScope(11, parents)).toBe('root');
  });
  it('tracks running tools for replay', () => {
    const d = tree();
    d.toolStart(11, 't1', 'Editing Login.java', 'Edit');
    d.toolStart(11, 't2', 'Running mvn test', 'Bash');
    d.toolDone(11, 't1');
    expect([...d.get(11)!.tools.keys()]).toEqual(['t2']);
    d.toolsClear(11);
    expect(d.get(11)!.tools.size).toBe(0);
  });
});
```

(`webview-ui/test/scopeLayoutGenerator.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { SCOPE_SLOTS_PER_ROW } from '../src/constants.js';
import {
  DEFAULT_SCOPE_KIT,
  generateScopeLayout,
} from '../src/office/scope/scopeLayoutGenerator.js';
import { TileType } from '../src/office/types.js';

const chairs = (n: number) =>
  generateScopeLayout(n, DEFAULT_SCOPE_KIT).furniture.filter(
    (f) => f.type === DEFAULT_SCOPE_KIT.chair,
  );

describe('generateScopeLayout', () => {
  it('has one workstation per member', () => {
    for (const n of [1, 2, 3, 5, 9, 17]) expect(chairs(n)).toHaveLength(n);
  });
  it('is deterministic (same input, same uids and positions)', () => {
    expect(generateScopeLayout(4, DEFAULT_SCOPE_KIT)).toEqual(
      generateScopeLayout(4, DEFAULT_SCOPE_KIT),
    );
  });
  it('keeps existing workstation uids when it grows', () => {
    const small = new Set(chairs(3).map((f) => `${f.uid}@${f.col},${f.row}`));
    const big = new Set(chairs(3 + SCOPE_SLOTS_PER_ROW).map((f) => `${f.uid}@${f.col},${f.row}`));
    for (const k of small) expect(big.has(k)).toBe(true);
  });
  it('fits the grid limits and has a wall top row', () => {
    const l = generateScopeLayout(17, DEFAULT_SCOPE_KIT);
    expect(l.cols).toBeLessThanOrEqual(64);
    expect(l.rows).toBeLessThanOrEqual(64);
    expect(l.tiles.slice(0, l.cols).every((t) => t === TileType.WALL)).toBe(true);
    expect(l.tiles.length).toBe(l.cols * l.rows);
  });
});
```

- [ ] **Step 2: Ver fallar** — Run: `npx vitest run --root webview-ui test/agentDirectory.test.ts test/scopeLayoutGenerator.test.ts` → FAIL.

- [ ] **Step 3: Implementar `agentDirectory.ts`** (clase con `Map<number, DirectoryAgent>`; `upsert` crea con `status: null, tools: new Map(), permission: false` si no existe y hace merge de campos; `childrenOf` filtra por `parentAgentId`; `hasPermissionBelow` recorre `childrenOf` recursivamente; `nearestLiveScope(scope, parents)`: si `scope === 'root'` o existe → `scope`; si no, sube por `parents` hasta encontrar un id existente, o `'root'`).

- [ ] **Step 4: Implementar `scopeLayoutGenerator.ts`**

```ts
import { SCOPE_SLOTS_PER_ROW, SCOPE_SLOT_H, SCOPE_SLOT_W } from '../../constants.js';
import type { OfficeLayout, PlacedFurniture } from '../types.js';
import { TileType } from '../types.js';

export interface ScopeFurnitureKit {
  desk: string;
  chair: string;
  monitor: string;
}
export const DEFAULT_SCOPE_KIT: ScopeFurnitureKit = {
  desk: 'DESK_FRONT',
  chair: 'CUSHIONED_CHAIR_BACK',
  monitor: 'PC_FRONT_OFF',
};

/** Slot 0 is the scope owner's (top row, centered); slots 1.. are children,
 *  filled row-major below it. Slot positions depend only on the slot index
 *  and the row width, so growing the room never moves an existing desk. */
export function generateScopeLayout(memberCount: number, kit: ScopeFurnitureKit): OfficeLayout {
  const count = Math.max(1, memberCount);
  const perRow = SCOPE_SLOTS_PER_ROW;
  const childRows = Math.ceil((count - 1) / perRow);
  const cols = 2 + perRow * SCOPE_SLOT_W;
  const rows = 2 + (1 + childRows) * SCOPE_SLOT_H + 1;
  const tiles: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const edge = r === 0 || c === 0 || c === cols - 1;
      tiles.push(edge ? TileType.WALL : TileType.FLOOR_1);
    }
  }
  const furniture: PlacedFurniture[] = [];
  const place = (slot: number, col: number, row: number): void => {
    furniture.push({ uid: `scope-desk-${slot}`, type: kit.desk, col, row });
    furniture.push({ uid: `scope-pc-${slot}`, type: kit.monitor, col: col + 1, row });
    furniture.push({ uid: `scope-chair-${slot}`, type: kit.chair, col: col + 1, row: row + 2 });
  };
  place(0, 1 + Math.floor((perRow - 1) / 2) * SCOPE_SLOT_W, 2);
  for (let i = 1; i < count; i++) {
    const k = i - 1;
    place(i, 1 + (k % perRow) * SCOPE_SLOT_W, 2 + (1 + Math.floor(k / perRow)) * SCOPE_SLOT_H);
  }
  return { version: 1, cols, rows, tiles, furniture } as OfficeLayout;
}
```

(Ajustar el cast a la forma exacta de `OfficeLayout` en `webview-ui/src/office/types.ts`; si `tiles` es `TileType[]`, tipar el array así.)

- [ ] **Step 5: Verde** — mismo comando del Step 2 → PASS. Además `npm run lint` (ninguna constante inline).

- [ ] **Step 6: Reportar al líder.**

---

### T5: Parser de feed de Claude y diff de fragmentos

**Files:**

- Create: `server/src/feedDiff.ts`
- Create: `server/src/providers/hook/claude/claudeFeed.ts`
- Test: `server/__tests__/feedDiff.test.ts`, `server/__tests__/claudeFeed.test.ts`

**Interfaces:**

- Consumes: `FeedEntry`, `FeedDetail`, `FeedDiffLine` de `core/src/messages.ts` (S1); `FEED_ENTRY_DETAIL_MAX_BYTES` (S1).
- Produces:
  - `snippetDiff(oldText: string, newText: string): FeedDiffLine[]`
  - `capDetail(detail: FeedDetail): FeedDetail` (trunca a `FEED_ENTRY_DETAIL_MAX_BYTES`, marca `truncated`)
  - `stripAnsi(text: string): string`
  - `parseClaudeFeedEntries(record: Record<string, unknown>): Array<Omit<FeedEntry, 'seq'>>` — lo registra S2 como `claudeProvider.parseFeedEntries`.

- [ ] **Step 1: Tests que fallan**

```ts
// feedDiff.test.ts
import { describe, expect, it } from 'vitest';
import { capDetail, snippetDiff, stripAnsi } from '../src/feedDiff.js';
import { FEED_ENTRY_DETAIL_MAX_BYTES } from '../src/constants.js';

describe('snippetDiff', () => {
  it('keeps common prefix/suffix lines as context and marks the middle', () => {
    expect(snippetDiff('a\nb\nc', 'a\nX\nc')).toEqual([
      { op: 'context', text: 'a' },
      { op: 'remove', text: 'b' },
      { op: 'add', text: 'X' },
      { op: 'context', text: 'c' },
    ]);
  });
  it('treats an empty old text as a pure addition', () => {
    expect(snippetDiff('', 'x\ny')).toEqual([
      { op: 'add', text: 'x' },
      { op: 'add', text: 'y' },
    ]);
  });
});

describe('capDetail', () => {
  it('truncates oversize output and flags it', () => {
    const d = capDetail({ type: 'output', text: 'x'.repeat(FEED_ENTRY_DETAIL_MAX_BYTES + 10) });
    expect(d.truncated).toBe(true);
    expect(Buffer.byteLength(d.text ?? '')).toBeLessThanOrEqual(FEED_ENTRY_DETAIL_MAX_BYTES);
  });
});

it('stripAnsi removes color codes', () => {
  expect(stripAnsi('\u001b[32mok\u001b[0m')).toBe('ok');
});
```

```ts
// claudeFeed.test.ts
import { describe, expect, it } from 'vitest';
import { parseClaudeFeedEntries } from '../src/providers/hook/claude/claudeFeed.js';

const assistant = (content: unknown[]) => ({
  type: 'assistant',
  timestamp: '2026-09-23T10:00:00Z',
  message: { content },
});

describe('parseClaudeFeedEntries', () => {
  it('emits assistant text', () => {
    expect(parseClaudeFeedEntries(assistant([{ type: 'text', text: 'Voy a revisar' }]))).toEqual([
      { ts: '2026-09-23T10:00:00Z', kind: 'text', summary: 'Voy a revisar' },
    ]);
  });
  it('emits an Edit as a tool entry with a diff', () => {
    const [e] = parseClaudeFeedEntries(
      assistant([
        {
          type: 'tool_use',
          id: 't1',
          name: 'Edit',
          input: {
            file_path: '/r/src/Login.java',
            old_string: 'return token;',
            new_string: 'return refresh(token);',
          },
        },
      ]),
    );
    expect(e).toMatchObject({
      kind: 'tool',
      toolId: 't1',
      toolName: 'Edit',
      summary: 'Edit Login.java',
    });
    expect(e.detail).toEqual({
      type: 'diff',
      lines: [
        { op: 'remove', text: 'return token;' },
        { op: 'add', text: 'return refresh(token);' },
      ],
    });
  });
  it('emits a Bash tool entry with its command and the result as output', () => {
    const [tool] = parseClaudeFeedEntries(
      assistant([{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'mvn -q test' } }]),
    );
    expect(tool.summary).toBe('Bash: mvn -q test');
    const [res] = parseClaudeFeedEntries({
      type: 'user',
      timestamp: '',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't2',
            content: [{ type: 'text', text: '\u001b[32mTests run: 12\u001b[0m' }],
          },
        ],
      },
    });
    expect(res).toMatchObject({
      kind: 'toolResult',
      toolId: 't2',
      detail: { type: 'output', text: 'Tests run: 12' },
    });
  });
  it('marks failed tool results', () => {
    const [res] = parseClaudeFeedEntries({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'boom' }],
      },
    });
    expect(res.isError).toBe(true);
  });
  it('ignores records it does not understand', () => {
    expect(parseClaudeFeedEntries({ type: 'queue-operation' })).toEqual([]);
    expect(parseClaudeFeedEntries({ type: 'user', message: { content: 'plain prompt' } })).toEqual(
      [],
    );
  });
});
```

- [ ] **Step 2: Ver fallar** — Run: `npx vitest run server/__tests__/feedDiff.test.ts server/__tests__/claudeFeed.test.ts` → FAIL.

- [ ] **Step 3: Implementar `feedDiff.ts`**

```ts
import type { FeedDetail, FeedDiffLine } from '../../core/src/messages.js';
import { FEED_ENTRY_DETAIL_MAX_BYTES } from './constants.js';

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** Edit snippets are small; a prefix/suffix trim reads well and never explodes. */
export function snippetDiff(oldText: string, newText: string): FeedDiffLine[] {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  )
    suf++;
  return [
    ...a.slice(0, pre).map((text) => ({ op: 'context' as const, text })),
    ...a.slice(pre, a.length - suf).map((text) => ({ op: 'remove' as const, text })),
    ...b.slice(pre, b.length - suf).map((text) => ({ op: 'add' as const, text })),
    ...a.slice(a.length - suf).map((text) => ({ op: 'context' as const, text })),
  ];
}

export function capDetail(detail: FeedDetail): FeedDetail {
  if (detail.type === 'output' && detail.text !== undefined) {
    if (Buffer.byteLength(detail.text) <= FEED_ENTRY_DETAIL_MAX_BYTES) return detail;
    const cut = Buffer.from(detail.text).subarray(0, FEED_ENTRY_DETAIL_MAX_BYTES).toString('utf8');
    return { ...detail, text: cut.replace(/�$/, ''), truncated: true };
  }
  if (detail.type === 'diff' && detail.lines) {
    let bytes = 0;
    const kept: FeedDiffLine[] = [];
    for (const l of detail.lines) {
      bytes += Buffer.byteLength(l.text) + 1;
      if (bytes > FEED_ENTRY_DETAIL_MAX_BYTES) return { ...detail, lines: kept, truncated: true };
      kept.push(l);
    }
  }
  return detail;
}
```

(Si el generador de Modelina tipa `op` como union de strings o como tipo propio, ajustar el `as const`.)

- [ ] **Step 4: Implementar `claudeFeed.ts`**

```ts
import * as path from 'path';

import type { FeedEntry } from '../../../../../core/src/messages.js';
import { capDetail, snippetDiff, stripAnsi } from '../../../feedDiff.js';

type Draft = Omit<FeedEntry, 'seq'>;

function toolSummary(name: string, input: Record<string, unknown>): string {
  const file = typeof input.file_path === 'string' ? path.basename(input.file_path) : undefined;
  switch (name) {
    case 'Bash':
      return `Bash: ${String(input.command ?? '').split('\n')[0]}`;
    case 'Grep':
      return `Grep "${String(input.pattern ?? '')}"`;
    case 'Glob':
      return `Glob ${String(input.pattern ?? '')}`;
    case 'Agent':
    case 'Task':
      return `${name}: ${String(input.description ?? input.subagent_type ?? '')}`;
    default:
      return file ? `${name} ${file}` : name;
  }
}

function toolDetail(name: string, input: Record<string, unknown>): FeedEntry['detail'] {
  if (name === 'Edit')
    return capDetail({
      type: 'diff',
      lines: snippetDiff(String(input.old_string ?? ''), String(input.new_string ?? '')),
    });
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const lines = (input.edits as Array<Record<string, unknown>>).flatMap((e) =>
      snippetDiff(String(e.old_string ?? ''), String(e.new_string ?? '')),
    );
    return capDetail({ type: 'diff', lines });
  }
  if (name === 'Write')
    return capDetail({ type: 'diff', lines: snippetDiff('', String(input.content ?? '')) });
  return undefined;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
          ? String((b as { text?: unknown }).text ?? '')
          : '',
      )
      .join('\n');
  }
  return '';
}

export function parseClaudeFeedEntries(record: Record<string, unknown>): Draft[] {
  const ts = typeof record.timestamp === 'string' ? record.timestamp : '';
  const message = record.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  const out: Draft[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (
      record.type === 'assistant' &&
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.trim()
    ) {
      out.push({ ts, kind: 'text', summary: block.text });
    } else if (record.type === 'assistant' && block.type === 'tool_use') {
      const name = String(block.name ?? '');
      const input = (block.input ?? {}) as Record<string, unknown>;
      const detail = toolDetail(name, input);
      out.push({
        ts,
        kind: 'tool',
        toolId: String(block.id ?? ''),
        toolName: name,
        summary: toolSummary(name, input),
        ...(detail ? { detail } : {}),
      });
    } else if (record.type === 'user' && block.type === 'tool_result') {
      const text = stripAnsi(resultText(block.content));
      const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
      out.push({
        ts,
        kind: 'toolResult',
        toolId: String(block.tool_use_id ?? ''),
        summary: firstLine.slice(0, 200),
        ...(block.is_error === true ? { isError: true } : {}),
        detail: capDetail({ type: 'output', text }),
      });
    }
  }
  return out;
}
```

- [ ] **Step 5: Verde** — Step 2 → PASS; `npm run check-types`.

- [ ] **Step 6: Reportar al líder.**

---

## S1b: Contrato de workflows (super-líder, antes de la Ola 2; spec §2.1b)

**Files:** `core/asyncapi.yaml` (+ regenerar `messages.ts`), `core/src/teamProvider.ts`, `server/src/types.ts`, `server/src/constants.ts`.

- [ ] **Step 1: contrato** — esquema nombrado `AgentNodeKind` (`type: string, enum: [agent, workflow]`) y propiedad `nodeKind: $ref AgentNodeKind` en `AgentCreated` y `AgentSeatMeta`. Regenerar sin `AnonymousSchema`.
- [ ] **Step 2: `TeamProvider`** (opcionales):

```ts
  /** A spawn-tool result that launched a scripted multi-agent run (Claude:
   *  the `Workflow` tool). `runDir` is where the run's agents write their
   *  transcripts; `name` is the run's display name. Null when not a launch. */
  extractWorkflowLaunch?(
    toolName: string,
    toolInput: Record<string, unknown>,
    resultContent: unknown,
  ): { runDir: string; name?: string } | null;

  /** Agents of one workflow run. Their sidecars carry no spawn tool id; the
   *  host gates them on the run being live. `label` is a short task line. */
  discoverWorkflowAgents?(runDir: string): Array<{
    jsonlPath: string;
    agentKey: string;
    parentAgentKey?: string;
    agentType: string;
    label?: string;
  }>;
```

- [ ] **Step 3: `AgentState`** — `nodeKind?: 'agent' | 'workflow'`; `workflowRunDir?: string` (solo nodos workflow). Constante `WORKFLOW_LABEL_MAX_CHARS = 80`.
- [ ] **Step 4:** `npm run compile`; commit `feat: Agregar contrato de nodos workflow`.

---

## Ola 2 (paralela; tras integrar la Ola 1)

### T6: Runtime — árbol recursivo, muerte en cascada y retiro del shadow store

**Files:**

- Modify: `server/src/fileWatcher.ts:788-953` (`liveSpawnToolIds`, `scanForBackgroundAgentFiles` → `scanSpawnTree`), setters `setSubagentWatch` (eliminar)
- Modify: `server/src/agentRuntime.ts:95-135` (callbacks) y `:308-338` (`removeAgent` en cascada)
- Modify: `server/src/transcriptParser.ts` (callback de spawn abierto/cerrado)
- Modify: `server/src/agentStateStore.ts:149-180` (sin cambios de lógica si `spawnToolUseId` sigue marcando derivados; verificar)
- Delete: `server/src/subagentWatch.ts`
- Modify test: `server/__tests__/backgroundAgents.test.ts`
- Create test: `server/__tests__/spawnTreeRuntime.test.ts`

**Interfaces:**

- Consumes: `planSpawnTree`, `subtreeRemovalOrder` (T3); campos de `discoverTeammates` (T1); `AgentState` tree fields (S1); `SessionRouter.registerSpawn/unregisterSpawn` (T2) vía `HookEventHandler.registerSpawn` que expone T7.
- Produces:
  - `scanSpawnTree(rootId, agents, nextAgentIdRef, fileWatchers, pollingTimers, waitingTimers, permissionTimers, onAgentCreated?)` exportada desde `fileWatcher.ts`.
  - `setSpawnTreeCallbacks({ onDerivedCreated(agent: AgentState): void; onDerivedRemoved(agent: AgentState): void })` en `fileWatcher.ts` (el runtime los usa para `registerSpawn`/`unregisterSpawn`).
  - `rootOf(agentId, agents): number` exportada desde `fileWatcher.ts` (sube por `parentAgentId`).
  - `setSpawnToolClosedCallback((agentId: number, toolUseId: string) => void)` en `transcriptParser.ts`: se invoca cuando el `tool_result` de una herramienta de spawn (en `subagentToolNames`) llega y el tool NO está en `backgroundAgentToolIds`.
  - `AgentRuntime.removeAgent(id)` elimina primero el subárbol (`subtreeRemovalOrder`).

- [ ] **Step 1: Test de integración que falla** (`spawnTreeRuntime.test.ts`; reutilizar `createLeadAgent` y los helpers de registros de `backgroundAgents.test.ts` — copiarlos, no importarlos de otro test)

Escenario A — profundidad 3:

1. Lead (id 1) procesa un `assistant` con `tool_use` `Agent` id `toolu_L` (primer plano).
2. Existe `subagents/agent-aaa.jsonl` + meta `{agentType:'lider-fase', toolUseId:'toolu_L', spawnDepth:1}`.
3. `scanSpawnTree(1, …)` → se crea un agente con `parentAgentId === 1`, `spawnAgentKey === 'aaa'`, `role === 'lider-fase'`, `depth === 1`.
4. Se escribe en `agent-aaa.jsonl` un `tool_use Agent` id `toolu_A`; `readNewLines` del nodo `aaa`.
5. Existe `agent-bbb.jsonl` + meta `{agentType:'desarrollador', toolUseId:'toolu_A', parentAgentId:'aaa', spawnDepth:2}`; `scanSpawnTree(1)` → nodo `bbb` con `parentAgentId` = id de `aaa`.
6. Repetir con `agent-ccc` (`qa-revisor`, `parentAgentId:'bbb'`, depth 3).

```ts
expect(byKey('ccc')).toMatchObject({
  parentAgentId: byKey('bbb').id,
  depth: 3,
  role: 'qa-revisor',
});
```

Escenario B — cascada: `runtime.removeAgent(idDe('aaa'))` → `store.get` de `aaa`, `bbb`, `ccc` es `undefined`; el lead sigue.

Escenario C — raíz termina: `onSessionEnd` del lead → no queda ningún agente con `parentAgentId` definido.

Escenario D — cierre de primer plano: el lead recibe el `tool_result` de `toolu_L` → `aaa` y su subárbol desaparecen.

Escenario E — nada se persiste: `store.persist()` con el adapter mock → el array guardado solo contiene el lead.

Escenario F — nieto antes que su padre: meta de `bbb` presente pero `aaa` aún no creado → `scanSpawnTree` no crea `bbb` ni lo cuelga del lead; tras crear `aaa` y ver `toolu_A`, el siguiente scan sí.

- [ ] **Step 2: Ver fallar** — Run: `npx vitest run server/__tests__/spawnTreeRuntime.test.ts` → FAIL (`scanSpawnTree` no existe).

- [ ] **Step 3: `scanSpawnTree` en `fileWatcher.ts`** (reemplaza `scanForBackgroundAgentFiles`; conservar el camino de **Teammate con nombre** tal cual — `agentName`, `isTeamLead`, `agentTeamInfo` — pero ahora también con `parentAgentId`)

```ts
export function rootOf(agentId: number, agents: AgentStateStore): number {
  let id = agentId;
  for (let a = agents.get(id); a?.parentAgentId !== undefined; a = agents.get(id))
    id = a.parentAgentId;
  return id;
}

export function scanSpawnTree(
  rootId: number,
  agents: AgentStateStore,
  nextAgentIdRef: { current: number },
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  onAgentCreated?: (agent: AgentState) => void,
): void {
  if (!teamProvider) return;
  const root = agents.get(rootId);
  if (!root || !root.sessionId || !root.projectDir || root.parentAgentId !== undefined) return;

  const nodes = new Map<number, SpawnTreeNode>();
  for (const [id, a] of agents) {
    if (id === rootId || (a.parentAgentId !== undefined && rootOf(id, agents) === rootId)) {
      nodes.set(id, { id, spawnAgentKey: a.spawnAgentKey, liveSpawnToolIds: liveSpawnToolIds(a) });
    }
  }
  if (![...nodes.values()].some((n) => n.liveSpawnToolIds.size > 0)) return;

  const entries: SpawnEntry[] = [];
  for (const t of teamProvider.discoverTeammates(root.projectDir, root.sessionId)) {
    if (!t.agentKey || !t.toolUseId) continue;
    entries.push({
      jsonlPath: t.jsonlPath,
      agentKey: t.agentKey,
      parentAgentKey: t.parentAgentKey,
      toolUseId: t.toolUseId,
      depth: t.depth ?? 1,
      agentType: t.agentType ?? t.teammateName,
      description: t.description,
      name: t.name,
    });
  }
  const isTracked = (p: string) => [...agents.values()].some((a) => pathsMatch(a.jsonlFile, p));
  const plan = planSpawnTree(rootId, nodes, entries, isTracked);

  for (const { entry, parentId } of plan.create) {
    const parent = agents.get(parentId)!;
    const id = nextAgentIdRef.current++;
    const agent: AgentState = {
      id,
      sessionId: root.sessionId,
      terminalRef: undefined,
      isExternal: true,
      projectDir: root.projectDir,
      jsonlFile: entry.jsonlPath,
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
      hookDelivered: false,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      contextTokens: 0,
      maxContextTokens: DEFAULT_MAX_CONTEXT_TOKENS,
      spawnToolUseId: entry.toolUseId,
      spawnAgentKey: entry.agentKey,
      parentAgentId: parentId,
      role: entry.agentType,
      label: entry.description,
      depth: entry.depth,
      ...(entry.name ? { agentName: entry.name, leadAgentId: parentId } : {}),
    };
    if (parent.palette !== undefined) {
      const siblingIndex = [...agents.values()].filter((a) => a.parentAgentId === parentId).length;
      agent.palette = parent.palette;
      agent.hueShift =
        ((parent.hueShift ?? 0) + SPAWN_SIBLING_HUE_STEP_DEG * (siblingIndex + 1)) % 360;
    } else assignPaletteIfNeeded(agent, agents);
    agents.set(id, agent);
    if (entry.name && !parent.isTeamLead) {
      /* bloque agentTeamInfo existente, con parentId */
    }
    // The parent's transient Subtask for this spawn is superseded by the real character.
    agents.broadcast({ type: 'subagentClear', id: parentId, parentToolId: entry.toolUseId });
    spawnTreeCallbacks?.onDerivedCreated(agent);
    onAgentCreated?.(agent);
    startFileWatching(
      id,
      entry.jsonlPath,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
    );
    readNewLines(id, agents, waitingTimers, permissionTimers);
  }
}
```

Borrar `setSubagentWatch`, la variable `subagentWatch` y toda referencia; quitar `scanForTeammateFiles`'s salto por `toolUseId` vivo solo si deja de ser necesario (mantenerlo: sigue evitando carreras con el flujo de Agent Teams).

- [ ] **Step 4: Disparadores en `agentRuntime.ts` y `transcriptParser.ts`**

- `setBackgroundAgentDetectedCallback((agentId) => this.scanTree(rootOf(agentId, this.store)))`.
- Nuevo: cuando `transcriptParser` registra un `tool_use` de herramienta en `subagentToolNames` en CUALQUIER agente (primer plano incluido), llamar al mismo callback (hoy solo se llama para async) — o, más simple, el escaneo periódico de 1 s (`startProjectScan`) llama `this.scanTree(rootId)` para cada raíz con spawns vivos en su árbol. Implementar ambos: el callback da latencia baja; el periódico, robustez.
- `setBackgroundAgentCompletedCallback((agentId, toolUseId) => …)`: buscar el hijo con `parentAgentId === agentId && spawnToolUseId === toolUseId` (antes era `leadAgentId`) y `this.removeAgent(childId)`.
- `setSpawnToolClosedCallback((agentId, toolUseId) => …)`: mismo borrado para spawns de primer plano.
- `setSpawnTreeCallbacks({ onDerivedCreated: (a) => this.hookEventHandler.registerSpawn(a.sessionId, a.spawnAgentKey!, a.id), onDerivedRemoved: (a) => this.hookEventHandler.unregisterSpawn(a.sessionId, a.spawnAgentKey!) })` — **si T7 aún no expone esos métodos, dejar el cableado para S2** (anotarlo en el reporte).
- `this.subagentWatch` desaparece (constructor, `removeByLead`, `removeBySpawn`).

`removeAgent` en cascada:

```ts
  removeAgent(id: number): void {
    if (!this.store.get(id)) return;
    const parentOf = new Map<number, number | undefined>();
    for (const [aid, a] of this.store) parentOf.set(aid, a.parentAgentId);
    for (const victim of subtreeRemovalOrder(id, parentOf)) this.removeSingleAgent(victim);
  }
```

con el cuerpo actual movido a `private removeSingleAgent(id)`, que además llama `spawnTreeCallbacks.onDerivedRemoved(agent)` si `agent.spawnAgentKey`.

- [ ] **Step 5: Adaptar `backgroundAgents.test.ts`**: los casos "unnamed → shadow store" pasan a esperar un agente derivado con `parentAgentId === 1` y sin `agentName`; los "named → teammate" esperan además `parentAgentId === 1`. Borrar las aserciones sobre `SubagentWatch`.

- [ ] **Step 6: Verde** — Run: `npx vitest run server/__tests__` → PASS. `npm run check-types` → PASS (sin referencias a `subagentWatch`).

- [ ] **Step 7: Reportar al líder** (incluir: qué cableado quedó pendiente para S2).

---

### T7: HookEventHandler — enrutar por `agentKey` (corrige el defecto)

**Files:**

- Modify: `server/src/hookEventHandler.ts:100-120` (registro), `:230-320` (resolución en `handleEvent`)
- Test: `server/__tests__/hookEventHandler.test.ts`

**Interfaces:**

- Consumes: `SessionRouter.registerSpawn/resolveSpawn/unregisterSpawn/bufferEvent(…, agentKey)` (T2); envelope `agentKey` (S1/T1).
- Produces:
  - `HookEventHandler.registerSpawn(sessionId: string, agentKey: string, agentId: number): void` (registra y re-despacha eventos bufferizados)
  - `HookEventHandler.unregisterSpawn(sessionId: string, agentKey: string): void`
  - Nuevo callback de ciclo de vida `onSpawnObserved?: (rootAgentId: number) => void` en las callbacks de `HookEventHandler`, invocado en `SubagentStart` con `agentKey` (para escanear el árbol sin esperar 1 s).

- [ ] **Step 1: Test rojo que reproduce el defecto** (antes de tocar código; depuración sistemática)

```ts
it('a tool event fired inside a subagent never animates the session root', () => {
  // Setup del archivo: handler con store, lead id 1 registrado para 'sess-1'.
  const broadcasts: Array<Record<string, unknown>> = [];
  store.on('broadcast', (m) => broadcasts.push(m));
  handler.handleEvent('claude', {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-1',
    agent_id: 'bbb222',
    agent_type: 'desarrollador',
    tool_name: 'Bash',
    tool_input: { command: 'mvn test' },
  });
  expect(
    broadcasts.filter(
      (m) => m.id === 1 && (m.type === 'agentToolStart' || m.type === 'agentStatus'),
    ),
  ).toEqual([]);
});
```

Run: `npx vitest run server/__tests__/hookEventHandler.test.ts -t "never animates"` → **FAIL** hoy (el lead recibe `agentToolStart`/`agentStatus: active`). Registrar la salida en el reporte: es la evidencia del defecto.

- [ ] **Step 2: Más tests que fallan**

```ts
it('routes a keyed event to the derived agent once registered, including buffered ones', () => {
  store.set(
    7,
    makeAgent({ id: 7, sessionId: 'sess-1', spawnAgentKey: 'bbb222', parentAgentId: 1 }),
  );
  const seen: Array<Record<string, unknown>> = [];
  store.on('broadcast', (m) => seen.push(m));
  handler.handleEvent('claude', {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-1',
    agent_id: 'bbb222',
    tool_name: 'Read',
    tool_input: { file_path: '/a.ts' },
  });
  expect(seen.some((m) => m.id === 7)).toBe(false); // not registered yet → buffered
  handler.registerSpawn('sess-1', 'bbb222', 7);
  expect(seen.some((m) => m.id === 7 && m.type === 'agentToolStart')).toBe(true);
  expect(seen.some((m) => m.id === 1 && m.type === 'agentToolStart')).toBe(false);
});

it('SubagentStart with agent_id asks the runtime to scan the tree', () => {
  const onSpawnObserved = vi.fn();
  // construir handler con callbacks { ..., onSpawnObserved }
  handler.handleEvent('claude', {
    hook_event_name: 'SubagentStart',
    session_id: 'sess-1',
    agent_id: 'bbb222',
    agent_type: 'Explore',
  });
  expect(onSpawnObserved).toHaveBeenCalledWith(1);
});

it('events without agent_id keep routing to the root as today', () => {
  handler.handleEvent('claude', {
    hook_event_name: 'PreToolUse',
    session_id: 'sess-1',
    tool_name: 'Read',
    tool_input: {},
  });
  expect(lastBroadcastFor(1)?.type).toBe('agentToolStart');
});
```

- [ ] **Step 3: Implementar**

En `handleEvent`, tras `normalizeHookEvent` (tomar `agentKey` del resultado):

```ts
const agentKey = normalized.agentKey;
if (
  agentKey !== undefined &&
  normEvent.kind !== 'subagentStart' &&
  normEvent.kind !== 'subagentEnd'
) {
  const derivedId = this.sessionRouter.resolveSpawn(event.session_id, agentKey);
  if (derivedId === undefined) {
    // The node is not materialized yet (scan runs every 1 s). Buffer; it
    // must never fall through to the session root — that was the bug.
    this.sessionRouter.bufferEvent(providerId, event, agentKey);
    return;
  }
  const derived = this.agents.get(derivedId);
  if (!derived) return;
  return this.dispatch(normEvent, derived, derivedId, event);
}
```

donde `dispatch` es el `switch (normEvent.kind)` actual extraído a un método privado (sin cambiar su contenido). Para `subagentStart` con `agentKey`: tras el manejo actual en el padre, `this.lifecycleCallbacks.onSpawnObserved?.(rootAgentIdDeLaSesion)`.

`registerSpawn` / `unregisterSpawn`:

```ts
  registerSpawn(sessionId: string, agentKey: string, agentId: number): void {
    const flushed = this.sessionRouter.registerSpawn(sessionId, agentKey, agentId);
    for (const b of flushed) this.handleEvent(b.providerId, b.event);
  }

  unregisterSpawn(sessionId: string, agentKey: string): void {
    this.sessionRouter.unregisterSpawn(sessionId, agentKey);
  }
```

- [ ] **Step 4: Verde** — Run: `npx vitest run server/__tests__/hookEventHandler.test.ts server/__tests__/sessionRouter.test.ts` → PASS, incluido el test del Step 1.

- [ ] **Step 5: Reportar al líder** con la salida roja del Step 1 y la verde del Step 4.

---

### T8: E2E — árbol de tres niveles (hooks OFF)

**Files:**

- Modify (si hace falta): `e2e/fixtures/mock-claude-runner.cjs`, `e2e/helpers/mock-claude.ts` — operación `writeFile(relPathFromProjectDir, content)` para escribir sidecars y transcripts de sub-agentes
- Create: `e2e/tests/claude/hooks-off/spawnTree.spec.ts`
- Modify: `e2e/README.md` (solo vía `npm run e2e:inventory`)

**Interfaces:**

- Consumes: comportamiento de S2 (agentCreated con `parentAgentId`/`role`/`label`; personajes derivados sentados en la raíz en la entrega 1).
- Produces: spec `spawnTree.spec.ts` con tag `@area:teams`.

- [ ] **Step 1: Leer `e2e/README.md` → "Mocking model & rules"** y seguirlo (append-only, afirmar sobre resultados visibles).
- [ ] **Step 2: Si el runner no puede escribir archivos arbitrarios bajo el project dir**, agregar `writeFile` al builder (`claudeScenario().at(ms).writeFile('<sessionId>/subagents/agent-aaa.meta.json', json)`), con test en `server/__tests__/mockClaudeRunner.test.ts`.
- [ ] **Step 3: Escenario**: lead abre `Agent` `toolu_L` → a los 500 ms escribe sidecar+transcript `aaa` (`lider-fase`, depth 1) → `aaa` abre `Agent` `toolu_A` → sidecar `bbb` (`desarrollador`, `parentAgentId: 'aaa'`, depth 2) → `bbb` abre `Agent` `toolu_B` → sidecar `ccc` (`qa-revisor`, `parentAgentId: 'bbb'`, depth 3) → `ccc` hace `Read` → `holdOpenFor(15000)`.
- [ ] **Step 4: Aserciones** (helpers de `e2e/helpers/office.ts`): aparecen 4 personajes; el overlay de `ccc` muestra la actividad de `Read`; el lead **no** muestra `Read` (defecto); al cerrar el `toolu_L` del lead con su `tool_result`, desaparecen `aaa`, `bbb`, `ccc`. Timeouts ≥ 10 s (escaneo 1 s + polling 500 ms por nivel × 3).
- [ ] **Step 5: Correr** — Run: `npm run e2e -- --workers=1 --grep "spawn tree"` → PASS; `npm run e2e:inventory`.
- [ ] **Step 6: Reportar al líder.**

---

### T16: Proveedor Claude — workflows

**Files:** Create `server/src/providers/hook/claude/claudeWorkflow.ts`, test `server/__tests__/claudeWorkflow.test.ts`. (El registro en `claudeTeamProvider` lo hace S2.)

**Interfaces:** Produces `extractClaudeWorkflowLaunch(toolName, toolInput, resultContent)` y `discoverClaudeWorkflowAgents(runDir)` con las firmas de S1b.

Reglas:

- Launch: `toolName === 'Workflow'` y el texto del resultado (string o bloques) contiene `Workflow launched`; `runDir` = valor tras `Transcript dir:` (hasta fin de línea, trim), aceptado solo si su basename casa con `/^wf_[A-Za-z0-9-]{1,64}$/` y su padre es `…/subagents/workflows`; `name` = `meta.name` extraído de `toolInput.script` con `/name:\s*['"]([^'"\n]{1,120})['"]/`, si no el texto tras `Summary:`; saneado con `sanitizeFeedText` y truncado a `WORKFLOW_LABEL_MAX_CHARS`.
- Agents: `agent-<key>.jsonl` del `runDir` con clave válida (`normalizeClaudeAgentKey` de T1), sidecar parseado con el mismo cuidado que T1 (archivo regular, ≤ 64 KB, caché por mtime+size); `parentAgentKey` con la regla de T1 (presente e inválido ⇒ omitir entrada); `label` = primera línea no vacía del primer registro `user` (leer solo los primeros 16 KB del `.jsonl`), saneada y truncada.

- [ ] **Step 1: tests rojos** con fixtures que copian la forma real (tool_result "Workflow launched in background. Task ID: w4eubwvnv\nSummary: …\nTranscript dir: C:\\…\\subagents\\workflows\\wf_9b94fdcd-8af"): launch reconocido con `name` desde el script; sin `Transcript dir` ⇒ null; `runDir` con `..` o basename inválido ⇒ null; resultados de otras herramientas ⇒ null; `discoverClaudeWorkflowAgents` devuelve clave/tipo/label y omite claves inválidas; transcript de 50 MB no se lee entero.
- [ ] **Step 2:** implementar. **Step 3:** verde (`npx vitest run __tests__/claudeWorkflow.test.ts`). **Step 4:** reportar.

---

### T17: Nodos workflow en el runtime (Ola 2b, tras T6)

**Files:** `server/src/fileWatcher.ts`, `server/src/transcriptParser.ts`, `server/src/agentRuntime.ts`; test `server/__tests__/workflowNodes.test.ts`.

**Interfaces:** Consumes `extractWorkflowLaunch`/`discoverWorkflowAgents` (T16 vía `TeamProvider`), `scanSpawnTree`/`rootOf`/`removeAgent` en cascada (T6), `registerSpawn` (T7).

- [ ] **Step 1: tests rojos** (`workflowNodes.test.ts`): (a) el lead procesa `tool_use Workflow` + su `tool_result` "launched" ⇒ se crea un agente con `nodeKind: 'workflow'`, `parentAgentId = lead`, `label` = nombre, sin watcher de archivo; (b) con 3 `agent-*.jsonl` en `runDir`, el escaneo crea 3 hijos del nodo workflow con `role`/`label`, `depth = nodo + 1`; (c) un `runDir` de un workflow ya completado (sin nodo vivo) no crea nada; (d) la `queue-operation` de completado con ese `tool-use-id` elimina el nodo y sus hijos; (e) estado derivado: un hijo activo ⇒ el nodo emite `agentStatus active`; todos en espera ⇒ `waiting`; (f) nada de esto se persiste; (g) el lead no queda con el `Workflow` como herramienta "activa" que dispare su timer de permiso.
- [ ] **Step 2: implementar** — en `transcriptParser`, al ver el `tool_result` de un `Workflow`, llamar `extractWorkflowLaunch`; si hay launch, callback al runtime que crea el nodo (registrar el `toolUseId` como spawn de fondo vivo del lead, como `backgroundAgentToolIds`); `scanSpawnTree` incluye, por cada nodo workflow vivo del árbol, las entradas de `discoverWorkflowAgents(runDir)` con padre = nodo (o su `parentAgentKey`); el completado reutiliza `setBackgroundAgentCompletedCallback`; estado derivado recalculado en `agentUpdated` de los hijos.
- [ ] **Step 3:** verde (`npx vitest run __tests__/workflowNodes.test.ts __tests__/spawnTreeRuntime.test.ts __tests__/backgroundAgents.test.ts`). **Step 4:** reportar.

---

### S2: Integración de la entrega 1 (super-líder)

**Files:** `server/src/agentRuntime.ts` (cableado pendiente), `server/src/httpServer.ts:172-185`, `adapters/vscode/PixelAgentsViewProvider.ts:123-136`, `server/src/clientMessageHandler.ts:480-499`, `server/src/providers/hook/claude/claude.ts` (registrar `parseFeedEntries: parseClaudeFeedEntries`), `webview-ui/src/hooks/useExtensionMessages.ts:247-290` (interim).

- [ ] **Step 1: Cableado runtime ↔ handler**: `setSpawnTreeCallbacks` → `hookEventHandler.registerSpawn/unregisterSpawn`; callback `onSpawnObserved: (rootId) => this.scanTree(rootId)`.
- [ ] **Step 2: `agentCreated` en ambos surfaces** — agregar:

```ts
        parentAgentId: agent.parentAgentId ?? agent.leadAgentId,
        role: agent.role,
        label: agent.label,
        depth: agent.depth,
        nodeKind: agent.nodeKind,
```

Además: registrar `extractWorkflowLaunch: extractClaudeWorkflowLaunch` y `discoverWorkflowAgents: discoverClaudeWorkflowAgents` en `claudeTeamProvider`; `nodeKind` también en `existingAgents.agentMeta`; en la webview, la etiqueta de un nodo `workflow` lleva el prefijo `⚙ `. Commits extra: `feat: Detectar workflows en el proveedor Claude` (T16), `feat: Representar workflows como nodos del árbol` (T17). E2E adicional en `spawnTree.spec.ts`: un `Workflow` lanzado con 2 agentes ⇒ aparece el nodo ⚙ con 2 hijos y desaparecen al completarse.

- [ ] **Step 3: `existingAgents.agentMeta`** en `clientMessageHandler.ts` agrega `parentAgentId: agent.parentAgentId ?? agent.leadAgentId, role, label, depth, teammateName: agent.agentName`. Test en `server/__tests__/clientMessageHandler.test.ts`: con un agente derivado en el store, `existingAgents.agentMeta[id]` trae `parentAgentId` y `role` (Review Focus 4).
- [ ] **Step 4: Webview interim** — en `agentCreated`, tratar `parentAgentId !== undefined` como el camino de teammate (heredar paleta, sentar cerca del padre), usando `msg.teammateName ?? msg.label` como nombre visible; en `existingAgents`, pasar `nearAgentId` del meta.
- [ ] **Step 5: Verificación completa** — Run: `npm run compile && npm test && npm run e2e -- --workers=1` → PASS.
- [ ] **Step 6: Prueba manual en navegador** (Claude in Chrome): `npm run build && node dist/cli.js --port 3100`, abrir la URL con `?token=` que imprime; en otra terminal lanzar una sesión real de Claude Code que use `/equipo` sobre una tarea trivial; verificar: personajes a profundidad ≥ 2, el líder no anima con la actividad de sus hijos, desaparición en cascada. GIF `entrega1-arbol.gif`.
- [ ] **Step 7: Commits** (uno por tarea validada, en orden): `feat: Exponer metadatos de spawn en el proveedor Claude` (T1), `feat: Enrutar sesiones por clave de agente derivado` (T2), `feat: Agregar planificador puro del árbol de spawns` (T3), `feat: Materializar el árbol de agentes recursivamente` (T6), `fix: Evitar que la actividad de un sub-agente anime a su padre` (T7), `test: Agregar e2e de árbol de agentes de tres niveles` (T8), `feat: Integrar el árbol de agentes en ambos surfaces` (S2). Todos con la línea `Co-Authored-By` de la sesión.
- [ ] **Step 8: Revisión del usuario** (cadencia por olas). No seguir a la Ola 3 sin su visto bueno.

---

## Ola 3 (paralela; entrega 2)

### T9: Directorio de agentes y OfficeRegistry — enrutado de mensajes por oficina

**Files:**

- Create: `webview-ui/src/office/scope/officeRegistry.ts`
- Modify: `webview-ui/src/hooks/useExtensionMessages.ts`
- Test: `webview-ui/test/officeRegistry.test.ts`

**Interfaces:**

- Consumes: `AgentDirectory`, `generateScopeLayout`, `DEFAULT_SCOPE_KIT` (T4); `OfficeState` (`addAgent`, `removeAgent`, `rebuildFromLayout`).
- Produces:

```ts
export class OfficeRegistry {
  constructor(root: OfficeState, directory: AgentDirectory, createOffice: () => OfficeState);
  readonly directory: AgentDirectory;
  readonly root: OfficeState;
  get activeScope(): ScopeId;
  get activeOffice(): OfficeState; // root when activeScope === 'root'
  /** Build the scope office (generated layout), seat owner at slot 0, children after, replay directory activity. */
  enter(scope: ScopeId): void;
  /** Offices currently showing agent `id` (root and/or the active scope office). */
  officesShowing(id: number): OfficeState[];
  /** Call after any agent add/remove: grows the room, seats newcomers, or bounces when the owner is gone. Returns the scope after reconciliation. */
  reconcile(): ScopeId;
  onChange(fn: () => void): () => void;
}
```

- [ ] **Step 1: Tests que fallan** — con un `OfficeState` real (los tests de webview ya instancian `OfficeState` en Node, ver `teammateSeating.test.ts`):
  - `enter(10)` → `activeOffice.characters` tiene exactamente `{10, 11}`; la raíz conserva sus personajes.
  - `officesShowing(11)` con scope 10 activo → `[scopeOffice]`; `officesShowing(1)` → `[root]`; `officesShowing(10)` → `[scopeOffice]` (en la raíz no está: es hijo de 1).
  - Replay: `directory.toolStart(11, 't', 'Editing', 'Edit')` antes de `enter(10)` → el personaje 11 en la oficina de scope está activo (`isActive`/estado TYPE, según la API de `OfficeState` usada por `agentToolStart`).
  - Crecimiento: estando en scope 10, `directory.upsert(13, { parentAgentId: 10 })` + `reconcile()` → personaje 13 sentado; los asientos de 10 y 11 no cambian.
  - Rebote (Review Focus 5): estando en scope 11, `directory.remove(11)` + `reconcile()` → `activeScope === 10` tras `SCOPE_OWNER_GONE_BOUNCE_MS` (fake timers).
- [ ] **Step 2: Ver fallar** — `npx vitest run --root webview-ui test/officeRegistry.test.ts`.
- [ ] **Step 3: Implementar `officeRegistry.ts`** — `enter(scope)`: si `'root'`, activo = raíz; si no, `createOffice()`, `rebuildFromLayout(generateScopeLayout(members.length, kit))`, `addAgent(id, palette, hueShift, seatId='scope-chair-<slot>', skipSpawnEffect=true)` por miembro (dueño slot 0), luego replay: `status`, cada tool en `tools`, `permission`. Guardar `lastKnownParents` para `nearestLiveScope`.
- [ ] **Step 4: Refactor de `useExtensionMessages.ts`** — recibir `registry: OfficeRegistry` en lugar de `getOfficeState`. Regla mecánica por mensaje:
  - mensajes sin `id` de agente (layout, assets, settings) → `registry.root`;
  - `agentCreated` / `existingAgents` → `directory.upsert(...)`; si el agente no tiene padre → `root.addAgent(...)` (camino actual); después `registry.reconcile()`;
  - `agentClosed` → `directory.remove(id)`, `for (const os of registry.officesShowing(id)) os.removeAgent(id)`, `registry.reconcile()`;
  - `agentStatus`, `agentToolStart/Done/Clear`, `agentToolPermission(Clear)`, `agentContextUsage`, `subagent*` → actualizar `directory` y aplicar la lógica actual a cada `os` de `registry.officesShowing(msg.id)`.
    Quitar el camino interim de S2 (sentar derivados en la raíz).
- [ ] **Step 5: Verde** — `npm run test:webview` y `npm run check-types`.
- [ ] **Step 6: Reportar al líder.**

---

### T10: UI de navegación — insignias, migas de pan, doble clic

**Files:**

- Create: `webview-ui/src/components/ScopeBreadcrumbs.tsx`
- Create: `webview-ui/src/office/components/ScopeBadgeOverlay.tsx`
- Modify: `webview-ui/src/office/components/OfficeCanvas.tsx` (prop `onDoubleClick?: (agentId: number) => void`, reutilizando el hit-test de `onClick`)
- Test: `webview-ui/test/scopeBreadcrumbs.test.ts` (función pura `breadcrumbTrail`)

**Interfaces:**

- Consumes: `AgentDirectory`, `ScopeId` (T4); `overlayProjection`/`mapOffset` de `office/projection.ts`; constantes `SCOPE_BADGE_BG`, `SCOPE_BADGE_ALERT_BG` (S1).
- Produces:

```ts
// ScopeBreadcrumbs.tsx
export function breadcrumbTrail(
  directory: AgentDirectory,
  scope: ScopeId,
): Array<{ scope: ScopeId; text: string }>;
export function ScopeBreadcrumbs(props: {
  directory: AgentDirectory;
  scope: ScopeId;
  onNavigate: (s: ScopeId) => void;
}): JSX.Element | null; // null en root
// ScopeBadgeOverlay.tsx
export function ScopeBadgeOverlay(props: {
  officeState: OfficeState;
  directory: AgentDirectory;
  activeScope: ScopeId;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  onEnterScope: (id: number) => void;
}): JSX.Element;
```

- [ ] **Step 1: Test de `breadcrumbTrail`**: árbol 1→10→11; `breadcrumbTrail(d, 11)` → `[{scope:'root',text:'Oficina'},{scope:1,text:<label|agentName|'Agente #1'>},{scope:10,…},{scope:11,…}]`; texto = `agentName ?? label ?? role ?? 'Agente #' + id`, recortado a 24 caracteres con `…`.
- [ ] **Step 2: Implementar `ScopeBreadcrumbs`** — barra arriba-izquierda, estilo pixel (fondo `var(--pixel-bg)`, borde `2px solid var(--pixel-border)`, sombra `var(--pixel-shadow)`, `borderRadius: 0`), tramos clicables separados por `›`; el último no es clicable.
- [ ] **Step 3: Implementar `ScopeBadgeOverlay`** — por cada personaje de `officeState` con `directory.liveChildCount(id) > 0` y que NO sea el dueño del scope activo: botón `▸N` sobre la cabeza (misma proyección que `ToolOverlay`), fondo `SCOPE_BADGE_ALERT_BG` si `directory.hasPermissionBelow(id)`, si no `SCOPE_BADGE_BG`; `onClick` → `onEnterScope(id)`; `title` = "Entrar a la oficina de …".
- [ ] **Step 4: `OfficeCanvas` doble clic** — `onDoubleClick` en el canvas usando el mismo hit-test que el clic; si hay personaje, `onDoubleClick?.(id)`. El clic simple no cambia.
- [ ] **Step 5: Verde** — `npm run test:webview && npm run lint`.
- [ ] **Step 6: Reportar al líder.**

---

### S3: Integración de la entrega 2 (super-líder)

**Files:** `webview-ui/src/App.tsx`, `webview-ui/src/office/components/ToolOverlay.tsx` (recibe la oficina activa), `e2e/tests/claude/hooks-off/scopeOffices.spec.ts`.

- [ ] **Step 1: `App.tsx`** — reemplazar `officeStateRef`/`getOfficeState()` por un `OfficeRegistry` (raíz = la `OfficeState` actual; `createOffice = () => new OfficeState()`); `getOfficeState()` devuelve `registry.activeOffice` para el editor y el canvas; estado React `activeScope` sincronizado con `registry.onChange`. Renderizar `ScopeBreadcrumbs` y `ScopeBadgeOverlay`; `onDoubleClick` y la insignia → `registry.enter(id)` si `liveChildCount(id) > 0`. `Esc` (fuera de edición) → subir un nivel. Botón "Layout" deshabilitado fuera de la raíz. `installTestHooks` expone `registry` para e2e.
- [ ] **Step 2: E2E** `scopeOffices.spec.ts` (reutiliza el escenario de T8): insignia `▸1` sobre el lead en la raíz; clic → migas `Oficina › …`; dentro, insignia sobre `aaa`; entrar a `bbb`; el lead cierra `toolu_L` → a los ~2 s se vuelve a la raíz (Review Focus 5); un permiso en `ccc` (7 s de timer heurístico) pinta ámbar la insignia del lead en la raíz.
- [ ] **Step 3: Verificación** — `npm run compile && npm test && npm run e2e -- --workers=1`; prueba en navegador con una sesión `/equipo` real; GIF `entrega2-oficinas.gif`.
- [ ] **Step 4: Commits**: `feat: Agregar directorio de agentes y registro de oficinas por scope` (T9), `feat: Agregar navegación entre oficinas de scope` (T10), `feat: Integrar oficinas de scope en la webview` (S3).
- [ ] **Step 5: Revisión del usuario.**

---

## Ola 4 (paralela; entrega 3)

### T11: AgentFeedHub — suscripciones dirigidas al feed

**Files:**

- Create: `server/src/agentFeed.ts`
- Modify: `server/src/fileWatcher.ts` (setter `setTranscriptLineListener((agentId: number, record: Record<string, unknown>) => void)` invocado por cada línea parseada en `readNewLines`/`processTranscriptLine`)
- Test: `server/__tests__/agentFeed.test.ts`

**Interfaces:**

- Consumes: `HookProvider.parseFeedEntries` (S1/S2), `FEED_*` (S1), `AgentStateStore`.
- Produces:

```ts
export type FeedSend = (msg: AgentFeedSnapshot | AgentFeedAppend | AgentFeedDenied) => void;
export class AgentFeedHub {
  constructor(store: AgentStateStore, provider: HookProvider);
  subscribe(connId: string, agentId: number, privileged: boolean, send: FeedSend): void;
  unsubscribe(connId: string, agentId: number): void;
  dropConnection(connId: string): void;
  /** Called for every transcript record the runtime parses. */
  onRecord(agentId: number, record: Record<string, unknown>): void;
  dispose(): void;
}
```

- [ ] **Step 1: Tests que fallan**
  - no privilegiado → `send` recibe solo `{type:'agentFeedDenied', id, reason:'unprivileged'}` y NUNCA lee el transcript (espiar `fs.readFileSync`/`openSync`);
  - agente inexistente → `reason: 'unknownAgent'`;
  - privilegiado → `agentFeedSnapshot` con las entradas del tail (≤ `FEED_SNAPSHOT_MAX_ENTRIES`, `truncated: true` si había más), `seq` estrictamente creciente;
  - `onRecord` tras suscribir → `agentFeedAppend` a ese `connId` y a ningún otro; tras `unsubscribe` o `dropConnection`, nada;
  - `onRecord` para un agente sin suscriptores no llama a `parseFeedEntries` (costo cero).
- [ ] **Step 2: Ver fallar.**
- [ ] **Step 3: Implementar** — snapshot: leer los últimos `FEED_TAIL_READ_BYTES` de `agent.jsonlFile` (descartar la primera línea parcial), `JSON.parse` por línea en try/catch, `parseFeedEntries`, quedarse con las últimas `FEED_SNAPSHOT_MAX_ENTRIES`. `seq` por agente, monotónico, compartido entre snapshot y appends.
- [ ] **Step 4: Verde** — `npx vitest run server/__tests__/agentFeed.test.ts`.
- [ ] **Step 5: Reportar al líder.**

---

### T12: AgentScreenModal — la pantalla ampliada

**Files:**

- Create: `webview-ui/src/components/AgentScreenModal.tsx`
- Create: `webview-ui/src/hooks/useAgentFeed.ts`
- Create: `webview-ui/src/components/feedFormat.ts` (puro) + Test: `webview-ui/test/feedFormat.test.ts`

**Interfaces:**

- Consumes: tipos `FeedEntry`, mensajes `agentFeed*` (S1); `MessageTransport`; `AgentDirectory` (T4) para la cabecera; colores `FEED_DIFF_*` (S1).
- Produces:

```ts
// useAgentFeed.ts
export function useAgentFeed(
  transport: MessageTransport,
  agentId: number | null,
): {
  entries: FeedEntry[];
  truncated: boolean;
  denied: 'unprivileged' | 'unknownAgent' | null;
};
// feedFormat.ts
export function toolRowState(entries: FeedEntry[], toolId: string): 'running' | 'done' | 'error';
export function mergeFeed(prev: FeedEntry[], incoming: FeedEntry[], max: number): FeedEntry[]; // dedup por seq, orden por seq, recorta a max
// AgentScreenModal.tsx
export function AgentScreenModal(props: {
  agentId: number;
  directory: AgentDirectory;
  transport: MessageTransport;
  onClose: () => void;
}): JSX.Element;
```

- [ ] **Step 1: Tests de `feedFormat`**: `toolRowState` → `running` sin toolResult, `done` con resultado, `error` con `isError`; `mergeFeed` deduplica por `seq`, ordena y recorta.
- [ ] **Step 2: `useAgentFeed`** — al montar con `agentId` envía `subscribeAgentFeed`; al cambiar/desmontar `unsubscribeAgentFeed`; aplica snapshot/append con `mergeFeed(…, FEED_MAX_ENTRIES)` (de `webview-ui/src/constants.ts`, S1).
- [ ] **Step 3: `AgentScreenModal`** — modal grande estilo pixel (reutilizar el patrón de `SettingsModal`/`ui/Button`): cabecera (rol · label · padre · contexto %) ; lista con autoscroll al final salvo que el usuario haya subido; filas: texto del asistente; herramienta con icono ⟳/✓/✗ y `summary`; `detail` diff (líneas `add` con `FEED_DIFF_ADD_COLOR`, `remove` con `FEED_DIFF_REMOVE_COLOR`, prefijos `+`/`-`) y salida en `<pre>` colapsado a 12 líneas con "ver más"; aviso "truncado" cuando corresponde; `denied === 'unprivileged'` → mensaje "Abre la oficina con el enlace con token para ver la pantalla de los agentes". `Esc` cierra.
- [ ] **Step 4: Verde** — `npm run test:webview && npm run lint`.
- [ ] **Step 5: Reportar al líder.**

---

### S4: Integración de la entrega 3 y documentación (super-líder)

**Files:** `server/src/clientMessageHandler.ts`, `server/src/httpServer.ts`, `adapters/vscode/PixelAgentsViewProvider.ts`, `server/src/agentRuntime.ts`, `webview-ui/src/App.tsx`, `webview-ui/src/office/components/ToolOverlay.tsx`, `webview-ui/src/office/components/OfficeCanvas.tsx` (clic en monitor), `e2e/tests/standalone/agentScreen.spec.ts`, `CLAUDE.md`.

- [ ] **Step 1: Server** — `AgentRuntime` crea `AgentFeedHub` y conecta `setTranscriptLineListener(hub.onRecord)`; `ClientMessageContext` gana `connId` y `feedHub`; casos `subscribeAgentFeed` → `feedHub.subscribe(ctx.connId, msg.id, ctx.privileged === true, send)`, `unsubscribeAgentFeed` → `unsubscribe`. `httpServer.ts`: `connId` por socket (`crypto.randomUUID()`), `dropConnection` en `close`. VS Code: `connId` fijo del webview, `privileged` según lo que ya pasa hoy el adapter.
- [ ] **Step 2: Test de seguridad** en `server/__tests__/httpServerWs.test.ts`: cliente standalone SIN `?token=` envía `subscribeAgentFeed` → recibe `agentFeedDenied` y ningún `agentFeedSnapshot`; con token → snapshot. Ningún `agentFeed*` aparece en el stream de broadcast de un segundo cliente conectado.
- [ ] **Step 3: Webview** — botón "Ver pantalla" en `ToolOverlay` para el agente seleccionado; clic en el monitor (furniture `PC_*` adyacente al asiento del agente, en `OfficeCanvas`) → abre `AgentScreenModal`.
- [ ] **Step 4: E2E** `agentScreen.spec.ts` (standalone, con token): escenario con `Edit` y `Bash` en un sub-agente → abrir su pantalla → se ve una línea `+` del diff y la salida del Bash; sin token, el mensaje de denegación.
- [ ] **Step 5: `CLAUDE.md`** — actualizar: árbol de spawns (reemplaza la sección de sidecar-backed background agents y del shadow store), oficinas de scope, feed y su regla de privilegio, cuentas de mensajes AsyncAPI, archivos nuevos en el árbol de directorios, y la nota de `~/.pixel-agents/servers/` (registro multi-servidor ya existente).
- [ ] **Step 6: Verificación completa** — `npm run compile && npm test && npm run e2e -- --workers=1 && npm run e2e:inventory`; prueba en navegador con `/equipo` real; GIF `entrega3-pantalla.gif`.
- [ ] **Step 7: Commits**: `feat: Agregar hub de feed de actividad por agente` (T11), `feat: Agregar pantalla ampliada de agente` (T12), `feat: Integrar pantalla ampliada con acceso privilegiado` (S4), `docs: Actualizar CLAUDE.md con árbol de agentes y oficinas` (S4).
- [ ] **Step 8: Revisión del usuario** (el push/PR se pregunta al cerrar la entrega 4).

---

## Ola 5 (entrega 4 — conversaciones entre agentes, spec §4b)

### S5: Contrato de conversación y filtro por conexión (super-líder)

**Files:** `core/asyncapi.yaml`, `core/src/messages.ts` (regenerado), `core/src/provider.ts`, `server/src/constants.ts`, `webview-ui/src/constants.ts`, `server/src/httpServer.ts`, `adapters/vscode/PixelAgentsViewProvider.ts`.

**Interfaces (Produces):**

```yaml
AgentConversation:
  description: >-
    One agent addresses another (assigns work, reports back, or sends a
    message). Broadcast to every client for the animation; `text` is
    transcript content and is stripped for unprivileged connections.
  type: object
  additionalProperties: false
  required: [type, conversationId, fromId, kind]
  properties:
    type:
      const: agentConversation
    conversationId:
      type: string
    fromId:
      type: integer
    toId:
      type: integer
      description: Absent when the recipient could not be resolved to a tracked agent.
    kind:
      $ref: '#/components/schemas/ConversationKind'
    text:
      type: string
ConversationKind:
  type: string
  enum: [assign, report, message]
```

(añadir `AgentConversation` a `ServerMessage.oneOf`).

```ts
// core/src/provider.ts — HookProvider, bloque opcional
  /** Recognize an inter-agent communication in one transcript record of the
   *  agent that wrote it. `to` is a provider reference (Claude: agent key or
   *  teammate name) the host resolves inside the same root tree; `spawnToolUseId`
   *  is set for assignments (the spawn call) so the host can emit them when the
   *  child materializes. Undefined = no conversations for this provider. */
  parseConversations?(record: Record<string, unknown>): Array<{
    kind: 'assign' | 'report' | 'message';
    text: string;
    to?: string;
    spawnToolUseId?: string;
  }>;
```

Constantes: server `CONVERSATION_TEXT_MAX_BYTES = 65536`; webview `CONVERSATION_TYPE_CPS = 80`, `CONVERSATION_MAX_MS = 15000`, `CONVERSATION_BUBBLE_MAX_W = 220`, `CONVERSATION_BUBBLE_MAX_LINES = 8`, colores `CONVERSATION_BUBBLE_BG`, `CONVERSATION_BUBBLE_BORDER`.

- [ ] **Step 1:** contrato + regenerar (`asyncapi:validate`, `asyncapi:generate`, sin `AnonymousSchema`).
- [ ] **Step 2: filtro por conexión.** En `httpServer.ts`, en el reenvío de broadcasts por socket: si `msg.type === 'agentConversation' && !privileged`, enviar el mensaje sin `text`. VS Code (embebido) envía completo. Test en `server/__tests__/httpServerWs.test.ts`: dos clientes, uno con `?token=` y otro sin; el segundo recibe el evento sin `text`.
- [ ] **Step 3:** `npm run compile && npm run test:server`; commit `feat: Agregar contrato de conversaciones entre agentes`.

---

### T13: Detección de conversaciones en el servidor

**Files:**

- Create: `server/src/providers/hook/claude/claudeConversation.ts` (+ test `server/__tests__/claudeConversation.test.ts`)
- Create: `server/src/conversations.ts` (+ test `server/__tests__/conversations.test.ts`)
- Modify: `server/src/fileWatcher.ts` / `server/src/transcriptParser.ts` — un único gancho: por cada registro parseado de un agente, `conversationTracker.onRecord(agentId, record)`; en `scanSpawnTree`, tras crear un hijo, `conversationTracker.onChildMaterialized(parentId, childId, spawnToolUseId)`; al cerrarse un spawn con su `tool_result`, `onSpawnResult(parentId, toolUseId, text)`.

**Interfaces:**

- Consumes: `HookProvider.parseConversations` (S5); árbol de T6 (`parentAgentId`, `spawnAgentKey`, `agentName`, `rootOf`); `sanitizeFeedText`/`truncateUtf8` (T5); `AgentStateStore.broadcast`.
- Produces:

```ts
// claudeConversation.ts
export function parseClaudeConversations(
  record: Record<string, unknown>,
): Array<{
  kind: 'assign' | 'report' | 'message';
  text: string;
  to?: string;
  spawnToolUseId?: string;
}>;
// conversations.ts
export class ConversationTracker {
  constructor(store: AgentStateStore, provider: HookProvider);
  onRecord(agentId: number, record: Record<string, unknown>): void;
  onChildMaterialized(parentId: number, childId: number, spawnToolUseId: string): void;
  /** Report fallback: the parent's spawn tool_result arrived and the child never sent a handback. */
  onSpawnResult(parentId: number, spawnToolUseId: string, resultText: string): void;
  dispose(): void;
}
```

Reglas:

- `assign`: `onRecord` del padre guarda `text` por `spawnToolUseId` (Map acotado; se borra al emitir o al cerrarse el spawn); se emite en `onChildMaterialized` con `toId = childId`.
- `report`: `SubagentHandback` en el transcript del hijo → `toId = parentAgentId`; marca el spawn como reportado para que `onSpawnResult` no duplique.
- `message`: `SendMessage` → resolver `to`/`recipient` contra `spawnAgentKey` y luego `agentName` de agentes con el mismo `rootOf`; si no resuelve, emitir sin `toId`.
- `conversationId` = `${agentId}:${record.uuid ?? toolUseId}`; deduplicar (los transcripts repiten registros).
- `text` truncado a `CONVERSATION_TEXT_MAX_BYTES` en frontera UTF-8 y saneado con `sanitizeFeedText`.
- No emitir para registros de la lectura inicial de un agente adoptado/restaurado a mitad de sesión (solo registros nuevos).
- Índices solo en `Map`/`Set` (claves como `__proto__` son válidas).

- [ ] **Step 1: tests rojos** — `claudeConversation.test.ts`: `Agent` tool_use → `assign` con `prompt` y `spawnToolUseId`; `SubagentHandback` → `report`; `SendMessage` con `to`+`message` y con `recipient`+`content` → `message`; registros ajenos → `[]`. `conversations.test.ts`: assign se emite solo al materializar el hijo y con `toId` correcto; report con `toId = parent`; `onSpawnResult` no duplica un handback; `message` resuelve por clave y por nombre, y sin `toId` si no resuelve; dedup por `conversationId`; la lectura inicial no emite.
- [ ] **Step 2:** implementar. **Step 3:** verde (`npx vitest run __tests__/claudeConversation.test.ts __tests__/conversations.test.ts __tests__/spawnTreeRuntime.test.ts`). **Step 4:** reportar (registro en `claudeProvider` y creación del tracker en `AgentRuntime` los hace S6).

---

### T14: Escena de conversación — máquina de estados pura (webview)

**Files:** Create `webview-ui/src/office/engine/conversationScene.ts`, test `webview-ui/test/conversationScene.test.ts`.

**Interfaces (Produces):**

```ts
export type ScenePhase = 'queued' | 'walking' | 'talking' | 'returning' | 'done';
export interface ConversationEvent {
  conversationId: string;
  fromId: number;
  toId?: number;
  kind: 'assign' | 'report' | 'message';
  text?: string;
}
export interface SceneView {
  conversationId: string;
  fromId: number;
  toId?: number;
  phase: ScenePhase;
  visibleText: string;
  complete: boolean;
  kind: ConversationEvent['kind'];
}
export interface SceneHost {
  /** Both characters present in the visible office? */
  canStage(fromId: number, toId: number | undefined): boolean;
  /** Start walking `fromId` next to `toId`; false if no path. */
  walkNextTo(fromId: number, toId: number): boolean;
  hasArrived(fromId: number): boolean;
  faceEachOther(fromId: number, toId: number): void;
  returnToSeat(fromId: number): void;
  isSeated(fromId: number): boolean;
  showEnvelope(fromId: number): void;
}
export class ConversationDirector {
  constructor(host: SceneHost, opts: { cps: number; maxMs: number });
  enqueue(ev: ConversationEvent): void; // FIFO per fromId
  update(dtSec: number): void; // advance phases + typewriter
  skip(conversationId: string): void; // reveal full text now
  views(): SceneView[]; // active scenes for rendering
  isBusy(agentId: number): boolean; // speaker or listener in an active scene
  clear(): void; // on office switch: drop everything, no replay
}
```

- [ ] **Step 1: tests rojos** con un `SceneHost` falso: FIFO por emisor (la 2ª espera a que la 1ª llegue a `done`); `canStage=false` → `showEnvelope` y `done` sin caminar; `walkNextTo=false` → envelope; typewriter: tras `update(0.5)` a 80 cps hay 40 caracteres visibles; `skip` → `complete=true`; al pasar `maxMs` en `talking` → `complete=true` y pasa a `returning`; `returning` → `done` cuando `isSeated`; `text` ausente → `visibleText = '…'`; `clear()` vacía todo.
- [ ] **Step 2:** implementar. **Step 3:** verde (`npx vitest run test/conversationScene.test.ts` desde `webview-ui/`). **Step 4:** reportar.

---

### T15: Motor y burbuja — caminar, mirarse y hablar

**Files:**

- Modify: `webview-ui/src/office/engine/characters.ts` (flag `scripted` que suspende el retorno automático al asiento del FSM activo mientras dura la escena)
- Modify: `webview-ui/src/office/engine/officeState.ts` (métodos que implementan `SceneHost`: `walkNextTo` con `closestFreeWalkableTile` alrededor del puesto del receptor + `walkToTile`; `faceEachOther`; `returnToSeat` → `sendToSeat`; `isSeated`; `showEnvelope` → bubble `'envelope'`)
- Modify: `webview-ui/src/office/types.ts` (`bubbleType` gana `'envelope' | 'listening'`; `Character.scripted?: boolean`)
- Create: `webview-ui/src/office/components/ConversationBubble.tsx` (overlay DOM con `office/projection.ts`, como `ToolOverlay`)
- Test: `webview-ui/test/conversationHost.test.ts` (OfficeState real)

**Interfaces:** Consumes `SceneHost`/`SceneView` (T14), `generateScopeLayout` (T4). Produces `OfficeState` que implementa `SceneHost` y `ConversationBubble(props: { officeState; views: SceneView[]; containerRef; zoom; panRef; onSkip(id: string); onOpenScreen(agentId: number) })`.

- [ ] **Step 1: tests rojos** (OfficeState con layout generado, dos agentes sentados): `walkNextTo(a, b)` deja a `a` en una casilla adyacente libre al puesto de `b` tras avanzar el loop; mientras `scripted`, un `agentToolStart` sobre `a` NO lo manda a su silla; `returnToSeat` lo sienta y limpia `scripted`; `faceEachOther` orienta ambos; `showEnvelope` pone `bubbleType='envelope'`.
- [ ] **Step 2:** implementar motor.
- [ ] **Step 3: `ConversationBubble`** — burbuja pixel (`borderRadius: 0`, `2px solid`, `var(--pixel-shadow)`, FS Pixel Sans) sobre el emisor, ancho máx `CONVERSATION_BUBBLE_MAX_W`, scroll interno a `CONVERSATION_BUBBLE_MAX_LINES`, texto SOLO como children de React (nada de HTML), clic → `onSkip`; completado por tope → enlace "…ver completo" → `onOpenScreen(fromId)`; "…" de escucha sobre el receptor.
- [ ] **Step 4:** verde — `npm run test:webview && npm run lint`. **Step 5:** reportar.

---

### S6: Integración de la entrega 4 (super-líder)

**Files:** `server/src/agentRuntime.ts`, `server/src/providers/hook/claude/claude.ts`, `webview-ui/src/hooks/useExtensionMessages.ts`, `webview-ui/src/App.tsx`, `webview-ui/src/office/engine/gameLoop.ts` (llamar `director.update(dt)`), `e2e/tests/claude/hooks-off/conversations.spec.ts`, `CLAUDE.md`, `CONTEXT.md` (término **Conversation**).

- [ ] **Step 1: Server** — `claudeProvider.parseConversations = parseClaudeConversations`; `AgentRuntime` crea `ConversationTracker` y cablea los ganchos de T13.
- [ ] **Step 2: Webview** — un `ConversationDirector` por oficina activa (`OfficeRegistry.enter` → `director.clear()`); `agentConversation` → `director.enqueue`; `agentClosed` de un hijo con escena `report` en curso: diferir `removeAgent` hasta `!director.isBusy(id)` o `CONVERSATION_MAX_MS`; render de `ConversationBubble`; `onOpenScreen` abre `AgentScreenModal` (entrega 3) si existe, si no, no-op.
- [ ] **Step 3: E2E** `conversations.spec.ts` (reutiliza el escenario de T8): el lead asigna → burbuja con el inicio del `prompt` sobre el lead junto al puesto del hijo; el hijo escribe `SubagentHandback` → camina al lead, se ve el inicio de su `message`, y desaparece después; standalone sin token → la burbuja muestra `…`.
- [ ] **Step 4:** `npm run compile && npm test && npm run e2e -- --workers=1 && npm run e2e:inventory`; prueba en navegador con `/equipo` real; GIF `entrega4-conversaciones.gif`.
- [ ] **Step 5: Commits**: `feat: Agregar contrato de conversaciones entre agentes` (S5), `feat: Detectar conversaciones entre agentes` (T13), `feat: Agregar director de escenas de conversación` (T14), `feat: Animar conversaciones entre personajes` (T15), `feat: Integrar conversaciones entre agentes` (S6).
- [ ] **Step 6: Revisión final del usuario** — y preguntar si se hace push/PR.
