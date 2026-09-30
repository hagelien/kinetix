import { useEffect, useRef, useState } from 'react';
import { ENGINE_LIMITS } from '@/lib/kinetics-core';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConcentrationField, DoseField, TimeField, Field } from './eventFields';
import { useSimulatorStore } from '@/stores/simulatorStore';
import { useAppStore } from '@/stores/appStore';
import { defaultConcentrationUnit } from '@/lib/unitConversion';
import { deriveQuestion } from '@/lib/eventDerivation';
import {
  getComponentEngine,
  getRunBlockReasonKey,
  isComponentRunnable,
} from '@/lib/modelingRun';
import { isEthanolDrugId } from '@/lib/ethanolSimulator';
import { DEFAULT_WORKBOOK_INPUT } from '@/lib/etohScenario';
import { useDrugName } from '@/lib/useDrugName';
import { WorkbookBackcalcPanel } from '@/components/simulator/WorkbookBackcalcPanel';
import { WorkbookForwardPanel } from '@/components/simulator/WorkbookForwardPanel';
import type { DrugComponent } from '@/types';
import type { EtohParityInput } from '@/lib/etohWorkbookFlows';
import type {
  ComponentEngine,
  DrugSimConfig,
  KinelabComponentParams,
  RouteType,
  DistributionSpec,
  TimeFormat,
  SimEvent,
  DoseEvent,
  MeasurementEvent,
  QueryEvent,
} from '@/types/simulator';
import { X, Copy, ChevronDown, ChevronUp, Eye, EyeOff } from 'lucide-react';

const ROUTES: { value: RouteType; label: string }[] = [
  { value: 'iv', label: 'IV' },
  { value: 'oral', label: 'Oral' },
  { value: 'insufflation', label: 'IN' },
  { value: 'inhalation', label: 'Inh' },
  { value: 'other', label: 'Other' },
];

const MATRIX_OPTIONS = [
  'whole_blood',
  'serum',
  'plasma',
  'femoral_blood',
  'cardiac_blood',
  'urine',
  'vitreous',
  'other',
] as const;

const STATUS_KEY: Record<string, string> = {
  'later-from-earlier': 'simulator.events.statusLaterFromEarlier',
  'earlier-from-later': 'simulator.events.statusEarlierFromLater',
  'concentration-from-dose': 'simulator.events.statusConcentrationFromDose',
  'dose-from-concentration': 'simulator.events.statusDoseFromConcentration',
};

const ENGINE_OPTIONS: { value: ComponentEngine; labelKey: string }[] = [
  { value: 'pk-montecarlo', labelKey: 'simulator.engine.pkMonteCarlo' },
  { value: 'ethanol-widmark', labelKey: 'simulator.engine.ethanolWidmark' },
  { value: 'kinelab-bayes', labelKey: 'simulator.engine.kinelabBayes' },
];

const DEFAULT_ETHANOL_PARAMS = {
  weightKg: 70,
  biologicalSex: 'male' as const,
  eliminationRateGdlPerHour: 0.015,
};

const DEFAULT_KINELAB_PARAMS = {
  assayCV: 0.15,
  drawCount: 2000,
};

function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  );
}

function formatDist(dist: DistributionSpec | undefined): string {
  if (!dist) return '—';
  switch (dist.type) {
    case 'fixed':
      return String(dist.value);
    case 'uniform':
      return `${dist.min}–${dist.max}`;
    case 'triangular':
      return `${dist.min}–${dist.max} (mode: ${dist.mode})`;
    case 'lognormal':
      return `LN(${dist.mu}, ${dist.sigma})`;
  }
}

interface DrugPanelProps {
  config: DrugSimConfig;
  drugComponent: DrugComponent | undefined;
  resolvedDistributions?: {
    halfLife: DistributionSpec;
    vd: DistributionSpec;
    f: DistributionSpec;
  };
  timeFormat: TimeFormat;
  referenceTime: string;
  /** Composite `configId:eventId` of the marker selected from the timeline. */
  selectedMarkerId?: string | null;
}

