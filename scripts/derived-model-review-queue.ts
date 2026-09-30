/**
 * Derived-model review queue (CV-5 preparation, read-only).
 *
 *   npx tsx scripts/derived-model-review-queue.ts                     # markdown to stdout
 *   npx tsx scripts/derived-model-review-queue.ts --out queue.md      # + write markdown
 *   npx tsx scripts/derived-model-review-queue.ts --json queue.json   # + write JSON
 *
 * The catalog-derivation pipeline (plan `docs/plans/2026-08-21-catalog-driven-model-coverage.md`)
 * can now assemble a runnable, graded model per drug/route from the DB declarations. Before any of
 * that is committed as an artifact (CV-4c-2b-b-2) or enabled for users (CV-5), the plan gates it on
 * a HUMAN batch-review of the families — "missing family science stays missing, never manufactured"
 * (plan §2). This script is the reviewer's worklist: it enumerates every drug, derives its per-route
 * model exactly as the generation would, and reports — per route — the engine family, the grade, WHICH
 * axes were asserted-with-citation vs. filled from the disclosed default, the source citations backing
 * each asserted axis, the parameters the catalog could not supply, and whether a curve would render.
 *
 * **The rendering authority is the ASSEMBLY, not the grade.** A structurally-supported route can lack
 * a required value (an oral first-order route with no `ka` value); `describeDerivedModel` still grades
 * it (a low D) and would call it curve-rendering, but the real generation runs the canonical values
 * through `assembleDrugDefinition`, which drops such an `incomplete` route and emits no model when none
 * assemble. So this queue takes each route's `RouteAssemblyOutcome` as the authority for whether a curve
 * renders — mirroring exactly what the committed artifact would contain — and grades only for the label.
 *
 * It then buckets each drug by REVIEW PRIORITY, most-dangerous first, so the reviewer spends attention
 * where a wrong default does the most harm:
 *
 *   1. default-family-curve   — a curve WOULD render, but the disposition or elimination family itself
 *                               was GUESSED (defaulted). A guessed family is qualitatively wrong science
 *                               presented as an authoritative curve — review first.
 *   2. simplified-family-curve — a curve renders, but on a SIMPLER family than the drug declares (an
 *                               asserted two-compartment disposition run one-compartment because the
 *                               catalog cannot yet supply the micro-constants). The curve is not the
 *                               model its evidence describes — review right after a guessed family.
 *   3. default-parameter-curve — a curve renders only because the bioavailability the catalog
 *                               lacks runs on a labelled cautious default (F = 1). The number
 *                               drawn is an assumption; a cited value would replace it.
 *   4. asserted-complex       — a curve renders on an asserted NON-trivial family (two-compartment,
 *                               saturable, zero/mixed-order, parent-metabolite). Declared, but the
 *                               declaration + its citations need confirming before it ships.
 *   5. uncited-asserted       — a curve renders on a simple, fully-asserted structure, but at least one
 *                               asserted axis carries NO citation — a claimed declaration with no
 *                               evidence. Ranked above a disclosed default: a default is transparent
 *                               about being unstated, an uncited assertion is not.
 *   6. default-absorption     — a curve renders; disposition + elimination are asserted (and cited),
 *                               only the absorption shape was defaulted. Lower stakes (route shape, not
 *                               family).
 *   7. simple-asserted        — a curve renders on the fully-asserted, fully-cited linear
 *                               one-compartment structure. Lowest risk; skim.
 *   8. not-modelable          — declared routes exist but none render a curve. Safe: no curve is drawn
 *                               (missing stays missing). Listed for completeness.
 *   9. superseded-by-override — the drug's slug is already claimed by the reviewed override tier, so
 *                               `buildRegistrySnapshot` drops any derived model for it — users never see
 *                               this derivation. Not a review item; kept separate so a guessed derived
 *                               family here is not mistaken for something that ships.
 *  10. no-route-data          — no per-route declaration authored yet, so the drug contributes NOTHING
 *                               to the derived tier. This is a COVERAGE gap (needs authoring), not a
 *                               review item.
 *
 * A drug's asserted axes carry the citations backing them (aggregated across every declared value for
 * that axis, so a CONFLICTING declaration keeps all its evidence rather than only the value that
 * happens to match the disclosed default the conflict resolves to); an asserted axis with no citation
 * at all is flagged. And a derived model that would be SUPERSEDED by the reviewed override tier —
 * `buildRegistrySnapshot`'s override-always-wins rule — is bucketed separately rather than reported as
 * a curve-rendering review item, since users would never see it.
 *
 * Strictly read-only: it runs the same SELECT-only reads the generation does and writes no DB. The
 * whole-catalog scan runs in ONE `REPEATABLE READ` transaction (as the snapshot builder does), so
 * every drug is classified from a single consistent DB state — an edit committing mid-scan cannot make
 * one drug's several reads observe rows that never coexisted. The report is a point-in-time view of
 * live catalog state — regenerate it on demand; it is deliberately NOT a committed artifact (that is
 * CV-4c-2b-b-2, and it is gated on the review this queue supports).
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { drugs, parameterEntries } from '../db/schema.js';
import { getDb, runInPoolTransaction } from '../api/_lib/db.js';
import { readDrugRouteAssemblyInputs } from '../api/_lib/model-derivation-store.js';
import { describeDerivedModel } from '../src/lib/modelGradeDisclosure.js';
import {
  DERIVED_MODEL_VALIDATION_STATUS,
  derivedDefinitionMetadata,
  MODEL_STRUCTURE_AXIS_PARAMETERS,
} from '../src/lib/modelDerivation.js';
import { assembleDrugDefinition, findModel, registeredAnalytes } from '../src/lib/kinetics-core/index.js';
import type { ModelFamily, ModelGrade, RouteAssemblyOutcome } from '../src/lib/kinetics-core/index.js';

/** Engine families that are qualitatively distinct from the linear one-compartment default — the ones
 *  the plan says to batch-review and backfill into the reviewed override tier first (§CV-5). */
