import { createHash } from 'node:crypto';

type PendingEditReviewTokenInput = {
  id: number;
  editType: string;
  targetId: number | null;
  parameter: string | null;
  proposedValue: unknown;
  proposedMeta: unknown;
  referenceId: number | null;
  referenceIds: number[] | null;
  status: string;
  // Monotonic marker bumped on every (re)submission. Without it the token
  // repeats across a pending -> returned -> pending cycle when the payload is
  // unchanged (status returns to `pending` and the review fields are cleared),
  // letting a stale approve from a still-open reviewer tab pass the freshness
  // check after a return/resubmit the reviewer never saw (#592).
  submittedAt: Date | string | number | null;
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function pendingEditReviewToken(
  edit: PendingEditReviewTokenInput,
): string {
  return createHash('sha256')
    .update(
      stableStringify({
        id: edit.id,
        editType: edit.editType,
        targetId: edit.targetId,
        parameter: edit.parameter,
        proposedValue: edit.proposedValue,
        proposedMeta: edit.proposedMeta,
        referenceId: edit.referenceId,
        referenceIds: edit.referenceIds,
        status: edit.status,
        // Normalise to epoch ms so a Date (drizzle row) and an ISO string
        // (serialised row) hash identically.
        submittedAt:
          edit.submittedAt == null
            ? null
            : new Date(edit.submittedAt).getTime(),
      }),
    )
    .digest('base64url');
}

/**
 * Content identity of a pending edit's payload — what a reviewer would call
 * "the proposal itself", with everything the server manages around it removed.
 *
 * Distinct from the review token above, which deliberately also folds in
 * `status` and `submittedAt` so a return/resubmit cycle invalidates a stale
 * reviewer snapshot even when nothing changed. This one answers the opposite
 * question: *did the content actually change?* — which is what decides whether
 * a submitter's PATCH counts as a revision, and so whether it clears an upheld
 * objection against the old content. A PATCH that echoes the stored values
 * back verbatim produces the same fingerprint and is therefore no revision at
 * all, however many payload fields it carried.
 *
 * `revisedAt`, `returnedAt` and `conflict` are stripped from the meta: all are
 * written by the server (the revision and return markers and the
 * concurrent-approval flag), so their presence or absence says nothing about
 * what the author proposed.
 *
 * References are folded into one canonical list, because the same citation set
 * has two spellings: a legacy row holds `referenceId = N` with `referenceIds`
 * null, while a PATCH echoing that same `referenceId` back arrives as `[N]`.
 * Hashing the columns as stored would call that a revision — the singular is
 * the head of the list by construction, not an independent field.
 */
export function pendingEditPayloadFingerprint(payload: {
  proposedValue: unknown;
  proposedMeta: unknown;
  referenceId: number | null | undefined;
  referenceIds: number[] | null | undefined;
}): string {
  return stableStringify({
    proposedValue: payload.proposedValue ?? null,
    proposedMeta: stripServerManagedMeta(payload.proposedMeta),
    references: canonicalReferenceList(
      payload.referenceIds,
      payload.referenceId,
    ),
  });
}

/**
 * The citation set as a single ordered list. Order is content — the first id
 * is the primary reference — so it is preserved; only the empty/null/singular
 * spellings are collapsed. Mirrors `readEffectiveReferenceIds`, which resolves
 * the same ambiguity for the write path.
 */
function canonicalReferenceList(
  referenceIds: number[] | null | undefined,
  referenceId: number | null | undefined,
): number[] {
  if (referenceIds && referenceIds.length > 0) return referenceIds;
  return referenceId == null ? [] : [referenceId];
}

function stripServerManagedMeta(meta: unknown): unknown {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta))
    return meta ?? null;
  const rest: Record<string, unknown> = {
    ...(meta as Record<string, unknown>),
  };
  delete rest.revisedAt;
  delete rest.returnedAt;
  delete rest.conflict;
  return rest;
}

/**
 * True when a reviewer returned this edit (with a note, not a rewrite) and its
 * author has not revised the payload since (issue #1357).
 *
 * A comment-only return keeps the edit's agent verdicts, and a bare
 * `{status:'pending'}` resubmit keeps them too. Agent consensus must not then
 * publish the very content a human reviewer sent back, so it holds while the
 * server-managed `returnedAt` marker is newer than `revisedAt` — the same
 * "until a real revision" rule an upheld dispute follows.
 */
export function returnStandsUnrevised(proposedMeta: unknown): boolean {
  if (!proposedMeta || typeof proposedMeta !== 'object' || Array.isArray(proposedMeta)) {
    return false;
  }
  const meta = proposedMeta as Record<string, unknown>;
  if (typeof meta.returnedAt !== 'string') return false;
  const returned = Date.parse(meta.returnedAt);
  if (!Number.isFinite(returned)) return true;
  const revised =
    typeof meta.revisedAt === 'string' ? Date.parse(meta.revisedAt) : Number.NaN;
  return !Number.isFinite(revised) || revised <= returned;
}
