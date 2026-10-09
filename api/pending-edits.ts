import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb, inTransaction, runInPoolTransaction } from './_lib/db.js';
import {
  paramEntryPayloadParts,
  withParamEntryPayloadLocks,
  type ParamEntryLockedResult,
  type ParamEntryLockRefusal,
} from './_lib/param-entry-payload-locks.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import {
  createPendingEditSchema,
  patchPendingEditSchema,
  wikiSectionPayloadSchema,
} from './_lib/schemas.js';
import {
  pendingEdits,
  users,
  drugs,
  drugParameterRevisions,
  wikiPages,
  citations,
  citationPdfs,
  pdfRequests,
  agents,
  agentVerifications,
  disputes,
  bioEntities,
  paperReviews,
} from '../db/schema.js';
import {
  applyApprovedEdit,
  assertReferencesJudged,
  assertReferencesJudgedForActor,
  isReadInFullUnverified,
  PendingEditReviewTokenMismatchError,
  ReferenceGateError,
  WikiFactApprovalError,
} from './_lib/pending-edits-helpers.js';
import {
  pendingEditPayloadFingerprint,
  pendingEditReviewToken,
} from './_lib/pending-edit-review-token.js';
import { fireAgentHookForSubmitterAsync } from './_lib/agentHooks.js';
import {
  lockDrugForEntryApplicability,
  ParameterNotApplicableError,
} from './_lib/parameterApplicabilityStore.js';
import { resolveOwningDrugIdForMonograph } from './_lib/monograph-helpers.js';
import {
  ParameterApplyError,
  readParameterValue,
} from './_lib/drugs-helpers.js';
import { MetabolismWriteError } from './_lib/metabolismStore.js';
import { getDrugParametersByDrugIds } from './_lib/drugParameterStore.js';
import {
  getParameterEntryContentsByIds,
  type ParameterEntryContents,
} from './_lib/parameter-entries-store.js';
import { isDrugParameterId } from './_lib/drugParameterIds.js';
import {
  DRUG_PARAMETERS,
  isModelStructureParameter,
} from '../src/lib/drugParameters.js';
import {
  inspectParameterEntryPayload,
  canonicalSourceQuote,
  sourceQuoteComparisonKey,
  parameterEntryEditSchema,
  sourceQuoteEvidenceUnchanged,
} from '../src/lib/parameterEntries.js';
import { resolveDrugName } from '../src/lib/drugNames.js';
import { CAP, capabilityForEditType } from '../src/lib/permissions.js';
import {
  callerCan,
  callerCanReadWikiPage,
} from './_lib/permissions-store.js';
import { createFactNode } from '../src/lib/monographContent.js';
import { liveClaimCitationId } from './_lib/paper-extraction-store.js';
import {
  findFactInContent,
  isMonographContentV2,
  type FactLocation,
  type MonographContentV2,
  type MonographFactNode,
} from '../src/lib/monographContent.js';
import {
  getMonographField,
  isMonographSectionId,
  isMergedMonographFieldId,
} from '../src/lib/monographSections.js';
import {
  isValidTopicSectionId,
  listTopicSectionIds,
} from '../src/lib/topicSections.js';
import {
  hasOpenDispute,
  openDisputeTargetIds,
  unresolvedDisputeVerdictCount,
  unresolvedDisputeVerdictCounts,
  anyUpheldRulingStands,
  upheldDisputeResolvedAt,
  upheldDisputeStands,
  rebindOpenDisputesForUnrevisedResubmit,
} from './_lib/disputes.js';
import { verificationTargetVersion } from './_lib/verification-targets.js';
import {
  clearVerificationsForTarget,
  emptyVerificationSummary,
  isActiveAgentUser,
  isSelfReviewAgentUser,
  recordImplicitAgentApproval,
  resolveActiveAgent,
  summariseVerificationsForTargets,
  visibleVerificationTargetIds,
  type VerificationSummary,
} from './_lib/agent-verifications.js';
import {
  fireAndForgetMirror,
  mirrorProposalVersion,
} from './_lib/knowledge-governance/mirror.js';
import {
  wikiContentFocusRefusal,
  wikiTargetFocusRefusal,
} from './agent-focus.js';
import { consensusStatusForTargets } from './agent-verifications.js';
import {
  agentProposalLacksSourceQuote,
  SOURCE_QUOTE_REQUIRED_MESSAGE,
} from './_lib/source-quote-gate.js';
import { notifyEditDecisionAfterCommit } from './_lib/editDecisionNotifications.js';

type PendingEditRecord = typeof pendingEdits.$inferSelect;

async function isReviewer(role: string): Promise<boolean> {
  return callerCan(role, CAP['review.edit.decide']);
}

/** A cited categorical axis proposal whose approval changes the model family. */
function isModelStructureEdit(
  edit: Pick<PendingEditRecord, 'editType' | 'parameter'>,
): boolean {
  return (
    edit.editType === 'param_entry' &&
    typeof edit.parameter === 'string' &&
    isModelStructureParameter(edit.parameter)
  );
}

/**
 * True when a contestation stands against this pending edit, so a self-review
 * agent must not approve it — an objection is held for a person, and here the
 * only other party is the disputed edit's own author.
 *
 * Both sources are read because they are not the same set and each can outlive
 * the other by a write: an agent's `dispute` verdict is mirrored into the
 * unified `disputes` table by a *separate* statement in
 * POST /api/agent-verifications, and a human's dispute exists only in that
 * table with no verdict behind it. `applyOnAgentConsensus` covers the same
 * ground by pairing its quorum tally with a `hasOpenDispute` check; this is
 * that pair, on the route consensus does not run through.
 *
 * The verdict leg counts only verdicts a moderator has *not* ruled on
 * (`unresolvedDisputeVerdictCount`). Counting them raw made the block
 * unliftable: resolving the dispute closes the `disputes` row but cannot close
 * the verdict behind it, so the objection stayed in force with nothing left to
 * decide — the author was told to resolve a dispute already resolved.
 */
async function selfReviewBlockedByDispute(
  pendingEditId: number,
): Promise<boolean> {
  const [open, unresolvedVerdicts] = await Promise.all([
    hasOpenDispute({ targetType: 'pending_edit', targetId: pendingEditId }),
    unresolvedDisputeVerdictCount({
      targetType: 'pending_edit',
      targetId: pendingEditId,
    }),
  ]);
  return open || unresolvedVerdicts > 0;
}

/**
 * True when a moderator sustained an objection to this edit's current payload,
 * so its own author must not now approve it.
 *
 * Resolving a dispute lifts the "decide it first" block, but the two
 * resolutions do not mean the same thing: `rejected` overrules the objection
 * and frees the proposal, `upheld` says the objection was right and asks for a
 * return, a rejection or a revision. Reading only "is anything still open"
 * would let an author sustain the objection against their own edit and approve
 * it in the next click.
 *
 * It binds the payload, not the row: revising the proposal in response to the
 * ruling — the thing the ruling asked for — moves the edit out from under it
 * and a fresh verdict decides. The signal is the `revisedAt` marker rather
 * than `submittedAt`, because a bare `{status:'pending'}` re-stamps the latter
 * without changing the content, which would let an author clear the ruling by
 * resubmitting exactly what it was made against. Only self-*approval* is
 * blocked; returning the edit is the disposition an uphold points at, and
 * withdrawing it never needed a capability.
 */
async function selfApprovalBlockedByUpheldDispute(
  pendingEditId: number,
  proposedMeta: unknown,
): Promise<boolean> {
  return upheldDisputeStands({
    targetType: 'pending_edit',
    targetId: pendingEditId,
    revisedAt: payloadRevisedAt(proposedMeta),
  });
}

/**
 * When this edit's payload was last actually revised, per the marker the
 * submitter-update branch stamps. Not `submittedAt`, which a status-only
 * resubmit moves without changing the proposal.
 */
function payloadRevisedAt(proposedMeta: unknown): string | null {
  if (!isRecord(proposedMeta)) return null;
  return typeof proposedMeta.revisedAt === 'string'
    ? proposedMeta.revisedAt
    : null;
}

/** The server-stamped time of the last comment-only return, if any. */
function payloadReturnedAt(proposedMeta: unknown): string | null {
  if (!isRecord(proposedMeta)) return null;
  return typeof proposedMeta.returnedAt === 'string'
    ? proposedMeta.returnedAt
    : null;
}

/**
 * Client-supplied meta with the revision marker removed.
 *
 * `revisedAt` decides whether an upheld objection still stands, so it is the
 * server's to write and nobody else's. It also sits in the one field a client
 * hands over wholesale — and the payload fingerprint deliberately ignores it,
 * so a PATCH that changes *only* the marker is not a revision by any measure
 * yet would be persisted verbatim. Post-dating it would then clear a ruling
 * over content nobody touched. Every path that accepts `proposedMeta` strips
 * it here; the submitter branch is the only writer, and only when the payload
 * fingerprint actually moved.
 */
function withoutRevisionMarker(meta: unknown): unknown {
  if (!isRecord(meta)) return meta;
  if (!SERVER_OWNED_META_KEYS.some((key) => key in meta)) return meta;
  const rest = { ...meta };
  for (const key of SERVER_OWNED_META_KEYS) delete rest[key];
  return rest;
}

/**
 * `proposedMeta` keys only the server writes. `returnedAt` holds agent
 * consensus until the author revises (`returnStandsUnrevised`), and the
 * conversation-ingestion marker (`unverifiedReferenceIds`, with the bundle
 * keys beside it) holds it until the cited papers are read in full
 * (`pendingEditCitesUnreadSources`), so a client must not be able to clear
 * either — or forge one — by writing the key. Ingestion writes its marker
 * straight to the row, and a revision carries it over from the stored row
 * (`nextProposedMetaPreservingConflict`).
 */
const SERVER_OWNED_META_KEYS = [
  'revisedAt',
  'returnedAt',
  'unverifiedReferenceIds',
  'unverifiedSourceKeys',
] as const;

const SAFE_FACT_LINK_PROTOCOLS = new Set([
  'http:',
  'https:',
  'mailto:',
  'tel:',
]);

/**
 * A conditional revise/return update matched no row (status moved under it).
 * Thrown inside the transaction so nothing after the update commits.
 */
class SubmitterUpdateConflictError extends Error {
  constructor() {
    super('pending edit changed while the update was being saved');
    this.name = 'SubmitterUpdateConflictError';
  }
}

const PENDING_EDIT_UPDATE_CONFLICT =
  'This edit changed while your update was being saved; refresh and try again';

/**
 * Optimistic lock for a reviewer write: the row is still the one the reviewer
 * loaded, in the status they loaded it in, and its content has not been
 * revised since.
 *
 * The `reviewToken` check upstream compares against the row this request read,
 * which leaves the read→write gap: a submitter revision that commits inside it
 * would otherwise be returned or rejected on content the reviewer never saw.
 * A submitter revision always re-stamps `submitted_at` (it is what makes the
 * token change), so pinning that column closes the gap atomically. Approval
 * has its own re-check inside `applyApprovedEdit`.
 *
 * `submitted_at` cannot be compared with a plain equality: the DB `now()`
 * default stores microseconds while drizzle reads the column back as a
 * millisecond-truncated Date, so `eq(...)` never matches a freshly-submitted
 * row and would fail every review with a spurious conflict. Truncating both
 * sides to milliseconds compares them at the precision the app actually has.
 */
export function pendingEditReviewerLock(edit: {
  id: number;
  status: string;
  submittedAt: Date | null;
}) {
  const unchangedSince = edit.submittedAt;
  return and(
    eq(pendingEdits.id, edit.id),
    eq(pendingEdits.status, edit.status),
    ...(unchangedSince
      ? [
          sql`date_trunc('milliseconds', ${pendingEdits.submittedAt}) = ${unchangedSince}`,
        ]
      : []),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object');
}

// The `op` of a param_entry proposal. `targetId` on the pending row carries the
// drug id for a create and the entry id for update/delete, so enrichment resolves
// the drug differently per op.
function paramEntryOp(
  value: unknown,
): 'create' | 'update' | 'delete' | null {
  if (
    isRecord(value) &&
    (value.op === 'create' || value.op === 'update' || value.op === 'delete')
  ) {
    return value.op;
  }
  return null;
}

/**
 * The other substances a param_entry's dose context names — the one that was
 * dosed and the one it was given with (Cmax dose-context RFC) — read from a
 * proposal payload's `input`/`patch` or from a stored entry's `doseContext`.
 *
 * Resolved to names for the review card. A metabolite's Cmax is filed against
 * the metabolite while the dose belongs to its parent, so "administered:
 * substance #311" leaves the reviewer unable to check the one fact that makes
 * the reading interpretable without opening another tab.
 */
function doseContextDrugIds(fields: unknown): number[] {
  if (!isRecord(fields)) return [];
  const ids: number[] = [];
  for (const key of ['administeredDrugId', 'interactingDrugId'] as const) {
    const id = fields[key];
    if (typeof id === 'number' && Number.isInteger(id) && id > 0) ids.push(id);
  }
  return ids;
}

/** A param_entry proposal's field payload: the create's `input`, the update's `patch`. */
function paramEntryPayloadFields(value: unknown): unknown {
  if (!isRecord(value)) return null;
  if (value.op === 'create') return value.input;
  if (value.op === 'update') return value.patch;
  return null;
}

/**
 * True when a `wiki_new` draft carries parameter values. Approving one of
 * those publishes drug-parameter revisions, which is `edit.parameter.submit`'s
 * territory rather than the page approval's.
 */
export function hasParameterBag(proposedMeta: unknown): boolean {
  const bag = (proposedMeta as Record<string, unknown> | null)?.parameters;
  return Boolean(bag && typeof bag === 'object' && Object.keys(bag).length > 0);
}

function isWholePageEditType(editType: string): boolean {
  return editType === 'wiki_page' || editType === 'wiki_new';
}

/**
 * Drop a `param_entry` proposal's nested quote when the reading it is evidence
 * for was revised and the quote itself was not.
 *
 * The sibling below handles a `parameter` proposal, whose quote lives in
 * `proposed_meta` and is carried forward by the server. A `param_entry` keeps
 * its quote INSIDE the payload (`proposed_value.input.quote` /
 * `.patch.quote`), so the client resubmits it explicitly — which means the
 * server cannot tell "the author re-affirmed this sentence" from "the author
 * edited the number in a JSON dialog and left the rest alone" by presence
 * alone. It can tell by comparison: a quote identical to the stored one, on a
 * payload that otherwise changed, was not re-authored. Keeping it would let a
 * revised calculation-driving value publish behind words describing the value
 * it replaced, after a fresh round of consensus on the new payload.
 *
 * Only ever removes, and only when the rest of the payload actually moved. A
 * quote the author changed is theirs and is kept, whatever else moved with it.
 */
/**
 * Store a `param_entry` payload's nested quote in the form it will actually be
 * stored in.
 *
 * `/api/parameter-entries` parses its payload through `parameterEntryEditSchema`
 * — `quote` included — so a proposal queued there is canonical from the start.
 * The two generic paths that can REWRITE `proposedValue`, the submitter's
 * resubmit and the reviewer's return-with-changes, validated the payload and
 * then stored the ORIGINAL object, so the raw text survived until the approval
 * re-parsed it.
 *
 * Which means the row held one sentence and publication produced another. That
 * is mostly cosmetic for stray whitespace and is not cosmetic at all for a
 * quote carrying bidi controls: U+202E reverses the run that follows it, so a
 * reviewer can be shown "21" where the payload says 12, approve what they read,
 * and have the stripped — and differently-reading — sentence recorded as the
 * provenance they approved. The reviewer's screen and the audit record have to
 * be the same words.
 *
 * Same answer as `proposedMetaSchema` gives the other quote, for the same
 * reason: parse at the boundary, so the review card, the payload fingerprint,
 * the echo comparison and the approval all read one text.
 */
export function withCanonicalEntryQuote(proposedValue: unknown): unknown {
  if (!isRecord(proposedValue)) return proposedValue;
  const key =
    proposedValue.op === 'create' && isRecord(proposedValue.input)
      ? 'input'
      : proposedValue.op === 'update' && isRecord(proposedValue.patch)
        ? 'patch'
        : null;
  if (key === null) return proposedValue;
  const body = proposedValue[key] as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(body, 'quote')) return proposedValue;
  const raw = body.quote;
  // `undefined` is silence and stays silence; anything that is not a string is
  // left for the payload validator to refuse with its own message.
  if (raw === undefined || (raw !== null && typeof raw !== 'string')) {
    return proposedValue;
  }
  const canonical = canonicalSourceQuote(raw) ?? null;
  if (canonical === raw) return proposedValue;
  return { ...proposedValue, [key]: { ...body, quote: canonical } };
}

export function withoutStaleEntryQuote(
  nextProposedValue: unknown,
  prevProposedValue: unknown,
  /**
   * The entry's LIVE `observationContext`, for an `update` revision only
   * (`null`/omitted for `create`, which has no row to read). Omission on an
   * update patch inherits this — not whatever the PRIOR proposal happened to
   * state — because that is what `updateParameterEntryRow` will actually read
   * at write time.
   */
  liveEntry?: { observationContext: string | null } | null,
): unknown {
  const nested = (value: unknown): 'input' | 'patch' | null => {
    if (!isRecord(value)) return null;
    if (value.op === 'create' && isRecord(value.input)) return 'input';
    if (value.op === 'update' && isRecord(value.patch)) return 'patch';
    return null;
  };
  const key = nested(nextProposedValue);
  if (key === null || !isRecord(nextProposedValue)) return nextProposedValue;
  const body = nextProposedValue[key] as Record<string, unknown>;
  const quote = body.quote;
  if (typeof quote !== 'string' || quote.trim() === '') return nextProposedValue;

  const prevKey = nested(prevProposedValue);
  if (prevKey === null || !isRecord(prevProposedValue)) return nextProposedValue;
  const prevBody = prevProposedValue[prevKey] as Record<string, unknown>;
  // A quote the author rewrote is an assertion about the new payload; leave it.
  //
  // Compared in CANONICAL form, because that is the form the schema stores. A
  // raw comparison would read a re-wrapped copy of the same sentence — a
  // re-paste out of a PDF, say — as a replacement, let it through, and then
  // normalize it back to the very sentence it had decided was superseded. The
  // two would disagree about what "the same quote" means, and the gap between
  // them is precisely a stale quote surviving a revision.
  const prevQuote = prevBody.quote;
  if (
    typeof prevQuote !== 'string' ||
    sourceQuoteComparisonKey(prevQuote) !== sourceQuoteComparisonKey(quote)
  ) {
    return nextProposedValue;
  }

  // Same sentence as before. Did anything it is EVIDENCE ABOUT move?
  //
  // Only the fields in `SOURCE_QUOTE_EVIDENCE_FIELDS`, which is the same list
  // the update's own SQL compares. Comparing the whole payload instead would
  // treat a comments-only revision as staling the quote — and curator notes are
  // commentary about the observation, not part of what the sentence attests. A
  // contributor fixing a typo would lose the provenance: the proposal would be
  // held as unquoted and a later human approval would store NULL.
  // `isCreate` matters for exactly one field: `observationContext`. An update
  // patch that omits it preserves the stored row's value (`updateParameterEntryRow`),
  // but a create input that omits it inserts NULL (`insertParameterEntryRow`
  // has no prior row to preserve from) — so a create revision that drops the
  // field while echoing its quote has, in fact, changed what the quote would
  // attest to, and must not read as unchanged the way an update's omission does.
  //
  // For an update, an omitted `observationContext` in `body` is resolved
  // against `liveEntry` before comparing — not left as `undefined` for
  // `sourceQuoteEvidenceUnchanged`'s own preserve-when-omitted rule to trigger
  // — because THIS comparison's job is to ask "does what the quote will
  // actually attest to differ from what the PRIOR proposal claimed", and the
  // prior proposal is not what an update's omission preserves. Left
  // unresolved, a revision that drops the field while the live row disagrees
  // with the prior proposal's stated context would read as unchanged and keep
  // a quote attached to a context it was never checked against.
  const resolvedBody =
    key === 'patch' && body.observationContext === undefined && liveEntry
      ? { ...body, observationContext: liveEntry.observationContext }
      : body;
  if (
    sourceQuoteEvidenceUnchanged(prevBody, resolvedBody, {
      isCreate: key === 'input',
    })
  )
    return nextProposedValue;

  const { quote: _dropped, ...rest } = body;
  return { ...nextProposedValue, [key]: rest };
}

