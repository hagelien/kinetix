/**
 * Decide which citation an inbox PDF belongs to.
 *
 * `pdf-identifiers.ts` reads what the file claims about itself; this module
 * turns those claims into citation rows and says how much weight the answer
 * can carry. The split matters because the two failure modes are different: a
 * missed identifier costs a human thirty seconds of looking, while a *wrong*
 * attachment silently binds a paper's full text to another paper's citation —
 * and the review gate (`paper_reviews.read_in_full`) then lets facts be
 * written from a document nobody checked the identity of.
 *
 * So the rule throughout is: an identifier may only settle the question when
 * it resolves to exactly ONE citation, and everything else is a suggestion
 * presented to a person (or an agent) to confirm.
 */
import { sql } from 'drizzle-orm';
import { getDb } from './db.js';
import type { ExtractedIdentifiers } from './pdf-identifiers.js';

type Db = ReturnType<typeof getDb>;

/**
 * How the file was tied to a citation, strongest first. Carried per candidate
 * so a reviewer sees not just *which* citation but *why* — a DOI stamped in
 * the document and a title that merely looks similar are not the same claim.
 */
export type MatchVia = 'doi' | 'pmid' | 'pmcid' | 'title';

export interface MatchCandidate {
  citationId: number;
  via: MatchVia;
  /** 0–1. Exactly 1 for an identifier hit; the similarity score for a title. */
  score: number;
  /** Denormalised for display so the queue renders without a second query. */
  citationType: string;
  citationIdentifier: string;
  citationMetadata: unknown;
  /** Whether that citation already has full text on file. */
  hasPdf: boolean;
}

/**
 * How far a match may be trusted.
 *
 *   `exact`  — a registered identifier (DOI/PMID/PMCID) read from the file
 *              resolved to exactly one citation, and no other identifier in
 *              the file contradicted it. This is the ONLY tier that may
 *              attach without a person, because it is the only one where
 *              being wrong requires the *document itself* to be mislabelled.
 *   `strong` — one candidate, reached by a near-identical title, or by an
 *              identifier that resolved uniquely while another identifier in
 *              the same file pointed elsewhere. Shown pre-selected; a human
 *              or agent confirms.
 *   `weak`   — several candidates, or a loose title similarity. Shown as a
 *              list to choose from.
 *   `none`   — nothing resolved. The item waits; `action=rematch` reruns it,
 *              which matters because the citation corpus grows — a paper with
 *              no match today matches the moment somebody cites it.
 */
export type MatchConfidence = 'exact' | 'strong' | 'weak' | 'none';

export interface MatchResult {
  candidates: MatchCandidate[];
  confidence: MatchConfidence;
  /** The candidate an attach would act on, or null when there is nothing to act on. */
  citationId: number | null;
}

/**
 * Lowest trigram similarity a title match may report at all.
 *
 * Below this the "match" is two papers sharing a stock phrase
 * ("Pharmacokinetics of ... in healthy volunteers"), which is noise a
 * reviewer has to read and reject — worse than an empty candidate list,
 * because an empty list is honest about knowing nothing.
 */
const TITLE_MIN_SIMILARITY = 0.55;

/**
 * Similarity at which a lone title match is promoted from `weak` to `strong`.
 * Still never `exact`: two papers can share a title (a corrigendum, a
 * conference abstract and its full paper, a reprint), and no amount of string
 * similarity distinguishes them.
 */
const TITLE_STRONG_SIMILARITY = 0.9;

/** Most title candidates ever offered — beyond a handful nobody reads them. */
const TITLE_CANDIDATE_LIMIT = 5;

interface CitationLookupRow extends Record<string, unknown> {
  id: number;
  type: string;
  identifier: string;
  metadata: unknown;
  has_pdf: boolean;
  via: MatchVia;
  score: number;
}

/**
 * Find the citations an extracted set of identifiers points at.
 *
 * Identifier lookups run first and, when any of them hits, the title search is
 * skipped entirely: a registered identifier is a stronger statement than any
 * string comparison, and mixing a title near-miss into the same candidate list
 * only invites someone to pick it.
 *
 * Every identifier is looked up against both the citation's own handle
 * (`type` + `identifier`) and its `metadata.altIds` crosswalk, because
 * `citations` files one paper under exactly one handle — a paper known to this
 * database as a PMID is invisible to a DOI lookup that does not consult the
 * alt ids (see `src/lib/citationHandles.ts`).
 */
