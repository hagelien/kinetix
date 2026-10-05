import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { DrugAnalyticalMethods } from '@/components/wiki/DrugAnalyticalMethods';
import { DrugPmConcentrations } from '@/components/wiki/DrugPmConcentrations';
import { DrugMonographSidebar } from '@/components/wiki/DrugMonographSidebar';
import { useAuthStore } from '@/stores/authStore';
import { useCan } from '@/lib/usePermissions';
import { useDrugStore } from '@/stores/drugStore';
import { drugRowToComponent, fetchDrugById, type DrugRow } from '@/lib/drugApi';
import { fetchDrugWikiPage } from '@/lib/wikiApi';
import { formatGenericDrugName, resolveDrugName } from '@/lib/drugNames';
import { activeLangCode } from '@/lib/useDrugName';

export function DrugPreview() {
  const { t, i18n } = useTranslation();
  const lang = activeLangCode(i18n.language);
  const { drugId } = useParams<{ drugId: string }>();
  const navigate = useNavigate();
  const { search } = useLocation();
  const { isAuthenticated } = useAuthStore();
  // Without this gate, users saw the Create button but POST
  // /api/wiki/pages would 403 silently (handleCreate only handles
  // 200/409), so it follows exactly the capability that endpoint requires.
  const canEdit = useCan('wiki.page.submit');

  const [drug, setDrug] = useState<DrugRow | null>(null);
  const [creating, setCreating] = useState(false);
  // True until we have confirmed there is no existing monograph for this
  // drug. If one exists we redirect to its slug URL, so we hold off
  // rendering the "no monograph yet" preview to avoid a flash of the
  // wrong content before the redirect lands.
  const [resolving, setResolving] = useState(true);

  const cid = Number(drugId);
  const drugName = useMemo(
    () =>
      drug ? formatGenericDrugName(resolveDrugName(drug.names, lang)) : null,
    [drug, lang],
  );
  const drugComponent = useMemo(
    () => (drug ? drugRowToComponent(drug) : null),
    [drug],
  );

  // Promote the previewed drug to the global "active drug" so surfaces that
  // track the monograph in focus — the drug table highlight and the floating
  // unit converter — stay in sync. WikiPage does the same for slug-backed
  // monographs; drugs that only have a /wiki/drug/:cid preview (no monograph
  // written yet) must update it here too, otherwise the converter keeps the
  // previously viewed drug's parameters.
  const setActiveDrug = useDrugStore((s) => s.setActiveDrug);
  useEffect(() => {
    if (drugComponent) setActiveDrug(drugComponent);
  }, [drugComponent, setActiveDrug]);

  useEffect(() => {
    if (!cid) return;
    let cancelled = false;
    setResolving(true);
    // Canonicalise the URL: if a monograph already exists for this drug,
    // redirect from the numeric /wiki/drug/:id route to its human-readable
    // /wiki/:slug page so the same drug is not reachable under two
    // divergent URLs. Only when no monograph exists do we load the drug and
    // render the preview / create flow.
    fetchDrugWikiPage(cid)
      .then(({ page }) => {
        if (cancelled) return;
        if (page?.slug) {
          // Keep the query: a notification links here with `param`/`view`
          // for the sidebar to open a parameter's log or discussion.
          navigate(`/wiki/${page.slug}${search}`, { replace: true });
          return;
        }
        return fetchDrugById(cid).then(({ drug }) => {
          if (cancelled) return;
          setDrug(drug);
          setResolving(false);
        });
      })
      .catch(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
    // `search` is read once for the redirect; changing it must not re-run it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, navigate]);

  async function handleCreate() {
    if (!cid) return;
    setCreating(true);
    try {
      const res = await fetch('/api/wiki/pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: drugName ?? `Drug ${cid}`,
          content: { type: 'doc', content: [] },
          pageType: 'drug_monograph',
          drugCid: cid,
          status: 'published',
        }),
      });
      if (res.status === 409) {
        const existing = await fetch(`/api/wiki/pages?drugCid=${cid}`).then(
          (r) => (r.ok ? r.json() : null),
        );
        if (existing?.page?.slug) {
          navigate(`/wiki/${existing.page.slug}`, { replace: true });
          return;
        }
      }
      if (res.ok) {
        const data = await res.json();
        if (data.pending && data.pendingEditId) {
          navigate(`/review?mine=1&id=${data.pendingEditId}`, {
            replace: true,
            state: { toast: t('drugPreview.submittedToast') },
          });
        } else if (data.page?.slug) {
          navigate(`/wiki/${data.page.slug}`, { replace: true });
        }
      }
    } finally {
      setCreating(false);
    }
  }

  if (!cid) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">{t('drugPreview.invalidId')}</p>
        <Link to="/" className="text-primary hover:underline">
          {t('drugPreview.backToTable')}
        </Link>
      </div>
    );
  }

  // While we are still resolving whether a monograph exists (and possibly
  // redirecting to its slug), show a neutral loading state rather than the
  // "no monograph yet" preview.
  if (resolving) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        {t('wiki.loading')}
      </div>
    );
  }

  return (
    <div className="flex flex-col lg:flex-row gap-8">
      <article className="flex-1 min-w-0 order-2 lg:order-1">
        <div className="mb-6">
          <h1 className="text-3xl font-bold">
            {drugName ?? t('wiki.loading')}
          </h1>
          <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-muted text-xs mt-2">
            {t('wiki.drugMonograph')}
          </span>
          <DrugAnalyticalMethods drug={drugComponent} />
          <DrugPmConcentrations
            drugDbId={drugComponent?._dbId ?? null}
            molecularWeight={drugComponent?.molecularWeight ?? null}
          />
        </div>

        <div className="border border-dashed border-border rounded-lg p-8 text-center">
          <p className="text-muted-foreground mb-4">
            {t('drugPreview.noMonographYet')}
          </p>
          {canEdit ? (
            <button
              onClick={handleCreate}
              disabled={creating}
              className="text-sm bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90 disabled:opacity-50"
            >
              {creating
                ? t('drugPreview.creating')
                : t('drugPreview.createMonograph')}
            </button>
          ) : !isAuthenticated ? (
            <Link
              to="/login"
              state={{ message: t('drugPreview.signInMessage') }}
              className="text-sm text-primary hover:underline"
            >
              {t('drugPreview.signInToContribute')}
            </Link>
          ) : null}
        </div>
      </article>

      <aside className="w-full lg:w-80 lg:shrink-0 order-1 lg:order-2">
        <DrugMonographSidebar drugCid={cid} />
      </aside>
    </div>
  );
}
