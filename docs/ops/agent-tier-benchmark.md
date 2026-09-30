# Agent tier benchmark

`scripts/benchmark-agent-tiers.ts` (`npm run benchmark:agent-tiers`) replays the
maintenance agents' historical work and reports the metrics that gate the
tiered-agent rollout — see
`docs/superpowers/specs/2026-08-24-tiered-agent-cost-architecture.md` §D. It is
**read-only**: SELECTs only, no writes.

## Run it

```bash
# All history, formatted text:
npm run benchmark:agent-tiers

# Bound the window and emit JSON:
npx tsx scripts/benchmark-agent-tiers.ts --since 2026-06-01T00:00:00Z --json

# Price measured runs (and project unrun configs) from a rate card:
npx tsx scripts/benchmark-agent-tiers.ts --rate-card docs/ops/rate-card.example.json
```

It reads `DATABASE_URL` from the environment (via `dotenv`), like the other
data scripts. Run it from a trusted admin workstation, not from a Routine
environment.

## What it measures — and the one thing it can't

Two ground-truth signals are recorded and form the strong part of the report:

- **Verifier accuracy by capability tier.** Each verdict is attributed **only**
  by the server-owned tier snapshot (`agent_verifications.verifier_tier`); a NULL
  snapshot (a legacy pre-`0113` verdict, or one from an unclassified agent) is
  `unknown` and never classified from the self-reported `model` — so a spoofed or
  omitted model can't move a verdict into a real tier's cohort. Cross-referenced
  with the pending edit's eventual human decision, this gives, per tier, the
  **false-approve rate** (the tier `approve`d something a human then rejected)
  and the over-dispute count.
  This is the number that licenses lowering a producer tier: if the mid tier's
  false-approve rate is at or below the flagship tier's on comparable volume,
  the routine tier can drop.
- **Producer outcomes by agent identity** — human rejection / return / approval
  rates per submitting agent.

The database does **not** record per-submission producer model, so producer
metrics are keyed by agent *identity* (a proxy — one identity may run different
models over time).

Token usage **is** recorded per run, in `agent_run_usage` (migration 0134): each
routine's last step, `scripts/kinetix-log-run-usage.ts --workflow <…>`, sums the
run's tokens from its own transcript and the server stamps the identity's
capability tier on the row. The report adds two measured sections:

- **Measured run usage by capability tier** — per tier × workflow: runs, tokens
  per run, cache-read share (the caching lever's hit rate, spec §E2), and cost
  where the rate card prices the run's model.
- **Measured cost per useful output, by agent identity** — cost per accepted edit
  (human-approved + consensus-applied) for producers and cost per peer verdict
  for reviewers. Shown only when every run of the identity is priced. An
  output counts only if it was made during one of the identity's logged runs
  (`started_at` to `started_at + duration_ms`), and only those runs' cost is
  divided by it — so work before telemetry, or from a run whose usage log
  failed, can never make a tier look cheaper than it is.

Each run also stores its tokens split by model, so a subagent on a cheaper (or
dearer) model is priced at its own rate; a run using any model the rate card
does not list is unpriced as a whole. A transcript with no usage record is
refused by the logger rather than recorded as a free run, and re-logging a
session refreshes its counts without moving its tier or date.

These are the numbers that answer "did tiering lower cost without lowering
accuracy": read them against the verifier-accuracy table for the same window.
Runs logged before an identity was classified carry a NULL tier and land in
`unknown`, exactly like verdicts. The older **projection** (price × *estimated*
tokens per action) remains for configs that have not run yet and is labelled as
an estimate.

### The one thing this benchmark can't measure

`falseApproveRate` above scores cast **verdicts**, and it deliberately excludes
consensus-applied edits from its ground-truth denominators — an edit published
by agent consensus has `reviewed_by` set to the tipping agent, so counting it
as human-decided would let those very approvals validate themselves. That
leaves the producer's own false-negative rate — how often a producer says
"routine" while a blind independent redo finds a materially wrong result —
measured by nothing here. `GET /api/agent-audit-sample` (issue 1232) is the
substrate that closes that gap: a random 5–10% sample of already-applied,
immutable `drug_parameter_revisions` for the flagship tier to redo blind. This
benchmark does not yet ingest those shadow-audit verdicts (it only reads
`pending_edit`-targeted rows); until a durable per-target-version decision
history exists (`agents/remote-routine-setup.md` §7), read the shadow audit's
results the same way any other `agent_verifications` row is read today, via
`GET /api/agent-verifications`.

## Known limits of the measured cost (issue 1444)

Four residual gaps are accepted for now and tracked in issue 1444:

- **The closing inference is not counted.** Routines log usage as their last
  tool call, so the one model turn that writes the final paragraph comes after
  the transcript is read. That is roughly 1–3% of a run, and about the same
  share in every tier, so tier-vs-tier comparisons are largely unaffected;
  absolute cost reads slightly low.
- **Concurrent runs of one identity can be confused.** Outputs are matched to
  runs by time window. If two routines share one agent token, overlap, and one
  of them fails to log, the failed run's outputs are credited to the other and
  its `$/accepted` or `$/verdict` reads low. Giving each routine its own
  identity removes the risk.
- **The tier is read when the run is logged, not when it starts.** An agent
  reclassified while one of its runs is in flight has that run filed under
  the new tier. Pause the routine before changing an agent's tier (the
  model is changed on the Routine between runs anyway).
- **Rows are self-reported.** The logger reads the run's transcript, but the
  endpoint accepts any agent-token POST. It rejects rows no transcript could
  produce: zero usage, a per-model split that does not sum to the totals, and
  timing in the future. A consistent but falsified row still gets through,
  so treat the numbers as the same trust level as the self-reported
  `agent_verifications.model`.

## Rate-card format

A JSON object mapping a config label to its per-MTok prices. `models` lists
case-insensitive substrings of the transcript model id the entry prices — a run
whose model matches no entry is reported as unpriced, never guessed. When
several entries match, the longest pattern wins (`gpt-5.6` over `gpt-5`); two
entries tying on the longest match leave the run unpriced. Cache
prices default to 10% (read) and 125% (write) of the input price. The
`est…PerAction` fields are optional and only feed the projection:

```json
{
  "sonnet-5-high": {
    "inputPerMTok": 3, "outputPerMTok": 15, "models": ["sonnet-5"],
    "estInputTokensPerAction": 200000, "estOutputTokensPerAction": 20000
  },
  "opus-5-high": {
    "inputPerMTok": 5, "outputPerMTok": 25, "models": ["opus-5"],
    "estInputTokensPerAction": 200000, "estOutputTokensPerAction": 20000
  }
}
```

The report emits a real per-config `cost/action` (price × est tokens) and the
measured human acceptance **once**, as a single baseline across all producers.
It deliberately does **not** divide each config by that shared acceptance to
print a per-config `cost/accepted-action`: producer model is not recorded per
edit, so there is no per-config acceptance to attribute, and dividing every
config by the same number would rank them purely by token price — hiding the
one tradeoff that matters. Per-config quality comes from the shadow-audit
false-negative rate (verifier-tier accuracy), not from the cost projection.

## How to read a small sample

`falseApproveRate` is computed over a tier's human-**decided** approvals only.
A tier with a handful of verdicts is not yet evidence; grow the window before
acting on it. Weight a false-approve far more heavily than a harmless
over-dispute when deciding whether a tier is safe to lower.
