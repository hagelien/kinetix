import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { showToast } from '@/lib/toast';
import {
  applyCitationMerge,
  CitationMergeError,
  isEligibleSurvivor,
  searchCitationsForMerge,
  suggestSurvivor,
  type CitationMergeCandidate,
} from '@/lib/citationMergeApi';

const KNOWN_ERROR_CODES = new Set([
  'not_found',
  'weaker_survivor',
  'nothing_to_merge',
  'cohort_conflict',
  'extraction_in_flight',
  'agent_refused',
]);

function messageForError(err: unknown, t: (key: string) => string): string {
  if (err instanceof CitationMergeError && err.code && KNOWN_ERROR_CODES.has(err.code)) {
    return t(`admin.citationMerge.errors.${err.code}`);
  }
  return t('admin.citationMerge.errors.generic');
}

function byline(row: CitationMergeCandidate): string {
  const meta = row.metadata ?? {};
  const authors = meta.authors ?? [];
  const first = authors[0] ?? '';
  const authorPart = authors.length > 1 ? `${first} et al.` : first;
  return [authorPart, meta.year ?? '', meta.journal ?? '']
    .filter((part) => String(part).trim())
    .join(' · ');
}

function CitationSummary({ row }: { row: CitationMergeCandidate }) {
  const { t } = useTranslation();
  const title = row.metadata?.title?.trim() || row.identifier;
  const meta = byline(row);
  return (
    <span className="min-w-0">
      <span className="block break-words font-medium">{title}</span>
      {meta && <span className="block text-xs text-muted-foreground">{meta}</span>}
      <span className="block break-all font-mono text-xs text-muted-foreground">
        #{row.id} · {row.type}:{row.identifier.length > 120 ? `${row.identifier.slice(0, 117)}…` : row.identifier}
      </span>
      <span className="mt-1 flex flex-wrap gap-1 text-xs">
        <Badge>{t('admin.citationMerge.usage', { count: row.usageCount })}</Badge>
        {row.review && (
          <Badge>
            {row.review.readInFull
              ? t('admin.citationMerge.reviewFull')
              : t('admin.citationMerge.reviewAbstract')}
          </Badge>
        )}
        {row.hasPdf && <Badge>{t('admin.citationMerge.hasPdf')}</Badge>}
        {row.pdfRequestStatus && (
          <Badge>
            {t('admin.citationMerge.pdfRequest', { status: row.pdfRequestStatus })}
          </Badge>
        )}
      </span>
    </span>
  );
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded border border-border px-1.5 py-0.5 text-muted-foreground">
      {children}
    </span>
  );
}

