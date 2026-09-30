import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBOOK_INPUT,
  buildScenario,
  scenarioFromHash,
  scenarioFromJson,
  scenarioToHash,
  scenarioToJson,
} from './etohScenario';

const parts = {
  referenceTime: '22:00',
  intakes: [{ id: 'a', timeHour: 0, ethanolGrams: 14 }],
  person: {
    weightKg: 75,
    biologicalSex: 'male' as const,
    eliminationRateGdlPerHour: 0.015,
  },
  workbook: { ...DEFAULT_WORKBOOK_INPUT, detectedPromille: 1.12 },
};

describe('etohScenario', () => {
  it('round-trips through JSON', () => {
    const s = buildScenario(parts);
    const json = scenarioToJson(s);
    const back = scenarioFromJson(json);
    expect(back).toEqual(s);
  });

  it('round-trips through base64url hash', () => {
    const s = buildScenario(parts);
    const hash = scenarioToHash(s);
    expect(hash).not.toMatch(/[+/=]/); // base64url, stripped padding
    const back = scenarioFromHash(hash);
    expect(back).toEqual(s);
  });

  it('rejects invalid JSON', () => {
    expect(() => scenarioFromJson('{"not":"a scenario"}')).toThrow();
  });

  it('rejects scenarios with non-finite numbers', () => {
    const bad = JSON.stringify({ ...buildScenario(parts), workbook: { ...parts.workbook, weightKg: Number.NaN } });
    expect(() => scenarioFromJson(bad)).toThrow();
  });

  it('defaults missing v3 second-sample fields for older scenarios', () => {
    const legacy = buildScenario(parts);
    const { secondSampleTime: _time, secondSamplePromille: _promille, ...workbook } = legacy.workbook;
    void _time;
    void _promille;
    const back = scenarioFromJson(JSON.stringify({ ...legacy, workbook }));
    expect(back.workbook.secondSampleTime).toBeNull();
    expect(back.workbook.secondSamplePromille).toBe(0);
  });
});
