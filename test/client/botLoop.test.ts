import { afterEach, describe, expect, it } from 'vitest';
import { ArbiterClient, ArbiterError, NetworkError, UnauthorizedError, type NextResult, type Turn } from '../../src/client/arbiterClient.ts';
import {
  BotLoop,
  CENTER_ORDER,
  fallbackMove,
  resolveGrid,
  safeLegalMoves,
  type Decider,
  type LoopClient,
} from '../../src/client/botLoop.ts';
import { emptyGrid, gridFromMoves, legalMoves } from '../../src/engine/rules.ts';
import { startMockArbiter, type MockArbiter, type MockGame } from '../../src/mock/mockArbiter.ts';

let mock: MockArbiter | null = null;
let loop: BotLoop | null = null;
afterEach(async () => {
  await loop?.stop();
  await mock?.close();
  loop = null;
  mock = null;
});

const quiet = () => {};
const centerDecider: Decider = async ({ grid, turn }) => ({
  column: CENTER_ORDER.find((c) => legalMoves(grid).includes(c) && turn.legal_moves.includes(c))!,
  depth: 1,
  score: 0,
});

async function waitFor(cond: () => boolean, timeoutMs = 15_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

function makeTurn(over: Partial<Turn> = {}): Turn {
  return {
    status: 'turn',
    game_id: 'g_1',
    match_id: null,
    kind: 'practice',
    you: 1,
    opponent: 'casa-basico',
    turn: 1,
    board: emptyGrid(),
    moves: [],
    last_move: null,
    legal_moves: [0, 1, 2, 3, 4, 5, 6, 7],
    deadline_ms: 3000,
    served_at: new Date().toISOString(),
    ...over,
  };
}

/** Scripted client: returns queued `next` results, records moves. */
function scriptedClient(results: Array<NextResult | Error>, moveImpl?: (g: string, c: number) => Promise<unknown>) {
  const moves: Array<{ gameId: string; column: number }> = [];
  const client: LoopClient = {
    async next() {
      const r = results.shift();
      if (!r) {
        await new Promise((res) => setTimeout(res, 10));
        return { status: 'idle' };
      }
      if (r instanceof Error) throw r;
      return r;
    },
    async move(gameId, column) {
      moves.push({ gameId, column });
      if (moveImpl) return (await moveImpl(gameId, column)) as never;
      return { ok: true, state: 'playing' };
    },
  };
  return { client, moves };
}

async function playPractice(opponent: 'casa-basico' | 'casa-aleatorio', first: 1 | 2, decide: Decider): Promise<MockGame> {
  mock = await startMockArbiter({ tokens: { tok: 'Equipo 3' } });
  const client = new ArbiterClient({ baseUrl: mock.url, token: 'tok' });
  const newGames: string[] = [];
  loop = new BotLoop({ client, decide, waitSec: 1, log: quiet, onNewGame: (id) => void newGames.push(id) });
  loop.start();
  const { game_id } = await client.practice(opponent, first);
  const game = mock.games.get(game_id)!;
  await waitFor(() => game.status === 'finished');
  expect(newGames).toEqual([game_id]);
  return game;
}

describe('BotLoop against the mock arbiter over HTTP', () => {
  it('plays a complete practice game vs casa-basico as player 1 without forfeits', async () => {
    const game = await playPractice('casa-basico', 1, centerDecider);
    expect(['connect4', 'draw']).toContain(game.result!.reason);
    expect(loop!.status().moves).toBeGreaterThan(3);
    expect(loop!.status().fallbacks).toBe(0);
    expect(loop!.status().avgDepth).toBe(1);
  });

  it('plays a complete practice game vs casa-aleatorio as player 2 without forfeits', async () => {
    const game = await playPractice('casa-aleatorio', 2, centerDecider);
    expect(['connect4', 'draw']).toContain(game.result!.reason);
    expect(game.moves.filter((m) => m.by === 2).every((m) => (m.ms ?? 0) < 3000)).toBe(true);
    expect(loop!.status().connected).toBe(true);
  });

  it('a decider that always throws still finishes the game with legal fallback moves', async () => {
    const game = await playPractice('casa-basico', 1, async () => {
      throw new Error('boom');
    });
    expect(['connect4', 'draw']).toContain(game.result!.reason);
    expect(loop!.status().fallbacks).toBeGreaterThan(0);
    expect(loop!.status().lastError?.message).toBe('boom');
  });
});

describe('BotLoop safety', () => {
  it('falls back to a legal move when the decider exceeds the hard deadline', async () => {
    const { client, moves } = scriptedClient([makeTurn()]);
    loop = new BotLoop({ client, log: quiet, hardDeadlineMs: 300, decide: () => new Promise(() => {}) });
    const t0 = Date.now();
    loop.start();
    await waitFor(() => moves.length === 1);
    expect(Date.now() - t0).toBeLessThan(800);
    expect(moves[0]).toEqual({ gameId: 'g_1', column: 3 });
    expect(loop.status().lastMove?.source).toBe('fallback');
  });

  it('replaces a decider column that is not legal (full column / not in legal_moves)', async () => {
    const full = gridFromMoves([0, 0, 0, 0, 0, 0, 0]);
    const turn = makeTurn({ board: full, moves: [0, 0, 0, 0, 0, 0, 0], you: 2, turn: 8, legal_moves: [1, 2, 3, 4, 5, 6, 7] });
    const { client, moves } = scriptedClient([turn]);
    loop = new BotLoop({ client, log: quiet, decide: async () => ({ column: 0, depth: 5 }) });
    loop.start();
    await waitFor(() => moves.length === 1);
    expect(moves[0].column).not.toBe(0);
    expect(loop.status().fallbacks).toBe(1);
  });

  it('the fallback wins immediately when possible and otherwise blocks', () => {
    const g = gridFromMoves([0, 7, 1, 7, 2]); // P1 threatens 0-1-2-3; P2 has two in col 7
    expect(fallbackMove(g, 2, safeLegalMoves(g, []))).toBe(3); // block
    const g2 = gridFromMoves([0, 7, 1, 7, 2, 7]);
    expect(fallbackMove(g2, 1, safeLegalMoves(g2, []))).toBe(3); // win
    expect(fallbackMove(emptyGrid(), 1, safeLegalMoves(emptyGrid(), []))).toBe(3);
  });

  it('recovers from network failures with backoff and keeps polling', async () => {
    const logs: string[] = [];
    const { client, moves } = scriptedClient([new NetworkError('ECONNRESET'), new NetworkError('ECONNRESET'), makeTurn()]);
    loop = new BotLoop({ client, decide: centerDecider, log: (l) => logs.push(l), backoffMinMs: 10, backoffMaxMs: 20 });
    loop.start();
    await waitFor(() => moves.length === 1);
    expect(logs.filter((l) => l.includes('error de red'))).toHaveLength(2);
    expect(logs.some((l) => l.includes('Reintento en 20 ms'))).toBe(true);
    expect(loop.status().connected).toBe(true);
  });

  it('on 401 logs loudly, marks unauthorized and retries', async () => {
    const logs: string[] = [];
    const { client, moves } = scriptedClient([new UnauthorizedError('Token inválido.'), makeTurn()]);
    loop = new BotLoop({ client, decide: centerDecider, log: (l) => logs.push(l), unauthorizedRetryMs: 20 });
    loop.start();
    await waitFor(() => logs.some((l) => l.includes('401')));
    await waitFor(() => moves.length === 1);
    expect(loop.status().authorized).toBe(true);
  });

  it('ignores 409 not_your_turn and keeps going', async () => {
    const { client, moves } = scriptedClient([makeTurn(), makeTurn({ game_id: 'g_2' })], async () => {
      throw new ArbiterError(409, 'not_your_turn', 'no');
    });
    loop = new BotLoop({ client, decide: centerDecider, log: quiet });
    loop.start();
    await waitFor(() => moves.length === 2);
    expect(loop.status().games).toBe(2);
    expect(loop.status().rejected).toBe(0);
    expect(loop.status().moves).toBe(0);
  });

  it('counts 400 rejections and retries POST on network errors, resending the same column', async () => {
    let calls = 0;
    const { client, moves } = scriptedClient([makeTurn(), makeTurn({ game_id: 'g_2' })], async (g) => {
      calls++;
      if (g === 'g_1') throw new ArbiterError(400, 'illegal_move', 'llena');
      if (calls === 2) throw new NetworkError('reset');
      return { ok: true, state: 'won' };
    });
    loop = new BotLoop({ client, decide: centerDecider, log: quiet });
    loop.start();
    await waitFor(() => loop!.status().moves === 1);
    expect(moves.map((m) => m.gameId)).toEqual(['g_1', 'g_2', 'g_2']);
    expect(moves[1].column).toBe(moves[2].column);
    expect(loop.status().rejected).toBe(1);
    expect(loop.status().results.won).toBe(1);
  });

  it('a re-served turn reuses the column already chosen without calling the decider', async () => {
    let decided = 0;
    const { client, moves } = scriptedClient([makeTurn(), makeTurn()], async () => {
      throw new NetworkError('lost');
    });
    loop = new BotLoop({ client, log: quiet, decide: async (i) => (decided++, centerDecider(i)) });
    loop.start();
    await waitFor(() => moves.length >= 5);
    expect(decided).toBe(1);
    expect(new Set(moves.map((m) => m.column)).size).toBe(1);
  });

  it('rebuilds the grid from moves when the board is malformed, and uses legal_moves when both fail', () => {
    const t = makeTurn({ board: [[9]] as never, moves: [3, 3] });
    expect(resolveGrid(t)![1][3]).toBe(2);
    expect(resolveGrid(makeTurn({ board: null as never, moves: [9] }))).toBeNull();
  });

  it('plays from legal_moves when board and moves are unusable', async () => {
    const { client, moves } = scriptedClient([makeTurn({ board: null as never, moves: [99], legal_moves: [7, 4] })]);
    loop = new BotLoop({ client, decide: centerDecider, log: quiet });
    loop.start();
    await waitFor(() => moves.length === 1);
    expect(moves[0].column).toBe(4);
  });

  it('safeLegalMoves intersects arbiter and grid, trusting the arbiter if they disagree', () => {
    const g = emptyGrid();
    expect(safeLegalMoves(g, [0, 7])).toEqual([0, 7]);
    expect(safeLegalMoves(gridFromMoves([0, 0, 0, 0, 0, 0, 0]), [0])).toEqual([0]);
  });

  it('stop() ends the loop even while a long poll is pending', async () => {
    mock = await startMockArbiter({ tokens: { tok: 'E' } });
    loop = new BotLoop({ client: new ArbiterClient({ baseUrl: mock.url, token: 'tok' }), decide: centerDecider, log: quiet, waitSec: 20 });
    loop.start();
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await loop.stop();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(loop.status().running).toBe(false);
  });
});
