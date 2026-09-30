import katex from "katex";

/**
 * Render a LaTeX string to KaTeX HTML+MathML markup.
 *
 * Shared by the editor node view (`MathView`) and the read-only
 * `WikiRenderer` so authored and published math render identically.
 *
 * Security: `trust: false` disables KaTeX commands that can emit URLs or
 * raw markup (`\href`, `\includegraphics`, `\htmlData`, …), so the output
 * is inert typeset markup with no script or navigation surface. This is
 * what lets `WikiRenderer` inject the result *after* `sanitizeWikiHtml`
 * (mirroring how verification badges are injected) without widening the
 * sanitizer's tag allowlist to cover KaTeX's spans and `<math>` output.
 *
 * `throwOnError: false` means malformed input renders as an inline error
 * (red source text) instead of throwing — a single bad formula never blanks
 * the whole article.
 */
export function renderTexToHtml(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: false,
    strict: "ignore",
    trust: false,
    output: "htmlAndMathml",
  });
}
