import { describe, it, expect } from "vitest";
import { compactInlineRefs, compactRenderedRefs } from "./inlineRefs";

describe("compactInlineRefs", () => {
  it("returns empty array for empty input", () => {
    expect(compactInlineRefs([])).toEqual([]);
  });

  it("keeps a single number as a singleton", () => {
    expect(compactInlineRefs([4])).toEqual([{ from: 4, to: 4 }]);
  });

  it("collapses a pair of consecutive numbers into an en-dash range", () => {
    expect(compactInlineRefs([1, 2])).toEqual([{ from: 1, to: 2 }]);
  });

  it("collapses a run of 3 or more consecutive numbers into a range", () => {
    expect(compactInlineRefs([7, 8, 9])).toEqual([{ from: 7, to: 9 }]);
    expect(compactInlineRefs([1, 2, 3, 4])).toEqual([{ from: 1, to: 4 }]);
  });

  it("handles the mixed example from #427 with two-item ranges", () => {
    expect(compactInlineRefs([1, 2, 5, 7, 8, 9])).toEqual([
      { from: 1, to: 2 },
      { from: 5, to: 5 },
      { from: 7, to: 9 },
    ]);
  });

  it("does not collapse non-consecutive numbers", () => {
    expect(compactInlineRefs([1, 3, 5])).toEqual([
      { from: 1, to: 1 },
      { from: 3, to: 3 },
      { from: 5, to: 5 },
    ]);
  });

  it("sorts caller-supplied groups into ascending reference order", () => {
    expect(compactInlineRefs([3, 1, 2])).toEqual([{ from: 1, to: 3 }]);
  });
});

describe("compactRenderedRefs", () => {
  const marker = (n: number) =>
    `<sup class="footnote-marker"><a href="#param-ref-${n}">[${n}]</a></sup>`;

  it("leaves a single marker untouched", () => {
    const html = `Foo ${marker(3)} bar`;
    expect(compactRenderedRefs(html)).toBe(html);
  });

  it("collapses a pair of markers into an en-dash range", () => {
    const html = `Foo ${marker(1)}${marker(2)} bar`;
    expect(compactRenderedRefs(html)).toBe(
      `Foo <sup class="footnote-marker"><a href="#param-ref-1">[1–2]</a></sup> bar`,
    );
  });

  it("collapses three or more consecutive markers into a range", () => {
    const html = `Foo ${marker(1)}${marker(2)}${marker(3)}${marker(4)} bar`;
    expect(compactRenderedRefs(html)).toBe(
      `Foo <sup class="footnote-marker"><a href="#param-ref-1">[1–4]</a></sup> bar`,
    );
  });

  it("keeps singletons inside a longer run that is not all consecutive", () => {
    const html = `${marker(1)}${marker(2)}${marker(5)}${marker(7)}${marker(8)}${marker(9)}`;
    expect(compactRenderedRefs(html)).toBe(
      `<sup class="footnote-marker"><a href="#param-ref-1">[1–2]</a></sup>${marker(5)}<sup class="footnote-marker"><a href="#param-ref-7">[7–9]</a></sup>`,
    );
  });

  it("tolerates whitespace between adjacent markers", () => {
    const html = `${marker(1)} ${marker(2)} ${marker(3)}`;
    expect(compactRenderedRefs(html)).toBe(
      `<sup class="footnote-marker"><a href="#param-ref-1">[1–3]</a></sup>`,
    );
  });

  it("preserves source reference ids when collapsing rendered markers", () => {
    const markerWithId = (n: number, id: number) =>
      `<sup class="footnote-marker" data-reference-ids="${id}"><a href="#param-ref-${n}">[${n}]</a></sup>`;
    const html = `${markerWithId(4, 101)}${markerWithId(5, 202)}${markerWithId(6, 303)}`;
    expect(compactRenderedRefs(html)).toBe(
      `<sup class="footnote-marker" data-reference-ids="101,202,303"><a href="#param-ref-4">[4–6]</a></sup>`,
    );
  });

  it("sorts adjacent markers into ascending order before compacting", () => {
    const html = `${marker(5)}${marker(36)}${marker(1)}`;
    expect(compactRenderedRefs(html)).toBe(
      `${marker(1)}${marker(5)}${marker(36)}`,
    );
  });
});
