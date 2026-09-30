/**
 * Analytical methods endpoint (laboratory analysis panels, keyed by method code).
 *   GET            — List all methods (id, code, name, matrices, type, …).
 *   GET   ?id=     — One method with its component drugs + reporting figures.
 *   GET   ?drugId= — The methods containing one drug, each with that drug's
 *                    reporting figures (Påvisn./MKK/Terskel — see
 *                    `analyticalMethodComponents`; they are not an LOD/LOQ
 *                    pair). Used to surface the method-derived reporting limit
 *                    in the monograph sidebar.
 *   POST           — Create a method (editor+).
 *   PATCH ?id=     — Update a method and (optionally) its component set (editor+).
 *   DELETE ?id=    — Delete a method. Its components (drug rows) are NOT
 *                    deleted — only the membership join rows go away.
 *
 * Read access is gated to admins + members of the `rettstoks` group
 * (`canAccessAnalyticalMethods`). Writes require the `editor` ("redaktør")
 * role or higher.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  json,
  error,
  withErrorHandling,
  noStoreHeaders,
} from './_lib/response.js';
import { getDb, runInPoolTransaction } from './_lib/db.js';
import { getUserFromRequest, type AuthContext } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import {
  analyticalMethods,
  analyticalMethodComponents,
  drugParameters,
  drugs,
} from '../db/schema.js';
import { canAccessAnalyticalMethods } from '../src/lib/featureAccess.js';
import {
  METHOD_MATRIX_VALUES,
  METHOD_TYPE_VALUES,
} from '../src/lib/methodMatrices.js';
import { CAP } from '../src/lib/permissions.js';
import {
  callerCan,
  loadPermissionOverrides,
} from './_lib/permissions-store.js';

// Shared with the React editor (`src/lib/methodMeta.ts`) so the toggles the UI
// offers and the values this route accepts can never drift apart.
const MATRICES = METHOD_MATRIX_VALUES;
const METHOD_TYPES = METHOD_TYPE_VALUES;

const componentInputSchema = z.object({
  drugId: z.number().int().positive(),
  lor: z.number().nonnegative().nullable().optional(),
  mkk: z.number().nonnegative().nullable().optional(),
  lod: z.number().nonnegative().nullable().optional(),
  unit: z.string().max(20).nullable().optional(),
  measurementUncertainty: z.number().nonnegative().nullable().optional(),
});

const methodSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(300),
  description: z.string().max(5000).nullable().optional(),
  matrices: z.array(z.enum(MATRICES)).max(20).optional(),
  volumeMl: z.number().positive().nullable().optional(),
  methodType: z.enum(METHOD_TYPES).nullable().optional(),
  components: z.array(componentInputSchema).max(2000).optional(),
});

const METHOD_ACCESS_HEADERS = noStoreHeaders();

/** Writes require the `methods.write` capability (editor by default). */
async function canEditMethods(auth: AuthContext | null): Promise<boolean> {
  return callerCan(auth?.role, CAP['methods.write']);
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

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!canAccessAnalyticalMethods(auth, await loadPermissionOverrides())) {
    json(
      res,
      200,
      { methods: [], gated: true },
      { headers: METHOD_ACCESS_HEADERS },
    );
    return;
  }
  const idParam = url.searchParams.get('id');
  if (idParam) {
    return handleDetail(res, Number(idParam));
  }
  const drugIdParam = url.searchParams.get('drugId');
  if (drugIdParam) {
    return handleForDrug(res, Number(drugIdParam));
  }
  return handleList(res);
}

/**
 * The methods that include a given drug, each carrying that drug's per-method
 * reporting figures. Powers the "Fra metoder" derived rows in the monograph
 * sidebar's "Analyse og deteksjon" section, which renders `lor` (Påvisn.).
 * `mkk` and `lod` are returned too, but only the method detail page renders
 * them. None of the three is an LOD, LOQ or LLOQ by definition — see
 * `analyticalMethodComponents` in db/schema.ts.
 */
async function handleForDrug(res: ServerResponse, drugId: number): Promise<void> {
  if (!Number.isInteger(drugId) || drugId <= 0) {
    error(res, 400, 'Invalid drugId parameter');
    return;
  }
  const db = getDb();
  const methods = await db
    .select({
      id: analyticalMethods.id,
      code: analyticalMethods.code,
      name: analyticalMethods.name,
      methodType: analyticalMethods.methodType,
      matrices: analyticalMethods.matrices,
      lor: analyticalMethodComponents.lor,
      mkk: analyticalMethodComponents.mkk,
      lod: analyticalMethodComponents.lod,
      unit: analyticalMethodComponents.unit,
      measurementUncertainty:
        analyticalMethodComponents.measurementUncertainty,
    })
    .from(analyticalMethodComponents)
    .innerJoin(
      analyticalMethods,
      eq(analyticalMethodComponents.methodId, analyticalMethods.id),
    )
    .where(eq(analyticalMethodComponents.drugId, drugId))
    .orderBy(analyticalMethods.code);

  json(res, 200, { methods }, { headers: METHOD_ACCESS_HEADERS });
}

