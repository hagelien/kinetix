import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { BookOpen, Download, Loader2, Play, Settings2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
  LazySimulatorGraph,
  type LegalLimit,
  type ReferenceRange,
  type SimulatorForensicOverlay,
  type SimulatorPmOverlay,
  type SimulatorTimeAxis,
} from '@/components/simulator/LazySimulatorGraph';
import { AnswerCard } from '@/components/simulator/AnswerCard';
import { ResultsSummary } from '@/components/simulator/ResultsSummary';
import { AssumptionPanel } from '@/components/simulator/AssumptionPanel';
import { ModelGradeNotice } from '@/components/modeling/ModelGradeNotice';
import { admittedResults, type ResultGrade } from '@/lib/reviewedModelGrade';
import { hasUncertaintyBand } from '@/lib/modelingAnswer';
import type { ChartMatrix } from '@/lib/matrixDisplay';
import type { CaseDisplaySettings, DrugSimResult } from '@/types/simulator';

export interface SimulatorRunStateMetadata {
  isRunning: boolean;
  canRun: boolean;
  hasResults: boolean;
  /** Human-readable reason the run is blocked, shown when canRun is false. */
  disabledReason?: string;
}

export interface SimulatorAssumptionContextEntry {
  id: string;
  label: string;
  value: string;
}

interface SimulatorModelingResultsProps {
  results: Record<string, DrugSimResult>;
  drugLabels: Record<string, string>;
  drugColors: Record<string, string>;
  drugMolecularWeights: Record<string, number | null>;
  /** Internal `drugs.id` per result id — for loading parameter references. */
  drugDbIds?: Record<string, number | null>;
  /** Blood:plasma ratio per result id, disclosed when a curve is converted. */
  bloodPlasmaRatios?: Record<string, number | null>;
  /**
   * Evidence grade + rendering disposition per result id. Amendment 1 (§5.2)
   * makes the itemised disclosure a CONDITION of showing a grade-C curve, so
   * this rides alongside the chart rather than being tucked into a details pane.
   */
  resultGrades?: Record<string, ResultGrade | null>;
  visibleDrugs: Set<string>;
  /**
   * Every drug on screen with a result, whatever the gate decided. The evidence
   * disclosure is keyed to THIS, not to `visibleDrugs`: a withheld model must still
   * say why it was withheld.
   */
  disclosedDrugs: Set<string>;
  /** Record this viewer's §5.1 acknowledgement for the model behind one result. */
  onAcknowledgeModel: (configId: string) => void;
  /** Withdraw it again. */
  onWithdrawModelAcknowledgement: (configId: string) => void;
  /** Config ids whose model this viewer has acknowledged, mapped to when they did. */
  acknowledgedDrugs: Map<string, string>;
  displaySettings: CaseDisplaySettings;
  referenceRanges: Record<string, ReferenceRange>;
  legalLimits?: LegalLimit[];
  /** Postmortem distribution overlay, built by the page. */
  pmOverlay?: SimulatorPmOverlay;
  /** Forensic postmortem overlay (the three toxbase "Døde" categories). */
  forensicOverlay?: SimulatorForensicOverlay;
  /** Component ids whose result is out of date — dimmed in the chart + badged. */
  staleIds?: Set<string>;
  onToggleMode: () => void;
  /** Toggle a drug's visibility (curve + helper lines) from a legend click. */
  onSeriesToggle?: (seriesId: string) => void;
  /** Matrix the chart is displayed in. */
  displayMatrix?: ChartMatrix;
  /** Change the chart's display matrix. */
  onDisplayMatrixChange?: (matrix: ChartMatrix) => void;
  /** Per-series curve multiplier for the display matrix (chart only). */
  matrixFactors?: Record<string, number>;
  /** True when at least one visible curve actually converted to the matrix. */
  matrixConverted?: boolean;
  /** Visible drugs shown in whole blood because their curve could not convert. */
  matrixConversionUnavailableFor?: string[];
  onRunAll: () => void | Promise<void>;
  onExport: () => void;
  onToggleSettings: () => void;
  runState: SimulatorRunStateMetadata;
  timeline?: ReactNode;
  /** Shared window that syncs the chart's x-axis with the event timeline. */
  timeAxis?: SimulatorTimeAxis;
}

