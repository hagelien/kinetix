import { describe, expect, it } from 'vitest';
import {
  dedupeMetaboliteLinks,
  hasMetabolismData,
  inferMetaboliteActivity,
  metaboliteLinkIdentity,
  normalizeMetabolismName,
} from './metabolism';
import type { DrugMetaboliteLink } from './metabolism';

function link(over: Partial<DrugMetaboliteLink> = {}): DrugMetaboliteLink {
  return {
    id: 1,
    parentDrugId: 100,
    metaboliteDrugId: null,
    metaboliteName: 'Metabolite',
    conversionFraction: null,
    activity: 'unknown',
    sortOrder: 0,
    evidenceNote: null,
    referenceIds: null,
    drug: null,
    ...over,
  };
}

const benzoylecgonine = {
  id: 7,
  slug: 'benzoylecgonin',
  names: { nb: 'benzoylecgonin', en: 'Benzoylecgonine' },
  pubchemCid: 2337,
};

describe('metabolism helpers', () => {
  it('normalizes names for seed-time metabolite matching', () => {
    expect(normalizeMetabolismName('  Norbuprenorphine  ')).toBe(
      'norbuprenorphine',
    );
  });

  it('infers explicit active/inactive annotations from legacy metabolite text', () => {
    expect(inferMetaboliteActivity('norcocaine which is active')).toBe(
      'active',
    );
    expect(inferMetaboliteActivity('an inactive metabolite')).toBe('inactive');
    expect(inferMetaboliteActivity('norketamine')).toBe('unknown');
  });

  it('identifies a link by the substance it resolves to, not its label', () => {
    expect(
      metaboliteLinkIdentity(
        link({ metaboliteName: 'Benzoylecgonine', drug: benzoylecgonine }),
      ),
    ).toBe(
      metaboliteLinkIdentity(
        link({ metaboliteName: 'benzoylecgonin', drug: benzoylecgonine }),
      ),
    );
    expect(metaboliteLinkIdentity(link({ metaboliteName: '  Norcocaine ' }))).toBe(
      metaboliteLinkIdentity(link({ metaboliteName: 'norcocaine' })),
    );
    expect(metaboliteLinkIdentity(link({ metaboliteName: 'Ecgonine' }))).not.toBe(
      metaboliteLinkIdentity(link({ metaboliteName: 'Ecgonine methyl ester' })),
    );
  });

  describe('dedupeMetaboliteLinks', () => {
    it('collapses two spellings of one linked substance and keeps what each carried', () => {
      const merged = dedupeMetaboliteLinks([
        link({
          id: 1,
          metaboliteDrugId: 7,
          metaboliteName: 'Benzoylecgonine',
          drug: benzoylecgonine,
          activity: 'inactive',
          referenceIds: [11],
          sortOrder: 0,
        }),
        link({
          id: 2,
          metaboliteDrugId: 7,
          metaboliteName: 'benzoylecgonin',
          drug: benzoylecgonine,
          activity: 'inactive',
          conversionFraction: { min: 0.3, median: null, max: 0.5 },
          evidenceNote: 'major urinary metabolite',
          referenceIds: [12],
          sortOrder: 1,
        }),
      ]);

      expect(merged).toHaveLength(1);
      // The survivor keeps its own row identity and label…
      expect(merged[0]!.id).toBe(1);
      expect(merged[0]!.metaboliteName).toBe('Benzoylecgonine');
      // …and absorbs everything only the second row held.
      expect(merged[0]!.conversionFraction).toEqual({
        min: 0.3,
        median: null,
        max: 0.5,
      });
      expect(merged[0]!.evidenceNote).toBe('major urinary metabolite');
      expect(merged[0]!.referenceIds).toEqual([11, 12]);
    });

    it('folds a free-text row into the linked row it spells in another locale', () => {
      // The live cocaine monograph: one row linked to the benzoylecgonine
      // monograph, one written as free text in Norwegian. Different strings,
      // different identities — but the sidebar renders both as the linked
      // drug's `nb` name, so they printed as the same line twice.
      const merged = dedupeMetaboliteLinks([
        link({
          id: 1,
          metaboliteDrugId: 7,
          metaboliteName: 'Benzoylecgonine',
          drug: benzoylecgonine,
          activity: 'unknown',
          sortOrder: 0,
        }),
        link({
          id: 2,
          metaboliteName: 'benzoylecgonin',
          activity: 'inactive',
          sortOrder: 1,
        }),
      ]);

      expect(merged).toHaveLength(1);
      expect(merged[0]!.drug).toEqual(benzoylecgonine);
      // 'unknown' is the absence of a claim, so the row that made one wins.
      expect(merged[0]!.activity).toBe('inactive');
    });

    it('resolves a free-text row that sorts ahead of its linked twin', () => {
      const merged = dedupeMetaboliteLinks([
        link({ id: 2, metaboliteName: 'Benzoylecgonine', sortOrder: 0 }),
        link({
          id: 1,
          metaboliteDrugId: 7,
          metaboliteName: 'benzoylecgonin',
          drug: benzoylecgonine,
          sortOrder: 1,
        }),
      ]);

      expect(merged).toHaveLength(1);
      // Position is the first row's, but the link is picked up so the entry
      // stays clickable through to the metabolite's monograph.
      expect(merged[0]!.id).toBe(2);
      expect(merged[0]!.metaboliteDrugId).toBe(7);
      expect(merged[0]!.drug).toEqual(benzoylecgonine);
    });

    it('takes a conversion range from one link, never a bound at a time', () => {
      const merged = dedupeMetaboliteLinks([
        link({
          id: 1,
          metaboliteDrugId: 7,
          metaboliteName: 'Benzoylecgonine',
          drug: benzoylecgonine,
          conversionFraction: { min: null, median: 0.8, max: null },
          sortOrder: 0,
        }),
        link({
          id: 2,
          metaboliteDrugId: 7,
          metaboliteName: 'benzoylecgonin',
          drug: benzoylecgonine,
          conversionFraction: { min: 0.2, median: null, max: 0.5 },
          sortOrder: 1,
        }),
      ]);

      // The three numbers are one quantity. Filled field by field this would
      // become min 0.2 / median 0.8 / max 0.5 — a median outside its own
      // bounds, which no write path can produce.
      expect(merged[0]!.conversionFraction).toEqual({
        min: null,
        median: 0.8,
        max: null,
      });
    });

    it('keeps two rows that contradict each other, however they are spelled', () => {
      // The merged list is what the metabolism editor loads, and a save from
      // it replaces the drug's links wholesale — so collapsing a disagreement
      // would make the dropped claim permanent without anyone seeing it. Both
      // rows survive; the monograph shows the disagreement (activity is
      // rendered) and a curator resolves it.
      const merged = dedupeMetaboliteLinks([
        link({
          id: 1,
          metaboliteDrugId: 7,
          metaboliteName: 'Benzoylecgonine',
          drug: benzoylecgonine,
          activity: 'inactive',
          sortOrder: 0,
        }),
        link({
          id: 2,
          metaboliteName: 'benzoylecgonin',
          activity: 'active',
          sortOrder: 1,
        }),
      ]);
      expect(merged.map((m) => m.id)).toEqual([1, 2]);
      expect(merged.map((m) => m.activity)).toEqual(['inactive', 'active']);
    });

    it('treats a differing conversion range or evidence note as a conflict too', () => {
      const ranges = dedupeMetaboliteLinks([
        link({
          id: 1,
          metaboliteDrugId: 7,
          drug: benzoylecgonine,
          conversionFraction: { min: null, median: 0.8, max: null },
        }),
        link({
          id: 2,
          metaboliteDrugId: 7,
          drug: benzoylecgonine,
          conversionFraction: { min: 0.2, median: null, max: 0.5 },
        }),
      ]);
      expect(ranges.map((m) => m.id)).toEqual([1, 2]);

      const notes = dedupeMetaboliteLinks([
        link({
          id: 1,
          metaboliteDrugId: 7,
          drug: benzoylecgonine,
          evidenceNote: 'major urinary metabolite',
        }),
        link({
          id: 2,
          metaboliteDrugId: 7,
          drug: benzoylecgonine,
          evidenceNote: 'minor pathway only',
        }),
      ]);
      expect(notes.map((m) => m.id)).toEqual([1, 2]);

      // An identical range on both is agreement, not conflict.
      const same = dedupeMetaboliteLinks([
        link({
          id: 1,
          metaboliteDrugId: 7,
          drug: benzoylecgonine,
          conversionFraction: { min: 0.2, median: null, max: 0.5 },
        }),
        link({
          id: 2,
          metaboliteDrugId: 7,
          drug: benzoylecgonine,
          conversionFraction: { min: 0.2, median: null, max: 0.5 },
          evidenceNote: 'adds a note, contradicts nothing',
        }),
      ]);
      expect(same).toHaveLength(1);
      expect(same[0]!.evidenceNote).toBe('adds a note, contradicts nothing');
    });

    it('merges nothing for a substance whose links disagree anywhere', () => {
      // Two contradictory rows plus a third that contradicts neither and
      // carries the only measurement and the only citation. Merged pairwise,
      // that third row lands in whichever branch came first — attributing its
      // number to a claim it never made — and a save from the editor, which
      // replaces the links wholesale, then deletes it along with that branch.
      const merged = dedupeMetaboliteLinks([
        link({
          id: 1,
          metaboliteDrugId: 7,
          drug: benzoylecgonine,
          activity: 'active',
          sortOrder: 0,
        }),
        link({
          id: 2,
          metaboliteDrugId: 7,
          drug: benzoylecgonine,
          activity: 'inactive',
          sortOrder: 1,
        }),
        link({
          id: 3,
          metaboliteDrugId: 7,
          drug: benzoylecgonine,
          conversionFraction: { min: null, median: 0.35, max: null },
          referenceIds: [99],
          sortOrder: 2,
        }),
      ]);

      expect(merged.map((m) => m.id)).toEqual([1, 2, 3]);
      expect(merged[0]!.conversionFraction).toBeNull();
      expect(merged[0]!.referenceIds).toBeNull();
      expect(merged[2]!.referenceIds).toEqual([99]);
    });

    it('leaves a free-text row alone when two linked drugs answer to its name', () => {
      // `drugs.names` has no cross-drug uniqueness, so one spelling can be one
      // drug's Norwegian name and another's English one. A free-text row
      // carrying it names neither in particular; resolving by position would
      // attach its measurement and citation to an arbitrary substance, and a
      // later full-replace save would make that permanent.
      const merged = dedupeMetaboliteLinks([
        link({
          id: 1,
          metaboliteDrugId: 7,
          metaboliteName: 'Norkokain',
          drug: {
            id: 7,
            slug: 'norkokain',
            names: { nb: 'Norkokain', en: 'Norcocaine' },
            pubchemCid: 1,
          },
          sortOrder: 0,
        }),
        link({
          id: 2,
          metaboliteDrugId: 9,
          metaboliteName: 'Norcocaine',
          drug: {
            id: 9,
            slug: 'annet-stoff',
            names: { nb: 'Norcocaine', en: 'Something else' },
            pubchemCid: 2,
          },
          sortOrder: 1,
        }),
        link({
          id: 3,
          metaboliteName: 'norcocaine',
          conversionFraction: { min: null, median: 0.05, max: null },
          referenceIds: [42],
          sortOrder: 2,
        }),
      ]);

      expect(merged.map((m) => m.id)).toEqual([1, 2, 3]);
      expect(merged[0]!.referenceIds).toBeNull();
      expect(merged[1]!.referenceIds).toBeNull();
      expect(merged[2]!.referenceIds).toEqual([42]);
    });

    it('treats a blank note as absent when merging, not as a note', () => {
      // The conflict test trims before deciding, so '' and a real note agree.
      // The merge has to read absence the same way, or it keeps the empty
      // string, drops the note, and still takes that row's citations — and the
      // editor's next save deletes the row the note came from.
      const merged = dedupeMetaboliteLinks([
        link({
          id: 1,
          metaboliteDrugId: 7,
          drug: benzoylecgonine,
          evidenceNote: '   ',
          sortOrder: 0,
        }),
        link({
          id: 2,
          metaboliteDrugId: 7,
          drug: benzoylecgonine,
          evidenceNote: 'major urinary metabolite',
          referenceIds: [12],
          sortOrder: 1,
        }),
      ]);

      expect(merged).toHaveLength(1);
      expect(merged[0]!.evidenceNote).toBe('major urinary metabolite');
      expect(merged[0]!.referenceIds).toEqual([12]);
    });

    it('keeps distinct substances and misspellings apart', () => {
      const merged = dedupeMetaboliteLinks([
        link({ id: 1, metaboliteName: 'Ecgonine' }),
        link({ id: 2, metaboliteName: 'Ecgonine methyl ester' }),
        // A typo is not something to merge on — silently folding it into its
        // neighbour would hide a data-entry error behind a correct-looking list.
        link({ id: 3, metaboliteName: 'Egconine methyl ester' }),
      ]);
      expect(merged.map((m) => m.id)).toEqual([1, 2, 3]);
    });

    it('never collapses precursors, which all name the drug being viewed', () => {
      // Read from the metabolite's side, `metaboliteDrugId` is the current
      // drug on every row and `metaboliteName` is its name; the parent is what
      // differs, and `drug` is what carries it.
      const merged = dedupeMetaboliteLinks([
        link({
          id: 1,
          parentDrugId: 10,
          metaboliteDrugId: 7,
          metaboliteName: 'benzoylecgonin',
          drug: { id: 10, slug: 'kokain', names: { nb: 'Kokain' }, pubchemCid: 446220 },
        }),
        link({
          id: 2,
          parentDrugId: 11,
          metaboliteDrugId: 7,
          metaboliteName: 'benzoylecgonin',
          drug: {
            id: 11,
            slug: 'kokaetylen',
            names: { nb: 'kokaetylen' },
            pubchemCid: 6720,
          },
        }),
      ]);
      expect(merged.map((m) => m.id)).toEqual([1, 2]);
    });
  });

  it('detects any populated metabolism subdivision', () => {
    expect(
      hasMetabolismData({
        routes: [],
        evidenceNote: null,
        metabolites: [],
        precursors: [],
      }),
    ).toBe(false);

    expect(
      hasMetabolismData({
        routes: [
          {
            id: 1,
            kind: 'enzyme',
            enzymeId: 5,
            enzyme: null,
            label: 'CYP3A4',
            fraction: null,
            note: null,
            referenceIds: null,
            sortOrder: 0,
          },
        ],
        evidenceNote: null,
        metabolites: [],
        precursors: [],
      }),
    ).toBe(true);
  });
});
