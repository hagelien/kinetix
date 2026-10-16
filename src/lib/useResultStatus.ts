import { useMemo } from 'react';
import type { ChartMatrix } from '@/lib/matrixDisplay';
import { isResultModelSuperseded, isResultStale } from '@/lib/resultStaleness';
import { gradeResult, type ResultGrade } from '@/lib/reviewedModelGrade';
import { useLiveDerivedModelsVersion } from '@/lib/useLiveDerivedModel';
import {
  hasAcknowledgement,
  type ModelAcknowledgement,
} from '@/stores/modelAcknowledgementStore';
import type { DrugSimConfig, DrugSimResult } from '@/types/simulator';

/**
 * Evidence grade + rendering disposition per result, for this viewer and this display matrix (the
 * matrix bridge is a property of the VIEW, so the grade is recomputed when the user changes matrix
 * rather than cached with the run).
 *
 * Also recomputed whenever a live derived model changes what the registry resolves (#299): a panel
 * left open refreshes its drug's live model every minute, and a curve computed on the superseded
 * build must be regraded — its versioned model id no longer resolves, so `gradeResult` withholds it
 * — rather than keep the grade of a model that is no longer the one a run would use.
 */
export function useResultGrades(
  drugs: readonly DrugSimConfig[],
  results: Record<string, DrugSimResult>,
  options: {
    role: string | null;
    displayMatrix: ChartMatrix;
    acknowledgements: Record<string, ModelAcknowledgement>;
    userId: number | null;
  },
): Record<string, ResultGrade | null> {
  const liveModelsVersion = useLiveDerivedModelsVersion();
  const { role, displayMatrix, acknowledgements, userId } = options;
  return useMemo(() => {
    const out: Record<string, ResultGrade | null> = {};
    for (const d of drugs) {
      const modelId = results[d.id]?.assumptions.modelId;
      out[d.id] = gradeResult(results[d.id], {
        role,
        displayMatrix,
        isAcknowledged: (version) =>
          modelId !== undefined &&
          hasAcknowledgement(acknowledgements, modelId, version, userId),
      });
    }
    return out;
  }, [drugs, results, role, displayMatrix, acknowledgements, userId, liveModelsVersion]);
}

/**
 * Results that no longer describe what a run would compute now: their component's inputs changed
 * since they were computed, or the derived model they ran on has since been replaced by a live
 * refresh (#299). The chart dims these curves and the summary badges them "out of date" until
 * re-run.
 */
export function useStaleResultIds(
  drugs: readonly DrugSimConfig[],
  results: Record<string, DrugSimResult>,
): Set<string> {
  const liveModelsVersion = useLiveDerivedModelsVersion();
  return useMemo(
    () =>
      new Set(
        drugs
          .filter((d) => isResultStale(d, results[d.id]) || isResultModelSuperseded(results[d.id]))
          .map((d) => d.id),
      ),
    [drugs, results, liveModelsVersion],
  );
}
