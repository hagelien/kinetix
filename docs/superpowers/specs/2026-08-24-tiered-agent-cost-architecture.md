# Tiered agent cost architecture + capability-aware consensus

Status: draft (updated 2026-09-17)

Owner: agent-optimization workstream (`claude/kinetix-agent-optimization-7gn4hq`)

## Why

Every scheduled maintenance cycle (`agents/drug-db-maintainer.md`) runs the
whole five-action cycle — parameter verification, a wiki fact, the
discussion/approval sweep, a full-text paper review, and peer verification — at
one uniformly strong model + effort. That is expensive and, more importantly,
mis-allocated: ~80–90% of the work is routine (a stored value concordant with
2–3 clear primary sources, a straightforward paper, a clear peer approve), while
the ~10–20% that is genuinely hard (contested parameters, conflicting primaries,
subtle methodological flaws) is where reasoning depth actually pays for itself.

The target architecture separates **production, independent verification,
adjudication and final authority** rather than merely stacking progressively
larger models:

- a **mid-tier routine producer/reviewer** doing the bulk scientific work;
- a **flagship T2 verifier** doing selective, blind independent re-verification
  of high-risk or disputed targets;
- a **rare T3 appellate panel** that sees the surviving disagreement and
  adjudicates it with two independent flagship-class model families;
- a **T4 human** for cases that remain unresolved or cross an authority/policy
  boundary;
- **deterministic escalation** off signals the system already records, never
  "the cheap model felt unsure" alone;
- a **random 5–10% shadow audit** of apparently-routine work through the
  flagship verifier to measure the false-negative escalation rate;
- and a **capability-aware consensus gate** so a high-risk edit cannot
  auto-publish on the agreement of two same-tier agents that may share a blind
  spot.

This document is the anchor for that work. It is deliberately model-agnostic:
the routine is a scientific research/review agent, not a coding agent, and the
peer pool is already heterogeneous across vendors (`agents/drug-db-maintainer.md`
§0 runs the same cycle under distinct identities — e.g. `kinetix-agent` and
`codex-agent` — that peer-verify each other). Concrete model names below are
*current priors to validate*, not settled choices; the empirical curves
(§Benchmark) decide.

## The binding constraint

Scientific and forensic integrity. A wrong half-life or Vd corrupts every
calculation in the app, and the error class that matters is the one that is
*hard to detect*: a confident, plausible, wrong judgment that no downstream
check catches. Two facts about the current system make this sharp:

1. **Agent consensus can auto-publish.** `AGENT_CONSENSUS_APPROVE_QUORUM = 2`
   (`api/_lib/agent-verifications.ts`): two independent non-author `approve`
   verdicts with no open dispute apply an agent-authored pending edit with no
   human in the loop. The quorum is a **bare count with no notion of verifier
   capability**.
2. **It relaxes to one approval in a small pool.** `effectiveConsensusQuorum`
   drops the bar to 1 when the active-agent pool is too small to supply two
   independent verifiers (degraded mode, logged but still auto-applying). So in
   the common small-pool deployment, a *single* mid-tier approve can publish a
   calculation-driving parameter.

That is the integrity hole the capability-aware gate (§C) closes. Lowering the
producer tier is only safe *after* that gate exists.

---

## A. Tiered model architecture

### The economising axis: effort before model tier

When integrity is the binding constraint, economise on **effort before model
tier**. Effort governs invisible spend — thinking depth, tool-call volume,
self-verification — and trimming it removes waste on easy cases without lowering
the capability ceiling that catches undetectable errors. Lowering the *model
tier* lowers that ceiling, which is the riskier axis. This is why the
single-config answer keeps the strong base model and touches effort, not the
reverse.

### Single-config prior (if one model + effort must serve the whole cycle)

**Keep the flagship, run it at a middle effort, and benchmark one step down.**
Both current model lines land here:

| Line | Single-config prior | Quality-first alternative |
|---|---|---|
| Claude | Opus-class @ `high` (benchmark `medium`) | Opus-class @ `xhigh` |
| GPT-5.6 | Sol @ `medium` (Sol @ `high` if error cost dominates) | Sol @ `high` |

