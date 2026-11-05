/**
 * Fast bitboard for the 8×7 board (Pascal Pons layout, adapted).
 *
 * Bit index = col * 8 + row (row 0 = bottom, row 7 = sentinel, always 0).
 * 64 bits split into two int32 words: `lo` = columns 0-3, `hi` = columns 4-7.
 * A position is (pos, mask): `pos` = stones of the side to move, `mask` = all stones.
 *
 * Shifts: vertical 1, horizontal 8, diagonal ↗ 9 (col+1,row+1), diagonal ↘ 7 (col+1,row-1).
 * All shifts are < 32, so a 64-bit shift is two word ops plus a carry between words.
 *
 * Two-word results are returned through the scratch array `R` (R[0] = lo, R[1] = hi)
 * to avoid allocating objects in the hot path.
 */

import type { Grid, Player } from './rules.ts';

export const COLS = 8;
export const ROWS = 7;
export const TOTAL_CELLS = COLS * ROWS;

/** Cells rows 0..6 of every column. Same pattern in both words. */
export const BOARD_LO = 0x7f7f7f7f | 0;
export const BOARD_HI = 0x7f7f7f7f | 0;
/** Row 0 of every column. */
export const BOTTOM_LO = 0x01010101 | 0;
export const BOTTOM_HI = 0x01010101 | 0;

/** Column masks (rows 0..6) — index by column; one of the words is always 0. */
export const COL_LO = new Int32Array(8);
export const COL_HI = new Int32Array(8);
for (let c = 0; c < 4; c++) COL_LO[c] = 0x7f << (c * 8);
for (let c = 4; c < 8; c++) COL_HI[c] = 0x7f << ((c - 4) * 8);

/** Row masks (all columns) — index by row 0..6. Same value for both words. */
export const ROW_MASK = new Int32Array(7);
for (let r = 0; r < 7; r++) ROW_MASK[r] = 0x01010101 << r;

/** Scratch output for two-word functions. */
export const R = new Int32Array(2);

export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return Math.imul(x, 0x01010101) >>> 24;
}

export function popcount64(lo: number, hi: number): number {
  return popcount32(lo) + popcount32(hi);
}

// --- 64-bit shifts over two words (0 < n < 32) --------------------------------------

function shlLo(lo: number, n: number): number {
  return lo << n;
}
function shlHi(lo: number, hi: number, n: number): number {
  return (hi << n) | (lo >>> (32 - n));
}
function shrLo(lo: number, hi: number, n: number): number {
  return (lo >>> n) | (hi << (32 - n));
}
function shrHi(hi: number, n: number): number {
  return hi >>> n;
}

/** True if `pos` (one player's stones) contains four in a line. */
export function hasWon(pLo: number, pHi: number): boolean {
  return (
    aligned(pLo, pHi, 1) || aligned(pLo, pHi, 8) || aligned(pLo, pHi, 7) || aligned(pLo, pHi, 9)
  );
}

function aligned(pLo: number, pHi: number, s: number): boolean {
  const mLo = pLo & shrLo(pLo, pHi, s);
  const mHi = pHi & shrHi(pHi, s);
  const s2 = s * 2;
  return ((mLo & shrLo(mLo, mHi, s2)) | (mHi & shrHi(mHi, s2))) !== 0;
}

/**
 * Cells where `pos` would complete four in a line and that are empty
 * (not necessarily playable now). Result in R[0], R[1].
 */
export function winningPositions(pLo: number, pHi: number, mLo: number, mHi: number): void {
  // vertical: three stones directly below
  let rLo = shlLo(pLo, 1) & shlLo(pLo, 2) & shlLo(pLo, 3);
  let rHi = shlHi(pLo, pHi, 1) & shlHi(pLo, pHi, 2) & shlHi(pLo, pHi, 3);

  // horizontal (8), diagonals (7, 9)
  for (let d = 0; d < 3; d++) {
    const s = d === 0 ? 8 : d === 1 ? 7 : 9;
    const l1 = shlLo(pLo, s), h1 = shlHi(pLo, pHi, s);
    const l2 = shlLo(pLo, 2 * s), h2 = shlHi(pLo, pHi, 2 * s);
    const l3 = shlLo(pLo, 3 * s), h3 = shlHi(pLo, pHi, 3 * s);
    const rl1 = shrLo(pLo, pHi, s), rh1 = shrHi(pHi, s);
    const rl2 = shrLo(pLo, pHi, 2 * s), rh2 = shrHi(pHi, 2 * s);
    const rl3 = shrLo(pLo, pHi, 3 * s), rh3 = shrHi(pHi, 3 * s);

    let pl = l1 & l2, ph = h1 & h2;
    rLo |= pl & l3; rHi |= ph & h3; // X X X _
    rLo |= pl & rl1; rHi |= ph & rh1; // X X _ X
    pl = rl1 & rl2; ph = rh1 & rh2;
    rLo |= pl & l1; rHi |= ph & h1; // X _ X X
    rLo |= pl & rl3; rHi |= ph & rh3; // _ X X X
  }
  R[0] = rLo & BOARD_LO & ~mLo;
  R[1] = rHi & BOARD_HI & ~mHi;
}

