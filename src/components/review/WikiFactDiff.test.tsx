import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WikiFactDiff } from './WikiFactDiff';
import type { ReferenceRow } from '@/lib/referenceApi';
import type { PendingEditRow } from '@/lib/pendingEditsApi';

// Repo convention (see ParameterDiff.test): a passthrough `t` so assertions can
// target translation keys directly.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'nb' },
  }),
}));

function ref(id: number, readInFull?: boolean): ReferenceRow {
  return {
    id,
    // Omitted entirely when unspecified: an older payload does not report it,
    // and undefined must not read as "unread".
    ...(readInFull === undefined ? {} : { readInFull }),
    drugId: 1,
    type: 'pmid',
    identifier: String(1000 + id),
    metadata: {
      title: `Paper ${id}`,
      authors: [`Author${id}`],
      journal: 'J',
      year: 2020,
      volume: null,
      pages: null,
    },
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function edit(over: Partial<PendingEditRow> = {}): PendingEditRow {
  return {
    id: 1,
    editType: 'wiki_fact',
    targetId: 9,
    sectionId: 'forensic',
    fieldId: null,
    factOperation: 'add',
    factStatement: 'Én atomær påstand.',
    factTargetAnchor: null,
    proposedValue: {},
    proposedMeta: null,
    references: [ref(1, true), ref(2, false)],
    ...over,
  } as unknown as PendingEditRow;
}

describe('WikiFactDiff — an unverified claim from conversation ingestion', () => {
  it('says the claim is unverified and marks the paper nobody read', () => {
    render(
      <WikiFactDiff
        edit={edit({
          proposedMeta: { source: 'conversation-ingestion' },
        })}
      />,
    );

    expect(screen.getByText('review.factUnverifiedSource')).toBeInTheDocument();
    // Exactly one of the two references is marked: marking both, or neither,
    // would leave the reviewer guessing which paper to open.
    expect(screen.getAllByText('review.factReferenceNotRead')).toHaveLength(1);
  });

  it('says nothing on an ordinary fact, which is every other write path', () => {
    render(<WikiFactDiff edit={edit()} />);

    expect(
      screen.queryByText('review.factUnverifiedSource'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('review.factReferenceNotRead'),
    ).not.toBeInTheDocument();
  });

  it('says nothing when the payload does not report review state', () => {
    // An older payload omits `readInFull` entirely. Unknown is not a claim that
    // the paper is unread, so the card stays quiet rather than guessing.
    render(
      <WikiFactDiff
        edit={edit({
          proposedMeta: { source: 'conversation-ingestion' },
          references: [ref(1), ref(2)],
        })}
      />,
    );

    expect(
      screen.queryByText('review.factUnverifiedSource'),
    ).not.toBeInTheDocument();
  });

  it('still warns when the paper carries someone else\'s read-in-full review', () => {
    // The claim was queued because the assistant never checked THIS sentence
    // against the paper. A paper-level review by someone else does not settle
    // that, so dropping the warning would remove the only reason the proposal
    // is in the queue at all.
    render(
      <WikiFactDiff
        edit={edit({
          proposedMeta: {
            source: 'conversation-ingestion',
            unverifiedReferenceIds: [1],
          },
          // Both papers now carry a read-in-full review.
          references: [ref(1, true), ref(2, true)],
        })}
      />,
    );

    expect(screen.getByText('review.factUnverifiedSource')).toBeInTheDocument();
    const marks = screen.getAllByText('review.factReferenceNotRead');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.parentElement?.textContent).toContain('[1]');
  });

  it('does not mark a paper dropped while the proposal was out for revision', () => {
    // Frozen ids are intersected with the references actually on the row, so a
    // reference removed during a revision cannot be marked.
    render(
      <WikiFactDiff
        edit={edit({
          proposedMeta: {
            source: 'conversation-ingestion',
            unverifiedReferenceIds: [7],
          },
          references: [ref(1, true)],
        })}
      />,
    );

    expect(
      screen.queryByText('review.factReferenceNotRead'),
    ).not.toBeInTheDocument();
  });

  it('marks both what the assistant skipped and what nobody has read', () => {
    // The two facts are different and neither subsumes the other, so the card
    // takes their union: [1] because the assistant never checked this claim
    // against it, [2] because no read-in-full review exists for it at all —
    // the case a list frozen at ingestion could not know about.
    render(
      <WikiFactDiff
        edit={edit({
          proposedMeta: {
            source: 'conversation-ingestion',
            unverifiedReferenceIds: [1],
          },
          references: [ref(1, true), ref(2, false)],
        })}
      />,
    );

    const marks = screen.getAllByText('review.factReferenceNotRead');
    expect(marks).toHaveLength(2);
    expect(marks.map((m) => m.parentElement?.textContent ?? '').join(' ')).toContain(
      '[1]',
    );
  });
});
