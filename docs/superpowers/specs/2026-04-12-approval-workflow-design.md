# Approval Workflow — Design Spec

**Date:** 2026-04-12
**Status:** Approved
**Goal:** All content changes on the platform require editor/admin approval before going live. Viewers can suggest changes, editors can approve (but not their own).

---

## 1. Roles and Permissions

Three roles on the existing `users.role` column:

| Permission | Anonymous | Viewer (logged in) | Editor | Admin |
|---|---|---|---|---|
| View published content | Yes | Yes | Yes | Yes |
| Suggest parameter edits | No | Yes | Yes | Yes |
| Create/edit wiki pages | No | Yes | Yes | Yes |
| Approve others' changes | No | No | Yes | Yes |
| Approve own changes | No | No | **No** | Yes |
| Manage users/settings | No | No | No | Yes |

**Enforcement:** API-level check. When `role === 'editor'`, reject approval if `reviewedBy === submittedBy`. Admins bypass this check (prevents deadlock with single admin).

---

## 2. Content States

Every content change (parameter edit, wiki page edit, new wiki page) goes through:

```
DRAFT → PENDING_REVIEW → APPROVED / REJECTED
```

- **DRAFT** — submitter still working (wiki pages only; parameter edits skip to PENDING_REVIEW)
- **PENDING_REVIEW** — submitted, awaiting editor/admin review
- **APPROVED** — applied to live content
- **REJECTED** — archived with reviewer's comment, never goes live

### Rules

- Published content stays live and unchanged while revisions sit in PENDING_REVIEW
- Multiple pending edits can coexist for the same target (first approved wins; others get a conflict notice)
- Rejection requires a comment from the reviewer
- Approval requires no comment

---

## 3. Database Schema

### New table: `pending_edits`

```sql
CREATE TABLE pending_edits (
  id              SERIAL PRIMARY KEY,
  edit_type       VARCHAR(20) NOT NULL,  -- 'parameter' | 'wiki_page' | 'wiki_new'
  target_id       INTEGER,               -- drug ID (parameter) or page ID (wiki_page), NULL for wiki_new
  parameter       VARCHAR(60),           -- only for edit_type = 'parameter'
  proposed_value  JSONB NOT NULL,        -- NumericRange (parameter) or full page content (wiki)
  proposed_meta   JSONB,                 -- {title, editSummary, pageType, drugCid, ...}
  reference_id    INTEGER REFERENCES citations(id) ON DELETE SET NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',  -- 'draft' | 'pending' | 'approved' | 'rejected'
  rejection_comment TEXT,
  submitted_by    INTEGER NOT NULL REFERENCES users(id),
  reviewed_by     INTEGER REFERENCES users(id),
  submitted_at    TIMESTAMP DEFAULT NOW() NOT NULL,
  reviewed_at     TIMESTAMP
);

CREATE INDEX pending_edits_status_idx ON pending_edits(status);
CREATE INDEX pending_edits_target_idx ON pending_edits(edit_type, target_id);
CREATE INDEX pending_edits_submitted_by_idx ON pending_edits(submitted_by);
```

### Changes to existing tables

- `wiki_revisions` — add `pending_edit_id INTEGER REFERENCES pending_edits(id) ON DELETE SET NULL`
- `drug_parameter_revisions` — add `pending_edit_id INTEGER REFERENCES pending_edits(id) ON DELETE SET NULL`
- No changes to `wiki_pages` or `drugs` — they only contain approved/live content

---

## 4. API Endpoints

### `POST /api/pending-edits`

Create a pending edit. Accepts:

```json
{
  "editType": "parameter",
  "targetId": 42,
  "parameter": "halfLife",
  "proposedValue": {"min": 4, "max": 6, "unit": "h"},
  "proposedMeta": {"editSummary": "Updated from newer study"},
  "referenceId": 7,
  "status": "pending"
}
```

For wiki edits:

```json
{
  "editType": "wiki_page",
  "targetId": 15,
  "proposedValue": {"type": "doc", "content": [...]},
  "proposedMeta": {"title": "Morfin", "editSummary": "Added pharmacodynamics section"},
  "status": "pending"
}
```

For new wiki pages:

```json
{
  "editType": "wiki_new",
  "proposedValue": {"type": "doc", "content": [...]},
  "proposedMeta": {"title": "NewDrug", "pageType": "drug_monograph", "drugCid": 123},
  "status": "draft"
}
```

