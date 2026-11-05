import { useEffect, useRef } from 'react';
import type { PieceColor } from './Board.tsx';

export interface HistoryEntry {
  name: string;
  color: PieceColor;
  column: number;
}

export function MoveHistory({ entries, current }: { entries: HistoryEntry[]; current?: number }) {
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el && current === undefined) el.scrollTop = el.scrollHeight;
  }, [entries.length, current]);

  return (
    <section className="card history" aria-label="Historial de jugadas" data-testid="move-history">
      <h2 className="card__title">
        Historial <span className="muted small">({entries.length})</span>
      </h2>
      {entries.length === 0 ? (
        <p className="muted">Todavía no hay jugadas.</p>
      ) : (
        <ol className="history__list" ref={listRef}>
          {entries.map((e, i) => (
            <li key={i} className={current !== undefined && i === current - 1 ? 'is-current' : undefined}>
              <span className="history__n">{i + 1}.</span>
              <span className={`dot dot--${e.color}`} aria-hidden="true" />
              <span className="history__who">{e.name}</span>
              <span className="history__col">col. {e.column + 1}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