const COMPLEX_FAMILIES: ReadonlySet<ModelFamily> = new Set<ModelFamily>([
  'one-compartment-zero-order',
  'one-compartment-mixed-order',
  'two-compartment-first-order',
  'michaelis-menten',
  'parent-metabolite-first-order',
]);

/** The review buckets, in descending priority (index 0 = review first). */
const BUCKETS = [
  'default-family-curve',
  'simplified-family-curve',
  'default-parameter-curve',
  'asserted-complex',
  'uncited-asserted',
  'default-absorption',
  'simple-asserted',
  'not-modelable',
  'superseded-by-override',
  'no-route-data',
] as const;
type Bucket = (typeof BUCKETS)[number];

const BUCKET_BLURB: Record<Bucket, string> = {
  'default-family-curve':
    'A curve would render, but the **disposition or elimination family was guessed** (disclosed default, not a cited declaration). A guessed family is qualitatively wrong science shown as an authoritative curve — highest review priority.',
  'simplified-family-curve':
    'A curve renders, but on a **simpler family than the drug declares** — e.g. a cited two-compartment disposition run as one-compartment because the catalog cannot yet supply the two-compartment parameters. The curve is not the model its evidence describes; the declaration’s citations back the declared family, not the one drawn.',
  'default-parameter-curve':
    'A curve renders only because the **bioavailability** the catalog lacks runs on a **labelled cautious default** — complete absorption, F = 1 — which pushes the whole curve toward higher concentrations. Authoring a cited value replaces the default.',
  'asserted-complex':
    'A curve renders on an asserted **non-linear / multi-compartment family**. Declared, but confirm the family declaration and its citations before it ships.',
  'uncited-asserted':
    'A curve renders on a simple, fully-asserted structure, but **at least one asserted axis carries no citation** — a claimed declaration with no supporting evidence. Ranked above a disclosed default: a default is transparent about being unstated, an uncited assertion is not.',
  'default-absorption':
    'A curve renders; disposition + elimination are asserted and only the **absorption shape** was defaulted. Lower stakes — a route shape, not the family.',
  'simple-asserted':
    'A curve renders on the fully-asserted **linear one-compartment** structure. Lowest risk — skim to confirm.',
  'not-modelable':
    'Declared routes exist but **none render a curve** (unsupported combination, or a required value the catalog could not supply). Safe: no curve is drawn. Listed for completeness.',
  'superseded-by-override':
    'The drug’s slug is already claimed by the **reviewed override tier**, so `buildRegistrySnapshot` drops any derived model for it — users see the reviewed model, never this derivation. Not a review item; listed so a guessed derived family here is not mistaken for something that ships.',
  'no-route-data':
    'No per-route declaration authored yet, so the drug contributes **nothing** to the derived tier. A coverage gap (needs authoring), not a review item.',
};

