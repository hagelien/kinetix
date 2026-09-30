import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  acquirePmc,
  download,
  MAX_BYTES,
  normalizePmcid,
  parseArticle,
} from "../scripts/fulltext/pmc";

const xml = `<article><front><article-meta>
<article-id pub-id-type="pmcid">PMC3584707</article-id><article-id pub-id-type="pmid">21346758</article-id>
<title-group><article-title>Alfentanil study</article-title></title-group><abstract><p>Summary</p></abstract>
</article-meta></front><body><sec><title>Results</title><p>ø, ≤ and α remain intact.</p>
<table-wrap id="T2"><label>Table 2</label><caption><p>Control group</p></caption><table>
<thead><tr><th>Endpoint</th><th>Sequential</th><th>Simultaneous</th></tr></thead>
<tbody><tr><td>T<sub>max</sub> (h)</td><td>1.0 ± 0.8</td><td>1.4 ± 0.4</td></tr></tbody></table>
<table-wrap-foot><p>n=6; oral d3-alfentanil</p></table-wrap-foot></table-wrap>
<fig><caption><p>Concentration curve</p></caption><graphic xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="figure1.jpg"/></fig>
<disp-formula><p>AUC = dose / CL</p></disp-formula><supplementary-material><p>Supplement</p></supplementary-material>
</sec></body><back><ref-list><ref><p>Reference one</p></ref></ref-list></back></article>`;
const html = `<html><head><link rel="canonical" href="https://pmc.ncbi.nlm.nih.gov/articles/PMC3584707/">
<meta name="citation_title" content="Alfentanil study"><meta name="citation_pmid" content="21346758"></head>
<body><article><section aria-label="Article content"><section class="main-article-body">
<section class="abstract"><p>Abstract</p></section><section><h2>Results</h2><p>Complete results.</p>
<table><tr><th>Tmax</th><td colspan="2">1.0 ± 0.8</td></tr></table></section></section>
<section><h2>References</h2><p>Reference one</p></section></section></article></body></html>`;
const challenge =
  "<html><head><title>Checking your browser - reCAPTCHA</title></head><body>please wait</body></html>";

afterEach(() => vi.unstubAllGlobals());

describe("article candidate validation and readable rendering", () => {
  it("preserves table headings, cells, units, uncertainty, footnotes, captions and references", () => {
    const parsed = parseArticle(xml, "xml", "PMC3584707", "21346758");
    for (const value of [
      "Sequential",
      "Simultaneous",
      "1.0 ± 0.8",
      "1.4 ± 0.4",
      "T_(max) (h)",
      "n=6",
      "Reference one",
      "ø, ≤ and α",
    ])
      expect(parsed.text).toContain(value);
    expect(parsed).toMatchObject({
      tables: 1,
      figures: 1,
      formulae: 1,
      supplements: 1,
    });
    expect(parsed.text).toContain(
      "[VISUAL: figure1.jpg; inspect in original article]",
    );
    expect(parsed.text).toContain("[FORMULA: inspect original]");
  });
  it("accepts the PMC author-manuscript HTML layout and retains table spans/back matter", () => {
    const parsed = parseArticle(html, "html", "PMC3584707", "21346758");
    expect(parsed.text).toContain("[colspan=2] 1.0 ± 0.8");
    expect(parsed.text).toContain("Reference one");
  });
  it("accepts short real corrections without an arbitrary word threshold", () => {
    const short = xml.replace(
      /<body>[\s\S]*<\/body>/,
      "<body><p>The correct dose is 2 mg.</p></body>",
    );
    expect(parseArticle(short, "xml", "PMC3584707").text).toContain("2 mg");
  });
  it.each(["xml", "html"] as const)(
    "refuses challenge pages even with HTTP 200 (%s)",
    (format) => {
      expect(() => parseArticle(challenge, format, "PMC3584707")).toThrow(
        "challenge_page",
      );
    },
  );
  it("refuses front matter, abstract-only HTML, mismatched identities and malformed XML", () => {
    expect(() =>
      parseArticle(
        xml.replace(/<body>[\s\S]*<\/body>/, ""),
        "xml",
        "PMC3584707",
      ),
    ).toThrow("no_article_body");
    expect(() =>
      parseArticle(
        html.replace(/<section><h2>Results[\s\S]*?<\/section>/, ""),
        "html",
        "PMC3584707",
      ),
    ).toThrow("no_article_body");
    expect(() => parseArticle(xml, "xml", "PMC11111")).toThrow(
      "identity_mismatch",
    );
    expect(() => parseArticle(html, "html", "PMC11111")).toThrow(
      "identity_mismatch",
    );
    expect(() => parseArticle(xml, "xml", "PMC3584707", "999")).toThrow(
      "pmid_mismatch",
    );
    expect(() => parseArticle("<article>", "xml", "PMC3584707")).toThrow(
      "invalid_document",
    );
  });
  it("does not execute script, include navigation, or expand custom XML entities", () => {
    expect(
      parseArticle(
        html.replace(
          "Complete results.",
          '<script>throw new Error("RUN")</script>Complete results.',
        ),
        "html",
        "PMC3584707",
      ).text,
    ).not.toContain("RUN");
    expect(() =>
      parseArticle(
        '<!DOCTYPE article [<!ENTITY x "hello">]>' + xml,
        "xml",
        "PMC3584707",
      ),
    ).toThrow("xml_entities_not_supported");
  });
  it("accepts the older numeric PMC identifier and EFetch wrapper", () => {
    expect(
      parseArticle(
        "<pmc-articleset>" +
          xml.replace(
            'pub-id-type="pmcid">PMC3584707',
            'pub-id-type="pmc">3584707',
          ) +
          "</pmc-articleset>",
        "xml",
        "PMC3584707",
      ).tables,
    ).toBe(1);
  });
});

