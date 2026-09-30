/**
 * Build-time migration runner. Seeds drizzle.__drizzle_migrations with a
 * one-time baseline (the production DB was bootstrapped via drizzle-kit push
 * and has no tracking table) and then applies any pending migrations via
 * drizzle-orm's neon-http migrator.
 *
 * Idempotent and self-healing: every seed INSERT guards with WHERE NOT
 * EXISTS so a partial first run is safely completed on rerun, and each
 * baseline tag is gated by a canary probe so that a partially-migrated DB
 * seeds only the prefix of tags that are actually applied — the rest flow
 * through migrate() normally.
 *
 * It also reconciles the one thing migrate() cannot see: a committed migration
 * that is unrecorded *and* behind the high-water mark it gates on, which it
 * would otherwise skip in silence on this and every future deploy. Those are
 * applied here (scripts/lib/migration-gaps.ts explains how one gets there and
 * what it cost), and the run ends by asserting that every journal entry is
 * recorded — so a migration that still has not landed fails the deploy instead
 * of shipping code against a schema that does not exist.
 *
 * Invoked from vercel.json buildCommand and aliased as `npm run db:migrate`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { migrate } from 'drizzle-orm/neon-http/migrator';
import {
  RETIRED_MIGRATION_HASHES,
  ambiguouslyAttributedRows,
  attributedMigrationWhens,
  migrationsBehindWatermark,
  misattributedRows,
  reconciliationWatermark,
  unrecognisedRows,
  unrecordedBorrowerSlots,
  unrecordedMigrations,
  type HashedMigrationRef,
  type RecordedMigration,
} from './lib/migration-gaps.js';

// A canary is a schema object we can probe to confirm a migration was
// actually applied. For CREATE migrations it's "does X exist"; for DROP
// migrations ('column-absent') it's "is X gone"; for migrations that only
// change a column default ('column-default'), it's a substring match on the
// recorded default expression.
type Canary =
  | { kind: 'relation'; ident: string }
  // Present if ANY of the listed relations exists. Used when a later migration
  // renames the relation, so both the pre- and post-rename physical states of
  // an untracked/partially-migrated DB are recognized as "this tag applied".
  | { kind: 'relation-any'; idents: string[] }
  | { kind: 'valid-index'; ident: string }
  | { kind: 'column'; table: string; column: string }
  | { kind: 'column-absent'; table: string; column: string }
  | {
      kind: 'column-default';
      table: string;
      column: string;
      expectedSubstring: string;
    };

type Journal = {
  entries: Array<{ tag: string; when: number }>;
};

// Baseline tags known to be present in production at the moment this script
// ships, each paired with a probe that detects whether the migration is in
// fact applied. Seeding walks this list in order and stops at the first
// missing canary — downstream tags flow through migrate() untouched. Do NOT
// extend this list for new migrations; new migrations go through migrate().
const BASELINE: ReadonlyArray<{ tag: string; canary: Canary }> = [
  {
    tag: '0000_wooden_gideon',
    canary: { kind: 'relation', ident: 'public.users' },
  },
  {
    tag: '0001_harsh_triathlon',
    canary: { kind: 'relation', ident: 'public.drugs' },
  },
  {
    tag: '0002_cheerful_lady_mastermind',
    canary: { kind: 'relation', ident: 'public.citations' },
  },
  {
    tag: '0003_drop_ranges_metabolism',
    canary: { kind: 'column-absent', table: 'drugs', column: 'metabolism' },
  },
  {
    tag: '0004_add_name_short',
    canary: { kind: 'column', table: 'drugs', column: 'name_short' },
  },
  {
    tag: '0005_pending_edits',
    canary: { kind: 'relation', ident: 'public.pending_edits' },
  },
  {
    tag: '0006_magic_link_attempt_limits',
    canary: {
      kind: 'column',
      table: 'users',
      column: 'magic_link_failed_attempts',
    },
  },
  {
    tag: '0007_multi_reference',
    canary: {
      kind: 'column',
      table: 'drug_parameter_revisions',
      column: 'reference_ids',
    },
  },
  {
    tag: '0008_drug_search_trgm',
    canary: { kind: 'relation', ident: 'public.drugs_search_key_trgm_idx' },
  },
  {
    // 0078 later renames reference_concentrations -> parameter_entries.
    // Recognize EITHER name so both bootstrap states of an untracked DB are
    // detected as "0009 applied": a pre-0078 restore (only
    // reference_concentrations exists) and a fresh drizzle-kit push of the
    // current schema (only parameter_entries exists). Anchoring on a single
    // name would stop baseline seeding at 0009 in the other state, and
    // migrate() would then re-create the already-existing table and abort at
    // the 0078 rename.
    tag: '0009_reference_concentrations',
    canary: {
      kind: 'relation-any',
      idents: ['public.reference_concentrations', 'public.parameter_entries'],
    },
  },
  {
    tag: '0010_verification_log',
    canary: { kind: 'relation', ident: 'public.verification_log' },
  },
  // 0018 later drops drugs.tmax/pka after migrating their data into drug_parameters,
  // so we anchor on peak_concentration which 0011 adds and 0018 leaves in place.
  {
    tag: '0011_cmax_tmax_pka',
    canary: { kind: 'column', table: 'drugs', column: 'peak_concentration' },
  },
  {
    tag: '0012_user_preferences',
    canary: { kind: 'column', table: 'users', column: 'display_name' },
  },
  {
    tag: '0013_drug_names_jsonb',
    canary: { kind: 'column', table: 'drugs', column: 'names' },
  },
  {
    tag: '0014_rejection_reason_and_priority_flags',
    canary: {
      kind: 'column',
      table: 'pending_edits',
      column: 'rejection_reason',
    },
  },
  {
    tag: '0015_pending_edit_fact_columns',
    canary: { kind: 'column', table: 'pending_edits', column: 'section_id' },
  },
  {
    tag: '0016_enabled_concentration_units',
    canary: {
      kind: 'column',
      table: 'users',
      column: 'enabled_concentration_units',
    },
  },
  {
    tag: '0017_role_authenticated_contributor',
    canary: {
      kind: 'column-default',
      table: 'users',
      column: 'role',
      expectedSubstring: 'authenticated',
    },
  },
  {
    tag: '0018_drug_parameters_table',
    canary: { kind: 'relation', ident: 'public.drug_parameters' },
  },
  {
    tag: '0019_user_favorite_parameters',
    canary: { kind: 'column', table: 'users', column: 'favorite_parameters' },
  },
  {
    tag: '0020_agents_table',
    canary: { kind: 'relation', ident: 'public.agents' },
  },
  {
    tag: '0021_wiki_fts_index',
    canary: { kind: 'relation', ident: 'public.wiki_pages_fts_idx' },
  },
];

// Migrations listed here require special non-transactional handling. Before
// each one, run the normal migrator through the preceding journal entries so
// recording a special migration never advances Drizzle's high-water mark past
// unapplied regular migrations.
//
// Membership is NOT "the file says CONCURRENTLY". drizzle's neon-http migrator
// is its own implementation (drizzle-orm/neon-http/migrator.js) that issues
// each statement over Neon's HTTP endpoint in autocommit — it never opens a
// transaction; only pg-core's dialect.migrate(), which backs the node-postgres
// and PGlite migrators, wraps a migration in session.transaction(). So
// CONCURRENTLY is legal through migrate() here, and 0040 and 0082 use it
// without being listed and applied in production exactly that way. What this
// path adds on top is the canary probe and the invalid-index repair below: a
// CONCURRENTLY build that fails leaves an INVALID index behind, which a
// re-run of `CREATE INDEX ... IF NOT EXISTS` would not fix.
const NON_TRANSACTIONAL_MIGRATIONS: ReadonlyArray<{
  tag: string;
  canary: Canary;
}> = [
  {
    tag: '0041_pending_edits_status_sort_idx',
    canary: {
      kind: 'valid-index',
      ident: 'public.pending_edits_status_sort_idx',
    },
  },
  {
    tag: '0042_wiki_pages_parent_id_idx',
    canary: {
      kind: 'valid-index',
      ident: 'public.wiki_pages_parent_id_idx',
    },
  },
  {
    tag: '0043_agent_hook_runs_event_idx',
    canary: {
      kind: 'valid-index',
      ident: 'public.agent_hook_runs_event_created_idx',
    },
  },
  {
    tag: '0059_drug_parameters_mw_sort_idx',
    canary: {
      kind: 'valid-index',
      ident: 'public.drug_parameters_mw_sort_idx',
    },
  },
  {
    tag: '0079_pending_edit_open_entry_idx',
    canary: {
      kind: 'valid-index',
      ident: 'public.pending_edits_open_entry_idx',
    },
  },
];

/**
 * drizzle's own chunk separator, duplicated here because the back-fill path
 * below sends migration bodies itself rather than through `migrate()`.
 */
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.log('[migrate] DATABASE_URL not set, skipping.');
  process.exit(0);
}

