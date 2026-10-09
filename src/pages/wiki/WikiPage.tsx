import { useEffect, useMemo, useState } from 'react';
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
  Link,
} from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  WikiRenderer,
  extractFootnoteIds,
  type MonographParameterValueMap,
} from '@/components/wiki/WikiRenderer';
import { DrugMonographSidebar } from '@/components/wiki/DrugMonographSidebar';
import { DrugMetadataHeader } from '@/components/wiki/DrugMetadataHeader';
import { DrugAnalyticalMethods } from '@/components/wiki/DrugAnalyticalMethods';
import { DrugSeedPromptButton } from '@/components/wiki/DrugSeedPromptButton';
import { DeleteWikiPageButton } from '@/components/wiki/DeleteWikiPageButton';
import { FactDiscussionPanel } from '@/components/wiki/FactDiscussionPanel';
import { DrugReferencesList } from '@/components/wiki/DrugReferencesList';
import { EntityMetabolismDrugs } from '@/components/wiki/EntityMetabolismDrugs';
import { useDrugBibliography } from '@/lib/useDrugBibliography';
import { useAuthStore } from '@/stores/authStore';
import { useCan } from '@/lib/usePermissions';
import { fetchPendingEdits, type PendingEditRow } from '@/lib/pendingEditsApi';
import { fetchFactVerificationLevels } from '@/lib/verificationLevelsApi';
import type { VerificationLevelInfo } from '@/lib/verificationLevel';
import {
  fetchDrugByWikiDrugId,
  drugRowToComponent,
  type DrugRow,
} from '@/lib/drugApi';
import {
  fetchDrugIndicators,
  fetchWikiPageIndicators,
} from '@/lib/drugIndicatorsApi';
import { capitalizeGenericDrugName, resolveDrugName } from '@/lib/drugNames';
import { useDrugStore } from '@/stores/drugStore';
import type { UserBadgeData } from '@/components/ui/UserBadge';
import {
  DEFAULT_MONOGRAPH_TAB,
  filterMonographHtmlForTab,
  isMonographTabId,
  loadLastMonographTab,
  monographTabLabelKey,
  monographTabPath,
  saveLastMonographTab,
  tabForParameter,
  type MonographTabId,
} from '@/lib/monographTabs';
import { DrugUnitScope } from '@/components/ui/DrugUnitScope';
import { isEthanolDrug } from '@/lib/ethanolUnits';

interface WikiPageData {
  id: number;
  slug: string;
  title: string;
  content: unknown;
  contentHtml: string;
  pageType: string;
  drugCid: number | null;
  /** Set only for `entity_monograph` pages: the bio entity this page describes. */
  entityId: number | null;
  parentId: number | null;
  updatedAt: string;
  updatedBy: UserBadgeData | null;
}

interface WikiPageNeighbour {
  id: number;
  slug: string;
  title: string;
  pageType: string;
}

