# Conversation-to-Kinetix skill and ingestion gateway

**Date:** 2026-08-05  
**Status:** Phase 0 implemented (2026-08-06); admin path implemented (2026-08-07); MCP phases proposed  
**Scope:** Portable Agent Skill, Kinetix ingestion contract, MCP/API gateway, admin JSON fallback

> **Where this actually stands.** Phase 0 is done — `src/lib/conversationIngestion.ts`
> defines and validates the bundle and `npm run validate:ingestion` checks one —
> and the **admin path now exists**: `api/_lib/conversationIngestionStore.ts`
> resolves a bundle against live data, `POST /api/conversation-ingestion` serves
> the plan and the apply, and Admin → Ingest conversation puts every item behind
> its own checkbox. See `docs/conversation-ingestion.md`.
>
> That path deliberately **departs from the disposition design below**. This plan
> routed wiki facts through `pending_edits` for independent review because it was
> written for an *agent* actor. The implemented path is admin-only and the
> per-item acceptance gate IS the review: an admin already holds publish
> authority, reads each statement next to the live state it would change, and
> ticks it. Facts are still written *through* the pending-edit approval path
> (staged and approved in the same request) so the splice, revision and conflict
> machinery stay shared and the row records who accepted what.
>
> Idempotency landed without the `conversation_ingestion_runs` table: apply
> re-plans every accepted item against current state before writing, so a
> re-applied bundle resolves as `duplicate` and writes nothing. The database is
> the record; a run table would only restate it.
>
> Still absent: every MCP tool. An assistant cannot resolve a `factId`, `pageId`
> or the live registry itself, so `replace`/`remove` facts remain effectively
> unauthorable from a conversation and the skill routes them to
> `blockedCandidates`. `parameter_entries.context` is also still unbuilt — the
> admin path folds study context into the entry's `comments` meanwhile.

## Goal

Turn the scientifically relevant content of the current ChatGPT or Claude conversation into properly sourced Kinetix knowledge without giving a model broad database privileges.

The user-facing invocations are:

- `@kinetix` in ChatGPT or `/kinetix` in Claude: infer every relevant Kinetix update across drugs, parameters, monographs, and topic pages.
- `@kinetix parameters`: restrict output to source-level drug parameter observations.
- `@kinetix wiki`: update a matching page with atomic facts, or propose a new topic page when no suitable page exists.
- `@kinetix monograph`: restrict wiki work to one or more drug monographs.
- `@kinetix json`: verify and return the portable ingestion bundle without writing.
- `@kinetix dry-run`: resolve targets and run the authoritative server preview without applying it.

The same `SKILL.md` is used by both platforms. Claude discovers it from `.claude/skills/kinetix/`; that folder can also be zipped as `kinetix/` and uploaded as a ChatGPT skill.

## Non-goals

- The conversation is not a scientific source.
- The model does not write directly to `drug_parameters`, `wiki_pages`, or arbitrary tables.
- This does not replace the whole-drug `kinetix-deep-research-output-v1` seed importer. That importer remains the operator/admin bootstrap path for a new drug.
- The first version does not automatically merge incompatible study contexts into one preferred canonical estimate.
- Raw conversations, patient details, case numbers, names, exact dates, and other identifying data are never persisted.

## Existing Kinetix primitives to reuse

The codebase already contains most of the scientific and governance machinery this feature needs:

1. **Per-source parameter observations**
   - `parameter_entries` stores one reported value per source.
   - `src/lib/parameterEntries.ts` validates registry ID, unit, bounds, matrix, scenario, sample size, qualifiers, and source.
   - `api/_lib/parameter-entries-store.ts` detects exact duplicates, aggregates entries with paper-review weighting, normalizes matrices, caches summaries in `drug_parameters`, and records `drug_parameter_revisions`.
   - `api/parameter-entries.ts` sends contributor/agent writes to `pending_edits`; admin writes can publish directly.

2. **Atomic wiki facts**
   - Drug monographs and topic pages use `wiki_pages` and `wiki_revisions`.
   - Non-admin contributors submit `wiki_fact` operations through `api/pending-edits.ts` rather than replacing whole pages.
   - Drug monographs have stable section IDs from `src/lib/monographSections.ts`: `pd`, `pk`, `metabolism`, `medical_use`, `non_medical_use`, `effects`, `toxicity`, `analytical`, and `forensic`.
   - Topic-page headings have stable section IDs.
   - Fact IDs are minted server-side; replace/remove operations use optimistic anchors.

