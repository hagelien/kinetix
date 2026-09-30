import { z } from "zod";
import type {
  DistributionSpec,
  RouteType,
  UncertaintyPoint,
} from "@/types/simulator";

// ─── Engine identity ────────────────────────────────────────────────────────
//
// `lite-browser` runs the analytic PK + grid/Monte-Carlo stack in the user's
// browser. `full-remote` proxies to the external Python KineLab backend.
// Result objects always carry the engine id under `diagnostics.engine` so
// downstream UI / report code can attribute output without having to inspect
// which engine was selected.

export type EngineId = "lite-browser" | "full-remote";

// ─── Capabilities ───────────────────────────────────────────────────────────

export type ComputeCapability =
  | "analytic-pk"
  | "grid-inference"
  | "browser-monte-carlo"
  | "basic-scenario-comparison"
  | "ode-solver"
  | "hmc-nuts"
  | "hierarchical-pop-pk"
  | "postmortem-model"
  | "model-averaging";

// ─── Matrices (aligned with reference_concentrations.matrix) ───────────────

export const matrixValues = [
  "whole_blood",
  "serum",
  "plasma",
  "femoral_blood",
  "cardiac_blood",
  "urine",
  "vitreous",
  "other",
] as const;

export type Matrix = (typeof matrixValues)[number];

// ─── PK model types (analytic Lite-mode families) ──────────────────────────

export const pkModelTypes = [
  "one_comp_iv_bolus",
  "one_comp_first_order_absorption",
  "one_comp_first_order_elimination",
  "two_comp_biexponential",
  "ethanol_zero_order",
  "parent_metabolite_simple",
] as const;

export type PKModelType = (typeof pkModelTypes)[number];

// ─── Concentration units ────────────────────────────────────────────────────

export const concentrationUnits = [
  "mg/L",
  "ng/mL",
  "µg/L",
  "µmol/L",
  "mmol/L",
] as const;

export type ConcentrationUnit = (typeof concentrationUnits)[number];

// ─── Zod schemas ────────────────────────────────────────────────────────────
//
// We parse these at engine boundaries so a Lite call and a Full-mode HTTP
// response are validated against the same shape. The runtime types below are
// inferred from these schemas.

const distributionSpecSchema: z.ZodType<DistributionSpec> = z.union([
  z.object({ type: z.literal("fixed"), value: z.number() }),
  z.object({ type: z.literal("uniform"), min: z.number(), max: z.number() }),
  z.object({
    type: z.literal("triangular"),
    min: z.number(),
    mode: z.number(),
    max: z.number(),
  }),
  z.object({
    type: z.literal("lognormal"),
    mu: z.number(),
    sigma: z.number(),
  }),
]);

const routeSchema: z.ZodType<RouteType> = z.enum([
  "iv",
  "oral",
  "insufflation",
  "inhalation",
  "other",
]);

export const matrixSchema = z.enum(matrixValues);
export const pkModelTypeSchema = z.enum(pkModelTypes);
export const concentrationUnitSchema = z.enum(concentrationUnits);

export const concentrationValueSchema = z.object({
  value: z.number(),
  unit: concentrationUnitSchema,
  matrix: matrixSchema,
});

export const observationSchema = z.object({
  id: z.string(),
  /** `drugs.slug` — preferred. Free-text falls back to drug name. */
  analyte: z.string().min(1),
  concentration: z.object({
    value: z.number(),
    unit: concentrationUnitSchema,
  }),
  matrix: matrixSchema,
  /** ISO-8601 sample timestamp, optional for grid inference. */
  sampleTime: z.string().optional(),
  assay: z
    .object({
      method: z.string().optional(),
      lod: z.number().optional(),
      loq: z.number().optional(),
      uncertaintyCV: z.number().optional(),
    })
    .optional(),
  /** Left-censoring for a non-detect: the true concentration is known only to
   *  be below `limit` (in the observation's concentration unit). The likelihood
   *  uses P(concentration < limit) instead of a point density. */
  censoring: z
    .object({
      kind: z.enum(["lod", "loq"]),
      limit: z.number().positive(),
    })
    .optional(),
});

