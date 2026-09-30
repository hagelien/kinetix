# Kinetix Learn — Phase A: Source-Anchored Learning-Unit Authoring & Verification Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let agents and contributors author source-anchored *learning units* (a source card, prerequisites, pre-reading guide, learning objectives, and ≥10 explained questions) that flow through the existing pending-edit review queue with agent peer-consensus, and are stored as versioned rows retrievable by an API.

**Architecture:** A learning unit is a new content type that reuses the existing `pending_edits` → `agent_verifications` → apply pipeline rather than growing a parallel one. It is anchored to a `citations` row that already carries a read-in-full `paper_review`, so Stages 1–4 of the spec's unit-builder agent (source intake, suitability, quality appraisal, structured extraction) are *consumed from the existing review*, not repeated. A new `learning_unit` `editType` carries the whole unit as `proposedValue` (like the `wiki_page` snapshot model); approval writes a `learning_units` row + a `learning_unit_revisions` history row and stamps an approval, exactly mirroring the `wiki_page` branch. Peer consensus (quorum, dispute-blocks, implicit-approve) is inherited unchanged.

**Tech Stack:** TypeScript, Drizzle ORM (PostgreSQL/Neon), raw `node:http` Vercel serverless handlers, Zod validation at the API edge, Vitest unit tests with `vi.hoisted` mocks for `getDb`/`auth`.

**Scope boundary:** This plan delivers the *authoring and storage* half only. The learner-facing UI (Topic Map, Source Library page, unit renderer, assessment UI, header-menu entry) is **Phase B**, and the adaptive engine (My Path, competence dimensions, spaced repetition) is **Phase C** — each a separate plan. Phase A ends with a working, tested backend: a unit can be submitted, peer-verified, approved, stored, and read back over HTTP.

## Global Constraints

- **Source content is link-out only.** Learning units MUST NOT embed or serve the ingested source PDF/full text. The unit links to the source (DOI/PMID/URL on the citation); learners retrieve it themselves. No task in this plan exposes `citation_pdfs` or paper full text to a learner-facing route.
- **Unit content language is Norwegian.** Unit prose (source card, prompts, questions, explanations) is author-written *content*, treated like wiki page content — exempt from the dual-locale rule per `AGENTS.md` ("User-generated content stays in whatever language the author wrote it"). Do NOT add `en.json`/`nb.json` keys for unit content. (Phase B chrome — menu labels, buttons — will be bilingual; not in this plan.)
- **Reference gate is mandatory.** A learning unit MUST anchor exactly one resolvable citation that carries a read-in-full `paper_review` (or a pending `paper_review` claiming `readInFull`). Reuse `assertReferencesJudged(referenceIds)` — do not write a second gate.
- **API style:** raw `node:http` handlers (NOT Express); Zod schemas at the boundary in `api/_lib/schemas.ts`; no human prose hardcoded in `api/` responses that can reach UI — use stable codes.
- **DB column width:** `pending_edits.edit_type` is `varchar(20)`. The new value `learning_unit` (13 chars) fits; do not exceed 20.
- **Migrations:** next Drizzle migration number is `0052`. Hand-write the `.sql` under `drizzle/` to match the existing `CREATE TABLE IF NOT EXISTS` + `--> statement-breakpoint` style; keep `db/schema.ts` as the source of truth.
- **Exhaustive switches:** `targetAuthorUserId` and `verificationTargetVersion` in `api/_lib/agent-verifications.ts` switch over `AgentVerificationTargetType`. Adding a member makes TypeScript flag the missing cases — that is the intended compile-time checklist.
- **Tests:** `npm run test` (Vitest). API-route tests live under `tests/api/` and mock `../../api/_lib/db.js` and `../../api/_lib/auth.js` via `vi.hoisted`. Pure helper/schema tests can import the module directly.
- **Commit cadence:** one commit per task (after its tests pass). Branch off `main`; never deploy.

---

## File Structure

**New files**
- `drizzle/0052_learning_units.sql` — migration for the two tables.
- `tests/api/learning-units-route.test.ts` — read-API tests.
- `tests/api/pending-edits-learning-unit.test.ts` — submit-gate + apply tests.
- `tests/lib/learningUnitSchema.test.ts` — content-schema validation tests.
- `api/learning-units.ts` — GET read API (`?id=`, `?citationId=`, list).
- `agents/learning-unit-builder.md` — the single full-cycle agent prompt (consumes the existing paper review).

**Modified files**
- `db/schema.ts` — add `learningUnits` + `learningUnitRevisions` tables; extend `ApprovalTargetType` with `'learning_unit_revision'`.
- `api/_lib/schemas.ts` — add `learningUnitContentSchema`; add `'learning_unit'` to `createPendingEditSchema.editType` + a `superRefine` branch.
- `api/_lib/agent-verifications.ts` — add `case 'learning_unit_revision'` to `targetAuthorUserId` and `verificationTargetVersion`.
- `api/_lib/pending-edits-helpers.ts` — add `applyApprovedLearningUnit`, wire it into `applyApprovedEditEffects`, add conflict marking.
- `api/pending-edits.ts` — allow `learning_unit` submissions (contributor+), enforce the reference gate, persist `referenceIds`.
- `AGENTS.md` — add a "Where to look" row for Kinetix Learn.

---

### Task 1: Database schema + migration for learning units

**Files:**
- Modify: `db/schema.ts` (add two tables after `paperReviews`, ~line 705; extend `ApprovalTargetType` ~line 1299)
- Create: `drizzle/0052_learning_units.sql`
- Test: `tests/lib/learningUnitSchema.test.ts` (schema-shape assertion only in this task)

**Interfaces:**
- Produces: `learningUnits` table (`id`, `citationId`, `slug`, `title`, `content jsonb`, `difficulty`, `domains jsonb`, `status`, `createdBy`, `updatedBy`, `createdAt`, `updatedAt`); `learningUnitRevisions` table (`id`, `unitId`, `content jsonb`, `editSummary`, `pendingEditId`, `createdBy`, `createdAt`); type exports `LearningUnit`, `NewLearningUnit`, `LearningUnitRevision`. `ApprovalTargetType` now includes `'learning_unit_revision'`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/learningUnitSchema.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { learningUnits, learningUnitRevisions } from '../../db/schema.ts';
import { getTableConfig } from 'drizzle-orm/pg-core';

