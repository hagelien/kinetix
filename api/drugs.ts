/**
 * Drugs CRUD endpoint.
 *   GET    — List (`?sort=popularity|name`, `?q=`, `?methodId=`, `?limit=`)
 *            or single (`?id=` or `?cid=` or `?slug=`)
 *   POST   — Create a drug (admin)
 *   PATCH  — Update drug top-level fields (`?id=`, admin)
 *   DELETE — Delete a drug and its monograph (`?id=`, admin)
 */
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from 'node:http';
import {
  eq,
  desc,
  asc,
  and,
  or,
  sql,
  inArray,
  getTableColumns,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import {
  json,
  error,
  withErrorHandling,
  noStoreHeaders,
  publicCacheHeaders,
} from './_lib/response.js';
import { getDb, runInPoolTransaction } from './_lib/db.js';
import { getUserFromRequest, requestHasAuthCookie } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import {
  buildSearchKey,
  insertDrug,
  isForeignKeyViolation,
  isUniqueViolation,
} from './_lib/drugs-helpers.js';
import {
  ensureDrugMonograph,
  resolveMonographDrugCids,
} from './_lib/monograph-helpers.js';
import { drugAliasesSchema, drugNamesSchema } from './_lib/schemas.js';
import { normalizeAliases } from '../src/lib/drugNames.js';
import { lockDrugForEntryApplicability } from './_lib/parameterApplicabilityStore.js';
import { activeProposalNestsDrug } from './_lib/param-entry-payload-locks.js';
import { canAccessAnalyticalMethods } from '../src/lib/featureAccess.js';
import { CAP } from '../src/lib/permissions.js';
import {
  callerCan,
  loadPermissionOverrides,
} from './_lib/permissions-store.js';
import {
  drugs,
  drugParameters,
  parameterEntries,
  wikiPages,
  pendingEdits,
} from '../db/schema.js';
import {
  getDrugParameterMap,
  mergeDrugParametersIntoRow,
  upsertDrugParameter,
} from './_lib/drugParameterStore.js';
import { isActiveAgentUser } from './_lib/agent-verifications.js';
import { wikiContentFocusRefusal } from './agent-focus.js';
import { getDrugMetabolism } from './_lib/metabolismStore.js';
import { getDrugReceptorTargets } from './_lib/receptorTargetStore.js';
import { getIonizationConstantsForDrug } from './_lib/ionizationConstantsStore.js';
import {
  getParameterSummariesWithRoutes,
  recomputeSummariesForDrug,
} from './_lib/parameter-entries-store.js';
import { DRUG_PARAMETERS } from '../src/lib/drugParameters.js';
import {
  parametersRequiringAdministration,
  substanceIsAdministered,
  SUBSTANCE_CLASSES,
} from '../src/lib/parameterApplicability.js';
import {
  ParameterNotApplicableError,
  withDrugApplicabilityLock,
} from './_lib/parameterApplicabilityStore.js';

// Reuse the parameter spec's bounds so the API enforces the same
// upper limit (#302 P2: the JSONB column doesn't carry a numeric(10,4)
// cap, and we don't want extreme values reaching converters via a
// direct POST/PATCH).
const molecularWeightSchema =
  DRUG_PARAMETERS.molecularWeight.kind === 'number'
    ? z.number().positive().max(DRUG_PARAMETERS.molecularWeight.bounds.max)
    : z.number().positive();

const createDrugSchema = z.object({
  names: drugNamesSchema,
  nameShort: z.string().max(50).optional(),
  aliases: drugAliasesSchema.optional(),
  pubchemCid: z.number().int().positive().optional(),
  /** Optional initial molecular weight; routed to drug_parameters. */
  molecularWeight: molecularWeightSchema.optional(),
  /**
   * What kind of substance this is. Defaults to 'drug' at the column. Setting
   * it to 'metabolite' or 'endogenous' also declares that the parameters
   * needing a dose of this substance — bioavailability, the dose ranges —
   * are undefined here, which removes them from the maintenance agent's gap
   * queue (src/lib/parameterApplicability.ts). Reserve the non-'drug' classes
   * for substances that are only ever analytes: something that is a metabolite
   * AND a marketed product (morphine, oxazepam) stays 'drug', because for it
   * every one of those parameters is perfectly well defined.
   */
  substanceClass: z.enum(SUBSTANCE_CLASSES).optional(),
});

const patchDrugSchema = createDrugSchema.partial();
// Drug catalog data changes only on admin writes (rare). Cache at the CDN
// layer for 1 hour so Neon is hit at most once per hour per edge node
// rather than every 60 s. The browser always revalidates (max-age=0);
// stale-while-revalidate=86400 keeps pages fast while the CDN refreshes.
const PUBLIC_DRUG_CACHE_HEADERS = publicCacheHeaders({
  sMaxAge: 3600,
  staleWhileRevalidate: 86400,
});

// Drug rows are public-cacheable, but admins write parameter/metabolism/target
// edits straight to the row (bypassing the review queue). With a 1-hour CDN
// cache the editor would keep seeing the stale pre-edit copy and conclude the
// save didn't take. Serve any cookie-bearing (logged-in) request fresh so a
// direct edit is visible immediately; anonymous reads keep the CDN benefit.
function drugCacheHeaders(req: IncomingMessage): OutgoingHttpHeaders {
  return requestHasAuthCookie(req)
    ? noStoreHeaders()
    : PUBLIC_DRUG_CACHE_HEADERS;
}

export function escapeDrugSearchLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export function parseExactPubchemCidQuery(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2147483647) {
    return null;
  }
  return parsed;
}

