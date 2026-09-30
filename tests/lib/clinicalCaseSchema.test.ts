import { describe, expect, it } from 'vitest';
import { learningUnits } from '../../db/schema.ts';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  CLINICAL_CASE_SAFETY_NOTICE,
  clinicalCaseContentSchema,
  createPendingEditSchema,
} from '../../api/_lib/schemas.ts';

describe('learning_units.kind discriminator', () => {
  it('learning_units has a kind column', () => {
    const cols = getTableConfig(learningUnits).columns.map((c) => c.name);
    expect(cols).toContain('kind');
  });
});

function validCaseContent() {
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
    scenario:
      'En fiktiv pasient presenterer med symptomer som krever resonnering rundt dosering.',
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

describe('clinicalCaseContentSchema', () => {
  it('accepts a well-formed case', () => {
    expect(clinicalCaseContentSchema.safeParse(validCaseContent()).success).toBe(
      true,
    );
  });

  it('rejects a missing safety notice', () => {
    const bad = { ...validCaseContent(), safetyNotice: undefined };
    expect(clinicalCaseContentSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an altered safety notice', () => {
    const bad = {
      ...validCaseContent(),
      safetyNotice: 'Kun til opplæring.',
    };
    expect(clinicalCaseContentSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects fewer than 6 questions', () => {
    const bad = {
      ...validCaseContent(),
      questions: validCaseContent().questions.slice(0, 5),
    };
    expect(clinicalCaseContentSchema.safeParse(bad).success).toBe(false);
  });
});

describe('createPendingEditSchema clinical_case branch', () => {
  const base = {
    editType: 'clinical_case' as const,
    proposedValue: validCaseContent(),
    referenceIds: [12, 34],
    proposedMeta: {
      title: 'En klinisk case om dosering',
      slug: 'klinisk-case-dosering',
      difficulty: 'advanced_lis',
      domains: ['pharmacokinetics'],
      requiresExpertReview: true,
    },
  };

  it('accepts a complete clinical_case edit citing several sources', () => {
    expect(createPendingEditSchema.safeParse(base).success).toBe(true);
  });

  it('rejects a clinical_case with an altered safety notice', () => {
    const bad = {
      ...base,
      proposedValue: { ...validCaseContent(), safetyNotice: 'feil tekst' },
    };
    expect(createPendingEditSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a clinical_case whose meta omits requiresExpertReview', () => {
    const bad = {
      ...base,
      proposedMeta: { ...base.proposedMeta, requiresExpertReview: undefined },
    };
    expect(createPendingEditSchema.safeParse(bad).success).toBe(false);
  });

  // The cite-a-source rule (≥1 referenceId) is enforced at the submit route so
  // it surfaces the clinical_case_missing_source code; the schema itself does
  // not require a citation, so a no-reference case still parses here.
  it('parses (schema-level) even with no anchor citation', () => {
    const { referenceIds, ...noRef } = base;
    void referenceIds;
    expect(createPendingEditSchema.safeParse(noRef).success).toBe(true);
  });
});
