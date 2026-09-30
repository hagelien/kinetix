import { describe, it, expect, vi } from 'vitest';
import { LiteBrowserEngine } from '../liteBrowserEngine';
import {
  LITE_LIMITATION_STATEMENT_TEXT,
  defaultEnglishReportLabels,
} from '../report';
import type {
  InferenceInput,
  ScenarioComparisonInput,
  ReportInput,
  ReportLabels,
} from '../types';

const BASELINE_MS = new Date('2030-01-01T00:00:00Z').getTime();
const SAMPLE_HOURS = 2;
const SAMPLE_ISO = new Date(BASELINE_MS + SAMPLE_HOURS * 3_600_000).toISOString();
const TRUE_DOSE = 100;
const TRUE_VD = 50;
const TRUE_HALF = 4;
const PREDICTED_C =
  (TRUE_DOSE / TRUE_VD) * Math.exp(-Math.LN2 / TRUE_HALF * SAMPLE_HOURS);

function ivInput(overrides: Partial<InferenceInput> = {}): InferenceInput {
  return {
    modelId: 'ethanol-zero-order-v0',
    analyte: 'ethanol',
    route: 'iv',
    observations: [
      {
        id: 'obs-1',
        analyte: 'ethanol',
        concentration: { value: PREDICTED_C, unit: 'mg/L' },
        matrix: 'whole_blood',
        sampleTime: SAMPLE_ISO,
        assay: { uncertaintyCV: 0.05 },
      },
    ],
    priors: {
      dose: { type: 'uniform', min: 10, max: 500 },
      halfLife: { type: 'fixed', value: TRUE_HALF },
      vd: { type: 'fixed', value: TRUE_VD },
    },
    scenario: {
      possibleIntakeWindow: {
        earliestIso: new Date(BASELINE_MS).toISOString(),
        latestIso: new Date(BASELINE_MS).toISOString(),
      },
    },
    defaultAssayCV: 0.15,
    drawCount: 1000,
    gridResolution: 40,
    seed: 11,
    ...overrides,
  };
}

