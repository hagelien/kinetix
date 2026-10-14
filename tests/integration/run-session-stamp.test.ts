/**
 * Which agent run wrote an output (issue #214), through the real auth path.
 *
 * An agent sends its runner session id in X-Kinetix-Run-Session; the write
 * paths stamp it on `pending_edits` and `agent_verifications` so the tier
 * benchmark can tie each output to the run that paid for it. The stamp must
 * come only from an agent-token (`kxat_`) request: a person sending the same
 * header leaves the column NULL. Auth is not mocked here — the agent token is
 * a real `agent_tokens` row and the person a real signed session — because the
 * rule under test lives in `getUserFromRequest`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { eq } from 'drizzle-orm';
import { generateAgentToken, signToken } from '../../api/_lib/auth.js';
import metabolismHandler from '../../api/drug-metabolism.js';
import verificationsHandler from '../../api/agent-verifications.js';
import pendingEditsHandler from '../../api/pending-edits.js';
import { verificationTargetVersion } from '../../api/_lib/verification-targets.js';
import {
  agentTokens,
  agentVerifications,
  agents,
  pendingEdits,
} from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;
const previousSecret = process.env.JWT_SECRET;

beforeAll(async () => {
  process.env.JWT_SECRET ??= 'run-session-stamp-test-secret';
  db = await setupIntegrationDb();
  // A person's session is resolved with `db.batch()`, a neon-http method the
  // PGlite client lacks. Running the same queries one by one is what batch
  // does, minus the shared round trip.
  (db as unknown as { batch: (qs: unknown[]) => Promise<unknown[]> }).batch = (
    qs,
  ) => Promise.all(qs);
});
afterAll(async () => {
  await teardownIntegrationDb();
  if (previousSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = previousSecret;
});
beforeEach(async () => {
  await resetIntegrationDb(db);
});

const RUN = '0f9c2b1e-7d4a-4c1b-9e2f-3a5b6c7d8e9f';

/** An active agent and a live kxat_ token for it. */
async function seedAgentWithToken(slug = 'claude-sonnet-5') {
  const userId = await seedUser(db, {
    email: `${slug}@example.com`,
    username: slug,
    role: 'contributor',
  });
  const [agent] = await db
    .insert(agents)
    .values({ userId, name: slug, slug, status: 'active', modelTier: 'mid' })
    .returning({ id: agents.id });
  const { token, hash, prefix } = generateAgentToken();
  await db.insert(agentTokens).values({
    agentId: agent!.id,
    tokenHash: hash,
    prefix,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return { userId, agentId: agent!.id, token };
}

/** A person with a fresh signed session. */
async function seedPersonWithSession() {
  const userId = await seedUser(db, {
    email: 'person@example.com',
    username: 'person',
    role: 'contributor',
    lastAuthAt: new Date(),
  });
  return { userId, token: await signToken(userId, 'contributor') };
}

function createResponse() {
  const state = { statusCode: 0, body: '' };
  const res = {
    headersSent: false,
    setHeader: vi.fn(),
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse;
  return { res, state };
}

async function call(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  method: 'PUT' | 'POST' | 'PATCH',
  url: string,
  body: unknown,
  token: string,
  runSession?: string,
) {
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
    cookie: `__Host-kinetix-auth=${token}`,
    ...(runSession !== undefined
      ? { 'x-kinetix-run-session': runSession }
      : {}),
  };
  const { res, state } = createResponse();
  await handler(req, res);
  return {
    statusCode: state.statusCode,
    body: state.body ? JSON.parse(state.body) : null,
  };
}

async function submitMetabolism(token: string, runSession?: string) {
  const drugId = await seedDrug(db, { slug: `drug-${Math.random()}` });
  const result = await call(
    metabolismHandler,
    'PUT',
    `/api/drug-metabolism?drugId=${drugId}`,
    {},
    token,
    runSession,
  );
  expect(result.statusCode, JSON.stringify(result.body)).toBe(201);
  const [row] = await db
    .select({
      submittedBy: pendingEdits.submittedBy,
      runSessionId: pendingEdits.runSessionId,
    })
    .from(pendingEdits)
    .where(eq(pendingEdits.id, result.body.pendingEditId as number));
  return { id: result.body.pendingEditId as number, row: row! };
}

describe('run session stamp on pending edits', () => {
  it("stamps an agent-token submission with the run's session id", async () => {
    const agent = await seedAgentWithToken();
    const { row } = await submitMetabolism(agent.token, RUN);
    expect(row).toEqual({ submittedBy: agent.userId, runSessionId: RUN });
  });

  it('leaves a person’s submission unstamped even when it sends the header', async () => {
    const person = await seedPersonWithSession();
    const { row } = await submitMetabolism(person.token, RUN);
    expect(row).toEqual({ submittedBy: person.userId, runSessionId: null });
  });

  it('leaves an agent submission unstamped without a valid header', async () => {
    const agent = await seedAgentWithToken();
    expect((await submitMetabolism(agent.token)).row.runSessionId).toBeNull();
    expect(
      (await submitMetabolism(agent.token, 'not a session')).row.runSessionId,
    ).toBeNull();
  });

  it('re-stamps a resubmission with the run that made it', async () => {
    const agent = await seedAgentWithToken();
    const { id } = await submitMetabolism(agent.token, 'run-1');
    await db
      .update(pendingEdits)
      .set({ status: 'returned' })
      .where(eq(pendingEdits.id, id));

    const resubmitted = await call(
      pendingEditsHandler,
      'PATCH',
      `/api/pending-edits?id=${id}`,
      { status: 'pending' },
      agent.token,
      'run-2',
    );
    expect(resubmitted.statusCode, JSON.stringify(resubmitted.body)).toBe(200);
    const [row] = await db
      .select({ runSessionId: pendingEdits.runSessionId })
      .from(pendingEdits)
      .where(eq(pendingEdits.id, id));
    expect(row!.runSessionId).toBe('run-2');
  });
});

describe('run session stamp on peer verdicts', () => {
  it('stamps an agent verdict, and a re-verdict moves the stamp to the new run', async () => {
    const person = await seedPersonWithSession();
    const { id: editId } = await submitMetabolism(person.token);
    const agent = await seedAgentWithToken();

    const verdict = async (runSession: string | undefined) => {
      const targetVersion = await verificationTargetVersion({
        targetType: 'pending_edit',
        targetId: editId,
      });
      return call(
        verificationsHandler,
        'POST',
        '/api/agent-verifications',
        {
          targetType: 'pending_edit',
          targetId: editId,
          targetVersion,
          verdict: 'abstain',
          rationaleMd: 'Kilden kan ikke leses i fulltekst i dette miljøet.',
        },
        agent.token,
        runSession,
      );
    };
    const stampOf = async () =>
      (
        await db
          .select({ runSessionId: agentVerifications.runSessionId })
          .from(agentVerifications)
          .where(eq(agentVerifications.agentId, agent.agentId))
      )[0]!.runSessionId;

    const first = await verdict('run-1');
    expect(first.statusCode, JSON.stringify(first.body)).toBe(201);
    expect(await stampOf()).toBe('run-1');

    // A later run revising the verdict owns the judgment the row now holds.
    const second = await verdict('run-2');
    expect(second.statusCode, JSON.stringify(second.body)).toBeLessThan(300);
    expect(await stampOf()).toBe('run-2');

    // Revised without naming a run: the old stamp would credit the wrong run.
    const third = await verdict(undefined);
    expect(third.statusCode, JSON.stringify(third.body)).toBeLessThan(300);
    expect(await stampOf()).toBeNull();
  });
});
