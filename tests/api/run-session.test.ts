import { describe, expect, it } from 'vitest';
import {
  currentRunSessionId,
  parseRunSessionId,
  runWithRunSessionCell,
  setRunSessionId,
} from '../../db/run-session.js';
import { agentVerifications, pendingEdits } from '../../db/schema.js';

describe('run session id', () => {
  it('accepts plain identifiers and rejects anything else', () => {
    expect(parseRunSessionId('0a1b2c3d-4e5f-6789-abcd-ef0123456789')).toBe(
      '0a1b2c3d-4e5f-6789-abcd-ef0123456789',
    );
    expect(parseRunSessionId(['abc', 'def'])).toBe('abc');
    expect(parseRunSessionId(undefined)).toBeNull();
    expect(parseRunSessionId('')).toBeNull();
    expect(parseRunSessionId('has space')).toBeNull();
    expect(parseRunSessionId("x'; drop table")).toBeNull();
    expect(parseRunSessionId('a'.repeat(129))).toBeNull();
  });

  it('is null outside a request and per-request inside one', async () => {
    expect(currentRunSessionId()).toBeNull();
    setRunSessionId('ignored'); // no cell: a no-op
    expect(currentRunSessionId()).toBeNull();

    const seen = await Promise.all([
      runWithRunSessionCell(async () => {
        setRunSessionId('sess-a');
        await new Promise((r) => setTimeout(r, 5));
        return currentRunSessionId();
      }),
      runWithRunSessionCell(async () => currentRunSessionId()),
    ]);
    expect(seen).toEqual(['sess-a', null]);
  });

  it('stamps both output tables by column default from the current request', () => {
    for (const col of [pendingEdits.runSessionId, agentVerifications.runSessionId]) {
      expect(runWithRunSessionCell(() => {
        setRunSessionId('sess-x');
        return col.defaultFn?.();
      })).toBe('sess-x');
      expect(col.defaultFn?.()).toBeNull();
    }
  });
});
