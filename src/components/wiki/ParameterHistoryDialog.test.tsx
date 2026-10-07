/**
 * The edit-history dialog didn't say why a revision's pooled sources changed
 * — only that they did ("Recomputed from 3 source entries") — and carried
 * none of the peer review behind it (#1358). This covers the two additions:
 * a source-diff list (added/removed citations) and a review-round list
 * (agent verdicts + human disputes).
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18nApp from '@/i18n';
import { ParameterHistoryDialog } from './ParameterHistoryDialog';
import { fetchDrugParameterHistory, type DrugParameterRevisionDTO } from '@/lib/drugApi';

vi.mock('@/lib/drugApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/drugApi')>()),
  fetchDrugParameterHistory: vi.fn(),
}));


const fetchDrugParameterHistoryMock = vi.mocked(fetchDrugParameterHistory);

function revision(over: Partial<DrugParameterRevisionDTO>): DrugParameterRevisionDTO {
  return {
    id: 1,
    oldValue: { median: 2, unit: 'h' },
    newValue: { median: 2.1, unit: 'h' },
    editSummary: 'auto:param_entries_recomputed:3',
    createdAt: '2026-09-22T11:00:00.000Z',
    author: null,
    ...over,
  };
}

describe('ParameterHistoryDialog', () => {
  beforeEach(async () => {
    await i18nApp.changeLanguage('en');
    fetchDrugParameterHistoryMock.mockReset();
  });

  it('lists which citations were added and removed from the pool', async () => {
    fetchDrugParameterHistoryMock.mockResolvedValue({
      revisions: [
        revision({
          editSummary: 'auto:param_entries_recomputed:3:citation_cleanup',
          sourceDiff: {
            added: [],
            removed: [
              { citationId: 1556, label: null },
              { citationId: 3023, label: 'Human pharmacology of MDMA' },
            ],
          },
        }),
      ],
    });

    render(
      <ParameterHistoryDialog drugId={51} parameter="tmax" onClose={() => {}} />,
    );

    expect(
      await screen.findByText('Human pharmacology of MDMA', { exact: false }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Citation #1556/)).toBeInTheDocument();
    // The cleanup reason is appended to the translated summary.
    expect(
      screen.getByText(/citation cleanup: an unreliable citation was removed/),
    ).toBeInTheDocument();
  });

  it('lists the agent verdicts and human disputes behind a revision', async () => {
    fetchDrugParameterHistoryMock.mockResolvedValue({
      revisions: [
        revision({
          reviewVerdicts: [
            {
              id: 10,
              verdict: 'approve',
              rationaleMd: 'Matches the surviving source.',
              isImplicit: false,
              createdAt: '2026-09-22T11:05:00.000Z',
              updatedAt: '2026-09-22T11:05:00.000Z',
              agent: { id: 1, slug: 'reviewer-agent', name: 'Reviewer agent' },
            },
          ],
          disputes: [
            {
              id: 20,
              source: 'human',
              reasonMd: 'This recompute dropped a source without explanation.',
              status: 'open',
              createdAt: '2026-09-22T11:10:00.000Z',
              updatedAt: '2026-09-22T11:10:00.000Z',
              author: { id: 2, name: 'A. Reviewer', agentSlug: null },
            },
          ],
        }),
      ],
    });

    render(
      <ParameterHistoryDialog drugId={51} parameter="tmax" onClose={() => {}} />,
    );

    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Reviewer agent', { exact: false })).toBeInTheDocument();
    expect(
      screen.getByText('Matches the surviving source.'),
    ).toBeInTheDocument();
    // The dispute verdict label appears once — filtered from `disputes`
    // (source: 'human'), not duplicated from `verifications`.
    expect(screen.getAllByText('Disputed')).toHaveLength(1);
    expect(
      screen.getByText('This recompute dropped a source without explanation.'),
    ).toBeInTheDocument();
  });

  it('does not duplicate an agent dispute still backed by a live dispute verdict', async () => {
    fetchDrugParameterHistoryMock.mockResolvedValue({
      revisions: [
        revision({
          reviewVerdicts: [
            {
              id: 11,
              verdict: 'dispute',
              rationaleMd: 'The pooled median looks wrong.',
              isImplicit: false,
              createdAt: '2026-09-22T11:05:00.000Z',
              updatedAt: '2026-09-22T11:05:00.000Z',
              agent: { id: 3, slug: 'auditor-agent', name: 'Auditor agent' },
            },
          ],
          disputes: [
            // Still open, and no resolved row from this agent answers the
            // verdict yet — this is the live, unanswered mirror.
            {
              id: 21,
              source: 'agent',
              reasonMd: 'The pooled median looks wrong.',
              status: 'open',
              createdAt: '2026-09-22T11:05:00.000Z',
              updatedAt: '2026-09-22T11:05:00.000Z',
              author: { id: 3, name: 'Auditor agent', agentSlug: 'auditor-agent' },
            },
          ],
        }),
      ],
    });

    render(
      <ParameterHistoryDialog drugId={51} parameter="tmax" onClose={() => {}} />,
    );

    expect(await screen.findByText('Disputed')).toBeInTheDocument();
    // Mirrored by a live agent_verifications dispute row for the same
    // agent — shown once, from the verdict, not duplicated from `disputes`.
    expect(screen.getAllByText('Disputed')).toHaveLength(1);
  });

  it('shows a standalone agent dispute with no matching live dispute verdict (#1379)', async () => {
    fetchDrugParameterHistoryMock.mockResolvedValue({
      revisions: [
        revision({
          reviewVerdicts: [
            {
              id: 12,
              verdict: 'approve',
              rationaleMd: 'Looks right.',
              isImplicit: false,
              createdAt: '2026-09-22T11:05:00.000Z',
              updatedAt: '2026-09-22T11:05:00.000Z',
              agent: { id: 3, slug: 'auditor-agent', name: 'Auditor agent' },
            },
          ],
          disputes: [
            // Opened directly via POST /api/disputes, so there is no
            // matching `dispute`-verdict row for this agent — or a mirror
            // whose verdict later changed to `approve`, leaving the
            // resolved dispute row behind. Either way it must still show.
            {
              id: 22,
              source: 'agent',
              reasonMd: 'Filed independently of any verdict.',
              status: 'resolved',
              createdAt: '2026-09-22T10:55:00.000Z',
              updatedAt: '2026-09-22T10:56:00.000Z',
              author: { id: 3, name: 'Auditor agent', agentSlug: 'auditor-agent' },
            },
          ],
        }),
      ],
    });

    render(
      <ParameterHistoryDialog drugId={51} parameter="tmax" onClose={() => {}} />,
    );

    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Disputed')).toBeInTheDocument();
    expect(
      screen.getByText('Filed independently of any verdict.'),
    ).toBeInTheDocument();
  });

  it('keeps a fresh agent dispute independent of an old, already-answered verdict (#1393 review)', async () => {
    fetchDrugParameterHistoryMock.mockResolvedValue({
      revisions: [
        revision({
          reviewVerdicts: [
            // The agent's verdict itself has no status column — it still
            // reads `dispute` even after a moderator resolved its mirror.
            {
              id: 13,
              verdict: 'dispute',
              rationaleMd: 'The pooled median looks wrong.',
              isImplicit: false,
              createdAt: '2026-09-22T11:00:00.000Z',
              updatedAt: '2026-09-22T11:00:00.000Z',
              agent: { id: 3, slug: 'auditor-agent', name: 'Auditor agent' },
            },
          ],
          disputes: [
            // The original mirror, resolved by a moderator after the
            // verdict — this answers the verdict, so it's independent
            // history rather than "the same" dispute as the verdict entry.
            {
              id: 23,
              source: 'agent',
              reasonMd: 'Original objection, since resolved.',
              status: 'resolved',
              createdAt: '2026-09-22T11:00:00.000Z',
              updatedAt: '2026-09-22T11:30:00.000Z',
              author: { id: 3, name: 'Auditor agent', agentSlug: 'auditor-agent' },
            },
            // A fresh dispute the same agent opened afterward, unrelated to
            // the now-resolved one — must not be swallowed just because the
            // agent's (unchanged) verdict still says `dispute`.
            {
              id: 24,
              source: 'agent',
              reasonMd: 'A new, unrelated objection.',
              status: 'open',
              createdAt: '2026-09-22T12:00:00.000Z',
              updatedAt: '2026-09-22T12:00:00.000Z',
              author: { id: 3, name: 'Auditor agent', agentSlug: 'auditor-agent' },
            },
          ],
        }),
      ],
    });

    render(
      <ParameterHistoryDialog drugId={51} parameter="tmax" onClose={() => {}} />,
    );

    expect(
      await screen.findByText('Original objection, since resolved.'),
    ).toBeInTheDocument();
    expect(screen.getByText('A new, unrelated objection.')).toBeInTheDocument();
    // Verdict + both disputes each render their own "Disputed" entry.
    expect(screen.getAllByText('Disputed')).toHaveLength(3);
  });

  it('renders nothing extra when a revision has no diff or review data', async () => {
    fetchDrugParameterHistoryMock.mockResolvedValue({
      revisions: [revision({})],
    });

    render(
      <ParameterHistoryDialog drugId={51} parameter="tmax" onClose={() => {}} />,
    );

    expect(await screen.findByText(/Recomputed from 3 source entries/)).toBeInTheDocument();
    expect(screen.queryByText('Sources')).not.toBeInTheDocument();
    expect(screen.queryByText('Review')).not.toBeInTheDocument();
  });
});
