import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type LazyExoticComponent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { sanitizeWikiHtml } from "@/lib/sanitizeWikiHtml";
import { useCloseTimer } from "@/lib/useHoverGrace";
import { compactRenderedRefs } from "@/lib/inlineRefs";
import {
  isMonographContentV2,
  normalizeMonographContentV2,
} from "@/lib/monographContent";
import {
  getConversionTooltipRows,
  getPreferredUnitDisplay,
} from "@/lib/unitTooltip";
import type { DrugParameterId } from "@/lib/drugParameters";
import {
  citationTooltipLabel,
  citationTooltipTitle,
} from "@/lib/citationFormat";
import {
  getMonographField,
  getMonographSection,
  isMonographSectionId,
  type MonographSectionId,
} from "@/lib/monographSections";
import {
  discussionTargetForFact,
  isFactDiscussionTargetKey,
} from "@/lib/discussionTargets";
import { activeLangCode } from "@/lib/useDrugName";
import { renderTexToHtml } from "@/lib/katexRender";
import { referenceModulePath, type CitationRow } from "@/lib/referencesApi";
import { useDisplayUnits } from "@/components/ui/DrugUnitScope";
import {
  expandBuiltinBlockMarkers,
  isBuiltinWikiBlockName,
  type BuiltinWikiBlockName,
} from "./builtin/builtinBlocks";
import "@/styles/wiki-prose.css";

/**
 * Legacy per-parameter value snapshot. Issue #396 removed the inline
 * parameter cards from the main monograph view — numeric values now live
 * exclusively in the right-side drug parameter box — so this map is no
 * longer consulted at render time. The type is kept so existing callers
 * (e.g. WikiPage) keep compiling without churn.
 */
export type MonographParameterValueMap = Partial<
  Record<DrugParameterId, unknown>
>;

interface WikiRendererProps {
  contentHtml: string | null;
  /**
   * Map of citation id → display number from the unified bibliography. Always
   * supply this when the parent renders a references list — it keeps the
   * inline `[N]` markers in sync with that list. When omitted, markers fall
   * back to order-of-appearance numbering and still anchor at `#param-ref-N`,
   * so the parent's references list renders coherently in either case.
   */
  bibliographyMap?: Map<number, number>;
  /**
   * Map of citation id to full citation row. Retained for source compatibility
   * with parents that already hydrate citations; inline markers now use compact
   * numeric bibliography labels for every row.
   */
  citations?: Map<number, CitationRow>;
  /**
   * Retained for source compatibility after #396; the renderer no longer
   * hydrates inline parameter placeholders, so this prop is ignored and
   * any stale `<aside data-monograph-parameter>` markers in legacy
   * stored HTML are dropped silently.
   */
  parameterValues?: MonographParameterValueMap;
  /** Drug molecular weight, used for inline concentration unit tooltips. */
  molecularWeight?: number | null;
  /** Comment counts keyed by discussion target, including `fact:<factId>`. */
  factCommentCounts?: Record<string, number>;
  onFactDiscussionClick?: (factId: string) => void;
}

const PARAMETER_ASIDE_RE =
  /<aside\b[^>]*\bclass="monograph-parameter"[^>]*><\/aside>/g;
// Stripped per #396: sections removed from `MONOGRAPH_SECTIONS` may still
// live inside cached `contentHtml` rows that were regenerated before this
// change shipped. Drop those top-level `<section>` blocks at render time
// so existing pages reflect the removal immediately, without waiting for
// each row to be re-saved (which would otherwise be the only path that
// regenerates `contentHtml` through the schema-driven server renderer).
// Sections never nest in the renderer output, so a non-greedy match
// between the opening and closing tags is safe.
const REMOVED_SECTION_RE =
  /<section\b[^>]*\bdata-monograph-section="(?:summary|key_facts|chemistry)"[^>]*>[\s\S]*?<\/section>/g;
const SECTION_HEADING_RE =
  /(<h2\b[^>]*\bdata-monograph-section-title=")([a-z_]+)("[^>]*>)([^<]*)(<\/h2>)/g;
const FIELD_HEADING_RE =
  /(<h3\b[^>]*\bdata-monograph-field=")([a-z0-9_]+)("[^>]*\bdata-monograph-field-section=")([a-z_]+)("[^>]*>)([^<]*)(<\/h3>)/g;
