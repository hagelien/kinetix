/**
 * The simulator's administration-route vocabulary and its mapping onto kinetics-core `RouteId`s.
 *
 * The simulator names every core route by its core id except one: the core's `intranasal` is the
 * simulator's `insufflation` (saved cases carry that name, so it stays). Everything else is the
 * core id unchanged, which is what lets the dose-route picker offer exactly the routes a resolved
 * model declares (`modeledSimulatorRoutes` in `forwardCoreAdapter.ts`) instead of a fixed list.
 *
 * Kept free of the registry on purpose: the compute worker's schemas import from here.
 */
import { ROUTE_IDS, type RouteId } from '@/lib/kinetics-core/types';
import type { RouteType } from '@/types/simulator';

/** Core `RouteId` → simulator `RouteType`. A new `RouteId` fails to compile until it is mapped. */
const SIMULATOR_ROUTE: Record<RouteId, RouteType> = {
  oral: 'oral',
  intranasal: 'insufflation',
  iv: 'iv',
  im: 'im',
  subcutaneous: 'subcutaneous',
  sublingual: 'sublingual',
  buccal: 'buccal',
  rectal: 'rectal',
  transdermal: 'transdermal',
  inhalation: 'inhalation',
  other: 'other',
};

/** Simulator `RouteType` → core `RouteId` (the inverse of `SIMULATOR_ROUTE`). */
const CORE_ROUTE: Record<RouteType, RouteId> = {
  oral: 'oral',
  insufflation: 'intranasal',
  iv: 'iv',
  im: 'im',
  subcutaneous: 'subcutaneous',
  sublingual: 'sublingual',
  buccal: 'buccal',
  rectal: 'rectal',
  transdermal: 'transdermal',
  inhalation: 'inhalation',
  other: 'other',
};

/** Every simulator route, in the kinetics-core display order. */
export const SIMULATOR_ROUTES: readonly RouteType[] = ROUTE_IDS.map((id) => SIMULATOR_ROUTE[id]);

/**
 * The routes the simulator offered before it read them off the resolved model. Still the offer for
 * the engines that do not run a kinetics-core model (KineLab, ethanol/Widmark) and for a drug with no
 * resolved model, so those keep the picker they had.
 */
export const LEGACY_SIMULATOR_ROUTES: readonly RouteType[] = [
  'iv',
  'oral',
  'insufflation',
  'inhalation',
  'other',
];

/** The core `RouteId` a simulator route runs under. */
export function coreRouteFor(route: RouteType): RouteId {
  return CORE_ROUTE[route];
}

/** The simulator route a core `RouteId` is offered as. */
export function simulatorRouteFor(route: RouteId): RouteType {
  return SIMULATOR_ROUTE[route];
}
