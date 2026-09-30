# Full-text failures after the first fix: runtime activation audit

Date: 2026-09-21. Scope: read-only investigation of recent local Kinetix scheduled
runs, matched citation histories, public acquisition replays, and a narrowly scoped
runtime fix. This is an internal audit, **not** a public runtime instruction.
Do not add it, session traces, profiles or helper source code to the public
instruction allowlist. No scientific review, verdict, source value, PDF request,
role, quorum or production deployment was changed by this investigation.

## Findings in brief

1. **The earlier fix was merged but not installed where the workers run.**
   PR 1265 merged on September 18. On September 21 the local scheduled
   checkout was still an old commit on `codex/scaling-daily-2026-07-08`, 62 commits
   behind the fetched main tip. Both `scripts/fetch-pmc-full-text.ts`
   and `agents/fulltext-acquisition.md` were absent. The checkout also held
   unrelated staged edits, so resetting or switching it was not a safe update.
2. **The same stopping error persists in actual tool traces.** Some runs treat
   a web reader's challenge/error plus a missing stored PDF as exhaustion of
   legitimate sources. Others search snippets without opening the article before
   making a stronger unavailable-source claim. This is not a uniform inability
   to read: the same worker successfully retrieved another article by direct HTML.
3. **PMC-only acquisition does not cover every free article.** The recent
   dehydronorketamine case has no PMCID, but exact-PMID metadata lists a free
   publisher PDF. `inPMC=N` and `isOpenAccess=N` must not discard that route.
   The publisher returned 403 through the web reader during this audit; this
   remains a route-specific blocker, not a demonstrated paywall or solved access.
4. **Claude's assertion is not independent proof of complete reading.** The
   database identifies Claude-authored reviews for the same papers, but no local
   Claude retrieval trace was found in the scoped project-session inventory.
   One review itself says quantitative table/figure details were missing. We can
   demonstrate Codex's omitted attempts, not infer a model-intrinsic capability
   difference or certify Claude's reading from `readInFull=true` alone.

## Sampling and reproducibility

Examined all 17 available local JSONL sessions in the September 20 and 21 day
directories whose session metadata identifies `thread_source=automation` and
`cwd=C:\Users\max\github\kinetix`, through the 19:40 September 21 run. Local time
is Europe/Oslo (UTC+02). The earliest run is September 20 00:11 local, September 19
22:11 UTC. This is a census of the **available local files**, not an assertion
that no other remote/missing runs occurred.

Count only actual `response_item` function/custom-tool calls and corresponding
outputs joined by `call_id`. Do not count copied prompts, analysis, memory text,
user attachments or strings repeated inside later summaries as attempted requests.
The web-output indicator below matches `Checking your browser`, `reCAPTCHA`, or
`not accessible via this tool` in outputs of actual `await tools.web__run(...)` calls.

| Observation | Count | Meaning / limit |
| --- | ---: | --- |
| Local scheduled sessions | 17 | All session metadata records the same old checkout |
| Sessions with actual web calls | 15 | Two stopped before web research |
| Sessions with one or more challenge/tool-access-error outputs | 11 | **Not** 11 inaccessible articles or failed cycles |
| Such web response blocks | 26 | A block may contain multiple URLs; repeated attempts are not independent articles |
| Invocations of `fetch-pmc-full-text.ts` | 0 | No scheduled run used the merged helper |

Inventory (full identifiers permit exact local trace lookup without publishing raw
session contents):

```text
September 20 local start | session id
00:11 | 01a0bbb9-c7e7-7792-b542-0c791c1f6f57
01:10 | 01a0bbef-cd7b-7e92-b457-317fb5a68e56
02:10 | 01a0bc26-bfae-7321-b263-6a29e01c82b3
03:10 | 01a0bc5d-3c55-7661-9654-f3669a832705
04:10 | 01a0bc94-a3d5-7b12-bdd1-6fd11b5c5396
05:10 | 01a0bccb-207b-78f2-aa9a-6077a4d65ecb
06:11 | 01a0bd03-728b-77a2-8f30-53d7aad1ffd5
07:11 | 01a0bd3a-64ca-7da3-a844-a617e84cad8b
08:11 | 01a0bd70-e1c1-7823-a18d-2a4d121097ac
09:10 | 01a0bda6-e9a0-7821-bc2e-059b0a8b3145
10:10 | 01a0bdde-5106-71b2-968b-95da1eee283d
11:10 | 01a0be15-42f0-7150-8730-612730dc4e10
12:12 | 01a0be4d-1f2d-73f1-a03a-5d44c0629b4b
13:11 | 01a0be83-9c01-7953-b5ac-137629873c9f
September 21 local start | session id
18:32 | 01a0c4cf-c17f-7700-830b-1cccf7f8931b
19:11 | 01a0c4f3-cd51-77e2-baf0-926a61150b4d
19:40 | 01a0c50e-5a82-7960-b056-782d473f7d1c
```

## Matched cases: what actually happened

