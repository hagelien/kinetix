import { describe, it, expect } from 'vitest';

import { buildProfileFromCase } from './buildProfile.js';
import { BENZODIAZEPINE_GRAPH, DIAZEPAM_FIXTURE_CASE } from './fixtures.js';
import { BENZODIAZEPINE_MODULE } from './modules/benzodiazepines.js';
import { COCAINE_MODULE } from './modules/cocaine.js';
import { computeAxis } from './profileModel.js';
import type { PatternSubstanceModule } from './substanceModules.js';
import type { PatternCaseData } from '../../types/patternCase.js';

function build(caseData: PatternCaseData, overrides?: Record<string, string>, locale?: string) {
  return buildProfileFromCase({
    caseData,
    modules: [BENZODIAZEPINE_MODULE],
    graph: BENZODIAZEPINE_GRAPH,
    contextOverrides: overrides,
    locale,
  });
}

describe('buildProfileFromCase', () => {
  it('formats values in the language the reader is using', () => {
    const nb = build(DIAZEPAM_FIXTURE_CASE);
    const en = build(DIAZEPAM_FIXTURE_CASE, undefined, 'en-GB');

    const first = (model: ReturnType<typeof build>) =>
      model.ratioGroups[0]?.rows[0]?.valueText;

    expect(first(nb)).toBe('1,45');
    expect(first(en)).toBe('1.45');
  });

  it('will not let specimen order decide a dilution verdict', () => {
    // Two urine specimens with different creatinine: taking the first would let
    // reordering flip the stated support between Hp and Hd.
    //
    // Exercised through a module variant carrying a threshold rule, because no
    // shipped signal has one — the module's only threshold rule was withdrawn
    // when its cut-offs turned out to have no registered published source. The
    // guarantee being tested belongs to the pipeline, not to that rule.
    const withThreshold: PatternSubstanceModule = {
      ...BENZODIAZEPINE_MODULE,
      signals: BENZODIAZEPINE_MODULE.signals.map((signal) =>
        signal.id === 'sample_dilution'
          ? {
              ...signal,
              strength: {
                type: 'threshold' as const,
                quantity: { type: 'specimen_metric' as const, metric: 'urine_creatinine' as const },
                bands: [{ between: [4, 20] as [number, number], strength: 'moderate' as const, side: 'Hp' as const }],
                fallback: { strength: 'no_support' as const, side: 'Hp' as const },
                thresholdProvenance: [{ type: 'pmid' as const, identifier: '19161663' }] as [
                  { type: 'pmid'; identifier: string },
                ],
              },
            }
          : signal,
      ),
    };

    const twoUrines: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: [
        ...DIAZEPAM_FIXTURE_CASE.specimens,
        { id: 'urine-2', matrix: 'urine', urine: { creatinineMmolL: 1.2 } },
      ],
    };

    const stated = {
      bmatrix: 'antemortem_whole_blood',
      umatrix: 'spot',
      interval: 'simultaneous',
      hydro: 'none',
      history: 'repeated',
    };

    const withModule = (caseData: PatternCaseData) =>
      buildProfileFromCase({
        caseData,
        modules: [withThreshold],
        graph: BENZODIAZEPINE_GRAPH,
        contextOverrides: stated,
      }).signals.find((s) => s.id === 'sample_dilution');

    expect(withModule(DIAZEPAM_FIXTURE_CASE)?.strength.kind).toBe('stated');
    expect(withModule(twoUrines)?.strength).toEqual({
      kind: 'not_calculable',
      reasonKey: 'pattern.profile.strength.basisIndeterminate',
    });
  });

  it('will not treat an unmeasured urine specimen as consent', () => {
    // Two urine collections, one of them with no creatinine. Counting the
    // measurements rather than the specimens made this look unambiguous — but
    // the signal is not bound to a specimen yet, so the unmeasured collection
    // is still a competing candidate for what "the urine sample" refers to.
    const oneMeasured: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: [
        ...DIAZEPAM_FIXTURE_CASE.specimens,
        { id: 'urine-2', matrix: 'urine' },
      ],
    };

    const withThreshold: PatternSubstanceModule = {
      ...BENZODIAZEPINE_MODULE,
      signals: BENZODIAZEPINE_MODULE.signals.map((signal) =>
        signal.id === 'sample_dilution'
          ? {
              ...signal,
              strength: {
                type: 'threshold' as const,
                quantity: { type: 'specimen_metric' as const, metric: 'urine_creatinine' as const },
                bands: [
                  {
                    between: [4, 20] as [number, number],
                    strength: 'moderate' as const,
                    side: 'Hp' as const,
                  },
                ],
                fallback: { strength: 'no_support' as const, side: 'Hp' as const },
                thresholdProvenance: [{ type: 'pmid' as const, identifier: '19161663' }] as [
                  { type: 'pmid'; identifier: string },
                ],
              },
            }
          : signal,
      ),
    };

    const dilution = buildProfileFromCase({
      caseData: oneMeasured,
      modules: [withThreshold],
      graph: BENZODIAZEPINE_GRAPH,
      contextOverrides: {
        bmatrix: 'antemortem_whole_blood',
        umatrix: 'spot',
        interval: 'simultaneous',
        hydro: 'none',
        history: 'repeated',
      },
    }).signals.find((s) => s.id === 'sample_dilution');

    expect(dilution?.strength).toEqual({
      kind: 'not_calculable',
      reasonKey: 'pattern.profile.strength.basisIndeterminate',
    });
  });

  it('states no strength anywhere in the shipped module', () => {
    // Every shipped signal is not-calculable, and the dilution one says why:
    // its cut-offs had no registered published source. This is the acceptance
    // criterion as it stands after that verification, and it is asserted so a
    // future registry cannot re-introduce a strength statement unnoticed.
    const model = build(DIAZEPAM_FIXTURE_CASE, {
      bmatrix: 'antemortem_whole_blood',
      umatrix: 'spot',
      interval: 'simultaneous',
      hydro: 'none',
      history: 'repeated',
    });

    expect(model.signals.every((s) => s.strength.kind === 'not_calculable')).toBe(true);
    expect(model.signals.find((s) => s.id === 'sample_dilution')?.strength).toEqual({
      kind: 'not_calculable',
      reasonKey: 'pattern.profile.strength.noPublishedCutoffs',
    });
  });
});

