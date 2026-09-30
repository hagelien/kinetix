import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSimulatorStore } from '@/stores/simulatorStore';
import { useAppStore } from '@/stores/appStore';
import {
  curveUnitOf,
  toPreferredUnitResult,
} from '@/lib/modelingDisplayUnit';
import { loadComponents } from '@/data';
import { useMonteCarloWorker } from '@/workers/useMonteCarloWorker';
import { useInferenceWorker } from '@/workers/useInferenceWorker';
import type { DrugComponent, NumericRange } from '@/types';
import { rangeToDistribution } from '@/lib/rangeUtils';
import {
  runComponent,
  isComponentRunnable,
  getRunBlockReasonKey,
} from '@/lib/modelingRun';
import { isResultStale } from '@/lib/resultStaleness';
import type {
  DrugSimConfig,
  DrugSimResult,
  MeasurementEvent,
  SimEvent,
} from '@/types/simulator';
import { exportSummaryText, downloadTextFile } from '@/lib/simulatorExport';
import { ETHANOL_PUBCHEM_CID, isEthanolDrugId } from '@/lib/ethanolSimulator';
import {
  keyComponentByLookupId,
  parseInternalDrugComponentId,
} from '@/lib/drugComponentId';
import {
  fetchDrugComponentByCid,
  fetchDrugComponentById,
  fetchDrugComponentBySlug,
} from '@/lib/drugApi';
import {
  buildDefaultKinelabConfig,
  buildEthanolConfig,
  DEFAULT_KINELAB_ANALYTE,
  scenarioFromLocationHash,
} from '@/lib/modelingMigration';
import { buildSimulatorReferenceRangeFromParameters } from '@/lib/referenceConcentrationsOverlay';
import { gradeResult, type ResultGrade } from '@/lib/reviewedModelGrade';
import { useAuthStore } from '@/stores/authStore';
import {
  acknowledgementKey,
  hasAcknowledgement,
  useModelAcknowledgementStore,
} from '@/stores/modelAcknowledgementStore';
import {
  bloodPlasmaFactorOrNull,
  matrixDisplayFactor,
  isChartMatrix,
  type ChartMatrix,
} from '@/lib/matrixDisplay';
import {
  usePmOverlay,
  type PmOverlaySeriesInput,
} from '@/lib/usePmOverlay';
import {
  useForensicOverlay,
  type ForensicOverlaySeriesInput,
} from '@/lib/useForensicOverlay';
import type { ReferenceRange } from '@/components/simulator/LazySimulatorGraph';
import type { LegalLimit } from '@/components/simulator/SimulatorGraph';
import { SimulatorModelingRail } from '@/components/modeling/modes/SimulatorModelingRail';
import {
  SimulatorModelingResults,
  type SimulatorAssumptionContextEntry,
  type SimulatorRunStateMetadata,
} from '@/components/modeling/modes/SimulatorModelingResults';
import {
  EventTimeline,
  computeTimelineRange,
  type TimelineMarker,
} from '@/components/simulator/EventTimeline';
import { useTranslation } from 'react-i18next';

function isDrugConfigComplete(d: DrugSimConfig): boolean {
  return isComponentRunnable(d);
}

function newEventId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)
  );
}

async function fetchEthanolBridgeComponent(): Promise<DrugComponent> {
  try {
    return await fetchDrugComponentByCid(ETHANOL_PUBCHEM_CID);
  } catch (err) {
    const components = await loadComponents();
    const fallback = components.find(
      (component) =>
        component.pubchemCid === ETHANOL_PUBCHEM_CID ||
        isEthanolDrugId(component.id),
    );
    if (fallback) return fallback;
    throw err;
  }
}

