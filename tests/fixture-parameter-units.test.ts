/**
 * Guards the units in `data/components.ts` against the parameter registry.
 *
 * The fixture is not inert. `src/data/index.ts` serves it as the offline
 * catalog when `GET /api/drugs` fails, `generate-registry-provenance.ts` checks
 * the pinned kinetics-core registry against it, and `scripts/seed-drugs.ts`
 * writes it into a database — the last of which stores a value that fails
 * `spec.zod` **as-is**, with only a console warning (softValidateParam). That
 * is how 44 `proteinBinding` values entered the catalog as `{ median: 80, unit:
 * '%' }` when the registry declares `allowedUnits: ['fraction']` and bounds the
 * quantity 0–1, and how 16 `volumeOfDistribution` values entered it as absolute
 * litres under a parameter declared `L/kg`: nothing between the extractor and
 * the fixture said no.
 *
 * A wrong unit here is not a formatting nit. It is a factual claim — 80 means
 * "0.8 of the drug is bound" under `fraction` and "0.8%" under `%`; 14 means a
 * volume of 14 L under `L` and of about 1000 L under `L/kg` — and the two
 * render side by side in the monograph sidebar. Migrations 0116 and 0117
 * repaired the database; this keeps the fixture from seeding the same rows
 * back in.
 *
 * There are no permitted exceptions. An earlier revision of this file carried
 * one, for the absolute-litre Vd rows, on the reasoning that they could not be
 * repaired by rule — true, but the repair was to delete them (0117), not to
 * tolerate them, and the exception mostly served to make the defect look
 * settled. If a new violation appears the answer is a migration and a fixture
 * edit, not an entry here.
 *
 * Scoped to the unit and the registry's bounds on purpose. Whether a value
 * satisfies its parameter's SHAPE (`requiresMinMax`) is a curation question
 * with over a hundred real fixture violations behind it — median-only protein
 * binding, mostly — and asserting it here would fail for reasons this guard is
 * not about.
 */
import { describe, expect, it } from 'vitest';
import { embeddedComponents } from '../data/components.js';
import {
  DRUG_PARAMETERS,
  isRangeKind,
  isRangeSpec,
  type DrugParameterId,
} from '../src/lib/drugParameters.js';
import type { NumericRange } from '../src/types/index.js';

const NUMERIC_FIELDS = ['min', 'max', 'mean', 'median'] as const;

/** Every (drug, parameter, range) triple the fixture holds for a range kind. */
function fixtureRanges(): Array<{
  label: string;
  parameter: DrugParameterId;
  range: NumericRange;
}> {
  const out: Array<{
    label: string;
    parameter: DrugParameterId;
    range: NumericRange;
  }> = [];
  for (const drug of embeddedComponents) {
    const bag = drug as unknown as Record<string, unknown>;
    const label = String(bag.name ?? bag.pubchemCid ?? '(unnamed)');
    for (const id of Object.keys(DRUG_PARAMETERS) as DrugParameterId[]) {
      if (!isRangeKind(DRUG_PARAMETERS[id].kind)) continue;
      const raw = bag[id];
      if (raw === null || raw === undefined || typeof raw !== 'object') continue;
      out.push({
        label: `${label} · ${id}`,
        parameter: id,
        range: raw as NumericRange,
      });
    }
  }
  return out;
}

describe('data/components.ts parameter units', () => {
  it('has range values to check (the guard is not vacuous)', () => {
    expect(fixtureRanges().length).toBeGreaterThan(100);
  });

  it('states every unit in the parameter registry allow-list', () => {
    for (const { label, parameter, range } of fixtureRanges()) {
      const spec = DRUG_PARAMETERS[parameter];
      if (!isRangeSpec(spec)) continue;
      if (range.unit === undefined) continue;
      expect(
        spec.allowedUnits.includes(range.unit),
        `${label}: unit "${range.unit}" is not one of ${spec.allowedUnits.join(', ')}`,
      ).toBe(true);
    }
  });

  it('keeps every number inside the bounds its parameter declares', () => {
    // The unit check above catches a value labelled with the wrong unit; this
    // catches one that is simply not a possible value of the quantity — a
    // negative volume, a half-life of a century — which no unit check can see,
    // because the unit is right and only the number is impossible.
    //
    // Bounds are stated in the canonical unit, so a value in a DIFFERENT
    // allowed unit is not comparable to them without a conversion this guard
    // has no reason to own (mass↔molar would need the molecular weight). Such
    // a value is skipped, and `spec.zod` bounds it on the way into the
    // database instead. Nothing is skipped today: all 369 fixture ranges are
    // in their canonical unit or state none.
    let checked = 0;
    for (const { label, parameter, range } of fixtureRanges()) {
      const spec = DRUG_PARAMETERS[parameter];
      if (!isRangeSpec(spec)) continue;
      if (range.unit !== undefined && range.unit !== spec.canonicalUnit)
        continue;
      const hint =
        spec.kind === 'fraction' ? ' (a percentage stored as a fraction?)' : '';
      for (const field of NUMERIC_FIELDS) {
        const value = range[field];
        if (typeof value !== 'number') continue;
        checked++;
        expect(
          value >= spec.bounds.min && value <= spec.bounds.max,
          `${label}: ${field} = ${value} is outside ${spec.bounds.min}–${spec.bounds.max} ${spec.canonicalUnit || '(dimensionless)'}${hint}`,
        ).toBe(true);
      }
    }
    // The skip above is a real exit, so say what the pass actually covered.
    expect(checked).toBeGreaterThan(100);
  });
});
