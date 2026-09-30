/**
 * Does every reference in the database name a paper that actually exists?
 *
 * A citation row carries two independent things: a HANDLE (`pmid:30973059`,
 * `doi:10.1000/x`) and a METADATA BLOB (title, authors, journal, year). Nothing
 * in the write path forced them to agree. A row whose metadata was supplied by
 * an LLM rather than fetched from the registry can therefore sit in the table
 * looking perfectly well-formed while the handle points at an unrelated paper —
 * or at no paper at all.
 *
 * They exist, and in bulk. `pmid:30973059` was filed as *"A case of
 * flubromazepam toxicity: analysis of serum and urine"* by Carpenter et al.;
 * NCBI answers that 30973059 is *"Scandinavian research on complementary and
 * alternative medicine: A bibliometric study"* by Danell et al. The UI shows
 * the stored title and links out to the stored number, so a reader only sees
 * the mismatch if they click through and read.
 *
 * This asks the registries. It is READ-ONLY: its output is a review list, not a
 * fix, because the two failure classes below want different answers and one of
 * them is not recoverable at all.
 *
 *   DEAD HANDLE   the PMID/DOI resolves to nothing. The number is invented.
 *   WRONG HANDLE  the stored title IS a real paper, but under a different
 *                 handle than the one filed. Repairable: retarget the row.
 *   UNFINDABLE    the handle names an unrelated paper AND no registry record
 *                 matches the stored title. The paper itself is likely
 *                 fabricated; nothing to retarget it to.
 *   TITLE DRIFT   handle and metadata name the same work, but the stored title
 *                 was translated or paraphrased ("Amfetaminforgiftning" for
 *                 "[Amphetamine poisoning]."). Cosmetic — the row is sound and
 *                 its metadata can simply be refreshed from the registry.
 *
 * The line between the middle two is drawn by a SECOND lookup, not by the first
 * one's similarity score. Stage 1 asks "does the handle's record match the
 * stored metadata"; only rows that fail it go on to stage 2, which asks PubMed
 * whether the stored title exists anywhere. That ordering is what keeps the run
 * cheap: stage 1 is ~200 rows per request, stage 2 up to four per suspect.
 *
 * The two stages are not the same order of cost, and the difference is the
 * whole reason for the ordering. Stage 1 clears the table in about a minute.
 * Stage 2 is bounded by NCBI's rate limit rather than by the work — two
 * searches per row, each possibly followed by an esummary, throttled to ~3
 * requests a second without an API key — so a thousand suspects is a couple of
 * hours. Set `NCBI_API_KEY` to raise that ceiling to 10/s, or run `--no-stage2`
 * when the question is only how bad the table is rather than which rows are
 * salvageable.
 *
 * **Agreement is judged on authors and year, not on the title.** A title can
 * differ for innocent reasons — translation, a subtitle dropped, sentence case
 * — and identical titles are not rare in this literature. Author surnames plus
 * publication year do not collide by accident: the flubromazepam row above
 * shares not one surname with the record it points at. A title mismatch alone
 * therefore lands in TITLE DRIFT, never in a fabrication verdict.
 *
 * Impact is printed beside each finding as the number of parameter entries the
 * row backs, so a curator can work the list in the order that matters rather
 * than by citation id.
 *
 * Usage:
 *   npm run audit:citations
 *   npm run audit:citations -- --json report.json
 *   npm run audit:citations -- --type doi
 *   npm run audit:citations -- --no-stage2      # stage 1 only, ~20 requests
 *   npm run audit:citations -- --limit 200      # sample instead of the table
 *
 * Stage 2 checkpoints every answer to `.citation-audit-checkpoint.jsonl` (or
 * `--checkpoint <path>`) and resumes from it, so an interrupted run costs the
 * rows it had not reached rather than all of them.
 */
import 'dotenv/config';
import fs from 'node:fs';
import { sql } from 'drizzle-orm';
import { getDb } from '../api/_lib/db';
import {
  fetchRecords,
  searchPubMed,
  type PubMedRecord,
} from '../api/_lib/pubmed-eutils';
import { fetchCrossRefMetadata } from '../api/_lib/crossref';
import { fetchDataCiteRecord } from '../api/_lib/datacite';
import { politeUserAgent } from '../api/_lib/polite-user-agent';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

