import type {
  Assumption,
  InferenceInput,
  InferenceResult,
  Limitation,
  PosteriorSummary,
  ReportInput,
  ReportLabels,
  ScenarioComparisonResult,
} from './types';

// `renderReportMarkdown` produces the markdown body returned by
// `LiteBrowserEngine.generateReport()`. Lite reports are plain markdown so the
// same string can be downloaded as `.md`, copied into monograph/wiki edits,
// or fed to a markdown-to-HTML pipeline.
//
// Localization: every chrome string the report emits is sourced from
// `ReportLabels`. Callers (the React page) populate that from `t()`; headless
// callers (tests, the future Full backend) can omit `labels` and receive
// `defaultEnglishReportLabels` so the report still reads cleanly without
// React in scope.
//
// The Lite limitation statement at the bottom is the verbatim text mandated
// by the KineLab spec for Lite output. It is exported separately so tests and
// the i18n parity check can assert it round-trips unchanged.

const LITE_LIMITATION_STATEMENT = `This result was generated using the KineLab Lite browser engine. The Lite engine uses simplified analytic PK models and approximate grid/Monte Carlo inference. It does not use full ODE-based pharmacometric modelling, hierarchical Bayesian inference, or validated postmortem redistribution modelling. The output should be interpreted as scenario exploration and uncertainty visualization, not as a definitive forensic conclusion.`;

export const LITE_LIMITATION_STATEMENT_TEXT = LITE_LIMITATION_STATEMENT;

export const defaultEnglishReportLabels: ReportLabels = {
  defaultTitle: 'KineLab Lite — inference report',
  authoredBy: 'Authored by',
  caseId: 'Case ID',
  caseSummary: 'Case summary',
  analyte: 'Analyte',
  model: 'Model',
  route: 'Route',
  intakeWindow: 'Intake window',
  subject: 'Subject',
  subjectSex: 'sex',
  subjectAge: 'age',
  subjectWeight: 'kg',
  engine: 'Engine',
  generated: 'Generated',
  observations: 'Observations',
  obsCol_id: 'ID',
  obsCol_concentration: 'Concentration',
  obsCol_matrix: 'Matrix',
  obsCol_sampleTime: 'Sample time',
  obsCol_assayCV: 'Assay CV',
  obsCol_assayCVDefault: 'default',
  method: 'Method',
  methodLead:
    'Lite engine uses analytic one-compartment PK and lognormal observation noise; posterior is approximated via importance sampling.',
  priors: 'Priors',
  priorsDose: 'Dose',
  priorsHalfLife: 'Half-life',
  priorsVd: 'Vd',
  priorsF: 'F',
  priorsEliminationRate: 'Elimination rate',
  priorsAssayCV: 'Default assay CV',
  priorsDraws: 'Draws',
  posteriorIntervals: 'Posterior parameter intervals',
  paramCol_param: 'Parameter',
  paramCol_unit: 'unit',
  posteriorEmpty:
    '_No posterior intervals — the inference produced an empty posterior._',
  posteriorPredictive: 'Posterior predictive curve',
  predictiveSpan: '{{count}} timepoints from {{start}} h to {{end}} h. Concentrations in {{unit}}.',
  predictivePeak:
    'Peak median: **{{median}}** {{unit}} at t = {{t}} h (90% CI: {{p05}} – {{p95}}).',
  scenarioComparison: 'Scenario comparison',
  scenariosComputedBy: '{{count}} scenarios computed by {{engine}}.',
  scenarioCol_label: 'Scenario',
  scenarioCol_doseMedian: 'Posterior dose median (mg)',
  scenarioCol_ess: 'Effective sample size',
  assumptions: 'Assumptions',
  limitations: 'Limitations',
  diagnosticWarnings: 'Diagnostic warnings',
  severityCritical: '(critical)',
  severityWarning: '(warning)',
  liteDisclaimer: LITE_LIMITATION_STATEMENT,
  notAvailable: '—',
};

