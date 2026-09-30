import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { PendingEditRow } from '@/lib/pendingEditsApi';
import {
  REFERENCE_MATRIX_LABEL_KEYS,
  REFERENCE_SCENARIO_LABEL_KEYS,
  type ReferenceMatrix,
  type ReferenceScenario,
} from '@/lib/referenceConcentrations';
import {
  getParameterLabelKey,
  isDrugParameterId,
} from '@/lib/drugParameters';
import {
  effectiveProposalReferenceIds,
  inspectParameterEntryPayload,
  sourceQuoteComparisonKey,
  sourceQuoteEvidenceUnchanged,
  type ParameterEntryPayloadCode,
} from '@/lib/parameterEntries';
import { ROUTE_LABEL_KEYS } from '@/lib/routeLabels';
import type { RouteId } from '@/lib/kinetics-core';
import { isQualifierOperator } from '@/types';
import {
  canonicalizeReportedStatistic,
  type DoseContextFields,
} from '@/lib/entryDoseContext';
import { DoseContextDetails } from './DoseContextDetails';

/**
 * Extends the dose-context fields (Cmax dose-context RFC) so a proposal
 * carrying them is compared and rendered with them — see `DoseContextDetails`.
 */
export interface EntryFields extends DoseContextFields {
  parameter?: string;
  low?: number | null;
  high?: number | null;
  median?: number | null;
  qualifier?: string | null;
  /** The declared value for a model-structure axis (CV-1b); absent for numeric entries. */
  categoricalValue?: string | null;
  unit?: string;
  /** The administration route (a RouteId) for a per-route absorption/F entry (CV-2c-4); absent for a
   *  drug-level entry. */
  route?: string | null;
  // Null/absent for a parameter with no matrix or interpretive scenario.
  matrix?: string | null;
  scenario?: string | null;
  n?: number | null;
  comments?: string | null;
  /**
   * Facts about the reading itself (dose, fed/fasted state, population, assay
   * method) — part of what a stored source quote is evidence for, unlike
   * `comments` (curator commentary about the row).
   */
  observationContext?: string | null;
  /**
   * The verbatim text the value was read off. `citationId` says which document;
   * this says where in it, in the source's own words — which is the difference
   * between a reviewer checking that the citation exists and a reviewer
   * checking that the number is in it.
   */
  quote?: string | null;
  citationId?: number | null;
}

type EntryPayload =
  | { op: 'create'; input: EntryFields }
  | { op: 'update'; patch: EntryFields }
  | { op: 'delete' };

/**
 * `f` as one line for the value cell.
 *
 * `t` is passed in because a `qualifier` the schema refuses is still shown —
 * a reviewer deciding what to ask for has to see what the author wrote — and
 * the sentence that frames it is app chrome, so it goes through i18n like any
 * other. The FIELD inside it stays the payload key, untranslated: the refusal
 * banner above lists the same keys (#1202's convention — the localized
 * sentence says a rule is broken, the keys say where, in the words the author
 * sees in the proposed-value JSON), and the two lines must name the same
 * field the same way.
 */
function formatValue(f: EntryFields, t: TFunction): string {
  const unit = f.unit ? ` ${f.unit}` : '';
  // A censored threshold takes precedence so "< 120" (which may store
  // low = high = 120) is never shown as an exact 120–120 range. Only a real
  // comparison operator may do that: a `qualifier` holding prose is a payload
  // the approval refuses (the banner above names the field), and printing it
  // in front of the figure is exactly how one reached two approvals reading as
  // an ordinary value — while its single-value branch hid the low–high span
  // besides. Same rule as `formatRange` in rangeUtils.
  if (isQualifierOperator(f.qualifier)) {
    // A dose-context entry states its threshold as `centralValue`.
    const v = f.centralValue ?? f.high ?? f.median ?? f.low;
    return v != null ? `${f.qualifier} ${v}${unit}` : '—';
  }
  // A dose-context entry's reported central value (mean, median, …), with its
  // interval beside it; what each is, is shown on the statistic row.
  if (f.centralValue != null) {
    return f.low != null && f.high != null
      ? `${f.centralValue}${unit} (${f.low}–${f.high})`
      : `${f.centralValue}${unit}`;
  }
  const numbers =
    f.low != null && f.high != null
      ? // Equal bounds are one figure, not a 3.34–3.34 span (as `formatRange` does).
        f.low === f.high
        ? `${f.low}${unit}`
        : `${f.low}–${f.high}${unit}`
      : f.median != null
        ? `${f.median}${unit}`
        : f.low != null
          ? `≥ ${f.low}${unit}`
          : f.high != null
            ? `≤ ${f.high}${unit}`
            : '—';
  if (!f.qualifier) return numbers;
  return `${numbers} · ${t('review.paramEntry.rejectedField', {
    defaultValue: 'field {{field}}: "{{value}}"',
    field: 'qualifier',
    value: f.qualifier,
  })}`;
}

