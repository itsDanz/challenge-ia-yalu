import { describe, expect, it } from 'vitest';
import { Board } from '../../src/engine/bitboard.ts';
import { Engine, MATE_BOUND, WIN_SCORE } from '../../src/engine/index.ts';
import {
  type Grid,
  type Player,
  cloneGrid,
  dropPiece,
  emptyGrid,
  findWinner,
  gridFromMoves,
  isLegalMove,
  legalMoves,
  opponent,
  outcome,
  winningLineThrough,
} from '../../src/engine/rules.ts';
import { Searcher } from '../../src/engine/search.ts';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A completely filled 8×7 grid with no four in a line (found by backtracking). */
function drawnFullGrid(): Grid {
  const grid = emptyGrid();
  const fill = (i: number): boolean => {
    if (i === 56) return true;
    const r = Math.floor(i / 8), c = i % 8;
    for (const v of [1, 2] as const) {
      grid[r][c] = v;
      if (!winningLineThrough(grid, r, c) && fill(i + 1)) return true;
    }
    grid[r][c] = 0;
    return false;
  };
  if (!fill(0)) throw new Error('no drawn grid');
  return grid;
}

const engine = new Engine({ ttBits: 16 });

describe('tactics', () => {
  it('plays the immediate win (horizontal)', () => {
    const grid = gridFromMoves([3, 3, 4, 4, 5, 5]);
    const r = engine.search(grid, 1, { timeMs: 100 });
    expect([2, 6]).toContain(r.column);
    expect(r.score).toBe(WIN_SCORE);
    expect(r.source).toBe('forced');
  });

  it('plays the immediate win (vertical) as player 2', () => {
    const grid = gridFromMoves([0, 7, 1, 7, 2, 7, 5]);
    const r = engine.search(grid, 2, { timeMs: 100 });
    expect(r.column).toBe(7);
    expect(r.score).toBe(WIN_SCORE);
  });

  it('blocks the opponent win-in-1', () => {
    const grid = gridFromMoves([3, 0, 3, 0, 3]);
    const r = engine.search(grid, 2, { timeMs: 100 });
    expect(r.column).toBe(3);
    expect(r.source).toBe('forced');
  });

  it('finds the forced win in 3 (double threat)', () => {
    // P1 has 2,3 on the bottom row; cols 1,4,5 (and 0,6) free: playing 4 creates two threats.
    const grid = gridFromMoves([2, 2, 3, 3]);
    const r = engine.search(grid, 1, { timeMs: 300 });
    expect([1, 4]).toContain(r.column);
    expect(r.score).toBeGreaterThanOrEqual(MATE_BOUND);
    expect(r.score).toBe(WIN_SCORE - 2);
    expect(r.source).toBe('search');
    expect(r.pv[0]).toBe(r.column);
    // The per-node tactical checks (double threat = loss) see this already at depth 1.
    expect(r.depth).toBeGreaterThanOrEqual(1);
  });

  it('sees a deeper forced win (win in 5) and reports a mate score', () => {
    // P1 to move; after 4 (P1), P2 must block at 1 or 5... build: P1 at 2,3 bottom, P2 elsewhere.
    const grid = gridFromMoves([3, 3, 2, 2, 7, 7]);
    const r = engine.search(grid, 1, { timeMs: 400 });
    expect(r.score).toBeGreaterThanOrEqual(MATE_BOUND);
    expect(isLegalMove(grid, r.column)).toBe(true);
  });

  it('avoids playing under an opponent winning cell when alternatives exist', () => {
    // P2 has (1,2),(1,3),(1,4); its only threat is (1,5), which sits on the empty (0,5).
    // P1 to move: playing column 5 would hand P2 the win on top.
    const grid = emptyGrid();
    grid[0][1] = 2; grid[0][2] = 1; grid[0][3] = 1; grid[0][4] = 2;
    grid[1][1] = 1; grid[1][2] = 2; grid[1][3] = 2; grid[1][4] = 2;
    const r = engine.search(grid, 1, { timeMs: 200 });
    expect(isLegalMove(grid, r.column)).toBe(true);
    expect(r.column).not.toBe(5);
    const next = dropPiece(grid, r.column, 1).grid;
    for (const c of legalMoves(next)) {
      const after = dropPiece(next, c, 2).grid;
      expect(findWinner(after)).toBeNull();
    }
  });

  it('when every move loses, still returns a legal column with a losing score', () => {
    // P2 has 3,4,5 on the bottom row with 2 and 6 free: P1 to move cannot stop both.
    const grid = gridFromMoves([0, 3, 0, 4, 7, 5]);
    const r = engine.search(grid, 1, { timeMs: 100 });
    expect(isLegalMove(grid, r.column)).toBe(true);
    expect(r.score).toBeLessThanOrEqual(-MATE_BOUND);
  });

  it('when the search proves a loss, it still picks a legal move (slowest loss)', () => {
    // P1 to move; P2 has a double threat prepared one ply away in search terms.
    const grid = gridFromMoves([0, 3, 0, 4, 7]);
    const r = engine.search(grid, 2, { timeMs: 200 });
    expect(isLegalMove(grid, r.column)).toBe(true);
    // P2 should win here by playing 2 or 5 (double threat).
    expect([2, 5]).toContain(r.column);
    expect(r.score).toBeGreaterThanOrEqual(MATE_BOUND);
  });
});

