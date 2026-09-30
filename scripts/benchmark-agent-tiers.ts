/**
 * Replay historical agent work to compare model/effort tiers on the metrics
 * that actually decide the tiering rollout — cost per *accepted correct* action,
 * not price per token.
 *
 * This is the empirical gate the tiered-agent architecture is contingent on
 * (docs/superpowers/specs/2026-08-24-tiered-agent-cost-architecture.md §D). We
 * do not yet have Kinetix-specific accuracy-vs-cost curves; every model/effort
 * recommendation is a prior until this harness measures the real distribution
 * on past work.
 *
 * ## What it measures, and the one thing it cannot
 *
 * Two ground-truth signals ARE recorded and are the strong part of the report:
 *
 * - **Verifier tier vs. human ground truth.** `agent_verifications.model` records
 *   which model cast each peer verdict. Cross-referenced against the pending
 *   edit's eventual human decision (`pending_edits.status`), this yields, per
 *   capability tier, the metric that licenses lowering a tier: how often a
 *   tier's `approve` verdicts landed on edits a human later REJECTED
 *   (false-approve) and how often its `dispute` verdicts landed on edits a human
 *   later APPROVED (over-dispute).
 * - **Producer outcomes by identity.** Grouped by the submitting agent, the
 *   human rejection / return / approval rates and the concordance distribution
 *   of its parameter work.
 *
 * The database does NOT record **per-submission producer model** — a pending
 * edit stores only `submitted_by` (an agent user), not the model that produced
 * it. So producer metrics are attributed by agent *identity* (a proxy: one
 * identity may run different models over time).
 *
 * Token usage IS recorded per run (`agent_run_usage`, migration 0134, written
 * by scripts/kinetix-log-run-usage.ts), with the server-snapshotted capability
 * tier. The report sums it per tier × workflow and per identity; with a rate
 * card whose entries name the `models` they price, it turns those measured
 * tokens into measured cost, cost per accepted edit and cost per peer verdict.
 * The older rate-card projection (price × estimated tokens per action) is kept
 * for configs not yet run, and stays visually separate from measured cost.
 *
 * ## Usage
 *
 *   npx tsx scripts/benchmark-agent-tiers.ts [--since <ISO>] [--json] \
 *     [--rate-card <path.json>]
 *
 * Read-only: it runs SELECTs only and never writes. `--since` bounds the window
 * (default: all history). `--json` emits the full report object instead of the
 * formatted text. `--rate-card` points at a JSON map of
 * `{ "<configName>": { "inputPerMTok": N, "outputPerMTok": N,
 * "cacheReadPerMTok"?: N, "cacheWritePerMTok"?: N, "models"?: ["sonnet"],
 * "estInputTokensPerAction"?: N, "estOutputTokensPerAction"?: N } }`; omit it
 * to get outcome metrics and measured tokens only.
 */
import 'dotenv/config';
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import {
  agentRunUsage,
  agentVerifications,
  agents,
  pendingEdits,
} from '../db/schema.js';
import { getDb } from '../api/_lib/db.js';
import { type ModelTier } from '../src/lib/modelTiers.js';

// ---------------------------------------------------------------------------
// Pure metric functions — no DB access, so the accounting is unit-testable.
// ---------------------------------------------------------------------------

/**
 * Decision on a pending edit, used as ground truth for verifier accuracy.
 * `agent_applied` is the crucial distinction: an edit `applyApprovedEdit`
 * published via consensus is stamped `status='approved'` with `reviewed_by` set
 * to the tipping AGENT, not a human. Counting those as `approved` would let the
 * very approvals that caused publication validate themselves — biasing
 * false-approve down and accepted-fraction up. They are a separate bucket,
 * excluded from the human-decided denominators.
 */
export type EditOutcome =
  | 'approved'
  | 'rejected'
  | 'returned'
  | 'pending'
  | 'agent_applied'
  | 'self_withdrawn';

/** Pure status → outcome, with no reviewer context (human-decided only). */
export function editOutcomeFromStatus(status: string): EditOutcome {
  if (status === 'approved') return 'approved';
  if (status === 'rejected') return 'rejected';
  if (status === 'returned') return 'returned';
  return 'pending';
}

/**
 * Resolve the outcome including reviewer identity:
 * - `approved` by an agent → `agent_applied`. Published by consensus (or an
 *   agent moderator); the verifiers' own approvals drive it, so it is not
 *   independent ground truth for the verifier metric.
 * - `rejected` by the SUBMITTER itself → `self_withdrawn`: the submitter
 *   cancelling its own proposal (§2.B/§2.C, `isOwnCancel`), not a quality
 *   rejection. This is NOT agent-specific — a human contributor can withdraw
 *   its own edit too (reviewedBy === submittedBy with a human reviewer). So the
 *   trigger is `reviewer == submitter`, whoever they are. An agent OR human
 *   moderator rejecting SOMEONE ELSE's edit stays a genuine `rejected`.
 *   Rejection has no consensus path, so reviewer==submitter cleanly separates a
 *   self-withdrawal from a peer/moderator rejection.
 */
