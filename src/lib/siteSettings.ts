/**
 * Site settings — the handful of runtime policy switches an admin can flip
 * from Admin → Settings.
 *
 * This is deliberately NOT the capability matrix (`src/lib/permissions.ts`).
 * That answers "who may do this"; these answer "is this rule in force at all",
 * for policies that are neither per-user nor per-tier. The registry below is
 * the single source of truth: it names every switch and carries the value the
 * code ships with, so a stock install stores no rows and behaves exactly as it
 * did before the switch existed.
 *
 * Stored rows are only ever *deviations* from these defaults, and an id this
 * release no longer knows is ignored at read time rather than migrated away.
 * The registry is compiled into both bundles; only the stored values travel
 * over the wire (`GET /api/admin?resource=settings`).
 */

/** Where a setting is surfaced in the admin UI. */
export const SITE_SETTING_GROUPS = ['review'] as const;

export type SiteSettingGroup = (typeof SITE_SETTING_GROUPS)[number];

export interface SiteSettingDef {
  /** Stable id; persisted in `site_settings.key`. */
  readonly id: string;
  readonly group: SiteSettingGroup;
  /** Value when nothing is stored — today's shipped behaviour. */
  readonly defaultValue: boolean;
  /**
   * Where the setting is enforced. Language-neutral technical hint rendered
   * as code chips in the admin UI, mirroring `CapabilityDef.enforcedAt`.
   */
  readonly enforcedAt: readonly string[];
}

export const SITE_SETTING_LIST = [
  {
    // The read-in-full reference gate, as applied to AGENT submissions
    // (`assertReferencesJudgedForActor`). ON (the default, and the behaviour
    // that shipped) means a fact, parameter or parameter entry an agent submits
    // is rejected when it cites a resolvable source with no read-in-full paper
    // review. OFF lets those writes through — the citation is still recorded
    // and still surfaces in the follow-up review queue
    // (`findCitationsNeedingFullReview`), it just no longer blocks.
    //
    // Deliberately does NOT reach the `learning_unit` path, which gates humans
    // too: there the reviewed source is the unit's substance, not an agent
    // discipline, so it stays unconditional.
    id: 'referenceGate.blockUnreviewedCitations',
    group: 'review',
    defaultValue: true,
    enforcedAt: [
      'POST /api/pending-edits',
      'POST /api/parameter-entries',
      'POST /api/drug-parameter',
      'POST /api/reference-concentrations',
    ],
  },
] as const satisfies readonly SiteSettingDef[];

export type SiteSettingId = (typeof SITE_SETTING_LIST)[number]['id'];

const SETTING_BY_ID = new Map<string, SiteSettingDef>(
  SITE_SETTING_LIST.map((s) => [s.id, s]),
);

/** Setting ids as a typed object, so call sites get autocomplete. */
export const SETTING = Object.fromEntries(
  SITE_SETTING_LIST.map((s) => [s.id, s.id]),
) as Record<SiteSettingId, SiteSettingId>;

export function isSiteSettingId(value: unknown): value is SiteSettingId {
  return typeof value === 'string' && SETTING_BY_ID.has(value);
}

export function getSiteSetting(id: string): SiteSettingDef | undefined {
  return SETTING_BY_ID.get(id);
}

/** Every switch's effective value: id → boolean. */
export type SiteSettings = Readonly<Record<SiteSettingId, boolean>>;

/** The shipped behaviour — what an empty `site_settings` table means. */
export const SITE_SETTING_DEFAULTS: SiteSettings = Object.freeze(
  Object.fromEntries(SITE_SETTING_LIST.map((s) => [s.id, s.defaultValue])),
) as SiteSettings;

/**
 * Fold stored rows onto the defaults.
 *
 * Anything the registry does not recognise is dropped: an id a later release
 * removed, or a value that is not a boolean (the column is `jsonb`, so a
 * hand-edited row can hold anything). The result therefore always has exactly
 * the registry's keys, and a caller never has to defend against a missing one.
 */
export function sanitizeSiteSettings(
  raw: Readonly<Record<string, unknown>>,
): SiteSettings {
  const merged: Record<string, boolean> = { ...SITE_SETTING_DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    if (!isSiteSettingId(key)) continue;
    if (typeof value !== 'boolean') continue;
    merged[key] = value;
  }
  return Object.freeze(merged) as SiteSettings;
}