/**
 * The localized refusal behind each DB-free approval check, so the card can say
 * WHY a stored payload cannot be published. Same keys `PendingEditCard` maps
 * the server's codes to — the preflight and the approval refusal read alike.
 */
const PAYLOAD_PROBLEM_KEYS: Record<ParameterEntryPayloadCode, string> = {
  param_entry_invalid_payload: 'review.errors.paramEntryInvalidPayload',
  param_entry_target_mismatch: 'review.errors.paramEntryTargetMismatch',
  param_entry_invalid_for_parameter:
    'review.errors.paramEntryInvalidForParameter',
  param_entry_citation_mismatch: 'review.errors.paramEntryCitationMismatch',
};

/**
 * Warn on a proposal the approval will refuse, before the reviewer presses
 * approve rather than after.
 *
 * The details grid renders whatever the payload holds — a free-text
 * `qualifier` where the schema allows only `<`/`>`/`≤`/`≥` reads as an
 * ordinary value ("apparent Vd ... 3.34 L/kg") — so an unpublishable proposal
 * looked exactly like a publishable one right up to the refusal. This runs the
 * approval's own DB-free rules over the stored payload and names the problem
 * on the card instead.
 */
function PayloadProblem({ edit }: { edit: PendingEditRow }) {
  const { t } = useTranslation();
  // Only while the proposal can still be acted on: a decided row is history,
  // and a warning about publishing it would be noise (an approved payload was
  // valid when it was applied; a rejected one is closed).
  const open = edit.status !== 'approved' && edit.status !== 'rejected';
  const problem = open
    ? inspectParameterEntryPayload(
        {
          parameter: edit.parameter,
          targetId: edit.targetId,
          referenceIds: effectiveProposalReferenceIds(edit),
        },
        edit.proposedValue,
      )
    : null;
  if (!problem) return null;
  return (
    <div
      role="alert"
      className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
    >
      <p className="font-medium">
        {t('review.paramEntry.cannotPublish', {
          defaultValue: 'This proposal cannot be approved as it stands',
        })}
      </p>
      <p className="mt-0.5">{t(PAYLOAD_PROBLEM_KEYS[problem.code])}</p>
      {/* Which field, when the refusal names one. The payload keys themselves,
          not the validator's English prose: the sentence above says a rule is
          broken, this says where, in the same words the author sees in the
          proposed-value JSON — so the reviewer can say what to change without
          untranslated text on the card. */}
      {problem.fields.length > 0 ? (
        <p className="mt-0.5 text-destructive/80">
          {t('review.paramEntry.problemFields', {
            defaultValue: 'Fields to correct: {{fields}}',
            fields: problem.fields.join(', '),
          })}
        </p>
      ) : null}
    </div>
  );
}

function citationLabel(citation: {
  identifier: string;
  metadata: unknown;
}): string {
  const meta = citation.metadata;
  if (meta && typeof meta === 'object' && 'title' in meta) {
    const title = (meta as { title?: unknown }).title;
    if (typeof title === 'string' && title.trim()) return title;
  }
  return citation.identifier;
}

/**
 * Map `PendingEditRow.currentEntry` (the live row, hydrated server-side) into
 * the `EntryFields` shape `EntryDetails` renders. Exported so any caller that
 * needs to show the live entry — the review card here, and `ReturnDialog`'s
 * conflict-revision view (#1258) — reads the same fields the same way.
 */
