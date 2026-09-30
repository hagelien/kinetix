import { describe, it, expect } from 'vitest';
import {
  effectiveProposalReferenceIds,
  inspectParameterEntryPayload,
  parameterEntryInputSchema,
  parameterEntryCreateRequestSchema,
  parameterEntryPatchSchema,
  parameterEntryEditSchema,
  validateEntryForParameter,
} from './parameterEntries';

const valid = {
  drugId: 1,
  parameter: 'therapeuticConcentration',
  low: 10,
  high: 30,
  unit: 'mg/L',
  matrix: 'serum',
  scenario: 'living_therapeutic',
  citationId: 5,
};

describe('parameterEntryInputSchema', () => {
  it('accepts a well-formed entry', () => {
    expect(parameterEntryInputSchema.safeParse(valid).success).toBe(true);
  });

  it('requires a citation (per-paper provenance)', () => {
    const { citationId: _omit, ...noCite } = valid;
    void _omit;
    expect(parameterEntryInputSchema.safeParse(noCite).success).toBe(false);
  });

  it('requires at least one of low / high / median', () => {
    const { low: _l, high: _h, ...noValue } = valid;
    void _l;
    void _h;
    expect(parameterEntryInputSchema.safeParse(noValue).success).toBe(false);
    expect(
      parameterEntryInputSchema.safeParse({ ...noValue, median: 20 }).success,
    ).toBe(true);
  });

  it('rejects low > high', () => {
    expect(
      parameterEntryInputSchema.safeParse({ ...valid, low: 40, high: 10 })
        .success,
    ).toBe(false);
  });

  // Facts about the reading (dose, fed/fasted state, population, assay
  // method) — distinct from `comments` (curator commentary about the row).
  it('accepts an optional observationContext alongside comments', () => {
    const parsed = parameterEntryInputSchema.safeParse({
      ...valid,
      observationContext: 'Fasted, single dose, healthy volunteers.',
      comments: 'Double-checked against table 3.',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.observationContext).toBe(
        'Fasted, single dose, healthy volunteers.',
      );
      expect(parsed.data.comments).toBe('Double-checked against table 3.');
    }
  });

  it('rejects a non-summarizable parameter', () => {
    expect(
      parameterEntryInputSchema.safeParse({ ...valid, parameter: 'halfLife' })
        .success,
    ).toBe(false);
  });

  it('rejects a median outside its own low..high interval', () => {
    expect(
      parameterEntryInputSchema.safeParse({
        ...valid,
        low: 10,
        high: 20,
        median: 100,
      }).success,
    ).toBe(false);
    // Within bounds is fine.
    expect(
      parameterEntryInputSchema.safeParse({
        ...valid,
        low: 10,
        high: 20,
        median: 15,
      }).success,
    ).toBe(true);
  });

  it('rejects a value above the concentration column bound', () => {
    expect(
      parameterEntryInputSchema.safeParse({ ...valid, low: undefined, high: 100_000_001 })
        .success,
    ).toBe(false);
  });

  it('bounds the value by its canonical (converted) magnitude', () => {
    // mg/mL is 1000× mg/L, so 1e6 mg/mL = 1e9 mg/L — over the registry max.
    expect(
      parameterEntryInputSchema.safeParse({
        ...valid,
        low: undefined,
        high: undefined,
        median: 1_000_000,
        unit: 'mg/mL',
      }).success,
    ).toBe(false);
    // The same magnitude in mg/L is exactly at the cap → allowed.
    expect(
      parameterEntryInputSchema.safeParse({
        ...valid,
        low: undefined,
        high: undefined,
        median: 1_000_000,
        unit: 'mg/L',
      }).success,
    ).toBe(true);
    // A reasonable mg/mL value converts within bounds.
    expect(
      parameterEntryInputSchema.safeParse({
        ...valid,
        low: undefined,
        high: undefined,
        median: 100,
        unit: 'mg/mL',
      }).success,
    ).toBe(true);
  });

  it('rejects a qualified entry with a distinct interval', () => {
    // A censored threshold is a single value; a distinct low..high would be
    // silently dropped by the formatters and aggregation.
    expect(
      parameterEntryInputSchema.safeParse({
        ...valid,
        low: 10,
        high: 20,
        qualifier: '<',
      }).success,
    ).toBe(false);
    // A single threshold (only high) is accepted…
    expect(
      parameterEntryInputSchema.safeParse({
        ...valid,
        low: undefined,
        high: 20,
        qualifier: '<',
      }).success,
    ).toBe(true);
    // …as are equal bounds ("< 20" stored as low = high = 20).
    expect(
      parameterEntryInputSchema.safeParse({
        ...valid,
        low: 20,
        high: 20,
        qualifier: '<',
      }).success,
    ).toBe(true);
  });
});

