# Documentación técnica

Objetivo: que una persona desarrolladora nueva entienda la arquitectura en 10 minutos y pueda
explicar por qué el bot juega lo que juega.

## 1. Arquitectura final

```
                ┌────────────────────────── proceso `npm start` (src/cli/start.ts) ─────────────────────────┐
                │                                                                                           │
 Árbitro ◄─────►│ client/arbiterClient.ts ◄── client/botLoop.ts ──► api/enginePool.ts ──► Worker "torneo" ─┐ │
 (HTTPS, long   │   (HTTP tipado, timeouts)     (ciclo, validación,                       (engineWorker.ts) │ │
  polling)      │                                fallback, reintentos)                                      │ │
                │                                                                          src/engine (puro) │
 Navegador ────►│ api/server.ts (HTTP :8787) ──────────────────────► api/enginePool.ts ──► Worker "web" ────┘ │
 (app React)    │   /api/bot/move · /api/health · /api/bot/status · /api/replay/:id · web/dist (estático)     │
                └───────────────────────────────────────────────────────────────────────────────────────────┘
```

| Capa | Archivos | Responsabilidad | Depende de |
|---|---|---|---|
| Reglas | `src/engine/rules.ts` | Reglas legibles sobre la matriz del protocolo (`board[fila][col]`, fila 0 abajo). Oráculo de pruebas; la usan la app y el cliente. | nada |
| Motor | `src/engine/{bitboard,evaluate,tt,search,index}.ts` | Búsqueda rápida. TypeScript puro, sin I/O: se prueba sin levantar servidores. | reglas |
| Cliente | `src/client/{arbiterClient,botLoop}.ts` | Protocolo del árbitro y ciclo del bot. `fetch` y decisor inyectables. | reglas (validación) |
| API | `src/api/{server,enginePool,engineWorker}.ts` | HTTP para la app y aislamiento del motor en *worker threads*. | motor, reglas |
| Mock | `src/mock/mockArbiter.ts` | Árbitro simulado fiel al OpenAPI (incluye bots de la casa, reloj de 3 s, ausencia de 30 s). | reglas |
| App | `web/src/**` | React + Vite. La lógica de partida es un reductor puro (`web/src/logic/game.ts`) probado. | reglas, API |
| CLI | `src/cli/*.ts` | Puntos de entrada: `start`, `mock`, `practice`, `me`, `submit`, `bench`, `selfplay`. | todo |

**Por qué dos workers:** la búsqueda bloquea el hilo de JavaScript ~1.5 s. Si el torneo y la app
compartieran hilo, una partida en la app podría retrasar una jugada del torneo y hacernos perder por
tiempo. Con un worker dedicado por uso, eso es imposible. Si un worker se cuelga, el pool lo mata
pasado `presupuesto + 400 ms` y lo recrea; el ciclo del bot ya habrá enviado una jugada de respaldo.

## 2. El protocolo y la robustez del cliente

Ciclo (`botLoop.ts`): `GET /api/next?wait=20` → si es turno: decidir → validar → `POST /api/move` →
repetir de inmediato. Reglas de seguridad, cada una con su prueba:

| Riesgo | Defensa |
|---|---|
| Motor lento o colgado | `Promise.race` contra un límite duro de **2200 ms** desde que recibimos el turno (y nunca más de `deadline_ms − 700`). Si se pasa: jugada de respaldo instantánea (ganar ya → bloquear → columna más central legal). |
| Jugada ilegal | La columna debe estar en `legal_moves` del árbitro **y** ser legal en `rules.ts` sobre el `board` recibido. Si no, respaldo. |
| Tablero inconsistente | Se valida forma y "gravedad" del `board`; si es inválido se reconstruye desde `moves`. |
| Red caída | Reintentos con *backoff* 250 ms → 2 s; el ciclo nunca termina. El `POST` se reintenta mientras quede tiempo; un `409` posterior es inofensivo. |
| Turno re-servido (respuesta perdida) | Se reenvía la misma columna sin volver a pensar, midiendo el tiempo desde la primera vez que se vio el turno. |
| Token inválido | Log muy visible y reintento cada 5 s. |
| Laptop dormida | `npm run torneo` corre el bot bajo `caffeinate` (macOS). |
| El proceso del bot se cae | `npm run torneo` (`scripts/run-bot.sh`) lo relanza 1 s después; el árbitro recién nos da por ausentes a los 30 s. Idea tomada del bot `free-fall` de nuestro equipo. |
| Excepciones no previstas | `uncaughtException`/`unhandledRejection` se registran y el proceso sigue. |

La primera consulta usa `wait=0` para saber al instante si estamos conectados.

## 3. El algoritmo

### 3.1 Representación: bitboard de 64 bits en dos enteros de 32

