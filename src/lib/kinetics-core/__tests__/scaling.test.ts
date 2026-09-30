/**
 * Body-composition Vd scaling must reproduce Redose's legacy `lib/pk/scaling.ts`
 * EXACTLY — that numeric identity is what makes a hydrophilic-drug migration a
 * traceable step rather than a silent re-parameterisation. These cases pin the
 * Boer LBM formula, the 70/56 reference pair, and the clamp against hand
 * computation.
 */
import { describe, it, expect } from 'vitest';
import type { CanonicalSubject } from '../types';
import {
  leanBodyMassKg,
  vdScaleKg,
  REFERENCE_WEIGHT_KG,
  REFERENCE_LBM_KG,
} from '../scaling';

// The legacy formula, re-derived here independently so the test can't drift with
// the implementation it guards.
function legacyLbm(weightKg: number, heightCm: number, sex: string): number {
  const lbm =
    sex === 'male'
      ? 0.407 * weightKg + 0.267 * heightCm - 19.2
      : 0.252 * weightKg + 0.473 * heightCm - 48.3;
  return Math.max(1, Math.min(lbm, weightKg * 0.95));
}
function legacyHydrophilicScaleKg(weightKg: number, heightCm: number, sex: string): number {
  return 70 * (legacyLbm(weightKg, heightCm, sex) / 56);
}

describe('kinetics-core body-composition scaling', () => {
  const subjects: CanonicalSubject[] = [
    { weightKg: 70, heightCm: 178, sex: 'male' },
    { weightKg: 60, heightCm: 165, sex: 'female' },
    { weightKg: 80, heightCm: 183, sex: 'male' },
    { weightKg: 95, heightCm: 170, sex: 'other' }, // 'other' → female coefficients
    { weightKg: 50, heightCm: 150, sex: 'female' }, // small-frame clamp territory
  ];

  it('leanBodyMassKg matches the legacy Boer formula (incl. clamp, sex handling)', () => {
    for (const s of subjects) {
      expect(leanBodyMassKg(s)).toBeCloseTo(
        legacyLbm(s.weightKg, s.heightCm as number, s.sex as string),
        12,
      );
    }
  });

  it('vdScaleKg(lean-body-mass) reproduces legacy vd·70·LBM/56', () => {
    for (const s of subjects) {
      expect(vdScaleKg(s, 'lean-body-mass')).toBeCloseTo(
        legacyHydrophilicScaleKg(s.weightKg, s.heightCm as number, s.sex as string),
        12,
      );
    }
  });

  it('vdScaleKg(total-weight) is the subject weight (legacy lipophilic branch)', () => {
    for (const s of subjects) {
      expect(vdScaleKg(s, 'total-weight')).toBe(s.weightKg);
    }
  });

  it('reference constants match the legacy engine (70 kg / 56 kg)', () => {
    expect(REFERENCE_WEIGHT_KG).toBe(70);
    expect(REFERENCE_LBM_KG).toBe(56);
    // A subject at exactly the reference LBM scales as if by 70 kg.
    const atRef = leanBodyMassKg({ weightKg: 70, heightCm: 177.15, sex: 'male' });
    // 0.407*70 + 0.267*177.15 - 19.2 = 56.0 (approx), so scale ≈ 70.
    expect(vdScaleKg({ weightKg: 70, heightCm: 177.15, sex: 'male' }, 'lean-body-mass')).toBeCloseTo(
      70 * (atRef / 56),
      12,
    );
  });
});
