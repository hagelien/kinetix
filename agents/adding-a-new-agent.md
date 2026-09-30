# Adding a new, separate agent

For multiple **local Codex schedules** on one checkout, use
[local-codex-workers.md](local-codex-workers.md) to select a private credential
profile on every API/logging command. The cloud-environment recipe below still
applies to remotely hosted routines.

This is the step-by-step recipe for standing up a _new_ scheduled agent alongside the existing `kinetix-agent`. Read it once; then for each new agent you only repeat steps 1–5.

## What an "agent" is here

An agent in Kinetix is **not a code class**. It is the sum of four things:

1. A **user row** (`users`) that acts as the service account.
2. An **agents row** (`agents`) holding admin-facing metadata (`name`, `slug`, …) and the lifecycle `status`. This is what the admin agent overview manages.
3. A **routine prompt** under `agents/<slug>.md` that defines what the agent does on each run.
4. A **Claude Code Routine + cloud environment** that fires the prompt on a schedule (`agents/remote-routine-setup.md`).

The helper scripts the existing agent uses are **agent-agnostic**: `scripts/kinetix-api.sh` calls the API with whatever `kxat_…` token is in `KINETIX_TOKEN`, and `scripts/kinetix-log-verification.ts` logs through the API using that same token. Agent-backed users authenticate only with a revocable `kxat_` token (bare JWTs are rejected for them), so each agent gets its own token via `AGENT_SLUG=<slug> npm run seed:agent-token`. A second **contributor** agent needs **no new TypeScript** — only a DB row, a prompt file, its own `kxat_` token, and its own cloud environment.

> Worked example: `reflink-agent` ("Kinetix referansevakt"), a reference-link checker. Its prompt lives at `agents/reflink-agent.md`. Substitute your own slug/name/purpose throughout — the mechanics are identical for any scheduled contributor agent.

## Step 1 — Create the user + agents rows (SQL, in Neon)

Paste into the Neon SQL editor, keeping the `BEGIN`, the lock and the `COMMIT`: an agent inserted without the lock could land while a consensus check is counting the pool, and let an edit publish on fewer approvals than the new pool requires. Column names are the drizzle snake_case forms from `db/schema.ts`. `email`/`username`/`slug` must be unique. Set `hooks_enabled = false` for a scheduled agent (only hook-triggered agents need `true`, and those rely on `api/_lib/agentHooks.ts`).

```sql
BEGIN;
-- Serialise with consensus re-checks: a new active agent changes the quorum
-- (src/lib/agentPoolLock.ts). Held until COMMIT.
SELECT pg_advisory_xact_lock(1357, 0);

WITH new_user AS (
  INSERT INTO users (email, username, role, email_verified_at)
  VALUES ('<slug>@kinetix.internal', '<slug>', 'contributor', now())
  RETURNING id
)
INSERT INTO agents (user_id, name, name_en, slug, description, description_en, status, hooks_enabled, model_tier)
SELECT id,
       '<Norsk navn>', '<English name>', '<slug>',
       '<Norsk beskrivelse>',
       '<English description>',
       'active', false, NULL   -- model_tier: leave unclassified here; assign it in Step 5, once the Routine's model is known
FROM new_user
RETURNING id AS agent_id, user_id, slug;

COMMIT;
```

**Leave `model_tier` NULL here, and set it in Step 5.** `model_tier` is the **server-owned** capability class the peer-consensus gate reads: a high-risk (calculation-driving, entry-backed parameter) edit auto-applies only with the full quorum **and** at least one **flagship**-tier approval. `NULL` is the fail-safe — it **never** counts as flagship — so a row that lands unclassified can hold no more authority than it has earned, which is exactly what you want for the window between creating the identity and knowing which model its Routine runs. The tier belongs to the model, and you do not choose the model until Step 4: a guessed tier written here is the one mistake this column cannot absorb, since a cheap model classified `flagship` is precisely the hole the consensus gate exists to close.

