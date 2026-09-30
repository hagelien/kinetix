/**
 * SC-5A — latent → observed matrix-transform contract.
 *
 * The observation is not the latent state: a model computes a concentration in its
 * NATIVE matrix, and the engine must never silently report that latent value as a
 * measurement in a different matrix. A cross-matrix request is honoured only via a
 * reviewed, model-declared transform; otherwise it is refused.
 *
 * The decision (`selectMatrixTransform`) and the scaling (`scaleCurvePointByRatio`) are
 * tested directly — no shipped model declares a transform yet (a reviewed conversion is
 * evidence-gated per analyte, SC-5) — plus the end-to-end native/refuse paths through
 * `simulateScenario` with a real registered (plasma) model.
 */
import { describe, it, expect } from 'vitest';
import {
  simulateScenario,
  selectMatrixTransform,
  scaleCurvePointByRatio,
} from '../simulate';
import type { CanonicalScenario, CanonicalSubject, MatrixTransform, CurvePoint } from '../types';

const NOW = '2026-08-20T00:00:00.000Z';
const subject: CanonicalSubject = { weightKg: 80 };

const bloodFromPlasma: MatrixTransform = {
  from: 'plasma',
  to: 'whole_blood',
  ratio: 0.55,
  rationale: 'Illustrative blood:plasma partition ratio.',
};
const model = { analyte: 'demo', matrix: 'plasma' as const, matrixTransforms: [bloodFromPlasma] };

describe('SC-5A — selectMatrixTransform (the cross-matrix decision)', () => {
  it('is native when no matrix is requested', () => {
    expect(selectMatrixTransform(model, undefined)).toEqual({ kind: 'native' });
  });

  it('is native when the request equals the model matrix', () => {
    expect(selectMatrixTransform(model, 'plasma')).toEqual({ kind: 'native' });
  });

  it('applies a declared transform for a covered cross-matrix request', () => {
    const r = selectMatrixTransform(model, 'whole_blood');
    expect(r.kind).toBe('transform');
    if (r.kind === 'transform') expect(r.transform).toEqual(bloodFromPlasma);
  });

  it('refuses a cross-matrix request with no declared transform', () => {
    expect(selectMatrixTransform(model, 'serum')).toEqual({ kind: 'unsupported' });
    // No transforms at all.
    expect(selectMatrixTransform({ analyte: 'demo', matrix: 'plasma' }, 'whole_blood')).toEqual({
      kind: 'unsupported',
    });
  });

  it('refuses a transform whose direction does not start at the model matrix', () => {
    // A transform declared from serum (not the model's plasma) does not cover a
    // plasma→whole_blood request.
    const mis = {
      analyte: 'demo',
      matrix: 'plasma' as const,
      matrixTransforms: [{ from: 'serum' as const, to: 'whole_blood' as const, ratio: 1.1, rationale: 'x' }],
    };
    expect(selectMatrixTransform(mis, 'whole_blood')).toEqual({ kind: 'unsupported' });
  });

  it('refuses a non-physical ratio (≤ 0 or non-finite)', () => {
    for (const ratio of [0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const bad = {
        analyte: 'demo',
        matrix: 'plasma' as const,
        matrixTransforms: [{ from: 'plasma' as const, to: 'whole_blood' as const, ratio, rationale: 'x' }],
      };
      expect(selectMatrixTransform(bad, 'whole_blood')).toEqual({ kind: 'unsupported' });
    }
  });

  it('resolves transforms PER analyte — a metabolite is not covered by the parent transform', () => {
    // A parent/metabolite model that declares a conversion ONLY for its primary analyte:
    // the primary resolves, but the metabolite (a distinct entity with its own partition
    // ratio) does NOT — it must carry its own declared transform.
    const pm = {
      analyte: 'parent',
      matrix: 'plasma' as const,
      matrixTransforms: [bloodFromPlasma], // no `analyte` → applies to the primary 'parent'
    };
    expect(selectMatrixTransform(pm, 'whole_blood', 'parent').kind).toBe('transform');
    expect(selectMatrixTransform(pm, 'whole_blood', 'metabolite')).toEqual({ kind: 'unsupported' });

    // Add an analyte-specific transform for the metabolite with its OWN ratio.
    const pm2 = {
      analyte: 'parent',
      matrix: 'plasma' as const,
      matrixTransforms: [
        bloodFromPlasma,
        { from: 'plasma' as const, to: 'whole_blood' as const, ratio: 1.3, analyte: 'metabolite', rationale: 'y' },
      ],
    };
    const m = selectMatrixTransform(pm2, 'whole_blood', 'metabolite');
    expect(m.kind).toBe('transform');
    if (m.kind === 'transform') expect(m.transform.ratio).toBe(1.3);
    // The primary still resolves to its own (different) ratio.
    const p = selectMatrixTransform(pm2, 'whole_blood', 'parent');
    if (p.kind === 'transform') expect(p.transform.ratio).toBe(0.55);
  });
});

describe('SC-5A — scaleCurvePointByRatio', () => {
  it('scales every percentile by the ratio and preserves the time', () => {
    const p: CurvePoint = { tHours: 2, median: 10, p05: 4, p25: 7, p75: 13, p95: 18 };
    expect(scaleCurvePointByRatio(p, 0.5)).toEqual({
      tHours: 2,
      median: 5,
      p05: 2,
      p25: 3.5,
      p75: 6.5,
      p95: 9,
    });
  });
});

function scenario(matrix?: CanonicalScenario['matrix']): CanonicalScenario {
  return {
    schemaVersion: '1',
    analyte: 'amphetamine',
    ...(matrix ? { matrix } : {}),
    subject,
    doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
    timeGrid: { startHours: 0, endHours: 24, stepHours: 1 },
  };
}

describe('SC-5A — end-to-end through a registered (plasma) model', () => {
  it('reports the native matrix and no transform when none is requested', () => {
    const res = simulateScenario(scenario(), NOW);
    if (!res.ok) throw new Error(`expected ok, got ${res.failure}`);
    expect(res.matrix).toBe('plasma');
    expect(res.manifest.matrixTransform).toBeUndefined();
  });

  it('refuses a cross-matrix request a model has no reviewed transform for', () => {
    const res = simulateScenario(scenario('whole_blood'), NOW);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failure).toBe('unsupported-scenario');
      expect(res.detail).toContain('no reviewed transform');
    }
  });

  it('still reports the native matrix when the requested matrix equals it', () => {
    const res = simulateScenario(scenario('plasma'), NOW);
    if (!res.ok) throw new Error(`expected ok, got ${res.failure}`);
    expect(res.matrix).toBe('plasma');
    expect(res.manifest.matrixTransform).toBeUndefined();
  });
});
