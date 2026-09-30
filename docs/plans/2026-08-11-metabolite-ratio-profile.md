# Metabolite ratio profile — implementation plan

**Status:** Proposed for review. Three open questions decided by the owner on 2026-08-12 —
§13.3 (published reference sources only), §13.4 (raw and normalised both shown, neither
asserted) and §13.7 (two completeness markers, per drug and direction).
**Date:** 2026-08-11
**Design input:** `Drug_Metabolite_Ratio_Visualization.zip` — design handoff "Metabolite ratio profile (Kinetix)", worked example diazepam, synthetic case `SYNTHETIC-DIAZEPAM-001` (invented values)
**Scientific input:** owner review of 2026-08-11, Layer A (diazepam and metabolites). Layer B was referenced but not supplied — see §3.4 and §13.
**Related:** [`docs/plans/2026-08-10-case-pattern-explorer.md`](./2026-08-10-case-pattern-explorer.md), [`docs/kinelab-integration.md`](../kinelab-integration.md), [`docs/pm-am-ratio-seeding.md`](../pm-am-ratio-seeding.md)

**Amended 2026-08-24 — the completeness markers are withdrawn.** Everything below about
asserted completeness (§7.3.2's second clause, the `graph_uncurated` status, the
`unclassified` candidate role, §13.7's two columns and their editor panel) describes what was
built and then removed; it is kept as the record of why it was tried. The assertion was a
per-substance, per-direction confirmation a curator had to make in the monograph sidebar,
outside the flow of curation and returning nothing to the person making it — so in practice
nobody made it, every substance stayed unasserted, and every case resolved to a curation
complaint naming nodes nobody was going to assert, with no source assessment behind it.

What stands in its place is a **standing caveat on the profile**: the assessment reads the
metabolite links the catalog holds, and a metabolite nobody entered may disturb both the
ratios and the source walk. So `not_applicable` now means "no administrable alternative among
the recorded edges" rather than "no administrable alternative exists", and the difference is
stated in the open — once, where a reader sees it — instead of being encoded in a status no
curator was going to clear.

The two columns and their digest functions stay in the database for now. `vercel.json` applies
migrations as the first step of the build command and the deploy only happens once the whole
build succeeds, so dropping them alongside the readers would leave the still-live build querying
columns that no longer exist — indefinitely, if any later build step fails, rather than for the
length of a deploy. So this is expand-then-contract: the readers go first, and a migration
after that is deployed drops `metabolites_complete_digest`, `precursors_complete_digest`, their
partial indexes and `metabolite_edges_digest_of` / `precursor_edges_digest_of`.


## 1. Decision

Build the metabolite ratio profile as the **first user interface vertical of Case Pattern
Explorer**, not as a standalone screen next to it.

The handoff describes one screen for one drug family. Everything on it that looks like a
constant — the six analytes, the six ratios, the three groups, the seven case-data rows, the
five evaluative signals, the placeholder percentile table, the axis bounds — is an instance of
a class that the pattern spec has already named. This plan's whole job is to say, for each
such constant, **which registry or record it becomes** so that the second drug family is a
data change and not a code change.

Concretely:

- the view is `src/components/modeling/pattern/RatioProfile.tsx`, rendered from a
  `RatioProfileViewModel` that contains no substance-specific knowledge;
- the diazepam content ships as a **substance module** (`benzodiazepines`) plus feature,
  context-field and signal registry entries, all keyed by stable identity (`pubchem_cid`),
  per pattern spec §16.5;
- the screen is a panel inside the Case Pattern workspace at `/modeling/pattern`, reading a
  `kind: 'pattern-case'` case from `/api/simulator/cases`;
- no percentile, likelihood ratio or verbal strength expression can be computed until a
  reference band carries provenance — enforced by the **type system**, not by a runtime check
  (§7.7).

The handoff's design decisions (no cards, hairline separation, one shared log axis, the
provisional tag, visible degradation) are adopted as-is. This plan changes none of them; it
changes where the *content* comes from, and — following the Layer A review — what the diazepam
content is allowed to claim.

### 1.1 Why not a bespoke screen first

A diazepam-shaped screen followed by a generalisation pass is the expensive order. The things
that make the screen worth building — dilution-invariance reasoning, provenance gating,
degradation from missing case data, and (after Layer A) source ambiguity and assay-artefact
flagging — are all *rules over a data model*, and each is cheaper to write once against a
registry than to write for diazepam and then lift. The handoff says as much in its own Open
items: "the strength expressions and degradation lines should come from a shared wording table
so report output and screen output cannot drift."

Layer A reinforces this from the science side. Three of its five substantive findings —
co-ingestion of a downstream drug, the hydrolysis artefact, and confounded attribution — are
not diazepam facts at all. They are shapes that recur in every family the tool will meet
(morphine from codeine, amphetamine from lisdexamfetamine, every conjugated analyte, every
multi-enzyme branch point). Encoding them as diazepam text would mean rediscovering them per
module.

## 2. Scope

**In scope.** The single view described by the handoff: analysis results, case data, ratio
groups against a shared log axis, evaluative assessment, method disclosure. The diazepam
family as the first module. Norwegian and English copy. The registries and the deterministic
engine underneath.

**Pulled into scope by Layer A** (both are small, derived, and cheap here — and expensive to
retrofit): a **source-ambiguity statement** computed from the metabolism graph (§7.3), and
**assay-artefact flagging** (§7.4). Neither is the full Source Resolver.

**Out of scope, inherited from the pattern spec.** Similar Cases (§22), the full Source
Resolver with candidate source sets and negative evidence (§23), Next Best Test (§30.11), the
Metabolic Pathway Map (§30.5), the Case Fingerprint grid (§30.4), mechanistic timing inference
(§24.2), sandbox templates (§30.12).

**Explicit non-goals**, restating pattern spec §4 for the parts this screen could plausibly
violate:

- no numeric likelihood ratio, percentile, or filled strength bar from a provisional band;
- no percentile from a band whose cohort context does not match the case (living/postmortem,
  matrix, hydrolysis protocol);
- no reference band derived from Kinetix users' own cases, ever;
- no cross-matrix ratio presented without a stated normalisation regime;
- no substitution of a point value for a censored result;
- **no attribution of a shifted ratio to one cause** — genotype, interaction, or timing — when
  the observations cannot separate them (Layer A, §A3).

## 3. Scientific review of 2026-08-11 (Layer A)

### 3.1 What the review was looking at

Several Layer A findings describe a tool state that the v3 design handoff has already moved
past: the review discusses a radar chart, categorical badges ("½–2 døgn", "Uavklart"), eight
ratios, an analyte labelled `3OH·OXA`, an `OH·TOT` ratio, and a rendered percentile ("p36").
None of these exist in v3, which has no radar, no badges, no percentiles, and six ratios.
The review therefore appears to predate the v3 handoff or to have been written against the
superseded v2 (`reference/Metabolite Ratio Profile v2.dc.html`, kept in the bundle only to
show what was rejected).

This matters for sequencing: the "do now" list is partly already done in the design, and the
part that is *not* done is the part this plan has to carry. Below, each finding is marked
**closed in v3**, **partly closed**, or **open**.

### 3.2 Finding-by-finding status

| Layer A finding | Status | What this plan does |
| --- | --- | --- |
| **A1** `3OH·OXA` names a non-existent compound; it is temazepam, and the ratio is a branch product against a convergent end-product, not a hydroxylation step | **Closed in v3** | v3 already labels it "Temazepam ∶ oksazepam" and carries the sub-label "grenfordeling, ikke hydroksyleringstrinn". The registry entry uses `kind: 'branch_ratio'`, which *derives* that sub-label (§7.1) so no future module can reintroduce the misreading by omission. `OH·TOT` does not exist in v3; the nearest feature, `ndd_dwn`, is a lineage burden and is typed as one. |
| **A1** the "hydroksyleringstrinnet" interpretive text | **Partly closed** | v3's basis line no longer says "hydroxylation step", but still attributes the branch balance to "CYP3A4- og CYP2C19-avhengige trinn". Per A3 that over-attributes. Reworded in §3.3. |
| **A2** urinary fractions (NDD 0.16 / TEM 0.34 / OXA 0.47) and half-lives, incl. nordazepam >120 h and ~3-week steady state | **Open — new evidence** | Attached as `referenceCitations` on the affected features, and as the stated reason the single-vs-repeated signal stays not-calculable (§3.3). |
| **A3** *Tid siden siste inntak* — defensible, was overstated | **Closed in v3** | No badge, no resolution claim; strength already "ikke beregnbar". Wang 2020 (PMID 32219697) and Jones & Holmgren 2013 (PMID 22797834) added as citations. |
| **A3** *Enkeltdose mot gjentatt bruk* — weak discriminator; does it earn a slot? | **Partly closed** | v3 marks it exploratory with overlapping distributions. This plan adds a general rule: an exploratory signal with no computable strength **and** no established band renders under a separate "Ikke etablert" heading (§7.6), not among signals that read as findings. |
| **A3** *Etterlevelse* — unsupported by any validated evidence | **Partly closed** | v3's wording is already a bounded negative ("Avgrenset negativt søk, ikke bevis for fravær"). This plan goes further and demotes it from a signal to a `not_established` finding — it makes no claim, so it should not occupy a claim-shaped row. |
| **A3** *Plausibel doseeksponering* — real quantity, over-attributed | **Open** | Basis line reworded; plus a general `attributionCaveat` that fires whenever ≥2 modifiers bear on one basis feature (§7.6). |
| **A3** *Prøvefortynning* — fine as QC, over-scoped as a correction | **Closed by owner decision, 2026-08-12** | Raw and normalised shown as separate quantities, neither asserted as the correct one. See §3.4. |
| **A4** co-ingestion of a downstream marketed drug (oxazepam, temazepam, nordazepam are separate products) | **Open — largest gap** | New derived mechanism, §7.3. |
| **A4** glucuronide hydrolysis status, incl. β-glucuronidase reductively converting oxazepam → nordazepam | **Partly closed** | v3 has the field with snail/recombinant options. The **artefact** is not modelled: new mechanism, §7.4. The field's default also changes from "ingen" (assumed) to "ikke angitt" (missing) — §3.3. |
| **A4** CYP2C19 genotype lowers NDD:DZP independently of timing | **Closed in v3, extended** | v3 has the field; this plan adds a *direction* annotation so the affected feature says which way an option pushes it (§7.5). |
| **A4** postmortem and pre-analytical instability | **Partly closed** | v3 has antemortem/postmortem blood matrix options. Adds storage duration to the specimen, and a hard rule that a living cohort never scores a postmortem case (§10, Phase 3). |
| **A5** bands are placeholder lognormals; rebuild from local casework, stratified, validated empirically | **Partly closed** | Band model changes from parametric to empirical-over-individual-observations with n-gated percentile tiers (§7.7). Local casework as a source is **declined** (owner, 2026-08-12, §13.3): published cohorts only, so a ratio the literature never covers never gets a casework-derived band. What it renders as meanwhile — hatched placeholder through Phases 0–2, bare axis if §13.10 lands that way — is a separate open question, not settled here. |
| **A6.6** stated dose and time of intake as optional inputs | **Open** | Already expressible as `PatternKnownExposure` (spec §7.1); wired in Phase 1. |
| **A6.5** curated interacting-comedication list | **Open — cheaper than stated** | Kinetix already has `drug_enzyme_interactions` (role `inhibitor`/`inducer`, strength, references, `src/lib/enzymeInteractions.ts`). The list is **generated** from it, not authored in the registry (§7.5). |

### 3.3 Copy and default changes to the diazepam module

Four concrete changes to the handoff's content, each traceable to a Layer A finding. These are
module data, not code:

1. **`hydro` default becomes "ikke angitt" (state `missing`), not "ingen" (state `assumed`).**
   Defaulting to "no hydrolysis" silently asserts a protocol that changes measured oxazepam and
   temazepam severalfold and can, via reductive conversion, corrupt five of the six urine-side
   ratios (§7.4). An assumption that strong is not a default; it is a missing datum. This makes the
   field effectively mandatory in the only way the design's vocabulary allows, which is what
   A6.2 asks for.
2. **`tem_oxa` basis line drops the causal attribution.** Replace "Grenfordelingen gjenspeiler
   balansen mellom CYP3A4- og CYP2C19-avhengige trinn" with a statement of what the quantity
   *is* — the share of flux through the 3-hydroxy branch relative to the convergent
   end-product — plus the standing caveat that a position in a distribution cannot separate
   interaction, genotype and timing.
3. **`ndd_dwn` and the single-vs-repeated signal gain the accumulation rationale as citations**
   (nordazepam t½ >120 h, steady state ~3 weeks; Luk 2014 urinary fractions), recorded as the
   documented reason the signal stays not-calculable rather than as support for a claim.
4. **"Etterlevelse av forskrivning" moves out of the signal list** into `not_established`
   (§7.6), keeping its bounded-negative wording verbatim.

Citations carried by the module: PMID 32219697, 22797834, 24500275, 32856316, 32400211,
22053351, 20529458, 25015743, PMC6906321, PMC8466227, PMC3502654. Several are marked
abstract-only in the review. Kinetix already models exactly this as the read-in-full review
state behind `needsFullReview`, so the module records the citations and that state is carried
by the citation rather than by a hand-kept note.

**Where the state does *not* render: anywhere in this view.** The method disclosure lists the
citations; their read-in-full status stays in the reference's own discussion and
`ReviewHistory`, per the repo convention that review status is not surfaced on browse surfaces
(AGENTS.md). The convention says to move *the information*, not merely to swap a glyph for a
sentence, and a collapsed `<details>` on an analytical screen is still that screen. Nothing is
lost: what a reader needs here is how much weight a signal carries, and that is what the
evidence grade and the not-calculable reason already say — in the view's own vocabulary, not by
importing the citation's review state into it.

