/**
 * Tests for the parameter-anchor hydration path in WikiRenderer (#276
 * phase 1d). The component itself uses dangerouslySetInnerHTML, so these
 * focus on the pure HTML transform: given server-emitted `<aside>`
 * placeholders + a parameter-values map, the rendered HTML should
 * contain the formatted live values (and a clean em dash when the
 * value is missing).
 *
 * The transform is exercised by mounting the component and reading the
 * sanitized output back from the DOM.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
// Importing the app's i18n setup (rather than the bare i18next instance)
// initializes the resource bundles so changeLanguage actually has
// translations to switch to.
import "@/i18n";
import i18n from "i18next";
import { WikiRenderer, type MonographParameterValueMap } from "./WikiRenderer";
import type { CitationRow } from "@/lib/referencesApi";
import { useAppStore } from "@/stores/appStore";

// Non-breaking space used as the thousands separator in formatted numbers.
const NBSP = " ";

function placeholder(
  parameterId: string,
  sectionId: string,
  fieldId: string,
): string {
  return (
    `<aside class="monograph-parameter"` +
    ` data-monograph-parameter="${parameterId}"` +
    ` data-monograph-section="${sectionId}"` +
    ` data-monograph-field="${fieldId}"></aside>`
  );
}

function rendered(
  html: string,
  parameterValues?: MonographParameterValueMap,
): string {
  const { container } = render(
    <WikiRenderer contentHtml={html} parameterValues={parameterValues} />,
  );
  return container.innerHTML;
}

describe("WikiRenderer drops inline parameter placeholders (#396)", () => {
  // Numeric drug parameters now live exclusively in the right-side
  // drug parameter box. The renderer strips any `<aside
  // data-monograph-parameter>` markers that may survive in legacy
  // stored HTML — regardless of whether the parent supplies a value
  // map or what section the marker claims to belong to — so the main
  // content view never carries tabular values inline again.
  it("strips inline parameter placeholders even when a value map is supplied", () => {
    const html = rendered(placeholder("halfLife", "pk", "half_life"), {
      halfLife: { min: 2, max: 4, unit: "h" },
    });
    expect(html).not.toContain("<aside");
    expect(html).not.toContain("<dl");
    expect(html).not.toContain("Halveringstid");
  });

  it("strips inline parameter placeholders when no value map is supplied", () => {
    const html = rendered(placeholder("halfLife", "pk", "half_life"));
    expect(html).not.toContain("<aside");
    expect(html).not.toContain("<dl");
  });

  it("strips placeholders pointing at removed sections (chemistry / summary / key_facts)", () => {
    const html = rendered(placeholder("aliases", "chemistry", "synonyms"), {
      aliases: ["Xanax", "Helex"],
    });
    expect(html).not.toContain("<dl");
    expect(html).not.toContain("<aside");
  });

  it("strips removed-section blocks that survive in cached contentHtml", () => {
    // Existing rows rendered before #396 still carry full `<section>`
    // blocks for the removed sections in their cached `contentHtml`. The
    // client renderer must drop them so the published page reflects the
    // removal immediately, without waiting for every monograph to be
    // re-saved through the schema-driven server renderer.
    const cached =
      '<section data-monograph-section="summary">' +
      '<h2 data-monograph-section-title="summary">Kort sammendrag</h2>' +
      "<p>legacy summary prose</p>" +
      "</section>" +
      '<section data-monograph-section="key_facts">' +
      '<h2 data-monograph-section-title="key_facts">Hurtigoversikt</h2>' +
      "<p>legacy key facts prose</p>" +
      "</section>" +
      '<section data-monograph-section="chemistry">' +
      '<h2 data-monograph-section-title="chemistry">Stoffidentitet og kjemi</h2>' +
      "<p>legacy chemistry prose</p>" +
      "</section>" +
      '<section data-monograph-section="pd">' +
      '<h2 data-monograph-section-title="pd">Farmakodynamikk</h2>' +
      "<p>kept pd prose</p>" +
      "</section>";
    const html = rendered(cached);
    expect(html).not.toContain("legacy summary prose");
    expect(html).not.toContain("legacy key facts prose");
    expect(html).not.toContain("legacy chemistry prose");
    expect(html).not.toContain("Kort sammendrag");
    expect(html).not.toContain("Hurtigoversikt");
    expect(html).not.toContain("Stoffidentitet og kjemi");
    // Kept sections must still render — the sanitizer scrubs `<section>`
    // wrappers and unknown data-attributes, so the surviving signal is
    // the heading text plus the prose inside.
    expect(html).toContain("Farmakodynamikk");
    expect(html).toContain("kept pd prose");
  });
});

describe("WikiRenderer heading localization", () => {
  it("swaps section h2 titles to English when active locale is en", async () => {
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    try {
      const html = rendered(
        '<h2 data-monograph-section-title="pk">Farmakokinetikk</h2>',
      );
      expect(html).toContain("Pharmacokinetics");
      expect(html).not.toContain("Farmakokinetikk");
    } finally {
      await act(async () => {
        await i18n.changeLanguage("nb");
      });
    }
  });

  it("keeps section h2 titles in Norwegian by default", () => {
    const html = rendered(
      '<h2 data-monograph-section-title="pk">Farmakokinetikk</h2>',
    );
    expect(html).toContain("Farmakokinetikk");
  });

  it("leaves retired field h3 titles untouched when present in cached HTML", async () => {
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    try {
      const html = rendered(
        '<h3 data-monograph-field="cardiovascular" data-monograph-field-section="effects">Kardiovaskulære</h3>',
      );
      expect(html).not.toContain("Cardiovascular");
      expect(html).toContain("Kardiovaskulære");
    } finally {
      await act(async () => {
        await i18n.changeLanguage("nb");
      });
    }
  });

  it("leaves headings untouched for unknown section / field ids", () => {
    const html = rendered(
      '<h2 data-monograph-section-title="not_a_section">Custom</h2>',
    );
    expect(html).toContain("Custom");
  });
});

describe("WikiRenderer fact discussions", () => {
  it("adds a discussion link to monograph facts and opens the selected fact", () => {
    const clicked: string[] = [];
    const { container } = render(
      <WikiRenderer
        contentHtml={
          '<div class="monograph-fact" data-fact-id="fact-1"><p>Claim.</p></div>'
        }
        factCommentCounts={{ "fact:fact-1": 3 }}
        onFactDiscussionClick={(factId) => clicked.push(factId)}
      />,
    );

    const link = container.querySelector('a[href="#fact-discussion-fact-1"]');
    expect(link?.textContent).toContain("(3)");

    fireEvent.click(link!);
    expect(clicked).toEqual(["fact-1"]);
  });

  it("ignores malformed fact discussion fragments", () => {
    const clicked: string[] = [];
    const { container } = render(
      <WikiRenderer
        contentHtml='<p><a href="#fact-discussion-%E0%A4%A">bad</a></p>'
        onFactDiscussionClick={(factId) => clicked.push(factId)}
      />,
    );

    fireEvent.click(container.querySelector("a")!);
    expect(clicked).toEqual([]);
  });
});

describe("WikiRenderer fact verification", () => {
  it("does not inject verification badges into fact prose", () => {
    // Review status now lives in the fact's discussion panel, not as an
    // inline badge in the rendered prose.
    const { container } = render(
      <WikiRenderer
        contentHtml={
          '<div class="monograph-fact" data-fact-id="fact-a"><p>A.</p></div>'
        }
        onFactDiscussionClick={() => {}}
      />,
    );
    expect(container.querySelector('[class*="kx-verify"]')).toBeNull();
  });
});

describe("WikiRenderer inline citation markers", () => {
  function citationRow(partial: Partial<CitationRow>): CitationRow {
    return {
      id: 1,
      drugId: null,
      type: "doi",
      identifier: "10.1093/jat/bkaa044",
      metadata: null,
      createdAt: "2026-01-01T00:00:00Z",
      ...partial,
    };
  }

  const fnHtml =
    '<sup class="footnote-marker" data-reference-id="1"><a href="#ref-1">[1]</a></sup>';

  it("renders compact bibliography numbers with hover citation details", () => {
    const citations = new Map<number, CitationRow>([
      [
        1,
        citationRow({
          type: "doi",
          identifier: "10.1093/jat/bkaa044",
          metadata: {
            authors: ["Huertas T"] as unknown as string,
            year: 2020,
          },
        }),
      ],
    ]);
    const bib = new Map<number, number>([[1, 4]]);
    const { container } = render(
      <WikiRenderer
        contentHtml={fnHtml}
        bibliographyMap={bib}
        citations={citations}
      />,
    );
    const html = container.innerHTML;
    expect(html).toContain("[4]");
    expect(html).toContain('href="#param-ref-4"');
    expect(html).toContain("Huertas, 2020");
    expect(html).toContain('href="/references/1"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('class="citation-tooltip"');
  });

  it("falls back to order-of-appearance numbers when no bibliography map is supplied", () => {
    const citations = new Map<number, CitationRow>([
      [
        1,
        citationRow({
          type: "doi",
          identifier: "10.1093/jat/bkaa044",
          metadata: {
            authors: ["Huertas T"] as unknown as string,
            title: "Forensic toxicology reference ranges",
            year: 2020,
          },
        }),
      ],
    ]);
    const { container } = render(
      <WikiRenderer contentHtml={fnHtml} citations={citations} />,
    );
    expect(container.innerHTML).toContain("[1]");
    expect(container.innerHTML).toContain('href="#param-ref-1"');
    expect(container.innerHTML).toContain(
      "Forensic toxicology reference ranges",
    );
  });

  it("uses bibliography numbering for freetext citations too", () => {
    const citations = new Map<number, CitationRow>([
      [
        1,
        citationRow({
          type: "freetext",
          identifier: "Baselt 2020",
          metadata: null,
        }),
      ],
    ]);
    const bib = new Map<number, number>([[1, 7]]);
    const { container } = render(
      <WikiRenderer
        contentHtml={fnHtml}
        bibliographyMap={bib}
        citations={citations}
      />,
    );
    const html = container.innerHTML;
    expect(html).toContain("[7]");
    expect(html).toContain('href="#param-ref-7"');
    expect(html).toContain("Baselt 2020");
  });

  it("lists every citation in the tooltip for compact ranges", () => {
    const html =
      '<sup class="footnote-marker" data-reference-id="1"><a href="#ref-1">[1]</a></sup>' +
      '<sup class="footnote-marker" data-reference-id="2"><a href="#ref-2">[2]</a></sup>' +
      '<sup class="footnote-marker" data-reference-id="3"><a href="#ref-3">[3]</a></sup>';
    const citations = new Map<number, CitationRow>([
      [
        1,
        citationRow({
          id: 1,
          metadata: {
            authors: ["Baselt RC"] as unknown as string,
            year: 2020,
            title: "Disposition of toxic drugs and chemicals in man",
          },
        }),
      ],
      [
        2,
        citationRow({
          id: 2,
          metadata: {
            authors: ["Moriya F", "Hashimoto Y"] as unknown as string,
            year: 1996,
            title:
              "Distribution of methamphetamine and amphetamine in blood and tissues",
          },
        }),
      ],
      [
        3,
        citationRow({
          id: 3,
          metadata: {
            authors: ["Huestis MA", "Cone EJ", "Wong CJ"] as unknown as string,
            year: 2011,
            title: "Oral fluid drug testing",
          },
        }),
      ],
    ]);
    const bib = new Map<number, number>([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
    const { container } = render(
      <WikiRenderer
        contentHtml={html}
        bibliographyMap={bib}
        citations={citations}
      />,
    );
    expect(container.innerHTML).toContain("[4–6]");
    expect(container.innerHTML).toContain("[4] Baselt, 2020");
    expect(container.innerHTML).toContain("[5] Moriya &amp; Hashimoto, 1996");
    expect(container.innerHTML).toContain("[6] Huestis et al., 2011");
  });

  it("renders citation tooltip content in a body-level portal on hover", () => {
    const citations = new Map<number, CitationRow>([
      [
        1,
        citationRow({
          id: 1,
          metadata: {
            authors: ["Baselt RC"] as unknown as string,
            year: 2020,
            title: "Disposition of toxic drugs and chemicals in man",
          },
        }),
      ],
    ]);
    const { container } = render(
      <WikiRenderer
        contentHtml={fnHtml}
        bibliographyMap={new Map([[1, 1]])}
        citations={citations}
      />,
    );
    const trigger = container.querySelector(".citation-tooltip-trigger");
    expect(document.body.querySelector(".citation-tooltip-portal")).toBeNull();
    expect(trigger).not.toBeNull();
    fireEvent.pointerOver(trigger!);
    const portal = document.body.querySelector(".citation-tooltip-portal");
    expect(portal?.textContent).toContain(
      "Disposition of toxic drugs and chemicals in man",
    );
  });

  it("keeps the tooltip open while the pointer moves onto the portal", () => {
    vi.useFakeTimers();
    try {
      const citations = new Map<number, CitationRow>([
        [
          1,
          citationRow({
            id: 1,
            metadata: {
              authors: ["Baselt RC"] as unknown as string,
              year: 2020,
              title: "Disposition of toxic drugs and chemicals in man",
            },
          }),
        ],
      ]);
      const { container } = render(
        <WikiRenderer
          contentHtml={fnHtml}
          bibliographyMap={new Map([[1, 1]])}
          citations={citations}
        />,
      );
      const trigger = container.querySelector(".citation-tooltip-trigger");
      act(() => {
        fireEvent.pointerOver(trigger!);
      });
      const portal = document.body.querySelector(".citation-tooltip-portal");
      expect(portal).not.toBeNull();

      // Pointer leaves the marker toward the portal: the hide is only
      // scheduled, so the tooltip is still present mid-flight.
      act(() => {
        fireEvent.pointerOut(trigger!, { relatedTarget: document.body });
      });
      expect(
        document.body.querySelector(".citation-tooltip-portal"),
      ).not.toBeNull();

      // Reaching the portal cancels the pending hide; it stays open even
      // after the delay window elapses, so the links remain clickable.
      act(() => {
        fireEvent.pointerEnter(portal!);
        vi.advanceTimersByTime(500);
      });
      expect(
        document.body.querySelector(".citation-tooltip-portal"),
      ).not.toBeNull();

      // Leaving the portal finally dismisses it after the delay.
      act(() => {
        fireEvent.pointerLeave(portal!);
        vi.advanceTimersByTime(500);
      });
      expect(document.body.querySelector(".citation-tooltip-portal")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps numeric [N] markers when no citations map is supplied (legacy / editor preview)", () => {
    const bib = new Map<number, number>([[1, 3]]);
    const { container } = render(
      <WikiRenderer contentHtml={fnHtml} bibliographyMap={bib} />,
    );
    expect(container.innerHTML).toContain("[3]");
    expect(container.innerHTML).toContain('href="#param-ref-3"');
  });
});

describe("WikiRenderer inline concentration unit tooltips", () => {
  // These assertions assume the default preference (primary unit µmol/L, with
  // mg/L also enabled). Pin it so a value set by another test can't leak in.
  beforeEach(() => {
    useAppStore.setState({ enabledUnits: ["µmol/L", "mg/L"] });
  });

  it("shows the value in the reader's preferred unit and keeps the original in the tooltip", () => {
    const { container } = render(
      <WikiRenderer
        contentHtml="<p>Serum concentration was 1.5 mg/L after intake.</p>"
        molecularWeight={150}
      />,
    );
    // 1.5 mg/L at MW 150 → 10 µmol/L, shown inline in the preferred unit.
    expect(container.textContent).toContain("Serum concentration was 10 µmol/L");
    const trigger = container.querySelector(".unit-conversion-trigger");
    expect(trigger?.textContent).toBe("µmol/L");
    // The authored mg/L figure survives inside the hover panel.
    expect(container.innerHTML).toContain("unit-conversion-tooltip-panel");
    const panel = container.querySelector(".unit-conversion-tooltip-panel");
    expect(panel?.textContent).toContain("1.5 mg/L");
  });

  it("leaves the value untouched when the preferred unit is the authored unit", () => {
    useAppStore.setState({ enabledUnits: ["mg/L", "µmol/L"] });
    const { container } = render(
      <WikiRenderer
        contentHtml="<p>Referansetabeller angir 0,2 til 0,5 mg/L i blod.</p>"
        molecularWeight={100}
      />,
    );
    // Authored figure kept verbatim; the tooltip carries the µmol/L equivalent.
    expect(container.textContent).toContain("0,2 til 0,5 mg/L");
    const panel = container.querySelector(".unit-conversion-tooltip-panel");
    expect(panel?.textContent).toContain("2–5 µmol/L");
  });

  it("keeps the authored unit when a cross-kind conversion has no molecular weight", () => {
    const { container } = render(
      <WikiRenderer contentHtml="<p>Toxic above 300 mg/L in serum.</p>" />,
    );
    // No MW → mg/L cannot become µmol/L, so nothing is rewritten or wrapped.
    expect(container.textContent).toContain("Toxic above 300 mg/L in serum.");
    expect(container.querySelector(".unit-conversion-tooltip")).toBeNull();
  });

  it("drops false precision when converting large magnitudes", () => {
    const { container } = render(
      <WikiRenderer
        contentHtml="<p>Toksisk 300–500 mg/L i serum.</p>"
        molecularWeight={150}
      />,
    );
    // 300–500 mg/L at MW 150 → 2000–3333 µmol/L, rendered without stray decimals.
    expect(container.textContent).toContain(`2${NBSP}000–3${NBSP}333 µmol/L`);
    const panel = container.querySelector(".unit-conversion-tooltip-panel");
    expect(panel?.textContent).toContain("300–500 mg/L");
    // Each value+unit is a non-breaking token wrapped in a line, so the panel
    // wraps between tokens instead of overflowing (the CSS selectors depend on
    // these class names existing).
    expect(panel?.querySelector(".unit-conversion-line")).not.toBeNull();
    expect(panel?.querySelector(".unit-conversion-token")).not.toBeNull();
  });

  it("parses comma thousands separators before converting tooltip values", () => {
    const { container } = render(
      <WikiRenderer
        contentHtml="<p>Peak concentration was 1,000 ng/mL.</p>"
        molecularWeight={150}
      />,
    );
    const panel = container.querySelector(".unit-conversion-tooltip-panel");
    expect(panel?.textContent).toContain("1 mg/L");
  });

  it("parses dotted thousands separators before converting tooltip values", () => {
    const { container } = render(
      <WikiRenderer
        contentHtml="<p>Peaks were 1.000 ng/mL and 1.234.567 ng/mL.</p>"
        molecularWeight={150}
      />,
    );
    const panels = container.querySelectorAll(".unit-conversion-tooltip-panel");
    expect(panels[0]?.textContent).toContain("1 mg/L");
    // Integer part is grouped with a non-breaking space thousands separator,
    // and decimals that add no precision at this magnitude are dropped.
    expect(panels[1]?.textContent).toContain("1 235 mg/L");
  });

  it("keeps sub-unit three-decimal concentration values as decimals", () => {
    const { container } = render(
      <WikiRenderer
        contentHtml="<p>Lower limit was 0.123 mg/L and 0,456 mg/L.</p>"
        molecularWeight={150}
      />,
    );
    // Both figures are re-expressed in the preferred unit (µmol/L) inline.
    expect(container.textContent).toContain("0.82 µmol/L");
    expect(container.textContent).toContain("3.04 µmol/L");
    const panels = container.querySelectorAll(".unit-conversion-tooltip-panel");
    expect(panels[0]?.textContent).toContain("0.123 mg/L");
    expect(panels[1]?.textContent).toContain("0.456 mg/L");
  });

  it("keeps single-separator three-decimal concentration values as decimals", () => {
    const { container } = render(
      <WikiRenderer
        contentHtml="<p>Measured values were 1,234 mg/L and 2.345 mg/L.</p>"
        molecularWeight={150}
      />,
    );
    expect(container.textContent).toContain("8.23 µmol/L");
    expect(container.textContent).toContain("15.6 µmol/L");
    const panels = container.querySelectorAll(".unit-conversion-tooltip-panel");
    expect(panels[0]?.textContent).toContain("1.234 mg/L");
    expect(panels[1]?.textContent).toContain("2.345 mg/L");
  });

  it("converts prose concentration intervals that use word separators", () => {
    const { container } = render(
      <WikiRenderer
        contentHtml="<p>Referansetabeller angir toksisk område fra 0,2 til 0,5 mg/L i blod.</p>"
        molecularWeight={100}
      />,
    );
    // The "til" separator is parsed and shown converted in the preferred unit;
    // the authored mg/L range moves into the tooltip.
    expect(container.textContent).toContain("2–5 µmol/L");
    const panel = container.querySelector(".unit-conversion-tooltip-panel");
    expect(panel?.textContent).toContain("0.2–0.5 mg/L");
  });

  it("preserves strict and inclusive ASCII bound semantics", () => {
    const { container } = render(
      <WikiRenderer
        contentHtml="<p>Bounds were &lt; 6 mg/L, &lt;= 5 mg/L, &gt; 3 mg/L, and &gt;= 2 mg/L.</p>"
        molecularWeight={150}
      />,
    );
    // Converted bounds keep their strict/inclusive operators in the inline text.
    expect(container.textContent).toContain("< 40 µmol/L");
    expect(container.textContent).toContain("≤ 33.3 µmol/L");
    expect(container.textContent).toContain("> 20 µmol/L");
    expect(container.textContent).toContain("≥ 13.3 µmol/L");
  });

  it("links injected tooltip panels to their keyboard focus target", () => {
    const { container } = render(
      <WikiRenderer
        contentHtml="<p>Serum concentration was 1.5 mg/L after intake.</p>"
        molecularWeight={150}
      />,
    );
    const tooltip = container.querySelector(".unit-conversion-tooltip");
    const panel = container.querySelector(".unit-conversion-tooltip-panel");
    expect(tooltip?.getAttribute("aria-describedby")).toBe(panel?.id);
    expect(panel?.id).toMatch(/^unit-conversion-tooltip-/);
  });

  it("recognizes every supported dL concentration unit in prose", () => {
    const { container } = render(
      <WikiRenderer
        contentHtml="<p>Values were 100 ng/dL and 2 µmol/dL.</p>"
        molecularWeight={150}
      />,
    );
    expect(container.querySelectorAll(".unit-conversion-tooltip")).toHaveLength(
      2,
    );
  });

  it("does not annotate concentration units inside rate expressions", () => {
    const { container } = render(
      <WikiRenderer
        contentHtml="<p>Clearance changed by 5 mg/L/day and AUC by 2 mg/L·h.</p>"
        molecularWeight={150}
      />,
    );
    expect(container.querySelector(".unit-conversion-tooltip")).toBeNull();
  });

  it("does not wrap concentration-looking text inside citation tooltips", () => {
    const citations = new Map<number, CitationRow>([
      [
        1,
        {
          id: 1,
          drugId: null,
          type: "doi",
          identifier: "10.1093/jat/bkaa044",
          metadata: {
            title: "Measured 1.5 mg/L in blood",
            authors: ["Huertas T"] as unknown as string,
            year: 2020,
          },
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    ]);
    const { container } = render(
      <WikiRenderer
        contentHtml={
          '<sup class="footnote-marker" data-reference-id="1"><a href="#ref-1">[1]</a></sup>'
        }
        bibliographyMap={new Map([[1, 1]])}
        citations={citations}
        molecularWeight={150}
      />,
    );
    const citationTooltip = container.querySelector(".citation-tooltip");
    expect(citationTooltip?.innerHTML).not.toContain("unit-conversion-tooltip");
  });

  it("limits citation tooltip hover target to the rendered reference marker", () => {
    const citations = new Map<number, CitationRow>([
      [
        1,
        {
          id: 1,
          drugId: null,
          type: "doi",
          identifier: "10.1000/example",
          metadata: { title: "Reference title", authors: [], year: 2024 },
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    ]);
    const { container } = render(
      <WikiRenderer
        contentHtml={
          '<p>Halveringstid 2-3 h<sup class="footnote-marker" data-reference-id="1"><a href="#ref-1">[1]</a></sup></p>'
        }
        bibliographyMap={new Map([[1, 1]])}
        citations={citations}
      />,
    );
    const marker = container.querySelector(".footnote-marker");
    expect(marker?.querySelector(":scope > .citation-tooltip")).toBeNull();
    expect(
      marker?.querySelector(
        ":scope > .citation-tooltip-trigger > a + .citation-tooltip",
      ),
    ).not.toBeNull();
  });
});
