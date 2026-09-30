/**
 * Amendment 1 (catalog-coverage plan §5.2) condition 4: a curve may not be
 * detached from its disclosure. An export is the easiest place for that to go
 * wrong, so the grade and its itemised limitations are pinned here.
 */
import { describe, it, expect } from 'vitest';
import { exportSummaryText } from '@/lib/simulatorExport';
import { gradeResult } from '@/lib/reviewedModelGrade';
import type { DrugSimResult } from '@/types/simulator';

function result(): DrugSimResult {
  return {
    drugConfigId: 'c1',
    engine: 'pk-montecarlo',
    questionMode: 'concentration-from-dose',
    median: 1, p05: 0.2, p25: 0.5, p75: 1.5, p95: 2,
    unit: 'mg/L',
    timeSeries: [],
    assumptions: {
      model: 'two-compartment, first-order elimination',
      modelKey: 'assumptions.models.twoCompartmentFirstOrder',
      route: 'oral',
      halfLife: { type: 'fixed', value: 28 },
      vd: { type: 'fixed', value: 19 },
      f: { type: 'fixed', value: 0.06 },
      weightScaling: true,
      modelId: 'thc-two-comp-v1',
      family: 'two-compartment-first-order',
      validationStatus: 'literature-derived',
      nativeMatrix: 'plasma',
    },
    sensitivity: [], warnings: [], seed: 1, drawCount: 100,
  } as DrugSimResult;
}

describe('exportSummaryText — the disclosure travels with the number', () => {
  const results = { c1: result() };
  const labels = { c1: 'THC' };
  const grades = {
    c1: gradeResult(results.c1, { role: null, displayMatrix: 'whole_blood' }),
  };

  it('carries the grade and every sub-B dimension into the export', () => {
    const text = exportSummaryText('Case', results, labels, undefined, grades);
    expect(text).toContain('Evidence grade:');
    expect(text).toContain('Grade C');
    expect(text).toContain('primary-source-review');
    expect(text).toContain('validation-status');
    expect(text).toContain('uncertainty-semantics');
    // The matrix bridge was applied in this view, so it must be disclosed too.
    expect(text).toContain('matrix-route-match');
  });

  it('never lets the band be read as a confidence interval', () => {
    const text = exportSummaryText('Case', results, labels, undefined, grades);
    expect(text).toContain('PLAUSIBLE RANGE');
    // Only AFFIRMATIVE claims are forbidden. The standing disclaimer already
    // says the range "is not an individualized confidence interval", which is
    // the same rule stated the other way round.
    expect(text).not.toMatch(/\bis an? (confidence|prediction) interval/i);
    expect(text).not.toMatch(/\d+% (confidence|prediction) interval/i);
  });

  it('records the model matrix, so a converted number is not read as native', () => {
    const text = exportSummaryText('Case', results, labels, undefined, grades);
    expect(text).toContain('plasma (model native)');
  });

  it('omits the grade block for a result with no reviewed model', () => {
    const text = exportSummaryText('Case', results, labels, undefined, { c1: null });
    expect(text).not.toContain('Evidence grade:');
  });
});

