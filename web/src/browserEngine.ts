/** Promise wrapper around engine.worker.ts (in-browser engine for the static deployment). */
import type { Level } from './logic/game.ts';

interface WorkerReply {
  id: number;
  ok: boolean;
  result?: Record<string, unknown>;
  message?: string;
}

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const entry = pending.get(event.data.id);
    if (!entry) return;
    pending.delete(event.data.id);
    if (event.data.ok && event.data.result) entry.resolve(event.data.result);
    else entry.reject(new Error(event.data.message ?? 'Error del motor.'));
  };
  return worker;
}

export function searchInBrowser(moves: number[], level: Level, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    signal?.addEventListener('abort', () => {
      // The search itself finishes within the level's budget; we just drop the answer.
      pending.delete(id);
      reject(new DOMException('Aborted', 'AbortError'));
    });
    getWorker().postMessage({ id, moves, level });
  });
}
