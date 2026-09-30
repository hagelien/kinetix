/**
 * Kinetix's implementation of `assurance-core`'s `AssuranceStore` port.
 *
 * The kg_* tables already hold everything the port describes, so this is a
 * translation layer rather than a second store. What it translates is worth
 * naming, because each difference is a place a host and a package can quietly
 * disagree:
 *
 *   - **Integers become strings.** kg_* rows are serial-keyed; the port's
 *     identifiers are strings, because not every store addresses a governed
 *     object by an integer. The conversion happens here, once.
 *   - **`Date` becomes ISO-8601.** The core reads no clock and treats a
 *     timestamp as an opaque orderable string.
 *   - **A space slug becomes a space id.** The port names a space the way a
 *     policy does — by slug — and the tables key it by integer.
 *   - **A stored risk profile becomes a `RiskProfile`.** The column is
 *     `unknown` JSON, so it is validated rather than cast: a row written
 *     before the shape settled must not produce a profile whose `level` is
 *     undefined, because `atLeastRisk` would then silently answer false and
 *     every high-risk rule would stop matching.
 *
 * ## Why this exists at all
 *
 * The port is what lets the review machinery — the queue, the review packet,
 * the eligibility rules — live in the package instead of here. Kinetix does
 * not have to use it to keep working; it is how Kinetix stops being the only
 * host that can.
 *
 * Every function still takes its database handle, so a caller can pass a
 * transaction rather than the pooled handle. The port has no notion of one,
 * which is correct — a transaction is a host concern — so the handle is bound
 * at construction and a caller that needs a transactional view builds a second
 * instance around it.
 */

import type {
  AssuranceStore,
  EvidenceRequirementState,
  OpenDisputeInput,
  OpenProposalQuery,
  ProposalVersionRef,
  RecordAssessmentInput,
  RecordDecisionInput,
  RiskProfile,
  RuleDisputeInput,
  SpaceId,
  StoredAssessment,
  StoredDecision,
  StoredDispute,
  StoredDisputeRuling,
  StoredProposal,
  StoredProposalVersion,
  TargetRef,
} from 'assurance-core';
import { LOW_RISK, isRiskLevel } from 'assurance-core';
import {
  NON_CANONICAL,
  canonicalSnapshot,
  isImplicitByColumn,
  readCanonicalCapabilities,
  type LegacySnapshotReader,
} from './capability-snapshot.js';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  kgAssessments,
  kgDisputeRulings,
  kgDisputes,
  kgProposals,
  kgSpaces,
  kgTargets,
  type KgDisputeRulingKind,
  type KgPolicyDecisionOutcome,
} from '../../../../db/governance-schema.js';
import type { GovernanceDb } from './interface.js';
import * as assessments from './assessments.js';
import * as decisions from './decisions.js';
import * as disputes from './disputes.js';
import { rulingClosesDispute } from './disputes.js';
import * as evidence from './evidence.js';
import * as proposals from './proposals.js';
import * as spaces from './spaces.js';
import * as versions from './versions.js';

/** The subject every governance record in this port hangs off. */
const SUBJECT = 'proposal_version' as const;

/**
 * A stored assessment as this reader sees it — `verdict` typed as the `string`
 * the column actually is.
 *
 * `AssessmentRecord` declares it `KgVerdict`, which is the same claim about an
 * unconstrained column that this whole adapter exists to stop believing. The
 * fallback needs the raw value to decide whether it is readable, so the
 * history is typed honestly rather than cast into the narrower shape.
 */
interface AssessmentHistoryRow {
  readonly id: number;
  readonly subjectId: number;
  readonly actorRef: string;
  readonly actorKind: string;
  readonly verdict: string;
  readonly capabilitySnapshot: unknown;
  readonly independenceGroup: string | null;
  readonly supersedesAssessmentId: number | null;
  readonly createdAt: Date;
}

/** The columns the unreadable-verdict fallback reads when walking a chain. */
const ASSESSMENT_HISTORY_COLUMNS = {
  id: kgAssessments.id,
  spaceId: kgAssessments.spaceId,
  subjectType: kgAssessments.subjectType,
  subjectId: kgAssessments.subjectId,
  actorRef: kgAssessments.actorRef,
  actorKind: kgAssessments.actorKind,
  verdict: kgAssessments.verdict,
  rationaleMd: kgAssessments.rationaleMd,
  capabilitySnapshot: kgAssessments.capabilitySnapshot,
  independenceGroup: kgAssessments.independenceGroup,
  supersedesAssessmentId: kgAssessments.supersedesAssessmentId,
  createdAt: kgAssessments.createdAt,
} as const;

/**
 * Two vocabularies for "the policy said yes", and one is not a subset of the
 * other.
 *
 * The stored outcome has five values because it also records what a human
 * reviewer should do next (`human_review`, `return`, `reject`); the port has a
 * boolean because a core that decides publication has exactly one question.
 * Only `apply` means yes, and everything else — including a `reject` — reads
 * back as `allowed: false`, which is right: none of them publish.
 */
const DECISION_ALLOW: KgPolicyDecisionOutcome = 'apply';
const DECISION_HOLD: KgPolicyDecisionOutcome = 'hold';

/**
 * Dispute rulings, mapped in both directions.
 *
 * Only the names differ now: `overruled` here is `rejected` there, and every
 * other word is shared. `superseded` briefly mapped to `withdrawn`, which was
 * a real defect rather than an acceptable loss — this store deliberately
 * leaves a superseded dispute *open*, because a replacement dispute governs
 * it, so a caller reading the pair saw a closed ruling on an open dispute and
 * could not tell a live supersession from an abandoned complaint. The port
 * carries the word now, and `rulingClosesDispute` states which rulings end a
 * dispute in one place instead of two.
 */
const RULING_FROM_PORT: Record<
  StoredDisputeRuling['ruling'],
  KgDisputeRulingKind
> = {
  upheld: 'upheld',
  rejected: 'overruled',
  withdrawn: 'withdrawn',
  superseded: 'superseded',
};

const RULING_TO_PORT: Partial<
  Record<string, StoredDisputeRuling['ruling']>
> = {
  upheld: 'upheld',
  overruled: 'rejected',
  withdrawn: 'withdrawn',
  superseded: 'superseded',
};

/**
 * The tag a fail-closed profile carries.
 *
 * Exported so a policy can match on it and a diagnostic can count them: a
 * sudden crop of these means an adapter is writing a shape this reader does
 * not accept, which is a data problem to fix rather than a proposal to hold
 * forever.
 */