/**
 * The live `observationContext` `withoutStaleEntryQuote` needs, for both of
 * its callers (a submitter revising their own proposal, and a reviewer
 * returning one with changes) — the same fetch either way, since both paths
 * ask the identical question: does an omitted value in the new payload
 * inherit something that disagrees with what the PRIOR proposal claimed?
 *
 * `null` for anything but a `param_entry` UPDATE: a `create`'s `targetId` is
 * the drug, not an entry, and has no row to read from in the first place.
 */
async function liveEntryForQuoteStaleness(
  edit: PendingEditRecord,
): Promise<{ observationContext: string | null } | null> {
  if (
    edit.editType !== 'param_entry' ||
    edit.targetId == null ||
    paramEntryOp(edit.proposedValue) !== 'update'
  ) {
    return null;
  }
  const live = (
    await getParameterEntryContentsByIds([edit.targetId])
  ).get(edit.targetId);
  return live ?? null;
}

/**
 * Did this PATCH change the proposal's SUBSTANCE — the value and the sources it
 * was read from — as opposed to the commentary around it?
 *
 * NOT the rest of `proposedMeta`: an `editSummary` reworded, a note added, any
 * other curatorial field is commentary about the proposal rather than part of
 * what it claims — the same distinction `SOURCE_QUOTE_EVIDENCE_FIELDS` draws on
 * the entry side, where `comments` is deliberately absent from the list.
 *
 * `pendingEditPayloadFingerprint` is the wrong question even though it is the
 * right one for `revisedAt`: it fingerprints the whole of `proposedMeta`, so it
 * answers "did anything about this proposal change?". So the same fingerprint
 * is reused with the metadata blanked on both sides, which isolates the value
 * and the reference list while keeping its canonicalization (notably the
 * null/singular/array spellings of the reference set collapsing to one form).
 *
 * ## Two rules need this answer, and both were getting a broader one
 *
 * **The stale-quote rule.** A quote is evidence for a value; the broad answer
 * strips it on a metadata-only edit, so the proposal loses the sentence
 * reviewers were meant to check and is held from auto-publication for it.
 *
 * **Clearing a `direct_admin_write` conflict marker.** The marker says a direct
 * write landed on the entry and the proposal now holds a stale snapshot; a
 * revision discharges it because a revision is a rebase. The broad answer let
 * an author discharge it by rewording their own edit summary — the
 * full-replacement patch untouched, the marker gone, and the next approval
 * overwriting the admin's reading and its quote. Commentary standing in for a
 * rebase, which is the same shape as presence standing in for assertion.
 *
 * One question, one answer, both callers.
 */
export function proposalContentRevised(
  next: {
    proposedValue: unknown;
    referenceId: number | null | undefined;
    referenceIds: number[] | null | undefined;
  },
  prev: {
    proposedValue: unknown;
    referenceId: number | null | undefined;
    referenceIds: number[] | null | undefined;
  },
): boolean {
  const fingerprint = (payload: typeof next) =>
    pendingEditPayloadFingerprint({ ...payload, proposedMeta: null });
  return fingerprint(next) !== fingerprint(prev);
}

/**
 * Drop a carried-forward `sourceQuote` when the payload it was evidence for has
 * been revised and the revision supplies no replacement.
 *
 * A `parameter` proposal keeps its quote in `proposedMeta` (a NumericRange has
 * nowhere to put one), and the review card resubmits `proposedValue` alone —
 * so without this, revising the value leaves the previous sentence attached to
 * it. `highRiskEditLacksSourceQuote` would then see a non-empty quote and let a
 * changed calculation-driving value auto-publish behind words that describe the
 * number it used to be. A quote is evidence for a specific value; when the
 * value moves and nobody supplies new evidence, the honest state is none —
 * which also holds the edit for a human rather than publishing it.
 *
 * Only ever removes. A revision that states a NEW `sourceQuote` keeps it.
 *
 * "New" is a comparison, not the presence of the key. A client that reads the
 * edit, changes `proposedValue` and PATCHes the whole thing back sends the
 * stored metadata along with it — the quote included — and taking that as the
 * author supplying evidence would let the old sentence ride a changed value
 * through the auto-publication gate, which is the exact failure this exists to
 * prevent. Echoing what is already stored asserts nothing; only a quote that
 * DIFFERS from the stored one is a statement about the new payload. Compared in
 * canonical form, so a re-paste that only rewraps the same sentence is still an
 * echo — the same rule `withoutStaleEntryQuote` applies to a nested entry
 * quote, and for the same reason.
 */
export function withoutStaleSourceQuote(
  nextMeta: unknown,
  opts: {
    payloadRevised: boolean;
    suppliedMeta: unknown;
    /** The row's metadata as stored BEFORE this PATCH — what an echo echoes. */
    storedMeta: unknown;
  },
): unknown {
  if (!opts.payloadRevised) return nextMeta;
  if (!isRecord(nextMeta)) return nextMeta;
  const supplied = opts.suppliedMeta;
  if (isRecord(supplied) && supplied.sourceQuote !== undefined) {
    const read = (meta: unknown): string | null | undefined => {
      if (!isRecord(meta)) return undefined;
      const raw = meta.sourceQuote;
      if (raw === undefined) return undefined;
      // The comparison key, not the stored form: an author "supplying" the
      // stored sentence with an invisible character appended has asserted
      // nothing, and comparing the raw text would let that count as a
      // replacement and keep a quote the revision has staled.
      return typeof raw === 'string'
        ? sourceQuoteComparisonKey(raw) || null
        : null;
    };
    // An explicit removal, or a sentence the author actually rewrote: both are
    // assertions about the revised payload, so they stand.
    if (read(supplied) !== read(opts.storedMeta)) return nextMeta;
  }
  if (nextMeta.sourceQuote === undefined) return nextMeta;
  const { sourceQuote: _dropped, ...rest } = nextMeta;
  return rest;
}

/**
 * The id of the `direct_admin_write` marker on `snapshotProposedMeta`, or
 * null when there is nothing of that specific kind to acknowledge.
 *
 * Deliberately narrower than "any `conflict` key": `buildConflictMarker`
 * (api/_lib/pending-edits-helpers.ts) stamps an unrelated, older conflict —
 * an approved SIBLING edit making this one stale — on `parameter`, `param_entry`
 * and wiki edits alike, and that marker has no `id` at all. Requiring an
 * acknowledgment for it would make it permanently unclearable, which is not
 * what #1258 asks for; only the direct-write marker
 * (`markEntryMutationsConflicted`) carries the `gen_random_uuid()` id this
 * function reads.
 */
function directAdminWriteConflictId(
  snapshotProposedMeta: unknown,
): string | null {
  const conflict = isRecord(snapshotProposedMeta)
    ? snapshotProposedMeta.conflict
    : null;
  if (!isRecord(conflict) || conflict.reason !== 'direct_admin_write') {
    return null;
  }
  return typeof conflict.id === 'string' ? conflict.id : null;
}

/**
 * Did this PATCH answer the SPECIFIC `direct_admin_write` marker still on the
 * row, rather than merely follow one (#1258)?
 *
 * A revised payload proves the actor did *something*; it does not prove they
 * reconciled with the direct write that raised the flag they were shown. The
 * client echoes back the id of the marker it rendered beside the live entry,
 * and only a match counts as "seen and answered".
 *
 * Compared against `snapshotProposedMeta` — the row as THIS handler loaded
 * it moments ago, not any earlier client-side copy — so a client acknowledging
 * a marker that has since been superseded by a newer direct write still fails
 * the match; the newer marker's id was never shown to them. A stale ack losing
 * costs nothing extra: the stale-erasure branch of
 * `nextProposedMetaPreservingConflict` re-applies a superseding marker
 * regardless of `revisesPayload`, so this only ever narrows the "same marker
 * as before" case where an id can meaningfully agree or disagree.
 *
 * No `direct_admin_write` marker present at all (no conflict, or the
 * unrelated sibling-approval marker above) — nothing to acknowledge, so a
 * content revision clears it exactly as it always has.
 */
/** A new wiki fact or a new wiki section (see `resubmitRebasesAdditiveWikiEdit`). */
function isAdditiveWikiEdit(
  edit: Pick<typeof pendingEdits.$inferSelect, 'editType' | 'factOperation' | 'proposedValue'>,
): boolean {
  if (edit.editType === 'wiki_fact') return edit.factOperation === 'add';
  if (edit.editType === 'wiki_section') {
    return isRecord(edit.proposedValue) && edit.proposedValue.operation === 'add';
  }
  return false;
}

function conflictMarkerAcknowledged(
  snapshotProposedMeta: unknown,
  acknowledgedConflictId: string | null | undefined,
): boolean {
  const seenId = directAdminWriteConflictId(snapshotProposedMeta);
  if (seenId === null) return true;
  return acknowledgedConflictId === seenId;
}

// Compute the next `proposedMeta` for a submitter/reviewer PATCH while guarding
// the `conflict` marker a concurrent approval may stamp onto the row (see
// markConflictingPendingEdits). The marker is written without changing `status`,
// so the row-status guard on these updates cannot detect it.
//
// `snapshotProposedMeta` is the row as the actor loaded it (start of the
// handler); `revisesPayload` is whether this PATCH changes the payload AND
// acknowledges the marker still on the row (`conflictMarkerAcknowledged`) — a
// CONTENT comparison, never "the request carried payload fields", because
// echoing the stored payload back satisfies the second and revises nothing.
// Passing the looser answer makes a stale proposal approvable again without
// anybody having rebased it, which is precisely what the "preserve" case below
// exists to prevent. Three outcomes, all decided inside the UPDATE so they
// stay atomic with the write:
//   - Authorized clear: the row's conflict is UNCHANGED from the actor's
//     snapshot (nobody raced them) AND they rebased against it — drop it from
//     `nextJson` and let the edit become approvable again.
//   - Preserve, which covers two cases the caller cannot tell apart from here
//     and must not need to: stale erasure (#592, the row now holds a conflict
//     the actor never saw — DISTINCT FROM their snapshot) and an unauthorized
//     clear (the row's conflict matches the snapshot, but the actor didn't
//     rebase, or rebased without acknowledging THIS marker's id — #1258). Both
//     FORCE the row's CURRENT conflict onto `nextJson`, rather than trusting
//     `nextJson` to already carry it: a caller that supplies its own
//     `proposedMeta` (any object, however innocuous) with no `conflict` key at
//     all — the ordinary shape for an API client that has never heard of this
//     field — would otherwise overwrite the column with one, silently erasing
//     the marker regardless of `revisesPayload`. Forcing it here means the
//     only way to lose the marker is the first branch, which requires both an
//     unchanged snapshot and an authorized rebase.
//   - No conflict on the row at all: nothing to preserve, use `nextJson` as
//     given.
export function nextProposedMetaPreservingConflict(
  nextMeta: unknown,
  snapshotProposedMeta: unknown,
  revisesPayload: boolean,
) {
  const nextJson = nextMeta == null ? null : JSON.stringify(nextMeta);
  const seenConflict =
    isRecord(snapshotProposedMeta) && snapshotProposedMeta.conflict != null
      ? JSON.stringify(snapshotProposedMeta.conflict)
      : null;
  const withConflict = sql`CASE
    WHEN jsonb_typeof(${pendingEdits.proposedMeta}) = 'object'
      AND jsonb_exists(${pendingEdits.proposedMeta}, 'conflict')
      AND ${revisesPayload}
      AND (${pendingEdits.proposedMeta} -> 'conflict') IS NOT DISTINCT FROM ${seenConflict}::jsonb
    THEN ${nextJson}::jsonb - 'conflict'
    WHEN jsonb_typeof(${pendingEdits.proposedMeta}) = 'object'
      AND jsonb_exists(${pendingEdits.proposedMeta}, 'conflict')
    THEN COALESCE(${nextJson}::jsonb, '{}'::jsonb)
      || jsonb_build_object('conflict', ${pendingEdits.proposedMeta} -> 'conflict')
    ELSE ${nextJson}::jsonb
  END`;
  // The conversation-ingestion marker is carried over from the stored row
  // whatever the revision supplies: a revision does not read the papers, so
  // it must not release the unread-sources hold (`SERVER_OWNED_META_KEYS`).
  // Read from the row the UPDATE writes, like the conflict marker above.
  return sql`CASE
    WHEN jsonb_typeof(${pendingEdits.proposedMeta} -> 'unverifiedReferenceIds') = 'array'
    THEN (CASE WHEN jsonb_typeof(${withConflict}) = 'object' THEN ${withConflict} ELSE '{}'::jsonb END)
      || jsonb_strip_nulls(jsonb_build_object(
        'unverifiedReferenceIds', ${pendingEdits.proposedMeta} -> 'unverifiedReferenceIds',
        'unverifiedSourceKeys', ${pendingEdits.proposedMeta} -> 'unverifiedSourceKeys'
      ))
    ELSE ${withConflict}
  END`;
}

type PatchPendingEditInput = z.infer<typeof patchPendingEditSchema>;
type PendingEditValidationError = {
  message: string;
  code: string;
};

function pendingEditPatchChangesPayload(data: PatchPendingEditInput): boolean {
  return (
    data.proposedValue !== undefined ||
    data.proposedMeta !== undefined ||
    data.referenceId !== undefined ||
    data.referenceIds !== undefined
  );
}

function readEffectiveReferenceIds(
  edit: Pick<PendingEditRecord, 'referenceId' | 'referenceIds'>,
  nextReferenceIds: number[] | null | undefined,
): number[] | null {
  if (nextReferenceIds !== undefined) return nextReferenceIds;
  if (edit.referenceIds && edit.referenceIds.length > 0) {
    return edit.referenceIds;
  }
  return edit.referenceId ? [edit.referenceId] : null;
}

function validateParameterSubmitterPatch(
  edit: PendingEditRecord,
  proposedValue: unknown,
  effectiveReferenceIds: number[] | null,
): PendingEditValidationError | null {
  if (edit.editType !== 'parameter') return null;
  if (!edit.parameter || !isDrugParameterId(edit.parameter)) {
    return {
      message: 'Invalid parameter',
      code: 'pending_edit_invalid_parameter',
    };
  }

  const spec = DRUG_PARAMETERS[edit.parameter];
  const valid = spec.zod.safeParse(proposedValue);
  if (!valid.success) {
    return {
      message:
        'Invalid value: ' +
        valid.error.issues
          .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
          .join('; '),
      code: 'pending_edit_parameter_value_invalid',
    };
  }

  if (!effectiveReferenceIds || effectiveReferenceIds.length === 0) {
    return {
      message: 'At least one referenceId is required for parameter edits',
      code: 'pending_edit_parameter_reference_required',
    };
  }

  return null;
}

/**
 * The source a `param_entry` payload would publish a citation to, or null when
 * it names none (a `delete`, or a payload that does not parse). The approval
 * gates exactly this id — not the pending row's whole `referenceIds` set — so
 * every check that mirrors the approval has to read the same one.
 */
export function paramEntryPayloadCitationId(
  proposedValue: unknown,
): number | null {
  const parsed = parameterEntryEditSchema.safeParse(proposedValue);
  if (!parsed.success) return null;
  if (parsed.data.op === 'create') return parsed.data.input.citationId;
  if (parsed.data.op === 'update') return parsed.data.patch.citationId;
  return null;
}

/**
 * Re-run the `param_entry` write rules on a payload rewrite.
 *
 * The dedicated `/api/parameter-entries` routes validate every payload they
 * queue, but the two generic paths that can REWRITE `proposedValue` — the
 * submitter's resubmit PATCH and the reviewer's return-with-changes — wrote it
 * through unchecked, so either could store a payload the approval will refuse
 * (free text where the schema wants a `<`/`≥` qualifier, a patch carrying
 * `null` for the fields it leaves alone, a value outside the parameter's
 * registry bounds, a citation the row does not advertise, an op switched from
 * `create` to `update`, which silently re-reads `targetId` as an entry id
 * instead of a drug id). Nothing surfaced that until a reviewer pressed
 * approve, and the failure they saw was `param_entry_invalid_payload` — an
 * error only its author can fix, told to the one person who cannot. When the
 * REVIEWER wrote the payload it was worse still: the author's next resubmit
 * was refused for a rewrite they never made.
 *
 * So mirror the approval-time checks in `applyApprovedParameterEntry` here,
 * where the caller is whoever wrote the payload and the message reaches
 * someone who can act on it. Anything this accepts is a payload approval will
 * still re-validate against the live row; anything it rejects could never have
 * been approved.
 *
 * `audience` only picks the prose for the op-kind refusals — a reviewer cannot
 * withdraw someone else's proposal, so they are not told to. The codes (which
 * is what the UI localizes) are the same either way.
 */
export function validateParameterEntrySubmitterPatch(
  edit: Pick<
    PendingEditRecord,
    'editType' | 'parameter' | 'targetId' | 'proposedValue'
  >,
  proposedValue: unknown,
  effectiveReferenceIds: number[] | null,
  audience: 'submitter' | 'reviewer' = 'submitter',
): PendingEditValidationError | null {
  if (edit.editType !== 'param_entry') return null;

  // Every DB-free approval rule, shared with the review card's preflight so a
  // payload one accepts is never one the other refuses.
  const problem = inspectParameterEntryPayload(
    {
      parameter: edit.parameter,
      targetId: edit.targetId,
      referenceIds: effectiveReferenceIds ?? [],
    },
    proposedValue,
  );
  // An unparseable payload says nothing about its op, so the op-kind guard
  // below cannot run; report the schema failure itself.
  if (problem?.code === 'param_entry_invalid_payload') return problem;

  // `targetId` means different things per op — the drug for a `create`, the
  // entry for `update`/`delete` — so a rewrite may move between update and
  // delete (both act on the same entry) but never across that boundary.
  //
  // A row whose STORED op is unreadable says nothing about which kind of id
  // `targetId` holds, and drug ids and entry ids are independent sequences
  // that overlap freely — so "repairing" such a row would let the approval
  // apply it to whichever unrelated row happens to share the number. Only
  // `/api/parameter-entries` creates these rows and it always writes a valid
  // op, so an unreadable one means the payload was already corrupted (the
  // unchecked writes this gate closes could do exactly that). Refuse the
  // rewrite; withdrawing (`status:'rejected'` with no payload change) stays
  // open, and a fresh proposal carries an unambiguous target.
  const storedOp = paramEntryOp(edit.proposedValue);
  const nextOp = paramEntryOp(proposedValue);
  if (!storedOp) {
    return {
      message:
        'This source-value proposal has no readable operation, so there is ' +
        'no way to tell whether its target id names a drug or an entry. ' +
        (audience === 'reviewer'
          ? 'Return it unchanged and ask for a fresh proposal.'
          : 'Withdraw it and submit a fresh proposal.'),
      code: 'param_entry_target_mismatch',
    };
  }
  if ((storedOp === 'create') !== (nextOp === 'create')) {
    return {
      message:
        `Cannot change a source-value proposal from "${storedOp}" to ` +
        `"${nextOp}": the two operations target different rows. ` +
        (audience === 'reviewer'
          ? 'Return it unchanged and ask for the operation you want.'
          : 'Withdraw this proposal and submit the operation you want.'),
      code: 'param_entry_target_mismatch',
    };
  }

  return problem;
}

function readProposedFactId(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.attrs)) return null;
  return typeof value.attrs.factId === 'string' ? value.attrs.factId : null;
}

export function changesWikiFactId(
  edit: Pick<PendingEditRecord, 'editType' | 'proposedValue'>,
  proposedValue: unknown,
): boolean {
  if (edit.editType !== 'wiki_fact') return false;
  const oldFactId = readProposedFactId(edit.proposedValue);
  const nextFactId = readProposedFactId(proposedValue);
  return Boolean(oldFactId && nextFactId !== oldFactId);
}

export function materializePatchedWikiFactProposedValue(
  edit: Pick<
    PendingEditRecord,
    'editType' | 'proposedValue' | 'factOperation' | 'factStatement'
  >,
  proposedValue: unknown,
  referenceIds: number[],
): unknown {
  if (
    edit.editType !== 'wiki_fact' ||
    (edit.factOperation !== 'add' && edit.factOperation !== 'replace')
  ) {
    return proposedValue;
  }

  const factId = readProposedFactId(edit.proposedValue);
  if (!factId) {
    throw new Error(
      'wiki_fact: existing proposedValue.attrs.factId is required',
    );
  }

  const factStatement = edit.factStatement?.trim();
  if (!factStatement) {
    throw new Error(
      'wiki_fact: factStatement is required to patch proposedValue',
    );
  }

  const rawContent = readSubmittedFactContent(proposedValue);
  const content = sanitizeSubmittedFactContent(proposedValue, factStatement);
  if (rawContent && !content) {
    throw new Error(
      'wiki_fact: proposedValue content must match the reviewed factStatement',
    );
  }

  return createFactNode({
    factId,
    statement: factStatement,
    referenceIds,
    content,
  });
}

