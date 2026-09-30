import { describe, expect, it } from 'vitest';

// Importing the script must not hit the database — `main()` only runs behind
// the `isDirectRun` guard at the bottom of the file, so evaluating its module
// scope (including this import) never opens a connection or reads
// DATABASE_URL.
import {
  classifyCaseDrugKey,
  resolveCollidingDrug,
} from '../../scripts/fix-simulator-case-drug-keys';
import type { NamedRow } from '../../scripts/pubchem/names';

const cidLessDrug: NamedRow = {
  names: { nb: 'Skyggerad', en: 'Shadow Drug' },
  aliases: [],
  nameShort: null,
};

const collidingDrug: NamedRow = {
  names: { nb: 'Navnebror', en: 'Namesake' },
  aliases: ['Alias For Namesake'],
  nameShort: null,
};

describe('classifyCaseDrugKey', () => {
  it('rewrites when there is no current collision and the saved name names the target', () => {
    expect(classifyCaseDrugKey('Shadow Drug', cidLessDrug, null)).toBe('rewrite');
    // Folded name matching bridges NO/EN orthography, same as the audit tool.
    expect(classifyCaseDrugKey('Skyggerad', cidLessDrug, null)).toBe('rewrite');
  });

  it('reports a conflict with no current collision when the saved name does NOT name the target', () => {
    // The number can be a FORMER CID some other, now-unrelated drug used to
    // hold — an ordinary `PUT /api/drugs` edit moves a drug's CID without
    // touching simulator_cases, so no collision survives to flag it. Absent
    // a current collision to compare against, an unmatched name must still
    // block the rewrite rather than being waved through.
    expect(
      classifyCaseDrugKey('Some Other Substance Entirely', cidLessDrug, null),
    ).toBe('conflict');
  });

  it('reports a conflict when there is no current collision and no stored name at all', () => {
    expect(classifyCaseDrugKey(undefined, cidLessDrug, null)).toBe('conflict');
  });

  it('rewrites when a collision exists but the saved name names the CID-less drug', () => {
    expect(classifyCaseDrugKey('Skyggerad', cidLessDrug, collidingDrug)).toBe(
      'rewrite',
    );
    // Folded name matching bridges NO/EN orthography, same as the audit tool.
    expect(classifyCaseDrugKey('Shadow Drug', cidLessDrug, collidingDrug)).toBe(
      'rewrite',
    );
  });

  it('leaves the entry alone when the saved name names the colliding drug instead', () => {
    expect(classifyCaseDrugKey('Navnebror', cidLessDrug, collidingDrug)).toBe(
      'skip',
    );
    expect(
      classifyCaseDrugKey('Alias For Namesake', cidLessDrug, collidingDrug),
    ).toBe('skip');
  });

  it('reports a conflict when there is a collision and no stored name to decide with', () => {
    expect(classifyCaseDrugKey(undefined, cidLessDrug, collidingDrug)).toBe(
      'conflict',
    );
  });

  it('reports a conflict when the stored name matches neither candidate', () => {
    expect(
      classifyCaseDrugKey('Something Else Entirely', cidLessDrug, collidingDrug),
    ).toBe('conflict');
  });

  it('reports a conflict when the stored name matches both candidates', () => {
    // Constructed case: same name recorded on both drugs. Nothing in the
    // saved case can pick one over the other, so escalate rather than guess.
    const sameNameBothWays: NamedRow = { ...cidLessDrug, names: collidingDrug.names };
    expect(
      classifyCaseDrugKey('Navnebror', sameNameBothWays, collidingDrug),
    ).toBe('conflict');
  });

  it('does not depend on whether the target drug currently has its own CID', () => {
    // #1256 item 6 follow-up: a drug can gain a CID long after a case was
    // saved under its old bare internal id (a data-enrichment backfill, not
    // necessarily retarget-pubchem-cid.ts). The collision that matters is
    // whether some OTHER drug holds the OLD number today, never what the
    // target drug's own CID now is — classifyCaseDrugKey must reach the same
    // verdict either way.
    const targetNowWithOwnCid: NamedRow & { pubchemCid: number } = {
      ...cidLessDrug,
      pubchemCid: 999999,
    };
    expect(
      classifyCaseDrugKey('Shadow Drug', targetNowWithOwnCid, collidingDrug),
    ).toBe('rewrite');
    expect(
      classifyCaseDrugKey('Navnebror', targetNowWithOwnCid, collidingDrug),
    ).toBe('skip');
  });
});

describe('resolveCollidingDrug', () => {
  const target = { id: 803 };

  it('returns the other drug when it holds the number as its own CID', () => {
    const other = { id: 42 };
    expect(resolveCollidingDrug(target, other)).toBe(other);
  });

  it('returns null when no drug holds the number as a CID', () => {
    expect(resolveCollidingDrug(target, null)).toBeNull();
  });

  it('excludes the target itself — its own CID equalling its own id is not a collision', () => {
    const selfHit = { id: 803 };
    expect(resolveCollidingDrug(target, selfHit)).toBeNull();
  });
});
