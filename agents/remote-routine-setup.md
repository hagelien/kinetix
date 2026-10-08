# Running the drug-db maintainer as a Claude Code Routine

This is the runtime counterpart to `agents/drug-db-maintainer.md`. The prompt is the _what_; this doc is _how to make it fire on schedule without your laptop in the loop_.

**Why remote?** Routines run on Anthropic-managed cloud infrastructure, so the hourly cycle fires regardless of whether your machine is on, asleep, or offline. Each run clones this repo fresh from the default branch and injects secrets from a cloud environment.

Official docs:

- Routines: <https://code.claude.com/docs/en/routines.md>
- Cloud environments: <https://code.claude.com/docs/en/claude-code-on-the-web.md>

## 1. One-time setup

### 1a. Seed the `kinetix-agent` user (local, once)

From a local clone:

```bash
npm run seed:agent-user
```

It prints the `users.id` of the `kinetix-agent` row for your records.

Then mint the agent's persistent API token (printed once):

```bash
npm run seed:agent-token
```

This emits a `kxat_…` secret. Save it — you'll paste it into the cloud environment as `KINETIX_TOKEN`. Agent-backed users can no longer authenticate with a bare JWT, so this revocable token is the agent's only credential. Re-run this command to rotate; revoke a leaked token from Admin → Agents → Tokens.

### 1b. Create the cloud environment

Go to <https://claude.ai/settings/environments> → **New environment** (call it e.g. `kinetix-prod`). Add these variables (all are required):

| Name                    | Value                                            |
| ----------------------- | ------------------------------------------------ |
| `KINETIX_TOKEN`         | the `kxat_…` agent token from 1a                 |
| `KINETIX_BASE_URL`      | e.g. `https://kinetix.app`                       |
| `KINETIX_AGENT_DRY_RUN` | `1` for the first run, then remove or set to `0` |

Values are encrypted at rest, but the runner injects them as normal environment variables visible to Bash. Keep the Routine environment intentionally narrow: do **not** add `DATABASE_URL`, `JWT_SECRET`, `ANTHROPIC_API_KEY`, or other production secrets. The helpers (`scripts/kinetix-api.sh`, `scripts/kinetix-log-verification.ts`) need only `KINETIX_TOKEN` and `KINETIX_BASE_URL`; `dotenv/config` in the TS scripts is a no-op on the remote runner (no `.env` file is present) and is only active for local smoke tests.

Do **not** put `ANTHROPIC_API_KEY` in this environment. The Routine's compute is billed against your Anthropic account automatically; the runner handles model auth itself.

### 1c. Smoke-test locally before scheduling

Create `.env` at the repo root with the same non-DB values from 1b, including the minted `KINETIX_TOKEN`, then:

```bash
KINETIX_AGENT_DRY_RUN=1 scripts/kinetix-api.sh GET /api/drugs?limit=1
KINETIX_AGENT_DRY_RUN=1 npx tsx scripts/kinetix-log-verification.ts \
  --target-type parameter --target-id 1 --parameter halfLife \
  --sources-count 3 --concordance strong --outcome submitted_pending \
  --notes "smoke test"
```

Both should print a `[dry-run]` line and exit 0. If they fail, fix the config before creating the Routine — the remote runner will hit the same failures.

### 1d. Preinstall Poppler (`pdftotext`) in the runner image

The paper-review action reads stored citation PDFs (`agents/drug-db-maintainer.md` §11). The `scripts/extract-citation-pdf-text.sh` fallback needs Poppler's `pdftotext`, which is **not** part of the Kinetix app runtime and must be provided by the runner environment **before the cycle starts**. Add it to the environment's setup/build step (not the scheduled prompt):

```bash
apt-get update
apt-get install -y --no-install-recommends poppler-utils
rm -rf /var/lib/apt/lists/*
```

The agent itself must **never** run `apt-get` or install packages during a scheduled cycle — installs belong in the image/setup step only.

**Claude runner note.** The Claude Code `Read` tool reads PDFs natively (including scanned / image-only pages), so the Claude Routine can read a downloaded stored PDF without Poppler — for it, this preinstall is a belt-and-suspenders fallback, not a hard requirement. It **is** required for any runner whose model cannot read PDFs directly (e.g. a Codex runner), which otherwise has no permitted way to extract stored-PDF text and must skip the review with a `missing_pdf_text_extractor` note. Deliberately keep PDF extraction out of the Vite/Vercel app runtime and out of production npm dependencies — it lives only in the runner image and this shell wrapper.

