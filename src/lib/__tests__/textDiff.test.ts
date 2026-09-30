import { describe, expect, it } from "vitest";
import { buildWordDiff, textFromContent, textFromHtml } from "../textDiff";

describe("textDiff", () => {
  it("extracts text from regular TipTap docs", () => {
    expect(
      textFromContent({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Old sentence." }],
          },
        ],
      }),
    ).toBe("Old sentence.");
  });

  it("extracts text from monograph section envelopes in section order", () => {
    expect(
      textFromContent({
        version: 2,
        sections: {
          toxicity: {
            body: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Toxicity text." }],
                },
              ],
            },
          },
          pd: {
            body: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "PD text." }],
                },
              ],
            },
          },
        },
      }),
    ).toBe("PD text. Toxicity text.");
  });

  it("builds added and removed chunks", () => {
    expect(buildWordDiff("alpha beta gamma", "alpha delta gamma")).toEqual([
      { type: "same", text: "alpha" },
      { type: "removed", text: "beta" },
      { type: "added", text: "delta" },
      { type: "same", text: "gamma" },
    ]);
  });

  it("extracts fallback text from html", () => {
    expect(textFromHtml("<p>Hello <strong>world</strong></p>")).toBe(
      "Hello world",
    );
  });
});