export async function matchInboxItem(
  db: Db,
  extracted: ExtractedIdentifiers,
): Promise<MatchResult> {
  const byIdentifier = await lookupByIdentifiers(db, extracted);
  if (byIdentifier.length > 0) {
    return gradeIdentifierMatches(byIdentifier, extracted);
  }
  if (extracted.title) {
    const byTitle = await lookupByTitle(db, extracted.title);
    return gradeTitleMatches(byTitle);
  }
  return { candidates: [], confidence: 'none', citationId: null };
}

async function lookupByIdentifiers(
  db: Db,
  extracted: ExtractedIdentifiers,
): Promise<MatchCandidate[]> {
  const { doi, pmid, pmcid } = extracted;
  if (!doi && !pmid && !pmcid) return [];

  // One statement for all three handles: the candidate set has to be deduped
  // across them anyway (a citation matching on both its DOI and its PMID is
  // one candidate, not two), and doing that in SQL keeps the "which handle
  // won" answer — `via` — decided by the same precedence the citation module
  // uses rather than by which query happened to return first.
  const result = await db.execute<CitationLookupRow>(sql`
    with wanted as (
      select
        ${doi ?? null}::text as doi,
        ${pmid ?? null}::text as pmid,
        ${pmcid ?? null}::text as pmcid
    ),
    hits as (
      select
        c.id,
        c.type,
        c.identifier,
        c.metadata,
        case
          when w.doi is not null
            and (
              (c.type = 'doi' and lower(c.identifier) = lower(w.doi))
              or lower(c.metadata -> 'altIds' ->> 'doi') = lower(w.doi)
            ) then 'doi'
          when w.pmid is not null
            and (
              (c.type = 'pmid' and c.identifier = w.pmid)
              or c.metadata -> 'altIds' ->> 'pmid' = w.pmid
            ) then 'pmid'
          else 'pmcid'
        end as via
      from citations c
      cross join wanted w
      where
        (
          w.doi is not null
          and (
            (c.type = 'doi' and lower(c.identifier) = lower(w.doi))
            or lower(c.metadata -> 'altIds' ->> 'doi') = lower(w.doi)
          )
        )
        or (
          w.pmid is not null
          and (
            (c.type = 'pmid' and c.identifier = w.pmid)
            or c.metadata -> 'altIds' ->> 'pmid' = w.pmid
          )
        )
        or (
          w.pmcid is not null
          and upper(c.metadata -> 'altIds' ->> 'pmcid') = upper(w.pmcid)
        )
    )
    select
      hits.id,
      hits.type,
      hits.identifier,
      hits.metadata,
      hits.via,
      1::float8 as score,
      exists (
        select 1 from citation_pdfs p where p.citation_id = hits.id
      ) as has_pdf
    from hits
    order by hits.id
  `);
  return toCandidates(result.rows ?? []);
}

/**
 * Title search, used only when no identifier resolved.
 *
 * Trigram similarity rather than equality because the titles this is compared
 * against come from three different metadata providers and a hand-typed
 * citation form: trailing full stops, `β` written as `beta`, a subtitle after
 * a colon, and the occasional truncation are all routine, and every one of
 * them defeats string equality on a pair of titles a person would call
 * identical.
 *
 * Deliberately not indexed: this runs once per *unmatched* inbox item, which
 * is a small fraction of a small queue, and a second trigram index on
 * `citations` would be paid for by every citation write. If the inbox ever
 * runs hot enough for this to matter, the fix is to index — not to weaken the
 * match.
 */
async function lookupByTitle(
  db: Db,
  title: string,
): Promise<MatchCandidate[]> {
  const result = await db.execute<CitationLookupRow>(sql`
    select
      c.id,
      c.type,
      c.identifier,
      c.metadata,
      'title'::text as via,
      similarity(lower(c.metadata ->> 'title'), lower(${title})) as score,
      exists (
        select 1 from citation_pdfs p where p.citation_id = c.id
      ) as has_pdf
    from citations c
    where c.metadata ->> 'title' is not null
      and c.type <> 'freetext'
      and similarity(lower(c.metadata ->> 'title'), lower(${title}))
          >= ${TITLE_MIN_SIMILARITY}
    order by score desc, c.id
    limit ${TITLE_CANDIDATE_LIMIT}
  `);
  return toCandidates(result.rows ?? []);
}