Auth: any logged-in user.

### `GET /api/pending-edits`

List pending edits. Query params:
- `status` — filter by status (default: `pending`)
- `editType` — filter by type
- `targetId` — filter by target
- `submittedBy` — filter by submitter (for "my pending edits")

Auth: viewers see only their own. Editors/admins see all.

### `PATCH /api/pending-edits/:id`

Update a pending edit. Used for:
- **Approve**: `{ "status": "approved" }` — only editors (not own) and admins
- **Reject**: `{ "status": "rejected", "rejectionComment": "..." }` — same auth, comment required
- **Cancel**: `{ "status": "rejected" }` — submitter can cancel their own pending edit
- **Update draft**: `{ "proposedValue": {...}, "status": "pending" }` — submitter can update before review

**On approval:**
1. Apply the change to live content (update `drugs` row for parameters, create `wiki_revisions` + update `wiki_pages` for wiki)
2. Record in `drug_parameter_revisions` or `wiki_revisions` with `pending_edit_id` link
3. Set `reviewed_by`, `reviewed_at`
4. Check for conflicting pending edits on the same target — mark them with a `conflict` flag in their `proposed_meta`

**Self-approval guard:** If `role === 'editor'` and `pending_edit.submitted_by === current_user.id`, return 403.

### Changes to existing endpoints

- `PUT /api/drug-parameter` — for viewers and editors, instead of directly updating, creates a pending edit and returns `{ pending: true, pendingEditId: N }`. For admins, continues to update directly (self-approve).
- `POST /api/wiki/pages` and `PUT /api/wiki/pages` — same pattern: viewers/editors create pending edits, admins can choose direct publish.

---

## 5. Review Queue Page

New route: `/review` — accessible to editors and admins only.

### Header badge

The header nav shows a "Review" link with a count badge (e.g. "Review (3)") showing total pending edits. Badge hidden when count is 0. Only visible to editors/admins.

### Queue list

- Sorted by `submitted_at` (newest first)
- Filterable: by type (parameter / wiki / all), by status
- Each item shows:
  - Type icon (parameter edit vs wiki page)
  - Target name (drug name or page title)
  - What changed (parameter name, or "new page" / "edited page")
  - Submitter username
  - Submitted timestamp
  - Action buttons: Approve / Reject

### Review detail

**For parameter edits:** Side-by-side display: current live value → proposed value, plus the attached citation.

**For wiki pages:** Link to preview the proposed content. Diff view: added text highlighted green, removed text highlighted red, against the current published version.

### Inline review

On wiki pages and drug parameter sidebars, editors/admins see a small indicator: "N pending" next to items with pending edits. Clicking opens a compact review panel for that specific item.

---

## 6. Submitter Experience

### Parameter edits (viewers and editors)

- Form UI unchanged (value, source, edit summary)
- Submit button: "Suggest change" (instead of "Save")
- On submit: green toast "Change submitted for review"
- Parameter sidebar shows "Your suggestion pending" in muted text next to that parameter (visible only to submitter)
- Submitter can cancel their pending suggestion

### Wiki page edits (viewers and editors)

- Editor UI unchanged
- Save button: "Submit for review" (instead of "Save Changes")
- On submit: redirected to published page with toast "Submitted for review"
- A "Your pending edit" link appears on the page (visible only to submitter), clicking shows preview
- Submitter can cancel or update their pending revision while it's in review

### New wiki pages (viewers and editors)

- Same creation flow
- Save button: "Submit for review"
- After submit: redirected to wiki home with toast
- Page not visible to others until approved
- Submitter can preview their pending page via "My pending pages" in the review queue

### Editors submitting content

- Same flow as viewers — changes go to PENDING_REVIEW
- They see "Submit for review", not "Save"
- They can also review OTHER people's pending edits (but not their own)

### Admins

- See both "Save & Publish" (bypasses queue) and "Submit for review" (opts into queue)
- Can self-approve

### Status visibility

- No real-time notifications in v1
- Submitter sees status (pending/approved/rejected) when revisiting the page or checking the review queue
- Rejected edits show the reviewer's comment

---

## 7. Not In Scope

- Real-time notifications (email, push, websocket) — can be added later
- Batch approve/reject — one at a time for v1
- Edit conflicts resolution UI — first approved wins, others notified
- Audit log beyond what `pending_edits` + existing revision tables provide
- Approval for drug table column reordering or display settings — those are client-side preferences
