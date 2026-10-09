import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WikiArticleImportSection } from "./WikiArticleImportSection";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("previews and queues the exact document and clears the completed preview", async () => {
  const document = {
    sources: [{ key: "s1", type: "doi", identifier: "10.1234/test" }],
  };
  const plan = {
    fingerprint: "abc",
    title: "Test",
    factCount: 1,
    newSectionCount: 1,
    blockedCount: 0,
    sections: [
      {
        key: "s",
        sectionId: "test",
        heading: "Bakgrunn",
        level: 2,
        create: true,
        facts: [{ key: "f", statement: "Testfaktum", sourceKeys: ["s1"] }],
      },
    ],
  };
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, plan }),
  } as Response);
  render(<WikiArticleImportSection />);
  expect(screen.queryByText("admin.wikiArticle.apply")).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: JSON.stringify(document) },
  });
  fireEvent.click(screen.getByText("admin.wikiArticle.analyse"));
  await screen.findByText("Testfaktum");
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({
      ok: true,
      result: { queued: 1, skipped: 0, newSections: 1 },
    }),
  } as Response);
  fireEvent.click(screen.getByText("admin.wikiArticle.apply"));
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(
    JSON.parse(vi.mocked(fetch).mock.calls[1]![1]!.body as string),
  ).toEqual({ document, action: "apply", expectedFingerprint: "abc" });
  await screen.findByText("admin.wikiArticle.result");
  expect(screen.queryByText("admin.wikiArticle.apply")).not.toBeInTheDocument();
});
