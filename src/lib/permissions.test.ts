import { describe, expect, it } from 'vitest';
import {
  CAP,
  CAPABILITY_LIST,
  can,
  canAnyInGroup,
  capabilitiesForTier,
  capabilityForEditType,
  checkOverride,
  effectiveTier,
  getCapability,
  isCapabilityId,
  sanitizeOverrides,
  tierForRole,
} from './permissions';

describe('capability registry', () => {
  it('has unique ids and a floor no higher than its default', () => {
    const ids = CAPABILITY_LIST.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const cap of CAPABILITY_LIST) {
      expect(
        can(cap.defaultTier === 'anonymous' ? null : cap.defaultTier, cap.id),
      ).toBe(true);
      // A floor above the default would make the shipped behavior unreachable.
      expect(effectiveTier(cap.id)).toBe(cap.defaultTier);
    }
  });

  it('never lets a write capability fall to anonymous', () => {
    for (const cap of CAPABILITY_LIST) {
      if (cap.group === 'read') continue;
      expect(cap.floorTier).not.toBe('anonymous');
    }
  });

  it('locks the privilege-granting capabilities to admin', () => {
    for (const id of [CAP['admin.users.manage'], CAP['admin.permissions.manage']]) {
      const cap = getCapability(id)!;
      expect(cap.locked).toBe(true);
      expect(cap.defaultTier).toBe('admin');
    }
  });
});

describe('tierForRole', () => {
  it('maps a missing session to anonymous', () => {
    expect(tierForRole(null)).toBe('anonymous');
    expect(tierForRole(undefined)).toBe('anonymous');
    expect(tierForRole('')).toBe('anonymous');
  });

  it('maps an unknown role to anonymous rather than trusting it', () => {
    expect(tierForRole('viewer')).toBe('anonymous');
    expect(tierForRole('superuser')).toBe('anonymous');
  });
});

describe('defaults match the shipped behavior', () => {
  it.each([
    [null, CAP['content.read.published'], true],
    [null, CAP['discussion.comment.create'], false],
    ['authenticated', CAP['discussion.comment.create'], true],
    ['authenticated', CAP['edit.parameter.submit'], false],
    ['contributor', CAP['edit.parameter.submit'], true],
    ['contributor', CAP['approval.stamp.add'], true],
    ['contributor', CAP['review.edit.decide'], false],
    ['editor', CAP['review.edit.decide'], true],
    ['editor', CAP['methods.write'], true],
    ['editor', CAP['wiki.page.approve'], false],
    ['editor', CAP['edit.directWrite'], false],
    ['admin', CAP['edit.directWrite'], true],
    ['admin', CAP['wiki.page.approve'], true],
  ])('%s %s → %s', (role, capability, expected) => {
    expect(can(role, capability)).toBe(expected);
  });
});

describe('overrides', () => {
  it('lowers a capability to the requested tier', () => {
    const overrides = { [CAP['review.edit.decide']]: 'contributor' } as const;
    expect(can('contributor', CAP['review.edit.decide'], overrides)).toBe(true);
    expect(can('authenticated', CAP['review.edit.decide'], overrides)).toBe(
      false,
    );
  });

  it('raises a capability so a previously-allowed tier loses it', () => {
    const overrides = { [CAP['edit.parameter.submit']]: 'editor' } as const;
    expect(can('contributor', CAP['edit.parameter.submit'], overrides)).toBe(
      false,
    );
    expect(can('editor', CAP['edit.parameter.submit'], overrides)).toBe(true);
  });

  it('keeps the ladder monotone — a grant to a tier grants every tier above', () => {
    const overrides = sanitizeOverrides({
      [CAP['edit.directWrite']]: 'editor',
      [CAP['methods.write']]: 'contributor',
    });
    const contributor = new Set(capabilitiesForTier('contributor', overrides));
    const editor = new Set(capabilitiesForTier('editor', overrides));
    const admin = new Set(capabilitiesForTier('admin', overrides));
    for (const id of contributor) expect(editor.has(id)).toBe(true);
    for (const id of editor) expect(admin.has(id)).toBe(true);
  });

  it('clamps a stored tier below the floor back up to the floor', () => {
    const overrides = sanitizeOverrides({
      [CAP['edit.directWrite']]: 'authenticated',
    });
    expect(overrides[CAP['edit.directWrite']]).toBe('editor');
    expect(can('contributor', CAP['edit.directWrite'], overrides)).toBe(false);
  });

  it('ignores locked, unknown and malformed rows', () => {
    expect(
      sanitizeOverrides({
        [CAP['admin.permissions.manage']]: 'editor',
        'capability.that.was.removed': 'contributor',
        [CAP['methods.write']]: 'wizard',
        [CAP['methods.write'] + '.typo']: 'editor',
      }),
    ).toEqual({});
    expect(can('editor', CAP['admin.permissions.manage'], {
      [CAP['admin.permissions.manage']]: 'editor',
    })).toBe(false);
  });

  it('prunes an override that merely restates the default', () => {
    expect(sanitizeOverrides({ [CAP['methods.write']]: 'editor' })).toEqual({});
  });

  it('treats an unknown capability id as admin-only', () => {
    expect(effectiveTier('nope.not.real')).toBe('admin');
    expect(can('editor', 'nope.not.real')).toBe(false);
    expect(isCapabilityId('nope.not.real')).toBe(false);
  });
});

