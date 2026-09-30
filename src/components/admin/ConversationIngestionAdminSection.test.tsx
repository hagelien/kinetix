import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationIngestionAdminSection } from './ConversationIngestionAdminSection';

// A faithful-enough i18next: a key that EXISTS in the shipped locale renders as
// the key (so a test can assert the component translated rather than echoing
// the server's English), and a key that does not falls back to `defaultValue`,
// which is what the real library does. Reading the actual locale file means
// this also fails when a key is referenced but never added — the failure mode
// a hand-written stub would hide.
vi.mock('react-i18next', async () => {
  const en = (await import('@/locales/en.json')).default as Record<string, unknown>;
  const lookup = (key: string): unknown =>
    key.split('.').reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      en,
    );
  return {
    useTranslation: () => ({
      t: (key: string, opts?: Record<string, unknown>) => {
        translated.push({ key, opts });
        return typeof lookup(key) === 'string'
          ? key
          : String(opts?.defaultValue ?? key);
      },
    }),
  };
});

/**
 * Every `t(key, opts)` this render made. The mock returns the bare key, so a
 * message's interpolated numbers are invisible in the DOM — and the count on
 * the completion toast is exactly the sort of thing that goes wrong silently
 * when the copy changes and the value behind it does not.
 */
const translated: Array<{ key: string; opts?: Record<string, unknown> }> = [];
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));

const BUNDLE = JSON.stringify({ schemaVersion: 'kinetix-conversation-ingestion-v1' });

const PLAN = {
  idempotencyKey: 'conv-01',
  mode: 'auto',
  createdAt: '2026-08-06T09:12:00Z',
  sources: [
    {
      key: 'S1',
      type: 'pmid',
      identifier: '2719903',
      title: 'A paper',
      citationId: null,
      citationAction: 'create',
      reviewAction: 'record',
      review: null,
      replacedReview: null,
      pdfRequestNeeded: false,
      metadata: { authors: [], journal: null, year: null },
      sameAs: null,
    },
  ],
  blockedCandidates: [],
  counts: { ready: 1, review: 0, duplicate: 0, blocked: 1 },
  items: [
    {
      index: 0,
      fingerprint: 'fp-0',
      type: 'parameter_observation',
      disposition: 'ready',
      reason: null,
      detail: null,
      notes: [],
      sourceKeys: ['S1'],
      editSummary: 'Oral bioavailability.',
      drugId: 4,
      drugName: 'Morphine',
      parameter: 'bioavailability',
      reading: { median: 0.239, unit: 'fraction', n: 6 },
      current: null,
      comments: null,
      quote: 'Absolute oral bioavailability averaged 23.9%.',
    },
    {
      index: 1,
      fingerprint: 'fp-1',
      type: 'wiki_fact',
      disposition: 'blocked',
      reason: 'fact_not_found',
      detail: 'abc',
      notes: [],
      sourceKeys: ['S1'],
      editSummary: null,
      pageId: 9,
      pageTitle: 'Morfin',
      pageType: 'drug_monograph',
      sectionId: 'forensic',
      operation: 'replace',
      statement: 'Ny setning.',
      existingStatement: null,
      existingReferences: [],
      sectionFactCount: 2,
      unverifiedSourceKeys: [],
    },
  ],
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  translated.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function typeBundle(value = BUNDLE) {
  fireEvent.change(
    screen.getByPlaceholderText('admin.conversationIngestion.placeholder'),
    { target: { value } },
  );
}

function mockResponse(body: unknown, ok = true) {
  (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok,
    json: async () => body,
  });
}

