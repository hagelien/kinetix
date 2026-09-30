/**
 * Deep-research drug seeding — input contract + validation (#drug-database-bulk-seed).
 *
 * A research agent (see `agents/deep-research-drug-seeding.md`) produces a
 * `kinetix-deep-research-output-v1` JSON document for a single drug. This
 * module is the pure, DB-free half of the importer: it validates that JSON
 * against the *live* Kinetix parameter registry (`DRUG_PARAMETERS`) and
 * normalizes it into the shape `scripts/import-research-output.ts` writes to
 * the database.
 *
 * Design notes:
 *  - Validation delegates to `DRUG_PARAMETERS[id].zod` so the accepted value
 *    shape / unit family / bounds can never drift from what the app enforces
 *    on a manual edit. A parameter whose value fails is skipped with a warning
 *    rather than aborting the whole import — a half-seeded drug is more useful
 *    than none, and the warnings tell the operator exactly what to fix.
 *  - Everything here is pure and synchronous so it can be unit-tested without a
 *    database (the unit suite mocks `db.js`). The script layer owns all I/O.
 */
import { DOSE_CONTEXT_FIELD_KEYS, type DoseContextFields } from './entryDoseContext.js';
import { z } from 'zod';
import {
  DRUG_PARAMETERS,
  isDrugParameterId,
  isModelStructureParameter,
  parameterAuthoringGated,
  parameterAuthoringGatedMessage,
  parameterHasDrugLevelValue,
  parameterDoseContextMode,
  ENTRY_ONLY_PARAMETER_IDS,
  SUMMARIZED_PARAMETER_IDS,
  type DrugParameterId,
} from './drugParameters.js';
import { parameterEntrySourceValueSchema } from './parameterEntries.js';
import {
  ionizationConstantInputSchema,
  IONIZATION_CONSTANT_TYPES,
  IONIZATION_EVIDENCE_TYPES,
  PKA_MIN,
  PKA_MAX,
  CHARGE_ABS_MAX,
  type IonizationConstantType,
  type IonizationEvidenceType,
} from './ionizationConstants.js';
import {
  canonicalCitationHandle,
  normalizeAltIds,
  normalizeHandleIdentifier,
  resolverHandleFromUrl,
  type CitationAltIds,
} from './citationHandles.js';

/** The one schema version this importer understands. */
export const DEEP_RESEARCH_SCHEMA_VERSION = 'kinetix-deep-research-output-v1';

/**
 * How many *distinct* sources a source-value-backed parameter should have
 * readings from (#kildeverdier).
 *
 * The displayed value of a summarizable parameter is recomputed from its
 * `parameter_entries` rows, so a parameter seeded from a single paper yields an
 * "aggregate" that is that one paper: no spread, no inter-quartile range, and
 * nothing for the forest plot or the how-well-established signal to show. The
 * research prompt therefore asks for at least two independent sources per
 * parameter, and a seed that falls short is reported (never rejected — one
 * honest reading beats a manufactured second one).
 */
export const MIN_SOURCES_PER_PARAMETER = 2;

/** Citation kinds Kinetix stores (mirrors `citations.type`). */
export type CitationType = 'freetext' | 'url' | 'pmid' | 'doi';

export interface ImportCitationMetadata {
  title?: string;
  authors?: string[];
  journal?: string;
  year?: number | null;
}

export interface ImportSource {
  /** Author-assigned handle (e.g. "S1") used to cross-reference from values. */
  sourceId: string;
  type: CitationType;
  identifier: string;
  metadata: ImportCitationMetadata | null;
  /**
   * The other handles the source object declared (#1018). A research source
   * usually reports both a PMID and a DOI, so the crosswalk that decides which
   * row this paper belongs in is already in hand — no ID-converter lookup
   * needed. `type`/`identifier` above is the winning handle; these are the
   * rest, and the importer keeps them on `metadata.altIds` so a later seed
   * declaring one of them resolves to the same row instead of splitting it.
   */
  altIds: CitationAltIds;
}

export interface ImportNumericRange {
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  unit?: string;
}

/**
 * One source's own reported value for a parameter — a `parameter_entries` row
 * in waiting (#kildeverdier). `sourceId` points at `sources[]`; the importer
 * resolves it to a citation at write time, because a citation id only exists
 * once the document has been written.
 *
 * This is what makes an imported value participate in the source-value
 * paradigm rather than sitting beside it: the synthesized `value` above is a
 * single number backed by N citations, which cannot show what each paper
 * actually reported and is replaced wholesale by the aggregate the moment
 * anyone adds a real entry.
 */
/**
 * Extends the dose-context fields (Cmax dose-context RFC) so the importer's
 * reconciliation compares them. The document format does not carry them yet —
 * reading them from a document is a release-C producer change — so today every
 * one is absent.
 */
export interface ImportParameterSourceValue extends DoseContextFields {
  sourceId: string;
  low?: number;
  high?: number;
  median?: number;
  qualifier?: string;
  /** As reported, from the parameter's own allowed entry units. */
  unit: string;
  matrix?: string;
  scenario?: string;
  n?: number;
  comments?: string;
  /**
   * Facts about the reading itself (dose, fed/fasted state, population, assay
   * method) — part of what the cited sentence attests, unlike `comments`
   * (curator commentary about the row). Written to `parameter_entries.observation_context`.
   * Same three states as `quote`, for the same reason: this field is new, so
   * every document written before it existed omits it, and that omission must
   * PRESERVE what a row already holds rather than clear it.
   *   - **absent** (`undefined`) — preserve what is stored.
   *   - **explicit `null`** (or a blank/whitespace-only string) — clear it.
   *   - **text** — replace it.
   */
  observationContext?: string | null;
  /**
   * The verbatim text this reading was taken from, in the source's own
   * language.
   *
   * Three states, and the difference between the last two decides whether a
   * re-import preserves or destroys provenance:
   *   - **absent** (`undefined`) — the document does not mention a quote, which
   *     is what EVERY document written before this field existed looks like.
   *     A re-import must leave a stored quote alone.
   *   - **explicit `null`** — the document states there is no quote, i.e. clear
   *     it.
   *   - **text** — the words.
   */
  quote?: string | null;
}

export interface ImportParameterValue {
  parameter: DrugParameterId;
  /**
   * The synthesized value, validated against `DRUG_PARAMETERS[parameter].zod`.
   * Optional in v2: a parameter that carries `sourceValues` may leave it out
   * and let the aggregate be computed from the entries instead. When both are
   * present the value is seeded first and the post-import recompute replaces
   * it with the aggregate.
   */
  value?: unknown;
  sourceIds: string[];
  /** Per-source values written to `parameter_entries`; empty when none given. */
  sourceValues: ImportParameterSourceValue[];
}

/**
 * One normalized ionization constant from an import document — a
 * `drug_ionization_constants` row in waiting. The transition (protonated →
 * deprotonated net charge) is the primary identity; `sourceIds` point at
 * `sources[]` and are resolved to citations at write time.
 */
export interface ImportIonizationConstant {
  pKa: number;
  protonatedCharge: number;
  deprotonatedCharge: number;
  type: IonizationConstantType;
  evidenceType: IonizationEvidenceType;
  siteLabel: string | null;
  temperatureC: number | null;
  medium: string | null;
  note: string | null;
  sourceIds: string[];
}