const sql = neon(DATABASE_URL);

function readJournal(): Journal {
  const journalPath = path.join('drizzle', 'meta', '_journal.json');
  return JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Journal;
}

function readMigrationBody(tag: string): string {
  return fs.readFileSync(path.join('drizzle', `${tag}.sql`), 'utf8');
}

function migrationHash(body: string): string {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function parseQualifiedIdent(ident: string): { schema: string; name: string } {
  const match = /^([A-Za-z_][A-Za-z0-9_$]*)\.([A-Za-z_][A-Za-z0-9_$]*)$/.exec(
    ident,
  );
  if (!match) throw new Error(`Unsupported identifier format: ${ident}`);
  // Both groups are mandatory in the pattern, so a match has both.
  return { schema: match[1]!, name: match[2]! };
}

function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

async function canaryPresent(c: Canary): Promise<boolean> {
  if (c.kind === 'relation') {
    const r = await sql`SELECT to_regclass(${c.ident}) AS t`;
    return r[0]?.t !== null;
  }
  if (c.kind === 'relation-any') {
    for (const ident of c.idents) {
      const r = await sql`SELECT to_regclass(${ident}) AS t`;
      if (r[0]?.t !== null) return true;
    }
    return false;
  }
  if (c.kind === 'valid-index') {
    const { schema, name } = parseQualifiedIdent(c.ident);
    const r = await sql`
      SELECT i.indisvalid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE n.nspname = ${schema} AND c.relname = ${name}
      LIMIT 1
    `;
    return r[0]?.indisvalid === true;
  }
  if (c.kind === 'column-default') {
    const r = await sql`
      SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${c.table} AND column_name = ${c.column}
      LIMIT 1
    `;
    const def = r[0]?.column_default;
    return typeof def === 'string' && def.includes(c.expectedSubstring);
  }
  const r = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${c.table} AND column_name = ${c.column}
    LIMIT 1
  `;
  const exists = r.length > 0;
  return c.kind === 'column' ? exists : !exists;
}

async function dropInvalidIndex(c: Canary): Promise<void> {
  if (c.kind !== 'valid-index') return;

  const { schema, name } = parseQualifiedIdent(c.ident);
  const r = await sql`
    SELECT i.indisvalid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_index i ON i.indexrelid = c.oid
    WHERE n.nspname = ${schema} AND c.relname = ${name}
    LIMIT 1
  `;
  if (r.length === 0 || r[0]?.indisvalid === true) return;

  console.log(`[migrate] Dropping invalid index ${c.ident} before retry`);
  await sql.query(
    `DROP INDEX CONCURRENTLY ${quoteIdent(schema)}.${quoteIdent(name)}`,
  );
}

/**
 * Every row in the bookkeeping table.
 *
 * `created_at` is the entry's `when` on every write path here — the baseline
 * seeder, the non-transactional applier and drizzle's own migrator all store
 * it. Neon's HTTP driver hands `bigint` back as a string, hence the explicit
 * `Number`.
 */
async function recordedMigrationRows(): Promise<RecordedMigration[]> {
  const rows = await sql`
    SELECT hash, created_at FROM "drizzle"."__drizzle_migrations"
  `;
  const recorded: RecordedMigration[] = [];
  for (const row of rows) {
    const createdAt = Number(row.created_at);
    if (Number.isFinite(createdAt)) {
      recorded.push({ createdAt, hash: String(row.hash) });
    }
  }
  return recorded;
}

/** Each journal entry with the hash of its committed body. */
function hashedJournalEntries(): HashedMigrationRef[] {
  return readJournal().entries.map((entry) => ({
    tag: entry.tag,
    when: entry.when,
    hash: migrationHash(readMigrationBody(entry.tag)),
    retiredHashes: RETIRED_MIGRATION_HASHES[entry.tag] ?? [],
  }));
}

/**
 * The journal timestamps this database has actually applied, with rows that
 * sit in another entry's slot credited to the entry their hash names
 * (`attributedMigrationWhens` explains how a slot gets borrowed).
 */
async function recordedMigrationWhens(): Promise<Set<number>> {
  return attributedMigrationWhens(
    hashedJournalEntries(),
    await recordedMigrationRows(),
  );
}

async function migrationRecorded(hash: string): Promise<boolean> {
  const existing = await sql`
    SELECT 1 FROM "drizzle"."__drizzle_migrations" WHERE hash = ${hash} LIMIT 1
  `;
  return existing.length > 0;
}

async function recordMigration(hash: string, createdAt: number): Promise<void> {
  await sql`INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
            VALUES (${hash}, ${createdAt})`;
}

function nonTransactionalTags(): Set<string> {
  return new Set(NON_TRANSACTIONAL_MIGRATIONS.map((m) => m.tag));
}

function makeMigrationFolder(entries: Journal['entries']): string {
  const sourceRoot = path.resolve('drizzle');
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kinetix-drizzle-migrations-'),
  );
  const tempMeta = path.join(tempRoot, 'meta');
  fs.mkdirSync(tempMeta, { recursive: true });
  fs.writeFileSync(
    path.join(tempMeta, '_journal.json'),
    JSON.stringify({ ...readJournal(), entries }, null, 2),
  );
  for (const entry of entries) {
    fs.copyFileSync(
      path.join(sourceRoot, `${entry.tag}.sql`),
      path.join(tempRoot, `${entry.tag}.sql`),
    );
  }
  return tempRoot;
}

async function migrateThrough(cutoffWhen: number): Promise<void> {
  const specialTags = nonTransactionalTags();
  const journal = readJournal();
  const entries = journal.entries.filter(
    (entry) => entry.when < cutoffWhen && !specialTags.has(entry.tag),
  );
  const migrationFolder = makeMigrationFolder(entries);

  try {
    await migrate(drizzle(sql), { migrationsFolder: migrationFolder });
  } finally {
    fs.rmSync(migrationFolder, { recursive: true, force: true });
  }
}

async function seedBaseline(): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`;
  await sql`CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at bigint
  )`;

  const journal = readJournal();
  const byTag = new Map(journal.entries.map((e) => [e.tag, e]));

  let seeded = 0;
  let alreadyPresent = 0;
  for (const { tag, canary } of BASELINE) {
    if (!(await canaryPresent(canary))) {
      console.log(
        `  stop at ${tag}: canary missing — migrate() will apply this and subsequent tags`,
      );
      break;
    }
    const entry = byTag.get(tag);
    if (!entry)
      throw new Error(
        `Baseline tag ${tag} is not in drizzle/meta/_journal.json`,
      );
    const hash = migrationHash(readMigrationBody(tag));

    // Guard per-row rather than up-front so a partial previous run is
    // completed on this run instead of being frozen at its interruption
    // point (avoiding a poisoned high-water mark in the migrator).
    if (await migrationRecorded(hash)) {
      alreadyPresent++;
      continue;
    }
    await recordMigration(hash, entry.when);
    console.log(`  seeded ${tag}`);
    seeded++;
  }
  console.log(
    `[migrate] Baseline: seeded=${seeded} already-present=${alreadyPresent}`,
  );
}

async function applyNonTransactionalMigrations(): Promise<void> {
  const journal = readJournal();
  const byTag = new Map(journal.entries.map((e) => [e.tag, e]));

  for (const { tag, canary } of NON_TRANSACTIONAL_MIGRATIONS) {
    const entry = byTag.get(tag);
    if (!entry)
      throw new Error(
        `Non-transactional tag ${tag} is not in drizzle/meta/_journal.json`,
      );

    const body = readMigrationBody(tag);
    const hash = migrationHash(body);
    await migrateThrough(entry.when);
    if (await migrationRecorded(hash)) {
      if (!(await canaryPresent(canary))) {
        await dropInvalidIndex(canary);
        console.log(`[migrate] Repairing recorded non-transactional ${tag}`);
        await sql.query(body);
        if (!(await canaryPresent(canary))) {
          throw new Error(`Non-transactional migration ${tag} canary missing`);
        }
      }
      continue;
    }

    if (await canaryPresent(canary)) {
      console.log(`[migrate] Recording existing non-transactional ${tag}`);
    } else {
      await dropInvalidIndex(canary);
      console.log(`[migrate] Applying ${tag} outside transaction...`);
      await sql.query(body);
      if (!(await canaryPresent(canary))) {
        throw new Error(`Non-transactional migration ${tag} canary missing`);
      }
    }
    await recordMigration(hash, entry.when);
  }
}

/**
 * Split a migration body the way drizzle's migrator does, so a back-filled
 * migration reaches Neon in exactly the chunks it would have reached it in
 * had it not been skipped. Neon's HTTP endpoint prepares each chunk, and a
 * prepared statement holds exactly one command — the property
 * tests/drizzle-migration-statements.test.ts exists to guard.
 *
 * Empty chunks are dropped: drizzle sends them, Postgres treats them as an
 * empty query, and there is nothing to gain from repeating that.
 */
function splitStatements(body: string): string[] {
  return body
    .split(STATEMENT_BREAKPOINT)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0);
}

