/**
 * The registry and review-packet entry points, gathered behind one object.
 *
 * The §25 inventory next door binds each capability to the function that
 * provides it, and importing three modules for two bullets would put the
 * plumbing in front of the list. Kept as a separate file rather than inline so
 * the inventory reads as an inventory.
 */
import { registerKnowledgeTargetAdapter } from '../../../api/_lib/knowledge-governance/registry.js';
import { sealReviewPacket } from 'assurance-core';

export const KNOWLEDGE_TARGET_REGISTRY_EXPORTS = {
  register: registerKnowledgeTargetAdapter,
  sealReviewPacket,
} as const;