export interface ImportPdTarget {
  symbol: string;
  name: string | null;
  interactionType: string;
  tier: 'primary' | 'secondary' | 'tertiary' | null;
  ki: ImportNumericRange | null;
  ic50: ImportNumericRange | null;
  ec50: ImportNumericRange | null;
  emax: ImportNumericRange | null;
  affinity: ImportNumericRange | null;
  potency: ImportNumericRange | null;
  efficacy: ImportNumericRange | null;
  selectivityRatio: ImportNumericRange | null;
  /**
   * Species of the preparation the measurements were made in (#1017), e.g.
   * "Homo sapiens", "Rattus norvegicus", "recombinant human (CHO-K1)". The
   * catalog entity stays human-canonical; a non-human assay is recorded here,
   * on the observation. `null` = the agent did not state one, which is NOT a
   * claim that the assay was human.
   */
  assaySpecies: string | null;
  evidenceNote: string | null;
  sourceIds: string[];
}

export type EliminationRouteKind =
  | 'enzyme'
  | 'metabolized'
  | 'renal_unchanged'
  | 'fecal_biliary'
  | 'other_unchanged';

export interface ImportEliminationRoute {
  kind: EliminationRouteKind;
  /** Enzyme symbol/name for enzyme routes; free-text label otherwise. */
  label: string;
  fraction: number | null;
  fractionMin: number | null;
  fractionMax: number | null;
  note: string | null;
  sourceIds: string[];
}

export interface ImportMetabolite {
  name: string;
  activity: 'active' | 'inactive' | 'unknown';
  conversionFraction: number | null;
  conversionFractionMin: number | null;
  conversionFractionMax: number | null;
  note: string | null;
  sourceIds: string[];
}

export interface ImportEnzymeInteraction {
  enzymeSymbol: string;
  role: 'substrate' | 'inducer' | 'inhibitor';
  strength: 'weak' | 'moderate' | 'strong' | null;
  note: string | null;
  sourceIds: string[];
}

export interface ImportMetabolism {
  profileNote: string | null;
  profileSourceIds: string[];
  eliminationRoutes: ImportEliminationRoute[];
  metabolites: ImportMetabolite[];
  enzymeInteractions: ImportEnzymeInteraction[];
}

export interface NormalizedResearchImport {
  schemaVersion: string;
  drug: {
    nameNb: string | null;
    nameEn: string | null;
    nameShort: string | null;
    aliases: string[];
    pubchemCid: number | null;
    molecularWeight: number | null;
  };
  parameters: ImportParameterValue[];
  ionizationConstants: ImportIonizationConstant[];
  sources: ImportSource[];
  pharmacodynamicTargets: ImportPdTarget[];
  metabolism: ImportMetabolism;
  /** Non-fatal issues: skipped parameters/targets, coercions, unknown ids. */
  warnings: string[];
}

export type ParseResult =
  | { ok: true; data: NormalizedResearchImport }
  | { ok: false; errors: string[] };

// ─── Loose input schema ──────────────────────────────────────────────────────
// The importer is deliberately permissive about the *envelope* (extra keys,
// missing optional blocks) and strict only where it writes to the DB. The zod
// schema below therefore validates structure loosely; per-value correctness is
// enforced afterwards against the parameter registry.

const numericRangeInput = z
  .object({
    min: z.number().finite().optional().nullable(),
    max: z.number().finite().optional().nullable(),
    mean: z.number().finite().optional().nullable(),
    median: z.number().finite().optional().nullable(),
    unit: z.string().optional().nullable(),
    qualifier: z.string().optional().nullable(),
    note: z.string().optional().nullable(),
  })
  .passthrough();

const sourceInput = z
  .object({
    sourceId: z.string().optional().nullable(),
    citationType: z.string().optional().nullable(),
    identifier: z.string().optional().nullable(),
    title: z.string().optional().nullable(),
    authors: z.array(z.string()).optional().nullable(),
    journalOrSource: z.string().optional().nullable(),
    year: z.number().optional().nullable(),
    doi: z.string().optional().nullable(),
    pmid: z.string().optional().nullable(),
    url: z.string().optional().nullable(),
  })
  .passthrough();

// One source's reported value. Loose like every other input block — the real
// rules come from `parameterEntrySourceValueSchema`, the same schema the entry
// store validates a hand-added entry with.
const sourceValueInput = z
  .object({
    sourceId: z.string(),
    low: z.number().optional().nullable(),
    high: z.number().optional().nullable(),
    median: z.number().optional().nullable(),
    qualifier: z.string().optional().nullable(),
    unit: z.string().optional().nullable(),
    matrix: z.string().optional().nullable(),
    scenario: z.string().optional().nullable(),
    n: z.number().optional().nullable(),
    comments: z.string().optional().nullable(),
    observationContext: z.string().optional().nullable(),
    quote: z.string().optional().nullable(),
  })
  .passthrough();

const parameterValueInput = z
  .object({
    parameter: z.string(),
    status: z.string().optional().nullable(),
    value: z.unknown().optional().nullable(),
    sourceIds: z.array(z.string()).optional().nullable(),
    sourceValues: z.array(sourceValueInput).optional().nullable(),
  })
  .passthrough();

const pdTargetInput = z
  .object({
    targetSymbol: z.string().optional().nullable(),
    targetName: z.string().optional().nullable(),
    interactionType: z.string().optional().nullable(),
    tier: z.string().optional().nullable(),
    ki: numericRangeInput.optional().nullable(),
    ic50: numericRangeInput.optional().nullable(),
    ec50: numericRangeInput.optional().nullable(),
    emax: numericRangeInput.optional().nullable(),
    affinity: numericRangeInput.optional().nullable(),
    potency: numericRangeInput.optional().nullable(),
    efficacy: numericRangeInput.optional().nullable(),
    selectivityRatio: numericRangeInput.optional().nullable(),
    assaySpecies: z.string().optional().nullable(),
    evidenceNote: z.string().optional().nullable(),
    sourceIds: z.array(z.string()).optional().nullable(),
  })
  .passthrough();

const eliminationRouteInput = z
  .object({
    kind: z.string().optional().nullable(),
    enzymeOrEntitySymbol: z.string().optional().nullable(),
    label: z.string().optional().nullable(),
    fraction: z.number().optional().nullable(),
    fractionMin: z.number().optional().nullable(),
    fractionMax: z.number().optional().nullable(),
    note: z.string().optional().nullable(),
    sourceIds: z.array(z.string()).optional().nullable(),
  })
  .passthrough();

const metaboliteInput = z
  .object({
    metaboliteName: z.string().optional().nullable(),
    conversionFraction: z.number().optional().nullable(),
    conversionFractionMin: z.number().optional().nullable(),
    conversionFractionMax: z.number().optional().nullable(),
    activity: z.string().optional().nullable(),
    evidenceNote: z.string().optional().nullable(),
    sourceIds: z.array(z.string()).optional().nullable(),
  })
  .passthrough();

const enzymeInteractionInput = z
  .object({
    enzymeOrEntitySymbol: z.string().optional().nullable(),
    role: z.string().optional().nullable(),
    strength: z.string().optional().nullable(),
    note: z.string().optional().nullable(),
    sourceIds: z.array(z.string()).optional().nullable(),
  })
  .passthrough();