type Axis = 'disposition' | 'elimination' | 'absorption';
const AXES: readonly Axis[] = ['disposition', 'elimination', 'absorption'];

/** The stored `parameter` id for each model-structure axis (`dispositionModel`, …). */
const AXIS_PARAM_IDS: readonly string[] = [
  MODEL_STRUCTURE_AXIS_PARAMETERS.disposition,
  MODEL_STRUCTURE_AXIS_PARAMETERS.elimination,
  MODEL_STRUCTURE_AXIS_PARAMETERS.absorption,
];
const PARAM_TO_AXIS: Record<string, Axis> = {
  [MODEL_STRUCTURE_AXIS_PARAMETERS.disposition]: 'disposition',
  [MODEL_STRUCTURE_AXIS_PARAMETERS.elimination]: 'elimination',
  [MODEL_STRUCTURE_AXIS_PARAMETERS.absorption]: 'absorption',
};

interface RouteReview {
  route: string;
  outcome: 'modelable' | 'not-modelable';
  /** Whether the curve would render in the committed artifact — the route's assembly outcome, NOT the
   *  grade. `true` only when `assembleDrugDefinition` reports the route `assembled`. */
  rendersCurve: boolean;
  family: ModelFamily | null;
  structure: Record<Axis, string>;
  /** Axes filled from the disclosed default rather than a cited declaration. */
  defaultedAxes: Axis[];
  /** Asserted axes the route runs in a SIMPLER form than declared, with the declared value (the
   *  structure above is what runs). Empty when the route runs exactly what was declared. */
  simplifiedFrom: Partial<Record<Axis, string>>;
  /** Roles running on a labelled cautious default because the catalog holds no value for them. */
  defaultedParameters: string[];
  grade: ModelGrade | null;
  limitingFactor: string | null;
  /** Required parameter roles the catalog could not supply (why an `incomplete` route does not render). */
  missingParameters: string[];
  /** Citation ids backing this route's ASSERTED axes (disposition + elimination + this route's
   *  absorption), deduplicated and sorted. Empty when nothing is asserted or nothing is cited. */
  sources: number[];
  /** Asserted axes that carry NO citation — a family stated without evidence, or whose citation was
   *  deleted (set null). The reviewer's cheapest red flag. */
  uncitedAxes: Axis[];
  reason: string | null;
}

interface DrugReview {
  slug: string;
  displayName: string;
  bucket: Bucket;
  routes: RouteReview[];
  /** Molecule-level family axes declared drug-wide (route-independent). A drug in `no-route-data`
   *  with these declared is one per-route row away from deriving — the authoring worklist. */
  moleculeAxes: { disposition: string[]; elimination: string[] };
}

/** One stored model-structure axis source row (a categorical declaration + its citation). */
interface AxisSourceRow {
  axis: Axis;
  route: string | null;
  value: string;
  citationId: number | null;
}

/** The citations backing one asserted axis: the distinct cited ids across ALL its declared values,
 *  and whether ANY of those values carries no citation. A cited value cannot cover an uncited one —
 *  on a conflict, one source may back `one-compartment` while another asserts `two-compartment` with
 *  no citation at all; the axis is flagged even though it has SOME evidence. */
interface AxisEvidence {
  citationIds: number[];
  uncited: boolean;
}

/** The evidence key for an axis: molecule axes (disposition/elimination) are route-independent; the
 *  absorption axis is per-route. Deliberately NOT keyed by the axis VALUE — an axis whose declarations
 *  CONFLICT resolves its structure to the disclosed default, so a value-keyed lookup would miss the
 *  citations for the other conflicting value (and could falsely flag the axis uncited). Aggregating
 *  every source row for the axis keeps all conflicting evidence. */
function evidenceKey(axis: Axis, route: string | null): string {
  return axis === 'absorption' ? `${axis} ${route ?? ''}` : axis;
}

/** Index the axis source rows by (axis[, route]) — aggregating every declared value — so an asserted
 *  axis's evidence is a lookup that survives conflicting declarations. */
