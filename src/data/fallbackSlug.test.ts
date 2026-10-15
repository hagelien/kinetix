/**
 * The offline fallback must carry the catalog slug (#133).
 *
 * The modelling run resolves a catalog-derived kinetics-core model by
 * `DrugComponent._slug` first. Registry keys are not always derivable from
 * the name (`paracetamol-acetaminophen`), so a fallback component without the
 * slug answered "not in the kinetics-core registry" precisely in the degraded
 * path. A separate file from `index.test.ts` because it replaces the fixture
 * module, and those tests exercise the real committed fixture.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDataCache, loadComponents } from './index';

vi.mock('../../data/components', () => ({
  embeddedComponents: [
    {
      name: 'Paracetamol',
      nameEn: 'Paracetamol',
      slug: 'paracetamol-acetaminophen',
      pubchemCid: 1983,
      halfLife: { min: 1.5, max: 3, unit: 'h' },
    },
    {
      // Hand-written / pre-slug entry: must still load, just without `_slug`.
      name: 'Etanol',
      nameEn: 'Ethanol',
      pubchemCid: 702,
    },
    {
      name: 'Blank',
      slug: '   ',
      pubchemCid: 1,
    },
  ],
}));

describe('loadComponents fallback — catalog slug', () => {
  beforeEach(() => {
    clearDataCache();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('transient network error')),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearDataCache();
  });

  it('maps the fixture slug onto _slug', async () => {
    const components = await loadComponents();
    const paracetamol = components.find((c) => c.pubchemCid === 1983);
    expect(paracetamol?._slug).toBe('paracetamol-acetaminophen');
  });

  it('still loads an entry without a slug, leaving _slug unset', async () => {
    const components = await loadComponents();
    const ethanol = components.find((c) => c.pubchemCid === 702);
    expect(ethanol).toBeDefined();
    expect(ethanol?.names).toEqual({ nb: 'Etanol', en: 'Ethanol' });
    expect(ethanol).not.toHaveProperty('_slug');
  });

  it('treats a blank slug as absent', async () => {
    const components = await loadComponents();
    expect(components.find((c) => c.pubchemCid === 1)).not.toHaveProperty(
      '_slug',
    );
  });
});
