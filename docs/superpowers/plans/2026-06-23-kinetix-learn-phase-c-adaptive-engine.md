# Kinetix Learn — Phase C: Adaptive Engine (Attempts → Competence → My Path → Spaced Review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Kinetix Learn from a stateless reader into an adaptive trainer. Persist every graded assessment attempt, derive a per-user **competence profile** across the spec's six dimensions, schedule **spaced-repetition review**, and surface a transparent **My Path** recommendation ("study this next, because…") plus a **Cases & Review** queue of due units. This is the learner-state half that Phases A (authoring) and B (stateless reading) deliberately deferred.

**Architecture:** Two new user-keyed tables — an append-only event log `learning_question_attempts` (one row per answered question, with the question's pedagogical tags **denormalized at attempt time** so later unit edits can't rewrite history) and a per-`(user, unit)` rollup `learning_unit_progress` that also carries the SM-2-style review schedule. A new authenticated write endpoint **grades authoritatively server-side** from the stored unit content (the client is never trusted for `correct`), writes the attempt rows, and upserts progress + the next review date. The competence profile and My Path ranking are **computed on read** by pure, unit-tested functions — no opaque model, no precomputed scores to invalidate. The learner's preference tilt is an additive `users.learn_preferences` jsonb (mirrors `favorite_parameters`). The six-dimension model is made real by an **additive optional `cognitiveSkill` tag** on questions (the spec's Stage 10 already calls for "cognitive skill tested"); legacy questions fall back to their `factual`/`reasoned` category.

**Tech Stack:** TypeScript, Drizzle ORM (PostgreSQL/Neon), raw `node:http` Vercel handlers, Zod at the edge (`api/_lib/schemas.ts`), `getUserFromRequest` for auth, `json`/`error`/`withErrorHandling`/`noStoreHeaders` response helpers. Frontend: React 18 + React Router v6, Zustand `authStore`, `react-i18next` (en/nb chrome), Tailwind + `src/components/ui/*`. Vitest + `@testing-library/react` (jsdom), co-located `*.test.tsx`; API tests under `tests/api/` with `vi.hoisted` mocks for `../../api/_lib/db.js` and `../../api/_lib/auth.js`.

**Decisions locked in (from product owner):**
- **Adaptive core MVP.** Ship the full loop — persist attempts → competence → spaced review → My Path. **Clinical Cases authoring (§5.4 cases) is deferred** to a later phase; "Cases & Review" in this plan is the *Review* half (spaced re-testing of existing unit questions), not new case content.
- **Make the competence model real.** Add an additive optional `cognitiveSkill` tag to the question schema so the six dimensions are genuinely measured as tagged content arrives; legacy/untagged questions fall back to `category`.

## Global Constraints

