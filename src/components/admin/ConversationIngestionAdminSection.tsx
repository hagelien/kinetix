import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Button } from '@/components/ui/button';
import { showToast } from '@/lib/toast';
import { formatRange } from '@/lib/rangeUtils';
import type { NumericRange } from '@/types';

type Disposition = 'ready' | 'review' | 'duplicate' | 'blocked';

/** Dispositions the admin may tick: one publishes, the other queues for review. */
const SELECTABLE: ReadonlySet<Disposition> = new Set(['ready', 'review']);

interface ItemPlanCommon {
  index: number;
  fingerprint: string;
  disposition: Disposition;
  reason: string | null;
  detail: string | null;
  notes: string[];
  sourceKeys: string[];
  editSummary: string | null;
}

interface ParameterItemPlan extends ItemPlanCommon {
  type: 'parameter_observation';
  drugId: number | null;
  drugName: string;
  targetName: string;
  parameter: string;
  reading: {
    low?: number;
    high?: number;
    median?: number;
    /** A labelled centre, what it is, and what low/high are (stored form). */
    centralValue?: number;
    centralStatistic?: string;
    intervalKind?: string;
    qualifier?: string;
    unit: string;
    matrix?: string;
    scenario?: string;
    n?: number;
  };
  current: { value: unknown; entryCount: number } | null;
  comments: string | null;
  quote: string | null;
}

interface WikiFactItemPlan extends ItemPlanCommon {
  type: 'wiki_fact';
  pageId: number | null;
  pageTitle: string | null;
  pageType: string | null;
  sectionId: string;
  operation: 'add' | 'replace' | 'remove';
  statement: string | null;
  existingStatement: string | null;
  existingReferences: Array<{
    id: number;
    type: string;
    identifier: string;
    title: string | null;
  }>;
  sectionFactCount: number;
  unverifiedSourceKeys: string[];
}

interface TopicPageItemPlan extends ItemPlanCommon {
  type: 'topic_page_proposal';
  slug: string;
  title: string;
  sectionCount: number;
  factCount: number;
  rationale: string;
  sections: Array<{
    sectionId: string;
    titleNb: string;
    facts: Array<{ statement: string; sourceKeys: string[] }>;
  }>;
  parent: { slug: string; title: string } | null;
  categories: { matched: string[]; dropped: string[] };
}

type ItemPlan = ParameterItemPlan | WikiFactItemPlan | TopicPageItemPlan;

interface SourcePlan {
  key: string;
  type: string;
  identifier: string;
  title: string | null;
  metadata: { authors: string[]; journal: string | null; year: number | null };
  citationId: number | null;
  citationAction: 'reuse' | 'create';
  reviewAction: 'record' | 'keep';
  review: {
    readInFull: boolean;
    locator: string;
    evidenceSummary: string;
    reviewMarkdown: string;
    reviewConfidence: string | null;
    overallScore: number | null;
  } | null;
  replacedReview: { readInFull: boolean; reviewMarkdown: string } | null;
  pdfRequestNeeded: boolean;
  sameAs: string | null;
}

interface BlockedCandidate {
  summary: string;
  blocker: string;
  candidateIdentifier?: string;
}

interface Plan {
  idempotencyKey: string;
  mode: string;
  createdAt: string;
  sources: SourcePlan[];
  items: ItemPlan[];
  blockedCandidates: BlockedCandidate[];
  counts: { ready: number; review: number; duplicate: number; blocked: number };
}

interface AppliedItem {
  index: number;
  status: 'applied' | 'queued' | 'skipped' | 'failed';
  reason: string | null;
  detail: string | null;
  createdId: number | null;
}

interface ApplyResult {
  citationsCreated: number;
  reviewsRecorded: number;
  items: AppliedItem[];
  counts: { applied: number; queued: number; skipped: number; failed: number };
}

interface IngestionMessage {
  code: string;
  where: string;
  params: Record<string, string | number>;
}

interface ApiResponse {
  ok: boolean;
  applied?: boolean;
  plan?: Plan;
  result?: ApplyResult;
  warnings?: string[];
  warningDetails?: IngestionMessage[];
  errors?: string[];
  errorDetails?: IngestionMessage[];
  error?: string;
  code?: string;
}