## 2. Create the Routine

At <https://claude.ai/code/routines> → **New routine**, or from any CLI session: `/schedule`. Fill in:

| Field           | Value                                                      |
| --------------- | ---------------------------------------------------------- |
| **Name**        | `Kinetix drug-db cycle`                                    |
| **Trigger**     | Schedule → `Every 1 hour` (or whatever cadence you prefer) |
| **Repository**  | `hagelien/kinetix` (default branch)                        |
| **Environment** | `kinetix-prod` (from 1b)                                   |
| **Model**       | the tier-defining choice — **must match this agent's `agents.model_tier`** (`flagship` = Opus/Fable/Mythos/Sol or another explicitly provisioned flagship, `mid` = Sonnet/Terra, `light` = Haiku/Luna); see §7 |
| **Effort**      | reasoning/effort level — `high` for a producer or T2 high-risk verifier |
| **Prompt**      | See below                                                  |

> **Reconcile the tier before the first live run.** The server trusts
> `agents.model_tier` verbatim (it never re-derives it from the running model), so
> a Routine on a `mid` model whose `model_tier` says `flagship` would let that
> model clear the high-risk consensus gate. After choosing the Model above,
> confirm `agents.model_tier` matches it and, as an admin, correct it in
> **Admin → Agents → Edit** via the **Model tier** dropdown if it does not (same
> reconciliation as `agents/adding-a-new-agent.md` Step 5); each row shows its
> current tier as a badge, and assigning `flagship` asks for confirmation.
> `PATCH /api/admin?resource=agents&id=<id>` with `{ "modelTier": "<tier>" }`
> does the same thing without that confirmation, for scripted provisioning.
> Either way this is admin-only; the agent's own `kxat_` token can't reach
> `/api/admin`. **Repeat this on any later Model change too** — each verdict
> snapshots the current `model_tier`, so a Routine downgraded to a cheaper model
> while still classified `flagship` would let that model clear the high-risk
> gate. Pause the Routine, reset the tier, verify, then resume.

### Prompt to paste

```
Read agents/drug-db-maintainer.md end-to-end, then run exactly one cycle and emit its end-of-cycle paragraph (§9). Output only that paragraph.
```

No `cd` prefix is needed — the Routine runner starts in the repo root of the fresh clone.

## 3. First runs

- **Dry run first.** With `KINETIX_AGENT_DRY_RUN=1` still set in the environment, trigger the Routine manually. Read the run log — it should plan actions and print `[dry-run]` lines where it would otherwise write. If the plan looks off, tune the prompt (the repo file, not the Routine form — the form just points at the file).
- **Flip to live.** In the cloud environment editor, delete `KINETIX_AGENT_DRY_RUN` (or set it to `0`), then trigger once manually. Then check the app's pending-edit/review views, or inspect the database from your own trusted admin workstation (not from the Routine environment):

```sql
SELECT id, edit_type, parameter, status, submitted_at
FROM pending_edits
WHERE submitted_by = (SELECT id FROM users WHERE username='kinetix-agent')
ORDER BY submitted_at DESC LIMIT 5;

SELECT target_type, target_id, parameter, verified_at, outcome, concordance
FROM verification_log ORDER BY verified_at DESC LIMIT 5;
```

- **Review it.** Open the Kinetix app and review/approve/reject the pending edit(s) as you would any contributor's.
- **Let the schedule take over.** After one good live cycle, do nothing. The Routine fires on the schedule.

## 4. Kill switch / backlog gauge

- **Pause:** at <https://claude.ai/code/routines> open the routine and disable it.
- **Revoke the agent's token:** in Admin → Agents → Tokens, revoke the `kxat_…` token (sets `revoked_at`). The next request fails closed immediately — no global secret rotation needed. Issue a fresh token with `npm run seed:agent-token` and update `KINETIX_TOKEN` when you're ready to resume.
- **Suspend the agent entirely:** transition the agent to `suspended` (Admin → Agents), which demotes the backing user below the contributor tier _and_ makes every one of its tokens fail the `agentStatus === 'active'` check in `getUserFromRequest`. To fully retire it, deactivate the agent.
- **Backlog warning:** if the app or a trusted admin workstation shows more than ~50 pending edits from `kinetix-agent`, pause the Routine until reviewers catch up.