export const intakeWindowSchema = z.object({
  earliestIso: z.string(),
  latestIso: z.string(),
});

export const routePriorSchema = z.object({
  route: routeSchema,
  weight: z.number().min(0).max(1).default(1),
});

export const subjectSchema = z.object({
  age: z.number().int().nonnegative().optional(),
  sex: z.enum(["male", "female", "unknown"]).optional(),
  weightKg: z.number().positive().optional(),
});

// ─── Citations / assumptions / limitations ─────────────────────────────────
//
// `citationId` references the existing `citations` table when known. KineLab
// can also emit citation-less assumptions (e.g. "ethanol distribution
// assumed homogeneous").
//
// `i18nKey` is a forward-compatible localization hook. Renderers that have
// access to a translator (the KineLab page, the report-flow caller) prefer
// the key over the verbatim `text`, so model-card text can ship in en + nb
// per AGENTS.md while the engine layer stays React-free. Cards that have
// not been migrated yet simply omit the key and fall back to `text`.

export const assumptionSchema = z.object({
  id: z.string(),
  text: z.string(),
  i18nKey: z.string().optional(),
  citationId: z.number().int().positive().optional(),
});

export const limitationSchema = z.object({
  id: z.string(),
  text: z.string(),
  i18nKey: z.string().optional(),
  severity: z.enum(["info", "warning", "critical"]).default("warning"),
});

export const diagnosticSummarySchema = z.object({
  engine: z.enum(["lite-browser", "full-remote"]),
  method: z.string(),
  sampleCount: z.number().int().nonnegative().optional(),
  /** Effective sample size for importance-sampling inference. Optional so
   *  that simulate() results, which don't apply weights, can omit it; and
   *  so that legacy saved cases without ESS can still parse. */
  effectiveSampleSize: z.number().nonnegative().optional(),
  warnings: z.array(z.string()).default([]),
});

export const remoteRunManifestSchema = z
  .object({
    engine: z.object({ name: z.string().min(1), version: z.string().min(1) }),
    model: z.object({ id: z.string().min(1), version: z.string().min(1) }),
    parameters: z.object({
      version: z.string().min(1),
      hash: z.string().min(1),
    }),
    registry: z.object({ version: z.string().min(1), hash: z.string().min(1) }),
    solver: z.object({
      name: z.string().min(1),
      version: z.string().min(1),
      settings: z.record(z.string(), z.unknown()),
    }),
    seed: z.number().int(),
    environment: z.object({
      runtime: z.string().min(1),
      architecture: z.string().min(1),
      image: z.string().min(1),
    }),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
  })
  .strict();

// ─── Simulation (forward) ──────────────────────────────────────────────────

export const simulationInputSchema = z.object({
  modelId: z.string(),
  /** `drugs.slug`. */
  analyte: z.string(),
  matrix: matrixSchema,
  route: routeSchema,
  subject: subjectSchema.optional(),
  parameters: z.object({
    halfLife: distributionSpecSchema,
    vd: distributionSpecSchema,
    f: distributionSpecSchema,
  }),
  dose: z.object({
    value: z.number().positive(),
    unit: z.literal("mg"),
  }),
  timeRangeHours: z.object({
    start: z.number(),
    end: z.number(),
    steps: z.number().int().positive().default(100),
  }),
  drawCount: z.number().int().positive().default(2000),
  seed: z.number().int().default(42),
});

const uncertaintyPointSchema: z.ZodType<UncertaintyPoint> = z.object({
  t: z.number(),
  p05: z.number(),
  p25: z.number(),
  median: z.number(),
  p75: z.number(),
  p95: z.number(),
});

