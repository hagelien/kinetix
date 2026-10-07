import { z } from 'zod';
import type { ReferenceMetadata } from './reference-metadata.js';
import { REJECTION_REASONS } from '../../src/lib/rejectionReasons.js';
import { sourceQuoteSchema } from '../../src/lib/parameterEntries.js';
import { MODEL_TIERS } from '../../src/lib/modelTiers.js';
import {
  DISPUTED_CLAIM_MAX_CHARS,
  DISPUTED_CLAIM_MIN_CHARS,
  normalizeClaimText,
} from '../../src/lib/disputedClaim.js';
import { DRUG_PARAMETERS } from '../../src/lib/drugParameters.js';
import { isReservedEditSummary } from './cache-revision-codes.js';
import { isAgentWorkTarget } from './agent-work-targets.js';
import {
  normalizeHandleIdentifier,
  resolverHandleFromUrl,
} from '../../src/lib/citationHandles.js';

/**
 * A human- or agent-authored edit summary. The `auto:param_entries_*` prefix is
 * reserved for the aggregate cache's own revisions, so a caller cannot forge a
 * summary that later tooling would mistake for one.
 */
function humanEditSummary(max: number, trim: boolean) {
  const base = trim ? z.string().trim().max(max) : z.string().max(max);
  return base.refine((v) => !isReservedEditSummary(v), {
    message: 'editSummary may not start with the reserved prefix "auto:param_entries_"',
  });
}

// Per-language drug names. At least one language entry is required. Keys are
// BCP-47 language codes (lowercase); values are the localized name. Empty
// string values are stripped at normalization time, not by zod.
export const drugNamesSchema = z
  .record(z.string().min(2).max(10), z.string().min(1).max(300))
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one language name is required',
  });

export const drugAliasesSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(50);

// Mirror the parameter spec's bounds for molecularWeight (#302 P2). The
// JSONB-backed drug_parameters store no longer carries a numeric(10,4)
// cap, so reject extreme values at the API edge.
const newDrugMolecularWeightSchema =
  DRUG_PARAMETERS.molecularWeight.kind === 'number'
    ? z.number().positive().max(DRUG_PARAMETERS.molecularWeight.bounds.max)
    : z.number().positive();

export const newDrugFieldsSchema = z.object({
  names: drugNamesSchema,
  nameShort: z.string().max(50).optional(),
  aliases: drugAliasesSchema.optional(),
  pubchemCid: z.number().int().positive().optional(),
  molecularWeight: newDrugMolecularWeightSchema.optional(),
});

export const createPageSchema = z.object({
  title: z.string().min(1).max(500),
  content: z.any(),
  pageType: z
    .enum(['drug_monograph', 'topic', 'entity_monograph'])
    .default('topic'),
  drugCid: z.number().int().positive().optional(),
  parentId: z.number().int().positive().optional(),
  categoryIds: z.array(z.number().int().positive()).optional(),
  editSummary: humanEditSummary(500, false).optional(),
  status: z.enum(['draft', 'published']).default('published'),
  submitForReview: z.boolean().optional(),
  // Monograph creation may optionally include a new drug row + initial PK
  // parameter values. Validated further in the route handler.
  newDrug: newDrugFieldsSchema.optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
  parametersReferenceId: z.number().int().positive().optional(),
});

export type NewDrugFields = z.infer<typeof newDrugFieldsSchema>;

export const updatePageSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  content: z.any().optional(),
  pageType: z.enum(['drug_monograph', 'topic', 'entity_monograph']).optional(),
  drugCid: z.number().int().positive().nullable().optional(),
  parentId: z.number().int().positive().nullable().optional(),
  categoryIds: z.array(z.number().int().positive()).optional(),
  editSummary: humanEditSummary(500, false).optional(),
  status: z.enum(['draft', 'published']).optional(),
  submitForReview: z.boolean().optional(),
  /**
   * Client-supplied version snapshot for optimistic concurrency: the
   * `wiki_pages.updated_at` value the editor loaded before authoring the
   * payload. When present, the server predicates the save on this value
   * so a page that a merge (or another editor) already committed
   * BEFORE this request arrived — a case a server-side re-read cannot
   * detect on its own, because the fresh SELECT returns the post-merge
   * timestamp and would compare it against itself — returns 409
   * wiki_page_changed instead of restoring the stale payload. ISO 8601
   * timestamp string; `null`/omitted falls back to the server snapshot
   * and closes only the same-transaction race.
   */
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

// ─── Drug parameter edit schemas ────────────────────────────────────────────

export const updateDrugParameterSchema = z.object({
  value: z.any(), // Validated against the registry spec at the route layer
  editSummary: humanEditSummary(500, false).optional(),
  // The verbatim sentence, table cell or figure caption the proposed value was
  // read off, quoted from the cited source. Stored on the pending edit's
  // `proposed_meta` rather than on the value, because a drug-parameter value is
  // a bare NumericRange with nowhere to carry one; the equivalent field on a
  // parameter ENTRY is `quote`, which is durable provenance on the entry row.
  //
  // Optional here, and enforced only where it matters: agent-consensus
  // auto-apply withholds publication of a calculation-driving parameter that
  // carries no quote (highRiskEditLacksSourceQuote). A human moderator may
  // still approve without one.
  sourceQuote: sourceQuoteSchema,
  // Optional at the schema layer: identity/constant metadata params (names,
  // aliases, molecular mass, PubChem CID) may be saved without a source. The
  // route enforces a reference for every other (pharmacokinetic) parameter.
  referenceId: z.number().int().positive().optional(),
  referenceIds: z.array(z.number().int().positive()).min(1).optional(),
  submitForReview: z.boolean().optional(),
});

export const postDiscussionSchema = z.object({
  body: z.string().min(1).max(5000),
  parentId: z.number().int().positive().optional(),
});

// Which routine a run executed — the workflow level of the tiered design
// (docs/superpowers/specs/2026-08-24-tiered-agent-cost-architecture.md §A),
// kept apart from the capability tier, which the server snapshots itself.
export const AGENT_RUN_WORKFLOWS = [
  'producer', // T1 hourly cycle, agents/drug-db-maintainer.md
  'escalation', // T2 blind verifier, agents/drug-db-escalation.md
  'adjudication', // T3 panel, agents/drug-db-adjudication.md
  'evaluator', // agents/comment-and-fact-evaluator.md
  'extraction', // agents/paper-fact-extractor.md
  'other',
] as const;
export const AGENT_RUN_RUNTIMES = ['claude-code', 'codex'] as const;
// A scheduled run is one cycle; a day is far beyond any real one.
export const AGENT_RUN_MAX_DURATION_MS = 24 * 60 * 60_000;

// One run's token usage (POST /api/agent-run-usage). Counts come from the
// runner's transcript via scripts/kinetix-log-run-usage.ts; model_tier is not
// accepted here — the server snapshots it from agents.model_tier.
const tokenCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const tokenCounts = z
  .object({
    inputTokens: tokenCount,
    outputTokens: tokenCount,
    cacheCreationTokens: tokenCount,
    cacheReadTokens: tokenCount,
  })
  .strict();
export const createAgentRunUsageSchema = z
  .object({
    workflow: z.enum(AGENT_RUN_WORKFLOWS),
    runtime: z.enum(AGENT_RUN_RUNTIMES),
    model: z.string().max(80).nullable().optional(),
    sessionId: z.string().min(1).max(128).nullable().optional(),
    startedAt: z.string().datetime().nullable().optional(),
    durationMs: z.number().int().min(0).nullable().optional(),
    inputTokens: tokenCount,
    outputTokens: tokenCount,
    cacheCreationTokens: tokenCount,
    cacheReadTokens: tokenCount,
    // The same totals split by the model that spent them (a subagent may run
    // a cheaper model), so the report can price each at its own rate.
    modelUsage: z
      .record(z.string().min(1).max(80), tokenCounts)
      .refine((m) => Object.keys(m).length <= 50, 'At most 50 models per run')
      .nullable()
      .optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict()
  // The logger reads a real transcript, but the endpoint cannot tell its POST
  // from a hand-written one, so reject rows no transcript could produce: a
  // run that spent nothing, a per-model split that does not add up to the
  // totals (which would let the report price the tokens at a cheaper model),
  // a headline model missing from its own split, and timing in the future.
  .superRefine((d, ctx) => {
    const fields = [
      'inputTokens',
      'outputTokens',
      'cacheCreationTokens',
      'cacheReadTokens',
    ] as const;
    if (fields.every((f) => d[f] === 0)) {
      ctx.addIssue({ code: 'custom', message: 'A run must report token usage' });
    }
    const shares = Object.entries(d.modelUsage ?? {});
    if (shares.length > 0) {
      for (const f of fields) {
        const sum = shares.reduce((n, [, c]) => n + c[f], 0);
        if (sum !== d[f]) {
          ctx.addIssue({
            code: 'custom',
            path: ['modelUsage'],
            message: `modelUsage ${f} must sum to the run total`,
          });
        }
      }
      if (d.model && !shares.some(([m]) => m === d.model)) {
        ctx.addIssue({
          code: 'custom',
          path: ['model'],
          message: 'model must be one of the modelUsage entries',
        });
      }
    }
    const skewMs = 5 * 60_000;
    const now = Date.now();
    const started = d.startedAt ? Date.parse(d.startedAt) : null;
    if (d.durationMs != null && d.durationMs > AGENT_RUN_MAX_DURATION_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['durationMs'],
        message: 'durationMs exceeds the longest plausible run',
      });
    }
    if (started != null && started + (d.durationMs ?? 0) > now + skewMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['startedAt'],
        message: 'A run cannot start or end in the future',
      });
    }
  });


