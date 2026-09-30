import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, ExternalLink, FileText, Loader2, Upload } from 'lucide-react';
import { useCan } from '@/lib/usePermissions';
import { isDefinitelyNotPdf, useFileDropZone } from '@/lib/useFileDropZone';
import {
  citationExternalHref,
  citationTooltipLabel,
  citationTooltipTitle,
} from '@/lib/citationFormat';
import {
  createPdfRequest,
  fetchPdfQueue,
  referenceModulePath,
  uploadCitationPdf,
  waitForCitationPdf,
  PdfFulfillError,
  type CitationRow,
  type FullTextGapRow,
  type OpenPdfRequestRow,
  type PdfQueue,
} from '@/lib/referencesApi';

/** How many source pages the "open" button spawns per click. */
const OPEN_SOURCES_BATCH = 20;

/** Up to `n` distinct items chosen uniformly at random (partial Fisher-Yates). */
function pickRandom<T>(items: readonly T[], n: number): T[] {
  const pool = [...items];
  const take = Math.min(n, pool.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    const picked = pool[j] as T;
    pool[j] = pool[i] as T;
    pool[i] = picked;
  }
  return pool.slice(0, take);
}

/** Server error codes → localized message keys (shared with CitationPdfSection). */
const PDF_ERROR_CODE_KEYS: Record<string, string> = {
  pdf_not_a_pdf: 'referenceModule.pdfNotAPdf',
  pdf_too_large: 'referenceModule.pdfTooLarge',
  pdf_upload_pending: 'referenceModule.pdfUploadPending',
  pdf_request_not_open: 'referenceModule.pdfRequestNotOpen',
  pdf_storage_unavailable: 'referenceModule.pdfStorageUnavailable',
};

/**
 * Both queue classes flattened to what a row needs to render and upload.
 * `requested` rows carry an open `pdf_requests` row — an agent hit a paywall,
 * or a contributor asked. `gap` rows carry none: the paper is simply cited
 * with no full text and no completed review, which is exactly what its own
 * reference page already says. The only behavioural difference is that a gap
 * must self-provision its request before the upload routes will accept bytes.
 */
interface QueueRow {
  key: string;
  origin: 'requested' | 'gap';
  citationId: number;
  reason: string | null;
  /** Request creation for a request; citation creation for a gap. */
  since: string;
  /** Gap rows only: a closed request proves somebody already reached this. */
  previouslyRequested: boolean;
  /** A bulk-dropped PDF matched to this paper is waiting in the inbox. */
  pdfInInbox: boolean;
  citation: CitationRow;
}

function toCitationRow(
  citationId: number,
  type: CitationRow['type'],
  identifier: string,
  metadata: CitationRow['metadata'],
  createdAt: string,
): CitationRow {
  return { id: citationId, drugId: null, type, identifier, metadata, createdAt };
}

function requestToQueueRow(row: OpenPdfRequestRow): QueueRow {
  return {
    key: `request-${row.id}`,
    origin: 'requested',
    citationId: row.citationId,
    reason: row.reason,
    since: row.createdAt,
    previouslyRequested: true,
    pdfInInbox: row.pdfInInbox === true,
    citation: toCitationRow(
      row.citationId,
      row.citationType,
      row.citationIdentifier,
      row.citationMetadata,
      row.createdAt,
    ),
  };
}

function gapToQueueRow(row: FullTextGapRow): QueueRow {
  return {
    key: `gap-${row.citationId}`,
    origin: 'gap',
    citationId: row.citationId,
    reason: null,
    since: row.citationCreatedAt,
    previouslyRequested: row.previouslyRequested,
    pdfInInbox: row.pdfInInbox === true,
    citation: toCitationRow(
      row.citationId,
      row.citationType,
      row.citationIdentifier,
      row.citationMetadata,
      row.citationCreatedAt,
    ),
  };
}

type UploadStatus = 'idle' | 'uploading' | 'success' | 'error';

/**
 * A single queue entry rendered as an inline drag-and-drop upload target.
 * Dropping a PDF anywhere on the row — or clicking the button to pick a file —
 * uploads it straight through `uploadCitationPdf`, so a contributor can clear
 * several papers in a row without opening each reference sub-page. A `gap` row
 * has no open request, and the upload routes require one, so it self-provisions
 * first — the same `ensureRequest` step the reference page's own upload does.
 */