### 3.4 One item referred to Layer B, now settled without it

A3 says creatinine correction is "largely redundant here (see B2)". Layer B was not supplied.
That reference bears directly on a decision this plan otherwise has to make — whether the
cross-matrix ratios are creatinine-normalised, shown raw, or shown both ways.

**Decided (owner, 2026-08-12, closing §13.4): show both, assert neither.** Pattern spec §11.5's
behaviour — raw and normalised as separate quantities, with no claim that one correction is
uniquely correct — is the answer rather than a placeholder awaiting Layer B. It survives either
reading of B2, and the alternative asks the tool to settle a question its own scientific input
declined to settle.

This is a display and provenance decision, not an abandonment of the correction: `k` is still
computed, recorded in the manifest, and still part of band matching (§8.1), so a cohort
standardised at one reference never scores a case standardised at another. If Layer B later
argues the correction is redundant for within-subject cross-matrix ratios, the module flips a
flag on the two cross-matrix features and the engine stops applying `k`; no component changes.

## 4. The generalisation contract

This is the table the implementation is judged against. Left column: something the handoff (or
the review) states as a fixed value. Right column: where it lives after this plan, and
therefore what changes when the next drug family arrives.

| Handoff constant | Becomes | Lives in |
| --- | --- | --- |
| Six analyte rows (`b_dzp`, `b_ndd`, `u_ndd`, `u_oxa`, `u_tem`) | Observations attached to specimens, resolved to catalog drugs | `PatternCaseData.observations` (spec §7.2) |
| `u_creat = 8.4` as a sixth "analyte" | Specimen metadata, not an analyte | `PatternSpecimen.urine.creatinineMmolL` (spec §7.1) |
| Matrix subheadings "Blod" / "Urin" | Specimen matrices present in the case, in a fixed matrix order | derived; labels from `referenceConcentrations.ts` label keys |
| Six named ratios and their formulas | Feature definitions with numerator/denominator selectors | `src/lib/pattern/featureRegistry.ts` (spec §16) |
| Ratio labels ("N-desmetyldiazepam ∶ diazepam") | Composed from resolved catalog drug names + matrix | `t('pattern.profile.ratioLabel', { numerator, denominator })` |
| Groups "Blod / Urin / Kryssmatrise" | Derived from the distinct specimen matrices of a feature's resolved operands | `groupFeatures()` in `profileModel.ts` |
| Group notes ("dilusjonsinvariant — kreatininfaktoren kanselleres") | Derived from the group's dilution regime, one of three | computed; three fixed copy keys |
| `tem_oxa` sub-label "grenfordeling, ikke hydroksyleringstrinn" | `kind: 'branch_ratio'` → a per-kind note key | feature kind, not per-feature text |
| Footnote "Sum urin ∶ sum blod er tatt ut" | A registry entry with `status: 'withdrawn'` + rationale key | `featureRegistry.ts` |
| p5/p50/p95 placeholder table | Empirical bands over individual observations; placeholders carry `provenance: null` | `provisionalBands.ts`, superseded by the atlas |
| "Provisorisk" status line | Rendered whenever any band in view lacks provenance | derived from band states |
| Seven case-data rows | Context field definitions with applicability rules | `src/lib/pattern/contextFields.ts` |
| "missing" vs "assumed" option states | Per-option state on the field definition | `contextFields.ts` |
| Co-medication option list (CYP2C19-hemmer, …) | Generated from `drug_enzyme_interactions` for enzymes on the case's lineage | existing table + `enzymeInteractions.ts` |
| Five signals, their Hp/Hd, grade, dependencies, basis | Signal definitions | `src/lib/pattern/signals.ts` |
| Prøvefortynning's creatinine thresholds | A declarative threshold rule | `signals.ts` |
| "Styrke ikke beregnbar — `<reason>`" | Wording table over the ENFSI scale + not-calculable reasons | `src/lib/pattern/wording.ts` |
| "Oksazepam is also a marketed drug" (A4) | Derived: any lineage node that is itself administrable | `sourceAmbiguity.ts`, from the catalog |
| "β-glucuronidase can convert OXA → NDD" (A4) | An artefact rule keyed to a context-field option | `artefactRules.ts` |
| Axis `LO = 0.03`, `HI = 100` | Computed from values and bands, with a per-module pin | `computeAxis()` in `profileModel.ts` |
| Norwegian UI copy | i18n keys, both locales | `src/locales/{nb,en}.json` under `pattern.profile.*` |
| Decimal comma, always | Locale-aware separator; precision ladder preserved | `src/lib/pattern/format.ts` |

### 4.1 The acceptance test for generalisability

Two mechanical checks, both in CI. They are the point of the plan; if they pass, the rest is
detail.

1. **The substance-free component test.** No substance name, analyte abbreviation, ratio
   formula, or numeric threshold appears anywhere under `src/components/modeling/pattern/` or
   in `src/lib/pattern/profileModel.ts`. Enforced by a test that greps those paths for the
   diazepam-family analyte names and the literals `0.03`, `8.4`, `10 / `.
2. **The second-module test.** A unit test builds a `RatioProfileViewModel` for a
   **cocaine / benzoylecgonine** case from registry entries alone — two analytes, one blood and
   one urine specimen, one within-matrix and one cross-matrix ratio, no applicable genotype
   field, no band at all — and asserts correct groups, a "no reference band" state, an axis
   computed from case values alone, no source-ambiguity statement, and no signals (no basis
   feature qualifies). The diff adding this test must touch **no file under `src/components/`**.