Do **not** run `xhigh`/`max` universally — it is wasteful for an ordinary cycle.
Do not adopt the one-step-down effort as permanent until the benchmark (§D)
shows the error rate holds. The single-config question is mostly moot: tiering
wins.

### Target tiered architecture

| Tier | Role | Model prior | Effort / authority |
|---|---|---|---|
| T0 | Mechanical / preprocessing | *deterministic code* > Haiku / Luna | low–med |
| T1 | Routine scientific producer + adversarial peer reviewer | Sonnet / Terra | high → benchmark medium |
| T2 | Blind escalation + high-risk verifier | Opus / Sol | high; peer verdict only |
| T3 | Rare non-blind appellate adjudication | two independent flagship-class families, e.g. Fable + Astra | xhigh / max; dedicated workflow role |
| T4 | Exceptional/final resolution | human | final authority |

The tier number is a **workflow level**, not a fourth model capability class.
`agents.model_tier` remains the server-owned capability vocabulary
`light | mid | flagship`; a T3 identity is still `flagship`. T3 authority must
come from a separate adjudication role/capability and prompt, never merely from
running a particular model.

Key design choices:

- **T1: produce and try to falsify peers.** The routine tier does the bulk work
  and participates in ordinary peer verification. A non-author reviewer should
  actively try to falsify the new entry/edit in the direct data, its context,
  scope, schema placement and source support rather than merely asking whether
  it looks plausible.
- **T2: independent verifier, not appellate judge.** When a deterministic §B1
  trigger fires, T2 independently checks the target and raw sources. It must be
  blind to lower-tier verdict rationales and approval counts. A dispute may be
  the routing reason, but the objection itself must not enter T2 context before
  its verdict is final. This gives the workflow a clean second measurement
  rather than a larger model anchored on T1's argument.
- **T3: adjudicate the surviving disagreement.** Only after the blind T2 verdict
  is stored may the complete lower-tier appeal record become visible. Two
  independent T3 identities receive the same case file but do not see each
  other's output. Their job is to resolve the exact scientific/scope/schema
  disagreement, including the possibility that the right answer is to split or
  narrow the proposition rather than choose one side. See
  `agents/drug-db-adjudication.md`.
- **T4: preserve human authority.** Material disagreement between the two T3
  panelists, missing decisive evidence, policy/schema choices, and any attempt
  to overrule a human-originated dispute/flag/return/rejection route to a human.
- **T0 is mostly code.** Queue selection, API routing, schema conformance,
  duplicate pre-checks, comparison of adjudication outputs, and logging are
  deterministic and should not spend model tokens at all (§E).
- **Rough economics.** At current rates the mid-tier is ≈40% of flagship
  per-token on both lines. A 90/10 T1/T2 split is ≈46% of all-flagship model
  cost (≈54% saving); 80/20 is ≈52% (≈48% saving). T3 should be sufficiently
  rare that its double-flagship cost is dominated by integrity, not token price.
  These are **per-token upper bounds** — the real figure is *cost per accepted
  correct task* (§D), and a stronger model that searches/backtracks less can
  beat a cheaper one that churns.

### The producer/verifier omission risk

If T2 only judges what T1 chose to surface, it inherits T1's framing — it never
sees the contradicting study T1 dismissed or failed to find. Two mitigations,
both required:

1. For high-risk targets, T2 verification must be able to **pull the raw
   sources itself**, not just judge T1's writeup.
2. The §D random audit must be a **full independent redo**, not a summary check
   — otherwise it cannot catch omission / search-miss errors, which are exactly
   the errors two same-tier producers are most likely to share.

T3 solves a different problem. It is allowed to see the lower-tier arguments
because its task is no longer measurement independence; it is adjudication of a
known conflict. Its independence requirement is instead **between the two T3
panelists**.

---

## B. Deterministic escalation and dispute resolution

### B1. T1 → T2: escalate to blind flagship verification

Route the target to T2 when **any** of these fire. They are all signals the
Kinetix schema already records, so the routine tier is never the sole authority
on whether its own work is hard:

- an editor/admin **A0 flag** on the target;
- an open peer **`dispute`**, or a reviewer **return** / **rejection** in
  history;
- **`weak` concordance** on the parameter;
- materially **conflicting primary studies**;
- a proposed **replacement of an established calculation-driving parameter**
  (as opposed to mere corroboration of the existing value);
