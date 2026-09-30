/**
 * Shared helpers for inserting drug rows and initial PK parameter values.
 * Used by:
 *   - POST /api/drugs (admin direct creation)
 *   - POST /api/wiki/pages (monograph creation with a brand-new drug)
 *   - approval worker for `wiki_new` pending edits
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { drugs, drugParameterRevisions, wikiPages } from "../../db/schema.js";
import { getDb } from "./db.js";
import { withDrugApplicabilityLock } from "./parameterApplicabilityStore.js";
import { generateSlug } from "./slug.js";
import {
  DRUG_PARAMETERS,
  isDrugParameterId,
  isRangeKind,
  parameterAcceptsAuthoredValue,
  type DrugParameterId,
} from "../../src/lib/drugParameters.js";
import {
  buildDrugSearchKey,
  normalizeAliases,
  resolveDrugName,
  type LangCode,
} from "../../src/lib/drugNames.js";
import {
  getDrugParameterMap,
  isStoredInDrugParameters,
  upsertDrugParameter,
} from "./drugParameterStore.js";

export interface InsertDrugInput {
  /** Per-language names; at least one entry. */
  names: Record<LangCode, string>;
  nameShort?: string;
  aliases?: string[];
  pubchemCid?: number;
  /**
   * Optional initial molecular weight. Stored in `drug_parameters` (#302
   * P2), so this requires a user id for `updated_by`. Pass `createdBy`
   * when supplying a value, or omit the value entirely.
   */
  molecularWeight?: number;
  /**
   * 'drug' (the column default), 'metabolite' or 'endogenous'. Governs which
   * parameters are defined for the substance — see SUBSTANCE_CLASSES in
   * src/lib/parameterApplicability.ts.
   */
  substanceClass?: string;
  /** User id used for the drug_parameters.updated_by column, when MW is set. */
  createdBy?: number;
}

export type DrugRow = typeof drugs.$inferSelect;

/**
 * Build the canonical lowercase, tab-separated `search_key` value covering
 * every language name plus aliases plus shortname. Mirrors the SQL backfill
 * in `drizzle/0013_drug_names_jsonb.sql`.
 */
export function buildSearchKey(input: {
  names?: Record<LangCode, string> | null;
  nameShort?: string | null;
  aliases?: string[] | null;
}): string {
  return buildDrugSearchKey({
    names: input.names ?? {},
    nameShort: input.nameShort,
    aliases: input.aliases,
  });
}

/**
 * Pick the slug source: prefer the Norwegian name (primary language of the
 * site), fall back to English. Norwegian-first prevents adding an English
 * name from silently re-slugging an existing drug.
 */
function slugSourceFromNames(names: Record<LangCode, string>): string {
  return resolveDrugName(names, 'nb') || resolveDrugName(names, 'en');
}

/**
 * Insert a new drug row. Returns the created row.
 *
 * Callers should catch unique-violation errors (message includes "unique"
 * or "duplicate") and surface a 409 — `slug` and `pubchem_cid` are unique.
 */
export async function insertDrug(input: InsertDrugInput): Promise<DrugRow> {
  const db = getDb();
  const slug = generateSlug(slugSourceFromNames(input.names));

  const aliases = input.aliases ? normalizeAliases(input.aliases) : [];

  const [row] = await db
    .insert(drugs)
    .values({
      slug,
      names: input.names,
      nameShort: input.nameShort,
      aliases,
      pubchemCid: input.pubchemCid,
      // Omitted rather than defaulted here so the column default ('drug')
      // stays the single source of truth for an unclassified substance.
      ...(input.substanceClass ? { substanceClass: input.substanceClass } : {}),
      searchKey: buildSearchKey({
        names: input.names,
        nameShort: input.nameShort,
        aliases,
      }),
    })
    .returning();

  if (!row) {
    throw new Error("Failed to insert drug row");
  }

  // molecularWeight moved to `drug_parameters` in #302 P2; route the
  // initial value (if any) through the new store. createdBy is required
  // because the store's `updated_by` column tracks attribution.
  if (input.molecularWeight !== undefined && input.createdBy !== undefined) {
    await upsertDrugParameter(
      db,
      row.id,
      "molecularWeight",
      input.molecularWeight,
      input.createdBy,
    );
  }

  return row;
}

