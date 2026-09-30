# Phase 11 — Clinical sign-off as a capability

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
(Phase 11, "Clinical case and explicit expert-signoff targets").

Clinical cases come last because their invariant is not quorum mathematics: a
human with clinical standing must sign one off. The plan asks for that to be
expressed generically —

```text
require human actor
require capability clinical_case_expert
```

— with the Kinetix adapter supplying the risk tag and the capability, rather
than the core knowing what a `clinical_case` is.

**This phase cuts nothing over.** `clinical_case` is not in
`CUTOVER_ELIGIBLE_EDIT_TYPES` and the hardcoded refusal in
`applyOnAgentConsensus` is untouched. §11 says to cut over only after moderator
identity and capability snapshots are reliable and auditable; naming the
capability is the first of those, not the last.

---

## 1. What was missing

Phase 1 already put the rule in the core: `kinetix-consensus@v1` has a
`clinical-case` rule matching the `clinical_case` risk tag and requiring
`humanApprovalWithCapability('clinical_expert')`. Phase 6 confirmed it produced
the right outcome.

Three things made it a declaration rather than a mechanism:

1. **No such capability existed.** The Phase 0 audit recorded it plainly: *no
   `clinical_case_expert` or `moderator` role or capability exists*. Clinical
   cases were governed through `edit.learning.submit`, the same capability as
   any other learning unit.
2. **Nothing mapped Kinetix's permission matrix onto the generic vocabulary.**
   An actor's `assuranceCapabilities` carried only the model tier.
3. **Nothing tagged the content.** `classifyRisk` never returned
   `clinical_case`, so the rule could not match.

---

## 2. What was added

### 2.1 `review.clinicalCase.signoff`

A capability in the `review` group, `defaultTier: 'admin'`,
`floorTier: 'editor'`.

It grants nothing that was not already granted: before this row, no tier could
publish a clinical case through consensus at all, and admins already approve
them by hand through `/review`. The floor is `editor` rather than `contributor`
because the whole point is that this is not an ordinary review — a deployment
with editors who have clinical standing may move it there, and no deployment may
move it below.

**Why name it at all, when the hardcoded refusal already works?** Because the
refusal is safe and not *auditable*. Nothing recorded who was qualified to sign
a clinical case off, so nothing could later show that whoever did was. Naming
the requirement makes it snapshottable: the capability snapshot on an
immutable assessment records that the approver held it at the time — the same
reason `agent_verifications.verifier_tier` exists.

### 2.2 The host mapping

`ASSURANCE_CONFERRING_CAPABILITIES` in `actor-context.ts` maps
`review.clinicalCase.signoff` → `clinical_expert`. This is §4.2's seam: the core
asks for a generic capability, and the host says which of *its* ids mean that.

The map is deliberately narrow. Almost everything in the permission matrix gates
what an actor may **do**; only these say something about what their approval is
**worth**, which is a much stronger claim and one that gets frozen into an
immutable record.

### 2.3 The risk tag

`pendingEditAdapter.classifyRisk` now returns `high` with the `clinical_case`
tag for a clinical case. High rather than medium, because it is the one content
type Kinetix will not publish on consensus at any tally.

That completes the inversion the plan wanted: the core matches on a *tag the
host supplied*, not on a Kinetix edit type it had to be taught.

---

## 3. Exit gate

§11's own gate is operational — reliable, auditable moderator identity and
capability snapshots — and is met by running the system, not by merging this.
What this establishes:

| Requirement | Evidence |
| --- | --- |
| the requirement is a capability, not a hardcoded type | the core rule matches the tag; the adapter supplies it |
| the capability exists and is grantable | registered, defaulting to admin, floored at editor, override checks asserted in both directions |
| granting it confers assurance standing, not just permission | `capabilities` and `assuranceCapabilities` asserted separately |
| it is conferred only by the grant | an editor who may decide edits does not get it |
| nothing is cut over | `CUTOVER_ELIGIBLE_EDIT_TYPES` unchanged; asserted |

`tests/governance/cutover/clinical-signoff.test.ts`, 14 tests.

**What remains:** the snapshots have to be observed as reliable in production
before `clinical_case` could be advanced, and the hardcoded refusal should be
the *last* thing removed — after the generic rule has been shown to refuse the
same cases, not before.

---

## 4. Rollback

Revert the commit. The capability row disappears from the admin matrix (no
override can reference it, since none could have been stored while it defaulted
to admin and nothing enforced it), the assurance mapping goes with it, and
`classifyRisk` returns what it returned before. No behaviour changes either way,
because nothing consumed the tag on a live path.
