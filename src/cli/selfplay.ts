/**
 * Self-play A/B: engine A vs engine B, alternating colours, random 2-ply openings.
 *
 *   node src/cli/selfplay.ts [games=20] [timeMs=200] [A=default] [B=default]
 *
 * A and B are weight presets (see PRESETS) or JSON overrides of EvalWeights, e.g.
 *   node src/cli/selfplay.ts 40 150 p1even p1odd
 *   node src/cli/selfplay.ts 40 150 default '{"stacked":0}'
 * Reports W/D/L from A's point of view, with a split by colour.
 */

import { DEFAULT_WEIGHTS, Engine, type EvalWeights } from '../engine/index.ts';
import { type Grid, type Player, dropPiece, emptyGrid, legalMoves, opponent, outcome } from '../engine/rules.ts';

const PRESETS: Record<string, Partial<EvalWeights>> = {
  default: {},
  p1even: { parityMode: 'p1even' },
  p1odd: { parityMode: 'p1odd' },
  noparity: { parityMode: 'off' },
  nostacked: { stacked: 0 },
  noopen2: { open2: 0 },
  nocenter: { center: 0 },
};

function parseWeights(spec: string): EvalWeights {
  const over = spec.startsWith('{') ? (JSON.parse(spec) as Partial<EvalWeights>) : PRESETS[spec];
  if (!over) throw new Error(`Preset desconocido: ${spec}. Opciones: ${Object.keys(PRESETS).join(', ')}`);
  return { ...DEFAULT_WEIGHTS, ...over };
}

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const games = Number(process.argv[2] ?? 20);
const timeMs = Number(process.argv[3] ?? 200);
const specA = process.argv[4] ?? 'default';
const specB = process.argv[5] ?? 'default';
const seed = Number(process.env.SEED ?? 1);

const engineA = new Engine({ ttBits: 20, weights: parseWeights(specA) });
const engineB = new Engine({ ttBits: 20, weights: parseWeights(specB) });
const random = rng(seed);

let winA = 0, winB = 0, draws = 0;
let winAAsFirst = 0, winAAsSecond = 0;
let maxMs = 0;
let plies = 0;
const t0 = performance.now();

for (let g = 0; g < games; g++) {
  const aIsFirst = g % 2 === 0;
  // random 2-ply opening (same opening for the pair of games g, g+1)
  if (g % 2 === 0) random();
  const open = rng(seed * 1000 + (g >> 1));
  let grid: Grid = emptyGrid();
  let player: Player = 1;
  for (let i = 0; i < 2; i++) {
    const moves = legalMoves(grid);
    grid = dropPiece(grid, moves[Math.floor(open() * moves.length)], player).grid;
    player = opponent(player);
  }
  engineA.newGame();
  engineB.newGame();
  let res = outcome(grid);
  while (res.status === 'playing') {
    const engine = (player === 1) === aIsFirst ? engineA : engineB;
    const r = engine.search(grid, player, { timeMs });
    if (r.timeMs > maxMs) maxMs = r.timeMs;
    grid = dropPiece(grid, r.column, player).grid;
    player = opponent(player);
    plies++;
    res = outcome(grid);
  }
  let line: string;
  if (res.status === 'draw') {
    draws++;
    line = 'empate';
  } else if ((res.winner === 1) === aIsFirst) {
    winA++;
    if (aIsFirst) winAAsFirst++; else winAAsSecond++;
    line = 'gana A';
  } else {
    winB++;
    line = 'gana B';
  }
  console.log(`partida ${g + 1}/${games}: A ${aIsFirst ? 'abre' : 'segundo'} -> ${line} (${plies} jugadas acumuladas)`);
}

const elapsed = (performance.now() - t0) / 1000;
const score = ((winA + draws / 2) / games) * 100;
console.log(`\nA=${specA}  B=${specB}  tiempo/jugada=${timeMs} ms  partidas=${games}`);
console.log(`A: ${winA} victorias (${winAAsFirst} abriendo, ${winAAsSecond} de segundo), ${draws} empates, ${winB} derrotas`);
console.log(`Puntaje de A: ${score.toFixed(1)} %   jugada más lenta: ${maxMs.toFixed(0)} ms   total ${elapsed.toFixed(0)} s`);
