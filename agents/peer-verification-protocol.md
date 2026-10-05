# Peer-Verification Protocol — agent-to-agent quality review

Every scheduled or hook-triggered Kinetix agent peer-verifies the queue's
output through a single shared mechanism (PR 575) — other agents' work, and
(for pending edits) human contributors' proposals too. This document is the
canonical description of that mechanism; every agent prompt references it
instead of restating it.

Two properties define the protocol:

1. **It is independent.** When you fetch a target to verify, the API
   deliberately omits other agents' verdicts and approval counts. You form
   your judgment from the proposed change + the cited references + your own
   sources. The protocol works only if every agent honors that independence
   — if you look up other verdicts before judging, you create an echo
   chamber and the signal collapses.
2. **It is symmetric.** Every contributor agent is both a submitter and a
   verifier. The same agent that submitted a parameter edit five minutes ago
   may, on the next cycle, see another agent's wiki fact in its queue and
   need to judge it. There is no dedicated "verifier" role.

The audience is **any active agent** (`agents.status='active'`). All current
agents — `kinetix-agent`, `reflink-agent`, the paper-review agent, the
hook-triggered evaluator — participate.

---

## What gets verified

Five target types, all keyed `(target_type, target_id)`:

| `target_type`              | What it is                                    |
| -------------------------- | --------------------------------------------- |
| `drug_parameter_revision`  | An approved parameter edit (live on the drug) |
| `wiki_revision`            | An approved monograph edit (live on the page) |
| `paper_review`             | A live (auto-published) paper review          |
| `drug_discussion`          | A discussion comment                          |
| `pending_edit`             | A pending edit still in the moderator queue   |

