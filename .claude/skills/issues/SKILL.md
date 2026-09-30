---
name: issues
description: Use when the user asks to work through GitHub issues, drain the issue backlog, implement open issues, or types /issues. Fetches the repo's open issues, builds a dependency-aware priority queue (foundational + important first, dependents after their prerequisites), and implements them — bundling small related issues into shared PRs when it reduces review overhead without entangling concerns.
---

# GitHub Issue Implementation

Autonomously plan and execute against the current repo's GitHub issue backlog.

## Step 1 — Inventory

Require `gh` (GitHub CLI). If `gh auth status` fails, stop and surface the auth instruction; do not proceed.

```bash
gh issue list --state open --limit 200 \
  --json number,title,body,labels,assignees,milestone,reactionGroups,createdAt,updatedAt
```

Read full bodies — dependency hints live in prose, not just labels. Skip issues already assigned to a human unless the user explicitly says to take them over.

## Step 2 — Dependency graph

For every issue, extract edges from:

- Explicit prose: `depends on #N`, `blocked by #N`, `requires #N`, `after #N`, `needs #N first`
- Inverse phrasing on the prerequisite: `blocks #N`, `unblocks #N`
- Labels: `blocked`, `blocked-by:N`, `epic`, `subtask`, `needs:#N`
- Task-list checkboxes referencing other issues
- Milestone co-membership (weak signal — same milestone often = same epic)

Build a DAG. If you find a cycle, flag both nodes and exclude them from the auto-queue — surface to the user.

## Step 3 — Rank

For each issue with zero unmet dependencies (eligible set), score on:

1. **Fundamentality** — does it touch shared abstractions? Heuristics: edits to schema/types, build/CI config, auth, top-level routing, or modules imported by ≥5 others. Foundational work first because later issues are often easier (or moot) once it lands.
2. **Importance** — labels (`security` > `bug` > `enhancement` > `docs` is a reasonable default, but follow repo conventions if different); reaction count (👍/❤️/🚀); age of unresolved bugs (long-open bugs = ongoing user pain); milestone urgency.
3. **Tiebreaker** — smaller scope first within the same priority band, to ship momentum.

Issues with unmet dependencies are queued behind their prerequisites in topological order — re-rank within each layer.

Present the ordered queue to the user as a compact table:

| Rank | # | Title | Scope | Depends on | Why |
|------|---|-------|-------|-----------|-----|

Then proceed without asking trivial questions. Pause only if the user has set explicit confirmation expectations or if the top item is genuinely ambiguous.

## Priority labels

Triage priorities are `P0`, `P1`, `P2`, `P3` — the same four bands as
[docs/REVIEW_POLICY.md](../../../docs/REVIEW_POLICY.md), so an issue's priority and a
review finding's severity mean the same thing. Their colours and descriptions are
declared in [.github/labels.json](../../../.github/labels.json) and applied by the
`label-sync` workflow (or `npm run labels:sync`).

**A missing label does not block triage through the REST issues API.** Setting `labels`
when creating or updating an issue through REST creates any label that does not exist
yet, so there is no separate "create the label first" step and no need for a
label-creation tool. It was verified in this repository: `review-debt` did not exist
when issue 1243 was filed with it, and the label exists now, grey and description-less —
the signature of an auto-created label, since `.github/labels.json` gives it a colour
and a description that only `label-sync` applies. Carry on labelling; the appearance is
cosmetic until the sync runs.

**Three paths do not create labels, and each fails differently:**

- **GraphQL** label mutations (`addLabelsToLabelable`) take label **node IDs**, so a
  label that does not exist cannot even be named. Create it first.
- **`gh issue edit --add-label`** resolves the name against the repository's label list
  and exits with `'<name>' not found`. Run `npm run labels:sync` — not a hand-typed
  `gh label create`, which invents a colour and a description that disagree with
  `.github/labels.json` — then retry.
- An **issue template** naming a label that does not exist files the issue without it,
  silently — the worst of the three, because nothing reports the loss. That is why
  `docs/REVIEW_POLICY.md` insists `P2` and `review-debt` exist before the first review
  finding is deferred through `.github/ISSUE_TEMPLATE/review-debt.md`.

Declare a genuinely new label in `.github/labels.json` in the same pull request that
starts using it: that keeps the vocabulary reviewable instead of accumulating in the
GitHub UI, and it is what makes all three paths safe.

## Step 4 — Bundle small issues into shared PRs

Bundle when **all** of these hold:

- Every issue is XS/S scope (~≤50 LOC, single area)
- They touch overlapping or adjacent files
- They share a coherent theme (three typos, three lint rules, three doc fixes, three small CSS tweaks)
- None is independently controversial — each could stand on its own in review

Do **not** bundle when:

- Concerns differ (refactor + feature + bug = three PRs, not one)
- Any issue has live disagreement on its thread
- One issue might get reverted — don't entangle it with unrelated work

Bundle naming: `chore: small fixes (issue 12, issue 15, issue 18)` with a one-line theme in the body, then a section per issue.

## Step 5 — Implementation loop

Per issue (or bundle):

1. **Branch** — `issue/<N>-<slug>` or `bundle/<lo>-<hi>-<slug>`
2. **Read first** — view all relevant files before editing. If the repo has a `CLAUDE.md` or `CONTRIBUTING.md`, follow it. If a code-review checklist (Iron Law / gates / definition-of-done) exists in `CLAUDE.md`, apply every gate before opening the PR.
3. **Minimum change that closes the issue.** Resist scope creep — if you find adjacent problems, file a new issue with `gh issue create`, don't fix here.
4. **Tests** — run the existing suite, add coverage for new behavior, don't ship red.
5. **Commit** — conventional commits, reference the issue: `fix(auth): handle null user in middleware (issue 42)`.
6. **PR** — `gh pr create --draft` with body ending in `Closes #N` (or
   `Closes #N, closes #M` for bundles) so merge auto-closes them. **Every pull
   request opens as a draft** — see *Opening a pull request* in
   [AGENTS.md](../../../AGENTS.md). Then, as the immediate next step, post
   `@codex review` on it: a draft raises no review event, so without that
   comment nobody reviews it. Do not mark it ready yourself — that is the
   maintainer's call, and it is what starts the expensive suites and arms the
   merge gate.
7. **Re-rank** — if this PR unblocks dependents or invalidates earlier scoring, recompute the queue before picking the next item.

## Step 6 — Report

End-of-session summary:

- PRs opened (numbers + links)
- Issues closed (auto-closed on merge or pending merge)
- Issues skipped — and why (assigned, ambiguous, controversial, blocked, out of scope for the session)
- Recommended next pickups if the queue isn't drained

## Guardrails

- Never force-push to a shared branch.
- Never mark a pull request ready for review, and never merge one. Workers open
  drafts; the maintainer decides when a branch goes live. A draft that cannot go
  green in CI is expected, not a failure — see *Opening a pull request* in
  [AGENTS.md](../../../AGENTS.md).
- Never close an issue manually — let GitHub close via `Closes #N` on a merged PR.
- If a spec is genuinely ambiguous after reading the code + related issues + recent PRs, comment on the issue asking for clarification rather than guessing.
- Stop and surface to the user before: DB migrations, API breaking changes, dependency major bumps, architectural decisions, or any change that would touch CI/build in a way that could affect other contributors.
- If `main` is red (tests failing, build broken) when you start, fix that first or surface it — don't pile new PRs on a broken base.
- Don't take over issues already assigned to a human contributor unless told to.