const rootInput = z
  .object({
    schemaVersion: z.string().optional().nullable(),
    drugIdentity: z
      .object({
        preferredName: z.string().optional().nullable(),
        names: z
          .object({
            en: z.string().optional().nullable(),
            nb: z.string().optional().nullable(),
          })
          .passthrough()
          .optional()
          .nullable(),
        nameShort: z.string().optional().nullable(),
        aliases: z.array(z.string()).optional().nullable(),
        pubchemCid: z.number().optional().nullable(),
        molecularWeight: z.number().optional().nullable(),
      })
      .passthrough(),
    kinetixParameterValues: z.array(parameterValueInput).optional().nullable(),
    ionizationConstants: z
      .array(ionizationConstantInputSchema)
      .optional()
      .nullable(),
    pharmacodynamicTargets: z.array(pdTargetInput).optional().nullable(),
    metabolism: z
      .object({
        profileEvidenceNote: z.string().optional().nullable(),
        profileSourceIds: z.array(z.string()).optional().nullable(),
        eliminationRoutes: z.array(eliminationRouteInput).optional().nullable(),
        metabolites: z.array(metaboliteInput).optional().nullable(),
        enzymeInteractions: z.array(enzymeInteractionInput).optional().nullable(),
      })
      .passthrough()
      .optional()
      .nullable(),
    sources: z.array(sourceInput).optional().nullable(),
  })
  .passthrough();

// ─── Helpers ─────────────────────────────────────────────────────────────────

const CITATION_TYPES: readonly CitationType[] = ['freetext', 'url', 'pmid', 'doi'];
const PMID_RE = /^\d{1,8}$/;
const DOI_RE = /^10\.\d{4,}\/.+/;
const ELIMINATION_KINDS: readonly EliminationRouteKind[] = [
  'enzyme',
  'metabolized',
  'renal_unchanged',
  'fecal_biliary',
  'other_unchanged',
];
const METABOLITE_ACTIVITY = ['active', 'inactive', 'unknown'] as const;
const ENZYME_ROLES = ['substrate', 'inducer', 'inhibitor'] as const;
const ENZYME_STRENGTHS = ['weak', 'moderate', 'strong'] as const;
const PD_TIERS = ['primary', 'secondary', 'tertiary'] as const;

