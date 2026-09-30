import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import { useCan } from '@/lib/usePermissions';
import { isDefinitelyNotPdf, useFilesDropZone } from '@/lib/useFileDropZone';
import {
  citationTooltipLabel,
  citationTooltipTitle,
} from '@/lib/citationFormat';
import { referenceModulePath, searchReferences } from '@/lib/referencesApi';
import type { CitationRow, ReferenceSearchHit } from '@/lib/referencesApi';
import {
  attachInboxItem,
  autoAttachInbox,
  discardInboxItem,
  fetchInbox,
  probeInboxStorage,
  rematchInboxItem,
  uploadToInbox,
  PdfInboxError,
  type InboxCandidate,
  type InboxItem,
  type MatchConfidence,
} from '@/lib/pdfInboxApi';

/**
 * Server error codes → localized message keys. Anything not listed falls back
 * to a generic failure, so a new server code degrades to a vague message
 * rather than rendering its own identifier at a user.
 */
const INBOX_ERROR_KEYS: Record<string, string> = {
  pdf_inbox_full: 'pdfInbox.errorFull',
  pdf_storage_unavailable: 'referenceModule.pdfStorageUnavailable',
  inbox_item_not_found: 'pdfInbox.errorGone',
  inbox_item_not_pending: 'pdfInbox.errorGone',
  citation_not_found: 'pdfInbox.errorCitationGone',
  pdf_request_unresolvable_citation: 'pdfInbox.errorUnresolvable',
  pdf_replace_requires_editor: 'pdfInbox.errorReplaceEditor',
  pdf_replace_extraction_in_flight: 'pdfInbox.errorExtractionOpen',
  inbox_attach_conflict: 'pdfInbox.errorRaced',
};

/**
 * Files uploaded at once.
 *
 * Each upload is a direct browser→Blob transfer plus a server-side read-back,
 * identifier scan and match, so they are neither free nor instant. Three at a
 * time keeps a forty-file drop moving without opening forty concurrent
 * connections — which browsers queue anyway, and which would make the progress
 * list jump from "nothing" to "everything" with no useful middle.
 */
const UPLOAD_CONCURRENCY = 3;

type UploadState = 'queued' | 'uploading' | 'done' | 'skipped' | 'failed';

interface UploadSlot {
  key: string;
  name: string;
  state: UploadState;
  message?: string;
}

