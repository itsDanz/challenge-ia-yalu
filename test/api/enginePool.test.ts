import { afterEach, describe, expect, it } from 'vitest';
import { EngineWorker } from '../../src/api/enginePool.ts';
import { emptyGrid } from '../../src/engine/rules.ts';

const workerUrl = new URL('./fixtures/fakeEngineWorker.ts', import.meta.url);
let w: EngineWorker | null = null;
afterEach(async () => {
  await w?.close();
  w = null;
});

describe('EngineWorker', () => {
  it('runs searches in a worker thread and serializes requests in order', async () => {
    w = new EngineWorker({ workerUrl });
    const results = await Promise.all([1, 2, 3].map(() => w!.search(emptyGrid(), 1, { timeMs: 10 })));
    expect(results.map((r) => r.column)).toEqual([0, 0, 0]);
    await w.newGame();
    expect((await w.search(emptyGrid(), 1, { timeMs: 10 })).score).toBe(1);
  });

  it('rejects when the engine reports an error, and keeps working', async () => {
    w = new EngineWorker({ workerUrl });
    await expect(w.search(emptyGrid(), 1, { timeMs: 777 })).rejects.toThrow('kaput');
    expect((await w.search(emptyGrid(), 1, { timeMs: 10 })).column).toBe(0);
  });

  it('restarts the worker after a crash and serves the next request', async () => {
    const logs: string[] = [];
    w = new EngineWorker({ workerUrl, log: (l) => logs.push(l) });
    await expect(w.search(emptyGrid(), 1, { timeMs: 999 })).rejects.toThrow(/murió/);
    expect((await w.search(emptyGrid(), 1, { timeMs: 10 })).column).toBe(0);
    expect(w.restarts).toBe(1);
    expect(logs.join()).toMatch(/reiniciando/);
  });

  it('kills and replaces a hung worker after timeMs + hangGraceMs', async () => {
    w = new EngineWorker({ workerUrl, hangGraceMs: 100 });
    const t0 = Date.now();
    await expect(w.search(emptyGrid(), 1, { timeMs: 888 })).rejects.toThrow(/murió/);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((await w.search(emptyGrid(), 1, { timeMs: 10 })).column).toBe(0);
  });

  it('rejects requests after close()', async () => {
    w = new EngineWorker({ workerUrl });
    await w.close();
    await expect(w.search(emptyGrid(), 1, { timeMs: 10 })).rejects.toThrow(/cerrado/);
  });
});
