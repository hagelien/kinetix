import { describe, expect, it } from "vitest";
import {
  REVIEW_PACKET_SCHEMA_VERSION,
  evaluateScientificRelease,
  reviewPacketChecksum,
  type ScientificReviewApproval,
  type ScientificReviewPacket,
} from "../scientific-review";

const versions = {
  modelVersion: "2",
  parameterVersion: "7",
  registryVersion: "3",
  coreVersion: "4",
};
const packet: ScientificReviewPacket = {
  schemaVersion: REVIEW_PACKET_SCHEMA_VERSION,
  packetId: "cocaine-2",
  artifacts: [
    {
      kind: "model",
      id: "cocaine",
      version: "2",
      checksum: "model-sha256",
      change: "changed",
    },
  ],
  primarySourceExtractions: [{ id: "paper-1", result: "extracted table 2" }],
  applicabilityBoundaries: ["healthy adults; plasma; intranasal"],
  parameterAndUnitChecks: [
    { id: "units", result: "canonical L/kg and hours verified" },
  ],
  deterministicFixtureDiffs: [{ id: "det", result: "expected diff reviewed" }],
  stochasticFixtureDiffs: [{ id: "mc", result: "seeded quantiles reviewed" }],
  literatureLandmarkResults: [
    { id: "cmax", result: "within prespecified tolerance" },
  ],
  observedDataComparisons: [
    { id: "dataset", result: "no suitable open individual-level dataset" },
  ],
  beforeAfterCurves: [{ id: "curve", result: "overlay reviewed" }],
  limitations: ["not validated in hepatic impairment"],
  proposedValidationGrade: "B",
};

function approval(
  overrides: Partial<ScientificReviewApproval> = {},
): ScientificReviewApproval {
  return {
    packetId: packet.packetId,
    packetChecksum: reviewPacketChecksum(packet),
    decision: "approved",
    reviewer: {
      name: "Ada Reviewer",
      affiliation: "Example University",
      scientificQualifications: "PhD pharmacometrics",
    },
    reviewedAt: "2026-08-26T00:00:00.000Z",
    validationGrade: "B",
    failureDisposition: "reviewer-only",
    ...versions,
    notes: "Approved within documented boundaries.",
    ...overrides,
  };
}

describe("scientific production review gate", () => {
  it("requires a complete packet and named, qualified approval of the exact release tuple", () => {
    expect(evaluateScientificRelease(packet, approval(), versions)).toEqual({
      production: true,
      access: "production",
      grade: "B",
    });
  });

  it("fails closed when review is unavailable or failed", () => {
    expect(evaluateScientificRelease(packet, null, versions)).toMatchObject({
      production: false,
      access: "experimental",
    });
    expect(
      evaluateScientificRelease(
        packet,
        approval({ decision: "failed" }),
        versions,
      ),
    ).toMatchObject({
      production: false,
      access: "reviewer-only",
    });
  });

  it("invalidates approval after packet or release version changes", () => {
    const changed = {
      ...packet,
      limitations: [...packet.limitations, "new limitation"],
    };
    expect(
      evaluateScientificRelease(changed, approval(), versions),
    ).toMatchObject({ production: false });
    const result = evaluateScientificRelease(packet, approval(), {
      ...versions,
      coreVersion: "5",
    });
    expect(result).toMatchObject({ production: false });
    if (!result.production)
      expect(result.reasons).toContain(
        "coreVersion is not the approved version",
      );
  });

  it("rejects omitted packet sections and anonymous approval", () => {
    const incomplete = { ...packet, stochasticFixtureDiffs: [] };
    const result = evaluateScientificRelease(
      incomplete,
      approval({ reviewer: null }),
      versions,
    );
    expect(result).toMatchObject({ production: false });
    if (!result.production) {
      expect(result.reasons).toContain(
        "stochasticFixtureDiffs must be documented",
      );
      expect(result.reasons).toContain("named reviewer is required");
    }
  });
});
