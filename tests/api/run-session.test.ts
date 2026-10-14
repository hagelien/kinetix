/**
 * The run-session header (issue #214): which agent run wrote an output. The
 * value lands in a varchar(128) and in the tier benchmark's matching, so
 * anything that is not a plain opaque id is dropped, never stored.
 */
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  RUN_SESSION_HEADER,
  RUN_SESSION_ID_MAX_LENGTH,
  parseRunSessionId,
  readRunSessionHeader,
  runSessionInsert,
} from '../../api/_lib/run-session.js';

describe('parseRunSessionId', () => {
  it('accepts a Claude Code or Codex session UUID', () => {
    expect(parseRunSessionId('0f9c2b1e-7d4a-4c1b-9e2f-3a5b6c7d8e9f')).toBe(
      '0f9c2b1e-7d4a-4c1b-9e2f-3a5b6c7d8e9f',
    );
  });

  it('accepts other opaque ids and trims surrounding whitespace', () => {
    expect(parseRunSessionId('run_2026.10.14:a-1')).toBe('run_2026.10.14:a-1');
    expect(parseRunSessionId('  sess-1 ')).toBe('sess-1');
  });

  it('accepts exactly the column width and refuses one more', () => {
    const max = 'a'.repeat(RUN_SESSION_ID_MAX_LENGTH);
    expect(parseRunSessionId(max)).toBe(max);
    expect(parseRunSessionId(`${max}a`)).toBeNull();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '   '],
    ['inner whitespace', 'sess 1'],
    // Node joins a repeated custom header with ", ".
    ['a repeated header', 'sess-1, sess-2'],
    ['markup', '<script>'],
    ['a path', '../etc/passwd'],
    ['a leading dash', '-rf'],
    ['non-ASCII', 'økt-1'],
    ['a header array', ['sess-1']],
  ])('drops %s', (_label, raw) => {
    expect(parseRunSessionId(raw as string | string[] | undefined)).toBeNull();
  });
});

describe('readRunSessionHeader', () => {
  const req = (headers: Record<string, string>) =>
    ({ headers }) as unknown as IncomingMessage;

  it('reads the lower-cased header Node exposes', () => {
    expect(RUN_SESSION_HEADER).toBe('x-kinetix-run-session');
    expect(readRunSessionHeader(req({ [RUN_SESSION_HEADER]: 'sess-1' }))).toBe(
      'sess-1',
    );
  });

  it('is null without the header, or without headers at all', () => {
    expect(readRunSessionHeader(req({}))).toBeNull();
    expect(readRunSessionHeader({} as IncomingMessage)).toBeNull();
  });
});

describe('runSessionInsert', () => {
  it('stamps the run of an agent context that named one', () => {
    expect(runSessionInsert({ runSessionId: 'sess-1' })).toEqual({
      runSessionId: 'sess-1',
    });
  });

  it('adds no column for a person or an agent that named no run', () => {
    expect(runSessionInsert({})).toEqual({});
    expect(runSessionInsert({ runSessionId: null })).toEqual({});
    expect(runSessionInsert({ runSessionId: undefined })).toEqual({});
  });
});