function confidenceTone(confidence: MatchConfidence): string {
  switch (confidence) {
    case 'exact':
      return 'bg-emerald-600/10 text-emerald-700 dark:text-emerald-400';
    case 'strong':
      return 'bg-sky-600/10 text-sky-700 dark:text-sky-400';
    case 'weak':
      return 'bg-amber-500/10 text-amber-700 dark:text-amber-400';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

/**
 * One dropped file, and what is known about which paper it is.
 *
 * The row's job is to make the decision cheap: what the file says about
 * itself on the left, the citation it would be linked to on the right, and —
 * when the answer is not obvious — a search box, so the fallback is still one
 * screen rather than a trip to another page.
 */
function InboxItemRow({
  item,
  citationsById,
  onAttached,
  onDiscarded,
  onRematched,
}: {
  item: InboxItem;
  citationsById: Map<number, CitationRow>;
  onAttached: (itemId: number) => void;
  onDiscarded: (itemId: number) => void;
  onRematched: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<null | 'attach' | 'rematch' | 'discard'>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [manualQuery, setManualQuery] = useState('');
  const [manualHits, setManualHits] = useState<ReferenceSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const candidates = item.candidates ?? [];
  const extracted = item.extracted;

  const report = (err: unknown): void => {
    const code = err instanceof PdfInboxError ? err.code : 'unknown';
    const key = INBOX_ERROR_KEYS[code];
    setErrorMsg(key ? t(key) : t('pdfInbox.errorGeneric'));
  };

  async function link(citationId: number): Promise<void> {
    if (busy) return;
    setBusy('attach');
    setErrorMsg(null);
    try {
      await attachInboxItem(item.id, citationId);
      onAttached(item.id);
    } catch (err) {
      report(err);
    } finally {
      setBusy(null);
    }
  }

  async function rematch(): Promise<void> {
    if (busy) return;
    setBusy('rematch');
    setErrorMsg(null);
    try {
      await rematchInboxItem(item.id);
      onRematched();
    } catch (err) {
      report(err);
    } finally {
      setBusy(null);
    }
  }

  async function discard(): Promise<void> {
    if (busy) return;
    setBusy('discard');
    setErrorMsg(null);
    try {
      await discardInboxItem(item.id);
      onDiscarded(item.id);
    } catch (err) {
      report(err);
    } finally {
      setBusy(null);
    }
  }

  // Debounced so typing a title does not fire a query per keystroke; the
  // in-flight request is aborted rather than left to resolve out of order.
  useEffect(() => {
    const query = manualQuery.trim();
    if (query.length < 3) {
      setManualHits(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      searchReferences(query, { limit: 6, signal: controller.signal })
        .then((hits) => setManualHits(hits))
        .finally(() => setSearching(false));
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [manualQuery]);

  const renderCitation = (citation: CitationRow | undefined, id: number): JSX.Element => {
    if (!citation) {
      return <span className="text-muted-foreground">#{id}</span>;
    }
    return (
      <Link
        to={referenceModulePath(id)}
        className="hover:underline"
        title={citationTooltipLabel(citation)}
      >
        {citationTooltipTitle(citation)}
      </Link>
    );
  };

  const renderCandidate = (candidate: InboxCandidate): JSX.Element => (
    <li
      key={candidate.citationId}
      className="flex items-start justify-between gap-3 py-1.5"
    >
      <div className="min-w-0 text-sm">
        {renderCitation(citationsById.get(candidate.citationId), candidate.citationId)}
        <span className="ml-2 text-xs text-muted-foreground">
          {t(`pdfInbox.via.${candidate.via}`)}
          {candidate.via === 'title' &&
            ` · ${Math.round(candidate.score * 100)}%`}
        </span>
        {/* Linking here would overwrite full text already on file, which is an
            editor's call everywhere else in the system. Say so before the
            click rather than after the 403. */}
        {candidate.hasPdf && (
          <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">
            {t('pdfInbox.candidateHasPdf')}
          </span>
        )}
      </div>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => void link(candidate.citationId)}
        className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-60"
      >
        {t('pdfInbox.link')}
      </button>
    </li>
  );

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-start gap-2 font-medium">
            <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 break-all">{item.originalFilename}</span>
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{formatBytes(item.sizeBytes)}</span>
            {extracted?.doi && (
              <span>
                DOI: <code>{extracted.doi}</code>{' '}
                <SourceChip source={extracted.sources?.doi} />
              </span>
            )}
            {extracted?.pmid && (
              <span>
                PMID: <code>{extracted.pmid}</code>{' '}
                <SourceChip source={extracted.sources?.pmid} />
              </span>
            )}
            {extracted?.pmcid && (
              <span>
                PMCID: <code>{extracted.pmcid}</code>{' '}
                <SourceChip source={extracted.sources?.pmcid} />
              </span>
            )}
          </p>
          {extracted?.title && (
            <p className="mt-1 text-sm text-muted-foreground">
              {t('pdfInbox.readTitle')}: {extracted.title}
            </p>
          )}
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${confidenceTone(
            item.matchConfidence,
          )}`}
        >
          {t(`pdfInbox.confidence.${item.matchConfidence}`)}
        </span>
      </div>

      {candidates.length > 0 ? (
        <ul className="mt-2 divide-y divide-border rounded-md border border-border px-3">
          {candidates.map(renderCandidate)}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">
          {t('pdfInbox.noCandidates')}
        </p>
      )}

      {/* Always available, not only when the matcher failed: the matcher can
          be confidently wrong (a supplement carrying the article's DOI), and
          the person looking at the file is the one who can tell. */}
      <div className="mt-3">
        <label className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={manualQuery}
            onChange={(e) => setManualQuery(e.target.value)}
            placeholder={t('pdfInbox.searchPlaceholder')}
            aria-label={t('pdfInbox.searchPlaceholder')}
            className="w-full bg-transparent text-sm outline-none"
          />
          {searching && (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
          )}
        </label>
        {manualHits !== null && (
          <ul className="mt-1 divide-y divide-border rounded-md border border-border px-3">
            {manualHits.length === 0 ? (
              <li className="py-2 text-sm text-muted-foreground">
                {t('pdfInbox.searchEmpty')}
              </li>
            ) : (
              manualHits.map((hit) => (
                <li
                  key={hit.id}
                  className="flex items-start justify-between gap-3 py-1.5"
                >
                  <span className="min-w-0 text-sm">
                    {citationTooltipTitle(hit)}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {citationTooltipLabel(hit)}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void link(hit.id)}
                    className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-accent disabled:opacity-60"
                  >
                    {t('pdfInbox.link')}
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      {errorMsg && <p className="mt-2 text-sm text-destructive">{errorMsg}</p>}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void rematch()}
          title={t('pdfInbox.rematchHint')}
          className="inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-60"
        >
          {busy === 'rematch' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t('pdfInbox.rematch')}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void discard()}
          className="inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-60"
        >
          {busy === 'discard' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          {t('pdfInbox.discard')}
        </button>
      </div>
    </li>
  );
}

function SourceChip({ source }: { source: string | undefined }): JSX.Element | null {
  const { t } = useTranslation();
  if (!source) return null;
  return (
    <span className="rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide">
      {t(`pdfInbox.source.${source}`)}
    </span>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function PdfInboxPage(): JSX.Element {
  const { t } = useTranslation();
  const mayUpload = useCan('pdfInbox.upload');
  const mayResolve = useCan('pdfInbox.resolve');

  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [citationsById, setCitationsById] = useState<Map<number, CitationRow>>(
    new Map(),
  );
  const [loadFailed, setLoadFailed] = useState(false);
  const [cleanupPending, setCleanupPending] = useState(0);
  const [uploads, setUploads] = useState<UploadSlot[]>([]);
  const [sweeping, setSweeping] = useState(false);
  const [sweepNote, setSweepNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploading = uploads.some(
    (slot) => slot.state === 'queued' || slot.state === 'uploading',
  );

  const reload = useCallback(async (): Promise<void> => {
    try {
      const listing = await fetchInbox('pending');
      setItems(listing.items);
      setCitationsById(new Map(listing.citations.map((row) => [row.id, row])));
      setCleanupPending(listing.cleanupPending);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
      setItems([]);
    }
  }, []);

  useEffect(() => {
    if (!mayResolve) {
      setItems([]);
      return;
    }
    void reload();
  }, [mayResolve, reload]);

  /**
   * Upload a whole selection.
   *
   * Obvious non-PDFs are rejected locally and marked `skipped` rather than
   * dropped: someone who drags a folder containing a spreadsheet needs to see
   * that it was not taken, or they will believe it is in the inbox.
   */
  const uploadAll = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0) return;
      const stamp = Date.now();
      const slots: UploadSlot[] = files.map((file, index) => ({
        key: `${stamp}-${index}-${file.name}`,
        name: file.name,
        state: isDefinitelyNotPdf(file) ? 'skipped' : 'queued',
        message: isDefinitelyNotPdf(file)
          ? t('referenceModule.fileNotAPdf')
          : undefined,
      }));
      setUploads((previous) => [...previous, ...slots]);

      const pending = files
        .map((file, index) => ({ file, slot: slots[index] }))
        .filter(
          (entry): entry is { file: File; slot: UploadSlot } =>
            entry.slot !== undefined && entry.slot.state === 'queued',
        );
      if (pending.length === 0) return;

      const update = (key: string, patch: Partial<UploadSlot>): void => {
        setUploads((previous) =>
          previous.map((slot) => (slot.key === key ? { ...slot, ...patch } : slot)),
        );
      };

      // One probe for the batch. Failing here fails every queued file with the
      // same clear reason instead of forty opaque browser CORS errors.
      try {
        await probeInboxStorage();
      } catch (err) {
        const code = err instanceof PdfInboxError ? err.code : 'unknown';
        const key = INBOX_ERROR_KEYS[code];
        for (const entry of pending) {
          update(entry.slot.key, {
            state: 'failed',
            message: key ? t(key) : t('pdfInbox.errorGeneric'),
          });
        }
        return;
      }

      let cursor = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const entry = pending[index];
          if (!entry) return;
          update(entry.slot.key, { state: 'uploading' });
          try {
            await uploadToInbox(entry.file);
            update(entry.slot.key, { state: 'done' });
          } catch (err) {
            const code = err instanceof PdfInboxError ? err.code : 'unknown';
            const key = INBOX_ERROR_KEYS[code];
            update(entry.slot.key, {
              state: 'failed',
              message: key ? t(key) : t('pdfInbox.errorGeneric'),
            });
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_CONCURRENCY, pending.length) }, worker),
      );
      await reload();
    },
    [reload, t],
  );

  const { dragActive, dropProps } = useFilesDropZone(
    (files) => void uploadAll(files),
    mayUpload && !uploading,
  );

  async function sweep(): Promise<void> {
    setSweeping(true);
    setSweepNote(null);
    try {
      const summary = await autoAttachInbox();
      const note = summary.truncated
        ? t('pdfInbox.sweepTruncated', {
            count: summary.attached.length,
            pending: summary.pending,
          })
        : t('pdfInbox.sweepDone', {
            count: summary.attached.length,
            scanned: summary.scanned,
          });
      // The sweep also retries deletions an earlier discard could not finish.
      // Say so when it did any — otherwise the only sign that storage was
      // cleaned up is its silent absence from a count nobody is watching.
      setSweepNote(
        summary.cleaned > 0
          ? `${note} ${t('pdfInbox.sweepCleaned', { count: summary.cleaned })}`
          : note,
      );
      await reload();
    } catch {
      setSweepNote(t('pdfInbox.errorGeneric'));
    } finally {
      setSweeping(false);
    }
  }

  const dropAll = (itemId: number): void => {
    setItems((previous) =>
      (previous ?? []).filter((candidate) => candidate.id !== itemId),
    );
  };

  const confidentCount = useMemo(
    () =>
      (items ?? []).filter(
        (item) =>
          item.matchConfidence === 'exact' &&
          item.matchedCitationId !== null &&
          !(item.candidates ?? []).some(
            (candidate) =>
              candidate.citationId === item.matchedCitationId && candidate.hasPdf,
          ),
      ).length,
    [items],
  );

  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8">
      <header className="border-b border-border pb-5">
        <h1 className="text-3xl font-semibold tracking-tight">
          {t('pdfInbox.title')}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('pdfInbox.subtitle')}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('pdfInbox.queueLink')}{' '}
          <Link to="/pdf-requests" className="underline">
            {t('pdfRequests.title')}
          </Link>
          .
        </p>
      </header>

      {mayUpload && (
        <section
          {...dropProps}
          className={`mt-6 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors ${
            dragActive ? 'border-primary bg-primary/5' : 'border-border'
          }`}
        >
          <Upload className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 font-medium">
            {dragActive ? t('pdfInbox.dropNow') : t('pdfInbox.dropHeading')}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('pdfInbox.dropHint')}
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            multiple
            className="hidden"
            onChange={(e) => {
              void uploadAll(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="mt-4 inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-60"
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Upload className="h-4 w-4" />
            )}
            {t('pdfInbox.choose')}
          </button>
        </section>
      )}

      {uploads.length > 0 && (
        <section className="mt-4 rounded-md border border-border">
          <ul className="divide-y divide-border">
            {uploads.map((slot) => (
              <li
                key={slot.key}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span className="min-w-0 break-all">{slot.name}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs">
                  {slot.state === 'uploading' && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  )}
                  {slot.state === 'done' && (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                  )}
                  {(slot.state === 'failed' || slot.state === 'skipped') && (
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                  )}
                  <span
                    className={
                      slot.state === 'failed'
                        ? 'text-destructive'
                        : 'text-muted-foreground'
                    }
                  >
                    {slot.message ?? t(`pdfInbox.upload.${slot.state}`)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
          <h2 className="text-lg font-semibold">
            {t('pdfInbox.waitingHeading', { count: items?.length ?? 0 })}
          </h2>
          {/* The sweep does three jobs, and gating it on a *stored* exact match
              would strand two of them. It re-matches every pending item, which
              is the only way an item that matched nothing when it arrived
              becomes linkable once the paper is cited — and the stored grade
              is precisely the snapshot that cannot know that yet. It also
              retries deletions an earlier discard could not finish, which
              nothing else triggers, so gating it would leave a stranded object
              with no route to cleanup at all once the inbox emptied. Hence:
              offered whenever there is anything at all for it to do. */}
          {mayResolve && ((items?.length ?? 0) > 0 || cleanupPending > 0) && (
            <button
              type="button"
              disabled={sweeping}
              onClick={() => void sweep()}
              title={t('pdfInbox.sweepHint')}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-60"
            >
              {sweeping ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wand2 className="h-4 w-4" />
              )}
              {confidentCount > 0
                ? t('pdfInbox.sweep', { count: confidentCount })
                : t('pdfInbox.sweepRecheck')}
            </button>
          )}
        </div>
        {sweepNote && (
          <p className="mt-2 text-sm text-muted-foreground">{sweepNote}</p>
        )}

        {!mayResolve ? (
          <p className="py-6 text-sm text-muted-foreground">
            {t('pdfInbox.readOnly')}
          </p>
        ) : items === null ? (
          <p className="py-6 text-sm text-muted-foreground">
            {t('pdfInbox.loading')}
          </p>
        ) : loadFailed ? (
          <p className="py-6 text-sm text-destructive">
            {t('pdfInbox.loadFailed')}
          </p>
        ) : items.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            {t('pdfInbox.empty')}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <InboxItemRow
                key={item.id}
                item={item}
                citationsById={citationsById}
                onAttached={dropAll}
                onDiscarded={dropAll}
                onRematched={() => void reload()}
              />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
