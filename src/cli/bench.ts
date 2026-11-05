/**
 * Benchmark: depth reached, nodes and nodes/second on a few standard positions.
 *
 *   node src/cli/bench.ts [timeMs=1500]
 */

import { Engine } from '../engine/index.ts';
import { dropPiece, emptyGrid, gridFromMoves, legalMoves, outcome, type Grid, type Player } from '../engine/rules.ts';

const timeMs = Number(process.argv[2] ?? 1500);

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded random game of `plies` moves that is still 'playing' and not tactically forced. */
function randomPosition(seed: number, plies: number): number[] {
  const random = rng(seed);
  const probe = new Engine({ ttBits: 12 });
  for (;;) {
    const moves: number[] = [];
    let grid: Grid = emptyGrid();
    let player: Player = 1;
    let ok = true;
    for (let i = 0; i < plies; i++) {
      const legal = legalMoves(grid);
      const c = legal[Math.floor(random() * legal.length)];
      moves.push(c);
      grid = dropPiece(grid, c, player).grid;
      player = player === 1 ? 2 : 1;
      if (outcome(grid).status !== 'playing') { ok = false; break; }
    }
    if (ok && probe.search(grid, player, { timeMs: 1, maxDepth: 1 }).source !== 'forced') return moves;
  }
}

const positions: Array<[string, number[]]> = [
  ['apertura (vacío)', []],
  ['apertura (3 jugadas)', [3, 4, 3]],
  ['medio juego (12 fichas)', randomPosition(7, 12)],
  ['medio juego (20 fichas)', randomPosition(11, 20)],
  ['final (32 fichas)', randomPosition(5, 32)],
];

const engine = new Engine();
console.log(`Presupuesto: ${timeMs} ms por posición\n`);
console.log('posición'.padEnd(24), 'col', 'prof', 'nodos'.padStart(10), 'ms'.padStart(7), 'nodos/s'.padStart(10), 'puntaje');
for (const [name, moves] of positions) {
  const grid = gridFromMoves(moves);
  const toMove = moves.length % 2 === 0 ? 1 : 2;
  engine.newGame();
  const r = engine.search(grid, toMove, { timeMs });
  const nps = r.timeMs > 0 ? Math.round((r.nodes / r.timeMs) * 1000) : 0;
  console.log(
    name.padEnd(24),
    String(r.column).padStart(3),
    String(r.depth).padStart(4),
    String(r.nodes).padStart(10),
    r.timeMs.toFixed(0).padStart(7),
    String(nps).padStart(10),
    String(r.score).padStart(7),
    r.source,
    'pv=' + r.pv.join(''),
  );
}
