# Plan de ejecución — Backend (bot Cuatro en línea 8×7)

> Equipo 3 · Escrito **antes de la primera línea de código**. Cualquier cambio de rumbo se
> documenta después en `docs/TECNICO.md` (sección "Desviaciones respecto al plan").

## 1. Alcance

| Incluido | Fuera de alcance |
|---|---|
| Motor de juego (reglas + búsqueda) en TypeScript puro, sin dependencias | Aprendizaje automático / redes neuronales (no hay tiempo de entrenar ni de explicarlo bien) |
| Cliente del árbitro con long polling, robusto ante caídas de red | Solver perfecto de 8×7 (el espacio es demasiado grande para 2 s por jugada) |
| API HTTP para la app web, usando **el mismo motor** que el torneo | Base de datos: el estado de una partida web vive en el navegador |
| Árbitro simulado (mock) que implementa `arbitro-openapi.json` v1.0.1 | |
| Pruebas automatizadas con cobertura y un solo comando (`npm test`) | |
| Herramienta de auto-juego (self-play) para medir cambios del motor | |

**Objetivo de calidad del bot:** cero derrotas por jugada ilegal, tiempo o desconexión, y ganar
siempre contra `casa-basico` jugando primero o segundo.

## 2. Stack y por qué

- **Node.js 24 + TypeScript** (ejecutado directamente con *type stripping* de Node, sin paso de
  compilación). Un solo lenguaje para motor, bot, API y frontend: el frontend reutiliza las
  reglas, y todos en el equipo pueden leer el código.
- **Vitest + cobertura v8**: `npm test` corre todo y reporta cobertura.
- **`node:http` y `fetch` nativos**: cero dependencias de servidor. Menos superficie de fallo.
- **`worker_threads`**: la búsqueda es CPU intensiva y bloquea el *event loop*. El motor del
  torneo corre en un worker dedicado y el de la app web en otro, para que una partida web
  **nunca** retrase una jugada del torneo.

## 3. Arquitectura

```
                 ┌──────────────── proceso `npm start` ─────────────────┐
 Árbitro  ◄────► │ client/arbiterClient ─► client/botLoop ─► Worker "torneo" ─┐
 (HTTPS,         │                                                   │  engine/ (puro) │
 long polling)   │ api/server (HTTP :8787) ─► Worker "web" ──────────┘                │
                 │        └─ sirve web/dist (la app)                                 │
                 └───────────────────────────────────────────────────────────────────┘
 Navegador ──HTTP──► api/server
```

Separación estricta en capas (ninguna capa importa a una superior):

| Módulo | Responsabilidad | Depende de |
|---|---|---|
| `src/engine/rules.ts` | Reglas legibles sobre matriz 7×8: caída de ficha, jugadas legales, victoria (4 direcciones) y línea ganadora, empate. Lo usan la app web, el cliente (validación) y las pruebas como **oráculo**. | nada |
| `src/engine/bitboard.ts` | Representación rápida del tablero: bitboard de 64 bits (8 columnas × 8 bits, 7 filas + 1 centinela) partido en dos enteros de 32 bits (JS no tiene enteros de 64 bits rápidos). | nada |
| `src/engine/evaluate.ts` | Heurística: amenazas (casillas que completan 4), paridad de filas (zugzwang), ventanas de 3 y 2, control del centro. | bitboard |
| `src/engine/tt.ts` | Tabla de transposición con *Zobrist hashing* sobre `TypedArray` (sin objetos ⇒ sin presión de GC). | — |
| `src/engine/search.ts` | Negamax con poda alfa-beta, PVS, *iterative deepening*, control de tiempo, ordenamiento de jugadas. | bitboard, evaluate, tt |
| `src/engine/index.ts` | API pública: `new Engine().search(grid, player, { timeMs, maxDepth })`. | todo engine |
| `src/client/arbiterClient.ts` | Llamadas HTTP tipadas al árbitro (`next`, `move`, `me`, `practice`, `submission`, `game`). `fetch` inyectable ⇒ se prueba sin red. | — |
| `src/client/botLoop.ts` | Ciclo: pedir turno → decidir → validar → enviar; reintentos y *backoff*; nunca muere. | arbiterClient, decisor inyectado |
| `src/api/server.ts` | API para la app web + archivos estáticos de `web/dist`. | engine (vía pool) |
| `src/api/enginePool.ts` / `engineWorker.ts` | Envoltura de `worker_threads` alrededor del motor. | engine |
| `src/mock/mockArbiter.ts` | Árbitro simulado fiel al OpenAPI (long polling, reloj de 3 s, ausencia a 30 s, bots de la casa). | rules |
| `src/cli/*.ts` | Puntos de entrada: `start`, `mock`, `selfplay`, `practice`, `submit`, `me`. | — |

