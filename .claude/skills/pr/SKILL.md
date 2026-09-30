---
name: pr
description: "Use when the user asks to merge all open pull requests, drain the PR queue, clear out open PRs, get every PR merged, or types /pr. Operates on a chosen GitHub repo: marks any draft/not-ready PRs as ready for review, resolves merge conflicts intelligently by reading the codebase and the PR, then merges every open PR until none remain. Runs fully autonomously — never asks the user to choose, confirm, or run commands; infers intent from the codebase (CLAUDE.md, CONTRIBUTING.md, docs) and history. Use this even when the user phrases it loosely like 'just get everything merged' or 'clean up the PRs'."
---

# Merge All Open PRs

Drive a chosen GitHub repo to the end state where **every open PR has been merged**. Mark not-ready PRs ready, resolve conflicts yourself, merge everything. Do not stop on difficulty and do not hand decisions back to the user — every challenge is yours to solve by understanding the code and the PR.

## Environment & tools (read first)

This skill must work in two environments. **Detect which you're in and use the matching toolset** — the logic below is identical either way; only the GitHub-operation commands differ.

- **Local / desktop (the `gh` CLI is available):** use the `gh` commands shown throughout this doc as written.
- **Claude Code on the web (no `gh` CLI):** the `gh` CLI is **not** installed and GitHub API access goes through the **GitHub MCP tools** (`mcp__github__*`). Translate each `gh` step to its MCP equivalent. You already have an authenticated clone of the in-scope repo at the working directory; use ordinary `git` for local conflict work and the MCP tools for everything that talks to GitHub.

Quick `gh` → MCP mapping:

| Purpose | `gh` (local) | GitHub MCP (web) |
|---|---|---|
| Repo merge config / default branch | `gh repo view --json …` | `mcp__github__get_file_contents` for config + repo metadata; default branch from repo info |
| List open PRs | `gh pr list …` | `mcp__github__list_pull_requests` |
| Read one PR / merge state | `gh pr view <n> --json …` | `mcp__github__pull_request_read` |
| Mark ready | `gh pr ready <n>` | `mcp__github__update_pull_request` (set draft=false) |
| Update branch (BEHIND) | `gh pr update-branch <n>` | `mcp__github__update_pull_request_branch` |
| Merge | `gh pr merge <n> --<method> …` | `mcp__github__merge_pull_request` |
| Push a resolved branch | `git push` | `git push` (clone is authenticated) |
| Check status checks | `gh pr view --json statusCheckRollup` | `mcp__github__pull_request_read` / `mcp__github__actions_list` |

Use ToolSearch to load any `mcp__github__*` schema you don't already have before calling it. If a needed GitHub tool isn't in scope for the session, say so rather than guessing — that's the web equivalent of an auth wall.

## Operating principles

- **Autonomy is the point.** Never ask the user which repo, which PR, which merge method, or whether to proceed. Resolve ambiguity from the codebase and repo history. The user's attention is not a fallback.
- **Don't stop midway.** A difficulty is a problem to solve, not a reason to halt. The only acceptable non-merge is a hard *external* constraint you genuinely cannot work around (e.g. you lack admin rights on a protected branch, or push access to a fork that can't be routed around) — and even then you exhaust the workarounds below first, merge everything else, and report the one wall at the end.
- **Resolve, don't paper over.** A conflict resolution must reflect the real intent of *both* sides. Read enough of the codebase to know what the PR was trying to do and what the base changed underneath it. Validate the result (build/tests) before merging — never ship a resolution you only hope compiles.

## Step 0 — Target repo + preconditions

Determine the repo without asking:
1. If the user named one (`owner/repo`), use it. Otherwise use the repo of the current working directory's git remote. On the web, default to the session's in-scope repo.
2. You need a **local clone** to resolve conflicts. If cwd is that repo, use it. Locally, if you were only given `owner/repo` and have no clone, clone it: `gh repo clone owner/repo /tmp/pr-<repo>` and work there.

**Auth precondition.** Locally, require `gh`; if `gh auth status` fails, surface the auth instruction and stop — auth is the one thing you cannot self-serve. On the web, the equivalent stop condition is the GitHub MCP tools not being available/in-scope for the target repo: report it and stop.

