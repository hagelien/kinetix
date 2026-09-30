import type { DrugSimResult } from '@/types/simulator';
import { CRITICAL_ESS_RATIO } from '@/lib/compute/liteInference';

/**
 * The single primary answer a result is meant to deliver, chosen by the task
 * rather than always reporting a peak. The label and the interval name both
 * change with the question:
 *  - inferred dose          → a back-calculated / posterior dose;
 *  - predicted concentration → forward concentration at the queried time;
 *  - back-extrapolated      → concentration earlier than the measurement;
 *  - BAC                    → blood-alcohol at the queried time.
 *
 * Interval naming is deliberately precise (the plan's "say what kind of
 * statistical quantity this is"):
 *  - `model`    — pointwise 90% interval from parameter uncertainty (Monte Carlo);
 *  - `credible` — 90% posterior credible interval (KineLab inference);
 *  - none       — a deterministic point estimate (Widmark).
 */
export interface ModelingAnswer {
  labelKey: string;
  value: number;
  unit: string;
  low?: number;
  high?: number;
  /** i18n key for the interval name, omitted when the estimate is deterministic. */
  intervalKey?: string;
}

const INTERVAL_MODEL = 'answer.interval.model';
const INTERVAL_CREDIBLE = 'answer.interval.credible';

/**
 * Whether a result actually carries an uncertainty band.
 *
 * A Monte Carlo run only spreads if the model declares a DISTRIBUTION for at
 * least one parameter (or an observation-error layer). Every reviewed
 * kinetics-core model currently declares `fixed` parameters only, so each draw
 * reproduces the central curve and the engine returns `p05 === median === p95`
 * by construction — a deterministic run, not a narrow interval. Reporting that
 * as "2.839 – 2.839, pointwise 90% model interval" states a precision the run
 * never established, so the answer surfaces drop the interval instead. When a
 * model gains real parameter distributions the band reappears with no further
 * change here.
 */
export function hasUncertaintyBand(result: DrugSimResult): boolean {
  return (
    Number.isFinite(result.p05) &&
    Number.isFinite(result.p95) &&
    result.p95 > result.p05
  );
}

export function deriveAnswer(result: DrugSimResult): ModelingAnswer {
  // KineLab inference: the inferred dose IS the answer, not the predicted peak
  // concentration. Surface the posterior dose median + 90% credible interval.
  if (result.engine === 'kinelab-bayes') {
    const dose = result.kinelab?.posterior.intervals.dose;
    if (dose) {
      return {
        labelKey: 'answer.inferredDose',
        value: dose.median,
        low: dose.p05,
        high: dose.p95,
        unit: dose.unit ?? 'mg',
        intervalKey: INTERVAL_CREDIBLE,
      };
    }
  }

  // Ethanol Widmark: a deterministic BAC at the queried time (or peak).
  if (result.engine === 'ethanol-widmark') {
    return {
      labelKey: 'answer.bac',
      value: result.median,
      unit: result.unit,
    };
  }

  // Monte Carlo PK: label by the question being asked.
  const labelKey =
    result.questionMode === 'dose-from-concentration'
      ? 'answer.inferredDose'
      : result.questionMode === 'earlier-from-later'
        ? 'answer.backExtrapolated'
        : 'answer.predictedConcentration';

  // A deterministic run has no interval to name (see `hasUncertaintyBand`), so
  // the answer is the point estimate alone rather than a collapsed range.
  if (!hasUncertaintyBand(result)) {
    return { labelKey, value: result.median, unit: result.unit };
  }

  return {
    labelKey,
    value: result.median,
    low: result.p05,
    high: result.p95,
    unit: result.unit,
    intervalKey: INTERVAL_MODEL,
  };
}

/**
 * Whether a KineLab posterior is robust enough to present as a point estimate.
 * A critically low effective sample size, or an empty posterior, means the
 * median/CI is dominated by a handful of high-weight draws (or does not exist),
 * so it must be blocked in the UI rather than shown as an authoritative answer.
 * A result the engine could not produce at all (`failure`) is blocked the same
 * way, whatever engine it came from. Every other non-KineLab result is
 * considered robust here (it has its own warnings surface).
 */
export type KinelabRobustness =
  | { robust: true }
  | { robust: false; reasonKey: string };

export function kinelabRobustness(result: DrugSimResult): KinelabRobustness {
  // A run that failed outright carries placeholder zeros, not an estimate. It
  // is not "a number to treat with care" — there is no number — so it is
  // blocked by the same gate rather than reaching the headline as "0".
  if (result.failure) {
    return {
      robust: false,
      reasonKey: result.failure.messageKey ?? result.failure.message,
    };
  }
  if (result.engine !== 'kinelab-bayes' || !result.kinelab) {
    return { robust: true };
  }
  const d = result.kinelab.diagnostics;
  if (d.sampleCount <= 0 || !result.kinelab.posterior.intervals.dose) {
    return { robust: false, reasonKey: 'answer.notRobust.emptyPosterior' };
  }
  const ratio = d.effectiveSampleSize / d.sampleCount;
  if (ratio < CRITICAL_ESS_RATIO) {
    return { robust: false, reasonKey: 'answer.notRobust.criticalEss' };
  }
  return { robust: true };
}
