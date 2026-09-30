/**
 * Vendor-agnostic capability tiers for the models that back Kinetix agents.
 *
 * Peer verifiers run under different identities and, deliberately, different
 * model families (agents/drug-db-maintainer.md §0 runs the same cycle as e.g.
 * `kinetix-agent` and `codex-agent`, which peer-verify each other). A
 * capability-aware consensus gate therefore cannot key on one vendor's names —
 * it classifies the verifier's reported model string (stored nullable on
 * `agent_verifications.model`) into a tier and requires a flagship-tier verdict
 * before a high-risk agent-authored edit can auto-publish.
 *
 * This is a small, deliberately editable registry: add a pattern when a new
 * model id enters the pool. The one rule that must not change is the fail-safe
 * default — an unrecognised or missing model id classifies as `unknown`, which
 * NEVER satisfies the flagship gate. A model we cannot place must not be able to
 * stand in for a top-tier reviewer.
 */

export type ModelTier = 'flagship' | 'mid' | 'light' | 'unknown';

/**
 * The one tier trusted to satisfy the high-risk consensus gate. Kept as a named
 * constant so the gate (which compares the server-owned `agents.model_tier`
 * against it) and this vocabulary never drift.
 */
export const FLAGSHIP_TIER: ModelTier = 'flagship';

/**
 * The assignable tiers an admin can store on `agents.model_tier` (everything
 * except `unknown`, which is the absence of a classification — represented as
 * NULL, not a stored value). Used to validate the Admin API's create/patch
 * payloads.
 */
export const MODEL_TIERS = ['flagship', 'mid', 'light'] as const;

/**
 * A tier an admin can actually store — the union behind {@link MODEL_TIERS}.
 * `null` (unclassified) is modelled separately wherever it is accepted, so a
 * caller can never pass the `unknown` sentinel as if it were a stored value.
 */
export type AssignableModelTier = (typeof MODEL_TIERS)[number];

interface TierRule {
  /** Matched case-insensitively against the model id. */
  pattern: RegExp;
  tier: ModelTier;
}

/**
 * Checked in order, first match wins. Flagship patterns are listed first so a
 * more specific family name is never shadowed by a broader one. Keep vendors
 * grouped and commented so the registry stays legible as models turn over.
 */
const TIER_RULES: TierRule[] = [
  // Flagship — the strongest widely-released tier of each line.
  { pattern: /opus/i, tier: 'flagship' }, // Claude Opus 4.x / 5
  { pattern: /fable|mythos/i, tier: 'flagship' }, // Claude Fable / Mythos
  { pattern: /\bsol\b|[-_]sol\b/i, tier: 'flagship' }, // GPT-5.6 Sol

  // Mid — the routine scientific-worker tier.
  { pattern: /sonnet/i, tier: 'mid' }, // Claude Sonnet
  { pattern: /\bterra\b|[-_]terra\b/i, tier: 'mid' }, // GPT-5.6 Terra

  // Light — cheap/clerical tier; never trusted for scientific judgment.
  { pattern: /haiku/i, tier: 'light' }, // Claude Haiku
  { pattern: /\bluna\b|[-_]luna\b/i, tier: 'light' }, // GPT-5.6 Luna
];

/**
 * Classify a model id into a capability tier. `null`/`undefined`/empty and any
 * unrecognised id classify as `unknown` — the fail-safe direction for the
 * consensus gate below.
 */
export function classifyModelTier(model: string | null | undefined): ModelTier {
  if (!model) return 'unknown';
  const id = model.trim();
  if (!id) return 'unknown';
  for (const rule of TIER_RULES) {
    if (rule.pattern.test(id)) return rule.tier;
  }
  return 'unknown';
}

/**
 * True when the model is a flagship-tier model — the only tier that satisfies
 * the capability-aware consensus gate for a high-risk agent-authored edit. An
 * unknown/missing model is deliberately NOT flagship.
 */
export function isFlagshipTier(model: string | null | undefined): boolean {
  return classifyModelTier(model) === 'flagship';
}
