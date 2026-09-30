import { describe, expect, it } from 'vitest';
import {
  CITATION_ADMISSIBLE_WORK_KINDS,
  CITATION_WORK_KINDS,
  PUBLISHED_WORK_COUNTERPART,
  CROSSREF_WORK_TYPE_KINDS,
  DATACITE_RESOURCE_TYPE_KINDS,
  PUBMED_PUBLICATION_TYPE_KINDS,
  classificationCoversHandles,
  isAdmissibleCitationWorkKind,
  classificationHandles,
  classifyFromVerdicts,
  mergeStoredClassifications,
  workKindFromCrossrefType,
  workKindFromDataCiteType,
  workKindFromPubMedTypes,
} from './citationWorkKind.js';
import type { PublishedWorkKind } from './pattern/publishedWorks.js';

describe('provider vocabularies', () => {
  it('maps every table entry to a canonical kind', () => {
    const tables = [
      CROSSREF_WORK_TYPE_KINDS,
      PUBMED_PUBLICATION_TYPE_KINDS,
      DATACITE_RESOURCE_TYPE_KINDS,
    ];
    for (const table of tables) {
      for (const [term, kind] of Object.entries(table)) {
        expect(CITATION_WORK_KINDS, `${term} → ${kind}`).toContain(kind);
      }
    }
  });

  it('keys every table by its lower-cased term, so lookups cannot miss on case', () => {
    const tables = [
      CROSSREF_WORK_TYPE_KINDS,
      PUBMED_PUBLICATION_TYPE_KINDS,
      DATACITE_RESOURCE_TYPE_KINDS,
    ];
    for (const table of tables) {
      for (const term of Object.keys(table)) {
        expect(term).toBe(term.toLowerCase());
      }
    }
  });
});

describe('workKindFromCrossrefType', () => {
  it('reads the ordinary article', () => {
    expect(workKindFromCrossrefType('journal-article')).toBe('journal_article');
  });

  it('reads a dataset as a dataset — the case the gate exists for', () => {
    expect(workKindFromCrossrefType('dataset')).toBe('dataset');
    expect(workKindFromCrossrefType('database')).toBe('database');
  });

  it('files a container as other, not as the works it contains', () => {
    expect(workKindFromCrossrefType('journal')).toBe('other');
    expect(workKindFromCrossrefType('proceedings')).toBe('other');
    expect(workKindFromCrossrefType('book-series')).toBe('other');
  });

  it('treats an unmapped type as an answer, not as an unasked question', () => {
    // Crossref told us what this is; we have no finer kind for it. That is
    // different from nobody having asked, and only the second one should send
    // the row back to the registry.
    expect(workKindFromCrossrefType('a-type-crossref-added-later')).toBe('other');
  });

  it('has no answer when there is no type at all', () => {
    expect(workKindFromCrossrefType(null)).toBeNull();
    expect(workKindFromCrossrefType('   ')).toBeNull();
  });

  it('ignores case and surrounding space', () => {
    expect(workKindFromCrossrefType('  Journal-Article ')).toBe('journal_article');
  });
});

describe('workKindFromPubMedTypes', () => {
  it('reads the object kind and ignores the study design beside it', () => {
    expect(
      workKindFromPubMedTypes([
        'Journal Article',
        'Randomized Controlled Trial',
        'Research Support, Non-U.S. Gov’t',
      ]),
    ).toBe('journal_article');
  });

  it('keeps letters and case reports, which is most of the forensic literature', () => {
    expect(workKindFromPubMedTypes(['Letter'])).toBe('journal_article');
    expect(workKindFromPubMedTypes(['Case Reports', 'Journal Article'])).toBe(
      'journal_article',
    );
  });

  it('has no answer when the array names only study design', () => {
    // Not `other`: PubMed answered with a list that never states the object's
    // kind, which is a gap. Calling it an answer would settle a question the
    // registry did not address.
    expect(workKindFromPubMedTypes(['Review', 'English Abstract'])).toBeNull();
    expect(workKindFromPubMedTypes([])).toBeNull();
    expect(workKindFromPubMedTypes(null)).toBeNull();
  });

  it('prefers the more specific object kind when one list names two', () => {
    expect(workKindFromPubMedTypes(['Book', 'Book Chapter'])).toBe('book_chapter');
  });
});

describe('workKindFromDataCiteType', () => {
  it('answers for the DOIs Crossref has never heard of', () => {
    expect(workKindFromDataCiteType('Dataset')).toBe('dataset');
    expect(workKindFromDataCiteType('JournalArticle')).toBe('journal_article');
  });

  it('does not read the catch-all text type as a publication', () => {
    expect(workKindFromDataCiteType('Text')).toBe('other');
    expect(workKindFromDataCiteType('Software')).toBe('other');
  });
});

