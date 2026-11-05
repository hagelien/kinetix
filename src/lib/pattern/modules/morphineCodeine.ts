/**
 * An entry panel for morphine, codeine and their intact glucuronides.
 *
 * This module names the measurements the user can enter. It does not turn
 * them into an empirical distribution: no admitted reference cohort or
 * study-derived concentration-time series is supplied here.
 *
 * In particular, a total-after-hydrolysis parent result is not automatically
 * interchangeable with the free parent or an intact conjugate. Leaving the
 * feature list empty avoids asserting that all such measurement protocols
 * yield the same ratio while the full assay vocabulary remains available in
 * the case. Source ambiguity uses the live metabolism graph and the explicit
 * codeine hypothesis; it is never evidence that codeine was administered.
 */
import type { PatternSubstanceModule } from '../substanceModules.js';

export const MORPHINE = { pubchemCid: 5288826, slug: 'morphine' };
export const CODEINE = { pubchemCid: 5284371, slug: 'codeine' };
const M3G = { pubchemCid: 5484731, slug: 'morphine-3-glucuronide' };
const M6G = { pubchemCid: 5360621, slug: 'morphine-6-glucuronide' };
const C6G = { pubchemCid: 5489029, slug: 'codeine-6-glucuronide' };

export const MORPHINE_CODEINE_MODULE: PatternSubstanceModule = {
  id: 'morphine-codeine',
  version: '1.0.0',
  labelKey: 'pattern.profile.module.morphineCodeine',
  assumedParent: CODEINE,
  analytes: [
    {
      analyte: MORPHINE,
      labelKey: 'pattern.profile.analyte.morphine.label',
      shortLabelKey: 'pattern.profile.analyte.morphine.short',
    },
    {
      analyte: CODEINE,
      labelKey: 'pattern.profile.analyte.codeine.label',
      shortLabelKey: 'pattern.profile.analyte.codeine.short',
    },
    {
      analyte: M3G,
      labelKey: 'pattern.profile.analyte.m3g.label',
      shortLabelKey: 'pattern.profile.analyte.m3g.short',
    },
    {
      analyte: M6G,
      labelKey: 'pattern.profile.analyte.m6g.label',
      shortLabelKey: 'pattern.profile.analyte.m6g.short',
    },
    {
      analyte: C6G,
      labelKey: 'pattern.profile.analyte.c6g.label',
      shortLabelKey: 'pattern.profile.analyte.c6g.short',
    },
  ],
  features: [],
  contextFields: [],
  signals: [],
  notEstablished: [],
  enzymeEffects: [],
  artefactRules: [],
};
