# Árbol de agentes, oficinas por scope y pantalla ampliada — Diseño

- **Fecha**: 2026-09-23
- **Estado**: borrador para revisión
- **Secciones aprobadas en conversación**: 1 (modelo de dominio), 2 (servidor). Las secciones 3 y 4 recogen decisiones ya tomadas (oficinas navegables, layout autogenerado, solo hijos directos, feed con diffs y salidas) más decisiones recomendadas marcadas **[revisar]**.

## Objetivo

Que la oficina represente fielmente cualquier sesión de Claude Code con muchos agentes —cualquier orquestación, no solo `/equipo`— como un **árbol de agentes de profundidad arbitraria**, que cada **scope** (un agente + sus hijos directos) sea una **oficina navegable**, y que se pueda **ver en grande lo que hace** cualquier agente.

### Criterios de éxito

1. En una sesión `/equipo` real (super-líder → `lider-fase` → `desarrollador` → `qa-revisor` + `pentester`), cada agente aparece como personaje propio en la oficina de su padre, a profundidad 3.
2. La actividad de un sub-agente **nunca** anima al personaje de su padre (defecto actual).
3. Clic en la insignia `▸N` entra a la oficina de ese scope; migas de pan para volver.
4. Clic en la pantalla de un agente abre su feed en vivo con texto, herramientas, diffs y salidas.
5. Nada de esto depende de nombres de `agentType`: funciona con `Explore`, `general-purpose`, forks, agentes custom.

### Fuera de alcance

- Editar el layout de oficinas de scope (se autogeneran).
- Persistir agentes derivados o su feed.
- Proveedores distintos de Claude (la interfaz queda preparada; solo se implementa Claude).

## Evidencia de partida

Relevado sobre ~329 sidecars reales en `~/.claude/projects/*/<sesión>/subagents/`:

- Todos los sub-agentes de una sesión —anidados o no— viven **planos** en `<projectDir>/<sessionId>/subagents/agent-<hexId>.jsonl` + `agent-<hexId>.meta.json`.
- El sidecar trae `agentType`, `description`, `toolUseId`, `spawnDepth` (siempre) y `parentAgentId` (cuando `spawnDepth ≥ 2`; es el `<hexId>` del padre). Opcionales: `name`, `model`, `isFork`, `worktreePath`, `stoppedByUser`.
- Profundidades observadas: 1 (`desarrollador`, `lider-fase`, `Explore`, …), 2 (`qa-revisor`, `pentester`, `fork`, …), 3 (`qa-revisor`, `pentester`). Ninguno trae `name`.
- Hoy `scanForBackgroundAgentFiles` (`server/src/fileWatcher.ts`) solo acepta sidecars cuyo `toolUseId` sea un spawn vivo **del líder** → profundidad ≥ 2 se descarta. Los sin nombre van al shadow store (`subagentWatch.ts`) y se pintan como sub-personaje "Subtask" alrededor del padre, sin capacidad de tener hijos.

## 1. Modelo de dominio

**Árbol de agentes.** Toda sesión de nivel superior (lanzada o adoptada) es raíz de un árbol. Todo agente creado dentro de ella por la herramienta de spawn del proveedor (`Agent`/`Task`), en primer o segundo plano, a cualquier profundidad, es un **Agent derivado** con:

| Campo           | Origen                                                                   | Uso                                           |
| --------------- | ------------------------------------------------------------------------ | --------------------------------------------- |
| `parentAgentId` | nodo cuyo id de sidecar = `parentAgentId` del sidecar; si falta, la raíz | Estructura del árbol                          |
| `spawnAgentKey` | `<hexId>` del nombre de archivo                                          | Enlazar hijos y enrutar hooks                 |
| `role`          | `agentType`                                                              | Etiqueta visible (solo etiqueta, nunca regla) |
| `label`         | `description`                                                            | Etiqueta visible / cabecera del feed          |
| `depth`         | `spawnDepth`                                                             | Informativo                                   |
| `agentName`     | `name` (si existe)                                                       | Sigue marcando Teammate                       |

**Glosario (`CONTEXT.md`) — cambios.** Se registran en `docs/adr/0002-every-spawn-is-a-derived-agent.md`:

- **Sub-agent**: pasa de "no es un Agent" a "Agent derivado sin sesión propia que vive lo que dura su tarea". Tener o no nombre sigue distinguiendo Sub-agent de Teammate, pero ya no cambia la representación: ambos se sientan en la oficina de su padre.
- **Scope** (nuevo): un agente más sus hijos directos.
- **Oficina de scope** (nuevo): oficina autogenerada donde se ve un scope. La **oficina raíz** es la actual, con el layout editable.

**Ciclo de vida de un Agent derivado.**

- _Nace_: su sidecar aparece y su `toolUseId` es un spawn vivo de su padre (anti-espurio recursivo).
- _Muere_: `tool_result` del spawn en el padre (primer plano), `queue-operation` de completado (segundo plano), `SubagentStop` por hook, o cascada cuando muere su padre (subárbol completo, hojas primero).
- **Nunca se persiste ni se adopta como sesión.** Tras recarga, el escaneo lo rematerializa desde los spawns vivos (como hoy los hijos de segundo plano).

**No cambia**: oficina raíz y su layout, asientos persistidos de sesiones de nivel superior, flujo de Agent Teams por config (`~/.claude/teams`).

## 2. Servidor

### 2.1 Detección recursiva

- `scanForBackgroundAgentFiles` se reemplaza por **`scanSpawnTree(rootId)`**. Se dispara donde hoy se dispara el escaneo de segundo plano (`setBackgroundAgentDetectedCallback`) y además cuando cualquier nodo del árbol abre una herramienta de spawn (primer plano incluido). Corre con hooks encendidos o apagados.
- Por cada sidecar no seguido:
  1. **Padre** = nodo del árbol con `spawnAgentKey === sidecar.parentAgentId`; si el sidecar no trae `parentAgentId`, la raíz.
  2. **Compuerta** = `sidecar.toolUseId ∈ liveSpawnToolIds(padre)` (la función actual, aplicada a cualquier nodo).
  3. Si el padre aún no existe → se reintenta en el próximo ciclo.
  4. Si pasa → crear Agent derivado, `startFileWatching` sobre su `.jsonl`. Sus propias herramientas de spawn quedan rastreadas por el pipeline normal, y sus hijos aparecen en el ciclo siguiente: **recursión natural**.
- **Frontera de proveedor**: `TeamProvider.discoverTeammates` amplía su entrada con `agentKey`, `parentAgentKey`, `depth`, `agentType`, `description`. El runtime nunca lee sidecars.
- **Se elimina** el shadow store (`server/src/subagentWatch.ts`) y la traducción `subagentTool*` para spawns con sidecar. Consecuencia: burbujas de permiso, espera y medidor de contexto funcionan por nodo sin código extra.
- **Compatibilidad Task-era**: transcripts antiguos sin sidecar (`agent_progress`) conservan el camino actual de sub-personaje "Subtask" como respaldo. Cuando un nodo se materializa para ese `toolUseId`, el Subtask se limpia con `subagentClear` (mecanismo existente).

### 2.1b Workflows (aprobado 2026-09-23)

La herramienta `Workflow` lanza un script que orquesta agentes. En disco: `<projectDir>/<sessionId>/subagents/workflows/wf_<id>/agent-<key>.jsonl` + sidecar con **solo** `agentType` y `spawnDepth` (sin `toolUseId` ni `description`). Enlace con la sesión: el `tool_result` de la llamada `Workflow` (`toolu_X`) dice `Workflow launched in background … Transcript dir: <ruta wf_…>`; el fin llega como `queue-operation` `<task-notification>` con `<tool-use-id>toolu_X</tool-use-id>` y `<status>completed</status>`.

- **Nodo workflow**: Agent derivado con `nodeKind: 'workflow'`, hijo de quien llamó `Workflow`, sin transcript (no se vigila ningún archivo), `label` = `meta.name` del script (`input.script`), si no el `Summary:` del tool_result; `role` = `'workflow'`. Nace al parsear el tool_result "Workflow launched"; muere (con su subárbol) con la notificación de completado de ese `toolUseId`, o con su padre. Su estado es derivado: `active` si alguno de sus hijos está activo, si no `waiting`.
- **Agentes del workflow**: hijos del nodo workflow. Compuerta anti-espuria: el nodo workflow de ese `Transcript dir` existe (la llamada sigue viva). `label` = primera línea no vacía del primer mensaje `user` de su transcript (truncada); `role` = `agentType`; `depth` = profundidad del nodo + 1. Si su sidecar trae `parentAgentId`, se cuelga de ese agente como cualquier spawn. Sus hooks llegan con `agent_id` y se enrutan por `(sessionId, agentKey)`. No hay señal de fin individual: al terminar su turno quedan en `waiting` en su puesto hasta que el workflow completa.
- **Frontera de proveedor**: `TeamProvider.extractWorkflowLaunch?(toolName, toolInput, resultContent) → { runDir, name? } | null` y `TeamProvider.discoverWorkflowAgents?(runDir) → Array<{ jsonlPath, agentKey, parentAgentKey?, agentType, label? }>`.

