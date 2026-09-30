/** Exact-PMID discovery. Returned external links are leads, NEVER fetched/executed here. */
import { download, normalizePmcid, type Attempt } from "./pmc";

export interface FulltextDiscovery {
  pmid: string;
  status: "routes_found" | "unresolved";
  readInFull: false;
  attempts: Attempt[];
  identity?: { title: string; doi?: string; pmcid?: string };
  routes: {
    url: string;
    kind: "pmc" | "publisher_or_repository";
    availability: string;
    format: string;
  }[];
}

function publicLead(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port
    )
      return;
    // These are never auto-fetched; nevertheless suppress obvious local targets.
    if (
      !url.hostname.includes(".") ||
      /[\[\]:]/.test(url.hostname) ||
      /^\d+(\.\d+){3}$/.test(url.hostname) ||
      /\.(localhost|local|internal)$/i.test(url.hostname)
    )
      return;
    return url.href;
  } catch {
    return;
  }
}

export async function discoverFulltext(
  pmid: string,
  request = download,
): Promise<FulltextDiscovery> {
  if (!/^[1-9]\d*$/.test(pmid)) throw new Error("Invalid PMID");
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=${encodeURIComponent(`EXT_ID:${pmid} AND SRC:MED`)}&format=json&resultType=core&pageSize=1`;
  const result: FulltextDiscovery = {
    pmid,
    status: "unresolved",
    readInFull: false,
    attempts: [],
    routes: [],
  };
  let httpStatus: number | undefined;
  try {
    const response = await request(url);
    httpStatus = response.status;
    if (httpStatus !== 200) {
      result.attempts.push({ url, httpStatus, outcome: `http_${httpStatus}` });
      return result;
    }
    const data = JSON.parse(response.text);
    const items = data?.resultList?.result;
    if (
      data?.hitCount !== 1 ||
      !Array.isArray(items) ||
      items.length !== 1 ||
      items[0]?.source !== "MED" ||
      items[0]?.id !== pmid ||
      typeof items[0]?.title !== "string" ||
      !items[0].title.trim()
    )
      throw new Error("identity_mismatch");
    const item = items[0];
    const pmcid = item.pmcid ? normalizePmcid(item.pmcid) : undefined;
    const doi =
      typeof item.doi === "string" && /^10\.\d{4,9}\/\S+$/.test(item.doi)
        ? item.doi
        : undefined;
    result.identity = { title: item.title, pmcid, doi };
    if (pmcid)
      result.routes.push({
        url: `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`,
        kind: "pmc",
        availability: "PMC candidate",
        format: "html",
      });
    const links = item.fullTextUrlList?.fullTextUrl;
    if (Array.isArray(links))
      for (const link of links) {
        const href = publicLead(link?.url);
        if (!href || result.routes.some((r) => r.url === href)) continue;
        result.routes.push({
          url: href,
          kind: "publisher_or_repository",
          availability:
            typeof link.availability === "string"
              ? link.availability
              : "unknown",
          format:
            typeof link.documentStyle === "string"
              ? link.documentStyle
              : "unknown",
        });
      }
    if (doi) {
      const href = `https://doi.org/${doi}`;
      if (!result.routes.some((r) => r.url === href))
        result.routes.push({
          url: href,
          kind: "publisher_or_repository",
          availability: "unknown",
          format: "doi",
        });
    }
    // inPMC / isOpenAccess are not gates: a Free publisher PDF can coexist with
    // both flags N (e.g. PMID 32838982). Discovery still isn't acquisition.
    result.status = result.routes.length ? "routes_found" : "unresolved";
    result.attempts.push({
      url,
      httpStatus,
      outcome: result.routes.length
        ? "identity_matched_routes"
        : "identity_matched_no_routes",
    });
  } catch (error) {
    result.identity = undefined;
    result.routes = [];
    const message = error instanceof Error ? error.message : "";
    const known = [
      "identity_mismatch",
      "response_too_large",
      "invalid_utf8",
      "redirect_not_allowed",
      "redirect_without_location",
      "too_many_redirects",
    ];
    result.attempts.push({
      url,
      httpStatus,
      outcome: known.includes(message)
        ? message
        : error instanceof SyntaxError
          ? "invalid_metadata"
          : typeof error === "object" &&
              error !== null &&
              "name" in error &&
              error.name === "TimeoutError"
            ? "timeout"
            : "network_error",
    });
  }
  return result;
}
