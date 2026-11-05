# Guía de exposición (10 minutos) y preguntas del jurado

Cualquier integrante puede ser interrogado: **todos** deben poder explicar las secciones 2 a 4.

## Guion sugerido

| Min | Quién | Qué |
|---|---|---|
| 0:00–2:00 | Demo | Abrir `http://localhost:8787`. Jugar en **Máximo** dejando que abra el bot. Mostrar el panel "¿Qué piensa el bot?" (profundidad 15–18, millones de nodos, barra de ventaja). Hacer clic en una columna llena (aviso y temblor). Mostrar **Deshacer**, la línea ganadora resaltada y **Repetir partida** con una partida real del torneo. |
| 2:00–5:00 | Algoritmo | Diapositiva/tablero: bitboard 2×32 → negamax + alfa-beta + PVS → iterative deepening → TT → jugadas que no pierden → heurística de amenazas → manejo del tiempo (1500 ms, corte a 45 %, límite duro 2200 ms y respaldo). Usar **una partida real** de la liga: "aquí el bot vio victoria forzada en N jugadas" (mensaje del panel / logs). |
| 5:00–8:00 | IA | Cómo trabajamos: plan primero → contrato (`rules.ts` + interfaz del motor) → **3 agentes en paralelo** (motor con Fable, backend y frontend con Opus), cada uno en sus archivos, sin commits propios. Mostrar `docs/IA_BITACORA.md`: qué falló y cómo lo detectamos (pruebas diferenciales, prueba de contrato `WIN_SCORE`, el tablero de "empate" con diagonal, la laptop que se durmió en la medición). La discusión de la **paridad**: la IA contradijo nuestro encargo y lo resolvimos con 180 partidas, no con fe. |
| 8:00–10:00 | Preguntas | — |

## Las ideas en una frase (para que cualquiera responda)

- **Bitboard:** el tablero son dos números de 32 bits; jugar es una suma y detectar cuatro en línea
  son 8 operaciones de bits. Por eso analizamos ~6 millones de posiciones por segundo en JavaScript.
- **Negamax + alfa-beta:** imaginamos jugadas propias y del rival alternadamente, suponiendo que el
  rival juega lo mejor para él; alfa-beta descarta ramas que ya sabemos que no cambiarán la decisión.
- **Iterative deepening:** buscamos a 1, 2, 3… jugadas; cuando se acaba el tiempo usamos la última
  búsqueda completa. Por eso nunca nos quedamos sin respuesta.
- **Tabla de transposición:** memoria de posiciones ya analizadas (a la misma posición se llega por
  caminos distintos).
- **Jugadas que no pierden:** si el rival amenaza ganar, sólo bloqueamos; nunca jugamos debajo de
  una casilla donde el rival gana.
- **Heurística:** cuenta amenazas (casillas que completarían cuatro), con peso según la paridad de
  su fila, amenazas apiladas, ventanas de dos y centro.
- **Tiempo:** 3000 ms del árbitro; pensamos 1500; el corte duro a 2200 ms manda una jugada de
  respaldo legal. El torneo y la app usan workers separados, así una partida web no puede retrasar
  el torneo.
- **Final de partida:** desde ~30 fichas la búsqueda llega al final del árbol: juego perfecto.

## Preguntas probables y respuestas

| Pregunta | Respuesta corta |
|---|---|
| ¿Por qué no MCTS? | Cuatro en línea es táctico (amenazas forzadas); alfa-beta con buen orden ve más profundo en 2 s y es explicable: podemos decir exactamente por qué jugó algo. |
| ¿Por qué no un solver perfecto? | El 8×7 no está resuelto para 2 s por jugada; pero en el final nuestro motor sí resuelve exacto. |
| ¿Cómo saben que el bitboard no tiene bugs? | Prueba diferencial: 800 partidas aleatorias (~30 000 posiciones) comparadas jugada a jugada contra `rules.ts`, que es código legible. |
| ¿Qué pasa si el motor se cuelga? | `Promise.race` con 2200 ms → jugada de respaldo (ganar/bloquear/centro). El worker se mata y se recrea. |
| ¿Y si se cae internet? | Reintentos con backoff; el árbitro sólo nos da por ausentes a los 30 s. |
| ¿Cuánto pesa cada término de la heurística y cómo lo eligieron? | Pesos iniciales razonados (amenaza con paridad 60, sin paridad 18, apiladas 160, ventana de 2: 4, centro: 3) y validados con self-play A/B (`npm run selfplay`). |
| ¿La paridad funciona? | La IA propuso invertir la regla de Allis para 8×7 (columnas de 7). Medimos 180 partidas: 51 % — sin diferencia medible a estas profundidades; dejamos la versión con justificación teórica. Ver `docs/TECNICO.md` §5. |
| ¿Qué le pidieron a la IA y qué hizo mal? | `docs/IA_BITACORA.md`: 13 casos concretos con cómo se detectó cada uno. |
| ¿Qué cambió respecto al plan? | `docs/TECNICO.md` §6. |
| ¿Cómo se corren las pruebas? | `npm test` (157 pruebas, 97.7 % de líneas). |

## Checklist del día (8:00 – 9:45)

1. **Laptop conectada al cargador** y con `caffeinate -i` (¡en la medición previa la laptop se
   durmió 5 minutos en batería!). Desactivar el bloqueo automático.
2. Crear `.env` con `ARBITRO_URL` y `TEAM_TOKEN` (nunca en el repo).
3. Reemplazar `docs/arbitro-openapi.json` por `GET {ARBITRO_URL}/api/openapi.json` y revisar
   diferencias (`git diff`). Ajustar `arbiterClient.ts` si algo cambió; `npm test`.
4. `npm run me` → debe mostrar nuestro equipo.
5. `npm run build:web && caffeinate -i npm start`.
6. `npm run practice -- casa-basico 1` y `npm run practice -- casa-basico 2`: ganar ambas.
7. Revisar tiempos reales: `curl {ARBITRO_URL}/api/games/<game_id>` → campo `ms` de cada jugada
   nuestra. Si el máximo es < 1800 ms se puede subir `BOT_THINK_MS` a 1700; si supera 2200, bajarlo.
8. Pedir amistosos a otros equipos si hay tiempo.
9. Crear el repositorio público, `git push`, y antes de 9:45:
   `npm run submit -- https://github.com/<org>/<repo>` (usa el último commit).
10. **No apagar el bot** hasta el final de la sesión (liga + playoffs).