function parsePositiveIntCsv(raw: string | null): number[] | null {
  if (raw === null) return null;
  const ids: number[] = [];
  for (const part of raw.split(',')) {
    if (!part.trim()) return null;
    const parsed = Number(part.trim());
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 2147483647) {
      return null;
    }
    ids.push(parsed);
  }
  return [...new Set(ids)];
}

export default withErrorHandling(
  async function handler(req, res): Promise<void> {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    );

    switch (req.method) {
      case 'GET':
        return handleGet(req, res, url);
      case 'POST':
        assertSameOrigin(req);
        return handleCreate(req, res);
      case 'PATCH':
        assertSameOrigin(req);
        return handleUpdate(req, res, url);
      case 'DELETE':
        assertSameOrigin(req);
        return handleDelete(req, res, url);
      default:
        error(res, 405, 'Method not allowed');
    }
  },
);

/**
 * Flatten a drug row + its drug_parameters map onto the legacy response
 * shape (drug.halfLife, drug.molecularWeight, etc.) so frontend
 * consumers don't need to know about the storage split. Parameters not
 * present in the map are simply absent from the result, matching the
 * pre-migration behaviour where the dedicated columns were nullable.
 */
function serializeDrugRow<T extends { id: number }>(
  row: T,
  paramMap: Map<string, unknown> | undefined,
): T & Record<string, unknown> {
  return mergeDrugParametersIntoRow(row, paramMap);
}

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const id = url.searchParams.get('id');
  const cid = url.searchParams.get('cid');
  const slug = url.searchParams.get('slug');
  const wikiDrugId = url.searchParams.get('wikiDrugId');
  const view = url.searchParams.get('view') === 'search' ? 'search' : 'full';

  const db = getDb();

  if (wikiDrugId) {
    const n = Number(wikiDrugId);
    if (!Number.isInteger(n) || n <= 0) {
      error(res, 400, 'Invalid wikiDrugId');
      return;
    }

    // wiki_pages.drug_cid is mixed-vintage data: modern rows store drugs.id,
    // while legacy rows can store PubChem CID. Resolve both candidates in one
    // query instead of making clients issue /id and /cid requests.
    const rows = await db
      .select()
      .from(drugs)
      .where(or(eq(drugs.id, n), eq(drugs.pubchemCid, n)))
      .limit(2);
    if (rows.length === 0) {
      error(res, 404, 'Drug not found');
      return;
    }
    // `id` and `pubchem_cid` are both unique, so the OR can only match two
    // rows when one drug's internal id equals a *different* drug's PubChem
    // CID — e.g. 25C-NBOMe (id=281) collides with carbon monoxide
    // (pubchem_cid=281). This is a number collision, not a genuinely
    // ambiguous link: modern drug_cid values — including every monograph
    // ensureDrugMonograph creates — store drugs.id, so prefer the id match
    // and fall back to the PubChem CID interpretation only for legacy rows
    // where no drug carries that internal id. (Previously this 409'd, which
    // blanked the parameter sidebar and discussion on correctly-linked
    // monographs whenever such a collision existed.)
    const row = rows.find((r) => r.id === n) ?? rows[0]!;
    const [
      paramMap,
      metabolism,
      receptorTargets,
      summaryBundle,
      ionizationConstants,
    ] = await Promise.all([
      getDrugParameterMap(db, row.id),
      getDrugMetabolism(db, row.id),
      getDrugReceptorTargets(db, row.id),
      getParameterSummariesWithRoutes(row.id),
      getIonizationConstantsForDrug(db, row.id),
    ]);
    const { summaries: parameterSummaries, routeSummaries: parameterRouteSummaries } =
      summaryBundle;
    json(
      res,
      200,
      {
        drug: {
          ...serializeDrugRow(row, paramMap),
          metabolism,
          receptorTargets,
          parameterSummaries,
          parameterRouteSummaries,
          ionizationConstants,
        },
      },
      { headers: drugCacheHeaders(req) },
    );
    return;
  }

  if (id || cid || slug) {
    const condition = id
      ? eq(drugs.id, Number(id))
      : cid
        ? eq(drugs.pubchemCid, Number(cid))
        : eq(drugs.slug, String(slug));

    const [row] = await db.select().from(drugs).where(condition).limit(1);
    if (!row) {
      error(res, 404, 'Drug not found');
      return;
    }
    const [
      paramMap,
      metabolism,
      receptorTargets,
      summaryBundle,
      ionizationConstants,
    ] = await Promise.all([
      getDrugParameterMap(db, row.id),
      getDrugMetabolism(db, row.id),
      getDrugReceptorTargets(db, row.id),
      getParameterSummariesWithRoutes(row.id),
      getIonizationConstantsForDrug(db, row.id),
    ]);
    const { summaries: parameterSummaries, routeSummaries: parameterRouteSummaries } =
      summaryBundle;
    json(
      res,
      200,
      {
        drug: {
          ...serializeDrugRow(row, paramMap),
          metabolism,
          receptorTargets,
          parameterSummaries,
          parameterRouteSummaries,
          ionizationConstants,
        },
      },
      { headers: drugCacheHeaders(req) },
    );
    return;
  }

  const sortParam = url.searchParams.get('sort') ?? 'popularity';
  const q = url.searchParams.get('q')?.toLowerCase().trim() ?? '';
  const methodIdParam = url.searchParams.get('methodId');
  const idsParam = url.searchParams.get('ids');
  const limit = Math.min(Number(url.searchParams.get('limit')) || 500, 1000);
  const responseOptions = methodIdParam
    ? { headers: noStoreHeaders() }
    : { headers: drugCacheHeaders(req) };

  const conditions: SQL[] = [];
  const ids = parsePositiveIntCsv(idsParam);
  if (idsParam !== null) {
    if (ids === null || ids.length === 0 || ids.length > 100) {
      error(res, 400, 'Invalid ids');
      return;
    }
    conditions.push(inArray(drugs.id, ids));
  }
  if (q) {
    const searchKeyCondition = sql`${drugs.searchKey} LIKE ${`%${escapeDrugSearchLikePattern(q)}%`} ESCAPE '\\'`;
    const pubchemCidQuery = parseExactPubchemCidQuery(q);
    const searchCondition =
      pubchemCidQuery === null
        ? searchKeyCondition
        : or(searchKeyCondition, eq(drugs.pubchemCid, pubchemCidQuery));
    if (searchCondition) conditions.push(searchCondition);
  }

  if (methodIdParam) {
    const auth = await getUserFromRequest(req);
    if (!canAccessAnalyticalMethods(auth, await loadPermissionOverrides())) {
      error(res, 403, 'Analytical methods access required');
      return;
    }

    const methodId = Number(methodIdParam);
    // IN subquery against the (method_id, drug_id) PK index — one Neon
    // round-trip instead of the previous lookup-then-inArray two-step.
    conditions.push(
      sql`${drugs.id} IN (
        SELECT drug_id FROM analytical_method_components
        WHERE method_id = ${methodId}
      )`,
    );
  }

  // Sort by name uses the English name when present, falling back to the
  // first available language so the column orders predictably regardless of
  // which languages are populated.
  const nameSortExpr = sql`COALESCE(
    ${drugs.names} ->> 'en',
    ${drugs.names} ->> 'nb',
    (SELECT value FROM jsonb_each_text(${drugs.names}) LIMIT 1)
  )`;

  // Sort by name: COALESCE across language keys so the column orders
  // predictably regardless of which languages are populated.
  const searchViewOrder =
    sortParam === 'name' ? asc(nameSortExpr) : desc(drugs.popularityScore);

  // When the user typed a query, rank rows whose name/alias *starts* with the
  // query ahead of rows that merely contain it as a substring. The search key
  // is a tab-joined list of lowercase terms, so a term-prefix match is either
  // at the very start of the key (`q%`) or right after a tab boundary
  // (`%\tq%`). This surfaces the parent "Fentanyl" above analogs such as
  // "Acetylfentanyl" or "2-Fluorfentanyl" that would otherwise crowd it out of
  // the result limit. Empty array spreads to nothing when there's no query.
  const searchRelevanceOrder: SQL[] = q
    ? [
        sql`CASE
          WHEN ${drugs.searchKey} LIKE ${`${escapeDrugSearchLikePattern(q)}%`} ESCAPE '\\'
            OR ${drugs.searchKey} LIKE ${`%\t${escapeDrugSearchLikePattern(q)}%`} ESCAPE '\\'
          THEN 0 ELSE 1 END`,
      ]
    : [];

  if (view === 'search') {
    const searchProjection = {
      id: drugs.id,
      slug: drugs.slug,
      names: drugs.names,
      nameShort: drugs.nameShort,
      aliases: drugs.aliases,
      pubchemCid: drugs.pubchemCid,
    };

    // molecularWeight lives in drug_parameters (#302 P2). A LEFT JOIN on the
    // single matching row is cheaper than a correlated subquery that reruns for
    // every drug row before the LIMIT is applied.
    if (sortParam === 'molecularWeight') {
      const rows = await db
        .select(searchProjection)
        .from(drugs)
        .leftJoin(
          drugParameters,
          and(
            eq(drugParameters.drugId, drugs.id),
            eq(drugParameters.parameter, 'molecularWeight'),
          ),
        )
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(
          ...searchRelevanceOrder,
          sql`(${drugParameters.value}::text)::numeric ASC NULLS LAST`,
        )
        .limit(limit);
      json(res, 200, { drugs: rows }, responseOptions);
      return;
    }

    const rows = await db
      .select(searchProjection)
      .from(drugs)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(...searchRelevanceOrder, searchViewOrder)
      .limit(limit);

    json(res, 200, { drugs: rows }, responseOptions);
    return;
  }

  // Full view: single LEFT JOIN query to fetch drugs and all their
  // parameters in one Neon HTTP round trip. jsonb_object_agg collects
  // every drug_parameters row into a {parameter: value} object per drug,
  // which serializeDrugRow then flattens onto the response shape.
  //
  // Sorting by molecularWeight uses MAX over the CASE on the joined rows
  // instead of a per-row correlated subquery — equivalent since each drug
  // has at most one MW row (PK is (drug_id, parameter)).
  const fullViewOrder =
    sortParam === 'name'
      ? asc(nameSortExpr)
      : sortParam === 'molecularWeight'
        ? sql`MAX(CASE WHEN ${drugParameters.parameter} = 'molecularWeight' THEN (${drugParameters.value}::text)::numeric END) ASC NULLS LAST`
        : desc(drugs.popularityScore);

  const drugCols = getTableColumns(drugs);
  const rows = await db
    .select({
      ...drugCols,
      monographSlug: sql<string | null>`MAX(${wikiPages.slug})`,
      _params: sql<Record<string, unknown> | null>`
        jsonb_object_agg(${drugParameters.parameter}, ${drugParameters.value})
        FILTER (WHERE ${drugParameters.parameter} IS NOT NULL)
      `,
    })
    .from(drugs)
    .leftJoin(drugParameters, eq(drugParameters.drugId, drugs.id))
    .leftJoin(
      wikiPages,
      and(
        eq(wikiPages.pageType, 'drug_monograph'),
        sql`(
          ${wikiPages.drugCid} = ${drugs.id}
          OR (
            ${wikiPages.drugCid} = ${drugs.pubchemCid}
            AND NOT EXISTS (
              SELECT 1 FROM drugs d2
              WHERE d2.id = ${drugs.pubchemCid}
                AND d2.id <> ${drugs.id}
            )
          )
        )`,
      ),
    )
    .where(conditions.length ? and(...conditions) : undefined)
    .groupBy(drugs.id)
    .orderBy(fullViewOrder)
    .limit(limit);

  json(
    res,
    200,
    {
      drugs: rows.map(({ _params, ...row }) => {
        const paramMap = _params ? new Map(Object.entries(_params)) : undefined;
        return serializeDrugRow(row, paramMap);
      }),
    },
    responseOptions,
  );
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth || !(await callerCan(auth.role, CAP['drug.create']))) {
    error(res, 403, 'Admin role required');
    return;
  }

  const parsed = await parseAndValidate(req, createDrugSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  try {
    const row = await insertDrug({
      ...parsed.data,
      aliases: parsed.data.aliases
        ? normalizeAliases(parsed.data.aliases)
        : undefined,
      // insertDrug routes molecularWeight into drug_parameters, which
      // requires a user id for `updated_by`.
      createdBy: auth.userId,
    });
    const db = getDb();
    // Every drug owns a monograph from creation — no manual "Create monograph"
    // step. Best-effort: a monograph hiccup must not fail (or roll back) the
    // drug insert, so we log and still return the created drug.
    try {
      await ensureDrugMonograph(db, row, auth.userId);
    } catch (monographErr) {
      console.error('Auto-create monograph failed for new drug:', {
        drugId: row.id,
        message:
          monographErr instanceof Error
            ? monographErr.message
            : String(monographErr),
        cause: (monographErr as { cause?: unknown })?.cause,
      });
    }
    const paramMap = await getDrugParameterMap(db, row.id);
    json(res, 201, { drug: serializeDrugRow(row, paramMap) });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      error(res, 409, 'Drug with this slug or pubchem cid already exists');
      return;
    }
    error(res, 500, 'Failed to create drug');
  }
}

