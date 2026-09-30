/**
 * The `parameters` bag on a new monograph (`POST /api/wiki/pages`, and the
 * `wiki_new` pending edit it queues) turns into drug-parameter revisions on
 * approval. It is therefore held to the same rules as `/api/drug-parameter` —
 * "page authoring must not be a way around what /api/drug-parameter would
 * refuse" (docs/permissions.md) — and that now includes the source-value rule.
 *
 * The bag carries one number per parameter under one shared citation, which is
 * exactly the shape a summarizable parameter cannot use: no per-paper
 * provenance, nothing to pool, nothing for the plot to show.
 */
import { describe, expect, it } from 'vitest';
import { validateParameterBag } from '../../../api/_lib/drugs-helpers.js';

describe('validateParameterBag — source-value-backed parameters', () => {
  it('refuses an authored value for a summarizable parameter', () => {
    expect(() =>
      validateParameterBag({ halfLife: { min: 1, max: 4, unit: 'h' } }),
    ).toThrow(/source values/i);
  });

  it('names the endpoint that does accept the reading', () => {
    expect(() =>
      validateParameterBag({
        therapeuticConcentration: { min: 10, max: 20, unit: 'ng/mL' },
      }),
    ).toThrow(/\/api\/parameter-entries/);
  });

  it('accepts analyte stability, which is authored per matrix', () => {
    expect(
      validateParameterBag({ analyteStability: { min: 1, max: 2, unit: 'h' } }),
    ).toEqual([
      { id: 'analyteStability', value: { min: 1, max: 2, unit: 'h' } },
    ]);
  });

  it('still ignores the empty placeholders the editor sends for untouched rows', () => {
    // Checked with a summarizable id: an untouched row must not become a
    // refusal, or every new monograph carrying the editor's blank grid fails.
    expect(validateParameterBag({ halfLife: {}, volumeOfDistribution: null })).toEqual(
      [],
    );
  });
});
