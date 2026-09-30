import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AuthGuard } from "@/components/AuthGuard";
import {
  WikiEditor,
  type NewDrugFormFields,
} from "@/components/wiki/WikiEditor";
import { fetchPendingEdits, updatePendingEdit } from "@/lib/pendingEditsApi";

interface PendingWikiDraft {
  id: number;
  title: string;
  content: unknown;
  editSummary?: string;
  pageType: string;
  drugCid?: number;
  // Carried over from a wiki_new draft so reopening the editor lands in
  // the form stage with the original CID/MW values intact.
  newDrug?: NewDrugFormFields;
}

function WikiNewContent() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const pageType =
    searchParams.get("type") === "drug_monograph" ? "drug_monograph" : "topic";
  const drugCid = searchParams.get("drugCid");
  // Optional pre-fill for the new-monograph search field. Set when the
  // editor is opened for a known-but-missing compound name (e.g. a
  // metabolite/precursor that has no monograph yet), so the search runs
  // immediately for that name instead of presenting an empty box.
  const searchQuery = searchParams.get("q") ?? undefined;
  const parentIdParam = searchParams.get("parentId");
  const initialParentId = parentIdParam ? Number(parentIdParam) : null;
  const pendingEditId = searchParams.get("pendingEditId");
  const [draft, setDraft] = useState<PendingWikiDraft | null>(null);
  const [loading, setLoading] = useState(Boolean(pendingEditId));

  useEffect(() => {
    if (!pendingEditId) return;

    fetchPendingEdits({ id: Number(pendingEditId) })
      .then((data) => {
        const row = data.pendingEdits[0];
        if (!row || row.editType !== "wiki_new") {
          setDraft(null);
          return;
        }

        const meta = (row.proposedMeta ?? {}) as Record<string, unknown>;
        setDraft({
          id: row.id,
          title: typeof meta.title === "string" ? meta.title : "Untitled",
          content: row.proposedValue,
          editSummary:
            typeof meta.editSummary === "string" ? meta.editSummary : undefined,
          pageType: typeof meta.pageType === "string" ? meta.pageType : "topic",
          drugCid: typeof meta.drugCid === "number" ? meta.drugCid : undefined,
          newDrug:
            meta.newDrug && typeof meta.newDrug === "object"
              ? (meta.newDrug as NewDrugFormFields)
              : undefined,
        });
      })
      .finally(() => setLoading(false));
  }, [pendingEditId]);

  if (loading) {
    return <p className="text-muted-foreground">{t("wiki.loading")}</p>;
  }

  return (
    <WikiEditor
      mode="create"
      initialTitle={draft?.title}
      initialContent={draft?.content}
      initialEditSummary={draft?.editSummary}
      pageType={draft?.pageType ?? pageType}
      drugCid={draft?.drugCid ?? (drugCid ? Number(drugCid) : undefined)}
      initialNewDrug={draft?.newDrug}
      initialSearchQuery={searchQuery}
      initialParentId={initialParentId}
      onSave={async (title, content, editSummary, options, action) => {
        if (pendingEditId) {
          await updatePendingEdit(Number(pendingEditId), {
            status: "pending",
            proposedValue: content,
            proposedMeta: {
              title,
              pageType: options?.pageType ?? pageType,
              drugCid:
                options?.drugCid ?? (drugCid ? Number(drugCid) : undefined),
              editSummary,
              newDrug: options?.newDrug,
            },
          });
          navigate(`/review?mine=1&id=${pendingEditId}`, {
            state: { toast: t("wiki.pendingPageUpdated") },
          });
          return;
        }

        const res = await fetch("/api/wiki/pages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            content,
            editSummary,
            pageType: options?.pageType ?? pageType,
            drugCid:
              options?.drugCid ?? (drugCid ? Number(drugCid) : undefined),
            // options.parentId === null on a fresh page is "no parent",
            // which is the default — only forward when a parent was set.
            parentId:
              options?.parentId != null
                ? options.parentId
                : (initialParentId ?? undefined),
            newDrug: options?.newDrug,
            submitForReview: action === "review",
          }),
        });
        if (!res.ok) {
          const data = await res.json();
          // Map known stable error codes to localised strings; fall
          // back to the API's English `error` for anything we haven't
          // explicitly handled (AGENTS.md i18n rule).
          const message =
            data.code === "wiki_admin_only_whole_page"
              ? t("wiki.adminOnlyWholePage")
              : data.code === "parameter_not_applicable"
                ? t("wiki.parameterNotApplicable")
                : (data.error ?? t("wiki.failedToCreate"));
          throw new Error(message);
        }
        const data = await res.json();
        if (data.pending && data.pendingEditId) {
          navigate(`/review?mine=1&id=${data.pendingEditId}`, {
            state: { toast: t("wiki.submittedForReview") },
          });
        } else {
          navigate(`/wiki/${data.page.slug}`, {
            state: { toast: t("wiki.pageCreated") },
          });
        }
      }}
      onCancel={() =>
        navigate(pendingEditId ? `/review?mine=1&id=${pendingEditId}` : "/wiki")
      }
    />
  );
}

export function WikiNew() {
  return (
    <AuthGuard requiredCapability="wiki.page.submit">
      <WikiNewContent />
    </AuthGuard>
  );
}