/**
 * Apply the committed migrations `migrate()` will never reach.
 *
 * See scripts/lib/migration-gaps.ts for how a migration ends up here. In short:
 * the migrator gates on a single newest-`created_at` high-water mark, so any
 * runner that records a LATER migration against this database from a tree
 * missing an earlier one buries that earlier one permanently — with a green,
 * sub-second "Done." on every deploy thereafter.
 *
 * Failure direction is deliberate. A migration that cannot be replayed (its
 * effect half-exists, say) aborts the build here, loudly, with the tag in the
 * message. That is the outcome the silent skip denied us: the alternative is
 * not "no risk", it is a deploy that reports success while production 500s on
 * the column that never appeared.
 */
async function applyMigrationsBehindWatermark(): Promise<void> {
  const entries = hashedJournalEntries();
  const rows = await recordedMigrationRows();
  // Refuse before any SQL runs: a row whose hash no body has ever had could
  // be an edited file or a body that already ran under another timestamp, and
  // the two need opposite repairs.
  const unrecognised = unrecognisedRows(entries, rows);
  if (unrecognised.length > 0) {
    throw new Error(
      unrecognised
        .map(
          ({ row, slot }) =>
            `the row at created_at=${row.createdAt} ` +
            (slot ? `(the slot of ${slot.tag}) ` : '(no committed slot) ') +
            `carries hash ${row.hash}, which is no body any committed ` +
            'migration has or had',
        )
        .join('; ') +
        '. Nothing was applied: find the file version that hash belongs to ' +
        'and add it to RETIRED_MIGRATION_HASHES under that tag, or, if the ' +
        'row is no migration at all, to UNATTRIBUTED_LEGACY_ROWS; then ' +
        'redeploy.',
    );
  }
  // Likewise a row that could be any of several identical bodies credits none
  // of them, so everything below would replay whichever one actually ran it.
  const ambiguous = ambiguouslyAttributedRows(entries, rows);
  if (ambiguous.length > 0) {
    throw new Error(
      ambiguous
        .map(
          ({ row, candidates }) =>
            `the row recorded at created_at=${row.createdAt} carries a body ` +
            `hash shared by ${candidates.map((c) => c.tag).join(', ')} and ` +
            'sits in none of their slots',
        )
        .join('; ') +
        '. Nothing was applied: record which of them ran under its own slot ' +
        'by hand, then redeploy.',
    );
  }
  for (const { row, slot, body } of misattributedRows(entries, rows)) {
    console.log(
      `[migrate] the row recorded for ${slot.tag} carries the body hash of ` +
        `${body.tag}, so ${slot.tag} is not counted as applied ` +
        `(created_at=${row.createdAt}).`,
    );
  }
  const gaps = migrationsBehindWatermark(
    entries,
    attributedMigrationWhens(entries, rows),
    nonTransactionalTags(),
    reconciliationWatermark(entries, rows),
  );
  if (gaps.length > 0) {
    console.log(
      `[migrate] ${gaps.length} committed migration(s) sit behind the ` +
        'high-water mark migrate() gates on and would never be applied:',
    );
  }
  for (const entry of gaps) {
    const body = readMigrationBody(entry.tag);
    console.log(`  back-filling ${entry.tag}`);
    for (const statement of splitStatements(body)) {
      await sql.query(statement);
    }
    await recordMigration(migrationHash(body), entry.when);
  }
  // Last, and only once everything below them is in: a body that already ran
  // under a borrowed slot gets a row under its own, so migrate() does not find
  // it newer than the mark and run it a second time.
  for (const entry of unrecordedBorrowerSlots(entries, rows)) {
    console.log(
      `  recording ${entry.tag} under its own slot; its body already ran ` +
        'under a borrowed one',
    );
    await recordMigration(entry.hash, entry.when);
  }
}

