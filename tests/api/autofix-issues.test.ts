import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fingerprint,
  fingerprintIdentity,
  reportError,
  scrubSecrets,
  verifyVercelSignature,
} from '../../api/_lib/autofix-issues.js';
import { clearRateLimitState } from '../../api/_lib/rate-limit.js';

function sign(body: string, secret: string): string {
  return createHmac('sha1', secret).update(body, 'utf8').digest('hex');
}

describe('verifyVercelSignature', () => {
  const secret = 'drain-secret';
  const body = '[{"message":"boom"}]';

  it('accepts a correct signature', () => {
    expect(verifyVercelSignature(body, sign(body, secret), secret)).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verifyVercelSignature(body + 'x', sign(body, secret), secret)).toBe(
      false,
    );
  });

  it('rejects a missing or wrong-length signature', () => {
    expect(verifyVercelSignature(body, undefined, secret)).toBe(false);
    expect(verifyVercelSignature(body, 'deadbeef', secret)).toBe(false);
  });
});

describe('fingerprint', () => {
  it('collapses volatile ids so the same error maps to one fingerprint', () => {
    const a = fingerprint([
      'runtime',
      '/api/drugs?id=12345',
      'TypeError at 0xabc123',
    ]);
    const b = fingerprint([
      'runtime',
      '/api/drugs?id=98765',
      'TypeError at 0xdef456',
    ]);
    expect(a).toBe(b);
  });

  it('distinguishes different routes', () => {
    expect(fingerprint(['runtime', '/api/drugs', 'boom'])).not.toBe(
      fingerprint(['runtime', '/api/methods', 'boom']),
    );
  });
});

describe('fingerprintIdentity', () => {
  /**
   * The normaliser `fingerprint` applies is right for error text and wrong for
   * identifiers: it would merge these pairs, and a merged key means the second
   * branch's build failure is swallowed by the first branch's open issue.
   */
  it.each([
    ['digit runs', 'release/2025', 'release/2026'],
    ['ticket numbers', 'fix/1234', 'fix/5678'],
    ['letter case', 'Feature/X', 'feature/x'],
  ])('keeps branches apart that differ only by %s', (_label, left, right) => {
    expect(fingerprint(['build', 'kinetix', left])).toBe(
      fingerprint(['build', 'kinetix', right]),
    );
    expect(fingerprintIdentity(['build', 'kinetix', left])).not.toBe(
      fingerprintIdentity(['build', 'kinetix', right]),
    );
  });

  it('is stable for the same identity', () => {
    expect(fingerprintIdentity(['build', 'kinetix', 'main'])).toBe(
      fingerprintIdentity(['build', 'kinetix', 'main']),
    );
  });

  it('cannot be collided by regrouping the parts', () => {
    expect(fingerprintIdentity(['build', 'kinetix', 'main'])).not.toBe(
      fingerprintIdentity(['build', 'kinetixmain']),
    );
  });
});

describe('scrubSecrets', () => {
  it('redacts connection strings and agent tokens', () => {
    const out = scrubSecrets(
      'failed: postgres://user:pw@host/db https://u:p@example.test/path?token=secret&api_key=abc token kxat_abc123 Bearer xy.z-1',
    );
    expect(out).not.toContain('pw@host');
    expect(out).not.toContain('u:p@');
    expect(out).not.toContain('token=secret');
    expect(out).not.toContain('api_key=abc');
    expect(out).not.toContain('kxat_abc123');
    expect(out).toContain('postgres://<redacted>');
    expect(out).toContain(
      'https://<credentials>@example.test/path?token=<redacted>&api_key=<redacted>',
    );
    expect(out).toContain('kxat_<redacted>');
    expect(out).toContain('Bearer <redacted>');
  });

  it('redacts raw JWT tokens without a Bearer prefix', () => {
    // A JWT that appears bare — e.g. logged via console.error(req.headers) —
    // should be caught by the eyJ pattern even when not preceded by 'Bearer '.
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
      '.eyJzdWIiOiIxMjMiLCJyb2xlIjoiZWRpdG9yIn0' +
      '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = scrubSecrets(`error: token mismatch got ${jwt} expected`);
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out).toContain('eyJ<jwt-redacted>');
  });

  it('redacts JWT tokens embedded in __Host- cookie values', () => {
    // When a JWT appears as a cookie value the __Host- pattern fires and
    // redacts the entire name=value pair; there is no residual JWT text.
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' +
      '.eyJzdWIiOiIxMjMiLCJyb2xlIjoiZWRpdG9yIn0' +
      '.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = scrubSecrets(`debug cookie: __Host-kinetix-auth=${jwt}`);
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    // Either the JWT pattern or the __Host- pattern will have fired; the
    // raw JWT must not be present in either case.
    expect(out).not.toContain('.eyJzdWIiOiIxMjMiLCJyb2xlIjoiZWRpdG9yIn0.');
  });

  it('redacts __Host- prefixed cookies', () => {
    const out = scrubSecrets(
      'cookie header: __Host-kinetix-auth=abc.def.ghi; other=value',
    );
    expect(out).not.toContain('abc.def.ghi');
    expect(out).toContain('__Host-<cookie-redacted>');
  });

  it('redacts GitHub PATs not preceded by a key= prefix', () => {
    // When a PAT appears bare (e.g. in an Authorization header without
    // 'Bearer') it must be caught by the gh[a-z]_ pattern.
    const classic = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
    const finegrained = 'github_pat_11ABCDEFG0abcdefghijklmnopq_xyz';
    const out = scrubSecrets(
      `Authorization: ${classic} and also ${finegrained}`,
    );
    expect(out).not.toContain(classic);
    expect(out).not.toContain(finegrained);
    expect(out).toContain('gh<type>_<redacted>');
    expect(out).toContain('github_pat_<redacted>');
  });

  it('redacts Resend API keys', () => {
    const key = 're_abcdefghijklmnopqrstuvwxyz0123';
    // When the key appears as a standalone token (not after 'Bearer ') the
    // re_ pattern must fire.
    const out = scrubSecrets(`failed to send: key=${key} was invalid`);
    expect(out).not.toContain(key);
  });
});

