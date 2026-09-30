/**
 * Act on `audit:citations` — repoint what is repairable, remove what is not.
 *
 * The audit sorts every reference into verdicts and stops there, because
 * deciding is a curation call. This is the other half: once that call has been
 * made, this carries it out. It reads the audit's own JSON report rather than
 * re-deciding anything, so what it does is exactly what was reviewed.
 *
 * Two operations, and they are not symmetrical.
 *
 * REPOINT (`wrong-handle`) is cheap and safe. The paper is real, the value it
 * backs stands, only the pointer was wrong. The row's handle is moved to the
 * identifier the audit found it under and its metadata refetched from the
 * registry. Where a citation for that identifier ALREADY exists — and it often
 * does, because a real paper tends to be cited more than once — the two are
 * merged through `mergeCitations` rather than updated, since `(type,
 * identifier)` is unique and an update would collide.
 *
 * DELETE (`unfindable`, `dead-handle`) destroys data, and the policy it
 * implements is the operator's, not this script's:
 *
 *   - a parameter entry or fact that has OTHER, sound references loses only
 *     the bad reference and survives;
 *   - one whose ONLY support was the bad reference is assumed erroneous and
 *     goes with it.
 *
 * For parameters that falls out of the existing machinery rather than being
 * re-implemented here: delete the entries, then call
 * `recomputeAndCacheParameterSummary`, which repools the survivors and clears
 * the published value when none remain — recording a revision either way, so
 * the deletion is in the history rather than merely absent from the table.
 * Facts are `reference_ids` arrays on the relationship tables; the bad id is
 * removed with the array's order preserved, and a row left with an empty array
 * is deleted.
 *
 * **Nothing is deleted before it is written down.** Every affected row is
 * dumped to a backup JSON before the first delete, and the run refuses to
 * proceed if that file cannot be written. A restore is a manual job, but it is
 * a possible one, which a cascade is not.
 *
 * **`--dry-run` is the default.** `--apply` is required to write, and with it
 * `--actor <userId>`: the parameter revisions this produces are attributed to a
 * person, and the script will not pick one for you.
 *
 * Usage:
 *   npm run repair:citations -- --report report.json
 *   npm run repair:citations -- --report report.json --only repoint
 *   npm run repair:citations -- --report report.json --apply --actor 2
 */
import 'dotenv/config';
import fs from 'node:fs';
import { sql, type SQL } from 'drizzle-orm';
import { getDb } from '../api/_lib/db';
import { mergeCitations } from '../api/_lib/citation-merge';
import { fetchRecords } from '../api/_lib/pubmed-eutils';
import { fetchCrossRefMetadata } from '../api/_lib/crossref';
import {
  recomputeAndCacheParameterSummary,
  isNormalizationInput,
  recomputeSummariesForDrug,
} from '../api/_lib/parameter-entries-store';
import {
  isDrugParameterId,
  type DrugParameterId,
} from '../src/lib/drugParameters';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

/** The relationship tables that carry a `reference_ids` array — the "facts". */
const FACT_TABLES = [
  { table: 'drug_receptor_targets', key: 'id' },
  { table: 'drug_metabolism_profiles', key: 'drug_id' },
  { table: 'drug_elimination_routes', key: 'id' },
  { table: 'drug_enzyme_interactions', key: 'id' },
  { table: 'drug_ionization_constants', key: 'id' },
  { table: 'drug_metabolites', key: 'id' },
] as const;

/**
 * A literal `int[]` for a list of citation ids.
 *
 * Interpolating a JS array into drizzle's `sql` expands it into a tuple of
 * bind parameters — `ANY(($1, $2, …))` — which Postgres rejects with "op
 * ANY/ALL (array) requires array on right side". At a thousand ids it also
 * pushes the statement past what is sensible to bind.
 *
 * So the array is emitted as a literal. That is only safe because every id is
 * checked to be a non-negative safe integer first: these come from a JSON
 * report file, which is not a trusted source just because this script wrote
 * the last one. A non-integer is a bug or a tampered report, and either way
 * the run stops rather than building SQL out of it.
 */