describe('LiteBrowserEngine.compareScenarios', () => {
  it('runs each scenario and returns a typed comparison result', async () => {
    const engine = new LiteBrowserEngine();
    const input: ScenarioComparisonInput = {
      scenarios: [
        { id: 'a', label: 'Tight CV', input: ivInput() },
        {
          id: 'b',
          label: 'Loose CV',
          input: ivInput({
            observations: [
              {
                id: 'obs-1',
                analyte: 'ethanol',
                concentration: { value: PREDICTED_C, unit: 'mg/L' },
                matrix: 'whole_blood',
                sampleTime: SAMPLE_ISO,
                assay: { uncertaintyCV: 0.5 },
              },
            ],
          }),
        },
      ],
    };
    const out = await engine.compareScenarios(input);
    expect(out.engine).toBe('lite-browser');
    expect(out.scenarios).toHaveLength(2);
    expect(out.scenarios[0]!.id).toBe('a');
    expect(out.scenarios[1]!.id).toBe('b');
    // Tight assay CV should produce a narrower 90 % CI than loose CV.
    const aDose = out.scenarios[0]!.result.posteriorSummary.intervals.dose!;
    const bDose = out.scenarios[1]!.result.posteriorSummary.intervals.dose!;
    expect(aDose.p95 - aDose.p05).toBeLessThan(bDose.p95 - bDose.p05);
  });

  it('aggregates per-scenario warnings with the scenario label as a prefix', async () => {
    const engine = new LiteBrowserEngine();
    // Wide dose prior + tight CV → low ESS warning fires for both scenarios.
    const lowEssInput = ivInput({
      priors: {
        dose: { type: 'uniform', min: 1, max: 5000 },
        halfLife: { type: 'fixed', value: TRUE_HALF },
        vd: { type: 'fixed', value: TRUE_VD },
      },
      observations: [
        {
          id: 'obs-1',
          analyte: 'ethanol',
          concentration: { value: PREDICTED_C, unit: 'mg/L' },
          matrix: 'whole_blood',
          sampleTime: SAMPLE_ISO,
          assay: { uncertaintyCV: 0.001 },
        },
      ],
      drawCount: 200,
    });
    const out = await engine.compareScenarios({
      scenarios: [
        { id: 'a', label: 'Scenario A', input: lowEssInput },
        { id: 'b', label: 'Scenario B', input: lowEssInput },
      ],
    });
    const warnings = out.diagnostics.warnings ?? [];
    expect(warnings.some((w) => w.startsWith('[Scenario A]'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('[Scenario B]'))).toBe(true);
  });

  it('rejects single-scenario input via the schema (min: 2)', async () => {
    const engine = new LiteBrowserEngine();
    await expect(
      engine.compareScenarios({
        scenarios: [{ id: 'a', label: 'Solo', input: ivInput() }],
      } as ScenarioComparisonInput),
    ).rejects.toThrow();
  });

  it('fails fast: a failing early scenario short-circuits the rest', async () => {
    // Regression for PR #237 codex P2. Spy on infer() so we can prove later
    // scenarios never start when an earlier one rejects.
    const engine = new LiteBrowserEngine();
    const inferSpy = vi.spyOn(engine, 'infer');

    // First scenario uses an invalid matrix to force an immediate rejection
    // from infer's matrix-policy guard. Second scenario is valid.
    const failing: ScenarioComparisonInput = {
      scenarios: [
        {
          id: 'a',
          label: 'Bad matrix',
          input: ivInput({
            observations: [
              {
                id: 'obs-1',
                analyte: 'ethanol',
                concentration: { value: PREDICTED_C, unit: 'mg/L' },
                matrix: 'urine', // not in ethanol model card supportedMatrices
                sampleTime: SAMPLE_ISO,
              },
            ],
          }),
        },
        { id: 'b', label: 'Would-be-fine', input: ivInput() },
      ],
    };
    await expect(engine.compareScenarios(failing)).rejects.toThrow();
    // Only the first scenario should have been attempted.
    expect(inferSpy).toHaveBeenCalledTimes(1);
  });
});

describe('LiteBrowserEngine.generateReport', () => {
  async function buildResult() {
    const engine = new LiteBrowserEngine();
    const input = ivInput();
    const inferenceResult = await engine.infer(input);
    return { engine, input, inferenceResult };
  }

  it('emits markdown carrying every required section', async () => {
    const { engine, input, inferenceResult } = await buildResult();
    const report = await engine.generateReport({
      inferenceInput: input,
      inferenceResult,
      caseId: 'case-42',
      cover: { title: 'Trial report', authoredBy: 'tester' },
    });
    expect(report.engine).toBe('lite-browser');
    expect(report.format).toBe('markdown');

    // All the spec-mandated sections must show up.
    expect(report.body).toContain('# Trial report');
    expect(report.body).toContain('case-42');
    expect(report.body).toContain('## Case summary');
    expect(report.body).toContain('## Observations');
    expect(report.body).toContain('## Method');
    expect(report.body).toContain('## Posterior parameter intervals');
    expect(report.body).toContain('## Limitations');

    // Verbatim Lite disclaimer per spec.
    expect(report.body).toContain(LITE_LIMITATION_STATEMENT_TEXT);
  });

  it('falls back to a sensible report when no inferenceInput is supplied', async () => {
    const { engine, inferenceResult } = await buildResult();
    const report = await engine.generateReport({ inferenceResult });
    expect(report.body).toContain('# KineLab Lite — inference report');
    expect(report.body).toContain('## Case summary');
    // Without inferenceInput we cannot render an observation table.
    expect(report.body).not.toContain('## Observations');
  });

  it('renders the scenario comparison block when supplied', async () => {
    const { engine, input, inferenceResult } = await buildResult();
    const comparison = await engine.compareScenarios({
      scenarios: [
        { id: 'a', label: 'Lower bound', input },
        { id: 'b', label: 'Upper bound', input: ivInput({ seed: 12 }) },
      ],
    });
    const report = await engine.generateReport({
      inferenceInput: input,
      inferenceResult,
      scenarioComparison: comparison,
    });
    expect(report.body).toContain('## Scenario comparison');
    expect(report.body).toContain('Lower bound');
    expect(report.body).toContain('Upper bound');
  });

  it('honours caller-supplied labels (i18n entry point)', async () => {
    // Regression for PR #237 codex P1. The page populates `labels` from `t()`
    // so a Norwegian session gets Norwegian report chrome. The renderer
    // itself stays React-free; we just have to confirm overrides win.
    const { engine, inferenceResult, input } = await buildResult();
    const overrides: ReportLabels = {
      ...defaultEnglishReportLabels,
      defaultTitle: 'KineLab Lite — inferensrapport',
      caseSummary: 'Kasussammendrag',
      observations: 'Observasjoner',
      method: 'Metode',
      limitations: 'Begrensninger',
    };
    const report = await engine.generateReport({
      inferenceInput: input,
      inferenceResult,
      labels: overrides,
    });
    // Overridden chrome appears.
    expect(report.body).toContain('# KineLab Lite — inferensrapport');
    expect(report.body).toContain('## Kasussammendrag');
    expect(report.body).toContain('## Observasjoner');
    expect(report.body).toContain('## Metode');
    expect(report.body).toContain('## Begrensninger');
    // English fallback labels are NOT present where they would have been.
    expect(report.body).not.toContain('## Case summary');
    expect(report.body).not.toContain('## Observations');
  });

  it('renders observations from the supplied inferenceInput, not any later form state', async () => {
    // Regression for PR #239 codex P1. The page must pair `result` with the
    // exact `inferenceInput` it was computed against, NOT a freshly-rebuilt
    // input that may reflect post-run form edits. We simulate that by
    // building two distinct inputs (the "run" snapshot and a "stale form"
    // value) and asserting the report only contains the snapshot's
    // observation values.
    const { engine, inferenceResult } = await buildResult();
    const snapshotInput: InferenceInput = {
      ...ivInput(),
      observations: [
        {
          id: 'obs-snapshot',
          analyte: 'ethanol',
          concentration: { value: 0.42, unit: 'mg/L' },
          matrix: 'whole_blood',
          sampleTime: SAMPLE_ISO,
          assay: { uncertaintyCV: 0.05 },
        },
      ],
    };
    // What the report SHOULD NOT include: the user's post-run form edit.
    const staleFormInput: InferenceInput = {
      ...ivInput(),
      observations: [
        {
          id: 'obs-stale',
          analyte: 'ethanol',
          concentration: { value: 9.99, unit: 'mg/L' },
          matrix: 'whole_blood',
          sampleTime: SAMPLE_ISO,
          assay: { uncertaintyCV: 0.5 },
        },
      ],
    };
    const report = await engine.generateReport({
      inferenceInput: snapshotInput, // page passes the snapshot
      inferenceResult,
    });
    expect(report.body).toContain('obs-snapshot');
    expect(report.body).toContain('0.42 mg/L');
    expect(report.body).not.toContain('obs-stale');
    expect(report.body).not.toContain('9.99 mg/L');
    // Extra safety: just because we never passed staleFormInput, none of its
    // distinguishing values should be inside the report at all.
    void staleFormInput;
  });

  it('preserves source diagnostic warnings into the report diagnostics', async () => {
    const { engine } = await buildResult();
    const input: ReportInput = {
      inferenceResult: {
        engine: 'lite-browser',
        modelIds: ['ethanol-zero-order-v0'],
        posteriorSummary: { intervals: {} },
        diagnostics: {
          engine: 'lite-browser',
          method: 'monte-carlo-importance-sampling',
          sampleCount: 1234,
          effectiveSampleSize: 567.8,
          warnings: ['Effective sample size is low.'],
        },
        assumptions: [],
        limitations: [],
        createdAt: '2030-01-01T00:00:00.000Z',
      },
    };
    const report = await engine.generateReport(input);
    expect(report.diagnostics.method).toBe('lite-markdown-report');
    expect(report.diagnostics.sampleCount).toBe(1234);
    expect(report.diagnostics.effectiveSampleSize).toBeCloseTo(567.8, 6);
    expect(report.diagnostics.warnings).toEqual([
      'Effective sample size is low.',
    ]);
  });
});
