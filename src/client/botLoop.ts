/**
 * Tournament bot main loop: ask for a turn (long polling) → decide → validate → send.
 *
 * Reliability rules (a loss by timeout, illegal move or absence is a catastrophe):
 * - The loop never exits on its own; network errors back off 250 ms → 2 s, 401 retries every 5 s.
 * - The decider is raced against a hard deadline; on error/timeout we play a safe fallback.
 * - Every column is checked against the arbiter's `legal_moves` AND rules.ts before sending.
 */

import {
  COLS,
  dropPiece,
  findWinner,
  gridFromMoves,
  isLegalMove,
  isValidGrid,
  opponent,
  playerToMove,
  type Grid,
  type Player,
} from '../engine/rules.ts';
import { ArbiterError, UnauthorizedError, type MoveAccepted, type NextResult, type Turn } from './arbiterClient.ts';

/** Shape compatible with the engine's SearchResult (only `column` is required). */
export interface Decision {
  column: number;
  score?: number;
  depth?: number;
  nodes?: number;
  timeMs?: number;
  pv?: number[];
  source?: string;
}

export interface DecideInput {
  turn: Turn;
  grid: Grid;
  toMove: Player;
  /** Milliseconds the decider may use (already below the hard deadline). */
  budgetMs: number;
}

export type Decider = (input: DecideInput) => Promise<Decision>;

export interface LoopClient {
  next(waitSec?: number, signal?: AbortSignal): Promise<NextResult>;
  move(gameId: string, column: number): Promise<MoveAccepted>;
}

export interface BotLoopOptions {
  client: LoopClient;
  decide: Decider;
  /** Long-polling wait in seconds (default 20). */
  waitSec?: number;
  /** Max ms from receiving the turn until we stop waiting for the decider (default 2200). */
  hardDeadlineMs?: number;
  /** Think budget handed to the decider (default 1500). */
  thinkMs?: number;
  /** Called when a game id not seen before arrives (e.g. reset the engine's TT). */
  onNewGame?: (gameId: string, turn: Turn) => void | Promise<void>;
  log?: (line: string) => void;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  unauthorizedRetryMs?: number;
}

export interface LastMove {
  gameId: string;
  turn: number;
  column: number;
  depth: number | null;
  score: number | null;
  ms: number;
  source: string;
  state: string | null;
  at: string;
}

export interface BotStatus {
  running: boolean;
  connected: boolean;
  authorized: boolean;
  games: number;
  moves: number;
  avgDepth: number | null;
  fallbacks: number;
  rejected: number;
  currentGameId: string | null;
  lastMove: LastMove | null;
  lastError: { message: string; at: string } | null;
  results: { won: number; draw: number };
  startedAt: string | null;
  lastPollAt: string | null;
}

/** Columns ordered centre first: 3, 4, 2, 5, 1, 6, 0, 7. */
export const CENTER_ORDER: readonly number[] = Array.from({ length: COLS }, (_, i) => i).sort(
  (a, b) => Math.abs(a - (COLS - 1) / 2) - Math.abs(b - (COLS - 1) / 2) || a - b,
);

/** Columns legal both for the arbiter list (when present) and on the grid. */
export function safeLegalMoves(grid: Grid, arbiterLegal: readonly number[]): number[] {
  const onGrid = CENTER_ORDER.filter((c) => isLegalMove(grid, c));
  if (arbiterLegal.length === 0) return onGrid;
  const both = onGrid.filter((c) => arbiterLegal.includes(c));
  // If they disagree completely, trust the arbiter: it is the one that judges.
  return both.length > 0 ? both : CENTER_ORDER.filter((c) => arbiterLegal.includes(c));
}

/** Instant safe move: win now, else block an immediate four, else centre-most legal. */
export function fallbackMove(grid: Grid, toMove: Player, legal: readonly number[]): number {
  const wins = (player: Player) =>
    legal.find((c) => isLegalMove(grid, c) && findWinner(dropPiece(grid, c, player).grid)?.winner === player);
  const win = wins(toMove);
  if (win !== undefined) return win;
  const block = wins(opponent(toMove));
  if (block !== undefined) return block;
  return legal[0];
}

/** Picks the grid to trust: the arbiter board if valid, else the one rebuilt from `moves`. */
export function resolveGrid(turn: Turn): Grid | null {
  if (isValidGrid(turn.board)) return turn.board;
  try {
    return gridFromMoves(turn.moves);
  } catch {
    return null;
  }
}

const sleepTimer = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

const TIMEOUT = Symbol('timeout');