describe('two explanations for one quantity is a caveat, not a stronger claim', () => {
  it('raises the attribution caveat when two selected options bear on one basis', () => {
    // The co-medication options that would carry these modifiers are generated
    // from `drug_enzyme_interactions`, which needs the database — Phase 2's
    // acceptance, not Phase 0's. The counting itself is Phase 0's, and an
    // unexercised path is how a mechanism turns out not to work on the day
    // something finally feeds it. This module variant feeds it directly.
    const withModifiers: PatternSubstanceModule = {
      ...BENZODIAZEPINE_MODULE,
      contextFields: [
        ...BENZODIAZEPINE_MODULE.contextFields,
        {
          id: 'confounder_a',
          labelKey: 'pattern.profile.context.history.label',
          shortKey: 'pattern.profile.context.history.short',
          applicability: { type: 'module', moduleId: 'benzodiazepines' },
          sortOrder: 90,
          options: [
            {
              value: 'present',
              labelKey: 'pattern.profile.context.history.repeated',
              state: 'known' as const,
              modifiers: [{ featureId: 'ndd_dzp', direction: 'increases' as const }],
            },
            {
              value: 'absent',
              labelKey: 'pattern.profile.context.notStated',
              state: 'known' as const,
              isDefault: true,
            },
          ],
        },
        {
          id: 'confounder_b',
          labelKey: 'pattern.profile.context.history.label',
          shortKey: 'pattern.profile.context.history.short',
          applicability: { type: 'module', moduleId: 'benzodiazepines' },
          sortOrder: 91,
          options: [
            {
              value: 'present',
              labelKey: 'pattern.profile.context.history.repeated',
              state: 'known' as const,
              modifiers: [{ featureId: 'ndd_dzp', direction: 'decreases' as const }],
            },
            {
              value: 'absent',
              labelKey: 'pattern.profile.context.notStated',
              state: 'known' as const,
              isDefault: true,
            },
          ],
        },
      ],
    };

    const timing = (overrides: Record<string, string>) =>
      buildProfileFromCase({
        caseData: DIAZEPAM_FIXTURE_CASE,
        modules: [withModifiers],
        graph: BENZODIAZEPINE_GRAPH,
        contextOverrides: overrides,
      }).signals.find((s) => s.id === 'time_since_intake');

    // One explanation in play attributes the value to it. Two is the case
    // Layer A objected to: the reader credits whichever they thought of first.
    expect(timing({ confounder_a: 'present' })?.attributionCaveat).toBe(false);
    expect(timing({ confounder_a: 'present', confounder_b: 'present' })?.attributionCaveat).toBe(
      true,
    );
  });
});

describe('the axis cannot be pinned to a span it has no logarithm for', () => {
  it('refuses a pin starting at zero rather than hanging on it', () => {
    // `lo: 0` is how anyone would start a linear axis, and the type allowed it.
    // `Math.log10(0)` is `-Infinity`, and `-Infinity + 1` is `-Infinity`: the
    // tick loop never advances and the page freezes. A frozen page is the one
    // failure nobody can diagnose from the screen, so this fails at load.
    const zeroPinned: PatternSubstanceModule = {
      ...BENZODIAZEPINE_MODULE,
      id: 'benzodiazepines-zero-pin',
      axisPin: { lo: 0, hi: 100 },
    };

    expect(() =>
      buildProfileFromCase({
        caseData: DIAZEPAM_FIXTURE_CASE,
        modules: [zeroPinned],
        graph: BENZODIAZEPINE_GRAPH,
      }),
    ).toThrow(/axisPin/);
  });

  it('refuses an inverted pin', () => {
    const inverted: PatternSubstanceModule = {
      ...BENZODIAZEPINE_MODULE,
      id: 'benzodiazepines-inverted-pin',
      axisPin: { lo: 100, hi: 1 },
    };

    expect(() =>
      buildProfileFromCase({
        caseData: DIAZEPAM_FIXTURE_CASE,
        modules: [inverted],
        graph: BENZODIAZEPINE_GRAPH,
      }),
    ).toThrow(/axisPin/);
  });

  it('refuses a pin that leaves parity off the track', () => {
    // `{ lo: 10, hi: 100 }` is a perfectly valid logarithmic span, which is why
    // the drawability check waved it through. Every ratio here is read against
    // 1 — which side of it a value sits on is the finding — so parity at −100%
    // is a plot whose markers have nothing to be above or below.
    const excludesParity: PatternSubstanceModule = {
      ...BENZODIAZEPINE_MODULE,
      id: 'benzodiazepines-parity-pin',
      axisPin: { lo: 10, hi: 100 },
    };

    expect(() =>
      buildProfileFromCase({
        caseData: DIAZEPAM_FIXTURE_CASE,
        modules: [excludesParity],
        graph: BENZODIAZEPINE_GRAPH,
      }),
    ).toThrow(/parity/);

    // And the arithmetic does not obey one that reaches it from outside the
    // registry: the case's own axis always carries parity.
    const axis = computeAxis([12, 40], { pin: { lo: 10, hi: 100 } });
    expect(axis.parityPct).toBeGreaterThanOrEqual(0);
    expect(axis.parityPct).toBeLessThanOrEqual(100);
  });

  it('refuses a module field that redefines a built-in one', () => {
    // The engine concatenates the built-in fields with the module's own, and
    // `unionContextFields` only sees the module half — so both definitions
    // survive: two controls under one id and one React key, while
    // `evaluateSignals` keeps whichever its id map saw last. The field the
    // reader answers and the field the signal reads come apart, silently.
    const shadowing: PatternSubstanceModule = {
      ...BENZODIAZEPINE_MODULE,
      id: 'benzodiazepines-shadowed-field',
      contextFields: [
        ...BENZODIAZEPINE_MODULE.contextFields,
        {
          ...BENZODIAZEPINE_MODULE.contextFields[0]!,
          id: 'bmatrix',
        },
      ],
    };

    expect(() =>
      buildProfileFromCase({
        caseData: DIAZEPAM_FIXTURE_CASE,
        modules: [shadowing],
        graph: BENZODIAZEPINE_GRAPH,
      }),
    ).toThrow(/bmatrix is already a built-in field/);
  });

  it('draws an axis from the case rather than obeying an unusable pin', () => {
    // `computeAxis` is exported and a pin can reach it from outside the
    // registry check. A blank or frozen screen is worse than a correct axis the
    // module did not ask for.
    const axis = computeAxis([1.45, 6.56], { pin: { lo: 0, hi: 100 } });

    expect(axis.lo).toBeGreaterThan(0);
    expect(Number.isFinite(axis.parityPct)).toBe(true);
    expect(axis.ticks.every((tick) => Number.isFinite(tick))).toBe(true);
  });
});

