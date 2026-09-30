---
name: kinetix
description: Verify the current conversation against primary sources and emit a validated kinetix-conversation-ingestion-v1 JSON bundle of parameter observations, wiki facts and blocked candidates.
---

# Kinetix conversation ingestion

Use this skill only when the user explicitly invokes `@kinetix`, `/kinetix`, or clearly asks to seed the current conversation into Kinetix.

ChatGPT convention: `@kinetix [mode]`
Claude convention: `/kinetix [mode]`

The current conversation is the discovery context. It is never scientific evidence.

## What this skill can and cannot do

**It produces one JSON document. It writes nothing.**

There is no Kinetix MCP server and no tool of any kind connecting you to Kinetix — that is an unbuilt phase of `docs/superpowers/plans/2026-08-05-conversation-to-kinetix-skill.md`. If you have ever seen a `kinetix_preview_ingestion` or `kinetix_apply_ingestion` tool, it was not this system. An admin import pane does exist (Admin → Ingest conversation), but you cannot reach it: a human carries your JSON there, resolves it against live data, and decides item by item.

Therefore:

- Never say an item was queued, submitted, applied, added, or placed in the review queue. Where this file says Kinetix "will queue" an unverified fact, that describes what the import pane does with a bundle a human carries across — not something your invocation did.
- Never assign a disposition (`auto_add`, `review_required`, `noop`, `rejected`). Only Kinetix classifies, and Kinetix has not seen your bundle.
- Never report a created ID, revision ID, or pending-edit ID. You have none.
- Always end by stating explicitly that nothing was submitted and the JSON must be carried across by a human.

The user runs `npm run validate:ingestion -- bundle.json` against your output. Anything that fails there is your error, not theirs.

## Modes

Interpret the first argument as one of:

- `auto` or no argument — every suitable parameter observation and wiki fact across all drugs and pages the conversation supports.
- `parameters` — only `parameter_observation` items.
- `wiki` — only `wiki_fact` and `topic_page_proposal` items.
- `monograph` — only `wiki_fact` items targeting drug monographs.

The validator enforces this: an item outside the declared mode is a hard error.

An unknown argument is a natural-language scope restriction, not something to ignore.

## Non-negotiable rules

1. Do not use the conversation, model memory, search snippets, or an abstract as the evidence for a committed quantitative value.
2. Independently resolve and read the relevant primary source in full before any item cites it.
3. Never invent a PMID, DOI, drug ID, parameter ID, page ID, section ID, fact ID, unit, or PubChem CID. Every identifier is either resolved or the claim is a `blockedCandidate`.
4. A claim you cannot verify to this standard is not dropped and not softened into a verified fact. If it is a wiki fact on a page you can name, emit it as a normal `wiki_fact` citing the source you found with `readInFull: false` — Kinetix will queue it for a human reviewer instead of publishing it. Anything else goes in `blockedCandidates` with the exact blocker.
5. Every parameter carries at least two independent sources — one `parameter_observation` per source. A parameter only one source supports is a `blockedCandidate`, not an item.
6. Preserve incompatible contexts separately. Never average two study arms into one range.
7. Exclude names, dates of birth, case numbers, exact incident and sampling dates, addresses, and analytical results from an individual case. Never include the raw conversation.
8. One invocation may cover several drugs, parameters, monographs, and pages. Do not collapse distinct targets for convenience.
9. Emit exactly one JSON object, in one fenced block, with nothing but contract fields inside it.
10. Every string a Kinetix reader will see is Norwegian bokmål. Kinetix's interface and monographs are Norwegian and the bundle is imported verbatim, so an English string stays English on the page.

## Content language

Norwegian bokmål: `statement`, `comments`, `editSummary`, `evidenceSummary`, `reviewMarkdown`, `rationale`, the blocker text in `blockedCandidates`, and `titleNb` / section titles on a topic-page proposal. `evidenceSummary` and `reviewMarkdown` become the published paper review on the reference page — the same review a Norwegian reader reads — so they are prose, not lab notes.

