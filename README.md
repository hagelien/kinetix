# Kinetix

Kinetix is a browser-based pharmacokinetic/pharmacodynamic (PK/PD) calculator, forensic-toxicology drug reference, and collaborative drug-monograph wiki. It pairs a React 18 SPA with Vercel serverless API routes and a Neon PostgreSQL database.

## Repository layout

```
kinetix/
├── src/           React SPA (primary frontend) — entry: src/main.tsx
├── api/           Vercel serverless functions (see api/AGENTS.md)
├── db/            Drizzle ORM schema
├── drizzle/       SQL migrations (0000 → 0009)
├── data/          Static drug and analytical-method catalog
├── scripts/       Operational and maintenance tooling (seeding, imports, migrations)
├── tools/         Data-enrichment CLI (see tools/enrichment/AGENTS.md)
├── tests/         Vitest unit + parity tests
├── e2e/           Playwright end-to-end tests
└── public/        Static assets
```

## What the app does

Kinetix serves three audiences through one SPA: clinicians/researchers doing quick unit conversions and PK lookups, forensic toxicologists running BAC and multi-drug scenarios, and moderators maintaining the drug monograph wiki.

### Pages (routes in [`src/router.tsx`](./src/router.tsx))

| Route                                                                 | Purpose                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/`                                                                   | Drug table — search, sort, filter by analytical method, inline µmol/L ↔ mg/L conversion                                  |
| `/modeling`                                                           | Unified multi-component PK/PD simulator; engine is chosen per component (Monte Carlo, ethanol Widmark, KineLab Bayesian) |
| `/simulator`, `/simulator/ethanol`, `/kinelab`                        | Legacy redirects into `/modeling` with migration bridges for old links                                                   |
| `/wiki`                                                               | Monograph index                                                                                                          |
| `/wiki/new`, `/wiki/:slug`, `/wiki/:slug/edit`, `/wiki/:slug/history` | View / create / edit / diff monographs (edits require auth + moderator approval)                                         |
| `/wiki/drug/:drugId`                                                  | Drug-scoped monograph preview with parameter box + discussion threads                                                    |
| `/review`                                                             | Moderator dashboard for pending parameter + wiki edits                                                                   |
| `/login`                                                              | Magic-link (6-digit OTP) sign-in                                                                                         |
| `/admin`                                                              | Manage users, feature groups, allowed email domains, allowed individual emails                                           |

Global UI: Cmd/Ctrl-K command palette, i18n (Norwegian default, English), dark/light/system theme, persisted user unit preferences.

## Frontend

- **Components** ([`src/components/`](./src/components)) — `RootLayout`, `Header`, `CommandPalette`, `AuthGuard`, `DrugTable`, `DrugSearchDropdown`, `PubChemSearchDropdown`; simulator panels under [`simulator/`](./src/components/simulator) (`DrugPanel`, `AssumptionPanel`, `IntakeTimeline`, `SimulatorGraph`, `ResultsSummary`, `WorkbookBackcalcPanel`); wiki editor + renderer under [`wiki/`](./src/components/wiki) (`WikiEditor`, `WikiRenderer`, `MonographDiscussion`, `ParameterEditForm`, `Bibliography`); review diff views under [`review/`](./src/components/review); Shadcn-style primitives under [`ui/`](./src/components/ui).
- **Pages** ([`src/pages/`](./src/pages)) — lazy-loaded route components (`SimulatorPage`, `WikiPage`, `ReviewPage`, `AdminPage`, …).
- **Zustand stores** ([`src/stores/`](./src/stores)) — `appStore` (prefs: unit, theme, text scale), `authStore` (session + magic-link flow), `drugStore` (catalog + search state), `simulatorStore` (multi-component modeling cases), `kineticsStore`, `widgetStore`.
- **Web workers** ([`src/workers/`](./src/workers)) — `montecarlo.worker.ts` runs Monte Carlo sampling and ODE integration off-thread via Comlink; exposed through `useMonteCarloWorker`.
- **Shared libs** ([`src/lib/`](./src/lib)) — `conversions.ts` (mass ↔ molar pivots through ng/mL + molecular weight), `rangeUtils` (`NumericRange` helpers), storage, etc.
- **Types** ([`src/types/index.ts`](./src/types/index.ts)) — `NumericRange`, `DrugComponent`, `GraphScenario`.

## Backend — Vercel serverless API

All handlers are plain `node:http` functions (no Express). Shared helpers live in [`api/_lib/`](./api/_lib): `auth`, `db`, `response`, `schemas`, `validate`, `rate-limit`, `magic-link`, `email`, `tiptap-utils`, `slug`, `pubmed`, `crossref`. See [`api/AGENTS.md`](./api/AGENTS.md) for route conventions.

| Route                                                                  | Methods                                     | Purpose                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| [`api/auth.ts`](./api/auth.ts)                                         | GET (`?action=me`), POST (`?action=logout`) | Current session + logout                                            |
| [`api/auth-request.ts`](./api/auth-request.ts)                         | POST                                        | Send 6-digit magic-link OTP                                         |
| [`api/auth-verify.ts`](./api/auth-verify.ts)                           | POST                                        | Verify OTP, issue JWT cookie                                        |
| [`api/drugs.ts`](./api/drugs.ts)                                       | GET, POST, PATCH                            | Drug list/search/create/update (incl. `?view=search&q=…` typeahead) |
| [`api/drug-parameter.ts`](./api/drug-parameter.ts)                     | GET, PUT                                    | Read/update a parameter and its metadata; writes a revision         |
| [`api/drug-parameter-history.ts`](./api/drug-parameter-history.ts)     | GET                                         | Per-parameter revision history                                      |
| [`api/drug-indicators.ts`](./api/drug-indicators.ts)                   | GET                                         | Aggregated comment counts + reference IDs per drug                  |
| [`api/drug-discussions.ts`](./api/drug-discussions.ts)                 | GET, POST                                   | Threaded discussion per drug/parameter                              |
| [`api/drug-track.ts`](./api/drug-track.ts)                             | POST                                        | Anonymous view-event tracking (rate-limited by IP hash)             |
| [`api/methods.ts`](./api/methods.ts)                                   | GET, POST, PATCH                            | Analytical lab panels                                               |
| [`api/references.ts`](./api/references.ts)                             | GET, POST                                   | Citation CRUD                                                       |
| [`api/references-resolve.ts`](./api/references-resolve.ts)             | POST                                        | Resolve DOI / PubMed IDs via CrossRef + PubMed                      |
| [`api/reference-concentrations.ts`](./api/reference-concentrations.ts) | GET, POST                                   | Matrix/scenario concentration rows                                  |
| [`api/pending-edits.ts`](./api/pending-edits.ts)                       | GET, POST, PATCH                            | Submit / list / approve-reject-apply edits                          |
| [`api/pubchem-search.ts`](./api/pubchem-search.ts)                     | GET                                         | PubChem name search proxy                                           |
| [`api/admin.ts`](./api/admin.ts)                                       | GET/POST/PATCH/DELETE (`?resource=…`)       | Users, groups, categories, allowed domains + emails                 |
| [`api/wiki/pages.ts`](./api/wiki/pages.ts)                             | GET, POST, PUT, DELETE                      | Wiki page CRUD                                                      |
| [`api/wiki/history.ts`](./api/wiki/history.ts)                         | GET                                         | Wiki page revision history                                          |
| [`api/wiki/search.ts`](./api/wiki/search.ts)                           | GET                                         | Full-text wiki search                                               |
| [`api/simulator/cases.ts`](./api/simulator/cases.ts)                   | GET, POST, PUT, DELETE                      | Saved simulator cases                                               |

### Authentication

Magic-link OTP only (no passwords). A 6-digit code is hashed into `users.magic_link_hash`, rate-limited per IP + email, and verified against a 10-attempt lockout. On success the server issues an HS256 JWT in an HttpOnly `__Host-kinetix-auth` cookie (SameSite=Lax, Secure); old `kinetix-auth` / `fjelltox-auth` cookies are cleared on new login/logout but are no longer accepted for authentication. Sessions expire after `users.session_max_days` (default 30, 60 with "stay logged in"). Roles `authenticated` / `contributor` / `editor` / `admin` are re-read from the DB on every request — never trusted from the JWT payload.

## Database

Drizzle schema: [`db/schema.ts`](./db/schema.ts). Config: [`drizzle.config.ts`](./drizzle.config.ts). Migrations: [`drizzle/0000_…`](./drizzle) onward — the log covers the original wiki + user + drug model, the move from metabolism columns to JSONB range fields, magic-link attempt limits, multi-reference arrays, pg_trgm search indexes, and the migration of therapeutic reference concentrations into normal drug parameters.

### Tables

**Identity and access control**

- **`users`** — account + auth state. `email`, `username` (both unique); `role` (`viewer`/`editor`/`admin`, default `viewer`); magic-link fields (`magic_link_hash`, `magic_link_expires`, `magic_link_failed_attempts`); `session_max_days` (default 30); `last_auth_at`, `email_verified_at`. `password_hash` is a legacy nullable column kept during the migration to magic links.
- **`user_groups`** + **`user_group_members`** — admin-managed feature groups. The seeded `rettstoks` group gates internal analytical method data and method-based drug filtering.
- **`allowed_email_domains`** — domain allowlist (unique `domain`, `added_by → users.id`).
- **`allowed_emails`** — per-email allowlist (unique `email`, `added_by → users.id`).

**Drug catalog**

- **`drugs`** — canonical drug record. `slug` (unique), `pubchem_cid` (unique nullable), `name`, `name_en`, `name_short`, `category`, `molecular_weight` (numeric 10,4). Eight `NumericRange` JSONB fields: `half_life`, `volume_of_distribution`, `bioavailability`, `protein_binding`, `blood_plasma_ratio`, `cmax`, `tmax`, `pka`. `popularity_score`, `search_key` (indexed with a pg_trgm GIN index from migration 0008 to drive typeahead). `source` (nullable, indexed; migration 0045) — provenance flag: `NULL` for native/hand-curated entries, `'farmakologiportalen'` for substances pulled in by the Farmakologiportalen importer (see below). `farmakologiportalen_path` (nullable; migration 0101) — this substance's content path on the portal, e.g. `/content/757/Morfin-3-glukuronid-M3G`, rendered as the monograph's outbound link. Independent of `source`: a hand-curated drug the portal also lists gets a link without being marked as imported. Both path segments are load-bearing — `/content/757` alone answers 200 with a shell page naming no substance — so the whole path is stored rather than the id, and `farmakologiportalenUrl()` refuses any other shape before it reaches an `href`.
- **`analytical_methods`** — lab panels (one row per method). `code` (unique), `name`, `description`.
- **`analytical_method_components`** — junction table (`method_id`, `drug_id`) with composite primary key; both sides cascade on delete.

**Drug parameter history and discussion**

- **`drug_parameter_revisions`** — one row per accepted parameter edit. `drug_id`, `parameter` (e.g. `halfLife`), `old_value` / `new_value` JSONB, `edit_summary`, `reference_id`, `reference_ids[]` (multi-source), `pending_edit_id`, `created_by`. Indexed on `(drug_id, parameter, created_at)`.
- **`drug_parameter_discussions`** — threaded comments on a drug or a specific parameter. `parent_id` enables nesting.
- **`drug_interactions`** — anonymous view/event tracking for popularity sorting. `event_type`, optional `user_id`, `ip_hash`.

**References**

- **`citations`** — scientific sources. `type` is one of `freetext` / `url` / `pmid` / `doi`; `identifier` + `metadata` JSONB (`{title, authors, journal, year, …}`). Unique on `(type, identifier)`.
- **`drug_parameters`** — reviewed parameter values, including interpretive concentration ranges such as `therapeuticConcentration`. Legacy `reference_concentrations` rows remain readable for compatibility, but new therapeutic concentration curation goes through the normal parameter edit/review flow.
- **`receptor_targets`** — canonical receptor / biological target entries, including subtype or variant rows. Stores symbol, bilingual name, target class, organism, and external IDs.
- **`drug_receptor_targets`** — junction table linking drugs to receptor targets. Relationship-specific pharmacodynamic fields include affinity, potency, efficacy, Ki, IC50, EC50, Emax, selectivity ratio, interaction type, evidence note, and reference IDs.

**Wiki**

- **`wiki_pages`** — monograph content. `slug` (unique), `title`, `content` JSONB (TipTap), `content_html`, `content_plaintext`, `page_type` (default `topic`), `status` (default `published`), `drug_cid` (stores `drugs.id` despite the name — legacy rows may carry a PubChem CID), `parent_id`, `created_by`, `updated_by`. Indexed on `drug_cid`, `page_type`, `status`.
- **`wiki_revisions`** — per-page edit history. `page_id` (cascade), `content` JSONB, `content_html`, `edit_summary`, `pending_edit_id`, `created_by`.
- **`wiki_categories`** + **`wiki_page_categories`** — category taxonomy and junction table.

**Workflow and simulator**

- **`pending_edits`** — moderator queue. `edit_type` + `target_id` identify the subject; `parameter` narrows to a drug field when relevant. `proposed_value` / `proposed_meta` JSONB, optional `reference_id` / `reference_ids[]`, `status` (`pending` / `approved` / `rejected`), `rejection_comment`, `submitted_by`, `reviewed_by`. Indexed on `status`, `(edit_type, target_id)`, `submitted_by`.
- **`simulator_cases`** — saved PK/PD scenarios. `name`, `case_data` JSONB, `created_by`; indexed on `created_by`.

## Static data

- [`data/components.ts`](./data/components.ts) (~1760 lines) — `embeddedComponents: RawComponent[]` with drug name, PubChem CID, molecular weight, `NumericRange` fields, and metabolism metadata. Null fields are omitted to keep entries compact.
- Analytical methods are not shipped as static data; they are maintained in the database and served by `/api/methods` (read by `loadMethods` in `src/data/index.ts`).
- The data loader builds a lowercase `_searchKey` (name + nameEn + category, tab-joined) for each component to back typeahead search.

### Keeping the catalog in sync with the database

`data/components.ts` is a seed source and an offline fallback, not a live view.
`npm run seed:drugs` pushes it *into* the database; every other write path (the
`/review` queue, `parameter_entries` aggregation, the deep-research importer,
the scheduled maintainer agents) writes only to the database. Without a
deliberate refresh the fixture drifts — which matters because `src/data/index.ts`
serves it when `GET /api/drugs` is unreachable, and the kinetics-core provenance
gate measures the pinned registry against it.

```bash
npm run catalog:check    # report drift between the fixture and the live DB
npm run catalog:export   # refresh data/components.ts from the live DB
```

Both need `DATABASE_URL`. The comparison is semantic (key order, blank notes,
and an empty `metabolism` block are not drift), so hand-written and refreshed
entries coexist. A refresh keeps existing entries in place and appends new
drugs; it does **not** delete fixture entries or field values the database has
none for — pass `--prune` to mirror the database exactly. See
[`docs/catalog-sync.md`](./docs/catalog-sync.md), which also covers the seeder
gap that left 68 entries' interpretive concentration bands out of the database.
The `catalog-drift` workflow runs the check weekly.

## Development

```bash
npm run dev              # Vite dev server on port 3000
npm run build            # tsc + vite build
npm run preview          # Preview the production build

