import { parseLocaleNumber } from '@/lib/parseNumber';
import type { DistributionSpec } from '@/types/simulator';
import type { InferenceInput, InferencePriors } from './types';

// Helpers for the scenario-comparison flow on /kinelab.
//
// Each variant inherits scenario A (the snapshotted `lastRunInput`) and
// applies only "what changed" — typically priors and the assay CV. The
// observations, intake window, route, analyte, and seed all stay shared
// across scenarios so the comparison answers "given THE SAME observed data,
// how do the posteriors move under different prior assumptions?"
//
// Empty / blank override fields mean "inherit". The merger maps the form-
// shape (strings) to the `InferenceInput` shape and falls back to the
// baseline value when an override is missing or unparseable. Failing parse
// uses the baseline rather than throwing because the page validates each
// variant before kicking off the comparison.

export interface VariantPriorOverrides {
  /** Inclusive low end of a uniform dose prior, in mg. */
  doseLowMg?: string;
  /** Inclusive high end of a uniform dose prior, in mg. */
  doseHighMg?: string;
  /** Fixed half-life override, in hours. First-order baselines only. */
  halfLifeHours?: string;
  /** Fixed Vd override, in litres. */
  vdLitres?: string;
  /** Fixed bioavailability override, dimensionless 0–1. First-order only. */
  bioavailability?: string;
  /** Fixed zero-order elimination rate override, in mg/L per hour.
   *  Zero-order baselines only (ethanol). */
  eliminationRateMgPerLPerHour?: string;
  /** Default assay CV override (if blank, scenario A's CV applies). */
  assayCV?: string;
}

export interface ScenarioVariant {
  id: string;
  label: string;
  overrides: VariantPriorOverrides;
}

export function mergeVariantIntoBaseline(
  baseline: InferenceInput,
  variant: VariantPriorOverrides,
): InferenceInput {
  const priors: InferencePriors = {
    dose: mergeDose(
      baseline.priors.dose,
      variant.doseLowMg,
      variant.doseHighMg,
    ),
    // halfLife is undefined for zero-order baselines; preserve that. The
    // first-order branch keeps its variant override as before.
    halfLife: baseline.priors.halfLife
      ? mergeFixed(baseline.priors.halfLife, variant.halfLifeHours)
      : baseline.priors.halfLife,
    vd: mergeFixed(baseline.priors.vd, variant.vdLitres),
    f:
      variant.bioavailability != null && variant.bioavailability !== ''
        ? mergeBoundedFraction(
            baseline.priors.f ?? { type: 'fixed', value: 1 },
            variant.bioavailability,
          )
        : baseline.priors.f,
    // Zero-order baselines carry an `eliminationRate` prior; the variant
    // can override it independently of half-life/F, which the zero-order
    // engine ignores.
    eliminationRate: baseline.priors.eliminationRate
      ? mergeFixed(
          baseline.priors.eliminationRate,
          variant.eliminationRateMgPerLPerHour,
        )
      : baseline.priors.eliminationRate,
  };

  const overriddenCV = parseFiniteNumber(variant.assayCV);

  // Apply the assay-CV override at two levels: the engine-wide
  // `defaultAssayCV` AND every observation's `assay.uncertaintyCV`. The
  // observation-level value wins inside the likelihood loop, so updating
  // it here makes the override actually take effect on the inference path.
  const observations =
    overriddenCV != null && overriddenCV > 0
      ? baseline.observations.map((o) => ({
          ...o,
          assay: { ...(o.assay ?? {}), uncertaintyCV: overriddenCV },
        }))
      : baseline.observations;

  return {
    ...baseline,
    priors,
    observations,
    defaultAssayCV:
      overriddenCV != null && overriddenCV > 0
        ? overriddenCV
        : baseline.defaultAssayCV,
  };
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function mergeDose(
  baseline: DistributionSpec,
  lowStr: string | undefined,
  highStr: string | undefined,
): DistributionSpec {
  const low = parseFiniteNumber(lowStr);
  const high = parseFiniteNumber(highStr);
  if (low == null && high == null) return baseline;
  // If we got at least one value, fall back to a sensible value for the
  // other half. For a uniform dose prior we already have min/max in the
  // baseline; reuse them.
  const baselineLow = baseline.type === 'uniform' ? baseline.min : undefined;
  const baselineHigh = baseline.type === 'uniform' ? baseline.max : undefined;
  const baselineFixed = baseline.type === 'fixed' ? baseline.value : undefined;
  const resolvedLow = low ?? baselineLow ?? baselineFixed;
  const resolvedHigh = high ?? baselineHigh ?? baselineFixed;
  if (resolvedLow == null || resolvedHigh == null) return baseline;
  // Reject non-positive bounds: dose <= 0 is unphysical and would otherwise
  // get passed straight to drawValidDraw which would silently reject every
  // sampled draw, collapsing ESS instead of inheriting the baseline. Easier
  // for the operator to see "my override was ignored" than to chase an
  // empty posterior.
  if (resolvedLow <= 0 || resolvedHigh <= 0) return baseline;
  if (resolvedHigh <= resolvedLow) return baseline; // ignore degenerate override
  return { type: 'uniform', min: resolvedLow, max: resolvedHigh };
}

function mergeFixed(
  baseline: DistributionSpec,
  override: string | undefined,
): DistributionSpec {
  const value = parseFiniteNumber(override);
  if (value == null || value <= 0) return baseline;
  return { type: 'fixed', value };
}

/** Bioavailability lives in (0, 1]. The locale-aware parser turns a
 *  Norwegian decimal-comma `1,5` into `1.5` — `Number()` would have
 *  silently returned NaN — so the upper bound now needs an explicit
 *  check here, otherwise the inference draw validator rejects every
 *  first-order draw with `f > 1` and the variant collapses to an
 *  empty posterior. Mirrors `parseOverrideF` on the main form. */
function mergeBoundedFraction(
  baseline: DistributionSpec,
  override: string | undefined,
): DistributionSpec {
  const value = parseFiniteNumber(override);
  if (value == null || value <= 0 || value > 1) return baseline;
  return { type: 'fixed', value };
}

function parseFiniteNumber(value: string | undefined): number | null {
  if (value == null || value.trim() === '') return null;
  // Use the same locale-aware parser as the main KineLab override path.
  // Without it, Norwegian
  // users who type `150,5` for any variant override (elimination rate,
  // half-life, Vd, dose, assay CV) silently fall back to the baseline
  // value while the typed override stays visible — the comparison
  // output then doesn't reflect the displayed variant.
  const n = parseLocaleNumber(value);
  return Number.isFinite(n) ? n : null;
}