const FACT_OPEN_RE =
  /(<(?:div|p)\b(?=[^>]*\bclass="[^"]*\bmonograph-fact\b[^"]*")(?=[^>]*\bdata-fact-id="([^"]+)")[^>]*>)/g;
const CONCENTRATION_NUMBER_PATTERN = String.raw`\d+(?:(?:[,.]\d{3})+)?(?:[,.]\d+)?`;
const CONCENTRATION_RANGE_SEPARATOR_PATTERN = String.raw`(?:[–-]|\btil\b|\bto\b)`;
const CONCENTRATION_UNIT_PATTERN = [
  "mmol/dL",
  "(?:µ|μ|u)mol/dL",
  "nmol/dL",
  "mmol/L",
  "(?:µ|μ|u)mol/L",
  "nmol/L",
  "ng/mL",
  "(?:µ|μ|u)g/mL",
  "mg/L",
  "(?:µ|μ|u)g/L",
  "ng/L",
  "mg/dL",
  "(?:µ|μ|u)g/dL",
  "ng/dL",
].join("|");

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CONCENTRATION_UNIT_RE = new RegExp(
  `((?:<=|>=|[<>≤≥])?\\s*${CONCENTRATION_NUMBER_PATTERN}(?:\\s*${CONCENTRATION_RANGE_SEPARATOR_PATTERN}\\s*${CONCENTRATION_NUMBER_PATTERN})?)\\s*(${CONCENTRATION_UNIT_PATTERN})(?!\\s*(?:/|·|\\*|per\\b))\\b`,
  "gi",
);
const SKIP_UNIT_TOOLTIP_ANCESTOR = [
  "a",
  "code",
  "pre",
  "sup",
  ".citation-tooltip",
  ".unit-conversion-tooltip",
].join(",");

function parseConcentrationValue(raw: string): {
  value?: number;
  low?: number;
  high?: number;
} {
  const normalized = raw.trim();
  const numberFrom = (value: string) => {
    const compact = value.trim().replace(/\s+/g, "");
    const lastComma = compact.lastIndexOf(",");
    const lastDot = compact.lastIndexOf(".");
    if (lastComma >= 0 && lastDot >= 0) {
      return Number(
        lastComma > lastDot
          ? compact.replace(/\./g, "").replace(",", ".")
          : compact.replace(/,/g, ""),
      );
    }
    const commaMatches = compact.match(/,/g) ?? [];
    const dotMatches = compact.match(/\./g) ?? [];
    if (commaMatches.length > 1) return Number(compact.replace(/,/g, ""));
    if (commaMatches.length === 1) {
      const [whole = "", fraction = ""] = compact.split(",");
      if (whole !== "0" && /^\d{1,3}$/.test(whole) && /^0{3}$/.test(fraction)) {
        return Number(`${whole}${fraction}`);
      }
      return Number(compact.replace(",", "."));
    }
    if (dotMatches.length > 1) return Number(compact.replace(/\./g, ""));
    if (dotMatches.length === 1) {
      const [whole = "", fraction = ""] = compact.split(".");
      if (whole !== "0" && /^\d{1,3}$/.test(whole) && /^0{3}$/.test(fraction)) {
        return Number(`${whole}${fraction}`);
      }
    }
    return Number(compact);
  };
  if (/^(?:>=|>|≥)/.test(normalized)) {
    const value = numberFrom(normalized.replace(/^(?:>=|>|≥)\s*/, ""));
    return Number.isFinite(value) ? { low: value } : {};
  }
  if (/^(?:<=|<|≤)/.test(normalized)) {
    const value = numberFrom(normalized.replace(/^(?:<=|<|≤)\s*/, ""));
    return Number.isFinite(value) ? { high: value } : {};
  }

  const range = normalized.split(/\s*(?:[–-]|\btil\b|\bto\b)\s*/i);
  if (range.length === 2) {
    const low = numberFrom(range[0] ?? "");
    const high = numberFrom(range[1] ?? "");
    return Number.isFinite(low) && Number.isFinite(high) ? { low, high } : {};
  }

  const value = numberFrom(normalized);
  return Number.isFinite(value) ? { value } : {};
}

