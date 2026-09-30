/**
 * Server-side knowledge-governance orchestration — public surface.
 *
 * Phase 2 of docs/plans/2026-08-26-general-knowledge-governance-extraction.md:
 * the target-adapter boundary and its Kinetix implementations. Unlike the
 * `assurance-core` package, this layer is allowed to touch Drizzle and
 * Kinetix's tables — that is the point of it. What it must not do is decide
 * policy; that stays in the pure core.
 *
 * No Kinetix route imports any of this yet (§1.3, legacy-authoritative-until-
 * proven). It is exercised by the shadow queue, the store tests and the
 * backfill.
 *
 * Phase 3 adds `store/` — the generic `kg_*` persistence — and `backfill.ts`.
 * Those tables are additive and inert: Kinetix behaves identically whether they
 * are full or empty, which is the phase's safety property.
 *
 * Phase 4 adds `migration-state.ts`, `mirror.ts`, `metrics.ts` and
 * `reconciliation.ts`. This is the first phase whose code runs inside a live
 * Kinetix request — strictly after the legacy write, strictly observational,
 * and inert until a target type is advanced past `legacy_only`, which nothing
 * ships as. A mirror failure can never reject a Kinetix action (§12.4).
 *
 * Phase 5 adds `queue/` — an independent generic queue selector and a differ
 * that compares it against the live one. Nothing serves it;
 * `api/agent-verifications-queue.ts` remains the endpoint.
 *
 * Phase 6 adds `policy-shadow.ts`: the whole agent-consensus gate evaluated
 * generically, recorded in `shadow` mode, and compared against the legacy
 * outcome. `applyOnAgentConsensus` remains the only thing that publishes.
 *
 * Phase 7 adds `assurance-service.ts` — the first *read* cutover. Under
 * `generic_read` and beyond, a verification level may be served from the
 * generic records instead of the legacy calculation. It falls back to legacy
 * whenever the generic side is missing, incomplete or broken, because a badge
 * that under-reports review tells a reader a verified value is unverified.
 */

export * from './target-adapter.js';
export * from './registry.js';
export * from './actor-context.js';
export * from './shadow-queue.js';
export * from './store/postgres.js';
export * from './backfill.js';
export * from './migration-state.js';
export * from './metrics.js';
export * from './mirror.js';
export * from './reconciliation.js';
export * from './queue/generic-queue.js';
export * from './queue/compare.js';
export * from './policy-shadow.js';
export * from './assurance-service.js';
