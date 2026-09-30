/**
 * Shadow-mirror counters (Phase 4's "Observability" list).
 *
 * In-process and deliberately minimal. Kinetix runs on Vercel serverless
 * functions with no metrics agent and no long-lived process to scrape, so a
 * counter here survives only as long as one warm instance. That is enough for
 * what these are for: the exit gate is evaluated from the *database* — the
 * reconciliation scanner counts what is actually missing — and these counters
 * are for the log line and the diagnostics endpoint that tell an operator
 * whether mirroring is running at all right now.
 *
 * Anything that must survive a cold start is written to `kg_audit_events`
 * instead, where a repair item can be found later. A counter that quietly reset
 * to zero is a bad place to keep the record of a lost mirror.
 */

export const MIRROR_METRICS = [
  'kg_mirror_attempt_total',
  'kg_mirror_success_total',
  'kg_mirror_failure_total',
  'kg_reconciliation_missing_total',
  'kg_payload_fingerprint_mismatch_total',
  'kg_state_projection_mismatch_total',
  // §17.3 asks for a fallback count, and both fallback paths were silent until
  // the parity report went looking for one and had to say "not instrumented".
  // Counted separately because the two answer different questions: a read
  // falling back means a badge served a legacy number, while a publication
  // falling back means the legacy gate decided. The first is a data-coverage
  // signal, the second is about who is in charge.
  'kg_read_fallback_total',
  'kg_publication_fallback_total',
  // A version whose assessment history contains rows the port cannot read.
  // Counted because that version is now held — it can carry no approvals at
  // all until a person looks at it — and a hold nobody can see is a proposal
  // that quietly stops moving. The label is the proposal id, so the answer to
  // "which ones?" is in the counter rather than only in the count.
  'kg_unreadable_assessment_history_total',
  // An assessment whose `capability_snapshot` is in no shape the store or the
  // host's compatibility reader recognises. It confers no capabilities, which
  // is the safe direction and was already the behaviour — what was missing is
  // that anyone knew: a corrupt snapshot and an assessor with genuinely no
  // standing produced the same silent empty list. Distinct from the counter
  // above because that one holds the version and this one does not, so this is
  // the failure that can otherwise publish unnoticed.
  'kg_non_canonical_capability_snapshot_total',
] as const;

export type MirrorMetric = (typeof MIRROR_METRICS)[number];

/** The counter above, named so a caller cannot typo it into a new series. */
export const UNREADABLE_HISTORY_METRIC =
  'kg_unreadable_assessment_history_total' satisfies MirrorMetric;

/** As above, for a snapshot in no recognised shape. */
export const NON_CANONICAL_SNAPSHOT_METRIC =
  'kg_non_canonical_capability_snapshot_total' satisfies MirrorMetric;

/**
 * Counter values keyed by metric, then by a dimension label.
 *
 * The label is the target type for the mirror counters. For
 * `kg_reconciliation_missing_total` it is the divergence class instead — "what
 * kind of loss is happening" is what the exit gate asks, and the target type is
 * already on every individual finding. For the two fallback counters it is the
 * *reason*, for the same purpose: "it fell back 40 times" is not actionable,
 * and "40 times because the linkage was incomplete" is.
 */
type Counters = Map<MirrorMetric, Map<string, number>>;

const counters: Counters = new Map();

export function incrementMetric(
  metric: MirrorMetric,
  label: string,
  by = 1,
): void {
  const perLabel = counters.get(metric) ?? new Map<string, number>();
  perLabel.set(label, (perLabel.get(label) ?? 0) + by);
  counters.set(metric, perLabel);
}

export function readMetric(metric: MirrorMetric, label: string): number {
  return counters.get(metric)?.get(label) ?? 0;
}

/** Total across every label. */
export function readMetricTotal(metric: MirrorMetric): number {
  let total = 0;
  for (const value of counters.get(metric)?.values() ?? []) total += value;
  return total;
}

/** Every non-zero counter, for a diagnostics response. */
export function snapshotMetrics(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const metric of MIRROR_METRICS) {
    const perLabel = counters.get(metric);
    if (!perLabel || perLabel.size === 0) continue;
    out[metric] = Object.fromEntries([...perLabel.entries()].sort());
  }
  return out;
}

export function resetMetricsForTests(): void {
  counters.clear();
}
