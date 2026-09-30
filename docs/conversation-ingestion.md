# Ingesting a conversation into Kinetix

Carry the scientifically reusable part of a ChatGPT or Claude conversation into
Kinetix — source-level parameter observations, atomic monograph and topic facts,
and, rarely, a new topic page — without ever letting the model write to the
database.

```
  your conversation
        │  /kinetix (Claude) or @kinetix (ChatGPT)
        ▼
  kinetix-conversation-ingestion-v1 JSON      ← the model verifies its own claims
        │  paste / upload
        ▼
  Admin → Ingest conversation                 ← per-item acceptance gate
        │  tick what should land
        ├──────────────────────────────┐
        ▼                              ▼
  parameter_entries · facts · pages    /review queue   ← what the assistant
        ↑ ordinary Kinetix write paths                   could not verify
```

The distinction that makes this safe: the model produces a **proposal document**,
Kinetix decides what it means against current data, and a human admin accepts it
one item at a time. The conversation is never a source; every committed item
rests on a citation the assistant resolved and read in full.

## 1. Produce the bundle

Run the `kinetix` skill in the conversation you want to harvest
(`.claude/skills/kinetix/SKILL.md`; the same folder zips up as a ChatGPT skill).
The skill verifies each candidate claim against primary sources and emits one
`kinetix-conversation-ingestion-v1` object. A claim it could not source at all —
or could not attach to a page it can name — goes into `blockedCandidates[]`
rather than being quietly dropped or promoted to a fact. A claim it *can* place,
resting on a paper it found but could not read in full, is emitted as an ordinary
`wiki_fact` citing that unread source; Kinetix routes it to the review queue
rather than publishing it (see below).

Save the object to a file, or keep it on the clipboard. Optionally check it
before it goes anywhere:

```bash
npm run validate:ingestion bundle.json        # add --json for machine output
```

The validator is the same code the endpoint runs (`src/lib/conversationIngestion.ts`):
strict envelope, privacy scan (a bundle carrying raw chat, case identifiers or
full dates is refused outright), registry-checked parameter readings, and
warnings for anything an operator should look at — a parameter resting on a
single source, a compound statement that should have been split, a unit that
cannot reach the parameter's canonical one.

## 2. Analyse it

Open **Admin → Ingest conversation**, paste or upload the JSON, and press
*Analyse*. Nothing is written. Kinetix resolves the bundle against live data and
returns, item by item:

| Disposition | Meaning |
| --- | --- |
| **Will be written** | Resolved, valid, and not already present. Ticked by default. |
| **Goes to review queue** | A fact the assistant could not verify against full text. Ticked by default, but accepting it stages a proposal in `/review` rather than publishing anything. |
| **Already present** | The same reading from the same paper, or the same statement in the same section, is already stored — or, for an unverified fact, an identical proposal is already waiting in the queue. Accepting it does nothing. |
| **Cannot be written** | Unresolvable drug, ambiguous name, unknown section, missing fact anchor, taken slug, a reading the registry rejects. Cannot be ticked. |

Each row shows what is there **now** next to what would be written: the
parameter's current aggregate and how many source entries back it, plus the exact
study context that would be stored on the entry; the target page, section, and
how many facts it already holds; the statement being replaced, struck through;
and for a page proposal, every heading (with the anchor it will carry) and every
statement. Sources are listed separately with what would happen to each — new
citation or existing one, the appraisal that would be published in your name, and
the review it would replace.

## 3. Accept and apply

Untick anything you do not want, then press *Apply*. Only ticked rows are sent.

Apply re-sends the document that was analysed — not whatever is in the box now —
together with two snapshots of what the gate displayed: the review disposition
for every source an accepted item cites, and a digest of each accepted row's
resolved target. Both are **required** (`ingestion_review_snapshot_required`,
`ingestion_fingerprints_required`), because a guard a caller can omit is no guard
against the case it exists for. The digest covers what "still applicable" does
not: a name-only drug target that re-resolves after an alias edit, or a fact
anchor whose statement someone rewrote between your reading it and your clicking
Apply. Every accepted item is then
**re-resolved server-side before it is written**, so the plan you accepted is
never what authorises the write:

- an item that became a duplicate in the meantime is skipped, not written twice;
- an item that stopped resolving is skipped with its reason;
- an item the client tried to promote past the gate is refused;
- an item whose source review changed is refused **and unticked**, so accepting
  it again is a deliberate act rather than one more click;
- an item whose resolved target moved since you read it is refused as *the item
  changed* rather than written against something you never saw.

Every refusal also unticks its row, so accepting again is deliberate rather than
one more click — and a refusal is checked **before** that item's sources are
written, so a refused row never leaves a paper reviewed in your name behind it.

That re-check is also what makes the whole thing idempotent. Re-pasting the same
bundle, or double-clicking Apply, plans as *Already present* and writes nothing.
There is no run table to keep in sync — the entries, facts and revisions are the
record.