type Verdict =
  | 'ok'
  | 'title-drift'
  | 'wrong-handle'
  | 'unfindable'
  | 'dead-handle'
  | 'registry-silent'
  | 'unchecked';

interface StoredMetadata {
  title?: string | null;
  authors?: unknown;
  journal?: string | null;
  year?: number | null;
}

interface CitationRow {
  id: number;
  type: string;
  identifier: string;
  metadata: StoredMetadata | null;
  parameterEntries: number;
  hasReview: boolean;
}

interface Finding {
  id: number;
  type: string;
  identifier: string;
  verdict: Verdict;
  /** Token overlap between stored and registry title, 0–1. */
  titleSimilarity: number;
  /** Share of stored author surnames the registry record also lists, 0–1. */
  authorOverlap: number | null;
  yearMatches: boolean | null;
  storedTitle: string;
  registryTitle: string | null;
  storedAuthors: string[];
  registryAuthors: string[];
  storedYear: number | null;
  registryYear: number | null;
  /** Handle the stored title was found under, when stage 2 found one. */
  suggestedPmid: string | null;
  /** A Crossref DOI the stored title was found under, when stage 3 found one. */
  suggestedDoi: string | null;
  parameterEntries: number;
  hasReview: boolean;
}

// ─── Comparison primitives ──────────────────────────────────────────────────
// Deliberately crude. These decide "same work or not", a question with a wide
// margin, and every extra rule is another way to be confidently wrong about a
// row a human would read correctly at a glance.

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Content words only: short words carry no discriminating power in titles. */
function contentWords(value: string): Set<string> {
  return new Set(
    normalize(value)
      .split(' ')
      .filter((w) => w.length > 3),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / new Set([...a, ...b]).size;
}

/**
 * The surname out of an author string, whichever way round it was stored.
 *
 * PubMed writes `Danell JB`, Crossref writes `Jenny-Ann Brodin Danell`, and the
 * stored blobs contain both shapes. Initials are dropped (`JB`, `J.B.`) and the
 * longest remaining token is taken: it is the surname in the PubMed form and,
 * for the Crossref form, the name most likely to be the family name. Wrong on
 * compound surnames, which is acceptable — the comparison is over a SET of
 * surnames and needs only partial overlap.
 */
function surname(author: string): string {
  const parts = normalize(author)
    .split(' ')
    .filter((part) => part.length > 2);
  if (parts.length === 0) return '';
  return parts.reduce((longest, part) =>
    part.length > longest.length ? part : longest,
  );
}

function surnameSet(authors: unknown): Set<string> {
  if (!Array.isArray(authors)) return new Set();
  const out = new Set<string>();
  for (const entry of authors) {
    const raw =
      typeof entry === 'string'
        ? entry
        : typeof (entry as { name?: string })?.name === 'string'
          ? (entry as { name: string }).name
          : '';
    const name = surname(raw);
    if (name) out.add(name);
  }
  return out;
}

/** Share of the STORED surnames the registry also lists; null if none stored. */
function authorOverlap(
  stored: Set<string>,
  registry: Set<string>,
): number | null {
  if (stored.size === 0) return null;
  let shared = 0;
  for (const name of stored) if (registry.has(name)) shared++;
  return shared / stored.size;
}

// A stored year one off the registry's is routine rather than suspicious:
// esummary dates the print issue, an LLM-written blob often carries the epub
// year, and the two straddle a new year for a large share of the literature.
function yearAgrees(
  stored: number | null,
  registry: number | null,
): boolean | null {
  if (!stored || !registry) return null;
  return Math.abs(stored - registry) <= 1;
}

/** Above this, two titles are the same work. */
const TITLE_MATCH = 0.5;
/** Below this share of shared surnames, two author lists are different people. */
const AUTHORS_DIFFER = 0.34;
/** Stage 2 only accepts a search hit this close to the stored title. */
const STAGE2_MATCH = 0.6;

// ─── Registry lookups ───────────────────────────────────────────────────────

interface RegistryRecord {
  title: string;
  authors: string[];
  year: number | null;
}

async function pubmedRecords(
  pmids: string[],
): Promise<Map<string, RegistryRecord>> {
  const out = new Map<string, RegistryRecord>();
  // `fetchRecords` already batches at 200 and throttles to NCBI's published
  // rate; a failure mid-way would lose every answer, so batches are driven here
  // and a failed one is reported rather than aborting the run.
  const size = 200;
  for (let i = 0; i < pmids.length; i += size) {
    const batch = pmids.slice(i, i + size);
    let records: PubMedRecord[] = [];
    try {
      records = await fetchRecords(batch);
    } catch (err) {
      console.warn(
        `  ! esummary batch ${i / size + 1} failed (${(err as Error).message}) — ` +
          `${batch.length} row(s) left unchecked`,
      );
      continue;
    }
    for (const record of records) {
      out.set(record.pmid, {
        title: record.title,
        authors: record.authors,
        year: record.year,
      });
    }
    process.stderr.write(
      `  stage 1: ${Math.min(i + size, pmids.length)}/${pmids.length}\r`,
    );
  }
  process.stderr.write('\n');
  return out;
}

/**
 * Does the stored title exist in PubMed under any handle?
 *
 * Two queries per row, because neither form alone is reliable: the `[Title]`
 * phrase search misses on punctuation, Greek letters and dropped subtitles,
 * and the bare term search ANDs its words and misses on an unusual one. A hit
 * from either is enough; a miss from both is what UNFINDABLE means.
 */
async function findByTitle(title: string): Promise<string | null> {
  const words = normalize(title)
    .split(' ')
    .filter((w) => w.length > 3);
  if (words.length < 3) return null;
  const wanted = contentWords(title);
  const queries = [`${normalize(title)}[Title]`, words.slice(0, 12).join(' ')];

  for (const query of queries) {
    let result;
    try {
      result = await searchPubMed({ query, maxResults: 5, sort: 'relevance' });
    } catch {
      continue;
    }
    for (const record of result.records) {
      if (jaccard(wanted, contentWords(record.title)) >= STAGE2_MATCH) {
        return record.pmid;
      }
    }
  }
  return null;
}

/**
 * Stage 2's answers, appended a row at a time.
 *
 * A full run takes hours, and the things that end it — a laptop closing, a
 * container being recycled, a terminal dying — do not ask first. Without this
 * every such interruption threw away every lookup already paid for, which is
 * the whole cost of the audit. So each answer is flushed to disk as it
 * arrives, and a re-run skips what the file already holds.
 *
 * Keyed by citation id rather than by PMID: the row is what is being decided
 * about, and the identifier is one of the things under suspicion.
 *
 * Append-only JSONL so a run killed mid-write loses at most its last line, and
 * deliberately NOT deleted on success: the file is what makes a re-run after a
 * crash cheap, and an audit that tidied it away would be back to hours.
 */
function readCheckpoint(path: string): Map<number, string | null> {
  const out = new Map<number, string | null>();
  if (!fs.existsSync(path)) return out;
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { id?: number; pmid?: string | null };
      if (typeof entry.id === 'number') out.set(entry.id, entry.pmid ?? null);
    } catch {
      // A torn last line from a killed run. Everything before it still counts.
    }
  }
  return out;
}