Read the repo's merge config and default branch once. Locally:

```bash
gh repo view --json nameWithOwner,defaultBranchRef,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed
```

On the web, get the same facts from the repo metadata / MCP tools. Pick the merge method from what's allowed (prefer squash if available, else merge commit, else rebase). Note the default branch.

If the default branch is red (build/tests broken) before you start, fixing that is part of the job — a broken base makes every conflict resolution unverifiable. Fix it or, if it's genuinely external, note it and proceed.

## Step 1 — Inventory every open PR

Locally:

```bash
gh pr list --state open --limit 300 \
  --json number,title,body,isDraft,mergeable,mergeStateStatus,baseRefName,headRefName,headRepositoryOwner,maintainerCanModify,author,labels,reviewDecision,statusCheckRollup
```

On the web, use `mcp__github__list_pull_requests` (state=open) and `mcp__github__pull_request_read` per PR for the detailed fields.

`mergeable`/`mergeStateStatus` are computed asynchronously by GitHub and are often `UNKNOWN` right after listing. When you need a fresh value for a specific PR, re-fetch it (`gh pr view <n> --json mergeable,mergeStateStatus`, or `mcp__github__pull_request_read`) and poll briefly until it settles.

Read full PR bodies — they reveal stacking, intent, and any author notes that inform conflict resolution.

## Step 2 — Order the queue (stacked PRs first)

Detect **stacked PRs**: a PR whose `baseRefName` equals another open PR's `headRefName` is stacked on top of it. The base PR must merge first. Build the dependency graph and topologically sort so a base PR is always merged before anything stacked on it. (When the base PR merges and its branch is deleted, GitHub auto-retargets the dependent PR to the original base — let it.)

Among independent PRs, order doesn't need to be perfect because Step 3 re-checks mergeability after every merge. A reasonable default: clean/small first to build momentum, conflicting/large later (by then the base has moved and you resolve against the final state once).

If you find a dependency cycle between PRs, break it by merging the one with fewer downstream dependents first and resolving the resulting conflicts normally.

## Step 3 — The merge loop

Process until no open PRs remain. Each pass, pick the next eligible PR (respecting stacking order) and:

### 3a. Make it ready for review
If `isDraft`, mark it ready: `gh pr ready <n>` (web: `mcp__github__update_pull_request` with draft=false).

Drafts are the default state in this repository — workers open every pull request
as one and never mark it ready (see *Opening a pull request* in
[AGENTS.md](../../../AGENTS.md)). Marking them ready here is not an exception to
that: `/pr` is maintainer-invoked, so running it **is** the maintainer making the
call, in bulk.

**Then defer this PR to a later pass — do not carry on to 3b with it now.**
Some repositories skip expensive suites while a pull request is a draft, so the
`ready_for_review` you just caused is the *first* time those suites run. They
need time to register and finish, and the status you would read right now shows
either nothing (not yet registered, looks clean) or the draft's own `skipped`
runs (concluded, also looks clean). Both read as green and neither means the
code was tested.

Waiting in place for that is what you must not do — a check that has already
concluded will never change, so an in-place wait can hang the whole queue. Put
the PR back in the queue instead and pick up the next one; the loop already
revisits everything in 3f. On the later pass it is no longer a draft, so this
step is skipped entirely and it goes through 3b like any other PR, where the
rule below does the real work.

**The rule that protects the merge lives in 3b, not here: the owed-check gate,
which applies before every merge in every state — including `CLEAN`, which a
head with no registered checks also reports.** That is what makes deferring
safe, and it needs no knowledge of which run came from where.

If every remaining PR is deferred, pause a minute before the next pass rather
than spinning through them. Keep deferring for as long as an owed check is
absent or still running — these suites legitimately take minutes (`unit-tests`
allows 25, `migrations` 15), so a pass count is not a deadline. Give up only
when a check exceeds its own workflow's `timeout-minutes` plus a margin without
concluding: that one is stuck, so leave the PR unmerged, record it for the final
report, and move on. Never merge it to break the cycle.

### 3b. Read the live merge state
Re-fetch `mergeStateStatus` and act on it:

- **CLEAN** → merge it (3d) — *after* the owed-check gate below, which `CLEAN` does not imply.
- **UNSTABLE** → non-required checks are failing or pending but branch protection does not block the merge. **Never merge through a *failing* one**, whatever its name — inspect every failed check and route it through 3e.2 (fix the PR, push, let it re-run). Non-required is not advisory: `gh pr merge` will happily merge known-failing code, and unlike the gate path nothing else is watching. Pending checks outside the owed set do not block: merge (3d).

  **A failed check from the draft period does not clear itself when you mark the PR ready.** The cheap path-filtered workflows (`kinetics-core`, `parity`, `scripts-typecheck`, `server-shared-esm`, `catalog-sync`, `prompt-registry-sync`) run on drafts but list no `types:`, so they default to `[opened, synchronize, reopened]` — `ready_for_review` is *not* among them and does not re-run them. Under draft-by-default a PR accumulates those results across its whole draft life, so a red `kinetics-core` (provenance and scientific-validation gates among them) is still red at the moment you mark it ready, and the readiness suites going green does not redeem it. Only a push re-runs them.
- **BEHIND** → base moved ahead; the branch just needs updating. `gh pr update-branch <n>` (web: `mcp__github__update_pull_request_branch`, or update locally and push), then re-check. If updating introduces conflicts, it becomes DIRTY → 3c.
- **DIRTY** → real merge conflicts → resolve them (3c).
- **BLOCKED** → required reviews or required checks aren't satisfied. See 3e.
- **DRAFT** → you missed 3a; go do it (which defers this PR to a later pass).
- **UNKNOWN** → not computed yet; poll again.

**Owed-check gate — applies before every merge, in every state.**
`mergeStateStatus` describes branch protection, not whether the work was
tested. A head whose readiness suites have not registered yet, or that carries
only the draft's `skipped` run, reports **`CLEAN`** — so this cannot live under
`UNSTABLE`, or it misses the exact case it exists for. Before merging any PR,
in any state:

**Every check the repo owes this PR must have concluded `success` on the
current head.** In **hagelien/kinetix** that is `unit-tests` on every PR, plus
`migrations` where its `paths:` apply. A `skipped` conclusion is *not* a
success — it is what the job writes while the PR is a draft, and the head SHA
does not change when you mark it ready, so a stale `skipped` sits there looking
concluded and the commit reads as green. Requiring `success` rejects it without
your having to work out which run produced it, and it is the same rule
`codex-gate` applies in `REQUIRE_SUCCESS_RE`.

Not satisfied → defer to a later pass, exactly as 3a does, for as long as the
check is absent or still running. Never merge to break a cycle; give up only on
a check that has blown past its workflow's own `timeout-minutes`, and then leave
the PR unmerged and record it for the report.

**Review-finding gate — applies before every merge.**
`mergeStateStatus` reflects branch protection only; it says nothing about
inline review comments, so a PR GitHub calls CLEAN or UNSTABLE can still carry
an open severe finding. Before merging any PR, read its review threads:

```bash
gh pr view <n> --json reviews --jq '.reviews[].body'
gh api repos/:owner/:repo/pulls/<n>/comments --jq '.[] | "\(.path):\(.line) \(.body)"'
```

Route what you find by [docs/REVIEW_POLICY.md](../../../docs/REVIEW_POLICY.md),
following [the steward procedure](../steward/SKILL.md):

- An unresolved **P0** or **P1** — and any finding touching the policy's
  escalation areas, whatever badge it carries — blocks this merge. Fix it,
  push, let checks re-run, then merge. That is intelligent resolution, exactly
  like fixing a failing required check; it is not a reason to stop or to hand
  the decision back.
- **P2** and **P3** do not block. File each as an issue labelled `P2` and
  `review-debt`, linked to the review comment, then merge.

The goal is every PR merged, not every PR merged unread.

### 3c. Resolve merge conflicts (the core skill)
Check out the PR head and merge the current base into it. This is plain `git` and works identically in both environments:

```bash
git fetch origin
git checkout <headRef>        # the PR head branch
git merge origin/<baseRef>    # surfaces the conflicts
```

