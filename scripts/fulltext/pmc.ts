/** Read-only, bounded acquisition of PMC article candidates. Never a review attestation. */
import { JSDOM } from "jsdom";

export type Format = "xml" | "html";
export interface Attempt {
  url: string;
  outcome: string;
  httpStatus?: number;
}
export interface ArticleCandidate {
  title: string;
  text: string;
  tables: number;
  figures: number;
  formulae: number;
  supplements: number;
}
export interface Acquisition {
  pmcid: string;
  expectedPmid?: string;
  status: "candidate" | "unresolved";
  readInFull: false;
  attempts: Attempt[];
  source?: {
    url: string;
    format: Format;
    raw: string;
    article: ArticleCandidate;
  };
}

export const MAX_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 25_000;
const HOSTS = new Set([
  "pmc.ncbi.nlm.nih.gov",
  "www.ebi.ac.uk",
  "eutils.ncbi.nlm.nih.gov",
]);

export function normalizePmcid(value: string): string {
  if (!/^PMC[1-9]\d*$/i.test(value))
    throw new Error("Expected a PMCID such as PMC3584707");
  return value.toUpperCase();
}

function publicUrl(value: string, hosts: ReadonlySet<string>): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !hosts.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error("redirect_not_allowed");
  }
  return url;
}

/** No cookies, bearer tokens, dotenv, shell, automatic retries or arbitrary source URLs. */
export async function download(
  url: string,
  hosts: ReadonlySet<string> = HOSTS,
  accept = "application/xml,text/html;q=0.9",
): Promise<{ status: number; text: string }> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let current = publicUrl(url, hosts);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(current, {
      redirect: "manual",
      signal,
      credentials: "omit",
      headers: {
        Accept: accept,
        "User-Agent": "Kinetix-Fulltext/1.0",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("redirect_without_location");
      current = publicUrl(new URL(location, current).href, hosts);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, text: "" };
    }
    if (Number(response.headers.get("content-length")) > MAX_BYTES) {
      await response.body?.cancel();
      throw new Error("response_too_large");
    }
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, text: "" };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error("response_too_large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    try {
      return {
        status: response.status,
        text: new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks),
        ),
      };
    } catch {
      throw new Error("invalid_utf8");
    }
  }
  throw new Error("too_many_redirects");
}

function rendered(node: Node): string {
  if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
  if (node.nodeType !== 1) return "";
  const el = node as Element;
  const tag = el.localName.toLowerCase();
  if (["script", "style", "noscript", "nav", "button"].includes(tag)) return "";
  const content = Array.from(el.childNodes, rendered).join("");
  if (tag === "sup") return `^(${content})`;
  if (tag === "sub") return `_(${content})`;
  if (/^h[1-6]$/.test(tag) || tag === "title") return `\n\n## ${content}\n`;
  if (tag === "td" || tag === "th") {
    const span = ["rowspan", "colspan"]
      .filter((a) => el.hasAttribute(a))
      .map((a) => `${a}=${el.getAttribute(a)}`)
      .join(" ");
    return `${span ? `[${span}] ` : ""}${content.trim()} | `;
  }
  if (tag === "tr") return `\n${content}\n`;
  if (["img", "graphic", "inline-graphic", "media"].includes(tag)) {
    const reference =
      el.getAttribute("src") ?? el.getAttribute("xlink:href") ?? "";
    return `\n[VISUAL: ${el.getAttribute("alt") ?? reference}; inspect in original article]\n${content}`;
  }
  if (["disp-formula", "inline-formula", "math"].includes(tag))
    return `\n[FORMULA: inspect original] ${content}\n`;
  if (tag === "a" || tag === "ext-link") {
    const href = el.getAttribute("href") ?? el.getAttribute("xlink:href");
    return href ? `${content} [${href}]` : content;
  }
  if (
    [
      "p",
      "sec",
      "section",
      "div",
      "table",
      "table-wrap",
      "caption",
      "fig",
      "figure",
      "ref",
      "list-item",
      "li",
      "abstract",
      "supplementary-material",
    ].includes(tag)
  ) {
    return `\n${content}\n`;
  }
  return content;
}