function trimOrNull(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function cleanSourceIds(ids: (string | null)[] | null | undefined): string[] {
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  for (const id of ids) {
    const t = trimOrNull(id);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function invalidCitationIdentifierWarning(
  sourceId: string,
  type: CitationType,
): string | null {
  if (type === 'url') {
    return `Source ${sourceId}: URL identifier must be an absolute http(s) URL; skipped.`;
  }
  if (type === 'pmid') {
    return `Source ${sourceId}: PubMed ID must be a positive integer up to 8 digits; skipped.`;
  }
  if (type === 'doi') {
    return `Source ${sourceId}: DOI must start with "10." and include a suffix; skipped.`;
  }
  return null;
}

function validateCitationIdentifier(
  type: CitationType,
  identifier: string,
  sourceId: string,
): string | null {
  if (type === 'url') {
    try {
      const parsed = new URL(identifier);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? null
        : invalidCitationIdentifierWarning(sourceId, type);
    } catch {
      return invalidCitationIdentifierWarning(sourceId, type);
    }
  }
  if (type === 'pmid' && !PMID_RE.test(identifier)) {
    return invalidCitationIdentifierWarning(sourceId, type);
  }
  if (type === 'doi' && !DOI_RE.test(identifier)) {
    return invalidCitationIdentifierWarning(sourceId, type);
  }
  return null;
}

function toNumericRange(
  raw: z.infer<typeof numericRangeInput> | null | undefined,
): ImportNumericRange | null {
  if (!raw) return null;
  const out: ImportNumericRange = {};
  for (const k of ['min', 'max', 'mean', 'median'] as const) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  const unit = trimOrNull(raw.unit);
  if (unit) out.unit = unit;
  if (out.min === undefined && out.max === undefined && out.mean === undefined && out.median === undefined) {
    return null;
  }
  return out;
}

function toFraction(v: number | null | undefined): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < 0 || v > 1) return null;
  return v;
}

/**
 * Derive a Kinetix citation (type + dedupe identifier + metadata) from a
 * research-output source object. Prefers the strongest resolvable identifier:
 * PMID > DOI > URL > free-text. `identifier` is what the (type, identifier)
 * unique index dedupes on, so it is normalized (lowercased DOI, bare PMID).
 */
export function citationFromSource(
  source: z.infer<typeof sourceInput>,
  index: number,
): { source: ImportSource } | { warning: string } {
  const declared = trimOrNull(source.citationType)?.toLowerCase();
  const pmid = trimOrNull(source.pmid);
  const doi = trimOrNull(source.doi);
  const url = trimOrNull(source.url);
  const identifierField = trimOrNull(source.identifier);
  const sourceId = trimOrNull(source.sourceId) ?? `S${index + 1}`;

  let type: CitationType | null =
    declared && (CITATION_TYPES as readonly string[]).includes(declared)
      ? (declared as CitationType)
      : null;
  let identifier: string | null = null;

  // Resolve identifier by strongest available handle, honouring the declared
  // type first when it carries a matching field.
  if (type === 'pmid' && (pmid || identifierField)) identifier = (pmid ?? identifierField)!;
  else if (type === 'doi' && (doi || identifierField)) identifier = (doi ?? identifierField)!;
  else if (type === 'url' && (url || identifierField)) identifier = (url ?? identifierField)!;
  else if (type === 'freetext') identifier = identifierField ?? trimOrNull(source.title);
  else if (pmid) { type = 'pmid'; identifier = pmid; }
  else if (doi) { type = 'doi'; identifier = doi; }
  else if (url) { type = 'url'; identifier = url; }
  else if (identifierField && declared) { type = (type ?? 'freetext'); identifier = identifierField; }
  else if (trimOrNull(source.title)) { type = 'freetext'; identifier = trimOrNull(source.title); }

  if (!type || !identifier) {
    return { warning: `Source ${sourceId}: no usable identifier (pmid/doi/url/title); skipped.` };
  }

  // One spelling per handle, shared with every other citation write path.
  identifier = normalizeHandleIdentifier(type, identifier);

  const invalidIdentifier = validateCitationIdentifier(type, identifier, sourceId);
  if (invalidIdentifier) {
    return { warning: invalidIdentifier };
  }

  const metadata: ImportCitationMetadata = {};
  const title = trimOrNull(source.title);
  const journal = trimOrNull(source.journalOrSource);
  if (title) metadata.title = title;
  if (Array.isArray(source.authors)) {
    const authors = source.authors.map((a) => a.trim()).filter(Boolean);
    if (authors.length) metadata.authors = authors;
  }
  if (journal) metadata.journal = journal;
  if (typeof source.year === 'number' && Number.isInteger(source.year)) metadata.year = source.year;

  // Everything else the source declared, so one paper stays one citation row
  // (#1018). A research source usually reports both a PMID and a DOI; the
  // strongest of them decides the row, the rest ride along as alt ids. An
  // unusable secondary handle is dropped rather than warned about — the source
  // already resolved through a valid one.
  const declaredAlt = normalizeAltIds({
    pmid: pmid ?? undefined,
    doi: doi ?? undefined,
    url: url ?? undefined,
  });
  for (const key of ['pmid', 'doi', 'url'] as const) {
    const value = declaredAlt[key];
    if (value && validateCitationIdentifier(key, value, sourceId)) {
      delete declaredAlt[key];
    }
  }

  // This is where "picks the strongest handle" actually happens: a source
  // declaring `citationType: "doi"` while also reporting a PMID is filed under
  // the PMID, because the DOI row and the PMID row would otherwise be two
  // independent papers as far as `paper_reviews` is concerned.
  const canonical = canonicalCitationHandle({ type, identifier }, declaredAlt);

  return {
    source: {
      sourceId,
      type: canonical.type,
      identifier: canonical.identifier,
      metadata: Object.keys(metadata).length ? metadata : null,
      altIds: canonical.altIds,
    },
  };
}

// ─── Main entry point ────────────────────────────────────────────────────────

/**
 * Validate and normalize a deep-research output document. Returns either the
 * normalized import (with a `warnings` list of non-fatal issues) or a list of
 * fatal structural errors.
 */
export function parseResearchOutput(raw: unknown): ParseResult {
  const parsed = rootInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
      ),
    };
  }
  const doc = parsed.data;
  const warnings: string[] = [];

  const schemaVersion = trimOrNull(doc.schemaVersion) ?? DEEP_RESEARCH_SCHEMA_VERSION;
  if (schemaVersion !== DEEP_RESEARCH_SCHEMA_VERSION) {
    warnings.push(
      `schemaVersion "${schemaVersion}" != expected "${DEEP_RESEARCH_SCHEMA_VERSION}"; parsed leniently.`,
    );
  }

  // ── Drug identity ──
  const id = doc.drugIdentity;
  const nameNb = trimOrNull(id.names?.nb);
  const nameEn = trimOrNull(id.names?.en) ?? trimOrNull(id.preferredName);
  if (!nameNb && !nameEn) {
    return { ok: false, errors: ['drugIdentity: at least one of names.nb / names.en / preferredName is required'] };
  }
  const pubchemCid =
    typeof id.pubchemCid === 'number' && Number.isInteger(id.pubchemCid) && id.pubchemCid > 0
      ? id.pubchemCid
      : null;
  const aliases = Array.isArray(id.aliases)
    ? [...new Set(id.aliases.map((a) => a.trim()).filter(Boolean))]
    : [];
  const molecularWeight =
    typeof id.molecularWeight === 'number' && id.molecularWeight > 0 ? id.molecularWeight : null;

  // ── Sources ──
  const sources: ImportSource[] = [];
  const seenSourceIds = new Set<string>();
  (doc.sources ?? []).forEach((s, i) => {
    const result = citationFromSource(s, i);
    if ('warning' in result) {
      warnings.push(result.warning);
      return;
    }
    if (seenSourceIds.has(result.source.sourceId)) {
      warnings.push(`Duplicate sourceId "${result.source.sourceId}"; keeping first.`);
      return;
    }
    seenSourceIds.add(result.source.sourceId);
    sources.push(result.source);
  });

  const knownSourceIds = new Set(sources.map((s) => s.sourceId));
  const filterSourceIds = (ids: string[], ctx: string): string[] => {
    const kept = ids.filter((sid) => {
      if (knownSourceIds.has(sid)) return true;
      warnings.push(`${ctx}: sourceId "${sid}" not found in sources[]; dropped.`);
      return false;
    });
    return kept;
  };

  // ── Parameters ──
  const parameters: ImportParameterValue[] = [];
  const seenParams = new Set<string>();
  for (const entry of doc.kinetixParameterValues ?? []) {
    const paramId = entry.parameter.trim();
    const status = trimOrNull(entry.status)?.toLowerCase() ?? 'finalized';
    if (status !== 'finalized') continue; // only finalized values are seeded
    if (!isDrugParameterId(paramId)) {
      warnings.push(`Parameter "${paramId}": not a known Kinetix parameter id; skipped.`);
      continue;
    }
    if (seenParams.has(paramId)) {
      warnings.push(`Parameter "${paramId}": duplicate finalized entry; keeping first.`);
      continue;
    }
    // Model-structure axes (CV-1b) are entry-backed: their value is a cited
    // `parameter_entries` declaration, never a hand-authored `drug_parameters`
    // row. This importer writes the latter, and the model-structure UI reads
    // only the former, so a value seeded here would be both unreviewed and
    // invisible. Skip it rather than smuggle it in; declaring a family from the
    // literature is its own (later) import path.
    if (isModelStructureParameter(paramId)) {
      warnings.push(
        `Parameter "${paramId}": model structure is declared as a cited entry, not seeded here; skipped.`,
      );
      continue;
    }
    // The dose-context authoring gate (Cmax dose-context RFC, release B):
    // registered so approvals can parse it, not yet creatable by any producer.
    // An entry-only parameter has no drug-level value for this importer to
    // seed either, so there is nothing else here it could write.
    if (parameterAuthoringGated(paramId)) {
      warnings.push(
        `Parameter "${paramId}": ${parameterAuthoringGatedMessage(paramId)}; skipped.`,
      );
      continue;
    }
    // An entry-only parameter (Cmax) has no drug-level value to seed: its
    // per-source readings ARE the parameter. A synthesized value is dropped
    // with a warning rather than written anywhere, and only the sourceValues
    // go through.
    if (!parameterHasDrugLevelValue(paramId)) {
      if (entry.value != null) {
        warnings.push(
          `Parameter "${paramId}": has no drug-level value; the synthesized value is ignored, only sourceValues are imported.`,
        );
      }
      const entryOnlyValues = normalizeSourceValues(
        paramId,
        entry.sourceValues,
        knownSourceIds,
        warnings,
      );
      if (entryOnlyValues.length === 0) {
        warnings.push(`Parameter "${paramId}": no usable sourceValues; skipped.`);
        continue;
      }
      seenParams.add(paramId);
      parameters.push({
        parameter: paramId,
        sourceIds: filterSourceIds(cleanSourceIds(entry.sourceIds), `Parameter "${paramId}"`),
        sourceValues: entryOnlyValues,
      });
      continue;
    }
    const sourceValues = normalizeSourceValues(
      paramId,
      entry.sourceValues,
      knownSourceIds,
      warnings,
    );

    const value = normalizeParameterValue(paramId, entry.value);
    if (value === undefined) {
      // v2: per-source values alone are a complete parameter — the aggregate is
      // computed from them after the import. Only a parameter with neither a
      // synthesized value nor a usable source value has nothing to write.
      if (sourceValues.length === 0) {
        warnings.push(`Parameter "${paramId}": missing value; skipped.`);
        continue;
      }
      seenParams.add(paramId);
      parameters.push({
        parameter: paramId,
        sourceIds: filterSourceIds(
          cleanSourceIds(entry.sourceIds),
          `Parameter "${paramId}"`,
        ),
        sourceValues,
      });
      continue;
    }
    const check = DRUG_PARAMETERS[paramId].zod.safeParse(value);
    if (!check.success) {
      const why = check.error.issues.map((iss) => iss.message).join('; ');
      // The source values were validated independently and are still good
      // evidence; a bad synthesis is not a reason to throw the papers away.
      if (sourceValues.length > 0) {
        warnings.push(
          `Parameter "${paramId}": synthesized value failed validation — ${why}; ` +
            `kept ${sourceValues.length} source value(s), aggregate computed from those.`,
        );
        seenParams.add(paramId);
        parameters.push({
          parameter: paramId,
          sourceIds: filterSourceIds(
            cleanSourceIds(entry.sourceIds),
            `Parameter "${paramId}"`,
          ),
          sourceValues,
        });
        continue;
      }
      warnings.push(`Parameter "${paramId}": value failed validation — ${why}; skipped.`);
      continue;
    }
    seenParams.add(paramId);
    parameters.push({
      parameter: paramId,
      value: check.data,
      sourceIds: filterSourceIds(cleanSourceIds(entry.sourceIds), `Parameter "${paramId}"`),
      sourceValues,
    });
  }

  const coverage = sourceValueCoverageWarning(thinlySourcedParameters(parameters, sources));
  if (coverage) warnings.push(coverage);

  // ── Ionization constants (structured pKa) ──
  const ionizationConstants = normalizeIonizationConstants(
    doc.ionizationConstants,
    filterSourceIds,
    warnings,
  );

  // ── Pharmacodynamic targets ──
  const pharmacodynamicTargets: ImportPdTarget[] = [];
  (doc.pharmacodynamicTargets ?? []).forEach((t, i) => {
    const symbol = trimOrNull(t.targetSymbol) ?? trimOrNull(t.targetName);
    if (!symbol) {
      warnings.push(`PD target #${i + 1}: no targetSymbol/targetName; skipped.`);
      return;
    }
    const tierRaw = trimOrNull(t.tier)?.toLowerCase();
    const tier = tierRaw && (PD_TIERS as readonly string[]).includes(tierRaw)
      ? (tierRaw as ImportPdTarget['tier'])
      : null;
    pharmacodynamicTargets.push({
      symbol: symbol.slice(0, 80),
      name: (trimOrNull(t.targetName) ?? symbol).slice(0, 200),
      interactionType: (trimOrNull(t.interactionType) ?? 'unspecified').slice(0, 60),
      tier,
      ki: toNumericRange(t.ki),
      ic50: toNumericRange(t.ic50),
      ec50: toNumericRange(t.ec50),
      emax: toNumericRange(t.emax),
      affinity: toNumericRange(t.affinity),
      potency: toNumericRange(t.potency),
      efficacy: toNumericRange(t.efficacy),
      selectivityRatio: toNumericRange(t.selectivityRatio),
      assaySpecies: trimOrNull(t.assaySpecies)?.slice(0, 80) ?? null,
      evidenceNote: trimOrNull(t.evidenceNote),
      sourceIds: filterSourceIds(cleanSourceIds(t.sourceIds), `PD target "${symbol}"`),
    });
  });

  // ── Metabolism ──
  const m = doc.metabolism;
  const eliminationRoutes: ImportEliminationRoute[] = [];
  const metabolites: ImportMetabolite[] = [];
  const enzymeInteractions: ImportEnzymeInteraction[] = [];

  (m?.eliminationRoutes ?? []).forEach((r, i) => {
    const kindRaw = trimOrNull(r.kind)?.toLowerCase();
    const kind = kindRaw && (ELIMINATION_KINDS as readonly string[]).includes(kindRaw)
      ? (kindRaw as EliminationRouteKind)
      : 'enzyme';
    const label = trimOrNull(r.enzymeOrEntitySymbol) ?? trimOrNull(r.label);
    if (!label) {
      warnings.push(`Elimination route #${i + 1}: no enzyme symbol/label; skipped.`);
      return;
    }
    eliminationRoutes.push({
      kind,
      label: label.slice(0, 200),
      fraction: toFraction(r.fraction),
      fractionMin: toFraction(r.fractionMin),
      fractionMax: toFraction(r.fractionMax),
      note: trimOrNull(r.note),
      sourceIds: filterSourceIds(cleanSourceIds(r.sourceIds), `Elimination route "${label}"`),
    });
  });

  (m?.metabolites ?? []).forEach((mb, i) => {
    const name = trimOrNull(mb.metaboliteName);
    if (!name) {
      warnings.push(`Metabolite #${i + 1}: no metaboliteName; skipped.`);
      return;
    }
    const activityRaw = trimOrNull(mb.activity)?.toLowerCase();
    const activity = activityRaw && (METABOLITE_ACTIVITY as readonly string[]).includes(activityRaw)
      ? (activityRaw as ImportMetabolite['activity'])
      : 'unknown';
    metabolites.push({
      name: name.slice(0, 300),
      activity,
      conversionFraction: toFraction(mb.conversionFraction),
      conversionFractionMin: toFraction(mb.conversionFractionMin),
      conversionFractionMax: toFraction(mb.conversionFractionMax),
      note: trimOrNull(mb.evidenceNote),
      sourceIds: filterSourceIds(cleanSourceIds(mb.sourceIds), `Metabolite "${name}"`),
    });
  });

  (m?.enzymeInteractions ?? []).forEach((ei, i) => {
    const symbol = trimOrNull(ei.enzymeOrEntitySymbol);
    const roleRaw = trimOrNull(ei.role)?.toLowerCase();
    if (!symbol) {
      warnings.push(`Enzyme interaction #${i + 1}: no enzyme symbol; skipped.`);
      return;
    }
    if (!roleRaw || !(ENZYME_ROLES as readonly string[]).includes(roleRaw)) {
      warnings.push(`Enzyme interaction "${symbol}": invalid role "${ei.role}"; skipped.`);
      return;
    }
    const strengthRaw = trimOrNull(ei.strength)?.toLowerCase();
    const strength = strengthRaw && (ENZYME_STRENGTHS as readonly string[]).includes(strengthRaw)
      ? (strengthRaw as ImportEnzymeInteraction['strength'])
      : null;
    enzymeInteractions.push({
      enzymeSymbol: symbol.slice(0, 80),
      role: roleRaw as ImportEnzymeInteraction['role'],
      strength,
      note: trimOrNull(ei.note),
      sourceIds: filterSourceIds(cleanSourceIds(ei.sourceIds), `Enzyme interaction "${symbol}"`),
    });
  });

  const metabolism: ImportMetabolism = {
    profileNote: trimOrNull(m?.profileEvidenceNote),
    profileSourceIds: filterSourceIds(cleanSourceIds(m?.profileSourceIds), 'Metabolism profile'),
    eliminationRoutes,
    metabolites,
    enzymeInteractions,
  };

  return {
    ok: true,
    data: {
      schemaVersion,
      drug: { nameNb, nameEn, nameShort: trimOrNull(id.nameShort), aliases, pubchemCid, molecularWeight },
      parameters,
      ionizationConstants,
      sources,
      pharmacodynamicTargets,
      metabolism,
      warnings,
    },
  };
}

