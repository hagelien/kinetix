# Skill reference files

Two files the `kinetix` skill reads before authoring a bundle.

## `vocabularies.md`

**Generated — do not edit.** Written by `npm run skill:reference` from the live
parameter registry, monograph sections, matrix/scenario enums and qualifier
operators. `npm run skill:reference:check` fails when it has drifted.

The skill runs in a chat window with no connection to this repository, so these
closed lists are the only thing standing between it and an invented parameter id.
Regenerate it whenever `src/lib/drugParameters.ts`,
`src/lib/monographSections.ts` or `src/lib/referenceConcentrations.ts` changes.

## `example-bundle.json`

The shape a model copies. Validated on every test run
(`src/lib/conversationIngestion.test.ts`), so it cannot rot into an invalid
example.

**The citations are real; the attestations are illustrative.** The three sources
(PMID 2719903, PMID 34773819, PMID 10201674) exist and the reported values are
theirs, but the `readInFull: true` attestations and the review text were written
to demonstrate the contract — they are not a Kinetix paper review anyone stands
behind. Do not copy the entries themselves into a real bundle; copy the
structure and verify your own sources.

It also demonstrates the two-source rule and the `requiresMinMax` shape rule
together, which is why it is shaped the way it is: two independent studies
each report a real oral bioavailability figure for morphine, but neither can
enter as a `parameter_observation` — one gives only a point estimate with no
reported interval, and `bioavailability` rejects an entry missing `low`/`high`
(see the "low & high" column in `vocabularies.md`); the other reports a real
interval but would then stand as the parameter's only entry, which the
two-source rule also refuses. Both real numbers are published anyway, as
`wiki_fact` prose rather than fabricated bounds, and `blockedCandidates`
names why each was excluded as a structured observation. `tmax` — verified in
only one of the three sources — sits in `blockedCandidates` the same way,
instead of entering as a lone observation.

## Validating output

```sh
npm run validate:ingestion -- bundle.json    # file
pbpaste | npm run validate:ingestion         # clipboard
```

A pass means the JSON is well-formed, source-verified and de-identified. It does
not mean anything was submitted — no ingestion endpoint exists yet. See
`docs/superpowers/plans/2026-08-05-conversation-to-kinetix-skill.md`.
