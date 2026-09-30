import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CENTRAL_STATISTICS,
  CMAX_CONCENTRATION_UNITS,
  COADMINISTRATION_STATES,
  DOSE_BASES,
  DOSE_CONTEXT_DOSE_UNITS,
  DOSE_CONTEXT_FIELD_KEYS,
  DOSE_REGIMENS,
  INTERVAL_KINDS,
  IV_INPUT_MODES,
  PHYSICAL_FORMS,
  PK_POPULATIONS,
  PRANDIAL_STATES,
  RELEASE_PROFILES,
  VALUE_BASES,
} from '../src/lib/entryDoseContext';
import { DOSE_CONTEXT_OBSERVATION_PARAMETERS } from '../src/lib/parameterApplicability';
import { ROUTE_IDS } from '../src/lib/kinetics-core';

/**
 * The Cmax curation instructions must not drift from the dose-context schema
 * (#1346).
 *
 * `agents/drug-db-maintainer.md` is the only place the maintenance routine
 * learns what a Cmax reading carries. A field the prompt never names is a
 * field the routine never fills, and the failure is silent: the entry is
 * accepted, stays visible, and is excluded from the per-dose headline for a
 * reason nobody traces back to the prompt. So every field and every member of
 * its closed vocabulary has to be named there, and a field added to
 * `DOSE_CONTEXT_FIELDS` without a line in the prompt fails here instead of in
 * the catalogue.
 */

const prompt = readFileSync(
  resolve(process.cwd(), 'agents/drug-db-maintainer.md'),
  'utf8',
);

/** Named as a key or value — in backticks or JSON quotes, not in passing. */
function names(token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`[\`"]${escaped}[\`"]`).test(prompt);
}

describe('the Cmax curation instructions', () => {
  it('serves the lane the prompt documents', () => {
    // Guard the guard: an empty lane (the authoring gate shut again) would
    // make every assertion below describe work the queue never hands out.
    expect(DOSE_CONTEXT_OBSERVATION_PARAMETERS).toEqual(['cmax']);
    expect(names('observation')).toBe(true);
    for (const id of DOSE_CONTEXT_OBSERVATION_PARAMETERS) {
      expect(names(id), `observation parameter ${id}`).toBe(true);
    }
  });

  it('names every dose-context field', () => {
    for (const key of DOSE_CONTEXT_FIELD_KEYS) {
      expect(names(key), `dose-context field ${key}`).toBe(true);
    }
  });

  it('names every member of every closed vocabulary', () => {
    const vocabularies: Record<string, readonly string[]> = {
      centralStatistic: CENTRAL_STATISTICS,
      intervalKind: INTERVAL_KINDS,
      doseUnit: DOSE_CONTEXT_DOSE_UNITS,
      doseBasis: DOSE_BASES,
      doseRegimen: DOSE_REGIMENS,
      ivInputMode: IV_INPUT_MODES,
      releaseProfile: RELEASE_PROFILES,
      physicalForm: PHYSICAL_FORMS,
      prandialState: PRANDIAL_STATES,
      coadministrationState: COADMINISTRATION_STATES,
      pkPopulation: PK_POPULATIONS,
      valueBasis: VALUE_BASES,
      unit: CMAX_CONCENTRATION_UNITS,
      route: ROUTE_IDS,
    };
    for (const [field, values] of Object.entries(vocabularies)) {
      for (const value of values) {
        expect(names(value), `${field} value ${value}`).toBe(true);
      }
    }
  });

  it('keeps the hard rule against parsing doses out of prose', () => {
    // The RFC's one unconditional prohibition: a dose inferred from comments
    // is indistinguishable, once stored, from one read off a table.
    expect(prompt).toMatch(/no backfill[^.]*may parse a dose/i);
  });
});