export function resolveEditOutcome(
  status: string,
  reviewerIsAgent: boolean,
  reviewerIsSubmitter: boolean,
): EditOutcome {
  const base = editOutcomeFromStatus(status);
  if (reviewerIsAgent && base === 'approved') return 'agent_applied';
  if (reviewerIsSubmitter && base === 'rejected') return 'self_withdrawn';
  return base;
}

export interface VerifierVerdictRecord {
  /** Server-owned tier snapshotted at verdict time (agent_verifications.verifier_tier). */
  verifierTier: string | null;
  verdict: 'approve' | 'dispute' | 'abstain';
  isImplicit: boolean;
  /** Eventual human decision on the pending edit this verdict targeted. */
  editOutcome: EditOutcome;
}

/**
 * The tier to attribute a verdict to — ONLY the server-owned snapshot
 * (`agent_verifications.verifier_tier`, migration 0113), the same value the
 * consensus gate trusts.
 *
 * A NULL snapshot is `unknown`, never model-classified. NULL has two causes and
 * both must stay untrusted: a legacy pre-0113 verdict, AND a post-migration
 * verdict from an *unclassified* agent (its `agents.model_tier` was NULL, so the
 * snapshot deliberately marks it untrusted). Falling back to the self-reported
 * model would let exactly the second case be spoofed — an unclassified mid-tier
 * agent reporting `claude-opus-5` would land in the flagship cohort — which is
 * the corruption the snapshot exists to prevent. Untrusted-tier verdicts sit in
 * the `unknown` bucket rather than polluting a real tier's accuracy.
 */
export function resolveVerifierTier(verifierTier: string | null): ModelTier {
  if (verifierTier === 'flagship' || verifierTier === 'mid' || verifierTier === 'light') {
    return verifierTier;
  }
  return 'unknown';
}

export interface VerifierTierMetrics {
  tier: ModelTier;
  verdicts: number;
  approve: number;
  dispute: number;
  abstain: number;
  /** approve verdicts on edits a human later rejected — the costly error. */
  falseApprove: number;
  /** approve verdicts on edits a human later approved. */
  trueApprove: number;
  /** dispute verdicts on edits a human later approved — over-caution. */
  overDispute: number;
  /** dispute verdicts on edits a human later rejected — a caught problem. */
  trueDispute: number;
  /**
   * falseApprove / (falseApprove + trueApprove). The headline: of this tier's
   * approvals on human-decided edits, the fraction the human overruled. `null`
   * when the tier cast no decided approvals.
   */
  falseApproveRate: number | null;
}

/**
 * Per-tier verifier accuracy against human ground truth. Implicit-approve rows
 * (the submitter's own stake) are excluded — they are not peer judgments.
 */
export function computeVerifierTierMetrics(
  records: VerifierVerdictRecord[],
): VerifierTierMetrics[] {
  const byTier = new Map<ModelTier, VerifierTierMetrics>();
  const ensure = (tier: ModelTier): VerifierTierMetrics => {
    let m = byTier.get(tier);
    if (!m) {
      m = {
        tier,
        verdicts: 0,
        approve: 0,
        dispute: 0,
        abstain: 0,
        falseApprove: 0,
        trueApprove: 0,
        overDispute: 0,
        trueDispute: 0,
        falseApproveRate: null,
      };
      byTier.set(tier, m);
    }
    return m;
  };

  for (const r of records) {
    if (r.isImplicit) continue;
    const m = ensure(resolveVerifierTier(r.verifierTier));
    m.verdicts += 1;
    if (r.verdict === 'approve') {
      m.approve += 1;
      // Only human-DECIDED outcomes are ground truth. An `agent_applied` edit
      // was published by these very approvals, so it counts as neither a true
      // nor a false approve — excluded from the falseApproveRate denominator.
      if (r.editOutcome === 'rejected') m.falseApprove += 1;
      else if (r.editOutcome === 'approved') m.trueApprove += 1;
    } else if (r.verdict === 'dispute') {
      m.dispute += 1;
      if (r.editOutcome === 'approved') m.overDispute += 1;
      else if (r.editOutcome === 'rejected') m.trueDispute += 1;
    } else {
      m.abstain += 1;
    }
  }

  for (const m of byTier.values()) {
    const decidedApprovals = m.falseApprove + m.trueApprove;
    m.falseApproveRate =
      decidedApprovals > 0 ? m.falseApprove / decidedApprovals : null;
  }

  return [...byTier.values()].sort((a, b) => b.verdicts - a.verdicts);
}

export interface ProducerRecord {
  agentSlug: string;
  outcome: EditOutcome;
}