3. **Reference verification**
   - `citations` deduplicates PMID, DOI, URL, and free-text references.
   - `paper_reviews` and `paper_review_revisions` preserve the current appraisal and its history.
   - Agent-authored facts and parameters are already gated on a resolvable source with `readInFull=true`.
   - Missing full text can flow through the existing PDF-request machinery.

4. **Review, provenance, and independent verification**
   - `pending_edits` handles parameter, parameter-entry, wiki-fact, wiki-section, and new-page proposals.
   - Revisions, approvals, disputes, and agent verifications are already first-class.
   - Agent-authored pending edits can auto-apply after independent agent consensus, while self-verification is prohibited and open disputes block publication.

5. **Agent identity**
   - Kinetix already issues revocable, expiring `kxat_` agent tokens and caps agent-backed accounts below admin authority.
   - Authentication currently resolves those tokens from the Kinetix auth cookie. The MCP gateway needs a shared resolver for `Authorization: Bearer kxat_…` rather than promoting an agent to admin or relying on the browser cookie.

6. **MCP transport**
   - `api/mcp.ts` is already a stateless Streamable HTTP MCP endpoint.
   - `api/_lib/mcp.ts` provides the Zod-backed tool registry and tool annotations.
   - The current endpoint exposes PubMed tools behind `MCP_BEARER_TOKEN`.

7. **Manual JSON import pattern**
   - Admin → Seed drug and `api/research-import.ts` already demonstrate upload/paste, server preview, and shared browser/CLI validation.
   - The conversation-ingestion fallback should copy this interaction pattern while using a separate contract and the normal review machinery.

## Architectural decision

Build one versioned, de-identified ingestion bundle and one authoritative domain service. Expose that service through both MCP and an admin JSON pane.

```text
current conversation
      │
      ▼
portable kinetix SKILL.md
      │ independently retrieve and read sources
      ▼
kinetix-conversation-ingestion-v1 bundle
      │
      ├── MCP: preview/apply with kxat_ bearer identity
      │
      └── Admin: paste/upload the same JSON
             │
             ▼
conversation ingestion domain service
      │ resolve + validate + reclassify against current DB state
      ├── auto_add
      ├── review_required
      ├── noop
      └── rejected
             │
             ├── citations / paper reviews
             ├── parameter_entries + derived parameter revisions
             └── pending_edits for semantic or conflicting changes
```

The model's proposed disposition is advisory. Kinetix always recomputes the disposition from current database state immediately before applying.

## Why not reuse the deep-research seed importer directly

`kinetix-deep-research-output-v1` is intentionally a whole-drug, admin/operator import that bypasses the pending-edit queue. Its parameter values write authored fallbacks to `drug_parameters`; it does not create one `parameter_entries` row per paper. That is appropriate for bootstrap seeding, but wrong for incremental chat-derived evidence.

Conversation ingestion must instead:

- add each verified study observation to `parameter_entries`;
- preserve its study context;
- let the existing aggregation pipeline derive the displayed value;
- route replacements, aggregate-moving additions, ambiguous matches, and semantic edits through review;
- remain idempotent across MCP retries.

## Scientific verification contract

The skill treats conversation content only as a list of hypotheses and candidate claims. Before any item is eligible for application, it must:

1. Resolve the source to a stable PMID, DOI, or authoritative URL.
2. Obtain and inspect the relevant full text. An abstract alone cannot support an automatically committed quantitative parameter.
3. Confirm that the source actually concerns the intended analyte, salt/base, stereoisomer, route, formulation, population, species, and matrix.
4. Record an exact evidence locator: table/figure/section/page plus a concise paraphrase of what was observed.
5. Distinguish `reported`, `digitized`, `calculated`, `modeled`, and `inferred` values.
6. Preserve dose, regimen, route, formulation, population, sample size, study design, sampling window, matrix, analytical method, and postmortem context when relevant.
7. Check corrections/retractions and reconcile DOI/PMID identity.
8. Create or update the Kinetix paper review with an explicit `readInFull` attestation. If full text is unavailable, file a PDF request or return JSON for later completion; do not submit the dependent fact or parameter.
9. Prefer primary sources for numeric observations. Reviews, guidelines, labels, and textbooks may support synthesis or clinical/forensic prose, but should not be presented as if they were a primary reported observation.
10. Never average incompatible contexts merely to produce one number.

## Portable bundle

Add `src/lib/conversationIngestion.ts` with a Zod schema and exported types for:

```ts
schemaVersion: 'kinetix-conversation-ingestion-v1'
idempotencyKey: string
mode: 'auto' | 'parameters' | 'wiki' | 'monograph'
conversationDigest: string // opaque hash only; never raw chat
createdAt: ISO datetime
sources: IngestionSource[]
items: IngestionItem[]
```

### Sources

Each source carries:

- a client-local key;
- citation type and normalized identifier;
- bibliographic metadata as a hint only (Kinetix resolves authoritative metadata where possible);
- verification status;
- full-text locator and concise evidence paraphrase;
- paper-review payload and edit summary;
- whether a PDF request is needed.

### Parameter observation item

The item identifies the drug with an exact Kinetix ID when available plus identity checks such as PubChem CID and preferred name. It carries:

- live parameter-registry ID;
- low/high/median/qualifier and original unit;
- matrix and interpretive scenario where required;
- sample size;
- one source key;
- structured study context;
- derivation type, equation, assumptions, and uncertainty when not directly reported;
- short edit summary.

Do not hardcode the parameter registry into the skill. The MCP context tool returns the live IDs, units, bounds, and matrix/scenario requirements.

### Wiki fact item

The item carries:

- target page ID and page type when resolved;
- target section ID;
- operation (`add`, `replace`, or `remove`);
- a single atomic fact statement;
- source keys;
- existing fact ID for replace/remove;
- optional TipTap-safe rich content;
- edit summary;
- the target revision/version observed during preparation.

A factual paragraph containing several independently contestable claims is split into several fact items.

### New topic page item

A new-page proposal carries title, candidate slug, parent/category suggestions, initial section structure, and atomic fact items. It never publishes directly in version 1.

### Privacy invariant

The schema rejects a raw conversation field. The skill removes case identifiers and unnecessary incident-level details before producing the bundle. The persisted audit record stores only the normalized de-identified bundle, its digest, and application results.

## Preserve richer parameter context

`parameter_entries.comments` is currently the only place to put the study context of non-concentration parameters. That is inadequate for robust automated comparison of, for example, oral single-dose terminal half-life versus repeated-dose effective half-life.

Add an optional `context jsonb NOT NULL DEFAULT '{}'` column to `parameter_entries`, typed and validated through `src/lib/parameterEntries.ts`. Initial fields:

- `analyte`
- `saltOrForm`
- `route`
- `formulation`
- `dose`
- `regimen`
- `population`
- `species`
- `studyDesign`
- `studyArm`
- `samplingWindow`
- `model`
- `analyticalMethod`
- `postmortemContext`
- `sourceLocator`
- `derivation`

This is additive: existing rows normalize to `{}` and current aggregation remains functional. Include a canonical context fingerprint in exact-duplicate detection so two study arms can coexist while a retried insert cannot be double-counted.

Context-aware subgroup summaries are a later enhancement. Version 1 remains conservative: if an observation would move the displayed aggregate or appears incompatible with the currently pooled context, it is queued for review.

## Authoritative disposition rules

### General rules

- **noop**: exact citation/item already exists, or the proposed fact is semantically and textually already represented with the same evidence.
- **rejected**: invalid identifier, unknown parameter ID, invalid unit/bounds, absent full-text verification, unresolved target, privacy failure, or stale/incorrect identity.
- **review_required**: ambiguity, replacement/removal, conflict, aggregate movement, new entity/page, incompatible contexts, or any case where the server cannot prove safety mechanically.
- **auto_add**: only narrowly defined additive operations that pass deterministic checks.

The server returns reason codes, not only prose, so the skill and admin UI can report outcomes reliably.

### Parameter observations

Use the existing registry validator and the same `aggregateEntries` implementation used in production.

1. Resolve the exact drug and parameter.
2. Resolve/upsert the citation and ensure its current paper review satisfies the agent reference gate.
3. Validate the entry and structured context.
4. Run existing exact-duplicate detection. A duplicate is `noop`.
5. Compute the current aggregate and a simulated aggregate including the proposal.
6. Compare a scientific-value projection (`min`, `max`, `median`, `unit`, and qualifier), excluding generated notes/source counts.
7. Classify as `auto_add` only when one of these holds:
   - the parameter currently has no authored value and no source entry, so the observation fills an empty slot without displacing knowledge;
   - the source entry is additive and the scientific-value projection remains exactly unchanged after canonical normalization;
   - the only current value is a grandfathered authored fallback and the new source observation reproduces that value exactly after normalization.