export const createVerificationLogSchema = z
  .object({
    targetType: z.enum([
      'parameter',
      'monograph_fact',
      'discussion_sweep',
      'rejection_review',
      'paper_review',
      // One row per paper fact-extraction run (agents/paper-fact-extractor.md
      // §6). `targetId` is the citation the run read; an empty-queue run logs
      // a `no_change` row with no target.
      'paper_extraction',
    ]),
    targetId: z.number().int().positive().nullable().optional(),
    parameter: z.string().max(60).nullable().optional(),
    sourcesConsultedCount: z.number().int().min(0).optional(),
    concordance: z
      .enum(['strong', 'moderate', 'weak', 'absent'])
      .nullable()
      .optional(),
    outcome: z.enum([
      'submitted_pending',
      'flagged',
      'commented_only',
      'no_change',
    ]),
    // The `rejection_review` row (§2.A pre-cycle learning) stores the ENTIRE
    // merged cross-agent lessons ledger here — the durable shared memory read
    // by every agent — not a one-line summary like the other target types. A
    // fully-populated ~12-rule ledger with concrete, drug-specific rules
    // routinely exceeds 2000 characters, so a tight cap turned a soft
    // authoring overshoot into a hard 400 that halts the whole cycle at
    // pre-cycle learning and can never recover (the watermark never advances).
    // The DB column (`verification_log.agent_notes`) is unbounded TEXT; keep a
    // generous bound only to reject runaway payloads.
    agentNotes: z.string().max(20000).nullable().optional(),
  })
  .strict()
  /**
   * An `absent` parameter verification is the only log row that *does*
   * something: the gap queue suppresses the pair for `ABSENT_RECHECK_DAYS` by
   * matching `target_id` and `parameter`. A row missing either, or naming a
   * target the registries do not have, matches nothing — so the agent gets
   * a 200, believes it recorded "no literature exists", and the queue serves
   * the same gap on the next cycle. That is the original benzoylecgonine bug
   * re-entering through the mechanism meant to fix it, and it would look like
   * a successful audit trail the whole time.
   *
   * The accepted set is every AGENT WORK TARGET, not just the parameter
   * registry: the queue's coverage lane serves `metabolism` and
   * `pharmacodynamics` through the same absent-cooldown predicate, so
   * refusing their ids here would leave the one state that suppresses an
   * exhausted search unwritable for exactly the two areas whose searches are
   * longest — the loop again, on the lane added to close it.
   *
   * Only `absent` parameter rows are constrained. The other target types and
   * outcomes are pure audit records with no matching predicate behind them —
   * a `no_change` sweep row legitimately has no target at all.
   */
  .superRefine((v, ctx) => {
    if (v.targetType !== 'parameter' || v.concordance !== 'absent') return;
    if (typeof v.targetId !== 'number') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetId'],
        message:
          'An absent parameter verification must name the drug it searched for; without targetId the gap is not suppressed and will be re-served next cycle.',
      });
    }
    if (!v.parameter || !isAgentWorkTarget(v.parameter)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['parameter'],
        message:
          'An absent parameter verification must name a registry parameter or coverage area; an unknown or missing name matches nothing and the gap will be re-served next cycle.',
      });
    }
  });

// ─── Interaction tracking ───────────────────────────────────────────────────

export const trackInteractionSchema = z.object({
  eventType: z.enum(['view', 'wiki_open', 'simulator_open', 'edit']),
});

// ─── Auth / allowlist ───────────────────────────────────────────────────────

export const requestMagicLinkSchema = z.object({
  email: z.string().email().max(255),
  stayLoggedIn: z.boolean().optional(),
});

export const verifyCodeSchema = z.object({
  email: z.string().email().max(255),
  code: z
    .string()
    .length(6)
    .regex(/^\d{6}$/, 'Code must be 6 digits'),
  // Optional: if provided, updates sessionMaxDays on successful auth.
  // Omitting it preserves the user's existing sessionMaxDays rather than
  // applying a default — this is intentional so callers that don't track
  // the preference don't silently reset it.
  stayLoggedIn: z.boolean().optional(),
});

export const addAllowedDomainSchema = z.object({
  domain: z
    .string()
    .min(3)
    .max(253)
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'Invalid domain'),
});

export const addAllowedEmailSchema = z.object({
  email: z.string().email().max(255),
});

export const createUserGroupSchema = z
  .object({
    name: z.string().min(1).max(200),
    slug: z
      .string()
      .min(1)
      .max(100)
      .transform((v) => v.toLowerCase())
      .pipe(z.string().regex(/^[a-z0-9-]+$/))
      .optional(),
    description: z.string().max(2000).optional(),
  })
  .strict();

export const patchUserGroupMembersSchema = z
  .object({
    userIds: z.array(z.number().int().positive()).max(500),
  })
  .strict();

// ─── References (citations / sources) ──────────────────────────────────────

// PubMed IDs are positive integers up to ~8 digits (current max is ~38 million,
// so 8 digits covers all real IDs with headroom). Blocking non-numeric strings
// prevents unnecessary round-trips to the NCBI eutils API.
const PMID_RE = /^\d{1,8}$/;

// DOI prefix format per ISO 26324: "10." followed by ≥4 registrant digits,
// then "/" and a non-empty suffix. Blocking malformed strings avoids sending
// garbage to the CrossRef API and narrows the accepted input surface.
const DOI_RE = /^10\.\d{4,}\/.+/;

/**
 * The http/https test `validateReferenceIdentifier` applies to a `url`
 * identifier, as a plain predicate. That validator reports the two failure
 * modes separately (unparseable vs. wrong protocol) because the caller is
 * fixing one identifier; an alt handle only needs the verdict.
 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateReferenceIdentifier(
  data: { type: string; identifier: string },
  ctx: z.RefinementCtx,
): void {
  if (data.type === 'url') {
    let parsed: URL;
    try {
      parsed = new URL(data.identifier);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'URL identifier must be a valid absolute URL',
        path: ['identifier'],
      });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'URL identifier must use http or https',
        path: ['identifier'],
      });
    }
    return;
  }

  if (data.type === 'pmid' && !PMID_RE.test(data.identifier)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'PubMed ID must be a positive integer up to 8 digits',
      path: ['identifier'],
    });
    return;
  }

  if (data.type === 'doi' && !DOI_RE.test(data.identifier)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'DOI must start with "10." followed by a registrant code and suffix (e.g. 10.1000/xyz123)',
      path: ['identifier'],
    });
  }
}

/**
 * Canonicalize a `pmid`/`doi` identifier before it is validated, so the same
 * paper submitted in any of its common spellings lands on one row and reaches
 * the resolver in the shape CrossRef/PubMed expect. Users routinely paste the
 * resolver URL (`https://doi.org/10.…`, `https://pubmed.ncbi.nlm.nih.gov/…`) or
 * a `doi:`/`PMID:` wrapper straight out of a journal page; without this the raw
 * string fails `DOI_RE`/`PMID_RE` and the request 400s — which the picker
 * surfaces as a bare "network error".
 *
 * A pasted resolver URL is unwrapped with `resolverHandleFromUrl` first: it
 * decodes the path (so an encoded slash survives) and drops the tracking query
 * string or `#` fragment that would otherwise ride into the identifier and
 * break the CrossRef/PubMed lookup — `normalizeHandleIdentifier`'s prefix strip
 * alone cannot do that. The unwrapped handle is only adopted when it points at
 * the same type as the tab the user is on; a mismatched paste (a PubMed URL in
 * the DOI tab) falls through to prefix normalization and fails validation
 * rather than silently switching the citation's type. `url`/`freetext`
 * identifiers are left untouched (nothing else is safe to assume for them).
 * This mirrors the normalization already applied to alt ids.
 */
function normalizeReferenceIdentifier<
  T extends { type: string; identifier: string },
>(data: T): T {
  if (data.type !== 'pmid' && data.type !== 'doi') return data;
  const fromUrl = resolverHandleFromUrl(data.identifier);
  if (fromUrl && fromUrl.type === data.type) {
    // Fold through the same canonicalizer as every other spelling: the URL
    // parser returns a PMID with its path digits intact (`/01234567/` →
    // `01234567`), so without this a zero-padded resolver URL would not match
    // the cache row keyed under `1234567` that `PMID: 01234567` produces. It is
    // idempotent for the already-clean DOI the parser returns.
    return {
      ...data,
      identifier: normalizeHandleIdentifier(data.type, fromUrl.identifier),
    };
  }
  return {
    ...data,
    identifier: normalizeHandleIdentifier(data.type, data.identifier),
  };
}

export const resolveReferenceSchema = z
  .object({
    type: z.enum(['freetext', 'url', 'pmid', 'doi']),
    identifier: z.string().min(1).max(2000),
  })
  .transform(normalizeReferenceIdentifier)
  .superRefine(validateReferenceIdentifier);

