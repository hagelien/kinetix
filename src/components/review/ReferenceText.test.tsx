import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ReferenceText } from './ReferenceText';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string) => key,
  }),
}));

const { fetchDisputeByIdMock, fetchDiscussionByIdMock } = vi.hoisted(() => ({
  fetchDisputeByIdMock: vi.fn(),
  fetchDiscussionByIdMock: vi.fn(),
}));
vi.mock('@/lib/disputesApi', () => ({
  fetchDisputeById: fetchDisputeByIdMock,
}));
vi.mock('@/lib/drugApi', () => ({
  fetchDiscussionById: fetchDiscussionByIdMock,
}));

const summary =
  'Etter melding fra fagfelle (diskusjon #1379, se også bestridelse #871 på pending_edit 1412).';

describe('ReferenceText', () => {
  it('links a pending edit to the review queue', () => {
    render(
      <MemoryRouter>
        <ReferenceText text={summary} />
      </MemoryRouter>,
    );
    expect(
      screen.getByRole('link', { name: 'pending_edit 1412' }),
    ).toHaveAttribute('href', '/review?id=1412&status=all');
    // The surrounding prose is kept verbatim.
    expect(screen.getByText(/Etter melding fra fagfelle/)).toBeInTheDocument();
  });

  it('opens the cited discussion comment', async () => {
    fetchDiscussionByIdMock.mockResolvedValue({
      discussion: {
        id: 1379,
        drugId: 12,
        parameter: 'dispositionModel',
        parentId: null,
        body: 'Cha 2024 er en delmengde av samme kohort.',
        createdAt: '2026-10-01T00:00:00.000Z',
        author: null,
      },
      parent: null,
      replies: [],
      url: '/wiki/drug/12',
    });
    render(
      <MemoryRouter>
        <ReferenceText text={summary} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'diskusjon #1379' }));
    expect(fetchDiscussionByIdMock).toHaveBeenCalledWith(1379);
    expect(
      await screen.findByText('Cha 2024 er en delmengde av samme kohort.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'review.reference.openDiscussion' }),
    ).toHaveAttribute('href', '/wiki/drug/12');
  });

  it('opens the cited dispute', async () => {
    fetchDisputeByIdMock.mockResolvedValue({
      dispute: {
        id: 871,
        targetType: 'pending_edit',
        targetId: 1412,
        source: 'agent',
        reasonMd: 'Ikke uavhengig korroborering.',
        evidenceRefs: [],
        status: 'resolved',
        resolution: 'upheld',
        resolvedAt: null,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-01T00:00:00.000Z',
        createdBy: 9,
        author: { id: 9, name: null, role: null, agentSlug: 'gpt-terra' },
        url: '/review?id=1412',
      },
    });
    render(
      <MemoryRouter>
        <ReferenceText text={summary} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'bestridelse #871' }));
    expect(
      await screen.findByText('Ikke uavhengig korroborering.'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('review.reference.disputeResolution.upheld'),
    ).toBeInTheDocument();
  });
});
