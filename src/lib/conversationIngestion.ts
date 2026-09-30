/**
 * Conversation-to-Kinetix ingestion — the portable `kinetix-conversation-ingestion-v1`
 * contract and its validator.
 *
 * A chat assistant running the `kinetix` skill (`.claude/skills/kinetix/SKILL.md`)
 * turns the scientifically reusable part of a conversation into ONE bundle of
 * independently verified, de-identified proposals. This module is the pure,
 * DB-free definition of that bundle plus the checker an operator runs before the
 * JSON goes anywhere (`npm run validate:ingestion`).
 *
 * Why the schema is strict where the deep-research importer is permissive:
 * `parseResearchOutput` normalizes a document produced by a *pinned* research
 * prompt, so a stray key is noise. This bundle is produced by an unpinned model
 * in someone else's chat window, which — left unconstrained — invents a plausible
 * shape instead of the real one (`{"kinetix_import_version": "1.0", "action":
 * "upsert_wiki_content", …}` is a real observed output). A strict envelope turns
 * that silent divergence into a first-line error naming the offending key.
 *
 * Design notes:
 *  - Parameter observations validate through the SAME registry rules the write
 *    routes use (`validateEntryForParameter`, `validateEntryValueInvariants`), so
 *    a bundle that passes here cannot be rejected later for a unit, bound,
 *    matrix or scenario the app would have caught.
 *  - Nothing here writes, resolves a target, or decides a disposition. Only
 *    Kinetix classifies an item as auto_add / review_required / noop / rejected;
 *    the bundle carries no disposition field at all so a model cannot assert one.
 *  - Every fatal problem is an `error`; anything an operator should look at but
 *    which does not make the bundle unusable is a `warning`.
 *  - Pure and synchronous, so the unit suite needs no database.
 */
import { z } from 'zod';
import {
  MONOGRAPH_SECTION_IDS,
  type MonographSectionId,
} from './monographSections.js';
import {
  sourceQuoteSchema,
  validateEntryForParameter,
  validateEntryValueInvariants,
} from './parameterEntries.js';
import { parameterUnitFamily } from './parameterUnits.js';
import {
  ENTRY_ONLY_PARAMETER_IDS,
  getRangeSpec,
  parameterDoseContextMode,
  SUMMARIZED_PARAMETER_IDS,
  type DrugParameterId,
} from './drugParameters.js';
import { canonicalizeReportedStatistic, doseContextShape } from './entryDoseContext.js';
import { ROUTE_IDS } from './kinetics-core/index.js';
import {
  referenceMatrixSchema,
  referenceScenarioSchema,
} from './referenceConcentrations.js';
import { QUALIFIER_OPERATORS } from '../types/index.js';
import {
  canonicalCitationHandle,
  normalizeAltIds,
  normalizeHandleIdentifier,
  resolverHandleFromUrl,
  type CitationAltIds,
} from './citationHandles.js';

/** The one schema version this validator understands. */
export const CONVERSATION_INGESTION_SCHEMA_VERSION =
  'kinetix-conversation-ingestion-v1';

/** Invocation modes the skill supports. `json`/`dry-run` are output modes, not bundle modes. */
export const INGESTION_MODES = [
  'auto',
  'parameters',
  'wiki',
  'monograph',
] as const;
export type IngestionMode = (typeof INGESTION_MODES)[number];

/**
 * Citation kinds a bundle may cite. `freetext` is deliberately absent: a paper
 * review — which every committed item depends on — requires a resolvable
 * citation (`api/paper-reviews.ts` refuses `type === 'freetext'`), so a freetext
 * source could never satisfy the reference gate. A claim whose only support is
 * unresolvable belongs in `blockedCandidates`.
 */
export const INGESTION_SOURCE_TYPES = ['pmid', 'doi', 'url'] as const;
export type IngestionSourceType = (typeof INGESTION_SOURCE_TYPES)[number];

/** Wiki page kinds a fact can target. */
export const INGESTION_PAGE_TYPES = ['monograph', 'topic'] as const;
export type IngestionPageType = (typeof INGESTION_PAGE_TYPES)[number];

/** How a reported value was arrived at. Only `reported` is a direct reading. */
export const DERIVATION_KINDS = [
  'reported',
  'digitized',
  'calculated',
  'modeled',
  'inferred',
] as const;
export type DerivationKind = (typeof DERIVATION_KINDS)[number];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IngestionSourceVerification {
  /** Attestation that the relevant full text was actually read, not just the abstract. */
  readInFull: boolean;
  /** Exact evidence locator: "Table 2, p. 501", "Fig 3B", "§5.2 of the SmPC". */
  locator: string;
  /** Concise paraphrase of what the source reports at that locator. */
  evidenceSummary: string;
  /** Substantive appraisal, stored as the Kinetix paper review. */
  reviewMarkdown: string;
  reviewConfidence?: 'high' | 'medium' | 'low';
  conclusionSupport?: string;
  overallScore?: number;
}

export interface IngestionSource {
  /** Bundle-local handle (e.g. "S1") that items cite. Never a Kinetix ID. */
  key: string;
  type: IngestionSourceType;
  identifier: string;
  /** Other handles the same paper declares; kept for crosswalk/dedupe. */
  altIds: CitationAltIds;
  metadata: {
    title?: string;
    authors?: string[];
    journal?: string;
    year?: number;
  } | null;
  verification: IngestionSourceVerification;
  /** True when full text could not be obtained and a PDF request should be filed. */
  pdfRequestNeeded: boolean;
}

/** Study context preserved alongside a parameter observation. */
export interface IngestionStudyContext {
  analyte?: string;
  saltOrForm?: string;
  route?: string;
  formulation?: string;
  dose?: string;
  regimen?: string;
  population?: string;
  species?: string;
  studyDesign?: string;
  studyArm?: string;
  samplingWindow?: string;
  model?: string;
  analyticalMethod?: string;
  postmortemContext?: string;
  derivation?: {
    kind: DerivationKind;
    equation?: string;
    assumptions?: string;
    uncertainty?: string;
  };
}

/**
 * How a bundle names the drug it means. A chat model has no way to know a
 * Kinetix `drugId`, so identity is normally carried as name + PubChem CID and
 * resolved server-side; `drugId` exists only for the case where the operator
 * (or a future context tool) supplied a confirmed one.
 */
export interface IngestionDrugTarget {
  drugId?: number;
  pubchemCid?: number;
  /** Preferred name as used in the source, for human confirmation of the match. */
  drugName: string;
}

export interface IngestionParameterItem {
  type: 'parameter_observation';
  target: IngestionDrugTarget;
  parameter: string;
  low?: number;
  high?: number;
  median?: number;
  qualifier?: string;
  unit: string;
  matrix?: string;
  scenario?: string;
  n?: number;
  /** Exactly one source: an observation is one paper's reading of one arm. */
  sourceKey: string;
  context: IngestionStudyContext;
  comments?: string;
  /**
   * The verbatim text this observation's value was read off — the sentence,
   * table cell or caption in the cited paper. Optional, for the same reason it
   * is optional on a direct entry write: a bundle assembled before the field
   * existed must still apply. Recording it is what lets somebody check the
   * number against the source later without re-reading the paper.
   */
  quote?: string;
  /**
   * Structured dose context, for a dose-context parameter (Cmax). See
   * `doseContextInput`: the drug references name substances like `target`
   * does and are resolved at import; an omitted administered drug is the
   * target itself.
   */
  doseContext?: IngestionDoseContext;
  editSummary: string;
}