describe('exportSummaryText — the export obeys the render gate', () => {
  const results = { c1: result() };
  const labels = { c1: 'THC' };

  /** A grade whose disposition withholds the curve, with a stated reason. */
  const withheld = (disposition: 'hidden' | 'acknowledge-in-review-workspace') => ({
    c1: {
      policy: {
        grade: 'D' as const,
        limitingDimensions: ['parameter-provenance' as const],
        disclosable: [
          {
            dimension: 'parameter-provenance' as const,
            grade: 'D' as const,
            reason: 'Per-input provenance is not recorded.',
          },
        ],
        hardStops: [],
      },
      disposition,
      acknowledgementVersion: 'v-test',
      admittedBy: 'withheld' as const,
    },
  });

  it.each(['hidden', 'acknowledge-in-review-workspace'] as const)(
    'writes no figures for a %s model',
    (disposition) => {
      const text = exportSummaryText(
        'Case',
        results,
        labels,
        undefined,
        withheld(disposition),
      );
      // The numbers a withheld curve must not leak: the percentiles that ARE the
      // curve, and the parameters it was drawn from.
      expect(text).not.toContain('Median:');
      expect(text).not.toContain('25–75%');
      expect(text).not.toContain('5–95%');
      expect(text).not.toContain('Assumptions:');
      // The parameter lines by their labels — matching on the bare numbers would
      // collide with the generated timestamp in the header.
      expect(text).not.toContain('t½:');
      expect(text).not.toContain('Vd:');
      expect(text).not.toContain('F:');
      expect(text).not.toContain('Draws:');
    },
  );

  it('still names the drug and states why, rather than omitting it', () => {
    const text = exportSummaryText('Case', results, labels, undefined, withheld('hidden'));
    expect(text).toContain('THC');
    expect(text).toContain('NO FIGURES');
    expect(text).toContain('Evidence record:');
    expect(text).toContain('Per-input provenance is not recorded.');
  });

  it('names a hard stop as one rather than as a low grade', () => {
    const text = exportSummaryText('Case', results, labels, undefined, {
      c1: {
        policy: {
          grade: 'ungraded' as const,
          limitingDimensions: ['matrix-route-match' as const],
          // Both lists, exactly as `evaluateGradePolicy` builds them.
          disclosable: [
            {
              dimension: 'matrix-route-match' as const,
              grade: 'hard-stop' as const,
              reason: 'The requested route is not one this model declares.',
            },
          ],
          hardStops: [
            {
              dimension: 'matrix-route-match' as const,
              grade: 'hard-stop' as const,
              reason: 'The requested route is not one this model declares.',
            },
          ],
        },
        disposition: 'hidden' as const,
        acknowledgementVersion: 'v-test',
        admittedBy: 'withheld' as const,
      },
    });
    expect(text).toContain('the evidence cannot support a curve');
    // A hand-built hard stop can carry an EMPTY `disclosable` (the "derived model
    // with no committed grade" case is exactly that), so an export reading only
    // that list would state no reason at all on the result that most needs one.
    expect(text).toContain('The requested route is not one this model declares.');
    // …and it is stated ONCE. `evaluateGradePolicy` puts hard stops in BOTH lists,
    // so concatenating them double-reports every hard stop.
    expect(text.split('The requested route is not one this model declares.')).toHaveLength(2);
  });

  it('withholds the figures from an export even after a reviewer acknowledges', () => {
    // §5.1: an acknowledgement "must not ... survive into exports/share links". An
    // acknowledged D renders `render-with-limitations` exactly like an ordinary C, so
    // a disposition check cannot tell them apart — `admittedBy` is what does.
    const text = exportSummaryText('Case', results, labels, undefined, {
      c1: {
        ...withheld('hidden').c1,
        disposition: 'render-with-limitations' as const,
        admittedBy: 'acknowledgement' as const,
      },
    });
    expect(text).not.toContain('Median:');
    expect(text).not.toContain('t½:');
    expect(text).toContain('NO FIGURES');
    expect(text).toContain('does not travel into an export');
  });

  it('exports the figures for a model whose own grade admits it', () => {
    const text = exportSummaryText('Case', results, labels, undefined, {
      c1: {
        ...withheld('hidden').c1,
        disposition: 'render-with-limitations' as const,
        admittedBy: 'grade' as const,
      },
    });
    expect(text).toContain('Median:');
    expect(text).toContain('Grade D');
  });

  it('leaves an ungoverned result (no grade) exporting as before', () => {
    // `null` means "not governed by this policy" — the ethanol/Widmark and KineLab
    // engines. Withholding those would be the gate over-reaching.
    const text = exportSummaryText('Case', results, labels, undefined, { c1: null });
    expect(text).toContain('Median:');
  });
});

describe('exportSummaryText — a deterministic run states no band', () => {
  const labels = { c1: 'THC' };

  function exportFor(overrides: Partial<DrugSimResult>): string {
    const r = { ...result(), ...overrides } as DrugSimResult;
    return exportSummaryText('Case', { c1: r }, labels, undefined, {
      c1: gradeResult(r, { role: 'admin', displayMatrix: 'whole_blood' }),
    });
  }

  it('replaces the collapsed percentile rows with the reason', () => {
    // A reviewed model declares fixed parameters, so every draw reproduces one
    // curve. "1 – 1" as a quartile band would put a precision claim into an
    // exported report that the run never made.
    const text = exportFor({ p05: 1, p25: 1, p75: 1, p95: 1 });
    expect(text).toContain('Median:');
    expect(text).toContain('Deterministic run');
    expect(text).not.toContain('25–75%');
    expect(text).not.toContain('5–95%');
  });

  it('keeps the percentile rows when the run genuinely spread', () => {
    const text = exportFor({});
    expect(text).toContain('25–75%');
    expect(text).toContain('5–95%');
    expect(text).not.toContain('Deterministic run');
  });
});

describe('exportSummaryText — a run that produced no answer', () => {
  const labels = { c1: 'THC' };

  it('records the reason instead of an estimate of zero', () => {
    // The percentiles on a failed run are placeholders. "Median: 0 mg/L" in an
    // exported report would state an estimate the engine never produced.
    const r = {
      ...result(),
      median: 0,
      p05: 0,
      p25: 0,
      p75: 0,
      p95: 0,
      failure: {
        message: 'simulator.warnings.nonlinearDoseSolve',
        messageKey: 'simulator.warnings.nonlinearDoseSolve',
      },
    } as DrugSimResult;
    const text = exportSummaryText('Case', { c1: r }, labels, undefined, {
      c1: gradeResult(r, { role: 'admin', displayMatrix: 'whole_blood' }),
    });
    expect(text).toContain('NO ANSWER');
    expect(text).toContain('simulator.warnings.nonlinearDoseSolve');
    expect(text).not.toContain('Median:');
    expect(text).not.toContain('Plausible concentration');
  });
});