Cada columna ocupa 8 bits (7 filas + 1 bit centinela siempre vacío): `bit = col·8 + fila`. Son 64
bits, pero JavaScript sólo hace operaciones de bits en 32, y `BigInt` es ~50× más lento. Por eso el
tablero se guarda en dos enteros: `lo` (columnas 0–3) y `hi` (columnas 4–7). Un *shift* de 64 bits
son dos *shifts* de 32 más el "acarreo" entre palabras.

Una posición es `(pos, mask)`: `pos` = fichas del jugador al que le toca, `mask` = todas las fichas
(Pons). Jugar en una columna es `mask | (mask + abajo_de_columna)`: la suma "cae" sola hasta la
primera casilla libre. Detectar cuatro en línea en una dirección con desplazamiento `s` es:
`m = p & (p >> s); hay4 = m & (m >> 2s)`, con `s` = 1 (vertical), 8 (horizontal), 9 (diagonal ↗)
y 7 (diagonal ↘). El centinela evita que una línea "dé la vuelta" de una columna a otra.

**Verificación:** 800 partidas aleatorias (~30 000 posiciones) en las que, jugada por jugada, el
bitboard y `rules.ts` coinciden en jugadas legales, victoria, columnas ganadoras y casillas ganadoras.
Incluye victorias que cruzan la frontera entre `lo` y `hi` (columnas 3 y 4), el caso más propenso a
errores.

### 3.2 Búsqueda: negamax + alfa-beta + PVS + iterative deepening

- **Negamax**: una sola función para ambos jugadores; el puntaje siempre es desde el punto de vista
  de quien mueve, y al bajar un nivel se niega.
- **Poda alfa-beta**: si una jugada ya demuestra que el rival tiene algo mejor en otra rama, se deja
  de explorar. Con buen orden de jugadas, revisa del orden de la raíz cuadrada de los nodos de un
  minimax.
- **PVS (Principal Variation Search)**: la primera jugada se busca con ventana completa; las demás con
  ventana nula (sólo "¿es mejor o no?"), y únicamente si lo son se re-buscan. Más podas.
- **Iterative deepening**: busca a profundidad 1, 2, 3…, cada vez reutilizando lo aprendido (la TT y
  la mejor jugada previa se exploran primero). Siempre hay una respuesta lista cuando se acaba el
  tiempo.
- **Puntaje de victoria**: `WIN_SCORE − ply` (10000 − profundidad). El bot prefiere ganar lo antes
  posible y, si pierde, perder lo más tarde posible (más oportunidades de que el rival se equivoque).

### 3.3 Conocimiento táctico en cada nodo (Pons)

Antes de buscar en un nodo, con puras operaciones de bits:

1. **¿Puedo ganar ya?** → victoria inmediata.
2. **¿El rival puede ganar ya?** Si en dos casillas distintas → posición perdida. Si en una → la
   única jugada considerada es bloquear.
3. **Jugadas que no pierden**: nunca jugar justo debajo de una casilla donde el rival completa
   cuatro (le estaríamos dando la casilla).

Esto reduce mucho el árbol y hace que las combinaciones de "ganar en 3" se encuentren casi en
profundidad 1.

### 3.4 Orden de jugadas

1. Jugada de la tabla de transposición (la mejor de la vez anterior).
2. Jugadas que **crean más amenazas** nuevas (casillas ganadoras propias).
3. *Killer moves* (jugadas que causaron poda en el mismo nivel) e *history heuristic*.
4. Centro primero: `3, 4, 2, 5, 1, 6, 0, 7`.

### 3.5 Tabla de transposición (TT)

Muchas secuencias distintas llegan al mismo tablero. La TT recuerda, por posición, el puntaje, la
profundidad, el tipo de cota (exacta / inferior / superior) y la mejor jugada. Está hecha con
`TypedArray` (2²² entradas, ~4 millones) para no crear objetos y no disparar el recolector de basura
en medio de una jugada. La clave es de 64 bits (dos palabras) y se conserva **entre jugadas de la
misma partida**; se limpia al empezar una partida nueva.

### 3.6 Heurística (evaluación de hojas)

Cuando la búsqueda llega a su profundidad máxima sin final, se estima la posición
(`evaluate.ts`, todo con operaciones de bits):

| Término | Idea |
|---|---|
| Amenazas | Casillas vacías que completarían un cuatro. Valen mucho más si su fila tiene la **paridad favorable** para su dueño (ver abajo). |
| Amenazas apiladas | Dos amenazas propias una encima de la otra en la misma columna: casi decisivo. |
| Ventanas de 2 | Ventanas de 4 casillas con dos fichas propias y ninguna rival: potencial. |
| Centro | Las columnas centrales participan en más líneas posibles. |

