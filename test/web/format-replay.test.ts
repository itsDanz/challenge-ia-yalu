import { describe, expect, it } from 'vitest';
import { WIN_SCORE, evaluate, formatMs, formatNodes, sourceLabel } from '../../web/src/logic/format.ts';
import { frameAt, parseReplay, reasonLabel } from '../../web/src/logic/replay.ts';

describe('format', () => {
  it('formats node counts', () => {
    expect(formatNodes(950)).toBe('950');
    expect(formatNodes(4_321)).toBe('4.3 mil');
    expect(formatNodes(250_000)).toBe('250 mil');
    expect(formatNodes(3_450_000)).toBe('3.45 M');
    expect(formatNodes(-1)).toBe('—');
  });

  it('formats times', () => {
    expect(formatMs(42.4)).toBe('42 ms');
    expect(formatMs(1500)).toBe('1.50 s');
    expect(formatMs(Number.NaN)).toBe('—');
  });

  it('reads forced wins and losses from the bot perspective', () => {
    expect(evaluate(WIN_SCORE - 7)).toMatchObject({ kind: 'bot-wins', botShare: 1, text: 'El bot ve victoria forzada en 7 jugadas' });
    expect(evaluate(-(WIN_SCORE - 1))).toMatchObject({ kind: 'bot-loses', botShare: 0, text: 'El bot ve derrota forzada en 1 jugada' });
    expect(evaluate(WIN_SCORE).text).toBe('El bot ve victoria forzada');
  });

  it('maps heuristic scores to a bounded bar', () => {
    expect(evaluate(0)).toMatchObject({ kind: 'even', botShare: 0.5 });
    const good = evaluate(300);
    expect(good.kind).toBe('bot-better');
    expect(good.botShare).toBeGreaterThan(0.5);
    expect(good.botShare).toBeLessThan(1);
    expect(evaluate(-300).kind).toBe('human-better');
    expect(evaluate(Number.NaN).kind).toBe('even');
  });

  it('labels the move source', () => {
    expect(sourceLabel('book')).toBe('Libro de aperturas');
    expect(sourceLabel('forced')).toBe('Jugada forzada');
    expect(sourceLabel('search')).toBe('Búsqueda');
    expect(sourceLabel('otro')).toBe('otro');
  });
});

const record = {
  game_id: 'g_1',
  kind: 'league',
  status: 'finished',
  players: { '1': { team_id: 'e3', name: 'Equipo 3' }, '2': { team_id: 'e5', name: 'Equipo 5' } },
  moves: [0, 7, 1, 7, 2, 7, 3].map((column, i) => ({ turn: i + 1, by: (i % 2) + 1, column, ms: 10 })),
  result: { winner: 1, reason: 'connect4', winning_cells: [[0, 0], [0, 1], [0, 2], [0, 3]] },
  board: [],
};

describe('replay', () => {
  it('parses an arbiter game record', () => {
    const r = parseReplay(record);
    expect(r.players).toEqual({ 1: 'Equipo 3', 2: 'Equipo 5' });
    expect(r.columns).toEqual([0, 7, 1, 7, 2, 7, 3]);
    expect(r.winner).toBe(1);
    expect(r.winningCells).toHaveLength(4);
  });

  it('rejects malformed records', () => {
    expect(() => parseReplay(null)).toThrow();
    expect(() => parseReplay({ moves: [{ column: 'x' }] })).toThrow();
  });

  it('builds frames step by step and shows the line at the end', () => {
    const r = parseReplay(record);
    expect(frameAt(r, 0).grid.flat().every((c) => c === 0)).toBe(true);
    const f2 = frameAt(r, 2);
    expect(f2.grid[0][0]).toBe(1);
    expect(f2.grid[0][7]).toBe(2);
    expect(f2.lastMove).toEqual({ row: 0, col: 7 });
    expect(frameAt(r, 7).winningCells).toHaveLength(4);
    expect(frameAt(r, 99).applied).toBe(7);
  });

  it('stops at an illegal move instead of throwing', () => {
    const r = parseReplay({ ...record, moves: [0, 0, 0, 0, 0, 0, 0, 0, 1].map((column) => ({ column })), result: null });
    expect(frameAt(r, 9).applied).toBe(7);
    expect(r.winner).toBeNull();
  });

  it('translates result reasons', () => {
    expect(reasonLabel('connect4')).toBe('cuatro en línea');
    expect(reasonLabel('timeout')).toBe('tiempo agotado');
    expect(reasonLabel(null)).toBe('');
    expect(reasonLabel('nuevo_motivo')).toBe('nuevo motivo');
  });
});

describe('engine contract', () => {
  it('uses the same win score as the engine', async () => {
    const web = await import('../../web/src/logic/format.ts');
    const engine = await import('../../src/engine/index.ts');
    expect(web.WIN_SCORE).toBe(engine.WIN_SCORE);
  });
});