/**
 * Validate and normalize `ionizationConstants[]`. Each entry becomes one
 * `drug_ionization_constants` row. Rules (dropped-with-a-warning, never fatal):
 *  - pKa finite and within the registry's physical band;
 *  - the net-charge transition must be two adjacent integers
 *    (`protonatedCharge === deprotonatedCharge + 1`) — a single deprotonation
 *    changes the charge by exactly one; when only one side is given the other
 *    is inferred;
 *  - `evidenceType` defaults to `predicted` when unstated/unrecognized, never
 *    `experimental` — the importer must not manufacture experimental provenance.
 */
function normalizeIonizationConstants(
  raw: z.infer<typeof ionizationConstantInputSchema>[] | null | undefined,
  filterSourceIds: (ids: string[], ctx: string) => string[],
  warnings: string[],
): ImportIonizationConstant[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  // Keyed by the reconciliation identity. The store keeps ONE row per identity
  // (0110's unique index), so two readings that share it are not "duplicates" to
  // discard but readings to AGGREGATE into that one row — the import contract:
  // repeated readings of the same transition aggregate, distinct ones stay
  // separate. Insertion order is preserved so the emitted list is deterministic.
  const groups = new Map<
    string,
    { base: ImportIonizationConstant; pKas: number[] }
  >();

  raw.forEach((c, i) => {
    const where = `Ionization constant #${i + 1}`;
    const pKaRaw = typeof c.pKa === 'number' && Number.isFinite(c.pKa) ? c.pKa : null;
    if (pKaRaw == null) {
      warnings.push(`${where}: no numeric pKa; skipped.`);
      return;
    }
    if (pKaRaw < PKA_MIN || pKaRaw > PKA_MAX) {
      warnings.push(
        `${where}: pKa ${pKaRaw} outside the allowed range (${PKA_MIN}–${PKA_MAX}); skipped.`,
      );
      return;
    }
    // Round to the storage column's precision (NUMERIC(6,3)) so a re-import
    // compares equal to the stored value — otherwise 8.1234 stores as 8.123 and
    // every subsequent run reports the constant as changed, breaking idempotency.
    const pKa = Math.round(pKaRaw * 1000) / 1000;

    const pRaw =
      typeof c.protonatedCharge === 'number' && Number.isInteger(c.protonatedCharge)
        ? c.protonatedCharge
        : null;
    const dRaw =
      typeof c.deprotonatedCharge === 'number' && Number.isInteger(c.deprotonatedCharge)
        ? c.deprotonatedCharge
        : null;
    let protonatedCharge: number | null = pRaw;
    let deprotonatedCharge: number | null = dRaw;
    // Infer the missing side of the pair; a deprotonation drops the charge by one.
    if (protonatedCharge == null && deprotonatedCharge != null) {
      protonatedCharge = deprotonatedCharge + 1;
    } else if (deprotonatedCharge == null && protonatedCharge != null) {
      deprotonatedCharge = protonatedCharge - 1;
    }
    if (protonatedCharge == null || deprotonatedCharge == null) {
      warnings.push(`${where}: missing charge transition; skipped.`);
      return;
    }
    if (protonatedCharge !== deprotonatedCharge + 1) {
      warnings.push(
        `${where}: charge transition ${protonatedCharge} → ${deprotonatedCharge} is not a ` +
          `single-proton dissociation (protonatedCharge must be deprotonatedCharge + 1); skipped.`,
      );
      return;
    }
    if (
      Math.abs(protonatedCharge) > CHARGE_ABS_MAX ||
      Math.abs(deprotonatedCharge) > CHARGE_ABS_MAX
    ) {
      warnings.push(`${where}: implausible net charge; skipped.`);
      return;
    }

    const transition = `${protonatedCharge}->${deprotonatedCharge}`;
    const evidenceRaw = trimOrNull(c.evidenceType)?.toLowerCase();
    const evidenceType: IonizationEvidenceType =
      evidenceRaw && (IONIZATION_EVIDENCE_TYPES as readonly string[]).includes(evidenceRaw)
        ? (evidenceRaw as IonizationEvidenceType)
        : 'predicted';
    if (!evidenceRaw) {
      warnings.push(
        `${where}: evidenceType unstated; recorded as "predicted" (an import never claims experimental provenance).`,
      );
    } else if (evidenceType !== evidenceRaw) {
      warnings.push(
        `${where}: unknown evidenceType "${c.evidenceType}"; recorded as "predicted".`,
      );
    }

    // `type` defaults to macroscopic ONLY when omitted. An explicit but
    // unrecognized value (a typo like "microsopic") is skipped, never coerced to
    // macroscopic: the population math trusts macroscopic constants, so silently
    // promoting a mistyped microscopic value would feed a microstate pKa into
    // derived logD and iPMR as if it governed the whole charge state.
    const typeRaw = trimOrNull(c.type)?.toLowerCase();
    if (typeRaw && !(IONIZATION_CONSTANT_TYPES as readonly string[]).includes(typeRaw)) {
      warnings.push(
        `${where}: unrecognized type "${c.type}" (expected macroscopic/microscopic); skipped.`,
      );
      return;
    }
    const type: IonizationConstantType = (typeRaw as IonizationConstantType) ?? 'macroscopic';
    // Canonicalize the temperature to the storage column's precision
    // (NUMERIC(5,2)) BEFORE it enters the reconciliation identity. Postgres
    // rounds 25.125 → 25.13 on write, so an un-rounded key would never match the
    // stored row on the next import and would insert a duplicate. Out-of-range
    // temperatures are dropped (the constant is still useful without one).
    let temperatureC: number | null = null;
    if (typeof c.temperatureC === 'number' && Number.isFinite(c.temperatureC)) {
      if (c.temperatureC < -999.99 || c.temperatureC > 999.99) {
        warnings.push(
          `${where}: temperature ${c.temperatureC}°C is out of range; dropped the temperature.`,
        );
      } else {
        temperatureC = Math.round(c.temperatureC * 100) / 100;
      }
    }
    const medium = trimOrNull(c.medium)?.slice(0, 120) ?? null;
    const siteLabel = trimOrNull(c.siteLabel)?.slice(0, 120) ?? null;

    // Group on the SAME identity the store reconciles on
    // (`seedIonizationConstants.reconcileKey`): the transition plus the
    // qualifiers that make two rows genuinely distinct measurements — evidence
    // tier, macro/microscopic type, site, medium and temperature. Two constants
    // for one transition measured in different media, or two microscopic
    // constants at different sites, stay separate; two readings that match on
    // ALL of these are the same measurement and are aggregated below.
    const groupKey = [
      transition,
      evidenceType,
      type,
      (siteLabel ?? '').toLowerCase(),
      (medium ?? '').toLowerCase(),
      temperatureC ?? '',
    ].join('\0');
    const note = trimOrNull(c.note);
    const sourceIds = filterSourceIds(cleanSourceIds(c.sourceIds), where);

    const existing = groups.get(groupKey);
    if (existing) {
      // Same measurement, another paper: union the provenance and pool the value
      // for a deterministic aggregate, rather than dropping the second reading.
      existing.pKas.push(pKa);
      for (const sid of sourceIds) {
        if (!existing.base.sourceIds.includes(sid)) existing.base.sourceIds.push(sid);
      }
      // Keep every distinct caveat, not just the first — a later reading's note
      // qualifies the pooled value as much as the earlier one's.
      if (note) {
        const parts = existing.base.note
          ? existing.base.note.split('; ').map((p) => p.trim())
          : [];
        if (!parts.includes(note)) {
          existing.base.note = existing.base.note ? `${existing.base.note}; ${note}` : note;
        }
      }
      return;
    }
    groups.set(groupKey, {
      base: {
        pKa,
        protonatedCharge,
        deprotonatedCharge,
        type,
        evidenceType,
        siteLabel,
        temperatureC,
        medium,
        note,
        sourceIds: [...sourceIds],
      },
      pKas: [pKa],
    });
  });

  // Collapse each identity group to one row: the median of its readings
  // (re-rounded to the storage precision), with the pooled provenance.
  return [...groups.values()].map(({ base, pKas }) => ({
    ...base,
    pKa: pKas.length > 1 ? Math.round(medianOf(pKas) * 1000) / 1000 : base.pKa,
  }));
}