function indexEvidence(rows: AxisSourceRow[]): Map<string, AxisEvidence> {
  const acc = new Map<string, { ids: Set<number>; anyUncited: boolean }>();
  for (const r of rows) {
    const k = evidenceKey(r.axis, r.route);
    let e = acc.get(k);
    if (!e) acc.set(k, (e = { ids: new Set<number>(), anyUncited: false }));
    if (r.citationId !== null) e.ids.add(r.citationId);
    else e.anyUncited = true;
  }
  const out = new Map<string, AxisEvidence>();
  for (const [k, e] of acc) {
    out.set(k, { citationIds: [...e.ids].sort((a, b) => a - b), uncited: e.anyUncited });
  }
  return out;
}

/** The analyte ids the reviewed override tier claims — each registered analyte plus its aliases. A
 *  derived model whose slug is in this set is dropped by `buildRegistrySnapshot` (the override always
 *  wins), so it never reaches users; computed once. */
let _overrideClaimed: ReadonlySet<string> | null = null;
function overrideClaimedAnalytes(): ReadonlySet<string> {
  if (_overrideClaimed) return _overrideClaimed;
  const claimed = new Set<string>();
  for (const analyte of registeredAnalytes()) {
    claimed.add(analyte);
    for (const alias of findModel(analyte)?.aliases ?? []) claimed.add(alias);
  }
  return (_overrideClaimed = claimed);
}

/** Read a drug's model-structure axis SOURCE rows (categorical declarations + their citation ids), the
 *  evidence the report surfaces alongside each asserted axis and the source of the molecule-axis lists. */
async function readAxisSourceRows(drugId: number): Promise<AxisSourceRow[]> {
  const rows = await getDb()
    .select({
      parameter: parameterEntries.parameter,
      route: parameterEntries.route,
      categoricalValue: parameterEntries.categoricalValue,
      citationId: parameterEntries.citationId,
    })
    .from(parameterEntries)
    .where(
      and(
        eq(parameterEntries.drugId, drugId),
        inArray(parameterEntries.parameter, AXIS_PARAM_IDS as string[]),
        isNotNull(parameterEntries.categoricalValue),
      ),
    );
  return rows.flatMap((r): AxisSourceRow[] => {
    const axis = PARAM_TO_AXIS[r.parameter];
    if (!axis || r.categoricalValue === null) return [];
    return [{ axis, route: r.route, value: r.categoricalValue, citationId: r.citationId ?? null }];
  });
}

/** Classify one drug's derived routes into a single review bucket (worst-wins across its routes). */
function bucketFor(routes: RouteReview[]): Bucket {
  if (routes.length === 0) return 'no-route-data';
  const rendering = routes.filter((r) => r.rendersCurve);
  if (rendering.length === 0) return 'not-modelable';
  // A guessed FAMILY axis (disposition/elimination) on any rendering route is the most dangerous case.
  if (
    rendering.some(
      (r) => r.defaultedAxes.includes('disposition') || r.defaultedAxes.includes('elimination'),
    )
  ) {
    return 'default-family-curve';
  }
  // A declared family run in a simpler form: the curve is not the model the evidence describes.
  if (rendering.some((r) => Object.keys(r.simplifiedFrom).length > 0)) {
    return 'simplified-family-curve';
  }
  // A curve standing on a default for an input the catalog lacks: the number drawn is an assumption.
  if (rendering.some((r) => r.defaultedParameters.length > 0)) {
    return 'default-parameter-curve';
  }
  if (rendering.some((r) => r.family !== null && COMPLEX_FAMILIES.has(r.family))) {
    return 'asserted-complex';
  }
  // An ASSERTED axis with no citation at all is worse than a disclosed default — a default is
  // transparently flagged as unstated, but an uncited assertion claims to be sourced while carrying
  // no evidence. Rank it ahead of a merely-defaulted-absorption route.
  if (rendering.some((r) => r.uncitedAxes.length > 0)) {
    return 'uncited-asserted';
  }
  if (rendering.some((r) => r.defaultedAxes.includes('absorption'))) {
    return 'default-absorption';
  }
  return 'simple-asserted';
}

