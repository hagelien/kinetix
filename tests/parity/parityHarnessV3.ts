// v3 parity harness — runs the v3 engine against the v3 oracle snapshot.
// Asserts every case matches on every output field the engine produces.
//
// As of Phase D1, the v3 engine output shape is a strict superset of the v1
// shape and includes the workbook's high-tier outputs. The five v3-only
// keys (`backcalcHighPromille`, `afterIntakeMin*`, `afterIntakeBackcalcHigh*`)
// are checked alongside the twelve v1-shape keys.

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_ABSORPTION_HIGH_HOURS,
  DEFAULT_ELIMINATION_HIGH,
  DEFAULT_ELIMINATION_LOW_BAC,
  DEFAULT_FIRST_PASS_HIGH_PERCENT,
  SEX_FEMALE,
  SEX_MALE,
  evaluateEtohWorkbookFlowsV3,
  type EtohV3ParityInput,
  type EtohV3ParityOutput,
  type SexEnum,
} from '../../src/lib/etohWorkbookFlowsV3';
import type { EtohParityInput } from '../../src/lib/etohWorkbookFlows';

const V3_OUTPUT_KEYS: Array<keyof EtohV3ParityOutput> = [
  'backcalcMinPromille',
  'backcalcLikelyPromille',
  'backcalcHighPromille',
  'ethanolGrams',
  'afterIntakeMaxPromille',
  'afterIntakeLikelyPromille',
  'afterIntakeMinPromille',
  'afterIntakeBackcalcMinPromille',
  'afterIntakeBackcalcLikelyPromille',
  'afterIntakeBackcalcHighPromille',
  'wattsonR',
  'afterIntakeMaxPromilleWattson',
  'afterIntakeLikelyPromilleWattson',
  'afterIntakeMinPromilleWattson',
  'afterIntakeBackcalcMinPromilleWattson',
  'afterIntakeBackcalcLikelyPromilleWattson',
  'afterIntakeBackcalcHighPromilleWattson',
];

const DEFAULT_TOLERANCE = { abs: 1e-9, rel: 1e-9 };
const WATTSON_TOLERANCE = { abs: 5e-3, rel: 5e-3 };
const WATTSON_KEYS: ReadonlySet<keyof EtohV3ParityOutput> = new Set([
  'wattsonR',
  'afterIntakeMaxPromilleWattson',
  'afterIntakeLikelyPromilleWattson',
  'afterIntakeMinPromilleWattson',
  'afterIntakeBackcalcMinPromilleWattson',
  'afterIntakeBackcalcLikelyPromilleWattson',
  'afterIntakeBackcalcHighPromilleWattson',
]);

function toleranceFor(key: keyof EtohV3ParityOutput) {
  return WATTSON_KEYS.has(key) ? WATTSON_TOLERANCE : DEFAULT_TOLERANCE;
}

interface SnapshotEntry {
  inputs: EtohParityInput;
  oracle: Record<string, number | null>;
}

interface CaseFailure {
  caseId: string;
  output: keyof EtohV3ParityOutput;
  oracle: number | null;
  sut: number | null;
  absDelta: number;
  relDelta: number;
}

export interface ParityV3Report {
  totalCases: number;
  failingCases: CaseFailure[];
}

function compareNumber(
  oracleValue: number | null | undefined,
  sutValue: number | null | undefined,
  tolerance: { abs: number; rel: number },
): { pass: boolean; absDelta: number; relDelta: number } {
  const oracleResolved = oracleValue ?? null;
  const sutResolved = sutValue ?? null;
  if (oracleResolved === null || sutResolved === null) {
    const pass = oracleResolved === sutResolved;
    return {
      pass,
      absDelta: pass ? 0 : Number.POSITIVE_INFINITY,
      relDelta: pass ? 0 : Number.POSITIVE_INFINITY,
    };
  }
  const absDelta = Math.abs(oracleResolved - sutResolved);
  const relDelta = absDelta / Math.max(1, Math.abs(oracleResolved));
  const pass = absDelta <= tolerance.abs || relDelta <= tolerance.rel;
  return { pass, absDelta, relDelta };
}

