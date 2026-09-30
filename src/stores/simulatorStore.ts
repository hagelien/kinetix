import { create } from 'zustand';
import type { DrugComponent } from '@/types';
import { fetchDrugComponentBySlug } from '@/lib/drugApi';
import type {
  DrugSimConfig,
  DrugSimResult,
  CaseDisplaySettings,
  MonteCarloConfig,
  QuestionMode,
  SimEvent,
} from '@/types/simulator';
import { rangeToDistribution } from '@/lib/rangeUtils';
import { resolveDrugName } from '@/lib/drugNames';
import {
  deriveQuestion,
  inferTimeRange,
  migrateDrugConfig,
} from '@/lib/eventDerivation';
import { ENGINE_LIMITS } from '@/lib/kinetics-core';
import { distributionInterval } from '@/lib/distributionInterval';
import {
  buildKinelabConfigFromCase,
  DEFAULT_KINELAB_ANALYTE,
} from '@/lib/modelingMigration';
import { isKinelabCaseData } from '@/types/kinelabCase';
import { isChartMatrix } from '@/lib/matrixDisplay';

const PALETTE = [
  '#2563eb',
  '#10b981',
  '#f97316',
  '#a855f7',
  '#ec4899',
  '#06b6d4',
];

/**
 * Run defaults. Exported because `/modeling/how-it-works` publishes them as the
 * simulator's stated configuration — a reviewer must be able to read the draw count and
 * seed a curve was produced with, and a value transcribed into a document would drift.
 */
export const DEFAULT_DRAW_COUNT = 10_000;
export const DEFAULT_SEED = 42;
/** Lower bound on output-grid resolution: never fewer points than this over the window. */
export const MIN_TIME_STEPS = 80;
/** Upper bound, so the worker's per-step arrays stay modest on a long window. */
export const MAX_TIME_STEPS = 160;
/** Output-grid resolution the window aims for, in hours, between those two bounds. */
export const TARGET_STEP_HOURS = 0.5;

interface SavedCaseMeta {
  id: number;
  name: string;
  updatedAt: string;
}

interface SimulatorState {
  /**
   * Bumped whenever auth-bound simulator state is reset. Async persistence
   * actions capture this value and ignore stale responses from an older
   * browser-tab session so private cases cannot cross auth boundaries.
   */
  sessionEpoch: number;

  // Case
  caseName: string;
  caseId: number | null;
  drugs: DrugSimConfig[];
  displaySettings: CaseDisplaySettings;

  // Results keyed by drug config id
  results: Record<string, DrugSimResult>;
  isRunning: boolean;
  runningDrugIds: Set<string>;

  // Saved cases list
  savedCases: SavedCaseMeta[];

  // Actions
  setCaseName: (name: string) => void;
  addDrug: (drug: DrugComponent) => void;
  upsertDrugConfig: (config: DrugSimConfig) => void;
  removeDrug: (configId: string) => void;
  updateDrugConfig: (configId: string, updates: Partial<DrugSimConfig>) => void;
  addEvent: (configId: string, event: SimEvent) => void;
  updateEvent: (
    configId: string,
    eventId: string,
    updates: Partial<SimEvent>,
  ) => void;
  removeEvent: (configId: string, eventId: string) => void;
  setDisplaySettings: (settings: Partial<CaseDisplaySettings>) => void;
  setResult: (drugConfigId: string, result: DrugSimResult) => void;
  setRunning: (running: boolean) => void;
  setDrugRunning: (drugId: string, running: boolean) => void;
  duplicateDrug: (configId: string) => void;
  clearResults: () => void;
  reset: () => void;

  // Persistence
  saveCase: () => Promise<void>;
  loadCase: (id: number) => Promise<void>;
  listCases: () => Promise<void>;
}