describe('parameterEntryEditSchema', () => {
  it('discriminates create / update / delete', () => {
    expect(
      parameterEntryEditSchema.safeParse({ op: 'create', input: valid }).success,
    ).toBe(true);
    expect(
      parameterEntryEditSchema.safeParse({
        op: 'update',
        patch: {
          median: 20,
          unit: 'mg/L',
          matrix: 'serum',
          scenario: 'living_therapeutic',
          citationId: 5,
        },
      }).success,
    ).toBe(true);
    expect(parameterEntryEditSchema.safeParse({ op: 'delete' }).success).toBe(
      true,
    );
    expect(parameterEntryEditSchema.safeParse({ op: 'bogus' }).success).toBe(
      false,
    );
  });
});


describe('non-concentration parameters', () => {
  const halfLife = {
    drugId: 1,
    parameter: 'halfLife',
    low: 4,
    high: 9,
    unit: 'h',
    citationId: 5,
  };

  it('accepts a half-life entry with no matrix and no scenario', () => {
    expect(parameterEntryInputSchema.safeParse(halfLife).success).toBe(true);
  });

  it('rejects a matrix on a matrix-independent parameter', () => {
    // A half-life has no "serum vs whole blood" reading; accepting one would
    // record a dimension the source never reported.
    expect(
      parameterEntryInputSchema.safeParse({ ...halfLife, matrix: 'serum' })
        .success,
    ).toBe(false);
  });

  it('rejects an interpretive scenario on a parameter that has none', () => {
    expect(
      parameterEntryInputSchema.safeParse({
        ...halfLife,
        scenario: 'living_therapeutic',
      }).success,
    ).toBe(false);
  });

  it('still requires a matrix and scenario on an interpretive concentration', () => {
    const { matrix: _m, ...noMatrix } = valid;
    void _m;
    expect(parameterEntryInputSchema.safeParse(noMatrix).success).toBe(false);
    const { scenario: _s, ...noScenario } = valid;
    void _s;
    expect(parameterEntryInputSchema.safeParse(noScenario).success).toBe(false);
  });

  it('rejects a unit the parameter does not allow', () => {
    expect(
      parameterEntryInputSchema.safeParse({ ...halfLife, unit: 'mg/L' })
        .success,
    ).toBe(false);
  });

  it('accepts negative values for logP but not for a concentration', () => {
    expect(
      parameterEntryInputSchema.safeParse({
        drugId: 1,
        parameter: 'logP',
        low: -1.2,
        high: 0.4,
        unit: '',
        citationId: 5,
      }).success,
    ).toBe(true);
    expect(
      parameterEntryInputSchema.safeParse({ ...valid, low: -5, high: 1 })
        .success,
    ).toBe(false);
  });

  it('enforces the registry bounds for the parameter', () => {
    // proteinBinding is a 0–1 fraction: 95 (a percentage) is out of range.
    expect(
      parameterEntryInputSchema.safeParse({
        drugId: 1,
        parameter: 'proteinBinding',
        low: 0.9,
        high: 0.99,
        median: 95,
        unit: 'fraction',
        citationId: 5,
      }).success,
    ).toBe(false);
    expect(
      parameterEntryInputSchema.safeParse({
        drugId: 1,
        parameter: 'proteinBinding',
        low: 0.9,
        high: 0.99,
        median: 0.95,
        unit: 'fraction',
        citationId: 5,
      }).success,
    ).toBe(true);
  });

  it('refuses parameters that are not entry-backed', () => {
    // Analyte stability stays per-matrix; metadata is not a measurement; and a
    // retired id (`loq`) is not a parameter at all.
    expect(validateEntryForParameter('analyteStability', { unit: 'h' })).not.toBeNull();
    expect(validateEntryForParameter('nameEn', { unit: '' })).not.toBeNull();
    expect(validateEntryForParameter('loq', { unit: 'ng/mL' })).not.toBeNull();
  });

  it('requires low and high on an entry for a requiresMinMax parameter (#1235)', () => {
    // proteinBinding declares requiresMinMax in the registry; withdrawn pending
    // edit #1203 carried only a median and nothing rejected it.
    expect(
      validateEntryForParameter('proteinBinding', { median: 0.535, unit: 'fraction' }),
    ).toMatch(/low and high are required/i);
    expect(
      validateEntryForParameter('proteinBinding', { low: 0.5, unit: 'fraction' }),
    ).toMatch(/low and high are required/i);
    expect(
      validateEntryForParameter('proteinBinding', {
        low: 0.5,
        high: 0.57,
        median: 0.535,
        unit: 'fraction',
      }),
    ).toBeNull();
  });

  it('does not require low/high on a parameter that leaves the shape optional', () => {
    // therapeuticConcentration (via `valid`) is not requiresMinMax.
    expect(
      validateEntryForParameter('therapeuticConcentration', {
        median: 6,
        unit: 'mg/L',
        matrix: 'serum',
        scenario: 'living_therapeutic',
      }),
    ).toBeNull();
  });
});

