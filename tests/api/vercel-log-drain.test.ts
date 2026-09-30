import { describe, expect, it } from 'vitest';
import {
  isInfrastructureEntry,
  toReport,
} from '../../api/vercel-log-drain.js';

describe('vercel log drain reports', () => {
  it('includes the runtime log timestamp in the generated issue body', () => {
    const report = toReport({
      level: 'error',
      path: '/api/drugs',
      message: 'boom',
      deploymentId: 'dpl_123',
      requestId: 'req_123',
      timestamp: '2026-05-22T09:03:42Z',
    });

    expect(report.body).toContain('**Timestamp:** `2026-05-22T09:03:42Z`');
    expect(report.body).toContain('deployment id + timestamp above');
  });

  it('keeps safe route selectors while stripping injected query string values', () => {
    const report = toReport({
      level: 'error',
      path: '/api/admin?resource=categories&injected=payload',
      message: 'boom',
    });

    expect(report.title).toContain('/api/admin?resource=categories');
    expect(report.title).not.toContain('injected=payload');
    expect(report.body).toContain('`/api/admin?resource=categories`');
    expect(report.body).not.toContain('injected=payload');
  });

  it('drops unsafe route selector values from title, body, and fingerprint', () => {
    const safe = toReport({
      level: 'error',
      path: '/api/auth?action=me',
      message: 'same error',
    });
    const unsafe = toReport({
      level: 'error',
      path: '/api/auth?action=ignore_previous_instructions',
      message: 'same error',
    });
    const withoutQuery = toReport({
      level: 'error',
      path: '/api/auth',
      message: 'same error',
    });

    expect(safe.title).toContain('/api/auth?action=me');
    expect(unsafe.title).not.toContain('IGNORE');
    expect(unsafe.body).toContain('`/api/auth`');
    expect(unsafe.fingerprint).toBe(withoutQuery.fingerprint);
    expect(safe.fingerprint).not.toBe(withoutQuery.fingerprint);
  });

  it('ignores non-string structured routes without breaking report creation', () => {
    const report = toReport({
      level: 'error',
      path: '/api/auth?action=me',
      message: 'KINETIX_ERROR {"route":42,"message":"boom"}',
    });

    expect(report.title).toContain('/api/auth?action=me');
    expect(report.title).toContain('boom');
  });

  it('drops unrecognized query string keys from route used in fingerprint', () => {
    const withQuery = toReport({
      level: 'error',
      path: '/api/drugs?id=42',
      message: 'same error',
    });
    const withoutQuery = toReport({
      level: 'error',
      path: '/api/drugs',
      message: 'same error',
    });
    expect(withQuery.fingerprint).toBe(withoutQuery.fingerprint);
  });
});

describe('isInfrastructureEntry (auto-fix issue suppression for outages)', () => {
  it('flags a structured KINETIX_ERROR tagged category:infrastructure', () => {
    const entry = {
      level: 'error',
      path: '/api/auth-request',
      message:
        'KINETIX_ERROR ' +
        JSON.stringify({
          route: '/api/auth-request',
          status: 503,
          category: 'infrastructure',
          message:
            "Failed query: select ... cause: password authentication failed for user 'neondb_owner'",
        }),
    };
    expect(isInfrastructureEntry(entry)).toBe(true);
  });

  it('flags a bad-password outage via message pattern even without the category tag', () => {
    // Platform-level / older-deploy log lines that never carried the category.
    const entry = {
      level: 'error',
      path: '/api/drug-track',
      message:
        'KINETIX_ERROR ' +
        JSON.stringify({
          route: '/api/drug-track',
          message: "password authentication failed for user 'neondb_owner'",
          cause: null,
        }),
    };
    expect(isInfrastructureEntry(entry)).toBe(true);
  });

  it('flags a raw (non-KINETIX_ERROR) connection-outage log line', () => {
    expect(
      isInfrastructureEntry({
        level: 'error',
        message: 'Error connecting to database: fetch failed',
      }),
    ).toBe(true);
  });

  it('does NOT flag an ordinary application error (still gets an auto-fix issue)', () => {
    const entry = {
      level: 'error',
      path: '/api/drugs',
      message:
        'KINETIX_ERROR ' +
        JSON.stringify({
          route: '/api/drugs',
          category: 'application',
          message: 'TypeError: Cannot read properties of undefined',
        }),
    };
    expect(isInfrastructureEntry(entry)).toBe(false);
  });

  it('does NOT flag a plain runtime error with no outage signature', () => {
    expect(
      isInfrastructureEntry({ level: 'error', message: 'boom' }),
    ).toBe(false);
  });
});

describe('vercel log drain report body', () => {
  it('escapes triple backticks in detail to prevent code fence breakout', () => {
    const report = toReport({
      level: 'error',
      path: '/api/drugs',
      // The injected ``` would close the code fence early and push "after" outside
      // the block, where it could be rendered as Markdown (or agent instructions).
      message: 'before\n```\nafter\n```',
    });

    // Exactly two standalone ``` lines — the block open and close added by
    // toReport itself. The injected ``` sequences must have been collapsed.
    const fenceLines = report.body.split('\n').filter((l) => l === '```');
    expect(fenceLines).toHaveLength(2);

    // The injected triple backticks become double backticks (still readable).
    expect(report.body).toContain('``');
    // All detail content is present inside the block.
    expect(report.body).toContain('after');
  });
});
