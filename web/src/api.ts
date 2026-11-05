/**
 * HTTP client for the bot server (same origin; Vite proxies /api in development).
 *
 * Static mode (VITE_ENGINE=browser, used for the Vercel deployment): there is no Node server, so
 * the bot runs in a Web Worker with the same src/engine code, and replays are read straight from
 * the public arbiter (it allows CORS).
 */
import type { BotInfo, Level } from './logic/game.ts';
import { searchInBrowser } from './browserEngine.ts';

export const STATIC_MODE = import.meta.env.VITE_ENGINE === 'browser';
const ARBITRO_URL = (import.meta.env.VITE_ARBITRO_URL ?? 'https://ai-challenge.yompi.com').replace(/\/+$/, '');

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
  const raw = STATIC_MODE
    ? await searchInBrowser(moves, level, signal)
    : await request<Record<string, unknown>>('/api/bot/move', {
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
  if (STATIC_MODE) return Promise.resolve({ ok: true, version: 'web', bot: { enabled: false, connected: false } });
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
  if (STATIC_MODE) return Promise.resolve({ enabled: false });
  return request<TournamentStatus>('/api/bot/status', { signal });
}

export function getReplay(gameId: string, signal?: AbortSignal): Promise<unknown> {
  const path = `/api/replay/${encodeURIComponent(gameId)}`;
  if (STATIC_MODE) return request<unknown>(`${ARBITRO_URL}/api/games/${encodeURIComponent(gameId)}`, { signal });
  return request<unknown>(path, { signal });
}
