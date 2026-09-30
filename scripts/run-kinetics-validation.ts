/** CI entry point for versioned, reviewed kinetics validation fixtures. */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  renderVersionedValidationReport,
  validateVersionedSuite,
  type VersionedValidationFixture,
} from "../src/lib/kinetics-core/validation.js";
import {
  registeredAnalytes,
  findModel,
} from "../src/lib/kinetics-core/registry.js";

const fixtureDir = resolve("src/lib/kinetics-core/validation-fixtures");
const fixtures = readdirSync(fixtureDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map(
    (name) =>
      JSON.parse(
        readFileSync(resolve(fixtureDir, name), "utf8"),
      ) as VersionedValidationFixture,
  );

const baseArg = process.argv.find((arg) => arg.startsWith("--base="))?.slice(7);
let changed: string[] = [];
if (baseArg) {
  changed = execFileSync("git", ["diff", "--name-only", `${baseArg}...HEAD`], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
}

// A core/solver/version change can affect every model. A registry change is narrowed to
// parameter sets whose analyte/model text changed; when that cannot be proved, fail closed
// and require every model to have a selected fixture.
const broadChange = changed.some((p) =>
  /kinetics-core\/(simulate|solver|equations|version|types)\.ts$/.test(p),
);
const registryChanged = changed.includes("src/lib/kinetics-core/registry.ts");
const requiredModels = new Set<string>();
if (broadChange)
  registeredAnalytes().forEach((a) =>
    requiredModels.add(findModel(a)!.modelId),
  );
if (registryChanged) {
  const diff = execFileSync(
    "git",
    [
      "diff",
      "--unified=0",
      `${baseArg}...HEAD`,
      "--",
      "src/lib/kinetics-core/registry.ts",
    ],
    { encoding: "utf8" },
  );
  for (const analyte of registeredAnalytes())
    if (diff.toLowerCase().includes(analyte.toLowerCase()))
      requiredModels.add(findModel(analyte)!.modelId);
  if (requiredModels.size === 0)
    registeredAnalytes().forEach((a) =>
      requiredModels.add(findModel(a)!.modelId),
    );
}
const covered = new Set(fixtures.map((f) => f.modelId));
const missing = [...requiredModels].filter((id) => !covered.has(id));
if (missing.length)
  throw new Error(
    `Changed scientific surface has no reviewed validation fixture for model(s): ${missing.join(", ")}`,
  );

const nowIso = process.env.VALIDATION_TIMESTAMP ?? "2026-08-26T00:00:00.000Z";
const report = validateVersionedSuite(fixtures, nowIso);
const markdown = renderVersionedValidationReport(report);
mkdirSync(resolve("artifacts"), { recursive: true });
writeFileSync(resolve("artifacts/kinetics-validation.md"), markdown);
writeFileSync(
  resolve("artifacts/kinetics-validation.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(markdown);
if (!report.passed) process.exitCode = 1;
