/** HTTP client for the bot server (same origin; Vite proxies /api in development). */
import type { BotInfo, Level } from './logic/game.ts';

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const OFFLINE_MESSAGE = 'No hay conexión con el servidor del bot.';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(OFFLINE_MESSAGE, 0);
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON body (e.g. the Vite proxy returning an HTML error page).
  }
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : res.status >= 500
          ? OFFLINE_MESSAGE
          : `Error ${res.status}`;
    throw new ApiError(message, res.status);
  }
  if (body === null) throw new ApiError('Respuesta inesperada del servidor.', res.status);
  return body as T;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export async function requestBotMove(moves: number[], level: Level, signal?: AbortSignal): Promise<BotInfo> {
  const raw = await request<Record<string, unknown>>('/api/bot/move', {
    method: 'POST',
    body: JSON.stringify({ moves, level }),
    signal,
  });
  if (!Number.isInteger(raw.column)) throw new ApiError('Respuesta del bot sin columna.', 200);
  return {
    column: raw.column as number,
    score: num(raw.score),
    depth: num(raw.depth),
    nodes: num(raw.nodes),
    timeMs: num(raw.timeMs),
    pv: Array.isArray(raw.pv) ? raw.pv.filter((c): c is number => Number.isInteger(c)) : [],
    source: typeof raw.source === 'string' ? raw.source : 'search',
  };
}

export interface Health {
  ok: boolean;
  version?: string;
  bot?: { enabled: boolean; connected: boolean };
}

export function getHealth(signal?: AbortSignal): Promise<Health> {
  return request<Health>('/api/health', { signal });
}

export interface TournamentStatus {
  enabled?: boolean;
  connected?: boolean;
  games?: number;
  gamesPlayed?: number;
  [key: string]: unknown;
}

export function getBotStatus(signal?: AbortSignal): Promise<TournamentStatus> {
  return request<TournamentStatus>('/api/bot/status', { signal });
}

export function getReplay(gameId: string, signal?: AbortSignal): Promise<unknown> {
  return request<unknown>(`/api/replay/${encodeURIComponent(gameId)}`, { signal });
}
