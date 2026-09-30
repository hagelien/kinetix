# Code review policy

Status: in effect from 2026-09-15.

## Purpose

Code review should catch real defects without stalling progress on trivia. So
findings are routed by severity: what can do harm is fixed immediately, the rest
becomes tracked debt that is handled deliberately.

## Main rule

| Severity | Handling |
| --- | --- |
| **P0** | Fixed before anything else in the pull request that raised it. Blocks release. |
| **P1** | Fixed in the pull request that raised it, before merge. |
| **P2** | Not fixed there. Filed as a GitHub issue labelled `P2` and `review-debt`, linked back to the review comment. |
| **P3** | As P2. |

A pull request is never merged with an open P0 or P1 finding. A finding with a
badge we do not recognise is treated as P0 until someone says otherwise.

## Escalation rule

A finding that touches any of the following is treated as **at least P1** and
fixed immediately, whatever lower severity the review assigned it:

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

The rule only raises severity, never lowers it: a P2 or P3 here becomes P1, and
a P0 stays P0.

Rationale: in these areas "less severe" is a judgement that can only be checked
once the damage is done. This kind of risk must not accumulate in a backlog.

## Findings with no severity

Comments from humans, and from tools that do not label their findings, carry no
P badge. Classify them:

- Data loss, a broken build, or anything else that would block a release:
  **P0**.
- Correctness, security, access or data-handling defects: **P1**.
- Cleanup, naming, structure, performance without a measured problem, refactor
  requests: **P2**.
- If there is doubt about whether a human reviewer's request is small enough to
  act on directly, treat it as large: propose, and let the author decide.

## Setup: the two labels must exist first

`P2` and `review-debt` are declared in [`.github/labels.json`](../.github/labels.json)
and applied by the `label-sync` workflow, or by `npm run labels:sync`. Declaring them
there is what makes the vocabulary reviewable; a label made by hand in the GitHub UI
leaves no trace in the repository.

They still have to exist before the first finding is deferred, and it is worth being
exact about why, because the paths behave differently. The **REST issues API** creates
a label that does not exist when it is set on an issue. **GraphQL** does not — its
label mutations take label node IDs, so a missing label cannot be named. **`gh issue
edit --add-label`** does not either: it resolves the name against the repository's
labels and exits with `'<name>' not found`. An **issue template** also does not, and
fails the most quietly of all — a template naming a label that does not exist silently
drops it and the issue is filed unlabelled, which leaves the finding out of the very
backlog this policy requires to be reviewed. `.github/ISSUE_TEMPLATE/review-debt.md`
names both labels, so that template is the path this warning is about.

If either label is missing, run `npm run labels:sync`, which creates it with the colour
and description `.github/labels.json` declares. Creating it by hand instead — in the
GitHub UI, or with a `gh label create` whose colour and description are typed out at the
prompt — makes a label that disagrees with the declaration, and nothing corrects the
drift: the sync workflow runs on pushes that change the definitions, which a hand-made
label does not. Add genuinely new labels to `.github/labels.json` first, then sync.

Anyone filing a deferred finding should confirm the labels are on the issue
afterwards; an unlabelled one is invisible to the milestone review.

## The backlog must be reviewed

The `review-debt` list is not an archive. It is reviewed at every milestone.
Findings that still apply are prioritised into ordinary work; findings that no
longer apply are closed with a reason.

The pattern this exists to prevent: "later" quietly meaning "never", and the
backlog growing into something nobody will read.

## Who does what

Coding agents follow the procedure in
[`.claude/skills/steward/SKILL.md`](../.claude/skills/steward/SKILL.md) and file
the issues themselves. The project lead owns the backlog review and decides
whether a deferred finding is promoted into ordinary work.
