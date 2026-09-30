/**
 * Cocaine legacy → v2 migration benchmark (plan B1; harmonization plan §305,
 * §459-468: every result-changing change ships before/after benchmark output).
 *
 *   npx tsx scripts/kinetics-cocaine-benchmark.ts
 *
 * The reviewed cocaine model (`cocaine-one-comp-v2`, registry 0.9.0) is a
 * DELIBERATE curve change from Redose's legacy parameters, not a numerical mirror.
 * This script quantifies the combined effect (Cmax, Tmax, C at reference times)
 * per route for a healthy reference subject, so the parameter change can be
 * reviewed with numbers rather than by inspection.
 *
 * For the ABSORPTION routes (intranasal, smoked, oral) both curves use the SAME
 * kinetics-core one-compartment Bateman equation + Vd scaling, so those deltas
 * isolate the parameter change (legacy vs reviewed). The IV row is the exception:
 * legacy modelled IV as fast one-compartment absorption, whereas v2 uses a true
 * bolus (`C(0)=dose/Vd`), so its delta combines a MODEL-FAMILY change with the
 * Vd/t½ changes and is labelled as such below. `scaling.ts` reproduces Redose's
 * legacy lean-body-mass scaling verbatim.
 *
 * Legacy params: Redose `lib/substances/cocaine.ts` (Vd 2.0 L/kg, lean-body-mass
 * scaling, elimination t½ 60 min). Reviewed params: `registry.ts` COCAINE.
 *
 * Prints a Markdown report to stdout (embedded in
 * docs/kinetics-core/cocaine-migration-report.md).
 */
import {
  concentrationOralFirstOrder,
  concentrationFromDoseIV,
  eliminationConstant,
} from '../src/lib/kinetics-core/equations';
import { vdScaleKg } from '../src/lib/kinetics-core/scaling';
import { findModel } from '../src/lib/kinetics-core/registry';
import { centralValue } from '../src/lib/kinetics-core/param';
import type { CanonicalSubject } from '../src/lib/kinetics-core/types';

// Healthy reference subject — the parity anchor (matches the cocaine fixtures,
// plus a reference height for the legacy lean-body-mass scaling).
const SUBJECT: CanonicalSubject = { weightKg: 75, heightCm: 178, age: 28, sex: 'male' };

const LN2 = Math.LN2;

interface OneCompParams {
  F: number;
  kaPerHour: number; // absorption rate (0 / n.a. for a true IV bolus)
  kePerHour: number;
  vdLiters: number;
  bolus?: boolean; // true → IV bolus C(0)=dose/Vd (no absorption phase)
}

/** Legacy Redose cocaine (Vd 2.0 L/kg, lean-body-mass, elimination t½ 60 min). */
function legacy(route: 'intranasal' | 'smoked' | 'oral' | 'iv'): OneCompParams {
  const vd = 2.0 * vdScaleKg(SUBJECT, 'lean-body-mass');
  const ke = eliminationConstant(60 / 60);
  const abs = { intranasal: 10, smoked: 1, oral: 30, iv: 0.5 }[route];
  const F = { intranasal: 0.3, smoked: 0.7, oral: 0.35, iv: 1.0 }[route];
  // Legacy models every route (incl. IV) as fast-absorption one-compartment.
  return { F, kaPerHour: LN2 / (abs / 60), kePerHour: ke, vdLiters: vd };
}

/**
 * Reviewed v2 cocaine — resolved from the REGISTRY (`cocaine-one-comp-v2`), not
 * duplicated here, so this benchmark always reflects the current central
 * parameters and cannot silently keep printing stale numbers after a registry
 * correction. Only the legacy baseline is frozen in this script (retired external
 * data with no live source), avoiding a second copy of the reviewed drug data.
 */
// Resolved through a helper rather than a bare `findModel` + throw: `v2` below
// is a hoisted function declaration, so TypeScript will not carry an outer
// narrowing into it. Returning a non-optional type settles it at the binding.
function requireModel(id: string): NonNullable<ReturnType<typeof findModel>> {
  const model = findModel(id);
  if (!model) throw new Error(`${id} model not found in registry`);
  return model;
}

const V2_MODEL = requireModel('cocaine');

