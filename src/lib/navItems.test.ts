import { describe, expect, it } from 'vitest';
import { NAV_ITEM_DEFS, NAV_ITEM_IDS, isNavItemId } from './navItems';

describe('nav item registry', () => {
  it('gives every item a unique id', () => {
    const ids = NAV_ITEM_DEFS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not list the drug table — it is not configurable, always visible', () => {
    const destinations: readonly string[] = NAV_ITEM_DEFS.map(
      (item) => item.to,
    );
    expect(destinations.includes('/')).toBe(false);
  });

  it('exposes every id through isNavItemId, and rejects anything else', () => {
    for (const id of NAV_ITEM_IDS) {
      expect(isNavItemId(id)).toBe(true);
    }
    expect(isNavItemId('gone.away')).toBe(false);
    expect(isNavItemId(42)).toBe(false);
    expect(isNavItemId(undefined)).toBe(false);
  });
});