describe('the method footer cites what the case actually shows', () => {
  it('drops a citation whose signal was never rendered', () => {
    // A case with no urine never offers the dilution signal's basis, so the
    // signal is absent — and the footer was still citing the source behind it,
    // attributing to the profile an assessment it did not make.
    const bloodOnly: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: DIAZEPAM_FIXTURE_CASE.specimens.filter((s) => s.matrix !== 'urine'),
      observations: DIAZEPAM_FIXTURE_CASE.observations.filter((o) =>
        o.specimenId.startsWith('blood'),
      ),
    };

    const cited = (data: PatternCaseData) =>
      build(data).method.citations.map((c) => c.identifier);

    // Cone 2009 is the dilution signal's only source.
    expect(cited(DIAZEPAM_FIXTURE_CASE)).toContain('19161663');
    expect(cited(bloodOnly)).not.toContain('19161663');
  });

  it('cites the provenance that licenses a stated strength', () => {
    // `thresholdProvenance` is what permits the ENFSI wording — the citation a
    // reader most needs — and it reached the footer only if a curator happened
    // to repeat it under `referenceCitations`.
    const withThreshold: PatternSubstanceModule = {
      ...BENZODIAZEPINE_MODULE,
      signals: BENZODIAZEPINE_MODULE.signals.map((signal) =>
        signal.id === 'sample_dilution'
          ? {
              ...signal,
              // Deliberately empty, so the only route to the footer is the
              // provenance itself.
              referenceCitations: [],
              strength: {
                type: 'threshold' as const,
                quantity: { type: 'specimen_metric' as const, metric: 'urine_creatinine' as const },
                bands: [
                  {
                    between: [4, 20] as [number, number],
                    strength: 'moderate' as const,
                    side: 'Hp' as const,
                  },
                ],
                fallback: { strength: 'no_support' as const, side: 'Hp' as const },
                thresholdProvenance: [{ type: 'pmid' as const, identifier: '19161663' }] as [
                  { type: 'pmid'; identifier: string },
                ],
              },
            }
          : signal,
      ),
    };

    const model = buildProfileFromCase({
      caseData: DIAZEPAM_FIXTURE_CASE,
      modules: [withThreshold],
      graph: BENZODIAZEPINE_GRAPH,
    });

    expect(model.method.citations.map((c) => c.identifier)).toContain('19161663');
  });
});

