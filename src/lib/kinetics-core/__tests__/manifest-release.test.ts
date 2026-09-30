/**
 * A run manifest must name the release it was actually served from.
 *
 * This could not be caught by inspection until the derived tier became non-empty: with
 * no derived entries, the flag-selected release hashes to exactly `REGISTRY_CHECKSUM`,
 * so stamping the reviewed constant and stamping the resolved release were
 * indistinguishable. They diverge the moment a derived model exists, and a manifest
 * naming a release that does not contain its own model defeats checksum-based replay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REGISTRY_CHECKSUM, resolvedRegistryRelease } from '../registry.js';
import { simulateScenario } from '../simulate.js';
import { GENERATED_REGISTRY_ARTIFACT } from '../generated-registry.js';
import type { CanonicalScenario } from '../types.js';

const scenario: CanonicalScenario = {
  schemaVersion: '1',
  analyte: 'amphetamine',
  subject: { weightKg: 70, age: 30, sex: 'male' },
  doses: [{ tHours: 0, amountMg: 30, route: 'oral', basis: 'active-moiety' }],
  timeGrid: { startHours: 0, endHours: 4, stepHours: 1 },
};

describe('run manifest — the release actually resolved', () => {
  it('stamps the resolved release, not a fixed constant', () => {
    const res = simulateScenario(scenario, '2026-01-01T00:00:00.000Z');
    if (!res.ok) throw new Error('expected ok');
    const release = resolvedRegistryRelease();
    expect(res.manifest.registryChecksum).toBe(release.checksum);
    expect(res.manifest.registryVersion).toBe(release.version);
  });

  it('is unchanged on the reviewed-only path', () => {
    // With the rollout flag off the release IS the reviewed tier, so the manifest
    // still carries exactly what it carried before. The fix must not move this.
    expect(resolvedRegistryRelease().checksum).toBe(REGISTRY_CHECKSUM);
  });

  it('the two checksums genuinely differ once a derived model exists', () => {
    // The regression guard. If this ever stops holding — the derived tier emptied,
    // say — the first test above passes vacuously and the bug could return unseen.
    expect(GENERATED_REGISTRY_ARTIFACT.derivedDefinitions.length).toBeGreaterThan(0);
    expect(GENERATED_REGISTRY_ARTIFACT.checksum).not.toBe(REGISTRY_CHECKSUM);
  });
});

// The three tests above all run with the rollout flag off (the suite's default
// environment), where `resolvedRegistryRelease()` returns exactly `REGISTRY_CHECKSUM`
// — so a `baseManifest` reverted to stamping that constant directly would still pass
// every one of them. Only with the flag on does a derived model's release diverge
// from the reviewed-only checksum, so this is the one path that actually exercises
// the bug the fix closes. Needs a fresh module graph: `derivedRegistryRolloutEnabled`
// reads `import.meta.env` and the resolved release is memoised on first read.
describe('run manifest — with the derived tier actually enabled', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('stamps the derived-tier release, not the reviewed-only constant, for a derived analyte', async () => {
    vi.stubEnv('VITE_DERIVED_REGISTRY_ENABLED', 'true');
    const { simulateScenario: simulateWithRollout } = await import('../simulate.js');
    const {
      REGISTRY_CHECKSUM: reviewedOnlyChecksum,
      resolvedRegistryRelease: resolvedWithRollout,
    } = await import('../registry.js');

    const derivedScenario: CanonicalScenario = {
      schemaVersion: '1',
      analyte: 'alprazolam',
      subject: { weightKg: 70, age: 30, sex: 'male' },
      doses: [{ tHours: 0, amountMg: 1, route: 'oral', basis: 'active-moiety' }],
      timeGrid: { startHours: 0, endHours: 4, stepHours: 1 },
    };
    const res = simulateWithRollout(derivedScenario, '2026-01-01T00:00:00.000Z');
    if (!res.ok) throw new Error(`expected ok, got ${res.failure}: ${res.detail}`);

    const release = resolvedWithRollout();
    // Sanity on the test itself: with the flag on, the resolved release must actually
    // be the derived-carrying one, and it must actually differ from the reviewed-only
    // constant — otherwise this test could pass without exercising anything new.
    expect(release.checksum).toBe(GENERATED_REGISTRY_ARTIFACT.checksum);
    expect(release.checksum).not.toBe(reviewedOnlyChecksum);

    expect(res.manifest.registryChecksum).toBe(release.checksum);
    expect(res.manifest.registryVersion).toBe(release.version);
  });
});
