---
name: steward
description: How to handle code review findings and drive a pull request to a mergeable state in this repository. Use when acting on review comments from a bot or a human reviewer, deciding whether a finding is fixed now or deferred, or working a pull request towards merge.
---

# Handling review findings

This repository routes review findings by severity. The rationale is in
[docs/REVIEW_POLICY.md](../../../docs/REVIEW_POLICY.md); this file is the procedure.

Review bots stamp each finding with a **P0**, **P1**, **P2** or **P3** badge at
the top of the comment. Read that badge first, then apply the escalation rule
below before acting.

Every badge routes to one of two tracks:

| Badge | Track |
| --- | --- |
| **P0** | Fix now. Release-blocking: it takes priority over every other item on the pull request, including other P1 findings. |
| **P1** | Fix now. |
| **P2** | Defer: file an issue. |
| **P3** | Defer: file an issue, exactly as for P2. |

There is no third track. A finding that carries a badge is never left unhandled
because its badge is unfamiliar — an unrecognised badge is treated as **P0**
until someone confirms otherwise, since the cost of over-reacting to a minor
finding is an hour and the cost of ignoring a severe one is a defect in
production.

## Escalation rule — apply before anything else

Treat a finding as **at least P1** when it touches any of:

- dose, concentration or PK/PD calculation correctness — including units,
  conversion factors and rounding,
- the drug, analytical-method and reference-range catalog, and the provenance
  registry that certifies where a value came from,
- anything that could present an unverified or unattributed value as though it
  were established clinical fact,
- authentication, authorisation, or who may edit or publish a monograph,
- personal or patient-identifiable data,
- audit logging, revision history, or traceability of a change,
- database migrations, data retention or deletion.

The rule only ever raises severity. A P2 or P3 in these areas becomes P1; a
finding already marked P0 stays P0 and keeps its priority over everything else
on the pull request.

"Touches" means the defect the finding describes would itself do harm in one of
those areas: a wrong or unattributed value, a provenance or approval check that
can be bypassed, an unauthorised write, a lost audit record. It does not mean the
code merely lives near them. A P2 about untranslated error text, scan fairness,
query cost, or the wording of a message on a provenance code path stays P2. When
you escalate, name in the thread reply the concrete harm the defect would cause;
if you cannot name one, the finding is not escalated.

A deferred finding in these areas is not technical debt, it is unmanaged risk.
"Less severe" here is a judgement that can only be checked after the damage is
done.

## P0 and P1 findings — fix now

1. Fix it in the pull request that raised it. Do not defer, and do not open an
   issue instead. Take a P0 before anything else on the pull request.
2. Add a regression test that fails without the fix.
3. Run the verification commands below before pushing.
4. Reply on the review thread naming the fixing commit and the regression test,
   then resolve the thread.

Never merge a pull request with an open P0 or P1 finding.

## P2 and P3 findings — file an issue, do not fix here

In this repository P2 and P3 findings from any review bot are **optional
findings**: they never start a push. This overrides any general instruction to
treat every bot finding as a bug report to fix. The escalation rule above is the
only way a P2 or P3 is fixed in the pull request that raised it. None of these
is a reason to fix one here instead of filing it:

- "the code was introduced by this pull request" or "the path is new here";
- "it is small" or "it is quick" (see item 4 for the one narrow ride-along);
- "the gate will not merge otherwise" — it will, see *Ask for a fresh verdict*
  below.

1. Do **not** change code for a P2 or P3 finding in this pull request. It widens
   the diff and delays the review it came from.
2. Open a GitHub issue with labels `P2` and `review-debt`. Both are declared in
   `.github/labels.json` and applied by the `label-sync` workflow, but confirm
   they are on the filed issue: an issue template silently drops a label that
   does not exist in the repository, which would leave the finding out of the
   backlog entirely. To repair a filing that lost one, create the label first
   with `npm run labels:sync` — which applies the declared colour and
   description, where a hand-typed `gh label create` makes one that disagrees
   with `.github/labels.json` and nothing later corrects — and then add it to
   the issue. `gh issue edit --add-label` does **not** create a missing label;
   it exits with `'<name>' not found`, and a GraphQL label mutation cannot name
   one at all (it takes label node IDs). (The REST issues API does create one,
   which is why an agent labelling through REST never has to stop, but do not
   rely on that here: the label is then grey and description-less until the sync
   runs.) Use the template below.
