# Plan de ejecución — Frontend (app web para jugar contra el bot)

> Equipo 3 · Escrito **antes de la primera línea de código**. Las desviaciones se documentan en
> `docs/TECNICO.md`.

## 1. Alcance

Una página donde una persona juega contra nuestro bot, en la misma computadora o en la red local
(y que funcione en el teléfono).

**Mínimo exigido:** tablero 8×7 interactivo; a quién le toca; columnas disponibles; elegir quién
abre (humano o bot); reiniciar; resultado con la línea de cuatro resaltada o empate.

**Extras planificados (en este orden de prioridad):**
1. Niveles de dificultad (Fácil, Medio, Difícil, Máximo).
2. Historial de jugadas y **deshacer**.
3. Panel "¿Qué piensa el bot?": profundidad alcanzada, nodos analizados, tiempo y evaluación
   (barra de ventaja). Sirve también para la exposición del algoritmo.
4. Reproducir una partida del torneo a partir de su `game_id` en el árbitro.
5. Modo responsive para teléfono.

## 2. Stack y por qué

- **React 19 + Vite + TypeScript**: arranque instantáneo, componentes pequeños, el equipo lo conoce.
- **CSS propio con variables** (sin framework): control total del aspecto, cero dependencias.
- **Reglas compartidas**: la app importa `src/engine/rules.ts` (las mismas reglas que usa el bot)
  para validar clics, detectar fin de partida y resaltar la línea ganadora **sin esperar al
  servidor**: retroalimentación inmediata.

## 3. Pantallas y componentes

Una sola pantalla con dos pestañas: **Jugar** y **Repetir partida**.

```
┌──────────────────────── Header: logo · "Cuatro en línea 8×7" · estado del servidor ───────┐
│ ┌──────────── Panel de control ────────────┐  ┌─────────────── Tablero ─────────────────┐ │
│ │ ¿Quién empieza?  (Yo | Bot)              │  │ indicadores de columna (▼ al pasar)     │ │
│ │ Dificultad (Fácil|Medio|Difícil|Máximo)  │  │ 8 × 7 celdas, ficha cae con animación   │ │
│ │ [Nueva partida]  [Deshacer]              │  │ columnas llenas atenuadas               │ │
│ │ Turno: ● Tú / ● Bot pensando…            │  └─────────────────────────────────────────┘ │
│ │ ¿Qué piensa el bot? prof · nodos · eval  │  Banner de resultado (ganaste / perdiste /   │
│ │ Historial de jugadas                     │  empate) + línea ganadora resaltada          │
│ └──────────────────────────────────────────┘                                              │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

| Componente | Responsabilidad |
|---|---|
| `App` | Pestañas, layout. |
| `useGame` (hook) | Estado de la partida: jugadas, turno, resultado, nivel, quién abre; llama al bot. Lógica pura separable y probada. |
| `Board` / `Cell` | Dibuja el tablero, *hover* de columna, animación de caída, resaltado de la línea ganadora, accesible con teclado (teclas 1–8). |
| `ControlPanel` | Quién empieza, dificultad, nueva partida, deshacer. |
| `StatusBar` | A quién le toca, "el bot está pensando…", errores de conexión. |
| `BotInsight` | Profundidad, nodos, tiempo, barra de evaluación. |
| `MoveHistory` | Lista de jugadas (#, jugador, columna). |
| `ResultBanner` | Ganaste / Ganó el bot / Empate, botón "jugar otra". |
| `ReplayView` | Pide `GET /api/replay/:gameId`, permite avanzar/retroceder jugada a jugada. |
| `api.ts` | Cliente HTTP de la API del bot (`/api/bot/move`, `/api/health`, `/api/replay`). |

## 4. Comunicación con el bot

- `POST /api/bot/move { moves, level }` → `{ column, score, depth, nodes, timeMs, pv }`.
  La app es dueña del estado; el servidor no guarda partidas (reiniciar o deshacer es trivial).
- En desarrollo Vite redirige `/api` al servidor del bot (puerto 8787). En producción el mismo
  servidor del bot sirve la app ya compilada: **un solo comando (`npm start`) levanta todo**.
- Si una respuesta llega después de reiniciar/deshacer, se descarta (identificador de petición).

## 5. Estados claros (requisito de la rúbrica)

| Estado | Qué ve la persona |
|---|---|
| Tu turno | Indicador con tu color, columnas disponibles resaltadas al pasar el mouse |
| Bot pensando | Indicador animado, tablero bloqueado |
| Jugada ilegal (columna llena) | La columna "tiembla" y aparece un aviso breve; no se envía nada |
| Fin: ganaste / perdiste | Banner + 4 fichas ganadoras resaltadas, resto atenuado |
| Empate | Banner de empate |
| Servidor caído | Aviso con instrucción para encenderlo y botón de reintentar |

## 6. Pasos en orden (con criterio de listo)

| # | Paso | Listo cuando… |
|---|---|---|
| 1 | Plan (este documento) | En el primer commit |
| 2 | Vite + React con el tablero estático | Se ven 8×7 celdas en laptop y teléfono |
| 3 | Juego humano vs humano local con `rules.ts` | Caída, turnos, victoria con línea resaltada, empate |
| 4 | Conectar al bot (`/api/bot/move`) | El bot responde; quién abre; niveles |
| 5 | Estados: pensando, ilegal, error de servidor | Cada estado de la tabla anterior es visible |
| 6 | Historial, deshacer, panel del bot | Funcionan sin errores en consola |
| 7 | Repetir partida del torneo | Se carga un `game_id` del mock y se navega |
| 8 | Pulido visual + responsive | Revisión en 1366×768 y 390×844 |
| 9 | Capturas para `docs/MANUAL.md` | Manual escrito para alguien que no programa |

## 7. Riesgos y mitigación

| Riesgo | Mitigación |
|---|---|
| Lógica de reglas duplicada y divergente entre app y bot | Se importa el mismo `rules.ts` |
| Respuestas tardías del bot tras reiniciar | Descartar respuestas viejas por identificador |
| Errores en consola | Revisión con la consola abierta en cada paso; manejo de errores de red |
| CORS al consultar el árbitro | Proxy `/api/replay` en nuestro servidor |
| Poco tiempo | Primero el mínimo exigido (pasos 2–5), luego extras |

## 8. Validación

- Pruebas unitarias de la lógica del juego de la app (hook/reductor puro) con Vitest.
- Prueba manual guiada por la tabla de estados (sección 5) antes de cada commit.
- Revisión en navegador de escritorio y en vista de teléfono.

## 9. Qué se delega a la IA y cómo se verifica

| Delegado | Verificación |
|---|---|
| Componentes React y CSS | Revisión visual en navegador, sin errores en consola |
| Animación de caída y resaltado | Prueba manual de las 4 direcciones de victoria |
| Reductor del estado de partida | Pruebas unitarias (jugar, deshacer, reiniciar, fin de partida) |
| Textos del manual | Lectura por alguien que no programa |