8. Classify as `review_required` when:
   - the aggregate changes;
   - a same-context source materially disagrees;
   - the new observation would replace a hand-authored fallback;
   - context is incomplete or incompatible;
   - the value is derived by a method not approved for deterministic ingestion.

An `auto_add` parameter entry is inserted through a narrow service method, followed by the existing transactional recompute/revision/approval path. It is attributed to the agent and remains eligible for post-publication peer verification. The agent is not granted admin role.

A review-required observation becomes a normal `param_entry` create proposal in `pending_edits`, with the full context and references preserved.

### Wiki and monograph facts

Semantic non-conflict cannot be proven safely by a single model and a numeric comparator. Therefore:

- all new or changed wiki facts are submitted as `wiki_fact` pending edits;
- an additive fact with an exact target and no detected overlap is marked `consensusEligible=true` and may publish through the existing independent-agent consensus path;
- replacements, removals, ambiguous targets, conflicts, and new topic pages carry `requiresHumanReview=true` in `proposedMeta`;
- `applyOnAgentConsensus` must refuse any pending edit carrying `requiresHumanReview=true`, just as it already refuses clinical cases;
- an open dispute always blocks automatic application;
- the authoring agent cannot verify its own proposal.

For the user's purposes, an additive wiki fact is therefore automatic after independent verification, not a privileged single-agent direct write.

Drug monographs should already exist because Kinetix creates a stub with each drug. If a valid drug is missing its monograph because of historical drift, call the existing `ensureDrugMonograph` invariant repair; do not treat that as permission to publish substantive content.

A genuinely new topic page is queued as `wiki_new` by the ingestion domain service. The regular non-admin route remains unchanged and continues to prohibit whole-page submissions.

## Idempotency and audit

MCP clients retry. Existing exact-duplicate guards protect parameter entries, but not a batch containing several wiki proposals. Add a small `conversation_ingestion_runs` table:

- `id`
- `idempotency_key` (unique)
- `bundle_hash`
- `schema_version`
- `mode`
- `status` (`processing`, `completed`, `failed`)
- `normalized_bundle` (de-identified JSONB)
- `result` (JSONB item outcomes and created IDs)
- `created_by`
- `created_at`, `updated_at`

Apply behavior:

- same idempotency key + same hash returns the prior result;
- same key + different hash returns `409 idempotency_key_reused`;
- classification is recomputed inside the apply transaction rather than trusted from preview;
- stale page/fact revisions are reclassified to review or rejected;
- no raw chat is stored.

## MCP design

Keep the existing endpoint and preserve backward compatibility:

1. `MCP_BEARER_TOKEN` continues to authenticate the existing PubMed-only server.
2. `Authorization: Bearer kxat_…` resolves a live, non-revoked, non-expired active agent through a new exported bearer resolver in `api/_lib/auth.ts`.
3. Kinetix ingestion tools require membership in a dedicated user group such as `kinetix-ingestion`. Existing group membership in `AuthContext` gives a capability boundary without making the agent admin or adding broad token scopes in the first version.
4. Construct the combined MCP server per request so tool closures receive the authenticated `userId`, role, groups, and agent identity.
5. Continue using `readBodyStream`, CORS bearer semantics, body caps, and rate limiting from `api/mcp.ts`.

### Tools

Expose a small workflow-oriented surface rather than raw table CRUD:

- `kinetix_search_knowledge`
  - Search drugs, aliases/PubChem IDs, wiki pages, citations, and biological entities.
  - Read-only.

- `kinetix_get_ingestion_context`
  - Return exact target snapshots: drug identity, monograph/page IDs and versions, section/fact IDs, current parameter values, source entries, current sources/reviews, and the live parameter-registry constraints.
  - Read-only.

- `kinetix_preview_ingestion`
  - Validate the bundle and return item-by-item `auto_add`, `review_required`, `noop`, or `rejected` with reason codes and predicted effects.
  - Read-only with respect to scientific content; it may resolve external metadata but performs no knowledge writes.

- `kinetix_apply_ingestion`
  - Revalidate and reclassify, upsert verified references/reviews, directly add only deterministic safe observations, and queue all other proposals.
  - Idempotent, non-destructive, and never accepts a client override of disposition.

- `kinetix_get_ingestion_run`
  - Return the persisted result for recovery after a client timeout.
  - Read-only.

The existing PubMed tools remain available to agent-token callers so the skill can search and fetch evidence through one MCP connection.

## Admin JSON fallback

Add an **Admin → Ingest conversation** pane modeled on `ResearchImportAdminSection`:

1. Upload or paste a `kinetix-conversation-ingestion-v1` JSON document.
2. Preview server classifications and diffs.
3. Apply the bundle.
4. Show direct additions, queued review IDs, no-ops, rejections, and warnings.

The admin UI calls the same domain service as MCP and cannot force a review-required item into `auto_add`. This keeps JSON fallback behavior identical to skill behavior.

A CLI wrapper can follow later if useful; it should call the same pure parser/domain service rather than recreate logic.

## Proposed files

### Contract and domain service

- `src/lib/conversationIngestion.ts` — versioned Zod input contract and public types.
- `src/lib/conversationIngestion.test.ts` — parser, privacy invariant, cross-field validation.
- `api/_lib/conversationIngestionStore.ts` — target resolution, preview classifier, idempotent apply, and result serialization.
- `api/_lib/conversationIngestionStore.test.ts` or integration coverage under `tests/integration/`.

### Database

- `db/schema.ts` — `parameter_entries.context` and `conversation_ingestion_runs`.
- new Drizzle migration with one SQL command per statement-breakpoint chunk, following the repository migration rules.

### MCP/auth

- `api/_lib/auth.ts` — shared `kxat_` token resolver plus Authorization-header helper; retain cookie auth behavior.
- `api/_lib/mcp-kinetix-tools.ts` — actor-bound tool definitions.
- `api/_lib/mcp-kinetix-server.ts` — combined PubMed/Kinetix server factory.
- `api/mcp.ts` — select PubMed-only static-token mode or agent-token combined mode.
- `tests/api/mcp-route.test.ts` and focused tool tests.

### Admin fallback

- `api/conversation-ingestion.ts` — admin preview/apply route using cookie auth.
- `src/components/admin/ConversationIngestionAdminSection.tsx` and tests.
- admin pane registration alongside the existing seed pane.

### Skill and documentation

- `.claude/skills/kinetix/SKILL.md` — canonical portable skill.
- `docs/conversation-ingestion.md` — operator setup, MCP connection, group/token provisioning, JSON fallback, and troubleshooting.
- optional packaging script that creates a ZIP whose top-level folder is `kinetix/`.

## Implementation sequence

### Phase 0 — Land the portable contract and skill ✅

- ✅ Merge this plan and `SKILL.md` (issue 1016).
- ✅ Add the Zod bundle contract plus fixtures — `src/lib/conversationIngestion.ts`,
  `.claude/skills/kinetix/reference/example-bundle.json`.
- ✅ Add a JSON-only validator that performs no writes —
  `scripts/validate-conversation-ingestion.ts` (`npm run validate:ingestion`).
- ✅ Confirm the skill can produce a valid bundle from representative conversations.

Two things the first draft of this phase missed, both added on implementation:

- **The envelope has to be strict, and say so when it is not matched.** A model
  with no schema in front of it invents a plausible one; the observed failure was
  a `{"kinetix_import_version": "1.0", "action": "upsert_wiki_content", …}`
  document that no validator would have recognized. `detectImpostorShape` names
  the invented key in one line instead of emitting thirty "unrecognized key"
  issues.
- **Unverifiable claims need a slot.** Without `blockedCandidates[]`, a model
  that cannot source an interpretation either drops it or promotes it to a fact.
  Both are worse than recording it as blocked.

Because the skill cannot query Kinetix in this phase, `replace`/`remove` wiki
facts and topic-page facts are effectively unauthorable — they need a real
`factId` or `pageId`. The skill routes them to `blockedCandidates` rather than
guessing, which is the correct behavior until phase 1 lands the context tool.

### Phase 1 — Read and preview

Partly done (2026-08-07): the admin half shipped — target resolution, live-state
snapshots, exact-duplicate checks and a reason-coded disposition per item, served
read-only by `POST /api/conversation-ingestion` and rendered as the acceptance
gate. The agent/MCP half below is untouched.

- Add agent bearer authentication and the `kinetix-ingestion` group gate.
- Add search/context/preview MCP tools.
- Add the admin paste/upload preview UI.
- Implement target resolution, exact duplicate checks, current-state snapshots, aggregate simulation, and reason-coded disposition.
- No scientific writes yet.

### Phase 2 — References and review-required proposals

Partly done (2026-08-07): the admin path reuses `resolveCitation` and
`recordPaperReview` (never overwriting an existing read-in-full review) and
writes accepted facts through the `wiki_fact` approval path. The
`requiresHumanReview` guard and agent-consensus wiring belong to the agent path
and are still open.

