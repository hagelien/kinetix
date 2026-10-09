/**
 * Which committed migrations the build-time runner has to apply by hand,
 * because drizzle's migrator will never look at them again.
 *
 * `drizzle-orm/neon-http/migrator` decides what is pending from exactly one
 * number: the newest `created_at` in `drizzle.__drizzle_migrations`. A journal
 * entry runs only if its `when` is greater than that high-water mark. There is
 * no per-migration memory anywhere in the comparison — a migration that never
 * ran is indistinguishable from one that did, as long as something newer
 * recorded after it.
 *
 * That holds fine while every recording happens in journal order, which is the
 * case when the production deploy is the only writer. It stops holding the
 * moment any runner points at this database from a tree that is MISSING an
 * earlier migration — a branch cut before that migration merged, a rollback, a
 * local `npm run db:migrate`, a preview build. The later migration records, the
 * mark jumps past the earlier one, and the earlier one is unreachable forever:
 * every subsequent deploy prints "Applying any pending migrations… Done." in a
 * few hundred milliseconds, the schema change never lands, and the code that
 * depends on it ships anyway.
 *
 * This is not a hypothetical. `0125_agent_focus_skip_wiki_content` was lost
 * exactly this way. The deploy was green, the column was absent, and every
 * request that read `agent_focus_config` — the admin focus pane, the agents'
 * parameter-gap queue, and every wiki edit submitted through
 * `POST /api/pending-edits` — returned 500 for a full day before anyone could
 * see why.
 *
 * `tests/drizzle-migration-statements.test.ts` already guards the shape this
 * file cannot: that journal timestamps increase strictly, so the repo never
 * *authors* an entry behind the mark. This closes the other half — an entry
 * authored in order that some other writer left behind.
 *
 * **Identity here is the journal timestamp, not the file hash.** Every writer
 * on this path (the baseline seeder, the non-transactional applier, drizzle's
 * own migrator) stores the entry's `when` in `created_at`, and timestamps are
 * unique and strictly increasing, so the number identifies the entry exactly.
 * The hash cannot: AGENTS.md deliberately allows a semantically-neutral edit to
 * an already-applied migration file (inserting a missing breakpoint marker, for
 * instance), which changes the hash. Keying on it would read such an edit as
 * "never applied" and run the file a second time — the one outcome worse than
 * skipping it.
 *
 * **But a timestamp is only a claim, and the hash can overrule it.** Two
 * branches written in parallel each append "the next migration" with the same
 * next-day `when`; one is renumbered at merge time, the other keeps the slot.
 * If a runner applied the renumbered one from its branch tree before the
 * merge, the database holds a row with the kept entry's `when` and the OTHER
 * entry's body hash — and on timestamps alone the kept entry reads as applied
 * when it never ran. That is the second way 0125 was lost: `0126_disputes_target_version`
 * was `0125_disputes_target_version` (same `when` as 0125) on its branch, ran
 * from there, and left 0125's slot filled with its own hash. So a row whose
 * hash is the body of a *different* committed entry is credited to that entry,
 * not to its timestamp (`attributedMigrationWhens`).
 *
 * **An old hash is recognised, never guessed at.** The neutral edit above
 * leaves a row carrying the file's *previous* hash, and so does a borrower
 * that ran from its branch and was edited before it merged — and the two are
 * indistinguishable by hash alone: crediting such a row to the slot it sits in
 * is right for the first and replays the borrower for the second. So every
 * body an applied file has ever had is kept in `RETIRED_MIGRATION_HASHES`, a
 * row carrying one is credited to the entry that body belonged to, and a row
 * whose hash is no body the repo has ever had stops the deploy before anything
 * is applied (`unrecognisedRows`), unless it is a checked legacy row.
 *
 * Pure and free of any database handle so the decision is testable without one.
 */

/**
 * Every earlier body of an applied migration file, by tag, as the sha256 its
 * row in `drizzle.__drizzle_migrations` carries.
 *
 * AGENTS.md allows a semantically-neutral edit to an applied migration. Making
 * one means adding the file's previous hash here in the same change; the
 * build-time runner refuses a recorded hash it cannot place, and names the
 * row, rather than guess which migration it is.
 *
 * Every entry is an edit production already holds a row for: each hash is the
 * body the file had before the edit, and each sits in its own entry's slot in
 * the live table.
 */
export const RETIRED_MIGRATION_HASHES: Readonly<
  Record<string, readonly string[]>
