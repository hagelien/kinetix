/**
 * The header nav's optional feature links (#1240) — every item besides the
 * drug table, which is the app's landing page and stays unconditionally
 * visible.
 *
 * This is the single registry both the header and the admin "which links are
 * visible" panel read: the header decides what to render and the admin panel
 * decides what an id means (its label and destination), so the two must never
 * describe the list differently. Framework-free (no React import) so the
 * server can validate an admin's PATCH against the same ids without pulling
 * in the client bundle.
 */

export interface NavItemDef {
  /** Stable id; persisted in `site_settings` under the `nav.hiddenMenuItems` key. */
  readonly id: string;
  readonly to: string;
  /** i18n key for the link's label — reuses the existing `nav.*` namespace. */
  readonly labelKey: string;
}

export const NAV_ITEM_DEFS = [
  { id: 'wiki', to: '/wiki', labelKey: 'nav.wiki' },
  { id: 'references', to: '/references', labelKey: 'nav.references' },
  { id: 'methods', to: '/methods', labelKey: 'nav.methods' },
  { id: 'entities', to: '/entities', labelKey: 'nav.entities' },
  { id: 'detectionTimes', to: '/detection-times', labelKey: 'nav.detection' },
  { id: 'pattern', to: '/modeling/pattern', labelKey: 'nav.pattern' },
] as const satisfies readonly NavItemDef[];

export type NavItemId = (typeof NAV_ITEM_DEFS)[number]['id'];

/** Every hideable id, in the registry's own (display) order. */
export const NAV_ITEM_IDS = NAV_ITEM_DEFS.map(
  (item) => item.id,
) as readonly NavItemId[];

const NAV_ITEM_ID_SET = new Set<string>(NAV_ITEM_IDS);

export function isNavItemId(value: unknown): value is NavItemId {
  return typeof value === 'string' && NAV_ITEM_ID_SET.has(value);
}
