export type FactDiscussionTargetKey = `fact:${string}`;
export type DiscussionTargetKey = string | FactDiscussionTargetKey;

const FACT_TARGET_PREFIX = 'fact:';
const MAX_FACT_ID_LENGTH = 64;

function isSupportedFactId(factId: string): boolean {
  return (
    factId.length > 0 &&
    factId.length <= MAX_FACT_ID_LENGTH &&
    factId.trim().length > 0
  );
}

export function discussionTargetForFact(
  factId: string,
): FactDiscussionTargetKey {
  return `${FACT_TARGET_PREFIX}${factId}`;
}

export function factIdFromDiscussionTarget(target: string): string | null {
  if (!target.startsWith(FACT_TARGET_PREFIX)) return null;
  const factId = target.slice(FACT_TARGET_PREFIX.length);
  return isSupportedFactId(factId) ? factId : null;
}

export function isFactDiscussionTargetKey(
  target: string,
): target is FactDiscussionTargetKey {
  return factIdFromDiscussionTarget(target) !== null;
}

/**
 * Which host a discussion thread hangs off. Drug monographs key by `drugId`;
 * topic (non-monograph) wiki pages key by `wikiPageId`. Exactly one is set —
 * the same drug-XOR-page invariant the API and DB CHECK enforce.
 */
export type DiscussionHost = { drugId: number } | { wikiPageId: number };

/** Serialize a {@link DiscussionHost} into the `drugId`/`wikiPageId` query param. */
export function discussionHostParams(host: DiscussionHost): URLSearchParams {
  return new URLSearchParams(
    'drugId' in host
      ? { drugId: String(host.drugId) }
      : { wikiPageId: String(host.wikiPageId) },
  );
}