/** Structural checks, not length heuristics: short corrections can have real bodies. */
export function parseArticle(
  raw: string,
  format: Format,
  pmcid: string,
  expectedPmid?: string,
): ArticleCandidate {
  if (
    /<title[^>]*>\s*(Checking your browser|Just a moment|Access denied)/i.test(
      raw,
    )
  )
    throw new Error("challenge_page");
  // Disable expansion of any supplied internal entity definitions. JSDOM never loads external resources.
  if (/<!ENTITY\s/i.test(raw)) throw new Error("xml_entities_not_supported");
  let dom: JSDOM;
  try {
    dom = new JSDOM(raw, {
      contentType: format === "xml" ? "text/xml" : "text/html",
    });
  } catch {
    throw new Error("invalid_document");
  }
  try {
    const doc = dom.window.document;
    let body: Element | null;
    let content: Element | null;
    let title: string;
    let actualPmid: string | null;
    if (format === "xml") {
      const article =
        doc.documentElement.localName === "article"
          ? doc.documentElement
          : doc.querySelector("pmc-articleset > article");
      const meta = article?.querySelector(":scope > front > article-meta");
      const actual = meta
        ?.querySelector(
          'article-id[pub-id-type="pmcid"], article-id[pub-id-type="pmc"]',
        )
        ?.textContent?.trim();
      if (!actual || `PMC${actual.replace(/^PMC/i, "")}` !== pmcid)
        throw new Error("identity_mismatch");
      actualPmid =
        meta
          ?.querySelector('article-id[pub-id-type="pmid"]')
          ?.textContent?.trim() ?? null;
      title = meta?.querySelector("article-title")?.textContent?.trim() ?? "";
      body = article?.querySelector(":scope > body") ?? null;
      content = article ?? null;
    } else {
      const canonical = doc
        .querySelector('link[rel="canonical"]')
        ?.getAttribute("href");
      if (canonical !== `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`)
        throw new Error("identity_mismatch");
      actualPmid =
        doc
          .querySelector('meta[name="citation_pmid"]')
          ?.getAttribute("content") ?? null;
      title =
        doc
          .querySelector('meta[name="citation_title"]')
          ?.getAttribute("content") ?? "";
      body = doc.querySelector("article .main-article-body");
      content = doc.querySelector(
        'article > section[aria-label="Article content"]',
      );
    }
    if (expectedPmid && actualPmid !== expectedPmid)
      throw new Error("pmid_mismatch");
    if (!title || !body || !content) throw new Error("no_article_body");
    const prose = body.cloneNode(true) as Element;
    prose
      .querySelectorAll("abstract, .abstract, .kwd-group, script, style")
      .forEach((el) => el.remove());
    if (!prose.textContent?.trim() || !prose.querySelector("p, table"))
      throw new Error("no_article_body");
    const text = rendered(content)
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return {
      title,
      text,
      tables: content.querySelectorAll("table").length,
      figures: content.querySelectorAll("fig, figure, .fig").length,
      formulae: content.querySelectorAll(
        "disp-formula, inline-formula, math, .disp-formula, .inline-formula",
      ).length,
      supplements: content.querySelectorAll(
        "supplementary-material, .supplementary-material",
      ).length,
    };
  } finally {
    dom.window.close();
  }
}

export async function acquirePmc(
  input: string,
  expectedPmid?: string,
  request = download,
): Promise<Acquisition> {
  const pmcid = normalizePmcid(input);
  if (expectedPmid !== undefined && !/^[1-9]\d*$/.test(expectedPmid))
    throw new Error("Invalid PMID");
  const result: Acquisition = {
    pmcid,
    expectedPmid,
    status: "unresolved",
    readInFull: false,
    attempts: [],
  };
  const candidates: [string, Format][] = [
    [
      `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid}/fullTextXML`,
      "xml",
    ],
    [`https://pmc.ncbi.nlm.nih.gov/articles/${pmcid}/`, "html"],
    [
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pmc&id=${pmcid.slice(3)}&rettype=full&retmode=xml&tool=kinetix-fulltext`,
      "xml",
    ],
  ];
  for (const [url, format] of candidates) {
    let httpStatus: number | undefined;
    try {
      const response = await request(url);
      httpStatus = response.status;
      if (httpStatus !== 200) {
        result.attempts.push({
          url,
          httpStatus,
          outcome: `http_${httpStatus}`,
        });
        continue;
      }
      const article = parseArticle(response.text, format, pmcid, expectedPmid);
      result.attempts.push({ url, httpStatus, outcome: "candidate" });
      result.status = "candidate";
      result.source = { url, format, raw: response.text, article };
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const known = [
        "challenge_page",
        "identity_mismatch",
        "pmid_mismatch",
        "no_article_body",
        "invalid_document",
        "invalid_utf8",
        "xml_entities_not_supported",
        "response_too_large",
        "redirect_not_allowed",
        "redirect_without_location",
        "too_many_redirects",
      ];
      // Do not leak arbitrary response text, credentials or environment values in a receipt.
      const timedOut =
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "TimeoutError";
      const outcome = known.includes(message)
        ? message
        : timedOut
          ? "timeout"
          : "network_error";
      result.attempts.push({ url, httpStatus, outcome });
    }
  }
  return result;
}
