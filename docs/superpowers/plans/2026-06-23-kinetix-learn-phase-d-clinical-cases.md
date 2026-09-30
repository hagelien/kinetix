# Kinetix Learn — Phase D: Clinical Cases (content type, expert-gated apply, Cases UI)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the §5.4 **Cases & Review** content real: a `clinical_case` content type that agents author through the existing pending-edit pipeline (per `agents/clinical-case-builder.md`), that learners browse and work through in the Cases area, and whose attempts feed the Phase C adaptive engine — all behind the non-negotiable safety rule that **a clinical case is never published on agent consensus alone; it always requires a human expert moderator.**

**Architecture:** A clinical case is **not a parallel table** — it is a `learning_units` row with a new `kind` discriminator (`'unit' | 'clinical_case'`). This is the central decision: because `learning_question_attempts` and `learning_unit_progress` already FK `learning_units.id`, and `learning_unit_revision` is already a verification/approval target, storing cases in `learning_units` means the entire Phase C engine (attempts, competence, spaced review, My Path) covers cases for free — case questions tagged `clinical_reasoning` simply feed that dimension. The case-specific payload (clinical scenario + the mandatory safety notice) lives in the row's `content` jsonb under a dedicated `clinicalCaseContentSchema`. A new `clinical_case` `editType` carries the whole case as `proposedValue` and applies via a new `applyApprovedClinicalCase` branch mirroring `applyApprovedLearningUnit`, reusing `learning_unit_revisions` and the `learning_unit_revision` consensus target unchanged. The one genuinely new mechanism is the **human-only gate**: `applyOnAgentConsensus` (the single agent auto-apply entry point) refuses to auto-apply a `clinical_case`, so agent peer verdicts *inform* the human moderator but never replace them.

**Tech Stack:** TypeScript, Drizzle ORM (PostgreSQL/Neon), raw `node:http` Vercel handlers, Zod at the edge (`api/_lib/schemas.ts`), the pending-edit → `agent_verifications` → apply pipeline, `getUserFromRequest` auth, `json`/`error`/`withErrorHandling` helpers. Frontend: React 18 + React Router v6, `react-i18next` (en/nb chrome), Tailwind + `src/components/ui/*`, the existing `src/pages/learn/*` + `src/components/learn/*`. Vitest + `@testing-library/react`; API tests under `tests/api/` with `vi.hoisted` mocks for `../../api/_lib/db.js` and `../../api/_lib/auth.js`.

**Decisions locked in:**
- **Cases live in `learning_units` (kind discriminator), not a new table.** Reuses the Phase C attempts/competence/spaced-review/My Path infrastructure with zero changes to those tables. (If the owner prefers full isolation, that's the alternative — but it duplicates four tables and all of Phase C's wiring; this plan takes the reuse path.)
- **Human expert review is mandatory.** Clinical cases never auto-apply on agent consensus (spec §12 Stage 12 + `agents/clinical-case-builder.md`). Agent verdicts surface in the queue; a human moderator publishes.

## Global Constraints

