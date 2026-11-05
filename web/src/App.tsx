import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Player } from '../../src/engine/rules.ts';
import { getBotStatus, getHealth, type Health, type TournamentStatus } from './api.ts';
import { Board, type PieceColor } from './components/Board.tsx';
import { BotInsight } from './components/BotInsight.tsx';
import { ControlPanel } from './components/ControlPanel.tsx';
import { Header, type ServerState } from './components/Header.tsx';
import { MoveHistory } from './components/MoveHistory.tsx';
import { ReplayView } from './components/ReplayView.tsx';
import { StatusBar } from './components/StatusBar.tsx';
import { Toast, type ToastMessage } from './components/Toast.tsx';
import { canUndo, type Level, type RejectReason, type Starter } from './logic/game.ts';
import { useGame } from './useGame.ts';

type Tab = 'play' | 'replay';

const HUMAN_COLOR: PieceColor = 'coral';
const BOT_COLOR: PieceColor = 'amber';
const STATUS_POLL_MS = 10_000;

function rejectionText(reason: RejectReason, column: number, hasError: boolean): string {
  switch (reason) {
    case 'full':
      return `La columna ${column + 1} está llena. Elige otra.`;
    case 'not-your-turn':
      return hasError ? 'Primero reintenta la jugada del bot.' : 'Espera: el bot está pensando.';
    case 'game-over':
      return 'La partida terminó. Pulsa «Jugar otra vez».';
    case 'out-of-range':
      return 'Esa columna no existe.';
  }
}

