import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ExternalLink,
  FileText,
  Loader2,
  RotateCcw,
  Upload,
  X,
} from 'lucide-react';
import { AuthGuard } from '@/components/AuthGuard';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ReferenceInput } from '@/components/wiki/ReferenceInput';
import {
  citationExternalHref,
  citationTooltipLabel,
  citationTooltipTitle,
} from '@/lib/citationFormat';
import { isDefinitelyNotPdf, useFileDropZone } from '@/lib/useFileDropZone';
import { useCan } from '@/lib/usePermissions';
import {
  createPdfRequest,
  referenceModulePath,
  uploadCitationPdf,
  waitForCitationPdf,
  PdfFulfillError,
} from '@/lib/referencesApi';
import {
  enqueuePaperExtraction,
  fetchPaperExtractionJobs,
  jobCitation,
  updatePaperExtractionJob,
  PaperExtractionApiError,
  type PaperExtractionJob,
} from '@/lib/paperExtractionApi';
import type { ReferenceRow } from '@/lib/referenceApi';
import { showToast } from '@/lib/toast';

/** Server error codes → localized message keys. */
const ERROR_CODE_KEYS: Record<string, string> = {
  pdf_not_a_pdf: 'referenceModule.pdfNotAPdf',
  pdf_too_large: 'referenceModule.pdfTooLarge',
  pdf_upload_pending: 'referenceModule.pdfUploadPending',
  pdf_request_not_open: 'referenceModule.pdfRequestNotOpen',
  pdf_storage_unavailable: 'referenceModule.pdfStorageUnavailable',
  paper_extraction_missing_pdf: 'paperExtraction.errorMissingPdf',
  paper_extraction_already_queued: 'paperExtraction.errorAlreadyQueued',
  paper_extraction_unresolvable_citation:
    'paperExtraction.errorUnresolvableCitation',
  paper_extraction_citation_not_found: 'paperExtraction.errorCitationNotFound',
  paper_extraction_illegal_transition: 'paperExtraction.errorIllegalTransition',
  paper_extraction_conflict: 'paperExtraction.errorConflict',
  pdf_replace_requires_editor: 'paperExtraction.errorReplaceRequiresEditor',
  pdf_replace_extraction_in_flight:
    'paperExtraction.errorReplaceExtractionInFlight',
};

const STATUS_CLASSES: Record<string, string> = {
  queued: 'bg-muted text-muted-foreground',
  claimed: 'bg-primary/15 text-primary',
  completed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  failed: 'bg-destructive/15 text-destructive',
  cancelled: 'bg-muted text-muted-foreground line-through',
};