const referenceMetadataObjectSchema = z
  .object({
    title: z.string().optional(),
    authors: z.array(z.string()).optional(),
    journal: z.string().optional(),
    year: z.number().int().nullable().optional(),
    volume: z.string().nullable().optional(),
    pages: z.string().nullable().optional(),
    // The handles this paper is not filed under (#1018). Accepted on the write
    // boundary so a caller that already knows the crosswalk can hand it over;
    // the store re-derives and re-normalizes it either way.
    altIds: z
      .object({
        pmid: z.string().max(20).optional(),
        doi: z.string().max(200).optional(),
        pmcid: z.string().max(20).optional(),
        url: z.string().max(2000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  // An alt handle is a canonicalization candidate, not a note: `resolveCitation`
  // files the paper under the strongest handle it is given, so a caller posting
  // a valid DOI with `altIds.pmid: "not-a-pmid"` would otherwise promote the row
  // into a `pmid` identifier that resolves to nothing. Held to the same shape as
  // the top-level identifier of that type. The store drops malformed alt ids
  // regardless (`normalizeAltIds`); rejecting here is what turns a silently
  // ignored field into a 400 the caller can act on.
  .superRefine((data, ctx) => {
    for (const [key, value] of Object.entries(data.altIds ?? {})) {
      if (typeof value !== 'string' || value.trim() === '') continue;
      const identifier = normalizeHandleIdentifier(key, value);
      const valid =
        key === 'pmid'
          ? PMID_RE.test(identifier)
          : key === 'doi'
            ? DOI_RE.test(identifier)
            : key === 'pmcid'
              ? /^PMC\d+$/.test(identifier)
              : isHttpUrl(identifier);
      if (!valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `metadata.altIds.${key} is not a valid ${key}`,
          path: ['altIds', key],
        });
      }
    }
  });

export const createReferenceSchema = z
  .object({
    drugId: z.number().int().positive().nullable().optional(),
    type: z.enum(['freetext', 'url', 'pmid', 'doi']),
    identifier: z.string().min(1).max(2000),
    metadata: referenceMetadataObjectSchema.nullable().optional() as z.ZodType<
      ReferenceMetadata | null | undefined
    >,
  })
  .transform(normalizeReferenceIdentifier)
  .superRefine(validateReferenceIdentifier);

// Correct or refresh the cached metadata of an existing citation. The citation
// is addressed by id (query param), so the body carries only the change:
//   - refresh:true  — re-resolve from the row's own pmid/doi via PubMed/CrossRef
//                     (the authoritative path; no agent-supplied values trusted).
//   - metadata:{…}  — explicit override, for url/freetext rows or when the
//                     upstream record itself is wrong.
// At least one must be present. Both together resolve authoritatively and use
// the supplied fields only to fill gaps the resolver leaves.
export const updateReferenceSchema = z
  .object({
    refresh: z.boolean().optional(),
    metadata: referenceMetadataObjectSchema.nullable().optional() as z.ZodType<
      ReferenceMetadata | null | undefined
    >,
  })
  .strict()
  .refine((d) => d.refresh === true || d.metadata !== undefined, {
    message: 'Provide refresh:true or a metadata object to update',
  });

export const createPaperReviewSchema = z
  .object({
    reviewMarkdown: z.string().min(1).max(50000),
    overallScore: z.number().int().min(0).max(100).optional(),
    conclusionSupport: z.string().max(30).optional(),
    reviewConfidence: z.enum(['high', 'medium', 'low']).optional(),
    // Explicit attestation that the reviewer read the paper in full. Required:
    // a fact or parameter may only cite a resolvable reference whose review
    // makes this claim. Reviewers without full text must file a PDF request
    // instead of attesting (readInFull: false is allowed but won't satisfy
    // the reference gate).
    readInFull: z.boolean(),
    // Why this (re-)review was made, in the author's language (Norwegian
    // bokmål). Recorded verbatim on the revision-history row so humans and
    // agents can see the reason for each change. Omit / empty on a first review.
    editSummary: humanEditSummary(500, true).optional(),
  })
  .strict();

// ─── PDF requests & fulfilment ─────────────────────────────────────────────

export const createPdfRequestSchema = z
  .object({
    reason: z.string().max(500).optional(),
    /**
     * Reopen a request for a citation that ALREADY has full text on file, so
     * the stored PDF can be replaced.
     *
     * Normally an existing `citation_pdfs` row means the request is satisfied
     * and re-filing is refused — that guard exists because the review agent
     * re-files on every paywalled pass and would otherwise resurface papers a
     * contributor had already supplied. But a stored PDF can be the *wrong*
     * paper, or a scan with no readable text, and until this flag existed
     * there was no path in the app to swap it: the upload token requires an
     * open request, and no open request could be created. `recordCitationPdf`
     * has always upserted on `citation_id`, so only the gate was missing.
     *
     * Editor+ only (enforced at the route): replacing full text discards the
     * previous asset, which is not a contributor-tier action.
     */
    replace: z.boolean().optional(),
  })
  .strict();

export const submitPdfUrlSchema = z
  .object({
    url: z.string().min(1).max(2000),
  })
  .strict()
  .superRefine((data, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(data.url);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'url must be a valid absolute URL',
        path: ['url'],
      });
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'url must use http or https',
        path: ['url'],
      });
    }
  });

// ─── Paper fact-extraction queue ───────────────────────────────────────────
//
// Editors/admins enqueue an uploaded full-text paper; a scheduled agent claims
// a job, reads the PDF, and reports back what it filed. See
// src/lib/paperExtraction.ts for the state machine and agents/
// paper-fact-extractor.md for the run contract.

export const createPaperExtractionSchema = z
  .object({
    // Free-text steer for the run ("only the postmortem cohort", "this is
    // about the metabolite, not the parent"). Passed to the agent as data.
    scopeNote: z.string().trim().max(1000).optional(),
    // Advisory hint only — the agent still decides where each fact belongs.
    // Bounded because a paper that touches 20 drugs is a review article, and
    // the queue is for primary sources.
    targetDrugIds: z.array(z.number().int().positive()).max(20).optional(),
  })
  .strict();

export type CreatePaperExtractionPayload = z.infer<
  typeof createPaperExtractionSchema
>;

/**
 * The token minted for this claim, returned by the claim/resume responses.
 * Required on every run outcome: it proves the caller is the *current* run,
 * which the agent's user id cannot, since one agent identity runs on a
 * schedule and a dead run shares its id with the run that replaced it.
 */
const claimTokenSchema = z.string().trim().length(32);

export const updatePaperExtractionSchema = z
  .discriminatedUnion('action', [
    z
      .object({
        action: z.literal('complete'),
        claimToken: claimTokenSchema,
        // The run's own account of what it filed. Norwegian, reader-facing:
        // it is shown to the editor who queued the paper.
        resultSummary: z.string().trim().min(1).max(4000),
        factsSubmitted: z.number().int().min(0).max(500),
        // The pending_edits rows created, so a reviewer can jump straight to
        // the queue items this paper produced. Zero is legal and meaningful:
        // "I read it and it yielded nothing citable" is a real outcome.
        pendingEditIds: z
          .array(z.number().int().positive())
          .max(500)
          .optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal('fail'),
        claimToken: claimTokenSchema,
        // Why the run could not finish — a scanned PDF with no text layer, a
        // paper that turned out to be a conference abstract, an extractor
        // that is missing from the runner image.
        error: z.string().trim().min(1).max(2000),
      })
      .strict(),
    z
      .object({ action: z.literal('release'), claimToken: claimTokenSchema })
      .strict(),
    z
      .object({
        action: z.literal('cancel'),
        reason: z.string().trim().max(500).optional(),
      })
      .strict(),
    z.object({ action: z.literal('requeue') }).strict(),
  ]);

export type UpdatePaperExtractionPayload = z.infer<
  typeof updatePaperExtractionSchema
>;

// ─── Pending edits (approval workflow) ────────────────────────────────────

const factTargetAnchorSchema = z
  .object({ factId: z.string().min(1).max(64) })
  .strict();

// ─── wiki_section payload schemas (issue #349) ─────────────────────────────
// One discriminated shape per `proposedMeta.operation` value. The
// section anchor for edit/reorder/remove travels in the top-level
// `sectionId` column (same column already used by wiki_fact); the
// operation discriminator and op-specific payload live in
// `proposedValue`. The DB column for editType is varchar(20) so no
// migration is needed — existing rows for other editTypes are unaffected.
export const wikiSectionAddPayloadSchema = z
  .object({
    operation: z.literal('add'),
    headingText: z.string().min(1).max(200),
    headingLevel: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    position: z.number().int().nonnegative().max(1000),
  })
  .strict();
export const wikiSectionEditPayloadSchema = z
  .object({
    operation: z.literal('edit'),
    headingText: z.string().min(1).max(200),
  })
  .strict();
export const wikiSectionReorderPayloadSchema = z
  .object({
    operation: z.literal('reorder'),
    position: z.number().int().nonnegative().max(1000),
  })
  .strict();
export const wikiSectionRemovePayloadSchema = z
  .object({
    operation: z.literal('remove'),
    /**
     * #360: when true, approval cascade-rejects every pending wiki_fact
     * for this section AND strips existing fact nodes from the section
     * body before splicing it out. When false / omitted, removal is
     * refused if the section contains any fact node — same as the
     * pre-#360 behavior. Reviewers see the cascade flag in the
     * pending-edit card so they can decline if they want to preserve
     * the facts elsewhere.
     */
    cascade: z.boolean().optional(),
  })
  .strict();

export const wikiSectionPayloadSchema = z.discriminatedUnion('operation', [
  wikiSectionAddPayloadSchema,
  wikiSectionEditPayloadSchema,
  wikiSectionReorderPayloadSchema,
  wikiSectionRemovePayloadSchema,
]);

export type WikiSectionPayload = z.infer<typeof wikiSectionPayloadSchema>;

// ─── Metabolism edits (editType='metabolism') ──────────────────────────────
// Full-replace payload for a drug's metabolism box: the profile (enzymes,
// elimination routes, fate fractions) plus its metabolite and precursor
// links. Submitted via PUT /api/drug-metabolism, queued as a pending edit,
// and re-validated here at approval time (defense-in-depth, like wiki_new).
// Fractions are stored 0–1; the form collects percentages and divides.
const metabolismActivitySchema = z.enum(['active', 'inactive', 'unknown']);
const metabolismFractionScalar = z.number().min(0).max(1);

// A metabolism quantity is a 0–1 range: `{ min, median, max }`, any field
// optional. `median` is the representative central value (mean folds into it
// when no median is given). Accepts a bare number for backward compatibility
// with already-queued pending edits that stored a single fraction; it
// normalizes to `{ min: null, median: n, max: null }`. Output is always the
// canonical `{ min, median, max }` (nulls for absent fields) or null.
const metabolismFractionRangeObject = z
  .object({
    min: metabolismFractionScalar.nullable().optional(),
    median: metabolismFractionScalar.nullable().optional(),
    mean: metabolismFractionScalar.nullable().optional(),
    max: metabolismFractionScalar.nullable().optional(),
  })
  .transform((v) => ({
    min: v.min ?? null,
    median: v.median ?? v.mean ?? null,
    max: v.max ?? null,
  }))
  .refine((v) => v.min == null || v.max == null || v.min <= v.max, {
    message: 'Fraction min must be ≤ max',
  })
  .refine((v) => v.median == null || v.min == null || v.min <= v.median, {
    message: 'Fraction min must be ≤ median',
  })
  .refine((v) => v.median == null || v.max == null || v.median <= v.max, {
    message: 'Fraction median must be ≤ max',
  });

