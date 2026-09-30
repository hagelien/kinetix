# Permissions: the adjustable capability matrix

Kinetix has four user tiers — `authenticated < contributor < editor < admin`
(`src/lib/roles.ts`) — plus anonymous visitors. What each tier may do used to be
written into every route and component as a literal (`auth.role !== 'admin'`,
`isReviewer(role)`, …). It is now a **capability matrix**: every gated action is
a named capability with a minimum tier, and an admin can move that tier at
runtime from **Admin → Permissions**.

## The pieces

| Piece | Where | What it is |
| --- | --- | --- |
| Registry | `src/lib/permissions.ts` | The capabilities, their shipped defaults, their floors, and the pure `can()` resolution. Compiled into both bundles. |
| Storage | `permission_overrides`, `permission_override_history` (migration 0091) | Only the **deviations** from the defaults, plus an append-only audit log. A stock install has zero rows. |
| Server | `api/_lib/permissions-store.ts` | Cached loader, `callerCan(role, capability)`, and `applyPermissionChanges` — one transaction per save. |
| API | `api/permissions.ts` | `GET` (public) returns the override map; `GET ?view=admin` and `PATCH` are admin-only. |
| UI | `src/components/admin/PermissionsAdminSection.tsx`, `src/lib/usePermissions.ts` | The editable grid, and `useCan()` for component gating. |

## Rules the matrix cannot break

- **One minimum tier per capability**, so the ladder stays monotone. Granting
  something to contributors necessarily grants it to editors and admins; there
  is no way to punch a hole where a higher tier loses something a lower tier
  has.
- **`floorTier`** is the lowest tier an admin may select. Every write and review
  capability floors at `authenticated` or above, so nothing that mutates
  content can be handed to anonymous callers.
- **`locked: true`** capabilities are not adjustable at all:
  `admin.users.manage` and `admin.permissions.manage`. Both can grant
  privileges, so delegating them would be a way around every other rule.
- **Raising to `admin` is always allowed.** The ceiling is never below the
  default.
- **Unknown ids resolve to admin-only.** A row for a capability a later release
  removed is ignored (`sanitizeOverrides`), and a check against an id the
  registry doesn't know fails closed.

## Adding a capability

1. Add an entry to `CAPABILITY_LIST` in `src/lib/permissions.ts` with the
   default that matches today's behavior, a floor, and the `enforcedAt` hints.
2. Replace the hardcoded check in the route with
   `await callerCan(auth.role, CAP['your.capability'])` — keep the existing
   status code, message and error `code` so clients don't shift under you.
3. Gate the matching UI with `useCan('your.capability')`.
4. Add the label to `admin.permissions.capabilities` in `src/locales/en.json`
   and `nb.json`, keyed by the id with `.` replaced by `_`.

No migration is needed: the table stores deviations, not the registry.

## Two access paths, not one

Analytical methods (`methods.read`), postmortem concentrations
(`pmConcentrations.read`), Rettstoks's own detection times
(`refsDetectionTimes.read`) and Kinetix Learn (`learn.read`) are reachable
**either** through the capability **or** through membership in an
admin-managed feature group (`rettstoks`, `kinetix-learn`). All four
default to the admin tier, which is exactly the old
`role === 'admin' || hasGroup(...)` behavior. The admin UI shows the group as
`alsoGrantedBy` so lowering the tier is visibly not the only way in.

## Saving a change

`applyPermissionChanges` takes the whole batch the admin form submitted and:

1. Validates every row before writing anything, so a stale client naming a
   capability that has since been locked gets the save rejected outright
   rather than half-applied.
2. Writes the batch — override rows and their audit rows — inside one
   `runInPoolTransaction`. A change and the record of who made it commit
   together; otherwise a disconnect between the two statements could leave the
   site's effective permissions changed with no audit entry, and a retry of
   the same save would be a no-op that never recreates it.
3. Invalidates the instance's cache only after the transaction commits.

## Caching and failure behavior

