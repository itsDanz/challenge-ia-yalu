/**
 * Typed HTTP client for the tournament arbiter (docs/arbitro-openapi.json v1.0.1).
 *
 * Every read of the protocol lives here. Parsing is tolerant: extra fields are ignored and
 * only the fields the bot needs are validated. `fetch` is injectable so tests run without
 * a network.
 */

import type { Grid, Player } from '../engine/rules.ts';

export type GameKind = 'practice' | 'friendly' | 'league' | 'third_place' | 'final';

export interface Turn {
  status: 'turn';
  game_id: string;
  match_id: string | null;
  kind: GameKind | string;
  you: Player;
  opponent: string;
  turn: number;
  board: Grid;
  moves: number[];
  last_move: { by: Player; column: number } | null;
  legal_moves: number[];
  deadline_ms: number;
  served_at: string;
}

export interface Idle {
  status: 'idle';
}

export type NextResult = Turn | Idle;

export interface MoveAccepted {
  ok: true;
  state: 'playing' | 'won' | 'draw' | string;
  turn?: number;
  winning_cells?: [number, number][];
}

export interface Me {
  team: { id: string; name: string; members?: string[] };
  standing?: Record<string, number> | null;
  pending_turns?: string[];
  submission?: { repo_url: string; commit: string; registered_at?: string } | null;
  phase?: string;
}

export interface PracticeCreated {
  game_id: string;
  you?: Player;
}

export interface SubmissionRecord {
  repo_url: string;
  commit: string;
  registered_at?: string;
}

export interface Health {
  ok: boolean;
  phase?: string;
  time?: string;
}

/** Any non-2xx answer from the arbiter, with the protocol error code when present. */
export class ArbiterError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;
  constructor(status: number, code: string, message: string, body?: unknown) {
    super(message);
    this.name = 'ArbiterError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/** 401: token missing or invalid. The bot must shout about this. */
export class UnauthorizedError extends ArbiterError {
  constructor(message: string, body?: unknown) {
    super(401, 'unauthorized', message, body);
    this.name = 'UnauthorizedError';
  }
}

/** Network failure, DNS, connection reset, request timeout, or unparsable body. */
export class NetworkError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export interface ArbiterClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  /** Timeout for regular requests (ms). Default 8000. `next` uses wait + 10 s. */
  timeoutMs?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIntArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => Number.isInteger(v));
}

/** Validates and normalises a `/api/next` payload. Throws NetworkError on garbage. */
export function parseNext(body: unknown): NextResult {
  if (!isObject(body)) throw new NetworkError('Respuesta de /api/next no es un objeto');
  if (body.status === 'idle') return { status: 'idle' };
  if (body.status !== 'turn') throw new NetworkError(`status desconocido en /api/next: ${String(body.status)}`);
  const you = body.you;
  if (you !== 1 && you !== 2) throw new NetworkError('Turno sin "you" válido');
  if (typeof body.game_id !== 'string' || body.game_id === '') throw new NetworkError('Turno sin game_id');
  const moves = isIntArray(body.moves) ? body.moves : [];
  const legal = isIntArray(body.legal_moves) ? body.legal_moves : [];
  const last = isObject(body.last_move) ? body.last_move : null;
  return {
    status: 'turn',
    game_id: body.game_id,
    match_id: typeof body.match_id === 'string' ? body.match_id : null,
    kind: typeof body.kind === 'string' ? body.kind : 'unknown',
    you,
    opponent: typeof body.opponent === 'string' ? body.opponent : '?',
    turn: Number.isInteger(body.turn) ? (body.turn as number) : moves.length + 1,
    board: body.board as Grid,
    moves,
    last_move: last && (last.by === 1 || last.by === 2) && Number.isInteger(last.column)
      ? { by: last.by, column: last.column as number }
      : null,
    legal_moves: legal,
    deadline_ms: typeof body.deadline_ms === 'number' ? body.deadline_ms : 3000,
    served_at: typeof body.served_at === 'string' ? body.served_at : new Date().toISOString(),
  };
}

export class ArbiterClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ArbiterClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  /** Long polling: holds up to `waitSec` (clamped 0..25) until a turn is available. */
  async next(waitSec = 20, signal?: AbortSignal): Promise<NextResult> {
    const wait = Math.max(0, Math.min(25, Math.floor(waitSec)));
    const body = await this.request('GET', `/api/next?wait=${wait}`, undefined, wait * 1000 + 10_000, signal);
    return parseNext(body);
  }

  async move(gameId: string, column: number): Promise<MoveAccepted> {
    const body = await this.request('POST', '/api/move', { game_id: gameId, column });
    if (!isObject(body)) throw new NetworkError('Respuesta de /api/move no es un objeto');
    return body as unknown as MoveAccepted;
  }

  async me(): Promise<Me> {
    return (await this.request('GET', '/api/me')) as Me;
  }

  /** PATCH /api/me (OpenAPI 1.1.0): changes the team's visible name. */
  async rename(name: string): Promise<Me['team']> {
    return (await this.request('PATCH', '/api/me', { name })) as Me['team'];
  }

  async practice(opponent = 'casa-basico', first: Player = 1): Promise<PracticeCreated> {
    return (await this.request('POST', '/api/practice', { opponent, first })) as PracticeCreated;
  }

  async submission(repoUrl: string, commit: string): Promise<SubmissionRecord> {
    return (await this.request('PUT', '/api/me/submission', { repo_url: repoUrl, commit })) as SubmissionRecord;
  }

  async game(id: string): Promise<unknown> {
    return this.request('GET', `/api/games/${encodeURIComponent(id)}`);
  }

  async health(): Promise<Health> {
    return (await this.request('GET', '/api/health')) as Health;
  }

  private async request(
    method: string,
    path: string,
    payload?: unknown,
    timeoutMs = this.timeoutMs,
    external?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    external?.addEventListener('abort', onExternalAbort, { once: true });
    const headers: Record<string, string> = { Accept: 'application/json', Authorization: `Bearer ${this.token}` };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    let text: string;
    try {
      res = await this.fetchFn(this.baseUrl + path, {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      const aborted = controller.signal.aborted;
      throw new NetworkError(
        aborted ? `${method} ${path}: sin respuesta en ${timeoutMs} ms` : `${method} ${path}: ${(err as Error)?.message ?? err}`,
        err,
      );
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    }
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        if (res.ok) throw new NetworkError(`${method} ${path}: respuesta no es JSON`);
        body = { message: text.slice(0, 200) };
      }
    }
    if (res.ok) return body;
    const code = isObject(body) && typeof body.error === 'string' ? body.error : `http_${res.status}`;
    const message = isObject(body) && typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
    if (res.status === 401) throw new UnauthorizedError(message, body);
    throw new ArbiterError(res.status, code, message, body);
  }
}