### 2.2 Muerte en cascada

`removeAgent(id)` elimina primero, recursivamente, todo agente con `parentAgentId === id`. Los disparadores del ciclo de vida (§1) llaman a `removeAgent` sobre el nodo afectado.

### 2.3 Defecto: la actividad del hijo anima al padre

- **Primero reproducir** con un test que falle (depuración sistemática), antes de tocar código.
- Causa (confirmada en la [doc de hooks](https://code.claude.com/docs/en/hooks)): los eventos de herramienta emitidos dentro de un sub-agente llevan el `session_id` de la sesión raíz más `agent_id` y `agent_type` (obligatorios en `SubagentStart`/`SubagentStop`, presentes en eventos de herramienta de sub-agente; no hay id de padre). `HookEventHandler` resuelve solo por `session_id` e ignora `agent_id` → `handlePreToolUse` anima a la raíz.
- Corrección: el `AgentEvent` normalizado gana `agentKey?` (de `agent_id`, en `normalizeHookEvent` del proveedor Claude), y `SessionRouter` resuelve por `(sessionId, agentKey)`: si coincide con el `spawnAgentKey` de un nodo derivado, el evento va a ese nodo; si el nodo aún no existe, se bufferiza (mecanismo existente) hasta que `scanSpawnTree` lo cree o expire. Un evento con `agentKey` que no resuelve **nunca** cae a la raíz. `SubagentStart` con `agent_id` dispara `scanSpawnTree` inmediato (sin esperar al ciclo de 1 s).
- Supuesto a validar en el primer test rojo: el `agent_id` del hook coincide con el `<hexId>` del nombre de archivo del sidecar (también es el `agentId` que devuelve el tool_result del spawn).
- Sin hooks, el defecto no existe (cada nodo lee su propio `.jsonl`), pero el test lo cubre en ambos modos.

## 3. Oficinas por scope (webview)

- **Varias `OfficeState`**: `App.tsx` pasa de un `officeStateRef` a un registro `Map<scopeId, OfficeState>`. `root` = la actual (layout de `layout.json`). Cada oficina de scope se crea al entrar y se descarta al salir (se recrea al volver: es barata y derivada).
- **Quién está en cada oficina**: la raíz muestra solo agentes sin `parentAgentId`. La oficina del scope X muestra X y sus hijos directos. **[revisar]** Esto también mueve a los Teammates de Agent Teams (hoy sentados en la raíz) a la oficina de su Lead, por coherencia.
- **Layout autogenerado**: función pura `generateScopeLayout(memberCount)` en `webview-ui/src/office/layout/scopeLayoutGenerator.ts`. Una sala con un puesto (escritorio + silla + monitor del catálogo) para el dueño arriba y filas de puestos para los hijos; al superar la capacidad se regenera más grande conservando las asignaciones. No se persiste; el editor de layout se deshabilita fuera de la raíz.
- **Navegación**:
  - Insignia `▸N` (hijos vivos directos) sobre personajes con equipo. **[revisar]** Clic en la insignia o doble clic en el personaje entra a su oficina; clic simple conserva el comportamiento actual (seleccionar/enfocar terminal).
  - Componente `ScopeBreadcrumbs` arriba a la izquierda: `Oficina › Fase 1 › dev-auth`, cada tramo clicable. `Esc` sube un nivel (fuera del modo edición).
  - Si el dueño del scope actual muere, se muestra "scope terminado" 2 s y se sube al ancestro vivo más cercano.
- **Atención que sube**: si un descendiente (a cualquier profundidad) pide permiso, la insignia `▸N` del ancestro visible en la oficina actual se pinta en ámbar. Evita perder permisos enterrados a profundidad 3.
- **Paleta**: los hijos heredan paleta del padre con desplazamiento de tono por hermano (reutiliza `adjustSprite`), para distinguirlos dentro de la oficina.

## 4. Pantalla ampliada (feed en vivo)

- **Apertura**: clic en el monitor del puesto de un agente, o botón "Ver pantalla" en el overlay del personaje seleccionado. Abre `AgentScreenModal` (estilo pixel, grande). Aplica a cualquier agente: raíz o derivado.
- **Contenido**: cabecera (rol, `label`, padre, % de contexto, estado) + feed cronológico en vivo:
  - texto del asistente;
  - herramienta por línea legible (`Edit SessionService.java`, `Bash mvn -q test`, `Grep "token"`), con estado ⟳/✓/✗;
  - `Edit`/`MultiEdit`/`Write` → diff coloreado (calculado en el servidor a partir de `old_string`/`new_string`/`content`);
  - `Bash` → comando + salida (ANSI eliminado);
  - resultados largos colapsados, expandibles.
- **Seguridad**: el feed expone código y salidas de comandos. **No se difunde por broadcast.** Solo conexiones **privilegiadas** (mismo criterio que `setHooksEnabled`: Bearer en embebido, `?token=` en standalone) pueden suscribirse; en conexiones sin privilegio el botón aparece deshabilitado con la explicación.
- **Protocolo** (AsyncAPI, ver §5): suscripción por agente, respuesta dirigida solo a esa conexión.
- **Fuente**: el `.jsonl` del agente. Al suscribirse, lectura de cola (últimas `FEED_SNAPSHOT_MAX_ENTRIES`); después, append desde el flujo de líneas del watcher existente. El parseo de registros a entradas de feed es del proveedor: `HookProvider.parseFeedEntries?(record)` (opcional), para que el runtime no conozca Claude.
- **Límites** (en `server/src/constants.ts`): `FEED_SNAPSHOT_MAX_ENTRIES = 200`, `FEED_ENTRY_DETAIL_MAX_BYTES = 64 KiB` (se trunca con marca), sin historial persistido.

## 4b. Conversaciones entre agentes (entrega 4)

Aprobada en conversación el 2026-09-23. Cuando un agente asigna, reporta o le manda un mensaje a otro, su personaje camina hasta el otro y se ve el diálogo completo.

**Detección** (servidor; parseo específico en el proveedor):

| Evento    | Emisor → receptor         | Origen                                                                                                                                                                  | Texto                                     |
| --------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `assign`  | padre → hijo              | `tool_use` de spawn (`Agent`/`Task`) en el transcript del padre; se emite cuando el hijo se materializa (el `prompt` se guarda al parsear el tool_use, por `toolUseId`) | `input.prompt`                            |
| `report`  | hijo → padre              | `tool_use` `SubagentHandback` en el transcript del hijo; en transcripts sin handback, el `tool_result` del spawn en el padre                                            | `input.message` / contenido del resultado |
| `message` | cualquiera → destinatario | `tool_use` `SendMessage`; `to`/`recipient` se resuelve contra `spawnAgentKey` o `agentName` dentro del árbol de la misma raíz                                           | `input.message` / `input.content`         |

Datos reales (todas las sesiones del usuario): 370 `Agent`, 215 `SubagentHandback`, 57 `SendMessage`.

**Escena** (webview, máquina de estados pura + render):

1. El emisor se levanta y camina (BFS) a la casilla libre más cercana al puesto del receptor; se orienta hacia él.
2. Burbuja pixel grande sobre el emisor: el texto completo aparece como máquina de escribir a `CONVERSATION_TYPE_CPS = 80` caracteres/s, con scroll interno. El receptor muestra "escuchando" (`…`) y lo mira.
3. Clic en la burbuja → salta a texto completo. Tope `CONVERSATION_MAX_MS = 15000`: la escena cierra con "…ver completo", que abre la pantalla ampliada (§4) del emisor.
4. El emisor vuelve a su silla.
5. `assign`: el hijo se materializa en su silla mientras le hablan. `report`: tras la escena el hijo desaparece (su despawn espera a que termine la escena, con tope `CONVERSATION_MAX_MS`).

**Reglas**: una conversación a la vez por personaje (cola FIFO por emisor); si emisor y receptor no comparten la oficina visible, el emisor muestra un sobre ✉ en su puesto sin moverse; escenas de oficinas no visibles no se reproducen al entrar (solo estado actual); el paseo es puramente visual (no cambia `status` del agente).

**Privacidad**: el texto es contenido del transcript. `agentConversation` se difunde a todos, pero la capa de envío por conexión **elimina `text`** en conexiones no privilegiadas (misma regla que el feed); esas ven la escena con `…`. En VS Code (embebido, privilegiado) va completo.

## 5. Cambios de protocolo (`core/asyncapi.yaml` → regenerar `messages.ts`)

- (Entrega 4) ServerMessage `agentConversation { conversationId, fromId, toId?, kind: 'assign' | 'report' | 'message', text? }` (`kind` como esquema nombrado `ConversationKind`; `text` solo en conexiones privilegiadas).

- `AgentCreated` y `AgentMeta` (en `existingAgents`): `parentAgentId?`, `role?`, `label?`, `depth?`, y `nodeKind?: 'agent' | 'workflow'` (esquema nombrado `AgentNodeKind`; ausente = `agent`). La UI dibuja el nodo workflow con el prefijo ⚙ en su etiqueta.
- ClientMessage nuevos: `subscribeAgentFeed { id }`, `unsubscribeAgentFeed { id }`.
- ServerMessage nuevos (dirigidos, no broadcast): `agentFeedSnapshot { id, entries, truncated }`, `agentFeedAppend { id, entries }`, `agentFeedDenied { id, reason }`.
- `FeedEntry`: `{ seq, ts, kind: 'text' | 'tool' | 'toolResult', toolId?, toolName?, summary, isError?, detail? }` con `detail` = `{ type: 'diff', lines: [{ op: 'context' | 'add' | 'remove', text }], truncated? } | { type: 'output', text, truncated? }`. El estado ⟳/✓/✗ de una herramienta lo deriva la UI emparejando `tool` con su `toolResult` por `toolId`.
- Las cuentas de variantes en `CLAUDE.md` se actualizan (27 → 30 server, 18 → 20 client).

## 6. Pruebas

- **Server (Vitest)**: fixtures anonimizados que copian la forma de sidecars reales.
  - árbol de profundidad 3 se materializa completo; nieto escaneado antes que su padre se reintenta;
  - compuerta: sidecar con `toolUseId` no vivo no crea nodo; `parentAgentId` desconocido no se cuelga de la raíz;
  - cascada al terminar un nodo intermedio; nada derivado se persiste;
  - defecto: hook con id de sub-agente no anima al líder (test rojo primero);
  - feed: parseo de Edit→diff, Bash→salida, truncado; conexión no privilegiada recibe `agentFeedDenied`.
- **Webview (Vitest, Node)**: `generateScopeLayout` (capacidad, crecimiento estable), filtro de miembros por scope, propagación de atención.
- **E2E (Playwright)**: `mock-claude` escribe un árbol de 3 niveles; se afirma la insignia, la navegación por migas, que el padre no anima con la actividad del hijo, y que la pantalla muestra un diff. Seguir "Mocking model & rules" de `e2e/README.md`; regenerar inventario.

## 7. Entregas

1. **Árbol en el servidor + defecto** (§1, §2, §5 parcial: campos de agente). Visible ya en la oficina raíz como personajes derivados sentados (interim, antes de las oficinas).
2. **Oficinas por scope** (§3).
3. **Pantalla ampliada** (§4, §5 feed).
4. **Conversaciones entre agentes** (§4b, §5 conversación). Depende de 1 y 2; puede ir en paralelo con 3.

Cada entrega deja `npm run compile`, `npm test` y el e2e en verde, y actualiza `CLAUDE.md`/`CONTEXT.md` en lo que toca.

## 8. Riesgos y preguntas abiertas

- **`agent_id` del hook ≠ clave del sidecar**: si el primer test real muestra que no coinciden, se enlaza por `agent_transcript_path`/`transcript_path` (ruta del `.jsonl` del nodo) en lugar de por clave.
- **Volumen**: una sesión real acumuló 342 sidecars; solo se materializan los de spawns vivos, y cada nodo vivo agrega un watcher de 500 ms. Un equipo típico (~15 nodos vivos) es asumible; se mide en el e2e.
- **Formato de sidecar** es interno de Claude Code y puede cambiar; queda aislado en el proveedor.