export interface ProducerMetrics {
  agentSlug: string;
  submitted: number;
  /** Human-approved only. Consensus-applied edits are counted in agentApplied. */
  approved: number;
  rejected: number;
  returned: number;
  pending: number;
  /** Published by agent consensus, not human-decided — reported separately. */
  agentApplied: number;
  /** Withdrawn by the submitter itself (agent or human) — not a rejection. */
  selfWithdrawn: number;
  /** rejected / human-decided (decided = approved + rejected + returned). */
  rejectionRate: number | null;
  /**
   * returned / human-decided. A **lower bound**: a returned edit that the
   * submitter revised and resubmitted reuses the same `pending_edits` row, so
   * once it is finally approved the row's status shows only `approved` and the
   * earlier return is not recoverable from status alone (no durable per-edit
   * decision-history table exists). returnRate therefore understates
   * corrections and acceptedFraction correspondingly overstates them — a
   * directional caveat when reading the rollout projection. Making this exact
   * needs a decision-history/audit table written on every reviewer action,
   * which is a separate change beyond this benchmark.
   */
  returnRate: number | null;
}

/** Per-producer human-outcome rates, keyed by submitting agent identity. */
export function computeProducerMetrics(
  records: ProducerRecord[],
): ProducerMetrics[] {
  const byAgent = new Map<string, ProducerMetrics>();
  for (const r of records) {
    let m = byAgent.get(r.agentSlug);
    if (!m) {
      m = {
        agentSlug: r.agentSlug,
        submitted: 0,
        approved: 0,
        rejected: 0,
        returned: 0,
        pending: 0,
        agentApplied: 0,
        selfWithdrawn: 0,
        rejectionRate: null,
        returnRate: null,
      };
      byAgent.set(r.agentSlug, m);
    }
    m.submitted += 1;
    if (r.outcome === 'approved') m.approved += 1;
    else if (r.outcome === 'rejected') m.rejected += 1;
    else if (r.outcome === 'returned') m.returned += 1;
    else if (r.outcome === 'agent_applied') m.agentApplied += 1;
    else if (r.outcome === 'self_withdrawn') m.selfWithdrawn += 1;
    else m.pending += 1;
  }
  for (const m of byAgent.values()) {
    // Human-decided only — consensus-applied edits are excluded so a producer's
    // rate is not inflated by its own peers' auto-applies.
    const decided = m.approved + m.rejected + m.returned;
    m.rejectionRate = decided > 0 ? m.rejected / decided : null;
    m.returnRate = decided > 0 ? m.returned / decided : null;
  }
  return [...byAgent.values()].sort((a, b) => b.submitted - a.submitted);
}