/**
 * True when `err` is (or wraps) a Postgres unique-violation.
 *
 * The chain matters: drizzle re-throws driver errors as a `DrizzleQueryError`
 * whose own message is "Failed query: insert into …" — the violation text and
 * SQLSTATE live on `cause`. Reading only the top-level message therefore
 * answers "no" for every real violation, which turns each caller's intended
 * 409 into a 500. SQLSTATE 23505 is the reliable signal; the message match is
 * kept as a fallback for drivers that surface a bare string.
 */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err; e != null; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("unique") || message.includes("duplicate")) return true;
  }
  return false;
}

/**
 * True when `err` is (or wraps) a Postgres foreign-key violation.
 *
 * Same chain-walk as {@link isUniqueViolation}, and for the same reason:
 * drizzle re-throws the driver's error, so the SQLSTATE lives on `cause`.
 * SQLSTATE 23503 is a restrictive key refusing to drop something another row
 * depends on — a conflict to report, not a fault to hide behind a 500.
 */
export function isForeignKeyViolation(err: unknown): boolean {
  for (let e: unknown = err; e != null; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23503") return true;
  }
  return false;
}

/**
 * Throws a user-meaningful Error so the caller can surface it as a 4xx
 * instead of leaking a raw DB violation.
 */
export class ParameterApplyError extends Error {
  constructor(
    message: string,
    public statusHint: 400 | 409 = 400,
    // Stable, locale-mappable code so the review UI can localize the failure
    // (see REVIEW_ERROR_KEYS) instead of surfacing the raw English message.
    public code?: string,
  ) {
    super(message);
    this.name = "ParameterApplyError";
  }
}

interface DrugRowLike {
  id: number;
  slug: string;
  names: Record<LangCode, string>;
  nameShort: string | null;
  aliases: string[] | null;
}

/** Map a per-language metadata parameter id to its `names` jsonb key. */
const NAME_PARAMETER_LANG: Record<string, LangCode> = {
  nameNb: 'nb',
  nameEn: 'en',
};

/**
 * Read the current value of a parameter from a drug row, indirecting through
 * the `names` jsonb for per-language parameters (`nameNb`, `nameEn`) and
 * through the supplied `paramMap` for grouped parameters that now live in
 * `drug_parameters` (#302 P2). Used when capturing oldValue snapshots for
 * revision history.
 *
 * Callers that look up grouped parameters MUST pre-fetch the map (via
 * `getDrugParameterMap` from drugParameterStore) and pass it here; an
 * undefined map yields `null` for grouped parameters since the value no
 * longer lives on the drug row.
 */
export function readParameterValue(
  row: Record<string, unknown>,
  parameter: DrugParameterId,
  paramMap?: Map<string, unknown> | null,
): unknown {
  const lang = NAME_PARAMETER_LANG[parameter];
  if (lang) {
    const names = (row.names ?? {}) as Record<LangCode, string>;
    return names[lang] ?? null;
  }
  if (isStoredInDrugParameters(parameter)) {
    return paramMap?.get(parameter) ?? null;
  }
  return row[parameter] ?? null;
}

/**
 * Compute the partial drug-row update for a single approved/admin parameter
 * change, taking care of the per-field side effects:
 *
 * - `nameNb` / `nameEn`: write into the `names` jsonb (creating, replacing,
 *   or removing the language key) and rebuild `searchKey`. When the slug
 *   source language changes, regenerate `slug` with a uniqueness pre-check.
 * - `nameShort` / `aliases`: rebuild `searchKey`.
 * - `molecularWeight`: stringify for the numeric column.
 * - `pubchemCid`: pre-flight uniqueness check against other rows.
 * - PK/PD `range` kinds: pass-through (jsonb columns).
 *
 * Throws `ParameterApplyError` on logical conflicts (e.g. another drug
 * already owns the proposed pubchemCid). Slug uniqueness is also pre-checked
 * for `nameEn`/`nameNb` so we can surface a clean conflict message instead
 * of a raw UNIQUE violation at write time.
 */
