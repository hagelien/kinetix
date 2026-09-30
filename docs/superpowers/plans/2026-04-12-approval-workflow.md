# Approval Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** All content changes require editor/admin approval before going live. Viewers can suggest, editors approve (not their own).

**Architecture:** A new `pending_edits` table stores all proposed changes. Existing endpoints (`drug-parameter`, `wiki/pages`) are modified to create pending edits instead of direct updates for non-admin users. A new `/api/pending-edits` endpoint handles CRUD and approval. A new `/review` page provides the review queue UI. Header shows pending count badge for editors/admins.

**Tech Stack:** Drizzle ORM (Postgres), Vite + React + React Router, Zustand, Tailwind CSS, Zod validation.

**Spec:** `docs/superpowers/specs/2026-04-12-approval-workflow-design.md`

---

## File Structure

### New files

| File                                        | Responsibility                                                    |
| ------------------------------------------- | ----------------------------------------------------------------- |
| `api/pending-edits.ts`                      | CRUD + approve/reject endpoint for pending edits                  |
| `api/_lib/pending-edits-helpers.ts`         | Shared logic: apply approved edit to live content, conflict check |
| `src/pages/ReviewPage.tsx`                  | Review queue page at `/review`                                    |
| `src/components/review/PendingEditCard.tsx` | Single pending edit card with approve/reject actions              |
| `src/components/review/ParameterDiff.tsx`   | Side-by-side parameter value comparison                           |
| `src/components/review/WikiDiff.tsx`        | Wiki content diff (added/removed text)                            |
| `src/components/review/RejectDialog.tsx`    | Modal for entering rejection comment                              |
| `src/components/PendingBadge.tsx`           | Header badge showing pending edit count                           |
| `src/lib/pendingEditsApi.ts`                | Client-side API functions for pending edits                       |

### Modified files

| File                                           | Change                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `db/schema.ts`                                 | Add `pendingEdits` table, add `pendingEditId` to `drugParameterRevisions` and `wikiRevisions` |
| `api/_lib/schemas.ts`                          | Add zod schemas for pending edits                                                             |
| `api/drug-parameter.ts`                        | Route non-admin edits to pending_edits instead of direct update                               |
| `api/wiki/pages.ts`                            | Route non-admin creates/edits to pending_edits                                                |
| `src/router.tsx`                               | Add `/review` route                                                                           |
| `src/components/Header.tsx`                    | Add review link with pending count badge                                                      |
| `src/components/wiki/ParameterEditForm.tsx`    | Change save button text based on role, show pending indicator                                 |
| `src/components/wiki/WikiEditor.tsx`           | Change save button text based on role                                                         |
| `src/components/wiki/DrugMonographSidebar.tsx` | Show "pending" indicator per parameter                                                        |
| `src/pages/wiki/WikiPage.tsx`                  | Show "your pending edit" link for submitter                                                   |
| `src/stores/authStore.ts`                      | Expose role for UI branching                                                                  |

---

### Task 1: Database schema — `pending_edits` table + migration

**Files:**

- Modify: `db/schema.ts`

- [ ] **Step 1: Add `pendingEdits` table to schema**

In `db/schema.ts`, add before the type exports section:

```typescript
// ─── Pending edits (approval workflow) ──────────────────────────────────────

export const pendingEdits = pgTable(
  'pending_edits',
  {
    id: serial('id').primaryKey(),
    editType: varchar('edit_type', { length: 20 }).notNull(), // 'parameter' | 'wiki_page' | 'wiki_new'
    targetId: integer('target_id'), // drug ID or page ID, null for wiki_new
    parameter: varchar('parameter', { length: 60 }), // only for edit_type = 'parameter'
    proposedValue: jsonb('proposed_value').notNull(),
    proposedMeta: jsonb('proposed_meta'),
    referenceId: integer('reference_id').references(() => citations.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    rejectionComment: text('rejection_comment'),
    submittedBy: integer('submitted_by').notNull().references(() => users.id),
    reviewedBy: integer('reviewed_by').references(() => users.id),
    submittedAt: timestamp('submitted_at').defaultNow().notNull(),
    reviewedAt: timestamp('reviewed_at'),
  },
  (t) => [
    index('pending_edits_status_idx').on(t.status),
    index('pending_edits_target_idx').on(t.editType, t.targetId),
    index('pending_edits_submitted_by_idx').on(t.submittedBy),
  ],
);
```

- [ ] **Step 2: Add `pendingEditId` to `drugParameterRevisions`**

Add after `referenceId` in the `drugParameterRevisions` table:

```typescript
    pendingEditId: integer('pending_edit_id').references(() => pendingEdits.id, { onDelete: 'set null' }),
```

