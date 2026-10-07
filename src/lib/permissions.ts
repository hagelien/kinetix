/**
 * Capability matrix (#310 follow-up).
 *
 * `src/lib/roles.ts` gives the four-tier ladder
 * (`authenticated < contributor < editor < admin`). This module turns the
 * hardcoded "which tier may do what" checks that were scattered across the
 * API and the React components into a single, granular, *adjustable*
 * registry: every gated action is a named capability with a default minimum
 * tier, and admins may raise or lower that tier at runtime from
 * Admin → Permissions (persisted in `permission_overrides`).
 *
 * Invariants that keep the matrix safe to hand to an admin:
 *   - The ladder stays monotone. A capability stores ONE minimum tier, so
 *     granting it to contributors necessarily grants it to editors and
 *     admins too — there is no way to produce a hole where a higher tier
 *     loses something a lower tier has.
 *   - `floorTier` is the lowest tier an admin may select. Write and review
 *     capabilities floor at `authenticated` or above so nothing that mutates
 *     content can ever be handed to anonymous callers.
 *   - `locked: true` capabilities are not adjustable at all. These are the
 *     privilege-granting ones (user roles, this matrix itself): an editor who
 *     could edit the matrix could grant themselves everything, so that door
 *     stays admin-only by construction rather than by policy.
 *   - Raising a capability to `admin` is always allowed; the ceiling is never
 *     below the default.
 *
 * The registry is compiled into both the server bundle and the client bundle;
 * only the *overrides* travel over the wire (`GET /api/permissions`).
 */

import { ROLES, type Role } from './roles.js';

/**
 * Tiers the matrix can address. This is the role ladder plus `anonymous`
 * (no session) so the matrix can express "public" as a real value rather
 * than an absence. `anonymous` is not a `Role` — it is never stored on a
 * user row.
 */
export const PERMISSION_TIERS = [
  'anonymous',
  ROLES.authenticated,
  ROLES.contributor,
  ROLES.editor,
  ROLES.admin,
] as const;

export type PermissionTier = (typeof PERMISSION_TIERS)[number];

const TIER_RANK: Record<PermissionTier, number> = {
  anonymous: 0,
  authenticated: 1,
  contributor: 2,
  editor: 3,
  admin: 4,
};

export function isPermissionTier(value: unknown): value is PermissionTier {
  return typeof value === 'string' && value in TIER_RANK;
}

/** The tier a caller occupies. Anonymous (no session) is `anonymous`. */
export function tierForRole(
  role: string | null | undefined,
): PermissionTier {
  if (!role) return 'anonymous';
  return isPermissionTier(role) && role !== 'anonymous' ? role : 'anonymous';
}

/** Capability groups, used to section the admin matrix UI. */
export const CAPABILITY_GROUPS = [
  'read',
  'community',
  'contribute',
  'review',
  'registry',
  'admin',
] as const;

export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

export interface CapabilityDef {
  /** Stable id; persisted in `permission_overrides.capability`. */
  readonly id: string;
  readonly group: CapabilityGroup;
  /** Tier required when no override is stored — today's shipped behavior. */
  readonly defaultTier: PermissionTier;
  /** Lowest tier an admin may select for this capability. */
  readonly floorTier: PermissionTier;
  /** Not adjustable: privilege-granting or structurally fixed. */
  readonly locked?: true;
  /**
   * Where the capability is enforced. Language-neutral technical hint shown
   * as code chips in the admin UI (server responses stay language-neutral;
   * the client translates only the prose around it).
   */
  readonly enforcedAt: readonly string[];
  /**
   * Extra access paths that bypass the tier check entirely, e.g. a feature
   * group. Shown in the UI so an admin is not surprised that lowering the
   * tier is not the only way in.
   */
  readonly alsoGrantedBy?: readonly string[];
}

