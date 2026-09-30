# Reference & Citation System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all data in Kinetix scientifically traceable — required references for parameter edits, Wikipedia-style footnotes in wiki monographs, with auto-fetch of PubMed/DOI metadata.

**Architecture:** A shared `references` table stores all citations. Parameter edits link via `referenceId` FK on `drug_parameter_revisions`. Wiki content uses inline TipTap footnote nodes with `referenceId` attrs. A server-side `/api/references/resolve` endpoint fetches metadata from NCBI E-utilities (PMID) and CrossRef (DOI). A shared `ReferenceInput` React component is used in both the parameter edit form and the wiki editor.

**Tech Stack:** Drizzle ORM (Postgres), Vite + React + React Router, TipTap 3.x editor, Zustand, Tailwind CSS, Zod validation.

**Spec:** `docs/superpowers/specs/2026-04-11-reference-system-design.md`

---

## File Structure

### New files

| File                                         | Responsibility                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `db/schema.ts` (modify)                      | Add `references` table, `referenceId` column on `drugParameterRevisions`                  |
| `api/references.ts`                          | CRUD for references (POST create/dedupe, GET by drugId)                                   |
| `api/references-resolve.ts`                  | Metadata fetcher endpoint — PubMed and CrossRef                                           |
| `api/_lib/pubmed.ts`                         | PubMed E-utilities XML fetch + parse                                                      |
| `api/_lib/crossref.ts`                       | CrossRef API JSON fetch + parse                                                           |
| `api/_lib/schemas.ts` (modify)               | Add `createReferenceSchema`, `resolveReferenceSchema`, update `updateDrugParameterSchema` |
| `src/components/wiki/ReferenceInput.tsx`     | Shared Text/PMID/DOI tabbed input with preview card                                       |
| `src/components/wiki/extensions/Footnote.ts` | TipTap footnote inline node extension                                                     |
| `src/components/wiki/FootnotePrompt.tsx`     | Floating "Add reference?" tooltip                                                         |
| `src/components/wiki/Bibliography.tsx`       | Renders numbered reference list from footnote data                                        |
| `src/lib/referenceApi.ts`                    | Client-side API functions for references                                                  |

### Modified files

| File                                        | Change                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------ |
| `db/schema.ts`                              | Add `references` table + type exports, add `referenceId` to `drugParameterRevisions` |
| `api/_lib/schemas.ts`                       | New zod schemas for references, update parameter edit schema                         |
| `api/drug-parameter.ts`                     | Require `referenceId` in PUT, insert into revision row                               |
| `src/lib/drugApi.ts`                        | Update `updateDrugParameter()` signature to include `referenceId`                    |
| `src/components/wiki/ParameterEditForm.tsx` | Add required `ReferenceInput` section                                                |
| `src/components/wiki/WikiEditor.tsx`        | Register Footnote extension, wire Cite toolbar button                                |
| `src/components/wiki/EditorToolbar.tsx`     | Add Cite button + Ctrl+Shift+R shortcut                                              |
| `src/components/wiki/WikiRenderer.tsx`      | Render footnotes as superscripts + bibliography                                      |
| `api/_lib/tiptap-utils.ts`                  | Server-side footnote HTML rendering                                                  |
| `src/styles/wiki-prose.css`                 | Footnote and bibliography styles                                                     |

---

### Task 1: Database schema — `references` table + migration

**Files:**

- Modify: `db/schema.ts`

- [ ] **Step 1: Add `references` table to schema**

In `db/schema.ts`, add before the type exports section (before line 260):

```typescript
// ─── References (citations / sources) ───────────────────────────────────────

export const references = pgTable(
  'references',
  {
    id: serial('id').primaryKey(),
    drugId: integer('drug_id').references(() => drugs.id, { onDelete: 'set null' }),
    type: varchar('type', { length: 10 }).notNull(), // 'freetext' | 'url' | 'pmid' | 'doi'
    identifier: text('identifier').notNull(),
    metadata: jsonb('metadata'), // {title, authors, journal, year, volume, pages}
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('references_drug_id_idx').on(t.drugId),
    index('references_type_identifier_idx').on(t.type, t.identifier),
  ],
);
```

- [ ] **Step 2: Add `referenceId` column to `drugParameterRevisions`**

In `db/schema.ts`, add to the `drugParameterRevisions` table columns (after `editSummary`, before `createdBy`):

```typescript
    referenceId: integer('reference_id').references(() => references.id, { onDelete: 'set null' }),
```

- [ ] **Step 3: Add type exports**

Add to the type exports section at the bottom of `db/schema.ts`:

```typescript
export type Reference = typeof references.$inferSelect;
export type NewReference = typeof references.$inferInsert;
```

- [ ] **Step 4: Generate migration**

Run: `npx drizzle-kit generate`

Verify a new SQL file appears in `drizzle/` with the CREATE TABLE and ALTER TABLE statements.

- [ ] **Step 5: Apply migration**

Run: `npx drizzle-kit push`

Expected: migration applies cleanly, no errors.

