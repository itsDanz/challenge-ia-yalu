// Fake engine worker speaking the same protocol as src/api/engineWorker.ts.
// timeMs 999 → the thread dies; timeMs 888 → never answers; timeMs 777 → reports an error.
import { parentPort } from 'node:worker_threads';
import { legalMoves, type Grid } from '../../../src/engine/rules.ts';

let games = 0;
parentPort!.on('message', (msg: { id: number; type: string; grid?: Grid; opts?: { timeMs: number } }) => {
  if (msg.type === 'newGame') {
    games++;
    return parentPort!.postMessage({ id: msg.id, ok: true });
  }
  if (msg.type !== 'search') return parentPort!.postMessage({ id: msg.id, ok: false, error: 'unknown' });
  if (msg.opts?.timeMs === 999) process.exit(3);
  if (msg.opts?.timeMs === 888) return;
  if (msg.opts?.timeMs === 777) return parentPort!.postMessage({ id: msg.id, ok: false, error: 'kaput' });
  const legal = legalMoves(msg.grid!);
  parentPort!.postMessage({
    id: msg.id,
    ok: true,
    result: { column: legal[0], score: games, depth: 1, nodes: 1, timeMs: 0, pv: [legal[0]], source: 'search' },
  });
});
