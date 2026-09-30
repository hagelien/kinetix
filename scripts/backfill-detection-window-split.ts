/**
 * Finish migration 0098's rename on a live database.
 *
 * Dry-run by default; `--apply` writes.
 *
 * ## Why this exists on top of the migration
 *
 * **A migration cannot close its own window.** `vercel.json`'s buildCommand
 * applies pending migrations *during the build*, while the previous deployment
 * is still serving and still accepting writes under
 * `bloodOralFluidDetectionWindow`. A parameter, entry, review row or monograph
 * draft stored in the minutes between the migration's UPDATE and the new build
 * going live is never revisited: the id it carries is no longer in the
 * registry, so the API rejects writes to it, the sidebar skips it, and the
 * value is invisible with no path back. The same hazard that made the
 * substance-class backfill a script rather than part of migration 0097.
 *
 * **So the mop-up runs after the deploy**, once every writer is on the new
 * registry and no more old-id rows can appear. It replays the statements of
 * `drizzle/0098_split_blood_oral_fluid_detection_window.sql` verbatim rather
 * than restating them: two copies of a nine-table rename drift, and the shipped
 * file is the one the integration test exercises. Every statement is filtered
 * on the old id (and the priority-flag insert skips drugs already flagged or
 * already carrying an oral-fluid value), so a replay against a database with
 * nothing left to move changes no rows.
 *
 * Safe to run more than once, and safe to run when the migration already
 * caught everything — that is the expected case.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { getDb } from '../api/_lib/db.js';

const APPLY = process.argv.includes('--apply');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  HERE,
  '..',
  'drizzle',
  '0098_split_blood_oral_fluid_detection_window.sql',
);

const OLD_ID = 'bloodOralFluidDetectionWindow';

/** Tables whose `parameter` column can still hold the retired id. */
const PARAMETER_COLUMN_TABLES = [
  'drug_parameters',
  'parameter_entries',
  'drug_parameter_revisions',
  'drug_parameter_applicability',
  'drug_parameter_discussions',
  'pending_edits',
  'parameter_priority_flags',
  'verification_log',
] as const;

/** The jsonb payloads that carry the id outside a `parameter` column. */
const JSON_SOURCES: Array<{ label: string; where: string; table: string }> = [
  {
    label: 'pending_edits.proposed_value (param_entry payload)',
    table: 'pending_edits',
    where: `jsonb_typeof("proposed_value") = 'object'
            AND "proposed_value" -> 'input' ->> 'parameter' = '${OLD_ID}'`,
  },
  {
    label: 'pending_edits.proposed_meta.parameters (monograph draft bag)',
    table: 'pending_edits',
    where: `jsonb_typeof("proposed_meta" -> 'parameters') = 'object'
            AND jsonb_exists("proposed_meta" -> 'parameters', '${OLD_ID}')`,
  },
  {
    label: 'users.favorite_parameters',
    table: 'users',
    where: `jsonb_typeof("favorite_parameters") = 'array'
            AND "favorite_parameters" @> '["${OLD_ID}"]'::jsonb`,
  },
  {
    label: 'agent_focus_config.parameters',
    table: 'agent_focus_config',
    where: `jsonb_typeof("parameters") = 'array'
            AND "parameters" @> '["${OLD_ID}"]'::jsonb`,
  },
];

type Db = ReturnType<typeof getDb>;

async function countRows(db: Db, table: string, where: string): Promise<number> {
  const result = await db.execute<{ n: string | number }>(
    sql.raw(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`),
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Every place a stale row can still hide, with its current count. */
async function survey(db: Db): Promise<Array<{ label: string; count: number }>> {
  const out: Array<{ label: string; count: number }> = [];
  for (const table of PARAMETER_COLUMN_TABLES) {
    out.push({
      label: `${table}.parameter`,
      count: await countRows(db, table, `"parameter" = '${OLD_ID}'`),
    });
  }
  for (const source of JSON_SOURCES) {
    out.push({
      label: source.label,
      count: await countRows(db, source.table, source.where),
    });
  }
  return out;
}

/** The shipped migration's statements, in order. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

function report(rows: Array<{ label: string; count: number }>): number {
  const stale = rows.filter((r) => r.count > 0);
  for (const row of stale) {
    // eslint-disable-next-line no-console
    console.log(`  ${row.label}: ${row.count}`);
  }
  return stale.reduce((sum, r) => sum + r.count, 0);
}

async function run(): Promise<void> {
  const db = getDb();

  const before = await survey(db);
  const total = report(before);

  if (total === 0) {
    // eslint-disable-next-line no-console
    console.log(
      `No rows left carrying ${OLD_ID}; migration 0098 caught everything. Nothing to do.`,
    );
    return;
  }

  if (!APPLY) {
    // eslint-disable-next-line no-console
    console.log(
      `\n${total} row(s) still carry ${OLD_ID} — either migration 0098 has not been applied to this database yet, or the outgoing build wrote them during the deploy window.\nRe-run with --apply to move them to bloodDetectionWindow.`,
    );
    return;
  }

  for (const statement of migrationStatements()) {
    await db.execute(sql.raw(statement));
  }

  const remaining = report(await survey(db));
  if (remaining > 0) {
    // eslint-disable-next-line no-console
    console.error(
      `Backfill incomplete: ${remaining} row(s) still carry ${OLD_ID}.`,
    );
    process.exitCode = 1;
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`Backfill complete. Moved ${total} row(s) to bloodDetectionWindow.`);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Backfill failed:', err);
  process.exitCode = 1;
});
