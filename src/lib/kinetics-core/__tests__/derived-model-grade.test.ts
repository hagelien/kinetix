/**
 * The derived tier's §5.1 scorer, and — more importantly — what it means at the
 * render gate. These cases pin the user-class outcome, because that is the part
 * a policy change would move and the part a mistake would silently widen.
 */
import { describe, expect, it } from 'vitest';
import { fixed, triangular } from '../param.js';
import { assessDerivedModel } from '../derived-model-grade.js';
import {
  evaluateGradePolicy,
  renderDisposition,
  statedDimensions,
} from '../grade-policy.js';
import type { DerivedRouteGrade } from '../derived-grade.js';
import type { DrugModelDefinition } from '../types.js';

const derivedDefinition = (
  over: Partial<DrugModelDefinition> = {},
): DrugModelDefinition => ({
  analyte: 'test-drug',
  displayName: 'Test Drug',
  modelId: 'test-drug-derived-v1',
  matrix: 'plasma',
  validationStatus: 'literature-derived',
  supportedBases: ['parent'],
  supportedCovariates: [],
  routes: {
    oral: {
      family: 'one-compartment-first-order',
      kaPerHour: fixed(1),
      eliminationHalfLifeHours: fixed(4),
      vdLitersPerKg: fixed(1),
      bioavailability: fixed(0.8),
    },
  },
  ...over,
});

const routeGrade = (over: Partial<DerivedRouteGrade> = {}): DerivedRouteGrade => ({
  route: 'oral',
  structure: {
    disposition: 'one-compartment',
    elimination: 'first-order',
    absorption: 'first-order',
  },
  axisProvenance: {
    disposition: 'asserted',
    elimination: 'asserted',
    absorption: 'asserted',
  },
  family: 'one-compartment-first-order',
  ...over,
});

const gradeOf = (
  route: DerivedRouteGrade,
  evidence = {},
  model = derivedDefinition(),
) => evaluateGradePolicy(assessDerivedModel(model, route, evidence));