describe('categorical model-structure entries (CV-1b)', () => {
  const disposition = {
    drugId: 1,
    parameter: 'dispositionModel',
    categoricalValue: 'two-compartment',
    unit: '',
    citationId: 5,
  };

  it('rejects route/input combinations with incompatible absorption physics', () => {
    expect(validateEntryForParameter('absorptionModel', {
      categoricalValue: 'bolus', route: 'oral', unit: '',
    })).toMatch(/not compatible/);
    expect(validateEntryForParameter('absorptionModel', {
      categoricalValue: 'iv-infusion', route: 'iv', unit: '',
    })).toBeNull();
    expect(validateEntryForParameter('ka', {
      median: 1, route: 'iv', unit: '1/h',
    })).toMatch(/no first-order absorption phase/);
    expect(validateEntryForParameter('bioavailability', {
      median: 0.8, route: 'iv', unit: 'fraction',
    })).toMatch(/fixes F = 1/);
  });

  it('accepts a well-formed model-structure entry', () => {
    expect(parameterEntryInputSchema.safeParse(disposition).success).toBe(true);
    expect(validateEntryForParameter('dispositionModel', disposition)).toBeNull();
  });

  it('still requires a citation', () => {
    const { citationId: _omit, ...noCite } = disposition;
    void _omit;
    expect(parameterEntryInputSchema.safeParse(noCite).success).toBe(false);
  });

  it('rejects a value outside the axis vocabulary', () => {
    expect(
      validateEntryForParameter('dispositionModel', {
        ...disposition,
        categoricalValue: 'three-compartment',
      }),
    ).not.toBeNull();
    // Also rejected by the stored schema (approval re-validates).
    expect(
      parameterEntryInputSchema.safeParse({
        ...disposition,
        categoricalValue: 'three-compartment',
      }).success,
    ).toBe(false);
  });

  it('rejects a value from a DIFFERENT axis', () => {
    // `bolus` is an absorption word, not a disposition word.
    expect(
      validateEntryForParameter('dispositionModel', {
        ...disposition,
        categoricalValue: 'bolus',
      }),
    ).not.toBeNull();
    // …but it is valid on the absorption axis.
    expect(
      validateEntryForParameter('absorptionModel', {
        categoricalValue: 'bolus',
        unit: '',
      }),
    ).toBeNull();
  });

  it('requires the categorical value to be present', () => {
    const { categoricalValue: _omit, ...noValue } = disposition;
    void _omit;
    expect(parameterEntryInputSchema.safeParse(noValue).success).toBe(false);
    expect(validateEntryForParameter('dispositionModel', noValue)).not.toBeNull();
  });

  it('rejects numeric bounds on a categorical entry', () => {
    expect(
      parameterEntryInputSchema.safeParse({ ...disposition, low: 1, high: 2 })
        .success,
    ).toBe(false);
    expect(
      parameterEntryInputSchema.safeParse({ ...disposition, median: 1 }).success,
    ).toBe(false);
  });

  it('rejects a unit, matrix or scenario on a categorical entry', () => {
    expect(
      validateEntryForParameter('dispositionModel', {
        ...disposition,
        unit: 'h',
      }),
    ).not.toBeNull();
    expect(
      validateEntryForParameter('dispositionModel', {
        ...disposition,
        matrix: 'serum',
      }),
    ).not.toBeNull();
    expect(
      validateEntryForParameter('dispositionModel', {
        ...disposition,
        scenario: 'living_therapeutic',
      }),
    ).not.toBeNull();
  });

  it('rejects a categorical value smuggled onto a numeric parameter', () => {
    expect(
      validateEntryForParameter('halfLife', {
        median: 6,
        unit: 'h',
        categoricalValue: 'two-compartment',
      }),
    ).not.toBeNull();
  });

  it('round-trips through the create/edit schemas', () => {
    expect(parameterEntryCreateRequestSchema.safeParse(disposition).success).toBe(
      true,
    );
    expect(
      parameterEntryEditSchema.safeParse({ op: 'create', input: disposition })
        .success,
    ).toBe(true);
  });
});