describe('learning unit tables', () => {
  it('learning_units has the expected columns', () => {
    const cols = getTableConfig(learningUnits).columns.map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'citation_id', 'slug', 'title', 'content',
        'difficulty', 'domains', 'status', 'created_by', 'updated_by',
        'created_at', 'updated_at',
      ]),
    );
  });

  it('learning_unit_revisions links back to the unit and pending edit', () => {
    const cols = getTableConfig(learningUnitRevisions).columns.map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'unit_id', 'content', 'edit_summary', 'pending_edit_id',
        'created_by', 'created_at',
      ]),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/lib/learningUnitSchema.test.ts`
Expected: FAIL — `learningUnits`/`learningUnitRevisions` are not exported from `db/schema.ts`.

- [ ] **Step 3: Add the tables to `db/schema.ts`**

Insert after the `paperReviews` table (after its closing `);`, ~line 705). The `content` column holds the full unit JSON validated by `learningUnitContentSchema` (Task 3). `slug` is unique for stable URLs in Phase B.

```typescript
// ─── Kinetix Learn: source-anchored learning units (Phase A) ────────────────
//
// One published unit per row, anchored to a citation that already carries a
// read-in-full paper_review (the reference gate is enforced at submit time).
// `content` is the validated unit payload (source card, prerequisites,
// pre-reading prompts, objectives, questions); see learningUnitContentSchema.
// Revisions mirror wiki_revisions / drug_parameter_revisions: every approved
// change inserts one history row linked back to the pending edit that produced
// it, so agent peer-verification can target the revision.