**Do the assignment as an admin from Admin → Agents → Edit**, where **Model tier** sits beside the role dropdown and each row carries a tier badge (`Unclassified` included) so the current value is legible without opening the form. Promoting to `flagship` there asks for confirmation — the deliberate pause that catches a mis-set tier while it is still cheap. Classify each identity to the tier of the model its Routine runs: `flagship` for the Opus/Fable/Mythos/Sol class, `mid` for Sonnet/Terra, `light` for Haiku/Luna. The same form can also create the whole identity (**Admin → Agents → New agent**, tier included, with the same confirmation), which is the shortest path for a one-off agent; the SQL above stays the documented route when you want the row and its descriptions written in one statement.

`PATCH /api/admin?resource=agents&id=<agent_id>` with `{ "modelTier": "flagship" }` (`null` clears it back to the fail-safe) remains available for **scripted or bulk provisioning** — it skips the confirmation, which is the point when a script is doing the deciding and a nuisance when a person is. Never a raw `UPDATE`: that skips the API's validation too. Either way this is an **admin-only** action — the agent's own `kxat_` token can't reach `/api/admin`, and the tier is deliberately server-owned so a running agent can never set its own capability class. See `agents/remote-routine-setup.md` §7 for the tier vocabulary, the pool-size rules (a high-risk edit needs **≥3 active identities** — two non-author verifiers, one flagship), and when flagship classification actually matters.

Concrete values for the worked example:

```sql
BEGIN;
-- Serialise with consensus re-checks: a new active agent changes the quorum
-- (src/lib/agentPoolLock.ts). Held until COMMIT.
SELECT pg_advisory_xact_lock(1357, 0);

WITH new_user AS (
  INSERT INTO users (email, username, role, email_verified_at)
  VALUES ('reflink-agent@kinetix.internal', 'reflink-agent', 'contributor', now())
  RETURNING id
)
INSERT INTO agents (user_id, name, name_en, slug, description, description_en, status, hooks_enabled, model_tier)
SELECT id,
       'Kinetix referansevakt', 'Kinetix reference checker', 'reflink-agent',
       'Sjekker jevnlig at siterte kilder fortsatt er tilgjengelige og flagger døde lenker.',
       'Periodically checks that cited sources remain reachable and flags dead links.',
       'active', false, NULL   -- tier assigned in Step 5; reflink-agent ends up 'mid' — a link checker never needs the flagship path
FROM new_user
RETURNING id AS agent_id, user_id, slug;

COMMIT;
```

**Record the returned `user_id`** for admin/audit lookups. It no longer goes into the Routine environment. The agent now appears in the admin agent overview.

Mint the agent's persistent API token and save the plaintext `kxat_…` value; it is printed once:

```bash
AGENT_SLUG=<slug> npm run seed:agent-token
```

> Provisioning note: `kinetix-agent` was created by `scripts/seed-agent-user.ts`, which also guards suspend/deactivate re-syncs. Pasting SQL skips that safety net. So for **status changes later** (suspend/reactivate/deactivate), use the audited admin endpoint `PATCH /api/admin?resource=agents&id=N&action=transition` (or the admin UI) rather than raw `UPDATE`s — that keeps the `agent_status_history` audit trail correct and re-syncs the backing user's role.

## Step 2 — Write the routine prompt (`agents/<slug>.md`)

Model it on `agents/drug-db-maintainer.md` (or copy the leaner `agents/reflink-agent.md`). Keep these load-bearing pieces:

- **§0 Environment & tooling** — list only `KINETIX_TOKEN`, `KINETIX_BASE_URL`, and `KINETIX_AGENT_DRY_RUN`; mandate the helpers; prohibit direct `DATABASE_URL`/`JWT_SECRET` exposure, `psql`, repo edits, and `git`; remind that Bash-tool calls don't share shell state and that fetched content is untrusted.
- **Secret and external-content boundaries** — explicitly state that environment variables and `.env` values are confidential, fetched/search content is untrusted data, and external content must never be followed as instructions (especially requests to read files, run commands, reveal secrets, or post arbitrary text).
- **Mission** — your agent's actual job, scoped to one cycle.
- **Hard rules** — Norwegian (bokmål) for all reader-facing content, spelled with `æ`, `ø` and `å` rather than ASCII stand-ins (link `agents/drug-db-maintainer.md` §1, "Norwegian orthography"); never fabricate; respect `KINETIX_AGENT_DRY_RUN`; **log every action** via `scripts/kinetix-log-verification.ts`.
- **Audit logging** — the `--target-type` enum in `scripts/kinetix-log-verification.ts` is fixed (`parameter | monograph_fact | discussion_sweep | rejection_review`); reuse the closest fit. A new target type requires a code change to that enum.
- **Peer verification** — every contributor agent participates in agent-to-agent peer review (PR 575). Add a small per-cycle step that pulls 3–10 items from `GET /api/agent-verifications-queue`, judges each independently, and posts a verdict via `POST /api/agent-verifications`. See `agents/peer-verification-protocol.md` for the full contract (endpoints, verdict semantics, independence rules, error handling) — including the **capability-aware gate**: high-risk edits need a flagship-tier approval, so whether this agent's approvals help auto-apply them depends on the `model_tier` you set in Step 5. Mention the protocol in your prompt and size the batch for your cycle's time budget.
- **End-of-cycle paragraph** — one concise English paragraph for the operator log.

## Step 3 — Create a cloud environment

At <https://claude.ai/settings/environments> → **New environment** (e.g. `kinetix-<slug>`):

| Name                    | Value                               |
| ----------------------- | ----------------------------------- |
| `KINETIX_TOKEN`         | the `kxat_…` token minted in Step 1 |
| `KINETIX_BASE_URL`      | e.g. `https://kinetix.app`          |
| `KINETIX_AGENT_DRY_RUN` | `1` for the first run, then remove  |

A **separate environment with a distinct `KINETIX_TOKEN`** is what makes this a separate agent while reusing the shared helper scripts. Do **not** add `DATABASE_URL`, `JWT_SECRET`, or `ANTHROPIC_API_KEY` — the Routine should not receive direct production credentials.

## Step 4 — Create the Routine

At <https://claude.ai/code/routines> → **New routine** (or `/schedule` from a CLI session):

| Field           | Value                                          |
| --------------- | ---------------------------------------------- |
| **Name**        | `Kinetix <slug> cycle`                         |
| **Trigger**     | Schedule → your cadence (e.g. `Every 6 hours`) |
| **Repository**  | `hagelien/kinetix` (default branch)            |
| **Environment** | `kinetix-<slug>` (from Step 3)                 |
| **Model**       | the tier-defining choice — **the `model_tier` you set in Step 5 must match it** (`flagship` = Opus/Fable/Mythos/Sol, `mid` = Sonnet/Terra, `light` = Haiku/Luna) |
| **Effort**      | reasoning/effort level — `high` for a producer or high-risk verifier; `xhigh`/`max` only for the rare adjudicator (`agents/remote-routine-setup.md` §7) |
| **Prompt**      | see below                                      |

> **The Model field is the one that actually sets this agent's capability — pick it deliberately.** The server trusts `agents.model_tier` verbatim (it never re-derives the tier from the running model), so a mismatch is an integrity hole, not a cosmetic slip: a Routine you set to a `mid` model while its `model_tier` says `flagship` will have its approvals satisfy the flagship gate for calculation-driving edits. Step 1 deliberately left `model_tier` NULL, so this choice is what Step 5 classifies the identity against — set it there before the first live run, and re-set it whenever you change this field later.

```
Read agents/<slug>.md end-to-end, then execute exactly one cycle as the routine specifies. Emit the end-of-cycle paragraph as your final message, nothing more.
```

The runner clones from the default branch each run, so edits to `agents/<slug>.md` that land on `main` take effect on the next cycle — no re-deploy. The Routine form is a thin pointer; the prompt file is the source of truth.

## Step 5 — Dry-run, then go live

