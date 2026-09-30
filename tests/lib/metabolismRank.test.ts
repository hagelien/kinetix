import { describe, expect, it } from 'vitest';
import { isEnzymeGroupRank } from '../../src/lib/metabolism';

describe('isEnzymeGroupRank', () => {
  it('treats superfamily/family/subfamily as group ranks', () => {
    expect(isEnzymeGroupRank('superfamily')).toBe(true);
    expect(isEnzymeGroupRank('family')).toBe(true);
    expect(isEnzymeGroupRank('subfamily')).toBe(true);
  });

  it('treats a specific enzyme (gene/isoform/…) as non-group', () => {
    expect(isEnzymeGroupRank('gene')).toBe(false);
    expect(isEnzymeGroupRank('isoform')).toBe(false);
    expect(isEnzymeGroupRank('subunit')).toBe(false);
    expect(isEnzymeGroupRank('variant')).toBe(false);
    expect(isEnzymeGroupRank('complex')).toBe(false);
  });

  it('treats a missing rank as non-group', () => {
    expect(isEnzymeGroupRank(null)).toBe(false);
    expect(isEnzymeGroupRank(undefined)).toBe(false);
  });
});
