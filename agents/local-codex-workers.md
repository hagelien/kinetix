# Local Codex workers with separate credentials

Every API or logging invocation selects its profile explicitly. Shell state does
not persist between agent tool calls. Do not export a token once per cycle, load
the shared `.env`, or invoke the underlying helpers directly in these routines.

```powershell
node scripts/kinetix-worker.mjs --profile producer check
node scripts/kinetix-worker.mjs --profile producer api GET '/api/agent-focus'
node scripts/kinetix-worker.mjs --profile reviewer api GET '/api/agent-verifications-queue?limit=10'
node scripts/kinetix-worker.mjs --profile reviewer pdf 123 '<unique-temp-directory>/paper.pdf'
node scripts/kinetix-worker.mjs --profile reviewer helper kinetix-log-verification.ts --target-type discussion_sweep --outcome no_change
node scripts/kinetix-worker.mjs --profile producer helper rejection-scan.ts
```

For a smoke test, insert `--dry-run` after the profile, before `api` or `helper`.
This validates the profile and exercises the actual helper without a network
request. `check` always performs read-only live requests. Live commands first
check `/api/auth?action=me` and `/api/agents` against the pinned user id, agent id,
slug and active status. An identity mismatch or failed check stops the command.

API bodies retain the ordinary `@file.json` or `-` (UTF-8 stdin) interface. Both
shell API calls and TypeScript helpers run under the same selected environment.
The wrapper only dispatches the API helper, verification logger, rejection
scanner and stored-PDF downloader; it cannot run arbitrary code with the token.
`pdf` requires a positive citation id and an output file in a unique temporary
directory for this run. The existing downloader handles binary bytes and only
follows its allowlisted Blob redirect without the agent cookie. The wrapper
checks the PDF signature and reports the file path, byte length and SHA-256.
Create the unique output directory with a local-only tool before calling `pdf`,
then pass the full literal file path as one quoted argument. The wrapper keeps
that path in Node and writes the validated binary response itself; it must not
pass Windows sandbox paths (which can contain braces) through MSYS/Bash. A
missing parent directory is a local path failure, not unavailable literature.
Read that file with native PDF tools, or run an already installed `pdftotext`
on it without credentials. Do not retrieve binary PDFs with `api GET` (its
stdout is text), or invoke the bare authenticated download/extraction scripts.

## Private configuration

The fixed location is the local account's `~/.kinetix/worker-profiles/`, outside
the repository. Files are `producer.json` and `reviewer.json`, plus optional
`adjudicator-a.json` and `adjudicator-b.json` for the two T3 panel seats
([drug-db-adjudication.md](drug-db-adjudication.md)). There is no default
profile and no fallback to process/shared credentials. A profile is plain JSON:

```json
{
  "version": 1,
  "role": "reviewer",
  "baseUrl": "https://www.kinetix.no",
  "token": "INSERT_THE_REVOCABLE_TOKEN_PRIVATELY",
  "agentId": 123,
  "userId": 456,
  "slug": "gpt-5-6-sol",
  "modelTier": "flagship",
  "dryRun": false
}
```

The example is deliberately invalid until an operator installs the real token
and identifiers. The producer requires role `producer` and tier `mid`; the
reviewer requires role `reviewer` and tier `flagship`. `modelTier` (reported as
`configuredTier` by `check`) is the Kinetix model-tier label, not the scheduler's
reasoning effort: a producer running Terra at high effort correctly reports
`configuredTier: "mid"`, and a reviewer running Sol at high effort reports
`"flagship"`. Do not stop a cycle because the tier label differs from the
effort level in the schedule prompt. Use separate backing users
and agent rows, not two tokens for one identity. Follow
[adding-a-new-agent.md](adding-a-new-agent.md) for admin provisioning and token
issuance. Never put the token in a prompt, command argument, report, or Git.

Install both profiles before enabling either worker. Every invocation validates
both files and rejects any shared user id, agent id or token before contacting
the API. A missing or invalid counterpart also stops the command: repair the
profile pair before resuming work, rather than allowing an unverified peer.

