/**
 * i18n label keys for the kinetics-core administration routes (`ROUTE_IDS`).
 *
 * The route vocabulary is owned by kinetics-core (`RouteId`); this maps each id to its translation
 * key under `parameters.route.*`, exactly as `REFERENCE_MATRIX_LABEL_KEYS` does for matrices. A route
 * `<select>` renders `t(ROUTE_LABEL_KEYS[id])`. Kept in step with `ROUTE_IDS` by the type: a new route
 * id fails to compile until it is given a label here (and a translation in en/nb).
 */
import { ROUTE_IDS, type RouteId } from '@/lib/kinetics-core';

export const ROUTE_LABEL_KEYS: Record<RouteId, string> = {
  oral: 'parameters.route.oral',
  intranasal: 'parameters.route.intranasal',
  iv: 'parameters.route.iv',
  im: 'parameters.route.im',
  sublingual: 'parameters.route.sublingual',
  rectal: 'parameters.route.rectal',
  inhalation: 'parameters.route.inhalation',
  other: 'parameters.route.other',
};

/** The route ids in display order (the kinetics-core order). */
export const ROUTE_OPTIONS: readonly RouteId[] = ROUTE_IDS;