- [ ] **Step 6: Type check**

Run: `npx tsc --noEmit`

Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add db/schema.ts drizzle/
git commit -m "feat: add references table and referenceId on parameter revisions"
```

---

### Task 2: PubMed and CrossRef metadata fetchers

**Files:**

- Create: `api/_lib/pubmed.ts`

- Create: `api/_lib/crossref.ts`

- [ ] **Step 1: Create PubMed fetcher**

Create `api/_lib/pubmed.ts`:

```typescript
export interface PubMedMetadata {
  title: string;
  authors: string[];
  journal: string;
  year: number | null;
  volume: string | null;
  pages: string | null;
}

export async function fetchPubMedMetadata(pmid: string): Promise<PubMedMetadata | null> {
  const url = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=json`;

  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;

  const data = await res.json();
  const doc = data?.result?.[pmid];
  if (!doc || doc.error) return null;

  return {
    title: doc.title ?? '',
    authors: (doc.authors ?? []).map((a: { name: string }) => a.name),
    journal: doc.source ?? '',
    year: doc.pubdate ? parseInt(doc.pubdate, 10) || null : null,
    volume: doc.volume || null,
    pages: doc.pages || null,
  };
}
```

- [ ] **Step 2: Create CrossRef fetcher**

Create `api/_lib/crossref.ts`:

```typescript
export interface CrossRefMetadata {
  title: string;
  authors: string[];
  journal: string;
  year: number | null;
  volume: string | null;
  pages: string | null;
}

export async function fetchCrossRefMetadata(doi: string): Promise<CrossRefMetadata | null> {
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Kinetix/1.0 (https://kinetix.no; mailto:admin@kinetix.no)',
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;

  const data = await res.json();
  const work = data?.message;
  if (!work) return null;

  return {
    title: Array.isArray(work.title) ? work.title[0] ?? '' : '',
    authors: (work.author ?? []).map(
      (a: { given?: string; family?: string }) =>
        [a.family, a.given].filter(Boolean).join(' '),
    ),
    journal: Array.isArray(work['container-title']) ? work['container-title'][0] ?? '' : '',
    year: work.published?.['date-parts']?.[0]?.[0] ?? null,
    volume: work.volume || null,
    pages: work.page || null,
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add api/_lib/pubmed.ts api/_lib/crossref.ts
git commit -m "feat: add PubMed and CrossRef metadata fetchers"
```

---

### Task 3: Reference API endpoints

**Files:**

- Modify: `api/_lib/schemas.ts`

- Create: `api/references-resolve.ts`

- Create: `api/references.ts`

- [ ] **Step 1: Add zod schemas**

In `api/_lib/schemas.ts`, add:

```typescript
export const resolveReferenceSchema = z.object({
  type: z.enum(['freetext', 'url', 'pmid', 'doi']),
  identifier: z.string().min(1).max(2000),
});

export const createReferenceSchema = z.object({
  drugId: z.number().int().positive().nullable().optional(),
  type: z.enum(['freetext', 'url', 'pmid', 'doi']),
  identifier: z.string().min(1).max(2000),
  metadata: z.any().nullable().optional(),
});
```

- [ ] **Step 2: Create `/api/references-resolve.ts`**

```typescript
import type { ServerResponse } from 'node:http';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getUserFromRequest } from './_lib/auth.js';
import { parseAndValidate } from './_lib/validate.js';
import { resolveReferenceSchema } from './_lib/schemas.js';
import { fetchPubMedMetadata } from './_lib/pubmed.js';
import { fetchCrossRefMetadata } from './_lib/crossref.js';

export default withErrorHandling(async function handler(req, res): Promise<void> {
  if (req.method !== 'POST') {
    error(res, 405, 'Method not allowed');
    return;
  }

  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }

  const parsed = await parseAndValidate(req, resolveReferenceSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const { type, identifier } = parsed.data;

  if (type === 'pmid') {
    const metadata = await fetchPubMedMetadata(identifier).catch(() => null);
    if (!metadata) {
      json(res, 200, { metadata: null, error: 'Could not resolve PubMed ID' });
      return;
    }
    json(res, 200, { metadata });
    return;
  }

  if (type === 'doi') {
    const metadata = await fetchCrossRefMetadata(identifier).catch(() => null);
    if (!metadata) {
      json(res, 200, { metadata: null, error: 'Could not resolve DOI' });
      return;
    }
    json(res, 200, { metadata });
    return;
  }

  json(res, 200, { metadata: null });
});
```

- [ ] **Step 3: Create `/api/references.ts`**

```typescript
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq, and } from 'drizzle-orm';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { parseAndValidate } from './_lib/validate.js';
import { createReferenceSchema } from './_lib/schemas.js';
import { references } from '../db/schema.js';

export default withErrorHandling(async function handler(req, res): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  switch (req.method) {
    case 'GET':
      return handleGet(res, url);
    case 'POST':
      return handleCreate(req, res);
    default:
      error(res, 405, 'Method not allowed');
  }
});

async function handleGet(res: ServerResponse, url: URL): Promise<void> {
  const drugId = Number(url.searchParams.get('drugId'));
  if (!drugId) {
    error(res, 400, 'Missing drugId');
    return;
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(references)
    .where(eq(references.drugId, drugId))
    .orderBy(references.createdAt);

  json(res, 200, { references: rows });
}

async function handleCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return;
  }

  const parsed = await parseAndValidate(req, createReferenceSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const { type, identifier, metadata, drugId } = parsed.data;
  const db = getDb();

  // Deduplicate: check if this exact reference already exists
  const [existing] = await db
    .select()
    .from(references)
    .where(and(eq(references.type, type), eq(references.identifier, identifier)))
    .limit(1);

  if (existing) {
    json(res, 200, { reference: existing });
    return;
  }

  const [row] = await db
    .insert(references)
    .values({
      drugId: drugId ?? null,
      type,
      identifier,
      metadata: metadata ?? null,
      createdBy: auth.userId,
    })
    .returning();

  json(res, 201, { reference: row });
}
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/schemas.ts api/references-resolve.ts api/references.ts
git commit -m "feat: add reference CRUD and metadata resolve API endpoints"
```

---

### Task 4: Update parameter edit API to require `referenceId`

**Files:**

- Modify: `api/_lib/schemas.ts`

- Modify: `api/drug-parameter.ts`

- Modify: `src/lib/drugApi.ts`

- [ ] **Step 1: Update the zod schema**

In `api/_lib/schemas.ts`, update `updateDrugParameterSchema`:

```typescript
export const updateDrugParameterSchema = z.object({
  value: z.any(), // Validated against the registry spec at the route layer
  editSummary: z.string().max(500).optional(),
  referenceId: z.number().int().positive(),
});
```

- [ ] **Step 2: Update `handleUpdate` in `api/drug-parameter.ts`**

Add `referenceId` to the revision insert. After line 143 (`editSummary: parsed.data.editSummary ?? null,`), add:

```typescript
    referenceId: parsed.data.referenceId,
```

So the full insert becomes:

```typescript
  await db.insert(drugParameterRevisions).values({
    drugId,
    parameter,
    oldValue: oldValue as never,
    newValue: newValue as never,
    editSummary: parsed.data.editSummary ?? null,
    referenceId: parsed.data.referenceId,
    createdBy: auth.userId,
  });
```

- [ ] **Step 3: Update client-side `updateDrugParameter` in `src/lib/drugApi.ts`**

Update the function signature and body:

```typescript
export async function updateDrugParameter(
  drugId: number,
  parameter: DrugParameterId,
  value: unknown,
  referenceId: number,
  editSummary?: string,
): Promise<{ parameter: string; value: unknown }> {
  return apiFetch(
    `/api/drug-parameter?drugId=${drugId}&parameter=${encodeURIComponent(parameter)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value, editSummary, referenceId }),
    },
  );
}
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`

Expected: errors in `ParameterEditForm.tsx` because `updateDrugParameter` call is missing `referenceId`. This is expected — Task 6 fixes it.

- [ ] **Step 5: Commit**

```bash
git add api/_lib/schemas.ts api/drug-parameter.ts src/lib/drugApi.ts
git commit -m "feat: require referenceId on parameter edits"
```

---

### Task 5: Client-side reference API functions + `ReferenceInput` component

**Files:**

- Create: `src/lib/referenceApi.ts`

- Create: `src/components/wiki/ReferenceInput.tsx`

- [ ] **Step 1: Create `src/lib/referenceApi.ts`**

```typescript
export interface ReferenceMetadata {
  title: string;
  authors: string[];
  journal: string;
  year: number | null;
  volume: string | null;
  pages: string | null;
}

