import { describe, expect, it } from 'vitest';
import {
  discussionTargetForFact,
  factIdFromDiscussionTarget,
  isFactDiscussionTargetKey,
} from './discussionTargets';

describe('discussionTargets', () => {
  it('builds and validates fact discussion keys', () => {
    const factId = 'fact.uuid:1_' + 'x'.repeat(52);
    const key = discussionTargetForFact(factId);
    expect(key).toBe(`fact:${factId}`);
    expect(isFactDiscussionTargetKey(key)).toBe(true);
    expect(factIdFromDiscussionTarget(key)).toBe(factId);
  });

  it('rejects malformed or oversized fact discussion keys', () => {
    expect(isFactDiscussionTargetKey('halfLife')).toBe(false);
    expect(isFactDiscussionTargetKey('fact:')).toBe(false);
    expect(isFactDiscussionTargetKey('fact:   ')).toBe(false);
    expect(isFactDiscussionTargetKey(`fact:${'x'.repeat(65)}`)).toBe(false);
  });
});
