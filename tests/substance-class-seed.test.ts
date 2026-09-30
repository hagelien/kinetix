/**
 * Guards the analyte classification.
 *
 * It used to live in two places — this constant and the UPDATE statements in
 * migration 0097 — and the job here was keeping them from disagreeing. The
 * migration no longer carries data: a migration runs before the guarded build
 * is live, and it runs once, which is wrong for a list of scientific
 * judgements that has already had four entries withdrawn. Applying it is now
 * `scripts/backfill-substance-classes.ts`, which reads this constant directly.
 *
 * So there is nothing left to hold in sync, and what remains is the harder
 * question the sync check never asked: is each entry *correct*. Nothing here
 * can answer that — there is no data source to check "has anyone administered
 * this" against — so these assert the things that are checkable, and pin the
 * near-misses that have already fooled a reader.
 */
import { describe, expect, it } from 'vitest';
import { embeddedComponents } from '../data/components.js';
import {
  SUBSTANCE_CLASS_BY_PUBCHEM_CID,
  seededSubstanceClass,
} from '../data/substanceClasses.js';
import { planSubstanceClassChanges } from '../scripts/backfill-substance-classes.js';
import {
  isSubstanceClass,
  parametersRequiringAdministration,
  substanceIsAdministered,
} from '../src/lib/parameterApplicability.js';

describe('analyte classification', () => {
  it('names only classes the applicability rules understand', () => {
    for (const [cid, entry] of Object.entries(SUBSTANCE_CLASS_BY_PUBCHEM_CID)) {
      expect(isSubstanceClass(entry.substanceClass), `CID ${cid}`).toBe(true);
      // A row here that resolves as administered would be inert — it would
      // exclude nothing, which is a silent no-op rather than a visible error.
      expect(substanceIsAdministered(entry.substanceClass), `CID ${cid}`).toBe(
        false,
      );
    }
  });

  it.each([
    [441, 'beta-hydroxybutyrate', 'dosed as ketone salts and esters'],
    [446, 'hydroxybupropion', 'its (+)-enantiomer was trialled as radafaxine'],
    [854019, 'cotinine', 'given to humans in controlled dosing studies'],
    [
      125820,
      '3-hydroxyphenazepam',
      'sold as a designer benzodiazepine in its own right',
    ],
    [
      15135972,
      'alpha-hydroxyetizolam',
      'an active metabolite of an NPS parent, same market',
    ],
    [
      19865837,
      'alpha-hydroxyflualprazolam',
      'an active metabolite of an NPS parent, same market',
    ],
    [123767, 'norketamine', 'active, and the ketamine-metabolite market is live'],
    [5288826, 'morphine', 'a codeine metabolite that is also a marketed drug'],
    [4616, 'oxazepam', 'a diazepam metabolite that is also a marketed drug'],
  ])(
    'leaves CID %i (%s) administered — %s',
    (cid) => {
      // The bar is "never administered", not "the body makes it" and not "it is
      // a metabolite". Every substance here fails that bar in a way that reads
      // like it passes, and classifying one is not a spurious-gap-sized
      // mistake: it makes correct bioavailability and dose data
      // unwritable and hides those gaps from the queue permanently, with
      // nothing in the output saying why.
      // Assert the CID is real first: "not classified" passes vacuously for a
      // typo, which would make this guard silently stop guarding anything.
      expect(
        embeddedComponents.some((c) => c.pubchemCid === cid),
        `CID ${cid} is not in the catalog — fix the number, not the assertion`,
      ).toBe(true);
      expect(seededSubstanceClass(cid)).toBeUndefined();
    },
  );

  it('classifies substances the shipped catalog actually contains', () => {
    // A CID that matches nothing silently does nothing, in both the seeder and
    // the backfill script — a typo would look exactly like a working entry.
    const catalogCids = new Set(
      embeddedComponents
        .map((c) => c.pubchemCid)
        .filter((v): v is number => typeof v === 'number'),
    );
    for (const cid of Object.keys(SUBSTANCE_CLASS_BY_PUBCHEM_CID)) {
      expect(catalogCids.has(Number(cid)), `CID ${cid} not in the catalog`).toBe(
        true,
      );
    }
  });

  it('never classifies a substance whose fixture carries an administered value', () => {
    // Classifying one would create the exact contradiction the write guards
    // exist to prevent — a value served for a quantity declared undefined —
    // and the seeder would throw partway through. Better to fail here, where
    // the fix is to review the classification rather than debug a seed run.
    const atRisk = parametersRequiringAdministration();
    for (const component of embeddedComponents) {
      if (!seededSubstanceClass(component.pubchemCid)) continue;
      const conflicting = atRisk.filter(
        (p) => (component as Record<string, unknown>)[p] !== undefined,
      );
      expect(
        conflicting,
        `${component.nameEn ?? component.name} is classified as an analyte but the fixture gives it ${conflicting.join(', ')}`,
      ).toEqual([]);
    }
  });

  it('leaves unlisted and unknown substances at the default', () => {
    expect(seededSubstanceClass(undefined)).toBeUndefined();
    expect(seededSubstanceClass(2244)).toBeUndefined(); // aspirin, not listed
  });
});

describe('what the backfill script proposes to change', () => {
  const drug = (over: Partial<Parameters<typeof planSubstanceClassChanges>[0][number]>) => ({
    id: 1,
    slug: 'x',
    pubchemCid: null,
    substanceClass: 'drug',
    ...over,
  });

  it('classifies a listed substance still at the default', () => {
    expect(
      planSubstanceClassChanges([drug({ pubchemCid: 448223 })]),
    ).toEqual([
      { drug: drug({ pubchemCid: 448223 }), action: { kind: 'classify', to: 'metabolite' } },
    ]);
  });

  it('proposes nothing for a substance the list does not name', () => {
    expect(planSubstanceClassChanges([drug({ pubchemCid: 2244 })])).toEqual([]);
  });

  it('never reverts a class an editor already set', () => {
    // Insert-only is the rule the seeder follows for the same reason: a
    // reclassification is a scientific judgement, and a re-run must not undo
    // one. Reported, not changed.
    const row = drug({ pubchemCid: 448223, substanceClass: 'endogenous' });
    expect(planSubstanceClassChanges([row])).toEqual([
      { drug: row, action: { kind: 'already', current: 'endogenous' } },
    ]);
  });

  it('reports a classification the list has withdrawn', () => {
    // The case that made this a script: hydroxybupropion and three others were
    // classified before review found them administered. A database that ran
    // the old migration still holds those, and nothing else would ever say so.
    // Reported rather than reverted — from here it is indistinguishable from
    // an editor's deliberate call, and that one must survive.
    const row = drug({ pubchemCid: 446, substanceClass: 'metabolite' });
    expect(planSubstanceClassChanges([row])).toEqual([
      { drug: row, action: { kind: 'unlisted', current: 'metabolite' } },
    ]);
  });

  it('says nothing about an unlisted substance left at the default', () => {
    expect(
      planSubstanceClassChanges([drug({ pubchemCid: 446 })]),
    ).toEqual([]);
  });
});
