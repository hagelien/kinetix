/**
 * Postmortem concentration distributions.
 *
 *   GET ?drugIds=1,2,3  — every stored distribution for those substances,
 *                         together with the cohorts they came from.
 *   GET ?cids=3016,2997 — the same, addressed by PubChem CID, for callers
 *                         holding catalog components rather than drug rows.
 *
 * Read access is gated to admins + members of the `rettstoks` group
 * (`canAccessPmConcentrations`). There is no write path here on purpose: a
 * cohort is transcribed as a whole from its source table and seeded by
 * `npm run seed:pm-concentrations`, so there is nothing an HTTP caller could
 * usefully edit one field of.
 *
 * The numbers are served in the SOURCE's unit and matrix, exactly as stored.
 * Converting server-side would mean picking a display unit for a reader whose
 * preference lives in the client, and a matrix for a chart whose axis the
 * server cannot see — `src/lib/pmConcentrations.ts` does both, in one place,
 * for the chart and the table alike.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq, inArray } from 'drizzle-orm';
import {
  json,
  error,
  withErrorHandling,
  noStoreHeaders,
} from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import {
  drugs,
  pmConcentrationDistributions,
  pmConcentrationSources,
} from '../db/schema.js';
import { canAccessPmConcentrations } from '../src/lib/featureAccess.js';
import { loadPermissionOverrides } from './_lib/permissions-store.js';
import {
  PM_STATISTIC_IDS,
  type PmConcentrationSourceInfo,
  type PmDistribution,
  type PmStatisticId,
} from '../src/lib/pmConcentrations.js';

/** Unpublished forensic material: never cached by a shared proxy. */
const PM_HEADERS = noStoreHeaders();

/**
 * Bound on one request's id list. Generous next to any real chart (the
 * modeling workspace tops out well below this) but finite, so a hand-built URL
 * cannot turn one GET into a full-table scan.
 */
const MAX_IDS = 200;

function parseIdList(raw: string | null): number[] | null {
  if (!raw) return null;
  const ids: number[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const value = Number(trimmed);
    if (!Number.isInteger(value) || value <= 0) return null;
    ids.push(value);
  }
  return ids.length > 0 ? Array.from(new Set(ids)) : null;
}

