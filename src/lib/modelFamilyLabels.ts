/**
 * Display identity for the model family that ACTUALLY produced a curve.
 *
 * Before this module the modeling pipeline stamped every core result
 * `one-compartment, first-order elimination`, so a two-compartment (THC) or
 * Michaelis-Menten (ethanol, GHB, MDMA) run was reported to the user as a
 * family it is not. The engine has always known better — `modelSummary.routes[]`
 * carries the resolved family — so the fix is to read it rather than to assume.
 *
 * Keys live under `assumptions.models.*` so the existing assumptions panel
 * renders them with no structural change.
 */
import type { ModelFamily } from '@/lib/kinetics-core';

export const MODEL_FAMILY_LABEL_KEYS: Record<ModelFamily, string> = {
  'one-compartment-first-order': 'assumptions.models.oneCompartmentFirstOrder',
  'one-compartment-clv': 'assumptions.models.oneCompartmentClv',
  'iv-one-compartment': 'assumptions.models.ivOneCompartment',
  'one-compartment-zero-order': 'assumptions.models.oneCompartmentZeroOrder',
  'one-compartment-mixed-order': 'assumptions.models.oneCompartmentMixedOrder',
  'two-compartment-first-order': 'assumptions.models.twoCompartmentFirstOrder',
  'michaelis-menten': 'assumptions.models.michaelisMenten',
  'parent-metabolite-first-order': 'assumptions.models.parentMetaboliteFirstOrder',
};

/** English fallback, used where a translation is unavailable (exports, logs). */
export const MODEL_FAMILY_LABELS: Record<ModelFamily, string> = {
  'one-compartment-first-order': 'one-compartment, first-order elimination',
  'one-compartment-clv': 'one-compartment, clearance/volume parameterisation',
  'iv-one-compartment': 'intravenous one-compartment',
  'one-compartment-zero-order': 'one-compartment, zero-order (rate-controlled) input',
  'one-compartment-mixed-order': 'one-compartment, mixed zero-/first-order input',
  'two-compartment-first-order': 'two-compartment, first-order elimination',
  'michaelis-menten': 'Michaelis-Menten (saturable) elimination',
  'parent-metabolite-first-order': 'coupled parent/metabolite, first-order',
};

export function modelFamilyLabelKey(family: ModelFamily): string {
  return MODEL_FAMILY_LABEL_KEYS[family];
}

export function modelFamilyLabel(family: ModelFamily): string {
  return MODEL_FAMILY_LABELS[family];
}
