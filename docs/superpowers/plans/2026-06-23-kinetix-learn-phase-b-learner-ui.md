# Kinetix Learn — Phase B: Learner-Facing UI (Source Library → Unit → Assessment)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give users a working, gated entry into Kinetix Learn: browse the published learning units (**Source Library**), open one (**unit renderer** — source card, prerequisites, pre-reading guide, objectives, Kinetix-aware source link-out), and take its **assessment** (≥10 questions, single-best / select-all, two answering modes, per-option explanations) with **client-side scoring only**. This is the learner-facing half of Phase A's storage/authoring backend.

**Architecture:** A vertical slice on top of the existing Phase A read API (`GET /api/learning-units`). New routes under `/learn` in the React SPA, a header-menu entry gated by a new admin-managed feature group, an API-client lib mirroring `src/lib/drugApi.ts`, presentational components that render the unit `content` JSON, and a self-contained assessment component that scores in the browser. The one backend change is a small, additive extension of the read API's `source` block to carry the citation's bibliographic metadata + a resolvable link-out URL (needed for the §7.1 source card). No new tables, no progress persistence.

**Tech Stack:** TypeScript, React 18 + React Router v6 (lazy routes), Zustand (`authStore`), `react-i18next` (en/nb), Tailwind + `src/components/ui/*`, Vitest + `@testing-library/react` (jsdom) co-located `*.test.tsx`. Backend: raw `node:http` Vercel handler, Zod at the edge, Vitest with `vi.hoisted` `getDb` mocks.

**Decisions locked in (from product owner):**
- **Vertical slice first.** Source Library + unit renderer + assessment ship together and unlock the menu entry. The **Topic Map** (§5.2) is a fast second increment (sketched in "Deferred", not built here).
- **Gate behind a feature group.** A new admin-managed group `kinetix-learn` controls the menu entry, exactly like the group-gated analytical methods. Pages remain reachable by direct URL for testing.
- **Stateless assessment.** Scoring is client-side; nothing is persisted. All attempt/progress/competence tracking lands in **Phase C** with the adaptive engine.

## Global Constraints

- **Source content is link-out only.** The unit view MUST NOT embed or serve the source PDF/full text. The source card links out (DOI → `https://doi.org/…`, PMID → `https://pubmed.ncbi.nlm.nih.gov/…`, URL → as-is). No new route exposes `citation_pdfs` or paper full text. (Inherited from Phase A.)
- **Chrome is bilingual; unit content is not.** Menu labels, buttons, filter labels, and assessment UI strings get `en.json` + `nb.json` keys under a `learn.*` namespace. The unit's authored prose (source card text, prompts, questions, explanations) is rendered **as authored** (Norwegian) — do NOT add locale keys for unit content, and do NOT machine-translate it. (Matches the Phase A content-language constraint.)
- **No new role/permission semantics.** Reuse `featureAccess.ts`. The Learn area is visible to members of the `kinetix-learn` group and to admins; everyone else does not see the menu entry. The read API stays auth-free (published content is public), so a direct `/learn/...` URL still renders — gating is a discovery/menu concern, not a hard data lock. This mirrors how methods access works.
- **Render untrusted content safely.** Unit `content` is author/agent-authored JSON. Render it as **text** through React (which escapes by default). Do NOT pass unit strings through `dangerouslySetInnerHTML`. (Unlike wiki, units are plain-text fields per `learningUnitContentSchema`, so no HTML sanitizer is needed — keep it that way.)
- **Content schema is the contract.** The frontend `LearningUnitContent` type MUST mirror `api/_lib/schemas.ts` `learningUnitContentSchema` (sourceCard, prerequisites, preReadingPrompts, objectives, questions[]). Derive/keep it in sync; treat the API payload as already-validated but defensively handle missing optional fields.
- **Tests:** `npm run test` (Vitest). Component tests co-locate as `*.test.tsx` beside the component (see `src/components/wiki/WikiRenderer.test.tsx`). API tests under `tests/api/` mock `../../api/_lib/db.js` via `vi.hoisted`. `npm run typecheck` must stay clean.
- **Commit cadence:** one commit per task (after its tests pass). Branch off `main`; never deploy.

## Where things live (verified)