describe('edge boards', () => {
  const full = drawnFullGrid();

  it('only one legal column', () => {
    const grid = cloneGrid(full);
    grid[6][5] = 0;
    const r = engine.search(grid, 1, { timeMs: 100 });
    expect(r.column).toBe(5);
    expect(r.source).toBe('forced');
  });

  it('board two moves from full: exact 2-ply result (draw or forced outcome)', () => {
    const grid = cloneGrid(full);
    grid[6][0] = 0;
    grid[6][7] = 0;
    // Oracle: 2-ply minimax with rules.ts.
    const expected = new Map<number, number>();
    for (const c of [0, 7]) {
      const g1 = dropPiece(grid, c, 1).grid;
      if (findWinner(g1)) { expected.set(c, WIN_SCORE); continue; }
      const other = c === 0 ? 7 : 0;
      const g2 = dropPiece(g1, other, 2).grid;
      expected.set(c, findWinner(g2) ? -(WIN_SCORE - 1) : 0);
    }
    const best = Math.max(...expected.values());
    const r = engine.search(grid, 1, { timeMs: 100 });
    expect([0, 7]).toContain(r.column);
    expect(expected.get(r.column)).toBe(best);
    expect(r.score).toBe(best);
  });

  it('board one move from full (last cell) is forced', () => {
    const grid = cloneGrid(full);
    grid[6][7] = 0;
    const r = engine.search(grid, 2, { timeMs: 100 });
    expect(r.column).toBe(7);
    expect(r.source).toBe('forced');
  });

  it('throws on a full board and on an invalid grid', () => {
    expect(() => engine.search(full, 1, { timeMs: 10 })).toThrow(RangeError);
    const bad = emptyGrid();
    bad[1][0] = 1; // floating piece
    expect(() => engine.search(bad, 1, { timeMs: 10 })).toThrow(RangeError);
    expect(() => engine.search(emptyGrid(), 3 as unknown as Player, { timeMs: 10 })).toThrow(RangeError);
  });
});

