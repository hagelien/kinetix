import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitCompare, Loader2, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { LazyPosteriorPredictiveChart as PosteriorPredictiveChart } from '@/components/kinelab/LazyPosteriorPredictiveChart';
import {
  mergeVariantIntoBaseline,
  type InferenceInput,
  type ScenarioVariant,
  type VariantPriorOverrides,
} from '@/lib/compute/index';
import type {
  RunScenarioComparisonArgs,
  WorkerScenarioComparisonOutput,
} from '@/workers/inference.worker';

interface Props {
  /** Snapshot of the input that produced the current single-run posterior.
   *  Acts as scenario A. Variants inherit and override. */
  baseline: InferenceInput | null;
  /** Predictive range used for charts so all scenarios share the same x-axis. */
  predictiveRangeHours: { start: number; end: number; steps: number } | null;
  runScenarioComparison: (
    args: RunScenarioComparisonArgs,
  ) => Promise<WorkerScenarioComparisonOutput>;
  /** Surfaced for the chart's observation marker (single observation today). */
  observationsForChart: Array<{ tHours: number; concentration: number }>;
  /** Notifies the page when a comparison run finishes so it can include the
   *  result in the generated report. The page is also responsible for
   *  clearing its lifted copy when the baseline changes (the card itself
   *  remounts via key, which resets internal state). */
  onResultChange?: (output: WorkerScenarioComparisonOutput | null) => void;
}

interface VariantState extends ScenarioVariant {}

const EMPTY_OVERRIDES: VariantPriorOverrides = {};

let nextVariantId = 1;

// `count` is the 1-based ordinal of this variant — the first one (count=1)
// gets suffix "B" because Scenario A is the baseline; the second is "C", and
// so on. Wraps around to a numeric suffix past 25 to avoid AA/AB style
// confusion with a wide-screen comparison.
function suffixFor(count: number): string {
  if (count >= 1 && count <= 25) return String.fromCharCode(65 + count);
  return String(count + 1);
}