function StatusBadge({ status }: { status: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        STATUS_CLASSES[status] ?? 'bg-muted text-muted-foreground'
      }`}
    >
      {t(`paperExtraction.status.${status}`, status)}
    </span>
  );
}

/**
 * Step 1–3 of queueing a paper: identify it, upload its full text, hand it to
 * the agent.
 *
 * The three steps are deliberately the *existing* rails rather than a new
 * upload path: `ReferenceInput` mints the citation (resolving the DOI/PMID
 * against PubMed/CrossRef so the title is real), `uploadCitationPdf` pushes the
 * bytes straight from the browser to Vercel Blob against a self-provisioned PDF
 * request, and only the last step — the enqueue — is new.
 */
function EnqueuePanel({
  onQueued,
}: {
  onQueued: (job: PaperExtractionJob) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [reference, setReference] = useState<ReferenceRow | null>(null);
  const [hasPdf, setHasPdf] = useState(false);
  const [scopeNote, setScopeNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const canUpload = Boolean(reference) && !hasPdf && !busy;
  const { dragActive, dropProps } = useFileDropZone(
    (file) => void handleFile(file),
    canUpload,
  );

  function fail(code: string): void {
    const key = ERROR_CODE_KEYS[code];
    setFeedback(key ? t(key) : t('paperExtraction.errorGeneric'));
    setFeedbackError(true);
  }

  function reset(): void {
    setReference(null);
    setHasPdf(false);
    setScopeNote('');
    setFeedback(null);
    setFeedbackError(false);
  }

  async function handleReferenceCreated(ref: ReferenceRow): Promise<void> {
    setReference(ref);
    setFeedback(null);
    setFeedbackError(false);
    // The paper may already have full text on file (another editor supplied it,
    // or an agent fulfilled an older PDF request). Skip straight to the enqueue
    // step rather than asking for an upload that would be thrown away.
    const state = await waitForCitationPdf(ref.id, { attempts: 1 }).catch(
      () => ({ request: null, hasPdf: false }),
    );
    setHasPdf(state.hasPdf);
  }

  async function handleFile(file: File | undefined): Promise<void> {
    if (!file || !reference || busy) return;
    if (isDefinitelyNotPdf(file)) {
      setFeedback(t('referenceModule.fileNotAPdf'));
      setFeedbackError(true);
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      // The upload routes require an open PDF request; self-provision one the
      // same way the reference page does.
      await createPdfRequest(reference.id);
      await uploadCitationPdf(reference.id, file);
      const next = await waitForCitationPdf(reference.id);
      if (!next.hasPdf) throw new PdfFulfillError('pdf_upload_pending');
      setHasPdf(true);
      setFeedback(t('paperExtraction.uploadDone'));
      setFeedbackError(false);
    } catch (err) {
      fail(err instanceof PdfFulfillError ? err.code : 'unknown');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleEnqueue(): Promise<void> {
    if (!reference || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      const job = await enqueuePaperExtraction(reference.id, { scopeNote });
      onQueued(job);
      showToast(t('paperExtraction.queued'));
      reset();
    } catch (err) {
      fail(err instanceof PaperExtractionApiError ? err.code : 'unknown');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-border p-4">
      <h2 className="text-lg font-semibold">{t('paperExtraction.addTitle')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('paperExtraction.addSubtitle')}
      </p>

      <div className="mt-4 space-y-4">
        <div>
          <h3 className="text-sm font-medium">
            {t('paperExtraction.stepIdentify')}
          </h3>
          {reference ? (
            <div className="mt-2 flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2 text-sm">
              <span className="min-w-0 break-words">
                {reference.metadata?.title?.trim() || reference.identifier}
              </span>
              <Button variant="ghost" size="sm" onClick={reset}>
                {t('paperExtraction.change')}
              </Button>
            </div>
          ) : (
            <div className="mt-2">
              {/* A paper the agent must read in full needs a retrievable
                  identifier, so the free-text tab is not offered here. */}
              <ReferenceInput
                allowedTypes={['pmid', 'doi']}
                onReferenceCreated={(ref) => void handleReferenceCreated(ref)}
              />
            </div>
          )}
        </div>

        {reference && (
          <div>
            <h3 className="text-sm font-medium">
              {t('paperExtraction.stepUpload')}
            </h3>
            {hasPdf ? (
              <p className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                {t('paperExtraction.fullTextOnFile')}
              </p>
            ) : (
              <div
                {...dropProps}
                data-testid="paper-extraction-dropzone"
                className={`mt-2 flex flex-col items-start gap-2 rounded-md border border-dashed p-4 transition-colors ${
                  dragActive
                    ? 'border-primary bg-primary/10'
                    : 'border-border bg-muted/30'
                }`}
              >
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={(e) => void handleFile(e.target.files?.[0])}
                />
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="mr-2 h-4 w-4" />
                  {busy
                    ? t('referenceModule.uploading')
                    : dragActive
                      ? t('referenceModule.dropPdf')
                      : t('referenceModule.uploadPdf')}
                </Button>
                <p className="text-xs text-muted-foreground">
                  {t('referenceModule.dragHint')}
                </p>
              </div>
            )}
          </div>
        )}

        {reference && hasPdf && (
          <div>
            <h3 className="text-sm font-medium">
              {t('paperExtraction.stepQueue')}
            </h3>
            <label
              className="mt-2 block text-xs text-muted-foreground"
              htmlFor="paper-extraction-scope"
            >
              {t('paperExtraction.scopeNoteLabel')}
            </label>
            <Input
              id="paper-extraction-scope"
              className="mt-1"
              value={scopeNote}
              disabled={busy}
              maxLength={1000}
              placeholder={t('paperExtraction.scopeNotePlaceholder')}
              onChange={(e) => setScopeNote(e.target.value)}
            />
            <Button
              className="mt-3"
              disabled={busy}
              onClick={() => void handleEnqueue()}
            >
              {busy ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              {t('paperExtraction.queueIt')}
            </Button>
          </div>
        )}

        {feedback && (
          <p
            className={`text-sm ${
              feedbackError ? 'text-destructive' : 'text-muted-foreground'
            }`}
          >
            {feedback}
          </p>
        )}
      </div>
    </section>
  );
}

function JobRow({
  job,
  onChanged,
  dateFmt,
  citationHasOpenJob,
}: {
  job: PaperExtractionJob;
  onChanged: (job: PaperExtractionJob) => void;
  dateFmt: Intl.DateTimeFormat;
  /**
   * Another job for the SAME citation is queued or claimed. The stored PDF
   * belongs to the citation, not to one job, so replacing it from a settled
   * card would change what that open job was queued with.
   */
  citationHasOpenJob: boolean;
}): JSX.Element {
  const { t } = useTranslation();
  // Reading the queue and steering it are separate capabilities, so a caller
  // who can see these cards does not necessarily hold the buttons on them.
  const canManage = useCan('paperExtraction.manage');
  const canReplacePdf = useCan('citation.pdf.replace');
  const [busy, setBusy] = useState(false);
  const replaceRef = useRef<HTMLInputElement>(null);
  const citation = jobCitation(job);
  const sourceHref = citationExternalHref(citation);
  const open = job.status === 'queued' || job.status === 'claimed';
  const requeueable =
    job.status === 'failed' ||
    job.status === 'cancelled' ||
    job.status === 'completed';
  // Wherever a job can be re-queued, its input can be fixed first. Scoping the
  // replacement to `failed` was too narrow: an editor who cancels a job
  // *because* they spotted the wrong paper lands on `cancelled`, and one who
  // reads a completed run's summary and realizes it read the wrong paper lands
  // on `completed` — both could then only re-queue the same bad PDF. Cancelling
  // is if anything the stronger signal, being a human judgement rather than an
  // agent failure.
  //
  // Withheld while ANY job for this citation is open, not merely this one: the
  // PDF is citation-level, so swapping it from a settled card would silently
  // change the input a queued job was created with — or, once claimed, the
  // bytes a run is reading. A citation routinely has settled history beside a
  // newer open job, so this is reachable from these very cards. The API
  // enforces the same rule; this only keeps the button from lying.
  const replaceable = requeueable && !citationHasOpenJob && canReplacePdf;

  async function act(
    payload: { action: 'cancel' } | { action: 'requeue' },
  ): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      onChanged(await updatePaperExtractionJob(job.id, payload));
    } catch (err) {
      const code =
        err instanceof PaperExtractionApiError ? err.code : 'unknown';
      const key = ERROR_CODE_KEYS[code];
      showToast(key ? t(key) : t('paperExtraction.errorGeneric'));
    } finally {
      setBusy(false);
    }
  }

  async function replacePdf(file: File | undefined): Promise<void> {
    if (!file || busy) return;
    if (isDefinitelyNotPdf(file)) {
      showToast(t('referenceModule.fileNotAPdf'));
      return;
    }
    setBusy(true);
    try {
      // Reopen the (satisfied) request so the upload token can be minted, then
      // upload; the storage layer upserts on citation id and drops the old blob.
      await createPdfRequest(job.citationId, { replace: true });
      await uploadCitationPdf(job.citationId, file);
      const next = await waitForCitationPdf(job.citationId);
      if (!next.hasPdf) throw new PdfFulfillError('pdf_upload_pending');
      showToast(t('paperExtraction.replaceDone'));
    } catch (err) {
      const code = err instanceof PdfFulfillError ? err.code : 'unknown';
      const key = ERROR_CODE_KEYS[code];
      showToast(key ? t(key) : t('paperExtraction.errorGeneric'));
    } finally {
      setBusy(false);
      if (replaceRef.current) replaceRef.current.value = '';
    }
  }

  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            to={referenceModulePath(job.citationId)}
            className="flex items-start gap-2 font-medium hover:underline"
          >
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 break-words">
              {citationTooltipTitle(citation)}
            </span>
          </Link>
          <p className="mt-1 text-sm text-muted-foreground">
            {citationTooltipLabel(citation)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <StatusBadge status={job.status} />
          {sourceHref && (
            <a
              href={sourceHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              {t('pdfRequests.openSource')}
            </a>
          )}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
        <div>
          {t('paperExtraction.queuedBy', {
            user: job.requestedByUsername ?? '—',
            date: dateFmt.format(new Date(job.createdAt)),
          })}
        </div>
        {job.claimedByUsername && (
          <div>
            {t('paperExtraction.claimedBy', { user: job.claimedByUsername })}
          </div>
        )}
        {job.attempts > 0 && (
          <div>{t('paperExtraction.attempts', { count: job.attempts })}</div>
        )}
        {job.factsSubmitted !== null && (
          <div>
            {t('paperExtraction.factsSubmitted', {
              count: job.factsSubmitted,
            })}
          </div>
        )}
        {/* Whether the paper is already appraised tells the editor how much
            work the run still has to do before it can cite anything: without a
            read-in-full review the agent must write one first. */}
        <div>
          {job.hasPaperReview
            ? t('paperExtraction.reviewOnFile')
            : t('paperExtraction.reviewPending')}
        </div>
      </dl>

      {job.scopeNote && (
        <p className="mt-2 text-sm">
          <span className="font-medium">
            {t('paperExtraction.scopeNoteLabel')}:{' '}
          </span>
          {job.scopeNote}
        </p>
      )}
      {job.resultSummary && (
        <p className="mt-2 whitespace-pre-wrap rounded-md bg-muted/40 px-3 py-2 text-sm">
          {job.resultSummary}
        </p>
      )}
      {job.lastError && (
        <p className="mt-2 text-sm text-destructive">
          {t('paperExtraction.lastError')}: {job.lastError}
        </p>
      )}

      <div className="mt-3 flex gap-2">
        {open && canManage && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void act({ action: 'cancel' })}
          >
            <X className="mr-1.5 h-3.5 w-3.5" />
            {t('paperExtraction.cancel')}
          </Button>
        )}
        {replaceable && (
          <>
            <input
              ref={replaceRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              data-testid={`replace-pdf-${job.id}`}
              onChange={(e) => void replacePdf(e.target.files?.[0])}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => replaceRef.current?.click()}
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {t('paperExtraction.replacePdf')}
            </Button>
          </>
        )}
        {requeueable && canManage && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void act({ action: 'requeue' })}
          >
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            {t('paperExtraction.requeue')}
          </Button>
        )}
      </div>
    </li>
  );
}

function PaperExtractionQueueContent(): JSX.Element {
  const { t, i18n } = useTranslation();
  // Queueing a paper is the same capability as steering the queue, and it is
  // separate from reading it — the guard above admits readers too.
  const canManage = useCan('paperExtraction.manage');
  const [jobs, setJobs] = useState<PaperExtractionJob[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  // Citations with a queued/claimed job anywhere in the list. The stored PDF is
  // citation-level, so a settled card must not offer to replace it while a
  // sibling job for the same paper is still waiting or being read.
  const citationsWithOpenJobs = useMemo(
    () =>
      new Set(
        (jobs ?? [])
          .filter((j) => j.status === 'queued' || j.status === 'claimed')
          .map((j) => j.citationId),
      ),
    [jobs],
  );

  const dateFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      }),
    [i18n.language],
  );

  const load = useCallback(async () => {
    try {
      setJobs(await fetchPaperExtractionJobs());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function upsert(job: PaperExtractionJob): void {
    setJobs((prev) => {
      if (!prev) return prev;
      const index = prev.findIndex((j) => j.id === job.id);
      // An enqueue returns the bare row (no citation join), so re-read the list
      // rather than rendering a half-populated card.
      if (index === -1) {
        void load();
        return prev;
      }
      const next = [...prev];
      next[index] = { ...next[index], ...job };
      return next;
    });
  }

  return (
    <div className="flex-1 bg-background">
      <main className="mx-auto max-w-4xl space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold">{t('paperExtraction.title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('paperExtraction.subtitle')}
          </p>
        </div>

        {canManage && <EnqueuePanel onQueued={upsert} />}

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">
              {t('paperExtraction.queueTitle')}
            </h2>
            <Link
              to="/review"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('nav.review')}
            </Link>
          </div>

          {loadError ? (
            <p className="text-sm text-destructive">
              {t('paperExtraction.loadFailed')}
            </p>
          ) : jobs === null ? (
            <p className="text-sm text-muted-foreground">
              {t('paperExtraction.loading')}
            </p>
          ) : jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t('paperExtraction.empty')}
            </p>
          ) : (
            <ul className="space-y-3">
              {jobs.map((job) => (
                <JobRow
                  key={job.id}
                  job={job}
                  onChanged={upsert}
                  dateFmt={dateFmt}
                  citationHasOpenJob={citationsWithOpenJobs.has(job.citationId)}
                />
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

export function PaperExtractionQueuePage(): JSX.Element {
  return (
    <AuthGuard requiredCapability="paperExtraction.queue.read">
      <PaperExtractionQueueContent />
    </AuthGuard>
  );
}