function PdfRequestItem({
  row,
  mayFulfill,
  dateFmt,
}: {
  row: QueueRow;
  mayFulfill: boolean;
  dateFmt: Intl.DateTimeFormat;
}): JSX.Element {
  const { t } = useTranslation();
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const citation = row.citation;
  const sourceHref = citationExternalHref(citation);

  // The drop target only accepts input while it can still take an upload.
  const interactive = mayFulfill && status !== 'uploading' && status !== 'success';
  const { dragActive, dropProps } = useFileDropZone(
    (file) => void upload(file),
    interactive,
  );

  async function upload(file: File | undefined): Promise<void> {
    if (!file || status === 'uploading') return;
    if (isDefinitelyNotPdf(file)) {
      setErrorMsg(t('referenceModule.fileNotAPdf'));
      setStatus('error');
      return;
    }
    setStatus('uploading');
    setErrorMsg(null);
    try {
      // A gap has no request to fulfil; open one so the upload is accepted and
      // the resulting fulfilled request lands in the agent's follow-up queue.
      if (row.origin === 'gap') await createPdfRequest(row.citationId);
      await uploadCitationPdf(row.citationId, file);
      const next = await waitForCitationPdf(row.citationId);
      if (!next.hasPdf) throw new PdfFulfillError('pdf_upload_pending');
      setStatus('success');
    } catch (err) {
      const code = err instanceof PdfFulfillError ? err.code : 'unknown';
      const key = PDF_ERROR_CODE_KEYS[code];
      setErrorMsg(key ? t(key) : t('referenceModule.fulfillFailed'));
      setStatus('error');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <li
      {...dropProps}
      className={`rounded-md py-4 transition-colors ${
        dragActive ? 'bg-accent ring-2 ring-primary' : ''
      } ${status === 'success' ? 'opacity-70' : ''}`}
    >
      <div className="flex items-start justify-between gap-4 px-1">
        <div className="min-w-0">
          <Link
            to={referenceModulePath(row.citationId)}
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
          {row.reason && (
            <p className="mt-1 text-sm">
              <span className="font-medium text-muted-foreground">
                {t('pdfRequests.reason')}:{' '}
              </span>
              {row.reason}
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            {t(
              row.origin === 'gap'
                ? 'pdfRequests.citedSince'
                : 'pdfRequests.requestedOn',
              { date: dateFmt.format(new Date(row.since)) },
            )}
          </p>
          {/* A gap whose request was closed rather than never filed: somebody
              did reach this paper, so the section's "nobody has asked yet"
              framing would be false for it. */}
          {row.origin === 'gap' && row.previouslyRequested && (
            <p className="mt-1 text-xs text-muted-foreground">
              {t('pdfRequests.previouslyRequested')}
            </p>
          )}
          {/* Somebody has already supplied this paper in bulk; it only needs
              confirming. Saying so here is the difference between one click
              and another trip to the library proxy. */}
          {row.pdfInInbox && (
            <p className="mt-1 text-xs font-medium text-sky-700 dark:text-sky-400">
              {t('pdfRequests.waitingInInbox')}{' '}
              <Link to="/pdf-inbox" className="underline">
                {t('pdfInbox.title')}
              </Link>
            </p>
          )}
          {status === 'error' && errorMsg && (
            <p className="mt-1 text-sm text-destructive">{errorMsg}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            {sourceHref && (
              <a
                href={sourceHref}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
              >
                <ExternalLink className="h-4 w-4" />
                {t('pdfRequests.openSource')}
              </a>
            )}
            {mayFulfill && (
              <>
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/pdf"
                  className="hidden"
                  onChange={(e) => void upload(e.target.files?.[0])}
                />
                <button
                  type="button"
                  disabled={status === 'uploading' || status === 'success'}
                  onClick={() => fileRef.current?.click()}
                  title={t('pdfRequests.fulfillHint')}
                  aria-label={t('pdfRequests.fulfillHint')}
                  className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                    status === 'success'
                      ? 'border-transparent bg-emerald-600 text-white'
                      : dragActive
                        ? 'border-primary bg-primary/10 ring-2 ring-primary'
                        : 'border-border hover:bg-accent'
                  } ${status === 'uploading' ? 'opacity-70' : ''}`}
                >
                  {status === 'uploading' ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t('pdfRequests.uploading')}
                    </>
                  ) : status === 'success' ? (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      {t('pdfRequests.uploaded')}
                    </>
                  ) : (
                    <>
                      <Upload className="h-4 w-4" />
                      {dragActive
                        ? t('pdfRequests.dropHint')
                        : t('pdfRequests.fulfill')}
                    </>
                  )}
                </button>
              </>
            )}
          </div>
          {/* Static affordance so contributors know the row itself is a drop
              target — the button need not be clicked. Hidden once an upload is
              in flight or done, and while dragging (the button already reads
              "Drop to upload" then). */}
          {mayFulfill && status !== 'uploading' && status !== 'success' && !dragActive && (
            <p className="text-right text-xs text-muted-foreground">
              {t('pdfRequests.dragHint')}
            </p>
          )}
        </div>
      </div>
    </li>
  );
}

export function PdfRequestsPage(): JSX.Element {
  const { t } = useTranslation();
  const mayUpload = useCan('citation.pdf.access');
  // A gap row POSTs a request before uploading, so clearing one needs the
  // request capability on top of upload access — the same pair the reference
  // page's self-service upload requires. An open request needs only the upload.
  const mayOpenRequest = useCan('pdfRequest.create');
  const mayDropInBulk = useCan('pdfInbox.upload');

  const [queue, setQueue] = useState<PdfQueue | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPdfQueue()
      .then((next) => {
        if (!cancelled) setQueue(next);
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setQueue({ requests: [], gaps: [], gapTotal: 0 });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dateFmt = useMemo(
    () => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }),
    [],
  );

  const requestRows = useMemo(
    () => (queue?.requests ?? []).map(requestToQueueRow),
    [queue],
  );
  const gapRows = useMemo(
    () => (queue?.gaps ?? []).map(gapToQueueRow),
    [queue],
  );

  // External "PDF download" pages (publisher DOI / PubMed / source URL) for the
  // open requests, in queue order. Freetext rows carry no stable link and drop
  // out here. Scoped to requests deliberately: the gap list can run to
  // hundreds, and "open all" spawning that many tabs helps nobody.
  // Rows whose PDF already waits in the inbox stay in the queue for
  // confirmation but need no publisher page, so they don't spend a slot.
  const externalHrefs = useMemo(
    () =>
      requestRows
        .filter((row) => !row.pdfInInbox)
        .map((row) => citationExternalHref(row.citation))
        .filter((href): href is string => href !== null),
    [requestRows],
  );

  // Browsers throttle or block mass pop-ups, so the button opens only a
  // batch. The batch is a random sample, not the head of the list: papers that
  // are inaccessible for whatever reason never get fulfilled, so a head-first
  // pick would pile them up at the front and starve everything behind them.
  const openCount = Math.min(externalHrefs.length, OPEN_SOURCES_BATCH);

  const openAllSources = (): void => {
    for (const href of pickRandom(externalHrefs, OPEN_SOURCES_BATCH)) {
      const tab = window.open(href, '_blank');
      // A `noopener` feature makes window.open return null even on success,
      // so sever the opener on the returned window instead.
      if (tab) tab.opener = null;
    }
  };

  const renderRows = (rows: QueueRow[], mayFulfill: boolean): JSX.Element => (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <PdfRequestItem
          key={row.key}
          row={row}
          mayFulfill={mayFulfill}
          dateFmt={dateFmt}
        />
      ))}
    </ul>
  );

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8">
      <header className="border-b border-border pb-5">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-3xl font-semibold tracking-tight">
            {t('pdfRequests.title')}
          </h1>
          {externalHrefs.length > 0 && (
            <button
              type="button"
              onClick={openAllSources}
              className="inline-flex shrink-0 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent"
              title={t('pdfRequests.openAllHint')}
            >
              <ExternalLink className="h-4 w-4" />
              {t('pdfRequests.openAll', { count: openCount })}
            </button>
          )}
        </div>
        {/* The subtitle covers whatever the page is actually showing. The old
            copy ("papers the review agent couldn't access") is true of the
            requested class only, and asserting it over a list that is mostly
            gaps misstates the very provenance the two-section split exists to
            keep straight. Each section states its own origin below. */}
        <p className="mt-2 text-sm text-muted-foreground">
          {mayUpload
            ? t('pdfRequests.subtitle')
            : t('pdfRequests.subtitleReadOnly')}
        </p>
        {/* The row-by-row upload below is the right shape for clearing one or
            two papers. It is the wrong shape for the case this queue actually
            produces — an agent files a dozen requests, the contributor answers
            them in one library session and comes back with a folder — so point
            at the bulk drop-off rather than letting them do it a row at a
            time. */}
        {mayDropInBulk && (
          <p className="mt-2 text-sm text-muted-foreground">
            {t('pdfRequests.inboxLink')}{' '}
            <Link to="/pdf-inbox" className="underline">
              {t('pdfInbox.title')}
            </Link>
            .
          </p>
        )}
      </header>

      {queue === null ? (
        <p className="py-8 text-sm text-muted-foreground">
          {t('pdfRequests.loading')}
        </p>
      ) : error ? (
        <p className="py-8 text-sm text-destructive">
          {t('pdfRequests.loadFailed')}
        </p>
      ) : requestRows.length === 0 && gapRows.length === 0 ? (
        <p className="py-8 text-sm text-muted-foreground">
          {t('pdfRequests.empty')}
        </p>
      ) : (
        <>
          <section className="pt-6">
            <h2 className="text-lg font-semibold">
              {t('pdfRequests.requestedHeading')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('pdfRequests.requestedIntro')}
            </p>
            {requestRows.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                {t('pdfRequests.requestedEmpty')}
              </p>
            ) : (
              renderRows(requestRows, mayUpload)
            )}
          </section>

          {gapRows.length > 0 && (
            <section className="mt-8 border-t border-border pt-6">
              <h2 className="text-lg font-semibold">
                {t('pdfRequests.gapsHeading')}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('pdfRequests.gapsIntro')}
              </p>
              {/* No silent truncation: the server caps the gap list, so say so
                  rather than letting the page read as the complete set. */}
              {queue.gapTotal > gapRows.length && (
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('pdfRequests.gapsTruncated', {
                    shown: gapRows.length,
                    total: queue.gapTotal,
                  })}
                </p>
              )}
              {renderRows(gapRows, mayUpload && mayOpenRequest)}
            </section>
          )}
        </>
      )}
    </main>
  );
}