- [ ] **Step 3: Add `pendingEditId` to `wikiRevisions`**

Add after `editSummary` in the `wikiRevisions` table:

```typescript
    pendingEditId: integer('pending_edit_id').references(() => pendingEdits.id, { onDelete: 'set null' }),
```

- [ ] **Step 4: Add type exports**

```typescript
export type PendingEdit = typeof pendingEdits.$inferSelect;
export type NewPendingEdit = typeof pendingEdits.$inferInsert;
```

- [ ] **Step 5: Write migration SQL**

Create `drizzle/0005_pending_edits.sql`:

```sql
CREATE TABLE "pending_edits" (
  "id" SERIAL PRIMARY KEY NOT NULL,
  "edit_type" VARCHAR(20) NOT NULL,
  "target_id" INTEGER,
  "parameter" VARCHAR(60),
  "proposed_value" JSONB NOT NULL,
  "proposed_meta" JSONB,
  "reference_id" INTEGER REFERENCES "citations"("id") ON DELETE SET NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "rejection_comment" TEXT,
  "submitted_by" INTEGER NOT NULL REFERENCES "users"("id"),
  "reviewed_by" INTEGER REFERENCES "users"("id"),
  "submitted_at" TIMESTAMP DEFAULT NOW() NOT NULL,
  "reviewed_at" TIMESTAMP
);

CREATE INDEX "pending_edits_status_idx" ON "pending_edits" USING btree ("status");
CREATE INDEX "pending_edits_target_idx" ON "pending_edits" USING btree ("edit_type", "target_id");
CREATE INDEX "pending_edits_submitted_by_idx" ON "pending_edits" USING btree ("submitted_by");

ALTER TABLE "drug_parameter_revisions" ADD COLUMN "pending_edit_id" INTEGER REFERENCES "pending_edits"("id") ON DELETE SET NULL;
ALTER TABLE "wiki_revisions" ADD COLUMN "pending_edit_id" INTEGER REFERENCES "pending_edits"("id") ON DELETE SET NULL;
```

- [ ] **Step 6: Update drizzle journal**

Add entry for `0005_pending_edits` in `drizzle/meta/_journal.json`.

- [ ] **Step 7: Type check and commit**

Run: `npx tsc --noEmit`

```bash
git add db/schema.ts drizzle/
git commit -m "feat: add pending_edits table for approval workflow"
```

---

### Task 2: Zod schemas + client API

**Files:**

- Modify: `api/_lib/schemas.ts`

- Create: `src/lib/pendingEditsApi.ts`

- [ ] **Step 1: Add zod schemas**

In `api/_lib/schemas.ts`, add:

```typescript
// ─── Pending edits (approval workflow) ────────────────────────────────────

export const createPendingEditSchema = z.object({
  editType: z.enum(['parameter', 'wiki_page', 'wiki_new']),
  targetId: z.number().int().positive().nullable().optional(),
  parameter: z.string().max(60).optional(),
  proposedValue: z.any(),
  proposedMeta: z.any().optional(),
  referenceId: z.number().int().positive().optional(),
  status: z.enum(['draft', 'pending']).default('pending'),
});

export const reviewPendingEditSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  rejectionComment: z.string().min(1).max(2000).optional(),
});
```

- [ ] **Step 2: Create client API**

Create `src/lib/pendingEditsApi.ts`:

```typescript
export interface PendingEditRow {
  id: number;
  editType: 'parameter' | 'wiki_page' | 'wiki_new';
  targetId: number | null;
  parameter: string | null;
  proposedValue: unknown;
  proposedMeta: Record<string, unknown> | null;
  referenceId: number | null;
  status: 'draft' | 'pending' | 'approved' | 'rejected';
  rejectionComment: string | null;
  submittedBy: number;
  reviewedBy: number | null;
  submittedAt: string;
  reviewedAt: string | null;
  submitter?: { id: number; username: string };
  reviewer?: { id: number; username: string };
  // Joined data for display
  drugName?: string;
  pageTitle?: string;
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export async function fetchPendingEdits(params?: {
  status?: string;
  editType?: string;
  submittedBy?: number;
}): Promise<{ pendingEdits: PendingEditRow[] }> {
  const sp = new URLSearchParams();
  if (params?.status) sp.set('status', params.status);
  if (params?.editType) sp.set('editType', params.editType);
  if (params?.submittedBy) sp.set('submittedBy', String(params.submittedBy));
  return apiFetch(`/api/pending-edits?${sp}`);
}

export async function fetchPendingEditCount(): Promise<{ count: number }> {
  return apiFetch('/api/pending-edits?status=pending&countOnly=true');
}

export async function createPendingEdit(data: {
  editType: string;
  targetId?: number | null;
  parameter?: string;
  proposedValue: unknown;
  proposedMeta?: Record<string, unknown>;
  referenceId?: number;
  status?: string;
}): Promise<{ pendingEdit: PendingEditRow }> {
  return apiFetch('/api/pending-edits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function reviewPendingEdit(
  id: number,
  action: { status: 'approved' | 'rejected'; rejectionComment?: string },
): Promise<{ pendingEdit: PendingEditRow }> {
  return apiFetch(`/api/pending-edits?id=${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action),
  });
}

