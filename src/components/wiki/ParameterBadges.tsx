import { useTranslation } from "react-i18next";
import { AlertTriangle, MessageSquare } from "lucide-react";

interface ParameterBadgesProps {
  commentCount?: number;
  refCount?: number;
  /** Render the missing-reference warning (skip for non-editable entries like MW). */
  showRefWarning?: boolean;
  onCommentClick?: () => void;
}

/**
 * Small row of visual indicators for a parameter box:
 *  - accent ⚠ when the parameter has no references attached
 *  - 💬 count when there are comments (clickable to open the discussion panel)
 *
 * Citations are not shown here: the value itself is the citation trigger
 * (`ReferenceHover`, or the sources preview for a source-value parameter), so
 * no superscript `[n]` markers trail it.
 *
 * Review status (verification level, unreviewed-source warnings) is
 * deliberately NOT shown here — it lives in the parameter's discussion and
 * revision history instead, to keep the browse surfaces free of visual noise.
 */
export function ParameterBadges({
  commentCount = 0,
  refCount,
  showRefWarning = true,
  onCommentClick,
}: ParameterBadgesProps) {
  const { t } = useTranslation();
  const hasRefWarning = showRefWarning && refCount === 0;

  if (!hasRefWarning && !commentCount) return null;

  return (
    <span className="inline-flex items-center gap-1 align-middle">
      {hasRefWarning && (
        <span
          className="inline-flex items-center text-accent"
          title={t("indicators.noReference")}
        >
          <AlertTriangle className="h-3 w-3" />
        </span>
      )}
      {commentCount > 0 && (
        <button
          type="button"
          onClick={onCommentClick}
          className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          title={t("indicators.comments", { count: commentCount })}
        >
          <MessageSquare className="h-3 w-3" />
          {commentCount}
        </button>
      )}
    </span>
  );
}