> = {
  // Before the breakpoint-marker fix.
  '0005_pending_edits': [
    'c8d8af75f58d333391af768015d9e9e88b80d8e1e2506344ca655ebd5d84e853',
  ],
  // Before a later edit.
  '0103_efedrin_racemate_cid': [
    '5b9ace866bdfe754c42ac260304dd65dd9f62e4784f15659b180e26e24f2bceb',
  ],
  // Comment-only edits for the public source release: removed values quoted
  // from an unpublished dataset (0100) and an internal method number (0097).
  '0097_parameter_applicability': [
    '5fe22324e07a1618742a0493d559f333b1e027fb4ecf1bf5bd33a98fdc26b80b',
  ],
  '0100_pm_concentration_distributions': [
    '83b87968b789171f772d1a4da6368d78647a7bd0d23faf84c218e9cac1345dca',
  ],
  // Removed an internal group name. 0027's seed now inserts a neutral group,
  // which only a fresh database sees; 0145 carries the change for this one.
  '0027_user_groups': [
    '1384d2d72909836547785cd84544a7016e7fb154c01a0ae0968954fe41f8bc43',
  ],
  '0054_agent_focus_methods': [
    '05a78d69b6b92dd60178216b376f02b6222c52f9b136b20d201745a60ff4d0a2',
  ],
  '0136_refs_detection_guidelines': [
    'f79af36747c32df6ea73e4fe02624e0ababa956fb64619c3b7ef4a74e80cc8d9',
  ],
};

/** The fields of a journal entry this decision needs. */
export interface MigrationRef {
  tag: string;
  when: number;
}

/** A journal entry together with the sha256 of its committed body. */
export interface HashedMigrationRef extends MigrationRef {
  hash: string;
  /** Earlier bodies of the same file (`RETIRED_MIGRATION_HASHES`). */
  retiredHashes?: readonly string[];
}

/** Every hash a row recorded for this entry could carry. */
function knownHashes(entry: HashedMigrationRef): readonly string[] {
  return [entry.hash, ...(entry.retiredHashes ?? [])];
}

/** Each known body hash mapped to the entries that body belongs to. */
function ownersByKnownHash(
  entries: readonly HashedMigrationRef[],
): Map<string, HashedMigrationRef[]> {
  const owners = new Map<string, HashedMigrationRef[]>();
  for (const entry of entries) {
    for (const hash of knownHashes(entry)) {
      owners.set(hash, [...(owners.get(hash) ?? []), entry]);
    }
  }
  return owners;
}

/** One row of `drizzle.__drizzle_migrations`. */
export interface RecordedMigration {
  createdAt: number;
  hash: string;
}

/**
 * The journal timestamps the recorded rows actually vouch for.
 *
 * A row normally vouches for its own `created_at`. The exception is a row whose
 * hash is a body — current or retired — of a different journal entry: that row
 * is the other entry, recorded under a borrowed slot, and it vouches for that
 * entry instead. Without this, the entry that owns the slot is read as applied
 * while its SQL never ran — and since it is not recorded as missing, neither
 * the gap repair nor the post-condition would ever see it.
 *
 * A hash no body the repo has ever had keeps the timestamp here, but the
 * runner refuses such a row before it applies anything (`unrecognisedRows`).
 * A hash several entries share is only trusted for a timestamp among them;
 * otherwise it vouches for nothing, and the runner refuses that too
 * (`ambiguouslyAttributedRows`).
 */
export function attributedMigrationWhens(
  entries: readonly HashedMigrationRef[],
  rows: readonly RecordedMigration[],
): Set<number> {
  const ownersByHash = ownersByKnownHash(entries);
  const whens = new Set<number>();
  for (const row of rows) {
    const owners = ownersByHash.get(row.hash);
    if (!owners || owners.some((entry) => entry.when === row.createdAt)) {
      whens.add(row.createdAt);
    } else if (owners.length === 1) {
      whens.add(owners[0]!.when);
    }
  }
  return whens;
}

/**
 * Rows the live table holds that are no migration's record, checked by hand.
 *
 * `unrecognisedRows` refuses every row whose hash is no body the repo has ever
 * had, wherever it sits, so a row that genuinely belongs to no migration has to
 * be named here, by timestamp and hash, before a deploy will pass it.
 */
export const UNATTRIBUTED_LEGACY_ROWS: readonly RecordedMigration[] = [
  // Written by hand on 2026-04-27, between 0009 and 0010: the hash is the
  // literal placeholder `<hash>` (no writer on this path stores anything but a
  // sha256), and 1777293793073 was never a journal `when` in any commit.
  { createdAt: 1777293793073, hash: '<hash>' },
];