describe('assessDerivedModel — §5.1 dimensions', () => {
  it('scores all eight dimensions', () => {
    expect(assessDerivedModel(derivedDefinition(), routeGrade())).toHaveLength(8);
  });

  it('lands even a fully-asserted derived model at D', () => {
    // Two dimensions are D for reasons about the CODE, not the data, and no
    // curation lifts either: the curve is a bare point estimate (nothing composes
    // the grade CV into the bands), and no per-input provenance is recorded.
    const result = gradeOf(routeGrade());
    expect(result.grade).toBe('D');
    expect(result.hardStops).toEqual([]);
    expect(result.limitingDimensions).toEqual(
      expect.arrayContaining(['parameter-provenance', 'uncertainty-semantics']),
    );
  });

  it('counts defaulted axes against completeness', () => {
    const oneDefaulted = assessDerivedModel(
      derivedDefinition(),
      routeGrade({
        axisProvenance: {
          disposition: 'defaulted',
          elimination: 'asserted',
          absorption: 'asserted',
        },
      }),
    ).find((a) => a.dimension === 'completeness');
    expect(oneDefaulted?.grade).toBe('B');

    const allDefaulted = assessDerivedModel(
      derivedDefinition(),
      routeGrade({
        axisProvenance: {
          disposition: 'defaulted',
          elimination: 'defaulted',
          absorption: 'defaulted',
        },
      }),
    ).find((a) => a.dimension === 'completeness');
    expect(allDefaulted?.grade).toBe('D');
  });

  it('counts a simplified axis against completeness like a defaulted one', () => {
    // A drug that declares two-compartment but runs one-compartment (the catalog cannot yet supply
    // the micro-constants) is not running the model its evidence describes. Declaring the richer
    // model must neither flatter the grade nor sink it below leaving the axis unstated.
    const simplified = assessDerivedModel(
      derivedDefinition(),
      routeGrade({ simplifiedFrom: { disposition: 'two-compartment' } }),
    ).find((a) => a.dimension === 'completeness');
    expect(simplified?.grade).toBe('B');
    expect(simplified?.reason).toContain('declares a two-compartment disposition');

    const defaulted = assessDerivedModel(
      derivedDefinition(),
      routeGrade({
        axisProvenance: { disposition: 'defaulted', elimination: 'asserted', absorption: 'asserted' },
      }),
    ).find((a) => a.dimension === 'completeness');
    expect(simplified?.grade).toBe(defaulted?.grade);
  });

  it('grades one cautious-default input C and two D, as §5.1 words it', () => {
    const completeness = (defaultedParameters: DerivedRouteGrade['defaultedParameters']) =>
      assessDerivedModel(derivedDefinition(), routeGrade({ defaultedParameters })).find(
        (a) => a.dimension === 'completeness',
      );
    const one = completeness(['bioavailability']);
    expect(one?.grade).toBe('C');
    expect(one?.reason).toContain('cautious default');
    expect(completeness(['bioavailability', 'ka'])?.grade).toBe('D');
    expect(completeness([])?.grade).toBe('A');
    // The worse of the axis count and the default count stands.
    expect(
      assessDerivedModel(
        derivedDefinition(),
        routeGrade({
          defaultedParameters: ['ka'],
          axisProvenance: { disposition: 'defaulted', elimination: 'defaulted', absorption: 'defaulted' },
        }),
      ).find((a) => a.dimension === 'completeness')?.grade,
    ).toBe('D');
  });

  it('counts an attributed route against completeness like a defaulted axis', () => {
    // The route the catalog never named is a disclosed assumption about the model, not curation:
    // §5.1 scores an input filled from a default against completeness, and this is one.
    const attributed = assessDerivedModel(
      derivedDefinition(),
      routeGrade({ routeProvenance: 'attributed' }),
    ).find((a) => a.dimension === 'completeness');
    expect(attributed?.grade).toBe('B');
    expect(attributed?.reason).toContain('administration route');

    // It stacks with the axes, so a wholly-defaulted model is not flattered by the route being
    // the only thing anyone stated.
    const withDefaultedAxis = assessDerivedModel(
      derivedDefinition(),
      routeGrade({
        routeProvenance: 'attributed',
        axisProvenance: {
          disposition: 'defaulted',
          elimination: 'asserted',
          absorption: 'asserted',
        },
      }),
    ).find((a) => a.dimension === 'completeness');
    expect(withDefaultedAxis?.grade).toBe('C');

    // An asserted route is the default reading, so an absent fact changes nothing.
    expect(
      assessDerivedModel(derivedDefinition(), routeGrade({ routeProvenance: 'asserted' })).find(
        (a) => a.dimension === 'completeness',
      )?.grade,
    ).toBe('A');
  });

  it('names an inferred parameter under provenance, not completeness', () => {
    // An inferred ka is present, so nothing is MISSING — the deficiency is that it
    // traces to no source, which is a provenance fact.
    const assessments = assessDerivedModel(
      derivedDefinition(),
      routeGrade({ inferredParameters: ['ka'] }),
    );
    expect(assessments.find((a) => a.dimension === 'completeness')?.grade).toBe('A');
    const provenance = assessments.find((a) => a.dimension === 'parameter-provenance');
    expect(provenance?.grade).toBe('D');
    expect(provenance?.reason).toContain('ka');
  });

  it('never claims a derived value is cited when the record cannot show it', () => {
    // A record written before sources were recorded cannot tell a cited t½ from a
    // seeded one. Claiming better than D here would be the manufactured evidence
    // the contract forbids.
    const provenance = assessDerivedModel(derivedDefinition(), routeGrade()).find(
      (a) => a.dimension === 'parameter-provenance',
    );
    expect(provenance?.grade).toBe('D');
    expect(provenance?.reason).toMatch(/before per-input sources were recorded/);
  });

  describe('parameter provenance from recorded input sources', () => {
    const cited = (...citationIds: number[]) => ({ basis: 'cited' as const, citationIds });
    const provenanceOf = (route: DerivedRouteGrade) =>
      assessDerivedModel(derivedDefinition(), route).find(
        (a) => a.dimension === 'parameter-provenance',
      );

    it('reaches C, and no better, when every catalog input is cited', () => {
      // Pooled values trace to studies, not to a table, page or extraction:
      // §5.1's C, never B.
      const provenance = provenanceOf(
        routeGrade({
          inputSources: {
            eliminationHalfLife: cited(1, 2),
            vd: cited(3),
            ka: cited(4),
            bioavailability: cited(5),
          },
        }),
      );
      expect(provenance?.grade).toBe('C');
      expect(provenance?.reason).toContain('only to study level');
    });

    it('stays D when one input is a hand-entered value, and names it', () => {
      const provenance = provenanceOf(
        routeGrade({
          inputSources: {
            eliminationHalfLife: cited(1),
            vd: { basis: 'uncited', reason: 'authored-value' },
          },
        }),
      );
      expect(provenance?.grade).toBe('D');
      expect(provenance?.reason).toContain('vd (a hand-entered catalog value');
    });

    it('stays D for a pool with an uncited entry, or a stale cache', () => {
      for (const reason of ['uncited-entry', 'stale-cache'] as const) {
        const provenance = provenanceOf(
          routeGrade({
            inputSources: {
              eliminationHalfLife: { basis: 'uncited', reason },
              vd: cited(1),
            },
          }),
        );
        expect(provenance?.grade).toBe('D');
      }
    });

    it('judges an inferred role by the source it was solved from, and D when none was recorded', () => {
      const withSource = provenanceOf(
        routeGrade({
          inferredParameters: ['ka'],
          inputSources: {
            eliminationHalfLife: cited(1),
            vd: cited(2),
            ka: cited(3),
            bioavailability: cited(4),
          },
        }),
      );
      expect(withSource?.grade).toBe('C');
      expect(withSource?.reason).toContain('ka was solved from another stored observable');
      const without = provenanceOf(
        routeGrade({
          inferredParameters: ['ka'],
          inputSources: { eliminationHalfLife: cited(1), vd: cited(2), bioavailability: cited(4) },
        }),
      );
      expect(without?.grade).toBe('D');
      expect(without?.reason).toContain('ka (no source recorded)');
    });

    it('leaves a defaulted input to completeness rather than counting it unsourced', () => {
      const provenance = provenanceOf(
        routeGrade({
          defaultedParameters: ['bioavailability'],
          inputSources: { eliminationHalfLife: cited(1), vd: cited(2), ka: cited(3) },
        }),
      );
      expect(provenance?.grade).toBe('C');
    });

    it('fails closed when the record omits a required input, even if every listed one is cited', () => {
      // One-compartment first-order needs ka, t½, Vd and F; a record listing only
      // a cited Vd must not read as "every catalog value is cited".
      const provenance = provenanceOf(routeGrade({ inputSources: { vd: cited(1) } }));
      expect(provenance?.grade).toBe('D');
      expect(provenance?.reason).toContain('eliminationHalfLife (no source recorded)');
      expect(provenance?.reason).toContain('ka (no source recorded)');
    });

    it('is D when no input has a recorded source at all', () => {
      expect(provenanceOf(routeGrade({ inputSources: {} }))?.grade).toBe('D');
    });

    it('still lands the whole model at D while its curve is a point estimate', () => {
      // Sources lift one D. The other — a bare point estimate — is about the
      // engine, and keeps every derived model away from non-reviewers.
      const result = gradeOf(
        routeGrade({
          inputSources: {
            eliminationHalfLife: cited(1),
            vd: cited(2),
            ka: cited(3),
            bioavailability: cited(4),
          },
        }),
      );
      expect(result.grade).toBe('D');
      expect(result.limitingDimensions).toEqual(['uncertainty-semantics']);
    });
  });

  it('grades the point-estimate output D rather than calling it a range', () => {
    // Every derived parameter is fixed(median) and no observation-error layer is
    // declared, so the engine emits p05 = median = p95. Calling that a "plausible
    // range" would be the mislabelled interval §5.1 makes a hard stop.
    const uncertainty = assessDerivedModel(derivedDefinition(), routeGrade()).find(
      (a) => a.dimension === 'uncertainty-semantics',
    );
    expect(uncertainty?.grade).toBe('D');
    expect(uncertainty?.reason).toMatch(/point estimate/);
    expect(uncertainty?.reason).not.toMatch(/plausible range/);
  });

  it('hard-stops on a route/analyte mismatch, a non-transferable population, or a collapsed contradiction', () => {
    for (const evidence of [
      { routeOrAnalyteMismatch: true },
      { populationNonTransferable: true },
      { contradictionCollapsed: true },
    ]) {
      const result = gradeOf(routeGrade(), evidence);
      expect(result.grade, JSON.stringify(evidence)).toBe('ungraded');
      expect(result.hardStops.length).toBeGreaterThan(0);
    }
  });

  it('names the matrix bridge when one is applied', () => {
    const bridged = assessDerivedModel(derivedDefinition(), routeGrade(), {
      matrixBridgedWithoutValidation: true,
    }).find((a) => a.dimension === 'matrix-route-match');
    expect(bridged?.grade).toBe('C');
    expect(bridged?.reason).toContain('blood:plasma');
  });
});