export function entryFieldsFromCurrentEntry(
  currentEntry: NonNullable<PendingEditRow['currentEntry']>,
): EntryFields {
  return {
    parameter: currentEntry.parameter,
    low: currentEntry.low,
    high: currentEntry.high,
    median: currentEntry.median,
    qualifier: currentEntry.qualifier,
    categoricalValue: currentEntry.categoricalValue,
    unit: currentEntry.unit,
    route: currentEntry.route,
    matrix: currentEntry.matrix,
    scenario: currentEntry.scenario,
    n: currentEntry.n,
    comments: currentEntry.comments,
    observationContext: currentEntry.observationContext,
    quote: currentEntry.sourceQuote,
    citationId: currentEntry.citationId,
    // Flattened, because a proposal states these at the top level and the
    // quote-evidence comparison reads them there.
    ...(currentEntry.doseContext ?? {}),
  };
}

/**
 * The value/matrix/scenario/n/citation/observationContext/comments grid shared
 * by every op. Exported so `ReturnDialog`'s conflict-revision view can render
 * the SAME live entry the review card shows here, rather than a second,
 * drifting copy of the formatting (#1258).
 */
export function EntryDetails({
  fields,
  citation,
  quoteInherited,
  drugNames,
}: {
  fields: EntryFields;
  /** Full citation (delete/update) with a title; else the payload's raw id. */
  citation?: {
    id: number;
    identifier: string;
    metadata: unknown;
  } | null;
  /**
   * The quote shown is carried over from the live entry rather than written by
   * this proposal — say so, or a reviewer reads a sentence the author never
   * re-asserted as one they did.
   */
  quoteInherited?: boolean;
  /** Names for the drug ids the dose context points at (`doseContextDrugNames`). */
  drugNames?: Record<number, string>;
}) {
  const { t } = useTranslation();
  const citationId = citation?.id ?? fields.citationId ?? null;
  // A model-structure axis (CV-1b) carries a categorical value, not a numeric
  // range — show its localized label so a reviewer sees which shape they are
  // approving/changing/removing, not the numeric formatter's em dash.
  const valueDisplay =
    fields.categoricalValue != null && fields.categoricalValue !== ''
      ? t(`parameters.modelStructure.value.${fields.categoricalValue}`, {
          defaultValue: fields.categoricalValue,
        })
      : formatValue(fields, t);
  return (
    <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-0.5 text-xs">
      <dt className="text-muted-foreground">
        {t('review.paramEntry.value', { defaultValue: 'Value' })}
      </dt>
      <dd className="font-medium">{valueDisplay}</dd>
      {fields.route ? (
        <>
          <dt className="text-muted-foreground">
            {t('review.paramEntry.route', { defaultValue: 'Route' })}
          </dt>
          <dd>
            {ROUTE_LABEL_KEYS[fields.route as RouteId]
              ? t(ROUTE_LABEL_KEYS[fields.route as RouteId])
              : fields.route}
          </dd>
        </>
      ) : null}
      {fields.matrix ? (
        <>
          <dt className="text-muted-foreground">
            {t('review.paramEntry.matrix', { defaultValue: 'Matrix' })}
          </dt>
          <dd>
            {t(
              REFERENCE_MATRIX_LABEL_KEYS[fields.matrix as ReferenceMatrix] ??
                'parameterEntries.otherMatrix',
            )}
          </dd>
        </>
      ) : null}
      {fields.scenario ? (
        <>
          <dt className="text-muted-foreground">
            {t('review.paramEntry.scenario', { defaultValue: 'Scenario' })}
          </dt>
          <dd>
            {t(
              REFERENCE_SCENARIO_LABEL_KEYS[
                fields.scenario as ReferenceScenario
              ] ?? fields.scenario,
            )}
          </dd>
        </>
      ) : null}
      {fields.n != null ? (
        <>
          <dt className="text-muted-foreground">n</dt>
          <dd>{fields.n}</dd>
        </>
      ) : null}
      <DoseContextDetails fields={fields} drugNames={drugNames} />
      {citationId != null ? (
        <>
          <dt className="text-muted-foreground">
            {t('review.paramEntry.citation', { defaultValue: 'Source' })}
          </dt>
          <dd>
            <a
              href={`/references/${citationId}`}
              className="text-primary hover:underline"
            >
              {citation ? citationLabel(citation) : `#${citationId}`}
            </a>
          </dd>
        </>
      ) : null}
      {fields.quote ? (
        <>
          <dt className="text-muted-foreground">
            {t('review.paramEntry.quote', { defaultValue: 'Source quote' })}
          </dt>
          {/*
            Set as a quotation rather than another grid value, because a
            reviewer has to read it as the source's words and compare them
            against the number above. Rendering it like the rest of the
            metadata invites skimming past it, which is the behaviour this
            field exists to stop.
          */}
          <dd className="border-l-2 border-border pl-2 italic">
            {fields.quote}
            {quoteInherited ? (
              <span className="mt-0.5 block text-[11px] not-italic text-muted-foreground">
                {t('review.paramEntry.quoteKept', {
                  defaultValue: 'Kept from the current entry',
                })}
              </span>
            ) : null}
          </dd>
        </>
      ) : null}
      {fields.observationContext ? (
        <>
          <dt className="text-muted-foreground">
            {t('review.paramEntry.observationContext', {
              defaultValue: 'Observation context',
            })}
          </dt>
          <dd>{fields.observationContext}</dd>
        </>
      ) : null}
      {fields.comments ? (
        <>
          <dt className="text-muted-foreground">
            {t('review.paramEntry.comments', { defaultValue: 'Notes' })}
          </dt>
          <dd>{fields.comments}</dd>
        </>
      ) : null}
    </dl>
  );
}