export const CAPABILITY_LIST = [
  // ─── Reading ────────────────────────────────────────────────────────────
  {
    id: 'content.read.published',
    group: 'read',
    defaultTier: 'anonymous',
    floorTier: 'anonymous',
    locked: true,
    enforcedAt: ['GET /api/drugs', 'GET /api/wiki/pages', 'GET /api/references'],
  },
  {
    id: 'wiki.draft.read',
    group: 'read',
    defaultTier: 'editor',
    floorTier: 'contributor',
    enforcedAt: ['GET /api/wiki/pages', 'GET /api/agent-sweep'],
  },
  {
    id: 'wiki.history.read',
    group: 'read',
    defaultTier: 'editor',
    floorTier: 'contributor',
    enforcedAt: ['GET /api/wiki/history'],
  },
  {
    id: 'methods.read',
    group: 'read',
    defaultTier: 'admin',
    floorTier: 'authenticated',
    enforcedAt: ['GET /api/methods', 'GET /api/drugs?methodId='],
    alsoGrantedBy: ['group:rettstoks'],
  },
  {
    id: 'learn.read',
    group: 'read',
    defaultTier: 'admin',
    floorTier: 'authenticated',
    enforcedAt: ['/api/learning-units', '/api/clinical-cases'],
    alsoGrantedBy: ['group:kinetix-learn'],
  },
  {
    // Postmortem concentration distributions. Gated like the analytical
    // methods: the shipped cohort is unpublished conference material a
    // forensic laboratory shared, and a percentile from autopsy findings is
    // easy to misread as a lethal threshold by anyone without the context.
    // `floorTier` is `authenticated` rather than `anonymous` for that reason —
    // no configuration can put this material in front of the public.
    id: 'pmConcentrations.read',
    group: 'read',
    defaultTier: 'admin',
    floorTier: 'authenticated',
    enforcedAt: ['GET /api/pm-concentrations'],
    alsoGrantedBy: ['group:rettstoks'],
  },
  {
    // Rettstoksikologi's own urine detection times, transcribed from the
    // section's approved guideline. Gated like the methods and the postmortem
    // cohort, and for the same reason: these bands are one laboratory's agreed
    // statement for its own cut-offs, not a pooled literature window, and the
    // guideline they come from is an internal restricted document. `floorTier`
    // is `authenticated` so no configuration can put it in front of the public.
    id: 'refsDetectionTimes.read',
    group: 'read',
    defaultTier: 'admin',
    floorTier: 'authenticated',
    enforcedAt: ['GET /api/refs-detection-times'],
    alsoGrantedBy: ['group:rettstoks'],
  },
  {
    id: 'review.queue.readAll',
    group: 'read',
    defaultTier: 'editor',
    floorTier: 'contributor',
    enforcedAt: ['GET /api/pending-edits'],
  },
  {
    id: 'dispute.queue.read',
    group: 'read',
    defaultTier: 'editor',
    floorTier: 'contributor',
    enforcedAt: ['GET /api/disputes'],
    alsoGrantedBy: ['active agent'],
  },
  {
    id: 'paperExtraction.queue.read',
    group: 'read',
    defaultTier: 'editor',
    floorTier: 'contributor',
    enforcedAt: ['GET /api/paper-extractions'],
  },

  // ─── Community ──────────────────────────────────────────────────────────
  {
    id: 'discussion.comment.create',
    group: 'community',
    defaultTier: 'authenticated',
    floorTier: 'authenticated',
    enforcedAt: ['POST /api/drug-discussions'],
  },
  {
    id: 'approval.stamp.add',
    group: 'community',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: ['POST /api/approvals'],
  },
  {
    id: 'dispute.open',
    group: 'community',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: ['POST /api/disputes'],
  },
  {
    id: 'dispute.resolve',
    group: 'community',
    defaultTier: 'editor',
    floorTier: 'contributor',
    enforcedAt: ['PATCH /api/disputes'],
  },

  // ─── Contributing (queued edits) ────────────────────────────────────────
  {
    id: 'edit.parameter.submit',
    group: 'contribute',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: ['POST /api/drug-parameter', 'POST /api/pending-edits'],
  },
  {
    id: 'edit.parameterEntry.submit',
    group: 'contribute',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: ['POST|PATCH|DELETE /api/parameter-entries'],
  },
  {
    id: 'edit.metabolism.submit',
    group: 'contribute',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: ['PUT /api/drug-metabolism'],
  },
  {
    id: 'edit.receptorTarget.submit',
    group: 'contribute',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: ['POST /api/drug-receptor-targets'],
  },
  {
    id: 'edit.enzymeInteraction.submit',
    group: 'contribute',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: ['POST /api/drug-enzyme-interactions'],
  },
  {
    id: 'edit.bioEntity.submit',
    group: 'contribute',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: ['POST|PATCH /api/bio-entities'],
  },
  {
    id: 'edit.wikiFact.submit',
    group: 'contribute',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: ['POST /api/pending-edits (wiki_fact, wiki_section)'],
  },
  {
    id: 'edit.learning.submit',
    group: 'contribute',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: ['POST /api/pending-edits (learning_unit, clinical_case)'],
  },
  {
    id: 'reference.create',
    group: 'contribute',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: ['POST /api/references', 'POST /api/references-resolve'],
  },
  {
    id: 'reference.update',
    group: 'contribute',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: ['PATCH /api/references'],
  },
  {
    /**
     * Supply full text for a citation, and — for the agents that extract from
     * it — read the stored bytes back.
     *
     * This is deliberately no longer a download permission for people.
     * `GET /api/citation-pdf` additionally requires the caller to back an
     * active agent, because serving a stored publisher PDF to a human is
     * redistribution of licensed material that the product does not need:
     * a reader follows the citation's own source link instead. The one
     * human-facing exception is `citation.pdf.share`, which is an admin
     * decision with an expiry attached.
     */
    id: 'citation.pdf.access',
    group: 'contribute',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: [
      'POST /api/citation-pdf',
      'GET /api/citation-pdf (active agents only)',
      '/api/citation-pdf-upload',
    ],
  },
  {
    id: 'pdfRequest.create',
    group: 'contribute',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: ['POST /api/pdf-requests'],
  },
  {
    /**
     * Drop full-text PDFs into the inbox in bulk, before anything says which
     * citation they belong to.
     *
     * Same tier as supplying full text one paper at a time
     * (`citation.pdf.access`), because it is the same act — the difference is
     * only that the link to a citation is established afterwards. Crucially it
     * is NOT a grant to establish that link: uploading leaves the bytes
     * unattached, and every attachment still goes through
     * `pdfInbox.resolve` and, where it would overwrite stored full text,
     * `citation.pdf.replace`.
     */
    id: 'pdfInbox.upload',
    group: 'contribute',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: ['/api/pdf-inbox-upload'],
  },
  {
    /**
     * Say which citation an inbox PDF belongs to — and drop one that belongs
     * to none.
     *
     * Contributor, because attaching produces exactly the state a contributor
     * can already produce by uploading from the reference page: a
     * `citation_pdfs` row plus a fulfilled request. It carries no authority to
     * *replace* full text already on file; that remains `citation.pdf.replace`
     * (editor), checked on top of this one, so the bulk path cannot become a
     * side door around a gate the single-file path holds.
     */
    id: 'pdfInbox.resolve',
    group: 'contribute',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: [
      'GET /api/pdf-inbox',
      'POST /api/pdf-inbox (attach, rematch, autoAttach)',
      'DELETE /api/pdf-inbox',
    ],
  },
  {
    id: 'paperExtraction.claim',
    group: 'contribute',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: [
      'GET /api/paper-extractions?view=mine',
      'POST /api/paper-extractions?action=claim',
      'PATCH /api/paper-extractions (claim-holder actions)',
    ],
  },
  {
    id: 'citation.pdf.replace',
    group: 'contribute',
    defaultTier: 'editor',
    floorTier: 'contributor',
    enforcedAt: [
      'POST /api/pdf-requests (replace)',
      'POST /api/citation-pdf',
      'POST /api/citation-pdf-upload',
    ],
  },
  {
    /**
     * Mint a short-lived, unauthenticated download URL for a stored PDF.
     *
     * Every other way to reach stored full text asks who the caller is:
     * `citation.pdf.access` gates the streaming proxy, and the Blob objects
     * themselves are private. A share link is the deliberate exception —
     * whoever holds the URL downloads the bytes, with no account and no tier.
     * That makes minting one a decision about *publishing* licensed full text
     * rather than about reading it, which is why it defaults to `admin` even
     * though reading defaults to `contributor`.
     *
     * `floorTier: 'contributor'` is where an admin may delegate it: to the
     * tier that can already read the same bytes, and no lower. Handing it to
     * every signed-up account would make "anyone who registers" equivalent to
     * "anyone at all" for the whole PDF corpus, and the matrix must not be
     * able to express that.
     *
     * Links expire (see PDF_SHARE_TTL_SECONDS) and are bound to the stored
     * bytes, so replacing a citation's full text invalidates the outstanding
     * links for it.
     *
     * Held *in addition to* `citation.pdf.access`, never instead of it. The
     * two ranges overlap — `access` may be raised to admin while this one is
     * delegated to contributor — and a link that needs no account is a
     * superset of reading, so the route and the UI both require the pair or
     * the runtime matrix could invert the two.
     */
    id: 'citation.pdf.share',
    group: 'contribute',
    defaultTier: 'admin',
    floorTier: 'contributor',
    enforcedAt: ['POST /api/citation-pdf-share'],
  },
  {
    id: 'paperReview.submit',
    group: 'contribute',
    defaultTier: 'contributor',
    floorTier: 'authenticated',
    enforcedAt: ['POST /api/paper-reviews'],
  },

  // ─── Reviewing ──────────────────────────────────────────────────────────
  {
    /**
     * Clinical expert sign-off on a clinical case (Phase 11 of
     * docs/plans/2026-08-26-general-knowledge-governance-extraction.md).
     *
     * A clinical case's invariant is not quorum mathematics: a human with
     * clinical standing must sign it off. Until now that was expressed only as
     * a hardcoded refusal in `applyOnAgentConsensus` — agent consensus simply
     * never publishes a `clinical_case`. That is safe and it is not
     * *auditable*: nothing records who was qualified to sign one off, so
     * nothing can later show that the person who did was.
     *
     * Naming the requirement makes it snapshottable. The generic policy asks
     * for "a human approval carrying this capability" and the capability
     * snapshot on the assessment records that the approver held it at the time
     * — the same reason `agent_verifications.verifier_tier` exists.
     *
     * `defaultTier: 'admin'` grants nothing that was not already granted:
     * before this row, no tier could publish a clinical case through
     * consensus at all, and admins already approve them by hand through
     * `/review`. `floorTier: 'editor'` is where an admin may move it if the
     * deployment has editors with clinical standing — never below, because the
     * whole point is that this is not an ordinary review.
     *
     * Adding the capability does not cut anything over. `clinical_case` is not
     * in `CUTOVER_ELIGIBLE_EDIT_TYPES` and the hardcoded refusal is untouched.
     */
    id: 'review.clinicalCase.signoff',
    group: 'review',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['knowledge-governance policy (kinetix-consensus@v2)'],
  },
  {
    id: 'review.edit.decide',
    group: 'review',
    defaultTier: 'editor',
    floorTier: 'contributor',
    enforcedAt: ['PATCH /api/pending-edits'],
  },
  {
    id: 'edit.modelStructure.decide',
    group: 'review',
    defaultTier: 'editor',
    // A categorical model-shape declaration selects the equations the engine
    // runs, rather than merely changing one numeric input. Keep a genuine
    // editor boundary even when an admin lowers neighbouring review grants:
    // agents may propose these cited parameter entries, but may not promote
    // them through a contributor-level permission or trusted self-review.
    floorTier: 'editor',
    enforcedAt: [
      'PATCH /api/pending-edits (model-structure parameter entries)',
    ],
  },
  {
    // Deciding on one's OWN proposal, on top of review.edit.decide. Default
    // admin: a second pair of eyes is what the review queue is for, and the
    // tier that may waive it is the tier that answers for the register. An
    // agent never reaches this row — its token is clamped to `editor` at
    // authentication, and self-review for agents stays the per-agent
    // `agents.self_review_enabled` grant, which this does not replace.
    id: 'review.edit.decideOwn',
    group: 'review',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['PATCH /api/pending-edits (own submission)'],
    alsoGrantedBy: ['agents.self_review_enabled'],
  },
  {
    id: 'wiki.page.approve',
    group: 'review',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['PATCH /api/pending-edits (wiki_page, wiki_new)'],
  },
  {
    id: 'parameterFlag.write',
    group: 'review',
    defaultTier: 'editor',
    floorTier: 'contributor',
    enforcedAt: ['POST|PATCH /api/parameter-priority-flags'],
  },
  {
    id: 'parameterApplicability.write',
    group: 'review',
    defaultTier: 'editor',
    // Floored at editor, not contributor like its neighbours. The whole point
    // of this capability being separate is that a contributor-tier maintenance
    // agent must not be able to retire its own queue items: an agent that can
    // declare a parameter undefined can hide a real gap as easily as an
    // impossible one, and the marker is permanent. Leaving the floor at
    // contributor would let an admin dissolve that boundary from the runtime
    // matrix, so the guarantee has to be structural rather than a default.
    floorTier: 'editor',
    enforcedAt: ['PUT|DELETE /api/drug-parameter-applicability'],
  },
  {
    id: 'paperExtraction.manage',
    group: 'review',
    defaultTier: 'editor',
    floorTier: 'contributor',
    enforcedAt: [
      'POST /api/paper-extractions',
      'PATCH /api/paper-extractions (cancel, requeue)',
    ],
  },
  {
    id: 'methods.write',
    group: 'review',
    defaultTier: 'editor',
    floorTier: 'contributor',
    enforcedAt: ['POST|PATCH|DELETE /api/methods'],
  },

  // ─── Registry / direct writes ───────────────────────────────────────────
  {
    id: 'edit.directWrite',
    group: 'registry',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: [
      '/api/drug-parameter',
      '/api/parameter-entries',
      '/api/drug-metabolism',
      '/api/drug-receptor-targets',
      '/api/drug-enzyme-interactions',
      '/api/bio-entities',
      '/api/wiki/pages',
    ],
  },
  {
    id: 'drug.create',
    group: 'registry',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['POST /api/drugs'],
  },
  {
    id: 'drug.update',
    group: 'registry',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['PATCH /api/drugs'],
  },
  {
    id: 'drug.delete',
    group: 'registry',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['DELETE /api/drugs'],
  },
  {
    // Merging two catalog entries for one substance folds one drug into the
    // other and deletes the loser. It repoints or discards far more than a
    // delete does (parameters, method memberships, atlas rows, monograph
    // links) and destroys a row, so it floors at editor like the other
    // destructive registry actions and defaults to admin.
    id: 'drug.merge',
    group: 'registry',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['POST /api/drug-merge'],
  },
  {
    id: 'wiki.page.submit',
    group: 'registry',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: [
      'POST|PATCH /api/wiki/pages',
      'POST /api/pending-edits (wiki_page, wiki_new)',
    ],
  },
  {
    id: 'wiki.page.delete',
    group: 'registry',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['DELETE /api/wiki/pages'],
  },
  {
    id: 'bioEntity.delete',
    group: 'registry',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['DELETE /api/bio-entities'],
  },
  {
    id: 'referenceConcentration.write',
    group: 'registry',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['POST|PATCH|DELETE /api/reference-concentrations'],
  },

  // ─── Administration ─────────────────────────────────────────────────────
  {
    id: 'admin.panel.access',
    group: 'admin',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['/admin'],
  },
  {
    id: 'admin.users.manage',
    group: 'admin',
    defaultTier: 'admin',
    floorTier: 'admin',
    locked: true,
    enforcedAt: ['/api/admin?resource=users'],
  },
  {
    id: 'admin.permissions.manage',
    group: 'admin',
    defaultTier: 'admin',
    floorTier: 'admin',
    locked: true,
    enforcedAt: ['PATCH /api/permissions'],
  },
  {
    id: 'admin.groups.manage',
    group: 'admin',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['/api/admin?resource=groups'],
  },
  {
    id: 'admin.allowlist.manage',
    group: 'admin',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: [
      '/api/admin?resource=allowed-domains',
      '/api/admin?resource=allowed-emails',
    ],
  },
  {
    id: 'admin.categories.manage',
    group: 'admin',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['/api/admin?resource=categories'],
  },
  {
    id: 'admin.agents.manage',
    group: 'admin',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['/api/admin?resource=agents', '/api/agent-focus'],
  },
  {
    id: 'admin.agentHookRuns.read',
    group: 'admin',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['/api/admin?resource=agent-hook-runs'],
  },
  {
    id: 'admin.researchImport.run',
    group: 'admin',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['POST /api/research-import'],
  },
  {
    // Conversation ingestion writes facts, parameters and pages straight to the
    // live data behind a per-item acceptance gate, so it floors at editor like
    // the other direct-write import: whoever holds it is the reviewer. Except
    // for a fact the assistant could not verify against full text — that one is
    // staged in the `/review` queue instead, because the reading the acceptance
    // rests on is precisely what nobody has done yet.
    id: 'admin.conversationIngestion.run',
    group: 'admin',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['POST /api/conversation-ingestion'],
  },
  {
    // The runtime policy switches (src/lib/siteSettings.ts). Delegable to
    // editors like the other content-policy panes — it changes which writes
    // are blocked, not who may write.
    id: 'admin.settings.manage',
    group: 'admin',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['/api/admin?resource=settings'],
  },
  {
    // Which header nav links (src/lib/navItems.ts) are hidden from the
    // average user (#1240) — a feature not yet ready to promote, kept
    // reachable by URL rather than pulled from the app. Delegable to editors
    // like the other content-visibility panes — it changes what is linked,
    // not who may write.
    id: 'admin.navVisibility.manage',
    group: 'admin',
    defaultTier: 'admin',
    floorTier: 'editor',
    enforcedAt: ['/api/admin?resource=nav-visibility'],
  },
] as const satisfies readonly CapabilityDef[];