- **Server grades, server schedules.** `POST /api/learn/attempts` MUST recompute correctness and all pedagogical tags from the stored `learning_units.content` — never persist client-supplied `correct`/`category`/`difficulty`. The client may still grade locally for instant feedback (Phase B behaviour), but the stored record is the server's. This is both a trust boundary and the integrity guarantee for competence stats.
- **History is frozen by denormalization.** Each attempt row stores the question's `category`, `cognitiveSkill`, `difficulty`, and `concepts` *as they were at attempt time*. Competence aggregates from these frozen tags, so editing or re-revisioning a unit later never rewrites a user's measured history. Questions are positional (no stable id in the content schema) — key attempts by `(unitId, questionIndex)` and accept that a unit revision may desync the index↔question mapping for *future* joins; the frozen tags make the aggregates correct regardless.
- **No hard locks (spec §5.2, §6.5).** My Path and prerequisite checks produce *guidance and soft warnings only*. Every published unit stays reachable by URL and from the library/topic map. A unit with unmet essential prerequisites is annotated, never blocked.
- **Transparent recommendations (spec §8).** My Path ranking is a deterministic, inspectable scoring function; every recommendation carries a human-readable reason assembled from stable codes (i18n), e.g. "due for review" / "targets your weakest area: statistical reasoning" / "next step up in pharmacokinetics". No ML, no black box.
- **Chrome bilingual, content not.** New UI strings (My Path, Review, competence labels, recommendation reasons) get `learn.*` keys in `en.json` + `nb.json`. Unit content and question prose render as authored (Norwegian), unchanged.
- **Auth, not group, gates the APIs.** Write/read-progress endpoints require an authenticated session (`getUserFromRequest`; 401 otherwise) keyed to `auth.userId`. Group membership (`kinetix-learn`) remains a *discovery* gate on the menu/links, consistent with Phases B — direct URLs still work for any signed-in user.
- **Additive schema only.** The `cognitiveSkill` field is `.optional()`; the `learn_preferences` column has a default. Existing units (already validated, already authored) MUST keep validating and reading back unchanged. No migration rewrites existing rows.
- **Migrations:** next Drizzle migration is `0061` (latest applied is `0060_disputes_and_notifications`; `learning_units` shipped as `0058`). Hand-write `drizzle/0061_*.sql` matching the `CREATE TABLE IF NOT EXISTS` + `--> statement-breakpoint` style, add the `_journal.json` entry, keep `db/schema.ts` as source of truth. Do **not** extend the baseline list in `scripts/apply-migrations-build.ts` (new migrations flow through the normal migrator).
- **Tests:** `npm run test`, `npm run typecheck`, `npm run lint` all green. `noUncheckedIndexedAccess` is on — guard index access. One commit per task after its tests pass. Branch off `main`; never deploy.

## Where things live (verified)

| Concern | Location | Note |
| --- | --- | --- |
| Learn schema | `db/schema.ts` (`learningUnits` ~723, `users` ~60) | Add two tables after `learningUnitRevisions`; add `learnPreferences` col to `users` |
| Migrations | `drizzle/`, `drizzle/meta/_journal.json`, `scripts/apply-migrations-build.ts` | Hand-written SQL; next is `0061`; don't touch the baseline list |
| Content/question schema | `api/_lib/schemas.ts` (`learningQuestionSchema` ~588, `LEARNING_DIFFICULTIES` ~564) | Add optional `cognitiveSkill` to the question object |
| Auth in handlers | `api/_lib/auth.ts` (`getUserFromRequest` → `{ userId, role, groups }`) | `auth.userId`; 401 via `error(res,401,…)` |
| Response helpers | `api/_lib/response.ts` (`json`, `error`, `withErrorHandling`, `noStoreHeaders`) | User-state responses use `noStoreHeaders()` |
| Read API (existing) | `api/learning-units.ts` | GET-only; Phase C adds new `api/learn-*` handlers, leaves this as-is |
| FE API client | `src/lib/learnApi.ts` | Add `submitAttempt`, `fetchProgress`, `fetchMyPath`, types |
| FE pure helpers | `src/lib/learnContent.ts` (`scoreQuestion`, `gradeAssessment`, `difficultyRank`) | Reuse for client-side preview; add competence/SR/ranking pure libs alongside |
| Assessment UI | `src/components/learn/Assessment.tsx` | Wire submit → `submitAttempt`; keep local scoring |
| Learn pages | `src/pages/learn/` (SourceLibraryPage, TopicMapPage, LearningUnitPage) | Add MyPathPage, ReviewPage; add a shared sub-nav |
| Routes / menu | `src/router.tsx`, `src/components/Header.tsx` (`canAccessKinetixLearn`) | Add `/learn/path`, `/learn/review` |
| Current user (FE) | `src/stores/authStore.ts` (`AuthUser`) | Add `learnPreferences`; `/api/auth?action=me` must include it |
| Preferences write pattern | `api/preferences.ts` (`PATCH`, Zod `.strict()`, `noStoreHeaders`) | Model the preference + attempts writes on this |

---

## Data model (new)

**`learning_question_attempts`** — append-only event log, one row per answered question.

