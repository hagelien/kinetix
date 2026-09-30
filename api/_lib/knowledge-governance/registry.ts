/**
 * The target-adapter registry (§4.5 of
 * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
 *
 * The review queue, proposal service and policy engine are meant to deal with
 * *registered target types* rather than a `switch (targetType)` block. This is
 * the lookup that makes that possible.
 *
 * Registration is keyed by `(space, type)`, not by `type` alone. A second
 * knowledge space is the whole reason §4.3 exists, and two spaces will
 * legitimately both govern something they each call `wiki_fact`; a type-only
 * key would silently let one space's adapter answer for the other's rows.
 *
 * Re-registering the same key throws rather than overwriting. A registry that
 * accepts the last writer is a registry where a stray import can quietly
 * replace the adapter that decides how a drug parameter gets written.
 */

import type { SpaceId, TargetType } from 'assurance-core';
import type { AnyKnowledgeTargetAdapter, KnowledgeTargetAdapter } from './target-adapter.js';

const adapters = new Map<string, AnyKnowledgeTargetAdapter>();

function key(space: SpaceId, type: TargetType): string {
  return `${space}/${type}`;
}

export class DuplicateAdapterError extends Error {
  constructor(space: SpaceId, type: TargetType) {
    super(
      `knowledge-governance: an adapter for '${key(space, type)}' is already registered`,
    );
    this.name = 'DuplicateAdapterError';
  }
}

export class UnknownTargetTypeError extends Error {
  constructor(space: SpaceId, type: TargetType) {
    super(`knowledge-governance: no adapter registered for '${key(space, type)}'`);
    this.name = 'UnknownTargetTypeError';
  }
}

export function registerKnowledgeTargetAdapter<TProposal, TCurrent>(
  adapter: KnowledgeTargetAdapter<TProposal, TCurrent>,
): void {
  const k = key(adapter.space, adapter.type);
  if (adapters.has(k)) throw new DuplicateAdapterError(adapter.space, adapter.type);
  adapters.set(k, adapter as AnyKnowledgeTargetAdapter);
}

/** The adapter for a target type, or `null` when none is registered. */
export function findKnowledgeTargetAdapter(
  space: SpaceId,
  type: TargetType,
): AnyKnowledgeTargetAdapter | null {
  return adapters.get(key(space, type)) ?? null;
}

/**
 * The adapter for a target type, throwing when none is registered.
 *
 * Callers routing a real proposal want the throw: silently doing nothing for an
 * unregistered type is the fail-open direction, and §1.6 requires governance
 * code to fail toward *withholding* publication, not toward skipping the check.
 */
export function getKnowledgeTargetAdapter(
  space: SpaceId,
  type: TargetType,
): AnyKnowledgeTargetAdapter {
  const adapter = findKnowledgeTargetAdapter(space, type);
  if (!adapter) throw new UnknownTargetTypeError(space, type);
  return adapter;
}

/** Every type registered for a space, sorted, for diagnostics and coverage tests. */
export function registeredTargetTypes(space: SpaceId): TargetType[] {
  const prefix = `${space}/`;
  return [...adapters.keys()]
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .sort();
}

/**
 * Drop every registration. Test-only: the registry is module-level state, and a
 * suite that registers adapters would otherwise leak into the next file that
 * imports the module in the same worker.
 */
export function resetKnowledgeTargetAdaptersForTests(): void {
  adapters.clear();
}
