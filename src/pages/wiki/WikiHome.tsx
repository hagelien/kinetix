import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CornerDownRight, Dna, FileText, FolderOpen, Plus } from "lucide-react";
import { useCan } from "@/lib/usePermissions";

interface WikiPageSummary {
  id: number;
  slug: string;
  title: string;
  pageType: string;
  parentId: number | null;
  updatedAt?: string;
}

export interface WikiTreeNode extends WikiPageSummary {
  children: WikiTreeNode[];
}

interface WikiPageSummaryResponse {
  pages?: WikiPageSummary[];
  hasMore?: boolean;
}

const WIKI_SUMMARY_PAGE_SIZE = 200;

export function wikiSummaryPageUrl(offset: number): string {
  const params = new URLSearchParams({
    limit: String(WIKI_SUMMARY_PAGE_SIZE),
    offset: String(offset),
    view: "summary",
    excludePageType: "drug_monograph",
  });
  return `/api/wiki/pages?${params.toString()}`;
}

// The wiki landing page lists non-monograph content only (topics, articles);
// drug monographs are reached via the drug table / search, not this index.
export function filterNonMonographPages<T extends { pageType: string }>(
  pages: T[],
): T[] {
  return pages.filter((page) => page.pageType !== "drug_monograph");
}

export function buildWikiPageTree(pages: WikiPageSummary[]): WikiTreeNode[] {
  const nodes = new Map<number, WikiTreeNode>();
  for (const page of pages) {
    nodes.set(page.id, { ...page, children: [] });
  }

  const hasParentCycle = (node: WikiTreeNode, parent: WikiTreeNode) => {
    const seen = new Set<number>();
    let cursor: WikiTreeNode | undefined = parent;

    while (cursor) {
      if (cursor.id === node.id) return true;
      if (seen.has(cursor.id)) return false;
      seen.add(cursor.id);
      cursor = cursor.parentId == null ? undefined : nodes.get(cursor.parentId);
    }

    return false;
  };

  const roots: WikiTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId == null ? null : nodes.get(node.parentId);
    if (parent && parent.id !== node.id && !hasParentCycle(node, parent)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortTree = (items: WikiTreeNode[]) => {
    items.sort((a, b) => a.title.localeCompare(b.title, "no"));
    for (const item of items) sortTree(item.children);
  };
  sortTree(roots);

  return roots;
}

export function WikiHome() {
  const { t } = useTranslation();
  const [pages, setPages] = useState<WikiPageSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // Whole-page creation follows the same capability the API requires on
  // POST /api/wiki/pages.
  const canCreate = useCan("wiki.page.submit");

  useEffect(() => {
    let cancelled = false;

    async function loadPages() {
      const collected: WikiPageSummary[] = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const res = await fetch(wikiSummaryPageUrl(offset));
        const data = (await res.json()) as WikiPageSummaryResponse;
        const batch = data.pages ?? [];
        collected.push(...batch);
        hasMore = data.hasMore === true && batch.length > 0;
        offset += batch.length;
      }

      if (!cancelled) setPages(collected);
    }

    loadPages()
      .catch(() => {
        if (!cancelled) setPages([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const listablePages = filterNonMonographPages(pages);
  const pageTree = buildWikiPageTree(listablePages);

  return (
    <div>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold mb-2">{t("wiki.title")}</h1>
          <p className="text-muted-foreground">{t("wiki.description")}</p>
        </div>
        {/* #310: whole-page wiki creation is admin-only. The action used to
            live in the top header; it now sits on the wiki landing page where
            it's contextually relevant. */}
        {canCreate && (
          <Link
            to="/wiki/new"
            className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            {t("wiki.newPage")}
          </Link>
        )}
      </div>

      {loading ? (
        <p className="text-muted-foreground">{t("wiki.loadingPages")}</p>
      ) : listablePages.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <p className="text-lg mb-2">{t("wiki.noPages")}</p>
          {canCreate && (
            <p>
              <Link to="/wiki/new" className="text-primary hover:underline">
                {t("wiki.createFirst")}
              </Link>
            </p>
          )}
        </div>
      ) : (
        <section
          aria-label={t("wiki.allPages")}
          className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {pageTree.map((node) => (
            <WikiPageCard key={node.id} node={node} />
          ))}
        </section>
      )}
    </div>
  );
}

function pageIcon(node: WikiTreeNode) {
  if (node.pageType === "entity_monograph") return Dna;
  return node.children.length > 0 ? FolderOpen : FileText;
}

// Each top-level page is a card. Subpages are always listed inside their
// parent's card, indented along a guide line, so the hierarchy is visible at a
// glance instead of hidden behind a collapsed toggle.
function WikiPageCard({ node }: { node: WikiTreeNode }) {
  const { t } = useTranslation();
  const Icon = pageIcon(node);

  return (
    <article className="rounded-lg border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/40">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <Link
            to={`/wiki/${node.slug}`}
            className="rounded-sm font-semibold text-foreground hover:text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          >
            {node.title}
          </Link>
          {node.children.length > 0 && (
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("wiki.subpageCount", { count: node.children.length })}
            </p>
          )}
        </div>
      </div>
      {node.children.length > 0 && <WikiSubpageList nodes={node.children} />}
    </article>
  );
}

function WikiSubpageList({ nodes }: { nodes: WikiTreeNode[] }) {
  return (
    <ul className="mt-3 ml-4 space-y-1 border-l-2 border-primary/20 pl-3">
      {nodes.map((child) => (
        <li key={child.id}>
          <Link
            to={`/wiki/${child.slug}`}
            className="flex items-start gap-1.5 rounded-sm py-1 text-sm text-foreground hover:text-primary hover:underline focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
          >
            <CornerDownRight
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span>{child.title}</span>
          </Link>
          {child.children.length > 0 && (
            <WikiSubpageList nodes={child.children} />
          )}
        </li>
      ))}
    </ul>
  );
}
