import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  Search,
  Pill,
  BookOpen,
  FlaskConical,
  FileText,
  Plus,
} from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { useCan, usePermissionOverrides } from '@/lib/usePermissions';
import { useTranslation } from 'react-i18next';
import { buildSimulatorUrl } from '@/lib/simulatorRouting';
import { buildDrugComponentId } from '@/lib/drugComponentId';
import { fetchDrugSearchResults } from '@/lib/drugApi';
import {
  searchReferences,
  referenceModulePath,
  type ReferenceSearchHit,
} from '@/lib/referencesApi';
import type { TFunction } from 'i18next';
import { citationTooltipLabel, citationTooltipTitle } from '@/lib/citationFormat';
import { loadMethods } from '@/data';
import { canAccessAnalyticalMethods } from '@/lib/featureAccess';
import {
  buildDrugSearchSubtitle,
  formatGenericDrugName,
  resolveDrugName,
} from '@/lib/drugNames';
import { activeLangCode } from '@/lib/useDrugName';
import { useOverlayLayer } from '@/lib/overlayStack';
import type { AnalyticalMethod } from '@/types';

type SearchContext = 'wiki' | 'table' | 'simulator' | 'other';

interface DrugResult {
  type: 'drug';
  id: string;
  title: string;
  subtitle?: string;
  drugId: number;
  pubchemCid?: number | null;
  slug?: string | null;
}

interface WikiResult {
  type: 'wiki';
  id: string;
  title: string;
  subtitle?: string;
  slug: string;
}

interface MethodResult {
  type: 'method';
  id: string;
  title: string;
  subtitle?: string;
  methodId: number;
}

interface ReferenceResult {
  type: 'reference';
  id: string;
  title: string;
  subtitle?: string;
  referenceId: number;
}

type SearchResult =
  | DrugResult
  | WikiResult
  | MethodResult
  | ReferenceResult;

interface WikiSearchResponse {
  results?: Array<{
    slug: string;
    title: string;
    pageType?: string;
  }>;
  pages?: Array<{
    slug: string;
    title: string;
    pageType?: string;
  }>;
}

// Relevance tiers, lower = better. We rank every candidate the same way
// regardless of source so the merged list reads "best match first" instead of
// "methods first, then drugs". See bestRank() below.
const RANK_EXACT = 0; // a field equals the query outright ("etanol" === "etanol")
const RANK_PREFIX = 1; // a field starts with the query ("ethanol…")
const RANK_WORD = 2; // the query starts a later word ("…ADH SCR" matching "scr")
const RANK_SUBSTRING = 3; // the query appears somewhere inside a field
const RANK_NONE = 4; // no textual match (kept so pre-filtered rows still sort)

// Source priority, used only to break ties between equal-rank matches so that
// an exact drug outranks an exact method, a prefix drug outranks a prefix
// method, and so on.
const TYPE_RANK: Record<SearchResult['type'], number> = {
  drug: 0,
  method: 1,
  reference: 2,
  wiki: 3,
};

