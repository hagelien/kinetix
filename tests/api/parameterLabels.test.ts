import { describe, expect, it } from 'vitest';
import nb from '../../src/locales/nb.json';
import en from '../../src/locales/en.json';
import { PARAMETER_LABELS } from '../../api/_lib/parameterLabels';

function localeLabels(bundle: { parameters: Record<string, { label?: string }> }) {
  return Object.fromEntries(
    Object.entries(bundle.parameters)
      .filter(([, v]) => typeof v.label === 'string')
      .map(([k, v]) => [k, v.label]),
  );
}

describe('PARAMETER_LABELS', () => {
  it('matches the parameter labels in the locale files', () => {
    expect(PARAMETER_LABELS.nb).toEqual(localeLabels(nb));
    expect(PARAMETER_LABELS.en).toEqual(localeLabels(en));
  });
});