describe('classifyFromVerdicts', () => {
  it('is unresolved when no handle answered', () => {
    expect(classifyFromVerdicts([])).toEqual({
      status: 'unresolved',
      kind: null,
      verdicts: [],
    });
  });

  it('resolves when the answers agree', () => {
    const result = classifyFromVerdicts([
      { handle: 'pmid:1', kind: 'journal_article' },
      { handle: 'doi:10.1/x', kind: 'journal_article' },
    ]);
    expect(result.status).toBe('resolved');
    expect(result.kind).toBe('journal_article');
  });

  it('conflicts when two registries disagree, keeping both verdicts', () => {
    const result = classifyFromVerdicts([
      { handle: 'pmid:1', kind: 'journal_article' },
      { handle: 'doi:10.1/x', kind: 'dataset' },
    ]);
    expect(result.status).toBe('conflicted');
    expect(result.kind).toBeNull();
    // Retained, not cleared: the disagreement is the evidence, and a merge or a
    // patch that lost it would let the more permissive verdict stand alone.
    expect(result.verdicts).toHaveLength(2);
  });
});

describe('classificationHandles', () => {
  it("collects the row's own handle and its alt ids", () => {
    expect(
      classificationHandles({
        type: 'pmid',
        identifier: '29462364',
        altIds: { doi: '10.1234/abc' },
      }),
    ).toEqual(['doi:10.1234/abc', 'pmid:29462364']);
  });

  it('sees through a resolver URL, which is a DOI wearing a coat', () => {
    expect(
      classificationHandles({
        type: 'url',
        identifier: 'https://doi.org/10.1234/ABC',
        altIds: null,
      }),
    ).toEqual(['doi:10.1234/abc']);
  });

  it('leaves out handles no registry is asked about', () => {
    // A PMC id names the same article its PMID does, and a plain URL identifies
    // no object any registry knows. Counting either would leave the row
    // permanently short of its own handle set — re-resolving on every read and
    // never becoming current.
    expect(
      classificationHandles({
        type: 'url',
        identifier: 'https://example.org/report.pdf',
        altIds: { pmcid: 'PMC123456' },
      }),
    ).toEqual([]);
    expect(
      classificationHandles({ type: 'freetext', identifier: 'Smith 1999' }),
    ).toEqual([]);
  });

  it('normalizes before comparing, so one handle cannot look like two', () => {
    expect(
      classificationHandles({
        type: 'doi',
        identifier: 'https://doi.org/10.1234/ABC',
        altIds: { doi: '10.1234/abc' },
      }),
    ).toEqual(['doi:10.1234/abc']);
  });
});

describe('classificationCoversHandles', () => {
  it('stands while every current handle was examined', () => {
    expect(
      classificationCoversHandles(['doi:10.1/x', 'pmid:1'], ['doi:10.1/x', 'pmid:1']),
    ).toBe(true);
  });

  it('expires when a handle appears', () => {
    // A PMID row classified as an article quietly acquires a DOI that resolves
    // to a dataset. Nothing about the earlier answer covers the new handle.
    expect(classificationCoversHandles(['pmid:1'], ['doi:10.1/x', 'pmid:1'])).toBe(
      false,
    );
  });

  it('survives a handle disappearing', () => {
    // The asymmetry §13.3 requires. Were removal to expire the verdict, a PATCH
    // dropping the DOI would re-open the question, the re-resolve would consult
    // only the surviving PMID, hear "journal article", and admit the cohort —
    // the evidence against it deleted by deleting the handle that produced it.
    expect(classificationCoversHandles(['doi:10.1/x', 'pmid:1'], ['pmid:1'])).toBe(
      true,
    );
  });

  it('never stands when nothing was examined', () => {
    expect(classificationCoversHandles(null, [])).toBe(false);
  });
});

