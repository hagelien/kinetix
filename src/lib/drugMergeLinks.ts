/**
 * Rewriting internal wiki links that point at a drug whose monograph is about
 * to disappear in a merge (#admin-drug-merge).
 *
 * When two catalog entries for one substance are merged, the loser's row and
 * its monograph `wiki_pages` row are deleted. Any prose elsewhere that linked
 * to that page — typically a precursor's or metabolite's monograph pointing at
 * the merged substance — would then render a broken link. A drug's monograph is
 * reachable by two href shapes (see `src/router.tsx`):
 *
 *   - `/wiki/drug/<drugId>`   the numeric drug-preview route, which redirects to
 *                             the monograph slug. Breaks once the drug row goes.
 *   - `/wiki/<monographSlug>` the monograph page's own wiki slug. Breaks once the
 *                             page row goes.
 *
 * These helpers rewrite both shapes from the loser to the winner. They are pure
 * so they can be unit-tested and reused for the JSON document (`content`), the
 * pre-rendered HTML (`content_html`) and queued edits
 * (`pending_edits.proposed_value`) alike — mirroring `rewriteCitationIdsInJson`
 * in `citationHandles.ts`, but keyed on `href` URL strings rather than numeric
 * id fields.
 */

export interface DrugLinkRewrite {
  fromId: number;
  toId: number;
  /** The loser monograph's wiki slug, if it has one. */
  fromSlug?: string | null;
  /** The winner monograph's wiki slug, if it has one. */
  toSlug?: string | null;
}

/**
 * Rewrite a single href if it targets the loser drug's monograph. Returns the
 * href unchanged when it does not.
 *
 * Boundary-aware on the numeric route: `/wiki/drug/11` must not be caught by a
 * rewrite of drug 1, so the id is matched only when the next character ends the
 * path or begins a query/fragment/segment. The slug rewrite matches the whole
 * first path segment after `/wiki/` for the same reason — a slug is never a
 * prefix of another slug by accident.
 */
export function rewriteDrugHref(href: string, r: DrugLinkRewrite): string {
  if (typeof href !== 'string' || href.length === 0) return href;

  // Numeric drug route: /wiki/drug/<id>(rest)
  const drugRoute = href.match(/^(\/wiki\/drug\/)(\d+)(.*)$/);
  if (drugRoute) {
    const id = Number(drugRoute[2]);
    const rest = drugRoute[3] ?? '';
    // Only a true id boundary — nothing, or a query/fragment/sub-path.
    if (id === r.fromId && (rest === '' || /^[/?#]/.test(rest))) {
      return `${drugRoute[1]}${r.toId}${rest}`;
    }
    return href;
  }

  // Slug route: /wiki/<slug>(rest). Skip the reserved /wiki/drug/… and
  // /wiki/entity/… namespaces (handled above / not drugs).
  if (r.fromSlug && r.toSlug) {
    const slugRoute = href.match(/^(\/wiki\/)([^/?#]+)(.*)$/);
    if (slugRoute) {
      const segment = slugRoute[2];
      const rest = slugRoute[3] ?? '';
      if (segment === r.fromSlug) {
        return `${slugRoute[1]}${r.toSlug}${rest}`;
      }
    }
  }

  return href;
}

/**
 * Walk a stored JSON document (TipTap doc) and rewrite every link mark whose
 * `href` targets the loser drug. Key-aware — only strings under an `href` key
 * are considered, so a drug id or slug that happens to appear as body text is
 * left alone.
 */
export function rewriteDrugLinksInJson<T>(
  value: T,
  r: DrugLinkRewrite,
): { value: T; changed: boolean } {
  let changed = false;

  const walk = (node: unknown, underHref: boolean): unknown => {
    if (Array.isArray(node)) {
      return node.map((item) => walk(item, underHref));
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(
        node as Record<string, unknown>,
      )) {
        out[key] = walk(child, key === 'href');
      }
      return out;
    }
    if (underHref && typeof node === 'string') {
      const next = rewriteDrugHref(node, r);
      if (next !== node) {
        changed = true;
        return next;
      }
    }
    return node;
  };

  return { value: walk(value, false) as T, changed };
}

/**
 * Every internal drug link inside a stored JSON document, as (kind, key) pairs:
 * `{ kind: 'id', key: 42 }` for `/wiki/drug/42` targets and
 * `{ kind: 'slug', key: 'mhd' }` for `/wiki/mhd` targets. Same key-aware walk
 * as `rewriteDrugLinksInJson` (only `href` string values), so free text that
 * happens to spell a slug is not extracted. Used at approval time to reject
 * a `wiki_page`/`wiki_fact`/`wiki_new` proposal whose content links to a drug
 * that has since been deleted by a merge — see the pending-edits approval
 * paths.
 */
export type DrugLinkRef = { kind: 'id'; key: number } | { kind: 'slug'; key: string };

export function extractDrugLinksFromJson(value: unknown): DrugLinkRef[] {
  const refs: DrugLinkRef[] = [];
  const walk = (node: unknown, underHref: boolean): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, underHref);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(
        node as Record<string, unknown>,
      )) {
        walk(child, key === 'href');
      }
      return;
    }
    if (underHref && typeof node === 'string') {
      const drugRoute = node.match(/^\/wiki\/drug\/(\d+)(.*)$/);
      if (drugRoute) {
        const id = Number(drugRoute[1]);
        const rest = drugRoute[2] ?? '';
        if (Number.isFinite(id) && (rest === '' || /^[/?#]/.test(rest))) {
          refs.push({ kind: 'id', key: id });
        }
        return;
      }
      const slugRoute = node.match(/^\/wiki\/([^/?#]+)(.*)$/);
      if (slugRoute) {
        // The reserved namespaces (`entity`, `drug`) aren't drug monograph
        // slugs; `drug` is already handled above.
        const segment = slugRoute[1] ?? '';
        if (segment && segment !== 'drug' && segment !== 'entity') {
          refs.push({ kind: 'slug', key: segment });
        }
      }
    }
  };
  walk(value, false);
  return refs;
}

/**
 * Rewrite drug links inside a pre-rendered HTML string (`content_html`). Only
 * `href="…"` attribute values are touched, so body text mentioning a path is
 * untouched. Both single- and double-quoted attributes are handled.
 */
export function rewriteDrugLinksInHtml(html: string, r: DrugLinkRewrite): {
  value: string;
  changed: boolean;
} {
  if (typeof html !== 'string' || html.length === 0) {
    return { value: html, changed: false };
  }
  let changed = false;
  const value = html.replace(
    /href=(["'])(.*?)\1/g,
    (match, quote: string, url: string) => {
      const next = rewriteDrugHref(url, r);
      if (next === url) return match;
      changed = true;
      return `href=${quote}${next}${quote}`;
    },
  );
  return { value, changed };
}
