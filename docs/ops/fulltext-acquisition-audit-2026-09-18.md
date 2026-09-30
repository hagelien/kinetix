# Scheduled maintainer full-text failures: investigation and repair

Date: 2026-09-18. Scope: Codex's local Kinetix maintenance routine, not a scientific
re-review of the papers and not an assessment of Claude's undocumented tool use.
No production verdicts, paper reviews or PDF requests were changed in this audit.

## Finding

**The routine confuses failure of a retrieval channel with absence of accessible
full text.** It has a source hierarchy in prose, but no consistent executable
fallback or per-source acquisition receipt. The observed failure is not explained
by a general inability of Codex to read open papers: the same runner can download
complete article bodies through independent official channels, and has done so
successfully in scheduled runs. The UTF-8 transport fix (PR 1222) addresses corrupt
Norwegian characters, not this acquisition defect.

## Audit method and limits

Read the automation configuration and recent memory as an index, then checked the
actual JSONL tool calls **and their matching outputs**, not the agent's prose alone.
Selected local session files dated September 16–18 through the run starting
September 18 at 07:11 Oslo time, with `session_meta.thread_source=automation` and
the Kinetix checkout as `cwd`. This yielded **36 session logs**, of which **29**
contain actual `tools.web__run(...)` calls. **23** contain at least one returned
`Checking your browser` / `reCAPTCHA` response (**33 call responses** in total).
These are session/call counts, **not** counts of unavailable papers or failed
cycles: requests can be batched, runs can be delayed/resumed, and other work in
the same cycle may succeed. Seven sessions had no such web call and are not
classified as full-text failures. Safety-review subthreads and copied instructions
were excluded by metadata; searches counted calls, not mentions in summaries.

Only two selected sessions contained an actual `fullTextXML` attempt (September 16
08:36 and September 18 02:10). Other alternatives, e.g. journal pages and Europe PMC's
web frontend, were sometimes tried; **this is not a claim that no alternative was
ever used**. Manual case review below checks the exact source and outcome. The
earlier September 9–15 audit found eight CAPTCHA-bearing sessions; the new counts
are a separate window, not cumulative.

Local provenance: files are under the operator's Codex `sessions/2026/09/<day>/`
directory, named `rollout-<local-start>-<session-id>.jsonl`. Source logs remain local;
no raw logs, tokens, user prompts or full copyrighted papers are committed here.
Times below refer to executed calls in Europe/Oslo (UTC+02), not always the filename
start time. Availability was re-tested on September 18; success now is not proof
that an untried route would have worked at the historical instant.

## Traceable cases

| Actual run/calls | Source and recorded outcome | What the trace establishes |
|---|---|---|
| Sep 15 09:20; session `01a0a3e7-9750-7a41-811c-d8eebe364dec` | PMID 21346758 / PMC3584707, citation 3343; pending edit 1197; PDF request 521; abstain 5881 | One batched PMC web open returned CAPTCHA at 09:20:05. PDF requests followed at 09:20:17, abstentions at 09:20:33. No stored-PDF check for this citation or direct/structured fallback appears before the verdict. The earlier citation-6 PDF check was for another paper. |
| Same Sep 15 batch | PMID 42484800 / PMC13391657, citation 3252; paper review 353; PDF request 520; abstain 5880 | Same early termination after the web challenge. The September 15 investigation fetched a real XML body (not merely an abstract) with three tables from Europe PMC. |
| Sep 17 18:18–18:19; session `01a0b022-888d-7d60-989c-539cfaa89e5e` | PMID 36942277 / PMC10023552, citation 750; paper review 374; PDF request 605 | PMC web open at 18:18:05; stored-PDF extractor returned HTTP 404 at 18:18:17; request at 18:19:04; abstain at 18:19:27. No direct PMC/structured XML attempt. Three other abstentions in that batch were broad historical wiki edits, **not** evidence that these three sources were unavailable. |
| Sep 17 19:20–19:22; session `01a0b059-7ad8-7442-88a5-8b3b7ddc1be2` | PMC6270744 and PMC9282245 opened together; paper review 377/citation 54 subsequently abstained, request 608 | Rationale explicitly attributes failure to PMC's barrier page. No structured fallback was called. The claim that a stored PDF was absent is not supported by a citation-54 PDF GET in this trace; the citation-6 GET does not establish that. |
| Sep 17 21:17–21:18; session `01a0b0c6-ea7b-7560-9eea-fb9f3e22fef5` | PMC5572767, PMC6962077, PMC5937443; requests 612–614 for citations 195, 980, 3273; several abstentions | Tried PMC plus Europe PMC **web pages**, and checked the three stored PDFs (404). No direct XML call. Better than a single attempt, but both frontend readers are not the structured full-text API. Two other verdicts cite Jantos/request 35 and must not be counted as failures for these PMC papers. |
| Sep 18 02:16; session `01a0b1da-1b12-7670-b9c1-66603326671c` | PMID 41987915 / PMC13078734; successful peer check | Positive control: web PMC challenge at 02:16:22; web XML open at 02:16:27 said “not accessible via this tool”; **direct curl** of the same official XML URL at 02:16:52 downloaded 87,758 bytes. A tool-specific failure plainly did not mean the source was unavailable. |
| Sep 18 05:16; session `01a0b27e-7ed1-7d30-addc-d2435dd3204d` | Paper reviews 288 and 396; citations 443 and 212; requests 624/625 | Stored PDFs returned 404; request and abstention followed. The explicit requests do not document article-specific alternate acquisition attempts. Do not infer a paywall merely from the missing stored PDFs. |

