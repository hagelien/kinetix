import { describe, expect, it } from "vitest";
import { renderHtml } from "../../api/_lib/tiptap-utils";
import { sanitizeWikiHtml } from "./sanitizeWikiHtml";
import { renderTexToHtml } from "./katexRender";

/**
 * End-to-end worked example for the math pipeline, using the real iPMR-LS
 * formula (`docs/ipmr-ls.md`, `src/lib/ipmr.ts`). Exercises the same chain a
 * published monograph goes through:
 *
 *   TipTap JSON → renderHtml (server) → sanitizeWikiHtml (client)
 *               → renderTexToHtml (client, post-sanitization)
 *
 * The React `WikiRenderer` wires these together; this test pins the
 * non-React boundary so a regression in any single stage is caught.
 */
const IPMR_MAIN = String.raw`\mathrm{iPMR} = 100 \times (0.45V + 0.20B + 0.10L_N + 0.05L_D + 0.05U + 0.15T)`;
const IPMR_CASES = String.raw`B = \begin{cases} 0, & \text{ingen basisk gruppe} \\ \sigma\!\left(1.2(pK_{aB}-8.0)\right), & \text{basisk stoff} \end{cases}`;
const IPMR_SIGMOID = String.raw`\sigma(x) = \frac{1}{1 + e^{-x}}`;

describe("math pipeline (iPMR-LS worked example)", () => {
  const doc = {
    type: "doc",
    content: [
      { type: "mathBlock", attrs: { tex: IPMR_MAIN } },
      { type: "mathBlock", attrs: { tex: IPMR_CASES } },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "with " },
          { type: "mathInline", attrs: { tex: IPMR_SIGMOID } },
        ],
      },
    ],
  };

  it("preserves every formula's LaTeX through server render + sanitization", () => {
    const sanitized = sanitizeWikiHtml(renderHtml(doc));

    for (const tex of [IPMR_MAIN, IPMR_CASES, IPMR_SIGMOID]) {
      // The DOM round-trip decodes entities, so compare against decoded text.
      const parsed = new DOMParser().parseFromString(sanitized, "text/html");
      const carriers = Array.from(
        parsed.querySelectorAll<HTMLElement>("[data-tex]"),
      ).map((n) => n.getAttribute("data-tex"));
      expect(carriers).toContain(tex);
    }
    // Two display blocks + one inline marker survived.
    expect(sanitized.match(/data-tex=/g)?.length).toBe(3);
  });

  it("renders each marker to KaTeX, displayMode keyed off the block class", () => {
    const sanitized = sanitizeWikiHtml(renderHtml(doc));
    const parsed = new DOMParser().parseFromString(sanitized, "text/html");

    for (const node of Array.from(
      parsed.querySelectorAll<HTMLElement>("[data-tex]"),
    )) {
      const tex = node.getAttribute("data-tex") ?? "";
      const display = node.classList.contains("kx-math-block");
      const html = renderTexToHtml(tex, display);
      expect(html).toContain("katex");
      expect(html.includes("katex-display")).toBe(display);
    }
  });
});
