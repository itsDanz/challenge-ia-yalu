/**
 * worker_threads wrapper around the engine. Each EngineWorker owns one Engine (one TT) in its
 * own thread, so a web game never delays a tournament move. Requests are serialized; a crashed
 * or hung worker is replaced transparently.
 */

import { Worker } from 'node:worker_threads';
import type { Grid, Player } from '../engine/rules.ts';

export interface SearchOptions {
  timeMs: number;
  maxDepth?: number;
  randomness?: number;
}

export interface SearchResult {
  column: number;
  score: number;
  depth: number;
  nodes: number;
  timeMs: number;
  pv: number[];
  source: 'search' | 'book' | 'forced' | string;
}

/** What the API server and the bot loop need from an engine (lets tests inject fakes). */
export interface EngineLike {
  search(grid: Grid, toMove: Player, opts: SearchOptions): Promise<SearchResult>;
  newGame(): Promise<void>;
}

export interface EngineWorkerOptions {
  name?: string;
  ttBits?: number;
  /** Override the worker script (tests use a fake engine). */
  workerUrl?: URL;
  /** Kill and respawn the worker if a request takes longer than timeMs + this (default 1500). */
  hangGraceMs?: number;
  log?: (line: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

export class EngineWorker implements EngineLike {
  readonly name: string;
  restarts = 0;
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly opts: EngineWorkerOptions;

  constructor(opts: EngineWorkerOptions = {}) {
    this.opts = opts;
    this.name = opts.name ?? 'engine';
    this.spawn();
  }

  private spawn(): void {
    const url = this.opts.workerUrl ?? new URL('./engineWorker.ts', import.meta.url);
    const worker = new Worker(url, { workerData: { ttBits: this.opts.ttBits }, name: this.name });
    worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? 'engine error'));
    });
    worker.on('error', (err) => this.onDeath(worker, `error: ${err.message}`));
    worker.on('exit', (code) => this.onDeath(worker, `exit ${code}`));
    worker.unref();
    this.worker = worker;
  }

  private onDeath(worker: Worker, why: string): void {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new Error(`worker ${this.name} murió (${why})`));
    }
    if (!this.closed) {
      this.restarts++;
      this.opts.log?.(`[engine:${this.name}] worker murió (${why}); reiniciando`);
      this.spawn();
    }
  }

  /** Forcefully replaces the worker (used when a search hangs). */
  restart(): void {
    const old = this.worker;
    if (old) {
      this.onDeath(old, 'reinicio forzado');
      void old.terminate();
    }
  }

  private call<T>(msg: Record<string, unknown>, hangMs: number | null): Promise<T> {
    const run = () =>
      new Promise<T>((resolve, reject) => {
        if (this.closed) return reject(new Error('engine cerrado'));
        if (!this.worker) this.spawn();
        const id = this.nextId++;
        let timer: ReturnType<typeof setTimeout> | undefined;
        this.pending.set(id, {
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v as T);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        if (hangMs !== null) {
          timer = setTimeout(() => {
            this.opts.log?.(`[engine:${this.name}] búsqueda colgada > ${hangMs} ms; reiniciando worker`);
            this.restart();
          }, hangMs);
        }
        this.worker!.postMessage({ id, ...msg });
      });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  search(grid: Grid, toMove: Player, opts: SearchOptions): Promise<SearchResult> {
    return this.call<SearchResult>({ type: 'search', grid, toMove, opts }, opts.timeMs + (this.opts.hangGraceMs ?? 1500));
  }

  async newGame(): Promise<void> {
    await this.call<void>({ type: 'newGame' }, 5000);
  }

  async close(): Promise<void> {
    this.closed = true;
    const w = this.worker;
    this.worker = null;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new Error('engine cerrado'));
    }
    if (w) await w.terminate();
  }
}

/** The two independent engines used by `npm start`. */
export function createEnginePool(opts: { log?: (line: string) => void; ttBits?: number } = {}) {
  return {
    tournament: new EngineWorker({ name: 'torneo', ...opts }),
    web: new EngineWorker({ name: 'web', ...opts }),
  };
}