describe('ConversationIngestionAdminSection', () => {
  it('cannot apply before the bundle has been analysed', () => {
    render(<ConversationIngestionAdminSection />);
    expect(screen.getByText(/admin.conversationIngestion.apply/)).toBeDisabled();
  });

  it('rejects invalid JSON without calling the API', () => {
    render(<ConversationIngestionAdminSection />);
    typeBundle('{ not json');
    fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));
    expect(screen.getByText('admin.conversationIngestion.invalidJson')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  // The quote claims to be the source's own words. An admin ticking it through
  // without seeing it is certifying a quotation they have not read, against a
  // value they cannot compare it to — the exact review failure the field was
  // added to prevent, reproduced at the gate meant to catch it. So it is shown
  // open on the card, not folded behind a disclosure or left in the raw JSON.
  it('shows the source quote on the card, beside the reading it certifies', async () => {
    mockResponse({ ok: true, applied: false, plan: PLAN, warnings: [] });
    render(<ConversationIngestionAdminSection />);
    typeBundle();
    fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));

    await waitFor(() =>
      expect(
        screen.getByText('Absolute oral bioavailability averaged 23.9%.'),
      ).toBeInTheDocument(),
    );
  });

  // Codex on #1452: a labelled reading (migration 0135) keeps its centre in
  // `centralValue`, not `median`. The gate must show that centre and what it is
  // — an admin must not publish a mean the preview only showed as its bounds.
  it('shows a labelled centre, its statistic and its interval kind', async () => {
    const labelled = {
      ...PLAN,
      items: [
        {
          ...PLAN.items[0]!,
          parameter: 'halfLife',
          reading: {
            low: 0.42,
            high: 0.66,
            centralValue: 0.54,
            centralStatistic: 'arithmetic_mean',
            intervalKind: 'sd',
            unit: 'h',
            n: 12,
          },
        },
        PLAN.items[1]!,
      ],
    };
    mockResponse({ ok: true, applied: false, plan: labelled, warnings: [] });
    render(<ConversationIngestionAdminSection />);
    typeBundle();
    fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));

    await waitFor(() =>
      expect(screen.getByText(/0\.54 \(0\.42–0\.66\) · h/)).toBeInTheDocument(),
    );
    expect(
      screen.getByText(/doseContext\.values\.centralStatistic\.arithmetic_mean/),
    ).toBeInTheDocument();
    expect(translated).toContainEqual({
      key: 'doseContext.interval',
      opts: { kind: 'doseContext.values.intervalKind.sd' },
    });
  });

  it('pre-selects applicable items and leaves blocked ones untickable', async () => {
    mockResponse({ ok: true, applied: false, plan: PLAN, warnings: [] });
    render(<ConversationIngestionAdminSection />);
    typeBundle();
    fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));

    await waitFor(() =>
      expect(screen.getByText('admin.conversationIngestion.gateTitle')).toBeInTheDocument(),
    );

    const boxes = screen
      .getAllByRole('checkbox')
      .filter((el) => (el as HTMLInputElement).getAttribute('aria-label'));
    expect(boxes).toHaveLength(2);
    // The ready item starts ticked; the blocked one cannot be ticked at all.
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).disabled).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
  });

  it('sends only the ticked items to the apply call', async () => {
    mockResponse({ ok: true, applied: false, plan: PLAN, warnings: [] });
    render(<ConversationIngestionAdminSection />);
    typeBundle();
    fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));
    await waitFor(() =>
      expect(screen.getByText('admin.conversationIngestion.gateTitle')).toBeInTheDocument(),
    );

    mockResponse({
      ok: true,
      applied: true,
      plan: { ...PLAN, counts: { ready: 0, duplicate: 1, blocked: 1 } },
      result: {
        citationsCreated: 1,
        reviewsRecorded: 1,
        items: [
          { index: 0, status: 'applied', reason: null, detail: null, createdId: 12 },
        ],
        counts: { applied: 1, skipped: 0, failed: 0 },
      },
      warnings: [],
    });
    fireEvent.click(screen.getByText(/admin.conversationIngestion.apply/));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const body = JSON.parse(
      (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1].body,
    );
    expect(body).toMatchObject({ action: 'apply', accept: [0] });
    // The server requires the disposition the gate displayed for every source
    // an accepted item cites, so the pane always sends it.
    expect(body.expectedReviewActions).toEqual({ S1: 'record' });
    // And the digest of each row as displayed, so the server can refuse one
    // whose resolution moved since.
    expect(body.expectedFingerprints).toEqual({ 0: 'fp-0', 1: 'fp-1' });

    await waitFor(() =>
      expect(
        screen.getByText('admin.conversationIngestion.resultSummary'),
      ).toBeInTheDocument(),
    );
  });

  it('unticking an item removes it from the apply call', async () => {
    mockResponse({ ok: true, applied: false, plan: PLAN, warnings: [] });
    render(<ConversationIngestionAdminSection />);
    typeBundle();
    fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));
    await waitFor(() =>
      expect(screen.getByText('admin.conversationIngestion.gateTitle')).toBeInTheDocument(),
    );

    const box = screen
      .getAllByRole('checkbox')
      .filter((el) => el.getAttribute('aria-label'))[0]!;
    fireEvent.click(box);

    // Nothing ticked → applying is impossible, so no request can be sent.
    expect(screen.getByText(/admin.conversationIngestion.apply/)).toBeDisabled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not re-tick declined items after a partial apply', async () => {
    mockResponse({ ok: true, applied: false, plan: PLAN, warnings: [] });
    render(<ConversationIngestionAdminSection />);
    typeBundle();
    fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));
    await waitFor(() =>
      expect(screen.getByText('admin.conversationIngestion.gateTitle')).toBeInTheDocument(),
    );

    // A three-item plan: two applicable, one of which the admin declines.
    // (PLAN's second item is blocked, so add a third that stays ready.)
    const extraReady = { ...PLAN.items[0], index: 2, parameter: 'halfLife' };
    mockResponse({
      ok: true,
      applied: false,
      plan: { ...PLAN, items: [...PLAN.items, extraReady] },
      warnings: [],
    });
    fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));
    await waitFor(() => expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(3));

    const boxes = () =>
      screen.getAllByRole('checkbox').filter((el) => el.getAttribute('aria-label'));
    fireEvent.click(boxes()[2]!); // decline the third item

    // Apply: the response is a POST-write plan in which the declined item is
    // still `ready`. It must not be silently re-ticked.
    mockResponse({
      ok: true,
      applied: true,
      plan: { ...PLAN, items: [...PLAN.items, extraReady] },
      result: {
        citationsCreated: 1,
        reviewsRecorded: 1,
        items: [{ index: 0, status: 'applied', reason: null, detail: null, createdId: 12 }],
        counts: { applied: 1, skipped: 1, failed: 0 },
      },
      warnings: [],
    });
    fireEvent.click(screen.getByText(/admin.conversationIngestion.apply/));

    await waitFor(() =>
      expect(
        screen.getByText('admin.conversationIngestion.resultSummary'),
      ).toBeInTheDocument(),
    );
    expect((boxes()[2] as HTMLInputElement).checked).toBe(false);
  });

  it('ignores a plan that arrives after the bundle was edited', async () => {
    // The response is held open while the admin edits the textarea. Installing
    // it afterwards would show a plan for text that is no longer on screen, and
    // Apply would then send the new document under the old plan's indices.
    let release: (value: unknown) => void = () => {};
    (fetch as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );

    render(<ConversationIngestionAdminSection />);
    typeBundle();
    fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));

    typeBundle('{"schemaVersion":"kinetix-conversation-ingestion-v1","edited":true}');
    release({ ok: true, json: async () => ({ ok: true, applied: false, plan: PLAN, warnings: [] }) });

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByText('admin.conversationIngestion.gateTitle'),
    ).not.toBeInTheDocument();
  });

  // Editing the textarea currently clears the plan, so this cannot diverge
  // today — it pins the invariant that Apply re-sends the document the plan was
  // computed from, so a later change that stops clearing on edit fails here
  // rather than silently applying indices against different items.
  it('applies the analysed document rather than re-reading the textarea', async () => {
    mockResponse({ ok: true, applied: false, plan: PLAN, warnings: [] });
    render(<ConversationIngestionAdminSection />);
    typeBundle();
    fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));
    await waitFor(() =>
      expect(screen.getByText('admin.conversationIngestion.gateTitle')).toBeInTheDocument(),
    );

    mockResponse({
      ok: true,
      applied: true,
      plan: PLAN,
      result: {
        citationsCreated: 0,
        reviewsRecorded: 0,
        items: [],
        counts: { applied: 0, skipped: 0, failed: 0 },
      },
      warnings: [],
    });
    fireEvent.click(screen.getByText(/admin.conversationIngestion.apply/));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    const body = JSON.parse(
      (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1]![1].body,
    );
    expect(body.document).toEqual(JSON.parse(BUNDLE));
  });

  it('keeps the gate and the receipt when the server cannot refresh the plan', async () => {
    mockResponse({ ok: true, applied: false, plan: PLAN, warnings: [] });
    render(<ConversationIngestionAdminSection />);
    typeBundle();
    fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));
    await waitFor(() =>
      expect(screen.getByText('admin.conversationIngestion.gateTitle')).toBeInTheDocument(),
    );

    // The writes committed but the post-write plan refresh failed, so the
    // response carries a receipt and no plan. The pane must show the receipt
    // rather than blanking out — the admin needs to know what landed.
    mockResponse({
      ok: true,
      applied: true,
      plan: null,
      result: {
        citationsCreated: 1,
        reviewsRecorded: 1,
        items: [{ index: 0, status: 'applied', reason: null, detail: null, createdId: 12 }],
        counts: { applied: 1, skipped: 0, failed: 0 },
      },
      warnings: [],
    });
    fireEvent.click(screen.getByText(/admin.conversationIngestion.apply/));

    await waitFor(() =>
      expect(
        screen.getByText('admin.conversationIngestion.resultSummary'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('admin.conversationIngestion.gateTitle')).toBeInTheDocument();
    // And the pane is usable again, not wedged on a stale busy flag.
    expect(screen.getByText('admin.conversationIngestion.analyze')).not.toBeDisabled();
  });

  it('unticks any item the server refused, including a new refusal reason', async () => {
    mockResponse({ ok: true, applied: false, plan: PLAN, warnings: [] });
    render(<ConversationIngestionAdminSection />);
    typeBundle();
    fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));
    await waitFor(() =>
      expect(screen.getByText('admin.conversationIngestion.gateTitle')).toBeInTheDocument(),
    );

    // `item_changed` is a refusal the first version of this filter did not name.
    // The rule is "skipped for any reason other than never accepted", so a
    // reason added later lands on the safe side without another fix.
    mockResponse({
      ok: true,
      applied: true,
      plan: PLAN,
      result: {
        citationsCreated: 0,
        reviewsRecorded: 0,
        items: [
          {
            index: 0,
            status: 'skipped',
            reason: 'item_changed',
            detail: null,
            createdId: null,
          },
        ],
        counts: { applied: 0, skipped: 1, failed: 0 },
      },
      warnings: [],
    });
    fireEvent.click(screen.getByText(/admin.conversationIngestion.apply/));

    await waitFor(() =>
      expect(
        screen.getByText('admin.conversationIngestion.resultSummary'),
      ).toBeInTheDocument(),
    );
    const box = screen
      .getAllByRole('checkbox')
      .filter((el) => el.getAttribute('aria-label'))[0]!;
    expect((box as HTMLInputElement).checked).toBe(false);
  });

  it('unticks an item the server refused because its source review changed', async () => {
    mockResponse({ ok: true, applied: false, plan: PLAN, warnings: [] });
    render(<ConversationIngestionAdminSection />);
    typeBundle();
    fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));
    await waitFor(() =>
      expect(screen.getByText('admin.conversationIngestion.gateTitle')).toBeInTheDocument(),
    );

    // The server refuses the item because the source's review disposition moved
    // since Analyse, and the refreshed plan shows it `ready` again — the state
    // it was refused against is now current. Leaving it ticked would let one
    // more click publish an appraisal the admin never consciously accepted.
    mockResponse({
      ok: true,
      applied: true,
      plan: PLAN,
      result: {
        citationsCreated: 0,
        reviewsRecorded: 0,
        items: [
          {
            index: 0,
            status: 'skipped',
            reason: 'source_review_changed',
            detail: 'S1',
            createdId: null,
          },
        ],
        counts: { applied: 0, skipped: 1, failed: 0 },
      },
      warnings: [],
    });
    fireEvent.click(screen.getByText(/admin.conversationIngestion.apply/));

    await waitFor(() =>
      expect(
        screen.getByText('admin.conversationIngestion.resultSummary'),
      ).toBeInTheDocument(),
    );
    const box = screen
      .getAllByRole('checkbox')
      .filter((el) => el.getAttribute('aria-label'))[0]!;
    expect((box as HTMLInputElement).checked).toBe(false);
  });

  it('translates coded warnings instead of printing server prose', async () => {
    mockResponse({
      ok: true,
      applied: false,
      plan: PLAN,
      warnings: ['items[0]: a new topic page always requires human review (…)'],
      warningDetails: [
        {
          code: 'new_topic_page',
          where: 'items[0]',
          params: { rationale: 'Ingen side dekker temaet' },
        },
      ],
    });
    render(<ConversationIngestionAdminSection />);
    typeBundle();
    fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));

    await waitFor(() =>
      expect(screen.getByText('admin.conversationIngestion.gateTitle')).toBeInTheDocument(),
    );
    // The locale key is used, not the English sentence the server rendered —
    // these fire on valid bundles, so they are chrome a Norwegian admin reads.
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'LI' &&
          el.textContent ===
            'items[0]: admin.conversationIngestion.warning.new_topic_page',
      ),
    ).toBeInTheDocument();
  });

  it('translates coded validation failures rather than printing server prose', async () => {
    mockResponse(
      {
        ok: false,
        errors: ['items[0]: "x" is not a valid DOI'],
        errorDetails: [
          { code: 'invalid_doi', where: 'items[0]', params: { identifier: 'x' } },
        ],
        warnings: [],
        warningDetails: [],
      },
      false,
    );
    render(<ConversationIngestionAdminSection />);
    typeBundle();
    fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));

    await waitFor(() =>
      expect(
        screen.getByText('admin.conversationIngestion.validationFailed'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText(
        (_, el) =>
          el?.tagName === 'LI' &&
          el.textContent === 'items[0]: admin.conversationIngestion.error.invalid_doi',
      ),
    ).toBeInTheDocument();
  });

  it('falls back to the rendered message when only prose is returned', async () => {
    // An older server, or a code this build predates: still readable, just not
    // translated.
    mockResponse({ ok: false, errors: ['items[0]: bad'], warnings: [] }, false);
    render(<ConversationIngestionAdminSection />);
    typeBundle();
    fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));

    await waitFor(() =>
      expect(
        screen.getByText('admin.conversationIngestion.validationFailed'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('items[0]: bad')).toBeInTheDocument();
  });

  describe('a fact bound for the review queue', () => {
    const REVIEW_PLAN = {
      ...PLAN,
      counts: { ready: 0, review: 1, duplicate: 0, blocked: 0 },
      items: [
        {
          ...PLAN.items[1],
          index: 0,
          disposition: 'review',
          reason: 'sources_not_read_in_full',
          detail: 'S1',
          operation: 'add',
          unverifiedSourceKeys: ['S1'],
        },
      ],
    };

    it('is tickable, and says it will not be published', async () => {
      mockResponse({ ok: true, applied: false, plan: REVIEW_PLAN, warnings: [] });
      render(<ConversationIngestionAdminSection />);
      typeBundle();
      fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));

      await waitFor(() =>
        expect(
          screen.getByText('admin.conversationIngestion.disposition.review'),
        ).toBeInTheDocument(),
      );
      // The gate's whole job is to say what a tick does, and for this row it
      // does something different from every other ticked row.
      expect(
        screen.getByText('admin.conversationIngestion.goesToReviewQueue', {
          exact: false,
        }),
      ).toBeInTheDocument();

      // Ticked by default like any other applicable row.
      const box = screen.getByLabelText('admin.conversationIngestion.acceptItem');
      expect(box).not.toBeDisabled();
      expect(box).toBeChecked();
    });

    it('sends it on apply and reports it as queued, not applied', async () => {
      mockResponse({ ok: true, applied: false, plan: REVIEW_PLAN, warnings: [] });
      render(<ConversationIngestionAdminSection />);
      typeBundle();
      fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));
      await waitFor(() =>
        expect(
          screen.getByText('admin.conversationIngestion.disposition.review'),
        ).toBeInTheDocument(),
      );

      mockResponse({
        ok: true,
        applied: true,
        plan: REVIEW_PLAN,
        result: {
          citationsCreated: 1,
          reviewsRecorded: 1,
          items: [{ index: 0, status: 'queued', reason: null, detail: null, createdId: 7 }],
          counts: { applied: 0, queued: 1, skipped: 0, failed: 0 },
        },
        warnings: [],
      });
      fireEvent.click(screen.getByText(/admin.conversationIngestion.apply/));

      await waitFor(() =>
        expect(
          screen.getByText('admin.conversationIngestion.outcome.queued'),
        ).toBeInTheDocument(),
      );
      const [, applyCall] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
      expect(JSON.parse(applyCall![1].body).accept).toEqual([0]);
    });

    it('counts queued items in the completion toast', async () => {
      // A run of nothing but unverified facts writes no live content, so a
      // toast counting `applied` alone would say "0 items" after queueing
      // every one of them.
      mockResponse({ ok: true, applied: false, plan: REVIEW_PLAN, warnings: [] });
      render(<ConversationIngestionAdminSection />);
      typeBundle();
      fireEvent.click(screen.getByText('admin.conversationIngestion.analyze'));
      await waitFor(() =>
        expect(
          screen.getByText('admin.conversationIngestion.disposition.review'),
        ).toBeInTheDocument(),
      );

      mockResponse({
        ok: true,
        applied: true,
        plan: REVIEW_PLAN,
        result: {
          citationsCreated: 1,
          reviewsRecorded: 1,
          items: [{ index: 0, status: 'queued', reason: null, detail: null, createdId: 7 }],
          counts: { applied: 0, queued: 1, skipped: 0, failed: 0 },
        },
        warnings: [],
      });
      fireEvent.click(screen.getByText(/admin.conversationIngestion.apply/));

      await waitFor(() =>
        expect(
          translated.some(
            (c) => c.key === 'admin.conversationIngestion.appliedToast',
          ),
        ).toBe(true),
      );
      const toasts = translated.filter(
        (c) => c.key === 'admin.conversationIngestion.appliedToast',
      );
      expect(toasts[toasts.length - 1]?.opts?.count).toBe(1);
    });
  });
});
