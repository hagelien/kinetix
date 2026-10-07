/**
 * Ethanol's own display-unit preference.
 *
 * Blood alcohol is read in per mille (‰) in Norway and in percent (% = g/dL)
 * in some other jurisdictions; nobody reads it in µmol/L. So ethanol gets a
 * preferred unit of its own, separate from the #306 unit list that governs every
 * other drug, and it defaults to ‰. The choice is display-only: stored values,
 * the export and every calculation keep their authored units.
 */
import {
  isConcentrationUnit,
  isEthanolDisplayUnit,
  type DisplayConcentrationUnit,
} from './unitConversion.js';
import { ETHANOL_PUBCHEM_CID } from './ethanolSimulator.js';

export const DEFAULT_ETHANOL_UNIT: DisplayConcentrationUnit = '‰';

/**
 * Every unit ethanol may be displayed in: ‰ and % first, then the same
 * concentration units any other drug can be shown in.
 */
export const ETHANOL_UNIT_OPTIONS: readonly DisplayConcentrationUnit[] = [
  '‰',
  '%',
  'mg/L',
  'µg/mL',
  'ng/mL',
  'µg/L',
  'ng/L',
  'mg/dL',
  'µg/dL',
  'ng/dL',
  'mmol/L',
  'µmol/L',
  'nmol/L',
  'mmol/dL',
  'µmol/dL',
  'nmol/dL',
];

export function isEthanolUnitOption(
  unit: unknown,
): unit is DisplayConcentrationUnit {
  return (
    typeof unit === 'string' &&
    (isEthanolDisplayUnit(unit) || isConcentrationUnit(unit))
  );
}

/** Repair a persisted or server-sent value to a valid ethanol unit. */
export function normalizeEthanolUnit(unit: unknown): DisplayConcentrationUnit {
  return isEthanolUnitOption(unit) ? unit : DEFAULT_ETHANOL_UNIT;
}

/** True when a drug row/component is ethanol (PubChem CID 702). */
export function isEthanolDrug(
  drug: { pubchemCid?: number | null } | null | undefined,
): boolean {
  return drug?.pubchemCid === ETHANOL_PUBCHEM_CID;
}

/**
 * The unit list a view of ethanol should use: the ethanol unit as the primary,
 * followed by the reader's other enabled units as the tooltip alternatives.
 */
export function ethanolDisplayUnits(
  enabledUnits: readonly string[],
  ethanolUnit: DisplayConcentrationUnit,
): string[] {
  return [ethanolUnit, ...enabledUnits.filter((u) => u !== ethanolUnit)];
}
