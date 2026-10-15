/**
 * The edit-history dialog didn't say why a revision's pooled sources changed
 * — only that they did ("Recomputed from 3 source entries") — and carried
 * none of the peer review behind it (#1358). This covers the two additions:
 * a source-diff list (added/removed citations) and a review-round list
 * (agent verdicts + human disputes).
 */
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18nApp from '@/i18n';
import { ParameterHistoryDialog } from './ParameterHistoryDialog';
import {
  fetchDrugBlockHistory,
  fetchDrugParameterHistory,
  type DrugParameterRevisionDTO,
} from '@/lib/drugApi';

vi.mock('@/lib/drugApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/drugApi')>()),
  fetchDrugParameterHistory: vi.fn(),
  fetchDrugBlockHistory: vi.fn(),
}));


const fetchDrugParameterHistoryMock = vi.mocked(fetchDrugParameterHistory);
const fetchDrugBlockHistoryMock = vi.mocked(fetchDrugBlockHistory);

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
    // No approvers → no "approved by" line.
    expect(screen.queryByTestId('revision-approvals')).not.toBeInTheDocument();
  });

  it('shows who approved a revision and when, read-only (#107)', async () => {
    const approvedAt = '2026-09-22T11:30:00.000Z';
    fetchDrugParameterHistoryMock.mockResolvedValue({
      revisions: [
        revision({
          approvals: {
            count: 1,
            approvers: [
              {
                id: 7,
                username: 'reviewer',
                displayName: 'Kari Nordmann',
                role: 'editor',
                isAgent: false,
                approvedAt,
              },
            ],
            approvedByMe: false,
          },
        }),
      ],
    });

    render(
      <ParameterHistoryDialog drugId={51} parameter="tmax" onClose={() => {}} />,
    );

    const line = await screen.findByTestId('revision-approvals');
    expect(line).toHaveTextContent('Approved by');
    expect(line).toHaveTextContent('Kari Nordmann');
    expect(line).toHaveTextContent(new Date(approvedAt).toLocaleString());
    // Display only: the removed click-to-approve chip must not come back.
    expect(within(line).queryByRole('button')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /approv/i }),
    ).not.toBeInTheDocument();
  });

  // #37: a whole block's history shows its before/after snapshots as lines,
  // marking what was removed and added, instead of a parameter's formatted value.
  describe('for a whole block', () => {
    beforeEach(() => fetchDrugBlockHistoryMock.mockReset());

    const declaration = (categoricalValue: string, citationId: number) => ({
      parameter: 'dispositionModel',
      categoricalValue,
      route: null,
      citationId,
      sourceQuote: null,
    });

    it('lists the lines a revision removed and added', async () => {
      fetchDrugBlockHistoryMock.mockResolvedValue({
        revisions: [
          revision({
            editSummary: null,
            oldValue: { declarations: [declaration('one-compartment', 4)] },
            newValue: { declarations: [declaration('two-compartment', 5)] },
          }),
        ],
      });

      render(
        <ParameterHistoryDialog
          drugId={51}
          parameter="modelStructure"
          onClose={() => {}}
        />,
      );

      expect(
        await screen.findByRole('dialog', { name: /^model structure — history$/i }),
      ).toBeInTheDocument();
      const diff = await screen.findByTestId('block-revision-diff');
      expect(within(diff).getByText(/^− .*#4$/)).toBeInTheDocument();
      expect(within(diff).getByText(/^\+ .*#5$/)).toBeInTheDocument();
      expect(fetchDrugBlockHistoryMock).toHaveBeenCalledWith(51, 'modelStructure');
      expect(fetchDrugParameterHistoryMock).not.toHaveBeenCalled();
    });

    it('says when the state before a revision was never recorded', async () => {
      fetchDrugBlockHistoryMock.mockResolvedValue({
        revisions: [
          revision({
            editSummary: null,
            oldValue: null,
            newValue: { declarations: [declaration('two-compartment', 5)] },
          }),
        ],
      });

      render(
        <ParameterHistoryDialog
          drugId={51}
          parameter="modelStructure"
          onClose={() => {}}
        />,
      );

      const diff = await screen.findByTestId('block-revision-diff');
      expect(within(diff).getByText('Not recorded')).toBeInTheDocument();
      // Nothing to compare against, so nothing is marked as added.
      expect(within(diff).queryByText(/^\+ /)).not.toBeInTheDocument();
    });


    it.each(['en', 'nb'])('shows the publication reviewer and verdict affordance in %s', async (lang) => {
      await i18nApp.changeLanguage(lang);
      const reviewedAt = '2026-10-15T11:30:00.000Z';
      fetchDrugBlockHistoryMock.mockResolvedValue({ revisions: [revision({
        oldValue: {}, newValue: {}, editSummary: null, pendingEditId: 44,
        author: { id: 1, displayName: 'Innsender' },
        reviewDecision: { reviewedAt, reviewer: { id: 2, displayName: 'Godkjenner', role: 'editor' } },
        verifications: { approveCount: 1, disputeCount: 0, abstainCount: 0, implicitApproveCount: 0 },
      })] });
      render(<ParameterHistoryDialog drugId={51} parameter="metabolism" onClose={() => {}} />);
      const decision = await screen.findByTestId('block-review-decision');
      expect(decision).toHaveTextContent(i18nApp.t('paramHistory.approvedBy'));
      expect(decision).toHaveTextContent('Godkjenner');
      expect(decision).toHaveTextContent(new Date(reviewedAt).toLocaleString());
      expect(within(decision).queryByRole('link')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: i18nApp.t('review.verification.showRationales') })).toBeInTheDocument();
      expect(screen.getByText('Innsender')).toBeInTheDocument();
    });

    it('states when the publication reviewer was not recorded', async () => {
      fetchDrugBlockHistoryMock.mockResolvedValue({ revisions: [revision({
        oldValue: {}, newValue: {}, editSummary: null,
        reviewDecision: { reviewedAt: null, reviewer: null },
      })] });
      render(<ParameterHistoryDialog drugId={51} parameter="metabolism" onClose={() => {}} />);
      expect(await screen.findByTestId('block-review-decision')).toHaveTextContent('Reviewer not recorded');
    });

    it('names an operator script as the author of an authorless block revision', async () => {
      fetchDrugBlockHistoryMock.mockResolvedValue({
        revisions: [
          revision({
            editSummary: null,
            author: null,
            oldValue: { declarations: [] },
            newValue: { declarations: [declaration('two-compartment', 5)] },
          }),
        ],
      });
      render(
        <ParameterHistoryDialog drugId={51} parameter="modelStructure" onClose={() => {}} />,
      );
      expect(await screen.findByText('Import or operator script')).toBeInTheDocument();
    });
  });
});