async function handleList(res: ServerResponse): Promise<void> {
  const db = getDb();
  const methods = await db
    .select({
      id: analyticalMethods.id,
      code: analyticalMethods.code,
      name: analyticalMethods.name,
      description: analyticalMethods.description,
      matrices: analyticalMethods.matrices,
      volumeMl: analyticalMethods.volumeMl,
      methodType: analyticalMethods.methodType,
      componentCount: sql<number>`count(${analyticalMethodComponents.drugId})::int`,
      drugIds: sql<number[]>`
        COALESCE(
          array_agg(${analyticalMethodComponents.drugId} ORDER BY ${analyticalMethodComponents.sortOrder}, ${analyticalMethodComponents.drugId})
            FILTER (WHERE ${analyticalMethodComponents.drugId} IS NOT NULL),
          ARRAY[]::integer[]
        )
      `,
      pubchemCids: sql<number[]>`
        COALESCE(
          array_agg(${drugs.pubchemCid} ORDER BY ${drugs.pubchemCid})
            FILTER (WHERE ${drugs.pubchemCid} IS NOT NULL),
          ARRAY[]::integer[]
        )
      `,
    })
    .from(analyticalMethods)
    .leftJoin(
      analyticalMethodComponents,
      eq(analyticalMethodComponents.methodId, analyticalMethods.id),
    )
    .leftJoin(drugs, eq(analyticalMethodComponents.drugId, drugs.id))
    // Grouping by the primary key lets us select the other method columns
    // (incl. the jsonb matrices) without enumerating them in GROUP BY.
    .groupBy(analyticalMethods.id)
    .orderBy(analyticalMethods.code);

  json(res, 200, { methods }, { headers: METHOD_ACCESS_HEADERS });
}

async function handleDetail(res: ServerResponse, id: number): Promise<void> {
  if (!Number.isInteger(id) || id <= 0) {
    error(res, 400, 'Invalid id parameter');
    return;
  }
  const db = getDb();
  const [method] = await db
    .select()
    .from(analyticalMethods)
    .where(eq(analyticalMethods.id, id))
    .limit(1);
  if (!method) {
    error(res, 404, 'Method not found');
    return;
  }

  const components = await db
    .select({
      drugId: analyticalMethodComponents.drugId,
      lor: analyticalMethodComponents.lor,
      mkk: analyticalMethodComponents.mkk,
      lod: analyticalMethodComponents.lod,
      unit: analyticalMethodComponents.unit,
      measurementUncertainty:
        analyticalMethodComponents.measurementUncertainty,
      sortOrder: analyticalMethodComponents.sortOrder,
      slug: drugs.slug,
      names: drugs.names,
      nameShort: drugs.nameShort,
      pubchemCid: drugs.pubchemCid,
      // molecularWeight lives in drug_parameters (#302 P2). The LEFT JOIN on the
      // single matching row lets the client offer molar↔mass conversion
      // tooltips on the reporting figures below. Cast through double precision
      // (not numeric) so neon-http returns a JS number rather than a string.
      molecularWeight: sql<
        number | null
      >`(${drugParameters.value}::text)::double precision`,
    })
    .from(analyticalMethodComponents)
    .innerJoin(drugs, eq(analyticalMethodComponents.drugId, drugs.id))
    .leftJoin(
      drugParameters,
      and(
        eq(drugParameters.drugId, drugs.id),
        eq(drugParameters.parameter, 'molecularWeight'),
      ),
    )
    .where(eq(analyticalMethodComponents.methodId, id))
    .orderBy(analyticalMethodComponents.sortOrder, drugs.id);

  json(
    res,
    200,
    { method: { ...method, components } },
    { headers: METHOD_ACCESS_HEADERS },
  );
}

