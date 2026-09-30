import { describe, expect, it } from 'vitest';
import {
  AGENT_STATUSES,
  allowedTransitions,
  canTransition,
  isAgentStatus,
} from '../agentStatus';

describe('agentStatus', () => {
  it('declares exactly three lifecycle states', () => {
    expect(AGENT_STATUSES).toEqual(['active', 'suspended', 'deactivated']);
  });

  it('recognises valid status strings via isAgentStatus', () => {
    expect(isAgentStatus('active')).toBe(true);
    expect(isAgentStatus('suspended')).toBe(true);
    expect(isAgentStatus('deactivated')).toBe(true);
    expect(isAgentStatus('draft')).toBe(false);
    expect(isAgentStatus(undefined)).toBe(false);
  });

  it('permits active ↔ suspended', () => {
    expect(canTransition('active', 'suspended')).toBe(true);
    expect(canTransition('suspended', 'active')).toBe(true);
  });

  it('permits transitions into deactivated from non-terminal states', () => {
    expect(canTransition('active', 'deactivated')).toBe(true);
    expect(canTransition('suspended', 'deactivated')).toBe(true);
  });

  it('treats deactivated as terminal', () => {
    expect(canTransition('deactivated', 'active')).toBe(false);
    expect(canTransition('deactivated', 'suspended')).toBe(false);
    expect(allowedTransitions('deactivated')).toEqual([]);
  });

  it('rejects no-op transitions', () => {
    expect(canTransition('active', 'active')).toBe(false);
    expect(canTransition('suspended', 'suspended')).toBe(false);
  });
});
