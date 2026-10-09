import { describe, expect, it } from 'vitest';
import {
  KINETIX_LEARN_GROUP_SLUG,
  GROUP_GRANT,
  canAccessAnalyticalMethods,
  canAccessKinetixLearn,
  canAccessPatternProfile,
} from './featureAccess';

describe('featureAccess', () => {
  it('allows admins to access analytical methods without a group', () => {
    expect(canAccessAnalyticalMethods({ role: 'admin', groups: [] })).toBe(
      true,
    );
  });

  it('allows members of a group granted methods.read to access analytical methods', () => {
    expect(
      canAccessAnalyticalMethods({
        role: 'authenticated',
        groups: [{ slug: 'any-group', grants: [GROUP_GRANT.methods] }],
      }),
    ).toBe(true);
  });

  it('keys on the database grant, not on any group slug', () => {
    expect(
      canAccessAnalyticalMethods({
        role: 'authenticated',
        groups: [{ slug: 'lab', grants: [] }],
      }),
    ).toBe(false);
    expect(
      canAccessAnalyticalMethods({
        role: 'authenticated',
        groups: [{ slug: 'lab', grants: [GROUP_GRANT.pmConcentrations] }],
      }),
    ).toBe(false);
  });

  it('denies non-members', () => {
    expect(
      canAccessAnalyticalMethods({
        role: 'editor',
        groups: [{ slug: 'other-lab' }],
      }),
    ).toBe(false);
  });

  describe('canAccessKinetixLearn', () => {
    it('allows admins without a group', () => {
      expect(canAccessKinetixLearn({ role: 'admin', groups: [] })).toBe(true);
    });

    it('allows kinetix-learn group members', () => {
      expect(
        canAccessKinetixLearn({
          role: 'authenticated',
          groups: [{ slug: KINETIX_LEARN_GROUP_SLUG }],
        }),
      ).toBe(true);
    });

    it('denies plain authenticated users', () => {
      expect(
        canAccessKinetixLearn({ role: 'authenticated', groups: [] }),
      ).toBe(false);
    });

    it('denies anonymous (null) users', () => {
      expect(canAccessKinetixLearn(null)).toBe(false);
    });
  });

  describe('canAccessPatternProfile', () => {
    it('allows admins without a group', () => {
      expect(canAccessPatternProfile({ role: 'admin', groups: [] })).toBe(true);
    });

    it('allows members of a group granted patternProfile.view', () => {
      expect(
        canAccessPatternProfile({
          role: 'authenticated',
          groups: [{ slug: 'any-group', grants: [GROUP_GRANT.patternProfile] }],
        }),
      ).toBe(true);
    });

    it('denies plain authenticated users', () => {
      expect(
        canAccessPatternProfile({ role: 'authenticated', groups: [] }),
      ).toBe(false);
    });

    it('denies editors outside the forensic group (role-keyed, not admin.panel.access)', () => {
      expect(canAccessPatternProfile({ role: 'editor', groups: [] })).toBe(
        false,
      );
    });

    it('denies anonymous (null) users', () => {
      expect(canAccessPatternProfile(null)).toBe(false);
    });
  });
});
