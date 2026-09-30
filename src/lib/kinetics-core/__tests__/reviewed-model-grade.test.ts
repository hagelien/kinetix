import { describe, it, expect } from 'vitest';
import { registeredAnalytes, findModel } from '../registry.js';
import { assessReviewedModel } from '../reviewed-model-grade.js';
import {
  evaluateGradePolicy,
  renderDisposition,
} from '../grade-policy.js';

describe('assessReviewedModel — the reviewed override tier', () => {
  const models = registeredAnalytes().map((a) => findModel(a)!);

  it('grades every shipped model, with no unassessed dimension', () => {
    expect(models).toHaveLength(12);
    for (const model of models) {
      const result = evaluateGradePolicy(assessReviewedModel(model));
      expect(result.grade, model.modelId).not.toBe('ungraded');
      // Nothing scored D-by-default: every dimension was actually assessed.
      for (const item of result.disclosable) {
        expect(item.reason, `${model.modelId}/${item.dimension}`).toBeDefined();
        expect(item.reason).not.toContain('Not assessed');
      }
    }
  });

  it('puts the current registry at C — the state Amendment 1 was written for', () => {
    for (const model of models) {
      const result = evaluateGradePolicy(assessReviewedModel(model));
      expect(result.grade, model.modelId).toBe('C');
      // And names why, so the disclosure has something true to say.
      expect(result.limitingDimensions).toContain('primary-source-review');
      expect(result.limitingDimensions).toContain('validation-status');
      expect(result.limitingDimensions).toContain('uncertainty-semantics');
    }
  });

  it('hides the whole registry from the public without the amendment', () => {
    for (const model of models) {
      const result = evaluateGradePolicy(assessReviewedModel(model));
      expect(renderDisposition(result, 'anonymous')).toBe('hidden');
      expect(renderDisposition(result, 'anonymous', { publicTier: true })).toBe(
        'render-with-limitations',
      );
    }
  });

  it('does not take a "validated" claim at its word without a passing fixture', () => {
    const model = { ...findModel('cocaine')!, validationStatus: 'validated' as const };
    const claimed = evaluateGradePolicy(
      assessReviewedModel(model, { externallyValidated: false }),
    );
    // `validated` + no fixture is not an A on validation; it is not even B.
    expect(
      claimed.disclosable.some((d) => d.dimension === 'validation-status'),
    ).toBe(true);
  });

  it('escalates a route or analyte mismatch to a hard stop, not a low grade', () => {
    const result = evaluateGradePolicy(
      assessReviewedModel(findModel('cocaine')!, {
        routeOrAnalyteMismatch: true,
      }),
    );
    expect(result.grade).toBe('ungraded');
    expect(renderDisposition(result, 'admin', {
      acknowledged: true,
      publicTier: true,
    })).toBe('hidden');
  });

  it('scores an unvalidated matrix bridge as C and names the native matrix', () => {
    const assessments = assessReviewedModel(findModel('cocaine')!, {
      matrixBridgedWithoutValidation: true,
    });
    const matrix = assessments.find((a) => a.dimension === 'matrix-route-match')!;
    expect(matrix.grade).toBe('C');
    expect(matrix.reason).toContain('plasma');
    expect(matrix.reason).toContain('unvalidated');
  });

  it('reaches B once a reviewer attests and a fixture passes', () => {
    // The exit condition from Amendment 1, exercised: the tier stops applying.
    const result = evaluateGradePolicy(
      assessReviewedModel(findModel('cocaine')!, {
        reviewerAttested: true,
        externallyValidated: true,
        uncertaintyLayersSeparated: true,
      }),
    );
    expect(result.grade).toBe('B');
    expect(renderDisposition(result, 'anonymous')).toBe(
      'render-with-limitations',
    );
  });
});