## 5. Changing the prompt

Because the runner clones from the default branch at each run, any edit to `agents/drug-db-maintainer.md` that lands on `main` takes effect on the next cycle — no re-deploy needed. Treat the Routine form as a thin pointer; the prompt file is the source of truth.

## 6. Second Routine — the paper fact extractor

`agents/paper-fact-extractor.md` drains the editor-filled fact-extraction queue: it claims one uploaded paper per run, reads it in full, and files its facts as `wiki_fact` pending edits on the monographs and wiki pages they belong to and its drug parameter values as `param_entry` pending edits on the parameters they belong to.

It is a **separate Routine on the same environment**, not a sixth action inside the maintainer cycle. The two have different clocks: the maintainer walks a backlog that is always there, while the extraction queue is editor-driven and bursty — a reading list someone deliberately handed the agent, which should drain promptly rather than wait behind an unrelated parameter verification. Folding it in would also mean one run does two full-text reads, and the paper read is the expensive part of both.

Create it exactly as in §2, reusing the `kinetix-prod` environment (same `KINETIX_TOKEN`, `KINETIX_BASE_URL`, same Poppler preinstall from §1d), with:

| Field       | Value                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **Name**    | `Kinetix paper fact extraction`                                                                                                            |
| **Trigger** | Schedule → `Every 1 hour`                                                                                                                  |
| **Prompt**  | `Read agents/paper-fact-extractor.md end-to-end, then run exactly one job and emit its end-of-run paragraph (§7). Output only that paragraph.` |

An empty queue costs one API call and one log row, so an over-frequent schedule is cheap; tune the cadence to how fast editors are filling it.

Running it under a **distinct agent identity** (its own `kxat_…` token) is optional but preferred: the identity is what the queue records as the claim holder, so a separate one makes it obvious in the queue view which routine is holding a job, and lets you pause extraction without pausing the maintainer.

Same kill switches as §4 — pause the Routine, revoke its token, or suspend the agent — plus a narrower one: an editor can cancel any single job from `/paper-extraction`. Cancelling a job that is mid-extraction guarantees the run's result is never recorded and that no later run claims the paper; the run itself stops at its next per-item claim check, so a fact or value filed in the seconds before cancellation still lands in the review queue for a human to reject.

## 7. Tiered model deployment (cost + integrity)

The full rationale and rollout gates live in
`docs/superpowers/specs/2026-08-24-tiered-agent-cost-architecture.md`. This
section is the operational recipe. The important distinction is no longer just
cheap vs expensive models: T1, T2, T3 and T4 perform **different epistemic
jobs**.

The model is chosen on the **Routine form** (§2), not in the repo. The T1
**producer** identities share `agents/drug-db-maintainer.md`. The T2
**flagship verifier** uses `agents/drug-db-escalation.md`, because it must do
only blind escalation/high-risk verification. T3 uses
`agents/drug-db-adjudication.md`, scheduled only under identities with the T3
adjudicator grant (`agents/adding-a-new-agent.md`); its case feed and panel
write path are live. T4 is a human workflow, not a Routine.

### Four-level decision workflow

- **T1 — routine producer + adversarial peer reviewer.** Mid-tier model at
  `high` effort initially (Sonnet / Terra class). It does the bulk parameter,
  wiki, sweep and peer-verification work. When reviewing another actor's change,
  it should actively try to falsify the entry/edit, including its context,
  scope, schema placement and sources. Author self-verification remains barred.
- **T2 — blind escalation + high-risk verifier.** Flagship model at `high`
  (Opus / Sol class), distinct active identity, pointed at
  `agents/drug-db-escalation.md`. It independently reconstructs the answer from
  the target + raw sources and must **not** see the lower-tier dispute rationale
  or other verdicts before posting its own. A dispute can route the target to
  T2, but should do so through an identifier-only feed
  (`GET /api/agent-escalation-queue`, §"Backend prerequisites" below). The
  `/api/disputes` endpoint remains unsafe for this purpose because it includes
  the argument and would anchor the blind verifier.
- **T3 — rare non-blind adjudication.** Two independent flagship-class
  adjudicator identities, preferably from different model families (current
  prior: Fable-class + Astra-class), at `xhigh`/`max` where supported. T3 sees
  the lower-tier disagreement **only after T2 has recorded its blind verdict**.
  Both panelists get the same complete case file but not each other's result.
  T3 remains `agents.model_tier = 'flagship'`; adjudication authority must be a
  separate workflow role/capability, not a new `superflagship` tier. See
  `agents/drug-db-adjudication.md`.
