/**
 * #292 — under the derived-registry rollout the dose-route picker must resolve the same (live) model
 * the run will. The run refreshes the live derived model before it resolves anything; a picker read
 * straight off the registry showed the committed snapshot's routes until after the first run, so a
 * drug the catalogue now models (here: a subcutaneous-only one the snapshot lacks) started its first
 * dose on a legacy route the refreshed model then refused.
 *
 * Fresh module graph per test: the rollout flag is read from `import.meta.env`, and the fetch cache
 * and the live overlay are module state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GENERATED_REGISTRY_ARTIFACT } from '@/lib/kinetics-core/generated-registry';
import type { DrugComponent } from '@/types';
import type { DrugSimConfig } from '@/types/simulator';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}));

const SLUG = 'live-sc-drug';

const drug: DrugComponent = {
  id: '990001',
  _slug: SLUG,
  names: { en: 'Live SC Drug', nb: 'Live SC Drug' },
  molecularWeight: 300,
};

const config: DrugSimConfig = {
  id: 'config-live',
  drugId: '990001',
  drugName: 'Live SC Drug',
  label: 'Live SC Drug',
  events: [],
  route: 'oral',
  questionMode: 'concentration-from-dose',
  inputs: {},
  overrides: {},
  display: { visible: true, color: '#2563eb' },
};

/** What the server builds now: a committed model's parameters under a new slug, declared for the
 *  subcutaneous route only — a drug the committed artifact does not have at all. */
function subcutaneousOnlyAnswer() {
  const committed = JSON.parse(
    JSON.stringify({
      definition: GENERATED_REGISTRY_ARTIFACT.derivedDefinitions.find((d) => d.analyte === 'alprazolam'),
      grade: GENERATED_REGISTRY_ARTIFACT.derivedGrades.find((g) => g.analyte === 'alprazolam'),
    }),
  );
  return {
    status: 'assembled',
    definition: {
      ...committed.definition,
      analyte: SLUG,
      modelId: `${SLUG}-derived-v1`,
      displayName: 'Live SC Drug',
      aliases: [],
      routes: { subcutaneous: committed.definition.routes.oral },
    },
    grade: {
      ...committed.grade,
      analyte: SLUG,
      routes: committed.grade.routes
        .filter((r: { route: string }) => r.route === 'oral')
        .map((r: { route: string }) => ({ ...r, route: 'subcutaneous' })),
    },
  };
}

async function load() {
  vi.stubEnv('VITE_DERIVED_REGISTRY_ENABLED', 'true');
  const { DrugPanel } = await import('./DrugPanel');
  const { useSimulatorStore } = await import('@/stores/simulatorStore');
  const { offeredDoseRoutes } = await import('@/lib/modelingRun');
  useSimulatorStore.setState({
    drugs: [config],
    results: {},
    runningDrugIds: new Set(),
    isRunning: false,
  });
  return { DrugPanel, useSimulatorStore, offeredDoseRoutes };
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('DrugPanel dose-route picker under the live derived tier (#292)', () => {
  it('loads the live model before a dose can be added, and starts it on a route that model declares', async () => {
    let respond!: (res: Response) => void;
    const fetchImpl = vi.fn(
      (_url: string) =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const { DrugPanel, useSimulatorStore, offeredDoseRoutes } = await load();

    // The committed snapshot does not know the drug: on its own the picker would offer the legacy
    // list, and a new dose would start on oral.
    expect(offeredDoseRoutes(config, drug)).not.toContain('subcutaneous');

    render(
      <DrugPanel config={config} drugComponent={drug} timeFormat="hours" referenceTime="00:00" />,
    );

    // The panel asked for the live model on mount, not only once the user runs.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain(`slug=${SLUG}`);
    const addDose = screen.getByRole('button', { name: 'simulator.events.addDose' });
    expect(addDose).toBeDisabled();

    await act(async () => {
      respond(new Response(JSON.stringify(subcutaneousOnlyAnswer()), { status: 200 }));
    });

    await waitFor(() => expect(addDose).not.toBeDisabled());
    expect(offeredDoseRoutes(config, drug)).toEqual(['subcutaneous']);

    fireEvent.click(addDose);
    const events = useSimulatorStore.getState().drugs[0]!.events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'dose', route: 'subcutaneous' });
  });

  it('lets a dose be added once the live request fails, on the model the run falls back to', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'down' }), { status: 503 })),
    );
    const { DrugPanel } = await load();
    render(
      <DrugPanel config={config} drugComponent={drug} timeFormat="hours" referenceTime="00:00" />,
    );
    const addDose = screen.getByRole('button', { name: 'simulator.events.addDose' });
    await waitFor(() => expect(addDose).not.toBeDisabled());
  });

  it('does not hold back a dose for an engine that runs no registry model', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const { DrugPanel } = await load();
    render(
      <DrugPanel
        config={{ ...config, engine: 'kinelab-bayes' }}
        drugComponent={drug}
        timeFormat="hours"
        referenceTime="00:00"
      />,
    );
    expect(screen.getByRole('button', { name: 'simulator.events.addDose' })).not.toBeDisabled();
  });
});
