import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../api/_lib/db.js', () => ({
  getDb: vi.fn(),
  // No enclosing transaction in these unit tests, so run the deferred callback
  // synchronously — matching the real afterTransactionCommit's no-tx branch.
  afterTransactionCommit: (fn: () => void) => fn(),
}));

import {
  fireAgentHook,
  fireAgentHookForActor,
  fireAgentHookForSubmitterAsync,
  hasHookSubscriber,
  isAgentUser,
  _resetHookSubscriberCache,
  _resetAgentUserCache,
} from '../../api/_lib/agentHooks';
import { getDb } from '../../api/_lib/db.js';

const ORIGINAL_FETCH = globalThis.fetch;

// fireAgentHookForSubmitterAsync defers its work through afterTransactionCommit
// (mocked to run synchronously) into an async IIFE. Every step resolves on the
// microtask queue (the db + fetch mocks return immediately), so draining a
// generous number of microtasks deterministically settles the whole chain.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

// rows is loosely typed so tests can supply whichever fields a given query
// selects (e.g. { id } for hasHookSubscriber, { userId } for isAgentUser).
function mockAgentLookup(rows: Array<Record<string, unknown>>): void {
  const builder: Record<string, unknown> = {};
  const chain = (): typeof builder => builder;
  const insertBuilder = {
    values: vi.fn(async () => undefined),
  };
  Object.assign(builder, {
    // Thenable so callers that await without calling .limit() still resolve.
    then: (resolve: (v: typeof rows) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(rows).then(resolve, reject),
    from: vi.fn(chain),
    innerJoin: vi.fn(chain),
    where: vi.fn(chain),
    limit: vi.fn(async () => rows),
  });
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn(() => builder),
    insert: vi.fn(() => insertBuilder),
  } as unknown as ReturnType<typeof getDb>);
}

function mockAgentLookupFailure(error: Error): void {
  const builder: Record<string, unknown> = {};
  const chain = (): typeof builder => builder;
  const insertBuilder = {
    values: vi.fn(async () => undefined),
  };
  Object.assign(builder, {
    // Thenable that rejects — used when awaiting the query directly.
    then: (_resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
      if (typeof reject === 'function') reject(error);
    },
    from: vi.fn(chain),
    innerJoin: vi.fn(chain),
    where: vi.fn(chain),
    limit: vi.fn(async () => {
      throw error;
    }),
  });
  vi.mocked(getDb).mockReturnValue({
    select: vi.fn(() => builder),
    insert: vi.fn(() => insertBuilder),
  } as unknown as ReturnType<typeof getDb>);
}

