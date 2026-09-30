import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Link2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useCan } from '@/lib/usePermissions';
import { isDefinitelyNotPdf, useFileDropZone } from '@/lib/useFileDropZone';
import {
  createPdfRequest,
  createPdfShareLink,
  fetchPdfRequest,
  submitPdfUrl,
  uploadCitationPdf,
  waitForCitationPdf,
  PdfFulfillError,
  type PdfRequestState,
  type PdfShareLink,
} from '@/lib/referencesApi';

interface Props {
  citationId: number;
  resolvable: boolean;
  /**
   * Whether a paper review already exists for this citation: `true`/`false`
   * once resolved, `null` while still loading. When resolved to `false` and no
   * PDF or open request is on file, a contributor is offered a self-service
   * upload so the missing full text can be supplied directly — the reason the
   * paper has no agent review yet. Kept `null` until known to avoid flashing the
   * upload prompt on papers that turn out to already be reviewed.
   */
  hasReview: boolean | null;
}

const ERROR_CODE_KEYS: Record<string, string> = {
  pdf_not_a_pdf: 'referenceModule.pdfNotAPdf',
  pdf_too_large: 'referenceModule.pdfTooLarge',
  pdf_fetch_failed: 'referenceModule.pdfFetchFailed',
  pdf_fetch_forbidden_host: 'referenceModule.pdfFetchForbiddenHost',
  pdf_fetch_timeout: 'referenceModule.pdfFetchTimeout',
  pdf_request_not_open: 'referenceModule.pdfRequestNotOpen',
  pdf_upload_pending: 'referenceModule.pdfUploadPending',
  pdf_storage_unavailable: 'referenceModule.pdfStorageUnavailable',
  pdf_share_no_pdf: 'referenceModule.shareNoPdf',
  pdf_share_forbidden: 'referenceModule.shareForbidden',
  pdf_share_rate_limited: 'referenceModule.shareRateLimited',
};

