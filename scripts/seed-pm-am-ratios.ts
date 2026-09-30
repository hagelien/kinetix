/**
 * Seed the postmortem/antemortem (PM/AM) drug concentration ratios from
 * Mantinieks et al. 2021 (J Anal Toxicol 45:368-377, doi:10.1093/jat/bkaa107)
 * into the multi-value parameter store.
 *
 * One Table I row becomes one `parameter_entries` row for the `pmAmRatio`
 * parameter — the paper's median ratio, its reported range, and its case count
 * — all linked to a single DOI citation for the paper. After the entries are
 * written the drug's `drug_parameters.pmAmRatio` cache is recomputed from them
 * (the cache is derived, never hand-authored).
 *
 * It is an ADMIN / OPERATOR tool. Like scripts/seed-drugs.ts and
 * scripts/import-research-output.ts it writes to the database directly,
 * bypassing the pending-edit review queue. The provenance is still complete:
 * every entry carries the citation, and each recompute records a
 * drug_parameter_revision crediting it, stamped with the operator's approval
 * exactly as the admin-direct API path does.
 *
 * Safety defaults:
 *   - Idempotent by SOURCE OBSERVATION, not by value: the seeder owns at most
 *     one entry per (drug, pmAmRatio, this citation). A corrected transcription
 *     UPDATES that row rather than inserting a second one, so re-running never
 *     double-weights the paper nor strands a stale `n`/comment. The identity
 *     check runs under the per-drug advisory lock inside the write transaction,
 *     since that tuple has no unique constraint to fall back on.
 *   - Updating a seeded row marks any pending update/delete proposal against it
 *     conflicted, so an approval cannot silently revert the correction.
 *   - The DOI citation is matched case-insensitively and reused as is, never
 *     overwritten: a second citation for the same paper would double-weight it.
 *   - Additive: entries from other sources are left alone; the cache is
 *     recomputed over the whole pool, not overwritten with this paper's value.
 *   - Drugs absent from the database are reported and skipped, never created.
 *   - Does NOT require a read-in-full paper review on the source: this bulk
 *     path is operator-vetted, like seed-drugs.ts. It reports a missing review
 *     up front so the operator can queue one, then seeds.
 *   - `--dry-run` validates the dataset and prints the plan without writing
 *     (no DATABASE_URL needed).
 *
 * Usage:
 *   npm run seed:pm-am-ratios
 *   npm run seed:pm-am-ratios -- --dry-run
 *   npm run seed:pm-am-ratios -- --user-email me@example.com
 *   DATABASE_URL=... npm run seed:pm-am-ratios
 */
import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  drugs,
  paperReviews,
  parameterEntries,
  users,
} from '../db/schema';
import { getDb, runInPoolTransaction } from '../api/_lib/db';
import { parameterWriteBlockedBy } from '../api/_lib/parameterApplicabilityStore';
import {
  insertParameterEntry,
  recomputeParameterAndDependents,
  updateParameterEntryRow,
} from '../api/_lib/parameter-entries-store';
import { markEntryMutationsConflicted } from '../api/_lib/entry-conflicts';
import { recordApproval } from '../api/_lib/approvals';
import { resolveCitation } from '../api/_lib/citation-store';
import { resolveOneCrosswalk } from '../api/_lib/citation-crosswalk';
import { recordImplicitAgentApproval } from '../api/_lib/agent-verifications';
import {
  loadPmAmDataset,
  seededReadingFor,
  storedEntryMatches,
  toParameterEntryInput,
  PM_AM_PARAMETER,
  type PmAmDataset,
  type PmAmRow,
  type StoredEntryFields,
} from './pm-am-ratios/dataset';

const DEFAULT_USER_EMAIL = process.env.IMPORT_USER_EMAIL ?? 'agent@kinetix.internal';

