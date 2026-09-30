/**
 * Merge one drug row into another, then delete the loser.
 *
 * The catalog can end up holding two rows for what curation decides is one
 * substance — most often a PubChem racemate/stereoisomer pair that carries the
 * same Norwegian name (`Efedrin` as both CID 5032 DL-ephedrine and CID 9294
 * (1R,2S)-ephedrine). Two rows with one name are indistinguishable to a reader
 * and to every name-keyed lookup: the Farmakologiportalen link backfill refuses
 * to link either one, because picking would be a coin flip.
 *
 * Deleting the loser outright is not the fix. `drugs` is the parent of sixteen
 * ON DELETE CASCADE tables, so a bare DELETE silently takes its parameters,
 * method memberships and metabolite links with it. This moves what the loser
 * carries onto the survivor first, then tears the row down the same way
 * `handleDelete` in api/drugs.ts does.
 *
 * CORRECT BY REFUSAL. It knows how to move a fixed set of relations. Every
 * other table that references `drugs.id` is COUNTED first, read from the live
 * schema rather than a hardcoded list, and a non-empty one the script cannot
 * move ABORTS the merge before anything is written. It never proceeds past data
 * it would drop. Widening it means teaching it that table's uniqueness key, not
 * relaxing the guard.
 *
 * Merge semantics: the survivor wins. A parameter or method link the survivor
 * already has is kept and the loser's copy discarded — the insert-if-absent
 * rule the importers use, so a merge never overwrites a curated value. Three
 * things are deliberately not survivor-wins:
 *
 *   - Names, shortname and aliases are ADDITIVE (scripts/drug-merge/identity.ts).
 *   - A colliding metabolite link carrying evidence of its own, and two
 *     postmortem distributions from one cohort, REFUSE rather than drop.
 *   - Parameter values are filtered through the applicability layer before they
 *     move, under the same advisory lock the API and importers take.
 *
 * Usage:
 *   npm run merge:drugs -- --into 436 --from 803            # dry run (default)
 *   npm run merge:drugs -- --into 436 --from 803 --apply
 *
 *   # when the LOSER is the row carrying the correct PubChem CID:
 *   npm run merge:drugs -- --into 437 --from 931 --adopt-cid --apply
 */
import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drugs, wikiPages, pendingEdits, parameterEntries } from '../db/schema';
import { getDb, runInPoolTransaction } from '../api/_lib/db';
import {
  blockedParametersFor,
  withDrugApplicabilityLock,
} from '../api/_lib/parameterApplicabilityStore';
import { mergeIdentity } from './drug-merge/identity';
import { API_ONLY_REFERENCES, apiOnlyRefusal } from './drug-merge/api-only-references';
import { resolveMonographDrugCids } from '../api/_lib/monograph-helpers';
import {
  buildDrugComponentId,
  simulatorDrugKeyCandidates,
} from '../src/lib/drugComponentId';
import { embeddedComponents } from '../data/components';
import { seedSourceRefusal, seedSourcesFor } from './pubchem/seed-sources';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

interface Options {
  into: number | null;
  from: number | null;
  apply: boolean;
  /**
   * Give the survivor the loser's PubChem CID as part of the merge.
   *
   * For the ordinary case the survivor's CID is the identity the caller chose
   * and the loser's is retired. But the pair this catalog actually produces is
   * an OLD row with a wrong or non-canonical CID beside a NEW row the
   * postmortem seeder created with the right one — and there the merge and the
   * correction cannot be separated. `pubchem_cid` is UNIQUE, so the right
   * number is not free until the loser is gone; and the seed file that created
   * the loser is keyed by that number, so a merge that retires it leaves the
   * resurrection this script refuses on.
   *
   * Adopting closes both at once: one transaction, the survivor keeps its slug,
   * portal link, parameters and monograph, and the seed entry that made the
   * loser now points at the row that survived.
   */
  adoptCid: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { into: null, from: null, apply: false, adoptCid: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--apply') opts.apply = true;
    else if (a === '--adopt-cid') opts.adoptCid = true;
    else if (a === '--into') opts.into = Number(argv[++i]);
    else if (a === '--from') opts.from = Number(argv[++i]);
    else if (a.startsWith('--into=')) opts.into = Number(a.split('=')[1]);
    else if (a.startsWith('--from=')) opts.from = Number(a.split('=')[1]);
  }
  return opts;
}

interface MoveSpec {
  table: string;
  /** The column holding the drug id being moved. */
  column: string;
  /** SQL comparing a survivor row `s` to a loser row `t` — true = collision. */
  conflict: string;
  /**
   * What a collision means. 'drop' discards the loser's row (the survivor
   * already states this); 'abort' refuses the whole merge. `evidenceOnly`
   * narrows an abort to loser rows that actually carry something of their own.
   */
  onConflict: 'drop' | 'abort';
  evidenceOnly?: string;
  /**
   * SQL comparing a colliding survivor row `s` to the loser's `t`, true when
   * they state different things. A collision matching this refuses the merge
   * even on a `drop` spec: the rows are not duplicates, they disagree.
   */
  differs?: string;
}

/**
 * A metabolite link is identified by the SUBSTANCE it points at, never by
 * `metabolite_name` (0099) — that column is a label whose spelling depends on
 * who wrote the row. Two unique indexes enforce this, so a collision is either
 * name OR substance; keying on the name alone would let a dry run report a
 * clean move and then blow up on the partial index at apply time.
 */
const METABOLITE_CONFLICT = `(
  s."metabolite_name" = t."metabolite_name"
  OR (s."metabolite_drug_id" IS NOT NULL AND s."metabolite_drug_id" = t."metabolite_drug_id")
)`;

/**
 * A metabolite link that states something on its own account. Its conversion
 * range, evidence note and citations can be the ONLY evidence for that claim,
 * and a citation is evidence for the claim on its own row — so dropping such a
 * row as a "duplicate" loses the measurement and, worse, can leave the
 * surviving claim looking supported by a paper that never addressed it.
 */
const METABOLITE_EVIDENCE = `(
  t."conversion_fraction" IS NOT NULL
  OR t."conversion_fraction_min" IS NOT NULL
  OR t."conversion_fraction_max" IS NOT NULL
  OR t."evidence_note" IS NOT NULL
  OR (t."reference_ids" IS NOT NULL AND array_length(t."reference_ids", 1) > 0)
  OR t."activity" <> 'unknown'
)`;