/**
 * Copy `text`, reporting whether it actually reached the clipboard.
 *
 * `navigator.clipboard` is absent on insecure origins and in older browsers,
 * and `navigator.clipboard?.writeText(...)` then resolves to `undefined`
 * rather than rejecting — awaiting it "succeeds" while nothing was copied. The
 * presence check is what separates that case from a real copy; permission
 * denials still arrive as a rejection.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function CitationPdfSection({
  citationId,
  resolvable,
  hasReview,
}: Props): JSX.Element | null {
  const { t } = useTranslation();
  const mayFulfill = useCan('citation.pdf.access');
  // The self-service path POSTs a request before uploading, so it needs the
  // request capability on top of upload access; fulfilling an existing
  // request does not.
  const mayOpenRequest = useCan('pdfRequest.create');
  // Minting a link that needs no account is a publishing decision, not a
  // reading one — admin by default, delegable from Admin → Permissions. Gated
  // on read access too, mirroring the conjunction the route enforces: the two
  // capabilities move independently, so a delegated share grant must not let
  // someone past a raised `citation.pdf.access`.
  const mayShare = useCan('citation.pdf.share') && mayFulfill;

  const [state, setState] = useState<PdfRequestState | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackError, setFeedbackError] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [shareLink, setShareLink] = useState<PdfShareLink | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  /**
   * The citation the section is currently showing. Minting awaits a
   * round-trip, and the reference route reuses this component across
   * navigations (no `key`), so an admin can be looking at another paper by
   * the time the answer lands. The continuation compares against this rather
   * than trusting its own closure.
   */
  const shownCitationRef = useRef(citationId);

  useEffect(() => {
    let cancelled = false;
    // A link belongs to one citation's stored bytes; never carry one across a
    // navigation into another reference.
    shownCitationRef.current = citationId;
    setShareLink(null);
    setShareCopied(false);
    if (!resolvable) {
      setState(null);
      return;
    }
    fetchPdfRequest(citationId)
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch(() => {
        if (!cancelled) setState({ request: null, hasPdf: false });
      });
    return () => {
      cancelled = true;
    };
  }, [citationId, resolvable]);

  // Drop the link from the panel the moment it stops working, so a stale URL
  // is never sitting there to be copied and handed on.
  useEffect(() => {
    if (!shareLink) return;
    const remaining = Date.parse(shareLink.expiresAt) - Date.now();
    if (remaining <= 0) {
      setShareLink(null);
      return;
    }
    const timer = setTimeout(() => {
      setShareLink(null);
      setShareCopied(false);
    }, remaining);
    return () => clearTimeout(timer);
  }, [shareLink]);

  // Declared before the early returns below — hooks may not be conditional.
  // `handleFile` is a hoisted function declaration, so the callback can refer to
  // it from up here.
  const { dragActive, dropProps } = useFileDropZone(
    (file) => void handleFile(file),
    mayFulfill && !busy,
  );

  if (!resolvable || !state) return null;

  const hasOpenRequest = state.request?.status === 'open';
  // A paper with no review yet and no full text on file is the "paper is
  // lacking" case: let a contributor upload the PDF right here instead of
  // waiting for an agent to file a request in the review queue.
  const selfService =
    mayFulfill &&
    mayOpenRequest &&
    !state.hasPdf &&
    !hasOpenRequest &&
    hasReview === false;
  // Only surface the section when there's something to show: a stored PDF, an
  // outstanding request, or a self-service upload prompt. Stay quiet otherwise
  // so already-reviewed or unremarkable references are unchanged.
  if (!state.hasPdf && !hasOpenRequest && !selfService) return null;

  // The upload/URL routes require an open request. When a contributor supplies
  // full text for a paper no agent has flagged, self-provision that request
  // first so the upload is accepted and the fulfilled request lands in the
  // agent's follow-up review queue.
  async function ensureRequest(): Promise<void> {
    if (!hasOpenRequest) {
      await createPdfRequest(citationId);
    }
  }

  function onSuccess(
    nextState: PdfRequestState = { request: null, hasPdf: true },
  ): void {
    setFeedback(t('referenceModule.fulfillSuccess'));
    setFeedbackError(false);
    setUrl('');
    setState(nextState);
  }

  function onFailure(code: string): void {
    const key = ERROR_CODE_KEYS[code];
    fail(key ? t(key) : t('referenceModule.fulfillFailed'));
  }

  function fail(message: string): void {
    setFeedback(message);
    setFeedbackError(true);
  }

  async function handleUrlSubmit(): Promise<void> {
    if (!url.trim() || busy) return;
    setBusy(true);
    setFeedback(null);
    try {
      await ensureRequest();
      await submitPdfUrl(citationId, url.trim());
      onSuccess();
    } catch (err) {
      onFailure(err instanceof PdfFulfillError ? err.code : 'unknown');
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(file: File | undefined): Promise<void> {
    if (!file || busy) return;
    // Catch an obvious mis-drop (a .docx, an image) before the round-trip.
    // Ambiguous files go through — the server checks the magic bytes.
    if (isDefinitelyNotPdf(file)) {
      fail(t('referenceModule.fileNotAPdf'));
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      await ensureRequest();
      await uploadCitationPdf(citationId, file);
      const nextState = await waitForCitationPdf(citationId);
      if (!nextState.hasPdf) throw new PdfFulfillError('pdf_upload_pending');
      onSuccess(nextState);
    } catch (err) {
      onFailure(err instanceof PdfFulfillError ? err.code : 'unknown');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function handleShare(): Promise<void> {
    if (busy) return;
    const requestedFor = citationId;
    setBusy(true);
    setFeedback(null);
    setShareCopied(false);
    try {
      const link = await createPdfShareLink(requestedFor);
      // Navigated to another reference while this was in flight: drop the
      // answer. Installing it would put a link to one licensed paper under
      // another paper's heading, where it reads as that paper's — and the
      // whole point of the field is that its contents get sent to someone.
      if (shownCitationRef.current !== requestedFor) return;
      setShareLink(link);
      // Best-effort on mint: the URL is always rendered in a selectable field,
      // so a clipboard the browser won't give us is not worth an error here —
      // but it must not be reported as a copy that happened either.
      setShareCopied(await copyToClipboard(link.url));
    } catch (err) {
      // Same for the failure path: a stale error belongs to the paper the
      // admin has already left.
      if (shownCitationRef.current !== requestedFor) return;
      setShareLink(null);
      onFailure(err instanceof PdfFulfillError ? err.code : 'unknown');
    } finally {
      setBusy(false);
    }
  }

  async function copyShareLink(): Promise<void> {
    if (!shareLink) return;
    if (await copyToClipboard(shareLink.url)) setShareCopied(true);
    // An explicit click that could not copy has to say so — the button would
    // otherwise sit there looking like it worked.
    else fail(t('referenceModule.shareCopyFailed'));
  }

  return (
    <section className="border-t border-border py-6">
      <h2 className="text-lg font-semibold">{t('referenceModule.fullText')}</h2>

      {state.hasPdf ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-muted-foreground">
            {t('referenceModule.fullTextOnFile')}
          </p>
          {mayShare && (
            <div className="space-y-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void handleShare()}
              >
                <Link2 className="mr-2 h-4 w-4" />
                {busy
                  ? t('referenceModule.shareMinting')
                  : shareLink
                    ? t('referenceModule.shareRenew')
                    : t('referenceModule.shareCreate')}
              </Button>
              <p className="text-xs text-muted-foreground">
                {t('referenceModule.shareHint', {
                  minutes: Math.round(
                    (shareLink?.expiresInSeconds ?? 600) / 60,
                  ),
                })}
              </p>
              {shareLink && (
                <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
                  <div className="flex gap-2">
                    <Input
                      readOnly
                      value={shareLink.url}
                      aria-label={t('referenceModule.shareUrlLabel')}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <Button
                      variant="outline"
                      onClick={() => void copyShareLink()}
                    >
                      {shareCopied ? (
                        <Check className="mr-2 h-4 w-4" />
                      ) : (
                        <Copy className="mr-2 h-4 w-4" />
                      )}
                      {shareCopied
                        ? t('referenceModule.shareCopied')
                        : t('referenceModule.shareCopy')}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('referenceModule.shareExpiresAt', {
                      time: new Date(shareLink.expiresAt).toLocaleTimeString(),
                    })}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-4">
          <p className="rounded-md bg-muted px-3 py-2 text-sm">
            {hasOpenRequest
              ? t('referenceModule.pdfRequested')
              : t('referenceModule.pdfMissingForReview')}
          </p>
          {state.request?.reason && (
            <p className="text-sm text-muted-foreground">
              <span className="font-medium">
                {t('referenceModule.pdfRequestReason')}:{' '}
              </span>
              {state.request.reason}
            </p>
          )}

          {mayFulfill && (
            <div className="space-y-3">
              {/* The whole panel is the drop target, not just the button, so a
                  PDF dragged anywhere near the affordance lands. */}
              <div
                {...dropProps}
                data-testid="pdf-dropzone"
                className={`flex flex-col items-start gap-2 rounded-md border border-dashed p-4 transition-colors ${
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
                {!busy && !dragActive && (
                  <p className="text-xs text-muted-foreground">
                    {t('referenceModule.dragHint')}
                  </p>
                )}
              </div>

              <div>
                <label className="text-sm text-muted-foreground">
                  {t('referenceModule.orPasteUrl')}
                </label>
                <div className="mt-1 flex gap-2">
                  <Input
                    type="url"
                    value={url}
                    disabled={busy}
                    placeholder={t('referenceModule.pdfUrlPlaceholder')}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleUrlSubmit();
                    }}
                  />
                  <Button
                    disabled={busy || !url.trim()}
                    onClick={() => void handleUrlSubmit()}
                  >
                    {t('referenceModule.submit')}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {feedback && (
        <p
          className={`mt-3 text-sm ${
            feedbackError ? 'text-destructive' : 'text-muted-foreground'
          }`}
        >
          {feedback}
        </p>
      )}
    </section>
  );
}
