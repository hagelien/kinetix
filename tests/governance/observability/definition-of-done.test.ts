/**
 * §26: the definition of done, as an audit.
 *
 * §26 says the extraction is complete *only when all of the following are
 * true*, and lists twenty-seven criteria. The value of automating it is not the
 * green cases — it is that the audit cannot be talked into a pass.
 *
 * Four properties carry it, and three are about refusing:
 *
 *  1. A criterion whose truth is a fact about the world is never reported as
 *     holding just because nothing contradicted it.
 *  2. An empty scan is not a clean scan.
 *  3. Signing off does not extend to criteria the audit actually checks.
 *  4. `isComplete` means every criterion, attestations included.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  attestationCriteria,
  definitionOfDone,
  describeDefinitionOfDone,
} from '../../../api/_lib/knowledge-governance/definition-of-done.js';
import {
  invalidateMigrationStateCache,
  setMigrationMode,
} from '../../../api/_lib/knowledge-governance/migration-state.js';
import { applyAuthorityKey } from '../../../api/_lib/knowledge-governance/cutover.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from '../../integration/setup/harness.js';

let db: IntegrationDb;

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  invalidateMigrationStateCache();
});

describe('the audit covers §26', () => {
  it('reports criteria in all four groups', async () => {
    const report = await definitionOfDone({ db });
    const groups = new Set(report.criteria.map((c) => c.group));
    expect([...groups].sort()).toEqual([
      'integrity',
      'kinetix_functionality',
      'operational_safety',
      'reusability',
    ]);
  });

  it('gives every criterion a unique id', async () => {
    const report = await definitionOfDone({ db });
    const ids = report.criteria.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('explains every criterion that does not hold', async () => {
    // A criterion reported as failing without saying what would establish it
    // is a criterion nobody can act on.
    const report = await definitionOfDone({ db });
    for (const criterion of report.criteria) {
      if (criterion.status === 'holds') continue;
      expect(criterion.evidence.length, criterion.id).toBeGreaterThan(20);
    }
  });
});

describe('it refuses to report what it cannot check', () => {
  it('never reports a world-fact criterion as holding on its own', async () => {
    // "Kinetix functionality works as before" is not something a test suite can
    // assert — a green suite means the tests pass. Reporting it as holding
    // because nothing contradicted it would be the audit lying by omission.
    const report = await definitionOfDone({ db });
    for (const criterion of attestationCriteria()) {
      const found = report.criteria.find((c) => c.id === criterion.id)!;
      expect(found.status, criterion.id).toBe('attestation_required');
    }
  });

  it('does not report an attestation criterion as failing either', async () => {
    // Equally wrong in the other direction: nothing is known to be broken.
    const report = await definitionOfDone({ db });
    const ids = new Set(attestationCriteria().map((c) => c.id));
    for (const criterion of report.criteria) {
      if (ids.has(criterion.id)) expect(criterion.status).not.toBe('fails');
    }
  });

  it('distinguishes an empty scan from a clean one', async () => {
    // The same failure as a mirror success rate of 1 over zero attempts: an
    // empty scan and a clean scan produce the same divergence count and are
    // not the same claim.
    const report = await definitionOfDone({ db });
    const clean = report.criteria.find((c) => c.id === 'safety.reconciliation_clean')!;
    expect(clean.status).toBe('not_yet');
  });

  it('marks migration-dependent criteria not_yet while nothing is cut over', async () => {
    // Legitimately incomplete rather than defective: nothing has been advanced,
    // so "rollback procedures were exercised during migration" cannot be true.
    const report = await definitionOfDone({ db });
    for (const id of ['safety.rollback_exercised', 'safety.complete_native_history']) {
      expect(report.criteria.find((c) => c.id === id)!.status, id).toBe('not_yet');
    }
  });

  it('moves those to holding once a target is authoritative', async () => {
    // The positive control: the not_yet is a statement about the migration's
    // stage, not a criterion that can never pass.
    await setMigrationMode({
      targetType: applyAuthorityKey('wiki_fact'),
      mode: 'generic_authoritative',
      updatedBy: 1,
    });
    invalidateMigrationStateCache();
    const report = await definitionOfDone({ db });
    expect(
      report.criteria.find((c) => c.id === 'safety.rollback_exercised')!.status,
    ).toBe('holds');
  });
});

describe('attestation is a deliberate act', () => {
  it('accepts a signed-off criterion', async () => {
    const report = await definitionOfDone({
      db,
      attested: ['functionality.unchanged'],
    });
    expect(
      report.criteria.find((c) => c.id === 'functionality.unchanged')!.status,
    ).toBe('holds');
  });

  it('ignores a signature on a criterion the audit checks itself', async () => {
    // Otherwise signing off would be a way to override a `fails` — which is
    // exactly what an audit must not offer.
    const report = await definitionOfDone({
      db,
      attested: ['safety.reconciliation_clean'],
    });
    expect(
      report.criteria.find((c) => c.id === 'safety.reconciliation_clean')!.status,
    ).toBe('not_yet');
  });

  it('is not complete while anything awaits attestation', async () => {
    const report = await definitionOfDone({ db });
    expect(report.byStatus.attestation_required).toBeGreaterThan(0);
    expect(report.isComplete).toBe(false);
  });

  it('is not complete while anything is not_yet, even fully attested', async () => {
    // The migration is genuinely unfinished, and signing every world-fact
    // criterion does not make it finished.
    const report = await definitionOfDone({
      db,
      attested: attestationCriteria().map((c) => c.id),
    });
    expect(report.byStatus.attestation_required).toBe(0);
    expect(report.byStatus.not_yet).toBeGreaterThan(0);
    expect(report.isComplete).toBe(false);
  });
});

describe('the rendered audit', () => {
  it('says plainly that the extraction is not complete', async () => {
    const report = await definitionOfDone({ db });
    const text = describeDefinitionOfDone(report);
    expect(text).toContain('NOT COMPLETE');
    expect(text).toContain('awaiting attestation');
  });

  it('groups criteria the way §26 groups them', async () => {
    const text = describeDefinitionOfDone(await definitionOfDone({ db }));
    for (const heading of [
      'Kinetix functionality',
      'Integrity',
      'Reusability',
      'Operational safety',
    ]) {
      expect(text).toContain(heading);
    }
  });

  it('shows the evidence line only where something is outstanding', async () => {
    const report = await definitionOfDone({ db });
    const text = describeDefinitionOfDone(report);
    const holding = report.criteria.find((c) => c.status === 'holds')!;
    expect(text).toContain(holding.text);
    expect(text).not.toContain(holding.evidence);
  });
});
