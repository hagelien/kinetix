import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ParameterDiff } from './ParameterDiff';
import type { ReferenceRow } from '@/lib/referenceApi';

// Mirror the repo convention (see ParameterBadges.test): a passthrough `t` so
// assertions can target translation keys directly.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.id ? `${key} ${values.id}` : key,
  }),
}));

function ref(id: number, year: number): ReferenceRow {
  return {
    id,
    drugId: 1,
    type: 'doi',
    identifier: `10.1000/${id}`,
    metadata: {
      title: `Ref ${id}`,
      authors: [`Author${id}`],
      journal: 'J',
      year,
      volume: null,
      pages: null,
    },
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('ParameterDiff — references-only changes (#857)', () => {
  it('flags a references-only change and hides the value diff grid', () => {
    render(
      <ParameterDiff
        parameter={null}
        currentValue={{ min: 5, max: 5, unit: 'mg/L' }}
        proposedValue={{ min: 5, max: 5, unit: 'mg/L' }}
        references={[ref(2, 2002)]}
        currentReferenceIds={[1]}
        currentReferences={[ref(1, 2001)]}
      />,
    );

    // "References changed" + "value unchanged" instead of a Live → Proposed grid.
    expect(screen.getByText('review.referencesChanged')).toBeTruthy();
    expect(screen.getByText(/review\.valueUnchanged/)).toBeTruthy();
    expect(screen.queryByText('review.live')).toBeNull();
    expect(screen.queryByText('review.proposed')).toBeNull();

    // The new citation is marked added; the dropped one is struck through.
    expect(screen.getByText('review.referenceAdded')).toBeTruthy();
    const removedTag = screen.getByText('review.referenceRemoved');
    expect(removedTag.closest('li')).toHaveClass('line-through');
  });

  it('keeps the normal value diff when the value itself changes', () => {
    render(
      <ParameterDiff
        parameter={null}
        currentValue={{ min: 5, max: 5, unit: 'mg/L' }}
        proposedValue={{ min: 9, max: 9, unit: 'mg/L' }}
        references={[ref(2, 2002)]}
        currentReferenceIds={[2]}
        currentReferences={[ref(2, 2002)]}
      />,
    );

    expect(screen.getByText('review.live')).toBeTruthy();
    expect(screen.getByText('review.proposed')).toBeTruthy();
    expect(screen.queryByText('review.referencesChanged')).toBeNull();
    // References are unchanged, so nothing is marked added/removed.
    expect(screen.queryByText('review.referenceAdded')).toBeNull();
    expect(screen.queryByText('review.referenceRemoved')).toBeNull();
  });

  it('renders the reference list plainly when the value also changed', () => {
    render(
      <ParameterDiff
        parameter={null}
        currentValue={{ min: 5, max: 5, unit: 'mg/L' }}
        proposedValue={{ min: 9, max: 9, unit: 'mg/L' }}
        references={[ref(2, 2002)]}
        currentReferenceIds={[1]}
        currentReferences={[ref(1, 2001)]}
      />,
    );

    // Value changed → the value diff is the headline; delta highlighting is
    // scoped to references-only changes, so no badge and no add/remove tags.
    expect(screen.getByText('review.live')).toBeTruthy();
    expect(screen.queryByText('review.referencesChanged')).toBeNull();
    expect(screen.queryByText('review.referenceAdded')).toBeNull();
    expect(screen.queryByText('review.referenceRemoved')).toBeNull();
  });
});

describe('ParameterDiff — list-kind metadata (#1311)', () => {
  it('renders the live and proposed alias lists instead of a blank diff', () => {
    render(
      <ParameterDiff
        parameter="aliases"
        currentValue={['Duragesic']}
        proposedValue={['Duragesic', 'Fentanyl patch']}
      />,
    );

    // Before the fix, `formatForDiff` only special-cased 'text'/'number' and
    // fell through to `formatRange` for 'list', which returns '' for an
    // array — both sides rendered as '—' and the card looked blank.
    expect(screen.getByText('Duragesic')).toBeTruthy();
    expect(screen.getByText('Duragesic, Fentanyl patch')).toBeTruthy();
    expect(screen.queryByText('—')).toBeNull();
  });

  it('treats two equal alias lists as unchanged (references-only path)', () => {
    render(
      <ParameterDiff
        parameter="aliases"
        currentValue={['Duragesic']}
        proposedValue={['Duragesic']}
        references={[ref(2, 2002)]}
        currentReferenceIds={[1]}
        currentReferences={[ref(1, 2001)]}
      />,
    );

    // Same list on both sides + a reference change → the references-only
    // path, which only exercises correctly if formatForDiff agrees the two
    // sides are equal (it previously did, by both being '', so this alone
    // wasn't the regression signal — the value-diff test above is).
    expect(screen.getByText('review.referencesChanged')).toBeTruthy();
    expect(screen.getByText('Duragesic')).toBeTruthy();
  });
});
