import { useTranslation } from 'react-i18next';
import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import {
  statedDimensions,
  type GradePolicyResult,
  type RenderDisposition,
} from '@/lib/kinetics-core';
import type { StructureSimplification } from '@/lib/reviewedModelGrade';
import { CAUTIOUS_DEFAULT_ROLES } from '@/lib/modelDerivation';
import { Button } from '@/components/ui/button';

/**
 * The evidence disclosure that travels with a curve.
 *
 * Amendment 1 (catalog-coverage plan §5.2) lets a grade-C model reach every user
 * class, but only on the condition that each dimension scoring below B is named
 * AT the curve — a single badge is explicitly not enough. This renders that
 * itemisation, so a reader can see why a model is C without leaving the result.
 *
 * The reasons the scorer produces are audit text, not UI copy: each dimension
 * maps to its own translated name and explanation, so the disclosure is bilingual
 * like every other user-facing string in the app.
 */
const GRADE_STYLES: Record<string, string> = {
  A: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/50 dark:text-emerald-100',
  B: 'bg-sky-100 text-sky-900 dark:bg-sky-900/50 dark:text-sky-100',
  C: 'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-100',
  D: 'bg-red-100 text-red-900 dark:bg-red-900/50 dark:text-red-100',
};

export function ModelGradeNotice({
  policy,
  disposition,
  drugLabel,
  onAcknowledge,
  acknowledged,
  acknowledgedAt,
  onWithdraw,
  hasBand = true,
  simplifications = [],
  cautiousDefaults = [],
}: {
  policy: GradePolicyResult;
  disposition: RenderDisposition;
  drugLabel?: string;
  /**
   * Whether the run this notice sits under actually produced an uncertainty
   * band. A model with fixed parameters collapses every percentile onto the
   * median, and the uncertainty-semantics disclosure then describes a shaded
   * band that is not on the chart — so it names the missing band instead.
   */
  hasBand?: boolean;
  /**
   * Record this viewer's §5.1 acknowledgement. Offered only on the
   * `acknowledge-in-review-workspace` disposition, which `renderDisposition`
   * returns for a reviewer class and a grade D and for no other combination — so
   * the control cannot appear for a viewer the policy would not admit, and this
   * component needs no user-class prop of its own to decide.
   */
  onAcknowledge?: () => void;
  /** This viewer has an acknowledgement on record for this model and this evidence. */
  acknowledged?: boolean;
  /** When that acknowledgement was recorded, ISO — part of the record §5.1 requires. */
  acknowledgedAt?: string;
  /** Withdraw that acknowledgement, returning the model to the withheld state. */
  onWithdraw?: () => void;
  /**
   * Structure axes the curve runs in a SIMPLER form than the drug's sources state
   * (a cited two-compartment disposition drawn one-compartment). Stated wherever
   * the curve or its review is shown: the generic completeness copy only says an
   * input was defaulted, which hides that the curve contradicts a cited model.
   */
  simplifications?: readonly StructureSimplification[];
  /**
   * Inputs the curve runs on a labelled cautious default because the catalog holds
   * no value (`bioavailability`, `ka`). Each is stated with what was assumed and
   * which way it pushes the curve, wherever the curve or its review is shown.
   */
  cautiousDefaults?: readonly string[];
}) {
  const { t } = useTranslation();
  const valueLabel = (value: string) =>
    t(`parameters.modelStructure.value.${value}`, { defaultValue: value });
  const simplificationNotes = [
    ...simplifications.map((s) => (
      <p key={s.axis} data-testid="model-simplification">
        {t('modelGrade.simplifiedStructure', {
          declared: valueLabel(s.declared),
          runs: valueLabel(s.runs),
        })}
      </p>
    )),
    ...cautiousDefaults.map((role) => (
      <p key={`default-${role}`} data-testid="model-cautious-default">
        {(CAUTIOUS_DEFAULT_ROLES as readonly string[]).includes(role)
          ? t(`modelGrade.cautiousDefault.${role}`)
          : t('modelGrade.cautiousDefault.generic', { parameter: role })}
      </p>
    )),
  ];

  // A hard stop or a below-floor grade shows the reason INSTEAD of a curve.
  // "Hidden" never means silent: the evidence record is the point.
  if (disposition === 'hidden') {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 px-2.5 py-2 text-xs text-red-900 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-100">
        <div className="flex items-center gap-1.5 font-semibold">
          <AlertTriangle className="h-3.5 w-3.5" />
          {drugLabel ? `${drugLabel} — ` : ''}
          {policy.grade === 'ungraded'
            ? t('modelGrade.hardStop')
            : t('modelGrade.insufficientEvidence')}
        </div>
        {/* `statedDimensions`, not `disclosable`: a hard stop assembled by hand can
            carry an empty `disclosable`, and the one result that most needs its
            reason shown would then show an empty list. */}
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {statedDimensions(policy).map((item) => (
            <li key={item.dimension}>
              {t(`modelGrade.dimension.${item.dimension}`)}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  // The labelled review workspace §5.1 requires. It must state that the curve is
  // exploratory, may be qualitatively wrong, and is not for clinical or forensic
  // decisions; it must itemise what is actually wrong; and only then may it offer
  // the acknowledgement. The button alone would be a click-through.
  //
  // The itemisation shows THIS MODEL'S OWN reasons rather than the translated
  // per-dimension copy the public disclosure uses. That copy is written for the
  // general (grade-C) case and here it would be materially false: it describes
  // uncertainty-semantics as a band whose "probability meaning is not established",
  // when a derived model emits no band at all, and parameter-provenance as a value
  // tracing "to a study or table", when the honest statement is that it traces to
  // nothing checkable. A reviewer cannot give informed consent to a paraphrase that
  // is wrong. The scorer's text is English audit prose, which is the right register
  // for a reviewer-only surface even in a bilingual app.
  if (disposition === 'acknowledge-in-review-workspace') {
    const stated = statedDimensions(policy);
    return (
      <div className="space-y-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-xs text-amber-900 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-100">
        <div className="flex items-center gap-1.5 font-semibold">
          <ShieldAlert className="h-3.5 w-3.5" />
          {drugLabel ? `${drugLabel} — ` : ''}
          {t('modelGrade.reviewWorkspace')}
        </div>
        <p>{t('modelGrade.acknowledgementRequired')}</p>
        <p className="font-medium">{t('modelGrade.acknowledgementWarning')}</p>
        {stated.length > 0 && (
          <ul className="list-disc space-y-0.5 pl-4">
            {stated.map((item) => (
              <li key={item.dimension}>
                <span className="font-medium">
                  {t(`modelGrade.dimension.${item.dimension}`)}
                </span>
                {' — '}
                {item.reason ?? t(`modelGrade.dimensionWhy.${item.dimension}`)}
              </li>
            ))}
          </ul>
        )}
        {simplificationNotes}
        {onAcknowledge && (
          <Button size="sm" variant="outline" onClick={onAcknowledge}>
            {t('modelGrade.acknowledgeAction')}
          </Button>
        )}
      </div>
    );
  }

  const grade = policy.grade === 'ungraded' ? null : policy.grade;
  if (!grade) return null;

  return (
    <div className="space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        {drugLabel && <span className="font-medium">{drugLabel}</span>}
        <span
          className={`rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide ${GRADE_STYLES[grade]}`}
        >
          {t('modelGrade.badge', { grade })}
        </span>
        <span className="text-muted-foreground">
          {t(`modelGrade.meaning.${grade}`)}
        </span>
      </div>

      {/* A curve on screen only because this reviewer accepted it says so, and
          offers the way back. Without this the acknowledgement is invisible and
          irreversible: the model would look ordinarily renderable from here on. */}
      {acknowledged && (
        <div className="flex flex-wrap items-center gap-1.5 text-amber-800 dark:text-amber-200">
          <ShieldAlert className="h-3 w-3 flex-shrink-0" />
          {/* The record §5.1 asks for, shown back: actor (you), time, and the evidence
              version it was filed against. The figures do not leave this workspace —
              an export withholds them (`admitsExport`) — so the reminder matters. */}
          <span>
            {acknowledgedAt
              ? t('modelGrade.acknowledgedByYouAt', {
                  time: new Date(acknowledgedAt).toLocaleString(),
                })
              : t('modelGrade.acknowledgedByYou')}
          </span>
          {onWithdraw && (
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1.5 text-[11px]"
              onClick={onWithdraw}
            >
              {t('modelGrade.withdrawAction')}
            </Button>
          )}
        </div>
      )}

      {policy.disclosable.length > 0 && (
        <>
          <div className="flex items-center gap-1 text-muted-foreground">
            <Info className="h-3 w-3 flex-shrink-0" />
            {t('modelGrade.whyHeading')}
          </div>
          <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
            {policy.disclosable.map((item) => (
              <li key={item.dimension}>
                <span className="font-medium">
                  {t(`modelGrade.dimension.${item.dimension}`)}
                </span>
                {' — '}
                {t(`modelGrade.dimensionWhy.${item.dimension}`)}
              </li>
            ))}
          </ul>
          {simplificationNotes.length > 0 && (
            <div className="text-muted-foreground">{simplificationNotes}</div>
          )}
          {/* Amendment 1 condition 3: while uncertainty semantics score below B
              the bands may not be called a confidence or prediction interval
              anywhere. Saying so once, at the curve, is the honest version. */}
          {policy.disclosable.some(
            (item) => item.dimension === 'uncertainty-semantics',
          ) && (
            <p className="text-muted-foreground">
              {t(
                hasBand
                  ? 'modelGrade.plausibleRange'
                  : 'modelGrade.noBandReported',
              )}
            </p>
          )}
        </>
      )}
    </div>
  );
}
