import { describe, it, expect } from 'vitest';
import {
  workerOutputToScenarioComparisonResult,
  type WorkerScenarioComparisonOutputLike,
} from '../scenarioComparisonResult';
import {
  scenarioComparisonResultSchema,
  type Assumption,
  type Limitation,
} from '../types';
import { renderReportMarkdown } from '../report';

// Synthesizes a worker-shaped comparison output without spinning up the
// actual worker. Mirrors what `runOne()` in `inference.worker.ts` would
// produce after `summarizePosterior` + `posteriorPredictive`.
function makeWorkerOutput(
  scenarios: Array<{
    id: string;
    label: string;
    doseMedian: number;
    sampleCount: number;
    ess: number;
  }>,
): WorkerScenarioComparisonOutputLike {
  return {
    scenarios: scenarios.map((s) => ({
      id: s.id,
      label: s.label,
      output: {
        posterior: {
          intervals: {
            dose: { p05: s.doseMedian * 0.8, median: s.doseMedian, p95: s.doseMedian * 1.2, unit: 'mg' },
          },
        },
        predictive: [
          { t: 0, p05: 0, p25: 0, median: 0, p75: 0, p95: 0 },
          { t: 1, p05: 0.05, p25: 0.08, median: 0.1, p75: 0.12, p95: 0.15 },
        ],
        diagnostics: {
          sampleCount: s.sampleCount,
          effectiveSampleSize: s.ess,
        },
      },
    })),
  };
}

const STUB_ASSUMPTIONS: Assumption[] = [
  { id: 'one-comp', text: 'One-compartment first-order absorption' },
];
const STUB_LIMITATIONS: Limitation[] = [
  { id: 'lite-disclaimer', text: 'Lite engine.', severity: 'info' },
];

describe('workerOutputToScenarioComparisonResult', () => {
  it('produces a value that satisfies scenarioComparisonResultSchema', () => {
    // Schema parse is the canonical "is this engine-compatible?" gate. If
    // the converter ever drifts (e.g., a new required field on
    // InferenceResult), this catches it before the report flow tries to
    // splice it in.
    const out = makeWorkerOutput([
      { id: 'a', label: 'Scenario A (baseline)', doseMedian: 100, sampleCount: 1000, ess: 540 },
      { id: 'b', label: 'High dose', doseMedian: 250, sampleCount: 1000, ess: 410 },
    ]);
    const result = workerOutputToScenarioComparisonResult(out, {
      modelId: 'ketamine-one-comp-v0',
      assumptions: STUB_ASSUMPTIONS,
      limitations: STUB_LIMITATIONS,
      predictiveUnit: 'mg/L',
    });
    expect(() => scenarioComparisonResultSchema.parse(result)).not.toThrow();
    expect(result.engine).toBe('lite-browser');
    expect(result.scenarios).toHaveLength(2);
    expect(result.scenarios[0]?.label).toBe('Scenario A (baseline)');
  });

  it('aggregates total sampleCount across scenarios', () => {
    // Matches what `LiteBrowserEngine.compareScenarios()` reports so a
    // comparison computed inline vs. off-thread looks the same in the
    // diagnostics line.
    const out = makeWorkerOutput([
      { id: 'a', label: 'A', doseMedian: 100, sampleCount: 800, ess: 600 },
      { id: 'b', label: 'B', doseMedian: 150, sampleCount: 1200, ess: 500 },
    ]);
    const result = workerOutputToScenarioComparisonResult(out, {
      modelId: 'm',
      assumptions: [],
      limitations: [],
      predictiveUnit: 'mg/L',
    });
    expect(result.diagnostics.sampleCount).toBe(2000);
  });

  it('propagates baseline modelId / assumptions / limitations to every scenario', () => {
    // Every scenario in a comparison shares one model card today (variants
    // inherit and override priors only). The converter therefore reuses
    // the baseline's model metadata; the report's per-scenario
    // InferenceResult slots stay populated even though the comparison
    // table itself doesn't render them.
    const out = makeWorkerOutput([
      { id: 'a', label: 'A', doseMedian: 100, sampleCount: 100, ess: 80 },
      { id: 'b', label: 'B', doseMedian: 200, sampleCount: 100, ess: 70 },
    ]);
    const result = workerOutputToScenarioComparisonResult(out, {
      modelId: 'ketamine-one-comp-v0',
      assumptions: STUB_ASSUMPTIONS,
      limitations: STUB_LIMITATIONS,
      predictiveUnit: 'mg/L',
    });
    for (const sc of result.scenarios) {
      expect(sc.result.modelIds).toEqual(['ketamine-one-comp-v0']);
      expect(sc.result.assumptions).toEqual(STUB_ASSUMPTIONS);
      expect(sc.result.limitations).toEqual(STUB_LIMITATIONS);
      expect(sc.result.posteriorPredictive?.unit).toBe('mg/L');
    }
  });

  it('flows through renderReportMarkdown into a comparison block', () => {
    // End-to-end check that the `inferenceInput`-only report path AND the
    // comparison-bearing path both succeed, and that the comparison
    // table actually appears in the markdown.
    const out = makeWorkerOutput([
      { id: 'a', label: 'Baseline', doseMedian: 100, sampleCount: 500, ess: 400 },
      { id: 'b', label: 'Variant high', doseMedian: 250, sampleCount: 500, ess: 320 },
    ]);
    const comparison = workerOutputToScenarioComparisonResult(out, {
      modelId: 'ketamine-one-comp-v0',
      assumptions: STUB_ASSUMPTIONS,
      limitations: STUB_LIMITATIONS,
      predictiveUnit: 'mg/L',
    });
    const primaryResult = comparison.scenarios[0]?.result;
    if (!primaryResult) throw new Error('expected at least one scenario');
    const md = renderReportMarkdown({
      // Use scenario A's result as the primary InferenceResult — same shape
      // as the page produces, and good enough to satisfy the schema for
      // the rendering smoke test.
      inferenceResult: primaryResult,
      scenarioComparison: comparison,
    });
    expect(md).toContain('## Scenario comparison');
    expect(md).toContain('Baseline');
    expect(md).toContain('Variant high');
    // ESS column rendered to one decimal as the renderer specifies.
    expect(md).toContain('400.0');
    expect(md).toContain('320.0');
  });
});