type DrinksTuple = [number, number, number, number, number, number];

function mlToDl(volumes: readonly number[] | undefined): DrinksTuple {
  const source = volumes ?? [0, 0, 0, 0, 0, 0];
  return [
    (source[0] ?? 0) / 100,
    (source[1] ?? 0) / 100,
    (source[2] ?? 0) / 100,
    (source[3] ?? 0) / 100,
    (source[4] ?? 0) / 100,
    (source[5] ?? 0) / 100,
  ];
}

function promote(input: EtohParityInput): EtohV3ParityInput {
  // Mirror the Python oracle's _promote_case_inputs: respect any v3-only
  // fields the case carries (eliminationLowBac, eliminationHigh,
  // absorptionHighHours, firstPassHighPercent, sexEnum, drinksDl) and apply
  // defaults only when missing. v1 cases use sexMale01 (0=female, 1=male)
  // and `drinksMl`; v3 uses `sexEnum` (0=unset, 1=male, 2=female) and
  // `drinksDl`. Unit conversion mirrors the Python oracle's
  // `drinks_volume = [v / 100.0 ...]` step.
  const candidate = input as EtohParityInput & {
    eliminationLowBac?: number;
    eliminationHigh?: number;
    absorptionHighHours?: number;
    firstPassHighPercent?: number;
    sexEnum?: SexEnum;
    drinksDl?: readonly number[];
  };
  const sexEnum: SexEnum =
    candidate.sexEnum ?? (input.sexMale01 === 1 ? SEX_MALE : SEX_FEMALE);
  const drinksDl: DrinksTuple = candidate.drinksDl
    ? [
        candidate.drinksDl[0] ?? 0,
        candidate.drinksDl[1] ?? 0,
        candidate.drinksDl[2] ?? 0,
        candidate.drinksDl[3] ?? 0,
        candidate.drinksDl[4] ?? 0,
        candidate.drinksDl[5] ?? 0,
      ]
    : mlToDl(input.drinksMl);
  const { sexMale01: _sex, drinksMl: _ml, ...rest } = input;
  void _sex;
  void _ml;
  return {
    ...rest,
    drinksDl,
    eliminationLowBac: candidate.eliminationLowBac ?? DEFAULT_ELIMINATION_LOW_BAC,
    eliminationHigh: candidate.eliminationHigh ?? DEFAULT_ELIMINATION_HIGH,
    absorptionHighHours: candidate.absorptionHighHours ?? DEFAULT_ABSORPTION_HIGH_HOURS,
    firstPassHighPercent: candidate.firstPassHighPercent ?? DEFAULT_FIRST_PASS_HIGH_PERCENT,
    sexEnum,
  };
}

export function runParityV3(): ParityV3Report {
  const snapshotPath = path.resolve('tests/parity/oracle-snapshots.v3.json');
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(
      `v3 oracle snapshot missing: ${snapshotPath}. Run \`npm run parity:v3:oracle\` to regenerate.`,
    );
  }
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as Record<
    string,
    SnapshotEntry
  >;

  const failingCases: CaseFailure[] = [];

  for (const [caseId, entry] of Object.entries(snapshot)) {
    const sut = evaluateEtohWorkbookFlowsV3(promote(entry.inputs));
    for (const outputKey of V3_OUTPUT_KEYS) {
      const oracleValue = entry.oracle[outputKey] ?? null;
      const compared = compareNumber(oracleValue, sut[outputKey], toleranceFor(outputKey));
      if (!compared.pass) {
        failingCases.push({
          caseId,
          output: outputKey,
          oracle: oracleValue,
          sut: sut[outputKey],
          absDelta: compared.absDelta,
          relDelta: compared.relDelta,
        });
      }
    }
  }

  return {
    totalCases: Object.keys(snapshot).length,
    failingCases,
  };
}