export class BotLoop {
  private readonly opts: Required<Omit<BotLoopOptions, 'onNewGame'>> & Pick<BotLoopOptions, 'onNewGame'>;
  private abort = new AbortController();
  private loopPromise: Promise<void> | null = null;
  private readonly seenGames = new Set<string>();
  private depthSum = 0;
  private depthCount = 0;
  private lastSent: { gameId: string; turn: number; column: number } | null = null;
  private firstSeen: { key: string; at: number } | null = null;
  private state: BotStatus = {
    running: false,
    connected: false,
    authorized: true,
    games: 0,
    moves: 0,
    avgDepth: null,
    fallbacks: 0,
    rejected: 0,
    currentGameId: null,
    lastMove: null,
    lastError: null,
    results: { won: 0, draw: 0 },
    startedAt: null,
    lastPollAt: null,
  };

  constructor(opts: BotLoopOptions) {
    this.opts = {
      waitSec: 20,
      hardDeadlineMs: 2200,
      thinkMs: 1500,
      log: (line) => console.log(line),
      backoffMinMs: 250,
      backoffMaxMs: 2000,
      unauthorizedRetryMs: 5000,
      ...opts,
    };
  }

  status(): BotStatus {
    return { ...this.state, results: { ...this.state.results } };
  }

  /** Starts the loop in the background. Returns the loop promise (resolves after stop()). */
  start(): Promise<void> {
    if (this.loopPromise) return this.loopPromise;
    this.abort = new AbortController();
    this.state.running = true;
    this.state.startedAt = new Date().toISOString();
    this.loopPromise = this.run().finally(() => {
      this.state.running = false;
      this.loopPromise = null;
    });
    return this.loopPromise;
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loopPromise;
  }

  private get stopped(): boolean {
    return this.abort.signal.aborted;
  }

  private async run(): Promise<void> {
    let backoff = this.opts.backoffMinMs;
    // The first poll does not wait, so the connection status is known right away.
    let waitSec = 0;
    while (!this.stopped) {
      try {
        const res = await this.opts.client.next(waitSec, this.abort.signal);
        waitSec = this.opts.waitSec;
        this.state.lastPollAt = new Date().toISOString();
        this.state.connected = true;
        this.state.authorized = true;
        backoff = this.opts.backoffMinMs;
        if (res.status === 'turn' && !this.stopped) await this.handleTurn(res);
      } catch (err) {
        if (this.stopped) break;
        this.recordError(err);
        if (err instanceof UnauthorizedError) {
          this.state.authorized = false;
          this.opts.log(`[bot] !!! 401 TOKEN INVÁLIDO: revisa TEAM_TOKEN. Reintento en ${this.opts.unauthorizedRetryMs} ms`);
          await sleepTimer(this.opts.unauthorizedRetryMs, this.abort.signal);
        } else {
          this.state.connected = false;
          this.opts.log(`[bot] error de red: ${(err as Error).message}. Reintento en ${backoff} ms`);
          await sleepTimer(backoff, this.abort.signal);
          backoff = Math.min(backoff * 2, this.opts.backoffMaxMs);
        }
      }
    }
  }