export const simulationResultSchema = z.object({
  engine: z.enum(["lite-browser", "full-remote"]),
  modelId: z.string(),
  timeSeries: z.array(uncertaintyPointSchema),
  unit: concentrationUnitSchema,
  diagnostics: diagnosticSummarySchema,
  assumptions: z.array(assumptionSchema),
  limitations: z.array(limitationSchema),
  createdAt: z.string(),
  /** Immutable remote execution provenance; absent for browser-only runs. */
  runManifest: remoteRunManifestSchema.optional(),
});

// ─── Inference (inverse) ───────────────────────────────────────────────────
//
// Lite inverse inference takes a small number of observations + priors over
// the unknown variables (dose, PK params, intake offset) and returns a
// weighted posterior summary plus posterior predictive curves. The intake
// offset prior is derived from `scenario.possibleIntakeWindow` when present
// and treated as a single anchor (offset = 0) otherwise. Future Full mode
// will accept the same input and run HMC/NUTS over a richer model.

export const inferencePriorsSchema = z
  .object({
    /** Dose, in mg. Always required. */
    dose: distributionSpecSchema,
    /** Half-life in hours. Required for `one_comp_*` models; omitted (or
     *  ignored) for zero-order models that drive elimination via
     *  `eliminationRate` instead. */
    halfLife: distributionSpecSchema.optional(),
    /** Volume of distribution in litres (or L/kg if engine weight-scales). */
    vd: distributionSpecSchema,
    /** Bioavailability (0, 1]. Ignored when route is iv. Also ignored by
     *  the ethanol zero-order model, which assumes complete absorption per
     *  the Widmark convention. */
    f: distributionSpecSchema.optional(),
    /** Zero-order elimination rate in mg/L per hour. Required for the
     *  `ethanol_zero_order` model; omitted for first-order models. */
    eliminationRate: distributionSpecSchema.optional(),
    /** First-order absorption rate constant ka (per hour). When present on a
     *  non-IV first-order case the engine uses the Bateman (rising-then-
     *  falling) curve instead of the instantaneous-absorption approximation,
     *  so samples near Tmax are modelled. Ignored for IV (fully absorbed) and
     *  for the zero-order model. */
    ka: distributionSpecSchema.optional(),
  })
  // Reject payloads with no elimination prior at all. Without this, both
  // first-order and zero-order dispatch paths in `runInference` would
  // explode at runtime instead of failing schema validation at the
  // boundary. Allowing both fields to be set is intentional — the
  // dispatcher in `inference.ts` documents that `eliminationRate`
  // takes precedence — so the constraint is "at least one", not
  // "exactly one".
  .refine(
    (priors) => priors.halfLife != null || priors.eliminationRate != null,
    {
      message:
        "priors must include either `halfLife` (first-order) or `eliminationRate` (zero-order)",
      path: ["halfLife"],
    },
  );

export const inferenceInputSchema = z.object({
  modelId: z.string(),
  analyte: z.string(),
  /** Route used by the prediction equation. IV ignores `priors.f`. */
  route: routeSchema,
  observations: z.array(observationSchema).min(1),
  priors: inferencePriorsSchema,
  /**
   * Known repeated doses beyond the primary (inferred) one, superposed on the
   * first-order model. Each is expressed as a fraction of the inferred primary
   * dose (1.0 = an identical repeat) at a known time after the primary intake.
   * Only the primary dose magnitude is inferred. Ignored by the zero-order
   * (ethanol) model, which handles repeated intakes via its own Widmark path.
   */
  additionalDoses: z
    .array(
      z.object({
        tHoursAfterPrimary: z.number().nonnegative(),
        doseFraction: z.number().positive(),
      }),
    )
    .optional(),
  scenario: z
    .object({
      possibleIntakeWindow: intakeWindowSchema.optional(),
      possibleRoutes: z.array(routePriorSchema).optional(),
      notes: z.string().optional(),
    })
    .optional(),
  subject: subjectSchema.optional(),
  /**
   * Default analytical CV used when an observation has no
   * `assay.uncertaintyCV`. Lognormal assay error: `log(observed) ~
   * N(log(predicted), sqrt(log(1 + cv^2)))`.
   */
  defaultAssayCV: z.number().positive().default(0.15),
  /** Reserved for the phase-2 grid hybrid. Currently unused by Lite. */
  gridResolution: z.number().int().positive().default(40),
  drawCount: z.number().int().positive().default(2000),
  seed: z.number().int().default(42),
});

