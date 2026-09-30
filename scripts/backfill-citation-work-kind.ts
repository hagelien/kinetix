/**
 * Ask the registries what each existing citation identifies, and store it
 * (§13.3, migration 0107).
 *
 * Dry-run by default; `--apply` writes. `--limit N` bounds one run.
 *
 * ## Why a script and not part of the migration
 *
 * The classification comes from Crossref, DataCite and PubMed. A migration runs
 * inside the deploy, against a database it must not spend ten thousand HTTP
 * round-trips inside, and with no way to resume when NCBI rate-limits it
 * halfway through. It also cannot be re-run when a mapping changes, and this
 * mapping will change — the two provider vocabularies grow.
 *
 * ## Why it is not the only way a row gets classified
 *
 * Admission resolves lazily when it meets an unresolved row, so a citation
 * created after this run is classified when it is first used rather than left
 * for the next backfill. This exists so the first admission is not also the
 * first fetch, and so the residue — rows no registry can answer for — is
 * visible before someone hits it.
 *
 * ## What it will and will not do
 *
 * - **Asks** every citation whose stored classification does not cover its
 *   current handles: unresolved rows, and rows that acquired a handle since.
 * - **Skips** rows with no askable handle at all (`freetext`, and a `url` that
 *   is not a resolver). Nothing can classify them; they stay unresolved, which
 *   is the state admission refuses.
 * - **Never overwrites a settled answer with silence.** A row whose registries
 *   are unreachable is reported as unanswered and left exactly as it was, so a
 *   backfill run during an outage cannot downgrade the catalog.
 * - **Reports conflicts rather than resolving them.** Two registries
 *   disagreeing about what an object is, is a curation question; the row is
 *   stored `conflicted` and listed for a human.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { getDb } from '../api/_lib/db.js';
import {
  readClassification,
  resolveCitationWorkKind,
  type CitationClassificationRow,
} from '../api/_lib/citation-work-kind.js';

const APPLY = process.argv.includes('--apply');

function parseLimit(argv: readonly string[]): number | null {
  const index = argv.indexOf('--limit');
  if (index === -1) return null;
  const value = Number(argv[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * NCBI asks for no more than three requests a second without an API key, and a
 * backfill is the one caller that can trip that on its own. One row at a time
 * with a pause between them keeps the whole run under the ceiling without
 * needing to know which providers each row will reach.
 */
const PAUSE_MS = 400;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface BackfillCounts {
  scanned: number;
  alreadyCurrent: number;
  noHandles: number;
  resolved: number;
  conflicted: number;
  unanswered: number;
  raced: number;
}

async function main() {
  const db = getDb();
  const limit = parseLimit(process.argv);

  const rows = await db.execute<{
    id: number;
    type: string;
    identifier: string;
    metadata: unknown;
    work_kind: string | null;
    work_kind_status: string;
    work_kind_handles: string[] | null;
    work_kind_verdicts: unknown;
  }>(sql`
    SELECT "id", "type", "identifier", "metadata",
           "work_kind", "work_kind_status", "work_kind_handles",
           "work_kind_verdicts"
      FROM "citations"
     ORDER BY "id"
  `);

  const counts: BackfillCounts = {
    scanned: 0,
    alreadyCurrent: 0,
    noHandles: 0,
    resolved: 0,
    conflicted: 0,
    unanswered: 0,
    raced: 0,
  };
  const conflicts: number[] = [];
  let asked = 0;

  for (const raw of rows.rows) {
    const row: CitationClassificationRow = {
      id: Number(raw.id),
      type: raw.type,
      identifier: raw.identifier,
      metadata: raw.metadata,
      workKind: raw.work_kind,
      workKindStatus: raw.work_kind_status,
      workKindHandles: raw.work_kind_handles,
      workKindVerdicts: raw.work_kind_verdicts,
    };
    counts.scanned += 1;

    const stored = readClassification(row);
    if (stored.current) {
      counts.alreadyCurrent += 1;
      continue;
    }
    if (stored.handles.length === 0) {
      counts.noHandles += 1;
      continue;
    }
    if (limit !== null && asked >= limit) continue;

    if (!APPLY) {
      // A dry run says which rows would be asked, not what they would answer:
      // finding that out is the network cost the run is deciding whether to
      // spend.
      console.log(
        `would ask citation ${row.id} (${row.type}:${row.identifier}) via ${stored.handles.join(', ')}`,
      );
      asked += 1;
      continue;
    }

    if (asked > 0) await sleep(PAUSE_MS);
    asked += 1;
    const result = await resolveCitationWorkKind(db, row.id);
    switch (result.outcome) {
      case 'stored':
        if (result.classification.status === 'conflicted') {
          counts.conflicted += 1;
          conflicts.push(row.id);
        } else {
          counts.resolved += 1;
        }
        break;
      case 'unanswered':
        counts.unanswered += 1;
        break;
      case 'raced':
        counts.raced += 1;
        break;
      case 'no_handles':
        counts.noHandles += 1;
        break;
      case 'current':
        counts.alreadyCurrent += 1;
        break;
    }
  }

  console.log(
    `${APPLY ? 'applied' : 'dry run'}: ${counts.scanned} citation(s) scanned, ` +
      `${counts.alreadyCurrent} already current, ${counts.noHandles} with no askable handle, ` +
      `${asked} asked`,
  );
  if (APPLY) {
    console.log(
      `resolved ${counts.resolved}, conflicted ${counts.conflicted}, ` +
        `unanswered ${counts.unanswered}, raced ${counts.raced}`,
    );
    if (conflicts.length > 0) {
      // Named rather than counted: each one is a registry disagreement a human
      // has to settle before any cohort can rest on it.
      console.log(`conflicting classifications: ${conflicts.join(', ')}`);
    }
    if (counts.raced > 0) {
      console.log(
        'raced rows had their handles change mid-resolve; re-run to pick them up',
      );
    }
  } else {
    console.log('re-run with --apply to store the classifications');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