`pending_edit` is the most consequential target type — verdicts on those
re-rank `/review` *and* can apply the edit outright: two independent
approvals with no open dispute auto-apply it (see "Consensus
auto-approval" below), and a well-reasoned dispute flags a bad edit *before*
it ships.

**Human submissions are verified too.** The `pending_edit` queue does not
filter by who submitted the edit: a proposal from a human contributor lands in
your queue exactly like a peer agent's. Judge it on the same merits and post
the same verdicts — an approve corroborates it for the moderator, a dispute
holds it. What differs is only what your verdict can *do*: an edit a human
submitted is never auto-applied by consensus, however many agents approve it
(see "Consensus auto-approval"). Publishing a person's change stays a human
moderator's call; your job on it is evidence, not authority. This asymmetry is
enforced server-side, so you do not have to special-case it — verify
everything the queue hands you.

The same line holds on the moderator path: if your account carries an editor
role, do **not** approve, reject, or return a human contributor's pending edit
through `PATCH /api/pending-edits` (the server answers
`403 agent_moderation_of_human_edit_not_allowed`). Post a verdict and, when it
matters, a discussion comment. Moderating other *agents'* edits is unchanged.

---

## Endpoints

### `GET /api/agent-verifications-queue` — discovery

Returns up to `limit` work items (default 20, max 100) the agent has not yet
verified and did not author. Each item carries the **target payload** you
need to form a judgment — for parameters, old + new value and references;
for wiki revisions, the new content plus the previous revision; for paper
reviews, the citation metadata, the review markdown, and `readInFull` plus a
computed `readInFullUnverified` flag (see below); for pending edits,
the proposed value, anchor columns (sectionId/factOperation/factTargetAnchor
for wiki_fact/wiki_section), the relevant drug or page baseline, and the
target's existing `currentValue` / `currentContent` to diff against.

**`readInFullUnverified` on paper reviews.** This boolean is `true` when the
review attests `readInFull` but the citation still has an open PDF request and
no stored full-text PDF — i.e. an agent earlier declared the full text
unavailable and none was ever supplied, so the attestation may have been made
from the abstract alone. It is a scrutiny signal, not a verdict: a reviewer
*can* legitimately have used a freely available full text (which leaves no
stored PDF). When it is set, read the review for tell-tale signs it relied only
on the abstract (no comment on tables/figures/methods/supplements) and lean
toward `dispute` if the depth does not match a full read.

The response **never includes** other agents' verdicts or approval counts.

Query parameters:

| param            | default | notes                                                     |
| ---------------- | ------- | --------------------------------------------------------- |
| `targetType`     | all     | one of the five target types; omit to interleave all      |
| `limit`          | 20      | cap 100                                                   |
| `minAgeMinutes`  | 5       | gives the submitter's implicit-approve row time to land   |
| `revisit`        | —       | `abstained` only: the recovery pass below                 |
| `abstainedBefore`| —       | required with `revisit`; ISO timestamp, not in the future |

When you omit `targetType`, the interleaved batch **reserves up to half its
slots for `pending_edit`** before backfilling the rest oldest-first. Without
that reserve the months-deep oldest-first backlog of revision/discussion
re-ranks crowded pending edits out of every small batch, so the consensus
apply-path never fired. You therefore get pending edits to judge on a plain
`limit=N` pull — no need to request `?targetType=pending_edit` separately. The
reserve is capped by how many pending edits are actually waiting, so once the
backlog drains the batch fills with the other types again.

Example via the shared helper:

```bash
scripts/kinetix-api.sh GET '/api/agent-verifications-queue?limit=10'
```

The response shape is `{ items: [{ targetType, targetId, targetVersion, createdAt, authorUserId, payload }], agent: { id, slug } }`.

Hold onto `targetVersion` per item — you must pass it back when posting a
verdict (next section).

### `POST /api/agent-verifications` — submit a verdict

```json
{
  "targetType": "drug_parameter_revision",
  "targetId": 1234,
  "targetVersion": "2026-06-02T10:00:00.000Z",
  "verdict": "dispute",
  "disputedClaim": "Elimination half-life 8 h (Karch 2008)",
  "rationaleMd": "Karch (2008) Table 3.2 gives 12–16h, not 8h as proposed. Two other primary sources (PMID 1234567, PMID 7654321) concur with the 12–16h range.",
  "evidenceRefs": [
    { "citationId": 9876, "quote": "Mean half-life 14.2h (range 12–16)" },
    { "citationId": 5544 }
  ],
  "model": "claude-opus-4-7"
}
```

Validation:

- `verdict` ∈ `approve | dispute | abstain`.
- `rationaleMd` is required (≥20 chars) for `dispute` and `abstain`; for
  explicit `approve` it's optional but recommended when the call was close. It
  is reader-facing: written in Norwegian (bokmål), spelled with `æ`, `ø` and
  `å` rather than `ae`/`oe`/`aa` or `a`/`o`/`a`, and displayed verbatim on the
  review card. See `agents/drug-db-maintainer.md` §1, "Norwegian orthography".
- `disputedClaim` is **required on `dispute`** (and rejected on any other
  verdict): the passage of the target you say is wrong, copied **verbatim**
  (≥12 chars — a bare number like `"8.17"` is not enough; quote the sentence it
  sits in, or for a structured field quote it with its field name, e.g.
  `"newValue: 8.17"`). The server checks the quote occurs in the target
  (case, whitespace and typographic quotes/dashes are ignored) and refuses the
  verdict with `agent_verification_disputed_claim_not_found` if it does not.
  The quote is stored at the head of your rationale so the moderator sees
  exactly what is contested. See "Quote the claim you dispute" below.
- `evidenceRefs[].citationId` must resolve to a real citation row.
- `targetVersion` must match what the queue returned. If the target's
  content changed in the meantime (submitter rewrote it, reviewer returned
  it, moderator approved/rejected it), you get a 409
  `agent_verification_target_version_stale` — refetch the queue and judge
  the new version.

Failure shape:
- `404 agent_verification_target_not_found` — target gone or not visible to
  the agent (see "What you cannot verify" below).
- `403 agent_verification_self_not_allowed` — the target's `createdBy` is
  the calling agent's user. You can't verify your own work; the
  implicit-approve row already speaks for you.
- `409 agent_verification_target_version_stale` — version mismatch, see
  above.
- `400 agent_verification_unknown_citation` — one of the `citationId`s in
  `evidenceRefs` does not resolve.

### `GET /api/agent-verifications` — read past verdicts

For inspecting an agent's own history or auditing — **never** call this on
a target you are about to verify. The queue is the only endpoint you fetch
to form a judgment.

```bash
scripts/kinetix-api.sh GET \
  '/api/agent-verifications?targetType=drug_parameter_revision&targetId=1234'
```

---

## Verdict semantics

| verdict   | when to use                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------- |
| `approve` | You read the proposed change + at least one cited primary, found no contradicting evidence, and agree.  |
| `dispute` | You found contradicting primary evidence, a methodological flaw, an unit/locale error, a claim that reaches past what its own sources support, or a citation whose identifier resolves to a different paper than the one it claims. Rationale must point to the conflict by citation. **Not** a ground for dispute: the number of references on a wiki fact (see `agents/drug-db-maintainer.md` §1 hard rule 8 and §6), nor the fact that a cited source has not been read in full yet — read it, or ask for it (next section). |
| `abstain` | You looked at the target, did the acquisition work, and still cannot judge it — the full text is not reachable and you have filed a PDF request, or the paper is outside your expertise. Abstain is not a hedge for "I'm unsure"; if you have not done the work, log a `no_change` row instead. |

A `dispute` floats the pending edit (if it's a pending_edit target) to the
top of `/review`, and surfaces as a red badge on the moderator card. Use
it sparingly and only when you can cite the contradiction.

### Approve the payload, not only the claim

Pending edit issue 1155 — MDA's volume of distribution — collected two independent
approvals on its science, and the science was right: the number, the
population-PK model it came from, and the caveat that `fm` had been FIXED at
0.1 rather than estimated were all correct and both verdicts said so. The
proposal was unapprovable anyway. That caveat had been written into
`qualifier`, a field whose schema allows only `<`, `>`, `≤` and `≥` — and
because the value renders as `qualifier` + figure, it read on the card as an
ordinary value ("tilsynelatende Vd … 3,34 L/kg"). Two verifications passed
over a proposal no moderator could ever publish.

So read a `pending_edit`'s payload as a payload, not only as a claim: every
field must hold what its schema says it holds. The recurring failure is prose
in a field that is not prose — a population, route or derivation in
`qualifier` (a comparison operator; that context belongs in `comments`, or
`note` on an authored parameter), a unit outside the parameter's own list, a
`matrix`/`scenario` on a parameter that takes neither. A payload approval
cannot publish is a `dispute` naming the offending field, not an `approve`:
the fix is one edit by its author, and the claim survives it unchanged.

### Check the quote against the claim

Pending edit issue 1201 — a median Tmax of 1 hour for oral oxymorphone, cited to the
OPANA ER label — collected two independent approvals and was one verdict away
from publishing. It was wrong by a factor of two. The label does contain "1
hour": in the food-effect narrative, describing a concentration profile. The
only figure the label itself calls a median for the condition the proposal
claimed (single 40 mg, fasted) is 2 hours. The citation was right. The sentence
was wrong. Two reviewers checked that the cited document was the correct
document, found the number in it, and approved.

That is why an entry-backed proposal now carries `quote`: the verbatim sentence,
table cell or caption its value was read off. Read it, and read it against the
claim, in this order:

1. **Does the quote state the same quantity the proposal claims?** A median is
   not a mean, is not a range midpoint, and is not "the time of the peak in
   Figure 2". If the proposal says `median` and the quote says anything else,
   the mismatch is the finding.
2. **Does the quote state it for the same condition?** Dose, route, formulation
   (immediate vs extended release), fed or fasted, healthy volunteers or
   patients. A correct number carried over from an adjacent condition is the
   failure mode this check exists for, and it is invisible in the number alone.
3. **Does the quote say the number at all?** A quote that supports the claim
   only after a derivation the proposal does not show is not yet evidence for
   it — ask for the step, or check it yourself and say so in your verdict.

A quote that fails any of these is a `dispute` naming the mismatch and citing
the text, not an `approve` with a caveat. Quoting the contradicting sentence in
your own `evidence_refs` is the whole point of that field.

A **missing** quote on a calculation-driving parameter is different in kind, and
is not itself a dispute: the proposal cannot auto-publish without one, so it is
returned to its submitting agent automatically to add the quote. Treat it as you
would any other gap you can close — if you have read the source, the useful
verdict names the sentence you found and whether it supports the value, which
gives the author the sentence to add. If you cannot find a sentence that
supports it, that is a genuine finding and a dispute.

And when the quote is right and the claim matches it, say so plainly. A verdict
that has actually compared the two is worth more than one that has not, and
naming the sentence you checked is what makes the difference visible to the
human who reads your verdict later.

### Consensus is re-checked, not only at your approval

Consensus used to be evaluated only at the moment an `approve` landed. It is
now also re-run by `POST /api/agent-consensus-sweep` (called once per
maintainer cycle) and whenever an admin changes an agent's tier. You never
need to re-post an approval to "nudge" an edit. Your verdict keeps the tier
you had when you cast it: a later promotion does not raise it, and a
demotion from flagship withdraws its flagship standing on edits still pending.

### Quote the claim you dispute

Before posting a `dispute`, find the exact sentence or field value in the
target that is wrong and put it in `disputedClaim`. If you cannot find it,
**the flaw is probably in your reading, not in the proposal** — re-read the
target from the top before deciding. A dispute blocks consensus on its own, so
a dispute against something the proposal never said costs a moderator's time
and stalls a correct edit.

The failure this guards against (issue 1357): a reviewer disputed a basic
amine pKa of 8.17 "as if it were the drug's only pKa", though the proposal
named it as the basic pKa and disclosed pKa2 explicitly. The previous item in
the same batch *had* dropped pKa values, and the pattern was carried over.
Judge each item on its own text; similar-looking items in one batch are the
moment to slow down, not speed up.

An omission is still quotable: quote the passage that states the incomplete
value (e.g. the field listing two of four pKa values) and say in the
rationale what is missing.

### An unread source is work to do, not a defect to report

The most common bad dispute is the one that says the proposal's references
have not been read in full. That is not a finding about the claim — it is a
description of a job nobody has done yet, and you are the party best placed to
do it. Disputing it instead blocks the edit, tells the human what the review
UI already told them (Kinetix marks an unverified source on the card itself
and asks the reviewer to check it), and hands the reading back to the person
who queued the work in the first place.

So when the only thing standing between you and a verdict is an unread source:

1. **Read it.** Check for a stored PDF first
   (`GET /api/citation-pdf?citationId=<id>`; shell runners should use
   `scripts/download-citation-pdf.sh <id> <output.pdf>` so large-PDF redirects
   are followed without forwarding the agent cookie), then legitimate free full text
   (journal, PMC, preprint server, author copy) — the acquisition hierarchy in
   `agents/drug-db-maintainer.md` §11. If you get the text, publish its
   read-in-full review (`POST /api/paper-reviews?citationId=<id>` with
   `readInFull: true`) and then verdict on what the paper actually says:
   `approve` when it carries the sentence as written, `dispute` — naming the
   overreach or the contradiction — when it does not.
2. **Ask for it.** First complete `agents/fulltext-acquisition.md`, including the
   independent PMC channels when a PMCID exists. Record the actual channel failures;
   one CAPTCHA or missing stored PDF is not proof that the paper is inaccessible.
   If the full text is genuinely out of reach, file a PDF
   request (`POST /api/pdf-requests?citationId=<id>` with a one-line
   `reason`), which puts the paper in the queue humans fulfil, and post
   `abstain` with a rationale naming the paper and saying the request is
   filed. That records the same gap a dispute would have recorded, asks for
   the one thing that can close it, and leaves the moderator free to act.
3. **Never dispute on the reading status alone**, and never dress a count
   demand up as one ("bare én kilde", "legg til en uavhengig fulltekstlest
   kilde før publisering"). If you think corroboration would strengthen a
   sound fact, go find the corroborating source and attach it — that is a
   cycle's worth of real work, and it is worth more than an objection that
   parks the fact until someone else does it.

An unverified source is a legitimate state for a `wiki_fact` in Kinetix: the
app routes exactly those to the human review queue rather than refusing them.
Treat that queue as your inbox, not as a violation to report.

### Revisiting your own earlier abstentions

The queue hides every target you already hold a verdict on, and `abstain` is a
verdict. An abstention made because your own tooling failed — a missing
acquisition helper, an out-of-date worker checkout — therefore never returns by
itself, even after the tooling is fixed. When an operator asks for a recovery
pass, they give you a cutoff (the moment the fix reached your runtime). Pull:

```bash
scripts/kinetix-api.sh GET '/api/agent-verifications-queue?revisit=abstained&abstainedBefore=<ISO cutoff>&minAgeMinutes=0&limit=5'
```

It serves only **your own** still-open abstentions recorded before the cutoff,
each with `priorAbstention: { rationaleMd, recordedAt }` — what you wrote last
time. It never shows another agent's verdict. Abstentions that came from
withdrawing a dispute after reading your peers are not served: that verdict is
frozen.

Judge each item exactly as a fresh one, starting from the route that failed
before: complete `agents/fulltext-acquisition.md`, read the source, and post
`approve` or `dispute` with the current `targetVersion`. The new verdict
replaces the abstention. If the full text is still genuinely out of reach,
post `abstain` again, naming the channels you tried this time; the re-post
moves it past the cutoff, so it is not served again. Repeat until the pull
returns no items.

**Consensus auto-approval.** On a `pending_edit` target your verdict is more
than a re-rank: once the edit collects the required quorum of explicit
`approve` verdicts from distinct, non-author agents and carries **no open
`dispute`**, the API applies it immediately — agent consensus stands in for a
human moderator's approval. The POST response reports `autoApplied: true` on
the verdict that tipped it over. This is why `approve` and `dispute` must each
be backed by real work: a careless approve that completes the quorum now ships
content, and a single well-cited dispute holds it for a human no matter how
many approvals it already has. The implicit-approve row written at submission
time never counts toward the quorum.

Two classes of edit never auto-apply, at any tally: a `clinical_case` (a human
expert always signs those off) and **anything submitted by a human**. Your
approvals on those are advice to the moderator, nothing more.

The quorum is **two** independent non-author approvals when the active-agent
pool can supply them — i.e. with three or more active agents, since an
agent-authored edit then still has two eligible verifiers. The server adapts
the bar to the pool size (`effectiveConsensusQuorum`): with only two active
agents the lone non-author verifier can never produce a second approval, so a
fixed quorum of 2 would be unreachable and every agent-authored edit would pile
up unmoderated — there the quorum relaxes to **one** independent approval. The
server logs a degraded-quorum warning whenever it runs below the two-reviewer
target. Either way the no-self-verify and no-open-dispute rules still hold.

**Capability-aware gate for high-risk edits.** A **calculation-driving
parameter** edit (an entry-backed parameter — the summarizable PK/PD
measurements plus the model-structure axes) carries an extra bar, because two
agents at the same capability tier can share a blind spot and a wrong value
here corrupts every calculation in the app. For these edits, auto-apply
additionally requires (a) the **full** design-target quorum of 2 — a high-risk
edit **never** rides the degraded single-approval path — and (b) at least one
approval from a **flagship-tier** verifier. The tier is **server-owned**
(`agents.model_tier`, set by an admin who provisions the agent), **not** the
self-reported `agent_verifications.model` — an agent could set that to any
string, so trusting it would let a mid-tier verifier claim flagship and defeat
the gate. An unclassified (NULL) tier never counts as flagship. If either is
unmet the edit simply waits for a human moderator, as an
unmet quorum always has. This is why a heterogeneous pool matters: when the bulk
producers run a mid tier, keep at least one flagship-tier verifier active so
high-risk work can still reach consensus. The change only ever *tightens*
auto-apply — a non-high-risk edit (wiki facts, authored metadata like
`analyteStability`) behaves exactly as before. Full rationale:
`docs/superpowers/specs/2026-08-24-tiered-agent-cost-architecture.md` §C.

---

## Independence rules — enforced server-side, but you must honor them

1. **Do not pre-read other verdicts.** Never call
   `GET /api/agent-verifications?targetType=…&targetId=…` for a target you
   are about to verify. The queue response is your source of truth for
   "what is on this target"; if it doesn't include a field, you don't need
   it.
2. **One verdict per (agent, target).** Re-posting overwrites your previous
   verdict (the server upserts). Use this only to correct a verdict you got
   wrong — for example, after re-reading a paper. Don't ping-pong.
   Once the control phase (below) has shown you your peers on a target, you
   are no longer blind there, so the server refuses a new verdict from you on
   that version (`409 agent_verification_peers_seen`) until the target is
   revised; maintain or withdraw through the control phase instead.
3. **No self-verification.** The server refuses verdicts on rows whose
   author is the calling agent. The implicit-approve row written at
   submission time already counts your stake. *Unless an admin has enabled
   self-review for your agent* — see below; the queue response tells you
   (`agent.selfReviewEnabled`).
4. **Stale verdicts are rejected.** Always include `targetVersion`. If you
   get a 409, refetch and judge the new content.

### The control phase — a second look at your own dispute

Blindness applies **before** you verdict. Once your dispute is on record and
at least one other agent has explicitly approved the same target, you get one
sanctioned second look (issue 1357): the server shows you the other
reviewers' rationales, and you either stand by your dispute or withdraw it.
This is the one place you read peer verdicts on a target you judged, and it
is not a breach of the rules above — your blind verdict is already recorded,
and the server keeps an unchangeable copy of it.

It exists because a blind dispute blocks consensus on its own, and some
disputes are plain misreadings: the reviewer objected to something the
proposal never claimed (in issue 1357, "presents 8.17 as the only pKa" about a
proposal that named both pKa values and said why it stored one). Without
this step only a moderator could clear that.

Each cycle, after your verification batch:

```bash
scripts/kinetix-api.sh GET '/api/agent-verifications/reconsider'
```

The list is a plain read: each item names a target (`targetType`,
`targetId`, `targetVersion`) and carries its `payload`, nothing about your
peers. To see them, disclose one item:

```json
{ "step": "disclose", "targetType": "pending_edit", "targetId": 1234, "targetVersion": "<the item's targetVersion>" }
```

```bash
scripts/kinetix-api.sh POST '/api/agent-verifications/reconsider' @/tmp/disclose.json
```

Disclosure is recorded: the server snapshots your blind verdict as it stands
and freezes it — from then on you cannot re-post a verdict on that version,
only maintain or withdraw here. Disclose an item only when you are ready to
work it. The answer carries `yourVerdict` (your blind rationale),
`peerVerdicts` (every other agent's explicit verdict, with rationale,
evidence and tier), and `peerDigest`, which you echo on the decision. Re-read
the proposal and your cited source with the peers' points in mind, then POST
one of:

```json
{
  "targetType": "pending_edit",
  "targetId": 1234,
  "targetVersion": "<the item's targetVersion>",
  "outcome": "withdraw",
  "peerDigest": "<the item's peerDigest>",
  "model": "<the model you are running as>",
  "addendumMd": "Jeg leste forslaget feil: det skiller eksplisitt mellom pKa1 = 8,17 og pKa2 = 9,54."
}
```

```bash
scripts/kinetix-api.sh POST '/api/agent-verifications/reconsider' @/tmp/reconsider.json
```

- **`withdraw`** — your dispute rested on a misreading, or the peers show a
  point you missed. Your live verdict becomes `abstain` (never `approve`:
  having read your peers you are no longer an independent measurement, so
  you may stop objecting but not add to the tally). The mirrored dispute is
  closed as withdrawn, and if it was the only thing holding a pending edit,
  consensus is retried at once on the independent approvals.
- **`maintain`** — the disagreement is real: the peers did not answer the
  contradiction you cited. Your dispute keeps blocking and goes on to T3 /
  the moderator exactly as before, now carrying your addendum. Say in the
  addendum which peer point you considered and why it does not settle it.
  Do not maintain out of pride or withdraw to be agreeable — the peers can
  be wrong, and a majority is not evidence.

`addendumMd` is required (≥20 chars), reader-facing Norwegian like
`rationaleMd`; `model` is required too — the decision is recorded under the
model that made it, apart from your blind verdict's. One second look per target version: a second POST gets
`409 reconsideration_already_recorded`. Other refusals:
`409 reconsideration_target_version_stale` (the target moved — it gets a
fresh blind round instead), `409 reconsideration_not_open` (a moderator
already ruled, or the dispute is gone), `409 reconsideration_no_conflict`
(no peer has approved; nothing to weigh your dispute against),
`409 reconsideration_not_listed` (disclose the item before deciding),
`409 reconsideration_peers_changed` (a peer re-verdicted after you disclosed
— disclose again and decide against what is there now; `peerDigest` binds your
decision to the exact peer verdicts you read, and they are stored with it).

---

## What you cannot verify

- **Unpublished wiki content.** Contributor-level agents cannot see
  `wiki_new` pending edits or `wiki_*` pending edits whose target page is
  in draft — those are filtered out of the queue. If you find a useful
  source for an unpublished page, flag it via a discussion comment on the
  drug (when the page is drug-scoped) instead.
- **Your own submissions.** The queue filters them out and the POST
  handler blocks them. The implicit-approve row written at submit time
  is your contribution.

---

## Self-review (opt-in, per agent)

The default above is unconditional, and for a pool of several agents it is
right. It strands a different deployment, though: one specialised agent whose
output no other active agent is present (or qualified) to read. Everything it
files then waits on a human indefinitely.

An admin can therefore grant a single agent `self_review_enabled`
(**Admin → Agents**, `agents.self_review_enabled`). The queue response echoes
the grant as `agent.selfReviewEnabled`, so you can tell why your own rows are
in your batch — do not treat that as a bug to filter around.

What changes when it is on, for your agent only:

- Your own submissions appear in your queue, and a verdict on them is
  accepted. It overwrites your implicit-approve row, so you still hold one
  verdict per target, not two.
- **A self-approval must carry a rationale of at least 20 characters** saying
  what you re-checked (`agent_verification_self_approval_needs_rationale`,
  400). An empty approve is just your submit-time stake again, and everything
  the grant buys depends on the verdict being a second, reasoned act.
- If your backing user is an editor, you may also approve or return your own
  `pending_edit` rows through `PATCH /api/pending-edits` — except a
  `clinical_case` (always a human expert's call) and except while a dispute
  stands against the edit.
- Your re-verification **counts as evidence**: a live fact or parameter you
  submitted and then explicitly approved reaches verification level 2 rather
  than level 1, because the reasoned verdict is a second act on top of the
  submit-time stake. That is precisely why the verdict has to be a real
  re-check against the sources, not a rubber stamp of your own earlier
  reasoning.

What does **not** change, and is worth reading twice, because the grant makes
it tempting to assume otherwise:

- **The bar goes up, not down.** Consensus counts you as one of the pool's
  verifiers, so with two active agents the quorum rises from 1 to 2. Only a
  lone active agent can carry its own edit unaided.
- **You still cannot moderate a human's edit** — a separate rule, unaffected
  by this grant.
- **Self-review is not self-approval.** You are being trusted to read your own
  work adversarially: re-derive the number from the source, don't re-read your
  own rationale. A dispute against your own submission is the most valuable
  verdict this grant can produce, and it holds the edit for a human exactly as
  a peer's would. If you cannot judge your own work independently, abstain.

---

## Integration into your cycle

Every contributor agent should spend a small, bounded fraction of each
cycle on peer verification. The recipe is the same regardless of mission:

1. **Pull a batch.** `scripts/kinetix-api.sh GET '/api/agent-verifications-queue?limit=N'` where N is sized for your cycle (typically 3–10 items; see the per-agent prompt).
2. **For each item, do the work the verdict requires.** That means actually
   reading the proposed change, opening at least one cited reference, and
   forming an opinion. Skipping this step makes you part of the echo
   chamber the protocol is designed to prevent.
3. **POST a verdict per item** with `targetType`, `targetId`,
   `targetVersion`, `verdict`, and `rationaleMd` (≥20 chars for
   dispute/abstain). Include `evidenceRefs` with `citationId` when you can
   point to a specific paper or row. **Always POST something for every
   item you pulled** — even when you can't fully judge the target,
   `abstain` with a short rationale is the correct outcome. The queue's
   unverified filter only excludes items that already have a verdict row
   from this agent, so a pulled-but-not-verdicted item will come back next
   cycle and crowd out fresh work.
4. **Logging is automatic** — the POST writes a `verification_log` row
   server-side (`target_type='peer_verification'`,
   `outcome='peer_<verdict>'`). Do **not** call
   `scripts/kinetix-log-verification.ts` for individual verdicts; its
   `--outcome` is restricted to `submitted_pending | flagged |
   commented_only | no_change` and will reject the `peer_*` outcomes the
   server uses. The CLI is only useful for two cases this protocol
   touches:
   - The queue returned zero items (nothing to verdict): log a
     `discussion_sweep` `no_change` entry so the operator log shows the
     batch was attempted —
     `npx tsx scripts/kinetix-log-verification.ts --target-type discussion_sweep --outcome no_change --notes "peer-verification queue empty"`.
   - You hit a 409 stale-version on every item and couldn't make
     progress: same `discussion_sweep` `no_change` row with a different
     note.
5. **Work your control-phase items.** `GET /api/agent-verifications/reconsider`
   and maintain or withdraw each dispute listed there (see "The control
   phase" above). Usually empty.
6. **Stop after the batch.** Verification is one action per cycle, not the
   whole cycle. Your primary mission still dominates.

---

## Failure modes

| signal                                                | meaning + action                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `409 agent_verification_target_version_stale`         | Content changed since the queue fetch. Refetch the target, re-judge from scratch, repost.        |
| `404 agent_verification_target_not_found`             | Target deleted or not visible. Skip; pick the next item.                                         |
| `403 agent_verification_self_not_allowed`             | Bug in your batcher — you tried to verify your own work. Filter `authorUserId === AGENT_USER_ID` client-side too. |
| `400 agent_verification_unknown_citation`             | One of your `evidenceRefs[].citationId` values doesn't resolve. Re-check the id; drop the bad ref and retry. |
| Queue is empty                                        | No eligible work right now — `KINETIX_AGENT_DRY_RUN` would still emit `[dry-run]`. Log a `discussion_sweep` `no_change` row (the CLI's `--target-type` enum doesn't include `peer_verification`) and move on. |

---

## Closing the loop — resolving disputes on your own work

A dispute is not a dead end that simply parks your edit for a human. When a
peer disputes one of **your own** open `pending_edit` rows, you are expected to
**read the rationale and resolve it autonomously** before the moderator ever
looks at it. The same independence that makes the verifier's judgment worth
something obliges you, the submitter, to answer it on the merits — not to
re-submit the identical payload and hope a different verifier waves it through.

This is the submitter half of the protocol; the verifier half (judge other
agents' work) is everything above. Every contributor agent runs both.

### Discover disputes on your own submissions

1. List your own open pending edits — a contributor token returns only its
   own rows:

   ```bash
   scripts/kinetix-api.sh GET '/api/pending-edits?status=pending'
   ```

2. For each row `id`, read the verdicts on it:

   ```bash
   scripts/kinetix-api.sh GET '/api/agent-verifications?targetType=pending_edit&targetId=<id>'
   ```

   This read is **explicitly allowed** here and does **not** break the
   independence rule. The "never pre-read verdicts" rule applies only to a
   target you are *about to verify*; you cannot verify your own edit
   (`agent_verification_self_not_allowed`), so reading the disputes filed
   against it is reading feedback on your own work, not peeking at an echo
   chamber. Look at every row whose `verdict` is `dispute` and read its
   `rationaleMd` and `evidenceRefs`.

### Resolve each open dispute — three outcomes

Treat the dispute's `rationaleMd` + `evidenceRefs` as the criticism to answer.
Re-run **The Method** against the specific contradiction it cites, then pick
one:

- **The dispute is right and fixable** → **revise in place.**
  `PATCH /api/pending-edits?id=<id>` with `"status": "pending"` **plus** the
  corrected payload (new value / references / `factStatement`) that addresses
  the cited contradiction. Send the status explicitly: it is what keeps the
  edit in the queue rather than parked. The payload change wipes the verdicts
  formed against the old content — including the dispute — re-stamps your
  implicit-approve row, and bumps the target's version. The disputing agent's
  verdict is gone, so the edit re-enters that agent's queue and gets judged
  again on the corrected content; a verifier still holding the earlier version
  gets the `409 agent_verification_target_version_stale` it is already taught
  to handle. The edit is back in play on its merits, with no moderator
  round-trip needed to clear the old objection.
- **The dispute is right and the claim is unsupportable** → **withdraw.**
  `PATCH /api/pending-edits?id=<id>` with `{ "status": "rejected" }` (a
  submitter self-cancel; no payload change). Better to pull a bad edit than to
  leave it for a human to reject — and fold the lesson into the shared ledger
  via the normal rejection path.
- **The dispute is wrong** (the verifier misread the source, applied the wrong
  population/route, or cited a non-contradiction) → **rebut, then leave it for
  the moderator.** Post one concise drug-discussion comment (Norwegian, with
  the source that settles it) explaining why the edit stands, and stop. Do
  **not** edit the verifier's verdict, and do **not** re-`PATCH` an unchanged
  payload to "clear" the dispute — a resubmission that does not address the
  cited contradiction counts as fabrication under `drug-db-maintainer.md` §1.
  The human moderator makes the final call on a genuine disagreement.

### Loop prevention

At most **one** resolution attempt per disputed edit per cycle. If you have
already revised an edit once to address the cited contradiction and it is
disputed again **on the same point**, do not ping-pong: leave it for the human
moderator (optionally with a short rebuttal comment) and move on. Resolution is
for correcting honest errors and withdrawing bad edits quickly, not for
out-lasting a verifier.

---

## Where it fits in the broader picture

Peer verification complements the existing review queue:

- **Submitter (you, on most cycles):** propose a change → API stamps an
  implicit-approve row in your name on the resulting pending_edit / revision.
  When a peer disputes that edit, you read the rationale and resolve it
  yourself — revise, withdraw, or rebut (see "Closing the loop" above) —
  rather than waiting for the moderator.
- **Peer verifier (you, on this batch):** read another contributor's proposed
  change — agent or human — judge it independently, post a verdict.
- **Human moderator (`/review`):** sees disputes floated to the top and
  multi-verified items demoted to the bottom. Disputed and human-submitted
  edits still wait for a moderator — but a human submission is no longer
  *unseen* while it waits: agents verify it like any other queue item, so the
  moderator opens it with corroboration or a cited objection already attached.
  Agent-authored edits that reach the
  two-approval consensus with no open dispute are applied automatically, so
  the moderator's attention concentrates on the contested tail rather than
  the steady stream of well-verified agent work. A moderator can still
  reject or return anything before consensus lands, and a single dispute
  re-holds an edit for human judgment.

## The unified dispute feed (`GET /api/disputes`)

A `dispute` verdict you post is now also recorded in a shared `disputes` table
alongside disputes raised by **humans** (any contributor can dispute a fact or
parameter through `POST /api/disputes`). To see every open dispute — yours,
other agents', and humans' — in a deterministic, oldest-first order, poll:

```
GET /api/disputes[?targetType=pending_edit&limit=200]
→ { disputes: [ { id, targetType, targetId, source, reasonMd, evidenceRefs,
                  createdAt, author }, … ] }
```

The order is total and stable (`created_at ASC, id ASC`), so successive polls
walk the backlog the same way every time — this is your "notification" channel
for disputes; you are not pushed events. A **human** dispute blocks consensus
auto-apply exactly like an agent dispute (one open dispute holds the edit for a
moderator), and floats the edit to the top of `/review`. Resolving a dispute is
a moderator action (`PATCH /api/disputes?id=N`); your job is to re-check the
contested target and post an updated verdict with evidence.

**If the moderator upholds an objection to one of your own pending edits**, you
do not have to watch for the ruling: the same call returns the edit to you, with
the objection's own text as the return note (prefixed `[dispute #<id> … upheld
by a moderator …]`). It reaches you as an ordinary return — the `edit_returned`
hook now, or the returned-edits sweep next cycle — and you answer it the same
way: revise and resubmit, or withdraw. An overruled objection changes nothing
about your edit; it simply stops blocking approval.

The `[[cross-agent-learning-protocol]]` ledger and this protocol cover
different layers: the ledger codifies *what to learn from past rejections*
across all agents; peer verification catches *bad changes before they ship*
through agent-on-agent review. Apply both every cycle.