export function isOpenPaperReviewConflict(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (isRecord(current) && !seen.has(current)) {
    seen.add(current);
    const code = current.code;
    const constraint = current.constraint;
    const message =
      typeof current.message === 'string' ? current.message : String(current);
    if (
      code === '23505' &&
      (constraint === 'pending_edits_open_paper_review_idx' ||
        message.includes('pending_edits_open_paper_review_idx'))
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

// ─── Batch enrichment helpers ─────────────────────────────────────────────────
//
// `buildEnrichmentMaps` collects all IDs needed across a batch of pending-edit
// rows and fetches them in 5 parallel queries instead of issuing 3-5 queries
// per row. `enrichFromMaps` is a pure synchronous function that produces the
// enriched record from the pre-fetched data, so the list path goes from
// O(n × queries) to O(1 batch + n × in-memory lookups).

const userRefSelect = {
  id: users.id,
  username: users.username,
  displayName: users.displayName,
  // Email omitted — the pending-edits queue is readable by submitters
  // (their own edits) and by editors/admins (all edits). Including email
  // would let contributors harvest reviewer addresses and editors harvest
  // all submitter addresses without any legitimate need. Same rationale
  // as the wiki-pages and drug-discussions endpoints.
  role: users.role,
  isAgent: sql<boolean>`${agents.id} is not null`,
};

type UserRef =
  typeof userRefSelect extends Record<string, infer _C>
    ? {
        id: number;
        username: string;
        displayName: string | null;
        role: string;
        isAgent: boolean;
      }
    : never;

type CitationRow = typeof citations.$inferSelect;
type DrugRow = typeof drugs.$inferSelect;
type PageRef = {
  id: number;
  title: string;
  slug: string;
  content: unknown;
  contentHtml: string | null;
  pageType: string;
  /** drug_cid for drug_monograph pages — used to resolve the localized drug name. */
  drugCid: number | null;
};

interface EnrichmentMaps {
  userMap: Map<number, UserRef>;
  citationMap: Map<number, CitationRow>;
  /** Citations carrying a read-in-full paper review, as of this request. */
  judgedCitationIds: Set<number>;
  drugMap: Map<number, DrugRow>;
  pageMap: Map<number, PageRef>;
  /** Maps drug.id → the slug of that drug's wiki monograph page. */
  monographSlugMap: Map<number, string>;
  drugParamsMap: Map<number, Map<string, unknown>>;
  /**
   * Maps `${drugId}:${parameter}` → the reference ids attached to that
   * parameter's *current* (latest-applied) revision. Lets the review diff show
   * which citations a value-preserving edit adds or removes (#857).
   */
  currentParamReferencesMap: Map<string, number[]>;
  verificationMap: Map<number, VerificationSummary>;
  /**
   * Citation ids (paper_review targets) that still have an open PDF request —
   * an agent declared the full text unavailable and none has been supplied.
   */
  openPdfRequestCitationIds: Set<number>;
  /** Citation ids that have a stored full-text PDF on file. */
  storedPdfCitationIds: Set<number>;
  /**
   * bio_entity update edits (targetId = bio_entities.id) → the entity's
   * symbol/name/slug, so the review card can label and link the edit to the
   * entity's monograph. Create edits carry their label in proposedMeta.
   */
  bioEntityMap: Map<number, { symbol: string; name: string; slug: string }>;
  /**
   * param_entry update/delete edits (targetId = parameter_entries.id) → the
   * entry's full contents, so the review card can show the live value, matrix,
   * scenario, citation, and comments a reviewer is about to change or remove.
   * Create edits carry their payload in proposedValue.input.
   */
  paramEntryMap: Map<number, ParameterEntryContents>;
}

// Bounds the size of a single `IN (…)` lookup so a queue page with many
// pending edits, each carrying long `referenceIds` arrays, can't push the
// citation lookup past the postgres bind-parameter ceiling and fail the
// whole queue request. The other lookups here add at most one or two ids
// per row (submittedBy, reviewedBy, targetId), so they comfortably fit
// in a single chunk and we still apply the same bound for consistency.
const ID_LOOKUP_CHUNK = 500;

async function chunkedInLookup<T>(
  ids: number[],
  fetcher: (chunk: number[]) => Promise<T[]>,
): Promise<T[]> {
  if (ids.length === 0) return [];
  if (ids.length <= ID_LOOKUP_CHUNK) return fetcher(ids);
  const results: T[] = [];
  for (let i = 0; i < ids.length; i += ID_LOOKUP_CHUNK) {
    const part = await fetcher(ids.slice(i, i + ID_LOOKUP_CHUNK));
    results.push(...part);
  }
  return results;
}

export async function buildEnrichmentMaps(
  rows: PendingEditRecord[],
  options: {
    /**
     * Whether the caller may see unpublished pages. The queue hydrates
     * wiki_page / wiki_fact targets with the page's *current* content so the
     * reviewer can diff against it — which would hand a draft's body to
     * anyone holding review.queue.readAll, including callers that
     * GET /api/wiki/pages would 404. Defaults to false so a caller that
     * forgets to pass it gets the safe answer.
     */
    canReadDrafts?: boolean;
  } = {},
): Promise<EnrichmentMaps> {
  const canReadDrafts = options.canReadDrafts ?? false;
  const db = getDb();
  const userIds = new Set<number>();
  const refIds = new Set<number>();
  const drugIds = new Set<number>();
  // contentPageIds: wiki_page edits need both content and contentHtml so the
  //   reviewer can see the current page body alongside the proposed diff.
  // wikiFactPageIds: wiki_fact edits only need content (to locate the specific
  //   fact node) — contentHtml is never read during enrichment and can be 50-200 KB
  //   of rendered HTML per monograph, so omitting it reduces Neon data transfer.
  // sectionPageIds: wiki_section edits only use the page title.
  const contentPageIds = new Set<number>();
  const wikiFactPageIds = new Set<number>();
  const sectionPageIds = new Set<number>();
  // Citations targeted by a paper_review edit — used to flag a read-in-full
  // attestation that has no full-text evidence on file (open PDF request, no
  // stored PDF). See isReadInFullUnverified.
  const paperReviewCitationIds = new Set<number>();
  // Drugs whose parameter edits need their *current* references resolved so the
  // review diff can flag a references-only change (#857).
  const paramEditDrugIds = new Set<number>();
  // bio_entity update edits target a bio_entities row; collect the ids so the
  // review card can hydrate the entity's symbol/name/slug.
  const bioEntityIds = new Set<number>();
  // param_entry update/delete edits target a parameter_entries row (targetId =
  // entry id); collect the ids so the card can show the entry being changed.
  const paramEntryEntryIds = new Set<number>();

  for (const row of rows) {
    userIds.add(row.submittedBy);
    if (row.reviewedBy) userIds.add(row.reviewedBy);

    const allRefIds =
      row.referenceIds && row.referenceIds.length > 0
        ? row.referenceIds
        : row.referenceId
          ? [row.referenceId]
          : [];
    for (const id of allRefIds) refIds.add(id);

    if (
      (row.editType === 'parameter' ||
        row.editType === 'metabolism' ||
        row.editType === 'receptor_targets') &&
      row.targetId
    )
      drugIds.add(row.targetId);
    if (row.editType === 'parameter' && row.targetId && row.parameter) {
      paramEditDrugIds.add(row.targetId);
    }
    // paper_review targets a citation directly (targetId = citation id);
    // pull it into the citation lookup so the queue card can name the paper.
    if (row.editType === 'paper_review' && row.targetId) {
      refIds.add(row.targetId);
      paperReviewCitationIds.add(row.targetId);
    }
    if (row.editType === 'wiki_page' && row.targetId) {
      contentPageIds.add(row.targetId);
    } else if (row.editType === 'wiki_fact' && row.targetId) {
      wikiFactPageIds.add(row.targetId);
    } else if (row.editType === 'wiki_section' && row.targetId) {
      sectionPageIds.add(row.targetId);
    }
    if (row.editType === 'bio_entity' && row.targetId) {
      bioEntityIds.add(row.targetId);
    }
    if (row.editType === 'param_entry' && row.targetId) {
      // create → targetId is the drug id; update/delete → targetId is the entry
      // id (resolved to its drug after the entry contents are fetched below).
      if (paramEntryOp(row.proposedValue) === 'create') {
        drugIds.add(row.targetId);
      } else {
        paramEntryEntryIds.add(row.targetId);
      }
    }
    if (row.editType === 'param_entry') {
      for (const id of doseContextDrugIds(
        paramEntryPayloadFields(row.proposedValue),
      )) {
        drugIds.add(id);
      }
    }
  }

  // param_entry update/delete edits reference an entry id, not a drug. Fetch the
  // entry contents up front (only when such edits are present) and fold their
  // drug ids into `drugIds` so the drug-name / monograph-slug lookups below cover
  // them in the same batch.
  const paramEntryMap =
    paramEntryEntryIds.size > 0
      ? await getParameterEntryContentsByIds([...paramEntryEntryIds])
      : new Map<number, ParameterEntryContents>();
  for (const entry of paramEntryMap.values()) {
    drugIds.add(entry.drugId);
    for (const id of doseContextDrugIds(entry.doseContext)) drugIds.add(id);
  }

  // Pages referenced by a wiki_page edit take priority over wiki_fact and
  // wiki_section edits for the same page. A page in contentPageIds gets the
  // full fetch (content + contentHtml) regardless of other edit types.
  const factOnlyPageIds = [...wikiFactPageIds].filter(
    (id) => !contentPageIds.has(id),
  );
  const titleOnlyPageIds = [...sectionPageIds].filter(
    (id) => !contentPageIds.has(id) && !wikiFactPageIds.has(id),
  );

  const [
    userRows,
    citeRows,
    drugRows,
    fullPageRows,
    factOnlyPageRows,
    titlePageRows,
    monographRows,
    paramsMap,
    verificationMap,
    openPdfRequestRows,
    storedPdfRows,
    currentParamRefRows,
  ] = await Promise.all([
    chunkedInLookup([...userIds], (chunk) =>
      db
        .select(userRefSelect)
        .from(users)
        .leftJoin(agents, eq(agents.userId, users.id))
        .where(inArray(users.id, chunk)),
    ),
    chunkedInLookup([...refIds], (chunk) =>
      db.select().from(citations).where(inArray(citations.id, chunk)),
    ),
    chunkedInLookup([...drugIds], (chunk) =>
      db.select().from(drugs).where(inArray(drugs.id, chunk)),
    ),
    // wiki_page edits: full content + contentHtml for the reviewer diff view.
    chunkedInLookup([...contentPageIds], (chunk) =>
      db
        .select({
          id: wikiPages.id,
          title: wikiPages.title,
          slug: wikiPages.slug,
          status: wikiPages.status,
          content: wikiPages.content,
          contentHtml: wikiPages.contentHtml,
          pageType: wikiPages.pageType,
          drugCid: wikiPages.drugCid,
        })
        .from(wikiPages)
        .where(inArray(wikiPages.id, chunk)),
    ),
    // wiki_fact-only edits: content only (contentHtml is never read during
    // fact-node lookup and can be 50-200 KB of rendered HTML per monograph).
    chunkedInLookup(factOnlyPageIds, (chunk) =>
      db
        .select({
          id: wikiPages.id,
          title: wikiPages.title,
          slug: wikiPages.slug,
          status: wikiPages.status,
          content: wikiPages.content,
          pageType: wikiPages.pageType,
          drugCid: wikiPages.drugCid,
        })
        .from(wikiPages)
        .where(inArray(wikiPages.id, chunk)),
    ),
    chunkedInLookup(titleOnlyPageIds, (chunk) =>
      db
        .select({
          id: wikiPages.id,
          title: wikiPages.title,
          slug: wikiPages.slug,
          pageType: wikiPages.pageType,
          drugCid: wikiPages.drugCid,
        })
        .from(wikiPages)
        .where(inArray(wikiPages.id, chunk)),
    ),
    // Fetch monograph slugs for drug-scoped edits so review cards link to the
    // wiki page URL (wiki_pages.slug) rather than drugs.slug, which can diverge.
    chunkedInLookup([...drugIds], (chunk) =>
      db
        .select({ drugCid: wikiPages.drugCid, slug: wikiPages.slug })
        .from(wikiPages)
        .where(
          and(
            eq(wikiPages.pageType, 'drug_monograph'),
            inArray(wikiPages.drugCid, chunk),
          ),
        ),
    ),
    drugIds.size > 0
      ? getDrugParametersByDrugIds(db, [...drugIds])
      : new Map<number, Map<string, unknown>>(),
    summariseVerificationsForTargets({
      targetType: 'pending_edit',
      targetIds: rows.map((r) => r.id),
    }),
    // Open PDF requests for the paper_review target citations — signals the
    // full text was declared unavailable and never supplied.
    chunkedInLookup([...paperReviewCitationIds], (chunk) =>
      db
        .select({ citationId: pdfRequests.citationId })
        .from(pdfRequests)
        .where(
          and(
            inArray(pdfRequests.citationId, chunk),
            eq(pdfRequests.status, 'open'),
          ),
        ),
    ),
    // Stored full-text PDFs for those same citations.
    chunkedInLookup([...paperReviewCitationIds], (chunk) =>
      db
        .select({ citationId: citationPdfs.citationId })
        .from(citationPdfs)
        .where(inArray(citationPdfs.citationId, chunk)),
    ),
    // Current references per parameter edit: the reference ids on each edited
    // parameter's latest applied revision. DISTINCT ON (drug_id, parameter)
    // returns only that latest row per parameter in one indexed pass; chunks
    // partition by drug_id, so no (drug_id, parameter) pair spans two chunks.
    paramEditDrugIds.size > 0
      ? chunkedInLookup([...paramEditDrugIds], (chunk) =>
          db
            .selectDistinctOn(
              [
                drugParameterRevisions.drugId,
                drugParameterRevisions.parameter,
              ],
              {
                drugId: drugParameterRevisions.drugId,
                parameter: drugParameterRevisions.parameter,
                referenceId: drugParameterRevisions.referenceId,
                referenceIds: drugParameterRevisions.referenceIds,
              },
            )
            .from(drugParameterRevisions)
            .where(inArray(drugParameterRevisions.drugId, chunk))
            .orderBy(
              drugParameterRevisions.drugId,
              drugParameterRevisions.parameter,
              desc(drugParameterRevisions.createdAt),
            ),
        )
      : Promise.resolve(
          [] as Array<{
            drugId: number;
            parameter: string;
            referenceId: number | null;
            referenceIds: number[] | null;
          }>,
        ),
  ]);

  // Merge all page fetch results into a single map. contentHtml is null for
  // fact-only and title-only pages since those paths don't fetch it.
  const pageMap = new Map<number, PageRef>();
  // A caller without wiki.draft.read must not receive an unpublished page's
  // body (or its existence) through the queue: GET /api/wiki/pages answers 404
  // for those, and the enrichment would otherwise hand over the live content.
  // Dropping the row leaves the card showing an unresolved target, which is
  // the same answer the read path gives.
  const visible = <T extends { status?: string | null }>(rows: T[]): T[] =>
    canReadDrafts ? rows : rows.filter((p) => p.status === 'published');

  for (const p of visible(fullPageRows)) pageMap.set(p.id, p as PageRef);
  for (const p of visible(factOnlyPageRows))
    pageMap.set(p.id, { ...p, contentHtml: null });
  for (const p of titlePageRows)
    pageMap.set(p.id, { ...p, content: null, contentHtml: null });

  const monographSlugMap = new Map<number, string>();
  for (const m of monographRows) {
    if (m.drugCid != null) monographSlugMap.set(m.drugCid, m.slug);
  }

  const drugMap = new Map(drugRows.map((d) => [d.id, d]));

  // Drug-monograph wiki pages (wiki_fact / wiki_page / wiki_section edits)
  // carry a drug_cid. Pull in those drugs so the queue card can show the
  // *drug's* localized name (e.g. Norwegian "Valproat") instead of the
  // monograph page's stored title, which may be English or stale
  // ("Valproic acid"). Mirrors the parameter/metabolism branches. Only the
  // drugs not already loaded above are fetched, in one extra round.
  const monographDrugIds = new Set<number>();
  for (const page of pageMap.values()) {
    if (
      page.pageType === 'drug_monograph' &&
      page.drugCid != null &&
      !drugMap.has(page.drugCid)
    ) {
      monographDrugIds.add(page.drugCid);
    }
  }
  if (monographDrugIds.size > 0) {
    const monographDrugRows = await chunkedInLookup(
      [...monographDrugIds],
      (chunk) => db.select().from(drugs).where(inArray(drugs.id, chunk)),
    );
    for (const d of monographDrugRows) drugMap.set(d.id, d);
  }

  // Index each edited parameter's current references by (drugId, parameter).
  const currentParamReferencesMap = new Map<string, number[]>();
  for (const r of currentParamRefRows) {
    const ids =
      r.referenceIds && r.referenceIds.length > 0
        ? r.referenceIds
        : r.referenceId
          ? [r.referenceId]
          : [];
    if (ids.length > 0) {
      currentParamReferencesMap.set(`${r.drugId}:${r.parameter}`, ids);
    }
  }

  // Hydrate bio_entity update targets in one extra round (only when present),
  // mirroring the monograph-drug second fetch above.
  const bioEntityMap = new Map<
    number,
    { symbol: string; name: string; slug: string }
  >();
  if (bioEntityIds.size > 0) {
    const bioRows = await chunkedInLookup([...bioEntityIds], (chunk) =>
      db
        .select({
          id: bioEntities.id,
          symbol: bioEntities.symbol,
          name: bioEntities.name,
          slug: bioEntities.slug,
        })
        .from(bioEntities)
        .where(inArray(bioEntities.id, chunk)),
    );
    for (const b of bioRows) {
      bioEntityMap.set(b.id, {
        symbol: b.symbol,
        name: b.name,
        slug: b.slug,
      });
    }
  }

  const citationMap = new Map(citeRows.map((c) => [c.id, c]));
  // A removed/edited current reference may not appear in any pending edit's
  // referenceIds, so its citation row isn't in citeRows. Hydrate the stragglers
  // so the diff can render the struck-through reference with a real label.
  const missingRefIds = new Set<number>();
  for (const ids of currentParamReferencesMap.values()) {
    for (const id of ids) if (!citationMap.has(id)) missingRefIds.add(id);
  }
  if (missingRefIds.size > 0) {
    const extraCiteRows = await chunkedInLookup([...missingRefIds], (chunk) =>
      db.select().from(citations).where(inArray(citations.id, chunk)),
    );
    for (const c of extraCiteRows) citationMap.set(c.id, c);
  }

  // Which of these papers carry a read-in-full review, right now.
  //
  // Read live rather than remembered: whether a paper has been read is not a
  // property of the proposal, so a value frozen onto one goes stale the moment
  // someone reviews the paper — or the moment the proposal's own references are
  // edited through PATCH, which preserves `proposedMeta` verbatim. A review
  // card that marks the wrong paper is worse than one that marks none, because
  // the mark is the reviewer's instruction about what to go and read.
  const judgedCitationIds = new Set<number>();
  if (citationMap.size > 0) {
    const reviewed = await chunkedInLookup([...citationMap.keys()], (chunk) =>
      db
        .select({ citationId: paperReviews.citationId })
        .from(paperReviews)
        .where(
          and(
            inArray(paperReviews.citationId, chunk),
            eq(paperReviews.readInFull, true),
          ),
        ),
    );
    for (const r of reviewed) judgedCitationIds.add(r.citationId);
  }

  return {
    userMap: new Map(userRows.map((u) => [u.id, u as UserRef])),
    citationMap,
    judgedCitationIds,
    drugMap,
    pageMap,
    monographSlugMap,
    drugParamsMap: paramsMap,
    currentParamReferencesMap,
    verificationMap,
    openPdfRequestCitationIds: new Set(
      openPdfRequestRows.map((r) => r.citationId),
    ),
    storedPdfCitationIds: new Set(storedPdfRows.map((r) => r.citationId)),
    bioEntityMap,
    paramEntryMap,
  };
}

// Resolve the localized (Norwegian-primary) drug name for a drug_monograph
// wiki page, or undefined for non-monograph pages / unresolvable drugs. Lets
// wiki_fact / wiki_page / wiki_section review cards show the canonical
// substance name ("Valproat") instead of the page's stored title, which may
// be English or stale ("Valproic acid"). Mirrors the parameter/metabolism
// branches' resolveDrugName(drug.names, 'nb') and activeLangCode()'s default.
function monographDrugName(
  page: PageRef,
  drugMap: Map<number, DrugRow>,
): string | undefined {
  if (page.pageType !== 'drug_monograph' || page.drugCid == null) {
    return undefined;
  }
  const drug = drugMap.get(page.drugCid);
  if (!drug) return undefined;
  const name = resolveDrugName(drug.names, 'nb');
  return name || undefined;
}

export function enrichFromMaps(
  row: PendingEditRecord,
  maps: EnrichmentMaps,
): Record<string, unknown> {
  const {
    userMap,
    citationMap,
    judgedCitationIds,
    drugMap,
    pageMap,
    monographSlugMap,
    drugParamsMap,
    currentParamReferencesMap,
    verificationMap,
    openPdfRequestCitationIds,
    storedPdfCitationIds,
    bioEntityMap,
    paramEntryMap,
  } = maps;

  const allReferenceIds =
    row.referenceIds && row.referenceIds.length > 0
      ? row.referenceIds
      : row.referenceId
        ? [row.referenceId]
        : [];

  const submitter = userMap.get(row.submittedBy) ?? null;
  const reviewer = row.reviewedBy
    ? (userMap.get(row.reviewedBy) ?? null)
    : null;

  // `readInFull` rides along on each reference so a card can say which paper
  // still needs reading without holding a remembered — and therefore stale —
  // list of its own. Additive: every existing consumer ignores it.
  const withReviewState = (r: CitationRow) => ({
    ...r,
    readInFull: judgedCitationIds.has(r.id),
  });

  const references = allReferenceIds
    .map((id) => citationMap.get(id))
    .filter((r): r is CitationRow => r !== undefined)
    .map(withReviewState);

  // Parameter edits carry the target parameter's *current* references (from its
  // latest revision) so the review diff can flag a references-only change and
  // mark added/removed citations (#857). Empty for every other edit type.
  const currentReferenceIds =
    row.editType === 'parameter' && row.targetId && row.parameter
      ? (currentParamReferencesMap.get(`${row.targetId}:${row.parameter}`) ??
        [])
      : [];
  const currentReferences = currentReferenceIds
    .map((id) => citationMap.get(id))
    .filter((r): r is CitationRow => r !== undefined)
    .map(withReviewState);
  // paper_review carries its citation in targetId rather than referenceIds;
  // surface it as the card's reference so the reviewer sees the paper.
  const reference =
    references[0] ??
    (row.editType === 'paper_review' && row.targetId
      ? (citationMap.get(row.targetId) ?? null)
      : null);

  // Flag a read-in-full attestation with no full-text evidence on file
  // (open PDF request + no stored PDF) so reviewers scrutinise it (issue:
  // agents must not review from an abstract). Never blocks the edit.
  let readInFullUnverified = false;
  if (row.editType === 'paper_review' && row.targetId) {
    const pv = row.proposedValue as { readInFull?: unknown } | null;
    readInFullUnverified = isReadInFullUnverified(
      Boolean(pv && pv.readInFull === true),
      openPdfRequestCitationIds.has(row.targetId),
      storedPdfCitationIds.has(row.targetId),
    );
  }

  let drugName: string | undefined;
  let drugSlug: string | undefined;
  let drugMolecularWeight: number | undefined;
  let pageTitle: string | undefined;
  let pageSlug: string | undefined;
  let currentValue: unknown;
  let currentContent: unknown;
  let currentContentHtml: string | null | undefined;
  let currentFactText: string | null = null;
  let entitySymbol: string | undefined;
  let entitySlug: string | undefined;
  // For a param_entry update/delete, the live entry contents a reviewer is about
  // to change or remove (value, matrix, scenario, citation, comments).
  let currentEntry: ParameterEntryContents | undefined;
  // For a param_entry, the names of the substances its dose context points at
  // (administered / interacting drug), keyed by drug id. See doseContextDrugIds.
  let doseContextDrugNames: Record<number, string> | undefined;

  if (row.editType === 'bio_entity') {
    // Update edits hydrate the live entity's symbol/slug from the map; create
    // edits (no target row) fall back to the symbol stashed in proposedMeta.
    const entity = row.targetId ? bioEntityMap.get(row.targetId) : undefined;
    const meta = (row.proposedMeta ?? {}) as Record<string, unknown>;
    entitySymbol =
      entity?.symbol ??
      (typeof meta.symbol === 'string' ? meta.symbol : undefined);
    entitySlug = entity?.slug;
  }

  if (row.editType === 'parameter' && row.targetId) {
    const drug = drugMap.get(row.targetId);
    if (drug) {
      // Resolve in the site's primary language (Norwegian). The queue is a
      // Norwegian-default surface; hardcoding 'en' surfaced the English name
      // for any drug that has one (e.g. "Ethyl glucuronide" vs the expected
      // "Etylglukuronid"). resolveDrugName still falls back to English when no
      // 'nb' name exists. Mirrors activeLangCode()'s 'nb' default client-side.
      drugName = resolveDrugName(drug.names, 'nb');
      drugSlug = drug.slug;
      // Use the monograph wiki page slug for the card link so the URL stays
      // correct even when drugs.slug and wiki_pages.slug diverge temporarily.
      pageSlug = monographSlugMap.get(drug.id);
      const paramMap = drugParamsMap.get(drug.id);
      // Surface the drug's molecular weight so the review diff can offer the
      // same molar↔mass conversion tooltip the monograph sidebar shows for
      // concentration-valued parameters (e.g. impairmentConcentration).
      const mwValue = readParameterValue(
        drug as Record<string, unknown>,
        'molecularWeight',
        paramMap,
      );
      if (typeof mwValue === 'number' && Number.isFinite(mwValue)) {
        drugMolecularWeight = mwValue;
      }
      if (row.parameter && isDrugParameterId(row.parameter)) {
        currentValue = readParameterValue(
          drug as Record<string, unknown>,
          row.parameter,
          paramMap,
        );
      }
    }
  } else if (
    (row.editType === 'metabolism' || row.editType === 'receptor_targets') &&
    row.targetId
  ) {
    const drug = drugMap.get(row.targetId);
    if (drug) {
      drugName = resolveDrugName(drug.names, 'nb');
      drugSlug = drug.slug;
      pageSlug = monographSlugMap.get(drug.id);
    }
  } else if (row.editType === 'param_entry') {
    // Resolve the target drug so the review card names it (and links its
    // monograph). create → targetId is the drug id; update/delete → the drug is
    // read from the hydrated entry, whose contents are also surfaced so the
    // reviewer sees exactly what changes or is removed.
    const op = paramEntryOp(row.proposedValue);
    let entryDrugId: number | undefined;
    if (op === 'create') {
      entryDrugId = row.targetId ?? undefined;
    } else if (row.targetId) {
      currentEntry = paramEntryMap.get(row.targetId);
      entryDrugId = currentEntry?.drugId;
    }
    if (entryDrugId != null) {
      const drug = drugMap.get(entryDrugId);
      if (drug) {
        drugName = resolveDrugName(drug.names, 'nb');
        drugSlug = drug.slug;
        pageSlug = monographSlugMap.get(drug.id);
      }
    }
    for (const id of [
      ...doseContextDrugIds(paramEntryPayloadFields(row.proposedValue)),
      ...doseContextDrugIds(currentEntry?.doseContext),
    ]) {
      const named = drugMap.get(id);
      if (named) {
        doseContextDrugNames ??= {};
        doseContextDrugNames[id] = resolveDrugName(named.names, 'nb');
      }
    }
  } else if (row.editType === 'wiki_page' && row.targetId) {
    const page = pageMap.get(row.targetId);
    if (page) {
      pageTitle = page.title;
      pageSlug = page.slug;
      drugName = monographDrugName(page, drugMap);
      currentContent = page.content;
      currentContentHtml = page.contentHtml;
    }
  } else if (row.editType === 'wiki_new') {
    const meta = (row.proposedMeta ?? {}) as Record<string, unknown>;
    if (typeof meta.title === 'string') pageTitle = meta.title;
  } else if (row.editType === 'wiki_section' && row.targetId) {
    const page = pageMap.get(row.targetId);
    if (page) {
      pageTitle = page.title;
      pageSlug = page.slug;
      drugName = monographDrugName(page, drugMap);
    }
  } else if (row.editType === 'wiki_fact' && row.targetId) {
    const page = pageMap.get(row.targetId);
    if (page) {
      pageTitle = page.title;
      pageSlug = page.slug;
      // For a drug monograph, prefer the drug's localized (Norwegian) name
      // over the page's stored title so the queue card stays in sync with the
      // canonical substance name. See monographDrugName.
      drugName = monographDrugName(page, drugMap);
      const anchor = (row.factTargetAnchor ?? {}) as Record<string, unknown>;
      const factId = typeof anchor.factId === 'string' ? anchor.factId : null;
      if (factId && isMonographContentV2(page.content)) {
        const found = findFactInContent(
          page.content as MonographContentV2,
          factId,
        );
        if (found) {
          const node = readFactNodeAt(
            page.content as MonographContentV2,
            found,
          );
          if (node) currentFactText = factNodeToPlaintext(node);
        }
      } else if (factId && page.pageType === 'topic') {
        // Topic pages store facts as top-level siblings of the
        // anchoring heading. Walk the section body slice to pull the
        // current statement so reviewers see what they're replacing
        // or removing — same UX the monograph branch above provides.
        const node = findTopicFactNode(page.content, row.sectionId, factId);
        if (node) currentFactText = factNodeToPlaintext(node);
      }
    }
  }

  return {
    ...row,
    submitter,
    reviewer,
    reference,
    references,
    currentReferenceIds,
    currentReferences,
    drugName,
    drugSlug,
    drugMolecularWeight,
    pageTitle,
    pageSlug,
    currentValue,
    currentContent,
    currentContentHtml: currentContentHtml ?? null,
    currentFactText,
    entitySymbol,
    entitySlug,
    currentEntry,
    doseContextDrugNames,
    readInFullUnverified,
    reviewToken: pendingEditReviewToken(row),
    verifications: verificationMap.get(row.id) ?? emptyVerificationSummary(),
  };
}

async function enrichPendingEdit(
  row: PendingEditRecord,
  canReadDrafts: boolean,
): Promise<Record<string, unknown>> {
  const maps = await buildEnrichmentMaps([row], { canReadDrafts });
  return enrichFromMaps(row, maps);
}

async function fetchAndEnrich(
  id: number,
  role: string,
): Promise<Record<string, unknown>> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(pendingEdits)
    .where(eq(pendingEdits.id, id))
    .limit(1);
  if (!row) throw new Error(`Pending edit ${id} not found`);
  return enrichPendingEdit(
    row,
    await callerCan(role, CAP['wiki.draft.read']),
  );
}

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );

    switch (req.method) {
      case 'GET':
        return handleGet(req, res, url);
      case 'POST':
        assertSameOrigin(req);
        return handleCreate(req, res);
      case 'PATCH':
        assertSameOrigin(req);
        return handlePatch(req, res, url);
      default:
        error(res, 405, 'Method not allowed');
    }
  },
);

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }

  const db = getDb();
  const status = url.searchParams.get('status');
  const editType = url.searchParams.get('editType');
  const submittedBy = url.searchParams.get('submittedBy');
  const targetId = url.searchParams.get('targetId');
  const id = url.searchParams.get('id');
  const countOnly = url.searchParams.get('countOnly') === 'true';

  const conditions = [];
  if (status && status !== 'all')
    conditions.push(eq(pendingEdits.status, status));
  if (editType) conditions.push(eq(pendingEdits.editType, editType));
  if (targetId) conditions.push(eq(pendingEdits.targetId, Number(targetId)));
  if (id) conditions.push(eq(pendingEdits.id, Number(id)));

  // Non-reviewers can only see their own submissions; reviewers (editor+)
  // see everything but may filter via ?submittedBy=. Authenticated users
  // who can't submit edits will simply see an empty list.
  if (!(await callerCan(auth.role, CAP['review.queue.readAll']))) {
    conditions.push(eq(pendingEdits.submittedBy, auth.userId));
  } else if (submittedBy) {
    conditions.push(eq(pendingEdits.submittedBy, Number(submittedBy)));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  if (countOnly) {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pendingEdits)
      .where(whereClause);
    json(res, 200, { count: result?.count ?? 0 });
    return;
  }

  // For the moderator queue (pending list, no specific id) we want disputed
  // edits to surface *regardless* of age — otherwise the LIMIT 100 below
  // hides a dispute that lives on an older row, defeating the rank that
  // pushes disputes to the top. Pull the dispute ids in parallel with the
  // top-100 query and union the two id sets before fetching.
  const isModeratorListView = !id && (!status || status === 'pending');
  let rows;
  // pending_edit ids carrying an OPEN dispute (human or bridged agent). Only
  // populated for the moderator list view, where it floats the edit to the top
  // (human disputes don't register in the agent_verifications-based tally).
  let openDisputeIdSet = new Set<number>();
  if (isModeratorListView) {
    // Build the filter for the dispute-boost query. Always scope to
    // status='pending': the boost exists to surface actionable items, not
    // historical ones. If the caller already passed ?status=pending the
    // condition is redundant but harmless. Starting from the pendingEdits
    // side (rather than agentVerifications) prevents this set from growing
    // O(all-disputes-ever) as resolved pending edits accumulate over time.
    const disputedWhere =
      conditions.length > 0
        ? and(eq(pendingEdits.status, 'pending'), ...conditions)
        : eq(pendingEdits.status, 'pending');
    const [recent, disputedRows, humanDisputedRows] = await Promise.all([
      db
        .select()
        .from(pendingEdits)
        .where(whereClause)
        .orderBy(desc(pendingEdits.submittedAt))
        .limit(100),
      db
        .selectDistinct({ id: pendingEdits.id })
        .from(pendingEdits)
        .innerJoin(
          agentVerifications,
          and(
            eq(agentVerifications.targetType, 'pending_edit'),
            eq(agentVerifications.targetId, pendingEdits.id),
            eq(agentVerifications.verdict, 'dispute'),
            eq(agentVerifications.isImplicit, false),
          ),
        )
        .where(disputedWhere),
      // Human (and bridged agent) disputes live in the unified `disputes`
      // table, which the agent_verifications join above doesn't see. Surface
      // pending edits carrying any OPEN dispute the same way, so a human
      // dispute floats its edit to the top of /review too.
      db
        .selectDistinct({ id: pendingEdits.id })
        .from(pendingEdits)
        .innerJoin(
          disputes,
          and(
            eq(disputes.targetType, 'pending_edit'),
            eq(disputes.targetId, pendingEdits.id),
            eq(disputes.status, 'open'),
          ),
        )
        .where(disputedWhere),
    ]);
    openDisputeIdSet = new Set(humanDisputedRows.map((r) => r.id));
    const recentIds = new Set(recent.map((r) => r.id));
    const extraIds = [...disputedRows, ...humanDisputedRows]
      .map((r) => r.id)
      .filter((id, i, arr) => arr.indexOf(id) === i && !recentIds.has(id));
    let extraRows: typeof recent = [];
    if (extraIds.length > 0) {
      // disputedRows already satisfies the full whereClause + status='pending',
      // so the extra fetch only needs the id IN (...) guard.
      extraRows = await db
        .select()
        .from(pendingEdits)
        .where(inArray(pendingEdits.id, extraIds))
        .orderBy(desc(pendingEdits.submittedAt))
        // Cap the dispute boost so a queue where agents have disputed many
        // old submissions can't return thousands of rows. 100 is enough to
        // surface every dispute even in a busy queue; the final 100-cap
        // after the rerank below picks the most relevant ones.
        .limit(100);
    }
    rows = [...recent, ...extraRows];
  } else {
    rows = await db
      .select()
      .from(pendingEdits)
      .where(whereClause)
      .orderBy(desc(pendingEdits.submittedAt))
      .limit(id ? 1 : 100);
  }

  if (rows.length === 0) {
    json(res, 200, { pendingEdits: [] });
    return;
  }

  // Batch-fetch all referenced users, drugs, wiki pages, and citations in
  // 5 parallel queries rather than issuing per-row queries for each.
  const maps = await buildEnrichmentMaps(rows, {
    canReadDrafts: await callerCan(auth.role, CAP['wiki.draft.read']),
  });
  const enriched = rows.map((row) => enrichFromMaps(row, maps));
  // Tag every row an open dispute contests. The moderator list view already
  // has the set (it drives the rank below); the other views — a single-id
  // lookup, a status filter — need their own lookup, because the card reads
  // this flag to decide whether to show the dispute and its resolve controls.
  // A card that hid them was the whole complaint: the approve button refused
  // with "resolve the dispute first" and offered nothing to resolve it with.
  if (!isModeratorListView) {
    openDisputeIdSet = await openDisputeTargetIds({
      targetType: 'pending_edit',
      targetIds: enriched.map((e) => e.id as number),
    });
  }
  // …and every row an objection was *upheld* against, which closes the dispute
  // without freeing the proposal: its author may return, reject or revise it,
  // but not approve it (see selfApprovalBlockedByUpheldDispute). The card
  // mirrors that rule, so the ruling has to travel with the row.
  const [upheldAt, unresolvedDisputes] = await Promise.all([
    upheldDisputeResolvedAt({
      targetType: 'pending_edit',
      targetIds: enriched.map((e) => e.id as number),
    }),
    // How many dispute verdicts a moderator has NOT ruled on. The raw tally in
    // `verifications.disputeCount` never falls — a verdict is testimony and
    // cannot be closed — so ranking and badging off it pinned an overruled
    // edit to the top of the queue under a red "Bestridt" forever.
    unresolvedDisputeVerdictCounts({
      targetType: 'pending_edit',
      targetIds: enriched.map((e) => e.id as number),
    }),
  ]);
  for (const e of enriched) {
    e.disputeUpheld = anyUpheldRulingStands({
      rulings: upheldAt.get(e.id as number),
      revisedAt: payloadRevisedAt(e.proposedMeta),
    });
    e.hasOpenDispute = openDisputeIdSet.has(e.id as number);
    const summary = e.verifications as VerificationSummary | undefined;
    if (summary) {
      (summary as VerificationSummary & { unresolvedDisputeCount: number })
        .unresolvedDisputeCount = unresolvedDisputes.get(e.id as number) ?? 0;
    }
  }
  // Why agent consensus has (not) published each edit (issue #1357's review
  // card), batched for the whole page instead of one GET per card (#1374).
  // Mirrors the client's own gate for showing the note — only a pending edit
  // with at least one approval and no unresolved dispute can have anything to
  // explain — so a queue full of untouched proposals costs nothing extra here.
  const consensusEligibleIds = enriched
    .filter((e) => {
      if (e.status !== 'pending') return false;
      const summary = e.verifications as
        | (VerificationSummary & { unresolvedDisputeCount?: number })
        | undefined;
      if (!summary || summary.approveCount < 1) return false;
      return (summary.unresolvedDisputeCount ?? summary.disputeCount) === 0;
    })
    .map((e) => e.id as number);
  if (consensusEligibleIds.length > 0) {
    // An active agent does not review what it wrote (AGENTS.md "Self-review"):
    // `GET /api/agent-verifications?targetId=` 404s a non-self-review agent's
    // own submission rather than reveal peer verdicts on it. The consensus
    // explanation is derived from those same verdicts (and, for a missing-
    // flagship hold, names the peer approvers), so it needs the identical
    // visibility check before this list response can attach it — a reviewer
    // (review.queue.readAll) sees every row here regardless, same as the
    // single-target endpoint.
    // Advisory only (issue #1421): a failure here must not turn the note this
    // decorates into a prerequisite for loading the queue at all.
    try {
      const callerAgent = await resolveActiveAgent(auth.userId);
      const consensusVisibleIds = await visibleVerificationTargetIds({
        targetType: 'pending_edit',
        targetIds: consensusEligibleIds,
        callerUserId: auth.userId,
        callerRole: auth.role,
        callerAgentId: callerAgent?.id ?? null,
        callerSelfReviews: callerAgent?.selfReviewEnabled,
        includeCallerVerdicts: true,
      });
      const consensusMap = await consensusStatusForTargets(consensusVisibleIds);
      for (const e of enriched) {
        const status = consensusMap.get(e.id as number);
        if (status) e.consensusStatus = status;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[pending-edits] consensusStatus batch failed: ${message}`);
    }
  }
  // Re-rank for the moderator queue: disputes float to the top, items with
  // ≥2 explicit agent approvals and zero disputes sink to the bottom so
  // moderators can skim them fast. Submitted-at stays as the tiebreaker.
  // Single-id lookups (?id=N) and non-pending statuses keep the original
  // submittedAt-desc order so history views are stable.
  if (isModeratorListView) {
    enriched.sort((a, b) => {
      const rankDelta = verificationSortRank(a) - verificationSortRank(b);
      if (rankDelta !== 0) return rankDelta;
      // submitted_at desc within the same rank bucket. Compare epoch ms so
      // the tiebreaker is chronological — String(Date) renders as
      // "Wed Jun 02 2026 ..." which sorts on weekday/month text, not time.
      return submittedAtMs(b) - submittedAtMs(a);
    });
    // Final cap on the merged + reranked list. The 100-row recent fetch
    // alone was already bounded; the dispute boost added another batch that
    // could push the response well over 100 rows in queues with many old
    // disputed edits. Slicing here preserves the rank order (disputes first)
    // while keeping the payload bounded.
    if (enriched.length > 100) enriched.length = 100;
  }
  json(res, 200, { pendingEdits: enriched });
}

function verificationSortRank(row: Record<string, unknown>): number {
  // An open human/bridged dispute floats the edit to the top alongside agent
  // dispute verdicts, even though it doesn't register in the verification tally.
  if (row.hasOpenDispute === true) return 0;
  const v = row.verifications as
    | (VerificationSummary & { unresolvedDisputeCount?: number })
    | undefined;
  if (!v) return 1;
  // Only objections still awaiting a decision float. A ruled-on verdict stays
  // in the record but stops competing for the moderator's attention.
  if ((v.unresolvedDisputeCount ?? v.disputeCount) > 0) return 0;
  if (v.approveCount >= 2) return 2;
  return 1;
}

function submittedAtMs(row: Record<string, unknown>): number {
  const raw = row.submittedAt;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'string' || typeof raw === 'number') {
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? t : 0;
  }
  return 0;
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }

  const parsed = await parseAndValidate(req, createPendingEditSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  if (parsed.data.editType === 'parameter') {
    error(
      res,
      400,
      'Parameter edits must be submitted via /api/drug-parameter',
    );
    return;
  }

  // Allowlist: only contributor+ may submit pending edits. This fails
  // closed for stale or non-canonical roles (e.g. legacy 'viewer' rows
  // on a pre-0017 DB or a restored snapshot) instead of relying on a
  // denylist that would silently let unknown roles through. Mirrors
  // the canContribute() guard on /api/drug-parameter and /api/wiki/pages.
  if (
    !(await callerCan(auth.role, capabilityForEditType(parsed.data.editType)))
  ) {
    error(
      res,
      403,
      'Contributor role or higher required to submit pending edits.',
    );
    return;
  }
  // Whole-page wiki_page / wiki_new submissions are admin-only (#310).
  // Every non-admin contribution flows through atomic facts (wiki_fact)
  // so reviewers never have to diff prose paragraphs. Admin retains the
  // escape hatch for one-off corrections that don't fit the fact model.
  if (
    !(await callerCan(auth.role, CAP['wiki.page.submit'])) &&
    (parsed.data.editType === 'wiki_page' ||
      parsed.data.editType === 'wiki_new')
  ) {
    error(
      res,
      403,
      `Whole-page ${parsed.data.editType} edits are admin-only; ` +
        `submit atomic-fact monograph edits (editType="wiki_fact") instead.`,
      'wiki_admin_only_whole_page',
    );
    return;
  }

  // ─── Admin agent-focus gate on agent-authored wiki content ────────────
  // The focus config an admin sets in the admin panel is the answer to "what
  // should the scheduled agents work on this cycle". Until this gate it only
  // narrowed the parameter queues, so an admin who picked `mode = "parameters"`
  // and a handful of parameter ids still got a monograph fact on an unrelated
  // drug every cycle: the wiki-content action walked popularity order, entirely
  // unscoped. Selecting parameters says what the agents may author, not merely
  // which of several queues gets filtered.
  //
  // Enforced here rather than left to the routine prompts because the prompts
  // are advice a model can drift from, while this is the single door every
  // agent-authored fact goes through — the drug-db maintainer's wiki-content
  // action and the paper fact-extractor's distribution step alike. Humans are
  // deliberately unaffected: an editor narrowing the *agents* has not narrowed
  // themselves. So is every non-monograph agent activity — parameters, paper
  // reviews, PDF requests/fulfilment, the discussion and approval sweeps —
  // which is the point: this gate only governs `wiki_fact` / `wiki_section`.
  //
  // `wiki_page` and `wiki_new` go through here too, though they are admin-tier
  // by default: `wiki.page.submit` carries `floorTier: 'editor'`, so an admin
  // may delegate it down and an editor-role agent identity then reaches this
  // branch. Gating only the two atomic-fact types would leave the guard's
  // promise resting on a permission nobody has to keep where it is.
  //
  // One exemption: a `wiki_fact` filed under a live paper-extraction claim.
  // An editor queued that paper for extraction on purpose, which is a
  // narrower and more recent instruction than the standing focus, so the
  // focus must not leave the queue stranded. The claim is verified here —
  // same identity, same token, not stale, and the fact cites the job's paper —
  // so the exemption cannot be borrowed for unrelated content.
  if (parsed.data.paperExtraction) {
    const claimCitationId = await liveClaimCitationId({
      jobId: parsed.data.paperExtraction.jobId,
      claimToken: parsed.data.paperExtraction.claimToken,
      userId: auth.userId,
    });
    if (claimCitationId === null) {
      error(
        res,
        409,
        'You no longer hold this paper-extraction claim: the job was ' +
          'cancelled or the claim expired. Stop the run and submit nothing ' +
          'further for it.',
        'paper_extraction_not_claim_holder',
      );
      return;
    }
    const cited =
      parsed.data.referenceIds ??
      (parsed.data.referenceId ? [parsed.data.referenceId] : []);
    if (!cited.includes(claimCitationId)) {
      error(
        res,
        400,
        `A fact filed under a paper-extraction job must cite that job's ` +
          `paper (citation ${claimCitationId}) in referenceIds.`,
        'paper_extraction_reference_mismatch',
      );
      return;
    }
  } else if (
    isWikiContentEditType(parsed.data.editType) &&
    (await isActiveAgentUser(auth.userId))
  ) {
    const refusal = await wikiEditFocusRefusal(
      parsed.data.editType,
      parsed.data.targetId ?? null,
      parsed.data.proposedMeta ?? null,
    );
    if (refusal) {
      error(res, 403, refusal, 'agent_focus_out_of_scope');
      return;
    }
  }

  const referenceIds =
    parsed.data.referenceIds ??
    (parsed.data.referenceId ? [parsed.data.referenceId] : null);
  const primaryReferenceId = referenceIds?.[0] ?? null;

  // Learning units must anchor a source that already carries a read-in-full
  // review (same gate facts/parameters use). This avoids re-reviewing the
  // source: the unit consumes the existing paper_review instead.
  if (parsed.data.editType === 'learning_unit') {
    const anchorIds =
      parsed.data.referenceIds ??
      (parsed.data.referenceId ? [parsed.data.referenceId] : []);
    try {
      await assertReferencesJudged(anchorIds);
    } catch (err) {
      error(
        res,
        400,
        'Learning units must anchor a source with a read-in-full review.',
        'learning_unit_unreviewed_source',
      );
      return;
    }
  }

  // Clinical cases must cite at least one source/guideline/label they interpret,
  // but — unlike learning units — they are NOT paper-gated: a case interprets
  // guidelines/labels that carry no read-in-full review, so assertReferencesJudged
  // is deliberately NOT called here (spec §5.4 / clinical-case-builder.md).
  if (parsed.data.editType === 'clinical_case') {
    if (!referenceIds || referenceIds.length < 1) {
      error(
        res,
        400,
        'Clinical cases must cite at least one source they interpret.',
        'clinical_case_missing_source',
      );
      return;
    }
    // Every cited reference must resolve to a real citation. The apply path
    // stores referenceIds[0] as learning_units.citation_id (a NOT NULL FK with
    // ON DELETE RESTRICT), so a bogus id would otherwise slip past submission
    // and only surface as a confusing foreign-key error at approval time.
    // Catch it here with a clear 400 instead.
    const uniqueRefIds = [...new Set(referenceIds)];
    const found = await getDb()
      .select({ id: citations.id })
      .from(citations)
      .where(inArray(citations.id, uniqueRefIds));
    if (found.length !== uniqueRefIds.length) {
      error(
        res,
        400,
        'One or more cited references do not resolve to a citation.',
        'clinical_case_unknown_reference',
      );
      return;
    }
  }

  // ─── wiki_fact: materialize the fact node + section/op columns ─────────
  // The client supplies the raw inputs (statement, refs, anchor); the API
  // builds the canonical MonographFactNode that approval will splice into
  // the page so the fact's identity (factId) is stamped server-side and
  // shows in the review queue verbatim.
  let proposedValueForFact: unknown = parsed.data.proposedValue;
  let factColumns: {
    sectionId: string | null;
    fieldId: string | null;
    factStatement: string | null;
    factOperation: 'add' | 'replace' | 'remove' | 'reorder' | null;
    factTargetAnchor: { factId: string } | null;
  } = {
    sectionId: null,
    fieldId: null,
    factStatement: null,
    factOperation: null,
    factTargetAnchor: null,
  };
  if (parsed.data.editType === 'wiki_fact') {
    // Look up the target page once; the sectionId / fieldId validation
    // depends on pageType — monographs use the fixed schema in
    // monographSections.ts, topic pages (#348) use the heading-anchored
    // sectionIds minted into their own content.
    const db = getDb();
    const [targetPage] = await db
      .select({
        pageType: wikiPages.pageType,
        content: wikiPages.content,
        status: wikiPages.status,
      })
      .from(wikiPages)
      .where(eq(wikiPages.id, parsed.data.targetId!))
      .limit(1);
    if (!targetPage) {
      error(res, 404, `Target wiki page ${parsed.data.targetId} not found`);
      return;
    }
    // Mirror the visibility rules /api/wiki/pages applies before
    // returning page content. Without this, a contributor could submit
    // wiki_fact edits against an unpublished page they can't actually
    // read — and the topic-page branch below would even leak the
    // page's section structure via the validation error message.
    if (!(await callerCanReadWikiPage(targetPage.status, { role: auth.role }))) {
      error(res, 404, `Target wiki page ${parsed.data.targetId} not found`);
      return;
    }

    if (targetPage.pageType === 'drug_monograph') {
      // Reject monograph reorder up front. The approval handler
      // also refuses it (the splice in monographContent.applyFactOp
      // throws), but persisting an unapprovable pending row would
      // pollute the queue and force a reviewer to manually reject.
      // Better to bounce the submission immediately. Filed as a
      // follow-up on #358.
      if (parsed.data.factOperation === 'reorder') {
        error(
          res,
          400,
          'wiki_fact reorder is not yet supported on drug-monograph pages',
          'wiki_fact_reorder_unsupported_pagetype',
        );
        return;
      }
      if (!isMonographSectionId(parsed.data.sectionId!)) {
        error(res, 400, `Unknown sectionId "${parsed.data.sectionId}"`);
        return;
      }
      // Reject typo'd or otherwise unknown fieldIds at the boundary. The
      // v2 renderer only walks schema-declared fields
      // (iterateSectionBodies in monographContent.ts), so an ad-hoc
      // fieldId would create a storage slot that never reaches
      // contentHtml/contentPlaintext — the approved fact would silently
      // disappear from the page.
      if (parsed.data.fieldId) {
        const field = getMonographField(
          parsed.data.sectionId!,
          parsed.data.fieldId,
        );
        const isRetiredField = isMergedMonographFieldId(
          parsed.data.sectionId!,
          parsed.data.fieldId,
        );
        if (!field && !isRetiredField) {
          error(
            res,
            400,
            `Unknown fieldId "${parsed.data.fieldId}" for section "${parsed.data.sectionId}"`,
          );
          return;
        }
      }
    } else if (targetPage.pageType === 'topic') {
      // Topic pages don't have a schema; sectionIds come from headings
      // minted by the #348 migration. Validate two things: the id
      // matches the slug shape (so tampered submissions can't sneak in
      // arbitrary strings) and it actually exists on the target page.
      // The error responses carry stable `code` fields so the React
      // panels can render a localised string (AGENTS.md i18n rule).
      const sid = parsed.data.sectionId!;
      if (!isValidTopicSectionId(sid)) {
        error(
          res,
          400,
          `Invalid topic sectionId "${sid}"`,
          'wiki_fact_invalid_topic_section_id',
        );
        return;
      }
      const known = listTopicSectionIds(targetPage.content as never);
      if (!known.includes(sid)) {
        error(
          res,
          400,
          `sectionId "${sid}" not found on target page; ` +
            `known sectionIds: ${known.join(', ') || '(none)'}`,
          'wiki_fact_section_not_found',
        );
        return;
      }
      if (parsed.data.fieldId) {
        // Topic pages don't have schema-defined fields. Reject rather
        // than silently store — phase 3 will introduce a separate
        // section CRUD path.
        error(
          res,
          400,
          `fieldId is not supported on topic pages (sectionId="${sid}")`,
          'wiki_fact_topic_field_not_supported',
        );
        return;
      }
    } else {
      error(
        res,
        400,
        `wiki_fact does not support pageType="${targetPage.pageType}"`,
      );
      return;
    }
    const op = parsed.data.factOperation!;
    // Reference gate: an agent may only cite resolvable references that have
    // been read in full and judged (add/replace carry references; remove and
    // reorder don't). Human contributors are exempt — they are trusted to have
    // read the paper, and the cited source joins the agent review queue
    // automatically once the fact is live.
    if (op === 'add' || op === 'replace') {
      try {
        await assertReferencesJudgedForActor(referenceIds ?? [], auth.userId);
      } catch (err) {
        if (err instanceof ReferenceGateError) {
          error(res, 400, err.message, 'reference_not_judged');
          return;
        }
        throw err;
      }
    }
    if (op === 'add') {
      proposedValueForFact = createFactNode({
        factId: randomUUID(),
        statement: parsed.data.factStatement!,
        referenceIds: referenceIds!,
        content: sanitizeSubmittedFactContent(
          parsed.data.proposedValue,
          parsed.data.factStatement!,
        ),
      });
    } else if (op === 'replace') {
      proposedValueForFact = createFactNode({
        // Preserve the existing anchor so other pending edits targeting
        // the same factId still resolve after approval.
        factId: parsed.data.factTargetAnchor!.factId,
        statement: parsed.data.factStatement!,
        referenceIds: referenceIds!,
        content: sanitizeSubmittedFactContent(
          parsed.data.proposedValue,
          parsed.data.factStatement!,
        ),
      });
    } else if (op === 'reorder') {
      // Reorder ships the destination index in proposedValue.position
      // (validated by the schema's superRefine block). Echo the
      // factId in the marker so the review queue can render it
      // without re-resolving via factTargetAnchor.
      const incoming = parsed.data.proposedValue as { position: number };
      proposedValueForFact = {
        position: incoming.position,
        factId: parsed.data.factTargetAnchor!.factId,
      };
    } else {
      // remove ops carry no replacement body, but pending_edits.proposed_value
      // is jsonb NOT NULL. Store a small marker so the column stays
      // populated and the review queue has a deterministic shape to render
      // (instead of a null that would either crash the insert or force
      // every consumer to special-case removes).
      proposedValueForFact = {
        removed: true,
        factId: parsed.data.factTargetAnchor!.factId,
      };
    }
    factColumns = {
      sectionId: parsed.data.sectionId!,
      fieldId: parsed.data.fieldId ?? null,
      factStatement: parsed.data.factStatement ?? null,
      factOperation: op,
      factTargetAnchor: parsed.data.factTargetAnchor ?? null,
    };
  }

  // ─── wiki_section: validate payload + section anchor (#349) ────────────
  // Section CRUD is topic-page-only and contributor-or-higher. The
  // payload shape (operation + op-specific fields) was already parsed
  // by the schema's superRefine; here we verify the target page is
  // visible to the submitter, is a topic page, and (for non-add ops)
  // that the named sectionId still exists. Approval will re-check the
  // same invariants against the live page content.
  let wikiSectionColumns: { sectionId: string | null } = { sectionId: null };
  if (parsed.data.editType === 'wiki_section') {
    const dbForCheck = getDb();
    const [targetPage] = await dbForCheck
      .select({
        pageType: wikiPages.pageType,
        content: wikiPages.content,
        status: wikiPages.status,
      })
      .from(wikiPages)
      .where(eq(wikiPages.id, parsed.data.targetId!))
      .limit(1);
    if (!targetPage) {
      error(res, 404, `Target wiki page ${parsed.data.targetId} not found`);
      return;
    }
    if (!(await callerCanReadWikiPage(targetPage.status, { role: auth.role }))) {
      error(res, 404, `Target wiki page ${parsed.data.targetId} not found`);
      return;
    }
    if (targetPage.pageType !== 'topic') {
      error(
        res,
        400,
        `wiki_section is only supported on topic pages (got pageType="${targetPage.pageType}")`,
        'wiki_section_unsupported_page_type',
      );
      return;
    }
    const payload = wikiSectionPayloadSchema.parse(parsed.data.proposedValue);
    if (payload.operation !== 'add') {
      const sid = parsed.data.sectionId!;
      if (!isValidTopicSectionId(sid)) {
        error(
          res,
          400,
          `Invalid topic sectionId "${sid}"`,
          'wiki_section_invalid_section_id',
        );
        return;
      }
      const known = listTopicSectionIds(targetPage.content as never);
      if (!known.includes(sid)) {
        error(
          res,
          400,
          `sectionId "${sid}" not found on target page`,
          'wiki_section_not_found',
        );
        return;
      }
      wikiSectionColumns.sectionId = sid;
    }
  }

  // Drug-scoped submits (wiki_page / wiki_fact against a drug_monograph, and
  // wiki_new which carries the drugCid in proposed_meta) race with the drug
  // merge admin: without the lock, a submission that lands between the
  // merge's initial monograph-proposal scan and the delete-teardown step 9
  // would either be swept along with the page (making the request's success
  // response a lie) or survive as an orphan against a deleted page. Take the
  // same per-drug advisory lock the merge uses, then re-verify the target
  // page / drug still exists inside the transaction before inserting.
  const lockRes = await resolveLockDrugId(parsed);
  if (lockRes.kind === 'target_missing') {
    // The edit is drug-scoped but its target (page or drug) is gone. A
    // concurrent merge deleted it between the route's earlier validation
    // and here. Refuse rather than file a proposal that could never be
    // approved.
    error(res, 404, 'Target no longer exists');
    return;
  }
  const lockDrugId = lockRes.kind === 'drug_scoped' ? lockRes.drugId : null;
  const insertPending = async () => {
    return await getDb()
      .insert(pendingEdits)
      .values({
        editType: parsed.data.editType,
        targetId: parsed.data.targetId ?? null,
        parameter: parsed.data.parameter ?? null,
        proposedValue: proposedValueForFact as never,
        // A row is not a revision of itself, and a marker planted at creation
        // would pre-empt every objection ever raised against it.
        proposedMeta: (withoutRevisionMarker(parsed.data.proposedMeta) ??
          null) as never,
        referenceId: primaryReferenceId,
        referenceIds: referenceIds ?? undefined,
        status: parsed.data.status ?? 'pending',
        submittedBy: auth.userId,
        sectionId: factColumns.sectionId ?? wikiSectionColumns.sectionId,
        fieldId: factColumns.fieldId,
        factStatement: factColumns.factStatement,
        factOperation: factColumns.factOperation,
        factTargetAnchor: factColumns.factTargetAnchor as never,
      })
      .returning();
  };

  type SubmitOutcome =
    | { kind: 'ok'; row: typeof pendingEdits.$inferSelect }
    | { kind: 'gone' };
  let outcome: SubmitOutcome;
  if (lockDrugId != null) {
    outcome = await runInPoolTransaction<SubmitOutcome>(async () => {
      await lockDrugForEntryApplicability(lockDrugId);
      // Re-verify the target under the lock. For wiki_page/wiki_fact the
      // target is the page id; for wiki_new the target is a drug that must
      // still exist.
      if (
        parsed.data.editType === 'wiki_page' ||
        parsed.data.editType === 'wiki_fact'
      ) {
        const [pageInTx] = await getDb()
          .select({ id: wikiPages.id })
          .from(wikiPages)
          .where(eq(wikiPages.id, parsed.data.targetId!))
          .limit(1);
        if (!pageInTx) return { kind: 'gone' };
      } else if (parsed.data.editType === 'wiki_new') {
        const [drugInTx] = await getDb()
          .select({ id: drugs.id })
          .from(drugs)
          .where(eq(drugs.id, lockDrugId))
          .limit(1);
        if (!drugInTx) return { kind: 'gone' };
      }
      const [row] = await insertPending();
      if (!row) throw new Error('pendingEdits insert returned no row');
      return { kind: 'ok', row };
    });
  } else {
    const [rowNoLock] = await insertPending();
    outcome = rowNoLock
      ? { kind: 'ok', row: rowNoLock }
      : { kind: 'gone' };
  }

  if (outcome.kind === 'gone') {
    error(res, 404, 'Target no longer exists');
    return;
  }
  const row = outcome.row;

  // If an active agent submitted this edit, stamp the implicit-approve row so
  // the submitter's stake is captured (and the agent itself can't later add
  // a second explicit verdict against the same target — POST handler blocks
  // self-verification).
  await recordImplicitAgentApproval({
    userId: auth.userId,
    targetType: 'pending_edit',
    targetId: row.id,
  });

  // Shadow mirror (§12.1, Phase 4 of the knowledge-governance extraction).
  // The pending edit is already inserted and authoritative; this records the
  // equivalent generic proposal + version after the fact and can never reject
  // the submission (§12.4). It returns immediately unless `pending_edit` has
  // been advanced past `legacy_only` in kg_migration_state, which nothing
  // ships as. Not awaited, so it adds no latency to the 201.
  fireAndForgetMirror(
    mirrorProposalVersion({
      targetType: 'pending_edit',
      targetId: row.id,
      legacyPendingEditId: row.id,
    }),
  );

  json(res, 201, {
    pendingEdit: await enrichPendingEdit(
      row,
      await callerCan(auth.role, CAP['wiki.draft.read']),
    ),
  });
}

