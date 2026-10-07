import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquirePubChem,
  normalizePubChemCid,
  pugViewUrl,
  renderPugView,
} from "../scripts/fulltext/pubchem";
// @ts-expect-error Operational .mjs has no declaration file.
import { acquisitionCommand } from "../scripts/kinetix-fulltext.mjs";
import { isPubChemRecordCitation } from "../src/lib/publicDatabaseRecord";

const record = JSON.stringify({
  Record: {
    RecordType: "CID",
    RecordNumber: 115237,
    RecordTitle: "Paliperidone",
    Section: [
      {
        TOCHeading: "Pharmacology and Biochemistry",
        Section: [
          {
            TOCHeading: "Biological Half-Life",
            Information: [
              {
                ReferenceNumber: 12,
                Value: {
                  StringWithMarkup: [
                    {
                      String:
                        "The terminal elimination half-life is approximately 23 hours.",
                    },
                  ],
                },
              },
              {
                ReferenceNumber: 31,
                ExtendedReference: [
                  {
                    Citation:
                      "Clarke WP et al; Br J Pharmacol 170 (3): 532-45 (2013)",
                    Matched: {
                      Citation: "Clarke WP. Signalling profile differences.",
                      PMID: 23826915,
                      DOI: "10.1111/bph.12295",
                    },
                  },
                ],
                Value: { Number: [25, 49], Unit: "days" },
              },
            ],
          },
        ],
      },
    ],
    Reference: [
      {
        ReferenceNumber: 12,
        SourceName: "DrugBank",
        Name: "Paliperidone",
        URL: "https://go.drugbank.com/drugs/DB01267",
      },
      {
        ReferenceNumber: 31,
        SourceName: "Hazardous Substances Data Bank (HSDB)",
      },
    ],
  },
});

afterEach(() => vi.unstubAllGlobals());

describe("PubChem record rendering", () => {
  it("keeps the contributing source and the primary study on every statement", () => {
    const rendered = renderPugView(record, "115237");
    expect(rendered.title).toBe("Paliperidone");
    expect(rendered.text).toContain("## Biological Half-Life");
    expect(rendered.text).toContain(
      "- The terminal elimination half-life is approximately 23 hours.\n  [source 12: DrugBank <https://go.drugbank.com/drugs/DB01267>]",
    );
    expect(rendered.text).toContain("- 25, 49 days");
    expect(rendered.text).toContain(
      "[cites: Clarke WP. Signalling profile differences. (PMID 23826915; DOI 10.1111/bph.12295)]",
    );
    expect(rendered.text).toContain("# Contributing sources");
    expect(rendered.primaryCitations).toBe(1);
  });

  it("rejects a record for another compound and malformed JSON", () => {
    expect(() => renderPugView(record, "1")).toThrow("identity_mismatch");
    expect(() => renderPugView("<html>captcha</html>", "115237")).toThrow(
      "invalid_json",
    );
  });

  it("accepts only numeric CIDs", () => {
    expect(normalizePubChemCid("115237")).toBe("115237");
    for (const bad of ["0", "abc", "1/../2", "paliperidone", ""])
      expect(() => normalizePubChemCid(bad)).toThrow();
    expect(pugViewUrl("115237")).toBe(
      "https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/115237/JSON",
    );
  });
});

describe("PubChem acquisition", () => {
  it("returns a candidate from the PUG-View service, never a read-in-full attestation", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(record, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await acquirePubChem("115237");
    expect(result).toMatchObject({ status: "candidate", readInFull: false });
    expect(fetchMock.mock.calls[0][0].href).toBe(pugViewUrl("115237"));
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      credentials: "omit",
      redirect: "manual",
    });
  });

  it("reports an unresolved HTTP failure and refuses off-host redirects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 503 })),
    );
    expect(await acquirePubChem("115237")).toMatchObject({
      status: "unresolved",
      attempts: [{ httpStatus: 503, outcome: "http_503" }],
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example/" },
          }),
        ),
    );
    expect(await acquirePubChem("115237")).toMatchObject({
      status: "unresolved",
      attempts: [{ outcome: "redirect_not_allowed" }],
    });
  });

  it("is dispatched by the standalone runner only for a numeric CID", () => {
    expect(acquisitionCommand(["pubchem", "115237"])).toEqual([
      "scripts/fetch-pubchem-record.ts",
      "115237",
    ]);
    for (const args of [
      ["pubchem"],
      ["pubchem", "paliperidone"],
      ["pubchem", "1", "--eval", "x"],
    ])
      expect(() => acquisitionCommand(args)).toThrow("Usage:");
  });
});

describe("PubChem citation classification", () => {
  it("matches PubChem record URLs only", () => {
    for (const identifier of [
      "https://pubchem.ncbi.nlm.nih.gov/compound/115237",
      "http://pubchem.ncbi.nlm.nih.gov/compound/paliperidone",
      " HTTPS://www.pubchem.ncbi.nlm.nih.gov/substance/1 ",
    ])
      expect(isPubChemRecordCitation({ type: "url", identifier })).toBe(true);
    for (const citation of [
      {
        type: "url",
        identifier: "https://example.org/pubchem.ncbi.nlm.nih.gov/",
      },
      {
        type: "url",
        identifier: "https://pubchem.ncbi.nlm.nih.gov.evil.example/",
      },
      { type: "doi", identifier: "10.1093/nar/gkae1059" },
      {
        type: "freetext",
        identifier: "https://pubchem.ncbi.nlm.nih.gov/compound/1",
      },
    ])
      expect(isPubChemRecordCitation(citation)).toBe(false);
  });
});
