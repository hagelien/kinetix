import { describe, expect, it } from 'vitest';
import { receptorTargetsWriteSchema } from '../../api/_lib/schemas';

describe('receptorTargetsWriteSchema', () => {
  it('fills defaults for an empty payload', () => {
    const r = receptorTargetsWriteSchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.mechanisms).toEqual([]);
  });

  it('accepts a mechanism linked to an existing catalog target', () => {
    const r = receptorTargetsWriteSchema.safeParse({
      mechanisms: [
        {
          receptorTargetId: 7,
          interactionType: 'antagonist',
          tier: 'primary',
          ki: { median: 2.4, unit: 'nmol/L' },
          referenceIds: [3, 4],
        },
      ],
      editSummary: 'add SERT antagonism',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.mechanisms[0]?.interactionType).toBe('antagonist');
      expect(r.data.mechanisms[0]?.tier).toBe('primary');
    }
  });

  it('accepts a new target supplied by symbol + name and defaults the interaction', () => {
    const r = receptorTargetsWriteSchema.safeParse({
      mechanisms: [{ targetSymbol: 'D3', targetName: 'Dopamine D3 receptor' }],
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.mechanisms[0]?.interactionType).toBe('unspecified');
      expect(r.data.mechanisms[0]?.tier ?? null).toBeNull();
    }
  });

  it('rejects a mechanism with neither an id nor a symbol/name', () => {
    expect(
      receptorTargetsWriteSchema.safeParse({
        mechanisms: [{ interactionType: 'agonist' }],
      }).success,
    ).toBe(false);
    // A symbol alone (no name) is not enough to create a target.
    expect(
      receptorTargetsWriteSchema.safeParse({
        mechanisms: [{ targetSymbol: 'D3' }],
      }).success,
    ).toBe(false);
  });

  it('rejects an invalid tier and an empty interaction type', () => {
    expect(
      receptorTargetsWriteSchema.safeParse({
        mechanisms: [{ receptorTargetId: 1, tier: 'quaternary' }],
      }).success,
    ).toBe(false);
    expect(
      receptorTargetsWriteSchema.safeParse({
        mechanisms: [{ receptorTargetId: 1, interactionType: '' }],
      }).success,
    ).toBe(false);
  });
});
