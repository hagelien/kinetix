/**
 * kinetics-core — portable, dependency-free pharmacokinetic engine.
 *
 * Kinetix owns this package; Redose consumes an exact, checksummed copy that is
 * vendored into its bundle and run offline. Import ONLY from this entry point so
 * the public surface stays stable across the vendoring boundary.
 *
 * Public surface:
 *   - simulateScenario(scenario, nowIso?) -> CanonicalResult   (the engine)
 *   - the CanonicalScenario / CanonicalResult contract types
 *   - the registry (findModel, registeredAnalytes, supportedAnalyteIds, version + checksum)
 *   - version constants
 *   - ParamSpec constructors (for authoring registry entries / fixtures)
 */
export { simulateScenario, ENGINE_LIMITS } from "./simulate.js";
export { CORE_VERSION, SCENARIO_SCHEMA_VERSION } from "./version.js";
export {
  REGISTRY_VERSION,
  REGISTRY_CHECKSUM,
  findModel,
  loadOfflineRegistry,
  derivedRegistryRolloutEnabled,
  registeredAnalytes,
  supportedAnalyteIds,
} from "./registry.js";
export { buildRegistrySnapshot } from "./registry-snapshot.js";
export type { RegistrySnapshot } from "./registry-snapshot.js";
export {
  fixed,
  uniform,
  triangular,
  lognormal,
  centralValue,
  validateParamSpec,
} from "./param.js";
export { PRNG, covarianceCholesky, sampleMultivariateNormal } from "./rng.js";
export {
  isApparentBasis,
  isAbsoluteBasis,
  isPrimitiveBasis,
  structuralIdentity,
  resolveStructural,
  absoluteValueOrNull,
  sameIdentifiabilityClass,
  isCoherentClvDisposition,
  clvReferenceSubjectLimitation,
  resolveClvDisposition,
} from "./structural.js";
export {
  resolveCovariateFactors,
  individualisesDisposition,
  covariateOf,
} from "./covariates.js";
export { hashValue, canonicalJson, fnv1a32 } from "./hash.js";
export {
  ROUTE_IDS,
  MODEL_FAMILIES,
  MODEL_FAMILY_EVALUATION,
} from "./types.js";
export {
  DISPOSITION_KINDS,
  ELIMINATION_KINDS,
  ABSORPTION_KINDS,
  IV_ABSORPTION_KINDS,
  isIvAbsorptionKind,
  absorptionHasFirstOrderRate,
  absorptionCoherentWithRoute,
  composeModelFamily,
  requiredParametersFor,
  forbiddenParametersFor,
  validateModelStructure,
} from "./model-structure.js";
export type {
  DispositionKind,
  EliminationKind,
  AbsorptionKind,
  ModelStructure,
  RequiredParam,
  ComposeResult,
  StructureRequirementOptions,
  StructureValidation,
} from "./model-structure.js";
export { deriveModel, MODEL_STRUCTURE_DEFAULTS } from "./derive-model.js";
export type {
  ModelStructureDeclaration,
  AxisProvenance,
  RouteProvenance,
  DerivedModel,
} from "./derive-model.js";
export { assembleRouteParams, rangeIsUsable } from "./assemble-model.js";
export type {
  AssemblyRange,
  AssemblyRanges,
  AssemblyValues,
  AssembleOptions,
  ModelAssembly,
} from "./assemble-model.js";
export { assembleDrugDefinition } from "./assemble-definition.js";
export type {
  RouteAssemblyInput,
  DrugDefinitionMetadata,
  RouteAssemblyOutcome,
  DrugDefinitionAssembly,
} from "./assemble-definition.js";
export {
  gradeDerivedModel,
  rendersCurve,
  gradeBandWidening,
  MIN_RENDER_GRADE,
  GRADE_BAND_WIDENING_CV,
} from "./model-grade.js";
export type {
  ModelGrade,
  GradeFactor,
  GradeFactorResult,
  GradedModel,
  GradeInputs,
  GradeBandWidening,
} from "./model-grade.js";
export { inferKaFromTmax } from "./ka-inference.js";
export type { KaInference } from "./ka-inference.js";
export { derivedModelFromGrade, findDerivedRouteGrade } from "./derived-grade.js";
export type { DerivedRouteGrade, DerivedModelGrade, InputSource } from "./derived-grade.js";
export { assessDerivedModel } from "./derived-model-grade.js";
export type { DerivedModelEvidence } from "./derived-model-grade.js";
export { resolveModel, resolvableAnalyteIds, resolvedRegistryRelease } from "./registry.js";
export { derivedRouteGrade, isDerivedAnalyte } from "./generated-registry-loader.js";
export {
  installLiveDerivedEntry,
  liveDerivedEntry,
  liveDerivedEntries,
  clearLiveDerivedEntries,
} from "./live-derived.js";
export type { LiveDerivedEntry } from "./live-derived.js";
export {
  GRADE_DIMENSIONS,
  evaluateGradePolicy,
  renderDisposition,
  minimumGradeFor,
  intervalSemanticsEstablished,
  statedDimensions,
} from "./grade-policy.js";
export type {
  GradeDimension,
  DimensionGrade,
  DimensionAssessment,
  GradePolicyResult,
  ModelGradeLetter,
  OverallGrade,
  UserClass,
  RenderDisposition,
  RenderPolicyOptions,
} from "./grade-policy.js";
export { assessReviewedModel } from "./reviewed-model-grade.js";
export type { ReviewedModelEvidence } from "./reviewed-model-grade.js";
export {
  computeAucLast,
  estimateTerminalHalfLife,
  computeLandmarks,
  validateFixture,
  renderValidationReport,
  VALIDATION_SUITE_VERSION,
  validateVersionedFixture,
  validateVersionedSuite,
  renderVersionedValidationReport,
} from "./validation.js";
export type {
  ExpectedLandmark,
  ValidationExpectation,
  ValidationFixture,
  LandmarkComparison,
  FixtureValidationReport,
  ValidationEndpoint,
  ReviewedSource,
  SuiteCheck,
  VersionedValidationFixture,
  ScientificCheckResult,
  VersionedValidationReport,
} from "./validation.js";
export {
  leanBodyMassKg,
  vdScaleKg,
  requiredCovariatesForVdScaling,
  REFERENCE_WEIGHT_KG,
  REFERENCE_LBM_KG,
} from "./scaling.js";
export {
  REGISTRY_PROVENANCE,
  PROVENANCE_REFERENCE_WEIGHT_KG,
  CHECKABLE_PARAMS,
  NOT_IN_CATALOG_PARAMS,
  crossCheckRegistry,
  provenanceFor,
  auditProvenanceCompleteness,
  isCatalogConsistent,
  reviewerAuthoredRouteParams,
  declaredMatrixTransforms,
  declaredObservationError,
} from "./provenance.js";

