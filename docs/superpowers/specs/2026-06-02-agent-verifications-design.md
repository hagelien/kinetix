# Agent-to-agent verification

Status: draft (2026-06-02)

## Motivation

Kinetix already has multiple scheduled contributor agents — `kinetix-agent`
(monograph + parameter curator), `reflink-agent` (reference checker), the
paper-review agent, etc. Each agent independently produces content (pending
edits, paper reviews, monograph facts). Today the only check on agent output
before it reaches users is a human moderator on `/review`.

We want agents to verify _each other's_ work — read another agent's output,
form an independent judgment, and record an approve / dispute / abstain
verdict with rationale and evidence. Human moderators stay in the loop and
keep the final word on every pending edit; agent verdicts re-rank the queue
and decorate it with badges so moderators can prioritise items the agents
have flagged.

## Targets

A verification is keyed by a polymorphic `(targetType, targetId)` pair, reusing
the same enum the existing `approvals` table uses, extended with one new value:

- `wiki_revision` — approved monograph edit
- `drug_parameter_revision` — approved parameter edit
- `paper_review` — approved paper review
- `drug_discussion` — discussion comment
- `pending_edit` — **new**; lets agents verify edits while they are
  still in the moderator queue, so verdicts can re-rank `/review`

## Verdict shape

```
verdict     ∈ { approve, dispute, abstain }
rationaleMd : short markdown (required for dispute/abstain ≥ 20 chars; optional
              for approve; '' for implicit-approve rows)
evidenceRefs: [{ citationId?: number, quote?: string, url?: string }]
model?      : string (e.g. 'claude-opus-4-7')
is_implicit : boolean — true for the auto-row written when the agent itself
              submitted the target (see "Implicit approve" below)
```

`UNIQUE (agent_id, target_type, target_id)` keeps one verdict per (agent,
target). Re-submission overwrites in place — same pattern as the
`pending_edits_open_paper_review_idx` partial unique index used by paper-review
submissions.

## Independence rules (enforced server-side)

1. **No self-verification.** Reject if the target's `createdBy` (resolved per
   target type) equals the agent's `users.id`. Returns 403
   `agent_verification_self_not_allowed`.
2. **Implicit approve.** When an agent submits content (pending edit, paper
   review, direct parameter write), the server writes a row with
   `verdict='approve', is_implicit=true, rationale_md=''` against the
   resulting target. Combined with rule (1) this models the chosen rule —
   _"the initial action where an agent adds or edits content counts as one
   review approval"_ — without special-cases later.
3. **One verdict per (agent, target).** Enforced by the unique constraint;
   re-submission goes through `ON CONFLICT DO UPDATE` and bumps the
   updated_at.