const metabolismFractionSchema = z
  .union([metabolismFractionScalar, metabolismFractionRangeObject])
  .transform((v) =>
    typeof v === 'number' ? { min: null, median: v, max: null } : v,
  );

const metabolismReferenceIds = z
  .array(z.number().int().positive())
  .max(50)
  .nullable()
  .optional();

export const metabolismMetaboliteSchema = z.object({
  metaboliteName: z.string().trim().min(1).max(300),
  // Optional link to an existing monograph; null/absent keeps it free-text.
  metaboliteDrugId: z.number().int().positive().nullable().optional(),
  conversionFraction: metabolismFractionSchema.nullable().optional(),
  activity: metabolismActivitySchema.default('unknown'),
  evidenceNote: z.string().trim().max(2000).nullable().optional(),
  referenceIds: metabolismReferenceIds,
});

export const metabolismPrecursorSchema = z.object({
  // Precursors are stored as the reverse of a metabolite link, so the parent
  // (precursor) must be an existing drug — there is no free-text variant.
  precursorDrugId: z.number().int().positive(),
  // Display-only label carried through so review cards / queues can name the
  // precursor without an extra lookup; ignored when the edit is applied.
  precursorName: z.string().trim().max(300).optional(),
  conversionFraction: metabolismFractionSchema.nullable().optional(),
  activity: metabolismActivitySchema.default('unknown'),
  evidenceNote: z.string().trim().max(2000).nullable().optional(),
  referenceIds: metabolismReferenceIds,
});

// One elimination/metabolism route: an enzyme (optionally linked to a
// canonical enzymes row) or an unchanged-excretion route. `fraction` is the
// 0–1 share of dose; `label` is the free-text enzyme name / "other" route
// description carried for display and unmatched enzymes.
export const eliminationRouteKindSchema = z.enum([
  'enzyme',
  'metabolized',
  'renal_unchanged',
  'fecal_biliary',
  'other_unchanged',
]);

export const eliminationRouteSchema = z.object({
  kind: eliminationRouteKindSchema,
  enzymeId: z.number().int().positive().nullable().optional(),
  label: z.string().trim().max(200).nullable().optional(),
  fraction: metabolismFractionSchema.nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  referenceIds: metabolismReferenceIds,
});

// Profile is now just the box-level note; per-route fates live on `routes`.
export const metabolismProfileSchema = z.object({
  evidenceNote: z.string().trim().max(2000).nullable().optional(),
  referenceIds: metabolismReferenceIds,
});

export const metabolismWriteSchema = z.object({
  profile: metabolismProfileSchema.default({}),
  routes: z.array(eliminationRouteSchema).max(100).default([]),
  metabolites: z.array(metabolismMetaboliteSchema).max(100).default([]),
  precursors: z.array(metabolismPrecursorSchema).max(100).default([]),
  /** Short rationale stored on the pending edit's proposedMeta. */
  editSummary: humanEditSummary(2000, true).optional(),
  /** Admins may opt their edit into the review queue instead of writing. */
  submitForReview: z.boolean().optional(),
});

export type MetabolismWritePayload = z.infer<typeof metabolismWriteSchema>;


// ─── Unified biological-entity catalog (#785, admin CRUD over bio_entities) ──
const bioEntityFunctionEnum = z.enum([
  'metabolic_enzyme',
  'drug_target',
  'transporter',
  'ion_channel',
  'biomarker',
  'structural',
]);

const bioEntityRankEnum = z.enum([
  'superfamily',
  'family',
  'subfamily',
  'gene',
  'isoform',
  'subunit',
  'variant',
  'complex',
]);

// External-id values mirror the jsonb column: strings/numbers or arrays of them.
const bioEntityExternalIdValue = z.union([
  z.string(),
  z.number(),
  z.array(z.string()),
  z.array(z.number()),
  z.null(),
]);

export const bioEntityCreateSchema = z.object({
  symbol: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().max(200).nullable().optional(),
  organism: z.string().trim().max(80).nullable().optional(),
  rank: bioEntityRankEnum.nullable().optional(),
  parentId: z.number().int().positive().nullable().optional(),
  entityClass: z.string().trim().max(60).nullable().optional(),
  externalIds: z.record(z.string(), bioEntityExternalIdValue).optional(),
  functions: z.array(bioEntityFunctionEnum).max(6).optional(),
});

export const bioEntityUpdateSchema = bioEntityCreateSchema
  .partial()
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one field is required',
  });

export type BioEntityCreatePayload = z.infer<typeof bioEntityCreateSchema>;
export type BioEntityUpdatePayload = z.infer<typeof bioEntityUpdateSchema>;

// The pure entity fields a contributor may change, used to require that an
// update request touches at least one of them (the review-flow extras below
// don't count as a change on their own).
const BIO_ENTITY_FIELD_KEYS = [
  'symbol',
  'name',
  'nameEn',
  'organism',
  'rank',
  'parentId',
  'entityClass',
  'externalIds',
  'functions',
] as const;

// Contributor write requests carry two optional review-flow extras alongside
// the entity fields: a free-text edit summary and an admin opt-in to route
// through the review queue instead of writing directly. These are stripped
// before the payload is queued so the apply-time re-validation sees only the
// entity fields (bioEntityEditSchema below).
const bioEntityWriteExtras = {
  editSummary: humanEditSummary(2000, false).optional(),
  submitForReview: z.boolean().optional(),
};

export const bioEntityCreateRequestSchema =
  bioEntityCreateSchema.extend(bioEntityWriteExtras);

export const bioEntityUpdateRequestSchema = bioEntityCreateSchema
  .partial()
  .extend(bioEntityWriteExtras)
  .refine((obj) => BIO_ENTITY_FIELD_KEYS.some((k) => obj[k] !== undefined), {
    message: 'At least one field is required',
  });

export type BioEntityCreateRequestPayload = z.infer<
  typeof bioEntityCreateRequestSchema
>;
export type BioEntityUpdateRequestPayload = z.infer<
  typeof bioEntityUpdateRequestSchema
>;

// ─── Bio-entity catalog edits routed through review (editType='bio_entity') ──
// A contributor's create/update to the shared registry is queued as a pending
// edit whose proposedValue carries the full desired change. Re-validated at
// approval time (defense-in-depth, like metabolism/receptor_targets).
export const bioEntityEditSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), entity: bioEntityCreateSchema }),
  z.object({ op: z.literal('update'), patch: bioEntityUpdateSchema }),
]);

export type BioEntityEditPayload = z.infer<typeof bioEntityEditSchema>;

// ─── Drug↔enzyme interactions (editType='enzyme_interaction', #785 Phase 6) ──
// Full-replace payload: each row links the drug to a canonical enzyme entity
// with a role (substrate / inducer / inhibitor) and optional strength.
const enzymeInteractionSchema = z.object({
  bioEntityId: z.number().int().positive(),
  role: z.enum(['substrate', 'inducer', 'inhibitor']),
  strength: z.enum(['weak', 'moderate', 'strong']).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  referenceIds: z
    .array(z.number().int().positive())
    .max(50)
    .nullable()
    .optional(),
});

export const enzymeInteractionsWriteSchema = z.object({
  interactions: z.array(enzymeInteractionSchema).max(100).default([]),
  editSummary: humanEditSummary(2000, false).optional(),
  submitForReview: z.boolean().optional(),
});

export type EnzymeInteractionsWritePayload = z.infer<
  typeof enzymeInteractionsWriteSchema
>;
export type EnzymeInteractionInput = z.infer<typeof enzymeInteractionSchema>;


// ─── Receptor-target mechanisms (editType='receptor_targets') ───────────────
// Full-replace payload for a drug's pharmacodynamic mechanisms: each row is an
// interaction at a receptor target (e.g. "antagonist at SERT"), ranked by
// tier, with optional binding/potency measurements and citations. Submitted
// via PUT /api/drug-receptor-targets, queued as a pending edit, and
// re-validated here at approval time (defense-in-depth, like metabolism).
const mechanismTierSchema = z
  .enum(['primary', 'secondary', 'tertiary'])
  .nullable()
  .optional();

// A single quantitative measurement. Empty objects are normalised to null by
// the store; bounds are intentionally permissive because units vary widely
// (nmol/L, %, fold) across affinity/potency/efficacy metrics.
const mechanismMeasurementSchema = z
  .object({
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    // `value` was split into mean + median (legacy single values → median).
    mean: z.number().finite().optional(),
    median: z.number().finite().optional(),
    unit: z.string().trim().max(40).optional(),
    note: z.string().trim().max(300).optional(),
  })
  .nullable()
  .optional();

const mechanismReferenceIds = z
  .array(z.number().int().positive())
  .max(50)
  .nullable()
  .optional();

export const receptorMechanismSchema = z
  .object({
    // Link an existing catalog target, or create one from symbol + name when
    // receptorTargetId is absent.
    receptorTargetId: z.number().int().positive().nullable().optional(),
    targetSymbol: z.string().trim().max(80).optional(),
    targetName: z.string().trim().max(200).optional(),
    interactionType: z.string().trim().min(1).max(60).default('unspecified'),
    tier: mechanismTierSchema,
    affinity: mechanismMeasurementSchema,
    potency: mechanismMeasurementSchema,
    efficacy: mechanismMeasurementSchema,
    ki: mechanismMeasurementSchema,
    ic50: mechanismMeasurementSchema,
    ec50: mechanismMeasurementSchema,
    emax: mechanismMeasurementSchema,
    selectivityRatio: mechanismMeasurementSchema,
    // Species of the preparation the measurements were made in (#1017). Free
    // text because the useful answer is often more than a binomial ("recombinant
    // human (CHO-K1)", "rat striatal membranes"). Absent/blank = unstated, which
    // is NOT the same as human: the catalog entity is human by default, and this
    // column is how a non-human measurement stays visible as such.
    assaySpecies: z.string().trim().max(80).nullable().optional(),
    referenceIds: mechanismReferenceIds,
    evidenceNote: z.string().trim().max(2000).nullable().optional(),
  })
  .refine(
    (m) =>
      (m.receptorTargetId != null) ||
      (Boolean(m.targetSymbol) && Boolean(m.targetName)),
    {
      message:
        'Each mechanism must link an existing target or provide a symbol and name to create one',
    },
  );