3. Reply on the review thread with the issue's full URL, then resolve the
   thread. The merge gate reads that reply: it accepts a P2 or P3 finding as
   handled only when a reply on its thread links an issue labelled
   `review-debt`. If Codex raises a finding that is already filed, reply with
   the existing issue's URL rather than filing a duplicate.
4. If such a finding is a one-line change in a file the pull request already
   touches, it may ride along in a push that was happening anyway — but still
   file the issue, and leave it open until the fixing pull request merges
   (`Closes #N` in that pull request's body closes it on merge). Closing it at
   push time marks the debt resolved while the fix exists only on a branch: if
   the pull request is then abandoned, the finding is neither fixed nor in the
   backlog.

### Issue template

```
Title: [P2] <the finding's own heading>

**Source:** <link to the review comment>
**Pull request:** <link to the PR>
**Location:** `<path>:<line>`
**Reviewer:** <who raised it>

### Finding

<the reviewer's text, quoted verbatim>

### Why this was deferred

<one line: why it is not P1 under docs/REVIEW_POLICY.md, including that it does not
touch the escalation areas>
```

## Ask for a fresh verdict before the gate can merge

`.github/workflows/codex-gate.yml` merges only on a sign-off from the Codex
reviewer against the **current head**: a formal approval, a comment its
`CLEAN_RE` matches, or a 👍 reaction. A `CHANGES_REQUESTED` review on the
current head keeps blocking until a newer verdict supersedes it.

Replying on a review thread and resolving it is none of those, and a review
comment raises no event the gate listens for. So after handling a finding, ask
for a new verdict explicitly:

- After a **fix**, the push is enough — `synchronize` wakes the gate and starts
  a fresh review of the new head. (Only on a draft, which workers never open,
  would you need to comment `@codex review` as well.)
- After a **deferral**, nothing changed on the branch. Do **not** comment
  `@codex review`: the reviewer has no memory of the deferral and re-raises the
  same findings on the same head. Instead, once every P2/P3 finding on the
  current head has its issue and its reply, add the `findings-deferred` label to
  the pull request. That wakes the gate, which checks for itself that every
  Codex finding on the head carries a P2 or P3 badge and a reply linking a
  `review-debt` issue, and treats that review as a sign-off. One P0, P1 or
  unbadged finding on the head, or one P2/P3 without a filed issue, and it does
  not. The gate removes the label each time it evaluates, so add it again after
  a later round of deferrals.

## Pull requests open ready for review

**Every pull request here opens ready for review, never as a draft** — see
*Opening a pull request* in [AGENTS.md](../../../AGENTS.md). That one choice
starts the Codex review, runs the full CI suite (`unit-tests`, and `migrations`
where its `paths:` apply) on every push, and arms `codex-gate`, which merges on
its own once Codex signs off on the current head and checks are green. No
`@codex review` comment is needed, and you never merge yourself.

**A pull request is finished when CI is green on the current head**, the Codex
review on that head is clean (or its only findings are P2/P3, each filed as
above), and there is no merge conflict. Red or pending CI is work: diagnose and
push a fix, per the drive-to-green rules.

Because every push runs the expensive suites, run the local checklist in
*Opening a pull request* ([AGENTS.md](../../../AGENTS.md)) **before** pushing. A
branch touching any path in `.github/workflows/migrations.yml`'s `paths:` list —
a wider set than the name suggests — owes **three extra commands** beyond
typecheck/lint/vitest. None of them is reachable from the base three:
`npm run typecheck` excludes `scripts/` and `tests/`, and `npx vitest run`
excludes `tests/integration/**` and `tests/governance/**`.

Never convert a pull request to draft, and never push an empty commit or
relabel one to re-trigger CI or review.

## Findings with no severity badge

Human reviewers and some tools do not label findings. Classify them:

- Data loss, a broken build, or anything that would block a release → **P0**.
- Correctness, security, access or data-handling bug → **P1**.
- Cleanup, naming, structure, unmeasured performance, refactor requests → **P2**.
- Large or open-ended requests from a human reviewer on a pull request you did
  not open → neither. Reply with a proposal and let the author decide. If you
  cannot tell whether such a request is small, treat it as large.

## Before every push

- `npm run typecheck`
- `npm run lint`
- `npx vitest run`

All of the above must pass locally. One validated push is worth more than three
speculative ones.
