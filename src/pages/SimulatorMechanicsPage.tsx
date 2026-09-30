import { Fragment, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { renderMarkdown } from '@/lib/renderMarkdown';
import mechanicsMarkdown from '../../docs/simulator-mechanics.md?raw';
import {
  mechanicsFamilies,
  mechanicsLimits,
  mechanicsModels,
  mechanicsVersions,
  splitMechanicsDocument,
} from '@/lib/simulatorMechanics';

/**
 * "How the simulator works" — the behind-the-scenes account of the modelling module,
 * written for a pharmacologist reviewing whether a curve may be relied on.
 *
 * The prose is `docs/simulator-mechanics.md`, imported raw so the document in the repo IS
 * the published page (no second copy to fall behind). Wherever that document would have
 * had to transcribe a fact about the running system — which analytes resolve, which model
 * families exist, which caps and defaults apply, which release produced the curve — it
 * carries a `{{live:…}}` token instead, and this component renders the fact from
 * `kinetics-core` at page load. So the page cannot describe last quarter's simulator.
 *
 * `src/lib/__tests__/simulatorMechanics.test.ts` pins the remaining prose against the code.
 */

function SectionTable({
  head,
  rows,
}: {
  head: string[];
  rows: Array<ReactNode[]>;
}) {
  return (
    <div className="my-4 overflow-x-auto rounded-md border">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="bg-muted/50 text-left">
            {head.map((h) => (
              <th key={h} className="px-2.5 py-1.5 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} className="border-t align-top">
              {cells.map((cell, j) => (
                <td key={j} className="px-2.5 py-1.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The document body — prose and live tables alike — is maintained in English, the language
 * of the pharmacology literature a reviewer will be checking it against, and the language
 * `docs/simulator-mechanics.md` is written in. Localising only the table chrome would
 * produce a half-Norwegian document, which reads worse than a consistently English one.
 * The app chrome around it (the back link, the entry points that lead here) IS localised,
 * as is the notice below that says which language the document is in.
 */
const ITEM = 'Item';
const VALUE = 'Value';

function VersionsBlock() {
  const v = mechanicsVersions();
  return (
    <SectionTable
      head={[ITEM, VALUE]}
      rows={[
        [
          'Engine release (kinetics-core)',
          <code key="c">{v.coreVersion}</code>,
        ],
        [
          'Scenario contract version',
          <code key="s">{v.scenarioSchemaVersion}</code>,
        ],
        ['Model registry release', <code key="r">{v.registryVersion}</code>],
        ['Registry checksum', <code key="k">{v.registryChecksum}</code>],
        [
          'Catalogue-derived models',
          v.derivedTierEnabled
            ? 'Served alongside the reviewed tier'
            : 'Off — reviewed models only',
        ],
      ]}
    />
  );
}

function ModelsBlock() {
  const models = useMemo(() => mechanicsModels(), []);
  return (
    <>
      <SectionTable
        head={[
          'Analyte',
          'Model',
          'Routes and families',
          'Native matrix',
          'Validation status',
          'Uncertainty bands',
          'Runs from the simulator UI',
        ]}
        rows={models.map((m) => [
          <span key="a">
            <span className="font-medium">{m.analyte}</span>
            {m.aliases.length > 0 && (
              <span className="text-muted-foreground">
                {' '}
                (also resolves as: {m.aliases.join(', ')})
              </span>
            )}
          </span>,
          <code key="m">{m.modelId}</code>,
          <span key="r">
            {m.routes.map((r) => `${r.route} — ${r.family}`).join('; ')}
          </span>,
          <span key="x">
            {m.matrix}
            {m.matrixTransforms.length > 0 && (
              <span className="text-muted-foreground">
                {' '}
                (→{' '}
                {m.matrixTransforms
                  .map((tr) => `${tr.to} ×${tr.ratio}`)
                  .join(', ')}
                )
              </span>
            )}
          </span>,
          m.validationStatus,
          m.bandsCarryUncertainty ? (
            <span key="b">
              {m.carriesParameterDistributions
                ? 'Widen from parameter distributions'
                : 'Widen from declared observation error'}
              {m.observationErrorLayers.length > 0 && (
                <span className="text-muted-foreground">
                  {' '}
                  ({m.observationErrorLayers.join(', ')})
                </span>
              )}
            </span>
          ) : (
            <span key="b" className="text-amber-700 dark:text-amber-400">
              Collapse onto the median — point values only
            </span>
          ),
          m.runsOnWeightOnlySubject ? (
            <span key="ok" className="text-emerald-700 dark:text-emerald-400">
              Yes
            </span>
          ) : (
            <span key="no" className="text-amber-700 dark:text-amber-400">
              No — needs subject{' '}
              {Array.from(
                new Set(m.routes.flatMap((r) => r.requiredCovariates)),
              ).join(', ')}
            </span>
          ),
        ])}
      />
      <p className="text-xs text-muted-foreground">
        &ldquo;Runs from the simulator UI&rdquo; reflects that the forward
        simulator currently supplies body weight only; a model whose volume of
        distribution scales by lean body mass or the Widmark factor refuses the
        run rather than substituting weight scaling (§8).
      </p>
      <p className="text-xs text-muted-foreground">
        A model whose parameters are all point values produces the same curve on
        every Monte Carlo draw, so its reported percentile bands sit exactly on
        the median. Read a curve with no visible band as an uncharacterised
        prediction, not a precise one (§8).
      </p>
    </>
  );
}

function FamiliesBlock() {
  const families = useMemo(() => mechanicsFamilies(), []);
  return (
    <SectionTable
      head={['Model family', 'Evaluated as', 'Used by']}
      rows={families.map((f) => [
        <code key="f">{f.family}</code>,
        f.evaluation === 'ode'
          ? 'Numerically integrated (RK4)'
          : 'Closed form, doses superposed',
        f.usedBy.length > 0 ? (
          f.usedBy.join(', ')
        ) : (
          <span key="n" className="text-muted-foreground">
            no model in this release
          </span>
        ),
      ])}
    />
  );
}

/** Plain-language label for each guardrail, keyed by the id `mechanicsLimits` emits. */
const LIMIT_LABELS: Record<string, string> = {
  defaultDraws: 'Monte Carlo draws per run (default)',
  defaultSeed: 'Random seed (fixed)',
  targetStepHours: 'Output-grid resolution aimed for (hours)',
  minTimeSteps: 'Minimum output-grid points',
  maxTimeSteps: 'Maximum output-grid points',
  maxGridPoints: 'Engine cap on grid points',
  maxDraws: 'Engine cap on draws',
  maxSimCells: 'Engine cap on grid points × doses × draws × analytes',
  maxOdeWork: 'Engine cap on integration work (span/step × draws × doses)',
  maxOdeDoses: 'Engine cap on doses in one integrated run',
  notRobustSurvivingDrawRatio:
    'Surviving-draw fraction below which bands are declared unreliable',
  minSubjectWeightKg: 'Minimum subject weight accepted (kg)',
  peakRefineStepHours: 'Finest peak-refinement resolution (hours)',
  maxPeakRefineSamples: 'Engine cap on peak-refinement sample points',
  maxPeakRefineEvals:
    'Engine cap on peak-refinement evaluations (samples × doses)',
  minPeakRefineScan:
    'Fewest peak-refinement evaluations a run needs (below this the run is refused)',
  lowEssRatio: 'Effective sample size flagged low below (inverse engine)',
  criticalEssRatio:
    'Effective sample size flagged critical below (inverse engine)',
};

function LimitsBlock() {
  const limits = useMemo(() => mechanicsLimits(), []);
  return (
    <SectionTable
      head={[ITEM, VALUE]}
      rows={limits.map((l) => [
        LIMIT_LABELS[l.id] ?? l.id,
        <code key="v">{l.value.toLocaleString('en-US')}</code>,
      ])}
    />
  );
}

function LiveBlock({ id }: { id: string }) {
  switch (id) {
    case 'versions':
      return <VersionsBlock />;
    case 'models':
      return <ModelsBlock />;
    case 'families':
      return <FamiliesBlock />;
    case 'limits':
      return <LimitsBlock />;
    default:
      // An unknown token means the document asked for a block this page does not
      // implement. Render nothing rather than leaking the raw token — the drift test
      // fails on it, which is where it should be caught.
      return null;
  }
}

export function SimulatorMechanicsPage() {
  const { t } = useTranslation();
  const parts = useMemo(() => splitMechanicsDocument(mechanicsMarkdown), []);
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8">
      <Link
        to="/modeling"
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {t('mechanics.backToModeling')}
      </Link>
      {/* The document is maintained in English; say so in the reader's language rather
          than translating half of it. */}
      <p className="mb-4 text-xs text-muted-foreground">
        {t('mechanics.englishNotice')}
      </p>
      <article className="prose prose-sm max-w-none dark:prose-invert">
        {parts.map((part, i) =>
          part.kind === 'live' ? (
            <LiveBlock key={`live-${i}`} id={part.id} />
          ) : (
            <Fragment key={`prose-${i}`}>
              <div
                dangerouslySetInnerHTML={{ __html: renderMarkdown(part.text) }}
              />
            </Fragment>
          ),
        )}
      </article>
    </main>
  );
}
