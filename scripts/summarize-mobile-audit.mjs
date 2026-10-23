import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import console from "node:console";

// Produce a compact, reviewable index from the raw Playwright attachments.
// No source code, production data, or application state is read or changed.
const input = resolve(process.argv[2] ?? "test-results");
const output = resolve(
  process.argv[3] ?? "artifacts/mobile-audit-summary.json",
);
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((e) => e.name !== "attachments")
      .map((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? files(path) : [path];
      }),
  );
  return nested.flat();
}
const summaries = [];
for (const path of (await files(input)).filter((name) =>
  name.endsWith(".json"),
)) {
  const audit = JSON.parse(await readFile(path, "utf8"));
  if (!audit.surface || !audit.metrics || !audit.accessibility) continue;
  const { metrics: m } = audit;
  summaries.push({
    project: audit.project,
    surface: audit.surface,
    route: audit.route,
    browser: audit.browser,
    buildMode: audit.buildMode,
    viewport: m.viewport,
    headerHeight: m.header?.height ?? null,
    railWidth: m.rail?.width ?? null,
    routeWidth: m.routePane?.width ?? null,
    documentOverflow: Math.max(0, m.pageWidth - m.viewport.width),
    targetsBelow44: m.targets.filter((target) => target.below44).length,
    targetsCenterObscured: m.targets.filter((target) => target.centerObscured)
      .length,
    accessibility: audit.accessibility.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.length,
    })),
    manualReviewRules: audit.accessibility.incomplete,
    // Paths identify loaded chunks. Transfer bytes may be zero for cached
    // resources; use the separate cold-context benchmark for download budgets.
    loadedScripts: m.scripts.map((script) => script.path),
  });
}
if (!summaries.length)
  throw new Error(`No mobile audit attachments found in ${input}`);
summaries.sort((a, b) =>
  `${a.project}:${a.surface}`.localeCompare(`${b.project}:${b.surface}`),
);
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      schema: "kinetix-mobile-audit-v1",
      note: "Characterization evidence, not a release approval or WCAG conformance claim. All scientific content is synthetic.",
      surfaces: summaries,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Summarized ${summaries.length} surfaces in ${output}`);
