/**
 * PubMed tool definitions for the MCP server exposed at `api/mcp.ts`.
 *
 * Tools are narrow on purpose: one NCBI operation each, structured input,
 * structured output, and the exact query string echoed back so a claim can be
 * traced to the search that produced it.
 */

import { defineTool } from './mcp.js';
import {
  mcpExportCitationsSchema,
  mcpFetchAbstractsSchema,
  mcpFetchRecordsSchema,
  mcpPmcFullTextSchema,
  mcpRelatedArticlesSchema,
  mcpResolveIdentifierSchema,
  mcpSearchPubMedSchema,
} from './schemas.js';
import {
  fetchAbstracts,
  fetchPmcFullText,
  fetchRecords,
  findRelated,
  resolveIdentifiers,
  searchPubMed,
  type PubMedRecord,
} from './pubmed-eutils.js';

/**
 * Guidance handed to the model on `initialize`. It encodes the evidence rules
 * this project holds agents to (AGENTS.md): quote the query, keep PMIDs, and
 * never let an abstract stand in for a read-in-full source.
 */
export const PUBMED_SERVER_INSTRUCTIONS = [
  'Read-only access to PubMed and PMC via NCBI E-utilities.',
  '',
  'When reporting evidence from these tools:',
  '- Cite title, authors, journal, year, PMID and DOI when available.',
  '- Quote the exact query string returned in `query` so the search is reproducible.',
  '  It already contains the publication-type and date constraints, so re-running it',
  '  reproduces the result set; `sort` is the only constraint held separately, and',
  '  `translatedQuery` shows how PubMed expanded the terms (MeSH mapping, synonyms).',
  '- Distinguish abstract-level evidence from full-text evidence. An abstract does',
  '  not establish findings it does not state.',
  '- Prefer primary studies for quantitative pharmacokinetic values; identify reviews',
  '  as reviews.',
  '- Do not pool incompatible populations, matrices, routes or study designs.',
  '- `total` is the hit count for the query, not the number of records returned —',
  '  say so when results are truncated, and note that indexing and search phrasing',
  '  may leave relevant records unfound.',
  '- A non-empty `warnings` list means PubMed did not run the query as written: a',
  '  term or field was dropped, or a quoted phrase was not found and stopped',
  '  constraining the search. Read it before trusting the hit count, and report it',
  '  rather than presenting the results as an answer to the query you sent.',
].join('\n');

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

// ─── search_pubmed ──────────────────────────────────────────────────────────

const searchTool = defineTool({
  name: 'search_pubmed',
  title: 'Search PubMed',
  description:
    'Search PubMed and return structured records (PMID, title, authors, ' +
    'journal, year, DOI, PMCID, publication types) plus the total hit count ' +
    'and the query as PubMed translated it.',
  schema: mcpSearchPubMedSchema,
  annotations: readOnly,
  async execute(args) {
    const result = await searchPubMed({
      query: args.query,
      dateFrom: args.date_from ?? null,
      dateTo: args.date_to ?? null,
      articleTypes: args.article_types,
      maxResults: args.max_results,
      offset: args.offset,
      sort: args.sort,
    });

    return {
      structured: {
        // Self-contained: publication-type and date constraints are inside
        // the term, so re-running this string reproduces the result set. Sort
        // is the one thing it cannot carry, hence the separate field.
        query: result.query,
        translatedQuery: result.translatedQuery,
        sort: result.sort,
        total: result.total,
        returned: result.records.length,
        offset: result.offset,
        truncated: result.offset + result.records.length < result.total,
        warnings: result.warnings,
        records: result.records,
      },
    };
  },
});

// ─── fetch_pubmed_records ───────────────────────────────────────────────────

const fetchRecordsTool = defineTool({
  name: 'fetch_pubmed_records',
  title: 'Fetch PubMed records',
  description:
    'Fetch bibliographic metadata for known PMIDs. Returns the same record ' +
    'shape as search_pubmed. PMIDs that PubMed does not recognise are ' +
    'reported in `notFound` rather than silently dropped.',
  schema: mcpFetchRecordsSchema,
  annotations: readOnly,
  async execute(args) {
    const records = await fetchRecords(args.pmids);
    const found = new Set(records.map((r) => r.pmid));
    return {
      structured: {
        records,
        notFound: args.pmids.filter((pmid) => !found.has(pmid)),
      },
    };
  },
});

