# Árbol de agentes, oficina viva y pantalla ampliada — Diseño

- **Fecha**: 2026-09-23
- **Estado**: borrador para revisión
- **Secciones aprobadas en conversación**: 1 (modelo de dominio), 2 (servidor), 3 (oficina viva — rediseñada y aprobada el 2026-09-24; reemplaza a las oficinas navegables por scope), 4 (pantalla ampliada), 4b (conversaciones).
- **Entrega 1** (§1–§2) implementada y commiteada el 2026-09-24.

## Objetivo

Que la oficina represente fielmente cualquier sesión de Claude Code con muchos agentes —cualquier orquestación, no solo `/equipo`— como un **árbol de agentes de profundidad arbitraria**, en **una sola oficina viva** que se arma sola como una oficina real (un módulo con nombre por equipo, puerta, sala de descanso), donde los agentes entran, trabajan, descansan, se hablan y se despiden, y que se pueda **ver en grande lo que hace** cualquier agente.

### Criterios de éxito

1. En una sesión `/equipo` real (super-líder → `lider-fase` → `desarrollador` → `qa-revisor` + `pentester`), cada agente aparece como personaje propio en la oficina de su padre, a profundidad 3.
2. La actividad de un sub-agente **nunca** anima al personaje de su padre (defecto actual).
3. Cada equipo aparece en su propio módulo con nombre al lado de la oficina del usuario; los agentes entran por la puerta, van al descanso tras inactividad y salen despidiéndose cuando el líder ya no los necesita.
4. Clic en la pantalla de un agente abre su feed en vivo con texto, herramientas, diffs y salidas.
5. Nada de esto depende de nombres de `agentType`: funciona con `Explore`, `general-purpose`, forks, agentes custom.

### Fuera de alcance

- Editar los módulos de equipo (se autogeneran; la oficina del usuario sigue siendo editable).
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
- _Muere_ (entrega 1): `tool_result` del spawn en el padre (primer plano), `queue-operation` de completado (segundo plano), `SubagentStop` por hook, o cascada cuando muere su padre (subárbol completo, hojas primero).
- _Ciclo de vida de la oficina viva_ (entrega 2, §3.3; reemplaza la regla anterior para spawns de segundo plano): terminar **no** es salir. Un spawn de fondo que termina (`<status>completed</status>` o `failed`) queda **disponible**: Claude Code puede retomarlo (`SendMessage` al mismo agente; la misma `task-id` vuelve a notificar). Solo sale con una señal de salida real: `<status>killed</status>` / `stopped`, un `TaskStop` del padre con su `task_id`, el cierre por el usuario, o el fin de la sesión raíz (cascada). Los spawns de primer plano terminan con su `tool_result` porque no pueden retomarse.
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
- **Frontera de proveedor**: `TeamProvider.extractWorkflowLaunch?(toolName, toolInput, resultContent) → { runDir, name? } | null`, `TeamProvider.discoverWorkflowAgents?(runDir) → Array<{ jsonlPath, agentKey, parentAgentKey?, agentType, label? }>` y `TeamProvider.isWorkflowRunDirOfSession?(runDir, projectDir, sessionId)`; un proveedor sin esta última no obtiene nodos workflow (falla cerrado).
- **Límites aceptados** (2026-09-24): si el servidor se reinicia a mitad de un workflow, el nodo no se recrea (derivados nunca se persisten; persistir el run se rechazó). Un nodo workflow cuya notificación de completado nunca llega (CLI muerta, sin hooks) vive hasta que cae su padre — misma paridad que los spawns de fondo.

### 2.2 Muerte en cascada

`removeAgent(id)` elimina primero, recursivamente, todo agente con `parentAgentId === id`. Los disparadores del ciclo de vida (§1) llaman a `removeAgent` sobre el nodo afectado.

### 2.3 Defecto: la actividad del hijo anima al padre

