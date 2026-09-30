import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewMonographSearchPanel } from "@/components/wiki/NewMonographSearchPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? key,
    i18n: { language: "nb" },
  }),
}));

interface MockResponse {
  url: string;
  body: unknown;
}

function makeFetch(responses: MockResponse[]) {
  return vi.fn().mockImplementation((input: RequestInfo) => {
    const url = typeof input === "string" ? input : input.toString();
    const match = responses.find((r) => url.startsWith(r.url));
    if (!match) {
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(match.body),
    });
  });
}

describe("NewMonographSearchPanel (#329)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns an existing kinetix drug when one matches the query", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetch([
        {
          url: "/api/drugs?view=search",
          body: {
            drugs: [
              {
                id: 42,
                slug: "alprazolam",
                names: { nb: "Alprazolam", en: "Alprazolam" },
                nameShort: null,
                aliases: [],
                pubchemCid: 2118,
              },
            ],
          },
        },
      ]),
    );

    const onPickExistingDrug = vi.fn();
    const onPickPubChem = vi.fn();
    const onSkipManual = vi.fn();
    render(
      <NewMonographSearchPanel
        onPickExistingDrug={onPickExistingDrug}
        onPickPubChem={onPickPubChem}
        onSkipManual={onSkipManual}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "alp" },
    });

    fireEvent.click(await screen.findByText("Alprazolam"));

    await waitFor(() => {
      expect(onPickExistingDrug).toHaveBeenCalledWith(
        expect.objectContaining({ _dbId: 42 }),
      );
    });
    expect(onPickPubChem).not.toHaveBeenCalled();
    expect(onSkipManual).not.toHaveBeenCalled();
  });

  it("offers PubChem suggestions when kinetix has no hit and the query is long enough", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetch([
        { url: "/api/drugs?view=search", body: { drugs: [] } },
        {
          url: "/api/pubchem-search",
          body: {
            results: [
              {
                cid: 5311,
                name: "Aspirin",
                molecularWeight: 180.16,
                molecularFormula: "C9H8O4",
              },
            ],
          },
        },
      ]),
    );

    const onPickPubChem = vi.fn();
    render(
      <NewMonographSearchPanel
        onPickExistingDrug={vi.fn()}
        onPickPubChem={onPickPubChem}
        onSkipManual={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "aspirin" },
    });

    fireEvent.click(await screen.findByText("Aspirin"));

    await waitFor(() => {
      expect(onPickPubChem).toHaveBeenCalledWith(
        expect.objectContaining({ cid: 5311, name: "Aspirin" }),
      );
    });
  });

  it("finds PubChem CID matches through the slim kinetix search endpoint", async () => {
    const fetchMock = makeFetch([
      {
        url: "/api/drugs?view=search",
        body: {
          drugs: [
            {
              id: 42,
              slug: "alprazolam",
              names: { nb: "Alprazolam", en: "Alprazolam" },
              nameShort: null,
              aliases: [],
              pubchemCid: 2118,
            },
          ],
        },
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const onPickExistingDrug = vi.fn();
    render(
      <NewMonographSearchPanel
        onPickExistingDrug={onPickExistingDrug}
        onPickPubChem={vi.fn()}
        onSkipManual={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "2118" },
    });

    fireEvent.click(await screen.findByText("Alprazolam"));

    await waitFor(() => {
      expect(onPickExistingDrug).toHaveBeenCalledWith(
        expect.objectContaining({ _dbId: 42 }),
      );
    });
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith("/api/drugs?cid="),
      ),
    ).toBe(false);
  });

  it("forwards the typed query to onSkipManual when the author chooses manual entry", async () => {
    vi.stubGlobal(
      "fetch",
      makeFetch([{ url: "/api/drugs?view=search", body: { drugs: [] } }]),
    );

    const onSkipManual = vi.fn();
    render(
      <NewMonographSearchPanel
        onPickExistingDrug={vi.fn()}
        onPickPubChem={vi.fn()}
        onSkipManual={onSkipManual}
      />,
    );

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "novel-compound-x" },
    });

    fireEvent.click(
      await screen.findByText(
        "Add manually — drug isn't in any database",
      ),
    );

    expect(onSkipManual).toHaveBeenCalledWith("novel-compound-x");
  });
});
