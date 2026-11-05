import { afterAll, describe, expect, it } from 'vitest';
import { ArbiterClient } from '../../src/client/arbiterClient.ts';
import { BotLoop } from '../../src/client/botLoop.ts';
import { EngineWorker } from '../../src/api/enginePool.ts';
import { startMockArbiter } from '../../src/mock/mockArbiter.ts';

// End-to-end: real Engine inside a worker thread, bot loop over HTTP, mock arbiter.
describe('real engine in a worker vs the mock arbiter', () => {
  const engine = new EngineWorker({ name: 'test', hangGraceMs: 400 });
  afterAll(() => engine.close());

  for (const [opponent, first] of [['casa-basico', 1], ['casa-basico', 2], ['casa-aleatorio', 2]] as const) {
    it(`beats ${opponent} playing as ${first}`, async () => {
      const mock = await startMockArbiter({ tokens: { tok: 'Equipo 3' } });
      const client = new ArbiterClient({ baseUrl: mock.url, token: 'tok' });
      const loop = new BotLoop({
        client,
        waitSec: 1,
        thinkMs: 60,
        log: () => {},
        decide: ({ grid, toMove, budgetMs }) => engine.search(grid, toMove, { timeMs: budgetMs }),
        onNewGame: () => engine.newGame(),
      });
      void loop.start();
      try {
        const { game_id } = await client.practice(opponent, first);
        const game = mock.games.get(game_id)!;
        const t0 = Date.now();
        while (game.status !== 'finished' && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 20));
        expect(game.result).toMatchObject({ winner: first, reason: 'connect4' });
        expect(loop.status().fallbacks).toBe(0);
        expect(Math.max(...game.moves.filter((m) => m.by === first).map((m) => m.ms ?? 0))).toBeLessThan(1000);
      } finally {
        await loop.stop();
        await mock.close();
      }
    });
  }
});