| column | type | notes |
| --- | --- | --- |
| `id` | serial pk | |
| `user_id` | int → users.id `cascade` notnull | |
| `unit_id` | int → learning_units.id `cascade` notnull | |
| `question_index` | int notnull | position in unit content at attempt time |
| `category` | varchar(10) notnull | `'factual' \| 'reasoned'` (frozen) |
| `cognitive_skill` | varchar(30) | nullable; frozen tag (null for legacy) |
| `difficulty` | varchar(30) notnull | frozen |
| `concepts` | jsonb `string[]` notnull default `[]` | frozen |
| `correct` | boolean notnull | server-computed |
| `selected_option_ids` | jsonb `string[]` notnull default `[]` | what the learner picked |
| `mode` | varchar(20) notnull | `'submit_all' \| 'one_at_a_time' \| 'review'` |
| `created_at` | timestamp notnull default now | |

Indexes: `(user_id, created_at)`, `(user_id, unit_id)`.

**`learning_unit_progress`** — rollup + SM-2 review schedule, one row per `(user, unit)`.

| column | type | notes |
| --- | --- | --- |
| `user_id` | int → users.id `cascade` notnull | |
| `unit_id` | int → learning_units.id `cascade` notnull | |
| `attempts` | int notnull default 0 | graded submissions count |
| `best_score_pct` | int notnull default 0 | 0–100 |
| `last_score_pct` | int notnull default 0 | 0–100 |
| `status` | varchar(20) notnull default `'in_progress'` | `'in_progress' \| 'completed' \| 'mastered'` |
| `review_reps` | int notnull default 0 | SM-2 repetition count |
| `review_ease` | int notnull default 250 | ease ×100 (2.50) to stay integer |
| `review_interval_days` | int notnull default 0 | |
| `next_review_at` | timestamp | null until first pass |
| `last_attempt_at` | timestamp notnull default now | |
| `created_at` / `updated_at` | timestamp notnull default now | |

Primary key: `(user_id, unit_id)`. Index: `(user_id, next_review_at)` for the due-review query.

**`users.learn_preferences`** — additive jsonb, default `{}`. Shape (validated at the edge): `{ emphasis?: string[]; preferredDomains?: string[] }` where `emphasis` ⊆ the competence dimensions / `'review'` and `preferredDomains` are curriculum domains.

---

## File Structure

**New files**
- `drizzle/0061_learning_progress.sql` — two tables + `users.learn_preferences` column.
- `api/learn-attempts.ts` — `POST` graded attempts (auth); writes log + upserts progress + SR.
- `api/learn-progress.ts` — `GET` per-unit progress + competence profile + due-review count.
- `api/learn-my-path.ts` — `GET` ranked recommendations with reasons.
- `api/_lib/learn-grading.ts` — server-side authoritative grading + tag extraction from unit content.
- `api/_lib/learn-scheduler.ts` — pure SM-2-lite `scheduleNextReview`.
- `src/lib/learnCompetence.ts` — pure competence aggregation + dimension mapping.
- `src/lib/learnMyPath.ts` — pure recommendation ranking + reason codes.
- `src/pages/learn/MyPathPage.tsx`, `src/pages/learn/ReviewPage.tsx`.
- `src/components/learn/CompetenceProfile.tsx`, `src/components/learn/LearnSubNav.tsx`.
- Tests co-located / under `tests/api/` for each of the above.

**Modified files**
- `db/schema.ts` — two tables + `users.learnPreferences`; type exports.
- `api/_lib/schemas.ts` — optional `cognitiveSkill` on `learningQuestionSchema`; new `attemptSubmitSchema`, `learnPreferencesSchema`.
- `api/auth.ts` (or wherever `action=me` builds its payload) — include `learnPreferences`.
- `api/preferences.ts` — accept `learnPreferences` in the existing PATCH (or a dedicated field).
- `src/lib/learnApi.ts` — `submitAttempt`, `fetchProgress`, `fetchMyPath`, `updateLearnPreferences`, types.
- `src/lib/learnContent.ts` — add `cognitiveSkill` to `LearningQuestion`; `COMPETENCE_DIMENSIONS`, `cognitiveSkillToDimension`.
- `src/components/learn/Assessment.tsx` — POST attempts on grade; surface saved/score.
- `src/stores/authStore.ts` — `AuthUser.learnPreferences`.
- `src/router.tsx`, `src/components/Header.tsx` — routes + (existing) gated entry; sub-nav.
- `src/locales/en.json`, `src/locales/nb.json` — `learn.*` chrome (path, review, competence, reasons).
- `agents/learning-unit-builder.md`, `AGENTS.md` — document `cognitiveSkill` + the learner-state surface.

