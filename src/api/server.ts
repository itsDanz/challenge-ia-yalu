/**
 * HTTP API for the web app + static files of web/dist. node:http only.
 *
 *   GET  /api/health          { ok, version, bot: { enabled, connected } }
 *   POST /api/bot/move        { moves, level } → SearchResult (stateless: the client sends all moves)
 *   GET  /api/bot/status      tournament bot status
 *   GET  /api/replay/:gameId  proxy to {arbiter}/api/games/{id}
 *   GET  /*                   web/dist with SPA fallback
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gridFromMoves, outcome, type Player } from '../engine/rules.ts';
import type { EngineLike, SearchOptions } from './enginePool.ts';

export const VERSION = '1.0.0';
export const BODY_LIMIT = 16 * 1024;

export const LEVELS: Record<string, SearchOptions> = {
  facil: { timeMs: 150, maxDepth: 2, randomness: 0.35 },
  medio: { timeMs: 400, maxDepth: 6 },
  dificil: { timeMs: 1000 },
  maximo: { timeMs: 1500 },
};

export interface ArbiterProxy {
  game(id: string): Promise<unknown>;
}

export interface ServerOptions {
  webEngine: EngineLike;
  /** Returns the tournament bot status, or null when the bot is disabled. */
  botStatus?: () => ({ connected: boolean } & Record<string, unknown>) | null;
  arbiter?: ArbiterProxy | null;
  staticDir?: string;
  log?: (line: string) => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new HttpError(413, 'validation', 'Cuerpo demasiado grande.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'validation', 'JSON inválido.');
  }
}

const NO_WEB_HTML = `<!doctype html><html lang="es"><meta charset="utf-8"><title>Cuatro en línea</title>
<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.5">
<h1>La app web no está compilada</h1>
<p>Ejecuta <code>npm run build:web</code> y recarga esta página. La API sigue disponible en
<a href="/api/health">/api/health</a>.</p></body></html>`;

export function createServer(opts: ServerOptions): Server {
  const log = opts.log ?? (() => {});
  const staticRoot = opts.staticDir ? resolve(opts.staticDir) : null;

  async function botMove(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = (await readJson(req)) as { moves?: unknown; level?: unknown } | null;
    if (!body || typeof body !== 'object') throw new HttpError(400, 'validation', 'Se esperaba un objeto JSON.');
    const moves = body.moves ?? [];
    if (!Array.isArray(moves) || moves.length > 56 || !moves.every((m) => Number.isInteger(m))) {
      throw new HttpError(400, 'validation', '"moves" debe ser una lista de columnas enteras.');
    }
    const level = body.level ?? 'dificil';
    const opts2 = typeof level === 'string' ? LEVELS[level] : undefined;
    if (!opts2) throw new HttpError(400, 'validation', `Nivel inválido: ${String(level)}. Usa facil, medio, dificil o maximo.`);
    let grid;
    try {
      grid = gridFromMoves(moves as number[]);
    } catch (err) {
      throw new HttpError(400, 'illegal_position', (err as Error).message);
    }
    const state = outcome(grid);
    if (state.status !== 'playing') throw new HttpError(400, 'illegal_position', 'La partida ya terminó.');
    const toMove: Player = state.next;
    const result = await opts.webEngine.search(grid, toMove, { ...opts2 });
    sendJson(res, 200, result);
  }

  async function replay(res: ServerResponse, id: string): Promise<void> {
    if (!opts.arbiter) throw new HttpError(503, 'no_arbiter', 'No hay árbitro configurado (ARBITRO_URL).');
    try {
      sendJson(res, 200, await opts.arbiter.game(id));
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) throw new HttpError(404, 'unknown_game', `La partida ${id} no existe.`);
      throw new HttpError(502, 'arbiter_error', `Árbitro: ${(err as Error).message}`);
    }
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method', 'Método no permitido.');
    const indexPath = staticRoot ? join(staticRoot, 'index.html') : null;
    if (!staticRoot || !indexPath || !(await isFile(indexPath))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(NO_WEB_HTML);
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new HttpError(400, 'validation', 'Ruta inválida.');
    }
    const target = normalize(join(staticRoot, decoded));
    const inside = target === staticRoot || target.startsWith(staticRoot + sep);
    const file = inside && (await isFile(target)) ? target : indexPath; // SPA fallback
    const data = await readFile(file);
    const isAsset = file !== indexPath && file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (path === '/api/health' && method === 'GET') {
      const bot = opts.botStatus?.() ?? null;
      return sendJson(res, 200, { ok: true, version: VERSION, bot: { enabled: bot !== null, connected: bot?.connected ?? false } });
    }
    if (path === '/api/bot/move' && method === 'POST') return botMove(req, res);
    if (path === '/api/bot/status' && method === 'GET') {
      const bot = opts.botStatus?.() ?? null;
      return sendJson(res, 200, bot ? { enabled: true, ...bot } : { enabled: false, connected: false });
    }
    const m = /^\/api\/replay\/([^/]+)$/.exec(path);
    if (m && method === 'GET') return replay(res, decodeURIComponent(m[1]));
    if (path.startsWith('/api/')) throw new HttpError(404, 'not_found', `No existe ${method} ${path}`);
    return serveStatic(req, res, path);
  }

  return createHttpServer((req, res) => {
    route(req, res).catch((err) => {
      const e = err instanceof HttpError ? err : new HttpError(500, 'internal', (err as Error)?.message ?? 'error');
      if (e.status >= 500) log(`[api] ${req.method} ${req.url} → ${e.status} ${e.message}`);
      if (res.headersSent) return void res.end();
      sendJson(res, e.status, { error: e.code, message: e.message });
      if (e.status === 413) req.resume();
    });
  });
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