export function App() {
  const [tab, setTab] = useState<Tab>('play');
  const { state, dispatch } = useGame();
  const [nextStarter, setNextStarter] = useState<Starter>(state.starter);
  const [server, setServer] = useState<ServerState>('checking');
  const [health, setHealth] = useState<Health | null>(null);
  const [tournament, setTournament] = useState<TournamentStatus | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [shakeCol, setShakeCol] = useState<number | null>(null);

  // --- Server health ---------------------------------------------------------
  const checkHealth = useCallback(async (signal?: AbortSignal) => {
    setServer('checking');
    try {
      const h = await getHealth(signal);
      setHealth(h);
      setServer('up');
    } catch {
      if (signal?.aborted) return;
      setHealth(null);
      setServer('down');
    }
  }, []);

  useEffect(() => {
    const c = new AbortController();
    void checkHealth(c.signal);
    return () => c.abort();
  }, [checkHealth]);

  // A successful bot answer proves the server is up; a failure suggests it is down.
  useEffect(() => {
    if (state.error) void checkHealth();
  }, [state.error, checkHealth]);
  const serverUp = server === 'up';
  useEffect(() => {
    if (state.insight && !serverUp) void checkHealth();
    // Only when a new bot answer arrives.
  }, [state.insight]);

  const botEnabled = server === 'up' && health?.bot?.enabled === true;
  useEffect(() => {
    if (!botEnabled) return;
    let c = new AbortController();
    const poll = () => {
      c = new AbortController();
      getBotStatus(c.signal).then(setTournament, () => undefined);
    };
    poll();
    const id = setInterval(poll, STATUS_POLL_MS);
    return () => {
      clearInterval(id);
      c.abort();
    };
  }, [botEnabled]);

  // --- Illegal-move feedback ------------------------------------------------
  const rejection = state.rejection;
  useEffect(() => {
    if (!rejection) return;
    setToast({ text: rejectionText(rejection.reason, rejection.column, state.error !== null), id: rejection.nonce });
    if (rejection.reason !== 'full') return;
    setShakeCol(null);
    const raf = requestAnimationFrame(() => setShakeCol(rejection.column));
    const t = setTimeout(() => setShakeCol(null), 500);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
    // Only react to new rejections (nonce), not to unrelated state changes.
  }, [rejection?.nonce]);

  // --- Actions --------------------------------------------------------------
  const play = useCallback((column: number) => dispatch({ type: 'humanMove', column }), [dispatch]);
  const newGame = useCallback(() => dispatch({ type: 'restart', starter: nextStarter }), [dispatch, nextStarter]);

  const onStarter = (s: Starter) => {
    setNextStarter(s);
    // Nothing played yet by the human: switching who starts takes effect immediately.
    if (state.moves.length === 0 || (state.moves.length === 1 && state.starter === 'bot') || state.outcome.status !== 'playing') {
      dispatch({ type: 'restart', starter: s });
    }
  };
  const onLevel = (level: Level) => dispatch({ type: 'setLevel', level });

  useEffect(() => {
    if (tab !== 'play') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key >= '1' && e.key <= '8') {
        e.preventDefault();
        play(Number(e.key) - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab, play]);

  // --- Derived view data ----------------------------------------------------
  const thinking = state.pending !== null;
  const playing = state.outcome.status === 'playing';
  const humanTurn = playing && !thinking && !state.error;
  const colorOf = useCallback((p: Player): PieceColor => (p === state.human ? HUMAN_COLOR : BOT_COLOR), [state.human]);
  const nameOf = useCallback((p: Player) => (p === state.human ? 'Tú' : 'Bot'), [state.human]);
  const history = useMemo(
    () =>
      state.moves.map((column, i) => {
        const p: Player = i % 2 === 0 ? 1 : 2;
        return { name: nameOf(p), color: colorOf(p), column };
      }),
    [state.moves, nameOf, colorOf],
  );

  return (
    <div className="app">
      <Header server={server} health={health} tournament={tournament} />

      {server === 'down' && (
        <div className="server-down" role="alert" data-testid="server-down">
          <p>
            <strong>No hay conexión con el servidor del bot.</strong> Enciéndelo con <code>npm start</code> y
            vuelve a intentarlo.
          </p>
          <button type="button" className="btn btn--small" onClick={() => void checkHealth()} data-testid="health-retry">
            Reintentar conexión
          </button>
        </div>
      )}

      <nav className="tabs" role="tablist" aria-label="Secciones">
        <button
          type="button"
          role="tab"
          id="tab-play"
          aria-selected={tab === 'play'}
          aria-controls="panel-play"
          className={`tab${tab === 'play' ? ' is-active' : ''}`}
          onClick={() => setTab('play')}
          data-testid="tab-play"
        >
          Jugar
        </button>
        <button
          type="button"
          role="tab"
          id="tab-replay"
          aria-selected={tab === 'replay'}
          aria-controls="panel-replay"
          className={`tab${tab === 'replay' ? ' is-active' : ''}`}
          onClick={() => setTab('replay')}
          data-testid="tab-replay"
        >
          Repetir partida
        </button>
      </nav>

      <main>
        <div id="panel-play" role="tabpanel" aria-labelledby="tab-play" hidden={tab !== 'play'} className="play">
          <aside className="play__side">
            <ControlPanel
              starter={nextStarter}
              level={state.level}
              canUndo={canUndo(state)}
              onStarter={onStarter}
              onLevel={onLevel}
              onNewGame={newGame}
              onUndo={() => dispatch({ type: 'undo' })}
            />
            <BotInsight info={state.insight} thinking={thinking} />
            <MoveHistory entries={history} />
          </aside>
          <section className="play__main" aria-label="Partida">
            <StatusBar
              outcome={state.outcome}
              human={state.human}
              humanColor={HUMAN_COLOR}
              botColor={BOT_COLOR}
              thinking={thinking}
              error={state.error}
              onRetry={() => dispatch({ type: 'retry' })}
              onPlayAgain={newGame}
            />
            <Board
              grid={state.grid}
              lastMove={state.lastMove}
              winningCells={state.outcome.status === 'won' ? state.outcome.cells : []}
              colorOf={colorOf}
              nameOf={nameOf}
              interactive
              locked={!humanTurn}
              ghost={HUMAN_COLOR}
              onColumn={play}
              shakeCol={shakeCol}
              label="Tablero de juego, 8 columnas por 7 filas"
            />
            <p className="legend">
              <span>
                <span className={`dot dot--${HUMAN_COLOR}`} aria-hidden="true" /> Tú
              </span>
              <span>
                <span className={`dot dot--${BOT_COLOR}`} aria-hidden="true" /> Bot
              </span>
              <span className="muted">
                {state.starter === 'human' ? 'Abriste tú' : 'Abrió el bot'} · nivel {levelLabel(state.level)}
              </span>
            </p>
          </section>
        </div>

        <div id="panel-replay" role="tabpanel" aria-labelledby="tab-replay" hidden={tab !== 'replay'}>
          <ReplayView />
        </div>
      </main>

      <Toast message={toast} />
    </div>
  );
}

function levelLabel(level: Level): string {
  return { facil: 'Fácil', medio: 'Medio', dificil: 'Difícil', maximo: 'Máximo' }[level];
}
