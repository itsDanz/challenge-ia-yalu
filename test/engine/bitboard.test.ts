import { describe, expect, it } from 'vitest';
import {
  Board,
  R,
  bitColumn,
  bitRow,
  hasWon,
  keyHi,
  keyLo,
  popcount32,
  popcount64,
  possibleMoves,
  winningPositions,
} from '../../src/engine/bitboard.ts';
import {
  type Grid,
  type Player,
  cloneGrid,
  dropPiece,
  emptyGrid,
  findWinner,
  gridFromMoves,
  isLegalMove,
  landingRow,
  legalMoves,
  opponent,
  outcome,
} from '../../src/engine/rules.ts';

/** Deterministic PRNG (mulberry32) so failures are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Oracle: columns where `player` wins immediately, using rules.ts. */
function oracleWinningColumns(grid: Grid, player: Player): number[] {
  const out: number[] = [];
  for (const c of legalMoves(grid)) {
    const next = dropPiece(grid, c, player).grid;
    const w = findWinner(next);
    if (w && w.winner === player) out.push(c);
  }
  return out;
}

/** Oracle: all empty cells where placing `player` (floating allowed) completes four. */
function oracleWinningCells(grid: Grid, player: Player): Set<string> {
  const out = new Set<string>();
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 8; c++) {
      if (grid[r][c] !== 0) continue;
      const g = cloneGrid(grid);
      g[r][c] = player;
      const w = findWinner(g);
      if (w && w.winner === player && w.cells.some(([rr, cc]) => rr === r && cc === c)) out.add(`${r},${c}`);
    }
  }
  return out;
}

function bitsToCells(lo: number, hi: number): Set<string> {
  const out = new Set<string>();
  for (let c = 0; c < 8; c++) {
    for (let r = 0; r < 7; r++) {
      const bit = 1 << ((c & 3) * 8 + r);
      if (((c < 4 ? lo : hi) & bit) !== 0) out.add(`${r},${c}`);
    }
  }
  return out;
}

describe('bitboard vs rules.ts (differential, random games)', () => {
  it('agrees on legal moves, win detection, winning columns and winning cells at every ply', () => {
    const random = rng(12345);
    const GAMES = 800;
    let plies = 0;
    for (let g = 0; g < GAMES; g++) {
      let grid = emptyGrid();
      let player: Player = 1;
      const board = new Board();
      for (;;) {
        expect(board.legalMoves()).toEqual(legalMoves(grid));
        expect(board.toGrid(player)).toEqual(grid);
        const fromGrid = Board.fromGrid(grid, player);
        expect([fromGrid.pLo, fromGrid.pHi, fromGrid.mLo, fromGrid.mHi]).toEqual([board.pLo, board.pHi, board.mLo, board.mHi]);
        expect(board.winningColumns()).toEqual(oracleWinningColumns(grid, player));
        winningPositions(board.pLo, board.pHi, board.mLo, board.mHi);
        expect(bitsToCells(R[0], R[1])).toEqual(oracleWinningCells(grid, player));
        const opp = opponent(player);
        winningPositions(board.pLo ^ board.mLo, board.pHi ^ board.mHi, board.mLo, board.mHi);
        expect(bitsToCells(R[0], R[1])).toEqual(oracleWinningCells(grid, opp));

        const moves = legalMoves(grid);
        const col = moves[Math.floor(random() * moves.length)];
        grid = dropPiece(grid, col, player).grid;
        board.play(col);
        plies++;
        const res = outcome(grid);
        expect(board.lastMoverWon()).toBe(res.status === 'won');
        expect(board.isFull()).toBe(legalMoves(grid).length === 0);
        player = opp;
        if (res.status !== 'playing') break;
      }
    }
    expect(plies).toBeGreaterThan(GAMES * 10);
  });

  it('canWinNow matches the oracle on random mid-game positions', () => {
    const random = rng(777);
    for (let g = 0; g < 500; g++) {
      let grid = emptyGrid();
      let player: Player = 1;
      const board = new Board();
      const n = 5 + Math.floor(random() * 30);
      for (let i = 0; i < n; i++) {
        const moves = legalMoves(grid);
        const col = moves[Math.floor(random() * moves.length)];
        grid = dropPiece(grid, col, player).grid;
        board.play(col);
        player = opponent(player);
        if (outcome(grid).status !== 'playing') break;
      }
      if (outcome(grid).status !== 'playing') continue;
      expect(board.canWinNow()).toBe(oracleWinningColumns(grid, player).length > 0);
    }
  });
});

