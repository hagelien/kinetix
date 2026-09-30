// Phase J1.5 parity harness — runs the v3 forward engine against the
// `Fremoverregning EtOH` oracle snapshot. Asserts every case matches on
// every output field the engine produces.
//
// The case JSON shape stays back-calc-shaped (drinkStopTime, drinks in mL,
// sexMale01). promote() applies the same conflations as the Python oracle's
// `_promote_case_inputs` for this config: drinkStopTime → drinkStartTime,
// sexMale01 → sexEnum, drinksMl → drinksDl (× 1/100).

import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_FORWARD_ELIMINATION_HIGH,
  DEFAULT_FORWARD_ELIMINATION_LIKELY,
  DEFAULT_FORWARD_ELIMINATION_LOW,
  evaluateEtohForwardFlowsV3,
  type EtohForwardInput,
  type EtohForwardOutput,
} from '../../src/lib/etohForwardFlowsV3';
import { SEX_FEMALE, SEX_MALE, type SexEnum } from '../../src/lib/etohWorkbookFlowsV3';
import type { EtohParityInput } from '../../src/lib/etohWorkbookFlows';

const FORWARD_OUTPUT_KEYS: Array<keyof EtohForwardOutput> = [
  'widmarkREffective',
  'wattsonR',
  'ethanolGrams',
  'theoreticalHighPromille',
  'theoreticalLikelyPromille',
  'theoreticalLowPromille',
  'theoreticalHighPromilleWattson',
  'theoreticalLikelyPromilleWattson',
  'theoreticalLowPromilleWattson',
  'forwardHours',
  'forwardHighPromille',
  'forwardLikelyPromille',
  'forwardLowPromille',
  'forwardHighPromilleWattson',
  'forwardLikelyPromilleWattson',
  'forwardLowPromilleWattson',
];

const DEFAULT_TOLERANCE = { abs: 1e-9, rel: 1e-9 };
const WATTSON_TOLERANCE = { abs: 5e-3, rel: 5e-3 };
const WATTSON_KEYS: ReadonlySet<keyof EtohForwardOutput> = new Set([
  'wattsonR',
  'theoreticalHighPromilleWattson',
  'theoreticalLikelyPromilleWattson',
  'theoreticalLowPromilleWattson',
  'forwardHighPromilleWattson',
  'forwardLikelyPromilleWattson',
  'forwardLowPromilleWattson',
]);

function toleranceFor(key: keyof EtohForwardOutput) {
  return WATTSON_KEYS.has(key) ? WATTSON_TOLERANCE : DEFAULT_TOLERANCE;
}

interface SnapshotEntry {
  inputs: EtohParityInput;
  oracle: Record<string, number | null>;
}

interface CaseFailure {
  caseId: string;
  output: keyof EtohForwardOutput;
  oracle: number | null;
  sut: number | null;
  absDelta: number;
  relDelta: number;
}

export interface ParityV3ForwardReport {
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

function promote(input: EtohParityInput): EtohForwardInput {
  // Mirror the Python oracle's `case_aliases` semantics: respect an explicit
  // `drinkStartTime` if the case carries one, fall back to `drinkStopTime`
  // only when it is missing. Same `??`-pattern Codex landed on PRs #236/#244
  // for `eliminationLowBac` / Widmark out-of-table.
  const candidate = input as EtohParityInput & {
    drinkStartTime?: number;
    sexEnum?: SexEnum;
    firstPassHighPercent?: number;
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
  return {
    drinkStartTime: candidate.drinkStartTime ?? input.drinkStopTime,
    eventTime: input.eventTime,
    drinksDl,
    drinksAbvPercent: input.drinksAbvPercent,
    firstPassMinPercent: input.firstPassMinPercent,
    firstPassLikelyPercent: input.firstPassLikelyPercent,
    firstPassHighPercent: candidate.firstPassHighPercent ?? 0,
    weightKg: input.weightKg,
    heightCm: input.heightCm,
    widmarkR: input.widmarkR,
    sexEnum,
    ageYears: input.ageYears,
    forwardEliminationHigh: DEFAULT_FORWARD_ELIMINATION_HIGH,
    forwardEliminationLikely: DEFAULT_FORWARD_ELIMINATION_LIKELY,
    forwardEliminationLow: DEFAULT_FORWARD_ELIMINATION_LOW,
  };
}

export function runParityV3Forward(): ParityV3ForwardReport {
  const snapshotPath = path.resolve('tests/parity/oracle-snapshots.v3.forward.json');
  if (!fs.existsSync(snapshotPath)) {
    throw new Error(
      `v3 forward oracle snapshot missing: ${snapshotPath}. Run ` +
        `\`npm run parity:v3:forward:oracle\` to regenerate.`,
    );
  }
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8')) as Record<
    string,
    SnapshotEntry
  >;

  const failingCases: CaseFailure[] = [];

  for (const [caseId, entry] of Object.entries(snapshot)) {
    const sut = evaluateEtohForwardFlowsV3(promote(entry.inputs));
    for (const outputKey of FORWARD_OUTPUT_KEYS) {
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
