import { describe, expect, it } from "vitest";
import { renderTexToHtml } from "./katexRender";

describe("renderTexToHtml", () => {
  it("renders inline LaTeX to KaTeX markup", () => {
    const html = renderTexToHtml("C_0 e^{-kt}", false);
    expect(html).toContain("katex");
    // Inline mode must not carry the display wrapper class.
    expect(html).not.toContain("katex-display");
  });

  it("renders display LaTeX with the display wrapper", () => {
    const html = renderTexToHtml("\\frac{a}{b}", true);
    expect(html).toContain("katex-display");
  });

  it("renders the multi-line iPMR-LS constructs (frac, sqrt, cases)", () => {
    const tex = String.raw`B = \begin{cases} 0, & \text{ingen} \\ \sigma(1.2(pK_{aB}-8.0)), & \text{basisk} \end{cases}`;
    const html = renderTexToHtml(tex, true);
    expect(html).toContain("katex");
    // KaTeX emits a MathML mirror for accessibility.
    expect(html).toContain("<math");
  });

  it("does not throw on malformed input (renders an inline error)", () => {
    expect(() => renderTexToHtml("\\frac{", true)).not.toThrow();
  });

  it("does not emit navigable anchors even when \\href is used (trust: false)", () => {
    const html = renderTexToHtml("\\href{https://evil.test}{x}", false);
    // With trust:false the command is rejected and rendered as an inert red
    // error token — no anchor element, nothing navigable. The URL survives
    // only as plain text inside the MathML <annotation> source echo, which
    // carries no link semantics.
    expect(html).not.toContain("<a ");
    expect(html).not.toMatch(/href="https:\/\/evil\.test"/);
    expect(html).toContain("#cc0000");
  });
});