describe('a malformed module fails where a curator will see it', () => {
  it('rejects a module the pipeline is asked to render', () => {
    // The validator turns a curation error into a load failure. Called only
    // from a unit test, it protected the test and nothing else: on the real
    // page a signal resting on a feature nobody defined produced a missing row
    // rather than an error, which is exactly what it exists to prevent.
    const broken: PatternSubstanceModule = {
      ...BENZODIAZEPINE_MODULE,
      // A distinct object, so the pipeline's once-per-module cache cannot
      // report this one as already validated.
      id: 'benzodiazepines-broken',
      signals: BENZODIAZEPINE_MODULE.signals.map((signal) =>
        signal.id === 'time_since_intake'
          ? { ...signal, basis: { type: 'feature' as const, featureId: 'no_such_feature' } }
          : signal,
      ),
    };

    expect(() =>
      buildProfileFromCase({
        caseData: DIAZEPAM_FIXTURE_CASE,
        modules: [broken],
        graph: BENZODIAZEPINE_GRAPH,
      }),
    ).toThrow(/unknown feature no_such_feature/);
  });

  it('rejects a threshold quantity naming a feature that does not exist', () => {
    // A threshold rule names its quantity separately from its basis, and the
    // two are ordinarily the same feature — which is why a typo in the second
    // is easy to miss. Unvalidated it loads cleanly, `quantityFor` finds
    // nothing, and the screen reports an indeterminate *case* basis: the
    // registry's defect, blamed on the laboratory's data.
    const brokenQuantity: PatternSubstanceModule = {
      ...BENZODIAZEPINE_MODULE,
      id: 'benzodiazepines-broken-quantity',
      signals: BENZODIAZEPINE_MODULE.signals.map((signal) =>
        signal.id === 'sample_dilution'
          ? {
              ...signal,
              // The basis is fine; only the quantity is misspelled.
              basis: { type: 'feature' as const, featureId: 'ndd_dzp' },
              strength: {
                type: 'threshold' as const,
                quantity: { type: 'feature' as const, featureId: 'ndd_dzpp' },
                bands: [
                  {
                    between: [4, 20] as [number, number],
                    strength: 'moderate' as const,
                    side: 'Hp' as const,
                  },
                ],
                fallback: { strength: 'no_support' as const, side: 'Hp' as const },
                thresholdProvenance: [{ type: 'pmid' as const, identifier: '19161663' }] as [
                  { type: 'pmid'; identifier: string },
                ],
              },
            }
          : signal,
      ),
    };

    expect(() =>
      buildProfileFromCase({
        caseData: DIAZEPAM_FIXTURE_CASE,
        modules: [brokenQuantity],
        graph: BENZODIAZEPINE_GRAPH,
      }),
    ).toThrow(/unknown feature ndd_dzpp/);
  });

  it('rejects a band a logarithmic axis has no position for', () => {
    // `positionOf` returns NaN for a non-positive percentile and the band draws
    // at `NaN%`; out-of-order percentiles draw a collapsed or reversed band
    // while the text beside it states the intended bounds. Both reach a reader
    // as a plot rather than as an error.
    const withBand = (band: { p5: number; p50: number; p95: number }): PatternSubstanceModule => ({
      ...BENZODIAZEPINE_MODULE,
      id: `benzodiazepines-band-${band.p5}-${band.p50}-${band.p95}`,
      features: BENZODIAZEPINE_MODULE.features.map((feature) =>
        feature.id === 'ndd_dzp' && feature.provisionalBand
          ? { ...feature, provisionalBand: { ...feature.provisionalBand, ...band } }
          : feature,
      ),
    });

    const render = (module: PatternSubstanceModule) =>
      buildProfileFromCase({
        caseData: DIAZEPAM_FIXTURE_CASE,
        modules: [module],
        graph: BENZODIAZEPINE_GRAPH,
      });

    expect(() => render(withBand({ p5: 0, p50: 1.2, p95: 4 }))).toThrow(/positive number/);
    expect(() => render(withBand({ p5: 4, p50: 1.2, p95: 0.4 }))).toThrow(/out of order/);
  });

  it('rejects a signal depending on a context field that does not exist', () => {
    // Read at render time as a field the *case* did not answer: the signal
    // degrades, the line naming the missing field has no name to give, and the
    // strength reports not-calculable. The registry's defect, delivered as a
    // gap in the case.
    const misspelled: PatternSubstanceModule = {
      ...BENZODIAZEPINE_MODULE,
      id: 'benzodiazepines-bad-dependency',
      signals: BENZODIAZEPINE_MODULE.signals.map((signal) =>
        signal.id === 'time_since_intake'
          ? { ...signal, dependsOn: ['interval', 'bmatrixx'] }
          : signal,
      ),
    };

    expect(() =>
      buildProfileFromCase({
        caseData: DIAZEPAM_FIXTURE_CASE,
        modules: [misspelled],
        graph: BENZODIAZEPINE_GRAPH,
      }),
    ).toThrow(/unknown context field bmatrixx/);
  });

  it('refuses two modules defining one feature id differently', () => {
    // First-wins deduplication is the wrong answer for a conflict: the
    // discarded definition's signals are still evaluated and look their basis
    // up in the shared result map, so the second module's signal binds to the
    // first module's ratio and states a forensic assessment about a quantity it
    // never described. Phase 2 loads two modules at once.
    const collides: PatternSubstanceModule = {
      ...COCAINE_MODULE,
      features: COCAINE_MODULE.features.map((feature, index) =>
        index === 0 ? { ...feature, id: 'ndd_dzp' } : feature,
      ),
    };

    expect(() =>
      buildProfileFromCase({
        caseData: DIAZEPAM_FIXTURE_CASE,
        modules: [BENZODIAZEPINE_MODULE, collides],
        graph: BENZODIAZEPINE_GRAPH,
      }),
    ).toThrow(/ndd_dzp is defined by both/);
  });

  it('refuses one module defining an id twice, not only two modules sharing one', () => {
    // The collision checks compared *owners*, and both of a module's own
    // definitions carry that module's id — so the comparison was false and the
    // later definition was dropped by the first-wins insert. A registry that
    // copied a feature and forgot to rename it therefore validated cleanly,
    // and every signal naming that id bound to the earlier definition while
    // the screen showed nothing unusual. It needs no second module, so unlike
    // the cross-module case it is reachable in this phase.
    //
    // What is compared instead is identity, so one definition object reaching
    // the union twice — a shared constant, a module listed twice — still
    // unions to itself.
    const variant = (overrides: Partial<PatternSubstanceModule>): PatternSubstanceModule => ({
      ...BENZODIAZEPINE_MODULE,
      id: 'benzodiazepines-self-collision',
      ...overrides,
    });

    const render = (module: PatternSubstanceModule) =>
      buildProfileFromCase({
        caseData: DIAZEPAM_FIXTURE_CASE,
        modules: [module],
        graph: BENZODIAZEPINE_GRAPH,
      });

    const [firstFeature, secondFeature] = BENZODIAZEPINE_MODULE.features;
    expect(() =>
      render(
        variant({
          features: [
            ...BENZODIAZEPINE_MODULE.features,
            { ...secondFeature!, id: firstFeature!.id },
          ],
        }),
      ),
    ).toThrow(new RegExp(`Feature id ${firstFeature!.id} is defined twice by`));

    const [firstSignal] = BENZODIAZEPINE_MODULE.signals;
    expect(() =>
      render(variant({ signals: [...BENZODIAZEPINE_MODULE.signals, { ...firstSignal! }] })),
    ).toThrow(new RegExp(`signal id ${firstSignal!.id} is defined twice by`));

    const [firstField] = BENZODIAZEPINE_MODULE.contextFields;
    expect(() =>
      render(
        variant({
          contextFields: [...BENZODIAZEPINE_MODULE.contextFields, { ...firstField! }],
        }),
      ),
    ).toThrow(new RegExp(`Context field id ${firstField!.id} is given two different definitions`));

    // The same object twice is a repeat, not a conflict.
    expect(() =>
      render(variant({ features: [...BENZODIAZEPINE_MODULE.features, firstFeature!] })),
    ).not.toThrow();
  });

  it('refuses a threshold band with no predicate or two', () => {
    // `matchesBand` returns on the first predicate present, so a band with none
    // never matches and a band with two honours only one — handing the reader
    // the fallback's verbal strength, or a neighbour's, in place of the one the
    // curator wrote. A wrong ENFSI step is worse than an absent one.
    const withBands = (band: Record<string, unknown>): PatternSubstanceModule => ({
      ...BENZODIAZEPINE_MODULE,
      id: `benzodiazepines-band-predicate-${JSON.stringify(band)}`,
      signals: BENZODIAZEPINE_MODULE.signals.map((signal) =>
        signal.id === 'sample_dilution'
          ? {
              ...signal,
              strength: {
                type: 'threshold' as const,
                quantity: { type: 'specimen_metric' as const, metric: 'urine_creatinine' as const },
                bands: [
                  { strength: 'moderate' as const, side: 'Hp' as const, ...band },
                ] as never,
                fallback: { strength: 'no_support' as const, side: 'Hp' as const },
                thresholdProvenance: [{ type: 'pmid' as const, identifier: '19161663' }] as [
                  { type: 'pmid'; identifier: string },
                ],
              },
            }
          : signal,
      ),
    });

    const render = (module: PatternSubstanceModule) =>
      buildProfileFromCase({
        caseData: DIAZEPAM_FIXTURE_CASE,
        modules: [module],
        graph: BENZODIAZEPINE_GRAPH,
      });

    expect(() => render(withBands({}))).toThrow(/exactly one of lt, gt or between/);
    expect(() => render(withBands({ lt: 2, gt: 30 }))).toThrow(/exactly one of lt, gt or between/);
    expect(() => render(withBands({ between: [20, 4] }))).toThrow(/finite bounds in order/);
    expect(() => render(withBands({ lt: Number.NaN }))).toThrow(/must be finite/);
  });

  it('refuses two modules sharing a signal, artefact-rule or not-established id', () => {
    // Ids are how rows are matched and keyed. Two modules sharing a signal id
    // send *both* rows to "Ikke etablert" when either qualifies, because the
    // demoted set is keyed by id; the artefact-rule id decides which citations
    // the method footer prints; and every one is a React key, so a collision
    // reconciles a row onto the wrong article when applicability changes.
    const sharing = (
      overrides: Partial<PatternSubstanceModule>,
    ): PatternSubstanceModule => ({ ...COCAINE_MODULE, ...overrides });

    const render = (module: PatternSubstanceModule) =>
      buildProfileFromCase({
        caseData: DIAZEPAM_FIXTURE_CASE,
        modules: [BENZODIAZEPINE_MODULE, module],
        graph: BENZODIAZEPINE_GRAPH,
      });

    // Well formed inside the cocaine module — a specimen-metric basis names no
    // feature — so the only thing left to object to is the shared id.
    expect(() =>
      render(
        sharing({
          signals: [
            {
              ...BENZODIAZEPINE_MODULE.signals[0]!,
              moduleId: 'cocaine',
              basis: { type: 'specimen_metric' as const, metric: 'urine_creatinine' as const },
              dependsOn: ['umatrix'],
            },
          ],
        }),
      ),
    ).toThrow(/signal id time_since_intake is defined by both/);

    expect(() =>
      render(
        sharing({
          artefactRules: [{ ...BENZODIAZEPINE_MODULE.artefactRules[0]! }],
        }),
      ),
    ).toThrow(/artefact rule id glucuronidase_oxa_to_ndd is defined by both/);

    expect(() =>
      render(
        sharing({
          notEstablished: [{ ...BENZODIAZEPINE_MODULE.notEstablished[0]!, moduleId: 'cocaine' }],
        }),
      ),
    ).toThrow(/not-established entry id prescription_adherence is defined by both/);
  });

  it('refuses the same module twice in one profile', () => {
    // The union helpers deduplicate what they key by id, so a repeat slips past
    // them — but the pipeline flattens signals, artefact rules and
    // not-established entries straight out of `modules`, and every forensic
    // assessment row, caution and demoted entry would arrive twice on duplicate
    // React keys. The modules in scope are a set.
    expect(() =>
      buildProfileFromCase({
        caseData: DIAZEPAM_FIXTURE_CASE,
        modules: [BENZODIAZEPINE_MODULE, BENZODIAZEPINE_MODULE],
        graph: BENZODIAZEPINE_GRAPH,
      }),
    ).toThrow(/appears twice in one profile/);
  });

  it('validates a well-formed module without complaint', () => {
    expect(() => build(DIAZEPAM_FIXTURE_CASE)).not.toThrow();
  });
});