describe('validateEntryForParameter (update path)', () => {
  // An update payload carries no `parameter`, so both write paths resolve it
  // from the target row and call this directly.
  it('validates a patch against the row\'s parameter', () => {
    expect(
      validateEntryForParameter('halfLife', { low: 4, high: 8, median: 6, unit: 'h' }),
    ).toBeNull();
    expect(
      validateEntryForParameter('halfLife', {
        low: 4,
        high: 8,
        median: 6,
        unit: 'h',
        matrix: 'serum',
      }),
    ).not.toBeNull();
    expect(
      validateEntryForParameter('therapeuticConcentration', {
        median: 6,
        unit: 'mg/L',
      }),
    ).not.toBeNull();
  });

  it('requires low and high for a requiresMinMax parameter, even on an update', () => {
    expect(
      validateEntryForParameter('halfLife', { median: 6, unit: 'h' }),
    ).toMatch(/low and high are required/i);
    expect(
      validateEntryForParameter('halfLife', { low: 4, unit: 'h' }),
    ).toMatch(/low and high are required/i);
  });
});


describe('parameterEntryCreateRequestSchema', () => {
  // The POST body deliberately stops at shape + cross-field invariants. Registry
  // rules run in the endpoint so their failure carries a translatable code
  // instead of a raw English zod message.
  const wrongUnit = {
    drugId: 1,
    parameter: 'halfLife',
    median: 6,
    unit: 'mg/L',
    citationId: 5,
  };

  it('leaves registry rules to the endpoint', () => {
    expect(parameterEntryCreateRequestSchema.safeParse(wrongUnit).success).toBe(
      true,
    );
    expect(validateEntryForParameter('halfLife', wrongUnit)).not.toBeNull();
  });

  it('still rejects shape and cross-field violations itself', () => {
    const { median: _m, ...noValue } = wrongUnit;
    void _m;
    expect(parameterEntryCreateRequestSchema.safeParse(noValue).success).toBe(
      false,
    );
    expect(
      parameterEntryCreateRequestSchema.safeParse({
        ...wrongUnit,
        low: 9,
        high: 4,
      }).success,
    ).toBe(false);
  });

  it('keeps the rules on the STORED payload, so approval re-validates', () => {
    // A queued proposal is re-checked against the registry before it publishes.
    expect(parameterEntryInputSchema.safeParse(wrongUnit).success).toBe(false);
    expect(
      parameterEntryEditSchema.safeParse({ op: 'create', input: wrongUnit })
        .success,
    ).toBe(false);
  });
});

describe('CV-2c — route-scoped parameter entries (ka)', () => {
  it('accepts a ka entry that carries a valid administration route', () => {
    expect(
      validateEntryForParameter('ka', { median: 1.2, unit: '1/h', route: 'oral' }),
    ).toBeNull();
    expect(
      parameterEntryInputSchema.safeParse({
        drugId: 1,
        parameter: 'ka',
        median: 1.2,
        unit: '1/h',
        route: 'oral',
        citationId: 5,
      }).success,
    ).toBe(true);
  });

  it('requires a route for a route-scoped parameter (ka)', () => {
    expect(validateEntryForParameter('ka', { median: 1.2, unit: '1/h' })).toMatch(
      /administration route is required/i,
    );
    expect(
      parameterEntryInputSchema.safeParse({
        drugId: 1,
        parameter: 'ka',
        median: 1.2,
        unit: '1/h',
        citationId: 5,
      }).success,
    ).toBe(false);
  });

  it('forbids a route on a non-route-scoped parameter', () => {
    expect(
      validateEntryForParameter('halfLife', { median: 4, unit: 'h', route: 'oral' }),
    ).toMatch(/not route-specific/i);
  });

  it('rejects a route outside the RouteId vocabulary', () => {
    expect(
      parameterEntryInputSchema.safeParse({
        drugId: 1,
        parameter: 'ka',
        median: 1.2,
        unit: '1/h',
        route: 'transdermal',
        citationId: 5,
      }).success,
    ).toBe(false);
  });
});

