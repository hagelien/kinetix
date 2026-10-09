import { sql } from 'drizzle-orm';
import {
  customType,
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  bigint,
  jsonb,
  numeric,
  doublePrecision,
  boolean,
  index,
  uniqueIndex,
  foreignKey,
  primaryKey,
  check,
} from 'drizzle-orm/pg-core';

type NumericRangeJson = {
  min?: number;
  max?: number;
  // Replaces the former standalone `value` field; legacy single values
  // were migrated into `median` (see drizzle/0064).
  mean?: number;
  median?: number;
  unit?: string;
  // Comparison operator for one-sided bounds only — not a free-text label.
  qualifier?: '<' | '>' | '≤' | '≥';
  note?: string;
};

type ReceptorTargetExternalIds = Record<
  string,
  string | number | string[] | number[] | null
>;

// External registry ids for a biological entity (#785): UniProt, ChEMBL, EC,
// HGNC, Guide-to-Pharmacology, … Same flexible shape as receptor targets so
// the two registries merge losslessly.
type BioEntityExternalIds = ReceptorTargetExternalIds;

const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).unique().notNull(),
  username: varchar('username', { length: 100 }).unique().notNull(),
  // Optional friendly name shown in attribution UI; falls back to username.
  displayName: varchar('display_name', { length: 100 }),
  // Legacy: password auth is being replaced by magic-link; nullable during migration
  passwordHash: text('password_hash'),
  // Tiered role system (#310): authenticated < contributor < editor < admin.
  // New signups default to 'authenticated' (read + comment, no edits);
  // existing 'viewer' rows were migrated to 'contributor' in 0017 since
  // they were already permitted to submit pending edits.
  role: varchar('role', { length: 20 }).notNull().default('authenticated'),
  emailVerifiedAt: timestamp('email_verified_at'),
  lastAuthAt: timestamp('last_auth_at'),
  sessionMaxDays: integer('session_max_days').notNull().default(30),
  magicLinkHash: varchar('magic_link_hash', { length: 128 }),
  magicLinkExpires: timestamp('magic_link_expires'),
  magicLinkFailedAttempts: integer('magic_link_failed_attempts')
    .notNull()
    .default(0),
  // Multi-select unit preferences (#306). The first item is the user's
  // primary display unit; the rest are the alternative units they want to
  // see in tooltips, converters, and pickers. Defaults to ['µmol/L','mg/L']
  // so the unit-conversion tooltip continues to show both kinds out of the
  // box; user content (drug data) is unaffected since this only governs
  // display.
  enabledConcentrationUnits: jsonb('enabled_concentration_units')
    .$type<string[]>()
    .notNull()
    .default(['µmol/L', 'mg/L']),
  // Ethanol's own display unit: ‰ and % on top of the units above, since blood
  // alcohol is read in per mille, not µmol/L. Display only. Defaults to ‰.
  ethanolConcentrationUnit: varchar('ethanol_concentration_unit', { length: 16 })
    .notNull()
    .default('‰'),
  // Per-user favorite parameter ids (#321). These are the parameters
  // the user wants visible in the monograph sidebar's collapsed mode;
  // expanding the box reveals every parameter regardless. Order is
  // arbitrary — the sidebar renders favorites in registry order.
  favoriteParameters: jsonb('favorite_parameters')
    .$type<string[]>()
    .notNull()
    .default([]),
  // Email notification opt-ins and frequency; shape and defaults in
  // src/lib/emailNotificationPrefs.ts (everything off by default).
  notificationSettings: jsonb('notification_settings'),
  // When the last email summary (daily/weekly/monthly) went out, or the
  // baseline set when email was switched on. Written only by the server.
  lastEmailDigestAt: timestamp('last_email_digest_at'),
  // When the delivery job last sent this user any email; orders each run's
  // recipients least recently served first. Written only by the server.
  lastEmailSentAt: timestamp('last_email_sent_at'),
  // A delivery run's lease on this user's current summary period; a lapsed
  // lease makes the period claimable again. Written only by the server.
  emailDigestClaimedAt: timestamp('email_digest_claimed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const userGroups = pgTable('user_groups', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 100 }).unique().notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  // Restricted features this group unlocks (`GROUP_GRANT` in
  // src/lib/featureAccess.ts). Set in the database, never in code.
  grants: jsonb('grants').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const userGroupMembers = pgTable(
  'user_group_members',
  {
    groupId: integer('group_id')
      .references(() => userGroups.id, { onDelete: 'cascade' })
      .notNull(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    addedBy: integer('added_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index('user_group_members_user_idx').on(t.userId),
  ],
);

// ─── Wiki Pages ───────────────────────────────────────────────────────────────

export const wikiPages = pgTable(
  'wiki_pages',
  {
    id: serial('id').primaryKey(),
    slug: varchar('slug', { length: 300 }).unique().notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    content: jsonb('content'),
    contentHtml: text('content_html'),
    contentPlaintext: text('content_plaintext'),
    pageType: varchar('page_type', { length: 30 }).notNull().default('topic'),
    // NOTE: despite the column name, this stores the internal `drugs.id`
    // (serial PK), not a PubChem CID. Some legacy rows may still carry a
    // PubChem CID from older seed data; the sidebar lookup tolerates both.
    drugCid: integer('drug_cid'),
    // Unified entity monograph link (#785 Phase 5): for page_type
    // 'entity_monograph', the bio_entities row this article describes. NULL for
    // every other page type.
    entityId: integer('entity_id').references(() => bioEntities.id, {
      onDelete: 'set null',
    }),
    parentId: integer('parent_id'),
    status: varchar('status', { length: 20 }).notNull().default('published'),
    searchTsvector: tsvector('search_tsvector').generatedAlwaysAs(
      sql`to_tsvector('english', coalesce("title", '') || ' ' || coalesce("content_plaintext", ''))`,
    ),
    createdBy: integer('created_by')
      .references(() => users.id)
      .notNull(),
    updatedBy: integer('updated_by')
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('wiki_pages_drug_cid_idx').on(t.drugCid),
    index('wiki_pages_entity_id_idx').on(t.entityId),
    index('wiki_pages_page_type_idx').on(t.pageType),
    index('wiki_pages_status_idx').on(t.status),
    index('wiki_pages_fts_idx').using('gin', t.searchTsvector),
    index('wiki_pages_parent_id_idx').on(t.parentId),
  ],
);

// ─── Wiki Revisions ───────────────────────────────────────────────────────────

export const wikiRevisions = pgTable(
  'wiki_revisions',
  {
    id: serial('id').primaryKey(),
    pageId: integer('page_id')
      .references(() => wikiPages.id, { onDelete: 'cascade' })
      .notNull(),
    content: jsonb('content').notNull(),
    contentHtml: text('content_html'),
    editSummary: varchar('edit_summary', { length: 500 }),
    pendingEditId: integer('pending_edit_id').references(
      () => pendingEdits.id,
      { onDelete: 'set null' },
    ),
    createdBy: integer('created_by')
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('wiki_revisions_page_created_idx').on(t.pageId, t.createdAt),
    index('wiki_revisions_created_idx').on(t.createdAt),
  ],
);

// ─── Wiki Categories ──────────────────────────────────────────────────────────

export const wikiCategories = pgTable('wiki_categories', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 200 }).unique().notNull(),
  slug: varchar('slug', { length: 200 }).unique().notNull(),
  description: text('description'),
});

// ─── Wiki Page Categories (junction table) ────────────────────────────────────

export const wikiPageCategories = pgTable(
  'wiki_page_categories',
  {
    pageId: integer('page_id')
      .references(() => wikiPages.id, { onDelete: 'cascade' })
      .notNull(),
    categoryId: integer('category_id')
      .references(() => wikiCategories.id, { onDelete: 'cascade' })
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.pageId, t.categoryId] })],
);

// ─── Simulator Cases ─────────────────────────────────────────────────────────

export const simulatorCases = pgTable(
  'simulator_cases',
  {
    id: serial('id').primaryKey(),
    name: varchar('name', { length: 500 }).notNull(),
    caseData: jsonb('case_data').notNull(),
    createdBy: integer('created_by')
      .references(() => users.id)
      .notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('simulator_cases_user_idx').on(t.createdBy)],
);

// ─── Drugs ───────────────────────────────────────────────────────────────────