Cocaine is chosen deliberately: it exercises what diazepam does not — no band, no CYP genotype
field (hydrolysis is esterase-mediated), a single metabolite, and no administrable alternative
— which is what most second modules will look like. Benzoylecgonine is one of the CIDs already
classified `metabolite` in `data/substanceClasses.ts` ("cocaine's inactive hydrolysis product,
no pharmacological effect and no reason to give it"), so the `not_applicable` branch is
exercised against the repo's own judgement rather than against an assumption made here.

An earlier draft used venlafaxine / O-desmethylvenlafaxine and tramadol / O-desmethyltramadol,
and both were wrong: ODV *is* desvenlafaxine, a marketed product (`docs/pm-am-ratio-seeding.md`
records the identity), and `data/substanceClasses.ts` names O-desmethyltramadol as administered
because it is taken recreationally in its own right. Both would have raised a real source
ambiguity and failed the no-warning assertion — the fixtures were testing the opposite of what
they claimed. Anything picked for this test must be checked against `substance_class` first.

Layer A's co-ingestion finding gives a third check worth adding at the same time: a
**codeine/morphine** fixture must raise the source-ambiguity statement from the graph alone,
with no benzodiazepine-specific code involved. It tests both walk directions in one case:
morphine is a metabolite of codeine *and* a marketed product (downstream), and heroin is an
administrable precursor of the observed morphine that no downstream walk from codeine reaches
(upstream, §7.3). A fixture asserting only the first would pass on an implementation that never
looks upstream — which is the failure mode with the worst forensic consequence, so the
assertion names both. It also pins the role classification: with morphine observed in the panel,
heroin is `sole_capable` and codeine-as-alternative is not, since neither can account for an
observed codeine on its own.

## 5. File map

New:

```text
src/types/patternCase.ts                              -- spec §7, shared with the wider workspace
src/lib/pattern/schemas.ts                            -- zod, mirrors the types
src/lib/pattern/substanceModules.ts                   -- spec §16.6
src/lib/pattern/featureRegistry.ts                    -- spec §16
src/lib/pattern/contextFields.ts                      -- §7.2
src/lib/pattern/sourceAmbiguity.ts                    -- §7.3
src/lib/pattern/metabolismGraphApi.ts                 -- client wrapper, module-scoped
api/metabolism-graph.ts                               -- spec §35; does not exist yet
api/_lib/metabolismGraphStore.ts
src/lib/pattern/artefactRules.ts                      -- §7.4
src/lib/pattern/modifiers.ts                          -- §7.5
src/lib/pattern/signals.ts                            -- §7.6
src/lib/pattern/wording.ts                            -- ENFSI scale + not-calculable reasons
src/lib/pattern/referenceBands.ts                     -- band types + the typed provenance gate
src/lib/pattern/provisionalBands.ts                   -- placeholders, provenance: null
src/lib/pattern/resolveObservations.ts                -- spec §7.2 → canonical µmol/L
src/lib/pattern/urineNormalization.ts                 -- spec §11
src/lib/pattern/calculateFeatures.ts                  -- spec §17 feature results
src/lib/pattern/evaluateSignals.ts                    -- signals, degradation, caveats
src/lib/pattern/profileModel.ts                       -- feature results → RatioProfileViewModel
src/lib/pattern/format.ts                             -- precision ladder, locale-aware
src/lib/patternCases.ts                               -- case CRUD wrapper (cf. src/lib/kinelabCases.ts)
src/stores/patternCaseStore.ts                        -- spec §36
src/pages/PatternCasePage.tsx
src/components/modeling/pattern/RatioProfile.tsx      -- the view; pure over the view model
src/components/modeling/pattern/AnalysisResults.tsx
src/components/modeling/pattern/CaseDataList.tsx
src/components/modeling/pattern/RatioTrack.tsx
src/components/modeling/pattern/RatioAxis.tsx
src/components/modeling/pattern/EvaluativeAssessment.tsx
src/components/modeling/pattern/MethodDisclosure.tsx
docs/pattern-ratio-profile.md                         -- curator-facing: how to add a module
```

Changed:

```text
src/lib/modelingMode.ts        -- add 'pattern' to MODELING_MODES
src/router.tsx                 -- /modeling/pattern[/:caseId]
src/components/modeling/ModelingWorkspace.tsx   -- accept a mode rather than hard-coding 'simulator'
src/locales/nb.json, src/locales/en.json        -- pattern.profile.*
src/index.css                  -- two tokens only, see §9.1
```

Deferred to the atlas phase (spec §42 Phase 3), listed so the seams are visible now:

```text
db/schema.ts, drizzle/00xx_pattern_reference_atlas.sql
api/_lib/patternReferenceStore.ts, api/pattern/reference-*.ts
api/_lib/citation-merge.ts                  -- see below; not optional
src/lib/pattern/referenceMatching.ts, src/lib/pattern/referenceComparison.ts
```

**The graph endpoint does not exist and this plan needs it.** `api/drug-metabolism.ts` serves one
drug at a time; there is no `/api/metabolism-graph` anywhere in the repo. Source ambiguity needs
the transitive neighbourhood in both directions, plus `substance_class` and the lineage enzymes
for co-medication generation — and fetching that per drug would both miss nodes the client does
not already know to ask for *and* put the case's exact analyte ids in request URLs, which spec
§41.1 prohibits precisely because it discloses case content to the server. So the endpoint is
**module-scoped** (`?module=<id>`, spec §35), and it ships in Phase 1 with the first persisted
case rather than in the spec's Phase 2, because that is when the browser first needs a graph it
cannot get from a fixture.

`citation-merge.ts` is easy to miss and expensive to miss. `mergeCitations` repoints an
**explicit, hand-maintained list** of consumer tables — wiki pages and revisions, pending edits,
paper reviews, learning units, parameter entries, drug parameter revisions — and then deletes
the losing citation row. `pattern_reference_cohorts.citation_id` is a new consumer, and spec
§18.1 already requires it to join that list. Left out, an ordinary DOI→PMID merge either fails
on the cohort's foreign key or, with a cascading one, deletes an admitted cohort and every
reference case and observation hanging off it. A merge can also collide two cohorts onto one
identity tuple, which has to be reconciled rather than allowed to violate the constraint. Both
cases carry regression coverage in Phase 3.

## 6. Architecture

```text
PatternCaseData  (specimens + observations + context)   <- persisted, raw, authoritative
        |
        |  resolveObservations       mass→molar via src/lib/unitConversion.ts, censoring preserved
        v
ResolvedObservation[]  (µmol/L intervals + qualifiers)
        |
        |  calculateFeatures         featureRegistry × substanceModules × urineNormalization
        v
PatternFeatureResult[]  (spec §17)
        |
        +-- sourceAmbiguity   <- metabolism graph + catalog administrability
        +-- artefactRules     <- context field state
        +-- evaluateSignals   <- contextFields state, modifiers, signals, wording
        |
        |  profileModel               grouping, axis, band states, formatting
        v
RatioProfileViewModel   <- the single boundary the React tree sees
        |
        v
RatioProfile.tsx (+ children)
```

Everything above `profileModel` is pure TypeScript with no React and no `i18next` — it emits
**keys and parameters**, never sentences (spec §28's `statementKey` / `statementParams`
contract). That is what lets the same evaluation drive a report export without the screen and
the report drifting, which is the handoff's third open item.

The engine runs client-side and receives no server round trip for case values (spec §41.1).
Reference bands are fetched **by module id**, never by the analytes in the open case.

## 7. Data model

### 7.1 Features

`PatternFeatureDefinition` is spec §16.3 verbatim, plus four generic fields it needs:

```ts
export interface PatternFeatureDefinition {
  // ... spec §16.3 fields

  /** Ordering inside its derived group. Groups themselves are matrix-ordered. */
  sortOrder: number;

  /**
   * A feature deliberately not offered, with the reason rendered as the group
   * footnote. The handoff's "Sum urin ∶ sum blod er tatt ut" is one: a ratio a
   * reader expects to see, whose absence must be stated rather than inferred.
   */
  status?: 'active' | 'withdrawn';
  withdrawnRationaleKey?: string;

  /** Placeholder band shipped with the registry until the atlas supersedes it. */
  provisionalBand?: ProvisionalBand;
}
```

The six diazepam ratios map onto the spec's existing `kind` vocabulary without extension:

| Feature | kind | Regime |
| --- | --- | --- |
| NDD ∶ DZP (blood) | `parent_metabolite_ratio` | within-matrix |
| OXA ∶ NDD (urine) | `parent_metabolite_ratio` | within-matrix |
| TEM ∶ OXA (urine) | `branch_ratio` | within-matrix |
| NDD ∶ downstream (urine) | `lineage_burden` | within-matrix |
| NDD urine ∶ blood | `matrix_same_analyte` | cross-matrix |
| OXA urine ∶ NDD blood | `matrix_matched_lineage` | cross-matrix |
| Sum urine ∶ sum blood | — | `status: 'withdrawn'` |

`branch_ratio` carries the sub-label the handoff attaches to `tem_oxa`, so every branch-product
pair in every future module inherits Layer A's correction for free. That is the durable form of
the A1 fix: the warning exists because branch products read as sequential steps, and typing the
feature is what stops the next module from reintroducing the misreading by omission.

### 7.2 Context fields

The seven "Saksdata" rows generalise to a registry whose entries declare **why they apply**:

```ts
export type ContextFieldApplicability =
  /** Always offered (matrix provenance, sampling interval). */
  | { type: 'universal' }
  /** Offered when the module is in scope for the case. */
  | { type: 'module'; moduleId: string }
  /**
   * Offered when the case's lineage routes through this enzyme, read from
   * drug_elimination_routes — a CYP2C19 genotype row appears for any case whose
   * analytes route through CYP2C19, and for no other.
   */
  | { type: 'enzyme'; enzymeSlug: string }
  /**
   * Offered when an observation declares a measurand mode that makes the answer
   * material — hydrolysis protocol matters exactly when a conjugated or
   * total-after-hydrolysis measurand is present (spec §15).
   */
  | { type: 'measurand'; modes: PatternMeasurandMode[] };

export interface PatternContextFieldDefinition {
  id: string;
  labelKey: string;
  /** Short form used in degradation lines ("CYP2C19-genotype"). */
  shortKey: string;
  applicability: ContextFieldApplicability;
  options: PatternContextOption[];
  /**
   * Options generated at runtime rather than authored — see §7.5. The enzyme
   * set is the case's resolved lineage enzymes, not an authored slug: diazepam
   * alone routes through CYP2C19 *and* CYP3A4, and one `comed` field naming a
   * single slug would silently drop the other enzyme's inhibitors and inducers
   * while the curated effects reference both.
   */
  generatedOptions?: { type: 'enzyme_modulators'; scope: 'lineage_enzymes' };
  sortOrder: number;
}

export interface PatternContextOption {
  /** Stable value stored in the case; never the display string. */
  value: string;
  labelKey: string;
  /** `known` renders foreground; `assumed` muted; `missing` destructive. */
  state: 'known' | 'assumed' | 'missing';
  isDefault?: boolean;
  /** How this option is expected to move specific features — §7.5. */
  modifiers?: PatternModifier[];
}
```

Of the handoff's seven fields, three are universal (`bmatrix`, `umatrix`, `interval`), one is
module-scoped (`history`), one is measurand-derived (`hydro`), and two are enzyme-derived
(`geno`, `comed`). A cocaine case gets no genotype row and no hydrolysis row without anyone
deciding that; a tramadol case gets a CYP2D6 row for the same reason diazepam gets a CYP2C19
one. Prescription history, which Layer A asks for, is deliberately *not* an eighth field — it
is multi-valued and lives in the case's exposure set instead (§7.3).

Storage: `PatternCaseContext.fields: Record<string, string>` — field id to option **value**, so
labels can be retranslated and option lists extended without invalidating saved cases.

### 7.3 Source ambiguity (Layer A, A4)

Layer A's largest practical gap: a profile dominated by oxazepam is equally consistent with
diazepam intake and with oxazepam intake, and the tool assumes a parent without asking.

This is fully derivable and needs no benzodiazepine knowledge, but it requires walking the graph
in **both** directions. An administrable node is an **alternative source** when it is either:

- **downstream** — reachable as a metabolite of the assumed parent, which is the oxazepam case
  Layer A describes; or
- **upstream** — a precursor, transitively, of any *observed* analyte.

The second is not a refinement. For a graph shaped `A → M ← B`, an assumed parent `A` and an
observed metabolite `M`, the administered substance may have been `B` — which no downstream walk
from `A` will ever reach. A downstream-only enumeration returns an empty alternative set, the
status resolves `not_applicable`, and every parent-dependent signal renders as if the source
were settled while a second compatible parent sits one edge away. Codeine and heroin over
morphine is exactly this shape, and getting it wrong is the forensic error Layer A's A4 warns
about, in its most consequential form.

The reverse edge is already available: `DrugMetabolism.precursors` in `src/lib/metabolism.ts`
reads `drug_metabolite_links` from the metabolite's side. So the candidate set is the union of
both walks, filtered to administrable per `substance_class` and minus the assumed parent. A
transitive precursor walk can over-include — a distant parent nobody would suggest — and that is
the correct direction to err, since the consequence is an ambiguity statement a curator can
dismiss rather than a resolution nobody was offered.

**One filter, though: a candidate must cover at least one observed analyte.** An upstream
candidate satisfies this by construction — it is a precursor of something observed. A downstream
one need not: an administrable descendant of the assumed parent that was never measured, and
whose own lineage produces nothing else in the panel, explains no observation in this case. It
is neither sole-capable nor contributing, because it contributes nothing, and including it would
raise an ambiguity and degrade every signal over a branch the case gives no reason to consider.
Candidates whose downstream lineage does not intersect the observed panel are dropped — but
**only when that lineage is asserted complete** (§7.3.2). Against an unasserted node, "covers
nothing observed" is unproven rather than established, and dropping on it would silently remove
a candidate on the strength of edges nobody has entered. Those candidates stay, `unclassified`.

**A candidate must be able to explain the panel before it can replace the parent.** Being
downstream and administrable is not enough. Oxazepam is both, but oxazepam intake cannot produce
the measured *blood diazepam* — so treating it as a substitute source would let the view propose
reframing onto a substance that leaves an observation unexplained. Classify each candidate by
what its own downstream lineage covers:

- **sole-capable** — its lineage covers **every** observed analyte, so it could account for the
  whole panel by itself. Heroin over an observed morphine panel is this;
- **contributing** — it covers some observed analytes but not all, so it can inflate part of the
  profile while another source explains the rest. Oxazepam alongside diazepam is this, and it is
  precisely Layer A's A4 concern: added oxazepam intake distorting the urine side of a genuine
  diazepam case;
- **unclassified** — its own metabolite edges are unasserted, so how much of the panel its
  lineage covers is unknown rather than partial (§7.3.2). It is stated as a candidate whose
  reach nobody has recorded, and it raises `graph_uncurated` naming it.

All three raise the ambiguity; they produce different sentences, and only the first could ever
be a substitute for the parent. An `unclassified` candidate is never treated as one — an
unrecorded lineage is not evidence of a full one — but neither is it written down as merely
contributing, which would be a coverage claim made from missing data.

```ts
export interface SourceAmbiguity {
  /** The parent the profile is framed around. */
  assumedParent: PatternDrugRef;
  candidates: Array<{
    drug: PatternDrugRef;
    direction: 'downstream' | 'upstream';
    /**
     * Whether its lineage covers the whole observed panel. `unclassified` when
     * the candidate's own metabolite edges are unasserted, so coverage cannot be
     * computed (§7.3.2) — a state to be stated, never guessed in either direction.
     */
    role: 'sole_capable' | 'contributing' | 'unclassified';
  }>;
  status:
    | { kind: 'not_applicable' }   // graph curated, and no candidate exists
    | { kind: 'unresolved' }
    | { kind: 'mixed_source' }     // two or more candidates positively declared
    /**
     * Every node the walks passed through whose edges are unasserted, each with
     * the direction that was needed (§7.3.2). A list because one traversal can
     * meet several, and each is its own curation request; the walk continues
     * across the edges such a node does record.
     */
    | {
        kind: 'graph_uncurated';
        nodes: Array<{ drug: PatternDrugRef; direction: 'metabolites' | 'precursors' }>;
      };
}
```

**Administrability is read from `drugs.substance_class`, not inferred.** The repo already
carries this judgement in `data/substanceClasses.ts`, whose bar is explicit — "nobody
administers it in any form", with morphine, oxazepam and temazepam named as *administered*
precisely because they are marketed products, and anything taken recreationally in its own
right (its example: O-desmethyltramadol) counted as administered too. That file also instructs
"when in doubt, leave it off", so an unclassified substance defaults to administered. That
default is the safe one here: a missing classification raises an ambiguity that may be
unnecessary, and never suppresses one that is real.

**Prescription history is a set, not a field.** Co-administration is the ordinary case, not an
edge case — a patient on both diazepam and oxazepam is unremarkable, and Layer A's own framing
("prescription history as input") admits several answers at once. A single-valued context field
could record only one of them, and picking one would read as resolving the ambiguity while
mixed sourcing remained fully confounded — the worst of the three states, because it silences
the degradation that the confounding requires.

So history is carried by `PatternKnownExposure[]` (spec §7.1), which already models several
exposures with per-exposure certainty (`confirmed` / `reported` / `suspected`), and which Phase
1 wires up anyway for stated dose and time (A6.6).

### 7.3.1 What this release does *not* conclude

Earlier drafts of this section resolved the ambiguity — a `sole_source` state that lifted the
degradation when history established one source and ruled out the rest. It is removed, and the
reasoning is worth recording because it is a scope judgement rather than a bug fix.

Making that state safe turned out to require, in order of discovery: candidate enumeration in
both graph directions; a check that the graph is curated for every node the walk touches;
exposure-certainty gating so a suspicion cannot settle it; the assumed parent inside its own
candidate set; a panel-coverage test so a partial explainer cannot substitute for the parent;
and per-candidate history coverage, because a prescription register that authoritatively covers
oxazepam says nothing whatever about heroin. Each is individually correct. Together they are
the **Source Resolver** — pattern spec §23, Phase 5 — which §2 of this plan explicitly scoped
out, arrived at one patch at a time.

So this release states the ambiguity and never settles it:

- it enumerates candidates in both directions, classifies each as sole-capable, contributing or
  unclassified, and says so in words;
- it renders declared exposures alongside them, so a reader sees what history is on file;
- it holds the source degradation on every parent-dependent signal for as long as any candidate
  exists.

The degradation is still liftable in the case that matters most for generalisation:
`not_applicable`, where the curated graph shows no candidate at all, which is most modules —
cocaine, methadone, venlafaxine. What cannot happen is a case with real alternatives being
declared settled by a view that has no resolver behind it.

The cost is a diazepam case whose prescription history genuinely settles the question still
carrying a degradation line until Phase 5. That is the conservative direction, and it is honest:
this view cannot verify panel coverage or per-candidate history scope, so it should not act as
if it had.

**What Phase 5 inherits.** The predicate above, in full, plus the two type amendments the
resolver needs — an `excluded` certainty on `PatternKnownExposure`, and a history-provenance
record whose coverage is scoped **per candidate** rather than by a single boolean:

```ts
/** Amends spec §7.1: a declared non-exposure, not merely an absent one. */
type PatternExposureCertainty = 'confirmed' | 'reported' | 'suspected' | 'excluded';

export interface PatternHistoryProvenance {
  source: 'prescription_register' | 'medical_record' | 'patient_report'
        | 'next_of_kin' | 'none';
  /**
   * Which candidates this source actually covered. A register covers dispensed
   * medicines and is silent on an illicit upstream source, so a single
   * "authoritative" flag would let it clear a heroin candidate it never saw.
   * Curator-declared per candidate, because only the person who consulted the
   * source knows its scope.
   */
  coveredCandidates: PatternDrugRef[];
}
```

### 7.3.2 Status resolution

Positive evidence is read before provenance, so two confirmed exposures established by
toxicology are `mixed_source` even when no history source was consulted — provenance absence
should not downgrade a claim the observations already support:

- **no administrable candidate exists, *and* every node the walk depends on is asserted
  complete** → `not_applicable`, decided before history is consulted. The second clause is the
  load-bearing one, and **presence is not completeness**: `hasMetabolismData()` returns true for
  a single elimination route, or even for an evidence note with no edges at all, so it answers
  "has anyone touched this?" and not "has anyone finished it?". A parent with one recorded route
  and no metabolite edges would pass a presence check, produce an empty candidate set, and clear
  every source degradation while an unrecorded administered source stayed possible — which is
  the failure this clause exists to prevent, reintroduced by the predicate meant to prevent it.

  So the assertion has to be explicit — and it is **two** assertions, not one (owner decision,
  2026-08-12, closing §13.7). "Every metabolite of this substance is entered" and "every
  precursor of this substance is entered" are different claims, made from different evidence,
  and §7.3 consumes them separately: its downstream enumeration depends only on the first, on
  the assumed parent and its descendants; its upstream enumeration depends only on the second,
  on each *observed* analyte. A single flag would force a curator to vouch for both before
  either could be used, so the common case — a well-characterised parent whose metabolites are
  fully entered, walked downstream — would sit unasserted waiting on a precursor claim the
  analysis never reads.

  Each node is therefore required complete **in the direction the walk uses it**, and a node
  used in both directions needs both. **Every node the traversal visits**, not only the node it
  started from: both walks are transitive (§7.3), so precursors-complete on an observed `M`
  proves that `M`'s own precursor edges are entered and nothing more. In `B → X → M`, if `X` is
  not precursors-complete, a missing `B → X` edge hides an administrable source and the
  candidate set comes back empty — `not_applicable`, the one status that lifts every source
  degradation, granted on the strength of an edge nobody entered. The downstream walk has the
  identical hole one level below the parent. So the walk carries its requirement with it: every
  node it passes *through* must be asserted complete in the direction it is travelling, and each
  node that is not is collected into `graph_uncurated` — the same outcome as an unasserted start
  node, for the same reason.

  **An unasserted node is not a wall.** The walk continues across every edge that node actually
  records, because those edges are entered data and dropping them would discard known sources to
  punish a missing assertion. In `B → X → M` with `X` unasserted, the stored `B → X` edge is
  still traversed and `B` still enters `candidates`; what the missing assertion costs is the
  right to conclude that nothing *else* is up there. So an incomplete node blocks
  `not_applicable` and names itself in the status — it never removes a candidate, and it never
  suppresses the `mixed_source` that two positively declared sources establish. Stopping the
  traversal, as an earlier draft of this paragraph had it, would have done exactly that: `B`
  never enumerated, so the precedence rule two paragraphs down could not fire and a declared
  source would go unreported.

  **Every candidate is such a node too**, whichever direction found it: §7.3 classifies a candidate `sole_capable` or `contributing` by walking *its own*
  downstream lineage across the observed panel, and drops it entirely when that lineage
  intersects nothing observed. Both of those read metabolite edges under the candidate, so an
  upstream candidate `B` in `A → M ← B` needs precursors-complete on `M` to be found at all and
  metabolites-complete on `B` before its role can be stated. Missing edges under `B` do not
  merely lose a candidate — they understate its coverage, so a substance that could account for
  the whole panel is described as explaining part of it, in the view and in the exported report.
  A candidate whose own direction is unasserted is therefore carried as `role: 'unclassified'`
  and raises `graph_uncurated` naming it, exactly as an unasserted parent does. It is never
  silently demoted to `contributing`, never dropped by the coverage filter (§7.3), and never
  promoted either — the type has a third state precisely so an implementation cannot be forced
  to invent one of the two real ones.

  **Positive evidence still outranks this.** §7.3.2's opening rule is that observations are read
  before provenance, and an unasserted candidate does not weaken what the case has already
  established: if the assumed parent and an `unclassified` candidate are both positively
  declared, the status is `mixed_source`, not `graph_uncurated`. The mixed-source test counts
  `[assumedParent, ...candidates]` and asks only whether each was declared, which a candidate
  with no computable role answers as well as any other. Resolving to `graph_uncurated` there
  would suppress a confirmed statement about the evidence in favour of a curation complaint,
  and both degrade identically anyway, so the trade is pure loss. `graph_uncurated` is what an
  unasserted node yields when nothing positive settles the state — which is the ordinary case,
  since it is `not_applicable` that the missing assertion actually blocks.

  Neither marker exists today, so **Phase 1 builds them** — **four columns**, being the two
  markers and the two edge-revision counters each is compared against (§10, §13.7): the markers
  alone would leave the trigger nowhere to record the graph's revision and the freshness check
  nothing to compare. Plus the migration, the trigger, store and API, the metabolism editor
  affordances that set them, and tests — alongside the graph endpoint, since both are
  metabolism-side plumbing this analysis cannot run without. Leaving them in §13 as a proposal rather than scheduling them would make
  Phase 2's acceptance unreachable by construction: both modules are required to resolve
  `not_applicable`, and nothing would exist to let them.

  Asserting them is **part of shipping a substance module.** A module author already curates
  features, context fields, signals and effects for their substances; asserting that those
  substances' metabolism edges are complete is the same kind of judgement, made by the same
  person, and it is what earns the module a `not_applicable`. A substance outside any module,
  or one whose author has not asserted the direction this case walks it in, yields
  `graph_uncurated` naming that node **and that direction** — an actionable curation request
  rather than a silent clearance;
- **two or more candidate sources positively declared** (`confirmed` or `reported`, over the set
  `[assumedParent, ...candidates]`) → `mixed_source`. Nothing weaker reaches this state: it
  *asserts* that several administered sources fed the profile, and that assertion is rendered and
  exported as a finding. One confirmed source with another candidate merely unchecked establishes
  one source and an open question, which is not the same claim;
- **anything else** → `unresolved`, including a single confirmed exposure. This is where "one
  confirmed, others never asked about" belongs, and — until Phase 5 — also where "one confirmed,
  everything else ruled out" belongs.

Every state except `not_applicable` degrades identically, so these distinctions change no
gating — only what the view says. That is exactly why they have to be right: `unresolved`,
`mixed_source` and `graph_uncurated` are different statements about the evidence, and the
wording layer is the part a report inherits.

**`not_applicable` is the only state that does not degrade.** The curated graph has *proved*
there is nothing to confound, which is a stronger statement than any history could make, and
treating it as unresolved would fire a source-confounding warning on every module with no
administrable alternative. That is most of them: cocaine has none (benzoylecgonine is inactive
and never dosed), and methadone's EDDP is a compliance marker with no product of its own. A
warning that fires where the ambiguity provably cannot exist trains readers to ignore it where
it can.

`mixed_source` degrades and says why, because a profile fed by two administered sources is
*less* interpretable than one of unknown source, not more. `graph_uncurated` degrades and names
every node whose metabolism nobody has curated, which is a list of actionable curation requests
rather than a dead end — and it is listed *alongside* whatever candidates the walk did find,
since the two are independent facts.

Rendering and consequences:

- the ambiguity renders as a statement directly under the provisional line, naming each
  candidate and whether it could account for the whole panel or only part of it — not as a
  signal, because it is not evidence for a proposition;
- **every signal that presupposes the assumed parent degrades unless the status is
  `not_applicable`.** This is a new dependency kind on a signal,
  `dependsOnSourceResolution: true`, producing the same visible degradation line the
  missing-field mechanism already does;
- no probability is attached to any candidate, and no candidate is proposed as a replacement
  framing. Compatibility is stated, not scored (spec §23.1), and substitution waits for §23.

The codeine/morphine fixture in §4.1 is the generalisation test for this.

### 7.4 Assay artefact rules (Layer A, A4)

β-glucuronidase hydrolysis can reductively convert oxazepam to nordazepam, corrupting several
of the ratios. Modelled generically as a declared conversion, keyed to the context option that
enables it and scoped to the material the protocol actually touched:

```ts
export interface PatternArtefactRule {
  id: string;
  /** Fires when this context field holds one of these option values. */
  when: { fieldId: string; valueIn: string[] };
  /** The conversion the protocol can cause. */
  converts: { from: PatternDrugRef; to: PatternDrugRef };
  /**
   * Which material the protocol was applied to. A urine hydrolysis cannot
   * alter a blood operand, so an unscoped rule would warn on rows it does not
   * affect — which erodes the warning everywhere it *is* real.
   */
  appliesTo:
    | { scope: 'matrix'; matrices: PatternMatrix[] }
    /** Preferred where the case says so: the observations whose measurand
     *  declares the protocol (spec §7.2 `assay.measurandMode`). */
    | { scope: 'measurand'; modes: PatternMeasurandMode[] };
  /** Rendered on every affected feature and in the method disclosure. */
  noteKey: string;
  referenceCitations: PatternCitationRef[];
}
```

The engine flags every feature with an in-scope operand resolving to **either side of the
conversion** — the product, whose value is inflated, *and* the consumed species, whose value is
depleted. Flagging only the product would miss a ratio whose denominator was eaten: for
diazepam that is TEM ∶ OXA, where oxazepam sits in the denominator and no nordazepam appears at
all. Both are computed from the resolved operands, not listed, so a curator cannot miss one and
a new feature is covered the day it is added.

For diazepam the rule fires when `hydro ∈ {snail, unknown}`, scoped to urine, and flags five of
the six features: OXA ∶ NDD, TEM ∶ OXA, NDD ∶ downstream, NDD urine ∶ blood, and OXA urine ∶ NDD
blood. **NDD ∶ DZP is not flagged** — both operands are blood, which a urine hydrolysis cannot
reach. That asymmetry is the point of `appliesTo`, and it is the Phase 0 acceptance criterion
(§10). The flag is a caution on the feature row, not a suppression: the value is still shown,
with its interpretation qualified.

This shape recurs — in-source conversion, artefactual deconjugation, matrix-driven degradation
— so it is worth the twenty lines it costs.

### 7.5 Modifiers and generated co-medication options (Layer A, A4/A6.5)

An option may declare how it is expected to move a feature:

```ts
export interface PatternModifier {
  featureId: string;
  direction: 'increases' | 'decreases' | 'unclear';
  /** Where the expectation comes from. */
  referenceCitations: PatternCitationRef[];
}
```

Used for two things and no more: annotating the affected feature row, and counting modifiers
for the attribution caveat (§7.6). It never adjusts a value. A CYP2C19 poor-metaboliser option
declares `{ feature: 'ndd_dzp', direction: 'decreases' }`, so the row states that the value is
expected to be lower for a reason unrelated to timing — Layer A's exact concern that "a slow
metaboliser will trigger a recent-intake reading".

**Co-medication options are generated; their effects are curated.** These are two separate
questions and only the first is derivable.

*Which drugs to offer* comes from `drug_enzyme_interactions` (role `inhibitor` / `inducer`,
strength, references). For each enzyme on the case's lineage, the option list is the interacting
drugs from that table, so fluconazole, fluvoxamine, voriconazole, omeprazole, methadone,
carbamazepine and rifampicin arrive as curated data through the existing review workflow rather
than as a literal in a registry — and a tramadol module gets its CYP2D6 list the same way, on
day one.

*Which feature each one moves, and in which direction*, *cannot* come from there. That table
names a perpetrator, an enzyme and a role; `drug_elimination_routes` associates an enzyme with a
drug **overall**; and `drug_metabolite_links` carries no enzyme attribution per edge — spec
§14.3 proposes `source_specificity`, `formation_role` and `diagnostic_note` on the edge, but no
enzyme. So nothing in the schema, present or planned, says which of diazepam's two branches a
CYP2C19 inhibitor moves. Deriving `featureId` and `direction` from these tables would mean
guessing, and a confidently wrong direction on a feature row is worse than no annotation.

So each module curates the effects, keyed by enzyme and role rather than by drug — one entry
covers every inhibitor of that enzyme, so the mapping does not grow with the co-medication list:

```ts
export interface EnzymeFeatureEffect {
  enzymeSlug: string;
  role: 'inhibitor' | 'inducer';
  featureId: string;
  direction: 'increases' | 'decreases' | 'unclear';
  referenceCitations: PatternCitationRef[];
}
```

A generated option inherits its modifiers by looking up `(enzyme, role)` here. Layer A supplies
the benzodiazepine entries directly: methadone's CYP3A4 inhibition raised urinary temazepam and
oxazepam fractions, while fluoxetine and esomeprazole's CYP2C19 inhibition raised the
nordazepam fraction (Luk et al. 2014).

**An option with no matching entry is still offered** — the interaction is real whether or not
its direction is documented — but it cannot become a `PatternModifier`, which requires a
`featureId` that by definition does not exist here. It becomes a different thing:

```ts
export interface UndocumentedInteraction {
  enzymeSlug: string;
  role: 'inhibitor' | 'inducer';
  perpetrator: PatternDrugRef;
}
```

Its scope is derived rather than guessed: it bears on every feature whose resolved operands
include a drug that `drug_elimination_routes` routes through that enzyme. That set is
computable from data already present, is conservative (it can over-include a feature the
interaction happens not to move, never silently omit one it does), and attaches to no feature
arbitrarily. Those features' signals gain the attribution caveat with an unknown direction, and
the row shows no arrow. That is the honest state for most enzyme/feature pairs and it should
look different from a documented one.

**What this means for Phase 0.** The effects are curated in the registry and validated at load,
and nothing selects them: the options that would carry the modifiers are generated from
`drug_enzyme_interactions`, which needs the database Phase 0 deliberately does not have. So
`enzymeEffects` ships inert and the attribution caveat cannot fire on a shipped module until
Phase 2 generates the options. That is phasing, not an oversight — but an unexercised mechanism
is how a thing turns out not to work on the day something finally feeds it, so Phase 0's tests
drive the counting through `buildProfileFromCase` with a module that declares the modifiers
directly. Phase 2 then supplies data to a path already known to work.

Per-edge enzyme attribution on `drug_metabolite_links` would make this derivable and is the
better long-term answer. It is a schema change with its own review workflow, so it belongs in
the pattern spec's §14.3 rather than in this plan; noted in §13.

### 7.6 Signals

```ts
export interface PatternSignalDefinition {
  id: string;
  version: string;
  titleKey: string;
  grade: 'exploratory' | 'suggestive' | 'validated';   // colour only
  propositionHpKey: string;
  propositionHdKey: string;
  basisKey: string;
  basis:
    | { type: 'feature'; featureId: string }
    | { type: 'specimen_metric'; metric: 'urine_creatinine' };
  dependsOn: string[];                  // context field ids
  dependsOnSourceResolution?: boolean;  // §7.3
  strength: PatternStrengthRule;
  referenceCitations: PatternCitationRef[];
}

export type PatternStrengthRule =
  | { type: 'not_calculable'; reasonKey: string }
  | {
      type: 'threshold';
      quantity: { type: 'specimen_metric'; metric: 'urine_creatinine' }
              | { type: 'feature'; featureId: string };
      bands: Array<{
        lt?: number; gt?: number; between?: [number, number];
        strength: EnfsiStrength;        // seven-step scale, wording.ts
        side: 'Hp' | 'Hd';
        caveatKey?: string;
      }>;
      fallback: { strength: EnfsiStrength; side: 'Hp' | 'Hd' };
      /**
       * The published support for these cut-offs. Non-empty and validated at
       * registry load — see below.
       */
      thresholdProvenance: [PatternCitationRef, ...PatternCitationRef[]];
    };
```

**There is deliberately no rule that derives strength from a band position.** An earlier draft
of this plan had one, carrying a `featureId`, on the assumption that an established band would
eventually license a verbal strength. It would not, and typing it invites an implementer to
supply what the type omits. A percentile in one empirical cohort says where a value sits; it
does not say which of Hp and Hd that supports, nor at which of seven ENFSI steps — and a
`side` field would not fix it, because the missing thing is a validated mapping from
distributional position to evidential weight, not a direction to point it in. Filling that gap
in code means inventing a forensic conclusion, which is exactly what the handoff forbids when it
says a likelihood ratio waits on provenance.

So a band position renders as a **reference comparison** (spec §28 level
`reference_comparison`), descriptive and labelled as such, and strength stays `not_calculable`
until a validated proposition-specific comparison is designed and specified. That is a future
spec item, not a type to reserve now.

Prøvefortynning expresses in the `threshold` shape; band order is significant and the registry
test asserts `lt: 2` precedes `between: [4, 20]`.

**There is exactly one source of verbal strength: a published cut-off.** An established
reference band is *not* a second one — that is what the paragraph above rules out — so a
strength expression can only ever come from a `threshold` rule. Prøvefortynning is the case the
handoff singles out as "the only signal with a strength expression, because it is the only one
with published support", and that support is Cone et al. 2009 on creatinine, not a reference
band for a ratio.

> **Correction, Phase 0 build.** That support does not hold, and the gate above is what caught
> it. Two errors were found when the module's handles were checked against the source records
> rather than against the prose describing them:
>
> 1. The handle carried as "Cone et al. 2009" was **PMID 20529458**, which is Fu et al. 2010,
>    *A novel reductive transformation of oxazepam to nordiazepam observed during enzymatic
>    hydrolysis* (J Anal Toxicol 34(5):243–251). That is the correct source for the §7.4
>    β-glucuronidase artefact, where it now sits; it says nothing about creatinine.
> 2. The paper actually intended, **PMID 19161663** (J Anal Toxicol 33(1):1–7), evaluates
>    creatinine and specific-gravity *normalisation* of urinary drug concentrations. It supports
>    the normalisation basis this view already discloses. It publishes **no** mapping from a
>    creatinine concentration onto the ENFSI verbal scale, so it does not support the
>    `lt: 2` / `between: [4, 20]` / `gt: 30` bands.
>
> The cut-offs therefore had no published support and the `threshold` rule is **withdrawn**:
> Prøvefortynning states `not_calculable` with `noPublishedCutoffs` as its reason, and the
> module ships no verbal strength expression at all. Restoring one requires a source that
> actually publishes the mapping — not a re-pointed citation.
>
> The mechanism this changes is §13.3's: a citation handle is now resolved against a
> **published-works registry** (`src/lib/pattern/publishedWorks.ts`) recording each work's
> title, container, year and `workKind`, not against the handle's syntax. Registration is a
> curator asserting they looked it up. Phase 1 replaces the table with the `citations` store and
> its `work_kind_status` resolution; the question and its callers are unchanged.
>
> **This revises the Phase 0 acceptance criterion.** "Exactly one strength expression, tracing
> to a published cut-off" becomes "no strength expression, because none traces to one" — the
> criterion's intent held, its factual premise did not. The band-provenance gate in §7.7 is therefore about percentiles and folds,
not about strength; the two mechanisms answer to different evidence and neither substitutes for
the other.

That leaves the threshold rule needing its own gate: ungated, it would let any curator emit
ENFSI wording from a number they picked, which is the failure the band gate exists to prevent
arriving by the other door.
So `thresholdProvenance` is required and non-empty, `evaluateSignals` degrades a rule with an
unresolvable citation to `not_calculable` rather than computing it, and the registry-load
validation fails on one that is absent. Provenance is required for a strength expression in
both directions; only its *form* differs — a cohort for a distribution, a citation for a
cut-off.

**Applicability.** A signal renders when its basis resolves. A signal whose basis feature is not
computable is absent entirely, not greyed out — which is what makes the cocaine case show
zero signals with no conditional code.

**Degradation** is computed, never authored: for each id in `dependsOn`, an option in state
`missing` or `assumed` joins the line via its `shortKey`; an unresolved source ambiguity joins
it when `dependsOnSourceResolution`.

**Attribution caveat (Layer A, A3).** When two or more modifiers bear on a signal's basis
feature, a standing caveat renders: the value's position cannot be attributed to any one of
them. Derived from the modifier count, so it applies to every module without authoring.

**Two new placements Layer A forces:**

- `not_established` — a finding that makes no claim. "Etterlevelse av forskrivning" moves here,
  keeping its bounded-negative wording. Rendered under its own heading, matching spec §28's
  "NOT ESTABLISHED" grouping, so a reader cannot mistake it for a finding;
- an exploratory signal with **no computable strength and no established band** renders under
  the same heading. This answers A3's "does it earn a slot" for single-vs-repeated dosing
  without deleting curated content: it keeps its slot, in the section for things the data
  cannot settle.

### 7.7 Reference bands and the provenance gate

Layer A rejects the placeholder lognormals and asks for empirical, stratified bands. The band
model therefore carries individual observations, not just three percentiles:

```ts
export interface BandProvenance {
  cohort: PatternCohortRef;      // spec §16.5 — citation + dataset hash + versions
  /**
   * No n, quantifiedN or censoredN here. The counts that gate suppression and
   * select the statistic tier must be the counts of the points the statistic is
   * actually computed from, so they are derived from `observations` below and
   * never stored beside them. Stored counts can disagree with the array — an
   * import declaring 100 quantified over 10 real points would unlock a tail
   * statistic and label it with a sample size the band does not contain, and
   * every part of that failure looks correct on screen.
   */
  population: string;
  collectionPeriod: string;
  /**
   * One entry per **resolved species term**, in the order the engine resolved
   * them — not one per arithmetic side. A selector can name several species:
   * `ndd_dwn`'s denominator is `oxazepam + temazepam`, and those two can have
   * been measured under different modes (free oxazepam, total-after-hydrolysis
   * temazepam) in the same specimen. A per-side shape cannot represent that and
   * would match a cohort whose composite was assembled differently.
   *
   * Spec §16.4 already requires the engine to return the resolved species list
   * used in every calculation, so this signature is keyed to exactly that list —
   * which also collapses what were two parallel per-side arrays into one.
   *
   * Any element disagreeing with the case, or carrying an `unknown` mode,
   * blocks the comparison rather than relaxing it.
   */
  operandSignature: Array<{
    species: PatternDrugRef;
    matrix: PatternMatrix;
    /** Spec §15's `measurand_mode` and `reported_as_drug_id`. */
    measurandMode: PatternMeasurandMode;
    reportedAs: PatternDrugRef | null;
  }>;
  /**
   * The urine-side basis the cohort's values were computed on. A cohort
   * normalised to specific gravity does not match a case normalised to
   * creatinine, even with identical matrices.
   */
  urineNormalization: {
    basis: 'none' | 'raw' | 'creatinine' | 'specific_gravity';
    /** The reference the cohort was standardised at. Matching compares this
     *  value, not just the basis name — see §8.1. */
    referenceValue: number | null;
  };
  /** Layer A: bands must be stratified or annotated by both. */
  livingOrPostmortem: 'living' | 'postmortem';
  hydrolysisProtocol: string | null;
  stratification: string | null;

  /**
   * Required when `livingOrPostmortem === 'postmortem'`. Layer A (A4) makes
   * this material: diazepam and nordazepam both decline over the postmortem
   * interval, and nordazepam was found unstable in stored blood, so a
   * short-interval preserved case and a long-interval degraded cohort are not
   * the same population even though both are "postmortem". Phase 1 already
   * captures every one of these on the specimen; without the matching side the
   * comparison silently spans them.
   */
  postmortemContext?: {
    intervalHours: { min: number; max: number } | null;
    storageDurationDays: { min: number; max: number } | null;
    preservative: string | null;
    decomposition: 'none' | 'mild' | 'moderate' | 'advanced' | 'unknown' | null;
  };
}

export interface ProvisionalBand {
  provenance: null;
  estimator: 'parametric_placeholder';
  percentiles: { p5: number; p50: number; p95: number };
  noteKey: string;
}

export interface EstablishedBand {
  provenance: BandProvenance;
  estimator: 'empirical';
  /** Individual observations. Percentiles AND counts are computed, never stored. */
  observations: ReferenceObservationPoint[];
}

/**
 * Spec §18.6's Tier C: a publication reporting only a median, a range, or
 * another summary. It has real provenance — it is not provisional — but it has
 * no subject-level points, and manufacturing some to fit `EstablishedBand`
 * would be exactly the fabrication §18.6 exists to prevent. Without this
 * variant, Phase 3's deletion of provisional bands would force aggregate
 * literature to be either discarded or invented into individual data.
 */
export interface AggregateBand {
  provenance: BandProvenance;
  estimator: 'aggregate_reported';
  /** Verbatim as published; nothing is interpolated between them. */
  reported: {
    n: number | null;
    median: number | null;
    range: { low: number; high: number } | null;
    percentiles: Array<{ p: number; value: number }>;
  };
}

export type ReferenceBand = ProvisionalBand | EstablishedBand | AggregateBand;

/** The only way to obtain counts: one pass over the points themselves. */
export function bandCounts(band: EstablishedBand): {
  total: number; quantified: number; censored: number;
};

```

**The gate is structural.** `referenceComparison.ts` exposes only:

```ts
export function percentileOf(value: number, band: EstablishedBand): number;
export function foldFromMedian(value: number, band: EstablishedBand): number;
```

Neither a `ProvisionalBand` nor an `AggregateBand` is assignable to `EstablishedBand`, so a
percentile against either does not compile — one lacking provenance, the other lacking the
subject-level points a percentile is computed from. The handoff's central rule becomes the type
rather than a discipline anyone has to remember.

Each variant renders differently, and the difference is the point: a provisional band hatched
with no statistic, an aggregate band as a labelled literature envelope showing exactly the
summary the paper published and nothing interpolated between its endpoints, an established band
as the dot strip with whatever statistic its counts license.

**Missing postmortem context blocks, it does not relax.** When the case is postmortem and
either side lacks the context above — or the two are present but disjoint, a case at 12 hours
against a cohort collected beyond 72 — the statistic is withheld and the individual points
render with the reason stated. The alternative, scoring the comparison and noting the mismatch
underneath, puts a number on screen that the note is expected to retract; in a forensic
context the number is what gets read. This is the same weakest-link rule spec §27 applies to
every derived conclusion, and it is why `postmortemContext` is required rather than optional on
a postmortem cohort.

**Two gates, in order: censoring first, then n.**

*Gate 1 — the spec's censoring policy, inherited unchanged.* Pattern spec §21.1 already
suppresses a statistic entirely when quantified references number fewer than 5, or when the
censored fraction reaches one third — compared by exact integer cross-multiplication, because
`0.33` is not one third and the two disagree at precisely the boundary the invariant tests.
§21.3a extends that same test to every statistic over matched references, so it governs the
median and interquartile tier below, not only percentiles.

An `n`-only ladder would drive straight through this: a cohort of 100 with 70 censored would
unlock a two-tailed statistic from 30 quantified values. So the gate runs first, on
`bandCounts(band)` — the counts derived from `observations`, which is the only place they exist
(§7.7) — and both counts travel with every number displayed, so a statistic resting on 4 of 11
is visibly that. Censored references still render as bounds on the strip; they are excluded
from the arithmetic, not from sight.

*Gate 2 — which statistic the surviving quantified count licenses.* Layer A is right that upper
percentiles need far more data than central ones, so each statistic carries its own threshold
over `bandCounts(band).quantified`:

```text
quantified < 20          -> dot strip of individual observations only, no statistic
20 <= quantified < 100   -> median and interquartile position
100 <= quantified < 500  -> p10/p90
quantified >= 500        -> p5/p95
```

**This ladder is stricter than spec §21.4, deliberately, and the two must not live in two
documents.** §21.4 permits an empirical percentile from `n >= 20`; Layer A's "hundreds to
thousands per analyte to stabilise the upper percentiles, which are exactly the ones that
matter forensically" is the argument for withholding the tails much longer. Both are product
defaults rather than biological constants, and the spec says so. They therefore belong in the
one place the spec already names — the `patternReference.percentile` setting — with §21.4's
thresholds and this ladder reconciled there before Phase 3 ships, rather than drifting apart in
prose. Phase 3 owns that reconciliation; flagged in §13.

The dot strip is the default rendering (spec §30.6), not a fallback, which matches both the
published-only atlas's realistic sample sizes and Layer A's "validate empirically rather than
assume lognormality". Nothing in the engine assumes a distributional family.

## 8. Derivation rules

### 8.1 Normalisation

Canonical internal concentration is µmol/L (spec §10.1) via the existing
`src/lib/unitConversion.ts`. No second mass/molar implementation.

```ts
// From the run configuration — never a literal at the call site, and never
// per-module. Default is spec §11.3's 8.84 mmol/L.
const crRef = runConfig.normalizationConfig.creatinineReferenceMmolL;
k = specimen.urine.creatinineMmolL > 0
  ? crRef / specimen.urine.creatinineMmolL
  : null;                                  // null, not 0
```

**One convention per case, and it is the spec's.** The handoff normalises to 10 mmol/L; pattern
spec §11.3 defaults to 8.84 and calls it "a normalization convention, not a claim that
8.84 mmol/L is biologically normal". `k` scales the urine side of every cross-matrix ratio
linearly, so the two differ by about 13% on exactly those features.

An earlier draft resolved this by letting the benzodiazepine module pin 10 while other modules
took 8.84 — which does not survive Phase 2, where a case may span two modules and the manifest
carries one value. The engine would then have to apply 10 to the other module (changing its
values and invalidating every 8.84-standardised band) or apply 8.84 to this one (failing the
figures the pin existed to preserve). There is no third option, and a per-feature convention
would only move the incoherence onto one screen, where two ratios normalised differently sit on
a shared axis.

So there is no pin. The convention is the spec's 8.84, configurable per case, recorded in the
manifest, and identical for every feature in that case. Nothing scientific is lost: 10 was a
round number in a prototype, and the spec is explicit that the reference is a convention rather
than a physiological claim. What changes is the fixture: the handoff's cross-matrix figures
(3,71 and 6,64) become **3,28 and 5,87** at 8.84. The four within-matrix ratios are untouched,
because `k` cancels in them — which is the plan's central invariant demonstrating itself.

Band matching still compares the reference *value*, not just the basis name (§7.7): a cohort
standardised at 10 does not score a case standardised at 8.84, whatever this product's default
happens to be at the time.

`k` applies **only** where a feature's operands come from different specimens. Within a
specimen it cancels algebraically. This is enforced by the engine from the resolved operands'
specimen ids, never by per-feature configuration — a curator cannot get it wrong because a
curator cannot state it. Per §3.4, both raw and normalised variants are shown, and neither is
asserted to be the correct one.

**Zero versus unknown.** Do not port the prototype's guarded division returning `0`. A
quantified zero is not a missing denominator; guarded divisions return `status:
'indeterminate'` (spec §17), which the formatter renders as "—". Visible behaviour matches the
prototype; semantics do not.

### 8.2 Censoring

The handoff assumes every value is quantified; a real case will not be. Rendered in the first
release (the data model is already spec §9):

- a censored operand yields `status: 'lower_bound' | 'upper_bound' | 'interval'`;
- a bound renders as an open marker with a ray toward the unbounded side; the value cell reads
  `>1,45` / `<1,45`;
- an interval renders as a bracketed span with both rims marked;
- censored values are excluded from percentile statistics but still displayed (spec §21.1).

### 8.3 Axis

Fixed `LO = 0.03 / HI = 100` is right for the diazepam bands and wrong in general. Compute it,
preserving the invariant that matters — **one axis shared by all groups**:

```
1. Collect every STRICTLY POSITIVE finite quantity in view: case values, band
   bounds, and 1.0. Zero is excluded here — see below.
2. LO = 10 ^ floor(log10(min) − 0.15), HI = 10 ^ ceil(log10(max) + 0.15).
3. Clamp the span to at least two decades and at most five.
4. A value still outside gets the out-of-axis treatment — a value four decades
   from its band is information, not a scaling problem.
5. A module may pin LO/HI for stability across cases; the benzodiazepine module
   pins 0.03–100 to match the approved design.
```

**Zero has to be handled explicitly, because §8.1 made it a real value.** Keeping a quantified
zero distinct from `indeterminate` is right, and it means a ratio can legitimately *be* zero —
whereupon `log10(0)` is `−Infinity` and one such value would collapse the axis for every row
sharing it. A censored `below_limit` interval has the same left endpoint. So zero never enters
the extent calculation, and it renders at the left rim with the out-of-axis marker but its own
label reading `0` rather than "‹ utenfor akse": a zero is not off the left end of this axis, it
is off *every* logarithmic axis, and the label should not imply that a wider view would find
it. Its value cell reads `0`; "—" stays reserved for `indeterminate`.

Decade tick labels are literal strings, never run through the number formatter. Out-of-axis
treatment is unchanged from the handoff: clamp to the rim, widen to 7 px, anchor the label
inside the track. Never clip, never drop.

### 8.4 Formatting

The handoff's precision ladder exactly (`≥100` → 0 dp, `≥10` → 1, `≥1` → 2, else 3 with the
trailing zero stripped), with a locale-aware separator via `Intl.NumberFormat`, following
`WorkbookBackcalcPanel.tsx`. Input parsing goes through the existing `parseLocaleNumber`, not
the prototype's `replace(',', '.')` — that helper already refuses `"1,500"` as ambiguous rather
than silently picking a reading that differs by 1000×, which is the error class this screen
exists to prevent. Non-numeric input leaves the previous value and marks the field invalid; it
does not become `0`.

