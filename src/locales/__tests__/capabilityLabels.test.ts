/**
 * Every capability in the matrix needs a label in every locale.
 *
 * Admin → Permissions renders each row through
 * `t('admin.permissions.capabilities.<id with dots as underscores>')`, and a
 * missing entry does not fail loudly — i18next returns the key, so the admin
 * sees `admin.permissions.capabilities.pmConcentrations_read` in a list of
 * readable rows and has to guess what it governs. Adding a capability is a
 * two-file change and there was nothing holding the second file to the first.
 */
import { describe, expect, it } from 'vitest';
import en from '@/locales/en.json';
import nb from '@/locales/nb.json';
import { CAPABILITY_LIST } from '@/lib/permissions';

type CapabilityLocale = Record<string, string>;

function capabilities(locale: unknown): CapabilityLocale {
  return (
    locale as {
      admin: { permissions: { capabilities: CapabilityLocale } };
    }
  ).admin.permissions.capabilities;
}

/** Mirrors `labelKey` in PermissionsAdminSection. */
function labelKey(capability: string): string {
  return capability.replace(/\./g, '_');
}

describe('capability i18n labels', () => {
  const locales: Array<[string, CapabilityLocale]> = [
    ['en', capabilities(en)],
    ['nb', capabilities(nb)],
  ];

  it('has a non-empty label for every registered capability', () => {
    for (const [locale, labels] of locales) {
      for (const cap of CAPABILITY_LIST) {
        expect(
          labels[labelKey(cap.id)],
          `${locale} admin.permissions.capabilities.${labelKey(cap.id)}`,
        ).toBeTruthy();
      }
    }
  });

  it('carries no label for a capability the registry has dropped', () => {
    const known = new Set(CAPABILITY_LIST.map((cap) => labelKey(cap.id)));
    for (const [locale, labels] of locales) {
      for (const key of Object.keys(labels)) {
        expect(known.has(key), `${locale} has a stale label for ${key}`).toBe(
          true,
        );
      }
    }
  });
});