export async function cancelPendingEdit(id: number): Promise<void> {
  await apiFetch(`/api/pending-edits?id=${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'rejected' }),
  });
}
```

- [ ] **Step 3: Type check and commit**

```bash
git add api/_lib/schemas.ts src/lib/pendingEditsApi.ts
git commit -m "feat: add pending edit schemas and client API"
```

---

### Task 3: Pending edits API endpoint

**Files:**

- Create: `api/pending-edits.ts`

- Create: `api/_lib/pending-edits-helpers.ts`

- [ ] **Step 1: Create helper for applying approved edits**

Create `api/_lib/pending-edits-helpers.ts`:

```typescript
import { eq, sql } from 'drizzle-orm';
import { getDb } from './db.js';
import {
  drugs,
  drugParameterRevisions,
  drugInteractions,
  wikiPages,
  wikiRevisions,
  pendingEdits,
} from '../../db/schema.js';
import { extractPlaintext, renderHtml } from './tiptap-utils.js';
import { generateSlug } from './slug.js';
import {
  DRUG_PARAMETERS,
  isDrugParameterId,
} from '../../src/lib/drugParameters.js';

export async function applyApprovedEdit(
  editId: number,
  reviewerId: number,
): Promise<void> {
  const db = getDb();

  const [edit] = await db
    .select()
    .from(pendingEdits)
    .where(eq(pendingEdits.id, editId))
    .limit(1);

  if (!edit) throw new Error('Pending edit not found');

  if (edit.editType === 'parameter') {
    if (!edit.targetId || !edit.parameter) throw new Error('Missing target or parameter');
    if (!isDrugParameterId(edit.parameter)) throw new Error('Invalid parameter');

    const oldDrug = await db.select().from(drugs).where(eq(drugs.id, edit.targetId)).limit(1);
    if (!oldDrug[0]) throw new Error('Drug not found');

    const oldValue = (oldDrug[0] as Record<string, unknown>)[edit.parameter] ?? null;
    const newValue = edit.proposedValue;
    const meta = (edit.proposedMeta ?? {}) as Record<string, unknown>;

    await db
      .update(drugs)
      .set({
        [edit.parameter]: newValue,
        updatedAt: new Date(),
        popularityScore: sql`${drugs.popularityScore} + 1`,
      } as never)
      .where(eq(drugs.id, edit.targetId));

    await db.insert(drugParameterRevisions).values({
      drugId: edit.targetId,
      parameter: edit.parameter,
      oldValue: oldValue as never,
      newValue: newValue as never,
      editSummary: (meta.editSummary as string) ?? null,
      referenceId: edit.referenceId,
      pendingEditId: edit.id,
      createdBy: edit.submittedBy,
    });

    await db.insert(drugInteractions).values({
      drugId: edit.targetId,
      userId: edit.submittedBy,
      eventType: 'edit',
    });
  } else if (edit.editType === 'wiki_page') {
    if (!edit.targetId) throw new Error('Missing target page ID');
    const meta = (edit.proposedMeta ?? {}) as Record<string, unknown>;

    const contentHtml = renderHtml(edit.proposedValue);
    const contentPlaintext = extractPlaintext(edit.proposedValue);

    await db
      .update(wikiPages)
      .set({
        content: edit.proposedValue as never,
        contentHtml,
        contentPlaintext,
        title: (meta.title as string) ?? undefined,
        updatedBy: edit.submittedBy,
        updatedAt: new Date(),
      })
      .where(eq(wikiPages.id, edit.targetId));

    await db.insert(wikiRevisions).values({
      pageId: edit.targetId,
      content: edit.proposedValue as never,
      contentHtml,
      editSummary: (meta.editSummary as string) ?? null,
      pendingEditId: edit.id,
      createdBy: edit.submittedBy,
    });
  } else if (edit.editType === 'wiki_new') {
    const meta = (edit.proposedMeta ?? {}) as Record<string, unknown>;
    const title = (meta.title as string) ?? 'Untitled';
    const slug = generateSlug(title);

    const contentHtml = renderHtml(edit.proposedValue);
    const contentPlaintext = extractPlaintext(edit.proposedValue);

    const [page] = await db.insert(wikiPages).values({
      slug,
      title,
      content: edit.proposedValue as never,
      contentHtml,
      contentPlaintext,
      pageType: (meta.pageType as string) ?? 'topic',
      drugCid: (meta.drugCid as number) ?? undefined,
      status: 'published',
      createdBy: edit.submittedBy,
      updatedBy: edit.submittedBy,
    }).returning();

    if (page) {
      await db.insert(wikiRevisions).values({
        pageId: page.id,
        content: edit.proposedValue as never,
        contentHtml,
        editSummary: (meta.editSummary as string) ?? 'Initial creation',
        pendingEditId: edit.id,
        createdBy: edit.submittedBy,
      });
    }
  }

  // Mark edit as approved
  await db
    .update(pendingEdits)
    .set({
      status: 'approved',
      reviewedBy: reviewerId,
      reviewedAt: new Date(),
    })
    .where(eq(pendingEdits.id, editId));
}
```

- [ ] **Step 2: Create the API endpoint**

Create `api/pending-edits.ts`:

```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq, and, desc } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { parseAndValidate } from './_lib/validate.js';
import { createPendingEditSchema, reviewPendingEditSchema } from './_lib/schemas.js';
import { pendingEdits, users, drugs, wikiPages } from '../db/schema.js';
import { applyApprovedEdit } from './_lib/pending-edits-helpers.js';
import { sql } from 'drizzle-orm';

export default withErrorHandling(async function handler(req, res): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  switch (req.method) {
    case 'GET':
      return handleGet(req, res, url);
    case 'POST':
      return handleCreate(req, res);
    case 'PATCH':
      return handleReview(req, res, url);
    default:
      error(res, 405, 'Method not allowed');
  }
});

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }

  const db = getDb();
  const status = url.searchParams.get('status') ?? 'pending';
  const editType = url.searchParams.get('editType');
  const submittedBy = url.searchParams.get('submittedBy');
  const countOnly = url.searchParams.get('countOnly') === 'true';

  const conditions = [eq(pendingEdits.status, status)];
  if (editType) conditions.push(eq(pendingEdits.editType, editType));

  // Viewers can only see their own pending edits
  if (auth.role === 'viewer') {
    conditions.push(eq(pendingEdits.submittedBy, auth.userId));
  } else if (submittedBy) {
    conditions.push(eq(pendingEdits.submittedBy, Number(submittedBy)));
  }

  if (countOnly) {
    const [result] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(pendingEdits)
      .where(and(...conditions));
    json(res, 200, { count: result?.count ?? 0 });
    return;
  }

  const rows = await db
    .select({
      id: pendingEdits.id,
      editType: pendingEdits.editType,
      targetId: pendingEdits.targetId,
      parameter: pendingEdits.parameter,
      proposedValue: pendingEdits.proposedValue,
      proposedMeta: pendingEdits.proposedMeta,
      referenceId: pendingEdits.referenceId,
      status: pendingEdits.status,
      rejectionComment: pendingEdits.rejectionComment,
      submittedBy: pendingEdits.submittedBy,
      reviewedBy: pendingEdits.reviewedBy,
      submittedAt: pendingEdits.submittedAt,
      reviewedAt: pendingEdits.reviewedAt,
    })
    .from(pendingEdits)
    .where(and(...conditions))
    .orderBy(desc(pendingEdits.submittedAt))
    .limit(100);

  // Enrich with user names and target names
  const enriched = await Promise.all(
    rows.map(async (row) => {
      const [submitter] = await db
        .select({ id: users.id, username: users.username })
        .from(users)
        .where(eq(users.id, row.submittedBy))
        .limit(1);

      let drugName: string | undefined;
      let pageTitle: string | undefined;

      if (row.editType === 'parameter' && row.targetId) {
        const [drug] = await db.select({ name: drugs.name }).from(drugs).where(eq(drugs.id, row.targetId)).limit(1);
        drugName = drug?.name;
      } else if (row.editType === 'wiki_page' && row.targetId) {
        const [page] = await db.select({ title: wikiPages.title }).from(wikiPages).where(eq(wikiPages.id, row.targetId)).limit(1);
        pageTitle = page?.title;
      } else if (row.editType === 'wiki_new') {
        pageTitle = (row.proposedMeta as Record<string, unknown>)?.title as string;
      }

      return {
        ...row,
        submitter: submitter ?? null,
        drugName,
        pageTitle,
      };
    }),
  );

  json(res, 200, { pendingEdits: enriched });
}

async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }

  const parsed = await parseAndValidate(req, createPendingEditSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const db = getDb();
  const [row] = await db
    .insert(pendingEdits)
    .values({
      editType: parsed.data.editType,
      targetId: parsed.data.targetId ?? null,
      parameter: parsed.data.parameter ?? null,
      proposedValue: parsed.data.proposedValue as never,
      proposedMeta: (parsed.data.proposedMeta ?? null) as never,
      referenceId: parsed.data.referenceId ?? null,
      status: parsed.data.status ?? 'pending',
      submittedBy: auth.userId,
    })
    .returning();

  json(res, 201, { pendingEdit: row });
}

async function handleReview(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }

  const id = Number(url.searchParams.get('id'));
  if (!id) {
    error(res, 400, 'Missing id parameter');
    return;
  }

  const parsed = await parseAndValidate(req, reviewPendingEditSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const db = getDb();
  const [edit] = await db
    .select()
    .from(pendingEdits)
    .where(eq(pendingEdits.id, id))
    .limit(1);

  if (!edit) {
    error(res, 404, 'Pending edit not found');
    return;
  }

  if (edit.status !== 'pending' && edit.status !== 'draft') {
    error(res, 400, 'Edit has already been reviewed');
    return;
  }

  // Allow submitter to cancel their own edit
  if (parsed.data.status === 'rejected' && edit.submittedBy === auth.userId) {
    await db
      .update(pendingEdits)
      .set({ status: 'rejected', reviewedBy: auth.userId, reviewedAt: new Date() })
      .where(eq(pendingEdits.id, id));
    json(res, 200, { pendingEdit: { ...edit, status: 'rejected' } });
    return;
  }

  // Only editors and admins can approve/reject others' edits
  if (auth.role !== 'editor' && auth.role !== 'admin') {
    error(res, 403, 'Editor or admin role required');
    return;
  }

  // Editors cannot approve their own edits
  if (auth.role === 'editor' && edit.submittedBy === auth.userId) {
    error(res, 403, 'Editors cannot approve their own edits');
    return;
  }

  if (parsed.data.status === 'rejected') {
    if (!parsed.data.rejectionComment) {
      error(res, 400, 'Rejection comment is required');
      return;
    }
    await db
      .update(pendingEdits)
      .set({
        status: 'rejected',
        rejectionComment: parsed.data.rejectionComment,
        reviewedBy: auth.userId,
        reviewedAt: new Date(),
      })
      .where(eq(pendingEdits.id, id));
    json(res, 200, { pendingEdit: { ...edit, status: 'rejected' } });
    return;
  }

  // Approve — apply the edit to live content
  await applyApprovedEdit(id, auth.userId);

  const [updated] = await db
    .select()
    .from(pendingEdits)
    .where(eq(pendingEdits.id, id))
    .limit(1);

  json(res, 200, { pendingEdit: updated });
}
```

- [ ] **Step 3: Type check and commit**

```bash
git add api/pending-edits.ts api/_lib/pending-edits-helpers.ts
git commit -m "feat: add pending edits API with approve/reject workflow"
```

---

### Task 4: Modify existing endpoints to route through pending edits

**Files:**

- Modify: `api/drug-parameter.ts`

- Modify: `api/wiki/pages.ts`

- [ ] **Step 1: Update drug-parameter PUT handler**

In `api/drug-parameter.ts`, modify `handleUpdate`. After auth check (line 87-91), change the role check to allow viewers, then branch on role:

Replace the existing role check:

```typescript
  if (!auth || (auth.role !== 'editor' && auth.role !== 'admin')) {
    error(res, 403, 'Editor role required');
    return;
  }
```

With:

```typescript
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }
```

After validation succeeds (after `valid.data` is set), before the DB update block, add branching:

```typescript
  // Non-admin users create a pending edit instead of direct update
  if (auth.role !== 'admin') {
    const db = getDb();
    const [row] = await db
      .insert(pendingEdits)
      .values({
        editType: 'parameter',
        targetId: drugId,
        parameter,
        proposedValue: valid.data as never,
        proposedMeta: { editSummary: parsed.data.editSummary } as never,
        referenceId: parsed.data.referenceId,
        status: 'pending',
        submittedBy: auth.userId,
      })
      .returning();

    json(res, 201, { pending: true, pendingEditId: row.id });
    return;
  }

  // Admin: direct update (existing code continues below)
```

Add the import at the top of the file:

```typescript
import { pendingEdits } from '../db/schema.js';
```

- [ ] **Step 2: Update wiki/pages POST and PUT handlers**

In `api/wiki/pages.ts`, apply the same pattern to `handleCreate` and `handleUpdate`:

For `handleCreate`: after auth check, if role is not admin, create a pending edit with `editType: 'wiki_new'` and return `{ pending: true }`.

For `handleUpdate`: after auth check, if role is not admin, create a pending edit with `editType: 'wiki_page'` and return `{ pending: true }`.

Add the import:

```typescript
import { pendingEdits } from '../../db/schema.js';
```

- [ ] **Step 3: Type check and commit**

```bash
git add api/drug-parameter.ts api/wiki/pages.ts
git commit -m "feat: route non-admin edits through pending approval queue"
```

---

### Task 5: Client-side UI — form button text and toast feedback

**Files:**

- Modify: `src/components/wiki/ParameterEditForm.tsx`

- Modify: `src/components/wiki/WikiEditor.tsx`

- Modify: `src/stores/authStore.ts`

- [ ] **Step 1: Expose role from authStore**

In `src/stores/authStore.ts`, ensure the `user` object includes `role` (it already does via `user.role`). No change needed — just confirm.

- [ ] **Step 2: Update ParameterEditForm save button**

In `src/components/wiki/ParameterEditForm.tsx`, import `useAuthStore` and change the save button text:

```typescript
const userRole = useAuthStore((s) => s.user?.role);
```

Change the button label:

```typescript
{saving ? 'Saving...' : userRole === 'admin' ? 'Save' : 'Suggest change'}
```

After a successful save, if the response contains `pending: true`, show a different message. Update `handleSave`:

```typescript
    try {
      const result = await updateDrugParameter(drugId, parameter, parsed.data, referenceId, editSummary || undefined);
      if ((result as { pending?: boolean }).pending) {
        // Show pending feedback — close dialog, parent will handle
      }
      onSaved();
    }
```

- [ ] **Step 3: Update WikiEditor save button**

In `src/components/wiki/WikiEditor.tsx`, change the save button text based on role:

```typescript
const userRole = useAuthStore((s) => s.user?.role);
```

Button label:

```typescript
{saving ? 'Saving...' : mode === 'create'
  ? (userRole === 'admin' ? 'Create Page' : 'Submit for review')
  : (userRole === 'admin' ? 'Save Changes' : 'Submit for review')}
```

- [ ] **Step 4: Type check and commit**

```bash
git add src/components/wiki/ParameterEditForm.tsx src/components/wiki/WikiEditor.tsx
git commit -m "feat: update save buttons based on user role"
```

---

### Task 6: Review queue page

**Files:**

- Create: `src/pages/ReviewPage.tsx`

- Create: `src/components/review/PendingEditCard.tsx`

- Create: `src/components/review/RejectDialog.tsx`

- Modify: `src/router.tsx`

- [ ] **Step 1: Create RejectDialog**

Create `src/components/review/RejectDialog.tsx`:

```typescript
import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface RejectDialogProps {
  onReject: (comment: string) => void;
  onCancel: () => void;
  saving: boolean;
}

export function RejectDialog({ onReject, onCancel, saving }: RejectDialogProps) {
  const [comment, setComment] = useState('');

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-card rounded-lg shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-semibold mb-2">Reject edit</h3>
        <p className="text-sm text-muted-foreground mb-3">
          Provide a reason so the contributor can improve their next suggestion.
        </p>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Why is this change being rejected?"
          className="w-full px-3 py-2 bg-background border border-input rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[80px]"
          autoFocus
        />
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={() => onReject(comment)}
            disabled={!comment.trim() || saving}
          >
            {saving ? 'Rejecting...' : 'Reject'}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create PendingEditCard**

Create `src/components/review/PendingEditCard.tsx`:

```typescript
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { reviewPendingEdit, type PendingEditRow } from '@/lib/pendingEditsApi';
import { RejectDialog } from './RejectDialog';
import { formatRange } from '@/lib/rangeUtils';
import type { NumericRange } from '@/types';
import { Check, X } from 'lucide-react';

interface PendingEditCardProps {
  edit: PendingEditRow;
  currentValue?: unknown;
  onReviewed: () => void;
}

export function PendingEditCard({ edit, currentValue, onReviewed }: PendingEditCardProps) {
  const [showReject, setShowReject] = useState(false);
  const [saving, setSaving] = useState(false);

  const meta = (edit.proposedMeta ?? {}) as Record<string, unknown>;

  async function handleApprove() {
    setSaving(true);
    try {
      await reviewPendingEdit(edit.id, { status: 'approved' });
      onReviewed();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to approve');
    } finally {
      setSaving(false);
    }
  }

  async function handleReject(comment: string) {
    setSaving(true);
    try {
      await reviewPendingEdit(edit.id, { status: 'rejected', rejectionComment: comment });
      setShowReject(false);
      onReviewed();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to reject');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-border rounded-lg p-4 bg-card space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant={edit.editType === 'parameter' ? 'default' : 'secondary'}>
            {edit.editType === 'parameter' ? 'Parameter' : edit.editType === 'wiki_new' ? 'New page' : 'Page edit'}
          </Badge>
          <span className="font-medium text-sm">
            {edit.drugName ?? edit.pageTitle ?? 'Unknown'}
          </span>
          {edit.parameter && (
            <span className="text-xs text-muted-foreground">({edit.parameter})</span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          by {edit.submitter?.username ?? 'unknown'} · {new Date(edit.submittedAt).toLocaleDateString()}
        </span>
      </div>

      {edit.editType === 'parameter' && (
        <div className="text-sm flex items-center gap-3">
          <span className="text-muted-foreground">
            {formatRange(currentValue as NumericRange | null, { showNote: false }) || '—'}
          </span>
          <span className="text-muted-foreground">→</span>
          <span className="font-medium">
            {formatRange(edit.proposedValue as NumericRange | null, { showNote: false }) || '—'}
          </span>
        </div>
      )}

      {meta.editSummary && (
        <p className="text-xs text-muted-foreground italic">"{meta.editSummary as string}"</p>
      )}

      <div className="flex gap-2 pt-1">
        <Button size="sm" onClick={handleApprove} disabled={saving}>
          <Check className="h-3.5 w-3.5 mr-1" />
          Approve
        </Button>
        <Button size="sm" variant="outline" onClick={() => setShowReject(true)} disabled={saving}>
          <X className="h-3.5 w-3.5 mr-1" />
          Reject
        </Button>
      </div>

      {showReject && (
        <RejectDialog
          onReject={handleReject}
          onCancel={() => setShowReject(false)}
          saving={saving}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create ReviewPage**

Create `src/pages/ReviewPage.tsx`:

```typescript
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { fetchPendingEdits, type PendingEditRow } from '@/lib/pendingEditsApi';
import { PendingEditCard } from '@/components/review/PendingEditCard';
import { Button } from '@/components/ui/button';

export function ReviewPage() {
  const navigate = useNavigate();
  const { user, isAuthenticated, isLoading } = useAuthStore();
  const [edits, setEdits] = useState<PendingEditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'parameter' | 'wiki_page' | 'wiki_new'>('all');

  useEffect(() => {
    if (!isLoading && (!isAuthenticated || (user?.role !== 'editor' && user?.role !== 'admin'))) {
      navigate('/', { replace: true });
    }
  }, [isLoading, isAuthenticated, user, navigate]);

  function loadEdits() {
    setLoading(true);
    const params: Record<string, string> = { status: 'pending' };
    if (filter !== 'all') params.editType = filter;
    fetchPendingEdits(params)
      .then((data) => setEdits(data.pendingEdits))
      .catch(() => setEdits([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadEdits(); }, [filter]);

  const filters = [
    { key: 'all' as const, label: 'All' },
    { key: 'parameter' as const, label: 'Parameters' },
    { key: 'wiki_page' as const, label: 'Page edits' },
    { key: 'wiki_new' as const, label: 'New pages' },
  ];

  return (
    <div className="flex-1 bg-background">
      <div className="max-w-4xl mx-auto p-6">
        <h1 className="text-2xl font-bold mb-1">Review Queue</h1>
        <p className="text-sm text-muted-foreground mb-4">
          {edits.length} pending {edits.length === 1 ? 'edit' : 'edits'}
        </p>

        <div className="flex gap-1 mb-4">
          {filters.map((f) => (
            <Button
              key={f.key}
              variant={filter === f.key ? 'default' : 'outline'}
              size="sm"
              className="text-xs"
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </Button>
          ))}
        </div>

        {loading ? (
          <p className="text-muted-foreground text-sm">Loading...</p>
        ) : edits.length === 0 ? (
          <p className="text-muted-foreground text-sm py-8 text-center">No pending edits to review.</p>
        ) : (
          <div className="space-y-3">
            {edits.map((edit) => (
              <PendingEditCard
                key={edit.id}
                edit={edit}
                onReviewed={loadEdits}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add route**

In `src/router.tsx`, add import and route:

```typescript
import { ReviewPage } from './pages/ReviewPage';
```

Add inside the `<Route element={<RootLayout />}>` block:

```typescript
        <Route path="/review" element={<ReviewPage />} />
```

- [ ] **Step 5: Type check and commit**

```bash
git add src/pages/ReviewPage.tsx src/components/review/PendingEditCard.tsx src/components/review/RejectDialog.tsx src/router.tsx
git commit -m "feat: add review queue page with approve/reject UI"
```

---

### Task 7: Header pending count badge

**Files:**

- Create: `src/components/PendingBadge.tsx`

- Modify: `src/components/Header.tsx`

- [ ] **Step 1: Create PendingBadge**

Create `src/components/PendingBadge.tsx`:

```typescript
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { fetchPendingEditCount } from '@/lib/pendingEditsApi';

export function PendingBadge() {
  const user = useAuthStore((s) => s.user);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (user?.role !== 'editor' && user?.role !== 'admin') return;
    fetchPendingEditCount().then((r) => setCount(r.count)).catch(() => {});
    const interval = setInterval(() => {
      fetchPendingEditCount().then((r) => setCount(r.count)).catch(() => {});
    }, 30_000);
    return () => clearInterval(interval);
  }, [user?.role]);

  if (user?.role !== 'editor' && user?.role !== 'admin') return null;

  return (
    <Link
      to="/review"
      className="text-sm font-medium px-3 py-1.5 rounded-md text-white/60 hover:text-white hover:bg-white/8 transition-colors flex items-center gap-1.5"
    >
      Review
      {count > 0 && (
        <span className="bg-accent text-accent-foreground text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
          {count}
        </span>
      )}
    </Link>
  );
}
```

- [ ] **Step 2: Add to Header**

In `src/components/Header.tsx`, import and render after the nav links:

```typescript
import { PendingBadge } from '@/components/PendingBadge';
```

Add after the `</nav>` closing tag, before the first divider:

```typescript
          <PendingBadge />
```

- [ ] **Step 3: Type check and commit**

```bash
git add src/components/PendingBadge.tsx src/components/Header.tsx
git commit -m "feat: add review badge with pending count in header"
```

---

### Task 8: Pending indicator on parameters and wiki pages

**Files:**

- Modify: `src/components/wiki/DrugMonographSidebar.tsx`

- Modify: `src/pages/wiki/WikiPage.tsx`

- [ ] **Step 1: Show pending indicator per parameter in sidebar**

In `src/components/wiki/DrugMonographSidebar.tsx`, fetch pending edits for the current drug and show a "pending" badge next to parameters that have suggestions.

Import `fetchPendingEdits` and add a state for pending parameter IDs:

```typescript
import { fetchPendingEdits } from '@/lib/pendingEditsApi';
```

In the component body:

```typescript
  const [pendingParams, setPendingParams] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!drug) return;
    fetchPendingEdits({ status: 'pending', editType: 'parameter' })
      .then((data) => {
        const params = new Set(
          data.pendingEdits
            .filter((e) => e.targetId === drug.id && e.parameter)
            .map((e) => e.parameter!),
        );
        setPendingParams(params);
      })
      .catch(() => {});
  }, [drug]);
```

In the parameter rendering loop, after the formatted value, add:

```typescript
{pendingParams.has(pid) && (
  <span className="text-[10px] text-amber-500 ml-1">pending</span>
)}
```

- [ ] **Step 2: Show pending edit link on wiki pages**

In `src/pages/wiki/WikiPage.tsx`, check if the current user has a pending edit for this page:

```typescript
import { fetchPendingEdits } from '@/lib/pendingEditsApi';
import { useAuthStore } from '@/stores/authStore';
```

Add state and effect:

```typescript
  const currentUser = useAuthStore((s) => s.user);
  const [hasPendingEdit, setHasPendingEdit] = useState(false);

  useEffect(() => {
    if (!page || !currentUser) return;
    fetchPendingEdits({ status: 'pending', submittedBy: currentUser.id })
      .then((data) => {
        setHasPendingEdit(
          data.pendingEdits.some((e) => e.editType === 'wiki_page' && e.targetId === page.id),
        );
      })
      .catch(() => {});
  }, [page, currentUser]);
```

Display below the page metadata:

```typescript
{hasPendingEdit && (
  <div className="text-xs text-amber-500 mt-1">
    You have a pending edit for this page
  </div>
)}
```

- [ ] **Step 3: Type check and commit**

```bash
git add src/components/wiki/DrugMonographSidebar.tsx src/pages/wiki/WikiPage.tsx
git commit -m "feat: show pending edit indicators on parameters and wiki pages"
```

---

### Task 9: Final integration verification

- [ ] **Step 1: Type check**

Run: `npx tsc --noEmit`

- [ ] **Step 2: Build**

Run: `npx vite build 2>&1 | tail -5`

- [ ] **Step 3: Commit any remaining changes**

```bash
git status
```