export const receptorTargetsWriteSchema = z.object({
  mechanisms: z.array(receptorMechanismSchema).max(100).default([]),
  /** Short rationale stored on the pending edit's proposedMeta. */
  editSummary: humanEditSummary(2000, true).optional(),
  /** Admins may opt their edit into the review queue instead of writing. */
  submitForReview: z.boolean().optional(),
});

export type ReceptorTargetsWritePayload = z.infer<
  typeof receptorTargetsWriteSchema
>;
export type ReceptorMechanismInput = z.infer<typeof receptorMechanismSchema>;

// ─── Learning-unit content schema (Task 3) ───────────────────────────────────

export const LEARNING_DIFFICULTIES = [
  'foundational',
  'intermediate_lis',
  'advanced_lis',
  'board',
  'senior',
  'research',
] as const;

export const PREREQUISITE_LEVELS = [
  'essential',
  'helpful',
  'advanced_adjacent',
  'optional_context',
] as const;

// Spec §12 Stage 10 ("cognitive skill tested"). Feeds the Phase C competence
// model: the four skill values map to the reasoning dimensions; 'factual_recall'
// maps to factual knowledge. Optional and additive — legacy questions omit it
// and fall back to their `category`.
export const COGNITIVE_SKILLS = [
  'factual_recall',
  'critical_appraisal',
  'statistical_reasoning',
  'clinical_reasoning',
  'mechanistic',
] as const;

const learningQuestionOptionSchema = z.object({
  id: z.string().trim().min(1).max(8),
  text: z.string().trim().min(1).max(600),
  isCorrect: z.boolean(),
  // Spec §7.6: every option — including wrong ones — is explained.
  explanation: z.string().trim().min(20).max(1200),
});

const learningQuestionSchema = z
  .object({
    stem: z.string().trim().min(1).max(1000),
    format: z.enum(['single_best', 'select_all']),
    category: z.enum(['factual', 'reasoned']),
    options: z.array(learningQuestionOptionSchema).min(2).max(8),
    difficulty: z.enum(LEARNING_DIFFICULTIES),
    concepts: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
    sourceSupport: z.string().trim().min(1).max(1000),
    // Phase C: optional cognitive-skill tag for the competence model.
    cognitiveSkill: z.enum(COGNITIVE_SKILLS).optional(),
  })
  .superRefine((q, ctx) => {
    const correct = q.options.filter((o) => o.isCorrect).length;
    if (q.format === 'single_best' && correct !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'single_best questions must have exactly one correct option',
        path: ['options'],
      });
    }
    if (q.format === 'select_all' && correct < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'select_all questions must have at least one correct option',
        path: ['options'],
      });
    }
    const ids = new Set(q.options.map((o) => o.id));
    if (ids.size !== q.options.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'option ids must be unique within a question',
        path: ['options'],
      });
    }
  });

// Shared between learning units and clinical cases (same prerequisite scheme,
// spec §7.x): a concept mapped to a level with a one-line "why".
const learningPrerequisiteSchema = z.object({
  concept: z.string().trim().min(1).max(80),
  level: z.enum(PREREQUISITE_LEVELS),
  why: z.string().trim().min(1).max(1000),
});

export const learningUnitContentSchema = z.object({
  sourceCard: z.object({
    whyItMatters: z.string().trim().min(1).max(2000),
    // foundational | current_consensus | historical | methodological |
    // regulatory | practice_changing | controversial | misconception_correcting
    sourceStatus: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
    estimatedReadingMinutes: z.number().int().positive().max(600),
  }),
  prerequisites: z.array(learningPrerequisiteSchema).max(40),
  preReadingPrompts: z.array(z.string().trim().min(1).max(600)).min(3).max(8),
  objectives: z.array(z.string().trim().min(1).max(600)).min(1).max(20),
  questions: z.array(learningQuestionSchema).min(10).max(80),
});

export type LearningUnitContent = z.infer<typeof learningUnitContentSchema>;

export const learningUnitMetaSchema = z.object({
  title: z.string().trim().min(1).max(500),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, and hyphens'),
  difficulty: z.enum(LEARNING_DIFFICULTIES),
  domains: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  editSummary: humanEditSummary(2000, true).optional(),
});

// ─── Clinical-case content schema (Phase D, spec §5.4) ───────────────────────
//
// A clinical case is a learning_units row with kind='clinical_case'. It reuses
// the unit's prerequisite/objective/question pieces but replaces the source card
// + pre-reading prompts with a fictional/composite scenario and a MANDATORY,
// verbatim educational-only safety notice (spec §12 Stage 12). The notice text
// is authored content (Norwegian), not an i18n key, and must be present exactly
// — a case cannot validate without it.

export const CLINICAL_CASE_SAFETY_NOTICE =
  'Kun til opplæring — ikke pasientspesifikke kliniske råd.';

export const clinicalCaseContentSchema = z.object({
  // Must equal the verbatim notice — enforced so no case can validate (or later
  // render) without the educational-only framing.
  safetyNotice: z.literal(CLINICAL_CASE_SAFETY_NOTICE),
  // The fictional/composite vignette (presentation, history, available data).
  // No real, identifiable patient data — that is an authoring-time duty the
  // schema can't police, flagged in the builder spec's self-audit.
  scenario: z.string().trim().min(1).max(5000),
  prerequisites: z.array(learningPrerequisiteSchema).max(40),
  objectives: z.array(z.string().trim().min(1).max(600)).min(1).max(20),
  // Cases are reasoning-heavy; ≥6 questions (vs ≥10 for units).
  questions: z.array(learningQuestionSchema).min(6).max(80),
  // Optional Kinetix cross-links: drugs / targets / enzymes / concepts /
  // guidelines the case touches that should link out to an existing monograph
  // or wiki page. `label` is the display text; `slug` (when present) points at
  // the wiki page to deep-link; `kind` is a free-form category tag for grouping
  // in the UI. Optional and defaulted so existing cases stay valid — authors
  // should not force weak links (builder spec).
  crossLinks: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(200),
        slug: z.string().trim().min(1).max(300).optional(),
        kind: z.string().trim().min(1).max(40).optional(),
      }),
    )
    .max(40)
    .optional()
    .default([]),
});

export type ClinicalCaseContent = z.infer<typeof clinicalCaseContentSchema>;

export const clinicalCaseMetaSchema = z.object({
  title: z.string().trim().min(1).max(500),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, and hyphens'),
  difficulty: z.enum(LEARNING_DIFFICULTIES),
  domains: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  editSummary: humanEditSummary(2000, true).optional(),
  // Clinical cases ALWAYS require a human expert moderator (never auto-apply on
  // agent consensus — enforced in code at applyOnAgentConsensus). The flag is
  // carried for the queue/UI; the code guard is the real safety mechanism.
  requiresExpertReview: z.literal(true),
});

export type ClinicalCaseMeta = z.infer<typeof clinicalCaseMetaSchema>;

export const LEARN_ATTEMPT_MODES = [
  'submit_all',
  'one_at_a_time',
  'review',
] as const;

// Phase C: a graded assessment submission. `answers` is keyed by question index
// (numeric string) → selected option ids. The server re-grades from the stored
// unit content; the client never sends correctness.
export const learnAttemptSchema = z
  .object({
    unitId: z.number().int().positive(),
    mode: z.enum(LEARN_ATTEMPT_MODES),
    answers: z
      .record(
        z.string().regex(/^\d+$/),
        z.array(z.string().trim().min(1).max(8)).max(8),
      )
      .refine((a) => Object.keys(a).length <= 80, {
        message: 'too many answers',
      }),
  })
  .strict();

export type LearnAttemptPayload = z.infer<typeof learnAttemptSchema>;

// ─────────────────────────────────────────────────────────────────────────────

/**
 * `proposed_meta` for a pending edit, with one key actually validated.
 *
 * The column is deliberately open — different edit types carry different notes
 * in it — so it has always been `z.any()`. That is fine for commentary and
 * wrong for `sourceQuote`, which is not commentary: it is the provenance the
 * consensus gate reads before deciding whether a calculation-driving value may
 * auto-publish. `/api/drug-parameter` has always parsed it through
 * `sourceQuoteSchema`; the pending-edit routes, which are the path a proposal
 * actually takes to publication, never did. So a proposal could be created or
 * revised carrying a quote the direct endpoint would have refused — one past
 * the length limit, or one carrying raw control characters — and publish with
 * it, leaving the review card and the audit record holding provenance outside
 * the contract that provenance is declared under.
 *
 * Validated HERE, in the schema, rather than at the handful of places that read
 * the key. Those places have grown from one to five over this review, and a
 * check at each of them is a check the sixth will not have. Parsing at the
 * boundary means every downstream reader — the fingerprint, the echo
 * comparison, the stale-quote rule, the stored value — sees the one canonical
 * form, and a quote that cannot be stored is a 400 rather than a surprise
 * further in.
 *
 * Everything else in the object is passed through untouched: this narrows one
 * key, it does not close the column.
 */
const proposedMetaSchema = z
  .any()
  .optional()
  .transform((meta, ctx) => {
    if (meta == null || typeof meta !== 'object' || Array.isArray(meta)) {
      return meta as unknown;
    }
    const record = meta as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, 'sourceQuote')) {
      return meta as unknown;
    }
    const parsed = sourceQuoteSchema.safeParse(record.sourceQuote);
    if (!parsed.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceQuote'],
        message:
          parsed.error.issues[0]?.message ?? 'Invalid source quote',
      });
      return z.NEVER;
    }
    // `undefined` is the key not being there, which the guard above already
    // excluded for a JSON body; keeping the object as-is rather than writing
    // the key back means silence can never be turned into an explicit clear.
    if (parsed.data === undefined) return meta as unknown;
    return { ...record, sourceQuote: parsed.data };
  });