- **Primero reproducir** con un test que falle (depuración sistemática), antes de tocar código.
- Causa (confirmada en la [doc de hooks](https://code.claude.com/docs/en/hooks)): los eventos de herramienta emitidos dentro de un sub-agente llevan el `session_id` de la sesión raíz más `agent_id` y `agent_type` (obligatorios en `SubagentStart`/`SubagentStop`, presentes en eventos de herramienta de sub-agente; no hay id de padre). `HookEventHandler` resuelve solo por `session_id` e ignora `agent_id` → `handlePreToolUse` anima a la raíz.
- Corrección: el `AgentEvent` normalizado gana `agentKey?` (de `agent_id`, en `normalizeHookEvent` del proveedor Claude), y `SessionRouter` resuelve por `(sessionId, agentKey)`: si coincide con el `spawnAgentKey` de un nodo derivado, el evento va a ese nodo; si el nodo aún no existe, se bufferiza (mecanismo existente) hasta que `scanSpawnTree` lo cree o expire. Un evento con `agentKey` que no resuelve **nunca** cae a la raíz. `SubagentStart` con `agent_id` dispara `scanSpawnTree` inmediato (sin esperar al ciclo de 1 s).
- Supuesto a validar en el primer test rojo: el `agent_id` del hook coincide con el `<hexId>` del nombre de archivo del sidecar (también es el `agentId` que devuelve el tool_result del spawn).
- Sin hooks, el defecto no existe (cada nodo lee su propio `.jsonl`), pero el test lo cubre en ambos modos.

## 3. Oficina viva (webview + ciclo de vida) — aprobada 2026-09-24

Reemplaza el diseño anterior de oficinas navegables por scope (doble clic, migas de pan, insignias `▸N`), que se descarta. Todo ocurre en **una sola oficina**.

### 3.1 Distribución

```
┌─ Oficina del usuario (editable) ─┐┌─ Fase 1 · Auth ─────────────┐┌─ Fase 2 · Pagos ──────┐
│ [raíz]          ┌─ Descanso ─┐    ││ [líder F1]                  ││ [líder F2]            │
│                 │ 🎮 🛋 ☕    │    ││ [dev-auth] ┊ QA · pen        ││ [dev-pagos] ┊ QA      │
│ 🚪 Entrada      └────────────┘    ││ [dev-login]┊ QA · pen        ││                       │
└──────────────────────────────────┘└─────────────────────────────┘└───────────────────────┘
```

- **Oficina del usuario**: su `layout.json`, intacto y editable. Ahí se sientan las sesiones raíz y los hijos directos de la raíz que **no** tienen equipo (p. ej. un `Explore` suelto), en escritorios libres.
- **Módulo de equipo**: cada hijo directo de una raíz que **tiene hijos** (un líder de fase, un nodo workflow ⚙) recibe un módulo generado a la derecha de la oficina, en orden de aparición. Dentro: el dueño en la cabecera; cada miembro con su puesto; los hijos de un miembro (p. ej. QA y pentester de un dev) en un **puesto de revisión** pegado al de ese miembro. Profundidades mayores se agrupan igual, bajo su padre, dentro del mismo módulo. Un hijo directo de la raíz que al nacer está solo se sienta en la oficina del usuario y se muda a su módulo (caminando) cuando le nace el primer hijo.
- **Nombre del área**: `label` del dueño (su tarea, p. ej. "Fase 1 · Auth"), con `⚙ ` para workflows; sin token (sin `label`), el `role`. Se pinta con el sistema de **Áreas** existente (`OfficeLayout.areas` / `areaTiles`: overlay translúcido con etiqueta), color determinista por dueño.
- **Capacidad**: el generador de T4 (`generateScopeLayout`, tope 57 puestos) se reutiliza por módulo; los módulos se colocan en columnas a la derecha sin superar `MAX_COLS`×`MAX_ROWS` (64×64); lo que no quepa espera a que se libere un módulo (un aviso).
- **Liberación**: cuando todos los agentes de un módulo salieron, el módulo se retira y los de la derecha se corren; la oficina se contrae.
- **Composición, no persistencia**: el layout visible = layout del usuario + módulos generados, compuesto en memoria. Nada de los módulos se escribe en `layout.json`; el editor de layout solo edita la parte del usuario (los módulos se ocultan mientras se edita).

### 3.2 Puerta y sala de descanso

- **Assets nuevos** (pixel art 16 px en el estilo del set, con `manifest.json` como el resto): `DOOR` (estados `closed`/`open`, montado en pared), `ARCADE`, `GAME_CONSOLE` (consola con TV), `BEANBAG` (puff). Entran al catálogo como muebles normales (categorías `wall` / `electronics` / `chairs`), así el usuario también puede colocarlos en el editor.
- **Puerta**: la primera `DOOR` del layout del usuario; si no hay, se coloca una **por defecto sin guardarla** en la primera pared exterior con una casilla caminable debajo. Se abre (estado `open`) mientras alguien la cruza.
- **Descanso**: el Área del usuario llamada "Descanso" (convención del editor de Áreas); si no existe, un **módulo de descanso** generado al final de la fila de módulos, con arcade, consola, puffs y café. Los asientos de descanso (puffs, sofás) nunca se asignan como escritorio.

### 3.3 Ciclo de vida visible

| Fase           | Disparador (servidor)                                                                                                                                                                                               | Qué se ve                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Entrada**    | nace el agente derivado (§1)                                                                                                                                                                                        | aparece en la puerta (se abre), camina a su puesto y se sienta — reemplaza el efecto matrix para derivados; las sesiones raíz conservan el suyo |
| **Trabajo**    | actividad normal                                                                                                                                                                                                    | escribe/lee en su escritorio                                                                                                                    |
| **Disponible** | fin de turno / `completed` / `failed`                                                                                                                                                                               | en su puesto, en espera                                                                                                                         |
| **Descanso**   | `IDLE_TO_LOUNGE_MS` (30 min por defecto, configurable en Ajustes) sin actividad estando disponible                                                                                                                  | se levanta y va al descanso; se sienta en un puff o juega en el arcade                                                                          |
| **Regreso**    | nueva actividad (p. ej. el padre le escribe con `SendMessage`)                                                                                                                                                      | se levanta del descanso y vuelve a su escritorio                                                                                                |
| **Salida**     | `killed`/`stopped`, `TaskStop` del padre con su `task_id`, cierre por el usuario, fin de la sesión raíz, o `LOUNGE_TO_LEAVE_MS` (60 min, configurable) en el descanso sin que nadie lo retome (aprobado 2026-09-24) | camina a la puerta, burbuja de despedida 👋, la puerta se abre y sale                                                                           |

- **Ventana de reaparición**: al adoptar/restaurar, un agente terminado solo se revive si terminó dentro de `IDLE_TO_LOUNGE_MS + LOUNGE_TO_LEAVE_MS`, y reaparece donde le toca (escritorio si terminó hace menos de `IDLE_TO_LOUNGE_MS`, si no el descanso), con sus relojes contados desde su hora real de término (mtime de su transcript). Evita que abrir la oficina en una sesión larga reviva todo el historial.
- **Timings efectivos**: el servidor manda `livingOfficeSettings { idleToLoungeMinutes, loungeToLeaveMinutes }` al conectar y en cada cambio.

- **Servidor como fuente de verdad**: el estado de vida viaja en un campo nuevo `presence: 'working' | 'available' | 'lounge' | 'leaving'` (§5). Ir al descanso y salir lo decide el servidor (así dos pestañas ven lo mismo); la animación es de la webview. Un agente en `leaving` se elimina del store tras `LEAVE_ANIMATION_MAX_MS` (la webview no bloquea la salida).
- **Cascada con despedida**: si sale un dueño, primero salen sus descendientes (hojas primero), cada uno despidiéndose; en ráfagas grandes (fin de sesión con muchos agentes) salen en fila con un pequeño escalonado.
- **Workflows**: los agentes de un run quedan disponibles al terminar su turno; salen cuando el workflow completa (sus agentes se despiden, luego el nodo ⚙).
- **Conversaciones** (§4b): al estar todo en una oficina, emisor y receptor siempre pueden caminar el uno al otro, entre módulos incluido. Un agente en el descanso que recibe un mensaje primero vuelve a su escritorio.
- **`TaskStop`**: registro `tool_use` `TaskStop` con `input.task_id` en el transcript del padre; `task_id` es la clave del agente hijo (o la task id de un workflow). Se reconoce en el proveedor (Claude) y se resuelve con la misma lógica que las notificaciones por `<task-id>`.

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

**Reglas**: una conversación a la vez por personaje (cola FIFO por emisor); todos comparten la oficina viva (§3), así que siempre se camina, entre módulos incluido — el sobre ✉ queda solo para destinatarios no resueltos (sin `toId`); un agente en el descanso primero vuelve a su escritorio; escenas de oficinas no visibles no se reproducen al entrar (solo estado actual); el paseo es puramente visual (no cambia `status` del agente).

**Privacidad**: el texto es contenido del transcript. `agentConversation` se difunde a todos, pero la capa de envío por conexión **elimina `text`** en conexiones no privilegiadas (misma regla que el feed); esas ven la escena con `…`. En VS Code (embebido, privilegiado) va completo.

## 5. Cambios de protocolo (`core/asyncapi.yaml` → regenerar `messages.ts`)

- (Entrega 2) ServerMessage `agentPresence { id, presence }` con `presence` en el esquema nombrado `AgentPresence` (`working | available | lounge | leaving`); `AgentCreated` y `AgentSeatMeta` ganan `presence?` (ausente = `working`).
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

1. **Árbol en el servidor + defecto** (§1, §2, §5 parcial: campos de agente). Visible ya en la oficina raíz como personajes derivados sentados (interim, antes de las oficinas). ✅ 2026-09-24.
2. **Oficina viva** (§3: módulos por equipo con nombre, puerta, descanso, ciclo de vida entrada/descanso/salida). Reemplaza a las oficinas por scope.
3. **Pantalla ampliada** (§4, §5 feed).
4. **Conversaciones entre agentes** (§4b, §5 conversación). Depende de 1 y 2; puede ir en paralelo con 3.

Cada entrega deja `npm run compile`, `npm test` y el e2e en verde, y actualiza `CLAUDE.md`/`CONTEXT.md` en lo que toca.

## 8. Riesgos y preguntas abiertas

- **`agent_id` del hook ≠ clave del sidecar**: si el primer test real muestra que no coinciden, se enlaza por `agent_transcript_path`/`transcript_path` (ruta del `.jsonl` del nodo) en lugar de por clave.
- **Volumen**: una sesión real acumuló 342 sidecars; solo se materializan los de spawns vivos, y cada nodo vivo agrega un watcher de 500 ms. Un equipo típico (~15 nodos vivos) es asumible; se mide en el e2e.
- **Formato de sidecar** es interno de Claude Code y puede cambiar; queda aislado en el proveedor.