/**
 * Build the review for one drug exactly as the generation would: read its per-route assembly inputs,
 * assemble them (the rendering authority), and read the axis source rows for the evidence + molecule
 * axes. A route renders iff `assembleDrugDefinition` reports it `assembled`.
 */
async function reviewDrug(
  drugId: number,
  slug: string,
  names: Record<string, string>,
): Promise<DrugReview> {
  const displayName = names.en ?? names.nb ?? Object.values(names)[0] ?? slug;
  const assemblyInputs = await readDrugRouteAssemblyInputs(drugId);
  const assembly = assembleDrugDefinition(
    derivedDefinitionMetadata({ slug, displayName }),
    assemblyInputs,
  );
  const outcomeByRoute = new Map<string, RouteAssemblyOutcome>(
    assembly.routeOutcomes.map((o) => [o.route, o]),
  );

  const axisRows = await readAxisSourceRows(drugId);
  const evidence = indexEvidence(axisRows);
  const evidenceFor = (axis: Axis, route: string | null): AxisEvidence | undefined =>
    evidence.get(evidenceKey(axis, axis === 'absorption' ? route : null));

  const routes: RouteReview[] = assemblyInputs.map(({ route, derived, simplifiedFrom = {}, defaultedParameters = [] }) => {
    const simplifiedAxes = AXES.filter((axis) => simplifiedFrom[axis] !== undefined);
    // Grade with the same inputs the derived tier carries: a freshly-derived, unvalidated catalog
    // model (`literature-derived`), source quality not yet assessed (omitted). The grade is a LABEL —
    // the rendering authority below is the assembly outcome, not the grade. A simplified axis is
    // graded as the derived tier grades it: like a defaulted one, since the structure that runs is
    // not the one the evidence asserts.
    // A cautious default is graded as the input it stands in for: missing from the catalog.
    const withDefaultsAsMissing =
      defaultedParameters.length === 0
        ? derived
        : {
            ...derived,
            missingParameters: [
              ...new Set([...(derived.missingParameters ?? []), ...defaultedParameters]),
            ],
          };
    const graded =
      simplifiedAxes.length === 0
        ? withDefaultsAsMissing
        : {
            ...withDefaultsAsMissing,
            defaulted: true,
            axisProvenance: Object.fromEntries(
              AXES.map((axis) => [
                axis,
                simplifiedAxes.includes(axis) ? 'defaulted' : derived.axisProvenance[axis],
              ]),
            ) as typeof derived.axisProvenance,
          };
    const disclosure = describeDerivedModel(graded, {
      validationStatus: DERIVED_MODEL_VALIDATION_STATUS,
    });
    const outcome = outcomeByRoute.get(route);
    const defaultedAxes = AXES.filter((axis) => derived.axisProvenance[axis] === 'defaulted');
    // A simplified axis's citations back the DECLARED family, not the one drawn, so they are not
    // listed as support for the displayed structure.
    const assertedAxes = AXES.filter(
      (axis) => derived.axisProvenance[axis] === 'asserted' && !simplifiedAxes.includes(axis),
    );

    // Evidence for the asserted axes: disposition/elimination are molecule-level (null route), the
    // absorption axis is this route's. Collect the cited ids and flag any asserted axis with none.
    const sources = new Set<number>();
    const uncitedAxes: Axis[] = [];
    for (const axis of assertedAxes) {
      const ev = evidenceFor(axis, axis === 'absorption' ? route : null);
      if (!ev || ev.uncited) uncitedAxes.push(axis);
      for (const id of ev?.citationIds ?? []) sources.add(id);
    }

    return {
      route,
      outcome: derived.outcome,
      // Authoritative: the route renders a curve only if it actually assembles into a runnable model.
      rendersCurve: outcome?.outcome === 'assembled',
      family: derived.family ?? null,
      structure: {
        disposition: derived.structure.disposition,
        elimination: derived.structure.elimination,
        absorption: derived.structure.absorption,
      },
      defaultedAxes,
      simplifiedFrom: { ...simplifiedFrom },
      defaultedParameters: [...defaultedParameters].sort(),
      grade: disclosure.grade,
      limitingFactor: disclosure.limitingFactor,
      // Prefer the assembler's value-based view of what is missing (what actually blocked the curve),
      // falling back to the structural derivation's roles.
      missingParameters: outcome?.missing ?? derived.missingParameters ?? [],
      sources: [...sources].sort((a, b) => a - b),
      uncitedAxes,
      reason: outcome?.reason ?? derived.reason ?? null,
    };
  });

  // Molecule axes (for the no-route-data authoring split): distinct declared disposition/elimination
  // values, from the same source rows.
  const distinct = (axis: Axis): string[] =>
    [...new Set(axisRows.filter((r) => r.axis === axis).map((r) => r.value))].sort();

  // Supersession: `buildRegistrySnapshot` drops a derived model whose slug is claimed by the reviewed
  // override tier (the override always wins), so such a drug never ships a derived curve — bucket it
  // separately rather than as a review item, whatever its routes would derive.
  const superseded = overrideClaimedAnalytes().has(slug);

  return {
    slug,
    displayName,
    bucket: superseded ? 'superseded-by-override' : bucketFor(routes),
    routes,
    moleculeAxes: { disposition: distinct('disposition'), elimination: distinct('elimination') },
  };
}