export const useSimulatorStore = create<SimulatorState>((set, get) => ({
  sessionEpoch: 0,
  caseName: 'New Case',
  caseId: null,
  drugs: [],
  displaySettings: {
    mode: 'overlay',
    showUncertaintyBands: true,
    normalizeMode: 'none',
    yAxisMode: 'shared',
    displayMatrix: 'whole_blood',
    timeFormat: 'clock',
    referenceTime: '00:00',
  },
  results: {},
  isRunning: false,
  runningDrugIds: new Set(),
  savedCases: [],

  setCaseName: (name) => set({ caseName: name }),

  addDrug: (drug) => {
    const state = get();
    const existingCount = state.drugs.filter(
      (d) => d.drugId === drug.id,
    ).length;
    // The simulator's `drugName` is a stable label used in saved cases — pick
    // the English name (or any available) so saved cases roundtrip across
    // language toggles without renaming the legend entries.
    const labelBase =
      resolveDrugName(drug.names, 'en') || resolveDrugName(drug.names, 'nb');
    const label =
      existingCount > 0 ? `${labelBase} (${existingCount + 1})` : labelBase;
    const colorIdx = state.drugs.length % PALETTE.length;

    const config: DrugSimConfig = {
      id: crypto.randomUUID?.() ?? String(Date.now()),
      drugId: drug.id,
      drugName: labelBase,
      label,
      events: [],
      route: 'oral',
      questionMode: 'later-from-earlier',
      inputs: {},
      overrides: {},
      display: {
        visible: true,
        color: PALETTE[colorIdx],
      },
    };

    set({ drugs: [...state.drugs, config] });
  },

  upsertDrugConfig: (config) => {
    set((state) => {
      const next = migrateDrugConfig(config);
      const index = state.drugs.findIndex((drug) => drug.id === next.id);
      if (index === -1) return { drugs: [...state.drugs, next] };
      const drugs = state.drugs.slice();
      drugs[index] = next;
      return { drugs };
    });
  },

  removeDrug: (configId) => {
    set((state) => {
      const { [configId]: _removed, ...remainingResults } = state.results;
      return {
        drugs: state.drugs.filter((d) => d.id !== configId),
        results: remainingResults,
      };
    });
  },

  duplicateDrug: (configId) => {
    const state = get();
    const source = state.drugs.find((d) => d.id === configId);
    if (!source) return;
    const count = state.drugs.filter((d) => d.drugId === source.drugId).length;
    const colorIdx = state.drugs.length % PALETTE.length;
    const clone: DrugSimConfig = {
      ...source,
      id: crypto.randomUUID?.() ?? String(Date.now()),
      label: `${source.drugName} (${count + 1})`,
      events: source.events.map((e) => ({
        ...e,
        id: crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
      })),
      inputs: { ...source.inputs },
      overrides: { ...source.overrides },
      display: { visible: true, color: PALETTE[colorIdx] },
    };
    set({ drugs: [...state.drugs, clone] });
  },

  updateDrugConfig: (configId, updates) => {
    set((state) => ({
      drugs: state.drugs.map((d) =>
        d.id === configId ? { ...d, ...updates } : d,
      ),
    }));
  },

  addEvent: (configId, event) => {
    set((state) => ({
      drugs: state.drugs.map((d) => {
        if (d.id !== configId) return d;
        const base = migrateDrugConfig(d);
        return { ...base, events: [...base.events, event] };
      }),
    }));
  },

  updateEvent: (configId, eventId, updates) => {
    set((state) => ({
      drugs: state.drugs.map((d) =>
        d.id === configId
          ? {
              ...d,
              events: d.events.map((e) =>
                e.id === eventId ? ({ ...e, ...updates } as SimEvent) : e,
              ),
            }
          : d,
      ),
    }));
  },

  removeEvent: (configId, eventId) => {
    set((state) => ({
      drugs: state.drugs.map((d) => {
        if (d.id !== configId) return d;
        const events = d.events.filter((e) => e.id !== eventId);
        return events.length === 0
          ? { ...d, events, inputs: {} }
          : { ...d, events };
      }),
    }));
  },

  setDisplaySettings: (settings) => {
    set((state) => ({
      displaySettings: { ...state.displaySettings, ...settings },
    }));
  },

  setResult: (drugConfigId, result) => {
    set((state) => ({
      results: { ...state.results, [drugConfigId]: result },
    }));
  },

  setRunning: (running) => set({ isRunning: running }),

  setDrugRunning: (drugId, running) => {
    set((state) => {
      const next = new Set(state.runningDrugIds);
      if (running) next.add(drugId);
      else next.delete(drugId);
      return { runningDrugIds: next, isRunning: next.size > 0 };
    });
  },

  clearResults: () => set({ results: {} }),

  reset: () =>
    set((state) => ({
      sessionEpoch: state.sessionEpoch + 1,
      caseName: 'New Case',
      caseId: null,
      drugs: [],
      displaySettings: {
        mode: 'overlay',
        showUncertaintyBands: true,
        normalizeMode: 'none',
        yAxisMode: 'shared',
        displayMatrix: 'whole_blood',
        timeFormat: 'clock',
        referenceTime: '00:00',
      },
      results: {},
      isRunning: false,
      runningDrugIds: new Set(),
      savedCases: [],
    })),

  saveCase: async () => {
    const { caseName, caseId, drugs, displaySettings, sessionEpoch } = get();
    const body = JSON.stringify({
      name: caseName,
      caseData: { drugs, displaySettings },
    });

    const url = caseId
      ? `/api/simulator/cases?id=${caseId}`
      : '/api/simulator/cases';
    const method = caseId ? 'PUT' : 'POST';

    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) throw new Error(await res.text());
    const saved = await res.json();
    if (get().sessionEpoch !== sessionEpoch) return;
    set({ caseId: saved.id });
  },

  loadCase: async (id) => {
    const sessionEpoch = get().sessionEpoch;
    const res = await fetch(`/api/simulator/cases?id=${id}`);
    if (!res.ok) throw new Error('Failed to load case');
    const row = await res.json();
    if (get().sessionEpoch !== sessionEpoch) return;
    if (isKinelabCaseData(row.caseData)) {
      const component = await fetchDrugComponentBySlug(
        row.caseData.input.analyte || DEFAULT_KINELAB_ANALYTE,
      ).catch(() => fetchDrugComponentBySlug(DEFAULT_KINELAB_ANALYTE));
      if (get().sessionEpoch !== sessionEpoch) return;
      set({
        caseId: row.id,
        caseName: row.name,
        drugs: [buildKinelabConfigFromCase(component, row.caseData, row.name)],
        displaySettings: {
          mode: 'overlay',
          showUncertaintyBands: true,
          normalizeMode: 'none',
          yAxisMode: 'shared',
          displayMatrix: 'whole_blood',
          timeFormat: 'hours',
          referenceTime: '00:00',
        },
        results: {},
      });
      return;
    }
    const data = row.caseData as {
      drugs?: DrugSimConfig[];
      displaySettings?: Partial<CaseDisplaySettings>;
    };
    if (get().sessionEpoch !== sessionEpoch) return;
    set({
      caseId: row.id,
      caseName: row.name,
      drugs: (data.drugs ?? []).map(migrateDrugConfig),
      displaySettings: {
        mode: 'overlay',
        showUncertaintyBands: true,
        normalizeMode: 'none',
        yAxisMode: 'shared',
        timeFormat: 'clock',
        referenceTime: '00:00',
        ...(data.displaySettings ?? {}),
        // caseData is arbitrary JSON: a persisted `null` or unknown matrix would
        // overwrite the default above and then be read as plasma-like
        // everywhere (scaling curves by 1/(B:P) with no button selected, and
        // handing an undefined key to the PM label). Coerce it back after the
        // spread so only a valid matrix survives.
        displayMatrix: isChartMatrix(data.displaySettings?.displayMatrix)
          ? data.displaySettings.displayMatrix
          : 'whole_blood',
      },
      results: {},
    });
  },

  listCases: async () => {
    const sessionEpoch = get().sessionEpoch;
    const res = await fetch('/api/simulator/cases');
    if (!res.ok) return;
    const data = await res.json();
    if (get().sessionEpoch !== sessionEpoch) return;
    set({ savedCases: data.cases ?? [] });
  },
}));

