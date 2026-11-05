import { useRef, type CSSProperties } from 'react';
import { COLS, ROWS, landingRow, type Coord, type Grid, type Player } from '../../../src/engine/rules.ts';

export type PieceColor = 'coral' | 'amber';

interface BoardProps {
  grid: Grid;
  lastMove: { row: number; col: number } | null;
  winningCells: Coord[];
  colorOf: (player: Player) => PieceColor;
  /** Names used in cell aria labels. */
  nameOf: (player: Player) => string;
  /** When set, columns are clickable and show a ghost piece of this color on hover. */
  ghost?: PieceColor | null;
  interactive?: boolean;
  /** Board locked (bot thinking / game over): columns stay focusable but show no ghost. */
  locked?: boolean;
  onColumn?: (col: number) => void;
  shakeCol?: number | null;
  label: string;
}

export function Board({
  grid,
  lastMove,
  winningCells,
  colorOf,
  nameOf,
  ghost = null,
  interactive = false,
  locked = false,
  onColumn,
  shakeCol = null,
  label,
}: BoardProps) {
  const count = grid.reduce((n, row) => n + row.filter((c) => c !== 0).length, 0);
  // Animate only pieces that were just added (not after undo or on replay step back).
  const prevCount = useRef(count);
  const animKey = useRef<string | null>(null);
  if (count !== prevCount.current) {
    animKey.current = count > prevCount.current && lastMove ? `${lastMove.row}-${lastMove.col}-${count}` : null;
    prevCount.current = count;
  }

  const winSet = new Set(winningCells.map(([r, c]) => `${r}-${c}`));
  const hasWin = winSet.size > 0;

  return (
    <div className={`board${hasWin ? ' board--won' : ''}${locked ? ' board--locked' : ''}`} role="group" aria-label={label} data-testid="board">
      <div className="board__grid">
        {Array.from({ length: COLS }, (_, col) => {
          const landing = landingRow(grid, col);
          const full = landing === -1;
          const free = full ? 0 : ROWS - landing;
          const cells = [];
          for (let row = ROWS - 1; row >= 0; row--) {
            const cell = grid[row][col];
            const key = `${row}-${col}`;
            const isLast = lastMove?.row === row && lastMove?.col === col;
            const drop = isLast && animKey.current === `${row}-${col}-${count}`;
            const style = { '--drop': ROWS - row } as CSSProperties;
            cells.push(
              <span className="cell" key={key} data-row={row} data-col={col}>
                {cell !== 0 && (
                  <span
                    className={[
                      'piece',
                      `piece--${colorOf(cell)}`,
                      drop && 'piece--drop',
                      isLast && 'piece--last',
                      hasWin && (winSet.has(key) ? 'piece--win' : 'piece--dim'),
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={style}
                    data-testid={winSet.has(key) ? 'win-piece' : undefined}
                  />
                )}
                {cell === 0 && row === landing && interactive && ghost && !locked && (
                  <span className={`piece piece--ghost piece--${ghost}`} aria-hidden="true" />
                )}
              </span>,
            );
          }
          const colLabel = full
            ? `Columna ${col + 1}, llena`
            : `Columna ${col + 1}, ${free} ${free === 1 ? 'espacio libre' : 'espacios libres'}`;
          const className = [
            'column',
            full && 'column--full',
            shakeCol === col && 'column--shake',
            interactive && !locked && !full && 'column--playable',
          ]
            .filter(Boolean)
            .join(' ');
          return interactive ? (
            <button
              type="button"
              key={col}
              className={className}
              aria-label={colLabel}
              aria-disabled={full || locked}
              onClick={() => onColumn?.(col)}
              data-testid={`column-${col}`}
            >
              {cells}
            </button>
          ) : (
            <div key={col} className={className} aria-label={colLabel} role="group">
              {cells}
            </div>
          );
        })}
      </div>
      <div className="board__labels" aria-hidden="true">
        {Array.from({ length: COLS }, (_, col) => (
          <span key={col}>{col + 1}</span>
        ))}
      </div>
      <p className="sr-only" aria-live="polite">
        {lastMove ? `Última jugada: ${nameOf(grid[lastMove.row][lastMove.col] as Player)} en la columna ${lastMove.col + 1}` : ''}
      </p>
    </div>
  );
}
