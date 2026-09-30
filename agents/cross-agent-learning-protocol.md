# Cross-Agent Learning Protocol — the shared lessons ledger

Every scheduled or hook-triggered Kinetix agent learns from reviewer
rejections through **one shared, cumulative lessons ledger**. This document is
the canonical description of that mechanism; agent specs reference it instead
of restating it.

> **Companion protocol:** This ledger captures *what to learn from past
> rejections*. Its sibling, **`agents/peer-verification-protocol.md`**, covers
> *how agents catch each other's bad changes before they ship* — agent-to-agent
> peer review with structured verdicts and rationale. Every contributor agent
> runs both: read the ledger before acting, peer-verify a small batch each
> cycle.

Two properties define the ledger:

1. **It endures.** Lessons survive across cycles and context resets. A
   correction learned ten cycles ago is still in force until it is explicitly
   pruned as obsolete — the watermark stops the same _raw rejection_ from being
   re-processed, but the _lesson_ is carried forward in full every cycle.
2. **It is shared by all agents.** The ledger is keyed only on
   `target_type='rejection_review'` in `verification_log` — never on a
   submitter. It is fed by rejections of **every** agent's submissions and is
   read by **every** agent before it acts. A lesson learned from one agent's
   rejection corrects the behaviour of all of them.

---

## Where it lives

- **Storage:** the `agent_notes` field of the most recent `verification_log`
  row with `target_type='rejection_review'`. That single field holds the entire
  standing ledger as a terse list of corrective rules.
- **Watermark:** the same row's `verified_at`. The scan reads
  `MAX(verified_at)` over `rejection_review` rows to decide which rejections are
  "new" since the ledger was last updated.

No schema change is needed: `agent_notes` is free text and already durable.

---

## Reading the ledger (every agent, before acting)

Run the shared helper and read `priorLedger`:

```
npx tsx scripts/rejection-scan.ts
```

It prints `{ "priorLedger": <string|null>, "rejections": [ … ] }`. Hold
`priorLedger` in working memory and re-read it before formulating any search
query and before drafting any submission, comment, or flag. If a ledger rule
applies to the work you are about to do, follow it.

Read-only agents (the reactive evaluator, the reflink checker) stop here: they
apply the ledger but do not rewrite it.

---

## Updating the ledger (the scheduled maintainer, once per cycle)

The scheduled maintenance cycle is the single writer cadence. Once per cycle it
folds new rejections into the ledger and writes the full result back:

1. **Read** `priorLedger` and `rejections` from `scripts/rejection-scan.ts`.
   `rejections` already spans every agent and only includes rows rejected since
   the watermark.
2. **Map** each new rejection's `rejection_reason` (and free-text
   `rejection_comment`) to a **general** behavioural lesson that holds across
   drugs, parameters, and fact types — never a rule that only fits the rejected
   row:
   - `outdated` → broaden search to the last 5 years; deprioritize pre-2010
     sources unless cited as the regulatory anchor.
   - `not_relevant` → tighten population/route/formulation qualifiers; drop
     pediatric data when the spec implies adult.
   - `factually_incorrect` → require a third independent primary source before
     submitting; re-verify unit conversions and locale decimal markers.
   - `insufficient_sources` → block `concordance=weak` submissions; raise the
     primary-source minimum from 2 to 3.
   - `too_general` → split broad claims into one narrower parameter, population,
     route, or section-specific submission.
   - `too_detailed` → trim over-specific wording to the decision-relevant
     finding; move caveats to notes only when needed.
   - `duplicate` → hard-check existing values for trivial restatements before
     submitting.
   - `out_of_scope` → exclude the cited population/species/dataset from future
     cycles.
   - `spam` / `low_quality` → never submit content sourced solely from a single
     non-regulatory URL.
   - `other` → read the comment in full and derive a one-sentence rule.
3. **Merge** new lessons into `priorLedger`:
   - Keep every prior lesson that is still relevant — this is what makes
     lessons endure.
   - De-duplicate: collapse a new lesson into an existing one rather than
     listing it twice.
   - Supersede: if a new lesson contradicts or refines an old one, replace the
     old wording.
   - Prune: drop a lesson only when it is clearly obsolete (e.g. its
     population was permanently removed from scope).
   - **Cap** the ledger at roughly 200 words / ~12 rules. When over budget,
     drop the least-actionable or oldest-untriggered rules first, never the
     most recent corrections.
4. **Write the FULL merged ledger back** — even when zero new rejections were
   found, re-stamp it so the watermark advances and the ledger stays current:

   ```
   npx tsx scripts/kinetix-log-verification.ts \
     --target-type rejection_review --outcome no_change --sources-count 0 \
     --notes "<full merged ledger>"
   ```

   The `--notes` value is the **entire** ledger, not just this cycle's new
   lessons. Writing only the delta would lose endurance the moment the
   watermark advanced.

Keep each rule terse but concrete. "Be more careful" helps nothing; "require
≥3 primary sources for half-life submissions in opioids" survives a context
reset and corrects every agent that reads it next.

---

## Concurrency note

The scheduled maintainer is the only writer and runs one cycle at a time, so
the read-merge-write is effectively serialized. If a second writer is ever
added, treat the newest `rejection_review` row as authoritative and merge into
it; the additive merge means a lost race at worst defers a brand-new lesson by
one cycle, never erases an established one.
