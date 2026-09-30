# Wiring the dependency-security routine

Runtime counterpart to `agents/dependency-security-maintainer.md`. That file is
the prompt; this one is the one-time external config that makes it fire on a
schedule without your laptop in the loop.

```
Dependabot alert / npm advisory ─┐
                                 ▼
        Claude Code Routine (daily) ─▶ fresh clone of the default branch
                                 ▼
        npm run deps:audit ──▶ ranked by fix cost   (no install: lockfile only)
                                 ▼
        npm audit fix --ignore-scripts --package-lock-only  (+ range bumps)
                                 ▼
        npm ci --ignore-scripts → typecheck / lint / test / build
                                 ▼
                    one PR, ready for review ──▶ a human merges
                                 ▼
              GitHub closes the alerts on the default branch
```

The reading half (`scripts/dependency-audit-scan.ts`, `src/lib/dependencyAudit.ts`)
ships with the repo and is unit-tested. The steps below are what lives outside it.

## What this routine deliberately does not get

It is a repository agent, not a Kinetix contributor agent. Do **not** give it
`KINETIX_TOKEN`, `KINETIX_BASE_URL`, `DATABASE_URL`, `JWT_SECRET`, or
`ANTHROPIC_API_KEY` — it never calls the Kinetix API or the database, and the
runner handles model auth itself. Its environment should hold nothing.

There is also no `agents` row and no `users` row to create. Skip
`agents/adding-a-new-agent.md` entirely; that recipe is for contributor agents
that write to the Kinetix API under a `kxat_` token.

## 1. Cloud environment

At <https://claude.ai/settings/environments> → **New environment**, call it
`kinetix-deps`. Leave the variable list **empty**. The only capability it needs
is the repository attachment (step 2), which carries the GitHub access for
reading alerts and opening PRs.

An empty environment is the point: a routine that runs `npm audit fix` on a
schedule and opens PRs should not be able to reach production data if a
dependency it installs turns out to be hostile.

### The exposure an empty environment does not remove

Be clear-eyed about this one, because it is inherent to the job rather than a
gap in the config. This routine exists to pull in versions of third-party
packages that nobody has read yet, and it runs unattended in a workspace holding
the GitHub credential it needs to push a branch. A malicious package therefore
has a target even with no application secrets present.

What the design does about it, in order of how much it actually buys:

1. **Triage executes nothing.** `npm run deps:audit` passes
   `--package-lock-only`, so the whole advisory list is ranked from
   `package-lock.json` with no `node_modules` on disk. The decision about what to
   install is made before anything is installed.
2. **Resolution executes nothing.** The fix step runs
   `npm audit fix --ignore-scripts --package-lock-only` — a new lockfile, still
   no install, no lifecycle hooks.
3. **Verification does execute dependency code, and no flag prevents that.**
   `npm run build` and `npm run test` load the packages; that is what verifying a
   bump means. `npm ci --ignore-scripts` blocks install hooks — the cheapest
   place to hide a payload — but the honest statement is that the residual risk
   is reduced, not eliminated.
4. **A human reviews the diff.** The routine cannot merge, so nothing it produces
   reaches the default branch or a deploy without a person looking.

If that residual risk is not acceptable for your threat model, the lever is
infrastructural, not textual: give the routine a repository attachment that can
push to `claude/deps-security-*` and nothing else, or split verification into a
credential-free sandbox and hand only the diff to the PR step. Do not "solve" it
by loosening the flags in the prompt.

## 2. Create the Routine

At <https://claude.ai/code/routines> → **New routine** (or `/schedule` from a CLI
session):

| Field           | Value                                 |
| --------------- | ------------------------------------- |
| **Name**        | `Kinetix dependency-security cycle`   |
| **Trigger**     | Schedule → `Every day` (see cadence)  |
| **Repository**  | `hagelien/kinetix` (default branch)   |
| **Environment** | `kinetix-deps` (from step 1)          |
| **Prompt**      | see below                             |

```
Read agents/dependency-security-maintainer.md end-to-end, then run exactly one
cycle as it specifies. Emit the end-of-cycle paragraph as your final message,
nothing more.
```

The runner clones the default branch on every fire, so any edit to
`agents/dependency-security-maintainer.md` that lands on `main` takes effect on
the next cycle. The Routine form is a thin pointer; the prompt file is the source
of truth.

### Cadence

Daily is the right default. Advisories land continuously, `npm audit fix` is
cheap, and a cycle with nothing to do costs one short run. Faster is waste — the
advisory database does not move hourly. Slower lets the backlog rebuild, which is
the failure mode this routine exists to prevent.

## 3. First runs

- **Dry the first cycle by hand.** Before scheduling, run the scan locally and
  read it: `npm run deps:audit` (no install needed). You should recognise the packages from
  the Dependabot alert list. If the two disagree wildly, fix that before letting
  a routine act on it.
- **Fire once manually** from the Routine page and read the run log end to end.
  Check the PR it opens: the diff should be `package.json` + `package-lock.json`
  and **nothing else** — not even `DEPENDENCY_AUDIT.md`, whose two registers are
  human-maintained. A diff touching anything else means the prompt drifted — fix
  the prompt, not the PR.
- **Merge that first PR yourself**, then confirm the alerts closed on the
  Security tab. Alerts close when the fix reaches the default branch, not when
  the PR opens.
- **Then let the schedule take over.**

## 4. What stays a human decision

The routine is deliberately incapable of finishing the job alone:

- **It never merges.** Every PR waits for a human, and so does every Dependabot
  PR the routine leaves alone.
- **It never dismisses an alert, and never records one as accepted.** Risk
  acceptance is a person's call, so the accepted-risk register in
  `DEPENDENCY_AUDIT.md` is human-only; the routine reports what it could not fix
  and leaves the table to you.
- **It never takes a semver-major bump** and never runs `npm audit fix --force`.
  Majors surface in the PR body's "Deliberately not fixed" section, which is
  where you pick them up.
- **It never adds an `overrides` pin.** npm declining to propose a version often
  means it falls outside the parent's supported range, and a green test run does
  not prove an unsupported combination is safe. The routine proposes the pin in
  the PR body; you apply it and write the ledger row.
- **It never touches `deploy-production.yml`** or adds an automatic trigger to a
  workflow (`AGENTS.md` → Deployment).

If the "Deliberately not fixed" section stops shrinking across cycles, that is
the signal to schedule a human upgrade session — not to loosen the routine.

## 5. Kill switch

- **Pause the Routine (primary stop):** disable it at
  <https://claude.ai/code/routines>. The agent only acts when the routine fires,
  so pausing stops everything.
- **Nothing to revoke.** With an empty environment there is no token to rotate.
  Repository access follows the routine's repo attachment; removing the
  repository from the routine removes its ability to push.
- **Close its open PR** if a cycle produced something you do not want. Nothing is
  applied until a human merges.

## 6. The CI half

The same scan doubles as a gate you can run anywhere:

```bash
npm run deps:audit:check                          # fail on fixable high+
npm run deps:audit -- --check --min-severity moderate
npm run deps:audit -- --check --strict            # also fail on major/no-auto-fix
```

It fails only on findings with a known, mechanical fix path — the ones with no
excuse for being open. `major` and `no-auto-fix` findings are reported but do not
fail the gate, because a gate a human cannot clear gets disabled.

Deliberately **not** wired into a workflow here: per `AGENTS.md`, an agent must
not add automatic triggers. Adding `npm run deps:audit:check` to a PR workflow is
a reasonable human decision, and this is the command to use.
