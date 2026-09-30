/**
 * Import every substance from Farmakologiportalen
 * (https://farmakologiportalen.no/substances) into Kinetix.
 *
 *   - Pulls the substance index from /farma/search/substances and fetches each
 *     substance's content page.
 *   - Parses the PK/PD parameter table, the therapeutic reference range, and
 *     the related-metabolite list (see scripts/farmakologiportalen/parse.ts).
 *   - Resolves a PubChem CID per substance (CAS first, then name) so imports
 *     dedupe against the existing CID-keyed catalog and fill `pubchem_cid`.
 *   - Dedupes against existing drugs by PubChem CID, then by normalized name /
 *     alias, so re-runs never create duplicates.
 *   - Records each substance's portal path in `drugs.farmakologiportalen_path`
 *     (on new rows and on pre-existing rows the portal also lists) so the
 *     monograph can link out to its counterpart. To fill those links WITHOUT a
 *     full re-import, run `npm run backfill:farmakologiportalen-links`.
 *   - Flags every imported substance with `drugs.source = 'farmakologiportalen'`
 *     (both newly created rows and pre-existing rows that the portal also
 *     lists), and writes available parameters into `drug_parameters` /
 *     metabolites into `drug_metabolites` WITHOUT overwriting curated values
 *     (insert-if-absent only).
 *
 * Usage:
 *   npm run import:farmakologiportalen
 *   npm run import:farmakologiportalen -- --limit 10 --dry-run
 *   npm run import:farmakologiportalen -- --no-pubchem
 */
import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { and, eq, sql } from 'drizzle-orm';
import {
  drugs,
  drugParameters,
  drugMetabolites,
} from '../db/schema';
import {
  blockedParametersFor,
  withDrugApplicabilityLock,
} from '../api/_lib/parameterApplicabilityStore';
import { getDb } from '../api/_lib/db';
import { generateSlug } from '../api/_lib/slug';
import { buildDrugSearchKey } from '../src/lib/drugNames';
import { farmakologiportalenUrl } from '../src/lib/farmakologiportalen';
import {
  inferMetaboliteActivity,
  normalizeMetabolismName,
} from '../src/lib/metabolism';
import { DRUG_PARAMETERS, type DrugParameterId } from '../src/lib/drugParameters';
import {
  parseSubstanceList,
  parseSubstancePage,
  splitTitle,
  type ParsedSubstancePage,
  type SubstanceListItem,
} from './farmakologiportalen/parse';

const SOURCE = 'farmakologiportalen';
const BASE_URL = 'https://farmakologiportalen.no';
const LIST_URL = `${BASE_URL}/farma/search/substances`;
const USER_AGENT =
  'KinetixImporter/1.0 (+https://github.com/hagelien/kinetix; substance import)';

// Page-fetch concurrency. The portal is a public reference site; a modest
// pool keeps the import quick without hammering it.
const FETCH_CONCURRENCY = 6;
// PubChem PUG-REST asks for ≤5 requests/second; stay well under it.
const PUBCHEM_SPACING_MS = 220;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

interface Options {
  limit: number | null;
  dryRun: boolean;
  usePubchem: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { limit: null, dryRun: false, usePubchem: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-pubchem') opts.usePubchem = false;
    else if (a === '--limit') opts.limit = Number(argv[++i]) || null;
    else if (a.startsWith('--limit=')) opts.limit = Number(a.split('=')[1]) || null;
  }
  return opts;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url: string, attempt = 0): Promise<string | null> {
  const MAX_ATTEMPTS = 4;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (res.ok) return await res.text();
    // 404 is a genuine "not found" — don't waste retries on it. Everything
    // else (5xx, Cloudflare 52x, 429, …) is treated as transient.
    if (res.status === 404) return null;
    if (attempt < MAX_ATTEMPTS) {
      await sleep(500 * 2 ** attempt);
      return fetchText(url, attempt + 1);
    }
    return null;
  } catch {
    if (attempt < MAX_ATTEMPTS) {
      await sleep(500 * 2 ** attempt);
      return fetchText(url, attempt + 1);
    }
    return null;
  }
}

// ─── PubChem CID resolution ──────────────────────────────────────────────────

const cidCache = new Map<string, number | null>();

async function pubchemCids(path: string): Promise<number | null> {
  const text = await fetchText(`https://pubchem.ncbi.nlm.nih.gov/rest/pug/${path}`);
  if (!text) return null;
  try {
    const json = JSON.parse(text) as { IdentifierList?: { CID?: number[] } };
    const cid = json.IdentifierList?.CID?.[0];
    return typeof cid === 'number' && cid > 0 ? cid : null;
  } catch {
    return null;
  }
}

