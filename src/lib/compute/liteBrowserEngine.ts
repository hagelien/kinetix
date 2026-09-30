import { PRNG, sampleDistribution, computePercentiles } from '../distributions';
import { concentrationFromDoseIV, concentrationFromDoseOral } from '../pkEquations';
import { LITE_CAPABILITIES } from './capabilities';
import { findModelCardById, findModelCardByAnalyte } from './modelCards';
import { runLiteInference } from './liteInference';
import { renderReportMarkdown } from './report';
import {
  type ComputeCapability,
  type ComputeEngine,
  type EngineId,
  type SimulationInput,
  type SimulationResult,
  type InferenceInput,
  type InferenceResult,
  type ScenarioComparisonInput,
  type ScenarioComparisonResult,
  type ReportInput,
  type ReportResult,
  type DiagnosticSummary,
  type Assumption,
  type Limitation,
  simulationInputSchema,
  scenarioComparisonInputSchema,
  reportInputSchema,
} from './types';
import type { UncertaintyPoint } from '@/types/simulator';

// `LiteBrowserEngine` is the in-process compute engine. It wraps the existing
// pure PK + distribution helpers under `src/lib/`. Heavy-lift Monte Carlo work
// can be moved into `montecarlo.worker.ts` in a follow-up — the engine surface
// stays the same.

export class LiteBrowserEngine implements ComputeEngine {
  readonly id: EngineId = 'lite-browser';

  getCapabilities(): ComputeCapability[] {
    return [...LITE_CAPABILITIES];
  }

  async simulate(input: SimulationInput): Promise<SimulationResult> {
    const parsed = simulationInputSchema.parse(input);
    const card =
      findModelCardById(parsed.modelId) ??
      findModelCardByAnalyte(parsed.analyte);

    const rng = new PRNG(parsed.seed);
    const { start, end, steps } = parsed.timeRangeHours;
    const samples = parsed.drawCount;

    // Pre-allocate one Float64Array per time step; fill across draws so we
    // can compute percentiles without keeping a 2D matrix in JS objects.
    const timePoints: number[] = [];
    for (let i = 0; i <= steps; i++) {
      timePoints.push(start + ((end - start) * i) / steps);
    }
    const perTimeDraws: Float64Array[] = timePoints.map(
      () => new Float64Array(samples),
    );

    // IV is fully absorbed by definition — bioavailability is forced to 1
    // and the IV equation is used so a sampled F < 1 doesn't bias an IV
    // trajectory downward. Other routes go through the oral first-order
    // equation with sampled F.
    const isIv = parsed.route === 'iv';

    let validCount = 0;
    let rejectedDraws = 0;

    for (let s = 0; s < samples; s++) {
      // Reject nonsensical draws (vd <= 0, half-life <= 0, F outside (0, 1])
      // exactly the way `montecarlo.worker.ts` does — resample once, then
      // skip if the redraw is still bad. Otherwise broad priors can leak
      // negative or infinite concentrations into the percentile summary.
      const draw = sampleValidPkParams(parsed.parameters, rng, isIv);
      if (!draw) {
        rejectedDraws++;
        continue;
      }
      const { halfLife, vd, f } = draw;
      const k = Math.LN2 / halfLife;

      for (let i = 0; i < timePoints.length; i++) {
        const t = timePoints[i]!;
        // Pre-dose timepoints (t < 0) would otherwise produce exp(+k|t|) > C0,
        // i.e. a physically impossible curve before drug administration.
        if (t < 0) {
          perTimeDraws[i]![validCount] = 0;
          continue;
        }
        const c = isIv
          ? concentrationFromDoseIV(parsed.dose.value, vd, k, t)
          : concentrationFromDoseOral(parsed.dose.value, vd, f, k, t);
        perTimeDraws[i]![validCount] =
          Number.isFinite(c) && c >= 0 ? c : 0;
      }
      validCount++;
    }

    const timeSeries: UncertaintyPoint[] =
      validCount === 0
        ? timePoints.map((t) => ({
            t,
            p05: 0,
            p25: 0,
            median: 0,
            p75: 0,
            p95: 0,
          }))
        : perTimeDraws.map((draws, i) => {
            // Use a view over the valid prefix. computePercentiles copies once
            // before sorting, so slicing here would duplicate every draw row.
            const summary = computePercentiles(draws.subarray(0, validCount));
            return { t: timePoints[i]!, ...summary };
          });

    const warnings: string[] = [];
    if (!card) {
      warnings.push(
        'No KineLab model card was found for the requested analyte; using bare analytic-PK defaults.',
      );
    }
    if (rejectedDraws > 0) {
      warnings.push(
        `${rejectedDraws} of ${samples} draws were rejected because the priors produced nonphysical PK parameters (vd <= 0, half-life <= 0, or F outside (0, 1]). Tighten the priors if this fraction is large.`,
      );
    }
    if (validCount === 0) {
      warnings.push(
        'No draws survived validity checks. Output is a flat zero curve and should not be interpreted.',
      );
    }

    const diagnostics: DiagnosticSummary = {
      engine: 'lite-browser',
      method: 'analytic-pk-monte-carlo',
      sampleCount: validCount,
      warnings,
    };

    return {
      engine: 'lite-browser',
      modelId: card?.id ?? parsed.modelId,
      timeSeries,
      unit: 'mg/L',
      diagnostics,
      assumptions: card?.assumptions ?? [],
      limitations: card?.limitations ?? [defaultLiteLimitation],
      createdAt: new Date().toISOString(),
    };
  }