async function replaceComponents(
  methodId: number,
  components: z.infer<typeof componentInputSchema>[],
): Promise<void> {
  // De-dupe on drugId (the table PK is (method_id, drug_id)); keep first.
  const seen = new Set<number>();
  const rows = components
    .filter((c) => {
      if (seen.has(c.drugId)) return false;
      seen.add(c.drugId);
      return true;
    })
    .map((c, index) => ({
      methodId,
      drugId: c.drugId,
      lor: c.lor ?? null,
      mkk: c.mkk ?? null,
      lod: c.lod ?? null,
      unit: c.unit ?? null,
      measurementUncertainty: c.measurementUncertainty ?? null,
      sortOrder: index,
    }));

  // Removed components only, rather than deleting the set and rebuilding it.
  //
  // A reference observation names the method *and* the analyte through a
  // composite key into this table (migration 0106), and that key clears the
  // observation's method when its component row goes. Delete-then-reinsert
  // therefore stripped every atlas observation of its method on an ordinary
  // edit — including for components the very next statement put back, since
  // the row that returns is a different row as far as the key is concerned.
  const keep = rows.map((row) => row.drugId);

  // The delete and the (re)insert run inside one transaction so a failure
  // partway through — e.g. the insert rejecting a bad drugId — rolls the
  // delete back too, instead of leaving the method with the delete
  // committed and zero components. Two separate auto-commit statements
  // would apply the delete unconditionally and only conditionally apply
  // the insert, which is exactly the partial-write this closes.
  await runInPoolTransaction(async () => {
    const db = getDb();
    await db
      .delete(analyticalMethodComponents)
      .where(
        keep.length > 0
          ? and(
              eq(analyticalMethodComponents.methodId, methodId),
              notInArray(analyticalMethodComponents.drugId, keep),
            )
          : eq(analyticalMethodComponents.methodId, methodId),
      );
    if (rows.length === 0) return;
    await db
      .insert(analyticalMethodComponents)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          analyticalMethodComponents.methodId,
          analyticalMethodComponents.drugId,
        ],
        set: {
          lor: sql`excluded.lor`,
          mkk: sql`excluded.mkk`,
          lod: sql`excluded.lod`,
          unit: sql`excluded.unit`,
          measurementUncertainty: sql`excluded.measurement_uncertainty`,
          sortOrder: sql`excluded.sort_order`,
        },
      });
  });
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!(await canEditMethods(auth))) {
    error(res, 403, 'Editor role required', 'methods.forbidden');
    return;
  }

  const parsed = await parseAndValidate(req, methodSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  const { components, ...methodValues } = parsed.data;

  const db = getDb();
  try {
    const [row] = await db
      .insert(analyticalMethods)
      .values({
        code: methodValues.code,
        name: methodValues.name,
        description: methodValues.description ?? null,
        matrices: methodValues.matrices ?? [],
        volumeMl: methodValues.volumeMl ?? null,
        methodType: methodValues.methodType ?? null,
      })
      .returning();
    if (row && components && components.length > 0) {
      await replaceComponents(row.id, components);
    }
    json(res, 201, { method: row });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('unique') || message.includes('duplicate')) {
      error(res, 409, 'Method with this code already exists', 'methods.duplicate');
      return;
    }
    error(res, 500, 'Failed to create method');
  }
}

async function handleUpdate(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!(await canEditMethods(auth))) {
    error(res, 403, 'Editor role required', 'methods.forbidden');
    return;
  }
  const id = Number(url.searchParams.get('id'));
  if (!id) {
    error(res, 400, 'Missing id parameter');
    return;
  }
  const parsed = await parseAndValidate(req, methodSchema.partial());
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  const { components, ...methodValues } = parsed.data;

  const db = getDb();
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (methodValues.code !== undefined) update.code = methodValues.code;
  if (methodValues.name !== undefined) update.name = methodValues.name;
  if (methodValues.description !== undefined)
    update.description = methodValues.description;
  if (methodValues.matrices !== undefined)
    update.matrices = methodValues.matrices;
  if (methodValues.volumeMl !== undefined)
    update.volumeMl = methodValues.volumeMl;
  if (methodValues.methodType !== undefined)
    update.methodType = methodValues.methodType;

  let row;
  try {
    [row] = await db
      .update(analyticalMethods)
      .set(update)
      .where(eq(analyticalMethods.id, id))
      .returning();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('unique') || message.includes('duplicate')) {
      error(res, 409, 'Method with this code already exists', 'methods.duplicate');
      return;
    }
    throw err;
  }

  if (!row) {
    error(res, 404, 'Method not found');
    return;
  }
  if (components !== undefined) {
    await replaceComponents(id, components);
  }
  json(res, 200, { method: row });
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!(await canEditMethods(auth))) {
    error(res, 403, 'Editor role required', 'methods.forbidden');
    return;
  }
  const id = Number(url.searchParams.get('id'));
  if (!id) {
    error(res, 400, 'Missing id parameter');
    return;
  }
  const db = getDb();
  // The analytical_method_components rows reference this method with
  // ON DELETE CASCADE, so they are removed automatically. The drug rows
  // (the components themselves) are never touched.
  const [row] = await db
    .delete(analyticalMethods)
    .where(eq(analyticalMethods.id, id))
    .returning({ id: analyticalMethods.id });
  if (!row) {
    error(res, 404, 'Method not found');
    return;
  }
  json(res, 200, { ok: true, id: row.id });
}
