import type { TFunction } from 'i18next';
import type { ReportLabels } from './types';

// Maps a `react-i18next` translator function to the flat `ReportLabels`
// shape consumed by `renderReportMarkdown`. Lives in src/lib/compute/ so the
// engine layer can stay React-free; the page resolves keys via `t()` and
// passes the resulting object as `reportInput.labels`.
//
// Every key in this list MUST exist in both `src/locales/{en,nb}.json` under
// `kinelab.report.*`, or the locale parity test will fail. The literal keys
// here are the discriminator the i18n parity test checks.

const REPORT_KEYS = [
  'defaultTitle',
  'authoredBy',
  'caseId',
  'caseSummary',
  'analyte',
  'model',
  'route',
  'intakeWindow',
  'subject',
  'subjectSex',
  'subjectAge',
  'subjectWeight',
  'engine',
  'generated',
  'observations',
  'obsCol_id',
  'obsCol_concentration',
  'obsCol_matrix',
  'obsCol_sampleTime',
  'obsCol_assayCV',
  'obsCol_assayCVDefault',
  'method',
  'methodLead',
  'priors',
  'priorsDose',
  'priorsHalfLife',
  'priorsVd',
  'priorsF',
  'priorsEliminationRate',
  'priorsAssayCV',
  'priorsDraws',
  'posteriorIntervals',
  'paramCol_param',
  'paramCol_unit',
  'posteriorEmpty',
  'posteriorPredictive',
  'predictiveSpan',
  'predictivePeak',
  'scenarioComparison',
  'scenariosComputedBy',
  'scenarioCol_label',
  'scenarioCol_doseMedian',
  'scenarioCol_ess',
  'assumptions',
  'limitations',
  'diagnosticWarnings',
  'severityCritical',
  'severityWarning',
  'liteDisclaimer',
  'notAvailable',
] as const satisfies ReadonlyArray<keyof ReportLabels>;

export function buildReportLabelsFromT(t: TFunction): ReportLabels {
  const labels = {} as Record<keyof ReportLabels, string>;
  for (const key of REPORT_KEYS) {
    // Pre-resolve every label so `renderReportMarkdown` (which runs without
    // a React context) gets a plain object. The page is responsible for
    // rebuilding this when the language changes — i18next changeLanguage
    // re-renders subscribed components, so a useMemo over `t` is enough.
    labels[key] = t(`kinelab.report.${key}`);
  }
  return labels;
}

// Re-export for tests / the parity guard.
export const REPORT_LABEL_KEYS: ReadonlyArray<keyof ReportLabels> = REPORT_KEYS;
