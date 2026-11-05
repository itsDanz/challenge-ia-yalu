/**
 * Transposition table over typed arrays (no objects, no GC pressure).
 *
 * The 64-bit position key (Pons: pos + mask) is stored in full, so a hit is exact.
 * Replacement: an entry is overwritten if it is from an older generation, or if the new
 * search depth is at least as large as the stored one.
 */

export const FLAG_NONE = 0;
export const FLAG_EXACT = 1;
export const FLAG_LOWER = 2; // score is a lower bound (fail-high)
export const FLAG_UPPER = 3; // score is an upper bound (fail-low)

export class TranspositionTable {
  readonly size: number;
  readonly mask: number;
  readonly keyLo: Int32Array;
  readonly keyHi: Int32Array;
  readonly score: Int16Array;
  readonly depth: Uint8Array;
  readonly flag: Uint8Array;
  readonly move: Int8Array;
  readonly gen: Uint8Array;
  generation = 1;

  /** Last probe results (valid right after `probe()` returned true). */
  hitScore = 0;
  hitDepth = 0;
  hitFlag = 0;
  hitMove = -1;

  constructor(bits = 22) {
    this.size = 1 << bits;
    this.mask = this.size - 1;
    this.keyLo = new Int32Array(this.size);
    this.keyHi = new Int32Array(this.size);
    this.score = new Int16Array(this.size);
    this.depth = new Uint8Array(this.size);
    this.flag = new Uint8Array(this.size);
    this.move = new Int8Array(this.size);
    this.gen = new Uint8Array(this.size);
  }

  index(kLo: number, kHi: number): number {
    const h = Math.imul(kLo, 0x9e3779b1) ^ Math.imul(kHi, 0x85ebca6b) ^ (kHi >>> 15);
    return (h ^ (h >>> 13)) & this.mask;
  }

  /** Returns true on an exact key match, leaving data in hit* fields. */
  probe(kLo: number, kHi: number): boolean {
    const i = this.index(kLo, kHi);
    if (this.flag[i] === FLAG_NONE || this.keyLo[i] !== kLo || this.keyHi[i] !== kHi) return false;
    this.hitScore = this.score[i];
    this.hitDepth = this.depth[i];
    this.hitFlag = this.flag[i];
    this.hitMove = this.move[i];
    return true;
  }

  store(kLo: number, kHi: number, score: number, depth: number, flag: number, move: number): void {
    const i = this.index(kLo, kHi);
    const same = this.flag[i] !== FLAG_NONE && this.keyLo[i] === kLo && this.keyHi[i] === kHi;
    if (!same && this.flag[i] !== FLAG_NONE && this.gen[i] === this.generation && this.depth[i] > depth) {
      return; // keep deeper entry from this search
    }
    this.keyLo[i] = kLo;
    this.keyHi[i] = kHi;
    this.score[i] = score;
    this.depth[i] = depth < 0 ? 0 : depth;
    this.flag[i] = flag;
    this.move[i] = same && move < 0 ? this.move[i] : move;
    this.gen[i] = this.generation;
  }

  /** Marks all current entries as old (cheap "clear" between games). */
  age(): void {
    this.generation = (this.generation + 1) & 0xff;
    if (this.generation === 0) this.generation = 1;
  }

  clear(): void {
    this.flag.fill(FLAG_NONE);
    this.generation = 1;
  }
}
