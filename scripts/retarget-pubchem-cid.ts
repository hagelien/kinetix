/**
 * Point a drug row at a different PubChem CID.
 *
 * The companion to `audit:pubchem-identity`, which finds rows whose stored CID
 * names a different substance — `imatinib` on a guanidine, `baricitinib` on
 * carbonyl chloride fluoride. That is a one-column fix, and doing it by hand in
 * SQL is how the wrong number got there in the first place.
 *
 * A CID is not a label. It is the key the offline catalog, the postmortem
 * resources and the method catalog all resolve by, it is what a saved simulator
 * case pins a drug with, and it is the address a reader follows out to PubChem.
 * So changing it is four changes at once, and this makes all four explicit:
 *
 *   1. It asks PubChem whether the new CID actually answers to this drug's
 *      names. A correction to another wrong number is not an improvement, and
 *      the same loose name lookup that produced the bad CIDs is available to
 *      whoever is fixing them.
 *   2. It repoints saved simulator cases, which key a CID-less drug on its own
 *      internal id (see #1256) — leaving them behind does not break the case,
 *      it silently loads whatever drug now answers to the old number and
 *      simulates that one instead.
 *   3. It refuses if a monograph is keyed by the OLD CID (`wiki_pages.drug_cid`
 *      is mixed-vintage and not an FK), which the change would orphan.
 *   4. It refuses while any repo file is still keyed by the old CID, because
 *      those files seed the database: the retarget frees that number, and
 *      `seed:drugs` upserts on it while `seed:pm-concentrations` creates a drug
 *      for a CID it cannot find. Leave one and the next seed run rebuilds the
 *      wrong substance beside the corrected row.
 *
 * Usage:
 *   npm run retarget:cid -- --drug 493 --to 5291              # dry run
 *   npm run retarget:cid -- --drug 493 --to 5291 --apply
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { getDb, runInPoolTransaction } from '../api/_lib/db';
import { catalogForms, candidates, matchesAny } from './pubchem/names';
import { resolveMonographDrugCids } from '../api/_lib/monograph-helpers';
import { simulatorDrugKeyCandidates } from '../src/lib/drugComponentId';
import { embeddedComponents } from '../data/components';
import { lockDrugForRetarget, rewriteCaseKeysAndCid } from './lib/retarget-cid-apply';
import { seedSourceRefusal, seedSourcesFor } from './pubchem/seed-sources';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const PUBCHEM = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid';

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

function parseArgs(argv: string[]): { drug: number | null; to: number | null; apply: boolean } {
  const opts: { drug: number | null; to: number | null; apply: boolean } = {
    drug: null,
    to: null,
    apply: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--apply') opts.apply = true;
    else if (a === '--drug') opts.drug = Number(argv[++i]);
    else if (a === '--to') opts.to = Number(argv[++i]);
    else if (a.startsWith('--drug=')) opts.drug = Number(a.split('=')[1]);
    else if (a.startsWith('--to=')) opts.to = Number(a.split('=')[1]);
  }
  return opts;
}

interface DrugRow {
  id: number;
  slug: string;
  names: Record<string, string> | null;
  aliases: string[] | null;
  nameShort: string | null;
  pubchemCid: number | null;
}

async function readDrug(db: Db, id: number, lock: boolean): Promise<DrugRow> {
  const res = await db.execute(
    sql.raw(`
      SELECT id, slug, names, aliases, name_short AS "nameShort",
             pubchem_cid AS "pubchemCid"
      FROM drugs WHERE id = ${id}${lock ? ' FOR UPDATE' : ''}`),
  );
  const row = (rowsOf(res) as unknown as DrugRow[])[0];
  if (!row) throw new Error(`Drug ${id} not found`);
  return row;
}

interface Identity {
  title: string | null;
  formula: string | null;
  synonyms: string[];
}

/** What PubChem says the new CID is. */
async function pubchemIdentity(cid: number): Promise<Identity | null> {
  const props = await fetch(`${PUBCHEM}/${cid}/property/Title,MolecularFormula/JSON`);
  if (!props.ok) return null;
  const body = (await props.json()) as {
    PropertyTable?: { Properties?: { Title?: string; MolecularFormula?: string }[] };
  };
  const p = body.PropertyTable?.Properties?.[0];
  if (!p) return null;
  const syn = await fetch(`${PUBCHEM}/${cid}/synonyms/JSON`);
  const synonyms = syn.ok
    ? ((await syn.json()) as {
        InformationList?: { Information?: { Synonym?: string[] }[] };
      }).InformationList?.Information?.[0]?.Synonym ?? []
    : [];
  return { title: p.Title ?? null, formula: p.MolecularFormula ?? null, synonyms };
}