/** Median of a non-empty numeric list; order-independent. */
function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

/**
 * The source-value-backed parameters in an import that are backed by readings
 * from fewer than `MIN_SOURCES_PER_PARAMETER` distinct papers, with the number
 * of distinct papers each one has.
 *
 * Counted per *paper*, not per reading: two readings a paper reports for two
 * populations are two rows in the pool but still one paper, and pooling them
 * says nothing about whether the literature agrees. Parameters that are not
 * entry-backed (`analyteStability` — a matrix-specific value that is
 * deliberately not pooled) are exempt, as are parameters the document did not
 * finalize at all: this reports thin evidence, not absent evidence.
 *
 * Nor is a `sourceId` a paper. Two entries in `sources[]` can be the same
 * article — the same DOI twice, or one declaring the PMID and the other the DOI
 * — and `resolveCitation` will file them in one `citations` row, so counting
 * ids would let a single paper clear the threshold. Sources are therefore
 * folded together by the handles they carry first (see
 * `sourceIdsToPaperKeys`). A pair whose declared handles do not overlap at all
 * is known to be one paper only to NCBI's ID converter, whose lookup is
 * asynchronous and cannot happen inside a pure validator — pass its answer as
 * `crosswalk` (`resolveImportCrosswalk`, keyed by `sourceId`) to fold those too.
 * The write paths do exactly that through {@link recountSourceValueCoverage};
 * the admin preview never resolves a crosswalk, so its count is the one this
 * document can establish on its own.
 */
