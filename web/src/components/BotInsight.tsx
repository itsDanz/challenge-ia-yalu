import type { BotInfo } from '../logic/game.ts';
import { evaluate, formatMs, formatNodes, sourceLabel } from '../logic/format.ts';

export function BotInsight({ info, thinking }: { info: BotInfo | null; thinking: boolean }) {
  const ev = info ? evaluate(info.score) : null;
  const humanPct = ev ? Math.round((1 - ev.botShare) * 100) : 50;
  return (
    <section className={`card insight${thinking ? ' is-thinking' : ''}`} aria-label="¿Qué piensa el bot?" data-testid="bot-insight">
      <h2 className="card__title">¿Qué piensa el bot?</h2>
      {!info ? (
        <p className="muted">{thinking ? 'Analizando la posición…' : 'Aquí verás el análisis del bot después de su primera jugada.'}</p>
      ) : (
        <>
          <dl className="stats">
            <div>
              <dt>Profundidad</dt>
              <dd>{info.depth}</dd>
            </div>
            <div>
              <dt>Nodos</dt>
              <dd>{formatNodes(info.nodes)}</dd>
            </div>
            <div>
              <dt>Tiempo</dt>
              <dd>{formatMs(info.timeMs)}</dd>
            </div>
          </dl>
          <div
            className="evalbar"
            role="meter"
            aria-label="Ventaja"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={humanPct}
            aria-valuetext={ev!.text}
          >
            <div className="evalbar__human" style={{ width: `${humanPct}%` }} />
            <span className="evalbar__mid" aria-hidden="true" />
          </div>
          <div className="evalbar__legend" aria-hidden="true">
            <span>Tú</span>
            <span>Bot</span>
          </div>
          <p className={`eval-text eval-text--${ev!.kind}`} data-testid="eval-text">
            {ev!.text}
          </p>
          <p className="muted small">
            Origen: {sourceLabel(info.source)} · jugó la columna {info.column + 1}
            {info.pv.length > 1 && <> · línea prevista: {info.pv.slice(0, 6).map((c) => c + 1).join(' → ')}</>}
          </p>
        </>
      )}
    </section>
  );
}
