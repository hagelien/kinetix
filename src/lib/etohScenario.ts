import { z } from 'zod';
import type { EtohParityInput } from './etohWorkbookFlows';
import type { EthanolIntake, EthanolPersonParams } from './ethanolEngine';

// The scenario schema is the wire-format used by:
//   - the URL hash (`#scenario=<base64>`) so a shareable link reproduces state
//   - the clipboard JSON import/export
// It is versioned so a future breaking change can migrate forward.

const SCENARIO_VERSION = 1 as const;

const intakeSchema = z.object({
  id: z.string(),
  timeHour: z.number().finite(),
  ethanolGrams: z.number().finite().min(0),
});

const personSchema = z.object({
  weightKg: z.number().finite().min(1),
  biologicalSex: z.enum(['female', 'male']),
  eliminationRateGdlPerHour: z.number().finite().min(0),
  distributionRatioOverride: z.number().finite().optional(),
});

const drinksTuple = z
  .array(z.number().finite().min(0))
  .length(6)
  .transform((arr) => arr as [number, number, number, number, number, number]);

const workbookInputSchema = z.object({
  drinkStopTime: z.number().finite(),
  eventTime: z.number().finite(),
  sampleTime: z.number().finite(),
  detectedPromille: z.number().finite().min(0),
  secondSampleTime: z.number().finite().nullable().optional().default(null),
  secondSamplePromille: z.number().finite().min(0).optional().default(0),
  eliminationMin: z.number().finite().min(0),
  eliminationLikely: z.number().finite().min(0),
  absorptionMinHours: z.number().finite().min(0),
  absorptionLikelyHours: z.number().finite().min(0),
  drinksMl: drinksTuple,
  drinksAbvPercent: drinksTuple,
  firstPassMinPercent: z.number().finite(),
  firstPassLikelyPercent: z.number().finite(),
  weightKg: z.number().finite().min(1),
  widmarkR: z.number().finite().min(0.01),
  sexMale01: z.union([z.literal(0), z.literal(1)]),
  heightCm: z.number().finite().min(1),
  ageYears: z.number().finite().min(0),
});

export const scenarioSchema = z.object({
  v: z.literal(SCENARIO_VERSION),
  referenceTime: z.string(),
  intakes: z.array(intakeSchema),
  person: personSchema,
  workbook: workbookInputSchema,
});

export type Scenario = z.infer<typeof scenarioSchema>;

export interface ScenarioParts {
  referenceTime: string;
  intakes: EthanolIntake[];
  person: EthanolPersonParams;
  workbook: EtohParityInput;
}

export function buildScenario(parts: ScenarioParts): Scenario {
  return {
    v: SCENARIO_VERSION,
    referenceTime: parts.referenceTime,
    intakes: parts.intakes,
    person: parts.person,
    workbook: {
      ...parts.workbook,
      secondSampleTime: parts.workbook.secondSampleTime ?? null,
      secondSamplePromille: parts.workbook.secondSamplePromille ?? 0,
    },
  };
}

export function scenarioToJson(scenario: Scenario): string {
  return JSON.stringify(scenario, null, 2);
}

export function scenarioFromJson(json: string): Scenario {
  const raw = JSON.parse(json) as unknown;
  return scenarioSchema.parse(raw);
}

// URL-hash codec uses base64url so it survives copy/paste in browser bars.
export function scenarioToHash(scenario: Scenario): string {
  const json = JSON.stringify(scenario);
  const b64 = typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(json))) : Buffer.from(json, 'utf-8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function scenarioFromHash(hash: string): Scenario {
  const padded = hash.replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const json = typeof atob === 'function'
    ? decodeURIComponent(escape(atob(padded + padding)))
    : Buffer.from(padded + padding, 'base64').toString('utf-8');
  return scenarioFromJson(json);
}

// Workbook-input defaults that mirror the legacy spreadsheet's reset state.
export const DEFAULT_WORKBOOK_INPUT: EtohParityInput = {
  drinkStopTime: 22 / 24,
  eventTime: 21 / 24,
  sampleTime: 23 / 24,
  detectedPromille: 0,
  secondSampleTime: null,
  secondSamplePromille: 0,
  eliminationMin: 0.1,
  eliminationLikely: 0.15,
  absorptionMinHours: 3,
  absorptionLikelyHours: 1,
  drinksMl: [0, 0, 0, 0, 0, 0],
  drinksAbvPercent: [0, 0, 0, 0, 0, 0],
  firstPassMinPercent: 10,
  firstPassLikelyPercent: 20,
  weightKg: 75,
  widmarkR: 0.7,
  sexMale01: 1,
  heightCm: 180,
  ageYears: 35,
};