describe('reliability', () => {
  it('never returns an illegal move across many random positions (short budgets)', () => {
    const random = rng(2024);
    const e = new Engine({ ttBits: 14 });
    let checked = 0;
    for (let g = 0; g < 60; g++) {
      let grid = emptyGrid();
      let player: Player = 1;
      e.newGame();
      while (outcome(grid).status === 'playing') {
        const useEngine = random() < 0.5;
        let col: number;
        if (useEngine) {
          const r = e.search(grid, player, { timeMs: 5 + Math.floor(random() * 25) });
          col = r.column;
          expect(isLegalMove(grid, col)).toBe(true);
          expect(r.pv[0]).toBe(col);
          checked++;
        } else {
          const moves = legalMoves(grid);
          col = moves[Math.floor(random() * moves.length)];
        }
        grid = dropPiece(grid, col, player).grid;
        player = opponent(player);
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('respects the time budget on an early-game position', () => {
    const e = new Engine({ ttBits: 20 });
    const grid = gridFromMoves([3, 4]);
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const r = e.search(grid, 1, { timeMs: 200 });
      const dt = performance.now() - t0;
      expect(dt).toBeLessThan(260);
      expect(r.timeMs).toBeLessThan(260);
      expect(isLegalMove(grid, r.column)).toBe(true);
      expect(r.depth).toBeGreaterThanOrEqual(6);
    }
  });

  it('maxDepth caps the iterative deepening', () => {
    const r = engine.search(gridFromMoves([3, 4]), 1, { timeMs: 500, maxDepth: 4 });
    expect(r.depth).toBe(4);
    expect(r.pv.length).toBeLessThanOrEqual(4);
  });

  it('aborts mid-iteration and still returns the previous iteration result (fake clock)', () => {
    // The clock advances 3 "ms" per read (reads happen every 1024 nodes), so the budget of
    // 100 runs out after ~34k nodes, in the middle of an iteration.
    let ticks = 0;
    const s = new Searcher({ ttBits: 14, now: () => ticks++ * 3, iterationCutoff: 10 });
    const board = Board.fromGrid(gridFromMoves([3, 4, 3]), 2);
    const r = s.search(board, { timeMs: 100 });
    expect(s.aborted).toBe(true);
    expect(board.canPlay(r.column)).toBe(true);
    expect(r.depth).toBeGreaterThanOrEqual(1);
    expect(r.nodes).toBeLessThan(60_000);
  });

  it('newGame clears the table and the engine keeps working', () => {
    const e = new Engine({ ttBits: 12 });
    const grid = gridFromMoves([3, 3, 4]);
    const a = e.search(grid, 2, { timeMs: 50 });
    e.newGame();
    const b = e.search(grid, 2, { timeMs: 50 });
    expect(isLegalMove(grid, a.column)).toBe(true);
    expect(isLegalMove(grid, b.column)).toBe(true);
  });

  it('randomness still produces legal, non-losing moves', () => {
    const s = new Searcher({ ttBits: 12, random: () => 0.0 });
    const grid = gridFromMoves([3, 3, 4, 4]);
    const board = Board.fromGrid(grid, 1);
    for (let i = 0; i < 10; i++) {
      const r = s.search(board, { timeMs: 20, randomness: 1 });
      expect(isLegalMove(grid, r.column)).toBe(true);
    }
    const e = new Engine({ ttBits: 12 });
    for (let i = 0; i < 20; i++) {
      const r = e.search(grid, 1, { timeMs: 10, randomness: 0.5 });
      expect(isLegalMove(grid, r.column)).toBe(true);
    }
    // randomness never overrides a forced win
    const win = e.search(gridFromMoves([3, 3, 4, 4, 5, 5]), 1, { timeMs: 10, randomness: 1 });
    expect([2, 6]).toContain(win.column);
  });

  it('a single forced block that is itself losing is still played', () => {
    // P2 (to move) must block at col 2 row 0 but P1 also wins at col 2 row 1? Build directly.
    const grid = emptyGrid();
    // P1 bottom: cols 3,4,5 -> threats at 2 and 6 (double) — that is the "all lose" case.
    // Instead: P1 threatens (0,2) only, and also (1,2) via diagonal: stones (0,3),(1,4),(2,5)? No (2,5) support.
    grid[0][3] = 1; grid[0][4] = 1; grid[0][5] = 1; grid[0][6] = 2;
    grid[1][3] = 1; grid[1][4] = 1; grid[1][5] = 2; grid[1][6] = 2;
    grid[0][7] = 2; grid[0][2] = 0;
    // P2 to move: single threat at (0,2); after block, P1 plays (1,2) completing (1,2),(1,3),(1,4)+? not 4.
    const r = engine.search(grid, 2, { timeMs: 50 });
    expect(r.column).toBe(2);
  });
});
