/**
 * The three suppression reasons must have exactly one definition.
 *
 * They are consumed in three shapes — the queue's ANDed negations, the count
 * query's ranked CASE, and the dev script's per-drug LATERAL — and for a while
 * each shape carried its own hand-written copy. When the absent cooldown
 * learned that newer evidence supersedes it, one copy learned it: the same
 * `parameter_gaps` response then returned a pair as open while counting it as
 * suppressed, and `scripts/prioritize-param.ts` hid it entirely.
 *
 * The integration tests cover behaviour where a database can observe it. This
 * covers the thing they cannot: that a *fourth* copy has not been written. A
 * behavioural test only fails for the call site somebody remembered to test,
 * which is the precise failure mode being guarded against here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const SOURCE_OF_TRUTH = 'api/_lib/parameterGapsSql.ts';

/** Files that legitimately build gap-suppression SQL. */
const CONSUMERS = [
  'api/agent-sweep.ts',
  'scripts/prioritize-param.ts',
] as const;

/**
 * Fragments that only appear when someone has written a reason out by hand.
 * Each is a distinctive slice of one of the three predicates.
 */
const HAND_WRITTEN: Array<{ fragment: RegExp; reason: string }> = [
  {
    fragment: /drug_parameter_applicability\s+a\b/,
    reason: 'the not-applicable marker check',
  },
  {
    fragment: /concordance\s*=\s*'absent'/,
    reason: 'the absent cooldown',
  },
  {
    fragment: /make_interval\(\s*days\s*=>/,
    reason: 'the cooldown window',
  },
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('gap-suppression SQL has one definition', () => {
  it.each(HAND_WRITTEN)(
    'defines $reason only in the shared module',
    ({ fragment, reason }) => {
      expect(
        fragment.test(read(SOURCE_OF_TRUTH)),
        `${SOURCE_OF_TRUTH} should define ${reason}`,
      ).toBe(true);

      for (const consumer of CONSUMERS) {
        expect(
          fragment.test(read(consumer)),
          `${consumer} writes out ${reason} itself instead of importing it from ` +
            `${SOURCE_OF_TRUTH}. A second copy is how the queue and its own ` +
            `suppression count came to disagree: build the clause from ` +
            `notSuppressedSql() or the individual predicate helpers.`,
        ).toBe(false);
      }
    },
  );

  it('has consumers that actually import the helpers', () => {
    // Without this the check above passes for a file that stopped filtering
    // altogether, which would be a far worse bug than a duplicated string.
    for (const consumer of CONSUMERS) {
      expect(
        /parameterGapsSql\.js/.test(read(consumer)),
        `${consumer} no longer imports the shared suppression SQL`,
      ).toBe(true);
      expect(
        /notSuppressedSql|withinAbsentCooldownSql/.test(read(consumer)),
        `${consumer} imports the module but uses none of its predicates`,
      ).toBe(true);
    }
  });
});