export function thinlySourcedParameters(
  parameters: ImportParameterValue[],
  sources: ImportSource[] = [],
  crosswalk: ReadonlyMap<string, CitationAltIds> = new Map(),
): { parameter: DrugParameterId; sources: number }[] {
  const paperKey = sourceIdsToPaperKeys(sources, crosswalk);
  return parameters
    .filter(
      (p) =>
        (SUMMARIZED_PARAMETER_IDS as readonly string[]).includes(p.parameter) ||
        (ENTRY_ONLY_PARAMETER_IDS as readonly string[]).includes(p.parameter),
    )
    .map((p) => ({
      parameter: p.parameter,
      sources: new Set(p.sourceValues.map((sv) => paperKey.get(sv.sourceId) ?? sv.sourceId)).size,
    }))
    .filter((p) => p.sources < MIN_SOURCES_PER_PARAMETER);
}

/**
 * How a source-value-coverage warning starts. Exported because the write paths
 * recompute the warning after the crosswalk and have to replace the parse-time
 * one rather than print a second, quieter count beside it.
 */
export const SOURCE_VALUE_COVERAGE_PREFIX = 'Source-value coverage:';

/** The operator-facing line for a coverage shortfall; `null` when there is none. */
export function sourceValueCoverageWarning(
  thin: { parameter: DrugParameterId; sources: number }[],
): string | null {
  if (thin.length === 0) return null;
  return (
    `${SOURCE_VALUE_COVERAGE_PREFIX} ${thin.length} parameter(s) carry readings from fewer ` +
    `than ${MIN_SOURCES_PER_PARAMETER} independent papers — ` +
    `${thin.map((t) => `${t.parameter} (${t.sources})`).join(', ')}. ` +
    'Kinetix recomputes each of these values from its per-source readings, so a ' +
    'single-paper parameter shows an aggregate of that one paper (sources that share ' +
    'a handle are one paper here, as they will be one citation row). Seed a second ' +
    'independent reading where the literature has one; where it genuinely does not, ' +
    "say so in the reading's comments."
  );
}

/**
 * The document's warnings with the coverage line recomputed against a resolved
 * crosswalk — what the write paths report instead of `data.warnings`.
 *
 * `parseResearchOutput` can only fold sources the document itself links. Once
 * `resolveImportCrosswalk` has answered, two entries the ID converter placed on
 * one article are known to be one paper, and the count taken at parse time can
 * be an over-count: it may have said the threshold was met for a parameter that
 * reaches the database backed by a single citation row. The write paths hold
 * that answer before `runImport`, so they can report the count that matches
 * what was actually written. The parse-time line is replaced, never appended
 * to — two coverage lines disagreeing would leave the operator to guess which
 * one describes their import.
 */
export function recountSourceValueCoverage(
  data: NormalizedResearchImport,
  crosswalk: ReadonlyMap<string, CitationAltIds>,
): string[] {
  const warnings = data.warnings.filter((w) => !w.startsWith(SOURCE_VALUE_COVERAGE_PREFIX));
  const coverage = sourceValueCoverageWarning(
    thinlySourcedParameters(data.parameters, data.sources, crosswalk),
  );
  return coverage ? [...warnings, coverage] : warnings;
}

/**
 * Map each `sourceId` to a key shared by every source that is the same paper.
 *
 * Two sources are the same paper when any handle they carry matches — the row
 * each is filed under (`type`/`identifier`, already normalized by
 * `citationFromSource`), any of the alternates it declared, the identifier a
 * resolver URL wraps (`https://doi.org/10.x/y` is the DOI `10.x/y`, a PubMed
 * article URL is its PMID), or the handles NCBI's ID converter returned for it,
 * when the caller has them. Matching is transitive: a source filed under a PMID
 * and one filed under a DOI are folded together by a third that declares both,
 * exactly as `resolveCitation` would fold them at write time. Keys are opaque;
 * only equality means anything.
 */
function sourceIdsToPaperKeys(
  sources: ImportSource[],
  crosswalk: ReadonlyMap<string, CitationAltIds>,
): Map<string, string> {
  // Union-find over sourceIds, joined through the handles they share.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression, so a long chain of shared handles stays cheap.
    let walk = id;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk)!;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootA, rootB);
  };

  // A handle contributes its own key and, for a resolver URL, the key of the
  // identifier it wraps: `https://doi.org/10.x/y` and a bare `10.x/y` are one
  // paper, and the crosswalk unwraps them the same way before writing.
  const keysFor = (kind: string, identifier: string): string[] => {
    const keys = [`${kind}:${identifier}`];
    const unwrapped = kind === 'url' ? resolverHandleFromUrl(identifier) : null;
    if (unwrapped) keys.push(`${unwrapped.type}:${unwrapped.identifier}`);
    return keys;
  };

  for (const s of sources) parent.set(s.sourceId, s.sourceId);
  const claimedBy = new Map<string, string>();
  for (const s of sources) {
    const resolved = crosswalk.get(s.sourceId);
    const handles = [
      ...keysFor(s.type, s.identifier),
      ...(['pmid', 'doi', 'pmcid', 'url'] as const).flatMap((kind) => [
        ...(s.altIds[kind] ? keysFor(kind, s.altIds[kind]!) : []),
        ...(resolved?.[kind] ? keysFor(kind, resolved[kind]!) : []),
      ]),
    ];
    for (const handle of handles) {
      const owner = claimedBy.get(handle);
      if (owner) union(owner, s.sourceId);
      else claimedBy.set(handle, s.sourceId);
    }
  }
  return new Map(sources.map((s) => [s.sourceId, find(s.sourceId)]));
}

