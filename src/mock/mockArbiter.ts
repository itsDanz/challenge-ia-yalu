/**
 * Mock arbiter, faithful to docs/arbitro-openapi.json v1.0.1 (node:http, no dependencies).
 *
 * - /api/next long polling, served_at set the first time a turn is handed out.
 * - /api/move: 400 illegal_move / timeout (game lost), 400 validation (no penalty),
 *   409 not_your_turn / unknown_game, 401 unauthorized.
 * - Absence: a turn not picked up within `absentMs` (30 s by default) loses the game.
 * - House bots casa-aleatorio and casa-basico move instantly, server-side.
 * - MOCK-ONLY: POST /admin/match {team1, team2} creates a friendly between two teams
 *   (team ids or tokens). The real arbiter has no such endpoint.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import {
  dropPiece,
  emptyGrid,
  isFull,
  isLegalMove,
  legalMoves,
  opponent,
  winningLineThrough,
  type Coord,
  type Grid,
  type Player,
} from '../engine/rules.ts';

export const HOUSE_BOTS = ['casa-aleatorio', 'casa-basico'] as const;
export type HouseBot = (typeof HOUSE_BOTS)[number];

export interface TeamInfo {
  id: string;
  name: string;
}

export interface MockArbiterOptions {
  port?: number;
  host?: string;
  /** token → team (or team name; the id is derived). */
  tokens?: Record<string, TeamInfo | string>;
  /** Ms a turn may wait unpicked before the game is lost by absence (default 30000). */
  absentMs?: number;
  /** deadline_ms announced and enforced (default 3000). */
  deadlineMs?: number;
  /** Random source for house bots (default Math.random). */
  random?: () => number;
  phase?: string;
  log?: (line: string) => void;
}

interface MoveRecord {
  turn: number;
  by: Player;
  column: number;
  ms?: number;
}

interface Side {
  ref: { team_id: string; name: string; house?: true };
  token: string | null;
  house: HouseBot | null;
}

interface Result {
  winner: Player | null;
  reason: 'connect4' | 'draw' | 'illegal_move' | 'timeout' | 'absent' | 'admin';
  winning_cells?: Coord[];
  forfeited_by?: Player;
  ms?: number;
  column?: unknown;
  waited_ms?: number;
}

export interface MockGame {
  game_id: string;
  match_id: string | null;
  kind: 'practice' | 'friendly' | 'league';
  sides: Record<Player, Side>;
  grid: Grid;
  moves: MoveRecord[];
  status: 'playing' | 'finished';
  current: Player | null;
  result: Result | null;
  started_at: string;
  finished_at: string | null;
  createdSeq: number;
  /** When the current turn became available (ms epoch). */
  pendingSince: number | null;
  servedAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Waiter {
  token: string;
  respond: (game: MockGame) => void;
}

export interface MockArbiter {
  url: string;
  port: number;
  close(): Promise<void>;
  games: Map<string, MockGame>;
  /** Creates a friendly game between two tokens (mock-only helper). */
  createMatch(token1: string, token2: string): MockGame;
  createPractice(token: string, opponentBot: HouseBot, first: Player): MockGame;
}

const DEFAULT_SPEC_PATH = new URL('../../docs/arbitro-openapi.json', import.meta.url);

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'equipo';
}

