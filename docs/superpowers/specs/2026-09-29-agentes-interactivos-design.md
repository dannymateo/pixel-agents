# Agentes interactivos: traer a la oficina, te esperan y proyectos de la máquina — Diseño

- **Fecha**: 2026-09-29
- **Estado**: borrador para revisión
- **Contexto**: continúa `2026-09-28-office-terminals-design.md` (Fase 1 entregada: consola real para agentes lanzados desde la oficina). Pedido del usuario: "que cada uno de los agentes que ya están puedan interactuar conmigo, abrir su consola y pedirles cosas o aceptar permisos, que me pregunten y que me aparezca que me preguntan… que sea más que informativo, usable".
- **Dirección acordada**: (1) traer cualquier agente a la oficina + (3) "te esperan"; el puente de permisos (2) después.

## Objetivo

Que la oficina sea el lugar desde el que se **trabaja** con todos los agentes de la máquina, no solo se miran: cualquier sesión que esté corriendo se puede traer a una consola de la oficina, la oficina avisa en cuanto un agente pregunta, pide permiso o espera respuesta, y un clic lleva a responderle.

### Criterios de éxito

1. En cualquier agente raíz que corra en otra terminal hay un botón **Traer a la oficina**. Tras cerrarlo allí (`/exit`), la oficina lo **retoma solo** en una consola propia, con la misma conversación, en el mismo personaje; desde ahí se le escribe, se aceptan sus permisos y se responden sus preguntas.
2. Cuando cualquier agente (de la oficina o externo, raíz o sub-agente) **pide permiso**, **pregunta** (`AskUserQuestion`) o **termina y espera**, la oficina lo muestra: marca en su personaje, sonido, contador en el título de la pestaña y la barra **Te esperan** con quién y por qué.
3. Un clic en una entrada de **Te esperan** lleva a responder: la consola del agente (o de su raíz, si es sub-agente) si es de la oficina; si es externo, su pantalla con **Traer a la oficina**.
4. El diálogo de lanzar ofrece los **proyectos de la máquina** (carpetas donde ya se usó Claude, más recientes primero, con buscador) y las **sesiones recientes** para **Retomar** — lo que también recupera las consolas tras reiniciar el servidor. Ya no propone la carpeta donde corre el servidor.
5. Nada de esto es accesible para un visor sin token.

### Fuera de alcance (esta fase)

- Escribir a una sesión que sigue abierta en otra terminal sin traerla (la oficina no posee su proceso).
- Puente de permisos para sesiones externas sin traerlas (Fase 3 de la spec anterior; sigue siendo la siguiente).
- Consola propia para sub-agentes: no son procesos; se les habla a través de la consola de su raíz.
- Traer sesiones de VS Code u otras superficies distintas del CLI en terminal (se comportan igual si terminan con `SessionEnd`, pero no se prueba).

## Hechos verificados (2026-09-29)

- `claude --resume <id>` continúa **esa** sesión (mismo id; solo `--fork-session` crea uno nuevo) — CLI 2.1.284.
- Cada registro del transcript lleva `cwd` (la carpeta donde corría la sesión).
- `~/.claude/projects/` de esta máquina: 28 proyectos.
- Dos procesos no deben llevar la misma sesión a la vez (ambos escribirían el mismo transcript): traer exige que el original haya terminado.

## 1. Traer a la oficina

### Flujo

1. El operador pulsa **Traer a la oficina** en un agente raíz externo (overlay del personaje o su pantalla). Cliente → `takeOverAgent { id }`.
2. Servidor (`AgentRuntime.requestTakeover`):
   - Si el agente no existe, no es raíz, ya tiene consola o no hay consolas disponibles → `takeoverStatus { id, state: 'refused', reason }`.
   - Si no, lo marca **pendiente de traer** y responde `takeoverStatus { id, state: 'waitingExit' }`. La UI muestra en el personaje y en su pantalla: _"Cierra la sesión en su terminal (`/exit`); la retomo aquí."_ con **Cancelar** y **Ya la cerré** (ver 4).
