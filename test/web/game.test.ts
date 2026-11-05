import { describe, expect, it } from 'vitest';
import {
  canUndo,
  gameReducer,
  initialState,
  isHumanTurn,
  sideToMove,
  type BotInfo,
  type GameAction,
  type GameState,
} from '../../web/src/logic/game.ts';

function info(column: number, extra: Partial<BotInfo> = {}): BotInfo {
  return { column, score: 0, depth: 10, nodes: 1000, timeMs: 50, pv: [column], source: 'search', ...extra };
}

function run(state: GameState, ...actions: GameAction[]): GameState {
  return actions.reduce(gameReducer, state);
}

/** Human plays `col`, then the bot answers `botCol` through the pending request. */
function exchange(state: GameState, col: number, botCol: number): GameState {
  const s = gameReducer(state, { type: 'humanMove', column: col });
  if (!s.pending) return s;
  return gameReducer(s, { type: 'botResponse', requestId: s.pending.id, info: info(botCol) });
}

describe('initialState', () => {
  it('human opens: human is player 1, no pending request', () => {
    const s = initialState('human', 'medio');
    expect(s.human).toBe(1);
    expect(s.pending).toBeNull();
    expect(isHumanTurn(s)).toBe(true);
    expect(s.outcome).toEqual({ status: 'playing', next: 1 });
  });

  it('bot opens: human is player 2 and a bot request is scheduled', () => {
    const s = initialState('bot', 'facil');
    expect(s.human).toBe(2);
    expect(s.pending).not.toBeNull();
    expect(isHumanTurn(s)).toBe(false);
    expect(s.level).toBe('facil');
  });
});

describe('humanMove', () => {
  it('drops the piece at the bottom and asks the bot', () => {
    const s = run(initialState(), { type: 'humanMove', column: 3 });
    expect(s.moves).toEqual([3]);
    expect(s.grid[0][3]).toBe(1);
    expect(s.lastMove).toEqual({ row: 0, col: 3 });
    expect(s.pending).not.toBeNull();
    expect(sideToMove(s.moves)).toBe(2);
  });

  it('rejects a move into a full column without changing the board', () => {
    let s = initialState();
    for (let i = 0; i < 3; i++) s = exchange(s, 0, 0); // 6 pieces
    s = exchange(s, 0, 1); // 7th piece fills column 0
    expect(s.grid[6][0]).not.toBe(0);
    const before = s.moves;
    const after = gameReducer(s, { type: 'humanMove', column: 0 });
    expect(after.moves).toBe(before);
    expect(after.rejection).toMatchObject({ column: 0, reason: 'full' });
    const again = gameReducer(after, { type: 'humanMove', column: 0 });
    expect(again.rejection!.nonce).toBe(after.rejection!.nonce + 1);
  });

  it('rejects moves while the bot is thinking', () => {
    const s = run(initialState(), { type: 'humanMove', column: 3 }, { type: 'humanMove', column: 4 });
    expect(s.moves).toEqual([3]);
    expect(s.rejection?.reason).toBe('not-your-turn');
  });

  it('rejects out-of-range columns', () => {
    const s = run(initialState(), { type: 'humanMove', column: 8 });
    expect(s.moves).toEqual([]);
    expect(s.rejection?.reason).toBe('out-of-range');
  });
});

describe('win and draw detection', () => {
  it('detects a human win with the four winning cells', () => {
    let s = initialState();
    s = exchange(s, 0, 0);
    s = exchange(s, 1, 1);
    s = exchange(s, 2, 2);
    s = run(s, { type: 'humanMove', column: 3 });
    expect(s.outcome.status).toBe('won');
    if (s.outcome.status !== 'won') throw new Error('unreachable');
    expect(s.outcome.winner).toBe(1);
    expect(s.outcome.cells).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
    ]);
    expect(s.pending).toBeNull();
    expect(gameReducer(s, { type: 'humanMove', column: 5 }).rejection?.reason).toBe('game-over');
  });

  it('detects a bot win (vertical)', () => {
    let s = initialState();
    s = exchange(s, 0, 7);
    s = exchange(s, 1, 7);
    s = exchange(s, 0, 7);
    s = exchange(s, 1, 7);
    expect(s.outcome).toMatchObject({ status: 'won', winner: 2 });
  });

  it('detects a draw on a full board without four in line', () => {
    // Fill columns in pairs with a pattern that never connects four.
    const order = [0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1];
    const pattern: number[] = [];
    for (const base of [0, 2, 4, 6]) pattern.push(...order.map((c) => c + base));
    let s = initialState();
    for (let i = 0; i < pattern.length; i += 2) s = exchange(s, pattern[i], pattern[i + 1]);
    expect(s.moves).toHaveLength(56);
    expect(s.outcome.status).toBe('draw');
    expect(s.pending).toBeNull();
  });
});

