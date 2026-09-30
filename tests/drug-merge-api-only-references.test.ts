/**
 * `npm run merge:drugs` and the dose-context drug references (Codex P1 on
 * #1360). The admin merge repoints `administered_drug_id` and
 * `interacting_drug_id` with checks the script does not carry, so the script
 * must refuse a loser those columns name — and say where the merge can be
 * done, rather than a generic "teach me this table" that invites a naive
 * repoint.
 */
import { describe, expect, it } from 'vitest';
import { apiOnlyRefusal } from '../scripts/drug-merge/api-only-references';

describe('apiOnlyRefusal', () => {
  it.each(['administered_drug_id', 'interacting_drug_id', 'drug_id'])(
    'refuses parameter_entries.%s and points at the admin merge',
    (column) => {
      const reason = apiOnlyRefusal([{ table: 'parameter_entries', column, rows: 2 }]);
      expect(reason).toMatch(/admin merge/);
      expect(reason).toMatch(/\(2\)/);
    },
  );

  it('says nothing about references it does not own', () => {
    expect(apiOnlyRefusal([{ table: 'drug_parameters', column: 'drug_id', rows: 3 }])).toBeNull();
    expect(apiOnlyRefusal([])).toBeNull();
  });
});