export const learningUnits = pgTable(
  'learning_units',
  {
    id: serial('id').primaryKey(),
    citationId: integer('citation_id')
      .references(() => citations.id, { onDelete: 'restrict' })
      .notNull(),
    slug: varchar('slug', { length: 300 }).unique().notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    content: jsonb('content').notNull(),
    /** 'foundational' | 'intermediate_lis' | 'advanced_lis' | 'board' | 'senior' | 'research'. */
    difficulty: varchar('difficulty', { length: 30 }).notNull(),
    /** Curriculum domains (e.g. ['pharmacokinetics']); validated at the API edge. */
    domains: jsonb('domains').$type<string[]>().notNull().default([]),
    /** 'published' (only state Phase A emits). */
    status: varchar('status', { length: 20 }).notNull().default('published'),
    createdBy: integer('created_by')
      .references(() => users.id)
      .notNull(),
    updatedBy: integer('updated_by').references(() => users.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('learning_units_citation_idx').on(t.citationId),
    index('learning_units_difficulty_idx').on(t.difficulty),
  ],
);

export const learningUnitRevisions = pgTable(
  'learning_unit_revisions',
  {
    id: serial('id').primaryKey(),
    unitId: integer('unit_id')
      .references(() => learningUnits.id, { onDelete: 'cascade' })
      .notNull(),
    content: jsonb('content').notNull(),
    editSummary: varchar('edit_summary', { length: 500 }),
    pendingEditId: integer('pending_edit_id').references(
      () => pendingEdits.id,
      { onDelete: 'set null' },
    ),
    createdBy: integer('created_by')
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('learning_unit_rev_unit_idx').on(t.unitId, t.createdAt),
  ],
);

export type LearningUnit = typeof learningUnits.$inferSelect;
export type NewLearningUnit = typeof learningUnits.$inferInsert;
export type LearningUnitRevision = typeof learningUnitRevisions.$inferSelect;
```

> Do NOT touch `ApprovalTargetType` in this task — Task 2 extends it together with the matching switch cases so typecheck stays clean within each task.

- [ ] **Step 4: Run the schema test to verify it passes**

Run: `npm run test -- tests/lib/learningUnitSchema.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the migration `drizzle/0052_learning_units.sql`**

```sql
-- Kinetix Learn Phase A: source-anchored learning units + revision history.
-- A unit is anchored to a citation that already carries a read-in-full
-- paper_review (gate enforced at submit time). Revisions mirror
-- wiki_revisions so agent peer-verification can target an approved revision.

CREATE TABLE IF NOT EXISTS "learning_units" (
  "id"          SERIAL PRIMARY KEY,
  "citation_id" INTEGER NOT NULL REFERENCES "citations"("id") ON DELETE RESTRICT,
  "slug"        VARCHAR(300) NOT NULL UNIQUE,
  "title"       VARCHAR(500) NOT NULL,
  "content"     JSONB NOT NULL,
  "difficulty"  VARCHAR(30) NOT NULL,
  "domains"     JSONB NOT NULL DEFAULT '[]'::jsonb,
  "status"      VARCHAR(20) NOT NULL DEFAULT 'published',
  "created_by"  INTEGER NOT NULL REFERENCES "users"("id"),
  "updated_by"  INTEGER REFERENCES "users"("id"),
  "created_at"  TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"  TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_units_citation_idx"
  ON "learning_units" ("citation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_units_difficulty_idx"
  ON "learning_units" ("difficulty");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learning_unit_revisions" (
  "id"              SERIAL PRIMARY KEY,
  "unit_id"         INTEGER NOT NULL REFERENCES "learning_units"("id") ON DELETE CASCADE,
  "content"         JSONB NOT NULL,
  "edit_summary"    VARCHAR(500),
  "pending_edit_id" INTEGER REFERENCES "pending_edits"("id") ON DELETE SET NULL,
  "created_by"      INTEGER NOT NULL REFERENCES "users"("id"),
  "created_at"      TIMESTAMP NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_unit_rev_unit_idx"
  ON "learning_unit_revisions" ("unit_id", "created_at");
```

- [ ] **Step 6: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS. The new tables are purely additive; this task does not touch `ApprovalTargetType` (Task 2 does), so the existing `agent-verifications.ts` switches remain exhaustive and typecheck stays clean.

- [ ] **Step 7: Commit**

```bash
git add db/schema.ts drizzle/0052_learning_units.sql tests/lib/learningUnitSchema.test.ts
git commit -m "feat(learn): add learning_units + learning_unit_revisions schema"
```

---

### Task 2: Extend agent-verification target switches for learning_unit_revision

**Files:**
- Modify: `api/_lib/agent-verifications.ts` (`targetAuthorUserId` ~line 242, `verificationTargetVersion` ~line 291)
- Test: `tests/api/agent-verifications-learning-unit.test.ts`

**Interfaces:**
- Consumes: `learningUnitRevisions` (Task 1), `AgentVerificationTargetType` (now includes `'learning_unit_revision'` transitively via `ApprovalTargetType`).
- Produces: `targetAuthorUserId({ targetType: 'learning_unit_revision', targetId })` returns the revision's `createdBy`; `verificationTargetVersion(...)` returns the revision's `createdAt` ISO string. These let the consensus engine attribute and version-check learning-unit verdicts with no other changes.

- [ ] **Step 1: Write the failing test**

Create `tests/api/agent-verifications-learning-unit.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));

import {
  targetAuthorUserId,
  verificationTargetVersion,
} from '../../api/_lib/agent-verifications.ts';

function selectReturning(row: unknown) {
  return {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => [row] }) }),
    }),
  };
}

describe('learning_unit_revision verification target', () => {
  beforeEach(() => getDbMock.mockReset());

  it('resolves the author from learning_unit_revisions.createdBy', async () => {
    getDbMock.mockReturnValue(selectReturning({ createdBy: 42 }));
    const author = await targetAuthorUserId({
      targetType: 'learning_unit_revision',
      targetId: 7,
    });
    expect(author).toBe(42);
  });

  it('versions on the revision createdAt', async () => {
    const when = new Date('2026-06-17T10:00:00.000Z');
    getDbMock.mockReturnValue(selectReturning({ createdAt: when }));
    const version = await verificationTargetVersion({
      targetType: 'learning_unit_revision',
      targetId: 7,
    });
    expect(version).toBe('2026-06-17T10:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/api/agent-verifications-learning-unit.test.ts`
Expected: FAIL — the switch has no `learning_unit_revision` case (returns `undefined`/throws), and/or `npm run typecheck` reports a non-exhaustive switch.

- [ ] **Step 3: Extend `ApprovalTargetType`, then add the switch cases**

First widen the type in `db/schema.ts` (~line 1299) so `'learning_unit_revision'` becomes a valid target everywhere `AgentVerificationTargetType` flows. Doing it here (not in Task 1) keeps both this type change and its switch cases in one atomic, typecheck-clean commit:

```typescript
export type ApprovalTargetType =
  | 'wiki_revision'
  | 'drug_parameter_revision'
  | 'drug_discussion'
  | 'paper_review'
  | 'learning_unit_revision';
```

Then ensure `learningUnitRevisions` is imported at the top of `api/_lib/agent-verifications.ts` (add to the existing `@db/schema` / `db/schema` import group alongside `wikiRevisions`, `drugParameterRevisions`), and add a case to `targetAuthorUserId`'s switch (after the `paper_review` case, before `pending_edit`):

```typescript
    case 'learning_unit_revision': {
      const [row] = await db
        .select({ createdBy: learningUnitRevisions.createdBy })
        .from(learningUnitRevisions)
        .where(eq(learningUnitRevisions.id, args.targetId))
        .limit(1);
      return row?.createdBy ?? null;
    }
```

And the matching case in `verificationTargetVersion`:

```typescript
    case 'learning_unit_revision': {
      const [row] = await db
        .select({ createdAt: learningUnitRevisions.createdAt })
        .from(learningUnitRevisions)
        .where(eq(learningUnitRevisions.id, args.targetId))
        .limit(1);
      return row?.createdAt.toISOString() ?? null;
    }
```

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run: `npm run test -- tests/api/agent-verifications-learning-unit.test.ts && npm run typecheck`
Expected: PASS, and the switches are exhaustive again.

- [ ] **Step 5: Commit**

```bash
git add db/schema.ts api/_lib/agent-verifications.ts tests/api/agent-verifications-learning-unit.test.ts
git commit -m "feat(learn): verify learning_unit_revision targets in consensus engine"
```

---

### Task 3: Learning-unit content schema + editType wiring

**Files:**
- Modify: `api/_lib/schemas.ts` (add `learningUnitContentSchema` near the other content schemas; extend `createPendingEditSchema.editType` ~line 427 and its `superRefine` ~line 450)
- Test: extend `tests/lib/learningUnitSchema.test.ts`

**Interfaces:**
- Produces: `learningUnitContentSchema` (Zod) and `LearningUnitContent` type. `createPendingEditSchema.editType` now accepts `'learning_unit'`. On `editType === 'learning_unit'`, `superRefine` requires: `proposedValue` parses as `learningUnitContentSchema`; `referenceId` OR a single-element `referenceIds` present (the anchor citation); `proposedMeta` carries `{ title: string; slug: string; difficulty: string; domains: string[] }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/learningUnitSchema.test.ts`:

```typescript
import {
  learningUnitContentSchema,
  createPendingEditSchema,
} from '../../api/_lib/schemas.ts';

function validUnitContent() {
  const option = (id: string, correct: boolean) => ({
    id,
    text: `alternativ ${id}`,
    isCorrect: correct,
    explanation: `forklaring for ${id} som er minst tjue tegn lang`,
  });
  const question = (n: number) => ({
    stem: `Spørsmål ${n} om kilden?`,
    format: 'single_best' as const,
    category: 'factual' as const,
    options: [option('a', true), option('b', false), option('c', false), option('d', false)],
    difficulty: 'foundational' as const,
    concepts: ['drug_clearance'],
    sourceSupport: 'Avsnitt 2 i kilden.',
  });
  return {
    sourceCard: {
      whyItMatters: 'Denne kilden forankrer kjernebegrepet clearance.',
      sourceStatus: ['foundational'],
      estimatedReadingMinutes: 20,
    },
    prerequisites: [
      { concept: 'drug_clearance', level: 'essential' as const, why: 'Trengs for eksponering.' },
    ],
    preReadingPrompts: [
      'Legg merke til hvordan eksponering defineres.',
      'Se om komparatoren støtter konklusjonen.',
      'Vurder om endepunktet er klinisk meningsfullt.',
    ],
    objectives: ['Forstå clearance i kontekst av kilden.'],
    questions: Array.from({ length: 10 }, (_unused, i) => question(i + 1)),
  };
}

describe('learningUnitContentSchema', () => {
  it('accepts a well-formed unit', () => {
    expect(learningUnitContentSchema.safeParse(validUnitContent()).success).toBe(true);
  });

  it('rejects fewer than 10 questions', () => {
    const bad = { ...validUnitContent(), questions: validUnitContent().questions.slice(0, 5) };
    expect(learningUnitContentSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects fewer than 3 pre-reading prompts', () => {
    const bad = { ...validUnitContent(), preReadingPrompts: ['bare én'] };
    expect(learningUnitContentSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a single_best question with no correct option', () => {
    const content = validUnitContent();
    content.questions[0].options.forEach((o) => (o.isCorrect = false));
    expect(learningUnitContentSchema.safeParse(content).success).toBe(false);
  });
});

describe('createPendingEditSchema learning_unit branch', () => {
  const base = {
    editType: 'learning_unit' as const,
    proposedValue: validUnitContent(),
    referenceIds: [12],
    proposedMeta: {
      title: 'Hvorfor kjernebegreper betyr noe',
      slug: 'hvorfor-kjernebegreper',
      difficulty: 'foundational',
      domains: ['pharmacokinetics'],
    },
  };

  it('accepts a complete learning_unit edit', () => {
    expect(createPendingEditSchema.safeParse(base).success).toBe(true);
  });

  it('rejects a learning_unit edit with no anchor citation', () => {
    const { referenceIds, ...noRef } = base;
    expect(createPendingEditSchema.safeParse(noRef).success).toBe(false);
  });

  it('rejects a learning_unit edit missing proposedMeta.slug', () => {
    const bad = { ...base, proposedMeta: { ...base.proposedMeta, slug: undefined } };
    expect(createPendingEditSchema.safeParse(bad).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- tests/lib/learningUnitSchema.test.ts`
Expected: FAIL — `learningUnitContentSchema` is not exported and `editType` rejects `'learning_unit'`.

- [ ] **Step 3: Add `learningUnitContentSchema` to `api/_lib/schemas.ts`**

Place it with the other content schemas (near `metabolismWriteSchema`). Keep it strict enough to make the self-audit (spec Stage 13) enforceable in code: every option carries an explanation, single-best has exactly one correct option, select-all has ≥1.

```typescript
export const LEARNING_DIFFICULTIES = [
  'foundational',
  'intermediate_lis',
  'advanced_lis',
  'board',
  'senior',
  'research',
] as const;

export const PREREQUISITE_LEVELS = [
  'essential',
  'helpful',
  'advanced_adjacent',
  'optional_context',
] as const;

const learningQuestionOptionSchema = z.object({
  id: z.string().trim().min(1).max(8),
  text: z.string().trim().min(1).max(600),
  isCorrect: z.boolean(),
  // Spec §7.6: every option — including wrong ones — is explained.
  explanation: z.string().trim().min(20).max(1200),
});

const learningQuestionSchema = z
  .object({
    stem: z.string().trim().min(1).max(1000),
    format: z.enum(['single_best', 'select_all']),
    category: z.enum(['factual', 'reasoned']),
    options: z.array(learningQuestionOptionSchema).min(2).max(8),
    difficulty: z.enum(LEARNING_DIFFICULTIES),
    concepts: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    sourceSupport: z.string().trim().min(1).max(1000),
  })
  .superRefine((q, ctx) => {
    const correct = q.options.filter((o) => o.isCorrect).length;
    if (q.format === 'single_best' && correct !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'single_best questions must have exactly one correct option',
        path: ['options'],
      });
    }
    if (q.format === 'select_all' && correct < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'select_all questions must have at least one correct option',
        path: ['options'],
      });
    }
    const ids = new Set(q.options.map((o) => o.id));
    if (ids.size !== q.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'option ids must be unique within a question',
        path: ['options'],
      });
    }
  });

export const learningUnitContentSchema = z.object({
  sourceCard: z.object({
    whyItMatters: z.string().trim().min(1).max(2000),
    // foundational | current_consensus | historical | methodological |
    // regulatory | practice_changing | controversial | misconception_correcting
    sourceStatus: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
    estimatedReadingMinutes: z.number().int().positive().max(600),
  }),
  prerequisites: z
    .array(
      z.object({
        concept: z.string().trim().min(1).max(80),
        level: z.enum(PREREQUISITE_LEVELS),
        why: z.string().trim().min(1).max(1000),
      }),
    )
    .max(40),
  preReadingPrompts: z.array(z.string().trim().min(1).max(600)).min(3).max(8),
  objectives: z.array(z.string().trim().min(1).max(600)).min(1).max(20),
  questions: z.array(learningQuestionSchema).min(10).max(80),
});

export type LearningUnitContent = z.infer<typeof learningUnitContentSchema>;

export const learningUnitMetaSchema = z.object({
  title: z.string().trim().min(1).max(500),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, and hyphens'),
  difficulty: z.enum(LEARNING_DIFFICULTIES),
  domains: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  editSummary: z.string().trim().max(2000).optional(),
});
```

- [ ] **Step 4: Wire `learning_unit` into `createPendingEditSchema`**

Add the literal to the `editType` enum (line 427):

```typescript
    editType: z.enum([
      'parameter',
      'wiki_page',
      'wiki_new',
      'wiki_fact',
      'wiki_section',
      'learning_unit',
    ]),
```

Then add a branch at the **top** of the `superRefine` callback (before the `wiki_section` check), so it returns early like the other content types:

```typescript
    if (value.editType === 'learning_unit') {
      const content = learningUnitContentSchema.safeParse(value.proposedValue);
      if (!content.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'learning_unit: invalid proposedValue (' +
            content.error.issues.map((i) => i.message).join('; ') +
            ')',
          path: ['proposedValue'],
        });
      }
      const meta = learningUnitMetaSchema.safeParse(value.proposedMeta);
      if (!meta.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'learning_unit: invalid proposedMeta (' +
            meta.error.issues.map((i) => i.message).join('; ') +
            ')',
          path: ['proposedMeta'],
        });
      }
      // Exactly one anchor citation (the reviewed source) is required.
      const refs =
        value.referenceIds ?? (value.referenceId ? [value.referenceId] : []);
      if (refs.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'learning_unit requires exactly one anchor citation (referenceId or single-element referenceIds)',
          path: ['referenceIds'],
        });
      }
      return;
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -- tests/lib/learningUnitSchema.test.ts`
Expected: PASS (all content + editType cases green).

- [ ] **Step 6: Commit**

```bash
git add api/_lib/schemas.ts tests/lib/learningUnitSchema.test.ts
git commit -m "feat(learn): learning_unit content schema + pending-edit validation"
```

---

### Task 4: Apply approved learning units (write + revision + approval + conflict)

**Files:**
- Modify: `api/_lib/pending-edits-helpers.ts` (add `applyApprovedLearningUnit`; wire into `applyApprovedEditEffects` ~line 741; add conflict marking near the other `markConflicting*` branches ~line 303)
- Test: `tests/api/pending-edits-learning-unit.test.ts`

**Interfaces:**
- Consumes: `learningUnits`, `learningUnitRevisions` (Task 1); `recordApproval`, `recordImplicitAgentApproval`, `fireAgentHookForActorAsync` (existing, used by the `wiki_page` branch); `learningUnitMetaSchema` (Task 3).
- Produces: `applyApprovedLearningUnit(db, edit, reviewerId)` — when `edit.targetId` is null it inserts a new `learning_units` row (`status='published'`); when set it updates that unit. Either way it inserts a `learning_unit_revisions` row linked to `edit.id`, calls `recordApproval`/`recordImplicitAgentApproval` on `targetType:'learning_unit_revision'`, and fires the `learning_unit_approved` hook.

- [ ] **Step 1: Write the failing test**

Create `tests/api/pending-edits-learning-unit.test.ts`. This is a focused unit test of the apply branch with an in-memory fake `db`; mirror the level of mocking used by existing `pending-edits-helpers` tests (inspect a sibling test for the exact `getDb` fake shape if the calls below need adjusting).

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, recordApprovalMock, recordImplicitMock, fireHookMock } =
  vi.hoisted(() => ({
    getDbMock: vi.fn(),
    recordApprovalMock: vi.fn(),
    recordImplicitMock: vi.fn(),
    fireHookMock: vi.fn(),
  }));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/approvals.js', () => ({
  recordApproval: recordApprovalMock,
}));
vi.mock('../../api/_lib/agent-verifications.js', () => ({
  recordImplicitAgentApproval: recordImplicitMock,
}));
vi.mock('../../api/_lib/agentHooks.js', () => ({
  fireAgentHookForActorAsync: fireHookMock,
}));