/**
 * Which drug's per-drug advisory lock the pending-edit submission should
 * take, or `null` if the edit type is not drug-scoped. For wiki_page /
 * wiki_fact against a `drug_monograph`, this is the page's `drug_cid`. For
 * `wiki_new`, it's the drug id in `proposed_meta.drugCid`. Everything else
 * (wiki_section on topic pages, non-drug edits) has no drug scope and
 * doesn't participate in the drug-merge race, so we skip the lock and let
 * the insert run outside a transaction.
 */
/**
 * Result of resolving the drug id to lock for a pending-edit submission.
 * - `not_drug_scoped`: the edit type doesn't touch a drug (e.g. wiki_section
 *   on a topic page, non-monograph wiki_page); insert without locking.
 * - `drug_scoped`: the edit belongs to a drug; take the advisory lock on
 *   `drugId` and re-verify the target under it.
 * - `target_missing`: the edit is drug-scoped but the target
 *   page/drug is gone (a concurrent merge or delete removed it between the
 *   route's earlier validation and here). Return 404 — never insert a
 *   dangling proposal.
 */
/**
 * The edit types that put prose on a wiki page. The agent-focus gate covers
 * all four, not just the two atomic-fact ones it began with: `wiki_page` and
 * `wiki_new` are admin-tier by DEFAULT, but `wiki.page.submit` carries
 * `floorTier: 'editor'`, so an admin may delegate them to the editor tier and
 * an editor-role agent identity then reaches them. A guard that holds only
 * until someone adjusts the permission matrix is not a guard.
 */
