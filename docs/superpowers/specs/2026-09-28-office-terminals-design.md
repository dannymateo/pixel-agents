# Consolas en la oficina: salas por sesión, pizarra y puente de permisos — Diseño

- **Fecha**: 2026-09-28
- **Estado**: borrador para revisión
- **Secciones aprobadas en conversación**: 1 (alcance y arquitectura), 2 (ciclo de vida de la terminal), 3 (puente de permisos), 4 (interfaz — revisada: sala por sesión + pizarra), 5 (errores, pruebas y entrega).

## Objetivo

Trabajar con los agentes **desde la oficina en el navegador** (`npx pixel-agents`) sin volver a la consola: lanzarlos, escribirles, responder sus permisos y preguntas, y ver qué hacen, con la misma experiencia que la terminal. Hoy la oficina solo observa; esto añade el canal de vuelta.

### Criterios de éxito

1. Desde el botón **+ Agent** se lanza una sesión de Claude Code que aparece en su **propia sala**, con una **pizarra** en la pared que muestra su consola en miniatura.
2. Clic en la pizarra abre la **consola real** (la misma interfaz de `claude` que en una terminal): se puede escribir prompts, responder permisos y preguntas, usar `/comandos`, Esc y Ctrl+C — una sesión completa sin tocar una terminal del sistema.
3. Cerrar y reabrir el navegador no mata la sesión: la consola se reengancha con lo último que mostró.
4. Una sesión abierta en **otra** terminal que pide permiso mientras la oficina está visible se puede **Permitir/Denegar desde la oficina**; si no se responde en 60 s, o la oficina no está visible, pregunta en su terminal como siempre.
5. Un cliente sin token (visor) nunca ve la salida de una consola, ni puede escribir, lanzar o responder permisos.

### Fuera de alcance (v1)

- La extensión de VS Code (solo standalone).
- Escribir texto libre a sesiones abiertas en otras terminales (la oficina no posee su proceso).
- Retomar una sesión de la oficina tras reiniciar el servidor (`claude --resume` desde la oficina) — fase posterior.
- "Permitir siempre" en el puente de permisos (necesita `updatedPermissions`, sin verificar).
- Multiusuario / oficina compartida en red.

## Decisiones y alternativas descartadas

- **Terminal real embebida (pseudo-terminal + xterm.js)**, elegida por el usuario frente a un chat estructurado sobre el Agent SDK. Da paridad total con la consola (`/comandos`, prompts de permiso, preguntas) sin reimplementar la interfaz de Claude. Coste: dependencia nativa y que las preguntas se responden en la consola, no como botones de la oficina.
- **`claude -p --input-format stream-json`**: descartado; el protocolo de entrada no está documentado.
- **`node-pty` 1.1.0**: verificado el 2026-09-28 en Windows — se instala con binario precompilado (sin `node-gyp`) y abre una shell funcional. Es la dependencia elegida.
- **Puente de permisos por hook**: el hook `PermissionRequest` puede devolver una decisión y Claude Code la aplica; mientras el hook espera, la terminal no muestra su prompt en paralelo. Por eso el hook solo espera cuando hay una oficina **visible** (§3). _Verificar contra la documentación oficial el formato exacto de la salida y la semántica de timeout como primera tarea del plan._

## 1. Arquitectura

Dos niveles de interacción:

| Nivel                  | Sesiones                                                 | Qué se puede hacer                                            |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| **Consola**            | Lanzadas desde la oficina (el servidor posee el proceso) | Todo: escribir, permisos, preguntas, `/comandos`, interrumpir |
| **Puente de permisos** | Abiertas en otras terminales                             | Permitir / Denegar desde la oficina (con espera acotada)      |

Una sesión de la oficina escribe su transcript y dispara hooks como cualquier otra: personaje, pantalla del agente, árbol de sub-agentes y conversaciones funcionan sin cambios. La consola es solo el canal crudo de entrada/salida.

### Piezas nuevas

- **`server/src/terminals/ptyHost.ts` — `PtyHost`**: crea, lista y cierra pseudo-terminales; búfer circular de salida por terminal; asociación terminal ↔ sesión por `--session-id`. Recibe la fábrica de pty por inyección (tests con un pty falso).
- **`server/src/terminals/permissionBridge.ts` — `PermissionBridge`**: decide si un `PermissionRequest` espera, guarda las preguntas pendientes, resuelve con la primera respuesta o al vencer.
- **Protocolo (`core/asyncapi.yaml` → `messages.ts`)**: mensajes de §2 y §3.
- **Hook script (`claude-hook.ts`)**: para `PermissionRequest`, espera la respuesta del servidor y escribe la decisión en stdout.
- **Instalador**: `timeout` mayor solo para `PermissionRequest`.
- **Webview**: diálogo de lanzar, sala por sesión en `composeOffice`, pizarra (mueble + capa DOM), modal de consola (xterm.js), botones del puente, indicador "te esperan".