export type CapabilityId = (typeof CAPABILITY_LIST)[number]['id'];

const CAPABILITY_BY_ID = new Map<string, CapabilityDef>(
  CAPABILITY_LIST.map((c) => [c.id, c]),
);

/** Capability ids as a typed object, so call sites get autocomplete. */
export const CAP = Object.fromEntries(
  CAPABILITY_LIST.map((c) => [c.id, c.id]),
) as Record<CapabilityId, CapabilityId>;

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === 'string' && CAPABILITY_BY_ID.has(value);
}

export function getCapability(id: string): CapabilityDef | undefined {
  return CAPABILITY_BY_ID.get(id);
}

/**
 * Stored deviations from the defaults: capability id → minimum tier.
 * Absent key = "use the default". A row equal to the default is pruned on
 * write, so this map only ever holds real deviations.
 */
export type PermissionOverrides = Readonly<Partial<Record<string, PermissionTier>>>;

export const NO_OVERRIDES: PermissionOverrides = Object.freeze({});

/**
 * Clamp a requested tier into what the capability allows: never below its
 * floor, and `locked` capabilities always resolve to their default.
 */
export function clampTier(
  cap: CapabilityDef,
  requested: PermissionTier,
): PermissionTier {
  if (cap.locked) return cap.defaultTier;
  return TIER_RANK[requested] < TIER_RANK[cap.floorTier]
    ? cap.floorTier
    : requested;
}