export const createPendingEditSchema = z
  .object({
    editType: z.enum([
      'parameter',
      'wiki_page',
      'wiki_new',
      'wiki_fact',
      'wiki_section',
      'learning_unit',
      'clinical_case',
    ]),
    targetId: z.number().int().positive().nullable().optional(),
    parameter: z.string().max(60).optional(),
    proposedValue: z.any(),
    proposedMeta: proposedMetaSchema,
    referenceId: z.number().int().positive().optional(),
    referenceIds: z.array(z.number().int().positive()).min(1).optional(),
    status: z.enum(['draft', 'pending']).default('pending'),
    // ─── wiki_fact fields (issue #284) ───────────────────────────────────
    // All optional at the type level; per-op invariants are enforced in
    // the superRefine below so legacy editTypes keep working unchanged.
    sectionId: z.string().min(1).max(40).optional(),
    fieldId: z.string().min(1).max(60).optional(),
    factStatement: z.string().min(1).max(400).optional(),
    factOperation: z.enum(['add', 'replace', 'remove', 'reorder']).optional(),
    factTargetAnchor: factTargetAnchorSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.editType === 'learning_unit') {
      const content = learningUnitContentSchema.safeParse(value.proposedValue);
      if (!content.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'learning_unit: invalid proposedValue (' +
            content.error.issues.map((i) => i.message).join('; ') +
            ')',
          path: ['proposedValue'],
        });
      }
      const meta = learningUnitMetaSchema.safeParse(value.proposedMeta);
      if (!meta.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'learning_unit: invalid proposedMeta (' +
            meta.error.issues.map((i) => i.message).join('; ') +
            ')',
          path: ['proposedMeta'],
        });
      }
      // Exactly one anchor citation (the reviewed source) is required.
      const refs =
        value.referenceIds ?? (value.referenceId ? [value.referenceId] : []);
      if (refs.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'learning_unit requires exactly one anchor citation (referenceId or single-element referenceIds)',
          path: ['referenceIds'],
        });
      }
      return;
    }
    if (value.editType === 'clinical_case') {
      const content = clinicalCaseContentSchema.safeParse(value.proposedValue);
      if (!content.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'clinical_case: invalid proposedValue (' +
            content.error.issues.map((i) => i.message).join('; ') +
            ')',
          path: ['proposedValue'],
        });
      }
      const meta = clinicalCaseMetaSchema.safeParse(value.proposedMeta);
      if (!meta.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'clinical_case: invalid proposedMeta (' +
            meta.error.issues.map((i) => i.message).join('; ') +
            ')',
          path: ['proposedMeta'],
        });
      }
      // Cite-a-source (≥1 anchor citation, possibly several) is enforced at the
      // submit route so it surfaces the `clinical_case_missing_source` code;
      // unlike learning_unit, a case does NOT require a read-in-full paper_review
      // (it may interpret guidelines/labels that carry no paper appraisal).
      return;
    }
    if (value.editType === 'wiki_section') {
      if (!value.targetId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'wiki_section requires targetId (the wiki page id)',
          path: ['targetId'],
        });
      }
      const payload = wikiSectionPayloadSchema.safeParse(value.proposedValue);
      if (!payload.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'wiki_section: invalid proposedValue payload (' +
            payload.error.issues.map((i) => i.message).join('; ') +
            ')',
          path: ['proposedValue'],
        });
        return;
      }
      // For edit/reorder/remove, the top-level sectionId column anchors
      // the target. add ops mint their id at approval time, so sectionId
      // must be absent on submission.
      if (payload.data.operation === 'add') {
        if (value.sectionId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message:
              'wiki_section add: sectionId is minted at approval; do not supply one',
            path: ['sectionId'],
          });
        }
      } else if (!value.sectionId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `wiki_section ${payload.data.operation}: sectionId is required`,
          path: ['sectionId'],
        });
      }
      return;
    }

    if (value.editType !== 'wiki_fact') return;

    if (!value.targetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'wiki_fact requires targetId (the wiki page id)',
        path: ['targetId'],
      });
    }
    if (!value.sectionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'wiki_fact requires sectionId',
        path: ['sectionId'],
      });
    }
    if (!value.factOperation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'wiki_fact requires factOperation',
        path: ['factOperation'],
      });
      return;
    }

    const refs =
      value.referenceIds ?? (value.referenceId ? [value.referenceId] : []);

    if (value.factOperation === 'add' || value.factOperation === 'replace') {
      if (!value.factStatement || !value.factStatement.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'factStatement is required for add/replace',
          path: ['factStatement'],
        });
      }
      if (refs.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'At least one referenceId is required for add/replace',
          path: ['referenceIds'],
        });
      }
    }

    if (value.factOperation === 'add' && value.factTargetAnchor) {
      // Anchors identify an existing fact; on `add` the API generates a
      // fresh factId, so an anchor here is either client error or a
      // copy-paste from a different op. Rejecting it keeps conflict
      // detection (which keys off the anchor for replace/remove) from
      // ever scanning the wrong factId.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'factTargetAnchor is not allowed on add ops',
        path: ['factTargetAnchor'],
      });
    }

    if (value.factOperation === 'replace' || value.factOperation === 'remove') {
      if (!value.factTargetAnchor?.factId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'factTargetAnchor.factId is required for replace/remove',
          path: ['factTargetAnchor'],
        });
      }
    }

    if (value.factOperation === 'reorder') {
      if (!value.factTargetAnchor?.factId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'factTargetAnchor.factId is required for reorder',
          path: ['factTargetAnchor'],
        });
      }
      // Reorder ships the new fact-position in proposedValue, not as a
      // standalone column. Validate the shape so downstream code can
      // trust the cast in `applyApprovedWikiFact`. The integer check
      // matters: a fractional position like 0.5 reaches the splice as
      // a non-integer index, causing `splice(undefined, ...)` to
      // misplace the fact (Codex review on #369).
      const pv = value.proposedValue as
        | { position?: unknown }
        | null
        | undefined;
      if (
        !pv ||
        typeof pv !== 'object' ||
        typeof (pv as { position?: unknown }).position !== 'number' ||
        !Number.isInteger((pv as { position: number }).position) ||
        (pv as { position: number }).position < 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'reorder requires proposedValue.position (non-negative integer)',
          path: ['proposedValue'],
        });
      }
      // factStatement / referenceIds are ignored for reorder.
    }
  });

export const patchPendingEditSchema = z
  .object({
    status: z
      .enum(['draft', 'pending', 'approved', 'rejected', 'returned'])
      .optional(),
    proposedValue: z.any().optional(),
    proposedMeta: proposedMetaSchema,
    referenceId: z.number().int().positive().nullable().optional(),
    referenceIds: z
      .array(z.number().int().positive())
      .min(1)
      .nullable()
      .optional(),
    rejectionReason: z.enum(REJECTION_REASONS).optional(),
    rejectionComment: z.string().min(1).max(2000).optional(),
    returnComment: z.string().min(1).max(2000).optional(),
    reviewToken: z.string().min(1).max(200).optional(),
    /**
     * The `conflict.id` the actor saw on the row before revising (#1258). A
     * revision only rebases the marker away when this matches the marker
     * still on the row at write time — see `nextProposedMetaPreservingConflict`
     * callers in api/pending-edits.ts. Absent or mismatched: the marker
     * survives, because nothing proves the actor looked at THIS write.
     */
    acknowledgedConflictId: z.string().min(1).max(200).nullable().optional(),
  })
  .refine(
    (value) =>
      value.status !== undefined ||
      value.proposedValue !== undefined ||
      value.proposedMeta !== undefined ||
      value.referenceId !== undefined ||
      value.referenceIds !== undefined ||
      value.rejectionReason !== undefined ||
      value.rejectionComment !== undefined ||
      value.returnComment !== undefined ||
      value.reviewToken !== undefined,
    {
      message: 'At least one field must be provided',
    },
  )
  .superRefine((value, ctx) => {
    if (value.status === 'rejected' && !value.rejectionReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rejectionReason'],
        message: 'rejectionReason is required when status is rejected',
      });
    }

    if (
      value.status !== 'rejected' &&
      (value.rejectionReason !== undefined ||
        value.rejectionComment !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'rejection fields are only allowed when status is rejected',
      });
    }

    if (value.status !== 'returned' && value.returnComment !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: 'returnComment is only allowed when status is returned',
      });
    }

    if (value.status === 'returned') {
      const hasComment = Boolean(value.returnComment?.trim());
      const hasReviewerChange =
        value.proposedValue !== undefined ||
        value.proposedMeta !== undefined ||
        value.referenceId !== undefined ||
        value.referenceIds !== undefined;
      if (!hasComment && !hasReviewerChange) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message:
            'returned edits require returnComment or a proposed payload/reference change',
        });
      }
    }
  });

// ─── Approval stamps (#344) ────────────────────────────────────────────────

export const APPROVAL_TARGET_TYPES = [
  'wiki_revision',
  'drug_parameter_revision',
  'drug_discussion',
  'paper_review',
] as const;
export const approvalTargetTypeSchema = z.enum(APPROVAL_TARGET_TYPES);

export const createApprovalSchema = z
  .object({
    targetType: approvalTargetTypeSchema,
    targetId: z.number().int().positive(),
  })
  .strict();

// ─── Agent verifications (peer-review of agent output) ────────────────────

export const AGENT_VERIFICATION_TARGET_TYPES = [
  'wiki_revision',
  'drug_parameter_revision',
  'drug_discussion',
  'paper_review',
  'pending_edit',
] as const;
export const agentVerificationTargetTypeSchema = z.enum(
  AGENT_VERIFICATION_TARGET_TYPES,
);

export const AGENT_VERIFICATION_VERDICTS = [
  'approve',
  'dispute',
  'abstain',
] as const;
export const agentVerificationVerdictSchema = z.enum(
  AGENT_VERIFICATION_VERDICTS,
);

const evidenceRefSchema = z
  .object({
    citationId: z.number().int().positive().optional(),
    quote: z.string().min(1).max(2000).optional(),
    url: z.string().url().max(2000).optional(),
  })
  .strict()
  .refine(
    (v) =>
      v.citationId !== undefined ||
      v.quote !== undefined ||
      v.url !== undefined,
    {
      message:
        'Each evidence ref needs at least one of citationId, quote, or url',
    },
  );