function strictOperator(raw: string): "<" | ">" | null {
  const normalized = raw.trim();
  if (/^<(?![=])/.test(normalized)) return "<";
  if (/^>(?![=])/.test(normalized)) return ">";
  return null;
}

function preserveStrictOperator(formatted: string, op: "<" | ">" | null) {
  if (op === "<") return formatted.replace(/^≤\s*/, "< ");
  if (op === ">") return formatted.replace(/^≥\s*/, "> ");
  return formatted;
}

/**
 * Render a single matched concentration (value + unit) as prose, optionally
 * converted into the reader's preferred unit (#306) with the other units — the
 * authored one included — relegated to a hover tooltip. Returns the full inline
 * segment (`"2 172 <tooltip µmol/L>"`), or plain `"value unit"` text when there
 * is nothing worth converting.
 */
function concentrationSegmentHtml(
  valueRaw: string,
  unit: string,
  molecularWeight: number | null | undefined,
  enabledUnits: readonly string[] | null | undefined,
  tooltipId: string,
): string {
  // The value pattern can absorb the whitespace that precedes it (the space in
  // "was 1.5 mg/L" lands in the capture group). Peel it off so replacing the
  // figure with a converted one keeps the surrounding prose spacing intact.
  const leading = /^\s*/.exec(valueRaw)?.[0] ?? "";
  const value = valueRaw.slice(leading.length);

  const op = strictOperator(value);
  const parsed = parseConcentrationValue(value);

  // Prefer re-expressing the value in the reader's primary unit; fall back to
  // the authored figure verbatim when it can't (or shouldn't) be converted.
  const preferred = getPreferredUnitDisplay(
    parsed,
    unit,
    molecularWeight,
    enabledUnits,
  );
  const displayUnit = preferred ? preferred.unit : unit;
  const displayValue = preferred
    ? preserveStrictOperator(preferred.formatted, op)
    : value;

  const rows = getConversionTooltipRows(
    parsed,
    unit,
    displayUnit,
    molecularWeight,
    enabledUnits,
  );
  if (rows.length === 0) {
    // No alternatives worth showing — plain text, no tooltip.
    return `${leading}${escapeHtml(displayValue)} ${escapeHtml(displayUnit)}`;
  }

  const renderGroup = (kind: "molar" | "mass") => {
    const group = rows.filter((a) => a.kind === kind);
    if (group.length === 0) return "";
    const tokens = group
      .map(
        (a) =>
          `<span class="unit-conversion-token">${escapeHtml(
            preserveStrictOperator(a.formatted, op),
          )} ${escapeHtml(a.unit)}</span>`,
      )
      .join('<span class="unit-conversion-eq"> = </span>');
    return `<span class="unit-conversion-line">${tokens}</span>`;
  };
  const molar = renderGroup("molar");
  const mass = renderGroup("mass");
  const spacer =
    molar && mass
      ? '<span class="unit-conversion-gap" aria-hidden="true"></span>'
      : "";

  return (
    `${leading}${escapeHtml(displayValue)} ` +
    `<span class="unit-conversion-tooltip" tabindex="0" aria-describedby="${escapeHtml(tooltipId)}">` +
    `<span class="unit-conversion-trigger">${escapeHtml(displayUnit)}</span>` +
    `<span id="${escapeHtml(tooltipId)}" class="unit-conversion-tooltip-panel" role="tooltip">${molar}${spacer}${mass}</span>` +
    "</span>"
  );
}