3. Cuando llega `SessionEnd` de esa sesión (razón distinta de `clear` y `resume`: esas continúan la sesión en otra parte), en lugar de retirar el agente el servidor **lo retoma**: lanza `claude --resume <sessionId>` en una consola de la oficina, en su `cwd`, y **conserva el mismo agente** (id, personaje, asiento), ahora interno y con `terminalId`. Emite `takeoverStatus { id, state: 'done', terminalId }`; la UI abre su consola.
4. **Ya la cerré**: para sesiones sin hooks (no llega `SessionEnd`) o cuando el operador ya la cerró. Cliente → `takeOverAgent { id, confirmClosed: true }`: retoma de inmediato. La UI advierte antes: _"Si sigue abierta en su terminal, las dos se pisarán."_
5. **Cancelar**: `cancelTakeover { id }` quita la marca; el agente sigue siendo externo.
6. Si la retoma falla (claude no arranca, `cwd` ya no existe) → `takeoverStatus { id, state: 'failed', reason }`; el agente sale como hoy.

### Datos

- `cwd` de la sesión: el último registro con `cwd` de su transcript (lectura acotada del final del archivo); si no hay, el `cwd` del hook `SessionStart` si se vio. Sin `cwd` válido → `refused`.
- La marca de pendiente vive en memoria del servidor (se pierde al reiniciar; el agente sigue siendo externo).
- Mientras está pendiente, el personaje muestra un estado "esperando para venir" (reutiliza la etiqueta del overlay).

## 2. Sesiones recientes y proyectos de la máquina

### Servidor

`MachineSessions` (nuevo, `server/src/terminals/machineSessions.ts`), con el proveedor como fuente (`HookProvider.getAllSessionRoots`):

- **Proyectos**: por cada carpeta de `~/.claude/projects/`, el `cwd` del transcript más reciente → `{ cwd, name, lastUsed }`, más recientes primero, acotado (`MACHINE_PROJECTS_MAX`), solo carpetas que existen.
- **Sesiones recientes**: los transcripts raíz más recientes de toda la máquina → `{ sessionId, cwd, name, lastUsed, title }`, acotado (`RECENT_SESSIONS_MAX`), excluyendo las que tienen un agente vivo en la oficina. `title` = inicio del primer prompt del usuario, saneado y acotado (contenido del transcript: **solo privilegiados**).
- Lecturas acotadas (cabeza/cola del archivo, nunca el archivo entero) y cacheadas por `mtime`.

### Protocolo

- `launchOptions` pasa de `{ defaultCwd, recentDirs }` a `{ projects, recentSessions }` (privilegiado). `defaultCwd` desaparece; el diálogo propone el proyecto más reciente.
- `launchAgent` gana `resumeSessionId?`: lanza `claude --resume <id>` en el `cwd` de esa sesión (el servidor lo resuelve; el cliente no manda la carpeta en ese caso).
- `requestLaunchOptions` (cliente → servidor): refresca la lista al abrir el diálogo (resuelve el menor "recientes solo al conectar").

### Interfaz

Diálogo de lanzar con dos pestañas: **Proyectos** (lista con buscador + campo de ruta libre) y **Sesiones recientes** (lista con título, proyecto y hace cuánto, botón **Retomar**).

## 3. Te esperan

### Señales (webview; ya llegan hoy por el cable)

| Motivo               | Señal                                                                     | Se limpia con                                                                       |
| -------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Permiso**          | `agentToolPermission` / `subagentToolPermission`                          | `agentToolPermissionClear`, nuevo `agentToolStart` del agente, `agentStatus` activo |
| **Pregunta**         | `agentToolStart` con `toolName === 'AskUserQuestion'` (raíz o sub-agente) | `agentToolDone` de esa herramienta, `agentToolsClear`                               |
| **Espera respuesta** | `agentStatus: 'waiting'` de un agente raíz                                | `agentStatus: 'active'`                                                             |

