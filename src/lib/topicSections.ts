/**
 * Helpers for the topic-page section model introduced by #310 phase 2 (#348).
 *
 * Drug monographs derive their section list from a fixed schema in
 * `monographSections.ts`. Topic pages don't have a schema — every page can
 * use whatever heading set its author chose. To anchor atomic facts
 * (`wiki_fact`) on topic pages we mint a stable `sectionId` into each
 * heading node (rendered as `data-section-id` via the
 * HeadingWithSectionId TipTap extension), and the splice / approval path
 * locates the right slice of the doc by matching that attribute.
 *
 * The `sectionId` is a kebab-case slug of the original heading text, with
 * a numeric suffix on collisions (`pharmacology`, `pharmacology-2`, ...).
 * The slug is minted once at migration time and persisted; renaming the
 * heading text afterwards leaves the id intact, so existing facts stay
 * anchored.
 */

// Match the API schema cap (`createPendingEditSchema` rejects sectionId
// strings longer than 40 chars). If we minted longer, the migration
// would happily persist a heading sectionId the API would then refuse
// every fact submission against.
const MAX_SLUG_LENGTH = 40;
// Reserved tail length for the collision suffix (`-NNN` covers up to
// the 999-collision pathological branch). Subtracted from the base so
// `${base}-${i}` always fits within MAX_SLUG_LENGTH.
const COLLISION_SUFFIX_RESERVE = 4;

/**
 * Convert a free-form heading title into a kebab-case sectionId slug. The
 * result is guaranteed to be non-empty (`'section'` is the fallback) and
 * to match {@link isValidTopicSectionId}.
 */
// Norwegian/Swedish/Danish characters don't decompose under NFKD
// (`\u00f8` U+00F8 is precomposed, not `o` + combining stroke), so we map
// them explicitly before normalising. The set is intentionally small \u2014
// only the ones our authors actually type.
const SCANDI_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\u00e5/g, 'a'],
  [/\u00f8/g, 'o'],
  [/\u00e6/g, 'ae'],
  [/\u00df/g, 'ss'],
];

export function slugifyHeadingText(text: string): string {
  let working = text.toLowerCase();
  for (const [pat, repl] of SCANDI_REPLACEMENTS) {
    working = working.replace(pat, repl);
  }
  const slug = working
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);
  return slug.length > 0 ? slug : 'section';
}

/**
 * Pick a sectionId for a heading whose text slugifies to `base`, avoiding
 * collisions with anything already in `taken`. Mutates `taken` so callers
 * can reuse the same set across an entire document.
 */
export function mintUniqueSectionId(
  text: string,
  taken: Set<string>,
): string {
  const base = slugifyHeadingText(text);
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  // Reserve room for the suffix so `${base}-${i}` stays within
  // MAX_SLUG_LENGTH and continues to satisfy SECTION_ID_PATTERN. Without
  // this, a heading that slugifies to exactly the cap would mint
  // colliding ids that the API schema then rejects on every fact
  // submission against the duplicate section.
  const truncated = base.slice(0, MAX_SLUG_LENGTH - COLLISION_SUFFIX_RESERVE).replace(/-+$/, '') ||
    base.slice(0, 1);
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${truncated}-${i}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  // Pathological fallback — 1000 collisions is not realistic, but we
  // never want to throw on author content.
  const fallback = `${truncated.slice(0, 1)}-${Date.now()}`.slice(0, MAX_SLUG_LENGTH);
  taken.add(fallback);
  return fallback;
}

const SECTION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,39})$/;

/**
 * Validates a topic-page sectionId at the API boundary. Mirrors the
 * shape that {@link slugifyHeadingText} produces, so tampered or
 * hand-crafted ids that would never appear in a heading attribute get
 * rejected before they can be stored on a `wiki_fact` pending edit.
 */
export function isValidTopicSectionId(id: string): boolean {
  return typeof id === 'string' && SECTION_ID_PATTERN.test(id);
}

// ─── Section extraction ─────────────────────────────────────────────────────

interface TipTapNode {
  type?: string;
  attrs?: Record<string, unknown> | null;
  content?: unknown[];
  text?: string;
  marks?: unknown[];
}

interface TipTapDocLike {
  content?: unknown[];
}

export interface TopicSection {
  sectionId: string;
  headingText: string;
  headingLevel: number;
  /**
   * Top-level nodes that belong to this section — every node between the
   * sectioning heading and the next heading carrying a `sectionId`.
   * Doesn't include the heading itself.
   */
  bodyContent: unknown[];
}

function asNode(value: unknown): TipTapNode | null {
  if (!value || typeof value !== 'object') return null;
  return value as TipTapNode;
}

