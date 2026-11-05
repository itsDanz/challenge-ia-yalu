/** Parsing and stepping of arbiter game records (GET /api/replay/:gameId). Pure. */
import { dropPiece, emptyGrid, findWinner, type Coord, type Grid, type Player } from '../../../src/engine/rules.ts';

export interface ReplayRecord {
  gameId: string;
  status: string;
  players: { 1: string; 2: string };
  columns: number[];
  winner: Player | null;
  reason: string | null;
  winningCells: Coord[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function playerName(players: unknown, key: '1' | '2'): string {
  if (isObj(players) && isObj(players[key]) && typeof players[key].name === 'string') return players[key].name;
  return `Jugador ${key}`;
}

/** Validates an arbiter Game record. Throws an Error with a Spanish message if malformed. */
export function parseReplay(data: unknown): ReplayRecord {
  if (!isObj(data) || !Array.isArray(data.moves)) throw new Error('La respuesta no parece una partida válida.');
  const columns = data.moves.map((m) => (isObj(m) ? m.column : m));
  if (!columns.every((c) => Number.isInteger(c))) throw new Error('La partida contiene jugadas mal formadas.');
  const result = isObj(data.result) ? data.result : null;
  const winner = result && (result.winner === 1 || result.winner === 2) ? (result.winner as Player) : null;
  const cells = result && Array.isArray(result.winning_cells) ? result.winning_cells : [];
  return {
    gameId: String(data.game_id ?? ''),
    status: String(data.status ?? ''),
    players: { 1: playerName(data.players, '1'), 2: playerName(data.players, '2') },
    columns: columns as number[],
    winner,
    reason: result && typeof result.reason === 'string' ? result.reason : null,
    winningCells: cells.filter(
      (c): c is Coord => Array.isArray(c) && c.length === 2 && Number.isInteger(c[0]) && Number.isInteger(c[1]),
    ),
  };
}

export interface ReplayFrame {
  grid: Grid;
  lastMove: { row: number; col: number } | null;
  winningCells: Coord[];
  /** Number of moves actually applied (stops at the first illegal one). */
  applied: number;
}

/** Board after the first `step` moves. Illegal moves (e.g. a forfeited game) stop the replay. */
export function frameAt(record: ReplayRecord, step: number): ReplayFrame {
  let grid = emptyGrid();
  let lastMove: ReplayFrame['lastMove'] = null;
  let applied = 0;
  const n = Math.max(0, Math.min(step, record.columns.length));
  for (let i = 0; i < n; i++) {
    try {
      const res = dropPiece(grid, record.columns[i], i % 2 === 0 ? 1 : 2);
      grid = res.grid;
      lastMove = { row: res.row, col: record.columns[i] };
      applied++;
    } catch {
      break;
    }
  }
  const win = findWinner(grid);
  const winningCells = win ? win.cells : step >= record.columns.length ? record.winningCells : [];
  return { grid, lastMove, winningCells, applied };
}

export function reasonLabel(reason: string | null): string {
  switch (reason) {
    case null:
      return '';
    case 'connect4':
      return 'cuatro en línea';
    case 'draw':
      return 'tablero lleno';
    case 'timeout':
      return 'tiempo agotado';
    case 'illegal_move':
      return 'jugada ilegal';
    case 'absent':
      return 'ausencia';
    case 'admin':
      return 'decisión del árbitro';
    default:
      return reason.replace(/_/g, ' ');
  }
}