// ─── fetch_abstracts ────────────────────────────────────────────────────────

const fetchAbstractsTool = defineTool({
  name: 'fetch_abstracts',
  title: 'Fetch PubMed abstracts',
  description:
    'Retrieve abstracts plus MeSH terms and copyright statements for known ' +
    'PMIDs. `abstract` is null when PubMed indexes no abstract for the ' +
    'record — treat that as absent evidence, not as an empty finding.',
  schema: mcpFetchAbstractsSchema,
  annotations: readOnly,
  async execute(args) {
    const abstracts = await fetchAbstracts(args.pmids);
    const found = new Set(abstracts.map((a) => a.pmid));
    return {
      structured: {
        abstracts,
        withoutAbstract: abstracts
          .filter((a) => !a.abstract)
          .map((a) => a.pmid),
        notFound: args.pmids.filter((pmid) => !found.has(pmid)),
      },
    };
  },
});

// ─── find_related_articles ──────────────────────────────────────────────────

const relatedTool = defineTool({
  name: 'find_related_articles',
  title: 'Find related articles',
  description:
    "Return PubMed's computed neighbours for an article, ordered by " +
    'relatedness score. Useful for widening a search that started from one ' +
    'known paper.',
  schema: mcpRelatedArticlesSchema,
  annotations: readOnly,
  async execute(args) {
    const related = await findRelated(args.pmid, args.max_results);
    if (!args.include_metadata || related.length === 0) {
      return { structured: { seedPmid: args.pmid, related } };
    }

    const records = await fetchRecords(related.map((r) => r.pmid));
    const byPmid = new Map(records.map((r) => [r.pmid, r]));
    return {
      structured: {
        seedPmid: args.pmid,
        related: related.map((entry) => ({
          ...entry,
          record: byPmid.get(entry.pmid) ?? null,
        })),
      },
    };
  },
});

// ─── resolve_identifier ─────────────────────────────────────────────────────

const resolveTool = defineTool({
  name: 'resolve_identifier',
  title: 'Resolve article identifiers',
  description:
    'Convert between PMID, PMCID and DOI. Use this to attach a PMID to a ' +
    'DOI-only citation, or to discover whether an article has a PMC record ' +
    'before asking for full text. A DOI with no PMC record is looked up in ' +
    'PubMed directly, so absence from PMC does not mean absence from PubMed.',
  schema: mcpResolveIdentifierSchema,
  annotations: readOnly,
  async execute(args) {
    const resolved = await resolveIdentifiers(args.ids);
    return {
      structured: {
        resolved,
        unresolved: resolved
          .filter((r) => !r.pmid && !r.pmcid)
          .map((r) => ({ requestedId: r.requestedId, status: r.status })),
      },
    };
  },
});

// ─── fetch_pmc_full_text ────────────────────────────────────────────────────

const fullTextTool = defineTool({
  name: 'fetch_pmc_full_text',
  title: 'Fetch PMC full text',
  description:
    'Retrieve the full text of an article from the PMC open-access subset as ' +
    'plain text. Returns available=false for articles outside that subset. ' +
    'The rendering omits tables, figures and formulae, so values reported ' +
    'only in a table will not appear — do not treat this as a substitute for ' +
    'reading the published article.',
  schema: mcpPmcFullTextSchema,
  annotations: readOnly,
  async execute(args) {
    const { text, ...metadata } = await fetchPmcFullText(args.pmcid);
    // The article body goes in exactly one place. `McpServer.callTool` emits
    // both `structuredContent` and a text content block, so leaving the body
    // in the structured payload as well sent every full-text response twice —
    // 60 KB of wire and context for a 30 KB article.
    return {
      structured: { ...metadata, characters: text?.length ?? 0 },
      text: text ?? metadata.note,
    };
  },
});

// ─── export_citations ───────────────────────────────────────────────────────

const NAME_SUFFIXES = new Set([
  'jr',
  'sr',
  'ii',
  'iii',
  'iv',
  '2nd',
  '3rd',
  '4th',
]);

/**
 * "Mantinieks D" (PubMed's form) → `{ family: "Mantinieks", initials: "D" }`.
 *
 * PubMed writes initials as one to four bare capitals, which is what makes the
 * split decidable. Two kinds of name break a naive "last token is initials"
 * rule and both appear in real esummary output: generational suffixes
 * ("Smith AB Jr") and collective authors ("World Health Organization"). Neither
 * ends in a capitals-only token, so anything that does not match is treated as
 * part of the name and left whole.
 */
