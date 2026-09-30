/**
 * Where is `qualifier` holding something that is not a comparison operator?
 *
 * `qualifier` is `<`, `>`, `≤` or `≥` and nothing else (`src/types/index.ts`):
 * it marks a CENSORED THRESHOLD, so the value renders as the operator followed
 * by one figure. Prose written there therefore does two things at once — it
 * reads as part of the number ("voksen po 30 mg/L", "tilsynelatende Vd … 3,34
 * L/kg"), and it collapses a real low–high span to a single bound, because the
 * threshold branch takes precedence over the range branch.
 *
 * Both schemas now refuse it (`drugParameters.ts` for an authored parameter,
 * `parameterEntries.ts` for a source value) and `formatRange` ignores a legacy
 * one, but three things survive that: rows written before the enums were
 * tightened, pending proposals written through a path that was not yet gated
 * (the `param_entry` resubmit, closed in #1196/#1202), and agent prompts that
 * taught the habit. A proposal in the last group reaches the review queue
 * unapprovable — no moderator can publish it, and the refusal names a field its
 * AUTHOR has to change.
 *
 * So this asks the database, read-only, in three places:
 *
 *   OPEN PROPOSALS   every `param_entry` pending edit still awaiting a
 *                    decision, run through `inspectParameterEntryPayload` —
 *                    the same DB-free rules the review card's preflight and
 *                    both resubmit gates use, so a row listed here is one no
 *                    approval can publish, for any reason, not only this one.
 *                    Plus open `parameter` proposals whose `NumericRange`
 *                    carries a free-text qualifier.
 *   SOURCE VALUES    `parameter_entries.qualifier` outside the operator set.
 *   LIVE PARAMETERS  `drug_parameters.value->>'qualifier'` outside it.
 *
 * The output is a list to act on, not a fix: where the prose belongs (`note`
 * on an authored parameter, `comments` on a source value) and whether it is
 * still worth saying are curation calls, and an open proposal is repaired by
 * its author or returned, never by rewriting the queue underneath them.
 *
 * Usage:
 *   npm run audit:qualifiers
 *   npm run audit:qualifiers -- --check   # exit 1 when anything is found
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { getDb } from '../api/_lib/db';
import {
  effectiveProposalReferenceIds,
  inspectParameterEntryPayload,
} from '../src/lib/parameterEntries';
import { isQualifierOperator, QUALIFIER_OPERATORS } from '../src/types/index';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const check = process.argv.includes('--check');

async function query<T>(text: string): Promise<T[]> {
  const res = await getDb().execute(sql.raw(text));
  return (((res as { rows?: unknown[] }).rows ?? res) as unknown) as T[];
}

interface PendingRow {
  id: number;
  editType: string;
  status: string;
  parameter: string | null;
  targetId: number | null;
  referenceId: number | null;
  referenceIds: number[] | null;
  proposedValue: unknown;
}

interface EntryRow {
  id: number;
  drugId: number;
  parameter: string;
  qualifier: string;
}

interface ParamRow {
  drugId: number;
  parameter: string;
  qualifier: string;
}

/** The qualifier a stored payload carries, whatever shape the payload has. */
function payloadQualifier(proposedValue: unknown): string | null {
  if (!proposedValue || typeof proposedValue !== 'object') return null;
  const pv = proposedValue as Record<string, unknown>;
  for (const holder of [pv.input, pv.patch, pv.value, pv]) {
    if (holder && typeof holder === 'object') {
      const q = (holder as Record<string, unknown>).qualifier;
      if (typeof q === 'string' && q !== '') return q;
    }
  }
  return null;
}

function truncate(s: string, max = 70): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