export function CitationMergeAdminSection() {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CitationMergeCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  // Kept across searches, so rows found under different spellings can be
  // gathered into one merge.
  const [selected, setSelected] = useState<Map<number, CitationMergeCandidate>>(
    () => new Map(),
  );
  const [survivorId, setSurvivorId] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  // Kept as the error rather than its message, so the search effect does not
  // depend on `t` and re-run whenever the translation function changes.
  const [searchError, setSearchError] = useState<unknown>(null);
  const [searchNonce, setSearchNonce] = useState(0);

  useEffect(() => {
    setSearchError(null);
    if (!query.trim()) {
      setResults((prev) => (prev.length > 0 ? [] : prev));
      // The previous run's cleanup aborted any in-flight request, and its
      // `finally` skips `setSearching` for aborted requests.
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    const handle = setTimeout(() => {
      setSearching(true);
      searchCitationsForMerge(query, controller.signal)
        .then((rows) => setResults(rows))
        .catch((err) => {
          if (!controller.signal.aborted) setSearchError(err);
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 250);
    return () => {
      controller.abort();
      clearTimeout(handle);
    };
  }, [query, searchNonce]);

  const selectedRows = useMemo(() => [...selected.values()], [selected]);

  // Keep the survivor valid as the selection changes: default to the
  // suggested row, and drop a choice that left the selection or stopped
  // being eligible (a stronger handle was added).
  useEffect(() => {
    const current = survivorId != null ? selected.get(survivorId) : undefined;
    if (current && isEligibleSurvivor(current, selectedRows)) return;
    setSurvivorId(suggestSurvivor(selectedRows)?.id ?? null);
  }, [selected, selectedRows, survivorId]);

  function toggle(row: CitationMergeCandidate) {
    setConfirming(false);
    setErrorMsg('');
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.set(row.id, row);
      return next;
    });
  }

  async function runMerge() {
    if (survivorId == null) return;
    const mergeIds = selectedRows.map((r) => r.id).filter((id) => id !== survivorId);
    setBusy(true);
    setErrorMsg('');
    try {
      const result = await applyCitationMerge({ survivorId, mergeIds });
      showToast(
        t('admin.citationMerge.merged', {
          count: result.merged.length,
          survivor: survivorId,
        }),
      );
      if (result.deferred.length > 0) {
        setErrorMsg(
          t('admin.citationMerge.deferred', { ids: result.deferred.join(', ') }),
        );
      }
      setSelected(new Map());
      setSurvivorId(null);
      setConfirming(false);
      setSearchNonce((n) => n + 1);
    } catch (err) {
      setErrorMsg(messageForError(err, t));
    } finally {
      setBusy(false);
    }
  }

  const survivor = survivorId != null ? selected.get(survivorId) : undefined;
  const mergeCount = selectedRows.length - 1;

  return (
    <section className="mb-10">
      <h2 className="text-xl font-semibold mb-2">{t('admin.citationMerge.title')}</h2>
      <p className="text-sm text-muted-foreground mb-4 max-w-2xl">
        {t('admin.citationMerge.description')}
      </p>

      <div className="max-w-3xl">
        <label className="block text-sm font-medium mb-1" htmlFor="citation-merge-search">
          {t('admin.citationMerge.searchLabel')}
        </label>
        <Input
          id="citation-merge-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('admin.citationMerge.searchPlaceholder')}
        />
        {searching && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('admin.citationMerge.searching')}
          </p>
        )}
        {!searching && query.trim() && results.length === 0 && (
          <p className="mt-2 text-sm text-muted-foreground">
            {t('admin.citationMerge.noResults')}
          </p>
        )}
        {results.length > 0 && (
          <ul className="mt-3 max-h-[28rem] space-y-1 overflow-auto rounded-md border border-border p-1">
            {results.map((row) => (
              <li key={row.id}>
                <label
                  className={`flex cursor-pointer gap-2 rounded-md p-2 text-sm hover:bg-muted ${
                    selected.has(row.id) ? 'bg-primary/5' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(row.id)}
                    onChange={() => toggle(row)}
                  />
                  <CitationSummary row={row} />
                </label>
              </li>
            ))}
          </ul>
        )}
      </div>

      {searchError != null && (
        <p className="mt-3 text-sm text-red-600">{messageForError(searchError, t)}</p>
      )}
      {errorMsg && <p className="mt-3 text-sm text-red-600">{errorMsg}</p>}

      {selectedRows.length > 0 && (
        <div className="mt-6 max-w-3xl space-y-3 rounded-lg border border-border p-4">
          <h3 className="font-semibold">
            {t('admin.citationMerge.selectedTitle', { count: selectedRows.length })}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t('admin.citationMerge.survivorHelp')}
          </p>
          <ul className="space-y-2">
            {selectedRows.map((row) => {
              const eligible = isEligibleSurvivor(row, selectedRows);
              return (
                <li
                  key={row.id}
                  className={`flex gap-2 rounded-md border p-2 text-sm ${
                    survivorId === row.id ? 'border-primary bg-primary/5' : 'border-border'
                  }`}
                >
                  <input
                    type="radio"
                    name="citation-merge-survivor"
                    className="mt-1"
                    aria-label={t('admin.citationMerge.keepThis')}
                    checked={survivorId === row.id}
                    disabled={!eligible}
                    onChange={() => {
                      setSurvivorId(row.id);
                      setConfirming(false);
                    }}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="block text-xs uppercase text-muted-foreground">
                      {survivorId === row.id
                        ? t('admin.citationMerge.kept')
                        : t('admin.citationMerge.mergedInto')}
                    </span>
                    <CitationSummary row={row} />
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => toggle(row)}>
                    {t('admin.citationMerge.remove')}
                  </Button>
                </li>
              );
            })}
          </ul>

          {selectedRows.length < 2 ? (
            <p className="text-sm text-muted-foreground">
              {t('admin.citationMerge.pickMore')}
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
              {confirming && survivor ? (
                <>
                  <span className="text-sm">
                    {t('admin.citationMerge.confirmPrompt', {
                      count: mergeCount,
                      survivor: survivor.id,
                    })}
                  </span>
                  <Button variant="destructive" onClick={runMerge} disabled={busy}>
                    {busy ? t('admin.citationMerge.merging') : t('admin.citationMerge.confirmMerge')}
                  </Button>
                  <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
                    {t('common.cancel')}
                  </Button>
                </>
              ) : (
                <Button
                  variant="destructive"
                  onClick={() => setConfirming(true)}
                  disabled={busy || !survivor}
                >
                  {t('admin.citationMerge.performMerge', { count: mergeCount })}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
