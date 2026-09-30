import { describe, it, expect } from 'vitest';
import { enzymeInteractionsWriteSchema } from '../../api/_lib/schemas';
import {
  isEnzymeInteractionRole,
  isEnzymeInteractionStrength,
} from '../../src/lib/enzymeInteractions';

describe('enzymeInteractionsWriteSchema', () => {
  it('accepts a full-replace set of interactions', () => {
    const parsed = enzymeInteractionsWriteSchema.parse({
      interactions: [
        { bioEntityId: 9, role: 'inhibitor', strength: 'strong' },
        { bioEntityId: 12, role: 'substrate', referenceIds: [3, 4] },
      ],
      editSummary: 'ritonavir is a strong CYP3A4 inhibitor',
    });
    expect(parsed.interactions).toHaveLength(2);
    expect(parsed.interactions[0].role).toBe('inhibitor');
  });

  it('defaults to an empty set', () => {
    expect(enzymeInteractionsWriteSchema.parse({}).interactions).toEqual([]);
  });

  it('rejects unknown roles and bad entity ids', () => {
    expect(() =>
      enzymeInteractionsWriteSchema.parse({
        interactions: [{ bioEntityId: 1, role: 'perpetrator' }],
      }),
    ).toThrow();
    expect(() =>
      enzymeInteractionsWriteSchema.parse({
        interactions: [{ bioEntityId: 0, role: 'inducer' }],
      }),
    ).toThrow();
  });
});

describe('enzyme interaction type guards', () => {
  it('validates roles', () => {
    expect(isEnzymeInteractionRole('inducer')).toBe(true);
    expect(isEnzymeInteractionRole('victim')).toBe(false);
  });
  it('validates strengths', () => {
    expect(isEnzymeInteractionStrength('moderate')).toBe(true);
    expect(isEnzymeInteractionStrength('huge')).toBe(false);
  });
});
