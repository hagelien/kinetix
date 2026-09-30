import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  BookText,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FlaskConical,
  Type,
  Users,
} from 'lucide-react';
import {
  citationExternalHref,
  citationTooltipLabel,
  citationTooltipTitle,
} from '@/lib/citationFormat';
import {
  fetchReferenceIndex,
  referenceModulePath,
  type CitationRow,
  type ReferenceGroup,
  type ReferenceGroupBy,
  type ReferenceIndex,
} from '@/lib/referencesApi';
import { formatGenericDrugName, resolveDrugName } from '@/lib/drugNames';
import { activeLangCode } from '@/lib/useDrugName';

const PAGE_SIZE = 50;
const GROUP_BY_OPTIONS: ReferenceGroupBy[] = [
  'drug',
  'alpha',
  'author',
  'year',
];

const EMPTY_INDEX: ReferenceIndex = {
  groups: [],
  buckets: [],
  groupBy: 'drug',
  bucket: null,
  page: 1,
  pageSize: PAGE_SIZE,
  totalPages: 1,
  totalReferences: 0,
  matchedReferences: 0,
  totalRows: 0,
  rangeStart: 0,
  rangeEnd: 0,
};

function parseGroupBy(value: string | null): ReferenceGroupBy {
  return value === 'alpha' || value === 'author' || value === 'year'
    ? value
    : 'drug';
}

function groupHeading(
  group: ReferenceGroup,
  lang: string | undefined,
  emptyLabel: (axis: string) => string,
): string {
  if (group.kind === 'drug') {
    const resolved = formatGenericDrugName(
      resolveDrugName(group.names ?? {}, lang),
    );
    return resolved || group.label || group.slug || String(group.id);
  }
  if (group.kind === 'wiki') {
    return group.title || group.label || group.slug || String(group.id);
  }
  // A letter bucket labels itself; only the catch-all buckets need naming, and
  // what they are called depends on the axis — undated, or authorless.
  return group.label || emptyLabel(group.kind);
}

function ReferenceEntry({ row }: { row: CitationRow }): JSX.Element {
  const { t } = useTranslation();
  const external = citationExternalHref(row);
  const label = citationTooltipLabel(row);
  return (
    <li className="flex items-start justify-between gap-3 py-2">
      <div className="min-w-0">
        <Link
          to={referenceModulePath(row.id)}
          className="font-medium hover:underline"
        >
          {citationTooltipTitle(row)}
        </Link>
        {label && <p className="text-xs text-muted-foreground">{label}</p>}
      </div>
      {external && (
        <a
          href={external}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={t('referencesIndex.openExternal')}
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      )}
    </li>
  );
}