describe('a negative result is not an observation of presence', () => {
  it('does not let a not-detected analyte seed the source walk', () => {
    // An ordinary negative on the panel must not introduce precursor candidates
    // for a substance nobody found, nor demote a candidate for failing to
    // "cover" it.
    const withNegative: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
        o.id === 'obs-tem-u'
          ? {
              ...o,
              value: undefined,
              qualifier: 'not_detected' as const,
              limitRef: { label: 'rapporteringsgrense', value: 10, unit: 'nmol/L' },
            }
          : o,
      ),
    };

    const roles = (model: ReturnType<typeof build>) =>
      new Map(
        (model.sourceAmbiguities[0]?.candidates ?? []).map((c) => [c.pubchemCid, c.role]),
      );

    // Temazepam (CID 5391) is administrable, so it is a candidate either way;
    // what must change is that a substance reported absent no longer counts as
    // observed when coverage is judged.
    const detected = roles(build(DIAZEPAM_FIXTURE_CASE));
    const negative = roles(build(withNegative));

    expect(detected.has(5391)).toBe(true);
    expect(negative.get(5391)).not.toBe('sole_capable');
    expect(build(withNegative).sourceAmbiguities[0]?.candidates.every((c) => c.pubchemCid > 0)).toBe(
      true,
    );
  });

  it('does not let a below-limit result seed the source walk either', () => {
    // `<X` is an interval that includes zero. It is not a claim of absence —
    // which is why an earlier version kept it — but source inference reasons
    // from presence, and a bound that includes zero establishes none.
    const censored: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
        o.id === 'obs-oxa-u'
          ? {
              ...o,
              value: undefined,
              qualifier: 'below_limit' as const,
              limitRef: { label: 'rapporteringsgrense', value: 10, unit: 'nmol/L' },
            }
          : o,
      ),
    };

    const notDetected: PatternCaseData = {
      ...censored,
      observations: censored.observations.map((o) =>
        o.id === 'obs-oxa-u' ? { ...o, qualifier: 'not_detected' as const } : o,
      ),
    };

    const roles = (data: PatternCaseData) =>
      JSON.stringify(build(data).sourceAmbiguities[0]?.candidates ?? []);

    // The two must reach the same source conclusion: neither observed the
    // analyte, and only that fact bears on the walk.
    expect(roles(censored)).toBe(roles(notDetected));
    expect(roles(censored)).not.toBe(roles(DIAZEPAM_FIXTURE_CASE));
  });

  it('keeps a detected-but-unquantified result in the panel', () => {
    // The one censored qualifier that does assert presence. Dropping it with
    // the rest would discard a real finding to fix a different problem.
    const detected: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
        o.id === 'obs-oxa-u'
          ? { ...o, value: undefined, qualifier: 'detected_not_quantified' as const }
          : o,
      ),
    };

    const roles = (data: PatternCaseData) =>
      JSON.stringify(build(data).sourceAmbiguities[0]?.candidates ?? []);

    expect(roles(detected)).toBe(
      JSON.stringify(build(DIAZEPAM_FIXTURE_CASE).sourceAmbiguities[0]?.candidates ?? []),
    );
  });

  it('ignores a positive result for a substance no loaded module claims', () => {
    // A panel routinely reports substances outside the module in scope. The
    // graph is module-scoped, so an unrelated positive has no node in it: the
    // upstream walk would read the absent node as uncurated and coverage would
    // be downgraded for failing to account for a substance that was never this
    // profile's business — degrading a benzodiazepine source assessment on
    // evidence about something else entirely.
    const unrelated: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: [
        ...DIAZEPAM_FIXTURE_CASE.observations,
        {
          id: 'obs-unrelated',
          specimenId: 'blood-1',
          // A substance no module in scope declares and the graph has never
          // heard of.
          analyte: { pubchemCid: 702 },
          value: 400,
          unit: 'nmol/L',
          qualifier: 'quantified' as const,
        },
      ],
    };

    expect(JSON.stringify(build(unrelated).sourceAmbiguities[0])).toBe(
      JSON.stringify(build(DIAZEPAM_FIXTURE_CASE).sourceAmbiguities[0]),
    );
  });

  it('keeps every candidate identifiable, module or not', () => {
    const model = build(DIAZEPAM_FIXTURE_CASE);
    const candidates = model.sourceAmbiguities[0]?.candidates ?? [];

    expect(candidates.length).toBeGreaterThan(0);
    // Identity survives into the view model, so two candidates outside every
    // loaded module cannot render as the same anonymous line.
    expect(new Set(candidates.map((c) => c.pubchemCid)).size).toBe(candidates.length);
  });
});

describe('a signal about a specimen nobody collected is not a finding', () => {
  it('drops the dilution signal when the case has no urine at all', () => {
    // Not an analysis that failed — the metric was never on offer. A
    // proposition pair about the concentration of a specimen that does not
    // exist reads as a finding and answers nothing.
    const bloodOnly: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: DIAZEPAM_FIXTURE_CASE.specimens.filter((s) => s.matrix !== 'urine'),
      observations: DIAZEPAM_FIXTURE_CASE.observations.filter((o) =>
        o.specimenId.startsWith('blood'),
      ),
    };

    expect(build(bloodOnly).signals.map((s) => s.id)).not.toContain('sample_dilution');
  });

  it('keeps it when urine was collected but its creatinine did not resolve', () => {
    // The other case, and the distinction the row exists for: the analysis was
    // attempted here, so the gap is worth stating rather than hiding.
    const noCreatinine: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: DIAZEPAM_FIXTURE_CASE.specimens.map((s) =>
        s.matrix === 'urine' ? { ...s, urine: undefined } : s,
      ),
    };

    const dilution = build(noCreatinine).signals.find((s) => s.id === 'sample_dilution');
    expect(dilution).toBeDefined();
    expect(dilution?.strength.kind).toBe('not_calculable');
  });
});

describe('the axis always contains parity', () => {
  it('keeps 1 inside a window the five-decade cap would have centred away', () => {
    // A lone value ten decades above parity centres the capped window on
    // 1e3–1e8, which puts the parity line at a negative percentage and draws it
    // outside the track. 1.0 is added to the extent precisely so it cannot be
    // excluded; the cap must not undo that.
    const axis = computeAxis([1e10]);

    expect(axis.lo).toBeLessThanOrEqual(1);
    expect(axis.hi).toBeGreaterThanOrEqual(1);
    expect(axis.parityPct).toBeGreaterThanOrEqual(0);
    expect(axis.parityPct).toBeLessThanOrEqual(100);
  });

  it('does the same for a value far below parity', () => {
    const axis = computeAxis([1e-10]);

    expect(axis.lo).toBeLessThanOrEqual(1);
    expect(axis.hi).toBeGreaterThanOrEqual(1);
    expect(axis.parityPct).toBeGreaterThanOrEqual(0);
    expect(axis.parityPct).toBeLessThanOrEqual(100);
  });
});

