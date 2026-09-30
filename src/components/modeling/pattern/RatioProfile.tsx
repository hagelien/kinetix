/**
 * The metabolite ratio profile (§9).
 *
 * A pure function of `RatioProfileViewModel` — the generalisation boundary. No
 * substance name, analyte abbreviation, ratio formula or numeric threshold
 * appears in this directory, and a test greps for exactly that (§4.1). Adding a
 * drug family must change nothing here.
 *
 * The design's own decisions are adopted as-is: no cards, hairline separation,
 * one shared log axis, the provisional tag, and degradation that is visible
 * rather than implied.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  AxisVM,
  SourceAmbiguityVM,
  ObservationRowVM,
  RatioGroupVM,
  RatioProfileViewModel,
  RatioRowVM,
} from '../../../lib/pattern/profileModel';
import type { ObservationEdit } from '../../../lib/pattern/buildProfile';
import { reportedDecimalsOf } from '../../../lib/pattern/format';
import { parseLocaleNumberDetailed } from '../../../lib/parseNumber';
import { RatioAxis } from './RatioAxis';
import { RatioTrack } from './RatioTrack';

interface Props {
  model: RatioProfileViewModel;
  /**
   * Called with a **patch** — the one field that changed, never the whole
   * record. The caller merges it into what it already holds; replacing wholesale
   * would drop every earlier selection on the next edit. Omitted, the fields
   * render read-only, which is what a report export wants.
   */
  onContextChange?: (patch: Record<string, string>) => void;
  /**
   * Same patch contract as `onContextChange`, for a measured value. Editing a
   * concentration and seeing the profile recompute without a submit is §10's
   * interaction criterion; the case itself stays authoritative until saved.
   *
   * The patch carries the precision as well as the number, because the two
   * cannot be recovered from each other: `1,50` and `1,5` parse identically and
   * say different things about the assay.
   */
  onObservationChange?: (patch: Record<string, ObservationEdit>) => void;
  /**
   * A concentration field holding text the engine cannot read, reported by id.
   *
   * The same channel `CaseEditor` uses, and for the same reason: the field
   * keeps the previous value underneath the draft, so a save while `1,500` is
   * on screen files the concentration the curator was replacing — and clicking
   * the button blurs the draft away before they can see that is what happened.
   * A screen with two entry surfaces needs both of them to reach the guard.
   */
  onDraftProblem?: (id: string, problem: boolean) => void;
}

export function RatioProfile({
  model,
  onContextChange,
  onObservationChange,
  onDraftProblem,
}: Props) {
  const { t } = useTranslation();

  return (
    <div className="mx-auto w-full max-w-[1000px] space-y-8 px-4 py-6">
      {model.provisional.anyProvisional && (
        <p className="text-sm text-[hsl(var(--muted-foreground))]">
          {t('pattern.profile.provisional.note', {
            count: model.provisional.provisionalCount,
            total: model.provisional.totalBands,
          })}
        </p>
      )}

      {/* Standing, and unconditional.
          The source walk and every ratio under it read the metabolite links the
          catalog happens to hold, and nothing certifies that set complete — the
          curator panel that once did was withdrawn as a manual step nobody
          performed. So the residual is stated rather than encoded in a status:
          it belongs *above* the per-module statements and outside their filter,
          because the case it qualifies most is the silent one, where no
          statement renders at all and an unrecorded metabolite is the whole of
          what is missing. */}
      <p className="text-sm text-[hsl(var(--muted-foreground))]">
        {t('pattern.profile.metaboliteCoverage.caveat')}
      </p>

      {/* One statement per module, because each is framed on its own parent.
          `not_applicable` has nothing to say and is dropped — unless the case
          names several modules, where the silence would hide which lineage the
          statement beside it is about. */}
      {model.sourceAmbiguities
        .filter(
          (ambiguity) => ambiguity.statusKind !== 'not_applicable' || ambiguity.framedOn !== null,
        )
        .map((ambiguity) => (
          <SourceAmbiguityStatement key={ambiguity.moduleId} ambiguity={ambiguity} />
        ))}

      <CaseData model={model} onContextChange={onContextChange} />
      <Observations
        model={model}
        onObservationChange={onObservationChange}
        onDraftProblem={onDraftProblem}
      />

      <section className="space-y-6">
        {/* The axis labels the tracks, so it has to occupy the track's column.
            Rendered across the section it would sit hundreds of pixels off the
            bands it describes at desktop widths, which reads as a second scale. */}
        <div className="grid grid-cols-1 gap-1 md:grid-cols-[240px_1fr_68px] md:gap-4">
          <div aria-hidden="true" className="hidden md:block" />
          <RatioAxis axis={model.axis} />
          <div aria-hidden="true" className="hidden md:block" />
        </div>
        {model.ratioGroups.map((group) => (
          <RatioGroup key={group.group} group={group} axis={model.axis} />
        ))}
        {/* §9.3 asks for both, and they answer different questions: each track
            names its own row for a reader moving through them one at a time,
            while the table is what makes several ratios comparable without
            sight of the grid. The redundancy is the point — one is narration,
            the other is navigation. */}
        <RatioTable model={model} />
      </section>

      <EvaluativeAssessment model={model} />
      <MethodDisclosure model={model} />
    </div>
  );
}