- an **`absent` conclusion on a core/important parameter**;
- **citation/identifier inconsistency**, correction, expression of concern, or
  retraction;
- any **paper-review deeper-pass trigger** the review protocol already defines
  (outcome switching, serious missingness, unexplained denominators,
  multiplicity, implausible values, statistical inconsistency).

The routine tier *may additionally* escalate on its own uncertainty, but
uncertainty is a supplement to the deterministic list, never a replacement.

The T2 router should reveal the **target identifier and risk trigger category**
only as needed for prioritisation. It must not reveal another reviewer's
`reasonMd`, `evidenceRefs`, verdict, or approval count before T2 records its own
verdict. The existing generic `/api/disputes` feed is therefore not a safe T2
input; the dedicated identifier-only feed described in
`agents/drug-db-escalation.md` is required.

### B2. T2 → T3: escalate only persistent material disagreement

A T1 dispute does **not** go directly to T3. After T2 has completed its blind
re-verification, create a T3 adjudication case only when at least one of these is
true:

- **T1/T2 material disagreement:** a live lower-tier `dispute` remains while T2
  independently approves the disputed proposition, or an equivalent future
  symmetric conflict exists;
- **competing defensible interpretations:** T2 concludes that populations,
  routes, matrices, definitions, time windows, model assumptions or other scope
  make more than one interpretation genuinely defensible;
- **flagship disagreement:** independent flagship verifiers materially disagree
  on the same target/version;
- **repeated correction loop:** the same material proposition has completed at
  least two correction/return/dispute cycles without settling;
- **explicit editor request:** a human asks for an agent adjudication memo while
  retaining final authority.

Do **not** use T3 as a generic confidence booster. In particular, missing full
text, a missing supplement, or an inaccessible decisive source should produce
acquisition work + `abstain`, not escalation. A larger model cannot resolve
missing evidence.

### B3. T3: non-blind cross-model appellate panel

T3 receives the complete appeal record only **after** T2's independent verdict
is immutable for that target version. The case file contains the exact disputed
proposition, target payload/version, lower-tier verdicts and rationales, raw
sources, relevant scope/schema fields, and material revision history.

Run two independent flagship-class adjudicator identities, preferably from
different model families. Both see the same lower-tier case file; neither sees
the other's draft or conclusion. Each returns a structured resolution as defined
in `agents/drug-db-adjudication.md`.

The backend should treat the panel as converged only when both agree on the
**material resolution and scope**. Superficial label agreement is insufficient.
For example, two `approve` outputs referring to different populations are still
a disagreement.

For an agent-only dispute, convergence may eventually support a narrowly scoped
automated resolution path, but that is a separate governance/implementation
decision. T3 should not inherit unrestricted `dispute.resolve` merely because it
runs a flagship model.

### B4. T3 → T4: human resolution

Route directly to a human when:

- the two T3 panelists materially disagree;
- resolving the case would overrule a **human-originated** dispute, flag, return
  or rejection;
- decisive evidence remains unavailable or irreconcilable;
- the choice is clinical/forensic policy rather than factual synthesis;
- the correct representation requires a schema/product-design decision;
- multiple evidence-compatible conventions exist and Kinetix must choose one
  intentionally;
- a new failure mode falls outside the adjudication contract.

The human handoff must include the target/version, lower-tier record, both T3
outputs, decisive evidence, and one concise statement of what remains disputed.
Do not make the human reconstruct the case from scattered logs.

### Shadow audit (measures the thing you actually need)

Route a random **5–10%** of apparently-routine T1 work to T2 as a **full
independent redo**, blind to T1's conclusion. This estimates the
**false-negative escalation rate** — how often T1 says "routine" while T2 finds
a materially wrong result — which is the only failure mode that actually
threatens integrity and the number that licenses lowering T1 from `high` to
`medium`.

---

## C. Capability-aware consensus (the integrity fix — implemented here)

Attach the verifier's **capability tier** to the consensus decision and require
a top-tier verdict before a high-risk agent-authored edit can auto-publish. The
change only ever *tightens* auto-apply; it never loosens anything.

### Tier classification (server-owned, vendor-agnostic)