| Concern | Location | Note |
| --- | --- | --- |
| Read API | `api/learning-units.ts` | Returns `source: { citationId, type, identifier }` today — Task 1 extends it |
| Citation metadata | `citations.metadata` jsonb `{title, authors, journal, year, volume, pages}` | `db/schema.ts` ~line 661 — backs the source card |
| Content/meta schema | `api/_lib/schemas.ts` (`learningUnitContentSchema`, `LearningUnitContent`, `LEARNING_DIFFICULTIES`) | Source of truth for the FE type |
| Router | `src/router.tsx` | Lazy routes + `withRouteFallback` / `withAuthRequired` |
| Header menu | `src/components/Header.tsx` (`NAV_ITEMS`, ~line 45) | Conditional-include gating pattern |
| Feature gating | `src/lib/featureAccess.ts` (`hasGroup`, `canAccessAnalyticalMethods`) | Add `KINETIX_LEARN_GROUP_SLUG` + `canAccessKinetixLearn` |
| Admin-managed groups | `user_groups` / `api/admin.ts?resource=groups` | Admin creates the `kinetix-learn` group at runtime — no migration |
| API-client lib pattern | `src/lib/drugApi.ts` | `fetch` + decode helpers; mirror for `learnApi.ts` |
| Page pattern | `src/pages/MethodsPage.tsx`, `src/pages/wiki/WikiHome.tsx` | `useEffect` fetch with `cancelled` flag |
| UI kit | `src/components/ui/` (`button`, `card`, `badge`, `select`, `input`) | Reuse; layout `mx-auto max-w-5xl px-4 py-6` |
| Auth state | `src/stores/authStore.ts` (`useAuthStore`) | `user`, `isAuthenticated` |

---

## File Structure

**New files**
- `src/lib/learnApi.ts` — `fetchLearningUnits()`, `fetchLearningUnit(id)`, response/content types. + `learnApi.test.ts`.
- `src/pages/learn/SourceLibraryPage.tsx` — list + difficulty/domain filters. + test.
- `src/pages/learn/LearningUnitPage.tsx` — fetches one unit, composes the renderer + assessment. + test.
- `src/components/learn/SourceCard.tsx` — §7.1 source card (metadata + link-out + why-it-matters). + test.
- `src/components/learn/Prerequisites.tsx` — §7.2 prerequisite list with level badges. + test.
- `src/components/learn/PreReadingGuide.tsx` — §7.3 prompts. (covered by unit-page test)
- `src/components/learn/Objectives.tsx` — §7.9 objectives. (covered by unit-page test)
- `src/components/learn/Assessment.tsx` — §7.5–7.6 question runner + scoring. + test (the heaviest test).
- `src/lib/learnContent.ts` — pure helpers: `difficultyLabelKey`, `sourceLinkOutUrl(type, identifier)`, `scoreQuestion`, `gradeAssessment`. + test.

**Modified files**
- `api/learning-units.ts` — add `metadata` + `url` to the `source` block (single-unit `?id=` path).
- `tests/api/learning-units-route.test.ts` — assert new `source` fields, and still NO pdf/full-text field.
- `src/lib/featureAccess.ts` — add `KINETIX_LEARN_GROUP_SLUG` + `canAccessKinetixLearn(user)`.
- `src/lib/featureAccess.test.ts` — cover the new gate (admin OR group; else false).
- `src/router.tsx` — lazy routes `/learn` and `/learn/unit/:id`.
- `src/components/Header.tsx` — gated `learn` nav entry.
- `src/locales/en.json` + `src/locales/nb.json` — `learn.*` chrome keys.
- `AGENTS.md` — update the Kinetix Learn "Where to look" row to mention the Phase B learner UI.

---

### Task 1: Extend the read API `source` block with bibliographic metadata + link-out URL

**Why:** The §7.1 source card needs title/authors/journal/year and a clickable link. The single-unit response currently exposes only `{ citationId, type, identifier }`.

**Files:** Modify `api/learning-units.ts`; extend `tests/api/learning-units-route.test.ts`.

**Interfaces:** `GET /api/learning-units?id=<n>` `source` becomes `{ citationId, type, identifier, url, metadata }` where `url` is the resolved link-out (`doi`→`https://doi.org/<id>`, `pmid`→`https://pubmed.ncbi.nlm.nih.gov/<id>/`, `url`→`<id>`, `freetext`→`null`) and `metadata` is the citation's `metadata` jsonb (or `null`). The list responses are unchanged. NO pdf/full-text field is ever added.

