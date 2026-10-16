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

## Repository checks

- `git diff --check`: passed.
- `npm run lint`: passed.
- `npm run typecheck`: failed with 14 errors involving `assurance-core` types.
  The existing dependency installation reports version 0.3.0 while this
  revision's lockfile requires 0.5.0. Application and dependency files are
  unchanged by this documentation repair.
- `npx vitest run`: 523 files passed, 10 failed; 7,096 tests passed, 15 failed,
  plus one suite failed to load. Failures include Windows separator and CRLF
  assumptions, shell-dependent worker tests and a worker-suite syntax error.
  These checks are not green; the documentation PR must remain a draft.

The live automation edits are installed locally. A Git push publishes this
procedure and audit only; it does not synchronize Codex automation settings to
another device or merge the procedure into main.