/**
 * Gather the dose events (relative to the first dose) and the concentration
 * query time for repeated-dose superposition. Only the forward
 * concentration-from-dose mode superposes; doses that don't share the primary
 * dose unit are skipped to avoid mixing units. Returns empty when superposition
 * doesn't apply, so callers fall back to the single-dose path.
 */
export function buildSuperposedDoses(
  config: DrugSimConfig,
  questionMode: QuestionMode,
  doseUnit: string | undefined,
): {
  doses?: Array<{ amount: number; tHours: number; durationHours?: number }>;
  queryTimeHours?: number;
} {
  if (
    questionMode !== 'concentration-from-dose' ||
    !Array.isArray(config.events)
  ) {
    return {};
  }
  const doseEvents = config.events.filter(
    (e): e is Extract<SimEvent, { type: 'dose' }> & { amount: number; t: number } =>
      e.type === 'dose' &&
      e.amount != null &&
      Number.isFinite(e.amount) &&
      e.t != null &&
      Number.isFinite(e.t) &&
      (doseUnit == null || e.unit === doseUnit),
  );
  const query = config.events
    .filter(
      (e): e is Extract<SimEvent, { type: 'query' }> & { t: number } =>
        e.type === 'query' &&
        e.solveFor === 'concentration' &&
        e.t != null &&
        Number.isFinite(e.t),
    )
    .sort((a, b) => b.t - a.t)[0];
  if (doseEvents.length === 0 || !query) return {};
  const t0 = Math.min(...doseEvents.map((d) => d.t));
  const queryTimeHours = query.t - t0;
  // A query before the first dose isn't a valid forward question; fall back.
  if (queryTimeHours < 0) return {};
  const doses = doseEvents
    .map((d) => ({
      amount: d.amount,
      tHours: d.t - t0,
      // Infusion only applies to IV; a positive duration switches that dose
      // from a bolus to a constant-rate infusion.
      ...(d.route === 'iv' && d.durationHours != null && d.durationHours > 0
        ? { durationHours: d.durationHours }
        : {}),
    }))
    .sort((a, b) => a.tHours - b.tHours);
  return { doses, queryTimeHours };
}