const MOVABLE: readonly MoveSpec[] = [
  {
    table: 'drug_parameters',
    column: 'drug_id',
    conflict: 's."parameter" = t."parameter"',
    onConflict: 'drop',
  },
  {
    table: 'analytical_method_components',
    column: 'drug_id',
    conflict: 's."method_id" = t."method_id"',
    // A membership with identical figures really is a duplicate, so the
    // survivor's stands. But the row carries this method's REPORTING FIGURES
    // for this analyte — the `lor` / `mkk` / `lod` limits (the sheet's Påvisn.,
    // MKK and Terskel), the unit and the measurement uncertainty. Those are per-method
    // measured facts a laboratory validated, displayed to readers as such, and
    // two rows that disagree are two measurements rather than one written
    // twice. Picking the survivor's silently would substitute one lab figure
    // for another in a forensic setting. `sort_order` is presentation, not a
    // claim, so it is excluded.
    onConflict: 'drop',
    differs: `(
      s."lor" IS DISTINCT FROM t."lor"
      OR s."mkk" IS DISTINCT FROM t."mkk"
      OR s."lod" IS DISTINCT FROM t."lod"
      OR s."unit" IS DISTINCT FROM t."unit"
      OR s."measurement_uncertainty" IS DISTINCT FROM t."measurement_uncertainty"
    )`,
  },
  {
    table: 'drug_metabolites',
    column: 'parent_drug_id',
    conflict: METABOLITE_CONFLICT,
    onConflict: 'abort',
    evidenceOnly: METABOLITE_EVIDENCE,
  },
  {
    table: 'drug_metabolites',
    column: 'metabolite_drug_id',
    conflict: 's."parent_drug_id" = t."parent_drug_id"',
    onConflict: 'abort',
    evidenceOnly: METABOLITE_EVIDENCE,
  },
  // A postmortem distribution is one laboratory's order statistics over a whole
  // cohort — a median, a p90, a p95 that all describe the SAME material, stored
  // whole precisely because splitting or averaging them invents a number nobody
  // measured (migration 0100). Two rows from one source are two competing
  // measurements of one analyte, so discarding either is a silent loss of
  // evidence. Refuse unconditionally and let a curator decide.
  {
    table: 'pm_concentration_distributions',
    column: 'drug_id',
    conflict: 's."source_id" = t."source_id"',
    onConflict: 'abort',
  },
  // A structured ionization constant is identified by its reconciliation
  // identity (the unique index in 0109): the charge transition plus type,
  // evidence tier, and normalized site/medium/temperature. Two rows sharing that
  // identity would violate the unique index once both point at the survivor, so
  // a collision must be resolved. Truly identical rows (same pKa AND the same
  // reference_ids) are duplicates and the survivor's stands; a collision where
  // the pKa or the backing citations differ is two measurements, not one written
  // twice — dropping either would lose a distinct value or its provenance, so
  // the merge aborts and a curator reconciles. Distinct transitions never
  // collide and are simply carried over. Same reasoning as
  // analytical_method_components' measured figures.
  {
    table: 'drug_ionization_constants',
    column: 'drug_id',
    conflict: `(
      s."protonated_charge" = t."protonated_charge"
      AND s."deprotonated_charge" = t."deprotonated_charge"
      AND s."constant_type" = t."constant_type"
      AND s."evidence_type" = t."evidence_type"
      AND lower(coalesce(s."site_label", '')) = lower(coalesce(t."site_label", ''))
      AND lower(coalesce(s."medium", '')) = lower(coalesce(t."medium", ''))
      AND coalesce(s."temperature_c"::text, '') = coalesce(t."temperature_c"::text, '')
    )`,
    onConflict: 'drop',
    // `origin` is part of the difference test: a curated (human) row and a
    // deep-research row are never "the same" even with identical values, because
    // dropping the curated one and keeping the research one would quietly make
    // the measurement eligible for a later --overwrite import — erasing the
    // guarantee that a human-authored constant is never rewritten. Such a
    // collision aborts for curator reconciliation.
    differs: `(
      s."pka" IS DISTINCT FROM t."pka"
      OR s."reference_ids" IS DISTINCT FROM t."reference_ids"
      OR s."note" IS DISTINCT FROM t."note"
      OR s."origin" IS DISTINCT FROM t."origin"
    )`,
  },
];

/** Referencing tables the merge deliberately lets the cascade discard. */
const DISCARDABLE = new Set(['drug_interactions']);

/**
 * Relations that hold a `drugs.id` WITHOUT a foreign key, so the FK scan is
 * blind to them and the cascade never reaches them.
 *
 * `verification_log.target_id` is polymorphic — a drug id for
 * `target_type='parameter'`, a wiki_pages.id for monograph rows, a citations.id
 * for paper rows — which is why it carries no constraint. Only the parameter
 * rows have a successor after a merge, and they must follow the substance:
 * `withinAbsentCooldownSql` matches on `target_id`, so an exhaustive "absent"
 * result recorded against the loser stops suppressing that gap the moment the
 * row is deleted, and the maintenance agent repeats work the cooldown was
 * meant to prevent. Repointing preserves both the suppression and the history.
 *
 * Monograph and citation rows are left alone: their targets are a deleted page
 * or an untouched citation, neither of which the survivor inherits.
 */
const TYPED_NON_FK_MOVES = [
  { table: 'verification_log', column: 'target_id', where: "target_type = 'parameter'" },
] as const;

/**
 * `paper_extraction_jobs.target_drug_ids` — an editor's hint about which drugs
 * a paper is expected to yield facts for.
 *
 * A Postgres array cannot carry a foreign key, so this is invisible to the FK
 * inventory and unreachable by the cascade, and it is not a scalar column
 * either, so the `TYPED_NON_FK_MOVES` shape above does not fit it. Left alone,
 * the merge leaves the extraction agent pointed at a drug id that resolves to
 * nothing, and the editor's steer for that run is silently lost.
 *
 * Rewritten rather than dropped, for the same reason as the saved cases: the
 * hint names a SUBSTANCE, and the substance survives the merge. Deduplicated
 * because a job naming both drugs would otherwise end up naming the survivor
 * twice — `array_agg(DISTINCT …)` also sorts, which is fine for what is an
 * unordered set of hints.
 */
function extractionHintSql(survivorId: number, loserId: number): string {
  return `
    UPDATE paper_extraction_jobs
    SET target_drug_ids = (
      SELECT array_agg(DISTINCT CASE WHEN v = ${loserId} THEN ${survivorId} ELSE v END)
      FROM unnest(target_drug_ids) v
    )
    WHERE target_drug_ids @> ARRAY[${loserId}]::integer[]`;
}

type Db = ReturnType<typeof getDb>;

function rowsOf(res: unknown): Record<string, unknown>[] {
  return ((res as { rows?: unknown[] }).rows ?? (res as unknown[])) as Record<
    string,
    unknown
  >[];
}

async function scalar(db: Db, query: string): Promise<number> {
  const res = await db.execute(sql.raw(query));
  return (rowsOf(res)[0]?.n as number) ?? 0;
}

/** Every FK column pointing at drugs.id, read from the live schema. */
async function drugReferences(db: Db): Promise<{ table: string; column: string }[]> {
  const res = await db.execute(sql`
    SELECT tc.table_name AS table, kcu.column_name AS column
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON kcu.constraint_name = tc.constraint_name
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'drugs' AND ccu.column_name = 'id'
    ORDER BY tc.table_name, kcu.column_name`);
  return rowsOf(res) as unknown as { table: string; column: string }[];
}

/** Loser rows that collide with a survivor row, optionally narrowed further. */
function conflictCountSql(
  spec: MoveSpec,
  survivorId: number,
  loserId: number,
  narrow?: string,
): string {
  return `
    SELECT count(*)::int AS n FROM "${spec.table}" t
    WHERE t."${spec.column}" = ${loserId}
      ${narrow ? `AND ${narrow}` : ''}
      AND EXISTS (
        SELECT 1 FROM "${spec.table}" s
        WHERE s."${spec.column}" = ${survivorId} AND ${spec.conflict}
      )`;
}

/**
 * Metabolite links directly between the two drugs. After the endpoints are
 * rewritten both halves read `survivor -> survivor`, a self-edge the metabolism
 * write path rejects outright — a substance cannot be its own metabolite. They
 * have to go before the rewrite, not after.
 */
function selfEdgeSql(survivorId: number, loserId: number, narrow?: string): string {
  return `
    SELECT count(*)::int AS n FROM drug_metabolites t
    WHERE ((t."parent_drug_id" = ${survivorId} AND t."metabolite_drug_id" = ${loserId})
        OR (t."parent_drug_id" = ${loserId} AND t."metabolite_drug_id" = ${survivorId}))
      ${narrow ? `AND ${narrow}` : ''}`;
}

/**
 * Loser links that share a LABEL with one of the survivor's but name a
 * different substance. `METABOLITE_CONFLICT` calls that a collision — the
 * name index would reject the move — but it is the opposite of a duplicate:
 * two different metabolic relationships that happen to be spelled alike.
 * Dropping the loser's would delete a relationship nothing else records.
 *
 * Only when the loser's row is the better-informed one. If the loser's link is
 * unresolved (NULL) and the survivor's names a substance, the survivor's row
 * already says strictly more and the loser's is safe to drop.
 */
