import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type {
  WikiArticleBundle,
  WikiArticlePlan,
} from "@/lib/wikiArticleImport";

export function WikiArticleImportSection() {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<{
    document: WikiArticleBundle;
    plan: WikiArticlePlan;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function request(apply: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const document = apply ? preview?.document : JSON.parse(text);
      const response = await fetch("/api/conversation-ingestion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document,
          ...(apply
            ? {
                action: "apply",
                expectedFingerprint: preview?.plan.fingerprint,
              }
            : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok)
        throw new Error(
          data.errors?.join("\n") ??
            data.error ??
            t("admin.wikiArticle.failed"),
        );
      if (apply) {
        setMessage(
          t("admin.wikiArticle.result", {
            queued: data.result.queued,
            skipped: data.result.skipped,
            newSections: data.result.newSections,
          }),
        );
        setPreview(null);
      } else {
        setPreview({ document, plan: data.plan });
      }
    } catch (err) {
      setPreview(null);
      setMessage(
        err instanceof Error ? err.message : t("admin.wikiArticle.failed"),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4 rounded-lg border p-4 mb-6">
      <h2 className="text-lg font-semibold">{t("admin.wikiArticle.title")}</h2>
      <p>{t("admin.wikiArticle.description")}</p>
      <label className="block">
        <span>{t("admin.wikiArticle.input")}</span>
        <textarea
          className="w-full min-h-40 rounded border p-2 font-mono text-sm"
          value={text}
          disabled={busy}
          onChange={(e) => {
            setText(e.target.value);
            setPreview(null);
            setMessage("");
          }}
        />
      </label>
      <Button
        disabled={busy || !text.trim()}
        onClick={() => void request(false)}
      >
        {t("admin.wikiArticle.analyse")}
      </Button>
      {preview && (
        <div className="space-y-3">
          <p className="font-semibold">{preview.plan.title}</p>
          <p>
            {t("admin.wikiArticle.counts", {
              factCount: preview.plan.factCount,
              newSectionCount: preview.plan.newSectionCount,
              blockedCount: preview.plan.blockedCount,
            })}
          </p>
          {preview.plan.sections.map((section) => (
            <details key={section.key} className="rounded border p-2">
              <summary>
                {section.heading} — {section.facts.length}{" "}
                {t("admin.wikiArticle.facts")}{" "}
                {section.create ? `(${t("admin.wikiArticle.newSection")})` : ""}
              </summary>
              <p className="text-sm">
                {section.sectionId} · H{section.level}
              </p>
              <ul className="list-disc pl-6">
                {section.facts.map((fact) => (
                  <li key={fact.key} className="my-2">
                    {fact.statement}
                    <ul className="text-sm list-disc pl-6">
                      {fact.sourceKeys.map((key) => {
                        const source = preview.document.sources.find(
                          (s) => s.key === key,
                        )!;
                        const href =
                          source.type === "doi"
                            ? `https://doi.org/${source.identifier}`
                            : source.type === "pmid"
                              ? `https://pubmed.ncbi.nlm.nih.gov/${source.identifier}/`
                              : source.identifier;
                        return (
                          <li key={key}>
                            <a href={href} target="_blank" rel="noreferrer">
                              {source.metadata?.title ?? source.identifier}
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            </details>
          ))}
          {!!preview.document.blockedCandidates?.length && (
            <div role="status">
              <p className="font-semibold">{t("admin.wikiArticle.blocked")}</p>
              <ul>
                {preview.document.blockedCandidates.map((b, i) => (
                  <li key={i}>
                    {b.statement} — {b.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <Button disabled={busy} onClick={() => void request(true)}>
            {t("admin.wikiArticle.apply")}
          </Button>
        </div>
      )}
      {message && (
        <p role="status" className="whitespace-pre-wrap">
          {message}
        </p>
      )}
    </section>
  );
}
