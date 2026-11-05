/**
 * Leaf evaluation, from the side-to-move's perspective.
 *
 * Ingredients (all bit operations):
 *  - threats: empty cells that would complete four (Pons' winning positions), weighted by
 *    zugzwang parity. On this 8×7 board (56 cells, 7 rows per column) the player who moves
 *    second can "claim" every odd row (1-indexed: 1,3,5,7 → row index 0,2,4,6) in the fill-up
 *    endgame, so player 2 benefits from threats on those rows and player 1 from threats on
 *    even rows (row index 1,3,5). This is the mirror of the classic 7×6 rule, where player 1
 *    owns the odd rows; `parityMode` lets self-play compare both conventions.
 *  - stacked threats (two own threats vertically adjacent): near decisive.
 *  - threats directly playable by the opponent (we must answer): handled by the search, but
 *    counted here for the rare leaf that sees them.
 *  - open windows of two stones (no enemy stone in a 4-window) and centre control.
 */

import { BOARD_HI, BOARD_LO, BOTTOM_HI, BOTTOM_LO, R, popcount32, winningPositions } from './bitboard.ts';

export interface EvalWeights {
  /** 'p1even' = player 1 wants even rows (8×7 correct); 'p1odd' = classic 7×6 rule; 'off' = no parity. */
  parityMode: 'p1even' | 'p1odd' | 'off';
  threatGood: number;
  threatBad: number;
  stacked: number;
  open2: number;
  center: number;
  /** multiplier (percent) applied to the opponent's threat terms */
  oppPercent: number;
}

export const DEFAULT_WEIGHTS: EvalWeights = {
  parityMode: 'p1even',
  threatGood: 60,
  threatBad: 18,
  stacked: 160,
  open2: 4,
  center: 3,
  oppPercent: 100,
};

/** Max absolute value an evaluation may return (keeps clear of win scores and fits int16). */
export const EVAL_LIMIT = 8000;

/** row index 1,3,5 in every column (even rows 1-indexed). */
const ODD_INDEX_ROWS = 0x2a2a2a2a | 0;
/** row index 0,2,4,6 in every column (odd rows 1-indexed). */
const EVEN_INDEX_ROWS = 0x55555555 | 0;

/** Columns 2..5 (lo: cols 2,3; hi: cols 4,5). */
const CENTER_LO = 0x7f7f0000 | 0;
const CENTER_HI = 0x00007f7f | 0;
/** Columns 3,4 — extra weight. */
const CORE_LO = 0x7f000000 | 0;
const CORE_HI = 0x0000007f | 0;

function shrLo(lo: number, hi: number, n: number): number {
  return (lo >>> n) | (hi << (32 - n));
}

/**
 * Number of 4-windows (all directions) that contain exactly two stones of `pos`
 * and no stone of `opp`.
 */
function openTwos(pLo: number, pHi: number, oLo: number, oHi: number): number {
  const eLo = ~oLo & BOARD_LO;
  const eHi = ~oHi & BOARD_HI;
  let count = 0;
  for (let d = 0; d < 4; d++) {
    const s = d === 0 ? 1 : d === 1 ? 8 : d === 2 ? 7 : 9;
    const s2 = s * 2, s3 = s * 3;
    // windows anchored at their lowest index with no enemy stone
    const wLo = eLo & shrLo(eLo, eHi, s) & shrLo(eLo, eHi, s2) & shrLo(eLo, eHi, s3);
    const wHi = eHi & (eHi >>> s) & (eHi >>> s2) & (eHi >>> s3);
    const aLo = pLo, bLo = shrLo(pLo, pHi, s), cLo = shrLo(pLo, pHi, s2), dLo = shrLo(pLo, pHi, s3);
    const aHi = pHi, bHi = pHi >>> s, cHi = pHi >>> s2, dHi = pHi >>> s3;
    const ge2Lo = (aLo & bLo) | (aLo & cLo) | (aLo & dLo) | (bLo & cLo) | (bLo & dLo) | (cLo & dLo);
    const ge2Hi = (aHi & bHi) | (aHi & cHi) | (aHi & dHi) | (bHi & cHi) | (bHi & dHi) | (cHi & dHi);
    const ge3Lo = (aLo & bLo & cLo) | (aLo & bLo & dLo) | (aLo & cLo & dLo) | (bLo & cLo & dLo);
    const ge3Hi = (aHi & bHi & cHi) | (aHi & bHi & dHi) | (aHi & cHi & dHi) | (bHi & cHi & dHi);
    count += popcount32(wLo & ge2Lo & ~ge3Lo) + popcount32(wHi & ge2Hi & ~ge3Hi);
  }
  return count;
}

