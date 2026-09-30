import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  metabolismWriteSchema,
  receptorTargetsWriteSchema,
} from '../api/_lib/schemas';
import { DRUG_COVERAGE_AREA_IDS } from '../src/lib/drugCoverageAreas';

/**
 * The coverage lane's write instructions must not drift from the write schemas.
 *
 * Both relationship endpoints are FULL REPLACEMENT, and both write schemas are
 * plain `z.object`s: they strip keys they do not know and `.default([])` every
 * collection. So a body whose keys do not line up does not fail — it validates
 * as "replace all of it with nothing", and approving the proposal deletes the
 * drug's routes, metabolite edges and mechanisms. Nothing in the stack refuses
 * it, which is exactly why the prompt has to carry the mapping and why the
 * mapping needs a test: `agents/drug-db-maintainer.md` is the only place the
 * maintenance routine learns these shapes, and a renamed write key would
 * otherwise be discovered as missing catalog data.
 *
 * The first version of that instruction said "read the current box and send it
 * back", which is precisely the destructive body. These assertions run in both
 * directions — every write key documented, and nothing documented that is not a
 * write key — so neither the schema nor the prompt can move alone.
 */

const PROMPT_PATH = resolve(process.cwd(), 'agents/drug-db-maintainer.md');
const prompt = readFileSync(PROMPT_PATH, 'utf8');

/**
 * The payload keys a caller actually builds, i.e. the schema's own shape minus
 * the two review-flow extras every write route accepts. Read off the schema so
 * a rename breaks this test rather than the catalog.
 */
function payloadKeys(shape: Record<string, unknown>): string[] {
  return Object.keys(shape).filter(
    (key) => key !== 'editSummary' && key !== 'submitForReview',
  );
}

/**
 * Whether the prompt names this key as a key rather than in passing.
 *
 * The document writes a collection key either bare (`` `routes` ``) or with the
 * array suffix the mapping table uses (`` `routes[]` ``), and a JSON example
 * quotes it (`"precursorDrugId":`). All three are the key being named; the
 * surrounding delimiter is what keeps `routes` in ordinary prose from
 * counting.
 */
function namesKey(key: string): boolean {
  return new RegExp(`[\`"]${key}(\\[\\])?[\`"]`).test(prompt);
}

describe('the coverage lane write instructions', () => {
  it('names every metabolism write key, and no key the schema lacks', () => {
    const keys = payloadKeys(metabolismWriteSchema.shape);
    // Guard the guard: if the schema is ever flattened this test would pass
    // vacuously while the prompt documents a shape that no longer exists.
    expect(keys).toEqual(['profile', 'routes', 'metabolites', 'precursors']);

    for (const key of keys) {
      expect(namesKey(key), `metabolism write key ${key}`).toBe(true);
    }
  });

  it('names every receptor-targets write key', () => {
    const keys = payloadKeys(receptorTargetsWriteSchema.shape);
    expect(keys).toEqual(['mechanisms']);

    for (const key of keys) {
      expect(namesKey(key), `receptor-targets write key ${key}`).toBe(true);
    }
  });

  it('warns that the read keys are not write keys', () => {
    // The two wrappers a read hands back. Posting either verbatim is the
    // silent full-replacement-with-nothing, so the prompt has to say so by
    // name rather than leaving "remap it" as an exercise.
    expect(prompt).toContain('`metabolism` is not a write key');
    expect(prompt).toContain('`receptorTargets` is not a write key');
  });

  it('spells out the precursor remap, which no field name suggests', () => {
    // `precursorDrugId` is the one value a caller cannot copy across: on a
    // precursor row read from the other end it is `parentDrugId`, while
    // `metaboliteName` names the drug being edited rather than the precursor.
    expect(namesKey('precursorDrugId')).toBe(true);
    expect(namesKey('parentDrugId')).toBe(true);
  });

  it('documents a write endpoint for every coverage area', () => {
    // A new area with a gap-queue lane but no write instruction would be
    // served forever and closed by nobody.
    const endpoints: Record<(typeof DRUG_COVERAGE_AREA_IDS)[number], string> = {
      metabolism: 'PUT /api/drug-metabolism?drugId=',
      pharmacodynamics: 'PUT /api/drug-receptor-targets?drugId=',
    };
    for (const area of DRUG_COVERAGE_AREA_IDS) {
      expect(prompt, `${area} write endpoint`).toContain(endpoints[area]);
    }
  });

  it('does not tell the routine to post the read body back unchanged', () => {
    // The exact wording of the finding this test exists for. Kept as a
    // negative assertion because the destructive instruction reads as
    // perfectly reasonable advice.
    expect(prompt).not.toMatch(/send it back with your addition/i);
  });
});
