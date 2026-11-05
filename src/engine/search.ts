/**
 * Negamax + alpha-beta (PVS) + iterative deepening + transposition table over the bitboard.
 *
 * Scores are from the side-to-move's perspective. A win found at tree ply p scores
 * WIN_SCORE - p (faster wins are better, slower losses are better). Draw = 0.
 *
 * Every node first does Pons' tactical checks: immediate win, forced block, double threat
 * (loss), and never playing directly under an opponent's winning cell. Leaves use `evaluate`.
 */

import {
  BOARD_HI,
  BOARD_LO,
  BOTTOM_HI,
  BOTTOM_LO,
  Board,
  COL_HI,
  COL_LO,
  R,
  TOTAL_CELLS,
  bitColumn,
  keyHi,
  keyLo,
  popcount32,
  winningPositions,
} from './bitboard.ts';
import { DEFAULT_WEIGHTS, type EvalWeights, evaluate } from './evaluate.ts';
import { FLAG_EXACT, FLAG_LOWER, FLAG_UPPER, TranspositionTable } from './tt.ts';

export const WIN_SCORE = 10000;
/** |score| >= MATE_BOUND means a forced win/loss was found. */
export const MATE_BOUND = WIN_SCORE - 100;
const INF = 32000;
const MAX_PLY = 64;
/** Centre-first column order. */
export const ORDER = [3, 4, 2, 5, 1, 6, 0, 7];

export interface SearchOptions {
  timeMs: number;
  maxDepth?: number;
  /** 0..1, only for easy web levels: chance to play a random non-losing move */
  randomness?: number;
}

export interface SearchResult {
  column: number;
  score: number;
  depth: number;
  nodes: number;
  timeMs: number;
  pv: number[];
  source: 'search' | 'book' | 'forced';
}

export interface SearcherOptions {
  ttBits?: number;
  weights?: EvalWeights;
  /** Fraction of the budget after which no new iteration is started. */
  iterationCutoff?: number;
  /** Injectable clock (ms) for tests. */
  now?: () => number;
  /** Injectable RNG for `randomness`. */
  random?: () => number;
}

export class Searcher {
  readonly tt: TranspositionTable;
  weights: EvalWeights;
  readonly iterationCutoff: number;
  readonly now: () => number;
  readonly random: () => number;

  nodes = 0;
  aborted = false;
  deadline = 0;

  private readonly moveCols = new Int8Array(MAX_PLY * 8);
  private readonly moveScores = new Int32Array(MAX_PLY * 8);
  private readonly killers = new Int8Array(MAX_PLY * 2).fill(-1);
  private readonly history = new Int32Array(16);

  // root iteration bookkeeping
  private iterBestMove = -1;
  private iterBestScore = -INF;
  private iterCompleted = 0;

  constructor(opts: SearcherOptions = {}) {
    this.tt = new TranspositionTable(opts.ttBits ?? 22);
    this.weights = opts.weights ?? DEFAULT_WEIGHTS;
    this.iterationCutoff = opts.iterationCutoff ?? 0.45;
    this.now = opts.now ?? (() => performance.now());
    this.random = opts.random ?? Math.random;
  }

  newGame(): void {
    this.tt.clear();
    this.killers.fill(-1);
    this.history.fill(0);
  }