The gate reads the tier from a **server-owned** column, `agents.model_tier`
(migration `0111`), set by the admin who provisions the agent — **not** from the
verdict POST body. `agent_verifications.model` is caller-supplied: an agent can
send any string, so a mid/light verifier could claim `claude-opus-5` and have
its approval counted as flagship, defeating the gate. The self-reported `model`
stays recorded for audit and offline analysis, but the gate never trusts it.

`agents.model_tier` is one of the tier vocabulary in `src/lib/modelTiers.ts`
(shared with the benchmark's model-id classifier, which currently maps
`opus`/`fable`/`mythos`/`sol` → flagship, `sonnet`/`terra` → mid,
`haiku`/`luna` → light):

- **T2 and T3 model capability**: `model_tier = 'flagship'`.
- **T1 / T0**: `'mid'` / `'light'`.
- **unknown / NULL**: untrusted — **never** satisfies the high-risk gate.

Do not add `superflagship` merely to represent T3. Model capability and workflow
authority are separate axes. If a new adjudicator model such as Astra is not yet
recognised by `src/lib/modelTiers.ts`, update the registry and/or explicitly
provision the trusted server-owned `model_tier` before deployment; an unknown
self-reported model string grants nothing.

NULL-maps-to-untrusted is the fail-safe direction: an unclassified agent must
not be able to stand in for a flagship reviewer, so a fresh deployment holds
high-risk edits for a human until an admin classifies at least one flagship
verifier. The vendor-agnostic classifier stays useful for provisioning —
deriving the tier to store on `agents.model_tier`. The benchmark deliberately
does **not** use it: it attributes verdicts only by the trusted
`verifier_tier` snapshot and treats a NULL snapshot as `unknown`, never
model-classified, so a self-reported model cannot be spoofed into a real tier's
accuracy cohort.