export const createAgentVerificationSchema = z
  .object({
    targetType: agentVerificationTargetTypeSchema,
    targetId: z.number().int().positive(),
    // Opaque version token the agent received from the queue. The exact
    // shape varies by target type — most are an ISO datetime, but
    // pending_edit folds the row status in as `ISO|<status>` so a moderator
    // action surfaces as a stale-version 409 (see verificationTargetVersion
    // in api/_lib/agent-verifications.ts). The schema only enforces the
    // sane-length envelope; the actual equality check happens in handlePost.
    targetVersion: z.string().min(1).max(80),
    verdict: agentVerificationVerdictSchema,
    rationaleMd: z.string().max(5000).default(''),
    evidenceRefs: z.array(evidenceRefSchema).max(20).optional(),
    model: z.string().min(1).max(60).optional(),
    // Required on `dispute`: the verbatim passage of the target the dispute
    // says is wrong. The route checks it actually occurs in the target
    // (api/_lib/disputed-claim.ts, issue #1357).
    disputedClaim: z.string().max(DISPUTED_CLAIM_MAX_CHARS).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.verdict === 'dispute' || value.verdict === 'abstain') {
      if (!value.rationaleMd || value.rationaleMd.trim().length < 20) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rationaleMd'],
          message: `rationaleMd ≥20 chars is required for verdict "${value.verdict}"`,
        });
      }
    }
    if (value.verdict === 'dispute') {
      const claim = normalizeClaimText(value.disputedClaim ?? '');
      if (claim.length < DISPUTED_CLAIM_MIN_CHARS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['disputedClaim'],
          message: `disputedClaim ≥${DISPUTED_CLAIM_MIN_CHARS} chars is required for verdict "dispute": quote verbatim the passage of the target you say is wrong`,
        });
      }
    } else if (value.disputedClaim !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['disputedClaim'],
        message: 'disputedClaim is only accepted with verdict "dispute"',
      });
    }
  });

// The control phase after a blind dispute (api/_lib/verdict-reconsideration.ts,
// issue #1357): the disputer, having read its peers, maintains or withdraws.
export const reconsiderVerdictSchema = z
  .object({
    targetType: agentVerificationTargetTypeSchema,
    targetId: z.number().int().positive(),
    targetVersion: z.string().min(1).max(80),
    outcome: z.enum(['maintain', 'withdraw']),
    // The list's `peerDigest`, echoed so the decision is bound to the peer
    // verdicts the agent actually read.
    peerDigest: z.string().regex(/^[0-9a-f]{64}$/),
    // The model the decision is made under — recorded separately from the
    // blind verdict's, since a withdrawal can release consensus on its own.
    model: z.string().min(1).max(60),
    // What the agent concluded after reading its peers — why the dispute
    // stands, or what it misread. Reader-facing, Norwegian, like rationaleMd.
    addendumMd: z
      .string()
      .max(5000)
      .refine((v) => v.trim().length >= 20, {
        message: 'addendumMd ≥20 chars is required',
      }),
  })
  .strict();

// Step 1 of the control phase: ask to be shown the peers on one disputed target.
export const discloseForReconsiderationSchema = z
  .object({
    step: z.literal('disclose'),
    targetType: agentVerificationTargetTypeSchema,
    targetId: z.number().int().positive(),
    targetVersion: z.string().min(1).max(80),
  })
  .strict();

export const reconsiderRequestSchema = z.union([
  discloseForReconsiderationSchema,
  reconsiderVerdictSchema,
]);

// ─── Disputes (unified human + agent contestation) ─────────────────────────

// Disputes share the agent-verification target taxonomy.
export const disputeTargetTypeSchema = agentVerificationTargetTypeSchema;

export const DISPUTE_RESOLUTIONS = ['upheld', 'rejected', 'withdrawn'] as const;
export const disputeResolutionSchema = z.enum(DISPUTE_RESOLUTIONS);

export const createDisputeSchema = z
  .object({
    targetType: disputeTargetTypeSchema,
    targetId: z.number().int().positive(),
    // Opaque version token the caller read the target at — same shape and
    // same check as createAgentVerificationSchema's targetVersion (see
    // verificationTargetVersion in api/_lib/verification-targets.ts). Binds
    // the objection to the payload it actually describes: without this, a
    // dispute posted against a since-revised target had no anchor but
    // created_at, which a revision leaves untouched.
    targetVersion: z.string().min(1).max(80),
    // Required, substantive: a dispute must say why, like an agent dispute
    // verdict (≥20 chars). Trim-checked so whitespace can't satisfy it.
    reasonMd: z.string().max(5000),
    evidenceRefs: z.array(evidenceRefSchema).max(20).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.reasonMd.trim().length < 20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasonMd'],
        message: 'reasonMd ≥20 chars is required to open a dispute',
      });
    }
  });

export const resolveDisputeSchema = z
  .object({
    resolution: disputeResolutionSchema,
  })
  .strict();

// ─── Notifications (in-app inbox) ──────────────────────────────────────────

// Mark notifications read: either an explicit id list, or all of the caller's.
export const markNotificationsReadSchema = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).max(500).optional(),
    all: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.all === true || (v.ids && v.ids.length > 0), {
    message: 'Provide either ids[] or all=true',
  });

// ─── Agents admin (#319) ───────────────────────────────────────────────────

export const createAgentSchema = z
  .object({
    /** New users.email — must be unique across the users table. */
    email: z
      .string()
      .email()
      .max(255)
      .transform((v) => v.toLowerCase()),
    /** New users.username — must be unique. Convention: kebab-case. */
    username: z
      .string()
      .min(3)
      .max(100)
      .regex(/^[a-z0-9_-]+$/i),
    /** Display name (Norwegian, primary). */
    name: z.string().min(1).max(100),
    /** Optional English display name. */
    nameEn: z.string().min(1).max(100).optional(),
    /** Agent slug; auto-generated from `name` when omitted. */
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    /** Description (Norwegian). */
    description: z.string().max(2000).optional(),
    /** Description (English). */
    descriptionEn: z.string().max(2000).optional(),
    /** Human user accountable for this agent. */
    maintainerUserId: z.number().int().positive().optional(),
    /**
     * Initial role for the agent's user account. Most agents land at
     * contributor; admins promote to editor explicitly. Defaults to
     * contributor.
     */
    role: z.enum(['contributor', 'editor']).default('contributor'),
    /**
     * Server-owned capability tier (agents.model_tier). Set it to `flagship`
     * for the high-risk verifier so calculation-driving parameter edits can
     * reach consensus; omit for an unclassified agent (never counts as
     * flagship). See src/lib/modelTiers.ts and the consensus gate.
     */
    modelTier: z.enum(MODEL_TIERS).optional(),
    /**
     * T3 adjudication grant (agents.adjudicator). Lets a flagship-tier agent
     * claim a seat on a T3 case; never grants `dispute.resolve`.
     */
    adjudicator: z.boolean().optional(),
    /** Model family for the T3 panel-diversity audit (agents.model_family). */
    modelFamily: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, ".", "_" or "-"').optional(),
  })
  .strict();

export const patchAgentSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    nameEn: z.string().min(1).max(100).nullable().optional(),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    description: z.string().max(2000).nullable().optional(),
    descriptionEn: z.string().max(2000).nullable().optional(),
    maintainerUserId: z.number().int().positive().nullable().optional(),
    /** Opt the agent in/out of the hook-triggered evaluator routine. */
    hooksEnabled: z.boolean().optional(),
    /**
     * Let this agent review its own submissions in the review queue. Off for
     * every agent unless an admin turns it on for one specifically; see
     * `isSelfReviewAgentUser` for what it unlocks.
     */
    selfReviewEnabled: z.boolean().optional(),
    /**
     * Server-owned capability tier (agents.model_tier). `null` clears it back to
     * unclassified. This is the supported path to populate the tier the
     * high-risk consensus gate reads.
     */
    modelTier: z.enum(MODEL_TIERS).nullable().optional(),
    /**
     * T3 adjudication grant (agents.adjudicator). Admin-only; an agent cannot
     * set it on itself. Lets a flagship-tier agent claim a seat on a T3 case
     * and never grants `dispute.resolve`.
     */
    adjudicator: z.boolean().optional(),
    /** Model family for the T3 panel-diversity audit; `null` clears it. */
    modelFamily: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, ".", "_" or "-"').nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

/** Mint a persistent API token for an agent (#319 follow-up). */
export const issueAgentTokenSchema = z
  .object({
    label: z.string().min(1).max(100).optional(),
    /** Days until the token expires; bounded so tokens can't be eternal. */
    expiresInDays: z.number().int().positive().max(365),
  })
  .strict();

/** Revoke a previously issued agent token. */
export const revokeAgentTokenSchema = z
  .object({
    tokenId: z.number().int().positive(),
  })
  .strict();

/** Change an agent's permission tier post-creation (contributor ↔ editor). */
export const setAgentRoleSchema = z
  .object({
    role: z.enum(['contributor', 'editor']),
  })
  .strict();

/**
 * Status transition payload. Separate from `patchAgentSchema` so the
 * transition is an explicit action (with optional `reason`) rather
 * than slipping in alongside a display-field edit.
 */
export const transitionAgentStatusSchema = z
  .object({
    status: z.enum(['active', 'suspended', 'deactivated']),
    reason: z.string().max(500).optional(),
  })
  .strict();

// ─── Parameter priority flags (manual queue boost for kinetix-agent) ───────

export const createParameterPriorityFlagSchema = z.object({
  drugId: z.number().int().positive(),
  parameter: z.string().max(60).optional(),
  note: z.string().max(2000).optional(),
});

export const patchParameterPriorityFlagSchema = z.object({
  status: z.enum(['active', 'resolved', 'cancelled']),
  note: z.string().max(2000).optional(),
});