/** casa-basico: wins if it can, blocks an immediate four, else random. */
export function houseMove(bot: HouseBot, grid: Grid, me: Player, random: () => number): number {
  const legal = legalMoves(grid);
  if (bot === 'casa-basico') {
    for (const who of [me, opponent(me)]) {
      for (const c of legal) {
        const { grid: next, row } = dropPiece(grid, c, who);
        if (winningLineThrough(next, row, c)) return c;
      }
    }
  }
  return legal[Math.min(legal.length - 1, Math.floor(random() * legal.length))];
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function err(res: ServerResponse, status: number, error: string, message: string): void {
  sendJson(res, status, { ok: false, error, message });
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startMockArbiter(opts: MockArbiterOptions = {}): Promise<MockArbiter> {
  const absentMs = opts.absentMs ?? 30_000;
  const deadlineMs = opts.deadlineMs ?? 3000;
  const random = opts.random ?? Math.random;
  const log = opts.log ?? (() => {});
  const phase = opts.phase ?? 'practice';

  const teams = new Map<string, TeamInfo>();
  for (const [token, info] of Object.entries(opts.tokens ?? { 'token-equipo3': 'Equipo 3', 'token-rival': 'Rival' })) {
    teams.set(token, typeof info === 'string' ? { id: slug(info), name: info } : info);
  }
  const submissions = new Map<string, { repo_url: string; commit: string; registered_at: string }>();
  const games = new Map<string, MockGame>();
  const waiters = new Set<Waiter>();
  let seq = 0;

  const sideOfToken = (game: MockGame, token: string): Player | null =>
    game.sides[1].token === token ? 1 : game.sides[2].token === token ? 2 : null;

  function clearTimer(game: MockGame): void {
    if (game.timer) clearTimeout(game.timer);
    game.timer = null;
  }

  function finish(game: MockGame, result: Result): void {
    clearTimer(game);
    game.status = 'finished';
    game.current = null;
    game.result = result;
    game.finished_at = new Date().toISOString();
    game.pendingSince = null;
    game.servedAt = null;
    log(`[mock] ${game.game_id} terminó: ${result.reason} ganador=${result.winner}`);
  }

  function forfeit(game: MockGame, loser: Player, reason: Result['reason'], extra: Partial<Result>): void {
    finish(game, { winner: opponent(loser), reason, forfeited_by: loser, ...extra });
  }

  /** Applies a legal move; returns the resulting state for the mover. */
  function applyMove(game: MockGame, column: number, ms?: number): 'playing' | 'won' | 'draw' {
    const by = game.current as Player;
    const { grid, row } = dropPiece(game.grid, column, by);
    game.grid = grid;
    game.moves.push({ turn: game.moves.length + 1, by, column, ...(ms !== undefined ? { ms } : {}) });
    clearTimer(game);
    const line = winningLineThrough(grid, row, column);
    if (line) {
      finish(game, { winner: by, reason: 'connect4', winning_cells: line });
      return 'won';
    }
    if (isFull(grid)) {
      finish(game, { winner: null, reason: 'draw' });
      return 'draw';
    }
    game.current = opponent(by);
    makeTurnAvailable(game);
    return 'playing';
  }

  function makeTurnAvailable(game: MockGame): void {
    const side = game.sides[game.current as Player];
    if (side.house) {
      applyMove(game, houseMove(side.house, game.grid, game.current as Player, random), 0);
      return;
    }
    game.pendingSince = Date.now();
    game.servedAt = null;
    game.timer = setTimeout(() => {
      if (game.status === 'playing' && game.servedAt === null) {
        forfeit(game, game.current as Player, 'absent', { waited_ms: Date.now() - (game.pendingSince ?? Date.now()) });
      }
    }, absentMs);
    for (const w of waiters) {
      if (w.token === side.token) {
        waiters.delete(w);
        w.respond(game);
        break;
      }
    }
  }

  function serve(game: MockGame): Record<string, unknown> {
    if (game.servedAt === null) {
      game.servedAt = Date.now();
      clearTimer(game);
      // A served turn that never gets a move is lost by timeout shortly after the deadline.
      const player = game.current as Player;
      game.timer = setTimeout(() => {
        if (game.status === 'playing' && game.current === player) {
          forfeit(game, player, 'timeout', { ms: Date.now() - (game.servedAt ?? Date.now()) });
        }
      }, deadlineMs + 1000);
    }
    const you = game.current as Player;
    const last = game.moves.at(-1);
    return {
      status: 'turn',
      game_id: game.game_id,
      match_id: game.match_id,
      kind: game.kind,
      you,
      opponent: game.sides[opponent(you)].ref.name,
      turn: game.moves.length + 1,
      board: game.grid,
      moves: game.moves.map((m) => m.column),
      last_move: last ? { by: last.by, column: last.column } : null,
      legal_moves: legalMoves(game.grid),
      deadline_ms: deadlineMs,
      served_at: new Date(game.servedAt).toISOString(),
    };
  }

  function oldestPending(token: string): MockGame | null {
    let best: MockGame | null = null;
    for (const g of games.values()) {
      if (g.status !== 'playing' || g.current === null || g.sides[g.current].token !== token) continue;
      if (!best || (g.pendingSince ?? 0) < (best.pendingSince ?? 0)) best = g;
    }
    return best;
  }

  function newGame(kind: MockGame['kind'], side1: Side, side2: Side, matchId: string | null): MockGame {
    seq++;
    const game: MockGame = {
      game_id: `g_${kind === 'practice' ? 'p_' : ''}${String(seq).padStart(3, '0')}`,
      match_id: matchId,
      kind,
      sides: { 1: side1, 2: side2 },
      grid: emptyGrid(),
      moves: [],
      status: 'playing',
      current: 1,
      result: null,
      started_at: new Date().toISOString(),
      finished_at: null,
      createdSeq: seq,
      pendingSince: null,
      servedAt: null,
      timer: null,
    };
    games.set(game.game_id, game);
    makeTurnAvailable(game);
    return game;
  }

  const teamSide = (token: string): Side => {
    const t = teams.get(token)!;
    return { ref: { team_id: t.id, name: t.name }, token, house: null };
  };
  const houseSide = (bot: HouseBot): Side => ({ ref: { team_id: bot, name: bot, house: true }, token: null, house: bot });

  function createPractice(token: string, bot: HouseBot, first: Player): MockGame {
    return first === 1
      ? newGame('practice', teamSide(token), houseSide(bot), null)
      : newGame('practice', houseSide(bot), teamSide(token), null);
  }

  function createMatch(token1: string, token2: string): MockGame {
    return newGame('friendly', teamSide(token1), teamSide(token2), 'amistoso');
  }

  function summary(game: MockGame): Record<string, unknown> {
    return {
      game_id: game.game_id,
      match_id: game.match_id,
      kind: game.kind,
      series: null,
      status: game.status,
      players: { 1: game.sides[1].ref, 2: game.sides[2].ref },
      moves: game.moves,
      current: game.current,
      result: game.result,
      started_at: game.started_at,
      finished_at: game.finished_at,
    };
  }

  function standings(): Record<string, unknown>[] {
    const rows = new Map<string, { team: TeamInfo; played: number; won: number; drawn: number; lost: number; points: number }>();
    for (const t of teams.values()) rows.set(t.id, { team: t, played: 0, won: 0, drawn: 0, lost: 0, points: 0 });
    for (const g of games.values()) {
      if (g.kind === 'practice' || g.status !== 'finished' || !g.result) continue;
      for (const p of [1, 2] as Player[]) {
        const row = rows.get(g.sides[p].ref.team_id);
        if (!row) continue;
        row.played++;
        if (g.result.winner === null) {
          row.drawn++;
          row.points += 1;
        } else if (g.result.winner === p) {
          row.won++;
          row.points += 3;
        } else row.lost++;
      }
    }
    return [...rows.values()]
      .sort((a, b) => b.points - a.points || b.won - a.won)
      .map((r, i) => ({ position: i + 1, ...r }));
  }

  function auth(req: IncomingMessage, res: ServerResponse): string | null {
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m || !teams.has(m[1].trim())) {
      err(res, 401, 'unauthorized', 'Token inválido.');
      return null;
    }
    return m[1].trim();
  }

  async function parseJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
    try {
      const text = await readBody(req);
      const body = text ? JSON.parse(text) : {};
      if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new Error('not an object');
      return body;
    } catch {
      err(res, 400, 'validation', 'JSON inválido.');
      return null;
    }
  }

  function handleNext(req: IncomingMessage, res: ServerResponse, url: URL, token: string): void {
    const raw = Number(url.searchParams.get('wait') ?? 20);
    const wait = Number.isFinite(raw) ? Math.max(0, Math.min(25, raw)) : 20;
    const pending = oldestPending(token);
    if (pending) return sendJson(res, 200, serve(pending));
    if (wait === 0) return sendJson(res, 200, { status: 'idle' });
    let done = false;
    const waiter: Waiter = {
      token,
      respond: (game) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sendJson(res, 200, serve(game));
      },
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      waiters.delete(waiter);
      sendJson(res, 200, { status: 'idle' });
    }, wait * 1000);
    req.on('close', () => {
      if (!done && !res.writableEnded) {
        done = true;
        clearTimeout(timer);
        waiters.delete(waiter);
      }
    });
    waiters.add(waiter);
  }

  async function handleMove(req: IncomingMessage, res: ServerResponse, token: string): Promise<void> {
    const body = await parseJson(req, res);
    if (!body) return;
    if (typeof body.game_id !== 'string' || !('column' in body)) {
      return err(res, 400, 'validation', 'Se requieren game_id y column.');
    }
    const game = games.get(body.game_id);
    if (!game) return err(res, 409, 'unknown_game', `La partida ${body.game_id} no existe.`);
    const player = game.current;
    if (game.status !== 'playing' || player === null || game.sides[player].token !== token) {
      return err(res, 409, 'not_your_turn', `La partida ${game.game_id} no tiene un turno pendiente para tu equipo.`);
    }
    const servedAt = game.servedAt ?? Date.now();
    const ms = Date.now() - servedAt;
    if (ms > deadlineMs) {
      forfeit(game, player, 'timeout', { ms });
      return err(res, 400, 'timeout', `La jugada llegó ${ms - deadlineMs} ms después del límite.`);
    }
    const column = body.column;
    if (typeof column !== 'number' || !isLegalMove(game.grid, column)) {
      forfeit(game, player, 'illegal_move', { ms, column });
      const why = typeof column === 'number' && Number.isInteger(column) && column >= 0 && column < 8 ? 'está llena' : 'no existe';
      return err(res, 400, 'illegal_move', `La columna ${JSON.stringify(column)} ${why}.`);
    }
    const state = applyMove(game, column, ms);
    // After a house reply the game may already be over for us (lost): the protocol only
    // reports the state right after OUR move, so `playing` is returned in that case.
    const out: Record<string, unknown> = { ok: true, state, turn: game.status === 'playing' ? game.moves.length + 1 : game.moves.length };
    if (state === 'won') out.winning_cells = game.result?.winning_cells;
    sendJson(res, 200, out);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mock');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/api/health') return sendJson(res, 200, { ok: true, phase, time: new Date().toISOString() });
    if (method === 'GET' && path === '/api/openapi.json') {
      try {
        return sendJson(res, 200, JSON.parse(readFileSync(DEFAULT_SPEC_PATH, 'utf8')));
      } catch {
        return err(res, 404, 'not_found', 'openapi.json no disponible');
      }
    }
    if (method === 'GET' && path === '/api/standings') return sendJson(res, 200, { phase, standings: standings() });
    if (method === 'GET' && path === '/api/state') {
      return sendJson(res, 200, {
        phase,
        standings: standings(),
        live: [...games.values()].filter((g) => g.status === 'playing').map((g) => ({ ...summary(g), board: g.grid })),
      });
    }
    if (method === 'GET' && path === '/api/games') {
      const kind = url.searchParams.get('kind');
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') ?? 50) || 50));
      const list = [...games.values()]
        .filter((g) => !kind || g.kind === kind)
        .sort((a, b) => b.createdSeq - a.createdSeq)
        .slice(0, limit)
        .map(summary);
      return sendJson(res, 200, list);
    }
    const gameMatch = /^\/api\/games\/([^/]+)$/.exec(path);
    if (method === 'GET' && gameMatch) {
      const game = games.get(decodeURIComponent(gameMatch[1]));
      if (!game) return err(res, 404, 'unknown_game', 'No existe.');
      return sendJson(res, 200, { ...summary(game), board: game.grid });
    }

    if (method === 'POST' && path === '/admin/match') {
      const body = await parseJson(req, res);
      if (!body) return;
      const find = (v: unknown) =>
        typeof v === 'string' ? (teams.has(v) ? v : [...teams].find(([, t]) => t.id === v)?.[0]) : undefined;
      const t1 = find(body.team1);
      const t2 = find(body.team2);
      if (!t1 || !t2) return err(res, 400, 'validation', 'team1/team2 deben ser tokens o ids de equipo.');
      const game = createMatch(t1, t2);
      return sendJson(res, 201, { game_id: game.game_id });
    }

    const isBot = ['/api/next', '/api/move', '/api/practice', '/api/me', '/api/me/submission'].includes(path);
    if (!isBot) return err(res, 404, 'not_found', `No existe ${method} ${path}`);
    const token = auth(req, res);
    if (!token) return;

    if (method === 'GET' && path === '/api/next') return handleNext(req, res, url, token);
    if (method === 'POST' && path === '/api/move') return handleMove(req, res, token);
    if (method === 'POST' && path === '/api/practice') {
      const body = await parseJson(req, res);
      if (!body) return;
      const opp = body.opponent ?? 'casa-basico';
      const first = body.first ?? 1;
      if (!HOUSE_BOTS.includes(opp as HouseBot)) return err(res, 400, 'validation', `Rival inválido: ${String(opp)}.`);
      if (first !== 1 && first !== 2) return err(res, 400, 'validation', `first inválido: ${String(first)}.`);
      const game = createPractice(token, opp as HouseBot, first);
      return sendJson(res, 201, { game_id: game.game_id, you: first });
    }
    if (method === 'GET' && path === '/api/me') {
      const team = teams.get(token)!;
      const pending = [...games.values()]
        .filter((g) => g.status === 'playing' && g.current !== null && sideOfToken(g, token) === g.current)
        .map((g) => g.game_id);
      return sendJson(res, 200, {
        team: { ...team, members: [] },
        standing: null,
        pending_turns: pending,
        submission: submissions.get(token) ?? null,
        phase,
      });
    }
    if (method === 'PUT' && path === '/api/me/submission') {
      const body = await parseJson(req, res);
      if (!body) return;
      const repo = body.repo_url;
      const commit = body.commit;
      if (typeof repo !== 'string' || !/^https?:\/\/(github\.com|bitbucket\.org)\/.+/.test(repo)) {
        return err(res, 400, 'validation', 'repo_url debe ser un repositorio de GitHub o Bitbucket.');
      }
      if (typeof commit !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(commit)) {
        return err(res, 400, 'validation', 'commit debe ser un hash hexadecimal de 7 a 40 caracteres.');
      }
      const record = { repo_url: repo, commit, registered_at: new Date().toISOString() };
      submissions.set(token, record);
      return sendJson(res, 200, record);
    }
    return err(res, 404, 'not_found', `No existe ${method} ${path}`);
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e) => {
      if (!res.headersSent) err(res, 500, 'internal', (e as Error).message);
      else res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://${opts.host && opts.host !== '0.0.0.0' ? opts.host : '127.0.0.1'}:${port}`,
    port,
    games,
    createMatch,
    createPractice,
    close: async () => {
      for (const g of games.values()) clearTimer(g);
      for (const w of waiters) waiters.delete(w);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