function intArray(ids: number[]): SQL {
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id < 0) {
      throw new Error(
        `Refusing to build SQL from a non-integer id: ${String(id)}`,
      );
    }
  }
  return sql.raw(
    ids.length === 0 ? "'{}'::int[]" : `'{${ids.join(',')}}'::int[]`,
  );
}

interface Finding {
  id: number;
  type: string;
  identifier: string;
  verdict: string;
  storedTitle: string;
  suggestedPmid: string | null;
  suggestedDoi: string | null;
  parameterEntries: number;
}

interface Repoint {
  citationId: number;
  fromType: string;
  fromIdentifier: string;
  toType: 'pmid' | 'doi';
  toIdentifier: string;
  storedTitle: string;
}

function arg(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] ?? null) : null;
}

function loadReport(path: string): Finding[] {
  if (!fs.existsSync(path)) {
    console.error(
      `No report at ${path} — run \`npm run audit:citations\` first.`,
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(path, 'utf8')) as Finding[];
}

/**
 * The repoints the report supports, preferring a PMID over a DOI.
 *
 * Both handles name the same paper when both were found, and PubMed is the
 * registry the rest of this codebase is built around — the full-text
 * acquisition path, the crosswalk, the MCP tools. A DOI is the fallback for
 * what PubMed does not index, which is exactly why the Crossref stage exists.
 */
function repointsFrom(findings: Finding[]): Repoint[] {
  const out: Repoint[] = [];
  for (const f of findings) {
    if (f.verdict !== 'wrong-handle') continue;
    const target = f.suggestedPmid
      ? { toType: 'pmid' as const, toIdentifier: f.suggestedPmid }
      : f.suggestedDoi
        ? { toType: 'doi' as const, toIdentifier: f.suggestedDoi }
        : null;
    if (!target) continue;
    if (target.toType === f.type && target.toIdentifier === f.identifier)
      continue;
    out.push({
      citationId: f.id,
      fromType: f.type,
      fromIdentifier: f.identifier,
      storedTitle: f.storedTitle,
      ...target,
    });
  }
  return out;
}

/**
 * Condemned citations that must NOT be deleted, because a repointed row's
 * recovered evidence has been, or would be, folded onto them.
 *
 * The two stages can disagree about the same row. A citation whose metadata is
 * fabricated is condemned on its metadata — but its HANDLE may be a real paper,
 * and a `wrong-handle` row resolving to that same paper lands on it. The row
 * then holds both fabricated evidence and recovered evidence, and no rule here
 * can tell which entry is which; only someone reading them can.
 *
 * Deleting it would destroy what the repoint stage just recovered. So it is
 * withheld from the batch and named, every run, whichever stage ran first.
 */
function protectedFromDeletion(
  findings: Finding[],
  deletes: Finding[],
): Map<number, Finding> {
  const byHandle = new Map<string, Finding>();
  for (const f of deletes) byHandle.set(`${f.type}:${f.identifier}`, f);

  const out = new Map<number, Finding>();
  for (const f of findings) {
    if (f.verdict !== 'wrong-handle') continue;
    const target = f.suggestedPmid
      ? `pmid:${f.suggestedPmid}`
      : f.suggestedDoi
        ? `doi:${f.suggestedDoi}`
        : null;
    if (!target) continue;
    const condemned = byHandle.get(target);
    if (condemned) out.set(condemned.id, condemned);
  }
  return out;
}

function deletionsFrom(findings: Finding[]): Finding[] {
  return findings.filter(
    (f) => f.verdict === 'unfindable' || f.verdict === 'dead-handle',
  );
}

// ─── Authoritative metadata for a repoint target ────────────────────────────

interface Metadata {
  title: string;
  authors: string[];
  journal: string;
  year: number | null;
  volume: string | null;
  pages: string | null;
}

async function metadataFor(
  type: 'pmid' | 'doi',
  identifier: string,
): Promise<Metadata | null> {
  if (type === 'pmid') {
    const [record] = await fetchRecords([identifier]);
    if (!record) return null;
    return {
      title: record.title,
      authors: record.authors,
      journal: record.journalAbbrev ?? record.journal,
      year: record.year,
      volume: record.volume,
      pages: record.pages,
    };
  }
  const work = await fetchCrossRefMetadata(identifier);
  if (!work) return null;
  return {
    title: work.title,
    authors: work.authors,
    journal: work.journal,
    year: work.year,
    volume: work.volume,
    pages: work.pages,
  };
}

// ─── Backup ─────────────────────────────────────────────────────────────────

/**
 * Everything the delete stage is about to destroy, written before it starts.
 *
 * Not a substitute for a database backup, and not automatically restorable:
 * it is the record of what was removed, keyed so a row can be put back by
 * hand. Cheap to produce and the only thing standing between a mistaken
 * verdict and an unrecoverable one.
 */
async function writeBackup(path: string, citationIds: number[]): Promise<void> {
  const db = getDb();
  const bundle: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    citationIds,
  };

  bundle.citations = (
    await db.execute(sql`
      SELECT * FROM citations WHERE id = ANY(${intArray(citationIds)})
    `)
  ).rows;
  bundle.parameterEntries = (
    await db.execute(sql`
      SELECT * FROM parameter_entries WHERE citation_id = ANY(${intArray(citationIds)})
    `)
  ).rows;
  for (const { table } of FACT_TABLES) {
    bundle[table] = (
      await db.execute(
        sql`SELECT * FROM ${sql.identifier(table)} WHERE reference_ids && ${intArray(citationIds)}`,
      )
    ).rows;
  }

  fs.writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`);
}

// ─── Stages ─────────────────────────────────────────────────────────────────

interface RepointPlan extends Repoint {
  /** The citation holding the target handle that this row folds into, if any. */
  mergeInto: number | null;
  metadata: Metadata | null;
  /** Already carries the target handle — an earlier run moved it. */
  alreadyDone: boolean;
  /** Condemned citation holding this target handle: fold refused, needs a human. */
  blockedBy: number | null;
}

/**
 * Resolve each repoint to one of three outcomes, against the database as it is
 * NOW rather than as the report found it.
 *
 * Two things make that necessary, and both were found the hard way by a run
 * that half-applied and then aborted on a unique-key violation.
 *
 * **Several rows can want the same target.** They usually do: the same real
 * paper was cited under a different fabricated identifier each time. One
 * reference — Schulz et al., *Therapeutic and toxic blood concentrations of
 * nearly 1,000 drugs* — was stored under fifteen invented PMIDs. The first row
 * of such a group takes the handle; the rest merge into it, because
 * `(type, identifier)` is unique and the second update would collide. Which is
 * the right answer anyway: they were always one reference.
 *
 * **A repoint may already have happened.** An aborted run leaves rows moved,
 * so a row whose live handle already equals its target is reported done and
 * skipped. That makes the stage re-runnable, which a partially applied batch
 * needs more than anything else.
 */
async function planRepoints(
  repoints: Repoint[],
  condemned: ReadonlySet<number>,
): Promise<RepointPlan[]> {
  const db = getDb();

  // One read of every row's CURRENT handle. The report says where each was;
  // only the database says where each is.
  const live = new Map<number, string>();
  for (const row of (
    await db.execute<{ id: number; type: string; identifier: string }>(sql`
      SELECT id, type, identifier FROM citations
       WHERE id = ANY(${intArray(repoints.map((r) => r.citationId))})
    `)
  ).rows) {
    live.set(row.id, `${row.type}:${row.identifier}`);
  }

  const plans: RepointPlan[] = [];
  // Rows wanting the same handle, in report order — the first is the one that
  // takes it.
  const byTarget = new Map<string, Repoint[]>();
  for (const r of repoints) {
    const key = `${r.toType}:${r.toIdentifier}`;
    const group = byTarget.get(key) ?? [];
    group.push(r);
    byTarget.set(key, group);
  }

  let planned = 0;
  for (const [key, group] of byTarget) {
    const [first] = group;
    if (!first) continue;

    const existing = (
      await db.execute<{ id: number }>(sql`
        SELECT id FROM citations
         WHERE type = ${first.toType} AND identifier = ${first.toIdentifier}
         LIMIT 1
      `)
    ).rows[0];
    const metadata = await metadataFor(first.toType, first.toIdentifier);

    // Whichever row ends up HOLDING the target handle is what the others fold
    // into: a citation that already had it, else the first of the group.
    // A citation the delete stage is going to remove must never become the
    // holder. Folding a recovered row into one moves real evidence onto a row
    // queued for destruction, and the deletion then takes both.
    //
    // This is not hypothetical. `pmid:26227253` is a real paper — Gjerde et
    // al., "Driving Under the Influence of Non-Alcohol Drugs, Part I" — held
    // by citation 1648 under a fabricated GHB title, and therefore condemned.
    // Citation 2486 carried that paper's real title under an invented PMID,
    // resolved correctly onto 26227253, and was folded into 1648. One
    // legitimate parameter entry moved onto a row about to be deleted.
    let holder = existing && !condemned.has(existing.id) ? existing.id : null;
    const blockedHolder =
      existing && condemned.has(existing.id) ? existing.id : null;
    for (const r of group) {
      if (!live.has(r.citationId)) {
        // The row is gone — an earlier run folded it into the holder already.
        // Reported as done, and never eligible to BE the holder: making a
        // deleted citation the target would fold the rest of the group into
        // nothing.
        plans.push({
          ...r,
          mergeInto: null,
          metadata,
          alreadyDone: true,
          blockedBy: null,
        });
        continue;
      }
      if (live.get(r.citationId) === key) {
        // Already moved by an earlier run. It is now the holder, and anything
        // else in the group merges into it.
        plans.push({
          ...r,
          mergeInto: null,
          metadata,
          alreadyDone: true,
          blockedBy: null,
        });
        holder ??= r.citationId;
        continue;
      }
      if (blockedHolder !== null) {
        // The handle belongs to a condemned row. Neither folding into it nor
        // taking the handle from under it is this script's call to make: the
        // condemned row's own evidence and this row's have to be separated by
        // someone who can read them.
        plans.push({
          ...r,
          mergeInto: null,
          metadata,
          alreadyDone: false,
          blockedBy: blockedHolder,
        });
        continue;
      }
      if (holder === null || holder === r.citationId) {
        plans.push({
          ...r,
          mergeInto: null,
          metadata,
          alreadyDone: false,
          blockedBy: null,
        });
        holder = r.citationId;
      } else {
        plans.push({
          ...r,
          mergeInto: holder,
          metadata,
          alreadyDone: false,
          blockedBy: null,
        });
      }
    }
    process.stderr.write(
      `  planning repoints: ${(planned += group.length)}/${repoints.length}\r`,
    );
  }
  if (repoints.length > 0) process.stderr.write('\n');
  return plans;
}

/**
 * Updates first, merges second.
 *
 * A merge folds one citation into the one HOLDING the target handle, so the
 * holder has to hold it before anything can be folded in. Planning marks the
 * first row of a group as the holder; if its update ran after the merges, they
 * would all fold into a row that still carried its fabricated identifier.
 */
async function applyRepoints(
  plans: RepointPlan[],
  actorUserId: number,
): Promise<{ updated: number; merged: number; skipped: number; done: number }> {
  const db = getDb();
  let updated = 0;
  let merged = 0;
  let skipped = 0;
  let done = 0;

  const updates = plans.filter(
    (p) => !p.alreadyDone && p.mergeInto === null && p.blockedBy === null,
  );
  const merges = plans.filter((p) => !p.alreadyDone && p.mergeInto !== null);
  done = plans.filter((p) => p.alreadyDone).length;

  for (const plan of updates) {
    if (!plan.metadata) {
      // The registry would not vouch for the target either. Leaving the row
      // alone is strictly better than moving it to a second unverified handle.
      skipped++;
      continue;
    }
    await db.execute(sql`
      UPDATE citations
         SET type = ${plan.toType},
             identifier = ${plan.toIdentifier},
             metadata = ${JSON.stringify(plan.metadata)}::jsonb
       WHERE id = ${plan.citationId}
    `);
    updated++;
    process.stderr.write(`  repointing: ${updated}/${updates.length}\r`);
  }
  if (updates.length > 0) process.stderr.write('\n');

  for (const plan of merges) {
    if (plan.mergeInto === null) continue;
    await mergeCitations(db, plan.mergeInto, plan.citationId, { actorUserId });
    merged++;
    process.stderr.write(`  merging: ${merged}/${merges.length}\r`);
  }
  if (merges.length > 0) process.stderr.write('\n');

  return { updated, merged, skipped, done };
}

interface DeletePlan {
  citationIds: number[];
  entryCount: number;
  affectedPairs: Array<{ drugId: number; parameter: string }>;
  pairsLosingEverything: number;
  facts: Array<{ table: string; touched: number; emptied: number }>;
}

async function planDeletes(citationIds: number[]): Promise<DeletePlan> {
  const db = getDb();
  const entries = (
    await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM parameter_entries
       WHERE citation_id = ANY(${intArray(citationIds)})
    `)
  ).rows[0];

  const pairs = (
    await db.execute<{ drug_id: number; parameter: string }>(sql`
      SELECT DISTINCT drug_id, parameter FROM parameter_entries
       WHERE citation_id = ANY(${intArray(citationIds)})
    `)
  ).rows;

  // A pair whose every entry cites a doomed citation publishes nothing once
  // they are gone — the recompute clears it. Counted here so the dry run can
  // say how many values disappear, rather than only how many rows do.
  const orphaned = (
    await db.execute<{ n: number }>(sql`
      WITH doomed AS (
        SELECT DISTINCT drug_id, parameter FROM parameter_entries
         WHERE citation_id = ANY(${intArray(citationIds)})
      )
      SELECT count(*)::int AS n FROM doomed d
       WHERE NOT EXISTS (
         SELECT 1 FROM parameter_entries pe
          WHERE pe.drug_id = d.drug_id
            AND pe.parameter = d.parameter
            AND (pe.citation_id IS NULL OR NOT (pe.citation_id = ANY(${intArray(citationIds)})))
       )
    `)
  ).rows[0];

  const facts: DeletePlan['facts'] = [];
  for (const { table } of FACT_TABLES) {
    const row = (
      await db.execute<{ touched: number; emptied: number }>(sql`
        SELECT count(*)::int AS touched,
               count(*) FILTER (
                 WHERE cardinality(
                   ARRAY(SELECT x FROM unnest(reference_ids) AS x
                          WHERE NOT (x = ANY(${intArray(citationIds)})))
                 ) = 0
               )::int AS emptied
          FROM ${sql.identifier(table)}
         WHERE reference_ids && ${intArray(citationIds)}
      `)
    ).rows[0];
    facts.push({
      table,
      touched: row?.touched ?? 0,
      emptied: row?.emptied ?? 0,
    });
  }

  return {
    citationIds,
    entryCount: entries?.n ?? 0,
    affectedPairs: pairs.map((p) => ({
      drugId: p.drug_id,
      parameter: p.parameter,
    })),
    pairsLosingEverything: orphaned?.n ?? 0,
    facts,
  };
}

