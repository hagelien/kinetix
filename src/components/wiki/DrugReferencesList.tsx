import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { referenceModulePath, type CitationRow } from '@/lib/referencesApi';
import {
  useDrugBibliography,
  type OrderedReference,
} from '@/lib/useDrugBibliography';

interface Props {
  /**
   * Identifier from `wiki_pages.drug_cid` — can be either the internal
   * `drugs.id` (modern) or a legacy PubChem CID. Resolution to the internal
   * id happens inside the hook. Ignored when `orderedRefs` is supplied.
   */
  drugIdOrCid?: number;
  /**
   * Pre-computed ordering from the parent. When supplied, no fetch is
   * issued — the parent is the source of truth (this is the path used by
   * monograph pages so the inline footnote markers and this list share one
   * numbering).
   */
  orderedRefs?: OrderedReference[] | null;
  /**
   * Footnote ref IDs extracted from the monograph body. Only used in the
   * fallback (self-fetching) mode.
   */
  footnoteReferenceIds?: number[];
  /**
   * Optional referenceId to highlight (e.g. the footnote at the editor
   * cursor). The matching `<li>` gets a soft accent and `aria-current` so
   * authors can see at a glance which source backs the prose they're
   * writing. Read-only callers leave this unset.
   */
  activeReferenceId?: number | null;
  /**
   * When true, render the list as a height-constrained scroll container so
   * long bibliographies don't stretch the surrounding layout and so the
   * highlight-scroll effect has somewhere to scroll *within* (never the
   * page). Used by the editor-side panel; read-only views leave this
   * unset to keep the traditional "full bibliography at the end of the
   * document" rendering.
   */
  scrollable?: boolean;
}

function joinAuthors(authors: string[] | undefined): string {
  if (!authors || authors.length === 0) return '';
  return authors.join(', ');
}

/**
 * Render a citation row in NLM-ish format:
 *   Authors. Title. Journal. Year;Volume:Pages. doi: DOI. PMID: PMID.
 * DOI / PMID / URL references link to the reference module first; that
 * page owns direct outbound source links and agent review status. Open
 * module links in a new tab because this list also renders inside the
 * wiki editor, where same-tab navigation would discard unsaved draft state.
 */
