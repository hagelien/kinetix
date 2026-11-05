import { describe, expect, it } from 'vitest';
import { eligibleStudyCurves, STUDY_CONCENTRATION_CURVES } from './studyCurves.js';

const directUrine = {
  pubchemCid: 3016,
  matrix: 'urine' as const,
  measurandMode: 'direct' as const,
  normalization: 'raw' as const,
};

describe('published study curve eligibility', () => {
  it('matches direct urine by analyte and keeps a nonzero first observation', () => {
    const [curve] = eligibleStudyCurves(directUrine);
    expect(curve?.points[0]).toEqual({ timeHours: 1, mean: 2.30, sd: 1.36 });
    expect(curve?.points.at(-1)?.timeHours).toBe(360);
    expect(curve?.participantCount).toBe(28);
    expect(curve?.citation.table).toBe(4);
  });

  it('does not substitute glucuronide data for oxazepam or invent opioid series', () => {
    for (const pubchemCid of [4616, 5288826, 5284371]) {
      expect(eligibleStudyCurves({ ...directUrine, pubchemCid })).toEqual([]);
    }
  });

  it('refuses incompatible matrix, normalization, postmortem and assay contexts', () => {
    expect(eligibleStudyCurves({ ...directUrine, matrix: 'whole_blood' })).toEqual([]);
    expect(eligibleStudyCurves({ ...directUrine, normalization: 'creatinine' })).toEqual([]);
    expect(eligibleStudyCurves({ ...directUrine, postmortem: true })).toEqual([]);
    for (const measurandMode of ['unknown', 'total_after_hydrolysis', 'class_response', 'direct_conjugate'] as const) {
      expect(eligibleStudyCurves({ ...directUrine, measurandMode })).toEqual([]);
    }
    expect(eligibleStudyCurves({ ...directUrine, hydrolysis: 'enzymatic' })).toEqual([]);
    expect(eligibleStudyCurves({ ...directUrine, hydrolysis: 'none' })).toHaveLength(1);
  });

  it('preserves the reported nordiazepam SD instead of treating it as a percentile', () => {
    const curve = STUDY_CONCENTRATION_CURVES.find((entry) => entry.analyte.pubchemCid === 2997);
    expect(curve?.points[0]).toEqual({ timeHours: 1, mean: 0.04, sd: 0.26 });
    expect(curve?.dispersion).toBe('sd');
  });
});
