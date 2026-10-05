/**
 * Coded revision summaries (not English prose) for the auto-generated
 * aggregate-cache revisions. Kept in a dependency-free module so the request
 * schemas can reserve the prefix without importing the database layer.
 */
export const CACHE_REVISION_CLEARED_CODE = 'auto:param_entries_cleared';
export const CACHE_REVISION_RECOMPUTED_CODE = 'auto:param_entries_recomputed';

/** Every cache-revision code starts with this; human edit summaries may not. */
export const CACHE_REVISION_RESERVED_PREFIX = 'auto:param_entries_';

export function isReservedEditSummary(value: string): boolean {
  return value.trimStart().toLowerCase().startsWith(CACHE_REVISION_RESERVED_PREFIX);
}
