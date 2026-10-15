/**
 * Admin endpoint for the deep-research drug bulk-seed (#drug-database-bulk-seed).
 *
 * The browser-facing counterpart to `npm run import:research`: an admin pastes
 * or uploads a `kinetix-deep-research-output-v1` JSON document and this route
 * validates it and (optionally) seeds the whole drug — parameters, citations,
 * pharmacodynamic targets, metabolism — in one request. Same validation and
 * write path as the CLI (both call `runImport`), so the terminal and the UI
 * behave identically.
 *
 *   POST /api/research-import
 *   body: { document: <v1 JSON>, dryRun?: boolean, overwrite?: boolean }
 *
 * Admin-only. `dryRun` validates and returns the plan + warnings without
 * writing (and needs no confirmation). A real run writes directly to the DB
 * like the other seed scripts, attributing the seeded revisions to the calling
 * admin, and stamps `drugs.source = 'deep-research'`.
 */
import { json, error, withErrorHandling } from './_lib/response.js';
import { getDb } from './_lib/db.js';
import { requireAdmin } from './_lib/require-admin.js';
import { CAP } from '../src/lib/permissions.js';
import {
  readBody,
  assertSameOrigin,
  RequestBodyTooLargeError,
  CrossOriginRequestError,
} from './_lib/validate.js';
import {
  parseResearchOutput,
  recountSourceValueCoverage,
  type NormalizedResearchImport,
} from '../src/lib/deepResearchImport.js';
import { runImport } from './_lib/researchImportStore.js';
import { OPTIONAL_DOSE_CONTEXT_FIELD_KEYS } from '../src/lib/entryDoseContext.js';
import { ParameterApplyError } from './_lib/drugs-helpers.js';
import { resolveImportCrosswalk } from './_lib/citation-crosswalk.js';

// Research documents carry every source-level observation, so they can be
// larger than the default 1 MB body cap. 8 MB is generous headroom while still
// bounding a hostile upload.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

export default withErrorHandling(async function handler(req, res): Promise<void> {
  if (req.method !== 'POST') {
    error(res, 405, 'Method not allowed');
    return;
  }

  assertSameOrigin(req);
  const auth = await requireAdmin(req, res, CAP['admin.researchImport.run']);
  if (!auth) return;

  let raw: string;
  try {
    raw = await readBody(req, { maxBytes: MAX_BODY_BYTES });
  } catch (err) {
    if (err instanceof RequestBodyTooLargeError) {
      error(res, 413, 'Document too large');
      return;
    }
    if (err instanceof CrossOriginRequestError) {
      error(res, 403, 'Cross-origin request rejected');
      return;
    }
    throw err;
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    error(res, 400, 'Invalid JSON body');
    return;
  }

  const envelope = (body ?? {}) as {
    document?: unknown;
    dryRun?: unknown;
    overwrite?: unknown;
  };
  const dryRun = envelope.dryRun !== false; // default to a safe dry-run
  const overwrite = envelope.overwrite === true;
  const document = 'document' in envelope ? envelope.document : body;

  const parsed = parseResearchOutput(document);
  if (!parsed.ok) {
    json(res, 400, { ok: false, errors: parsed.errors });
    return;
  }
  const data = parsed.data;

  const plan = summarizePlan(data);

  if (dryRun) {
    json(res, 200, { ok: true, dryRun: true, plan, warnings: data.warnings });
    return;
  }

  // Which of this document's sources are the same paper as an existing row
  // (#1018). Resolved here rather than in the store, which stays network-free;
  // best-effort, so a slow or unavailable NCBI just means each source is filed
  // under the handle it declared.
  const crosswalk = await resolveImportCrosswalk(data.sources);

  let stats: Awaited<ReturnType<typeof runImport>>;
  try {
    stats = await runImport(getDb(), data, {
      userId: auth.userId,
      overwrite,
      crosswalk,
    });
  } catch (err) {
    // The document's PubChem CID would shadow another, CID-less drug's
    // internal id (new drug or first-CID backfill). Refused before the drug
    // row is written, and answered as PATCH /api/drugs answers it.
    if (err instanceof ParameterApplyError) {
      error(res, err.statusHint, err.message, err.code);
      return;
    }
    throw err;
  }
  // Coverage is recounted against the crosswalk: two sources the ID converter
  // placed on one article became one citation row, so the parse-time count the
  // preview showed could have credited a parameter with two papers it does not
  // have. The import reports what it wrote.
  json(res, 200, {
    ok: true,
    dryRun: false,
    plan,
    stats,
    warnings: recountSourceValueCoverage(data, crosswalk),
  });
});

/** Counts + a parameter list the UI renders as a preview before committing. */
function summarizePlan(data: NormalizedResearchImport) {
  return {
    drug: {
      nameNb: data.drug.nameNb,
      nameEn: data.drug.nameEn,
      pubchemCid: data.drug.pubchemCid,
    },
    parameters: data.parameters.map((p) => ({
      parameter: p.parameter,
      sourceCount: p.sourceIds.length,
      // The source values that state a formulation, regimen or population
      // (#12): this import writes them without review, and a modified-release
      // or special-population value is kept out of the pooled figure, so the
      // operator approving the plan must see which values carry one.
      scopes: (p.sourceValues ?? [])
        .map((sv) =>
          Object.fromEntries(
            OPTIONAL_DOSE_CONTEXT_FIELD_KEYS.flatMap((k) =>
              sv[k] == null ? [] : [[k, sv[k]]],
            ),
          ),
        )
        .filter((scope) => Object.keys(scope).length > 0),
    })),
    // Structured pKa is committed by the same review-bypassing write path, so it
    // must be visible in the dry-run plan an operator approves.
    ionizationConstants: data.ionizationConstants.map((c) => ({
      pKa: c.pKa,
      protonatedCharge: c.protonatedCharge,
      deprotonatedCharge: c.deprotonatedCharge,
      type: c.type,
      evidenceType: c.evidenceType,
      sourceCount: c.sourceIds.length,
    })),
    counts: {
      parameters: data.parameters.length,
      ionizationConstants: data.ionizationConstants.length,
      sources: data.sources.length,
      pharmacodynamicTargets: data.pharmacodynamicTargets.length,
      eliminationRoutes: data.metabolism.eliminationRoutes.length,
      metabolites: data.metabolism.metabolites.length,
      enzymeInteractions: data.metabolism.enzymeInteractions.length,
    },
  };
}