- **T4 — human resolution.** Used when the two T3 panelists materially disagree,
  decisive evidence is missing/irreconcilable, a schema/policy choice is needed,
  or resolving the case would overrule a human-originated dispute/flag/return/
  rejection.
- **Mechanical work.** Prefer deterministic scripts over any model; a light tier
  (Haiku / Luna) only where a script cannot yet do it.

### Pool size and the capability-aware gate

A calculation-driving parameter needs at least one flagship-tier approval to
auto-apply (see `agents/peer-verification-protocol.md` → "Capability-aware
gate"); a pool with no flagship verifier correctly holds those edits for a
human. A high-risk edit needs the full two-approval quorum and the author cannot
verify its own edit. So the two-identity topology (one producer + one flagship
verifier) can never reach consensus on a high-risk edit: the lone non-author
verifier supplies only one approval.

To let calculation-driving edits reach ordinary consensus you need **at least
three active identities** so an agent-authored edit has two eligible non-author
verifiers, **at least one flagship** — e.g. two producers plus a T2 verifier, or
one producer plus two verifiers. The gate reads the tier from
`agents.model_tier`, set by an admin when provisioning the identity, not from
what the model reports at verdict time. Classify T2/T3 identities `flagship`, T1
producers `mid`, and mechanical/light identities `light`. Unknown/NULL remains
fail-safe untrusted.

A new model name that is not yet recognised by `src/lib/modelTiers.ts` does not
become trusted because its self-reported string sounds strong. Update the
registry and/or explicitly provision the server-owned tier before deployment.

### Escalation chain

The intended chain is:

**T1 dispute/high-risk trigger → T2 blind re-verification → persistent material
disagreement → T3 cross-model adjudication → unresolved or authority-bound case
→ T4 human.**

T1 → T2 deterministic triggers include: editor/admin flag; open peer `dispute`;
reviewer return/rejection history; `weak` concordance; materially conflicting
primary studies; replacement of an established calculation-driving parameter;
`absent` conclusion on a core parameter; citation/identifier inconsistency,
correction or retraction; and paper-review deeper-pass triggers. T1 uncertainty
may additionally escalate but never replaces these server-observable triggers.

T2 → T3 happens only if disagreement **survives** the blind check: e.g. T2
approves while a live T1 dispute remains, T2 finds genuinely competing scope
interpretations, independent flagship verifiers disagree, the same proposition
has looped through at least two correction/return/dispute cycles, or an editor
explicitly requests an adjudication memo.

Missing decisive evidence is not a reason to spend a larger model. Request the
source and `abstain`. T3 cannot reason a missing PDF into existence.

### T3 authority boundary

Do not give every flagship identity `dispute.resolve`. T3 model capability and
workflow authority are separate concerns. A panel records a structured
recommendation; by the owner's governance decision the backend then acts on a
convergent case that rests on **agent-originated** disputes only (overruling or
upholding them, and returning an upheld proposal —
`agents/drug-db-adjudication.md` §1). A human-originated
dispute/flag/return/rejection stays human-controlled.

### Shadow audit (measures the thing that licenses lowering a tier)

Route a random **5–10%** of apparently-routine producer work to T2 as a **full
independent redo**, blind to the producer's conclusion — not a summary check, or
it cannot catch omission / search-miss errors. This estimates the false-negative
escalation rate (producer said "routine", flagship finds a material problem),
which is the number that decides whether the producer tier can drop from `high`
to `medium`. Confirm it with `npm run benchmark:agent-tiers`
(`docs/ops/agent-tier-benchmark.md`) on historical work before changing tiers.

The audit cannot run until the **recent-applied-work sampler** below exists, and
it is the only sanctioned basis for lowering a producer tier — so if the sampler
is never built, the tiering work delivers its integrity benefits but none of its
cost savings. Do not let it drift behind the T3 items.

### Cost measurement (the other half of the tiering case)

Every routine ends with `scripts/kinetix-log-run-usage.ts --workflow <…>`,
which sums the run's tokens from its own transcript (Claude Code or Codex) and
appends one `agent_run_usage` row through `POST /api/agent-run-usage`. The
server snapshots the identity's `agents.model_tier` onto the row, so a run is
attributed to the tier it actually ran at even if the identity is reclassified
later. `npm run benchmark:agent-tiers -- --rate-card <card.json>` then reports
tokens and cost per tier × workflow and cost per accepted edit / per verdict per
identity, next to the accuracy tables — see `docs/ops/agent-tier-benchmark.md`.
A model id the rate card does not list shows as unpriced rather than guessed,
so add each deployed model (including GPT-line models) to the card you use.
The helper reads the invoking session's own transcript when the runner
exposes its id (Claude Code always does). Without one, it refuses to guess
while another transcript on the machine is active, so two local workers
running at once log a failure rather than each other's tokens.
Pause a routine before changing its agent's model tier: a run's tier is read
when its usage is logged at the end, so a run in flight during the change would
be filed under the new tier (issue 1444).
Give each routine its own agent identity: the cost-per-output figures match
outputs to runs by time, so two routines sharing one token can blur each
other's numbers when a usage log fails (see issue 1444).
No environment change is needed: the helper uses the same `KINETIX_TOKEN`.

### Backend prerequisites

The prompts exist as design contracts, but deployment needs the following.
Note which tier each one gates — the first group must land **before** T1/T2
tiering is switched on, not after it (spec rollout step 4).

Before T1/T2 can run as designed:

1. ~~an **identifier-only T2 escalation feed** that routes disputed/high-risk
   targets without leaking lower-tier reasoning~~ — done:
   `GET /api/agent-escalation-queue` (`api/agent-escalation-queue.ts`). Covers
   five of the triggers above from data the schema already records (open
   dispute, editor/admin flag, reviewer return/rejection history, `weak`/
   `absent` concordance, and the identifier-inconsistency half of the citation
   trigger — `citations.work_kind_status = 'conflicted'`, §13.3) and reports
   only `targetType`/`targetId`/`targetVersion`/reason codes — never
   rationale. Does not yet cover materially conflicting primary studies (no
   column separates those from a merely sparse `weak` concordance, which
   already catches them), citation correction or retraction, or paper-review
   deeper-pass triggers: none of those has a schema representation to query
   yet, so they remain future work rather than a query over an existing
   signal. A proposed replacement of a
   calculation-driving parameter is deliberately not a feed trigger either —
   it is already visible in the standard queue's own payload, which
   `agents/drug-db-escalation.md` §1 already tells T2 to prioritise by;
2. ~~a **recent-applied-work sampler** returning immutable applied revisions
   (with payload + references) for an unbiased, self-excluding shadow audit~~
   — done: `GET /api/agent-audit-sample` (`api/agent-audit-sample.ts`,
   issue 1232). Draws a random 5–10% sample of `drug_parameter_revisions`
   rows — the one genuinely append-only "applied work" table — excluding
   whatever the caller produced or has already verified, and labels each item
   `agent_applied` / `human_reviewed` / `direct` so a T2 audit can prioritise
   the class that ships with no human involvement. See
   `agents/drug-db-escalation.md` §2. It supplies the audit's population, not
   the false-negative rate itself — that still needs item 3 below;
3. durable **per-target-version decision history**, so a decision record cannot
   mutate underneath a later audit or appeal.

Before T3 could run — these five are now built
(`docs/plans/2026-09-18-t3-adjudication-backend.md`, *Implementation status*);
item 8 remains a deployment precondition for every T3 Routine:

4. a **T3 case feed** that hydrates the complete appeal only after T2 is final;
5. two independent T3 write slots/results that remain hidden from the other
   panelist until both are final;
6. deterministic comparison of the two outputs and a T4 handoff package;
7. a separate adjudication workflow capability if T3 is ever allowed to take
   an action beyond recommendation;
8. a T3 identity constrained to the same read-only tooling and untrusted-content
   boundary as T2 (`agents/drug-db-adjudication.md` §0). The case file
   deliberately exposes rationales and raw sources to a token-holding routine,
   so that boundary is a deployment precondition.

### Cheaper on every tier: slim the runtime contract

A full cycle currently reads ~50–60k tokens of static instructions every hour on
a fresh clone. Independently of model choice, move deterministic housekeeping
(queue selection, routing, schema conformance, duplicate pre-checks, logging and
T3-output comparison) into scripts the agent *calls* rather than prose it
*re-reads*, and keep the static prefix byte-stable so the server-side prompt
cache can hit within its TTL (verify with `usage.cache_read_input_tokens`). See
the spec §E.