## What each item type does

**Parameter observation** → one `parameter_entries` row (origin `conversation`),
followed by the ordinary recompute, so the drug's displayed value stays a derived
aggregate rather than a number the conversation asserted. The study context the
skill captured (route, formulation, population, species, design, derivation,
evidence locator) is written to `parameter_entries.observationContext` (issue 1257) —
a stored source quote is evidence for it, so a later context edit detaches the
quote the same way editing the value does. Any free-text note the assistant
itself adds about the row (as opposed to the reading) goes in `comments`
instead, which carries no such weight.

**Unverified wiki fact** → the same staging, without the approval. A fact whose
sources the assistant did not read in full was never verified to the standard the
acceptance gate stands on: the admin's tick means *carry this across*, not
*publish this*. So the `wiki_fact` pending edit is written and simply left
`pending`, where it reaches `/review` like any contributor's proposal and a human
does the full-text check. The receipt calls it **queued**, never applied. Two
consequences worth knowing:

- The paper review recorded for such a source carries `readInFull: false`, so it
  authorises nothing anywhere else in Kinetix. Filing the claim does not quietly
  promote its source.
- The review card names the paper nobody read — the proposal carries the
  unread citation ids, and `WikiFactDiff` marks them in its reference list — so
  the outstanding task is stated where the decision is made, not inferred from
  the fact that the row is in the queue at all.

**What the queue does and does not guarantee here.** It guarantees a second,
separate, recorded decision with the claim and its unread source in front of the
decider. It does **not** guarantee a second *person*: `review.edit.decideOwn`
defaults to admin, so the admin who ingested the claim may also approve it. That
is deliberate elsewhere in the app — an admin is often the last reviewer in the
building, and on a single-admin deployment the alternative is a proposal nobody
can ever clear — and this path does not carve an exception out of it. If a
deployment wants the stronger rule, lower `review.edit.decideOwn` to `editor` in
Admin → Permissions and leave `admin.conversationIngestion.run` at admin.

Because a queued fact never lands on the page, the ordinary duplicate check
cannot see it. The open proposal is the record instead: re-pasting the bundle
plans as *Already present* with *an identical proposal is already waiting in the
review queue*, so the queue does not fill with copies. What counts as the same
proposal mirrors what the live check counts as the same edit, operation by
operation: an `add` by section and statement (one sentence proposed into two
sections is two proposals), a `replace` by anchor, statement and citation set
(re-citing one sentence to a better paper is a real edit, not a repeat), a
`remove` by anchor alone. Both halves of that question — is it live, is it
queued — are re-asked inside the write transaction under a page-scoped advisory
lock, so two applies racing each other queue it once rather than twice, and a
proposal someone approved in the meantime is recognised by its now-live
statement rather than by a queue row that has left `pending`. `pending_edits`
has no constraint that would catch either, and adding one would bind every other
`wiki_fact` submitter to a rule that is this path's alone.

What that does *not* close is an approval committing in the instant between
that read and the insert: `applyApprovedEdit` takes no page lock, so nothing
serialises the two. It is the same gap as the one under "Known gaps" below,
reached from the other side, and it belongs to the shared approval path.

This is only offered for facts on existing pages. A parameter observation is
written straight into `parameter_entries` and folded into a recomputed aggregate
— there is no queued form of that write on this path — and a whole new topic page
is more unverified content than one checkbox should stand for. Both still refuse
an unread source outright, and those claims still belong in `blockedCandidates`.

**Wiki fact** → a supplied `pageId` is cross-checked against everything else the
target claims: a monograph target must name a monograph, a topic target a topic,
and a monograph must belong to the drug the item names. Two identifiers that
disagree are a block, not a coin flip — a right drug with a wrong id would
otherwise publish onto another drug's page with nothing in the gate to show it.
Then staged as a `wiki_fact` pending edit and approved by you in the
same request. If the approval fails, the staged row is retired rather than left
`pending`: an item this run reported as failed must not stay in the review queue
where someone who never saw the run could approve it. The fact splice, the `wiki_revisions` row, the HTML regeneration
and the conflict marking are the review queue's own code; the pending row left
behind records who accepted it and when. A drug whose monograph went missing
gets one minted first (`ensureDrugMonograph`), the same invariant repair drug
creation runs.

**Topic page proposal** → the gate names the parent page it would be filed
under and the category links it would publish, including the proposed category
names that match nothing and are dropped. A published `topic` page whose
headings carry the section ids the proposal declared (or, where one is malformed or repeated, ids
minted from the heading), so a later conversation anchoring on a declared id
finds it. Page, revision, approval and categories commit together: a page
published without its revision could not be repaired by re-running, since
planning would then stop at `slug_taken`. Categories are matched to existing ones
by name; unknown names are dropped rather than invented.