/** The tier currently required for `capabilityId`, overrides applied. */
export function effectiveTier(
  capabilityId: string,
  overrides: PermissionOverrides = NO_OVERRIDES,
): PermissionTier {
  const cap = CAPABILITY_BY_ID.get(capabilityId);
  // An unknown id must never be silently permissive.
  if (!cap) return 'admin';
  const override = overrides[capabilityId];
  if (!override || !isPermissionTier(override)) return cap.defaultTier;
  return clampTier(cap, override);
}

/** True when a caller at `role` (null = anonymous) holds `capabilityId`. */
export function can(
  role: string | null | undefined,
  capabilityId: string,
  overrides: PermissionOverrides = NO_OVERRIDES,
): boolean {
  const required = effectiveTier(capabilityId, overrides);
  return TIER_RANK[tierForRole(role)] >= TIER_RANK[required];
}

/**
 * True when the stored matrix could change the answer for this caller.
 *
 * Two outcomes are fixed no matter what an admin configures: the admin tier
 * holds every capability (nothing can be raised above `admin`), and a caller
 * below a capability's floor can never be granted it. Callers that would
 * otherwise have to read the override table can skip it in those cases —
 * which keeps the common admin path free of an extra round-trip and lets
 * routes reject an under-privileged caller before touching the database.
 */
