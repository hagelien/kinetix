# Verifying a change while CI is down

GitHub Actions is not allocating runners for this repository. Every workflow —
`scripts-typecheck`, `unit-tests`, `server-shared-esm`, `migrations`, the rest
— fails in about four seconds with `runner_id: 0`, no steps and no log, on
every branch and every author. It is a billing matter, not a code one, and no
push from any pull request will clear it.

**Nothing is being checked before merge.** Until Actions is restored, the check
has to happen on a developer's machine, deliberately, before the merge button.

## The command

```bash
npm run verify
```

It works out which workflows your branch's diff would have triggered, runs
their checks, and prints one line per gate.

| Gate | Stands in for | Triggers on |
| --- | --- | --- |
| `typecheck` | the `Typecheck` step in `kinetics-core` / `simulator-mechanics` | every change |
| `typecheck:scripts` | `scripts-typecheck` | that workflow's `paths:` |
| `lint` | nothing — no workflow runs eslint | `src/**` |
| `unit` | `unit-tests`, and with it `server-shared-esm`, `prompt-registry-sync`, `simulator-mechanics`, `kinetics-core` | every change |
| `provenance` | `kinetics-core` | that workflow's `paths:` |
| `derived-registry` | `kinetics-core` (needs `DATABASE_URL`) | that workflow's `paths:` |
| `catalog-drift` | `catalog-drift` — a **weekly report**, not a PR gate | `--all` only |

A full run is about four minutes, most of it the unit suite.

```bash
npm run verify             # the gates this branch's diff would trigger
npm run verify -- --all    # every gate, including the scheduled reports
npm run verify -- --fast   # skip the unit suite (reported, not hidden)
npm run verify -- --list   # print the gates and what triggers them
```

### Why it mirrors the path filters instead of running everything

Because a gate that fires on changes it was never meant to judge is a gate
people learn to ignore, and a check nobody reads is worse than no check. Both
`catalog-drift` and `derived-registry` currently fail on a clean `main` (see
below). Running them on a docs branch would paint every branch red for reasons
that have nothing to do with it, and the real failures would be lost in the
noise.

The diff is taken against the merge base with `main`, and **untracked files
count**: a brand-new file is exactly the sort of change a gate must not miss.

## What a pass does and does not mean

A pass means *someone checked*. It does not mean CI is green:

- It runs on your working tree, not a clean checkout, and against whatever
  `node_modules` you have rather than a fresh `npm ci`.
- It runs when you remember to type it. CI ran on every push.
- CI tested the *merge commit*. This cannot, so two branches that each pass
  alone can still break each other.

Treat every merge during this period as less verified than one from a week ago.

## Gates that cannot run here

`npm run verify` never hides one. A gate whose prerequisites are missing is
printed as **NOT CHECKED** with the reason, counted, and the run ends with a
`PARTIAL:` line naming them. It does not fail the run — a contributor without
`DATABASE_URL` is a normal state, and failing on it would train people to
ignore the output — but it will not read as all-clear either.

Four things it does not attempt at all, listed in its own output so the gap
stays visible: `parity` (Python `formulas` + `openpyxl` and a regenerated
oracle snapshot), `migrations` (needs a real Postgres), the Playwright e2e
suite, and `deploy-production`, which is manual and human-only regardless.

## Recording the result

With no green check on the pull request, the verification is only as good as
its record. Paste the gate summary into a comment on the pull request before
merging, so a reviewer can see what was run and what was not.

## Known pre-existing failures on `main`

Both were found by running `npm run verify -- --all` against a clean checkout
of the default branch on 2026-09-22. Neither is caused by any feature branch,
and both went unnoticed because the workflows that would have caught them stopped
running.

- **`derived-registry`** — `npm run kinetics:registry:check` reports the
  generated artifact stale. Regenerate with `npm run kinetics:registry` and
  commit the result.
- **`catalog-drift`** — the offline catalog fixture is behind the live catalog
  by 138+ drift rows, and 13 live drugs cannot be represented in the fixture at
  all (each needs a PubChem CID as its fixture identity). Refresh with
  `npm run catalog:export` after fixing the 13.

Until those are cleared, expect `--all` to fail on every branch, and do not
read either as a finding against the branch under test.