function annotateConcentrationUnits(
  html: string,
  molecularWeight: number | null | undefined,
  enabledUnits: readonly string[] | null | undefined,
): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const walker = parsed.createTreeWalker(parsed.body, 4);
  const textNodes: Text[] = [];
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    const text = node.nodeValue ?? "";
    CONCENTRATION_UNIT_RE.lastIndex = 0;
    if (
      parent &&
      !parent.closest(SKIP_UNIT_TOOLTIP_ANCESTOR) &&
      CONCENTRATION_UNIT_RE.test(text)
    ) {
      textNodes.push(node as Text);
    }
    node = walker.nextNode();
  }

  for (const [textNodeIndex, textNode] of textNodes.entries()) {
    const fragment = parsed.createDocumentFragment();
    const text = textNode.nodeValue ?? "";
    let lastIndex = 0;
    let tooltipIndex = 0;
    CONCENTRATION_UNIT_RE.lastIndex = 0;
    for (const match of text.matchAll(CONCENTRATION_UNIT_RE)) {
      const index = match.index ?? 0;
      if (index > lastIndex) {
        fragment.append(text.slice(lastIndex, index));
      }
      const valueRaw = match[1] ?? "";
      const unit = match[2] ?? "";
      const template = parsed.createElement("template");
      template.innerHTML = concentrationSegmentHtml(
        valueRaw,
        unit,
        molecularWeight,
        enabledUnits,
        `unit-conversion-tooltip-${textNodeIndex}-${tooltipIndex}`,
      );
      fragment.append(template.content);
      tooltipIndex++;
      lastIndex = index + match[0].length;
    }
    if (lastIndex < text.length) {
      fragment.append(text.slice(lastIndex));
    }
    textNode.replaceWith(fragment);
  }

  return parsed.body.innerHTML;
}

/**
 * Hydrate math markers into typeset KaTeX output. Runs *after*
 * `sanitizeWikiHtml`: the sanitizer allowlists the `data-tex` carrier
 * (`span.kx-math` / `div.kx-math-block`) but strips KaTeX's own spans and
 * `<math>` output, so we render here on the trusted, post-sanitize string —
 * exactly how verification badges are injected. KaTeX runs with `trust:
 * false`, so its markup is inert (no script, no navigation). Malformed TeX
 * renders as an inline error rather than throwing.
 *
 * Done after `annotateConcentrationUnits` so the concentration-unit regex
 * never matches the numeric literals inside a rendered formula.
 */
function renderMathMarkers(html: string): string {
  if (!html.includes("data-tex")) return html;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const nodes = parsed.querySelectorAll<HTMLElement>("[data-tex]");
  for (const node of Array.from(nodes)) {
    const tex = node.getAttribute("data-tex") ?? "";
    const displayMode = node.classList.contains("kx-math-block");
    node.innerHTML = renderTexToHtml(tex, displayMode);
  }
  return parsed.body.innerHTML;
}

function renderCitationTooltipHtml(
  refIds: number[],
  citations: Map<number, CitationRow> | undefined,
  displayNumByRefId: Map<number, number>,
): string {
  if (!citations || refIds.length === 0) return "";
  const entries = refIds
    .map((id) => {
      const row = citations.get(id);
      const index = displayNumByRefId.get(id);
      return row && index !== undefined ? { index, row } : null;
    })
    .filter(
      (entry): entry is { index: number; row: CitationRow } => entry !== null,
    )
    .sort((a, b) => a.index - b.index);

  if (entries.length === 0) return "";

  return `<span class="citation-tooltip">${entries
    .map(({ index, row }) => {
      return (
        '<span class="citation-tooltip-entry">' +
        `<a href="${escapeHtml(referenceModulePath(row.id))}" target="_blank" rel="noopener noreferrer">[${index}] ${escapeHtml(citationTooltipLabel(row))}</a>` +
        `<span>${escapeHtml(citationTooltipTitle(row))}</span>` +
        "</span>"
      );
    })
    .join("")}</span>`;
}

interface PortalTooltipState {
  html: string;
  targetRect: DOMRect;
}

const TOOLTIP_VIEWPORT_PADDING = 4;
const TOOLTIP_TARGET_GAP = 14;

function CitationTooltipPortal({
  state,
  onPointerEnter,
  onPointerLeave,
}: {
  state: PortalTooltipState | null;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<CSSProperties>({
    left: "-9999px",
    top: "-9999px",
  });

  useLayoutEffect(() => {
    if (!state) return;
    const element = ref.current;
    if (!element) return;
    const tooltipRect = element.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    let left =
      state.targetRect.left +
      state.targetRect.width / 2 -
      tooltipRect.width / 2;
    left = Math.max(
      TOOLTIP_VIEWPORT_PADDING,
      Math.min(
        left,
        viewportWidth - tooltipRect.width - TOOLTIP_VIEWPORT_PADDING,
      ),
    );

    let top = state.targetRect.top - tooltipRect.height - TOOLTIP_TARGET_GAP;
    if (top < TOOLTIP_VIEWPORT_PADDING) {
      top = TOOLTIP_VIEWPORT_PADDING;
    }

    setStyle({ left: `${left}px`, top: `${top}px` });
  }, [state]);

  if (!state) return null;

  return createPortal(
    <div
      ref={ref}
      className="citation-tooltip-portal"
      role="tooltip"
      style={style}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      dangerouslySetInnerHTML={{ __html: state.html }}
    />,
    document.body,
  );
}

interface TipTapNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
}

