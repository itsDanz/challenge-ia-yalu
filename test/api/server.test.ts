import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer, LEVELS } from '../../src/api/server.ts';
import type { EngineLike, SearchOptions } from '../../src/api/enginePool.ts';
import type { Grid, Player } from '../../src/engine/rules.ts';
import { ArbiterClient } from '../../src/client/arbiterClient.ts';
import { startMockArbiter, type MockArbiter } from '../../src/mock/mockArbiter.ts';

let server: Server | null = null;
let mock: MockArbiter | null = null;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((r) => (server ? server.close(r) : r(null)));
  await mock?.close();
  server = null;
  mock = null;
});

function fakeEngine() {
  const calls: Array<{ grid: Grid; toMove: Player; opts: SearchOptions }> = [];
  const engine: EngineLike = {
    async search(grid, toMove, opts) {
      calls.push({ grid, toMove, opts });
      return { column: 3, score: 0, depth: 4, nodes: 10, timeMs: 1, pv: [3], source: 'search' };
    },
    async newGame() {},
  };
  return { engine, calls };
}

async function start(opts: Partial<Parameters<typeof createServer>[0]> = {}) {
  const { engine, calls } = fakeEngine();
  server = createServer({ webEngine: engine, ...opts });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { base, calls };
}

const post = (base: string, body: unknown) =>
  fetch(`${base}/api/bot/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('API server', () => {
  it('GET /api/health reports version and bot state', async () => {
    const { base } = await start({ botStatus: () => ({ connected: true, games: 2 }) });
    const res = await fetch(`${base}/api/health`);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ ok: true, version: '1.0.0', bot: { enabled: true, connected: true } });
  });

  it('GET /api/bot/status returns the bot stats or enabled:false', async () => {
    const a = await start({ botStatus: () => ({ connected: false, games: 2 }) });
    expect(await (await fetch(`${a.base}/api/bot/status`)).json()).toEqual({ enabled: true, connected: false, games: 2 });
    server!.close();
    const b = await start();
    expect(await (await fetch(`${b.base}/api/bot/status`)).json()).toEqual({ enabled: false, connected: false });
    expect((await (await fetch(`${b.base}/api/health`)).json()).bot.enabled).toBe(false);
  });

  it('POST /api/bot/move rebuilds the board, computes who moves and returns the SearchResult', async () => {
    const { base, calls } = await start();
    const res = await post(base, { moves: [3, 4, 3], level: 'medio' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ column: 3, depth: 4, pv: [3] });
    expect(calls[0].toMove).toBe(2);
    expect(calls[0].grid[1][3]).toBe(1);
    expect(calls[0].opts).toEqual({ timeMs: 400, maxDepth: 6 });
  });

  it('maps each level to its search options', async () => {
    const { base, calls } = await start();
    for (const level of ['facil', 'medio', 'dificil', 'maximo']) await post(base, { moves: [], level });
    expect(calls.map((c) => c.opts)).toEqual([LEVELS.facil, LEVELS.medio, LEVELS.dificil, LEVELS.maximo]);
    expect(LEVELS.facil).toEqual({ timeMs: 150, maxDepth: 2, randomness: 0.35 });
    expect(calls[0].toMove).toBe(1);
  });

  it('rejects illegal moves, finished games, bad levels and bad JSON with 400', async () => {
    const { base, calls } = await start();
    const cases: Array<[unknown, string]> = [
      [{ moves: [0, 0, 0, 0, 0, 0, 0, 0], level: 'facil' }, 'illegal_position'], // column full
      [{ moves: [8], level: 'facil' }, 'illegal_position'],
      [{ moves: [0, 1, 0, 1, 0, 1, 0], level: 'facil' }, 'illegal_position'], // already won
      [{ moves: [0, 1, 0, 1, 0, 1, 0, 2], level: 'facil' }, 'illegal_position'], // move after end
      [{ moves: [1.5], level: 'facil' }, 'validation'],
      [{ moves: 'x', level: 'facil' }, 'validation'],
      [{ moves: [], level: 'imposible' }, 'validation'],
      ['{nope', 'validation'],
      ['null', 'validation'],
    ];
    for (const [body, code] of cases) {
      const res = await post(base, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBe(code);
    }
    expect(calls).toHaveLength(0);
  });

  it('rejects bodies over the size limit with 413', async () => {
    const { base } = await start();
    const res = await post(base, { moves: [], level: 'facil', pad: 'x'.repeat(40_000) }).catch((e) => e);
    if (res instanceof Error) return; // the server may close the socket early; both are acceptable
    expect(res.status).toBe(413);
  });

  it('answers CORS preflight and 404s unknown API routes as JSON', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/bot/move`, { method: 'OPTIONS' })).status).toBe(204);
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('not_found');
  });

  it('GET /api/replay/:id proxies to the arbiter (mock) and maps errors', async () => {
    mock = await startMockArbiter({ tokens: { tok: 'E' } });
    const arbiter = new ArbiterClient({ baseUrl: mock.url, token: 'tok' });
    const { game_id } = await arbiter.practice('casa-basico', 2);
    const { base } = await start({ arbiter });
    const res = await fetch(`${base}/api/replay/${game_id}`);
    expect(res.status).toBe(200);
    const game = await res.json();
    expect(game).toMatchObject({ game_id, kind: 'practice', status: 'playing' });
    expect(game.moves).toHaveLength(1);
    expect((await fetch(`${base}/api/replay/g_nope`)).status).toBe(404);
  });

  it('GET /api/replay/:id without arbiter → 503, arbiter down → 502', async () => {
    const a = await start();
    expect((await fetch(`${a.base}/api/replay/x`)).status).toBe(503);
    server!.close();
    const b = await start({ arbiter: { game: async () => { throw new Error('ECONNREFUSED'); } } });
    expect((await fetch(`${b.base}/api/replay/x`)).status).toBe(502);
  });

  it('serves a friendly page when web/dist is missing', async () => {
    const { base } = await start({ staticDir: join(tmpdir(), 'does-not-exist-xyz') });
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('npm run build:web');
  });

  it('serves static files with MIME types, SPA fallback and no path traversal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'webdist-'));
    writeFileSync(join(dir, 'index.html'), '<h1>app</h1>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    const { base } = await start({ staticDir: dir });
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(await js.text()).toBe('console.log(1)');
    expect(await (await fetch(`${base}/partida/123`)).text()).toBe('<h1>app</h1>');
    expect(await (await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`)).text()).toBe('<h1>app</h1>');
    expect((await fetch(`${base}/%E0%A4%A`)).status).toBe(400);
    expect((await fetch(`${base}/x`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/`, { method: 'HEAD' })).status).toBe(200);
  });

  it('turns engine failures into a JSON 500', async () => {
    const engine: EngineLike = { search: async () => { throw new Error('worker murió'); }, newGame: async () => {} };
    const logs: string[] = [];
    server = createServer({ webEngine: engine, log: (l) => logs.push(l) });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const res = await post(base, { moves: [], level: 'facil' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal', message: 'worker murió' });
    expect(logs[0]).toMatch(/500/);
  });
});
