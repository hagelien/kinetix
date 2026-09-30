/**
 * Clear the rows the retired `loq` / `lod` drug parameters left behind.
 *
 * Dry-run by default; `--apply` writes.
 *
 * ## Why this is a script and not a migration
 *
 * **It has to run after the deploy, not before it.** `vercel.json`'s build
 * command applies pending migrations to the live database *while the previous
 * application version is still serving writes* — and that version still
 * declares `loq`/`lod` in its parameter registry. A parameter PUT or a
 * pending-edit approval landing in that window would recreate exactly the rows
 * a migration had just deleted, and nothing would ever clean them up again:
 * the new build neither renders them nor lets an editor reach them, and a
 * migration runs once. The stragglers are not inert either — a leftover
 * `pending_edits` row sits in `/review` as an item whose approval the new API
 * rejects, and a leftover `parameter_entries` row keeps its citation in the
 * agent's unreviewed-references queue.
 *
 * Running once the registry change is live closes the window by construction:
 * from that moment nothing can write the two ids at all. This mirrors
 * `backfill-substance-classes.ts`, which was moved out of migration 0097 for
 * the same reason.
 *
 * **And it is re-runnable.** Every statement is idempotent — a second run
 * reports zero rows. If the deploy window did produce stragglers, or a restore
 * from an older backup brings some back, run it again.
 *
 * ## Deploying the retirement needs this manual step
 *
 * After the build carrying the registry change is live:
 *
 *     npm run retire:loq-lod              # dry run, reports what it would do
 *     npm run retire:loq-lod -- --apply   # writes
 *
 * Skipping it is not catastrophic — the registry change alone already stops
 * every new write and removes the parameters from every surface — but the dead
 * rows above stay until it runs. It is deliberately not wired into
 * `deploy-production.yml`: a data mutation that runs automatically against
 * production is a decision for whoever owns the deploy.
 *
 * ## What it touches, and what it deliberately does not
 *
 * Every table that keys on a parameter id: the value, its per-source entries,
 * its revision history, both kinds of queued proposal, priority flags,
 * applicability markers, and drug-scoped discussion threads — plus the admin's
 * agent focus list, which would otherwise narrow the maintenance agent onto
 * work that can never exist.
 *
 * Open **disputes** against the revisions, pending edits and discussion threads
 * being deleted are resolved as `withdrawn` FIRST, before their targets go.
 * `disputes.target_id` is polymorphic and unconstrained and `listOpenDisputes`
 * reads open rows without joining to the target, so a dispute left behind
 * becomes a feed item no agent or moderator can ever resolve. It is resolved
 * rather than deleted: the dispute was raised in good faith and its subject
 * simply ceased to exist, which is what `withdrawn` means. `resolved_by` stays
 * null — no person made this call.
 *
 * NOT touched:
 *
 *   * `analytical_method_components` — `lor` / `mkk` / `lod` are where an
 *     analytical limit legitimately lives, per analyte per method.
 *     They are the replacement for the retired parameters, not a casualty.
 *   * `verification_log` — an audit trail of work an agent actually did. A row
 *     there records a past check, not a live claim about the drug.
 *   * `approvals` and `agent_verifications` — also polymorphic and
 *     unconstrained, so deleting a target can strand a row. Unlike a dispute,
 *     neither surfaces in a queue on its own: both are read only through a
 *     target that still exists, and their unique indexes cannot collide with a
 *     future row because the id columns they point at are never-reused serials.
 *     Audit rows are kept rather than swept.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { getDb, runInPoolTransaction } from '../api/_lib/db.js';

/** The two ids being retired. Inlined into the SQL below, not interpolated. */
export const RETIRED_PARAMETER_IDS = ['loq', 'lod'] as const;

export interface RetirementStep {
  /** Short human label for the report line. */
  label: string;
  /**
   * One SQL command. Every one ends in `RETURNING 1 AS changed` so the caller
   * can count rows without depending on a driver's `rowCount` shape — and as a
   * literal rather than a column, since not every table here has an `id` (the
   * applicability marker is keyed on drug + parameter).
   */
  sql: string;
}

/**
 * The whole sweep, in dependency order: a dispute is resolved while its target
 * still exists, so every `disputes` step precedes the delete it protects.
 *
 * Exported as text and executed AS IS by
 * `tests/integration/retire-loq-lod-rows.test.ts` — the same anti-drift rule
 * `UNREVIEWED_REFERENCES_SQL` and `CITATION_HAYSTACK` follow. A copy in the
 * test would let the two drift apart silently.
 */