describe('a warning names the failure that actually happened', () => {
  it('does not report missing creatinine when the operand never resolved', () => {
    // The urine specimen has perfectly good creatinine. The cross-matrix feature
    // fails because its urine observation is gone, and a warning sending a
    // curator to look for a creatinine value that is right there wastes the one
    // thing a warning is for.
    const noUrineNordazepam: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.filter((o) => o.id !== 'obs-ndd-u'),
    };

    const row = build(noUrineNordazepam)
      .ratioGroups.flatMap((g) => g.rows)
      .find((r) => r.featureId === 'ndd_u_b');

    expect(row?.status).toBe('indeterminate');
    expect(row?.warnings.map((w) => w.code)).not.toContain('normalization_unavailable');
    // The real failure still says so.
    expect(row?.warnings.length).toBeGreaterThan(0);
  });
});

describe('nothing detected is not an ambiguity', () => {
  it('performs no source inference when no analyte establishes presence', () => {
    // A panel of non-detects has no profile whose source could be in question.
    // Walking anyway manufactures one: every administrable neighbour of the
    // assumed parent would be enumerated as an alternative source of nothing,
    // and every source-dependent signal on a case that has nothing to say would
    // degrade behind it.
    const allNegative: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) => ({
        ...o,
        value: undefined,
        qualifier: 'not_detected' as const,
        limitRef: { label: 'rapporteringsgrense', value: 10, unit: 'nmol/L' },
      })),
    };

    const model = buildProfileFromCase({
      caseData: allNegative,
      modules: [BENZODIAZEPINE_MODULE],
      graph: BENZODIAZEPINE_GRAPH,
    });

    expect(model.sourceAmbiguities[0]?.statusKind).toBe('not_applicable');
    expect(model.sourceAmbiguities[0]?.candidates).toEqual([]);
  });
});

describe('the method disclosure describes what happened, not what was configured', () => {
  it('claims both bases only when a normalised value was actually produced', () => {
    expect(build(DIAZEPAM_FIXTURE_CASE).method.normalizationBasisKey).toBe(
      'pattern.profile.method.creatinineBasis',
    );
  });

  it('produces no normalised value for a ratio that did not compute', () => {
    // The urine operand resolves and the creatinine is fine, but the blood
    // operand is gone. Scaling an indeterminate interval yields a defined
    // `{low: null, high: null}`, which every downstream presence check reads as
    // "a normalised value exists" — a second em dash beside the first, and a
    // method line claiming both bases for a case that computed neither.
    const noBloodNordazepam: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.filter((o) => o.id !== 'obs-ndd-b'),
    };

    const model = build(noBloodNordazepam);
    const row = model.ratioGroups.flatMap((g) => g.rows).find((r) => r.featureId === 'ndd_u_b');

    expect(row?.status).toBe('indeterminate');
    expect(row?.normalizedValueText).toBeUndefined();
    expect(model.method.normalizationBasisKey).not.toBe(
      'pattern.profile.method.creatinineBasis',
    );
  });

  it('groups the ratios by the matrix their operands come from', () => {
    // The generalisation contract's "Blod / Urin / Kryssmatrise", derived from
    // the operands rather than declared. One within-matrix group put the blood
    // ratio under the same heading and the same dilution note as three urine
    // ones — and no single note is true of both, since a urine-internal ratio
    // is invariant because the creatinine factor cancels while blood is not
    // subject to dilution at all.
    const model = build(DIAZEPAM_FIXTURE_CASE);

    expect(model.ratioGroups.map((g) => g.group)).toEqual(['blood', 'urine', 'cross_matrix']);
    expect(model.ratioGroups.map((g) => g.rows.map((r) => r.featureId))).toEqual([
      ['ndd_dzp'],
      ['oxa_ndd', 'tem_oxa', 'ndd_dwn'],
      ['ndd_u_b', 'oxa_u_ndd_b'],
    ]);
    expect(model.ratioGroups.map((g) => g.headingKey)).toEqual([
      'pattern.profile.group.blood',
      'pattern.profile.group.urine',
      'pattern.profile.group.crossMatrix',
    ]);
    expect(model.ratioGroups.map((g) => g.regimeNoteKey)).toEqual([
      'pattern.profile.regime.blood',
      'pattern.profile.regime.urine',
      'pattern.profile.regime.crossMatrix',
    ]);
    // The withdrawn sum ratio spans both matrices, so its footnote belongs to
    // the cross-matrix group and nowhere else.
    expect(model.ratioGroups.map((g) => g.withdrawnNoteKeys.length)).toEqual([0, 0, 1]);
  });

  it('does not promise both bases in the group note when only one is shown', () => {
    // The regime note is a statement about what is in the group, not about what
    // the regime means in principle. The method disclosure was corrected for
    // exactly this and the note one level down kept the promise.
    const noCreatinine: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: DIAZEPAM_FIXTURE_CASE.specimens.map((s) =>
        s.matrix === 'urine' ? { ...s, urine: undefined } : s,
      ),
    };

    const crossNote = (data: PatternCaseData) =>
      build(data).ratioGroups.find((g) => g.group === 'cross_matrix')?.regimeNoteKey;

    expect(crossNote(DIAZEPAM_FIXTURE_CASE)).toBe('pattern.profile.regime.crossMatrix');
    expect(crossNote(noCreatinine)).toBe('pattern.profile.regime.crossMatrixRawOnly');
  });

  it('says nothing about normalisation when the failure was an operand', () => {
    // The urine specimen's creatinine is recorded and fine; the cross-matrix
    // features fail because an operand is missing. Blaming the creatinine would
    // send a reader to check a value that is right there, and say nothing about
    // what actually went wrong.
    const noUrineNordazepam: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.filter(
        (o) => !o.specimenId.startsWith('urine'),
      ),
    };

    expect(build(noUrineNordazepam).method.normalizationBasisKey).toBeUndefined();
  });

  it('says so when the reference was configured but never applied', () => {
    // "Shown both raw and normalised" is a statement about the screen. On a case
    // whose creatinine is unusable the screen shows one of the two, and the
    // configured reference does not make the sentence true.
    const noCreatinine: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: DIAZEPAM_FIXTURE_CASE.specimens.map((s) =>
        s.matrix === 'urine' ? { ...s, urine: undefined } : s,
      ),
    };

    expect(build(noCreatinine).method.normalizationBasisKey).toBe(
      'pattern.profile.method.creatinineUnavailable',
    );
  });
});