**Paridad (zugzwang).** Al final de una partida, cuando nadie quiere jugar debajo de una amenaza, el
orden de llenado obliga a uno de los dos a ceder. En el 7×6 clásico (Allis) el jugador 1 quiere
amenazas en filas impares. En 8×7 hay **56 casillas (par)** y **columnas de 7 (impar)**: si el
jugador 2 responde siempre en la misma columna que el 1, se queda con las filas impares; por eso el
motor, por defecto (`parityMode: 'p1even'`), favorece **filas pares para el jugador 1 e impares para
el 2** (en numeración desde 1). Esta inversión la propuso el agente de IA del motor contradiciendo
nuestro encargo; la medimos en vez de asumirla (sección 5).

### 3.7 Manejo del tiempo

| Paso | Valor |
|---|---|
| Reloj del árbitro | 3000 ms desde `served_at` |
| Presupuesto de pensamiento (`BOT_THINK_MS`) | 1500 ms (configurable, máx. 2000) |
| Revisión del reloj dentro de la búsqueda | cada 1024 nodos (`performance.now()`) |
| No iniciar una iteración nueva si ya se usó | 45 % del presupuesto (la siguiente costaría ~2–3× la anterior) |
| Si se acaba en medio de una iteración | se usa la mejor jugada de la última iteración completa, o la de la iteración parcial si ya terminó de evaluar al menos una jugada raíz |
| Límite duro en el ciclo del bot | 2200 ms desde que recibimos el turno → jugada de respaldo |

Medido: en una partida completa a 1500 ms con la CPU ocupada, la peor jugada tardó 1500.2 ms.
Margen para la red: ~800 ms o más.

## 4. Rendimiento

`npm run bench` (Apple Silicon, 1500 ms por posición, sin carga):

| Posición | Profundidad | Nodos/s |
|---|---|---|
| Tablero vacío | 15 | ~5.8 M |
| Apertura de 3 jugadas | 16 | ~6 M |
| Medio juego (12 fichas) | 18 | ~6 M |
| Final (32 fichas) | **resuelto** (juego perfecto) en 82 ms | — |

A partir de ~30 fichas el bot normalmente llega al final del árbol: juega perfecto.

## 5. Medición de fuerza

| Experimento | Resultado |
|---|---|
| Arena contra un "minimax típico" (ventanas de 4, alfa-beta, iterative deepening; lo que suele generar una IA), ambos con 1500 ms, alternando quién abre | **8 victorias, 0 empates, 0 derrotas** (4 abriendo, 4 de segundo). Nuestra jugada más lenta: 1501 ms |
| Self-play: evaluación completa vs sin paridad | **57.7 %** para la versión con paridad (104 partidas: 20 a 150 ms y 84 a 200 ms) |
| Self-play: amenazas apiladas sí/no | 45 % (20 partidas): ruido, se dejó el valor por defecto |
| Self-play: paridad 8×7 (`p1even`) vs paridad clásica 7×6 (`p1odd`) | **51.1 %** en 180 partidas (87G 10E 83P, a 100–250 ms): **sin diferencia medible**. Se mantiene `p1even` por su justificación teórica. Interpretación: a profundidad 15–18 la búsqueda resuelve sola los finales donde la paridad decide, así que el término importa menos que el propio hecho de valorar amenazas. |
| Contra `casa-basico` en el mock (como jugador 1 y 2) | Gana siempre |

## 6. Decisiones y desviaciones respecto a los planes

