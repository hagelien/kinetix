# Reference & Citation System — Design Spec

**Date:** 2026-04-11
**Status:** Approved
**Goal:** Make all data in Kinetix scientifically traceable by requiring references for parameter edits and enabling low-effort citation in wiki monographs.

---

## 1. Overview

Two interconnected features backed by a shared reference store:

1. **Parameter references** — When a user edits a PK/PD parameter (half-life, Vd, etc.), they must provide a source. This is required, not optional.
2. **Monograph citations** — When writing wiki content, a non-intrusive prompt encourages the user to add Wikipedia-style numbered footnotes `[1]`. A "References" section auto-renders at the bottom.

Both features store citations in the same `references` table. A single paper cited in a parameter edit and a monograph footnote is one row referenced from two places.

---

## 2. Reference Types

Every reference has a `type` that determines how it's stored and displayed:

| Type       | Input               | Auto-fetch metadata?   | Example                                          |
| ---------- | ------------------- | ---------------------- | ------------------------------------------------ |
| `freetext` | Free text           | No                     | "Internal SOP-2024-03, Oslo University Hospital" |
| `url`      | URL                 | No                     | "https://pubchem.ncbi.nlm.nih.gov/compound/887"  |
| `pmid`     | PubMed ID (numeric) | Yes — NCBI E-utilities | "12345678"                                       |
| `doi`      | DOI string          | Yes — CrossRef API     | "10.1007/s00414-023-02965-6"                     |

Auto-fetch resolves: title, authors (list), journal, year, volume, pages. Stored in `metadata` jsonb. If fetch fails, user is prompted to save as freetext instead — never blocked.

---

## 3. Database Schema

### 3.1 New table: `references`

```sql
CREATE TABLE references (
  id            SERIAL PRIMARY KEY,
  drug_id       INTEGER REFERENCES drugs(id) ON DELETE SET NULL,
  type          VARCHAR(10) NOT NULL,  -- 'freetext' | 'url' | 'pmid' | 'doi'
  identifier    TEXT NOT NULL,          -- raw input value
  metadata      JSONB,                  -- auto-fetched: {title, authors, journal, year, volume, pages}
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMP DEFAULT NOW() NOT NULL,
  UNIQUE(type, identifier)
);

CREATE INDEX references_drug_id_idx ON references(drug_id);
```

The UNIQUE constraint on `(type, identifier)` deduplicates — citing the same PMID twice returns the existing row.

`drug_id` is nullable to support non-drug wiki pages citing sources.

### 3.2 Schema change: `drug_parameter_revisions`

Add column:

```sql
ALTER TABLE drug_parameter_revisions
  ADD COLUMN reference_id INTEGER REFERENCES references(id) ON DELETE SET NULL;
```

This is required for new edits (enforced in the API, not as a DB NOT NULL constraint, to avoid breaking existing rows).

### 3.3 No schema change to `wiki_pages`

Monograph citations are stored as TipTap footnote nodes in the `content` jsonb. Each footnote node has a `referenceId` attribute pointing to `references.id`. No additional columns needed.

---

## 4. API Endpoints

### 4.1 `POST /api/references/resolve`

Accepts `{ type, identifier }`. For `pmid` and `doi` types, fetches metadata from external APIs. Returns the resolved metadata for preview.

```typescript
// Request
{ type: 'pmid', identifier: '12345678' }

// Response
{
  metadata: {
    title: "Half-life of metanol in post-mortem blood",
    authors: ["Smith J", "Doe A", "Johnson B"],
    journal: "J Forensic Toxicol",
    year: 2023,
    volume: "45",
    pages: "112-119"
  }
}
```

For `freetext` and `url` types, returns `{ metadata: null }` immediately.

If external fetch fails: returns `{ error: "Could not resolve", metadata: null }`. Client shows fallback option.

### 4.2 `POST /api/references`

Creates a reference row. Checks UNIQUE constraint — if `(type, identifier)` already exists, returns the existing row instead of creating a duplicate.

```typescript
// Request
{ drugId: 42, type: 'pmid', identifier: '12345678', metadata: { ... } }

// Response
{ reference: { id: 7, ... } }
```

### 4.3 `GET /api/references?drugId=X`

Returns all references associated with a drug, ordered by `createdAt`. Used for rendering the monograph bibliography and for showing "sources for this drug" on the preview page.

### 4.4 Changes to `PUT /api/drug-parameter`

The existing endpoint gains a required `referenceId` field in the request body. The API rejects parameter edits that don't include a reference (HTTP 400).

```typescript
// Updated request body
{ value: { min: 2, max: 4, unit: 'h' }, editSummary: "Updated from newer study", referenceId: 7 }
```

---

## 5. External API Integration

### 5.1 PubMed (NCBI E-utilities)

- Endpoint: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id={pmid}&rettype=xml`
- Free, no API key required at <3 requests/second
- Parse XML response for: ArticleTitle, AuthorList, Journal/Title, PubDate/Year, Volume, MedlinePgn

### 5.2 CrossRef (DOI)

- Endpoint: `https://api.crossref.org/works/{doi}`
- Free, no auth required
- Set `User-Agent` header with app name and contact email (CrossRef etiquette)
- Parse JSON response for: title, author, container-title, published.date-parts, volume, page