describe('a band is only shown against the quantity it describes', () => {
  const rowsOf = (model: ReturnType<typeof build>) =>
    new Map(model.ratioGroups.flatMap((g) => g.rows).map((row) => [row.featureId, row]));

  it('withholds a band whose basis is unstated once normalisation applies', () => {
    // The cross-matrix rows carry two materially different values, and the band
    // was derived from neither in particular. Plotting the raw one against it
    // would misstate the position by exactly the normalisation factor, with
    // nothing on screen to show it.
    const rows = rowsOf(build(DIAZEPAM_FIXTURE_CASE));
    const cross = rows.get('ndd_u_b');

    expect(cross?.normalizedValueText).toBeDefined();
    expect(cross?.normalizedValueText).not.toBe(cross?.valueText);
    expect(cross?.band).toBeNull();
    // Withheld, not absent: a row with no reference distribution at all is a
    // different statement, and this one says which it is.
    expect(cross?.bandWithheldNoteKey).toBe('pattern.profile.band.basisUnstated');
  });

  it('keeps the band on a within-matrix row, where the two values coincide', () => {
    const rows = rowsOf(build(DIAZEPAM_FIXTURE_CASE));
    const within = rows.get('ndd_dzp');

    expect(within?.band).not.toBeNull();
    expect(within?.bandWithheldNoteKey).toBeUndefined();
    expect(within?.plottedBasis).toBe('raw');
  });

  it('withholds an unstated band when normalisation was needed and failed', () => {
    // `applied: false` covers two different facts, and only one of them means
    // the raw and normalised values coincide. Here normalisation was required
    // and the creatinine was unusable, so the two still differ — we just do not
    // know by how much, which is the worst position from which to plot one of
    // them against a band that might describe the other.
    const noCreatinine: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: DIAZEPAM_FIXTURE_CASE.specimens.map((s) =>
        s.matrix === 'urine' ? { ...s, urine: undefined } : s,
      ),
    };

    const cross = build(noCreatinine)
      .ratioGroups.flatMap((g) => g.rows)
      .find((r) => r.featureId === 'ndd_u_b');

    expect(cross?.normalizedValueText).toBeUndefined();
    expect(cross?.band).toBeNull();
    expect(cross?.bandWithheldNoteKey).toBe('pattern.profile.band.basisUnstated');
  });

  it('keeps a withheld band out of the automatic axis and the provisional count', () => {
    // A withheld band is invisible and was still deciding how much room the
    // visible markers got — a wide unstated-basis band can compress every real
    // value toward one rim on a screen that says no comparable band is shown.
    // The module pins its axis, so this is asserted on an unpinned variant.
    const unpinned: PatternSubstanceModule = {
      ...BENZODIAZEPINE_MODULE,
      axisPin: undefined,
      features: BENZODIAZEPINE_MODULE.features.map((feature) =>
        feature.id === 'ndd_u_b' && feature.provisionalBand
          ? { ...feature, provisionalBand: { ...feature.provisionalBand, p95: 5000 } }
          : feature,
      ),
    };

    const model = buildProfileFromCase({
      caseData: DIAZEPAM_FIXTURE_CASE,
      modules: [unpinned],
      graph: BENZODIAZEPINE_GRAPH,
    });

    const rows = model.ratioGroups.flatMap((g) => g.rows);
    const shown = rows.filter((r) => r.band !== null);
    const withheld = rows.filter((r) => r.bandWithheldNoteKey !== undefined);

    expect(withheld.length).toBeGreaterThan(0);
    // The note counts what a reader can see, not what the registry declares.
    expect(model.provisional.totalBands).toBe(shown.length);

    // That band's upper percentile is 5000, four decades above every value the
    // case actually plots. An axis stretched to reach it would push all six
    // markers into the left rim of a distribution none of them is shown
    // against.
    expect(model.axis.hi).toBeLessThan(5000);
  });

  it('says which of the two reasons a band is withheld for', () => {
    // A band whose basis *is* stated, withheld because this case's creatinine
    // is unusable. Saying the basis is unstated misdescribes the registry and
    // hides the case-data failure — and the two send a reader to different
    // places to fix them.
    const normalizedBand: PatternSubstanceModule = {
      ...BENZODIAZEPINE_MODULE,
      features: BENZODIAZEPINE_MODULE.features.map((feature) =>
        feature.id === 'ndd_u_b' && feature.provisionalBand
          ? {
              ...feature,
              provisionalBand: {
                ...feature.provisionalBand,
                basis: 'creatinine_normalized' as const,
              },
            }
          : feature,
      ),
    };

    const noCreatinine: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: DIAZEPAM_FIXTURE_CASE.specimens.map((s) =>
        s.matrix === 'urine' ? { ...s, urine: undefined } : s,
      ),
    };

    const row = buildProfileFromCase({
      caseData: noCreatinine,
      modules: [normalizedBand],
      graph: BENZODIAZEPINE_GRAPH,
    })
      .ratioGroups.flatMap((g) => g.rows)
      .find((r) => r.featureId === 'ndd_u_b');

    expect(row?.band).toBeNull();
    expect(row?.bandWithheldNoteKey).toBe('pattern.profile.band.normalizationUnavailable');
  });

  it('sizes the axis to what the tracks draw, not to both stored variants', () => {
    // A cross-matrix row stores raw and normalised and plots one. An extreme
    // creatinine makes the unplotted variant enormous; letting it into the
    // extent consumes the five-decade window and compresses every visible
    // marker toward a rim on behalf of a number that is nowhere on the plot.
    const unpinned: PatternSubstanceModule = { ...BENZODIAZEPINE_MODULE, axisPin: undefined };

    const extremeCreatinine: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      specimens: DIAZEPAM_FIXTURE_CASE.specimens.map((s) =>
        s.matrix === 'urine' ? { ...s, urine: { creatinineMmolL: 0.0001 } } : s,
      ),
    };

    const model = buildProfileFromCase({
      caseData: extremeCreatinine,
      modules: [unpinned],
      graph: BENZODIAZEPINE_GRAPH,
    });

    const rows = model.ratioGroups.flatMap((g) => g.rows);
    // Every row plots its raw value here — no band declares a normalised basis
    // — so the normalised variants, five decades up, must not be in the extent.
    expect(rows.every((row) => row.plottedBasis === 'raw')).toBe(true);
    expect(model.axis.hi).toBeLessThan(1000);
  });

  it('plots the normalised value against a normalised band', () => {
    const normalizedBand: PatternSubstanceModule = {
      ...BENZODIAZEPINE_MODULE,
      features: BENZODIAZEPINE_MODULE.features.map((feature) =>
        feature.id === 'ndd_u_b' && feature.provisionalBand
          ? {
              ...feature,
              provisionalBand: { ...feature.provisionalBand, basis: 'creatinine_normalized' as const },
            }
          : feature,
      ),
    };

    const model = buildProfileFromCase({
      caseData: DIAZEPAM_FIXTURE_CASE,
      modules: [normalizedBand],
      graph: BENZODIAZEPINE_GRAPH,
    });
    const row = model.ratioGroups
      .flatMap((g) => g.rows)
      .find((r) => r.featureId === 'ndd_u_b');

    // The band is now comparable, and the marker moves onto its basis. The
    // value cell still shows both — §3.4 asserts neither is the correct one —
    // but the plot compares like with like.
    expect(row?.band).not.toBeNull();
    expect(row?.plottedBasis).toBe('normalized');
    expect(row?.bandWithheldNoteKey).toBeUndefined();
  });
});

