import { describe, expect, it } from 'vitest';
import {
  CLINICAL_CASE_SAFETY_NOTICE,
  clinicalCaseContentSchema,
} from '../../api/_lib/schemas.ts';

function baseCaseContent() {
  const option = (id: string, correct: boolean) => ({
    id,
    text: `alternativ ${id}`,
    isCorrect: correct,
    explanation: `forklaring for ${id} som er minst tjue tegn lang`,
  });
  const question = (n: number) => ({
    stem: `Klinisk resonnement-spørsmål ${n}?`,
    format: 'single_best' as const,
    category: 'reasoned' as const,
    options: [option('a', true), option('b', false), option('c', false)],
    difficulty: 'advanced_lis' as const,
    concepts: ['drug_clearance'],
    sourceSupport: 'Retningslinje, avsnitt 3.',
    cognitiveSkill: 'clinical_reasoning' as const,
  });
  return {
    safetyNotice: CLINICAL_CASE_SAFETY_NOTICE,
    scenario: 'En fiktiv pasient med behov for resonnering rundt dosering.',
    prerequisites: [
      {
        concept: 'drug_clearance',
        level: 'essential' as const,
        why: 'Trengs for å vurdere eksponering.',
      },
    ],
    objectives: ['Anvende retningslinjen på et realistisk scenario.'],
    questions: Array.from({ length: 6 }, (_unused, i) => question(i + 1)),
  };
}

describe('clinicalCaseContentSchema crossLinks', () => {
  it('defaults crossLinks to [] when omitted', () => {
    const parsed = clinicalCaseContentSchema.safeParse(baseCaseContent());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.crossLinks).toEqual([]);
  });

  it('accepts cross-links with a label, optional slug and kind', () => {
    const content = {
      ...baseCaseContent(),
      crossLinks: [
        { label: 'Warfarin', slug: 'warfarin', kind: 'drug' },
        { label: 'CYP2C9' },
      ],
    };
    const parsed = clinicalCaseContentSchema.safeParse(content);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.crossLinks).toHaveLength(2);
      expect(parsed.data.crossLinks[0]).toMatchObject({
        label: 'Warfarin',
        slug: 'warfarin',
        kind: 'drug',
      });
    }
  });

  it('rejects a cross-link with an empty label', () => {
    const content = {
      ...baseCaseContent(),
      crossLinks: [{ label: '' }],
    };
    expect(clinicalCaseContentSchema.safeParse(content).success).toBe(false);
  });
});
