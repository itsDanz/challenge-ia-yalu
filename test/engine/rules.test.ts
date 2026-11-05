import { describe, expect, it } from 'vitest';
import {
  COLS,
  ROWS,
  countPieces,
  dropPiece,
  emptyGrid,
  findWinner,
  gridFromMoves,
  isLegalMove,
  isValidGrid,
  landingRow,
  legalMoves,
  opponent,
  outcome,
  playerToMove,
  winningLineThrough,
  type Grid,
} from '../../src/engine/rules.ts';

/** A full 56-cell board (28 pieces each) with no four in a row in any direction. */
function fullDrawGrid(): Grid {
  const a = [1, 1, 2, 2, 1, 1, 2, 2] as const;
  const b = [2, 2, 1, 1, 2, 2, 1, 1] as const;
  const order = [a, a, a, b, a, a, a];
  return order.map((row) => row.slice()) as Grid;
}

describe('dropPiece', () => {
  it('drops a piece to the lowest empty row', () => {
    const { grid, row } = dropPiece(emptyGrid(), 3, 1);
    expect(row).toBe(0);
    expect(grid[0][3]).toBe(1);
    const second = dropPiece(grid, 3, 2);
    expect(second.row).toBe(1);
    expect(second.grid[1][3]).toBe(2);
  });

  it('does not mutate the original grid', () => {
    const original = emptyGrid();
    dropPiece(original, 0, 1);
    expect(countPieces(original)).toBe(0);
  });

  it('rejects full columns and out of range columns', () => {
    let grid = emptyGrid();
    for (let i = 0; i < ROWS; i++) grid = dropPiece(grid, 5, ((i % 2) + 1) as 1 | 2).grid;
    expect(landingRow(grid, 5)).toBe(-1);
    expect(() => dropPiece(grid, 5, 1)).toThrow(/llena/);
    expect(() => dropPiece(grid, 8, 1)).toThrow(/rango/);
    expect(() => dropPiece(grid, -1, 1)).toThrow(/rango/);
    expect(() => dropPiece(grid, 1.5, 1)).toThrow(/rango/);
  });
});

describe('legal moves', () => {
  it('lists every column on an empty board', () => {
    expect(legalMoves(emptyGrid())).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('excludes full columns', () => {
    const grid = gridFromMoves([0, 0, 0, 0, 0, 0, 0]);
    expect(legalMoves(grid)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(isLegalMove(grid, 0)).toBe(false);
    expect(isLegalMove(grid, 1)).toBe(true);
    expect(isLegalMove(grid, COLS)).toBe(false);
  });
});

describe('victory in the four directions', () => {
  it('detects horizontal', () => {
    const grid = gridFromMoves([2, 2, 3, 3, 4, 4, 5]);
    const win = findWinner(grid);
    expect(win?.winner).toBe(1);
    expect(win?.cells).toEqual([[0, 2], [0, 3], [0, 4], [0, 5]]);
  });

  it('detects vertical', () => {
    const grid = gridFromMoves([7, 6, 7, 6, 7, 6, 7]);
    expect(findWinner(grid)?.cells).toEqual([[0, 7], [1, 7], [2, 7], [3, 7]]);
  });

  it('detects diagonal ↗', () => {
    // Player 1 builds (0,0),(1,1),(2,2),(3,3).
    const grid = gridFromMoves([0, 1, 1, 2, 2, 3, 2, 3, 3, 7, 3]);
    const win = findWinner(grid);
    expect(win?.winner).toBe(1);
    expect(win?.cells).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]]);
  });

  it('detects diagonal ↖', () => {
    // Mirror of the previous game: player 1 builds (0,7),(1,6),(2,5),(3,4).
    const grid = gridFromMoves([7, 6, 6, 5, 5, 4, 5, 4, 4, 0, 4]);
    const win = findWinner(grid);
    expect(win?.winner).toBe(1);
    expect(win?.cells).toEqual([[3, 4], [2, 5], [1, 6], [0, 7]]);
  });

  it('reports lines longer than four', () => {
    const grid = gridFromMoves([0, 0, 1, 1, 3, 3, 4, 4, 2]);
    expect(winningLineThrough(grid, 0, 2)).toHaveLength(5);
  });

  it('does not report three in a row', () => {
    expect(findWinner(gridFromMoves([0, 7, 1, 7, 2]))).toBeNull();
    expect(winningLineThrough(emptyGrid(), 0, 0)).toBeNull();
  });
});

describe('outcome', () => {
  it('reports the next player while playing', () => {
    expect(outcome(emptyGrid())).toEqual({ status: 'playing', next: 1 });
    expect(outcome(gridFromMoves([3]))).toEqual({ status: 'playing', next: 2 });
    expect(playerToMove(gridFromMoves([3, 4]))).toBe(1);
  });

  it('detects a draw when the 56 cells are full without a winner', () => {
    const grid = fullDrawGrid();
    expect(countPieces(grid)).toBe(56);
    expect(findWinner(grid)).toBeNull();
    expect(outcome(grid)).toEqual({ status: 'draw' });
  });

  it('reports a win', () => {
    const result = outcome(gridFromMoves([7, 6, 7, 6, 7, 6, 7]));
    expect(result.status).toBe('won');
  });
});

describe('gridFromMoves', () => {
  it('rejects moves after the game ended', () => {
    expect(() => gridFromMoves([7, 6, 7, 6, 7, 6, 7, 0])).toThrow(/final/);
  });

  it('rejects illegal moves', () => {
    expect(() => gridFromMoves([0, 0, 0, 0, 0, 0, 0, 0])).toThrow(/llena/);
  });
});

describe('isValidGrid', () => {
  it('accepts well-formed boards', () => {
    expect(isValidGrid(emptyGrid())).toBe(true);
    expect(isValidGrid(gridFromMoves([3, 3, 4]))).toBe(true);
  });

  it('rejects wrong shapes, values and floating pieces', () => {
    expect(isValidGrid(null)).toBe(false);
    expect(isValidGrid(emptyGrid().slice(1))).toBe(false);
    const wrongWidth = emptyGrid().map((r) => r.slice(1));
    expect(isValidGrid(wrongWidth)).toBe(false);
    const badValue = emptyGrid() as unknown as number[][];
    badValue[0][0] = 3;
    expect(isValidGrid(badValue)).toBe(false);
    const floating = emptyGrid();
    floating[2][4] = 1;
    expect(isValidGrid(floating)).toBe(false);
  });
});

it('opponent swaps players', () => {
  expect(opponent(1)).toBe(2);
  expect(opponent(2)).toBe(1);
});