function isWikiContentEditType(editType: string): boolean {
  return (
    editType === 'wiki_fact' ||
    editType === 'wiki_section' ||
    editType === 'wiki_page' ||
    editType === 'wiki_new'
  );
}

/**
 * The `proposed_meta` a submitter PATCH will actually persist.
 *
 * `undefined` means the field was omitted, so the stored bag stands; `null` is
 * an explicit clear that the write honours. `??` collapses the two and is the
 * wrong test for any guard claiming to judge the post-update state — it reads
 * the old bag on exactly the payload that replaces it. The persistence path
 * keys on `!== undefined`, so every reader of the next value goes through here
 * rather than restating the rule and drifting from it.
 */
function nextProposedMeta(
  data: { proposedMeta?: unknown },
  edit: { proposedMeta: unknown },
): unknown {
  return data.proposedMeta !== undefined ? data.proposedMeta : edit.proposedMeta;
}

/**
 * The agent-focus refusal for a wiki-content edit, dispatched on what the edit
 * actually targets.
 *
 * `wiki_new` names no page — it proposes one — so the gate judges the page the
 * approval will CREATE, which is `proposed_meta` and nothing else. Both fields
 * matter and for the same reason: `applyApprovedEdit` reads
 * `meta.pageType ?? 'topic'` for the new page's type and `meta.drugCid` for
 * its drug, so judging the drug alone would let a `wiki_new` naming an
 * in-scope component drug publish a TOPIC page under a mode that permits only
 * that component's monograph. The default is `'topic'`, so a `wiki_new` that
 * says nothing about its type is not a monograph however its drug resolves.
 *
 * The drug goes through the same legacy-CID precedence `resolveLockDrugId`
 * uses, so the gate and the lock cannot disagree about which drug an edit
 * belongs to. An edit that names no page AND no resolvable drug is judged as a
 * new page with no drug: refused under every narrowing, allowed under `all`.
 * `wiki_fact` / `wiki_section` never reach that branch, because the schema
 * requires their `targetId`.
 */
