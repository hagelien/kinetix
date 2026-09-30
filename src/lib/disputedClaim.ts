/**
 * Pure text helpers for the "quote the claim" rule on dispute verdicts
 * (issue #1357). The server-side check lives in api/_lib/disputed-claim.ts;
 * these are split out so the shared request schema can use them without
 * pulling in the database layer.
 */

/** Shortest quote accepted, after normalisation. Long enough that a bare
 * number ("8.17") or a single word cannot stand in for the claim it sits in. */
export const DISPUTED_CLAIM_MIN_CHARS = 12;
export const DISPUTED_CLAIM_MAX_CHARS = 1000;

/**
 * Canonical form for comparing a quote against target text: Unicode-folded,
 * lower-cased, typographic quotes/dashes made plain, whitespace collapsed.
 * Deliberately no fuzzier than that — the point is that the passage exists.
 */
export function normalizeClaimText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every string/number leaf of a row, including inside jsonb columns, as
 * separate text blocks. A quote may not straddle two fields; each block is
 * matched on its own.
 *
 * A leaf under a named field is also offered as `field: value`, so a short
 * structured value is quotable with its label — `newValue: 8.17` — when the
 * bare value alone (`8.17`) is below the minimum length. Without the label a
 * revision carrying only a parameter id and a number could not be disputed at
 * all.
 */
export function collectTextBlocks(
  value: unknown,
  out: string[] = [],
  key?: string,
): string[] {
  if (value == null) return out;
  if (key !== undefined && isIdentifierKey(key)) return out;
  if (typeof value === 'string' && UUID_RE.test(value.trim())) return out;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    const text = String(value);
    out.push(text);
    if (key !== undefined) out.push(`${key}: ${text}`);
  } else if (value instanceof Date) {
    // Timestamps are never the claim under dispute.
  } else if (Array.isArray(value)) {
    for (const v of value) collectTextBlocks(v, out, key);
  } else if (typeof value === 'object') {
    const node = value as Record<string, unknown>;
    if (isRichTextNode(node)) {
      collectRichText(node, out);
      return out;
    }
    for (const [k, v] of Object.entries(node)) {
      collectTextBlocks(v, out, k);
    }
  }
  return out;
}

/**
 * Identifier keys (`id`, `factId`, `referenceIds`, `drug_id`) name records,
 * never make a claim. A `wiki_fact` remove or reorder stores the server's
 * fact UUID in `proposedValue`; without this, `factId: <uuid>` would be
 * long enough to "quote" and still block consensus as a dispute.
 */
function isIdentifierKey(key: string): boolean {
  return /^(id|ids|uuid)$|(Id|Ids|_id|_ids|Uuid)$/.test(key);
}

/** A bare UUID is an identifier wherever it sits. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The keys a TipTap/ProseMirror node may carry. */
const RICH_TEXT_NODE_KEYS = new Set(['type', 'attrs', 'content', 'text', 'marks']);

/**
 * A TipTap/ProseMirror node: a string `type` and nothing but node keys. Leaf
 * nodes (`horizontalRule`, `hardBreak`, an image) carry neither `content` nor
 * `text`, and still must not expose `type: horizontalRule` as a quotable
 * claim, so the shape decides, not the presence of text.
 */
function isRichTextNode(node: Record<string, unknown>): boolean {
  return (
    typeof node.type === 'string' &&
    Object.keys(node).every((k) => RICH_TEXT_NODE_KEYS.has(k))
  );
}

/**
 * Rich text contributes only what a reader sees. One rendered sentence is
 * split into adjacent text nodes at every mark boundary — `pKa ` then bold
 * `8.17` — so each node's rendered text is a block, down to the individual
 * paragraphs. Node types, marks and attrs (`type: paragraph`) are structure,
 * never a claim, so they are not matchable.
 */
function collectRichText(node: Record<string, unknown>, out: string[]): void {
  const rendered = renderedText(node);
  if (rendered) out.push(rendered);
  if (Array.isArray(node.content)) {
    for (const child of node.content) {
      if (child != null && typeof child === 'object') {
        collectRichText(child as Record<string, unknown>, out);
      }
    }
  }
}