- [ ] **Step 1 — failing test:** In `tests/api/learning-units-route.test.ts`, extend the single-unit case so the joined citation row includes `metadata: { title, authors, journal, year }` and `type:'doi'`, `identifier:'10.1/x'`; assert `body.source.url === 'https://doi.org/10.1/x'`, `body.source.metadata.title` is present, and `body.source` has NO `pdf`/`fullText` key.
- [ ] **Step 2 — run, expect FAIL** (`url`/`metadata` undefined).
- [ ] **Step 3 — implement:** add `metadata: citations.metadata` to the citation `select`; add a `sourceLinkOutUrl(type, identifier)` switch in the handler (or import from a shared helper — see Task 6 `learnContent.ts` if sharing server+client; otherwise inline, the FE has its own copy for rendering robustness); include `url` + `metadata` in `sourceLinkOut`.
- [ ] **Step 4 — run, expect PASS** + `npm run typecheck`.
- [ ] **Step 5 — commit:** `feat(learn): expose citation metadata + link-out url on unit read API`.

---

### Task 2: Feature-access gate for Kinetix Learn

**Files:** Modify `src/lib/featureAccess.ts`; add/extend `src/lib/featureAccess.test.ts`.

**Interfaces:** `KINETIX_LEARN_GROUP_SLUG = 'kinetix-learn'`; `canAccessKinetixLearn(user)` → `true` when `user.role === 'admin'` OR `hasGroup(user, KINETIX_LEARN_GROUP_SLUG)`, else `false` (and `false` for null/undefined user). No migration — admins create the group through the existing `user_groups` admin UI.

- [ ] **Step 1 — failing test:** admin → true; member of `kinetix-learn` → true; plain authenticated user → false; `null` → false.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** mirroring `canAccessAnalyticalMethods`.
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit:** `feat(learn): add kinetix-learn feature-access gate`.

---

### Task 3: API client + content types + pure helpers

**Files:** Create `src/lib/learnApi.ts`, `src/lib/learnContent.ts`; tests `learnApi.test.ts`, `learnContent.test.ts`.

**Interfaces:**
- `learnApi.ts`: `LearningUnitListItem { id; slug; title; difficulty; domains }`; `LearningUnitDetail { id; slug; title; difficulty; domains; content: LearningUnitContent; source: LearningUnitSource | null }`; `fetchLearningUnits(params?: { citationId?: number })` → `LearningUnitListItem[]`; `fetchLearningUnit(id)` → `LearningUnitDetail`. Use the `fetch` + decode + throw-on-!ok pattern from `drugApi.ts`. Re-export `LearningUnitContent` shaped to mirror `learningUnitContentSchema` (sourceCard, prerequisites[], preReadingPrompts[], objectives[], questions[] with options[] `{ id, text, isCorrect, explanation }`).
- `learnContent.ts` (pure, framework-free, easy to unit-test): `sourceLinkOutUrl(type, identifier)`; `difficultyLabelKey(difficulty)` → i18n key like `learn.difficulty.foundational`; `scoreQuestion(question, selectedIds)` → `{ correct: boolean; correctIds: string[] }` (single_best: exactly the one correct id; select_all: selected set equals correct set); `gradeAssessment(questions, answers)` → `{ correctCount; total; perQuestion }`.

- [ ] **Step 1 — failing tests:** `learnContent.test.ts` covers `sourceLinkOutUrl` for doi/pmid/url/freetext, and `scoreQuestion` for single_best (right/wrong) and select_all (exact match, partial = incorrect). `learnApi.test.ts` mocks `fetch` (global) and asserts URL + decoded shape for list and detail, and that a non-ok response throws.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** both libs.
- [ ] **Step 4 — run, expect PASS** + typecheck.
- [ ] **Step 5 — commit:** `feat(learn): learn API client, content types, scoring helpers`.

---

### Task 4: Source Library page + route + gated menu entry

**Files:** Create `src/pages/learn/SourceLibraryPage.tsx` + test; modify `src/router.tsx`, `src/components/Header.tsx`, `src/locales/{en,nb}.json`.

