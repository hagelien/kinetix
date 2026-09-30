/**
 * The guideline's own wording for one cell of its detection-time column.
 *
 * Shared by the detection-times section and the substance register's column so
 * the same cell never reads two ways in two places. Takes `t` rather than
 * importing i18next, which keeps it a pure function of (statement, translator)
 * and testable without a provider.
 */
import type { RefsDetectionStatement } from './refsDetectionTimes';

export type Translate = (
  key: string,
  options?: Record<string, unknown>,
) => string;

export function refsStatementText(
  statement: RefsDetectionStatement,
  t: Translate,
): string {
  switch (statement.kind) {
    case 'band':
      // Bands reuse the module's band vocabulary: the guideline and the module
      // say the same words ("Siste døgnet", "Siste par ukene"), which is why
      // the bands were named after them in the first place.
      return statement.upper
        ? t('detection.refs.bandRange', {
            low: t(`detection.band.${statement.band}`),
            high: t(`detection.band.${statement.upper}`),
          })
        : t(`detection.band.${statement.band}`);
    case 'curves':
      return t('detection.refs.curves');
    case 'noDocumentation':
      return t('detection.refs.noDocumentation');
    case 'notStated':
      return t('detection.refs.notStated');
  }
}