/**
 * Walks a TipTap-shaped tree and collects every `referenceId` from `footnote`
 * nodes. Accepts either a v1 free-form doc or a v2 monograph envelope; in
 * the v2 case it descends into every `sections[id].body` and
 * `sections[id].fields[fieldId].body` so the bibliography panel still picks
 * up footnotes that live inside section bodies.
 */
export function extractFootnoteIds(doc: unknown): number[] {
  const ids: number[] = [];
  function walk(node: TipTapNode) {
    if (node.type === "footnote" && node.attrs?.referenceId) {
      ids.push(node.attrs.referenceId as number);
    }
    // Atomic facts (issue #284) carry their citations on the node attrs
    // instead of as inline footnote markers; the renderer emits footnote
    // markers for them, but the JSON-side bibliography pipeline needs to
    // see those refs too so the references panel populates correctly.
    if (node.type === "fact" && Array.isArray(node.attrs?.referenceIds)) {
      for (const id of node.attrs.referenceIds as unknown[]) {
        if (typeof id === "number" && Number.isFinite(id)) ids.push(id);
      }
    }
    if (node.content) {
      for (const child of node.content) walk(child);
    }
  }
  if (!doc || typeof doc !== "object") return ids;
  if (isMonographContentV2(doc)) {
    // Normalize retired sub-category fields into parent sections before
    // collecting refs so bibliography numbering matches rendered HTML.
    const normalized = normalizeMonographContentV2(doc);
    for (const [sectionId, section] of Object.entries(normalized.sections)) {
      if (!section) continue;
      if (!isMonographSectionId(sectionId)) continue;
      if (section.body) walk(section.body as TipTapNode);
      if (section.fields) {
        for (const [fieldId, field] of Object.entries(section.fields)) {
          if (!field?.body) continue;
          if (!getMonographField(sectionId, fieldId)) continue;
          walk(field.body as TipTapNode);
        }
      }
    }
    return ids;
  }
  walk(doc as TipTapNode);
  return ids;
}

// Loaded on demand: only the pages that place a `{{kinetix:…}}` marker pay
// for a block's code.
const BUILTIN_BLOCK_COMPONENTS: Record<
  BuiltinWikiBlockName,
  LazyExoticComponent<ComponentType>
> = {
  agents: lazy(() => import("./builtin/AgentReviewGuide")),
};

interface BuiltinBlockTarget {
  element: HTMLElement;
  name: BuiltinWikiBlockName;
}

