import { useTranslation } from 'react-i18next';
import type {
  GradeCaveat,
  GradeDisclosure as GradeDisclosureData,
} from '@/lib/modelGradeDisclosure';
import type { ModelGrade } from '@/lib/kinetics-core';

/**
 * The prominent grade + disclaimer for a catalog-DERIVED model (CV-3d).
 *
 * Renders the single data contract CV-3c (`describeDerivedModel`) produces — grade, limiting factor,
 * band-widening, and the structured caveats — into a badge + caveat list, translating each caveat
 * CODE here (the contract stays locale-agnostic, emitting codes + values, never prose). A
 * `not-modelable` derivation shows a "not modelable" badge and its reason, no grade; a spotless A model
 * shows just its badge. Purely presentational: the caller supplies the disclosure (the render path,
 * CV-4/CV-5, computes it per drug), so this stays unit-testable from fixtures.
 */

/** Badge colour per grade — earned confidence fades from green (A) to red (D). */
const GRADE_BADGE_CLASS: Record<ModelGrade, string> = {
  A: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  B: 'bg-lime-500/15 text-lime-700 dark:text-lime-300',
  C: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  D: 'bg-red-500/15 text-red-700 dark:text-red-300',
};

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** Localize one structured caveat. Each `code` maps to a `modelGrade.caveat.*` key; unmapped axis /
 *  parameter tokens fall back to their raw engine name so a new one is never a blank. */
function caveatText(caveat: GradeCaveat, t: Translate): string {
  switch (caveat.code) {
    case 'defaulted-axes':
      return t('modelGrade.caveat.defaultedAxes', {
        axes: caveat.axes.map((a) => t(`modelGrade.axis.${a}`, { defaultValue: a })).join(', '),
      });
    case 'missing-parameters':
      return t('modelGrade.caveat.missingParameters', {
        parameters: caveat.parameters
          .map((p) => t(`modelGrade.param.${p}`, { defaultValue: p }))
          .join(', '),
      });
    case 'inferred-parameters':
      return t('modelGrade.caveat.inferredParameters', {
        parameters: caveat.parameters
          .map((p) => t(`modelGrade.param.${p}`, { defaultValue: p }))
          .join(', '),
      });
    case 'weak-source-quality':
      return t('modelGrade.caveat.weakSourceQuality', { grade: caveat.grade });
    case 'not-validated':
      return t('modelGrade.caveat.notValidated');
    case 'not-modelable':
      return caveat.reason
        ? t('modelGrade.caveat.notModelableReason', { reason: caveat.reason })
        : t('modelGrade.caveat.notModelable');
  }
}

export interface GradeDisclosureProps {
  disclosure: GradeDisclosureData;
  className?: string;
}

export function GradeDisclosure({ disclosure, className }: GradeDisclosureProps) {
  const { t } = useTranslation();
  const { rendersCurve, grade, limitingFactor, bandWideningCv, caveats } = disclosure;

  return (
    <div
      className={`flex flex-col gap-1 text-xs${className ? ` ${className}` : ''}`}
      data-testid="grade-disclosure"
    >
      <div className="flex flex-wrap items-center gap-2">
        {rendersCurve && grade ? (
          <span
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium ${GRADE_BADGE_CLASS[grade]}`}
          >
            <span className="font-bold">{grade}</span>
            <span className="sr-only">{t('modelGrade.badge', { grade })}</span>
          </span>
        ) : (
          <span className="inline-flex items-center rounded bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
            {t('modelGrade.notModelable')}
          </span>
        )}
        {rendersCurve && limitingFactor && (
          <span className="text-muted-foreground">
            {t('modelGrade.limitedBy', {
              factor: t(`modelGrade.factor.${limitingFactor}`, { defaultValue: limitingFactor }),
            })}
          </span>
        )}
        {bandWideningCv != null && bandWideningCv > 0 && (
          <span className="text-muted-foreground">
            {t('modelGrade.bandWidened', { percent: Math.round(bandWideningCv * 100) })}
          </span>
        )}
      </div>

      {caveats.length > 0 && (
        <ul className="ml-3 list-disc text-muted-foreground">
          {caveats.map((caveat, i) => (
            <li key={`${caveat.code}-${i}`}>{caveatText(caveat, t)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default GradeDisclosure;