export async function buildParameterUpdate(args: {
  drugId: number;
  parameter: DrugParameterId;
  newValue: unknown;
  existing: DrugRowLike;
  /**
   * The user id to record on `drug_parameters.updated_by` when the
   * parameter is stored in the row table (#302 P2). Required for any
   * grouped parameter; ignored otherwise.
   */
  applyingUserId: number;
}): Promise<Record<string, unknown>> {
  const { drugId, parameter, newValue, existing, applyingUserId } = args;
  const spec = DRUG_PARAMETERS[parameter];
  const db = getDb();

  // Grouped parameters (#302) live in `drug_parameters`. Side-effect the
  // upsert here and return an empty drug-row update — callers still
  // expect a record they can spread into `db.update(drugs).set(...)`.
  if (isStoredInDrugParameters(parameter)) {
    if (spec.kind === "number" && newValue === null && spec.nullable) {
      await upsertDrugParameter(db, drugId, parameter, null, applyingUserId);
      return {};
    }
    if (spec.kind === "number") {
      if (typeof newValue !== "number" || !Number.isFinite(newValue)) {
        throw new ParameterApplyError(
          `${spec.longLabel} must be a finite number`,
          400,
        );
      }
    }
    await upsertDrugParameter(db, drugId, parameter, newValue, applyingUserId);
    return {};
  }

  if (isRangeKind(spec.kind)) {
    return { [parameter]: newValue };
  }

  if (spec.kind === "text") {
    const raw = typeof newValue === "string" ? newValue.trim() : String(newValue ?? "").trim();

    const lang = NAME_PARAMETER_LANG[parameter];
    if (lang) {
      const nextNames: Record<LangCode, string> = { ...existing.names };
      if (raw.length === 0) {
        delete nextNames[lang];
      } else {
        nextNames[lang] = raw;
      }
      if (Object.keys(nextNames).length === 0) {
        throw new ParameterApplyError(
          'A drug must keep at least one language name',
          400,
        );
      }
      const updates: Record<string, unknown> = { names: nextNames };
      // Slug derives from English first, Norwegian second. Regenerate when
      // the chosen source actually changes.
      const oldSlugSrc = slugSourceFromNames(existing.names);
      const newSlugSrc = slugSourceFromNames(nextNames);
      if (newSlugSrc && newSlugSrc !== oldSlugSrc) {
        const newSlug = generateSlug(newSlugSrc);
        if (!newSlug) {
          throw new ParameterApplyError(
            'Drug name produces an empty slug',
            400,
          );
        }
        if (newSlug !== existing.slug) {
          const [collision] = await db
            .select({ id: drugs.id })
            .from(drugs)
            .where(and(eq(drugs.slug, newSlug), ne(drugs.id, drugId)))
            .limit(1);
          if (collision) {
            throw new ParameterApplyError(
              `Another drug already uses the slug "${newSlug}"; rename it first or pick a distinct name`,
              409,
            );
          }
          updates.slug = newSlug;
          // Keep the drug's wiki monograph page slug in sync so pending-edit
          // review cards always link to the correct URL.
          await db
            .update(wikiPages)
            .set({ slug: newSlug })
            .where(
              and(
                eq(wikiPages.pageType, 'drug_monograph'),
                eq(wikiPages.drugCid, drugId),
              ),
            );
        }
      }
      updates.searchKey = buildSearchKey({
        names: nextNames,
        nameShort: existing.nameShort,
        aliases: existing.aliases,
      });
      return updates;
    }

    // Optional non-name text fields (nameShort): empty string clears the column.
    const stored: string | null = raw.length === 0 ? null : raw;
    const updates: Record<string, unknown> = { [parameter]: stored };
    updates.searchKey = buildSearchKey({
      names: existing.names,
      nameShort: parameter === 'nameShort' ? stored : existing.nameShort,
      aliases: existing.aliases,
    });
    return updates;
  }

  if (spec.kind === 'list') {
    if (parameter === 'aliases') {
      const aliases = normalizeAliases(newValue);
      const updates: Record<string, unknown> = { aliases };
      updates.searchKey = buildSearchKey({
        names: existing.names,
        nameShort: existing.nameShort,
        aliases,
      });
      return updates;
    }
    return { [parameter]: newValue };
  }

  if (spec.kind === "number") {
    // Nullable number params (e.g. molecularWeight) may be cleared back
    // to NULL. Skip the uniqueness probe and the final assignment when
    // null is the intended value; downstream the column write is just
    // `{ [parameter]: null }`.
    if (newValue === null && spec.nullable) {
      return { [parameter]: null };
    }
    if (typeof newValue !== "number" || !Number.isFinite(newValue)) {
      throw new ParameterApplyError(
        `${spec.longLabel} must be a finite number`,
        400,
      );
    }

    if (spec.unique) {
      const [collision] = await db
        .select({ id: drugs.id })
        .from(drugs)
        // Drizzle types: pubchemCid lives on `drugs`. Since the ID is
        // dynamic we use the column object directly.
        .where(
          and(
            eq(drugs[parameter as "pubchemCid"], newValue),
            ne(drugs.id, drugId),
          ),
        )
        .limit(1);
      if (collision) {
        throw new ParameterApplyError(
          `${spec.longLabel} ${newValue} is already used by another drug`,
          409,
        );
      }
    }

    return { [parameter]: newValue };
  }

  // 'struct' or anything we don't yet support: fall through with a noop.
  return { [parameter]: newValue };
}