/**
 * Parameters that would become undefined under `nextClass` but still hold a
 * value or source entries today. Empty when the change is safe — including for
 * a change *to* 'drug', which only ever widens what is defined.
 */
export async function conflictingAdministrationData(
  drugId: number,
  nextClass: string,
): Promise<string[]> {
  if (substanceIsAdministered(nextClass)) return [];
  const atRisk = parametersRequiringAdministration();
  const db = getDb();
  const [stored, entried] = await Promise.all([
    db
      .select({ parameter: drugParameters.parameter })
      .from(drugParameters)
      .where(
        and(
          eq(drugParameters.drugId, drugId),
          inArray(drugParameters.parameter, atRisk),
        ),
      ),
    db
      .selectDistinct({ parameter: parameterEntries.parameter })
      .from(parameterEntries)
      .where(
        and(
          eq(parameterEntries.drugId, drugId),
          inArray(parameterEntries.parameter, atRisk),
        ),
      ),
  ]);
  return Array.from(
    new Set([...stored, ...entried].map((r) => r.parameter)),
  ).sort();
}

/**
 * Apply a PATCH's whole column bag to one drug row, under the per-drug
 * applicability lock when the edit changes `substanceClass`.
 *
 * Both properties matter and neither is free:
 *
 * - **Locked** — a reclassification is a check-then-write, so without the lock
 *   a parameter write that already passed its own class check could commit
 *   between the conflict read and the update, landing data the new class
 *   forbids.
 * - **One statement, one transaction** — the class column travels with the
 *   rest of `updates` rather than being written separately first. A later
 *   failure in the same request (a `pubchemCid` unique violation, say) then
 *   rolls the reclassification back too, instead of leaving the caller with an
 *   error and a silently applied class change that starts suppressing gaps.
 *
 * An edit that does not touch the class skips the lock and the transaction
 * entirely — it has no invariant to protect.
 *
 * Exported for the integration tests, which exercise the locked unit directly
 * rather than through an HTTP request mock.
 */