export interface IngestionWikiFactItem {
  type: 'wiki_fact';
  target: {
    pageType: IngestionPageType;
    pageId?: number;
    /** For `pageType: 'monograph'` — the drug whose monograph is meant. */
    drug?: IngestionDrugTarget;
    pageSlug?: string;
    sectionId: string;
    /** Page revision observed while preparing, so a stale target is detectable. */
    observedRevisionId?: number;
  };
  operation: 'add' | 'replace' | 'remove';
  /** Required for replace/remove; forbidden for add. Minted server-side. */
  factId?: string;
  /** One atomic, independently contestable statement. Omitted for `remove`. */
  statement?: string;
  sourceKeys: string[];
  editSummary: string;
}

export interface IngestionTopicPageItem {
  type: 'topic_page_proposal';
  titleNb: string;
  titleEn?: string;
  slug: string;
  parentSlug?: string;
  categories: string[];
  sections: Array<{
    sectionId: string;
    titleNb: string;
    facts: Array<{ statement: string; sourceKeys: string[] }>;
  }>;
  /** Why no existing page fits — a new page is the last resort, not the default. */
  rationale: string;
}

export type IngestionItem =
  | IngestionParameterItem
  | IngestionWikiFactItem
  | IngestionTopicPageItem;

/**
 * A claim the conversation raised that could NOT be verified to the standard the
 * contract requires. Carrying it explicitly is the point: without this slot a
 * model either drops the finding silently or smuggles it in as a fact.
 */
export interface IngestionBlockedCandidate {
  summary: string;
  /** What is missing: no full text, no resolvable source, ambiguous target, … */
  blocker: string;
  /** Best candidate source handle, if one was found at all. */
  candidateIdentifier?: string;
}

export interface NormalizedConversationIngestion {
  schemaVersion: typeof CONVERSATION_INGESTION_SCHEMA_VERSION;
  idempotencyKey: string;
  mode: IngestionMode;
  /** Opaque digest of the originating conversation. Never the conversation itself. */
  conversationDigest: string;
  createdAt: string;
  sources: IngestionSource[];
  items: IngestionItem[];
  blockedCandidates: IngestionBlockedCandidate[];
}

/**
 * A warning as a stable code plus its specifics.
 *
 * Warnings fire on VALID bundles in ordinary use — every topic-page proposal
 * carries one — so unlike the fatal errors, which only appear when a document is
 * malformed and name JSON paths, they are app chrome a Norwegian admin reads
 * routinely. Carrying the code lets the pane translate; `renderWarning` keeps
 * one English rendering for the CLI, so both come from a single definition.
 */
export interface IngestionWarning {
  code: IngestionWarningCode;
  /** Where in the bundle, e.g. `items[2]`. An address, never translated. */
  where: string;
  params: Record<string, string | number>;
}

export type IngestionWarningCode =
  | 'full_date'
  | 'drug_name_only'
  | 'derivation_no_assumptions'
  | 'no_derivation'
  | 'no_sample_size'
  | 'unit_not_convertible'
  | 'single_source'
  | 'remove_with_sources'
  | 'no_observed_revision'
  | 'statement_multi_sentence'
  | 'new_topic_page'
  | 'source_uncited'
  | 'item_unverified_sources'
  | 'pdf_request_with_read_in_full';

/** The English rendering. The pane translates from the code; the CLI uses this. */
export function renderWarning(warning: IngestionWarning): string {
  const p = warning.params;
  const at = warning.where;
  switch (warning.code) {
    case 'full_date':
      return `${at}: contains a day-precision date; confirm it is not an incident or sampling date`;
    case 'drug_name_only':
      return `${at}: drug identified by name only ("${p.name}") — add pubchemCid so the match is not left to a name lookup`;
    case 'derivation_no_assumptions':
      return `${at}: derivation.kind is "${p.kind}" but no assumptions are recorded`;
    case 'no_derivation':
      return `${at}: no context.derivation — state whether the value is reported, digitized, calculated, modeled or inferred`;
    case 'no_sample_size':
      return `${at}: no sample size (n)`;
    case 'unit_not_convertible':
      return `${at}: ${p.parameter} for ${p.drug} is reported in "${p.unit}", which does not convert to the parameter's canonical "${p.canonicalUnit}" — no observation in this unit reaches the aggregate, so however many sources back it the pool stays empty`;
    case 'single_source':
      return `${at}: ${p.label} rests on a single source (${p.cited})${p.spread} — a parameter needs at least two independent sources; add a corroborating observation or move it to blockedCandidates`;
    case 'remove_with_sources':
      return `${at}: sourceKeys on a remove operation are evidence that the existing fact is wrong — make sure the editSummary says so`;
    case 'no_observed_revision':
      return `${at}: no observedRevisionId — a ${p.operation} cannot be checked for staleness`;
    case 'statement_multi_sentence':
      return `${at}: statement looks like more than one sentence — split compound prose into separate atomic facts`;
    case 'new_topic_page':
      return `${at}: a new topic page always requires human review — confirm no existing page fits (${p.rationale})`;
    case 'source_uncited':
      return `${at}: declared but never cited by an item`;
    case 'item_unverified_sources':
      return `${at}: cites ${p.keys}, which ${p.count === 1 ? 'was' : 'were'} not read in full — Kinetix will queue this fact for human review instead of publishing it`;
    case 'pdf_request_with_read_in_full':
      return `${at}: pdfRequestNeeded with readInFull: true — a PDF request implies the full text was NOT available`;
  }
}

/**
 * A fatal problem as a stable code plus its specifics.
 *
 * These appear only on a malformed bundle, which is why they were left as prose
 * for three rounds — but AGENTS.md names "validation message" outright, and a
 * Norwegian admin who pastes a bad document is still reading app chrome. Same
 * shape as the warnings: one definition, rendered to English for the CLI and
 * translated from the code in the pane.
 *
 * `schema_invalid` is the exception that proves the rule. Zod's own text
 * ("String must contain at most 40 character(s)") is library English about a
 * schema, and inventing thirty locale keys to paraphrase it would be a
 * translation of the wrong thing; the frame around it is translated and the
 * technical remainder is quoted as data.
 */
export interface IngestionError {
  code: IngestionErrorCode;
  where: string;
  params: Record<string, string | number>;
}

export type IngestionErrorCode =
  | 'impostor_shape'
  | 'forbidden_key'
  | 'national_id'
  | 'schema_invalid'
  | 'invalid_pmid'
  | 'invalid_doi'
  | 'invalid_url'
  | 'value_bounds'
  | 'registry_rejected'
  | 'remove_with_statement'
  | 'statement_required'
  | 'source_key_required'
  | 'add_with_fact_id'
  | 'fact_id_required'
  | 'unknown_monograph_section'
  | 'monograph_target_required'
  | 'topic_target_required'
  | 'duplicate_source_key'
  | 'undeclared_source_key'
  | 'source_verification_conflict'
  | 'source_not_read_in_full'
  | 'item_type_not_in_mode'
  | 'monograph_mode_topic_fact'
  | 'empty_bundle';

