import { describe, expect, it, vi } from 'vitest';

// The closure module's other exports reach the database; the decision under
// test is pure and never does.
vi.mock('../../api/_lib/db.js', () => ({ getDb: vi.fn(), inTransaction: vi.fn() }));

import { closureDeclineReason } from '../../api/_lib/adjudication/closure';
import type { AdjudicationRecommendation } from '../../db/schema';

const recommend = (resolution: AdjudicationRecommendation['resolution']): AdjudicationRecommendation => ({
  resolution,
  scopeKey: {},
  value: null,
  opinionIds: [1, 2],
});

describe('T3 closure: what it will not act on', () => {
  it('hands an upheld objection on anything but a pending edit to a person', () => {
    for (const targetType of ['wiki_revision', 'drug_parameter_revision', 'paper_review', 'drug_discussion']) {
      expect(closureDeclineReason(recommend('return'), null, targetType)).toBe('no_disposition');
      expect(closureDeclineReason(recommend('dispute'), null, targetType)).toBe('no_disposition');
    }
  });

  it('still overrules on a non-pending target, and upholds on a pending edit', () => {
    expect(closureDeclineReason(recommend('approve'), null, 'wiki_revision')).toBeNull();
    expect(closureDeclineReason(recommend('return'), null, 'pending_edit')).toBeNull();
  });

  it('hands a split scope to a person', () => {
    expect(closureDeclineReason(recommend('split_scope'), null, 'pending_edit')).toBe('split_scope');
  });
});

describe('T3 closure: reading the proposal’s own value', () => {
  it('reads a stored entry’s numeric columns, which come back as strings (#108)', () => {
    const bound = {
      served: {
        targetType: 'pending_edit',
        payload: {
          editType: 'param_entry',
          parameter: 'clearance',
          proposedValue: { op: 'update', patch: { quote: 'Restated.' } },
          currentEntry: { low: '40', high: '80', median: '60', unit: 'L/h' },
        },
      },
      sourceRow: null,
      comparison: { canonicalUnit: 'L/h', molecularWeight: null },
      decidedDisputes: [],
      lowerTier: { t2Verdicts: [], t1Verdicts: [], openDisputes: [] },
      context: { triggers: [], triggerDetail: {}, disputeOrigin: 'agent' as const },
    };
    const approve = (value: NonNullable<AdjudicationRecommendation['value']>) => ({
      ...recommend('approve'),
      value,
    });
    expect(
      closureDeclineReason(approve({ kind: 'range', low: 40, high: 80, unit: 'L/h' }), bound, 'pending_edit'),
    ).toBeNull();
    expect(
      closureDeclineReason(approve({ kind: 'range', low: 40, high: 90, unit: 'L/h' }), bound, 'pending_edit'),
    ).toBe('value_differs');
  });
});
