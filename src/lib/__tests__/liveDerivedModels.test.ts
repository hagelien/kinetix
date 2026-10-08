import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERATED_REGISTRY_ARTIFACT } from '@/lib/kinetics-core/generated-registry';

/**
 * The app-side live fetch. Fresh module graph per test: the rollout flag is read from
 * `import.meta.env`, and the fetch cache and the live overlay are module state.
 */
async function load(flag = true) {
  if (flag) vi.stubEnv('VITE_DERIVED_REGISTRY_ENABLED', 'true');
  const live = await import('../liveDerivedModels');
  const core = await import('@/lib/kinetics-core');
  return { ...live, core };
}

function committedAlprazolam() {
  const definition = GENERATED_REGISTRY_ARTIFACT.derivedDefinitions.find((d) => d.analyte === 'alprazolam')!;
  const grade = GENERATED_REGISTRY_ARTIFACT.derivedGrades.find((g) => g.analyte === 'alprazolam')!;
  return JSON.parse(JSON.stringify({ definition, grade }));
}

function answer(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('refreshLiveDerivedModel', () => {
  it('lays the catalogue’s current model over the committed one', async () => {
    const { refreshLiveDerivedModel, core } = await load();
    const { definition, grade } = committedAlprazolam();
    definition.routes.oral.eliminationHalfLifeHours = { kind: 'fixed', value: 30 };
    const fetchImpl = answer({ status: 'assembled', definition, grade });

    await refreshLiveDerivedModel('alprazolam', fetchImpl, 0);

    expect(fetchImpl).toHaveBeenCalledWith('/api/derived-model?slug=alprazolam', expect.anything());
    const oral = core.resolveModel('alprazolam')?.routes.oral as unknown as Record<string, unknown>;
    expect(oral.eliminationHalfLifeHours).toEqual({ kind: 'fixed', value: 30 });
  });

  it('withdraws a model the catalogue no longer builds', async () => {
    const { refreshLiveDerivedModel, core } = await load();
    await refreshLiveDerivedModel('alprazolam', answer({ status: 'not-modelable', entry: {} }), 0);
    expect(core.resolveModel('alprazolam')).toBeUndefined();
  });

  it('keeps the committed model when the server cannot answer', async () => {
    const { refreshLiveDerivedModel, core } = await load();
    const before = core.resolveModel('alprazolam');
    await refreshLiveDerivedModel('alprazolam', answer({ error: 'down' }, 503), 0);
    await refreshLiveDerivedModel('alprazolam', vi.fn(async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch, 1);
    expect(core.resolveModel('alprazolam')).toEqual(before);
    expect(core.liveDerivedEntry('alprazolam')).toBeUndefined();
  });

  it('gives up on a server that does not answer in time, keeping the committed model', async () => {
    vi.useFakeTimers();
    try {
      const { refreshLiveDerivedModel, LIVE_MODEL_TIMEOUT_MS, core } = await load();
      const hanging = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      ) as unknown as typeof fetch;
      const pending = refreshLiveDerivedModel('alprazolam', hanging, 0);
      await vi.advanceTimersByTimeAsync(LIVE_MODEL_TIMEOUT_MS);
      await pending;
      expect(core.liveDerivedEntry('alprazolam')).toBeUndefined();
      expect(core.resolveModel('alprazolam')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores an answer that is not a model for the slug it asked about', async () => {
    const { refreshLiveDerivedModel, core } = await load();
    const { definition, grade } = committedAlprazolam();
    await refreshLiveDerivedModel('diazepam', answer({ status: 'assembled', definition, grade }), 0);
    expect(core.liveDerivedEntry('diazepam')).toBeUndefined();
  });

  it('asks again only once the answer has aged out, and retries after a failure', async () => {
    const { refreshLiveDerivedModel, LIVE_MODEL_TTL_MS } = await load();
    const ok = answer({ status: 'not-modelable', entry: {} });
    await refreshLiveDerivedModel('alprazolam', ok, 0);
    await refreshLiveDerivedModel('alprazolam', ok, LIVE_MODEL_TTL_MS - 1);
    expect(ok).toHaveBeenCalledTimes(1);
    await refreshLiveDerivedModel('alprazolam', ok, LIVE_MODEL_TTL_MS);
    expect(ok).toHaveBeenCalledTimes(2);

    const failing = answer({}, 500);
    await refreshLiveDerivedModel('diazepam', failing, 0);
    await refreshLiveDerivedModel('diazepam', failing, 1);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('never fetches a reviewed analyte, a missing slug, or with the derived tier off', async () => {
    const { refreshLiveDerivedModel } = await load();
    const fetchImpl = answer({ status: 'reviewed' });
    await refreshLiveDerivedModel('ethanol', fetchImpl, 0);
    await refreshLiveDerivedModel(undefined, fetchImpl, 0);
    expect(fetchImpl).not.toHaveBeenCalled();

    vi.resetModules();
    vi.unstubAllEnvs();
    const off = await load(false);
    await off.refreshLiveDerivedModel('alprazolam', fetchImpl, 0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('withLiveDerived', () => {
  it('carries the main thread’s live answers to the worker with each run', async () => {
    vi.stubEnv('VITE_DERIVED_REGISTRY_ENABLED', 'true');
    const { withLiveDerived } = await import('@/workers/useMonteCarloWorker');
    const core = await import('@/lib/kinetics-core');
    const config = { drugConfigId: 'x', scenario: {} as never };
    expect(withLiveDerived(config)).toBe(config);

    core.installLiveDerivedEntry({ analyte: 'alprazolam', definition: null, grade: null });
    expect(withLiveDerived(config).liveDerived).toEqual([
      { analyte: 'alprazolam', definition: null, grade: null },
    ]);
  });
});
