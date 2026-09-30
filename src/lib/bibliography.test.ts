import { describe, expect, it } from "vitest";
import { buildDrugBibliography } from "./bibliography";

describe("buildDrugBibliography", () => {
  it("numbers inline monograph footnotes before sidebar-only parameter references", () => {
    const bibliography = buildDrugBibliography(
      {
        halfLife: [30, 10],
        volumeOfDistribution: [40],
      },
      [20, 10],
    );

    expect([...bibliography.entries()]).toEqual([
      [20, 1],
      [10, 2],
      [30, 3],
      [40, 4],
    ]);
  });
});