| Plan decía | Qué hicimos | Por qué |
|---|---|---|
| Revisar el reloj cada 2048 nodos | Cada 1024 | Más margen con un costo despreciable. |
| Heurística con ventanas de 3 y 2 | Ventanas de 3 sustituidas por "amenazas" (casillas ganadoras) con paridad + amenazas apiladas | Una ventana de 3 abierta *es* una amenaza; contarla dos veces sesgaba la evaluación. Las amenazas se calculan con el mismo código que el bitboard ya probado. |
| Regla de paridad clásica (jugador 1 → filas impares) | Invertida para 8×7 | Análisis del agente del motor + medición A/B (sección 5). |
| Libro de aperturas "si sobra tiempo" | No se hizo | No pudimos demostrar una ganancia en el tiempo disponible; la búsqueda ya llega a profundidad 15 desde el tablero vacío. |
| `/api/health` con estado del bot | Hecho, más `/api/bot/status` con estadísticas del torneo | La app lo muestra en el encabezado. |
| Límite duro implícito | Explícito: 2200 ms + worker reiniciable | Defensa en profundidad contra timeouts. |
| Primer long poll con `wait=20` | `wait=0` en la primera consulta | El indicador de conexión tardaba 20 s en ponerse verde (encontrado en la prueba de punta a punta). |
| `WIN_SCORE` | 10000 compartido con la app mediante una prueba de contrato | Los agentes del motor y del frontend asumieron valores distintos (bitácora #2). |
| La app sólo funciona con el servidor del bot | Además, **modo estático** para Vercel: el mismo `src/engine` corre en un Web Worker del navegador (`web/src/engine.worker.ts`) y las repeticiones se leen directo del árbitro (permite CORS) | Poder compartir la app con un enlace público sin depender de la laptop. Los niveles viven en `src/engine/levels.ts` para que servidor y navegador jueguen idéntico. El bot del torneo **sigue** corriendo en la laptop: Vercel es *serverless* y no puede mantener un long polling permanente. |
| OpenAPI preliminar 1.0.1 | Oficial 1.1.0 | Sólo agrega `PATCH /api/me` (renombrar equipo): `npm run rename`. El protocolo de juego no cambió. |
| `POST /api/move` con el timeout general (8 s) | Timeout de 1 s y reintento también en 5xx/429 | Hallazgo de la revisión adversarial: un POST trabado no dejaba tiempo para reintentar dentro de los 3 s. |
| `BOT_THINK_MS` hasta 2000 | Tope en 1700 | Arriba de eso el *watchdog* del worker (presupuesto + 400 ms) dispararía después del respaldo de 2200 ms. |

## 7. Pruebas y cobertura

`npm test` = `vitest run --coverage`. **159 pruebas** en 14 archivos, todas verdes. Umbrales
configurados (líneas/sentencias/funciones 80 %, ramas 70 %): si la cobertura baja, falla.

| Módulo | Líneas | Ramas |
|---|---|---|
| `src/engine` (reglas + motor) | 99.6 % | 96.7 % |
| `src/client` | 96.7 % | 91.6 % |
| `src/api` | 98.0 % | 87.1 % |
| `src/mock` | 95.7 % | 83.0 % |
| `web/src/logic` | 94.4 % | 92.0 % |
| **Total** | **97.7 %** | **90.7 %** |

Qué cubren: caída de fichas, legales, cuatro direcciones y empate (reglas); diferencial bitboard vs
reglas; ganar en 1, bloquear, doble amenaza, "todas pierden", una sola columna, tablero a 1–2
casillas de llenarse, 60 partidas aleatorias con presupuestos de 5–30 ms sin una sola jugada ilegal,
presupuesto de 200 ms respetado (<260 ms), reloj falso para forzar abortos (motor); parseo de
turno/idle/errores, cuerpo y encabezados del `POST`, respaldo ante excepción y ante timeout del
motor, recuperación de red, `409` ignorado, partidas completas contra el mock por HTTP real
(cliente); niveles, validación de jugadas y estáticos (API); long polling, timeout, jugada ilegal,
ausencia y bots de la casa (mock); reductor de la partida y deshacer (app).

## 8. Revisión adversarial independiente

Antes de la liga, un agente de IA independiente (modelo Fable, sin ver nuestras conclusiones) buscó
defectos que pudieran costar partidas, con experimentos propios:

| Experimento | Resultado |
|---|---|
| Worker en frío, en caliente y tras reinicio forzado | 923 / 716 ms: muy por debajo del límite de 1900 ms |
| Exceso sobre el presupuesto (40 posiciones, 300 ms) | máx. 0.4 ms |
| Calidad al abortar (120 posiciones a 2/5/10 ms vs referencia de 300 ms) | 0 errores graves causados por el corte |
| Oráculo exacto en 50 finales (≤ 11 casillas) sin limpiar la TT | 0 jugadas erróneas, TT consistente |
| Bot + worker real vs mock, dos partidas intercaladas | 0 respaldos, 0 rechazos, máx. 1086 ms |

**Defectos confirmados: ninguno.** Tres endurecimientos plausibles se aplicaron (sección 6).

## 9. Fuentes

- Pascal Pons, *Solving Connect 4: how to build a perfect AI*, http://blog.gamesolver.org — bitboard,
  `(pos, mask)`, jugadas que no pierden, orden por amenazas. Adaptado a 8×7 y a dos palabras de 32 bits.
- Victor Allis, *A Knowledge-based Approach of Connect-Four* (1988) — amenazas y zugzwang (paridad).
- John Tromp, resultados de Connect-4 en tableros de distintos tamaños — contexto: 8×7 no tiene un
  solver conocido aplicable en 2 s.

## 10. Incidente real durante la medición

Al correr 120 partidas de self-play, las seis ejecuciones reportaron una "jugada más lenta" de
~410 s. No era el motor: `pmset -g log` mostró que **la laptop se durmió** de 07:00:01 a 07:05:30
(en batería). En el torneo eso sería una derrota por ausencia en cada partida en curso. Mitigación
adoptada: correr el bot con `caffeinate -i`, laptop conectada al cargador, y una alerta en la
checklist del día (`docs/EXPOSICION.md`). Las mediciones posteriores se hicieron con `caffeinate` y
la jugada más lenta fue de 202 ms con presupuesto de 200 ms.
