/**
 * The published-works registry is what turns a citation handle into a claim.
 *
 * These tests exist because the alternative was tried and failed: a check on
 * the handle's syntax passed a real PubMed identifier for an unrelated paper,
 * and that identifier authorised the only ENFSI strength statement in the
 * benzodiazepine module.
 */

import { describe, it, expect } from 'vitest';

import { PATTERN_MODULES } from './modules/index.js';
import { lookupWork, resolvesToPublishedWork } from './publishedWorks.js';
import type { PatternSubstanceModule } from './substanceModules.js';

/**
 * Every module the app ships, read from the registry rather than listed here.
 *
 * A hand-written list is a list somebody has to remember to extend, and the one
 * module it forgets is the newest — the one whose citations nobody has checked
 * yet. Reading `PATTERN_MODULES` means adding a module adds its citations to
 * this guard in the same commit.
 */
const MODULES: readonly PatternSubstanceModule[] = PATTERN_MODULES;

function everyCitation(module: PatternSubstanceModule) {
  return [
    ...module.features.flatMap((f) => f.referenceCitations ?? []),
    ...module.signals.flatMap((s) => s.referenceCitations),
    ...module.artefactRules.flatMap((r) => r.referenceCitations ?? []),
    ...module.enzymeEffects.flatMap((e) => e.referenceCitations ?? []),
    ...module.notEstablished.flatMap((n) => n.referenceCitations),
  ];
}

describe('the published-works registry', () => {
  it('registers every citation the shipped modules make', () => {
    // A handle nobody registered is a handle nobody checked. The method
    // disclosure prints these to a reader, so an unverified one is a citation
    // the screen vouches for and the repository does not.
    for (const module of MODULES) {
      for (const citation of everyCitation(module)) {
        expect(
          lookupWork(citation),
          `${module.id} cites ${citation.type}:${citation.identifier}, which is not registered`,
        ).toBeDefined();
      }
    }
  });

  it('records enough of each work to tell whether it is the right one', () => {
    // The failure this prevents is not a missing citation but a plausible
    // wrong one. A title and a container are what let the next reader notice
    // that a paper on enzymatic hydrolysis is not a creatinine study.
    for (const module of MODULES) {
      for (const citation of everyCitation(module)) {
        const work = lookupWork(citation)!;
        expect(work.title.length).toBeGreaterThan(10);
        expect(work.container.length).toBeGreaterThan(0);
        expect(work.year).toBeGreaterThan(1900);
      }
    }
  });

  it('refuses a handle nobody registered', () => {
    expect(resolvesToPublishedWork({ type: 'pmid', identifier: '11111111' })).toBe(false);
    expect(resolvesToPublishedWork({ type: 'doi', identifier: '10.9999/nope' })).toBe(false);
    expect(resolvesToPublishedWork(undefined)).toBe(false);
  });

  it('resolves a registered handle regardless of surrounding whitespace or case', () => {
    expect(resolvesToPublishedWork({ type: 'pmid', identifier: ' 19161663 ' })).toBe(true);
  });
});
