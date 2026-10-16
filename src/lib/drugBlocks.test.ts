import { describe, expect, it } from 'vitest';
import { DRUG_BLOCK_IDS, isDrugBlockId } from './drugBlocks';
import { DRUG_PARAMETER_IDS } from './drugParameters';
import { isFactDiscussionTargetKey } from './discussionTargets';

describe('drug blocks', () => {
  // A block id shares the discussion `parameter` column with parameter ids and
  // fact keys, so it must never read as either.
  it('never collides with a parameter id or a fact key', () => {
    for (const block of DRUG_BLOCK_IDS) {
      expect(DRUG_PARAMETER_IDS as readonly string[]).not.toContain(block);
      expect(isFactDiscussionTargetKey(block)).toBe(false);
    }
  });

  it('recognises exactly the declared blocks', () => {
    expect(isDrugBlockId('metabolism')).toBe(true);
    expect(isDrugBlockId('modelStructure')).toBe(true);
    expect(isDrugBlockId('halfLife')).toBe(false);
    expect(isDrugBlockId(null)).toBe(false);
  });
});
