/**
 * Public API of the engine. Pure TypeScript: no I/O, no Node APIs.
 *
 *   const engine = new Engine();
 *   const { column } = engine.search(grid, toMove, { timeMs: 1500 });
 */

import { Board } from './bitboard.ts';
import { DEFAULT_WEIGHTS, type EvalWeights } from './evaluate.ts';
import { isValidGrid, type Grid, type Player } from './rules.ts';
import { MATE_BOUND, Searcher, WIN_SCORE, type SearchOptions, type SearchResult } from './search.ts';

export type { SearchOptions, SearchResult } from './search.ts';
export type { EvalWeights } from './evaluate.ts';
export { WIN_SCORE, MATE_BOUND, DEFAULT_WEIGHTS };

export interface EngineOptions {
  /** log2 of the transposition table size (default 22 ≈ 4M entries ≈ 50 MB). */
  ttBits?: number;
  /** Evaluation weights (for A/B testing in self-play). */
  weights?: EvalWeights;
}

export class Engine {
  private readonly searcher: Searcher;

  constructor(opts: EngineOptions = {}) {
    this.searcher = new Searcher({ ttBits: opts.ttBits, weights: opts.weights });
  }

  /**
   * Chooses a column for `toMove`. Always returns a legal column if one exists.
   * Throws RangeError if the grid is invalid or full.
   */
  search(grid: Grid, toMove: Player, opts: SearchOptions): SearchResult {
    if (!isValidGrid(grid)) throw new RangeError('Tablero inválido');
    if (toMove !== 1 && toMove !== 2) throw new RangeError('Jugador inválido');
    const board = Board.fromGrid(grid, toMove);
    return this.searcher.search(board, opts);
  }

  /** Forgets everything learned in the previous game. */
  newGame(): void {
    this.searcher.newGame();
  }
}