async function applyDeletes(
  plan: DeletePlan,
  actorUserId: number,
): Promise<void> {
  const db = getDb();
  const ids = plan.citationIds;

  console.log('  removing parameter entries…');
  await db.execute(sql`
    DELETE FROM parameter_entries WHERE citation_id = ANY(${intArray(ids)})
  `);

  console.log('  removing the bad reference from facts…');
  for (const { table } of FACT_TABLES) {
    // Emptied rows go first: once the id is stripped, "which rows had only
    // this reference" is no longer answerable.
    await db.execute(sql`
      DELETE FROM ${sql.identifier(table)}
       WHERE reference_ids && ${intArray(ids)}
         AND cardinality(
               ARRAY(SELECT x FROM unnest(reference_ids) AS x
                      WHERE NOT (x = ANY(${intArray(ids)})))
             ) = 0
    `);
    // Order is preserved — `reference_ids` is displayed in the order it was
    // authored, and an EXCEPT would silently reshuffle a surviving row.
    await db.execute(sql`
      UPDATE ${sql.identifier(table)}
         SET reference_ids = ARRAY(
               SELECT x FROM unnest(reference_ids) WITH ORDINALITY AS u(x, ord)
                WHERE NOT (x = ANY(${intArray(ids)}))
                ORDER BY ord
             )
       WHERE reference_ids && ${intArray(ids)}
    `);
  }

  console.log('  removing the citations…');
  await db.execute(sql`DELETE FROM citations WHERE id = ANY(${intArray(ids)})`);

  // Last, and deliberately after the deletes: the recompute reads what is left
  // and publishes that. Run before them it would repool the rows being removed.
  console.log(`  recomputing ${plan.affectedPairs.length} parameter value(s)…`);
  const cascade = new Set<number>();
  let done = 0;
  for (const { drugId, parameter } of [...plan.affectedPairs].sort(
    (a, b) => a.drugId - b.drugId,
  )) {
    if (isDrugParameterId(parameter)) {
      try {
        await recomputeAndCacheParameterSummary(
          drugId,
          parameter as DrugParameterId,
          actorUserId,
          null,
          'citation_cleanup',
        );
        if (isNormalizationInput(parameter)) cascade.add(drugId);
      } catch (err) {
        console.warn(
          `  ! recompute failed for drug ${drugId} / ${parameter}: ${(err as Error).message}`,
        );
      }
    }
    process.stderr.write(
      `  recomputing: ${++done}/${plan.affectedPairs.length}\r`,
    );
  }
  process.stderr.write('\n');
  for (const drugId of cascade) {
    await recomputeSummariesForDrug(drugId, actorUserId);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const reportPath = arg(argv, '--report') ?? 'citation-audit.json';
  const apply = argv.includes('--apply');
  const only = arg(argv, '--only');
  const actorRaw = arg(argv, '--actor');
  const backupPath =
    arg(argv, '--backup') ??
    `citation-repair-backup-${new Date().toISOString().slice(0, 10)}.json`;

  if (only && !['repoint', 'delete'].includes(only)) {
    console.error(`--only must be "repoint" or "delete" (got "${only}")`);
    process.exit(1);
  }
  const actorUserId = actorRaw ? Number(actorRaw) : null;
  if (apply && (!actorUserId || Number.isNaN(actorUserId))) {
    console.error(
      '--apply requires --actor <userId>: the parameter revisions this writes ' +
        'are attributed to a person, and this will not pick one for you.',
    );
    process.exit(1);
  }

  const findings = loadReport(reportPath);
  const repoints = repointsFrom(findings);
  const allDeletes = deletionsFrom(findings);
  const withheld = protectedFromDeletion(findings, allDeletes);
  const deletes = allDeletes.filter((f) => !withheld.has(f.id));
  const deleteIds = deletes.map((f) => f.id);
  const excluded = (arg(argv, '--exclude') ?? '')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isSafeInteger(v) && v > 0);
  for (const id of excluded) {
    const at = deleteIds.indexOf(id);
    if (at >= 0) deleteIds.splice(at, 1);
  }

  if (withheld.size > 0) {
    console.log(
      `\nWITHHELD from deletion: ${withheld.size} citation(s) whose handle is a ` +
        'real paper that a repointed row resolves onto. Deleting one would ' +
        'destroy the evidence the repoint recovered; separate the fabricated ' +
        'and recovered entries by hand.',
    );
    for (const f of withheld.values()) {
      console.log(
        `  citation ${f.id}  ${f.type}:${f.identifier}  ` +
          `${f.parameterEntries} entr(ies)  "${f.storedTitle.slice(0, 60)}"`,
      );
    }
  }

  console.log(
    `Report: ${reportPath}\n` +
      `  ${repoints.length} reference(s) to repoint\n` +
      `  ${deleteIds.length} reference(s) to delete\n` +
      `${apply ? '\nAPPLYING — this writes to the database.\n' : '\nDRY RUN — nothing will be written. Pass --apply to act.\n'}`,
  );

  if (only !== 'delete' && repoints.length > 0) {
    console.log(
      '\n─── Repoint ───────────────────────────────────────────────',
    );
    // The delete set is computed before the repoint plan on purpose: a row the
    // delete stage would remove must not be chosen to hold a recovered handle.
    const plans = await planRepoints(repoints, new Set(deleteIds));
    const blocked = plans.filter((p) => p.blockedBy !== null);
    const merges = plans.filter(
      (p) => !p.alreadyDone && p.mergeInto !== null,
    ).length;
    const already = plans.filter((p) => p.alreadyDone).length;
    const unresolved = plans.filter(
      (p) => !p.alreadyDone && p.mergeInto === null && !p.metadata,
    ).length;
    console.log(
      `  ${plans.length - merges - unresolved - already} row(s) get a new handle\n` +
        `  ${merges} row(s) fold into the citation holding that handle\n` +
        `  ${already} row(s) already carry it — an earlier run moved them\n` +
        `  ${unresolved} row(s) skipped — the registry would not vouch for the target either` +
        (blocked.length > 0
          ? `\n  ${blocked.length} row(s) HELD — the target handle belongs to a citation this run would delete`
          : ''),
    );
    for (const p of blocked) {
      console.log(
        `    HELD  citation ${p.citationId} (${p.fromType}:${p.fromIdentifier}) ` +
          `→ ${p.toType}:${p.toIdentifier}, held by condemned citation ${p.blockedBy}\n` +
          `          "${p.storedTitle.slice(0, 70)}"\n` +
          '          Both rows carry evidence for the same real paper, one of them ' +
          'fabricated. Separate them by hand before either stage runs.',
      );
    }
    for (const p of plans.slice(0, 10)) {
      console.log(
        `    ${p.fromType}:${p.fromIdentifier} → ${p.toType}:${p.toIdentifier}` +
          `${p.alreadyDone ? '  (already applied)' : p.mergeInto ? `  (fold into citation ${p.mergeInto})` : ''}`,
      );
    }
    if (plans.length > 10) console.log(`    … ${plans.length - 10} more`);
    if (apply) {
      const stats = await applyRepoints(plans, actorUserId!);
      console.log(
        `  done: ${stats.updated} updated, ${stats.merged} merged, ` +
          `${stats.done} already applied, ${stats.skipped} skipped`,
      );
    }
  }

  if (only !== 'repoint' && deleteIds.length > 0) {
    console.log(
      '\n─── Delete ────────────────────────────────────────────────',
    );
    const plan = await planDeletes(deleteIds);
    const factsTouched = plan.facts.reduce((s, f) => s + f.touched, 0);
    const factsEmptied = plan.facts.reduce((s, f) => s + f.emptied, 0);
    console.log(
      `  ${deleteIds.length} citation(s) removed\n` +
        `  ${plan.entryCount} parameter entr(ies) removed, across ` +
        `${plan.affectedPairs.length} (drug, parameter) pair(s)\n` +
        `    of those pairs, ${plan.pairsLosingEverything} lose every entry ` +
        `and their published value is cleared;\n` +
        `    ${plan.affectedPairs.length - plan.pairsLosingEverything} keep ` +
        `other sources and are repooled from them\n` +
        `  ${factsTouched} fact row(s) touched, of which ${factsEmptied} lose ` +
        `their last reference and are deleted`,
    );
    for (const f of plan.facts) {
      if (f.touched > 0) {
        console.log(
          `    ${f.table.padEnd(28)} touched ${String(f.touched).padStart(4)}  deleted ${String(f.emptied).padStart(4)}`,
        );
      }
    }

    if (apply) {
      console.log(`\n  writing backup to ${backupPath} …`);
      await writeBackup(backupPath, deleteIds);
      const size = fs.statSync(backupPath).size;
      if (size < 1024) {
        console.error(
          `  backup is only ${size} bytes — refusing to delete. Nothing was removed.`,
        );
        process.exit(1);
      }
      console.log(`  backup written (${(size / 1024 / 1024).toFixed(1)} MB)`);
      await applyDeletes(plan, actorUserId!);
      console.log('  done.');
    }
  }

  if (!apply) {
    console.log(
      '\nNothing was written. Re-run with --apply --actor <userId> to carry ' +
        'this out; the delete stage writes a backup of every affected row first ' +
        'and aborts if it cannot.',
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