export const RETIREMENT_STEPS: readonly RetirementStep[] = [
  {
    label: 'disputes on parameter revisions → withdrawn',
    sql: `
      UPDATE "disputes" d
      SET "status" = 'resolved',
          "resolution" = 'withdrawn',
          "resolved_at" = now(),
          "updated_at" = now()
      WHERE d."status" = 'open'
        AND d."target_type" = 'drug_parameter_revision'
        AND EXISTS (
          SELECT 1 FROM "drug_parameter_revisions" r
          WHERE r."id" = d."target_id"
            AND r."parameter" IN ('loq', 'lod')
        )
      RETURNING 1 AS changed`,
  },
  {
    label: 'disputes on queued proposals → withdrawn',
    sql: `
      UPDATE "disputes" d
      SET "status" = 'resolved',
          "resolution" = 'withdrawn',
          "resolved_at" = now(),
          "updated_at" = now()
      WHERE d."status" = 'open'
        AND d."target_type" = 'pending_edit'
        AND EXISTS (
          SELECT 1 FROM "pending_edits" pe
          WHERE pe."id" = d."target_id"
            AND pe."edit_type" IN ('parameter', 'param_entry')
            AND pe."parameter" IN ('loq', 'lod')
        )
      RETURNING 1 AS changed`,
  },
  {
    label: 'disputes on discussion threads → withdrawn',
    sql: `
      UPDATE "disputes" d
      SET "status" = 'resolved',
          "resolution" = 'withdrawn',
          "resolved_at" = now(),
          "updated_at" = now()
      WHERE d."status" = 'open'
        AND d."target_type" = 'drug_discussion'
        AND EXISTS (
          SELECT 1 FROM "drug_parameter_discussions" dd
          WHERE dd."id" = d."target_id"
            AND dd."drug_id" IS NOT NULL
            AND dd."parameter" IN ('loq', 'lod')
        )
      RETURNING 1 AS changed`,
  },
  {
    label: 'stored values',
    sql: `DELETE FROM "drug_parameters" WHERE "parameter" IN ('loq', 'lod') RETURNING 1 AS changed`,
  },
  {
    // Only reachable from before `validateEntryForParameter` restricted entries
    // to summarizable parameters, or from an operator script writing the table
    // directly — but a straggler holds a citation_id and would keep that source
    // in the agent's unreviewed-references queue with nothing able to clear it.
    label: 'per-source entries',
    sql: `DELETE FROM "parameter_entries" WHERE "parameter" IN ('loq', 'lod') RETURNING 1 AS changed`,
  },
  {
    label: 'revision history',
    sql: `DELETE FROM "drug_parameter_revisions" WHERE "parameter" IN ('loq', 'lod') RETURNING 1 AS changed`,
  },
  {
    // A reviewer cannot act on a proposal the API would now reject at approval
    // time, so it is removed rather than left to fail in the queue.
    label: 'queued proposals (parameter + param_entry)',
    sql: `
      DELETE FROM "pending_edits"
      WHERE "edit_type" IN ('parameter', 'param_entry')
        AND "parameter" IN ('loq', 'lod')
      RETURNING 1 AS changed`,
  },
  {
    label: 'agent priority flags',
    sql: `DELETE FROM "parameter_priority_flags" WHERE "parameter" IN ('loq', 'lod') RETURNING 1 AS changed`,
  },
  {
    // The parameter is now undefined for every substance, so a per-pair
    // "not applicable" exception has nothing left to say.
    label: 'applicability markers',
    sql: `DELETE FROM "drug_parameter_applicability" WHERE "parameter" IN ('loq', 'lod') RETURNING 1 AS changed`,
  },
  {
    // Topic-page fact discussions reuse this column with `wiki_page_id` set and
    // `drug_id` null; they are a different population and stay.
    label: 'drug-scoped discussion threads',
    sql: `
      DELETE FROM "drug_parameter_discussions"
      WHERE "drug_id" IS NOT NULL
        AND "parameter" IN ('loq', 'lod')
      RETURNING 1 AS changed`,
  },
  {
    // An id the registry no longer knows would narrow the maintenance agent's
    // parameter lane onto work that can never exist. If the retired ids were
    // the ONLY ones selected the list becomes empty, which
    // `resolveFocusNarrowing` reads as "nothing is in scope" — the agent logs
    // no_change and the response echoes the empty focus. Resetting the mode to
    // 'all' instead would silently widen it to the whole catalogue against an
    // explicit admin instruction.
    label: 'admin agent focus list',
    sql: `
      UPDATE "agent_focus_config"
      SET "parameters" = COALESCE(
        (
          SELECT jsonb_agg(p)
          FROM jsonb_array_elements_text("parameters") AS p
          WHERE p NOT IN ('loq', 'lod')
        ),
        '[]'::jsonb
      )
      WHERE "parameters" @> '["loq"]'::jsonb
         OR "parameters" @> '["lod"]'::jsonb
      RETURNING 1 AS changed`,
  },
];

export interface StepResult {
  label: string;
  rows: number;
}

/** Sentinel thrown to roll back the dry run's transaction. */
class DryRunRollback extends Error {
  constructor(readonly results: StepResult[]) {
    super('dry run');
  }
}

/**
 * Run every step in one transaction and report the rows each touched. With
 * `apply: false` the transaction is rolled back, so the counts are what a real
 * run WOULD do — including each step's effect on the next — rather than an
 * estimate assembled from separate SELECTs.
 */
export async function retireLoqLodRows(opts: {
  apply: boolean;
}): Promise<StepResult[]> {
  try {
    return await runInPoolTransaction(async () => {
      const db = getDb();
      const results: StepResult[] = [];
      for (const step of RETIREMENT_STEPS) {
        const res = await db.execute(sql.raw(step.sql));
        const rows =
          (res as unknown as { rows?: unknown[] }).rows ??
          (res as unknown as unknown[]);
        results.push({ label: step.label, rows: rows.length });
      }
      if (!opts.apply) throw new DryRunRollback(results);
      return results;
    });
  } catch (err) {
    if (err instanceof DryRunRollback) return err.results;
    throw err;
  }
}

async function run(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const log = (...a: unknown[]) => console.log(...a); // eslint-disable-line no-console

  const results = await retireLoqLodRows({ apply });
  const total = results.reduce((n, r) => n + r.rows, 0);

  log(`── Retire ${RETIRED_PARAMETER_IDS.join(' / ')} rows ──`);
  for (const r of results) {
    log(`  ${String(r.rows).padStart(6)}  ${r.label}`);
  }
  log(`${apply ? 'Changed' : 'Would change'} ${total} row(s) in total.`);
  if (!apply) log(`\nDry run. Re-run with --apply to write.`);
}

if (process.argv[1]?.endsWith('retire-loq-lod-rows.ts')) {
  await run();
}