async function wikiEditFocusRefusal(
  editType: string,
  targetId: number | null,
  proposedMeta: unknown,
): Promise<string | null> {
  if (editType !== 'wiki_new' && targetId != null) {
    return await wikiContentFocusRefusal(targetId);
  }
  const meta = proposedMeta as
    | { drugCid?: unknown; pageType?: unknown }
    | null;
  // Mirrors applyApprovedEdit's own default; see the note above.
  const pageType =
    typeof meta?.pageType === 'string' ? meta.pageType : 'topic';
  const drugCid = meta?.drugCid;
  const drugId =
    pageType === 'drug_monograph' &&
    typeof drugCid === 'number' &&
    Number.isSafeInteger(drugCid)
      ? await resolveOwningDrugIdForMonograph(getDb(), drugCid)
      : null;
  return await wikiTargetFocusRefusal({
    pageId: null,
    pageType,
    drugId: drugId ?? null,
  });
}

type LockResolution =
  | { kind: 'not_drug_scoped' }
  | { kind: 'drug_scoped'; drugId: number }
  | { kind: 'target_missing' };

async function resolveLockDrugId(
  parsed: { data: z.infer<typeof createPendingEditSchema> },
): Promise<LockResolution> {
  const editType = parsed.data.editType;
  if (
    (editType === 'wiki_page' || editType === 'wiki_fact') &&
    parsed.data.targetId != null
  ) {
    const [page] = await getDb()
      .select({ pageType: wikiPages.pageType, drugCid: wikiPages.drugCid })
      .from(wikiPages)
      .where(eq(wikiPages.id, parsed.data.targetId))
      .limit(1);
    if (!page) return { kind: 'target_missing' };
    if (page.pageType !== 'drug_monograph' || page.drugCid == null) {
      return { kind: 'not_drug_scoped' };
    }
    // `page.drug_cid` may be a legacy PubChem CID rather than the drug's
    // internal id; the merge locks by `drugs.id`, so we must resolve to
    // the owning `drugs.id` before locking or the two paths would not
    // serialize on the same key.
    const owningId = await resolveOwningDrugIdForMonograph(getDb(), page.drugCid);
    if (owningId == null) return { kind: 'target_missing' };
    return { kind: 'drug_scoped', drugId: owningId };
  }
  if (editType === 'wiki_new') {
    const drugCid = (parsed.data.proposedMeta as { drugCid?: unknown })
      ?.drugCid;
    if (typeof drugCid !== 'number' || !Number.isSafeInteger(drugCid)) {
      return { kind: 'not_drug_scoped' };
    }
    // Same legacy-CID resolution as above — wiki_new's proposed_meta.drugCid
    // is the same mixed-vintage shape as wiki_pages.drug_cid.
    const owningId = await resolveOwningDrugIdForMonograph(getDb(), drugCid);
    if (owningId == null) return { kind: 'target_missing' };
    return { kind: 'drug_scoped', drugId: owningId };
  }
  return { kind: 'not_drug_scoped' };
}

/**
 * Run a `param_entry` payload rewrite under `withParamEntryPayloadLocks`, for
 * the payload as it will be stored AFTER the write. Any other edit type, or a
 * payload too malformed to name its op (the write rules refuse it elsewhere),
 * writes as before.
 */
async function underParamEntryLocks<T>(
  edit: typeof pendingEdits.$inferSelect,
  nextProposedValue: unknown,
  write: () => Promise<T>,
): Promise<ParamEntryLockedResult<T>> {
  const parts =
    edit.editType === 'param_entry' ? paramEntryPayloadParts(nextProposedValue) : null;
  if (!parts || edit.targetId == null) return { refused: null, value: await write() };
  return withParamEntryPayloadLocks(
    { op: parts.op, targetId: edit.targetId, proposedValue: nextProposedValue },
    write,
  );
}

function refuseParamEntryRevision(res: ServerResponse, refusal: ParamEntryLockRefusal): void {
  if (refusal.refused === 'drug_missing') {
    error(
      res,
      409,
      `The proposal names substance #${refusal.drugId}, which no longer exists`,
      'param_entry_drug_missing',
    );
  } else if (refusal.refused === 'target_moved') {
    error(
      res,
      409,
      'The entry was moved to another substance while this revision was being written; reload and try again',
      'param_entry_target_moved',
    );
  } else {
    error(res, 409, 'The proposal target no longer exists', 'param_entry_target_missing');
  }
}