describe('CV-2c-4 — route-optional absorption declarations', () => {
  it('accepts a route-keyed absorption declaration', () => {
    expect(
      validateEntryForParameter('absorptionModel', {
        categoricalValue: 'first-order',
        route: 'oral',
      }),
    ).toBeNull();
    expect(
      parameterEntryInputSchema.safeParse({
        drugId: 1,
        parameter: 'absorptionModel',
        categoricalValue: 'first-order',
        unit: '',
        route: 'intranasal',
        citationId: 5,
      }).success,
    ).toBe(true);
  });

  it('still accepts a drug-level (route-less) absorption declaration', () => {
    // route-OPTIONAL, not route-required: a legacy drug-level declaration stays valid.
    expect(
      validateEntryForParameter('absorptionModel', { categoricalValue: 'bolus' }),
    ).toBeNull();
    expect(
      parameterEntryInputSchema.safeParse({
        drugId: 1,
        parameter: 'absorptionModel',
        categoricalValue: 'bolus',
        unit: '',
        citationId: 5,
      }).success,
    ).toBe(true);
  });

  it('rejects an out-of-vocabulary route on an absorption declaration', () => {
    expect(
      parameterEntryInputSchema.safeParse({
        drugId: 1,
        parameter: 'absorptionModel',
        categoricalValue: 'first-order',
        unit: '',
        route: 'transdermal',
        citationId: 5,
      }).success,
    ).toBe(false);
  });

  it('still rejects a stray unit/matrix on a route-keyed absorption declaration', () => {
    // route-optional relaxes only the route rule; the categorical dimension checks still apply.
    expect(
      validateEntryForParameter('absorptionModel', {
        categoricalValue: 'first-order',
        route: 'oral',
        unit: 'h',
      }),
    ).toMatch(/takes no unit/i);
  });

  it('accepts a route-specific bioavailability and a drug-level one (route-optional)', () => {
    expect(
      validateEntryForParameter('bioavailability', {
        low: 0.3,
        high: 0.4,
        median: 0.35,
        unit: 'fraction',
        route: 'intranasal',
      }),
    ).toBeNull();
    expect(
      validateEntryForParameter('bioavailability', {
        low: 0.75,
        high: 0.85,
        median: 0.8,
        unit: 'fraction',
      }),
    ).toBeNull();
    expect(
      parameterEntryInputSchema.safeParse({
        drugId: 1,
        parameter: 'bioavailability',
        low: 0.3,
        high: 0.4,
        median: 0.35,
        unit: 'fraction',
        route: 'intranasal',
        citationId: 5,
      }).success,
    ).toBe(true);
  });

  it('accepts a route-specific Tmax and a drug-level one (CV-2c-6, route-optional)', () => {
    // A per-route Tmax is what the extravascular `ka` inference solves against, so the write path
    // has to admit one — while a drug-level Tmax stays exactly as valid as it has always been.
    expect(validateEntryForParameter('tmax', { median: 0.25, unit: 'h', route: 'intranasal' })).toBeNull();
    expect(validateEntryForParameter('tmax', { median: 2, unit: 'h', route: 'oral' })).toBeNull();
    expect(validateEntryForParameter('tmax', { median: 2, unit: 'h' })).toBeNull();
    expect(
      parameterEntryInputSchema.safeParse({
        drugId: 1,
        parameter: 'tmax',
        median: 0.25,
        unit: 'h',
        route: 'intranasal',
        citationId: 5,
      }).success,
    ).toBe(true);
  });

  it('still rejects an unknown route on Tmax', () => {
    expect(validateEntryForParameter('tmax', { median: 1, unit: 'h', route: 'telepathy' })).toMatch(
      /Unknown administration route/,
    );
  });
});