export const posteriorSummarySchema = z.object({
  /** Posterior intervals keyed by parameter name (e.g. "dose", "intakeTime"). */
  intervals: z.record(
    z.string(),
    z.object({
      median: z.number(),
      p05: z.number(),
      p95: z.number(),
      unit: z.string().optional(),
    }),
  ),
});

export const inferenceResultSchema = z.object({
  engine: z.enum(["lite-browser", "full-remote"]),
  modelIds: z.array(z.string()),
  posteriorSummary: posteriorSummarySchema,
  posteriorPredictive: z
    .object({
      timeSeries: z.array(uncertaintyPointSchema),
      unit: concentrationUnitSchema,
    })
    .optional(),
  diagnostics: diagnosticSummarySchema,
  assumptions: z.array(assumptionSchema),
  limitations: z.array(limitationSchema),
  createdAt: z.string(),
  /** Immutable remote execution provenance; absent for browser-only runs. */
  runManifest: remoteRunManifestSchema.optional(),
});

// ─── Scenario comparison ───────────────────────────────────────────────────

export const scenarioComparisonInputSchema = z.object({
  scenarios: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        input: inferenceInputSchema,
      }),
    )
    .min(2),
});

export const scenarioComparisonResultSchema = z.object({
  engine: z.enum(["lite-browser", "full-remote"]),
  scenarios: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      result: inferenceResultSchema,
    }),
  ),
  diagnostics: diagnosticSummarySchema,
  createdAt: z.string(),
  /** Immutable remote execution provenance; absent for browser-only runs. */
  runManifest: remoteRunManifestSchema.optional(),
});

// ─── Reports ───────────────────────────────────────────────────────────────

// All translatable strings the markdown report emits. Callers pass values
// pre-resolved via `t()` so the engine layer remains React-free. Defaults are
// kept in `src/lib/compute/report.ts` so headless users (tests, the future
// Full backend) can rely on English fallbacks.
export const reportLabelsSchema = z.object({
  defaultTitle: z.string(),
  authoredBy: z.string(),
  caseId: z.string(),
  caseSummary: z.string(),
  analyte: z.string(),
  model: z.string(),
  route: z.string(),
  intakeWindow: z.string(),
  subject: z.string(),
  subjectSex: z.string(),
  subjectAge: z.string(),
  subjectWeight: z.string(),
  engine: z.string(),
  generated: z.string(),
  observations: z.string(),
  obsCol_id: z.string(),
  obsCol_concentration: z.string(),
  obsCol_matrix: z.string(),
  obsCol_sampleTime: z.string(),
  obsCol_assayCV: z.string(),
  obsCol_assayCVDefault: z.string(),
  method: z.string(),
  methodLead: z.string(),
  priors: z.string(),
  priorsDose: z.string(),
  priorsHalfLife: z.string(),
  priorsVd: z.string(),
  priorsF: z.string(),
  priorsEliminationRate: z.string(),
  priorsAssayCV: z.string(),
  priorsDraws: z.string(),
  posteriorIntervals: z.string(),
  paramCol_param: z.string(),
  paramCol_unit: z.string(),
  posteriorEmpty: z.string(),
  posteriorPredictive: z.string(),
  predictiveSpan: z.string(),
  predictivePeak: z.string(),
  scenarioComparison: z.string(),
  scenariosComputedBy: z.string(),
  scenarioCol_label: z.string(),
  scenarioCol_doseMedian: z.string(),
  scenarioCol_ess: z.string(),
  assumptions: z.string(),
  limitations: z.string(),
  diagnosticWarnings: z.string(),
  severityCritical: z.string(),
  severityWarning: z.string(),
  liteDisclaimer: z.string(),
  notAvailable: z.string(),
});