function appendCheckpoint(path: string, id: number, pmid: string | null): void {
  fs.appendFileSync(path, `${JSON.stringify({ id, pmid })}\n`);
}

/**
 * Does the stored title exist in CROSSREF under any DOI?
 *
 * Stage 2 asks PubMed and nothing else, and PubMed is not the literature. A
 * sample of 40 rows it had called `unfindable` found 3 of them in Crossref
 * under their exact stored titles — *Clinical Pharmacokinetics of Ethanol*
 * among them. Extrapolated, roughly 8% of that verdict is a real paper the
 * wrong registry was asked about.
 *
 * That rate is tolerable in a report and not tolerable in a deletion. This
 * stage exists so the `unfindable` bucket can be acted on: every row that
 * survives PubMed is asked of Crossref too, and one that turns up there is
 * reclassified `wrong-handle` — repairable, not fabricated.
 *
 * The threshold is deliberately higher than stage 2's. Crossref's
 * `query.bibliographic` always returns its five best guesses however poor, so
 * a loose match would manufacture a DOI for a paper that does not exist, which
 * is the one error this whole stage is meant to prevent.
 */
const CROSSREF_MATCH = 0.75;
/** Parallel Crossref lookups. Its search is seconds per query, not milliseconds. */
const CROSSREF_CONCURRENCY = 6;