function SourceAmbiguityStatement({ ambiguity }: { ambiguity: SourceAmbiguityVM }) {
  const { t } = useTranslation();

  return (
    <section className="space-y-1 border-l-2 border-[hsl(var(--destructive))] pl-3">
      {ambiguity.statusKind !== 'not_applicable' && (
        <p className="text-sm font-medium">
          {t(`pattern.profile.sourceAmbiguity.${ambiguity.statusKind}`)}
        </p>
      )}
      {ambiguity.framedOn && (
        <p className="text-sm">
          {t('pattern.profile.sourceAmbiguity.framedOn', {
            substance: substanceName(t, ambiguity.framedOn),
          })}
        </p>
      )}
      {ambiguity.declared.length > 0 && (
        <p className="text-sm">
          {t('pattern.profile.sourceAmbiguity.declared', {
            substances: ambiguity.declared
              .map((exposure) => substanceName(t, exposure))
              .join(', '),
          })}
        </p>
      )}
      <ul className="space-y-0.5 text-sm text-[hsl(var(--muted-foreground))]">
        {ambiguity.candidates.map((candidate) => (
          <li key={`${candidate.pubchemCid}-${candidate.direction}`}>
            {t(`pattern.profile.sourceAmbiguity.role.${candidate.role}`, {
              substance: substanceName(t, candidate),
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A candidate's display name. Where no loaded module names the substance — the
 * ordinary case for an upstream source, which is the whole point of that walk —
 * it falls back to its identity rather than to an anonymous label, so two such
 * candidates cannot render as the same line.
 */
function substanceName(
  t: (key: string, options?: Record<string, unknown>) => string,
  ref: { labelKey: string; pubchemCid: number; slug?: string },
): string {
  // An empty key means no loaded module names this substance — the ordinary
  // case for an upstream candidate. Fall back to its own identity so two such
  // candidates never render as one line.
  if (ref.labelKey) return t(ref.labelKey);
  return ref.slug ?? t('pattern.profile.sourceAmbiguity.unnamedSubstance', { cid: ref.pubchemCid });
}

function CaseData({ model, onContextChange }: Props) {
  const { t } = useTranslation();

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{t('pattern.profile.caseData.title')}</h2>
      <dl className="divide-y divide-[hsl(var(--border-subtle))]">
        {model.contextFields.map((field) => (
          <div
            key={field.id}
            className="grid grid-cols-1 gap-1 py-[5px] text-sm md:grid-cols-[240px_1fr] md:gap-4"
          >
            <dt className="text-[hsl(var(--muted-foreground))]">{t(field.labelKey)}</dt>
            <dd
              className={
                field.state === 'missing'
                  ? 'text-[hsl(var(--destructive))]'
                  : field.state === 'assumed'
                    ? 'text-[hsl(var(--muted-foreground))]'
                    : ''
              }
            >
              {onContextChange ? (
                <select
                  className="w-full bg-transparent"
                  value={field.value}
                  aria-label={t(field.labelKey)}
                  onChange={(event) =>
                    onContextChange({ [field.id]: event.target.value })
                  }
                >
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {/* A label the app did not write, where the option was
                          not written by the app either: a co-medication
                          generated from the catalog names a substance the
                          catalog holds, and a message key for it would be a
                          second spelling of that name. */}
                      {option.label ?? t(option.labelKey)}
                      {option.labelSuffixKey ? ` (${t(option.labelSuffixKey)})` : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <>
                  {field.valueLabel ?? t(field.valueLabelKey)}
                  {field.valueLabelSuffixKey ? ` (${t(field.valueLabelSuffixKey)})` : ''}
                </>
              )}
              {/* The colour is the only thing distinguishing a stated answer
                  from an assumed or missing one, and colour is not information
                  a screen reader or a colour-blind reader receives (§9.3). */}
              <span className="sr-only"> ({t(`pattern.profile.caseData.state.${field.state}`)})</span>
            </dd>
          </div>
        ))}
      </dl>
      {model.contextSummary.missing > 0 && (
        <p className="text-xs text-[hsl(var(--destructive))]">
          {t('pattern.profile.caseData.missingCount', { count: model.contextSummary.missing })}
        </p>
      )}
    </section>
  );
}

function Observations({ model, onObservationChange, onDraftProblem }: Props) {
  const { t } = useTranslation();
  if (model.observations.length === 0 && model.specimenMetrics.length === 0) return null;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{t('pattern.profile.observations.title')}</h2>
      <dl className="divide-y divide-[hsl(var(--border-subtle))]">
        {model.observations.map((observation) => {
          // Never the observation id: on a stored case that is a UUID, which
          // names nothing a reader recognises. Same fallback the source
          // candidates use, for the same reason — a panel routinely reports
          // substances no loaded module declares.
          const name = substanceName(t, observation);
          const label = `${name} — ${observation.specimenLabel}`;
          return (
            <div
              key={observation.id}
              className="grid grid-cols-1 gap-1 py-[5px] text-sm md:grid-cols-[240px_1fr] md:gap-4"
            >
              <dt className="text-[hsl(var(--muted-foreground))]">{label}</dt>
              <dd className="tabular-nums">
                {/* The model carries a value only for a quantified result, so
                    a censored one falls through to the qualifier and its
                    threshold — which are what the laboratory actually
                    reported. */}
                {onObservationChange && observation.value !== undefined ? (
                  <ObservationInput
                    observation={observation}
                    label={label}
                    onObservationChange={onObservationChange}
                    onDraftProblem={onDraftProblem}
                  />
                ) : (
                  <ObservationValue observation={observation} />
                )}
              </dd>
            </div>
          );
        })}
        {/* The measurement every normalised value is computed from. Shown with
            the observations rather than in the method line, because it is a
            property of a specimen in this case and not of the method. */}
        {model.specimenMetrics.map((metric) => (
          <div
            key={`${metric.specimenId}-${metric.labelKey}`}
            className="grid grid-cols-1 gap-1 py-[5px] text-sm md:grid-cols-[240px_1fr] md:gap-4"
          >
            <dt className="text-[hsl(var(--muted-foreground))]">
              {t(metric.labelKey)} — {metric.specimenLabel}
            </dt>
            <dd className="tabular-nums">
              {metric.valueText} {metric.unit}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * An editable concentration.
 *
 * The keystroke and the accepted value are deliberately separate states. The
 * model only ever holds a value the engine would compute from, so a cleared or
 * half-typed field has nowhere to live there — and a controlled input whose
 * `value` comes straight from the model snaps back to the previous number the
 * moment the field is emptied, which makes retyping one impossible. The draft
 * holds what was typed; the patch is emitted only for entries that are
 * measurements, and the draft is dropped on blur so the field returns to
 * whatever the case actually holds.
 */
function ObservationInput({
  observation,
  label,
  onObservationChange,
  onDraftProblem,
}: {
  observation: ObservationRowVM;
  label: string;
  onObservationChange: (patch: Record<string, ObservationEdit>) => void;
  onDraftProblem?: (id: string, problem: boolean) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<'invalid' | 'ambiguous' | null>(null);
  const messageId = `${observation.id}-entry-problem`;
  // Reported up, because a rejected entry has to reach the Save button. The
  // field keeps the old concentration underneath the draft — that is what lets
  // a reader retype one — so a save while `1,500` is on screen files the value
  // the curator was replacing, and clicking the button blurs the draft away
  // before they can see that is what happened.
  const report = onDraftProblem;
  const id = observation.id;
  // A cleared field blocks too, though it shows no message. The editor can
  // answer an emptied number by clearing the case's own — the case is allowed
  // to hold nothing there — but a concentration reached through the profile has
  // no such patch: the observation goes on holding the number being replaced.
  // So a blank field is a screen and a case that disagree, and saving into it
  // files the value the curator was in the middle of removing.
  const blocking = problem !== null || (draft !== null && draft.trim() === '');
  useEffect(() => report?.(id, blocking), [report, id, blocking]);
  // And the row's problem leaves with the row: a field unmounted mid-edit —
  // another case opened, the module scope changed — would otherwise hold the
  // save closed on behalf of an input nobody can see or correct.
  useEffect(() => () => report?.(id, false), [report, id]);

  return (
    // A wrapping `<label>` rather than `aria-label` (§9.3): it gives the field
    // an accessible name *and* a click target, and it keeps the name visible to
    // a reader who is not using assistive technology at all.
    <label>
      <span className="sr-only">{label}</span>
      <input
        // Text, not `number`: the field displays and accepts the reader's own
        // decimal separator, and a `number` control rejects a comma outright —
        // so a Norwegian reader retyping the value they can see would have it
        // silently discarded.
        type="text"
        inputMode="decimal"
        className="w-28 bg-transparent"
        value={draft ?? observation.editText ?? String(observation.value ?? '')}
        aria-invalid={problem !== null}
        aria-describedby={problem ? messageId : undefined}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          // A cleared field is a blank editing state, not a measurement of zero,
          // and it is not an error either — it is what a field looks like
          // mid-retype.
          const trimmed = raw.trim();
          if (trimmed === '') {
            setProblem(null);
            return;
          }
          const parsed = parseLocaleNumberDetailed(trimmed);
          if (!parsed.ok) {
            // `1,500` is 1.5 or 1500 depending on the reader, and the parser
            // refuses to pick. On a forensic concentration that guess is a
            // 1000× error, so the entry is rejected visibly rather than
            // resolved quietly.
            setProblem(parsed.reason);
            return;
          }
          if (parsed.value < 0) {
            setProblem('invalid');
            return;
          }
          setProblem(null);
          onObservationChange({
            [observation.id]: {
              value: parsed.value,
              reportedDecimals: reportedDecimalsOf(trimmed),
            },
          });
        }}
        onBlur={() => {
          setDraft(null);
          setProblem(null);
        }}
      />{' '}
      <span className="text-[hsl(var(--muted-foreground))]">{observation.unit}</span>
      {problem && (
        <span id={messageId} className="ml-2 text-xs text-[hsl(var(--destructive))]">
          {t(`pattern.profile.observations.entry.${problem}`)}
        </span>
      )}
    </label>
  );
}

/**
 * A measured value, or what the laboratory reported instead of one.
 *
 * A censored result carries its meaning in the qualifier and the threshold, not
 * in a number: rendering an em dash would make a non-detect, a `<LOQ` and a
 * measurement nobody entered look identical.
 */
function ObservationValue({
  observation,
}: {
  observation: RatioProfileViewModel['observations'][number];
}) {
  const { t } = useTranslation();

  if (observation.value !== undefined) {
    return (
      <span>
        {observation.valueText ?? observation.value} {observation.unit}
      </span>
    );
  }

  const qualifier = t(`pattern.profile.qualifier.${observation.qualifier}`);
  if (!observation.limit) return <span>{qualifier}</span>;

  return (
    <span>
      {qualifier} {observation.limit.valueText} {observation.limit.unit}{' '}
      <span className="text-[hsl(var(--muted-foreground-faint))]">
        ({observation.limit.label})
      </span>
    </span>
  );
}

/**
 * The ratio section as a table, for readers who cannot see the grid (§9.3).
 *
 * Every fact the picture carries has to be here, because a reader who cannot
 * see the grid gets the ratios only as a sequence of separate images otherwise:
 * the value on each basis, the band, the notes a row shows in prose, and — the
 * one a sighted reader takes from geometry alone — whether the marker sits
 * where it does because the result is off the axis.
 */
function RatioTable({ model }: Props) {
  const { t } = useTranslation();
  // Flattened, so the group each row belongs to has to travel with it: the
  // heading above the tracks is a fact the picture carries, and which matrix a
  // ratio is from is the one this section is organised around.
  const rows = model.ratioGroups.flatMap((group) =>
    group.rows.map((row) => ({ row, headingKey: group.headingKey })),
  );
  if (rows.length === 0) return null;

  return (
    <table className="sr-only">
      <caption>{t('pattern.profile.table.title')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('pattern.profile.table.feature')}</th>
          <th scope="col">{t('pattern.profile.table.group')}</th>
          <th scope="col">{t('pattern.profile.table.value')}</th>
          <th scope="col">{t('pattern.profile.table.normalized')}</th>
          <th scope="col">{t('pattern.profile.table.band')}</th>
          <th scope="col">{t('pattern.profile.table.notes')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ row, headingKey }) => (
          <tr key={row.featureId}>
            {/* The row header stays first, so a screen reader announces the
                ratio before what qualifies it. */}
            <th scope="row">{t(row.labelKey)}</th>
            <td>{t(headingKey)}</td>
            <td>{row.valueText}</td>
            <td>{row.normalizedValueText ?? t('pattern.profile.table.none')}</td>
            <td>{bandDescription(t, row)}</td>
            <td>{rowNotes(t, row).join(' ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Everything a row states in prose, plus the clamp direction — which a sighted
 * reader takes from where the marker sits and nobody else gets at all.
 */
function rowNotes(
  t: (key: string, options?: Record<string, unknown>) => string,
  row: RatioRowVM,
): string[] {
  const notes: string[] = [];
  if (row.basisKey) notes.push(t(row.basisKey));
  if (row.kindNoteKey) notes.push(t(row.kindNoteKey));
  // The table is the whole profile for a reader who never sees the tracks, so
  // a qualifier that changes how a number reads has to be in it.
  if (row.expectedDirection) notes.push(t(`pattern.profile.expected.${row.expectedDirection}`));
  if (row.bandWithheldNoteKey) notes.push(t(row.bandWithheldNoteKey));
  notes.push(...row.artefactNoteKeys.map((key) => t(key)));
  notes.push(...row.warnings.map((warning) => t(warning.messageKey)));
  if (row.marker?.isZero) notes.push(t('pattern.profile.track.outOfAxis.zero'));
  for (const direction of [row.marker?.outOfAxis, row.marker?.endOutOfAxis]) {
    if (direction) notes.push(t(`pattern.profile.track.outOfAxis.${direction}`));
  }
  return notes;
}

function RatioGroup({ group, axis }: { group: RatioGroupVM; axis: AxisVM }) {
  const { t } = useTranslation();

  return (
    <section className="space-y-1">
      {/* The heading is what tells a reader which matrix the rows below are
          from. Without it the note has to carry the matrix as well as the
          dilution regime, and a reader scanning the tracks has nothing to
          anchor a ratio to but its label. */}
      <h2 className="text-sm font-semibold">{t(group.headingKey)}</h2>
      <p className="text-xs text-[hsl(var(--muted-foreground-faint))]">
        {t(group.regimeNoteKey)}
      </p>
      <div className="divide-y divide-[hsl(var(--border-subtle))]">
        {group.rows.map((row) => (
          <RatioRow key={row.featureId} row={row} axis={axis} />
        ))}
      </div>
      {group.withdrawnNoteKeys.map((key) => (
        <p key={key} className="pt-1 text-xs text-[hsl(var(--muted-foreground))]">
          {t(key)}
        </p>
      ))}
    </section>
  );
}

/**
 * What to say about a row's reference band.
 *
 * `noBand` is a claim that none exists, and a withheld band is the opposite
 * case: one exists and cannot be compared with this case. The row's notes
 * already draw that distinction, so saying "no reference band" here made the
 * two halves of the same row contradict each other — in the table cell and in
 * the track's accessible name, which are exactly the two places a reader who
 * cannot see the hatching depends on.
 */
function bandDescription(
  t: (key: string, options?: Record<string, unknown>) => string,
  row: RatioRowVM,
): string {
  if (row.band) {
    return t('pattern.profile.track.band', {
      low: row.band.p5Text,
      median: row.band.p50Text,
      high: row.band.p95Text,
    });
  }
  return row.bandWithheldNoteKey
    ? t(row.bandWithheldNoteKey)
    : t('pattern.profile.track.noBand');
}

/**
 * The track's accessible name.
 *
 * `role="img"` collapses the graphic into one accessibility object, so every
 * fact the picture conveys has to be in this string or it is lost. That
 * includes the one a clamped marker conveys only by being slightly wider: a
 * result drawn at the rim because it is off the axis is indistinguishable, both
 * visually and here, from one that genuinely sits at the boundary.
 */
function trackLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  row: RatioRowVM,
): string {
  const description = t('pattern.profile.track.description', {
    feature: t(row.labelKey),
    value:
      row.plottedBasis === 'normalized' && row.normalizedValueText
        ? row.normalizedValueText
        : row.valueText,
    band: bandDescription(t, row),
  });

  if (row.marker?.isZero) return `${description} ${t('pattern.profile.track.outOfAxis.zero')}`;

  // Both endpoints, and de-duplicated: an interval can leave the axis at each
  // end, and one that leaves at only its far end used to say nothing at all.
  const clamped = [row.marker?.outOfAxis, row.marker?.endOutOfAxis]
    .filter((direction): direction is 'low' | 'high' => Boolean(direction))
    .filter((direction, index, all) => all.indexOf(direction) === index);
  if (clamped.length === 0) return description;

  return [description, ...clamped.map((d) => t(`pattern.profile.track.outOfAxis.${d}`))].join(' ');
}

function RatioRow({ row, axis }: { row: RatioRowVM; axis: AxisVM }) {
  const { t } = useTranslation();
  const label = t(row.labelKey);

  // Stacked below the design's ~820 px collapse: at 320–360 px the fixed
  // three-column rhythm cannot fit its own minimums, so the row would overflow
  // sideways rather than reflow.
  return (
    <div className="grid grid-cols-1 items-center gap-1 py-[5px] md:grid-cols-[240px_1fr_68px] md:gap-4">
      <div className="min-w-0">
        <p className="truncate text-sm">{label}</p>
        {/* The basis states what the quantity is. For a branch ratio it also
            carries the standing caveat that a position in a distribution cannot
            separate interaction, genotype and timing — §3.3's rewording, which
            exists precisely to be read. */}
        {row.basisKey && (
          <p className="text-xs text-[hsl(var(--muted-foreground))]">{t(row.basisKey)}</p>
        )}
        {row.kindNoteKey && (
          <p className="text-xs text-[hsl(var(--muted-foreground-faint))]">
            {t(row.kindNoteKey)}
          </p>
        )}
        {/* What the case's own context says about this ratio: a selected
            co-medication, a genotype. Stated on the row rather than folded
            into the value, because it is not a correction — the number is what
            it is, and this is the second explanation for it. */}
        {row.expectedDirection && (
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            {t(`pattern.profile.expected.${row.expectedDirection}`)}
          </p>
        )}
        {row.artefactNoteKeys.map((key) => (
          <p key={key} className="text-xs text-[hsl(var(--destructive))]">
            {t(key)}
          </p>
        ))}
        {row.warnings.map((warning) => (
          <p key={warning.code} className="text-xs text-[hsl(var(--muted-foreground))]">
            {t(warning.messageKey)}
          </p>
        ))}
        {row.bandWithheldNoteKey && (
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            {t(row.bandWithheldNoteKey)}
          </p>
        )}
      </div>
      <RatioTrack
        band={row.band}
        marker={row.marker}
        parityPct={axis.parityPct}
        label={trackLabel(t, row)}
      />
      {/* Raw and normalised are materially different numbers on a cross-matrix
          row, and §3.4 asserts neither is the correct one — so neither may be
          left for the reader to identify by position. Which one the track plots
          follows the band's basis, and the cell names it rather than assuming. */}
      <div className="text-left text-sm tabular-nums md:text-right">
        <span
          title={
            row.normalizedValueText && row.plottedBasis === 'raw'
              ? t('pattern.profile.value.rawPlotted')
              : undefined
          }
        >
          {row.normalizedValueText && (
            <span className="mr-1 text-xs text-[hsl(var(--muted-foreground-faint))]">
              {t('pattern.profile.value.raw')}
            </span>
          )}
          {row.valueText}
        </span>
        {row.normalizedValueText && (
          <span
            className="block text-xs text-[hsl(var(--muted-foreground))]"
            title={
              row.plottedBasis === 'normalized'
                ? t('pattern.profile.value.normalizedPlotted')
                : undefined
            }
          >
            <span className="mr-1 text-[hsl(var(--muted-foreground-faint))]">
              {t('pattern.profile.value.normalized')}
            </span>
            {row.normalizedValueText}
          </span>
        )}
      </div>
    </div>
  );
}

function EvaluativeAssessment({ model }: Props) {
  const { t } = useTranslation();
  if (model.signals.length === 0 && model.notEstablished.length === 0) return null;

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold">{t('pattern.profile.assessment.title')}</h2>

      {model.signals.map((signal) => (
        <article key={signal.id} className="space-y-1 border-t border-[hsl(var(--border-subtle))] pt-3">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-medium">{t(signal.titleKey)}</h3>
            {/* Grade qualifies everything below it: a validated cut-off and an
                exploratory interpretation must not look alike. */}
            <span className="text-[11px] uppercase tracking-wide text-[hsl(var(--muted-foreground-faint))]">
              {t(`pattern.profile.grade.${signal.grade}`)}
            </span>
          </div>
          <p className="text-xs text-[hsl(var(--muted-foreground))]">{t(signal.basisKey)}</p>
          {/* Both propositions, always. "Moderate support for Hp" is not a
              conclusion anybody can read without knowing what Hp says, and the
              side a strength points at is the whole content of the finding. */}
          <dl className="text-xs text-[hsl(var(--muted-foreground))]">
            <div className="flex gap-2">
              <dt className="font-medium">{t('pattern.profile.assessment.hp')}</dt>
              <dd>{t(signal.propositionHpKey)}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="font-medium">{t('pattern.profile.assessment.hd')}</dt>
              <dd>{t(signal.propositionHdKey)}</dd>
            </div>
          </dl>
          <p className="text-sm">
            {signal.strength.kind === 'stated'
              ? t('pattern.profile.assessment.stated', {
                  strength: t(signal.strength.strengthKey),
                  side: signal.strength.side,
                })
              : t('pattern.profile.assessment.notCalculable', {
                  reason: t(signal.strength.reasonKey),
                })}
          </p>
          {signal.strength.kind === 'stated' && signal.strength.caveatKey && (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              {t(signal.strength.caveatKey)}
            </p>
          )}
          {signal.degradations.map((degradation, index) => (
            <p
              key={`${degradation.kind}-${degradation.shortKey ?? index}`}
              className="text-xs text-[hsl(var(--destructive))]"
            >
              {degradation.kind === 'source'
                ? t('pattern.profile.degradation.source')
                : t(
                    // An assumed answer and an unanswered field both degrade,
                    // and telling a reader a field "is not stated" when the
                    // screen shows a value for it would read as a bug rather
                    // than as the caveat it is.
                    degradation.state === 'assumed'
                      ? 'pattern.profile.degradation.assumedField'
                      : 'pattern.profile.degradation.field',
                    { field: degradation.shortKey ? t(degradation.shortKey) : '' },
                  )}
            </p>
          ))}
          {signal.attributionCaveat && (
            <p className="text-xs text-[hsl(var(--muted-foreground))]">
              {t('pattern.profile.degradation.attribution')}
            </p>
          )}
        </article>
      ))}

      {model.notEstablished.length > 0 && (
        <div className="space-y-2 border-t border-[hsl(var(--border-subtle))] pt-3">
          {/* A finding that makes no claim does not belong among rows that read
              as findings — it gets its own heading instead. */}
          <h3 className="text-sm font-medium">{t('pattern.profile.notEstablished.title')}</h3>
          {model.notEstablished.map((entry) => (
            <div key={entry.id}>
              <p className="text-sm">{t(entry.titleKey)}</p>
              <p className="text-xs text-[hsl(var(--muted-foreground))]">{t(entry.rationaleKey)}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function MethodDisclosure({ model }: Props) {
  const { t } = useTranslation();

  return (
    <section className="space-y-1 border-t border-[hsl(var(--border-subtle))] pt-3 text-xs text-[hsl(var(--muted-foreground))]">
      <h2 className="font-semibold">{t('pattern.profile.method.title')}</h2>
      {model.method.creatinineReferenceText !== undefined && model.method.normalizationBasisKey && (
        <p>
          {t(model.method.normalizationBasisKey, {
            reference: model.method.creatinineReferenceText,
          })}
        </p>
      )}
      {model.method.citations.length > 0 && (
        <p>
          {t('pattern.profile.method.citations')}{' '}
          {model.method.citations.map((c) => `${c.type.toUpperCase()} ${c.identifier}`).join(', ')}
        </p>
      )}
    </section>
  );
}