/**
 * Build a MonteCarloConfig for a drug, resolving literature parameter ranges
 * from the drug component data.
 */
export function buildConfigWithDrugData(
  drugConfig: DrugSimConfig,
  drugComponent: DrugComponent | undefined,
): MonteCarloConfig {
  // Resolve distributions: overrides take precedence over drug literature data
  const halfLife =
    drugConfig.overrides.halfLife ??
    (drugComponent?.halfLife
      ? rangeToDistribution(drugComponent.halfLife, 4)
      : { type: 'fixed' as const, value: 4 });
  const vd =
    drugConfig.overrides.vd ??
    (drugComponent?.volumeOfDistribution
      ? rangeToDistribution(drugComponent.volumeOfDistribution, 50)
      : { type: 'fixed' as const, value: 50 });
  const f =
    drugConfig.overrides.f ??
    (drugComponent?.bioavailability
      ? rangeToDistribution(drugComponent.bioavailability, 1)
      : { type: 'fixed' as const, value: 1 });

  // The engine rejects a run whose draw count is outside 1..maxDraws, which surfaced
  // as "Ingen svar" for an oversized entry. Clamp to the cap, and fall back to the
  // default for a non-finite or non-positive entry.
  const requestedDraws = drugConfig.overrides.drawCount;
  const drawCount =
    requestedDraws == null || !Number.isFinite(requestedDraws) || requestedDraws < 1
      ? DEFAULT_DRAW_COUNT
      : Math.min(Math.trunc(requestedDraws), ENGINE_LIMITS.maxDraws);
  const { questionMode, route, inputs } = deriveQuestion(drugConfig);

  // Detect per-kg Vd: scale by body weight ONLY when the stored unit is
  // explicitly L/kg. A missing unit is treated as unknown (absolute litres),
  // never implicitly L/kg — silently multiplying an already-litre Vd by body
  // weight inflates the volume by a body-weight factor. Default to a 70 kg
  // reference adult when no subject weight is supplied for a genuine L/kg Vd.
  const DEFAULT_WEIGHT_KG = 70;
  const vdUnit =
    typeof drugComponent?.volumeOfDistribution === 'object'
      ? (drugComponent.volumeOfDistribution as { unit?: string })?.unit
      : undefined;
  const vdIsPerKg = vdUnit === 'L/kg';
  const needsWeightScaling = vdIsPerKg && !drugConfig.overrides.vd;
  const effectiveWeight =
    inputs.weight ?? (needsWeightScaling ? DEFAULT_WEIGHT_KG : undefined);

  let { start: timeStart, end: timeEnd } = inferTimeRange(questionMode, inputs);

  // Repeated-dose superposition: for the forward concentration-from-dose mode,
  // gather every same-unit dose event (not just the latest) with its time
  // relative to the first dose, so the worker sums their contributions. A
  // single dose reproduces the previous single-dose result exactly.
  const { doses, queryTimeHours } = buildSuperposedDoses(
    drugConfig,
    questionMode,
    inputs.doseUnit,
  );
  if (doses && doses.length > 1 && queryTimeHours != null) {
    const maxRel = Math.max(queryTimeHours, ...doses.map((d) => d.tHours));
    timeStart = 0;
    timeEnd = Math.max(maxRel * 1.5, 24);
  }

  // Extend the window so the curve visibly decays a few half-lives past the last
  // event, rather than stopping at the fixed inferTimeRange default. Otherwise a
  // long half-life drug never dips below the therapeutic band on-screen. The
  // display then trims back to where the curve actually crosses the threshold
  // (see SimulatorPage.timelineRange).
  const eventTimesRel: number[] = [0];
  const pushIfFinite = (v: number | undefined) => {
    if (v != null && Number.isFinite(v)) eventTimesRel.push(v);
  };
  pushIfFinite(inputs.timeSinceDose);
  pushIfFinite(inputs.measuredTime);
  pushIfFinite(inputs.targetTime);
  pushIfFinite(queryTimeHours);
  if (doses) for (const d of doses) pushIfFinite(d.tHours);
  const lastEventRel = Math.max(...eventTimesRel);
  const repHalfLife = distributionInterval(halfLife).median;
  if (Number.isFinite(repHalfLife) && repHalfLife > 0) {
    timeEnd = Math.max(timeEnd, lastEventRel + 4 * repHalfLife);
  }

  // Keep the curve smooth over the (possibly much longer) window: target ~0.5 h
  // resolution, bounded so the worker's per-step arrays stay modest.
  const steps = Math.min(
    MAX_TIME_STEPS,
    Math.max(
      MIN_TIME_STEPS,
      Math.ceil((timeEnd - timeStart) / TARGET_STEP_HOURS),
    ),
  );

  return {
    drugConfigId: drugConfig.id,
    questionMode,
    route,
    inputs,
    halfLife,
    vd,
    f,
    drawCount,
    seed: DEFAULT_SEED,
    timeRange: { start: timeStart, end: timeEnd, steps },
    // Scale only for a genuine L/kg Vd. Entering a subject weight alone must
    // NOT trigger scaling of an absolute-litre Vd.
    weightScaling: needsWeightScaling,
    weight: effectiveWeight,
    molecularWeight: drugComponent?.molecularWeight,
    doses,
    queryTimeHours,
    // Enable Bateman oral absorption only when an absorption rate is supplied.
    absorptionKa:
      drugConfig.overrides.ka != null &&
      Number.isFinite(drugConfig.overrides.ka) &&
      drugConfig.overrides.ka > 0
        ? drugConfig.overrides.ka
        : undefined,
  };
}