export function overridesCouldMatter(
  role: string | null | undefined,
  capabilityId: string,
): boolean {
  const cap = CAPABILITY_BY_ID.get(capabilityId);
  if (!cap || cap.locked) return false;
  const tier = tierForRole(role);
  if (TIER_RANK[tier] >= TIER_RANK.admin) return false;
  return TIER_RANK[tier] >= TIER_RANK[cap.floorTier];
}

/**
 * True when the caller holds at least one capability in `group`. For
 * affordances that front a whole family of actions — the header badge covers
 * "content you submitted", whichever kind — rather than one endpoint.
 */
export function canAnyInGroup(
  role: string | null | undefined,
  group: CapabilityGroup,
  overrides: PermissionOverrides = NO_OVERRIDES,
): boolean {
  return CAPABILITY_LIST.some(
    (cap) => cap.group === group && can(role, cap.id, overrides),
  );
}

/** Every capability a tier holds, for the admin UI and for tests. */
export function capabilitiesForTier(
  tier: PermissionTier,
  overrides: PermissionOverrides = NO_OVERRIDES,
): CapabilityId[] {
  return CAPABILITY_LIST.filter(
    (c) => TIER_RANK[tier] >= TIER_RANK[effectiveTier(c.id, overrides)],
  ).map((c) => c.id as CapabilityId);
}