/**
 * Review-queue renderer for a `param_entry` proposal. Shows the operation
 * (add / edit / remove), the target drug and parameter, and the proposed value
 * with its matrix, scenario, sample size, and citation — so a reviewer can
 * inspect the scientific data before approving. For a delete, the LIVE entry
 * being removed is shown (value, matrix, scenario, citation, comments) so a
 * reviewer never approves a removal blind.
 */
export function ParameterEntryDiff({ edit }: { edit: PendingEditRow }) {
  const { t } = useTranslation();
  const payload = edit.proposedValue as EntryPayload | null;
  if (!payload || typeof payload !== 'object' || !('op' in payload)) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('review.paramEntry.unavailable', {
          defaultValue: 'Proposal payload unavailable',
        })}
      </p>
    );
  }

  // In stored form: a dose-context entry's `median` shorthand is shown as the
  // labelled central value it will be written as, not as a bare median with an
  // empty statistic row.
  const fields: EntryFields = canonicalizeReportedStatistic(
    payload.op === 'create'
      ? payload.input
      : payload.op === 'update'
        ? payload.patch
        : {},
  );
  const paramId = fields.parameter ?? edit.parameter ?? '';
  const paramLabel = isDrugParameterId(paramId)
    ? t(getParameterLabelKey(paramId))
    : paramId;

  const opLabel =
    payload.op === 'create'
      ? t('review.paramEntry.create', { defaultValue: 'Add source value' })
      : payload.op === 'update'
        ? t('review.paramEntry.update', { defaultValue: 'Edit source value' })
        : t('review.paramEntry.delete', { defaultValue: 'Remove source value' });

  // The live entry a delete/update proposal acts on, hydrated server-side. Its
  // contents are what the reviewer is about to remove (delete) or replace
  // (update); showing them prevents approving a change to an opaque entry id.
  const currentEntry = edit.currentEntry;
  const currentFields: EntryFields | null = currentEntry
    ? entryFieldsFromCurrentEntry(currentEntry)
    : null;

  /**
   * What the entry will carry AFTER approval, not what the payload happens to
   * say. The editor omits an untouched quote on purpose and the update
   * preserves the stored one while the evidence it attests to is unchanged, so
   * rendering the sparse patch straight shows no quote on a proposal that keeps
   * one — a reviewer reads that as the quotation being removed, which is the
   * opposite of what approving it does. Resolved through the same predicate the
   * write uses, so the card and the write cannot disagree.
   *
   * Three cases, matching `effectiveQuoteExpr` on the write:
   *
   *  - omitted → the stored sentence carries over while the evidence holds;
   *  - an ECHO of the stored sentence → asserts nothing, so it is treated
   *    exactly as omission. Rendering it as a statement is the same lie in a
   *    quieter register: the write will clear it when the reading moved, and a
   *    reviewer would approve believing the provenance on the card survives;
   *  - a different sentence → the author's assertion about the new payload, so
   *    it is shown as written.
   *
   * An explicit `null` is the author removing the quote, and must keep showing
   * as removal.
   */
  const storedQuote = currentFields?.quote ?? null;
  const statedQuote =
    typeof fields.quote === 'string'
      ? sourceQuoteComparisonKey(fields.quote)
      : null;
  const echoesStoredQuote =
    statedQuote !== null &&
    storedQuote !== null &&
    statedQuote === sourceQuoteComparisonKey(storedQuote);
  const quoteUnstated = fields.quote === undefined || echoesStoredQuote;
  const inheritsQuote =
    payload.op === 'update' &&
    currentFields != null &&
    quoteUnstated &&
    storedQuote != null &&
    sourceQuoteEvidenceUnchanged(
      currentFields as unknown as Record<string, unknown>,
      fields as unknown as Record<string, unknown>,
    );
  const quoteFields: EntryFields = inheritsQuote
    ? { ...fields, quote: storedQuote }
    : // An echo the write will discard must not be displayed as provenance the
      // approval keeps.
      payload.op === 'update' && echoesStoredQuote
      ? { ...fields, quote: null }
      : fields;

  /**
   * `observationContext` has the same omission-means-preserve rule as the
   * quote (`updateParameterEntryRow`), but none of the quote's echo/staleness
   * complexity: an omitted value simply carries the stored one over,
   * unconditionally. Rendering the sparse patch straight would show the
   * context as gone on an update that never touched it — indistinguishable
   * from an explicit clear, which is exactly the ambiguity the write's
   * tri-state exists to avoid.
   */
  const inheritsObservationContext =
    payload.op === 'update' &&
    currentFields != null &&
    quoteFields.observationContext === undefined;
  const proposedFields: EntryFields = inheritsObservationContext
    ? { ...quoteFields, observationContext: currentFields.observationContext }
    : quoteFields;

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
        <span className="font-medium">{opLabel}</span>
        {edit.drugName ? (
          <span className="text-xs font-medium text-foreground">
            {edit.drugName}
          </span>
        ) : null}
        {paramLabel ? (
          <span className="text-xs text-muted-foreground">{paramLabel}</span>
        ) : null}
      </div>
      <PayloadProblem edit={edit} />
      {payload.op === 'delete' ? (
        currentFields ? (
          <div>
            <p className="mb-1 text-xs text-muted-foreground">
              {t('review.paramEntry.deleteContentsHint', {
                defaultValue: 'This source value will be removed:',
              })}
            </p>
            <EntryDetails
              fields={currentFields}
              citation={currentEntry?.citation}
              drugNames={edit.doseContextDrugNames}
            />
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('review.paramEntry.deleteHint', {
              defaultValue: 'Removes entry #{{id}} from this parameter.',
              id: edit.targetId ?? '?',
            })}
          </p>
        )
      ) : payload.op === 'update' && currentFields ? (
        // Show the live entry beside the proposal so a reviewer can see exactly
        // what changes (e.g. matrix or citation), not just the new value.
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {t('review.paramEntry.current', { defaultValue: 'Current' })}
            </p>
            <EntryDetails
              fields={currentFields}
              citation={currentEntry?.citation}
              drugNames={edit.doseContextDrugNames}
            />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {t('review.paramEntry.proposed', { defaultValue: 'Proposed' })}
            </p>
            <EntryDetails
              fields={proposedFields}
              quoteInherited={inheritsQuote}
              drugNames={edit.doseContextDrugNames}
            />
          </div>
        </div>
      ) : (
        <EntryDetails fields={fields} drugNames={edit.doseContextDrugNames} />
      )}
    </div>
  );
}

export default ParameterEntryDiff;