## 9. Rendering

`RatioProfile.tsx` is a pure function of `RatioProfileViewModel` — the generalisation boundary.
The model carries resolved labels, formatted values, band geometry as percentages, marker
states and finding rows, and no substance identity beyond a display string.

```ts
export interface RatioProfileViewModel {
  provisional: { anyProvisional: boolean; provisionalCount: number; totalBands: number };
  sourceAmbiguity: SourceAmbiguityVM | null;
  specimens: SpecimenGroupVM[];
  contextFields: ContextFieldVM[];
  contextSummary: { missing: number; assumed: number };
  ratioGroups: RatioGroupVM[];           // regime note, rows, artefact flags, withdrawn footnote
  axis: { lo: number; hi: number; ticks: number[] };
  signals: SignalVM[];
  notEstablished: NotEstablishedVM[];
  method: MethodDisclosureVM;
}
```

### 9.1 Tokens

Use the existing variables in `src/index.css`. Three notes:

- the app's `--destructive` is `4 70% 50%` against the handoff's `4 70% 42%`, and
  `--muted-foreground` `210 10% 45%` against `210 12% 45%`. The app tokens win; the difference
  is imperceptible and a second palette is not worth carrying;
- the "faint" tier (`210 10% 58%`) and the row hairline (`#F0F2F2`) have no token. Add exactly
  two — `--muted-foreground-faint`, `--border-subtle` — in both the light and dark blocks.
  These are the only `index.css` changes;
