import { describe, expect, it } from 'vitest';
import {
  updateDrugParameterSchema,
  updatePageSchema,
} from '../../api/_lib/schemas.js';
import {
  CACHE_REVISION_CLEARED_CODE,
  CACHE_REVISION_RECOMPUTED_CODE,
} from '../../api/_lib/cache-revision-codes.js';

describe('reserved aggregate-cache edit-summary prefix', () => {
  it.each([
    `${CACHE_REVISION_RECOMPUTED_CODE}:3`,
    CACHE_REVISION_CLEARED_CODE,
    `  AUTO:param_entries_recomputed:3`,
  ])('rejects %j on a parameter edit', (editSummary) => {
    const r = updateDrugParameterSchema.safeParse({ value: 1, editSummary });
    expect(r.success).toBe(false);
  });

  it('rejects the prefix on a page update too', () => {
    expect(
      updatePageSchema.safeParse({ editSummary: 'auto:param_entries_x' }).success,
    ).toBe(false);
  });

  it('still accepts ordinary summaries', () => {
    expect(
      updateDrugParameterSchema.safeParse({ value: 1, editSummary: 'auto-corrected typo' })
        .success,
    ).toBe(true);
    expect(updateDrugParameterSchema.safeParse({ value: 1 }).success).toBe(true);
  });
});
