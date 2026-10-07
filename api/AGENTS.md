# API - Vercel Serverless Functions

## Overview

Vercel serverless API using raw `node:http` handlers, not Express. Each file in `api/` is a route. Shared utilities live in `api/_lib/`.

## Route pattern

Every route exports a default handler wrapped in `withErrorHandling`:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, error, withErrorHandling } from './_lib/response';

export default withErrorHandling(async function handler(req, res) {
  // Dispatch by method or ?action= parameter
});
```

Multi-action routes such as `auth.ts` dispatch via `?action=` rather than separate files.

## Shared utilities (`_lib/`)

| File              | Purpose                                                                         |
| ----------------- | ------------------------------------------------------------------------------- |
| `auth.ts`         | JWT sign/verify, cookie helpers, `getUserFromRequest()`                         |
| `db.ts`           | Lazy Drizzle singleton via `getDb()` for Neon PostgreSQL                        |
| `pdf-storage.ts`  | Vercel Blob helpers for citation PDFs: size cap, hashing, `readStoredPdfBytes()` (proxy path, used by both agent reads and share redemption up to `PROXYABLE_PDF_MAX_BYTES`), `presignStoredPdfUrl()` (short-lived redirect path used by both routes for objects over the 4.5 MB function response cap), `recordCitationPdf()` |
| `pdf-share-token.ts` | Signed, ten-minute download tokens for stored PDFs (`citation.pdf.share`); key derived from `JWT_SECRET` under its own label |
| `rate-limit.ts`   | Best-effort in-memory request throttles for abuse-prone endpoints               |
| `response.ts`     | `json(res, status, data)`, `error(res, status, msg)`, `withErrorHandling()`     |
| `schemas.ts`      | Zod schemas for request validation                                              |
| `slug.ts`         | URL slug generation for wiki pages                                              |
| `tiptap-utils.ts` | TipTap JSON to HTML/plaintext conversion for wiki content                       |
| `validate.ts`     | `readBody()` and `parseAndValidate(req, schema)` with a 1 MiB JSON body limit   |
| `mcp.ts`          | MCP/JSON-RPC protocol core, transport-agnostic — `initialize`, `tools/list`, `tools/call` |
| `mcp-pubmed-server.ts` | Composes tools + instructions + identity; both transports build from it so they cannot drift |
| `mcp-stdio.ts`    | stdio transport (`npm run mcp:stdio`). stdout is JSON-RPC only — diagnostics go to stderr |
| `mcp-pubmed-tools.ts` | PubMed tool definitions for that server (see `docs/pubmed-mcp.md`)          |
| `pubmed-eutils.ts` | NCBI E-utilities client: politeness throttle, retries, MEDLINE + JATS parsing  |

## Auth

- JWT is stored in the `__Host-kinetix-auth` httpOnly cookie with SameSite=Lax and Secure. Older `kinetix-auth` and `fjelltox-auth` cookies are not accepted for authentication; they are only cleared on new login/logout.
- `getUserFromRequest(req)` returns `{ userId, role } | null`.
- Magic-link endpoints use best-effort in-memory throttles before DB/auth work. `/api/auth-request` limits repeated sends per email and per client IP, and `/api/auth-verify` limits repeated guesses per email and per client IP while still keeping invalid-code responses generic.
- Roles are `authenticated`, `contributor`, `editor`, and `admin` (in increasing order of privilege; see `src/lib/roles.ts` for `roleAtLeast`/`isReviewer` helpers).
- Role checks go through the capability matrix, not through role literals: `await callerCan(auth.role, CAP['edit.parameter.submit'])` (`api/_lib/permissions-store.ts`). Defaults live in `src/lib/permissions.ts` and match the behavior each route shipped with; admins move them at runtime from Admin → Permissions. Keep the existing status code, message and error `code` when converting a guard. See `docs/permissions.md`.
- Always check auth before DB access on protected routes.
- Wiki pages with `status='published'` are public. Unpublished wiki content and history must return `404` unless the requester is `editor` or `admin`.

## Conventions

- Use `json()` and `error()` helpers instead of writing raw `res.end()`.
- Validate POST bodies with `parseAndValidate(req, schema)`.
- Oversized JSON bodies must fail with `413 Request body too large` before the full payload is buffered.
- Body-reading helpers reject browser requests whose `Origin` host does not match `Host`; keep mutations on `parseAndValidate()`/`readBody()` so the shared CSRF guard applies. `readBodyStream()` skips that guard and exists only for `api/mcp.ts`, where every request carries a bearer token a browser never attaches on its own — there is no ambient authority to protect, and the guard would instead reject legitimate cross-origin MCP clients. Anything that reads the auth cookie must use `readBody()`.
- Wrap every handler in `withErrorHandling()`.
- Use `getDb()` for database access.
- Import the schema from `../../db/schema.ts`.

## Anti-patterns

- Do not use Express middleware or `req.body`.
- Do not create new Zod schemas inline; add them to `_lib/schemas.ts`.
- Do not access `process.env.DATABASE_URL` directly; use `getDb()`.
- Do not return HTML errors; always respond through `json()` or `error()`.

## Agent admin endpoints (issue 319, issue 345)

`api/admin.ts ?resource=agents` and `?resource=agent-hook-runs` cover the agent lifecycle.

| Method/path                                               | Behavior                                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/admin?resource=agents`                          | List all agents (every status) plus linked user + last 5 history rows                      |
| `POST /api/admin?resource=agents`                         | Create agent. Seeds `agent_status_history` with the `null → active` entry                  |
| `PATCH /api/admin?resource=agents&id=N`                   | Edit display fields (name, slug, description, maintainer) and the server-owned grants (`hooksEnabled`, `selfReviewEnabled`, `modelTier`, `adjudicator`, `modelFamily`). Does **not** touch status |
| `PATCH /api/admin?resource=agents&id=N&action=transition` | Audited status change. Body: `{ status, reason? }`. Writes a history row + syncs user role |
| `DELETE /api/admin?resource=agents&id=N`                  | Transition to `deactivated` (terminal). Row retained; backing user demoted                 |
| `GET /api/admin?resource=agent-hook-runs`                 | Recent `agent_hook_runs` rows; `?outcome=` and `?event=` filters, `?limit=` (default 50)   |