async function handlePatch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }

  const id = Number(url.searchParams.get('id'));
  if (!id) {
    error(res, 400, 'Missing id parameter');
    return;
  }

  const parsed = await parseAndValidate(req, patchPendingEditSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const db = getDb();
  const [edit] = await db
    .select()
    .from(pendingEdits)
    .where(eq(pendingEdits.id, id))
    .limit(1);

  if (!edit) {
    error(res, 404, 'Pending edit not found');
    return;
  }

  if (
    edit.status !== 'pending' &&
    edit.status !== 'draft' &&
    edit.status !== 'returned'
  ) {
    error(res, 400, 'Edit has already been reviewed');
    return;
  }

  const requestedStatus = parsed.data.status;
  const isSubmitter = edit.submittedBy === auth.userId;
  const canReview = await isReviewer(auth.role);
  const canDecideModelStructure =
    !isModelStructureEdit(edit) ||
    (await callerCan(auth.role, CAP['edit.modelStructure.decide']));
  const hasSubmitterPayloadChange = pendingEditPatchChangesPayload(parsed.data);
  const isOwnCancel =
    requestedStatus === 'rejected' && isSubmitter && !hasSubmitterPayloadChange;
  const isSubmitterUpdate =
    isSubmitter &&
    (hasSubmitterPayloadChange ||
      requestedStatus === 'draft' ||
      requestedStatus === 'pending');

  // A revision and a decision are two different acts, and sent together the
  // submitter branch below swallows the decision: it persists the payload but
  // computes `nextStatus` from `pending`/`draft` only, so everything else —
  // `approved`, `returned` — falls through to "keep the current status" and
  // the call answers 200 with the edit still sitting pending. That was
  // unreachable-by-design while a submitter could not decide at all; with
  // review.edit.decideOwn it is a shape someone will send. Refuse it rather
  // than apply half of it: revise first, then decide on the revised row (the
  // payload change re-stamps `submittedAt`, so the decision needs the fresh
  // review token anyway — which is exactly the re-read this forces).
  //
  // `rejected` is not in the list: with no payload change it is `isOwnCancel`
  // (withdraw), and with one it is the same submitter revision it has always
  // been. Neither meaning changed here.
  if (
    isSubmitterUpdate &&
    (requestedStatus === 'approved' || requestedStatus === 'returned')
  ) {
    error(
      res,
      400,
      'Revise and decide are separate calls: PATCH the payload first, then send the decision with the refreshed review token',
      'pending_edit_decision_with_payload_change',
    );
    return;
  }

  if (isSubmitterUpdate) {
    // A submitter who has since been demoted below contributor (e.g. role
    // flipped to 'authenticated' after they created the draft) must not
    // be able to keep updating or re-submitting the draft via PATCH —
    // that would bypass the canContribute gate enforced on the POST and
    // wiki/parameter endpoints. The own-cancel path below still works,
    // so they can always withdraw the draft (status='rejected').
    if (!(await callerCan(auth.role, capabilityForEditType(edit.editType)))) {
      error(
        res,
        403,
        'Contributor role or higher required to update pending edits; you may still withdraw your draft by setting status="rejected".',
      );
      return;
    }
    // Match the POST-side admin gate (#310): non-admins can't keep
    // editing pre-existing wiki_page/wiki_new drafts via PATCH either,
    // since that would resurrect the whole-page submission path the
    // POST guard above closed off.
    if (
      !(await callerCan(auth.role, CAP['wiki.page.submit'])) &&
      isWholePageEditType(edit.editType)
    ) {
      error(
        res,
        403,
        `Whole-page ${edit.editType} edits are admin-only; ` +
          `you may still withdraw the draft by setting status="rejected".`,
        'wiki_admin_only_whole_page',
      );
      return;
    }

    // Same for the agent focus gate on the POST: without it here, an agent
    // whose wiki_fact predates the admin's focus change could keep revising
    // and resubmitting it — replacing the statement and references outright —
    // while a fresh submission of the identical content is refused. A returned
    // or draft row is a live proposal, so leaving this path open would make
    // the restriction bypassable through any row the agent already owns.
    // `isOwnCancel` is deliberately not in this branch, so withdrawing an
    // out-of-scope draft stays possible — that is the outcome we want.
    if (
      isWikiContentEditType(edit.editType) &&
      (await isActiveAgentUser(auth.userId))
    ) {
      const refusal = await wikiEditFocusRefusal(
        edit.editType,
        edit.targetId ?? null,
        // `!== undefined`, never `??`: the schema accepts an explicit
        // `proposedMeta: null`, and the write below keys on the same test. With
        // `??` the two disagree on exactly that payload — the gate would judge
        // the OLD metadata, which for an in-scope `wiki_new` names a component
        // drug and its monograph, while the update stores the null. Approval
        // then reads `meta.pageType ?? 'topic'` off that null and publishes a
        // topic page the focus never admitted. The rule the whole gate rests
        // on: judge what the write will actually leave behind.
        nextProposedMeta(parsed.data, edit) as Record<string, unknown> | null,
      );
      if (refusal) {
        error(
          res,
          403,
          `${refusal} You may still withdraw this edit by setting status="rejected".`,
          'agent_focus_out_of_scope',
        );
        return;
      }
    }

    // A wiki_new draft can carry side effects — a catalog drug, parameter
    // values — that the create endpoint gates separately. Re-check them on
    // resubmit against whatever the payload will be after this PATCH, so a
    // draft written before the policy tightened cannot be pushed back into
    // the queue by someone a fresh submission would now refuse. Through the
    // same `nextProposedMeta` as the focus gate above, and for the same
    // reason: an explicit `proposedMeta: null` must not have this read the old
    // bag while the write stores the new one.
    const resubmitMeta = nextProposedMeta(parsed.data, edit) as Record<
      string,
      unknown
    > | null;
    if (edit.editType === 'wiki_new') {
      if (
        resubmitMeta?.newDrug &&
        !(await callerCan(auth.role, CAP['drug.create']))
      ) {
        error(
          res,
          403,
          'Resubmitting a draft that creates a new drug requires the drug-creation permission.',
          'drug_create_forbidden',
        );
        return;
      }
      if (
        hasParameterBag(resubmitMeta) &&
        !(await callerCan(auth.role, CAP['edit.parameter.submit']))
      ) {
        error(
          res,
          403,
          'Resubmitting a draft that publishes parameter values requires the parameter-edit permission.',
          'parameter_submit_forbidden',
        );
        return;
      }
    }
    // wiki_fact rows lock the factId at submission time. PATCH may freely
    // edit referenceIds, factStatement-driven body content, etc., but
    // attrs.factId is the stable anchor that subsequent replace/remove
    // edits target — letting it be rewritten via PATCH would either
    // duplicate ids on the page or orphan other pending edits whose
    // factTargetAnchor still points at the original.
    if (
      parsed.data.proposedValue !== undefined &&
      changesWikiFactId(edit, parsed.data.proposedValue)
    ) {
      error(
        res,
        400,
        'wiki_fact: factId is immutable; cannot change attrs.factId via PATCH',
      );
      return;
    }
    // The write itself, through the same helper as the two guards above, so
    // the three cannot drift on what "the next metadata" means.
    const suppliedMeta = nextProposedMeta(parsed.data, edit);

    // referenceIds wins over referenceId when both are supplied; if only the
    // singular is supplied, keep them in sync.
    let nextReferenceIds: number[] | null | undefined;
    let nextReferenceId: number | null;
    if (parsed.data.referenceIds !== undefined) {
      nextReferenceIds = parsed.data.referenceIds;
      nextReferenceId = parsed.data.referenceIds?.[0] ?? null;
    } else if (parsed.data.referenceId !== undefined) {
      nextReferenceId = parsed.data.referenceId;
      nextReferenceIds =
        parsed.data.referenceId === null ? null : [parsed.data.referenceId];
    } else {
      nextReferenceId = edit.referenceId;
      nextReferenceIds = undefined;
    }

    const effectiveReferenceIds = readEffectiveReferenceIds(
      edit,
      nextReferenceIds,
    );

    const proposedValue =
      parsed.data.proposedValue !== undefined
        ? parsed.data.proposedValue
        : edit.proposedValue;
    const parameterPatchError = validateParameterSubmitterPatch(
      edit,
      proposedValue,
      effectiveReferenceIds,
    );
    if (parameterPatchError) {
      error(res, 400, parameterPatchError.message, parameterPatchError.code);
      return;
    }
    const paramEntryPatchError = validateParameterEntrySubmitterPatch(
      edit,
      proposedValue,
      effectiveReferenceIds,
    );
    if (paramEntryPatchError) {
      error(res, 400, paramEntryPatchError.message, paramEntryPatchError.code);
      return;
    }

    // Reference gate: an agent editing a fact/parameter must not swap in a
    // reference that hasn't been read in full and judged. Human submitters are
    // exempt (trusted readers); their cited source is left for the agent queue.
    if (
      (edit.editType === 'wiki_fact' || edit.editType === 'parameter') &&
      effectiveReferenceIds !== null
    ) {
      try {
        await assertReferencesJudgedForActor(effectiveReferenceIds, auth.userId);
      } catch (err) {
        if (err instanceof ReferenceGateError) {
          error(res, 400, err.message, 'reference_not_judged');
          return;
        }
        throw err;
      }
    }

    // Same gate for a source value, on the payload's own citation rather than
    // the row's whole reference set — that is the id the approval gates, and
    // widening it here would refuse a revision approval would accept. Without
    // this an agent could point both the payload and `referenceIds` at the
    // same unread source: the membership check above is satisfied, and the
    // refusal surfaces only at approval, in front of the reviewer, which is
    // the failure mode this whole gate exists to move back to the author.
    if (edit.editType === 'param_entry') {
      const payloadCitationId = paramEntryPayloadCitationId(proposedValue);
      if (payloadCitationId != null) {
        try {
          await assertReferencesJudgedForActor(
            [payloadCitationId],
            auth.userId,
          );
        } catch (err) {
          if (err instanceof ReferenceGateError) {
            error(res, 400, err.message, 'param_entry_reference_not_judged');
            return;
          }
          throw err;
        }
      }
    }

    let nextProposedValue: unknown = proposedValue;
    if (parsed.data.proposedValue !== undefined) {
      try {
        nextProposedValue = materializePatchedWikiFactProposedValue(
          edit,
          parsed.data.proposedValue,
          effectiveReferenceIds ?? [],
        );
      } catch (err) {
        error(res, 400, err instanceof Error ? err.message : String(err));
        return;
      }
    }
    const liveEntryForStaleness = await liveEntryForQuoteStaleness(edit);
    // A `param_entry` carries its quote inside the payload, so a revision that
    // edits the reading and leaves the quote as it was resubmits the old
    // sentence explicitly. See `withoutStaleEntryQuote`.
    // Canonicalized FIRST: everything below — the staleness comparison, the
    // payload fingerprint, the review card and the approval — has to reason
    // about the text that will be stored, not the text that was typed.
    nextProposedValue = withoutStaleEntryQuote(
      withCanonicalEntryQuote(nextProposedValue),
      edit.proposedValue,
      liveEntryForStaleness,
    );

    // Did this PATCH actually change the proposal? `hasSubmitterPayloadChange`
    // only says the request *carried* payload fields — echoing the stored
    // values back verbatim satisfies it — so the answer has to come from
    // comparing contents, which is what the fingerprint is for.
    //
    // What turns on it: `revisedAt`, the server-managed marker an upheld
    // dispute is measured against (`upheldRulingStands`). An uphold says "not
    // this content", so only a change to the content may clear it. Both looser
    // signals fail here — `submittedAt` is re-stamped by a bare
    // `{status:'pending'}` (#592), and "carried some payload fields" is
    // satisfied by resubmitting the identical payload — and either would let
    // an author launder a ruling away without touching the proposal.
    const payloadActuallyRevised =
      hasSubmitterPayloadChange &&
      pendingEditPayloadFingerprint({
        proposedValue: nextProposedValue,
        proposedMeta: suppliedMeta,
        referenceId: nextReferenceId,
        referenceIds:
          nextReferenceIds !== undefined ? nextReferenceIds : edit.referenceIds,
      }) !==
        pendingEditPayloadFingerprint({
          proposedValue: edit.proposedValue,
          proposedMeta: edit.proposedMeta,
          referenceId: edit.referenceId,
          referenceIds: edit.referenceIds,
        });
    // The marker is written here and nowhere else: stamped fresh on a real
    // revision, otherwise carried over from the row so a meta-only rewrite
    // neither invents a revision nor erases the record of an earlier one.
    // Whatever the client sent under that key is discarded either way.
    const baseMeta = withoutRevisionMarker(suppliedMeta);
    // The same question asked of the proposal's substance alone — what the
    // conflict marker is about. `payloadActuallyRevised` stays the right
    // signal for `revisedAt`, which records that the proposal changed at all.
    const contentActuallyRevised =
      hasSubmitterPayloadChange &&
      proposalContentRevised(
        {
          proposedValue: nextProposedValue,
          referenceId: nextReferenceId,
          referenceIds:
            nextReferenceIds !== undefined
              ? nextReferenceIds
              : edit.referenceIds,
        },
        {
          proposedValue: edit.proposedValue,
          referenceId: edit.referenceId,
          referenceIds: edit.referenceIds,
        },
      );
    // Content changed is necessary but not sufficient to discharge a conflict
    // marker (#1258): the author also has to answer THIS marking, not merely
    // revise something while it happened to be on the row. See
    // `conflictMarkerAcknowledged`.
    const conflictAcknowledged = conflictMarkerAcknowledged(
      edit.proposedMeta,
      parsed.data.acknowledgedConflictId,
    );
    // An additive wiki edit — a new fact or a new section — writes nothing an
    // approved sibling could have changed under it, and its approval re-checks
    // the section anchor against the live page. There is no stale content to
    // rebase, so the author resubmitting after seeing the warning is the whole
    // rebase there is; requiring a content change left these stuck behind a
    // marker nobody could clear without rewording a correct fact.
    const resubmitRebasesAdditiveWikiEdit =
      requestedStatus === 'pending' && isAdditiveWikiEdit(edit);

    const nextRevisedAt = payloadActuallyRevised
      ? new Date().toISOString()
      : payloadRevisedAt(edit.proposedMeta);
    // The return marker is carried over untouched: a revision answers it by
    // moving `revisedAt` past it, never by erasing it.
    const rowReturnedAt = payloadReturnedAt(edit.proposedMeta);
    const nextMeta = withoutStaleSourceQuote(
      nextRevisedAt || rowReturnedAt
        ? {
            ...(isRecord(baseMeta) ? baseMeta : {}),
            ...(nextRevisedAt ? { revisedAt: nextRevisedAt } : {}),
            ...(rowReturnedAt ? { returnedAt: rowReturnedAt } : {}),
          }
        : baseMeta,
      {
        // Deliberately NOT `payloadActuallyRevised`, which also counts a
        // metadata-only rewrite: see `proposalContentRevised`.
        payloadRevised: proposalContentRevised(
          {
            proposedValue: nextProposedValue,
            referenceId: nextReferenceId,
            referenceIds:
              nextReferenceIds !== undefined
                ? nextReferenceIds
                : edit.referenceIds,
          },
          {
            proposedValue: edit.proposedValue,
            referenceId: edit.referenceId,
            referenceIds: edit.referenceIds,
          },
        ),
        // `parsed.data.proposedMeta`, NOT `suppliedMeta`: the latter falls back
        // to the STORED meta when the PATCH omits one, so passing it here would
        // hand this function the old `sourceQuote` and let it read the server's
        // own carry-forward as the author supplying a replacement. The fix
        // would then be inert on exactly the path it exists for — a revision
        // that touches only `proposedValue`, which is what the review card
        // sends. `nextMeta` still comes from the effective metadata; only the
        // question "did the author state a quote?" uses the request.
        suppliedMeta: parsed.data.proposedMeta,
        storedMeta: edit.proposedMeta,
      },
    );

    // A submitter revision keeps the row in whatever state it was already in;
    // only an explicit `status` moves it. Revising a *pending* edit used to
    // silently demote it to `draft`, which is a black hole for API clients:
    // the agent protocol tells a submitting agent to answer a peer dispute by
    // PATCHing the corrected payload (agents/peer-verification-protocol.md,
    // "Closing the loop"), and that call quietly pulled the edit out of the
    // moderator queue and out of the verification queue — no scan looks at
    // `draft`, so a good revision disappeared instead of going back in play.
    // Reviewers are protected by the review token, not by this demotion: the
    // payload change re-stamps `submittedAt`, so a moderator holding a
    // pre-revision snapshot gets `pending_edit_review_token_mismatch` rather
    // than approving content they never read.
    const nextStatus =
      requestedStatus === 'pending'
        ? 'pending'
        : requestedStatus === 'draft'
          ? 'draft'
          : edit.status;
    // An agent putting a calculation-driving proposal back in the queue with
    // no quote is refused here, as the entry routes refuse it at submission:
    // consensus could never publish it, so it would only come straight back.
    // Asked of what the row will hold after this PATCH, so a bare resubmit
    // of a returned proposal and a revision that drops the quote both count.
    if (
      nextStatus === 'pending' &&
      (await agentProposalLacksSourceQuote(auth.userId, {
        editType: edit.editType,
        parameter: edit.parameter,
        targetId: edit.targetId,
        proposedValue: nextProposedValue,
        proposedMeta: nextMeta,
      }))
    ) {
      error(res, 400, SOURCE_QUOTE_REQUIRED_MESSAGE, 'source_quote_required');
      return;
    }
    const shouldClearReviewFields =
      nextStatus === 'draft' || requestedStatus === 'pending';

    // Wipe agent verifications when the submitter materially changes the
    // proposed payload or its references — prior verdicts were formed against
    // the old content. A bare status flip (draft ⇄ pending without payload
    // change) leaves verdicts intact. We always (re-)stamp the submitter's
    // implicit-approve on a status flip to 'pending' — the helper is
    // idempotent, and this restores the agent's own implicit approval after
    // a reviewer-return path cleared it (the reviewer-return branch above
    // wipes all verifications when the reviewer rewrites payload).
    const payloadChanged =
      parsed.data.proposedValue !== undefined ||
      parsed.data.proposedMeta !== undefined ||
      parsed.data.referenceId !== undefined ||
      parsed.data.referenceIds !== undefined;

    // The payload write and the verdict wipe are ONE transaction. Committed
    // separately, there was a moment in which the row held the new payload
    // but the old approvals still stood, and an agent-consensus retry (the
    // sweep, which the author itself may call) could publish the revision on
    // evidence formed against the previous version. Consensus applies under
    // this row's lock, so it now sees either the old payload with its
    // verdicts or the new payload without them (issue #1357).
    try {
      const refusal = await inTransaction(async () => {
        // A `param_entry` revision re-locks every drug its NEW payload names and
        // re-reads them before writing (`withParamEntryPayloadLocks`): revising a
        // proposal to name a drug being deleted or merged must serialize with that
        // removal exactly as authoring it does (RFC owner review, amendment 2).
        // The lock helper joins this transaction.
        const lockedUpdate = await underParamEntryLocks(edit, nextProposedValue, () =>
          getDb()
          .update(pendingEdits)
          .set({
            proposedValue: nextProposedValue as never,
            proposedMeta: nextProposedMetaPreservingConflict(
              nextMeta,
              edit.proposedMeta,
              // CONTENT, not the whole payload. Two narrowings, each closing a
              // way to discharge a conflict marker without rebasing:
              //
              //  - not `hasSubmitterPayloadChange`, which is true merely because
              //    the request carried payload fields, so a verbatim resubmit
              //    cleared it;
              //  - not the whole-payload fingerprint either, which counts
              //    `proposedMeta`, so rewording one's own `editSummary` cleared
              //    it — the entry patch untouched, and the next approval
              //    overwriting the very write the marker was announcing.
              //
              // The marker says "the entry moved under you". Only a change to
              // what this proposal would WRITE can answer that; commentary
              // cannot. See `proposalContentRevised`.
              //
              // Content changed AND the author echoed back the id of the
              // marker they were shown (#1258) — a revision that happens to
              // land while a marker sits on the row, without the author having
              // been shown and answered that specific one, leaves it in place.
              (contentActuallyRevised || resubmitRebasesAdditiveWikiEdit) &&
                conflictAcknowledged,
            ) as never,
            referenceId: nextReferenceId,
            // Explicit null clears the array; undefined leaves the column alone.
            ...(nextReferenceIds !== undefined
              ? { referenceIds: nextReferenceIds }
              : {}),
            ...(parsed.data.proposedValue !== undefined ||
            parsed.data.proposedMeta !== undefined ||
            parsed.data.referenceId !== undefined ||
            parsed.data.referenceIds !== undefined ||
            // A resubmit (-> pending) always bumps submittedAt even when the
            // payload is unchanged, so the review token differs from any
            // snapshot a reviewer took before the return/resubmit cycle (#592)
            // and the edit floats to the top of the submitted_at-ordered queue.
            requestedStatus === 'pending'
              ? { submittedAt: new Date() }
              : {}),
            status: nextStatus,
            ...(shouldClearReviewFields
              ? {
                  rejectionReason: null,
                  rejectionComment: null,
                  reviewedBy: null,
                  reviewedAt: null,
                }
              : {}),
          })
          .where(
            and(eq(pendingEdits.id, id), eq(pendingEdits.status, edit.status)),
          )
          .returning({ id: pendingEdits.id }),
        );
        if (lockedUpdate.refused) return lockedUpdate;
        if (lockedUpdate.value.length === 0) throw new SubmitterUpdateConflictError();
        // Take the author's agent row before touching verdict rows — the
        // order a verdict write (`recordVerification`: source row, agents,
        // verdict) and an admin tier change (`updateAgentWithTierRestamp`:
        // agents, verdicts) use. Wiping verdicts first and then reaching the
        // agent row inside `recordImplicitAgentApproval` would take the two in
        // the opposite order and could deadlock with a concurrent tier change.
        await getDb()
          .select({ id: agents.id })
          .from(agents)
          .where(eq(agents.userId, auth.userId))
          .for('update');
        if (payloadChanged) {
          await clearVerificationsForTarget({
            targetType: 'pending_edit',
            targetId: id,
          });
        } else if (requestedStatus === 'pending') {
          // A payload-identical resubmit keeps every verdict, including an
          // open dispute — but it just re-stamped `submittedAt`, so the
          // dispute's own captured version needs to move with it or it
          // strands out of reach of reconsideration (#1388). Content is
          // unchanged in this branch by construction, so `nextRevisedAt`
          // reflects no new revision either.
          const newTargetVersion = await verificationTargetVersion({
            targetType: 'pending_edit',
            targetId: id,
          });
          if (newTargetVersion) {
            await rebindOpenDisputesForUnrevisedResubmit({
              targetType: 'pending_edit',
              targetId: id,
              targetVersion: newTargetVersion,
              revisedAt: nextRevisedAt ? new Date(nextRevisedAt) : null,
            });
          }
        }
        if (payloadChanged || requestedStatus === 'pending') {
          await recordImplicitAgentApproval({
            userId: auth.userId,
            targetType: 'pending_edit',
            targetId: id,
          });
        }
        return null;
      });
      if (refusal) {
        refuseParamEntryRevision(res, refusal);
        return;
      }
    } catch (err) {
      if (err instanceof SubmitterUpdateConflictError) {
        error(
          res,
          409,
          PENDING_EDIT_UPDATE_CONFLICT,
          'pending_edit_update_conflict',
        );
        return;
      }
      if (
        requestedStatus === 'pending' &&
        edit.editType === 'paper_review' &&
        isOpenPaperReviewConflict(err)
      ) {
        error(
          res,
          409,
          'Another pending paper review already exists for this citation',
          'paper_review_pending_conflict',
        );
        return;
      }
      throw err;
    }

    json(res, 200, { pendingEdit: await fetchAndEnrich(id, auth.role) });
    return;
  }

  if (isOwnCancel) {
    const updated = await db
      .update(pendingEdits)
      .set({
        status: 'rejected',
        reviewedBy: auth.userId,
        reviewedAt: new Date(),
      })
      .where(and(eq(pendingEdits.id, id), eq(pendingEdits.status, edit.status)))
      .returning({ id: pendingEdits.id });
    if (updated.length === 0) {
      error(
        res,
        409,
        PENDING_EDIT_UPDATE_CONFLICT,
        'pending_edit_update_conflict',
      );
      return;
    }

    json(res, 200, { pendingEdit: await fetchAndEnrich(id, auth.role) });
    return;
  }

  if (!canReview || !canDecideModelStructure) {
    error(res, 403, 'Editor or admin role required');
    return;
  }

  if (
    requestedStatus === 'approved' ||
    requestedStatus === 'rejected' ||
    requestedStatus === 'returned'
  ) {
    if (edit.status !== 'pending') {
      error(
        res,
        409,
        'Only pending edits can be reviewed; drafts and returned edits must be submitted first.',
        'pending_edit_not_reviewable',
      );
      return;
    }
  }

  // Deciding on your own proposal. The default is still no — a second pair of
  // eyes is the whole point of the queue — but "no" is now a tier in the
  // matrix rather than a law of the code, and two different grants can lift it.
  //
  //   - `review.edit.decideOwn` (default `admin`, Admin → Permissions) is the
  //     human grant. An admin is the last reviewer in the building: on a
  //     deployment where they are the only one, their own proposals otherwise
  //     sit in the queue with nobody left to clear them, which is the same
  //     dead end `agents.self_review_enabled` was added for. It stacks on top
  //     of review.edit.decide (checked above) rather than replacing it, so
  //     lowering it to `editor` still only reaches editors who may moderate.
  //   - `agents.self_review_enabled` (Admin → Agents) is the per-agent grant,
  //     read off the caller's own agent row so it can only ever excuse the
  //     agent it was granted to. It stays the *only* route for an agent:
  //     an agent token is clamped to `editor` at authentication, but an admin
  //     who lowered decideOwn to `editor` would otherwise hand every agent
  //     the self-review flag exists to hand out one at a time. Hence the
  //     explicit `isActiveAgentUser` exclusion below.
  //
  // Three carve-outs survive, because neither grant is about overriding the
  // rules that exist to put a *second party* in the loop:
  //
  //   - A clinical_case is never published without a human expert (spec §12
  //     Stage 12). `applyOnAgentConsensus` already refuses to auto-apply one;
  //     without this, agent self-review would open the moderator path as a way
  //     around that, and the author would be signing off its own case. The
  //     human grant is not carved out here: the rule asks for a human expert
  //     moderator, and an admin acting on the moderator path is one.
  //   - A model-structure parameter entry chooses the equations the engine
  //     runs and may lift the model grade/disclaimer. Agents may propose one,
  //     but even a trusted self-review agent cannot make its own declaration
  //     live; edit.modelStructure.decide is deliberately editor-floored and a
  //     genuine second party must exercise it.
  //   - An open dispute holds the edit for someone else, whoever the author
  //     is. A moderator may overrule a dispute — that judgment is what a
  //     moderator is for — but here the "moderator" would be the disputed
  //     edit's own author, so the objection its work attracted would be
  //     cleared by the party it was raised against. An admin who wants it
  //     gone resolves the dispute first, as a separate and recorded act, and
  //     then approves. The consensus path enforces the same rule; this closes
  //     the direct route.
  const selfDecisionRequested =
    isSubmitter &&
    (requestedStatus === 'approved' || requestedStatus === 'returned');

  const selfReviewAllowed =
    selfDecisionRequested &&
    edit.editType !== 'clinical_case' &&
    !isModelStructureEdit(edit) &&
    (await isSelfReviewAgentUser(auth.userId));

  const selfDecideByCapability =
    selfDecisionRequested &&
    (await callerCan(auth.role, CAP['review.edit.decideOwn'])) &&
    !(await isActiveAgentUser(auth.userId));

  const mayDecideOwn = selfReviewAllowed || selfDecideByCapability;

  if (requestedStatus === 'approved' && isSubmitter && !mayDecideOwn) {
    error(
      res,
      403,
      'Users cannot approve their own edits',
      'approval_self_not_allowed',
    );
    return;
  }

  if (requestedStatus === 'returned' && isSubmitter && !mayDecideOwn) {
    error(
      res,
      403,
      'Users cannot return their own edits',
      'return_self_not_allowed',
    );
    return;
  }

  // Allowed to decide on your own edit, but not over a standing objection.
  // Its own code so the UI can say "resolve the dispute first" instead of the
  // flat "you may not touch your own edit" the grant just disproved.
  if (mayDecideOwn && (await selfReviewBlockedByDispute(id))) {
    error(
      res,
      403,
      'This edit has an open dispute against it; resolve the dispute before deciding on your own submission',
      'self_decision_blocked_by_dispute',
    );
    return;
  }

  // The dispute was decided — against this edit. Upholding an objection asks
  // for a return, a rejection or a revision, so the one thing its author may
  // not do next is approve it. Return stays open (it is the disposition the
  // ruling points at), and a revision re-stamps submitted_at, which clears
  // this by construction.
  if (
    requestedStatus === 'approved' &&
    mayDecideOwn &&
    (await selfApprovalBlockedByUpheldDispute(id, edit.proposedMeta))
  ) {
    error(
      res,
      403,
      'A dispute against this edit was upheld; return, reject or revise it rather than approving your own submission',
      'self_approval_blocked_by_upheld_dispute',
    );
    return;
  }

  // No single agent decides a person's proposal. Agents peer-verify every
  // pending edit, human-submitted ones included, and since kinetix-consensus v2
  // their consensus publishes a person's proposal at quorum exactly as it does
  // an agent's (api/agent-verifications.ts). What this closes is the
  // one-agent route: an agent carrying an editor role must not approve,
  // reject, or return a person's edit through the moderator path, which would
  // let one agent stand in for the quorum. Agent-submitted edits are
  // unaffected here: agents still moderate each other.
  if (
    (requestedStatus === 'approved' ||
      requestedStatus === 'rejected' ||
      requestedStatus === 'returned') &&
    !isSubmitter &&
    (await isActiveAgentUser(auth.userId)) &&
    !(await isActiveAgentUser(edit.submittedBy))
  ) {
    error(
      res,
      403,
      // Fallback prose only; the UI renders review.errors.agentModerationNotAllowed
      // off the code (AGENTS.md i18n rule for API error bodies).
      'Agents cannot moderate a human contributor\'s edit; post a peer-verification verdict instead',
      'agent_moderation_of_human_edit_not_allowed',
    );
    return;
  }

  if (
    requestedStatus === 'approved' ||
    requestedStatus === 'rejected' ||
    requestedStatus === 'returned'
  ) {
    if (
      !parsed.data.reviewToken ||
      parsed.data.reviewToken !== pendingEditReviewToken(edit)
    ) {
      error(
        res,
        409,
        'This edit changed since it was loaded; refresh before reviewing',
        'pending_edit_review_token_mismatch',
      );
      return;
    }
  }

  // #310: whole-page edits are admin-only across the entire workflow,
  // including approval. An editor reviewing a pre-existing wiki_page or
  // wiki_new draft (legacy or admin-submitted) must not be able to apply
  // it — only an admin can. Reject (status='rejected') is still fine.
  // Approving a wiki_new draft that carries a `newDrug` payload creates the
  // catalog drug as a side effect, so it needs the drug-creation capability
  // too — the same side door the create endpoint closes.
  if (
    requestedStatus === 'approved' &&
    edit.editType === 'wiki_new' &&
    (edit.proposedMeta as Record<string, unknown> | null)?.newDrug &&
    !(await callerCan(auth.role, CAP['drug.create']))
  ) {
    error(
      res,
      403,
      'Approving a draft that creates a new drug requires the drug-creation permission.',
      'drug_create_forbidden',
    );
    return;
  }

  // Same for the parameters bag a wiki_new draft can carry: approving it
  // publishes drug-parameter revisions via applyInitialParameters, which is
  // what /api/drug-parameter gates. A reviewer must not be able to publish
  // values they would not be allowed to submit.
  if (
    requestedStatus === 'approved' &&
    edit.editType === 'wiki_new' &&
    hasParameterBag(edit.proposedMeta) &&
    !(await callerCan(auth.role, CAP['edit.parameter.submit']))
  ) {
    error(
      res,
      403,
      'Approving a draft that publishes parameter values requires the parameter-edit permission.',
      'parameter_submit_forbidden',
    );
    return;
  }

  if (
    requestedStatus === 'approved' &&
    !(await callerCan(auth.role, CAP['wiki.page.approve'])) &&
    isWholePageEditType(edit.editType)
  ) {
    error(
      res,
      403,
      `Whole-page ${edit.editType} edits can only be approved by an admin; ` +
        `you may still reject the draft.`,
      'wiki_admin_only_whole_page',
    );
    return;
  }

  if (requestedStatus === 'returned') {
    const hasReviewerPayloadChange =
      parsed.data.proposedValue !== undefined ||
      parsed.data.proposedMeta !== undefined ||
      parsed.data.referenceId !== undefined ||
      parsed.data.referenceIds !== undefined;

    if (
      hasReviewerPayloadChange &&
      !(await callerCan(auth.role, CAP['wiki.page.approve'])) &&
      isWholePageEditType(edit.editType)
    ) {
      error(
        res,
        403,
        `Whole-page ${edit.editType} edits can only be modified by an admin before being returned; ` +
          `you may still return the draft with reviewer comments.`,
        'wiki_admin_only_whole_page',
      );
      return;
    }

    if (
      parsed.data.proposedValue !== undefined &&
      changesWikiFactId(edit, parsed.data.proposedValue)
    ) {
      error(
        res,
        400,
        'wiki_fact: factId is immutable; cannot change attrs.factId via PATCH',
      );
      return;
    }

    // A reviewer's return-with-changes is not the submitter's revision, so the
    // marker is neither stamped nor accepted from the request — the row keeps
    // whatever it had, and the author's own resubmission decides the rest.
    const reviewerMeta = withoutRevisionMarker(
      parsed.data.proposedMeta !== undefined
        ? parsed.data.proposedMeta
        : edit.proposedMeta,
    );
    const rowRevisedAt = payloadRevisedAt(edit.proposedMeta);

    let nextReferenceIds: number[] | null | undefined;
    let nextReferenceId: number | null;
    if (parsed.data.referenceIds !== undefined) {
      nextReferenceIds = parsed.data.referenceIds;
      nextReferenceId = parsed.data.referenceIds?.[0] ?? null;
    } else if (parsed.data.referenceId !== undefined) {
      nextReferenceId = parsed.data.referenceId;
      nextReferenceIds =
        parsed.data.referenceId === null ? null : [parsed.data.referenceId];
    } else {
      nextReferenceId = edit.referenceId;
      nextReferenceIds = undefined;
    }

    // Reference gate: an agent reviewer adjusting references on return must not
    // swap in a reference that hasn't been read in full and judged. A human
    // reviewer is exempt (trusted reader); the cited source is left for the
    // agent queue.
    if (
      (edit.editType === 'wiki_fact' || edit.editType === 'parameter') &&
      nextReferenceIds !== undefined &&
      nextReferenceIds !== null
    ) {
      try {
        await assertReferencesJudgedForActor(nextReferenceIds, auth.userId);
      } catch (err) {
        if (err instanceof ReferenceGateError) {
          error(res, 400, err.message, 'reference_not_judged');
          return;
        }
        throw err;
      }
    }

    const effectiveReferenceIds =
      nextReferenceIds !== undefined
        ? (nextReferenceIds ?? [])
        : edit.referenceIds && edit.referenceIds.length > 0
          ? edit.referenceIds
          : edit.referenceId
            ? [edit.referenceId]
            : [];
    let nextProposedValue = edit.proposedValue;
    if (parsed.data.proposedValue !== undefined) {
      try {
        nextProposedValue = materializePatchedWikiFactProposedValue(
          edit,
          parsed.data.proposedValue,
          effectiveReferenceIds,
        ) as never;
      } catch (err) {
        error(res, 400, err instanceof Error ? err.message : String(err));
        return;
      }
    }
    // Same exposure on this path: a reviewer rewriting the reading and leaving
    // the nested quote alone resubmits the old sentence explicitly.
    // Canonicalized FIRST: everything below — the staleness comparison, the
    // payload fingerprint, the review card and the approval — has to reason
    // about the text that will be stored, not the text that was typed.
    nextProposedValue = withoutStaleEntryQuote(
      withCanonicalEntryQuote(nextProposedValue),
      edit.proposedValue,
      await liveEntryForQuoteStaleness(edit),
    ) as never;

    // Decided here rather than beside `reviewerMeta` above, because it needs
    // the value and reference set this return will actually store — and
    // `hasReviewerPayloadChange`, the flag that was to hand up there, is
    // broader still than the submitter path's: it is true merely because the
    // request CARRIED a `proposedMeta`, so a reviewer returning with a note and
    // nothing else would strip a quote that is still perfectly good evidence.
    // A return with a note and no rewrite keeps the agents' verdicts, so it is
    // stamped: agent consensus then holds until the author actually revises
    // (`returnStandsUnrevised`). A rewrite wipes the verdicts instead and
    // replaces any earlier marker — the reviewer's own version is what the
    // next verdicts are about.
    const nextReturnedAt = hasReviewerPayloadChange ? null : new Date().toISOString();
    const nextMeta = withoutStaleSourceQuote(
      rowRevisedAt || nextReturnedAt
        ? {
            ...(isRecord(reviewerMeta) ? reviewerMeta : {}),
            ...(rowRevisedAt ? { revisedAt: rowRevisedAt } : {}),
            ...(nextReturnedAt ? { returnedAt: nextReturnedAt } : {}),
          }
        : reviewerMeta,
      {
        payloadRevised: proposalContentRevised(
          {
            proposedValue: nextProposedValue,
            referenceId: nextReferenceId,
            referenceIds:
              nextReferenceIds !== undefined
                ? nextReferenceIds
                : edit.referenceIds,
          },
          {
            proposedValue: edit.proposedValue,
            referenceId: edit.referenceId,
            referenceIds: edit.referenceIds,
          },
        ),
        suppliedMeta: parsed.data.proposedMeta,
        storedMeta: edit.proposedMeta,
      },
    );

    // Did this return actually REBASE the proposal? Two things it is not:
    // `hasReviewerPayloadChange`, which is true merely because the request
    // carried payload fields, so a verbatim send-back would clear a conflict
    // marker nobody rebased; and a whole-payload comparison, which counts
    // `proposedMeta`, so returning the proposal with a note — the most
    // ordinary thing a return carries — would clear it too. Only the content
    // answers "the entry moved under you". The fingerprint underneath ignores
    // `revisedAt` and `conflict`, so the marker's own presence never reads as
    // a revision.
    const reviewerContentActuallyRevised =
      hasReviewerPayloadChange &&
      proposalContentRevised(
        {
          proposedValue: nextProposedValue,
          referenceId: nextReferenceId,
          referenceIds:
            nextReferenceIds !== undefined
              ? nextReferenceIds
              : edit.referenceIds,
        },
        {
          proposedValue: edit.proposedValue,
          referenceId: edit.referenceId,
          referenceIds: edit.referenceIds,
        },
      );
    // Same requirement as the submitter path (#1258): a reviewer's own
    // content change discharges the marker only when they echo back the id
    // of the marker still on the row, proving they answered THIS write and
    // not merely rewrote the payload while a marker happened to be present.
    const reviewerConflictAcknowledged = conflictMarkerAcknowledged(
      edit.proposedMeta,
      parsed.data.acknowledgedConflictId,
    );

    // A reviewer returning WITH CHANGES rewrites `proposedValue` (and may
    // rewrite the references the payload's citation has to be drawn from), and
    // that write was the last `param_entry` payload path with no rules on it.
    // What it stored landed back on the author, whose own resubmit is gated —
    // so a reviewer's correction could leave the proposal unapprovable AND
    // unresubmittable, refused for a rewrite its author never made. Gate the
    // reviewer's version too, against the payload as it will be stored.
    //
    // Only when the reviewer actually changes the payload or its references: a
    // plain return-with-comments must stay open, since that is exactly how an
    // already-corrupt proposal gets sent back to someone who can repair it.
    if (
      parsed.data.proposedValue !== undefined ||
      parsed.data.referenceId !== undefined ||
      parsed.data.referenceIds !== undefined
    ) {
      const paramEntryReturnError = validateParameterEntrySubmitterPatch(
        edit,
        nextProposedValue,
        effectiveReferenceIds,
        'reviewer',
      );
      if (paramEntryReturnError) {
        error(
          res,
          400,
          paramEntryReturnError.message,
          paramEntryReturnError.code,
        );
        return;
      }
    }

    // A `param_entry` revision re-locks every drug its NEW payload names and
    // re-reads them before writing (`withParamEntryPayloadLocks`): revising a
    // proposal to name a drug being deleted or merged must serialize with that
    // removal exactly as authoring it does (RFC owner review, amendment 2).
    // The return and the verdict wipe commit together (issue #1357): a
    // request that failed between them would leave the old approvals attached
    // to the reviewer's rewritten payload, and the author's bare resubmit
    // would let the consensus sweep publish content no verifier reviewed.
    let lockedUpdate: ParamEntryLockedResult<{ id: number }[]>;
    try {
      lockedUpdate = await inTransaction(async () => {
            const result = await underParamEntryLocks(edit, nextProposedValue, () =>
          getDb()
            .update(pendingEdits)
            .set({
              proposedValue: nextProposedValue as never,
              proposedMeta: nextProposedMetaPreservingConflict(
                nextMeta,
                edit.proposedMeta,
                // Content only, same as the submitter path: a reviewer returning the
                // proposal with a note has not rebased it either, and a note is the
                // most ordinary thing a return carries. Acknowledgment required too
                // (#1258): see `reviewerConflictAcknowledged`.
                reviewerContentActuallyRevised && reviewerConflictAcknowledged,
              ) as never,
              referenceId: nextReferenceId,
              ...(nextReferenceIds !== undefined
                ? { referenceIds: nextReferenceIds }
                : {}),
              status: 'returned',
              // When the reviewer rewrites the payload on return, bump submittedAt
              // so the version token (`ISO|status`) changes — otherwise a later
              // status flip back to 'pending' would reproduce the exact token any
              // agent saw before the reviewer's edit, letting stale verdicts apply
              // to different content. Verifications are wiped immediately below.
              ...(hasReviewerPayloadChange ? { submittedAt: new Date() } : {}),
              rejectionReason: null,
              rejectionComment: parsed.data.returnComment ?? null,
              reviewedBy: auth.userId,
              reviewedAt: new Date(),
            })
            // Optimistic lock on (id, status, submitted_at) — see
            // pendingEditReviewerLock for why the timestamp is truncated rather than
            // compared directly, and why the upstream reviewToken check alone leaves
            // a gap a submitter revision can land in.
            .where(pendingEditReviewerLock(edit))
            .returning({ id: pendingEdits.id }),
        );
        if (result.refused) return result;
        if (result.value.length === 0) throw new SubmitterUpdateConflictError();
        if (hasReviewerPayloadChange) {
          await clearVerificationsForTarget({
            targetType: 'pending_edit',
            targetId: id,
          });
        }
        return result;
      });
    } catch (err) {
      if (err instanceof SubmitterUpdateConflictError) {
        error(
          res,
          409,
          PENDING_EDIT_UPDATE_CONFLICT,
          'pending_edit_update_conflict',
        );
        return;
      }
      throw err;
    }
    if (lockedUpdate.refused) {
      refuseParamEntryRevision(res, lockedUpdate);
      return;
    }

    // Wake the submitting agent so it reconciles the return this cycle instead
    // of on the next scheduled sweep. No-op for human submitters (see the
    // helper's inverse gate) and when hooks aren't configured.
    fireAgentHookForSubmitterAsync(edit.submittedBy, {
      kind: 'edit_returned',
      pendingEditId: id,
      editType: edit.editType,
      targetId: edit.targetId ?? null,
    });
    await notifyEditDecisionAfterCommit({
      edit,
      decision: 'returned',
      actorUserId: auth.userId,
      note: parsed.data.returnComment ?? null,
    });

    json(res, 200, { pendingEdit: await fetchAndEnrich(id, auth.role) });
    return;
  }

  if (requestedStatus === 'rejected') {
    const updated = await db
      .update(pendingEdits)
      .set({
        status: 'rejected',
        rejectionReason: parsed.data.rejectionReason!,
        rejectionComment: parsed.data.rejectionComment ?? null,
        reviewedBy: auth.userId,
        reviewedAt: new Date(),
      })
      // Same optimistic lock as the return path above.
      .where(pendingEditReviewerLock(edit))
      .returning({ id: pendingEdits.id });
    if (updated.length === 0) {
      error(
        res,
        409,
        PENDING_EDIT_UPDATE_CONFLICT,
        'pending_edit_update_conflict',
      );
      return;
    }
    await notifyEditDecisionAfterCommit({
      edit,
      decision: 'rejected',
      actorUserId: auth.userId,
      note: parsed.data.rejectionComment ?? null,
    });

    json(res, 200, { pendingEdit: await fetchAndEnrich(id, auth.role) });
    return;
  }

  if (requestedStatus !== 'approved') {
    error(res, 400, 'Unsupported pending edit update');
    return;
  }

  const meta = (edit.proposedMeta ?? {}) as Record<string, unknown>;
  if (meta.conflict) {
    error(
      res,
      409,
      'This edit conflicts with a newer approved change and cannot be approved as-is',
    );
    return;
  }

  try {
    await applyApprovedEdit(id, auth.userId, parsed.data.reviewToken);
  } catch (err) {
    if (err instanceof PendingEditReviewTokenMismatchError) {
      error(res, err.statusHint, err.message, err.code);
      return;
    }
    // buildParameterUpdate (slug/CID conflict, required-field empty etc.)
    // surfaces as ParameterApplyError; the wiki_fact approval flow uses
    // WikiFactApprovalError for invariant failures (unknown section,
    // missing target, fact-not-found, etc.). Translate both instead of
    // letting withErrorHandling produce a generic 500 on user-correctable
    // states.
    // The store's own backstop. `applyApprovedEditEffects` pre-checks
    // applicability, but that read is not under the lock, so a marker or a
    // reclassification committing in between reaches upsertDrugParameter and
    // throws from there instead. Same user-correctable state, so it must reach
    // the reviewer as the same localized 409 — otherwise the race produces a
    // generic 500 for a condition the sequential path explains properly.
    if (err instanceof ParameterNotApplicableError) {
      error(res, 409, err.message, err.code);
      return;
    }
    if (
      err instanceof ParameterApplyError ||
      err instanceof WikiFactApprovalError ||
      err instanceof MetabolismWriteError
    ) {
      // ParameterApplyError carries a stable code for the param_entry approval
      // branches so the review UI can localize it; the other two have none and
      // fall through to the message (undefined code is a no-op for error()).
      const code =
        err instanceof ParameterApplyError ? err.code : undefined;
      error(res, err.statusHint, err.message, code);
      return;
    }
    throw err;
  }

  json(res, 200, { pendingEdit: await fetchAndEnrich(id, auth.role) });
}

