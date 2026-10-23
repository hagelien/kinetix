# Anonymous access to public read-only Kinetix functionality

**Status:** Adopted product requirement; initial implementation is intentionally scoped  
**Date:** 2026-10-23  
**Related:** [Mobile UX implementation specification](./2026-10-23-mobile-ux-implementation.md)  
**Applies to:** Desktop web, mobile web and future PWA equally

## 1. Policy decision

**Anonymous users must be able to use all public, non-mutating Kinetix functionality without signing in.** An account is needed for optional persistent actions (creating, submitting, editing, saving, moderation and administration), personalized private server-side data, or deliberate access to restricted/non-public data. A screen must not force login merely because an Edit/Save action is available somewhere on that screen.

Examples of expected guest workflows:

- Find a substance via the drug table or unified search.
- Read published drug monographs, public pharmacological parameters, citations and bioentity information.
- Browse publicly distributable detection windows and general scientific explanation pages.
- Convert concentrations and compare drugs using in-memory/local-only selections.
- Run a pharmacokinetic calculation or simulator **without saving a case to the database**, once its execution path and resource limits are explicitly verified as guest-safe.
- Read published learning material without a personalized learning record, after its response format and copyright/publication scope have been reviewed.

**A read-only HTTP method does not imply publicly releasable information.** Keep unpublished/restricted laboratory documents and cohorts, private draft data, personal cases, review/audit records and sensitive administrative metadata behind their existing permissions unless the data owner explicitly authorizes publication. The policy is *public reads without unnecessary login*, not *publish every database row*.

## 2. Three independent access dimensions

1. **Operation:** Does it change application business state? User-intended editing/submission/saving requires authentication and the appropriate capability. Server-side records of expensive compute jobs, email dispatch and administrative side effects must also be audited.
2. **Data classification:** Is the returned material approved for unrestricted public distribution? If not, read access remains permission-gated even where the operation is a pure GET.
3. **User identity:** Is the response tied to an account (saved scenarios, draft revisions, personalized progress, settings or notifications)? These remain authenticated/private.

Do not equate `GET = public`, `POST = forbidden` or `client-side read-only = harmless`. Some POSTs return a calculated result without persisting business data; some GETs contain protected records, and some innocent-looking UI actions emit background analytics writes.

The server and data-access layer are the security boundary. The frontend must align with the same rule, but removing an `AuthGuard` is never a substitute for verifying the endpoint and response fields.

## 3. Route-by-route baseline and access contract

This is the intended policy plus the initial changes, not a claim that every item has already been implemented.

| Surface | Intended anonymous behavior | Initial status / action |
|---|---|---|
| `/` (drug table) | Public search, read, unit conversion | Already accessible |
| `/wiki` index | Public published pages | **Remove parent route login gate**; API filters published statuses |
| `/wiki/:slug/:tab?` | Published monograph/topic read, sources and public notes | **Open**; API already checks publication |
| `/wiki/drug/:drugId` and `/wiki/entity/:slug` | Public read-only fallback/monograph | **Open** |
| `/wiki/new`, `/wiki/:slug/edit` | Sign-in and relevant authoring capability | **Keep explicitly gated** |
| `/wiki/:slug/history` | Read policy for revisions/diffs needs separate disclosure review | Keep gated initially; may contain unpublished revision text |
| `/references`, `/references/:id` | Public reference lookups where citation is public | Already accessible |
| `/entities` | Public bioentity browse/search and published entity details | **Open**; mutation API stays protected |
| `/detection-times` | Public pooled/cited windows and public components | **Open**; internal laboratory guideline stays gated |
| `/comparison` | Client/local basket and published-drug comparison | **Open**; restricted overlays still gated by their own APIs |
| `/modeling/how-it-works` | Read-only scientific engine description | **Open** |
| `/modeling`, legacy simulator paths | Guest model runs and unit conversions, without saving or private case data | **Follow-up**: audit backend compute side effects, case load/save UX, usage limits and acknowledgment/persistence; currently session gated |
| `/methods`, `/methods/:id`, method basket | Public if individual analytical-method dataset is approved for release | **Follow-up data-owner review**; current methods API and derived method lookups are restricted |
| `/modeling/pattern` | Public where evidence/atlas and case logic are publishable | **Follow-up**: currently provisional/restricted forensic feature |
| `/learn`, `/learn/map`, `/learn/unit/:id` | Published lessons available to guests; no guest progress writes | **Follow-up**: Learn's APIs currently require session/group even for published records |
| `/learn/path` and personalized progress | Guest-local ephemeral mode if built; saved user progress requires sign-in | Keep private until separated |
| `/review`, review/dispute queues | Not anonymously accessible | Private moderation/unpublished submissions |
| `/admin`, user/permissions management | Not anonymously accessible | Admin/privileged |
| `/pdf-inbox`, paper extraction queue, restricted PDF assets | Not anonymously accessible without explicit publication review | May expose unpublished or licensed source material |
| `/preferences` | Guest-local display settings; account settings require sign-in | Route already accessible; retain local preference behavior |

**The initial UI change intentionally does not override the existing API capability floors** for methods, internal lab detection guidelines, unpublished PM cohorts, patterns, or learning units. This prevents an uncontrolled disclosure while the new public-access policy is implemented.

## 4. First implementation slice

Changes in the accompanying PR:

- In `src/router.tsx`, make published wiki browsing, entity browsing, general detection-time lookup, comparison and modeling explanatory documentation public by removing unnecessary whole-route login guards.
- Restore explicit login gates on `/wiki/new`, `/wiki/:slug/edit` and `/wiki/:slug/history` when opening the parent `/wiki` route.
- In `src/components/Header.tsx`, display already-public destinations to anonymous users once the configured nav list has loaded. Preserve methods/pattern authorization logic and hidden nav settings.
- Add `e2e/anonymous-readonly.spec.ts` coverage of public destinations and protected routes.
- Maintain current API-side publication filtering, capabilities, auth controls, and no-store rules for restricted data. Do not change database schemas or calculation code in this PR.

### Compatibility notes

- Do not change or revoke existing user roles or capability overrides.
- Opened routes share the **same** component implementation as signed-in users. The individual page's editing affordances are already capability gated; this PR does not create a new guest UI fork.
- Editor-only links remain usable after login, including preserved `state.from` return navigation if applicable.
- Keep desktop and mobile behavior consistent. The mobile shell's future bottom navigation must not hide public content from a guest.

## 5. Follow-up implementation work packages

**Access PR-A01: Public simulator/compute**
- Inventory which runs happen entirely in the browser and which invoke API, background jobs, quotas, model acknowledgment or run-session persistence.
- Allow guest-local input, execution and export where safe, without calling `/api/simulator/cases` for automatic save/load.
- Gate only the explicit **Save**, server-side case retrieval/share or authenticated personal actions.
- Distinguish local history from account-owned cases; do not make another user's case publicly retrievable by ID.
- Rate-limit expensive anonymous execution server-side. Public access cannot disable compute cost/security controls.
- Test scientific parity, failure modes, and anonymous/nonanonymous handling.

**Access PR-A02: Public published learning content**
- Separate published read APIs from personal progress/attempts/case submission and internal source assets.
- Confirm licensing and that published lesson payloads contain no non-public PDFs/full text/private case details.
- Allow anonymous list/lesson/topic reads; preserve group/capability gates for restricted material.
- Attempt/progress persistence prompts sign-in; optionally offer guest-local progress without writing to server.
- Test direct API GET responses as both guest and privileged user, not merely visible navigation.

**Access PR-A03: Public and restricted scientific dataset classification**
- Inventory all GET/read APIs and field projections for analytical methods, restricted laboratory urine guidelines, postmortem cohorts, pattern atlases, unpublished monographs, pending edits, review/diff/history and source attachments.
- Label each dataset `public-published`, `restricted` or `private-user` and identify its data owner / publication basis.
- If publishable, provide a public-safe projection of only approved fields, rather than dropping a role gate on an internal endpoint.
- Update `src/lib/featureAccess.ts`, `src/lib/permissions.ts`, API enforcement and navigation atomically with explicit approval. Keep restrictive floors until publication is approved.
- Review whether field-level public redaction is needed for individual analytical-method identifiers, unpublished threshold data or other potentially non-public lab information.

**Access PR-A04: Read-side audit, UX and regression hardening**
- Audit `/api/drug-track`: drug opens currently produce anonymous interaction records and update popularity. Decide whether this background database write is necessary/acceptable for public read-only actions; default toward minimal anonymous telemetry and document the decision.
- Audit other read-side implicit writes, remote compute recording, user-owned state and expensive endpoints.
- Ensure every public-friendly screen prompts for sign-in **at the attempted write**, not when viewing published data.
- Verify 401/403 handling with helpful messaging and navigation back to the originating task after login.
- Add feature-matrix, API access, cross-user isolation and mobile E2E tests.
- Verify PWA does not cache authenticated, unpublished or personalized responses for anonymous users.

## 6. Test and security matrix

| Scenario | Expected |
|---|---|
| Guest opens a published monograph, follows citation, converts units | Allowed without login |
| Guest opens a draft/non-published wiki page by direct URL | Not found / forbidden, not leaked via public response |
| Guest browses entities, detection windows or compares published drugs | Allowed without login |
| Guest opens `/wiki/new` or edit route | Login required, no write request |
| Guest sends an unauthenticated mutation directly to an API | 401/403; no persistent change |
| Guest opens restricted lab guideline or unpublished PM data endpoint | Restricted/empty-gated response |
| Guest requests another user's saved modeling case ID | 401/403/404; never disclose the case |
| Guest accesses review queue, unpublished proposals, admin or source PDF inbox | Restricted |
| Account switches from authenticated to anonymous | Existing private client stores reset, private data not rendered |
| Mobile & desktop public navigation | Same permitted content; layout may differ |
| Direct-link guest on wiki detail or reference | URL remains intact; no blanket login redirect |
| Guest runs allowed local calculator, then tries Save | Calculation works; Save requires login and preserves draft where feasible |

Automate role matrix tests for: anonymous, authenticated, contributor, editor, admin, and group-granted users. Add a separate test for a restricted capability raised/lowered by an override, ensuring a public read change does not bypass configured policy.

## 7. Definition of done for the policy

The new policy is **fully implemented** only when all public/published read-only functions, including guest-safe calculations and approved learning views, are accessible without login, with authorized mutations individually gated; all remaining blocked read-only paths have documented confidentiality, ownership, security or computational cost reasons.

The accompanying first PR is **partial implementation**, not a claim that every module is public. Review and deploy through the repository's normal `AGENTS.md` / CI / Codex gate process. Do not self-merge or deploy.

## 8. Implementation sequencing and dependencies

1. First PR: public route/UI unblocking for APIs already designed for anonymous published reads.
2. A01 and A02: open guest computation and published learning when the client/API separation is tested.
3. A03: publish specifically approved restricted datasets with documented public-safe projections, if authorized.
4. A04: eliminate read-side hidden writes where required, strengthen tests, and align all desktop/mobile navigation.

The mobile UX roadmap should treat this access model as a hard requirement, not an optional feature.
