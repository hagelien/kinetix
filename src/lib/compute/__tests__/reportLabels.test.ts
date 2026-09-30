import { describe, it, expect, vi } from 'vitest';
import {
  buildReportLabelsFromT,
  REPORT_LABEL_KEYS,
} from '../reportLabels';
import { defaultEnglishReportLabels } from '../report';
import type { TFunction } from 'i18next';

// Cast a vi.fn returning a string to TFunction so we can stub `t()` without
// depending on react-i18next's full type surface here.
function mockT(impl: (key: string) => string): TFunction {
  return vi.fn(impl) as unknown as TFunction;
}

describe('buildReportLabelsFromT', () => {
  it('resolves every label via t() under the kinelab.report.* namespace', () => {
    const t = mockT((key) => `T(${key})`);
    const labels = buildReportLabelsFromT(t);
    for (const key of REPORT_LABEL_KEYS) {
      expect(labels[key]).toBe(`T(kinelab.report.${key})`);
    }
  });

  it('exports REPORT_LABEL_KEYS that exactly cover the ReportLabels shape', () => {
    // The English defaults are the canonical shape — every key we ship needs
    // a matching translation key. This guard catches a future PR that adds
    // a label without updating the resolver list.
    const defaultKeys = Object.keys(defaultEnglishReportLabels).sort();
    const helperKeys = [...REPORT_LABEL_KEYS].sort();
    expect(helperKeys).toEqual(defaultKeys);
  });

  it('memoization friendliness: separate calls return distinct objects', () => {
    const t = mockT((key) => key);
    const a = buildReportLabelsFromT(t);
    const b = buildReportLabelsFromT(t);
    expect(a).not.toBe(b); // page wraps in useMemo to dedupe
    expect(a).toEqual(b);
  });
});