export function renderReportMarkdown(input: ReportInput): string {
  const labels = input.labels ?? defaultEnglishReportLabels;
  const { inferenceResult, inferenceInput, scenarioComparison, cover, caseId } =
    input;
  const lines: string[] = [];

  // ─── Cover ────────────────────────────────────────────────────────────────
  const title = cover?.title ?? labels.defaultTitle;
  lines.push(`# ${title}`);
  if (cover?.authoredBy) {
    lines.push(`_${labels.authoredBy} **${cover.authoredBy}**_`);
  }
  if (caseId) {
    lines.push(`_${labels.caseId}: \`${caseId}\`_`);
  }
  lines.push('');

  // ─── Case summary ─────────────────────────────────────────────────────────
  lines.push(`## ${labels.caseSummary}`);
  lines.push('');
  lines.push(`- **${labels.analyte}**: ${inferenceInput?.analyte ?? labels.notAvailable}`);
  lines.push(
    `- **${labels.model}**: ${inferenceResult.modelIds.join(', ') || labels.notAvailable}`,
  );
  if (inferenceInput) {
    lines.push(`- **${labels.route}**: ${inferenceInput.route}`);
    const window = inferenceInput.scenario?.possibleIntakeWindow;
    if (window) {
      lines.push(
        `- **${labels.intakeWindow}**: ${window.earliestIso} → ${window.latestIso}`,
      );
    }
    if (inferenceInput.subject) {
      const s = inferenceInput.subject;
      const fields: string[] = [];
      if (s.sex) fields.push(`${labels.subjectSex} ${s.sex}`);
      if (typeof s.age === 'number') fields.push(`${labels.subjectAge} ${s.age}`);
      if (typeof s.weightKg === 'number') {
        fields.push(`${s.weightKg} ${labels.subjectWeight}`);
      }
      if (fields.length) {
        lines.push(`- **${labels.subject}**: ${fields.join(', ')}`);
      }
    }
  }
  lines.push(`- **${labels.engine}**: ${inferenceResult.engine}`);
  lines.push(`- **${labels.generated}**: ${inferenceResult.createdAt}`);
  lines.push('');

  // ─── Observations ─────────────────────────────────────────────────────────
  if (inferenceInput && inferenceInput.observations.length > 0) {
    lines.push(`## ${labels.observations}`);
    lines.push('');
    lines.push(
      `| ${labels.obsCol_id} | ${labels.obsCol_concentration} | ${labels.obsCol_matrix} | ${labels.obsCol_sampleTime} | ${labels.obsCol_assayCV} |`,
    );
    lines.push('|---|---|---|---|---|');
    for (const o of inferenceInput.observations) {
      const cv = o.assay?.uncertaintyCV;
      const cvCell =
        cv != null
          ? cv.toString()
          : `${labels.obsCol_assayCVDefault} (${inferenceInput.defaultAssayCV})`;
      lines.push(
        `| ${o.id} | ${o.concentration.value} ${o.concentration.unit} | ${o.matrix} | ${o.sampleTime ?? labels.notAvailable} | ${cvCell} |`,
      );
    }
    lines.push('');
  }

  // ─── Method description ───────────────────────────────────────────────────
  lines.push(`## ${labels.method}`);
  lines.push('');
  lines.push(
    `${labels.method}: **${inferenceResult.diagnostics.method}**. ${labels.methodLead}`,
  );
  if (inferenceInput) {
    lines.push('');
    lines.push(`### ${labels.priors}`);
    lines.push(
      `- **${labels.priorsDose}**: ${formatDistribution(inferenceInput.priors.dose)} mg`,
    );
    if (inferenceInput.priors.halfLife) {
      lines.push(
        `- **${labels.priorsHalfLife}**: ${formatDistribution(inferenceInput.priors.halfLife)} h`,
      );
    }
    if (inferenceInput.priors.eliminationRate) {
      // Zero-order analytes (ethanol) drive elimination through this prior
      // instead of half-life. Surfacing it in the report keeps the run
      // reproducible from the markdown alone — without this row a reader
      // can't reconstruct the posterior.
      lines.push(
        `- **${labels.priorsEliminationRate}**: ${formatDistribution(inferenceInput.priors.eliminationRate)} mg/L/h`,
      );
    }
    lines.push(
      `- **${labels.priorsVd}**: ${formatDistribution(inferenceInput.priors.vd)} L`,
    );
    if (inferenceInput.priors.f) {
      lines.push(
        `- **${labels.priorsF}**: ${formatDistribution(inferenceInput.priors.f)}`,
      );
    }
    lines.push(`- **${labels.priorsAssayCV}**: ${inferenceInput.defaultAssayCV}`);
    lines.push(`- **${labels.priorsDraws}**: ${inferenceInput.drawCount}`);
  }
  lines.push('');

  // ─── Posterior intervals ──────────────────────────────────────────────────
  lines.push(`## ${labels.posteriorIntervals}`);
  lines.push('');
  lines.push(...renderPosteriorTable(inferenceResult.posteriorSummary, labels));
  lines.push('');

  // ─── Posterior predictive (peak summary) ──────────────────────────────────
  if (inferenceResult.posteriorPredictive) {
    const series = inferenceResult.posteriorPredictive.timeSeries;
    if (series.length > 0) {
      const peak = series.reduce(
        (best, p) => (p.median > best.median ? p : best),
        series[0]!,
      );
      lines.push(`## ${labels.posteriorPredictive}`);
      lines.push('');
      lines.push(
        `_${interpolate(labels.predictiveSpan, {
          count: String(series.length),
          start: series[0]!.t.toFixed(2),
          end: series.at(-1)!.t.toFixed(2),
          unit: inferenceResult.posteriorPredictive.unit,
        })}_`,
      );
      lines.push('');
      lines.push(
        interpolate(labels.predictivePeak, {
          median: peak.median.toFixed(4),
          unit: inferenceResult.posteriorPredictive.unit,
          t: peak.t.toFixed(2),
          p05: peak.p05.toFixed(4),
          p95: peak.p95.toFixed(4),
        }),
      );
      lines.push('');
    }
  }

  // ─── Scenario comparison ──────────────────────────────────────────────────
  if (scenarioComparison) {
    lines.push(...renderScenarioComparison(scenarioComparison, labels));
    lines.push('');
  }

  // ─── Assumptions ──────────────────────────────────────────────────────────
  if (inferenceResult.assumptions.length > 0) {
    lines.push(`## ${labels.assumptions}`);
    lines.push('');
    lines.push(...renderBulletList(inferenceResult.assumptions, (a: Assumption) => a.text));
    lines.push('');
  }

  // ─── Limitations ──────────────────────────────────────────────────────────
  if (inferenceResult.limitations.length > 0) {
    lines.push(`## ${labels.limitations}`);
    lines.push('');
    for (const l of inferenceResult.limitations) {
      const tag =
        l.severity === 'critical'
          ? `**${labels.severityCritical}**`
          : l.severity === 'warning'
            ? `_${labels.severityWarning}_`
            : '';
      lines.push(`- ${tag} ${l.text}`.trim());
    }
    lines.push('');
  }

  // ─── Diagnostic warnings ─────────────────────────────────────────────────
  if (inferenceResult.diagnostics.warnings.length > 0) {
    lines.push(`## ${labels.diagnosticWarnings}`);
    lines.push('');
    lines.push(...renderBulletList(inferenceResult.diagnostics.warnings, (w: string) => w));
    lines.push('');
  }

  // ─── Lite engine disclaimer ──────────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push(`> ${labels.liteDisclaimer}`);
  lines.push('');

  return lines.join('\n');
}