function relabelledSql(survivorId: number, loserId: number): string {
  return `
    SELECT count(*)::int AS n FROM drug_metabolites t
    WHERE t."parent_drug_id" = ${loserId}
      AND t."metabolite_drug_id" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM drug_metabolites s
        WHERE s."parent_drug_id" = ${survivorId}
          AND s."metabolite_name" = t."metabolite_name"
          AND s."metabolite_drug_id" IS DISTINCT FROM t."metabolite_drug_id"
      )`;
}

/**
 * Every reason this merge must not proceed. Empty means safe.
 *
 * Run twice: once in the preflight so the dry run explains itself, and again
 * inside the apply transaction. The second run is not paranoia — the
 * applicability advisory lock serializes parameter writers, but nothing stops
 * a metabolism API write from committing an evidence-bearing colliding row
 * between the two, and the cleanup below would then delete evidence that
 * arrived after the check said there was none.
 */
async function refusals(db: Db, survivorId: number, loserId: number): Promise<string[]> {
  const out: string[] = [];
  for (const spec of MOVABLE) {
    if (spec.onConflict !== 'abort') continue;
    const n = await scalar(
      db,
      conflictCountSql(spec, survivorId, loserId, spec.evidenceOnly),
    );
    if (n > 0) {
      out.push(
        `${n} ${spec.table} row(s) collide with the survivor's and carry evidence of ` +
          'their own (a conversion range, a note, a citation, a known activity, or a ' +
          'whole cohort distribution)',
      );
    }
  }
  for (const spec of MOVABLE) {
    if (!spec.differs) continue;
    const n = await scalar(
      db,
      `SELECT count(*)::int AS n FROM "${spec.table}" t
       WHERE t."${spec.column}" = ${loserId}
         AND EXISTS (
           SELECT 1 FROM "${spec.table}" s
           WHERE s."${spec.column}" = ${survivorId}
             AND ${spec.conflict} AND ${spec.differs}
         )`,
    );
    if (n > 0) {
      out.push(
        `${n} ${spec.table} row(s) collide with the survivor's but state DIFFERENT ` +
          'figures — two measurements, not one written twice; keeping the survivor\'s ' +
          'would substitute one laboratory value for another',
      );
    }
  }

  const relabelled = await scalar(db, relabelledSql(survivorId, loserId));
  if (relabelled > 0) {
    out.push(
      `${relabelled} metabolite link(s) share a label with one of the survivor's but ` +
        'name a DIFFERENT substance — two relationships, not two spellings',
    );
  }
  const selfEdge = await scalar(db, selfEdgeSql(survivorId, loserId, METABOLITE_EVIDENCE));
  if (selfEdge > 0) {
    out.push(
      `${selfEdge} metabolite link(s) run between these two drugs and carry evidence — ` +
        'the catalog states one is formed from the other, which merging them denies',
    );
  }
  return out;
}

/** Parameters the loser holds that the survivor does not — the ones that move. */
async function movingParameters(
  db: Db,
  survivorId: number,
  loserId: number,
): Promise<string[]> {
  const res = await db.execute(
    sql.raw(`
      SELECT t."parameter" FROM drug_parameters t
      WHERE t."drug_id" = ${loserId}
        AND NOT EXISTS (
          SELECT 1 FROM drug_parameters s
          WHERE s."drug_id" = ${survivorId} AND s."parameter" = t."parameter"
        )
      ORDER BY t."parameter"`),
  );
  return rowsOf(res).map((r) => String(r.parameter));
}


interface DrugRow {
  id: number;
  slug: string;
  names: Record<string, string> | null;
  aliases: string[] | null;
  nameShort: string | null;
  pubchemCid: number | null;
  source: string | null;
  substanceClass: string;
  popularityScore: number;
  farmakologiportalenPath: string | null;
}

interface MonographPage {
  id: number;
  slug: string;
  chars: number;
}

/**
 * Everything the merge needs to know, and every reason it must not proceed.
 *
 * Gathered by ONE function rather than inline, because the same questions have
 * to be asked twice: once for the dry run, and once inside the apply
 * transaction. Every earlier round of this script fixed one stale preflight
 * check and left its neighbours reading from the same snapshot — the fix for
 * that is not another patch but a single pass that the apply path re-runs
 * wholesale, so a check cannot be added to one place and forgotten in the other.
 */
interface Plan {
  survivor: DrugRow;
  loser: DrugRow;
  refusals: string[];
  carried: string[];
  pages: MonographPage[];
  blockedParameters: string[];
  selfEdges: number;
  settledEdits: number;
  typedNonFk: { label: string; rows: number }[];
  simulatorCases: number;
  kinelabCases: number;
  /** The monograph the survivor keeps, if any — where a focus selection moves. */
  survivorPageId: number | null;
  /**
   * The survivor's OWN legacy monograph key, when `--adopt-cid` is about to
   * retire the number it is stored under. Null when there is nothing to move.
   *
   * Computed here rather than in the apply block so the dry run says it will
   * happen. This file's structure exists because earlier rounds kept adding a
   * check to one path and forgetting the other.
   */
  survivorLegacyMonographCid: number | null;
  /** Selected pages of the loser's that the merge is about to delete. */
  focusPageIds: number[];
  /** The whole selection, read under the same lock the rewrite relies on. */
  focusAllPageIds: number[];
  /** Extraction jobs whose editor hint names the loser. */
  extractionHints: number;
  /**
   * The saved-case key(s) that stop resolving, and what replaces them.
   * `caseFrom` is every spelling currently in use for the source drug (see
   * {@link simulatorDrugKeyCandidates}) — a CID-less drug can have cases
   * saved under both its pre-#1256 bare id and its `drug:<id>` key.
   */
  caseFrom: string[];
  caseTo: string;
}

/**
 * The maintenance agent's scope, when an admin has narrowed it.
 *
 * `agent_focus_config.page_ids` is an unconstrained JSON array of
 * `wiki_pages.id`, so deleting a monograph leaves the selection pointing at a
 * page that no longer exists — and `resolveDrugIdsForPages` resolves nothing
 * for it. On `mode = 'pages'` that is not a slightly smaller scope: if it was
 * the only selection the agent's drug set is empty and the hourly parameter
 * queue quietly stops doing anything, with the config still displaying a
 * choice the admin made.
 */
async function readFocus(
  db: Db,
  lock: boolean,
): Promise<{ mode: string; pageIds: number[] }> {
  // `FOR UPDATE` on the apply path, and it is load-bearing rather than
  // decorative: the rewrite computes a new array in TypeScript from what it
  // read, so an admin changing the selection between the read and the UPDATE
  // would have their change overwritten by a list derived from the state
  // before it. The lock is taken during `buildPlan`, so it is held for the
  // rest of the transaction and the value used to build `next` is the value
  // being replaced.
  const res = await db.execute(
    sql.raw(
      `SELECT mode, page_ids AS "pageIds" FROM agent_focus_config WHERE id = 1` +
        (lock ? ' FOR UPDATE' : ''),
    ),
  );
  const row = rowsOf(res)[0];
  if (!row) return { mode: 'all', pageIds: [] };
  const raw = row.pageIds;
  const pageIds = Array.isArray(raw)
    ? raw.filter((v): v is number => typeof v === 'number')
    : [];
  return { mode: String(row.mode ?? 'all'), pageIds };
}

/**
 * Drug-scoped pending-edit types whose `target_id` is always a drugs.id.
 *
 * Every endpoint that queues a proposal against a *drug* belongs here, and each
 * one is written independently — `api/drug-enzyme-interactions.ts` stores
 * `editType: 'enzyme_interaction', targetId: drugId` in its own insert, with
 * nothing tying it to this list. So this is a list that rots by default: a new
 * drug-scoped proposal type is added somewhere else entirely, and the omission
 * shows up as a queued contribution whose target drug no longer exists and
 * whose approval path therefore fails. Grep `editType:` across `api/` before
 * trusting it.
 */
