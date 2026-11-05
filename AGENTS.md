# AGENTS.md — Reglas para agentes de IA en este repositorio

Este archivo lo leen Claude Code, Codex, Cursor y cualquier otro agente. `CLAUDE.md` apunta aquí.

## Proyecto

Bot de Cuatro en línea 8×7 que juega contra un árbitro HTTP (long polling) y una app web para
jugar contra él. Detalle en `PLAN_BACKEND.md`, `PLAN_FRONTEND.md` y `docs/TECNICO.md`.

## Estructura

```
src/engine/   Reglas y motor de búsqueda. TypeScript PURO: sin I/O, sin red, sin Node APIs.
src/client/   Cliente del árbitro y ciclo del bot. fetch inyectable.
src/api/      Servidor HTTP para la app web + workers del motor.
src/mock/     Árbitro simulado (fiel a docs/arbitro-openapi.json).
src/cli/      Puntos de entrada (start, mock, selfplay, practice, submit, me).
web/          App React + Vite. Importa reglas de src/engine/rules.ts.
test/         Pruebas Vitest (*.test.ts), espejo de src/.
docs/         TECNICO.md, MANUAL.md, IA_BITACORA.md, OpenAPI del árbitro.
```

## Comandos

| Comando | Qué hace |
|---|---|
| `npm install` | Instala dependencias |
| `npm test` | **Todas** las pruebas + cobertura (debe quedar verde antes de cada commit) |
| `npm run typecheck` | Verificación de tipos de TypeScript |
| `npm start` | Bot del torneo (si hay `ARBITRO_URL`) + API + app web en :8787 |
| `npm run mock` | Árbitro simulado local en :8790 |
| `npm run dev:web` | App en modo desarrollo (Vite, :5173) |
| `npm run selfplay` | Partidas motor vs motor para medir cambios |

## Convenciones

- Node 24 ejecuta TypeScript directamente: los imports relativos llevan extensión `.ts`.
  Sólo sintaxis "borrable" (nada de `enum`, `namespace` ni *parameter properties*).
- Tablero del protocolo: `board[fila][columna]`, fila 0 = abajo, 7 filas × 8 columnas,
  0 vacío, 1 jugador que abre, 2 el otro. No cambiar esta convención en ninguna capa.
- `src/engine` no importa nada fuera de `src/engine`. La lógica de juego nunca se mezcla con HTTP.
- Funciones pequeñas, nombres en inglés para código y en español para textos de usuario y docs.
- Toda función nueva del motor o del cliente lleva prueba que documente su comportamiento.

## Qué NO tocar / prohibido

- Nunca escribir el token del equipo en el repo. Se lee de `TEAM_TOKEN`. `.env` está ignorado.
- No interferir con el árbitro ni con otros bots (descalifica). Sólo los endpoints documentados.
- No cambiar `docs/arbitro-openapi.json` salvo para reemplazarlo por la versión oficial.
- No reescribir `PLAN_*.md`: los cambios de rumbo se explican en `docs/TECNICO.md`.
- No bajar el presupuesto de seguridad de tiempo (`BOT_THINK_MS` ≤ 2000) sin medir en el árbitro.
- No hacer `git push` ni publicar nada sin que lo pida una persona del equipo.