- **dark mode is a real gap in the handoff.** The app ships a dark theme; the design is
  light-only. The hatched band, header gradient and hairlines all need dark values. Define the
  hatch through the two new tokens so it inverts, and check the case marker's contrast against
  the dark band.

### 9.2 Layout and chrome

The 1000 px content column, hairline separation, the 240/1fr/68 ratio grid, the axis insets and
the ~820 px responsive collapse are implemented as specified, in Tailwind bound to the tokens.
Arbitrary values (`py-[5px]`, `w-[240px]`) are acceptable where the design's rhythm is off
Tailwind's scale — this view's rhythm is the design.

The header is the app's existing `Header` + `RootLayout`, not the prototype's bar; the view
name and case identifier render in a subheader beneath it in the same type and colours.

### 9.2.1 Settled: significant digits that decimal notation cannot express

Phase 0 records `reportedDecimals` beside each observation, because `1.50` and `1.5` are the
same JavaScript number and different statements about the assay. That solves the case where the
significant digits fall *after* the decimal point, and it cannot solve the case where they fall
before it. A source reporting `1.50 × 10²` states three significant figures; the value is 150,
which has none to state — there is no decimal rendering of 150 that distinguishes two
significant figures from three. Storing significant digits instead of decimals does not help:
`Intl` renders 150 to three significant digits as `150`.