function splitAuthor(
  name: string,
  isCollective = false,
): {
  family: string;
  initials: string;
  suffix: string;
} {
  // esummary told us this is an organisation, so no heuristic is needed or
  // wanted — "Study Team ABC" ends in something indistinguishable from initials.
  if (isCollective) {
    return { family: name.trim(), initials: '', suffix: '' };
  }

  const parts = name.trim().split(/\s+/);

  let suffix = '';
  const last = parts[parts.length - 1];
  if (parts.length > 2 && last && NAME_SUFFIXES.has(last.toLowerCase())) {
    suffix = parts.pop() ?? '';
  }

  const candidate = parts[parts.length - 1];
  if (parts.length < 2 || !candidate || !/^[A-Z]{1,4}$/.test(candidate)) {
    return {
      family: [...parts, suffix].filter(Boolean).join(' '),
      initials: '',
      suffix: '',
    };
  }

  parts.pop();
  return { family: parts.join(' '), initials: candidate, suffix };
}

function vancouver(record: PubMedRecord): string {
  // Vancouver lists up to six authors before truncating with "et al."
  const authors =
    record.authors.length > 6
      ? `${record.authors.slice(0, 6).join(', ')}, et al`
      : record.authors.join(', ');
  const issue = record.issue ? `(${record.issue})` : '';
  const volume = record.volume ?? '';
  const pages = record.pages ? `:${record.pages}` : '';
  const locator = volume || issue || pages ? `;${volume}${issue}${pages}` : '';

  return [
    authors ? `${authors}.` : '',
    record.title ? `${record.title}` : '',
    record.journalAbbrev || record.journal
      ? `${record.journalAbbrev ?? record.journal}.`
      : '',
    record.year ? `${record.year}${locator}.` : '',
    record.doi ? `doi:${record.doi}.` : '',
    `PMID: ${record.pmid}.`,
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function apa(record: PubMedRecord): string {
  const collective = new Set(record.collectiveAuthors);
  const authors = record.authors.map((name) => {
    const { family, initials, suffix } = splitAuthor(name, collective.has(name));
    const dotted = initials
      .split('')
      .map((letter) => `${letter}.`)
      .join(' ');
    if (!dotted) return family;
    // APA places a generational suffix after the initials: "Smith, A. B., Jr."
    return suffix ? `${family}, ${dotted}, ${suffix}` : `${family}, ${dotted}`;
  });

  // APA 7 §9.8: with 21 or more authors, list the first 19, an ellipsis, then
  // the final author — and no ampersand. Biomedical collaborations routinely
  // run to hundreds of names, so this is the common case, not the exotic one.
  const last = authors[authors.length - 1] ?? '';
  const authorList =
    authors.length > 20
      ? `${authors.slice(0, 19).join(', ')}, ... ${last}`
      : authors.length > 1
        ? `${authors.slice(0, -1).join(', ')}, & ${last}`
        : (authors[0] ?? '');

  const issue = record.issue ? `(${record.issue})` : '';
  const locator = [record.volume ? `${record.volume}${issue}` : '', record.pages]
    .filter(Boolean)
    .join(', ');

  return [
    authorList ? `${authorList}` : '',
    `(${record.year ?? 'n.d.'}).`,
    record.title ? `${record.title}` : '',
    record.journal ? `${record.journal}${locator ? ', ' : '.'}` : '',
    locator ? `${locator}.` : '',
    record.doi ? `https://doi.org/${record.doi}` : '',
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const TEX_ESCAPES: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
};

/**
 * Escape TeX-reserved characters in a value that came from PubMed. `%` is the
 * dangerous one — it opens a comment, so an unescaped "50% of patients" in a
 * title silently swallows the rest of the line when the bibliography is
 * rendered. `&` in titles is common enough to hit in an ordinary sample.
 *
 * Single pass over a map, so the backslash replacement cannot be re-escaped by
 * a later rule.
 */
function escapeTex(value: string): string {
  return value.replace(/[\\{}&%$#_~^]/g, (char) => TEX_ESCAPES[char] ?? char);
}

/**
 * BibTeX parses an unpunctuated name as `First von Last`, so PubMed's
 * "Mantinieks D" would be filed and sorted under "D". The comma form
 * (`Last, Jr, First`) is unambiguous. A collective author has no initials to
 * split on and is braced instead, which stops BibTeX splitting it at all —
 * those braces are added after escaping, so they survive as grouping syntax
 * rather than being escaped into literal characters.
 */
function bibtexName(name: string, isCollective = false): string {
  const { family, initials, suffix } = splitAuthor(name, isCollective);
  const escapedFamily = escapeTex(family);
  if (!initials) return `{${escapedFamily}}`;
  const escapedInitials = escapeTex(initials);
  return suffix
    ? `${escapedFamily}, ${escapeTex(suffix)}, ${escapedInitials}`
    : `${escapedFamily}, ${escapedInitials}`;
}

function bibtex(record: PubMedRecord): string {
  const collective = new Set(record.collectiveAuthors);
  const firstAuthor = record.authors[0] ?? '';
  const { family } = splitAuthor(firstAuthor, collective.has(firstAuthor));
  const key = `${family.toLowerCase().replace(/[^a-z]/g, '') || 'pubmed'}${record.year ?? ''}pmid${record.pmid}`;
  const escaped = (value: string | null): string | null =>
    value ? escapeTex(value) : null;

  // A preprint exported as @article reads as peer-reviewed literature. The
  // entry type carries the distinction, and the note carries it into the
  // rendered bibliography where a reader will actually see it.
  const nonJournal = nonJournalType(record.publicationTypes);
  const entryType = nonJournal?.bibtex ?? 'article';

  const fields: Array<[string, string | null]> = [
    ['title', escaped(record.title || null)],
    // Already escaped per name by bibtexName, which adds its own braces after.
    [
      'author',
      record.authors
        .map((name) => bibtexName(name, collective.has(name)))
        .join(' and ') || null,
    ],
    ['journal', escaped(record.journal || null)],
    ['year', record.year ? String(record.year) : null],
    ['volume', escaped(record.volume)],
    ['number', escaped(record.issue)],
    ['pages', escaped(record.pages)],
    ['doi', escaped(record.doi)],
    ['pmid', record.pmid],
    ['note', nonJournal ? escapeTex(nonJournal.pubType) : null],
  ];

  const body = fields
    .filter(([, value]) => Boolean(value))
    .map(([name, value]) => `  ${name} = {${value}}`)
    .join(',\n');
  return `@${entryType}{${key},\n${body}\n}`;
}

/**
 * RIS `AU` is "Family, Initials". PubMed's space-separated form leaves a
 * reference manager to guess, and the usual guess is that the whole value is
 * the surname. Collective authors have no initials and are written unchanged.
 */
function risName(name: string, isCollective = false): string {
  const { family, initials, suffix } = splitAuthor(name, isCollective);
  if (!initials) return family;
  const dotted = initials
    .split('')
    .map((letter) => `${letter}.`)
    .join('');
  return suffix ? `${family}, ${dotted}, ${suffix}` : `${family}, ${dotted}`;
}

/**
 * RIS keeps the first and last page in separate fields, so "10-20" in `SP`
 * alone is either read as a start page of "10-20" or has its end silently
 * dropped.
 *
 * PubMed also abbreviates the closing page — "368-77" means 368 to 377 — so a
 * short end is expanded against the start's leading digits. Anything that is
 * not a plain numeric range (an e-locator like "e0234567", a supplement range
 * like "S1-S5") stays whole in `SP`, where it is at least not corrupted.
 */
function risPages(pages: string): { start: string; end: string | null } {
  const match = /^(\d+)\s*-\s*(\d+)$/.exec(pages.trim());
  if (!match) return { start: pages.trim(), end: null };

  const start = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  const end =
    rawEnd.length < start.length
      ? start.slice(0, start.length - rawEnd.length) + rawEnd
      : rawEnd;
  return { start, end };
}

/**
 * PubMed publication types that are not journal articles, with the reference
 * type each maps to in RIS and BibTeX. Ordered by specificity — a record
 * carries several types and the most specific one should win.
 *
 * Only types with real volume in PubMed are listed (checked against Entrez:
 * Preprint 66,529; Video-Audio Media 47,975; Newspaper Article 18,294; Dataset
 * 5,692; Technical Report 3,248). "Patent" and "Book Chapter" return zero hits
 * and are not PubMed publication types at all.
 *
 * Preprints matter most here: exporting one as a journal article hides exactly
 * the peer-review status this project asks agents to distinguish, which is why
 * the entry also carries the type through as a `note`.
 */
const NON_JOURNAL_TYPES: Array<{
  pubType: string;
  ris: string;
  bibtex: string;
}> = [
  { pubType: 'Dataset', ris: 'DATA', bibtex: 'misc' },
  { pubType: 'Preprint', ris: 'UNPB', bibtex: 'misc' },
  { pubType: 'Newspaper Article', ris: 'NEWS', bibtex: 'misc' },
  { pubType: 'Technical Report', ris: 'RPRT', bibtex: 'techreport' },
  { pubType: 'Video-Audio Media', ris: 'VIDEO', bibtex: 'misc' },
];

function nonJournalType(
  publicationTypes: string[],
): (typeof NON_JOURNAL_TYPES)[number] | null {
  const types = new Set(publicationTypes);
  return NON_JOURNAL_TYPES.find((entry) => types.has(entry.pubType)) ?? null;
}

function risType(publicationTypes: string[]): string {
  return nonJournalType(publicationTypes)?.ris ?? 'JOUR';
}

function ris(record: PubMedRecord): string {
  const lines = [`TY  - ${risType(record.publicationTypes)}`];
  const collective = new Set(record.collectiveAuthors);
  for (const author of record.authors) {
    lines.push(`AU  - ${risName(author, collective.has(author))}`);
  }
  if (record.title) lines.push(`TI  - ${record.title}`);
  if (record.journal) lines.push(`JO  - ${record.journal}`);
  if (record.year) lines.push(`PY  - ${record.year}`);
  if (record.volume) lines.push(`VL  - ${record.volume}`);
  if (record.issue) lines.push(`IS  - ${record.issue}`);
  if (record.pages) {
    const { start, end } = risPages(record.pages);
    lines.push(`SP  - ${start}`);
    if (end) lines.push(`EP  - ${end}`);
  }
  if (record.doi) lines.push(`DO  - ${record.doi}`);
  lines.push(`AN  - ${record.pmid}`);
  lines.push(`UR  - ${record.url}`);
  lines.push('ER  - ');
  return lines.join('\n');
}

const FORMATTERS: Record<string, (record: PubMedRecord) => string> = {
  vancouver,
  apa,
  bibtex,
  ris,
};

const exportTool = defineTool({
  name: 'export_citations',
  title: 'Export citations',
  description:
    'Format known PMIDs as Vancouver, APA, BibTeX or RIS citation strings.',
  schema: mcpExportCitationsSchema,
  annotations: readOnly,
  async execute(args) {
    const records = await fetchRecords(args.pmids);
    const format = FORMATTERS[args.format];
    if (!format) throw new Error(`Unsupported citation format: ${args.format}`);

    const citations = records.map((record) => ({
      pmid: record.pmid,
      citation: format(record),
    }));
    const found = new Set(records.map((r) => r.pmid));
    const notFound = args.pmids.filter((pmid) => !found.has(pmid));

    // The missing PMIDs belong in the text block too. Without them a client
    // reading only the content block sees fewer citations than it asked for
    // with no explanation — and if every PMID is unknown, an empty block.
    const missingNote =
      notFound.length > 0
        ? `Not found in PubMed, no citation produced: ${notFound.join(', ')}`
        : null;

    return {
      structured: {
        format: args.format,
        citations,
        notFound,
      },
      // Every entry carries its PMID even in the text block. Only Vancouver
      // puts one inside the citation string, so a client that reads just the
      // content block — which is the only block MCP guarantees — would
      // otherwise get APA output with the identifier this project requires
      // agents to keep stripped out of it.
      text: [
        ...citations.map((c) => `PMID ${c.pmid}\n${c.citation}`),
        ...(missingNote ? [missingNote] : []),
      ].join('\n\n'),
    };
  },
});

export const PUBMED_TOOLS = [
  searchTool,
  fetchRecordsTool,
  fetchAbstractsTool,
  relatedTool,
  resolveTool,
  fullTextTool,
  exportTool,
];

/** Exported for tests. */
export const CITATION_FORMATTERS = FORMATTERS;