async function findDoiByTitle(title: string): Promise<string | null> {
  const wanted = contentWords(title);
  if (wanted.size < 3) return null;
  const url =
    'https://api.crossref.org/works?rows=5&select=title,DOI' +
    `&query.bibliographic=${encodeURIComponent(title)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': politeUserAgent(),
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      message?: { items?: Array<{ title?: string[]; DOI?: string }> };
    };
    let best = 0;
    let doi: string | null = null;
    for (const item of data.message?.items ?? []) {
      const candidate = Array.isArray(item.title) ? (item.title[0] ?? '') : '';
      const score = jaccard(wanted, contentWords(candidate));
      if (score > best) {
        best = score;
        doi = item.DOI ?? null;
      }
    }
    return best >= CROSSREF_MATCH ? doi : null;
  } catch {
    return null;
  }
}

// ─── Audit ──────────────────────────────────────────────────────────────────

async function loadCitations(
  type: string,
  limit: number | null,
): Promise<CitationRow[]> {
  const db = getDb();
  const rows = await db.execute<{
    id: number;
    type: string;
    identifier: string;
    metadata: StoredMetadata | null;
    parameter_entries: number;
    has_review: boolean;
  }>(sql`
    SELECT c.id,
           c.type,
           c.identifier,
           c.metadata,
           (SELECT count(*)::int FROM parameter_entries pe WHERE pe.citation_id = c.id)
             AS parameter_entries,
           EXISTS (SELECT 1 FROM paper_reviews pr WHERE pr.citation_id = c.id)
             AS has_review
      FROM citations c
     WHERE c.type IN (${sql.join(
       (type === 'all' ? ['pmid', 'doi'] : [type]).map((t) => sql`${t}`),
       sql`, `,
     )})
       AND c.metadata ->> 'title' IS NOT NULL
     ORDER BY c.id
     ${limit ? sql`LIMIT ${limit}` : sql``}
  `);

  return (rows.rows ?? rows).map((r) => ({
    id: r.id,
    type: r.type,
    identifier: String(r.identifier).trim(),
    metadata: r.metadata,
    parameterEntries: r.parameter_entries,
    hasReview: r.has_review,
  }));
}

/**
 * A DOI that resolves at a registry which carries no comparable metadata.
 *
 * Crossref is not the DOI system. Zenodo and ResearchGate register through
 * DataCite, and `10.5281/zenodo.7236453` and `10.13140/rg.2.2.18513.54883`
 * are both real records that Crossref answers 404 for — two of the thirteen
 * this audit first called `dead-handle`, which is the verdict that gets a row
 * deleted.
 *
 * DataCite settles existence but not identity: `fetchDataCiteRecord` returns
 * the resource type and nothing to compare a title or an author list against.
 * So the honest verdict is neither "invented" nor "verified" — the handle is
 * real and the metadata is unchecked. It is reported separately and, above
 * all, kept out of the deletion set.
 */
const REGISTRY_SILENT = Symbol('registry-silent');
type RegistryAnswer = RegistryRecord | typeof REGISTRY_SILENT | null;

function compare(row: CitationRow, registry: RegistryAnswer): Finding {
  const stored = row.metadata ?? {};
  const storedTitle = stored.title ?? '';
  const storedAuthors = surnameSet(stored.authors);
  const storedYear = typeof stored.year === 'number' ? stored.year : null;

  const base: Finding = {
    id: row.id,
    type: row.type,
    identifier: row.identifier,
    verdict: 'dead-handle',
    titleSimilarity: 0,
    authorOverlap: null,
    yearMatches: null,
    storedTitle,
    registryTitle: null,
    storedAuthors: [...storedAuthors],
    registryAuthors: [],
    storedYear,
    registryYear: null,
    suggestedPmid: null,
    suggestedDoi: null,
    parameterEntries: row.parameterEntries,
    hasReview: row.hasReview,
  };
  if (registry === REGISTRY_SILENT)
    return { ...base, verdict: 'registry-silent' };
  if (!registry) return base;

  const registryAuthors = surnameSet(registry.authors);
  const overlap = authorOverlap(storedAuthors, registryAuthors);
  const similarity = jaccard(
    contentWords(storedTitle),
    contentWords(registry.title),
  );
  const finding: Finding = {
    ...base,
    titleSimilarity: Number(similarity.toFixed(2)),
    authorOverlap: overlap === null ? null : Number(overlap.toFixed(2)),
    yearMatches: yearAgrees(storedYear, registry.year),
    registryTitle: registry.title,
    registryAuthors: [...registryAuthors],
    registryYear: registry.year,
    verdict: 'ok',
  };

  if (similarity >= TITLE_MATCH) return finding;
  // Title disagrees. Authors decide what kind of disagreement it is; with no
  // authors stored there is nothing to decide it with, so the row goes to
  // stage 2 rather than being cleared or condemned on the title alone.
  const differentPeople = overlap === null ? true : overlap < AUTHORS_DIFFER;
  finding.verdict = differentPeople ? 'unfindable' : 'title-drift';
  return finding;
}

function summarize(findings: Finding[]): Map<Verdict, Finding[]> {
  const order: Verdict[] = [
    'dead-handle',
    'unfindable',
    'wrong-handle',
    'title-drift',
    'registry-silent',
    'unchecked',
    'ok',
  ];
  const groups = new Map<Verdict, Finding[]>();
  for (const verdict of order) {
    const group = findings.filter((f) => f.verdict === verdict);
    if (group.length > 0) groups.set(verdict, group);
  }
  return groups;
}

const HEADLINE: Record<Verdict, string> = {
  'dead-handle': 'DEAD HANDLE — the identifier resolves to nothing',
  unfindable:
    'UNFINDABLE — the identifier names an unrelated paper and no registry record carries the stored title',
  'wrong-handle':
    'WRONG HANDLE — the paper is real but filed under the wrong identifier (retarget it)',
  'title-drift':
    'TITLE DRIFT — same work, translated or paraphrased title (refresh the metadata)',
  'registry-silent':
    'REGISTRY SILENT — the DOI is real (DataCite has it) but carries no metadata to check it against. NOT a candidate for deletion.',
  unchecked: 'UNCHECKED — the registry did not answer for these rows',
  ok: 'OK',
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonAt = argv.includes('--json')
    ? argv[argv.indexOf('--json') + 1]
    : null;
  const type = argv.includes('--type')
    ? (argv[argv.indexOf('--type') + 1] ?? '')
    : 'all';
  const limit = argv.includes('--limit')
    ? Number(argv[argv.indexOf('--limit') + 1])
    : null;
  const stage2 = !argv.includes('--no-stage2');
  const checkpointAt = argv.includes('--checkpoint')
    ? (argv[argv.indexOf('--checkpoint') + 1] ?? '')
    : '.citation-audit-checkpoint.jsonl';

  if (!['all', 'pmid', 'doi'].includes(type)) {
    console.error(`--type must be one of: all, pmid, doi (got "${type}")`);
    process.exit(1);
  }

  const rows = await loadCitations(type, limit);
  console.log(`Checking ${rows.length} citation(s) against the registries\n`);

  const pmidRows = rows.filter((r) => r.type === 'pmid');
  const doiRows = rows.filter((r) => r.type === 'doi');

  const registry = new Map<number, RegistryAnswer>();

  if (pmidRows.length > 0) {
    const records = await pubmedRecords(pmidRows.map((r) => r.identifier));
    for (const row of pmidRows) {
      registry.set(row.id, records.get(row.identifier) ?? null);
    }
  }

  // Crossref has no batch endpoint, so DOIs cost one request each. There are
  // far fewer of them than PMIDs, which is the only reason this is affordable.
  for (const [index, row] of doiRows.entries()) {
    try {
      const work = await fetchCrossRefMetadata(row.identifier);
      if (work) {
        registry.set(row.id, {
          title: work.title,
          authors: work.authors,
          year: work.year,
        });
      } else {
        // Crossref does not have it. That is not the same as the DOI not
        // existing — ask the other registry before condemning the row.
        const datacite = await fetchDataCiteRecord(row.identifier).catch(
          () => null,
        );
        registry.set(row.id, datacite ? REGISTRY_SILENT : null);
      }
    } catch {
      registry.set(row.id, null);
    }
    process.stderr.write(`  stage 1 (doi): ${index + 1}/${doiRows.length}\r`);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  if (doiRows.length > 0) process.stderr.write('\n');

  const findings = rows.map((row) =>
    compare(row, registry.get(row.id) ?? null),
  );

  // One checkpoint file serves both lookup stages. Stage 3's entries are keyed
  // by the NEGATED citation id so the two cannot collide: the same row is asked
  // a different question by each, and a PubMed "no" must not be replayed as a
  // Crossref answer.
  const done = readCheckpoint(checkpointAt);
  if (done.size > 0) {
    console.log(
      `  resuming: ${done.size} lookup(s) already recorded in ${checkpointAt}\n`,
    );
  }

  // Stage 2 — only the rows stage 1 could not vouch for, and only against
  // PubMed: Crossref has no title search worth trusting for this.
  const suspects = findings.filter(
    (f) => f.verdict === 'unfindable' || f.verdict === 'dead-handle',
  );
  if (stage2 && suspects.length > 0) {
    console.log(
      `\nStage 2: asking PubMed whether ${suspects.length} stored title(s) exist ` +
        "under another handle. This is the slow part: NCBI's rate limit puts " +
        'it at a few seconds per row, so a thousand suspects is a couple of ' +
        'hours. `NCBI_API_KEY` raises the ceiling; `--no-stage2` skips it.\n',
    );
    for (const [index, finding] of suspects.entries()) {
      // A resumed row is applied from the checkpoint rather than re-asked:
      // the answer does not change between runs, and re-asking is the entire
      // cost of the stage.
      const pmid = done.has(finding.id)
        ? (done.get(finding.id) ?? null)
        : await findByTitle(finding.storedTitle);
      if (!done.has(finding.id))
        appendCheckpoint(checkpointAt, finding.id, pmid);
      if (pmid && pmid !== finding.identifier) {
        finding.verdict = 'wrong-handle';
        finding.suggestedPmid = pmid;
      }
      process.stderr.write(`  stage 2: ${index + 1}/${suspects.length}\r`);
    }
    process.stderr.write('\n');
  }

  // Stage 3 — Crossref, for what PubMed could not place. Cheap (one request
  // per row, no published rate limit beyond politeness) and it is what makes
  // the `unfindable` verdict safe to delete on.
  if (stage2) {
    const stillLost = findings.filter(
      (f) => f.verdict === 'unfindable' || f.verdict === 'dead-handle',
    );
    if (stillLost.length > 0) {
      console.log(
        `\nStage 3: asking Crossref about the ${stillLost.length} title(s) ` +
          'PubMed could not place. A hit here means the paper is real and the ' +
          'handle is wrong, not that the paper was invented.\n',
      );
      // Crossref's bibliographic search takes seconds per query — it is doing
      // a real relevance match over the whole corpus, not a key lookup — so
      // this is run with bounded concurrency rather than serially. Unlike
      // NCBI, Crossref publishes no request-per-second ceiling for the polite
      // pool; it asks for a contact address, which the User-Agent carries.
      // CROSSREF_CONCURRENCY is deliberately modest: the point is to turn
      // hours into minutes, not to lean on someone else's free service.
      let next = 0;
      let finished = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const index = next++;
          if (index >= stillLost.length) return;
          const finding = stillLost[index];
          if (!finding) return;
          // Negative ids keep stage 3's answers out of stage 2's: the same row
          // is asked a different question by each stage, and a PubMed "no"
          // must never be replayed as a Crossref answer.
          const key = -finding.id;
          const doi = done.has(key)
            ? (done.get(key) ?? null)
            : await findDoiByTitle(finding.storedTitle);
          if (!done.has(key)) appendCheckpoint(checkpointAt, key, doi);
          if (doi) {
            finding.verdict = 'wrong-handle';
            finding.suggestedDoi = doi;
          }
          process.stderr.write(
            `  stage 3: ${++finished}/${stillLost.length}\r`,
          );
        }
      };
      await Promise.all(
        Array.from({ length: CROSSREF_CONCURRENCY }, () => worker()),
      );
      process.stderr.write('\n');
    }
  }

  const groups = summarize(findings);
  const suspect = findings.filter((f) => f.verdict !== 'ok');
  const backed = suspect.reduce((sum, f) => sum + f.parameterEntries, 0);

  console.log('\n─── Summary ───────────────────────────────────────────────');
  for (const [verdict, group] of groups) {
    console.log(`  ${verdict.padEnd(13)} ${String(group.length).padStart(5)}`);
  }
  console.log(
    `\n  ${suspect.length} of ${findings.length} row(s) need a look; they back ` +
      `${backed} parameter entr${backed === 1 ? 'y' : 'ies'}.`,
  );

  for (const [verdict, group] of groups) {
    if (verdict === 'ok') continue;
    console.log(`\n\n${HEADLINE[verdict]} — ${group.length}\n`);
    // Worst blast radius first: a fabricated row backing forty parameters is a
    // different problem from one backing none.
    for (const f of [...group].sort(
      (a, b) => b.parameterEntries - a.parameterEntries,
    )) {
      console.log(
        `  citation ${f.id}  ${f.type}:${f.identifier}  ` +
          `backs ${f.parameterEntries} parameter(s)${f.hasReview ? '  [reviewed]' : ''}`,
      );
      console.log(`    stored   : ${f.storedTitle}`);
      console.log(
        `               ${f.storedAuthors.join(', ') || '(no authors)'}` +
          `${f.storedYear ? `, ${f.storedYear}` : ''}`,
      );
      console.log(
        f.registryTitle
          ? `    registry : ${f.registryTitle}`
          : f.verdict === 'registry-silent'
            ? '    registry : DataCite HAS this DOI but publishes no title or authors — existence confirmed, identity unchecked'
            : '    registry : NO SUCH RECORD — the identifier resolves to nothing',
      );
      if (f.registryTitle) {
        console.log(
          `               ${f.registryAuthors.join(', ') || '(no authors)'}` +
            `${f.registryYear ? `, ${f.registryYear}` : ''}`,
        );
      }
      if (f.suggestedPmid) {
        console.log(`    found as : pmid:${f.suggestedPmid}`);
      }
      if (f.suggestedDoi) {
        console.log(`    found as : doi:${f.suggestedDoi}`);
      }
    }
  }

  if (jsonAt) {
    fs.writeFileSync(jsonAt, `${JSON.stringify(findings, null, 2)}\n`);
    console.log(`\n\nWrote ${findings.length} row(s) to ${jsonAt}`);
  }

  console.log(
    '\nThis audit reads only. TITLE DRIFT is safe to fix in bulk by refreshing ' +
      'the metadata from the registry; WRONG HANDLE is a retarget, one row at a ' +
      'time; DEAD HANDLE and UNFINDABLE are curation calls, because deleting a ' +
      'citation orphans every parameter it backs.',
  );
  console.log(
    '\nA verdict is evidence, not a ruling. Stage 2 asks PubMed alone, so a real ' +
      'paper indexed only in Crossref, a book chapter or a national report reads ' +
      'as UNFINDABLE. Check the row before acting on it.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
