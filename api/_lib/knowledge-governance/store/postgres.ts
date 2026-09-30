/**
 * The Postgres-backed governance store, composed.
 *
 * One object grouping the module functions, so a caller takes a single
 * dependency and a test can substitute the whole surface. The functions stay
 * individually importable — this is a convenience, not a gate — and every one
 * still takes its database handle first, so a caller can pass a transaction
 * rather than the pooled handle when shadow writes have to join the host's
 * ambient transaction (§12.3.1).
 *
 * There is no `updateAssessment`, no `deleteVersion`, no `editRuling`. The
 * absence is the append-only enforcement: a caller that wants to rewrite a
 * judgment has to reach past this store to do it, which is visible in review.
 */

import * as assessments from './assessments.js';
import * as audit from './audit.js';
import * as decisions from './decisions.js';
import * as disputes from './disputes.js';
import * as evidence from './evidence.js';
import * as legacyLinks from './legacy-links.js';
import * as proposals from './proposals.js';
import * as spaces from './spaces.js';
import * as versions from './versions.js';

export const governanceStore = {
  spaces: {
    ensure: spaces.ensureSpace,
    find: spaces.findSpace,
    setActivePolicyVersion: spaces.setActivePolicyVersion,
  },
  targets: {
    ensure: spaces.ensureTarget,
    find: spaces.findTarget,
  },
  proposals: {
    create: proposals.createProposal,
    get: proposals.getProposal,
    setState: proposals.setProposalState,
    setCurrentVersion: proposals.setCurrentVersion,
    recomputeProjection: proposals.recomputeProjection,
    listOpen: proposals.listOpenProposals,
    findByLegacyPendingEdit: proposals.findProposalByLegacyPendingEdit,
  },
  versions: {
    append: versions.appendVersion,
    get: versions.getVersion,
    list: versions.listVersions,
    latest: versions.latestVersion,
    markSubmitted: versions.markSubmitted,
  },
  assessments: {
    record: assessments.recordAssessment,
    revise: assessments.reviseAssessment,
    list: assessments.listAssessments,
    current: assessments.currentAssessments,
    currentForSubjects: assessments.currentAssessmentsForSubjects,
    historyForActor: assessments.assessmentHistoryForActor,
  },
  disputes: {
    open: disputes.openDispute,
    get: disputes.getDispute,
    rule: disputes.recordRuling,
    rulings: disputes.listRulings,
    latestRuling: disputes.latestRuling,
    listOpen: disputes.openDisputes,
  },
  decisions: {
    record: decisions.recordPolicyDecision,
    recordCore: decisions.recordCoreDecision,
    listForVersion: decisions.listDecisionsForVersion,
    latestForVersion: decisions.latestDecisionForVersion,
    recordPublication: decisions.recordPublicationEvent,
    publicationEvents: decisions.listPublicationEvents,
  },
  evidence: {
    ensureItem: evidence.ensureEvidenceItem,
    findItem: evidence.findEvidenceItem,
    link: evidence.linkEvidence,
    forSubject: evidence.evidenceForSubject,
  },
  audit: {
    record: audit.recordAuditEvent,
    forSubject: audit.listAuditEvents,
    byType: audit.listAuditEventsByType,
  },
  legacyLinks: {
    link: legacyLinks.linkLegacyRecord,
    findByGeneric: legacyLinks.findByGeneric,
    findByLegacy: legacyLinks.findByLegacy,
  },
} as const;

export type GovernanceStore = typeof governanceStore;

export * from './interface.js';
export * from './spaces.js';
export * from './proposals.js';
export * from './versions.js';
export * from './assessments.js';
export * from './disputes.js';
export * from './decisions.js';
export * from './evidence.js';
export * from './audit.js';
export * from './legacy-links.js';
