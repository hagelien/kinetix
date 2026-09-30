import type { DrugComponent } from '@/types';
import type { Scenario } from '@/lib/etohScenario';
import type { KineLabCaseData } from '@/types/kinelabCase';
import type {
  ComponentEngine,
  DoseEvent,
  DrugSimConfig,
  MeasurementEvent,
  SimEvent,
} from '@/types/simulator';
import { DEFAULT_WORKBOOK_INPUT, scenarioFromHash } from '@/lib/etohScenario';
import { ETHANOL_PUBCHEM_CID } from '@/lib/ethanolSimulator';
import { resolveDrugName } from '@/lib/drugNames';

const DEFAULT_DISPLAY = { visible: true, color: '#2563eb' };
export const LEGACY_ETHANOL_CONFIG_ID = 'legacy-ethanol-component';
export const LEGACY_KINELAB_CONFIG_ID = 'legacy-kinelab-component';
// Must match the seeded drug slug (`generateSlug('Ketamine')` → 'ketamine').
// The API resolves slugs by exact match, so the earlier 'ketamin' returned
// "Drug not found" and the default KineLab component never loaded.
export const DEFAULT_KINELAB_ANALYTE = 'ketamine';

function componentLabel(component: DrugComponent, fallback: string): string {
  return (
    resolveDrugName(component.names, 'en') ||
    resolveDrugName(component.names, 'nb') ||
    fallback
  );
}

function hoursBetween(iso: string | undefined, baselineMs: number): number {
  if (!iso) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? (parsed - baselineMs) / 3_600_000 : 0;
}

function fixedOrUniformDose(
  prior: KineLabCaseData['input']['priors']['dose'],
): {
  amount?: number;
  amountRange?: { min: number; max: number };
} {
  if (prior.type === 'fixed') return { amount: prior.value };
  if (prior.type === 'uniform' || prior.type === 'triangular') {
    return { amountRange: { min: prior.min, max: prior.max } };
  }
  return { amount: Math.exp(prior.mu) };
}

export function scenarioFromLocationHash(hash: string): Scenario | null {
  const match = /^#scenario=(.+)$/.exec(hash);
  if (!match?.[1]) return null;
  try {
    return scenarioFromHash(match[1]);
  } catch {
    return null;
  }
}

export function buildEthanolConfig(
  component: DrugComponent,
  scenario?: Scenario | null,
): DrugSimConfig {
  const label = componentLabel(component, 'Ethanol');
  const events: SimEvent[] =
    scenario?.intakes.map<DoseEvent>((intake) => ({
      id: intake.id,
      type: 'dose',
      t: intake.timeHour,
      amount: intake.ethanolGrams,
      unit: 'g',
      route: 'oral',
    })) ?? [];

  return {
    id: LEGACY_ETHANOL_CONFIG_ID,
    drugId: component.id || String(ETHANOL_PUBCHEM_CID),
    drugName: label,
    label,
    engine: 'ethanol-widmark',
    ethanol: {
      weightKg: scenario?.person.weightKg ?? 75,
      biologicalSex: scenario?.person.biologicalSex ?? 'male',
      eliminationRateGdlPerHour:
        scenario?.person.eliminationRateGdlPerHour ?? 0.015,
      distributionRatioOverride: scenario?.person.distributionRatioOverride,
      workbook: scenario?.workbook ?? { ...DEFAULT_WORKBOOK_INPUT },
    },
    events,
    route: 'oral',
    questionMode: 'concentration-from-dose',
    inputs: {},
    overrides: {},
    display: { ...DEFAULT_DISPLAY, color: '#ea580c' },
  };
}

export function buildDefaultKinelabConfig(
  component: DrugComponent,
): DrugSimConfig {
  const label = componentLabel(component, 'Ketamine');
  return {
    id: LEGACY_KINELAB_CONFIG_ID,
    drugId: component.id,
    drugName: label,
    label,
    engine: 'kinelab-bayes',
    events: [
      {
        id: 'legacy-kinelab-dose',
        type: 'dose',
        t: 0,
        tRange: [0, 5],
        amountRange: { min: 20, max: 500 },
        unit: 'mg',
        route: 'oral',
      },
      {
        id: 'legacy-kinelab-measurement',
        type: 'measurement',
        t: 6,
        value: 0.2,
        unit: 'mg/L',
        assayCV: 0.15,
      },
    ],
    kinelab: {
      assayCV: 0.15,
      drawCount: 4000,
    },
    route: 'oral',
    questionMode: 'dose-from-concentration',
    inputs: {
      measuredConcentration: 0.2,
      concentrationUnit: 'mg/L',
      timeSinceDose: 6,
    },
    overrides: {},
    display: { ...DEFAULT_DISPLAY, color: '#0ea5e9' },
  };
}

export function buildKinelabConfigFromCase(
  component: DrugComponent,
  caseData: KineLabCaseData,
  caseName?: string,
): DrugSimConfig {
  const input = caseData.input;
  const label = caseName?.trim() || componentLabel(component, input.analyte);
  const window = input.scenario?.possibleIntakeWindow;
  const baselineMs = Date.parse(
    window?.earliestIso ?? input.observations[0]?.sampleTime ?? '',
  );
  const baseline = Number.isFinite(baselineMs) ? baselineMs : Date.now();
  const latest = window ? hoursBetween(window.latestIso, baseline) : 0;
  const route = input.route ?? 'oral';
  const dose: DoseEvent = {
    id: 'legacy-kinelab-dose',
    type: 'dose',
    t: 0,
    tRange: [0, Math.max(0, latest)],
    unit: 'mg',
    route,
    ...fixedOrUniformDose(input.priors.dose),
  };
  const observations = input.observations.map<MeasurementEvent>((obs, idx) => ({
    id: obs.id || `legacy-kinelab-measurement-${idx + 1}`,
    type: 'measurement',
    t: hoursBetween(obs.sampleTime, baseline),
    value: obs.concentration.value,
    unit: obs.concentration.unit,
    assayCV: obs.assay?.uncertaintyCV ?? input.defaultAssayCV,
  }));

  return {
    id: `kinelab-case-${caseData.input.modelId}`,
    drugId: component.id,
    drugName: componentLabel(component, input.analyte),
    label,
    engine: 'kinelab-bayes' as ComponentEngine,
    events: [dose, ...observations],
    kinelab: {
      assayCV: input.defaultAssayCV,
      drawCount: input.drawCount,
      priorsSnapshot: input.priors,
      subject: {
        weightKg: input.subject?.weightKg,
        sex: input.subject?.sex,
        ageYears: input.subject?.age,
      },
    },
    route,
    questionMode: 'dose-from-concentration',
    inputs: {
      measuredConcentration: observations[0]?.value,
      concentrationUnit: observations[0]?.unit,
      timeSinceDose: observations[0]?.t,
      weight: input.subject?.weightKg,
    },
    weight: input.subject?.weightKg,
    overrides: {},
    display: { ...DEFAULT_DISPLAY, color: '#0ea5e9' },
  };
}
