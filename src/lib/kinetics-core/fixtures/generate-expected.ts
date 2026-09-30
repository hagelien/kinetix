/**
 * Regenerate the golden parity artifacts from the current kinetics-core.
 *
 *   npx tsx src/lib/kinetics-core/fixtures/generate-expected.ts
 *
 * Emits:
 *   - parity-expected.json : golden CanonicalResult per scenario
 *   - prng-draws.json      : first N draws of PRNG(seed) for cross-runtime RNG parity
 *
 * These artifacts are committed and asserted (unchanged) by BOTH Kinetix and the
 * vendored Redose copy, so any divergence between the two apps — or any
 * accidental change to the engine — fails a test. Only run this deliberately
 * when an intended scientific change lands, and review the diff.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { simulateScenario } from '../simulate';
import type { CanonicalScenario } from '../types';
import { PRNG } from '../rng';

const here = dirname(fileURLToPath(import.meta.url));

interface FixtureFile {
  nowIso: string;
  scenarios: Array<{ name: string; scenario: CanonicalScenario }>;
}

const fixtures = JSON.parse(
  readFileSync(join(here, 'parity-scenarios.json'), 'utf8'),
) as FixtureFile;

const expected: Record<string, unknown> = {};
for (const { name, scenario } of fixtures.scenarios) {
  expected[name] = simulateScenario(scenario, fixtures.nowIso);
}
writeFileSync(join(here, 'parity-expected.json'), JSON.stringify(expected, null, 2) + '\n');

// Golden PRNG stream — locks the seeded draw sequence across V8 and Hermes.
const draws: Record<string, number[]> = {};
for (const seed of [42, 7, 12345]) {
  const rng = new PRNG(seed);
  draws[String(seed)] = Array.from({ length: 12 }, () => rng.next());
}
writeFileSync(join(here, 'prng-draws.json'), JSON.stringify(draws, null, 2) + '\n');

// eslint-disable-next-line no-console
console.log('Wrote parity-expected.json and prng-draws.json');