## Independent public retrieval checks, September 18

Used ordinary credential-free Node HTTPS requests on this Windows runner. Checked
HTTP status, article identity, actual body, and tables; did **not** attest to a
scientific full read or approve any live claim.

| PMCID | Direct PMC HTML | Europe PMC `fullTextXML` |
|---|---|---|
| PMC3584707 (original alfentanil example) | Article, 211,893 characters; 2 tables | HTTP 500 on this retest (404 in the earlier investigation) |
| PMC10023552 | Article, 296,129 characters; 1 table | Article XML, 201,148 characters; body + 1 table |
| PMC9282245 | HTTP 200 **CAPTCHA**, 21,303 characters | Article XML, 133,353 characters; body + 6 tables |
| PMC5937443 | HTTP 200 **CAPTCHA**, 21,304 characters | Article XML, 88,073 characters; body + 2 tables |
| PMC13078734 | HTTP 200 **CAPTCHA**, 21,309 characters | Article XML, 87,570 characters; body + 2 tables |

Counts above are decoded string lengths, not byte sizes, and responses change over
time. Notably, a >20 KB HTTP-200 HTML response can still contain **no article**.
Links: [original manuscript](https://pmc.ncbi.nlm.nih.gov/articles/PMC3584707/),
[valproate XML](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC10023552/fullTextXML),
[postmortem matrices XML](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC9282245/fullTextXML),
[morphine XML](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC5937443/fullTextXML),
[isotonitazene XML](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC13078734/fullTextXML).

## Causes and contributing conditions

1. **Reader-level barriers are generalized to source-level unavailability.** A cached
   challenge page or web tool's unsupported XML response ends work even when another
   ordinary official channel works. Native retrieval must be independent of the web
   reader, not another open of its cached URL.
2. **No per-citation acquisition receipt.** One source's PDF 404 is sometimes treated
   as evidence about another source, and generic “unavailable in this runner” prose
   hides which steps were skipped. Repeated requests do not prove repeated searches.
3. **Free-to-read is not identical to API-reusable OA.** Europe PMC XML covers its OA
   subset; PMC author manuscripts can be readable as HTML without that XML endpoint
   succeeding. A single XML-only fix would still miss the original alfentanil case.
   See [Europe PMC API](https://europepmc.org/RestfulWebService),
   [content/access help](https://europepmc.org/help), and
   [PMC identity crosswalk](https://pmc.ncbi.nlm.nih.gov/tools/id-converter-api/).
4. **The existing MCP is not an equivalent quantitative full-text reader.**
   `api/_lib/pubmed-eutils.ts` deliberately removes tables, figures and formulae in
   `jatsToText`. Installing/using it alone would lose table-only Tmax data. Its
   front-matter rejection is correct and should not be relaxed.
5. **Runner and acquisition failures are conflated.** Bash/WSL path problems, missing
   PDF extraction tools, sandbox/network restrictions, a missing stored PDF, and an
   actual publisher access restriction need different remedies. The new public CLI
   avoids Bash entirely; it does not change authenticated API helpers or permissions.
6. **Repeated selection amplifies the visible noise.** Citation 6 / PMID 21805908 /
   PDF request 35 repeatedly appears in the paper-review lane. Some runs search for
   it again, others only recheck storage. This audit did not establish an available
   full text for it; do not label all its skips false. Queue cooldown/selection is a
   separate policy change and is not silently included in this retrieval repair.
7. **The scheduled checkout is stale.** The automation configuration points to the
   long-lived local checkout, which at audit time was on
   `codex/scaling-daily-2026-07-08`, HEAD at a September 5 commit, with **31 commits
   on current main not in that HEAD** and local edits. Main's maintainer prompt,
   review methodology and API helper differ from that checkout. This does not
   establish why any particular source failed, but it explains why a merged fix
   need not reach subsequent Codex runs. The documented Claude remote setup clones
   the default branch afresh; its actual current deployment was not inspected.

Claude's exact access route is not in these Codex logs. Different tools and the
documented native PDF path are plausible contributors, not a verified model-level
explanation. The successful Codex direct-XML run is stronger evidence than guesses
about either model's capabilities.

## Implemented remedy

`scripts/fetch-pmc-full-text.ts` invokes a bounded, tested sequence: Europe PMC XML
→ direct PMC HTML → NCBI EFetch XML. It checks identifier and substantive body,
rejects challenge/front-matter responses, retains raw source and table-aware text,
flags visual inspection, and writes a unique local receipt listing attempts and a
source hash. No credentials, arbitrary URL fetches, database writes, automatic
approvals, full-read attestations or CAPTCHA bypasses are introduced.

The maintainer, scientific review spec and peer-verification protocol all route to
`agents/fulltext-acquisition.md`: check **this citation's** stored PDF, use the
bounded helper for a known PMCID, then legitimate publisher/repository alternatives
if still unresolved. Before abstaining, state exactly what failed. A candidate still
needs a complete independent read; a time-limited unread paper is not unavailable.

Regression tests cover both observed success paths, alternate-channel failures,
identity mismatch, challenge HTTP 200, XML stubs, abstract-only HTML, short real
corrections, table values/footnotes/Unicode, visual markers, request limits,
credential-free redirects, and all three instruction entry points.

## Rollout and acceptance

### Validation performed

- New acquisition regression suite: **22/22 passed**.
- CLI live smoke tests: PMC3584707 / PMID 21346758 used HTML after XML HTTP 500;
  PMC9282245 / PMID 34115841 and PMC10023552 / PMID 36942277 used XML. All returned
  identity-checked candidates, preserved tables, saved receipts, and kept
  `readInFull: false`. The rendered alfentanil Table 2 retained both `1.0±0.8` and
  `1.4±0.4` Tmax rows with units and footnotes. This is extraction QA, not re-review.
- `npm run typecheck`, `npm run lint`, and `git diff --check`: passed.
- Full `npx vitest run --maxWorkers=4`: **5,520 passed / 12 failed**, 424 files.
  Seven failures were reproduced on a clean detached baseline of main with
  identical dependencies: two source-quote parsing assertions in
  `src/lib/deepResearchImport.test.ts`, four Windows path-separator assertions in
  `tests/vitest-env-split.test.ts` / `tests/parameter-write-guards.test.ts`, and the
  PowerShell BOM assertion in `tests/kinetix-api-transport.test.ts`. Five additional
  30-second timeouts occurred in untouched `src/lib/__tests__/modelingRun.test.ts`.
  A separate single-worker baseline run reproduced four of those timeouts; the
  remaining model-provenance case passed in that run (69 passed / 4 timed out).
  This establishes baseline timing failures, not that the full suite is green or
  that every timeout has an identical cause.
- `npm run typecheck:scripts`: fails on the same clean baseline and PR branch at
  `scripts/seed-pm-am-ratios.ts:60`, importing the no-longer-exported
  `markEntryMutationsConflicted`. No diagnostic points to the new helper.

The PR remains **draft**, not “all checks green”. These unrelated files were not
changed to make the acquisition PR appear clean.

### Activation

Merge the reviewed PR and make its files available in the **actual local checkout
used by the scheduled routine**. This routine runs locally in a long-lived checkout;
merging main or deploying the web app does not update that checkout automatically.
Do not reset/overwrite its unrelated working changes. No production deploy, database
migration or schedule/model change is required. Ensure the existing npm dependencies
are installed before the next scheduled run; no install is performed by the helper.

Acceptance is a future scheduled run that logs the per-source attempt receipt,
reads a recovered article including decisive tables, and bases its verdict on that
reading. A unit-test pass or one successful download is not that acceptance test.
No old abstention is mass-replaced: each needs a fresh independent read and current
target version. The helper is a PMC-specific acquisition bridge, not a universal
publisher downloader or an API-enforced requirement for every external agent.