/** Cells that can be played now (lowest empty of each non-full column). Result in R. */
export function possibleMoves(mLo: number, mHi: number): void {
  R[0] = ((mLo + BOTTOM_LO) | 0) & BOARD_LO;
  R[1] = ((mHi + BOTTOM_HI) | 0) & BOARD_HI;
}

/** True if the side to move can win by playing now. */
export function canWinNow(pLo: number, pHi: number, mLo: number, mHi: number): boolean {
  winningPositions(pLo, pHi, mLo, mHi);
  const wLo = R[0], wHi = R[1];
  possibleMoves(mLo, mHi);
  return ((wLo & R[0]) | (wHi & R[1])) !== 0;
}

/** Column (0..7) of the lowest set bit in (lo, hi); -1 if empty. */
export function bitColumn(lo: number, hi: number): number {
  if (lo !== 0) return (31 - Math.clz32(lo & -lo)) >> 3;
  if (hi !== 0) return 4 + ((31 - Math.clz32(hi & -hi)) >> 3);
  return -1;
}

/** Row (0..6) of the lowest set bit in (lo, hi); -1 if empty. */
export function bitRow(lo: number, hi: number): number {
  if (lo !== 0) return (31 - Math.clz32(lo & -lo)) & 7;
  if (hi !== 0) return (31 - Math.clz32(hi & -hi)) & 7;
  return -1;
}

/** Position key (unique for a position; Pons: pos + mask). Carries never cross columns. */
export function keyLo(pLo: number, mLo: number): number {
  return (pLo + mLo) | 0;
}
export function keyHi(pHi: number, mHi: number): number {
  return (pHi + mHi) | 0;
}

/** Mutable board used by tests, CLI tools and the public API. The search uses raw words. */
export class Board {
  /** stones of the side to move */
  pLo = 0;
  pHi = 0;
  /** all stones */
  mLo = 0;
  mHi = 0;
  /** stones played */
  moves = 0;

  static fromGrid(grid: Grid, toMove: Player): Board {
    const b = new Board();
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        const cell = grid[r][c];
        if (cell === 0) break;
        const bit = 1 << ((c & 3) * 8 + r);
        if (c < 4) {
          b.mLo |= bit;
          if (cell === toMove) b.pLo |= bit;
        } else {
          b.mHi |= bit;
          if (cell === toMove) b.pHi |= bit;
        }
        b.moves++;
      }
    }
    return b;
  }

  clone(): Board {
    const b = new Board();
    b.pLo = this.pLo; b.pHi = this.pHi; b.mLo = this.mLo; b.mHi = this.mHi; b.moves = this.moves;
    return b;
  }

  canPlay(col: number): boolean {
    if (col < 0 || col >= COLS) return false;
    const top = 1 << ((col & 3) * 8 + ROWS - 1);
    return col < 4 ? (this.mLo & top) === 0 : (this.mHi & top) === 0;
  }

  legalMoves(): number[] {
    const out: number[] = [];
    for (let c = 0; c < COLS; c++) if (this.canPlay(c)) out.push(c);
    return out;
  }

  /** Plays in `col` for the side to move and switches sides. Caller checks legality. */
  play(col: number): void {
    const add = 1 << ((col & 3) * 8);
    this.pLo ^= this.mLo;
    this.pHi ^= this.mHi;
    if (col < 4) this.mLo = (this.mLo | (this.mLo + add)) | 0;
    else this.mHi = (this.mHi | (this.mHi + add)) | 0;
    this.moves++;
  }

  /** True if the side that just moved (i.e. NOT the side to move) has four in a line. */
  lastMoverWon(): boolean {
    return hasWon(this.pLo ^ this.mLo, this.pHi ^ this.mHi);
  }

  /** True if the side to move can win immediately. */
  canWinNow(): boolean {
    return canWinNow(this.pLo, this.pHi, this.mLo, this.mHi);
  }

  /** Columns where the side to move wins immediately. */
  winningColumns(): number[] {
    winningPositions(this.pLo, this.pHi, this.mLo, this.mHi);
    const wLo = R[0], wHi = R[1];
    possibleMoves(this.mLo, this.mHi);
    const lo = wLo & R[0], hi = wHi & R[1];
    const out: number[] = [];
    for (let c = 0; c < COLS; c++) {
      if (c < 4 ? (lo & COL_LO[c]) !== 0 : (hi & COL_HI[c]) !== 0) out.push(c);
    }
    return out;
  }

  isFull(): boolean {
    return this.moves >= TOTAL_CELLS;
  }

  /** Grid in protocol convention, given who is to move. */
  toGrid(toMove: Player): Grid {
    const other: Player = toMove === 1 ? 2 : 1;
    const grid: Grid = [];
    for (let r = 0; r < ROWS; r++) grid.push(new Array(COLS).fill(0));
    for (let c = 0; c < COLS; c++) {
      for (let r = 0; r < ROWS; r++) {
        const bit = 1 << ((c & 3) * 8 + r);
        const m = c < 4 ? this.mLo : this.mHi;
        const p = c < 4 ? this.pLo : this.pHi;
        if ((m & bit) !== 0) grid[r][c] = (p & bit) !== 0 ? toMove : other;
      }
    }
    return grid;
  }
}