/**
 * Drop anything the registry no longer recognises and clamp what remains.
 * DB rows outlive code: a capability renamed or removed in a later release
 * leaves a stale row behind, and a hand-edited row could hold a tier below
 * the floor. Both must resolve to the default rather than to a hole.
 */
export function sanitizeOverrides(raw: unknown): PermissionOverrides {
  if (!raw || typeof raw !== 'object') return NO_OVERRIDES;
  const out: Record<string, PermissionTier> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const cap = CAPABILITY_BY_ID.get(key);
    if (!cap || cap.locked) continue;
    if (!isPermissionTier(value)) continue;
    const clamped = clampTier(cap, value);
    if (clamped === cap.defaultTier) continue;
    out[key] = clamped;
  }
  return out;
}

/**
 * Validate an admin's requested change. Returns the tier that would be
 * stored, or a reason it cannot be.
 */
export type OverrideCheck =
  | { ok: true; capability: CapabilityDef; tier: PermissionTier; isDefault: boolean }
  | { ok: false; reason: 'unknown_capability' | 'locked_capability' | 'invalid_tier' | 'below_floor' };

export function checkOverride(
  capabilityId: string,
  tier: unknown,
): OverrideCheck {
  const cap = CAPABILITY_BY_ID.get(capabilityId);
  if (!cap) return { ok: false, reason: 'unknown_capability' };
  if (cap.locked) return { ok: false, reason: 'locked_capability' };
  if (!isPermissionTier(tier)) return { ok: false, reason: 'invalid_tier' };
  if (TIER_RANK[tier] < TIER_RANK[cap.floorTier]) {
    return { ok: false, reason: 'below_floor' };
  }
  return { ok: true, capability: cap, tier, isDefault: tier === cap.defaultTier };
}

