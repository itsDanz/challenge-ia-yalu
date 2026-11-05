import { describe, expect, it } from 'vitest';
import { FLAG_EXACT, FLAG_LOWER, FLAG_UPPER, TranspositionTable } from '../../src/engine/tt.ts';

describe('TranspositionTable', () => {
  it('stores and probes exact keys', () => {
    const tt = new TranspositionTable(8);
    expect(tt.probe(1, 2)).toBe(false);
    tt.store(1, 2, 123, 5, FLAG_EXACT, 3);
    expect(tt.probe(1, 2)).toBe(true);
    expect(tt.hitScore).toBe(123);
    expect(tt.hitDepth).toBe(5);
    expect(tt.hitFlag).toBe(FLAG_EXACT);
    expect(tt.hitMove).toBe(3);
    // different key with the same slot is not a hit
    expect(tt.probe(2, 1)).toBe(false);
  });

  it('negative scores and keys round-trip', () => {
    const tt = new TranspositionTable(8);
    tt.store(-5, -7, -9999, 3, FLAG_UPPER, 7);
    expect(tt.probe(-5, -7)).toBe(true);
    expect(tt.hitScore).toBe(-9999);
    expect(tt.hitFlag).toBe(FLAG_UPPER);
  });

  it('keeps a deeper entry of the same generation when a different key collides', () => {
    const tt = new TranspositionTable(1);
    // size 2: find two keys that map to the same index
    const i0 = tt.index(0, 0);
    let other = 1;
    while (tt.index(other, 0) !== i0) other++;
    tt.store(0, 0, 10, 8, FLAG_EXACT, 1);
    tt.store(other, 0, 20, 2, FLAG_LOWER, 2);
    expect(tt.probe(0, 0)).toBe(true);
    expect(tt.probe(other, 0)).toBe(false);
    // same key: always overwritten, move kept if the new one is unknown
    tt.store(0, 0, 11, 1, FLAG_LOWER, -1);
    expect(tt.probe(0, 0)).toBe(true);
    expect(tt.hitScore).toBe(11);
    expect(tt.hitMove).toBe(1);
    // after ageing, a shallower entry replaces the old deep one
    tt.age();
    tt.store(other, 0, 20, 2, FLAG_LOWER, 2);
    expect(tt.probe(other, 0)).toBe(true);
    expect(tt.probe(0, 0)).toBe(false);
  });

  it('age wraps around without reaching generation 0', () => {
    const tt = new TranspositionTable(4);
    for (let i = 0; i < 300; i++) {
      tt.age();
      expect(tt.generation).toBeGreaterThan(0);
      expect(tt.generation).toBeLessThan(256);
    }
  });

  it('clear forgets everything', () => {
    const tt = new TranspositionTable(8);
    tt.store(3, 4, 1, 1, FLAG_EXACT, 0);
    tt.clear();
    expect(tt.probe(3, 4)).toBe(false);
  });
});
