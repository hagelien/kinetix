import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PendingEditCard } from '@/components/review/PendingEditCard';
import type { PendingEditRow } from '@/lib/pendingEditsApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, opts?: Record<string, unknown>) =>
      (opts?.defaultValue as string | undefined) ?? key,
  }),
}));

describe('PendingEditCard', () => {
  it('links wiki fact target titles to their page', () => {
    const edit: PendingEditRow = {
      id: 17,
      editType: 'wiki_fact',
      targetId: 5,
      parameter: null,
      proposedValue: null,
      proposedMeta: null,
      referenceId: null,
      referenceIds: null,
      status: 'pending',
      rejectionReason: null,
      rejectionComment: null,
      submittedBy: 7,
      reviewedBy: null,
      submittedAt: '2026-06-17T08:00:00Z',
      reviewedAt: null,
      reviewToken: 'token',
      sectionId: 'pk',
      fieldId: null,
      factStatement: 'Ethyl glucuronide is formed by glucuronidation.',
      factOperation: 'add',
      factTargetAnchor: null,
      submitter: { id: 7, username: 'agent', displayName: null },
      references: [],
      pageTitle: 'Ethyl glucuronide',
      pageSlug: 'ethyl-glucuronide',
    };

    render(
      <MemoryRouter>
        <PendingEditCard edit={edit} onReviewed={() => {}} />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('link', { name: 'Ethyl glucuronide' }),
    ).toHaveAttribute('href', '/wiki/ethyl-glucuronide');
  });

  it('renders a clinical_case with its title, scenario and answer key instead of an empty wiki diff', () => {
    const edit: PendingEditRow = {
      id: 42,
      editType: 'clinical_case',
      targetId: null,
      parameter: null,
      proposedValue: {
        safetyNotice: 'Kun til opplæring — ikke pasientspesifikke kliniske råd.',
        scenario: 'A 34-year-old breastfeeding patient is prescribed codeine.',
        prerequisites: [],
        objectives: ['Recognise CYP2D6 ultrarapid metaboliser risk'],
        questions: [
          {
            stem: 'Which phenotype raises morphine toxicity risk?',
            format: 'single_best',
            category: 'reasoned',
            difficulty: 'advanced_lis',
            concepts: [],
            sourceSupport: 'FDA codeine label',
            options: [
              {
                id: 'a',
                text: 'Ultrarapid metaboliser',
                isCorrect: true,
                explanation: 'More codeine is converted to morphine.',
              },
              {
                id: 'b',
                text: 'Poor metaboliser',
                isCorrect: false,
                explanation: 'Less morphine is formed.',
              },
            ],
          },
        ],
        crossLinks: [],
      },
      proposedMeta: {
        title: 'Codeine toxicity in an ultrarapid metaboliser',
        slug: 'codeine-um-case',
        difficulty: 'advanced_lis',
        domains: [],
        requiresExpertReview: true,
      },
      referenceId: null,
      referenceIds: null,
      status: 'pending',
      rejectionReason: null,
      rejectionComment: null,
      submittedBy: 7,
      reviewedBy: null,
      submittedAt: '2026-06-28T08:00:00Z',
      reviewedAt: null,
      reviewToken: 'token',
      submitter: { id: 7, username: 'claude-agent', displayName: null },
      references: [],
    };

    render(
      <MemoryRouter>
        <PendingEditCard edit={edit} onReviewed={() => {}} />
      </MemoryRouter>,
    );

    // Title comes from proposedMeta, not the "unknown target" placeholder.
    expect(
      screen.getByText('Codeine toxicity in an ultrarapid metaboliser'),
    ).toBeInTheDocument();
    expect(screen.queryByText('review.unknownTarget')).not.toBeInTheDocument();
    // Scenario + safety notice + answer key render (no empty WikiDiff).
    expect(
      screen.getByText(/A 34-year-old breastfeeding patient/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Kun til opplæring/),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Ultrarapid metaboliser'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('review.wikiDiff.noChanges'),
    ).not.toBeInTheDocument();
  });
});