**Sources** → resolved through `resolveCitation`, so a paper already on file
under another handle (PMID vs DOI) is reused rather than split, and the
assistant's appraisal is recorded as the paper review. The alternate handles
used for that are the **ID converter's**, never the bundle's: `resolveCitation`
treats a crosswalk as authoritative and may merge two rows on it, and a
well-formed but wrong `altIds.doi` — which is exactly what an unpinned model
emits — would fold two different papers together. If NCBI is unavailable each
source is simply filed under the handle it declared. An existing
**read-in-full** review is never overwritten: a chat model's appraisal does not
displace a published one. Where two source keys turn out to be the same paper —
duplicate handles, or a PMID and a DOI the converter joins — only the first
key's appraisal is written, and the gate says which one rather than promising
both. That holds whichever item you accept: if only the later key's item is
applied, the review recorded is still the one the gate named, not the appraisal
that happened to reach the write first.

Recording a review is an editorial act, not bookkeeping — `read_in_full` decides
whether that paper may back a fact or a parameter anywhere in Kinetix — so the
sources list shows the full appraisal the bundle carries (locator, evidence,
score, confidence, markdown) and, when one is being replaced, the review
currently on file. It is shown even where the existing review would be **kept**,
because `keep` describes the database at the moment you pressed *Analyse*, not a
promise: a review can be withdrawn in between (recording a replacement PDF does
exactly that, so a wrong-paper upload stops authorising facts). If that happens,
the item is **not** applied — it comes back as *the source review changed since
you looked*, and you analyse again and decide with the appraisal in front of
you. Sources are written **per item, after
that item survives its re-plan**: an item that turns out to be blocked or a
duplicate never leaves a paper reviewed in your name backing nothing.

## Who may do this

`admin.conversationIngestion.run`, admin by default and delegable down to editor
in Admin → Permissions — the same floor as the deep-research seed importer. The
capability is the whole gate: this path bypasses the review queue because the
holder *is* the reviewer, item by item, before anything is written. Except where
they cannot be — an unverified fact rests on a full-text reading nobody has done,
which is not something a checkbox can supply — and there the review queue is
used rather than bypassed.

## Relationship to the deep-research seed importer

They solve different problems and share no document.

| | Deep research (`/api/research-import`) | Conversation (`/api/conversation-ingestion`) |
| --- | --- | --- |
| Scope | One whole drug, bootstrapped | Incremental, across drugs and pages |
| Contract | `kinetix-deep-research-output-v1` (permissive envelope, pinned prompt) | `kinetix-conversation-ingestion-v1` (strict envelope, unpinned model) |
| Covers | Drug, parameters, PD targets, metabolism | Parameter observations, wiki facts, topic pages |
| Gate | Dry-run preview of the whole document | Per-item acceptance |

Seed a new drug with the research importer; keep it current from conversations
with this one.

## Known gaps

- **Deep-research does not carry this yet.** `observationContext` (issue 1257) is
  written by the conversation path above, but the separate deep-research seed
  importer (`/api/research-import`) still only writes `comments` — see issue 1289.
  Until that lands, a drug seeded by deep research and then kept current by
  conversation ingestion has its context split across two columns depending on
  which path wrote each row.
- **No MCP path.** Phase 1's `kinetix_preview_ingestion` / `kinetix_apply_ingestion`
  tools are not built, so an assistant still cannot resolve a Kinetix `factId` or
  `pageId` itself. In practice that means `replace` / `remove` facts and
  facts on topic pages are authorable only when you supply the ids; the skill
  routes them to `blockedCandidates` rather than guessing.
- **Concurrent approvals on one page are not serialised.** `applyApprovedWikiFact`
  reads the page content, splices, and writes it back without a page-level lock,
  so two approvals landing on the same page at the same instant can lose one
  fact. That is a property of the shared approval path — two reviewers clearing
  the queue at once hit it identically — not of this importer, and fixing it
  belongs there rather than here. What this path does is not add to the
  exposure: the pane locks the document and both buttons while a request is in
  flight, so an admin cannot double-submit an apply.
- **A `pdfRequestNeeded` source does not open a PDF request.** When the skill
  could not obtain a paper's full text it marks the source that way. A dependent
  wiki fact can still be carried across — into the review queue, never onto a
  page — and every other dependent claim goes to `blockedCandidates`; either way
  the source authorises nothing, since the review recorded for it says the paper
  was not read in full. The sources list says *full text not obtained —
  file a PDF request* so the ask is at least visible; opening the request is
  still a trip to `/pdf-requests`. Doing it from here would mean this pane
  writing `pdf_requests` rows, which is a different capability
  (`pdfRequest.create`) and a queue with its own dedupe and replacement rules —
  worth doing, but as its own change rather than a side effect of ingesting a
  conversation.
- **Fact reorder** is not offered — the contract has no such operation, and the
  monograph approval path does not support it either.
