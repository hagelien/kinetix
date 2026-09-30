/**
 * Kinetix's host layer over the generic governance core: the policy set plus
 * the compatibility projections the legacy helpers delegate to.
 *
 * Separate from the core barrel (`../index.ts`) on purpose — importing the
 * generic core must never drag a host's policy in with it.
 */

export * from './policy.js';
export * from './projection.js';
