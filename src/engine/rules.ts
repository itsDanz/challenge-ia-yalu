/**
 * Readable Connect-4 rules for the 8×7 board.
 *
 * Same convention as the arbiter protocol: `grid[row][col]`, row 0 is the bottom,
 * 0 = empty, 1 = player who opens, 2 = the other player.
 *
 * This module favours clarity over speed. It is used by the web app, by the arbiter
 * client to validate moves, and by the tests as the oracle for the fast bitboard engine.
 */

export const COLS = 8;
export const ROWS = 7;
export const CONNECT = 4;

export type Player = 1 | 2;
export type Cell = 0 | Player;
export type Grid = Cell[][];
/** [row, col] */
export type Coord = [number, number];

export type Outcome =
  | { status: 'playing'; next: Player }
  | { status: 'won'; winner: Player; cells: Coord[] }
  | { status: 'draw' };

const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, 1], // horizontal
  [1, 0], // vertical
  [1, 1], // diagonal ↗
  [1, -1], // diagonal ↖
];

export function emptyGrid(): Grid {
  return Array.from({ length: ROWS }, () => Array<Cell>(COLS).fill(0));
}

export function cloneGrid(grid: Grid): Grid {
  return grid.map((row) => row.slice());
}

export function opponent(player: Player): Player {
  return player === 1 ? 2 : 1;
}

export function isValidColumn(col: unknown): col is number {
  return Number.isInteger(col) && (col as number) >= 0 && (col as number) < COLS;
}

/** Lowest empty row of a column, or -1 if the column is full. */
export function landingRow(grid: Grid, col: number): number {
  for (let row = 0; row < ROWS; row++) {
    if (grid[row][col] === 0) return row;
  }
  return -1;
}

export function isLegalMove(grid: Grid, col: number): boolean {
  return isValidColumn(col) && landingRow(grid, col) !== -1;
}

export function legalMoves(grid: Grid): number[] {
  const moves: number[] = [];
  for (let col = 0; col < COLS; col++) if (grid[ROWS - 1][col] === 0) moves.push(col);
  return moves;
}

/** Returns a new grid with the piece dropped. Throws on illegal moves. */
export function dropPiece(grid: Grid, col: number, player: Player): { grid: Grid; row: number } {
  if (!isValidColumn(col)) throw new RangeError(`Columna fuera de rango: ${col}`);
  const row = landingRow(grid, col);
  if (row === -1) throw new RangeError(`Columna llena: ${col}`);
  const next = cloneGrid(grid);
  next[row][col] = player;
  return { grid: next, row };
}

function inside(row: number, col: number): boolean {
  return row >= 0 && row < ROWS && col >= 0 && col < COLS;
}

/** Winning line that passes through (row, col), or null. */
export function winningLineThrough(grid: Grid, row: number, col: number): Coord[] | null {
  const player = grid[row][col];
  if (player === 0) return null;
  for (const [dr, dc] of DIRECTIONS) {
    const line: Coord[] = [[row, col]];
    for (const sign of [1, -1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (inside(r, c) && grid[r][c] === player) {
        line.push([r, c]);
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (line.length >= CONNECT) return line.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  }
  return null;
}

/** First winning line found anywhere on the board, with its owner. */
export function findWinner(grid: Grid): { winner: Player; cells: Coord[] } | null {
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const cells = winningLineThrough(grid, row, col);
      if (cells) return { winner: grid[row][col] as Player, cells };
    }
  }
  return null;
}

export function isFull(grid: Grid): boolean {
  return legalMoves(grid).length === 0;
}

export function countPieces(grid: Grid): number {
  let n = 0;
  for (const row of grid) for (const cell of row) if (cell !== 0) n++;
  return n;
}

/** Whose turn it is, assuming player 1 opened. */
export function playerToMove(grid: Grid): Player {
  return countPieces(grid) % 2 === 0 ? 1 : 2;
}

export function outcome(grid: Grid): Outcome {
  const win = findWinner(grid);
  if (win) return { status: 'won', winner: win.winner, cells: win.cells };
  if (isFull(grid)) return { status: 'draw' };
  return { status: 'playing', next: playerToMove(grid) };
}

/**
 * Replays a list of columns from the empty board. Throws if a move is illegal or
 * if a move is played after the game already ended.
 */
export function gridFromMoves(moves: readonly number[]): Grid {
  let grid = emptyGrid();
  let player: Player = 1;
  for (let i = 0; i < moves.length; i++) {
    if (outcome(grid).status !== 'playing') throw new RangeError(`Jugada ${i + 1} después del final`);
    grid = dropPiece(grid, moves[i], player).grid;
    player = opponent(player);
  }
  return grid;
}

/** Validates the shape and contents of a grid received from outside. */
export function isValidGrid(value: unknown): value is Grid {
  if (!Array.isArray(value) || value.length !== ROWS) return false;
  for (let row = 0; row < ROWS; row++) {
    const r = value[row];
    if (!Array.isArray(r) || r.length !== COLS) return false;
    for (let col = 0; col < COLS; col++) {
      const cell = r[col];
      if (cell !== 0 && cell !== 1 && cell !== 2) return false;
      // No floating pieces: a non-empty cell needs support below it.
      if (cell !== 0 && row > 0 && value[row - 1][col] === 0) return false;
    }
  }
  return true;
}
