import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getDbMock,
  getUserFromRequestMock,
  runImportMock,
  resolveImportCrosswalkMock,
} = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  getUserFromRequestMock: vi.fn(),
  runImportMock: vi.fn(),
  resolveImportCrosswalkMock: vi.fn(),
}));

vi.mock('../../api/_lib/db.js', () => ({ getDb: getDbMock }));
vi.mock('../../api/_lib/auth.js', () => ({ getUserFromRequest: getUserFromRequestMock }));
vi.mock('../../api/_lib/researchImportStore.js', () => ({ runImport: runImportMock }));
// The PMID↔DOI crosswalk is a live NCBI lookup (#1018); stub it so the route
// test stays hermetic.
vi.mock('../../api/_lib/citation-crosswalk.js', () => ({
  resolveImportCrosswalk: resolveImportCrosswalkMock,
}));

import handler from '../../api/research-import.ts';

function createRequest(body: unknown, method = 'POST'): IncomingMessage {
  const req = Readable.from([typeof body === 'string' ? body : JSON.stringify(body)]) as unknown as
    IncomingMessage & { method: string; url: string; headers: Record<string, string> };
  req.method = method;
  req.url = '/api/research-import';
  req.headers = { host: 'localhost', 'content-type': 'application/json' };
  return req;
}

function createResponse(): { res: ServerResponse; state: { statusCode: number; body: string } } {
  const state = { statusCode: 200, body: '' };
  const res = {
    headersSent: false,
    writeHead: vi.fn((statusCode: number) => {
      state.statusCode = statusCode;
      res.headersSent = true;
      return res;
    }),
    end: vi.fn((body?: string) => {
      state.body = body ?? '';
      return res;
    }),
  } as unknown as ServerResponse & { headersSent: boolean };
  return { res, state };
}

const VALID_DOC = {
  schemaVersion: 'kinetix-deep-research-output-v1',
  drugIdentity: { names: { nb: 'Kokain', en: 'Cocaine' }, pubchemCid: 446220 },
  kinetixParameterValues: [
    { parameter: 'halfLife', status: 'finalized', value: { min: 0.7, max: 1.7, unit: 'h' }, sourceIds: ['S1'] },
  ],
  sources: [{ sourceId: 'S1', citationType: 'pmid', pmid: '29462364' }],
};

beforeEach(() => {
  getDbMock.mockReset();
  getUserFromRequestMock.mockReset();
  runImportMock.mockReset();
  resolveImportCrosswalkMock.mockReset();
  resolveImportCrosswalkMock.mockResolvedValue(new Map());
  getDbMock.mockReturnValue({});
});

describe('POST /api/research-import', () => {
  it('rejects non-admins with 403', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 5, role: 'editor' });
    const { res, state } = createResponse();
    await handler(createRequest({ document: VALID_DOC }), res);
    expect(state.statusCode).toBe(403);
    expect(runImportMock).not.toHaveBeenCalled();
  });

  it('rejects non-POST with 405', async () => {
    const { res, state } = createResponse();
    await handler(createRequest({}, 'GET'), res);
    expect(state.statusCode).toBe(405);
  });

  it('dry-runs by default: validates, returns a plan, and does NOT import', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();
    await handler(createRequest({ document: VALID_DOC }), res);
    expect(state.statusCode).toBe(200);
    const payload = JSON.parse(state.body);
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.plan.counts.parameters).toBe(1);
    expect(payload.plan.drug.pubchemCid).toBe(446220);
    expect(runImportMock).not.toHaveBeenCalled();
  });

  it('returns 400 with structured errors for an invalid document', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();
    await handler(createRequest({ document: { drugIdentity: {} } }), res);
    expect(state.statusCode).toBe(400);
    const payload = JSON.parse(state.body);
    expect(payload.ok).toBe(false);
    expect(Array.isArray(payload.errors)).toBe(true);
    expect(runImportMock).not.toHaveBeenCalled();
  });

  it('imports when dryRun is false, attributing to the admin', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 42, role: 'admin' });
    runImportMock.mockResolvedValue({
      drugId: 7, drugCreated: true, citations: 1, parameters: 1, parametersSkipped: 0,
      pdTargets: 0, routes: 0, metabolites: 0, enzymeInteractions: 0,
    });
    const { res, state } = createResponse();
    await handler(createRequest({ document: VALID_DOC, dryRun: false, overwrite: true }), res);
    expect(state.statusCode).toBe(200);
    const payload = JSON.parse(state.body);
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(false);
    expect(payload.stats.drugId).toBe(7);
    expect(runImportMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      userId: 42,
      overwrite: true,
      crosswalk: expect.any(Map),
    });
  });

  it('recounts source-value coverage against the resolved crosswalk on import', async () => {
    // The document names a PMID for S1 and a DOI for S2 with nothing linking
    // them, so the preview counts two papers. NCBI says they are one article,
    // and the import reports the coverage that matches what it wrote.
    const twoSources = {
      ...VALID_DOC,
      kinetixParameterValues: [
        {
          parameter: 'halfLife',
          status: 'finalized',
          value: { min: 0.7, max: 1.7, unit: 'h' },
          sourceValues: [
            { sourceId: 'S1', low: 0.8, high: 1.2, median: 1.0, unit: 'h' },
            { sourceId: 'S2', low: 1.2, high: 1.6, median: 1.4, unit: 'h' },
          ],
        },
      ],
      sources: [
        { sourceId: 'S1', citationType: 'pmid', pmid: '29462364' },
        { sourceId: 'S2', citationType: 'doi', doi: '10.1093/jat/bky007' },
      ],
    };
    getUserFromRequestMock.mockResolvedValue({ userId: 42, role: 'admin' });
    runImportMock.mockResolvedValue({
      drugId: 7, drugCreated: true, citations: 1, parameters: 1, parametersSkipped: 0,
      pdTargets: 0, routes: 0, metabolites: 0, enzymeInteractions: 0,
    });

    const preview = createResponse();
    await handler(createRequest({ document: twoSources }), preview.res);
    const previewPayload = JSON.parse(preview.state.body);
    expect(
      (previewPayload.warnings as string[]).some((w) => w.startsWith('Source-value coverage:')),
    ).toBe(false);

    resolveImportCrosswalkMock.mockResolvedValue(
      new Map([['S1', { pmid: '29462364', doi: '10.1093/jat/bky007' }]]),
    );
    const imported = createResponse();
    await handler(createRequest({ document: twoSources, dryRun: false }), imported.res);
    const payload = JSON.parse(imported.state.body);
    const coverage = (payload.warnings as string[]).filter((w) =>
      w.startsWith('Source-value coverage:'),
    );
    expect(coverage).toHaveLength(1);
    expect(coverage[0]).toContain('halfLife (1)');
  });

  it('accepts a bare document (no envelope) and dry-runs it', async () => {
    getUserFromRequestMock.mockResolvedValue({ userId: 1, role: 'admin' });
    const { res, state } = createResponse();
    await handler(createRequest(VALID_DOC), res);
    expect(state.statusCode).toBe(200);
    const payload = JSON.parse(state.body);
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(runImportMock).not.toHaveBeenCalled();
  });
});