/**
 * Validate an incoming `parameters` bag against the DRUG_PARAMETERS registry
 * and return the normalised entries. Throws a plain Error if any value is
 * invalid; the caller is responsible for turning that into a 400.
 */
export function validateParameterBag(
  bag: Record<string, unknown>,
): Array<{ id: DrugParameterId; value: unknown }> {
  const out: Array<{ id: DrugParameterId; value: unknown }> = [];
  for (const [id, raw] of Object.entries(bag)) {
    if (raw === undefined || raw === null) continue;
    // Skip empty-object entries that the UI may send for untouched rows.
    if (
      typeof raw === "object" &&
      Object.keys(raw as Record<string, unknown>).length === 0
    ) {
      continue;
    }
    if (!isDrugParameterId(id)) {
      throw new Error(`Unknown parameter: ${id}`);
    }
    const spec = DRUG_PARAMETERS[id];
    // The parameters bag is for PK/PD NumericRange values only — drug metadata
    // (names, nameShort, aliases, molecularWeight, pubchemCid) goes through
    // the dedicated `newDrug` payload on wiki_new and the per-field edit flow.
    if (!isRangeKind(spec.kind)) {
      throw new Error(
        `Parameter "${id}" is metadata, not a PK value; submit it via the drug fields, not the parameters bag`,
      );
    }
    // Nor is it a way around the source-value rule. A summarizable parameter's
    // value is the aggregate of its per-source readings, and this bag carries
    // one number under one shared citation — no per-paper provenance, nothing
    // for the pool to show. `/api/drug-parameter` refuses such a value (409
    // parameter_entry_backed) and page authoring must not be the back door: the
    // readings go in as source values, whether the drug is new or not.
    if (!parameterAcceptsAuthoredValue(id)) {
      throw new Error(
        `Parameter "${id}" is derived from its source values; submit each source's reading via /api/parameter-entries, not the parameters bag`,
      );
    }
    const parsed = spec.zod.safeParse(raw);
    if (!parsed.success) {
      const msg = parsed.error.issues
        .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
        .join("; ");
      throw new Error(`Invalid ${id}: ${msg}`);
    }
    out.push({ id, value: parsed.data });
  }
  return out;
}