// ─── Helpers used by enrichPendingEdit for the wiki_fact card ──────────────

function readFactNodeAt(
  content: MonographContentV2,
  loc: FactLocation,
): MonographFactNode | null {
  const section = content.sections[loc.sectionId];
  if (!section) return null;
  const doc = loc.fieldId ? section.fields?.[loc.fieldId]?.body : section.body;
  const node = doc?.content?.[loc.index];
  return (node as MonographFactNode | undefined) ?? null;
}

/**
 * Cheap plaintext extractor for a fact node — concatenates all `text` leaf
 * values it finds. Used only to surface the existing claim in the review
 * card; the canonical render is server-side renderHtml.
 */
function factNodeToPlaintext(node: MonographFactNode): string {
  const parts: string[] = [];
  function walk(n: unknown): void {
    if (!n || typeof n !== 'object') return;
    const r = n as { text?: unknown; content?: unknown[] };
    if (typeof r.text === 'string') parts.push(r.text);
    if (Array.isArray(r.content)) {
      for (const child of r.content) walk(child);
    }
  }
  walk(node);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function sanitizeSubmittedFactContent(
  proposedValue: unknown,
  fallbackStatement: string,
): unknown[] | undefined {
  const raw = readSubmittedFactContent(proposedValue);
  if (!raw) return undefined;
  const sanitized = sanitizeFactBlockContent(raw);
  if (
    sanitized.length === 0 ||
    factContentPlaintext(sanitized) !== fallbackStatement.trim()
  ) {
    return undefined;
  }
  return sanitized;
}

function readSubmittedFactContent(proposedValue: unknown): unknown[] | null {
  if (!proposedValue || typeof proposedValue !== 'object') return null;
  const value = proposedValue as { type?: unknown; content?: unknown };
  if (value.type === 'doc' && Array.isArray(value.content))
    return value.content;
  if (Array.isArray(value.content)) return value.content;
  return null;
}

function sanitizeFactBlockContent(nodes: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as { type?: unknown; content?: unknown };
    if (node.type !== 'paragraph') continue;
    const inline = Array.isArray(node.content)
      ? sanitizeFactInlineContent(node.content)
      : [];
    out.push(
      inline.length > 0
        ? { type: 'paragraph', content: inline }
        : { type: 'paragraph' },
    );
  }
  return out;
}

function sanitizeFactInlineContent(nodes: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const raw of nodes) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as { type?: unknown; text?: unknown; marks?: unknown };
    if (node.type !== 'text' || typeof node.text !== 'string') continue;
    const next: { type: 'text'; text: string; marks?: unknown[] } = {
      type: 'text',
      text: node.text,
    };
    const marks = sanitizeFactMarks(node.marks);
    if (marks.length > 0) next.marks = marks;
    out.push(next);
  }
  return out;
}

function sanitizeFactMarks(marks: unknown): unknown[] {
  if (!Array.isArray(marks)) return [];
  const out: unknown[] = [];
  for (const raw of marks) {
    if (!raw || typeof raw !== 'object') continue;
    const mark = raw as { type?: unknown; attrs?: { href?: unknown } };
    if (mark.type !== 'link') continue;
    const href = sanitizeFactHref(String(mark.attrs?.href ?? ''));
    if (!href) continue;
    out.push({ type: 'link', attrs: { href } });
  }
  return out;
}

export function sanitizeFactHref(raw: string): string | null {
  const value = raw.trim();
  if (!value || value.startsWith('//')) return null;
  if (value.startsWith('#')) return value;
  if (value.startsWith('/wiki/')) {
    // Normalize path to prevent traversal: /wiki/../../api/admin resolves
    // to /api/admin, which does NOT start with /wiki/ and is rejected.
    try {
      const normalized = new URL(value, 'https://example.com').pathname;
      if (!normalized.startsWith('/wiki/')) return null;
      return normalized;
    } catch {
      return null;
    }
  }
  try {
    const parsed = new URL(value);
    if (!SAFE_FACT_LINK_PROTOCOLS.has(parsed.protocol)) return null;
    return value;
  } catch {
    return null;
  }
}

export function factContentPlaintext(nodes: unknown[]): string {
  function readNode(node: unknown): string {
    if (!node || typeof node !== 'object') return '';
    const value = node as { text?: unknown; content?: unknown };
    const text = typeof value.text === 'string' ? value.text : '';
    if (!Array.isArray(value.content)) return text;
    return text + value.content.map(readNode).join('');
  }

  return nodes.map(readNode).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Locate a topic-page fact node by sectionId + factId for review-card
 * `currentFactText` enrichment (#348). Topic pages keep a flat v1 doc
 * with facts as top-level siblings of the anchoring heading, so we
 * scan the body slice between the matching heading and the next
 * sectioned heading.
 */
function findTopicFactNode(
  content: unknown,
  sectionId: string | null,
  factId: string,
): MonographFactNode | null {
  if (!sectionId || !content || typeof content !== 'object') return null;
  const top = (content as { content?: unknown[] }).content;
  if (!Array.isArray(top)) return null;

  let inside = false;
  for (const raw of top) {
    if (!raw || typeof raw !== 'object') continue;
    const node = raw as {
      type?: string;
      attrs?: { sectionId?: unknown; factId?: unknown } | null;
    };
    if (node.type === 'heading') {
      const sid =
        node.attrs && typeof node.attrs.sectionId === 'string'
          ? node.attrs.sectionId
          : null;
      if (inside && sid) break; // hit the next sectioned heading
      if (sid === sectionId) inside = true;
      continue;
    }
    if (!inside) continue;
    if (node.type === 'fact' && node.attrs && node.attrs.factId === factId) {
      return raw as MonographFactNode;
    }
  }
  return null;
}