Extended 2026-08-07 with the review-queue route for **unverified wiki facts**.
The first cut's rule — an item may not cite a source with `readInFull: false` —
was enforced in the contract, which meant a claim resting on a paper the
assistant found but could not read had exactly one destination:
`blockedCandidates`, a list nobody can act on. That was the reference gate doing
a job it does not have. The gate governs *publishing*; carrying a claim across is
a different question, and the review queue is the answer the app already has for
it. So an unread source is now the marker that routes a `wiki_fact` — the pending
edit is staged and simply left `pending`. It stays fatal for a parameter
observation (written straight into a recomputed aggregate; no queued form on this
path) and a topic-page proposal (too much unverified content for one checkbox).

- Reuse citation resolution and `recordPaperReview`.
- ✅ Queue unverified wiki facts through the existing `pending_edits` structure —
  disposition `review`, receipt status `queued`, idempotent on the open proposal
  rather than on live page content.
- Queue parameter-entry, wiki-new, and other review-required items the same way.
- Add `requiresHumanReview` guard to consensus application.
- Persist ingestion runs/idempotency.

At this point the skill is useful without direct auto-add risk.

### Phase 3 — Restricted parameter auto-add

- Add `parameter_entries.context`.
- Enable only the deterministic parameter cases described above.
- Reuse `insertParameterEntry`, `recomputeParameterAndDependents`, revision recording, and implicit agent approval.
- Log predicted versus actual aggregate and fail closed if they differ.

### Phase 4 — Production calibration

- Measure no-op rate, review acceptance, reclassification, disputes, and false duplicate/conflict outcomes.
- Expand automatic classes only when observed review data supports it.
- Consider context-aware parameter subgroup summaries and direct consensus-eligible topic facts only as separate reviewed changes.

## Tests and acceptance criteria

### Contract

- Rejects unknown schema versions, raw conversation content, malformed identifiers, invalid item/source links, and incomplete context.
- Does not duplicate the live parameter registry in the skill or schema.

### Authentication

- Static MCP token lists PubMed tools only.
- Valid active `kxat_` token in the ingestion group lists combined tools.
- Revoked, expired, suspended, ungrouped, or cookie-only assumptions fail closed.
- Agent identity remains capped below admin.

### Parameters

- Exact retry is `noop` and never changes aggregation weight.
- Empty parameter + verified first observation may auto-add.
- Numerically unchanged aggregate may auto-add.
- Aggregate-changing observation queues a `param_entry` pending edit.
- Context mismatch queues review.
- Missing read-in-full review is rejected or requests PDF; it is never committed.
- Application recompute matches preview; a mismatch rolls back/fails closed.
- Blood/plasma normalization dependencies still recompute transactionally.

### Wiki

- Additive fact is an atomic `wiki_fact`, not a whole-page replacement.
- Fact IDs are server-minted.
- Replacements/removals/new pages carry `requiresHumanReview` and cannot auto-apply on agent consensus.
- Stale fact/page anchors do not overwrite newer content.
- One conversation may correctly produce facts for several pages and drugs.

### Idempotency/audit

- Repeating the same key and bundle returns the original item IDs/results.
- Reusing a key for different content returns 409.
- Every applied value/fact remains attributable through existing revisions and approvals.
- Stored ingestion data contains no raw conversation or direct identifiers.

### End-to-end examples

1. A detailed discussion of one paper's oral half-life for drug X produces a full-text-reviewed citation and a context-rich `parameter_entry`; it auto-adds only if the current displayed value is absent or unchanged.
2. A discussion correcting a drug's half-life produces a review-required entry rather than overwriting `drug_parameters`.
3. A postmortem interpretation discussion produces several atomic `forensic` monograph facts, all independently sourced and routed through peer consensus or human review.
4. A multi-drug metabolism discussion updates each relevant monograph/parameter target independently in one idempotent run.
5. With no MCP connection, `@kinetix json` produces the same bundle accepted by the admin pane.

## Final decision

Use a **portable skill + Kinetix MCP/API + identical JSON fallback**.

Do not use the existing deep-research importer for incremental chat ingestion, do not give the skill an admin agent, and do not allow a model to decide its own write safety. Reuse source-level parameter entries, atomic wiki facts, read-in-full paper reviews, revisions, pending edits, disputes, and independent agent consensus. Add only the thin missing layer: de-identified contract, authoritative classification/idempotency service, agent-bearer MCP tools, and admin fallback.