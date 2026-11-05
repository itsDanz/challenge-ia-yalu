/**
 * Difficulty levels of the web app. Shared by the bot server (src/api/server.ts) and the
 * in-browser engine (web/src/engine.worker.ts) so both play exactly the same way.
 * "maximo" is the tournament configuration.
 */
import type { SearchOptions } from './search.ts';

export type Level = 'facil' | 'medio' | 'dificil' | 'maximo';

export const LEVELS: Record<Level, SearchOptions> = {
  facil: { timeMs: 150, maxDepth: 2, randomness: 0.35 },
  medio: { timeMs: 400, maxDepth: 6 },
  dificil: { timeMs: 1000 },
  maximo: { timeMs: 1500 },
};

export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && Object.hasOwn(LEVELS, value);
}
