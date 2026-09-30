import { describe, expect, it, vi } from "vitest";
import { discoverFulltext } from "../scripts/fulltext/discovery";

const record = {
  id: "32838982",
  source: "MED",
  doi: "10.1016/j.bja.2020.06.067",
  title: "Ketamine and its metabolites",
  inPMC: "N",
  isOpenAccess: "N",
  fullTextUrlList: {
    fullTextUrl: [
      {
        availability: "Free",
        documentStyle: "pdf",
        url: "http://www.bjanaesthesia.org/article/S0007091220305717/pdf",
      },
      {
        availability: "Subscription required",
        documentStyle: "doi",
        url: "https://doi.org/10.1016/j.bja.2020.06.067",
      },
    ],
  },
};
function requestFor(item: unknown = record) {
  return vi
    .fn()
    .mockResolvedValue({
      status: 200,
      text: JSON.stringify({ hitCount: 1, resultList: { result: [item] } }),
    });
}

describe("exact-PMID route discovery", () => {
  it("finds the free publisher PDF even when both OA and PMC flags are N", async () => {
    const request = requestFor();
    const result = await discoverFulltext("32838982", request);
    expect(result).toMatchObject({
      status: "routes_found",
      readInFull: false,
      identity: { doi: record.doi },
    });
    expect(result.routes).toContainEqual({
      url: record.fullTextUrlList.fullTextUrl[0].url,
      kind: "publisher_or_repository",
      availability: "Free",
      format: "pdf",
    });
    expect(result.identity?.pmcid).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1); // NEVER fetch the external lead.
    expect(request.mock.calls[0][0]).toContain(
      "EXT_ID%3A32838982%20AND%20SRC%3AMED",
    );
  });
  it("resolves PMC identity for the bounded full-text reader without calling discovery a read", async () => {
    const result = await discoverFulltext(
      "32838982",
      requestFor({ ...record, pmcid: "PMC3584707" }),
    );
    expect(result.identity?.pmcid).toBe("PMC3584707");
    expect(result.routes[0].kind).toBe("pmc");
    expect(result.readInFull).toBe(false);
  });
  it.each([
    { ...record, id: "999" },
    { ...record, source: "PMC" },
    { ...record, title: "" },
  ])("refuses a different or incomplete identity", async (item) => {
    const result = await discoverFulltext("32838982", requestFor(item));
    expect(result.status).toBe("unresolved");
    expect(result.routes).toEqual([]);
    expect(result.attempts[0].outcome).toBe("identity_mismatch");
  });
  it.each([0, 2])(
    "refuses ambiguous or empty metadata (%i hits)",
    async (hitCount) => {
      const request = vi
        .fn()
        .mockResolvedValue({
          status: 200,
          text: JSON.stringify({ hitCount, resultList: { result: [record] } }),
        });
      expect(
        (await discoverFulltext("32838982", request)).attempts[0].outcome,
      ).toBe("identity_mismatch");
    },
  );
  it("does not emit unsafe links or duplicate DOI leads", async () => {
    const links = [
      "javascript:alert(1)",
      "file:///secret",
      "http://127.0.0.1/x",
      "http://[::1]/x",
      "http://localhost/x",
      "https://x.local/x",
      "https://user:secret@example.com/x",
      "https://example.com:8080/x",
      "https://doi.org/10.1016/j.bja.2020.06.067",
    ];
    const result = await discoverFulltext(
      "32838982",
      requestFor({
        ...record,
        fullTextUrlList: { fullTextUrl: links.map((url) => ({ url })) },
      }),
    );
    expect(result.routes.map((r) => r.url)).toEqual([
      "https://doi.org/10.1016/j.bja.2020.06.067",
    ]);
  });
  it("keeps no-routes distinct from network failure and never calls it a paywall", async () => {
    const result = await discoverFulltext(
      "32838982",
      requestFor({ id: "32838982", source: "MED", title: "Short paper" }),
    );
    expect(result).toMatchObject({ status: "unresolved", readInFull: false });
    expect(result.attempts[0].outcome).toBe("identity_matched_no_routes");
  });
  it("records HTTP, malformed metadata and timeout failures without leaking arbitrary errors", async () => {
    for (const [request, outcome] of [
      [vi.fn().mockResolvedValue({ status: 429, text: "" }), "http_429"],
      [
        vi.fn().mockResolvedValue({ status: 200, text: "secret-not-json" }),
        "invalid_metadata",
      ],
      [
        vi.fn().mockRejectedValue(new DOMException("secret", "TimeoutError")),
        "timeout",
      ],
      [vi.fn().mockRejectedValue(new Error("secret")), "network_error"],
    ] as const) {
      const result = await discoverFulltext("32838982", request);
      expect(result.attempts[0].outcome).toBe(outcome);
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });
  it.each(["", "0", "PMC123", "123&query=all", "../123"])(
    "rejects invalid PMID %s before network access",
    async (input) => {
      const request = vi.fn();
      await expect(discoverFulltext(input, request)).rejects.toThrow(
        "Invalid PMID",
      );
      expect(request).not.toHaveBeenCalled();
    },
  );
});