  /** Decides and sends one move. Never throws for decider problems. Exposed for tests. */
  async handleTurn(turn: Turn): Promise<void> {
    // If the same turn is served again (lost response), the arbiter clock kept running since
    // we first saw it: measure the budget from then, not from now.
    const key = `${turn.game_id}#${turn.turn}`;
    if (this.firstSeen?.key !== key) this.firstSeen = { key, at: Date.now() };
    const receivedAt = this.firstSeen.at;
    if (!this.seenGames.has(turn.game_id)) {
      this.seenGames.add(turn.game_id);
      this.state.games = this.seenGames.size;
      this.opts.log(`[bot] partida nueva ${turn.game_id} (${turn.kind}) vs ${turn.opponent}, somos ${turn.you}`);
      try {
        await this.opts.onNewGame?.(turn.game_id, turn);
      } catch (err) {
        this.opts.log(`[bot] onNewGame falló: ${(err as Error).message}`);
      }
    }
    this.state.currentGameId = turn.game_id;

    const grid = resolveGrid(turn);
    const toMove = turn.you;
    const legal = grid ? safeLegalMoves(grid, turn.legal_moves) : CENTER_ORDER.filter((c) => turn.legal_moves.includes(c));
    if (legal.length === 0) {
      this.opts.log(`[bot] ${turn.game_id} t${turn.turn}: sin jugadas legales, se ignora`);
      return;
    }
    if (grid && playerToMove(grid) !== toMove) {
      this.opts.log(`[bot] aviso: el tablero sugiere jugador ${playerToMove(grid)} pero you=${toMove}; uso you`);
    }

    let decision: Decision | null = null;
    let source = 'search';
    const repeat = this.lastSent && this.lastSent.gameId === turn.game_id && this.lastSent.turn === turn.turn;
    if (repeat && legal.includes(this.lastSent!.column)) {
      // Same turn served again (e.g. our POST was lost): resend the same column at once.
      decision = { column: this.lastSent!.column };
      source = 'repeat';
    } else if (grid) {
      decision = await this.decideSafely(turn, grid, toMove, Date.now() - receivedAt);
      if (decision && !legal.includes(decision.column)) {
        this.opts.log(`[bot] !!! el decisor propuso columna ilegal ${decision.column}; uso fallback`);
        decision = null;
      }
      if (decision) source = decision.source ?? 'search';
    }
    if (!decision) {
      this.state.fallbacks++;
      source = 'fallback';
      decision = { column: grid ? fallbackMove(grid, toMove, legal) : legal[0] };
    }

    const column = decision.column;
    this.lastSent = { gameId: turn.game_id, turn: turn.turn, column };
    const result = await this.sendMove(turn, column, receivedAt);
    const ms = Date.now() - receivedAt;
    if (decision.depth !== undefined) {
      this.depthSum += decision.depth;
      this.depthCount++;
      this.state.avgDepth = Math.round((this.depthSum / this.depthCount) * 10) / 10;
    }
    if (result) {
      this.state.moves++;
      if (result.state === 'won') this.state.results.won++;
      if (result.state === 'draw') this.state.results.draw++;
    }
    this.state.lastMove = {
      gameId: turn.game_id,
      turn: turn.turn,
      column,
      depth: decision.depth ?? null,
      score: decision.score ?? null,
      ms,
      source,
      state: result?.state ?? null,
      at: new Date().toISOString(),
    };
    this.opts.log(
      `[bot] ${turn.game_id} t${turn.turn} you=${turn.you} col=${column} depth=${decision.depth ?? '-'} ` +
        `score=${decision.score ?? '-'} src=${source} ${ms}ms -> ${result?.state ?? 'sin confirmar'}`,
    );
  }

  private async decideSafely(turn: Turn, grid: Grid, toMove: Player, elapsedMs: number): Promise<Decision | null> {
    const hard = Math.min(this.opts.hardDeadlineMs, turn.deadline_ms - 700) - elapsedMs;
    if (hard < 250) {
      this.opts.log(`[bot] !!! turno re-servido con poco tiempo (${elapsedMs} ms usados); fallback inmediato`);
      return null;
    }
    const budgetMs = Math.max(50, Math.min(this.opts.thinkMs, hard - 300));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await Promise.race([
        this.opts.decide({ turn, grid, toMove, budgetMs }),
        new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT), hard);
        }),
      ]);
      if (out === TIMEOUT) {
        this.opts.log(`[bot] !!! el decisor superó ${hard} ms; uso fallback`);
        return null;
      }
      if (!out || !Number.isInteger(out.column)) return null;
      return out;
    } catch (err) {
      this.recordError(err);
      this.opts.log(`[bot] !!! el decisor falló: ${(err as Error)?.message ?? err}; uso fallback`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** POSTs the move, retrying network failures while there is time left. */
  private async sendMove(turn: Turn, column: number, receivedAt: number): Promise<MoveAccepted | null> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.opts.client.move(turn.game_id, column);
      } catch (err) {
        this.recordError(err);
        // 5xx/429: the arbiter had a transient problem, so retry like a network error.
        const transient = err instanceof ArbiterError && (err.status >= 500 || err.status === 429);
        if (err instanceof ArbiterError && !transient) {
          if (err.status === 409) {
            this.opts.log(`[bot] 409 ${err.code} en ${turn.game_id}: se ignora`);
          } else {
            if (err.status === 400) this.state.rejected++;
            this.opts.log(`[bot] !!! jugada rechazada ${err.status} ${err.code}: ${err.message}`);
          }
          return null;
        }
        const left = turn.deadline_ms - (Date.now() - receivedAt);
        if (left < 400 || attempt >= 4 || this.stopped) {
          this.opts.log(`[bot] !!! no se pudo enviar la jugada: ${(err as Error).message}`);
          return null;
        }
        await sleepTimer(100, this.abort.signal);
      }
    }
  }

  private recordError(err: unknown): void {
    this.state.lastError = { message: (err as Error)?.message ?? String(err), at: new Date().toISOString() };
  }
}
