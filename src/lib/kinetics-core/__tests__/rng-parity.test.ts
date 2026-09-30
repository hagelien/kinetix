/**
 * The core PRNG must match the app's `distributions.ts` PRNG bit-for-bit (so a
 * seeded Monte-Carlo run agrees between Kinetix and the vendored Redose copy),
 * and must reproduce the committed golden draw sequence (so V8 and Hermes agree).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRNG as CorePRNG } from '../rng';
import { PRNG as LegacyPRNG } from '../../distributions';

const golden = JSON.parse(
  readFileSync(join(__dirname, '../fixtures/prng-draws.json'), 'utf8'),
) as Record<string, number[]>;

describe('kinetics-core PRNG parity', () => {
  it('matches distributions.ts PRNG for shared seeds', () => {
    for (const seed of [42, 7, 12345]) {
      const a = new CorePRNG(seed);
      const b = new LegacyPRNG(seed);
      for (let i = 0; i < 20; i++) {
        expect(a.next()).toBe(b.next());
      }
    }
  });

  it('reproduces the committed golden draw stream', () => {
    for (const [seed, expected] of Object.entries(golden)) {
      const rng = new CorePRNG(Number(seed));
      const got = expected.map(() => rng.next());
      expect(got).toEqual(expected);
    }
  });
});