export async function applyDrugRowUpdate(
  id: number,
  updates: Record<string, unknown>,
  nextSubstanceClass: string | undefined,
  /**
   * molecularWeight lives in `drug_parameters`, not on the drug row, so it
   * needs its own write — but it must land in the *same* unit as the row
   * update. Left outside, a PATCH carrying both committed the class/name/CID
   * change first and then threw on the parameter write (the applicability
   * guard rejects a marked pair), returning an error with half the request
   * already applied and a reclassification quietly suppressing gaps.
   */
  parameterWrite?: { molecularWeight: number; userId: number },
): Promise<{ conflicts: string[] } | { row: typeof drugs.$inferSelect | undefined }> {
  const run = async () => {
    if (nextSubstanceClass !== undefined) {
      const found = await conflictingAdministrationData(id, nextSubstanceClass);
      if (found.length) return { conflicts: found };
    }
    const [updated] = await getDb()
      .update(drugs)
      .set(updates)
      .where(eq(drugs.id, id))
      .returning();

    if (parameterWrite && updated) {
      // Changing molecularWeight restales every summarizable parameter whose
      // entries convert molar values, so the recompute belongs in here too —
      // both for atomicity and because its advisory lock is the one this unit
      // already holds (re-entrant within the transaction).
      await upsertDrugParameter(
        getDb(),
        updated.id,
        'molecularWeight',
        parameterWrite.molecularWeight,
        parameterWrite.userId,
      );
      await recomputeSummariesForDrug(updated.id, parameterWrite.userId);
    }

    return { row: updated };
  };

  // The lock covers a class change and a parameter write alike; either alone
  // is enough to need it, and a PATCH doing neither should not pay for a
  // transaction it has no invariant to protect.
  return nextSubstanceClass === undefined && !parameterWrite
    ? run()
    : withDrugApplicabilityLock(id, run);
}