- **Never auto-apply a clinical case.** The human-only rule is enforced in code at `applyOnAgentConsensus` (the *only* path that turns agent consensus into an apply). The human `/review` approval path (`applyApprovedEdit`) still publishes a case normally. A test must prove a `clinical_case` pending edit does **not** auto-apply at quorum while a `learning_unit` still does.
- **Mandatory safety notice, verbatim.** Every case's content MUST carry the exact Norwegian notice `Kun til opplæring — ikke pasientspesifikke kliniske råd.` The `clinicalCaseContentSchema` enforces its presence (a literal/`refine`), and the renderer shows it prominently before the scenario. No case can validate or render without it.
- **Source-cited, not paper-gated.** A case must anchor at least one citation (the primary source/guideline/label it interprets) — but it does **NOT** require a read-in-full `paper_review` (unlike learning units; cases interpret guidelines/labels that have no paper appraisal). Submit-time gate: require ≥1 `referenceId`; do **not** call `assertReferencesJudged`.
- **Reuse, don't fork, the revision/verification target.** Case revisions write to `learning_unit_revisions` and are verified as `learning_unit_revision`. Do **NOT** add a new `ApprovalTargetType` — the existing one already covers both kinds (a revision row belongs to a `learning_units` row of either kind).
- **Render by kind.** The unit renderer branches on `kind`: a `clinical_case` shows the safety notice + scenario (no SourceCard/PreReadingGuide, which are unit-only); a `unit` renders exactly as today. The shared pieces (Prerequisites, Objectives, Assessment) are reused.
- **Chrome bilingual; content Norwegian.** New UI strings (Cases tab, scenario heading, safety-notice label) get `learn.*` en/nb keys. Case prose renders as authored (Norwegian), and the safety-notice string inside content is authored, not an i18n key.
- **Auth/gating unchanged.** Cases are gated to the `kinetix-learn` group for discovery exactly like units (`canAccessKinetixLearn`); the read API stays public; the write/submit path is contributor+ (agents author), human approval is editor+/admin (the "expert moderator").
- **Additive & backward-compatible.** `learning_units.kind` defaults to `'unit'`, so every existing unit and all Phase C behaviour is unchanged. Migration adds one column only.
- **Migrations:** next number is `0063` (latest is `0062_learning_progress`). Hand-write `drizzle/0063_*.sql`, add the `_journal.json` entry, keep `db/schema.ts` as source of truth.
- **Tests/typecheck/lint** all green; one commit per task; branch off `main`; never deploy.

## Where things live (verified)

| Concern | Location | Note |
| --- | --- | --- |
| Unit table | `db/schema.ts` `learningUnits` (~723) | Add `kind` column |
| Content schemas | `api/_lib/schemas.ts` (`learningUnitContentSchema` ~667, `learningUnitMetaSchema` ~691, `createPendingEditSchema` ~745 enum, `learning_unit` superRefine ~772) | Add `clinicalCaseContentSchema` + `clinical_case` enum/branch |
| Submit gate | `api/pending-edits.ts` (`learning_unit` block ~929, `canContribute` ~41) | Add `clinical_case` cite-a-source gate |
| Apply dispatcher | `api/_lib/pending-edits-helpers.ts` (`applyApprovedEditEffects` ~646, branches; `applyApprovedLearningUnit` ~523; conflict marking ~498) | Add `applyApprovedClinicalCase` + dispatch + conflict |
| **Auto-apply gate** | `api/agent-verifications.ts` `applyOnAgentConsensus` (~409) | Refuse `clinical_case` here |
| Verification targets | `db/schema.ts` `ApprovalTargetType` (~1710); `api/_lib/agent-verifications.ts` `targetAuthorUserId`/`verificationTargetVersion` (`learning_unit_revision` cases ~276/~333) | **No change** — reused as-is |
| Phase C tables | `db/schema.ts` `learningQuestionAttempts`/`learningUnitProgress` (FK `learning_units.id` ~802/~841/~877) | Reused unchanged — cases get the engine free |
| Read API | `api/learning-units.ts` (status filter ~99/150) | Add `kind` filter + field |
| FE client/types | `src/lib/learnApi.ts` | Add `kind` to types + list filter |
| Renderer | `src/pages/learn/LearningUnitPage.tsx`, `src/components/learn/*` | Branch by kind; new `CaseScenario` |
| Cases area | `src/pages/learn/ReviewPage.tsx` (Cases & Review), `LearnSubNav` | Add a Cases listing |
| Agent spec | `agents/clinical-case-builder.md` | Drop the "not built yet" caveat once live |

---

## Clinical-case content shape (new)