4. **Echo-chamber guard.** The `/api/agent-verifications/queue` response and
   the `/api/agent-verifications` POST never include other agents' verdicts
   or approval counts for the target being judged. This matches the existing
   guardrail documented in `api/_lib/approvals.ts` (_"agentic evaluations of
   facts must NOT consume the approval count"_) and extends it to verdicts.

No declared-scope restriction in v1 — any agent can verify any target type.

## Endpoints

### `GET /api/agent-verifications/queue`

Pull-based discovery for an agent.

| query           | default | notes                                       |
| --------------- | ------- | ------------------------------------------- |
| `targetType`    | any     | one of the five target types                |
| `limit`         | 20      | cap 100                                     |
| `minAgeMinutes` | 5       | gives the implicit-approve row time to land |

Returns up to `limit` targets the agent has not yet verified and did not
author. The response includes the **target payload** the agent needs to form a
judgment (e.g. for a parameter revision: old + new value, references, drug
name) plus `targetVersion`, an ISO timestamp the agent must echo when posting
its verdict. It explicitly omits other agents' verdicts and approval counts.

Auth: any active agent (matching active `agents` row).

### `POST /api/agent-verifications`

Submit a verdict.

```json
{
  "targetType": "drug_parameter_revision",
  "targetId": 1234,
  "targetVersion": "2026-06-02T12:34:56.000Z",
  "verdict": "dispute",
  "rationaleMd": "Half-life of 8h conflicts with Karch (2008) Table 3.2, which gives 12–16h…",
  "evidenceRefs": [
    { "citationId": 9876, "quote": "Mean half-life 14.2h (range 12–16)" }
  ],
  "model": "claude-opus-4-7"
}
```

Validation:

- Active agent required (403 if not).
- `rationaleMd` ≥ 20 chars for dispute/abstain; optional for approve.
- `evidenceRefs[].citationId` must resolve to a real citation.
- Target must exist and be visible (re-uses `visibleTargetIds` from
  `api/approvals.ts`, extended for `pending_edit`).
- `targetVersion` must match the current target timestamp; stale verdicts are
  rejected with `agent_verification_target_version_stale`.
- Self-target rejected with 403.

Writes via `ON CONFLICT DO UPDATE` and appends a row to `verification_log`
(reusing the existing audit trail — `targetType='peer_verification'`).

### `GET /api/agent-verifications`

Public read for the UI.

- `?targetType=…&targetId=…` → full verdict list + agent profile per row
- `?targetType=…&targetIds=1,2,3` → batch summary (count + verdict tally) per
  id, capped at 200 ids per request. Mirrors the shape of
  `/api/approvals?targetIds=…`.

Visibility: same `visibleTargetIds` rule as `/api/approvals`.

## Implicit-approve hooks

We add `recordImplicitAgentApproval` in `api/_lib/agent-verifications.ts` and
call it from:

- `api/paper-reviews.ts POST` — write against the pending-edit target so the
  same row carries forward to `applyApprovedEdit`.
- `api/pending-edits.ts POST` — when the submitter is an agent, write against
  the resulting `pending_edit` row.
- `applyApprovedEdit` — when the resulting revision row's `createdBy` is an
  agent, write against the new revision row id (matches existing
  `recordApproval` calls in the same code path).

Each call is idempotent via the unique constraint.

## Effect on the moderator queue

The pending-edits list endpoint joins `agent_verifications` and exposes a
per-row summary:

```ts
verifications: {
  approveCount: number; // explicit approvals (excludes is_implicit)
  disputeCount: number;
  abstainCount: number;
  implicitApproveCount: number; // for display "submitted by agent X"
}
```

The `/review` page reads this summary to:

1. Show a small badge row (green checkmark + count, red flag for dispute).
2. Sort: items with ≥1 dispute float to the top; items with ≥2 independent
   approves and zero disputes sink to the bottom (so moderators can skim them
   fast). The default sort still respects submitted-at as a tiebreaker.

No auto-approval. Every pending edit still requires a human click on
`/review`. The change is advisory.

## Data model

```sql
CREATE TABLE "agent_verifications" (
  "id"            SERIAL PRIMARY KEY,
  "agent_id"      INTEGER NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "target_type"   VARCHAR(40) NOT NULL,
  "target_id"     INTEGER NOT NULL,
  "verdict"       VARCHAR(20) NOT NULL,
  "rationale_md"  TEXT NOT NULL DEFAULT '',
  "evidence_refs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "model"         VARCHAR(60),
  "is_implicit"   BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at"    TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at"    TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX "agent_verifs_unique_idx"
  ON "agent_verifications" ("agent_id", "target_type", "target_id");
CREATE INDEX "agent_verifs_target_idx"
  ON "agent_verifications" ("target_type", "target_id");
CREATE INDEX "agent_verifs_target_dispute_idx"
  ON "agent_verifications" ("target_type", "target_id")
  WHERE "verdict" = 'dispute';
```

`target_type` and `verdict` are varchar (project convention — no native PG
enums); Zod validates at the API edge.

## Testing

- Unit tests for the verdict helper (`recordVerification`, idempotent upsert,
  self-target rejection, implicit-approve flag).
- Route tests for `/api/agent-verifications` (POST + GET) including the
  self-target 403 and the unique-constraint upsert path.
- Queue test: agent A submits → agent A does not see it in its queue; agent B
  sees it; once B verifies, B no longer sees it.
- Echo-chamber test: queue response and POST 200 body contain zero verdict
  data for the target.
- Pending-edits list test: verification summary shape and the
  dispute-floats-to-top sort.

## Out of scope (follow-ups)

- Hook-driven push (low-latency variant of discovery). The pull queue is the
  v1 mechanism; hooks can layer on later by reusing `agentHooks.ts`.
- Declared-scope per agent (e.g., reflink-agent only verifies `paper_review`).
  Looser is fine for v1; we can add a scope column later.
- Auto-approve threshold. Explicitly off the table for v1 — humans approve
  every pending edit. Revisit when we have data on agent agreement rates.
