import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  formatGenericDrugName,
  resolveAltDrugName,
  resolveDrugName,
  type LangCode,
} from '@/lib/drugNames';
import type { DrugComponent } from '@/types';

/**
 * Map an i18next locale tag (e.g. `"nb-NO"`, `"en-US"`) to the BCP-47 base
 * code we store as a key in `drug.names`. Falls back to `"nb"` because the
 * app's default language is Norwegian.
 */
export function activeLangCode(locale: string | undefined | null): LangCode {
  if (!locale) return 'nb';
  return locale.split('-')[0]!.toLowerCase();
}

/**
 * Resolve a drug's primary display name, preferring the user's active
 * interface language. Returns an empty string only if `names` is empty,
 * which the schema does not allow.
 */
export function getDrugDisplayName(
  drug: { names: Record<LangCode, string> | null | undefined },
  locale: string | undefined | null,
): string {
  return formatGenericDrugName(
    resolveDrugName(drug.names, activeLangCode(locale)),
  );
}

/**
 * Hook returning `{ displayName, altName, shortLabel }` for a drug, reactive
 * to the current i18n language. `shortLabel` is what the table cell shows:
 * `nameShort` if present, otherwise the localized display name.
 */
export function useDrugName(drug: DrugComponent | null | undefined) {
  const { i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  return useMemo(() => {
    if (!drug) {
      return { displayName: '', altName: null, shortLabel: '' };
    }
    // Resolve against the canonical stored names first (so the
    // primary/alt comparison uses the real values), then apply the
    // display-case house style for rendering.
    const canonical = resolveDrugName(drug.names, lang);
    const displayName = formatGenericDrugName(canonical);
    const altName = formatGenericDrugName(
      resolveAltDrugName(drug.names, canonical) ?? '',
    ) || null;
    const shortLabel = drug.nameShort ?? displayName;
    return { displayName, altName, shortLabel };
  }, [drug, lang]);
}