The admin sets `agents.model_tier` through the agents Admin API (`modelTier` on
create/patch; migration `0111`). The gate does **not** read that live column at
tally time, though — it reads a **snapshot** taken when each verdict was
recorded (`agent_verifications.verifier_tier`, migration `0113`, copied from the
verifier's `agents.model_tier` server-side at write time). Reading the live
column would let an agent identity reassigned from a mid to a flagship model
retroactively reclassify all of its past approvals as flagship (and a downgrade
erase valid ones); the snapshot pins the tier that actually cast each verdict.

### High-risk classification of a pending edit

The **apply gate** keys on a pure function of the edit's own fields, so it adds
no DB read to the hot path: a pending edit is **high-risk** when it is a
`parameter` / `param_entry` edit whose parameter is **calculation-driving**
(entry-backed — the summarizable PK/PD measurements plus the model-structure
axes; identity metadata like names/MW/CID and per-matrix `analyteStability` are
excluded). This is the set whose value feeds every calculation in the app and
where an undetectable error is most costly.

The other high-risk signals are enforced where they live, not at the apply gate:
`weak` concordance is a **routing-layer** escalation trigger (§B) — it sits on
`verification_log`, not on the edit, so folding it into the apply gate would add
a join to the hot path for a signal the producer/verifier routing already acts
on. Disputes and returns need no tier rule at all: an open dispute *blocks*
consensus outright, and a returned/rejected edit is out of the auto-apply path
entirely.

### The rule

For a high-risk agent-authored pending edit, auto-apply requires **all** of:

1. the existing gate — `disputeCount === 0` and
   `approveCount >= AGENT_CONSENSUS_APPROVE_QUORUM` (the full design-target
   quorum of 2, i.e. **degraded single-approve mode does not apply to high-risk
   edits**); and
2. at least **one explicit, non-implicit approval from a flagship (T2-capable)
   model identity**.

If either fails, the edit does **not** auto-apply — it waits for a human
moderator, exactly as it does today when the quorum is unmet. Non-high-risk
edits keep the current behaviour unchanged. Every rejection of an otherwise-met
quorum for want of a flagship verdict (or for degraded-mode on a high-risk edit)
is logged, so the hold is never silent and operators can see whether the pool
needs a T2 verifier added.

This lets T1 do the expensive bulk work while T2 performs a narrow, independent
check on exactly the data where a shared blind spot would be most costly. T3 is
outside this ordinary consensus tally: it exists to adjudicate a disagreement
that the peer-verdict layer did not settle.

Implementation lives in `api/_lib/agent-verifications.ts` (tier + high-risk
classifiers, extended summary, risk-aware quorum predicate) and the apply path
in `api/_lib/pending-edits-helpers.ts`. See that code and its tests for the
exact wiring.

---

## D. Benchmark methodology

Everything above is a **prior**. We do not yet have Kinetix-specific
accuracy-vs-cost curves, so the rollout is gated on measuring them, not on
assuming equivalence.

### Metric: cost per *accepted correct* action, not price per token

Weight the error metrics by how hard the error is to detect and how costly it
is. In particular a **false auto-approve** (consensus published something a
human would have rejected) counts far more heavily than a harmless unnecessary
escalation.

Per-config metrics to compute over historical agent work:

- human **rejection** rate and **return** rate;
- peer **dispute** rate against the config's output;
- **false-approve** rate (consensus-applied edits later reverted/corrected);
- **citation/identifier** error rate;
- **numerical extraction** error rate;
- **concordance misclassification** rate;
- **cost per ultimately-accepted action** (tokens × rate ÷ accepted actions).
  *(Update: tokens are now measured per run in `agent_run_usage` with a
  server-snapshotted tier, and the benchmark reports measured cost per tier ×
  workflow and per accepted edit / verdict per identity.)*

For the four-level workflow also track:

- T1→T2 escalation rate by deterministic trigger;
- T1/T2 material-disagreement rate after blind T2 review;
- T3 panel convergence rate and human-handoff rate;
- rate at which T3 finds a **scope split/narrowing** rather than choosing either
  lower-tier position;
- false closure/reopen rate for any future automated agent-dispute resolution.

### Harness

`scripts/benchmark-agent-tiers.ts` replays historical agent submissions and
verdicts from the database and computes the above per config, so
Sonnet/Terra-medium vs -high vs Opus/Sol-medium vs -high can be compared on
*real past work* before anything changes in production. See the script and
`docs/ops/agent-tier-benchmark.md` for inputs, outputs, and how to read the
report.

**Known limitation — the live tables are not append-only.** The replay reads
current-state rows, but neither `pending_edits` nor `agent_verifications`
retains per-version history: a returned edit that is revised and re-approved
shows only its final `approved` status, a verifier that changes its verdict
upserts the row, and a material edit revision clears the target's verdicts. So
`returnRate` and the verifier `falseApproveRate` are **lower bounds** — the
harness labels them as such. Making them exact needs a single follow-up: a
durable per-version decision/verdict **audit table** written on every reviewer
and verifier action. The T3 workflow strengthens that requirement further: an
adjudication case must pin the exact target version and preserve all decisions
that produced the appeal. Until the durable history exists, read the two rates
as floors and lean on the shadow-audit false-negative rate for producer-tier
changes.

---

## E. Instruction-bundle & caching cost levers

Independent of model choice, two structural levers cut input cost on **every**
tier:

### E1. Slim the runtime contract; move deterministic rules into code

A full cycle currently pulls ~50–60k tokens of static instructions into context
**every hour on a fresh clone** (`drug-db-maintainer.md` ~29.5k, plus the
paper-review spec ~14k, peer-verification protocol ~7k, source-selection ~4.6k,
etc.). Two moves:

- **Core + lazy-loaded action modules.** A ~6–8k-token core (tooling, hard
  rules, cycle order, logging, output) plus per-action modules read *only when
  that action has work this cycle* (§3 prioritisation already reveals which
  buckets are non-empty via cheap API calls before the writing rules are
  needed). The paper-review methodology alone is ~14k tokens and its action
  frequently no-ops — lazy-loading stops paying for it on those cycles.
  Estimated 45–70% cut in instruction tokens, multiplicative with model/effort.
- **Deterministic housekeeping is code, not prose.** Queue selection, API
  routing, schema conformance, duplicate pre-checks, adjudication-panel
  comparison, and logging should be enforced by scripts the agent *calls*, not
  instructions it *re-reads*. Don't spend frontier-model tokens rereading rules
  a script can enforce perfectly.

Human design-rationale prose belongs in `docs/`, not in the file the agent reads
hourly; keep the agent file imperative and contract-shaped.

### E2. Make the static prefix cacheable

The API prompt cache is server-side, keyed on prefix bytes, TTL up to 1h — a
fresh container does **not** prevent a cross-run hit if the leading bytes are
byte-identical and the next run lands within the TTL. Two actions:

- **Protect prefix byte-stability.** Keep the static instruction block first and
  identical run-to-run; never inject anything volatile early (a per-run
  timestamp, run id, or "today's date" ahead of the instruction read silently
  drops the cache to zero). Verify with `usage.cache_read_input_tokens` — if it
  is ~0 across runs, a silent invalidator is the culprit and fixing it recovers
  most of this lever with no restructuring.
- **Align TTL to cadence.** Default ephemeral TTL (~5 min) is cold by the next
  hourly run. Either set the static prefix to a 1h TTL (and run slightly under
  60-min cadence so it reliably hits) or bank the guaranteed within-run win: one
  cycle makes dozens of tool round-trips, and the big instruction read is paid
  once at full rate then served at ~0.1× on every subsequent turn. Whether the
  Routine harness exposes TTL/prefix control is a harness setting to verify; the
  reliable repo-side lever is E1.

### E3. Effort should track action difficulty

The producer runs at `high` initially. T2 uses a flagship model at `high` for
focused blind verification. T3, because it is rare and information-dense, is the
right place for `xhigh`/`max` where supported. Do not pay adjudication-level
reasoning cost on every routine escalation.

---

## Rollout sequence

1. **Ship the consensus fix first (C).** It is a real integrity hole *today*,
   independent of tiering, and it is the precondition that makes lowering the
   producer tier safe.
2. **Run the benchmark (D)** on historical work to get real curves.
3. **Slim the bundle (E1) + audit caching (E2).** Multiplicative savings on
   every tier, no behaviour change.
4. **Build the T2 substrate first: the identifier-only escalation feed, the
   recent-applied-work sampler, and durable per-version audit history.** These
   are prerequisites, not follow-ups. Without the feed, "deterministic
   escalation" cannot route disputed/high-risk targets without leaking the
   disputant's reasoning into a blind verifier; without the sampler, the shadow
   audit cannot run on immutable applied work, and step 8 can never be
   justified. See `agents/drug-db-escalation.md` → "Not yet available".
   *(Update, issue 1231: the escalation feed sub-item is built —
   `GET /api/agent-escalation-queue`, covering five of the nine triggers named
   in §B1 above; the sampler and durable audit history remain open.)*
   *(Update, issue 1232: the sampler sub-item is built —
   `GET /api/agent-audit-sample`, a random 5–10% sample of
   `drug_parameter_revisions` — the shadow audit can now run on immutable
   applied work; durable per-version audit history remains the one open
   prerequisite.)*
5. **Introduce T1/T2 tiering (A/B1)** with deterministic escalation and the
   shadow audit, T1 at `high`. Keep T2 blind.
6. **Implement T3 case hydration + independent panel writes (B2/B3)** without
   granting automatic dispute resolution initially. Measure convergence against
   human outcomes.
7. **Only after governance + benchmark evidence**, consider narrow automatic
   closure of convergent **agent-originated** disputes. Human-originated disputes
   remain human-controlled.
8. **Only then**, if the shadow-audit false-negative rate stays flat, lower T1
   to `medium`.

## Open questions (empirical / governance)

- Does the 80–90% "routine" assumption hold on the live backlog? Instrument via
  `verification_log` concordance and dispute rates before committing tier ratios.
- Is T1 `medium` safe, or does it under-search the ≥3-source / deeper-pass work
  the protocols mandate? The shadow audit answers this.
- Exact calculation-driving parameter set for the high-risk classifier — pinned
  from the parameter registry, kept in sync by test.
- Is **two** correction/return/dispute cycles the right deterministic threshold
  for repeated-loop escalation to T3?
- What exact workflow capability should identify a T3 adjudicator, separate from
  `agents.model_tier = 'flagship'`?
- After prospective validation, should convergent T3 decisions merely recommend
  closure, ask the original agent disputer to reconsider/withdraw, or directly
  close **agent-only** disputes under a narrowly scoped capability?
- Which second flagship family is best for the appellate panel at deployment
  time? Fable/Astra is a current prior, not a hard-coded architectural rule.
