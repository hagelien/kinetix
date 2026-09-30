import { describe, expect, it } from 'vitest';
import { classifyModelTier, isFlagshipTier } from './modelTiers.js';

describe('classifyModelTier', () => {
  it('classifies Claude flagship models', () => {
    expect(classifyModelTier('claude-opus-4-7')).toBe('flagship');
    expect(classifyModelTier('claude-opus-5')).toBe('flagship');
    expect(classifyModelTier('claude-fable-5')).toBe('flagship');
    expect(classifyModelTier('claude-mythos-5')).toBe('flagship');
  });

  it('classifies GPT-5.6 Sol as flagship', () => {
    expect(classifyModelTier('gpt-5.6-sol')).toBe('flagship');
    expect(classifyModelTier('sol')).toBe('flagship');
  });

  it('classifies mid-tier models', () => {
    expect(classifyModelTier('claude-sonnet-5')).toBe('mid');
    expect(classifyModelTier('claude-sonnet-4-6')).toBe('mid');
    expect(classifyModelTier('gpt-5.6-terra')).toBe('mid');
    expect(classifyModelTier('terra')).toBe('mid');
  });

  it('classifies light-tier models', () => {
    expect(classifyModelTier('claude-haiku-4-5')).toBe('light');
    expect(classifyModelTier('gpt-5.6-luna')).toBe('light');
    expect(classifyModelTier('luna')).toBe('light');
  });

  it('classifies unknown / missing as unknown (fail-safe)', () => {
    expect(classifyModelTier(null)).toBe('unknown');
    expect(classifyModelTier(undefined)).toBe('unknown');
    expect(classifyModelTier('')).toBe('unknown');
    expect(classifyModelTier('   ')).toBe('unknown');
    expect(classifyModelTier('some-future-model-x1')).toBe('unknown');
    expect(classifyModelTier('gpt-5.3-codex')).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(classifyModelTier('CLAUDE-OPUS-5')).toBe('flagship');
    expect(classifyModelTier('Terra')).toBe('mid');
  });
});

describe('isFlagshipTier', () => {
  it('is true only for flagship models, never for unknown', () => {
    expect(isFlagshipTier('claude-opus-5')).toBe(true);
    expect(isFlagshipTier('gpt-5.6-sol')).toBe(true);
    expect(isFlagshipTier('claude-sonnet-5')).toBe(false);
    expect(isFlagshipTier('gpt-5.6-terra')).toBe(false);
    expect(isFlagshipTier('claude-haiku-4-5')).toBe(false);
    expect(isFlagshipTier(null)).toBe(false);
    expect(isFlagshipTier('mystery-model')).toBe(false);
  });
});