/**
 * Validate and normalize a parameter's `sourceValues[]` — the per-source
 * readings that become `parameter_entries` rows.
 *
 * Everything is dropped-with-a-warning rather than fatal, matching how the rest
 * of the document is handled: one mis-stated unit should not cost the operator
 * the whole seed run. The rules themselves are NOT restated here — they come
 * from `parameterEntrySourceValueSchema`, so an imported entry has to clear the
 * same registry bar (allowed unit, canonical-unit bounds, matrix required only
 * where it is meaningful, median inside low..high, censored values single-valued)
 * as one a curator adds by hand.
 */
function normalizeSourceValues(
  parameter: DrugParameterId,
  raw: z.infer<typeof sourceValueInput>[] | null | undefined,
  knownSourceIds: Set<string>,
  warnings: string[],
): ImportParameterSourceValue[] {
  if (!raw || raw.length === 0) return [];
  const ctx = `Parameter "${parameter}"`;

  if (
    !(SUMMARIZED_PARAMETER_IDS as readonly string[]).includes(parameter) &&
    !(ENTRY_ONLY_PARAMETER_IDS as readonly string[]).includes(parameter)
  ) {
    warnings.push(
      `${ctx}: not a source-entry-backed parameter; ${raw.length} sourceValues dropped ` +
        `(its value is authored, not pooled from sources).`,
    );
    return [];
  }

  const out: ImportParameterSourceValue[] = [];
  raw.forEach((sv, i) => {
    const where = `${ctx} sourceValue #${i + 1}`;
    const sourceId = trimOrNull(sv.sourceId);
    if (!sourceId) {
      warnings.push(`${where}: no sourceId; dropped.`);
      return;
    }
    if (!knownSourceIds.has(sourceId)) {
      warnings.push(`${where}: sourceId "${sourceId}" not found in sources[]; dropped.`);
      return;
    }
    const candidate = {
      parameter,
      ...numOrOmit('low', sv.low),
      ...numOrOmit('high', sv.high),
      ...numOrOmit('median', sv.median),
      ...strOrOmit('qualifier', sv.qualifier),
      unit: trimOrNull(sv.unit) ?? '',
      ...strOrOmit('matrix', sv.matrix),
      ...strOrOmit('scenario', sv.scenario),
      ...numOrOmit('n', sv.n),
      ...strOrOmit('comments', sv.comments),
      // NOT `strOrOmit`, for the same reason as `quote` below: an absent
      // observationContext must stay absent so a re-import preserves what is
      // stored, while an explicit null has to survive as an instruction to
      // clear it.
      ...(sv.observationContext === undefined
        ? {}
        : {
            observationContext:
              sv.observationContext === null
                ? null
                : (trimOrNull(sv.observationContext) ?? null),
          }),
      // NOT `strOrOmit`: that helper drops null and undefined alike, which is
      // right for fields where both mean "unset" and wrong here. An absent
      // quote must stay absent so a re-import preserves what is stored, while
      // an explicit null has to survive as the document's instruction to clear.
      ...(sv.quote === undefined
        ? {}
        : { quote: sv.quote === null ? null : (trimOrNull(sv.quote) ?? null) }),
      // Structured dose context (Cmax dose-context RFC), carried through as
      // the document states it. The two drug references are NOT: a document
      // cannot know this catalog's internal ids. The imported reading is
      // recorded as self-administered — the importer writes the drug's own
      // id — and a metabolite reading measured after dosing another substance
      // has to be authored where that substance can be named.
      ...doseContextFromDocument(sv as Record<string, unknown>),
    };
    const doseContextRequired = parameterDoseContextMode(parameter) === 'required';
    // Validated as the self-administered reading it will be stored as; the
    // placeholder id stands in for the drug the importer resolves at write
    // time, and is not kept.
    const check = parameterEntrySourceValueSchema.safeParse(
      doseContextRequired ? { ...candidate, administeredDrugId: 1 } : candidate,
    );
    if (!check.success) {
      warnings.push(
        `${where} (${sourceId}): ${check.error.issues
          .map((iss) => iss.message)
          .join('; ')}; dropped.`,
      );
      return;
    }
    const { parameter: _p, administeredDrugId: _a, ...fields } = check.data;
    out.push({ sourceId, ...fields } as ImportParameterSourceValue);
  });
  return out;
}

/**
 * The dose-context fields a research document states for one source value,
 * minus the two drug references (see the caller). Absent and null alike are
 * left out: a document's silence is "not recorded", which is what the column
 * holds by default.
 */
function doseContextFromDocument(sv: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of DOSE_CONTEXT_FIELD_KEYS) {
    if (key === 'administeredDrugId' || key === 'interactingDrugId') continue;
    const value = sv[key];
    if (value !== undefined && value !== null) {
      out[key] = typeof value === 'string' ? value.trim() : value;
    }
  }
  return out;
}

/** `{key: value}` when the input is a usable number, `{}` otherwise. */
function numOrOmit(key: string, v: number | null | undefined) {
  return typeof v === 'number' && Number.isFinite(v) ? { [key]: v } : {};
}

/** `{key: trimmed}` when the input is a non-empty string, `{}` otherwise. */
function strOrOmit(key: string, v: string | null | undefined) {
  const trimmed = trimOrNull(v);
  return trimmed ? { [key]: trimmed } : {};
}

/**
 * Normalize a research-output parameter `value` into the exact shape the
 * parameter's zod schema expects, before validation:
 *  - number/list/text kinds pass through (their zod does the checking);
 *  - range-shaped kinds drop null fields and, for a dimensionless scalar
 *    (pKa/logP/logD — `allowedUnits: []`), strip any `unit` the agent added
 *    (the registry rejects a unit string there, it must be omitted).
 * Returns `undefined` when the value is absent so the caller can skip it.
 */
export function normalizeParameterValue(
  parameter: DrugParameterId,
  value: unknown,
): unknown {
  if (value === null || value === undefined) return undefined;
  const spec = DRUG_PARAMETERS[parameter];

  // A model-structure axis (CV-1b) is entry-backed, not authored: it must never
  // be written to `drug_parameters` from an import. The caller already skips
  // these ids with a specific warning; returning undefined here is the
  // defensive backstop for any other path that reaches this function.
  if (spec.kind === 'enum') return undefined;

  if (
    spec.kind === 'number' ||
    spec.kind === 'text' ||
    spec.kind === 'list'
  ) {
    return value;
  }

  // Range family: {min,max,mean,median,unit,qualifier,note}
  if (typeof value !== 'object' || Array.isArray(value)) return value;
  const v = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['min', 'max', 'mean', 'median'] as const) {
    if (typeof v[k] === 'number' && Number.isFinite(v[k] as number)) out[k] = v[k];
  }
  // Dimensionless scalars must omit `unit` entirely; a stray "unitless"/""
  // string would fail the registry's `z.undefined()` unit guard.
  if (spec.allowedUnits.length > 0 && typeof v.unit === 'string' && v.unit.trim()) {
    out.unit = v.unit.trim();
  }
  if (typeof v.qualifier === 'string' && v.qualifier.trim()) out.qualifier = v.qualifier.trim();
  if (typeof v.note === 'string' && v.note.trim()) out.note = v.note.trim().slice(0, 500);
  return out;
}