function nodeText(node: TipTapNode): string {
  if (typeof node.text === 'string') return node.text;
  if (!Array.isArray(node.content)) return '';
  return node.content
    .map((child) => {
      const c = asNode(child);
      return c ? nodeText(c) : '';
    })
    .join('');
}

/**
 * Walk a topic-page TipTap doc and return one entry per heading carrying
 * a `sectionId` attribute. Pre-heading content (paragraphs above the
 * first sectioned heading) is ignored — those nodes belong to no section
 * and atomic facts can't anchor against them. Headings without a
 * `sectionId` (e.g. nested h3s inside a section's body) stay in their
 * parent section's `bodyContent`, which keeps splice anchoring tied to
 * the explicit attribute rather than heading level.
 */
export function extractTopicSections(
  doc: TipTapDocLike | null | undefined,
): TopicSection[] {
  const content = doc?.content ?? [];
  const sections: TopicSection[] = [];
  let current: TopicSection | null = null;

  for (const raw of content) {
    const node = asNode(raw);
    const sectionId =
      node?.type === 'heading' && node.attrs && typeof node.attrs.sectionId === 'string'
        ? (node.attrs.sectionId as string)
        : null;

    if (sectionId && node) {
      if (current) sections.push(current);
      current = {
        sectionId,
        headingText: nodeText(node),
        headingLevel:
          typeof node.attrs?.level === 'number' ? (node.attrs.level as number) : 1,
        bodyContent: [],
      };
    } else if (current) {
      current.bodyContent.push(raw);
    }
  }
  if (current) sections.push(current);
  return sections;
}

/** Convenience: just the sectionIds in document order. */
export function listTopicSectionIds(doc: TipTapDocLike | null | undefined): string[] {
  return extractTopicSections(doc).map((s) => s.sectionId);
}

// ─── One-shot migration helper ──────────────────────────────────────────────

/**
 * Mint stable `sectionId` attributes onto every top-level heading in
 * `doc` that doesn't already have one. Returns a new doc plus a flag
 * indicating whether anything changed (`false` means the input is
 * already fully sectioned and the caller can skip writing).
 *
 * Idempotent: existing sectionIds are left untouched and feed into the
 * uniqueness set so newly-minted ids never collide with them. Only
 * heading nodes at the top level of `doc.content` get sectionIds —
 * headings nested inside lists / blockquotes etc. stay vanilla, since
 * they wouldn't be section breaks in the rendered page anyway.
 */
export function mintTopicSectionIds(
  doc: TipTapDocLike | null | undefined,
): { doc: TipTapDocLike; changed: boolean } {
  if (!doc || !Array.isArray(doc.content)) {
    return { doc: doc ?? { content: [] }, changed: false };
  }

  // Two-pass walk so a new heading inserted *above* an already-
  // sectioned heading with the same text doesn't steal that section's
  // stable id.
  //
  // Pass 1 collects every valid existing id (first occurrence only) so
  // they're reserved verbatim regardless of position. Pass 2 walks
  // again, preserving valid existing ids the first time we encounter
  // each one and minting a fresh id for everything else — missing,
  // invalid (uppercase, spaces, over-cap, ...), or a later duplicate
  // of an already-preserved id.
  const taken = new Set<string>();
  for (const raw of doc.content) {
    const node = asNode(raw);
    if (!node || node.type !== 'heading') continue;
    const existing =
      node.attrs && typeof node.attrs.sectionId === 'string' && node.attrs.sectionId.length > 0
        ? node.attrs.sectionId
        : '';
    if (existing && isValidTopicSectionId(existing) && !taken.has(existing)) {
      taken.add(existing);
    }
  }

  const usedIds = new Set<string>();
  let changed = false;

  const nextContent = doc.content.map((raw) => {
    const node = asNode(raw);
    if (!node || node.type !== 'heading') return raw;

    const existing =
      node.attrs && typeof node.attrs.sectionId === 'string' && node.attrs.sectionId.length > 0
        ? node.attrs.sectionId
        : '';

    if (
      existing &&
      isValidTopicSectionId(existing) &&
      taken.has(existing) &&
      !usedIds.has(existing)
    ) {
      usedIds.add(existing);
      return raw;
    }

    // Either no id, invalid id, or a later duplicate of one we've
    // already preserved.
    const text = nodeText(node) || 'section';
    const sectionId = mintUniqueSectionId(text, taken);
    usedIds.add(sectionId);
    changed = true;
    return {
      ...node,
      attrs: { ...(node.attrs ?? {}), sectionId },
    };
  });

  if (!changed) return { doc, changed: false };
  return { doc: { ...doc, content: nextContent }, changed: true };
}