  /** Main entry point. `board` is the position with the side to move encoded in it. */
  search(board: Board, opts: SearchOptions): SearchResult {
    const start = this.now();
    const timeMs = Math.max(1, opts.timeMs);
    this.deadline = start + timeMs;
    this.nodes = 0;
    this.aborted = false;
    this.tt.age();
    this.history.fill(0);

    const legal = board.legalMoves();
    if (legal.length === 0) throw new RangeError('Tablero lleno: no hay jugadas legales');

    const pLo = board.pLo, pHi = board.pHi, mLo = board.mLo, mHi = board.mHi;
    const done = (column: number, score: number, source: SearchResult['source'], depth = 0, pv: number[] = [column]): SearchResult => ({
      column, score, depth, nodes: this.nodes, timeMs: this.now() - start, pv, source,
    });

    if (legal.length === 1) return done(legal[0], 0, 'forced');

    const possLo = ((mLo + BOTTOM_LO) | 0) & BOARD_LO;
    const possHi = ((mHi + BOTTOM_HI) | 0) & BOARD_HI;

    // Immediate win?
    winningPositions(pLo, pHi, mLo, mHi);
    const winLo = R[0] & possLo, winHi = R[1] & possHi;
    if ((winLo | winHi) !== 0) return done(bitColumn(winLo, winHi), WIN_SCORE, 'forced');

    // Opponent threats playable now: must block (or lost if more than one).
    const oLo = pLo ^ mLo, oHi = pHi ^ mHi;
    winningPositions(oLo, oHi, mLo, mHi);
    const opWLo = R[0], opWHi = R[1];
    const forcedLo = opWLo & possLo, forcedHi = opWHi & possHi;
    if ((forcedLo | forcedHi) !== 0) {
      const col = bitColumn(forcedLo, forcedHi);
      const n = popcount32(forcedLo) + popcount32(forcedHi);
      if (n > 1) return done(col, -(WIN_SCORE - 2), 'forced');
      // single forced block: still fine to answer instantly unless it is also a losing cell
      const belowLo = (opWLo >>> 1) | (opWHi << 31), belowHi = opWHi >>> 1;
      const losing = ((forcedLo & belowLo) | (forcedHi & belowHi)) !== 0;
      return done(col, losing ? -(WIN_SCORE - 2) : 0, 'forced');
    }

    // Non-losing moves: do not play right under an opponent's winning cell.
    const nlLo = possLo & ~((opWLo >>> 1) | (opWHi << 31));
    const nlHi = possHi & ~(opWHi >>> 1);
    const nonLosing: number[] = [];
    for (const c of ORDER) {
      if (c < 4 ? (nlLo & COL_LO[c]) !== 0 : (nlHi & COL_HI[c]) !== 0) nonLosing.push(c);
    }
    if (nonLosing.length === 0) {
      // Every move loses next turn: play the centre-most legal column and hope.
      const col = ORDER.find((c) => legal.includes(c)) as number;
      return done(col, -(WIN_SCORE - 2), 'forced');
    }
    if (nonLosing.length === 1) return done(nonLosing[0], 0, 'forced');

    if (opts.randomness && opts.randomness > 0 && this.random() < opts.randomness) {
      const col = nonLosing[Math.floor(this.random() * nonLosing.length)];
      return done(col, 0, 'search');
    }

    // Iterative deepening.
    const remaining = TOTAL_CELLS - board.moves;
    const maxDepth = Math.min(opts.maxDepth ?? MAX_PLY - 2, remaining, MAX_PLY - 2);
    let bestMove = nonLosing[0];
    let bestScore = 0;
    let bestDepth = 0;
    for (let depth = 1; depth <= maxDepth; depth++) {
      if (depth > 1 && this.now() - start > timeMs * this.iterationCutoff) break;
      const score = this.searchRoot(pLo, pHi, mLo, mHi, oLo, oHi, nlLo, nlHi, depth, bestMove);
      if (this.aborted) {
        if (this.iterCompleted >= 1 && this.iterBestMove >= 0) {
          bestMove = this.iterBestMove;
          bestScore = this.iterBestScore;
        }
        break;
      }
      bestMove = this.iterBestMove;
      bestScore = score;
      bestDepth = depth;
      if (bestScore >= MATE_BOUND || bestScore <= -MATE_BOUND) break;
    }
    return done(bestMove, bestScore, 'search', bestDepth, this.extractPv(board, bestMove, bestDepth));
  }

