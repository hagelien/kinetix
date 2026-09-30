/**
 * `parseLimit` in `scripts/backfill-parameter-revision-source-diff.ts` (#1411
 * review): an invalid `--limit` value must fail closed rather than silently
 * fall back to "no limit" — an ops script writing to production should never
 * turn `--limit 0` (or a typo'd value) into "touch every row".
 */
import { describe, expect, it } from 'vitest';
import { parseLimit } from '../scripts/backfill-parameter-revision-source-diff.js';

describe('parseLimit', () => {
  it('returns null when --limit is not given at all (an intentional unbounded run)', () => {
    expect(parseLimit(['--apply'])).toBeNull();
    expect(parseLimit([])).toBeNull();
  });

  it('accepts a positive integer', () => {
    expect(parseLimit(['--limit', '5'])).toBe(5);
    expect(parseLimit(['--apply', '--limit', '1'])).toBe(1);
  });

  it.each([
    ['0', '--limit 0'],
    ['-1', '--limit -1'],
    ['abc', '--limit abc'],
    ['1.5', '--limit 1.5'],
    [undefined, '--limit with no value'],
  ])('rejects an invalid value (%s)', (value) => {
    const argv = value === undefined ? ['--limit'] : ['--limit', value];
    expect(() => parseLimit(argv)).toThrow(/--limit requires a positive integer/);
  });
});