interface Plan {
  drug: DrugRow;
  identity: Identity | null;
  refusals: string[];
  simulatorCases: number;
  seededElsewhere: { file: string; label?: string }[];
}

async function buildPlan(db: Db, drugId: number, to: number, lock: boolean): Promise<Plan> {
  const drug = await readDrug(db, drugId, lock);
  const refusals: string[] = [];

  if (drug.pubchemCid === to) {
    refusals.push(`drug ${drug.id} already carries CID ${to} — nothing to do`);
  }

  const taken = await scalar(
    db,
    `SELECT count(*)::int AS n FROM drugs WHERE pubchem_cid = ${to} AND id <> ${drug.id}`,
  );
  if (taken > 0) {
    refusals.push(
      `another drug already carries CID ${to}. If they are the same substance, that is a ` +
        'merge (npm run merge:drugs), not a retarget — a retarget here would only fail ' +
        'the unique index',
    );
  }

  // The NEW number can shadow a drug that has no CID of its own, because such a
  // drug is keyed in saved cases by its bare `drugs.id` and
  // `hydrateComponentByRouteId` tries the CID lookup FIRST. Taking that number
  // does not break the other drug's cases — it silently makes them load this
  // substance and simulate it with these parameters, which is the same
  // wrong-answer-that-looks-right the merge refuses on, arriving from the
  // opposite direction.
  const shadowed = rowsOf(
    await db.execute(
      sql.raw(`
        SELECT id, slug FROM drugs
        WHERE id = ${to} AND pubchem_cid IS NULL AND id <> ${drug.id}`),
    ),
  )[0];
  if (shadowed) {
    const shadowedCases = await scalar(
      db,
      `SELECT count(*)::int AS n FROM simulator_cases
       WHERE case_data->'drugs' @> '[{"drugId":"${to}"}]'::jsonb`,
    );
    // Refused whether or not a case exists TODAY. An earlier revision warned
    // when the count was zero, on the grounds that no harm had happened yet —
    // but nothing about taking the number is undone by that. The other drug
    // still has no CID, so `drugRowToComponent` still keys it by this id, and
    // the first case anyone saves for it afterwards resolves here instead. A
    // guard scoped to existing rows is a guard against the past.
    refusals.push(
      `CID ${to} is also the internal id of drug ${shadowed.id} ` +
        `(${String(shadowed.slug)}), which has no CID of its own, so saved cases key ` +
        `that drug by this number — ${shadowedCases} of them today, and any saved ` +
        `afterwards too. Taking it would make them load ${drug.slug} instead. Give ` +
        `${String(shadowed.slug)} its own CID first`,
    );
  }

  // The catalog's own claim about what this substance is has to survive the
  // change. A CID that answers to none of the drug's names is a second guess,
  // not a correction — and the audit's `by name` column is produced by exactly
  // the kind of lookup that put the wrong numbers here.
  const identity = await pubchemIdentity(to);
  if (!identity) {
    refusals.push(`PubChem has no compound ${to}`);
  } else {
    const forms = catalogForms(drug);
    const named =
      (identity.title != null && candidates(identity.title).some((c) => matchesAny(forms, c))) ||
      identity.synonyms.some((s) => matchesAny(forms, s));
    if (!named) {
      refusals.push(
        `CID ${to} is "${identity.title ?? 'untitled'}" (${identity.formula ?? '?'}), which ` +
          `answers to none of this drug's names (${[
            ...Object.values(drug.names ?? {}).map(String),
            ...(drug.aliases ?? []),
          ].join(', ')}). Check the formula before forcing it`,
      );
    }
  }

  // A monograph keyed by the OLD CID is legacy-vintage and not an FK, so
  // nothing repoints it and nothing complains — it just stops resolving.
  //
  // Which pages those are is not "every page whose drug_cid equals the old
  // number": the two id spaces collide, so that number can equally be another
  // drug's `drugs.id` and the page found would be that drug's modern monograph.
  // Refusing on it would block this retarget over a page belonging to a
  // different substance. `resolveMonographDrugCids` is the repo's answer to
  // that collision — it drops a CID that is also some other drug's internal id
  // — so the old CID is only treated as a monograph key when it survives that.
  //
  // With one exception the resolver cannot express: when a drug's CID EQUALS
  // its own internal id, the two keys are the same number, and the candidate
  // list cannot say which of the two it is. Every ordinary modern monograph
  // would then look legacy-keyed and refuse — with a message telling the
  // operator to set `drug_cid` to the value it already holds, making the
  // correction impossible for exactly those drugs. A page keyed by that number
  // is reachable as `drugs.id` regardless of what the CID becomes, so there is
  // nothing to protect here.
  const monographCids = await resolveMonographDrugCids(db, drug);
  if (
    drug.pubchemCid != null &&
    drug.pubchemCid !== drug.id &&
    monographCids.includes(drug.pubchemCid)
  ) {
    const pages = rowsOf(
      await db.execute(
        sql.raw(`
          SELECT id, slug FROM wiki_pages
          WHERE page_type = 'drug_monograph' AND drug_cid = ${drug.pubchemCid}`),
      ),
    );
    if (pages.length > 0) {
      refusals.push(
        `${pages.length} monograph page(s) are keyed by the old CID ${drug.pubchemCid} ` +
          `(${pages.map((p) => `/${String(p.slug)}`).join(', ')}). Repoint them to ` +
          `drug_cid = ${drug.id} first, or the change orphans them`,
      );
    }
  }

  // Saved cases pin a drug by `buildDrugComponentId` — a bare CID, or (#1256)
  // a `drug:<id>` key for a CID-less drug. A CID-less drug being given its
  // first CID here can have cases saved under either spelling (the prefixed
  // one only exists once #1256 ships), so both are rewritten.
  const oldKeys = simulatorDrugKeyCandidates(drug);
  const simulatorCases = await scalar(
    db,
    `SELECT count(*)::int AS n FROM simulator_cases
     WHERE ${oldKeys
       .map((k) => `case_data->'drugs' @> '[{"drugId":${JSON.stringify(k)}}]'::jsonb`)
       .join(' OR ')}`,
  );
  // The question is about the KEY, not about this drug — an earlier revision
  // asked only whether THIS row lacked a CID and stopped there. A bare
  // numeric key is ambiguous whenever both spellings of that number exist in
  // the catalog: one drug carrying it as a `pubchem_cid`, another CID-less
  // drug carrying it as an internal id. Whether the drug being retargeted is
  // the CID side or the id side does not change that the rewrite would sweep
  // up both. A `drug:<id>` key can't be ambiguous — skip it.
  if (simulatorCases > 0) {
    for (const oldKey of oldKeys) {
      if (!/^\d+$/.test(oldKey)) continue;
      const ambiguous = await scalar(
        db,
        `SELECT count(*)::int AS n FROM drugs a
         WHERE a.pubchem_cid = ${oldKey}
           AND EXISTS (
             SELECT 1 FROM drugs b
             WHERE b.id = ${oldKey} AND b.pubchem_cid IS NULL AND b.id <> a.id
           )`,
      );
      if (ambiguous > 0) {
        refusals.push(
          `${simulatorCases} saved case(s) are in scope and the key "${oldKey}" names two ` +
            'substances — one drug carries it as its PubChem CID, another with no CID of ' +
            'its own carries it as its internal id. The rewrite cannot tell which cases ' +
            'mean this drug; give the CID-less one a CID first',
        );
      }
    }
  }

  // Every repo file still keyed by the OLD CID, because those files seed this
  // database and the retarget frees that number. `seed:drugs` upserts on
  // `pubchem_cid`, and `seed:pm-concentrations` CREATES a drug for a CID it
  // cannot find — so a stale entry does not merely go unused, it rebuilds the
  // wrong substance beside the corrected row on the next run, and the audit
  // that found this reports it all over again.
  //
  // A refusal rather than a warning, deliberately. A printed reminder arrives
  // after the write and depends on whoever ran it reading the last line; the
  // whole point of correcting a CID is not to leave a resurrection behind.
  const seededElsewhere =
    drug.pubchemCid != null ? seedSourcesFor(drug.pubchemCid, embeddedComponents) : [];
  if (seededElsewhere.length > 0 && drug.pubchemCid != null) {
    refusals.push(seedSourceRefusal(drug.pubchemCid, seededElsewhere, `CID ${to}`));
  }

  return { drug, identity, refusals, simulatorCases, seededElsewhere };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.drug || !opts.to) {
    console.error('Usage: --drug <drug id> --to <pubchem cid> [--apply]');
    process.exit(1);
  }

  const plan = await buildPlan(getDb(), opts.drug, opts.to, false);
  console.log(
    `Drug ${plan.drug.id} (${plan.drug.slug}) ` +
      `${JSON.stringify(plan.drug.names)}\n` +
      `  CID ${plan.drug.pubchemCid ?? '—'} → ${opts.to}`,
  );
  if (plan.identity) {
    console.log(
      `  ${opts.to} is "${plan.identity.title ?? 'untitled'}" ` +
        `(${plan.identity.formula ?? '?'}), ${plan.identity.synonyms.length} synonyms`,
    );
  }
  if (plan.simulatorCases > 0) {
    console.log(`  simulator_cases: ${plan.simulatorCases} — repointed to the new key`);
  }
  console.log(
    `  ⚠  grep the old CID before you finish: ` +
      `grep -rn "${plan.drug.pubchemCid}" data/ resources/`,
  );

  if (plan.refusals.length > 0) {
    console.error('\nRefusing to retarget:');
    for (const r of plan.refusals) console.error(`  - ${r}`);
    process.exit(1);
  }

  if (!opts.apply) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    return;
  }

  await runInPoolTransaction(async () => {
    const tx = getDb();
    // Advisory lock before the FOR UPDATE below, as the merge orders them, so
    // a concurrent case save serializes against this retarget (#1076 item 4).
    await lockDrugForRetarget(opts.drug!);
    // Rebuilt from the locked row rather than trusted from the preflight: an
    // admin metadata edit takes no lock this script can share, and it can
    // change the very names the identity check just passed on.
    const live = await buildPlan(tx, opts.drug!, opts.to!, true);
    if (live.refusals.length > 0) {
      throw new Error(
        'Refusing to retarget — the catalog changed since the preflight:\n' +
          live.refusals.map((r) => `  - ${r}`).join('\n'),
      );
    }

    await rewriteCaseKeysAndCid(
      tx,
      live.drug.id,
      simulatorDrugKeyCandidates(live.drug),
      opts.to!,
    );
  });

  console.log(`\nDone. Drug ${plan.drug.id} now carries CID ${opts.to}.`);
  console.log(
    'Retire the old CID from the repo files that seed this database, then re-run ' +
      'npm run catalog:check and npm run kinetics:provenance:check.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