describe('win detection in all four directions', () => {
  const cases: Array<[string, number[]]> = [
    ['horizontal', [0, 0, 1, 1, 2, 2, 3]],
    ['vertical', [5, 6, 5, 6, 5, 6, 5]],
    ['diagonal up-right', [0, 1, 1, 2, 2, 3, 2, 3, 3, 7, 3]],
    ['diagonal up-left', [7, 6, 6, 5, 5, 4, 5, 4, 4, 0, 4]],
  ];
  for (const [name, moves] of cases) {
    it(name, () => {
      const board = new Board();
      for (const m of moves.slice(0, -1)) {
        board.play(m);
        expect(board.lastMoverWon()).toBe(false);
      }
      expect(board.winningColumns()).toEqual([moves[moves.length - 1]]);
      board.play(moves[moves.length - 1]);
      expect(board.lastMoverWon()).toBe(true);
      expect(outcome(gridFromMoves(moves)).status).toBe('won');
    });
  }

  it('horizontal line across the lo/hi word boundary (cols 2-5)', () => {
    const board = new Board();
    for (const m of [2, 2, 3, 3, 4, 4]) board.play(m);
    expect(board.winningColumns()).toEqual([1, 5]);
    board.play(5);
    expect(board.lastMoverWon()).toBe(true);
    expect(hasWon(board.pLo ^ board.mLo, board.pHi ^ board.mHi)).toBe(true);
  });

  it('does not wrap around column tops (sentinel row)', () => {
    // Column 0 full with alternating-ish stones, then stones in column 1 bottom: no false line.
    const board = new Board();
    // p1: col0 rows 0,2,4,6 ; p2: col0 rows 1,3,5 and col1 rows 0..2
    for (const m of [0, 0, 0, 0, 0, 0, 0, 1, 2, 1, 2, 1]) board.play(m);
    expect(board.lastMoverWon()).toBe(false);
    expect(findWinner(board.toGrid(1))).toBeNull();
  });
});

describe('helpers', () => {
  it('popcount', () => {
    expect(popcount32(0)).toBe(0);
    expect(popcount32(-1)).toBe(32);
    expect(popcount32(0x7f7f7f7f)).toBe(28);
    expect(popcount64(1, 1 << 31)).toBe(2);
  });

  it('bitColumn / bitRow', () => {
    expect(bitColumn(0, 0)).toBe(-1);
    expect(bitRow(0, 0)).toBe(-1);
    expect(bitColumn(1 << 24, 0)).toBe(3);
    expect(bitColumn(1 << 31, 0)).toBe(3);
    expect(bitRow(1 << 31, 0)).toBe(7);
    expect(bitColumn(0, 1 << 8)).toBe(5);
    expect(bitRow(0, 1 << 10)).toBe(2);
  });

  it('possibleMoves is the landing row of each non-full column', () => {
    const grid = gridFromMoves([3, 3, 3, 3, 3, 3, 3, 4, 4]);
    const board = Board.fromGrid(grid, 2);
    possibleMoves(board.mLo, board.mHi);
    const cells = bitsToCells(R[0], R[1]);
    for (let c = 0; c < 8; c++) {
      const r = landingRow(grid, c);
      expect(cells.has(`${r},${c}`)).toBe(r !== -1);
      expect(board.canPlay(c)).toBe(isLegalMove(grid, c));
    }
    expect(board.canPlay(-1)).toBe(false);
    expect(board.canPlay(8)).toBe(false);
  });

  it('keys are unique across many random positions', () => {
    const random = rng(99);
    const seen = new Map<string, string>();
    for (let g = 0; g < 400; g++) {
      const board = new Board();
      const n = Math.floor(random() * 20);
      const moves: number[] = [];
      for (let i = 0; i < n; i++) {
        const legal = board.legalMoves();
        const c = legal[Math.floor(random() * legal.length)];
        board.play(c);
        moves.push(c);
        if (board.lastMoverWon()) break;
      }
      const key = `${keyLo(board.pLo, board.mLo)},${keyHi(board.pHi, board.mHi)}`;
      const sig = JSON.stringify(board.toGrid(board.moves % 2 === 0 ? 1 : 2));
      const prev = seen.get(key);
      if (prev !== undefined) expect(prev).toBe(sig);
      seen.set(key, sig);
    }
  });

  it('clone is independent', () => {
    const a = new Board();
    a.play(3);
    const b = a.clone();
    b.play(4);
    expect(a.moves).toBe(1);
    expect(b.moves).toBe(2);
  });
});