function v2(route: 'intranasal' | 'inhalation' | 'oral' | 'iv'): OneCompParams {
  const p = V2_MODEL.routes[route];
  if (!p) throw new Error(`registry cocaine model has no route "${route}"`);
  if (p.family === 'iv-one-compartment') {
    const scaling = p.vdScaling ?? 'total-weight';
    // v2 IV is a TRUE bolus (C(0)=dose/Vd) — a DIFFERENT model family from the
    // legacy fast-absorption one-compartment IV. The IV row therefore combines a
    // model-family change with the Vd/t½ changes; it is NOT a pure parameter delta.
    return {
      F: 1,
      kaPerHour: 0,
      kePerHour: eliminationConstant(centralValue(p.eliminationHalfLifeHours)),
      vdLiters: centralValue(p.vdLitersPerKg) * vdScaleKg(SUBJECT, scaling),
      bolus: true,
    };
  }
  if (p.family === 'one-compartment-first-order') {
    const scaling = p.vdScaling ?? 'total-weight';
    return {
      F: centralValue(p.bioavailability),
      kaPerHour: centralValue(p.kaPerHour),
      kePerHour: eliminationConstant(centralValue(p.eliminationHalfLifeHours)),
      vdLiters: centralValue(p.vdLitersPerKg) * vdScaleKg(SUBJECT, scaling),
    };
  }
  throw new Error(`unexpected family "${p.family}" for cocaine route "${route}"`);
}

function conc(p: OneCompParams, doseMg: number, tHours: number): number {
  if (p.bolus) return concentrationFromDoseIV(doseMg, p.vdLiters, p.kePerHour, tHours);
  return concentrationOralFirstOrder(doseMg, p.vdLiters, p.F, p.kaPerHour, p.kePerHour, tHours);
}

/** Cmax / Tmax by a fine 0.5-min scan over 6 h (same resolution as the engine). */
function peak(p: OneCompParams, doseMg: number): { cmax: number; tmaxH: number } {
  let cmax = 0;
  let tmaxH = 0;
  const stepH = 0.5 / 60;
  for (let t = 0; t <= 6 + 1e-9; t += stepH) {
    const c = conc(p, doseMg, t);
    if (c > cmax) {
      cmax = c;
      tmaxH = t;
    }
  }
  return { cmax, tmaxH };
}

const pct = (a: number, b: number): string => {
  if (b === 0) return 'n/a';
  const d = ((a - b) / b) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(0)}%`;
};
const mgL = (x: number) => x.toFixed(4);
const minutes = (h: number) => `${(h * 60).toFixed(1)} min`;

const ROUTES: Array<{
  label: string;
  doseMg: number;
  legacy: OneCompParams;
  v2: OneCompParams;
  note: string;
}> = [
  {
    label: 'intranasal',
    doseMg: 40,
    legacy: legacy('intranasal'),
    v2: v2('intranasal'),
    note: 'F 0.30→0.80, Vd 2.0 LBM→2.7 TW, t½ 60→90 min, abs t½ 10→11.7 min',
  },
  {
    label: 'smoked → inhalation',
    doseMg: 40,
    legacy: legacy('smoked'),
    v2: v2('inhalation'),
    note: 'F 0.70→0.57, Vd 2.0 LBM→2.7 TW, t½ 60→90 min, abs t½ 1→1.1 min',
  },
  {
    label: 'oral',
    doseMg: 100,
    legacy: legacy('oral'),
    v2: v2('oral'),
    note: 'F 0.35→0.33, Vd 2.0 LBM→2.7 TW, t½ 60→90 min, abs t½ 30→30 min',
  },
  {
    label: 'iv (model-family change)',
    doseMg: 40,
    legacy: legacy('iv'),
    v2: v2('iv'),
    note: 'MODEL-FAMILY change (legacy fast-absorption one-comp → v2 TRUE bolus) PLUS Vd 2.0 LBM→2.7 TW, t½ 60→90 min — not a pure parameter delta',
  },
];

const lines: string[] = [];
lines.push('| Route | Dose | Cmax legacy | Cmax v2 | ΔCmax | Tmax legacy | Tmax v2 | C@1h legacy | C@1h v2 | ΔC@1h |');
lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of ROUTES) {
  const pl = peak(r.legacy, r.doseMg);
  const pv = peak(r.v2, r.doseMg);
  const l1 = conc(r.legacy, r.doseMg, 1);
  const v1 = conc(r.v2, r.doseMg, 1);
  lines.push(
    `| ${r.label} | ${r.doseMg} mg | ${mgL(pl.cmax)} | ${mgL(pv.cmax)} | ${pct(pv.cmax, pl.cmax)} | ` +
      `${minutes(pl.tmaxH)} | ${minutes(pv.tmaxH)} | ${mgL(l1)} | ${mgL(v1)} | ${pct(v1, l1)} |`,
  );
}

// eslint-disable-next-line no-console
console.log(
  `Reference subject: ${SUBJECT.weightKg} kg, ${SUBJECT.heightCm} cm, ${SUBJECT.age} y, ${SUBJECT.sex}. ` +
    `Concentrations in mg/L.\n`,
);
// eslint-disable-next-line no-console
console.log(lines.join('\n'));
// eslint-disable-next-line no-console
console.log('\nPer-route parameter deltas:');
for (const r of ROUTES) {
  // eslint-disable-next-line no-console
  console.log(`- ${r.label}: ${r.note}`);
}