### A. September 20 07:11 — PMID 37670374 / PMC10478446 / citation 695

The review queue item was paper review 472. At 05:16:32 UTC,
`call_EDCrbUcw9LoWyYVWzXNP1Y7a` opened PMC10478446; its response was a three-line
reCAPTCHA page. `call_yJakV3PSkOsURnzeo7a5hKl5` invoked the stored-PDF extractor
for **695**, which returned curl HTTP 404. At 05:17:06,
`call_9zvDOZLNKkhWlQufyJIy1zVa` posted PDF request **727** and abstention **7070**
with the generic unavailable-full-text rationale. There was no native Europe PMC
XML or NCBI EFetch attempt for this article.

Current read-only citation metadata confirms PMID 37670374 and the Wang et al.
2023 paper. Claude-authored review revision **444**, September 3, records
`readInFull=true`, but its prose explicitly qualifies missing table/figure values.
That is a comparison of recorded claims, not a Claude transport trace.

**Replay:** the no-secret runner downloaded identity-matched Europe PMC XML on
September 21: 150,392 characters, four tables, five figures, twelve formula markers,
one supplement marker; SHA-256
`a296c7915b917f5bbf3ad60a61b35cfe6f79d455939da5a242da7ecf13285caa`.
This is a demonstrated missed acquisition channel in a recent failure. The
candidate still requires reading and original visual/supplement inspection.

### B. September 21 18:32 — PMID 32838982 / citation 3347 / pending edit 1273

Claude-authored review revision **645**, September 20 18:49:29 UTC, claims a
complete read of Kamp et al. (2020). The exact DOI is
`10.1016/j.bja.2020.06.067`. Codex's next-day trace contains two search calls:
`call_an8GVknotQ3BpUSklE88b9Y3` (PMID/title/value search) and the follow-up search
for the numeric clearance. It then files/refreshes request **531** and abstains on
**1273** in the batch of verdicts 7363–7365. The submitted rationale claims no
full text was available from lawful sources. No exact-citation stored-PDF GET,
publisher full-text open, or repository download appears before that assertion.

