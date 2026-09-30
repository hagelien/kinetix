/**
 * Unified biological-entity catalog endpoint (#785). One registry for the
 * non-drug macromolecules that drugs are metabolised by or act on — enzymes,
 * receptors, transporters, … — superseding the separate /api/enzymes and
 * /api/receptor-targets catalogs.
 *
 *   GET                  — typeahead (`?q=&limit=`, optional `?function=`) or
 *                          full list (`?view=all`) or a single entity (`?id=`),
 *                          including its functions, or the drugs the metabolism
 *                          database routes through an entity
 *                          (`?metabolismDrugs=`). Read-only/public.
 *   POST                 — admin only. Create an entity (with functions).
 *   PATCH ?id=           — admin only. Update an entity / its functions.
 *   DELETE ?id=          — admin only. Remove an entity (edge links set null).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import {
  bioEntityCreateRequestSchema,
  bioEntityUpdateRequestSchema,
} from './_lib/schemas.js';
import {
  BIO_ENTITY_FUNCTIONS,
  normalizeBioEntityKey,
} from '../src/lib/bioEntities.js';
import type { BioEntityFunction } from '../src/lib/bioEntities.js';
import { CAP } from '../src/lib/permissions.js';
import { callerCan } from './_lib/permissions-store.js';
import { pendingEdits } from '../db/schema.js';
import { recordImplicitAgentApproval } from './_lib/agent-verifications.js';
import {
  BioEntityWriteError,
  createBioEntity,
  deleteBioEntity,
  getAncestors,
  getBioEntityById,
  getBioEntityBySlug,
  getChildren,
  getEntityMonographSlug,
  listBioEntities,
  searchBioEntities,
  updateBioEntity,
} from './_lib/bioEntityStore.js';
import { listEntityMetabolismDrugs } from './_lib/metabolismStore.js';
import { ensureEntityMonograph } from './_lib/monograph-helpers.js';

const FUNCTION_SET: ReadonlySet<string> = new Set(BIO_ENTITY_FUNCTIONS);

export default withErrorHandling(async function handler(req, res): Promise<void> {
  switch (req.method) {
    case 'GET':
      return handleGet(req, res);
    case 'POST':
      assertSameOrigin(req);
      return handleCreate(req, res);
    case 'PATCH':
      assertSameOrigin(req);
      return handleUpdate(req, res);
    case 'DELETE':
      assertSameOrigin(req);
      return handleDelete(req, res);
    default:
      error(res, 405, 'Method not allowed');
  }
});

function urlOf(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
}

function parseId(req: IncomingMessage): number | null {
  const n = Number(urlOf(req).searchParams.get('id'));
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseFunction(req: IncomingMessage): BioEntityFunction | undefined {
  const value = urlOf(req).searchParams.get('function');
  return value && FUNCTION_SET.has(value)
    ? (value as BioEntityFunction)
    : undefined;
}

async function requireEntityDeleter(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ userId: number } | null> {
  const auth = await getUserFromRequest(req);
  if (!auth || !(await callerCan(auth.role, CAP['bioEntity.delete']))) {
    error(res, 403, 'Admin role required');
    return null;
  }
  return { userId: auth.userId };
}

type ContributorAuth = { userId: number; role: string };

async function requireContributor(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<ContributorAuth | null> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Authentication required');
    return null;
  }
  if (!(await callerCan(auth.role, CAP['edit.bioEntity.submit']))) {
    error(res, 403, 'Contributor role or higher required to edit entities');
    return null;
  }
  return { userId: auth.userId, role: auth.role };
}

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = urlOf(req);

  const id = parseId(req);
  if (id !== null) {
    const entity = await getBioEntityById(getDb(), id);
    if (!entity) {
      error(res, 404, 'Entity not found');
      return;
    }
    const monographSlug = await getEntityMonographSlug(getDb(), entity.id);
    json(res, 200, { entity, monographSlug });
    return;
  }

  const slug = url.searchParams.get('slug');
  if (slug) {
    const entity = await getBioEntityBySlug(getDb(), slug);
    if (!entity) {
      error(res, 404, 'Entity not found');
      return;
    }
    const monographSlug = await getEntityMonographSlug(getDb(), entity.id);
    json(res, 200, { entity, monographSlug });
    return;
  }

  // Reverse metabolism lookup: the drugs whose elimination routes run through
  // this entity. Read-only/public, like the rest of the catalog GETs.
  const metabolismDrugsFor = Number(url.searchParams.get('metabolismDrugs'));
  if (Number.isInteger(metabolismDrugsFor) && metabolismDrugsFor > 0) {
    const drugs = await listEntityMetabolismDrugs(getDb(), metabolismDrugsFor);
    json(res, 200, { drugs });
    return;
  }

  const childrenOf = Number(url.searchParams.get('children'));
  if (Number.isInteger(childrenOf) && childrenOf > 0) {
    const entities = await getChildren(getDb(), childrenOf);
    json(res, 200, { entities });
    return;
  }

  const ancestorsOf = Number(url.searchParams.get('ancestors'));
  if (Number.isInteger(ancestorsOf) && ancestorsOf > 0) {
    const entities = await getAncestors(getDb(), ancestorsOf);
    json(res, 200, { entities });
    return;
  }

  if (url.searchParams.get('view') === 'all') {
    const entities = await listBioEntities(getDb());
    json(res, 200, { entities });
    return;
  }

  const q = url.searchParams.get('q') ?? '';
  const limitParam = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 10;
  const entities = await searchBioEntities(getDb(), q, {
    function: parseFunction(req),
    limit,
  });
  json(res, 200, { entities });
}

// Queue a contributor's catalog change as a pending edit (editType='bio_entity')
// so it flows through the same review queue as drug facts and parameters, then
// records the submitter's implicit self-approval. Mirrors the receptor-targets
// and metabolism submit paths.
async function queueBioEntityEdit(
  res: ServerResponse,
  actor: ContributorAuth,
  targetId: number | null,
  proposedValue: unknown,
  editSummary: string | undefined,
  label: { symbol: string; name: string } | null,
): Promise<void> {
  const meta: Record<string, unknown> = {};
  if (editSummary) meta.editSummary = editSummary;
  // Create edits have no target row to hydrate a name from, so stash the
  // symbol/name for the review card (mirrors learning_unit's meta.title).
  if (label) {
    meta.symbol = label.symbol;
    meta.name = label.name;
  }
  const [row] = await getDb()
    .insert(pendingEdits)
    .values({
      editType: 'bio_entity',
      targetId,
      proposedValue: proposedValue as never,
      proposedMeta: (Object.keys(meta).length > 0 ? meta : null) as never,
      status: 'pending',
      submittedBy: actor.userId,
    })
    .returning({ id: pendingEdits.id });
  if (!row) throw new Error('pendingEdits insert returned no row');

  await recordImplicitAgentApproval({
    userId: actor.userId,
    targetType: 'pending_edit',
    targetId: row.id,
  });

  json(res, 201, { pending: true, pendingEditId: row.id });
}

async function handleCreate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const actor = await requireContributor(req, res);
  if (!actor) return;
  const parsed = await parseAndValidate(req, bioEntityCreateRequestSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  const { editSummary, submitForReview, ...entityInput } = parsed.data;

  // Reject a duplicate symbol up front so the review queue never fills with
  // unapprovable create rows (the normalized-symbol dedup rule mirrors the
  // registry's own matching in src/lib/bioEntities.ts).
  const key = normalizeBioEntityKey(entityInput.symbol);
  const existing = await listBioEntities(getDb());
  if (existing.some((e) => normalizeBioEntityKey(e.symbol) === key)) {
    error(
      res,
      409,
      `An entity with the symbol "${entityInput.symbol}" already exists`,
      'bio_entity_duplicate_symbol',
    );
    return;
  }

  // Non-admins (and admins who opt in) route through the review queue.
  if (
    !(await callerCan(actor.role, CAP['edit.directWrite'])) ||
    submitForReview
  ) {
    await queueBioEntityEdit(
      res,
      actor,
      null,
      { op: 'create', entity: entityInput },
      editSummary,
      { symbol: entityInput.symbol, name: entityInput.name },
    );
    return;
  }

  try {
    const entity = await createBioEntity(getDb(), entityInput);
    // Mint an empty monograph up front, mirroring drug creation (#785).
    const { page } = await ensureEntityMonograph(getDb(), entity, actor.userId);
    json(res, 201, { entity, monographSlug: page.slug });
  } catch (err) {
    if (err instanceof BioEntityWriteError) {
      error(res, err.statusHint, err.message);
      return;
    }
    throw err;
  }
}

async function handleUpdate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const actor = await requireContributor(req, res);
  if (!actor) return;
  const id = parseId(req);
  if (id === null) {
    error(res, 400, 'Missing or invalid id');
    return;
  }
  const parsed = await parseAndValidate(req, bioEntityUpdateRequestSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }
  const { editSummary, submitForReview, ...patch } = parsed.data;

  // Confirm the entity exists before queuing an edit against it so a stale id
  // fails fast rather than producing an unapprovable review row.
  const target = await getBioEntityById(getDb(), id);
  if (!target) {
    error(res, 404, 'Entity not found');
    return;
  }

  if (
    !(await callerCan(actor.role, CAP['edit.directWrite'])) ||
    submitForReview
  ) {
    await queueBioEntityEdit(
      res,
      actor,
      id,
      { op: 'update', patch },
      editSummary,
      { symbol: target.symbol, name: target.name },
    );
    return;
  }

  try {
    const entity = await updateBioEntity(getDb(), id, patch);
    if (!entity) {
      error(res, 404, 'Entity not found');
      return;
    }
    json(res, 200, { entity });
  } catch (err) {
    if (err instanceof BioEntityWriteError) {
      error(res, err.statusHint, err.message);
      return;
    }
    throw err;
  }
}

async function handleDelete(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!(await requireEntityDeleter(req, res))) return;
  const id = parseId(req);
  if (id === null) {
    error(res, 400, 'Missing or invalid id');
    return;
  }
  const removed = await deleteBioEntity(getDb(), id);
  if (!removed) {
    error(res, 404, 'Entity not found');
    return;
  }
  json(res, 200, { ok: true });
}