function GroupCard({
  group,
  heading,
}: {
  group: ReferenceGroup;
  heading: string;
}): JSX.Element {
  const { t } = useTranslation();
  const Icon =
    group.kind === 'drug'
      ? FlaskConical
      : group.kind === 'wiki'
        ? BookText
        : group.kind === 'year'
          ? CalendarRange
          : group.kind === 'author'
            ? Users
            : Type;
  return (
    <section className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-3 border-b border-border pb-2">
        {group.href ? (
          <Link
            to={group.href}
            className="flex min-w-0 items-center gap-2 text-lg font-semibold hover:underline"
          >
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{heading}</span>
          </Link>
        ) : (
          <h3 className="flex min-w-0 items-center gap-2 text-lg font-semibold">
            <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="truncate">{heading}</span>
          </h3>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('referencesIndex.count', { count: group.totalReferences })}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {group.references.map((row) => (
          <ReferenceEntry key={`${group.key}-${row.id}`} row={row} />
        ))}
      </ul>
    </section>
  );
}

export function ReferencesPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const groupBy = parseGroupBy(searchParams.get('group'));
  const bucket = searchParams.get('bucket');
  const page = Math.max(1, Number(searchParams.get('page')) || 1);
  const query = searchParams.get('q') ?? '';

  // The input is uncontrolled by the URL while typing: the URL (and with it
  // the server round-trip) only catches up after the debounce, so keystrokes
  // never wait on the network.
  const [draftQuery, setDraftQuery] = useState(query);
  const [index, setIndex] = useState<ReferenceIndex>(EMPTY_INDEX);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const loadedOnceRef = useRef(false);

  // `names` is keyed by bare language code, so a persisted regional locale
  // ("nb-NO") has to be normalized before it reaches resolveDrugName — here and
  // on the server, which resolves the same headings to sort the drug axis.
  const lang = activeLangCode(i18n.language);

  useEffect(() => {
    setDraftQuery(query);
  }, [query]);

  // Discrete navigation (axis, bucket, page) pushes a history entry so Back
  // returns to the view the user came from. Only the debounced search box
  // replaces — otherwise every keystroke that survives the debounce would
  // leave its own entry to back out of.
  const updateParams = useCallback(
    (changes: Record<string, string | null>, replace = false) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const [key, value] of Object.entries(changes)) {
            if (value == null || value === '') next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace },
      );
    },
    [setSearchParams],
  );

  // Debounce the typed query into the URL. Changing the query, the axis, or
  // the bucket always returns to page 1 — page 7 of the old result set is
  // meaningless against the new one.
  useEffect(() => {
    if (draftQuery === query) return;
    const timer = setTimeout(() => {
      updateParams(
        { q: draftQuery.trim() || null, page: null, bucket: null },
        true,
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [draftQuery, query, updateParams]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchReferenceIndex(
      { q: query, groupBy, bucket, page, pageSize: PAGE_SIZE, lang },
      controller.signal,
    )
      .then((data) => {
        setIndex(data);
        loadedOnceRef.current = true;
        setLoading(false);
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name === 'AbortError') return;
        setError(t('referencesIndex.loadFailed'));
        setLoading(false);
      });
    return () => controller.abort();
  }, [query, groupBy, bucket, page, lang, t]);

  const unknownYearLabel = t('referencesIndex.unknownYear');
  const unknownAuthorLabel = t('referencesIndex.unknownAuthor');
  // Names the axis's catch-all bucket. `axis` is a groupBy value or the
  // equivalent group kind — they share their spelling for the flat axes.
  const emptyLabel = useCallback(
    (axis: string): string =>
      axis === 'year'
        ? unknownYearLabel
        : axis === 'author'
          ? unknownAuthorLabel
          : '#',
    [unknownYearLabel, unknownAuthorLabel],
  );
  const decorated = useMemo(
    () =>
      index.groups.map((group) => ({
        group,
        heading: groupHeading(group, lang, emptyLabel),
      })),
    [index.groups, lang, emptyLabel],
  );

  const activeBucket = index.bucket;
  const hasQuery = query.trim().length > 0;
  const showsNothing = index.groups.length === 0;

  function bucketLabel(label: string | null): string {
    return label || emptyLabel(groupBy);
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <header className="border-b border-border pb-5">
        <h1 className="text-3xl font-semibold tracking-tight">
          {t('referencesIndex.title')}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('referencesIndex.subtitle', { count: index.totalReferences })}
        </p>
      </header>

      <div className="space-y-3 py-4">
        <div>
          <input
            type="search"
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
            placeholder={t('referencesIndex.searchPlaceholder')}
            aria-label={t('referencesIndex.searchPlaceholder')}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {t('referencesIndex.searchHint')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('referencesIndex.groupBy')}
          </span>
          <div className="inline-flex rounded-md border border-border p-0.5">
            {GROUP_BY_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={groupBy === option}
                onClick={() =>
                  updateParams({
                    group: option === 'drug' ? null : option,
                    bucket: null,
                    page: null,
                  })
                }
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  groupBy === option
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t(`referencesIndex.groupBy_${option}`)}
              </button>
            ))}
          </div>
        </div>

        {index.buckets.length > 1 &&
          (groupBy === 'drug' ? (
            <label className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {t('referencesIndex.jumpTo')}
              <select
                value={activeBucket ?? ''}
                onChange={(event) =>
                  updateParams({
                    bucket: event.target.value || null,
                    page: null,
                  })
                }
                className="max-w-xs rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
              >
                <option value="">{t('referencesIndex.allBuckets')}</option>
                {index.buckets.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {`${bucketLabel(entry.label)} (${entry.count})`}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <nav
              aria-label={t('referencesIndex.jumpTo')}
              className="flex flex-wrap items-center gap-1"
            >
              <button
                type="button"
                aria-pressed={activeBucket == null}
                onClick={() => updateParams({ bucket: null, page: null })}
                className={`rounded border px-2 py-0.5 text-xs ${
                  activeBucket == null
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                {t('referencesIndex.allBuckets')}
              </button>
              {index.buckets.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  aria-pressed={activeBucket === entry.key}
                  title={t('referencesIndex.count', { count: entry.count })}
                  onClick={() =>
                    updateParams({ bucket: entry.key, page: null })
                  }
                  className={`rounded border px-2 py-0.5 text-xs ${
                    activeBucket === entry.key
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {bucketLabel(entry.label)}
                </button>
              ))}
            </nav>
          ))}
      </div>

      {error ? (
        <p className="py-8 text-sm text-destructive">{error}</p>
      ) : loading && !loadedOnceRef.current ? (
        <p className="py-8 text-sm text-muted-foreground">
          {t('referencesIndex.loading')}
        </p>
      ) : showsNothing ? (
        <p className="py-8 text-sm text-muted-foreground">
          {hasQuery
            ? t('referencesIndex.noMatches')
            : t('referencesIndex.empty')}
        </p>
      ) : (
        <>
          {/* One key per rendered sentence: a search-active summary is its own
              bilingual string rather than two fragments joined with hardcoded
              punctuation (AGENTS.md § Internationalization). */}
          <p className="pb-3 text-xs text-muted-foreground" aria-live="polite">
            {hasQuery
              ? t('referencesIndex.showingMatched', {
                  from: index.rangeStart,
                  to: index.rangeEnd,
                  total: index.totalRows,
                  count: index.matchedReferences,
                })
              : t('referencesIndex.showing', {
                  from: index.rangeStart,
                  to: index.rangeEnd,
                  count: index.totalRows,
                })}
          </p>

          <div
            className={`space-y-4 ${loading ? 'opacity-60 transition-opacity' : ''}`}
          >
            {decorated.map(({ group, heading }, position) => (
              <div key={group.key} className="space-y-4">
                {/* Drug monographs sort ahead of wiki pages, so the section
                    heading appears wherever the kind changes — including at
                    the top of a page that starts mid-section. */}
                {groupBy === 'drug' &&
                  (position === 0 ||
                    decorated[position - 1]?.group.kind !== group.kind) && (
                    <h2 className="pt-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                      {group.kind === 'drug'
                        ? t('referencesIndex.drugMonographs')
                        : t('referencesIndex.wikiPages')}
                    </h2>
                  )}
                <GroupCard group={group} heading={heading} />
              </div>
            ))}
          </div>

          {index.totalPages > 1 && (
            <nav
              aria-label={t('referencesIndex.pagination')}
              className="flex items-center justify-between gap-3 py-6"
            >
              <button
                type="button"
                disabled={index.page <= 1}
                onClick={() =>
                  updateParams({
                    page: index.page > 2 ? String(index.page - 1) : null,
                  })
                }
                className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
                {t('referencesIndex.previous')}
              </button>
              <span className="text-xs text-muted-foreground">
                {t('referencesIndex.pageOf', {
                  page: index.page,
                  pages: index.totalPages,
                })}
              </span>
              <button
                type="button"
                disabled={index.page >= index.totalPages}
                onClick={() => updateParams({ page: String(index.page + 1) })}
                className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-40"
              >
                {t('referencesIndex.next')}
                <ChevronRight className="h-4 w-4" />
              </button>
            </nav>
          )}
        </>
      )}
    </main>
  );
}
