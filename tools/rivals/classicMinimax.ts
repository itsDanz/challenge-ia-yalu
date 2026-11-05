/**
 * "Typical rival": the classic minimax + alpha-beta with window scoring that most
 * tutorials and AI assistants produce (Keith Galli style), adapted to 8×7.
 * Used only to measure our engine against what other teams are likely to bring.
 * It is NOT part of the bot.
 */
import { COLS, ROWS, type Grid, type Player, legalMoves, landingRow, findWinner, opponent } from '../../src/engine/rules.ts';

const ORDER = [3, 4, 2, 5, 1, 6, 0, 7];

function scoreWindow(w: number[], me: Player): number {
  const opp = opponent(me);
  const mine = w.filter((c) => c === me).length;
  const theirs = w.filter((c) => c === opp).length;
  const empty = w.filter((c) => c === 0).length;
  if (mine === 4) return 100;
  if (mine === 3 && empty === 1) return 5;
  if (mine === 2 && empty === 2) return 2;
  if (theirs === 3 && empty === 1) return -4;
  return 0;
}

function evaluate(g: Grid, me: Player): number {
  let s = 0;
  for (let r = 0; r < ROWS; r++) {
    if (g[r][3] === me) s += 3;
    if (g[r][4] === me) s += 3;
  }
  for (let r = 0; r < ROWS; r++)
    for (let c = 0; c < COLS; c++) {
      if (c + 3 < COLS) s += scoreWindow([g[r][c], g[r][c + 1], g[r][c + 2], g[r][c + 3]], me);
      if (r + 3 < ROWS) s += scoreWindow([g[r][c], g[r + 1][c], g[r + 2][c], g[r + 3][c]], me);
      if (r + 3 < ROWS && c + 3 < COLS) s += scoreWindow([g[r][c], g[r + 1][c + 1], g[r + 2][c + 2], g[r + 3][c + 3]], me);
      if (r + 3 < ROWS && c - 3 >= 0) s += scoreWindow([g[r][c], g[r + 1][c - 1], g[r + 2][c - 2], g[r + 3][c - 3]], me);
    }
  return s;
}

function minimax(g: Grid, depth: number, alpha: number, beta: number, maximizing: boolean, me: Player, deadline: number): number {
  const win = findWinner(g);
  if (win) return win.winner === me ? 1e6 + depth : -1e6 - depth;
  const moves = ORDER.filter((c) => legalMoves(g).includes(c));
  if (moves.length === 0) return 0;
  if (depth === 0 || performance.now() > deadline) return evaluate(g, me);
  const p: Player = maximizing ? me : opponent(me);
  let best = maximizing ? -Infinity : Infinity;
  for (const c of moves) {
    const r = landingRow(g, c);
    g[r][c] = p;
    const v = minimax(g, depth - 1, alpha, beta, !maximizing, me, deadline);
    g[r][c] = 0;
    if (maximizing) {
      best = Math.max(best, v);
      alpha = Math.max(alpha, v);
    } else {
      best = Math.min(best, v);
      beta = Math.min(beta, v);
    }
    if (alpha >= beta) break;
  }
  return best;
}

/** Iterative deepening up to `timeMs`, like a careful rival team would do. */
export function classicMove(grid: Grid, me: Player, timeMs = 1500): { column: number; depth: number } {
  const g = grid.map((r) => r.slice()) as Grid;
  const start = performance.now();
  const deadline = start + timeMs;
  const moves = ORDER.filter((c) => legalMoves(g).includes(c));
  let bestCol = moves[0];
  let depth = 1;
  for (; depth <= 56; depth++) {
    let best = -Infinity;
    let col = moves[0];
    for (const c of moves) {
      const r = landingRow(g, c);
      g[r][c] = me;
      const v = minimax(g, depth - 1, -Infinity, Infinity, false, me, deadline);
      g[r][c] = 0;
      if (v > best) {
        best = v;
        col = c;
      }
    }
    if (performance.now() > deadline) break;
    bestCol = col;
    if (performance.now() - start > timeMs * 0.4) break;
  }
  return { column: bestCol, depth };
}