function threatScore(
  tLo: number,
  tHi: number,
  goodRows: number,
  w: EvalWeights,
): number {
  if ((tLo | tHi) === 0) return 0;
  let s = 0;
  if (w.parityMode === 'off') {
    s += (popcount32(tLo) + popcount32(tHi)) * ((w.threatGood + w.threatBad) >> 1);
  } else {
    s += (popcount32(tLo & goodRows) + popcount32(tHi & goodRows)) * w.threatGood;
    s += (popcount32(tLo & ~goodRows) + popcount32(tHi & ~goodRows)) * w.threatBad;
  }
  // stacked threats: a threat directly above another own threat
  const stLo = tLo & (tLo << 1);
  const stHi = tHi & (tHi << 1);
  if ((stLo | stHi) !== 0) s += (popcount32(stLo) + popcount32(stHi)) * w.stacked;
  return s;
}

/**
 * Static evaluation of (pos, mask) for the side to move. Assumes the side to move has
 * no immediate win (the search checks that first).
 */
export function evaluate(pLo: number, pHi: number, mLo: number, mHi: number, w: EvalWeights): number {
  const oLo = pLo ^ mLo;
  const oHi = pHi ^ mHi;
  const stones = popcount32(mLo) + popcount32(mHi);
  const meIsP1 = (stones & 1) === 0;

  let meRows: number;
  if (w.parityMode === 'p1even') meRows = meIsP1 ? ODD_INDEX_ROWS : EVEN_INDEX_ROWS;
  else meRows = meIsP1 ? EVEN_INDEX_ROWS : ODD_INDEX_ROWS;
  const oppRows = ~meRows;

  winningPositions(pLo, pHi, mLo, mHi);
  const myLo = R[0], myHi = R[1];
  winningPositions(oLo, oHi, mLo, mHi);
  const opLo = R[0], opHi = R[1];

  let score = threatScore(myLo, myHi, meRows, w);
  let oppScore = threatScore(opLo, opHi, oppRows, w);

  // Opponent threats that are playable right now force our reply: strong penalty.
  const playLo = ((mLo + BOTTOM_LO) | 0) & BOARD_LO;
  const playHi = ((mHi + BOTTOM_HI) | 0) & BOARD_HI;
  const urgentLo = opLo & playLo, urgentHi = opHi & playHi;
  if ((urgentLo | urgentHi) !== 0) oppScore += (popcount32(urgentLo) + popcount32(urgentHi)) * w.threatGood;

  // Own threats whose supporting cell is an opponent threat are worth less (cell is poisoned
  // for both; whoever is forced there loses). Approximate: ignore, parity already covers it.

  score += openTwos(pLo, pHi, oLo, oHi) * w.open2;
  oppScore += openTwos(oLo, oHi, pLo, pHi) * w.open2;

  score += (popcount32(pLo & CENTER_LO) + popcount32(pHi & CENTER_HI)) * w.center;
  score += (popcount32(pLo & CORE_LO) + popcount32(pHi & CORE_HI)) * w.center;
  oppScore += (popcount32(oLo & CENTER_LO) + popcount32(oHi & CENTER_HI)) * w.center;
  oppScore += (popcount32(oLo & CORE_LO) + popcount32(oHi & CORE_HI)) * w.center;

  let v = score - ((oppScore * w.oppPercent) / 100) | 0;
  if (v > EVAL_LIMIT) v = EVAL_LIMIT;
  else if (v < -EVAL_LIMIT) v = -EVAL_LIMIT;
  return v;
}