## T3 adjudication endpoints

The appellate panel for a disagreement that survives blind T2
(`agents/drug-db-adjudication.md`, `docs/plans/2026-09-18-t3-adjudication-backend.md`).
An adjudicator is an active agent with the admin-set `agents.adjudicator` grant
**and** the `flagship` tier; logic lives in `_lib/adjudication/`.

| Method/path                                        | Behavior                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `GET /api/agent-adjudication-queue`                | Adjudicator: its seated cases and open cases it may claim (identifiers only). Reviewer: `handoffs` for T4   |
| `GET /api/agent-adjudication-queue?caseId=N`       | Case file. A panelist only on its own case, never the other seat's opinions before sealing; a reviewer reads all, handoff included |
| `POST /api/agent-adjudication-queue?action=claim`  | Take a free seat. Body `{ caseId }`. Refuses a conflicted agent (verdict, dispute or target author)        |
| `POST /api/agent-adjudication-opinions`            | Append an opinion for the caller's seat; `final: true` seals it. Both final → compared in code, closed or handed to T4 |

The panelists resolve nothing. When a panel converges on a case resting on
agent disputes only, the seal closes it (`_lib/adjudication/closure.ts`, the
owner's governance decision): both seats approving overrules the agent disputes
(`rejected`, then consensus is retried); both sustaining the objection upholds
them and returns a pending edit to its author, a person's included. A split
scope, a clinical case, a model-structure axis or an approval of a different
value goes to T4 instead. Rows are resolved with `resolved_by = null`, and the
case's `closure` records what was done. A person's dispute is never closed
here.

An overruled or withdrawn agent dispute no longer holds a proposal from
publishing on consensus (`kinetix-consensus@v3`): the gate and the sweep count
only dispute verdicts no ruling has answered since they were raised.

## Feature groups (issue 404)

Admins manage feature-access groups through `api/admin.ts?resource=groups`.
`rettstoks` is seeded by migration 0027 and gates analytical method data
(`/api/methods` plus `/api/drugs?methodId=`). Unauthenticated users and users
outside the group must receive no method data.

All transitions funnel through `transitionAgentStatus` in `_lib/agentHelpers.ts`, which enforces the state machine in `src/lib/agentStatus.ts` and is the only place that should mutate `agents.status`.
