import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, isAgentUserMock, gateEnabledMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  isAgentUserMock: vi.fn(),
  gateEnabledMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/agentHooks.js', () => ({ isAgentUser: isAgentUserMock }));
vi.mock('../../api/_lib/site-settings-store.js', () => ({
  isReferenceGateEnabled: gateEnabledMock,
}));

import {
  assertReferencesJudged,
  assertReferencesJudgedForActor,
  isReadInFullUnverified,
  ReferenceGateError,
} from '../../api/_lib/pending-edits-helpers';

// Three sequential queries (citations, paper_reviews, pending paper-review
// edits), not one db.batch() call — `.batch()` is a neon-http-only method the
// pool-transaction client this helper also runs under does not implement
// (#1356). The mock resolves each successive select/from/where in the order
// the helper issues them.
function mockDb(
  citeRows: unknown[],
  approvedRows: unknown[],
  pendingRows: unknown[],
) {
  const queue = [citeRows, approvedRows, pendingRows];
  const where = vi.fn(() => Promise.resolve(queue.shift() ?? []));
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  getDbMock.mockReturnValue({ select });
  return { select, where };
}

describe('assertReferencesJudged (reference gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The admin switch defaults to ON; the off case has its own describe.
    gateEnabledMock.mockResolvedValue(true);
  });

  it('passes with no references and never touches the db', async () => {
    const { select } = mockDb([], [], []);
    await expect(assertReferencesJudged([])).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it('exempts freetext references', async () => {
    const { select } = mockDb([{ id: 1, type: 'freetext' }], [], []);
    await expect(assertReferencesJudged([1])).resolves.toBeUndefined();
    // All three queries run regardless of citation type; the freetext filter
    // is applied in JS after they resolve.
    expect(select).toHaveBeenCalledTimes(3);
  });

  it('passes when a resolvable reference has an approved read-in-full review', async () => {
    mockDb([{ id: 1, type: 'doi' }], [{ citationId: 1 }], []);
    await expect(assertReferencesJudged([1])).resolves.toBeUndefined();
  });

  it('passes when a pending review claims read-in-full', async () => {
    mockDb(
      [{ id: 1, type: 'pmid' }],
      [],
      [{ targetId: 1, proposedValue: { readInFull: true } }],
    );
    await expect(assertReferencesJudged([1])).resolves.toBeUndefined();
  });

  it('rejects when a pending review does not claim read-in-full', async () => {
    mockDb(
      [{ id: 1, type: 'pmid' }],
      [],
      [{ targetId: 1, proposedValue: { readInFull: false } }],
    );
    await expect(assertReferencesJudged([1])).rejects.toBeInstanceOf(
      ReferenceGateError,
    );
  });

  it('rejects a resolvable reference with no review at all, listing it', async () => {
    mockDb([{ id: 7, type: 'url' }], [], []);
    await expect(assertReferencesJudged([7])).rejects.toMatchObject({
      unjudgedCitationIds: [7],
    });
  });

  it('passes a freetext ref even when an unreviewed resolvable ref is also cited only after it is judged', async () => {
    // Mixed batch: freetext (exempt) + resolvable with approved review.
    mockDb(
      [
        { id: 1, type: 'freetext' },
        { id: 2, type: 'doi' },
      ],
      [{ citationId: 2 }],
      [],
    );
    await expect(assertReferencesJudged([1, 2])).resolves.toBeUndefined();
  });
});

describe('assertReferencesJudgedForActor (agent-only gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The admin switch defaults to ON; the off case has its own describe.
    gateEnabledMock.mockResolvedValue(true);
  });

  it('skips the gate for a human actor and never touches the db', async () => {
    isAgentUserMock.mockResolvedValue(false);
    const { select } = mockDb([{ id: 7, type: 'url' }], [], []);
    // A human cites a resolvable reference with no review at all — the bare
    // gate would reject it, but the actor-aware gate lets it through.
    await expect(
      assertReferencesJudgedForActor([7], 42),
    ).resolves.toBeUndefined();
    expect(isAgentUserMock).toHaveBeenCalledWith(42);
    expect(select).not.toHaveBeenCalled();
  });

  it('enforces the gate for an agent actor', async () => {
    isAgentUserMock.mockResolvedValue(true);
    mockDb([{ id: 7, type: 'url' }], [], []);
    await expect(
      assertReferencesJudgedForActor([7], 99),
    ).rejects.toBeInstanceOf(ReferenceGateError);
    expect(isAgentUserMock).toHaveBeenCalledWith(99);
  });

  it('passes for an agent when the reference is judged', async () => {
    isAgentUserMock.mockResolvedValue(true);
    mockDb([{ id: 1, type: 'doi' }], [{ citationId: 1 }], []);
    await expect(
      assertReferencesJudgedForActor([1], 99),
    ).resolves.toBeUndefined();
  });
});

describe('reference gate admin switch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lets an agent submission through when blocking is off', async () => {
    gateEnabledMock.mockResolvedValue(false);
    isAgentUserMock.mockResolvedValue(true);
    // A resolvable citation with no review at all — the strictest rejection
    // the gate has. With the switch off it must pass, and must ask neither
    // the citation tables nor the agent registry: nothing they could return
    // changes the answer.
    const { select } = mockDb([{ id: 7, type: 'url' }], [], []);
    await expect(
      assertReferencesJudgedForActor([7], 99),
    ).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
    expect(isAgentUserMock).not.toHaveBeenCalled();
  });

  it('leaves the bare gate unconditional so learning units stay gated', async () => {
    // `assertReferencesJudged` is called directly by the learning_unit
    // submission path, which gates humans as well: there the reviewed source
    // is the unit's substance, not an agent discipline. The switch must not
    // reach it — turning the agent gate off must not newly let anyone publish
    // a learning unit anchored to an unread paper.
    gateEnabledMock.mockResolvedValue(false);
    mockDb([{ id: 7, type: 'url' }], [], []);
    await expect(assertReferencesJudged([7])).rejects.toBeInstanceOf(
      ReferenceGateError,
    );
    expect(gateEnabledMock).not.toHaveBeenCalled();
  });

  it('does not consult the switch when nothing is cited', async () => {
    gateEnabledMock.mockResolvedValue(false);
    await expect(
      assertReferencesJudgedForActor([], 99),
    ).resolves.toBeUndefined();
    expect(gateEnabledMock).not.toHaveBeenCalled();
  });
});

describe('isReadInFullUnverified (false-attestation flag)', () => {
  it('flags read-in-full with an open PDF request and no stored PDF', () => {
    // The contradiction: agent attested it read the full paper, yet the only
    // signal on file is an open request ("full text unavailable") and no PDF.
    expect(isReadInFullUnverified(true, true, false)).toBe(true);
  });

  it('does not flag when a PDF is stored (read-in-full is supported)', () => {
    expect(isReadInFullUnverified(true, true, true)).toBe(false);
  });

  it('does not flag the legitimate free-full-text case (no open request)', () => {
    // No request was ever filed (or it was resolved), so there is no
    // contradicting signal — a free full text leaves no stored PDF either.
    expect(isReadInFullUnverified(true, false, false)).toBe(false);
  });

  it('does not flag a review that never claimed read-in-full', () => {
    expect(isReadInFullUnverified(false, true, false)).toBe(false);
  });
});
