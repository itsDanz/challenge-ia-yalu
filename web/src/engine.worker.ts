/**
 * Web Worker that runs the SAME engine as the tournament bot (src/engine), used when the app
 * is deployed as a static site (Vercel) without the Node bot server.
 */
import { Engine } from '../../src/engine/index.ts';
import { LEVELS, isLevel } from '../../src/engine/levels.ts';
import { gridFromMoves, outcome } from '../../src/engine/rules.ts';

// 2^20 TT entries (~13 MB) instead of 2^22: phones have less memory.
const engine = new Engine({ ttBits: 20 });

interface MoveRequest {
  id: number;
  moves: number[];
  level: string;
}

self.onmessage = (event: MessageEvent<MoveRequest>) => {
  const { id, moves, level } = event.data;
  try {
    if (!isLevel(level)) throw new Error(`Nivel inválido: ${level}`);
    const grid = gridFromMoves(moves);
    const state = outcome(grid);
    if (state.status !== 'playing') throw new Error('La partida ya terminó.');
    if (moves.length === 0) engine.newGame();
    const result = engine.search(grid, state.next, LEVELS[level]);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({ id, ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};
