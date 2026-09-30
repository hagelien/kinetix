import { describe, expect, it } from 'vitest';
import {
  cognitiveSkillToDimension,
  difficultyLabelKey,
  difficultyRank,
  gradeAssessment,
  groupUnitsByDomain,
  prerequisiteLevelLabelKey,
  scoreQuestion,
  sourceLinkOutUrl,
  type LearningQuestion,
} from './learnContent';

function singleBest(): LearningQuestion {
  return {
    stem: 'Which statement is correct?',
    format: 'single_best',
    category: 'factual',
    difficulty: 'foundational',
    concepts: [],
    sourceSupport: 'p. 1',
    options: [
      { id: 'a', text: 'Right', isCorrect: true, explanation: 'because right' },
      { id: 'b', text: 'Wrong', isCorrect: false, explanation: 'because wrong' },
    ],
  };
}

function selectAll(): LearningQuestion {
  return {
    stem: 'Select all that apply.',
    format: 'select_all',
    category: 'reasoned',
    difficulty: 'board',
    concepts: [],
    sourceSupport: 'p. 2',
    options: [
      { id: 'a', text: 'One', isCorrect: true, explanation: 'yes one' },
      { id: 'b', text: 'Two', isCorrect: true, explanation: 'yes two' },
      { id: 'c', text: 'Three', isCorrect: false, explanation: 'no three' },
    ],
  };
}

describe('label keys', () => {
  it('builds difficulty and prerequisite label keys', () => {
    expect(difficultyLabelKey('foundational')).toBe(
      'learn.difficulty.foundational',
    );
    expect(prerequisiteLevelLabelKey('essential')).toBe(
      'learn.prereq.essential',
    );
  });
});

describe('sourceLinkOutUrl', () => {
  it('resolves doi, pmid, and url', () => {
    expect(sourceLinkOutUrl('doi', '10.1/x')).toBe('https://doi.org/10.1/x');
    expect(sourceLinkOutUrl('pmid', '123')).toBe(
      'https://pubmed.ncbi.nlm.nih.gov/123/',
    );
    expect(sourceLinkOutUrl('url', 'https://example.com')).toBe(
      'https://example.com',
    );
  });

  it('returns null for freetext and empty identifiers', () => {
    expect(sourceLinkOutUrl('freetext', 'Smith 2020')).toBeNull();
    expect(sourceLinkOutUrl('doi', '   ')).toBeNull();
  });

  it('does not link unsafe or malformed URL identifiers', () => {
    expect(sourceLinkOutUrl('url', 'javascript:alert(1)')).toBeNull();
    expect(sourceLinkOutUrl('url', 'not a url')).toBeNull();
  });
});

describe('scoreQuestion', () => {
  it('scores single_best right and wrong', () => {
    const q = singleBest();
    expect(scoreQuestion(q, ['a'])).toEqual({ correct: true, correctIds: ['a'] });
    expect(scoreQuestion(q, ['b']).correct).toBe(false);
    expect(scoreQuestion(q, []).correct).toBe(false);
  });

  it('scores select_all as an exact set match', () => {
    const q = selectAll();
    expect(scoreQuestion(q, ['a', 'b']).correct).toBe(true);
    expect(scoreQuestion(q, ['b', 'a']).correct).toBe(true); // order-insensitive
    expect(scoreQuestion(q, ['a']).correct).toBe(false); // partial = incorrect
    expect(scoreQuestion(q, ['a', 'b', 'c']).correct).toBe(false); // extra = incorrect
  });
});

describe('gradeAssessment', () => {
  it('counts correct answers across questions', () => {
    const questions = [singleBest(), selectAll()];
    const grade = gradeAssessment(questions, { 0: ['a'], 1: ['a'] });
    expect(grade.total).toBe(2);
    expect(grade.correctCount).toBe(1);
    expect(grade.perQuestion[0]!.correct).toBe(true);
    expect(grade.perQuestion[1]!.correct).toBe(false);
  });

  it('treats a missing answer as incorrect', () => {
    const grade = gradeAssessment([singleBest()], {});
    expect(grade.correctCount).toBe(0);
  });
});

describe('cognitiveSkillToDimension', () => {
  it('maps explicit skills to their dimension', () => {
    expect(cognitiveSkillToDimension('statistical_reasoning', 'reasoned')).toBe(
      'statistical_reasoning',
    );
    expect(cognitiveSkillToDimension('critical_appraisal', 'reasoned')).toBe(
      'critical_appraisal',
    );
    expect(cognitiveSkillToDimension('factual_recall', 'reasoned')).toBe(
      'factual_knowledge',
    );
    // mechanistic folds into clinical reasoning
    expect(cognitiveSkillToDimension('mechanistic', 'factual')).toBe(
      'clinical_reasoning',
    );
  });

  it('falls back to category when no skill tag is present', () => {
    expect(cognitiveSkillToDimension(undefined, 'factual')).toBe(
      'factual_knowledge',
    );
    expect(cognitiveSkillToDimension(null, 'reasoned')).toBe(
      'clinical_reasoning',
    );
  });
});

describe('difficultyRank', () => {
  it('orders by curriculum sequence and sorts unknowns last', () => {
    expect(difficultyRank('foundational')).toBeLessThan(
      difficultyRank('research'),
    );
    expect(difficultyRank('board')).toBeLessThan(difficultyRank('senior'));
    expect(difficultyRank('mystery')).toBeGreaterThan(
      difficultyRank('research'),
    );
  });
});

describe('groupUnitsByDomain', () => {
  const units = [
    { id: 1, domains: ['pharmacokinetics'], difficulty: 'board' },
    { id: 2, domains: ['pharmacokinetics'], difficulty: 'foundational' },
    { id: 3, domains: ['pharmacodynamics', 'pharmacokinetics'], difficulty: 'senior' },
    { id: 4, domains: [], difficulty: 'foundational' },
  ];

  it('groups units under each of their domains, alphabetically', () => {
    const groups = groupUnitsByDomain(units, 'Other');
    expect(groups.map((g) => g.domain)).toEqual([
      'Other',
      'pharmacodynamics',
      'pharmacokinetics',
    ]);
  });

  it('places unitless units under the uncategorized label', () => {
    const groups = groupUnitsByDomain(units, 'Other');
    const other = groups.find((g) => g.domain === 'Other');
    expect(other?.units.map((u) => u.id)).toEqual([4]);
  });

  it('sorts units within a domain by difficulty rank', () => {
    const groups = groupUnitsByDomain(units, 'Other');
    const pk = groups.find((g) => g.domain === 'pharmacokinetics');
    // foundational (id 2) < board (id 1) < senior (id 3)
    expect(pk?.units.map((u) => u.id)).toEqual([2, 1, 3]);
  });
});