/**
 * Proposal states in which a contribution is still somebody's work in progress.
 *
 * `pending_edits.status` is `draft | pending | approved | rejected | returned`,
 * and only the middle three are what they sound like. A `draft` has never been
 * submitted and a `returned` one was handed back for revision — both are
 * editable, both are expected to become a submission, and both were being read
 * as settled by a check that recognised `pending` alone. The teardown deletes
 * by target regardless of status, so the merge was discarding unfinished and
 * returned work while reporting only "settled rows deleted".
 */
const ACTIVE_EDIT_STATUSES = ['pending', 'draft', 'returned'];
const SETTLED_EDIT_STATUSES = ['approved', 'rejected'];
const quoted = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(', ');

const DRUG_SCOPED_EDIT_TYPES = [
  'parameter',
  'metabolism',
  'receptor_targets',
  'enzyme_interaction',
];

/**
 * Read both drug rows, optionally locking them.
 *
 * `FOR UPDATE` is what makes the apply path's re-read meaningful: `/api/drugs`
 * can rewrite names, aliases or the shortname at any time and takes none of the
 * locks this script holds, so without the row lock the merge would compute an
 * identity, have it superseded, and then write the stale version back over a
 * curator's edit.
 */
async function readDrugs(
  db: Db,
  survivorId: number,
  loserId: number,
  lock: boolean,
): Promise<{ survivor: DrugRow; loser: DrugRow }> {
  const res = await db.execute(
    sql.raw(`
      SELECT id, slug, names, aliases, name_short AS "nameShort", pubchem_cid AS "pubchemCid",
             source, substance_class AS "substanceClass",
             popularity_score AS "popularityScore",
             farmakologiportalen_path AS "farmakologiportalenPath"
      FROM drugs WHERE id IN (${survivorId}, ${loserId})${lock ? ' FOR UPDATE' : ''}`),
  );
  const rows = rowsOf(res) as unknown as DrugRow[];
  const survivor = rows.find((r) => r.id === survivorId);
  const loser = rows.find((r) => r.id === loserId);
  if (!survivor) throw new Error(`Survivor drug ${survivorId} not found`);
  if (!loser) throw new Error(`Loser drug ${loserId} not found`);
  return { survivor, loser };
}

/**
 * The loser's drug monographs, optionally locked.
 *
 * `wiki_pages.drug_cid` is a plain integer, not an FK, so the cascade never
 * reaches these and they have to be found and deleted explicitly. Only modern
 * `drug_cid = drugs.id` keying is touched: a legacy page keyed by PubChem CID
 * could belong to a different drug whose internal id happens to equal it, and
 * guessing there loses somebody's monograph.
 *
 * `drug_cid` is mixed-vintage — modern rows store `drugs.id`, legacy rows a
 * PubChem CID — so both are candidates, resolved by the same
 * `resolveMonographDrugCids` the admin delete uses. It drops a CID that is also
 * some *other* drug's internal id, which is the collision that makes a naive
 * "delete pages keyed by either number" lose an unrelated monograph. Handling
 * only `drugs.id` avoids that collision too, but at the cost of leaving a
 * legacy page orphaned once the drug row goes.
 *
 * The lock closes the window between reading a page's length and deleting it —
 * without it an editor can commit prose in between and have it deleted by a
 * check that saw an empty page. It does not stop a page being *created* in that
 * window (there is no row to lock yet, and wiki writes take no drug-level
 * lock), which is why this is read as late as possible and the delete uses the
 * ids it just saw rather than the preflight's.
 */
async function readMonographs(
  db: Db,
  loser: { id: number; pubchemCid: number | null },
  lock: boolean,
): Promise<MonographPage[]> {
  const candidates = await resolveMonographDrugCids(db, loser);
  if (candidates.length === 0) return [];
  const res = await db.execute(
    sql.raw(`
      SELECT id, slug, coalesce(length(content_plaintext), 0)::int AS chars
      FROM wiki_pages
      WHERE page_type = 'drug_monograph'
        AND drug_cid IN (${candidates.join(', ')})${lock ? ' FOR UPDATE' : ''}`),
  );
  return rowsOf(res) as unknown as MonographPage[];
}

/**
 * Whether a saved-case KEY names more than one substance.
 *
 * The question is about the string, not about a drug, and an earlier revision
 * got that wrong: it asked whether *this drug* had a CID and returned "safe"
 * the moment it did. But a bare numeric `case_data.drugs[].drugId` predates
 * #1256's `drug:<id>` prefix (or names a CID under it either way), so one
 * numeric string is ambiguous whenever BOTH spellings of it exist in the
 * catalog — some drug carrying it as a `pubchem_cid`, and some other,
 * CID-less drug carrying it as a `drugs.id`. Which of the two happens to be
 * the drug being merged does not enter into it. A `drug:<id>` key is never
 * ambiguous — it fails the numeric-string test below and returns false
 * immediately — which is the fix: no future key built this way can collide.
 *
 * `hydrateComponentByRouteId` tries the CID lookup first for a bare numeric
 * key, so an ambiguous one resolves to the CID-bearing drug and the
 * CID-less drug's saved cases have been quietly pointing at the wrong
 * substance all along. What the merge must not do is act on it: the
 * rewrite matches by that string, so it would sweep up the other drug's
 * cases and move them to the survivor as well.
 */
async function ambiguousSimulatorKey(db: Db, key: string): Promise<boolean> {
  if (!/^\d+$/.test(key)) return false;
  const n = Number(key);
  if (!Number.isSafeInteger(n)) return false;
  return (
    (await scalar(
      db,
      `SELECT count(*)::int AS n FROM drugs a
       WHERE a.pubchem_cid = ${n}
         AND EXISTS (
           SELECT 1 FROM drugs b
           WHERE b.id = ${n} AND b.pubchem_cid IS NULL AND b.id <> a.id
         )`,
    )) > 0
  );
}

/**
 * Saved cases naming the loser (any spelling — see
 * {@link simulatorDrugKeyCandidates}), which must be repointed before it is
 * deleted.
 */
function simulatorCaseCountSql(keys: string[]): string {
  const clauses = keys
    .map(
      (key) =>
        `case_data->'drugs' @> ${quote(`[{"drugId":${JSON.stringify(key)}}]`)}::jsonb`,
    )
    .join(' OR ');
  return `
    SELECT count(*)::int AS n FROM simulator_cases
    WHERE ${clauses}`;
}

/**
 * KineLab cases pin their analyte by SLUG, in a different place and a different
 * id space from a forward-simulator case.
 *
 * `case_data` is `{kind: 'kinelab-case', input: {analyte: '<slug>', …}}`, so the
 * `drugs`-array predicate above cannot see one. And the failure is silent in the
 * same way: `loadCase` resolves the slug with
 * `fetchDrugComponentBySlug(analyte).catch(() => fetchDrugComponentBySlug(DEFAULT_KINELAB_ANALYTE))`,
 * so once the loser's slug stops resolving the case does not fail — it loads the
 * *default* analyte under the saved case's name and models a substance nobody
 * chose.
 *
 * A slug is the right key to write here (unlike `drugs[].drugId`, where the app
 * matches components on `String(pubchemCid ?? id)` and a slug would never
 * settle): this path looks the analyte up by slug and builds the config from
 * whatever it gets back. The survivor's slug never changes during a merge, so
 * the rewritten value resolves to exactly the substance the case now means.
 */
function kinelabCaseWhere(slug: string): string {
  return `case_data->>'kind' = 'kinelab-case' AND case_data->'input'->>'analyte' = ${quote(slug)}`;
}

