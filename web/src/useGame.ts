import { useEffect, useReducer, useRef } from 'react';
import { requestBotMove } from './api.ts';
import { gameReducer, initialState, type GameAction, type GameState } from './logic/game.ts';

/** Minimum time the "thinking" indicator stays visible, so instant answers don't flicker. */
const MIN_THINK_MS = 350;

export function useGame(): { state: GameState; dispatch: (action: GameAction) => void } {
  const [state, dispatch] = useReducer(gameReducer, undefined, () => initialState('human', 'medio'));
  const stateRef = useRef(state);
  stateRef.current = state;

  const pendingId = state.pending?.id ?? null;

  useEffect(() => {
    if (pendingId === null) return;
    const { moves, level } = stateRef.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = performance.now();

    requestBotMove(moves, level, controller.signal).then(
      (info) => {
        const wait = Math.max(0, MIN_THINK_MS - (performance.now() - started));
        timer = setTimeout(() => dispatch({ type: 'botResponse', requestId: pendingId, info }), wait);
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : 'Error desconocido.';
        dispatch({ type: 'botError', requestId: pendingId, message });
      },
    );

    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [pendingId]);

  return { state, dispatch };
}
