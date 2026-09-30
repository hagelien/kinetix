import { describe, expect, it } from 'vitest';
import { userLabel } from './userLabel';

describe('userLabel', () => {
  it('uses displayName when set', () => {
    expect(userLabel({ username: 'alice', displayName: 'Alice Smith' })).toBe(
      'Alice Smith',
    );
  });

  it('falls back to username when displayName is null', () => {
    expect(userLabel({ username: 'alice', displayName: null })).toBe('alice');
  });

  it('falls back to username when displayName is whitespace', () => {
    expect(userLabel({ username: 'alice', displayName: '   ' })).toBe('alice');
  });

  it('returns Unknown for null/undefined input', () => {
    expect(userLabel(null)).toBe('Unknown');
    expect(userLabel(undefined)).toBe('Unknown');
  });

  it('returns Unknown when username is also missing', () => {
    expect(userLabel({ displayName: null })).toBe('Unknown');
  });
});