import { applyApprovedLearningUnit } from '../../api/_lib/pending-edits-helpers.ts';

// Minimal chainable db fake: insert(...).values(...).returning() -> [{ id }];
// update(...).set(...).where(...) resolves; select for slug-existence -> [].
function makeDb(insertedIds: number[]) {
  const ids = [...insertedIds];
  return {
    insert: () => ({
      values: () => ({
        returning: () => [{ id: ids.shift() ?? 1 }],
      }),
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  };
}

describe('applyApprovedLearningUnit', () => {
  beforeEach(() => {
    getDbMock.mockReset();
    recordApprovalMock.mockReset();
    recordImplicitMock.mockReset();
    fireHookMock.mockReset();
  });

  it('inserts a new unit + revision and stamps approval when targetId is null', async () => {
    const db = makeDb([100, 200]); // unit id 100, revision id 200
    const edit = {
      id: 9,
      editType: 'learning_unit',
      targetId: null,
      proposedValue: { questions: [] },
      proposedMeta: {
        title: 'Tittel',
        slug: 'tittel',
        difficulty: 'foundational',
        domains: ['pharmacokinetics'],
        editSummary: 'først',
      },
      referenceIds: [12],
      submittedBy: 5,
    };
    await applyApprovedLearningUnit(db as never, edit as never, 3);

    expect(recordApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: 'learning_unit_revision',
        targetId: 200,
        approvedBy: 3,
      }),
    );
    expect(recordImplicitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 5,
        targetType: 'learning_unit_revision',
        targetId: 200,
      }),
    );
    expect(fireHookMock).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ kind: 'learning_unit_approved', pendingEditId: 9 }),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/api/pending-edits-learning-unit.test.ts`
Expected: FAIL — `applyApprovedLearningUnit` is not exported.

- [ ] **Step 3: Implement `applyApprovedLearningUnit`**

Add to `api/_lib/pending-edits-helpers.ts` (import `learningUnits`, `learningUnitRevisions` from the schema, and `learningUnitMetaSchema` from `./schemas`). Model it on the `wiki_page` branch (lines 653–711):

```typescript
export async function applyApprovedLearningUnit(
  db: ReturnType<typeof getDb>,
  edit: PendingEditRow,
  reviewerId: number,
): Promise<void> {
  const meta = learningUnitMetaSchema.parse(edit.proposedMeta ?? {});
  const content = edit.proposedValue;

  let unitId = edit.targetId ?? null;
  if (unitId == null) {
    if (!edit.referenceIds || edit.referenceIds.length !== 1) {
      throw new Error('learning_unit requires exactly one anchor citation');
    }
    const [unit] = await db
      .insert(learningUnits)
      .values({
        citationId: edit.referenceIds[0],
        slug: meta.slug,
        title: meta.title,
        content: content as never,
        difficulty: meta.difficulty,
        domains: meta.domains as never,
        status: 'published',
        createdBy: edit.submittedBy,
        updatedBy: edit.submittedBy,
      })
      .returning({ id: learningUnits.id });
    unitId = unit.id;
  } else {
    await db
      .update(learningUnits)
      .set({
        title: meta.title,
        slug: meta.slug,
        content: content as never,
        difficulty: meta.difficulty,
        domains: meta.domains as never,
        updatedBy: edit.submittedBy,
        updatedAt: new Date(),
      })
      .where(eq(learningUnits.id, unitId));
  }

  const [unitRev] = await db
    .insert(learningUnitRevisions)
    .values({
      unitId,
      content: content as never,
      editSummary: meta.editSummary ?? null,
      pendingEditId: edit.id,
      createdBy: edit.submittedBy,
    })
    .returning({ id: learningUnitRevisions.id });

  if (unitRev) {
    await recordApproval({
      targetType: 'learning_unit_revision',
      targetId: unitRev.id,
      approvedBy: reviewerId,
    });
    await recordImplicitAgentApproval({
      userId: edit.submittedBy,
      targetType: 'learning_unit_revision',
      targetId: unitRev.id,
    });
    fireAgentHookForActorAsync(edit.submittedBy, {
      kind: 'learning_unit_approved',
      pendingEditId: edit.id,
      revisionId: unitRev.id,
      unitId,
    });
  }
}
```

> Note on the hook `kind`: if `fireAgentHookForActorAsync`'s event argument is a discriminated union typed in `api/_lib/agentHooks.ts`, add `'learning_unit_approved'` (with `pendingEditId`, `revisionId`, `unitId`) to that union there. If the parameter is a loose `Record`, no change is needed. Check before relying on typecheck.

- [ ] **Step 4: Wire the dispatch branch**

In `applyApprovedEditEffects`, add a branch alongside the others (after `paper_review` / before the final `else`/`wiki_new`, ~line 741):

```typescript
  } else if (edit.editType === 'learning_unit') {
    await applyApprovedLearningUnit(db, edit, reviewerId);
```

- [ ] **Step 5: Add conflict marking**

In `markConflictingPendingEdits` (the function holding the `editType === 'wiki_page'` block ~line 303), add an analogous block so approving one unit edit staling other pending edits on the same unit:

```typescript
  if (edit.editType === 'learning_unit' && edit.targetId) {
    await markStaleByTarget(db, {
      editType: 'learning_unit',
      targetId: edit.targetId,
      approvedEditId: edit.id,
    });
  }
```

> Use whatever helper the `wiki_page` branch uses to mark rows stale (e.g. the local `markStaleByTarget` / inline update that writes `proposedMeta.conflict`). Read the `wiki_page` block first and mirror its exact mechanism rather than inventing a new one. New-unit edits (`targetId == null`) have no prior target and need no conflict handling.

- [ ] **Step 6: Run test + typecheck to verify they pass**

Run: `npm run test -- tests/api/pending-edits-learning-unit.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/_lib/pending-edits-helpers.ts tests/api/pending-edits-learning-unit.test.ts
git commit -m "feat(learn): apply approved learning_unit edits with revision + consensus"
```

---

### Task 5: Submit path — allow learning_unit + enforce the reference gate

**Files:**
- Modify: `api/pending-edits.ts` (POST handler ~lines 844–894)
- Test: `tests/api/pending-edits-learning-unit-route.test.ts`

**Interfaces:**
- Consumes: `createPendingEditSchema` (Task 3), `assertReferencesJudged` (existing, `api/_lib/pending-edits-helpers.ts:132`), `canContribute` (existing).
- Produces: `POST /api/pending-edits` accepts `editType:'learning_unit'` from any contributor+ role (NOT admin-gated — agent authoring is the point), runs `assertReferencesJudged([citationId])` so an unreviewed source is rejected, and persists the row with `referenceIds` set to the anchor citation. A unit whose source lacks a read-in-full review returns 400 with code `learning_unit_unreviewed_source`.

- [ ] **Step 1: Write the failing test**

Create `tests/api/pending-edits-learning-unit-route.test.ts` following the `paper-reviews-route.test.ts` harness (the `createResponse`/`createJsonRequest` helpers; mock `db`, `auth`, and `assertReferencesJudged`). Assert two behaviours: (a) a unit anchored to a reviewed citation is inserted (200/201); (b) a unit whose `assertReferencesJudged` throws the "unreviewed" error returns 400.

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const { getDbMock, authMock, assertRefsMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  authMock: vi.fn(),
  assertRefsMock: vi.fn(),
}));
vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: authMock }));
vi.mock('../../api/_lib/pending-edits-helpers.js', async (orig) => ({
  ...(await orig()),
  assertReferencesJudged: assertRefsMock,
}));

import handler from '../../api/pending-edits.ts';

// (reuse createResponse + createJsonRequest from paper-reviews-route.test.ts)

function unitBody(refId: number) {
  return {
    editType: 'learning_unit',
    referenceIds: [refId],
    proposedMeta: { title: 'T', slug: 't', difficulty: 'foundational', domains: [] },
    proposedValue: /* a valid learningUnitContent — import the helper from the schema test or inline it */ {},
  };
}

describe('POST /api/pending-edits learning_unit', () => {
  beforeEach(() => {
    getDbMock.mockReset();
    authMock.mockReset();
    assertRefsMock.mockReset();
    authMock.mockResolvedValue({ id: 5, role: 'contributor' });
    getDbMock.mockReturnValue({
      insert: () => ({ values: () => ({ returning: () => [{ id: 77 }] }) }),
    });
  });

  it('rejects a unit whose source has no read-in-full review', async () => {
    assertRefsMock.mockRejectedValue(
      Object.assign(new Error('unreviewed'), { code: 'reference_unreviewed' }),
    );
    // expect the handler to translate this into a 400 with a learning_unit code
  });

  it('accepts a unit anchored to a reviewed citation', async () => {
    assertRefsMock.mockResolvedValue(undefined);
    // expect 200/201 + insert called
  });
});
```

> Fill the two `expect` bodies using the same response-introspection pattern as `paper-reviews-route.test.ts` (assert on `state.statusCode` and parsed `state.body`). Inline a valid `proposedValue` by importing `validUnitContent` — export it from a shared test helper or duplicate the minimal object.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/api/pending-edits-learning-unit-route.test.ts`
Expected: FAIL — handler does not yet special-case `learning_unit` and the reference gate is not called for it.

- [ ] **Step 3: Add the gate to the POST handler**

In `api/pending-edits.ts`, after the existing `canContribute` allowlist (line 871) and the admin-only whole-page block (lines 876–889), add the learning-unit reference gate. The unit is intentionally NOT added to the admin-only block. Insert before the row is built/inserted:

```typescript
  // Learning units must anchor a source that already carries a read-in-full
  // review (same gate facts/parameters use). This avoids re-reviewing the
  // source: the unit consumes the existing paper_review instead.
  if (parsed.data.editType === 'learning_unit') {
    const anchorIds =
      parsed.data.referenceIds ??
      (parsed.data.referenceId ? [parsed.data.referenceId] : []);
    try {
      await assertReferencesJudged(anchorIds);
    } catch (err) {
      error(
        res,
        400,
        'Learning units must anchor a source with a read-in-full review.',
        'learning_unit_unreviewed_source',
      );
      return;
    }
  }
```

> Confirm `assertReferencesJudged` is imported in `api/pending-edits.ts` (it already imports from `./_lib/pending-edits-helpers`). Confirm the existing insert path persists `referenceIds` (it computes `referenceIds`/`primaryReferenceId` at line 891–894 and writes them for other editTypes); `learning_unit` flows through the same insert, so no extra persistence code is needed — verify the row insert includes `referenceIds`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/api/pending-edits-learning-unit-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/pending-edits.ts tests/api/pending-edits-learning-unit-route.test.ts
git commit -m "feat(learn): gate learning_unit submissions on a reviewed source"
```

---

### Task 6: Read API — GET /api/learning-units

**Files:**
- Create: `api/learning-units.ts`
- Test: `tests/api/learning-units-route.test.ts`

**Interfaces:**
- Consumes: `getDb`, `learningUnits`, `citations` (for the anchor link-out), the existing JSON `error`/response helpers in `api/_lib/response.ts`.
- Produces: `GET /api/learning-units?id=<n>` → one published unit `{ id, slug, title, difficulty, domains, content, source: { citationId, doi?, pmid?, url? } }`; `GET /api/learning-units?citationId=<n>` → units anchored to that source; `GET /api/learning-units` → a lightweight list (`id, slug, title, difficulty, domains` — no `content`). Read-only; no auth required (published learning content). The `source` block carries only the link-out identifiers, never PDF/full-text (Global Constraint).

- [ ] **Step 1: Write the failing test**

Create `tests/api/learning-units-route.test.ts` (mirror `paper-reviews-route.test.ts` harness):

```typescript
// ... vi.hoisted getDbMock; vi.mock db; import handler from '../../api/learning-units.ts'
describe('GET /api/learning-units', () => {
  it('returns a single published unit with a link-out source block', async () => {
    // getDb returns a unit row joined to its citation; assert 200 +
    // body.source has { citationId, doi|pmid|url } and NO pdf/full-text field
  });

  it('404s an unknown id', async () => {
    // getDb returns []; assert 404
  });

  it('lists units without their content payload', async () => {
    // assert list items omit `content`
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- tests/api/learning-units-route.test.ts`
Expected: FAIL — `api/learning-units.ts` does not exist.

- [ ] **Step 3: Implement the handler**

Create `api/learning-units.ts` following the raw `node:http` pattern used by `api/paper-reviews.ts` (same imports for `getDb`, `json`, `error`). Sketch:

```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, eq } from 'drizzle-orm';
import { getDb } from './_lib/db.js';
import { json, error } from './_lib/response.js';
import { learningUnits, citations } from '../db/schema.js';

function sourceLinkOut(c: { id: number; doi: string | null; pmid: string | null; url: string | null }) {
  // Link-out identifiers only — never PDF/full text (see plan Global Constraints).
  return { citationId: c.id, doi: c.doi ?? undefined, pmid: c.pmid ?? undefined, url: c.url ?? undefined };
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'GET') {
    error(res, 405, 'Method not allowed');
    return;
  }
  const url = new URL(req.url ?? '', `http://${req.headers.host}`);
  const db = getDb();
  const idParam = url.searchParams.get('id');
  const citationParam = url.searchParams.get('citationId');

  if (idParam) {
    const id = Number(idParam);
    const [row] = await db
      .select()
      .from(learningUnits)
      .where(and(eq(learningUnits.id, id), eq(learningUnits.status, 'published')))
      .limit(1);
    if (!row) { error(res, 404, 'Learning unit not found'); return; }
    const [cite] = await db
      .select({ id: citations.id, doi: citations.doi, pmid: citations.pmid, url: citations.url })
      .from(citations)
      .where(eq(citations.id, row.citationId))
      .limit(1);
    json(res, 200, {
      id: row.id, slug: row.slug, title: row.title,
      difficulty: row.difficulty, domains: row.domains, content: row.content,
      source: cite ? sourceLinkOut(cite) : null,
    });
    return;
  }

  const base = db
    .select({
      id: learningUnits.id, slug: learningUnits.slug, title: learningUnits.title,
      difficulty: learningUnits.difficulty, domains: learningUnits.domains,
    })
    .from(learningUnits)
    .where(
      citationParam
        ? and(eq(learningUnits.status, 'published'), eq(learningUnits.citationId, Number(citationParam)))
        : eq(learningUnits.status, 'published'),
    );
  const rows = await base;
  json(res, 200, { units: rows });
}
```

> Verify the actual column names on `citations` for the link-out (e.g. `doi`, `pmid`, `url`). Grep `db/schema.ts` for `export const citations` and use whatever identifier columns exist; drop any that don't. Confirm the `json`/`error` helper names in `api/_lib/response.ts` and match them.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- tests/api/learning-units-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/learning-units.ts tests/api/learning-units-route.test.ts
git commit -m "feat(learn): read API for published learning units (link-out source)"
```