  private searchRoot(
    pLo: number, pHi: number, mLo: number, mHi: number,
    oLo: number, oHi: number, movesLo: number, movesHi: number,
    depth: number, firstMove: number,
  ): number {
    this.iterBestMove = -1;
    this.iterBestScore = -INF;
    this.iterCompleted = 0;
    const n = this.orderMoves(pLo, pHi, mLo, mHi, movesLo, movesHi, 0, firstMove);
    let alpha = -INF;
    const beta = INF;
    for (let i = 0; i < n; i++) {
      const c = this.moveCols[i];
      const bLo = c < 4 ? movesLo & COL_LO[c] : 0;
      const bHi = c >= 4 ? movesHi & COL_HI[c] : 0;
      const nmLo = mLo | bLo, nmHi = mHi | bHi;
      let s: number;
      if (i === 0) {
        s = -this.negamax(oLo, oHi, nmLo, nmHi, depth - 1, 1, -beta, -alpha);
      } else {
        s = -this.negamax(oLo, oHi, nmLo, nmHi, depth - 1, 1, -alpha - 1, -alpha);
        if (!this.aborted && s > alpha && s < beta) {
          s = -this.negamax(oLo, oHi, nmLo, nmHi, depth - 1, 1, -beta, -alpha);
        }
      }
      if (this.aborted) return 0;
      this.iterCompleted++;
      if (s > this.iterBestScore) {
        this.iterBestScore = s;
        this.iterBestMove = c;
        if (s > alpha) alpha = s;
      }
    }
    this.tt.store(keyLo(pLo, mLo), keyHi(pHi, mHi), this.toTT(this.iterBestScore, 0), depth, FLAG_EXACT, this.iterBestMove);
    return this.iterBestScore;
  }

  private toTT(score: number, ply: number): number {
    if (score >= MATE_BOUND) return score + ply;
    if (score <= -MATE_BOUND) return score - ply;
    return score;
  }

  private fromTT(score: number, ply: number): number {
    if (score >= MATE_BOUND) return score - ply;
    if (score <= -MATE_BOUND) return score + ply;
    return score;
  }

  /**
   * Fills moveCols[ply*8 ..] sorted best-first and returns the count.
   * Ranking: TT/first move, then number of winning cells created, killers, history, centre.
   */
  private orderMoves(
    pLo: number, pHi: number, mLo: number, mHi: number,
    movesLo: number, movesHi: number, ply: number, ttMove: number,
  ): number {
    const base = ply * 8;
    const cols = this.moveCols, scores = this.moveScores;
    const k0 = this.killers[ply * 2], k1 = this.killers[ply * 2 + 1];
    const side = (ply & 1) * 8;
    let n = 0;
    for (let i = 0; i < 8; i++) {
      const c = ORDER[i];
      const bLo = c < 4 ? movesLo & COL_LO[c] : 0;
      const bHi = c >= 4 ? movesHi & COL_HI[c] : 0;
      if ((bLo | bHi) === 0) continue;
      let s: number;
      if (c === ttMove) {
        s = 1 << 28;
      } else {
        winningPositions(pLo | bLo, pHi | bHi, mLo | bLo, mHi | bHi);
        s = (popcount32(R[0]) + popcount32(R[1])) * 4096 + (7 - i) * 8;
        if (c === k0 || c === k1) s += 2048;
        const h = this.history[side + c];
        s += h > 2000 ? 2000 : h;
      }
      // insertion sort (descending)
      let j = n;
      while (j > 0 && scores[base + j - 1] < s) {
        scores[base + j] = scores[base + j - 1];
        cols[base + j] = cols[base + j - 1];
        j--;
      }
      scores[base + j] = s;
      cols[base + j] = c;
      n++;
    }
    return n;
  }