The only representation that carries it is the one the source used, so closing this would mean
**rendering measurements in scientific notation where the source did** — a decision about how
every number on this screen and in Phase 4's report output looks, not a formatting detail.

**Owner decision, 2026-08-13: decimal notation throughout.** The app reads in decimal and keeps
doing so; the precision a mantissa with trailing zeros states is not carried on screen. The
condition attached to it is the one that matters — *the arithmetic must be right underneath* —
and it is, because nothing here touches the stored value. `reportedDecimals` still records what
the source stated, the ratios are computed from the number and never from its rendering, and a
value entered as `1.50 × 10²` is still exactly 150 to every calculation. What is lost is a claim
about the assay's precision that the screen never made in the first place.

**Two narrow exceptions, where decimal would be false rather than imprecise.** Past `Intl`'s
twenty-fraction-digit limit a decimal rendering prints `0` for a nonzero value, so the
observation would contradict the ratio computed from it — and on a pinned axis, a decade below
that limit either throws on an older engine or draws a hundred-character tick. Both render in
scientific notation, and both are about a number decimal cannot state *at all* rather than one
whose precision it understates. `formatMeasured` and `RatioAxis.tickLabel` carry the limit.

### 9.3 Accessibility

Not covered by the handoff, and required:

- each ratio row carries a text equivalent ("N-desmetyldiazepam ∶ diazepam, 1,45; provisional
  reference band 0,55 to 5,4, median 1,50"), and the Forholdstall section has a
  visually-hidden table alternative;
- the out-of-axis label is already text and needs `aria` association with its row;
- evidence grade is already a word, not only a colour tier — keep it that way;
- case-data row state (missing/assumed/known) gets a visually-hidden state word so the
  distinction survives without colour;
- inline concentration inputs keep the design's `<label>` wrapper and gain `aria-invalid` on a
  refused parse.

## 10. Phasing

Each phase is independently shippable, behind `pattern` in the modeling mode selector, hidden
from the primary nav until Phase 3 (mirroring how `/modeling` is handled today).

### Phase 0 — Engine and registries, no persistence

The four registries, source ambiguity, artefact rules, the resolve/normalise/calculate
pipeline, `profileModel`, and the full view rendering from an in-memory fixture case. Includes
all four content changes in §3.3 — they are module data and cost nothing here, versus a
rewrite later.

**Acceptance.** Ratios `1,45 / 1,79 / 0,212 / 0,461` for the handoff fixture's within-matrix
features, and `3,28 / 5,87` for the two cross-matrix ones — the handoff's `3,71 / 6,64` restated
at spec §11.3's 8.84 mmol/L creatinine reference (§8.1).
Editing a concentration recomputes without a submit. Both §4.1 tests pass, plus the
codeine/morphine ambiguity fixture. No percentile appears anywhere; the only strength
expression is Prøvefortynning's, and it traces to a resolved `thresholdProvenance`. With
`hydro` unset, exactly five of the six features carry the artefact flag and NDD ∶ DZP does not
(§7.4). With no declared exposures, the source ambiguity reads `unresolved`, oxazepam and
temazepam are listed as `contributing` candidates rather than sole-capable ones, and every
signal depending on it degrades. No case reaches a state that lifts that degradation except
`not_applicable` (§7.3.1). "Etterlevelse" appears under "Ikke etablert", not among the signals.

**Delivered** in issue 1068 and issue 1070 (engine, registries, view), issue 1072 and issue 1075 (source ambiguity
and the graph endpoint's first half).

### Phase 1 — Case persistence and history inputs

`patternCaseStore`, `patternCases.ts`, `/api/simulator/cases` with `kind: 'pattern-case'`,
route `/modeling/pattern/:caseId?`, specimen and observation entry, stated dose and time of
intake as `PatternKnownExposure` (A6.6), storage duration and postmortem interval on the
specimen (A4). The `excluded` certainty and per-candidate history coverage are **not** built
here — they exist only to serve resolution, which Phase 5 owns (§7.3.1), and storing them
earlier would invite a resolver to be written against them in the meantime.

Also here, because the analysis cannot run without them and neither exists today: the
**module-scoped metabolism-graph endpoint** (`api/metabolism-graph.ts`, its store and client
wrapper), and the **two metabolism-complete markers** — metabolites-complete and
precursors-complete per substance (§7.3.2). That is **four columns on the drug row**, not two:
`metabolite_edges_rev` and `precursor_edges_rev`, maintained by the trigger, and the two
nullable revisions each marker was asserted against. The assertion columns alone leave the
trigger nowhere to record the graph's current revision, and the equality §13.7 requires has
nothing to compare. Plus the migration, the trigger, store, API, the editor affordances that
set them, and tests. Both are metabolism-side plumbing rather than pattern code, and both gate
Phase 2's acceptance.

**Acceptance.** A case round-trips exactly; censored results stay distinguishable after reload;
time-origin consistency rules (spec §7.3) hold; a case saved before a registry version bump
reopens with a staleness marker rather than silently recomputing. A metabolism edit that adds or
removes an edge leaves **neither endpoint** of it asserting completeness in that edge's
direction (§13.7) — asserted from the resolver's answer, which must move off `not_applicable`,
not from the marker column alone, since the marker stays set and it is the revision equality that
breaks. Tested through **every** writer, not just the editor: a research import, a `seed-drugs`
run, and a drug deletion that un-links rows through `ON DELETE SET NULL` each invalidate the
markers they touch — and only those, so an edge change that moves one direction leaves the other
direction's marker valid. An assertion racing an edge write is refused rather than applied.

**Delivered** in issue 1079: `patternCases.ts`, `patternCaseStore`, the route with `:caseId`, the
entry screen, the two completeness markers with their endpoint and editor panel, and the
module-scoped graph endpoint the case's source walk now reads.

Two departures from the description above, both settled during the work and both recorded in
the PR:

1. **No revision columns and no trigger.** The four columns became two: each digest is computed
   from the edge rows at read time, and only the asserted digest is stored. Every
   cache-maintenance strategy tried lost a race that ended in a marker reading `complete` over
   an unreviewed edge, and the row lock that closed the race deadlocked against the foreign
   key's own `KEY SHARE` lock. Computing the digest on read has no race to lose.
2. **The per-writer acceptance is therefore a shorter list.** It was written against a cache,
   which a writer can bypass; a read-time digest has no bookkeeping to skip. Tested through the
   editor's full-replace writer, the research importer, a drug deletion that un-links an edge,
   and the seed script's delete-and-reinsert shape — the last one pinning that the digest reads
   the edge set's content rather than its rows, so an ordinary re-seed does not lapse every
   marker in the catalog.

### Phase 2 — Second and third modules

Cocaine / benzoylecgonine (the no-band, no-genotype, no-alternative-source case) and
methadone / EDDP (an enzyme-derived field from methadone's CYP2B6/3A4 routes, and a metabolite
`data/substanceClasses.ts` classifies as never administered — "methadone's inactive cyclisation
product, measured to confirm methadone compliance").

**Acceptance.** Both ship with zero changes under `src/components/`. A case spanning two modules
unions their features and context fields without duplication. Methadone's co-medication options
generate from `drug_enzyme_interactions` with no registry edit. Neither module raises a
source-ambiguity statement or a source degradation — both resolve `not_applicable`, which
requires two things and is worth asserting as two: no administrable candidate per
`substance_class`, **and** the module author's completeness assertion on each of its substances,
in each direction that module's walks actually use (§7.3.2). A module shipped without the
assertion the walk needs yields `graph_uncurated` naming the node and the direction, and the
test asserts that too — including the asymmetric case, where a substance marked
metabolites-complete but not precursors-complete still degrades an upstream walk. Neither
marker can be quietly skipped for the next module (§7.3).

### Phase 3 — Atlas binding

Reference tables, `/api/pattern/reference-*`, band resolution by module, the n-gated percentile
tiers, and stratification by living/postmortem and hydrolysis protocol.

**Acceptance.** A band with provenance renders solid with its quantified and censored counts
and evidence tier; every band without one stays hatched and mute. A living cohort never scores
a postmortem case. A band is not matched at all when its `operandSignature` disagrees with the
case's resolved species list element-wise — in species, matrix, measurand mode or reported-as —
or carries an `unknown` mode, nor when its `urineNormalization` differs in basis *or* in
reference value. A composite operand is covered term by term: a cohort whose downstream sum was
assembled from total-after-hydrolysis temazepam does not score a case that measured it free.
Cohort admission accepts a citation whose resolved work kind is a publication and refuses one
that is a dataset, a bare `url`, a `freetext` note, or a DOI whose kind will not resolve — so
the unpublished-dataset route §13.3 declined is closed mechanically rather than by policy, at
the object rather than at the handle (§13.3).
A merge carries a resolved work kind onto the winner and records two that disagree as
`conflicted` — retained, not cleared, since a cleared kind re-resolves through the primary handle
alone and re-admits the source (§13.3). A conflicted citation backs no cohort until a human
settles it.
A citation merge that repoints a cohort leaves it intact, and one that
would collide two cohorts onto one identity tuple is reconciled rather than failing the
constraint — both covered by regression tests. The censoring gate suppresses before the n ladder
is consulted. An aggregate-only source renders as a labelled literature envelope and yields no
percentile, no fold-from-median and no interpolation between its published endpoints; it is
never presented as, nor silently upgraded to, an individual distribution. A band below 20
quantified references renders as a dot strip
with no statistic. §21.4's thresholds and the §7.7 ladder are reconciled in
`patternReference.percentile`, not in two documents. The provisional registry bands are deleted,
not left as a fallback.

### Phase 4 — Wording reuse

Export the same `PatternFinding[]` to report output, closing the handoff's third open item.

## 11. Testing

Beyond the generalisation tests in §4.1:

**Invariants** (property-based where marked):

- *(property)* multiplying every observation in one specimen by a common factor leaves every
  within-matrix feature unchanged, and moves a cross-matrix feature **by the factor or its
  reciprocal according to which side that specimen supplies** — `×f` for a numerator operand,
  `÷f` for a denominator one, unchanged when the specimen supplies both. Asserting `×f`
  unconditionally would fail a correct feature whose scaled specimen sits in the denominator,
  which is half of the cross-matrix features in the diazepam module alone. This is the
  dilution-invariance claim the UI makes in words, asserted in code;
- *(property)* `k` never applies within a specimen, for any registry entry including ones a
  future curator adds — asserted over the whole registry, not a fixture;
- `log10Value` and `rawValue` agree for every feature result;
- a guarded division yields `indeterminate`, never `0`;
- no censoring interval is inverted or empty;
- the registry contains no numeric database id (spec §16.5), validated at load;
- every registry `labelKey` exists in both locale files — extend the existing locale parity
  test rather than adding a second;
- a `withdrawn` feature never produces a row and always produces a footnote;
- *(property)* an artefact rule flags **every in-scope feature whose operands include either
  side of the conversion** — the product *and* the consumed species — and **no** feature whose
  operands all fall outside `appliesTo`. Both halves matter and the fixed diazepam fixture tests
  neither generically: a regression that stopped flagging depleted operands would still pass
  against a module whose only consumed-side feature is TEM ∶ OXA. Asserted by construction over
  the registry, including a synthetic consumed-side-only feature, so a newly added feature
  cannot escape it;
- a signal with `dependsOnSourceResolution` degrades whenever ambiguity is unresolved;
- **completeness is checked at every visited node, not only at the walk's origin** (§7.3.2). The
  fixture is `B → X → M` with `M` observed and precursors-complete, `X` unasserted, and `B`
  administrable: the walk must reach `B` across the recorded `B → X` edge, list it as a
  candidate, and resolve `graph_uncurated` naming `X` — never `not_applicable`, and never an
  empty candidate set. A one-hop check passes this graph while hiding `B` entirely, and a walk
  that stops at `X` hides `B` too, so the test pins both halves: the candidate is found *and*
  the uncurated node is named. Written against the two-hop shape specifically, with its
  downstream mirror one level below the parent.
  Both are cheap to state and neither is reachable from the diazepam fixture, whose graph is one
  hop deep in both directions.

**Provenance gating.** A type-level test (`@ts-expect-error`) asserting
`percentileOf(x, provisionalBand)` does not compile. Plus a render test over an all-provisional
fixture asserting that no percentile or likelihood ratio appears anywhere, and that every
strength expression on screen traces to a `threshold` rule with resolved `thresholdProvenance`
— **exclusively** that, since §7.6 leaves no other source of strength. Naming an
`EstablishedBand` as an alternative provenance here, as an earlier draft of this test did, would
let a regression that invents ENFSI wording from a band position pass the very test written to
forbid it. What the assertion must not become is "no strength appears at all": Prøvefortynning
legitimately renders "Moderat støtte for Hd" in exactly that fixture, on published creatinine
cut-offs and no band; a test demanding its absence would encode a prohibition the handoff does
not make and would fail on correct behaviour (§7.6). A separate test strips
`thresholdProvenance` and asserts the rule degrades to "ikke beregnbar". Plus tier tests at
quantified n = 19/20/99/100/499/500, and censoring-gate tests that must run *before* them:
4 quantified (suppressed); **33 censored of 100 permitted, 34 suppressed** — `33 × 3 = 99` is
short of `100`, so 33/100 sits just below one third, and 34 is the first integer that reaches
it. A `censoredFraction >= 0.33` float comparison would wrongly *suppress* 33, which is the
whole reason spec §21.1 mandates integer cross-multiplication; the test pins the direction so an
implementation cannot quietly drift to the float form. Plus a cohort of 100 with 70 censored,
asserting no statistic is offered despite `n = 100`.

**Signals.** Each threshold boundary at both edges (`c = 2, 4, 20, 30` — the handoff's rule
leaves `2 ≤ c < 4` to the fallback, which is deliberate and needs a test that says so).
Degradation asserted for one, several and all dependencies unknown. The attribution caveat
asserted at one modifier (absent) and two (present).

**Component.** Out-of-axis left and right; the case-data edit flip; recompute on edit; the
responsive collapse; a dark-mode snapshot.

**E2E** (Phase 1+): open a saved case, edit a concentration, see a ratio and a signal basis line
change, reload, see it persisted.

## 12. Deviations from the handoff

Each is deliberate, listed so review can reject any individually.

1. **Route** `/modeling/pattern/:caseId` rather than `/case/:id/profile` — no `/case` namespace
   exists and the pattern spec places this workspace under `/modeling` (§30.1).
2. **Header**: app shell plus a subheader, not the prototype's bar.
3. **Numbers are locale-aware**, not comma-always; the precision ladder is unchanged.
4. **Parsing** via `parseLocaleNumber`, which refuses ambiguous input instead of coercing to 0.
5. **Zero versus indeterminate** are distinct in the engine.
6. **Censoring** is rendered; the prototype does not cover it.
7. **Axis is computed** with a per-module pin preserving the design's exact diazepam bounds.
8. **Dark mode and accessibility** added.
9. **Creatinine** moves from an analyte row to specimen metadata, rendering in the urine group
   as a visually identical metadata row.
10. **Case-data edit mode** keeps the flip-to-select behaviour using the app's `Select`.
11. **From Layer A**: `hydro` defaults to missing rather than assuming "ingen"; "Etterlevelse"
    is demoted out of the signal list; the `tem_oxa` basis line drops its causal attribution;
    a source-ambiguity statement and artefact flags are added to the view.
12. **The creatinine reference is spec §11.3's 8.84 mmol/L**, not the handoff's 10, and is one
    convention per case rather than a per-module pin — two conventions cannot coexist in a
    multi-module case. The handoff's cross-matrix figures restate as 3,28 and 5,87; the
    within-matrix ratios are unchanged (§8.1).

## 13. Open questions

1. **Case identity.** The handoff shows `Diazepam · sak SYNTHETIC-DIAZEPAM-001`. Kinetix cases are
   user-owned rows with a title — is there an external case-number field to surface?
2. **Who curates a module?** The registries are source-controlled, so adding a drug family is a
   PR. Acceptable long-term, or should signals eventually move to a reviewed database table
   like parameters and facts?
3. ~~**Local casework as reference data — a governance conflict.**~~ **Decided (owner,
   2026-08-12): published sources only.** Layer A (A5) asked for bands rebuilt on OUS/FHI DUID
   and TDM casework, and the technical route existed — admit it as a licensed dataset under a
   URL handle with a dataset hash, `cohort_type: DUID` or `postmortem`, and an admitting admin.
   It is not taken. Pattern spec §18.0's "published sources only" stands as written, and
   `pattern_reference_cohorts.citation_id` stays `NOT NULL`, so Phase 3 needs no governance
   decision and no new legal basis before it can start.

   **`NOT NULL` does not enforce this, and Phase 3 must.** The declined route is a citation —
   `citations.type` is `'freetext' | 'url' | 'pmid' | 'doi'`, and a dataset under a URL handle
   is a perfectly valid `url` row — so a constraint that only demands *a* citation admits the
   exact source this decision refuses.

   **But the handle is not the classification either.** `citations.type` records which
   identifier a citation is keyed by, ranked by durability in
   `CITATION_HANDLE_PREFERENCE` — it says nothing about what the identified object *is*.
   Datasets carry DOIs; that is the normal way to publish one. So admitting every `doi` would
   re-admit the licensed-dataset route through its front door, one handle up from the `url` this
   check was written to refuse. What has to be validated is the resolved **work kind**, which
   Kinetix currently discards: `api/_lib/crossref.ts` reads title, authors, container, year,
   volume and pages from the Crossref record and drops `work.type`.

   Phase 3 therefore persists the work kind on the citation, populated by the Crossref adapter
   and by the PubMed path, and admission allows only publication kinds — journal article,
   proceedings article, book chapter and the like — refusing `dataset`, `database`, `component`
   and `peer-review`. **A DOI whose kind cannot be resolved is refused, not assumed**, since the
   whole point is to stop an unpublished object entering on the strength of having an
   identifier. Tested with a dataset DOI, not only with a `url` citation: the `url` case was
   never the hard one.

   **"Not yet resolved" is not "not a publication", and the schema starts out full of the
   first.** Every citation already in the table predates the column, and nothing re-derives it:
   `handleCreate` in `api/references.ts` returns an exact existing row *before* calling the
   resolvers, treating stored rows as a local cache, so reuse never refreshes metadata. A
   fail-closed rule applied to a null kind would therefore refuse every reference the catalog
   already holds — including the journal articles this atlas is supposed to be built from. So
   Phase 3 ships a backfill that re-resolves the kind for existing `pmid` and `doi` citations,
   in the shape `scripts/backfill-substance-classes.ts` already establishes, **and** admission
   resolves lazily when it meets a null: fetch the kind, store it, then judge. Refusal is what
   happens after asking, never instead of asking.

   **The merge has to carry the kind, or the answer is lost the moment a DOI folds into a
   PMID.** `mergeCitations` selects `id`, `type`, `identifier` and `metadata`, updates the
   winner's metadata and deletes the loser — a new column is simply dropped, so a resolved DOI
   row folded into a stronger PMID row whose kind is still null leaves the merged citation
   unclassified. Admission would then re-resolve it, or fail closed during an upstream outage,
   having already had the answer. So the merge preserves a non-null kind onto the winner. Two
   non-null kinds that agree stay as they are; two that disagree are **recorded as a conflict**,
   not discarded. Clearing them to null was the first answer here and it was wrong: null means
   "nobody asked", and the lazy resolution it routes into dispatches on the citation's *primary*
   handle, which after promotion is the PMID. So the re-resolve would ask PubMed, hear "journal
   article", and admit the cohort — throwing away Crossref's `dataset` verdict on the way. The
   remedy would have permitted exactly the source it was written to block.

   **Providers do not speak one vocabulary, so the comparison is on canonical values.** Crossref
   returns a single `work.type` (`journal-article`); PubMed returns a `pubtype` *array* mixing
   object kind with study design (`Journal Article`, `Randomized Controlled Trial`). Compared
   raw, an ordinary article resolved through both handles disagrees with itself and every one of
   its cohorts is refused — the gate failing closed on exactly the sources it exists to admit. So
   each provider's vocabulary maps into one canonical kind before anything is compared, study
   design is ignored as a different axis entirely, and only canonical values are stored and
   contrasted. **The enum's membership and the two mapping tables are Phase 3 work**, settled
   once against live Crossref and PubMed responses rather than guessed here; what this plan
   fixes is that the mapping exists and that the comparison never touches a raw provider string.

   **The classification is a claim about a handle set, so it expires when that set changes.**
   This is the general rule, and it is worth stating once rather than meeting it one path at a
   time: a merge is only the loudest way the handles move. `resolveCitation` folds new
   identifiers into `metadata.altIds` on an existing row in place, so a PMID row classified as
   an article can quietly acquire a DOI that resolves to a dataset, with no merge and no null to
   trigger a re-resolve. Any change to a citation's handle set — merge, promotion, or an altIds
   expansion — therefore returns `work_kind_status` to unresolved. Same shape as the completeness
   markers in §13.7: a claim about a set of edges, invalidated when the set moves, re-earned by
   asking again.

   Four consequences, all stated as invariants because enumerating the paths is what keeps
   failing here.

   **The reset is enforced where the handle set lives** — a trigger on `citations`, for the
   reason table-level enforcement won the same argument in §13.7: the named writers are never all
   of them. `PATCH /api/references` writes `citations.metadata` directly, altIds included, so a
   rule implemented in the resolver and the merge would already be bypassable by a supported
   endpoint on day one.

   **Matching reads the current status, not the status at admission.** A cohort whose citation is
   not *currently* a resolved publication contributes nothing — skipped by band matching exactly
   as an unprovenanced band is (§7.7), which needs no quarantine pass and no revalidation sweep
   over already-admitted rows. Deferring to "the next admission" would have left a cohort scoring
   cases on a classification that had already expired, since admission happens once and matching
   happens on every case.

   **Resolution is bound to the handle set it examined — the same protocol §13.7 uses, not a
   second one.** A resolve that starts before a concurrent merge or `PATCH` adds a handle would
   otherwise read the old set, be marked unresolved by the trigger, and then write `resolved`
   over the top: a publication verdict that never looked at the new DOI, and no further handle
   change to trigger another reset. So `citations` carries a `handle_set_rev` bumped by that same
   trigger, and the classification write is conditional on it — `UPDATE … SET work_kind = …,
   work_kind_status = 'resolved' WHERE id = $1 AND handle_set_rev = $observed`, zero rows meaning
   the handles moved mid-resolve and the work is redone. Marker-against-edges and
   classification-against-handles are one mechanism used twice; Phase 3 should implement it once.

   **Shrinking the handle set must not erase the verdict it produced.** `PATCH /api/references`
   stores `metadataToStore` wholesale and `mergeReferenceMetadata` does not carry `altIds`, so
   patching a `conflicted` PMID-article + DOI-dataset citation can drop the DOI, reset the
   status, and let resolution consult only the surviving PMID — the cohort re-admitted by
   deleting the evidence against it. Metadata writes therefore preserve aliases, removal being an
   explicit operation rather than a side effect of a patch; and a `conflicted` status is **sticky
   across a handle-set shrink**, cleared only by a human reconciling it. Adding a handle re-opens
   the question, removing one does not answer it — the asymmetry migration 0099 already applies
   to contradicting duplicate groups.

   Conflict is therefore a state of its own: `work_kind_status` of `resolved`, `unresolved` or
   `conflicted` beside the kind. A conflicted citation is **refused at admission and surfaced for a human**,
   because two registries disagreeing about what an object *is* is a curation question, not
   something a retry settles. And lazy resolution consults **every handle the row carries**, not
   just the primary one — a citation keyed by PMID with a DOI in `metadata.altIds` is asked
   through both, and a disagreement between them lands in `conflicted` rather than being decided
   by which handle happened to be stronger. Covered by an alias-merge test in Phase 3 alongside
   the cohort-repointing ones §5 already requires, plus one pinning that a PMID-primary row
   whose DOI resolves to a dataset is refused.

   If a genuinely published source turns out to carry no resolvable publication identifier, the
   answer is to reopen this question with that case named — not to leave the gate at admin
   discretion, which is the discretion the decision exists to remove.

   The cost is real and belongs in Phase 3's planning rather than in a footnote: the atlas is
   bounded by what the literature reports, which for several of these ratios is thin, and A5's
   objection to uninterpretable bands is *not* answered by this decision — it is answered by
   §7.7's provenance gate, which blocks every statistic on a band that has no source. If that
   proves too thin in practice, the decision to revisit is a governance one, not an engineering
   one, and it reopens here.

   **This decides where a band's numbers may come from, and nothing else.** It does not decide
   what a ratio renders as while it has no admitted cohort — hatched provisional placeholders
   or a case marker on a bare axis — which is §13.10, still open. Phases 0–2 ship the
   `provisionalBands.ts` placeholders the handoff chose, with every statistic blocked by the
   type system, and Phase 3 deletes them; if §13.10 later settles on the bare axis, it settles
   it for those phases too. Read together, the two questions do interact: with casework
   declined, the placeholders survive on screen longer than they would have otherwise, for any
   ratio the literature never covers. That is an argument to answer §13.10, not a reason to
   pre-empt it here.
4. ~~**Layer B.**~~ **Decided (owner, 2026-08-12): show both, assert neither** — §3.4. Raw and
   creatinine-normalised variants are shown as separate quantities, and the plan no longer
   treats this as a placeholder awaiting Layer B. `k` is still computed, recorded in the
   manifest and used in band matching (§8.1), so the correction remains available to a later
   module flag if B2 ever lands and argues it is redundant within-subject.
5. **`history` option list.** Universal field with module-extendable options, or module-scoped
   field? This plan assumes the latter; the former is tidier if the option lists turn out to be
   identical across modules.
6. **Source resolution is deferred to Phase 5, and that is a scope call worth confirming**
   (§7.3.1). This release states the ambiguity and never settles it, so a diazepam case whose
   prescription history genuinely answers the question still carries a degradation line. The
   alternative — resolving it here — needs the full predicate §7.3.1 records, which is pattern
   spec §23's Source Resolver under another name. If holding that line is too conservative for
   real casework, the decision is to pull §23 forward rather than to approximate it. The two
   type amendments it needs (an `excluded` certainty, and per-candidate history coverage) also
   need a home: an edit to `2026-08-10-case-pattern-explorer.md`, or a documented extension
   here. They should not stay described in only one of the two.
7. ~~**A metabolism-complete marker (§7.3.2).**~~ **Decided (owner, 2026-08-12): two markers,
   per drug and direction** — metabolites-complete and precursors-complete, asserted separately
   and consumed separately: §7.3's downstream enumeration reads the first, its upstream
   enumeration the second, and its coverage classification reads the first again on each
   candidate, so an upstream candidate needs both markers on different nodes (§7.3.2). The
   module author asserts them, as part of
   shipping a module, through the same review workflow as the metabolism data itself; Phase 1
   builds both columns. `hasMetabolismData()` remains unfit for this and is not reused — it is
   satisfied by a single elimination route or a bare evidence note, so it answers "has anyone
   touched this?" rather than "has anyone finished it?".

   **A stale assertion must not be merely discoverable — it must not resolve
   `not_applicable`.** An edge can appear or vanish under a marker asserted last month, and a
   gate that keeps trusting it suppresses the very source warning it exists to raise. Phase 1
   therefore owes a guarantee, not an affordance.

   **The guarantee has to live in the database, because the writers are not one path.**
   `replaceDrugMetabolism` is the obvious one, but `researchImportStore` inserts into
   `drug_metabolites` directly, `scripts/seed-drugs.ts` and the farmakologiportalen importer do
   too, and deleting a drug mutates links nobody named: `metabolite_drug_id` is
   `ON DELETE SET NULL`, so removing substance `B` silently un-links every row pointing at it
   while the parent's metabolites-complete marker stays set, and `parent_drug_id` cascades. A
   rule anchored to one store would be bypassed by four paths on day one, two of them without
   any Kinetix code running at all. So the invalidation is a trigger on `drug_metabolites`
   bumping a revision counter on **both endpoints** of the touched row — the junction is shared,
   so editing `M`'s precursors writes rows whose parent is `P`. The FK's own `SET NULL` fires it
   as an update, which is precisely why the rule is written at that level.

   **Completeness is a claim about which edges exist, so only topology bumps it.** Insert and
   delete bump unconditionally; the update arm fires only when `parent_drug_id` or
   `metabolite_drug_id` actually changes — and then bumps from **`OLD` and `NEW` both**, which is
   up to four nodes. Retargeting `P1 → M1` to `P2 → M2` is a delete and an insert wearing one
   statement: `P1` lost a metabolite and `M1` lost a precursor just as surely as if the row had
   been removed, and a trigger reading only `NEW` would leave both of their markers valid over a
   graph missing the edge they were asserted against. The `ON DELETE SET NULL` case is the same
   shape with `NEW.metabolite_drug_id` null, which is why it has to be the update arm's rule
   rather than a special case beside it. The regression test retargets an edge; insert and delete
   alone would pass a trigger with this bug. Bumping on any column would invalidate correct
   assertions over edits that leave the edge set identical — and not rarely: `mergeCitations`
   rewrites `reference_ids` **in this table**, so an ordinary DOI→PMID merge would reset the
   markers on both endpoints of every affected edge and report `graph_uncurated` across those
   modules until a curator reasserted them by hand. A gate that cries wolf on routine citation
   housekeeping is one curators learn to click through, which costs more than the edits it was
   guarding.

   **Two counters per drug, not one**, matching the two markers: a `P → M` row bumps
   `metabolite_edges_rev` on `P` and `precursor_edges_rev` on `M`, and nothing else. A single
   per-node counter would invalidate `P`'s precursors-complete over an edge that changed only
   `P`'s metabolite set, so the resolver would report `graph_uncurated` on a direction nobody
   touched — surrendering the independence the two markers exist to provide, at the one moment
   the curator was right.

   **A counter, not a timestamp, and each marker records the revision it was asserted against.**
   `now()` is fixed at transaction start in PostgreSQL, so an import that begins first, pauses,
   and inserts its edge after an assertion has committed would stamp an edge change *older* than
   the marker — leaving a stale marker looking fresh, which is the exact failure this mechanism
   exists to prevent, reintroduced by the clock. Validity is therefore equality, not ordering:
   `metabolites_complete_rev = metabolite_edges_rev` and likewise for precursors. Any bump in
   either direction of time breaks the equality.

   **And asserting completeness must not race a concurrent edge write.** A curator reviews the
   graph, an import adds an edge, and the assertion commits afterwards vouching for a graph
   nobody reviewed — with `not_applicable` back on the table. The assertion is therefore a
   conditional write carrying the revision the curator was shown:
   `UPDATE … SET metabolites_complete_rev = $observed WHERE drug_id = $1 AND
   metabolite_edges_rev = $observed`. Zero rows updated means the graph moved under the review,
   which is a `409` and a re-read, not a retry. Both counters live on the drug row the assertion
   writes, so the two statements contend for one row lock and the loser re-evaluates its `WHERE`
   against the winner's committed value — the ordering is enforced by the database rather than
   assumed. That matters because it holds against writers that take no lock, and the importers
   take none, so a `pg_advisory_xact_lock` on the assertion path alone would not have closed
   this.

   **The read the curator reviews has to be one snapshot, too.** The conditional write is only
   as good as the pairing of graph and revision it is given: if the endpoint reads the links in
   one `READ COMMITTED` statement and the counters in the next, an edge write committing between
   them hands the curator the old graph with the new token — and the assertion then succeeds,
   because the token does equal the current counter. The graph and its two revisions therefore
   come back from a single statement, or from one `REPEATABLE READ` transaction. Where that is
   awkward, the counters are read **first**: an interleaved write then leaves the token behind
   the graph, which fails the equality and costs a spurious `409`. Never the other order, which
   fails silently in the direction that matters.
8. **Per-edge enzyme attribution.** §7.5 curates enzyme→feature effects per module because no
   table associates an enzyme with an individual metabolite edge. Adding that association to
   `drug_metabolite_links` would make the effects derivable and retire the curated table — a
   schema change with its own review workflow, so it belongs in pattern spec §14.3 alongside
   `source_specificity` and `formation_role` rather than here. Worth deciding before a third
   module curates the same shape a third time.
9. **One threshold ladder, not two.** §7.7's tiers are deliberately stricter than spec §21.4's,
   on Layer A's evidence. Both are product defaults and belong in `patternReference.percentile`
   together. Phase 3 owns the reconciliation, but the decision on which ladder wins is a
   scientific one.
10. **Provisional bands in production.** Shipping placeholder percentiles — hatched, with every
   statistic blocked — still puts numbers on screen that no source backs, and Layer A calls
   them uninterpretable. The alternative is no band until the atlas exists: the case marker on
   a bare axis. The handoff chose the former; given A5, this is worth reconfirming, because the
   hatching carries the entire warning.