describe('assessDerivedModel — what it means at the render gate', () => {
  it('shows a derived curve to nobody who has not acknowledged it', () => {
    // The whole user-visible consequence of the derived rollout, pinned rather than
    // left to be discovered: at D no floor admits it outright, and the reviewer path
    // runs through a recorded acknowledgement.
    const result = gradeOf(routeGrade());
    for (const userClass of ['anonymous', 'authenticated', 'contributor'] as const) {
      expect(renderDisposition(result, userClass), userClass).toBe('hidden');
    }
    for (const userClass of ['editor', 'admin'] as const) {
      expect(renderDisposition(result, userClass), userClass).toBe(
        'acknowledge-in-review-workspace',
      );
    }
  });

  it('hides a hard-stopped derived model from reviewers too', () => {
    const result = gradeOf(routeGrade(), { routeOrAnalyteMismatch: true });
    for (const userClass of ['anonymous', 'editor', 'admin'] as const) {
      expect(renderDisposition(result, userClass), userClass).toBe('hidden');
    }
  });

  it('sends a three-axis-defaulted model to the reviewer acknowledgement path', () => {
    // Completeness D drags the whole model to D, which no floor admits outright.
    const result = gradeOf(
      routeGrade({
        axisProvenance: {
          disposition: 'defaulted',
          elimination: 'defaulted',
          absorption: 'defaulted',
        },
      }),
    );
    expect(result.grade).toBe('D');
    expect(renderDisposition(result, 'anonymous')).toBe('hidden');
    expect(renderDisposition(result, 'editor')).toBe('acknowledge-in-review-workspace');
    expect(renderDisposition(result, 'editor', { acknowledged: true })).toBe(
      'render-with-limitations',
    );
  });

  it('is not rescued by extending the public tier — the D dimensions are code, not policy', () => {
    // Worth pinning because it is the tempting shortcut: §5.2's publicTier lowers the
    // non-reviewer floor to C, which still does not admit a D. Composing the grade CV
    // into the bands and recording per-input provenance are what move this, and both
    // are code changes.
    const result = gradeOf(routeGrade());
    expect(renderDisposition(result, 'anonymous', { publicTier: true })).toBe('hidden');
  });
});