**Also every free-text value under `context`** — `route`, `formulation`, `dose`, `regimen`, `population`, `studyDesign`, `studyArm`, `samplingWindow`, `model`, `analyticalMethod`, `postmortemContext`, and `derivation.equation` / `assumptions` / `uncertainty`. Kinetix folds these into `parameter_entries.observationContext` under Norwegian labels (`Administrasjonsvei:`, `Populasjon:`, `Studiedesign:` …), so an English value publishes as English prose behind a Norwegian label. `observationContext` is a stored source quote's evidence — a later edit to it detaches the quote, exactly like editing the value does — so put facts about the READING here, not curator commentary about the row (that stays in `comments`, which never affects the quote). Name substances by their Norwegian form there too (`morfin`, `morfinsulfat`) — `target.drugName` is a lookup key and stays as it is.

Write Norwegian with its own letters: `æ`, `ø` and `å`, never folded to `ae`/`oe`/`aa` or `a`/`o`/`a` (`ærlig`, not `aerlig`; `målt`, not `malt`; `også`, not `ogsaa`). The bundle is imported verbatim, so a transliterated string is what a Norwegian reader sees on the page. Scientific symbols (`µ`, `≤`, `–`, `β`) likewise stay as the character, not an approximation of it.

Unchanged: parameter ids, unit strings, matrices, scenarios, qualifiers, `derivation.kind`, section ids, source types and every other identifier from `reference/vocabularies.md`; numbers; `context.species` (the Latin binomial); PMIDs, DOIs and URLs; `titleEn` and `slug`; and citation metadata (`title`, `authors`, `journal`) and direct quotations, which stay in the source's own language.

## Reference files

Read both before authoring:

- `reference/vocabularies.md` — the closed lists: parameter ids, units, bounds, matrices, scenarios, qualifiers, derivation kinds, monograph section ids, source types. Generated from the live registry. An identifier not on these lists does not exist.
- `reference/example-bundle.json` — a complete, valid bundle. Copy its shape exactly.

## Workflow

### 1. Determine scope

Read the conversation and the mode. Identify only scientifically reusable content:

- directly reported parameter observations;
- metabolism, pharmacodynamic, analytical, clinical, toxicological, or forensic facts that generalize;
- corrections or extensions to existing Kinetix content.

Separate case-specific reasoning from generalizable knowledge. A statement about one death or one patient is not a monograph fact. The reasoning that led you to a conclusion about a case is almost never itself a fact — it is the thing `blockedCandidates` exists for.

### 2. De-identify and atomize

Build a private working list of candidate claims. Strip identifying details. Split compound prose into independently contestable statements.

- one paper reporting oral terminal half-life in healthy volunteers = one parameter observation;
- "morphine may arise from codeine, heroin, or morphine administration" = three separately sourced facts, or a blocked candidate;
- a numeric parameter and its interpretive consequence are separate items.

Case measurements — the concentrations that prompted the conversation — never enter the bundle. There is no field for them and the validator rejects the containers models reach for (`caseExample`, `measurements` under a forbidden key, national identity numbers, raw conversation).

### 3. Verify sources independently

For every retained claim:

1. Find the strongest appropriate source, preferring primary literature for numeric observations.
2. Resolve a stable PMID or DOI (or an authoritative URL for a label/guideline) and confirm bibliographic identity.
3. Obtain the relevant full text.
4. Read the methods and the exact result in context, not the abstract or conclusion.
5. Record on the source: the exact locator (table, figure, page, section, supplement), a concise `evidenceSummary` of what is reported there, and a substantive `reviewMarkdown` appraisal naming the study's real limitations. Both are published as the paper review, so both are Norwegian bokmål.
6. Record on the item: analyte and chemical form, species and population, route, formulation, dose and regimen, matrix and analytical method, sample size, study design, sampling window, and whether the value is `reported`, `digitized`, `calculated`, `modeled` or `inferred`.
7. Check for correction, retraction, incompatible definitions, and parent/metabolite or salt/base mismatch.
8. Set `readInFull: true` only when you actually read the relevant full text.

