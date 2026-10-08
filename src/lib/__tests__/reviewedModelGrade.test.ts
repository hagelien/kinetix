import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  admitsExport,
  admitsFigures,
  admittedResults,
  gradeResult,
  userClassForRole,
} from '@/lib/reviewedModelGrade';
import * as core from '@/lib/kinetics-core';
import type { DrugSimResult } from '@/types/simulator';

vi.mock('@/lib/kinetics-core', async (importOriginal) => {
  const actual = await importOriginal<typeof core>();
  return {
    ...actual,
    resolveModel: vi.fn(actual.resolveModel),
    resolvableAnalyteIds: vi.fn(actual.resolvableAnalyteIds),
    isDerivedAnalyte: vi.fn(actual.isDerivedAnalyte),
    derivedRouteGrade: vi.fn(actual.derivedRouteGrade),
  };
});

function result(overrides: Partial<DrugSimResult['assumptions']> = {}): DrugSimResult {
  return {
    drugConfigId: 'c1',
    engine: 'pk-montecarlo',
    questionMode: 'concentration-from-dose',
    median: 1, p05: 0, p25: 0.5, p75: 1.5, p95: 2,
    unit: 'mg/L',
    timeSeries: [],
    assumptions: {
      model: 'two-compartment, first-order elimination',
      route: 'oral',
      halfLife: { type: 'fixed', value: 28 },
      vd: { type: 'fixed', value: 19 },
      f: { type: 'fixed', value: 0.06 },
      weightScaling: true,
      modelId: 'thc-two-comp-v1',
      family: 'two-compartment-first-order',
      validationStatus: 'literature-derived',
      nativeMatrix: 'plasma',
      ...overrides,
    },
    sensitivity: [], warnings: [], seed: 1, drawCount: 100,
  } as DrugSimResult;
}

describe('gradeResult', () => {
  it('maps permission tiers onto policy user classes', () => {
    expect(userClassForRole(null)).toBe('anonymous');
    expect(userClassForRole('editor')).toBe('editor');
    // An unknown role must not be trusted upward.
    expect(userClassForRole('wizard')).toBe('anonymous');
  });

  it('grades a reviewed model C and still renders it to the public', () => {
    const graded = gradeResult(result(), {
      role: null,
      displayMatrix: 'plasma',
    })!;
    expect(graded.policy.grade).toBe('C');
    expect(graded.disposition).toBe('render-with-limitations');
  });

  it('records a model that clears its floor as admitted by its GRADE', () => {
    // An acknowledgement that changes nothing must not downgrade a model that already
    // renders on merit — otherwise a stray `true` would silently strip a reviewed C
    // out of every export.
    const graded = gradeResult(result(), {
      role: null,
      displayMatrix: 'plasma',
      isAcknowledged: () => true,
    })!;
    expect(graded.disposition).toBe('render-with-limitations');
    expect(graded.admittedBy).toBe('grade');
  });

  it('adds the matrix dimension only when the VIEW bridges matrices', () => {
    const native = gradeResult(result(), { role: null, displayMatrix: 'plasma' })!;
    const bridged = gradeResult(result(), { role: null, displayMatrix: 'whole_blood' })!;
    const has = (g: typeof native) =>
      g.policy.disclosable.some((d) => d.dimension === 'matrix-route-match');
    expect(has(native)).toBe(false);
    expect(has(bridged)).toBe(true);
  });

  it('grades nothing for a result with no reviewed model', () => {
    expect(gradeResult(result({ modelId: undefined }), {
      role: null, displayMatrix: 'plasma',
    })).toBeNull();
    // A model id that no longer resolves must not be graded as something else.
    expect(gradeResult(result({ modelId: 'retired-model-v0' }), {
      role: null, displayMatrix: 'plasma',
    })).toBeNull();
    expect(gradeResult(undefined, { role: null, displayMatrix: 'plasma' })).toBeNull();
  });
});