/**
 * The DB-free half of the approval gate, shared by the two payload-rewrite
 * routes and the review card. A real proposal reached a reviewer with a whole
 * qualifying sentence in `qualifier` — "apparent Vd (Vss/(F×fm)); fm=0.1 FIXED
 * in the model, not estimated" — which the card rendered as an ordinary value
 * and the approval then refused. These are the refusals it has to name.
 */
describe('inspectParameterEntryPayload', () => {
  const target = { parameter: 'volumeOfDistribution', targetId: 42, referenceIds: [132] };
  const input = {
    drugId: 42,
    parameter: 'volumeOfDistribution',
    low: 2.9,
    high: 3.8,
    median: 3.34,
    unit: 'L/kg',
    n: 65,
    citationId: 132,
  };

  it('passes a payload the approval would accept', () => {
    expect(
      inspectParameterEntryPayload(target, { op: 'create', input }),
    ).toBeNull();
    expect(inspectParameterEntryPayload(target, { op: 'delete' })).toBeNull();
  });

  it('refuses free text in qualifier, which is an operator, not a note', () => {
    const problem = inspectParameterEntryPayload(target, {
      op: 'create',
      input: {
        ...input,
        qualifier: 'apparent Vd (Vss/(F×fm)); fm=0.1 FIXED in the model',
      },
    });
    expect(problem?.code).toBe('param_entry_invalid_payload');
    expect(problem?.message).toContain('qualifier');
    // The offending key, wrapper dropped, so a UI can name the field without
    // printing the validator's English prose (AGENTS.md i18n rule).
    expect(problem?.fields).toEqual(['qualifier']);
  });

  it('names no field when the refusal is about the payload as a whole', () => {
    // A cross-field invariant (a qualified entry is one threshold value, not
    // an interval) is raised at the root — there is no single key to blame.
    const problem = inspectParameterEntryPayload(target, {
      op: 'create',
      input: { ...input, qualifier: '<', low: 1, high: 5, median: undefined },
    });
    expect(problem?.code).toBe('param_entry_invalid_payload');
    expect(problem?.fields).toEqual([]);
  });

  it('refuses a create that no longer targets the queued drug/parameter', () => {
    expect(
      inspectParameterEntryPayload(target, {
        op: 'create',
        input: { ...input, drugId: 43 },
      })?.code,
    ).toBe('param_entry_target_mismatch');
    expect(
      inspectParameterEntryPayload(target, {
        op: 'create',
        input: { ...input, parameter: 'halfLife', unit: 'h', low: 6, high: 10, median: 8 },
      })?.code,
    ).toBe('param_entry_target_mismatch');
  });

  it('applies the registry rules to an update against the queued parameter', () => {
    // Vd takes no matrix — the same refusal the approval raises.
    expect(
      inspectParameterEntryPayload(target, {
        op: 'update',
        patch: { low: 2.9, high: 3.8, median: 3.34, unit: 'L/kg', matrix: 'serum', citationId: 132 },
      })?.code,
    ).toBe('param_entry_invalid_for_parameter');
  });

  it('refuses a citation the proposal does not list', () => {
    expect(
      inspectParameterEntryPayload(target, {
        op: 'create',
        input: { ...input, citationId: 999 },
      })?.code,
    ).toBe('param_entry_citation_mismatch');
  });
});

/**
 * An empty `reference_ids` array is a row that never set one, not a row citing
 * nothing: every server-side reader falls back to the singular `reference_id`.
 * A `??` in a caller keeps the empty array instead, and the payload is then
 * refused for citing the very source the row lists.
 */
describe('effectiveProposalReferenceIds', () => {
  it('prefers a populated array', () => {
    expect(
      effectiveProposalReferenceIds({ referenceIds: [7, 9], referenceId: 3 }),
    ).toEqual([7, 9]);
  });

  it('falls back to the singular id when the array is empty or absent', () => {
    expect(
      effectiveProposalReferenceIds({ referenceIds: [], referenceId: 7 }),
    ).toEqual([7]);
    expect(
      effectiveProposalReferenceIds({ referenceIds: null, referenceId: 7 }),
    ).toEqual([7]);
    expect(effectiveProposalReferenceIds({ referenceId: 7 })).toEqual([7]);
  });

  it('is empty when the row advertises no reference at all', () => {
    expect(
      effectiveProposalReferenceIds({ referenceIds: [], referenceId: null }),
    ).toEqual([]);
    expect(effectiveProposalReferenceIds({})).toEqual([]);
  });
});

