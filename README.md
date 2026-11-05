# Cuatro en Línea 8×7: bot de torneo y app web (Equipo 3)

Bot que juega Cuatro en línea en un tablero de **8 columnas × 7 filas** contra el árbitro del
challenge (HTTP con long polling), y una **app web** para que una persona juegue contra el mismo
bot. El torneo y la app usan **el mismo motor**: negamax con poda alfa-beta, bitboards,
iterative deepening y tabla de transposición.

| Documento | Para qué |
|---|---|
| [PLAN_BACKEND.md](PLAN_BACKEND.md) · [PLAN_FRONTEND.md](PLAN_FRONTEND.md) | Planes escritos antes del código |
| [docs/TECNICO.md](docs/TECNICO.md) | Arquitectura, algoritmo, decisiones, desviaciones, cobertura |
| [docs/MANUAL.md](docs/MANUAL.md) | Manual de la app para personas que no programan |
| [docs/IA_BITACORA.md](docs/IA_BITACORA.md) | Cómo usamos la IA: qué pedimos, qué falló, cómo lo verificamos |
| [docs/EXPOSICION.md](docs/EXPOSICION.md) | Guion de la exposición, preguntas del jurado y checklist del día |
| [AGENTS.md](AGENTS.md) | Reglas para los agentes de IA en este repo |

## Requisitos

- **Node.js 22.18 o superior** (probado con Node 24). Ejecuta TypeScript directamente: no hay
  paso de compilación para el bot.
- npm.

## Instalación

```bash
npm install
npm run build:web      # compila la app web (la sirve el mismo servidor del bot)
```

## Pruebas: un solo comando

```bash
npm test
```

Corre **todas** las pruebas (reglas, motor, cliente del árbitro con árbitro simulado, API, mock y
lógica de la app) y muestra la **cobertura** en consola. El reporte HTML queda en
`coverage/index.html`. La prueba falla si la cobertura baja de los umbrales configurados.

## Variables de entorno

Copia `.env.example` a `.env` (está en `.gitignore`; **el token nunca va al repositorio**).

| Variable | Obligatoria | Por defecto | Qué es |
|---|---|---|---|
| `ARBITRO_URL` | Para el torneo | — | URL del árbitro, p. ej. `https://arbitro.yompi…` |
| `TEAM_TOKEN` | Para el torneo | — | Token del equipo (encabezado `Authorization: Bearer`) |
| `BOT_THINK_MS` | No | `1500` | Presupuesto de pensamiento por jugada (máx. 2000) |
| `PORT` | No | `8787` | Puerto de la API y de la app web |
| `HOST` | No | `0.0.0.0` | Interfaz; `0.0.0.0` permite jugar desde el teléfono en la red local |

Sin `ARBITRO_URL`/`TEAM_TOKEN` el servidor arranca sólo la app web y su API.

## Correr el bot del torneo + la app

```bash
npm run torneo              # recomendado: supervisor que relanza el bot si se cae y, en macOS,
                            # mantiene la laptop despierta (caffeinate) mientras corre
npm start                   # el bot solo, sin supervisor (en macOS: caffeinate -i npm start)
```

- Se conecta al árbitro y juega cada turno que le toque (long polling).
- Abre la app en `http://localhost:8787` (la consola también muestra la URL de la red local para
  el teléfono).

Comandos útiles con el árbitro (leen `.env`):

```bash
npm run me                                   # verifica el token y muestra posición
npm run practice -- casa-basico 1            # práctica contra el bot de la casa, abrimos nosotros
npm run practice -- casa-basico 2            # práctica, abre la casa
npm run submit -- https://github.com/<org>/<repo> [commit]   # registra la entrega
npm run rename -- "Nombre del equipo"        # cambia el nombre visible (máx. 30)
```

## Desarrollo sin árbitro (mock)

```bash
npm run mock                                  # árbitro simulado en http://localhost:8790
ARBITRO_URL=http://localhost:8790 TEAM_TOKEN=token-equipo3 npm start
ARBITRO_URL=http://localhost:8790 TEAM_TOKEN=token-equipo3 npm run practice -- casa-basico 1
npm run dev:web                               # app con recarga en caliente en :5173
```

## App pública en Vercel (opcional)

La app también se puede publicar como sitio estático: el **mismo motor** corre en el navegador
(Web Worker), sin servidor. `vercel.json` ya está configurado (`npm run build:static` → `web/dist`).
En Vercel: *Add New → Project → Import* este repositorio y *Deploy* (no hace falta configurar nada).

> El **bot del torneo no corre en Vercel**: necesita un proceso permanente haciendo long polling,
> así que corre en la laptop del equipo con `npm start`.

## Medir la fuerza del motor

```bash
npm run bench                       # profundidad y nodos/segundo en posiciones de referencia
npm run selfplay                    # motor vs motor (A/B de configuraciones)
node tools/arena.ts 10 1500 1500    # nuestro motor vs un minimax "típico" (rival de referencia)
```

### Serie contra otro bot (cualquier lenguaje) usando el árbitro simulado

```bash
npm run mock                                                            # terminal 1
ARBITRO_URL=http://127.0.0.1:8790 TEAM_TOKEN=token-equipo3 npm start    # terminal 2: este bot
ARBITRO_URL=http://127.0.0.1:8790 TEAM_TOKEN=token-rival <su comando>   # terminal 3: el otro bot
node tools/match.ts 10                                                  # terminal 4: 10 partidas alternando quién abre
```

## Estructura

```
src/engine/   reglas (rules.ts) y motor (bitboard, evaluación, TT, búsqueda): TS puro, sin I/O
src/client/   cliente del árbitro y ciclo del bot
src/api/      servidor HTTP de la app + workers del motor
src/mock/     árbitro simulado
src/cli/      puntos de entrada
web/          app React + Vite
test/         pruebas
tools/        arena y rival de referencia (no forman parte del bot)
docs/         documentación
```

## Créditos y fuentes

- Pascal Pons, *Solving Connect 4: how to build a perfect AI* (blog.gamesolver.org): bitboards,
  orden de jugadas, jugadas que no pierden. Adaptado a 8×7.
- Victor Allis, *A Knowledge-based Approach of Connect-Four* (1988): regla de paridad de amenazas.
- Equipo 3: Mauricio Estuardo Batres Montejo, José Danilo Alvarado Zamora, Luis Fernando Rivas
  Colaj, Matias Javier Montini, Jessica Romero.
