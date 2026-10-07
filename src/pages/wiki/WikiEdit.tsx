import { useEffect, useState } from 'react';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AuthGuard } from '@/components/AuthGuard';
import { WikiEditor } from '@/components/wiki/WikiEditor';
import { TopicSectionsEditor } from '@/components/wiki/TopicSectionsEditor';
import { fetchPendingEdits, updatePendingEdit } from '@/lib/pendingEditsApi';
import { fetchDrugByWikiDrugId } from '@/lib/drugApi';
import { useCan } from '@/lib/usePermissions';
import type { TipTapDoc } from '@/lib/monographContent';
import { isMonographTabId, sectionsForTab } from '@/lib/monographTabs';

interface WikiPageData {
  id: number;
  slug: string;
  title: string;
  content: unknown;
  editSummary?: string;
  pageType: string;
  drugCid: number | null;
  parentId: number | null;
  /**
   * ISO 8601 timestamp of the page's last modification, sent back with the
   * save as `expectedUpdatedAt` so the server can predicate its UPDATE on
   * the load-time version. Without this, the server's fresh SELECT
   * snapshot compares the post-merge timestamp against itself and cannot
   * detect that a merge already committed BEFORE the request arrived —
   * accepting a pre-merge payload that restores the loser URL.
   */
  updatedAt?: string;
}

interface WikiPageAncestor {
  id: number;
  slug: string;
  title: string;
}

