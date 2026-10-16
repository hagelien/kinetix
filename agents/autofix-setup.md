# Wiring the auto-fix pipeline

Runtime path counterpart to `agents/error-fixer.md`. This connects Vercel
errors → GitHub `auto-fix` issues → a Claude Code trigger that opens fix PRs.

```
app 500 / platform error ─▶ Vercel Log Drain ─▶ POST /api/vercel-log-drain ─┐
build failure ──────────▶ Vercel deploy webhook ─▶ POST /api/vercel-deploy-hook ─┤
                                                                                  ▼
                                       api/_lib/autofix-issues.ts (dedupe + file)
                                                                                  ▼
                                              GitHub issue, label: auto-fix
                                                                                  ▼
                                  Claude Code GitHub trigger → reads error-fixer.md → PR
```

The code (`api/vercel-log-drain.ts`, `api/vercel-deploy-hook.ts`,
`api/_lib/autofix-issues.ts`, and the `KINETIX_ERROR` marker in
`api/_lib/response.ts`) ships with the deployment. The steps below are the
one-time external config.

## 1. Environment variables (Vercel project → Settings → Environment Variables)

| Name | Value |
| ---- | ----- |
| `GITHUB_AUTOFIX_TOKEN` | fine-grained PAT, **Issues: write** on `hagelien/kinetix` |
| `GITHUB_REPO` | `hagelien/kinetix` |
| `VERCEL_LOG_DRAIN_SECRET` | signature secret from the Add-Drain screen (step 2) |
| `VERCEL_WEBHOOK_SECRET` | signature secret from the webhook (step 3) |
| `AUTOFIX_DRY_RUN` | `1` for the first rollout — logs instead of filing issues |
| `AUTOFIX_DISABLED` | set to `1` to pause the whole pipeline without removing secrets |

Roll out with `AUTOFIX_DRY_RUN=1`, confirm the receivers log the parsed errors,
then remove it to go live.

## 2. Log drain (runtime errors) — Vercel dashboard → Add Drain

- **Data:** Logs. **Sources:** Functions (+ Edge Functions if used).
- **Destination:** Custom Endpoint → `https://<prod-host>/api/vercel-log-drain`,
  encoding **JSON**.
- Copy the **Signature Verification Secret** into `VERCEL_LOG_DRAIN_SECRET`.
- Use the screen's **Test** button to fire a sample batch; with dry-run on it
  should log and create nothing.

The drain is a firehose — the receiver only acts on error-level entries and the
`KINETIX_ERROR` lines emitted by `withErrorHandling`, and ignores logs from the
drain/webhook routes themselves (loop-guard).

## 3. Deployment webhook (build failures) — Vercel dashboard → Webhooks

- **Events:** `deployment.error` (and optionally `deployment.failed`).
- **Endpoint:** `https://<prod-host>/api/vercel-deploy-hook`.
- Copy the webhook secret into `VERCEL_WEBHOOK_SECRET`.

## 4. GitHub trigger (the fix agent) — claude.ai

Create a Claude Code GitHub trigger on `hagelien/kinetix` that starts a session
when an issue is **labeled `auto-fix`**, with the prompt:

```
Read agents/error-fixer.md end-to-end, then handle the labeled auto-fix issue
exactly as it specifies.
```

The session uses the Vercel MCP tools to pull full logs (see
`agents/error-fixer.md` step 2), so the trigger's environment needs the Vercel
MCP connection available.

## Before going live: the injection path

An issue body is built from error text, and error text carries request
input: a Drizzle query error embeds the bind parameters, and some handlers log
raw request values. So anyone, without signing in, can choose words that
reach the fix agent, both in the issue and in the runtime logs it pulls
through the Vercel MCP tools. Treat that text as hostile and keep a person
between it and `main`:

- **The fix agent opens drafts only** (`agents/error-fixer.md` step 6).
  `codex-gate` never merges a draft. A person reviews the change and marks it
  ready, and only then does the gate's usual review-and-CI path apply.
- **Restrict the trigger environment's outbound network** to GitHub, Vercel and
  the package registry. An agent that follows planted instructions should have
  nowhere to send what it can read.
- **Give the trigger nothing it doesn't need.** No production database
  credentials, and no tokens beyond the repository access the PR needs.

Do not enable the GitHub trigger in step 4 until all three hold.

## Kill switch

- **Pause everything:** set `AUTOFIX_DISABLED=1` (receivers still 200, file
  nothing).
- **Stop only auto-fixing:** disable the GitHub trigger; issues keep accruing
  for manual triage.
- **Stop ingestion:** delete the log drain / webhook in Vercel.
