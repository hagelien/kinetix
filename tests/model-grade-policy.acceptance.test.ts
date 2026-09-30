/**
 * Owner-approved acceptance contract for the model-grade release policy.
 *
 * These cases were written against a local oracle so the approved examples and
 * boundaries could be reviewed before production code existed. They now run
 * against the production evaluator (`kinetics-core/grade-policy.ts`) with every
 * expected outcome preserved: the oracle is gone, the expectations are not.
 *
 * Amendment 1 (plan §5.2) is a parameter, not a rewrite — with the public tier
 * off, these are exactly the §5.1 outcomes they always were. The amendment's own
 * behaviour is pinned separately at the bottom, so a future change cannot
 * quietly trade one contract for the other.
 */
import { describe, expect, it } from "vitest";
import {
  GRADE_DIMENSIONS,
  evaluateGradePolicy,
  renderDisposition,
  type DimensionAssessment,
  type DimensionGrade,
  type RenderDisposition,
  type UserClass,
} from "../src/lib/kinetics-core/grade-policy";

type Grade = "A" | "B" | "C" | "D";

/**
 * Build a full eight-dimension assessment whose weakest links are `factors`.
 * Unlisted dimensions are A, so each case isolates exactly what it names.
 */
function assessment(
  factors: DimensionGrade[],
  { hardStop = false }: { hardStop?: boolean } = {},
): DimensionAssessment[] {
  const grades: DimensionGrade[] = hardStop
    ? [...factors, "hard-stop"]
    : factors;
  return GRADE_DIMENSIONS.map((dimension, index) => ({
    dimension,
    grade: grades[index] ?? "A",
  }));
}

function gradeOf(factors: DimensionGrade[], hardStop = false) {
  return evaluateGradePolicy(assessment(factors, { hardStop })).grade;
}

function disposition(
  user: UserClass,
  grade: Grade,
  acknowledged = false,
  publicTier = false,
): RenderDisposition {
  // A single dimension at `grade` drives the weakest link, so the disposition
  // under test is the one for that overall grade.
  return renderDisposition(evaluateGradePolicy(assessment([grade])), user, {
    acknowledged,
    publicTier,
  });
}

describe("model-grade policy acceptance — user-class gates", () => {
  it.each([
    ["anonymous", "A", false, "render"],
    ["anonymous", "B", false, "render-with-limitations"],
    ["anonymous", "C", false, "hidden"],
    ["authenticated", "C", true, "hidden"],
    ["contributor", "C", true, "hidden"],
    ["editor", "C", false, "render-with-limitations"],
    ["admin", "C", false, "render-with-limitations"],
    ["editor", "D", false, "acknowledge-in-review-workspace"],
    ["editor", "D", true, "render-with-limitations"],
    ["admin", "D", true, "render-with-limitations"],
  ] satisfies Array<[UserClass, Grade, boolean, RenderDisposition]>)(
    "%s / grade %s / acknowledged=%s → %s",
    (user, grade, acknowledged, expected) => {
      expect(disposition(user, grade, acknowledged)).toBe(expected);
    },
  );

  it("never lets acknowledgement elevate a non-reviewer", () => {
    for (const user of [
      "anonymous",
      "authenticated",
      "contributor",
    ] satisfies UserClass[]) {
      expect(disposition(user, "D", true)).toBe("hidden");
    }
  });
});

type EvidenceCase = {
  name: string;
  factors: Grade[];
  expected: Grade | "ungraded";
  hardStop?: boolean;
};

const approvedCases: EvidenceCase[] = [
  {
    name: "direct, complete, independently validated evidence",
    factors: ["A", "A", "A"],
    expected: "A",
  },
  {
    name: "otherwise A but only benchmark checked",
    factors: ["A", "A", "B"],
    expected: "B",
  },
  {
    name: "unreviewed decisive primary source caps the model",
    factors: ["A", "C", "A"],
    expected: "C",
  },
  {
    name: "unknown uncertainty semantics makes the model insufficient",
    factors: ["A", "A", "D"],
    expected: "D",
  },
  {
    name: "one weak dimension cannot be averaged away",
    factors: ["A", "A", "A", "C"],
    expected: "C",
  },
  {
    name: "unbridged route mismatch is a hard stop",
    factors: ["A", "A", "A"],
    expected: "ungraded",
    hardStop: true,
  },
  {
    name: "material family contradiction is a hard stop",
    factors: ["B", "C", "B"],
    expected: "ungraded",
    hardStop: true,
  },
];

describe("model-grade policy acceptance — evidence boundaries", () => {
  it.each(approvedCases)("$name → $expected", (testCase) => {
    expect(gradeOf(testCase.factors, testCase.hardStop)).toBe(
      testCase.expected,
    );
  });

  it("hard stops are not bypassed by admin role or acknowledgement", () => {
    const stopped = approvedCases.filter((testCase) => testCase.hardStop);
    expect(stopped).not.toHaveLength(0);
    for (const testCase of stopped) {
      const result = evaluateGradePolicy(
        assessment(testCase.factors, { hardStop: true }),
      );
      expect(result.grade).toBe("ungraded");
      // Every escape route, closed: role, acknowledgement, and the amendment.
      for (const user of [
        "anonymous",
        "editor",
        "admin",
      ] satisfies UserClass[]) {
        expect(
          renderDisposition(result, user, {
            acknowledged: true,
            publicTier: true,
          }),
        ).toBe("hidden");
      }
    }
  });

  it("treats an unassessed dimension as unknown, not as passing", () => {
    // Only three of eight dimensions supplied; the rest must not read as A.
    const partial: DimensionAssessment[] = [
      { dimension: "completeness", grade: "A" },
      { dimension: "parameter-provenance", grade: "A" },
      { dimension: "validation-status", grade: "A" },
    ];
    expect(evaluateGradePolicy(partial).grade).toBe("D");
  });

  it("keeps the worse of a duplicated dimension", () => {
    const duplicated: DimensionAssessment[] = [
      ...GRADE_DIMENSIONS.map((dimension) => ({
        dimension,
        grade: "A" as const,
      })),
      { dimension: "validation-status", grade: "C" },
    ];
    expect(evaluateGradePolicy(duplicated).grade).toBe("C");
  });
});

describe("model-grade policy acceptance — Amendment 1 (disclosed public tier)", () => {
  it("lets a C model reach the public only with the tier in force", () => {
    expect(disposition("anonymous", "C", false, false)).toBe("hidden");
    expect(disposition("anonymous", "C", false, true)).toBe(
      "render-with-limitations",
    );
  });

  it("does not move the D gate for anyone", () => {
    for (const user of [
      "anonymous",
      "authenticated",
      "contributor",
    ] satisfies UserClass[]) {
      expect(disposition(user, "D", false, true)).toBe("hidden");
      expect(disposition(user, "D", true, true)).toBe("hidden");
    }
    // A reviewer's D path is unchanged by the amendment.
    expect(disposition("editor", "D", false, true)).toBe(
      "acknowledge-in-review-workspace",
    );
  });

  it("still renders a C model carrying its limitations, never as clean", () => {
    const result = evaluateGradePolicy(assessment(["C"]));
    expect(renderDisposition(result, "anonymous", { publicTier: true })).toBe(
      "render-with-limitations",
    );
    // Condition 2: every sub-B dimension is itemised for disclosure.
    expect(result.disclosable.length).toBeGreaterThan(0);
  });
});