function WikiEditContent() {
  const { t } = useTranslation();
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const pendingEditId = searchParams.get('pendingEditId');
  // Escape hatch back to the whole-page editor for the title / parent /
  // prose edits the atomic-fact surface can't express. Gated on the
  // capability PUT /api/wiki/pages checks, not on the admin role — a
  // delegated page submitter would otherwise land on fact controls backed by
  // an endpoint they don't hold, with no way to edit prose at all.
  const legacy = searchParams.get('legacy') === '1';
  // Editing from a monograph tab opens only that tab's prose sections.
  const tabParam = searchParams.get('tab');
  const monographSectionIds = isMonographTabId(tabParam)
    ? sectionsForTab(tabParam)
    : undefined;
  const canSubmitWholePage = useCan('wiki.page.submit');
  const [page, setPage] = useState<WikiPageData | null>(null);
  // Internal drugs.id resolved from page.drugCid. wiki_pages.drug_cid is a
  // legacy column that historically stored a PubChem CID and now stores the
  // internal id for newer rows; we normalize here so WikiEditor and any
  // downstream API calls (especially citation inserts whose drug_id FKs
  // drugs.id) always see a canonical id.
  const [resolvedDrugId, setResolvedDrugId] = useState<number | null>(null);
  const [parentTitle, setParentTitle] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!slug) return;

    async function load() {
      try {
        const response = await fetch(
          `/api/wiki/pages?slug=${encodeURIComponent(slug ?? '')}`,
        );
        const data = await response.json();
        const livePage = data.page as WikiPageData | undefined;
        const ancestors = (data.ancestors ?? []) as WikiPageAncestor[];
        if (!livePage) {
          setPage(null);
          setLoading(false);
          return;
        }
        // The closest ancestor is the immediate parent — use its title for
        // the editor's parent-picker chip without making a second request.
        const immediateParent =
          livePage.parentId != null
            ? (ancestors.find((a) => a.id === livePage.parentId) ?? null)
            : null;
        setParentTitle(immediateParent?.title ?? null);

        if (livePage.drugCid != null) {
          let canonical: number | null = null;
          try {
            const { drug } = await fetchDrugByWikiDrugId(livePage.drugCid);
            canonical = drug.id;
          } catch {
            canonical = null;
          }
          setResolvedDrugId(canonical);
        } else {
          setResolvedDrugId(null);
        }

        if (!pendingEditId) {
          setPage(livePage);
          setLoading(false);
          return;
        }

        const pending = await fetchPendingEdits({ id: Number(pendingEditId) });
        const row = pending.pendingEdits[0];
        if (row?.editType === 'wiki_page') {
          const meta = (row.proposedMeta ?? {}) as Record<string, unknown>;
          setPage({
            ...livePage,
            title: (meta.title as string | undefined) ?? livePage.title,
            content: row.proposedValue,
            editSummary:
              typeof meta.editSummary === 'string'
                ? meta.editSummary
                : undefined,
          });
        } else {
          setPage(livePage);
        }
      } catch {
        setPage(null);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [slug, pendingEditId]);

  if (loading) {
    return <p className="text-muted-foreground">{t('wiki.loading')}</p>;
  }

  if (!page) {
    return (
      <div className="py-12 text-center">
        <p className="text-muted-foreground">{t('wiki.pageNotFoundShort')}</p>
        <Link to="/wiki" className="text-primary hover:underline">
          {t('wiki.backToWiki')}
        </Link>
      </div>
    );
  }

  // Topic-page edits land in the atomic-fact surface for *everyone* with
  // contribution rights, admins included (#310 phase 3 / #349). This is
  // the default editing experience now: prose-only pages would otherwise
  // show no atomic-fact UI at all. Admins keep a whole-page escape hatch
  // (`?legacy=1`) for the title / parent / prose edits the section editor
  // can't express; the API still gates that path to admins.
  if (page.pageType === 'topic' && !(legacy && canSubmitWholePage)) {
    return (
      <div className="space-y-4">
        <header className="flex items-baseline justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">{page.title}</h1>
            <p className="text-xs text-muted-foreground">
              {t('topicSections.editorHint', {
                defaultValue:
                  'Add or edit atomic facts within each section. Whole-page edits remain admin-only.',
              })}
            </p>
          </div>
          <div className="flex items-center gap-3 text-sm">
            {canSubmitWholePage ? (
              <Link
                to={`/wiki/${page.slug}/edit?legacy=1`}
                className="text-muted-foreground hover:text-foreground hover:underline"
              >
                {t('wiki.editWholePageLegacy', {
                  defaultValue: 'Edit whole page',
                })}
              </Link>
            ) : null}
            <Link
              to={`/wiki/${page.slug}`}
              className="text-muted-foreground hover:text-foreground"
            >
              {t('common.cancel')}
            </Link>
          </div>
        </header>
        <TopicSectionsEditor
          content={page.content as TipTapDoc | null | undefined}
          pageId={page.id}
        />
      </div>
    );
  }

  return (
    <WikiEditor
      mode="edit"
      initialTitle={page.title}
      initialContent={page.content}
      initialEditSummary={page.editSummary}
      pageType={page.pageType}
      slug={page.slug}
      pageId={page.id}
      drugCid={resolvedDrugId ?? undefined}
      initialParentId={page.parentId ?? null}
      initialParentTitle={parentTitle}
      monographSectionIds={
        monographSectionIds && monographSectionIds.length > 0
          ? monographSectionIds
          : undefined
      }
      onSave={async (title, content, editSummary, options, action) => {
        if (pendingEditId) {
          await updatePendingEdit(Number(pendingEditId), {
            status: 'pending',
            proposedValue: content,
            proposedMeta: {
              title,
              slug: page.slug,
              editSummary,
            },
          });
          navigate(`/wiki/${page.slug}`, {
            state: { toast: t('wiki.pendingEditUpdated') },
          });
          return;
        }

        const res = await fetch(
          `/api/wiki/pages?slug=${encodeURIComponent(page.slug)}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              title,
              content,
              editSummary,
              submitForReview: action === 'review',
              // Only send when changed (editor returns undefined for no-op)
              ...(options?.parentId !== undefined
                ? { parentId: options.parentId }
                : {}),
              // Load-time optimistic-concurrency snapshot so the server can
              // reject a save whose payload was authored against a
              // pre-merge (or pre-other-edit) revision of this page —
              // otherwise a fresh server-side SELECT would return the
              // post-merge value and compare it with itself.
              ...(page.updatedAt ? { expectedUpdatedAt: page.updatedAt } : {}),
            }),
          },
        );
        if (!res.ok) {
          const data = await res.json();
          const message =
            data.code === 'wiki_admin_only_whole_page'
              ? t('wiki.adminOnlyWholePage')
              : (data.error ?? t('wiki.failedToSave'));
          throw new Error(message);
        }
        const data = await res.json();
        if (data.pending) {
          navigate(`/wiki/${page.slug}`, {
            state: { toast: t('wiki.submittedForReview') },
          });
        } else {
          navigate(`/wiki/${page.slug}`, {
            state: { toast: t('wiki.pageUpdated') },
          });
        }
      }}
      onCancel={() => navigate(`/wiki/${page.slug}`)}
    />
  );
}

export function WikiEdit() {
  // The route hosts two workflows with two capabilities: the atomic-fact
  // panels (edit.wikiFact.submit) and the whole-page editor
  // (wiki.page.submit). Either one is enough to have something to do here;
  // WikiEditor then shows only the save buttons the caller actually holds.
  // Without at least one, every submission the editor surfaces would 403.
  return (
    <AuthGuard
      requiredAnyCapability={['edit.wikiFact.submit', 'wiki.page.submit']}
    >
      <WikiEditContent />
    </AuthGuard>
  );
}