/**
 * Apply a set of already-validated parameter values to a drug row and write
 * one `drug_parameter_revisions` entry per parameter. Does not wrap in a
 * transaction (neon-http doesn't support interactive tx); callers should
 * validate first so errors happen before any writes.
 *
 * After #302 P2, grouped parameters land in `drug_parameters` rather than
 * dedicated columns on `drugs`. Initial-value writes are always for
 * grouped parameters (validateParameterBag rejects metadata), so this
 * function upserts each one through `upsertDrugParameter` and bumps the
 * drug row's popularity once for the batch.
 *
 * Returns the inserted revision row IDs so callers (e.g. the wiki_new
 * approval path) can attach approval stamps to them — without that
 * loop, parameter facts created through wiki_new lose the base
 * reviewer stamp that direct parameter approvals get (#344).
 */
export async function applyInitialParameters(args: {
  drugId: number;
  entries: Array<{ id: DrugParameterId; value: unknown }>;
  referenceId: number;
  userId: number;
  editSummary?: string;
  pendingEditId?: number;
}): Promise<{ revisionIds: number[] }> {
  const { drugId, entries, referenceId, userId, editSummary, pendingEditId } =
    args;
  if (entries.length === 0) return { revisionIds: [] };

  // The advisory lock is taken FIRST — before the reads and before the
  // popularity bump — because lock *order* is what prevents a deadlock, and
  // this function had it backwards for one of its two callers.
  //
  // The popularity `UPDATE drugs` takes a row lock held to commit. Under the
  // wiki_new approval path (`applyApprovedEdit` wraps everything in one
  // transaction) that happened before any upsert reached the advisory lock, so
  // the order there was row → advisory. `applyDrugRowUpdate`, serving a
  // concurrent `PATCH /api/drugs`, takes them advisory → row. Two requests
  // touching the same drug could each hold what the other needs, and Postgres
  // resolves that by killing one. The admin monograph path was already correct
  // only by accident: `withPageWriteLock` happens to take the advisory lock
  // before calling in here.
  //
  // Taking it up front makes every path advisory-first. It costs the admin
  // path nothing — `pg_advisory_xact_lock` is re-entrant within a transaction,
  // so a caller already holding it re-acquires for free.
  //
  // `withDrugApplicabilityLock` JOINS the caller's transaction rather than
  // nesting (see `inTransaction`): opening a second pool here would put these
  // writes on a different connection, where they would block forever on the
  // lock the caller's own connection holds. That is not a hypothetical — it
  // shipped once.
  return withDrugApplicabilityLock(drugId, async () => {
    const db = getDb();

    // Load the current drug row once so we know it exists.
    const [existing] = await db
      .select({ id: drugs.id })
      .from(drugs)
      .where(eq(drugs.id, drugId))
      .limit(1);
    if (!existing) {
      throw new Error("Drug not found");
    }

    // Pre-fetch the existing parameter map so revisions capture the actual
    // overwritten value. When a monograph is created against an existing
    // drug that already carries a halfLife (etc.), the previous column
    // path read the live value before writing — preserve that semantic
    // so history and conflict review reflect what changed.
    const existingParams = await getDrugParameterMap(db, drugId);

    // Bump popularity once for the whole batch (matches the previous
    // behaviour where each per-column update ticked it).
    await db
      .update(drugs)
      .set({
        updatedAt: new Date(),
        popularityScore: sql`${drugs.popularityScore} + ${entries.length}`,
      })
      .where(eq(drugs.id, drugId));

    const tx = getDb();
    const revisionIds: number[] = [];

    for (const { id, value } of entries) {
      // Initial values are always grouped (validateParameterBag rejects
      // metadata), so we know they belong in drug_parameters.
      const oldValue = existingParams.get(id) ?? null;
      await upsertDrugParameter(tx, drugId, id, value, userId);

      const [rev] = await tx
        .insert(drugParameterRevisions)
        .values({
          drugId,
          parameter: id,
          oldValue: oldValue as never,
          newValue: value as never,
          editSummary: editSummary ?? "Initial value from monograph creation",
          referenceId,
          pendingEditId,
          createdBy: userId,
        })
        .returning({ id: drugParameterRevisions.id });
      if (rev) revisionIds.push(rev.id);

      // A priority flag on this parameter (or a whole-drug flag) stays active
      // through this fill — it is a "dig deep here" instruction that only a
      // human moderator resolves (agents/drug-db-maintainer.md §3 A0).
    }

    return { revisionIds };
  });
}