---

### Task 1: Schema + migration (attempts, progress, preferences)

**Files:** modify `db/schema.ts`; create `drizzle/0061_learning_progress.sql`; add `drizzle/meta/_journal.json` entry; test `tests/lib/learnProgressSchema.test.ts`.

**Interfaces:** `learningQuestionAttempts`, `learningUnitProgress` tables + `$inferSelect`/`$inferInsert` type exports; `users.learnPreferences` jsonb column. Composite PK on progress; indexes as in the data model.

- [ ] **Step 1 — failing test:** assert (via `getTableConfig`) that both tables expose the expected column names, the progress table's PK is `(user_id, unit_id)`, and `users` has a `learn_preferences` column.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the two tables after `learningUnitRevisions` in `db/schema.ts` (follow the `userGroupMembers` composite-PK idiom and `learning_units` audit/timestamp idiom), add `learnPreferences: jsonb('learn_preferences').$type<{ emphasis?: string[]; preferredDomains?: string[] }>().notNull().default({})` to `users`, export types.
- [ ] **Step 4 — run, expect PASS** + `npm run typecheck`.
- [ ] **Step 5 — write `drizzle/0061_learning_progress.sql`** (two `CREATE TABLE IF NOT EXISTS` with `--> statement-breakpoint` between statements/indexes; `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "learn_preferences" JSONB NOT NULL DEFAULT '{}'::jsonb`) and append the `_journal.json` entry (`idx: 61`, tag `0061_learning_progress`).
- [ ] **Step 6 — commit:** `feat(learn): schema + migration for attempts, progress, and learner preferences`.

---

### Task 2: Additive `cognitiveSkill` question tag

**Files:** modify `api/_lib/schemas.ts`; extend `tests/lib/learningUnitSchema.test.ts`; modify `src/lib/learnContent.ts` (FE type + mapping).

**Interfaces:** `COGNITIVE_SKILLS = ['factual_recall','critical_appraisal','statistical_reasoning','clinical_reasoning','mechanistic'] as const`; `learningQuestionSchema` gains `cognitiveSkill: z.enum(COGNITIVE_SKILLS).optional()`. FE `LearningQuestion` gains the optional field. A pure `cognitiveSkillToDimension(skill, category)` maps skill→one of the six dimensions, falling back to `category` (`factual`→`factual_knowledge`, `reasoned`→`clinical_reasoning` as the generic reasoned bucket) when the tag is absent.

- [ ] **Step 1 — failing tests:** a unit whose questions carry a valid `cognitiveSkill` still validates; an invalid skill value is rejected; a unit with **no** `cognitiveSkill` (legacy) still validates (backward-compat guard). FE: `cognitiveSkillToDimension('statistical_reasoning', 'reasoned')` → `'statistical_reasoning'`; `cognitiveSkillToDimension(undefined, 'factual')` → `'factual_knowledge'`.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the optional enum in the Zod question schema and the FE type + mapping in `learnContent.ts` (add `COMPETENCE_DIMENSIONS` const there too).
- [ ] **Step 4 — run, expect PASS** + typecheck.
- [ ] **Step 5 — commit:** `feat(learn): optional cognitiveSkill tag on questions for the competence model`.

---

### Task 3: Server-side authoritative grading + tag extraction

**Files:** create `api/_lib/learn-grading.ts`; test `tests/api/learn-grading.test.ts`.

