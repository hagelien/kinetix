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

  it('withdraws a model whose drug is no longer in the catalogue', async () => {
    const { refreshLiveDerivedModel, core } = await load();
    expect(core.resolveModel('alprazolam')).toBeDefined();
    await refreshLiveDerivedModel('alprazolam', answer({ error: 'No drug with that slug' }, 404), 0);
    expect(core.resolveModel('alprazolam')).toBeUndefined();
  });

  it('keeps the committed model when the server cannot answer', async () => {
    const { refreshLiveDerivedModel, LIVE_MODEL_TTL_MS, core } = await load();
    const before = core.resolveModel('alprazolam');
    await refreshLiveDerivedModel('alprazolam', answer({ error: 'down' }, 503), 0);
    await refreshLiveDerivedModel('alprazolam', vi.fn(async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch, LIVE_MODEL_TTL_MS);
    expect(core.resolveModel('alprazolam')).toEqual(before);
    expect(core.liveDerivedEntry('alprazolam')).toBeUndefined();
  });

  it('keeps the last live answer, not the committed model, when a later refresh fails', async () => {
    const { refreshLiveDerivedModel, LIVE_MODEL_TTL_MS, core } = await load();
    const committed = core.resolveModel('alprazolam');
    const { definition, grade } = committedAlprazolam();
    definition.routes.oral.eliminationHalfLifeHours = { kind: 'fixed', value: 30 };
    await refreshLiveDerivedModel('alprazolam', answer({ status: 'assembled', definition, grade }), 0);
    const live = core.resolveModel('alprazolam');
    expect(live).not.toEqual(committed);

    const failures: (typeof fetch)[] = [
      answer({ error: 'down' }, 503),
      answer({ status: 'something-else' }),
      vi.fn(async () => {
        throw new TypeError('offline');
      }) as unknown as typeof fetch,
    ];
    for (const [i, failing] of failures.entries()) {
      await refreshLiveDerivedModel('alprazolam', failing, (i + 1) * LIVE_MODEL_TTL_MS);
      expect(failing).toHaveBeenCalledTimes(1);
      expect(core.resolveModel('alprazolam')).toEqual(live);
    }
  });

  it('keeps a live withdrawal in force through an outage, so the committed model does not return', async () => {
    const { refreshLiveDerivedModel, LIVE_MODEL_TTL_MS, core } = await load();
    expect(core.resolveModel('alprazolam')).toBeDefined();
    await refreshLiveDerivedModel('alprazolam', answer({ status: 'not-modelable', entry: {} }), 0);
    expect(core.resolveModel('alprazolam')).toBeUndefined();

    const down = answer({ error: 'down' }, 503);
    await refreshLiveDerivedModel('alprazolam', down, LIVE_MODEL_TTL_MS);
    expect(down).toHaveBeenCalledTimes(1);
    expect(core.resolveModel('alprazolam')).toBeUndefined();
    expect(core.liveDerivedEntry('alprazolam')).toEqual({ analyte: 'alprazolam', definition: null, grade: null });
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

  it('asks again only once the answer, or a failure, has aged out', async () => {
    const { refreshLiveDerivedModel, LIVE_MODEL_TTL_MS } = await load();
    const ok = answer({ status: 'not-modelable', entry: {} });
    await refreshLiveDerivedModel('alprazolam', ok, 0);
    await refreshLiveDerivedModel('alprazolam', ok, LIVE_MODEL_TTL_MS - 1);
    expect(ok).toHaveBeenCalledTimes(1);
    await refreshLiveDerivedModel('alprazolam', ok, LIVE_MODEL_TTL_MS);
    expect(ok).toHaveBeenCalledTimes(2);

    // A failure is trusted for the same window (#292): asking again inside it could install a
    // model whose routes the picker, built on the failure's fallback, never offered.
    const failing = answer({}, 500);
    await refreshLiveDerivedModel('diazepam', failing, 0);
    await refreshLiveDerivedModel('diazepam', failing, LIVE_MODEL_TTL_MS - 1);
    expect(failing).toHaveBeenCalledTimes(1);
    await refreshLiveDerivedModel('diazepam', failing, LIVE_MODEL_TTL_MS);
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

describe('the picker’s view of the live answer (#292)', () => {
  it('waits on a derived slug until its first live answer settles, then tells subscribers', async () => {
    const { refreshLiveDerivedModel, awaitingLiveDerivedModel, subscribeLiveDerivedModels, liveDerivedModelsVersion } =
      await load();
    const listener = vi.fn();
    const unsubscribe = subscribeLiveDerivedModels(listener);
    expect(awaitingLiveDerivedModel('alprazolam')).toBe(true);

    const before = liveDerivedModelsVersion();
    await refreshLiveDerivedModel('alprazolam', answer({ status: 'not-modelable', entry: {} }), 0);
    expect(awaitingLiveDerivedModel('alprazolam')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(liveDerivedModelsVersion()).toBeGreaterThan(before);

    unsubscribe();
    await refreshLiveDerivedModel('diazepam', answer({ status: 'not-modelable', entry: {} }), 0);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops waiting after a failed request too, since the run then falls back to the same model', async () => {
    const { refreshLiveDerivedModel, awaitingLiveDerivedModel } = await load();
    await refreshLiveDerivedModel('alprazolam', answer({ error: 'down' }, 503), 0);
    expect(awaitingLiveDerivedModel('alprazolam')).toBe(false);
  });

  it('notifies again only when a later answer changes what is installed', async () => {
    const { refreshLiveDerivedModel, subscribeLiveDerivedModels, LIVE_MODEL_TTL_MS } = await load();
    const { definition, grade } = committedAlprazolam();
    const listener = vi.fn();
    subscribeLiveDerivedModels(listener);
    await refreshLiveDerivedModel('alprazolam', answer({ status: 'assembled', definition, grade }), 0);
    expect(listener).toHaveBeenCalledTimes(1);
    // The same answer again (a run after the TTL): nothing changed, nothing to re-render.
    await refreshLiveDerivedModel('alprazolam', answer({ status: 'assembled', definition, grade }), LIVE_MODEL_TTL_MS);
    expect(listener).toHaveBeenCalledTimes(1);
    // A withdrawal changes the installed model: the picker must hear about it.
    await refreshLiveDerivedModel('alprazolam', answer({ status: 'not-modelable', entry: {} }), 2 * LIVE_MODEL_TTL_MS);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('never waits for a reviewed analyte, a missing slug, or with the derived tier off', async () => {
    const { awaitingLiveDerivedModel } = await load();
    expect(awaitingLiveDerivedModel('ethanol')).toBe(false);
    expect(awaitingLiveDerivedModel(undefined)).toBe(false);

    vi.resetModules();
    vi.unstubAllEnvs();
    const off = await load(false);
    expect(off.awaitingLiveDerivedModel('alprazolam')).toBe(false);
  });

  it('says when the trusted outcome ages out, so an open panel can ask again then (#299)', async () => {
    const { refreshLiveDerivedModel, liveDerivedModelExpiresAt, LIVE_MODEL_TTL_MS } = await load();
    expect(liveDerivedModelExpiresAt('alprazolam')).toBeUndefined();
    await refreshLiveDerivedModel('alprazolam', answer({ error: 'down' }, 503), 1_000);
    expect(liveDerivedModelExpiresAt('alprazolam')).toBe(1_000 + LIVE_MODEL_TTL_MS);
    // A slug that is never fetched has nothing to wait for, so a panel does not keep re-arming.
    expect(liveDerivedModelExpiresAt('ethanol')).toBeUndefined();
    expect(liveDerivedModelExpiresAt(undefined)).toBeUndefined();
  });
});

/**
 * #292 review — every way the panel's request and the run's can interleave must leave the picker
 * and the run on the same model. The panel asks on mount; the run asks again before it resolves.
 */
describe('picker and run interleavings (#292)', () => {
  it('a run after the panel’s failed request resolves the same fallback, without retrying', async () => {
    const { refreshLiveDerivedModel, awaitingLiveDerivedModel, LIVE_MODEL_TTL_MS, core } = await load();
    const committed = core.resolveModel('alprazolam');
    // The panel's request fails: the picker stops waiting and is built on the committed model.
    await refreshLiveDerivedModel('alprazolam', answer({ error: 'down' }, 503), 0);
    expect(awaitingLiveDerivedModel('alprazolam')).toBe(false);

    // The run inside the window would get a changed model if it asked; it must not ask.
    const { definition, grade } = committedAlprazolam();
    definition.routes = { subcutaneous: definition.routes.oral };
    const changed = answer({ status: 'assembled', definition, grade });
    await refreshLiveDerivedModel('alprazolam', changed, LIVE_MODEL_TTL_MS - 1);
    expect(changed).not.toHaveBeenCalled();
    expect(core.resolveModel('alprazolam')).toEqual(committed);
  });

  it('a run started while the panel’s request is in flight joins it rather than asking again', async () => {
    const { refreshLiveDerivedModel, awaitingLiveDerivedModel, core } = await load();
    const { definition, grade } = committedAlprazolam();
    definition.routes.oral.eliminationHalfLifeHours = { kind: 'fixed', value: 30 };
    let respond!: (res: Response) => void;
    const slow = vi.fn(
      (_url: string) =>
        new Promise<Response>((resolve) => {
          respond = resolve;
        }),
    ) as unknown as typeof fetch;
    const panel = refreshLiveDerivedModel('alprazolam', slow, 0);
    const other = answer({ error: 'down' }, 503);
    const run = refreshLiveDerivedModel('alprazolam', other, 1);
    expect(awaitingLiveDerivedModel('alprazolam')).toBe(true);
    respond(new Response(JSON.stringify({ status: 'assembled', definition, grade }), { status: 200 }));
    await Promise.all([panel, run]);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(core.liveDerivedEntry('alprazolam')?.definition?.routes.oral).toEqual(definition.routes.oral);
  });

  it('a later run whose answer changes the model tells the picker before the run resolves', async () => {
    const { refreshLiveDerivedModel, subscribeLiveDerivedModels, LIVE_MODEL_TTL_MS, core } = await load();
    await refreshLiveDerivedModel('alprazolam', answer({ error: 'down' }, 503), 0);
    const seen: (string[] | undefined)[] = [];
    subscribeLiveDerivedModels(() => {
      const model = core.resolveModel('alprazolam');
      seen.push(model ? Object.keys(model.routes) : undefined);
    });

    const { definition, grade } = committedAlprazolam();
    definition.routes = { subcutaneous: definition.routes.oral };
    await refreshLiveDerivedModel('alprazolam', answer({ status: 'assembled', definition, grade }), LIVE_MODEL_TTL_MS);
    // The picker heard of the new model, and read it, before the run went on to resolve it.
    expect(seen).toEqual([['subcutaneous']]);
  });
});
