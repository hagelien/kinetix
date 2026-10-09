/**
 * #321 follow-up: tests for the favorite-toggle serialization +
 * error semantics added in response to Codex review on #333.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore, type AuthUser } from './authStore';
import { useBasketStore } from './basketStore';
import { useDrugStore } from './drugStore';
import { useSimulatorStore } from './simulatorStore';
import { useAppStore } from './appStore';
import { usePatternCaseStore } from './patternCaseStore';
import { DEFAULT_PM_LINE_SETTINGS } from '@/lib/pmConcentrations';

function setUser(favoriteParameters: string[]) {
  useAuthStore.setState({
    user: {
      id: 1,
      email: 'a@b.com',
      username: 'alice',
      role: 'contributor',
      displayName: null,
      enabledConcentrationUnits: ['µmol/L', 'mg/L'],
      notificationSettings: null,
      favoriteParameters,
    },
    isAuthenticated: true,
    isLoading: false,
  });
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe('toggleFavoriteParameter (#321 P1 follow-ups)', () => {
  const originalState = useAuthStore.getState();

  beforeEach(() => {
    setUser([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState(originalState);
  });

  it('serializes concurrent toggles so each call observes the prior result', async () => {
    // The first response returns ['halfLife']; the second sees the
    // already-applied ['halfLife'] and returns ['halfLife','vd'].
    // Without serialization, both calls would read [] and the second
    // PATCH would clobber the first.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          preferences: {
            displayName: null,
            enabledConcentrationUnits: ['µmol/L', 'mg/L'],
            notificationSettings: null,
            favoriteParameters: ['halfLife'],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          preferences: {
            displayName: null,
            enabledConcentrationUnits: ['µmol/L', 'mg/L'],
            notificationSettings: null,
            favoriteParameters: ['halfLife', 'volumeOfDistribution'],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { toggleFavoriteParameter } = useAuthStore.getState();
    await Promise.all([
      toggleFavoriteParameter('halfLife'),
      toggleFavoriteParameter('volumeOfDistribution'),
    ]);

    const final = useAuthStore.getState().user?.favoriteParameters;
    expect(final).toEqual(['halfLife', 'volumeOfDistribution']);

    // Both PATCH bodies are derived from sequential snapshots.
    const calls = fetchMock.mock.calls;
    expect(calls).toHaveLength(2);
    const bodies = calls.map(
      (c) =>
        JSON.parse((c[1] as { body: string }).body) as {
          favoriteParameters: string[];
        },
    );
    expect(bodies[0]!.favoriteParameters).toEqual(['halfLife']);
    expect(bodies[1]!.favoriteParameters).toEqual([
      'halfLife',
      'volumeOfDistribution',
    ]);
  });

  it('rejects with an error when the PATCH fails so the caller can surface a toast', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: 'boom' }, false));
    vi.stubGlobal('fetch', fetchMock);

    const { toggleFavoriteParameter } = useAuthStore.getState();
    await expect(toggleFavoriteParameter('halfLife')).rejects.toThrow();
    // Auth-store state is untouched on failure — the optimistic UI
    // contract is "server is the source of truth".
    expect(useAuthStore.getState().user?.favoriteParameters).toEqual([]);
  });

  it('keeps the chain alive after a failure so the next toggle still works', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, false))
      .mockResolvedValueOnce(
        jsonResponse({
          preferences: {
            displayName: null,
            enabledConcentrationUnits: ['µmol/L', 'mg/L'],
            notificationSettings: null,
            favoriteParameters: ['halfLife'],
          },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const { toggleFavoriteParameter } = useAuthStore.getState();
    await expect(toggleFavoriteParameter('halfLife')).rejects.toThrow();
    await toggleFavoriteParameter('halfLife');
    expect(useAuthStore.getState().user?.favoriteParameters).toEqual([
      'halfLife',
    ]);
  });

  it('is a no-op for anonymous sessions', async () => {
    useAuthStore.setState({ user: null, isAuthenticated: false });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await useAuthStore.getState().toggleFavoriteParameter('halfLife');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('auth error code → i18n key mapping (DB-outage UX)', () => {
  const originalState = useAuthStore.getState();

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState(originalState);
  });

  function errorResponse(body: unknown, status: number): Response {
    return {
      ok: false,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response;
  }

  it('maps a 503 service_unavailable code to a translatable key, not raw English', async () => {
    // The server returns a stable code + English fallback prose; the store must
    // throw the i18n key so LoginPage renders a translated message instead of
    // "Service temporarily unavailable" verbatim in the Norwegian UI.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errorResponse(
          { error: 'Service temporarily unavailable', code: 'service_unavailable' },
          503,
        ),
      ),
    );

    await expect(
      useAuthStore.getState().requestMagicLink('a@b.com', false),
    ).rejects.toThrow('auth.serviceUnavailable');
  });

  it('maps the same code on the verify step too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errorResponse(
          { error: 'Service temporarily unavailable', code: 'service_unavailable' },
          503,
        ),
      ),
    );

    await expect(
      useAuthStore.getState().verifyCode('a@b.com', '123456'),
    ).rejects.toThrow('auth.serviceUnavailable');
  });

  it('falls back to the server error prose for codes it does not recognise', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          errorResponse({ error: 'Too many sign-in requests.' }, 429),
        ),
    );

    await expect(
      useAuthStore.getState().requestMagicLink('a@b.com', false),
    ).rejects.toThrow('Too many sign-in requests.');
  });
});

// #405 follow-up: /api/methods is admin/group-grant-gated, so the
// module-scoped methodsCache must not survive auth-state changes within
// the same tab — otherwise the next user inherits the previous user's
// gated/ungated response.
describe('analytical-methods cache invalidation on auth change', () => {
  const originalAuth = useAuthStore.getState();
  const originalDrug = useDrugStore.getState();

  function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
    return {
      id: 1,
      email: 'a@b.com',
      username: 'alice',
      role: 'contributor',
      displayName: null,
      enabledConcentrationUnits: ['µmol/L', 'mg/L'],
      notificationSettings: null,
      favoriteParameters: [],
      groups: [],
      ...overrides,
    };
  }

  function methodsResponse(body: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
    } as unknown as Response;
  }

  beforeEach(() => {
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: false,
    });
    useDrugStore.setState({ methods: [] });
  });

  afterEach(() => {
    // Reset auth state BEFORE unstubbing fetch — restoring to the
    // original `user: null` flips analytical-methods access from
    // true → false for any test that left an admin signed in, which
    // re-triggers the subscriber's loadMethods() call. Keeping the
    // fetch stub installed prevents that refetch from hitting the
    // real network and erroring in the JSDOM env.
    useAuthStore.setState(originalAuth);
    useDrugStore.setState(originalDrug);
    useBasketStore.getState().clear();
    useSimulatorStore.getState().reset();
    vi.unstubAllGlobals();
  });

  it('clears drug-store methods and refetches when a user gains access', async () => {
    // Anonymous visitor cached the gated empty response.
    useDrugStore.setState({
      methods: [
        { id: 'stale', name: 'stale', description: '', components: [] },
      ],
    });
    const fetchMock = vi.fn().mockResolvedValue(
      methodsResponse({
        methods: [
          {
            code: 'GC-MS',
            name: 'GC-MS',
            description: 'Gas chromatography',
            drugIds: [1],
            pubchemCids: [702],
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    useAuthStore.setState({
      user: makeUser({
        groups: [{ id: 1, slug: 'lab', name: 'Lab', grants: ['methods.read', 'pmConcentrations.read', 'refsDetectionTimes.read', 'patternProfile.view'] }],
      }),
      isAuthenticated: true,
    });

    // Synchronously cleared.
    expect(useDrugStore.getState().methods).toEqual([]);
    // Refetch pushes the fresh list once /api/methods resolves so the
    // already-mounted DrugTable shell sees the new auth scope without
    // remounting.
    await vi.waitFor(() => {
      expect(useDrugStore.getState().methods).toEqual([
        {
          id: 'GC-MS',
          name: 'GC-MS',
          description: 'Gas chromatography',
          components: ['702'],
          drugIds: [1],
        },
      ]);
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/methods');
  });

  it('clears drug-store methods on logout without refetching a gated empty list', async () => {
    // Stub fetch first so the initial admin login (access false → true)
    // doesn't escape to a real /api/methods call before the logout
    // transition we're actually asserting.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(methodsResponse({ methods: [], gated: true }));
    vi.stubGlobal('fetch', fetchMock);

    useAuthStore.setState({
      user: makeUser({ role: 'admin' }),
      isAuthenticated: true,
    });
    useDrugStore.setState({
      methods: [
        { id: 'cached', name: 'cached', description: '', components: [] },
      ],
    });

    useAuthStore.setState({ user: null, isAuthenticated: false });

    expect(useDrugStore.getState().methods).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useDrugStore.getState().methods).toEqual([]);
  });

  it('does not reset methods when access state is unchanged across user swaps', () => {
    // Stubbed with a valid response so both the initial admin sign-in
    // (false → true flip, fires refetch once) and the afterEach reset
    // (true → false flip) have something to drain. The assertion is on
    // the user-swap call count delta, not the lifetime total.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(methodsResponse({ methods: [], gated: true }));
    vi.stubGlobal('fetch', fetchMock);

    useAuthStore.setState({
      user: makeUser({ id: 1, role: 'admin' }),
      isAuthenticated: true,
    });
    const cached = [
      { id: 'shared', name: 'shared', description: '', components: [] },
    ];
    useDrugStore.setState({ methods: cached });
    const callsBeforeSwap = fetchMock.mock.calls.length;

    // Different admin signs in on the same tab — same access level, so
    // the methods snapshot is still valid (server returns the same set).
    useAuthStore.setState({
      user: makeUser({
        id: 2,
        email: 'b@b.com',
        username: 'bob',
        role: 'admin',
      }),
    });

    expect(useDrugStore.getState().methods).toEqual(cached);
    expect(fetchMock.mock.calls.length).toBe(callsBeforeSwap);
  });

  it('preserves bootstrap comparisons but clears them when the authenticated user changes', () => {
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: true,
    });
    useBasketStore.getState().addItem({
      drugId: 1,
      pubchemCid: 702,
      drugName: 'Ethanol',
    });
    expect(useBasketStore.getState().items).toHaveLength(1);

    useAuthStore.setState({
      user: makeUser({ id: 1 }),
      isAuthenticated: true,
      isLoading: false,
    });
    expect(useBasketStore.getState().items).toHaveLength(1);

    useBasketStore.getState().addItem({
      drugId: 2,
      pubchemCid: 3821,
      drugName: 'Ketamine',
    });
    useAuthStore.setState({
      user: makeUser({ id: 2, email: 'b@b.com', username: 'bob' }),
      isAuthenticated: true,
    });

    expect(useBasketStore.getState().items).toEqual([]);
    expect(useBasketStore.getState().referenceDrugId).toBeNull();
  });

  it('preserves bootstrap simulator state but clears it when the authenticated user changes', () => {
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: true,
    });
    useSimulatorStore.setState({
      caseName: 'Shared tab case',
      caseId: 12,
      drugs: [
        {
          id: 'cfg1',
          drugId: '702',
          drugName: 'Ethanol',
          label: 'Ethanol',
          events: [],
          route: 'oral',
          questionMode: 'concentration-from-dose',
          inputs: {},
          overrides: {},
          display: { visible: true },
        },
      ],
    });
    expect(useSimulatorStore.getState().drugs).toHaveLength(1);

    useAuthStore.setState({
      user: makeUser({ id: 1 }),
      isAuthenticated: true,
      isLoading: false,
    });
    expect(useSimulatorStore.getState().drugs).toHaveLength(1);

    useAuthStore.setState({
      user: makeUser({ id: 2, email: 'b@b.com', username: 'bob' }),
      isAuthenticated: true,
    });

    expect(useSimulatorStore.getState().caseName).toBe('New Case');
    expect(useSimulatorStore.getState().caseId).toBeNull();
    expect(useSimulatorStore.getState().drugs).toEqual([]);
    expect(useSimulatorStore.getState().results).toEqual({});
  });
});

describe('postmortem line settings on auth change', () => {
  const originalAuth = useAuthStore.getState();

  function makeUser(id: number): AuthUser {
    return {
      id,
      email: `u${id}@b.com`,
      username: `u${id}`,
      role: 'admin',
      displayName: null,
      enabledConcentrationUnits: ['µmol/L', 'mg/L'],
      notificationSettings: null,
      favoriteParameters: [],
      groups: [],
    } as AuthUser;
  }

  const CUSTOMISED = {
    ...DEFAULT_PM_LINE_SETTINGS,
    enabled: false,
    statistics: { ...DEFAULT_PM_LINE_SETTINGS.statistics, p975: true },
  };

  beforeEach(() => {
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
    useAppStore.setState({ pmLines: DEFAULT_PM_LINE_SETTINGS });
    usePatternCaseStore.getState().reset();
  });

  afterEach(() => {
    useAuthStore.setState(originalAuth);
    useAppStore.setState({ pmLines: DEFAULT_PM_LINE_SETTINGS });
  });

  it('discards one account\'s chart configuration when another signs in', async () => {
    // Shared browser: the second reader must not open on the first reader's
    // percentiles, least of all with plasma-converted lines already drawn.
    useAuthStore.setState({ user: makeUser(1), isAuthenticated: true });
    useAppStore.setState({ pmLines: CUSTOMISED });

    useAuthStore.setState({ user: makeUser(2), isAuthenticated: true });

    expect(useAppStore.getState().pmLines).toEqual(DEFAULT_PM_LINE_SETTINGS);
  });

  it('discards the case on screen when another account signs in', async () => {
    // A forensic case is the most user-scoped thing the app holds, and its
    // store is a singleton that outlives a session. Worse than a stale screen:
    // the page skips the fetch for a case it believes it already has, so the
    // endpoint's ownership check never runs and the next reader gets the
    // previous reader's case with nothing asking whether they may see it.
    useAuthStore.setState({ user: makeUser(1), isAuthenticated: true });
    usePatternCaseStore.setState({ caseId: 7, caseName: 'Sak TEST-001', dirty: true });

    useAuthStore.setState({ user: makeUser(2), isAuthenticated: true });

    expect(usePatternCaseStore.getState().caseId).toBeNull();
    expect(usePatternCaseStore.getState().caseName).toBe('');
  });

  it('keeps the case when the same session is restored on load', async () => {
    // Bootstrap is not somebody else signing in, and discarding an unsaved
    // draft on every page load would be its own kind of loss.
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: true });
    usePatternCaseStore.setState({ caseId: 7, caseName: 'Sak TEST-001' });

    useAuthStore.setState({ user: makeUser(1), isAuthenticated: true, isLoading: false });

    expect(usePatternCaseStore.getState().caseId).toBe(7);
  });

  it('keeps the preference when the same session is restored on load', async () => {
    // The whole point of persisting it. Bootstrap goes null -> user with
    // isLoading falling, which is not somebody else signing in.
    useAppStore.setState({ pmLines: CUSTOMISED });
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: true });

    useAuthStore.setState({
      user: makeUser(1),
      isAuthenticated: true,
      isLoading: false,
    });

    expect(useAppStore.getState().pmLines).toEqual(CUSTOMISED);
  });
});

// #1240 round 5 (Codex, review comment 4062497398): a failed reload must not
// leave a stale hidden-item list in place. checkAuth() reruns on login
// (LoginPage.tsx), so a list an earlier anonymous-session load set can
// otherwise survive a subsequent failed reload for the rest of the tab.
describe('loadHiddenNavItems fail-open behaviour', () => {
  const originalState = useAuthStore.getState();

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState(originalState);
  });

  it('marks the read settled and stores the fetched list on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          hiddenItems: ['references'],
          updatedAt: null,
          updatedBy: null,
        }),
      ),
    );

    await useAuthStore.getState().loadHiddenNavItems();

    expect(useAuthStore.getState().hiddenNavItems).toEqual(['references']);
    expect(useAuthStore.getState().hiddenNavItemsLoaded).toBe(true);
  });

  it('resets to "hide nothing" on a failed reload, rather than keeping a stale list', async () => {
    // Simulates the exact scenario: an earlier successful load left a real
    // hidden id in place, then a later reload (e.g. triggered by login)
    // fails.
    useAuthStore.setState({ hiddenNavItems: ['references'] });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));

    await useAuthStore.getState().loadHiddenNavItems();

    expect(useAuthStore.getState().hiddenNavItems).toEqual([]);
    expect(useAuthStore.getState().hiddenNavItemsLoaded).toBe(true);
  });

  it('unsettles hiddenNavItemsLoaded as soon as a reload starts, not only on first load (Codex, review comment 4062578610)', async () => {
    // checkAuth() reruns loadHiddenNavItems() on login. If `loaded` stayed
    // true from an earlier (e.g. anonymous-session) load while this fetch is
    // in flight, Header would render that STALE list instead of withholding
    // — the same exposure round 3 fixed for the never-loaded case.
    useAuthStore.setState({ hiddenNavItemsLoaded: true, hiddenNavItems: ['references'] });
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      ),
    );

    const pending = useAuthStore.getState().loadHiddenNavItems();
    // Synchronously true the instant the call is made, before the fetch
    // itself has any chance to settle.
    expect(useAuthStore.getState().hiddenNavItemsLoaded).toBe(false);

    resolveFetch(
      jsonResponse({ hiddenItems: [], updatedAt: null, updatedBy: null }),
    );
    await pending;
    expect(useAuthStore.getState().hiddenNavItemsLoaded).toBe(true);
  });
});
