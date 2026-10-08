import type { DerivedModelGrade, DerivedRouteGrade } from './derived-grade.js';
import { findDerivedRouteGrade } from './derived-grade.js';
import type { DrugModelDefinition, RouteId } from './types.js';
import { buildRegistrySnapshot, type RegistrySnapshot } from './registry-snapshot.js';
import { GENERATED_REGISTRY_ARTIFACT } from './generated-registry.js';
import { liveDerivedEntries, liveDerivedEntry, type LiveDerivedEntry } from './live-derived.js';

export interface GeneratedRegistryArtifact {
  formatVersion: 1;
  generatedAt: 'snapshot-content-addressed';
  registryVersion: string;
  checksum: string;
  derivedDefinitions: readonly DrugModelDefinition[];
  /**
   * The grade-relevant facts for each derived definition's assembled routes (CV-3 ↔ CV-4), so a
   * consumer that RESOLVES a derived model can also grade and disclose it. A derived curve without
   * its grade is the "silent family wrongness" the plan's §8 risk list names, so this travels with
   * the definitions rather than being recomputed (which would need the DB the pin exists to avoid).
   *
   * Deliberately OUTSIDE `checksum`, which hashes `{version, definitions}` only: including it would
   * break CV-4a's guarantee that a snapshot with no derived entries reproduces `REGISTRY_CHECKSUM`
   * bit-for-bit. The reproducibility gate byte-compares this whole file, so a changed grade still
   * fails the gate until the artifact is regenerated — the checksum is simply not where that is caught.
   */
  derivedGrades: readonly DerivedModelGrade[];
  supersededByOverride: readonly string[];
  notModelable: readonly {
    slug: string;
    reason: string;
    routes: readonly {
      route: string;
      outcome: 'incomplete' | 'unsupported';
      missing?: readonly string[];
      reason?: string;
      /** Roles the route got by INFERENCE rather than from a cited value (CV-2c-6) — present only
       *  when an inference actually fired for a route that still could not be assembled. */
      inferred?: readonly string[];
      /** Why an attempted inference was refused for this route (CV-2c-6). */
      inferenceDeclined?: string;
      /**
       * Present as `'attributed'` when the read adapter attributed this route rather than reading it
       * from a route-scoped row (CV-2c-7). A curator reading the coverage report must be able to
       * tell "the drug's oral route is missing an F" from "we assumed the route was oral, and then
       * it was missing an F" — the second is answered by keying the route, the first by citing a
       * value.
       */
      routeProvenance?: 'asserted' | 'attributed';
      /**
       * Declared structure axes this entry reports in SIMPLIFIED form (e.g. a two-compartment drug
       * whose one-compartment form is still missing an F). The gap named is the simplified route's:
       * closing it gives the drug a curve even before the declared form can be run.
       */
      simplifiedFrom?: Readonly<Record<string, string>>;
      /** Roles filled with a cautious default here; absent from the catalog all the same. */
      defaulted?: readonly string[];
    }[];
  }[];
}

export interface OfflineRegistryRelease {
  snapshot: RegistrySnapshot;
  notModelable: GeneratedRegistryArtifact['notModelable'];
}

/** Coverage diagnostics remain visible even while model consumption is behind the rollout flag. */
export function generatedRegistryCoverageReport(): GeneratedRegistryArtifact['notModelable'] {
  return GENERATED_REGISTRY_ARTIFACT.notModelable;
}

/**
 * Rebuild through the precedence primitive: committed derived data can never replace an override.
 *
 * Live answers (`live-derived.ts`) are laid over the committed derived tier after its checksum is
 * verified: a live definition replaces or adds its analyte's entry, a live "no model" removes it. The
 * merged release is re-checksummed and versioned `<version>+live`, so a run manifest names the
 * release it actually resolved through and never claims the committed one for a live curve.
 */
export function loadGeneratedRegistry(
  reviewedOverrides: readonly DrugModelDefinition[],
  artifact: GeneratedRegistryArtifact = GENERATED_REGISTRY_ARTIFACT,
  live: readonly LiveDerivedEntry[] = liveDerivedEntries(),
): OfflineRegistryRelease {
  const snapshot = buildRegistrySnapshot(
    reviewedOverrides,
    artifact.derivedDefinitions,
    artifact.registryVersion,
  );
  if (snapshot.checksum !== artifact.checksum) {
    throw new Error(
      `Generated registry checksum mismatch: committed ${artifact.checksum}, computed ${snapshot.checksum}`,
    );
  }
  if (live.length === 0) return { snapshot, notModelable: artifact.notModelable };

  const liveAnalytes = new Set(live.map((entry) => entry.analyte));
  const derived = [
    ...artifact.derivedDefinitions.filter((definition) => !liveAnalytes.has(definition.analyte)),
    ...live.flatMap((entry) => (entry.definition ? [entry.definition] : [])),
  ];
  const builtLive = new Set(live.filter((entry) => entry.definition).map((entry) => entry.analyte));
  return {
    snapshot: buildRegistrySnapshot(reviewedOverrides, derived, `${artifact.registryVersion}+live`),
    notModelable: artifact.notModelable.filter((entry) => !builtLive.has(entry.slug)),
  };
}

/**
 * The grade facts for one derived model's route (live when the app holds a live answer for the
 * analyte, committed otherwise), or `undefined` when there are none: a reviewed override (which
 * carries its own reviewed-tier assessment), or an analyte/route the derived tier does not cover. A caller that resolves a DERIVED model and gets `undefined` here
 * must not render a curve: it would be an ungraded catalog curve.
 */
export function derivedRouteGrade(
  analyte: string,
  route: RouteId,
  artifact: GeneratedRegistryArtifact = GENERATED_REGISTRY_ARTIFACT,
): DerivedRouteGrade | undefined {
  // A live answer supersedes the committed grade facts, exactly as its definition supersedes the
  // committed model — a curve and its grade must describe the same build.
  const live = artifact === GENERATED_REGISTRY_ARTIFACT ? liveDerivedEntry(analyte) : undefined;
  if (live) return live.grade ? findDerivedRouteGrade([live.grade], analyte, route) : undefined;
  return findDerivedRouteGrade(artifact.derivedGrades, analyte, route);
}

/** Whether the derived tier — the committed artifact, or a live answer laid over it — claims this
 *  analyte as a DERIVED (not reviewed) model. */
export function isDerivedAnalyte(
  analyte: string,
  artifact: GeneratedRegistryArtifact = GENERATED_REGISTRY_ARTIFACT,
): boolean {
  const live = artifact === GENERATED_REGISTRY_ARTIFACT ? liveDerivedEntry(analyte) : undefined;
  if (live) return live.definition !== null;
  return artifact.derivedDefinitions.some((definition) => definition.analyte === analyte);
}
