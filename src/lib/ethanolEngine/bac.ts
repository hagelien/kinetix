import type {
  EthanolIntake,
  EthanolPersonParams,
  EthanolSimulationOutput,
  EthanolSimulationPoint,
} from './types';

const BAC_DECAY_PER_HOUR_FROM_GDL = 1;

export function getWidmarkR(params: EthanolPersonParams): number {
  if (params.distributionRatioOverride != null && params.distributionRatioOverride > 0) {
    return params.distributionRatioOverride;
  }
  return params.biologicalSex === 'female' ? 0.55 : 0.68;
}

/**
 * Blood-alcohol concentration (g/dL) at a single instant under a chronological
 * state model.
 *
 * Ethanol is eliminated at one zero-order rate β from the body as a whole, no
 * matter how many drinks are in play. We therefore process intakes in time
 * order, decay the WHOLE pool once between consecutive events, then add each
 * new intake's instantaneous rise. The previous implementation gave every
 * intake its own β slope and summed them, so two overlapping intakes declined
 * at ≈2β — clearing the alcohol roughly twice as fast as physiology allows.
 */
export function bacAtTime(
  intakes: EthanolIntake[],
  params: EthanolPersonParams,
  t: number,
): number {
  const r = getWidmarkR(params);
  const beta = params.eliminationRateGdlPerHour * BAC_DECAY_PER_HOUR_FROM_GDL;
  const relevant = intakes
    .filter((intake) => intake.ethanolGrams > 0 && intake.timeHour <= t)
    .sort((a, b) => a.timeHour - b.timeHour);

  let bacGdl = 0;
  let lastTime: number | null = null;
  for (const intake of relevant) {
    if (lastTime != null) {
      // Decay the total pool once across the gap (clamped at zero so a
      // fully-cleared pool never goes negative).
      bacGdl = Math.max(0, bacGdl - beta * (intake.timeHour - lastTime));
    }
    bacGdl += intake.ethanolGrams / (r * params.weightKg * 10);
    lastTime = intake.timeHour;
  }
  if (lastTime == null) return 0;
  return Math.max(0, bacGdl - beta * (t - lastTime));
}

export function estimateBacCurve(
  intakes: EthanolIntake[],
  params: EthanolPersonParams,
  options?: { fromHour?: number; toHour?: number; stepHours?: number },
): EthanolSimulationOutput {
  const fromHour = options?.fromHour ?? -2;
  const toHour = options?.toHour ?? 18;
  const stepHours = options?.stepHours ?? 0.25;

  const points: EthanolSimulationPoint[] = [];
  let peakBacGdl = 0;
  let peakTimeHour = fromHour;

  for (let t = fromHour; t <= toHour; t += stepHours) {
    const bacGdl = bacAtTime(intakes, params, t);
    points.push({ t, bacGdl });
    if (bacGdl > peakBacGdl) {
      peakBacGdl = bacGdl;
      peakTimeHour = t;
    }
  }

  const bacAtReference = points.find((p) => Math.abs(p.t) < stepHours / 2)?.bacGdl ?? 0;

  return { points, peakBacGdl, peakTimeHour, bacAtReference };
}
