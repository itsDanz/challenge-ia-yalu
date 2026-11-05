/**
 * Worker thread entry point: owns ONE Engine instance and answers messages from enginePool.ts.
 *
 * Protocol: in  { id, type: 'search', grid, toMove, opts } | { id, type: 'newGame' }
 *           out { id, ok: true, result? } | { id, ok: false, error }
 */

import { parentPort, workerData } from 'node:worker_threads';
import { Engine } from '../engine/index.ts';

const engine = new Engine(workerData?.ttBits ? { ttBits: workerData.ttBits } : undefined);

parentPort!.on('message', (msg: { id: number; type: string; grid?: unknown; toMove?: unknown; opts?: unknown }) => {
  try {
    if (msg.type === 'newGame') {
      engine.newGame();
      parentPort!.postMessage({ id: msg.id, ok: true });
    } else if (msg.type === 'search') {
      const result = engine.search(msg.grid as never, msg.toMove as never, msg.opts as never);
      parentPort!.postMessage({ id: msg.id, ok: true, result });
    } else {
      parentPort!.postMessage({ id: msg.id, ok: false, error: `unknown message type ${msg.type}` });
    }
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, ok: false, error: (err as Error)?.message ?? String(err) });
  }
});
