/**
 * `npm start`: API + web app on PORT (default 8787) and, when ARBITRO_URL and TEAM_TOKEN are
 * set, the tournament bot with its own engine worker.
 */
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ArbiterClient } from '../client/arbiterClient.ts';
import { BotLoop } from '../client/botLoop.ts';
import { EngineWorker } from '../api/enginePool.ts';
import { createServer } from '../api/server.ts';
import { loadDotEnv } from './env.ts';

loadDotEnv();

const log = (line: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${line}`);
process.on('uncaughtException', (err) => log(`[proceso] uncaughtException: ${err?.stack ?? err}`));
process.on('unhandledRejection', (err) => log(`[proceso] unhandledRejection: ${(err as Error)?.stack ?? err}`));

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
const rawThink = Number(process.env.BOT_THINK_MS ?? 1500);
// Capped at 1700: above that the worker hang-kill (budget + 400 ms) would fire after the
// bot's 2200 ms fallback and the next turn would start on a cold worker.
const thinkMs = Math.max(100, Math.min(1700, Number.isFinite(rawThink) ? rawThink : 1500));
const arbiterUrl = process.env.ARBITRO_URL;
const token = process.env.TEAM_TOKEN;

const webEngine = new EngineWorker({ name: 'web', log });
let bot: BotLoop | null = null;
let tournamentEngine: EngineWorker | null = null;
const arbiter = arbiterUrl && token ? new ArbiterClient({ baseUrl: arbiterUrl, token }) : null;

if (arbiter) {
  // Hang guard below the bot's hard deadline (2200 ms): a stuck search is killed at budget + 400.
  tournamentEngine = new EngineWorker({ name: 'torneo', log, hangGraceMs: 400 });
  const engine = tournamentEngine;
  bot = new BotLoop({
    client: arbiter,
    thinkMs,
    log,
    decide: ({ grid, toMove, budgetMs }) => engine.search(grid, toMove, { timeMs: budgetMs }),
    onNewGame: () => engine.newGame(),
  });
  log(`[bot] árbitro ${arbiter.baseUrl}, BOT_THINK_MS=${thinkMs}`);
  arbiter
    .me()
    .then((me) => log(`[bot] /api/me OK: ${me.team?.name} (${me.team?.id}) fase=${me.phase} pendientes=${me.pending_turns?.length ?? 0}`))
    .catch((err) => log(`[bot] !!! /api/me falló: ${err.message} — revisa ARBITRO_URL / TEAM_TOKEN`));
  void bot.start();
} else {
  log('[bot] ARBITRO_URL/TEAM_TOKEN no definidos: sólo API + app web (bot del torneo apagado)');
}

const server = createServer({
  webEngine,
  botStatus: bot ? () => ({ ...bot!.status(), thinkMs, engineRestarts: tournamentEngine?.restarts ?? 0 }) : undefined,
  arbiter,
  staticDir: fileURLToPath(new URL('../../web/dist', import.meta.url)),
  log,
});
server.listen(port, host, () => {
  log(`[api] http://localhost:${port}`);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) log(`[api] LAN: http://${a.address}:${port}`);
  }
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) process.exit(1);
  stopping = true;
  log('[proceso] cerrando…');
  const force = setTimeout(() => process.exit(0), 3000);
  force.unref();
  await bot?.stop().catch(() => {});
  server.close();
  await Promise.allSettled([webEngine.close(), tournamentEngine?.close()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