/** The English rendering. The pane translates from the code; the CLI uses this. */
export function renderError(error: IngestionError): string {
  const p = error.params;
  const at = error.where;
  switch (error.code) {
    case 'impostor_shape':
      return String(p.message);
    case 'forbidden_key':
      return `${at}: forbidden key "${p.key}" — a bundle must not carry the conversation or case-identifying data`;
    case 'national_id':
      return `${at}: looks like a national identity number — remove it before submitting`;
    case 'schema_invalid':
      return `${at}: ${p.message}`;
    case 'invalid_pmid':
      return `${at}: "${p.identifier}" is not a valid PMID`;
    case 'invalid_doi':
      return `${at}: "${p.identifier}" is not a valid DOI`;
    case 'invalid_url':
      return `${at}: "${p.identifier}" is not a valid http(s) URL`;
    case 'value_bounds':
    case 'registry_rejected':
      return `${at}: ${p.message}`;
    case 'remove_with_statement':
      return `${at}: a remove operation must not carry a statement`;
    case 'statement_required':
      return `${at}: operation "${p.operation}" requires a statement`;
    case 'source_key_required':
      return `${at}: operation "${p.operation}" requires at least one sourceKey`;
    case 'add_with_fact_id':
      return `${at}: an add operation must not carry a factId — fact IDs are minted by Kinetix`;
    case 'fact_id_required':
      return `${at}: operation "${p.operation}" requires the exact factId of the existing fact`;
    case 'unknown_monograph_section':
      return `${at}: "${p.sectionId}" is not a monograph section id (expected one of: ${p.allowed})`;
    case 'monograph_target_required':
      return `${at}: a monograph fact needs target.drug or a confirmed target.pageId`;
    case 'topic_target_required':
      return `${at}: a topic fact needs target.pageId or target.pageSlug — an unresolved page is a blockedCandidate, not an item`;
    case 'duplicate_source_key':
      return `${at}: duplicate source key "${p.key}"`;
    case 'undeclared_source_key':
      return `${at}: sourceKey "${p.key}" is not declared in sources[]`;
    case 'source_verification_conflict':
      return `${at}: ${p.keys} name the same paper but disagree about readInFull — one paper was either read in full or it was not, and which one wins would decide both whether a fact publishes and what review is stored`;
    case 'source_not_read_in_full':
      return `${at}: source "${p.key}" has readInFull: false — only a wiki_fact may cite an unverified source (Kinetix routes it to the review queue); a ${p.itemType} may not, so move the claim to blockedCandidates`;
    case 'item_type_not_in_mode':
      return `${at}: item type "${p.itemType}" is not allowed in mode "${p.mode}"`;
    case 'monograph_mode_topic_fact':
      return `${at}: mode "monograph" restricts wiki facts to monograph pages`;
    case 'empty_bundle':
      return `${at}: bundle carries neither items nor blockedCandidates — an empty bundle is not a result, it is a no-op`;
  }
}

/** Collects fatal problems as codes, rendering the English text once. */
export class ErrorSink {
  readonly details: IngestionError[] = [];

  push(
    code: IngestionErrorCode,
    where: string,
    params: Record<string, string | number> = {},
  ): void {
    this.details.push({ code, where, params });
  }

  get length(): number {
    return this.details.length;
  }

  get messages(): string[] {
    return this.details.map(renderError);
  }
}

/**
 * Collects warnings as codes and renders them in one place, so the array the
 * CLI prints and the codes the pane translates can never drift apart.
 */
export class WarningSink {
  readonly details: IngestionWarning[] = [];

  push(
    code: IngestionWarningCode,
    where: string,
    params: Record<string, string | number> = {},
  ): void {
    this.details.push({ code, where, params });
  }

  get messages(): string[] {
    return this.details.map(renderWarning);
  }
}

export type ConversationIngestionParseResult =
  | {
      ok: true;
      data: NormalizedConversationIngestion;
      /** Rendered English, for the CLI and for callers that just print. */
      warnings: string[];
      /** The same warnings as codes, for a UI that translates them. */
      warningDetails: IngestionWarning[];
    }
  | {
      ok: false;
      /** Rendered English, for the CLI and for callers that just print. */
      errors: string[];
      /** The same failures as codes, for a UI that translates them. */
      errorDetails: IngestionError[];
      warnings: string[];
      warningDetails: IngestionWarning[];
    };

// ─── Privacy invariant ───────────────────────────────────────────────────────

/**
 * Keys that must never appear anywhere in a bundle. The contract's whole privacy
 * promise is that the raw chat and the case behind it are not transmitted, and
 * the cheapest enforcement is to refuse the containers a model reaches for when
 * it wants to attach them.
 */
const FORBIDDEN_KEYS = new Set([
  'rawconversation',
  'conversation',
  'transcript',
  'messages',
  'chat',
  'chatlog',
  'caseexample',
  'casenumber',
  'caseid',
  'patient',
  'patientname',
  'patientid',
  'name',
  'dateofbirth',
  'dob',
  'birthdate',
  'address',
  'nationalid',
  'personnummer',
  'fodselsnummer',
  'incidentdate',
  'deceased',
  'autopsynumber',
]);

/** Norwegian fødselsnummer / D-number: 11 digits, optionally spaced after the 6th. */
const NATIONAL_ID_PATTERN = /\b\d{6}\s?\d{5}\b/;

/** Day-precision dates. A year is fine in a citation; a full date rarely is. */
const FULL_DATE_PATTERN =
  /\b(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * Envelope fields whose content is the bundle's own machine metadata, not
 * anything observed about a case. They are exempt from the date scan: a run
 * stamped `2026-08-06` is the run's date, and flagging it would train the reader
 * to ignore the warning that matters.
 */
const DATE_SCAN_EXEMPT_KEYS = new Set(['createdAt', 'idempotencyKey']);

/**
 * Walk the raw document for privacy violations before anything else runs, so a
 * bundle carrying case data fails on that ground rather than on some incidental
 * shape error further down.
 */
function scanPrivacy(
  raw: unknown,
  errors: ErrorSink,
  warnings: WarningSink,
  path = '(root)',
): void {
  if (Array.isArray(raw)) {
    raw.forEach((v, i) => scanPrivacy(v, errors, warnings, `${path}[${i}]`));
    return;
  }
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const here = path === '(root)' ? key : `${path}.${key}`;
      if (FORBIDDEN_KEYS.has(normalizeKey(key))) {
        errors.push('forbidden_key', here, { key });
        continue;
      }
      if (DATE_SCAN_EXEMPT_KEYS.has(key) && typeof value === 'string') continue;
      scanPrivacy(value, errors, warnings, here);
    }
    return;
  }
  if (typeof raw === 'string') {
    if (NATIONAL_ID_PATTERN.test(raw)) {
      errors.push('national_id', path);
    } else if (FULL_DATE_PATTERN.test(raw)) {
      warnings.push('full_date', path);
    }
  }
}

// ─── Input schema ────────────────────────────────────────────────────────────

const trimmed = (max: number) => z.string().trim().min(1).max(max);

const altIdsInput = z
  .object({
    pmid: z.string().optional(),
    doi: z.string().optional(),
    pmcid: z.string().optional(),
    url: z.string().optional(),
  })
  .strict();

const verificationInput = z
  .object({
    readInFull: z.boolean(),
    locator: trimmed(300),
    evidenceSummary: trimmed(2000),
    reviewMarkdown: trimmed(50000),
    reviewConfidence: z.enum(['high', 'medium', 'low']).optional(),
    conclusionSupport: z.string().trim().max(30).optional(),
    overallScore: z.number().int().min(0).max(100).optional(),
  })
  .strict();

const sourceInput = z
  .object({
    key: trimmed(40),
    type: z.enum(INGESTION_SOURCE_TYPES),
    identifier: trimmed(2000),
    altIds: altIdsInput.optional(),
    metadata: z
      .object({
        title: z.string().trim().max(1000).optional(),
        authors: z.array(z.string().trim().max(200)).max(200).optional(),
        journal: z.string().trim().max(300).optional(),
        year: z.number().int().min(1500).max(2200).optional(),
      })
      .strict()
      .optional(),
    verification: verificationInput,
    pdfRequestNeeded: z.boolean().optional(),
  })
  .strict();

const drugTargetInput = z
  .object({
    drugId: z.number().int().positive().optional(),
    pubchemCid: z.number().int().positive().optional(),
    drugName: trimmed(200),
  })
  .strict();

const derivationInput = z
  .object({
    kind: z.enum(DERIVATION_KINDS),
    equation: z.string().trim().max(500).optional(),
    assumptions: z.string().trim().max(2000).optional(),
    uncertainty: z.string().trim().max(500).optional(),
  })
  .strict();

