import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { EditFactPanel } from "./EditFactPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { id?: string; count?: number; max?: number }) => {
      if (key === "wikiFact.editTitle") return `Edit ${opts?.id ?? ""}`;
      if (key === "wikiFact.charCount") {
        return `${opts?.count ?? 0}/${opts?.max ?? 0}`;
      }
      return key;
    },
  }),
}));

vi.mock("./ReferenceInput", () => ({
  ReferenceInput: () => <div data-testid="reference-input" />,
}));

vi.mock("./FactStatementEditor", () => ({
  FactStatementEditor: () => <div data-testid="statement-editor" />,
}));

describe("EditFactPanel reference hydration", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hydrates existing fact references with one batched request", async () => {
    // `referenceApi`'s `apiFetch` reads the body with `res.text()` and parses it
    // itself, deliberately: a failure surfaced by the platform rather than the app
    // (a gateway timeout, a proxy error page, a 413) can arrive as HTML, and
    // `res.json()` would throw a SyntaxError before the `res.ok` check — losing the
    // real status behind an opaque parse error.
    //
    // A stub offering only `json` therefore makes `res.text()` throw, the hydration
    // promise reject, and the panel fall into its catch and show `refLoading`
    // forever. The failure looked like "the titles never rendered"; the cause was
    // that this fixture still modelled the older contract. Serve both, from one
    // payload, so the stub cannot drift from itself.
    const payload = {
      references: [
        {
          id: 2,
          drugId: null,
          type: "doi",
          identifier: "10.1000/two",
          metadata: { title: "Second source", authors: [], journal: "" },
          createdBy: null,
          createdAt: "2026-05-27T00:00:00.000Z",
        },
        {
          id: 1,
          drugId: null,
          type: "pmid",
          identifier: "12345",
          metadata: { title: "First source", authors: [], journal: "" },
          createdBy: null,
          createdAt: "2026-05-27T00:00:00.000Z",
        },
      ],
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(payload),
      json: async () => payload,
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <EditFactPanel
        pageId={10}
        sectionId="section-a"
        factId="fact-abcdef"
        initialStatement="Existing fact"
        initialReferenceIds={[2, 1]}
        onClose={vi.fn()}
        onSubmitted={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/references?ids=2%2C1",
      undefined,
    );
    // Awaited, not asserted straight after the fetch call. The request being
    // ISSUED and the hydrated rows being RENDERED are two different moments:
    // resolving the response body and folding it into state takes further ticks,
    // during which the list still shows `refLoading`. Asserting outside `waitFor`
    // made this pass only while those ticks happened to land inside the first
    // one — a race the test won until the hydration chain grew a step.
    await waitFor(() => {
      expect(screen.getByText(/Second source/)).toBeInTheDocument();
    });
    expect(screen.getByText(/First source/)).toBeInTheDocument();
  });
});