`clinicalCaseContentSchema` (reuses the unit's prerequisite/objective/question pieces):

```
{
  safetyNotice: string  // must equal "Kun til opplæring — ikke pasientspesifikke kliniske råd."
  scenario: string      // the fictional/composite vignette (1..5000)
  prerequisites: [{ concept, level, why }]   // same as learning units
  objectives: string[]                       // same
  questions: LearningQuestion[]              // same schema (≥6); reasoning-heavy, cognitiveSkill-tagged
}
```

Meta (`clinicalCaseMetaSchema`): `{ title, slug, difficulty, domains, editSummary?, requiresExpertReview: true }`.

---

### Task 1: Schema + migration — `learning_units.kind` + case content schema

**Files:** modify `db/schema.ts`; create `drizzle/0063_learning_unit_kind.sql` + `_journal.json` entry; add `clinicalCaseContentSchema`/`clinicalCaseMetaSchema` to `api/_lib/schemas.ts`; test `tests/lib/clinicalCaseSchema.test.ts`.

**Interfaces:** `learningUnits.kind varchar(20) NOT NULL DEFAULT 'unit'` (`'unit' | 'clinical_case'`). `clinicalCaseContentSchema` requires the verbatim `safetyNotice`, a `scenario`, and reuses `prerequisites`/`objectives`/`questions` (questions `.min(6)`). `clinicalCaseMetaSchema` like `learningUnitMetaSchema` + `requiresExpertReview`.

- [ ] **Step 1 — failing tests:** `getTableConfig(learningUnits)` includes `kind`; `clinicalCaseContentSchema` accepts a well-formed case, rejects one with a missing/altered safety notice, rejects <6 questions.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the column (after `status`) + the two Zod schemas (reuse the existing prerequisite/objective/question sub-schemas).
- [ ] **Step 4 — run, expect PASS** + typecheck.
- [ ] **Step 5 — migration** `0063_learning_unit_kind.sql` (`ALTER TABLE "learning_units" ADD COLUMN IF NOT EXISTS "kind" VARCHAR(20) NOT NULL DEFAULT 'unit'`) + journal entry (`idx 63`).
- [ ] **Step 6 — commit:** `feat(learn): clinical_case content schema + learning_units.kind discriminator`.

---

### Task 2: `clinical_case` editType wiring

**Files:** modify `api/_lib/schemas.ts` (`createPendingEditSchema` enum + superRefine); extend `tests/lib/clinicalCaseSchema.test.ts`.

**Interfaces:** `editType` enum gains `'clinical_case'`. A superRefine branch (mirroring `learning_unit`, ~772): `proposedValue` parses as `clinicalCaseContentSchema`; `proposedMeta` parses as `clinicalCaseMetaSchema`; **≥1** `referenceId`/`referenceIds` present (cite a source) — note: not *exactly* one (cases may cite several).

- [ ] **Step 1 — failing tests:** a complete `clinical_case` edit validates; one with no anchor citation fails; one with an altered safety notice fails (via the content schema).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the enum literal + branch.
- [ ] **Step 4 — run, expect PASS** + typecheck.
- [ ] **Step 5 — commit:** `feat(learn): clinical_case pending-edit validation`.

---

### Task 3: Submit path — allow `clinical_case`, cite-a-source gate

**Files:** modify `api/pending-edits.ts`; test `tests/api/pending-edits-clinical-case-route.test.ts`.

**Interfaces:** `POST /api/pending-edits` accepts `editType:'clinical_case'` from contributor+ (agents author). Gate: require ≥1 `referenceId` (else 400 `clinical_case_missing_source`); do **NOT** call `assertReferencesJudged` (no read-in-full gate). Persist `referenceIds` like other editTypes.

- [ ] **Step 1 — failing tests:** a case citing a source inserts (201); a case with no `referenceIds` → 400 `clinical_case_missing_source`; `assertReferencesJudged` is **not** invoked for `clinical_case`.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the gate near the existing `learning_unit` block (~929).
- [ ] **Step 4 — run, expect PASS** + typecheck.
- [ ] **Step 5 — commit:** `feat(learn): accept clinical_case submissions citing a source`.

---

### Task 4: Apply path — `applyApprovedClinicalCase`

**Files:** modify `api/_lib/pending-edits-helpers.ts` (`applyApprovedClinicalCase`; dispatch in `applyApprovedEditEffects` ~863; conflict marking ~498); test `tests/api/pending-edits-clinical-case.test.ts`.

**Interfaces:** `applyApprovedClinicalCase(db, edit, reviewerId)` mirrors `applyApprovedLearningUnit` but inserts/updates the `learning_units` row with `kind:'clinical_case'`, `citationId = referenceIds[0]` (primary anchor), content = the case payload. Writes a `learning_unit_revisions` row, `recordApproval`/`recordImplicitAgentApproval` on `learning_unit_revision`, and fires a `clinical_case_approved` hook. Conflict marking mirrors the `learning_unit` branch for `targetId`-bearing edits.

- [ ] **Step 1 — failing test:** applying a new `clinical_case` edit inserts a `learning_units` row with `kind:'clinical_case'` + a revision, and stamps the approval on `learning_unit_revision`.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the fn + dispatch branch + conflict block (reuse `clinicalCaseMetaSchema`).
- [ ] **Step 4 — run, expect PASS** + typecheck.
- [ ] **Step 5 — commit:** `feat(learn): apply approved clinical_case edits into learning_units`.

---

### Task 5: The human-only gate (no agent auto-apply) — **the safety-critical task**

**Files:** modify `api/agent-verifications.ts` (`applyOnAgentConsensus` ~409); test `tests/api/clinical-case-no-autoapply.test.ts`.

**Interfaces:** `applyOnAgentConsensus` loads the pending edit's `editType` and, when it is `clinical_case`, returns `false` (leaves it in the human queue) **before** calling `applyApprovedEdit` — even at full quorum with no dispute. Agent verdicts are still recorded; only the auto-apply is withheld. The human `/review` approval path is untouched, so an editor/admin still publishes the case.

- [ ] **Step 1 — failing tests:** with quorum met and no dispute, a `learning_unit` pending edit auto-applies (`autoApplied=true`); a `clinical_case` does **not** (`autoApplied=false`) and `applyApprovedEdit` is not called for it. (Mock the summary/quorum + the pending-edit lookup; assert the apply spy.)
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the editType guard (a single lookup + early return), with a comment citing spec §12 Stage 12.
- [ ] **Step 4 — run, expect PASS** + typecheck.
- [ ] **Step 5 — commit:** `feat(learn): clinical cases require human review — never auto-apply on agent consensus`.

---

### Task 6: Read API — `kind` discriminator

**Files:** modify `api/learning-units.ts`; extend `tests/api/learning-units-route.test.ts`.

**Interfaces:** list endpoint accepts `?kind=unit|clinical_case` (default: **units only**, so the existing Library/Topic Map are unchanged). The Cases area requests `?kind=clinical_case`. Both list items and the single-unit payload include `kind`. The single-unit (`?id=`) endpoint returns any published row regardless of kind (the renderer branches on `kind`).

- [ ] **Step 1 — failing tests:** default list returns only `kind:'unit'` rows; `?kind=clinical_case` returns case rows; the single-unit payload includes `kind`.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the filter (add `kind` to selects + a `kind` where-clause; default unit).
- [ ] **Step 4 — run, expect PASS** + typecheck.
- [ ] **Step 5 — commit:** `feat(learn): kind-aware learning-units read API`.

---

### Task 7: Render a clinical case (scenario + safety notice)

**Files:** create `src/components/learn/CaseScenario.tsx`; modify `src/lib/learnApi.ts` (types: `kind`, case content), `src/pages/learn/LearningUnitPage.tsx`; tests for `CaseScenario` + the page's case branch; locale keys.

**Interfaces:** `LearningUnitDetail` gains `kind`; content typing covers both shapes. `LearningUnitPage` branches: `kind:'clinical_case'` renders `CaseScenario` (the prominent safety notice banner + the scenario prose) then `Prerequisites`, `Objectives`, `Assessment` (with `unitId` — attempts persist exactly as for units); `kind:'unit'` renders today's SourceCard/PreReading path unchanged. `CaseScenario` shows the safety notice as a visually distinct banner.

- [ ] **Step 1 — failing tests:** `CaseScenario` renders the safety-notice banner + scenario; `LearningUnitPage` given a `clinical_case` detail shows the scenario and mounts the assessment, and does **not** render a SourceCard.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the component, the page branch, types, and `learn.case.*` locale keys (en + nb): `safetyNoticeLabel`, `scenario`.
- [ ] **Step 4 — run, expect PASS** + typecheck + lint.
- [ ] **Step 5 — commit:** `feat(learn): render clinical cases with scenario + safety notice`.

---

### Task 8: Cases listing in the Cases & Review area

**Files:** modify `src/pages/learn/ReviewPage.tsx` (or split a `CasesPage`); modify `src/lib/learnApi.ts` (list `kind` filter); locale keys; test.

**Interfaces:** the Cases & Review page gains a **Cases** section listing published clinical cases (`fetchLearningUnits({ kind: 'clinical_case' })`), each linking to `/learn/unit/:id` (the kind-aware renderer). The existing spaced-review list stays. `LearnSubNav` already exposes the Review tab; the Cases list sits at its top above "due for review".

- [ ] **Step 1 — failing test:** the page lists published clinical cases with links; empty state when none.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the listing + `learn.review.cases*` keys (en + nb).
- [ ] **Step 4 — run, expect PASS** + typecheck + lint.
- [ ] **Step 5 — commit:** `feat(learn): list clinical cases in the Cases & Review area`.

---

### Task 9: Docs — activate the agent spec + AGENTS.md + full-suite gate

**Files:** modify `agents/clinical-case-builder.md`, `AGENTS.md`.

- [ ] **Step 1 — update `agents/clinical-case-builder.md`:** remove the "Status / backend prerequisite (not built yet)" caveat now that `clinical_case` is live; keep the human-review and safety rules. Note the cite-a-source (not paper-gated) submit rule and that questions feed the `clinical_reasoning` dimension.
- [ ] **Step 2 — update AGENTS.md:** the clinical-cases row now points at the live surface (`learning_units.kind`, the `clinical_case` editType + `applyApprovedClinicalCase`, the `applyOnAgentConsensus` human-only guard, the kind-aware read API + renderer).
- [ ] **Step 3 — run `npm run test && npm run typecheck && npm run lint`** — all green.
- [ ] **Step 4 — commit:** `docs(learn): activate the clinical-case builder for the live backend`.

---

## Manual verification (after Task 8)

1. As an agent (contributor), submit a `clinical_case` citing a source → it lands in the pending queue.
2. Agents reach approval quorum with no dispute → the case is **still pending** (not auto-applied); a `learning_unit` in the same state **does** auto-apply. (The core safety guarantee.)
3. A human editor/admin approves the case via `/review` → it publishes (`kind:'clinical_case'`).
4. The case appears in the Cases area (not in the Source Library/Topic Map, which stay units-only).
5. Opening it shows the safety-notice banner + scenario (no SourceCard), then the assessment.
6. Completing the assessment persists attempts; `/learn/path` shows the clinical-reasoning dimension move and the case can become due for spaced review — i.e. cases ride the Phase C engine with no extra wiring.

## Deferred (NOT in this plan)

- **Multi-source anchoring UI.** A case persists one primary anchor citation (`citationId`); additional cited sources are referenced within the scenario prose. First-class multi-citation storage/rendering is a later refinement.
- **A distinct expert-reviewer role.** "Expert moderator" maps to the existing human editor/admin approval; a dedicated clinical-expert role/permission is out of scope.
- **In-prose Kinetix cross-linking** (still pending from B/C) and the **§15 update/maintenance model**.
- **Progressive/multi-step case disclosure** (staged reveal of data before each decision) — MVP is one scenario + its question set.

## Self-Review

- **Decisions honored:** cases reuse the `learning_units` substrate via `kind` (Tasks 1,4,6,7) so Phase C covers them unchanged; human-only review is enforced in code at the one auto-apply gate (Task 5) with a test proving units auto-apply but cases don't.
- **Spec coverage:** §5.4 Cases & Review content + area (Tasks 4,6,7,8); §12 Stage 12 safety framing — verbatim notice enforced by schema + renderer (Tasks 1,7), human expert gate (Task 5), source-cited claims (Task 3); §6.8 clinical realism with safety framing.
- **Reused, not forked:** `learning_unit_revisions` + `learning_unit_revision` verification target carry both kinds (no new `ApprovalTargetType`); attempts/competence/spaced-review/My Path untouched.
- **Backward-compatible:** one additive column defaulting to `'unit'`; the read API defaults to units-only so existing pages don't change.
- **Open items to confirm during execution:** whether the `/review` human-approval UI needs a visible "clinical case — expert review" badge (Task 5/8 — nice-to-have, not required for correctness); whether `clinical_case_approved` needs to be added to the agent-hook event union in `api/_lib/agentHooks.ts` (Task 4 — mirror the `learning_unit_approved` check); exact conflict-marking helper reused from the `learning_unit` branch (Task 4). None affect the design.