/**
 * Rows whose hash is no body the repo has ever had for any entry, current or
 * retired — `slot` is the committed entry whose timestamp the row sits in, or
 * `null` when no entry owns it.
 *
 * In a committed slot, such a row is either that entry's own file edited
 * without its old hash being retired, or another entry that ran from a branch
 * and was edited before it merged. Nothing in the table tells the two apart,
 * and they call for opposite repairs: the first is applied, the second means
 * the slot's owner never ran and the borrower would run again.
 *
 * Outside every slot it is no safer. A migration that ran from its branch,
 * was given a different `when` when the journal was reordered, and was then
 * edited without retiring its old hash leaves exactly this row: its body ran,
 * nothing credits it, and it would be applied a second time.
 *
 * The runner stops before applying anything and names the row. Retiring the
 * right hash, or listing a row that is truly no migration's in
 * `UNATTRIBUTED_LEGACY_ROWS`, is a one-line fix a human can check against the
 * history.
 */
export function unrecognisedRows(
  entries: readonly HashedMigrationRef[],
  rows: readonly RecordedMigration[],
  legacyRows: readonly RecordedMigration[] = UNATTRIBUTED_LEGACY_ROWS,
): Array<{ row: RecordedMigration; slot: MigrationRef | null }> {
  const ownersByHash = ownersByKnownHash(entries);
  const byWhen = new Map(entries.map((entry) => [entry.when, entry]));
  const isLegacy = (row: RecordedMigration) =>
    legacyRows.some(
      (legacy) =>
        legacy.createdAt === row.createdAt && legacy.hash === row.hash,
    );
  const found: Array<{ row: RecordedMigration; slot: MigrationRef | null }> =
    [];
  for (const row of rows) {
    if (ownersByHash.has(row.hash) || isLegacy(row)) continue;
    found.push({ row, slot: byWhen.get(row.createdAt) ?? null });
  }
  return found;
}

/**
 * Rows whose hash is the committed body of several entries at once, recorded
 * under a timestamp that belongs to none of them.
 *
 * Such a row proves one of those bodies ran but not which, so
 * `attributedMigrationWhens` credits it to nobody — and the gap repair or
 * `migrate()` would then run the real borrower's SQL a second time before the
 * post-condition ever looked. Identical bodies are harmless only while each
 * sits in its own slot; the runner stops before applying anything when one
 * does not, because guessing wrong here duplicates data.
 */
export function ambiguouslyAttributedRows(
  entries: readonly HashedMigrationRef[],
  rows: readonly RecordedMigration[],
): Array<{ row: RecordedMigration; candidates: MigrationRef[] }> {
  const found: Array<{ row: RecordedMigration; candidates: MigrationRef[] }> =
    [];
  for (const row of rows) {
    const candidates = entries.filter((entry) =>
      knownHashes(entry).includes(row.hash),
    );
    if (
      candidates.length > 1 &&
      !candidates.some((entry) => entry.when === row.createdAt)
    ) {
      found.push({ row, candidates });
    }
  }
  return found;
}

/**
 * Entries whose body already ran under another entry's slot and have no row
 * under their own `when` that vouches for them yet.
 *
 * The runner records each of these under its own slot, without running its
 * SQL again, once the gaps below it are repaired. Otherwise `migrate()`, which
 * sees only the raw newest `created_at`, would find the entry newer than the
 * borrowed slot and run its body a second time — harmless for an
 * `IF NOT EXISTS` column, a duplicate for any data migration.
 *
 * The body may have run under any of its known hashes — a borrower edited
 * after it ran from its branch left its retired hash in the borrowed slot.
 *
 * A row already at the entry's own `when` counts only if it vouches for this
 * entry: its hash is one of the entry's bodies, or no known body at all (the
 * runner refuses those before it gets here). A row there carrying a *third*
 * entry's body is
 * that entry, borrowing in turn — a chain. Treating it as occupied would leave
 * this entry credited only through the borrowed row, and the first neutral
 * edit to its file would turn that row into an unknown hash credited to the
 * slot it sits in, read this entry as missing, and replay it.
 */