export const drugs = pgTable(
  'drugs',
  {
    id: serial('id').primaryKey(),
    slug: varchar('slug', { length: 200 }).unique().notNull(),
    // Per-language drug names keyed by BCP-47 code (e.g. { nb: "Alimemazin",
    // en: "Alimemazine" }). At least one language must be present; UI falls
    // back across keys when the active locale is missing.
    names: jsonb('names').$type<Record<string, string>>().notNull(),
    nameShort: varchar('name_short', { length: 50 }),
    // Zero or more alias strings — literature variants, brand names, and
    // street names. Indexed via `search_key` so all aliases are searchable
    // regardless of the active UI language.
    aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
    pubchemCid: integer('pubchem_cid').unique(),
    // SQL column kept after Cmax was retired from the app (see #255). Drizzle
    // must still know about the column so schema-diff tooling does not
    // synthesise a destructive DROP on the next migration. The other PK/PD
    // and chemistry numerics that used to live alongside Cmax (halfLife,
    // volumeOfDistribution, bioavailability, proteinBinding,
    // bloodPlasmaRatio, tmax, pKa, molecularWeight) moved to the
    // `drug_parameters` row table in #302 P2 (migration 0018).
    // Keyed `retiredPeakConcentration`, not `cmax`: `cmax` is a live
    // parameter id again (the Cmax dose-context RFC, entry-backed in
    // `parameter_entries`), and a drug row carrying a `cmax` key would read as
    // that parameter's drug-level value to anything flattening parameters onto
    // the row. The column name is unchanged, so no migration.
    retiredPeakConcentration: jsonb('peak_concentration'),
    popularityScore: integer('popularity_score').notNull().default(0),
    searchKey: text('search_key'),
    // Provenance flag (#import). NULL = native Kinetix seed / hand-curated
    // entry; a non-NULL value names the external catalog the substance was
    // imported (or corroborated) from — e.g. 'farmakologiportalen' for rows
    // pulled in from https://farmakologiportalen.no/substances. Lets the UI
    // and queries distinguish bulk-imported substances from the original
    // curated set. Kept as a free-form short string rather than an enum to
    // match the repo convention (no native PG enums) and to stay extensible
    // as future import sources are added.
    source: varchar('source', { length: 60 }),
    // Path of this substance's page on Farmakologiportalen, e.g.
    // '/content/757/Morfin-3-glukuronid-M3G' — written by
    // scripts/import-farmakologiportalen.ts and the link backfill, and rendered
    // as the outbound monograph link (see src/lib/farmakologiportalen.ts).
    // Both path segments matter: the numeric id alone answers 200 with a shell
    // page that names no substance. NULL = no known counterpart on the portal,
    // which is why this is independent of `source` above: a hand-curated drug
    // the portal also lists gets a link without being marked as imported.
    farmakologiportalenPath: varchar('farmakologiportalen_path', {
      length: 300,
    }),
    // What kind of thing this entry is: 'drug' (administered), 'metabolite'
    // (formed in vivo, analyte only) or 'endogenous' (physiological marker).
    // See SUBSTANCE_CLASSES in src/lib/parameterApplicability.ts, which also
    // derives from it which parameters are undefined for the substance —
    // bioavailability and the dose parameters need a dose OF THIS SUBSTANCE,
    // so they have no referent for the non-'drug' classes. (tmax does not:
    // a metabolite's time to peak is measured after the parent is dosed.)
    // Screening panels are full of such analytes, and without this the
    // maintenance agent's gap queue re-selects their permanently unfillable
    // parameters every cycle. Free-form varchar rather than a native enum, as
    // with `source` above.
    substanceClass: varchar('substance_class', { length: 20 })
      .notNull()
      .default('drug'),
    // Metabolism completeness (0102) — **withdrawn, awaiting a contract
    // migration.** Nothing reads or writes these any more: the curator panel
    // that set them, its endpoint and the graph store's comparisons were all
    // removed when the assertion was replaced by a standing caveat on the ratio
    // profile (§7.3.2, amended 2026-08-24).
    //
    // They stay declared because they are still in the live database, and
    // dropping them in the same change that removes the readers is unsafe here.
    // `vercel.json` applies migrations as the *first* step of the build command
    // and the workflow only deploys once the whole build succeeds, so a failure
    // in any later step leaves the previous build serving against a schema its
    // queries no longer match — not for the length of a deploy, but until some
    // later deploy happens to succeed. Expand first: this release removes the
    // readers, and a migration after it is deployed drops the two columns,
    // their partial indexes and `metabolite_edges_digest_of` /
    // `precursor_edges_digest_of`.
    metabolitesCompleteDigest: text('metabolites_complete_digest'),
    precursorsCompleteDigest: text('precursors_complete_digest'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('drugs_slug_idx').on(t.slug),
    index('drugs_pubchem_cid_idx').on(t.pubchemCid),
    index('drugs_popularity_idx').on(t.popularityScore),
    index('drugs_source_idx').on(t.source),
    // drugs_search_key_trgm_idx (GIN, migration 0008) handles LIKE '%q%' queries;
    // the B-tree index was superseded by it and has no remaining use.
  ],
);

// ─── Drug parameters (#302 P2 — generic key/value store) ────────────────────
//
// Each row is one parameter value for one drug. `value` carries the
// parameter-kind-shaped payload (NumericRange jsonb for range/scalar/
// fraction/ratio kinds, a JSON number for number kinds, a string or
// string[] for text/list kinds — the spec in src/lib/drugParameters
// dictates the shape). Replaces the per-column storage on `drugs` for
// halfLife, volumeOfDistribution, bioavailability, proteinBinding,
// bloodPlasmaRatio, tmax, pKa, and molecularWeight; metadata
// (names, aliases, pubchemCid) stays on `drugs`.
//
// `updated_by` is nullable because the existing column data backfilled
// in 0018 has no provenance — modifications afterwards always set it.

export const drugParameters = pgTable(
  'drug_parameters',
  {
    drugId: integer('drug_id')
      .references(() => drugs.id, { onDelete: 'cascade' })
      .notNull(),
    parameter: varchar('parameter', { length: 60 }).notNull(),
    value: jsonb('value').notNull(),
    updatedBy: integer('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.drugId, t.parameter] }),
    index('drug_parameters_param_idx').on(t.parameter),
    // Partial functional index supporting ORDER BY (value::text::numeric) for
    // the molecularWeight sort path in GET /api/drugs?sort=molecularWeight.
    // Mirrors the index created by migration 0047_drug_parameters_mw_sort_idx.sql
    // so db:push and future schema diffs don't treat it as drift.
    index('drug_parameters_mw_sort_idx')
      .on(sql`(${t.value}::text::numeric)`)
      .where(
        sql`${t.parameter} = 'molecularWeight' AND jsonb_typeof(${t.value}) = 'number'`,
      ),
  ],
);

// ─── Parameter applicability (not-applicable markers) ───────────────────────
//
// Records that a specific (drug, parameter) pair is not a defined quantity, so
// nothing is missing and nobody should keep looking. Distinct from "we have no
// value yet", which is the ordinary absence of a `drug_parameters` row and is
// real work.
//
// This is the pair-level, human-set layer of the applicability model in
// src/lib/parameterApplicability.ts. The class-wide rule (a metabolite has no
// bioavailability) is derived from `drugs.substance_class` and needs no row
// here; this table is for the one-offs that rule cannot express. The third
// layer — an exhaustive search that found nothing — is NOT stored here: it
// stays a `verification_log` row with concordance='absent' and only suppresses
// the pair for ABSENT_RECHECK_DAYS, because "no literature today" is not the
// same claim as "no such quantity".
//
// Writing is gated on the `parameterApplicability.write` capability
// (editor-tier by default): a contributor agent that hits an unfillable pair
// says so in the parameter discussion thread and leaves the judgement to a
// human, rather than retiring its own work item.
export const drugParameterApplicability = pgTable(
  'drug_parameter_applicability',
  {
    drugId: integer('drug_id')
      .references(() => drugs.id, { onDelete: 'cascade' })
      .notNull(),
    parameter: varchar('parameter', { length: 60 }).notNull(),
    // APPLICABILITY_STATUSES in src/lib/parameterApplicability.ts.
    status: varchar('status', { length: 30 }).notNull().default('not_applicable'),
    // Why the quantity is undefined for this substance. Required by the API —
    // an unexplained marker is indistinguishable from a mistake, and this is
    // the text a future curator reads when deciding whether to lift it.
    reason: text('reason').notNull(),
    setBy: integer('set_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.drugId, t.parameter] }),
    // The gap queue filters by parameter across all drugs.
    index('drug_parameter_applicability_param_idx').on(t.parameter),
  ],
);

// ─── Drug ionization constants (structured pKa) ─────────────────────────────
//
// Replaces the single scalar `pKa` drug parameter for molecules with more than
// one ionizable group. Each row is one acid-dissociation equilibrium, keyed by
// the net-charge transition it represents (`protonated_charge` →
// `deprotonated_charge`, always adjacent integers differing by one). Distinct
// transitions of the same molecule are distinct rows and are never pooled;
// multiple literature measurements of the SAME transition are aggregated into
// one row's `pKa` with their sources in `reference_ids`.
//
// The generic `pKa` parameter is kept in parallel during migration (see the
// structured-ionization-constants issue): existing scalar values are NOT
// blindly converted into a `+1 → 0` transition, since the stored number does
// not record whether it is acidic or basic.
export const drugIonizationConstants = pgTable(
  'drug_ionization_constants',
  {
    id: serial('id').primaryKey(),
    drugId: integer('drug_id')
      .references(() => drugs.id, { onDelete: 'cascade' })
      .notNull(),
    // The pKa of this equilibrium.
    pka: numeric('pka', { precision: 6, scale: 3 }).notNull(),
    // Net molecular charge of the protonated species; the deprotonated species
    // always carries exactly one less (a single-proton dissociation).
    protonatedCharge: integer('protonated_charge').notNull(),
    deprotonatedCharge: integer('deprotonated_charge').notNull(),
    // 'macroscopic' (default, site-agnostic, the common case) | 'microscopic'.
    constantType: varchar('constant_type', { length: 20 })
      .notNull()
      .default('macroscopic'),
    // 'experimental' | 'predicted'. A predicted value is weaker evidence and
    // must stay distinguishable from a measured one; the two are never merged.
    evidenceType: varchar('evidence_type', { length: 20 })
      .notNull()
      .default('experimental'),
    // Optional description of the ionizable group/site (microscopic detail).
    siteLabel: varchar('site_label', { length: 120 }),
    temperatureC: numeric('temperature_c', { precision: 5, scale: 2 }),
    medium: varchar('medium', { length: 120 }),
    referenceIds: integer('reference_ids').array(),
    note: text('note'),
    // Provenance: 'curated' (default — a human/manual row, never rewritten by an
    // import) vs 'deep-research' (seeded by the importer, which may reconcile its
    // own rows under --overwrite). Mirrors parameter_entries.origin.
    origin: varchar('origin', { length: 20 }).notNull().default('curated'),
    createdBy: integer('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedBy: integer('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('drug_ionization_constants_drug_idx').on(t.drugId),
    index('drug_ionization_constants_transition_idx').on(
      t.drugId,
      t.protonatedCharge,
      t.deprotonatedCharge,
    ),
    // One row per reconciliation identity, enforced in the DB so overlapping
    // imports for the same drug can't each insert the same measurement. NULL
    // qualifiers are folded via COALESCE, and temperature compares as its stored
    // text to match the NUMERIC(5,2) rounding. Mirrors seedIonizationConstants'
    // reconcileKey and migration 0109's expression index.
    uniqueIndex('drug_ionization_constants_identity_uidx').on(
      t.drugId,
      t.protonatedCharge,
      t.deprotonatedCharge,
      t.constantType,
      t.evidenceType,
      sql`lower(coalesce(${t.siteLabel}, ''))`,
      sql`lower(coalesce(${t.medium}, ''))`,
      sql`coalesce(${t.temperatureC}::text, '')`,
    ),
  ],
);

// ─── Biological entities (#785) ─────────────────────────────────────────────
// One canonical, non-drug biological macromolecule — an enzyme, receptor,
// transporter, ion channel, … This unifies the previously separate `enzymes`
// and `receptor_targets` registries. Because the same molecule (e.g.
// acetylcholinesterase) can be both a metabolic enzyme AND a drug target, the
// roles it plays live in the many-to-one `bio_entity_functions` table rather
// than being implied by which registry it sits in. `parent_id` gives a
// taxonomic subdivision spine (superfamily → family → subfamily →
// isoform/subunit); drug-specific data stays on `drug_elimination_routes` and
// `drug_receptor_targets`, which point here via their catalog FK.
export const bioEntities = pgTable(
  'bio_entities',
  {
    id: serial('id').primaryKey(),
    slug: varchar('slug', { length: 120 }).unique().notNull(),
    // Short symbol used for search/display, e.g. "CYP3A4", "SERT", "AChE".
    symbol: varchar('symbol', { length: 80 }).notNull(),
    name: varchar('name', { length: 200 }).notNull(),
    nameEn: varchar('name_en', { length: 200 }),
    organism: varchar('organism', { length: 80 })
      .notNull()
      .default('Homo sapiens'),
    // Position in the subdivision tree (free-form; spine backfilled in Phase 6).
    // 'superfamily' | 'family' | 'subfamily' | 'gene' | 'isoform' | 'subunit'
    // | 'variant' | 'complex'. NULL when unranked.
    rank: varchar('rank', { length: 20 }),
    // Self-reference to the parent in the subdivision tree. No FK constraint,
    // matching the `wiki_pages.parent_id` convention. NULL for roots.
    parentId: integer('parent_id'),
    // Coarse molecular family for grouping/filtering — subsumes the old
    // `enzymes.enzyme_class` and `receptor_targets.target_class` (CYP, UGT,
    // GPCR, LGIC, transporter, …).
    entityClass: varchar('entity_class', { length: 60 }),
    externalIds: jsonb('external_ids')
      .$type<BioEntityExternalIds>()
      .notNull()
      .default({}),
    // Identity-level real-life attributes that are not function-specific.
    properties: jsonb('properties')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('bio_entities_symbol_idx').on(t.symbol),
    index('bio_entities_normalized_symbol_idx').on(
      sql`upper(regexp_replace(${t.symbol}, '[^a-zA-Z0-9]', '', 'g'))`,
    ),
    index('bio_entities_uniprot_idx').on(
      sql`lower(${t.externalIds} ->> 'uniprot')`,
    ),
    index('bio_entities_class_idx').on(t.entityClass),
    index('bio_entities_parent_idx').on(t.parentId),
    index('bio_entities_rank_idx').on(t.rank),
  ],
);

// A role a bio_entity plays. Many-to-one, so acetylcholinesterase carries both
// a 'metabolic_enzyme' and a 'drug_target' row. `detail` holds the
// function-specific real-life properties (enzyme: ecNumber / cofactors /
// alleles; target: receptorSuperfamily / transduction / endogenousLigand / …).
export const bioEntityFunctions = pgTable(
  'bio_entity_functions',
  {
    id: serial('id').primaryKey(),
    entityId: integer('entity_id')
      .references(() => bioEntities.id, { onDelete: 'cascade' })
      .notNull(),
    // 'metabolic_enzyme' | 'drug_target' | 'transporter' | 'ion_channel'
    // | 'biomarker' | 'structural'
    function: varchar('function', { length: 30 }).notNull(),
    detail: jsonb('detail')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    referenceIds: integer('reference_ids').array(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('bio_entity_functions_entity_idx').on(t.entityId),
    index('bio_entity_functions_function_idx').on(t.function),
    uniqueIndex('bio_entity_functions_entity_function_idx').on(
      t.entityId,
      t.function,
    ),
  ],
);

// Transitional crosswalk from a legacy registry row ('enzyme' /
// 'receptor_target') to its unified `bio_entities` id (#785). Built by the
// Phase 1 backfill (0064), used by the 0065 edge backfill and the store
// dual-write path, and dropped in Phase 7 once the legacy FK columns are gone.
export const bioEntityIdMap = pgTable(
  'bio_entity_id_map',
  {
    source: varchar('source', { length: 20 }).notNull(),
    sourceId: integer('source_id').notNull(),
    entityId: integer('entity_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.sourceId] })],
);

// Drug metabolism (#436)
// Metabolism is relationship-heavy data, so it lives outside the generic
// drug_parameters table. The profile row carries only a parent-drug evidence
// note now; per-enzyme / per-route fates live on drug_elimination_routes and
// drug_metabolites models directed parent -> metabolite edges that can resolve
// to a canonical drugs row when the metabolite exists in Kinetix.
export const drugMetabolismProfiles = pgTable('drug_metabolism_profiles', {
  drugId: integer('drug_id')
    .references(() => drugs.id, { onDelete: 'cascade' })
    .primaryKey()
    .notNull(),
  evidenceNote: text('evidence_note'),
  referenceIds: integer('reference_ids').array(),
  updatedBy: integer('updated_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// One row per elimination/metabolism route for a drug. `kind` selects an
// enzyme route (optionally linked to a canonical enzymes row) or an unchanged
// excretion route (renal / fecal-biliary / other). `fraction` is the share of
// dose (0–1) when known; `label` is the free-text fallback for an unmatched
// enzyme name or an "other" route description (sweat, breath, …).
export const drugEliminationRoutes = pgTable(
  'drug_elimination_routes',
  {
    id: serial('id').primaryKey(),
    drugId: integer('drug_id')
      .references(() => drugs.id, { onDelete: 'cascade' })
      .notNull(),
    kind: varchar('kind', { length: 30 }).notNull().default('enzyme'),
    // Unified biological-entity FK (#785 Phase 2), the sole catalog reference
    // since #791 Part B step 4 dropped the legacy `enzyme_id` column (0076).
    // Nullable: renal/biliary and unmatched-enzyme routes legitimately carry no
    // entity (only a free-text `label`).
    bioEntityId: integer('bio_entity_id').references(() => bioEntities.id, {
      onDelete: 'set null',
    }),
    label: varchar('label', { length: 200 }),
    // Share of dose through this route, recorded as a 0–1 range. `fraction`
    // is the representative central value (median preferred, mean fallback);
    // `fractionMin`/`fractionMax` are the bounds. Any of the three may be null.
    fraction: numeric('fraction', { precision: 6, scale: 4 }),
    fractionMin: numeric('fraction_min', { precision: 6, scale: 4 }),
    fractionMax: numeric('fraction_max', { precision: 6, scale: 4 }),
    note: text('note'),
    referenceIds: integer('reference_ids').array(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('drug_elimination_routes_drug_idx').on(t.drugId),
    index('drug_elimination_routes_bio_entity_idx').on(t.bioEntityId),
  ],
);

export const drugMetabolites = pgTable(
  'drug_metabolites',
  {
    id: serial('id').primaryKey(),
    parentDrugId: integer('parent_drug_id')
      .references(() => drugs.id, { onDelete: 'cascade' })
      .notNull(),
    metaboliteDrugId: integer('metabolite_drug_id').references(() => drugs.id, {
      onDelete: 'set null',
    }),
    metaboliteName: varchar('metabolite_name', { length: 300 }).notNull(),
    // Fraction of the parent converted to this metabolite, recorded as a 0–1
    // range. `conversionFraction` is the representative central value (median
    // preferred, mean fallback); `*Min`/`*Max` are the bounds. Any may be null
    // — e.g. min 0.30, max 0.40, median null means "30–40%, no point estimate".
    conversionFraction: numeric('conversion_fraction', {
      precision: 6,
      scale: 4,
    }),
    conversionFractionMin: numeric('conversion_fraction_min', {
      precision: 6,
      scale: 4,
    }),
    conversionFractionMax: numeric('conversion_fraction_max', {
      precision: 6,
      scale: 4,
    }),
    activity: varchar('activity', { length: 20 }).notNull().default('unknown'),
    sortOrder: integer('sort_order').notNull().default(0),
    evidenceNote: text('evidence_note'),
    referenceIds: integer('reference_ids').array(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('drug_metabolites_parent_idx').on(t.parentDrugId),
    index('drug_metabolites_metabolite_drug_idx').on(t.metaboliteDrugId),
    uniqueIndex('drug_metabolites_parent_name_idx').on(
      t.parentDrugId,
      t.metaboliteName,
    ),
    // One row per substance, not per spelling (0099). The name index above
    // cannot express this: `metabolite_name` is a label chosen by whoever
    // wrote the row — the editor fills it from the linked drug's name in the
    // *editing user's* language, importers copy the source's spelling — so the
    // same metabolite arrived as "Benzoylecgonine" and "benzoylecgonin",
    // passed the name index, and the monograph printed one line twice (both
    // render as the linked drug's localized name). Partial because an
    // unresolved free-text link has no substance to key on; those stay covered
    // by the name index alone.
    uniqueIndex('drug_metabolites_parent_metabolite_drug_idx')
      .on(t.parentDrugId, t.metaboliteDrugId)
      .where(sql`${t.metaboliteDrugId} IS NOT NULL`),
  ],
);

export const drugReceptorTargets = pgTable(
  'drug_receptor_targets',
  {
    id: serial('id').primaryKey(),
    drugId: integer('drug_id')
      .references(() => drugs.id, { onDelete: 'cascade' })
      .notNull(),
    // Unified biological-entity FK (#785 Phase 2), the sole catalog reference
    // since #791 Part B step 4 dropped the legacy `receptor_target_id` column
    // (0076). Mandatory (0074): every mechanism resolves to a bio_entity. ON
    // DELETE RESTRICT (not SET NULL, which can't coexist with NOT NULL) protects
    // an in-use catalog entity from deletion until its relationships are cleared.
    bioEntityId: integer('bio_entity_id')
      .references(() => bioEntities.id, { onDelete: 'restrict' })
      .notNull(),
    // Examples: agonist, antagonist, inhibitor, partial_agonist,
    // positive_allosteric_modulator. Kept free-form for now because
    // receptor pharmacology terms are broader than a small enum.
    interactionType: varchar('interaction_type', { length: 60 })
      .notNull()
      .default('unspecified'),
    // Rank of this mechanism in the drug's overall pharmacodynamic profile:
    // 'primary' | 'secondary' | 'tertiary'. NULL means unranked — such targets
    // are still shown, just grouped under "other" rather than a numbered tier.
    // Drives the primary/secondary/tertiary mechanism grouping in the
    // monograph pharmacodynamics box.
    tier: varchar('tier', { length: 20 }),
    affinity: jsonb('affinity').$type<NumericRangeJson>(),
    potency: jsonb('potency').$type<NumericRangeJson>(),
    efficacy: jsonb('efficacy').$type<NumericRangeJson>(),
    ki: jsonb('ki').$type<NumericRangeJson>(),
    ic50: jsonb('ic50').$type<NumericRangeJson>(),
    ec50: jsonb('ec50').$type<NumericRangeJson>(),
    emax: jsonb('emax').$type<NumericRangeJson>(),
    selectivityRatio: jsonb('selectivity_ratio').$type<NumericRangeJson>(),
    // Species of the preparation the measurements on this row were made in
    // (#1017, migration 0092), e.g. "Homo sapiens", "Rattus norvegicus",
    // "recombinant human (HEK293)". The catalog entity stays human-canonical —
    // species is a property of the observation, not of the target being
    // modelled — so a rat-tissue Ki is kept as (lower-transferability)
    // evidence about the same entity instead of forking the catalog.
    // NULL means unstated, NOT human.
    assaySpecies: varchar('assay_species', { length: 80 }),
    referenceIds: integer('reference_ids').array(),
    evidenceNote: text('evidence_note'),
    createdBy: integer('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedBy: integer('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('drug_receptor_targets_drug_idx').on(t.drugId),
    index('drug_receptor_targets_bio_entity_idx').on(t.bioEntityId),
    index('drug_receptor_targets_interaction_idx').on(t.interactionType),
    // Unified uniqueness guard (0068). Partial predicate is a historical
    // artifact of when bio_entity_id was nullable; it is now NOT NULL (0074) so
    // this covers every row. Replaced the legacy receptor_target_id unique index
    // dropped in #791 Part B step 4 (0076).
    uniqueIndex('drug_receptor_targets_bio_unique_idx')
      .on(t.drugId, t.bioEntityId, t.interactionType)
      .where(sql`${t.bioEntityId} IS NOT NULL`),
  ],
);

// Drug ↔ enzyme interactions (#785 Phase 6 follow-up). The DDI-perpetrator
// relationship that neither drug_elimination_routes (which captures the drug as
// a *substrate* with a dose fraction) nor a monograph can express: a drug that
// induces or inhibits (or is a substrate of) a metabolic enzyme. `bioEntityId`
// points at the canonical enzyme in the unified registry.
export const drugEnzymeInteractions = pgTable(
  'drug_enzyme_interactions',
  {
    id: serial('id').primaryKey(),
    drugId: integer('drug_id')
      .references(() => drugs.id, { onDelete: 'cascade' })
      .notNull(),
    bioEntityId: integer('bio_entity_id')
      .references(() => bioEntities.id, { onDelete: 'cascade' })
      .notNull(),
    // 'substrate' | 'inducer' | 'inhibitor'
    role: varchar('role', { length: 20 }).notNull(),
    // Coarse magnitude when known: 'weak' | 'moderate' | 'strong'. NULL = unrated.
    strength: varchar('strength', { length: 20 }),
    note: text('note'),
    referenceIds: integer('reference_ids').array(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdBy: integer('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    updatedBy: integer('updated_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('drug_enzyme_interactions_drug_idx').on(t.drugId),
    index('drug_enzyme_interactions_entity_idx').on(t.bioEntityId),
    uniqueIndex('drug_enzyme_interactions_unique_idx').on(
      t.drugId,
      t.bioEntityId,
      t.role,
    ),
  ],
);

// ─── Agents (#319 — multi-agent infrastructure) ─────────────────────────────
//
// Each row represents an automated contributor with its own JWT-bearing
// `users.id` (so the existing auth/audit machinery works unchanged) plus
// a human `maintainerUserId` who's responsible for it. Public-facing
// metadata (name, slug, description) backs the /agents listing; the
// `status` column drives the lifecycle (active / suspended / deactivated)
// — see src/lib/agentStatus.ts for the allowed transitions. Suspended
// and deactivated rows stay in the table so pending_edits and revisions
// keep their FK targets.

export const agents = pgTable(
  'agents',
  {
    id: serial('id').primaryKey(),
    /** The user row carrying the agent's identity + JWT-bearing role. */
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull()
      .unique(),
    /** Display name (Norwegian, primary; AGENTS.md bilingual convention). */
    name: varchar('name', { length: 100 }).notNull(),
    /** Optional English display name; nameEn falls back to name when null. */
    nameEn: varchar('name_en', { length: 100 }),
    /** URL-friendly slug for /agents/:slug detail pages (P2). */
    slug: varchar('slug', { length: 100 }).notNull().unique(),
    /** Description (Norwegian). */
    description: text('description'),
    /** Description (English). Falls back to `description` when null. */
    descriptionEn: text('description_en'),
    /** Human user accountable for this agent. */
    maintainerUserId: integer('maintainer_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /**
     * Lifecycle state: 'active' | 'suspended' | 'deactivated'. The
     * enum and allowed transitions live in src/lib/agentStatus.ts;
     * the column is VARCHAR to match the repo convention (no native
     * PG enums).
     */
    status: varchar('status', { length: 20 }).notNull().default('active'),
    /** Last actor to change `status`. NULL for the initial insert. */
    statusChangedBy: integer('status_changed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** When `status` last changed. NULL for the initial insert. */
    statusChangedAt: timestamp('status_changed_at'),
    /** Free-form reason the admin supplied with the last transition. */
    statusChangeReason: text('status_change_reason'),
    /**
     * Role the backing user held immediately before the agent was
     * suspended. NULL whenever `status='active'`; populated only while
     * the row is in the reversible `suspended` state so a later
     * reactivation can restore the exact prior tier (e.g. `editor`)
     * instead of always demoting back to `contributor`.
     */
    preSuspensionRole: varchar('pre_suspension_role', { length: 20 }),
    /**
     * Opt-in flag for the hook-triggered evaluator routine (see
     * api/_lib/agentHooks.ts). Defaults to FALSE so adding a new agent
     * never silently enrolls it in hook firing — operators must
     * explicitly enable it for the agent whose routine the env-level
     * CLAUDE_CODE_AGENT_HOOK_URL points at. `fireAgentHook` skips the
     * outbound POST when no active agent has this set.
     */
    hooksEnabled: boolean('hooks_enabled').notNull().default(false),
    /**
     * Per-agent opt-in that lets THIS agent review its own submissions
     * (#1027). Defaults to FALSE, which is the standing rule: an agent
     * peer-verifies other agents' work and its own submission carries only
     * the implicit-approve stake. Flipping it on makes the agent's own rows
     * visible in its verification queue, lets it cast an explicit verdict on
     * them, and — for an editor-tier agent — lets it approve/return its own
     * pending edits through the moderator path. It never widens what an
     * agent may do to a *human's* edit.
     */
    selfReviewEnabled: boolean('self_review_enabled').notNull().default(false),
    // Server-owned capability tier: 'flagship' | 'mid' | 'light'
    // (src/lib/modelTiers.ts). NULL = unknown. The high-risk consensus gate
    // trusts THIS, not the caller-supplied agent_verifications.model, when
    // deciding whether a flagship-tier approval is present. Set by an admin who
    // provisions the agent; NULL never counts as flagship (fail-safe).
    modelTier: varchar('model_tier', { length: 20 }),
    /**
     * Server-owned T3 adjudication grant (0138). The capability matrix is
     * monotone by role, so it cannot say "this one flagship identity may read
     * a T3 case file"; this per-agent flag does, set only by an admin like
     * `selfReviewEnabled`. Being flagship grants nothing on its own, and the
     * flag grants no `dispute.resolve`.
     */
    adjudicator: boolean('adjudicator').notNull().default(false),
    /**
     * Server-owned model family (e.g. the vendor line an identity runs), for
     * the T3 panel-diversity audit. Recorded on a case, never a gate. NULL =
     * unknown.
     */
    modelFamily: varchar('model_family', { length: 40 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('agents_status_idx').on(t.status),
    index('agents_maintainer_idx').on(t.maintainerUserId),
  ],
);

/**
 * Persistent, revocable API tokens for agents (admin-issued). The raw
 * secret (`kxat_<base64url>`) is shown to the issuing admin exactly once
 * and never stored — only its SHA-256 hash lives here, so a DB leak can't
 * recover usable credentials. `getUserFromRequest` resolves a presented
 * `kxat_` token by hashing it and matching `tokenHash`, rejecting rows
 * that are revoked (`revokedAt` set) or past `expiresAt`. Revocation is a
 * per-token kill switch that needs no global `JWT_SECRET` rotation.
 */
export const agentTokens = pgTable(
  'agent_tokens',
  {
    id: serial('id').primaryKey(),
    agentId: integer('agent_id')
      .references(() => agents.id, { onDelete: 'cascade' })
      .notNull(),
    /** SHA-256 hex digest of the issued secret. Never the secret itself. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    /** Display-only fingerprint, e.g. "kxat_ab12cd…", for the admin list. */
    prefix: varchar('prefix', { length: 20 }).notNull(),
    /** Optional human label describing where the token is deployed. */
    label: varchar('label', { length: 100 }),
    createdBy: integer('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    /**
     * Hard expiry, enforced NOT NULL so a perpetual credential can never
     * exist — auth only treats a token as expirable when this is set, and
     * the issuance API bounds it to ≤ 365 days.
     */
    expiresAt: timestamp('expires_at').notNull(),
    lastUsedAt: timestamp('last_used_at'),
    revokedAt: timestamp('revoked_at'),
    revokedBy: integer('revoked_by').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (t) => [index('agent_tokens_agent_id_idx').on(t.agentId)],
);

/**
 * Outcome log for every `fireAgentHook` invocation. Lets admins spot
 * Claude Code routine outages without scraping serverless logs. See
 * api/_lib/agentHooks.ts; `outcome` is one of 'success' | 'failed' |
 * 'skipped' (env vars unset).
 */
export const agentHookRuns = pgTable(
  'agent_hook_runs',
  {
    id: serial('id').primaryKey(),
    event: varchar('event', { length: 40 }).notNull(),
    targetType: varchar('target_type', { length: 40 }),
    targetId: integer('target_id'),
    outcome: varchar('outcome', { length: 20 }).notNull(),
    httpStatus: integer('http_status'),
    errorMessage: text('error_message'),
    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('agent_hook_runs_created_idx').on(t.createdAt),
    index('agent_hook_runs_outcome_idx').on(t.outcome, t.createdAt),
    index('agent_hook_runs_event_created_idx').on(t.event, t.createdAt),
  ],
);

/**
 * Append-only audit log of every agent status transition. The `agents`
 * row carries the latest state for fast reads; this table preserves
 * the full timeline (who suspended / reactivated, when, why).
 */
export const agentStatusHistory = pgTable(
  'agent_status_history',
  {
    id: serial('id').primaryKey(),
    agentId: integer('agent_id')
      .references(() => agents.id, { onDelete: 'cascade' })
      .notNull(),
    /** Status before the transition. NULL for the initial 'active' insert. */
    fromStatus: varchar('from_status', { length: 20 }),
    toStatus: varchar('to_status', { length: 20 }).notNull(),
    changedBy: integer('changed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    changedAt: timestamp('changed_at').defaultNow().notNull(),
    reason: text('reason'),
  },
  (t) => [index('agent_status_history_agent_idx').on(t.agentId, t.changedAt)],
);

// ─── User role change history ────────────────────────────────────────────────
// Append-only audit log for every admin-initiated role change on a user account.
// Mirrors the pattern used by agent_status_history to provide accountability for
// privilege escalation (e.g. promoting a user to admin).

export const userRoleHistory = pgTable(
  'user_role_history',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    /** Role before the change. NULL if the user row didn't exist yet (edge case). */
    fromRole: varchar('from_role', { length: 20 }),
    toRole: varchar('to_role', { length: 20 }).notNull(),
    changedBy: integer('changed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    changedAt: timestamp('changed_at').defaultNow().notNull(),
  },
  (t) => [index('user_role_history_user_idx').on(t.userId, t.changedAt)],
);

// ─── Adjustable capability matrix ────────────────────────────────────────────
// Deviations from the shipped defaults in `src/lib/permissions.ts`. One row per
// capability an admin has moved; an unchanged capability has no row, so the
// table stays empty on a stock install and the code defaults remain the single
// source of truth. `capability` is the natural key — the registry guarantees
// ids are unique — and rows for ids a later release removes are ignored at
// read time (`sanitizeOverrides`) rather than migrated away.

export const permissionOverrides = pgTable('permission_overrides', {
  capability: varchar('capability', { length: 64 }).primaryKey(),
  /** Minimum tier that holds the capability: authenticated|contributor|editor|admin. */
  minTier: varchar('min_tier', { length: 20 }).notNull(),
  updatedBy: integer('updated_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Append-only audit log for matrix changes, mirroring user_role_history: a
// site-wide access change deserves the same accountability as promoting a
// single user. `toTier` is NULL when the override was cleared (reset to the
// code default).

export const permissionOverrideHistory = pgTable(
  'permission_override_history',
  {
    id: serial('id').primaryKey(),
    capability: varchar('capability', { length: 64 }).notNull(),
    fromTier: varchar('from_tier', { length: 20 }),
    toTier: varchar('to_tier', { length: 20 }),
    changedBy: integer('changed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    changedAt: timestamp('changed_at').defaultNow().notNull(),
  },
  (t) => [
    index('permission_override_history_cap_idx').on(t.capability, t.changedAt),
    index('permission_override_history_changed_idx').on(t.changedAt),
  ],
);

// ─── Site settings (runtime policy switches) ────────────────────────────────
// Admin-flippable policy switches whose registry (id + shipped default) lives
// in src/lib/siteSettings.ts. Only *deviations* from those defaults are stored,
// so a stock install holds zero rows; an absent key means "use the default".
// Keys the registry no longer knows are ignored at read time
// (sanitizeSiteSettings) rather than migrated away.

export const siteSettings = pgTable('site_settings', {
  key: varchar('key', { length: 64 }).primaryKey(),
  /** Boolean today, jsonb so a future switch can hold a richer value. */
  value: jsonb('value').notNull(),
  updatedBy: integer('updated_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

/**
 * Restricted reference tables that are served behind a gate and never shipped
 * in the source tree — today the laboratory's urine detection-time guideline
 * (`/api/refs-detection-times`). One row per table: `source` is the document's
 * identity (`RefsGuidelineSource`), `rows` the `RefsUrineDetectionRow[]` the
 * route serves. The contents are loaded by an operator from outside the
 * repository; the public tree carries the shape only.
 */
export const refsDetectionGuidelines = pgTable('refs_detection_guidelines', {
  key: varchar('key', { length: 64 }).primaryKey(),
  source: jsonb('source').notNull(),
  preamble: text('preamble').notNull().default(''),
  rows: jsonb('rows').notNull().default(sql`'[]'::jsonb`),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Citations (scientific sources / references) ────────────────────────────
// Table named 'citations' to avoid conflict with PostgreSQL reserved word 'references'

export const citations = pgTable(
  'citations',
  {
    id: serial('id').primaryKey(),
    drugId: integer('drug_id').references(() => drugs.id, {
      onDelete: 'set null',
    }),
    type: varchar('type', { length: 10 }).notNull(), // 'freetext' | 'url' | 'pmid' | 'doi'
    identifier: text('identifier').notNull(),
    metadata: jsonb('metadata'), // {title, authors, journal, year, volume, pages}
    /**
     * What the citation identifies, as opposed to which handle it is keyed by
     * (§13.3, migration 0107). Canonical — never a raw provider string, since
     * Crossref and PubMed name the same article differently and would
     * contradict each other on every row known under both handles.
     */
    workKind: text('work_kind'),
    workKindStatus: text('work_kind_status').notNull().default('unresolved'),
    /**
     * The handles that were asked, as `pmid:…` / `doi:…`. The classification
     * stands while the row's *current* handles are all among these: a handle
     * appearing expires it, a handle disappearing does not. Computed against
     * the row on every read rather than cached, so no writer can leave it
     * looking current.
     */
    workKindHandles: text('work_kind_handles').array(),
    /** Per-handle verdicts, kept so a conflict can name which registry said what. */
    workKindVerdicts: jsonb('work_kind_verdicts'),
    workKindResolvedAt: timestamp('work_kind_resolved_at'),
    createdBy: integer('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('citations_drug_id_idx').on(t.drugId),
    uniqueIndex('citations_type_identifier_idx').on(t.type, t.identifier),
  ],
);

/**
 * Handles a merge folded into another citation (migrations 0143, 0144). One
 * row per handle the deleted citation answered to — its own and its alt ids.
 * `metadata.altIds` holds one handle per type and none for free text, so
 * without this a second merged-away URL, or any merged-away spelling, would
 * resolve to nothing on the next write and recreate the duplicate. DOIs are
 * stored lower-case (`aliasIdentifier`).
 */
export const citationIdentifierAliases = pgTable(
  'citation_identifier_aliases',
  {
    id: serial('id').primaryKey(),
    citationId: integer('citation_id')
      .references(() => citations.id, { onDelete: 'cascade' })
      .notNull(),
    type: varchar('type', { length: 10 }).notNull(), // 'freetext' | 'url' | 'pmid' | 'doi'
    identifier: text('identifier').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('citation_identifier_aliases_type_identifier_idx').on(
      t.type,
      t.identifier,
    ),
    index('citation_identifier_aliases_citation_idx').on(t.citationId),
  ],
);

// ─── Paper reviews (agent-generated quality reviews of cited papers) ─────────
// One current review per citation; re-reviews replace the row (upsert on
// citation_id). Review prose is Norwegian (bokmål) markdown.

export const paperReviews = pgTable(
  'paper_reviews',
  {
    id: serial('id').primaryKey(),
    citationId: integer('citation_id')
      .references(() => citations.id, { onDelete: 'cascade' })
      .notNull(),
    reviewMarkdown: text('review_markdown').notNull(),
    overallScore: integer('overall_score'), // 0–100 rubric score
    conclusionSupport: varchar('conclusion_support', { length: 30 }),
    reviewConfidence: varchar('review_confidence', { length: 10 }), // 'high' | 'medium' | 'low'
    // Reviewer's explicit attestation that the paper was read in full (not
    // abstract-only). Required to back a fact/parameter: facts and parameters
    // may only cite resolvable references that carry a read-in-full review.
    readInFull: boolean('read_in_full').notNull().default(false),
    createdBy: integer('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('paper_reviews_citation_idx').on(t.citationId),
    index('paper_reviews_created_at_idx').on(t.createdAt),
    index('paper_reviews_updated_at_idx').on(t.updatedAt),
  ],
);

// ─── Paper review revisions (re-review history) ─────────────────────────────
// Paper reviews auto-publish (no review queue) and are re-reviewable: an agent
// may edit an existing review, and every write appends one history row here so
// humans and agents can see, per reference, WHAT changed and WHY. Mirrors
// learning_unit_revisions / drug_parameter_revisions. The snapshot is
// self-contained (the review fields as of this revision) so the history reads
// without reconstructing state, and `editSummary` carries the author's reason.

export const paperReviewRevisions = pgTable(
  'paper_review_revisions',
  {
    id: serial('id').primaryKey(),
    paperReviewId: integer('paper_review_id')
      .references(() => paperReviews.id, { onDelete: 'cascade' })
      .notNull(),
    // Denormalized citation id so history is queryable by reference directly,
    // without first resolving the current paper_reviews row.
    citationId: integer('citation_id')
      .references(() => citations.id, { onDelete: 'cascade' })
      .notNull(),
    reviewMarkdown: text('review_markdown').notNull(),
    overallScore: integer('overall_score'),
    conclusionSupport: varchar('conclusion_support', { length: 30 }),
    reviewConfidence: varchar('review_confidence', { length: 10 }),
    readInFull: boolean('read_in_full').notNull().default(false),
    // Why this revision was made — a short author-supplied note (Norwegian
    // bokmål). Null on the initial revision / imported legacy history.
    editSummary: varchar('edit_summary', { length: 500 }),
    createdBy: integer('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('paper_review_rev_citation_idx').on(t.citationId, t.createdAt),
    index('paper_review_rev_review_idx').on(t.paperReviewId, t.createdAt),
  ],
);

// ─── Kinetix Learn: source-anchored learning units (Phase A) ────────────────
//
// One published unit per row, anchored to a citation that already carries a
// read-in-full paper_review (the reference gate is enforced at submit time).
// `content` is the validated unit payload (source card, prerequisites,
// pre-reading prompts, objectives, questions); see learningUnitContentSchema.
// Revisions mirror wiki_revisions / drug_parameter_revisions: every approved
// change inserts one history row linked back to the pending edit that produced
// it, so agent peer-verification can target the revision.

export const learningUnits = pgTable(
  'learning_units',
  {
    id: serial('id').primaryKey(),
    citationId: integer('citation_id')
      .references(() => citations.id, { onDelete: 'restrict' })
      .notNull(),
    slug: varchar('slug', { length: 300 }).unique().notNull(),
    title: varchar('title', { length: 500 }).notNull(),
    content: jsonb('content').notNull(),
    /** 'foundational' | 'intermediate_lis' | 'advanced_lis' | 'board' | 'senior' | 'research'. */
    difficulty: varchar('difficulty', { length: 30 }).notNull(),
    /** Curriculum domains (e.g. ['pharmacokinetics']); validated at the API edge. */
    domains: jsonb('domains').$type<string[]>().notNull().default([]),
    /** 'published' (only state Phase A emits). */
    status: varchar('status', { length: 20 }).notNull().default('published'),
    /**
     * Content discriminator: 'unit' (a source-anchored learning unit, the
     * Phase A/B/C default) or 'clinical_case' (a §5.4 Cases & Review case).
     * Cases reuse this table — and therefore the whole Phase C attempts/
     * competence/spaced-review/My Path engine — keyed off `content`'s shape
     * (see clinicalCaseContentSchema). Defaults to 'unit' so every existing
     * row and all Phase C behaviour is unchanged.
     */
    kind: varchar('kind', { length: 20 }).notNull().default('unit'),
    createdBy: integer('created_by')
      .references(() => users.id)
      .notNull(),
    updatedBy: integer('updated_by').references(() => users.id),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('learning_units_citation_idx').on(t.citationId),
    index('learning_units_difficulty_idx').on(t.difficulty),
  ],
);

export const learningUnitRevisions = pgTable(
  'learning_unit_revisions',
  {
    id: serial('id').primaryKey(),
    unitId: integer('unit_id')
      .references(() => learningUnits.id, { onDelete: 'cascade' })
      .notNull(),
    content: jsonb('content').notNull(),
    editSummary: varchar('edit_summary', { length: 500 }),
    pendingEditId: integer('pending_edit_id').references(
      () => pendingEdits.id,
      { onDelete: 'set null' },
    ),
    createdBy: integer('created_by')
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('learning_unit_rev_unit_idx').on(t.unitId, t.createdAt)],
);

export type LearningUnit = typeof learningUnits.$inferSelect;
export type NewLearningUnit = typeof learningUnits.$inferInsert;
export type LearningUnitRevision = typeof learningUnitRevisions.$inferSelect;

// ─── Kinetix Learn: learner state (Phase C) ─────────────────────────────────
//
// `learning_question_attempts` is an append-only event log — one row per
// question answered in a graded assessment. The question's pedagogical tags
// (category, cognitiveSkill, difficulty, concepts) are DENORMALIZED at attempt
// time so the competence aggregates stay correct even if the unit is later
// edited/re-revisioned. Questions are positional in the unit content (no stable
// id), so a row is keyed by (unitId, questionIndex) as it was at attempt time.

export const learningQuestionAttempts = pgTable(
  'learning_question_attempts',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    unitId: integer('unit_id')
      .references(() => learningUnits.id, { onDelete: 'cascade' })
      .notNull(),
    questionIndex: integer('question_index').notNull(),
    /** 'factual' | 'reasoned' — frozen at attempt time. */
    category: varchar('category', { length: 10 }).notNull(),
    /** Frozen cognitive-skill tag; null for legacy/untagged questions. */
    cognitiveSkill: varchar('cognitive_skill', { length: 30 }),
    /** Frozen difficulty. */
    difficulty: varchar('difficulty', { length: 30 }).notNull(),
    /** Frozen concept tags. */
    concepts: jsonb('concepts').$type<string[]>().notNull().default([]),
    correct: boolean('correct').notNull(),
    selectedOptionIds: jsonb('selected_option_ids')
      .$type<string[]>()
      .notNull()
      .default([]),
    /** 'submit_all' | 'one_at_a_time' | 'review'. */
    mode: varchar('mode', { length: 20 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('learning_attempts_user_created_idx').on(t.userId, t.createdAt),
    index('learning_attempts_user_unit_idx').on(t.userId, t.unitId),
  ],
);

// Per-(user, unit) rollup + SM-2-style spaced-review schedule. `review_ease`
// is stored ×100 (250 = ease 2.50) to keep integer math.

export const learningUnitProgress = pgTable(
  'learning_unit_progress',
  {
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    unitId: integer('unit_id')
      .references(() => learningUnits.id, { onDelete: 'cascade' })
      .notNull(),
    attempts: integer('attempts').notNull().default(0),
    bestScorePct: integer('best_score_pct').notNull().default(0),
    lastScorePct: integer('last_score_pct').notNull().default(0),
    /** 'in_progress' | 'completed' | 'mastered'. */
    status: varchar('status', { length: 20 }).notNull().default('in_progress'),
    reviewReps: integer('review_reps').notNull().default(0),
    reviewEase: integer('review_ease').notNull().default(250),
    reviewIntervalDays: integer('review_interval_days').notNull().default(0),
    nextReviewAt: timestamp('next_review_at'),
    lastAttemptAt: timestamp('last_attempt_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.unitId] }),
    index('learning_progress_user_due_idx').on(t.userId, t.nextReviewAt),
  ],
);

export type LearningQuestionAttempt =
  typeof learningQuestionAttempts.$inferSelect;
export type NewLearningQuestionAttempt =
  typeof learningQuestionAttempts.$inferInsert;
export type LearningUnitProgress = typeof learningUnitProgress.$inferSelect;
export type NewLearningUnitProgress = typeof learningUnitProgress.$inferInsert;

// ─── PDF requests (agent → contributor: full text needed for a citation) ────
// Filed by the review agent when a cited paper has no legitimately free full
// text. One open request per citation; a contributor fulfils it by uploading
// a file or submitting a downloadable URL (see citation_pdfs).

export const pdfRequests = pgTable(
  'pdf_requests',
  {
    id: serial('id').primaryKey(),
    citationId: integer('citation_id')
      .references(() => citations.id, { onDelete: 'cascade' })
      .notNull(),
    status: varchar('status', { length: 12 }).notNull().default('open'), // 'open' | 'fulfilled' | 'cancelled'
    reason: text('reason'),
    /**
     * This request exists to REPLACE stored full text, not to supply missing
     * full text. Opening one is editor-gated (swapping discards the previous
     * asset), and fulfilment must enforce the same tier — otherwise the
     * invariant lasts only until the row is written. An interrupted upload
     * leaves the request open, and the open-queue listing hides citations that
     * already have a PDF, so an unguarded replacement request is an invisible
     * standing grant to overwrite that paper.
     */
    isReplacement: boolean('is_replacement').notNull().default(false),
    requestedBy: integer('requested_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    fulfilledBy: integer('fulfilled_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    fulfilledAt: timestamp('fulfilled_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('pdf_requests_citation_idx').on(t.citationId),
    index('pdf_requests_status_idx').on(t.status),
  ],
);

// ─── Citation PDFs (durable full-text asset stored in Vercel Blob) ──────────
// One current PDF per citation. Bytes live in Blob; this row holds the pointer
// (blob pathname kept server-side only) plus integrity/provenance metadata.

export const citationPdfs = pgTable(
  'citation_pdfs',
  {
    id: serial('id').primaryKey(),
    citationId: integer('citation_id')
      .references(() => citations.id, { onDelete: 'cascade' })
      .notNull(),
    blobPathname: text('blob_pathname').notNull(),
    // Blob URL is unguessable-but-public; never returned to clients — the
    // GET /api/citation-pdf agent read uses it server-side to stream the
    // bytes to an extraction agent.
    blobUrl: text('blob_url').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    contentType: varchar('content_type', { length: 100 }).notNull(),
    source: varchar('source', { length: 8 }).notNull(), // 'upload' | 'url'
    sourceUrl: text('source_url'),
    uploadedBy: integer('uploaded_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [uniqueIndex('citation_pdfs_citation_idx').on(t.citationId)],
);

// ─── PDF inbox (bulk drop-off, linked to a citation afterwards) ─────────────
// A place for full-text PDFs to exist BEFORE anyone has said which citation
// they belong to. The agents file PDF requests faster than a human can answer
// them one at a time; the human's real workflow is "download a folder, then
// work out what is in it". These rows hold the bytes and the identifiers read
// out of them until the link is made — automatically when a DOI/PMID resolves
// to exactly one citation, by hand or by an agent when it does not.
//
// Attaching does not bypass anything: it opens (or reuses) the citation's
// `pdf_requests` row and goes through `recordCitationPdf` like every other
// fulfilment, so the review gate and the follow-up queues are unaffected.

export const pdfInboxItems = pgTable(
  'pdf_inbox_items',
  {
    id: serial('id').primaryKey(),
    blobPathname: text('blob_pathname').notNull(),
    // Never returned to clients, for the same reason `citation_pdfs.blob_url`
    // is not: an unattached item is still licensed full text.
    blobUrl: text('blob_url').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    contentType: varchar('content_type', { length: 100 }).notNull(),
    /**
     * The name the file had on the uploader's disk. Load-bearing, not
     * cosmetic: publisher downloads are routinely named after the DOI, and
     * for a scanned paper with no text layer the filename is the only handle
     * the matcher gets.
     */
    originalFilename: text('original_filename').notNull(),
    // 'pending' | 'attached' | 'discarded'
    status: varchar('status', { length: 12 }).notNull().default('pending'),
    /** {doi, pmid, pmcid, title, year, sources} — see api/_lib/pdf-identifiers.ts. */
    extracted: jsonb('extracted'),
    /** Ranked citation candidates — see api/_lib/pdf-inbox-match.ts. */
    candidates: jsonb('candidates'),
    matchedCitationId: integer('matched_citation_id').references(
      () => citations.id,
      { onDelete: 'set null' },
    ),
    /** 'exact' | 'strong' | 'weak' | 'none'. Only 'exact' may auto-attach. */
    matchConfidence: varchar('match_confidence', { length: 8 })
      .notNull()
      .default('none'),
    /**
     * This link was made with no human in the loop. Recorded so the set of
     * attachments nobody eyeballed is queryable — an auto-attach is a claim
     * about identity made from an identifier, and identifiers can be wrong
     * (a preprint stamped with the published DOI, a supplement carrying the
     * article's).
     */
    autoAttached: boolean('auto_attached').notNull().default(false),
    attachedAt: timestamp('attached_at'),
    attachedBy: integer('attached_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    uploadedBy: integer('uploaded_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Why the last attach attempt failed, in operator-readable terms. */
    lastError: text('last_error'),
    /**
     * When this item's Blob object was confirmed deleted.
     *
     * Only meaningful for a discarded row: an *attached* one no longer owns
     * its object (`citation_pdfs` does) and must never have it deleted, so
     * this stays null there and the cleanup query filters on status.
     *
     * Null on a discarded row means the bytes may still be in the store — a
     * delete that failed, most likely transiently. That is the retry queue
     * (`retryPendingBlobDeletions`), and the reason the delete is allowed to
     * be best-effort without the failure vanishing: a human clearing their
     * queue is never blocked by a Blob outage, but the outage does not leave
     * licensed full text behind unrecorded either.
     */
    blobDeletedAt: timestamp('blob_deleted_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    // Re-dropping the same folder must be recognised rather than duplicated.
    // Excludes discarded rows so a mistaken discard can be undone by dropping
    // the file again.
    uniqueIndex('pdf_inbox_items_sha256_idx')
      .on(t.sha256)
      .where(sql`${t.status} <> 'discarded'`),
    index('pdf_inbox_items_status_idx').on(t.status, t.createdAt),
    index('pdf_inbox_items_citation_idx')
      .on(t.matchedCitationId)
      .where(sql`${t.matchedCitationId} is not null`),
    // The cleanup retry queue: discarded rows whose object is not known gone.
    index('pdf_inbox_items_blob_cleanup_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'discarded' and ${t.blobDeletedAt} is null`),
  ],
);

export type PdfInboxItem = typeof pdfInboxItems.$inferSelect;
export type NewPdfInboxItem = typeof pdfInboxItems.$inferInsert;

// ─── Parameter entries (per-drug, per-parameter multi-value source store) ───
//
// One row = one value for one drug parameter as reported by one source. This
// is the multi-value backbone: a parameter (where `matrixRelevant`/`summarizable`
// in the registry) can carry many rows, each from a different paper, each in its
// own biological `matrix`. The single `drug_parameters` value for such a
// parameter is a recomputed, matrix-normalized aggregate of these rows.
//
// Generalized from the former `reference_concentrations` table (migration 0078
// renamed it in place and added the `parameter` column): the interpretive
// concentration parameters seed it via the legacy `scenario` → parameter map.
// `scenario` is retained as optional finer-grained context (postmortem mono vs
// poly, case report/series) but the authoritative bucket is now `parameter`.

export const parameterEntries = pgTable(
  'parameter_entries',
  {
    id: serial('id').primaryKey(),
    drugId: integer('drug_id')
      .references(() => drugs.id, { onDelete: 'cascade' })
      .notNull(),
    // Which drug parameter this entry backs (a DrugParameterId, e.g.
    // 'therapeuticConcentration', 'loq'). Back-filled from `scenario` in 0078.
    parameter: varchar('parameter', { length: 60 }).notNull(),
    // Source-matrix values; no conversion at write time. At least one of
    // low/high is required (enforced in Zod, not in the DB).
    low: numeric('low', { precision: 14, scale: 6 }),
    high: numeric('high', { precision: 14, scale: 6 }),
    // Legacy, UNLABELLED central estimate ("median preferred over mean") when
    // the source reports one. Kept distinct from the low/high bounds so
    // aggregation uses the curated point rather than the bound midpoint. Null
    // when the source reports only a range — and for a LABELLED entry, whose
    // centre lives in `centralValue` with `centralStatistic` saying what it is
    // (migration 0135); the two never coexist on a row.
    median: numeric('median', { precision: 14, scale: 6 }),
    // Comparison operator (one of NumericRange.qualifier, e.g. '<', '≤') for a
    // strict-threshold value like "< 120". Null for a plain range. Without it a
    // one-sided threshold would silently become an inclusive bound.
    qualifier: varchar('qualifier', { length: 8 }),
    // Source unit, exactly as reported. '' for a dimensionless parameter
    // (logP, logD, pKa) — the registry's canonical unit for those is empty.
    unit: varchar('unit', { length: 20 }).notNull(),
    // Categorical (pick-from-a-list) value for a non-numeric parameter — the
    // model-structure axes (dispositionModel / eliminationModel /
    // absorptionModel, CV-1b). NULL for every numeric parameter; NOT NULL and
    // drawn from that axis's kinetics-core vocabulary for a model-axis row,
    // which then carries no low/high/median (enforced by a CHECK in 0109).
    categoricalValue: varchar('categorical_value', { length: 40 }),
    // Administration route this entry is specific to (CV-2c) — a kinetics-core
    // `RouteId` (oral / intranasal / iv / …). NULL means drug-level (every row
    // before CV-2c, and every molecule-level parameter — half-life, Vd,
    // clearance — stays NULL). A non-null route scopes an entry to one route, so
    // the genuinely route-specific quantities (the absorption shape, its
    // bioavailability, and the reviewer-authored `ka`) can differ per route
    // instead of collapsing to one drug-level value. A CHECK (migration 0111)
    // holds the value to the RouteId vocabulary; `modelStructureVocabulary.test.ts`
    // keeps that list in step with kinetics-core.
    route: varchar('route', { length: 20 }),
    // NULL for a matrix-independent parameter (half-life, logP, B/P, protein
    // binding, …): only concentration-shaped values change with the sampled
    // matrix. Required for the matrix-relevant ones (migration 0085).
    matrix: varchar('matrix', { length: 20 }),
    // Optional finer-grained interpretive context; the authoritative bucket is
    // `parameter`. Set only for the interpretive concentrations — NULL for every
    // other parameter, whose study context lives in `observation_context`.
    scenario: varchar('scenario', { length: 30 }),
    n: integer('n'),
    comments: text('comments'),
    // Facts about the READING itself — dose, fed/fasted state, population,
    // assay method — that are part of what the cited sentence attests, as
    // opposed to `comments`, which is curator commentary ABOUT the row
    // ("double-checked against table 3"). The two used to share `comments`,
    // which meant a curator correcting "fasted" to "fed" changed what the
    // observation WAS without moving anything `SOURCE_QUOTE_EVIDENCE_FIELDS`
    // watches, so a stored quote survived attached to a reading it no longer
    // described. `observationContext` IS in that list (`comments` still is
    // not) so editing it does what editing `unit` or `median` already did.
    //
    // Nullable and additive, and deliberately NOT backfilled (migration
    // 0120): existing `comments` text is an unclassifiable mix of both kinds,
    // so every pre-existing row keeps this NULL and only a new or edited
    // entry populates it going forward.
    observationContext: text('observation_context'),
    // The verbatim sentence, table cell or figure caption this entry's value
    // was read off, quoted from the cited document. `citation_id` says WHICH
    // document; this says WHERE IN IT, in the source's own words.
    //
    // It exists because citing the right document is not the same as reading
    // the right number out of it. A label that reports a median Tmax of 2 h
    // for the fasted single-dose condition may also say "1 hour" a paragraph
    // later about something else entirely; with only a citation id, telling
    // those apart means re-reading the source, which is exactly the expensive
    // judgement peer review was observed not to reliably make. With the
    // sentence stored, the check is mechanical: does the quoted text actually
    // say `median`, and does it actually say this number?
    //
    // NULL for every row written before migration 0119 — the sentences were
    // never recorded and cannot be reconstructed, so this fills going forward
    // rather than being backfilled. The consensus auto-apply gate treats a
    // missing quote as a reason to withhold automatic publication of a
    // calculation-driving parameter, never as a reason to invalidate a stored
    // row or to block a human reviewer.
    sourceQuote: text('source_quote'),
    // ── Dose context and reported statistic (Cmax release B, migration 0127) ──
    // docs/plans/2026-09-17-cmax-dose-context.md. Every column is nullable and
    // nothing writes one yet: release B ships only the code that must HANDLE a
    // value here (merge repointing, delete refusal, dedup, serialization);
    // release C ships the writers and release D the CHECKs that require them.
    // No backfill — null means "not recorded", never "same as the analyte".
    //
    // Reported statistic: `centralValue` is the central estimate and
    // `centralStatistic` says what it is (mean, geometric mean, median, …);
    // `intervalKind` says what `low`/`high` are (SD, CI, range, …). Unlike
    // the dose columns below, these three are not Cmax-only: since migration
    // 0135 any numeric parameter may carry them (optionally), so a half-life
    // reported as a mean ± SD is stored as one rather than as a median.
    centralValue: numeric('central_value', { precision: 14, scale: 6 }),
    centralStatistic: varchar('central_statistic', { length: 24 }),
    intervalKind: varchar('interval_kind', { length: 24 }),
    // Dose: exact (`doseValue`) or a two-sided range, in `doseUnit`, with what
    // the mass represents (`doseBasis`, e.g. salt vs free base).
    doseValue: numeric('dose_value', { precision: 14, scale: 6 }),
    doseLow: numeric('dose_low', { precision: 14, scale: 6 }),
    doseHigh: numeric('dose_high', { precision: 14, scale: 6 }),
    doseUnit: varchar('dose_unit', { length: 20 }),
    doseBasis: varchar('dose_basis', { length: 20 }),
    doseSaltForm: varchar('dose_salt_form', { length: 60 }),
    // Regimen and where in it the sample was taken.
    doseRegimen: varchar('dose_regimen', { length: 20 }),
    doseIntervalHours: numeric('dose_interval_hours', { precision: 10, scale: 4 }),
    doseNumber: integer('dose_number'),
    regimenDurationHours: numeric('regimen_duration_hours', {
      precision: 10,
      scale: 4,
    }),
    priorDosingRegular: boolean('prior_dosing_regular'),
    // Administration: IV input shape, formulation, fed/fasted. Route reuses
    // the existing `route` column above.
    ivInputMode: varchar('iv_input_mode', { length: 16 }),
    administrationDurationMin: numeric('administration_duration_min', {
      precision: 10,
      scale: 4,
    }),
    releaseProfile: varchar('release_profile', { length: 20 }),
    physicalForm: varchar('physical_form', { length: 20 }),
    prandialState: varchar('prandial_state', { length: 16 }),
    // The substance actually dosed, which for a metabolite's Cmax is the
    // parent (benzoylecgonine is measured after COCAINE is given). ON DELETE
    // RESTRICT: administration identity is provenance, so deleting the dosed
    // drug must not silently detach evidence recorded against another drug.
    // A self-administered observation stores its own drug id, which is why
    // the drug-delete teardown removes a drug's own entries explicitly
    // (#1339) before the drug row.
    administeredDrugId: integer('administered_drug_id').references(
      () => drugs.id,
      { onDelete: 'restrict' },
    ),
    coadministrationState: varchar('coadministration_state', { length: 24 }),
    interactingDrugId: integer('interacting_drug_id').references(
      () => drugs.id,
      { onDelete: 'restrict' },
    ),
    pkPopulation: varchar('pk_population', { length: 32 }),
    populationQualifier: varchar('population_qualifier', { length: 80 }),
    // 'concentration' or 'dose_normalized' — what the stored number IS.
    valueBasis: varchar('value_basis', { length: 24 }),
    // Provenance of the row:
    //   'legacy'        — a real reference-concentration source row (migrated
    //                     from the old table or added via the legacy admin UI).
    //   'grandfathered' — a synthetic cache-preservation row minted by 0078 from
    //                     a hand-authored drug_parameters value (migration
    //                     artifact, not an independent source).
    //   'deep-research' — a source value seeded from a deep-research import
    //                     document (`sourceValues[]`). A real reading from a
    //                     real paper, so it pools like any other; the origin is
    //                     what lets a re-import reconcile its own rows without
    //                     touching one a human wrote.
    // The legacy compatibility endpoint surfaces only 'legacy' rows so a
    // synthetic row is never displayed as duplicate evidence or edited/deleted
    // through it. Later phases add a 'contributor' origin.
    origin: varchar('origin', { length: 20 }).default('legacy').notNull(),
    // Display order within a parameter's entry list.
    sortOrder: integer('sort_order').default(0).notNull(),
    citationId: integer('citation_id').references(() => citations.id, {
      onDelete: 'set null',
    }),
    createdBy: integer('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('parameter_entries_drug_idx').on(t.drugId),
    index('parameter_entries_drug_param_idx').on(t.drugId, t.parameter),
    index('parameter_entries_citation_idx').on(t.citationId),
    index('parameter_entries_drug_matrix_scenario_idx').on(
      t.drugId,
      t.matrix,
      t.scenario,
    ),
    index('parameter_entries_administered_drug_idx')
      .on(t.administeredDrugId)
      .where(sql`${t.administeredDrugId} IS NOT NULL`),
    index('parameter_entries_interacting_drug_idx')
      .on(t.interactingDrugId)
      .where(sql`${t.interactingDrugId} IS NOT NULL`),
  ],
);

/**
 * Back-compat alias for the pre-0078 name. Existing importers
 * (`api/_lib/reference-concentrations-helpers.ts`, `citation-usage.ts`) keep
 * working against the same table; retired in Phase 5.
 */
export const referenceConcentrations = parameterEntries;

// ─── Drug parameter revisions (per-parameter edit history) ───────────────────

export const drugParameterRevisions = pgTable(
  'drug_parameter_revisions',
  {
    id: serial('id').primaryKey(),
    drugId: integer('drug_id')
      .references(() => drugs.id, { onDelete: 'cascade' })
      .notNull(),
    parameter: varchar('parameter', { length: 60 }).notNull(),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    editSummary: varchar('edit_summary', { length: 500 }),
    referenceId: integer('reference_id').references(() => citations.id, {
      onDelete: 'set null',
    }),
    referenceIds: integer('reference_ids').array(),
    /**
     * Which citations entered/left the pooled aggregate since the previous
     * revision of this (drug, parameter), as `{added, removed}` arrays of
     * `{citationId, label}`. `label` is a best-effort snapshot taken at
     * diff time (title if the citation still exists, else null) — a
     * citation deleted before its removal is diffed can no longer be
     * looked up, so `referenceIds` staying a plain id array is what still
     * lets a reader match rows up by hand (#1358). Null when the
     * contributing set didn't change.
     */
    sourceDiff: jsonb('source_diff'),
    pendingEditId: integer('pending_edit_id').references(
      () => pendingEdits.id,
      { onDelete: 'set null' },
    ),
    createdBy: integer('created_by')
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('drug_param_rev_drug_param_idx').on(
      t.drugId,
      t.parameter,
      t.createdAt,
    ),
    index('drug_param_rev_created_idx').on(t.createdAt),
  ],
);

// ─── Drug parameter discussions (per-drug, optionally per-parameter) ─────────

export const drugParameterDiscussions = pgTable(
  'drug_parameter_discussions',
  {
    id: serial('id').primaryKey(),
    // Drug-scoped (monograph) discussions set drugId; topic-page atomic-fact
    // discussions set wikiPageId instead. Exactly one of the two is non-null
    // (enforced by the drug_param_disc_target_chk CHECK below), so a comment
    // always belongs to exactly one host. drugId stays nullable because a
    // topic fact has no drug.
    drugId: integer('drug_id').references(() => drugs.id, {
      onDelete: 'cascade',
    }),
    // Set for topic-page fact discussions (parameter is always a `fact:<id>`
    // key in that case — topic pages have no whole-page or drug-parameter
    // threads). Cascades so deleting a wiki page reaps its fact threads.
    wikiPageId: integer('wiki_page_id').references(() => wikiPages.id, {
      onDelete: 'cascade',
    }),
    parameter: varchar('parameter', { length: 80 }),
    parentId: integer('parent_id'),
    body: text('body').notNull(),
    createdBy: integer('created_by')
      .references(() => users.id)
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('drug_param_disc_drug_param_idx').on(t.drugId, t.parameter),
    index('drug_param_disc_drug_created_idx')
      .on(t.createdAt)
      .where(sql`${t.drugId} IS NOT NULL`),
    // Mirror index for the topic-page side so the indicators count query and
    // the fact-thread list both hit an index instead of scanning.
    index('drug_param_disc_page_param_idx').on(t.wikiPageId, t.parameter),
    // Exactly one host: drug XOR wiki page. `num_nonnulls` keeps this readable
    // and rejects the both-set / neither-set rows the API never intends to
    // write.
    check(
      'drug_param_disc_target_chk',
      sql`num_nonnulls(${t.drugId}, ${t.wikiPageId}) = 1`,
    ),
  ],
);

// ─── Analytical methods (laboratory analysis panels) ─────────────────────────

export const analyticalMethods = pgTable('analytical_methods', {
  id: serial('id').primaryKey(),
  code: varchar('code', { length: 20 }).unique().notNull(),
  name: varchar('name', { length: 300 }).notNull(),
  description: text('description'),
  // Matrices (sample media) the method applies to, stored as canonical
  // slugs ('blood' | 'urine' | 'saliva' | 'muscle' | 'vitreous' | 'organ' |
  // 'hair' | 'other' — see src/lib/methodMatrices.ts for the canonical list).
  // Display labels are localized at the React boundary.
  matrices: jsonb('matrices').$type<string[]>().notNull().default([]),
  // Sample volume requirement in millilitres (Vol. column in the source).
  volumeMl: doublePrecision('volume_ml'),
  // 'screening' | 'confirmatory' | 'screening_confirmatory'. Null when the
  // classification is unknown.
  methodType: varchar('method_type', { length: 30 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const analyticalMethodComponents = pgTable(
  'analytical_method_components',
  {
    methodId: integer('method_id')
      .references(() => analyticalMethods.id, { onDelete: 'cascade' })
      .notNull(),
    // Components are drug rows. ON DELETE CASCADE here only removes the
    // membership row when the *drug* is deleted; deleting a method drops
    // these join rows but never the underlying drugs (#methods feature).
    drugId: integer('drug_id')
      .references(() => drugs.id, { onDelete: 'cascade' })
      .notNull(),
    // Per-method, per-component reporting figures parsed from the method
    // sheet. The source sheet carries three concentration limits per
    // component, all stored here in the method's reporting unit (`unit`),
    // each under the limit-type name the sheet gives it:
    //   lor = Påvisn.
    //   mkk = MKK      (NULL for every method whose sheet leaves it blank,
    //                    which is most of them)
    //   lod = Terskel
    // The column names are historical and assert nothing. The laboratory has
    // confirmed (#1058) that a limit-type name only tells one registered limit
    // from another and does not say how the limit is used: "MKK" is not
    // necessarily the minste kvantifiserbare konsentrasjon (LLOQ), and a type
    // named for screening need not belong to a screening analysis. So none of
    // the three is an LOD, LOQ or LLOQ by definition — carry them under the
    // sheet's headings and never relabel them (case-pattern-explorer §9.1).
    // uncertainty = Usikker. (measurement uncertainty, %).
    // unit = Benevn. (e.g. 'µmol/l').
    lor: doublePrecision('lor'),
    mkk: doublePrecision('mkk'),
    lod: doublePrecision('lod'),
    unit: varchar('unit', { length: 20 }),
    measurementUncertainty: doublePrecision('measurement_uncertainty'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.methodId, t.drugId] })],
);

// ─── Drug interactions (for popularity tracking) ─────────────────────────────

export const drugInteractions = pgTable(
  'drug_interactions',
  {
    id: serial('id').primaryKey(),
    drugId: integer('drug_id')
      .references(() => drugs.id, { onDelete: 'cascade' })
      .notNull(),
    userId: integer('user_id').references(() => users.id),
    eventType: varchar('event_type', { length: 30 }).notNull(),
    ipHash: varchar('ip_hash', { length: 64 }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('drug_interactions_drug_created_idx').on(t.drugId, t.createdAt),
  ],
);

// ─── Email allowlist (domain + individual) ───────────────────────────────────

export const allowedEmailDomains = pgTable('allowed_email_domains', {
  id: serial('id').primaryKey(),
  domain: varchar('domain', { length: 253 }).unique().notNull(),
  addedBy: integer('added_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const allowedEmails = pgTable('allowed_emails', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).unique().notNull(),
  addedBy: integer('added_by').references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ─── Pending edits (approval workflow) ──────────────────────────────────────

export const pendingEdits = pgTable(
  'pending_edits',
  {
    id: serial('id').primaryKey(),
    editType: varchar('edit_type', { length: 20 }).notNull(),
    targetId: integer('target_id'),
    parameter: varchar('parameter', { length: 60 }),
    proposedValue: jsonb('proposed_value').notNull(),
    proposedMeta: jsonb('proposed_meta'),
    referenceId: integer('reference_id').references(() => citations.id, {
      onDelete: 'set null',
    }),
    referenceIds: integer('reference_ids').array(),
    status: varchar('status', { length: 20 }).notNull().default('pending'),
    // One of REJECTION_REASONS (see src/lib/rejectionReasons.ts) or NULL.
    // Free-form context goes in rejectionComment; reason is the standardized
    // category that powers agent learning and review filtering.
    rejectionReason: varchar('rejection_reason', { length: 40 }),
    rejectionComment: text('rejection_comment'),
    // ─── Atomic-fact fields (issue #284, editType='wiki_fact') ──────────
    // All nullable so legacy editTypes (parameter, wiki_page, wiki_new) keep
    // working unchanged. The API layer enforces required fields per editType.
    sectionId: varchar('section_id', { length: 40 }),
    fieldId: varchar('field_id', { length: 60 }),
    factStatement: text('fact_statement'),
    /** 'add' | 'replace' | 'remove' — validated at the API layer. */
    factOperation: varchar('fact_operation', { length: 20 }),
    /** JSON anchor for replace/remove ops, typically `{ factId: string }`. */
    factTargetAnchor: jsonb('fact_target_anchor'),
    submittedBy: integer('submitted_by')
      .notNull()
      .references(() => users.id),
    reviewedBy: integer('reviewed_by').references(() => users.id),
    submittedAt: timestamp('submitted_at').defaultNow().notNull(),
    reviewedAt: timestamp('reviewed_at'),
    // The most recent agent-consensus apply refusal (issue #1364), keyed to
    // the `pendingEditReviewToken` it was attempted against: `{ token, detail,
    // at }`. Read by `agentConsensusStatus` so a deterministic refusal (a
    // parameter collision, a moved fact target) is not reported as `ready`
    // again until the proposal actually changes. Null once nothing has ever
    // failed to apply, or meaningless once the token no longer matches the
    // current proposal — readers must check the token, not just presence.
    lastConsensusApplyFailure: jsonb('last_consensus_apply_failure'),
  },
  (t) => [
    index('pending_edits_status_idx').on(t.status),
    index('pending_edits_target_idx').on(t.editType, t.targetId),
    index('pending_edits_submitted_by_idx').on(t.submittedBy),
    index('pending_edits_section_idx').on(t.targetId, t.sectionId),
    uniqueIndex('pending_edits_open_paper_review_idx')
      .on(t.targetId)
      .where(sql`${t.editType} = 'paper_review' and ${t.status} = 'pending'`),
    // At most one OPEN pending edit per (drug, parameter). Contributor-role
    // agents can only see their OWN open rows via GET /api/pending-edits, so
    // without a server-side guard a sibling agent's pending edit on the same
    // parameter is invisible and gets re-proposed every cycle — the review
    // queue then fills with duplicate parameter edits across days. The API
    // rejects the second submission with 409 (parameter_pending_conflict) and
    // agents endorse the existing row instead (GET /api/agent-sweep
    // ?mode=pending_parameters). Mirrors pending_edits_open_paper_review_idx.
    uniqueIndex('pending_edits_open_parameter_idx')
      .on(t.targetId, t.parameter)
      .where(sql`${t.editType} = 'parameter' and ${t.status} = 'pending'`),
    // At most one OPEN update/delete pending edit per existing parameter entry
    // (target_id is the entry id for those ops). `create` rows are deliberately
    // unconstrained — a parameter is multi-value, so many concurrent proposals
    // to add new entries must coexist. Mirrors pending_edits_open_parameter_idx
    // but scoped to the `param_entry` editType. See Phase 3 (entry review).
    uniqueIndex('pending_edits_open_entry_idx')
      .on(t.targetId, t.parameter)
      .where(
        sql`${t.editType} = 'param_entry' and ${t.status} = 'pending' and (${t.proposedValue} ->> 'op') <> 'create'`,
      ),
    // Covers the reviewer queue: WHERE status = ? ORDER BY submitted_at DESC.
    // The status-only index required a separate filesort step; this composite
    // index satisfies both the filter and sort direction in one scan.
    index('pending_edits_status_sort_idx').on(t.status, t.submittedAt.desc()),
    // Covers the agent rejection-learning scan:
    // WHERE status='rejected' AND reviewed_at > watermark
    //   AND submitted_by IN (agents)
    // ORDER BY reviewed_at DESC LIMIT 50.
    index('pending_edits_rejection_scan_idx').on(
      t.status,
      t.reviewedAt.desc(),
      t.submittedBy,
    ),
  ],
);

// ─── Approvals (#344) ──────────────────────────────────────────────────────
//
// Polymorphic approval-stamp table. Each row records one user
// endorsing one specific target — a wiki revision, a drug-parameter
// revision, or a drug-parameter discussion comment. The first stamp
// is created automatically when a reviewer applies a pending edit
// (see applyApprovedEdit); additional stamps come from voluntary
// POST /api/approvals calls by other reviewers.
//
// `targetType` is the discriminator and `targetId` references the
// per-type table. We don't add SQL FK constraints because the target
// table varies by targetType; the unique index on (targetType,
// targetId, approvedBy) keeps idempotent re-stamps cheap and safe.
//
// The approval count is purely a display signal — agentic
// evaluations of facts must NOT consume it (per #344). The API
// surface intentionally exposes it only on history / hover endpoints,
// not in the canonical wiki page content payloads agents fetch for
// review.

export const approvals = pgTable(
  'approvals',
  {
    id: serial('id').primaryKey(),
    /** Discriminator: 'wiki_revision' | 'drug_parameter_revision' | 'drug_discussion'. */
    targetType: varchar('target_type', { length: 40 }).notNull(),
    /** Per-type FK; intentionally unconstrained at the SQL level. */
    targetId: integer('target_id').notNull(),
    approvedBy: integer('approved_by')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('approvals_target_user_idx').on(
      t.targetType,
      t.targetId,
      t.approvedBy,
    ),
    index('approvals_target_idx').on(t.targetType, t.targetId),
  ],
);

// ─── Agent verifications (peer-review of agent output) ─────────────────────
//
// One row per (agent, target) judgment. Lets one agent record an
// approve / dispute / abstain verdict on another agent's output —
// parameter revisions, wiki revisions, paper reviews, drug discussions,
// and pending edits. Mirrors the polymorphic shape of `approvals` but
// carries an opinion + rationale + evidence rather than a soft endorsement.
//
// `is_implicit = TRUE` rows are written by the API at submission time so the
// submitter's own work counts as one approve without a special-case branch
// at read time. Combined with the self-verification block at the POST
// handler, this gives us "the initial action where an agent adds or edits
// content counts as one review approval" without leaking submitter rows
// into the explicit verifier counts surfaced on /review.
//
// `target_type` and `verdict` are varchar (project convention — no native
// PG enums); Zod validates them at the API edge.
//
// Independence guardrail: the queue endpoint and the POST handler never
// include other agents' verdicts in their responses. Same rule the existing
// _lib/approvals.ts note documents for approval counts.

export const agentVerifications = pgTable(
  'agent_verifications',
  {
    id: serial('id').primaryKey(),
    agentId: integer('agent_id')
      .references(() => agents.id, { onDelete: 'cascade' })
      .notNull(),
    /** Discriminator: see AgentVerificationTargetType. */
    targetType: varchar('target_type', { length: 40 }).notNull(),
    /** Per-type FK; intentionally unconstrained at the SQL level. */
    targetId: integer('target_id').notNull(),
    /** 'approve' | 'dispute' | 'abstain'. */
    verdict: varchar('verdict', { length: 20 }).notNull(),
    /** Required for dispute/abstain (≥20 chars); empty for implicit-approve. */
    rationaleMd: text('rationale_md').notNull().default(''),
    /** Array of { citationId?, quote?, url? } objects backing the verdict. */
    evidenceRefs: jsonb('evidence_refs')
      .$type<AgentVerificationEvidenceRef[]>()
      .notNull()
      .default([]),
    /** Model id the agent ran under (e.g. 'claude-opus-4-7'); nullable. */
    model: varchar('model', { length: 60 }),
    /**
     * Server-owned capability tier of the verifier, snapshotted from
     * agents.model_tier when the verdict was recorded (NOT the current agent
     * row). This is what the high-risk consensus gate reads, so reassigning an
     * agent's model can never retroactively reclassify its past verdicts. NULL =
     * unclassified at verdict time; never counts as flagship.
     */
    verifierTier: varchar('verifier_tier', { length: 20 }),
    /**
     * The tier as stamped when this verdict was written, and never touched
     * again. `verifierTier` above is the *effective* tier — a demotion
     * restamps it on pending targets so a revoked flagship grant stops
     * counting — which makes it the wrong field for "under which tier was
     * this judgment produced". Audit snapshots read this one (falling back to
     * `verifierTier` for rows written before the column existed).
     */
    recordedVerifierTier: varchar('recorded_verifier_tier', { length: 20 }),
    /** True for the auto-row written when the agent submitted the target. */
    isImplicit: boolean('is_implicit').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('agent_verifs_unique_idx').on(
      t.agentId,
      t.targetType,
      t.targetId,
    ),
    index('agent_verifs_target_idx').on(t.targetType, t.targetId),
    // Partial index that powers the /api/pending-edits dispute boost
    // (disputedTargetIdsForType). Mirrors the index created by migration
    // 0046_agent_verifications.sql so db:push and future schema diffs don't
    // treat the partial index as drift.
    index('agent_verifs_target_dispute_idx')
      .on(t.targetType, t.targetId)
      .where(sql`${t.verdict} = 'dispute'`),
  ],
);

// ─── Verdict reconsiderations (issue #1357) ─────────────────────────────────
//
// The control phase that follows a blind dispute. Peer verification is blind
// on purpose — the queue hides every other verdict so each one is an
// independent measurement — but blindness also means a plain misreading (a
// dispute of something the proposal never claimed) can only be corrected by a
// moderator. Once a dispute stands against at least one peer approval, its
// author is shown the other reviewers' rationales and may maintain the dispute
// with an addendum or withdraw it. One row per (agent, target, target version)
// records that step. It is written the moment the peers are shown, and it is
// the immutable copy of the ORIGINAL blind verdict: the live
// `agent_verifications` row is rewritten (a withdrawal becomes `abstain`), but
// what the agent concluded before it saw its peers stays here unchanged.
export const agentVerdictReconsiderations = pgTable(
  'agent_verdict_reconsiderations',
  {
    id: serial('id').primaryKey(),
    /** The live verdict row this reconsidered; kept even if that row is wiped. */
    verificationId: integer('verification_id').notNull(),
    agentId: integer('agent_id')
      .references(() => agents.id, { onDelete: 'cascade' })
      .notNull(),
    targetType: varchar('target_type', { length: 40 }).notNull(),
    targetId: integer('target_id').notNull(),
    /** verificationTargetVersion at reconsideration time. */
    targetVersion: varchar('target_version', { length: 80 }).notNull(),
    /** The blind verdict as recorded, before the agent saw its peers. */
    originalVerdict: varchar('original_verdict', { length: 20 }).notNull(),
    originalRationaleMd: text('original_rationale_md').notNull(),
    originalEvidenceRefs: jsonb('original_evidence_refs')
      .$type<AgentVerificationEvidenceRef[]>()
      .notNull()
      .default([]),
    originalVerifierTier: varchar('original_verifier_tier', { length: 20 }),
    /** Model id the blind verdict was produced under (agent_verifications.model). */
    originalModel: varchar('original_model', { length: 60 }),
    originalRecordedAt: timestamp('original_recorded_at').notNull(),
    /**
     * 'disclosed' (peers shown, no decision yet) | 'maintained' | 'withdrawn'.
     * The row is written when the peers are shown, so the agent's blind verdict
     * is snapshotted before it could be edited with the peers in view.
     */
    outcome: varchar('outcome', { length: 20 }).notNull().default('disclosed'),
    /** The agent's addendum after reading its peers (≥20 chars once decided). */
    addendumMd: text('addendum_md').notNull().default(''),
    /** When the agent decided; null while only disclosed. */
    decidedAt: timestamp('decided_at'),
    /** Model id the decision (and addendum) was made under; null until decided. */
    decisionModel: varchar('decision_model', { length: 60 }),
    /** agents.model_tier when the decision was made; null until decided. */
    decisionVerifierTier: varchar('decision_verifier_tier', { length: 20 }),
    /**
     * Every peer set the agent was shown, in order: [{ disclosedAt,
     * peerVerdicts }]. `peerVerdicts` above is the last of them — the one the
     * decision is bound to — but the agent read them all.
     */
    peerDisclosures: jsonb('peer_disclosures').notNull().default([]),
    /**
     * The peer verdicts the decision was made against, copied in full (id,
     * verdict, rationale, evidence, tier, time, and the producing agent and
     * model). Peer rows are upserted in place and deleted on a revision, so
     * their ids alone could not say what the agent read or who wrote it.
     */
    peerVerdicts: jsonb('peer_verdicts')
      .$type<
        Array<{
          id: number;
          verdict: string;
          rationaleMd: string;
          evidenceRefs: AgentVerificationEvidenceRef[];
          verifierTier: string | null;
          recordedAt: string;
          /** Who produced it: stored for audit, never shown to the agent. */
          agentId: number;
          model: string | null;
        }>
      >()
      .notNull()
      .default([]),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('agent_verdict_reconsiderations_unique_idx').on(
      t.agentId,
      t.targetType,
      t.targetId,
      t.targetVersion,
    ),
    index('agent_verdict_reconsiderations_target_idx').on(
      t.targetType,
      t.targetId,
    ),
  ],
);

// Per-run token usage for scheduled agent runs (migration 0134), so the tiered
// rollout's cost side is measured next to its accuracy side. One row per run,
// summed from the runner's transcript by scripts/kinetix-log-run-usage.ts and
// read by scripts/benchmark-agent-tiers.ts. Cost is derived at report time from
// a rate card rather than stored, because prices change.
export const agentRunUsage = pgTable(
  'agent_run_usage',
  {
    id: serial('id').primaryKey(),
    agentId: integer('agent_id').references(() => agents.id, {
      onDelete: 'set null',
    }),
    createdBy: integer('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    /**
     * agents.model_tier snapshotted server-side at write time — never taken
     * from the request — so reclassifying the identity later cannot move its
     * past runs between tiers (same rule as agent_verifications.verifier_tier).
     */
    modelTier: varchar('model_tier', { length: 20 }),
    /** AGENT_RUN_WORKFLOWS: which routine ran (producer, escalation, …). */
    workflow: varchar('workflow', { length: 20 }).notNull(),
    /** AGENT_RUN_RUNTIMES: whose transcript the counts were summed from. */
    runtime: varchar('runtime', { length: 20 }).notNull(),
    /** Model id read from the transcript; self-reported, audit only. */
    model: varchar('model', { length: 80 }),
    /**
     * Runner session id; with agent_id, makes a re-log of one run an update
     * of its counts only — tier, workflow and created_at keep the first write.
     */
    sessionId: varchar('session_id', { length: 128 }),
    startedAt: timestamp('started_at'),
    durationMs: integer('duration_ms'),
    /**
     * Normalized so input excludes cache reads on every runtime (Claude
     * reports them apart; Codex reports cached input inside input_tokens).
     */
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheCreationTokens: bigint('cache_creation_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' })
      .notNull()
      .default(0),
    /** The same totals keyed by the model that spent them (subagents). */
    modelUsage: jsonb('model_usage').$type<
      Record<
        string,
        {
          inputTokens: number;
          outputTokens: number;
          cacheCreationTokens: number;
          cacheReadTokens: number;
        }
      >
    >(),
    notes: text('notes'),
  },
  (t) => [
    uniqueIndex('agent_run_usage_agent_session_uq').on(t.agentId, t.sessionId),
    index('agent_run_usage_created_at_idx').on(t.createdAt),
  ],
);

export type AgentRunUsage = typeof agentRunUsage.$inferSelect;

export interface AgentVerificationEvidenceRef {
  citationId?: number;
  quote?: string;
  url?: string;
}

// ─── Parameter priority flags (manual queue boost for agents) ───────────────

export const parameterPriorityFlags = pgTable(
  'parameter_priority_flags',
  {
    id: serial('id').primaryKey(),
    drugId: integer('drug_id')
      .references(() => drugs.id, { onDelete: 'cascade' })
      .notNull(),
    // NULL = whole drug (any/all parameters); otherwise a DrugParameterId.
    parameter: varchar('parameter', { length: 60 }),
    // 'active' = pending, picked up first by the agent; 'resolved' = the
    // flagged parameter has been addressed; 'cancelled' = manually cleared.
    // active → resolved happens automatically when a parameter value change is
    // committed (direct edit, pending-edit approval, or monograph creation; see
    // api/_lib/parameterPriorityFlags.ts), and the agent also flips it for
    // comment-only / verification outcomes that leave the value untouched.
    // Admins can manually flip via DELETE (cancelled).
    status: varchar('status', { length: 20 }).notNull().default('active'),
    // Free-form moderator note explaining the urgency / hint.
    note: text('note'),
    flaggedBy: integer('flagged_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    resolvedBy: integer('resolved_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at'),
  },
  (t) => [
    index('param_priority_status_idx').on(t.status, t.createdAt),
    index('param_priority_drug_param_idx').on(t.drugId, t.parameter),
  ],
);

// ─── Agent focus config (scope of the scheduled maintenance routine) ────────
//
// Singleton row (id = 1) that lets an admin steer what the scheduled
// drug-database maintainer (agents/drug-db-maintainer.md §3) works on each
// cycle. It is a global narrowing of the popularity-ordered queues, not a
// per-drug/parameter boost (that is parameter_priority_flags above).
//
//   mode = 'all'        → any page, drug, and parameter (popularity order;
//                         pageIds/parameters ignored). This is the default.
//   mode = 'pages'      → restrict monograph + parameter work to the wiki
//                         pages / drug monographs listed in pageIds.
//   mode = 'parameters' → restrict parameter work to the DrugParameterIds
//                         listed in parameters, on any drug (popularity order).
export const agentFocusConfig = pgTable('agent_focus_config', {
  // Always 1 — the table holds exactly one row (enforced by the API upsert).
  id: integer('id').primaryKey().default(1),
  mode: varchar('mode', { length: 20 }).notNull().default('all'),
  // wiki_pages.id list for mode='pages'; empty otherwise.
  pageIds: jsonb('page_ids').notNull().default([]),
  // DrugParameterId list for mode='parameters'; empty otherwise.
  parameters: jsonb('parameters').notNull().default([]),
  // Whether the `parameters` array above was written by a writer that
  // understands the composed `methods` + `parameters` focus (migration 0122).
  //
  // The column exists because a migration cannot close the deploy window:
  // `vercel.json` applies migrations at the start of `vercel build`, and the
  // PREVIOUS build keeps serving writes until `vercel deploy` finishes, so a
  // focus saved in between is written by the OLD handler — which never sets
  // this — and lands after any cleanup the migration did. `resolveFocusNarrowing`
  // therefore trusts the array only when this is true, which no old writer can
  // produce. `scopeArraysToMode` derives it from the arrays it is storing, so
  // the flag and the array cannot disagree.
  methodsParametersOptIn: boolean('methods_parameters_opt_in')
    .notNull()
    .default(false),
  // Mode-independent: when true the scheduled agents author no wiki content at
  // all (monograph facts and wiki sections), whichever mode is selected, and
  // work only the parameter queues. Orthogonal to `mode`, which answers *which*
  // drugs/parameters are in scope rather than *whether* the wiki action is open
  // — so an admin can keep a method or page scope and still close the monograph
  // half, which previously required switching to mode='parameters' and losing
  // the drug axis. `mode='parameters'` already implies it (migration 0125).
  skipWikiContent: boolean('skip_wiki_content').notNull().default(false),
  // analytical_methods.id list for mode='methods'; empty otherwise. Focuses
  // the agent on every drug component that belongs to one of these methods
  // (the laboratory's test panels). Stored as ids — it never requires the
  // agent to belong to a group granted method access; the resolved component drug ids
  // are surfaced to the agent through GET /api/agent-focus.
  methodIds: jsonb('method_ids').notNull().default([]),
  updatedBy: integer('updated_by').references(() => users.id, {
    onDelete: 'set null',
  }),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ─── Verification log (agent curation audit trail) ─────────────────────────

export const verificationLog = pgTable(
  'verification_log',
  {
    id: serial('id').primaryKey(),
    // 'parameter' | 'monograph_fact' | 'discussion_sweep' | 'rejection_review' | 'paper_review' | 'paper_extraction' (extend as new target types appear)
    targetType: varchar('target_type', { length: 30 }).notNull(),
    // drugs.id for parameter rows, wiki_pages.id for monograph rows, citations.id
    // for paper_review / paper_extraction rows, NULL for sweep rows
    targetId: integer('target_id'),
    // DrugParameterId for parameter rows; NULL otherwise
    parameter: varchar('parameter', { length: 60 }),
    verifiedAt: timestamp('verified_at').defaultNow().notNull(),
    agentNotes: text('agent_notes'),
    sourcesConsultedCount: integer('sources_consulted_count')
      .notNull()
      .default(0),
    // 'strong' | 'moderate' | 'weak' | 'absent'; NULL for sweep
    concordance: varchar('concordance', { length: 10 }),
    // 'submitted_pending' | 'flagged' | 'commented_only' | 'no_change'
    outcome: varchar('outcome', { length: 30 }).notNull(),
    createdBy: integer('created_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    // Supports "latest verification for this (drug, parameter)" (prioritization §3.B)
    index('verification_log_target_param_idx').on(
      t.targetType,
      t.targetId,
      t.parameter,
      t.verifiedAt,
    ),
    // Supports "MAX(verified_at) for target_type" (discussion sweep watermark)
    index('verification_log_type_verified_idx').on(t.targetType, t.verifiedAt),
    // Supports the absent-cooldown check in the parameter-gap queue
    // (GET /api/agent-sweep?mode=parameter_gaps): "has this pair been searched
    // exhaustively-but-empty inside the cooldown window?". 'absent' rows are a
    // small minority of parameter verifications, so a partial index over just
    // them stays cheap as the log grows. Mirrors migration 0097 so db:push and
    // future schema diffs don't treat it as drift.
    index('verification_log_absent_param_idx')
      .on(t.targetId, t.parameter, t.verifiedAt.desc())
      .where(
        sql`${t.targetType} = 'parameter' AND ${t.concordance} = 'absent'`,
      ),
  ],
);

// ─── Disputes (unified human + agent contestation of a fact/parameter) ──────
//
// Canonical record that "someone contests this target". Unlike
// `agent_verifications` (one row per agent, agent-only, also carrying
// approve/abstain verdicts), `disputes` is authored by HUMANS as well as
// agents and only ever records a contestation — so a contributor who spots a
// wrong fact has the same first-class "dispute" verb an agent has.
//
// Bridge model (see docs/superpowers/specs/2026-06-23-unified-disputes.md):
// agent dispute *verdicts* still flow through `agent_verifications` and still
// drive consensus auto-apply unchanged; the POST handler additionally mirrors
// each agent dispute into a row here (source='agent') so this table is the one
// place to enumerate every open dispute — the deterministic feed agents poll
// (GET /api/disputes) and the signal that fans out notifications. A human
// dispute (source='human') additionally blocks consensus auto-apply, exactly
// like an agent dispute, because an open contestation should hold an edit for
// review however it was raised.
export const disputes = pgTable(
  'disputes',
  {
    id: serial('id').primaryKey(),
    /** Discriminator: see AgentVerificationTargetType (shared taxonomy). */
    targetType: varchar('target_type', { length: 40 }).notNull(),
    /** Per-type FK; intentionally unconstrained at the SQL level. */
    targetId: integer('target_id').notNull(),
    /**
     * The target's `verificationTargetVersion` at the moment the dispute was
     * opened (or last refreshed) — the same opaque token
     * `POST /api/agent-verifications` validates. Nullable only for rows
     * written before this column existed; every row POST /api/disputes
     * creates or updates from here on carries one, so the objection is bound
     * to the payload it actually read rather than inferred from `created_at`,
     * which a later revision leaves untouched-but-superseded.
     */
    targetVersion: varchar('target_version', { length: 80 }),
    /** users.id of the author — a human, or an agent's backing user. */
    createdBy: integer('created_by')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    /** 'human' | 'agent' — provenance, so the feed can distinguish the two. */
    source: varchar('source', { length: 20 }).notNull().default('human'),
    /** Why it's contested (required, ≥20 chars enforced at the API edge). */
    reasonMd: text('reason_md').notNull(),
    /** Array of { citationId?, quote?, url? } objects backing the dispute. */
    evidenceRefs: jsonb('evidence_refs')
      .$type<AgentVerificationEvidenceRef[]>()
      .notNull()
      .default([]),
    /** 'open' | 'resolved' — open disputes block consensus + drive the feed. */
    status: varchar('status', { length: 20 }).notNull().default('open'),
    /** How an open dispute closed: 'upheld' | 'rejected' | 'withdrawn'. */
    resolution: varchar('resolution', { length: 20 }),
    resolvedBy: integer('resolved_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    resolvedAt: timestamp('resolved_at'),
    /**
     * When the scheduled digest escalated this dispute to the admins for
     * being overdue (#1233, `api/_lib/notificationEmails.ts`). NULL = not
     * escalated. Set once, by a conditional UPDATE, so overlapping digest
     * runs never escalate the same dispute twice.
     */
    escalatedAt: timestamp('escalated_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    // At most one OPEN dispute per (author, target): re-disputing updates the
    // existing open row rather than stacking duplicates. A resolved row leaves
    // the partial index, so the same author can dispute again later.
    uniqueIndex('disputes_open_author_target_idx')
      .on(t.targetType, t.targetId, t.createdBy)
      .where(sql`${t.status} = 'open'`),
    // Powers "is this target disputed" + the consensus/queue boost lookups.
    index('disputes_target_idx').on(t.targetType, t.targetId),
    // Powers the deterministic oldest-first open-dispute feed (GET /api/disputes).
    index('disputes_status_created_idx').on(t.status, t.createdAt),
  ],
);

// ─── T3 adjudication (0138) ─────────────────────────────────────────────────
//
// The non-blind two-panelist appellate tier for a disagreement that survives
// blind T2 re-verification (agents/drug-db-adjudication.md,
// docs/plans/2026-09-18-t3-adjudication-backend.md). Shaped like the
// governance store: a pinned immutable version, verdicts copied in rather than
// referenced, and append-only opinions.

/** One verdict as the case copied it: the appeal record a later re-verdict cannot rewrite. */
export type AdjudicationVerdictSnapshot = {
  verificationId: number;
  agentId: number;
  verdict: string;
  rationaleMd: string;
  evidenceRefs: AgentVerificationEvidenceRef[];
  verifierTier: string | null;
  model: string | null;
  recordedAt: string;
};

/** One open dispute as the case copied it, with its provenance. */
export type AdjudicationDisputeSnapshot = {
  disputeId: number;
  source: string;
  createdBy: number;
  reasonMd: string;
  evidenceRefs: unknown;
  createdAt: string;
};

export type AdjudicationTrigger =
  | 't1_t2_disagreement'
  | 'competing_scope'
  | 'flagship_disagreement'
  | 'repeated_correction_loop'
  | 'human_request';
export type AdjudicationDisputeOrigin = 'agent' | 'human' | 'mixed';
export type AdjudicationCaseState =
  | 'open'
  | 'sealed'
  | 'converged'
  | 'diverged'
  | 'invalidated';
export type AdjudicationSeat = 'a' | 'b';
export type AdjudicationResolution =
  | 'approve'
  | 'dispute'
  | 'return'
  | 'split_scope'
  | 'abstain'
  | 'human';

/** Why two sealed opinions did not converge (null when they did). */
export type AdjudicationDivergenceReason =
  | 'resolution_differs'
  | 'scope_differs'
  | 'value_shape_differs'
  | 'value_differs'
  | 'unit_family_differs'
  | 'unit_not_convertible';

/** The typed comparison of the two sealed opinions (0141). */
export type AdjudicationConvergence = {
  converged: boolean;
  reason: AdjudicationDivergenceReason | null;
  /** A panelist resolved `human` or set humanRequired. */
  humanRequested: boolean;
  /** The canonical unit both values were compared in, when a value was. */
  canonicalUnit: string | null;
  comparedAt: string;
};

/** What a converged panel recommends. A recommendation only (0141). */
export type AdjudicationRecommendation = {
  resolution: AdjudicationResolution;
  scopeKey: Record<string, string>;
  /** Canonical-unit value both panelists endorsed, when they endorsed one. */
  value:
    | { kind: 'scalar'; value: number; unit: string }
    | { kind: 'range'; low: number; high: number; unit: string }
    | null;
  opinionIds: number[];
};

/** One opinion as the T4 handoff carries it. */
export type AdjudicationHandoffOpinion = {
  opinionId: number;
  seat: AdjudicationSeat;
  agentId: number;
  adjudicatorTier: string | null;
  adjudicatorFamily: string | null;
  model: string | null;
  resolution: AdjudicationResolution;
  proposition: string;
  scopeKey: Record<string, string>;
  resolvedValue: number | null;
  resolvedLow: number | null;
  resolvedHigh: number | null;
  resolvedUnit: string | null;
  reasoningMd: string;
  evidenceRefs: unknown;
  confidence: string;
  humanRequired: boolean;
  humanReason: string | null;
  finalizedAt: string;
};

/**
 * What the panel adjudicated (0141): the target exactly as the case file
 * served it to the panel at the sealing write — hydrated, with the current
 * value, entry or content it is compared against — and its source row.
 */
export type AdjudicatedTarget = {
  /** The hydrated target (agent-verifications-queue `QueueItem`) served to the panel. */
  served: Record<string, unknown>;
  sourceRow: Record<string, unknown> | null;
  /**
   * What the comparison converts through, pinned at binding: the parameter's
   * canonical unit (null for a target that carries no value) and the drug's
   * molecular weight for a mass↔molar conversion.
   */
  comparison: { canonicalUnit: string | null; molecularWeight: number | null };
  /** The decided disputes on the target as served to the panel. */
  decidedDisputes: AdjudicationDecidedDispute[];
  /**
   * The lower-tier record as served to the panel: the copied verdicts and the
   * open disputes on the version, read at binding. A dispute filed later
   * still reaches the case record (and decides who closes it) at sealing,
   * but never one seat's case file and not the other's.
   */
  lowerTier: {
    t2Verdicts: AdjudicationVerdictSnapshot[];
    t1Verdicts: AdjudicationVerdictSnapshot[];
    openDisputes: AdjudicationDisputeSnapshot[];
  };
  /** Why the case opened and whose objection it rests on, as served to the panel. */
  context: {
    triggers: AdjudicationTrigger[];
    triggerDetail: Record<string, unknown>;
    disputeOrigin: AdjudicationDisputeOrigin;
  };
};

export type AdjudicationDecidedDispute = {
  disputeId: number;
  source: string;
  targetVersion: string | null;
  reasonMd: string;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
};

/** Why a converged agent-only case was not closed automatically (0142). */
export type AdjudicationClosureDeclined =
  /** Split into two scopes: a product decision on representation. */
  | 'split_scope'
  /** A clinical case is always a person's. */
  | 'clinical'
  /** A categorical axis that changes the model family is admin-tier. */
  | 'model_structure'
  /** Both seats approved, but a value other than the proposal's own. */
  | 'value_differs'
  /** Both seats approved a value, but the proposal's could not be read. */
  | 'value_unverifiable'
  /** An agent dispute opened after the panel was bound: neither seat saw it. */
  | 'unseen_dispute'
  /**
   * Both seats sustained the objection, but the target is not a pending edit:
   * there is no return to give it, and a published record is corrected by a
   * person.
   */
  | 'no_disposition'
  /**
   * An agent dispute verdict with no `disputes` row to close (one recorded
   * before the dispute table mirrored verdicts): closing would leave it
   * holding the proposal.
   */
  | 'unmirrored_dispute';

/**
 * What the automatic closure of a converged agent-only case did (0142):
 * `overruled` (both seats approved the proposal; its agent disputes resolve
 * `rejected`), `upheld` (both seats sustained the objection; they resolve
 * `upheld` and a pending edit is returned), `none` (no agent dispute was
 * still open), or `declined` (handed to a person instead).
 */
export type AdjudicationClosure = {
  action: 'overruled' | 'upheld' | 'none' | 'declined';
  declined: AdjudicationClosureDeclined | null;
  disputeIds: number[];
  /** For an upheld pending edit: whether it went back to its author. */
  pendingEditReturned: boolean | null;
  returnSkipped: string | null;
  at: string;
};

/** The T4 package a person gets, so nobody reconstructs the appeal from logs (0141). */
export type AdjudicationHandoff = {
  caseId: number;
  targetType: string;
  targetId: number;
  targetVersion: string;
  disputeOrigin: AdjudicationDisputeOrigin;
  triggers: AdjudicationTrigger[];
  /** Why a person is needed, in order of weight. */
  reasons: Array<
    | 'panel_diverged'
    | 'human_requested'
    | 'panel_abstained'
    | 'human_dispute'
    | 'panel_conflicted'
    // The panel converged on an agent-only case, but the closure would not act
    // on it (./closure.ts): see `AdjudicationClosure.declined`.
    | 'closure_declined'
    // The panel upheld the objection, but the proposal could not be returned.
    | 'return_refused'
  >;
  /**
   * One paragraph, in English, of what remains disputed: the record's prose
   * for agents and the API. A screen or email renders from `reasons` and
   * `convergence.reason` in the reader's language instead.
   */
  summary: string;
  opinions: AdjudicationHandoffOpinion[];
  t2Snapshot: AdjudicationVerdictSnapshot[];
  t1Snapshot: {
    verdicts: AdjudicationVerdictSnapshot[];
    openDisputes: AdjudicationDisputeSnapshot[];
  };
  /** The sources both panelists cited, de-duplicated. */
  decisiveSources: unknown[];
  convergence: AdjudicationConvergence;
  recommendation: AdjudicationRecommendation | null;
  createdAt: string;
};

export const adjudicationCases = pgTable(
  'adjudication_cases',
  {
    id: serial('id').primaryKey(),
    targetType: varchar('target_type', { length: 40 }).notNull(),
    targetId: integer('target_id').notNull(),
    /** The exact verificationTargetVersion this case adjudicates. */
    targetVersion: varchar('target_version', { length: 80 }).notNull(),
    /** Trigger codes that opened or later joined the case, in order. */
    triggers: jsonb('triggers').$type<AdjudicationTrigger[]>().notNull().default([]),
    /** Per-trigger detail, e.g. a lower-bound cycle count. */
    triggerDetail: jsonb('trigger_detail')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    disputeOrigin: varchar('dispute_origin', { length: 10 })
      .$type<AdjudicationDisputeOrigin>()
      .notNull(),
    /** Traceability only; t2Snapshot is the record of what T2 said. */
    t2VerificationId: integer('t2_verification_id').references(
      () => agentVerifications.id,
      { onDelete: 'set null' },
    ),
    t2Snapshot: jsonb('t2_snapshot').$type<AdjudicationVerdictSnapshot[]>().notNull(),
    t1Snapshot: jsonb('t1_snapshot')
      .$type<{
        verdicts: AdjudicationVerdictSnapshot[];
        openDisputes: AdjudicationDisputeSnapshot[];
      }>()
      .notNull(),
    state: varchar('state', { length: 20 })
      .$type<AdjudicationCaseState>()
      .notNull()
      .default('open'),
    panelFamilyDiversity: varchar('panel_family_diversity', { length: 10 }),
    openedAt: timestamp('opened_at').defaultNow().notNull(),
    sealedAt: timestamp('sealed_at'),
    closedAt: timestamp('closed_at'),
    invalidatedReason: text('invalidated_reason'),
    /** When the detector last re-checked this case; the sweep rotates on it. */
    lastCheckedAt: timestamp('last_checked_at'),
    /** The typed comparison of the two sealed opinions (0141). */
    convergence: jsonb('convergence').$type<AdjudicationConvergence>(),
    /** What a converged panel recommends; a recommendation only (0141). */
    recommendation: jsonb('recommendation').$type<AdjudicationRecommendation>(),
    /** A person must take the case (0141). */
    t4Required: boolean('t4_required').notNull().default(false),
    /** The T4 package for that person (0141). */
    handoff: jsonb('handoff').$type<AdjudicationHandoff>(),
    /**
     * The target as the panel adjudicated it, copied at sealing under the
     * source-row lock — for every sealed outcome, converged or handed off — so
     * later revisions of the live row, or of the baselines served beside it,
     * cannot change the record of what was decided (0141).
     */
    adjudicatedTarget: jsonb('adjudicated_target').$type<AdjudicatedTarget>(),
    /** What the automatic closure did with a converged agent-only case (0142). */
    closure: jsonb('closure').$type<AdjudicationClosure>(),
  },
  (t) => [
    // Permanent, not "while live": a target version is adjudicated at most once.
    uniqueIndex('adjudication_cases_target_version_uq').on(
      t.targetType,
      t.targetId,
      t.targetVersion,
    ),
    index('adjudication_cases_state_checked_idx').on(t.state, t.lastCheckedAt),
    check(
      'adjudication_cases_dispute_origin_check',
      sql`${t.disputeOrigin} IN ('agent', 'human', 'mixed')`,
    ),
    check(
      'adjudication_cases_state_check',
      sql`${t.state} IN ('open', 'sealed', 'converged', 'diverged', 'invalidated')`,
    ),
    check(
      'adjudication_cases_panel_family_diversity_check',
      sql`${t.panelFamilyDiversity} IS NULL OR ${t.panelFamilyDiversity} IN ('distinct', 'same', 'unknown')`,
    ),
  ],
);

/**
 * When the detector sweep last classified each target and the latest
 * verdict/dispute activity it saw, so the sweep skips unchanged targets and
 * rotates through the rest instead of re-reading one prefix.
 */
export const adjudicationDetectorChecks = pgTable(
  'adjudication_detector_checks',
  {
    targetType: varchar('target_type', { length: 40 }).notNull(),
    targetId: integer('target_id').notNull(),
    checkedAt: timestamp('checked_at').defaultNow().notNull(),
    activityAt: timestamp('activity_at'),
  },
  (t) => [
    primaryKey({
      name: 'adjudication_detector_checks_pk',
      columns: [t.targetType, t.targetId],
    }),
  ],
);

export const adjudicationCaseSeats = pgTable(
  'adjudication_case_seats',
  {
    id: serial('id').primaryKey(),
    caseId: integer('case_id')
      .references(() => adjudicationCases.id, { onDelete: 'cascade' })
      .notNull(),
    seat: varchar('seat', { length: 1 }).$type<AdjudicationSeat>().notNull(),
    agentId: integer('agent_id')
      .references(() => agents.id)
      .notNull(),
    claimedAt: timestamp('claimed_at').defaultNow().notNull(),
    sealedAt: timestamp('sealed_at'),
  },
  (t) => [
    uniqueIndex('adjudication_case_seats_case_seat_uq').on(t.caseId, t.seat),
    uniqueIndex('adjudication_case_seats_case_agent_uq').on(t.caseId, t.agentId),
    check('adjudication_case_seats_seat_check', sql`${t.seat} IN ('a', 'b')`),
  ],
);

/** Append-only: a database trigger refuses every UPDATE and DELETE (0138). */
export const adjudicationOpinions = pgTable(
  'adjudication_opinions',
  {
    id: serial('id').primaryKey(),
    caseId: integer('case_id').notNull(),
    seat: varchar('seat', { length: 1 }).$type<AdjudicationSeat>().notNull(),
    /** Derived server-side; the loser of a concurrent append hits the unique index. */
    revisionNo: integer('revision_no').notNull(),
    /** On the NEW row, pointing back at the one it replaces. */
    supersedesOpinionId: integer('supersedes_opinion_id'),
    /** agents.model_tier at write time. */
    adjudicatorTier: varchar('adjudicator_tier', { length: 20 }),
    /**
     * agents.model_family at write time (0141), so the panel's family
     * diversity is recorded as the panel was, whatever the grant says later.
     */
    adjudicatorFamily: varchar('adjudicator_family', { length: 40 }),
    /** Self-reported, audit only. */
    model: varchar('model', { length: 80 }),
    resolution: varchar('resolution', { length: 20 })
      .$type<AdjudicationResolution>()
      .notNull(),
    proposition: text('proposition').notNull(),
    /** The structured scope the resolution applies to; compared in code. */
    scopeKey: jsonb('scope_key').$type<Record<string, string>>().notNull().default({}),
    resolvedValue: doublePrecision('resolved_value'),
    resolvedLow: doublePrecision('resolved_low'),
    resolvedHigh: doublePrecision('resolved_high'),
    resolvedUnit: varchar('resolved_unit', { length: 40 }),
    reasoningMd: text('reasoning_md').notNull(),
    evidenceRefs: jsonb('evidence_refs').notNull().default([]),
    confidence: varchar('confidence', { length: 10 }).notNull(),
    humanRequired: boolean('human_required').notNull().default(false),
    humanReason: text('human_reason'),
    /** Non-null = final and immutable. */
    finalizedAt: timestamp('finalized_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('adjudication_opinions_case_seat_revision_uq').on(
      t.caseId,
      t.seat,
      t.revisionNo,
    ),
    foreignKey({
      name: 'adjudication_opinions_seat_fk',
      columns: [t.caseId, t.seat],
      foreignColumns: [adjudicationCaseSeats.caseId, adjudicationCaseSeats.seat],
    }),
    foreignKey({
      name: 'adjudication_opinions_supersedes_fk',
      columns: [t.supersedesOpinionId],
      foreignColumns: [t.id],
    }),
    check(
      'adjudication_opinions_resolution_check',
      sql`${t.resolution} IN ('approve', 'dispute', 'return', 'split_scope', 'abstain', 'human')`,
    ),
    check(
      'adjudication_opinions_confidence_check',
      sql`${t.confidence} IN ('high', 'medium', 'low')`,
    ),
    check(
      'adjudication_opinions_human_reason_check',
      sql`NOT ${t.humanRequired} OR ${t.humanReason} IS NOT NULL`,
    ),
    check(
      'adjudication_opinions_value_shape_check',
      sql`(${t.resolvedValue} IS NULL OR (${t.resolvedLow} IS NULL AND ${t.resolvedHigh} IS NULL))
        AND ((${t.resolvedLow} IS NULL) = (${t.resolvedHigh} IS NULL))
        AND (${t.resolvedLow} IS NULL OR ${t.resolvedLow} <= ${t.resolvedHigh})
        AND ((${t.resolvedUnit} IS NULL) = (${t.resolvedValue} IS NULL AND ${t.resolvedLow} IS NULL))`,
    ),
  ],
);

// ─── Notifications (in-app inbox) ──────────────────────────────────────────
//
// One row per (recipient, event). Fanned out on dispute open/resolve to the
// target author plus every reviewer/editor/admin, and on escalation of an
// overdue dispute to the admins (see api/_lib/notifications.ts). Agents are
// intentionally NOT notified here — they pull the deterministic GET
// /api/disputes feed each cycle instead of needing a push channel. The inbox
// is in-app; the email channel is the scheduled digest (#1233).
export const notifications = pgTable(
  'notifications',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    /** A {@link NotificationType}: dispute opened / resolved / escalated. */
    type: varchar('type', { length: 40 }).notNull(),
    /** Optional link back to the subject (polymorphic, unconstrained). */
    targetType: varchar('target_type', { length: 40 }),
    targetId: integer('target_id'),
    disputeId: integer('dispute_id').references(() => disputes.id, {
      onDelete: 'cascade',
    }),
    title: text('title').notNull(),
    bodyMd: text('body_md'),
    /** App-relative URL the notification deep-links to (e.g. /review). */
    url: text('url'),
    readAt: timestamp('read_at'),
    /**
     * {@link NotificationAudience}: 'author' = feedback on the recipient's own
     * contribution, 'reviewer' = the review queue. Selects which email opt-in
     * (src/lib/emailNotificationPrefs.ts) governs this row.
     */
    audience: varchar('audience', { length: 20 }).notNull().default('reviewer'),
    /**
     * Set once the row was emailed (alone or in a summary) or skipped because
     * it predates the opt-in. NULL = still owed an email if the recipient opts
     * in to its audience. Written only after a successful send (migration 0133).
     */
    emailHandledAt: timestamp('email_handled_at'),
    /**
     * A delivery run's lease on the row while it sends; a lapsed lease makes
     * the row claimable again, so a run that dies mid-send loses nothing.
     */
    emailClaimedAt: timestamp('email_claimed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    // "my unread, newest first" — the inbox's primary query.
    index('notifications_user_read_idx').on(t.userId, t.readAt, t.createdAt),
    // The email delivery job's "still owed an email" scan.
    index('notifications_email_pending_idx')
      .on(t.userId, t.createdAt)
      .where(sql`${t.emailHandledAt} IS NULL`),
  ],
);

// ─── Paper fact-extraction queue ───────────────────────────────────────────
//
// An editor/admin uploads a full-text paper (the PDF rail already exists:
// pdf_requests → citation_pdfs → Vercel Blob) and enqueues it here. A scheduled
// agent (agents/paper-fact-extractor.md) claims one job per run, reads the
// stored PDF, and distributes the paper's atomic facts to the monographs and
// wiki pages they belong to as `wiki_fact` pending edits — so every extracted
// fact still lands in the human review queue like any other contributor edit.
//
// The queue deliberately holds no extracted content of its own. It is a work
// ticket: what to read, who asked, what the run produced. The facts live in
// `pending_edits` and, once approved, in the wiki pages themselves.
export const paperExtractionJobs = pgTable(
  'paper_extraction_jobs',
  {
    id: serial('id').primaryKey(),
    citationId: integer('citation_id')
      .references(() => citations.id, { onDelete: 'cascade' })
      .notNull(),
    /** PAPER_EXTRACTION_STATUSES — see src/lib/paperExtraction.ts. */
    status: varchar('status', { length: 12 }).notNull().default('queued'),
    /**
     * Editor's steer for the run: which angle of the paper matters, which
     * drug/topic it is about, what to ignore. Free text, untrusted by the
     * agent (data, never instructions).
     */
    scopeNote: text('scope_note'),
    /**
     * Optional hint listing the drugs whose monographs the editor expects to
     * receive facts. Advisory only — the agent still maps each fact to the
     * page it actually belongs on.
     */
    targetDrugIds: integer('target_drug_ids').array(),
    requestedBy: integer('requested_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** The agent user that holds the current claim (NULL unless claimed). */
    claimedBy: integer('claimed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    claimedAt: timestamp('claimed_at'),
    /**
     * Identifies the claim *instance*, not its owner. Minted fresh on every
     * claim and required to report an outcome.
     *
     * `claimed_by` alone cannot do this job: the expected deployment runs one
     * agent identity on a schedule, so a run that died and the run that later
     * reclaimed its job carry the SAME user id. Without a per-claim value, a
     * stale run waking up late would pass an owner check and overwrite its
     * successor's live claim and result.
     */
    claimToken: varchar('claim_token', { length: 32 }),
    /**
     * Claims taken, including ones that died mid-run. A claim older than the
     * stale window is reclaimable, so this is the only thing standing between
     * a paper that crashes the agent and an infinite retry loop.
     */
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /** Agent's end-of-run summary (Norwegian, reader-facing). */
    resultSummary: text('result_summary'),
    /** Count of `wiki_fact` pending edits the run submitted. */
    factsSubmitted: integer('facts_submitted'),
    /** The pending_edits rows the run created, for reviewer follow-through. */
    pendingEditIds: integer('pending_edit_ids').array(),
    completedAt: timestamp('completed_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    // At most one OPEN job per paper. Re-queueing a paper that is already
    // waiting (or mid-extraction) would have two agents reading the same PDF
    // and submitting the same facts — the duplicate wiki_fact rows a reviewer
    // then has to reconcile. Finished jobs are unconstrained so a paper can be
    // re-extracted later (new sections, corrected full text).
    uniqueIndex('paper_extraction_jobs_open_citation_idx')
      .on(t.citationId)
      .where(sql`status in ('queued', 'claimed')`),
    // The claim query: oldest claimable job first.
    index('paper_extraction_jobs_status_created_idx').on(
      t.status,
      t.createdAt,
    ),
  ],
);

/**
 * A cohort whose postmortem concentration distribution Kinetix carries whole.
 *
 * Deliberately NOT `parameter_entries`. Every summarizable parameter pools
 * per-paper values into a weighted median + IQR, which is the right shape for
 * "what does the literature say this drug's half-life is" and the wrong shape
 * for a single laboratory's order statistics over tens of thousands of cases:
 * pooling a 97.5th percentile with somebody else's would produce a number no
 * cohort ever measured. The distribution is the unit of meaning here, so it is
 * stored, displayed and cited as one.
 *
 * Source-keyed rather than single-purpose: a second PM cohort is an INSERT,
 * not a migration.
 */
export const pmConcentrationSources = pgTable('pm_concentration_sources', {
  id: serial('id').primaryKey(),
  /** Stable slug from the dataset file (e.g. 'example-cohort-2023'). */
  key: varchar('key', { length: 60 }).unique().notNull(),
  /**
   * Citation exactly as it should appear beside the numbers. Free text and
   * not a `citations` row on purpose: this material is unpublished conference
   * data with no DOI or PMID, and minting a handle-less citation row would put
   * something in the reference index that nobody can look up.
   */
  citation: text('citation').notNull(),
  /** Short label for a chart line, where the full citation will not fit. */
  shortLabel: varchar('short_label', { length: 40 }).notNull(),
  /** The source table's own heading, shown above the numbers verbatim. */
  heading: text('heading').notNull(),
  /** Sampled matrix for every row of this cohort. */
  matrix: varchar('matrix', { length: 40 }).notNull(),
  /** Unit every numeric column of this cohort is expressed in. */
  unit: varchar('unit', { length: 20 }).notNull(),
  description: text('description').notNull(),
  /** Reader-facing limits, rendered wherever the numbers are. */
  caveats: jsonb('caveats').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const pmConcentrationDistributions = pgTable(
  'pm_concentration_distributions',
  {
    id: serial('id').primaryKey(),
    sourceId: integer('source_id')
      .references(() => pmConcentrationSources.id, { onDelete: 'cascade' })
      .notNull(),
    drugId: integer('drug_id')
      .references(() => drugs.id, { onDelete: 'cascade' })
      .notNull(),
    /** Analyte name as the source table prints it, kept for auditability. */
    analyte: varchar('analyte', { length: 200 }).notNull(),
    /** Cases contributing to this row. */
    n: integer('n').notNull(),
    // Order statistics, stored in the source's own unit and matrix. `numeric`
    // rather than `double precision` so a transcribed decimal round-trips
    // exactly — these are read back and displayed as published.
    loq: numeric('loq', { precision: 14, scale: 6 }),
    mean: numeric('mean', { precision: 14, scale: 6 }),
    median: numeric('median', { precision: 14, scale: 6 }),
    p90: numeric('p90', { precision: 14, scale: 6 }),
    p95: numeric('p95', { precision: 14, scale: 6 }),
    p975: numeric('p975', { precision: 14, scale: 6 }),
    /**
     * The source's OWN therapeutic plasma concentration and median(PM)/TC
     * ratio. Held here, inside the cohort, precisely so it never reaches the
     * `therapeuticConcentration` pool: that parameter is built from reviewed
     * per-paper source values, and a single unsourced comparison figure would
     * silently reweight it. The ratio is what the source printed, not a value
     * recomputed from the two columns.
     */
    tcPlasma: numeric('tc_plasma', { precision: 14, scale: 6 }),
    medianOverTc: numeric('median_over_tc', { precision: 14, scale: 6 }),
    /**
     * A defect in the printed table (e.g. a percentile out of order). Set
     * means the row is displayed with the note attached; `undrawable` names
     * the statistics that must not become chart lines.
     */
    anomaly: text('anomaly'),
    undrawable: jsonb('undrawable').$type<string[]>().notNull().default([]),
    /** Open question about which analyte the row maps to. */
    reviewNote: text('review_note'),
    /**
     * Exact source strings for values a float cannot reproduce, keyed by
     * column (`{ p95: '0.20' }`). Trailing zeros state significant figures,
     * and these numbers get quoted in forensic work.
     */
    printed: jsonb('printed').$type<Record<string, string>>().notNull().default({}),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    // One row per analyte per cohort. This is what makes the seeder idempotent
    // by source observation: a corrected transcription updates the row instead
    // of adding a second distribution for the same drug.
    uniqueIndex('pm_concentration_distributions_source_drug_idx').on(
      t.sourceId,
      t.drugId,
    ),
    // The read path: "every distribution for the drugs on this chart".
    index('pm_concentration_distributions_drug_idx').on(t.drugId),
  ],
);

// ─── Type exports ─────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type UserGroup = typeof userGroups.$inferSelect;
export type NewUserGroup = typeof userGroups.$inferInsert;
export type UserGroupMember = typeof userGroupMembers.$inferSelect;
export type WikiPage = typeof wikiPages.$inferSelect;
export type NewWikiPage = typeof wikiPages.$inferInsert;
export type WikiRevision = typeof wikiRevisions.$inferSelect;
export type NewWikiRevision = typeof wikiRevisions.$inferInsert;
export type WikiCategory = typeof wikiCategories.$inferSelect;
export type WikiPageCategory = typeof wikiPageCategories.$inferSelect;
export type SimulatorCase = typeof simulatorCases.$inferSelect;
export type NewSimulatorCase = typeof simulatorCases.$inferInsert;
export type Drug = typeof drugs.$inferSelect;
export type DrugParameter = typeof drugParameters.$inferSelect;
export type DrugIonizationConstant =
  typeof drugIonizationConstants.$inferSelect;
export type NewDrugIonizationConstant =
  typeof drugIonizationConstants.$inferInsert;
export type DrugMetabolismProfile = typeof drugMetabolismProfiles.$inferSelect;
export type NewDrugMetabolismProfile =
  typeof drugMetabolismProfiles.$inferInsert;
export type DrugMetabolite = typeof drugMetabolites.$inferSelect;
export type NewDrugMetabolite = typeof drugMetabolites.$inferInsert;
export type DrugEliminationRoute = typeof drugEliminationRoutes.$inferSelect;
export type NewDrugEliminationRoute = typeof drugEliminationRoutes.$inferInsert;
export type BioEntity = typeof bioEntities.$inferSelect;
export type NewBioEntity = typeof bioEntities.$inferInsert;
export type BioEntityFunction = typeof bioEntityFunctions.$inferSelect;
export type NewBioEntityFunction = typeof bioEntityFunctions.$inferInsert;
export type DrugEnzymeInteraction = typeof drugEnzymeInteractions.$inferSelect;
export type NewDrugEnzymeInteraction =
  typeof drugEnzymeInteractions.$inferInsert;
export type DrugReceptorTarget = typeof drugReceptorTargets.$inferSelect;
export type NewDrugReceptorTarget = typeof drugReceptorTargets.$inferInsert;
export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
export type AgentStatusHistoryRow = typeof agentStatusHistory.$inferSelect;
export type NewAgentStatusHistoryRow = typeof agentStatusHistory.$inferInsert;
export type UserRoleHistoryRow = typeof userRoleHistory.$inferSelect;
export type NewUserRoleHistoryRow = typeof userRoleHistory.$inferInsert;
export type AgentHookRun = typeof agentHookRuns.$inferSelect;
export type NewAgentHookRun = typeof agentHookRuns.$inferInsert;
export type NewDrugParameter = typeof drugParameters.$inferInsert;
export type NewDrug = typeof drugs.$inferInsert;
export type DrugParameterRevision = typeof drugParameterRevisions.$inferSelect;
export type NewDrugParameterRevision =
  typeof drugParameterRevisions.$inferInsert;
export type DrugParameterDiscussion =
  typeof drugParameterDiscussions.$inferSelect;
export type NewDrugParameterDiscussion =
  typeof drugParameterDiscussions.$inferInsert;
export type AnalyticalMethod = typeof analyticalMethods.$inferSelect;
export type NewAnalyticalMethod = typeof analyticalMethods.$inferInsert;
export type DrugInteraction = typeof drugInteractions.$inferSelect;
export type NewDrugInteraction = typeof drugInteractions.$inferInsert;
export type AllowedEmailDomain = typeof allowedEmailDomains.$inferSelect;
export type NewAllowedEmailDomain = typeof allowedEmailDomains.$inferInsert;
export type AllowedEmail = typeof allowedEmails.$inferSelect;
export type NewAllowedEmail = typeof allowedEmails.$inferInsert;
export type Citation = typeof citations.$inferSelect;
export type NewCitation = typeof citations.$inferInsert;
export type PaperReview = typeof paperReviews.$inferSelect;
export type NewPaperReview = typeof paperReviews.$inferInsert;
export type PaperReviewRevision = typeof paperReviewRevisions.$inferSelect;
export type NewPaperReviewRevision = typeof paperReviewRevisions.$inferInsert;
export type ParameterEntry = typeof parameterEntries.$inferSelect;
export type NewParameterEntry = typeof parameterEntries.$inferInsert;
export type PendingEdit = typeof pendingEdits.$inferSelect;
export type NewPendingEdit = typeof pendingEdits.$inferInsert;
export type ParameterPriorityFlag = typeof parameterPriorityFlags.$inferSelect;
export type NewParameterPriorityFlag =
  typeof parameterPriorityFlags.$inferInsert;
export type AgentFocusConfig = typeof agentFocusConfig.$inferSelect;
export type NewAgentFocusConfig = typeof agentFocusConfig.$inferInsert;
export type VerificationLog = typeof verificationLog.$inferSelect;
export type NewVerificationLog = typeof verificationLog.$inferInsert;
export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;
/** Stable target-type discriminator for the polymorphic approvals table. */
export type ApprovalTargetType =
  | 'wiki_revision'
  | 'drug_parameter_revision'
  | 'drug_discussion'
  | 'paper_review'
  | 'learning_unit_revision';

export type AgentVerification = typeof agentVerifications.$inferSelect;
export type NewAgentVerification = typeof agentVerifications.$inferInsert;

/**
 * Stable discriminator for agent-verification targets. Superset of
 * `ApprovalTargetType`: adds `pending_edit` so agents can also verify items
 * that are still in the moderator queue.
 */
export type AgentVerificationTargetType = ApprovalTargetType | 'pending_edit';

export type AgentVerificationVerdict = 'approve' | 'dispute' | 'abstain';

export type Dispute = typeof disputes.$inferSelect;
export type NewDispute = typeof disputes.$inferInsert;
/** Disputes share the agent-verification target taxonomy. */
export type DisputeTargetType = AgentVerificationTargetType;
export type DisputeSource = 'human' | 'agent';
export type DisputeResolution = 'upheld' | 'rejected' | 'withdrawn';

export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type NotificationType =
  | 'dispute_opened'
  | 'dispute_resolved'
  | 'dispute_escalated'
  | 'edit_approved'
  | 'edit_rejected'
  | 'edit_returned'
  | 'comment_reply'
  | 'comment_on_contribution'
  | 'comment_in_thread'
  | 'contribution_endorsed'
  // A T3 panel left a case for a person: it diverged, a panelist asked for a
  // human, or a person's dispute is part of it (0141).
  | 'adjudication_handoff';

export type NotificationAudience = 'author' | 'reviewer';

export type PaperExtractionJob = typeof paperExtractionJobs.$inferSelect;
export type NewPaperExtractionJob = typeof paperExtractionJobs.$inferInsert;

export type PmConcentrationSource = typeof pmConcentrationSources.$inferSelect;
export type NewPmConcentrationSource =
  typeof pmConcentrationSources.$inferInsert;
export type PmConcentrationDistribution =
  typeof pmConcentrationDistributions.$inferSelect;
export type NewPmConcentrationDistribution =
  typeof pmConcentrationDistributions.$inferInsert;

/**
 * The atlas's admission record (spec §18.1).
 *
 * One published dataset, admitted by one named admin. Every reference case and
 * observation reaches the atlas through a cohort, which is what makes
 * invariant 31 auditable — there is no path to atlas data nobody admitted.
 *
 * The identity is the five columns in `pattern_reference_cohorts_identity_idx`,
 * and **every one of them is NOT NULL** because PostgreSQL treats nulls as
 * distinct in a unique index: one nullable member disables the whole
 * constraint. `citationId` is `RESTRICT` rather than `CASCADE` — deleting a
 * citation must not take an admitted cohort with it — and is repointed
 * explicitly by `mergeCitations`, which would otherwise fail on this
 * constraint (§18.1).
 */
export const patternReferenceCohorts = pgTable(
  'pattern_reference_cohorts',
  {
    id: serial('id').primaryKey(),
    citationId: integer('citation_id')
      .references(() => citations.id, { onDelete: 'restrict' })
      .notNull(),
    /** `''` is the whole dataset; a subgroup the paper reports separately gets its own key. */
    subgroupKey: text('subgroup_key').notNull().default(''),
    /**
     * Computed over the canonical serialization of what was admitted, including
     * for a cohort transcribed by hand from an article with no downloadable
     * dataset: a cohort with no bytes behind it cannot be re-verified
     * (invariant 32).
     *
     * Immutable after admission, and enforced by a trigger rather than by this
     * sentence — the importer compares the file in hand against it, so a value
     * any store or maintenance script can rewrite verifies nothing: move the
     * baseline and changed input passes against it. The trigger covers this
     * column, `importerVersion` and `transformationVersion`; `citationId` is
     * deliberately outside it, because the merge path repoints that and a merge
     * is a statement about which handle names the paper.
     */
    sourceDatasetHash: text('source_dataset_hash').notNull(),
    importerVersion: text('importer_version').notNull(),
    transformationVersion: text('transformation_version').notNull(),

    name: text('name').notNull(),
    // controlled_single_dose | controlled_repeated_dose | clinical | DUID |
    // forensic_living | postmortem | other
    cohortType: varchar('cohort_type', { length: 40 }).notNull(),
    design: text('design'),
    evidenceTier: varchar('evidence_tier', { length: 40 }),
    populationNote: text('population_note'),
    analyticalNote: text('analytical_note'),
    /** The zero every relative hour on this cohort's cases is measured from (§7.3). */
    timeOrigin: varchar('time_origin', { length: 40 }).notNull(),
    sourceDatasetUrl: text('source_dataset_url'),
    /** Prose for a human; deliberately not part of the identity comparison. */
    transformationNotes: text('transformation_notes'),
    version: text('version'),

    authorizedBy: integer('authorized_by')
      .references(() => users.id, { onDelete: 'restrict' })
      .notNull(),
    authorizedAt: timestamp('authorized_at').defaultNow().notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('pattern_reference_cohorts_identity_idx').on(
      t.citationId,
      t.sourceDatasetHash,
      t.transformationVersion,
      t.importerVersion,
      t.subgroupKey,
    ),
    index('pattern_reference_cohorts_citation_idx').on(t.citationId),
  ],
);

export type PatternReferenceCohort = typeof patternReferenceCohorts.$inferSelect;
export type NewPatternReferenceCohort = typeof patternReferenceCohorts.$inferInsert;

/**
 * One subject in an admitted cohort (spec §18.2).
 *
 * The chain below the cohort cascades on delete, which is the opposite of the
 * citation key above it: withdrawing an admission takes its data, and an
 * observation outliving the admission it arrived under is the row invariant 31
 * forbids.
 */
export const patternReferenceCases = pgTable(
  'pattern_reference_cases',
  {
    id: serial('id').primaryKey(),
    cohortId: integer('cohort_id')
      .references(() => patternReferenceCohorts.id, { onDelete: 'cascade' })
      .notNull(),
    /** The paper's own key — "case 3", "subject B". Never a patient identifier. */
    sourceSubjectKey: text('source_subject_key').notNull(),
    sex: varchar('sex', { length: 20 }),
    age: numeric('age'),
    /**
     * Overrides the cohort's origin for this case; the effective origin is
     * this where present and the cohort's otherwise (§18.2). A cohort
     * assembled from case reports that genuinely differ needs it, and without
     * it two cases would be compared as if their hour zero meant the same
     * thing.
     */
    timeOrigin: varchar('time_origin', { length: 40 }),
    contextJson: jsonb('context_json'),
    /** Where in the paper this row was read from — invariant 29, NOT NULL. */
    sourceLocator: text('source_locator').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('pattern_reference_cases_cohort_idx').on(t.cohortId),
    // A second import of one dataset under one admission is the same
    // subjects. Counted twice they are a wrong denominator under every
    // percentile the ladder reports.
    uniqueIndex('pattern_reference_cases_subject_idx').on(t.cohortId, t.sourceSubjectKey),
  ],
);

export type PatternReferenceCase = typeof patternReferenceCases.$inferSelect;
export type NewPatternReferenceCase = typeof patternReferenceCases.$inferInsert;

/** What the paper says was taken, with the certainty it says it (spec §18.3). */
export const patternReferenceExposures = pgTable(
  'pattern_reference_exposures',
  {
    id: serial('id').primaryKey(),
    caseId: integer('case_id')
      .references(() => patternReferenceCases.id, { onDelete: 'cascade' })
      .notNull(),
    drugId: integer('drug_id')
      .references(() => drugs.id, { onDelete: 'restrict' })
      .notNull(),
    /** confirmed | reported | suspected */
    certainty: varchar('certainty', { length: 20 }).notNull(),
    amount: numeric('amount'),
    amountUnit: varchar('amount_unit', { length: 40 }),
    route: varchar('route', { length: 40 }),
    /** Against the case's effective origin, never against wall-clock time. */
    timeRelativeHours: numeric('time_relative_hours'),
    timeLowHours: numeric('time_low_hours'),
    timeHighHours: numeric('time_high_hours'),
    regimenJson: jsonb('regimen_json'),
    sourceLocator: text('source_locator').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('pattern_reference_exposures_case_idx').on(t.caseId),
    index('pattern_reference_exposures_drug_idx').on(t.drugId),
  ],
);

export type PatternReferenceExposure = typeof patternReferenceExposures.$inferSelect;
export type NewPatternReferenceExposure = typeof patternReferenceExposures.$inferInsert;

/** What was collected, when, and under what conditions (spec §18.4). */
export const patternReferenceSpecimens = pgTable(
  'pattern_reference_specimens',
  {
    id: serial('id').primaryKey(),
    caseId: integer('case_id')
      .references(() => patternReferenceCases.id, { onDelete: 'cascade' })
      .notNull(),
    matrix: varchar('matrix', { length: 40 }).notNull(),
    collectionRelativeHours: numeric('collection_relative_hours'),
    /** Femoral and heart blood are not interchangeable in a postmortem case. */
    bloodSite: varchar('blood_site', { length: 40 }),
    postmortemIntervalHours: numeric('postmortem_interval_hours'),
    urineCreatinineMmolL: numeric('urine_creatinine_mmol_l'),
    urineSpecificGravity: numeric('urine_specific_gravity'),
    urinePh: numeric('urine_ph'),
    urineVolumeMl: numeric('urine_volume_ml'),
    collectionDurationHours: numeric('collection_duration_hours'),
    metadataJson: jsonb('metadata_json'),
    sourceLocator: text('source_locator').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('pattern_reference_specimens_case_idx').on(t.caseId)],
);

export type PatternReferenceSpecimen = typeof patternReferenceSpecimens.$inferSelect;
export type NewPatternReferenceSpecimen = typeof patternReferenceSpecimens.$inferInsert;

/**
 * Raw published values, never precomputed ratios (spec §18.5).
 *
 * A stored ratio cannot be recomputed when a feature definition improves, and
 * the atlas has to stay recomputable from what the papers reported.
 */
export const patternReferenceObservations = pgTable(
  'pattern_reference_observations',
  {
    id: serial('id').primaryKey(),
    specimenId: integer('specimen_id')
      .references(() => patternReferenceSpecimens.id, { onDelete: 'cascade' })
      .notNull(),
    drugId: integer('drug_id')
      .references(() => drugs.id, { onDelete: 'restrict' })
      .notNull(),
    /**
     * Usually null, and that is the ordinary case: a published reference was
     * not measured by one of this installation's methods, which is why the
     * measurand below is transcribed rather than inherited.
     */
    analyticalMethodId: integer('analytical_method_id').references(() => analyticalMethods.id, {
      onDelete: 'set null',
    }),
    /** Transcribed; 'unknown' where the paper is silent, which downgrades it. */
    measurandMode: varchar('measurand_mode', { length: 40 }).default('unknown').notNull(),
    /** The species defining the paper's mass basis. */
    reportedAsDrugId: integer('reported_as_drug_id').references(() => drugs.id, {
      onDelete: 'restrict',
    }),
    /** Prose; the structured fields above drive matching. */
    hydrolysisNote: text('hydrolysis_note'),
    value: numeric('value'),
    unit: varchar('unit', { length: 40 }),
    /**
     * `PatternObservationQualifier`, and 40 rather than 20 because
     * 'detected_not_quantified' is 23 characters — the ordinary censored state
     * would otherwise fail at import with a length error.
     */
    qualifier: varchar('qualifier', { length: 40 }).notNull(),
    /**
     * The source's own name for its limit (§9.1), not a house vocabulary, and
     * required alongside the value: "LOD", "LOQ" and "cutoff" say different
     * things about what was in the sample, and a number with no name cannot be
     * read back as any of them.
     */
    limitLabel: text('limit_label'),
    limitValue: numeric('limit_value'),
    limitUnit: varchar('limit_unit', { length: 40 }),
    lowerLimitLabel: text('lower_limit_label'),
    lowerLimitValue: numeric('lower_limit_value'),
    lowerLimitUnit: varchar('lower_limit_unit', { length: 40 }),
    uncertaintyCv: numeric('uncertainty_cv'),
    sourceLocator: text('source_locator').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('pattern_reference_observations_specimen_idx').on(t.specimenId),
    index('pattern_reference_observations_drug_idx').on(t.drugId),
    // A method and *this* analyte. Two separate keys say only that both rows
    // exist, so an observation could name a method that does not measure the
    // substance and inherit its limits and uncertainty anyway.
    foreignKey({
      columns: [t.analyticalMethodId, t.drugId],
      foreignColumns: [analyticalMethodComponents.methodId, analyticalMethodComponents.drugId],
      name: 'pattern_reference_observations_method_component',
    }),
  ],
);

export type PatternReferenceObservation = typeof patternReferenceObservations.$inferSelect;
export type NewPatternReferenceObservation = typeof patternReferenceObservations.$inferInsert;

/**
 * Tier C: studies reporting only summary statistics (spec §18.6).
 *
 * Its own table rather than a flag, so the rules keeping this tier out of
 * individual-level claims are structural: no individual percentile can come
 * from a row that is not about an individual, and a query has to name this
 * table or the other rather than pooling them.
 */
export const patternReferenceAggregates = pgTable(
  'pattern_reference_aggregates',
  {
    id: serial('id').primaryKey(),
    cohortId: integer('cohort_id')
      .references(() => patternReferenceCohorts.id, { onDelete: 'cascade' })
      .notNull(),
    drugId: integer('drug_id').references(() => drugs.id, { onDelete: 'restrict' }),
    matrix: varchar('matrix', { length: 40 }),
    /** The same transcribed measurand the individual observations carry. */
    measurandMode: varchar('measurand_mode', { length: 40 }).default('unknown').notNull(),
    reportedAsDrugId: integer('reported_as_drug_id').references(() => drugs.id, {
      onDelete: 'restrict',
    }),
    hydrolysisNote: text('hydrolysis_note'),
    /** concentration | feature */
    statisticOf: varchar('statistic_of', { length: 20 }).notNull(),
    /**
     * Admissible only where the study reported that feature's statistics.
     * Deriving one by dividing two concentration aggregates is a ratio of
     * published means, which is not a mean of individual ratios (invariant 17).
     */
    featureId: text('feature_id'),
    featureVersion: text('feature_version'),
    n: integer('n'),
    /** What the study itself reports below its limit (§21.1). */
    nCensored: integer('n_censored'),
    mean: numeric('mean'),
    sd: numeric('sd'),
    median: numeric('median'),
    p25: numeric('p25'),
    p75: numeric('p75'),
    min: numeric('min'),
    max: numeric('max'),
    geometricMean: numeric('geometric_mean'),
    unit: varchar('unit', { length: 40 }),
    limitLabel: text('limit_label'),
    limitValue: numeric('limit_value'),
    limitUnit: varchar('limit_unit', { length: 40 }),
    populationNote: text('population_note'),
    sourceLocator: text('source_locator').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('pattern_reference_aggregates_cohort_idx').on(t.cohortId)],
);

export type PatternReferenceAggregate = typeof patternReferenceAggregates.$inferSelect;
export type NewPatternReferenceAggregate = typeof patternReferenceAggregates.$inferInsert;

// ─── Generic knowledge governance (kg_*) ─────────────────────────────────────
//
// The definitions live in `./governance-schema.ts` and are re-exported here so
// every existing importer of `db/schema.ts` is unaffected. The split exists so
// the governance store can import its tables without importing Kinetix's —
// §14's rule for the `postgres` package. The dependency runs one way: nothing
// in that module knows this one exists.
export * from './governance-schema.js';