If full text is unavailable: set `readInFull: false` and `pdfRequestNeeded: true`. What happens to the claims resting on it depends on what they are:

- a **wiki fact** on a page you can name may still cite it. Emit the item as normal; Kinetix reads the unread source as the marker that this claim was never verified and routes it to the review queue, where a human reads the paper and decides. Nothing is published on your word.
- a **parameter observation** or a **topic page proposal** may not. The validator rejects those outright — a parameter is written straight into a recomputed aggregate, and a new page is too much unverified content to hand a reviewer as one decision. Move them to `blockedCandidates`.

Never set `readInFull: true` to get a claim through. The flag is the whole difference between a fact that publishes and one a human checks first, and a false attestation publishes something nobody read.

A review, guideline, product label, or textbook may support interpretive prose. Do not present its summary as a primary reported observation.

### 4. Corroborate every parameter

Two independent sources per parameter is the floor, not the target. One paper's number is a claim; two papers' numbers are something a reader can weigh, and weighing them is what the aggregation pipeline is for. So once one source is verified, keep searching until a second independent study reports the same parameter for the same drug — then emit both. `sourceKey` holds exactly one key, so two sources are always two items.

Independent means a different study on different subjects:

- two arms, two tables, or two figures of one paper are one source;
- the same cohort published twice — an interim report and the final, a pooled reanalysis of data you already cite — is one source;
- a review, label, textbook, or database entry repeating a primary study's number is that primary study: resolve it, read it, and cite it instead;
- a paper that re-derives a value from another paper's data is not independent of it.

The two must describe the same quantity: same drug, same parameter, and a context a reader would pool. Route, formulation, population, dose, and analytical method will differ between studies — that is normal, it belongs in each item's `context`, and it is not a reason to merge them or to drop one. A context that is a genuinely different quantity — human oral against rat intravenous, plasma against whole blood, one matrix or scenario against another — corroborates nothing. It is its own parameter group and needs its own two sources.

Disagreement between the two is a result, not a problem. Emit both values as reported and name the divergence in `comments`. Never average them, never widen one item's `low`/`high` to swallow the other, and never quietly keep whichever you find more convincing.

When only one source survives verification, the parameter does not enter as a lone observation. It goes to `blockedCandidates`, and the blocker names the source you did verify, the value it reports, and what you searched for and did not find. Whoever carries the bundle across can then decide in the open what a single-sourced value is worth.

`npm run validate:ingestion` warns for every parameter group left with one source, so a single-sourced observation is visible on the way in rather than after it lands. It counts papers, not keys — two `sources[]` entries resolving to the same PMID or DOI are one source — and it splits a group whose members declare a different species or analyte, a unit no conversion reaches from the other (`L/h` against `L/h/kg`), or a different route where the parameter is a property of the route (`bioavailability` is oral bioavailability; `tmax` is time to peak after a particular route). It also names a unit that reaches the parameter's canonical unit from nowhere — a dose in `mg/kg/day` against a canonical `mg` — because no value in such a unit enters the aggregate at all, however many sources back it. It cannot see that two papers reanalyse one cohort. That part is yours.

### 5. Build parameter observations

One paper, one arm, one context = one item; at least two items, from two sources, per parameter. Use only parameter ids from `reference/vocabularies.md`.

Preserve `low` / `high` / `median` and any qualifier as reported, in the source's own unit. Do not convert — the aggregation pipeline converts and records that it did.

