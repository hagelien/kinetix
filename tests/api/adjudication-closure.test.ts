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