describe('canAnyInGroup', () => {
  it('is true when the tier holds at least one of the group', () => {
    expect(canAnyInGroup('contributor', 'contribute')).toBe(true);
    expect(canAnyInGroup('authenticated', 'contribute')).toBe(false);
  });

  it('follows an override on any single member', () => {
    const overrides = { [CAP['edit.parameter.submit']]: 'authenticated' } as const;
    expect(canAnyInGroup('authenticated', 'contribute', overrides)).toBe(true);
  });

  it('is false for anonymous across every non-read group', () => {
    for (const group of ['community', 'contribute', 'review', 'registry', 'admin'] as const) {
      expect(canAnyInGroup(null, group)).toBe(false);
    }
  });
});

describe('checkOverride', () => {
  it('keeps model-structure decisions at the editor floor', () => {
    expect(
      checkOverride(CAP['edit.modelStructure.decide'], 'contributor'),
    ).toEqual({ ok: false, reason: 'below_floor' });
    expect(
      checkOverride(CAP['edit.modelStructure.decide'], 'editor'),
    ).toMatchObject({ ok: true, tier: 'editor' });
  });

  it('accepts a tier at or above the floor', () => {
    const result = checkOverride(CAP['review.edit.decide'], 'contributor');
    expect(result).toMatchObject({ ok: true, tier: 'contributor' });
  });

  it('flags a request that would restore the default', () => {
    expect(checkOverride(CAP['methods.write'], 'editor')).toMatchObject({
      ok: true,
      isDefault: true,
    });
  });

  it.each([
    [CAP['edit.directWrite'], 'contributor', 'below_floor'],
    [CAP['admin.users.manage'], 'editor', 'locked_capability'],
    ['made.up', 'editor', 'unknown_capability'],
    [CAP['methods.write'], 'root', 'invalid_tier'],
  ])('rejects %s → %s', (capability, tier, reason) => {
    expect(checkOverride(capability, tier)).toEqual({ ok: false, reason });
  });
});

describe('capabilityForEditType', () => {
  it('routes whole-page drafts to the whole-page capability', () => {
    expect(capabilityForEditType('wiki_page')).toBe(CAP['wiki.page.submit']);
    expect(capabilityForEditType('wiki_new')).toBe(CAP['wiki.page.submit']);
  });

  it('routes each queued type to its own capability', () => {
    expect(capabilityForEditType('parameter')).toBe(CAP['edit.parameter.submit']);
    expect(capabilityForEditType('param_entry')).toBe(
      CAP['edit.parameterEntry.submit'],
    );
    expect(capabilityForEditType('metabolism')).toBe(
      CAP['edit.metabolism.submit'],
    );
    expect(capabilityForEditType('learning_unit')).toBe(
      CAP['edit.learning.submit'],
    );
  });

  it('falls back to the fact capability for an unrecognised type', () => {
    expect(capabilityForEditType('something_new')).toBe(
      CAP['edit.wikiFact.submit'],
    );
  });
});