### Seguridad (invariantes)

- Todo mensaje de consola, lanzamiento y puente es **privilegiado** (token): entra por la lista blanca de `clientMessageHandler` solo para el operador.
- La salida de una consola **nunca se difunde**: va punto a punto a las conexiones enganchadas (como el feed).
- Consolas, lanzamiento y puente **solo con el servidor en loopback**: la CLI acepta `--host`, y exponer una consola en la red daría una shell remota a quien tenga el token. Con un `host` que no sea loopback, `providerCapabilities.terminals = false` y esos mensajes se rechazan (el resto de la oficina funciona igual).
- La salida la dibuja xterm.js como terminal; la miniatura de la pizarra la pinta como texto plano (nunca HTML).

## 2. Ciclo de vida de una consola

**Lanzar**: el cliente con token envía `launchAgent { cwd, bypassPermissions }`. `PtyHost` genera un UUID y arranca `claude --session-id <uuid>` (vía `HookProvider.buildLaunchCommand`) en la pseudo-terminal, en `cwd` (en Windows a través de `cmd.exe /c`, porque `claude` es un `.cmd`). El agente se registra como **interno** (tiene consola; no headless) con `terminalId`, y el `SessionRouter` asocia sus hooks por session id. `cwd` por defecto: el directorio donde corre el servidor; las carpetas usadas se guardan como recientes en `config.json` (`standalone.recentLaunchDirs`, acotado).

**Mensajes**:

| Dirección          | Mensaje                                            | Uso                                                                |
| ------------------ | -------------------------------------------------- | ------------------------------------------------------------------ |
| cliente → servidor | `launchAgent { cwd?, bypassPermissions? }`         | lanzar                                                             |
| cliente → servidor | `terminalAttach { terminalId }` / `terminalDetach` | engancharse / soltarse                                             |
| cliente → servidor | `terminalInput { terminalId, data }`               | teclas                                                             |
| cliente → servidor | `terminalResize { terminalId, cols, rows }`        | tamaño                                                             |
| cliente → servidor | `terminalClose { terminalId }`                     | matar (tras confirmar)                                             |
| servidor → cliente | `terminalSnapshot { terminalId, data }`            | al engancharse (punto a punto)                                     |
| servidor → cliente | `terminalOutput { terminalId, data }`              | en vivo (punto a punto)                                            |
| servidor → cliente | `terminalExit { terminalId, code }`                | fin del proceso                                                    |
| servidor → cliente | `terminalTail { terminalId, lines }`               | últimas líneas para la pizarra (solo privilegiados, con limitador) |
| servidor → cliente | `launchResult { ok, agentId?, error? }`            | respuesta al lanzar                                                |

**Varias pestañas**: todas las enganchadas ven la salida; cualquiera escribe; el tamaño lo fija el último `terminalResize`.

**Cerrar el navegador**: la terminal sigue viva; al volver, `terminalAttach` recibe el snapshot.

**Fin**: `/exit` o fin de `claude` → `terminalExit` y el agente sale por el `sessionEnd` existente. Cerrar el agente desde la oficina (con confirmación) mata la terminal. **Detener el servidor** mata todas; el trabajo queda en el transcript.

**Límites** (en `server/src/constants.ts`): `MAX_OFFICE_TERMINALS` (8), `TERMINAL_BUFFER_BYTES` (256 KB), tasa máxima de `terminalInput`/`terminalResize` por conexión, `TERMINAL_TAIL_LINES` y su intervalo mínimo.

## 3. Puente de permisos (sesiones externas)

**Cuándo espera el hook** — ambas condiciones:

1. La sesión **no** es una consola de la oficina (esas responden en su consola).
2. Hay al menos una conexión con token **visible**: el cliente envía `officeVisibility { visible }` con la Page Visibility API.

**Flujo**:

1. El hook envía `PermissionRequest` como hoy. Sin espera → el servidor responde vacío al instante (comportamiento actual). Con espera → retiene la respuesta HTTP hasta `PERMISSION_BRIDGE_WAIT_MS` (60 s) y emite `permissionAsk { askId, agentId, toolName, summary, expiresAt }` a las conexiones con token (`summary` = resumen del input de la herramienta: contenido privilegiado).
2. La oficina muestra en la burbuja del personaje y en su pantalla **Permitir / Denegar** con cuenta atrás.
3. `permissionAnswer { askId, behavior: 'allow' | 'deny' }` resuelve la espera; el hook escribe la decisión en stdout y Claude continúa.
4. Sin respuesta a tiempo, la oficina deja de estar visible o la sesión termina → respuesta vacía → el prompt normal de la terminal. El servidor emite `permissionAskClosed { askId, reason }` y la burbuja pasa a "respóndele en su terminal".

**Detalles**:

- Timeout del hook `PermissionRequest` en `settings.json`: `PERMISSION_HOOK_TIMEOUT_SEC` (90) > espera del servidor. El resto de eventos no cambia.
- Varios servidores: el script consulta a todos en paralelo y gana la primera decisión; los que no esperan devuelven vacío enseguida.
- `askId` aleatorio y de un solo uso; solo una conexión con token puede responder; se aplica la primera respuesta.
- Un visor ve la burbuja genérica de "espera permiso", sin detalle ni botones.
- Cualquier error del servidor o del script resuelve **vacío**: nunca aprueba por defecto.

## 4. Interfaz

### Sala por sesión

Cada sesión lanzada desde la oficina recibe una **sala generada** en `composeOffice`, como los módulos de equipo: en memoria, nunca guardada en `layout.json`, excluida de `savableLayout`, oculta en el editor, con etiqueta de Area (la carpeta de la sesión). Contiene la **pizarra** en su pared superior, el escritorio de la sesión raíz y asientos para sus sub-agentes sueltos. Los **módulos de equipo** de esa sesión se colocan contiguos a su sala. Las sesiones externas siguen en la oficina del usuario.

`composeOffice` gana un `SessionSpec { ownerId, label, terminalId }` junto a `TeamSpec`; la oficina se compone también cuando hay consolas de la oficina (hoy solo con agentes derivados).

### Pizarra

- Mueble `WHITEBOARD` (asset existente, 2×2, de pared) con una variante "encendida".
- Encima, una **capa DOM proyectada** (`overlayProjection`, como las etiquetas) con las últimas líneas de `terminalTail`, texto plano monoespaciado, escalada con el zoom.
- Estados: trabajando (texto avanza) · te espera (permiso, pregunta o fin de turno: marco parpadeante ⚑ + sonido) · terminada (apagada).
- **Clic en la pizarra o en el personaje raíz** → **modal de consola**: xterm.js casi a pantalla completa con addon _fit_, foco de teclado propio (las teclas del editor no interfieren), Esc va a Claude; se cierra con ✕.
- Visor sin token: pizarra apagada, sin texto ni clic.

### Lanzar

**+ Agent** abre un diálogo pixel-art: carpeta (campo + recientes), "saltar permisos" (con aviso), Lanzar. Al aceptar: aparece la sala, el personaje entra con el efecto matrix y el modal de consola se abre.

### Te esperan

- Contador en el título del navegador (`(2) Pixel Agents`) mientras haya agentes esperando.
- Indicador en la barra inferior que lleva al siguiente: abre su consola (sesión de la oficina) o su pantalla con los botones del puente (externa).

### Estilo

Reglas de la casa (colores en `constants.ts`, `pixel-shadow`, FS Pixel Sans); tema de xterm con la paleta de la oficina.

## 5. Errores, pruebas y entrega

### Errores

- `claude` ausente o falla al arrancar: el error se ve en la consola; `launchResult { ok: false, error }`; no se crea agente.
- `node-pty` no carga: el servidor arranca igual; `providerCapabilities.terminals = false`; la UI oculta **+ Agent** con un aviso. El resto funciona.
- Caída del WebSocket: la terminal sigue viva; al reconectar, snapshot.
- Proceso de `claude` muere inesperadamente: `terminalExit` con código, visible en la consola.
- Puente: cualquier error resuelve vacío (falla cerrado hacia la terminal).

### Pruebas

- **Servidor (Vitest)**: `PtyHost` con pty falso (ciclo de vida, búfer acotado, attach/snapshot, límites, cierre al detener); puerta de privilegio de cada mensaje nuevo; `PermissionBridge` (espera/no espera por visibilidad y por sesión de la oficina, decisión, timeout, cierre de pestaña, primera respuesta gana, `askId` inválido o reusado); salida del hook script para una decisión (integración, como `claude-hook.test.ts`).
- **Webview (Vitest)**: composición de salas por sesión (contigüidad con sus módulos, excluida de `savableLayout`); reducer de "te esperan" y contador del título.
- **E2E standalone (Playwright)**: lanzar con mock-claude en la pty real → la consola muestra su salida → teclear → el mock lo recibe (extender `mock-claude-runner` para leer y registrar stdin); sesión externa pide permiso con la oficina visible → Permitir → el mock recibe la decisión; con la pestaña oculta → no espera.

### Entrega por fases

1. `PtyHost` + protocolo + lanzar + modal de consola (nivel 1, sin sala aún: la consola se abre desde el personaje).
2. Sala por sesión + pizarra.
3. Puente de permisos (nivel 2).
4. "Te esperan" + contador en el título.

Cada fase termina verificada y usable.

### Documentación

ADR `docs/adr/0004` (terminal real vs SDK vs stream-json; política de espera del hook); `CONTEXT.md` (Consola, Sesión de la oficina, Sala de sesión, Pizarra, Puente de permisos); CLAUDE.md (privilegio de consolas y puente, dependencia `node-pty`).