const studyContextInput = z
  .object({
    analyte: z.string().trim().max(200).optional(),
    saltOrForm: z.string().trim().max(200).optional(),
    route: z.string().trim().max(100).optional(),
    formulation: z.string().trim().max(200).optional(),
    dose: z.string().trim().max(200).optional(),
    regimen: z.string().trim().max(200).optional(),
    population: z.string().trim().max(300).optional(),
    species: z.string().trim().max(100).optional(),
    studyDesign: z.string().trim().max(300).optional(),
    studyArm: z.string().trim().max(200).optional(),
    samplingWindow: z.string().trim().max(200).optional(),
    model: z.string().trim().max(200).optional(),
    analyticalMethod: z.string().trim().max(300).optional(),
    postmortemContext: z.string().trim().max(500).optional(),
    derivation: derivationInput.optional(),
  })
  .strict();

/**
 * Structured dose context for a dose-context parameter (Cmax dose-context RFC;
 * `src/lib/entryDoseContext.ts`). The free-text `context` above stays what it
 * is — a description for the reviewer — and this is what the entry stores and
 * the normalizer reads. The two drug references name a substance the way
 * `target` does (id, CID or name), resolved by the same resolver at import;
 * an omitted `administeredDrug` means the target drug itself was dosed.
 * `route` is the entry's structured administration route.
 */
const { administeredDrugId: _a, interactingDrugId: _i, ...doseContextFieldsInput } =
  doseContextShape;
const doseContextInput = z
  .object({
    ...doseContextFieldsInput,
    route: z.enum(ROUTE_IDS as unknown as [string, ...string[]]).optional(),
    administeredDrug: drugTargetInput.optional(),
    interactingDrug: drugTargetInput.optional(),
  })
  .strict();
export type IngestionDoseContext = z.infer<typeof doseContextInput>;

/**
 * The dose context flattened onto entry fields, for the registry validator.
 * The drug references cannot be resolved here (that needs the catalog), so a
 * named or defaulted administered drug is stood in by a placeholder id — what
 * is being checked is the SHAPE; the importer re-validates with real ids.
 */
export function doseContextEntryFields(
  parameter: string,
  doseContext: IngestionDoseContext | undefined,
): Record<string, unknown> {
  const { administeredDrug: _administered, interactingDrug, ...fields } = doseContext ?? {};
  const out: Record<string, unknown> = { ...fields };
  // Named or defaulted to the target, a dose-context entry always has one.
  if (parameterDoseContextMode(parameter) === 'required') {
    out.administeredDrugId = PLACEHOLDER_DRUG_ID;
  }
  if (interactingDrug) out.interactingDrugId = PLACEHOLDER_DRUG_ID;
  return out;
}
const PLACEHOLDER_DRUG_ID = 1;

const parameterItemInput = z
  .object({
    type: z.literal('parameter_observation'),
    target: drugTargetInput,
    // The summarized parameters, plus the entry-only ones (Cmax) that carry
    // structured dose context.
    parameter: z.enum([...SUMMARIZED_PARAMETER_IDS, ...ENTRY_ONLY_PARAMETER_IDS] as unknown as [
      string,
      ...string[],
    ]),
    doseContext: doseContextInput.optional(),
    low: z.number().finite().optional(),
    high: z.number().finite().optional(),
    median: z.number().finite().optional(),
    qualifier: z
      .enum(QUALIFIER_OPERATORS as unknown as [string, ...string[]])
      .optional(),
    unit: z.string().max(20),
    matrix: referenceMatrixSchema.optional(),
    scenario: referenceScenarioSchema.optional(),
    n: z.number().int().positive().max(2_147_483_647).optional(),
    sourceKey: trimmed(40),
    context: studyContextInput,
    comments: z.string().trim().max(2000).optional(),
    quote: sourceQuoteSchema,
    editSummary: trimmed(500),
  })
  .strict();

const wikiFactItemInput = z
  .object({
    type: z.literal('wiki_fact'),
    target: z
      .object({
        pageType: z.enum(INGESTION_PAGE_TYPES),
        pageId: z.number().int().positive().optional(),
        drug: drugTargetInput.optional(),
        pageSlug: z.string().trim().max(200).optional(),
        sectionId: trimmed(100),
        observedRevisionId: z.number().int().positive().optional(),
      })
      .strict(),
    operation: z.enum(['add', 'replace', 'remove']),
    factId: z.string().trim().max(100).optional(),
    statement: z.string().trim().max(2000).optional(),
    sourceKeys: z.array(trimmed(40)).max(20),
    editSummary: trimmed(500),
  })
  .strict();