/**
 * Admin → Ingest conversation.
 *
 * The bundle a chat assistant produced is never applied wholesale: the server
 * resolves it against live data and this pane puts every item behind its own
 * checkbox — fact by fact, parameter by parameter, page by page — with what is
 * there now next to what would be written. Only ticked, applicable rows are
 * sent, and the server re-checks each one before writing.
 */
export function ConversationIngestionAdminSection() {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<null | 'plan' | 'apply'>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [warnings, setWarnings] = useState<IngestionMessage[]>([]);
  const [errors, setErrors] = useState<IngestionMessage[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // The exact document the current plan was computed from. Apply sends THIS,
  // not whatever is in the textarea now: the accepted indices point into the
  // analysed document, and an edit made while a request was in flight would
  // otherwise send new items under the old item's approval.
  const [analyzedText, setAnalyzedText] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Only the newest request may install a plan. A slower earlier response
  // arriving after the admin edited the bundle would otherwise present a plan
  // for text that is no longer on screen.
  const requestSeq = useRef(0);

  const resultByIndex = useMemo(() => {
    const map = new Map<number, AppliedItem>();
    result?.items.forEach((r) => map.set(r.index, r));
    return map;
  }, [result]);

  function resetOutput() {
    setPlan(null);
    setResult(null);
    setWarnings([]);
    setErrors([]);
    setErrorMsg('');
    setSelected(new Set());
    setAnalyzedText('');
    // Anything already in flight belongs to the document being replaced. Its
    // response will be dropped, so its `finally` never runs for us — clear the
    // busy flag here or both buttons stay disabled for the life of the pane.
    requestSeq.current += 1;
    setBusy(null);
  }

  function onPickFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setText(typeof reader.result === 'string' ? reader.result : '');
      resetOutput();
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  async function send(action: 'plan' | 'apply') {
    setErrorMsg('');
    setErrors([]);
    // Apply re-sends the analysed document verbatim; only Analyse reads the box.
    const submitted = action === 'apply' ? analyzedText : text;
    let document: unknown;
    try {
      document = JSON.parse(submitted);
    } catch {
      setErrorMsg(t('admin.conversationIngestion.invalidJson'));
      return;
    }
    const seq = (requestSeq.current += 1);
    setBusy(action);
    try {
      const res = await fetch('/api/conversation-ingestion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          action === 'apply'
            ? {
                document,
                action: 'apply',
                accept: [...selected],
                // What the gate showed for each source's review. The server
                // re-decides on its own reading; sending this only lets it
                // refuse an item whose review disposition changed since.
                expectedReviewActions: Object.fromEntries(
                  (plan?.sources ?? []).map((s) => [s.key, s.reviewAction]),
                ),
                // The digest of each row as it was displayed. The server
                // refuses any accepted row whose resolution moved since.
                expectedFingerprints: Object.fromEntries(
                  (plan?.items ?? []).map((i) => [i.index, i.fingerprint]),
                ),
              }
            : { document },
        ),
      });
      const data = (await res.json().catch(() => ({}))) as ApiResponse;
      // Superseded by a newer request (or by an edit to the bundle): drop it.
      if (seq !== requestSeq.current) return;
      // Prefer the coded form; fall back to the rendered English if an older
      // server (or a code this build predates) supplies only the message.
      setErrors(
        data.errorDetails ??
          (data.errors ?? []).map((message) => ({
            code: 'raw',
            where: '',
            params: { message },
          })),
      );
      setWarnings(
        data.warningDetails ??
          (data.warnings ?? []).map((message) => ({
            code: 'raw',
            where: '',
            params: { message },
          })),
      );
      if (!res.ok || data.ok === false) {
        setPlan(null);
        setResult(null);
        setErrorMsg(
          data.errors?.length || data.errorDetails?.length
            ? ''
            : (data.error ?? t('admin.conversationIngestion.requestFailed')),
        );
        return;
      }
      if (data.plan) {
        const nextPlan = data.plan;
        setPlan(nextPlan);
        setAnalyzedText(submitted);
        const stillReady = new Set(
          nextPlan.items
            .filter((i) => SELECTABLE.has(i.disposition))
            .map((i) => i.index),
        );
        if (action === 'plan') {
          // A fresh analysis: everything applicable starts ticked and the admin
          // unticks what they do not want. Nothing else can be ticked at all.
          setSelected(stillReady);
        } else {
          // After an apply the response carries a POST-write plan, and
          // re-ticking everything still ready in it would silently re-enable the
          // items the admin just declined — one more click and they would be
          // written. Carry the decision forward instead: keep what was ticked,
          // drop what no longer applies (what just landed now reads as a
          // duplicate).
          //
          // Except for anything the server actively REFUSED. Those come back
          // `ready` — the state they were refused against is now the current
          // state — so keeping them ticked would let one more click write the
          // very thing the refusal withheld, defeating it entirely.
          //
          // Phrased as "skipped for any reason other than never having been
          // accepted", not as a list of refusal codes: the list version already
          // failed once, when `item_changed` was added and this filter still
          // named only `source_review_changed`. Unticking is the conservative
          // direction, so an unfamiliar reason should land there by default.
          // `failed` keeps its tick — it is visibly failed and worth retrying.
          const needsReconsent = new Set(
            (data.result?.items ?? [])
              .filter((r) => r.status === 'skipped' && r.reason !== 'not_accepted')
              .map((r) => r.index),
          );
          setSelected(
            (prev) =>
              new Set(
                [...prev].filter(
                  (index) => stillReady.has(index) && !needsReconsent.has(index),
                ),
              ),
          );
        }
      }
      if (action === 'apply' && data.result) {
        setResult(data.result);
        showToast(
          t('admin.conversationIngestion.appliedToast', {
            // Both, because both are outcomes the admin asked for: a run of
            // nothing but unverified facts writes no live content and would
            // otherwise report "0 items" after queueing every one of them.
            count: data.result.counts.applied + data.result.counts.queued,
          }),
        );
      }
    } catch {
      if (seq === requestSeq.current) {
        setErrorMsg(t('admin.conversationIngestion.requestFailed'));
      }
    } finally {
      if (seq === requestSeq.current) setBusy(null);
    }
  }

  function toggle(index: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  const readyIndices = plan?.items
    .filter((i) => SELECTABLE.has(i.disposition))
    .map((i) => i.index) ?? [];
  const allReadySelected =
    readyIndices.length > 0 && readyIndices.every((i) => selected.has(i));

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-2">
        {t('admin.conversationIngestion.title')}
      </h2>
      <p className="text-sm text-muted-foreground mb-4 max-w-2xl">
        {t('admin.conversationIngestion.description')}
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={onPickFile}
          className="hidden"
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => fileInputRef.current?.click()}
        >
          {t('admin.conversationIngestion.chooseFile')}
        </Button>
        {text && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              setText('');
              resetOutput();
            }}
          >
            {t('admin.conversationIngestion.clear')}
          </Button>
        )}
      </div>

      {/* Locked while a request is in flight. Replacing the document mid-apply
          would discard the receipt for writes the server has already made, and
          the admin would be looking at a pane that says nothing happened. */}
      <textarea
        value={text}
        disabled={busy !== null}
        onChange={(e) => {
          setText(e.target.value);
          resetOutput();
        }}
        placeholder={t('admin.conversationIngestion.placeholder')}
        spellCheck={false}
        className="w-full h-56 font-mono text-xs rounded-md border border-input bg-background p-3 mb-3 disabled:opacity-70"
      />

      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Button
          onClick={() => send('plan')}
          disabled={!text.trim() || busy !== null}
          variant="outline"
        >
          {busy === 'plan'
            ? t('admin.conversationIngestion.analyzing')
            : t('admin.conversationIngestion.analyze')}
        </Button>
        <Button
          onClick={() => send('apply')}
          disabled={!plan || selected.size === 0 || busy !== null}
          title={!plan ? t('admin.conversationIngestion.analyzeFirst') : undefined}
        >
          {busy === 'apply'
            ? t('admin.conversationIngestion.applying')
            : t('admin.conversationIngestion.apply', { count: selected.size })}
        </Button>
      </div>

      {errorMsg && <p className="text-sm text-red-600 mb-2">{errorMsg}</p>}
      {errors.length > 0 && (
        <div className="mb-3">
          <p className="text-sm font-medium text-red-600 mb-1">
            {t('admin.conversationIngestion.validationFailed')}
          </p>
          <ul className="list-disc pl-5 text-sm text-red-600 space-y-0.5">
            {errors.map((e, i) => (
              <li key={i}>
                {e.where ? <span className="font-mono">{e.where}: </span> : null}
                {t(`admin.conversationIngestion.error.${e.code}`, {
                  ...e.params,
                  defaultValue: String(e.params.message ?? e.code),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {plan && (
        <div className="border border-border rounded-lg p-4 mb-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
            <h3 className="font-semibold">
              {t('admin.conversationIngestion.gateTitle')}
            </h3>
            <span className="text-xs text-muted-foreground">
              {t('admin.conversationIngestion.counts', {
                ready: plan.counts.ready,
                review: plan.counts.review,
                duplicate: plan.counts.duplicate,
                blocked: plan.counts.blocked,
              })}
            </span>
          </div>

          {readyIndices.length > 0 && (
            <label className="flex items-center gap-2 text-sm mb-3">
              <input
                type="checkbox"
                checked={allReadySelected}
                onChange={() =>
                  setSelected(allReadySelected ? new Set() : new Set(readyIndices))
                }
              />
              {t('admin.conversationIngestion.selectAll')}
            </label>
          )}

          <ul className="space-y-2">
            {plan.items.map((item) => (
              <ItemRow
                key={item.index}
                item={item}
                checked={selected.has(item.index)}
                onToggle={() => toggle(item.index)}
                outcome={resultByIndex.get(item.index) ?? null}
                sources={plan.sources}
              />
            ))}
          </ul>

          {plan.sources.length > 0 && (
            <div className="mt-4 pt-3 border-t border-border">
              <p className="text-sm font-medium mb-1">
                {t('admin.conversationIngestion.sources')}
              </p>
              <ul className="text-xs text-muted-foreground space-y-2">
                {plan.sources.map((s) => (
                  <li key={s.key}>
                    <span className="font-mono">
                      {s.key} · {s.type}:{s.identifier}
                    </span>{' '}
                    {s.title ? `— ${s.title} ` : ''}
                    {/* Authors, journal and year are stored too, and they drive
                        reference search and grouping — so they are content the
                        admin is publishing, not decoration. */}
                    {(s.metadata.authors.length > 0 ||
                      s.metadata.journal ||
                      s.metadata.year) && (
                      <span>
                        (
                        {[
                          s.metadata.authors.join(', '),
                          s.metadata.journal,
                          s.metadata.year,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        ){' '}
                      </span>
                    )}
                    <em>
                      {t(
                        `admin.conversationIngestion.source.${s.citationAction}`,
                      )}
                      {' · '}
                      {t(`admin.conversationIngestion.review.${s.reviewAction}`)}
                    </em>
                    {/* The bundle could not obtain this paper's full text, so it
                        backs nothing here. Saying so is the only way the ask
                        reaches anyone — nothing else in this path reads it. */}
                    {s.pdfRequestNeeded && (
                      <span className="text-amber-700 dark:text-amber-400">
                        {' · '}
                        {t('admin.conversationIngestion.pdfRequestNeeded')}
                      </span>
                    )}
                    {/* Two keys, one paper: only the first key's appraisal is
                        written, so say which one rather than promising both. */}
                    {s.sameAs && (
                      <span>
                        {' · '}
                        {t('admin.conversationIngestion.samePaperAs', {
                          key: s.sameAs,
                        })}
                      </span>
                    )}
                    {/* Accepting an item that cites this source publishes the
                        appraisal below in the admin's name, and `readInFull`
                        decides what the paper may back elsewhere in Kinetix.
                        Show the text rather than just the verb. */}
                    {s.review && (
                      <details className="mt-1">
                        <summary className="cursor-pointer">
                          {t(
                            s.reviewAction === 'record'
                              ? 'admin.conversationIngestion.reviewToRecord'
                              : 'admin.conversationIngestion.reviewIfWithdrawn',
                            {
                              readInFull: s.review.readInFull
                                ? t('admin.conversationIngestion.readInFull')
                                : t('admin.conversationIngestion.notReadInFull'),
                            },
                          )}
                        </summary>
                        <p className="mt-1">
                          {t('admin.conversationIngestion.locator')}:{' '}
                          {s.review.locator}
                        </p>
                        <p>
                          {t('admin.conversationIngestion.evidence')}:{' '}
                          {s.review.evidenceSummary}
                        </p>
                        {(s.review.overallScore != null ||
                          s.review.reviewConfidence) && (
                          <p>
                            {t('admin.conversationIngestion.appraisalMeta', {
                              score: s.review.overallScore ?? '—',
                              confidence: s.review.reviewConfidence ?? '—',
                            })}
                          </p>
                        )}
                        <p className="mt-1 whitespace-pre-wrap">
                          {s.review.reviewMarkdown}
                        </p>
                        {s.replacedReview && (
                          <div className="mt-2 border-l-2 border-amber-400 pl-2">
                            <p className="font-medium text-amber-700 dark:text-amber-400">
                              {t('admin.conversationIngestion.replacesReview')}
                            </p>
                            <p className="whitespace-pre-wrap line-through">
                              {s.replacedReview.reviewMarkdown}
                            </p>
                          </div>
                        )}
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="border border-border rounded-lg p-4 mb-3 text-sm">
          <p className="font-medium mb-1">
            {t('admin.conversationIngestion.resultSummary', {
              applied: result.counts.applied,
              queued: result.counts.queued,
              skipped: result.counts.skipped,
              failed: result.counts.failed,
            })}
          </p>
          <p className="text-muted-foreground">
            {t('admin.conversationIngestion.resultSources', {
              citations: result.citationsCreated,
              reviews: result.reviewsRecorded,
            })}
          </p>
        </div>
      )}

      {plan && plan.blockedCandidates.length > 0 && (
        <div className="border border-border rounded-lg p-3 mb-3">
          <p className="text-sm font-medium mb-1">
            {t('admin.conversationIngestion.blockedCandidates', {
              count: plan.blockedCandidates.length,
            })}
          </p>
          <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-1">
            {plan.blockedCandidates.map((c, i) => (
              <li key={i}>
                {c.summary} — <em>{c.blocker}</em>
                {c.candidateIdentifier ? ` (${c.candidateIdentifier})` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="border border-amber-300/60 bg-amber-50 dark:bg-amber-950/20 rounded-lg p-3">
          <p className="text-sm font-medium mb-1">
            {t('admin.conversationIngestion.warnings', { count: warnings.length })}
          </p>
          <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
            {warnings.map((w, i) => (
              <li key={i}>
                {w.where ? <span className="font-mono">{w.where}: </span> : null}
                {t(`admin.conversationIngestion.warning.${w.code}`, {
                  ...w.params,
                  defaultValue: String(w.params.message ?? w.code),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ItemRow({
  item,
  checked,
  onToggle,
  outcome,
  sources,
}: {
  item: ItemPlan;
  checked: boolean;
  onToggle: () => void;
  outcome: AppliedItem | null;
  sources: SourcePlan[];
}) {
  const { t } = useTranslation();
  const selectable = SELECTABLE.has(item.disposition);
  const badgeClass =
    item.disposition === 'ready'
      ? 'text-emerald-700 dark:text-emerald-400'
      : item.disposition === 'review'
        ? 'text-sky-700 dark:text-sky-400'
        : item.disposition === 'duplicate'
          ? 'text-muted-foreground'
          : 'text-amber-700 dark:text-amber-400';

  return (
    <li className="border border-border rounded-md p-3">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1"
          checked={checked}
          disabled={!selectable}
          onChange={onToggle}
          aria-label={t('admin.conversationIngestion.acceptItem', {
            index: item.index + 1,
          })}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2 mb-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {t(`admin.conversationIngestion.itemType.${item.type}`)}
            </span>
            <span className={`text-xs font-medium ${badgeClass}`}>
              {t(`admin.conversationIngestion.disposition.${item.disposition}`)}
            </span>
            {item.reason && (
              <span className="text-xs text-muted-foreground">
                {t(`admin.conversationIngestion.reason.${item.reason}`, {
                  defaultValue: item.reason,
                })}
                {item.detail ? `: ${item.detail}` : ''}
              </span>
            )}
          </div>

          <ItemBody item={item} />

          {/* A ticked row normally publishes. This one does not, and that is
              the single most important thing about it — so it is stated in
              full next to the statement rather than left to a status word. */}
          {/* Which sources went unread is already on the reason chip above, so
              this says only the part a status word cannot: what a tick does. */}
          {item.disposition === 'review' && (
            <p className="mt-1 text-xs text-sky-700 dark:text-sky-400">
              {t('admin.conversationIngestion.goesToReviewQueue')}
            </p>
          )}

          {/* Which paper backs this row. The sources list below the gate names
              them once for the bundle; a reading is only reviewable next to the
              paper it comes from, so name it here too. */}
          {item.sourceKeys.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('admin.conversationIngestion.backedBy')}:{' '}
              {item.sourceKeys
                .map((key) => {
                  const source = sources.find((s) => s.key === key);
                  return source
                    ? `${key} · ${source.type}:${source.identifier}${
                        source.title ? ` — ${source.title}` : ''
                      }`
                    : key;
                })
                .join(' | ')}
            </p>
          )}

          {item.notes.length > 0 && (
            <ul className="mt-1 text-xs text-amber-700 dark:text-amber-400 space-y-0.5">
              {item.notes.map((n) => (
                <li key={n}>
                  {t(`admin.conversationIngestion.note.${n}`, { defaultValue: n })}
                </li>
              ))}
            </ul>
          )}

          {item.editSummary && (
            <p className="mt-1 text-xs text-muted-foreground italic">
              {item.editSummary}
            </p>
          )}

          {outcome && (
            <p className="mt-1 text-xs font-medium">
              {t(`admin.conversationIngestion.outcome.${outcome.status}`)}
              {outcome.reason
                ? ` — ${t(`admin.conversationIngestion.reason.${outcome.reason}`, {
                    defaultValue: outcome.reason,
                  })}`
                : ''}
              {outcome.detail ? `: ${outcome.detail}` : ''}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

function ItemBody({ item }: { item: ItemPlan }) {
  const { t } = useTranslation();

  if (item.type === 'parameter_observation') {
    return (
      <div className="text-sm">
        <p>
          <strong>{item.drugName}</strong> · {item.parameter}
          {item.targetName && item.targetName !== item.drugName && (
            // The row the write lands on is the one shown in bold; say so when
            // the bundle called it something else, rather than echoing the
            // bundle's label over a different drug.
            <span className="text-muted-foreground">
              {' '}
              {t('admin.conversationIngestion.bundleCalledIt', {
                name: item.targetName,
              })}
            </span>
          )}
        </p>
        <p className="text-muted-foreground">
          {t('admin.conversationIngestion.observation')}:{' '}
          {formatReading(item.reading, t)}
          {item.reading.n ? ` (n=${item.reading.n})` : ''}
        </p>
        <p className="text-muted-foreground">
          {t('admin.conversationIngestion.currentValue')}:{' '}
          {item.current
            ? `${formatRange(item.current.value as NumericRange) || '—'} · ${t(
                'admin.conversationIngestion.entryCount',
                { count: item.current.entryCount },
              )}`
            : t('admin.conversationIngestion.noCurrentValue')}
        </p>
        {/* The source's own words for this value. Shown OPEN rather than behind
            a disclosure, and above the study context, because it is the one
            thing on this card that has to be read against the reading printed
            above it: ticking a purported verbatim quotation without seeing it
            beside the number it certifies is the review failure this field was
            added to prevent. */}
        {item.quote && (
          <div className="mt-1 text-xs">
            <span className="text-muted-foreground">
              {t('admin.conversationIngestion.sourceQuote', {
                defaultValue: 'Source quote',
              })}
            </span>
            <p className="border-l-2 border-border pl-2 italic">{item.quote}</p>
          </div>
        )}
        {/* The study context is stored verbatim on the entry, so it is content
            the admin is publishing — not metadata. Show it before the tick. */}
        {item.comments && (
          <details className="mt-1 text-xs text-muted-foreground">
            <summary className="cursor-pointer">
              {t('admin.conversationIngestion.storedContext')}
            </summary>
            <p className="mt-1 whitespace-pre-wrap">{item.comments}</p>
          </details>
        )}
      </div>
    );
  }

  if (item.type === 'wiki_fact') {
    return (
      <div className="text-sm">
        <p>
          <strong>{item.pageTitle ?? t('admin.conversationIngestion.newMonograph')}</strong>{' '}
          · {item.sectionId} ·{' '}
          {t(`admin.conversationIngestion.operation.${item.operation}`)}
        </p>
        {item.statement && <p className="mt-1">{item.statement}</p>}
        {item.existingStatement && (
          <p className="mt-1 text-muted-foreground line-through">
            {item.existingStatement}
          </p>
        )}
        {/* Replacing a fact swaps its citations for the bundle's; removing it
            deletes them. Either way this is provenance the admin is dropping,
            so it belongs on the row and not only in the page's history. */}
        {item.existingReferences.length > 0 && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            {t('admin.conversationIngestion.citationsDropped')}:{' '}
            {item.existingReferences
              .map(
                (c) =>
                  `${c.type}:${c.identifier}${c.title ? ` — ${c.title}` : ''}`,
              )
              .join(' | ')}
          </p>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {t('admin.conversationIngestion.sectionFacts', {
            count: item.sectionFactCount,
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="text-sm">
      <p>
        <strong>{item.title}</strong> · /{item.slug}
      </p>
      <p className="text-muted-foreground">
        {t('admin.conversationIngestion.pageShape', {
          sections: item.sectionCount,
          facts: item.factCount,
        })}
      </p>
      {/* Accepting this publishes every sentence below, so every sentence is
          shown. A count is not something an admin can review. */}
      <ul className="mt-2 space-y-2">
        {item.sections.map((section, i) => (
          <li key={`${section.sectionId}-${i}`}>
            <p className="font-medium">
              {section.titleNb}{' '}
              <span className="font-mono text-xs text-muted-foreground">
                #{section.sectionId}
              </span>
            </p>
            <ul className="list-disc pl-5 space-y-0.5">
              {section.facts.map((fact, j) => (
                <li key={j}>
                  {fact.statement}
                  {fact.sourceKeys.length > 0 && (
                    <span className="text-xs text-muted-foreground font-mono">
                      {' '}
                      [{fact.sourceKeys.join(', ')}]
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground mt-2">
        {t('admin.conversationIngestion.pageParent')}:{' '}
        {item.parent
          ? `${item.parent.title} (/${item.parent.slug})`
          : t('admin.conversationIngestion.noParent')}
      </p>
      {(item.categories.matched.length > 0 ||
        item.categories.dropped.length > 0) && (
        <p className="text-xs text-muted-foreground">
          {t('admin.conversationIngestion.pageCategories')}:{' '}
          {item.categories.matched.join(', ') || '—'}
          {item.categories.dropped.length > 0 && (
            <span className="text-amber-700 dark:text-amber-400">
              {' · '}
              {t('admin.conversationIngestion.categoriesDropped', {
                names: item.categories.dropped.join(', '),
              })}
            </span>
          )}
        </p>
      )}
      <p className="text-xs text-muted-foreground italic mt-2">{item.rationale}</p>
    </div>
  );
}

/**
 * "0.18–0.30 fraction" / "0.24 fraction" / "0.54 (0.42–0.66) h · arithmetic
 * mean · interval: SD" — the reading as it would be stored, including what a
 * labelled centre and its bounds are.
 */
function formatReading(reading: ParameterItemPlan['reading'], t: TFunction): string {
  const { low, high, median, centralValue, centralStatistic, intervalKind, qualifier, unit, matrix, scenario } =
    reading;
  const span =
    centralValue != null
      ? low != null && high != null
        ? `${centralValue} (${low}–${high})`
        : `${centralValue}`
      : low != null && high != null
        ? `${low}–${high}`
        : (median ?? low ?? high ?? '').toString();
  const parts = [
    [qualifier, span].filter(Boolean).join(' '),
    unit,
    centralStatistic ? t(`doseContext.values.centralStatistic.${centralStatistic}`) : null,
    intervalKind
      ? t('doseContext.interval', { kind: t(`doseContext.values.intervalKind.${intervalKind}`) })
      : null,
    matrix,
    scenario,
  ].filter(Boolean);
  return parts.join(' · ');
}