**Interfaces:** pure functions (no DB): `gradeUnitAttempt(content, answers)` where `answers: Record<number, string[]>` → `{ scorePct, perQuestion: Array<{ questionIndex, correct, category, cognitiveSkill, difficulty, concepts }> }`. Reuses the same single-best/select-all exact-match rule as `learnContent.scoreQuestion` (duplicate the ~6-line rule here — `api/` can't import from `src/`). Only questions present in `answers` are graded; `scorePct` is over answered questions (review may sample a subset).

- [ ] **Step 1 — failing test:** given a 2-question content blob (one single_best, one select_all with a `cognitiveSkill`), grading returns correct per-question verdicts, frozen tags, and the right `scorePct`; an out-of-range `questionIndex` is ignored.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.**
- [ ] **Step 4 — run, expect PASS** + typecheck.
- [ ] **Step 5 — commit:** `feat(learn): authoritative server-side attempt grading`.

---

### Task 4: Spaced-repetition scheduler

**Files:** create `api/_lib/learn-scheduler.ts`; test `tests/api/learn-scheduler.test.ts`.

**Interfaces:** pure `scheduleNextReview(prev: { reps; easeX100; intervalDays }, scorePct, now)` → `{ reps; easeX100; intervalDays; nextReviewAt }`. SM-2-lite: derive a quality 0–5 from `scorePct`; a *pass* (quality ≥ 3) increments reps and sets interval `1 → 6 → round(prevInterval × ease)`, nudging ease; a *fail* resets reps to 0 and interval to 1. Ease floored at 130 (1.30). All integer math (ease ×100). `nextReviewAt = now + intervalDays`.

- [ ] **Step 1 — failing tests:** first pass → interval 1, reps 1; second pass → interval 6, reps 2; third pass → interval ≈ round(6 × ease/100); a fail → reps 0, interval 1; ease never drops below 130.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement.**
- [ ] **Step 4 — run, expect PASS.**
- [ ] **Step 5 — commit:** `feat(learn): SM-2-lite spaced-repetition scheduler`.

---

### Task 5: `POST /api/learn/attempts` — persist a graded attempt

**Files:** create `api/learn-attempts.ts`; add `attemptSubmitSchema` to `api/_lib/schemas.ts`; test `tests/api/learn-attempts-route.test.ts`.

**Interfaces:** `POST /api/learn/attempts` body `{ unitId: number; mode: 'submit_all'|'one_at_a_time'|'review'; answers: Record<number, string[]> }`. Auth required (401 via `getUserFromRequest`). Loads the published unit, calls `gradeUnitAttempt`, inserts one `learning_question_attempts` row per answered question (frozen tags), upserts `learning_unit_progress` (bump `attempts`, update `best/last_score_pct`, set `status` — `mastered` when `best_score_pct ≥ 90` from a full attempt — and call `scheduleNextReview`), responds `{ scorePct, status, nextReviewAt, perQuestion }` with `noStoreHeaders()`. Unknown/unpublished `unitId` → 404.

- [ ] **Step 1 — failing test** (mock `db` + `auth` via `vi.hoisted`, `Readable.from` request, capture response): a valid submit by `{ userId: 5 }` inserts attempt rows and upserts progress and returns the server-computed score; an unauthenticated request → 401; an unknown unit → 404. Assert the stored `correct` comes from the server grade even when the client sends a contradictory value (i.e. the body has no `correct` field to trust).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the handler (`withErrorHandling`); add the Zod schema (`.strict()`, `answers` as a record of index→string[] with bounded sizes).
- [ ] **Step 4 — run, expect PASS** + typecheck.
- [ ] **Step 5 — commit:** `feat(learn): persist graded assessment attempts and review schedule`.

---

### Task 6: `GET /api/learn/progress` — progress + competence profile

**Files:** create `api/learn-progress.ts`; create `src/lib/learnCompetence.ts` (pure aggregation, shared shape); tests `tests/api/learn-progress-route.test.ts` + `src/lib/learnCompetence.test.ts`.

**Interfaces:** `GET /api/learn/progress` (auth) → `{ units: Array<{ unitId, attempts, bestScorePct, status, nextReviewAt }>, competence: CompetenceProfile, dueReviewCount }`. `CompetenceProfile` = per-dimension `{ dimension, accuracyPct, sampleCount }` for the four skill dimensions + a `retention` stat (accuracy over `mode='review'` attempts) + the user's declared `preference`. The aggregation (attempts[] → profile, via `cognitiveSkillToDimension`) lives in `learnCompetence.ts` so it's unit-testable without a DB and reusable by the FE for previews. Dimensions with zero samples report `null` accuracy ("not yet measured") rather than 0.

- [ ] **Step 1 — failing tests:** `learnCompetence` aggregates a mixed attempt list into the right per-dimension accuracies and sample counts, maps untagged reasoned/factual via fallback, and reports `null` for unsampled dimensions. Route test: returns the assembled payload for an authed user; 401 otherwise.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the pure lib then the handler (query attempts + progress for `auth.userId`, count due reviews where `next_review_at ≤ now`).
- [ ] **Step 4 — run, expect PASS** + typecheck.
- [ ] **Step 5 — commit:** `feat(learn): progress + competence profile read API`.

---

### Task 7: `GET /api/learn/my-path` — transparent recommendations

**Files:** create `src/lib/learnMyPath.ts` (pure ranking + reason codes); create `api/learn-my-path.ts`; tests `src/lib/learnMyPath.test.ts` + `tests/api/learn-my-path-route.test.ts`.

**Interfaces:** pure `rankRecommendations({ units, progress, competence, preferences, now })` → ordered `Array<{ unitId, score, reasonCode, prerequisiteWarning?: string[] }>`. Scoring factors (transparent, weighted, documented in-file):
  1. **Due for review** (progress.nextReviewAt ≤ now) — top priority; `reasonCode: 'due_review'`.
  2. **Weakest-dimension targeting** — boost units whose dominant dimension matches the user's lowest-accuracy sampled dimension; `reasonCode: 'targets_weakness'`.
  3. **Prerequisite readiness** — if a unit's *essential* prerequisite concepts aren't yet evidenced in the user's correct-attempt concept set, attach a soft `prerequisiteWarning` (never exclude); otherwise small readiness boost.
  4. **Difficulty progression** — prefer the next difficulty rank above the user's demonstrated max; `reasonCode: 'next_step'`.
  5. **Preference tilt** — boost `preferredDomains` / `emphasis`; `reasonCode: 'matches_preference'`.
Mastered units drop out of the "next" pool but can resurface via factor 1. `GET /api/learn/my-path` (auth) composes the three reads (units list, progress, competence, prefs) and returns the ranked list with reason codes the FE renders via i18n templates.

- [ ] **Step 1 — failing tests:** a due unit ranks first; with no due units, the unit matching the weakest dimension outranks an unrelated one; a unit missing an essential prerequisite still appears but carries a warning; preference tilt breaks ties. Route test: authed → ranked payload; 401 otherwise.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** pure lib then handler.
- [ ] **Step 4 — run, expect PASS** + typecheck.
- [ ] **Step 5 — commit:** `feat(learn): transparent My Path recommendation engine`.

---

### Task 8: Persist attempts from the Assessment UI + learnApi client

**Files:** modify `src/lib/learnApi.ts` (add `submitAttempt`, `fetchProgress`, `fetchMyPath`, `updateLearnPreferences` + types); modify `src/components/learn/Assessment.tsx`; extend `Assessment.test.tsx`.

**Interfaces:** `submitAttempt({ unitId, mode, answers })` → server grade. When the learner grades in `Assessment` (submit-all submit, or after the last one-at-a-time reveal), POST the collected `answers`; keep the existing local scoring for instant feedback, then reconcile with the server response (and show a subtle "progress saved"). `Assessment` gains a `unitId` prop (the page passes it). Failures to persist are non-fatal (local feedback still shows) — surface a quiet retry affordance, don't block.

- [ ] **Step 1 — failing test:** on submit, `submitAttempt` is called once with the selected answers keyed by index and the unit id; a rejected `submitAttempt` still shows the local score (no crash).
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the client fns and wire the component (mock `learnApi` in the test; pass `unitId` from `LearningUnitPage`).
- [ ] **Step 4 — run, expect PASS** + typecheck.
- [ ] **Step 5 — commit:** `feat(learn): persist assessment attempts from the unit view`.

---

### Task 9: My Path page + competence profile + preference tilt

**Files:** create `src/pages/learn/MyPathPage.tsx`, `src/components/learn/CompetenceProfile.tsx`, `src/components/learn/LearnSubNav.tsx`; modify `src/router.tsx`, `src/components/Header.tsx`, `src/stores/authStore.ts`, `api/auth.ts` (+ `api/preferences.ts`), locales; tests for the page + CompetenceProfile.

**Interfaces:** route `/learn/path` (auth) renders the competence profile (per-dimension bars with sample counts; "not yet measured" for null), the ranked recommendation list (each card: unit title, difficulty, a reason rendered from `reasonCode` + optional prerequisite warning, link to the unit), and a small **preference tilt** control (emphasis + preferred domains) that calls `updateLearnPreferences`. `LearnSubNav` (Library · Topic map · My Path · Review) is shared across the learn pages. `AuthUser.learnPreferences` is added and surfaced by `/api/auth?action=me`; the preference write reuses the `api/preferences.ts` PATCH idiom.

- [ ] **Step 1 — failing tests:** `CompetenceProfile` renders a bar per dimension and the "not measured" state for null; `MyPathPage` (mocking `fetchMyPath`/`fetchProgress`) renders recommendation cards with their reason text and links. (Keep data-fetch `useEffect` deps free of `t` — store errors as state, translate at render — per the Phase B render-loop lesson.)
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** page, components, route, sub-nav, the `learnPreferences` wiring (authStore + me payload + preferences PATCH), and `learn.path.*` / `learn.competence.*` / `learn.reason.*` locale keys (en + nb).
- [ ] **Step 4 — run, expect PASS** + typecheck + lint.
- [ ] **Step 5 — commit:** `feat(learn): My Path page with competence profile and preference tilt`.

---

### Task 10: Cases & Review page (spaced review runner)

**Files:** create `src/pages/learn/ReviewPage.tsx`; modify `src/router.tsx`, locales; test `ReviewPage.test.tsx`.

**Interfaces:** route `/learn/review` (auth) lists units due for review (`nextReviewAt ≤ now`, from `fetchProgress`), each with a "Review" action that opens the unit's `Assessment` in `mode='review'` over a sampled subset of its questions; submitting posts a `review`-mode attempt (Task 8 path), which re-schedules via the server. Empty state: "Nothing due — come back later." This is the *Review* half only; **Clinical Cases content is explicitly out of scope** (deferred).

- [ ] **Step 1 — failing test:** with two due units mocked, both render with a review action; the empty state shows when none are due.
- [ ] **Step 2 — run, expect FAIL.**
- [ ] **Step 3 — implement** the page + `learn.review.*` locale keys (en + nb). Reuse `Assessment` with `mode='review'`.
- [ ] **Step 4 — run, expect PASS** + typecheck + lint.
- [ ] **Step 5 — commit:** `feat(learn): Cases & Review page with spaced-review runner`.

---

### Task 11: Docs + agent prompt + full-suite gate

**Files:** modify `agents/learning-unit-builder.md`, `AGENTS.md`.

- [ ] **Step 1 — update the agent prompt** to emit a `cognitiveSkill` per question (Stage 10 "cognitive skill tested" → the new enum), explaining the four reasoning dimensions it feeds.
- [ ] **Step 2 — update AGENTS.md**: extend the learner-UI row to note the adaptive engine (attempts/progress/My Path/review APIs, `learnCompetence`/`learnMyPath`/`learn-scheduler`/`learn-grading`), the `cognitiveSkill` tag, and that Clinical Cases authoring remains deferred.
- [ ] **Step 3 — run `npm run test && npm run typecheck && npm run lint`** — all green.
- [ ] **Step 4 — commit:** `docs(learn): document the Phase C adaptive engine and cognitiveSkill tag`.

---

## Competence & ranking math (reference)

- **Dimension accuracy** = correct / answered over attempts mapped to that dimension via `cognitiveSkillToDimension(skill, category)`; `< 1` sample → `null` (not measured), shown distinctly.
- **Retention** = accuracy over `mode='review'` attempts (recall under spacing); `null` until the first review.
- **Mastery** = `best_score_pct ≥ 90` on a full (non-sampled) attempt → `status='mastered'`; `≥ 50` → `completed`; else `in_progress`.
- **SM-2-lite quality** from `scorePct`: `≥90→5, ≥80→4, ≥60→3 (pass)`, `≥40→2, ≥20→1, else 0 (fail)`; pass advances `1→6→round(interval×ease)`, ease `+ (0.1 − (5−q)(0.08 + (5−q)0.02))` clamped ≥1.30; fail resets to interval 1, reps 0.
- **My Path score** = weighted sum (due ≫ weakness > next-step > preference), prerequisite gaps annotate only. Weights live as named constants in `learnMyPath.ts`.

## Manual verification (after Task 10)

1. As a `kinetix-learn` user, open a unit, take its assessment, submit → "progress saved"; reload `/learn/path` and see the unit's score reflected and the competence bars move.
2. Answer mostly statistical-reasoning questions wrong → "statistical reasoning" shows as the weakest dimension and My Path surfaces a `targets_weakness` recommendation naming it.
3. A unit with an unmet essential prerequisite appears in My Path with a soft warning, still openable.
4. Pass a unit, confirm `nextReviewAt` is set; fast-forward (or seed) a due date → it appears in `/learn/review`; complete the review → it re-schedules with a longer interval.
5. Set a preference tilt (e.g. prefer pharmacokinetics) → matching units rank higher with a `matches_preference` reason.
6. Confirm the read API and direct unit URLs still work for a non-group user (no hard locks); the menu entry is hidden for non-members.

## Deferred (NOT in this plan)

- **Clinical Cases content type (§5.4)** — authored, safety-framed case scenarios with their own schema, authoring/review path, and UI. A separate phase; the spec's "educational case only" framing and case content are not built here.
- **In-prose Kinetix cross-linking (§4, §6)** — still pending from Phase B; independent of the adaptive engine.
- **§15 update/maintenance model** — agent/review surfacing of outdated sources; not learner-state.
- **Cross-user analytics / cohort dashboards** — Phase C is per-learner only.
- **Server-side competence caching** — compute-on-read is sufficient at current scale; revisit if attempt volume demands it.

## Self-Review

- **Decisions honored:** Adaptive core MVP only (Tasks 5–10 deliver attempts→competence→My Path→review; Clinical Cases explicitly deferred). `cognitiveSkill` tag added additively (Task 2), making the six-dimension profile real while staying backward-compatible.
- **Spec coverage:** §5.1 My Path (Task 7+9), §5.2 soft prerequisite warnings (Task 7, no hard locks), §5.4 *Review* half (Task 10), §8 six dimensions incl. retention + preference (Tasks 2,6,9), §7.5 modes incl. `review` (Tasks 5,10). §5.4 *Cases* and §15 deferred and named.
- **Integrity:** server-authoritative grading (Task 3,5) + frozen denormalized tags (Task 1) mean competence can't be spoofed by the client and isn't rewritten by later unit edits — the central correctness argument, re-checked against the "questions have no stable id" caveat.
- **Reused conventions:** user-keyed tables (`userGroupMembers` composite-PK idiom), hand-written migration `0061`, `getUserFromRequest`→`auth.userId` + 401, `json/error/withErrorHandling/noStoreHeaders`, `vi.hoisted` db/auth mocks, the Phase B render-loop lesson (no `t` in fetch effects).
- **Pure-core testability:** grading, scheduling, competence, and ranking are all DB-free pure functions with their own tests, so the hard logic is verified without HTTP/DB plumbing.
- **Open items to confirm during execution:** exact location where `/api/auth?action=me` assembles its user payload (Task 9 — add `learnPreferences`); whether preference writes belong in `api/preferences.ts` PATCH or a dedicated endpoint (Task 9 — default to extending PATCH); the precise upsert idiom for the composite-PK progress row in Drizzle (`onConflictDoUpdate` on `(user_id, unit_id)`) (Task 5). None affect the design.
