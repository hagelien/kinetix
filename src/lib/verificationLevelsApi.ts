/**
 * Client helpers for GET /api/verification-levels. The level is a display
 * signal (see api/_lib/approvals.ts) — never gate agentic logic on it.
 */
import type { VerificationLevelInfo } from '@/lib/verificationLevel';

export type { VerificationLevelInfo } from '@/lib/verificationLevel';

async function fetchLevels(query: string): Promise<
  Record<string, VerificationLevelInfo>
> {
  const res = await fetch(`/api/verification-levels?${query}`);
  if (!res.ok) {
    // Levels are decorative; a failure should never break the page that
    // requested them. Callers treat an empty map as "no badges".
    return {};
  }
  const data = (await res.json()) as {
    levels?: Record<string, VerificationLevelInfo>;
  };
  return data.levels ?? {};
}

/** Per-parameter verification levels for a drug, keyed by parameter id. */
export function fetchParameterVerificationLevels(
  drugId: number,
): Promise<Record<string, VerificationLevelInfo>> {
  return fetchLevels(`drugId=${encodeURIComponent(String(drugId))}`);
}

/** Per-fact verification levels for a wiki page, keyed by factId. */
export function fetchFactVerificationLevels(
  wikiPageId: number,
): Promise<Record<string, VerificationLevelInfo>> {
  return fetchLevels(`wikiPageId=${encodeURIComponent(String(wikiPageId))}`);
}