/** `numeric` columns arrive from the driver as strings. */
function num(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Keep only ids the statistic registry knows.
 *
 * `undrawable` is stored as free-form JSON, so a statistic renamed or dropped
 * in a later release would otherwise arrive at the client as a string that
 * matches nothing and silently stops suppressing the line it was written to
 * suppress.
 */
function parseUndrawable(value: unknown): PmStatisticId[] {
  if (!Array.isArray(value)) return [];
  const known = new Set<string>(PM_STATISTIC_IDS);
  return value.filter(
    (entry): entry is PmStatisticId =>
      typeof entry === 'string' && known.has(entry),
  );
}

/**
 * Keep only string-valued entries. Free-form JSON reaching a `toLocaleString`
 * call site as a non-string would throw in the reader's browser, on a page
 * that is otherwise fine.
 */
function parsePrinted(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, text] of Object.entries(value as Record<string, unknown>)) {
    if (typeof text === 'string' && text.length > 0) out[key] = text;
  }
  return out;
}

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'GET') {
    error(res, 405, 'Method not allowed');
    return;
  }

  const auth = await getUserFromRequest(req);
  if (!canAccessPmConcentrations(auth, await loadPermissionOverrides())) {
    // Answers like `GET /api/methods` does: an empty, flagged payload rather
    // than a 403. The overlay is one section of a page a reader is otherwise
    // entitled to see, and a failed request there would surface as an error
    // toast on a page that is working exactly as configured.
    json(
      res,
      200,
      { sources: [], distributions: [], gated: true },
      { headers: PM_HEADERS },
    );
    return;
  }

  const url = new URL(req.url ?? '', 'http://localhost');
  const drugIds = parseIdList(url.searchParams.get('drugIds'));
  const cids = parseIdList(url.searchParams.get('cids'));
  if (!drugIds && !cids) {
    error(res, 400, 'drugIds or cids is required', 'missing_ids');
    return;
  }
  if ((drugIds?.length ?? 0) + (cids?.length ?? 0) > MAX_IDS) {
    error(res, 400, `At most ${MAX_IDS} ids per request`, 'too_many_ids');
    return;
  }

  const db = getDb();
  const ids = new Set<number>(drugIds ?? []);
  if (cids) {
    const rows = await db
      .select({ id: drugs.id })
      .from(drugs)
      .where(inArray(drugs.pubchemCid, cids));
    for (const row of rows) ids.add(row.id);
  }

  if (ids.size === 0) {
    json(res, 200, { sources: [], distributions: [] }, { headers: PM_HEADERS });
    return;
  }

  // One statement, so the numbers and the metadata that qualifies them come
  // from a single snapshot.
  //
  // Reading them separately looks harmless and is not: `source.unit` is what
  // the client converts BY, and the heading and caveats are what say the
  // percentiles are not thresholds. A re-seed committing between two reads
  // could pair pre-update numbers with a post-update unit, and the reader
  // would be shown a misconverted forensic value with no sign anything was
  // wrong. Joining costs a repeated source row per distribution — a handful,
  // deduplicated below — and removes the window entirely.
  const rows = await db
    .select({
      sourceKey: pmConcentrationSources.key,
      sourceCitation: pmConcentrationSources.citation,
      sourceShortLabel: pmConcentrationSources.shortLabel,
      sourceHeading: pmConcentrationSources.heading,
      sourceMatrix: pmConcentrationSources.matrix,
      sourceUnit: pmConcentrationSources.unit,
      sourceDescription: pmConcentrationSources.description,
      sourceCaveats: pmConcentrationSources.caveats,
      drugId: pmConcentrationDistributions.drugId,
      pubchemCid: drugs.pubchemCid,
      analyte: pmConcentrationDistributions.analyte,
      n: pmConcentrationDistributions.n,
      loq: pmConcentrationDistributions.loq,
      mean: pmConcentrationDistributions.mean,
      median: pmConcentrationDistributions.median,
      p90: pmConcentrationDistributions.p90,
      p95: pmConcentrationDistributions.p95,
      p975: pmConcentrationDistributions.p975,
      tcPlasma: pmConcentrationDistributions.tcPlasma,
      medianOverTc: pmConcentrationDistributions.medianOverTc,
      anomaly: pmConcentrationDistributions.anomaly,
      undrawable: pmConcentrationDistributions.undrawable,
      reviewNote: pmConcentrationDistributions.reviewNote,
      printed: pmConcentrationDistributions.printed,
    })
    .from(pmConcentrationDistributions)
    .innerJoin(
      pmConcentrationSources,
      eq(pmConcentrationSources.id, pmConcentrationDistributions.sourceId),
    )
    .innerJoin(drugs, eq(drugs.id, pmConcentrationDistributions.drugId))
    .where(inArray(pmConcentrationDistributions.drugId, Array.from(ids)));

  const distributions: PmDistribution[] = rows.map((row) => ({
    sourceKey: row.sourceKey,
    drugId: row.drugId,
    pubchemCid: row.pubchemCid,
    analyte: row.analyte,
    n: row.n,
    loq: num(row.loq),
    mean: num(row.mean),
    median: num(row.median),
    p90: num(row.p90),
    p95: num(row.p95),
    p975: num(row.p975),
    tcPlasma: num(row.tcPlasma),
    medianOverTc: num(row.medianOverTc),
    anomaly: row.anomaly,
    undrawable: parseUndrawable(row.undrawable),
    reviewNote: row.reviewNote,
    printed: parsePrinted(row.printed),
  }));

  // Only the cohorts actually represented in this answer, deduplicated out of
  // the joined rows. A client that gets a distribution must be able to render
  // its citation and caveats without a second request — those are not optional
  // decoration here, they are what stops a percentile being read as a
  // threshold.
  const sourceByKey = new Map<string, PmConcentrationSourceInfo>();
  for (const row of rows) {
    if (sourceByKey.has(row.sourceKey)) continue;
    sourceByKey.set(row.sourceKey, {
      key: row.sourceKey,
      citation: row.sourceCitation,
      shortLabel: row.sourceShortLabel,
      heading: row.sourceHeading,
      matrix: row.sourceMatrix,
      unit: row.sourceUnit,
      description: row.sourceDescription,
      caveats: row.sourceCaveats ?? [],
    });
  }

  json(
    res,
    200,
    {
      sources: Array.from(sourceByKey.values()),
      distributions,
    },
    { headers: PM_HEADERS },
  );
});
