# Bitácora de uso de IA

Registro honesto de **qué le pedimos a la IA, qué devolvió mal y cómo lo detectamos**. Es la base
de la parte "cómo usamos la IA" de la exposición.

## Herramientas y forma de trabajo

- **Claude Code** (CLI) como agente principal, con el modelo Opus para orquestar, planear y
  revisar, y el modelo **Fable** (más grande) para la lógica del motor de búsqueda.
- Patrón **orquestador + sub-agentes en paralelo**: una vez escritos y confirmados los planes y el
  contrato (`src/engine/rules.ts` y la interfaz `Engine.search`), lanzamos tres agentes a la vez:
  motor (Fable), backend/mock/cliente (Opus) y frontend (Opus). Cada uno tenía archivos propios
  para no pisarse, y ninguno podía hacer commits: los commits los revisa y hace el orquestador.
- `AGENTS.md` fija las reglas que cualquier agente debe seguir (estructura, convenciones, qué no
  tocar, nunca subir el token).
- Regla de oro: **ninguna salida de la IA se acepta sin una prueba que la verifique.** Por eso
  `rules.ts` (legible) sirve de oráculo contra el motor rápido (bitboard).

## Qué pedimos (prompts clave, resumidos)

| # | Pedido | Para qué |
|---|---|---|
| 1 | "Analiza las bases y el OpenAPI y arma un plan antes de escribir código" | `PLAN_BACKEND.md`, `PLAN_FRONTEND.md` (primeros commits) |
| 2 | "Reglas legibles del 8×7 con la convención del árbitro" | `rules.ts`, el oráculo |
| 3 | "Motor: bitboard 2×32 bits, negamax alfa-beta, TT, iterative deepening, heurística de paridad; con pruebas diferenciales contra rules.ts" | `src/engine/*` |
| 4 | "Cliente del árbitro con long polling, mock fiel al OpenAPI, API para la web en workers" | `src/client`, `src/mock`, `src/api` |
| 5 | "App React con estados claros, deshacer, niveles, panel del bot, repetir partidas" | `web/` |
| 6 | "Un rival típico (minimax clásico) para medir nuestro bot" | `tools/rivals`, `tools/arena.ts` |

## Errores de la IA que detectamos

| # | Qué devolvió mal la IA | Cómo lo detectamos | Corrección |
|---|---|---|---|
| 1 | Al escribir la prueba de **empate**, la IA propuso un tablero "lleno sin ganador" con filas alternadas que en realidad tenía **un cuatro en diagonal** (fila 0 col 0-1, fila 2-3 col 2-3). | Antes de usarlo lo verificamos con `findWinner` de `rules.ts`; devolvió un ganador. | Generamos el tablero buscando con un pequeño script una combinación de filas sin ningún cuatro, y la prueba quedó verde. |
| 2 | **Contrato roto entre agentes:** el agente del frontend supuso `WIN_SCORE = 100000`; el del motor usó `10000`. La app habría mostrado mal "victoria forzada en N". | Revisión del orquestador al integrar (comparar constantes de ambos lados). | Se alineó a 10000 y se agregó una **prueba de contrato** (`test/web/format-replay.test.ts`) que falla si vuelven a divergir. |
| 3 | El motor construyó **cuatro veces** posiciones de prueba "tranquilas" que en realidad ya tenían una victoria inmediata. | `gridFromMoves` lanzó "jugada después del final" y el bench mostraba `forced` con puntaje 10000. | Posiciones generadas con semilla y filtradas por el propio motor. |
| 4 | Prueba de "no jugar debajo de la casilla ganadora del rival" mal planteada: la posición ya era una doble amenaza perdida. | La prueba falló; al analizarla el error era del planteamiento, no del motor. | Se reescribió la posición. |
| 5 | Prueba del límite de la evaluación esperaba 8000 y obtuvo 9: la posición tenía una amenaza rival que cancelaba exactamente la propia. | Prueba fallida + análisis manual. | Prueba reescrita; la evaluación era correcta. |
| 6 | Se exigió profundidad ≥ 3 para "ganar en 3", pero los chequeos tácticos por nodo la encuentran en profundidad 1. | Prueba fallida. | Se corrigió la expectativa (es una mejora, no un bug). |
| 7 | La prueba diferencial con 3000 partidas excedía el tiempo con la instrumentación de cobertura (39 s). | `npm test` lento / timeout. | Se redujo a 800 partidas (siguen siendo ~30 000 posiciones comparadas). |
| 8 | Campo `depth` de la TT en `Uint8Array`: una profundidad negativa se habría convertido en 255. | Revisión de código (no lo detectó ninguna prueba). | Se agregó un *clamp*. |
| 9 | Frontend: la última ficha de la línea ganadora no caía (la animación de victoria pisaba la de caída); deshacer repetía la animación en fichas viejas. | Revisión del CSS y prueba manual en el navegador. | Regla CSS combinada; animar sólo cuando aumenta el número de fichas. |
| 10 | Frontend: en "Repetir partida" la IA inventó motivos de fin de partida que no existen en el protocolo. | Comparación contra `docs/arbitro-openapi.json`. | Se usaron los valores reales (`connect4`, `draw`, `illegal_move`, `timeout`, `absent`, `admin`). |
| 11 | Frontend: en una laptop de 768 px de alto el tablero empujaba la leyenda fuera de la pantalla. | Prueba visual. | Altura del tablero ajustada. |
| 12 | Indicador "Bot del torneo: desconectado" durante los primeros 20 s aunque sí estaba conectado (el primer long poll tarda hasta 20 s en responder). | Prueba visual de punta a punta contra el mock. | El primer `GET /api/next` usa `wait=0`. |
| 13 | **Lección:** el agente del backend reportó que **ninguna** prueba le falló a la primera, y lo señaló como debilidad: escribió las pruebas después del código y pueden compartir sus puntos ciegos. | Autocrítica del propio agente. | Lo compensamos con la prueba de punta a punta contra el mock y la práctica contra el árbitro real. |

## Qué verificamos siempre

1. `npm test` verde con cobertura antes de cada commit.
2. Pruebas diferenciales motor vs reglas en miles de partidas aleatorias.
3. Medición real de tiempo por jugada (`ms` en `/api/games/{id}`) en la práctica contra el árbitro.
4. Fuerza medida con partidas, no con opiniones: self-play A/B y arena contra el rival típico.

## Una decisión que la IA nos discutió (y cómo la resolvimos con datos)

En el encargo al agente del motor escribimos la regla clásica de Allis para 7×6: "el jugador 1
quiere amenazas en filas impares". El agente (modelo Fable) **la cuestionó**: en 8×7 las columnas
tienen 7 casillas (impar), así que con la estrategia de "seguir en la misma columna" es el
**jugador 2** quien se queda con las filas impares, y la regla se invierte. En vez de creerle a
nadie, lo medimos con partidas motor contra motor (ver `docs/TECNICO.md`, sección de evaluación).
