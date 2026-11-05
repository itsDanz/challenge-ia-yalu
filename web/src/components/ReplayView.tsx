import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { Player } from '../../../src/engine/rules.ts';
import { getReplay } from '../api.ts';
import { frameAt, parseReplay, reasonLabel, type ReplayRecord } from '../logic/replay.ts';
import { Board, type PieceColor } from './Board.tsx';
import { MoveHistory } from './MoveHistory.tsx';

const COLOR: Record<Player, PieceColor> = { 1: 'coral', 2: 'amber' };
const PLAY_INTERVAL_MS = 700;

export function ReplayView() {
  const [gameId, setGameId] = useState('');
  const [record, setRecord] = useState<ReplayRecord | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const total = record?.columns.length ?? 0;

  useEffect(() => {
    if (!playing) return;
    if (step >= total) {
      setPlaying(false);
      return;
    }
    const t = setTimeout(() => setStep((s) => Math.min(s + 1, total)), PLAY_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [playing, step, total]);

  useEffect(() => {
    if (!record) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === 'ArrowLeft') setStep((s) => Math.max(0, s - 1));
      else if (e.key === 'ArrowRight') setStep((s) => Math.min(total, s + 1));
      else return;
      setPlaying(false);
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [record, total]);

  const frame = useMemo(() => (record ? frameAt(record, step) : null), [record, step]);

  async function load(e: FormEvent) {
    e.preventDefault();
    const id = gameId.trim();
    if (!id) {
      setError('Escribe el identificador de la partida (game_id).');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setPlaying(false);
    try {
      const rec = parseReplay(await getReplay(id, controller.signal));
      setRecord(rec);
      setStep(0);
    } catch (err) {
      if (controller.signal.aborted) return;
      const status = (err as { status?: number }).status;
      setError(status === 404 ? `No existe una partida con id «${id}».` : err instanceof Error ? err.message : 'Error desconocido.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  const go = (s: number) => {
    setPlaying(false);
    setStep(Math.max(0, Math.min(total, s)));
  };

  let resultText = '';
  if (record) {
    if (record.status !== 'finished' && !record.reason) resultText = 'Partida en curso';
    else if (record.winner) resultText = `Ganó ${record.players[record.winner]}`;
    else resultText = 'Empate';
    const reason = reasonLabel(record.reason);
    if (reason && record.reason !== 'draw') resultText += ` · ${reason}`;
  }

  return (
    <div className="replay">
      <section className="card replay__side">
        <h2 className="card__title">Repetir partida del torneo</h2>
        <form className="replay__form" onSubmit={load}>
          <label htmlFor="game-id" className="field__label">
            Identificador de la partida (game_id)
          </label>
          <div className="replay__row">
            <input
              id="game-id"
              className="input"
              value={gameId}
              onChange={(e) => setGameId(e.target.value)}
              placeholder="p. ej. g_0123"
              autoComplete="off"
              spellCheck={false}
              data-testid="replay-input"
            />
            <button type="submit" className="btn btn--primary" disabled={loading} data-testid="replay-load">
              {loading ? 'Cargando…' : 'Cargar'}
            </button>
          </div>
        </form>
        {error && (
          <p className="notice notice--error" role="alert" data-testid="replay-error">
            {error}
          </p>
        )}
        {record && (
          <div className="replay__meta" data-testid="replay-meta">
            <p className="replay__player">
              <span className="dot dot--coral" aria-hidden="true" /> {record.players[1]} <span className="muted small">(abre)</span>
            </p>
            <p className="replay__player">
              <span className="dot dot--amber" aria-hidden="true" /> {record.players[2]}
            </p>
            <p className="replay__result">{resultText}</p>
          </div>
        )}
        {record && (
          <MoveHistory
            entries={record.columns.map((column, i) => ({
              name: record.players[(i % 2 === 0 ? 1 : 2) as Player],
              color: COLOR[(i % 2 === 0 ? 1 : 2) as Player],
              column,
            }))}
            current={step}
          />
        )}
      </section>

      <section className="replay__main" aria-label="Tablero de la repetición">
        {record && frame ? (
          <>
            <p className="status status--plain" aria-live="polite" data-testid="replay-step">
              Jugada <strong>{step}</strong> de {total}
            </p>
            <Board
              grid={frame.grid}
              lastMove={frame.lastMove}
              winningCells={step === total ? frame.winningCells : []}
              colorOf={(p) => COLOR[p]}
              nameOf={(p) => record.players[p]}
              label={`Repetición: jugada ${step} de ${total}`}
            />
            <div className="player-controls" role="toolbar" aria-label="Controles de la repetición">
              <button type="button" className="btn btn--icon" onClick={() => go(0)} disabled={step === 0} aria-label="Primera jugada">
                «
              </button>
              <button type="button" className="btn btn--icon" onClick={() => go(step - 1)} disabled={step === 0} aria-label="Jugada anterior" data-testid="replay-prev">
                ‹
              </button>
              <button
                type="button"
                className="btn btn--primary btn--icon btn--wide"
                onClick={() => {
                  if (step >= total) setStep(0);
                  setPlaying((p) => !p);
                }}
                disabled={total === 0}
                aria-label={playing ? 'Pausar' : 'Reproducir'}
                data-testid="replay-play"
              >
                {playing ? 'Pausa' : step >= total ? 'Repetir' : 'Reproducir'}
              </button>
              <button type="button" className="btn btn--icon" onClick={() => go(step + 1)} disabled={step >= total} aria-label="Jugada siguiente" data-testid="replay-next">
                ›
              </button>
              <button type="button" className="btn btn--icon" onClick={() => go(total)} disabled={step >= total} aria-label="Última jugada">
                »
              </button>
            </div>
            <input
              type="range"
              className="scrubber"
              min={0}
              max={total}
              value={step}
              onChange={(e) => go(Number(e.target.value))}
              aria-label="Posición en la partida"
            />
            <p className="muted small center">Usa las flechas ← → del teclado para avanzar o retroceder.</p>
          </>
        ) : (
          <div className="empty" data-testid="replay-empty">
            <div className="empty__icon" aria-hidden="true">
              <span className="dot dot--coral" />
              <span className="dot dot--amber" />
              <span className="dot dot--coral" />
              <span className="dot dot--amber" />
            </div>
            <p>Escribe el <strong>game_id</strong> de una partida del torneo y pulsa <strong>Cargar</strong> para verla jugada a jugada.</p>
          </div>
        )}
      </section>
    </div>
  );
}
