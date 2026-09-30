# §22 — The rollback playbook, rehearsed

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
§22.

§22 says *"every authoritative phase must have a documented rollback before it
is enabled"* and then names four levels and a six-step rehearsal. Three levels
existed. One did not, and the rehearsal was prose nobody had executed.

---

## 1. The four levels

| Level | Action | Status |
| --- | --- | --- |
| 1 | retreat the target's migration state | existed since Phase 4; rehearsed here |
| 2 | `KNOWLEDGE_GOVERNANCE_FORCE_LEGACY=1` | existed since Phase 4; rehearsed here |
| 3 | revert the commit | git; each phase doc names its own revert |
| 4 | **data repair** — rebuild generic mirrors from legacy state | **did not exist** |

Level 4 is the gap this closes. The reconciliation scanner has *detected*
divergence since Phase 4 and nothing rebuilt it, so the playbook's fourth level
was a sentence describing a capability the system did not have.

---

## 2. The rule that shapes the repair module

> Do not delete generic history as part of rollback. Mark erroneous generic
> records superseded/invalid where necessary.

**Nothing in `repair.ts` deletes.** The reason is stronger than the
instruction: the generic tables are an append-only audit, and a repair path that
could delete would be a repair path someone could use to remove an inconvenient
assessment. The only operations available are re-mirroring what is missing and
recording an audit event about what cannot be repaired.

So repair is deliberately incomplete, and says which findings it will not touch
rather than pretending to have fixed them:

| Finding | Repairable | Why not |
| --- | --- | --- |
| `missing_proposal` | yes | legacy is the source of truth during migration |
| `missing_assessment` | yes | same |
| `orphaned_proposal` | no | the legacy row is gone, and an immutable record of a review that happened does not stop having happened because someone deleted the row it mirrored |
| `fingerprint_mismatch` | no | re-mirroring would overwrite the generic side with the legacy one without anyone deciding that was right |
| `state_mismatch` | no | same |
| `missing_publication` | no | manufacturing one would claim this engine published something it did not |

An unknown finding class — one added later with no repair rule written — is
reported as needing a human rather than assumed harmless. The safe default for
something nobody has reasoned about is to leave it and say so.

**It defaults to a dry run.** A repair tool that writes by default is one
someone runs to "have a look" and then has to explain, in the middle of an
incident, on a day that is already bad.

**It delegates to the same mirror functions the live seams use.** A repair path
with its own inserts is a second writer that can drift from the first, and the
divergence it would then produce is exactly what it exists to fix.

---

## 3. The rehearsal, executed

§22's six steps, run end to end against the PGlite harness:

1. create a pending edit — status `pending`
2. run the generic shadow path — reconciliation clean
3. switch `pending_edit:wiki_fact` to `generic_authoritative`
4. verdict and apply through the generic path — `applied`
5. switch back to `legacy_only`
6. confirm the old API can still inspect and continue

Step 6 is the one worth stating precisely. The `pending_edits` row is what the
moderator UI and admin tooling read, and after a generic publication it is
stamped exactly as a legacy approval would have stamped it — `approved`, with
`reviewed_by` set. The generic history survives the rollback too, which is §22's
"do not delete generic history" observed from the other side.

A second test covers the half that matters most operationally: after retreating,
an ordinary consensus publishes again through the path it used before the
cutover existed.

---

## 4. Exit gate

| §22 requirement | Evidence |
| --- | --- |
| level 1 rollback works at runtime | rehearsal step 5, and a separate legacy-publish test |
| level 2 overrides an advanced target | asserted with the kill switch set |
| level 4 exists | `repairMirrors`, rebuilding from legacy through the live mirror functions |
| repair deletes nothing | proposal count asserted unchanged across a repair run |
| an orphan is left alone | asserted, with the proposal still present |
| the rehearsal has been run | six steps, end to end |

`tests/governance/rollback/rehearsal.test.ts`, 9 tests.

**What this does not establish:** the rehearsal ran against a test database, not
a staging environment. §22 asks for step 3 to happen "in staging", and that
needs a staging environment and someone to point it at.

---

## 5. Rollback

Delete `repair.ts` and `tests/governance/rollback/`. Nothing imports them; the
repair path has no caller and is invoked by hand.