/** Single-quote a literal for inlining into raw SQL. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Gather the whole picture and every objection to it. */
async function buildPlan(
  db: Db,
  survivorId: number,
  loserId: number,
  lock: boolean,
  adoptCid = false,
): Promise<Plan> {
  const { survivor, loser } = await readDrugs(db, survivorId, loserId, lock);
  const refusalList: string[] = [];
  const carried: string[] = [];

  // Every FK into `drugs`, read from the live schema rather than a hardcoded
  // list that would rot. Re-run on the apply path too: a metabolism save can
  // add an elimination route or profile row for the loser after the preflight,
  // and the final DELETE would cascade it away unexamined.
  const movable = new Set(MOVABLE.map((m) => `${m.table}.${m.column}`));
  const unhandled: string[] = [];
  const apiOnly: { table: string; column: string; rows: number }[] = [];
  for (const ref of await drugReferences(db)) {
    const n = await scalar(
      db,
      `SELECT count(*)::int AS n FROM "${ref.table}" WHERE "${ref.column}" = ${loser.id}`,
    );
    if (n === 0) continue;
    const known = movable.has(`${ref.table}.${ref.column}`);
    const discard = DISCARDABLE.has(ref.table);
    const viaApi = API_ONLY_REFERENCES.has(`${ref.table}.${ref.column}`);
    carried.push(
      `${ref.table}.${ref.column}: ${n} — ` +
        `${known ? 'move' : discard ? 'discard (telemetry)' : viaApi ? 'ADMIN MERGE ONLY' : 'UNHANDLED'}`,
    );
    if (viaApi) {
      apiOnly.push({ table: ref.table, column: ref.column, rows: n });
    } else if (!known && !discard) {
      unhandled.push(`${ref.table}.${ref.column} (${n} rows)`);
    }
  }
  const apiOnlyReason = apiOnlyRefusal(apiOnly);
  if (apiOnlyReason) refusalList.push(apiOnlyReason);
  if (unhandled.length > 0) {
    refusalList.push(
      `nothing here knows how to move ${unhandled.join(', ')} — teach ` +
        "merge-drugs.ts that table's uniqueness key, or clear the rows first",
    );
  }

  // `substance_class` decides which parameters are even DEFINED for the row —
  // bioavailability and the dose parameters need a dose OF THIS SUBSTANCE, so
  // they have no referent for a metabolite or an endogenous marker. Letting the
  // survivor's class win silently resolves a disagreement about what the
  // substance IS, and it resolves it in a way that changes the data: merging
  // into the 'drug' row makes undefined dose parameters look applicable and
  // re-opens them in the gap queue, while merging into the non-administered row
  // makes valid ones unwritable and hides real gaps. Neither is a merge
  // decision.
  if (survivor.substanceClass !== loser.substanceClass) {
    refusalList.push(
      `the two rows disagree about what this substance is — survivor is ` +
        `'${survivor.substanceClass}', loser is '${loser.substanceClass}'. Reconcile ` +
        'the classification first; it decides which parameters are defined at all',
    );
  }

  refusalList.push(...(await refusals(db, survivor.id, loser.id)));

  const pages = await readMonographs(db, loser, lock);
  const written = pages.filter((p) => p.chars > 0);
  if (written.length > 0) {
    refusalList.push(
      `the loser's monograph has prose on it (` +
        `${written.map((p) => `/${p.slug}: ${p.chars} chars`).join(', ')}) — move the ` +
        'text onto the survivor first; the merge deletes the page',
    );
  }

  // A monograph that is EMPTY NOW can still have been written. `wiki_revisions`
  // cascades on the page delete, so blanking a page and then merging it away
  // destroys the editorial history that blanking did not — and the current
  // snapshot, which is all the check above reads, says nothing about it.
  // Tag-stripped, because an "empty" rich-text document still serialises to
  // some markup.
  const writtenRevisions =
    pages.length === 0
      ? 0
      : await scalar(
          db,
          `SELECT count(*)::int AS n FROM wiki_revisions
           WHERE "page_id" IN (${pages.map((p) => p.id).join(', ')})
             AND length(btrim(regexp_replace(coalesce("content_html", ''),
                                             '<[^>]*>', '', 'g'))) > 0`,
        );
  if (writtenRevisions > 0 && written.length === 0) {
    refusalList.push(
      `the loser's monograph is empty now but has ${writtenRevisions} revision(s) with ` +
        'prose in them — `wiki_revisions` cascades when the page is deleted, so the ' +
        'merge would destroy editorial history that blanking the page did not. Move ' +
        'the text onto the survivor, or accept the loss deliberately by clearing the ' +
        'history first',
    );
  }

  // Every repo file that would rebuild the loser from its CID after the row is
  // gone. A refusal rather than the warning this used to print: the warning
  // arrived after the write, and `seed:pm-concentrations` does not merely
  // upsert — it CREATES a drug for a CID it cannot find, so one stale entry
  // undoes the merge on the next seed run.
  //
  // WHICH CID is being freed depends on `--adopt-cid`. Without it the loser's
  // number is retired and the survivor keeps its own; with it the survivor
  // takes the loser's, so the number that stops belonging to anything is the
  // survivor's OLD one. Checking the wrong side is not a harmless
  // over-refusal — it points the operator at the number they are about to
  // adopt and tells them to remove it.
  const freedCid = adoptCid ? survivor.pubchemCid : loser.pubchemCid;
  const keptCid = adoptCid ? loser.pubchemCid : survivor.pubchemCid;
  const seeded = freedCid != null ? seedSourcesFor(freedCid, embeddedComponents) : [];
  if (seeded.length > 0 && freedCid != null) {
    refusalList.push(
      seedSourceRefusal(
        freedCid,
        seeded,
        keptCid != null
          ? `CID ${keptCid}`
          : 'the surviving row (which has no CID — give it one first, or remove the entries)',
      ),
    );
  }
  if (adoptCid && loser.pubchemCid == null) {
    refusalList.push(
      '--adopt-cid was passed but the loser has no PubChem CID to adopt',
    );
  }

  // The survivor's OWN monograph may be legacy-keyed by the CID `--adopt-cid`
  // is about to retire. `wiki_pages.drug_cid` is mixed-vintage —
  // `ensureDrugMonograph` writes `drugs.id`, the older
  // `seed-drug-monographs.ts` wrote the PubChem CID — and
  // `resolveMonographDrugCids` only looks for the drug's id and its CURRENT
  // CID. Change the CID and stop there and the written page stops resolving:
  // the substance shows no monograph and the next backfill builds a SECOND,
  // empty one beside it. The loser's pages are handled elsewhere (they go with
  // the row); this one has to MOVE.
  //
  // Read through `resolveMonographDrugCids` so the collision rule is the
  // repo's: a `drug_cid` that is some OTHER drug's internal id is that drug's
  // modern link, and adopting it here would steal an unrelated monograph.
  let survivorLegacyMonographCid: number | null = null;
  if (adoptCid && survivor.pubchemCid != null && survivor.pubchemCid !== survivor.id) {
    const survivorCids = await resolveMonographDrugCids(db, survivor);
    if (survivorCids.includes(survivor.pubchemCid)) {
      const legacyPages = await scalar(
        db,
        `SELECT count(*)::int AS n FROM wiki_pages
         WHERE page_type = 'drug_monograph' AND drug_cid = ${survivor.pubchemCid}`,
      );
      if (legacyPages > 0) survivorLegacyMonographCid = survivor.pubchemCid;
    }
  }

  // An OPEN pending edit is a contributor's proposal about a substance that
  // still exists after the merge, plus its place in the review queue. Deleting
  // it as teardown debris discards the contribution. Repointing it to the
  // survivor is not automatically safe either: `pending_edits_open_*_idx`
  // allows at most one open edit per (drug, parameter), so a repoint can
  // collide with an open edit the survivor already has. Refuse and let the
  // queue be worked instead.
  //
  // `param_entry` is counted separately and keyed by `op`, exactly as the
  // teardown is. Its `target_id` is polymorphic — a drug id on a create, an
  // independently allocated `parameter_entries.id` on an update or delete — so
  // folding it into the drug-id predicate is wrong in both directions: an
  // unrelated open update whose entry id happens to equal this drug's id would
  // refuse the merge with an objection nobody can clear, and an open update
  // against one of the loser's OWN entries would go uncounted and be deleted by
  // the teardown as debris.
  const openEdits =
    (await scalar(
      db,
      `SELECT count(*)::int AS n FROM pending_edits
       WHERE "target_id" = ${loser.id}
         AND "status" IN (${quoted(ACTIVE_EDIT_STATUSES)})
         AND "edit_type" IN (${quoted(DRUG_SCOPED_EDIT_TYPES)})`,
    )) +
    (await scalar(
      db,
      `SELECT count(*)::int AS n FROM pending_edits
       WHERE "edit_type" = 'param_entry'
         AND "status" IN (${quoted(ACTIVE_EDIT_STATUSES)})
         AND (
           ("target_id" = ${loser.id} AND "proposed_value" ->> 'op' = 'create')
           OR ("proposed_value" ->> 'op' IN ('update', 'delete')
               AND "target_id" IN (
                 SELECT id FROM parameter_entries WHERE drug_id = ${loser.id}))
         )`,
    ));
  // …and the same for proposals against the loser's MONOGRAPH. These live in a
  // different id space — a wiki proposal's `target_id` is a `wiki_pages.id`,
  // not a drug id — so the check above cannot see them however it is widened,
  // and the teardown deletes them by page id regardless of status.
  const openPageEdits =
    pages.length === 0
      ? 0
      : await scalar(
          db,
          `SELECT count(*)::int AS n FROM pending_edits
           WHERE "target_id" IN (${pages.map((p) => p.id).join(', ')})
             AND "status" IN (${quoted(ACTIVE_EDIT_STATUSES)})
             AND "edit_type" IN ('wiki_page', 'wiki_section', 'wiki_fact')`,
        );
  // A `wiki_new` proposal is a monograph that does not exist yet, so it has no
  // page id and the predicate above — which keys on the loser's existing pages
  // — cannot see one however it is widened. The drug link lives in
  // `proposed_meta->>'drugCid'`, which holds a `drugs.id` (the same join
  // `api/agent-sweep.ts` makes against `d.id::text`) and carries no constraint.
  //
  // Left alone, the merge deletes the drug and leaves the proposal queued.
  // Approving it later publishes a `drug_monograph` whose `drug_cid` names a
  // row that no longer exists — a page about nothing, created by a reviewer
  // doing exactly what the queue asked of them.
  const openNewPageEdits = await scalar(
    db,
    `SELECT count(*)::int AS n FROM pending_edits
     WHERE "edit_type" = 'wiki_new'
       AND "status" IN (${quoted(ACTIVE_EDIT_STATUSES)})
       AND "proposed_meta" ->> 'drugCid' = '${loser.id}'`,
  );
  if (openNewPageEdits > 0) {
    refusalList.push(
      `${openNewPageEdits} unfinished proposal(s) would CREATE a monograph for the loser ` +
        '(`wiki_new`, linked through proposed_meta.drugCid, so they have no page yet and ' +
        'the page check cannot see them). Settle them first, or approving one later ' +
        'publishes a monograph attached to a drug that no longer exists',
    );
  }
  if (openPageEdits > 0) {
    refusalList.push(
      `${openPageEdits} unfinished proposal(s) target the loser's monograph (pending, ` +
        'draft or returned) — settle them first; the merge deletes the page and would ' +
        'take them with it',
    );
  }
  if (openEdits > 0) {
    refusalList.push(
      `${openEdits} unfinished pending edit(s) target the loser — pending, draft or ` +
        'returned. Settle them first, so the contribution lands somewhere rather than ' +
        'being deleted with the row',
    );
  }
  const settledEdits = await scalar(
    db,
    `SELECT count(*)::int AS n FROM pending_edits
     WHERE "target_id" = ${loser.id}
       AND "status" IN (${quoted(SETTLED_EDIT_STATUSES)})
       AND "edit_type" IN (${quoted(DRUG_SCOPED_EDIT_TYPES)})`,
  );

  const typedNonFk: { label: string; rows: number }[] = [];
  for (const spec of TYPED_NON_FK_MOVES) {
    const n = await scalar(
      db,
      `SELECT count(*)::int AS n FROM "${spec.table}"
       WHERE "${spec.column}" = ${loser.id} AND ${spec.where}`,
    );
    if (n > 0) typedNonFk.push({ label: `${spec.table}.${spec.column}`, rows: n });
  }

  // Saved simulator cases pin a drug by the same string the UI routes on, in
  // JSON, with no constraint of any kind — invisible to the FK scan. Left
  // alone, loading the case fails to hydrate that component, and worse:
  // `hydrateComponentByRouteId` falls back from the CID lookup to an
  // internal-id lookup, so a deleted CID that happens to equal some other
  // drug's id silently hydrates the WRONG substance and simulates it with
  // that substance's parameters. Low CIDs colliding with internal ids is a
  // documented fact of this catalog, not a hypothetical.
  // WHICH key stops meaning this substance depends on `--adopt-cid`, and the
  // count and the ambiguity guard have to be asked about the same one the
  // rewrite will use. Normally that is the loser's key, replaced by the
  // survivor's. Under adoption the survivor takes the loser's CID, so the
  // loser's cases already carry the final value and need no rewrite — it is
  // the SURVIVOR's own key that stops resolving, and counting the loser's
  // would run every check against a key nothing is about to touch.
  const caseFrom = adoptCid
    ? simulatorDrugKeyCandidates(survivor)
    : simulatorDrugKeyCandidates(loser);
  const caseTo = adoptCid ? String(loser.pubchemCid) : buildDrugComponentId(survivor);
  const simulatorCases = await scalar(db, simulatorCaseCountSql(caseFrom));
  if (simulatorCases > 0) {
    // Both ends, always. The search key(s) decide WHICH cases move and the
    // replacement decides what they mean afterwards, so either being ambiguous
    // is enough to make the rewrite wrong — and neither is safe merely because
    // the drug it came from has a CID.
    for (const [role, key] of [
      ...caseFrom.map((key) => ['search', key] as const),
      ['replacement', caseTo],
    ] as const) {
      if (!(await ambiguousSimulatorKey(db, key))) continue;
      refusalList.push(
        `${simulatorCases} saved simulator case(s) are in scope and the ${role} key ` +
          `"${key}" names two substances — one drug carries it as its PubChem CID and ` +
          'another, with no CID of its own, carries it as its internal id. Give that ' +
          'second drug a CID first: rewriting on this key would move cases that were ' +
          'never about either of these drugs, and they would simulate to a plausible ' +
          'curve rather than failing',
      );
    }
  }

  const kinelabCases = await scalar(
    db,
    `SELECT count(*)::int AS n FROM simulator_cases WHERE ${kinelabCaseWhere(loser.slug)}`,
  );

  const extractionHints = await scalar(
    db,
    `SELECT count(*)::int AS n FROM paper_extraction_jobs
     WHERE target_drug_ids @> ARRAY[${loser.id}]::integer[]`,
  );

  const survivorPages = await readMonographs(db, survivor, lock);
  const survivorPageId = survivorPages[0]?.id ?? null;
  const focus = await readFocus(db, lock);
  const focusPageIds = focus.pageIds.filter((id) => pages.some((p) => p.id === id));
  if (focusPageIds.length > 0 && survivorPageId === null) {
    const remaining = focus.pageIds.filter((id) => !focusPageIds.includes(id));
    if (focus.mode === 'pages' && remaining.length === 0) {
      refusalList.push(
        "the maintenance agent's focus is narrowed to the loser's monograph and nothing " +
          'else, and the survivor has no monograph to move the selection to — the merge ' +
          'would leave the agent scoped to nothing while the config still shows a ' +
          'selection. Give the survivor a monograph, or widen the focus first',
      );
    }
  }

  const selfEdges = await scalar(db, selfEdgeSql(survivor.id, loser.id));
  const blockedParameters = await blockedParametersFor(
    db,
    survivor.id,
    await movingParameters(db, survivor.id, loser.id),
  );

  return {
    survivor,
    loser,
    refusals: refusalList,
    carried,
    pages,
    blockedParameters,
    selfEdges,
    settledEdits,
    typedNonFk,
    simulatorCases,
    kinelabCases,
    survivorPageId,
    survivorLegacyMonographCid,
    focusPageIds,
    focusAllPageIds: focus.pageIds,
    extractionHints,
    caseFrom,
    caseTo,
  };
}

