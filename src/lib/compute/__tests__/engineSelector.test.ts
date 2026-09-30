import { describe, it, expect, beforeEach } from 'vitest';
import {
  getComputeEngine,
  clearComputeEngineCache,
  resolveComputeMode,
} from '../engineSelector';
import { LiteBrowserEngine } from '../liteBrowserEngine';
import { FullRemoteEngine } from '../fullRemoteEngine';
import { LITE_CAPABILITIES, FULL_CAPABILITIES } from '../capabilities';

describe('getComputeEngine', () => {
  beforeEach(() => {
    clearComputeEngineCache();
  });

  it('returns the LiteBrowserEngine by default', () => {
    const engine = getComputeEngine({ mode: 'lite' });
    expect(engine).toBeInstanceOf(LiteBrowserEngine);
    expect(engine.id).toBe('lite-browser');
  });

  it('returns the FullRemoteEngine when mode=full', () => {
    const engine = getComputeEngine({ mode: 'full' });
    expect(engine).toBeInstanceOf(FullRemoteEngine);
    expect(engine.id).toBe('full-remote');
  });

  it('caches the Lite engine across calls', () => {
    const a = getComputeEngine({ mode: 'lite' });
    const b = getComputeEngine({ mode: 'lite' });
    expect(a).toBe(b);
  });

  it('does not cache the Full engine — a new instance per call', () => {
    const a = getComputeEngine({ mode: 'full' });
    const b = getComputeEngine({ mode: 'full' });
    expect(a).not.toBe(b);
  });

  it('resolveComputeMode falls back to "lite" for missing or unknown values', () => {
    expect(resolveComputeMode({ computeMode: undefined })).toBe('lite');
    expect(resolveComputeMode({ computeMode: 'lite' })).toBe('lite');
    expect(resolveComputeMode({ computeMode: 'unknown' })).toBe('lite');
    expect(resolveComputeMode({ computeMode: 'full' })).toBe('full');
  });
});

describe('engine capabilities', () => {
  it('Lite advertises exactly the spec-mandated capability set', () => {
    const lite = new LiteBrowserEngine();
    expect(lite.getCapabilities()).toEqual(LITE_CAPABILITIES);
  });

  it('Full advertises the lite set + the future Full-only capabilities', () => {
    const full = new FullRemoteEngine();
    expect(full.getCapabilities()).toEqual(FULL_CAPABILITIES);
    for (const cap of LITE_CAPABILITIES) {
      expect(full.getCapabilities()).toContain(cap);
    }
  });
});