function renderPosteriorTable(
  p: PosteriorSummary,
  labels: ReportLabels,
): string[] {
  const entries = Object.entries(p.intervals);
  if (entries.length === 0) {
    return [labels.posteriorEmpty];
  }
  const out = [
    `| ${labels.paramCol_param} | p05 | median | p95 | ${labels.paramCol_unit} |`,
    '|---|---|---|---|---|',
  ];
  for (const [key, iv] of entries) {
    out.push(
      `| ${key} | ${formatNumber(iv.p05)} | ${formatNumber(iv.median)} | ${formatNumber(iv.p95)} | ${iv.unit ?? ''} |`,
    );
  }
  return out;
}

function renderScenarioComparison(
  s: ScenarioComparisonResult,
  labels: ReportLabels,
): string[] {
  const out: string[] = [];
  out.push(`## ${labels.scenarioComparison}`);
  out.push('');
  out.push(
    `_${interpolate(labels.scenariosComputedBy, {
      count: String(s.scenarios.length),
      engine: s.engine,
    })}_`,
  );
  out.push('');
  out.push(
    `| ${labels.scenarioCol_label} | ${labels.scenarioCol_doseMedian} | ${labels.scenarioCol_ess} |`,
  );
  out.push('|---|---|---|');
  for (const sc of s.scenarios) {
    const dose = sc.result.posteriorSummary.intervals.dose?.median;
    const ess = sc.result.diagnostics.effectiveSampleSize;
    out.push(
      `| ${sc.label} | ${dose != null ? formatNumber(dose) : labels.notAvailable} | ${ess != null ? ess.toFixed(1) : labels.notAvailable} |`,
    );
  }
  return out;
}

function renderBulletList<T>(items: T[], pick: (t: T) => string): string[] {
  return items.map((t) => `- ${pick(t)}`);
}

function formatDistribution(d: {
  type: string;
  value?: number;
  min?: number;
  max?: number;
  mode?: number;
  mu?: number;
  sigma?: number;
}): string {
  switch (d.type) {
    case 'fixed':
      return `${d.value} (fixed)`;
    case 'uniform':
      return `${d.min} – ${d.max} (uniform)`;
    case 'triangular':
      return `${d.min} – ${d.max}, mode ${d.mode} (triangular)`;
    case 'lognormal':
      return `LN(${d.mu}, ${d.sigma})`;
    default:
      return '—';
  }
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) < 0.01 && value !== 0) return value.toExponential(2);
  if (Math.abs(value) < 1) return value.toFixed(3);
  if (Math.abs(value) < 100) return value.toFixed(2);
  return Math.round(value).toLocaleString();
}

function interpolate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? '');
}

// Re-export so the test file doesn't have to reach into types.ts for these.
export type { Limitation, InferenceResult, InferenceInput };