describe('gradeResult — derived tier', () => {
  /**
   * The derived tier is empty in the committed artifact (no drug declares a route
   * yet), so the branch is exercised against a stubbed release. What is pinned here
   * is the POLICY outcome, which is what a future change would move by accident.
   */
  const derivedModel = {
    analyte: 'derived-drug',
    displayName: 'Derived Drug',
    modelId: 'derived-drug-derived-v1',
    matrix: 'plasma' as const,
    validationStatus: 'literature-derived' as const,
    supportedBases: ['parent' as const],
    supportedCovariates: [],
    routes: {},
  };
  const routeGrade = {
    route: 'oral' as const,
    structure: {
      disposition: 'one-compartment' as const,
      elimination: 'first-order' as const,
      absorption: 'first-order' as const,
    },
    axisProvenance: {
      disposition: 'asserted' as const,
      elimination: 'asserted' as const,
      absorption: 'asserted' as const,
    },
    family: 'one-compartment-first-order' as const,
  };

  const derivedResult = () => result({ modelId: 'derived-drug-derived-v1' });

  beforeEach(() => {
    vi.mocked(core.resolvableAnalyteIds).mockReturnValue(['derived-drug']);
    vi.mocked(core.resolveModel).mockReturnValue(derivedModel as never);
    vi.mocked(core.isDerivedAnalyte).mockReturnValue(true);
    vi.mocked(core.derivedRouteGrade).mockReturnValue(routeGrade);
  });
  afterEach(() => vi.restoreAllMocks());

  it('renders a derived model to nobody until a reviewer acknowledges it', () => {
    // A derived model grades D on today's implementation (point-estimate output, no
    // per-input provenance), so unlike a reviewed C it clears no floor at all.
    for (const role of [null, 'contributor']) {
      expect(gradeResult(derivedResult(), { role, displayMatrix: 'plasma' })?.disposition, String(role)).toBe('hidden');
    }
    for (const role of ['editor', 'admin']) {
      expect(gradeResult(derivedResult(), { role, displayMatrix: 'plasma' })?.disposition, role).toBe(
        'acknowledge-in-review-workspace',
      );
    }
  });

  it('renders it to a reviewer who has acknowledged, carrying its limitations', () => {
    for (const role of ['editor', 'admin']) {
      const graded = gradeResult(derivedResult(), {
        role,
        displayMatrix: 'plasma',
        isAcknowledged: () => true,
      })!;
      expect(graded.policy.grade, role).toBe('D');
      expect(graded.disposition, role).toBe('render-with-limitations');
    }
  });

  it('carries a simplified structure axis to the surface, and nothing when none', () => {
    vi.mocked(core.derivedRouteGrade).mockReturnValue({
      ...routeGrade,
      simplifiedFrom: { disposition: 'two-compartment' },
    });
    const graded = gradeResult(derivedResult(), {
      role: 'editor',
      displayMatrix: 'plasma',
      isAcknowledged: () => true,
    })!;
    expect(graded.structureSimplifications).toEqual([
      { axis: 'disposition', declared: 'two-compartment', runs: 'one-compartment' },
    ]);

    vi.mocked(core.derivedRouteGrade).mockReturnValue(routeGrade);
    expect(
      gradeResult(derivedResult(), { role: 'editor', displayMatrix: 'plasma' })!
        .structureSimplifications,
    ).toBeUndefined();
  });

  it('carries cautious defaults to the surface, and nothing when none', () => {
    vi.mocked(core.derivedRouteGrade).mockReturnValue({
      ...routeGrade,
      defaultedParameters: ['bioavailability'],
    });
    expect(
      gradeResult(derivedResult(), { role: 'editor', displayMatrix: 'plasma' })!.cautiousDefaults,
    ).toEqual(['bioavailability']);
    vi.mocked(core.derivedRouteGrade).mockReturnValue(routeGrade);
    expect(
      gradeResult(derivedResult(), { role: 'editor', displayMatrix: 'plasma' })!.cautiousDefaults,
    ).toBeUndefined();
  });

  it('never lets an acknowledgement elevate a non-reviewer', () => {
    // The acknowledgement is a reviewer-only path. If a non-reviewer's client ever
    // set the flag — a stale record, a shared browser profile, a bug — it must buy
    // nothing at all.
    for (const role of [null, 'authenticated', 'contributor']) {
      expect(
        gradeResult(derivedResult(), {
          role,
          displayMatrix: 'plasma',
          isAcknowledged: () => true,
        })
          ?.disposition,
        String(role),
      ).toBe('hidden');
    }
  });

  it('never lets an acknowledgement reach a hard stop', () => {
    // A hard stop is not a low grade. An ungradeable derived model stays hidden from
    // an acknowledging admin, or the acknowledgement would become a way around the
    // one rule the policy states as absolute.
    vi.mocked(core.derivedRouteGrade).mockReturnValue(undefined);
    expect(
      gradeResult(derivedResult(), {
        role: 'admin',
        displayMatrix: 'plasma',
        isAcknowledged: () => true,
      })?.disposition,
    ).toBe('hidden');
  });

  it('hides — never returns null for — a derived model with no committed grade', () => {
    // The load-bearing case. `null` means "not governed by the policy", which the
    // simulator gate renders. A derived curve with nothing to disclose must not.
    vi.mocked(core.derivedRouteGrade).mockReturnValue(undefined);
    const graded = gradeResult(derivedResult(), { role: 'admin', displayMatrix: 'plasma' });
    expect(graded).not.toBeNull();
    expect(graded?.disposition).toBe('hidden');
    expect(graded?.policy.grade).toBe('ungraded');
    expect(graded?.policy.hardStops[0]?.reason).toMatch(/no committed grade/);
  });

  it('keeps a held derived result hidden once its model is withdrawn from the catalogue', () => {
    // A live refresh can withdraw a derived model while a curve it produced is still on
    // screen. Its id then resolves nothing, and `null` would let the curve render to everyone.
    vi.mocked(core.resolvableAnalyteIds).mockReturnValue([]);
    const graded = gradeResult(result({ modelId: 'withdrawn-drug-derived-v1' }), {
      role: null,
      displayMatrix: 'plasma',
    });
    expect(graded?.disposition).toBe('hidden');
    expect(graded?.admittedBy).toBe('withheld');
    // A reviewed id that no longer resolves is still "not governed", as before.
    expect(gradeResult(result({ modelId: 'retired-one-comp-v1' }), { role: null, displayMatrix: 'plasma' })).toBeNull();
  });

  it('grades the route the run actually used', () => {
    gradeResult(result({ modelId: 'derived-drug-derived-v1', route: 'insufflation' }), {
      role: 'admin',
      displayMatrix: 'plasma',
    });
    // `insufflation` is the app's name for the core's `intranasal`.
    expect(vi.mocked(core.derivedRouteGrade)).toHaveBeenCalledWith('derived-drug', 'intranasal');
  });

  it('marks an acknowledged D as admitted by the acknowledgement, not by its grade', () => {
    // The distinction an export depends on: §5.1 says an acknowledgement must not
    // survive into exports, and an acknowledged D renders `render-with-limitations`
    // exactly like an ordinary C, so the disposition alone cannot tell them apart.
    const unaided = gradeResult(derivedResult(), { role: 'admin', displayMatrix: 'plasma' })!;
    expect(unaided.admittedBy).toBe('withheld');

    const acknowledged = gradeResult(derivedResult(), {
      role: 'admin',
      displayMatrix: 'plasma',
      isAcknowledged: () => true,
    })!;
    expect(acknowledged.disposition).toBe('render-with-limitations');
    expect(acknowledged.admittedBy).toBe('acknowledgement');
  });

  it('versions the acknowledgement by the EVIDENCE, not by the release checksum', () => {
    // The bug this pins, and it defeats TWO wrong keys. The release checksum hashes
    // `{version, definitions}` and the artifact's `derivedGrades` sit deliberately
    // outside it, so a regeneration that changes only grade facts leaves it identical.
    // And the DISCLOSED policy is no better here: §5.1 discloses only dimensions below
    // B, so this axis moving from asserted to defaulted takes completeness from A to B
    // and never appears in `disclosable` at all. Only the complete assessment set sees
    // it — which is why that is what the version hashes.
    const before = gradeResult(derivedResult(), { role: 'admin', displayMatrix: 'plasma' })!;

    vi.mocked(core.derivedRouteGrade).mockReturnValue({
      ...routeGrade,
      axisProvenance: { ...routeGrade.axisProvenance, absorption: 'defaulted' as const },
    });
    const after = gradeResult(derivedResult(), { role: 'admin', displayMatrix: 'plasma' })!;

    expect(after.acknowledgementVersion).not.toBe(before.acknowledgementVersion);
  });

  it('does not let an acknowledgement carry over to changed evidence', () => {
    // The consequence of the above, stated as the behaviour that matters: a reviewer
    // who accepted the old disclosure is asked again, not assumed to agree.
    const before = gradeResult(derivedResult(), { role: 'admin', displayMatrix: 'plasma' })!;
    const accepted = new Set([before.acknowledgementVersion]);

    expect(
      gradeResult(derivedResult(), {
        role: 'admin',
        displayMatrix: 'plasma',
        isAcknowledged: (v) => accepted.has(v),
      })?.disposition,
    ).toBe('render-with-limitations');

    vi.mocked(core.derivedRouteGrade).mockReturnValue({
      ...routeGrade,
      axisProvenance: { ...routeGrade.axisProvenance, absorption: 'defaulted' as const },
    });
    expect(
      gradeResult(derivedResult(), {
        role: 'admin',
        displayMatrix: 'plasma',
        isAcknowledged: (v) => accepted.has(v),
      })?.disposition,
    ).toBe('acknowledge-in-review-workspace');
  });

  it('versions a matrix bridge separately, and finds the original record on the way back', () => {
    // The bridge adds a stated deficiency, so it is different evidence and needs its
    // own acknowledgement — but switching the matrix back must not have destroyed the
    // first one, because each evidence state keeps its own record.
    const native = gradeResult(derivedResult(), { role: 'admin', displayMatrix: 'plasma' })!;
    const bridged = gradeResult(derivedResult(), {
      role: 'admin',
      displayMatrix: 'whole_blood',
    })!;
    expect(bridged.acknowledgementVersion).not.toBe(native.acknowledgementVersion);
    expect(
      gradeResult(derivedResult(), { role: 'admin', displayMatrix: 'plasma' })!
        .acknowledgementVersion,
    ).toBe(native.acknowledgementVersion);
  });

  it('still returns null for a model that resolves to nothing at all', () => {
    vi.mocked(core.resolvableAnalyteIds).mockReturnValue([]);
    expect(gradeResult(result({ modelId: 'not-a-model' }), { role: null, displayMatrix: 'plasma' })).toBeNull();
  });
});