/**
 * The run's post-condition: every committed migration has a recorded row.
 *
 * Without this the only evidence a deploy migrated anything is that it did not
 * crash, and the failure this whole file is about produces no crash at all.
 * Throwing fails `vercel build` before `vercel deploy` publishes the code that
 * needs the missing schema — the migration step runs first precisely so a bad
 * schema state can still stop a release.
 */
async function assertEveryMigrationRecorded(): Promise<void> {
  const journal = readJournal();
  const missing = unrecordedMigrations(
    journal.entries,
    await recordedMigrationWhens(),
  );
  if (missing.length === 0) return;
  throw new Error(
    `${missing.length} committed migration(s) are still not applied: ` +
      `${missing.map((entry) => entry.tag).join(', ')}. The deploy is ` +
      'stopped here rather than shipping code against a schema that does ' +
      'not exist.',
  );
}

async function main() {
  console.log('[migrate] Seeding baseline if needed...');
  await seedBaseline();
  // Gaps are repaired BEFORE anything else runs a migrator, and the order is
  // load-bearing. `applyNonTransactionalMigrations` calls `migrateThrough`
  // ahead of each special tag, and that call still obeys the high-water mark —
  // so with a buried migration older than a special tag still missing, it
  // applies the entries after the mark against a schema that predecessor never
  // built, and aborts on the relation the gap was supposed to create. It would
  // abort before ever reaching the repair. Seeding stays first: it creates the
  // bookkeeping table the gap query reads, and its rows set the mark.
  await applyMigrationsBehindWatermark();
  await applyNonTransactionalMigrations();
  console.log('[migrate] Applying any pending migrations...');
  await migrate(drizzle(sql), { migrationsFolder: './drizzle' });
  await assertEveryMigrationRecorded();
  console.log('[migrate] Done.');
}

main().catch((err) => {
  console.error('[migrate] Error:', err);
  process.exit(1);
});
