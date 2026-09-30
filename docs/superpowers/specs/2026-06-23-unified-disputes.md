# Unified disputes + in-app notifications

Status: implemented (backend + agent feed). Frontend inbox/dispute-button: follow-up.

## Goal

Anyone — humans *and* agents — can dispute a fact or parameter; everyone who
should care is notified; and agents have a **deterministic** way to enumerate
all open disputes each cycle.

Before this, only active agents could record a `dispute` (via a peer-review
verdict in `agent_verifications`); humans could only reject/return from
`/review`. There was no notification on dispute and no agent-facing "list all
disputes" endpoint.

## Data model — bridge, not rewrite

A new canonical `disputes` table records *contestations* (human or agent),
separate from `agent_verifications` (which also carries approve/abstain and
drives consensus):

- `disputes(id, target_type, target_id, created_by, source, reason_md,
  evidence_refs, status, resolution, resolved_by, resolved_at, …)`
- Partial unique index `(target_type, target_id, created_by) WHERE status='open'`
  → at most one open dispute per author per target; re-disputing updates it.

**The consensus engine is unchanged.** Agent dispute *verdicts* still live in
`agent_verifications` and still block `meetsConsensusApprovalQuorum`. We bridge:

- An agent `dispute` verdict (POST `/api/agent-verifications`) additionally
  mirrors an `source='agent'` row into `disputes`; flipping to approve/abstain
  withdraws it. So `disputes` is the single enumerable source of truth.
- A **human** dispute lives only in `disputes`, so the consensus auto-apply path
  gets an extra guard: `hasOpenDispute(pending_edit, id)` blocks the apply even
  when the agent approval tally would otherwise clear. The `/review` queue boost
  and rank also read `disputes` so a human dispute floats its edit to the top.

## Endpoints

- `GET /api/disputes[?targetType=&limit=&offset=]` — deterministic open-dispute
  feed, oldest-first (`created_at ASC, id ASC` — total, stable order).
  Active-agent or reviewer only. **This is how agents are "notified":** they
  poll it each cycle. No webhook/push infra.
- `POST /api/disputes {targetType, targetId, targetVersion, reasonMd, evidenceRefs?}`
  — open or refresh a dispute. Contributor+ humans and active agents.
  Visibility-gated like agent verifications. `targetVersion` is the same
  `verificationTargetVersion` token POST /api/agent-verifications validates;
  a mismatch (the target moved since the caller read it) is rejected with 409
  `dispute_target_version_stale` rather than binding the dispute to content
  its author already revised away from (issue 1321). Fans out notifications on
  first raise.
- `PATCH /api/disputes?id=N {resolution}` — reviewer closes a dispute
  (`upheld | rejected | withdrawn`). Fans out a `dispute_resolved` notice.
- `GET /api/notifications[?unread=1&limit=N]` — caller's inbox + unread count.
- `PATCH /api/notifications {ids?|all?}` — mark read (own rows only).

## Notification policy

In-app only (no email, by decision). On a dispute open/resolve, fan out to the
**target author ∪ all reviewers/admins, minus the actor**, de-duplicated
(`disputeNotificationRecipients`). Agents are not pushed to — they pull the
feed.

## Follow-ups (not in this PR)

- Frontend: a notification bell + inbox dropdown, and a "Dispute" action on the
  fact/parameter verification badge.
- Agent prompt wiring: have the maintainer poll `GET /api/disputes` as a
  first-class step (documented in `agents/peer-verification-protocol.md`).
