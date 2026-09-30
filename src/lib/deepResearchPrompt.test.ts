import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DRUG_NAME_PLACEHOLDER,
  buildDrugSeedPrompt,
  extractSeedPrompt,
  fillDrugName,
} from './deepResearchPrompt';

/**
 * The clipboard payload behind the monograph's "Copy seed prompt" button is
 * derived from `agents/deep-research-drug-seeding.md` by string surgery, so the
 * markdown and this module are one contract with nothing between them. Every
 * way that contract can break is silent at the UI: the button still copies, the
 * paste still looks like a prompt, and the damage shows up as a research run
 * that asks about the wrong drug or reasons about Kinetix internals it was
 * never meant to see.
 *
 * The assertions therefore run against the real file, not a fixture.
 */
const PROMPT_PATH = resolve(process.cwd(), 'agents/deep-research-drug-seeding.md');
const markdown = readFileSync(PROMPT_PATH, 'utf8');

describe('extractSeedPrompt', () => {
  const prompt = extractSeedPrompt(markdown);

  it('keeps the prompt body', () => {
    expect(prompt).toContain('You are a scientific deep-research agent');
    expect(prompt).toContain('kinetix-deep-research-output-v1');
    // The registry tables are part of the prompt, not reference material
    // around it — an agent that never sees them researches nothing.
    expect(prompt).toContain('Parameter ID');
  });

  it('drops the operator preamble and the operator notes', () => {
    // Both describe importer machinery the research agent cannot see; the file
    // says in as many words not to paste them.
    expect(prompt).not.toContain('## How to use this file');
    expect(prompt).not.toContain('## Operator notes');
    expect(prompt).not.toContain('npm run import:research');
  });

  it('drops the markers themselves', () => {
    expect(prompt).not.toContain('PROMPT START');
    expect(prompt).not.toContain('PROMPT END');
  });

  it('still carries the drug placeholder to fill', () => {
    expect(prompt).toContain(DRUG_NAME_PLACEHOLDER);
  });

  it('throws when the markers are gone rather than copying the whole file', () => {
    expect(() => extractSeedPrompt('# Just a document\n')).toThrow(/markers not found/i);
  });
});

describe('fillDrugName', () => {
  it('substitutes every occurrence of the placeholder', () => {
    const filled = fillDrugName(
      `a ${DRUG_NAME_PLACEHOLDER} b ${DRUG_NAME_PLACEHOLDER}`,
      'cocaine',
    );
    expect(filled).toBe('a cocaine b cocaine');
  });

  it('inserts the name verbatim, trimmed', () => {
    expect(fillDrugName(DRUG_NAME_PLACEHOLDER, '  4-fluoroamphetamine \n')).toBe(
      '4-fluoroamphetamine',
    );
  });

  it('rejects an empty name instead of emitting a nameless prompt', () => {
    expect(() => fillDrugName(DRUG_NAME_PLACEHOLDER, '   ')).toThrow(/drug name is required/i);
  });

  it('rejects a prompt whose placeholder has been renamed', () => {
    // Silently returning the prompt unchanged would ship `[DRUG NAME]` to the
    // research agent — the exact manual step this button removes.
    expect(() => fillDrugName('## Input\n- Drug: `[SUBSTANCE]`', 'cocaine')).toThrow(
      /placeholder/i,
    );
  });
});

describe('buildDrugSeedPrompt', () => {
  it('loads the shipped markdown and returns it filled in', async () => {
    const prompt = await buildDrugSeedPrompt('cocaine');
    expect(prompt).toContain('**Drug/substance:** `cocaine`');
    expect(prompt).not.toContain(DRUG_NAME_PLACEHOLDER);
    expect(prompt).not.toContain('## Operator notes');
  });
});