npm run test             # Vitest unit tests
npm run test:e2e         # Playwright
npm run test:parity      # Parity + invariant suites against the ethanol oracle

npm run lint             # ESLint (src/ only)
npm run typecheck        # tsc --noEmit

npm run db:generate      # Generate a new Drizzle migration
npm run db:push          # Push the schema to DATABASE_URL
npm run db:migrate       # Apply migrations (build-time helper)
npm run db:studio        # Drizzle Studio
npm run seed:drugs       # Idempotent upsert of data/components.ts
npm run catalog:check    # Report drift: data/components.ts vs the live catalog
npm run catalog:export   # Refresh data/components.ts from the live catalog

# Import every substance from https://farmakologiportalen.no/substances.
# Dedupes against existing drugs by PubChem CID then name; flags imported rows
# with drugs.source='farmakologiportalen'; writes available PK parameters +
# metabolites without overwriting curated values. Idempotent (re-runnable).
npm run import:farmakologiportalen
npm run import:farmakologiportalen -- --limit 10 --dry-run   # preview a subset
npm run import:farmakologiportalen -- --no-pubchem           # skip CID resolution

# Fill drugs.farmakologiportalen_path — the outbound link each drug monograph
# shows to its counterpart on the portal — from the substance index alone.
# One request, no page fetches and no PubChem lookups, so it is the cheap way
# to (re)fill just the links. Idempotent; also corrects a path the portal moved.
# This is the post-deploy step migration 0101 needs before any link appears;
# CI can run it too (Actions → farmakologiportalen-links). Runbook:
# docs/ops/farmakologiportalen-links.md
npm run backfill:farmakologiportalen-links -- --dry-run      # preview matches
npm run backfill:farmakologiportalen-links
```

Copy [`.env.example`](./.env.example) to `.env` and fill in at least `DATABASE_URL` (Neon Postgres) and `JWT_SECRET` before running any command that touches the DB or auth.

## Further reading

- [`AGENTS.md`](./AGENTS.md) — contributor conventions, anti-patterns, data-shape notes
- [`api/AGENTS.md`](./api/AGENTS.md) — API route conventions
- [`tools/enrichment/AGENTS.md`](./tools/enrichment/AGENTS.md) — data-enrichment CLI
- [`PARITY.md`](./PARITY.md), [`DEPENDENCY_AUDIT.md`](./DEPENDENCY_AUDIT.md), [`docs/`](./docs)
