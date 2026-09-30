# Recovering Codex abstentions made on a stale checkout

Internal operator runbook. Not a public runtime instruction; do not add it to the
public instruction allowlist.

## Why this is needed

The September audits ([2026-09-18](fulltext-acquisition-audit-2026-09-18.md),
[2026-09-21](fulltext-worker-activation-audit-2026-09-21.md)) found the scheduled
Codex workers running an old checkout without the full-text acquisition helper.
Some items those runs looked at ended in an `abstain` ("full text not reachable").

- Items the stalled runs never reached are still in the normal queue; nothing to do.
- Items Codex **abstained** on are hidden from its queue for good, because the queue
  skips every target the agent already holds a verdict on. Updating the checkout
  does not change that. Only a revision of the target (which clears its verdicts)
  or a deliberate recovery pass brings them back.

The recovery pass is `GET /api/agent-verifications-queue?revisit=abstained&abstainedBefore=<cutoff>`,
documented for agents in `agents/peer-verification-protocol.md` ("Revisiting your own
earlier abstentions"). Each agent sees only its own abstentions. Abstentions that
came from withdrawing a dispute after reading peers are never served (they are frozen).

## Steps

1. **Confirm the fix is live where the workers run.** In the scheduled checkout:
   `git log -1 --format='%H %cI'` must be at or after the merge of PR 1265, and
   `node scripts/kinetix-fulltext.mjs check` must succeed. Do not run the pass
   before this — it would just re-abstain everything.
2. **Pick the cutoff:** the UTC time the scheduled checkout was brought up to date
   (step 1). Abstentions recorded before it were made with the broken tooling.
3. **Run one extra cycle per Codex worker** (producer and reviewer, each with its own
   profile) with the prompt below. It does not replace or change the scheduled
   prompts, and it may take more than one run to drain.

```text
Run one abstention-recovery pass, not a normal cycle. Run `check` first; stop on any
identity or configuration failure. Then follow "Revisiting your own earlier
abstentions" in agents/peer-verification-protocol.md with abstainedBefore=<CUTOFF>,
using `--profile <producer|reviewer> api GET` for every call. Work at most 5 items.
For each one, start from priorAbstention.rationaleMd, complete
agents/fulltext-acquisition.md, and post approve, dispute, or (only if the full text
is still out of reach, naming the channels tried) abstain. Report how many items were
served, the verdict posted for each, and whether the pull is now empty.
```

4. **Done when** the pull returns no items for each worker. Anything re-abstained
   after the cutoff is a genuine access problem; its PDF request is already in the
   human queue.