export const UNREADABLE_RISK_TAG = 'risk_profile_unreadable';

/**
 * A profile for a row whose stored classification could not be read.
 *
 * High, deliberately. A publication gate fails closed by demanding *more*
 * review, not less: this holds the proposal until someone looks, where a
 * low-risk fallback would have published it.
 */
export const UNREADABLE_RISK: RiskProfile = Object.freeze({
  level: 'high' as const,
  tags: Object.freeze([UNREADABLE_RISK_TAG]) as readonly string[],
});

/**
 * The unreadable profile, keeping whatever tags could still be read.
 *
 * Replacing a malformed profile wholesale discarded the readable tags with
 * the unreadable ones, and that lost a requirement rather than adding one:
 * the Kinetix policy demands a human clinical expert on anything tagged
 * `clinical_case`, and no rule matches `risk_profile_unreadable`, so a
 * corrupted clinical case got the high-risk bar and not the clinical one.
 *
 * Keeping the readable tags is safe in one direction only, and that direction
 * is the one that holds here: every rule in this policy is `require:`, so a
 * tag can only *add* a requirement. A surviving tag therefore tightens the
 * gate, and even a spurious one introduced by the corruption tightens it.
 * Nothing in the policy relaxes a bar on the strength of a tag, which is what
 * would make this reasoning unsafe.
 */
function unreadableRiskWith(tags: unknown): RiskProfile {
  return { level: 'high', tags: [...new Set([...salvageTags(tags), UNREADABLE_RISK_TAG])] };
}

/**
 * Every tag still recognisable in a malformed value, whatever shape it took.
 *
 * The first version of this looked only inside an array, so
 * `tags: 'clinical_case'` — a scalar where a list belongs — dropped a tag that
 * was perfectly legible, and with it the clinical-expert requirement. Asking
 * "is it the shape I expected?" and giving up otherwise is how a salvage
 * routine loses exactly the thing it exists to save.
 *
 * So this asks the opposite question: what here is a tag? A string is one. A
 * list contributes the strings in it. Anything else contributes nothing,
 * because there is nothing in it a tag rule could match.
 */
function salvageTags(value: unknown): readonly string[] {
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (Array.isArray(value)) {
    return value.filter((t): t is string => typeof t === 'string' && t.length > 0);
  }
  return [];
}

/**
 * Read a stored risk profile without trusting it.
 *
 * The column is JSON written by whichever adapter classified the version, and
 * a malformed one is not a crash — it is worse. `atLeastRisk` on a profile
 * with no `level` answers false, so every high-risk rule silently stops
 * matching and the proposal publishes under the low-risk bar.
 *
 * An earlier version of this fell back to `LOW_RISK`, on the reasoning that a
 * stated guess beats an implicit one. That was wrong in the direction that
 * matters: it produced exactly the silent bypass the validation exists to
 * prevent, just with a comment above it. A malformed profile now reads as
 * high-risk and carries `risk_profile_unreadable`, so the proposal is held and
 * the reason is visible in the policy context rather than needing a separate
 * call to `riskProfileIsMalformed`.
 *
 * `null` is not malformed: a version written before anything classified it
 * legitimately has none, and treating that as corruption would hold every
 * unclassified row.
 */
export function toRiskProfile(stored: unknown): RiskProfile {
  if (stored === null || stored === undefined) return LOW_RISK;
  if (typeof stored !== 'object') return UNREADABLE_RISK;
  const raw = stored as { level?: unknown; tags?: unknown };
  if (!isRiskLevel(raw.level)) return unreadableRiskWith(raw.tags);
  // Tags are as load-bearing as the level, and were briefly not treated that
  // way: this filtered non-strings out and carried on. The Kinetix policy
  // requires a human clinical expert on anything tagged `clinical_case`, so a
  // corrupted tag list silently unmatched that rule — a bypass of exactly the
  // kind the level check was added to stop, one field over.
  //
  // Absent is fine; present-but-not-a-list-of-strings is not. Nothing writes
  // `tags: null` — the classifier always emits an array, and an unclassified
  // version has no profile at all — so a non-array here means the row was not
  // written by something this reader understands.
  if (raw.tags === undefined) return { level: raw.level, tags: [] };
  if (!Array.isArray(raw.tags)) return unreadableRiskWith(raw.tags);
  if (!raw.tags.every((t): t is string => typeof t === 'string')) {
    return unreadableRiskWith(raw.tags);
  }
  return { level: raw.level, tags: [...raw.tags] };
}

