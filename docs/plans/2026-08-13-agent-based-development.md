# Transitioning Kinetix to agent-based development

**Status:** proposal · **Date:** 2026-08-13 · **Scope:** how the repo is developed, not what the app does

## 0. The finding that reframes the question

Kinetix is already developed by agents. Over the last 30 days, 283 of 354 commits (80%)
were authored by Claude, across 5–11 merged PRs per day, and the `Codex gate` workflow
merges them without a human touching the button. The transition being asked about has
substantially already happened.

What has *not* happened is governance. And the striking thing is that this repo already
contains an unusually well-designed agent governance system — it just only applies to
**content**, never to **code**:

| Concern | Content side (the app's database) | Repo side (the code) |
| --- | --- | --- |
| Identity | `users` + `agents` rows, revocable `kxat_` tokens | none — every PR is `hagelien` |
| Authority | capability matrix with `floorTier`, locked capabilities | none |
| Independent review | peer verification, `effectiveConsensusQuorum`, self-review is opt-in per agent | one shell workflow greps a comment for "LGTM" |
| Disagreement | disputes, moderator rulings, `upheldDisputeStands` | PR thread, lost on merge |
| Learning | shared cumulative lessons ledger, endures across context resets | none |
| Kill switch | revoke token / suspend agent, fails closed | disable the workflow |
| Audit | `verification_log`, `agent_status_history`, `agent_hook_runs` | git log |

So the recommendation is not "add agents". It is: **port the governance you already
invented for facts onto the code.**

The target end state, in one line:

> **GitHub is the blackboard and the arbiter. The two models alternate between builder
> and adversary. CI is the physics. The repository constitution is the law, and it cannot
> amend itself. You remain the constitutional owner and the scientific authority.**

---

## 1. Phase 0 — the seam that has to close before autonomy increases

Everything else in this document assumes a policy layer that agents cannot talk their way
past. That layer does not currently exist, and the gap is not theoretical.

**VERIFIED 2026-08-14.** This section opened as a reported claim carrying a warning that
it was unchecked. It has now been checked against the live repository, and every part of
it holds — plus one thing nobody thought to look for.

```
$ gh api repos/hagelien/kinetix/rulesets/15191652
  "rules": [ { "type": "deletion" }, { "type": "non_fast_forward" } ]
  "current_user_can_bypass": "always"

$ gh api repos/hagelien/kinetix/environments/production --jq '.protection_rules'
  []

$ gh api repos/hagelien/kinetix/actions/permissions/workflow
  { "default_workflow_permissions": "write", "can_approve_pull_request_reviews": true }
```

**The `main` ruleset enforces two rules: no deletion, no non-fast-forward.** No required
pull request, no required status checks, no required review. There is nothing for the
`/pr` skill's "branch protection holds the line" reasoning to rest on, and nothing for a
merge gate to be the front door of — `main` is directly writable by anything holding
repository write. That is the seam this document opened with, and it is real.

**The `production` environment has no protection rules at all.** Not weak ones — an empty
array. So `deploy-production.yml`'s `environment: production` is decoration, its lines
15–17 are a comment describing a configuration nobody made, and **any identity with
repository write can `gh workflow run deploy-production.yml` today**, applying pending
migrations to the live Neon database before the app compiles. This is the largest live
exposure in the repository and it is one command wide.

**The default workflow token is `write`.** The eight workflows that declare no
`permissions:` block hold `statuses: write` and `checks: write` today — so the forgery
path is not a future hazard conditional on Stage B. A peer-approved test in
`kinetics-core`, `migrations` or `parity` can publish any check context right now.

**And `can_approve_pull_request_reviews: true`, which no round of review thought to look
for.** GitHub Actions can submit *approving reviews*. Nothing exploits it at present
because no rule requires an approval — but it is armed for the moment one does: a workflow
requesting `pull-requests: write` could approve the very pull request that defines it. It
is the check-publishing forgery applied to reviews, so it must be turned off **before**
required reviews are turned on, not after. Settings → Actions → *Allow GitHub Actions to
create and approve pull requests*.

Composed, in one sentence worth being plain about: **there is currently no technical
control preventing anything with repository write from merging to `main`, deploying to
production, or attesting that either was reviewed.** Everything that has felt like a
control — the gate, the deploy workflow's environment, the `/pr` skill's safety argument —
is convention among cooperating parties. That is a perfectly reasonable place for a
single-maintainer repository to have arrived at. It is not a place to add a second
autonomous writer to.

The order below follows one principle, which earned its place by being violated three
times during review of this document:

> **A control can only be installed behind a control that already exists, and the first
> one must protect itself.** Anything else has a window in which the thing being installed
> is unprotected — and the window is exactly where an agent with write access lives.

Two consequences that are easy to miss and both cost a review round: a permission rule
cannot precede the identities it distinguishes, and `CODEOWNERS` must appear in its own
owner-only patterns or the first PR weakening it needs no owner approval, because at the
base revision no owner pattern covers that file yet.

Three review rounds were spent on this ordering, each finding an instance the previous
prose had not enumerated. So the sequence below is written as literal artifacts and a
literal order rather than as a description — a bootstrap is not the place for prose that
has to be interpreted correctly.

**Stage 0 — quiesce. Reach a state where nothing but the owner can change the repository,
and confirm it. Everything else in the bootstrap assumes this and is worth nothing without
it.**

Three things are running right now, and stopping one does not stop the others:

1. **Pause the scheduled routines.** Until they are paused, agents hold the shared
   `hagelien` credential and can push or merge as the owner *directly* — no gate involved,
   so nothing done to `codex-gate.yml` touches this path. Stage A's premise ("agents have
   no write access") is not true until this happens, which makes it Stage 0 work rather
   than the Stage A step it used to be.
2. **Disable the gate at the repository level, and drain the runs already in flight.**
   Editing the merge step out is not enough: a run that was queued or executing when the
   edit landed carries the *old* script, and the gate's poller can wait minutes before
   calling the merge API — so a peer-signed PR can still merge after Stage 0 has
   "completed". Disable the workflow, then cancel every in-progress and queued run.
3. **Revoke the shared credential** once the routines are quiesced, and verify a call made
   with it fails.

Then confirm the quiesced state rather than assuming it: no enabled scheduled routine, no
gate run in flight, the shared credential rejected. Same discipline as Stage B's negative
tests — the state is reached when something that should now fail visibly does.

This is what every ordering finding in this document eventually reduced to. New gates get
built in Stage B, agents held write from the end of Stage A, and in between the *old*
paths kept running with none of the new controls installed. Two rounds were spent moving
individual controls earlier — the closure check, then the R3 classifier — which fixed
those two and left the next to be found the same way. Closing the window is the fix; the
occupants were never the problem.

The corollary reads backwards until you have been bitten by it: **during a security
bootstrap the safe state is "nothing moves without the owner", not "the existing
automation keeps running while its replacement is built".** It is a real slowdown for the
duration, and it is the only arrangement in which installing a control cannot be overtaken
by the mechanism it replaces.

**Stage A — the owner acts alone. Agents have no write access during this stage.**

1. **Land `.github/CODEOWNERS` yourself, in a single owner-authored commit.** Self-ownership
   protects every *later* edit but cannot protect the commit that creates the file: code-owner
   rules are evaluated against the **base** revision, where neither the file nor its
   self-pattern exists yet. If agents hold write at this moment, the initial patterns can be
   installed incomplete through ordinary peer review — the one PR that defines the boundary
   being the one PR the boundary does not cover.

   ```
   # Every pattern here is owner-only. The first line is why the rest survive.
   /.github/CODEOWNERS   @hagelien
   /.github/             @hagelien
   /agents/              @hagelien
   /.claude/             @hagelien
   **/AGENTS.md          @hagelien
   **/CLAUDE.md          @hagelien
   /src/lib/permissions.ts        @hagelien
   /api/_lib/permissions-store.ts @hagelien
   /vercel.json                   @hagelien
   /package.json                  @hagelien
   /vite.config.ts                @hagelien
   /drizzle/                      @hagelien
   /package-lock.json             @hagelien
   /vitest.config.ts              @hagelien
   /src/test/setup.ts             @hagelien
   /tests/drizzle-migration-statements.test.ts @hagelien
   /scripts/assert-vercel-project.mjs          @hagelien
   /scripts/apply-migrations-build.ts     @hagelien
   /scripts/fix-monograph-links-build.ts  @hagelien
   /scripts/backfill-farmakologiportalen-links.ts @hagelien
   /scripts/export-components.ts          @hagelien
   /postcss.config.js             @hagelien
   /tailwind.config.js            @hagelien

   # Files that do not exist yet, and are owned pre-emptively. Creating one is
   # then an owner decision, which is the only moment the check could see it.
   /.npmrc                        @hagelien
   /.yarnrc                       @hagelien
   /.yarnrc.yml                   @hagelien
   /.pnpmfile.cjs                 @hagelien
   /.husky/                       @hagelien
   /.github/actions/              @hagelien

   # …plus the transitive import closure of the scripts above,
   # which is COMPUTED, not hand-listed — see below.
   ```

   **Own the convention-named files before they exist.** A derivation that walks *outward
   from roots* structurally cannot see a file that joins the closure by **being created** —
   one that no root references, but that a tool reads by convention the moment it appears.
   `.npmrc` is the live example: `npm ci` runs install scripts (four packages in the
   current lockfile declare them), and a project `.npmrc` setting
   `script-shell=./some-agent-owned-file` redirects those scripts to that file, which then
   executes in the credentialed job **before** the protected migration and build inputs run
   and can rewrite them in the checkout. There is no `.npmrc` in this repository today,
   which is exactly the problem: it is not in the closure, not an invoked file and not a
   manifest, so nothing looks at it, and the check stays green through the PR that adds it.

   `CODEOWNERS` patterns match paths that do not exist yet, so this costs nothing:
   creating any of these needs owner review, which is the one moment the decision is
   visible. The same mechanism covers `.github/actions/` and retires the
   local-composite-action hazard from two rounds earlier — the traversal rule still matters
   for actions that exist, but the file cannot appear unreviewed.

   **Owning a convention file is one third of the treatment, and the other two are the ones
   that keep being forgotten.** Every root in this design needs three things, and a new
   kind of root needs all three:

   1. **owned**, so it cannot be edited without the owner;
   2. **a traversal root**, so the walk continues *through* it rather than stopping at it;
   3. **parsed**, so the files it *names* become roots as well.

   **And a fourth, which removes the need for the first three wherever it can be applied:
   pin the path at the invocation.** Owning `/vite.config.ts` does not own the *slot* — Vite
   resolves `vite.config` across `.js`, `.mjs`, `.ts`, `.cjs`, `.mts` and `.cts`, so an agent
   adding `vite.config.js` can be resolved *ahead of* the owned file while touching no owner
   pattern and being named by no root. Every convention-loaded family has the same shape:
   a resolver trying a list, and ownership attached to one entry on it. Pre-owning all six
   works, and has to be repeated for PostCSS, Tailwind, and each family added later.

   Invoking `vite build --config vite.config.ts` instead collapses the whole category:
   the file becomes an explicitly *named* edge the derivation can see, and no alternative
   filename can displace it, because nothing is resolving any more. **Prefer pinning; fall
   back to pre-owning every variant only where a tool offers no way to name its config.**
   Convention resolution is the hazard — a path chosen by a search the checker does not run
   — and naming the file is what turns it back into an ordinary edge.

   Skipping (3) is the same "protect the entry point, not the closure" error this document
   has now made three times at three different layers. Concretely: an owner-approved
   `.npmrc` containing `script-shell=./tools/npm-shell.sh` leaves that shell peer-editable
   — it touches no owned path, and nothing parses `.npmrc` to learn it matters — while it
   executes during `npm ci` in the credentialed job. And two convention files are already
   here and were missed by the outward walk for the same reason: `postcss.config.js` and
   `tailwind.config.js` are loaded and executed by the production Vite/PostCSS build,
   named by no workflow step and imported from no protected root, and `tailwind.config.js`
   carries its own `require()`. Both are now owned, both are roots, and the parse rule
   follows their edges.

   **Protect the closure, not the entry point.** `/vercel.json` names the `buildCommand`,
   but the command *executes* `apply-migrations-build.ts` and
   `fix-monograph-links-build.ts` — so leaving those unprotected means a peer-approved
   edit to either runs arbitrary code against the live `DATABASE_URL` on the next
   human-approved deploy, with the workflow and the command both unchanged and the risk
   table cheerfully filing it as R2. The same goes for the dispatchable production
   workflows below: what decides whether a run reads or writes is the *script*, and
   `--check` is one peer-approved character away from `--apply`. The rule, since this is
   the third boundary in three rounds to have been drawn one level too shallow:

   > **The protected boundary is the transitive closure of everything that executes with
   > production credentials** — the workflow, the config naming the command, and every
   > script the command reaches. Protecting an entry point while leaving what it invokes
   > peer-approvable protects nothing.

   **The closure is enumerable — but only once you separate *executed* from *bundled*.**
   An earlier revision of this section claimed it reached `src/`, `db/` and `api/` and was
   therefore approximately the whole repository. That was wrong, and wrong in the
   expensive direction: taken literally it would have made routine application changes
   owner-approved, recreating the repository-wide review queue this design exists to
   avoid. `vite.config.ts` imports only `vite`, the React plugin and `path`; its aliases
   let Vite *resolve* application modules for transformation. Bundling code is not
   executing it with `DATABASE_URL`.

   **The entry points are few and can be named. The closure cannot, and must be computed.**
   Two attempts to write it out by hand failed here in opposite directions within two
   rounds — first sweeping in all of `src/`, `db/` and `api/` on a false claim that Vite
   executes what it bundles, then listing only *direct* imports and calling that a
   closure. It is not: `api/_lib/catalogExportStore.ts` pulls in `api/_lib/db.ts` and
   `db/schema.ts`; `src/lib/catalogExport.ts` pulls in `src/lib/metabolism.ts`,
   `src/types/index.ts` and `data/components.ts`; `scripts/farmakologiportalen/match.ts`
   pulls in `src/lib/metabolism.ts` and `./parse`. Each of those has imports of its own.

   A hand-maintained list of a transitive closure is not a control — it is a snapshot that
   is wrong the first time anybody adds an import, and nothing announces when that happens.
   So name the **entry points**, and let CI compute the rest:

   | Entry point | Why it is one |
   | --- | --- |
   | `vercel.json` → `package.json` `build` → `vite.config.ts` | the build command chain, run with the deploy's environment |
   | `scripts/apply-migrations-build.ts` | executed by the build, holds `DATABASE_URL` |
   | `scripts/fix-monograph-links-build.ts` | same |
   | `scripts/backfill-farmakologiportalen-links.ts` | dispatchable production writer |
   | `scripts/export-components.ts` | dispatchable, holds the credential |
   | `drizzle/*.sql` | not code that imports, but data the build executes against production |
   | `package-lock.json` | selects the dependency code the build runs; a swapped transitive dep never touches `package.json` |
   | `tests/drizzle-migration-statements.test.ts` + `vitest.config.ts` | `deploy-production.yml` *executes* this test in the credentialed job |
   | `scripts/assert-vercel-project.mjs` | runs **after** `vercel pull`, with production config on disk and `VERCEL_TOKEN` in the environment |

   **Import traversal alone would find none of the last three**, which is the category that
   makes hand-seeding unsafe too. The credentialed job runs `npm ci`, a vitest invocation,
   and a `node` script as *workflow steps* — nothing imports them, so a traversal seeded
   from the build command walks straight past. And a lockfile is code selection: an agent
   can replace the dependency Vite or the migration runner actually executes without
   modifying the protected `package.json` at all.

   So the roots are **derived from the workflows, not hand-picked**: for every job holding
   a production secret or environment, take each `run:` step's invoked files as roots,
   plus the dependency manifests. That keeps the check correct when a step is added, which
   is exactly how this category was missed in the first place.

   **Recurse into repository-local `uses:` as well as `run:` — and fail closed on anything
   the checker does not understand.** A job can invoke a local action
   (`uses: ./.github/actions/…`) that no `run:` step names, so its metadata and everything
   that metadata reaches would sit outside the roots while executing with production
   credentials. There are none in this repository today (no `.github/actions`, no local
   `uses:`), which is why it belongs in the rule rather than in a list: the gap opens when
   an owner-approved workflow first introduces one, and from then on the implementation is
   peer-editable with the check still green.

   Local actions come in three kinds and they reach code by three different edges —
   composite via nested `steps` (`run:` and further `uses:`), JavaScript via
   `runs.main`/`pre`/`post`, Docker via `runs.image` and its Dockerfile. None of those are
   import edges, so all three need parsing. Two rounds here were spent adding one kind at
   a time, which is the argument for stating the property instead of the taxonomy:

   > **Every path by which a credentialed job can reach executable code is a root, whatever
   > the mechanism. A checker that meets a mechanism it does not understand must fail the
   > build, not skip the file.**

   **A third kind of edge, and the one live in this repository today: configuration that
   names files as strings.** `deploy-production.yml` runs
   `npx vitest run tests/drizzle-migration-statements.test.ts` inside the credentialed job,
   and `vitest.config.ts` carries `setupFiles: ['./src/test/setup.ts']`. That file is
   reached by no import and no workflow step — it is a string in a config value — yet it
   executes with production credentials on **every human-approved deployment**, before
   `vercel build` runs the migrations. A peer-approved edit there could rewrite the
   migration runner or the migration files in the moments before they are applied to the
   live database.

   Note what this says about the fail-closed rule above: it protects against unknown
   *variants* of a mechanism the checker is already examining, and does nothing about an
   unknown *category*, because the checker never opens the file to be confused by it.
   Nothing about `vitest.config.ts` announces that a string inside it is an execution edge.
   So the derivation must, for every config file already in the closure, parse its known
   execution-edge fields — `setupFiles`, `globalSetup`, `plugins`, `reporters`, and their
   equivalents in the other tool configs — and fail on a config file whose format it cannot
   parse at all. The categories are enumerable even though the files are not: import,
   workflow step, action metadata, tool configuration.

   Failing closed is what makes the rule survive a mechanism nobody has thought of —
   including one GitHub adds later. It is also the direction this repository already
   chooses elsewhere: an unrecognised `substance_class` normalizes to `drug` and shows too
   many gaps, precisely so a build that has not heard of something is noisy rather than
   quietly permissive.

   The check, in two parts: **derive the roots** by parsing every workflow job that holds a
   production credential and collecting the files its steps invoke plus the dependency
   manifests; then **walk local imports transitively** from those roots and **fail if any
   file in the resulting set lacks an owner-only `CODEOWNERS` pattern.** That turns "did we
   remember?" into a red build, and it is the same anti-drift discipline this repo already
   applies where a copy could silently diverge from its source — the integration test that
   EXPLAINs the exported `CITATION_HAYSTACK` itself rather than a duplicate of it. Run it
   in CI on every PR, because the closure grows by ordinary refactoring: a contributor
   adding one import to `src/lib/catalogExport.ts` extends the production-credentialed
   trust boundary without touching anything that looks like security.

   **The boundary does not stop at the repository — it includes what the job fetches.**
   Everything above governs files under version control. `deploy-production.yml` then runs
   `npm install --global vercel@latest`, so the binary that receives `VERCEL_TOKEN` and
   performs *both* the build and the deploy is chosen at run time from a mutable tag: not
   selected by the protected lockfile, not bound to the reviewed commit, and different on
   two runs of the same SHA. The repository closure can be perfectly owned while changing,
   unreviewed third-party code executes in the credentialed job. Every `uses:` in the repo
   is pinned to a major-version tag (`@v4`, `@v5`) with the same property, and in that job
   `actions/checkout@v4` runs before anything else does.

   > **A mutable reference is unreviewed code entering the credentialed job.** Pin what the
   > job fetches to immutable identifiers — and for an npm tool that means the *tree*, not
   > the package.

   An exact `vercel@x.y.z` is not sufficient, and the reason is worth stating because it is
   easy to stop one step early: `npm install --global` resolves its own dependency tree and
   the root project's lockfile does not constrain it, so a transitive dependency publishing
   a new version still changes what executes on two runs of the same SHA. What locks a tree
   is a lockfile. So **move `vercel` into the project's dev dependencies and run the locked
   binary** — it then falls under `package-lock.json`, which is already in the protected
   closure, and the global install step disappears rather than being hardened. A
   digest-verified artifact is the alternative where a tool cannot be a project dependency.

   For actions, the immutable identifier is a commit SHA rather than a moving `@v4`. But
   pinning the action pins its *implementation*, not what it *fetches* —
   `node-version: '22'` selects whatever Node 22 patch exists at run time, and that runtime
   then executes `npm ci` and the Vercel CLI holding the production token.

   Three review rounds each pinned one layer and left the next one floating: tag → exact
   package → dependency tree → runtime. So enumerate the stack rather than peel it, and be
   explicit about where it stops. For this job:

   | Layer | Today | Pin to |
   | --- | --- | --- |
   | action implementation | `@v4`, `@v5` | commit SHA |
   | tool package | `vercel@latest` | project dev dependency |
   | tool's dependency tree | unconstrained (global install) | `package-lock.json` |
   | language runtime | `node-version: '22'` | exact patch, e.g. `22.18.0` |
   | runner image | `ubuntu-latest` | `ubuntu-24.04` narrows drift; **the label stays mutable** |
   | the image's bundled toolchain | whatever that VM ships | **not pinnable on a hosted runner** |
   | the platform itself | GitHub-hosted | **not pinnable** |

   The bottom two rows are why this terminates rather than recursing forever. Note the
   floor is *both* of them, not just the last: `ubuntu-24.04` is still a GitHub-hosted
   label, so a later run of the same reviewed SHA can land on a refreshed VM with different
   preinstalled system tools, which then executes `npm ci` and the deploy steps. Pinning
   the label narrows the drift and does not remove it, and the honest boundary therefore
   includes the hosted image and everything it ships. Removing *that* means a digest-pinned
   container or a self-hosted runner — a real option, and a much larger commitment than
   anything else in this table.

   **Pin everything you select; name what you cannot pin as the trust boundary instead of
   pretending the stack bottoms out.** A reproducibility claim that does not state its
   floor is not a claim — and a floor stated one row above where it actually sits is the
   same defect in a more convincing costume.

   Treat updating any pinned identifier as the ordinary reviewed change it is.

   Outside credentialed jobs this is a judgement call about maintenance cost against
   supply-chain exposure. Inside one, the argument is the same one that put `package-lock.json`
   in the closure: selecting code *is* choosing what executes with production credentials,
   whether the selection happens in a lockfile or in a tag resolved at run time.

   **`drizzle/*.sql` is R3 regardless**, and not because of any closure argument: a
   migration is a destructive data operation against production, which is R3's own
   definition. The risk table filed it under R2 for eighteen rounds, which was simply an
   error. An agent may author a migration; it does not auto-merge.

   **Taking the credential out of the build is still worth doing**, but it is now an
   improvement rather than a rescue: `apply-migrations-build.ts` runs inside `vercel build`
   holding `DATABASE_URL`, and moving migrations to a separate owner-gated step against a
   pinned artifact would leave the build with no production credential at all. Named as a
   target beyond Phase 0.

   **`deploy-production.yml` is not the only dispatchable path into production.** An
   inventory of `.github/workflows/` finds three workflows holding `DATABASE_URL`, two of
   them `workflow_dispatch`-able, and the only `environment:` gate in the repository is on
   the one workflow that does *not* hold the credential directly:

   | Workflow | Dispatchable | Holds `DATABASE_URL` | Gated |
   | --- | --- | --- | --- |
   | `deploy-production.yml` | yes | no (the Vercel build does) | **yes** |
   | `farmakologiportalen-links.yml` | yes | yes | **no** |
   | `catalog-drift.yml` | yes | yes (read-only today) | **no** |
   | `migrations.yml` | no (PR-triggered) | **no** — its only assignment is `DATABASE_URL: ''` | n/a |

   That last row was wrong in an earlier revision, and the error is worth keeping visible
   because of its *direction*. The inventory was built by counting occurrences of the
   string `DATABASE_URL` rather than reading what each workflow does with it —
   `migrations.yml` sets it to `''` on purpose, as a no-database smoke test asserting the
   runner takes its early exit. Treating that workflow as credentialed would pull `npm ci`,
   the migration typecheck and the whole integration-test dependency graph into the
   owner-gated set: the overbroad closure this section spends several paragraphs rejecting,
   arriving through a sloppy inventory rather than a bad principle.

   **Over-gating is a real failure, not a safe default.** A closure that swallows ordinary
   application code stops agent development without stopping anything else, and the
   pressure to relax it then falls on the whole boundary rather than on the mistake. Read
   what a credential is *used for*; a grep counts strings.

   `farmakologiportalen-links` is the live one: its `dry_run` input defaults to `'true'`,
   and `gh workflow run … -f dry_run=false` runs the backfill against the production
   catalog. Its own header explains it is dispatch-only so that becoming an unattended
   writer "should be a deliberate choice" — reasoning that held while only humans could
   dispatch it. `catalog-drift` only runs `--check` today, which makes it a smaller
   problem and not a different one, since the script deciding that is itself
   peer-approvable. **Inventory every production-writing dispatch and put all of them
   behind the same human gate before granting write access**, and re-run the inventory
   whenever a workflow is added — this is a class, not a list.

   **And bind the approval to a commit.** `environment: production` gates the job *before
   any step runs*, and the checkout then resolves `ref: main` dynamically — so a human
   approves a run, `main` advances while the approval sits there, and a different commit
   ships than the one that was approved. That is the head-binding invariant again, and the
   fact that it applies here means the invariant as written was scoped too narrowly (see
   below). Either resolve the SHA into a `workflow_dispatch` input before the gate, or
   split the workflow so an ungated job resolves the SHA and the gated job consumes it.

   The general form, because this will not be the only one: **Stage A's job is to convert
   every instruction-shaped guarantee into a control.** Anything currently protected by a
   sentence in `AGENTS.md` asking agents not to do it is protected by nothing once agents
   hold their own identities and write access — and the whole argument of this document is
   that an instruction is not a control. Grep `AGENTS.md` for "do not" and "never" before
   Stage B, and treat every hit as a candidate.

2. **Provision per-agent authenticated identities**, still without granting write. Nothing
   below is expressible until they exist: while both agents push as `hagelien`, one account
   cannot simultaneously hold the owner bypass and be restricted to write, and two
   independent risk classifiers cannot be told apart.

3. **Confirm the revocation from Stage 0 still holds, and migrate each routine onto its own
   identity.** The revocation itself is Stage 0 work — Stage A's premise depends on it —
   but the migration lands here, once the identities from step 2 exist. Provisioning a new, lower-privilege
   identity does not invalidate the token, app installation or delegated session through
   which both agents act as `hagelien` today — and an agent holding both will simply keep
   using the old one. It would then continue to appear as the owner, satisfy every
   owner-only boundary, and reach the emergency bypass, while the org chart says it holds
   write. Migrate each routine onto its own identity, revoke the shared credential, and
   confirm a call made with it now fails. The content side already works exactly this way:
   `npm run revoke:agent-tokens`, and a revoked `kxat_` fails closed on the next request.

4. **Convert the deploy guarantee from an instruction into a control.** This is the
   highest-stakes item in the phase and the one this document itself got wrong for
   fifteen rounds — repeating "deployment stays manual and human-only" as though it were a
   settled property. It is not a control today. `deploy-production.yml` is
   `workflow_dispatch`, so any identity with repository write can start it with
   `gh workflow run`; the only things in the way are AGENTS.md line 143 asking agents not
   to ("Do NOT run or auto-trigger the production deploy — it is human-only") and the
   workflow's `environment: production`, whose lines 15–17 are a **comment** telling a
   human to configure Required reviewers in repository settings. Whether anyone did is
   exactly as unverified as the ruleset.

   The blast radius is the largest in the repo: the production build applies pending
   migrations to the live Neon database *before* the app is compiled, so an
   agent-dispatched deploy is an agent-dispatched production migration. Verify — or
   install — Required reviewers on the `production` environment listing **only human
   identities**, **before** granting agent write access, then confirm it by having an agent
   identity attempt a dispatch and watching it hold for approval.

   **Leave self-review enabled**, which reads wrong beside every other rule in this
   document and is right here. The control needed is *the reviewer list excludes agents* —
   an agent dispatching the workflow cannot approve it because it is not on the list, and
   that holds whatever the self-review setting says. Preventing self-review on top would
   only stop the **owner** approving a deploy they dispatched themselves, and with a
   sole owner on the list that is the documented human release path, deadlocked. Add a
   second trusted human first if you want the two-person rule here; until then, "no
   self-approval" is a rule with nobody left to satisfy it. This repo has met the same
   dead end twice already and built an escape hatch both times —
   `agents.self_review_enabled` and `review.edit.decideOwn` — for exactly this shape: a
   deployment with one reviewer, where an unconditional second-pair-of-eyes rule stops
   the work rather than checking it.

   **`deploy-production.yml` is not the only dispatchable path into production.** An
   inventory of `.github/workflows/` finds three workflows holding `DATABASE_URL`, two of
   them `workflow_dispatch`-able, and the only `environment:` gate in the repository is on
   the one workflow that does *not* hold the credential directly:

   | Workflow | Dispatchable | Holds `DATABASE_URL` | Gated |
   | --- | --- | --- | --- |
   | `deploy-production.yml` | yes | no (the Vercel build does) | **yes** |
   | `farmakologiportalen-links.yml` | yes | yes | **no** |
   | `catalog-drift.yml` | yes | yes (read-only today) | **no** |
   | `migrations.yml` | no (PR-triggered) | **no** — its only assignment is `DATABASE_URL: ''` | n/a |

   That last row was wrong in an earlier revision, and the error is worth keeping visible
   because of its *direction*. The inventory was built by counting occurrences of the
   string `DATABASE_URL` rather than reading what each workflow does with it —
   `migrations.yml` sets it to `''` on purpose, as a no-database smoke test asserting the
   runner takes its early exit. Treating that workflow as credentialed would pull `npm ci`,
   the migration typecheck and the whole integration-test dependency graph into the
   owner-gated set: the overbroad closure this section spends several paragraphs rejecting,
   arriving through a sloppy inventory rather than a bad principle.

   **Over-gating is a real failure, not a safe default.** A closure that swallows ordinary
   application code stops agent development without stopping anything else, and the
   pressure to relax it then falls on the whole boundary rather than on the mistake. Read
   what a credential is *used for*; a grep counts strings.

   `farmakologiportalen-links` is the live one: its `dry_run` input defaults to `'true'`,
   and `gh workflow run … -f dry_run=false` runs the backfill against the production
   catalog. Its own header explains it is dispatch-only so that becoming an unattended
   writer "should be a deliberate choice" — reasoning that held while only humans could
   dispatch it. `catalog-drift` only runs `--check` today, which makes it a smaller
   problem and not a different one, since the script deciding that is itself
   peer-approvable. **Inventory every production-writing dispatch and put all of them
   behind the same human gate before granting write access**, and re-run the inventory
   whenever a workflow is added — this is a class, not a list.

   **And bind the approval to a commit.** `environment: production` gates the job *before
   any step runs*, and the checkout then resolves `ref: main` dynamically — so a human
   approves a run, `main` advances while the approval sits there, and a different commit
   ships than the one that was approved. That is the head-binding invariant again, and the
   fact that it applies here means the invariant as written was scoped too narrowly (see
   below). Either resolve the SHA into a `workflow_dispatch` input before the gate, or
   split the workflow so an ungated job resolves the SHA and the gated job consumes it.

   The general form, because this will not be the only one: **Stage A's job is to convert
   every instruction-shaped guarantee into a control.** Anything currently protected by a
   sentence in `AGENTS.md` asking agents not to do it is protected by nothing once agents
   hold their own identities and write access — and the whole argument of this document is
   that an instruction is not a control. Grep `AGENTS.md` for "do not" and "never" before
   Stage B, and treat every hit as a candidate.

5. **Reserve the permissions that no file can protect.** `CODEOWNERS` governs files in a pull
   request; a GitHub ruleset is server-side configuration, so no path rule reaches it — an
   identity holding **admin** rewrites the policy through the API without opening a PR at all.
   Agents therefore get **write at most, never admin**, and ruleset administration stays with
   you. Versioned ruleset config is worth adding on top, but it protects the copy, not the
   setting.

   **Withhold `statuses: write` and `checks: write` in the same breath.** They are separate
   scopes from repository write, an identity provisioned casually may hold them without
   anyone having chosen that, and they are what let a credential satisfy a required check
   by publishing under its context — see the note opening Stage B, which is why this
   matters more than its size suggests.

   **Turn off "Allow GitHub Actions to create and approve pull requests" here as well.**
   It is `true` today (`can_approve_pull_request_reviews`), which means the Actions token
   can submit an *approving review*. Harmless while nothing requires approvals, and armed
   the instant step 8 does: a workflow requesting `pull-requests: write` could approve the
   pull request that defines it. Same forgery as the check-publishing one, aimed at reviews
   instead of checks — so it belongs with the permissions, before the ruleset that gives it
   meaning.

   **And lock the *workflow* token here too, not in Stage B.** Set the repository default
   `GITHUB_TOKEN` permissions to read-only and give every workflow an explicit
   `permissions:` block, granting status/check write to the gate alone. This cannot wait,
   because steps 7 and 8 below make the closure check **required**: if the default still
   carries status writes when agents receive write at the end of this stage, an
   agent-editable test in any of the eight workflows that currently inherit the default can
   publish that context from ordinary CI and walk straight through the check. Prove it
   negatively before continuing — have a non-gate workflow attempt to publish the context
   and fail.

   Setting the default is necessary and **not sufficient**: a workflow-level `permissions:`
   block can request more than the default grants, and a PR editing a `pull_request`
   workflow runs its own YAML before any code-owner approval. The check cannot be *required*
   until its publisher is unreachable from pull-request-defined YAML.

6. **Provision the trusted publisher, bind the required contexts to it, and prove nothing
   else can publish them.** An external App or webhook identity — not Actions, for the
   reason in Stage B fix (3). Two earlier revisions placed this after the check was already
   required, once in Stage B and once as a note inside the permissions step; both left an
   operator requiring a check before the identity that makes it trustworthy existed. The
   **The binding and its test belong with step 8, not here**, because the expected-App
   association *is* part of the required-status-check configuration: until the context is
   required, there is nothing for a source binding to constrain and the test below has no
   observable to check. Provision the identity here; bind the source and prove it in the
   same act that adds the check to the ruleset.

   When you do, test the right property. A PR workflow requesting `checks: write` **can**
   create a check run carrying the required context name — the binding does not reserve the
   name, it makes that run fail to *satisfy* the requirement. So do not test that
   publication fails; it will not. **Have the PR-defined workflow successfully publish the
   look-alike check, then show the pull request is still blocked** because its publisher is
   not the expected App. Testing the wrong half is worse than not testing: an operator who
   watches the look-alike publish successfully may conclude the binding is broken and relax
   the one control that was working.

   This is the fourth ordering error of the same shape in this review, and the pattern
   behind all four is now clear enough to state as a rule: **a required check is the
   load-bearing primitive of this whole design, so anything a required check depends on is
   Stage A by definition** — its publisher, that publisher's identity, and the permissions
   that stop anything else wearing it. Placing any of them later is not a scheduling
   preference, it is a claim that the check works before the thing that makes it mean
   anything exists.

   The general point, since this is the third control this review found scheduled after the
   grant it defends against: **a required check that can be forged is worse than no check.**
   No check is a known absence; a forgeable required check is a false assurance, and every
   dashboard downstream of it reads green.

7. **Compute the closure, protect all of it, and land the failing check — before the write
   grant, not in Stage B.** The named entry points above are Stage A's *starting* set, not
   its finishing one. Deferring the rest of the closure to the R3 classifier leaves a gap
   with a precise shape: the classifier is Stage B machinery, agents hold write from the
   end of Stage A, and the existing Codex gate will merge a peer-signed PR in the
   meantime — so an agent can land a change to an unowned transitive dependency that
   subsequently executes with production credentials, during the exact window opened to
   build the control that would have stopped it. Run the derivation, add every file it
   reports to `CODEOWNERS`, and require the check to be red on an unprotected file before
   anything gets write. R3 classification then covers what the closure check cannot see —
   semantic risk in ordinary files — rather than standing in for it.

8. **Set the ruleset** (this is where checks become *required*, and therefore where the
   source binding and its negative test from step 6 are performed — atomically with adding
   each context): a PR, current-HEAD status checks, required code-owner review,
   no unresolved conversations, and **dismiss stale approvals on push**. No standing bypass for
   any agent identity; keep an emergency owner bypass for yourself.

**Stage B — build the machinery. Agents may now hold write.**

Every step here ships with a **negative test**: a pull request that should be blocked, and
an observation that it *is*. A control is not installed when its code merges, it is
installed when something it should stop has visibly failed to get through. Two rounds of
this review were spent on controls that were required before they could refuse anything —
including a status check that exits green on a PR with no sign-off at all.

**Stage 0 switched things off, and every one of them needs an explicit way back on.** A
quiesce with no un-quiesce finishes with safe identities, correct gates, and nothing
running — the transition "succeeds" into a repository no agent can act in. So each
restart appears below as its own step, ordered behind the control that replaces whatever
was protecting the thing before.

8. **Re-enable the workflow — after landing the no-merge version, before exercising it.**
   Stage 0 disabled `codex-gate.yml` at the repository level, which stops it running at
   all: committing a safe version does not bring it back. Nothing in Stage B can publish a
   verdict, request a re-review, or run its negative tests while it is off. Land the
   no-merge gate first, then re-enable, then test. Note this is not the same act as
   enabling auto-merge in step 14 — one lets the gate *speak*, the other lets GitHub
   *merge*, and conflating them is how the merge came back early.

**A required check is satisfied by a *name*, and that is not enough.** Everything below
routes authority through required checks, so it is worth saying plainly what one asserts:
that *some* publisher wrote a success under that context on this head. If an agent
credential can write commit statuses or check runs, it can publish a green result under
the required context itself — and auto-merge then guarantees nothing except that the
string appeared. The verdict gate, the R3 gate and the closure check all go decorative at
once, while every dashboard reads green.

Three fixes, and the third is the one that actually closes it.

1. **Withhold `statuses: write` / `checks: write` from the agent identities** (Stage A
   step 5). Necessary, and on its own insufficient — see below.
2. **Set the repository's default workflow-token permissions to read-only**, and grant
   narrowly per workflow — **in Stage A, before the write grant** (step 5), for the reason
   given there. Right now **eight of the nine workflows declare no `permissions:` block at
   all** and inherit the repository default; `codex-gate.yml` is the only one that sets its
   own. Several of the eight execute agent-editable code (the test suites in
   `kinetics-core`, `migrations`, `parity`), so if that default includes status writes, a
   peer-approved test can recover the checkout's persisted token and publish the required
   context from inside ordinary CI. Withholding the scope from the long-lived agent
   identities does nothing about that path.
3. **Publish the verdict from something no pull request can influence — installed in
   Stage A (step 6), not here.** This entry stays for the reasoning; the work belongs
   before any check is made required. An earlier revision downgraded it on the reasoning
   that a read-only repository default made the Actions-integration binding adequate. That
   was wrong, and the reason is worth stating exactly: **the repository default is a
   default, not a ceiling.** A workflow-level `permissions:` block can request more, and a
   same-repository PR that edits a `pull_request`-triggered workflow **runs the PR's own
   version of that YAML, before any code-owner approval**. Six workflows here trigger on
   `pull_request`. So an agent can open PR A that adds `checks: write` to a workflow it
   controls, have that run publish the required contexts onto PR B, and merge B through a
   gate that never ran. `CODEOWNERS` over `.github/` stops the workflow edit from *merging*
   — it does nothing about it *running*.

   The publishing credential therefore has to live somewhere PR-defined YAML cannot reach —
   and **that rules out every Actions-based arrangement, including the `workflow_run`
   fallback an earlier revision of this paragraph offered.** A default-branch
   `workflow_run` job does run trusted YAML, but its `GITHUB_TOKEN` publishes as the *same
   `github-actions` integration* as the PR-defined workflow, so an expected-source binding
   cannot tell the two apart and PR A can still publish PR B's context. That fallback
   reintroduced, one paragraph later, the exact conflation this section had just
   identified. The general form is worth stating because it closes the question:

   > **Within GitHub Actions there is exactly one integration identity. No Actions-based
   > scheme can attest to *which* workflow published a check.**

   So the publisher must be outside Actions — a separate App or webhook service with its
   own identity — or the requirement must name the *workflow* rather than the context
   string, via a platform control that identifies the workflow itself. Fixes (1) and (2)
   remain worth doing since they bound what ordinary CI holds, and neither closes this:
   both constrain identities and defaults rather than what a pull request can ask for.

This is the authenticated-authorship rule on its third application, and the pattern is
worth naming because it has now caught three different things: **§3 bound the *author* of a
change to an identity, this section binds the *assertion* about a change, and (3) binds
the *publisher* of that assertion.** Each time the fix was an identity rather than a rule
about content — **an assertion has to be attributable to who made it, or it is a string
anybody can type**, and "attributable" has to mean attributable to something that cannot be
worn by the thing it is meant to constrain.

9. **Compute the verdict in Actions; publish it from the trusted publisher.** Step 6 bound
   the required contexts to an external identity, so a verdict emitted by `codex-gate.yml`
   is authored by the Actions integration and cannot satisfy that binding — leaving only
   two bad options, a verdict that never counts, or a requirement set without the binding,
   which reopens the PR-defined-workflow forgery. Split the two jobs the gate currently
   conflates — but **not** by having Actions hand the service a result to sign. A
   PR-modified `pull_request` workflow can call the same endpoint and submit a green result
   for an arbitrary head, and the App would sign it: that moves the forgery from the Checks
   API to a confused deputy, which is a worse place for it, because the signature now says
   the trusted identity vouched for the claim.

   > **The publisher must not accept a result. It must determine one.**

   So the service independently fetches and evaluates the trusted default-branch run —
   repository, pull request, head SHA and the run's own identity all verified by the service
   against GitHub, not asserted by the caller. If a submitted result is used at all, it must
   arrive as a workflow-bound attestation the service verifies (an OIDC token carrying the
   workflow and ref claims), never as a plain webhook payload. Anything the caller can
   assert, an attacker-controlled caller can assert.

   And it must be a verdict that can fail: Today's `gate` status is not one: both
   the `BLOCKED` and the no-sign-off branches `continue`, and the job exits 0 unless the merge
   API itself errors — so requiring the existing status as a check would admit a merge with no
   sign-off at all. Split the verdict from the merge: publish a check that is **red without a
   non-author sign-off on the current head**, and stop the workflow merging. The gate already
   does the hard part — binding judgement to the evaluated head, handling stale checks.

10. **Make a re-review actually get requested when the head moves — before requiring the
   check, not after.** §3 diagnoses this and Stage B is what makes it fatal: the verdict must
   be bound to the current head, while Codex reviews on *open*, *ready-for-review* and an
   explicit `@codex review` and **not** on `synchronize`. Make the verdict mandatory without
   fixing that and every PR which pushes a requested fix loses its admissible verdict with
   nothing scheduled to replace it — so the ordinary, *successful* review cycle ends
   permanently red, and the only PRs that merge are the ones nobody had to correct. Have the
   gate request the re-review whenever the head moves past the last verdict.

11. **Only once the check exists, demonstrably fails a PR with no sign-off, and demonstrably
   recovers after a fix is pushed, add it to the required list.** Requiring it earlier either
   blocks every PR on a check nothing publishes, or — worse, and the actual hazard — requires
   a status that is green regardless.

12. **Implement the R3 classification gate, and prove it blocks.** Both agents classify
   independently; the PR carries a sticky ceiling; any disagreement or any R3 blocks for
   the owner (§ below). Until this exists, a semantic R3 change — a privacy boundary, a
   scientific-policy reinterpretation, a destructive data operation — sits in an ordinary
   source file that no `CODEOWNERS` pattern reaches, and auto-merges exactly like an R0
   typo. Ship it with a PR that carries an R3 change and no owner approval, and watch it
   fail to merge.

13. **Narrow `/pr` for scheduled use — and during the pilot it does not merge at all.** Keep
   the aggressive version for explicitly requested interactive cleanup. The scheduled
   profile **stops after verifying the gates and reports**; direct merging turns on only
   under an explicit post-pilot control.

   "Merge only gate-approved work" was not enough, because it describes *what* to merge and
   the pilot is a restriction on *whether*. `/pr` merges with a direct `gh pr merge` call,
   which neither requires the auto-merge feature nor counts as queuing one — so §9's promise
   that the owner keeps the merge click for the first ~20 PRs, and step 15's "enable the
   feature and leave it unused", both constrain a channel `/pr` never touches. Its fork
   escape hatch goes further still: merge the resolved branch into the base locally and
   **push the base**, which is not a PR merge at all and works today precisely because the
   ruleset this document is premised on does not require pull requests.

   > **A restraint expressed over one mechanism does not bind another mechanism that
   > achieves the same effect.** Enumerate the ways a change can reach `main` — auto-merge,
   > a direct merge API call, and a push to the base branch — and check each against the
   > restraint, rather than gating the one that happens to be top of mind. This is the same
   > shape as `vercel.json` routing around the deploy gate: the control was real and the
   > path around it was ordinary.

   Draft still means draft, and `UNSTABLE` still does not mean "fine, GitHub permits it".

14. **Resume the scheduled routines** — on their own identities, with the reciprocal review
   triggers live and every gate blocking. This is the step that actually starts the system
   the document describes; without it the bootstrap ends with a well-governed repository
   and no builders or reviewers running in it.

15. **Enable the auto-merge *feature* — last, and note that this does not start it.** Turning
   it on at any earlier point removes the final human friction without having added the
   machine friction meant to replace it. But enabling the repository setting is not the
   same as letting work merge unattended: §9's pilot keeps the merge click with the owner
   for roughly the first 20 agent-created PRs, and **no routine queues an automatic merge
   until that pilot completes**. Stage B ends with the machinery built and proven, not with
   it driving.

### The authority audit

Four separate review rounds found the same shape of defect — an approval that is asserted
but not *bound* — so it is stated here as an invariant rather than patched a fifth time.
This is the class-level audit §2 asks builders to perform, applied to this document:

> **Every claim that permits an irreversible action — a review verdict, an override label,
> an owner approval, a risk classification, a deploy authorization, and anything added
> later — must be complete (covering everything it asserts), ordered (existing before the
> thing it gates), and bound to the commit it was made about. A claim that outlives that
> commit is a standing permission.**

It said "permit a merge" until a deploy approval turned out to have the same defect and
larger consequences — a merge is revertible, a production migration is not. The scope is
the *irreversibility* of what the claim unlocks, not the mechanism that consumes it.

A second invariant sits beside it, and it was learned three times over — the ruleset (not
a file, so `CODEOWNERS` cannot reach it), the deployment marker (not a branch, so the
branch ruleset cannot reach it), and the post-deploy acknowledgements (an ordinary issue
or Release, which every write-holder can edit):

> **State that authorizes, gates, or discharges an obligation must live where the party it
> constrains cannot write it.** Moving state out of one problem's reach always lands it on
> some other surface — and that surface's permissions are then part of the control, whether
> or not anyone designed them to be. Ask of every new store: *who can write this, and are
> they the party it is meant to bind?*

The invariant is the rule; the table is only today's inventory of surfaces subject to it.
Anything added to this design later is covered by the sentence above without needing a new
row — which is the mistake that produced this audit's own fourth instance, since the R3
classification introduced one round earlier was itself left unbound.

| Surface | Complete? | Ordered? | Head-bound? |
| --- | --- | --- | --- |
| Agent peer verdict | yes | needs identities + a Codex runner + the `codex/*` review trigger first | yes — `.commit_id == $head` |
| `merge-when-green` override | human-only | — | **must drop on `synchronize`** or record the approved SHA |
| Code-owner approval | control-plane paths only — see below | **must precede auto-merge** | **needs dismiss-stale-approvals**, or an agent pushes after the owner approves and keeps the approval |
| Required status checks | yes | — | yes, natively |
| Ruleset administration | **not a file — no path rule reaches it** | before everything | n/a — hold it as an owner-only *permission* |
| R3 risk classification | **no — this is the gap, see below** | before auto-merge | **both claims must record the SHA they judged**, or clear on `synchronize` — otherwise an R0 verdict on commit A survives an R3 change in commit B |

**The R3 gap is the one that does not close with a path rule.** `CODEOWNERS` can express
"who owns `.github/workflows/`". It cannot express "this change alters a privacy
boundary", "this reinterprets a scientific policy", or "this is a destructive data
operation" — those live in ordinary source files, so an R3 change of that kind satisfies
the peer verdict and CI and auto-merges exactly like an R0 typo fix. Nothing today
consumes a `risk:` label, and a label an agent applies to its own PR is self-asserted —
the same defect as deriving authorship from a branch prefix.

Three properties make the classification trustworthy without a trusted classifier, and all
three are already patterns in this repo:

- **Both agents classify independently**, as they already do for correctness. The
  builder's class and the reviewer's are separate claims.
- **Disagreement escalates.** If the two differ, or either says R3, the PR blocks for the
  owner. Nobody has to be right — they only have to disagree for the owner to be consulted.
- **Each claim records the head it judged**, and a push clears both *attestations*.
  Otherwise two R0 classifications of commit A silently authorize an R3 change pushed as
  commit B — the invariant above, applied to the surface this section creates.
- **But the PR keeps a sticky ceiling: its highest class so far, which a push never
  lowers.** Clearing the attestations without it hands the agents the de-escalation the
  next bullet reserves for the owner — classify commit A as R3, push a trivial commit B,
  and two fresh R0 claims merge the whole PR with no owner review. The attestations are
  about a commit; the ceiling is about the pull request, and only the owner lowers it.
- **The class is monotone: an agent may only ever raise it, never lower it.** Only the
  owner can de-escalate. This is exactly the ladder discipline `floorTier` already enforces
  in the capability matrix, where no configuration may leave a higher tier holding less
  than a lower one, and it is what stops the classification becoming a self-issued exemption.

Path-expressible R3 surfaces get `CODEOWNERS` as well — belt and braces, since a rule the
platform enforces beats a rule two agents agree to follow.

---

## 2. The operating architecture

For every unit of work, one model builds and the other reviews. Neither has symmetric
authority over the same change.

| Situation | Builder | Reviewer | Final merge |
| --- | --- | --- | --- |
| Claude-created PR | Claude | Codex | deterministic gate |
| Codex-created PR | Codex | Claude | deterministic gate |
| Human-created PR | one assigned | the other | deterministic gate |
| Security / auth / data-integrity | one | the other, strict | gate, sometimes human |
| Scientific / privacy / product policy | one may implement | the other reviews | **owner decides** |
| Strategy proposal | independent Claude assessment | independent Codex assessment | synthesis, never automatic code |

Three rules make this more than an org chart:

- **The reviewer never repairs the PR it is reviewing.** If Codex finds a problem in
  Claude's PR, Claude fixes it and Codex reviews the new head. Same for conflicts: the
  builder resolves, the reviewer reviews the resolution. Without this, reviewer and author
  converge into one entity wearing two hats — which is exactly what
  `agents/peer-verification-protocol.md` already forbids on the content side, and for the
  same reason. Note that the tooling actively invites the violation: Codex offers
  *"@codex address that feedback"* on its own review. Do not use it.

  The cost of this rule is round trips, and it should be paid deliberately. This document
  took six review rounds and seventeen findings; at a scheduled 2–4 h builder pickup that
  is 12–24 hours of wall clock. So **the builder must wake on review-completion events**,
  not only on its schedule. The independence rule is affordable only if the loop is
  event-driven — and worth it: three of those rounds found errors that would have shipped,
  including a proposed fix that was worse than the bug it fixed.

- **After the second round of the same defect class, the builder owes a class-level
  audit** rather than another point fix. This repo's own history keeps teaching it: one
  stale-read path turns out to have three neighbours (issue 1076 is that lesson written down —
  six uncoordinated writers found by fixing one). Whack-a-mole is the default failure mode
  of a fast builder with a good reviewer.

- **The control plane is owner-only, and the constitution cannot amend itself.** An agent
  may *propose* changes to `.github/workflows/`, the branch ruleset, agent permissions, or
  its own instruction files. It must never be able to weaken the rules governing itself
  and have its peer approve that change. This is the one rule whose violation is
  unrecoverable, because it removes the mechanism that would have caught it.

### Risk classes

Not every PR deserves the same governance, and a flat rule is what makes people turn the
whole thing off.

| Risk | Examples | Autonomy |
| --- | --- | --- |
| **R0** | docs, tests, copy, dead code, mechanical refactor | cross-agent review → auto-merge |
| **R1** | ordinary UI, contained features, non-critical API | cross-agent review + CI → auto-merge |
| **R2** | modeling maths, identifiers, auth-adjacent code, reference-data machinery, DB writers **that run behind the app's own review gates** | strict review + expanded tests → auto-merge, last |
| **R3** | scientific interpretation policy, privacy boundaries, destructive data ops (**`drizzle/*.sql` included**), security policy, deploy policy, agent permissions, the constitution, and the enumerated build-execution closure | agents advise and build; **owner decides** |

**Migrations were listed under R2 for eighteen rounds, and that contradicted R3's own
definition.** A migration is a destructive data operation against production, which R3
names explicitly; filing it as auto-mergeable was an error, surfaced by the closure
argument below but standing entirely on its own. Note what R3 does **not** sweep in:
application code that the build *bundles* rather than executes stays R0–R2, or this
becomes the repository-wide review queue §2 exists to avoid.

R3 is not a hedge. Kinetix already contains textbook instances: issue 1059 asks what privacy
guarantee forensic cases should actually carry, and issue 1060 states outright that
reference-atlas curation needs a human owner. Neither is answerable by "which
implementation is cleaner", and an agent that resolves them is not more autonomous, it is
less honest.

---

## 3. Identity — the precondition both plans need

`codex-gate.yml` merges when it finds a sign-off from an author matching `codex` and the
checks are green. It reads `.head.sha`, `.state`, `.draft` and `.labels` from the PR — it
never reads `.user.login`.

Today that is safe, because every PR is authored by `hagelien` and Codex only reviews. It
stops being safe the moment Codex authors, which is what §2 proposes: a Codex PR on which
Codex comments "no issues found" merges on its author's own word. The content side refuses
precisely this (`agent_verification_self_not_allowed`).

**And the cheap fix does not work.** Every PR here is authored by the same account, so
`.user.login` cannot say which model wrote it, and `claude/*` vs `codex/*` are mutable
strings the author picks for itself. Keying the required reviewer off the branch prefix
means an agent is treated as its own peer by writing a different branch name — an
authorship claim controlled by the claimant is not an authorship check.

**So distinct authenticated GitHub identities per agent are a precondition for the entire
architecture above, not a later refinement.** Any rule of the form "do not give the
Claude/Codex identities a standing bypass" presumes those identities exist; they do not.
Until they do, only one agent should author. This is the same conclusion the content side
reached when it stopped accepting bare JWTs from agent-backed users and gave each agent
its own revocable `kxat_` token.

Two more gate defects, both verified in the workflow, both of which the §1 split
(verdict-as-check, GitHub merges) largely dissolves:

- **`merge-when-green` is an unreviewed-merge path, checked first.** `codex_verdict`
  returns `OK|<label>` before reading any review, and the job `if` accepts a `labeled`
  event for it. Anything that can label a PR can merge it with no reviewer. It cannot
  simply be deleted — it is currently the only way out of the stall below — so restrict it
  to an authenticated human and replace its agent-facing use with an explicit stall signal.

  **Restricting it to a human is not sufficient: it must also bind to a head.** `OVERRIDE`
  tests only for the label's *presence*, so a human who labels commit A has, in effect,
  approved commit Z — the author can keep pushing while the label sits there. That is the
  same defect `--match-head-commit` was added to the merge call to prevent, left standing
  one level up. Either drop the label on `synchronize` or record the SHA it was applied to
  and require a match. An override that outlives the commit it was granted for is a
  standing merge permission, not an override.
- **The reviewer can be unavailable, and the gate cannot say so.** This proposal's own PR
  (issue 1078) hit it within a minute: Codex answered `You have reached your Codex usage limits
  for security reviews`, which is neither a sign-off nor a `CHANGES_REQUESTED`, so
  `codex_verdict` returns empty and the gate polls, gives up, and re-polls every two hours
  forever. A quota refusal, an auth failure, or a reviewer silent for N hours is a
  *stalled* queue, not a pending one, and should raise a label or an owner-decision issue.
  An automated merge queue whose only failure mode is silence stops merging without anyone
  noticing it stopped.

- **The review trigger and the freshness rule disagree, and this one fires constantly.**
  The gate admits a verdict only if it is bound to the current head (`.commit_id == $head`,
  or a comment later than the head commit's committer date). Codex reviews on *open*,
  *ready-for-review* and an explicit `@codex review` — **not** on `synchronize`. So pushing
  a fix for review feedback strands the PR: the verdict goes stale and nothing is scheduled
  to replace it. **A PR nobody had to correct merges; a PR the review actually worked on
  gets stuck** — the inverse of the incentive a review gate exists to create, and it fires
  on every PR the process did its job on. issue 1078 demonstrated it four times over. Fix by
  having the gate request the re-review it requires when the head moves past the last
  verdict.

---

## 4. The context tax — `AGENTS.md` is 31k tokens, read by both agents on every run

`AGENTS.md` is 124,886 bytes / 16,935 words. `CLAUDE.md` says "See AGENTS.md"; `AGENTS.md`
is also Codex's native convention. So **both** agents load ~31k tokens before doing
anything — every authoring session, every review, every scheduled cycle — and it is paid
most often by the runs that need it least (a lockfile bump reads the entire
parameter-applicability essay). For a scheduled autonomous process that is too much
constitutional law mixed with historical case law.

The rationale in those rows is genuinely valuable and must not be deleted; it is the record
of why each guard exists and it demonstrably prevents regressions. Split, don't trim:

- `AGENTS.md` → a router of **≤12 KB**: invariants, safety boundaries, conventions,
  commands, anti-patterns, and **one line per subsystem** pointing at its architecture doc.
- Each fat row → `docs/architecture/<subsystem>.md`, full rationale intact.
- Per-directory `AGENTS.md` where it earns its place — `drizzle/`, `scripts/`, `agents/`,
  `src/lib/kinetics-core/` — **each with a paired `CLAUDE.md` shim**. Not decoration: this
  tree redirects Claude through a `CLAUDE.md` stub and `api/CLAUDE.md` exists for exactly
  that. A scoped `AGENTS.md` with no shim is a file Codex finds and Claude may not — so
  once the root is thinned, Claude silently loses the migration rules the split existed to
  surface. Copy the `api/` pattern verbatim; `api/AGENTS.md` (6.8 KB) is also the size model.
- **A CI budget on the root file, in bytes — never lines, and derived from the token
  target.** The unit matters twice over. `AGENTS.md` is 124,886 bytes in **258 lines**
  (longest line: 14,429 chars), so a 400-line cap passes today's file with 142 lines to
  spare and bounds nothing. And the *value* matters as much as the unit: at ~4 bytes/token
  measured on this file, the §9 target of <5k tokens of standing context is ~20 KB total,
  shared between the root file and the scoped file a run also loads — hence ≤12 KB root and
  ≤8 KB scoped. A 40 KB root would pass a byte check while missing the target it serves by
  a factor of two.

  **The check must cover every instruction file, not just the root.** A root-only budget
  leaves the ≤8 KB scoped figure as an informal intention, and the moment a scoped file
  drifts past it CI stays green while every run in that directory carries unbounded
  standing context again — the same regression, relocated. Budget the root and each scoped
  `AGENTS.md`, and fail on either.

The `.claude/skills/` layout already demonstrates the pattern: load the detailed procedure
only when the task calls for it.

---

## 5. Three queues nobody owns

### 5.1 `auto-fix`: 8 open, oldest 13 days, zero comments

The pipeline files but nothing drains. Either the GitHub trigger in
`agents/autofix-setup.md` §4 was never created or it fails silently — find out first.

**Deduplication is not the missing piece.** `api/_lib/autofix-issues.ts` already embeds an
`autofix-fp:<hash>` marker, searches open issues for it, and holds a cooldown. The defect
is what the fingerprint is computed *from*:

- **Runtime:** `fingerprint(['runtime', routeForDisplay, firstLine])` splits one defect
  across many issues — issue 989 titled with a UUID request id, issue 992 with `00000002`, issue 990 with
  a bare `Failed query:`, issue 988 with the query in full, and issue 984/#985 repeating the shape on
  `/api/agent-run-stats`. Normalization *widens* the split rather than closing it, since a
  UUID folds to `UUID` and an 8-digit id to `#` under `\b\d{4,}\b`.

  The mechanism is **not** "the first line of a batch": `toReport` runs per drain entry,
  and when the entry carries a parseable `KINETIX_ERROR` marker it sets `detail` from
  `parsed.message`/`stack`/`cause`, so `firstLine` is the parsed error message. Structured
  errors are therefore already keyed on something reasonable. What the `START RequestId:`
  titles reveal is the *other* class: entries arriving with **no parseable marker**, where
  `detail` falls back to the raw log line — so a Lambda lifecycle line, which is not an
  error at all, is being filed and fingerprinted as one.

  That makes the remedy three things, not one, and *not* "hash the marker record" — the
  raw record carries a per-occurrence `ts` plus volatile stack and cause text, so hashing
  it would split repeats even harder. Instead: **stop filing non-error entries** (a
  lifecycle line should never reach `reportError`); for structured errors hash an
  explicitly chosen signature — route plus normalized `parsed.message`, with `ts`, stack
  and cause excluded rather than incidentally absent; and for genuine unstructured
  platform 500s derive the signature from the normalized message instead of the first 120
  characters of whatever line arrived. Then diagnose the `Failed query:` pair specifically,
  since two spellings of one query suggest the parsed messages really do differ and that is
  worth knowing before choosing the normalization.
- **Build:** `fingerprint(['build', name, shortSha || depId])` includes the commit SHA, so
  every failed build is unique by construction (issue 987, issue 1005). **Do not fix this by dropping
  the SHA** — the deploy webhook carries no failure cause (its own issue body tells the
  agent to fetch the logs), so the hash falls back to `['build', name]`, one fingerprint
  for the whole project, and the first open build issue then silently swallows every later
  unrelated compiler or migration failure. That trades too many issues for exactly one,
  ever. The better frame: **a build failure is a point-in-time event, not a recurring
  error**, so expiry is the tool, not dedupe — keep the per-commit hash and close the issue
  when a later build of the same project goes green.
- **Both of those closing rules need a signal that does not exist yet.** For runtime, a
  dedupe hit makes `reportError` return without touching the issue (the rate-limit check
  returns earlier still), so nothing observes that an error is still firing — an expiry
  keyed on issue timestamps would close precisely the errors recurring so steadily nothing
  needed to re-file them. Persist last-seen first. For build, `FAILURE_TYPES` is exactly
  `deployment.error`/`deployment.failed` and every other event returns `{ignored:true}`, so
  no green build is observable at all; add `deployment.succeeded` to the Vercel
  subscription and the receiver's accepted set. That is cheap *here* only because deploys
  are `workflow_dispatch`-only — a property of this repo's manual-release rule, not a
  general one.

### 5.2 Owner decisions

issue 1057–issue 1060 are agents correctly declining to invent an answer. Nothing routes them
anywhere. Add `needs-owner` and one weekly digest; these are the highest-value items in the
backlog precisely because they block agents that are otherwise unblocked.

### 5.3 Stale branches

45 of them, oldest from February. The gate deletes on merge, so these predate it or were
abandoned. **One janitor pass, then a periodic one for a narrower population** — and the
narrowing is the point.

An earlier revision claimed deletion was a side effect of the gate's own
`gh pr merge --delete-branch` and would stop when Stage B took the merge away. Checked:
`delete_branch_on_merge` is already `true` at the repository level, so GitHub deletes
merged branches regardless of who merges. That claim was wrong, and it is the one finding
in this document overturned by evidence rather than argument — worth leaving visible, since
eighty findings were checked against code and none against the settings until now.

But withdrawing the standing janitor along with it went too far in the other direction.
`delete_branch_on_merge` fires **on merge**; a pull request closed without merging, or a
branch abandoned before any PR was opened, is never cleaned up by it. This paragraph
attributes some of the existing 45 to exactly that, so the pile rebuilds from the next
abandoned branch. The janitor stays periodic — it just has a much smaller job than
originally described, sweeping unmerged and abandoned branches rather than everything.

---

## 6. Two standing concerns, and the tooling debt under them

**Security.** `dependency-security-maintainer` covers dependencies well and nothing else.
No agent reads the *code* surface, which here is the higher risk: JWT auth, magic-link OTP,
a runtime-mutable permission matrix, revocable agent tokens, admin-gated importers, an HTML
sanitizer, and several paths where an LLM reads text written by strangers (paper full text,
`scopeNote`, advisory bodies, fetched pages). Run a fixed rotation, **one surface per
cycle** — auth → permission matrix → agent tokens → untrusted-input boundaries → sanitizer
and CSP → raw SQL. Findings are issues, never silent fixes, and **never weaken a guard to
clear a finding**; the content side already had to learn this structurally, which is why
`parameterApplicability.write` sits at a raised floor tier.

**Efficiency.** The gate's own v6/v7 work is the standard to copy: it *measured* billed
minutes, found the poll loop was 74% of them, and cut it, with the measurement written into
the file. One measured finding per cycle — Actions minutes, agent token spend, bundle size,
cold starts, N+1 paths. If it cannot measure a claim, it does not file it.

**Least privilege.** `dependency-security-maintainer` is also the template for what a
development agent should *hold*: fresh checkout, no `DATABASE_URL`, no production Vercel
secrets, no `ANTHROPIC_API_KEY`, explicit hostile-text awareness, at most one PR per cycle.
Development routines get the same treatment. A code agent has no business holding
production database credentials.

**Harden before accelerating.** issue 1076 and issue 1077 are the two that matter most, and they
should be early agentic work rather than backlog. issue 1076 names six uncoordinated writers, a
non-atomic method-component replace, and an ambiguous identifier that can silently resolve
the wrong drug. issue 1077 shows the production-writing scripts sit outside every typecheck.
Both are exactly the class of defect that gets worse when throughput rises tenfold, and
issue 1076's headline failure — *everything succeeded, the wrong scientific object was stored* —
is the failure mode this codebase actually suffers from.

---

## 7. Shared memory: GitHub as the bus, and two ledgers

Agent reasoning that affects a decision must land in an issue, RFC or PR — never only in a
session that ends.

- **Labels as the state machine — for coordination, never for authority.** `claude`,
  `codex`, `claude-blocked`, `codex-blocked`, `security`, `optimization`, `auto-fix`,
  `loose-thread` already exist. Add only orthogonal concepts: `agent-ready`,
  `needs-owner`, `strategy`, `risk:R0..R3`.

  **`risk:` is the exception, and it is a display, not a decision.** Labels are editable by
  every identity holding repository write, so a risk label that *is* the sticky ceiling
  lets either agent remove or downgrade an R3 and silently take the de-escalation §2
  reserves for the owner. The ceiling lives in owner-controlled state; the label is a
  **read-only projection** of it, refreshed by the gate and authoritative for nothing.
  Anything else here that comes to gate a merge rather than merely route work inherits the
  same treatment — that is what the custody invariant means in this section.
- **Claim with a lease.** A builder claims one item by assigning its identity and writing a
  run marker with an expiry. Without this, two agents on overlapping schedules do the same
  issue twice — the same hazard `claimNextJob` already solves for paper extraction with
  `FOR UPDATE SKIP LOCKED` and a reclaimable stale claim. Copy that shape.
- **An engineering learning ledger**, distinct from the content one in
  `agents/cross-agent-learning-protocol.md`. Same two properties — it endures, it is shared
  — same discipline: merged not appended, capped at ~12 rules, pruned when obsolete. Recent
  PRs have already produced exactly the reusable lessons that belong in it: *numeric
  identifiers drawn from two namespaces need tagged keys*; *a full-replace writer must be
  transactional*; *a displayed state used to authorize a write must travel back with a
  version token*; *check-then-write across two connections is not serialized*. The next
  agent should inherit these rather than rediscover them six PRs later.
- **A constitution** at `agents/dev/constitution.md`, with `builder.md`, `reviewer.md`,
  `triage.md`, `security-auditor.md`, `performance-auditor.md`, `strategist.md` beside it.
  Both models consume the same role specs; model-specific files stay tiny.

---

## 8. The strategy loop is separate, and deliberately slow

Do not let the two models discuss "what should we build" during coding cycles. Agents are
very good at manufacturing plausible work, and mixing ideation into the build loop turns
the repo into a feature pinball machine.

Once a week: Claude writes an independent assessment of product, roadmap, open issues,
architecture and recent work. Codex writes its own **without reading Claude's**. Only then
does a synthesis pass compare them. Independence is the mechanism, not the ceremony —
agreement between two models that read each other first is not evidence of anything, and
`agents/peer-verification-protocol.md` already codifies this for content.

Judge every candidate on the same axes: **user value** (does it improve a real
pharmacology/toxicology workflow?), **trust** (correctness, provenance, interpretability),
**architectural leverage** (a reusable primitive or another special case?), **data
readiness** (does the reference data exist?), **cost** (engineering + maintenance +
curation), **risk** (how bad is a plausible *silent* failure?), **reversibility** (testable
without committing the architecture?).

Output is ~3 candidate moves, not 40 ideas. Novel ideas become an `experiment` issue; at
most one or two exploratory branches live at a time.

### Where the strategy agents should point Kinetix now

Not "more features". The strongest direction already in the repo is **a generalized,
evidence-aware analytical workbench rather than a collection of calculators** — and two
documents already argue it better than a fresh proposal would:

- The **Case Pattern Explorer** spec establishes reusable primitives (specimens, analytes,
  metabolic lineage, curated features, context-matched reference data, source
  compatibility, provenance) and deliberately separates measurement, deterministic
  calculation, reference comparison and exposure inference — explicitly refusing to make v1
  a black-box exposure classifier. That is good product architecture, and it is specified.
- The **modeling trust roadmap** concluded, after reading the code, that the weakness is
  statistical semantics and correctness rather than missing features, and prioritized
  trust, provenance, honest assumptions and validation.

So three parallel streams:

1. **Reliability / control plane** — §1, issue 1076, issue 1077, security and test coverage.
2. **Current product vertical** — finish Case Pattern Explorer Phase 1, then its specified
   phases, rather than opening another feature frontier.
3. **The non-engineering critical path** — start the reference-corpus curation of issue 1060
   *now*, in parallel. Agents writing code faster cannot dissolve a human curation
   bottleneck later, and this is the one stream that does not accelerate with more compute.

---

## 9. Rollout, and what to measure

### Order of operations

Every arrow below is a dependency someone would otherwise discover the hard way. Several
were found exactly that way, during review of this document.

One maintenance note, arrived at the hard way: **this table used to restate §1's Stage
0/A/B sequence, and drifted from it four times.** Each time a section was corrected while
the ordered row it implies kept stating the design that had just been rejected, so an
implementer following the table would have built the discarded version. After the third
occurrence the note here asked for both registers to be updated together; the fourth
happened anyway, in the row added to fix the third.

So the duplication is gone rather than annotated — the phase rows below cover work stated
nowhere else, and the bootstrap order lives only in §1. A rule that requires two places to
be edited in step is a defect surface wearing a reminder; the fix is to have one place.

| # | Step | Why it cannot move later |
| --- | --- | --- |
| 0/A/B | **See §1's numbered sequence — that is the authoritative order.** Restating it here drifted from the prose four times in review; this row exists so the table has one entry per phase and none of them duplicate an ordering stated elsewhere | Two registers of the same sequence is a defect surface, not documentation |
| 1 | `agents/codex-routine-setup.md` — a documented Codex runner | The repo wires only Claude; an unrunnable Codex turn does not get skipped, it collapses onto Claude |
| 1 | **Claude-reviews-`codex/*` trigger** | Ships in the same breath as Codex authoring. The moment self-approval is excluded, a Codex-authored PR has no admissible reviewer and stalls until a human intervenes |
| 1 | `AGENTS.md` split + byte budget on **every** instruction file + `CLAUDE.md` shims | Every routine added first pays the 31k-token tax forever |
| 1 | `scripts/` into typecheck (issue 1077) | It is the substrate the agents run on |
| 1 | Auto-fix fingerprint inputs; diagnose the trigger | Everything else assumes the pipeline's output goes somewhere |
| 2 | Issue triage (alternating — Claude-only if any step 1 item slipped, stated explicitly rather than degrading quietly) | — |
| 2 | `needs-owner` label + weekly digest; branch janitor | — |
| 2 | Last-seen persistence → **then** runtime expiry; success-event wiring → **then** build auto-close | Both closing rules are unobservable until their signal exists |
| 2 | Deploy marker, **protected from agent writes** → **then** the release summary, in a Release body or pinned issue — **never a tracked file** | A guessed lower bound drops operator steps silently; a tracked file appears in its own delta; and an unprotected tag is movable by any identity with repo write |
| 2 | Post-deploy actions tracked as **their own items**, with completion in owner/environment-controlled state | The commit delta drops each one the moment the marker advances — i.e. exactly when it becomes due; and an ordinary issue or Release is editable by every identity holding repo write |
| 3 | Security rotation; cost-and-perf; engineering ledger | Wants a working builder/reviewer loop to learn from |
| 4 | Strategy council | Wants a stable enough repo that direction is the binding constraint |

### Rolling out autonomy

**For roughly the first 20 agent-created PRs, both agents run the whole workflow and you
keep the merge click.** The point is not catching bad code — the reviewer does that. It is
discovering bad **rules**. Write every one you find into the engineering ledger as you find
it, or that period produces learning that evaporates when the sessions end.

Then: auto-merge for R0/R1. Then R2, once migrations, data writers, modeling code and
conflict resolutions have visibly survived the process. R3 stays an owner decision
permanently.

**Deployment stays manual and human-only**, and not merely out of caution: the production
build applies pending migrations to the live database before the app is compiled, so the
migration guard in `deploy-production.yml` is the last place a malformed migration can be
stopped before Neon sees it. Development becomes autonomous; *releasing* does not. The
operating model that produces — come back to five reviewed PRs merged, new issues filed,
and a release summary waiting for your button — is the goal, not a compromise.

That release summary needs a home outside the history it measures — a Release body or a
pinned issue, **not** a tracked file (see below). It carries merged-but-undeployed commits plus
every post-deploy step harvested from the PR bodies — issue 1069's seed step,
`backfill:substance-classes`, and so on). **It also needs a lower bound that does not exist
yet**: `deploy-production.yml` checks out `ref: main` and records nothing about what it
shipped, and a run's triggering SHA is not a substitute since it differs whenever another
ref launched the run or `main` advanced before checkout. Record the resolved post-checkout
SHA — a moving `production` tag or a Release — before writing the routine, or it will drop
operator steps silently, which is the one thing it exists to prevent.

**The commit delta cannot also track whether the operator steps were done.** These are two
different lifecycles and conflating them loses exactly the information the summary exists
to carry. `backfill:substance-classes` runs *after* the new build is live — so the instant
a successful deploy advances the marker to that commit, the commit leaves the
`production..main` delta and its step vanishes from the summary **at precisely the moment
it becomes due**, whether or not anybody ran it. The delta answers *what ships*; it cannot
answer *what still needs doing*, because for post-deploy work those two are never true at
the same time. Harvest each post-deploy action into its own persistent item with its own
completion state, cleared only when the operator says it is done — never as a side effect
of the marker moving.

"Only when the operator says" then has to be *true*, which an ordinary Release or pinned
issue does not make it: every identity with repository write can edit, check off or close
those, so a routine could silently retire an unrun `backfill:substance-classes` and
reproduce precisely the failure this exists to prevent. The acknowledgement needs
owner- or environment-controlled state, or an owner-authenticated completion transition.
This is the custody invariant above, and it is the third surface to need it — which is why
it is stated as a rule covering future stores rather than fixed once more in place.

**And the marker needs its own protection, which `main`'s ruleset does not provide.** Tags
and releases are not branches: agent identities holding repository write can move a tag or
edit a Release even while `main` is fully guarded. An agent that advances the marker past
the actually-deployed SHA makes the summary omit real commits *and* the operator steps
attached to them — the failure mode is silent and points the wrong way, since the list
looks complete. Put the marker in owner- or environment-controlled state, or add a tag
ruleset that excludes agent mutation. Same lesson as the ruleset itself: moving state out
of the history to escape one problem moves it onto a permission surface that then has to be
guarded too.

**And the list must not measure itself.** Written as a file through a PR, each update
lands as a commit after the production marker and so appears in the next run's own
undeployed list — including the commit that *clears* the list after a deploy. That is an
endless chain of release-note PRs, each one generated by the previous one. Either exclude
release-list-only commits from the delta, or — cleaner — keep the generated state out of
the history being measured entirely: a Release body or a pinned issue is not a commit and
cannot appear in its own diff.

### Cadence

| Process | Cadence |
| --- | --- |
| PR / review discovery | event-driven; scheduled backstop every 1–2 h |
| Builder issue pickup | every 2–4 h, **plus event-driven on review completion** |
| CI / error triage | every engineering cycle |
| Changed-code security + performance audit | daily |
| Whole-repo security / dependency / architecture sweep | weekly |
| Strategy council | weekly |
| Architecture + debt review | monthly |

Avoid heavy polling. The gate's own history is the cautionary tale — a poll loop grew to
74% of its billed minutes before anyone measured it.

### Signals

| Signal | Now | Target |
| --- | --- | --- |
| Standing context per agent run | ~31k tokens | <5k |
| PRs merged without an independent reviewer | unenforceable today | 0, enforced by GitHub |
| Bugs first found *after* merge rather than by the opposing model | unknown | trending down |
| Human interventions per PR | — | trending down |
| Average review rounds | — | stable, not growing |
| Duplicate work from agent races | — | 0 |
| Escaped regressions / reverts | — | 0 |
| Open `auto-fix` issues older than 7 days | 8 | 0 |
| Owner-decision issues with no response | 4 | surfaced weekly |
| Stale branches | 45 | <10 |
| CI cost; issue→merge time | measured | measured |

The two to watch hardest are **PRs merged without an independent reviewer** — the
difference between two agents and one agent that agrees with itself — and **bugs first
found after merge**, which is the only real measure of whether the adversarial pairing is
doing anything.

---

## 10. What not to automate

- **Production deploys.** Human, manual, unchanged.
- **The owner-decision queue.** issue 1057–issue 1060 are the system working correctly.
- **Merging your own work**, under any label, for either agent.
- **Amending the constitution or the control plane.** Propose freely; never self-approve.
- **Scientific and clinical judgement.** The content side already draws this line —
  `clinical_case` needs a human expert, `substance_class` entries must carry a checkable
  claim. Code agents inherit it: an agent may decide what the codebase says, never what is
  pharmacologically true.