function renderCitation(row: CitationRow): JSX.Element {
  const meta = (row.metadata ?? {}) as {
    title?: string;
    authors?: string[];
    journal?: string;
    year?: number | null;
    volume?: string | null;
    pages?: string | null;
  };
  const authors = joinAuthors(meta.authors);
  // Freetext citations typically store their visible text in `identifier`
  // rather than `metadata.title`, so fall back to it when no metadata
  // title is supplied. DOI/PMID rows already expose their identifier via
  // the trailing "doi: X" / "PMID: Y" link, so we don't duplicate it here.
  const title =
    meta.title?.trim() || (row.type === 'freetext' ? row.identifier : '');
  const journal = meta.journal?.trim() || '';
  const year = meta.year ?? '';
  const volume = meta.volume?.trim() || '';
  const pages = meta.pages?.trim() || '';

  // Build "Year;Volume:Pages" segment, dropping pieces that are missing.
  let citationCore = '';
  if (year) citationCore += `${year}`;
  if (volume) citationCore += `${citationCore ? ';' : ''}${volume}`;
  if (pages) citationCore += `${citationCore ? ':' : ''}${pages}`;

  const isDoi = row.type === 'doi';
  const isPmid = row.type === 'pmid';
  const isUrl = row.type === 'url';
  const moduleHref = referenceModulePath(row.id);

  return (
    <span className="break-words">
      {authors && <>{authors}. </>}
      {isUrl ? (
        <a
          href={moduleHref}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline hover:no-underline"
        >
          {title || row.identifier}
        </a>
      ) : (
        title && <>{title}. </>
      )}
      {!isUrl && journal && <>{journal}. </>}
      {!isUrl && citationCore && <>{citationCore}. </>}
      {isDoi && (
        <>
          doi:{' '}
          <a
            href={moduleHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline hover:no-underline"
          >
            {row.identifier}
          </a>
          .{' '}
        </>
      )}
      {isPmid && (
        <>
          PMID:{' '}
          <a
            href={moduleHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary underline hover:no-underline"
          >
            {row.identifier}
          </a>
          .
        </>
      )}
    </span>
  );
}

/**
 * Lists every citation attached to a drug in stable bibliography order.
 * Each entry gets an `id="param-ref-N"` anchor so the `[N]` superscripts on
 * parameter values and inline monograph footnotes can link into this list.
 */
export function DrugReferencesList({
  drugIdOrCid,
  orderedRefs,
  footnoteReferenceIds = [],
  activeReferenceId,
  scrollable = false,
}: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(scrollable);
  const fallback = useDrugBibliography(
    orderedRefs === undefined && drugIdOrCid != null ? drugIdOrCid : null,
    footnoteReferenceIds,
  );
  const ordered = orderedRefs !== undefined ? orderedRefs : fallback.ordered;
  const containerRef = useRef<HTMLOListElement | null>(null);

  // Bring the highlighted entry into view *inside the panel*, never the
  // document. We can't use Element.scrollIntoView here because it walks up
  // to the nearest scrollable ancestor and would yank the whole page if
  // the panel itself isn't a scroll container — which is the default
  // layout. Instead, scroll the <ol> only when it actually overflows.
  useEffect(() => {
    if (activeReferenceId == null) return;
    if (!expanded) {
      setExpanded(true);
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(
      `[data-reference-id="${activeReferenceId}"]`,
    );
    if (!target) return;
    const isScrollable = container.scrollHeight > container.clientHeight;
    if (!isScrollable) return;
    const targetTop = target.offsetTop - container.offsetTop;
    const targetBottom = targetTop + target.offsetHeight;
    if (targetTop < container.scrollTop) {
      container.scrollTop = targetTop;
    } else if (targetBottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = targetBottom - container.clientHeight;
    }
    // `ordered` is in deps because the active row may not exist yet when
    // a footnote is inserted before async bibliography fetches resolve;
    // re-running once rows arrive lets us scroll to the late-arriving row.
  }, [activeReferenceId, expanded, ordered]);

  useEffect(() => {
    function expandForHash() {
      if (!window.location.hash.startsWith('#param-ref-')) return;
      setExpanded(true);
    }
    function expandForReferenceClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest<HTMLAnchorElement>('a[href^="#param-ref-"]');
      if (!link) return;
      setExpanded(true);
    }
    expandForHash();
    window.addEventListener('hashchange', expandForHash);
    document.addEventListener('click', expandForReferenceClick);
    return () => {
      window.removeEventListener('hashchange', expandForHash);
      document.removeEventListener('click', expandForReferenceClick);
    };
  }, []);

  useEffect(() => {
    if (!expanded || !window.location.hash.startsWith('#param-ref-')) return;
    const target = document.getElementById(window.location.hash.slice(1));
    target?.scrollIntoView?.({ block: 'start' });
  }, [expanded, ordered]);

  if (!ordered || ordered.length === 0) return null;

  return (
    <section className="mt-8 border-t border-border pt-4">
      <h3 className="mb-2 text-base font-semibold">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-3 rounded-md py-1 text-left hover:text-primary"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <span>
            {t('wiki.references')} ({ordered.length})
          </span>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
      </h3>
      {/*
        pl-8 (not pl-4): the <ol> marker sits in the left padding with
        list-style-position: outside, so the padding has to fit the widest
        number that will render. pl-4 (16px) only fits a single digit, which
        meant the leading "1" of "10." onwards got clipped against the
        container's left edge — the rendered list looked like 9, 0, 1, 2…
        See #282. pl-8 (32px) holds 3-digit indices comfortably.
      */}
      {expanded ? (
        <ol
          ref={containerRef}
          className={`text-sm space-y-1 pl-8 list-decimal ${
            scrollable
              ? 'max-h-64 overflow-y-auto rounded border border-border/40 py-1'
              : ''
          }`}
        >
          {ordered.map(({ index, row }) => {
            const isActive =
              activeReferenceId != null && row.id === activeReferenceId;
            return (
              <li
                key={row.id}
                id={`param-ref-${index}`}
                data-reference-id={row.id}
                aria-current={isActive ? 'true' : undefined}
                className={`scroll-mt-20 rounded px-1 ${
                  isActive ? 'bg-accent/40 ring-1 ring-primary/30' : ''
                }`}
              >
                {renderCitation(row)}
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}
