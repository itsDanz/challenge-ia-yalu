/**
 * Arena: our Engine vs the "typical rival" (classic minimax) to measure real strength.
 *
 *   node tools/arena.ts [games=10] [ourMs=1500] [rivalMs=1500]
 *
 * Alternates who opens and uses random 2-ply openings so games differ.
 */
import { Engine } from '../src/engine/index.ts';
import { classicMove } from './rivals/classicMinimax.ts';
import { dropPiece, emptyGrid, legalMoves, outcome, type Grid, type Player } from '../src/engine/rules.ts';

const games = Number(process.argv[2] ?? 10);
const ourMs = Number(process.argv[3] ?? 1500);
const rivalMs = Number(process.argv[4] ?? 1500);

const engine = new Engine();
const tally = { win: 0, draw: 0, loss: 0 };
let maxOurMs = 0;

for (let i = 0; i < games; i++) {
  engine.newGame();
  const ours: Player = i % 2 === 0 ? 1 : 2;
  let grid: Grid = emptyGrid();
  let toMove: Player = 1;
  const moves: number[] = [];
  // Random 2-ply opening for variety.
  for (let k = 0; k < 2; k++) {
    const legal = legalMoves(grid);
    const col = legal[Math.floor(Math.random() * legal.length)];
    grid = dropPiece(grid, col, toMove).grid;
    moves.push(col);
    toMove = toMove === 1 ? 2 : 1;
  }
  let state = outcome(grid);
  while (state.status === 'playing') {
    let col: number;
    if (toMove === ours) {
      const t0 = performance.now();
      col = engine.search(grid, toMove, { timeMs: ourMs }).column;
      maxOurMs = Math.max(maxOurMs, performance.now() - t0);
    } else {
      col = classicMove(grid, toMove, rivalMs).column;
    }
    grid = dropPiece(grid, col, toMove).grid;
    moves.push(col);
    toMove = toMove === 1 ? 2 : 1;
    state = outcome(grid);
  }
  const result = state.status === 'draw' ? 'draw' : state.winner === ours ? 'win' : 'loss';
  tally[result]++;
  console.log(`#${i + 1} nosotros=J${ours} → ${result.padEnd(4)} (${moves.length} jugadas) ${moves.join('')}`);
}
console.log(`\nResultado: ${tally.win}G ${tally.draw}E ${tally.loss}P · máx. ms por jugada nuestra: ${maxOurMs.toFixed(0)}`);