describe('statedDimensions — every reason, each named once', () => {
  it('does not double-report a hard stop', () => {
    // `evaluateGradePolicy` puts a hard stop in BOTH `hardStops` and `disclosable`,
    // so a surface concatenating the two lists states it twice.
    const result = gradeOf(routeGrade(), { routeOrAnalyteMismatch: true });
    expect(result.hardStops.length).toBeGreaterThan(0);
    const stated = statedDimensions(result);
    expect(new Set(stated.map((d) => d.dimension)).size).toBe(stated.length);
  });

  it('falls back to the hard stops when disclosable is empty', () => {
    // A hand-built result — `gradeResult`'s "no committed grade" case — carries its
    // only dimension in `hardStops`. Reading `disclosable` alone states nothing.
    expect(
      statedDimensions({
        grade: 'ungraded',
        limitingDimensions: [],
        disclosable: [],
        hardStops: [
          { dimension: 'parameter-provenance', grade: 'hard-stop', reason: 'No grade.' },
        ],
      }),
    ).toHaveLength(1);
  });
});

describe('uncertainty semantics from the reported spreads', () => {
  const uncertaintyOf = (model: DrugModelDefinition, route = routeGrade()) =>
    assessDerivedModel(model, route).find((a) => a.dimension === 'uncertainty-semantics');
  const oralWith = (specs: Partial<Record<'ka' | 't' | 'vd' | 'f', ReturnType<typeof fixed>>>) =>
    derivedDefinition({
      routes: {
        oral: {
          family: 'one-compartment-first-order',
          kaPerHour: specs.ka ?? fixed(1),
          eliminationHalfLifeHours: specs.t ?? fixed(4),
          vdLitersPerKg: specs.vd ?? fixed(1),
          bioavailability: specs.f ?? fixed(0.8),
        },
      },
    });

  it('is C, labelled a plausible range, when every input carries its spread', () => {
    const assessment = uncertaintyOf(
      oralWith({
        ka: triangular(0.5, 1, 2),
        t: triangular(2, 4, 9),
        vd: triangular(0.5, 1, 2),
        f: triangular(0.6, 0.8, 0.9),
      }),
    );
    expect(assessment?.grade).toBe('C');
    expect(assessment?.reason).toContain('plausible range, not a confidence or prediction interval');
  });

  it('is D, naming the input, when one input has no spread', () => {
    const assessment = uncertaintyOf(
      oralWith({ ka: triangular(0.5, 1, 2), t: triangular(2, 4, 9), f: triangular(0.6, 0.8, 0.9) }),
    );
    expect(assessment?.grade).toBe('D');
    expect(assessment?.reason).toContain('vd has no reported spread');
  });

  it('exempts a defaulted F, which is a disclosed bound rather than a measured value', () => {
    const assessment = uncertaintyOf(
      oralWith({ ka: triangular(0.5, 1, 2), t: triangular(2, 4, 9), vd: triangular(0.5, 1, 2), f: fixed(1) }),
      routeGrade({ defaultedParameters: ['bioavailability'] }),
    );
    expect(assessment?.grade).toBe('C');
  });

  it('is D when every input is fixed', () => {
    expect(uncertaintyOf(oralWith({}))?.grade).toBe('D');
  });
});
