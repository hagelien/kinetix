import { useCallback, useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ApprovalSummary } from "@/lib/approvalsApi";
import type { TextDiffChunk } from "@/lib/textDiff";
import { useCan } from "@/lib/usePermissions";

interface Revision {
  id: number;
  editSummary: string | null;
  createdBy: { username: string } | null;
  createdAt: string;
  approvals?: ApprovalSummary;
}

const HISTORY_PAGE_SIZE = 50;

type DiffState =
  | { status: "loading" }
  | { status: "loaded"; diff: TextDiffChunk[] }
  | { status: "error" };

function RevisionDiff({ state }: { state: DiffState }) {
  const { t } = useTranslation();
  if (state.status === "loading") {
    return (
      <div className="mt-3 rounded-md border border-border bg-muted/20 p-3 text-sm text-muted-foreground">
        {t("wiki.loadingDiff")}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        {t("wiki.diffUnavailable")}
      </div>
    );
  }

  const diff = state.diff;
  const hasChanges = diff.some((chunk) => chunk.type !== "same");

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/20 p-3">
      <div className="mb-2 flex items-center gap-3 text-xs text-muted-foreground">
        <span>{t("wiki.diffAdded")}</span>
        <span>{t("wiki.diffRemoved")}</span>
      </div>
      <div className="rounded-md bg-background p-3 text-sm leading-7">
        {!hasChanges ? (
          <span className="text-muted-foreground">
            {t("wiki.noTextChanges")}
          </span>
        ) : (
          diff.map((chunk, index) => {
            if (chunk.type === "added") {
              return (
                <ins
                  key={`${chunk.type}-${index}`}
                  className="bg-emerald-500/15 text-emerald-700 no-underline dark:text-emerald-300"
                >
                  {chunk.text}{" "}
                </ins>
              );
            }
            if (chunk.type === "removed") {
              return (
                <del
                  key={`${chunk.type}-${index}`}
                  className="bg-rose-500/15 text-rose-700 dark:text-rose-300"
                >
                  {chunk.text}{" "}
                </del>
              );
            }
            return <span key={`${chunk.type}-${index}`}>{chunk.text} </span>;
          })
        )}
      </div>
    </div>
  );
}

export function WikiHistory() {
  const { t } = useTranslation();
  const { slug } = useParams<{ slug: string }>();
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [pageTitle, setPageTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [expandedRevisionId, setExpandedRevisionId] = useState<number | null>(
    null,
  );
  const [diffs, setDiffs] = useState<Record<number, DiffState>>({});
  const canViewDiff = useCan("wiki.history.read");

  const load = useCallback(
    (options?: { append?: boolean; offset?: number }) => {
      if (!slug) return;
      const append = options?.append ?? false;
      const offset = options?.offset ?? 0;
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      fetch(
        `/api/wiki/history?slug=${encodeURIComponent(slug)}&limit=${HISTORY_PAGE_SIZE}&offset=${offset}`,
      )
        .then((res) => res.json())
        .then((data) => {
          const nextRevisions = data.revisions ?? [];
          setRevisions((current) =>
            append ? [...current, ...nextRevisions] : nextRevisions,
          );
          setHasMore(Boolean(data.hasMore));
          setPageTitle(data.pageTitle ?? slug);
          setLoading(false);
        })
        .catch(() => {
          setLoading(false);
        })
        .finally(() => {
          setLoadingMore(false);
        });
    },
    [slug],
  );

  const toggleRevisionDiff = useCallback(
    (revisionId: number) => {
      if (!slug || !canViewDiff) return;
      if (expandedRevisionId === revisionId) {
        setExpandedRevisionId(null);
        return;
      }

      setExpandedRevisionId(revisionId);
      if (diffs[revisionId]) return;

      setDiffs((current) => ({
        ...current,
        [revisionId]: { status: "loading" },
      }));
      fetch(
        `/api/wiki/history?slug=${encodeURIComponent(slug)}&revisionId=${revisionId}`,
      )
        .then(async (res) => {
          const data = (await res.json()) as { diff?: TextDiffChunk[] };
          if (!res.ok || !Array.isArray(data.diff)) {
            throw new Error("Failed to load revision diff");
          }
          const diff = data.diff;
          setDiffs((current) => ({
            ...current,
            [revisionId]: { status: "loaded", diff },
          }));
        })
        .catch(() => {
          setDiffs((current) => ({
            ...current,
            [revisionId]: { status: "error" },
          }));
        });
    },
    [canViewDiff, diffs, expandedRevisionId, slug],
  );

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <div className="mb-6">
        <Link
          to={`/wiki/${slug}`}
          className="text-primary hover:underline text-sm"
        >
          &larr; {t("wiki.backToPage")}
        </Link>
        <h1 className="text-2xl font-bold mt-2">
          {t("wiki.historyTitle", { title: pageTitle })}
        </h1>
      </div>

      {loading ? (
        <p className="text-muted-foreground">{t("wiki.loadingHistory")}</p>
      ) : revisions.length === 0 ? (
        <p className="text-muted-foreground">{t("wiki.noHistory")}</p>
      ) : (
        <div className="space-y-3">
          {!canViewDiff && (
            <p className="text-sm text-muted-foreground">
              {t("wiki.diffReviewerOnly")}
            </p>
          )}
          {revisions.map((rev) => (
            <div
              key={rev.id}
              className="border border-border rounded-md px-4 py-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="text-muted-foreground shrink-0">
                  #{rev.id}
                </span>
                <span className="text-muted-foreground shrink-0">
                  {new Date(rev.createdAt).toLocaleString()}
                </span>
                {rev.createdBy && (
                  <span className="text-foreground shrink-0">
                    {rev.createdBy.username}
                  </span>
                )}
                {rev.editSummary && (
                  <span className="flex-1 text-muted-foreground truncate italic">
                    {rev.editSummary}
                  </span>
                )}
                {canViewDiff && (
                  <button
                    type="button"
                    onClick={() => toggleRevisionDiff(rev.id)}
                    className="text-primary hover:underline text-sm"
                  >
                    {expandedRevisionId === rev.id
                      ? t("wiki.hideDiff")
                      : t("wiki.showDiff")}
                  </button>
                )}
              </div>
              {expandedRevisionId === rev.id && (
                <RevisionDiff state={diffs[rev.id] ?? { status: "loading" }} />
              )}
            </div>
          ))}
          {hasMore && (
            <button
              type="button"
              onClick={() => load({ append: true, offset: revisions.length })}
              disabled={loadingMore}
              className="text-sm border border-input bg-background px-4 py-1.5 rounded-md hover:bg-muted disabled:opacity-50"
            >
              {loadingMore ? t("wiki.loadingHistory") : t("wiki.loadMore")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