export interface ReferenceRow {
  id: number;
  drugId: number | null;
  type: 'freetext' | 'url' | 'pmid' | 'doi';
  identifier: string;
  metadata: ReferenceMetadata | null;
  createdBy: number | null;
  createdAt: string;
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export async function resolveReference(
  type: string,
  identifier: string,
): Promise<{ metadata: ReferenceMetadata | null; error?: string }> {
  return apiFetch('/api/references-resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, identifier }),
  });
}

export async function createReference(data: {
  drugId?: number | null;
  type: string;
  identifier: string;
  metadata?: ReferenceMetadata | null;
}): Promise<{ reference: ReferenceRow }> {
  return apiFetch('/api/references', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

export async function fetchReferences(drugId: number): Promise<{ references: ReferenceRow[] }> {
  return apiFetch(`/api/references?drugId=${drugId}`);
}

export function formatReference(ref: ReferenceRow): string {
  if (ref.metadata) {
    const m = ref.metadata;
    const authors = m.authors.length > 3
      ? `${m.authors.slice(0, 3).join(', ')}, et al.`
      : m.authors.join(', ');
    const parts = [authors];
    if (m.title) parts.push(`"${m.title}"`);
    if (m.journal) parts.push(m.journal + '.');
    if (m.year) parts.push(String(m.year));
    if (m.volume) {
      let vol = `;${m.volume}`;
      if (m.pages) vol += `:${m.pages}`;
      parts.push(vol + '.');
    }
    if (ref.type === 'pmid') parts.push(`PMID: ${ref.identifier}`);
    if (ref.type === 'doi') parts.push(`DOI: ${ref.identifier}`);
    return parts.join(' ');
  }
  if (ref.type === 'url') return ref.identifier;
  return ref.identifier;
}
```

- [ ] **Step 2: Create `src/components/wiki/ReferenceInput.tsx`**

```typescript
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  resolveReference,
  createReference,
  formatReference,
  type ReferenceMetadata,
  type ReferenceRow,
} from '@/lib/referenceApi';

type RefType = 'freetext' | 'pmid' | 'doi';

interface ReferenceInputProps {
  drugId?: number | null;
  required?: boolean;
  onReferenceCreated: (ref: ReferenceRow) => void;
}

export function ReferenceInput({ drugId, required, onReferenceCreated }: ReferenceInputProps) {
  const [tab, setTab] = useState<RefType>('freetext');
  const [value, setValue] = useState('');
  const [resolving, setResolving] = useState(false);
  const [preview, setPreview] = useState<{ metadata: ReferenceMetadata; type: RefType; identifier: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleResolve() {
    if (!value.trim()) return;
    setError(null);
    setResolving(true);
    try {
      const result = await resolveReference(tab, value.trim());
      if (result.metadata) {
        setPreview({ metadata: result.metadata, type: tab, identifier: value.trim() });
      } else {
        setError(result.error ?? 'Could not resolve. Save as free text instead?');
      }
    } catch {
      setError('Network error. Try again or save as free text.');
    } finally {
      setResolving(false);
    }
  }

  async function handleSave() {
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const result = await createReference({
        drugId: drugId ?? null,
        type: preview ? preview.type : tab === 'freetext' ? 'freetext' : 'freetext',
        identifier: value.trim(),
        metadata: preview?.metadata ?? null,
      });
      onReferenceCreated(result.reference);
      setValue('');
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save reference');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveResolved() {
    if (!preview) return;
    setSaving(true);
    setError(null);
    try {
      const result = await createReference({
        drugId: drugId ?? null,
        type: preview.type,
        identifier: preview.identifier,
        metadata: preview.metadata,
      });
      onReferenceCreated(result.reference);
      setValue('');
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save reference');
    } finally {
      setSaving(false);
    }
  }

  function handleFallbackToFreetext() {
    setTab('freetext');
    setError(null);
    setPreview(null);
  }

  const tabs: { key: RefType; label: string }[] = [
    { key: 'freetext', label: 'Text' },
    { key: 'pmid', label: 'PMID' },
    { key: 'doi', label: 'DOI' },
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground mr-1">
          Source{required ? '' : ' (optional)'}
        </span>
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => { setTab(t.key); setPreview(null); setError(null); }}
            className={`text-xs px-2 py-0.5 rounded ${
              tab === t.key
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex gap-1.5">
        <Input
          value={value}
          onChange={(e) => { setValue(e.target.value); setPreview(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (tab === 'freetext') handleSave();
              else handleResolve();
            }
          }}
          placeholder={
            tab === 'freetext' ? 'Free text citation, URL, or description...'
              : tab === 'pmid' ? 'e.g. 12345678'
              : 'e.g. 10.1007/s00414-023-02965-6'
          }
          className="text-sm"
        />
        {tab === 'freetext' ? (
          <Button
            type="button"
            size="sm"
            onClick={handleSave}
            disabled={!value.trim() || saving}
          >
            {saving ? '...' : 'Add'}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={handleResolve}
            disabled={!value.trim() || resolving}
          >
            {resolving ? '...' : 'Lookup'}
          </Button>
        )}
      </div>

      {preview && (
        <div className="border border-border rounded p-2 bg-muted/30 text-xs space-y-1.5">
          <div className="font-medium">{preview.metadata.title}</div>
          <div className="text-muted-foreground">
            {preview.metadata.authors.slice(0, 3).join(', ')}
            {preview.metadata.authors.length > 3 && ', et al.'}
            {preview.metadata.journal && ` — ${preview.metadata.journal}`}
            {preview.metadata.year && ` (${preview.metadata.year})`}
          </div>
          <Button type="button" size="sm" onClick={handleSaveResolved} disabled={saving}>
            {saving ? 'Saving...' : 'Use this reference'}
          </Button>
        </div>
      )}

      {error && (
        <div className="text-xs text-red-600 flex items-center gap-2">
          <span>{error}</span>
          {tab !== 'freetext' && (
            <button
              type="button"
              onClick={handleFallbackToFreetext}
              className="text-primary underline"
            >
              Save as free text
            </button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`

Expected: zero errors (these files are standalone).

- [ ] **Step 4: Commit**

```bash
git add src/lib/referenceApi.ts src/components/wiki/ReferenceInput.tsx
git commit -m "feat: add ReferenceInput component and reference API client"
```

---

### Task 6: Update ParameterEditForm with required source

**Files:**

- Modify: `src/components/wiki/ParameterEditForm.tsx`

- [ ] **Step 1: Update ParameterEditForm**

Replace the full file content with the updated version that adds a required `ReferenceInput` between the note field and edit summary. Key changes:

1. Import `ReferenceInput` and `ReferenceRow` type
2. Add `referenceId` state (initially `null`)
3. Add `ReferenceInput` component to the form between note and editSummary
4. Pass `referenceId` to `updateDrugParameter()`
5. Disable Save button when `referenceId` is null

```typescript
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { DRUG_PARAMETERS, type DrugParameterId } from '@/lib/drugParameters';
import { updateDrugParameter } from '@/lib/drugApi';
import type { NumericRange } from '@/types';
import { ReferenceInput } from './ReferenceInput';
import type { ReferenceRow } from '@/lib/referenceApi';

interface Props {
  drugId: number;
  parameter: DrugParameterId;
  currentValue: unknown;
  onClose: () => void;
  onSaved: () => void;
}

function toInputRange(value: unknown): NumericRange {
  if (value && typeof value === 'object') return value as NumericRange;
  return {};
}

export function ParameterEditForm({
  drugId,
  parameter,
  currentValue,
  onClose,
  onSaved,
}: Props) {
  const spec = DRUG_PARAMETERS[parameter];
  const initial = useMemo(() => toInputRange(currentValue), [currentValue]);

  const [min, setMin] = useState<string>(initial.min !== undefined ? String(initial.min) : '');
  const [max, setMax] = useState<string>(initial.max !== undefined ? String(initial.max) : '');
  const [value, setValue] = useState<string>(
    initial.value !== undefined ? String(initial.value) : '',
  );
  const [unit, setUnit] = useState<string>(initial.unit ?? spec.canonicalUnit);
  const [note, setNote] = useState<string>(initial.note ?? '');
  const [editSummary, setEditSummary] = useState<string>('');
  const [referenceId, setReferenceId] = useState<number | null>(null);
  const [referenceName, setReferenceName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (referenceId === null) {
      setError('A source reference is required');
      return;
    }
    setError(null);
    setSaving(true);

    const build: NumericRange = {};
    if (min !== '') build.min = Number(min);
    if (max !== '') build.max = Number(max);
    if (value !== '') build.value = Number(value);
    if (unit) build.unit = unit;
    if (note.trim()) build.note = note.trim();

    const parsed = spec.zod.safeParse(build);
    if (!parsed.success) {
      setError(parsed.error.issues.map((i) => i.message).join('; '));
      setSaving(false);
      return;
    }

    try {
      await updateDrugParameter(drugId, parameter, parsed.data, referenceId, editSummary || undefined);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  function handleReferenceCreated(ref: ReferenceRow) {
    setReferenceId(ref.id);
    setReferenceName(ref.metadata?.title ?? ref.identifier);
  }

  const unitOptions = spec.allowedUnits.map((u) => ({ value: u, label: u }));

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
        <h3 className="text-lg font-semibold mb-1">Edit {spec.longLabel}</h3>
        <p className="text-xs text-muted-foreground mb-4">
          Allowed bounds: {spec.bounds.min} – {spec.bounds.max}
          {spec.requiresMinMax ? ' · min and max required' : ''}
        </p>

        <div className="flex flex-col gap-3">
          {spec.kind === 'struct' ? (
            <p className="text-sm text-red-600">
              Editing structured parameters is not yet supported in this dialog.
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">Min</span>
                  <Input
                    type="number"
                    value={min}
                    onChange={(e) => setMin(e.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">Max</span>
                  <Input
                    type="number"
                    value={max}
                    onChange={(e) => setMax(e.target.value)}
                  />
                </label>
              </div>

              {!spec.requiresMinMax && (
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">Single value (optional)</span>
                  <Input
                    type="number"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                </label>
              )}

              {unitOptions.length > 0 && (
                <label className="flex flex-col gap-1 text-xs">
                  <span className="text-muted-foreground">Unit</span>
                  <Select
                    options={unitOptions}
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                  />
                </label>
              )}

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Note (optional)</span>
                <Input value={note} onChange={(e) => setNote(e.target.value)} />
              </label>

              <div className="border-t border-border pt-3">
                {referenceId ? (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-emerald-600 font-medium">Source set:</span>
                    <span className="text-muted-foreground truncate flex-1">{referenceName}</span>
                    <button
                      type="button"
                      onClick={() => { setReferenceId(null); setReferenceName(null); }}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <ReferenceInput
                    drugId={drugId}
                    required
                    onReferenceCreated={handleReferenceCreated}
                  />
                )}
              </div>

              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Edit summary</span>
                <Input
                  value={editSummary}
                  onChange={(e) => setEditSummary(e.target.value)}
                  placeholder="Why are you changing this?"
                />
              </label>
            </>
          )}

          {error && <div className="text-sm text-red-600">{error}</div>}
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving || spec.kind === 'struct' || referenceId === null}>
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/wiki/ParameterEditForm.tsx
git commit -m "feat: require source reference in parameter edit form"
```

---

### Task 7: TipTap footnote extension

**Files:**

- Create: `src/components/wiki/extensions/Footnote.ts`

- [ ] **Step 1: Create the Footnote TipTap node**

```typescript
import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    footnote: {
      insertFootnote: (referenceId: number) => ReturnType;
    };
  }
}

export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      referenceId: {
        default: null,
        parseHTML: (element) => Number(element.getAttribute('data-reference-id')) || null,
        renderHTML: (attributes) => ({ 'data-reference-id': attributes.referenceId }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'sup[data-reference-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['sup', mergeAttributes({ class: 'footnote-marker' }, HTMLAttributes), ''];
  },

  addCommands() {
    return {
      insertFootnote:
        (referenceId: number) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: { referenceId },
          });
        },
    };
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add src/components/wiki/extensions/Footnote.ts
git commit -m "feat: add TipTap footnote inline node extension"
```

---

### Task 8: Wire Footnote into WikiEditor + EditorToolbar

**Files:**

- Modify: `src/components/wiki/WikiEditor.tsx`

- Modify: `src/components/wiki/EditorToolbar.tsx`

- [ ] **Step 1: Register Footnote in WikiEditor**

In `src/components/wiki/WikiEditor.tsx`, add import:

```typescript
import { Footnote } from './extensions/Footnote';
```

Add to the extensions array (after `Link.configure(...)`):

```typescript
      Footnote,
```

Add state and handler for the citation panel:

```typescript
  const [showCitePanel, setShowCitePanel] = useState(false);
```

Add a handler function for when a reference is created from the cite panel:

```typescript
  function handleCiteReferenceCreated(ref: { id: number }) {
    editor?.commands.insertFootnote(ref.id);
    setShowCitePanel(false);
  }
```

Pass `onCite` and `showCitePanel` to the toolbar:

```typescript
  <EditorToolbar editor={editor} onCite={() => setShowCitePanel(true)} />
```

Import and render the `ReferenceInput` below the toolbar when `showCitePanel` is true:

```typescript
import { ReferenceInput } from './ReferenceInput';
import type { ReferenceRow } from '@/lib/referenceApi';
```

After the `<EditorContent editor={editor} />` line, inside the editor border div:

```typescript
          {showCitePanel && (
            <div className="border-t border-border px-4 py-3 bg-muted/20">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-medium">Add citation</span>
                <button
                  type="button"
                  onClick={() => setShowCitePanel(false)}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
              <ReferenceInput
                drugId={drugCid}
                onReferenceCreated={(ref: ReferenceRow) => handleCiteReferenceCreated(ref)}
              />
            </div>
          )}
```

- [ ] **Step 2: Add Cite button to EditorToolbar**

In `src/components/wiki/EditorToolbar.tsx`, add `onCite` to the props:

```typescript
interface EditorToolbarProps {
  editor: Editor;
  onCite?: () => void;
}
```

Update the function signature:

```typescript
export function EditorToolbar({ editor, onCite }: EditorToolbarProps) {
```

Add the Cite button after the Img button (before the inline link input section):

```typescript
      {/* Citation */}
      {onCite && (
        <>
          <Separator />
          <ToolbarButton onClick={onCite} title="Insert citation (Ctrl+Shift+R)">
            Cite
          </ToolbarButton>
        </>
      )}
```

- [ ] **Step 3: Add Ctrl+Shift+R shortcut in WikiEditor**

In `WikiEditor.tsx`, inside the existing `handleKeyDown` function (which already handles Ctrl+S), add a case for Ctrl+Shift+R:

```typescript
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        setShowCitePanel(true);
      }
```

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`

Expected: zero errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/wiki/WikiEditor.tsx src/components/wiki/EditorToolbar.tsx
git commit -m "feat: add Cite button and Ctrl+Shift+R shortcut in wiki editor"
```

---

### Task 9: Non-intrusive "Add reference?" prompt

**Files:**

- Create: `src/components/wiki/FootnotePrompt.tsx`

- Modify: `src/components/wiki/WikiEditor.tsx`

- [ ] **Step 1: Create FootnotePrompt component**

```typescript
import { useState, useEffect, useRef } from 'react';
import type { Editor } from '@tiptap/react';

interface FootnotePromptProps {
  editor: Editor;
  onAddCitation: () => void;
}

export function FootnotePrompt({ editor, onAddCitation }: FootnotePromptProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastParaRef = useRef<string | null>(null);
  const dismissedRef = useRef(new Set<string>());

  useEffect(() => {
    function checkPrompt() {
      // Don't show if editor isn't focused
      if (!editor.isFocused) {
        setVisible(false);
        return;
      }

      const { $anchor } = editor.state.selection;
      const node = $anchor.parent;

      // Only for paragraphs with content
      if (node.type.name !== 'paragraph' || node.textContent.length === 0) {
        setVisible(false);
        return;
      }

      const paraKey = `${$anchor.pos}-${node.textContent.length}`;

      // Already dismissed this paragraph
      if (dismissedRef.current.has(paraKey)) return;

      // Same paragraph as last time — skip
      if (lastParaRef.current === paraKey) return;
      lastParaRef.current = paraKey;

      // Cancel any pending timer
      if (timerRef.current) clearTimeout(timerRef.current);

      // Show after 3 second pause
      timerRef.current = setTimeout(() => {
        // Get cursor position for tooltip placement
        const coords = editor.view.coordsAtPos($anchor.pos);
        const editorRect = editor.view.dom.getBoundingClientRect();
        setPosition({
          top: coords.bottom - editorRect.top + 4,
          left: coords.left - editorRect.left,
        });
        setVisible(true);

        // Auto-hide after 4 seconds
        setTimeout(() => setVisible(false), 4000);
      }, 3000);
    }

    // Listen for selection and content changes
    editor.on('selectionUpdate', checkPrompt);
    editor.on('update', () => {
      setVisible(false);
      if (timerRef.current) clearTimeout(timerRef.current);
      lastParaRef.current = null;
    });

    return () => {
      editor.off('selectionUpdate', checkPrompt);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [editor]);

  if (!visible) return null;

  return (
    <div
      className="absolute z-30 bg-white border border-border rounded-md shadow-sm px-2.5 py-1.5 flex items-center gap-2 text-xs text-muted-foreground animate-in fade-in duration-200"
      style={{ top: position.top, left: position.left }}
    >
      <span>Add reference?</span>
      <button
        type="button"
        onClick={() => {
          setVisible(false);
          onAddCitation();
        }}
        className="text-primary font-medium hover:underline"
      >
        [+]
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Wire FootnotePrompt into WikiEditor**

In `WikiEditor.tsx`, import and render the prompt inside the editor container (relative positioned):

```typescript
import { FootnotePrompt } from './FootnotePrompt';
```

Wrap the `<EditorContent>` in a `relative` div and add the prompt:

```typescript
        <div className="border border-border rounded-lg overflow-hidden">
          {editor && (
            <EditorToolbar editor={editor} onCite={() => setShowCitePanel(true)} />
          )}
          <div className="relative">
            <EditorContent editor={editor} />
            {editor && (
              <FootnotePrompt
                editor={editor}
                onAddCitation={() => setShowCitePanel(true)}
              />
            )}
          </div>
          {showCitePanel && (
            /* ... cite panel ... */
          )}
        </div>
```

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`

Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/wiki/FootnotePrompt.tsx src/components/wiki/WikiEditor.tsx
git commit -m "feat: add non-intrusive 'Add reference?' prompt in wiki editor"
```

---

### Task 10: Bibliography rendering — client and server

**Files:**

- Create: `src/components/wiki/Bibliography.tsx`

- Modify: `src/components/wiki/WikiRenderer.tsx`

- Modify: `api/_lib/tiptap-utils.ts`

- Modify: `src/styles/wiki-prose.css`

- [ ] **Step 1: Create Bibliography component**

```typescript
import { useEffect, useState } from 'react';
import { type ReferenceRow, formatReference } from '@/lib/referenceApi';

interface BibliographyProps {
  referenceIds: number[];
}

export function Bibliography({ referenceIds }: BibliographyProps) {
  const [refs, setRefs] = useState<ReferenceRow[]>([]);

  useEffect(() => {
    if (referenceIds.length === 0) return;

    // Fetch each reference by ID — deduplicated
    const uniqueIds = [...new Set(referenceIds)];
    Promise.all(
      uniqueIds.map((id) =>
        fetch(`/api/references?id=${id}`)
          .then((r) => r.ok ? r.json() : null)
          .catch(() => null),
      ),
    ).then((results) => {
      const loaded: ReferenceRow[] = [];
      for (const r of results) {
        if (r?.reference) loaded.push(r.reference);
        else if (r?.references?.[0]) loaded.push(r.references[0]);
      }
      // Order by first appearance in referenceIds
      const idOrder = new Map(uniqueIds.map((id, i) => [id, i]));
      loaded.sort((a, b) => (idOrder.get(a.id) ?? 0) - (idOrder.get(b.id) ?? 0));
      setRefs(loaded);
    });
  }, [referenceIds]);

  if (refs.length === 0) return null;

  return (
    <section className="mt-8 pt-6 border-t border-border">
      <h2 className="text-lg font-semibold mb-3">References</h2>
      <ol className="list-none space-y-2 text-sm">
        {refs.map((ref, i) => {
          const label = referenceIds.indexOf(ref.id) + 1;
          const formatted = formatReference(ref);
          const link =
            ref.type === 'pmid'
              ? `https://pubmed.ncbi.nlm.nih.gov/${ref.identifier}`
              : ref.type === 'doi'
                ? `https://doi.org/${ref.identifier}`
                : ref.type === 'url'
                  ? ref.identifier
                  : null;

          return (
            <li key={ref.id} className="flex gap-2">
              <span className="text-muted-foreground font-medium shrink-0">[{label}]</span>
              <span>
                {formatted}
                {link && (
                  <>
                    {' '}
                    <a
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      Link
                    </a>
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
```

- [ ] **Step 2: Update WikiRenderer to extract footnotes and render bibliography**

Replace `src/components/wiki/WikiRenderer.tsx`:

```typescript
import { useMemo } from 'react';
import { Bibliography } from './Bibliography';
import '@/styles/wiki-prose.css';

interface WikiRendererProps {
  contentHtml: string | null;
  content?: unknown;
}

interface TipTapNode {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
}

function extractFootnoteIds(doc: unknown): number[] {
  const ids: number[] = [];
  function walk(node: TipTapNode) {
    if (node.type === 'footnote' && node.attrs?.referenceId) {
      ids.push(node.attrs.referenceId as number);
    }
    if (node.content) {
      for (const child of node.content) walk(child);
    }
  }
  if (doc && typeof doc === 'object') walk(doc as TipTapNode);
  return ids;
}

export function WikiRenderer({ contentHtml, content }: WikiRendererProps) {
  const referenceIds = useMemo(() => extractFootnoteIds(content), [content]);

  if (!contentHtml) {
    return <p className="text-muted-foreground italic">This page has no content yet.</p>;
  }

  // Inject footnote numbers into the rendered HTML
  let processedHtml = contentHtml;
  let footnoteIndex = 0;
  processedHtml = processedHtml.replace(
    /<sup[^>]*class="footnote-marker"[^>]*data-reference-id="(\d+)"[^>]*><\/sup>/g,
    () => {
      footnoteIndex++;
      return `<sup class="footnote-marker"><a href="#ref-${footnoteIndex}">[${footnoteIndex}]</a></sup>`;
    },
  );

  return (
    <>
      <div
        className="wiki-prose prose prose-sm max-w-none dark:prose-invert"
        dangerouslySetInnerHTML={{ __html: processedHtml }}
      />
      {referenceIds.length > 0 && <Bibliography referenceIds={referenceIds} />}
    </>
  );
}
```

- [ ] **Step 3: Update server-side HTML rendering for footnotes**

In `api/_lib/tiptap-utils.ts`, add a footnote counter and case in `renderNode`:

At the top of the file, add a module-level counter (reset per render call). Update `renderHtml`:

```typescript
export function renderHtml(doc: unknown): string {
  if (!doc || typeof doc !== 'object') return '';
  const node = doc as TipTapNode;
  if (node.type !== 'doc' || !node.content) return '';
  footnoteCounter = 0;
  return node.content.map(renderNode).join('');
}

let footnoteCounter = 0;
```

Add the `footnote` case in `renderNode` before the `default:` case:

```typescript
    case 'footnote': {
      footnoteCounter++;
      const refId = node.attrs?.referenceId ?? '';
      return `<sup class="footnote-marker" data-reference-id="${escapeAttr(String(refId))}"><a href="#ref-${footnoteCounter}">[${footnoteCounter}]</a></sup>`;
    }
```

- [ ] **Step 4: Add footnote CSS**

In `src/styles/wiki-prose.css`, add at the end:

```css
.wiki-prose .footnote-marker {
  font-size: 0.75em;
  vertical-align: super;
  line-height: 0;
}

.wiki-prose .footnote-marker a {
  color: hsl(var(--primary));
  text-decoration: none;
  font-weight: 600;
}

.wiki-prose .footnote-marker a:hover {
  text-decoration: underline;
}
```

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit`

Expected: zero errors.

- [ ] **Step 6: Build check**

Run: `npx vite build 2>&1 | tail -5`

Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/components/wiki/Bibliography.tsx src/components/wiki/WikiRenderer.tsx api/_lib/tiptap-utils.ts src/styles/wiki-prose.css
git commit -m "feat: add footnote rendering and bibliography in wiki pages"
```

---

### Task 11: Update `GET /api/references` to support fetching by ID

**Files:**

- Modify: `api/references.ts`

- [ ] **Step 1: Add ID-based lookup**

In `handleGet` in `api/references.ts`, add support for fetching a single reference by `id` query param (needed by the Bibliography component):

Add at the top of `handleGet`, before the `drugId` check:

```typescript
  const id = Number(url.searchParams.get('id'));
  if (id) {
    const db = getDb();
    const [row] = await db.select().from(references).where(eq(references.id, id)).limit(1);
    if (!row) {
      error(res, 404, 'Reference not found');
      return;
    }
    json(res, 200, { reference: row });
    return;
  }
```

- [ ] **Step 2: Type check and commit**

Run: `npx tsc --noEmit`

```bash
git add api/references.ts
git commit -m "feat: support fetching reference by ID"
```

---

### Task 12: Final integration verification

- [ ] **Step 1: Type check**

Run: `npx tsc --noEmit`

Expected: zero errors.

- [ ] **Step 2: Build**

Run: `npx vite build 2>&1 | tail -5`

Expected: build succeeds.

- [ ] **Step 3: Final commit if any remaining changes**

```bash
git status
```

If clean, no action needed. If there are unstaged changes, review and commit.