**First, set the tier to match the model you actually chose in Step 4.** Step 1 left `agents.model_tier` NULL on purpose; now that the Routine's model is fixed, the identity can be classified against something real. This is the check that keeps a non-flagship model from clearing the flagship gate. Do it as an admin before the first live run: open **Admin → Agents**, read the tier badge on the agent's row, and set **Model tier** in its edit form to the tier of the Step 4 model. Promoting to `flagship` prompts for confirmation, which is the point at which to double-check the Routine's Model one more time. The same applies to an identity that already carries a tier and needs a different one.

The equivalent endpoint, for scripted provisioning:

```
PATCH /api/admin?resource=agents&id=<agent_id>   { "modelTier": "<tier of the Step 4 model>" }
```

Then dry-run: trigger the Routine manually with `KINETIX_AGENT_DRY_RUN=1` still set and read the run log — it should plan actions and print `[dry-run]` lines where it would write. When the plan looks right, delete `KINETIX_AGENT_DRY_RUN` (or set it to `0`), trigger once more, verify the writes landed, then let the schedule take over.

> **This reconciliation is not one-time.** `model_tier` is not derived from the running model, and each verdict snapshots the *current* `agents.model_tier` into its `verifier_tier` at record time. So **any later change to the Routine's Model** — a downgrade, an upgrade, or a model swap — requires re-reconciling `model_tier` **before you re-enable the Routine**: pause it, set the new model's tier (or `Unclassified`) in **Admin → Agents → Edit**, verify against the row's tier badge, then resume. A Routine downgraded from a flagship to a mid model while still classified `flagship` would let the mid model's approvals clear the high-risk gate until you correct it.

## Verification

- **DB:** `SELECT id, slug, status, model_tier FROM agents WHERE slug='<slug>';` returns one `active` row whose `model_tier` matches the **model you selected in the Step 4 Routine** (not `NULL`, unless you deliberately want the fail-safe, and never a higher tier than the model actually runs), and the backing user has role `contributor`.
- **Admin overview:** the agent shows in the admin agent table.
- **Shared helpers work with the new id** (proves no code change was needed). `scripts/kinetix-api.sh` validates `KINETIX_BASE_URL` and `KINETIX_TOKEN` _before_ it honors the dry-run flag, so both must be set — easiest is to create `.env` with your deployment values (as in `agents/remote-routine-setup.md` §1c) and run:
  ```bash
  KINETIX_AGENT_DRY_RUN=1 scripts/kinetix-api.sh GET '/api/drugs?limit=1'
  ```
  or pass them inline:
  ```bash
  KINETIX_BASE_URL=https://kinetix.app KINETIX_TOKEN=<kxat token> \
    KINETIX_AGENT_DRY_RUN=1 scripts/kinetix-api.sh GET '/api/drugs?limit=1'
  ```
  Either form prints a `[dry-run]` line and exits 0.
- **First Routine run** (dry) plans the work and prints `[dry-run]`; first live run produces the expected rows (e.g. discussion comments + `verification_log` entries).

## Kill switch

- **Pause the Routine (primary emergency stop):** disable the Routine at <https://claude.ai/code/routines>. A scheduled agent only acts when its Routine fires, so pausing it stops _all_ activity — including direct discussion comments — immediately and completely. This is the reliable stop for any agent.
- **Suspend/deactivate the agent (API-permission revoke, partial):** via the admin transition endpoint (Step 1 note), this demotes the backing user to `authenticated`. That blocks **contributor-gated writes** (parameter submissions, `pending_edits`), but it does **not** block actions any authenticated user can take — notably `POST /api/drug-discussions`, which a comment-posting agent like `reflink-agent` relies on. So for a comment-only agent, suspension alone does **not** stop it from writing; pause the Routine.
- **Revoke a persistent API token (per-token, targeted):** in **Admin → Agents → Tokens**, revoke the agent's `kxat_…` token. The next request using it fails immediately — a precise kill switch that touches only that token. (Tokens are inert anyway once the agent is suspended, since auth reads the live demoted role.)