export function WikiPage() {
  const { t } = useTranslation();
  const { slug, tab: tabParam } = useParams<{ slug: string; tab?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const [page, setPage] = useState<WikiPageData | null>(null);
  const [ancestors, setAncestors] = useState<WikiPageNeighbour[]>([]);
  const [children, setChildren] = useState<WikiPageNeighbour[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const { user } = useAuthStore();
  const [pendingEdit, setPendingEdit] = useState<PendingEditRow | null>(null);
  const [factDiscussion, setFactDiscussion] = useState<{
    factId: string;
  } | null>(null);
  const [discussionCounts, setDiscussionCounts] = useState<
    Record<string, number>
  >({});
  const [factLevels, setFactLevels] = useState<
    Record<string, VerificationLevelInfo>
  >({});

  // Edit link visible to contributor+ only - `authenticated` is the
  // default read-only role and the API would 403 every fact submission
  // they made. Admins land in the legacy whole-page editor; everyone
  // else lands in TopicSectionsEditor / MonographSectionsEditor.
  // /wiki/:slug/edit hosts both workflows, so the link follows either
  // capability — the editor then shows only the saves the caller holds.
  // Both hooks run unconditionally; `||` would short-circuit the second.
  const canSubmitFacts = useCan('edit.wikiFact.submit');
  const canSubmitPage = useCan('wiki.page.submit');
  const canEdit = canSubmitFacts || canSubmitPage;

  useEffect(() => {
    setFactDiscussion(null);
  }, [slug]);

  useEffect(() => {
    const pageId = page?.id;
    if (!pageId) {
      setFactLevels({});
      return;
    }
    let cancelled = false;
    setFactLevels({});
    fetchFactVerificationLevels(pageId)
      .then((levels) => {
        if (!cancelled) setFactLevels(levels);
      })
      .catch(() => {
        if (!cancelled) setFactLevels({});
      });
    return () => {
      cancelled = true;
    };
  }, [page?.id]);

  useEffect(() => {
    if (!page || !user) return;
    fetchPendingEdits({
      status: 'all',
      submittedBy: user.id,
      targetId: page.id,
    })
      .then((data) => {
        const match = data.pendingEdits.find(
          (e) => e.editType === 'wiki_page' && e.targetId === page.id,
        );
        setPendingEdit(match ?? null);
      })
      .catch(() => setPendingEdit(null));
  }, [page, user]);

  useEffect(() => {
    if (!slug) return;
    setLoading(true);
    setNotFound(false);
    fetch(`/api/wiki/pages?slug=${encodeURIComponent(slug)}`)
      .then((res) => {
        if (res.status === 404) {
          setNotFound(true);
          setLoading(false);
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (data) {
          setPage(data.page);
          setAncestors(Array.isArray(data.ancestors) ? data.ancestors : []);
          setChildren(Array.isArray(data.children) ? data.children : []);
          setLoading(false);
        }
      })
      .catch(() => setLoading(false));
  }, [slug]);

  const isMonograph = page?.pageType === 'drug_monograph';
  const activeTab: MonographTabId = isMonographTabId(tabParam)
    ? tabParam
    : DEFAULT_MONOGRAPH_TAB;

  // A drug monograph is always shown one tab at a time, and the tab is part
  // of the URL so it can be bookmarked and shared. A bare `/wiki/<slug>`
  // opens the tab a deep-linked parameter lives on, or else the tab the
  // reader was last on — switching drug keeps the same topic in view.
  useEffect(() => {
    if (!page || page.pageType !== 'drug_monograph' || page.slug !== slug) {
      return;
    }
    if (isMonographTabId(tabParam)) {
      saveLastMonographTab(tabParam);
      return;
    }
    const linkedParam = searchParams.get('param');
    const target =
      (tabParam === undefined && linkedParam
        ? tabForParameter(linkedParam)
        : null) ?? loadLastMonographTab();
    navigate(
      `${monographTabPath(page.slug, target)}${location.search}${location.hash}`,
      { replace: true },
    );
  }, [
    page,
    slug,
    tabParam,
    searchParams,
    navigate,
    location.search,
    location.hash,
  ]);

  const footnoteRefIds = useMemo(
    () => (page ? extractFootnoteIds(page.content) : []),
    [page],
  );
  const drugIdOrCid =
    page?.pageType === 'drug_monograph' ? (page.drugCid ?? null) : null;
  // The resolved row is kept **with the drugCid that asked for it**, not just
  // on its own. Whether a row belongs to this page cannot be re-derived from
  // the row: `drugs.id` and `drugs.pubchem_cid` share a number space, and the
  // collision is real (25C-NBOMe id=281 vs carbon monoxide pubchem_cid=281 —
  // see the resolver in `api/drugs.ts`). Comparing the row against drugCid on
  // either column therefore passes the *previous* monograph's row whenever its
  // CID happens to equal the next monograph's id. The request key has no such
  // ambiguity.
  const [resolvedDrug, setResolvedDrug] = useState<{
    key: number;
    row: DrugRow;
  } | null>(null);
  const drug = resolvedDrug?.row ?? null;
  const drugComponent = useMemo(
    () => (drug ? drugRowToComponent(drug) : null),
    [drug],
  );
  // The row **only** when this page is the one that asked for it. Two gaps make
  // `drug` alone unsafe to read: the fetch is in flight on first paint, and a
  // client-side route change commits the new `page` one render before the
  // effect that clears the previous monograph's row.
  const matchedDrug = resolvedDrug?.key === drugIdOrCid ? drug : null;
  const bibliographyDrugId =
    page?.pageType === 'drug_monograph' ? (drug?.id ?? null) : null;
  const { ordered: orderedRefs, bibliographyMap } = useDrugBibliography(
    bibliographyDrugId,
    footnoteRefIds,
    { resolvedDrugId: bibliographyDrugId },
  );
  // Hand WikiRenderer the citation rows by id so it can render
  // [Surname Year] markers that link directly to DOI/PMID/URL (#265).
  const citationsById = useMemo(() => {
    if (!orderedRefs) return undefined;
    const map = new Map<number, (typeof orderedRefs)[number]['row']>();
    for (const { row } of orderedRefs) map.set(row.id, row);
    return map;
  }, [orderedRefs]);

  // Load the drug row so we can hydrate the inline parameter-anchor
  // placeholders (issue #276 phase 1d). `wikiPages.drugCid` is mixed-vintage
  // data: modern rows store `drugs.id`, while legacy rows can store PubChem
  // CID. The API resolver checks both candidates in one query and rejects
  // ambiguous collisions instead of making clients issue /id and /cid reads.
  useEffect(() => {
    // Clear the previous monograph's drug row immediately so a client-
    // side route change can't render the new page's parameter anchors
    // with stale values during the brief gap between /api/wiki/pages
    // resolving and the new fetch completing.
    setResolvedDrug(null);
    if (drugIdOrCid == null) return;
    const requestedCid = drugIdOrCid;
    let cancelled = false;
    (async () => {
      // `fresh: true` bypasses the CDN/browser cache. The default
      // /api/drugs cache headers (s-maxage=60 + swr=600) are right for
      // sidebar/list views but would let an approved parameter update
      // sit invisible in the inline anchors for up to ~10 minutes,
      // contradicting the "live drug row" claim Phase 1d makes.
      const resolved = await fetchDrugByWikiDrugId(drugIdOrCid, {
        fresh: true,
      })
        .then(({ drug }) => drug)
        .catch((err) => {
          if (typeof console !== 'undefined') {
            console.warn(
              `WikiPage: failed to resolve drugCid=${drugIdOrCid} for parameter values`,
              err,
            );
          }
          return null;
        });
      if (cancelled) return;
      setResolvedDrug(resolved ? { key: requestedCid, row: resolved } : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [drugIdOrCid]);

  // Promote the page's drug to the global "active drug" so the drug table
  // (sidebar/full) highlights the same row the user is reading about. The
  // table is the canonical surface for "current drug"; opening a monograph
  // directly via URL or a wiki link should not desync the two views (#309).
  const setActiveDrug = useDrugStore((s) => s.setActiveDrug);
  useEffect(() => {
    if (!matchedDrug || !drugComponent) return;
    setActiveDrug(drugComponent);
  }, [matchedDrug, drugComponent, setActiveDrug]);

  useEffect(() => {
    let cancelled = false;
    setDiscussionCounts({});
    if (!drug) return;
    fetchDrugIndicators(drug.id)
      .then((data) => {
        if (!cancelled) setDiscussionCounts(data.comments);
      })
      .catch(() => {
        if (!cancelled) setDiscussionCounts({});
      });
    return () => {
      cancelled = true;
    };
  }, [drug]);

  // Topic (non-monograph) pages have no drug, so their fact-comment counts
  // come keyed by wiki page id. Mirrors the monograph branch above so
  // WikiRenderer surfaces the same Discuss ({{count}}) affordance on topic
  // facts.
  useEffect(() => {
    if (!page || page.pageType === 'drug_monograph') return;
    let cancelled = false;
    fetchWikiPageIndicators(page.id)
      .then((data) => {
        if (!cancelled) setDiscussionCounts(data.comments);
      })
      .catch(() => {
        if (!cancelled) setDiscussionCounts({});
      });
    return () => {
      cancelled = true;
    };
  }, [page?.id, page?.pageType]);

  const parameterValues = useMemo<
    MonographParameterValueMap | undefined
  >(() => {
    // Defense in depth: only hydrate from the row that matches this page's
    // drugCid (see `matchedDrug`), never from one still in flight or left
    // over from the monograph before it.
    if (!matchedDrug) return undefined;
    return {
      halfLife: matchedDrug.halfLife ?? undefined,
      volumeOfDistribution: matchedDrug.volumeOfDistribution ?? undefined,
      bioavailability: matchedDrug.bioavailability ?? undefined,
      proteinBinding: matchedDrug.proteinBinding ?? undefined,
      bloodPlasmaRatio: matchedDrug.bloodPlasmaRatio ?? undefined,
      tmax: matchedDrug.tmax ?? undefined,
      pKa: matchedDrug.pKa ?? undefined,
      aliases: matchedDrug.aliases ?? undefined,
      molecularWeight: matchedDrug.molecularWeight ?? undefined,
      pubchemCid: matchedDrug.pubchemCid ?? undefined,
    };
  }, [matchedDrug]);
  const updatedDate = page ? new Date(page.updatedAt).toLocaleDateString() : '';

  if (loading) {
    return <p className="text-muted-foreground">{t('wiki.loading')}</p>;
  }

  if (notFound || !page) {
    return (
      <div className="text-center py-12">
        <h1 className="text-2xl font-bold mb-2">{t('wiki.pageNotFound')}</h1>
        <p className="text-muted-foreground mb-4">
          {t('wiki.pageNotFoundDesc', { slug })}
        </p>
        <Link to="/wiki" className="text-primary hover:underline">
          {t('wiki.backToWiki')}
        </Link>
      </div>
    );
  }

  // Kinetix is a Norwegian product, so a drug monograph's main title is the
  // drug's Norwegian name whenever the linked row exposes one — independent of
  // the stored `page.title` (which may predate this rule or have been authored
  // in another language). Falls back to the stored title until the drug row
  // loads, or when the drug has no Norwegian name.
  const displayTitle = matchedDrug
    ? capitalizeGenericDrugName(resolveDrugName(matchedDrug.names, 'nb')) || page.title
    : page.title;

  // The seeding prompt drives an English-language literature search, so it
  // prefers `names.en`. `resolveDrugName` falls back to the row's other names
  // when there is no English entry (only one language is required), and that
  // fallback is wanted: substance names here are INN, so the Norwegian entry is
  // overwhelmingly the same token, and a prompt naming the drug in Norwegian is
  // far more useful than no button at all on a Norwegian-first product.
  //
  // What is *not* allowed is `page.title` — the stored title, which may be
  // stale or belong to the monograph before this one. The name comes from the
  // resolved row or the button stays hidden until that lands.
  const seedPromptDrugName = matchedDrug ? resolveDrugName(matchedDrug.names, 'en') : '';

  const breadcrumbs =
    ancestors.length > 0 ? (
      <nav
        aria-label={t('wiki.breadcrumbs')}
        className="mb-2 text-sm text-muted-foreground"
      >
        <ol className="flex flex-wrap items-center gap-1">
          <li>
            <Link to="/wiki" className="hover:text-foreground hover:underline">
              {t('wiki.title')}
            </Link>
          </li>
          {ancestors.map((a) => (
            <li key={a.id} className="flex items-center gap-1">
              <span aria-hidden="true">/</span>
              <Link
                to={`/wiki/${a.slug}`}
                className="hover:text-foreground hover:underline"
              >
                {a.title}
              </Link>
            </li>
          ))}
          <li className="flex items-center gap-1">
            <span aria-hidden="true">/</span>
            <span className="text-foreground" aria-current="page">
              {displayTitle}
            </span>
          </li>
        </ol>
      </nav>
    ) : null;

  const lastEdited = (
    <span className="text-muted-foreground">
      {t('wiki.lastEdited')}{' '}
      <Link
        to={`/wiki/${page.slug}/history`}
        className="text-foreground hover:text-primary hover:underline"
        aria-label={t('wiki.historyLinkLabel', {
          title: page.title,
          date: updatedDate,
        })}
      >
        {updatedDate}
      </Link>
    </span>
  );

  const pendingEditNotice = pendingEdit ? (
    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-accent">
      <Link
        to={`/review?mine=1&id=${pendingEdit.id}`}
        className="hover:underline"
      >
        {t('wiki.viewPending')}
      </Link>
      {(pendingEdit.status === 'pending' || pendingEdit.status === 'draft') && (
        <Link
          to={`/wiki/${page.slug}/edit?pendingEditId=${pendingEdit.id}`}
          className="hover:underline"
        >
          {t('wiki.updateDraft')}
        </Link>
      )}
      {pendingEdit.status !== 'pending' && pendingEdit.status !== 'draft' && (
        <span className="text-muted-foreground">
          {t('wiki.status', { status: pendingEdit.status })}
        </span>
      )}
    </div>
  ) : null;

  const onFactDiscussionClick =
    // Monographs need the resolved drug row to host the thread; topic pages
    // host fact threads on the page itself, so the affordance is available
    // as soon as the page loads.
    isMonograph
      ? drug
        ? (factId: string) => setFactDiscussion({ factId })
        : undefined
      : (factId: string) => setFactDiscussion({ factId });

  const renderBody = (contentHtml: string) => (
    <div className="prose prose-sm max-w-none">
      <WikiRenderer
        contentHtml={contentHtml}
        bibliographyMap={bibliographyMap}
        citations={citationsById}
        parameterValues={parameterValues}
        molecularWeight={drug?.molecularWeight ?? null}
        factCommentCounts={discussionCounts}
        onFactDiscussionClick={onFactDiscussionClick}
      />
    </div>
  );

  const childrenList =
    children.length > 0 ? (
      <section className="mt-8 border-t border-border pt-6">
        <h2 className="text-lg font-semibold mb-3">
          {t('wiki.childrenHeading')}
        </h2>
        <ul className="space-y-1">
          {children.map((c) => (
            <li key={c.id}>
              <Link
                to={`/wiki/${c.slug}`}
                className="text-sm text-primary hover:underline"
              >
                {c.title}
              </Link>
              <span className="ml-2 text-xs text-muted-foreground">
                {c.pageType === 'drug_monograph'
                  ? t('wiki.drugMonograph')
                  : t('wiki.topic')}
              </span>
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  const factDiscussionPanel =
    factDiscussion && (drug || !isMonograph) ? (
      <FactDiscussionPanel
        host={drug ? { drugId: drug.id } : { wikiPageId: page.id }}
        factId={factDiscussion.factId}
        verification={factLevels[factDiscussion.factId]}
        onClose={() => setFactDiscussion(null)}
      />
    ) : null;

  if (!isMonograph) {
    return (
      <div>
        <article className="min-w-0">
          <div className="mb-6">
            {breadcrumbs}
            <div className="flex flex-wrap items-start justify-between gap-4">
              <h1 className="min-w-0 text-3xl font-bold">{displayTitle}</h1>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 text-sm">
                {lastEdited}
                {canEdit && (
                  <Link
                    to={`/wiki/${page.slug}/edit`}
                    className="bg-muted hover:bg-muted/80 px-3 py-1.5 rounded-md"
                  >
                    {t('wiki.edit')}
                  </Link>
                )}
                <DeleteWikiPageButton
                  slug={page.slug}
                  title={page.title}
                  pageType={page.pageType}
                  entityId={page.entityId}
                />
              </div>
            </div>
            <div className="flex items-center gap-3 mt-2 text-sm text-muted-foreground">
              <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-muted text-xs">
                {t('wiki.topic')}
              </span>
            </div>
            {pendingEditNotice}
          </div>

          {renderBody(page.contentHtml)}

          <DrugReferencesList orderedRefs={orderedRefs} />

          {childrenList}

          {page.pageType === 'entity_monograph' && page.entityId && (
            <EntityMetabolismDrugs entityId={page.entityId} />
          )}
        </article>
        {factDiscussionPanel}
      </div>
    );
  }

  // A drug monograph shows one tab at a time. The drug's name lives in the
  // app header (with the tab menu under it), so the page heading names the
  // topic. The drug's identity block — names, aliases, seed prompt and the
  // whole-monograph Edit — belongs to the overview (chemistry) tab only; the
  // analytical methods that cover the drug sit with analytics & detection.
  const tabHtml = filterMonographHtmlForTab(page.contentHtml ?? '', activeTab);
  const isChemistryTab = activeTab === 'chemistry';

  return (
    <DrugUnitScope isEthanol={isEthanolDrug(matchedDrug)}>
    <div>
      <article className="min-w-0">
        <div className="mb-6">
          {breadcrumbs}
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              {/* The page names its own drug. The header's drug comes from
                  the global active drug, which still names the previous
                  monograph until this one's row resolves (or forever, if
                  that lookup fails), so it cannot be the only label. */}
              <p
                className="text-sm font-medium text-muted-foreground"
                data-testid="monograph-drug-name"
              >
                {displayTitle}
              </p>
              <h1 className="text-3xl font-bold">
                {t(monographTabLabelKey(activeTab))}
              </h1>
            </div>
            {isChemistryTab && (
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 text-sm">
                {lastEdited}
                <DrugSeedPromptButton drugName={seedPromptDrugName} />
                {canEdit && (
                  <Link
                    to={`/wiki/${page.slug}/edit`}
                    className="bg-muted hover:bg-muted/80 px-3 py-1.5 rounded-md"
                  >
                    {t('wiki.edit')}
                  </Link>
                )}
              </div>
            )}
          </div>
          {isChemistryTab && page.drugCid && (
            <DrugMetadataHeader drugCid={page.drugCid} />
          )}
          {activeTab === 'analytics_detection' && (
            <DrugAnalyticalMethods drug={drugComponent} />
          )}
          {pendingEditNotice}
        </div>

        {page.drugCid ? (
          <section
            aria-label={t('monographTabs.parametersLabel')}
            className="mb-8 rounded-lg border border-border bg-card p-4"
          >
            {/* Keyed by drug so a client-side switch between monographs never
                shows the previous drug's values while the next one loads. */}
            <DrugMonographSidebar
              key={page.drugCid}
              drugCid={page.drugCid}
              sharedReferences={orderedRefs}
              section={activeTab}
            />
          </section>
        ) : null}

        {tabHtml ? (
          renderBody(tabHtml)
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('monographTabs.noText')}
          </p>
        )}
        {canEdit && !isChemistryTab && (
          <div className="mt-4 text-sm">
            <Link
              to={`/wiki/${page.slug}/edit?tab=${activeTab}`}
              className="text-primary hover:underline"
            >
              {t('monographTabs.editTabText', {
                tab: t(monographTabLabelKey(activeTab)),
              })}
            </Link>
          </div>
        )}

        <DrugReferencesList orderedRefs={orderedRefs} />

        {childrenList}
      </article>
      {factDiscussionPanel}
    </div>
    </DrugUnitScope>
  );
}
