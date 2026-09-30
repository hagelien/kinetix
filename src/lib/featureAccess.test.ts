import { describe, expect, it } from 'vitest';
import {
  KINETIX_LEARN_GROUP_SLUG,
  RETTSTOKS_GROUP_SLUG,
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

  it('allows Rettstoks group members to access analytical methods', () => {
    expect(
      canAccessAnalyticalMethods({
        role: 'authenticated',
        groups: [{ slug: RETTSTOKS_GROUP_SLUG }],
      }),
    ).toBe(true);
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

    it('allows Rettstoks group members', () => {
      expect(
        canAccessPatternProfile({
          role: 'authenticated',
          groups: [{ slug: RETTSTOKS_GROUP_SLUG }],
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