/** The concatenated `text` of a rich-text subtree, in document order. */
function renderedText(node: unknown): string {
  if (node == null || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;
  // A hard break renders as a line break; without a separator the words on
  // either side would run together and a sentence crossing it could never be
  // quoted as a reader sees it.
  if (n.type === 'hardBreak') return ' ';
  let text = typeof n.text === 'string' ? n.text : '';
  if (Array.isArray(n.content)) {
    for (const child of n.content) text += renderedText(child);
  }
  return text;
}

/**
 * The columns of each target's source row that carry the claim under review.
 * Only these are matchable: row metadata (`status`, ids, author, timestamps)
 * would otherwise let a dispute "quote" `status: pending` instead of the
 * passage it objects to, and still block consensus as though it had named one.
 * A target type missing here has nothing quotable, so it cannot be disputed
 * until its claim fields are listed.
 */
export const CLAIM_FIELDS: Readonly<Record<string, readonly string[]>> = {
  pending_edit: ['parameter', 'proposedValue', 'proposedMeta', 'factStatement'],
  paper_review: [
    'reviewMarkdown',
    'overallScore',
    'conclusionSupport',
    'reviewConfidence',
    'readInFull',
  ],
  wiki_revision: ['content', 'editSummary'],
  drug_parameter_revision: ['parameter', 'newValue', 'editSummary'],
  drug_discussion: ['parameter', 'body'],
  // Not yet accepted by the verdict schema, but listed so the type cannot
  // become undisputable the day it is.
  learning_unit_revision: ['content', 'editSummary'],
};

/**
 * The `pending_edits.proposed_meta` keys that carry proposal content a reviewer
 * can contest — the quote the value was read off, the submitter's summary,
 * titles and bibliographic details. Everything else in that column is
 * bookkeeping written by the server or an importer (`revisedAt`, the
 * `conflict` marker, `idempotencyKey`, `unverifiedSourceKeys`, ids, slugs,
 * commit refs) and is never a claim, so it is not matchable. An allowlist, not
 * a denylist: a new bookkeeping key must not silently become quotable.
 */
export const PROPOSED_META_CLAIM_KEYS: readonly string[] = [
  'sourceQuote',
  'editSummary',
  'title',
  'titleNb',
  'titleEn',
  'name',
  'symbol',
  'newDrug',
  'parameters',
  'authors',
  'journal',
  'year',
  'volume',
  'pages',
  'domains',
  'difficulty',
];

/** The matchable text blocks of a target row: its claim-bearing fields only. */
export function claimTextBlocks(
  targetType: string,
  row: Record<string, unknown>,
): string[] {
  const out: string[] = [];
  for (const field of CLAIM_FIELDS[targetType] ?? []) {
    let value = row[field];
    if (
      field === 'proposedMeta' &&
      value != null &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      const meta = value as Record<string, unknown>;
      value = Object.fromEntries(
        PROPOSED_META_CLAIM_KEYS.filter((key) => key in meta).map((key) => [
          key,
          meta[key],
        ]),
      );
    }
    collectTextBlocks(value, out, field);
  }
  return out;
}

/** True when the normalised quote occurs inside one of the text blocks. */
export function claimAppearsIn(claim: string, blocks: readonly string[]): boolean {
  const needle = normalizeClaimText(claim);
  if (needle.length === 0) return false;
  return blocks.some((b) => normalizeClaimText(b).includes(needle));
}

/** Stored heading for the quoted claim; Norwegian (bokmål), like the rationale. */
export const DISPUTED_CLAIM_HEADING = 'Bestridt påstand';

/**
 * The rationale as stored: the quoted claim leads, so the moderator and any
 * later adjudicator see exactly which passage the dispute is about. The
 * heading is stored, reader-facing prose, so it is Norwegian like the rest of
 * the rationale.
 */
export function rationaleWithDisputedClaim(claim: string, rationaleMd: string): string {
  const quoted = claim
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
  return `**${DISPUTED_CLAIM_HEADING}:**\n${quoted}\n\n${rationaleMd}`;
}
