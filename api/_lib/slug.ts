export function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 200);
}

/**
 * Best catalog slug for a receptor target described by a symbol and/or name.
 * The symbol is preferred, but symbols like "μ" consist entirely of characters
 * `generateSlug` strips, so fall back to the name when the symbol alone yields
 * an empty slug.
 */
export function targetSlug(
  symbol?: string | null,
  name?: string | null,
): string {
  return generateSlug(symbol ?? '') || generateSlug(name ?? '');
}