/** Resolve a PubChem CID by CAS first, then by name. Cached, rate-limited. */
async function resolveCid(cas: string | null, name: string): Promise<number | null> {
  const key = `${cas ?? ''}|${name.toLowerCase()}`;
  const cached = cidCache.get(key);
  if (cached !== undefined) return cached;

  let cid: number | null = null;
  if (cas) {
    await sleep(PUBCHEM_SPACING_MS);
    cid = await pubchemCids(`compound/xref/RN/${encodeURIComponent(cas)}/cids/JSON`);
  }
  if (cid === null && name) {
    await sleep(PUBCHEM_SPACING_MS);
    cid = await pubchemCids(`compound/name/${encodeURIComponent(name)}/cids/JSON`);
  }
  cidCache.set(key, cid);
  return cid;
}

// ─── Concurrency helper ──────────────────────────────────────────────────────

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return results;
}

// ─── Parameter validation ────────────────────────────────────────────────────

const PARSED_PARAM_IDS: DrugParameterId[] = [
  'bioavailability',
  'tmax',
  'proteinBinding',
  'volumeOfDistribution',
  'bloodPlasmaRatio',
  'halfLife',
  'therapeuticConcentration',
];

/** Run a parsed value through the registry's zod schema; skip on failure. */
function validateParam(id: DrugParameterId, value: unknown, label: string): unknown | null {
  if (value === null || value === undefined) return null;
  const result = DRUG_PARAMETERS[id].zod.safeParse(value);
  if (!result.success) {
    console.warn(
      `  [skip] ${label}: ${id} failed validation — ${result.error.issues
        .map((iss) => iss.message)
        .join('; ')}`,
    );
    return null;
  }
  return result.data;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

interface Prepared {
  item: SubstanceListItem;
  base: string;
  alias: string | null;
  page: ParsedSubstancePage;
  cid: number | null;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const client = neon(DATABASE_URL!);
  const db = drizzle(client);

  console.log(`Fetching substance index from ${LIST_URL} …`);
  const listText = await fetchText(LIST_URL);
  if (!listText) throw new Error('Could not fetch substance index');
  let list = parseSubstanceList(JSON.parse(listText));
  console.log(`  → ${list.length} substances listed.`);
  if (opts.limit) list = list.slice(0, opts.limit);

  // 1) Fetch + parse all content pages (concurrent).
  console.log(`Fetching ${list.length} content pages (concurrency ${FETCH_CONCURRENCY}) …`);
  let fetched = 0;
  const pages = await mapPool(list, FETCH_CONCURRENCY, async (item) => {
    const html = await fetchText(BASE_URL + item.url);
    if (++fetched % 50 === 0) console.log(`  … ${fetched}/${list.length}`);
    return html ? parseSubstancePage(html) : null;
  });

  // 2) Resolve PubChem CIDs (sequential, rate-limited).
  const prepared: Prepared[] = [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i]!;
    const page = pages[i];
    if (!page) {
      console.warn(`  [warn] no page for ${item.title}`);
      continue;
    }
    const { base, alias } = splitTitle(item.title);
    const cid = opts.usePubchem ? await resolveCid(page.cas, base) : null;
    prepared.push({ item, base, alias, page, cid });
  }
  if (opts.usePubchem) {
    const resolved = prepared.filter((p) => p.cid !== null).length;
    console.log(`Resolved PubChem CID for ${resolved}/${prepared.length} substances.`);
  }

  // 3) Load existing-drug indexes for dedup.
  const existing = await db
    .select({ id: drugs.id, slug: drugs.slug, pubchemCid: drugs.pubchemCid, names: drugs.names, aliases: drugs.aliases, source: drugs.source })
    .from(drugs);
  const byCid = new Map<number, number>();
  const byName = new Map<string, number>();
  const slugsSeen = new Set<string>();
  for (const d of existing) {
    slugsSeen.add(d.slug);
    if (d.pubchemCid) byCid.set(d.pubchemCid, d.id);
    for (const n of Object.values(d.names ?? {})) {
      const k = normalizeMetabolismName(String(n));
      if (k && !byName.has(k)) byName.set(k, d.id);
    }
    for (const a of d.aliases ?? []) {
      const k = normalizeMetabolismName(a);
      if (k && !byName.has(k)) byName.set(k, d.id);
    }
  }

  function findExisting(p: Prepared): number | null {
    if (p.cid && byCid.has(p.cid)) return byCid.get(p.cid)!;
    for (const candidate of [p.base, p.item.title, p.alias ?? '']) {
      const k = normalizeMetabolismName(candidate);
      if (k && byName.has(k)) return byName.get(k)!;
    }
    return null;
  }

  function uniqueSlug(base: string, fallback: string): string {
    let slug = generateSlug(base) || generateSlug(fallback) || `substance-${fallback}`;
    const root = slug;
    let n = 2;
    while (slugsSeen.has(slug)) slug = `${root}-${n++}`;
    slugsSeen.add(slug);
    return slug;
  }

  // 4) Upsert drugs + parameters; track ids for the metabolite pass.
  const stats = {
    created: 0,
    matched: 0,
    flagged: 0,
    params: 0,
    // Values withheld because the pair is not a defined quantity for the
    // substance (marker or substance_class). Counted so a run reports it.
    paramsNotApplicable: 0,
    skipped: 0,
    cidBackfilled: 0,
    // Pre-existing rows whose portal link was written or corrected. New rows
    // are counted by `created` — they always carry the link.
    linked: 0,
  };
  const idByPrepared = new Map<Prepared, number>();

  for (const p of prepared) {
    const names: Record<string, string> = { nb: p.base };
    const aliases = p.alias ? [p.alias] : [];
    let drugId = findExisting(p);
    // Only store a path the monograph will actually render as a link; a shape
    // the renderer refuses is worth less in the column than NULL.
    const portalPath = farmakologiportalenUrl(p.item.url) ? p.item.url : null;

    if (drugId === null) {
      // New substance.
      const slug = uniqueSlug(p.base, String(p.item.associationId));
      const searchKey = buildDrugSearchKey({ names, aliases });
      // Only attach a resolved CID if it isn't already taken by another drug.
      const cid = p.cid && !byCid.has(p.cid) ? p.cid : null;
      if (opts.dryRun) {
        console.log(`  [new] ${p.base}  cid=${cid ?? '-'}  slug=${slug}`);
        stats.created++;
        continue;
      }
      const [inserted] = await db
        .insert(drugs)
        .values({
          slug,
          names,
          aliases,
          pubchemCid: cid,
          searchKey,
          source: SOURCE,
          farmakologiportalenPath: portalPath,
        })
        .returning({ id: drugs.id });
      if (!inserted) throw new Error(`INSERT returned no row for ${slug}`);
      drugId = inserted.id;
      stats.created++;
      stats.flagged++;
      if (cid) byCid.set(cid, drugId);
      byName.set(normalizeMetabolismName(p.base), drugId);
      if (p.alias) byName.set(normalizeMetabolismName(p.alias), drugId);
    } else {
      // Existing substance — flag provenance (without clobbering). Also
      // backfill the PubChem CID when the row lacks one and we resolved an
      // unclaimed CID, so CID-based lookups/dedupe work for it afterwards.
      stats.matched++;
      const backfillCid = p.cid && !byCid.has(p.cid) ? p.cid : null;
      if (!opts.dryRun) {
        const res = await db
          .update(drugs)
          .set({ source: SOURCE, updatedAt: new Date() })
          .where(and(eq(drugs.id, drugId), sql`${drugs.source} IS NULL`))
          .returning({ id: drugs.id });
        if (res.length) stats.flagged++;
        // The portal is the authority on its own addresses, so a path that no
        // longer matches is corrected rather than kept — but only when it
        // actually differs, so a re-run doesn't churn `updated_at` on every
        // row it has already linked.
        const linkRes = portalPath
          ? await db
              .update(drugs)
              .set({ farmakologiportalenPath: portalPath, updatedAt: new Date() })
              .where(
                and(
                  eq(drugs.id, drugId),
                  sql`${drugs.farmakologiportalenPath} IS DISTINCT FROM ${portalPath}`,
                ),
              )
              .returning({ id: drugs.id })
          : [];
        if (linkRes.length) stats.linked++;
        if (backfillCid) {
          const cidRes = await db
            .update(drugs)
            .set({ pubchemCid: backfillCid, updatedAt: new Date() })
            .where(and(eq(drugs.id, drugId), sql`${drugs.pubchemCid} IS NULL`))
            .returning({ id: drugs.id });
          if (cidRes.length) {
            byCid.set(backfillCid, drugId);
            stats.cidBackfilled++;
          }
        }
      } else {
        stats.flagged++;
      }
    }

    idByPrepared.set(p, drugId);

    // Parameters: insert-if-absent (never overwrite curated values).
    const paramValues: Partial<Record<DrugParameterId, unknown>> = {
      molecularWeight: p.page.molecularWeight,
      bioavailability: p.page.bioavailability,
      tmax: p.page.tmax,
      proteinBinding: p.page.proteinBinding,
      volumeOfDistribution: p.page.volumeOfDistribution,
      bloodPlasmaRatio: p.page.bloodPlasmaRatio,
      halfLife: p.page.halfLife,
      therapeuticConcentration: p.page.therapeuticConcentration,
    };
    // Values this page actually offers, validated up front so a substance with
    // nothing to write skips the lock entirely.
    const toWrite: Array<{ id: DrugParameterId; value: unknown }> = [];
    for (const id of ['molecularWeight', ...PARSED_PARAM_IDS] as DrugParameterId[]) {
      const value = validateParam(id, paramValues[id], p.base);
      if (value !== null) toWrite.push({ id, value });
    }

    if (opts.dryRun) {
      stats.params += toWrite.length;
      continue;
    }
    if (toWrite.length === 0) continue;

    // Check and write as one locked unit, on the same per-drug advisory lock
    // the API and the research importer take.
    //
    // The applicability check is only meaningful if nothing can change between
    // it and the inserts, and this importer is long-running — an editor
    // marking a pair or reclassifying a substance mid-run is a realistic
    // overlap, not a theoretical one. Preflighting on the auto-commit client
    // (as the first version of this did) is a check-then-write: both sides see
    // no conflict and both commit.
    //
    // Per substance rather than per run: one transaction across the whole
    // import would hold locks for its entire duration. The pool cost is
    // immaterial next to the page fetch and PubChem spacing this loop already
    // pays for each substance.
    await withDrugApplicabilityLock(drugId, async () => {
      const tx = getDb();
      const blockedForDrug = await blockedParametersFor(
        tx,
        drugId,
        toWrite.map((w) => w.id),
      );

      for (const { id, value } of toWrite) {
        if (blockedForDrug.includes(id)) {
          stats.paramsNotApplicable++;
          continue;
        }
        const res = await tx
          .insert(drugParameters)
          .values({ drugId, parameter: id, value: value as never })
          .onConflictDoNothing({
            target: [drugParameters.drugId, drugParameters.parameter],
          })
          .returning({ drugId: drugParameters.drugId });
        if (res.length) stats.params++;
      }
    });
  }

  // 5) Metabolite links — second pass so links can resolve to substances
  //    created earlier or later in this run. Only added for drugs that have
  //    no metabolite rows yet (don't disturb curated metabolism).
  let metaboliteLinks = 0;
  if (!opts.dryRun) {
    for (const p of prepared) {
      const drugId = idByPrepared.get(p);
      if (!drugId || p.page.metabolites.length === 0) continue;
      const existingCount = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(drugMetabolites)
        .where(eq(drugMetabolites.parentDrugId, drugId));
      if ((existingCount[0]?.n ?? 0) > 0) continue;

      const rows = p.page.metabolites.map((m, sortOrder) => ({
        parentDrugId: drugId,
        metaboliteDrugId: byName.get(normalizeMetabolismName(splitTitle(m.name).base)) ?? null,
        metaboliteName: m.name,
        activity: inferMetaboliteActivity(m.name),
        sortOrder,
      }));
      const res = await db
        .insert(drugMetabolites)
        .values(rows)
        // Untargeted: a page can name one substance twice (the bare name and a
        // qualified variant), which is one link once both resolve to the same
        // drug — the substance index (0099) catches that, the name index the
        // literal repeat.
        .onConflictDoNothing()
        .returning({ id: drugMetabolites.id });
      metaboliteLinks += res.length;
    }
  }

  console.log('\nImport summary' + (opts.dryRun ? ' (dry run)' : '') + ':');
  console.log(`  substances processed : ${prepared.length}`);
  console.log(`  new drugs created    : ${stats.created}`);
  console.log(`  existing drugs matched: ${stats.matched}`);
  console.log(`  rows flagged '${SOURCE}': ${stats.flagged}`);
  console.log(`  CIDs backfilled      : ${stats.cidBackfilled}`);
  console.log(`  portal links written : ${stats.linked} (existing rows)`);
  console.log(`  parameters written   : ${stats.params}`);
  if (stats.paramsNotApplicable) {
    console.log(
      `  not applicable       : ${stats.paramsNotApplicable} (skipped — undefined for that substance)`,
    );
  }
  console.log(`  metabolite links     : ${metaboliteLinks}`);
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
