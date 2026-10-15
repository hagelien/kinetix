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
  const { offeredDoseRoutes, runComponent } = await import('@/lib/modelingRun');
  const live = await import('@/lib/liveDerivedModels');
  useSimulatorStore.setState({
    drugs: [config],
    results: {},
    runningDrugIds: new Set(),
    isRunning: false,
  });
  return { DrugPanel, useSimulatorStore, offeredDoseRoutes, runComponent, live };
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

// Each test imports the panel's module graph afresh (the live overlay and fetch cache are module
// state), which alone can take seconds on a loaded runner.
describe('DrugPanel dose-route picker under the live derived tier (#292)', { timeout: 30_000 }, () => {
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

  it('a run after the panel’s failed request does not retry into a model the picker never offered', async () => {
    // The panel's request fails; the server is back by the time the user runs, and now builds an
    // SC-only model. Retrying inside the window would refuse the dose the picker just allowed.
    let serverUp = false;
    const fetchImpl = vi.fn(async (_url: string) =>
      serverUp
        ? new Response(JSON.stringify(subcutaneousOnlyAnswer()), { status: 200 })
        : new Response(JSON.stringify({ error: 'down' }), { status: 503 }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const { DrugPanel, useSimulatorStore, offeredDoseRoutes, runComponent } = await load();
    render(
      <DrugPanel config={config} drugComponent={drug} timeFormat="hours" referenceTime="00:00" />,
    );
    const addDose = screen.getByRole('button', { name: 'simulator.events.addDose' });
    await waitFor(() => expect(addDose).not.toBeDisabled());
    fireEvent.click(addDose);
    const withDose = useSimulatorStore.getState().drugs[0]!;
    const route = (withDose.events[0] as { route: string }).route;
    expect(offeredDoseRoutes(withDose, drug)).toContain(route);

    serverUp = true;
    const runMonteCarlo = vi.fn(async () => {
      throw new Error('not under test');
    });
    await runComponent(withDose, drug, { runMonteCarlo }).catch(() => undefined);
    // The run trusted the panel's failure for the window: one request in all, and the dose's route
    // is still one the model the run resolved declares.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(offeredDoseRoutes(withDose, drug)).toContain(route);
  });

  it('redraws the picker when a later refresh changes the model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(subcutaneousOnlyAnswer()), { status: 200 })),
    );
    const { DrugPanel, live } = await load();
    const dosed: DrugSimConfig = {
      ...config,
      events: [{ id: 'd1', type: 'dose', t: 0, amount: 10, unit: 'mg', route: 'subcutaneous' }],
    };
    render(
      <DrugPanel config={dosed} drugComponent={drug} timeFormat="hours" referenceTime="00:00" />,
    );
    await waitFor(() =>
      expect(screen.getByTitle('parameters.route.subcutaneous')).toBeInTheDocument(),
    );
    expect(screen.queryByTitle('simulator.routes.notModeled')).toBeNull();

    // A run after the window gets a model that no longer declares subcutaneous.
    const oralOnly = subcutaneousOnlyAnswer();
    oralOnly.definition.routes = { oral: oralOnly.definition.routes.subcutaneous };
    oralOnly.grade.routes = oralOnly.grade.routes.map((r: { route: string }) => ({ ...r, route: 'oral' }));
    await act(async () => {
      await live.refreshLiveDerivedModel(
        SLUG,
        vi.fn(async () => new Response(JSON.stringify(oralOnly), { status: 200 })) as unknown as typeof fetch,
        Date.now() + live.LIVE_MODEL_TTL_MS,
      );
    });
    // The picker now offers what the run resolves, and marks the dose's route as undeclared.
    expect(screen.getByTitle('simulator.routes.notModeled')).toBeInTheDocument();
    expect(screen.getByTitle('parameters.route.oral')).toBeInTheDocument();
  });

  it('asks again when the window ends while the panel stays open, so the picker drops a route the catalogue dropped (#299)', async () => {
    const oralOnly = subcutaneousOnlyAnswer();
    oralOnly.definition.routes = { oral: oralOnly.definition.routes.subcutaneous };
    oralOnly.grade.routes = oralOnly.grade.routes.map((r: { route: string }) => ({ ...r, route: 'oral' }));
    let answer: unknown = subcutaneousOnlyAnswer();
    const fetchImpl = vi.fn(async (_url: string) => new Response(JSON.stringify(answer), { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);
    const { DrugPanel, offeredDoseRoutes, live } = await load();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const dosed: DrugSimConfig = {
        ...config,
        events: [{ id: 'd1', type: 'dose', t: 0, amount: 10, unit: 'mg', route: 'subcutaneous' }],
      };
      const { unmount } = render(
        <DrugPanel config={dosed} drugComponent={drug} timeFormat="hours" referenceTime="00:00" />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(screen.getByTitle('parameters.route.subcutaneous')).toBeInTheDocument();
      expect(screen.queryByTitle('simulator.routes.notModeled')).toBeNull();

      // The catalogue drops subcutaneous. Inside the window nothing asks again.
      answer = oralOnly;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(live.LIVE_MODEL_TTL_MS - 1);
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(offeredDoseRoutes(config, drug)).toEqual(['subcutaneous']);

      // The window ends with the panel still open and no run: the panel asks again on its own, and
      // the picker now offers what the next run will resolve.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(offeredDoseRoutes(config, drug)).toEqual(['oral']);
      expect(screen.getByTitle('simulator.routes.notModeled')).toBeInTheDocument();
      expect(screen.getByTitle('parameters.route.oral')).toBeInTheDocument();

      // It keeps following the catalogue while open, and stops once the panel is closed.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(live.LIVE_MODEL_TTL_MS);
      });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      unmount();
      await vi.advanceTimersByTimeAsync(live.LIVE_MODEL_TTL_MS * 3);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
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
