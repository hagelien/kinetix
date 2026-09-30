/**
 * Intrinsic Postmortem Redistribution Liability Score (iPMR-LS v1.1).
 *
 * A derived, read-only comparative liability index — NOT a stored or
 * editable drug parameter. It estimates how intrinsically prone a drug is
 * to postmortem redistribution (PMR) from commonly available
 * physicochemical/PK properties. It is a comparative index only and must
 * never be used to back-calculate an antemortem concentration from a
 * measured postmortem concentration.
 *
 * The formula is ported verbatim from the iPMR-LS v1.1 specification
 * (docs/ipmr-ls.md). The drug→input mapping in `deriveDrugIpmr` reads the
 * distinct `logP` and `logD` chemistry parameters directly.
 *
 * `pKaBasic` is derived from the structured ionization profile: specifically
 * the pKa of the `+1 → 0` equilibrium (BH⁺ ⇌ B + H⁺), which is the only
 * transition the basicity term is about. A drug with an acidic-only profile
 * therefore contributes B = 0 because it has no such transition, rather than by
 * the old heuristic of relying on acidic pKa values being numerically low.
 * When a drug has no ionization constants at all, the mapping falls back to the
 * legacy scalar `pKa` treated as the basic pKa — a conservative bridge kept
 * only until the ionization profile is populated (see the migration plan in the
 * structured-ionization-constants issue).
 *
 * logD7.4 prefers the measured `logD` parameter. When that is absent but logP
 * and an adequate ionization profile are available, a logD7.4 is derived
 * transiently (never stored) from logP + the neutral fraction at pH 7.4; only
 * if neither is available does it fall back to logP (the spec's fallback).
 */
import type { NumericRange } from '@/types';
import { rangeRepresentative } from '@/lib/rangeUtils';
import {
  deriveBasicPKa,
  deriveLogD,
  type IonizationConstant,
} from '@/lib/ionizationConstants';

/**
 * Slug of the iPMR wiki article. The derived iPMR row in the drug parameter
 * box links here so a reader can jump straight to the concept explanation.
 * Wiki pages live in the database, so this constant is the single source of
 * truth for the link target — change it here if the article is re-slugged.
 */
export const IPMR_WIKI_SLUG = 'ipmr';

export type IpmrBand = 'low' | 'lowModerate' | 'moderate' | 'high' | 'veryHigh';

export interface IpmrInputs {
  /** Apparent volume of distribution, L/kg. Required, must be > 0. */
  vd: number;
  /** Neutral-species octanol/water partition coefficient (logP). Required. */
  logP: number;
  /** Basic pKa (pKa of BH+). `null` → no relevant basic centre. */
  pKaBasic: number | null;
  /** Distribution coefficient at pH 7.4. `null` → falls back to logP. */
  logD74: number | null;
  /** Plasma unbound fraction, 0–1. `null` → neutral imputation of 0.5. */
  fu: number | null;
}

export interface IpmrResult {
  /** Integer score, 0–100. */
  score: number;
  band: IpmrBand;
  inputs: IpmrInputs;
  /**
   * True when `inputs.logD74` was calculated from logP + the ionization
   * profile rather than read from a measured `logD` parameter. Surfaced so a
   * consumer can label the value as derived; a derived logD is never presented
   * as experimental evidence.
   */
  logD74Derived?: boolean;
}

function clip01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Compute the iPMR-LS v1.1 score from explicit inputs. Returns `null` when
 * the two required inputs (Vd > 0 and a finite logP) are missing, mirroring
 * the reference implementation's preconditions.
 */
export function computeIpmrLs(inputs: IpmrInputs): number | null {
  const { vd, logP } = inputs;
  if (!Number.isFinite(vd) || vd <= 0) return null;
  if (!Number.isFinite(logP)) return null;

  const logD74 =
    inputs.logD74 != null && Number.isFinite(inputs.logD74)
      ? inputs.logD74
      : logP;
  const fu =
    inputs.fu != null && Number.isFinite(inputs.fu) ? inputs.fu : 0.5;

  const V = sigmoid(1.6 * Math.log(vd / 3));
  const B =
    inputs.pKaBasic == null || !Number.isFinite(inputs.pKaBasic)
      ? 0
      : sigmoid(1.2 * (inputs.pKaBasic - 8.0));
  const L_N = clip01((logP - 0.5) / 3.0);
  const L_D = clip01((logD74 - 0.5) / 3.0);
  const U = Math.sqrt(clip01(fu));
  const T = Math.cbrt(V * L_N * (0.25 + 0.75 * B));

  const score =
    100 *
    (0.45 * V + 0.2 * B + 0.1 * L_N + 0.05 * L_D + 0.05 * U + 0.15 * T);

  return Math.round(score);
}

/** Map an integer score to its interpretation band. */
export function ipmrBand(score: number): IpmrBand {
  if (score <= 20) return 'low';
  if (score <= 40) return 'lowModerate';
  if (score <= 60) return 'moderate';
  if (score <= 80) return 'high';
  return 'veryHigh';
}

/**
 * Drug shape `deriveDrugIpmr` reads. Values are the merged
 * `drug.<parameter>` NumericRanges produced by the API serializer.
 */
type IpmrDrugSource = {
  volumeOfDistribution?: NumericRange | number | null;
  logP?: NumericRange | number | null;
  logD?: NumericRange | number | null;
  pKa?: NumericRange | number | null;
  proteinBinding?: NumericRange | number | null;
  /** Structured ionization profile; supersedes the legacy scalar `pKa`. */
  ionizationConstants?: IonizationConstant[] | null;
};

function representative(
  value: NumericRange | number | null | undefined,
): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return rangeRepresentative(value);
}

/**
 * Derive the iPMR-LS for a drug from its stored parameters, or `null` when
 * the required inputs (volume of distribution and logP/logD) are not set.
 */
export function deriveDrugIpmr(
  drug: IpmrDrugSource | null | undefined,
): IpmrResult | null {
  if (!drug) return null;

  const vd = representative(drug.volumeOfDistribution);
  const logP = representative(drug.logP);
  if (vd == null || vd <= 0 || logP == null) return null;

  const constants = drug.ionizationConstants ?? null;
  // Basic centre = the +1 → 0 transition. With a structured profile, an
  // acidic-only or neutral compound correctly yields null (no basic centre);
  // only a drug lacking any ionization data falls back to the legacy scalar.
  const pKaBasic =
    constants && constants.length > 0
      ? deriveBasicPKa(constants)
      : representative(drug.pKa);

  // Prefer measured logD; else derive it transiently from logP + the profile.
  const measuredLogD = representative(drug.logD);
  let logD74 = measuredLogD;
  let logD74Derived = false;
  if (measuredLogD == null) {
    const derived = deriveLogD(logP, constants, 7.4);
    if (derived) {
      logD74 = derived.value;
      logD74Derived = true;
    }
  }

  const proteinBound = representative(drug.proteinBinding);
  // Stored protein binding is the bound fraction; iPMR needs the unbound
  // fraction fu = 1 − bound.
  const fu = proteinBound == null ? null : clip01(1 - proteinBound);

  const inputs: IpmrInputs = {
    vd,
    logP,
    pKaBasic,
    logD74,
    fu,
  };

  const score = computeIpmrLs(inputs);
  if (score == null) return null;

  return {
    score,
    band: ipmrBand(score),
    inputs,
    ...(logD74Derived ? { logD74Derived: true } : {}),
  };
}
