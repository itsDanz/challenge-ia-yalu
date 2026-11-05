/** Presentation helpers for bot search statistics. Pure and unit-tested. */

/** Score magnitude used by the engine for a won position (assumed; read defensively). */
export const WIN_SCORE = 100_000;
const MATE_THRESHOLD = WIN_SCORE - 100;

export function formatNodes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)} mil`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)} M`;
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  return `${(ms / 1_000).toFixed(2)} s`;
}

export interface Evaluation {
  /** 0..1 share of the bar that belongs to the bot. 0.5 = balanced. */
  botShare: number;
  text: string;
  kind: 'bot-wins' | 'bot-loses' | 'bot-better' | 'human-better' | 'even';
}

/** Interprets a score given from the bot's perspective. */
export function evaluate(score: number): Evaluation {
  if (!Number.isFinite(score)) return { botShare: 0.5, text: 'Sin evaluación', kind: 'even' };
  if (Math.abs(score) >= MATE_THRESHOLD) {
    const plies = WIN_SCORE - Math.abs(score);
    const suffix = plies > 0 && plies < 100 ? ` en ${plies} ${plies === 1 ? 'jugada' : 'jugadas'}` : '';
    return score > 0
      ? { botShare: 1, text: `El bot ve victoria forzada${suffix}`, kind: 'bot-wins' }
      : { botShare: 0, text: `El bot ve derrota forzada${suffix}`, kind: 'bot-loses' };
  }
  const botShare = 0.5 + 0.5 * Math.tanh(score / 400);
  if (Math.abs(score) < 30) return { botShare, text: 'Posición equilibrada', kind: 'even' };
  return score > 0
    ? { botShare, text: 'Ventaja para el bot', kind: 'bot-better' }
    : { botShare, text: 'Ventaja para ti', kind: 'human-better' };
}

export function sourceLabel(source: string): string {
  switch (source) {
    case 'book':
      return 'Libro de aperturas';
    case 'forced':
      return 'Jugada forzada';
    case 'search':
      return 'Búsqueda';
    default:
      return source || '—';
  }
}
