/**
 * Pure game state for the web app (human vs bot).
 *
 * The app owns the game: the server is stateless and only answers "which column would
 * you play from this position?". Every bot request carries an id; responses whose id
 * no longer matches the pending request (after undo / restart) are discarded.
 */
import {
  dropPiece,
  emptyGrid,
  isLegalMove,
  outcome,
  type Grid,
  type Outcome,
  type Player,
} from '../../../src/engine/rules.ts';

export type Level = 'facil' | 'medio' | 'dificil' | 'maximo';
export type Starter = 'human' | 'bot';

export const LEVELS: ReadonlyArray<{ id: Level; label: string }> = [
  { id: 'facil', label: 'Fácil' },
  { id: 'medio', label: 'Medio' },
  { id: 'dificil', label: 'Difícil' },
  { id: 'maximo', label: 'Máximo' },
];

export interface BotInfo {
  column: number;
  score: number;
  depth: number;
  nodes: number;
  timeMs: number;
  pv: number[];
  source: string;
}

export type RejectReason = 'full' | 'not-your-turn' | 'game-over' | 'out-of-range';

export interface Rejection {
  column: number;
  reason: RejectReason;
  /** Increments on every rejection so the UI can replay the shake animation. */
  nonce: number;
}

export interface GameState {
  moves: number[];
  grid: Grid;
  outcome: Outcome;
  /** Board coordinates of the last piece dropped, or null. */
  lastMove: { row: number; col: number } | null;
  starter: Starter;
  /** Player number (1 opens) that the human controls. */
  human: Player;
  level: Level;
  /** Bot request in flight (or waiting to be sent). */
  pending: { id: number } | null;
  nextRequestId: number;
  error: string | null;
  insight: BotInfo | null;
  /** Bot info per ply index (sparse: only bot moves). */
  insights: Record<number, BotInfo>;
  rejection: Rejection | null;
}

export type GameAction =
  | { type: 'restart'; starter?: Starter; level?: Level }
  | { type: 'setLevel'; level: Level }
  | { type: 'humanMove'; column: number }
  | { type: 'botResponse'; requestId: number; info: BotInfo }
  | { type: 'botError'; requestId: number; message: string }
  | { type: 'retry' }
  | { type: 'undo' };

export function sideToMove(moves: readonly number[]): Player {
  return moves.length % 2 === 0 ? 1 : 2;
}

function replay(moves: readonly number[]): { grid: Grid; lastMove: GameState['lastMove'] } {
  let grid = emptyGrid();
  let lastMove: GameState['lastMove'] = null;
  moves.forEach((col, i) => {
    const res = dropPiece(grid, col, i % 2 === 0 ? 1 : 2);
    grid = res.grid;
    lastMove = { row: res.row, col };
  });
  return { grid, lastMove };
}

/** Builds a state for a given move list, scheduling a bot request if it is the bot's turn. */
function withMoves(base: GameState, moves: number[]): GameState {
  const { grid, lastMove } = replay(moves);
  const out = outcome(grid);
  const botTurn = out.status === 'playing' && sideToMove(moves) !== base.human;
  return {
    ...base,
    moves,
    grid,
    lastMove,
    outcome: out,
    pending: botTurn ? { id: base.nextRequestId } : null,
    nextRequestId: botTurn ? base.nextRequestId + 1 : base.nextRequestId,
    error: null,
  };
}

export function initialState(starter: Starter = 'human', level: Level = 'medio'): GameState {
  const base: GameState = {
    moves: [],
    grid: emptyGrid(),
    outcome: { status: 'playing', next: 1 },
    lastMove: null,
    starter,
    human: starter === 'human' ? 1 : 2,
    level,
    pending: null,
    nextRequestId: 1,
    error: null,
    insight: null,
    insights: {},
    rejection: null,
  };
  return withMoves(base, []);
}

export function isHumanTurn(state: GameState): boolean {
  return state.outcome.status === 'playing' && sideToMove(state.moves) === state.human && !state.pending;
}

export function canUndo(state: GameState): boolean {
  return state.moves.some((_, i) => (i % 2 === 0 ? 1 : 2) === state.human);
}

function reject(state: GameState, column: number, reason: RejectReason): GameState {
  return { ...state, rejection: { column, reason, nonce: (state.rejection?.nonce ?? 0) + 1 } };
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'restart': {
      const next = initialState(action.starter ?? state.starter, action.level ?? state.level);
      // Keep ids monotonic so a late answer from the previous game can never match.
      const shift = state.nextRequestId - 1;
      return {
        ...next,
        pending: next.pending ? { id: next.pending.id + shift } : null,
        nextRequestId: next.nextRequestId + shift,
        rejection: state.rejection,
      };
    }
    case 'setLevel':
      return { ...state, level: action.level };
    case 'humanMove': {
      const col = action.column;
      if (state.outcome.status !== 'playing') return reject(state, col, 'game-over');
      if (!Number.isInteger(col) || col < 0 || col >= state.grid[0].length) return reject(state, col, 'out-of-range');
      if (!isHumanTurn(state)) return reject(state, col, 'not-your-turn');
      if (!isLegalMove(state.grid, col)) return reject(state, col, 'full');
      return withMoves(state, [...state.moves, col]);
    }
    case 'botResponse': {
      if (!state.pending || state.pending.id !== action.requestId) return state; // stale
      const col = action.info.column;
      if (!isLegalMove(state.grid, col)) {
        return { ...state, pending: null, error: `El bot propuso una jugada inválida (columna ${col + 1}).` };
      }
      const ply = state.moves.length;
      const next = withMoves(state, [...state.moves, col]);
      return { ...next, insight: action.info, insights: { ...state.insights, [ply]: action.info } };
    }
    case 'botError':
      if (!state.pending || state.pending.id !== action.requestId) return state;
      return { ...state, pending: null, error: action.message };
    case 'retry': {
      if (state.pending || state.outcome.status !== 'playing' || sideToMove(state.moves) === state.human) {
        return { ...state, error: null };
      }
      return { ...state, error: null, pending: { id: state.nextRequestId }, nextRequestId: state.nextRequestId + 1 };
    }
    case 'undo': {
      if (!canUndo(state)) return state;
      const moves = state.moves.slice();
      // Pop until a human move has been removed: the human is then to move again.
      while (moves.length > 0) {
        const ply = moves.length - 1;
        moves.pop();
        if ((ply % 2 === 0 ? 1 : 2) === state.human) break;
      }
      const insights: Record<number, BotInfo> = {};
      for (const [k, v] of Object.entries(state.insights)) if (Number(k) < moves.length) insights[Number(k)] = v;
      const lastBotPly = Math.max(-1, ...Object.keys(insights).map(Number));
      const next = withMoves({ ...state, insights }, moves);
      return { ...next, insight: lastBotPly >= 0 ? insights[lastBotPly] : null };
    }
  }
}