The exception is a **systemic** clearance reported per kg (`L/h/kg`, `mL/min/kg`): a separate family from `L/h`/`mL/min`, so the pipeline never bridges them, and per §4 an observation in one never reaches the aggregate however many sources back it. Never convert `CL/F` (apparent, oral-route clearance divided by an unknown bioavailability): multiplying by weight cancels the `/kg` but not the `/F`, so the result is still apparent clearance, not the systemic quantity it would be pooled as, and the two can differ by a factor of bioavailability — convert only when the source states or the design implies genuine systemic clearance (an IV arm, or `CL/F` already corrected for a known `F`), and leave a `CL/F` reported per kg in its per-kg unit otherwise. If the source gives a genuine per-subject pairing — one subject's own per-kg clearance and that same subject's own weight — compute the absolute value yourself, with a single multiplication by weight in kilograms (a real reconstruction of that subject's own absolute clearance) — convert the weight to kg first if the source reports it in pounds or grams (a US-cohort or neonatal study routinely does; multiplying by the raw number is off by a factor of 2.205 or 1000) and name that conversion alongside the arithmetic — and emit that instead: `context.derivation.kind: "calculated"` and `context.derivation.assumptions` naming the weight and the arithmetic; `quote` then covers both operands (the per-kg value and the weight), never a restatement of the computed number. Never convert a dose reported in `mg/kg` or `mg/kg/day`, weight-paired or not. `mg/kg/day` cannot reach the canonical `mg` by weight alone — that only reaches `mg/day`, itself outside the convertible family. `mg/kg` reaches `mg` arithmetically, but the number is almost always a prescribed regimen (a pediatric dose, an induction dose), not a measured absolute quantity — multiplying it by one subject's weight produces a mass that encodes that subject's body size, not the drug's dose, and emitting it as though it were a general absolute dose skews the aggregate. Never derive an absolute value from a cohort-level mean/median per-kg value and a mean/median sample weight — the product of means is not the mean of products. Absent a genuine per-subject pairing, preserve the reported per-kg unit as usual; it stays out of the aggregate, as documented.

A study that pairs weight with per-kg value for **more than one** subject is still one arm, so it is still one item, not one item per subject — `entryWeight` weights a citation by item, and one item per subject would let a single paper outweigh every other source on the parameter. Compute the absolute value for every paired subject, then report the arm the same way any other reading is reported: `median` (and `low`/`high` if the source gives a spread) across those computed values, `n` set to the number of subjects actually paired — not the arm's full size if some lack a weight. `derivation.assumptions` has a 2000-character limit a large arm's per-subject pairs can exceed: name every subject's weight and per-kg value only while it comfortably fits, and past that name the calculation method and a locator instead — in Norwegian, since a stored `derivation.assumptions` is rendered verbatim (e.g. "beregnet fra hver av n=24 forsøkspersoners egen vekt og kg-normerte clearance, tabell 2") — rather than transcribing every value and having the item rejected. `quote` has no such fallback: it has its own 1000-character limit and must stay **verbatim** source words, so a locator is not evidence there — when the operands for every paired subject do not fit verbatim within it, leave `quote` absent rather than substitute authored text, so the item is not mistaken for one whose calculation a human can verify. Never emit just one paired subject's value as though it stood for the arm.

Do not emit:

- a parameter that one source alone supports — corroborate it or block it;
- a range assembled from incompatible studies;
- several study arms as one item;
- a population- or route-independent claim from a context-specific paper;
- LOQ or LOD as a parameter — an analytical limit belongs to a validated method in a laboratory, not to the substance, and Kinetix records it per analyte per analytical method; stability likewise takes no per-source observation, being matrix-specific;
- a value whose derivation you cannot state.

A qualified (`<`, `>`, `≤`, `≥`) observation is one censored threshold, so it carries a single value — never a range.

### 6. Build wiki facts

One atomic, independently contestable statement per item, in Norwegian bokmål.

- `add` — a genuinely new fact. Must not carry a `factId`; Kinetix mints those.
- `replace` — corrects or materially improves one existing fact. Requires that fact's exact `factId`.
- `remove` — only when the existing fact is demonstrably wrong or obsolete. Requires the exact `factId`, carries no statement, and the `editSummary` must say why it is wrong.

For a drug monograph use the exact section id from `reference/vocabularies.md`, never a translated title. Every drug already has a monograph — never propose a page for a drug that exists.

Keep numeric canonical parameters in parameter items rather than restating them as prose.

You will usually not have a `pageId`, `factId`, or `observedRevisionId`, because you cannot query Kinetix. That is decisive:

- an `add` to a drug monograph is authorable — identify the drug by name and PubChem CID and give the section id;
- a `replace` or `remove` is **not** authorable without the real `factId`. If the user has not supplied one, it is a `blockedCandidate` reading "requires factId from the live page".
- a topic fact needs a `pageId` or `pageSlug` the user supplied. Otherwise: blocked.

### 7. New topic pages

Only when no existing page fits, and never for a drug. Give the title, slug, suggested parent and categories, section structure, and atomic sourced facts, plus a `rationale` explaining what you searched and why nothing fit. A new page always requires human review.

### 8. Emit and report

Emit one `kinetix-conversation-ingestion-v1` object (contract below).

Then, outside the JSON, report a compact audit:

- proposed parameter observations: drug, parameter, value, source — grouped by parameter, so how many independent sources each one carries is visible at a glance;
- proposed wiki facts: page, section, operation;
- proposed wiki facts resting on an unread source: claim, page, and the source you could not read — these will go to Kinetix's review queue, not onto a page;
- blocked candidates: claim and exact blocker;
- sources verified: identifier, whether full text was read, whether a PDF request is needed;
- **an explicit statement that nothing was submitted to Kinetix and the bundle must be validated and imported by a human.**

Report what you proposed, never what "happened".

## The contract

Strict envelope: any key not listed here is a hard error. This is deliberate — an invented shape is the most common failure, and it fails silently everywhere else.

```jsonc
{
  "schemaVersion": "kinetix-conversation-ingestion-v1",  // exact literal
  "idempotencyKey": "conv-<topic>-<nn>",                 // stable for this invocation
  "mode": "auto | parameters | wiki | monograph",
  "conversationDigest": "<64 hex chars>",                // opaque; never the chat
  "createdAt": "2026-08-06T09:12:00Z",                   // ISO 8601
  "sources": [ /* see below */ ],
  "items": [ /* see below */ ],
  "blockedCandidates": [ /* see below */ ]               // optional but usually present
}
```

`items` and `blockedCandidates` may not both be empty.

### sources[]

```jsonc
{
  "key": "S1",                    // bundle-local handle; items cite this
  "type": "pmid | doi | url",     // no freetext: an unresolvable source cannot back an item
  "identifier": "2719903",
  "altIds": { "doi": "10.1111/…", "pmcid": "PMC1379730" },   // optional
  "metadata": { "title": "…", "authors": ["…"], "journal": "…", "year": 1989 },
  "verification": {
    "readInFull": true,
    "locator": "Results, p. 501; Table 2",
    "evidenceSummary": "Hva kilden rapporterer på dette stedet. Norsk bokmål.",
    "reviewMarkdown": "Design, metode og reelle begrensninger. Norsk bokmål.",
    "reviewConfidence": "high | medium | low",
    "overallScore": 68
  },
  "pdfRequestNeeded": false
}
```

### items[] — parameter_observation

```jsonc
{
  "type": "parameter_observation",
  "target": { "drugName": "Morphine", "pubchemCid": 5288826 },
  "parameter": "bioavailability",       // from reference/vocabularies.md
  "low": 0.215, "high": 0.263,           // "both required" parameters reject a lone centre
                                         // (see the "low & high" column in vocabularies.md)
  "doseContext": { "centralValue": 0.239, "centralStatistic": "median", "intervalKind": "range" },
                                         // what the numbers ARE — see "What the number is" below
  "qualifier": "<",                      // optional; then a single value only, no statistic
  "unit": "fraction",                    // must be allowed for this parameter
  "matrix": "whole_blood",               // only where the parameter requires it
  "scenario": "postmortem_mono_intox",   // only where the parameter requires it
  "n": 6,
  "sourceKey": "S1",                     // exactly one; a second source is a second item
  "context": { "analyte": "…", "route": "…", "population": "…",   // norsk bokmål — the reading's own facts
               "derivation": { "kind": "reported" } },
  "comments": "Norsk bokmål: kuratorkommentar om oppføringen, ikke om avlesningen selv.",
  "quote": "Verbatim sentence, table cell or caption — the source's own words.",
  "editSummary": "Norsk bokmål, én linje."
}
```

`quote` is the **only** field that stays in the source's original language: it is
a quotation, so translating it would destroy the thing it is for. Everything
else in this item follows the Norwegian rule above.

Quote the text that states this value **for the condition you are claiming it
for** — the dose, route, formulation, fed/fasted state and population you named
in `context`. Citing the right paper is not the same as reading the right number
out of it, and a value lifted from an adjacent condition looks perfectly
well-sourced while being wrong. If the sentence you can quote does not say what
you are about to emit, emit what the sentence supports or narrow the claim until
it matches; do not quote a near-miss and leave it for review.

Two of these, citing two different sources, is the minimum for any one parameter. One of them alone is a `blockedCandidate`.

#### What the number is — every parameter

A source's central number is a mean, a median or one subject's value, and its
bounds are an SD, a CI or an observed range. Say which, on **every** numeric
parameter, through a `doseContext` block that carries only these three fields
(the dose fields are Cmax-only and refused elsewhere):

```jsonc
{
  "type": "parameter_observation",
  "parameter": "halfLife",
  "low": 0.42, "high": 0.66,             // 0.54 ± 0.12: centre minus and plus the SD
  "unit": "h", "n": 12, "sourceKey": "S1",
  "doseContext": {
    "centralValue": 0.54,                // the reported centre
    "centralStatistic": "arithmetic_mean", // arithmetic_mean | geometric_mean | median | single_subject | unknown
    "intervalKind": "sd"                 // sd | sem | ci95 | iqr | range | unknown
  },
  "quote": "Mean Total (SD) … t1/2 (h) 0.54 (0.12)"
}
```

- **A mean never goes in `median`.** `median` is accepted only as shorthand for
  a *reported median* and is stored as `centralStatistic: "median"`.
- **SD / SEM bounds** are symmetric around `centralValue`: "0.54 ± 0.12" is
  `low: 0.42, high: 0.66`, never `low: 0.12`.
- **A range with no reported centre** is `low`/`high` + `intervalKind: "range"`
  and no `centralValue`.
- **Bounds beside a labelled centre always name their `intervalKind`**; use
  `"unknown"` when the source does not say what they are.
- **A threshold** (`< 5`) keeps its legacy shape — `qualifier` + one value in
  `low`/`high`/`median` — with no statistic.
- When the source does not say which statistic it reports, use `unknown`;
  never guess.

#### Cmax: structured dose context

A peak concentration means nothing without the dose, schedule, formulation,
population and statistic behind it, so a `cmax` observation carries a
`doseContext` block beside the free-text `context`. `context` is still the
Norwegian description a reviewer reads; `doseContext` is what Kinetix stores and
later normalizes by. Every value is an identifier from the closed lists below,
never prose.

```jsonc
{
  "type": "parameter_observation",
  "target": { "drugName": "Benzoylecgonine" },
  "parameter": "cmax",
  "low": 70, "high": 98,                 // what these ARE is `intervalKind`
  "unit": "ng/mL",                       // or a per-dose unit such as "µmol/L/mg" (see valueBasis)
  "matrix": "plasma",
  "n": 12,
  "sourceKey": "S1",
  "context": { "dose": "2 mg kokainhydroklorid peroralt", "population": "friske voksne" },
  "doseContext": {
    "valueBasis": "concentration",       // REQUIRED: "concentration" | "dose_normalized"
    "centralValue": 84,                  // the reported centre, as for every parameter (see above)
    "centralStatistic": "arithmetic_mean", // required with a centre: arithmetic_mean | geometric_mean | median | single_subject | unknown
    "intervalKind": "sd",                // required with bounds: sd | sem | ci95 | iqr | range | unknown
    "doseValue": 2, "doseUnit": "mg",    // OR doseLow + doseHigh; never both. µg | mg | g | µg/kg | mg/kg
    "doseBasis": "salt", "doseSaltForm": "hydrochloride", // only what the paper states
    "route": "oral",                     // from the route ids in vocabularies.md
    "doseRegimen": "single",             // single | multiple | steady_state | unknown
    "releaseProfile": "immediate", "physicalForm": "tablet_capsule",
    "prandialState": "fasted",           // fasted | fed | unspecified
    "coadministrationState": "monotherapy",
    "pkPopulation": "healthy_adult",
    "administeredDrug": { "drugName": "Cocaine" } // omit when the target itself was dosed
  }
}
```

- **Record what the source states and nothing else.** A field the paper does not
  report is omitted or set to `unknown` / `unspecified`. Never infer a salt form,
  a fasted state or a healthy population. Kinetix keeps such readings visible and
  excludes them from the dose-normalized summary with a named reason; a guessed
  value would be pooled as though it were fact.
- **A metabolite's Cmax** names the substance that was actually dosed in
  `administeredDrug` (same shape as `target`). Benzoylecgonine measured after
  cocaine is `target: benzoylecgonine`, `administeredDrug: cocaine`.
- **One arm per item.** Two doses, two regimens, fed vs fasted, or an interaction
  arm (`coadministrationState: "with_interacting_drug"` + `interactingDrug`) are
  separate items. Never average arms.
- **A threshold** (`< 5 ng/mL`) is `qualifier` + `centralValue`, with no
  `centralStatistic`, no `intervalKind` and no bounds.
- **SD / SEM bounds** are `centre ± dispersion` and must be symmetric around
  `centralValue`.

### items[] — wiki_fact

```jsonc
{
  "type": "wiki_fact",
  "target": {
    "pageType": "monograph | topic",
    "drug": { "drugName": "Morphine", "pubchemCid": 5288826 },  // monograph
    "pageId": 42, "pageSlug": "…",                              // topic
    "sectionId": "forensic",
    "observedRevisionId": 118                                    // for replace/remove
  },
  "operation": "add | replace | remove",
  "factId": "…",                        // replace/remove only
  "statement": "Én setning.",           // omitted for remove
  "sourceKeys": ["S2"],
  "editSummary": "Norsk bokmål, én linje."
}
```

### items[] — topic_page_proposal

```jsonc
{
  "type": "topic_page_proposal",
  "titleNb": "…", "titleEn": "…", "slug": "…", "parentSlug": "…",
  "categories": ["…"],
  "sections": [ { "sectionId": "…", "titleNb": "…",
                  "facts": [ { "statement": "…", "sourceKeys": ["S1"] } ] } ],
  "rationale": "Norsk bokmål: hva som ble søkt etter, og hvorfor ingen eksisterende side passer."
}
```

### blockedCandidates[]

```jsonc
{
  "summary": "Norsk bokmål: påstanden, sagt rett fram.",
  "blocker": "Norsk bokmål: nøyaktig hva som mangler — ingen fulltekst, ingen kilde som lar seg slå opp, ingen factId, tvetydig mål.",
  "candidateIdentifier": "pmid:9061094"     // optional
}
```

This is where an interpretation the conversation reached but no source establishes belongs — and where a claim you cannot attach to a page belongs (a `replace`/`remove` with no `factId`, a topic fact with no `pageId` or `pageSlug`). Putting it here is a successful outcome, not a failure.

It is **not** the place for a wiki fact you could place but could not read the full text for. That one is an ordinary `wiki_fact` citing a `readInFull: false` source: Kinetix queues it for a human reviewer, which carries the claim across instead of stranding it in a list nobody can act on.

## Quality standard

A good invocation leaves a bundle that is more granular and easier to challenge than the conversation was:

- source observations stay source observations;
- no parameter rests on a single source;
- facts stay atomic;
- incompatible contexts stay separate;
- every item traces to a source that was read in full, or is visibly marked `readInFull: false` so Kinetix sends it for human review;
- everything that cannot be placed at all is visibly blocked, with the reason;
- nothing is described as having landed anywhere.