**Interfaces:** Route `GET /learn` (auth required, `withAuthRequired`) renders a list of published units from `fetchLearningUnits()`, with client-side filter controls for **difficulty** (the `LEARNING_DIFFICULTIES` values) and **domain** (distinct `domains` from the loaded list). Each item is a `Card` linking to `/learn/unit/:id`, showing title + difficulty badge + domain badges. Header gains a `learn` entry inside the authenticated branch, included only when `canAccessKinetixLearn(user)`.

- [ ] **Step 1 — failing test:** render `SourceLibraryPage` with `fetchLearningUnits` mocked to return 3 units across 2 difficulties; assert all 3 render, then selecting a difficulty filter narrows the list. (Mock `src/lib/learnApi`.)
- [ ] **Step 2 — run, expect FAIL** (page missing).
- [ ] **Step 3 — implement** the page (page pattern: `useEffect` + `cancelled`, loading/error/empty states, `t('learn.*')`), add lazy route in `router.tsx`, add the gated `NAV_ITEMS` entry in `Header.tsx`, and add `learn.title`, `learn.empty`, `learn.filter.difficulty`, `learn.filter.domain`, `learn.difficulty.*`, `nav.learn` to both locale files.
- [ ] **Step 4 — run, expect PASS** + typecheck.
- [ ] **Step 5 — commit:** `feat(learn): source library page, route, and gated menu entry`.

---

### Task 5: Unit renderer (source card, prerequisites, pre-reading, objectives)

**Files:** Create `src/components/learn/{SourceCard,Prerequisites,PreReadingGuide,Objectives}.tsx`, `src/pages/learn/LearningUnitPage.tsx`, and tests for `SourceCard`, `Prerequisites`, and the page.

**Interfaces:** Route `GET /learn/unit/:id` (auth required) fetches one unit via `fetchLearningUnit(Number(id))` and composes, in order: `SourceCard` (title, authors/journal/year from `source.metadata`, difficulty badge, "why it matters", estimated reading minutes, **link-out** to `source.url` with `target=_blank rel=noopener` — never an embed), `Prerequisites` (each with an Essential/Helpful/Advanced-adjacent/Optional-context badge + "why"), `PreReadingGuide` (the 3–8 prompts as a list), `Objectives`, then mounts `Assessment` (Task 6). All unit text rendered as escaped React text. Handle 404 (`fetchLearningUnit` throws) with a not-found state. Cross-linking of in-prose terms is explicitly **out of scope** (see Deferred).

- [ ] **Step 1 — failing tests:** `SourceCard.test.tsx` (renders title + resolved link href + reading time; no embed/iframe); `Prerequisites.test.tsx` (renders each prereq with its level label); `LearningUnitPage.test.tsx` (mocks `fetchLearningUnit`, asserts source card + prereqs + prompts + objectives all render and the page mounts the assessment heading).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the four presentational components (use `Card`, `Badge`; level labels via `t('learn.prereq.*')`) and the page; add lazy route. Add `learn.sourceCard.*`, `learn.prereq.*`, `learn.preReading`, `learn.objectives`, `learn.readingMinutes` locale keys.
- [ ] **Step 4 — run, expect PASS** + typecheck.
- [ ] **Step 5 — commit:** `feat(learn): unit renderer — source card, prerequisites, pre-reading, objectives`.

---

### Task 6: Assessment runner (two modes, per-option feedback, client-side score)

**Files:** Create `src/components/learn/Assessment.tsx` + `Assessment.test.tsx`.

**Interfaces:** `Assessment({ questions })`. Supports both §7.5 modes via a toggle:
- **Submit-all:** answer every question, then "Submit" reveals per-option explanations + a total score (`gradeAssessment`).
- **One-at-a-time:** answer a question, get immediate feedback (correct/incorrect + per-option explanations) before advancing.

Single-best uses radio inputs; select-all uses checkboxes (scored as exact-set match). Every option's `explanation` is shown after grading — for both correct and incorrect options (§7.6). State is component-local (`useState`); **nothing is persisted or POSTed**. Score is display-only.

