import { describe, expect, it } from 'vitest';
import { runParityV3Forward } from './parityHarnessV3Forward';

describe('EtOH workbook v3 forward parity (Phase J1.5)', () => {
  it('matches the Fremoverregning EtOH oracle snapshot for every shared output field', () => {
    const report = runParityV3Forward();
    if (report.failingCases.length > 0) {
      const first = report.failingCases[0];
      throw new Error(
        `v3 forward parity failed for ${report.failingCases.length} comparisons. ` +
          `First failure: ${first.caseId}/${first.output} oracle=${first.oracle} ` +
          `sut=${first.sut} abs=${first.absDelta} rel=${first.relDelta}`,
      );
    }
    expect(report.failingCases).toHaveLength(0);
  });
});
