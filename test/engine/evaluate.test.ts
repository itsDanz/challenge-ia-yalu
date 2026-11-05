import { describe, expect, it } from 'vitest';
import { Board } from '../../src/engine/bitboard.ts';
import { DEFAULT_WEIGHTS, EVAL_LIMIT, type EvalWeights, evaluate } from '../../src/engine/evaluate.ts';
import { type Grid, emptyGrid, gridFromMoves } from '../../src/engine/rules.ts';

function ev(grid: Grid, toMove: 1 | 2, w: EvalWeights = DEFAULT_WEIGHTS): number {
  const b = Board.fromGrid(grid, toMove);
  return evaluate(b.pLo, b.pHi, b.mLo, b.mHi, w);
}

describe('evaluate', () => {
  it('empty board is 0 and is antisymmetric between the two sides', () => {
    expect(ev(emptyGrid(), 1)).toBe(0);
    const grid = gridFromMoves([3, 4, 3, 2, 5]);
    expect(ev(grid, 2)).toBe(-ev(grid, 1));
  });

  it('centre stones are worth more than edge stones', () => {
    expect(ev(gridFromMoves([3]), 2)).toBeLessThan(ev(gridFromMoves([0]), 2));
  });

  it('a threat is worth more than no threat', () => {
    // P1 has 3 on the bottom row (cols 1,2,3) with col 0 and 4 empty: two threats.
    const threats = gridFromMoves([1, 7, 2, 7, 3, 7]);
    const quiet = gridFromMoves([1, 7, 3, 7, 5, 7]);
    expect(ev(threats, 1)).toBeGreaterThan(ev(quiet, 1));
  });

  it('parity: p1even and p1odd value the same threat differently', () => {
    // P1 threat on row index 0 (odd row 1-indexed): bad for P1 under p1even, good under p1odd.
    const grid = gridFromMoves([1, 7, 2, 7, 3, 7]);
    const even = ev(grid, 1, { ...DEFAULT_WEIGHTS, parityMode: 'p1even' });
    const odd = ev(grid, 1, { ...DEFAULT_WEIGHTS, parityMode: 'p1odd' });
    const off = ev(grid, 1, { ...DEFAULT_WEIGHTS, parityMode: 'off' });
    expect(odd).toBeGreaterThan(even);
    expect(off).toBeGreaterThan(even);
    expect(off).toBeLessThan(odd);
  });

  it('stacked threats score higher than two separate threats', () => {
    // Build two vertically adjacent threats for P1 at col 0 rows 1 and 2 via diagonals is hard;
    // use a direct grid: P1 horizontal threes on rows 1 and 2 with col 0 open above a filled row 0.
    const g = emptyGrid();
    g[0][0] = 2; g[0][1] = 2; g[0][2] = 1; g[0][3] = 2; // row 0
    g[1][1] = 1; g[1][2] = 1; g[1][3] = 1; // row 1: P1 1,2,3 -> threat at (1,0) and (1,4)
    g[2][1] = 1; g[2][2] = 1; g[2][3] = 1; // row 2: threats at (2,0) and (2,4)
    g[1][0] = 0; g[2][0] = 0;
    // support for row 2 stones
    g[0][4] = 2; g[1][4] = 0;
    const stacked = ev(g, 1);
    const single = (() => {
      const h = g.map((r) => r.slice()) as Grid;
      h[2][1] = 2; h[2][2] = 2; h[2][3] = 2; // row 2 now P2's: kills stacked threats
      return ev(h, 1);
    })();
    expect(stacked).toBeGreaterThan(single);
  });

  it('is clamped to EVAL_LIMIT', () => {
    // P1 has two threats, P2 one (playable, so it counts double): with oppPercent 50 the
    // P1 view is +100000 and the P2 view (full opponent weight) is -100000.
    const grid = gridFromMoves([1, 7, 2, 7, 3, 7]);
    const w: EvalWeights = { ...DEFAULT_WEIGHTS, threatGood: 100000, threatBad: 100000, oppPercent: 50 };
    expect(ev(grid, 1, w)).toBe(EVAL_LIMIT);
    expect(ev(grid, 2, { ...w, oppPercent: 100 })).toBe(-EVAL_LIMIT);
  });

  it('oppPercent scales the opponent part', () => {
    const grid = gridFromMoves([1, 7, 2, 7, 3, 7]);
    const a = ev(grid, 2, { ...DEFAULT_WEIGHTS, oppPercent: 100 });
    const b = ev(grid, 2, { ...DEFAULT_WEIGHTS, oppPercent: 50 });
    expect(b).toBeGreaterThan(a);
  });
});