describe('bot responses', () => {
  it('applies the bot move and stores its insight', () => {
    const s = exchange(initialState(), 3, 4);
    expect(s.moves).toEqual([3, 4]);
    expect(s.insight?.column).toBe(4);
    expect(s.insights[1]?.column).toBe(4);
    expect(isHumanTurn(s)).toBe(true);
  });

  it('discards a stale response after restart', () => {
    const s1 = run(initialState(), { type: 'humanMove', column: 3 });
    const staleId = s1.pending!.id;
    const s2 = run(s1, { type: 'restart', starter: 'bot' });
    expect(s2.pending!.id).not.toBe(staleId);
    const s3 = run(s2, { type: 'botResponse', requestId: staleId, info: info(5) });
    expect(s3).toBe(s2);
  });

  it('discards a stale response after undo', () => {
    let s = exchange(initialState(), 3, 4);
    s = run(s, { type: 'humanMove', column: 2 });
    const staleId = s.pending!.id;
    s = run(s, { type: 'undo' });
    expect(s.moves).toEqual([3, 4]);
    expect(run(s, { type: 'botResponse', requestId: staleId, info: info(2) })).toBe(s);
  });

  it('turns network errors into a retryable error state', () => {
    const s1 = run(initialState(), { type: 'humanMove', column: 3 });
    const s2 = run(s1, { type: 'botError', requestId: s1.pending!.id, message: 'sin conexión' });
    expect(s2.error).toBe('sin conexión');
    expect(s2.pending).toBeNull();
    expect(isHumanTurn(s2)).toBe(false);
    const s3 = run(s2, { type: 'retry' });
    expect(s3.error).toBeNull();
    expect(s3.pending!.id).toBeGreaterThan(s1.pending!.id);
  });

  it('ignores stale errors', () => {
    const s1 = run(initialState(), { type: 'humanMove', column: 3 });
    const s2 = run(s1, { type: 'botError', requestId: 999, message: 'x' });
    expect(s2).toBe(s1);
  });

  it('rejects an illegal bot column with an error instead of crashing', () => {
    let s = initialState();
    for (let i = 0; i < 3; i++) s = exchange(s, 0, 0);
    s = run(s, { type: 'humanMove', column: 0 }); // column 0 now full
    s = run(s, { type: 'botResponse', requestId: s.pending!.id, info: info(0) });
    expect(s.moves).toHaveLength(7);
    expect(s.error).toMatch(/inválida/);
  });
});

describe('undo', () => {
  it('undoes both the bot reply and the human move', () => {
    let s = exchange(initialState(), 3, 4);
    s = exchange(s, 2, 5);
    s = run(s, { type: 'undo' });
    expect(s.moves).toEqual([3, 4]);
    expect(isHumanTurn(s)).toBe(true);
    expect(s.insight?.column).toBe(4);
  });

  it('undoes only the human move while the bot is still thinking', () => {
    const s = run(initialState(), { type: 'humanMove', column: 3 }, { type: 'undo' });
    expect(s.moves).toEqual([]);
    expect(s.pending).toBeNull();
    expect(s.insight).toBeNull();
  });

  it('when the bot opened, never undoes its first move', () => {
    let s = initialState('bot');
    s = run(s, { type: 'botResponse', requestId: s.pending!.id, info: info(3) });
    expect(canUndo(s)).toBe(false);
    expect(run(s, { type: 'undo' })).toBe(s);
    s = exchange(s, 2, 4);
    s = run(s, { type: 'undo' });
    expect(s.moves).toEqual([3]);
    expect(isHumanTurn(s)).toBe(true);
  });

  it('undo after the game ended resumes play', () => {
    let s = initialState();
    s = exchange(s, 0, 0);
    s = exchange(s, 1, 1);
    s = exchange(s, 2, 2);
    s = run(s, { type: 'humanMove', column: 3 }, { type: 'undo' });
    expect(s.outcome.status).toBe('playing');
    expect(s.moves).toHaveLength(6);
  });
});

describe('restart and level', () => {
  it('restart keeps the level and switches who starts', () => {
    let s = run(initialState('human', 'medio'), { type: 'setLevel', level: 'maximo' });
    s = exchange(s, 3, 3);
    s = run(s, { type: 'restart', starter: 'bot' });
    expect(s.moves).toEqual([]);
    expect(s.level).toBe('maximo');
    expect(s.human).toBe(2);
    expect(s.pending).not.toBeNull();
    expect(s.insight).toBeNull();
  });

  it('restart without arguments repeats the previous starter', () => {
    const s = run(initialState('bot'), { type: 'restart' });
    expect(s.starter).toBe('bot');
  });
});
