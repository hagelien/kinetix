/**
 * #81 — the simulator offers the routes the resolved model declares, and only those.
 *
 * Before this the dose-route picker was a fixed five (`iv | oral | insufflation | inhalation |
 * other`), so a model declared for `im`, `sublingual` or `rectal` existed in the engine and could
 * not be selected, while a route the model lacked was offered and then refused at run time.
 */
import { describe, expect, it } from 'vitest';
import { ROUTE_IDS } from '@/lib/kinetics-core';
import { modeledSimulatorRoutes, toCanonicalScenario } from '@/lib/forwardCoreAdapter';
import { offeredDoseRoutes } from '@/lib/modelingRun';
import {
  LEGACY_SIMULATOR_ROUTES,
  SIMULATOR_ROUTES,
  coreRouteFor,
  simulatorRouteFor,
} from '@/lib/simulatorRoutes';
import type { DrugSimConfig } from '@/types/simulator';

function config(overrides: Partial<DrugSimConfig> = {}): DrugSimConfig {
  return {
    id: 'cfg1',
    drugId: 'drug1',
    drugName: 'Ketamine',
    label: 'Ketamine',
    events: [],
    route: 'oral',
    questionMode: 'concentration-from-dose',
    inputs: {},
    overrides: {},
    display: { visible: true },
    ...overrides,
  };
}

describe('simulator route vocabulary', () => {
  it('names every core route, renaming only intranasal to insufflation', () => {
    expect(SIMULATOR_ROUTES).toHaveLength(ROUTE_IDS.length);
    for (const id of ROUTE_IDS) {
      const route = simulatorRouteFor(id);
      expect(coreRouteFor(route)).toBe(id);
      expect(route).toBe(id === 'intranasal' ? 'insufflation' : id);
    }
  });

  it('includes the subcutaneous, transdermal and buccal routes', () => {
    expect(SIMULATOR_ROUTES).toEqual(
      expect.arrayContaining(['subcutaneous', 'transdermal', 'buccal']),
    );
  });
});

describe('modeledSimulatorRoutes', () => {
  it("offers a model's IM route, which the fixed picker never reached", () => {
    // ketamine's reviewed model declares intranasal, IM and oral — and no IV.
    expect(modeledSimulatorRoutes('ketamine')).toEqual(['oral', 'insufflation', 'im']);
  });

  it("offers a sublingual-only model's one route", () => {
    expect(modeledSimulatorRoutes('lsd')).toEqual(['sublingual']);
  });

  it('keeps the insufflation → intranasal mapping', () => {
    expect(modeledSimulatorRoutes('cocaine')).toContain('insufflation');
    expect(modeledSimulatorRoutes('cocaine')).not.toContain('intranasal');
  });

  it('resolves nothing for an analyte with no model', () => {
    expect(modeledSimulatorRoutes('not-a-registered-analyte')).toBeUndefined();
  });

  it('offers only routes the engine accepts', () => {
    for (const analyte of ['ketamine', 'lsd', 'cocaine']) {
      for (const route of modeledSimulatorRoutes(analyte)!) {
        const built = toCanonicalScenario({
          analyte,
          route,
          subject: { weightKg: 70 },
          doses: [{ amountMg: 1, tHours: 0 }],
          timeRange: { start: 0, end: 12, steps: 12 },
        });
        expect(built.ok, `${analyte} / ${route}`).toBe(true);
      }
    }
  });
});

describe('offeredDoseRoutes', () => {
  it("offers a Monte Carlo component exactly its model's routes", () => {
    const routes = offeredDoseRoutes(config(), undefined);
    expect(routes).toEqual(['oral', 'insufflation', 'im']);
    // A route the model does not declare is not offered.
    expect(routes).not.toContain('iv');
  });

  it('keeps the legacy list for a drug with no resolved model', () => {
    expect(
      offeredDoseRoutes(config({ drugName: 'Unmodelled', label: 'Unmodelled' }), undefined),
    ).toEqual(LEGACY_SIMULATOR_ROUTES);
  });

  it('keeps the legacy list for an engine that runs no core model', () => {
    expect(offeredDoseRoutes(config({ engine: 'kinelab-bayes' }), undefined)).toEqual(
      LEGACY_SIMULATOR_ROUTES,
    );
  });
});