- [ ] **Step 1 — failing test:** render with 2 questions (one single_best, one select_all). In submit-all mode: select answers, click submit, assert the score text and that an incorrect option's explanation is shown. In one-at-a-time mode: answer Q1, assert feedback appears and Q2 is gated until advance. (`@testing-library/react` + `userEvent`.)
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** using `scoreQuestion`/`gradeAssessment` from `learnContent.ts`; `Button`/`Badge`/`Card` for UI; `t('learn.assessment.*')` for chrome (mode labels, submit, score, correct/incorrect). Render explanations as escaped text.
- [ ] **Step 4 — run, expect PASS** + typecheck.
- [ ] **Step 5 — commit:** `feat(learn): assessment runner with client-side scoring and per-option feedback`.

---

### Task 7: Docs + full-suite gate

**Files:** Modify `AGENTS.md`.

- [ ] **Step 1 — update** the Kinetix Learn "Where to look" row to add the Phase B learner UI surface: `src/pages/learn/`, `src/components/learn/`, `src/lib/learnApi.ts`, gated by `canAccessKinetixLearn` (`kinetix-learn` group). Note Phase B = read + stateless assessment; My Path / Topic Map / progress = Phase C.
- [ ] **Step 2 — run `npm run test && npm run typecheck`** — expect all green.
- [ ] **Step 3 — commit:** `docs(learn): point AGENTS.md at the Phase B learner UI`.

---

## Manual verification (after Task 6)

1. Admin creates a `kinetix-learn` group (admin → groups) and adds a test user.
2. As that user, the **Kinetix Learn** entry appears in the header; as a plain authenticated user it does not, but `/learn` still loads by URL.
3. Library lists published units; difficulty/domain filters narrow it.
4. Opening a unit shows the source card with a working external link (new tab, no embed), prerequisites with level badges, pre-reading prompts, objectives.
5. Assessment: both modes work; every option (right and wrong) shows its explanation after grading; the score is correct; reloading the page loses all answers (confirming statelessness).

---

## Deferred (NOT in this plan)

- **§5.2 Topic Map** — fast-follow increment (Phase B.2): a domain/concept navigation surface with soft prerequisite warnings (no hard locks). Needs a curriculum/concept taxonomy that doesn't exist yet; the unit `domains` field is the seed. Separate plan.
- **§5.1 My Path & §8 adaptive model** — **Phase C.** Requires persisted attempts + the six competence dimensions + spaced repetition + a recommendation engine. New tables + new API. Out of scope.
- **§5.4 Cases & Review / spaced review** — Phase C (depends on persisted progress).
- **In-prose Kinetix cross-linking (§4, §6)** — unit prose is plain text today, so making drug/concept terms clickable needs either authored link markup in the content schema or a client-side term-matcher against the drug/wiki index. Non-trivial; defer to a dedicated increment after the read experience lands. The source-card link-out is the only linking in Phase B.
- **§15 update/maintenance surfacing** — agent/review concern, not learner UI.

## Self-Review

- **Decisions honored:** vertical slice (Tasks 4→5→6 deliver Library→unit→quiz, unlocking the menu in Task 4); group-gated (Task 2 + Header); stateless (Task 6 persists nothing — explicit verification step 5).
- **Spec coverage (Phase B scope):** §5.3 Source Library (Task 4); §7.1 source card (Tasks 1+5, metadata from `citations.metadata`); §7.2 prerequisites with the four levels (Task 5); §7.3 pre-reading 3–8 prompts (Task 5); §7.5 two modes + single-best/select-all (Task 6); §7.6 per-option explanations incl. wrong options (Task 6); §4 header entry (Task 4).
- **One backend touch only** (Task 1), additive and link-out-only — re-verified against the LINK-OUT-ONLY constraint with a negative test assertion.
- **Type contract:** FE `LearningUnitContent` mirrors `learningUnitContentSchema`; if Phase A changes the schema, the FE type and `learnContent.ts` scorers are the sync points.
- **Security:** all unit content rendered as escaped React text (no `dangerouslySetInnerHTML`); external source link uses `rel=noopener`.
- **Open items to confirm during execution:** exact `drugApi.ts` fetch/throw idiom to mirror (Task 3); whether `sourceLinkOutUrl` should be shared server+client or duplicated (Task 1 vs 3 — duplication is acceptable, it's ~6 lines and avoids an api↔src import); the precise `userEvent` setup used in an existing `*.test.tsx` (Task 6). None affect the design.