function fmtAxis(r: RouteReview, axis: Axis): string {
  const v = r.structure[axis];
  if (r.defaultedAxes.includes(axis)) return `_${v}_ (default)`;
  const declared = r.simplifiedFrom[axis];
  if (declared !== undefined) return `_${v}_ (simplified from ${declared})`;
  return r.uncitedAxes.includes(axis) ? `${v} ⚠️` : v;
}

function renderMarkdown(reviews: DrugReview[]): string {
  const byBucket = new Map<Bucket, DrugReview[]>(BUCKETS.map((b) => [b, []]));
  for (const r of reviews) byBucket.get(r.bucket)!.push(r);

  const lines: string[] = [];
  lines.push('# Derived-model review queue');
  lines.push('');
  lines.push(
    '_Generated by `scripts/derived-model-review-queue.ts` — a point-in-time view of live catalog ' +
      'state. Regenerate on demand; not a committed artifact._',
  );
  lines.push('');
  lines.push(
    'What the catalog-derivation pipeline would produce **right now**, per drug and route, so the ' +
      'families can be batch-reviewed before the derived tier is committed (CV-4c-2b-b-2) or enabled ' +
      'for users (CV-5). Review top-down: the first buckets are where a wrong default does the most harm. ' +
      'A ⚠️ on an asserted axis means it carries **no citation**.',
  );
  lines.push('');

  // Summary table.
  lines.push('## Summary');
  lines.push('');
  lines.push('| Priority | Bucket | Drugs |');
  lines.push('|---|---|---|');
  BUCKETS.forEach((b, i) => {
    const count = byBucket.get(b)!.length;
    lines.push(`| ${i + 1} | \`${b}\` | ${count} |`);
  });
  lines.push(`| | **Total drugs** | **${reviews.length}** |`);
  lines.push('');

  for (const bucket of BUCKETS) {
    const items = byBucket.get(bucket)!;
    lines.push(`## \`${bucket}\` — ${items.length} drug(s)`);
    lines.push('');
    lines.push(BUCKET_BLURB[bucket]);
    lines.push('');
    if (items.length === 0) {
      lines.push('_None._');
      lines.push('');
      continue;
    }
    if (bucket === 'superseded-by-override') {
      // A reviewed override ships instead — the derived detail is moot. A compact name list suffices.
      lines.push(items.map((d) => `\`${d.slug}\``).join(', '));
      lines.push('');
      continue;
    }
    if (bucket === 'no-route-data') {
      // No routes to tabulate. Split by authoring-readiness: a drug that already declares a
      // molecule-level family axis (disposition/elimination) is one per-route row away from
      // deriving — that is the authoring worklist. A drug with no declaration at all needs the
      // family science stated first.
      const hasFamily = (d: DrugReview): boolean =>
        d.moleculeAxes.disposition.length > 0 || d.moleculeAxes.elimination.length > 0;
      const ready = items.filter(hasFamily);
      const undeclared = items.filter((d) => !hasFamily(d));
      lines.push(
        `**${ready.length}** already declare a molecule-level family axis — authoring one per-route ` +
          `absorption/\`F\`/\`ka\` row would derive them. **${undeclared.length}** have no family ` +
          `declaration yet.`,
      );
      lines.push('');
      if (ready.length > 0) {
        lines.push('### Family declared — ready for per-route authoring');
        lines.push('');
        lines.push('| Drug | Disposition | Elimination |');
        lines.push('|---|---|---|');
        for (const d of ready) {
          lines.push(
            `| **${d.displayName}** (\`${d.slug}\`) | ${d.moleculeAxes.disposition.join(', ') || '—'} | ` +
              `${d.moleculeAxes.elimination.join(', ') || '—'} |`,
          );
        }
        lines.push('');
      }
      if (undeclared.length > 0) {
        lines.push('### No family declaration yet');
        lines.push('');
        lines.push(undeclared.map((d) => `\`${d.slug}\``).join(', '));
        lines.push('');
      }
      continue;
    }
    lines.push(
      '| Drug | Route | Grade | Family | Disposition | Elimination | Absorption | Sources | Missing params | Note |',
    );
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const d of items) {
      d.routes.forEach((r, idx) => {
        const name = idx === 0 ? `**${d.displayName}** (\`${d.slug}\`)` : '';
        const grade = r.rendersCurve ? (r.grade ?? '—') : '— (no curve)';
        const family = r.family ?? '—';
        const sources = r.sources.length ? r.sources.map((id) => `#${id}`).join(', ') : '—';
        const missing = r.missingParameters.length ? r.missingParameters.join(', ') : '—';
        const notes: string[] = [];
        if (r.outcome === 'not-modelable' || !r.rendersCurve) {
          notes.push(`no curve${r.reason ? `: ${r.reason}` : ''}`);
        } else if (r.limitingFactor) {
          notes.push(`limited by ${r.limitingFactor}`);
        }
        if (r.uncitedAxes.length) notes.push(`⚠️ uncited: ${r.uncitedAxes.join(', ')}`);
        if (r.defaultedParameters.length) {
          notes.push(`cautious default: ${r.defaultedParameters.join(', ')}`);
        }
        lines.push(
          `| ${name} | ${r.route} | ${grade} | ${family} | ${fmtAxis(r, 'disposition')} | ` +
            `${fmtAxis(r, 'elimination')} | ${fmtAxis(r, 'absorption')} | ${sources} | ${missing} | ${notes.join('; ')} |`,
        );
      });
    }
    lines.push('');
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flagValue = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  const outArg = flagValue('--out');
  const jsonArg = flagValue('--json');

  // One consistent snapshot: enumerate and read every drug inside a single REPEATABLE READ
  // transaction, exactly as the snapshot builder does, so no drug is classified from rows that never
  // coexisted (each per-drug read issues several queries).
  const reviews = await runInPoolTransaction(async (): Promise<DrugReview[]> => {
    await getDb().execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    const drugRows = await getDb()
      .select({ id: drugs.id, slug: drugs.slug, names: drugs.names })
      .from(drugs)
      .orderBy(asc(drugs.slug));
    const acc: DrugReview[] = [];
    for (const row of drugRows) {
      acc.push(await reviewDrug(row.id, row.slug, row.names));
    }
    return acc;
  });

  // Order: bucket priority, then slug — the reviewer reads it top to bottom.
  const rank = new Map<Bucket, number>(BUCKETS.map((b, i) => [b, i]));
  reviews.sort((a, b) => rank.get(a.bucket)! - rank.get(b.bucket)! || a.slug.localeCompare(b.slug));

  const markdown = renderMarkdown(reviews);
  if (outArg) {
    writeFileSync(outArg, markdown);
    console.error(`Wrote ${outArg}`);
  }
  if (jsonArg) {
    writeFileSync(jsonArg, JSON.stringify(reviews, null, 2));
    console.error(`Wrote ${jsonArg}`);
  }
  if (!outArg && !jsonArg) {
    console.log(markdown);
  } else {
    // A one-line summary to stderr so a redirected-to-file run still reports coverage.
    const counts = BUCKETS.map((b) => `${b}=${reviews.filter((r) => r.bucket === b).length}`);
    console.error(`Reviewed ${reviews.length} drug(s): ${counts.join(', ')}`);
  }
}

if (process.argv[1]?.endsWith('derived-model-review-queue.ts')) {
  await main();
}

export { bucketFor, renderMarkdown, reviewDrug };
export type { DrugReview, RouteReview, Bucket };