  private negamax(
    pLo: number, pHi: number, mLo: number, mHi: number,
    depth: number, ply: number, alpha: number, beta: number,
  ): number {
    this.nodes++;
    if ((this.nodes & 1023) === 0 && this.now() >= this.deadline) {
      this.aborted = true;
      return 0;
    }

    const possLo = ((mLo + BOTTOM_LO) | 0) & BOARD_LO;
    const possHi = ((mHi + BOTTOM_HI) | 0) & BOARD_HI;
    if ((possLo | possHi) === 0) return 0; // board full: draw

    winningPositions(pLo, pHi, mLo, mHi);
    if (((R[0] & possLo) | (R[1] & possHi)) !== 0) return WIN_SCORE - ply;

    const oLo = pLo ^ mLo, oHi = pHi ^ mHi;
    winningPositions(oLo, oHi, mLo, mHi);
    const opWLo = R[0], opWHi = R[1];
    const forcedLo = opWLo & possLo, forcedHi = opWHi & possHi;
    let movesLo: number, movesHi: number;
    let forced = false;
    if ((forcedLo | forcedHi) !== 0) {
      if (popcount32(forcedLo) + popcount32(forcedHi) > 1) return -(WIN_SCORE - ply - 1);
      movesLo = forcedLo;
      movesHi = forcedHi;
      forced = true;
    } else {
      movesLo = possLo;
      movesHi = possHi;
    }
    movesLo &= ~((opWLo >>> 1) | (opWHi << 31));
    movesHi &= ~(opWHi >>> 1);
    if ((movesLo | movesHi) === 0) return -(WIN_SCORE - ply - 1);

    // Mate-distance bounds: best case is a win two plies from now; worst a loss next ply.
    const upper = WIN_SCORE - ply - 2;
    if (beta > upper) {
      beta = upper;
      if (alpha >= beta) return beta;
    }
    const lower = -(WIN_SCORE - ply - 1);
    if (alpha < lower) {
      alpha = lower;
      if (alpha >= beta) return alpha;
    }

    if (depth <= 0 && !forced) return evaluate(pLo, pHi, mLo, mHi, this.weights);

    const kLo = keyLo(pLo, mLo), kHi = keyHi(pHi, mHi);
    let ttMove = -1;
    const tt = this.tt;
    if (tt.probe(kLo, kHi)) {
      ttMove = tt.hitMove;
      if (tt.hitDepth >= depth) {
        const s = this.fromTT(tt.hitScore, ply);
        const f = tt.hitFlag;
        if (f === FLAG_EXACT) return s;
        if (f === FLAG_LOWER) {
          if (s >= beta) return s;
          if (s > alpha) alpha = s;
        } else if (f === FLAG_UPPER) {
          if (s <= alpha) return s;
          if (s < beta) beta = s;
        }
      }
    }

    const childDepth = forced ? depth : depth - 1;
    const n = this.orderMoves(pLo, pHi, mLo, mHi, movesLo, movesHi, ply, ttMove);
    const base = ply * 8;
    const alphaOrig = alpha;
    let best = -INF;
    let bestMove = -1;
    for (let i = 0; i < n; i++) {
      const c = this.moveCols[base + i];
      const bLo = c < 4 ? movesLo & COL_LO[c] : 0;
      const bHi = c >= 4 ? movesHi & COL_HI[c] : 0;
      const nmLo = mLo | bLo, nmHi = mHi | bHi;
      let s: number;
      if (i === 0) {
        s = -this.negamax(oLo, oHi, nmLo, nmHi, childDepth, ply + 1, -beta, -alpha);
      } else {
        s = -this.negamax(oLo, oHi, nmLo, nmHi, childDepth, ply + 1, -alpha - 1, -alpha);
        if (!this.aborted && s > alpha && s < beta) {
          s = -this.negamax(oLo, oHi, nmLo, nmHi, childDepth, ply + 1, -beta, -alpha);
        }
      }
      if (this.aborted) return 0;
      if (s > best) {
        best = s;
        bestMove = c;
        if (s > alpha) {
          alpha = s;
          if (alpha >= beta) {
            const k = ply * 2;
            if (this.killers[k] !== c) {
              this.killers[k + 1] = this.killers[k];
              this.killers[k] = c;
            }
            this.history[(ply & 1) * 8 + c] += depth * depth;
            break;
          }
        }
      }
    }
    const flag = best <= alphaOrig ? FLAG_UPPER : best >= beta ? FLAG_LOWER : FLAG_EXACT;
    tt.store(kLo, kHi, this.toTT(best, ply), depth, flag, bestMove);
    return best;
  }

  /** Principal variation from the TT, starting with `firstMove`. */
  private extractPv(board: Board, firstMove: number, maxLen: number): number[] {
    const pv: number[] = [firstMove];
    const b = board.clone();
    b.play(firstMove);
    for (let i = 1; i < maxLen && i < 24; i++) {
      if (b.lastMoverWon() || b.isFull()) break;
      if (!this.tt.probe(keyLo(b.pLo, b.mLo), keyHi(b.pHi, b.mHi))) break;
      const m = this.tt.hitMove;
      if (m < 0 || !b.canPlay(m)) break;
      pv.push(m);
      b.play(m);
    }
    return pv;
  }
}