Current checks through the selected-profile worker found no stored PDF for 3347.
[PubMed](https://pubmed.ncbi.nlm.nih.gov/32838982/) identifies it as a free article.
Europe PMC exact-PMID metadata returns **no PMCID**, `inPMC=N`, `isOpenAccess=N`,
yet lists `http://www.bjanaesthesia.org/article/S0007091220305717/pdf` as **Free**.
The new discovery helper preserves this route rather than filtering it out.

**Limit:** current BJA full-text and ScienceDirect opens returned 403 through the
web reader; the PDF open failed; the Erasmus institutional record only linked the
DOI. We have not obtained this article's complete body or validated the proposed
clearance. The demonstrated bug is premature exhaustion and overbroad reporting,
not proof that the publisher will serve every runner. No verdict was rewritten.

### C. Positive control — PMID 41133403 / PMC12893244 / citation 3418

In that same September 21 18:32 run, `call_gunxT3TjKyA3IACar7PlLFWO` got
“not accessible via this tool” for Europe PMC fullTextXML. The run then downloaded
PMC HTML with curl and read text in several chunks. This disproves the stronger
claim that the environment categorically cannot retrieve full text. It does not
by itself establish that all figures/supplements were independently assessed.

**Replay:** the bounded reader obtained XML directly (84,504 characters, two
tables, four figures, two supplement markers). The XML endpoint itself worked;
the web-reader error did not describe the underlying endpoint's availability.

### D. Unresolved control — PMID 11139459 / PMC1572517 / citation 3400

September 20 03:10 run searched/opened the M3G transport paper and abstained on
pending edit **1258**, creating request **722**. Current identity-checked replay
returned Europe PMC **500**, PMC HTML **200 challenge page**, and NCBI XML **200
without an article body**. Correct result: `unresolved`, `readInFull=false`.
This is deliberately retained as a failing acquisition control: no bypass,
abstract promotion or blanket “everything fixed” conclusion.

### E. Earlier controls replayed after the runtime change

| PMID / PMCID | Channel result on September 21 | Candidate structure |
| --- | --- | --- |
| 21346758 / PMC3584707 (original screenshot) | Europe PMC 500, then direct PMC HTML 200 | 211,893 characters, 2 tables |
| 34115841 / PMC9282245 | Europe PMC XML 200 | 133,353 characters, 6 tables |
| 36942277 / PMC10023552 | Europe PMC XML 200 | 201,148 characters, 1 table |

## Implemented remediation and boundaries

- `scripts/kinetix-fulltext.mjs`: fixed dispatch (`check`, `discover`, `pmc`),
  installed-file hashes and local dependency resolution; child environment
  allowlist; no profiles, no Kinetix API, no runtime installation, no arbitrary
  executable/URL dispatch. It is independent of Bash/WSL path translation.
- `scripts/fulltext/discovery.ts` + CLI: exact MED/PMID identity, bounded public
  metadata transport, PMCID/DOI and explicit publisher/repository leads, unique
  receipt. No external link is auto-fetched. Discovery is never acquisition.
- Runtime checklist: preflight before the affected lane; exact-citation stored
  PDF; actual article requests rather than search-only evidence; explicit
  distinction between local failure, channel blocking, material not yet read,
  and genuine source restrictions. Both helper modes always keep `readInFull=false`.
- Installation is a separate local operation, not a production deployment or a
  side effect of merge. Install only the five named helper source files and the
  acquisition checklist into the long-lived root after testing, preserving its
  branch/index and all existing worker/profile changes. Existing local Node,
  tsx and jsdom dependencies are reused; no packages need installation.
- The setup task owns the identity wrapper, Sol prompt and public instruction
  bundle. This task owns the no-secret runtime and the minimal Terra acquisition
  prompt addition. A public instruction release does not publish executable code
  or install it, and still requires the normal human production release.

## Verification and operational acceptance

Focused acquisition/discovery/runtime suite: **40 tests passed**. App typecheck,
lint and scripts typecheck passed on the isolated main-based worktree, using
existing local dependencies (Node 24.13.1, installed Vitest 4.1.8). No CI reruns
were requested; exhausted CI minutes are not evidence for or against this patch.
Broad local-suite and stable-runtime activation results follow.

### Completed local suite and clean-baseline comparison

`vitest run --maxWorkers=2`: **5,741 passed, 5 failed**, 443 test files,
226 seconds. Every failure reproduced on the untouched main tip in a separate
worktree with the same installed dependencies (`5 failed, 14 passed` in the three
affected files): one Windows emitted-JS path assertion in `vitest-env-split`,
three Windows slash/path assertions in `parameter-write-guards`, and one
PowerShell pipeline/BOM assertion in `kinetix-api-transport`. These are existing
baseline failures, not a green broad suite and not regressions attributed to this
patch. No CI rerun, dependency change or unrelated fix was made to hide them.

### Stable runtime and actual scheduled permissions

Installed the five source files and runtime checklist into
`C:\Users\max\github\kinetix`; **all six SHA-256 hashes matched** the reviewed
worktree byte-for-byte. No branch switch/reset/index modification was used.
The actual root's `check` resolved Node 24.13.1 and its existing tsx/jsdom. The
root's read-only replay acquired PMC10478446, PMC9282245 and PMC10023552. For the
original PMC3584707, the root replay exercised the third route: XML 500, HTML
challenge, then NCBI EFetch identity-matched XML (106,194 characters, two tables).
This variability is why a single channel cannot establish availability.

The interactive investigation's restricted sandbox returned `network_error` for
all three routes, while normal approved unsandboxed execution succeeded. That is
**not the effective scheduler policy**: the actual September 21 Terra and Sol
`turn_context` records both contain `approval_policy=never`,
`sandbox_policy.type=danger-full-access`, `permission_profile.type=disabled`, and
no escalated calls. The current local Codex config agrees. Thus the installed-root
unsandboxed read-only replays test the OS/network mode these workers actually use.
No global permission or approval setting was changed, and no sandbox was bypassed.
If a future scheduled runner has narrower network permissions, it must report the
environment failure and follow normal authorization, not call it a paywall.

The producer's saved prompt was minimally appended with the preflight, checklist
and standalone public commands, then re-read: the prompt matched exactly and its
schedule, model, effort, status, notification policy, cwd, environment config and
identity rules were preserved. The separate setup task owns Sol's prompt and the
binary-safe authenticated stored-PDF action; this runner never receives its token.

An additional natural producer run at 20:11 
started before this installation/prompt update and still made no helper calls.
Its permission record matched the two runs above. It is **not** a post-activation
acceptance run and is not folded into the earlier 17-session census.

### Stored-PDF integration follow-up

After the setup task installed both the profile wrapper's binary-safe `pdf`
action and its existing redirect-safe downloader in the stable root, a live
read-only call with the **reviewer** profile downloaded citation **824** to a
unique temporary path. The wrapper verified the `%PDF-` signature and reported
**328,359 bytes**, SHA-256
`181469b8190344dcd9ad1c7feb51eeecf89ebef5252bcaf97383328ae50e3139`.
The existing bundled `pypdf` successfully parsed all **nine pages**, each with
extractable text (**43,820 characters** total); the file was not encrypted.
No article content, credentials or signed storage URLs were printed. This closes
the previously pending binary-download/extraction integration check with issue 1320.
It is a transport/extraction test, not a scientific reading, visual-layout check
or `readInFull` attestation. No source record or verdict was changed.

Future natural scheduled runs must provide the final end-to-end acceptance:
preflight from the actual cwd, installed hashes, exact-citation stored status,
acquisition receipt, complete independent reading where possible, and truthful
route-specific failure reporting otherwise. No extra scientific maintenance cycle
was triggered to manufacture acceptance. The Norwegian-character report is
separate and is not claimed fixed by this acquisition work.