export function SimulatorModelingResults({
  results,
  drugLabels,
  drugColors,
  drugMolecularWeights,
  drugDbIds,
  bloodPlasmaRatios,
  resultGrades,
  visibleDrugs,
  disclosedDrugs,
  onAcknowledgeModel,
  onWithdrawModelAcknowledgement,
  acknowledgedDrugs,
  displaySettings,
  referenceRanges,
  legalLimits,
  pmOverlay,
  forensicOverlay,
  staleIds,
  onToggleMode,
  onSeriesToggle,
  displayMatrix,
  onDisplayMatrixChange,
  matrixFactors,
  matrixConverted,
  matrixConversionUnavailableFor,
  onRunAll,
  onExport,
  onToggleSettings,
  runState,
  timeline,
  timeAxis,
}: SimulatorModelingResultsProps) {
  const { t } = useTranslation();

  // Every on-screen result that resolved to a registry model, with its grade —
  // including the ones the gate withheld. A result without a grade (ethanol/Widmark,
  // KineLab, an older saved case) is not governed by this policy and shows nothing
  // rather than a manufactured grade.
  //
  // Keyed to `disclosedDrugs` rather than `visibleDrugs` on purpose. The policy's own
  // words are that "hidden still shows the reason and the evidence record"; filtering
  // this list by the gate's verdict made a withheld model vanish without one.
  const gradedEntries = Object.entries(resultGrades ?? {}).flatMap(
    ([id, grade]) => (grade && disclosedDrugs.has(id) ? [[id, grade] as const] : []),
  );

  // The numeric surfaces below the chart obey the same gate the chart does. The
  // answer card reads medians and intervals straight off a result, so handing it the
  // unfiltered set would publish the exact numbers the disposition withheld — the
  // curve would be hidden and its Cmax printed underneath it.
  const admitted = admittedResults(results, resultGrades);

  return (
    <div className="space-y-4">
      {/* The graph takes the full set and filters on `visibleDrugs` internally
          (series, bands, threshold lines and labels all key off it), so it is the
          one consumer here that must not be pre-filtered. */}
      <LazySimulatorGraph
        results={results}
        drugLabels={drugLabels}
        drugColors={drugColors}
        visibleDrugs={visibleDrugs}
        displaySettings={displaySettings}
        referenceRanges={referenceRanges}
        legalLimits={legalLimits}
        pmOverlay={pmOverlay}
        forensicOverlay={forensicOverlay}
        staleIds={staleIds}
        timeAxis={timeAxis}
        timeline={timeline}
        onToggleMode={onToggleMode}
        onSeriesToggle={onSeriesToggle}
        displayMatrix={displayMatrix}
        onDisplayMatrixChange={onDisplayMatrixChange}
        matrixFactors={matrixFactors}
        matrixConverted={matrixConverted}
        matrixConversionUnavailableFor={matrixConversionUnavailableFor}
      />

      {/* Amendment 1 condition 2: the itemised evidence disclosure sits AT the
          curve, not behind a disclosure toggle. Condition 4 (exports carrying
          the same disclosure) is enforced separately, in the export path. */}
      {gradedEntries.length > 0 && (
        <div className="space-y-2 rounded-md border border-mode-accent/25 px-2.5 py-2">
          {gradedEntries.map(([id, grade]) => (
            <ModelGradeNotice
              key={id}
              policy={grade.policy}
              disposition={grade.disposition}
              drugLabel={
                gradedEntries.length > 1 ? (drugLabels[id] ?? id) : undefined
              }
              onAcknowledge={() => onAcknowledgeModel(id)}
              acknowledged={acknowledgedDrugs.has(id)}
              acknowledgedAt={acknowledgedDrugs.get(id)}
              onWithdraw={() => onWithdrawModelAcknowledgement(id)}
              hasBand={
                results[id] != null && hasUncertaintyBand(results[id]!)
              }
              simplifications={grade.structureSimplifications}
              cautiousDefaults={grade.cautiousDefaults}
            />
          ))}
        </div>
      )}

      {runState.hasResults && (
        <AnswerCard
          results={admitted}
          drugLabels={drugLabels}
          drugColors={drugColors}
          drugMolecularWeights={drugMolecularWeights}
          staleIds={staleIds}
        />
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <Button
          onClick={onRunAll}
          disabled={!runState.canRun}
          size="sm"
          title={
            !runState.canRun && !runState.isRunning
              ? runState.disabledReason
              : undefined
          }
          className="bg-mode-accent text-white ring-1 ring-mode-accent/25 hover:bg-mode-accent/90"
        >
          {runState.isRunning ? (
            <>
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              {t('modeling.workspace.simulator.running')}
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5 mr-1.5" />
              {t('modeling.workspace.simulator.runSimulation')}
            </>
          )}
        </Button>

        {!runState.canRun &&
          !runState.isRunning &&
          runState.disabledReason && (
            <span className="text-xs text-muted-foreground">
              {runState.disabledReason}
            </span>
          )}

        {runState.hasResults && (
          <Button variant="outline" size="sm" onClick={onExport}>
            <Download className="h-3.5 w-3.5 mr-1.5" />
            {t('modeling.workspace.simulator.export')}
          </Button>
        )}

        <div className="flex-1" />

        {/* Always present, results or not: someone deciding whether to trust this
            workspace has to be able to read its premises before running anything. */}
        <Button
          variant="ghost"
          size="sm"
          asChild
          className="text-muted-foreground"
        >
          <Link to="/modeling/how-it-works" title={t('mechanics.linkTitle')}>
            <BookOpen className="h-3.5 w-3.5 mr-1.5" />
            {t('mechanics.linkLabel')}
          </Link>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleSettings}
          className="text-muted-foreground"
        >
          <Settings2 className="h-3.5 w-3.5 mr-1.5" />
          {t('modeling.workspace.simulator.settings')}
        </Button>
      </div>

      {runState.hasResults && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <ResultsSummary
            results={admitted}
            drugLabels={drugLabels}
            drugColors={drugColors}
            staleIds={staleIds}
          />
          <AssumptionPanel
            results={admitted}
            drugLabels={drugLabels}
            drugDbIds={drugDbIds}
            displayMatrix={displaySettings.displayMatrix}
            bloodPlasmaRatios={bloodPlasmaRatios}
          />
        </div>
      )}
    </div>
  );
}