describe('axis ticks stay inside the axis', () => {
  it('emits no decade below lo or above hi', () => {
    const { axis } = build(DIAZEPAM_FIXTURE_CASE);

    // The shipped pin does not start on a decade, so rounding would place a
    // tick outside the track — its label drawn at a negative percentage.
    expect(Math.min(...axis.ticks)).toBeGreaterThanOrEqual(axis.lo);
    expect(Math.max(...axis.ticks)).toBeLessThanOrEqual(axis.hi);
  });
});

describe('what the case declares is stated separately from what the graph allows', () => {
  it('names the confirmed sources rather than only the candidate list', () => {
    const confirmed: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      context: {
        ...DIAZEPAM_FIXTURE_CASE.context,
        knownExposures: [
          { drug: { pubchemCid: 3016 }, certainty: 'confirmed' },
          { drug: { pubchemCid: 4616 }, certainty: 'reported' },
          { drug: { pubchemCid: 5391 }, certainty: 'suspected' },
        ],
      },
    };

    const model = build(confirmed);
    expect(model.sourceAmbiguities[0]?.statusKind).toBe('mixed_source');
    // `resolveStatus` counts confirmed *or* reported, so the headline may not
    // say "confirmed": two reported exposures reach this state with nothing
    // confirmed at all, and overstating the case history is the one thing this
    // statement must not do.
    expect(model.sourceAmbiguities[0]?.declared.some((d) => d.certainty === 'reported')).toBe(true);

    // "Several sources are confirmed" is uncheckable against a list of every
    // candidate the graph permits, so the declared pair is carried separately.
    const declared = model.sourceAmbiguities[0]?.declared ?? [];
    expect(declared.map((d) => d.pubchemCid).sort()).toEqual([3016, 4616]);
    // A suspected exposure is not a declaration and must not widen the claim.
    expect(declared.some((d) => d.pubchemCid === 5391)).toBe(false);
  });

  it('names only exposures that could have fed this profile', () => {
    // A confirmed co-medication is a fact about the case and not a source of
    // the metabolite pattern. `resolveStatus` decides `mixed_source` against the
    // assumed parent and the candidates; the statement under it has to name the
    // same set, or an unrelated exposure reads as one of the sources that
    // established the status.
    const withComedication: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      context: {
        ...DIAZEPAM_FIXTURE_CASE.context,
        knownExposures: [
          { drug: { pubchemCid: 3016 }, certainty: 'confirmed' },
          { drug: { pubchemCid: 4616 }, certainty: 'reported' },
          // Not in the lineage and not a candidate for anything on the panel.
          { drug: { pubchemCid: 702 }, certainty: 'confirmed' },
        ],
      },
    };

    const declared = build(withComedication).sourceAmbiguities[0]?.declared ?? [];
    expect(declared.map((d) => d.pubchemCid).sort()).toEqual([3016, 4616]);
  });
});

describe('unit spellings that reach the engine in practice', () => {
  it('accepts the ASCII and Greek micro spellings', () => {
    const spelled: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((o) =>
        o.specimenId === 'blood-1' && o.value !== undefined
          ? { ...o, value: o.value / 1000, unit: 'umol/L' }
          : o,
      ),
    };

    // Rejecting `umol/L` would make every dependent feature indeterminate on
    // ordinary imported data.
    const value = build(spelled).ratioGroups[0]?.rows[0]?.valueText;
    expect(value).toBe('1,45');
  });
});

describe('an id that names something on Object.prototype is still just an id', () => {
  it('applies no edit to an observation nobody edited', () => {
    // `observationOverrides` is an ordinary object, and observation ids come
    // out of a stored case rather than out of the code. Looking one up with
    // `overrides[id]` answers for the whole prototype chain, so an observation
    // called `toString` collects an inherited function as its "edit" — and this
    // edit carries no `value`, so a quantified result is replaced with
    // `undefined` and reopens indeterminate along with every ratio it feeds.
    //
    // The empty override map is the point: the assertion is that a case with
    // no edits at all reads exactly as it does when no edit map is passed.
    const named: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      observations: DIAZEPAM_FIXTURE_CASE.observations.map((observation) =>
        observation.id === 'obs-dzp-b' ? { ...observation, id: 'toString' } : observation,
      ),
    };

    const withEmptyEdits = buildProfileFromCase({
      caseData: named,
      modules: [BENZODIAZEPINE_MODULE],
      graph: BENZODIAZEPINE_GRAPH,
      observationOverrides: {},
    });

    expect(withEmptyEdits.ratioGroups[0]?.rows[0]?.valueText).toBe(
      build(named).ratioGroups[0]?.rows[0]?.valueText,
    );
    expect(withEmptyEdits.ratioGroups[0]?.rows[0]?.valueText).toBe('1,45');
  });
});


describe('a context selection does not outlive the question that raised it', () => {
  it('ignores a hydrolysis protocol once no result is measured that way', () => {
    // The hydrolysis field only reaches a case whose observations declare
    // themselves conjugate or total-after-hydrolysis. Correct the last such
    // result to a direct one and the control disappears — while a `snail`
    // still sitting in the case went on producing hydrolysis artefact
    // warnings for results no hydrolysis was performed on, with nothing on
    // screen to clear.
    const withProtocol: PatternCaseData = {
      ...DIAZEPAM_FIXTURE_CASE,
      context: { ...DIAZEPAM_FIXTURE_CASE.context, fields: { hydro: 'snail' } },
    };
    const flaggedRows = (data: PatternCaseData) =>
      build(data)
        .ratioGroups.flatMap((group) => group.rows)
        .filter((row) => row.artefactNoteKeys.length > 0).length;
    expect(flaggedRows(withProtocol)).toBeGreaterThan(0);

    // Same case, every result measured directly.
    const direct: PatternCaseData = {
      ...withProtocol,
      observations: withProtocol.observations.map((o) => ({
        ...o,
        assay: { ...o.assay, measurandMode: 'direct' as const },
      })),
    };

    const model = build(direct);
    expect(model.contextFields.some((field) => field.id === 'hydro')).toBe(false);
    expect(flaggedRows(direct)).toBe(0);
    // And the selection is still in the case: restore a conjugate result and
    // the protocol is recorded, which is what correcting a mistyped mode
    // expects. It simply does not decide anything while the question is not
    // asked.
    expect(direct.context.fields.hydro).toBe('snail');
  });
});