---

### Task 7: Unit-builder agent prompt + docs

**Files:**
- Create: `agents/learning-unit-builder.md`
- Modify: `AGENTS.md` ("Where to look" table, ~line 53)

**Interfaces:**
- Consumes: nothing in code. The prompt instructs an agent to call existing endpoints: read a citation + its `paper_review` (the existing review), then `POST /api/pending-edits` with `editType:'learning_unit'`.
- Produces: a documented, repeatable single-run cycle that emits one learning unit per run, consuming the existing review rather than re-appraising.

- [ ] **Step 1: Write the agent prompt**

Create `agents/learning-unit-builder.md`. It adapts spec §12's 13 stages but **collapses Stages 1–4 into "consume the existing review"**:

```markdown
# Kinetix Learn Unit Builder Agent

You build ONE source-anchored learning unit per run for Kinetix Learn.

## Preconditions (do not re-do work the review pipeline already did)
A learning unit may only be built on a citation that ALREADY has a read-in-full
`paper_review`. Do not re-read or re-appraise the source from scratch:
1. Fetch the citation and its current paper review (the appraisal + structured
   extraction the review agent produced).
2. If no read-in-full review exists, STOP and (optionally) queue a paper review
   first via the existing review path. Building a unit on an unreviewed source
   is rejected by `POST /api/pending-edits` (`learning_unit_unreviewed_source`).

## Build the unit (spec §12 stages 5–13)
Using the existing review's extraction as your source of truth:
- **Prerequisites** — map to the 25 Core Concepts; label essential / helpful /
  advanced_adjacent / optional_context with a one-line "why".
- **Kinetix cross-links** — list drugs/targets/enzymes/concepts that should link
  to existing monographs/wiki pages. Do not force weak links.
- **Pre-reading guide** — 3–8 source-SPECIFIC prompts (not generic objectives).
- **Objectives** — concise, subordinate to the source.
- **Assessment** — ≥10 questions, mixed single_best / select_all and
  factual / reasoned. EVERY option (right and wrong) gets an explanation that
  names the misconception. single_best = exactly one correct option.
- **Self-audit (Stage 13)** — reject your own draft for unsupported claims,
  weak distractors, multiple correct answers, or missing explanations.

## Language
Write all unit prose in NORWEGIAN (the unit content is treated as authored
content, like a wiki page — not dual-locale chrome).

## Output
POST to `/api/pending-edits`:
- editType: "learning_unit"
- referenceIds: [<the anchor citationId>]
- proposedMeta: { title, slug, difficulty, domains, editSummary }
- proposedValue: { sourceCard, prerequisites, preReadingPrompts, objectives, questions }

The unit enters the moderator queue and is auto-applied only on peer consensus
(≥2 independent approves, no disputes) — same mechanism as parameter/monograph
edits. Clinical-case-bearing units that you flag for expert review must NOT be
written to auto-apply; leave them for a human moderator.

## Verification duty
On runs where no new unit is warranted, instead pull
`GET /api/agent-verifications-queue`, judge other agents' pending learning units
independently, and POST a verdict (approve / dispute / abstain) with rationale
and evidence — see `agents/peer-verification-protocol.md`.
```

