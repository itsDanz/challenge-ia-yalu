import type { Outcome, Player } from '../../../src/engine/rules.ts';
import type { PieceColor } from './Board.tsx';

interface StatusBarProps {
  outcome: Outcome;
  human: Player;
  humanColor: PieceColor;
  botColor: PieceColor;
  thinking: boolean;
  error: string | null;
  onRetry: () => void;
  onPlayAgain: () => void;
}

export function StatusBar({ outcome, human, humanColor, botColor, thinking, error, onRetry, onPlayAgain }: StatusBarProps) {
  if (outcome.status !== 'playing') {
    const kind = outcome.status === 'draw' ? 'draw' : outcome.winner === human ? 'win' : 'loss';
    const title = kind === 'win' ? '¡Ganaste!' : kind === 'loss' ? 'Ganó el bot' : 'Empate';
    const sub =
      kind === 'win'
        ? 'Conectaste cuatro. Bien jugado.'
        : kind === 'loss'
          ? 'El bot conectó cuatro. ¿Revancha?'
          : 'El tablero se llenó sin cuatro en línea.';
    return (
      <div className={`status status--result status--${kind}`} role="status" data-testid="result-banner">
        <div>
          <p className="status__title">{title}</p>
          <p className="status__sub">{sub}</p>
        </div>
        <button type="button" className="btn btn--primary" onClick={onPlayAgain} data-testid="play-again">
          Jugar otra vez
        </button>
      </div>
    );
  }

  if (error) {
    return (
      <div className="status status--error" role="alert" data-testid="bot-error">
        <div>
          <p className="status__title">No se pudo obtener la jugada del bot</p>
          <p className="status__sub">
            {error} Pulsa «Reintentar» cuando el servidor esté encendido.
          </p>
        </div>
        <button type="button" className="btn btn--primary" onClick={onRetry} data-testid="retry">
          Reintentar
        </button>
      </div>
    );
  }

  return (
    <div className="status" role="status" aria-live="polite" data-testid="turn-status">
      {thinking ? (
        <p className="status__turn">
          <span className={`dot dot--${botColor} dot--pulse`} aria-hidden="true" />
          El bot está pensando
          <span className="thinking-dots" aria-hidden="true">
            <span>.</span>
            <span>.</span>
            <span>.</span>
          </span>
        </p>
      ) : (
        <p className="status__turn">
          <span className={`dot dot--${humanColor}`} aria-hidden="true" />
          Tu turno: elige una columna
          <span className="status__hint"> (clic o teclas 1–8)</span>
        </p>
      )}
    </div>
  );
}
