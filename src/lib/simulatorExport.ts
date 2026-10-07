import { admitsExport, type ResultGrade } from '@/lib/reviewedModelGrade';
import { statedDimensions } from '@/lib/kinetics-core';
import type { DrugSimResult } from '@/types/simulator';
import { formatSignificant, formatWithMaxDecimals } from '@/lib/rangeUtils';
import { hasUncertaintyBand } from '@/lib/modelingAnswer';

function fmt(n: number): string {
  return formatSignificant(n);
}

function formatDist(dist: {
  type: string;
  value?: number;
  min?: number;
  max?: number;
  mode?: number;
  mu?: number;
  sigma?: number;
}): string {
  switch (dist.type) {
    case 'fixed':
      return `${dist.value} (fixed)`;
    case 'uniform':
      return `${dist.min}–${dist.max} (uniform)`;
    case 'triangular':
      return `${dist.min}–${dist.max}, mode ${dist.mode} (triangular)`;
    case 'lognormal':
      return `LN(${dist.mu}, ${dist.sigma})`;
    default:
      return '—';
  }
}

/**
 * Generate a plain-text summary report of the simulation results.
 */
export function exportSummaryText(
  caseName: string,
  results: Record<string, DrugSimResult>,
  drugLabels: Record<string, string>,
  translate?: (key: string) => string,
  /**
   * Evidence grade per result id. Amendment 1 (catalog-coverage plan §5.2)
   * condition 4: a curve may not be detached from its disclosure, so an export
   * carries the same grade and the same itemised limitations as the screen.
   */
  resultGrades?: Record<string, ResultGrade | null>,
): string {
  const lines: string[] = [];
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  lines.push('PK SIMULATOR — ROUGH ESTIMATE SUMMARY');
  lines.push('='.repeat(40));
  lines.push(`Case: ${caseName}`);
  lines.push(`Generated: ${now}`);
  lines.push('');
  lines.push(
    'DISCLAIMER: This range reflects uncertainty in literature-based PK',
  );
  lines.push('parameters and case assumptions. It is not an individualized');
  lines.push('confidence interval.');
  lines.push('');

  for (const [id, result] of Object.entries(results)) {
    const label = drugLabels[id] ?? id;

    // The export obeys the same render gate the screen does. A model the policy
    // withholds contributes no figures here either: the disclosure below used to
    // sit UNDER a full numeric block, which meant a hard-stopped or below-floor
    // model was hidden from the chart and had its median, percentiles and
    // parameters written into the file anyway. §5.1 governs "a numeric curve or
    // curve coordinates" wherever they surface, and a text export is such a
    // surface. The drug is still named, and still carries its evidence record —
    // omitting it entirely would be its own dishonesty.
    const graded = resultGrades?.[id];
    if (graded && !admitsExport(graded)) {
      lines.push(`─── ${label} ───`);
      lines.push(
        `  ${
          graded.policy.grade === 'ungraded'
            ? 'NO FIGURES — the evidence cannot support a curve'
            : graded.admittedBy === 'acknowledgement'
              ? `NO FIGURES — grade ${graded.policy.grade} is shown to you only under an ` +
                'acknowledgement in the review workspace, which does not travel into an export'
              : `NO FIGURES — grade ${graded.policy.grade} is below the floor for this viewer`
        }`,
      );
      const stated = statedDimensions(graded.policy);
      if (stated.length > 0) {
        lines.push('  Evidence record:');
        for (const item of stated) {
          lines.push(`    - ${item.dimension} [${item.grade}]: ${item.reason ?? ''}`.trimEnd());
        }
      }
      lines.push('');
      continue;
    }

    const modeLabel =
      result.questionMode === 'dose-from-concentration'
        ? 'Plausible dose'
        : 'Plausible concentration';

    lines.push(`─── ${label} ───`);
    lines.push(`  Question mode: ${result.questionMode}`);
    // A run the engine could not complete carries placeholder zeros, not an
    // estimate of zero. It is named and its reason recorded — the same shape
    // the withheld-model branch above uses — but no figure is written.
    if (result.failure) {
      lines.push('  NO ANSWER — the run could not be completed');
      lines.push(
        `    Reason: ${result.failure.messageKey ?? result.failure.message}`,
      );
      lines.push('');
      continue;
    }
    lines.push(`  ${modeLabel}:`);
    lines.push(`    Median:  ${fmt(result.median)} ${result.unit}`);
    if (hasUncertaintyBand(result)) {
      lines.push(
        `    25–75%:  ${fmt(result.p25)} – ${fmt(result.p75)} ${result.unit}`,
      );
      lines.push(
        `    5–95%:   ${fmt(result.p05)} – ${fmt(result.p95)} ${result.unit}`,
      );
    } else {
      // Every percentile coincided: the model declares fixed parameters, so the
      // run produced no spread. Printing "22.27 – 22.27" as a quartile band
      // would put a precision claim into an exported report that the run never
      // made.
      lines.push(
        '    Deterministic run: fixed model parameters, no uncertainty band.',
      );
    }
    lines.push('');

    lines.push('  Assumptions:');
    lines.push(
      `    Model: ${
        result.assumptions.modelKey
          ? (translate?.(result.assumptions.modelKey) ??
            result.assumptions.model)
          : result.assumptions.model
      }`,
    );
    lines.push(`    Route: ${result.assumptions.route}`);
    lines.push(`    t½:    ${formatDist(result.assumptions.halfLife)}`);
    lines.push(`    Vd:    ${formatDist(result.assumptions.vd)}`);
    lines.push(`    F:     ${formatDist(result.assumptions.f)}`);
    lines.push(`    Draws: ${result.drawCount.toLocaleString()}`);
    if (result.assumptions.nativeMatrix) {
      lines.push(`    Matrix: ${result.assumptions.nativeMatrix} (model native)`);
    }
    lines.push('');

    if (graded) {
      const grade = graded.policy.grade;
      lines.push('  Evidence grade:');
      lines.push(
        `    ${grade === 'ungraded' ? 'UNGRADED — no curve may be shown' : `Grade ${grade}`}`,
      );
      if (graded.policy.disclosable.length > 0) {
        lines.push('    Limitations (each dimension below B):');
        for (const item of graded.policy.disclosable) {
          // The scorer's own reason text, which is the audit record — the
          // export is a document, so it carries the full statement rather than
          // the UI's shortened line.
          lines.push(`      - ${item.dimension} [${item.grade}]: ${item.reason ?? ''}`.trimEnd());
        }
      }
      if (
        graded.policy.disclosable.some(
          (item) => item.dimension === 'uncertainty-semantics',
        )
      ) {
        // Only when a band was actually reported: naming the semantics of a
        // 5–95% band that the deterministic run never produced would describe
        // a figure that is not in the document.
        lines.push(
          hasUncertaintyBand(result)
            ? '    The 5–95% band above is a PLAUSIBLE RANGE, not a confidence or'
            : '    This run reports a single value, not an interval: the model’s',
        );
        lines.push(
          hasUncertaintyBand(result)
            ? '    prediction interval: the uncertainty components are pooled.'
            : '    parameter uncertainty is not quantified.',
        );
      }
      lines.push('');
    }

    if (result.sensitivity.length > 0) {
      lines.push('  Sensitivity:');
      for (const s of result.sensitivity.filter((s) => s.influence > 0.05)) {
        lines.push(`    ${s.parameter}: ${Math.round(s.influence * 100)}%`);
      }
      lines.push('');
    }

    if (result.warnings.length > 0) {
      lines.push('  Warnings:');
      for (const w of result.warnings) {
        const message = w.messageKey
          ? (translate?.(w.messageKey) ?? w.message)
          : w.message;
        lines.push(`    [${w.severity}] ${message}`);
      }
      lines.push('');
    }

    const m = result.manifest;
    if (m) {
      lines.push('  Run manifest:');
      lines.push(`    Engine:  ${m.engine}`);
      lines.push(
        `    Model:   ${m.model ? (translate?.(m.model) ?? m.model) : m.model}`,
      );
      lines.push(`    Seed:    ${m.seed}`);
      lines.push(`    Draws:   ${m.drawCount.toLocaleString()}`);
      if (m.effectiveSampleSize != null && m.sampleCount != null) {
        lines.push(
          `    ESS:     ${formatWithMaxDecimals(m.effectiveSampleSize)} / ${m.sampleCount.toLocaleString()}`,
        );
      }
      if (m.matrix) lines.push(`    Matrix:  ${m.matrix}`);
      lines.push(`    Inputs:  ${m.inputHash}`);
      if (m.appVersion) lines.push(`    Version: ${m.appVersion}`);
      lines.push(`    Run at:  ${m.createdAtIso}`);
      lines.push('');
    }
  }

  lines.push('─'.repeat(40));
  lines.push('Generated by Kinetix PK Simulator');

  return lines.join('\n');
}

/**
 * Trigger a file download in the browser.
 */
export function downloadTextFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