describe('agent hook actor policy', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    _resetHookSubscriberCache();
    _resetAgentUserCache();
    globalThis.fetch = ORIGINAL_FETCH;
    delete process.env.CLAUDE_CODE_AGENT_HOOK_URL;
    delete process.env.CLAUDE_CODE_AGENT_HOOK_TOKEN;
  });

  it('detects users that back registered agents', async () => {
    mockAgentLookup([{ userId: 9 }]);
    await expect(isAgentUser(9)).resolves.toBe(true);

    _resetAgentUserCache();
    mockAgentLookup([]);
    await expect(isAgentUser(9)).resolves.toBe(false);
  });

  it('omits hook dispatch for agent-authored events', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    mockAgentLookup([{ userId: 9 }]);

    await fireAgentHookForActor(9, {
      kind: 'comment_posted',
      drugId: 1,
      parameter: 'halfLife',
      commentId: 99,
      authorUserId: 9,
      body: 'agent-authored comment',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('wakes the submitting agent when its own edit is returned', async () => {
    process.env.CLAUDE_CODE_AGENT_HOOK_URL =
      'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
    process.env.CLAUDE_CODE_AGENT_HOOK_TOKEN = 'shh';
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    // User 9 backs a registered, hook-enabled agent (same row set feeds both
    // isAgentUser and hasHookSubscriber).
    mockAgentLookup([{ userId: 9, id: 1 }]);

    fireAgentHookForSubmitterAsync(9, {
      kind: 'edit_returned',
      pendingEditId: 42,
      editType: 'wiki_fact',
      targetId: 17,
    });
    await flushMicrotasks();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain(
      'routines/trig_test/fire',
    );
  });

  it('does not fire when a human contributor edit is returned', async () => {
    process.env.CLAUDE_CODE_AGENT_HOOK_URL =
      'https://api.anthropic.com/v1/claude_code/routines/trig_test/fire';
    process.env.CLAUDE_CODE_AGENT_HOOK_TOKEN = 'shh';
    const fetchSpy = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    // Only user 9 backs an agent; the returned edit's submitter (7) is human,
    // so there is no agent to wake — the inverse gate short-circuits.
    mockAgentLookup([{ userId: 9, id: 1 }]);

    fireAgentHookForSubmitterAsync(7, {
      kind: 'edit_returned',
      pendingEditId: 43,
      editType: 'parameter',
      targetId: 5,
    });
    await flushMicrotasks();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('swallows actor lookup failures instead of dispatching or rejecting', async () => {
    const fetchSpy = vi.fn();
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    mockAgentLookupFailure(new Error('lookup unavailable'));

    await expect(
      fireAgentHookForActor(9, {
        kind: 'comment_posted',
        drugId: 1,
        parameter: 'halfLife',
        commentId: 99,
        authorUserId: 9,
        body: 'comment while lookup is down',
      }),
    ).resolves.toBeUndefined();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[agentHook] actor lookup for 9 threw: lookup unavailable',
    );
  });
});

describe('agent hook subscriber opt-in', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    _resetHookSubscriberCache();
    _resetAgentUserCache();
    globalThis.fetch = ORIGINAL_FETCH;
    process.env.CLAUDE_CODE_AGENT_HOOK_URL = 'https://example.test/fire';
    process.env.CLAUDE_CODE_AGENT_HOOK_TOKEN = 'shh';
    delete process.env.CLAUDE_CODE_AGENT_HOOKS_DISABLED;
  });

  it('detects when at least one active agent has opted in', async () => {
    mockAgentLookup([{ id: 1 }]);
    await expect(hasHookSubscriber()).resolves.toBe(true);

    // Reset cache so the second call re-queries with the updated mock.
    _resetHookSubscriberCache();
    mockAgentLookup([]);
    await expect(hasHookSubscriber()).resolves.toBe(false);
  });

  it('joins users so the agent-role kill switch also pauses hook firing', async () => {
    // Regression guard for the documented kill switch in
    // agents/remote-routine-setup.md: demoting the agent user to
    // `authenticated` without touching the `agents` row must stop the
    // hook from firing. The defence is the inner-join on `users` plus
    // the contributor+ role filter (mirroring api/agents.ts). Assert
    // the join is wired so it can't be silently dropped.
    const builder: Record<string, unknown> = {};
    const chain = (): typeof builder => builder;
    const innerJoinSpy = vi.fn(chain);
    const whereSpy = vi.fn(chain);
    Object.assign(builder, {
      from: vi.fn(chain),
      innerJoin: innerJoinSpy,
      where: whereSpy,
      limit: vi.fn(async () => []),
    });
    vi.mocked(getDb).mockReturnValue({
      select: vi.fn(() => builder),
      insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    } as unknown as ReturnType<typeof getDb>);

    await hasHookSubscriber();

    expect(innerJoinSpy).toHaveBeenCalledTimes(1);
    expect(whereSpy).toHaveBeenCalledTimes(1);
  });

  it('treats subscriber-lookup failures as no subscriber (fail closed)', async () => {
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    mockAgentLookupFailure(new Error('subscriber lookup down'));

    await expect(hasHookSubscriber()).resolves.toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      '[agentHook] hook-subscriber lookup threw: subscriber lookup down',
    );
  });

  it('skips the fire endpoint when no agent has hooks enabled', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    mockAgentLookup([]);

    await fireAgentHook({
      kind: 'comment_posted',
      drugId: 1,
      parameter: 'halfLife',
      commentId: 99,
      authorUserId: 7,
      body: 'hello',
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