describe('reportError', () => {
  const baseReport = {
    source: 'runtime' as const,
    title: '[auto-fix] boom',
    body: 'stack trace',
  };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    clearRateLimitState();
    process.env.GITHUB_REPO = 'hagelien/kinetix';
    process.env.GITHUB_AUTOFIX_TOKEN = 'ghp_test';
    delete process.env.AUTOFIX_DISABLED;
    delete process.env.AUTOFIX_DRY_RUN;

    fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/search/issues')) {
        return { ok: true, json: async () => ({ total_count: 0 }) } as Response;
      }
      return { ok: true, json: async () => ({ number: 1 }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('files an issue when none exists for the fingerprint', async () => {
    await reportError({ ...baseReport, fingerprint: 'fp-new' });
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes('/search/issues'))).toBe(true);
    expect(
      calls.some((u) => u.includes('/issues') && !u.includes('/search/')),
    ).toBe(true);
  });

  it('scrubs secrets from issue titles before creating', async () => {
    await reportError({
      ...baseReport,
      title:
        '[auto-fix] Bearer xy.z-1 in https://u:p@example.test/path?token=secret',
      fingerprint: 'fp-title',
    });
    const createCall = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/repos/'),
    );
    expect(createCall).toBeDefined();
    const init = createCall?.[1] as RequestInit | undefined;
    const payload = JSON.parse(String(init?.body)) as { title: string };
    expect(payload.title).toContain('Bearer <redacted>');
    expect(payload.title).toContain(
      'https://<credentials>@example.test/path?token=<redacted>',
    );
    expect(payload.title).not.toContain('xy.z-1');
    expect(payload.title).not.toContain('u:p');
    expect(payload.title).not.toContain('token=secret');
  });

  it('does not file when an open issue already carries the fingerprint', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/search/issues')) {
        return { ok: true, json: async () => ({ total_count: 1 }) } as Response;
      }
      throw new Error('should not create when a duplicate exists');
    });
    await reportError({ ...baseReport, fingerprint: 'fp-dupe' });
    const created = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/issues') && !u.includes('/search/'));
    expect(created).toHaveLength(0);
  });

  it('collapses repeats of the same fingerprint within the cooldown', async () => {
    await reportError({ ...baseReport, fingerprint: 'fp-flap' });
    await reportError({ ...baseReport, fingerprint: 'fp-flap' });
    const searches = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes('/search/issues'));
    expect(searches).toHaveLength(1);
  });

  it('is a no-op when disabled', async () => {
    process.env.AUTOFIX_DISABLED = '1';
    await reportError({ ...baseReport, fingerprint: 'fp-disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs but never creates in dry-run', async () => {
    process.env.AUTOFIX_DRY_RUN = '1';
    await reportError({ ...baseReport, fingerprint: 'fp-dry' });
    expect(fetchMock).not.toHaveBeenCalled();
    delete process.env.AUTOFIX_DRY_RUN;
    await reportError({ ...baseReport, fingerprint: 'fp-dry' });
    expect(fetchMock).toHaveBeenCalled();
  });

  it('skips silently when GitHub config is missing', async () => {
    delete process.env.GITHUB_AUTOFIX_TOKEN;
    await reportError({ ...baseReport, fingerprint: 'fp-noconf' });
    expect(fetchMock).not.toHaveBeenCalled();
    process.env.GITHUB_AUTOFIX_TOKEN = 'ghp_test';
    await reportError({ ...baseReport, fingerprint: 'fp-noconf' });
    expect(fetchMock).toHaveBeenCalled();
  });
});