interface Options {
  dryRun: boolean;
  userEmail: string;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { dryRun: false, userEmail: DEFAULT_USER_EMAIL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--user-email') opts.userEmail = argv[++i] ?? opts.userEmail;
    else if (a.startsWith('--user-email=')) {
      opts.userEmail = a.slice('--user-email='.length);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

/**
 * Resolve the paper's citation row, creating it only if this paper has none.
 *
 * Goes through `resolveCitation` (#1018) so this seeder cannot mint a second
 * row for a paper Kinetix already knows. That matters twice over here:
 *
 *   - **Case.** A DOI is case-insensitive by specification, but
 *     `citations.identifier` is plain text and its unique index is
 *     case-sensitive, so `10.1093/JAT/BKAA107` and `10.1093/jat/bkaa107` would
 *     be two rows. `resolveCitation` compares DOIs case-insensitively.
 *   - **Handle.** The same paper may already be filed under its PMID. A second
 *     DOI row would carry its own entries — double-weighting this paper's
 *     evidence — and hide the first row's paper review, including the
 *     `read_in_full` attestation the parameter gate reads.
 *
 * An existing row's metadata wins field by field: it may have been resolved
 * from CrossRef or curated by a human, and this dataset's hand-transcribed
 * record must not overwrite it. Fields the existing row lacks are filled in.
 */
async function ensureCitation(dataset: PmAmDataset): Promise<number> {
  const db = getDb();
  const { type, identifier, ...rest } = dataset.source;

  // Which other handles this paper answers to, so a PMID row for the same
  // article is recognized. Best-effort: if NCBI does not answer, the DOI is
  // used on its own, exactly as before.
  const crosswalk = {
    // The dataset's own publisher link is a handle too — kept as an alt id so
    // it stays searchable and cannot become a separate `url` citation later.
    url: rest.url,
    ...(await resolveOneCrosswalk({ type, identifier })),
  };

  const resolved = await resolveCitation(
    db,
    {
      type,
      identifier,
      crosswalk,
      metadata: {
        title: rest.title,
        authors: rest.authors,
        journal: rest.journal,
        year: rest.year,
        volume: rest.volume,
        pages: rest.pages,
      },
    },
    null,
  );

  if (!resolved.created) {
    console.log(
      `  citation   : reusing existing row #${resolved.id} (${resolved.type}:${resolved.identifier})`,
    );
  }
  if (resolved.promotedFrom) {
    console.log(
      `  citation   : re-filed from ${resolved.promotedFrom.type}:${resolved.promotedFrom.identifier} ` +
        `to ${resolved.type}:${resolved.identifier}`,
    );
  }
  for (const mergedId of resolved.mergedIds) {
    console.log(`  citation   : merged split row #${mergedId} into #${resolved.id}`);
  }
  return resolved.id;
}

async function resolveActorUserId(email: string): Promise<number> {
  const [row] = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!row) {
    throw new Error(
      `No user with email "${email}". Pass --user-email <address> for an existing account.`,
    );
  }
  return row.id;
}

/**
 * Report whether the source carries a read-in-full paper review.
 *
 * The API's contributor path gates parameter values on that review
 * (`assertReferencesJudged`). This bulk-seed path deliberately does NOT — the
 * operator has vetted the paper by transcribing its table, the same standing
 * as `seed-drugs.ts` and `import-research-output.ts`, which bypass the queue
 * outright. So this only informs, and it runs BEFORE the writes: a notice that
 * arrives after 42 committed entries tells the operator nothing they can act
 * on, whereas one printed up front lets them stop and queue the review first.
 */
async function reportSourceReviewStatus(citationId: number): Promise<void> {
  const [review] = await getDb()
    .select({ readInFull: paperReviews.readInFull })
    .from(paperReviews)
    .where(eq(paperReviews.citationId, citationId))
    .limit(1);
  const gap = !review
    ? 'has no paper review yet'
    : !review.readInFull
      ? 'has a paper review that is not marked read-in-full'
      : null;
  if (!gap) return;
  console.warn(
    `\n! The source ${gap}. Seeding anyway (this path does not require one), but\n` +
      '  queueing it for the paper-review agent will strengthen the seeded entries.\n',
  );
}

interface MatchedDrug {
  id: number;
  /** Display name, for the operator to eyeball the CID match against. */
  name: string;
}

/**
 * Map every dataset CID to a drug in one query.
 *
 * Matching on `pubchem_cid` rather than name is what lets the paper's English
 * analyte names resolve against Norwegian-named drug rows. The trade-off is
 * that a mistyped CID matches the WRONG drug silently instead of not matching
 * at all, so the caller prints the resolved name next to the paper's — one
 * transposed digit in this dataset pointed at an unrelated peptide.
 */
async function loadDrugsByCid(
  rows: readonly PmAmRow[],
): Promise<Map<number, MatchedDrug>> {
  const cids = rows.map((r) => r.pubchemCid);
  const found = await getDb()
    .select({ id: drugs.id, pubchemCid: drugs.pubchemCid, names: drugs.names })
    .from(drugs)
    .where(inArray(drugs.pubchemCid, cids));
  const byCid = new Map<number, MatchedDrug>();
  for (const d of found) {
    if (d.pubchemCid == null) continue;
    const names = d.names ?? {};
    byCid.set(d.pubchemCid, {
      id: d.id,
      name: names.nb ?? names.en ?? Object.values(names)[0] ?? `#${d.id}`,
    });
  }
  return byCid;
}

type ExistingEntry = StoredEntryFields & { id: number };

/**
 * The entries this seeder owns for one drug: `pmAmRatio` rows citing this
 * paper. Identity is (drug, parameter, citation) — the source observation —
 * NOT the value, so a corrected number still resolves to the same row instead
 * of looking like a new independent study.
 */
async function findSeededEntries(
  drugId: number,
  citationId: number,
): Promise<ExistingEntry[]> {
  return getDb()
    .select({
      id: parameterEntries.id,
      low: parameterEntries.low,
      high: parameterEntries.high,
      median: parameterEntries.median,
      centralValue: parameterEntries.centralValue,
      centralStatistic: parameterEntries.centralStatistic,
      intervalKind: parameterEntries.intervalKind,
      unit: parameterEntries.unit,
      n: parameterEntries.n,
      comments: parameterEntries.comments,
    })
    .from(parameterEntries)
    .where(
      and(
        eq(parameterEntries.drugId, drugId),
        eq(parameterEntries.parameter, PM_AM_PARAMETER),
        eq(parameterEntries.citationId, citationId),
      ),
    );
}

/**
 * Recompute the cached aggregate and stamp the resulting revision, mirroring
 * the admin-direct API path (api/parameter-entries.ts `recomputeCache`). Without
 * the stamp the live revision stays an unapproved level-0 row that the peer
 * verification sweep never offers for review.
 */
async function recomputeAndStamp(
  drugId: number,
  actorUserId: number,
): Promise<void> {
  const revisionId = await recomputeParameterAndDependents(
    drugId,
    PM_AM_PARAMETER,
    actorUserId,
    { approvedBy: actorUserId },
  );
  if (revisionId == null) return;
  await recordApproval({
    targetType: 'drug_parameter_revision',
    targetId: revisionId,
    approvedBy: actorUserId,
  });
  // No-ops for a plain human operator; records the stake when the acting
  // account is an active agent.
  await recordImplicitAgentApproval({
    userId: actorUserId,
    targetType: 'drug_parameter_revision',
    targetId: revisionId,
  });
}

function printDataset(dataset: PmAmDataset, dryRun: boolean): void {
  const s = dataset.source;
  console.log(
    `PM/AM ratio seed${dryRun ? ' (dry run)' : ''}: ${s.title} — ${s.journal} ${s.year};${s.volume}(${s.issue}):${s.pages}`,
  );
  console.log(`  doi        : ${s.identifier}`);
  console.log(`  parameter  : ${PM_AM_PARAMETER}`);
  console.log(`  rows       : ${dataset.entries.length} analytes, ${dataset.study.cases} coronial cases`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const dataset = loadPmAmDataset();
  printDataset(dataset, opts.dryRun);

  if (opts.dryRun) {
    // Validate every row's entry payload against the live parameter registry —
    // the same schema the write path applies — using placeholder ids.
    for (const row of dataset.entries) {
      toParameterEntryInput(row, 1, 1);
      console.log(
        `  - ${row.drug.padEnd(24)} CID ${String(row.pubchemCid).padEnd(10)} ${row.pubchemName.padEnd(24)} ${row.median} (${row.low}-${row.high})  n=${row.n}`,
      );
    }
    console.log('\nDry run: dataset is valid, nothing written.');
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required (omit only with --dry-run).');
    process.exit(1);
  }

  const actorUserId = await resolveActorUserId(opts.userEmail);
  const citationId = await ensureCitation(dataset);
  await reportSourceReviewStatus(citationId);
  const drugByCid = await loadDrugsByCid(dataset.entries);

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  // Rows withheld because the pair is not a defined quantity for the
  // substance. Reported, not dropped silently — see the other bulk writers.
  const notApplicable: string[] = [];
  const missing: string[] = [];
  const ambiguous: string[] = [];

  for (const row of dataset.entries) {
    const drug = drugByCid.get(row.pubchemCid);
    if (!drug) {
      missing.push(`${row.drug} (CID ${row.pubchemCid})`);
      continue;
    }
    const drugId = drug.id;
    const input = toParameterEntryInput(row, drugId, citationId);

    // Cheap pre-check so an already-current row costs one SELECT instead of an
    // opened transaction. It is only a fast path — the authoritative decision is
    // made again under the drug lock below, because this read is unsynchronized.
    const preview = await findSeededEntries(drugId, citationId);
    if (preview.length === 1 && storedEntryMatches(preview[0]!, input)) {
      unchanged += 1;
      continue;
    }

    // Everything that decides AND performs the write happens inside one
    // transaction that first takes the drug's advisory lock.
    //
    // Without the lock the identity lookup is a TOCTOU: `parameter_entries` has
    // no unique constraint on (drug, parameter, citation), so two overlapping
    // seeder runs could both read "no row" and both insert, double-weighting
    // this paper. Recompute takes the same lock, so re-taking it here just
    // widens the critical section to cover the decision as well (advisory xact
    // locks are re-entrant within a transaction).
    const outcome = await runInPoolTransaction(async () => {
      await getDb().execute(
        sql`SELECT pg_advisory_xact_lock(${drugId}::bigint)`,
      );
      // Not a defined quantity for this substance. `insertParameterEntry`
      // throws on this now, which would abort the whole run — a seeder should
      // skip the row and report it, like the other bulk writers. Checked
      // inside the existing locked transaction, so it cannot race a marker.
      if (
        await parameterWriteBlockedBy(getDb(), drugId, input.parameter)
      ) {
        return { kind: 'not-applicable' as const };
      }

      const existing = await findSeededEntries(drugId, citationId);
      if (existing.length > 1) {
        // Someone (or an earlier value-keyed run) left more than one row for
        // this source observation. Picking one to update would silently keep the
        // paper double-weighted, so surface it for a human instead.
        return { kind: 'ambiguous' as const, ids: existing.map((e) => e.id) };
      }
      const current = existing[0];
      if (current && storedEntryMatches(current, input)) {
        return { kind: 'unchanged' as const };
      }
      if (current) {
        const next = seededReadingFor(current, input);
        if (!next.ok) {
          return { kind: 'curated' as const, id: current.id, reason: next.reason };
        }
        await updateParameterEntryRow(current.id, {
          ...next.reading,
          unit: input.unit,
          n: input.n,
          comments: input.comments,
          citationId,
        });
        // A contributor may have a pending update/delete queued against this
        // entry, holding a snapshot of the values we just corrected. Approving
        // it later would silently revert the correction (or delete the row), so
        // flag it stale in the same transaction — exactly what the direct-write
        // routes in api/parameter-entries.ts do.
        await markEntryMutationsConflicted(current.id);
      } else {
        await insertParameterEntry(input, actorUserId, 'contributor');
      }
      await recomputeAndStamp(drugId, actorUserId);
      return { kind: current ? ('updated' as const) : ('inserted' as const) };
    });

    // The resolved drug name is printed on every write so a mistyped CID —
    // which matches the wrong drug rather than nothing — is visible in the log.
    const label = `${row.drug} → ${drug.name}`;
    const value = `${row.median} (${row.low}-${row.high}), n=${row.n}`;
    if (outcome.kind === 'not-applicable') {
      notApplicable.push(label);
    } else if (outcome.kind === 'ambiguous') {
      ambiguous.push(
        `${label}: ${outcome.ids.length} entries cite this paper (ids ${outcome.ids.join(', ')})`,
      );
    } else if (outcome.kind === 'curated') {
      ambiguous.push(
        `${label}: entry ${outcome.id} was labelled by a curator, and the labels no longer fit the dataset's ${value} (${outcome.reason})`,
      );
    } else if (outcome.kind === 'unchanged') {
      unchanged += 1;
    } else if (outcome.kind === 'updated') {
      updated += 1;
      console.log(`  ~ ${label}: updated to ${value}`);
    } else {
      inserted += 1;
      console.log(`  + ${label}: ${value}`);
    }
  }

  console.log('');
  console.log(`Inserted: ${inserted}`);
  console.log(`Updated:  ${updated}`);
  console.log(`Same:     ${unchanged}`);
  if (notApplicable.length > 0) {
    console.warn(
      `Not applicable (${notApplicable.length}, skipped): ${notApplicable.join(', ')}`,
    );
  }
  if (missing.length > 0) {
    console.warn(
      `Drug not in database (${missing.length}, skipped): ${missing.join(', ')}`,
    );
    console.warn(
      'Add the substance first, then re-run — the seeder is idempotent.',
    );
  }
  if (ambiguous.length > 0) {
    console.warn(`\nNeeds a human (${ambiguous.length}, skipped):`);
    for (const line of ambiguous) console.warn(`  ! ${line}`);
    console.warn(
      'Delete redundant entries so one row per source observation remains, or relabel a curated entry to fit the corrected numbers, then re-run.',
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
