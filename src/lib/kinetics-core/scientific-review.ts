/**
 * Fail-closed scientific release review for calculation-driving artifacts.
 *
 * A packet is evidence; an approval is a separate, named attestation over the
 * packet and the exact release tuple.  Keeping those concepts separate prevents
 * a complete-looking packet, or a stale approval, from promoting itself.
 */
import { hashValue } from "./hash.js";

export const REVIEW_PACKET_SCHEMA_VERSION = "1";

export type ReviewArtifactKind =
  | "model"
  | "parameter-set"
  | "covariate-function"
  | "matrix-transform"
  | "error-model"
  | "validation-dataset";

export type ValidationGrade = "A" | "B" | "C" | "D" | "unsupported";
export type ReviewFailureDisposition =
  | "experimental"
  | "reviewer-only"
  | "unsupported";

export interface VersionedReviewArtifact {
  kind: ReviewArtifactKind;
  id: string;
  version: string;
  /** Hash of the canonical artifact, not a mutable filename or branch. */
  checksum: string;
  change: "new" | "changed";
}

export interface ScientificReviewer {
  /** A person's full name; team names and anonymous approvals are invalid. */
  name: string;
  affiliation: string;
  scientificQualifications: string;
}

export interface ReviewEvidenceItem {
  id: string;
  result: string;
  evidenceUri?: string;
}

export interface ScientificReviewPacket {
  schemaVersion: typeof REVIEW_PACKET_SCHEMA_VERSION;
  packetId: string;
  artifacts: VersionedReviewArtifact[];
  primarySourceExtractions: ReviewEvidenceItem[];
  applicabilityBoundaries: string[];
  parameterAndUnitChecks: ReviewEvidenceItem[];
  deterministicFixtureDiffs: ReviewEvidenceItem[];
  stochasticFixtureDiffs: ReviewEvidenceItem[];
  literatureLandmarkResults: ReviewEvidenceItem[];
  /** May explicitly say that no suitable observed dataset exists. */
  observedDataComparisons: ReviewEvidenceItem[];
  beforeAfterCurves: ReviewEvidenceItem[];
  limitations: string[];
  proposedValidationGrade: ValidationGrade;
}

export interface ScientificReviewApproval {
  packetId: string;
  packetChecksum: string;
  decision: "approved" | "failed" | "unavailable";
  reviewer: ScientificReviewer | null;
  reviewedAt: string;
  validationGrade: ValidationGrade;
  failureDisposition: ReviewFailureDisposition;
  modelVersion: string;
  parameterVersion: string;
  registryVersion: string;
  coreVersion: string;
  notes: string;
}

export interface ScientificReleaseVersions {
  modelVersion: string;
  parameterVersion: string;
  registryVersion: string;
  coreVersion: string;
}

export type ScientificReleaseDecision =
  | { production: true; access: "production"; grade: ValidationGrade }
  | {
      production: false;
      access: ReviewFailureDisposition;
      grade: "unsupported";
      reasons: string[];
    };

export function reviewPacketChecksum(packet: ScientificReviewPacket): string {
  return hashValue(packet);
}

const EVIDENCE_SECTIONS: ReadonlyArray<keyof ScientificReviewPacket> = [
  "primarySourceExtractions",
  "applicabilityBoundaries",
  "parameterAndUnitChecks",
  "deterministicFixtureDiffs",
  "stochasticFixtureDiffs",
  "literatureLandmarkResults",
  "observedDataComparisons",
  "beforeAfterCurves",
  "limitations",
];

function nonBlank(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

/** Returns every defect that prevents a packet from being eligible for approval. */
export function auditScientificReviewPacket(
  packet: ScientificReviewPacket,
): string[] {
  const errors: string[] = [];
  if (packet.schemaVersion !== REVIEW_PACKET_SCHEMA_VERSION)
    errors.push("unsupported packet schema");
  if (!nonBlank(packet.packetId)) errors.push("packetId is required");
  if (packet.artifacts.length === 0)
    errors.push("at least one versioned artifact is required");
  const keys = new Set<string>();
  for (const artifact of packet.artifacts) {
    const key = `${artifact.kind}:${artifact.id}`;
    if (keys.has(key)) errors.push(`duplicate artifact ${key}`);
    keys.add(key);
    if (![artifact.id, artifact.version, artifact.checksum].every(nonBlank)) {
      errors.push(`artifact ${key} lacks id, version, or checksum`);
    }
  }
  for (const section of EVIDENCE_SECTIONS) {
    const values = packet[section] as unknown[];
    if (values.length === 0) errors.push(`${section} must be documented`);
  }
  return errors;
}

/**
 * Decide whether the exact release may be exposed as production.
 * Missing/malformed/stale/failed review always fails closed.  Callers may use
 * the returned access value to expose it only in an explicitly restricted lane.
 */
export function evaluateScientificRelease(
  packet: ScientificReviewPacket,
  approval: ScientificReviewApproval | null,
  versions: ScientificReleaseVersions,
): ScientificReleaseDecision {
  const reasons = auditScientificReviewPacket(packet);
  if (!approval) reasons.push("named scientific approval is unavailable");
  if (approval) {
    if (approval.decision !== "approved")
      reasons.push(`review decision is ${approval.decision}`);
    if (approval.packetId !== packet.packetId)
      reasons.push("approval names a different packet");
    if (approval.packetChecksum !== reviewPacketChecksum(packet))
      reasons.push("packet changed after review");
    if (!approval.reviewer || !nonBlank(approval.reviewer.name))
      reasons.push("named reviewer is required");
    if (
      !approval.reviewer ||
      !nonBlank(approval.reviewer.scientificQualifications)
    ) {
      reasons.push("reviewer scientific qualifications are required");
    }
    for (const key of [
      "modelVersion",
      "parameterVersion",
      "registryVersion",
      "coreVersion",
    ] as const) {
      if (approval[key] !== versions[key])
        reasons.push(`${key} is not the approved version`);
    }
    if (approval.validationGrade === "unsupported")
      reasons.push("unsupported grade cannot enter production");
  }
  if (reasons.length === 0 && approval) {
    return {
      production: true,
      access: "production",
      grade: approval.validationGrade,
    };
  }
  return {
    production: false,
    access: approval?.failureDisposition ?? "experimental",
    grade: "unsupported",
    reasons,
  };
}