export function DrugPanel({
  config,
  drugComponent,
  resolvedDistributions,
  timeFormat,
  referenceTime,
  selectedMarkerId,
}: DrugPanelProps) {
  const { t } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const updateDrugConfig = useSimulatorStore((s) => s.updateDrugConfig);
  const removeDrug = useSimulatorStore((s) => s.removeDrug);
  const duplicateDrug = useSimulatorStore((s) => s.duplicateDrug);
  const addEvent = useSimulatorStore((s) => s.addEvent);
  const updateEvent = useSimulatorStore((s) => s.updateEvent);
  const removeEvent = useSimulatorStore((s) => s.removeEvent);
  const enabledUnits = useAppStore((s) => s.enabledUnits);

  const { displayName: localizedName } = useDrugName(drugComponent ?? null);

  const derived = deriveQuestion(config);
  const hasDose = config.events.some((e) => e.type === 'dose');
  const hasMeasurement = config.events.some((e) => e.type === 'measurement');
  const canUseEthanolEngine = isEthanolDrugId(config.drugId);
  const engineOptions = canUseEthanolEngine
    ? ENGINE_OPTIONS
    : ENGINE_OPTIONS.filter((option) => option.value !== 'ethanol-widmark');
  const engine = getComponentEngine(config);
  const isEthanolEngine = engine === 'ethanol-widmark';
  const isKinelabEngine = engine === 'kinelab-bayes';
  const ethanolParams = config.ethanol ?? {};
  const ethanolWorkbook = ethanolParams.workbook ?? DEFAULT_WORKBOOK_INPUT;
  const kinelabParams = config.kinelab ?? {};
  const sortedEvents = [...config.events].sort(
    (a, b) =>
      (a.t ?? Number.POSITIVE_INFINITY) - (b.t ?? Number.POSITIVE_INFINITY),
  );

  const handleAddDose = () => {
    const event: DoseEvent = {
      id: newId(),
      type: 'dose',
      t: 0,
      unit: isEthanolEngine ? 'g' : 'mg',
      route: isEthanolEngine ? 'oral' : (config.route ?? 'oral'),
      ...(isKinelabEngine
        ? {
            amountRange: { min: 50, max: 500 },
            tRange: [0, 1] as [number, number],
          }
        : {}),
    };
    addEvent(config.id, event);
  };

  const handleEngineChange = (nextEngine: ComponentEngine) => {
    updateDrugConfig(config.id, {
      engine: nextEngine,
      ...(nextEngine === 'ethanol-widmark' && !config.ethanol
        ? {
            ethanol: {
              ...DEFAULT_ETHANOL_PARAMS,
              weightKg: config.weight ?? DEFAULT_ETHANOL_PARAMS.weightKg,
            },
          }
        : {}),
      ...(nextEngine === 'kinelab-bayes' && !config.kinelab
        ? { kinelab: { ...DEFAULT_KINELAB_PARAMS } }
        : {}),
    });
  };

  const updateEthanolParams = (
    updates: Partial<NonNullable<DrugSimConfig['ethanol']>>,
  ) => {
    updateDrugConfig(config.id, {
      ethanol: {
        ...ethanolParams,
        ...updates,
      },
    });
  };

  const updateEthanolWorkbook = (updates: Partial<EtohParityInput>) => {
    updateEthanolParams({
      workbook: {
        ...ethanolWorkbook,
        ...updates,
      },
    });
  };

  const updateEthanolWorkbookDrink = (
    idx: number,
    field: 'ml' | 'abv',
    value: number,
  ) => {
    if (idx < 0 || idx > 5) return;
    const key = field === 'ml' ? 'drinksMl' : 'drinksAbvPercent';
    const next = [...ethanolWorkbook[key]] as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    next[idx] = value;
    updateEthanolWorkbook({ [key]: next });
  };

  const updateKinelabParams = (
    updates: Partial<NonNullable<DrugSimConfig['kinelab']>>,
  ) => {
    updateDrugConfig(config.id, {
      kinelab: {
        ...kinelabParams,
        ...updates,
      },
    });
  };

  const updateKinelabSubject = (
    updates: Partial<NonNullable<DrugSimConfig['kinelab']>['subject']>,
  ) => {
    updateKinelabParams({
      subject: {
        ...(kinelabParams.subject ?? {}),
        ...updates,
      },
    });
  };

  const handleAddConcentration = () => {
    const event: MeasurementEvent = {
      id: newId(),
      type: 'measurement',
      t: 0,
      unit: defaultConcentrationUnit(
        enabledUnits,
        drugComponent?.molecularWeight,
      ),
    };
    addEvent(config.id, event);
  };

  const handleAddQuery = () => {
    // Default to predicting a concentration; the user can switch a query to
    // solve for dose instead via the per-event toggle.
    const event: QueryEvent = {
      id: newId(),
      type: 'query',
      t: 1,
      solveFor: 'concentration',
    };
    addEvent(config.id, event);
  };

  const runnable = isComponentRunnable(config);
  // When the component cannot run, `getRunBlockReasonKey` is the single source
  // of the reason — the same text the disabled Run button explains itself with,
  // so the panel and the button can never name different gaps.
  const statusKey =
    (runnable
      ? STATUS_KEY[
          isEthanolEngine
            ? 'concentration-from-dose'
            : isKinelabEngine
              ? 'dose-from-concentration'
              : derived.questionMode
        ]
      : getRunBlockReasonKey(config)) ?? 'simulator.events.statusIncomplete';

  return (
    <Card
      className="border-l-4"
      style={{ borderLeftColor: config.display.color ?? '#2563eb' }}
    >
      <CardContent className="p-3 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">{config.label}</span>
            {localizedName && localizedName !== config.drugName && (
              <span className="text-xs text-muted-foreground">
                ({localizedName})
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() =>
                updateDrugConfig(config.id, {
                  display: {
                    ...config.display,
                    visible: !config.display.visible,
                  },
                })
              }
              title={
                config.display.visible
                  ? t('simulator.hideOnGraph')
                  : t('simulator.showOnGraph')
              }
            >
              {config.display.visible ? (
                <Eye className="h-3.5 w-3.5" />
              ) : (
                <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => duplicateDrug(config.id)}
              title={t('simulator.duplicate')}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-destructive"
              onClick={() => removeDrug(config.id)}
              title={t('simulator.removeDrug')}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/30 p-2">
          <label className="text-xs font-medium text-muted-foreground">
            {t('simulator.engine.label')}
          </label>
          <select
            aria-label={t('simulator.engine.label')}
            value={engine}
            onChange={(e) =>
              handleEngineChange(e.target.value as ComponentEngine)
            }
            className="h-8 rounded border bg-card px-2 text-xs"
          >
            {engineOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
        </div>

        {isEthanolEngine && (
          <div className="space-y-2 rounded-md border border-amber-200/70 bg-amber-50/50 p-2 dark:border-amber-900/50 dark:bg-amber-950/20">
            <div className="text-xs font-medium text-foreground">
              {t('simulator.engine.ethanolParams')}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field
                label={t('simulator.engine.weightKg')}
                placeholder="70"
                value={ethanolParams.weightKg}
                onChange={(v) => updateEthanolParams({ weightKg: v })}
                unit="kg"
              />
              <Field
                label={t('simulator.engine.eliminationRate')}
                placeholder="0.015"
                value={ethanolParams.eliminationRateGdlPerHour}
                onChange={(v) =>
                  updateEthanolParams({ eliminationRateGdlPerHour: v })
                }
                unit="g/dL/h"
              />
              <Field
                label={t('simulator.engine.widmarkR')}
                placeholder={t('simulator.engine.auto')}
                value={ethanolParams.distributionRatioOverride}
                onChange={(v) =>
                  updateEthanolParams({ distributionRatioOverride: v })
                }
              />
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('simulator.engine.biologicalSex')}
                </span>
                <div className="flex gap-1">
                  {(['male', 'female'] as const).map((sex) => (
                    <Button
                      key={sex}
                      variant={
                        (ethanolParams.biologicalSex ??
                          DEFAULT_ETHANOL_PARAMS.biologicalSex) === sex
                          ? 'default'
                          : 'outline'
                      }
                      size="sm"
                      className="h-8 flex-1 px-2 text-xs"
                      onClick={() =>
                        updateEthanolParams({ biologicalSex: sex })
                      }
                    >
                      {t(`simulator.engine.${sex}`)}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
            <details
              open
              className="space-y-2 rounded-md border border-amber-200/70 bg-card/80 p-2 dark:border-amber-900/50"
            >
              <summary className="cursor-pointer text-xs font-medium text-foreground">
                {t('simulator.engine.ethanolWorkbookTools')}
              </summary>
              <div className="mt-2 space-y-2">
                <WorkbookBackcalcPanel
                  inputs={ethanolWorkbook}
                  onChange={updateEthanolWorkbook}
                  onChangeDrink={updateEthanolWorkbookDrink}
                />
                <WorkbookForwardPanel inputs={ethanolWorkbook} />
              </div>
            </details>
          </div>
        )}

        {isKinelabEngine && (
          <div className="space-y-2 rounded-md border border-sky-200/70 bg-sky-50/50 p-2 dark:border-sky-900/50 dark:bg-sky-950/20">
            <div className="text-xs font-medium text-foreground">
              {t('simulator.engine.kinelabParams')}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field
                label={t('simulator.engine.assayCV')}
                placeholder="0.15"
                value={kinelabParams.assayCV}
                onChange={(v) => updateKinelabParams({ assayCV: v })}
              />
              <Field
                label={t('simulator.engine.drawCount')}
                placeholder="2000"
                value={kinelabParams.drawCount}
                onChange={(v) => updateKinelabParams({ drawCount: v })}
              />
              <div className="col-span-2 flex flex-col gap-1">
                <label className="text-xs font-medium text-muted-foreground">
                  {t('simulator.engine.matrix')}
                </label>
                <select
                  className="h-8 rounded border border-border bg-background px-2 text-xs"
                  value={kinelabParams.matrix ?? 'whole_blood'}
                  onChange={(e) =>
                    updateKinelabParams({
                      matrix: e.target.value as KinelabComponentParams['matrix'],
                    })
                  }
                >
                  {MATRIX_OPTIONS.map((mx) => (
                    <option key={mx} value={mx}>
                      {t(`simulator.engine.matrixOption.${mx}`)}
                    </option>
                  ))}
                </select>
              </div>
              <Field
                label={t('simulator.engine.weightKg')}
                placeholder="70"
                value={kinelabParams.subject?.weightKg ?? config.weight}
                onChange={(v) => updateKinelabSubject({ weightKg: v })}
                unit="kg"
              />
              <Field
                label={t('simulator.engine.ageYears')}
                placeholder={t('simulator.engine.auto')}
                value={kinelabParams.subject?.ageYears}
                onChange={(v) => updateKinelabSubject({ ageYears: v })}
              />
              <div className="col-span-2 flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  {t('simulator.engine.biologicalSex')}
                </span>
                <div className="flex gap-1">
                  {(['male', 'female', 'unknown'] as const).map((sex) => (
                    <Button
                      key={sex}
                      variant={
                        (kinelabParams.subject?.sex ?? 'unknown') === sex
                          ? 'default'
                          : 'outline'
                      }
                      size="sm"
                      className="h-8 flex-1 px-2 text-xs"
                      onClick={() => updateKinelabSubject({ sex })}
                    >
                      {t(`simulator.engine.${sex}`)}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Event list */}
        {sortedEvents.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t('simulator.events.empty')}
          </p>
        ) : (
          <div className="space-y-2">
            {sortedEvents.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                molecularWeight={drugComponent?.molecularWeight}
                timeFormat={timeFormat}
                referenceTime={referenceTime}
                isEthanolEngine={isEthanolEngine}
                isKinelabEngine={isKinelabEngine}
                selected={selectedMarkerId === `${config.id}:${event.id}`}
                onChange={(updates) =>
                  updateEvent(config.id, event.id, updates)
                }
                onRemove={() => removeEvent(config.id, event.id)}
              />
            ))}
          </div>
        )}

        {/* Add buttons (progressive disclosure) */}
        <div className="flex flex-wrap gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={handleAddDose}
          >
            {t('simulator.events.addDose')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={handleAddConcentration}
          >
            {t('simulator.events.addConcentration')}
          </Button>
          {(hasDose || hasMeasurement) && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              onClick={handleAddQuery}
            >
              {t('simulator.events.addQuery')}
            </Button>
          )}
        </div>

        {/* Derived status */}
        <p className="text-xs text-muted-foreground italic">{t(statusKey)}</p>

        {/* Advanced / expert toggle */}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs w-full"
          onClick={() => setAdvancedOpen(!advancedOpen)}
        >
          {t('simulator.events.advanced')}
          {advancedOpen ? (
            <ChevronUp className="h-3 w-3 ml-1" />
          ) : (
            <ChevronDown className="h-3 w-3 ml-1" />
          )}
        </Button>

        {advancedOpen && (
          <div className="space-y-3 text-xs border-t pt-2">
            <Field
              label={t('simulator.events.patientWeight')}
              placeholder="kg"
              value={config.weight}
              onChange={(v) => updateDrugConfig(config.id, { weight: v })}
              unit="kg"
            />
            {!isEthanolEngine && !isKinelabEngine && (
              <>
                <Field
                  label={t('simulator.events.absorptionKa')}
                  placeholder={t('simulator.events.absorptionKaPlaceholder')}
                  value={config.overrides.ka}
                  onChange={(v) =>
                    updateDrugConfig(config.id, {
                      overrides: { ...config.overrides, ka: v },
                    })
                  }
                  unit={t('simulator.events.perHour')}
                />
                <Field
                  label={t('simulator.events.halfLife')}
                  placeholder={
                    resolvedDistributions
                      ? formatDist(resolvedDistributions.halfLife)
                      : ''
                  }
                  value={
                    config.overrides.halfLife?.type === 'fixed'
                      ? config.overrides.halfLife.value
                      : undefined
                  }
                  onChange={(v) =>
                    updateDrugConfig(config.id, {
                      overrides: {
                        ...config.overrides,
                        halfLife: v === undefined ? undefined : { type: 'fixed', value: v },
                      },
                    })
                  }
                  unit={t('simulator.events.hoursUnit')}
                />
                <Field
                  label={t('simulator.events.volumeOfDistribution')}
                  placeholder={
                    resolvedDistributions
                      ? formatDist(resolvedDistributions.vd)
                      : ''
                  }
                  value={
                    config.overrides.vd?.type === 'fixed'
                      ? config.overrides.vd.value
                      : undefined
                  }
                  onChange={(v) =>
                    updateDrugConfig(config.id, {
                      overrides: {
                        ...config.overrides,
                        vd: v === undefined ? undefined : { type: 'fixed', value: v },
                      },
                    })
                  }
                  unit={t('simulator.events.litersUnit')}
                />
                <Field
                  label={t('simulator.events.bioavailability')}
                  placeholder={
                    resolvedDistributions
                      ? formatDist(resolvedDistributions.f)
                      : ''
                  }
                  value={
                    config.overrides.f?.type === 'fixed'
                      ? config.overrides.f.value
                      : undefined
                  }
                  onChange={(v) =>
                    updateDrugConfig(config.id, {
                      overrides: {
                        ...config.overrides,
                        f: v === undefined ? undefined : { type: 'fixed', value: v },
                      },
                    })
                  }
                />
              </>
            )}
            <div>
              <label className="text-xs font-medium">
                {t('simulator.drawCount')}
              </label>
              <Input
                type="number"
                min={1}
                max={ENGINE_LIMITS.maxDraws}
                placeholder="10000"
                value={config.overrides.drawCount ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  updateDrugConfig(config.id, {
                    overrides: {
                      ...config.overrides,
                      drawCount: v === '' ? undefined : Number(v),
                    },
                  });
                }}
                className="h-7 text-xs bg-card"
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface EventRowProps {
  event: SimEvent;
  molecularWeight?: number;
  timeFormat: TimeFormat;
  referenceTime: string;
  isEthanolEngine: boolean;
  isKinelabEngine: boolean;
  selected?: boolean;
  onChange: (updates: Partial<SimEvent>) => void;
  onRemove: () => void;
}

function EventRow({
  event,
  molecularWeight,
  timeFormat,
  referenceTime,
  isEthanolEngine,
  isKinelabEngine,
  selected = false,
  onChange,
  onRemove,
}: EventRowProps) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selected) return;
    rowRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    rowRef.current
      ?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select')
      ?.focus();
  }, [selected]);

  return (
    <div
      ref={rowRef}
      data-event-id={event.id}
      className={`rounded-md border border-border bg-card/60 p-2 space-y-2 ${
        selected ? 'ring-2 ring-ring ring-offset-2 ring-offset-background' : ''
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {event.type === 'dose'
            ? t('simulator.events.doseLabel')
            : event.type === 'measurement'
              ? t('simulator.events.measurementLabel')
              : t('simulator.events.queryLabel')}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 w-5 p-0 text-destructive"
          onClick={onRemove}
          title={t('simulator.events.removeEvent')}
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {event.type === 'dose' && (
          <DoseField
            label={t('simulator.events.amount')}
            placeholder={t('simulator.events.amountPlaceholder')}
            value={event.amount}
            onChange={(v) => onChange({ amount: v } as Partial<SimEvent>)}
            unit={event.unit}
            onUnitChange={(u) => onChange({ unit: u } as Partial<SimEvent>)}
            hint={
              isEthanolEngine
                ? t('simulator.events.ethanolDoseHint')
                : undefined
            }
          />
        )}
        {event.type === 'measurement' && (
          <ConcentrationField
            label={t('simulator.events.concentration')}
            placeholder={t('simulator.events.concentrationPlaceholder')}
            value={event.value}
            onChange={(v) => onChange({ value: v } as Partial<SimEvent>)}
            unit={event.unit}
            onUnitChange={(u) => onChange({ unit: u } as Partial<SimEvent>)}
            molecularWeight={molecularWeight}
          />
        )}
        <TimeField
          label={
            event.type === 'query'
              ? t('simulator.events.predictionTime')
              : t('simulator.events.atTime')
          }
          placeholder={
            event.type === 'query' && timeFormat === 'clock'
              ? t('simulator.events.relativeTimePlaceholder')
              : t('simulator.events.hoursPlaceholder')
          }
          value={event.t}
          onChange={(v) => onChange({ t: v } as Partial<SimEvent>)}
          timeFormat={timeFormat}
          referenceTime={referenceTime}
          preferRelative={event.type === 'query'}
        />
      </div>

      {event.type === 'dose' &&
        event.route === 'iv' &&
        !isKinelabEngine &&
        !isEthanolEngine && (
          <div className="mt-2">
            <Field
              label={t('simulator.events.infusionDuration')}
              placeholder="0"
              value={event.durationHours}
              onChange={(v) =>
                onChange({ durationHours: v } as Partial<SimEvent>)
              }
              unit={t('simulator.events.hoursUnit')}
            />
          </div>
        )}

      {event.type === 'dose' && isKinelabEngine && (
        <div className="grid grid-cols-2 gap-2 rounded border border-border/60 bg-muted/20 p-2">
          <Field
            label={t('simulator.events.dosePriorMin')}
            placeholder="50"
            value={event.amountRange?.min}
            onChange={(v) =>
              onChange({
                amountRange: { min: v ?? 0, max: event.amountRange?.max ?? 0 },
              } as Partial<SimEvent>)
            }
            unit={event.unit}
          />
          <Field
            label={t('simulator.events.dosePriorMax')}
            placeholder="500"
            value={event.amountRange?.max}
            onChange={(v) =>
              onChange({
                amountRange: { min: event.amountRange?.min ?? 0, max: v ?? 0 },
              } as Partial<SimEvent>)
            }
            unit={event.unit}
          />
          <TimeField
            label={t('simulator.events.windowEarliest')}
            placeholder={t('simulator.events.hoursPlaceholder')}
            value={event.tRange?.[0] ?? event.t}
            onChange={(v) =>
              onChange({
                tRange: [v ?? 0, event.tRange?.[1] ?? event.t ?? 0],
              } as Partial<SimEvent>)
            }
            timeFormat={timeFormat}
            referenceTime={referenceTime}
          />
          <TimeField
            label={t('simulator.events.windowLatest')}
            placeholder={t('simulator.events.hoursPlaceholder')}
            value={event.tRange?.[1] ?? event.t}
            onChange={(v) =>
              onChange({
                tRange: [event.tRange?.[0] ?? event.t ?? 0, v ?? 0],
              } as Partial<SimEvent>)
            }
            timeFormat={timeFormat}
            referenceTime={referenceTime}
          />
        </div>
      )}

      {event.type === 'measurement' && isKinelabEngine && (
        <div className="grid grid-cols-2 gap-2 rounded border border-border/60 bg-muted/20 p-2">
          <Field
            label={t('simulator.events.assayCV')}
            placeholder="0.15"
            value={event.assayCV}
            onChange={(v) => onChange({ assayCV: v } as Partial<SimEvent>)}
          />
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              {t('simulator.events.censoring')}
            </label>
            <select
              className="h-8 rounded border border-border bg-background px-2 text-xs"
              value={event.censoring ?? 'measured'}
              onChange={(e) =>
                onChange({
                  censoring:
                    e.target.value === 'measured'
                      ? undefined
                      : (e.target.value as 'below_lod' | 'below_loq'),
                } as Partial<SimEvent>)
              }
            >
              <option value="measured">
                {t('simulator.events.censoringMeasured')}
              </option>
              <option value="below_loq">
                {t('simulator.events.censoringBelowLoq')}
              </option>
              <option value="below_lod">
                {t('simulator.events.censoringBelowLod')}
              </option>
            </select>
          </div>
        </div>
      )}

      {event.type === 'dose' && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t('simulator.route')}:
          </span>
          <div className="flex gap-1">
            {ROUTES.map((r) => (
              <Button
                key={r.value}
                variant={event.route === r.value ? 'default' : 'outline'}
                size="sm"
                className="h-6 text-xs px-2"
                onClick={() =>
                  onChange({ route: r.value } as Partial<SimEvent>)
                }
              >
                {r.value === 'oral'
                  ? t('simulator.routes.oral')
                  : r.value === 'other'
                    ? t('simulator.routes.other')
                    : r.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {event.type === 'query' && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t('simulator.events.solveFor')}:
          </span>
          <div className="flex gap-1">
            {(['concentration', 'dose'] as const).map((solveFor) => (
              <Button
                key={solveFor}
                variant={event.solveFor === solveFor ? 'default' : 'outline'}
                size="sm"
                className="h-6 text-xs px-2"
                onClick={() => onChange({ solveFor } as Partial<SimEvent>)}
              >
                {solveFor === 'concentration'
                  ? t('simulator.events.solveConcentration')
                  : t('simulator.events.solveDose')}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
