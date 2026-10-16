# Standalone GitHub instruction fetch repair

Verified on 2026-10-16 for the installed **Kinetix T1**, **Kinetix T2** and
**Kinetix T3** Codex automations.

## Cause and repair

The Windows scheduler's existing permission rule allows standalone `gh api`
commands. The identical instruction request failed with `error connecting to
api.github.com` when embedded in a PowerShell loop or given shell redirection.
Plain requests succeeded using the existing GitHub authentication.

All three live prompts now require one plain `gh api` command per shell tool
call, capturing the complete response directly. Local decoding and temporary
file operations occur in separate calls without a network client. The shared
procedure and per-role starting documents are in
[local-codex-workers.md](../../agents/local-codex-workers.md#github-instruction-retrieval-for-t1-t2-and-t3).

T1 retains its clean-main, fetch, fast-forward-only and HEAD-equality refresh
gates. It now fetches its required guides from one freshly resolved GitHub
commit and requires that commit to match the refreshed checkout. T2 and T3
retain their commit-pinned retrieval and do not refresh the checkout.

All three saved prompts were read back and compared exactly with the intended
updates. Existing models, efforts, schedules, active states, notification
preferences, project and working directory were preserved. Profiles, pinned
identities, scientific gates, blindness and the one-cycle limits were not
changed. The paused legacy Sol reviewer was not modified.

## Transport and integrity verification

Standalone commit resolution returned
`f7d568090b177c215fd0db978fba024aa54ee703`. Every document below was acquired
from that same commit, with complete JSON stdout, strict UTF-8 decoding,
decoded byte count equal to GitHub's `size`, and a matching Git blob SHA-1
computed over `blob <byteLength>\0` plus the original decoded bytes.

| Document under `agents/` | Decoded bytes |
| --- | ---: |
| `local-codex-workers.md` | 14,599 |
| `drug-db-maintainer.md` | 165,779 |
| `drug-db-escalation.md` | 13,662 |
| `peer-verification-protocol.md` | 42,974 |
| `fulltext-acquisition.md` | 12,340 |
| `drug-db-adjudication.md` | 14,492 |
| `kinectics_science_paper_review_agent_instructions.md` | 28,731 |

The local-worker guide's size describes the tested main revision, before this
documentation change. No new network permission, credential provisioning,
Kinetix API write, scientific cycle or production deployment was performed.
Transport verification does not establish that a source was read in full or
that an entire scientific cycle completed.

## Initial repository checks

- `git diff --check`: passed.
- `npm run lint`: passed.
- `npm run typecheck`: failed with 14 errors involving `assurance-core` types.
  The existing dependency installation reports version 0.3.0 while this
  revision's lockfile requires 0.5.0. Application and dependency files are
  unchanged by this documentation repair.
- `npx vitest run`: 523 files passed, 10 failed; 7,096 tests passed, 15 failed,
  plus one suite failed to load. Failures include Windows separator and CRLF
  assumptions, shell-dependent worker tests and a worker-suite syntax error.
  The PR was initially left in draft because these checks were not green.

## Follow-up repairs and final verification

The follow-up request also covered signing, dependencies and the Windows
failures. Those repairs now pass verification:

- Replaced the missing signing-key reference with the existing local SSH key
  in repository-local Git configuration. Signing remains enabled. A signed
  test commit passed ordinary `git verify-commit` using a repository-local
  public-key trust file outside the checkout. Global Git configuration and
  GitHub account keys were not changed; local verification does not imply a
  GitHub verified-signature badge.
- Installed the exact lockfile in the isolated worktree with `npm ci`;
  `assurance-core` now resolves to 0.5.0. No dependency versions or lockfile
  entries were changed.
- The scheduler's old main (`25723dc1e4aaff54beac75b5c577d2686b9d6da1`)
  had no merge base with origin/main. A fast-forward attempt stopped safely.
  Preserved that original main as
  `codex/scheduler-main-before-refresh-20261016`, then created main from
  origin/main at the tested revision above. No reset, forced update or
  discarded files; all four unrelated untracked directories remained.
  `npm ci` installed the matching dependencies in that stable checkout too.
- Read-only producer, reviewer and adjudicator-b wrapper checks all returned
  `identityVerified: true` from the refreshed scheduler directory. The
  credential-free full-text preflight returned `status: ready`.
- Canonicalize discovered source paths to forward slashes; normalize CRLF
  when testing Markdown contracts; compare marker-directory paths using the
  host's path rules. The guards and assertions remain in force.
- Keep shell and MJS sources LF on checkout. Remove the worker's redundant
  hashbang (the documented entrypoint uses `node`), which Vite had moved
  behind its generated import bindings and made syntactically invalid.
- Test and document a UTF-8/no-BOM file for legacy Windows PowerShell:
  its string pipeline was measured emitting a BOM even with a zero-preamble
  output encoding. The HTTP regression checks the exact request bytes.
- Select Git Bash and a native PATH delimiter in the credit-runner fixture.
  Parse CLI result JSON with the already-required Node runtime, removing its
  dependency on an uninstalled `jq` binary. Budget and failure-limit tests pass.

Final checks:

- `git diff --check`: passed.
- `npm run typecheck`: passed.
- `npm run typecheck:scripts`: passed.
- `npm run lint`: passed.
- `npx vitest run --maxWorkers=4`: **533 files, 7,128 tests passed**. An
  earlier unrestricted run passed 7,127 tests with one repository-wide scan
  timing out under filesystem load. Lower concurrency passed the complete
  unchanged test set; no tests or assertions were skipped.

The live automation and local setup repairs are installed on this machine.
The Git push publishes the shared procedure, compatibility changes and audit;
it does not synchronize scheduler settings to another device or merge into
main. No scientific cycle, Kinetix data write or production deploy was run.