// api/_lib/reference-search.ts ranks a hit 0–5; fold those tiers onto the
// palette's own scale. Only an identifier the user typed in full earns
// RANK_EXACT; a title that starts with the query is a prefix hit; everything
// else — including a keyword found deep in a paper review — sorts as a
// substring match, below the drugs and methods it shares the list with.
const REFERENCE_RANKS = [
  RANK_EXACT,
  RANK_PREFIX,
  RANK_WORD,
  RANK_SUBSTRING,
  RANK_SUBSTRING,
  RANK_SUBSTRING,
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Best (lowest) relevance tier across a set of candidate fields for one row —
// e.g. all of a drug's names + aliases, or a method's code + name. Comparisons
// are case-insensitive; the query is expected pre-lowercased and trimmed.
function bestRank(query: string, fields: Array<string | null | undefined>): number {
  let best = RANK_NONE;
  const wordStart = new RegExp(`[\\s\\-–/](?:${escapeRegExp(query)})`);
  for (const field of fields) {
    if (!field) continue;
    const value = field.toLowerCase().trim();
    if (!value) continue;
    if (value === query) return RANK_EXACT; // can't beat exact
    if (value.startsWith(query)) best = Math.min(best, RANK_PREFIX);
    else if (wordStart.test(value)) best = Math.min(best, RANK_WORD);
    else if (value.includes(query)) best = Math.min(best, RANK_SUBSTRING);
  }
  return best;
}

function referenceSubtitle(
  hit: ReferenceSearchHit,
  t: TFunction,
): string {
  if (hit.matchSource === 'review' && hit.reviewSnippet) {
    return t('search.referenceReviewSubtitle', { snippet: hit.reviewSnippet });
  }
  const label = citationTooltipLabel(hit);
  return label
    ? t('search.referenceSubtitle', { label })
    : t('search.reference');
}

function getContext(pathname: string): SearchContext {
  if (pathname.startsWith('/wiki')) return 'wiki';
  // PR 3: `/simulator(/ethanol)` and `/kinelab` are now redirects to
  // `/modeling?mode=…`. All three modeling modes share the same drug
  // lookup behavior (clicking a drug opens it in the simulator), so
  // treat any /modeling location — and the legacy paths still
  // resolvable by external bookmarks — as the simulator context.
  if (pathname.startsWith('/modeling')) return 'simulator';
  if (pathname.startsWith('/simulator')) return 'simulator';
  if (pathname.startsWith('/kinelab')) return 'simulator';
  if (pathname === '/' || pathname.startsWith('/drug')) return 'table';
  return 'other';
}

export function CommandPalette() {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // The palette renders above any open ModalOverlay (z-60 vs z-50), so it has
  // to claim the top of the overlay stack — otherwise that modal's focus trap
  // keeps pulling Tab out of the palette and back into the box behind it.
  useOverlayLayer(open);
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  // The shortcut navigates to /wiki/new and then creates a catalog drug, so
  // it needs both of that flow's capabilities to be worth offering. Both
  // hooks run unconditionally; `&&` inline would short-circuit the second.
  const mayCreateDrugRow = useCan('drug.create');
  const maySubmitPage = useCan('wiki.page.submit');
  const canCreateDrug = mayCreateDrugRow && maySubmitPage;
  const permissionOverrides = usePermissionOverrides();
  const canMethods = canAccessAnalyticalMethods(user, permissionOverrides);
  const [methods, setMethods] = useState<AnalyticalMethod[]>([]);
  const methodsLoadedRef = useRef(false);
  const methodsLoadPromiseRef = useRef<Promise<void> | null>(null);
  const methodsLoadEpochRef = useRef(0);
  const context = getContext(location.pathname);

  // Analytical methods are gated to admins + the rettstoks group. Load the
  // method list once per eligible session so repeated Ctrl+K opens reuse the
  // data-layer cache instead of issuing a fresh /api/methods request.
  useEffect(() => {
    if (!canMethods) {
      methodsLoadEpochRef.current += 1;
      methodsLoadPromiseRef.current = null;
      methodsLoadedRef.current = false;
      setMethods([]);
      return;
    }
    if (!open || methodsLoadedRef.current || methodsLoadPromiseRef.current)
      return;
    const epoch = methodsLoadEpochRef.current;
    methodsLoadPromiseRef.current = loadMethods()
      .then((rows) => {
        if (methodsLoadEpochRef.current === epoch) {
          setMethods(rows);
          methodsLoadedRef.current = true;
        }
      })
      .catch(() => {
        if (methodsLoadEpochRef.current === epoch) setMethods([]);
      })
      .finally(() => {
        if (methodsLoadEpochRef.current === epoch) {
          methodsLoadPromiseRef.current = null;
        }
      });
  }, [open, canMethods]);

  // Ctrl+K / Cmd+K to open
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setResults([]);
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  const search = useCallback(
    async (q: string, signal?: AbortSignal) => {
      const trimmed = q.trim();
      if (!trimmed) {
        setResults([]);
        return;
      }
      const encoded = encodeURIComponent(trimmed);
      const [drugsRes, wikiRes, referenceHits] = await Promise.all([
        fetchDrugSearchResults({ q: trimmed, limit: 20, signal }).catch(
          (err) => {
            if ((err as Error).name === 'AbortError') throw err;
            return { drugs: [] };
          },
        ),
        fetch(`/api/wiki/search?q=${encoded}&limit=6&view=compact`, {
          signal,
        }).then((r) =>
          r.ok ? (r.json() as Promise<WikiSearchResponse>) : { results: [] },
        ),
        // Cited sources are searchable by DOI, PubMed ID, metadata, or a
        // phrase from the agent's review of the paper — the identifiers users
        // paste straight out of a PDF used to return nothing at all.
        searchReferences(trimmed, { limit: 5, signal }).catch((err) => {
          if ((err as Error).name === 'AbortError') throw err;
          return [];
        }),
      ]);
      if (signal?.aborted) return;

      // Score every candidate by how closely it matches the query, then sort
      // across all sources so the list reads "best match first". Ties break by
      // source priority (drug > method > wiki), giving the desired order:
      // exact drug → exact method → approx drug → approx method → wiki.
      const lowered = trimmed.toLowerCase();
      const scored: Array<{ result: SearchResult; rank: number }> = [];

      // Analytical methods — codes like "9001" are exact, memorable identifiers
      // users type to jump straight to a panel, so an exact code/name match
      // ranks as highly as an exact drug name. Keep at most the 6 most relevant.
      const methodMatches: Array<{ result: SearchResult; rank: number }> = [];
      for (const m of methods) {
        // #797: methods come from the cached data layer — `m.id` is the
        // analytical-method code string, `m.dbId` the numeric PK used to link
        // to the detail page. Skip rows without a resolvable DB id — they
        // can't be navigated to.
        const methodId = m.dbId;
        if (typeof methodId !== 'number') continue;
        // Rank across the code, name, and numeric id; drop non-matches so only
        // genuine hits enter the merged, relevance-sorted list.
        const rank = bestRank(lowered, [m.id, m.name, String(methodId)]);
        if (rank === RANK_NONE) continue;
        methodMatches.push({
          result: {
            type: 'method',
            id: `method-${methodId}`,
            title: `${m.id} – ${m.name}`,
            subtitle: t('search.method'),
            methodId,
          },
          rank,
        });
      }
      methodMatches.sort((a, b) => a.rank - b.rank);
      scored.push(...methodMatches.slice(0, 6));

      for (const d of (drugsRes.drugs ?? []) as Array<{
        id: number;
        names: Record<string, string>;
        nameShort?: string | null;
        aliases?: string[] | null;
        pubchemCid?: number | null;
        slug?: string | null;
      }>) {
        const primary = resolveDrugName(d.names, lang);
        scored.push({
          result: {
            type: 'drug',
            id: `drug-${d.id}`,
            title: formatGenericDrugName(primary),
            // Show the English name plus the short name and aliases in the
            // gray subtitle so a row matched via an alias/abbreviation reveals
            // why; the matched term is floated to the front (see helper).
            subtitle: buildDrugSearchSubtitle(
              d.names,
              primary,
              d.nameShort,
              d.aliases,
              lowered,
            ),
            drugId: d.id,
            pubchemCid: d.pubchemCid ?? null,
            slug: d.slug ?? null,
          },
          // Match against every name + alias, not just the displayed primary,
          // so typing an alias still scores as an exact/prefix hit.
          rank: bestRank(lowered, [
            ...Object.values(d.names),
            d.nameShort,
            ...(d.aliases ?? []),
          ]),
        });
      }
      for (const hit of referenceHits) {
        // Rank tiers come from the server, which is the only side that knows
        // whether the query *equals* the identifier (rank 0) or merely appears
        // somewhere inside it. Mapping them here — rather than re-deriving from
        // the title — keeps a pasted DOI at the top without promoting every row
        // whose DOI happens to contain the typed fragment.
        const titleRank = REFERENCE_RANKS[hit.matchRank] ?? RANK_SUBSTRING;
        scored.push({
          result: {
            type: 'reference',
            id: `reference-${hit.id}`,
            title: citationTooltipTitle(hit),
            // One key per rendered sentence — the separator, ordering and
            // ellipses belong to the translator, not to string concatenation
            // here (AGENTS.md § Internationalization).
            subtitle: referenceSubtitle(hit, t),
            referenceId: hit.id,
          },
          rank: titleRank,
        });
      }
      for (const p of wikiRes.results ?? wikiRes.pages ?? []) {
        // Every drug now owns a monograph, so a `drug_monograph` wiki hit is
        // always a duplicate of the drug result above (which already opens the
        // monograph on click and via the Wiki quick-action). Skip it so the
        // palette lists each drug once instead of showing two near-identical
        // rows.
        if (p.pageType === 'drug_monograph') continue;
        scored.push({
          result: {
            type: 'wiki',
            id: `wiki-${p.slug}`,
            title: p.title,
            subtitle: t('search.wikiPage'),
            slug: p.slug,
          },
          rank: bestRank(lowered, [p.title]),
        });
      }

      // Stable sort: rank first, then source priority on ties. Array.sort is
      // stable, so within an equal (rank, type) the backend's drug ordering and
      // the method relevance order above are preserved.
      scored.sort(
        (a, b) =>
          a.rank - b.rank ||
          TYPE_RANK[a.result.type] - TYPE_RANK[b.result.type],
      );

      setResults(scored.map((s) => s.result));
      setSelected(0);
    },
    [lang, t, methods],
  );

  // Debounced search
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      search(query, controller.signal).catch((err) => {
        if ((err as Error).name !== 'AbortError') setResults([]);
      });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open, search]);

  async function openInWiki(result: DrugResult) {
    setOpen(false);
    // The drug's slug (e.g. "acetaminophen") is not necessarily the wiki
    // monograph's slug (e.g. "paracetamol"). Resolve the actual monograph slug
    // server-side so Norwegian-slugged pages open instead of a 404 redirect
    // through the English drug slug.
    //
    // `wiki_pages.drug_cid` can be either the internal drugs.id (modern) or a
    // PubChem CID (legacy seed data). Try both — DrugMonographSidebar applies
    // the same fallback when resolving a drug row.
    const candidates = [result.drugId, result.pubchemCid].filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v),
    );
    for (const cid of candidates) {
      try {
        const res = await fetch(`/api/wiki/pages?drugCid=${cid}`);
        if (!res.ok) continue;
        const data = (await res.json()) as { page?: { slug?: string } };
        if (data.page?.slug) {
          navigate(`/wiki/${data.page.slug}`);
          return;
        }
      } catch {
        // try the next candidate
      }
    }
    navigate(`/wiki/drug/${result.drugId}`);
  }

  function openInSimulator(result: DrugResult) {
    setOpen(false);
    navigate(
      buildSimulatorUrl({
        id: buildDrugComponentId({ id: result.drugId, pubchemCid: result.pubchemCid }),
        pubchemCid: result.pubchemCid ?? null,
        dbId: result.drugId,
      }),
    );
  }

  function openWiki(result: WikiResult) {
    setOpen(false);
    navigate(`/wiki/${result.slug}`);
  }

  function openMethod(result: MethodResult) {
    setOpen(false);
    navigate(`/methods/${result.methodId}`);
  }

  function openReference(result: ReferenceResult) {
    setOpen(false);
    navigate(referenceModulePath(result.referenceId));
  }

  // No hit anywhere — offer privileged users a one-click path to create the
  // missing drug. Lands on the new-monograph search stage pre-filled with the
  // typed name, which re-runs the kinetix + PubChem de-duplication lookups
  // before the author commits to creating it.
  function createDrug(typedQuery: string) {
    setOpen(false);
    navigate(
      `/wiki/new?type=drug_monograph&q=${encodeURIComponent(typedQuery)}`,
    );
  }

  function handleSelect(result: SearchResult) {
    if (result.type === 'wiki') {
      openWiki(result);
      return;
    }
    if (result.type === 'method') {
      openMethod(result);
      return;
    }
    if (result.type === 'reference') {
      openReference(result);
      return;
    }
    // Drug — contextual default. Everywhere except the simulator opens the
    // full monograph page (`/wiki/{slug}`) so the selection lands on a real,
    // shareable URL instead of the embedded landing-page preview that left
    // the address bar on `/` and offered a separate "open full page" link.
    // The explicit table quick-action below still opens the inline panel for
    // anyone who wants to browse alongside the table.
    if (context === 'simulator') openInSimulator(result);
    else openInWiki(result);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === 'Enter') {
      const result = results[selected];
      if (!result) return;
      // Ctrl/Cmd+Enter → send a drug result straight to the simulator
      // regardless of the current page context (#308). For wiki results
      // the simulator action doesn't apply, so fall through to the
      // standard contextual select.
      if ((e.ctrlKey || e.metaKey) && result.type === 'drug') {
        e.preventDefault();
        openInSimulator(result);
        return;
      }
      handleSelect(result);
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 bg-white/8 hover:bg-white/15 px-3 py-1.5 rounded-md text-white/50 hover:text-white/80 text-sm transition-colors"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{t('nav.search')}</span>
        <kbd className="hidden sm:inline text-[10px] bg-white/10 px-1.5 py-0.5 rounded font-mono">
          Ctrl+K
        </kbd>
      </button>
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={() => setOpen(false)}
      />

      {/* Palette */}
      <div className="relative w-full max-w-lg bg-card rounded-xl shadow-2xl border overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 border-b">
          <Search className="h-5 w-5 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('search.placeholder')}
            className="flex-1 bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
          />
          <kbd className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
            Esc
          </kbd>
        </div>

        {results.length > 0 && (
          <ul className="max-h-80 overflow-y-auto py-2">
            {results.map((r, i) => (
              <li key={r.id}>
                <div
                  onMouseEnter={() => setSelected(i)}
                  className={`flex items-center gap-3 px-4 py-2.5 text-sm ${
                    i === selected ? 'bg-muted' : 'hover:bg-muted/50'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => handleSelect(r)}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    {r.type === 'drug' ? (
                      <Pill className="h-4 w-4 text-primary shrink-0" />
                    ) : r.type === 'method' ? (
                      <FlaskConical className="h-4 w-4 text-amber-600 shrink-0" />
                    ) : r.type === 'reference' ? (
                      <FileText className="h-4 w-4 text-sky-600 shrink-0" />
                    ) : (
                      <BookOpen className="h-4 w-4 text-emerald-600 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="font-medium text-foreground truncate">
                        {r.title}
                      </div>
                      {r.subtitle && (
                        <div className="text-xs text-muted-foreground truncate">
                          {r.subtitle}
                        </div>
                      )}
                    </div>
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {query.trim() && results.length === 0 && (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            <p>{t('search.noResults', { query: query.trim() })}</p>
            {/* The shortcut lands on the drug-creation flow, so gate it on
                the capability that flow needs rather than on admin-panel
                access — otherwise a delegated panel user is sent into a 403. */}
            {canCreateDrug && (
              <button
                type="button"
                onClick={() => createDrug(query.trim())}
                className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Plus className="h-4 w-4" />
                {t('search.createDrug', { query: query.trim() })}
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
