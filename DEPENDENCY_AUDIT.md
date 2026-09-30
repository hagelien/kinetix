# Dependency security

The living record of how Kinetix handles vulnerable dependencies: how they are
found, who fixes them, and — the part no tool can reconstruct — why the ones
still open are still open.

> **History.** Until 2026-08 this file was a one-off audit dated 2026-01-20 that
> described Kinetix as a dependency-free vanilla-JavaScript app and concluded
> "no vulnerable dependencies (none exist)". Every tooling recommendation it made
> (Vitest, ESLint, Prettier, Vite, TypeScript, CI) has since been adopted, and
> the project now carries ~630 resolved packages. The old text was not merely
> stale, it inverted the current risk picture, so it has been replaced rather
> than appended to.

## How vulnerabilities are found

| Source                    | Covers                                                              |
| ------------------------- | ------------------------------------------------------------------- |
| Dependabot alerts         | GitHub's advisory scan of `package-lock.json`; the Security tab list  |
| Dependabot PRs            | Bumps GitHub can propose on its own — direct deps and some transitive |
| `npm run deps:audit`      | The same advisories, ranked by **what the fix costs**                 |

The third is the one that decides anything. An alert says a package is
vulnerable; it does not say whether clearing it is a lockfile bump or a breaking
upgrade, and it does not say whether the vulnerable code ships to a user or only
runs on a build machine. `scripts/dependency-audit-scan.ts` joins `npm audit`,
`package.json`, `package-lock.json`, and the deployed source's import graph
(propagated through the lockfile's dependency tree) to answer both, and sorts by remediation urgency rather than severity alone:
severity, then how mechanical the fix is, then production reach.

It resolves from `package-lock.json` (`--package-lock-only`), so it needs no
`node_modules` and runs in a fresh clone. That is deliberate — the scheduled
routine ranks every advisory before installing anything, so the decision about
what to pull in is made without executing what it might pull in. For the same
reason the scan runs under bare `node` (type-stripping, hence the `>=22.18`
engine floor) rather than `tsx`: a devDependency runner would not exist yet at
the moment triage needs to happen.

One caveat worth carrying: **`no-auto-fix` does not mean "no patch exists".**
npm reports `fixAvailable: false` for any package declared with a non-registry
spec — a git URL, `file:`, `link:` — because it cannot propose a registry
replacement, whether or not the upstream source has a patched tag. The scan
flags those separately as `non-registry spec` so the class is not read as a
dead end.

```bash
npm run deps:audit                                # ranked table
npm run deps:audit -- --json                      # machine-readable triage
npm run deps:audit:check                          # exit 1 on fixable high+
npm run deps:audit -- --check --strict            # also fail on major/no-auto-fix
```

Fix classes, in the order the scan ranks them:

| Class          | Meaning                                     | Who clears it            |
| -------------- | ------------------------------------------- | ------------------------ |
| `in-range`     | `npm audit fix` resolves it; lockfile only  | the scheduled routine    |
| `out-of-range` | one declared range needs a non-major bump   | the scheduled routine    |
| `major`        | only a breaking upgrade fixes it            | a human                  |
| `no-auto-fix`  | npm offers no automatic remediation          | a human (override/accept) |

## Who fixes them

`agents/dependency-security-maintainer.md` runs daily as a Claude Code Routine
(wiring: `agents/dependency-security-setup.md`). Each cycle it reads the alerts
and the audit, fixes the mechanical end of the list, and opens **one** PR ready
for review.

It is bounded on purpose. It never merges, never dismisses an alert, never takes
a semver-major bump, never adds an `overrides` pin, and never runs
`npm audit fix --force`. Anything it cannot clear lands in the PR body's
"Deliberately not fixed" section — as a proposal, not a decision. Its diff is
`package.json` and `package-lock.json` and nothing else; both registers below are
maintained by hand.

## Override ledger

Every entry in `package.json` → `overrides` needs a row here. `package.json`
cannot carry comments, so an override with no recorded rationale is a pin nobody
can safely remove — the version gets carried forward for years because deleting
it feels risky.

| Package   | Pin        | Why                                                                                                             | Drop when                                                            |
| --------- | ---------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `esbuild` | `^0.28.1`  | Pre-dates this ledger. Forces the patched esbuild line across the tree; build tooling resolved older copies transitively. | Every dependent resolves `>=0.28.1` on its own — check with `npm ls esbuild`. |

## Accepted-risk register

Advisories knowingly left open, with the reasoning. An empty table is the healthy
state; a row here is a decision someone made, not a backlog item.

**Human-only.** The routine never writes to this table. An advisory it could not
fix is *unresolved*, and it reports those in its PR body and operator summary —
filing one here would turn an unreviewed vulnerability into an acceptance nobody
granted. The override ledger above is human-only too: the routine never adds an
`overrides` pin, because npm declining to propose a version often means it falls
outside the parent's supported range, and passing this repo's tests does not
establish that an unsupported combination is safe. It proposes; you decide.

| Advisory | Package | Severity | Why accepted | Revisit when |
| -------- | ------- | -------- | ------------ | ------------ |

_(No accepted risks recorded.)_

## Conventions

- **Never weaken a check to quiet an alert** — not the CSP, not auth, not
  validation, not a test or lint rule. If a bump breaks something, fix the break
  or drop the bump; do not lower the gate.
- **`build-only` is context, not an exemption.** A finding marked `build-only`
  still runs on CI and on maintainer machines, so it still gets fixed — just not
  ahead of anything that ships.
- **Reach is not the lockfile `dev` flag.** That flag records how npm *installs*
  a package, not whether a bundler ships it: `lucide-react`, `clsx`, and
  `tailwind-merge` are all `devDependencies` here and all bundled into the
  browser by Vite. So the scan reports `build-only` only when the lockfile scope
  **and** the deployed import graph agree, and reports `unknown` — which ranks
  above `build-only` — whenever it cannot prove otherwise. The DECLARED and REACH
  columns are separate for the same reason: where a package is declared and
  whether its code reaches a user are independent facts.
- **Reach propagates through the dependency graph, and is path-precise.** The
  import scan only establishes roots; the lockfile does the rest, following
  `dependencies`, `optionalDependencies`, and non-optional `peerDependencies`
  (a peer resolves from elsewhere in the tree but is still `require`d at
  runtime). `linkify-it` — one of the currently-open highs — is never imported
  by name anywhere in `src/`; it is reached through `marked`. Matching is on
  lockfile *paths*, not names, because a name can sit at several paths with
  different scoping: this tree already has four such names (`entities`,
  `commander`, `js-tokens`, `whatwg-mimetype`), each with one production copy
  and one dev-only copy. A name-level check would let the safe deployed copy
  vouch for the vulnerable dev-only one.
- **Deployed roots are `src/`, `api/`, `data/`, `db/` — not `scripts/`.**
  `index.html` loads exactly one entry (`/src/main.tsx`) and nothing under `src/`
  references `scripts/`. That directory holds maintenance CLIs and the two
  build-time migration steps in `vercel.json`; it is not a served frontend root.
  Including it would mark `jsdom` and `dotenv` as reaching users. If a new
  frontend entry is ever added outside `src/`, add that entry to `DEPLOYED_ROOTS`.
- **`--check` fails only on mechanical fixes.** `major` and `no-auto-fix` findings
  are reported but do not fail the gate: a gate that a human cannot clear gets
  disabled, and then nothing is gated.
- **Alerts close themselves.** GitHub closes a Dependabot alert when the fix
  reaches the default branch. Never close one by hand to tidy the list, and never
  write `Closes #<n>` for an alert number in a PR — alert numbers and issue
  numbers share a namespace in that syntax and it will close an unrelated issue.

## Related

- `agents/dependency-security-maintainer.md` — the routine's prompt
- `agents/dependency-security-setup.md` — how the routine is wired
- `src/lib/dependencyAudit.ts` — the classification logic (unit-tested)
- `scripts/dependency-audit-scan.ts` — the CLI