export function WikiRenderer({
  contentHtml,
  bibliographyMap,
  citations,
  molecularWeight,
  factCommentCounts,
  onFactDiscussionClick,
}: WikiRendererProps) {
  const { i18n, t } = useTranslation();
  const enabledUnits = useDisplayUnits();
  const lang = activeLangCode(i18n.language);
  const html = useMemo(() => {
    if (!contentHtml) return null;
    let processed = contentHtml;
    let footnoteIndex = 0;
    const fallbackNumByRef = new Map<string, number>();
    const displayNumByRefId = new Map<number, number>();
    processed = processed.replace(
      /<sup[^>]*class="footnote-marker"[^>]*data-reference-id="(\d+)"[^>]*>(?:<a[^>]*>\[\d+\]<\/a>)?<\/sup>/g,
      (_match, refId: string) => {
        const numericId = Number(refId);
        const mapped = bibliographyMap?.get(numericId);
        if (mapped !== undefined) {
          displayNumByRefId.set(numericId, mapped);
          return `<sup class="footnote-marker" data-reference-ids="${numericId}"><a href="#param-ref-${mapped}">[${mapped}]</a></sup>`;
        }
        let num = fallbackNumByRef.get(refId);
        if (num === undefined) {
          footnoteIndex++;
          num = footnoteIndex;
          fallbackNumByRef.set(refId, num);
        }
        displayNumByRefId.set(numericId, num);
        return `<sup class="footnote-marker" data-reference-ids="${numericId}"><a href="#param-ref-${num}">[${num}]</a></sup>`;
      },
    );
    // Issue #427 — collapse runs of three or more consecutive markers
    // into compact `[N-M]` segments so long citation tails stay legible.
    processed = compactRenderedRefs(processed);
    processed = processed.replace(
      /<sup class="footnote-marker" data-reference-ids="([^"]+)"><a href="#param-ref-(\d+)">(\[[^\]]+\])<\/a><\/sup>/g,
      (_match, refIdsRaw: string, anchor: string, label: string) => {
        const refIds = refIdsRaw
          .split(",")
          .map((raw) => Number(raw))
          .filter((id) => Number.isFinite(id));
        const tooltip = renderCitationTooltipHtml(
          refIds,
          citations,
          displayNumByRefId,
        );
        return `<sup class="footnote-marker"><span class="citation-tooltip-trigger"><a href="#param-ref-${anchor}">${label}</a>${tooltip}</span></sup>`;
      },
    );
    // Issue #396 — strip any inline `<aside data-monograph-parameter>`
    // placeholders that may live in legacy stored HTML. Numeric drug
    // parameters now live exclusively in the right-side parameter box;
    // the main monograph content view must never carry them inline.
    processed = processed.replace(PARAMETER_ASIDE_RE, "");
    // Also strip the three sections removed by #396 if they survive in
    // a row's cached `contentHtml`. Without this, existing pages would
    // continue to render the removed blocks until each row is re-saved.
    processed = processed.replace(REMOVED_SECTION_RE, "");
    // Localize the v2 monograph headings (issue #276 phase 1d). The
    // server emits the canonical Norwegian title (which contentPlaintext
    // stores for search); here we swap the display text based on the
    // active i18n locale so an English user sees "Pharmacokinetics"
    // rather than "Farmakokinetikk". Schema lookups are best-effort —
    // an unknown id leaves the original heading untouched.
    processed = processed.replace(
      SECTION_HEADING_RE,
      (_match, prefix, sectionId, suffix, _oldText, closing) => {
        if (!isMonographSectionId(sectionId)) return _match;
        const meta = getMonographSection(sectionId);
        const title = lang === "en" ? meta.titleEn : meta.titleNb;
        return `${prefix}${sectionId}${suffix}${escapeHtml(title)}${closing}`;
      },
    );
    processed = processed.replace(
      FIELD_HEADING_RE,
      (_match, p1, fieldId, p2, sectionId, p3, _oldText, closing) => {
        if (!isMonographSectionId(sectionId)) return _match;
        const meta = getMonographField(
          sectionId as MonographSectionId,
          fieldId,
        );
        if (!meta) return _match;
        const title = lang === "en" ? meta.titleEn : meta.titleNb;
        return `${p1}${fieldId}${p2}${sectionId}${p3}${escapeHtml(title)}${closing}`;
      },
    );
    let rendered = expandBuiltinBlockMarkers(
      renderMathMarkers(
        annotateConcentrationUnits(
          sanitizeWikiHtml(processed),
          molecularWeight,
          enabledUnits,
        ),
      ),
    );
    // Inject the per-fact discussion link *after* sanitization, into a
    // top-right cluster that reveals on hover (see `.monograph-fact-actions`
    // in wiki-prose.css). Verification status is intentionally not injected
    // here — it lives in the fact's discussion panel instead, keeping the
    // prose free of inline review symbols.
    if (onFactDiscussionClick) {
      rendered = rendered.replace(
        FACT_OPEN_RE,
        (_match, opening: string, factIdRaw: string) => {
          if (!factIdRaw.trim()) return opening;
          const targetKey = discussionTargetForFact(factIdRaw);
          if (!isFactDiscussionTargetKey(targetKey)) return opening;
          const count = factCommentCounts?.[targetKey] ?? 0;
          const label =
            count > 0
              ? t("discussion.factActionWithCount", { count })
              : t("discussion.factAction");
          const link = `<a href="#fact-discussion-${encodeURIComponent(
            factIdRaw,
          )}">${escapeHtml(label)}</a>`;
          return `${opening}<span class="monograph-fact-actions">${link}</span>`;
        },
      );
    }
    return rendered;
  }, [
    contentHtml,
    bibliographyMap,
    citations,
    enabledUnits,
    factCommentCounts,
    lang,
    molecularWeight,
    onFactDiscussionClick,
    t,
  ]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [tooltipState, setTooltipState] = useState<PortalTooltipState | null>(
    null,
  );
  // Hide is deferred (via the shared grace timer) so the pointer can travel
  // across the gap between the reference marker and the portal-rendered tooltip
  // without it vanishing. Entering either the marker or the tooltip cancels the
  // pending hide; the tooltip stays open long enough to click the links inside.
  const { scheduleClose: scheduleHide, cancelClose: cancelHide } = useCloseTimer(
    () => setTooltipState(null),
  );

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const showTooltip = (target: Element | null) => {
      const trigger = target?.closest<HTMLElement>(".citation-tooltip-trigger");
      if (!trigger || !root.contains(trigger)) return;
      const tooltip = trigger.querySelector<HTMLElement>(".citation-tooltip");
      if (!tooltip?.innerHTML.trim()) return;
      cancelHide();
      setTooltipState({
        html: tooltip.innerHTML,
        targetRect: trigger.getBoundingClientRect(),
      });
    };

    const onPointerOver = (event: PointerEvent) =>
      showTooltip(event.target as Element | null);
    const onPointerOut = (event: PointerEvent) => {
      const trigger = (event.target as Element | null)?.closest<HTMLElement>(
        ".citation-tooltip-trigger",
      );
      if (!trigger) return;
      const related = event.relatedTarget as Node | null;
      if (related && trigger.contains(related)) return;
      scheduleHide();
    };
    const onFocusIn = (event: FocusEvent) =>
      showTooltip(event.target as Element | null);
    const onFocusOut = () => scheduleHide();
    const onScroll = () => {
      cancelHide();
      setTooltipState(null);
    };

    root.addEventListener("pointerover", onPointerOver);
    root.addEventListener("pointerout", onPointerOut);
    root.addEventListener("focusin", onFocusIn);
    root.addEventListener("focusout", onFocusOut);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      root.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerout", onPointerOut);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", onFocusOut);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [html, cancelHide, scheduleHide]);

  // Mount points for built-in blocks are plain nodes inside the
  // dangerouslySetInnerHTML tree; collect them after each HTML swap and
  // portal the block components into them.
  const [blockTargets, setBlockTargets] = useState<BuiltinBlockTarget[]>([]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const found: BuiltinBlockTarget[] = [];
    for (const element of Array.from(
      root?.querySelectorAll<HTMLElement>("[data-kx-block]") ?? [],
    )) {
      const name = element.dataset.kxBlock;
      if (isBuiltinWikiBlockName(name)) found.push({ element, name });
    }
    setBlockTargets((prev) =>
      prev.length === 0 && found.length === 0 ? prev : found,
    );
  }, [html]);

  if (!html) {
    return (
      <p className="text-muted-foreground italic">
        {t('wiki.emptyPageContent')}
      </p>
    );
  }

  return (
    <>
      <div
        ref={rootRef}
        className="wiki-prose prose max-w-none dark:prose-invert"
        onClick={(event) => {
          if (!onFactDiscussionClick) return;
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          const anchor = target.closest<HTMLAnchorElement>(
            'a[href^="#fact-discussion-"]',
          );
          if (!anchor) return;
          const href = anchor.getAttribute("href") ?? "";
          const encoded = href.slice("#fact-discussion-".length);
          if (!encoded) return;
          event.preventDefault();
          let factId: string;
          try {
            factId = decodeURIComponent(encoded);
          } catch {
            return;
          }
          onFactDiscussionClick(factId);
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <CitationTooltipPortal
        state={tooltipState}
        onPointerEnter={cancelHide}
        onPointerLeave={scheduleHide}
      />
      {blockTargets.map(({ element, name }, index) => {
        const Block = BUILTIN_BLOCK_COMPONENTS[name];
        return createPortal(
          <Suspense fallback={null}>
            <Block />
          </Suspense>,
          element,
          `${name}-${index}`,
        );
      })}
    </>
  );
}