describe("bounded independent acquisition channels", () => {
  it("uses an XML body without stripping the decisive table and never attests readInFull", async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, text: xml });
    const result = await acquirePmc("pmc3584707", "21346758", request);
    expect(request).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "candidate", readInFull: false });
    expect(result.source?.article.text).toContain("1.0 ± 0.8");
  });
  it("falls back to HTML when XML is outside the reusable OA subset", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ status: 404, text: "" })
      .mockResolvedValueOnce({ status: 200, text: html });
    const result = await acquirePmc("PMC3584707", undefined, request);
    expect(result.source?.format).toBe("html");
    expect(result.attempts.map((a) => a.outcome)).toEqual([
      "http_404",
      "candidate",
    ]);
  });
  it("tries independent EFetch after XML failure and HTML CAPTCHA", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret-token-do-not-log"))
      .mockResolvedValueOnce({ status: 200, text: challenge })
      .mockResolvedValueOnce({ status: 200, text: xml });
    const result = await acquirePmc("PMC3584707", undefined, request);
    expect(result.attempts.map((a) => a.outcome)).toEqual([
      "network_error",
      "challenge_page",
      "candidate",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
  it("returns an unresolved attempt receipt, not a claim of inaccessible literature", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ status: 403, text: "No access" });
    const result = await acquirePmc("PMC3584707", undefined, request);
    expect(result).toMatchObject({ status: "unresolved", readInFull: false });
    expect(result.source).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("records timeouts separately and does not retry a rate-limited endpoint", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"))
      .mockResolvedValueOnce({ status: 429, text: "" })
      .mockResolvedValueOnce({ status: 200, text: xml });
    expect(
      (await acquirePmc("PMC3584707", undefined, request)).attempts.map(
        (a) => a.outcome,
      ),
    ).toEqual(["timeout", "http_429", "candidate"]);
  });
  it.each([
    "123",
    "PMC0",
    "PMC123/../../x",
    "https://example.com",
    "PMC123?token=secret",
  ])("rejects invalid identifier %s before networking", async (value) => {
    expect(() => normalizePmcid(value)).toThrow();
    const request = vi.fn();
    await expect(acquirePmc(value, undefined, request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("public transport boundaries", () => {
  it("rejects damaged UTF-8 instead of silently replacing scientific symbols", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array([0xf8]))),
    );
    await expect(download("https://pmc.ncbi.nlm.nih.gov/")).rejects.toThrow(
      "invalid_utf8",
    );
  });
  it("never follows a redirect to an arbitrary host", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("", {
          status: 302,
          headers: { location: "http://127.0.0.1/secret" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      download("https://pmc.ncbi.nlm.nih.gov/articles/PMC3584707/"),
    ).rejects.toThrow("redirect_not_allowed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      credentials: "omit",
      redirect: "manual",
    });
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty(
      "Authorization",
    );
  });
  it("bounds redirects and response size, including unannounced streaming bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          async () =>
            new Response("", { status: 302, headers: { location: "/loop" } }),
        ),
    );
    await expect(download("https://pmc.ncbi.nlm.nih.gov/")).rejects.toThrow(
      "too_many_redirects",
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("x", {
            headers: { "content-length": String(MAX_BYTES + 1) },
          }),
        ),
    );
    await expect(download("https://pmc.ncbi.nlm.nih.gov/")).rejects.toThrow(
      "response_too_large",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(new Uint8Array(MAX_BYTES + 1))),
    );
    await expect(download("https://pmc.ncbi.nlm.nih.gov/")).rejects.toThrow(
      "response_too_large",
    );
  });
});

it("routes maintainer, scientific review and peer verification through the same acquisition checklist", () => {
  for (const file of [
    "drug-db-maintainer.md",
    "peer-verification-protocol.md",
    "kinectics_science_paper_review_agent_instructions.md",
  ]) {
    expect(readFileSync(resolve("agents", file), "utf8")).toContain(
      "agents/fulltext-acquisition.md",
    );
  }
});