const topicPageItemInput = z
  .object({
    type: z.literal('topic_page_proposal'),
    titleNb: trimmed(200),
    titleEn: z.string().trim().max(200).optional(),
    slug: trimmed(200),
    parentSlug: z.string().trim().max(200).optional(),
    categories: z.array(z.string().trim().max(100)).max(20).optional(),
    sections: z
      .array(
        z
          .object({
            sectionId: trimmed(100),
            titleNb: trimmed(200),
            facts: z
              .array(
                z
                  .object({
                    statement: trimmed(2000),
                    sourceKeys: z.array(trimmed(40)).min(1).max(20),
                  })
                  .strict(),
              )
              .min(1)
              .max(50),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    rationale: trimmed(1000),
  })
  .strict();

const itemInput = z.discriminatedUnion('type', [
  parameterItemInput,
  wikiFactItemInput,
  topicPageItemInput,
]);

const blockedCandidateInput = z
  .object({
    summary: trimmed(1000),
    blocker: trimmed(500),
    candidateIdentifier: z.string().trim().max(2000).optional(),
  })
  .strict();

const rootInput = z
  .object({
    schemaVersion: z.literal(CONVERSATION_INGESTION_SCHEMA_VERSION),
    idempotencyKey: trimmed(200),
    mode: z.enum(INGESTION_MODES),
    conversationDigest: z
      .string()
      .trim()
      .regex(
        /^[a-f0-9]{64}$/i,
        'must be a 64-character hex digest (e.g. sha256 of the conversation)',
      ),
    createdAt: z.string().trim().datetime({ offset: true }),
    sources: z.array(sourceInput).max(200),
    items: z.array(itemInput).max(500),
    blockedCandidates: z.array(blockedCandidateInput).max(200).optional(),
  })
  .strict();

// ─── Shape-mismatch diagnostics ──────────────────────────────────────────────

/**
 * Keys seen on documents that claim to be an ingestion bundle but follow a shape
 * the model invented. Naming the specific key beats a wall of "unrecognized
 * key" issues, because the fix is not to delete the key — it is to start again
 * from the real contract.
 */
const IMPOSTOR_KEYS: Record<string, string> = {
  kinetix_import_version: 'kinetix_import_version',
  action: 'action',
  review_required: 'review_required',
  review_reason: 'review_reason',
  topic: 'topic',
  interpretation_en: 'interpretation_en',
  interpretation_no: 'interpretation_no',
  decision_rules: 'decision_rules',
  confidence: 'confidence',
};

/**
 * Detect a document that is not this contract at all, and say so in one line.
 * Returns null when the document at least looks like an attempt at v1.
 */
function detectImpostorShape(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  if (doc.schemaVersion === CONVERSATION_INGESTION_SCHEMA_VERSION) return null;
  const found = Object.keys(doc).filter((k) => k in IMPOSTOR_KEYS);
  if (found.length === 0) return null;
  return (
    `This is not a ${CONVERSATION_INGESTION_SCHEMA_VERSION} bundle — it uses an invented shape ` +
    `(found ${found.map((k) => `"${k}"`).join(', ')}). The contract has a strict envelope of ` +
    `schemaVersion, idempotencyKey, mode, conversationDigest, createdAt, sources[], items[] and ` +
    `blockedCandidates[]; see .claude/skills/kinetix/reference/example-bundle.json.`
  );
}

// ─── Cross-reference and semantic checks ─────────────────────────────────────

function normalizeSource(
  input: z.infer<typeof sourceInput>,
  index: number,
  errors: ErrorSink,
): IngestionSource | null {
  const declaredAlt = normalizeAltIds(input.altIds ?? {});
  const identifier = normalizeHandleIdentifier(input.type, input.identifier);

  // Do not let an alt handle silently outrank the declared one here. The bundle
  // is a proposal, and the operator reading it should see the handle the author
  // chose; `canonicalCitationHandle` still tells us when a stronger one exists.
  const canonical = canonicalCitationHandle(
    { type: input.type, identifier },
    declaredAlt,
  );

  if (input.type === 'pmid' && !/^\d{1,8}$/.test(identifier)) {
    errors.push('invalid_pmid', `sources[${index}] (${input.key})`, {
      identifier: input.identifier,
    });
    return null;
  }
  if (input.type === 'doi' && !/^10\.\d{4,}\/.+/.test(identifier)) {
    errors.push('invalid_doi', `sources[${index}] (${input.key})`, {
      identifier: input.identifier,
    });
    return null;
  }
  if (input.type === 'url') {
    try {
      const url = new URL(identifier);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('bad protocol');
      }
    } catch {
      errors.push('invalid_url', `sources[${index}] (${input.key})`, {
        identifier: input.identifier,
      });
      return null;
    }
  }

  const metadata = input.metadata
    ? {
        ...(input.metadata.title ? { title: input.metadata.title } : {}),
        ...(input.metadata.authors?.length
          ? { authors: input.metadata.authors }
          : {}),
        ...(input.metadata.journal ? { journal: input.metadata.journal } : {}),
        ...(input.metadata.year !== undefined
          ? { year: input.metadata.year }
          : {}),
      }
    : null;

  return {
    key: input.key,
    type: input.type,
    identifier,
    altIds: canonical.altIds,
    metadata: metadata && Object.keys(metadata).length ? metadata : null,
    verification: {
      readInFull: input.verification.readInFull,
      locator: input.verification.locator,
      evidenceSummary: input.verification.evidenceSummary,
      reviewMarkdown: input.verification.reviewMarkdown,
      ...(input.verification.reviewConfidence
        ? { reviewConfidence: input.verification.reviewConfidence }
        : {}),
      ...(input.verification.conclusionSupport
        ? { conclusionSupport: input.verification.conclusionSupport }
        : {}),
      ...(input.verification.overallScore !== undefined
        ? { overallScore: input.verification.overallScore }
        : {}),
    },
    pdfRequestNeeded: input.pdfRequestNeeded ?? false,
  };
}

function checkParameterItem(
  item: z.infer<typeof parameterItemInput>,
  where: string,
  errors: ErrorSink,
  warnings: WarningSink,
): void {
  // Registry rules first — the same call the write routes make, so a bundle
  // that passes here cannot fail later on unit/bounds/matrix/scenario.
  const withDose = { ...item, ...doseContextEntryFields(item.parameter, item.doseContext) };
  const boundsMessage = validateEntryValueInvariants(withDose);
  if (boundsMessage) errors.push('value_bounds', where, { message: boundsMessage });

  const registryMessage = validateEntryForParameter(
    item.parameter,
    canonicalizeReportedStatistic(withDose),
  );
  if (registryMessage) {
    errors.push('registry_rejected', where, { message: registryMessage });
  }

  if (item.target.drugId === undefined && item.target.pubchemCid === undefined) {
    warnings.push('drug_name_only', where, { name: item.target.drugName });
  }

  const derivation = item.context.derivation;
  if (derivation && derivation.kind !== 'reported' && !derivation.assumptions) {
    warnings.push('derivation_no_assumptions', where, { kind: derivation.kind });
  }
  if (!derivation) {
    warnings.push('no_derivation', where);
  }
  if (item.n === undefined) {
    warnings.push('no_sample_size', where);
  }
}

/**
 * Union-find over string aliases. Both halves of the corroboration check need
 * the same thing — several spellings of one identity collapsed to a single
 * representative, with no preference order between them: a paper declared once
 * as a PMID and once as the DOI in its `altIds`, a drug carried once as
 * `drugId` + CID and once as CID alone.
 */
class AliasSets {
  private parent = new Map<string, string>();

  private find(id: string): string {
    const path: string[] = [];
    let current = id;
    for (;;) {
      const next = this.parent.get(current);
      if (next === undefined || next === current) break;
      path.push(current);
      current = next;
    }
    this.parent.set(current, current);
    for (const node of path) this.parent.set(node, current);
    return current;
  }

  /** Declare that every alias names the same thing. */
  link(aliases: ReadonlyArray<string>): void {
    const [first, ...rest] = aliases;
    if (first === undefined) return;
    const root = this.find(first);
    for (const alias of rest) {
      const other = this.find(alias);
      if (other !== root) this.parent.set(other, root);
    }
  }

  key(alias: string): string {
    return this.find(alias);
  }
}

/**
 * `sourceKey` → the identity of the paper behind it.
 *
 * Bundle-local keys are not citations: the same paper declared as `S1` by PMID
 * and as `S3` by DOI is two keys and one source, and counting keys would let it
 * satisfy the two-source rule on its own. Identity therefore folds over every
 * handle a source is addressable under, primary and alternate alike — the same
 * crosswalk the citation write path uses to avoid minting a second row.
 *
 * Reads the DECLARED handles, all of them, rather than a canonicalized row.
 * `canonicalCitationHandle` answers a different question — which row does this
 * paper belong in — and drops handles that answer is indifferent to: the
 * winning one (a source declared by DOI with a stronger PMID in `altIds` comes
 * back without that PMID) and any alt sharing the winner's type (a second URL
 * for the same label). Either omission would let one paper count twice.
 *
 * Every handle a source declares is treated as naming the same paper, because
 * that is what declaring it asserts. Erring that way can only merge two keys
 * into one source, never split one into two — so it can only add a
 * single-source warning, never suppress one.
 */
function citationIdentities(
  sources: ReadonlyArray<z.infer<typeof sourceInput>>,
): (sourceKey: string) => string {
  const sets = new AliasSets();

  // A fragment names a place inside the retrieved document — `#results` against
  // `#table-2` — never a different document, so it is not part of identity. The
  // query string is left alone, because that one CAN select a different article.
  const aliasFor = (type: string, identifier: string) => {
    if (type !== 'url') return `${type}:${identifier}`;
    try {
      const parsed = new URL(identifier.trim());
      parsed.hash = '';
      return `url:${parsed.toString()}`;
    } catch {
      return `url:${identifier.trim()}`;
    }
  };

  const handlesOf = (source: z.infer<typeof sourceInput>) => {
    const aliases = new Set<string>([
      aliasFor(
        source.type,
        normalizeHandleIdentifier(source.type, source.identifier),
      ),
    ]);
    for (const [type, identifier] of Object.entries(
      normalizeAltIds(source.altIds),
    )) {
      aliases.add(aliasFor(type, identifier));
    }

    // A resolver URL is a front for the handle behind it — doi.org/10.x and
    // the bare DOI are one paper declared two ways — and it can be spelled
    // into any handle, not just a `url` one: `type: "doi"` with the doi.org
    // address as its identifier passes the DOI shape check, because
    // normalization strips the scheme while keeping whatever query string
    // came with it. So the raw values are what gets read here, before that.
    for (const raw of [source.identifier, ...Object.values(source.altIds ?? {})]) {
      if (typeof raw !== 'string') continue;
      const resolved = resolverHandleFromUrl(raw);
      if (resolved) aliases.add(`${resolved.type}:${resolved.identifier}`);
    }

    return [...aliases];
  };

  for (const source of sources) sets.link(handlesOf(source));
  const byKey = new Map(
    sources.map((source) => [source.key, sets.key(handlesOf(source)[0]!)]),
  );

  // An undeclared sourceKey is already a hard error elsewhere; give it its own
  // identity rather than folding unrelated items together behind it.
  return (sourceKey) => byKey.get(sourceKey) ?? `key:${sourceKey}`;
}

/**
 * Drug target → drug identity, folded across the identifier forms the contract
 * allows. One item may carry a confirmed `drugId` alongside the CID while the
 * next carries the CID alone; both name the same drug, and grouping them apart
 * would report each as single-sourced.
 *
 * Resolved in tiers of decreasing confidence rather than unioned, because
 * unioning trusts the bundle to be internally consistent and a bundle that
 * contradicts itself is precisely where a false pair would slip through. A
 * confirmed `drugId` is the identity — unless the bundle pairs that same
 * `drugId` with two different CIDs, which is a contradiction in the other
 * direction and leaves neither target's identity settled. A CID stands in for a
 * `drugId` only where the bundle maps it to exactly one. A display name is not
 * identity at all — two papers can call two compounds the same thing — so it
 * resolves a target carrying neither identifier, and only where the bundle uses
 * that name for exactly one drug.
 *
 * Every ambiguity therefore ends in a separate group, which warns. That is the
 * safe direction: a spurious single-source warning is visible and answerable,
 * a silent merge of two compounds is not.
 */
function drugIdentities(
  targets: ReadonlyArray<IngestionDrugTarget>,
): (target: IngestionDrugTarget) => string {
  const nameOf = (target: IngestionDrugTarget) =>
    `name:${target.drugName.trim().toLowerCase()}`;

  const drugIdsByCid = new Map<number, Set<string>>();
  const cidsByDrugId = new Map<number, Set<number>>();
  for (const target of targets) {
    if (target.pubchemCid === undefined || target.drugId === undefined) continue;
    const ids = drugIdsByCid.get(target.pubchemCid) ?? new Set<string>();
    ids.add(`drug:${target.drugId}`);
    drugIdsByCid.set(target.pubchemCid, ids);
    const cids = cidsByDrugId.get(target.drugId) ?? new Set<number>();
    cids.add(target.pubchemCid);
    cidsByDrugId.set(target.drugId, cids);
  }

  const stableIdentity = (target: IngestionDrugTarget): string | null => {
    if (target.drugId !== undefined) {
      const claimedCids = cidsByDrugId.get(target.drugId);
      // One drug id carrying two CIDs: the bundle contradicts itself about what
      // this drug is, so the pair is not corroboration until someone says which.
      return (claimedCids?.size ?? 0) > 1
        ? `drug:${target.drugId}+cid:${target.pubchemCid ?? 'none'}`
        : `drug:${target.drugId}`;
    }
    if (target.pubchemCid === undefined) return null;
    const claimed = drugIdsByCid.get(target.pubchemCid);
    return claimed?.size === 1 ? [...claimed][0]! : `cid:${target.pubchemCid}`;
  };

  const byName = new Map<string, Set<string>>();
  for (const target of targets) {
    const stable = stableIdentity(target);
    if (!stable) continue;
    const seen = byName.get(nameOf(target)) ?? new Set<string>();
    seen.add(stable);
    byName.set(nameOf(target), seen);
  }

  return (target) => {
    const stable = stableIdentity(target);
    if (stable) return stable;
    const resolved = byName.get(nameOf(target));
    return resolved?.size === 1 ? [...resolved][0]! : nameOf(target);
  };
}

/**
 * Spellings of one species and one route, folded so two rat studies do not read
 * as two species because one said `rat` and the other `Rattus norvegicus`.
 * Anything unrecognized keys by its own normalized text — which errs toward
 * splitting a group and warning, never toward silently pooling a human value
 * with an animal one or an oral value with an intranasal one.
 */
const SPECIES_SYNONYMS: Readonly<Record<string, string>> = {
  human: 'human',
  humans: 'human',
  man: 'human',
  'homo sapiens': 'human',
  'h sapiens': 'human',
  rat: 'rat',
  rats: 'rat',
  'rattus norvegicus': 'rat',
  mouse: 'mouse',
  mice: 'mouse',
  'mus musculus': 'mouse',
  dog: 'dog',
  dogs: 'dog',
  'canis familiaris': 'dog',
  rabbit: 'rabbit',
  rabbits: 'rabbit',
  'oryctolagus cuniculus': 'rabbit',
  pig: 'pig',
  pigs: 'pig',
  swine: 'pig',
  'sus scrofa': 'pig',
};

const ROUTE_SYNONYMS: Readonly<Record<string, string>> = {
  oral: 'oral',
  po: 'oral',
  'per oral': 'oral',
  peroral: 'oral',
  'by mouth': 'oral',
  intravenous: 'intravenous',
  iv: 'intravenous',
  intramuscular: 'intramuscular',
  im: 'intramuscular',
  subcutaneous: 'subcutaneous',
  sc: 'subcutaneous',
  intranasal: 'intranasal',
  nasal: 'intranasal',
  inhaled: 'inhalation',
  inhalation: 'inhalation',
  smoked: 'inhalation',
  rectal: 'rectal',
  transdermal: 'transdermal',
  buccal: 'buccal',
  sublingual: 'sublingual',
};

function foldedKey(
  synonyms: Readonly<Record<string, string>>,
  raw: string | undefined,
): string {
  if (!raw) return '';
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[.]/g, '')
    .replace(/\s+/g, ' ');
  return synonyms[normalized] ?? normalized;
}

/**
 * Parameters whose value is a property of the route, not of the drug. The
 * registry calls `bioavailability` "Oral bioavailability", and time to peak is
 * meaningless without the route it was measured after — so a buccal study does
 * not corroborate an oral one. Everything else (half-life, volume of
 * distribution, protein binding, …) is a drug property that the aggregate pools
 * across routes, and splitting those would warn about ordinary practice.
 */
const ROUTE_DEPENDENT_PARAMETERS: ReadonlySet<string> = new Set([
  'bioavailability',
  'tmax',
]);

/**
 * The context dimensions on which two observations stop being the same
 * quantity. Each splits a group only once two of its values are actually
 * declared there: splitting on a dimension one of the two items left blank
 * would break a genuine pair over a missing field.
 *
 * `saltOrForm` is deliberately absent. Morphine sulfate and morphine sulfate
 * pentahydrate are the same drug measured after the same route, and the skill
 * treats salt form as context that legitimately differs between two studies of
 * one quantity — splitting on that free text would warn about ordinary pairs.
 * A parent/metabolite mismatch is a different matter, and that is what
 * `analyte` catches.
 */
const CORROBORATION_DIMENSIONS = [
  {
    label: 'species',
    applies: () => true,
    read: (item: z.infer<typeof parameterItemInput>) => item.context.species,
    fold: (raw: string | undefined) => foldedKey(SPECIES_SYNONYMS, raw),
  },
  {
    label: 'analyte',
    applies: () => true,
    read: (item: z.infer<typeof parameterItemInput>) => item.context.analyte,
    fold: (raw: string | undefined) => foldedKey({}, raw),
  },
  {
    label: 'route',
    applies: (parameter: string) => ROUTE_DEPENDENT_PARAMETERS.has(parameter),
    read: (item: z.infer<typeof parameterItemInput>) => item.context.route,
    fold: (raw: string | undefined) => foldedKey(ROUTE_SYNONYMS, raw),
  },
] as const;

/**
 * A parameter aggregate is only as strong as the number of independent sources
 * under it: one paper's value is a claim, two papers' values are something the
 * aggregation can weigh. The skill therefore requires at least two independent
 * sources per parameter — one observation item each — and sends a parameter
 * that only one source supports to `blockedCandidates` instead.
 *
 * Grouped by drug + parameter + matrix + scenario, because those four decide
 * which entries are pooled downstream. Population, formulation, dose and method
 * deliberately do NOT split a group: they are context on the entry, not a
 * different quantity. Species and analyte always split one, and route splits
 * one for a parameter that is a property of the route — see
 * CORROBORATION_DIMENSIONS,
 * which also explains why a dimension only splits once two of its values are
 * actually declared.
 *
 * A warning, not an error: the bundle is still usable, and the operator may
 * knowingly accept a single-sourced value. The point is that they see it.
 */
function checkCorroboration(
  items: ReadonlyArray<z.infer<typeof itemInput>>,
  sources: ReadonlyArray<z.infer<typeof sourceInput>>,
  warnings: WarningSink,
): void {
  type Observation = {
    item: z.infer<typeof parameterItemInput>;
    index: number;
  };

  const observations: Observation[] = [];
  items.forEach((item, index) => {
    if (item.type === 'parameter_observation') observations.push({ item, index });
  });
  if (observations.length === 0) return;

  const citationOf = citationIdentities(sources);
  const drugOf = drugIdentities(observations.map((o) => o.item.target));

  const groups = new Map<string, Observation[]>();
  for (const observation of observations) {
    const { item } = observation;
    // JSON, not join('|'): free-text context can contain the delimiter, and two
    // different tuples colliding on one key would read as corroboration.
    const key = JSON.stringify([
      drugOf(item.target),
      item.parameter,
      item.matrix ?? '',
      item.scenario ?? '',
      // Units that cannot be converted into one another cannot end up in one
      // aggregate — `L/h` and `L/h/kg` differ by a body weight no entry
      // carries — so a pair spanning two families is not two usable sources.
      parameterUnitFamily(item.unit),
    ]);
    const group = groups.get(key);
    if (group) group.push(observation);
    else groups.set(key, [observation]);
  }

  for (const group of groups.values()) {
    const parameter = group[0]!.item.parameter;
    const splitting = CORROBORATION_DIMENSIONS.filter((dimension) => {
      if (!dimension.applies(parameter)) return false;
      const declared = new Set(
        group.map((o) => dimension.fold(dimension.read(o.item))).filter(Boolean),
      );
      return declared.size > 1;
    });

    const buckets = new Map<string, Observation[]>();
    for (const observation of group) {
      const key = JSON.stringify(
        splitting.map((dimension) =>
          dimension.fold(dimension.read(observation.item)),
        ),
      );
      const bucket = buckets.get(key);
      if (bucket) bucket.push(observation);
      else buckets.set(key, [observation]);
    }

    for (const bucket of buckets.values()) {
      const identities = new Set(bucket.map((o) => citationOf(o.item.sourceKey)));
      const first = bucket[0]!.item;
      const where = `items[${bucket.map((o) => o.index).join(', ')}]`;

      // A unit no conversion reaches from the parameter's canonical one never
      // enters the aggregate at all, so counting sources in it is moot: two of
      // them still leave the pool empty. Say that instead of asking for a
      // third.
      const canonicalUnit = getRangeSpec(
        first.parameter as DrugParameterId,
      ).canonicalUnit;
      if (
        parameterUnitFamily(first.unit) !== parameterUnitFamily(canonicalUnit)
      ) {
        warnings.push('unit_not_convertible', where, {
          parameter: first.parameter,
          drug: first.target.drugName,
          unit: first.unit,
          canonicalUnit,
        });
        continue;
      }

      if (identities.size >= 2) continue;

      const qualifiers = [
        first.matrix,
        first.scenario,
        ...splitting.map(
          (dimension) =>
            dimension.read(first) ?? `${dimension.label} not stated`,
        ),
      ].filter(Boolean);
      const label = `${first.parameter}${
        qualifiers.length ? ` (${qualifiers.join(', ')})` : ''
      } for ${first.target.drugName}`;

      const keys = [...new Set(bucket.map((o) => o.item.sourceKey))];
      const cited =
        keys.length > 1
          ? `${keys.map((k) => `"${k}"`).join(' and ')} resolve to the same citation`
          : `"${keys[0]}"`;
      const spread =
        bucket.length > 1 ? ` across ${bucket.length} observations` : '';

      warnings.push('single_source', where, { label, cited, spread });
    }
  }
}

function checkWikiFactItem(
  item: z.infer<typeof wikiFactItemInput>,
  where: string,
  errors: ErrorSink,
  warnings: WarningSink,
): void {
  const { operation, target } = item;

  if (operation === 'remove') {
    if (item.statement) {
      errors.push('remove_with_statement', where);
    }
    if (item.sourceKeys.length > 0) {
      warnings.push('remove_with_sources', where);
    }
  } else {
    if (!item.statement) {
      errors.push('statement_required', where, { operation });
    }
    if (item.sourceKeys.length === 0) {
      errors.push('source_key_required', where, { operation });
    }
  }

  if (operation === 'add' && item.factId) {
    errors.push('add_with_fact_id', where);
  }
  if (operation !== 'add' && !item.factId) {
    errors.push('fact_id_required', where, { operation });
  }

  if (target.pageType === 'monograph') {
    if (!(MONOGRAPH_SECTION_IDS as readonly string[]).includes(target.sectionId)) {
      errors.push('unknown_monograph_section', where, {
        sectionId: target.sectionId,
        allowed: MONOGRAPH_SECTION_IDS.join(', '),
      });
    }
    if (!target.drug && target.pageId === undefined) {
      errors.push('monograph_target_required', where);
    }
  } else if (target.pageId === undefined && !target.pageSlug) {
    errors.push('topic_target_required', where);
  }

  if (target.observedRevisionId === undefined && operation !== 'add') {
    warnings.push('no_observed_revision', where, { operation });
  }

  // A paragraph carrying several independently contestable claims is not an
  // atomic fact; the review queue cannot accept half of it.
  if (item.statement && /(?:\.\s+[A-ZÆØÅ])/.test(item.statement)) {
    warnings.push('statement_multi_sentence', where);
  }
}

/**
 * Validate and normalize a `kinetix-conversation-ingestion-v1` bundle.
 *
 * Returns the normalized bundle plus non-fatal warnings, or the list of fatal
 * problems. Warnings are returned on both branches: a bundle can fail on one
 * item while still carrying advice worth showing about the rest.
 */
export function parseConversationIngestion(
  raw: unknown,
): ConversationIngestionParseResult {
  const errors = new ErrorSink();
  const warnings = new WarningSink();

  const impostor = detectImpostorShape(raw);
  if (impostor) {
    errors.push('impostor_shape', '(root)', { message: impostor });
    return {
      ok: false,
      errors: errors.messages,
      errorDetails: errors.details,
      warnings: warnings.messages,
      warningDetails: warnings.details,
    };
  }

  // Privacy runs on the RAW document: a forbidden key would otherwise be
  // reported only as an unrecognized one, hiding why it must go.
  scanPrivacy(raw, errors, warnings);
  if (errors.length) {
    return {
      ok: false,
      errors: errors.messages,
      errorDetails: errors.details,
      warnings: warnings.messages,
      warningDetails: warnings.details,
    };
  }

  const parsed = rootInput.safeParse(raw);
  if (!parsed.success) {
    // Zod's own text is library English about a schema. The frame around it is
    // translated; the technical remainder rides along as data.
    const schemaIssues: IngestionError[] = parsed.error.issues.map((i) => ({
      code: 'schema_invalid' as const,
      where: i.path.join('.') || '(root)',
      params: { message: i.message },
    }));
    return {
      ok: false,
      errors: schemaIssues.map(renderError),
      errorDetails: schemaIssues,
      warnings: warnings.messages,
      warningDetails: warnings.details,
    };
  }
  const doc = parsed.data;

  // ── Sources ──
  const sources: IngestionSource[] = [];
  const seenKeys = new Set<string>();
  doc.sources.forEach((s, i) => {
    if (seenKeys.has(s.key)) {
      errors.push('duplicate_source_key', `sources[${i}]`, { key: s.key });
      return;
    }
    seenKeys.add(s.key);
    const normalized = normalizeSource(s, i, errors);
    if (normalized) sources.push(normalized);
  });

  const byKey = new Map(sources.map((s) => [s.key, s]));
  const referenced = new Set<string>();

  // Two keys can name one paper — declared by PMID under one and by DOI under
  // the other — and the write path treats them as one citation row with one
  // review. So an attestation is a property of the PAPER, and a bundle that
  // says the same paper was both read and not read in full has not given one.
  //
  // Left to run, that contradiction is resolved by two different rules that do
  // not agree: routing reads the key the ITEM cites, while `commitSourcesFor`
  // records the FIRST key's appraisal. Depending on declaration order, a fact
  // publishes as verified while its citation is stored `readInFull: false`
  // (a live claim resting on a source the app considers unreviewed), or a
  // verified claim is queued for a paper already marked read. Neither is a
  // defensible reading of the bundle, so refuse it rather than pick one —
  // the same stance the contract takes on a drug id that carries two CIDs.
  const paperOf = citationIdentities(doc.sources);
  const attestations = new Map<string, { read: string[]; unread: string[] }>();
  for (const source of sources) {
    const paper = paperOf(source.key);
    const seen = attestations.get(paper) ?? { read: [], unread: [] };
    (source.verification.readInFull ? seen.read : seen.unread).push(source.key);
    attestations.set(paper, seen);
  }
  for (const [, seen] of attestations) {
    if (seen.read.length === 0 || seen.unread.length === 0) continue;
    const keys = [...seen.read, ...seen.unread];
    errors.push('source_verification_conflict', `sources[${keys.join(', ')}]`, {
      keys: keys.map((key) => `"${key}"`).join(' and '),
    });
  }

  /**
   * Resolve an item's source keys and decide what an unread source means for it.
   *
   * The reference gate — a committed claim cites a source whose review attests
   * full-text reading — is a rule about *publishing*, not about carrying a claim
   * across. For a `wiki_fact` there is a second destination: Kinetix stages it as
   * a pending edit and leaves it in the `/review` queue, where a human does the
   * verification the assistant could not. So an unread source stops being fatal
   * there and becomes the marker that routes the item — the returned key list is
   * what the store reads to decide `review` over `ready`.
   *
   * It stays fatal for a `parameter_observation` and a `topic_page_proposal`.
   * A parameter observation is written straight into `parameter_entries` and
   * folded into a recomputed aggregate — there is no queued form of that write
   * on this path — and a whole new page is too much unverified content to hand
   * a reviewer as one checkbox. Those claims still belong in `blockedCandidates`.
   */
  const resolveSourceKeys = (
    keys: string[],
    where: string,
    itemType: IngestionItem['type'],
  ): string[] => {
    const unverified: string[] = [];
    for (const key of keys) {
      const source = byKey.get(key);
      if (!source) {
        errors.push('undeclared_source_key', where, { key });
        continue;
      }
      referenced.add(key);
      if (source.verification.readInFull) continue;
      if (itemType === 'wiki_fact') unverified.push(key);
      else errors.push('source_not_read_in_full', where, { key, itemType });
    }
    return unverified;
  };

  // ── Items ──
  doc.items.forEach((item, i) => {
    const where = `items[${i}] (${item.type})`;
    if (item.type === 'parameter_observation') {
      checkParameterItem(item, where, errors, warnings);
      resolveSourceKeys([item.sourceKey], where, item.type);
    } else if (item.type === 'wiki_fact') {
      checkWikiFactItem(item, where, errors, warnings);
      const unverified = resolveSourceKeys(item.sourceKeys, where, item.type);
      // Not an error, but the most consequential thing about the row: it will
      // NOT be published on apply. Say so on the way in, so an operator reading
      // the CLI output knows before the gate tells them again.
      if (unverified.length > 0) {
        warnings.push('item_unverified_sources', where, {
          keys: unverified.map((key) => `"${key}"`).join(', '),
          count: unverified.length,
        });
      }
    } else {
      item.sections.forEach((section, si) =>
        section.facts.forEach((fact, fi) =>
          resolveSourceKeys(
            fact.sourceKeys,
            `${where}.sections[${si}].facts[${fi}]`,
            item.type,
          ),
        ),
      );
      warnings.push('new_topic_page', where, { rationale: item.rationale });
    }
  });

  checkCorroboration(doc.items, doc.sources, warnings);

  for (const source of sources) {
    if (!referenced.has(source.key)) {
      warnings.push('source_uncited', `sources[${source.key}]`);
    }
    if (source.pdfRequestNeeded && source.verification.readInFull) {
      warnings.push('pdf_request_with_read_in_full', `sources[${source.key}]`);
    }
  }

  const blockedCandidates = doc.blockedCandidates ?? [];
  if (doc.items.length === 0 && blockedCandidates.length === 0) {
    errors.push('empty_bundle', '(root)');
  }

  // Mode is a declaration about scope; an item outside it means the model
  // ignored the operator's restriction.
  const modeAllows: Record<IngestionMode, ReadonlyArray<IngestionItem['type']>> =
    {
      auto: ['parameter_observation', 'wiki_fact', 'topic_page_proposal'],
      parameters: ['parameter_observation'],
      wiki: ['wiki_fact', 'topic_page_proposal'],
      monograph: ['wiki_fact'],
    };
  doc.items.forEach((item, i) => {
    if (!modeAllows[doc.mode].includes(item.type)) {
      errors.push('item_type_not_in_mode', `items[${i}]`, {
        itemType: item.type,
        mode: doc.mode,
      });
    }
    if (
      doc.mode === 'monograph' &&
      item.type === 'wiki_fact' &&
      item.target.pageType !== 'monograph'
    ) {
      errors.push('monograph_mode_topic_fact', `items[${i}]`);
    }
  });

  if (errors.length) {
    return {
      ok: false,
      errors: errors.messages,
      errorDetails: errors.details,
      warnings: warnings.messages,
      warningDetails: warnings.details,
    };
  }

  return {
    ok: true,
    warnings: warnings.messages,
    warningDetails: warnings.details,
    data: {
      schemaVersion: CONVERSATION_INGESTION_SCHEMA_VERSION,
      idempotencyKey: doc.idempotencyKey,
      mode: doc.mode,
      conversationDigest: doc.conversationDigest.toLowerCase(),
      createdAt: doc.createdAt,
      sources,
      items: doc.items as IngestionItem[],
      blockedCandidates,
    },
  };
}

/**
 * The keys of the sources an item cites that were NOT read in full.
 *
 * The single definition of "unverified" for this contract. The validator uses it
 * to warn on the way in and the write path uses it to route the item to the
 * review queue instead of publishing it, so the document an operator validates
 * and the plan the gate renders can never disagree about which rows are which.
 *
 * Deliberately reads the BUNDLE's attestation and nothing else. A paper may well
 * carry a read-in-full review by someone else in Kinetix, but that review says
 * somebody read the paper — not that this statement is what the paper reports.
 * Only the assistant's own attestation can say that, so an existing review never
 * promotes an unverified claim, and the routing stays stable between Analyse and
 * Apply.
 */
export function unverifiedSourceKeys(
  item: IngestionItem,
  sources: ReadonlyArray<IngestionSource>,
): string[] {
  if (item.type !== 'wiki_fact') return [];
  const unread = new Set(
    sources.filter((s) => !s.verification.readInFull).map((s) => s.key),
  );
  return item.sourceKeys.filter((key) => unread.has(key));
}

/** Monograph section ids, re-exported so the skill reference has one origin. */
export { MONOGRAPH_SECTION_IDS };
export type { MonographSectionId };
