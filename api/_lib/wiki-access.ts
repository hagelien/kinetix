import {
  CAP,
  NO_OVERRIDES,
  can,
  type PermissionOverrides,
} from "../../src/lib/permissions.js";

export interface WikiReadAuth {
  role: string;
}

/**
 * Published pages are public; drafts need the `wiki.draft.read` capability
 * (editor by default). Kept pure — callers pass the matrix they already
 * loaded — so this stays usable from tests and non-request contexts.
 */
export function canReadWikiPageStatus(
  status: string | null | undefined,
  auth: WikiReadAuth | null,
  overrides: PermissionOverrides = NO_OVERRIDES,
): boolean {
  if (status === "published") {
    return true;
  }

  if (status !== "draft") {
    return false;
  }

  return can(auth?.role, CAP["wiki.draft.read"], overrides);
}