/** True for a stored profile `toRiskProfile` had to fall back on. */
export function riskProfileIsMalformed(stored: unknown): boolean {
  if (stored === null || stored === undefined) return false;
  if (typeof stored !== 'object') return true;
  const raw = stored as { level?: unknown; tags?: unknown };
  if (!isRiskLevel(raw.level)) return true;
  if (raw.tags === undefined) return false;
  return (
    !Array.isArray(raw.tags) ||
    !raw.tags.every((t): t is string => typeof t === 'string')
  );
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

const VERDICTS: ReadonlySet<string> = new Set(['approve', 'dispute', 'abstain']);

/** True for a verdict this reader understands. */
function isReadableVerdict(verdict: string): boolean {
  return VERDICTS.has(verdict);
}

/**
 * Read a stored verdict without letting an unreadable one count as approval.
 *
 * `kg_assessments.verdict` is `varchar(16)`, so the cast this used to be was a
 * claim rather than a guarantee. It mattered more than the other unconstrained
 * columns: the tally handles `dispute` and `abstain` explicitly and treats
 * everything else as an approval, so a row reading `garbled` became an
 * *explicit approval* and could satisfy a quorum or a human-approval
 * requirement outright.
 *
 * Unreadable reads as `abstain` — the verdict that says "this assessor formed
 * no position". It is on the record and counts toward nothing, which is the
 * only honest thing to say about a judgment nobody can read.
 */
function verdictOf(row: { verdict: string }): StoredAssessment['verdict'] {
  return isReadableVerdict(row.verdict)
    ? (row.verdict as StoredAssessment['verdict'])
    : 'abstain';
}

/**
 * Whether this version's assessment history is one this reader can trust.
 *
 * ## Why this replaced a reconstruction
 *
 * There used to be a mechanism here that recovered an assessor's position from
 * a history containing rows nobody can read: it walked `supersedesAssessmentId`
 * to the last readable row, collapsed parallel branches by how much each
 * helped publication, and merged ties down to what every branch supported.
 *
 * It was wrong six times, in six distinguishable ways — the fallback's scope,
 * the metadata it carried, the key it walked the chain by, its handling of a
 * cycle, its tie-breaking, and finally its direction, which restored superseded
 * *approvals* as readily as superseded holds. Every fix was correct and every
 * fix left the next case, because the mechanism's premise was the problem: it
 * inferred what a corrupt record probably meant, and a publication gate that
 * guesses will eventually guess in the direction that publishes.
 *
 * So it does not guess any more. Corruption is *detected*, and a version whose
 * history is corrupt cannot publish at all until a person looks at it.
 *
 * ## What counts as corrupt
 *
 * Four things, all of which mean the same thing — a row these writers did not
 * produce has reached the table:
 *
 *  - a verdict this reader cannot read;
 *  - a supersession link naming a row that is not in this version's history;
 *  - a supersession link naming *another actor's* row, which no writer here
 *    emits and which would let one person overrule another's verdict;
 *  - a same-actor supersession cycle, which an append-only column cannot
 *    produce because a row can only name an id that already exists.
 *
 * None of these can arise from anything in this repository. They take an
 * import, a direct write, or in-place corruption — which is precisely the
 * population a reader hardening against untrusted columns exists for.
 */
function historyIsCorrupt(
  history: readonly {
    id: number;
    actorRef: string;
    verdict: string;
    supersedesAssessmentId: number | null;
  }[],
): boolean {
  const byId = new Map(history.map((h) => [h.id, h]));
  for (const row of history) {
    if (!isReadableVerdict(row.verdict)) return true;
    if (row.supersedesAssessmentId === null) continue;
    const target = byId.get(row.supersedesAssessmentId);
    if (!target || target.actorRef !== row.actorRef) return true;
  }
  // Cycles, checked separately because a link can be individually valid and
  // still close a loop with the ones ahead of it.
  for (const row of history) {
    const seen = new Set<number>();
    let cursor: (typeof history)[number] | undefined = row;
    while (cursor) {
      if (seen.has(cursor.id)) return true;
      seen.add(cursor.id);
      const next: number | null = cursor.supersedesAssessmentId;
      cursor = next === null ? undefined : byId.get(next);
    }
  }
  return false;
}

/**
 * The rows that still stand, on a history already known to be well-formed.
 *
 * `assessments.currentAssessments` drops any row whose id appears as some
 * other row's `supersedesAssessmentId`, regardless of who wrote it — fine for
 * the writers here, none of which supersede another actor's assessment, and
 * not fine for a reader tolerating rows those writers did not produce. That
 * distinction no longer needs guarding at this step, because a cross-actor or
 * cyclic link makes the whole history corrupt and this function is not reached.
 * Supersession is therefore what it says it is: a superseded row is gone.
 */
function standingRows<T extends { id: number; supersedesAssessmentId: number | null }>(
  history: readonly T[],
): T[] {
  const superseded = new Set<number>();
  for (const row of history) {
    if (row.supersedesAssessmentId !== null) superseded.add(row.supersedesAssessmentId);
  }
  return history.filter((row) => !superseded.has(row.id));
}

/**
 * How much a position helps a proposal publish, lowest first.
 *
 * Used to collapse an assessor holding several standing positions at once.
 * That is **not** a corruption signal and must not be treated as one:
 * `backfill.ts` records every legacy `agent_verification` with
 * `supersedesAssessmentId: null` on purpose (§6.4 forbids inferring that a
 * later approval replaced an earlier dispute when that history no longer
 * exists), so one agent with several verdicts on one target legitimately
 * arrives here as several unlinked standing rows.
 *
 * Which means this is permanent, not a tolerance for bad data: `tallyAssurance`
 * collapses one assessor's rows to **the last one**, so without this the
 * position that counts is whichever row was inserted last. The least
 * publication-helping reading is the safe one, and it is the adapter's to
 * choose because only the adapter can see that the rows are unlinked.
 */
function publicationRank(a: StoredAssessment): number {
  if (a.verdict === 'dispute') return 0;
  if (a.verdict === 'abstain') return 1;
  return a.implicit ? 2 : 3;
}

/**
 * One position per assessor, chosen fail-closed.
 *
 * `tallyAssurance` collapses several rows from one assessor to **the last
 * one**, deliberately: a reviewer who changed their mind holds one position,
 * not two. That is right for a well-formed history and wrong for a branched
 * one — returning `[a recovered dispute, a later unrelated approval]` let the
 * approval win and released the hold, even though the dispute was present in
 * the array. Handing the core a list and trusting it to pick correctly was the
 * mistake; the adapter has the information to decide and the core does not.
 */
function onePositionPerAssessor(
  records: readonly StoredAssessment[],
): StoredAssessment[] {
  const byAssessor = new Map<string, StoredAssessment[]>();
  for (const record of records) {
    const bucket = byAssessor.get(record.assessorRef) ?? [];
    bucket.push(record);
    byAssessor.set(record.assessorRef, bucket);
  }

  const out: StoredAssessment[] = [];
  for (const bucket of byAssessor.values()) {
    const best = Math.min(...bucket.map(publicationRank));
    out.push(mergeTiedPositions(bucket.filter((r) => publicationRank(r) === best)));
  }
  return out;
}

/**
 * Collapse branches that tie on rank, asserting only what all of them support.
 *
 * Keeping whichever row came first was arbitrary and, worse, arbitrary in the
 * direction of privilege: two standing approvals both rank the same, and if
 * the first happened to carry a clinical-expert or flagship capability the
 * collapsed position satisfied a gate the other branch could not. "Fail
 * closed" has to mean something when the ranks are equal too.
 *
 * When it cannot be told which branch is real, the position asserts only what
 * every branch agrees on: the intersection of the capabilities, implicit if
 * any of them is implicit, and human only if all of them are. Each of those is
 * the reading that helps publication least, and each is a claim the record
 * genuinely supports — every branch really does carry the capabilities in the
 * intersection.
 */
function unanimousKind(
  tied: readonly StoredAssessment[],
): StoredAssessment['assessorKind'] | null {
  const first = tied[0]!.assessorKind;
  return tied.every((r) => r.assessorKind === first) ? first : null;
}

function mergeTiedPositions(tied: readonly StoredAssessment[]): StoredAssessment {
  const first = tied[0]!;
  if (tied.length === 1) return first;

  const shared = tied
    .map((r) => new Set(r.assuranceCapabilities ?? []))
    .reduce((a, b) => new Set([...a].filter((c) => b.has(c))));
  const capabilities = [...shared].sort();

  // Dropped before the spread rather than after: an empty intersection has to
  // mean *no* capabilities, and spreading `first` would have kept its own.
  const { assuranceCapabilities: _dropped, ...identity } = first;

  return {
    ...identity,
    // An implicit assessment counts toward nothing, so any branch calling this
    // the author's own stake is the reading that grants least.
    implicit: tied.some((r) => r.implicit),
    // Unanimity or nothing. The first version of this kept the first
    // *non-human* kind, which treated "not human" as safe — but `agent`
    // qualifies too: it feeds `agentApprovals`, which the Kinetix projection
    // reads into a verification level. So an agent row encountered first still
    // won on insertion order, which is the same mistake one value over.
    //
    // `service` is the fallback because no requirement counts it as a person
    // or as a reviewing agent, so a disagreement about identity resolves to an
    // identity that claims nothing.
    assessorKind: unanimousKind(tied) ?? 'service',
    ...(capabilities.length > 0 ? { assuranceCapabilities: capabilities } : {}),
  };
}

const ACTOR_KINDS: ReadonlySet<string> = new Set([
  'human',
  'agent',
  'service',
  'system',
]);

/**
 * Read an **assessor's** kind without granting privilege to an unreadable one.
 *
 * `kg_assessments.actor_kind` is a text column, so a mistyped or legacy value
 * is possible. This used to fall through to `human`, which is the one value
 * that *confers* something on an assessor: `humanApproval` is satisfied by
 * kind alone, and the clinical-expert rule reads it together with a
 * capability. A corrupt row could therefore satisfy a requirement whose entire
 * purpose is putting a person in the loop.
 *
 * Unknown reads as `service` — a real actor kind that no requirement treats as
 * a person or as a reviewing agent. The assessment stays on the record,
 * because deleting history to make a read tidy is worse; it simply cannot
 * stand in for a human.
 */
export function actorKindOf(kind: string): StoredAssessment['assessorKind'] {
  return ACTOR_KINDS.has(kind)
    ? (kind as StoredAssessment['assessorKind'])
    : 'service';
}

/**
 * Read an **author's** kind, which fails closed in the opposite direction.
 *
 * The same word, the same column, and the reverse conclusion — which is why
 * this is a second function rather than a shared one. For an assessor, `human`
 * *satisfies* a requirement, so an unreadable kind must not be human. For an
 * author it *attracts* one: `when: { authorKind: 'human' }` requires a human
 * approval, on the reasoning that agent consensus never stands in for the
 * moderator on a person's proposal. Reusing the assessor fallback here would
 * let an unreadable author kind skip that rule, so a human-authored proposal
 * could pass on agent approvals alone.
 *
 * Fail closed means "toward the more demanding outcome", and which outcome
 * that is depends on the role. Unknown authors read as `human`.
 */
export function authorKindOf(kind: string): StoredAssessment['assessorKind'] {
  return ACTOR_KINDS.has(kind)
    ? (kind as StoredAssessment['assessorKind'])
    : 'human';
}

/**
 * Read a stored evaluation mode without promoting an unreadable one.
 *
 * Three things made the old `=== 'shadow' ? 'shadow' : 'authoritative'` wrong,
 * and only one of them was corruption. `advisory` is a real stored mode — a
 * decision surfaced to a human, governing nothing — and it was being reported
 * as authoritative, so a decision that decided nothing read as one that
 * published. The column is unconstrained text besides, so a legacy or
 * mistyped value took the same promotion.
 *
 * Only the exact word reads as authoritative. Everything else is `shadow`,
 * which is what the store already defaults to when a caller does not say, and
 * for the same reason: a decision that governs nothing is the safe thing to be
 * wrong about.
 */
function toDecisionMode(stored: string): StoredDecision['mode'] {
  return stored === 'authoritative' ? 'authoritative' : 'shadow';
}

/**
 * Read the assurance capabilities of a stored snapshot.
 *
 * Canonical first, and that is all the generic store knows. A non-canonical
 * row is offered to the host's own reader — Kinetix's older shapes live in
 * `kinetix-legacy-snapshots.ts` — and a row neither recognises confers
 * nothing *and says so*, rather than reading as an ordinary approval by an
 * assessor with no capabilities. Those are different facts, and collapsing
 * them is how a corrupt snapshot stops being investigated.
 */
export function capabilitiesFrom(
  snapshot: unknown,
  legacy: LegacySnapshotReader | null,
): { capabilities: readonly string[]; canonical: boolean; readable: boolean } {
  const canonical = readCanonicalCapabilities(snapshot);
  if (canonical !== NON_CANONICAL) {
    return { capabilities: canonical, canonical: true, readable: true };
  }
  const host = legacy?.readCapabilities(snapshot) ?? null;
  return host === null
    ? { capabilities: [], canonical: false, readable: false }
    : { capabilities: host, canonical: false, readable: true };
}


/**
 * The verdict and the implicit marker together, because they constrain each
 * other.
 *
 * `implicit` says "this is the author's submit-time approval stake". The tally
 * skips an implicit assessment before it ever looks at the verdict, so a row
 * carrying both `dispute` and an implicit marker states an objection that no
 * reader ever sees: the tally counts it as an implicit approval, nothing
 * disputes the version, and publication proceeds over a recorded objection.
 * The two markers are contradictory, and this reader resolves the
 * contradiction in the direction that keeps the objection: the verdict is the
 * assessor's stated position and wins, the implicit marker is dropped.
 *
 * The same holds for `abstain`, and for a verdict too garbled to read (which
 * `verdictOf` renders as `abstain`): neither is an approval, so neither has an
 * approval stake to be implicit about. Only an approval can be implicit.
 *
 * Failing this way withholds nothing that was ever counted — an implicit
 * assessment contributes to no requirement — while the other direction lets a
 * single flag erase a dispute.
 */
function standingPosition(
  row: {
    verdict: string;
    independenceGroup: string | null;
    capabilitySnapshot: unknown;
  },
  legacy: LegacySnapshotReader | null,
): Pick<StoredAssessment, 'verdict' | 'implicit'> {
  const verdict = verdictOf(row);
  const implicit =
    isImplicitByColumn(row) ||
    (legacy?.readImplicit(row.capabilitySnapshot) ?? false);
  return { verdict, implicit: verdict === 'approve' && implicit };
}

/**
 * What the store reports about itself, for a caller that wants to observe it.
 *
 * A callback rather than a metrics import, because
 * `tests/governance/packaging/boundaries.test.ts` holds this module to
 * drizzle, the core, the governance schema and the db handle — and it is right
 * to. A store that reached for a counter module would be a store that cannot
 * move to another host, which is the property this whole extraction exists to
 * protect. So the store states the fact and the host decides what to do with
 * it; that inversion is the same one `AssuranceStore` itself is built on.
 */
export interface AssuranceStoreObserver {
  /**
   * This version's assessment history contains rows the port cannot read, so
   * it now carries no approvals and cannot publish until a person looks at it.
   * Called once per read of that version, not once per bad row.
   */
  readonly onUnreadableHistory?: (proposalId: string) => void;
  /**
   * A `capability_snapshot` in a shape neither the canonical reader nor the
   * host's compatibility reader recognises.
   *
   * It confers no capabilities, which is the safe direction and was already
   * the behaviour — what was missing is that anyone knew. A corrupt snapshot
   * and an assessor with genuinely no standing produced the same silent empty
   * list, so the row read as an ordinary unqualified approval and nothing ever
   * looked at it.
   */
  readonly onNonCanonicalSnapshot?: (proposalId: string) => void;
}

export class KinetixAssuranceStore implements AssuranceStore {
  private spaceIds = new Map<SpaceId, number>();
  private targetRefs = new Map<number, TargetRef>();

  constructor(
    private readonly db: GovernanceDb,
    private readonly observer: AssuranceStoreObserver = {},
    /**
     * The host's reader for its own pre-canonical snapshots.
     *
     * A dependency rather than knowledge of this class: everything the store
     * needs to read a *canonical* row is here, and everything it needs to read
     * a Kinetix row written before that shape existed is injected. That is the
     * line §3 draws, and the reason the default is Kinetix's reader is that
     * this class is still constructed directly in Kinetix's own tests — the
     * extraction drops the default, not the seam.
     */
    private readonly legacySnapshots: LegacySnapshotReader | null = null,
  ) {}

  private async spaceIdOf(slug: SpaceId): Promise<number | null> {
    const cached = this.spaceIds.get(slug);
    if (cached !== undefined) return cached;
    const space = await spaces.findSpace(this.db, slug);
    if (!space) return null;
    this.spaceIds.set(slug, space.id);
    return space.id;
  }

  /**
   * Resolve a target row into the `TargetRef` a policy addresses it by.
   *
   * Cached per instance: a queue page hydrates dozens of proposals that mostly
   * point at a handful of targets, and the cache is per-request-scoped by
   * construction because the store is.
   */
  private async targetRefOf(targetId: number, slug: SpaceId): Promise<TargetRef> {
    const cached = this.targetRefs.get(targetId);
    if (cached) return cached;
    const [row] = await this.db
      .select({
        targetType: kgTargets.targetType,
        targetKey: kgTargets.targetKey,
      })
      .from(kgTargets)
      .where(eq(kgTargets.id, targetId))
      .limit(1);
    const ref: TargetRef = {
      space: slug,
      type: row?.targetType ?? 'unknown',
      id: row?.targetKey ?? String(targetId),
    };
    this.targetRefs.set(targetId, ref);
    return ref;
  }

  private async slugOf(spaceId: number): Promise<SpaceId> {
    for (const [slug, id] of this.spaceIds) if (id === spaceId) return slug;
    // Rare: a proposal read by id before any space lookup warmed the cache.
    const [row] = await this.db
      .select({ slug: kgSpaces.slug })
      .from(kgSpaces)
      .where(eq(kgSpaces.id, spaceId))
      .limit(1);
    const slug = row?.slug ?? String(spaceId);
    this.spaceIds.set(slug, spaceId);
    return slug;
  }

  private async toProposal(
    row: Awaited<ReturnType<typeof proposals.getProposal>>,
  ): Promise<StoredProposal | null> {
    if (!row) return null;
    const slug = await this.slugOf(row.spaceId);
    return {
      proposalId: String(row.id),
      target: await this.targetRefOf(row.targetId, slug),
      author: {
        actorRef: row.authorActorRef,
        kind: authorKindOf(row.authorKind),
        capabilities: [],
        assuranceCapabilities: [],
      },
      currentVersionId:
        row.currentVersionId === null ? null : String(row.currentVersionId),
      // `state` is a projection; `closedAt` is the fact. A proposal is open
      // when nothing has closed it.
      open: row.closedAt === null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async toVersion(
    row: Awaited<ReturnType<typeof versions.getVersion>>,
  ): Promise<StoredProposalVersion | null> {
    if (!row) return null;
    const proposal = await proposals.getProposal(this.db, row.proposalId);
    if (!proposal) return null;
    const slug = await this.slugOf(proposal.spaceId);
    return {
      ref: { proposalId: String(row.proposalId), versionId: String(row.id) },
      target: await this.targetRefOf(proposal.targetId, slug),
      author: {
        actorRef: row.authorActorRef,
        kind: authorKindOf(row.actorKind),
        capabilities: [],
        assuranceCapabilities: [],
      },
      risk: toRiskProfile(row.riskProfile),
      payloadFingerprint: row.payloadFingerprint,
      versionNo: row.versionNo,
      submittedAt: iso(row.submittedAt),
    };
  }

  /**
   * One stored row, reported as itself.
   *
   * Nothing is inferred from anywhere else in the history: the verdict, the
   * assessor's kind, the implicit marker and the capabilities all come from
   * this row. A row whose verdict cannot be read reports `abstain` — it stays
   * on the record and counts toward nothing, which is the only honest thing to
   * say about a judgment nobody can read — and its presence has already made
   * the whole history corrupt, which is what actually holds the version.
   */
  private toAssessmentRecord(
    row: AssessmentHistoryRow,
    proposalId: string,
  ): StoredAssessment {
    const { capabilities, readable } = capabilitiesFrom(
      row.capabilitySnapshot,
      this.legacySnapshots,
    );
    // A snapshot neither this store nor the host can read is stated, not
    // guessed at. It still confers nothing — the safe direction — but an
    // operator learns the row exists instead of it passing as an ordinary
    // approval by an assessor with no capabilities.
    if (!readable) this.observer.onNonCanonicalSnapshot?.(proposalId);
    return {
      assessmentId: String(row.id),
      version: { proposalId, versionId: String(row.subjectId) },
      assessorRef: row.actorRef,
      assessorKind: actorKindOf(row.actorKind),
      ...standingPosition(row, this.legacySnapshots),
      supersedesAssessmentId:
        row.supersedesAssessmentId === null
          ? null
          : String(row.supersedesAssessmentId),
      recordedAt: row.createdAt.toISOString(),
      ...(capabilities ? { assuranceCapabilities: capabilities } : {}),
    };
  }

  /**
   * Every assessor's position on one version, from that version's full history.
   *
   * Two paths, and which one runs is decided by `historyIsCorrupt` rather than
   * by anything about an individual row.
   *
   * **Well-formed** — the ordinary case, and every case any writer here can
   * produce. Superseded rows are gone, the rest report themselves.
   *
   * **Corrupt** — supersession is ignored entirely, because the links are part
   * of what cannot be trusted: obeying them is how an unreadable row came to
   * delete the dispute it claimed to replace. Every row then speaks only for
   * itself, one position per assessor, and **nothing qualifies as an
   * approval**. A readable `dispute` survives, because it is a real objection
   * from a real actor and dropping it would fail open; everything else — an
   * approval, an abstention, an unreadable verdict alike — reports `abstain`,
   * carrying no capabilities and no implicit marker.
   *
   * That is a hold rather than a penalty, and it is a guaranteed one:
   * `effectiveIndependentQuorum` is `Math.min(target, Math.max(1, eligible))`
   * and so never zero, which means a version with no approvals at all cannot
   * satisfy `independentApprovalsFromPool()` however small the reviewer pool
   * is. The version waits for a person.
   */
  private positionsOn(
    history: readonly AssessmentHistoryRow[],
    proposalId: string,
  ): StoredAssessment[] {
    if (!historyIsCorrupt(history)) {
      return onePositionPerAssessor(
        standingRows(history).map((row) => this.toAssessmentRecord(row, proposalId)),
      );
    }

    this.observer.onUnreadableHistory?.(proposalId);

    const byAssessor = new Map<string, StoredAssessment>();
    for (const row of history) {
      const record = this.toAssessmentRecord(row, proposalId);
      const held = byAssessor.get(record.assessorRef);
      // One position per assessor: an objection they raised anywhere in this
      // history, else their latest row saying nothing. Order decides only
      // between rows that all say nothing, so it cannot decide anything that
      // matters — which is the point, after a tie-break that kept whichever
      // branch happened to carry a capability.
      if (held?.verdict === 'dispute') continue;
      if (record.verdict === 'dispute') {
        byAssessor.set(record.assessorRef, record);
        continue;
      }
      // Stated nothing, and carries nothing: no capability, no implicit
      // marker, no approval. Built rather than spread so a field added to
      // `StoredAssessment` later cannot arrive here still carrying its value.
      byAssessor.set(record.assessorRef, {
        assessmentId: record.assessmentId,
        version: record.version,
        assessorRef: record.assessorRef,
        assessorKind: record.assessorKind,
        verdict: 'abstain',
        implicit: false,
        supersedesAssessmentId: record.supersedesAssessmentId,
        recordedAt: record.recordedAt,
      });
    }
    return [...byAssessor.values()];
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async getProposal(proposalId: string): Promise<StoredProposal | null> {
    const id = Number(proposalId);
    if (!Number.isInteger(id)) return null;
    return this.toProposal(await proposals.getProposal(this.db, id));
  }

  async getVersion(ref: ProposalVersionRef): Promise<StoredProposalVersion | null> {
    const id = Number(ref.versionId);
    if (!Number.isInteger(id)) return null;
    const row = await versions.getVersion(this.db, id);
    // A version id that exists but belongs to another proposal is not a match:
    // the port addresses a version by both halves, and answering on the id
    // alone would let a caller read across proposals by guessing.
    if (!row || String(row.proposalId) !== ref.proposalId) return null;
    return this.toVersion(row);
  }

  async latestVersion(proposalId: string): Promise<StoredProposalVersion | null> {
    const id = Number(proposalId);
    if (!Number.isInteger(id)) return null;
    return this.toVersion(await versions.latestVersion(this.db, id));
  }

  async listOpenProposals(
    space: SpaceId,
    query: OpenProposalQuery = {},
  ): Promise<readonly StoredProposal[]> {
    const spaceId = await this.spaceIdOf(space);
    if (spaceId === null) return [];

    // Both filters run in SQL, before `LIMIT`.
    //
    // An earlier version read a bounded over-fetch — four times the limit —
    // and filtered in JavaScript. That is wrong whenever more than that many
    // older proposals fail the predicate: the page comes back short, or empty,
    // while eligible work sits just past the window. `excludeAuthorRef` is the
    // self-review filter, so the caller most likely to hit it is a prolific
    // author looking at their own space, which is exactly the case that
    // over-fetch loses.
    const conditions = [
      eq(kgProposals.spaceId, spaceId),
      isNull(kgProposals.closedAt),
    ];
    if (query.excludeAuthorRef) {
      conditions.push(ne(kgProposals.authorActorRef, query.excludeAuthorRef));
    }
    if (query.targetType) {
      conditions.push(eq(kgTargets.targetType, query.targetType));
    }

    const rows = await this.db
      .select({
        id: kgProposals.id,
        spaceId: kgProposals.spaceId,
        targetId: kgProposals.targetId,
        authorActorRef: kgProposals.authorActorRef,
        authorKind: kgProposals.authorKind,
        state: kgProposals.state,
        currentVersionId: kgProposals.currentVersionId,
        legacyPendingEditId: kgProposals.legacyPendingEditId,
        createdAt: kgProposals.createdAt,
        closedAt: kgProposals.closedAt,
      })
      .from(kgProposals)
      // Joined rather than filtered afterwards, because the target type is
      // what `targetType` narrows on and it lives on the other table.
      .innerJoin(kgTargets, eq(kgTargets.id, kgProposals.targetId))
      .where(and(...conditions))
      .orderBy(asc(kgProposals.createdAt), asc(kgProposals.id))
      .limit(query.limit ?? 50);

    const out: StoredProposal[] = [];
    for (const row of rows) {
      const proposal = await this.toProposal(
        row as Awaited<ReturnType<typeof proposals.getProposal>>,
      );
      if (proposal) out.push(proposal);
    }
    return out;
  }

  /**
   * The numeric version id, but only if the reference names a real pairing.
   *
   * The port addresses a version by both halves, and until this existed only
   * `getVersion` enforced that. Every other read trusted `versionId` alone, so
   * combining proposal A's id with proposal B's version id returned B's
   * governance state labelled as A's — approvals from one proposal
   * contaminating another's assurance context, with nothing malformed anywhere
   * to notice.
   *
   * `null` means "no such version under that proposal", and every caller
   * treats it as the empty answer rather than an error: an unknown reference
   * reads as absent, which is the contract the port states.
   */
  private async versionIdOf(ref: ProposalVersionRef): Promise<number | null> {
    const versionId = Number(ref.versionId);
    if (!Number.isInteger(versionId)) return null;
    const row = await versions.getVersion(this.db, versionId);
    if (!row || String(row.proposalId) !== ref.proposalId) return null;
    return versionId;
  }

  /**
   * The same pairing check as `versionIdOf`, for the writes — which must
   * refuse rather than silently do nothing.
   *
   * A read of an unknown reference is legitimately empty; a *write* to one is
   * a caller mistake, and appending it under whichever proposal happens to own
   * that version id would put a verdict on the wrong change.
   */
  private async mustResolve(
    ref: ProposalVersionRef,
  ): Promise<{ versionId: number; spaceId: number }> {
    const versionId = await this.versionIdOf(ref);
    if (versionId === null) {
      throw new Error(
        `no version ${ref.versionId} under proposal ${ref.proposalId}`,
      );
    }
    const proposal = await proposals.getProposal(this.db, Number(ref.proposalId));
    if (!proposal) throw new Error(`no proposal ${ref.proposalId}`);
    return { versionId, spaceId: proposal.spaceId };
  }

  async currentAssessments(
    ref: ProposalVersionRef,
  ): Promise<readonly StoredAssessment[]> {
    const versionId = await this.versionIdOf(ref);
    if (versionId === null) return [];
    // The full history: standing rows are derived from it here rather than
    // taken from the store helper, whose supersession rule is actor-blind.
    const history = await assessments.listAssessments(this.db, {
      subjectType: SUBJECT,
      subjectId: versionId,
    });
    return this.positionsOn(history, ref.proposalId);
  }

  async assessmentsByActor(
    actorRef: string,
    refs: readonly ProposalVersionRef[],
  ): Promise<readonly StoredAssessment[]> {
    if (refs.length === 0) return [];
    const byVersion = new Map<number, string>();
    for (const ref of refs) {
      // Each reference is validated as a pair, so one bad entry in a queue
      // page cannot pull in another proposal's assessments.
      const id = await this.versionIdOf(ref);
      if (id !== null) byVersion.set(id, ref.proposalId);
    }
    if (byVersion.size === 0) return [];
    // History for every version in the page, in one query: standing rows are
    // derived from it, and fetching per row would make a page cost quadratic.
    const historyRows = await this.db
      .select(ASSESSMENT_HISTORY_COLUMNS)
      .from(kgAssessments)
      .where(
        and(
          eq(kgAssessments.subjectType, SUBJECT),
          inArray(kgAssessments.subjectId, [...byVersion.keys()]),
        ),
      )
      .orderBy(asc(kgAssessments.createdAt), asc(kgAssessments.id));
    const historyByVersion = new Map<
      number,
      Array<(typeof historyRows)[number]>
    >();
    for (const row of historyRows) {
      const bucket = historyByVersion.get(row.subjectId) ?? [];
      bucket.push(row);
      historyByVersion.set(row.subjectId, bucket);
    }

    const out: StoredAssessment[] = [];
    for (const [versionId, history] of historyByVersion) {
      const proposalId = byVersion.get(versionId);
      if (proposalId === undefined) continue;
      // Resolved exactly as the single read resolves it, then filtered to the
      // actor. Filtering first would hide a cross-actor link that displaces
      // this actor's row, and the two reads would disagree again.
      const resolved = this.positionsOn(history, proposalId);
      for (const record of resolved) {
        if (record.assessorRef === actorRef) out.push(record);
      }
    }
    return out;
  }

  async disputes(ref: ProposalVersionRef): Promise<readonly StoredDispute[]> {
    const versionId = await this.versionIdOf(ref);
    if (versionId === null) return [];
    // `openDisputes` reads only the open ones; the port wants both, because a
    // settled objection is part of the record a reviewer and an auditor read.
    // Queried directly rather than adding a flag to the store helper, whose
    // narrow predicate is deliberately the one the partial index serves.
    const rows = await this.db
      .select({
        id: kgDisputes.id,
        openedByActorRef: kgDisputes.openedByActorRef,
        openedByKind: kgDisputes.openedByKind,
        closedAt: kgDisputes.closedAt,
        createdAt: kgDisputes.createdAt,
      })
      .from(kgDisputes)
      .where(
        and(
          eq(kgDisputes.subjectType, SUBJECT),
          eq(kgDisputes.subjectId, versionId),
        ),
      )
      .orderBy(asc(kgDisputes.createdAt));
    if (rows.length === 0) return [];

    // Openness is derived from the rulings, not read off `closedAt`.
    //
    // `closedAt` is a projection, and the port's own rule is that where a
    // projection and the history disagree the history wins — but reading
    // `closedAt` *is* trusting the projection. `recordRuling` repairs it, so
    // this was only correct for disputes whose rulings all arrived through
    // that path. A ruling imported directly, or an existing one corrupted in
    // place, leaves a stale non-null `closedAt` that nothing re-derives, and
    // the dispute then reads closed and stops blocking publication.
    //
    // One query for every ruling on these disputes rather than one per
    // dispute: a version rarely carries more than a couple, but the shape
    // should not degrade if it does.
    const rulingRows = await this.db
      .select({
        disputeId: kgDisputeRulings.disputeId,
        ruling: kgDisputeRulings.ruling,
        createdAt: kgDisputeRulings.createdAt,
        id: kgDisputeRulings.id,
      })
      .from(kgDisputeRulings)
      .where(
        inArray(
          kgDisputeRulings.disputeId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(kgDisputeRulings.createdAt), asc(kgDisputeRulings.id));

    const latestByDispute = new Map<number, string>();
    for (const ruling of rulingRows) {
      latestByDispute.set(ruling.disputeId, ruling.ruling);
    }

    return rows.map((row) => {
      const latest = latestByDispute.get(row.id);
      return {
        disputeId: String(row.id),
        version: ref,
        openedByRef: row.openedByActorRef,
        openedByKind: actorKindOf(row.openedByKind),
        // No ruling at all means open. An unreadable latest ruling also means
        // open: nobody can say what settled it, so the objection stands.
        open: latest === undefined || !rulingClosesDispute(latest),
        openedAt: row.createdAt.toISOString(),
      };
    });
  }

  async disputeRulings(disputeId: string): Promise<readonly StoredDisputeRuling[]> {
    const id = Number(disputeId);
    if (!Number.isInteger(id)) return [];
    const rows = await disputes.listRulings(this.db, id);
    // An unrecognised stored ruling is omitted rather than mislabelled.
    //
    // The column is unconstrained text, so `RULING_TO_PORT` can miss, and
    // every available substitute would be a false factual claim: reporting
    // `superseded` asserts a replacement dispute governs, `withdrawn` asserts
    // the opener gave up. The port has no word for "we cannot read this", so
    // the honest options are to omit it or to invent one, and omitting costs
    // less — the row is still in the table for an audit that queries directly,
    // and `recordRuling` already refuses to let an unreadable ruling close the
    // dispute, so the objection keeps blocking publication either way.
    return rows.flatMap((row) => {
      const ruling = RULING_TO_PORT[row.ruling];
      if (!ruling) return [];
      return [
        {
          rulingId: String(row.id),
          disputeId,
          ruling,
          ruledByRef: row.actorRef,
          rationale: row.rationaleMd,
          ruledAt: row.createdAt.toISOString(),
        },
      ];
    });
  }

  async evidenceState(
    ref: ProposalVersionRef,
  ): Promise<readonly EvidenceRequirementState[]> {
    const versionId = await this.versionIdOf(ref);
    if (versionId === null) return [];
    const declared = this.declaredEvidence.get(ref.versionId);
    if (declared) return declared;
    const links = await evidence.evidenceForSubject(this.db, {
      subjectType: SUBJECT,
      subjectId: versionId,
    });
    if (links.length === 0) return [];
    return [
      {
        requirementId: 'evidence.cited',
        satisfied: links.some((l) => l.link.relation === 'supports'),
        detail: `${links.length} item(s) linked`,
      },
    ];
  }

  private declaredEvidence = new Map<
    string,
    readonly EvidenceRequirementState[]
  >();

  /**
   * Override the derived evidence state for one version.
   *
   * Present because the port's conformance suite asks a host to declare a
   * state and read it back, and Kinetix derives its own from evidence links
   * rather than storing requirement outcomes. Confined to that: production
   * reads the derivation above.
   */
  declareEvidence(
    ref: ProposalVersionRef,
    state: readonly EvidenceRequirementState[],
  ): void {
    this.declaredEvidence.set(ref.versionId, state);
  }

  async latestDecision(ref: ProposalVersionRef): Promise<StoredDecision | null> {
    const versionId = await this.versionIdOf(ref);
    if (versionId === null) return null;
    const row = await decisions.latestDecisionForVersion(this.db, versionId);
    if (!row) return null;
    return {
      decisionId: String(row.id),
      version: ref,
      policyId: row.policyId,
      policyVersion: row.policyVersion,
      allowed: row.decision === DECISION_ALLOW,
      inputFingerprint: row.inputFingerprint,
      mode: toDecisionMode(row.evaluationMode),
      evaluatedAt: row.evaluatedAt.toISOString(),
    };
  }

  // ── Appends ──────────────────────────────────────────────────────────────

  async recordAssessment(input: RecordAssessmentInput): Promise<StoredAssessment> {
    const { versionId, spaceId } = await this.mustResolve(input.version);
    const row = await assessments.recordAssessment(this.db, {
      spaceId,
      subjectType: SUBJECT,
      subjectId: versionId,
      actorRef: input.assessorRef,
      actorKind: input.assessorKind,
      verdict: input.verdict,
      // Unconditional, so a port-native row is canonical whether or not the
      // assessor had capabilities. Omitting it stored NULL, which is a shape
      // the canonical reader has to make an exception for — and an exception
      // for the common case is how "reject non-canonical records" becomes
      // unenforceable later.
      capabilitySnapshot: canonicalSnapshot({
        assuranceCapabilities: input.assuranceCapabilities,
      }),
      // An implicit marker only ever describes an approval stake, so it is
      // dropped rather than stored on a verdict that states the opposite.
      // Storing it would make this row invisible to the tally (see
      // `standingPosition`), and the raw column is read by the mirror and the
      // SDK too — normalising here keeps every reader's answer the same.
      independenceGroup: input.implicit && input.verdict === 'approve' ? 'author' : null,
      supersedesAssessmentId: input.supersedesAssessmentId
        ? Number(input.supersedesAssessmentId)
        : null,
      at: new Date(input.recordedAt),
    });
    // A row this method just wrote: its verdict came from a typed input, so
    // it is readable by construction.
    return this.toAssessmentRecord(row, input.version.proposalId);
  }

  async openDispute(input: OpenDisputeInput): Promise<StoredDispute> {
    const { versionId, spaceId } = await this.mustResolve(input.version);
    const row = await disputes.openDispute(this.db, {
      spaceId,
      subjectType: SUBJECT,
      subjectId: versionId,
      openedByActorRef: input.openedByRef,
      openedByKind: input.openedByKind,
      at: new Date(input.openedAt),
    });
    return {
      disputeId: String(row.id),
      version: input.version,
      openedByRef: row.openedByActorRef,
      openedByKind: input.openedByKind,
      open: row.closedAt === null,
      openedAt: row.createdAt.toISOString(),
    };
  }

  async ruleDispute(input: RuleDisputeInput): Promise<StoredDisputeRuling> {
    const row = await disputes.recordRuling(this.db, {
      disputeId: Number(input.disputeId),
      ruling: RULING_FROM_PORT[input.ruling],
      actorRef: input.ruledByRef,
      rationaleMd: input.rationale ?? null,
      at: new Date(input.ruledAt),
    });
    return {
      rulingId: String(row.id),
      disputeId: input.disputeId,
      ruling: input.ruling,
      ruledByRef: row.actorRef,
      rationale: row.rationaleMd,
      ruledAt: row.createdAt.toISOString(),
    };
  }

  async recordDecision(input: RecordDecisionInput): Promise<StoredDecision> {
    const { versionId, spaceId } = await this.mustResolve(input.version);
    const row = await decisions.recordPolicyDecision(this.db, {
      spaceId,
      proposalVersionId: versionId,
      policyId: input.policyId,
      policyVersion: input.policyVersion,
      decision: input.allowed ? DECISION_ALLOW : DECISION_HOLD,
      inputFingerprint: input.inputFingerprint,
      evaluationMode: input.mode,
      at: new Date(input.evaluatedAt),
    });
    return {
      decisionId: String(row.id),
      version: input.version,
      policyId: row.policyId,
      policyVersion: row.policyVersion,
      allowed: row.decision === DECISION_ALLOW,
      inputFingerprint: row.inputFingerprint,
      mode: input.mode,
      evaluatedAt: row.evaluatedAt.toISOString(),
    };
  }
}