export interface RateCardEntry {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Price of cache reads; defaults to 10% of input (both vendors' current ratio). */
  cacheReadPerMTok?: number;
  /** Price of cache writes; defaults to 125% of input (Anthropic 5-minute TTL). */
  cacheWritePerMTok?: number;
  /**
   * Case-insensitive substrings of the transcript model id this entry prices
   * (e.g. `["sonnet-5"]`). Without it the entry prices no measured run.
   */
  models?: string[];
  /** Operator estimates for the projection of configs not yet run. */
  estInputTokensPerAction?: number;
  estOutputTokensPerAction?: number;
}

export interface CostProjection {
  config: string;
  /** token price × estimated tokens per action. Real, per-config. */
  costPerAction: number;
}

/**
 * Project per-action token cost for each rate-card config. Cost per token is
 * external (no token data in the DB); tokens per action are the operator's
 * estimate.
 *
 * Deliberately does NOT emit a per-config cost-per-*accepted*-action: that
 * would require each config's own acceptance fraction, but producer model is
 * not recorded per edit (see ProducerMetrics), so the only acceptance the DB
 * yields is one global figure across all producers. Dividing every config by
 * that same number would rank configs purely by token price and could never
 * show a cheaper config being rejected more — the exact tradeoff this benchmark
 * exists to measure. The measured acceptance is reported once as a labelled
 * baseline instead, and per-config quality comes from the shadow-audit
 * false-negative rate, not from this projection.
 */
export function projectCosts(
  rateCard: Record<string, RateCardEntry>,
): CostProjection[] {
  return Object.entries(rateCard).flatMap(([config, r]) =>
    r.estInputTokensPerAction == null || r.estOutputTokensPerAction == null
      ? []
      : [
          {
            config,
            costPerAction:
              (r.estInputTokensPerAction / 1_000_000) * r.inputPerMTok +
              (r.estOutputTokensPerAction / 1_000_000) * r.outputPerMTok,
          },
        ],
  );
}

interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface RunUsageRecord extends TokenCounts {
  agentSlug: string | null;
  /** Server-owned tier snapshot (agent_run_usage.model_tier); NULL = unknown. */
  modelTier: string | null;
  workflow: string;
  /** Transcript model id — used only to look up a price, never the tier. */
  model: string | null;
  /** The totals split by the model that spent them (subagents); may be null. */
  modelUsage: Record<string, TokenCounts> | null;
  createdAt: Date;
  /** When the run began and how long it had run when last logged. */
  startedAt: Date | null;
  durationMs: number | null;
}

const runTokens = (r: RunUsageRecord): number =>
  r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens;

/**
 * The rate-card entry for a model id: the one whose matching pattern is the
 * longest, so `gpt-5.6` beats `gpt-5` for `gpt-5.6-sol` whatever the JSON
 * order. Two different entries tying on the longest match are ambiguous and
 * price nothing, rather than silently picking one.
 */
export function rateCardEntryFor(
  model: string | null,
  rateCard: Record<string, RateCardEntry>,
): RateCardEntry | null {
  if (!model) return null;
  const id = model.toLowerCase();
  let best: RateCardEntry | null = null;
  let bestLength = 0;
  let ambiguous = false;
  for (const entry of Object.values(rateCard)) {
    const length = Math.max(
      0,
      ...(entry.models ?? [])
        .filter((m) => m && id.includes(m.toLowerCase()))
        .map((m) => m.length),
    );
    if (length === 0) continue;
    if (length > bestLength) {
      best = entry;
      bestLength = length;
      ambiguous = false;
    } else if (length === bestLength && entry !== best) {
      ambiguous = true;
    }
  }
  return ambiguous ? null : best;
}

function priceCounts(
  model: string | null,
  counts: TokenCounts,
  rateCard: Record<string, RateCardEntry>,
): number | null {
  const entry = rateCardEntryFor(model, rateCard);
  if (!entry) return null;
  const cacheRead = entry.cacheReadPerMTok ?? entry.inputPerMTok * 0.1;
  const cacheWrite = entry.cacheWritePerMTok ?? entry.inputPerMTok * 1.25;
  return (
    (counts.inputTokens * entry.inputPerMTok +
      counts.outputTokens * entry.outputPerMTok +
      counts.cacheReadTokens * cacheRead +
      counts.cacheCreationTokens * cacheWrite) /
    1_000_000
  );
}

/**
 * Measured cost of one run, pricing each model's share of the tokens at that
 * model's rate (a subagent on a cheaper model is not charged the main model's
 * price). `null` when any share has no matching rate-card entry — an unpriced
 * run is reported as such, never guessed at.
 */
export function priceRun(
  run: RunUsageRecord,
  rateCard: Record<string, RateCardEntry> | null,
): number | null {
  if (!rateCard) return null;
  const shares = Object.entries(run.modelUsage ?? {});
  if (shares.length === 0) return priceCounts(run.model, run, rateCard);
  let total = 0;
  for (const [model, counts] of shares) {
    const cost = priceCounts(model, counts, rateCard);
    if (cost == null) return null;
    total += cost;
  }
  return total;
}

export interface RunUsageMetrics {
  tier: ModelTier;
  workflow: string;
  runs: number;
  totalTokens: number;
  avgTokensPerRun: number;
  /** cache reads / all input-side tokens — the E2 caching lever's hit rate. */
  cacheReadShare: number | null;
  /** Runs a rate-card entry priced; cost fields cover these runs only. */
  pricedRuns: number;
  cost: number | null;
  costPerRun: number | null;
}

/** Measured tokens (and cost, where priced) per capability tier × workflow. */
export function computeRunUsageMetrics(
  runs: RunUsageRecord[],
  rateCard: Record<string, RateCardEntry> | null,
): RunUsageMetrics[] {
  const groups = new Map<string, RunUsageMetrics & { inputSide: number; cacheRead: number }>();
  for (const r of runs) {
    const tier = resolveVerifierTier(r.modelTier);
    const key = `${tier}\u0000${r.workflow}`;
    let m = groups.get(key);
    if (!m) {
      m = {
        tier,
        workflow: r.workflow,
        runs: 0,
        totalTokens: 0,
        avgTokensPerRun: 0,
        cacheReadShare: null,
        pricedRuns: 0,
        cost: null,
        costPerRun: null,
        inputSide: 0,
        cacheRead: 0,
      };
      groups.set(key, m);
    }
    m.runs += 1;
    m.totalTokens += runTokens(r);
    m.inputSide += r.inputTokens + r.cacheCreationTokens + r.cacheReadTokens;
    m.cacheRead += r.cacheReadTokens;
    const cost = priceRun(r, rateCard);
    if (cost != null) {
      m.pricedRuns += 1;
      m.cost = (m.cost ?? 0) + cost;
    }
  }
  return [...groups.values()]
    .map(({ inputSide, cacheRead, ...m }) => ({
      ...m,
      avgTokensPerRun: m.totalTokens / m.runs,
      cacheReadShare: inputSide > 0 ? cacheRead / inputSide : null,
      costPerRun: m.cost != null ? m.cost / m.pricedRuns : null,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
}

export interface AgentCostMetrics {
  agentSlug: string;
  /**
   * The runs' server-snapshotted tier. An identity reclassified within the
   * window gets one row per tier, so a promotion never folds mid-tier history
   * into a flagship figure.
   */
  tier: ModelTier;
  runs: number;
  pricedRuns: number;
  cost: number | null;
  /**
   * Human-approved + consensus-applied edits this identity submitted DURING
   * one of its logged runs. Outputs of a run whose usage was never logged
   * (before telemetry, or a failed log) have no cost in the numerator, so
   * they are left out of the denominator too.
   */
  acceptedEdits: number;
  /** Non-implicit peer verdicts cast during one of its logged runs. */
  verdicts: number;
  /** Logged runs with no start time, so no outputs can be tied to them. */
  unplacedRuns: number;
  costPerAcceptedEdit: number | null;
  costPerVerdict: number | null;
}

export interface AgentOutputRecord {
  agentSlug: string;
  at: Date;
}

/** The [start, end] a logged run covered, or null when it cannot be placed. */
export function runInterval(r: RunUsageRecord): [number, number] | null {
  if (!r.startedAt) return null;
  const start = r.startedAt.getTime();
  // durationMs is refreshed on a re-log; createdAt keeps the first write.
  const end =
    r.durationMs != null ? start + r.durationMs : r.createdAt.getTime();
  return end >= start ? [start, end] : null;
}

/**
 * Where the cost ratio's outputs must be fetched from: the earliest START of
 * any included run. Runs are selected by `created_at` (written when the run
 * ends), so with `--since` a run under way at the cutoff is included and
 * began before it — its outputs must be read from its start, not the cutoff.
 */
export function earliestRunStart(runs: RunUsageRecord[]): Date | null {
  let min: Date | null = null;
  for (const r of runs) {
    const at = r.startedAt ?? r.createdAt;
    if (!min || at < min) min = at;
  }
  return min;
}

/**
 * Cost per unit of useful output, per identity — the §D headline metric.
 * An output counts only when it falls inside one of the identity's logged
 * runs, and only the cost of runs that can be placed in time is divided by
 * them, so numerator and denominator always cover the same work: neither
 * pre-telemetry history nor a run whose usage log failed can make a tier look
 * cheaper than it is. Only computed when every run of the identity is priced,
 * so a partly priced identity never looks cheaper either.
 */
export function computeAgentCostMetrics(
  runs: RunUsageRecord[],
  rateCard: Record<string, RateCardEntry> | null,
  acceptedEdits: AgentOutputRecord[],
  verdicts: AgentOutputRecord[],
): AgentCostMetrics[] {
  const bySlug = new Map<
    string,
    AgentCostMetrics & { placedCost: number; intervals: [number, number][] }
  >();
  for (const r of runs) {
    if (!r.agentSlug) continue;
    const tier = resolveVerifierTier(r.modelTier);
    const key = `${r.agentSlug}\u0000${tier}`;
    let m = bySlug.get(key);
    if (!m) {
      m = {
        agentSlug: r.agentSlug,
        tier,
        runs: 0,
        pricedRuns: 0,
        cost: null,
        acceptedEdits: 0,
        verdicts: 0,
        unplacedRuns: 0,
        costPerAcceptedEdit: null,
        costPerVerdict: null,
        placedCost: 0,
        intervals: [],
      };
      bySlug.set(key, m);
    }
    m.runs += 1;
    const cost = priceRun(r, rateCard);
    if (cost != null) {
      m.pricedRuns += 1;
      m.cost = (m.cost ?? 0) + cost;
    }
    const interval = runInterval(r);
    if (interval) {
      m.intervals.push(interval);
      m.placedCost += cost ?? 0;
    } else {
      m.unplacedRuns += 1;
    }
  }
  const countDuringRuns = (
    outputs: AgentOutputRecord[],
    slug: string,
    intervals: [number, number][],
  ) =>
    outputs.filter((o) => {
      if (o.agentSlug !== slug) return false;
      const t = o.at.getTime();
      return intervals.some(([start, end]) => t >= start && t <= end);
    }).length;
  return [...bySlug.values()]
    .map(({ placedCost, intervals, ...m }) => {
      m.acceptedEdits = countDuringRuns(acceptedEdits, m.agentSlug, intervals);
      m.verdicts = countDuringRuns(verdicts, m.agentSlug, intervals);
      if (m.cost != null && m.pricedRuns === m.runs) {
        m.costPerAcceptedEdit =
          m.acceptedEdits > 0 ? placedCost / m.acceptedEdits : null;
        m.costPerVerdict = m.verdicts > 0 ? placedCost / m.verdicts : null;
      }
      return m;
    })
    .sort(
      (a, b) => a.agentSlug.localeCompare(b.agentSlug) || b.runs - a.runs,
    );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function pct(x: number | null): string {
  return x == null ? '  n/a' : `${(x * 100).toFixed(1)}%`;
}

function usd(x: number | null): string {
  return x == null ? 'n/a' : `$${x.toFixed(2)}`;
}

function kTok(x: number): string {
  return `${Math.round(x / 1000)}k`;
}

function formatReport(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push('# Agent tier benchmark');
  lines.push(
    `window: ${report.since ?? 'all history'} · pending edits: ${report.totalEdits} · peer verdicts: ${report.totalVerdicts}`,
  );
  lines.push('');
  lines.push('## Verifier accuracy by capability tier (vs. human decision)');
  lines.push(
    'tier      verdicts  appr  disp  abst  falseAppr  falseApprRate  overDisp',
  );
  for (const m of report.verifierTiers) {
    lines.push(
      `${m.tier.padEnd(9)} ${String(m.verdicts).padStart(8)}  ${String(m.approve).padStart(4)}  ${String(m.dispute).padStart(4)}  ${String(m.abstain).padStart(4)}  ${String(m.falseApprove).padStart(9)}  ${pct(m.falseApproveRate).padStart(13)}  ${String(m.overDispute).padStart(8)}`,
    );
  }
  lines.push('');
  lines.push('## Producer outcomes by agent identity (model not recorded per edit)');
  lines.push(
    'agent               submitted  appr  rej  ret  cons  wdn  rejRate  retRate',
  );
  for (const m of report.producers) {
    lines.push(
      `${m.agentSlug.padEnd(19)} ${String(m.submitted).padStart(9)}  ${String(m.approved).padStart(4)}  ${String(m.rejected).padStart(3)}  ${String(m.returned).padStart(3)}  ${String(m.agentApplied).padStart(4)}  ${String(m.selfWithdrawn).padStart(3)}  ${pct(m.rejectionRate).padStart(7)}  ${pct(m.returnRate).padStart(7)}`,
    );
  }
  lines.push(
    'appr/rej/ret and the rates are HUMAN-decided only. cons = published by agent',
  );
  lines.push(
    'consensus; wdn = withdrawn by the submitter itself. Both are excluded from the',
  );
  lines.push('rates so peers cannot self-validate and self-withdrawals cannot inflate rej.');
  lines.push(
    'retRate is a LOWER bound: a returned edit later resubmitted+approved reuses',
  );
  lines.push('its row, so its return is not recoverable from status alone.');
  lines.push('');
  lines.push('## Measured run usage by capability tier (agent_run_usage)');
  if (report.runUsage.length === 0) {
    lines.push('no runs logged in this window (scripts/kinetix-log-run-usage.ts)');
  } else {
    lines.push(
      'tier      workflow       runs  tok/run  cacheRead  priced       cost  cost/run',
    );
    for (const m of report.runUsage) {
      lines.push(
        `${m.tier.padEnd(9)} ${m.workflow.padEnd(12)} ${String(m.runs).padStart(6)}  ${kTok(m.avgTokensPerRun).padStart(7)}  ${pct(m.cacheReadShare).padStart(9)}  ${`${m.pricedRuns}/${m.runs}`.padStart(6)}  ${usd(m.cost).padStart(9)}  ${usd(m.costPerRun).padStart(8)}`,
      );
    }
    lines.push('');
    lines.push('## Measured cost per useful output, by agent identity');
    lines.push(
      'agent               tier      runs       cost  accepted  $/accepted  verdicts  $/verdict',
    );
    for (const m of report.agentCosts) {
      lines.push(
        `${m.agentSlug.padEnd(19)} ${m.tier.padEnd(9)} ${String(m.runs).padStart(4)}  ${usd(m.cost).padStart(9)}  ${String(m.acceptedEdits).padStart(8)}  ${usd(m.costPerAcceptedEdit).padStart(10)}  ${String(m.verdicts).padStart(8)}  ${usd(m.costPerVerdict).padStart(9)}`,
      );
    }
    lines.push(
      'accepted = human-approved + consensus-applied edits; accepted and verdicts',
    );
    lines.push(
      'count only when made during a logged run, and $/output divides only the',
    );
    lines.push(
      'cost of runs that can be placed in time — both sides cover the same work.',
    );
    const unplaced = report.agentCosts.reduce((n, m) => n + m.unplacedRuns, 0);
    if (unplaced > 0) {
      lines.push(
        `${unplaced} logged run(s) had no start time and are left out of $/output.`,
      );
    }
    lines.push(
      'Cost needs a rate-card entry for every model a run used; $/accepted and',
    );
    lines.push('$/verdict are shown only when every run of the identity is priced.');
  }
  if (report.costs && report.costs.length > 0) {
    lines.push('');
    lines.push('## Cost projection (token price × ESTIMATED tokens/action, from rate card)');
    lines.push('config                cost/action');
    for (const c of report.costs) {
      lines.push(
        `${c.config.padEnd(21)} ${('$' + c.costPerAction.toFixed(4)).padStart(11)}`,
      );
    }
    lines.push(
      `measured human acceptance across ALL producers: ${pct(report.acceptedFraction)}`,
    );
    lines.push(
      '— a single baseline, NOT attributable per config (producer model is not',
    );
    lines.push(
      'recorded per edit), so per-config cost-per-accepted-action is deliberately',
    );
    lines.push('not emitted; use the shadow-audit false-negative rate for that.');
  }
  lines.push('');
  lines.push(
    'NOTE: falseApprRate is of this tier’s human-DECIDED approvals only. A tier',
  );
  lines.push(
    'with a low count is not yet evidence — grow the window before acting on it.',
  );
  lines.push(
    'It is also measured over SURVIVING verdicts: a verifier changing its verdict',
  );
  lines.push(
    'upserts the row, and a material edit revision clears the target’s verdicts, so',
  );
  lines.push(
    'a mid-tier approval on a version later revised is not replayable from the live',
  );
  lines.push(
    'table — falseApprRate is a lower bound (same durable-history gap as retRate).',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// DB glue
// ---------------------------------------------------------------------------

export interface BenchmarkReport {
  since: string | null;
  totalEdits: number;
  totalVerdicts: number;
  verifierTiers: VerifierTierMetrics[];
  producers: ProducerMetrics[];
  acceptedFraction: number | null;
  costs: CostProjection[] | null;
  runUsage: RunUsageMetrics[];
  agentCosts: AgentCostMetrics[];
}

export async function runBenchmark(opts: {
  since: Date | null;
  rateCard: Record<string, RateCardEntry> | null;
}): Promise<BenchmarkReport> {
  const db = getDb();

  // The user ids that back an agent — so an `approved` edit reviewed by one of
  // them is a consensus auto-apply, not human ground truth.
  const agentUserRows = await db.select({ userId: agents.userId }).from(agents);
  const agentUserIds = new Set(agentUserRows.map((a) => a.userId));

  // Pending edits in-window, joined to their submitting agent's slug.
  const editRows = await db
    .select({
      id: pendingEdits.id,
      status: pendingEdits.status,
      submittedBy: pendingEdits.submittedBy,
      reviewedBy: pendingEdits.reviewedBy,
      agentSlug: agents.slug,
    })
    .from(pendingEdits)
    .leftJoin(agents, eqSubmitter())
    .where(opts.since ? gte(pendingEdits.submittedAt, opts.since) : undefined);

  const outcomeById = new Map<number, EditOutcome>();
  const producerRecords: ProducerRecord[] = [];
  for (const e of editRows) {
    const reviewerIsAgent = e.reviewedBy != null && agentUserIds.has(e.reviewedBy);
    const reviewerIsSubmitter =
      e.reviewedBy != null && e.reviewedBy === e.submittedBy;
    const outcome = resolveEditOutcome(
      e.status,
      reviewerIsAgent,
      reviewerIsSubmitter,
    );
    outcomeById.set(e.id, outcome);
    // Only agent-submitted edits (those with a resolved agent slug) are producer
    // work; human submissions have no agent join and are skipped here.
    if (e.agentSlug) producerRecords.push({ agentSlug: e.agentSlug, outcome });
  }

  // Peer verdicts on pending_edit targets in the same window's edit set.
  // CAVEAT: agent_verifications is not append-only — a verifier changing its
  // verdict upserts the row (recordVerification) and a material edit revision
  // deletes the target's verdicts (clearVerificationsForTarget). So this reads
  // only surviving terminal verdicts, not the full judgment history; the
  // verifier accuracy metric is a lower bound, the same durable-history gap the
  // returnRate caveat describes. An exact replay needs a per-version verdict
  // audit table (see the design spec's open follow-up), not the live table.
  const editIds = [...outcomeById.keys()];
  const verdictRows =
    editIds.length > 0
      ? await db
          .select({
            targetId: agentVerifications.targetId,
            verdict: agentVerifications.verdict,
            verifierTier: agentVerifications.verifierTier,
            isImplicit: agentVerifications.isImplicit,
          })
          .from(agentVerifications)
          .where(
            and(
              eqPendingEditTarget(),
              inArray(agentVerifications.targetId, editIds),
            ),
          )
      : [];

  const verifierRecords: VerifierVerdictRecord[] = verdictRows.map((v) => ({
    verifierTier: v.verifierTier ?? null,
    verdict: v.verdict as 'approve' | 'dispute' | 'abstain',
    isImplicit: v.isImplicit,
    editOutcome: outcomeById.get(v.targetId) ?? 'pending',
  }));

  // Logged run usage in the window, oldest first so an identity's tier in the
  // per-agent table is that of its latest run. A database that predates
  // migration 0134 has no table yet; report no runs rather than fail the
  // accuracy half of the report.
  const usageRows = await db
    .select({
      agentSlug: agents.slug,
      modelTier: agentRunUsage.modelTier,
      workflow: agentRunUsage.workflow,
      model: agentRunUsage.model,
      inputTokens: agentRunUsage.inputTokens,
      outputTokens: agentRunUsage.outputTokens,
      cacheCreationTokens: agentRunUsage.cacheCreationTokens,
      cacheReadTokens: agentRunUsage.cacheReadTokens,
      modelUsage: agentRunUsage.modelUsage,
      createdAt: agentRunUsage.createdAt,
      startedAt: agentRunUsage.startedAt,
      durationMs: agentRunUsage.durationMs,
    })
    .from(agentRunUsage)
    .leftJoin(agents, eq(agents.id, agentRunUsage.agentId))
    .where(opts.since ? gte(agentRunUsage.createdAt, opts.since) : undefined)
    .orderBy(asc(agentRunUsage.createdAt))
    .catch((err: unknown) => {
      if (isUndefinedTable(err)) return [];
      throw err;
    });
  const runRecords: RunUsageRecord[] = usageRows.map((r) => ({
    ...r,
    agentSlug: r.agentSlug ?? null,
    modelUsage: r.modelUsage ?? null,
  }));

  // Outputs are counted only from the telemetry window onwards, so there is
  // nothing to fetch before the first logged run.
  const firstRunAt = earliestRunStart(runRecords);
  // Accepted edits for the cost ratio are fetched from the earliest included
  // run's START, not from --since: a run already under way at the cutoff is
  // included (its usage row is written at its end), so its earlier outputs
  // must be too, or its full cost would be divided by only part of its work.
  const acceptedOutputs: AgentOutputRecord[] = [];
  if (firstRunAt) {
    const runEditRows = await db
      .select({
        status: pendingEdits.status,
        submittedBy: pendingEdits.submittedBy,
        reviewedBy: pendingEdits.reviewedBy,
        submittedAt: pendingEdits.submittedAt,
        agentSlug: agents.slug,
      })
      .from(pendingEdits)
      .innerJoin(agents, eqSubmitter())
      .where(gte(pendingEdits.submittedAt, firstRunAt));
    for (const e of runEditRows) {
      const outcome = resolveEditOutcome(
        e.status,
        e.reviewedBy != null && agentUserIds.has(e.reviewedBy),
        e.reviewedBy != null && e.reviewedBy === e.submittedBy,
      );
      if (outcome === 'approved' || outcome === 'agent_applied') {
        acceptedOutputs.push({ agentSlug: e.agentSlug, at: e.submittedAt });
      }
    }
  }
  const verdictOutputs: AgentOutputRecord[] = firstRunAt
    ? await db
        // updated_at, not created_at: a verdict revised during a logged run
        // keeps its first created_at, but the run paid for the judgment that
        // survives — the upsert and reconsideration paths stamp updated_at.
        .select({ agentSlug: agents.slug, at: agentVerifications.updatedAt })
        .from(agentVerifications)
        .innerJoin(agents, eq(agents.id, agentVerifications.agentId))
        .where(
          and(
            eq(agentVerifications.isImplicit, false),
            gte(agentVerifications.updatedAt, firstRunAt),
          ),
        )
    : [];

  const producers = computeProducerMetrics(producerRecords);
  const decided = producers.reduce(
    (acc, p) => {
      acc.accepted += p.approved;
      acc.total += p.approved + p.rejected + p.returned;
      return acc;
    },
    { accepted: 0, total: 0 },
  );
  const acceptedFraction =
    decided.total > 0 ? decided.accepted / decided.total : null;

  return {
    since: opts.since ? opts.since.toISOString() : null,
    totalEdits: editRows.length,
    totalVerdicts: verifierRecords.filter((r) => !r.isImplicit).length,
    verifierTiers: computeVerifierTierMetrics(verifierRecords),
    producers,
    acceptedFraction,
    costs: opts.rateCard ? projectCosts(opts.rateCard) : null,
    runUsage: computeRunUsageMetrics(runRecords, opts.rateCard),
    agentCosts: computeAgentCostMetrics(
      runRecords,
      opts.rateCard,
      acceptedOutputs,
      verdictOutputs,
    ),
  };
}

function isUndefinedTable(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === '42P01') return true;
  }
  return false;
}

// Small helpers kept out of the query body so the join/predicate intent reads
// cleanly.
function eqSubmitter() {
  return eq(agents.userId, pendingEdits.submittedBy);
}
function eqPendingEditTarget() {
  return eq(agentVerifications.targetType, 'pending_edit');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sinceIdx = argv.indexOf('--since');
  const sinceArg = sinceIdx >= 0 ? argv[sinceIdx + 1] : undefined;
  const since = sinceArg ? new Date(sinceArg) : null;
  if (since && Number.isNaN(since.getTime())) {
    console.error('Invalid --since date (expected ISO 8601).');
    process.exit(1);
  }
  const asJson = argv.includes('--json');
  const rcIdx = argv.indexOf('--rate-card');
  const rcArg = rcIdx >= 0 ? argv[rcIdx + 1] : undefined;
  let rateCard: Record<string, RateCardEntry> | null = null;
  if (rcArg) {
    const { readFileSync } = await import('node:fs');
    rateCard = JSON.parse(readFileSync(rcArg, 'utf8')) as Record<
      string,
      RateCardEntry
    >;
  }

  const report = await runBenchmark({ since, rateCard });
  console.log(asJson ? JSON.stringify(report, null, 2) : formatReport(report));
}

// Run only as a CLI; importing for tests must not hit the DB.
const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