export type ReportLabels = z.infer<typeof reportLabelsSchema>;

export const reportInputSchema = z.object({
  caseId: z.string().optional(),
  inferenceResult: inferenceResultSchema,
  /** Optional: original inference input. When supplied the report renders an
   *  observation table and the priors block; without it the report falls
   *  back to summarizing the posterior + diagnostics only. */
  inferenceInput: inferenceInputSchema.optional(),
  /** Optional: a scenario-comparison result to render side-by-side with the
   *  primary inference. */
  scenarioComparison: scenarioComparisonResultSchema.optional(),
  /** Free-text introductory blurb the operator wants on the report cover. */
  cover: z
    .object({
      title: z.string().optional(),
      authoredBy: z.string().optional(),
    })
    .optional(),
  /** Localized strings for every chrome string in the report. The page passes
   *  them resolved via `t()`; headless callers can omit and receive English
   *  defaults from `defaultEnglishReportLabels`. */
  labels: reportLabelsSchema.optional(),
});

export const reportResultSchema = z.object({
  engine: z.enum(["lite-browser", "full-remote"]),
  /** Self-contained HTML or markdown the front-end can render or download. */
  format: z.enum(["markdown", "html"]),
  body: z.string(),
  diagnostics: diagnosticSummarySchema,
  createdAt: z.string(),
  /** Immutable remote execution provenance; absent for browser-only runs. */
  runManifest: remoteRunManifestSchema.optional(),
});

// ─── Inferred types ─────────────────────────────────────────────────────────

export type Observation = z.infer<typeof observationSchema>;
export type InferencePriors = z.infer<typeof inferencePriorsSchema>;
export type Assumption = z.infer<typeof assumptionSchema>;
export type Limitation = z.infer<typeof limitationSchema>;
export type DiagnosticSummary = z.infer<typeof diagnosticSummarySchema>;
export type SimulationInput = z.infer<typeof simulationInputSchema>;
export type SimulationResult = z.infer<typeof simulationResultSchema>;
export type InferenceInput = z.infer<typeof inferenceInputSchema>;
export type InferenceResult = z.infer<typeof inferenceResultSchema>;
export type ScenarioComparisonInput = z.infer<
  typeof scenarioComparisonInputSchema
>;
export type ScenarioComparisonResult = z.infer<
  typeof scenarioComparisonResultSchema
>;
export type ReportInput = z.infer<typeof reportInputSchema>;
export type ReportResult = z.infer<typeof reportResultSchema>;
export type PosteriorSummary = z.infer<typeof posteriorSummarySchema>;

// ─── The interface every engine implements ──────────────────────────────────

export interface ComputeEngine {
  readonly id: EngineId;
  simulate(input: SimulationInput): Promise<SimulationResult>;
  infer(input: InferenceInput): Promise<InferenceResult>;
  compareScenarios(
    input: ScenarioComparisonInput,
  ): Promise<ScenarioComparisonResult>;
  generateReport(input: ReportInput): Promise<ReportResult>;
  getCapabilities(): ComputeCapability[];
}

// ─── Stable error codes shared with api/jobs/* ──────────────────────────────

export const FULL_COMPUTE_DISABLED_ERROR = "FULL_COMPUTE_DISABLED" as const;
export const COMPUTE_NOT_IMPLEMENTED_ERROR = "COMPUTE_NOT_IMPLEMENTED" as const;

export class ComputeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ComputeError";
  }
}