async function handleUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth || !(await callerCan(auth.role, CAP['drug.update']))) {
    error(res, 403, 'Admin role required');
    return;
  }

  const id = Number(url.searchParams.get('id'));
  if (!id) {
    error(res, 400, 'Missing id parameter');
    return;
  }

  const parsed = await parseAndValidate(req, patchDrugSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const data = parsed.data;

  // molecularWeight is not drug metadata: it lands in `drug_parameters` and
  // triggers the same recomputes /api/drug-parameter does, so carrying it
  // needs that endpoint's capability on top of drug.update.
  if (
    data.molecularWeight !== undefined &&
    !(await callerCan(auth.role, CAP['edit.parameter.submit']))
  ) {
    error(
      res,
      403,
      'Updating molecularWeight requires the parameter-edit permission.',
      'parameter_submit_forbidden',
    );
    return;
  }

  // Do the read → derive → update under one merge advisory lock so a
  // concurrent merge cannot commit `mergedAliases`/`searchKey` (or any
  // other row-level state) between our SELECT and UPDATE and see it
  // silently wiped by our derivation. The merge holds
  // `lockDrugForEntryApplicability` on the winner across its whole fold;
  // taking it here serializes with that, and the re-read inside the lock
  // reflects the post-merge state so nameShort/aliases decisions build on
  // the merged row (loser names preserved as aliases, etc.) rather than a
  // pre-merge snapshot. `applyDrugRowUpdate` also takes the lock when it
  // needs to; `pg_advisory_xact_lock` is re-entrant so the second
  // acquire is free.
  type UpdateOutcome =
    | { kind: 'ok'; applied: Awaited<ReturnType<typeof applyDrugRowUpdate>> }
    | { kind: 'gone' }
    | { kind: 'not_applicable'; error: ParameterNotApplicableError };
  let outcome: UpdateOutcome;
  try {
    outcome = await runInPoolTransaction<UpdateOutcome>(async () => {
      await lockDrugForEntryApplicability(id);
      const txDb = getDb();
      const [existing] = await txDb
        .select({
          id: drugs.id,
          names: drugs.names,
          nameShort: drugs.nameShort,
          aliases: drugs.aliases,
        })
        .from(drugs)
        .where(eq(drugs.id, id))
        .limit(1);
      if (!existing) return { kind: 'gone' };

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      let nextNames = existing.names;
      let nextAliases = existing.aliases;

      if (data.names !== undefined) {
        nextNames = data.names;
        updates.names = data.names;
      }
      if (data.nameShort !== undefined) updates.nameShort = data.nameShort;
      if (data.aliases !== undefined) {
        nextAliases = normalizeAliases(data.aliases);
        updates.aliases = nextAliases;
      }
      if (data.pubchemCid !== undefined) updates.pubchemCid = data.pubchemCid;
      if (data.substanceClass !== undefined) {
        updates.substanceClass = data.substanceClass;
      }

      if (
        data.names !== undefined ||
        data.nameShort !== undefined ||
        data.aliases !== undefined
      ) {
        updates.searchKey = buildSearchKey({
          names: nextNames,
          nameShort: data.nameShort ?? existing.nameShort,
          aliases: nextAliases,
        });
      }

      // A reclassification to an analyte class declares bioavailability and
      // the dose ranges undefined for this substance. If any of them
      // currently holds a value or has source entries, that would leave the
      // API serving numbers the applicability rule says cannot exist while
      // the gap queue quietly suppresses them. Refuse and name what is in
      // the way; clearing curated data as a side effect of a classification
      // change is not a safe default. Same contract as marking a single
      // pair, one level up.
      //
      // molecularWeight travels with the row update rather than following
      // it: it lands in `drug_parameters`, and `upsertDrugParameter`
      // refuses a pair that a marker or the (possibly just-changed)
      // substance class forbids. Run separately, that refusal arrived after
      // the row update had committed — a 500 with the reclassification
      // already applied and suppressing gaps.
      try {
        const applied = await applyDrugRowUpdate(
          id,
          updates,
          data.substanceClass,
          data.molecularWeight !== undefined
            ? { molecularWeight: data.molecularWeight, userId: auth.userId }
            : undefined,
        );
        return { kind: 'ok', applied };
      } catch (err: unknown) {
        if (err instanceof ParameterNotApplicableError) {
          return { kind: 'not_applicable', error: err };
        }
        throw err;
      }
    });
  } catch (err) {
    throw err;
  }
  if (outcome.kind === 'gone') {
    error(res, 404, 'Drug not found');
    return;
  }
  if (outcome.kind === 'not_applicable') {
    error(res, 409, outcome.error.message, outcome.error.code);
    return;
  }
  const applied = outcome.applied;

  if ('conflicts' in applied) {
    json(res, 409, {
      error:
        'This substance still has values or source entries for parameters that a non-administered class declares undefined. Clear them before reclassifying.',
      code: 'substance_class_conflict',
      parameters: applied.conflicts,
    });
    return;
  }

  const row = applied.row;
  if (!row) {
    error(res, 500, 'Failed to update drug');
    return;
  }

  const paramMap = await getDrugParameterMap(getDb(), row.id);
  json(res, 200, { drug: serializeDrugRow(row, paramMap) });
}