## 4. Algoritmo elegido y por qué

**Negamax con poda alfa-beta + iterative deepening + tabla de transposición + heurística de
amenazas.** Fuentes: Pascal Pons, *"Solving Connect 4: how to build a perfect AI"*
(blog.gamesolver.org) para bitboards, orden de jugadas y "jugadas que no pierden"; Victor
Allis, *"A Knowledge-based Approach of Connect-Four"* (1988) para la regla de paridad de
amenazas (zugzwang). Lo adaptamos a 8×7 (máscaras, tamaño de columna, tabla de zobrist).

Por qué no las alternativas:
- **MCTS**: con 2 s y JS rinde menos que alfa-beta en Cuatro en línea (juego táctico, con
  amenazas forzadas); además es más difícil de explicar por qué jugó una jugada.
- **Minimax sin poda / profundidad fija**: desperdicia el tiempo; con iterative deepening
  usamos todo el presupuesto y siempre tenemos una respuesta lista.
- **Solver perfecto**: no cabe en 2 s desde la apertura de 8×7. Pero al final de la partida
  nuestra búsqueda llega al final del árbol y **juega perfecto** automáticamente.

Detalles clave:
1. **Bitboard** 2×32 bits: jugar es una suma; detectar 4 en línea son 4 pares de *shift & AND*.
2. **Jugadas que no pierden** (Pons): si el rival amenaza ganar, sólo se considera bloquear; nunca
   se juega debajo de una casilla ganadora del rival. Reduce mucho el árbol.
3. **Orden de jugadas**: jugada de la TT → jugadas que crean más amenazas → centro primero →
   *killer moves* / *history heuristic*.
4. **Puntaje**: victoria = `WIN − ply` (gana lo antes posible, pierde lo más tarde posible).
5. **Heurística de hojas**: amenazas propias/rivales con peso según la paridad de su fila
   (jugador 1 prefiere filas impares 1-indexadas, jugador 2 pares), ventanas abiertas de 3 y 2,
   y fichas en columnas centrales.
6. **Tiempo**: presupuesto `BOT_THINK_MS` (por defecto 1500 ms, < 2000 recomendados). Se revisa
   el reloj cada 2048 nodos; no se inicia una iteración nueva si ya se usó > 45 % del
   presupuesto; si se acaba en medio de una iteración, se usa la mejor jugada de la última
   iteración completa.
7. **TT persistente entre jugadas** de la misma partida (lo ya calculado se reutiliza).
8. (Si sobra tiempo) **libro de aperturas** precalculado con búsquedas largas fuera de línea
   para las primeras jugadas, que es donde 2 s rinden menos.

## 5. API para la app web

Sin estado en el servidor: la app envía la lista de jugadas y el servidor reconstruye el tablero.

| Método y ruta | Cuerpo / respuesta |
|---|---|
| `GET /api/health` | `{ ok: true, version, bot: { enabled, connected } }` |
| `POST /api/bot/move` | `{ moves: number[], level: "facil" \| "medio" \| "dificil" \| "maximo" }` → `{ column, score, depth, nodes, timeMs, pv }` |
| `GET /api/bot/status` | Estado del bot del torneo: conectado, partidas jugadas, última jugada, profundidad media. |
| `GET /api/replay/:gameId` | Proxy a `GET {ARBITRO_URL}/api/games/{id}` para reproducir partidas del torneo (evita CORS). |
| `GET /*` | Archivos de la app (`web/dist`). |

Errores: `400 { error: "illegal_position" \| "validation", message }`. El servidor valida que
las jugadas sean legales con `rules.ts` antes de llamar al motor.

## 6. Pasos en orden (con criterio de listo)