/**
 * The verbatim source quote (migration 0119). It is optional at the schema
 * layer on purpose — making it structurally required would reject every
 * proposal queued before the field existed — and is enforced instead where it
 * matters, at agent-consensus auto-apply. What the schema owes is that a quote,
 * when present, is stored as WORDS: normalized, bounded, and never persisted as
 * an empty string pretending to be evidence.
 */
describe('source quote on an entry', () => {
  const quoted = (quote: unknown) => ({ ...valid, quote });

  it('accepts an entry with no quote at all', () => {
    const parsed = parameterEntryInputSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.quote).toBeUndefined();
  });

  it('keeps a quote verbatim', () => {
    const text = 'Median Tmax was 2 hours after a single 40 mg dose (fasted).';
    const parsed = parameterEntryInputSchema.safeParse(quoted(text));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.quote).toBe(text);
  });

  // A quote copied out of a two-column PDF arrives carrying the line breaks of
  // the page it was typeset on. Those are an artefact of the layout, not part
  // of what the source said, and leaving them in would make two records of the
  // same sentence compare unequal.
  it('collapses the whitespace a PDF copy-paste drags along', () => {
    const parsed = parameterEntryInputSchema.safeParse(
      quoted('  Median   Tmax\n\twas 2 hours.  '),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.quote).toBe('Median Tmax was 2 hours.');
  });

  // An empty quote must read as "no quote", not as "a quote that says nothing":
  // the auto-apply gate asks whether anybody wrote the sentence down, and a
  // blank string would answer yes.
  it('normalizes a blank or whitespace-only quote to an explicit null', () => {
    for (const blank of ['', '   ', '\n\t  \r\n']) {
      const parsed = parameterEntryInputSchema.safeParse(quoted(blank));
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.quote).toBeNull();
    }
  });

  // The distinction the update path depends on. An omitted quote is a client
  // saying NOTHING about it — which every integration written before the field
  // existed does — and must stay distinguishable from a client clearing it,
  // or an old client silently wipes provenance it never knew about.
  it('keeps "absent" and "explicitly cleared" distinguishable', () => {
    const absent = parameterEntryPatchSchema.safeParse({
      unit: 'mg/L',
      citationId: 5,
      low: 10,
      high: 30,
    });
    expect(absent.success).toBe(true);
    if (absent.success) expect(absent.data.quote).toBeUndefined();

    for (const cleared of [null, '', '   ']) {
      const parsed = parameterEntryPatchSchema.safeParse({
        unit: 'mg/L',
        citationId: 5,
        low: 10,
        high: 30,
        quote: cleared,
      });
      expect(parsed.success).toBe(true);
      // Not undefined: the caller asked for it to go.
      if (parsed.success) expect(parsed.data.quote).toBeNull();
    }
  });

  it('rejects a quote longer than the stored limit', () => {
    expect(parameterEntryInputSchema.safeParse(quoted('x'.repeat(1001))).success)
      .toBe(false);
    expect(parameterEntryInputSchema.safeParse(quoted('x'.repeat(1000))).success)
      .toBe(true);
  });

  // Length is measured on the NORMALIZED text, so a quote that is only over the
  // limit because of copy-paste whitespace is accepted rather than refused for
  // a reason the submitter cannot see.
  it('measures length after normalizing, not before', () => {
    const padded = 'word '.repeat(300); // 1500 raw chars, 1499 after trimming.
    expect(parameterEntryInputSchema.safeParse(quoted(padded)).success).toBe(false);
    const spaced = `${'x'.repeat(900)}${' '.repeat(400)}`;
    const parsed = parameterEntryInputSchema.safeParse(quoted(spaced));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.quote).toBe('x'.repeat(900));
  });

  it('rejects a non-string quote', () => {
    expect(parameterEntryInputSchema.safeParse(quoted(2)).success).toBe(false);
    expect(parameterEntryInputSchema.safeParse(quoted({})).success).toBe(false);
  });

  // The quote rides the stored proposal payload, so it survives the round trip
  // from submission to approval — which is what lets the gate read it back.
  it('survives the stored param_entry edit payload', () => {
    const parsed = parameterEntryEditSchema.safeParse({
      op: 'create',
      input: quoted('Median Tmax was 2 hours.'),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.op === 'create') {
      expect(parsed.data.input.quote).toBe('Median Tmax was 2 hours.');
    }
  });
});