`loadPermissionOverrides()` caches for 5 seconds per warm serverless instance
and is invalidated immediately on write. `callerCan()` skips the read entirely
when it cannot change the answer — an admin holds every capability, and a
caller below a capability's floor can never be granted it — so admin paths and
under-privileged rejections never touch the database.

A failed read is retried (`withDbRetry`, the same transient-blip handling every
other read uses). If it still fails, `callerCan` serves the last matrix this
instance saw — and **denies** if it never saw one. Falling back to the shipped
defaults would be wrong in one direction that matters: an admin may have
*raised* a capability, and the default is then more permissive than the
configured policy. The denial is narrow by construction, because `callerCan`
only reaches the read for callers whose answer an override could change.

"Unreachable" and "not configured" are deliberately distinguished, because
only the first one makes the policy unknown:

| Situation | Meaning | Result |
| --- | --- | --- |
| No store wired up (`db.js` mocked with only the exports a route uses) | nothing to read | defaults |
| No `DATABASE_URL` (a local run) | nothing to read | defaults |
| `permission_overrides` missing (migration 0091 hasn't run here) | no overrides can exist | defaults |
| Query failed after retries | policy unknown | last known matrix, else **deny** |

The third row matters operationally: a database that predates the migration
must not deny every middle-tier action until someone notices. The first is
detected by `resolveStoreAccessors()` — reading an export a mock factory never
defined throws, and that throw is the signal — and the third by Postgres's
`42P01` walked up the driver's cause chain.

Authorization decisions all go through `callerCan` (or `callerCanReadWikiPage`,
which wraps it for draft visibility) so they inherit the deny. Only display
callers — `loadPermissionOverrides`, the public `GET`, and the pure
`canReadWikiPageStatus` helper used in tests — fall back to the defaults.
Keeping unpublished-content checks on the fail-closed path matters: an admin
who raises `wiki.draft.read` is making a confidentiality decision, and a read
failure must not quietly restore the laxer default.

Each capability's row is taken under a transaction-scoped advisory lock before
its `fromTier` is read, so two admins saving the same capability at once can't
both record a transition from the pre-change value. Batches take their locks in
capability order, so two overlapping saves can't deadlock.

A committed save clears the stale-fallback value along with the cache. The
matrix an instance remembers is by definition out of date once a write lands,
so serving it on a later failed read could admit exactly the callers the new
policy was meant to exclude.

The store reads through `getConfigDb()` rather than `getDb()`
(`api/_lib/db.ts`). Same connection — the separate accessor exists so route
unit tests, which queue mocked query results in the exact order a handler asks
for them, are not silently shifted by an infrastructure read. The
stored-override path is covered end-to-end against real SQL in
`tests/integration/permission-overrides.test.ts`.

## When one action needs two capabilities

A few endpoints do more than their name suggests, and the extra work has its
own capability:

- `POST /api/wiki/pages` with a `newDrug` payload creates the catalog drug as
  well as the monograph, so it requires `drug.create` on top of
  `wiki.page.submit`. Approving a `wiki_new` pending edit that carries
  `newDrug` requires the same. The wiki editor disables the save buttons (with
  a reason) when the monograph-create flow would send a `newDrug` payload the
  caller cannot create, and the review card's Approve button follows the same
  rule.
- The same create endpoint turns a `parameters` bag into drug-parameter
  revisions, so carrying one also requires `edit.parameter.submit` — page
  authoring must not be a way around what `/api/drug-parameter` would refuse.
  Approving a `wiki_new` draft that carries one requires it too: the reviewer
  publishes those values, so they need the permission to write them. The same
  sentence now also bars the bag from carrying a **summarizable** parameter at
  all, capability or not: `/api/drug-parameter` refuses an authored value for
  those (409 `parameter_entry_backed`), so `validateParameterBag` refuses one
  too and points at `/api/parameter-entries`, where each source's reading goes.
- Deciding on your **own** pending edit needs `review.edit.decideOwn` (default
  `admin`) *on top of* `review.edit.decide` — the second capability is the
  waiver of "a second pair of eyes", not a substitute for being a reviewer at
  all, so lowering it to `editor` still only reaches editors who may moderate.
  Withdrawing your own proposal is unaffected and needs neither: the submitter
  path (`status: 'rejected'` with no payload change) is a different act. See
  "What is deliberately not adjustable here" for the two rules that survive the
  waiver.
- The self-service PDF upload files its own request before uploading, so that
  affordance needs `pdfRequest.create` as well as `citation.pdf.access`;
  fulfilling a request an agent already opened needs only the latter.
- `GET /api/admin?resource=users` also backs the group-membership picker, so
  it is readable with `admin.groups.manage` as well as `admin.users.manage` —
  otherwise a delegated group manager gets a picker with nobody in it. Changing
  a user's role still requires `admin.users.manage`.
- `PUT /api/wiki/pages` falls back to the stored content when the body omits it,
  which would copy a draft into a pending edit its submitter could read back.
  Whole-page submission and draft reading are separate capabilities, so that
  branch checks `callerCanReadWikiPage` and 404s exactly as the read path does.
- Every path that can reach an unpublished page checks `wiki.draft.read`, not
  just the read routes: the queued PUT branch, the direct PUT branch (which
  could otherwise rewrite or publish a hidden draft), DELETE (which resolved
  by slug without ever loading the status), and the review queue's enrichment,
  which hydrates wiki targets with the page's current body and would hand a
  draft to anyone holding `review.queue.readAll`.
- `PATCH /api/drugs` accepts `molecularWeight`, which lands in
  `drug_parameters` and triggers the same recomputes, so it requires
  `edit.parameter.submit` as well as `drug.update`.
- Replacing a paper's stored full text is `citation.pdf.replace`, separate from
  `citation.pdf.access`, because a swap discards the previous asset. All three
  paths that can perform one carry it — opening the replacement request
  (`POST /api/pdf-requests` with `replace`), the server-fetch fulfilment, and
  the client-upload fulfilment — or the gate would last only until the request
  row exists.
- The bulk PDF drop-off splits into two capabilities because it splits into
  two acts. `pdfInbox.upload` takes bytes with **no citation named**, which is
  the same act as supplying full text one paper at a time and carries the same
  tier (contributor); it grants nothing about which paper those bytes are.
  `pdfInbox.resolve` is the second act — saying which citation an inbox PDF
  belongs to, and discarding one that belongs to none — and is contributor for
  the same reason: attaching produces exactly the state a contributor already
  produces by uploading from a reference page (a `citation_pdfs` row plus a
  fulfilled request). Neither is authority to **replace** full text already on
  file. That check stays `citation.pdf.replace`, resolved for the caller on
  `POST /api/pdf-inbox` and passed down to the attach, so a contributor cannot
  reach through the bulk path a transition the single-file path refuses them.
  The unattended path is narrower still: an automatic attach happens only for
  an identifier read from the document itself that resolves to exactly one
  citation with no full text on file, and the `autoAttach` sweep passes
  `mayReplace: false` unconditionally — a bulk action is the last place to let
  an editor's grant apply silently to fifty papers.
- `citation.pdf.access` is not a download permission for people. It gates
  *supplying* full text (`POST /api/citation-pdf`, `/api/citation-pdf-upload`),
  and `GET /api/citation-pdf` — the read-back — additionally requires the
  caller to back an **active agent**. Serving a stored publisher PDF to a
  human is redistribution of licensed material that nothing in the product
  needs: a reader follows the citation's own source link, which every
  reference page renders. What the stored bytes are for is the machine read
  the review and extraction agents perform, so that is the only caller left.
  The check is not a tier — an admin is refused too — and it runs *after* the
  capability check, so narrowing `citation.pdf.access` still shuts the bytes
  off for agents as well.
- Handing a stored PDF to someone with **no account** is `citation.pdf.share`,
  and it is the only capability that mints a credential rather than spending
  one. `POST /api/citation-pdf-share` returns a signed, ten-minute URL that
  `GET /api/citation-pdf-share` redeems with no session at all — serving the
  bytes from kinetix.no for a paper that fits a function response, and falling
  back to a 60-second presigned Blob URL only for one that does not — so the
  tier
  that holds it decides what leaves the site — hence `admin` by default, above
  the `contributor` tier that may merely supply the same bytes. It is now the
  *only* way a person gets a stored PDF out of Kinetix, which is the point:
  one deliberate, logged, expiring act rather than a standing download. Its floor is
  `contributor` rather than `authenticated`: delegating it to everyone who
  registers would make the whole PDF corpus effectively public, and the matrix
  must not be able to express that. Each link names one citation and carries a
  prefix of that citation's stored SHA-256, so replacing the full text
  (`citation.pdf.replace`) invalidates every outstanding link for it — which,
  with the expiry, is the whole of the revocation story. Minting requires
  `citation.pdf.access` **as well**: the two capabilities carry independent
  overrides and their ranges overlap, so checking only the share grant would
  let an admin who raised the read tier to `admin` and delegated sharing to
  `contributor` hand contributors a link they could read through — a public
  link is a superset of reading, never a way around it. The UI mirrors the
  conjunction so the button and the endpoint agree.
- The paper-extraction queue splits three ways: `paperExtraction.queue.read`
  admits you to the queue page, `paperExtraction.manage` covers enqueueing and
  steering (cancel, requeue), and `paperExtraction.claim` is the contributor
  tier the scheduled agent runs at, scoped to its own rows. The page renders
  only the buttons the caller holds, so lowering the read capability alone
  hands out a read-only queue rather than a broken one.
- The side-effect checks apply on **three** paths, not two: create, approve,
  and the submitter's resubmit of a returned draft. A draft written before a
  policy tightened must not be pushable back into the queue by someone a fresh
  submission would refuse.
- `/wiki/:slug/edit` hosts two workflows (atomic facts and the whole-page
  editor) with two capabilities, so the route admits either one
  (`requiredAnyCapability`) and the editor shows only the saves the caller
  holds.

Whenever you add a side effect like that, gate it on the capability the
dedicated endpoint uses — otherwise delegating the outer capability quietly
hands out the inner one. The UI mirrors each pair, so no affordance leads to a
403: a control follows the capability of the endpoint its *save* hits, and a
link follows the capabilities of the route it opens.

## What is deliberately not adjustable here

- **Reading published content** is listed in the matrix as a locked, public row.
  Public GETs are served through the shared CDN cache; tier-gating them would
  need the cache policy to change with the matrix, which is a separate piece of
  work.
- **Agent tokens** are clamped to `editor` at authentication
  (`api/_lib/auth.ts`), whatever their backing user's role says. Capabilities
  apply on top of that clamp, so no matrix change can give an agent token
  admin-tier access.
- **Approval stamps** on your own content stay blocked for everyone, admins
  included (`isSelfApproval` in `api/approvals.ts`). A stamp is a voluntary
  signature saying someone else read this; a signature you give yourself says
  nothing, so there is no tier at which it becomes meaningful.
- **Deciding on your own pending edit** *is* adjustable — `review.edit.decideOwn`,
  default `admin` — because the queue's job is to make sure a proposal is read,
  and on a deployment whose only reviewer is the admin who wrote it there is
  nobody left to read it. Two rules survive the waiver, in
  `PATCH /api/pending-edits`, and neither is a tier:
  - An **open dispute** blocks the self-decision (`self_decision_blocked_by_dispute`),
    whoever the author is. A moderator may overrule an objection — that
    judgment is what a moderator is for — but not when the moderator is the
    party it was raised against. Resolve the dispute first, as its own
    recorded act, then approve.
  - An **agent** never reaches the grant. Agent self-review stays the
    per-agent `agents.self_review_enabled` switch, one agent at a time; the
    matrix row is for humans and excludes agent callers explicitly, so
    lowering it to `editor` cannot hand every agent at once what that switch
    exists to hand out deliberately.
