import { describe, expect, it } from 'vitest';
import { learningUnits, learningUnitRevisions } from '../../db/schema.ts';
import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  learningUnitContentSchema,
  createPendingEditSchema,
} from '../../api/_lib/schemas.ts';

describe('learning unit tables', () => {
  it('learning_units has the expected columns', () => {
    const cols = getTableConfig(learningUnits).columns.map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'citation_id', 'slug', 'title', 'content',
        'difficulty', 'domains', 'status', 'created_by', 'updated_by',
        'created_at', 'updated_at',
      ]),
    );
  });

  it('learning_unit_revisions links back to the unit and pending edit', () => {
    const cols = getTableConfig(learningUnitRevisions).columns.map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'id', 'unit_id', 'content', 'edit_summary', 'pending_edit_id',
        'created_by', 'created_at',
      ]),
    );
  });
});

function validUnitContent() {
  const option = (id: string, correct: boolean) => ({
    id,
    text: `alternativ ${id}`,
    isCorrect: correct,
    explanation: `forklaring for ${id} som er minst tjue tegn lang`,
  });
  const question = (n: number) => ({
    stem: `Spørsmål ${n} om kilden?`,
    format: 'single_best' as const,
    category: 'factual' as const,
    options: [option('a', true), option('b', false), option('c', false), option('d', false)],
    difficulty: 'foundational' as const,
    concepts: ['drug_clearance'],
    sourceSupport: 'Avsnitt 2 i kilden.',
  });
  return {
    sourceCard: {
      whyItMatters: 'Denne kilden forankrer kjernebegrepet clearance.',
      sourceStatus: ['foundational'],
      estimatedReadingMinutes: 20,
    },
    prerequisites: [
      { concept: 'drug_clearance', level: 'essential' as const, why: 'Trengs for eksponering.' },
    ],
    preReadingPrompts: [
      'Legg merke til hvordan eksponering defineres.',
      'Se om komparatoren støtter konklusjonen.',
      'Vurder om endepunktet er klinisk meningsfullt.',
    ],
    objectives: ['Forstå clearance i kontekst av kilden.'],
    questions: Array.from({ length: 10 }, (_unused, i) => question(i + 1)),
  };
}

describe('learningUnitContentSchema', () => {
  it('accepts a well-formed unit', () => {
    expect(learningUnitContentSchema.safeParse(validUnitContent()).success).toBe(true);
  });

  it('rejects fewer than 10 questions', () => {
    const bad = { ...validUnitContent(), questions: validUnitContent().questions.slice(0, 5) };
    expect(learningUnitContentSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects fewer than 3 pre-reading prompts', () => {
    const bad = { ...validUnitContent(), preReadingPrompts: ['bare én'] };
    expect(learningUnitContentSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a question carrying a valid cognitiveSkill tag', () => {
    const content = validUnitContent();
    (content.questions[0] as Record<string, unknown>).cognitiveSkill =
      'statistical_reasoning';
    expect(learningUnitContentSchema.safeParse(content).success).toBe(true);
  });

  it('rejects an unknown cognitiveSkill value', () => {
    const content = validUnitContent();
    (content.questions[0] as Record<string, unknown>).cognitiveSkill =
      'telepathy';
    expect(learningUnitContentSchema.safeParse(content).success).toBe(false);
  });

  it('still accepts legacy questions with no cognitiveSkill (backward compat)', () => {
    // validUnitContent() omits cognitiveSkill entirely.
    expect(learningUnitContentSchema.safeParse(validUnitContent()).success).toBe(
      true,
    );
  });

  it('rejects a single_best question with no correct option', () => {
    const content = validUnitContent();
    content.questions[0].options.forEach((o) => (o.isCorrect = false));
    expect(learningUnitContentSchema.safeParse(content).success).toBe(false);
  });

  it('rejects a select_all question with zero correct options', () => {
    const content = validUnitContent();
    // Change question 1 to select_all format with no correct options.
    const q = content.questions[1]!;
    (q as typeof q & { format: string }).format = 'select_all';
    q.options.forEach((o) => (o.isCorrect = false));
    expect(learningUnitContentSchema.safeParse(content).success).toBe(false);
  });

  it('rejects a single_best question with two correct options', () => {
    const content = validUnitContent();
    const q = content.questions[2]!;
    // Set the first two options as correct — violates single_best invariant.
    q.options[0]!.isCorrect = true;
    q.options[1]!.isCorrect = true;
    q.options[2]!.isCorrect = false;
    q.options[3]!.isCorrect = false;
    expect(learningUnitContentSchema.safeParse(content).success).toBe(false);
  });
});

describe('createPendingEditSchema learning_unit branch', () => {
  const base = {
    editType: 'learning_unit' as const,
    proposedValue: validUnitContent(),
    referenceIds: [12],
    proposedMeta: {
      title: 'Hvorfor kjernebegreper betyr noe',
      slug: 'hvorfor-kjernebegreper',
      difficulty: 'foundational',
      domains: ['pharmacokinetics'],
    },
  };

  it('accepts a complete learning_unit edit', () => {
    expect(createPendingEditSchema.safeParse(base).success).toBe(true);
  });

  it('rejects a learning_unit edit with no anchor citation', () => {
    const { referenceIds, ...noRef } = base;
    expect(createPendingEditSchema.safeParse(noRef).success).toBe(false);
  });

  it('rejects a learning_unit edit missing proposedMeta.slug', () => {
    const bad = { ...base, proposedMeta: { ...base.proposedMeta, slug: undefined } };
    expect(createPendingEditSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a slug containing an uppercase letter or underscore', () => {
    // Slug feeds a public URL — must be lowercase letters, digits, and hyphens only.
    const bad = { ...base, proposedMeta: { ...base.proposedMeta, slug: 'Bad_Slug' } };
    expect(createPendingEditSchema.safeParse(bad).success).toBe(false);
  });
});