export function SimulatorPage() {
  const { t } = useTranslation();
  const [showSearch, setShowSearch] = useState(true);
  const [loadedComponents, setLoadedComponents] = useState<DrugComponent[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const pendingHydrationRef = useRef(new Set<string>());
  const pendingRouteDrugIdRef = useRef<string | null>(null);
  const pendingLegacyModeRef = useRef<string | null>(null);

  const caseName = useSimulatorStore((s) => s.caseName);
  const drugs = useSimulatorStore((s) => s.drugs);
  const displaySettings = useSimulatorStore((s) => s.displaySettings);
  const results = useSimulatorStore((s) => s.results);
  const isRunning = useSimulatorStore((s) => s.isRunning);
  const addDrug = useSimulatorStore((s) => s.addDrug);
  const upsertDrugConfig = useSimulatorStore((s) => s.upsertDrugConfig);
  const setDisplaySettings = useSimulatorStore((s) => s.setDisplaySettings);
  const setResult = useSimulatorStore((s) => s.setResult);
  const setDrugRunning = useSimulatorStore((s) => s.setDrugRunning);
  const updateEvent = useSimulatorStore((s) => s.updateEvent);

  const { runSimulation } = useMonteCarloWorker();
  const { runInference } = useInferenceWorker();

  const updateDrugConfig = useSimulatorStore((s) => s.updateDrugConfig);

  const upsertLoadedComponent = useCallback((component: DrugComponent) => {
    setLoadedComponents((prev) => {
      const index = prev.findIndex((entry) => entry.id === component.id);
      if (index === -1) return [...prev, component];
      const next = prev.slice();
      next[index] = component;
      return next;
    });
    return component;
  }, []);

  const hydrateComponentByDbId = useCallback(
    async (dbId: number) => {
      const component = await fetchDrugComponentById(dbId);
      return upsertLoadedComponent(component);
    },
    [upsertLoadedComponent],
  );

  const hydrateComponentByRouteId = useCallback(
    async (routeId: string) => {
      // An explicit `drug:<id>` key (see #1256) always names a CID-less
      // drug's own internal id — unambiguous, no CID fallback needed.
      const internalId = parseInternalDrugComponentId(routeId);
      if (internalId != null) {
        const component = await fetchDrugComponentById(internalId);
        return upsertLoadedComponent(
          keyComponentByLookupId(component, routeId),
        );
      }

      const numericId = Number(routeId);
      if (!Number.isFinite(numericId)) {
        const component = await fetchDrugComponentBySlug(routeId);
        return upsertLoadedComponent(component);
      }

      try {
        const component = await fetchDrugComponentByCid(numericId);
        return upsertLoadedComponent(component);
      } catch {
        const component = await fetchDrugComponentById(numericId);
        return upsertLoadedComponent(
          keyComponentByLookupId(component, routeId),
        );
      }
    },
    [upsertLoadedComponent],
  );

  useEffect(() => {
    const mode = searchParams.get('mode');
    const drugId = searchParams.get('drugId');
    const hasEthanolScenario = /^#scenario=/.test(window.location.hash);
    const shouldBridgeEthanol =
      mode === 'ethanol' || isEthanolDrugId(drugId) || hasEthanolScenario;
    const shouldBridgeKinelab = mode === 'kinelab';
    if (!shouldBridgeEthanol && !shouldBridgeKinelab) return;

    const bridgeKey = `${mode ?? ''}:${drugId ?? ''}:${window.location.hash}`;
    if (pendingLegacyModeRef.current === bridgeKey) return;
    pendingLegacyModeRef.current = bridgeKey;

    const cleanModeParam = () => {
      if (!mode) return;
      const params = new URLSearchParams(searchParams);
      params.delete('mode');
      const query = params.toString();
      navigate(`/modeling${query ? `?${query}` : ''}${window.location.hash}`, {
        replace: true,
      });
    };

    if (shouldBridgeEthanol) {
      fetchEthanolBridgeComponent()
        .then((component) => {
          const scenario = hasEthanolScenario
            ? scenarioFromLocationHash(window.location.hash)
            : null;
          upsertLoadedComponent(component);
          upsertDrugConfig(buildEthanolConfig(component, scenario));
          if (scenario?.referenceTime) {
            setDisplaySettings({
              timeFormat: 'clock',
              referenceTime: scenario.referenceTime,
            });
          }
          setShowSearch(false);
          cleanModeParam();
        })
        .catch((err) => {
          console.error('Failed to bridge legacy ethanol scenario:', err);
        })
        .finally(() => {
          pendingLegacyModeRef.current = null;
        });
      return;
    }

    fetchDrugComponentBySlug(DEFAULT_KINELAB_ANALYTE)
      .then((component) => {
        upsertLoadedComponent(component);
        upsertDrugConfig(buildDefaultKinelabConfig(component));
        setDisplaySettings({ timeFormat: 'hours' });
        setShowSearch(false);
        cleanModeParam();
      })
      .catch((err) => {
        console.error('Failed to bridge legacy KineLab mode:', err);
      })
      .finally(() => {
        pendingLegacyModeRef.current = null;
      });
  }, [
    navigate,
    searchParams,
    setDisplaySettings,
    upsertDrugConfig,
    upsertLoadedComponent,
  ]);

  useEffect(() => {
    const uniqueDrugIds = new Set(drugs.map((drug) => drug.drugId));
    for (const drugId of uniqueDrugIds) {
      if (pendingHydrationRef.current.has(drugId)) continue;
      if (loadedComponents.some((component) => component.id === drugId))
        continue;

      pendingHydrationRef.current.add(drugId);
      hydrateComponentByRouteId(drugId)
        .catch((err) => {
          console.error(`Failed to hydrate simulator drug ${drugId}:`, err);
        })
        .finally(() => {
          pendingHydrationRef.current.delete(drugId);
        });
    }
  }, [drugs, hydrateComponentByRouteId, loadedComponents]);

  // Auto-add drug from URL param
  useEffect(() => {
    const drugId = searchParams.get('drugId');
    if (!drugId) return;
    if (isEthanolDrugId(drugId)) {
      return;
    }
    if (drugs.some((d) => d.drugId === drugId)) return;
    if (pendingRouteDrugIdRef.current === drugId) return;

    pendingRouteDrugIdRef.current = drugId;
    hydrateComponentByRouteId(drugId)
      .then((component) => {
        addDrug(component);
        const conc = searchParams.get('conc');
        const concUnit = searchParams.get('concUnit');
        if (conc) {
          const concNum = Number(conc);
          if (Number.isFinite(concNum) && concNum > 0) {
            const state = useSimulatorStore.getState();
            const added = state.drugs.find((d) => d.drugId === component.id);
            if (added) {
              const concentrationUnit =
                concUnit ?? added.inputs.concentrationUnit ?? 'mg/L';
              const measurementEvent: MeasurementEvent = {
                id: newEventId(),
                type: 'measurement',
                t: added.inputs.measuredTime ?? 0,
                value: concNum,
                unit: concentrationUnit,
              };
              updateDrugConfig(added.id, {
                events: [...added.events, measurementEvent],
                inputs: {
                  ...added.inputs,
                  measuredConcentration: concNum,
                  concentrationUnit,
                },
              });
            }
          }
        }
        setShowSearch(false);
      })
      .catch((err) => {
        console.error(`Failed to auto-load simulator drug ${drugId}:`, err);
      })
      .finally(() => {
        if (pendingRouteDrugIdRef.current === drugId) {
          pendingRouteDrugIdRef.current = null;
        }
      });
  }, [
    searchParams,
    drugs,
    addDrug,
    updateDrugConfig,
    hydrateComponentByRouteId,
  ]);

  const drugComponentMap = useMemo(() => {
    const map = new Map<string, DrugComponent>();
    for (const c of loadedComponents) map.set(c.id, c);
    return map;
  }, [loadedComponents]);

  const drugLabels = useMemo(() => {
    const labels: Record<string, string> = {};
    for (const d of drugs) labels[d.id] = d.label;
    return labels;
  }, [drugs]);

  const drugColors = useMemo(() => {
    const colors: Record<string, string> = {};
    for (const d of drugs) colors[d.id] = d.display.color ?? '#2563eb';
    return colors;
  }, [drugs]);

  const drugMolecularWeights = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const d of drugs) {
      const component = drugComponentMap.get(d.drugId);
      out[d.id] = component?.molecularWeight ?? null;
    }
    return out;
  }, [drugs, drugComponentMap]);

  const drugBloodPlasmaRatios = useMemo(() => {
    const out: Record<string, NumericRange | number | null> = {};
    for (const d of drugs) {
      out[d.id] = drugComponentMap.get(d.drugId)?.bloodPlasmaRatio ?? null;
    }
    return out;
  }, [drugs, drugComponentMap]);

  // Internal drugs.id per config, so the assumptions pane can load each drug's
  // parameter references (for the hoverable "refs" tooltips).
  const drugDbIds = useMemo(() => {
    const out: Record<string, number | null> = {};
    for (const d of drugs) {
      out[d.id] = drugComponentMap.get(d.drugId)?._dbId ?? null;
    }
    return out;
  }, [drugs, drugComponentMap]);

  // The user's preferred concentration unit (from settings). Every displayed
  // concentration — graph axis, median/bands, and the Svar headline — is
  // re-expressed in it so a mass-based input no longer leaves the readouts in a
  // mix of units.
  const preferredUnit = useAppStore((s) => s.enabledUnits)[0];

  const displayMatrix = displaySettings.displayMatrix ?? 'whole_blood';
  const userRole = useAuthStore((s) => s.user?.role ?? null);
  const userId = useAuthStore((s) => s.user?.id ?? null);
  // §5.1's reviewer path: a grade-D model renders only to a reviewer who has an
  // acknowledgement on record for THIS model and THIS evidence. The version key comes
  // from the grade itself (`acknowledgementVersionFor`), so a change to what was
  // disclosed asks the reviewer again rather than inheriting their answer.
  const acknowledgements = useModelAcknowledgementStore((s) => s.acknowledgements);
  const acknowledgeModel = useModelAcknowledgementStore((s) => s.acknowledge);
  const withdrawModelAcknowledgement = useModelAcknowledgementStore((s) => s.withdraw);

  // Unit-only conversion for the canonical readouts (Svar headline, summary,
  // export). The chart's display MATRIX is applied separately to the plotted
  // curve (matrixFactors below), so it never reframes the primary answer.
  const displayResults = useMemo(() => {
    const out: Record<string, DrugSimResult> = {};
    for (const [id, result] of Object.entries(results)) {
      out[id] = toPreferredUnitResult(
        result,
        drugMolecularWeights[id],
        preferredUnit,
      );
    }
    return out;
  }, [results, drugMolecularWeights, preferredUnit]);

  // The matrix each drug's curve is NATIVELY computed in. A reviewed
  // kinetics-core model declares its own (plasma for most of the registry, whole
  // blood for ethanol) and reports it on the result; anything without one — an
  // older saved case, the Widmark engine — is whole blood, the legacy frame.
  const curveNativeMatrix = useCallback(
    (drugId: string): string =>
      results[drugId]?.assumptions.nativeMatrix ?? 'whole_blood',
    [results],
  );

  // Per-series multiplier that reframes each plotted curve FROM the matrix its
  // model computed in INTO the display matrix. Every drug whose conversion is
  // fully defined gets an entry — including an identity factor of 1, so
  // membership answers "can this curve be expressed in the matrix?", kept
  // distinct from "did the value move?" Drugs whose conversion needs a
  // blood:plasma ratio they do not have are absent and named in the warning
  // below.
  //
  // Unlike the previous version this is NOT skipped for a whole-blood display:
  // a plasma model shown in whole blood is a real conversion (x r), and
  // assuming otherwise was plotting plasma numbers on a whole-blood axis.
  const matrixFactors = useMemo<Record<string, number>>(() => {
    const out: Record<string, number> = {};
    for (const d of drugs) {
      // Only a blood-drug concentration curve converts between matrices. The
      // ethanol/Widmark engine plots a BAC in g/dL — no blood:plasma meaning —
      // so it keeps whole blood and is named in the warning, whatever B/P range
      // the catalog lists. Gate on the ENGINE, not the scalar result unit:
      // every Monte Carlo mode plots a concentration curve, and in
      // dose-from-concentration the scalar unit is a dose (mg) even though the
      // plotted curve is still a concentration that should convert.
      if (results[d.id]?.engine === 'ethanol-widmark') {
        if (displayMatrix === 'whole_blood') out[d.id] = 1;
        continue;
      }
      const factor = matrixDisplayFactor(
        curveNativeMatrix(d.id),
        displayMatrix,
        bloodPlasmaFactorOrNull(drugBloodPlasmaRatios[d.id]),
      );
      if (factor != null) out[d.id] = factor;
    }
    return out;
  }, [
    drugs,
    displayMatrix,
    drugBloodPlasmaRatios,
    results,
    curveNativeMatrix,
  ]);

  // The scalar blood:plasma ratio per drug — the same value `matrixFactors`
  // converts with, surfaced so the assumptions panel can name the factor rather
  // than leaving a converted curve to look like a measured one.
  const curveBloodPlasmaRatios = useMemo<Record<string, number | null>>(() => {
    const out: Record<string, number | null> = {};
    for (const d of drugs) {
      out[d.id] = bloodPlasmaFactorOrNull(drugBloodPlasmaRatios[d.id]);
    }
    return out;
  }, [drugs, drugBloodPlasmaRatios]);

  // The matrix each drug's series is ACTUALLY drawn in: the chosen matrix when
  // its curve converted (it has a factor above), else the matrix its own model
  // computed in — NOT an assumed whole blood, which would relabel an
  // unconvertible plasma curve as blood. Derived straight from `matrixFactors`
  // so the pooled thresholds and both reference overlays share the curve's frame
  // exactly.
  const effectiveMatrix = useMemo<Record<string, ChartMatrix>>(() => {
    const out: Record<string, ChartMatrix> = {};
    for (const d of drugs) {
      if (matrixFactors[d.id] != null) {
        out[d.id] = displayMatrix;
        continue;
      }
      const native = curveNativeMatrix(d.id);
      out[d.id] = isChartMatrix(native) ? native : 'whole_blood';
    }
    return out;
  }, [drugs, displayMatrix, matrixFactors, curveNativeMatrix]);

  // Visible curves left in their model's own matrix because the drug has no B/P
  // ratio to convert with — named so an unconverted curve is never taken for the
  // chosen matrix. Unlike before this is not empty for a whole-blood display: a
  // plasma model with no ratio cannot be shown in blood either.
  const matrixConversionUnavailableFor = useMemo<string[]>(() => {
    return drugs
      .filter(
        (d) =>
          d.display.visible &&
          results[d.id] != null &&
          matrixFactors[d.id] == null,
      )
      .map((d) => d.label);
  }, [drugs, results, matrixFactors]);

  // At least one visible curve is expressed in the display matrix (its drug has
  // a usable ratio, identity included), so the "converted" note is shown only
  // when the chart is genuinely reframed rather than fully falling back to blood.
  const anyMatrixConverted = useMemo(
    () =>
      drugs.some(
        (d) =>
          d.display.visible &&
          results[d.id] != null &&
          matrixFactors[d.id] != null,
      ),
    [drugs, results, matrixFactors],
  );

  // Evidence grade + rendering disposition per result, for this viewer and this
  // display matrix (the matrix bridge is a property of the VIEW, so the grade is
  // recomputed when the user changes matrix rather than cached with the run).
  const resultGrades = useMemo<Record<string, ResultGrade | null>>(() => {
    const out: Record<string, ResultGrade | null> = {};
    for (const d of drugs) {
      const modelId = displayResults[d.id]?.assumptions.modelId;
      out[d.id] = gradeResult(displayResults[d.id], {
        role: userRole,
        displayMatrix,
        isAcknowledged: (version) =>
          modelId !== undefined &&
          hasAcknowledgement(acknowledgements, modelId, version, userId),
      });
    }
    return out;
  }, [drugs, displayResults, userRole, displayMatrix, acknowledgements, userId]);

  // Record a reviewer's acknowledgement for the model behind one result. Keyed by
  // the run's own `modelId` rather than by analyte, matching how `gradeResult`
  // resolves: a saved case pinned to a superseded model is a different model, and
  // acknowledging today's must not silently cover it.
  const handleAcknowledgeModel = useCallback(
    (configId: string) => {
      const modelId = displayResults[configId]?.assumptions.modelId;
      const version = resultGrades[configId]?.acknowledgementVersion;
      if (!modelId || !version) return;
      acknowledgeModel(modelId, version, userId);
    },
    [displayResults, resultGrades, acknowledgeModel, userId],
  );

  const handleWithdrawModelAcknowledgement = useCallback(
    (configId: string) => {
      const modelId = displayResults[configId]?.assumptions.modelId;
      const version = resultGrades[configId]?.acknowledgementVersion;
      if (!modelId || !version) return;
      withdrawModelAcknowledgement(modelId, version, userId);
    },
    [displayResults, resultGrades, withdrawModelAcknowledgement, userId],
  );

  // Which on-screen results are rendering only because this viewer acknowledged
  // them, so the disclosure can say so and offer the way back.
  const acknowledgedDrugs = useMemo(() => {
    const out = new Map<string, string>();
    for (const d of drugs) {
      const modelId = displayResults[d.id]?.assumptions.modelId;
      const version = resultGrades[d.id]?.acknowledgementVersion;
      if (modelId == null || version == null) continue;
      const record = acknowledgements[acknowledgementKey(modelId, version, userId)];
      if (record) out.set(d.id, record.at);
    }
    return out;
  }, [drugs, displayResults, resultGrades, acknowledgements, userId]);

  // The gate: a model whose disposition is not renderable contributes no curve.
  // Every reviewed model is C and Amendment 1 renders C to everyone, so the
  // reviewed tier passes this untouched — but a hard stop (a route or analyte
  // mismatch) must never reach a chart, and a DERIVED model is gated at §5.1's
  // floor (the amendment does not cover that tier), so it is hidden below editor.
  // Both are decided here rather than in the chart.
  //
  // `!grade` means the result came from an engine this policy does not govern
  // (ethanol/Widmark, KineLab, an older saved case), which carries its own
  // assumption surface. It is NOT the fallback for a registry model that could
  // not be graded — `gradeResult` returns an explicit hidden disposition there,
  // precisely so an ungraded catalog curve cannot arrive through this branch.
  const visibleDrugs = useMemo(() => {
    return new Set(
      drugs
        .filter((d) => d.display.visible)
        .filter((d) => {
          const grade = resultGrades[d.id];
          if (!grade) return true; // not governed by the policy
          return (
            grade.disposition === 'render' ||
            grade.disposition === 'render-with-limitations'
          );
        })
        .map((d) => d.id),
    );
  }, [drugs, resultGrades]);

  // Every drug the user has toggled on that produced a result, REGARDLESS of what
  // the gate decided. `visibleDrugs` answers "may this curve be drawn"; this answers
  // "is this drug on screen at all", and the evidence disclosure is keyed to the
  // second. Filtering the disclosure by `visibleDrugs` is what made the gate silent:
  // a withheld model contributed no curve AND no notice, so the reason it was
  // withheld — the whole point of `hidden` — never reached the reader.
  const disclosedDrugs = useMemo(() => {
    return new Set(
      drugs
        .filter((d) => d.display.visible && displayResults[d.id] != null)
        .map((d) => d.id),
    );
  }, [drugs, displayResults]);

  // Legend click → toggle that drug's visibility in the store, so its curve,
  // bands, and threshold lines/labels all hide/show together (they are all
  // filtered by `visibleDrugs`). Reads fresh state to avoid a stale closure.
  const handleSeriesToggle = useCallback(
    (id: string) => {
      const cfg = useSimulatorStore.getState().drugs.find((d) => d.id === id);
      if (!cfg) return;
      updateDrugConfig(id, {
        display: { ...cfg.display, visible: !cfg.display.visible },
      });
    },
    [updateDrugConfig],
  );

  // Results whose component inputs changed since they were computed. The chart
  // dims these curves and the summary badges them "out of date" until re-run.
  const staleIds = useMemo(() => {
    return new Set(
      drugs.filter((d) => isResultStale(d, results[d.id])).map((d) => d.id),
    );
  }, [drugs, results]);

  const referenceRanges = useMemo(() => {
    const out: Record<string, ReferenceRange> = {};
    for (const d of drugs) {
      const component = drugComponentMap.get(d.drugId);
      if (!component) continue;
      // Match the (preferred-unit) display so threshold lines land on the
      // converted curve, not the drug's raw input unit.
      const targetUnit =
        curveUnitOf(displayResults[d.id]) ??
        d.inputs.concentrationUnit ??
        'mg/L';
      // Threshold overlays come exclusively from the reviewed drug parameters
      // (therapeutic/impairment/toxic/fatal concentration fields), so every line
      // on the chart is traceable to a drug-parameter DB value. The legacy
      // reference_concentrations table is intentionally not consulted here.
      const range = buildSimulatorReferenceRangeFromParameters(
        component,
        targetUnit,
        effectiveMatrix[d.id] ?? displayMatrix,
      );
      if (Object.keys(range).length > 0) out[d.id] = range;
    }
    return out;
  }, [drugs, drugComponentMap, displayResults, displayMatrix, effectiveMatrix]);

  // Postmortem distribution overlay. Built from the same per-component display
  // unit the threshold lines use, so a percentile and a therapeutic bound on
  // one axis are always in the same unit as the curve between them.
  const pmSeriesInput = useMemo<PmOverlaySeriesInput[]>(() => {
    return drugs.map((d) => {
      const component = drugComponentMap.get(d.drugId);
      return {
        seriesId: d.id,
        drugDbId: component?._dbId ?? null,
        label: d.label,
        color: d.display.color ?? '#2563eb',
        unit: curveUnitOf(displayResults[d.id]) ?? d.inputs.concentrationUnit ?? 'mg/L',
        molecularWeight: component?.molecularWeight ?? null,
        bloodPlasmaRatio: component?.bloodPlasmaRatio ?? null,
        displayMatrix: effectiveMatrix[d.id] ?? 'whole_blood',
        // Visible AND actually plotted. A component that has been added but not
        // run — or every component after `clearResults()` — has no series on
        // the chart, so its lines are dropped by the panel filter anyway; but
        // it would still put its cohort heading, statistics and warnings into
        // the controls, describing a curve that is not there. It would also
        // make `contexts.length > 1` true and prefix the ONE plotted drug's
        // lines with its name, which is the visible half of the mistake.
        visible: d.display.visible && displayResults[d.id] != null,
      };
    });
  }, [drugs, drugComponentMap, displayResults, effectiveMatrix]);

  const pmOverlay = usePmOverlay(pmSeriesInput);

  // Forensic postmortem overlay (the three "Døde" toxbase categories). Shares
  // the same per-component display unit and drug info as the PM overlay so a
  // forensic band and the curve beneath it are always in the same unit.
  const forensicSeriesInput = useMemo<ForensicOverlaySeriesInput[]>(() => {
    return drugs.map((d) => {
      const component = drugComponentMap.get(d.drugId);
      return {
        seriesId: d.id,
        drugDbId: component?._dbId ?? null,
        label: d.label,
        unit: curveUnitOf(displayResults[d.id]) ?? d.inputs.concentrationUnit ?? 'mg/L',
        molecularWeight: component?.molecularWeight ?? null,
        bloodPlasmaRatio: component?.bloodPlasmaRatio ?? null,
        displayMatrix: effectiveMatrix[d.id] ?? 'whole_blood',
        visible: d.display.visible && displayResults[d.id] != null,
      };
    });
  }, [drugs, drugComponentMap, displayResults, effectiveMatrix]);

  const forensicOverlay = useForensicOverlay(forensicSeriesInput);

  const ethanolLegalLimits: LegalLimit[] | undefined = useMemo(() => {
    const ethanolResult = Object.values(results).find(
      (result) =>
        result.engine === 'ethanol-widmark' &&
        visibleDrugs.has(result.drugConfigId),
    );
    if (!ethanolResult) return undefined;
    // Move the (whole-blood) statutory limits onto the same matrix as the
    // ethanol curve, so the curve and the limits it is compared against are
    // never on different scales.
    const factor = matrixFactors[ethanolResult.drugConfigId] ?? 1;
    const limits: LegalLimit[] = [
      {
        value: 0.02,
        color: '#ca8a04',
        label: t('modeling.workspace.ethanol.legalLimits.norway02'),
        dash: 'dash',
      },
      {
        value: 0.05,
        color: '#ea580c',
        label: t('modeling.workspace.ethanol.legalLimits.norway05'),
        dash: 'dash',
      },
      {
        value: 0.12,
        color: '#dc2626',
        label: t('modeling.workspace.ethanol.legalLimits.norway12'),
        dash: 'dash',
      },
    ];
    return factor === 1
      ? limits
      : limits.map((l) => ({ ...l, value: l.value * factor }));
  }, [results, t, visibleDrugs, matrixFactors]);

  const handleAddDrug = useCallback(
    async (component: DrugComponent) => {
      const hydrated = component._dbId
        ? await hydrateComponentByDbId(component._dbId).catch(() => component)
        : component;
      addDrug(hydrated);
      setShowSearch(false);
    },
    [addDrug, hydrateComponentByDbId],
  );

  const handleRunAll = useCallback(async () => {
    const validDrugs = drugs.filter(isDrugConfigComplete);
    if (validDrugs.length === 0) return;

    for (const drugConfig of validDrugs) {
      const component = drugComponentMap.get(drugConfig.drugId);

      setDrugRunning(drugConfig.id, true);
      try {
        const result = await runComponent(drugConfig, component, {
          runMonteCarlo: runSimulation,
          runInference,
        });
        if (
          !useSimulatorStore
            .getState()
            .drugs.some((drug) => drug.id === drugConfig.id)
        ) {
          continue;
        }
        setResult(drugConfig.id, result);
      } catch (err) {
        console.error(`Simulation failed for ${drugConfig.label}:`, err);
      } finally {
        setDrugRunning(drugConfig.id, false);
      }
    }
  }, [
    drugs,
    drugComponentMap,
    runInference,
    runSimulation,
    setResult,
    setDrugRunning,
  ]);

  const hasInputs = drugs.some(isDrugConfigComplete);

  const runDisabledReason = useMemo<string | undefined>(() => {
    if (hasInputs) return undefined;
    if (drugs.length === 0) {
      return t('modeling.workspace.simulator.blockedNoComponent');
    }
    const reasonKeys = Array.from(
      new Set(
        drugs
          .map(getRunBlockReasonKey)
          .filter((key): key is string => key != null),
      ),
    );
    // When every incomplete component is blocked for the same reason, show that
    // specific hint; otherwise fall back to a generic prompt.
    const [onlyReason] = reasonKeys;
    if (reasonKeys.length === 1 && onlyReason) return t(onlyReason);
    return t('modeling.workspace.simulator.blockedIncomplete');
  }, [drugs, hasInputs, t]);

  const getResolvedDistributions = useCallback(
    (config: DrugSimConfig) => {
      const component = drugComponentMap.get(config.drugId);
      return component
        ? {
            halfLife:
              config.overrides.halfLife ??
              rangeToDistribution(component.halfLife, 4),
            vd:
              config.overrides.vd ??
              rangeToDistribution(component.volumeOfDistribution, 50),
            f:
              config.overrides.f ??
              rangeToDistribution(component.bioavailability, 1),
          }
        : undefined;
    },
    [drugComponentMap],
  );

  const chartSeriesData = results;
  const assumptionContextEntries: SimulatorAssumptionContextEntry[] = useMemo(
    () =>
      Object.values(results).flatMap((result) => [
        {
          id: `${result.drugConfigId}-model`,
          label: drugLabels[result.drugConfigId] ?? result.drugConfigId,
          value: result.assumptions.model,
        },
      ]),
    [results, drugLabels],
  );
  const runStateMetadata: SimulatorRunStateMetadata = {
    isRunning,
    canRun: !isRunning && hasInputs,
    hasResults: Object.keys(results).length > 0,
    disabledReason: runDisabledReason,
  };
  void chartSeriesData;
  void assumptionContextEntries;

  const timelineMarkers = useMemo<TimelineMarker[]>(() => {
    const out: TimelineMarker[] = [];
    for (const d of drugs) {
      if (!d.display.visible) continue;
      const color = d.display.color ?? '#2563eb';
      for (const e of d.events) {
        if (e.t == null) continue;
        let label: string;
        if (e.type === 'dose') {
          label =
            e.amount != null
              ? `${e.amount} ${e.unit}`
              : t('simulator.events.doseLabel');
        } else if (e.type === 'measurement') {
          label =
            e.value != null
              ? `${e.value} ${e.unit}`
              : t('simulator.events.measurementLabel');
        } else {
          label = t('simulator.events.queryLabel');
        }
        out.push({
          id: `${d.id}:${e.id}`,
          configId: d.id,
          eventId: e.id,
          t: e.t,
          label,
          color,
          kind: e.type,
        });
      }
    }
    return out;
  }, [drugs, t]);

  const timelineRange = useMemo(() => {
    const resultTimes: number[] = [];
    for (const [id, r] of Object.entries(displayResults)) {
      if (!visibleDrugs.has(id)) continue;
      // Curve times are on the same absolute frame as the markers once the
      // per-result anchor is applied (see modelingAdapters), so the shared
      // window is consistent and the offset curve isn't clipped.
      const anchor = r.anchorTime ?? 0;
      for (const p of r.timeSeries) resultTimes.push(p.t + anchor);
    }
    const base = computeTimelineRange(
      timelineMarkers.map((m) => m.t),
      resultTimes,
    );
    // Trim the right edge to where the curve has meaningfully decayed (below the
    // therapeutic-min line, or ~3% of peak) so a long near-zero tail doesn't
    // squeeze the useful part of the plot. Never trim past the last marker.
    const markerMax = timelineMarkers.reduce(
      (m, mk) => (Number.isFinite(mk.t) ? Math.max(m, mk.t) : m),
      -Infinity,
    );
    let cutoffAbs = -Infinity;
    let simEndAbs = -Infinity;
    for (const [id, r] of Object.entries(displayResults)) {
      if (!visibleDrugs.has(id) || r.timeSeries.length === 0) continue;
      const anchor = r.anchorTime ?? 0;
      const peak = Math.max(...r.timeSeries.map((p) => p.median));
      // `displayResults` points are whole blood (unit-only); `referenceRanges`
      // is matrix-scaled by the same per-series factor the curve uses. Uniform
      // scaling cannot move a crossing time, so undo it here — compare a
      // whole-blood threshold against whole-blood points, keeping the trim
      // matrix-invariant instead of drifting with B/P.
      const rawTherapeuticMin = referenceRanges[id]?.therapeutic?.min;
      const factor = matrixFactors[id] ?? 1;
      const therapeuticMin =
        typeof rawTherapeuticMin === 'number' && Number.isFinite(rawTherapeuticMin)
          ? rawTherapeuticMin / factor
          : undefined;
      const threshold = Math.max(
        typeof therapeuticMin === 'number' ? therapeuticMin : 0,
        0.03 * peak,
      );
      let lastAbove = r.timeSeries[0]!.t;
      for (const p of r.timeSeries) {
        if (p.median > threshold) lastAbove = p.t;
      }
      cutoffAbs = Math.max(cutoffAbs, lastAbove + anchor);
      simEndAbs = Math.max(
        simEndAbs,
        r.timeSeries[r.timeSeries.length - 1]!.t + anchor,
      );
    }
    if (!Number.isFinite(cutoffAbs) || !Number.isFinite(simEndAbs)) return base;
    const pad = Math.max(0.5, (cutoffAbs - base.from) * 0.05);
    const floor = Number.isFinite(markerMax) ? markerMax + pad : base.from + 1;
    const to = Math.min(simEndAbs, Math.max(cutoffAbs + pad, floor));
    return { from: base.from, to: Math.max(to, base.from + 1) };
  }, [timelineMarkers, displayResults, visibleDrugs, referenceRanges, matrixFactors]);

  // Tmax guide lines: the time of maximum median concentration per visible
  // component, on the absolute frame. Suppressed when the peak sits at the
  // curve's start (instantaneous absorption / decay-only) since the line would
  // just duplicate the dose guide.
  const tmaxMarkers = useMemo(
    () =>
      Object.entries(displayResults).flatMap(([id, r]) => {
        if (!visibleDrugs.has(id) || r.timeSeries.length === 0) return [];
        let bestT = r.timeSeries[0]!.t;
        let bestV = r.timeSeries[0]!.median;
        for (const p of r.timeSeries) {
          if (p.median > bestV) {
            bestV = p.median;
            bestT = p.t;
          }
        }
        if (bestT < 0.05 || bestV <= 0) return [];
        return [
          {
            x: bestT + (r.anchorTime ?? 0),
            color: drugColors[id] ?? '#2563eb',
            label: t('simulator.referenceLines.tmax'),
            componentId: id,
          },
        ];
      }),
    [displayResults, visibleDrugs, drugColors, t],
  );
  // Shared window that keeps the chart's x-axis and the event timeline in
  // lockstep: same span, same ticks, and a vertical guide line per event. Only
  // set when a timeline is actually shown, so the chart keeps auto-ranging to
  // its data otherwise.
  const timeAxis =
    timelineMarkers.length > 0
      ? {
          from: timelineRange.from,
          to: timelineRange.to,
          markers: timelineMarkers.map((m) => ({
            t: m.t,
            color: m.color,
            label: m.label,
          })),
          curveMarkers: tmaxMarkers,
        }
      : undefined;

  const timeline =
    timelineMarkers.length > 0 ? (
      <EventTimeline
        markers={timelineMarkers}
        fromHour={timelineRange.from}
        toHour={timelineRange.to}
        timeFormat={displaySettings.timeFormat}
        referenceTime={displaySettings.referenceTime}
        activeMarkerId={selectedMarkerId}
        onMarkerSelect={(marker) => setSelectedMarkerId(marker.id)}
        onMarkerTimeChange={(marker, nextHour) => {
          setSelectedMarkerId(marker.id);
          const event = drugs
            .find((d) => d.id === marker.configId)
            ?.events.find((e) => e.id === marker.eventId);
          // KineLab dose inference reads the intake window from `tRange`, so
          // shift the whole window by the drag delta — otherwise the marker
          // moves while the engine keeps using the stale window.
          const updates: Partial<SimEvent> =
            event?.type === 'dose' && event.tRange
              ? {
                  t: nextHour,
                  tRange: [
                    event.tRange[0] + (nextHour - (event.t ?? nextHour)),
                    event.tRange[1] + (nextHour - (event.t ?? nextHour)),
                  ],
                }
              : { t: nextHour };
          updateEvent(marker.configId, marker.eventId, updates);
        }}
      />
    ) : null;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
      <div className="min-w-0 space-y-4 xl:col-span-2">
        <SimulatorModelingResults
          results={displayResults}
          drugLabels={drugLabels}
          drugColors={drugColors}
          drugMolecularWeights={drugMolecularWeights}
          drugDbIds={drugDbIds}
          bloodPlasmaRatios={curveBloodPlasmaRatios}
          resultGrades={resultGrades}
          visibleDrugs={visibleDrugs}
          disclosedDrugs={disclosedDrugs}
          onAcknowledgeModel={handleAcknowledgeModel}
          onWithdrawModelAcknowledgement={handleWithdrawModelAcknowledgement}
          acknowledgedDrugs={acknowledgedDrugs}
          displaySettings={displaySettings}
          referenceRanges={referenceRanges}
          legalLimits={ethanolLegalLimits}
          pmOverlay={pmOverlay}
          forensicOverlay={forensicOverlay}
          staleIds={staleIds}
          onToggleMode={() =>
            setDisplaySettings({
              mode: displaySettings.mode === 'overlay' ? 'separate' : 'overlay',
            })
          }
          onSeriesToggle={handleSeriesToggle}
          displayMatrix={displayMatrix}
          onDisplayMatrixChange={(m) => setDisplaySettings({ displayMatrix: m })}
          matrixFactors={matrixFactors}
          matrixConverted={anyMatrixConverted}
          matrixConversionUnavailableFor={matrixConversionUnavailableFor}
          onRunAll={handleRunAll}
          onExport={() => {
            const text = exportSummaryText(
              caseName,
              results,
              drugLabels,
              t,
              resultGrades,
            );
            downloadTextFile(text, 'simulation_summary.txt');
          }}
          onToggleSettings={() => setShowSettings(!showSettings)}
          runState={runStateMetadata}
          timeline={timeline}
          timeAxis={timeAxis}
        />
      </div>

      <aside className="min-w-0 xl:col-span-1">
        <div className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span>{t('simulator.events.componentsTitle')}</span>
          <div className="h-px flex-1 bg-border" />
        </div>
        <SimulatorModelingRail
          showSettings={showSettings}
          displaySettings={displaySettings}
          setDisplaySettings={setDisplaySettings}
          drugs={drugs}
          drugComponentMap={drugComponentMap}
          getResolvedDistributions={getResolvedDistributions}
          showSearch={showSearch}
          setShowSearch={setShowSearch}
          onAddDrug={handleAddDrug}
          selectedMarkerId={selectedMarkerId}
        />
      </aside>
    </div>
  );
}