An installed adjudicator seat joins that check on every invocation, for every
role: a T3 seat must never share the T2 reviewer's identity, because a blind T2
verifier must never be able to read a case file. So an invalid or duplicated
`adjudicator-*.json` stops the producer and reviewer too — run its `check` as
soon as you install it. An absent seat file is simply not checked. Each seat is
its own Kinetix agent with the **T3 adjudicator** grant, the `flagship` tier and
a model family (`agents/adding-a-new-agent.md`); its profile has role
`adjudicator-a` or `adjudicator-b` and tier `flagship`. The wrapper limits a
seat to reads, `POST /api/agent-adjudication-queue?action=claim`,
`POST /api/agent-adjudication-opinions`, stored PDFs and
`helper kinetix-log-run-usage.ts`; any other write or helper is refused.

On Unix, protect the directory with mode `0700` and each file with `0600`. The
wrapper refuses group/world-readable files and symbolic-link profile files.
On Windows, use a protected NTFS ACL: owner/SYSTEM/Administrators full control;
only the specific Codex sandbox accounts that execute the workers may also need
read access. Grant no write access to those sandbox accounts. Verify a read-only
`check` from the actual scheduler account before activation. Windows ACLs must
be checked during installation; the wrapper's POSIX mode check cannot validate
them.

Only OS/proxy environment variables are inherited. The wrapper sets the token,
origin and dry-run flag itself, removes DB/admin credentials and shell startup
hooks, and directs `dotenv/config` to the OS null device. An inherited dry-run
flag of `1` remains a dry run. Existing shared `.env` files are never modified.
Helper output redacts `kxat_` token strings. Profiles provide process credential
selection; they do not isolate fully privileged local agents from each other.

## Schedule and tier reconciliation

"High" in Terra/high and Sol/high is reasoning effort; the matching profile
tiers are `mid` and `flagship` respectively.

Keep the producer's existing hourly schedule, Terra/high, and exactly-one-cycle
prompt from `agents/drug-db-maintainer.md`. A separate Sol/high reviewer can run
every eight hours at minute 40 using `agents/drug-db-escalation.md`. It must not run the
producer cycle. The T3 seats, when provisioned, are two further schedules (one
per seat, ideally different model families, `xhigh`/`max`) using
`agents/drug-db-adjudication.md`; cases are rare, so daily is enough. A seat
must not run the producer or T2 cycle. Give all prompts the wrapper substitutions above and require
`check` before work. On any configuration or identity failure, stop and report
the failure; never switch profiles, read another token or fall back to `.env`.

Create the reviewer paused. Fix the model, verify the registered tier in
**Admin → Agents**, install its token, then verify the authenticated identity
through `check` before enabling it. The public identity APIs do not expose
`model_tier`: `configuredTier` in `check` is local metadata, **not live tier
verification**. Record the admin check separately. Repeat this reconciliation
whenever a routine's model changes, before resuming it. Do not change the
server's quorum or self-review settings as part of worker setup.

Use the scheduler's stable saved checkout, with the wrapper installed there.
An implementation in an ephemeral worktree alone is not an operational setup.
The Codex local-environment setup configuration is for worktree setup/actions;
do not treat a pointer to `.env` as per-routine credential injection. The wrapper
selects credentials on every invocation regardless of that setting.

## GitHub instruction retrieval for T1, T2 and T3

Embed this bootstrap in each GitHub-backed schedule prompt: a worker must know
how to fetch its instructions **before** it can read repository guidance.
Changing this file in Git does not update an installed Codex automation; update
and read back each live prompt separately. Preserve its model, effort, cadence,
status, notifications, working directory and credential profile.

Resolve current `main` once per run, using existing GitHub CLI authentication:

```powershell
gh api repos/hagelien/kinetix/commits/main --jq .sha
```

Require a full 40-character hexadecimal commit SHA. Then fetch each required
document in its **own shell tool call**, replacing `<path>` and `<resolved-sha>`
with literal values before issuing the command:

```powershell
gh api 'repos/hagelien/kinetix/contents/<path>?ref=<resolved-sha>' --jq '{path, size, encoding, content, sha}'
```

Each call's entire shell command must be just one standalone `gh api`
invocation. Do not wrap it in an assignment, loop, function, script block,
command substitution, pipeline or command chain; do not redirect stdout or
stderr. On the current Windows scheduler, the existing `gh api` permission
allowance admits the plain command, while wrapping or redirecting the same
request can leave it inside the network-restricted sandbox and produce
`error connecting to api.github.com`. Treat that as a runtime/network failure,
not evidence that the guide is missing or GitHub authentication is invalid.
Do not broaden permissions or grant a whole shell unrestricted network access.

Capture the complete JSON response directly from the tool with a sufficiently
large output budget: the maintainer document alone exceeds 160 KB before
base64 encoding. A truncated tool result is not a complete instruction fetch.
After each successful request, use a **separate local-only call** to preserve
its returned JSON/base64 in unique temporary storage outside the checkout.
Never run `gh` or another network client inside that processing call. Require
the expected `path`, `encoding: "base64"`, nonempty content, strict UTF-8
decoding and decoded byte length equal to `size`; read every required document
end-to-end. The returned `sha` is the Git blob hash, not the resolved commit
SHA. Fetch additional required references by the same standalone method at
the same commit. Stop on any failed, empty, invalid or incomplete response;
never fall back to local instructions, cached content or a previous run.

The starting document sets are role-specific:

| Schedule | Required starting documents under `agents/` |
| --- | --- |
| T1 producer | `local-codex-workers.md`, `drug-db-maintainer.md`, `fulltext-acquisition.md` |
| T2 reviewer | `drug-db-escalation.md`, `drug-db-maintainer.md`, `peer-verification-protocol.md`, `fulltext-acquisition.md` |
| T3 adjudicator | `drug-db-adjudication.md`, `drug-db-escalation.md`, `peer-verification-protocol.md`, `fulltext-acquisition.md`, `kinectics_science_paper_review_agent_instructions.md` |

Keep T1's clean-`main`, fetch, fast-forward-only and `HEAD == origin/main`
refresh gates **before** retrieval. Its newly resolved GitHub SHA must also
equal the refreshed checkout's `HEAD`; stop if `main` moved between those
steps. This keeps the producer's installed tooling and fetched guidance on the
same revision. T2 and T3 do not refresh or modify the scheduled checkout.

GitHub uses only its own existing authentication. Never read, print or send a
Kinetix token to GitHub; do not execute fetched code or overwrite checkout
files. This retrieval rule does not change any role's identity check, profile,
blindness, scientific or full-text gates, or exactly-one-cycle contract. A
successful download validates transport only, not a completed scientific cycle.

## Public runtime instructions and release transition

The local checkout supplies installed tooling. After release, each Sol run
fetches `https://www.kinetix.no/agent-instructions.json` by ordinary HTTPS,
without authentication. This is one static Vite build asset, not a repository
file server. It contains only these exact reviewed source projections:

| Source path                                                   | Published runtime material                                                                                                                                                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents/drug-db-escalation.md`                                | T2 instructions through section 5; planning appendix omitted                                                                                                                                                         |
| `agents/drug-db-maintainer.md`                                | Sections 0, 1, 4, 8, 9 and 11, plus section 6's complete "How many references a fact needs" rule; environment-provisioning paragraph omitted                                                                         |
| `agents/peer-verification-protocol.md`                        | Review contract, scientific/payload checks, acquisition duties, independence, verdict/logging and failure rules; self-review, own-dispute resolution, broader architecture and unified dispute-feed sections omitted |
| `agents/fulltext-acquisition.md`                              | Complete acquisition checklist                                                                                                                                                                                       |
| `agents/kinectics_science_paper_review_agent_instructions.md` | Complete scientific appraisal methodology and source hierarchy                                                                                                                                                       |

References to private setup, adjudication, evaluator and cost rationale are
replaced by contextual labels; their targets are never published. T2 scope
overrides producer-action references in the shared rules. Scientific appraisal,
source hierarchy, full-text acquisition, fact-support, peer independence,
logging and final-output guidance remain available inside the five-item bundle.
No T3 instructions or authority are granted. A new unreviewed `agents/` or
`docs/` Markdown reference fails the build instead of expanding publication.
Tests require the complete appraisal/checklist, Method, hard rules and logging
sections to survive projection. No setup, admin, deployment, architecture,
planning, audit, credential or source-code files are served by this feature.

The response has `format: "kinetix-agent-instructions"`, `schemaVersion: 1`,
`revision`, optional-value `sourceCommit`, and `documents`. Every document has
only `path`, UTF-8 `byteLength`, `sha256` and complete `content`. Validate the
exact five paths with no duplicates, every byte length and SHA-256, and the
revision: SHA-256 of `JSON.stringify(documents.map(d => [d.path,d.sha256]))`.
Require the documented order and lowercase hexadecimal hashes. Decode UTF-8
strictly and read every complete content string. HTTPS provides transport
authentication; hashes detect truncation/mixing, not a compromised publisher.

The canonical Markdown stays the single source of truth. A release regenerates
the projection; `Cache-Control: no-store` avoids retaining an old response.
Freshness means the currently **deployed release**, not unreleased `main`.
The single response avoids mixing files across releases. There are no path,
query or revision selectors, directory listings, or runtime filesystem reads.
The reserved instruction namespace is excluded from the SPA fallback.

**Keep the working GitHub-based interim Sol schedule active until this asset is
live and verified.** That interim resolves authenticated GitHub `main` once per
run and fetches complete required guidance from that one commit; it is not a
fallback after public cutover. Do not switch the live prompt to a missing
endpoint or pause it merely because publication is awaiting release. Production
release is human-run under root `AGENTS.md`; agents must not dispatch the
production workflow. After a human releases the change, verify a fresh anonymous
HTTPS fetch, all bundle checks and the public content boundary, then install the
prepared public-source prompt. Preserve model, cadence, status and notification
settings. This public-source cutover is for the reviewer only; T1 and T3 keep
the commit-pinned GitHub procedure above.

After cutover, failure of fetch, schema, integrity or a required dependency
stops that cycle with a clear failure report. Never fall back to GitHub, local
Markdown, an old snapshot or an earlier run. Do not execute downloaded code.

## Acquisition tooling dependency

The separate full-text runtime must be installed and checked before acquisition
work: `node scripts/kinetix-fulltext.mjs check`. Its credential-free commands are
`discover <PMID>` for identity metadata and candidate routes, and
`pmc <PMCID> --pmid <PMID>` for bounded independent PMC acquisition. These
commands never load worker profiles or call the Kinetix API. They are installed
tooling, not executable content obtained from the public instruction bundle.
Use the profile-aware `pdf` command above for stored Kinetix PDFs first.

Missing tooling, a sandbox network denial, or a missing PDF extractor is an
environment failure, not evidence that a scientific source is inaccessible.
Follow the normal narrowly scoped network approval path where available; if it
remains unavailable, stop the affected lane and report it. Do not manufacture an
access-based abstention/PDF request from that failure. Successful acquisition is
not a `readInFull` attestation: read the complete article and necessary figures,
tables and supplements before reviewing it. Preserve the canonical checklist.

Token rotation: pause only the affected worker, mint a replacement through
Admin → Agents → Tokens, replace only its private profile, run `check`, revoke
the old token, and resume. Preserve the other worker's profile and shared `.env`.
An expired/revoked token stops at the read-only identity check.

## Verification

`npx vitest run tests/kinetix-worker.test.ts` exercises actual Bash and TypeScript
helpers against a fake transport: inherited/shared-token override, concurrent
identities, missing/invalid profiles, identity mismatch, dry runs, secret
redaction, duplicate profile identities, binary stored PDFs and suppression of direct database credentials. No scientific data
or verification-log rows are written by this test.