async function main(): Promise<void> {
  console.log(
    `Valid qualifiers: ${QUALIFIER_OPERATORS.join(' ')} — anything else is prose in a field that takes none.\n`,
  );
  let findings = 0;

  // ── Open proposals ────────────────────────────────────────────────────────
  // A decided row is history: an approved payload was valid when it was
  // applied, a rejected one is closed. Only what a moderator can still be
  // handed is actionable.
  const pending = await query<PendingRow>(`
    SELECT id, edit_type AS "editType", status, parameter,
           target_id AS "targetId", reference_id AS "referenceId",
           reference_ids AS "referenceIds", proposed_value AS "proposedValue"
    FROM pending_edits
    WHERE edit_type IN ('param_entry', 'parameter')
      AND status NOT IN ('approved', 'rejected')
    ORDER BY id`);

  const unpublishable: string[] = [];
  for (const row of pending) {
    if (row.editType === 'param_entry') {
      const problem = inspectParameterEntryPayload(
        {
          parameter: row.parameter,
          targetId: row.targetId,
          referenceIds: effectiveProposalReferenceIds(row),
        },
        row.proposedValue,
      );
      if (problem) {
        const where = problem.fields.length ? ` [${problem.fields.join(', ')}]` : '';
        const q = payloadQualifier(row.proposedValue);
        unpublishable.push(
          `  #${row.id} (${row.status}) ${row.parameter ?? '?'} — ${problem.code}${where}` +
            (q && !isQualifierOperator(q) ? `\n      qualifier: "${truncate(q)}"` : ''),
        );
      }
      continue;
    }
    const q = payloadQualifier(row.proposedValue);
    if (q && !isQualifierOperator(q)) {
      unpublishable.push(
        `  #${row.id} (${row.status}) ${row.parameter ?? '?'} — free-text qualifier: "${truncate(q)}"`,
      );
    }
  }

  console.log(`OPEN PROPOSALS (${pending.length} awaiting a decision)`);
  if (unpublishable.length) {
    findings += unpublishable.length;
    console.log(unpublishable.join('\n'));
    console.log(
      '  → return it with a comment naming the field; the author resubmits with\n' +
        '    the prose moved to `comments`. A reviewer\'s own rewrite is gated by the\n' +
        '    same rules, so it cannot leave the payload in a worse state.',
    );
  } else {
    console.log('  none — every open proposal passes the DB-free approval rules.');
  }

  // ── Source values ─────────────────────────────────────────────────────────
  const entries = (
    await query<EntryRow>(`
      SELECT id, drug_id AS "drugId", parameter, qualifier
      FROM parameter_entries
      WHERE qualifier IS NOT NULL AND qualifier <> ''
      ORDER BY id`)
  ).filter((r) => !isQualifierOperator(r.qualifier));

  console.log(`\nSOURCE VALUES (parameter_entries)`);
  if (entries.length) {
    findings += entries.length;
    for (const r of entries)
      console.log(
        `  entry ${r.id} · drug ${r.drugId} · ${r.parameter} — "${truncate(r.qualifier)}"`,
      );
    console.log('  → move the text into the entry\'s `comments` and clear `qualifier`.');
  } else {
    console.log('  none.');
  }

  // ── Live parameters ───────────────────────────────────────────────────────
  const params = (
    await query<ParamRow>(`
      SELECT drug_id AS "drugId", parameter, value->>'qualifier' AS qualifier
      FROM drug_parameters
      WHERE value ? 'qualifier' AND value->>'qualifier' <> ''
      ORDER BY drug_id, parameter`)
  ).filter((r) => !isQualifierOperator(r.qualifier));

  console.log(`\nLIVE PARAMETERS (drug_parameters)`);
  if (params.length) {
    findings += params.length;
    for (const r of params)
      console.log(`  drug ${r.drugId} · ${r.parameter} — "${truncate(r.qualifier)}"`);
    console.log(
      '  → legacy rows, written before the enum was tightened. `formatRange`\n' +
        '    already ignores them, so nothing is displayed wrong today; clear the\n' +
        '    field (keeping anything still worth saying in `note`) on the next edit.',
    );
  } else {
    console.log('  none.');
  }

  console.log(`\n${findings} finding${findings === 1 ? '' : 's'}.`);
  if (check && findings > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
