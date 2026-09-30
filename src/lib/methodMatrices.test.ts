import { describe, expect, it } from 'vitest';
import en from '@/locales/en.json';
import nb from '@/locales/nb.json';
import { METHOD_MATRIX_VALUES, METHOD_TYPE_VALUES } from './methodMatrices';
import {
  MATRIX_COLORS,
  METHOD_MATRICES,
  METHOD_TYPES,
  matrixLabelKey,
  methodTypeLabelKey,
} from './methodMeta';

const LOCALES: Record<string, { methods: Record<string, unknown> }> = { en, nb };

describe('method matrix vocabulary', () => {
  it('includes every matrix the editor offers, "other" among them', () => {
    // Regression: the API's zod enum omitted 'other', so saving a method with
    // the "Annet" toggle active failed with `matrices.N: Invalid option`.
    expect(METHOD_MATRIX_VALUES).toContain('other');
    expect(METHOD_MATRICES).toEqual([...METHOD_MATRIX_VALUES]);
  });

  it('has a colour for every matrix and no orphan colours', () => {
    expect(Object.keys(MATRIX_COLORS).sort()).toEqual(
      [...METHOD_MATRIX_VALUES].sort(),
    );
  });

  it.each(Object.keys(LOCALES))('has a %s label for every matrix', (locale) => {
    const messages = LOCALES[locale]!.methods;
    for (const matrix of METHOD_MATRIX_VALUES) {
      const key = matrixLabelKey(matrix).replace(/^methods\./, '');
      expect(messages[key], `${locale}: ${matrixLabelKey(matrix)}`).toBeTruthy();
    }
  });

  it.each(Object.keys(LOCALES))('has a %s label for every method type', (locale) => {
    const messages = LOCALES[locale]!.methods;
    for (const type of METHOD_TYPE_VALUES) {
      const key = methodTypeLabelKey(type).replace(/^methods\./, '');
      expect(messages[key], `${locale}: ${methodTypeLabelKey(type)}`).toBeTruthy();
    }
    expect(METHOD_TYPES).toEqual([...METHOD_TYPE_VALUES]);
  });
});
