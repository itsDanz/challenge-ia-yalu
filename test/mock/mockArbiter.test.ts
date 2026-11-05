import { afterEach, describe, expect, it } from 'vitest';
import { houseMove, startMockArbiter, type MockArbiter } from '../../src/mock/mockArbiter.ts';
import { emptyGrid } from '../../src/engine/rules.ts';

let mock: MockArbiter | null = null;
afterEach(async () => {
  await mock?.close();
  mock = null;
});

const TOKENS = { 'tok-a': 'Equipo A', 'tok-b': { id: 'eqb', name: 'Equipo B' } };

async function api(path: string, opts: { token?: string; method?: string; body?: unknown; raw?: string } = {}) {
  const res = await fetch(mock!.url + path, {
    method: opts.method ?? (opts.body !== undefined || opts.raw !== undefined ? 'POST' : 'GET'),
    headers: { ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), 'Content-Type': 'application/json' },
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  return { status: res.status, body: await res.json() };
}

describe('mock arbiter', () => {
  it('requires a valid Bearer token on bot routes but not on public ones', async () => {
    mock = await startMockArbiter({ tokens: TOKENS });
    expect((await api('/api/next?wait=0')).status).toBe(401);
    expect((await api('/api/me', { token: 'nope' })).body).toMatchObject({ ok: false, error: 'unauthorized' });
    expect((await api('/api/health')).body).toMatchObject({ ok: true, phase: 'practice' });
    expect((await api('/api/standings')).status).toBe(200);
    expect((await api('/api/openapi.json')).body.info.version).toBe('1.0.1');
    expect((await api('/api/nope')).status).toBe(404);
  });

  it('long polling answers idle after the wait expires when there is no turn', async () => {
    mock = await startMockArbiter({ tokens: TOKENS });
    const t0 = Date.now();
    const res = await api('/api/next?wait=1', { token: 'tok-a' });
    expect(res.body).toEqual({ status: 'idle' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it('long polling answers as soon as a turn appears', async () => {
    mock = await startMockArbiter({ tokens: TOKENS });
    const pending = api('/api/next?wait=10', { token: 'tok-a' });
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    mock.createMatch('tok-a', 'tok-b');
    const res = await pending;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(res.body).toMatchObject({ status: 'turn', you: 1, turn: 1, kind: 'friendly', opponent: 'Equipo B', last_move: null, deadline_ms: 3000 });
    expect(res.body.legal_moves).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(typeof res.body.served_at).toBe('string');
  });

  it('plays a friendly between two tokens, enforces turns and reports the win with winning_cells', async () => {
    mock = await startMockArbiter({ tokens: TOKENS });
    const { body: created } = await api('/admin/match', { body: { team1: 'tok-a', team2: 'eqb' } });
    const id = created.game_id;
    // B tries to move on A's turn → 409, no penalty
    expect((await api('/api/move', { token: 'tok-b', body: { game_id: id, column: 0 } })).body.error).toBe('not_your_turn');
    expect((await api('/api/move', { token: 'tok-a', body: { game_id: 'g_x', column: 0 } })).body.error).toBe('unknown_game');
    const seq = [0, 1, 0, 1, 0, 1];
    for (let i = 0; i < seq.length; i++) {
      const tok = i % 2 === 0 ? 'tok-a' : 'tok-b';
      const next = await api('/api/next?wait=1', { token: tok });
      expect(next.body.status).toBe('turn');
      const r = await api('/api/move', { token: tok, body: { game_id: id, column: seq[i] } });
      expect(r.body).toMatchObject({ ok: true, state: 'playing', turn: i + 2 });
    }
    await api('/api/next?wait=1', { token: 'tok-a' });
    const win = await api('/api/move', { token: 'tok-a', body: { game_id: id, column: 0 } });
    expect(win.body).toMatchObject({ ok: true, state: 'won', turn: 7 });
    expect(win.body.winning_cells).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
    const game = (await api(`/api/games/${id}`)).body;
    expect(game).toMatchObject({ status: 'finished', current: null, result: { winner: 1, reason: 'connect4' } });
    expect(game.moves[0]).toMatchObject({ turn: 1, by: 1, column: 0 });
    expect(typeof game.moves[0].ms).toBe('number');
    expect(game.board[3][0]).toBe(1);
    const standings = (await api('/api/standings')).body.standings;
    expect(standings[0]).toMatchObject({ position: 1, won: 1, points: 3 });
    expect((await api('/api/games?kind=friendly&limit=5')).body).toHaveLength(1);
    expect((await api('/api/games?kind=practice')).body).toHaveLength(0);
    expect((await api('/api/games/zzz')).status).toBe(404);
  });

  it('illegal move (full column or out of range) loses the game', async () => {
    mock = await startMockArbiter({ tokens: TOKENS });
    const { body } = await api('/api/practice', { token: 'tok-a', body: { opponent: 'casa-aleatorio', first: 1 } });
    await api('/api/next?wait=1', { token: 'tok-a' });
    const r = await api('/api/move', { token: 'tok-a', body: { game_id: body.game_id, column: 9 } });
    expect(r).toMatchObject({ status: 400, body: { ok: false, error: 'illegal_move' } });
    const game = (await api(`/api/games/${body.game_id}`)).body;
    expect(game.result).toMatchObject({ winner: 2, reason: 'illegal_move', forfeited_by: 1, column: 9 });
  });

  it('invalid JSON is a validation error that does not lose the game', async () => {
    mock = await startMockArbiter({ tokens: TOKENS });
    const { body } = await api('/api/practice', { token: 'tok-a', body: {} });
    expect(body.you).toBe(1);
    const r = await api('/api/move', { token: 'tok-a', raw: '{oops' });
    expect(r).toMatchObject({ status: 400, body: { error: 'validation' } });
    expect((await api('/api/move', { token: 'tok-a', body: { game_id: body.game_id } })).body.error).toBe('validation');
    expect((await api(`/api/games/${body.game_id}`)).body.status).toBe('playing');
  });

  it('a move later than deadline_ms after served_at loses by timeout', async () => {
    mock = await startMockArbiter({ tokens: TOKENS, deadlineMs: 100 });
    const { body } = await api('/api/practice', { token: 'tok-a', body: { opponent: 'casa-basico', first: 1 } });
    await api('/api/next?wait=1', { token: 'tok-a' });
    await new Promise((r) => setTimeout(r, 180));
    const r = await api('/api/move', { token: 'tok-a', body: { game_id: body.game_id, column: 3 } });
    expect(r).toMatchObject({ status: 400, body: { error: 'timeout' } });
    expect((await api(`/api/games/${body.game_id}`)).body.result).toMatchObject({ reason: 'timeout', forfeited_by: 1 });
  });

  it('a served turn that never gets a move is lost by timeout', async () => {
    mock = await startMockArbiter({ tokens: TOKENS, deadlineMs: 50 });
    const { body } = await api('/api/practice', { token: 'tok-a', body: { first: 1 } });
    await api('/api/next?wait=1', { token: 'tok-a' });
    await new Promise((r) => setTimeout(r, 1200));
    expect((await api(`/api/games/${body.game_id}`)).body.result).toMatchObject({ reason: 'timeout' });
  });

  it('a turn not picked up within absentMs is lost by absence', async () => {
    mock = await startMockArbiter({ tokens: TOKENS, absentMs: 100 });
    const { body } = await api('/api/practice', { token: 'tok-a', body: { opponent: 'casa-basico', first: 1 } });
    await new Promise((r) => setTimeout(r, 200));
    const game = (await api(`/api/games/${body.game_id}`)).body;
    expect(game.result).toMatchObject({ winner: 2, reason: 'absent', forfeited_by: 1 });
    expect(game.result.waited_ms).toBeGreaterThanOrEqual(90);
    expect((await api('/api/next?wait=0', { token: 'tok-a' })).body).toEqual({ status: 'idle' });
  });

  it('practice with first=2 makes the house bot open immediately', async () => {
    mock = await startMockArbiter({ tokens: TOKENS });
    const { status, body } = await api('/api/practice', { token: 'tok-a', body: { opponent: 'casa-aleatorio', first: 2 } });
    expect(status).toBe(201);
    expect(body.you).toBe(2);
    const next = (await api('/api/next?wait=1', { token: 'tok-a' })).body;
    expect(next).toMatchObject({ you: 2, turn: 2, kind: 'practice', match_id: null, opponent: 'casa-aleatorio' });
    expect(next.moves).toHaveLength(1);
    expect(next.last_move).toMatchObject({ by: 1 });
    const me = (await api('/api/me', { token: 'tok-a' })).body;
    expect(me).toMatchObject({ team: { name: 'Equipo A' }, pending_turns: [body.game_id], phase: 'practice' });
  });

  it('rejects invalid practice requests', async () => {
    mock = await startMockArbiter({ tokens: TOKENS });
    expect((await api('/api/practice', { token: 'tok-a', body: { opponent: 'casa-experto' } })).body.error).toBe('validation');
    expect((await api('/api/practice', { token: 'tok-a', body: { first: 3 } })).body.error).toBe('validation');
    expect((await api('/admin/match', { body: { team1: 'x', team2: 'tok-a' } })).status).toBe(400);
  });

  it('registers submissions and validates repo_url and commit', async () => {
    mock = await startMockArbiter({ tokens: TOKENS });
    const bad = await api('/api/me/submission', { token: 'tok-a', method: 'PUT', body: { repo_url: 'https://gitlab.com/x', commit: 'abc1234' } });
    expect(bad.status).toBe(400);
    const bad2 = await api('/api/me/submission', { token: 'tok-a', method: 'PUT', body: { repo_url: 'https://github.com/x/y', commit: 'xyz' } });
    expect(bad2.status).toBe(400);
    const ok = await api('/api/me/submission', { token: 'tok-a', method: 'PUT', body: { repo_url: 'https://github.com/x/y', commit: 'abc1234' } });
    expect(ok.body).toMatchObject({ repo_url: 'https://github.com/x/y', commit: 'abc1234' });
    expect((await api('/api/me', { token: 'tok-a' })).body.submission.commit).toBe('abc1234');
  });
});

describe('house bots', () => {
  it('casa-basico takes an immediate win', () => {
    const g = emptyGrid();
    g[0][0] = g[0][1] = g[0][2] = 2;
    g[1][0] = g[1][1] = 1;
    expect(houseMove('casa-basico', g, 2, () => 0)).toBe(3);
  });

  it('casa-basico blocks an immediate four of the opponent', () => {
    const g = emptyGrid();
    g[0][4] = g[1][4] = g[2][4] = 1;
    g[0][0] = g[0][7] = 2;
    expect(houseMove('casa-basico', g, 2, () => 0)).toBe(4);
  });

  it('casa-aleatorio picks among legal moves using the random source', () => {
    const g = emptyGrid();
    expect(houseMove('casa-aleatorio', g, 1, () => 0.99)).toBe(7);
    for (let r = 0; r < 7; r++) g[r][0] = ((r % 2) + 1) as 1 | 2;
    expect(houseMove('casa-aleatorio', g, 1, () => 0)).toBe(1);
  });
});