/**
 * Which capability a queued pending edit belongs to. `/api/pending-edits`
 * accepts several edit types through one endpoint, so the generic
 * contributor gate there would otherwise be a way around the per-type
 * capability enforced on the dedicated endpoints.
 */
export function capabilityForEditType(editType: string): CapabilityId {
  switch (editType) {
    case 'parameter':
      return 'edit.parameter.submit';
    case 'param_entry':
      return 'edit.parameterEntry.submit';
    case 'metabolism':
      return 'edit.metabolism.submit';
    case 'receptor_targets':
      return 'edit.receptorTarget.submit';
    case 'enzyme_interaction':
      return 'edit.enzymeInteraction.submit';
    case 'bio_entity':
      return 'edit.bioEntity.submit';
    case 'wiki_page':
    case 'wiki_new':
      return 'wiki.page.submit';
    case 'paper_review':
      return 'paperReview.submit';
    case 'learning_unit':
    case 'clinical_case':
      return 'edit.learning.submit';
    case 'wiki_fact':
    case 'wiki_section':
    default:
      return 'edit.wikiFact.submit';
  }
}

/** Role values an override may name, for building the admin UI columns. */
export const ROLE_TIERS: readonly Role[] = [
  ROLES.authenticated,
  ROLES.contributor,
  ROLES.editor,
  ROLES.admin,
];