export function ScenarioCompareCard({
  baseline,
  predictiveRangeHours,
  runScenarioComparison,
  observationsForChart,
  onResultChange,
}: Props) {
  const { t } = useTranslation();

  const newVariant = useCallback(
    (count: number): VariantState => ({
      id: `variant-${nextVariantId++}`,
      label: t('kinelab.compare.scenarioLabel', { suffix: suffixFor(count) }),
      overrides: { ...EMPTY_OVERRIDES },
    }),
    [t],
  );

  const [variants, setVariants] = useState<VariantState[]>(() => [
    {
      id: `variant-${nextVariantId++}`,
      // Translate at the call site rather than capturing `t` outside the
      // component so a language switch on subsequent variant additions
      // produces strings in the new language. Existing labels are
      // user-editable so they stay in whatever language they were created in.
      label: t('kinelab.compare.scenarioLabel', { suffix: suffixFor(1) }),
      overrides: { ...EMPTY_OVERRIDES },
    },
  ]);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [output, setOutput] = useState<WorkerScenarioComparisonOutput | null>(
    null,
  );
  // Two guards on `handleRun`'s resolution. The card is `key={baselineEpoch}`-
  // remounted on every baseline change, so a comparison still in flight when
  // the user switches analyte / re-runs / loads a case will resolve into a
  // stale closure — the new instance owns the page's `comparisonOutput`
  // state, but the stale closure still holds a reference to the same
  // setter (`onResultChange`) and would clobber it. Two checks close that:
  //   1. `isMountedRef` rejects results that arrive after unmount.
  //   2. `runIdRef` rejects results from any earlier run if the user
  //      double-clicks Run while one is in flight.
  const isMountedRef = useRef(true);
  const runIdRef = useRef(0);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const updateVariant = useCallback(
    (id: string, patch: Partial<VariantState>) => {
      setVariants((prev) =>
        prev.map((v) => (v.id === id ? { ...v, ...patch } : v)),
      );
    },
    [],
  );

  const updateOverride = useCallback(
    (id: string, patch: Partial<VariantPriorOverrides>) => {
      setVariants((prev) =>
        prev.map((v) =>
          v.id === id ? { ...v, overrides: { ...v.overrides, ...patch } } : v,
        ),
      );
    },
    [],
  );

  const addVariant = useCallback(() => {
    setVariants((prev) => [...prev, newVariant(prev.length + 1)]);
  }, [newVariant]);

  const removeVariant = useCallback((id: string) => {
    setVariants((prev) => prev.filter((v) => v.id !== id));
  }, []);

  const handleRun = useCallback(async () => {
    if (!baseline || !predictiveRangeHours || variants.length === 0) return;
    const myRunId = ++runIdRef.current;
    setError(null);
    setIsRunning(true);
    try {
      const scenarios: RunScenarioComparisonArgs['scenarios'] = [
        {
          id: 'scenario-a',
          label: t('kinelab.compare.baselineLabel'),
          args: { input: baseline, predictiveRangeHours },
        },
        ...variants.map((v) => ({
          id: v.id,
          label: v.label.trim() || v.id,
          args: {
            input: mergeVariantIntoBaseline(baseline, v.overrides),
            predictiveRangeHours,
          },
        })),
      ];
      const out = await runScenarioComparison({ scenarios });
      // Reject if a newer run was started OR the card unmounted (baseline
      // change). Without these guards `onResultChange` would write a
      // stale comparison into the page's lifted state and the next
      // generated report would describe the wrong baseline.
      if (myRunId !== runIdRef.current) return;
      if (!isMountedRef.current) return;
      setOutput(out);
      onResultChange?.(out);
    } catch (err) {
      if (myRunId !== runIdRef.current) return;
      if (!isMountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (myRunId === runIdRef.current && isMountedRef.current) {
        setIsRunning(false);
      }
    }
  }, [baseline, predictiveRangeHours, variants, runScenarioComparison, t, onResultChange]);

  if (!baseline || !predictiveRangeHours) {
    // No baseline run yet; the card still renders but in an instructional
    // state so the user knows what to do.
    return (
      <Card>
        <CardContent className="p-4 space-y-2">
          <h2 className="text-sm font-semibold uppercase text-muted-foreground">
            {t('kinelab.compare.heading')}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t('kinelab.compare.runBaselineFirst')}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h2 className="text-sm font-semibold uppercase text-muted-foreground">
            {t('kinelab.compare.heading')}
          </h2>
          <Button onClick={handleRun} disabled={isRunning} size="sm">
            {isRunning ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <GitCompare className="h-4 w-4 mr-1" />
            )}
            {t('kinelab.compare.run')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('kinelab.compare.description')}
        </p>

        <ul className="space-y-3">
          {variants.map((v) => (
            <li
              key={v.id}
              className="rounded-lg border border-border/40 p-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2">
                <Input
                  value={v.label}
                  onChange={(e) => updateVariant(v.id, { label: e.target.value })}
                  className="max-w-xs"
                  aria-label={t('kinelab.compare.variantLabel')}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeVariant(v.id)}
                  aria-label={t('kinelab.compare.remove')}
                  title={t('kinelab.compare.remove')}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
                <Field label={t('kinelab.compare.doseLow')}>
                  <Input
                    value={v.overrides.doseLowMg ?? ''}
                    onChange={(e) =>
                      updateOverride(v.id, { doseLowMg: e.target.value })
                    }
                    placeholder={String(getBaselineDoseLow(baseline) ?? '')}
                  />
                </Field>
                <Field label={t('kinelab.compare.doseHigh')}>
                  <Input
                    value={v.overrides.doseHighMg ?? ''}
                    onChange={(e) =>
                      updateOverride(v.id, { doseHighMg: e.target.value })
                    }
                    placeholder={String(getBaselineDoseHigh(baseline) ?? '')}
                  />
                </Field>
                {baseline.priors.eliminationRate ? (
                  <Field label={t('kinelab.compare.eliminationRate')}>
                    <Input
                      value={v.overrides.eliminationRateMgPerLPerHour ?? ''}
                      onChange={(e) =>
                        updateOverride(v.id, {
                          eliminationRateMgPerLPerHour: e.target.value,
                        })
                      }
                      placeholder={String(
                        getFixedValue(baseline.priors.eliminationRate) ?? '',
                      )}
                    />
                  </Field>
                ) : (
                  <Field label={t('kinelab.compare.halfLife')}>
                    <Input
                      value={v.overrides.halfLifeHours ?? ''}
                      onChange={(e) =>
                        updateOverride(v.id, { halfLifeHours: e.target.value })
                      }
                      placeholder={String(
                        baseline.priors.halfLife
                          ? (getFixedValue(baseline.priors.halfLife) ?? '')
                          : '',
                      )}
                    />
                  </Field>
                )}
                <Field label={t('kinelab.compare.vd')}>
                  <Input
                    value={v.overrides.vdLitres ?? ''}
                    onChange={(e) =>
                      updateOverride(v.id, { vdLitres: e.target.value })
                    }
                    placeholder={String(getFixedValue(baseline.priors.vd) ?? '')}
                  />
                </Field>
                {!baseline.priors.eliminationRate && (
                  <Field label={t('kinelab.compare.f')}>
                    <Input
                      value={v.overrides.bioavailability ?? ''}
                      onChange={(e) =>
                        updateOverride(v.id, { bioavailability: e.target.value })
                      }
                      placeholder={String(
                        baseline.priors.f != null
                          ? getFixedValue(baseline.priors.f)
                          : '',
                      )}
                    />
                  </Field>
                )}
                <Field label={t('kinelab.compare.assayCV')}>
                  <Input
                    value={v.overrides.assayCV ?? ''}
                    onChange={(e) =>
                      updateOverride(v.id, { assayCV: e.target.value })
                    }
                    placeholder={String(baseline.defaultAssayCV)}
                  />
                </Field>
              </div>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={addVariant}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            {t('kinelab.compare.addVariant')}
          </Button>
        </div>

        {error && (
          <p className="text-sm text-destructive border border-destructive/40 rounded-md p-2">
            {error}
          </p>
        )}

        {output && (
          <ScenarioCompareResult
            output={output}
            observationsForChart={observationsForChart}
          />
        )}
      </CardContent>
    </Card>
  );
}

function ScenarioCompareResult({
  output,
  observationsForChart,
}: {
  output: WorkerScenarioComparisonOutput;
  observationsForChart: Array<{ tHours: number; concentration: number }>;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <table className="w-full text-sm">
        <thead className="text-xs uppercase text-muted-foreground">
          <tr>
            <th className="text-left py-1">{t('kinelab.compare.colLabel')}</th>
            <th className="text-right py-1">{t('kinelab.compare.colDoseMedian')}</th>
            <th className="text-right py-1">{t('kinelab.compare.colDoseInterval')}</th>
            <th className="text-right py-1">{t('kinelab.compare.colSampleCount')}</th>
            <th className="text-right py-1">{t('kinelab.compare.colEss')}</th>
          </tr>
        </thead>
        <tbody>
          {output.scenarios.map((s) => {
            const dose = s.output.posterior.intervals.dose;
            return (
              <tr key={s.id} className="border-t border-border/40">
                <td className="py-1 font-medium">{s.label}</td>
                <td className="py-1 text-right tabular-nums">
                  {dose ? formatNumber(dose.median) : '—'}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {dose
                    ? `${formatNumber(dose.p05)} – ${formatNumber(dose.p95)}`
                    : '—'}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {s.output.diagnostics.sampleCount}
                </td>
                <td className="py-1 text-right tabular-nums">
                  {s.output.diagnostics.effectiveSampleSize.toFixed(1)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="space-y-3">
        {output.scenarios.map((s) => (
          <div key={s.id} className="space-y-1">
            <h3 className="text-xs font-medium text-muted-foreground">
              {s.label}
            </h3>
            <PosteriorPredictiveChart
              points={s.output.predictive}
              observations={observationsForChart}
              ariaLabel={`${t('kinelab.chart.ariaLabel')} — ${s.label}`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function getBaselineDoseLow(input: InferenceInput): number | undefined {
  if (input.priors.dose.type === 'uniform') return input.priors.dose.min;
  if (input.priors.dose.type === 'fixed') return input.priors.dose.value;
  return undefined;
}

function getBaselineDoseHigh(input: InferenceInput): number | undefined {
  if (input.priors.dose.type === 'uniform') return input.priors.dose.max;
  if (input.priors.dose.type === 'fixed') return input.priors.dose.value;
  return undefined;
}

function getFixedValue(spec: { type: string; value?: number }): number | undefined {
  return spec.type === 'fixed' ? spec.value : undefined;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) < 0.01 && value !== 0) return value.toExponential(2);
  if (Math.abs(value) < 1) return value.toFixed(3);
  if (Math.abs(value) < 100) return value.toFixed(2);
  return Math.round(value).toLocaleString();
}
