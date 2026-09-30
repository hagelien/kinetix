/**
 * The applicability refusals must reach a Norwegian curator in Norwegian.
 *
 * `PUT /api/drug-parameter` answers a blocked pair with a 409 whose `message`
 * is English developer-facing prose and whose `code` is the stable contract.
 * The form used to render `err.message` straight into the error slot, so the
 * new refusal — the one a curator is most likely to hit, since it fires on an
 * ordinary edit — leaked English. AGENTS.md's i18n rule is explicit that
 * server messages reaching the UI go through a code at the React boundary.
 *
 * This asserts the mapping and the locale coverage rather than rendering the
 * form: the bug was a missing translation, not a rendering fault, and a key
 * that exists in one language but not the other is the failure mode a
 * component test would not catch.
 */
import { describe, expect, it } from 'vitest';
import en from '../../locales/en.json';
import nb from '../../locales/nb.json';

/** Codes the parameter form maps — kept in step with SAVE_ERROR_KEYS. */
const MAPPED_CODES = {
  parameter_not_applicable: 'notApplicable',
  parameter_entry_backed: 'entryBacked',
  reference_not_judged: 'referenceNotJudged',
} as const;

type Locale = { paramEdit: { errors?: Record<string, string> } };

describe('parameter edit form — server error translations', () => {
  it('has a Norwegian and an English string for every mapped code', () => {
    for (const [code, key] of Object.entries(MAPPED_CODES)) {
      for (const [lang, bundle] of [
        ['en', en as Locale],
        ['nb', nb as Locale],
      ] as const) {
        const value = bundle.paramEdit.errors?.[key];
        expect(value, `${lang} is missing paramEdit.errors.${key} (${code})`)
          .toBeTruthy();
        expect(
          typeof value === 'string' && value.trim().length,
          `${lang} paramEdit.errors.${key} is empty`,
        ).toBeTruthy();
      }
    }
  });

  it('does not leave the Norwegian string as a copy of the English one', () => {
    // An untranslated placeholder passes a presence check while still showing
    // a Norwegian curator English prose — the exact bug being fixed.
    for (const key of Object.values(MAPPED_CODES)) {
      const enText = (en as Locale).paramEdit.errors?.[key];
      const nbText = (nb as Locale).paramEdit.errors?.[key];
      expect(nbText, `paramEdit.errors.${key} is untranslated`).not.toBe(enText);
    }
  });

  it('covers the codes the parameter endpoint can actually return', () => {
    // Guards against the endpoint gaining a refusal the form cannot translate.
    // Update both sides together when adding one.
    expect(Object.keys(MAPPED_CODES).sort()).toEqual([
      'parameter_entry_backed',
      'parameter_not_applicable',
      'reference_not_judged',
    ]);
  });
});

/**
 * `parameter_not_applicable` is raised by four endpoints, not one, and each
 * reaches a different React surface with its own translation mechanism. Fixing
 * only the parameter form left three of them showing the API's English —
 * exactly the shape of "fixed the boundary in front of me" that this PR kept
 * repeating.
 *
 * Each entry below pairs a surface with the locale path it actually looks up,
 * so a new surface has to be added here consciously rather than discovered in
 * production.
 */
const NOT_APPLICABLE_SURFACES: Array<{
  surface: string;
  path: readonly string[];
}> = [
  // ParameterEditForm — SAVE_ERROR_KEYS
  { surface: 'parameter edit form', path: ['paramEdit', 'errors', 'notApplicable'] },
  // ParameterEntryEditor — t(`parameterEntries.editor.error_${code}`)
  {
    surface: 'source-entry editor',
    path: ['parameterEntries', 'editor', 'error_parameter_not_applicable'],
  },
  // PendingEditCard — REVIEW_ERROR_KEYS
  {
    surface: 'review card',
    path: ['review', 'errors', 'parameterNotApplicable'],
  },
  // WikiNew — inline code check on the create response
  { surface: 'wiki page creation', path: ['wiki', 'parameterNotApplicable'] },
];

function lookup(bundle: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (node, key) =>
      node && typeof node === 'object'
        ? (node as Record<string, unknown>)[key]
        : undefined,
    bundle,
  );
}

/**
 * `parameter_entry_backed` is the refusal a curator meets when they try to type
 * a value into a parameter that is fed by source values. It reaches two
 * surfaces: the editor itself (which now also renders the string in place of
 * its inputs, not only on a failed save) and the review card, where an edit
 * queued before the rule existed comes up for a decision.
 */
const ENTRY_BACKED_SURFACES: Array<{
  surface: string;
  path: readonly string[];
}> = [
  { surface: 'parameter edit form', path: ['paramEdit', 'errors', 'entryBacked'] },
  { surface: 'review card', path: ['review', 'errors', 'parameterEntryBacked'] },
];

describe('parameter_entry_backed reaches every surface translated', () => {
  it.each(ENTRY_BACKED_SURFACES)(
    'has both locales for the $surface',
    ({ surface, path }) => {
      for (const [lang, bundle] of [
        ['en', en],
        ['nb', nb],
      ] as const) {
        const value = lookup(bundle, path);
        expect(
          typeof value === 'string' && value.trim().length > 0,
          `${lang} is missing ${path.join('.')} for the ${surface}`,
        ).toBe(true);
      }
    },
  );

  it('translates each surface rather than copying the English', () => {
    for (const { surface, path } of ENTRY_BACKED_SURFACES) {
      expect(lookup(nb, path), `${surface} is untranslated`).not.toBe(
        lookup(en, path),
      );
    }
  });
});

describe('parameter_not_applicable reaches every surface translated', () => {
  it.each(NOT_APPLICABLE_SURFACES)(
    'has both locales for the $surface',
    ({ surface, path }) => {
      for (const [lang, bundle] of [
        ['en', en],
        ['nb', nb],
      ] as const) {
        const value = lookup(bundle, path);
        expect(
          typeof value === 'string' && value.trim().length > 0,
          `${lang} is missing ${path.join('.')} for the ${surface}`,
        ).toBe(true);
      }
    },
  );

  it('translates each surface rather than copying the English', () => {
    for (const { surface, path } of NOT_APPLICABLE_SURFACES) {
      expect(lookup(nb, path), `${surface} is untranslated`).not.toBe(
        lookup(en, path),
      );
    }
  });
});