describe('admitsFigures — one gate for every numeric surface', () => {
  const graded = (disposition: string) =>
    ({
      policy: { grade: 'D', limitingDimensions: [], disclosable: [], hardStops: [] },
      disposition,
      acknowledgementVersion: 'v-test',
      admittedBy: disposition === 'render' || disposition === 'render-with-limitations'
        ? 'grade'
        : 'withheld',
    }) as never;

  it('admits only the two rendering dispositions', () => {
    expect(admitsFigures(graded('render'))).toBe(true);
    expect(admitsFigures(graded('render-with-limitations'))).toBe(true);
    expect(admitsFigures(graded('hidden'))).toBe(false);
    expect(admitsFigures(graded('acknowledge-in-review-workspace'))).toBe(false);
  });

  it('admits a result this policy does not govern', () => {
    // `null` is the ethanol/Widmark and KineLab engines, and older saved cases.
    // Treating it as withheld would blank surfaces the policy says nothing about.
    expect(admitsFigures(null)).toBe(true);
    expect(admitsFigures(undefined)).toBe(true);
  });

  it('filters a result map down to what may show figures', () => {
    const results = { a: 1, b: 2, c: 3 };
    const grades = {
      a: graded('render'),
      b: graded('hidden'),
      c: null,
    };
    expect(admittedResults(results, grades)).toEqual({ a: 1, c: 3 });
  });

  it('filters nothing when no grades are supplied at all', () => {
    expect(admittedResults({ a: 1 }, undefined)).toEqual({ a: 1 });
  });

  it('admitsExport is stricter by exactly the acknowledgement case', () => {
    const by = (admittedBy: string) =>
      ({
        policy: { grade: 'D', limitingDimensions: [], disclosable: [], hardStops: [] },
        disposition: 'render-with-limitations',
        acknowledgementVersion: 'v',
        admittedBy,
      }) as never;
    expect(admitsFigures(by('grade'))).toBe(true);
    expect(admitsExport(by('grade'))).toBe(true);
    // The one divergence: on screen in a labelled workspace, yes; in a file, no.
    expect(admitsFigures(by('acknowledgement'))).toBe(true);
    expect(admitsExport(by('acknowledgement'))).toBe(false);
    expect(admitsFigures(by('withheld'))).toBe(false);
    expect(admitsExport(by('withheld'))).toBe(false);
    // An ungoverned result still exports.
    expect(admitsExport(null)).toBe(true);
  });
});