// Pending-edit kinds whose targetId is always a drugs.id, so they can be
// cleaned up alongside the drug. Other editTypes key off a wiki_pages.id and
// must not be touched here.
const DRUG_SCOPED_EDIT_TYPES = ['parameter', 'metabolism', 'receptor_targets'];

/** Thrown inside the delete transaction to roll it back and answer 409. */
class NestedProposalReferenceError extends Error {
  constructor(readonly count: number) {
    super('drug named by open proposals');
  }
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth || !(await callerCan(auth.role, CAP['drug.delete']))) {
    error(res, 403, 'Admin role required');
    return;
  }

  const id = Number(url.searchParams.get('id'));
  if (!id || !Number.isInteger(id) || id <= 0) {
    error(res, 400, 'Missing id parameter');
    return;
  }

  const db = getDb();
  const [existing] = await db
    .select({ id: drugs.id, pubchemCid: drugs.pubchemCid })
    .from(drugs)
    .where(eq(drugs.id, id))
    .limit(1);

  if (!existing) {
    error(res, 404, 'Drug not found');
    return;
  }

  // Admitted atlas rows block the delete, and say so rather than failing as a
  // 500 on the foreign key.
  //
  // `pattern_reference_*` name drugs with RESTRICT keys deliberately: those
  // rows are a transcription of a published paper that a named admin admitted
  // (invariant 31), and deleting a catalog entry is not a decision to withdraw
  // an admission. The teardown below cascades a great deal on purpose; this is
  // the one thing it must not carry off silently, so the operator is told what
  // is holding the drug and what to do about it.
  const [atlasUses] = await db
    .select({
      count: sql<number>`(
        (SELECT count(*) FROM pattern_reference_exposures WHERE drug_id = ${existing.id})
        + (SELECT count(*) FROM pattern_reference_observations
             WHERE drug_id = ${existing.id} OR reported_as_drug_id = ${existing.id})
        + (SELECT count(*) FROM pattern_reference_aggregates
             WHERE drug_id = ${existing.id} OR reported_as_drug_id = ${existing.id})
      )::int`,
    })
    .from(drugs)
    .where(eq(drugs.id, existing.id));
  if ((atlasUses?.count ?? 0) > 0) {
    error(
      res,
      409,
      `This substance is named by ${atlasUses!.count} admitted reference row(s) in the ` +
        `pattern atlas — published data a named admin took responsibility for. Withdraw the ` +
        `cohort admission that carries them first; deleting the substance would take a ` +
        `transcription with it.`,
    );
    return;
  }

  // Another drug's source entries naming this one as the substance dosed or
  // the interacting drug (Cmax release B, #1340) block the delete the same
  // way. Both keys are ON DELETE RESTRICT on purpose: a metabolite's Cmax
  // recorded after dosing THIS drug is evidence about the metabolite that
  // must not silently lose what produced it. The drug's OWN entries are not
  // counted — the teardown removes them before the drug row, self-references
  // included (#1339), so they never reach the constraint.
  const [evidenceUses] = await db
    .select({
      count: sql<number>`(
        SELECT count(*) FROM parameter_entries
        WHERE drug_id <> ${existing.id}
          AND (administered_drug_id = ${existing.id}
            OR interacting_drug_id = ${existing.id})
      )::int`,
    })
    .from(drugs)
    .where(eq(drugs.id, existing.id));
  if ((evidenceUses?.count ?? 0) > 0) {
    error(
      res,
      409,
      `This substance is named as the drug administered or the interacting drug by ` +
        `${evidenceUses!.count} source entr${evidenceUses!.count === 1 ? 'y' : 'ies'} on other ` +
        `substances — for example a metabolite's Cmax measured after dosing it. Deleting it ` +
        `would detach that evidence from what produced it. Correct or remove those entries ` +
        `first, or merge this substance into its duplicate instead of deleting it.`,
    );
    return;
  }

  // ─── Admin agent-focus gate on agent-authored wiki content ──────────────
  // The teardown below deletes this drug's monograph, so this endpoint is
  // another door into wiki content — and `drug.delete` carries
  // `floorTier: 'editor'` like the wiki capabilities, so the same delegation
  // that lets an editor-tier agent identity write pages lets it remove a
  // monograph from here. Gating `DELETE /api/wiki/pages` while leaving this
  // open would close the front door and label the side one.
  //
  // Judged on the monograph the delete would remove, page by page, exactly as
  // the wiki route judges the page it is asked to delete. A drug with no
  // monograph touches no wiki content, so the focus — which governs what
  // agents may author, not the catalog — has nothing to say about it.
  if (await isActiveAgentUser(auth.userId)) {
    const monographCandidates = await resolveMonographDrugCids(db, existing);
    const monographPages = monographCandidates.length
      ? await db
          .select({ id: wikiPages.id })
          .from(wikiPages)
          .where(
            and(
              eq(wikiPages.pageType, 'drug_monograph'),
              inArray(wikiPages.drugCid, monographCandidates),
            ),
          )
      : [];
    for (const page of monographPages) {
      const refusal = await wikiContentFocusRefusal(page.id);
      if (refusal) {
        error(res, 403, refusal, 'agent_focus_out_of_scope');
        return;
      }
    }
  }

  // Run the whole teardown in one transaction so we never leave a half-deleted
  // drug (e.g. row gone but monograph orphaned). Structured drug data
  // (drug_parameters, metabolism, receptor targets, method components,
  // discussions, revisions, …) is removed automatically by ON DELETE CASCADE
  // on their drug_id foreign keys. Two things are NOT FK-bound to drugs and
  // are cleaned up explicitly:
  //   - the drug monograph wiki page (wiki_pages.drug_cid is a plain integer,
  //     mixed-vintage: modern rows store drugs.id, legacy rows a PubChem CID)
  //   - pending_edits whose polymorphic target_id points at this drug
  try {
    await runInPoolTransaction(async () => {
      // Same advisory lock the merge script and the PATCH handler above take.
      // Without it, a concurrent writer that also holds the lock (a monograph
      // create/relink, the merge) can read this drug as existing between its
      // own lock acquisition and this transaction's DELETE, then commit a row
      // pointing at a substance this teardown is about to remove — exactly
      // the exposure #1076 named ("a plain admin delete has the same
      // exposure" as merging). `pg_advisory_xact_lock` is re-entrant, so this
      // is free if some caller already holds it.
      await lockDrugForEntryApplicability(id);
      const tx = getDb();

      // Open proposals about ANOTHER drug that name this one in their dose
      // context (administered or interacting drug; Cmax release B). JSON
      // carries no foreign key, so the delete must check them itself, and
      // must do it here, under this drug's lock: every writer of such a
      // payload holds the same lock while it re-reads the drugs it names
      // (`withParamEntryPayloadLocks`), so a proposal either committed before
      // this read and is counted, or its writer blocks and then finds this
      // drug gone. The drug's OWN proposals are excluded — the teardown below
      // removes them. Refused rather than deleted: they are somebody's queued
      // work about a different substance, the same reasoning as the RESTRICT
      // key on stored entries.
      const nestedRows = await tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM pending_edits pe
        WHERE ${activeProposalNestsDrug(existing.id)}
          AND NOT ((pe.proposed_value ->> 'op') = 'create' AND pe.target_id = ${existing.id})
          AND NOT ((pe.proposed_value ->> 'op') IN ('update', 'delete')
            AND pe.target_id IN (SELECT id FROM parameter_entries WHERE drug_id = ${existing.id}))`);
      const nested = Number(
        (nestedRows.rows as Array<{ n: number }>)[0]?.n ?? 0,
      );
      if (nested > 0) throw new NestedProposalReferenceError(nested);

      // Only delete monographs that actually belong to this drug. drug_cid is
      // mixed-vintage (modern = drugs.id, legacy = PubChem CID), but if our
      // PubChem CID equals a *different* drug's internal id, a page keyed by
      // that number is that drug's monograph — deleting it here would be silent
      // data loss (e.g. deleting ethanol id=37/cid=702 must not delete timolol's
      // monograph, drug_cid=702). resolveMonographDrugCids drops such a CID.
      const monographCandidates = await resolveMonographDrugCids(tx, existing);

      // Find the monograph page IDs before deletion so we can clean up
      // wiki-scoped pending edits (wiki_page, wiki_section, wiki_fact) that
      // target the page by its numeric id rather than by drug id.
      const monographPageIds = (
        await tx
          .select({ id: wikiPages.id })
          .from(wikiPages)
          .where(
            and(
              eq(wikiPages.pageType, 'drug_monograph'),
              inArray(wikiPages.drugCid, monographCandidates),
            ),
          )
      ).map((r) => r.id);

      if (monographPageIds.length > 0) {
        const WIKI_SCOPED_EDIT_TYPES = [
          'wiki_page',
          'wiki_section',
          'wiki_fact',
        ];
        await tx
          .delete(pendingEdits)
          .where(
            and(
              inArray(pendingEdits.targetId, monographPageIds),
              inArray(pendingEdits.editType, WIKI_SCOPED_EDIT_TYPES),
            ),
          );
      }

      await tx
        .delete(wikiPages)
        .where(
          and(
            eq(wikiPages.pageType, 'drug_monograph'),
            inArray(wikiPages.drugCid, monographCandidates),
          ),
        );

      await tx
        .delete(pendingEdits)
        .where(
          and(
            eq(pendingEdits.targetId, existing.id),
            inArray(pendingEdits.editType, DRUG_SCOPED_EDIT_TYPES),
          ),
        );

      // param_entry pending edits are polymorphic and NOT covered by
      // DRUG_SCOPED_EDIT_TYPES: a CREATE proposal stores the drug id in
      // target_id, while UPDATE/DELETE proposals store a parameter_entries.id.
      // The entry rows themselves are deleted explicitly below (#1339), but
      // pending_edits.target_id has no FK, so remove the proposals here.
      // The two id spaces (drug ids vs entry ids) can collide, so the predicates
      // are keyed by proposedValue.op — never by a combined target_id IN (…) set,
      // which would let drug 5's teardown delete an unrelated entry-5 update.
      await tx
        .delete(pendingEdits)
        .where(
          and(
            eq(pendingEdits.editType, 'param_entry'),
            eq(pendingEdits.targetId, existing.id),
            sql`${pendingEdits.proposedValue} ->> 'op' = 'create'`,
          ),
        );
      const entryIds = (
        await tx
          .select({ id: parameterEntries.id })
          .from(parameterEntries)
          .where(eq(parameterEntries.drugId, existing.id))
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

      // Explicit, not left to the drug_id cascade (#1339): the Cmax
      // dose-context release adds a self-referential `administered_drug_id`
      // FK on this table with ON DELETE RESTRICT (a self-administered
      // observation stores its own drug id), so once that release is
      // deployed, a drug's own evidence would block its own deletion unless
      // its entries are already gone by the time the drug row goes. Deleting
      // them here, ahead of that release, means the constraint never meets a
      // row it would refuse.
      await tx
        .delete(parameterEntries)
        .where(eq(parameterEntries.drugId, existing.id));

      await tx.delete(drugs).where(eq(drugs.id, existing.id));
    });
  } catch (err) {
    console.error('Failed to delete drug:', {
      drugId: id,
      message: err instanceof Error ? err.message : String(err),
      cause: (err as { cause?: unknown })?.cause,
    });
    if (err instanceof NestedProposalReferenceError) {
      error(
        res,
        409,
        `${err.count} open proposal${err.count === 1 ? '' : 's'} about other substances ` +
          `name${err.count === 1 ? 's' : ''} this one as the drug administered or the ` +
          `interacting drug. Settle ${err.count === 1 ? 'it' : 'them'} from the review queue ` +
          `first, or merge this substance into its duplicate instead of deleting it.`,
        'drug_named_by_open_proposals',
      );
      return;
    }
    // The preflight above answers this in the ordinary case; a row admitted
    // between that read and this delete lands here instead, and a restrictive
    // key refusing to drop admitted data is a conflict rather than a fault.
    if (isForeignKeyViolation(err)) {
      error(
        res,
        409,
        'This substance is referenced by rows that must not be deleted with it — an admitted ' +
          'reference cohort, or another substance\'s source entry naming it as the drug ' +
          'administered or the interacting drug. Remove that reference first, then delete.',
      );
      return;
    }
    error(res, 500, 'Failed to delete drug');
    return;
  }

  json(res, 200, { ok: true, id: existing.id });
}
