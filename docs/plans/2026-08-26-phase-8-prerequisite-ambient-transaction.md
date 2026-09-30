# Phase 8 prerequisite — legacy apply helpers join the ambient transaction

Companion to `docs/plans/2026-08-26-general-knowledge-governance-extraction.md`
§12.3.1 and §16.6, and the stated prerequisite of Phase 8 ("First authoritative
cutover"):

> Authoritative cutover cannot start until every legacy helper on the chosen
> target's apply path uses `inTransaction()` rather than `runInPoolTransaction`,
> with the connection-identity tests from 16.6 green for that path. This is a
> separate, shippable, behaviour-preserving PR that lands **while legacy is
> still authoritative** — not a change made under a live cutover.

This is that change. It is behaviour-preserving and it moves no target type.

---

## 1. The failure it prevents

An adapter's `apply()` will open the unit of work at the top. Today
`applyApprovedEdit` and the parameter write paths call `runInPoolTransaction`
unconditionally, and nesting that is **not** a nested transaction: it opens a
fresh Neon Pool on a *different connection*.

The approval path takes transaction-scoped drug advisory locks
(`pg_advisory_xact_lock`) and a `FOR NO KEY UPDATE` row lock on `pending_edits`;
the parameter and parameter-entry paths do the same. So the inner connection
would block on locks the outer connection holds while the outer awaits the
inner — a **hang until timeout**, not an error. That is the failure
`inTransaction()` was introduced for, after it took down the
monograph-creation path.

`inTransaction` joins an ambient transaction and opens one when there is none,
so every existing endpoint behaves exactly as before.

---

## 2. What changed

| File | Change |
| --- | --- |
| `api/_lib/pending-edits-helpers.ts` | `applyApprovedEdit` joins instead of opening |
| `api/drug-parameter.ts` | all three write units join |
| `api/parameter-entries.ts` | all seven write units join |

One import and one identifier per file. No lock order changed, no statement
moved: the ABBA hazard the approval path already navigates (advisory locks
before row locks, matching the merge fold) is untouched, because this changes
only *who opens the transaction*, never what happens inside it.

---

## 3. Why "it ran in a transaction" is not the test

This is the one property in the migration the integration harness cannot detect
by ordinary means. Under PGlite everything routes through a single connection,
so a nested `runInPoolTransaction` degrades to a savepoint:

- `txid_current()` matches on both sides,
- `pg_backend_pid()` matches,
- advisory locks are re-entrant,
- a rollback test passes.

Every reassuring signal is available on precisely the code that opens a second
Pool in production. A green suite would mean nothing.

The assertion that **does** discriminate is client object identity.
`inTransaction` hands the inner helper the same `getDb()` object; a nested
`runInPoolTransaction` allocates a fresh transaction client and a fresh
`txStorage` context even on PGlite, so the objects differ. That survives the
savepoint degradation, and it is what ships:

- `inTransaction` inside an ambient transaction returns the **same object**
  (`toBe`, not `toEqual`);
- the ambient client differs from the base client, so "same object" is a real
  claim about joining rather than something that holds regardless;
- `inTransaction` outside a transaction still opens one, which is what keeps the
  conversion invisible to existing endpoints;
- a static sweep asserts the three converted files no longer call
  `runInPoolTransaction`, and that nothing under
  `api/_lib/knowledge-governance/` ever does (§12.3.1 rule 5) — with a
  guard-the-guard test so a moved directory fails loudly instead of sweeping
  nothing;
- a rollback test shows the inner write is undone with the outer transaction.

### The negative control is documented, not executed

Nesting `runInPoolTransaction` inside itself is the production bug's exact shape
and the obvious control — but running it under this harness **hangs**. PGlite
has one connection, and the inner call issues a second top-level `BEGIN` on it
rather than a savepoint, so the test never returns and CI reads a timeout rather
than a failure.

That hang is itself evidence for the conversion. What ships instead fails fast
and says why. §16.6 reserves the real deadlock exercise — governance
transaction holds the drug advisory lock, legacy helper requests it, assert the
test completes and `pg_backend_pid()` matches — for a real-Postgres run, which
this repository does not currently have a harness for.

---

## 4. What this does *not* do

It does not start Phase 8. No target type is advanced, no adapter gains an
`apply()`, and the generic engine still decides nothing. This is the groundwork
that has to be in place, and proven, before an authoritative cutover is a safe
thing to attempt.

---

## 5. Rollback

Revert the commit. Three identifiers change back and the behaviour is identical
either way while nothing opens an ambient transaction around these helpers —
which nothing does yet.
