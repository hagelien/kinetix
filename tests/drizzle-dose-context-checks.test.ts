/**
 * Migration 0129's vocabulary CHECK must list exactly the values the
 * application accepts (src/lib/entryDoseContext.ts). A value the API accepts
 * and the database refuses fails as an opaque 500 on write; one the database
 * accepts and the API does not is a direct writer storing what the app would
 * refuse. Either drift is silent until someone hits it, so it is pinned here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CENTRAL_STATISTICS,
  CMAX_CONCENTRATION_UNITS,
  COADMINISTRATION_STATES,
  DOSE_CONTEXT_FIELD_KEYS,
  REPORTED_STATISTIC_FIELD_KEYS,
  DOSE_BASES,
  DOSE_CONTEXT_DOSE_UNITS,
  DOSE_NORMALIZED_UNITS,
  DOSE_REGIMENS,
  INTERVAL_KINDS,
  IV_INPUT_MODES,
  PHYSICAL_FORMS,
  PK_POPULATIONS,
  PRANDIAL_STATES,
  RELEASE_PROFILES,
  VALUE_BASES,
} from '../src/lib/entryDoseContext';
import { ENTRY_ONLY_PARAMETER_IDS, parameterDoseContextMode, DRUG_PARAMETER_IDS } from '../src/lib/drugParameters';

const sqlText = readFileSync(
  path.resolve(__dirname, '../drizzle/0129_parameter_entries_dose_context_checks.sql'),
  'utf8',
);

function listFor(column: string): string[] {
  const m = sqlText.match(new RegExp(`"${column}" IN \\(([^)]*)\\)`));
  expect(m, column).not.toBeNull();
  return [...m![1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!);
}

describe('0129 dose-context vocabulary CHECK', () => {
  it.each([
    ['central_statistic', CENTRAL_STATISTICS],
    ['interval_kind', INTERVAL_KINDS],
    ['dose_unit', DOSE_CONTEXT_DOSE_UNITS],
    ['dose_basis', DOSE_BASES],
    ['dose_regimen', DOSE_REGIMENS],
    ['iv_input_mode', IV_INPUT_MODES],
    ['release_profile', RELEASE_PROFILES],
    ['physical_form', PHYSICAL_FORMS],
    ['prandial_state', PRANDIAL_STATES],
    ['coadministration_state', COADMINISTRATION_STATES],
    ['pk_population', PK_POPULATIONS],
    ['value_basis', VALUE_BASES],
  ] as const)('%s matches the application vocabulary', (column, values) => {
    expect(listFor(column)).toEqual([...values]);
  });

  it('the concentration unit list matches CMAX_CONCENTRATION_UNITS', () => {
    // The first "unit" IN (...) is the concentration branch of the
    // value-basis CHECK.
    expect(listFor('unit')).toEqual([...CMAX_CONCENTRATION_UNITS]);
  });

  it('the dose-normalized unit list matches DOSE_NORMALIZED_UNITS', () => {
    // Its units contain parentheses ("mg/L/(mg/kg)"), so listFor's [^)]* cannot
    // delimit it: take the quoted values between its IN ( and the dose-unit
    // family clause that follows the list.
    const m = sqlText.match(/'dose_normalized'\s+OR \("unit" IN \(([\s\S]*?)\)\s+AND \("dose_unit" IS NULL/);
    expect(m).not.toBeNull();
    const units = [...m![1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]!);
    expect(units).toEqual([...DOSE_NORMALIZED_UNITS]);
  });

  it('names exactly the dose-context parameters the registry declares', () => {
    const required = DRUG_PARAMETER_IDS.filter((id) => parameterDoseContextMode(id) === 'required');
    expect(required).toEqual(['cmax']);
    expect(ENTRY_ONLY_PARAMETER_IDS).toEqual(['cmax']);
    expect(sqlText).toContain(`"parameter" <> 'cmax'`);
    expect(sqlText).toContain(`"parameter" = 'cmax'`);
  });
});

/**
 * Migration 0135 re-states 0129's "no dose context outside Cmax" without the
 * three reported-statistic columns, which every numeric parameter may now
 * carry. The column list must be exactly the dose fields the application
 * forbids — a field missing from it is one a direct writer can store on a
 * half-life; a statistic column left in it refuses what the API accepts.
 */
describe('0135 reported-statistic CHECKs', () => {
  const sql0135 = readFileSync(
    path.resolve(__dirname, '../drizzle/0135_parameter_entries_reported_statistic.sql'),
    'utf8',
  );

  it('forbids exactly the non-statistic dose-context columns outside Cmax', () => {
    const block = sql0135.match(
      /ADD CONSTRAINT "parameter_entries_dose_context_forbidden"([\s\S]*?)--> statement-breakpoint/,
    );
    expect(block).not.toBeNull();
    const columns = [...block![1]!.matchAll(/"([a-z_]+)" IS NULL/g)].map((m) => m[1]!);
    const statistic: readonly string[] = REPORTED_STATISTIC_FIELD_KEYS;
    const expected = DOSE_CONTEXT_FIELD_KEYS.filter((k) => !statistic.includes(k)).map((k) =>
      k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
    );
    expect(columns).toEqual(expected);
  });

  it('holds the statistic rules to every parameter but the dose-context one', () => {
    expect(sql0135).toContain('ADD CONSTRAINT "parameter_entries_reported_statistic"');
    expect(sql0135).toMatch(/"parameter_entries_reported_statistic"\s+CHECK \(\s+"parameter" = 'cmax'/);
  });
});