export function unrecordedBorrowerSlots(
  entries: readonly HashedMigrationRef[],
  rows: readonly RecordedMigration[],
): HashedMigrationRef[] {
  const ownersByHash = ownersByKnownHash(entries);
  const vouchedFor = (entry: HashedMigrationRef) =>
    rows.some(
      (row) =>
        row.createdAt === entry.when &&
        (knownHashes(entry).includes(row.hash) || !ownersByHash.has(row.hash)),
    );
  return entries
    .filter(
      (entry) =>
        !vouchedFor(entry) &&
        rows.some((row) => {
          const owners = ownersByHash.get(row.hash);
          return owners?.length === 1 && owners[0] === entry;
        }),
    )
    .sort((a, b) => a.when - b.when);
}

/**
 * The mark the runner reconciles up to: the raw newest `created_at`, or a
 * borrower's own slot when that is newer. Every unrecorded entry at or below
 * it is applied by hand, so that recording a borrower under its own slot never
 * leaves an entry between the borrowed slot and that one behind the mark.
 */
export function reconciliationWatermark(
  entries: readonly HashedMigrationRef[],
  rows: readonly RecordedMigration[],
): number | null {
  return recordedWatermark(
    new Set([
      ...rows.map((row) => row.createdAt),
      ...unrecordedBorrowerSlots(entries, rows).map((entry) => entry.when),
    ]),
  );
}

/**
 * Rows recorded under a timestamp their hash says belongs to another entry —
 * reported by the runner so the repair it triggers is explained in the log.
 */
export function misattributedRows(
  entries: readonly HashedMigrationRef[],
  rows: readonly RecordedMigration[],
): Array<{ row: RecordedMigration; slot: MigrationRef; body: MigrationRef }> {
  const byWhen = new Map(entries.map((entry) => [entry.when, entry]));
  const ownersByHash = ownersByKnownHash(entries);
  const found: Array<{
    row: RecordedMigration;
    slot: MigrationRef;
    body: MigrationRef;
  }> = [];
  for (const row of rows) {
    const slot = byWhen.get(row.createdAt);
    if (!slot || knownHashes(slot).includes(row.hash)) continue;
    const owners = ownersByHash.get(row.hash);
    if (owners?.length === 1) found.push({ row, slot, body: owners[0]! });
  }
  return found;
}

/**
 * The newest recorded migration timestamp — the number drizzle's migrator
 * compares every journal entry against — or `null` when nothing is recorded at
 * all (a fresh database, where the migrator applies the whole chain).
 */
export function recordedWatermark(
  recordedWhens: ReadonlySet<number>,
): number | null {
  let watermark: number | null = null;
  for (const when of recordedWhens) {
    if (watermark === null || when > watermark) watermark = when;
  }
  return watermark;
}

/**
 * Committed migrations that are unrecorded AND already behind the high-water
 * mark, in journal order: precisely the set `migrate()` will skip on this and
 * every future run.
 *
 * `excludedTags` carries the tags the runner applies through its own
 * canary-probed path (`NON_TRANSACTIONAL_MIGRATIONS`); those have a repair
 * route of their own and must not be re-sent whole from here.
 *
 * Entries past the mark are deliberately left out — those are ordinary
 * pending migrations and `migrate()` applies them itself, in its own order,
 * with its own bookkeeping.
 *
 * `watermark` defaults to the newest of `recordedWhens`. The runner passes
 * `reconciliationWatermark` instead, because `recordedWhens` is the attributed
 * set: an entry sitting exactly at the raw mark whose slot another body
 * borrowed is unrecorded there, and `migrate()` (which runs only what is
 * strictly newer) will never reach it.
 */
export function migrationsBehindWatermark(
  entries: readonly MigrationRef[],
  recordedWhens: ReadonlySet<number>,
  excludedTags: ReadonlySet<string>,
  watermark: number | null = recordedWatermark(recordedWhens),
): MigrationRef[] {
  if (watermark === null) return [];
  return entries
    .filter(
      (entry) =>
        entry.when <= watermark &&
        !recordedWhens.has(entry.when) &&
        !excludedTags.has(entry.tag),
    )
    .sort((a, b) => a.when - b.when);
}

/**
 * Committed migrations with no recorded row, whatever the reason — the
 * post-condition the runner asserts once it has finished.
 *
 * Everything the runner does should empty this list: the baseline seeder
 * records the pre-tracking prefix, `migrationsBehindWatermark` covers the gaps,
 * and `migrate()` covers the tail. A non-empty result after all three means a
 * migration is still not applied, and the honest response is to fail the deploy
 * rather than ship code against a schema that does not exist.
 */
export function unrecordedMigrations(
  entries: readonly MigrationRef[],
  recordedWhens: ReadonlySet<number>,
): MigrationRef[] {
  return entries.filter((entry) => !recordedWhens.has(entry.when));
}