export type {
  RouteId,
  Matrix,
  MatrixTransform,
  ObservationErrorLayer,
  DoseBasis,
  ModelFamily,
  CanonicalUnit,
  CovariateId,
  VdScaling,
  ValidationStatus,
  ParamSpec,
  BoundMeaning,
  CovarianceModel,
  CovarianceState,
  ScenarioUncertaintyLayers,
  StructuralParameterId,
  IdentifiabilityBasis,
  StructuralParameterSpec,
  ResolvedStructuralParameter,
  CovariateFunction,
  CovariateTargetParameter,
  ContinuousCovariateId,
  CategoricalCovariateId,
  AppliedCovariate,
  OneCompartmentRouteParams,
  OneCompartmentClvRouteParams,
  OneCompartmentZeroOrderRouteParams,
  OneCompartmentMixedOrderRouteParams,
  MichaelisMentenRouteParams,
  RouteModelParams,
  DrugModelDefinition,
  CanonicalSubject,
  CanonicalDoseEvent,
  UncertaintyConfig,
  CanonicalScenario,
  FailureCode,
  CurvePoint,
  AnalyteCurve,
  Limitation,
  RunManifest,
  ResolvedRouteSummary,
  ParentMetaboliteRouteParams,
  CanonicalResult,
  CanonicalResultOk,
  CanonicalResultFailure,
} from "./types.js";

export type { ResolvedClvDisposition } from "./structural.js";
export {
  REVIEW_PACKET_SCHEMA_VERSION,
  reviewPacketChecksum,
  auditScientificReviewPacket,
  evaluateScientificRelease,
} from "./scientific-review.js";
export type {
  ReviewArtifactKind,
  ValidationGrade,
  ReviewFailureDisposition,
  VersionedReviewArtifact,
  ScientificReviewer,
  ReviewEvidenceItem,
  ScientificReviewPacket,
  ScientificReviewApproval,
  ScientificReleaseVersions,
  ScientificReleaseDecision,
} from "./scientific-review.js";

export type {
  CatalogRange,
  CatalogParams,
  CatalogLookup,
  CheckableParam,
  ProvenanceSource,
  ParamProvenance,
  RouteKey,
  RegistryProvenanceEntry,
  Classification,
  CrossCheckRow,
  CrossCheckReport,
  DeclaredMatrixTransform,
  DeclaredObservationError,
} from "./provenance.js";
