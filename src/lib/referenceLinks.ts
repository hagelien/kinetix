/**
 * Find cross-references in free text written by agents and reviewers — edit
 * summaries, return notes, dispute reasons — so the reader can open what they
 * point at instead of taking "per discussion #1379" on trust.
 *
 * Recognised (case-insensitive, Norwegian and English, as agents write both):
 *   - discussion comments: `diskusjon #N`, `diskusjonen #N`, `discussion #N`,
 *     `drug_discussion N`
 *   - disputes: `bestridelse #N`, `innsigelse #N`, `dispute #N`
 *   - pending edits: `pending_edit N`, `pending edit #N`, `endringsforslag #N`
 *
 * Plain words need the `#` so ordinary prose ("discussion 2 of the paper")
 * is left alone; the snake_case table names agents copy from the API are
 * unambiguous and match with or without it.
 */

export type ReferenceKind = 'discussion' | 'dispute' | 'pending_edit';

export type ReferenceSegment =
  | { type: 'text'; text: string }
  | { type: 'ref'; kind: ReferenceKind; id: number; text: string };

const PATTERN = new RegExp(
  [
    // Snake_case table names: `#` optional.
    String.raw`\b(?<discTable>drug_discussion)\s*#?\s*(?<discTableId>\d+)`,
    String.raw`\b(?<peTable>pending_edit)\s*#?\s*(?<peTableId>\d+)`,
    // Words: `#` required.
    String.raw`\b(?<disc>diskusjon(?:en|str[åa]d(?:en)?)?|discussion(?:\s+thread)?)\s*#(?<discId>\d+)`,
    String.raw`\b(?<disp>bestridelse(?:n|r)?|innsigelse(?:n|r)?|dispute)\s*#(?<dispId>\d+)`,
    String.raw`\b(?<pe>pending\s+edit|endringsforslag(?:et)?)\s*#(?<peId>\d+)`,
  ].join('|'),
  'giu',
);

export function parseReferences(text: string): ReferenceSegment[] {
  const out: ReferenceSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(PATTERN)) {
    const g = m.groups ?? {};
    const rawId =
      g.discTableId ?? g.discId ?? g.dispId ?? g.peTableId ?? g.peId;
    const id = Number(rawId);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const kind: ReferenceKind =
      g.discTableId !== undefined || g.discId !== undefined
        ? 'discussion'
        : g.dispId !== undefined
          ? 'dispute'
          : 'pending_edit';
    const start = m.index ?? 0;
    if (start > last) out.push({ type: 'text', text: text.slice(last, start) });
    out.push({ type: 'ref', kind, id, text: m[0] });
    last = start + m[0].length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

/** In-app link for a pending edit, regardless of its current status. */
export function pendingEditHref(id: number): string {
  return `/review?id=${id}&status=all`;
}