describe('mergeStoredClassifications', () => {
  it("keeps the loser's verdict when the winner was never asked", () => {
    const merged = mergeStoredClassifications(
      { handles: null, verdicts: null },
      {
        handles: ['doi:10.1/x'],
        verdicts: [{ handle: 'doi:10.1/x', kind: 'dataset' }],
      },
    );
    expect(merged.status).toBe('resolved');
    expect(merged.kind).toBe('dataset');
    expect(merged.handles).toEqual(['doi:10.1/x']);
  });

  it('surfaces a disagreement between the folded rows as a conflict', () => {
    const merged = mergeStoredClassifications(
      {
        handles: ['pmid:1'],
        verdicts: [{ handle: 'pmid:1', kind: 'journal_article' }],
      },
      {
        handles: ['doi:10.1/x'],
        verdicts: [{ handle: 'doi:10.1/x', kind: 'dataset' }],
      },
    );
    expect(merged.status).toBe('conflicted');
    expect(merged.kind).toBeNull();
    expect(merged.handles).toEqual(['doi:10.1/x', 'pmid:1']);
  });

  it('treats two answers for one handle as one registry asked twice', () => {
    // Not a conflict: `conflicted` means two registries disagree about the
    // object, and the same handle answering differently at two times is not
    // that. The surviving row's answer is kept.
    const merged = mergeStoredClassifications(
      {
        handles: ['doi:10.1/x'],
        verdicts: [{ handle: 'doi:10.1/x', kind: 'journal_article' }],
      },
      {
        handles: ['doi:10.1/x'],
        verdicts: [{ handle: 'doi:10.1/x', kind: 'preprint' }],
      },
    );
    expect(merged.status).toBe('resolved');
    expect(merged.kind).toBe('journal_article');
  });

  it('stores no examined set when neither side had an answer', () => {
    const merged = mergeStoredClassifications(
      { handles: null, verdicts: null },
      { handles: null, verdicts: null },
    );
    expect(merged.status).toBe('unresolved');
    expect(merged.handles).toEqual([]);
  });
});

/**
 * `PUBLISHED_KINDS` is private to `publishedWorks.ts`, and exporting it to
 * satisfy a test would widen that module's surface for the test's convenience.
 * Restated here instead, which is safe because the file it mirrors is a short
 * literal a diff would show — and because the assertion below fails loudly if
 * the two ever part company on a kind this list admits.
 */
const PUBLISHED_KINDS_FOR_TEST = new Set<PublishedWorkKind>([
  'journal_article',
  'book',
  'official_guideline',
]);

describe('which kinds may back a reference cohort', () => {
  it('admits only canonical kinds', () => {
    for (const kind of CITATION_ADMISSIBLE_WORK_KINDS) {
      expect(CITATION_WORK_KINDS).toContain(kind);
    }
  });

  it('refuses the objects the decision was written about', () => {
    expect(isAdmissibleCitationWorkKind('dataset')).toBe(false);
    expect(isAdmissibleCitationWorkKind('database')).toBe(false);
    expect(isAdmissibleCitationWorkKind('peer_review')).toBe(false);
    expect(isAdmissibleCitationWorkKind('component')).toBe(false);
  });

  it('refuses a kind nobody wrote a rule about', () => {
    // `other` covers containers and anything a registry adds after this list
    // was written. Refused by default, rather than admitted by matching no
    // refusal — the failure mode a vocabulary check exists to close.
    expect(isAdmissibleCitationWorkKind('other')).toBe(false);
    expect(isAdmissibleCitationWorkKind(null)).toBe(false);
  });

  it('never admits a kind the registries\' own gate excludes', () => {
    // The relation, not the list. `publishedWorks.ts` already answers the
    // published-sources decision for the registries, and its header says this
    // store replaces it without the question changing — so a kind failing that
    // gate must not back reference data through this one. Asserted one way
    // only: being stricter here is allowed, and `report` is.
    for (const [kind, counterpart] of Object.entries(PUBLISHED_WORK_COUNTERPART)) {
      if (PUBLISHED_KINDS_FOR_TEST.has(counterpart!)) continue;
      expect(
        isAdmissibleCitationWorkKind(kind as never),
        `${kind} → ${counterpart}`,
      ).toBe(false);
    }
  });

  it('refuses the kinds one canonical name cannot separate', () => {
    // `report` covers a published guideline and an institution's write-up of
    // its own casework alike, and the second is materially the declined route.
    // A preprint is published but unreviewed; a dissertation is a thesis; a
    // proceedings paper is the nearest thing there is to a conference abstract.
    expect(isAdmissibleCitationWorkKind('report')).toBe(false);
    expect(isAdmissibleCitationWorkKind('preprint')).toBe(false);
    expect(isAdmissibleCitationWorkKind('dissertation')).toBe(false);
    expect(isAdmissibleCitationWorkKind('conference_paper')).toBe(false);
  });

  it('admits the ordinary literature this atlas is built from', () => {
    expect(isAdmissibleCitationWorkKind('journal_article')).toBe(true);
    expect(isAdmissibleCitationWorkKind('book_chapter')).toBe(true);
  });
});