### 5.3 Error handling

- Network timeout: 5 seconds
- Invalid ID (404): return error, suggest freetext fallback
- Rate limiting: E-utilities allows 3/sec without key, CrossRef allows 50/sec with polite pool
- All fetches happen server-side (the `/api/references/resolve` endpoint), never from the client

---

## 6. Parameter Edit Form Changes

### 6.1 Current state

- `note` field: "Note / citation (optional)" — free text in NumericRange
- `editSummary`: optional text explaining the change

### 6.2 New state

The form gains a required **"Source"** section between the value fields and the edit summary:

```
[ Value fields: min, max, unit, note ]

Source (required)
  [ Text | PMID | DOI ]     ← tab selector, Text is default
  [ ________________________ ]  ← input field
  [ Preview card if resolved ]  ← shows fetched metadata or raw text

Edit summary (optional)
[ ________________________ ]

[ Save ]
```

- **Text tab**: free text input. Accepts anything — URLs, descriptions, "personal communication", etc.
- **PMID tab**: numeric input. On blur/enter, calls `/api/references/resolve`. Shows preview card with title/authors/journal.
- **DOI tab**: text input (e.g. `10.1007/...`). Same resolve-and-preview flow.

If PMID/DOI resolution fails, a message appears: "Couldn't find this ID. Save as free text instead?" with a button to switch to the Text tab with the input preserved.

The `note` field on NumericRange stays as-is for value-context notes ("measured at steady state"). It is separate from the source.

The `editSummary` field stays as-is for change-rationale notes ("Updated based on larger cohort study").

---

## 7. Monograph Editor — Citation Extension

### 7.1 TipTap footnote node

A custom TipTap `footnote` node:

```typescript
{
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,
  attrs: {
    referenceId: { default: null },  // FK to references.id
    label: { default: null },        // auto-assigned: 1, 2, 3...
  }
}
```

Renders as superscript `[n]` in both the editor and the read-only view.

### 7.2 Toolbar button

A `Cite` button in EditorToolbar (after the Image button). Keyboard shortcut: `Ctrl+Shift+R`.

Clicking opens an inline reference input panel (same Text/PMID/DOI tabs as the parameter form). After the user enters a source and confirms:

1. A reference row is created via `POST /api/references`
2. A footnote node is inserted at the cursor with `referenceId` set
3. The label is auto-assigned based on order of appearance in the document

### 7.3 Non-intrusive "Add reference?" prompt

**Trigger:** When the user's cursor moves to a new paragraph after editing the previous one, OR the user pauses typing for 3 seconds after adding/editing content.

**Appearance:** A small floating tooltip near the cursor position:

```
┌─────────────────────────┐
│  📎 Add reference?  [+] │
└─────────────────────────┘
```

**Behavior:**

- Clicking `[+]` opens the reference input panel and inserts a footnote at the end of the paragraph
- The tooltip fades out after 4 seconds
- If the user starts typing, the tooltip disappears immediately
- Only appears once per paragraph edit session (not on every keystroke or cursor move)
- Does not appear on empty paragraphs or headings

### 7.4 Bibliography rendering

The read-only WikiRenderer collects all footnote nodes from the page content and renders a "References" section at the bottom:

```
─────────────────────────────────────────
References

[1] Smith J, Doe A, Johnson B. "Half-life of metanol in post-mortem 
    blood." J Forensic Toxicol. 2023;45(2):112-119. PMID: 12345678

[2] Internal laboratory protocol, Oslo University Hospital, 2024.

[3] https://pubchem.ncbi.nlm.nih.gov/compound/887
─────────────────────────────────────────
```

Each entry is formatted based on type:

- **pmid/doi with metadata**: Authors. "Title." Journal. Year;Volume:Pages. [PMID/DOI link]
- **url**: Clickable link
- **freetext**: Raw text as entered

The bibliography is not stored separately — it's generated from footnote nodes + reference metadata at render time.

### 7.5 Server-side HTML rendering

The `renderHtml` function in `api/_lib/tiptap-utils.ts` renders footnote nodes as `<sup><a href="#ref-N">[N]</a></sup>` inline, and appends a `<section class="references">` block at the end with all cited references. Reference metadata is fetched from the DB during render.

---

## 8. Not In Scope

- Citation style options (APA, Vancouver, etc.) — one consistent format
- Bulk reference import
- Reference manager integration (Zotero, Mendeley)
- Cross-drug reference search ("all drugs citing this paper")
- Reference editing/updating after creation (can be added later)
- Automatic detection of URLs in pasted text to auto-create references

---

## 9. Migration Strategy

- Existing parameter revisions have `reference_id = NULL` — not retroactively required
- New parameter edits require a reference going forward
- Existing monograph content is unaffected — footnotes are additive
- The `NumericRange.note` field continues to work as-is for value context; it is not replaced