function toCandidates(rows: readonly CitationLookupRow[]): MatchCandidate[] {
  return rows.map((row) => ({
    citationId: Number(row.id),
    via: row.via,
    score: Number(row.score),
    citationType: row.type,
    citationIdentifier: row.identifier,
    citationMetadata: row.metadata ?? null,
    hasPdf: Boolean(row.has_pdf),
  }));
}

/**
 * Grade a set of identifier hits.
 *
 * Two citations matching one file is the interesting case, and it is not
 * hypothetical: the same paper can exist twice in `citations` when it was
 * entered under two handles before the crosswalk in `citationHandles.ts`
 * folded such pairs together, and a file can carry two *different* papers'
 * identifiers (a supplement stamped with the article's DOI, an erratum
 * carrying the original's). Neither case is safe to resolve automatically, and
 * they are not distinguishable from the PDF alone — so both drop to `weak` and
 * a person decides.
 */
function gradeIdentifierMatches(
  candidates: MatchCandidate[],
  extracted: ExtractedIdentifiers,
): MatchResult {
  if (candidates.length > 1) {
    return {
      candidates: rank(candidates),
      confidence: 'weak',
      citationId: null,
    };
  }
  const only = candidates[0];
  if (!only) return { candidates: [], confidence: 'none', citationId: null };

  // Only evidence that says *where in the document* it came from may settle an
  // identity unattended.
  //
  //   `filename` — a claim about what somebody named a download, not about
  //     what the document is. Usually right, occasionally catastrophic (a file
  //     renamed for the paper it was fetched beside), and nothing in the
  //     artifact corroborates it.
  //   `raw` — found loose in the uncompressed bytes, in no identified object.
  //     The likeliest thing living there is the reference list's link
  //     annotations, which are *other papers'* DOIs; taking one as the
  //     document's own would attach the file to a paper it merely cites.
  //
  // Both therefore propose and do not decide. `xmp` and `info` are what the
  // publisher wrote about this file, and `text` is read off the page ahead of
  // the reference section — those are claims about the document itself.
  const source = extracted.sources[only.via];
  if (source === 'filename' || source === 'raw') {
    return { candidates, confidence: 'strong', citationId: only.citationId };
  }
  return { candidates, confidence: 'exact', citationId: only.citationId };
}

function gradeTitleMatches(candidates: MatchCandidate[]): MatchResult {
  const best = candidates[0];
  if (!best) return { candidates: [], confidence: 'none', citationId: null };
  const unique =
    candidates.length === 1 ||
    // A clear winner is as good as a lone one; a tie between two papers with
    // near-identical titles is exactly the case a human must look at.
    (candidates[1] !== undefined && best.score - candidates[1].score >= 0.15);
  if (unique && best.score >= TITLE_STRONG_SIMILARITY) {
    return { candidates, confidence: 'strong', citationId: best.citationId };
  }
  return { candidates, confidence: 'weak', citationId: null };
}

function rank(candidates: MatchCandidate[]): MatchCandidate[] {
  const order: Record<MatchVia, number> = { doi: 0, pmid: 1, pmcid: 2, title: 3 };
  return [...candidates].sort(
    (a, b) => order[a.via] - order[b.via] || b.score - a.score || a.citationId - b.citationId,
  );
}

/**
 * Whether a graded match may be attached with nobody in the loop.
 *
 * Both halves are necessary. `exact` is the identity claim. "No PDF on file"
 * is the consequence claim: overwriting stored full text is editor-gated
 * everywhere else in this system precisely because it discards an asset and
 * invalidates the review written about it (`recordCitationPdf` flips
 * `read_in_full`), and a bulk drop must not be a side door around that. A
 * duplicate of a paper already on file therefore stops and waits, which is
 * also the right answer for the commonest cause — the same folder dropped
 * twice.
 */
export function mayAutoAttach(match: MatchResult): boolean {
  if (match.confidence !== 'exact' || match.citationId === null) return false;
  const chosen = match.candidates.find(
    (candidate) => candidate.citationId === match.citationId,
  );
  return chosen !== undefined && !chosen.hasPdf;
}