- [ ] **Step 2: Add the AGENTS.md "Where to look" row**

In the table under "## Where to look", add:

```markdown
| Kinetix Learn (learning units) | `db/schema.ts` (`learning_units`), `api/learning-units.ts`, `api/_lib/pending-edits-helpers.ts` (`applyApprovedLearningUnit`), `agents/learning-unit-builder.md` | Source-anchored learning units; reuse the pending-edit/peer-consensus path. Built on a citation that already has a read-in-full `paper_review` (Phase A: authoring only) |
```

- [ ] **Step 3: Verify the full suite + typecheck pass**

Run: `npm run test && npm run typecheck`
Expected: PASS (all new + existing tests green; no type errors).

- [ ] **Step 4: Commit**

```bash
git add agents/learning-unit-builder.md AGENTS.md
git commit -m "docs(learn): unit-builder agent prompt + AGENTS.md pointer"
```

---

## Self-Review

**Spec coverage (Phase A scope):**
- §5.3 Source Library backing data → Tasks 1 & 6 (storage + read API). The *page* is Phase B.
- §7.1–7.6 unit anatomy (source card, prerequisites, pre-reading, objectives, assessment, feedback) → Task 3 content schema enforces all of it, including per-option explanations and ≥10 questions.
- §12 single full-cycle agent → Task 7 prompt; Stages 1–4 consumed from the existing review (the "avoid double work" goal); Stage 13 self-audit partly enforced in code (Task 3 invariants).
- §6 dual assessment / §14 factual+reasoned → `category` enum in Task 3.
- Verification/consensus → Tasks 2 & 4 reuse the existing engine unchanged.
- Reference integrity ("must not invent facts", §12; metadata verified at ingestion, §9) → reference gate, Task 5.
- **Explicitly deferred:** §5.1 My Path, §5.2 Topic Map, §5.4 Cases & Review, §8 adaptive model, §4 header-menu entry, §15 update/maintenance model. These are Phase B/C — called out in the Scope boundary, not silently dropped.

**Placeholder scan:** The `tests/api/pending-edits-learning-unit-route.test.ts` and `learning-units-route.test.ts` bodies intentionally defer two `expect` blocks to the documented `paper-reviews-route.test.ts` harness rather than guessing its private response helpers — flagged inline with exact instructions, not left as bare TODOs. All code steps carry real code.

**Type consistency:** `learning_unit` (editType) vs `learning_unit_revision` (verification/approval target type) are deliberately distinct and used consistently — the editType names the pending-edit kind; the revision target is what peers verify. `applyApprovedLearningUnit` signature `(db, edit, reviewerId)` matches its call site in Task 4 Step 4. `learningUnitMetaSchema` fields (`title`, `slug`, `difficulty`, `domains`, `editSummary`) match the apply branch's `meta.*` reads. `LEARNING_DIFFICULTIES` values match the `difficulty` column usage.

**Open items to confirm during execution (each flagged at its task):** the exact stale-marking helper in `markConflictingPendingEdits` (Task 4 Step 5); whether `fireAgentHookForActorAsync`'s event arg is a typed union needing a new `kind` (Task 4 Step 3); `citations` link-out column names (Task 6 Step 3); `response.ts` helper names (Task 6). None block the design; all are local mirror-the-neighbor checks.
