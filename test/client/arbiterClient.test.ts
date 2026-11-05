import { describe, expect, it } from 'vitest';
import {
  ArbiterClient,
  ArbiterError,
  NetworkError,
  UnauthorizedError,
  parseNext,
} from '../../src/client/arbiterClient.ts';
import { emptyGrid } from '../../src/engine/rules.ts';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(status: number, body: unknown, calls: Call[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

const turnBody = {
  status: 'turn',
  game_id: 'g_7f3a',
  match_id: 'm_12',
  kind: 'league',
  you: 2,
  opponent: 'Los Recursivos',
  turn: 2,
  board: (() => {
    const g = emptyGrid();
    g[0][3] = 1;
    return g;
  })(),
  moves: [3],
  last_move: { by: 1, column: 3 },
  legal_moves: [0, 1, 2, 3, 4, 5, 6, 7],
  deadline_ms: 3000,
  served_at: '2026-11-05T14:00:00Z',
  extra_field_from_future: 'ignored',
};

describe('ArbiterClient', () => {
  it('parses a turn, sends Bearer auth and strips the trailing slash of baseUrl', async () => {
    const calls: Call[] = [];
    const client = new ArbiterClient({ baseUrl: 'https://arb.example/', token: 'tok', fetch: fakeFetch(200, turnBody, calls) });
    const res = await client.next(20);
    expect(res.status).toBe('turn');
    if (res.status !== 'turn') throw new Error('unreachable');
    expect(res.you).toBe(2);
    expect(res.moves).toEqual([3]);
    expect(res.last_move).toEqual({ by: 1, column: 3 });
    expect('extra_field_from_future' in res).toBe(false);
    expect(calls[0].url).toBe('https://arb.example/api/next?wait=20');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('clamps wait to the 0..25 range allowed by the protocol', async () => {
    const calls: Call[] = [];
    const client = new ArbiterClient({ baseUrl: 'http://x', token: 't', fetch: fakeFetch(200, { status: 'idle' }, calls) });
    expect(await client.next(99)).toEqual({ status: 'idle' });
    await client.next(-3);
    expect(calls.map((c) => c.url)).toEqual(['http://x/api/next?wait=25', 'http://x/api/next?wait=0']);
  });

  it('builds the POST /api/move body as JSON', async () => {
    const calls: Call[] = [];
    const client = new ArbiterClient({ baseUrl: 'http://x', token: 't', fetch: fakeFetch(200, { ok: true, state: 'playing', turn: 10 }, calls) });
    const res = await client.move('g_1', 4);
    expect(res.state).toBe('playing');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ game_id: 'g_1', column: 4 });
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('maps 400 illegal_move / timeout and 409 not_your_turn to ArbiterError with the code', async () => {
    for (const [status, code] of [[400, 'illegal_move'], [400, 'timeout'], [409, 'not_your_turn']] as const) {
      const client = new ArbiterClient({ baseUrl: 'http://x', token: 't', fetch: fakeFetch(status, { ok: false, error: code, message: 'm' }) });
      const e = await client.move('g', 1).catch((x) => x);
      expect(e).toBeInstanceOf(ArbiterError);
      expect(e.status).toBe(status);
      expect(e.code).toBe(code);
    }
  });

  it('throws UnauthorizedError on 401', async () => {
    const client = new ArbiterClient({ baseUrl: 'http://x', token: 'bad', fetch: fakeFetch(401, { ok: false, error: 'unauthorized', message: 'Token inválido.' }) });
    await expect(client.me()).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('wraps non-JSON error bodies and missing error codes', async () => {
    const client = new ArbiterClient({ baseUrl: 'http://x', token: 't', fetch: fakeFetch(502, '<html>Bad gateway</html>') });
    const e = await client.health().catch((x) => x);
    expect(e).toBeInstanceOf(ArbiterError);
    expect(e.code).toBe('http_502');
  });

  it('turns fetch failures, timeouts and non-JSON 200s into NetworkError', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(new ArbiterClient({ baseUrl: 'http://x', token: 't', fetch: failing }).me()).rejects.toBeInstanceOf(NetworkError);

    const hanging = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch;
    const e = await new ArbiterClient({ baseUrl: 'http://x', token: 't', fetch: hanging, timeoutMs: 30 }).me().catch((x) => x);
    expect(e).toBeInstanceOf(NetworkError);
    expect(e.message).toMatch(/sin respuesta/);

    await expect(new ArbiterClient({ baseUrl: 'http://x', token: 't', fetch: fakeFetch(200, 'not json') }).me()).rejects.toBeInstanceOf(NetworkError);
  });

  it('next() can be cancelled with an external AbortSignal', async () => {
    const hanging = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch;
    const ctrl = new AbortController();
    const p = new ArbiterClient({ baseUrl: 'http://x', token: 't', fetch: hanging }).next(20, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toBeInstanceOf(NetworkError);
  });

  it('uses the documented paths for practice, submission, game, me and health', async () => {
    const calls: Call[] = [];
    const client = new ArbiterClient({ baseUrl: 'http://x', token: 't', fetch: fakeFetch(200, { ok: true }, calls) });
    await client.practice('casa-aleatorio', 2);
    await client.submission('https://github.com/a/b', 'abc1234');
    await client.game('g 1');
    await client.me();
    await client.health();
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'POST http://x/api/practice',
      'PUT http://x/api/me/submission',
      'GET http://x/api/games/g%201',
      'GET http://x/api/me',
      'GET http://x/api/health',
    ]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ opponent: 'casa-aleatorio', first: 2 });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ repo_url: 'https://github.com/a/b', commit: 'abc1234' });
  });
});

describe('parseNext', () => {
  it('rejects garbage and unknown statuses', () => {
    expect(() => parseNext(null)).toThrow(NetworkError);
    expect(() => parseNext({ status: 'weird' })).toThrow(/desconocido/);
    expect(() => parseNext({ ...turnBody, you: 3 })).toThrow(/you/);
    expect(() => parseNext({ ...turnBody, game_id: '' })).toThrow(/game_id/);
  });

  it('fills sensible defaults for optional or missing fields', () => {
    const t = parseNext({ status: 'turn', game_id: 'g', you: 1, board: [], moves: [1, 2] });
    if (t.status !== 'turn') throw new Error('unreachable');
    expect(t.turn).toBe(3);
    expect(t.deadline_ms).toBe(3000);
    expect(t.legal_moves).toEqual([]);
    expect(t.last_move).toBeNull();
    expect(t.match_id).toBeNull();
  });
});