Un reducer puro (`webview-ui/src/office/attention.ts`) mantiene `id → { motivo, desde }`; los sub-agentes cuentan como suyos pero **se atienden en su raíz**.

### Interfaz

- **Título de la pestaña**: `(n) Pixel Agents` mientras haya alguien esperando (vuelve a `Pixel Agents` en 0).
- **Barra Te esperan** (barra inferior): botón con el número; abre la lista (agente, motivo con icono, hace cuánto). Clic →
  - agente de la oficina (o sub-agente de uno): abre la **consola** de su raíz;
  - externo: abre su **pantalla** con **Traer a la oficina** a la vista.
- **Personaje**: las burbujas de permiso y espera existentes; la pregunta usa la burbuja de permiso con icono "?". Sonidos: los existentes (permiso, fin de turno); la pregunta suena como permiso.
- Visor sin token: ve las burbujas (como hoy), no la barra ni el contador (no puede responder).

## 4. Seguridad

- `takeOverAgent`, `cancelTakeover`, `requestLaunchOptions` y `launchAgent` con `resumeSessionId` son **privilegiados** (fuera de `VIEWER_MESSAGES`), y solo con consolas disponibles (loopback + node-pty).
- `resumeSessionId` se valida como id de sesión seguro (`isSafeSessionId`) y debe corresponder a un transcript bajo las raíces del proveedor; el `cwd` sale del transcript, nunca del cliente.
- `title` y rutas de proyectos: solo a conexiones privilegiadas.
- Traer nunca mata un proceso ajeno: espera `SessionEnd` o la confirmación explícita del operador.

## 5. Errores, pruebas y entrega

### Errores

- `SessionEnd` con razón `clear`/`resume` durante una marca pendiente: la sesión continúa en otra parte → la marca sigue (espera el siguiente `SessionEnd`).
- El agente pendiente desaparece por otra vía (stale, cierre del usuario) → se descarta la marca.
- Retoma con `cwd` inexistente → `failed` con motivo legible.
- Sesión reciente cuyo transcript ya no existe → `launchResult { ok: false }`.

### Pruebas

- **Servidor (Vitest)**: `requestTakeover` (rechazos, pendiente, `SessionEnd` → retoma en el mismo agente con `--resume <id>` y su `cwd`, razones `clear`/`resume` no disparan, cancelar, confirmación explícita, fallo); `MachineSessions` (proyectos y sesiones con transcripts sintéticos, acotado, excluye vivas, sin `cwd` válido); `launchAgent` con `resumeSessionId` (validación, cwd del transcript); privilegio de cada mensaje nuevo.
- **Webview (Vitest)**: reducer de atención (cada señal y su limpieza, sub-agente → raíz, contador); enrutado del clic.
- **E2E standalone**: (a) sesión externa mock con hooks → Traer a la oficina → el mock emite `SessionEnd` → aparece la consola del mismo personaje con el mock retomado (`--resume <id>` en la invocación); (b) un agente pide permiso → "Te esperan (1)" y el título `(1)` → clic abre su consola; (c) diálogo: Retomar una sesión reciente.

### Entrega por fases

1. **Te esperan** (solo webview; valor inmediato con los agentes de hoy).
2. **Proyectos de la máquina + sesiones recientes + Retomar** (servidor + diálogo).
3. **Traer a la oficina** (servidor + UI + e2e).
4. (Siguiente spec) Puente de permisos para externas sin traerlas.

Incluye además el menor aparcado de la Fase 1: la ✕ del Debug View pide la misma confirmación que el overlay para agentes con consola.

### Documentación

ADR `docs/adr/0005` (traer a la oficina: esperar `SessionEnd`, nunca matar un proceso ajeno; `--resume` conserva el id); `CONTEXT.md` (Traer a la oficina, Te esperan, Sesión reciente); CLAUDE.md (mensajes privilegiados nuevos).
