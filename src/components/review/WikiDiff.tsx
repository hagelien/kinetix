import { useTranslation } from "react-i18next";
import { buildWordDiff, textFromContent, textFromHtml } from "@/lib/textDiff";

interface WikiDiffProps {
  currentContent?: unknown;
  currentContentHtml?: string | null;
  proposedValue: unknown;
}

export function WikiDiff({
  currentContent,
  currentContentHtml,
  proposedValue,
}: WikiDiffProps) {
  const { t } = useTranslation();
  const currentText =
    textFromContent(currentContent) || textFromHtml(currentContentHtml);
  const proposedText = textFromContent(proposedValue);
  const diff = buildWordDiff(currentText, proposedText);

  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <div className="mb-2 flex items-center gap-3 text-xs text-muted-foreground">
        <span>{t("review.wikiDiff.greenAdded")}</span>
        <span>{t("review.wikiDiff.redRemoved")}</span>
      </div>

      <div className="rounded-md bg-background p-3 text-sm leading-7">
        {diff.length === 0 ? (
          <span className="text-muted-foreground">
            {t("review.wikiDiff.noChanges")}
          </span>
        ) : (
          diff.map((chunk, index) => (
            <span
              key={`${chunk.type}-${index}`}
              className={
                chunk.type === "added"
                  ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : chunk.type === "removed"
                    ? "bg-rose-500/15 text-rose-700 line-through dark:text-rose-300"
                    : undefined
              }
            >
              {chunk.text}{" "}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