| # | Paso | Listo cuando… |
|---|---|---|
| 1 | Planes + `AGENTS.md` en el repo | Primer commit sólo con planes |
| 2 | Andamiaje: `package.json`, `tsconfig`, Vitest con cobertura | `npm test` corre (aunque haya 0 pruebas) |
| 3 | `rules.ts` + pruebas | Caída, legales, 4 direcciones, empate, línea ganadora: verdes |
| 4 | `bitboard.ts` + pruebas diferenciales | 10 000 partidas aleatorias: bitboard y `rules.ts` coinciden en cada jugada |
| 5 | `search.ts` + `evaluate.ts` + `tt.ts` | Encuentra victoria en 1, bloquea derrota en 1, gana en 3 forzado; nunca ilegal; respeta tiempo con margen |
| 6 | Mock del árbitro | Las pruebas del cliente corren contra él; `npm run mock` levanta uno local |
| 7 | `arbiterClient` + `botLoop` | Juega partidas completas contra el mock sin errores; maneja 409, 400, 401, red caída |
| 8 | Workers + API web | `POST /api/bot/move` responde en ≤ tiempo del nivel; torneo y web en paralelo sin bloqueo |
| 9 | Self-play / benchmark | Profundidad y nodos/s medidos; versión nueva ≥ 55 % vs anterior antes de aceptarla |
| 10 | Integración con el árbitro real (8:00) | `npm run me` OK; práctica vs `casa-basico` ganada como 1 y como 2; tiempos `ms` < 2000 |
| 11 | Entrega | Commit final registrado con `npm run submit` antes de 9:45 |

## 7. Riesgos y mitigación

| Riesgo | Impacto | Mitigación |
|---|---|---|
| Timeout por búsqueda larga o GC | Derrota | Corte por reloj cada 2048 nodos, TT en `TypedArray`, presupuesto 1500 ms; medir `ms` real en `/api/games/{id}` en la práctica y ajustar `BOT_THINK_MS` |
| Jugada ilegal por bug del motor | Derrota | Validación final contra `legal_moves` del árbitro y `rules.ts`; *fallback* a la primera legal ordenada al centro; pruebas diferenciales |
| Caída de red / árbitro reiniciado | Derrota por ausencia (30 s) | Reintento en 0.5–2 s, `AbortController` con timeout por petición, el ciclo nunca termina; `uncaughtException` registrado y continuar |
| La laptop se duerme durante la liga | Derrota por ausencia | `caffeinate -i npm start` en macOS (documentado en el README) |
| Partida web bloquea el torneo | Timeout | Workers separados para torneo y web |
| OpenAPI definitivo cambia | Cliente roto | Toda la lectura del protocolo vive en `arbiterClient.ts` con tipos; parseo tolerante (campos extra ignorados, `board` o `moves` como fuente) |
| Token filtrado | Suplantación | Sólo por variable de entorno; `.env` en `.gitignore` |
| Bug sutil en bitboard de 2×32 bits | Juega mal sin fallar | Pruebas diferenciales contra `rules.ts` en miles de partidas aleatorias |

## 8. Cómo se validará

- **Unitarias** (Vitest): reglas, bitboard, evaluación, búsqueda (tácticas conocidas, límites,
  tiempo), cliente contra árbitro simulado, API con `fetch` real a un servidor efímero.
- **Diferenciales**: bitboard vs reglas legibles en partidas aleatorias.
- **Integración**: partida completa bot ↔ mock por HTTP real.
- **Fuerza**: self-play entre versiones y contra un rival "casa-basico" local; registro de
  profundidad alcanzada y nodos/segundo.
- **Cobertura**: meta ≥ 85 % en `src/engine` y `src/client` (mínimo exigido 70 %), umbral
  configurado en Vitest para que falle si baja.

## 9. Qué se delega a la IA y cómo se verifica

| Delegado a la IA (Claude Code) | Verificación humana / automática |
|---|---|
| Borrador de máscaras y *shifts* del bitboard 8×7 | Pruebas diferenciales contra `rules.ts`; revisión manual de constantes |
| Implementación de negamax/TT/iterative deepening | Posiciones tácticas con respuesta conocida; prueba de tiempo; self-play |
| Heurística y sus pesos | Self-play A/B: sólo se acepta si gana más |
| Mock del árbitro a partir del OpenAPI | Comparar respuestas con los ejemplos del OpenAPI; luego contra el árbitro real |
| Pruebas y documentación | Revisión de que cada prueba verifica comportamiento, no sólo "que no explote" |

Registraremos en `docs/IA_BITACORA.md` qué se le pidió a la IA, qué devolvió mal y cómo lo
detectamos.