function describe(plan: Plan, adoptCid: boolean): void {
  const label = (d: DrugRow) =>
    `${d.id} (${d.slug}, CID ${d.pubchemCid ?? '—'}, class ${d.substanceClass}) ` +
    JSON.stringify(d.names);
  console.log(`Survivor: ${label(plan.survivor)}`);
  console.log(`Loser   : ${label(plan.loser)}`);
  if (adoptCid) {
    console.log(
      `  --adopt-cid: the survivor's CID becomes ${plan.loser.pubchemCid ?? '—'} ` +
        `(was ${plan.survivor.pubchemCid ?? '—'}), applied after the loser is deleted ` +
        'so the unique index allows it',
    );
    if (plan.survivorLegacyMonographCid != null) {
      console.log(
        `  the survivor's monograph is legacy-keyed by ${plan.survivorLegacyMonographCid} ` +
          `— repointed to drug_cid = ${plan.survivor.id}, or the CID change strands it ` +
          'and the next backfill builds a second, empty page',
      );
    }
  }
  console.log('\nWhat the loser carries:');
  for (const line of plan.carried) console.log(`  ${line}`);
  if (plan.selfEdges > 0) {
    console.log(
      `  ${plan.selfEdges} metabolite link(s) between the two drugs — dropped ` +
        '(a substance cannot be its own metabolite)',
    );
  }
  for (const p of plan.pages) {
    console.log(`  monograph page ${p.id} /${p.slug}: ${p.chars} chars — DELETED`);
  }
  if (plan.simulatorCases > 0) {
    console.log(
      `  simulator_cases: ${plan.simulatorCases} saved case(s) name the loser — ` +
        'repointed to the survivor',
    );
  }
  if (plan.kinelabCases > 0) {
    console.log(
      `  simulator_cases: ${plan.kinelabCases} saved KineLab case(s) name the loser's ` +
        `slug as their analyte — repointed to /${plan.survivor.slug}`,
    );
  }
  for (const t of plan.typedNonFk) {
    console.log(`  ${t.label}: ${t.rows} — move (no FK; the schema scan cannot see it)`);
  }
  if (plan.extractionHints > 0) {
    console.log(
      `  paper_extraction_jobs.target_drug_ids: ${plan.extractionHints} job(s) name the ` +
        'loser — repointed to the survivor (no FK; an array cannot carry one)',
    );
  }
  if (plan.focusPageIds.length > 0) {
    console.log(
      `  agent_focus_config.page_ids: selects page(s) ${plan.focusPageIds.join(', ')} — ` +
        (plan.survivorPageId !== null
          ? `repointed to the survivor's monograph ${plan.survivorPageId}`
          : 'pruned (the survivor has no monograph to move the selection to)'),
    );
  }
  if (plan.settledEdits > 0) {
    console.log(
      `  ${plan.settledEdits} settled pending_edits row(s) — DELETED (the durable ` +
        'audit trail is verification_log / approvals, which are left alone)',
    );
  }
  if (plan.blockedParameters.length > 0) {
    console.log(
      `  not applicable to the survivor, will NOT move: ${plan.blockedParameters.join(', ')}`,
    );
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.into || !opts.from || opts.into === opts.from) {
    console.error('Usage: --into <survivor drug id> --from <loser drug id> [--apply]');
    process.exit(1);
  }
  // Bound to locals so the narrowing above survives into the closures below —
  // TypeScript drops property narrowing at a function boundary, which is why
  // the transaction body used to re-assert `opts.into!` / `opts.from!`.
  const intoId = opts.into;
  const fromId = opts.from;

  // ── Preflight: report, and refuse before writing anything ────────────────
  const plan = await buildPlan(getDb(), intoId, fromId, false, opts.adoptCid);
  describe(plan, opts.adoptCid);

  const identity = mergeIdentity(
    {
      names: plan.survivor.names ?? {},
      aliases: plan.survivor.aliases ?? [],
      nameShort: plan.survivor.nameShort,
    },
    {
      names: plan.loser.names ?? {},
      aliases: plan.loser.aliases ?? [],
      nameShort: plan.loser.nameShort,
    },
  );
  if (identity.addedNames.length)
    console.log(`\n  names   += ${identity.addedNames.join(', ')}`);
  if (identity.addedAliases.length)
    console.log(`  aliases += ${identity.addedAliases.join(', ')}`);
  if (identity.inheritedNameShort)
    console.log(`  nameShort inherited: ${identity.inheritedNameShort}`);

  if (plan.refusals.length > 0) {
    console.error('\nRefusing to merge:');
    for (const r of plan.refusals) console.error(`  - ${r}`);
    process.exit(1);
  }

  if (!opts.apply) {
    console.log('\nDry run — nothing written. Re-run with --apply to perform the merge.');
    return;
  }

  // ── Apply, atomically ────────────────────────────────────────────────────
  // Two layers of serialization, because no single one covers every writer.
  // The per-drug advisory lock is the one the API and importers take for
  // parameter and applicability writes; `FOR UPDATE` on the two drug rows and
  // the loser's monographs covers the writers that take no advisory lock at all
  // (drug metadata edits, wiki saves). Both drugs lock lowest-id-first so two
  // concurrent merges over an overlapping pair cannot deadlock.
  //
  // Then the ENTIRE plan is rebuilt from the locked rows and re-checked. A
  // preflight-only check is a check-then-write however carefully it is written.
  const firstLock = Math.min(intoId, fromId);
  const secondLock = Math.max(intoId, fromId);
  await runInPoolTransaction(async () => {
    await withDrugApplicabilityLock(firstLock, async () => {
      await withDrugApplicabilityLock(secondLock, async () => {
        const tx = getDb();
        const live = await buildPlan(tx, intoId, fromId, true, opts.adoptCid);
        if (live.refusals.length > 0) {
          throw new Error(
            'Refusing to merge — the catalog changed since the preflight:\n' +
              live.refusals.map((r) => `  - ${r}`).join('\n'),
          );
        }

        // Identity is recomputed from the locked rows, not the preflight's:
        // a metadata edit in between would otherwise be overwritten by a stale
        // copy of the names it just changed.
        const merged = mergeIdentity(
          {
            names: live.survivor.names ?? {},
            aliases: live.survivor.aliases ?? [],
            nameShort: live.survivor.nameShort,
          },
          {
            names: live.loser.names ?? {},
            aliases: live.loser.aliases ?? [],
            nameShort: live.loser.nameShort,
          },
        );
        const inheritedPath =
          !live.survivor.farmakologiportalenPath && live.loser.farmakologiportalenPath
            ? live.loser.farmakologiportalenPath
            : null;
        const inheritedSource =
          !live.survivor.source && live.loser.source ? live.loser.source : null;

        // Links between the two drugs become `survivor -> survivor` once the
        // endpoints are rewritten. The refusals have established that none of
        // them state anything, so they are dropped rather than rewritten.
        await tx.execute(
          sql.raw(`
            DELETE FROM drug_metabolites
            WHERE (parent_drug_id = ${live.survivor.id} AND metabolite_drug_id = ${live.loser.id})
               OR (parent_drug_id = ${live.loser.id} AND metabolite_drug_id = ${live.survivor.id})`),
        );

        // Parameters the applicability layer says the survivor cannot hold are
        // deleted rather than moved — the same outcome the cascade would
        // produce, done explicitly so the dry run could say so first.
        if (live.blockedParameters.length > 0) {
          await tx.execute(
            sql.raw(`
              DELETE FROM drug_parameters
              WHERE "drug_id" = ${live.loser.id}
                AND "parameter" IN (${live.blockedParameters
                  .map((p) => `'${p.replace(/'/g, "''")}'`)
                  .join(', ')})`),
          );
        }

        for (const spec of MOVABLE) {
          // Move only what the survivor does not already have…
          await tx.execute(
            sql.raw(`
              UPDATE "${spec.table}" t SET "${spec.column}" = ${live.survivor.id}
              WHERE t."${spec.column}" = ${live.loser.id}
                AND NOT EXISTS (
                  SELECT 1 FROM "${spec.table}" s
                  WHERE s."${spec.column}" = ${live.survivor.id} AND ${spec.conflict}
                )`),
          );
          // …and drop what stayed behind. The refusals have established that
          // nothing left here states anything of its own, so these are pure
          // duplicates. They must go rather than linger: metabolite_drug_id is
          // ON DELETE SET NULL, which would otherwise degrade a resolved link
          // into an unresolved free-text one.
          await tx.execute(
            sql.raw(`DELETE FROM "${spec.table}" WHERE "${spec.column}" = ${live.loser.id}`),
          );
        }

        await tx
          .update(drugs)
          .set({
            names: merged.names,
            aliases: merged.aliases,
            nameShort: merged.nameShort,
            searchKey: merged.searchKey,
            // Both halves of one substance's attention. The score only ever
            // accumulates (+1 per view, per edit, per approved entry) and is
            // never recomputed from `drug_interactions`, so the loser's share
            // is unrecoverable once its row goes — and the score drives both
            // the default drug ordering and the parameter-gap work queue, so
            // dropping it demotes a substance that was actually being used.
            popularityScore: live.survivor.popularityScore + live.loser.popularityScore,
            ...(inheritedPath ? { farmakologiportalenPath: inheritedPath } : {}),
            ...(inheritedSource ? { source: inheritedSource } : {}),
            updatedAt: new Date(),
          })
          .where(eq(drugs.id, live.survivor.id));

        // Saved cases keep referring to the substance, which still exists, so
        // the reference is rewritten rather than orphaned. Guarded by the same
        // containment test that counted them, so only affected cases are
        // touched and a case without a `drugs` array is left alone.
        {
          // Taken from the plan rather than recomputed, so the keys the
          // ambiguity guard was asked about are the keys that get written.
          const { caseFrom: from, caseTo: to } = live;
          const fromList = from.map((key) => quote(key)).join(', ');
          const fromContainment = from
            .map(
              (key) =>
                `case_data->'drugs' @> ${quote(`[{"drugId":${JSON.stringify(key)}}]`)}::jsonb`,
            )
            .join(' OR ');
          await tx.execute(
            sql.raw(`
              UPDATE simulator_cases SET case_data = jsonb_set(
                case_data, '{drugs}',
                (SELECT jsonb_agg(
                   CASE WHEN d->>'drugId' IN (${fromList})
                        THEN jsonb_set(d, '{drugId}', to_jsonb(${quote(to)}::text))
                        ELSE d END)
                 FROM jsonb_array_elements(case_data->'drugs') d)
              )
              WHERE ${fromContainment}`),
          );
        }

        // The editor's extraction hint, which is an array and therefore
        // outside both the FK graph and the scalar non-FK moves below.
        await tx.execute(sql.raw(extractionHintSql(live.survivor.id, live.loser.id)));

        // The other shape of saved case, keyed by slug rather than by the
        // component id, and silently defaulted rather than failed when its
        // analyte stops resolving.
        await tx.execute(
          sql.raw(`
            UPDATE simulator_cases
            SET case_data = jsonb_set(
              case_data, '{input,analyte}', to_jsonb(${quote(live.survivor.slug)}::text))
            WHERE ${kinelabCaseWhere(live.loser.slug)}`),
        );

        // Relations holding a drug id with no FK behind it. Moved explicitly
        // because nothing else will: the cascade cannot reach them and the
        // schema scan cannot see them.
        for (const spec of TYPED_NON_FK_MOVES) {
          await tx.execute(
            sql.raw(`
              UPDATE "${spec.table}" SET "${spec.column}" = ${live.survivor.id}
              WHERE "${spec.column}" = ${live.loser.id} AND ${spec.where}`),
          );
        }

        // An admin's focus selection follows the substance, before the page it
        // names is deleted. Replaced by the survivor's monograph where there is
        // one — the admin chose a substance, and that substance survives — and
        // otherwise pruned, because a dangling page id resolves to no drug and
        // silently narrows the agent's scope rather than failing.
        if (live.focusPageIds.length > 0) {
          const kept = live.focusAllPageIds.filter(
            (id) => !live.focusPageIds.includes(id),
          );
          const next =
            live.survivorPageId !== null && !kept.includes(live.survivorPageId)
              ? [...kept, live.survivorPageId]
              : kept;
          await tx.execute(
            sql.raw(`
              UPDATE agent_focus_config
              SET page_ids = ${quote(JSON.stringify(next))}::jsonb, updated_at = now()
              WHERE id = 1`),
          );
        }

        // Teardown, mirroring handleDelete: the monograph and the polymorphic
        // pending edits are not FK-bound, so the cascade does not reach them.
        const pageIds = live.pages.map((p) => p.id);
        if (pageIds.length > 0) {
          await tx
            .delete(pendingEdits)
            .where(
              and(
                inArray(pendingEdits.targetId, pageIds),
                inArray(pendingEdits.editType, ['wiki_page', 'wiki_section', 'wiki_fact']),
              ),
            );
          await tx.delete(wikiPages).where(inArray(wikiPages.id, pageIds));
        }
        await tx
          .delete(pendingEdits)
          .where(
            and(
              eq(pendingEdits.targetId, live.loser.id),
              inArray(pendingEdits.editType, DRUG_SCOPED_EDIT_TYPES),
            ),
          );
        // param_entry proposals are polymorphic: a create stores the drug id, an
        // update/delete a parameter_entries.id. The two id spaces collide, so
        // the predicates are keyed by op — never a combined target_id IN (…).
        await tx
          .delete(pendingEdits)
          .where(
            and(
              eq(pendingEdits.editType, 'param_entry'),
              eq(pendingEdits.targetId, live.loser.id),
              sql`${pendingEdits.proposedValue} ->> 'op' = 'create'`,
            ),
          );
        const entryIds = (
          await tx
            .select({ id: parameterEntries.id })
            .from(parameterEntries)
            .where(eq(parameterEntries.drugId, live.loser.id))
        ).map((r) => r.id);
        if (entryIds.length > 0) {
          await tx
            .delete(pendingEdits)
            .where(
              and(
                eq(pendingEdits.editType, 'param_entry'),
                inArray(pendingEdits.targetId, entryIds),
                sql`${pendingEdits.proposedValue} ->> 'op' IN ('update', 'delete')`,
              ),
            );
        }

        await tx.delete(drugs).where(eq(drugs.id, live.loser.id));

        // Only now is the number free: `pubchem_cid` is UNIQUE, so the
        // survivor cannot take it while the loser still holds it. This is the
        // whole reason the adoption belongs inside the merge rather than in a
        // second command — split in two, the catalog sits between them with the
        // right substance under the wrong identity.
        if (opts.adoptCid && live.loser.pubchemCid != null) {
          // Move the survivor's own legacy-keyed monograph onto the row id
          // BEFORE the CID changes out from under it. Decided in `buildPlan`
          // (re-run here under the locks), so the dry run says it will happen —
          // see `Plan.survivorLegacyMonographCid` for why it is needed at all.
          if (live.survivorLegacyMonographCid != null) {
            await tx
              .update(wikiPages)
              .set({ drugCid: live.survivor.id, updatedAt: new Date() })
              .where(
                and(
                  eq(wikiPages.pageType, 'drug_monograph'),
                  eq(wikiPages.drugCid, live.survivorLegacyMonographCid),
                ),
              );
          }

          await tx
            .update(drugs)
            .set({ pubchemCid: live.loser.pubchemCid, updatedAt: new Date() })
            .where(eq(drugs.id, live.survivor.id));
        }
      });
    });
  });

  console.log(`\nMerged drug ${opts.from} into ${opts.into}. Done.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