(Locally `gh pr checkout <n>` is a convenient shortcut that also wires up fork remotes.)

For every conflicted file:
1. **Understand both sides.** `git log`/`git diff` both branches around the hunk. What was the PR changing this code to do? What did the base change and why? Read the surrounding code, not just the conflict markers.
2. **Produce the resolution that honors both intents.** Not "pick a side" unless one side genuinely supersedes the other. For divergent edits to the same logic, integrate them. For a file the base deleted and the PR modified, decide from intent (usually keep the deletion and re-apply the PR's intent elsewhere, or vice versa — reason it out).
3. **Lockfiles / generated files** (package-lock.json, yarn.lock, Cargo.lock, migrations, build output): don't hand-merge line by line. Take one side then regenerate (`npm install`, `cargo build`, etc.) so the file is internally consistent.

After resolving, **validate**: run the repo's build and tests. Find the commands from CLAUDE.md / CONTRIBUTING.md / package.json scripts / Makefile / CI config. If the repo defines a review checklist or "Iron Law"/definition-of-done in CLAUDE.md, apply every gate. Fix anything your merge broke before continuing — a resolution that fails tests is not resolved.

Commit and push the resolution:
- **Own-repo branch** (head is the same repo): `git push`.
- **Fork branch with `maintainerCanModify: true`**: `git push` (gh checkout sets the right remote; on the web add the fork remote explicitly).
- **Fork branch you can't push to** (`maintainerCanModify: false`): don't dead-end. Resolve locally as above, then merge the resolved branch into the base branch locally and push the base. Because the PR's original head commits are now ancestors of the base, GitHub detects them and marks the PR **merged** automatically. This is the escape hatch that keeps fork PRs from blocking the goal.

Re-check mergeStateStatus → should now be CLEAN/UNSTABLE → merge (3d).

### 3d. Merge
```bash
gh pr merge <n> --<method> --delete-branch
```
Web: `mcp__github__merge_pull_request` with the chosen `merge_method`, then delete the branch if allowed. Use the method chosen in Step 0. If the merge reports the branch can't be deleted (shared/protected), skip the delete and proceed.

### 3e. BLOCKED by branch protection
Required reviews/checks are an intentional gate, and **this skill respects them — it does not override branch protection.** Work *within* the gate:
1. If checks are merely *pending*, wait for them, then merge.
2. If a *required* check is failing because of a real problem in the PR, fix the PR (that's the intelligent resolution), push, let checks re-run, merge.
3. If the block is "needs N approvals", a `CODEOWNERS` review, or any other protection rule you can't satisfy by fixing the PR, that is a true external wall: record it for the final report and move on to the remaining PRs. Do **not** force it through with `--admin` or by editing protection settings — leave it for a human to review and merge. Don't let one protected PR stop the rest.

### 3f. Recompute
After each merge the base branch has changed. Re-fetch mergeability for the remaining PRs before picking the next — a PR that was CLEAN may now be BEHIND or DIRTY, and one that was DIRTY may now be CLEAN. Continue the loop.

## Step 4 — Report

When the queue is drained, summarize tightly:
- PRs merged (numbers + how: clean / conflict-resolved / admin / via-base-push for forks).
- For any conflict resolved, one line on the substantive call you made (so a human can audit it).
- Any PR **not** merged and the exact external constraint that blocked it (unsatisfiable branch-protection gate such as required approvals/CODEOWNERS) — left for a human, never forced through.
- Anything you changed on the base branch directly (e.g. fixing a red default branch before starting).

## Guardrails

- Never force-push someone else's branch destructively. When resolving on a head branch, add merge/rebase commits; don't rewrite their history out from under them.
- Never hand-edit a lockfile or generated artifact into an inconsistent state — regenerate it.
- Don't ship a conflict resolution you haven't validated against the repo's build/tests when those exist.
- **Never override branch protection.** No `--admin` merges, no editing protection rules. A PR that can't satisfy its required reviews/checks is left for a human and reported — that's a feature, not a failure.
- Auth failure is the one stop condition: locally a failed `gh auth status`, on the web the GitHub MCP tools being unavailable for the target repo. You can't self-authenticate. Everything else is yours to solve.