  async infer(input: InferenceInput): Promise<InferenceResult> {
    // Delegates to the single shared boundary so this direct path and the
    // off-thread `inference.worker.ts` path apply identical schema, model-card,
    // and matrix-policy validation. `runLiteInference` throws on matrix
    // violations / malformed input exactly as this method used to.
    const lite = runLiteInference(input);
    const { input: parsed, card, computation, posterior, predictive } = lite;

    const diagnostics: DiagnosticSummary = {
      engine: 'lite-browser',
      method: 'monte-carlo-importance-sampling',
      sampleCount: computation.samples.length,
      effectiveSampleSize: computation.effectiveSampleSize,
      warnings: lite.warnings,
    };

    return {
      engine: 'lite-browser',
      modelIds: [card?.id ?? parsed.modelId],
      posteriorSummary: posterior,
      posteriorPredictive:
        predictive.length > 0
          ? { timeSeries: predictive, unit: 'mg/L' }
          : undefined,
      diagnostics,
      assumptions: card?.assumptions ?? [],
      limitations: card?.limitations ?? [defaultLiteLimitation],
      createdAt: new Date().toISOString(),
    };
  }

  async compareScenarios(
    input: ScenarioComparisonInput,
  ): Promise<ScenarioComparisonResult> {
    const parsed = scenarioComparisonInputSchema.parse(input);

    // Sequential `await` loop (NOT Promise.all/map) so a failing scenario
    // — e.g. matrix-policy rejection inside infer() — short-circuits the
    // remaining scenarios instead of letting them complete N-1 worth of
    // wasted Monte Carlo work before the rejection surfaces. Reuses the
    // existing infer() path so all its likelihood + matrix-policy
    // validation applies uniformly.
    const results: Array<{
      id: string;
      label: string;
      result: InferenceResult;
    }> = [];
    for (const s of parsed.scenarios) {
      results.push({
        id: s.id,
        label: s.label,
        result: await this.infer(s.input),
      });
    }

    const totalSamples = results.reduce(
      (sum, r) => sum + (r.result.diagnostics.sampleCount ?? 0),
      0,
    );
    const aggregatedWarnings = results.flatMap((r) =>
      (r.result.diagnostics.warnings ?? []).map(
        (w) => `[${r.label}] ${w}`,
      ),
    );

    return {
      engine: 'lite-browser',
      scenarios: results,
      diagnostics: {
        engine: 'lite-browser',
        method: 'monte-carlo-importance-sampling',
        sampleCount: totalSamples,
        warnings: aggregatedWarnings,
      },
      createdAt: new Date().toISOString(),
    };
  }

  async generateReport(input: ReportInput): Promise<ReportResult> {
    const parsed = reportInputSchema.parse(input);
    const body = renderReportMarkdown(parsed);

    return {
      engine: 'lite-browser',
      format: 'markdown',
      body,
      diagnostics: {
        engine: 'lite-browser',
        // Reports are a transformation, not a computation, so the method
        // line distinguishes them from inference output.
        method: 'lite-markdown-report',
        sampleCount: parsed.inferenceResult.diagnostics.sampleCount,
        effectiveSampleSize:
          parsed.inferenceResult.diagnostics.effectiveSampleSize,
        warnings: parsed.inferenceResult.diagnostics.warnings,
      },
      createdAt: new Date().toISOString(),
    };
  }
}

const defaultLiteLimitation: Limitation = {
  id: 'lite-engine-default-disclaimer',
  text: 'Computed by the Lite browser engine. Output is scenario exploration, not a definitive forensic conclusion.',
  severity: 'warning',
};

interface ValidPkSample {
  halfLife: number;
  vd: number;
  f: number;
}

// Mirrors `montecarlo.worker.ts`: try once, redraw once, then give up. Keeps
// nonphysical parameter samples (vd <= 0, half-life <= 0, F outside (0, 1])
// out of the percentile summary.
function sampleValidPkParams(
  parameters: SimulationInput['parameters'],
  rng: PRNG,
  isIv: boolean,
): ValidPkSample | null {
  const draw = (): ValidPkSample => ({
    halfLife: sampleDistribution(parameters.halfLife, rng),
    vd: sampleDistribution(parameters.vd, rng),
    f: isIv ? 1 : sampleDistribution(parameters.f, rng),
  });
  const isValid = (s: ValidPkSample): boolean =>
    s.halfLife > 0 && s.vd > 0 && s.f > 0 && s.f <= 1;

  let s = draw();
  if (isValid(s)) return s;
  s = draw();
  return isValid(s) ? s : null;
}

// Re-export so call sites that only need the type don't have to reach into types.ts.
export type { Assumption, Limitation };