// ─── Parameter applicability (not-applicable markers) ───────────────────────
//
// `reason` is required and non-empty: the marker's whole job is to tell a
// future curator why this quantity does not exist for this substance, and an
// unexplained one cannot be distinguished from a mistake. parameter-id
// membership is checked in the handler against isDrugParameterId.
export const putParameterApplicabilitySchema = z.object({
  drugId: z.number().int().positive(),
  parameter: z.string().min(1).max(60),
  status: z.enum(['not_applicable']).optional(),
  reason: z.string().trim().min(1).max(2000),
});

// ─── Agent focus config (scope of the scheduled maintenance routine) ────────

export const AGENT_FOCUS_MODES = [
  'all',
  'pages',
  'parameters',
  'methods',
] as const;

// parameter-id membership (DrugParameterId) is checked in the handler so the
// schema stays decoupled from the runtime parameter registry, mirroring how
// parameter-priority-flags validates its `parameter` field. methodIds are
// analytical_methods.id values for mode='methods'; existence is checked in
// the handler when the config is hydrated.
export const updateAgentFocusConfigSchema = z.object({
  mode: z.enum(AGENT_FOCUS_MODES),
  pageIds: z.array(z.number().int().positive()).max(500).optional(),
  parameters: z.array(z.string().max(60)).max(200).optional(),
  methodIds: z.array(z.number().int().positive()).max(500).optional(),
  // Mode-independent switch (migration 0125): close the agents' wiki-content
  // action while leaving whichever drug/parameter scope `mode` sets intact.
  // Optional, and ABSENT IS NOT `false`: the handler keeps whatever is stored
  // when the field is missing, so a client that predates the switch cannot
  // silently re-open the wiki action by saving an unrelated scope change. The
  // array fields can default to empty because they are the instruction itself;
  // this one is a guard, and a guard must not drop on a stale request.
  skipWikiContent: z.boolean().optional(),
});

// ─── Site settings (runtime policy switches) ────────────────────────────────
// Partial patch: only the switches the form actually changed. Setting-id
// membership is checked in the store against src/lib/siteSettings.ts, so the
// schema stays decoupled from the runtime registry (mirroring how
// updateAgentFocusConfigSchema leaves parameter ids to the handler) and an
// unknown id comes back as `unknown_site_setting` naming the id rather than a
// generic zod complaint. The count bound is a shape guard — the registry is
// tiny; the key bound matches `site_settings.key` (VARCHAR(64)).
export const updateSiteSettingsSchema = z.object({
  settings: z
    .record(z.string().min(1).max(64), z.boolean())
    .refine((s) => Object.keys(s).length <= 50, {
      message: 'Too many settings in one request',
    }),
});

// ─── Nav visibility (hidden header menu items, #1240) ───────────────────────
// Item-id membership is checked in the store against src/lib/navItems.ts,
// mirroring updateSiteSettingsSchema — an unknown id comes back as
// `unknown_nav_item` naming the id rather than a generic zod complaint. One
// item toggles per request (#1316) — the store applies it atomically against
// whatever the list currently holds, rather than the whole list being
// replaced from a client snapshot that can go stale.
export const updateHiddenNavItemSchema = z.object({
  id: z.string().min(1).max(64),
  hidden: z.boolean(),
});

// ─── Parameter entries (multi-value) ────────────────────────────────────────
// Re-exported here so the /api/parameter-entries route validates against the
// centralized API schema surface (api/AGENTS.md), like the other routes. The
// definitions live in src/lib/parameterEntries.ts because the entry model is
// shared with the frontend client and the aggregation layer.
export {
  parameterEntryCreateRequestSchema,
  parameterEntryUpdateRequestSchema,
  parameterEntryInputSchema,
  parameterEntryPatchSchema,
  parameterEntryEditSchema,
  type ParameterEntryInput,
  type ParameterEntryPatch,
  type ParameterEntryEdit,
} from '../../src/lib/parameterEntries.js';

// ─── PubMed MCP tool arguments (docs/pubmed-mcp.md) ─────────────────────────
// Argument schemas for the tools `api/mcp.ts` exposes. They live here with the
// rest of the API-boundary schemas (api/AGENTS.md: no inline Zod) because they
// validate externally reachable input like any route body. They differ from
// route schemas in one way worth knowing: `api/_lib/mcp.ts` also serialises
// each one to JSON Schema for `tools/list`, so `.describe()` text is published
// to clients and is documentation, not a comment. Keep field names in the
// snake_case MCP convention rather than the camelCase used elsewhere.

export const mcpPmidSchema = z
  .string()
  .trim()
  .regex(/^\d{1,9}$/, 'must be a numeric PubMed ID');

export const mcpPmidListSchema = z
  .array(mcpPmidSchema)
  .min(1, 'provide at least one PMID')
  .max(50, 'at most 50 PMIDs per call');

export const mcpSearchPubMedSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    // Generous enough for a systematic-review query with hundreds of terms;
    // the client switches to a form-encoded POST well before this, so the
    // bound exists to stop an unbounded body reaching NCBI, not to limit
    // legitimate queries.
    .max(8000)
    .describe(
      'PubMed query. Full Entrez syntax is supported, e.g. ' +
        '"trimipramine AND postmortem redistribution" or ' +
        '"amitriptyline[Title/Abstract] AND femoral blood".',
    ),
  date_from: z
    .string()
    .nullish()
    .describe('Earliest publication date, as YYYY, YYYY-MM or YYYY-MM-DD.'),
  date_to: z
    .string()
    .nullish()
    .describe('Latest publication date, as YYYY, YYYY-MM or YYYY-MM-DD.'),
  article_types: z
    .array(z.string().trim().min(1))
    .optional()
    .describe(
      'PubMed publication types to restrict to, e.g. ["Journal Article"], ' +
        '["Review"], ["Case Reports"], ["Randomized Controlled Trial"].',
    ),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe(
      'Records to return (1-100). The hit count is reported separately.',
    ),
  offset: z
    .number()
    .int()
    .min(0)
    // Entrez rejects retstart above 9998: ESearch reaches only the first 9,999
    // records of any PubMed query. Catching it here turns an upstream "Search
    // Backend failed" into an argument error that says what to do instead.
    .max(9998, 'PubMed cannot page beyond the first 9,999 matches')
    .default(0)
    .describe(
      'Records to skip, for paging through a large result set. PubMed reaches ' +
        'only the first 9,999 matches of any query (max offset 9998) — narrow ' +
        'the query with date bounds or publication types to go deeper.',
    ),
  sort: z
    .enum(['relevance', 'pub_date', 'author', 'journal'])
    .default('relevance')
    .describe('Result ordering.'),
});

export const mcpFetchRecordsSchema = z.object({
  pmids: mcpPmidListSchema.describe('PubMed IDs to look up.'),
});

export const mcpFetchAbstractsSchema = z.object({
  pmids: mcpPmidListSchema.describe('PubMed IDs whose abstracts to retrieve.'),
});

export const mcpRelatedArticlesSchema = z.object({
  pmid: mcpPmidSchema.describe('Seed article.'),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe('Related articles to return.'),
  include_metadata: z
    .boolean()
    .default(true)
    .describe(
      'Fetch bibliographic metadata for the neighbours. Set false for a ' +
        'faster PMID-and-score-only response.',
    ),
});

export const mcpResolveIdentifierSchema = z.object({
  ids: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(50)
    .describe(
      'Identifiers to convert: PMIDs, PMCIDs (PMC1234567) or DOIs, mixed freely.',
    ),
});

export const mcpPmcFullTextSchema = z.object({
  pmcid: z
    .string()
    .trim()
    .regex(/^(PMC)?\d{1,9}$/i, 'must be a PMCID such as PMC1234567')
    .describe('PMC identifier, with or without the PMC prefix.'),
});

export const mcpExportCitationsSchema = z.object({
  pmids: mcpPmidListSchema.describe('PubMed IDs to format.'),
  format: z
    .enum(['vancouver', 'apa', 'bibtex', 'ris'])
    .default('vancouver')
    .describe('Citation style.'),
});

// ─── Capability matrix (Admin → Permissions) ────────────────────────────────
// A change list rather than a whole-matrix PUT: the admin form only sends the
// rows it touched, so two admins editing different capabilities don't clobber
// each other. `minTier: null` means "back to the shipped default".

export const permissionMatrixPatchSchema = z.object({
  changes: z
    .array(
      z.object({
        capability: z.string().min(1).max(64),
        minTier: z
          .enum(['anonymous', 'authenticated', 'contributor', 'editor', 'admin'])
          .nullable(),
      }),
    )
    .min(1)
    .max(100),
});

// ─── Drug merge (Admin → Merge drugs) ────────────────────────────────────────
// Fold two catalog entries for one substance into one. `preview` returns the
// plan (survivor, conflicts, blockers, counts); `apply` performs the merge with
// the admin's per-conflict resolutions. See api/_lib/drug-merge.ts.

const drugMergeIdSchema = z.number().int().positive().max(2147483647);

export const drugMergePreviewSchema = z.object({
  action: z.literal('preview'),
  drugIdA: drugMergeIdSchema,
  drugIdB: drugMergeIdSchema,
  /** Optional override: force this id to be the surviving entry. */
  winnerId: drugMergeIdSchema.optional(),
});

export const drugMergeApplySchema = z.object({
  action: z.literal('apply'),
  winnerId: drugMergeIdSchema,
  loserId: drugMergeIdSchema,
  /** conflict id (`${kind}:${key}`) → which side's value to keep. */
  resolutions: z.record(z.string(), z.enum(['winner', 'loser'])).default({}),
  /**
   * The `planFingerprint` from the preview response. Server rebuilds the plan
   * under the merge lock and refuses the apply if this doesn't match — every
   * decision an admin approved was against the values inside the fingerprint,
   * so any change (a conflict's underlying value shifting, the loser
   * monograph gaining prose, a new blocker appearing) is a stale-plan 409.
   * Hex string, capped conservatively.
   */
  planFingerprint: z.string().min(1).max(128),
});

export const drugMergeBodySchema = z.discriminatedUnion('action', [
  drugMergePreviewSchema,
  drugMergeApplySchema,
]);
