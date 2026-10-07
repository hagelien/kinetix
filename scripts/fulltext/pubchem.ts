/**
 * Read-only, bounded acquisition of a PubChem compound record through the open
 * PUG-View JSON service. Never a review attestation.
 *
 * PubChem's HTML compound page serves automated readers a CAPTCHA, which is
 * not a paywall: the same record is published as structured data. A PubChem
 * record is a database aggregate, not a paper — every statement in it carries
 * the contributing source (DrugBank, HSDB, LiverTox, DailyMed …) and often the
 * primary study (PMID/DOI). The rendering keeps that attribution on every line
 * so an agent can cite the primary source rather than PubChem itself.
 */
import { download, type Attempt } from "./pmc";

export interface PubChemAcquisition {
  cid: string;
  status: "candidate" | "unresolved";
  readInFull: false;
  attempts: Attempt[];
  source?: { url: string; raw: string; record: RenderedRecord };
}

export interface RenderedRecord {
  title: string;
  text: string;
  /** Lines that cite a primary study by PMID or DOI. */
  primaryCitations: number;
}

const HOSTS: ReadonlySet<string> = new Set(["pubchem.ncbi.nlm.nih.gov"]);

export function normalizePubChemCid(value: string): string {
  if (!/^[1-9]\d{0,11}$/.test(value))
    throw new Error("Expected a PubChem CID such as 115237");
  return value;
}

export function pugViewUrl(cid: string): string {
  return `https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/${normalizePubChemCid(cid)}/JSON`;
}

interface Markup {
  String?: string;
}
interface Information {
  ReferenceNumber?: number;
  Name?: string;
  Description?: string;
  Reference?: string[];
  ExtendedReference?: {
    Citation?: string;
    Matched?: {
      Citation?: string;
      PMID?: number;
      DOI?: string;
      PMCID?: string;
    };
  }[];
  Value?: {
    StringWithMarkup?: Markup[];
    Number?: number[];
    Unit?: string;
    Boolean?: boolean[];
    DateISO8601?: string[];
    ExternalDataURL?: string[];
  };
}
interface Section {
  TOCHeading?: string;
  Information?: Information[];
  Section?: Section[];
}
interface Reference {
  ReferenceNumber?: number;
  SourceName?: string;
  Name?: string;
  URL?: string;
}

function valueText(value: Information["Value"]): string {
  if (!value) return "";
  const parts: string[] = [];
  for (const item of value.StringWithMarkup ?? [])
    if (item.String) parts.push(item.String);
  if (value.Number?.length)
    parts.push(value.Number.join(", ") + (value.Unit ? ` ${value.Unit}` : ""));
  else if (value.Unit) parts.push(value.Unit);
  if (value.Boolean?.length) parts.push(value.Boolean.join(", "));
  if (value.DateISO8601?.length) parts.push(value.DateISO8601.join(", "));
  if (value.ExternalDataURL?.length)
    parts.push(`[EXTERNAL DATA: ${value.ExternalDataURL.join(", ")}]`);
  return parts.join(" | ");
}

function primaryCitation(info: Information): string[] {
  const cites: string[] = [];
  for (const ref of info.ExtendedReference ?? []) {
    const matched = ref.Matched;
    const ids = [
      matched?.PMID ? `PMID ${matched.PMID}` : "",
      matched?.DOI ? `DOI ${matched.DOI}` : "",
      matched?.PMCID ?? "",
    ].filter(Boolean);
    const citation = matched?.Citation ?? ref.Citation ?? "";
    cites.push(ids.length ? `${citation} (${ids.join("; ")})` : citation);
  }
  if (!cites.length) cites.push(...(info.Reference ?? []));
  return cites.filter(Boolean);
}

/** Render a PUG-View record as readable text with per-line source attribution. */
export function renderPugView(
  raw: string,
  expectedCid: string,
): RenderedRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid_json");
  }
  const record = (parsed as { Record?: Record<string, unknown> }).Record;
  if (!record || String(record.RecordNumber) !== expectedCid)
    throw new Error("identity_mismatch");
  const title = String(record.RecordTitle ?? `CID ${expectedCid}`);
  const references = new Map<number, Reference>();
  for (const ref of (record.Reference as Reference[] | undefined) ?? [])
    if (ref.ReferenceNumber) references.set(ref.ReferenceNumber, ref);

  const lines: string[] = [`PubChem CID ${expectedCid}: ${title}`];
  let primaryCitations = 0;
  const walk = (sections: Section[] | undefined, depth: number): void => {
    for (const section of sections ?? []) {
      lines.push(
        "",
        `${"#".repeat(Math.min(depth, 6))} ${section.TOCHeading ?? ""}`,
      );
      for (const info of section.Information ?? []) {
        const text = valueText(info.Value);
        if (!text) continue;
        const source = info.ReferenceNumber
          ? references.get(info.ReferenceNumber)
          : undefined;
        const cites = primaryCitation(info);
        if (cites.some((c) => /PMID|DOI|doi\.org|10\.\d{4,}\//.test(c)))
          primaryCitations++;
        lines.push(`- ${info.Name ? `${info.Name}: ` : ""}${text}`);
        if (source)
          lines.push(
            `  [source ${info.ReferenceNumber}: ${source.SourceName ?? "unknown"}${source.URL ? ` <${source.URL}>` : ""}]`,
          );
        for (const cite of cites) lines.push(`  [cites: ${cite}]`);
      }
      walk(section.Section, depth + 1);
    }
  };
  walk(record.Section as Section[] | undefined, 1);

  lines.push("", "# Contributing sources");
  for (const [number, ref] of references)
    lines.push(
      `- [${number}] ${ref.SourceName ?? "unknown"}: ${ref.Name ?? ""}${ref.URL ? ` <${ref.URL}>` : ""}`,
    );
  return { title, text: lines.join("\n"), primaryCitations };
}

export async function acquirePubChem(
  cidInput: string,
): Promise<PubChemAcquisition> {
  const cid = normalizePubChemCid(cidInput);
  const url = pugViewUrl(cid);
  const result: PubChemAcquisition = {
    cid,
    status: "unresolved",
    readInFull: false,
    attempts: [],
  };
  try {
    const response = await download(url, HOSTS, "application/json");
    if (response.status !== 200 || !response.text) {
      result.attempts.push({
        url,
        httpStatus: response.status,
        outcome: `http_${response.status}`,
      });
      return result;
    }
    const record = renderPugView(response.text, cid);
    result.attempts.push({ url, httpStatus: 200, outcome: "candidate" });
    result.status = "candidate";
    result.source = { url, raw: response.text, record };
  } catch (error) {
    result.attempts.push({
      url,
      outcome: error instanceof Error ? error.message : "network_error",
    });
  }
  return result;
}
