/**
 * Entering a case (plan §10, Phase 1: specimen and observation entry).
 *
 * Separate from `RatioProfile`, which stays pure over the view model. This
 * writes the case; that one reads it.
 *
 * Three decisions shape everything here:
 *
 * **The schema is the only statement of what a case may be.** The problem list
 * is `patternCaseProblems` rendered, not a second set of rules written for the
 * screen. A screen with its own copy drifts, and the half that drifts is always
 * the unenforced one — so it would fall silent about a save the server still
 * refuses, which is the failure a curator cannot diagnose.
 *
 * **Ids are generated, never typed.** They are the key an edit is applied by
 * and the key an observation names its specimen with, and the schema refuses
 * duplicates — so a field inviting a curator to type one is a field inviting
 * the refusal.
 *
 * **A number keeps a draft while it is being typed.** The case holds only
 * values the engine can compute from, so a cleared or half-typed field has
 * nowhere to live there; a controlled input reading straight from the case
 * snaps back to the previous number the moment the field is emptied, which
 * makes retyping one impossible. Same lesson as the profile's own inline
 * entry, and the same locale-tolerant parse — `1,5` is what a Norwegian
 * curator types, and `1,500` is refused rather than guessed at, because that
 * guess is a 1000× error on a forensic concentration.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DrugSearchDropdown } from '@/components/DrugSearchDropdown';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { parseLocaleNumberDetailed } from '@/lib/parseNumber';
import { formatForEditing, reportedDecimalsOf } from '@/lib/pattern/format';
import { catalogHasMolecularWeight } from '@/lib/pattern/catalogAnalytes';
import { patternCaseProblems } from '@/lib/patternCases';
import type { PatternSubstanceModule } from '@/lib/pattern/substanceModules';
import { getAvailableConcentrationUnits, getAvailableDoseUnits } from '@/lib/unitConversion';
import type {
  PatternCaseData,
  PatternKnownExposure,
  PatternLimitRef,
  PatternMatrix,
  PatternMeasurandMode,
  PatternObservation,
  PatternObservationQualifier,
  PatternSpecimen,
} from '@/types/patternCase';

const MATRICES: readonly PatternMatrix[] = [
  'whole_blood',
  'femoral_blood',
  'cardiac_blood',
  'serum',
  'plasma',
  'urine',
  'vitreous',
  'other',
];

const QUALIFIERS: readonly PatternObservationQualifier[] = [
  'quantified',
  'below_limit',
  'above_limit',
  'detected_not_quantified',
  'not_detected',
];

/**
 * What the laboratory actually measured.
 *
 * Unset is a real answer and the one a new row starts on: it is `unknown` to
 * the engine, and the alternative is asserting a protocol nobody stated. Same
 * reasoning as the hydrolysis field defaulting to "not stated" rather than to
 * "none" (§3.3) — an assumption that strong is a missing datum, not a default.
 */
const MEASURAND_MODES: readonly PatternMeasurandMode[] = [
  'direct',
  'free',
  'direct_conjugate',
  'total_after_hydrolysis',
  'class_response',
  'unknown',
];

const CERTAINTIES: readonly PatternKnownExposure['certainty'][] = [
  'confirmed',
  'reported',
  'suspected',
];

const TIME_ORIGINS: readonly PatternCaseData['context']['timeOrigin'][] = [
  'first_specimen_collection',
  'declared_exposure',
  'death',
  'admission',
];

/**
 * The next free id under a prefix.
 *
 * Sequential rather than a UUID, because these ids are read: the schema's
 * refusals name them ("observation obs-3 is quantified but carries no value"),
 * and a curator can find `obs-3` on screen in a way they cannot find
 * `f47ac10b-…`. Collision-avoiding rather than count-based, because a removed
 * row would otherwise hand its number to the next one and two rows would share
 * an id — which the schema refuses, and which silently applies one edit to two
 * observations until it does.
 */
function freshId(prefix: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const candidate = `${prefix}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The threshold as the three controls leave it, or nothing at all.
 *
 * A limit is easy to start by accident — one keystroke in the label — and until
 * now there was no way back: the value control wrote `0` when cleared, which
 * the schema refuses, and no control removed the object. Deleting the whole
 * observation was the only route back to a censored result with no printed
 * threshold, which is a state laboratories produce all the time.
 */
function nextLimit(
  existing: PatternLimitRef | undefined,
  patch: Partial<PatternLimitRef> & { value?: number | undefined },
): PatternLimitRef | undefined {
  const label = patch.label ?? existing?.label ?? '';
  const unit = patch.unit ?? existing?.unit ?? '';
  const value = 'value' in patch ? patch.value : existing?.value;
  const decimals = 'reportedDecimals' in patch ? patch.reportedDecimals : existing?.reportedDecimals;
  // Zero counts as nothing typed here, not as a threshold of zero: the schema
  // refuses a non-positive limit, so a `0` with no name and no unit is the
  // placeholder this function wrote a moment ago rather than anything a
  // laboratory stated.
  if (label === '' && unit === '' && (value === undefined || value === 0)) return undefined;
  return {
    ...existing,
    label,
    unit,
    // Zero is a placeholder for "not typed yet", and the schema says so: a
    // reporting limit is a concentration a method can detect, and there is no
    // such thing as a non-positive one. The problem list names it while the row
    // is half entered.
    value: value ?? 0,
    reportedDecimals: decimals,
    source: existing?.source ?? 'manual',
  };
}

/** Drop cleared fields, so an emptied group does not persist as `{}`. */
function pruned<T extends object>(value: T): T | undefined {
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return entries.length === 0 ? undefined : (Object.fromEntries(entries) as T);
}

/**
 * A select's own options, plus whatever the case actually holds.
 *
 * A stored value outside the list leaves the control showing nothing while the
 * case goes on holding it — the screen says the unit is unset and the saved
 * bytes say `pmol/L`, and a curator who never touches that row files it again
 * unchanged. Imported cases and a vocabulary that has since been narrowed both
 * produce exactly that.
 *
 * The value is offered as itself rather than translated: the point is to show
 * what is there, and a label the app chose would be a second claim about a
 * unit it does not recognise.
 */
function withStoredOption(
  options: Array<{ value: string; label: string }>,
  stored: string | undefined,
): Array<{ value: string; label: string }> {
  if (!stored || options.some((option) => option.value === stored)) return options;
  return [...options, { value: stored, label: stored }];
}

function replaceAt<T>(list: readonly T[], index: number, next: T): T[] {
  return list.map((item, i) => (i === index ? next : item));
}

interface Props {
  caseData: PatternCaseData;
  /** Every module the app ships; the case names the ones in scope. */
  modules: readonly PatternSubstanceModule[];
  onChange: (next: PatternCaseData) => void;
  /**
   * Whether a field is holding text the case could not take.
   *
   * The problem list cannot say this: the case is *valid*, because the rejected
   * keystrokes never reached it. So the screen shows `1,500` in a field while
   * the case still holds the number it replaced, and a save filed at that
   * moment writes the old one — the one thing on this screen that would put a
   * concentration in a case that nobody typed. The page holds the save button,
   * so it has to be told.
   */
  onDraftProblem?: (problem: boolean) => void;
}

export function CaseEditor({ caseData, modules, onChange, onDraftProblem }: Props) {
  const { t } = useTranslation();
  // Which fields are mid-edit and unreadable, by field. A count would drift on
  // a field that reports twice; the set cannot.
  const [badDrafts, setBadDrafts] = useState<ReadonlySet<string>>(() => new Set());
  const noteDraft = useCallback((id: string, problem: boolean) => {
    setBadDrafts((previous) => {
      if (problem === previous.has(id)) return previous;
      const next = new Set(previous);
      if (problem) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const draftProblem = badDrafts.size > 0;
  useEffect(() => onDraftProblem?.(draftProblem), [draftProblem, onDraftProblem]);
  /**
   * The last catalog pick this screen turned away, and where it was made.
   *
   * Scoped to the control, because a message about a pick belongs beside the
   * pick: one editor renders many search fields, and a single shared message
   * would appear under an unrelated row — or, where that row does not exist,
   * nowhere at all, leaving a selection that silently did nothing.
   */
  const [refusedPick, setRefusedPick] = useState<{
    scope: string;
    name: string;
    reason: 'no_cid' | 'no_weight';
  } | null>(null);
  const problems = patternCaseProblems(caseData);

  const patch = (next: Partial<PatternCaseData>) => onChange({ ...caseData, ...next });
  const patchContext = (next: Partial<PatternCaseData['context']>) =>
    patch({ context: { ...caseData.context, ...next } });

  const specimenIds = new Set(caseData.specimens.map((specimen) => specimen.id));
  const observationIds = new Set(caseData.observations.map((observation) => observation.id));

  // The analytes a curator can pick are the ones the modules in scope declare
  // — but never *only* those: a stored case can name an analyte no loaded
  // module describes, and a select that dropped it would silently reassign the
  // measurement to whatever option happened to be first.
  const known = new Map<number, string>();
  for (const module of modules) {
    if (!caseData.moduleIds.includes(module.id)) continue;
    for (const analyte of module.analytes) known.set(analyte.analyte.pubchemCid, t(analyte.labelKey));
  }
  const remember = (drug: { pubchemCid: number; slug?: string }) => {
    if (known.has(drug.pubchemCid)) return;
    known.set(
      drug.pubchemCid,
      drug.slug ?? t('pattern.editor.observations.analyteUnknown', { cid: drug.pubchemCid }),
    );
  };
  for (const observation of caseData.observations) {
    remember(observation.analyte);
    // The mass basis too. It is a catalog identity like any other, and a case
    // reported on a substance outside the module would otherwise render a
    // blank select over an id that is very much in use — the molecular weight
    // every ratio from that row is computed with.
    const reportedAs = observation.assay?.reportedAsDrugId;
    if (reportedAs !== undefined) remember({ pubchemCid: reportedAs });
  }
  // Exposures too, and for a sharper reason than the observations: a declared
  // exposure is routinely a substance *no module describes* — an upstream
  // source drug is exactly what the source-ambiguity walk exists to consider.
  // Left out of the options, its select renders with a value it does not carry,
  // showing the first substance in the list while the case says another; the
  // next change to the row would then file that misreading.
  for (const exposure of caseData.context.knownExposures ?? []) remember(exposure.drug);
  const analyteOptions = [...known].map(([cid, label]) => ({ value: String(cid), label }));

  return (
    <div className="space-y-6">
      <Problems problems={problems} />

      <Section title={t('pattern.editor.modules.title')}>
        <p className="text-xs text-[hsl(var(--muted-foreground))]">
          {t('pattern.editor.modules.hint')}
        </p>
        <div className="flex flex-wrap gap-3">
          {/* Every module the app ships, and every one the case names. A stored
              id the app no longer ships has no checkbox of its own, so the case
              could not be edited out of naming it — while the profile stayed
              unavailable, since the graph endpoint has nothing to answer for a
              module it does not know. It is offered here, ticked, with its
              state said plainly, so a curator can take it off. */}
          {[
            ...modules.map((module) => ({ id: module.id, label: t(module.labelKey) })),
            ...caseData.moduleIds
              .filter((id) => !modules.some((module) => module.id === id))
              .map((id) => ({ id, label: t('pattern.editor.modules.retired', { moduleId: id }) })),
          ].map((module) => (
            <label key={module.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={caseData.moduleIds.includes(module.id)}
                onChange={(event) =>
                  patch({
                    moduleIds: event.target.checked
                      ? [...caseData.moduleIds, module.id]
                      : caseData.moduleIds.filter((id) => id !== module.id),
                  })
                }
              />
              {module.label}
            </label>
          ))}
        </div>
      </Section>

      <Section title={t('pattern.editor.context.title')}>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={caseData.context.postmortem}
              onChange={(event) =>
                patchContext(
                  event.target.checked
                    ? { postmortem: true }
                    : // A case that says nobody died cannot go on carrying the
                      // hour of the death. It is an instant on the case's axis,
                      // so it keeps anchoring the timeline — from a field the
                      // curator can no longer see, and therefore can no longer
                      // put right.
                      { postmortem: false, deathRelativeHours: undefined },
                )
              }
            />
            {t('pattern.editor.context.postmortem')}
          </label>
          <Field label={t('pattern.editor.context.timeOrigin')}>
            <Select
              value={caseData.context.timeOrigin}
              options={TIME_ORIGINS.map((origin) => ({
                value: origin,
                label: t(`pattern.editor.context.timeOriginOption.${origin}`),
              }))}
              onChange={(event) =>
                patchContext({
                  timeOrigin: event.target.value as PatternCaseData['context']['timeOrigin'],
                })
              }
            />
          </Field>
          {/* Only where death is on the axis at all. On a living case the field
              is not merely unused — filling it would place a death in a case
              that states there was none. */}
          {caseData.context.postmortem && (
            <NumberField
              label={t('pattern.editor.context.deathRelativeHours')}
              onDraftProblem={noteDraft}
              value={caseData.context.deathRelativeHours}
              onChange={(hours) => patchContext({ deathRelativeHours: hours })}
            />
          )}
          <NumberField
            label={t('pattern.editor.context.creatinineReference')}
            onDraftProblem={noteDraft}
            value={caseData.normalization.creatinineReferenceMmolL}
            onChange={(value) =>
              value !== undefined &&
              patch({ normalization: { creatinineReferenceMmolL: value } })
            }
          />
        </div>
      </Section>

      <Section
        title={t('pattern.editor.exposures.title')}
        onAdd={() =>
          patchContext({
            knownExposures: [
              ...(caseData.context.knownExposures ?? []),
              {
                id: freshId(
                  'exp',
                  new Set(
                    (caseData.context.knownExposures ?? [])
                      .map((exposure) => exposure.id)
                      .filter((id): id is string => id !== undefined),
                  ),
                ),
                drug: { pubchemCid: Number(analyteOptions[0]?.value ?? 0) },
                certainty: 'reported',
              },
            ],
          })
        }
        addLabel={t('pattern.editor.exposures.add')}
      >
        {/* Suggestions for the dose unit field below. One list for every row:
            they offer the same units, and a copy per exposure would be the
            same markup repeated for each. */}
        <datalist id="pattern-dose-units">
          {getAvailableDoseUnits().map((unit) => (
            <option key={unit} value={unit} />
          ))}
        </datalist>
        {(caseData.context.knownExposures ?? []).length === 0 && (
          <Empty>{t('pattern.editor.exposures.none')}</Empty>
        )}
        {(caseData.context.knownExposures ?? []).map((exposure, index) => {
          const exposures = caseData.context.knownExposures ?? [];
          const update = (next: PatternKnownExposure) =>
            patchContext({ knownExposures: replaceAt(exposures, index, next) });
          const exposureScope = `exposure-${exposure.id ?? index}`;
          return (
            <Row
              // The row's own id, not its position. Removing the first
              // exposure slides the second into index 0, where React hands it
              // the state of the row that just went — a half-typed dose from a
              // removed exposure showing over another's, and a refusal message
              // attached to the wrong picker.
              key={exposure.id ?? `exposure-${index}`}
              onRemove={() =>
                patchContext({ knownExposures: exposures.filter((_, i) => i !== index) })
              }
              removeLabel={t('pattern.editor.remove')}
            >
              <Field label={t('pattern.editor.observations.analyte')}>
                <Select
                  value={String(exposure.drug.pubchemCid)}
                  options={analyteOptions}
                  onChange={(event) =>
                    update({ ...exposure, drug: { pubchemCid: Number(event.target.value) } })
                  }
                />
              </Field>
              {/* And anything the catalog has. A module's analytes are the
                  substances it computes ratios from; what somebody took is not
                  bounded by them, and the interesting exposure for source
                  ambiguity is precisely the one outside the module. */}
              <Field label={t('pattern.editor.exposures.otherDrug')}>
                <DrugSearchDropdown
                  onSelect={(drug) => {
                    // Identity is the PubChem CID and never the slug (§16.5).
                    // A catalog entry without one cannot be named here at all,
                    // and picking it silently would file an exposure the engine
                    // cannot match to anything.
                    if (drug.pubchemCid === undefined) {
                      setRefusedPick({
                        scope: exposureScope,
                        name: drug.names.nb ?? drug.names.en ?? drug.id,
                        reason: 'no_cid',
                      });
                      return;
                    }
                    setRefusedPick(null);
                    update({ ...exposure, drug: { pubchemCid: drug.pubchemCid } });
                  }}
                />
                <RefusedPick refused={refusedPick} scope={exposureScope} />
              </Field>
              <Field label={t('pattern.editor.exposures.certainty')}>
                <Select
                  value={exposure.certainty}
                  options={CERTAINTIES.map((certainty) => ({
                    value: certainty,
                    label: t(`pattern.editor.exposures.certaintyOption.${certainty}`),
                  }))}
                  onChange={(event) =>
                    update({
                      ...exposure,
                      certainty: event.target.value as PatternKnownExposure['certainty'],
                    })
                  }
                />
              </Field>
              <Field label={t('pattern.editor.exposures.route')}>
                <Input
                  value={exposure.route ?? ''}
                  onChange={(event) =>
                    update({ ...exposure, route: event.target.value || undefined })
                  }
                />
              </Field>
              <NumberField
                label={t('pattern.editor.exposures.amount')}
                onDraftProblem={noteDraft}
                value={exposure.amount}
                onChange={(amount) => update({ ...exposure, amount })}
              />
              {/* Typed, not picked from a list of three. The case contract has
                  this as free text because an account states what it states —
                  `mg/kg` is the ordinary way to give a weight-normalised dose,
                  and a select offering absolute units only would leave a
                  curator no way to record it and show a stored one as an empty
                  control while the case went on holding it. Nothing computes
                  from a dose here, so there is no vocabulary to protect; the
                  suggestions are the app's dose units, offered rather than
                  imposed. */}
              <Field label={t('pattern.editor.exposures.amountUnit')}>
                <Input
                  list="pattern-dose-units"
                  value={exposure.amountUnit ?? ''}
                  onChange={(event) =>
                    update({ ...exposure, amountUnit: event.target.value || undefined })
                  }
                />
              </Field>
              <NumberField
                label={t('pattern.editor.exposures.time')}
                onDraftProblem={noteDraft}
                value={exposure.timeRelativeHours}
                onChange={(hours) => update({ ...exposure, timeRelativeHours: hours })}
              />
              {/* The window, for the intake that was never a point. Both ends
                  or neither: half a window states nothing the other half does
                  not, and the schema would refuse the pair anyway. */}
              <NumberField
                label={t('pattern.editor.exposures.rangeFrom')}
                onDraftProblem={noteDraft}
                value={exposure.timeRangeHours?.[0]}
                onChange={(hours) =>
                  update({
                    ...exposure,
                    timeRangeHours:
                      hours === undefined
                        ? undefined
                        : [hours, exposure.timeRangeHours?.[1] ?? hours],
                  })
                }
              />
              <NumberField
                label={t('pattern.editor.exposures.rangeTo')}
                onDraftProblem={noteDraft}
                value={exposure.timeRangeHours?.[1]}
                onChange={(hours) =>
                  update({
                    ...exposure,
                    timeRangeHours:
                      hours === undefined
                        ? undefined
                        : [exposure.timeRangeHours?.[0] ?? hours, hours],
                  })
                }
              />
            </Row>
          );
        })}
      </Section>

      <Section
        title={t('pattern.editor.specimens.title')}
        onAdd={() =>
          patch({
            specimens: [
              ...caseData.specimens,
              { id: freshId('spm', specimenIds), matrix: 'whole_blood' },
            ],
          })
        }
        addLabel={t('pattern.editor.specimens.add')}
      >
        {caseData.specimens.length === 0 && <Empty>{t('pattern.editor.specimens.none')}</Empty>}
        {caseData.specimens.map((specimen, index) => {
          const update = (next: PatternSpecimen) =>
            patch({ specimens: replaceAt(caseData.specimens, index, next) });
          const attached = caseData.observations.filter(
            (observation) => observation.specimenId === specimen.id,
          ).length;
          return (
            <Row
              key={specimen.id}
              heading={specimen.label || specimen.id}
              // Removing a specimen never removes measurements. Deleting
              // results as a side effect of tidying up a container is the
              // silent loss this screen exists to avoid, so the button says
              // what is in the way instead.
              onRemove={
                attached === 0
                  ? () => patch({ specimens: caseData.specimens.filter((_, i) => i !== index) })
                  : undefined
              }
              removeLabel={t('pattern.editor.remove')}
              removeBlockedLabel={t('pattern.editor.specimens.removeBlocked', { count: attached })}
            >
              <Field label={t('pattern.editor.specimens.label')}>
                <Input
                  value={specimen.label ?? ''}
                  onChange={(event) =>
                    update({ ...specimen, label: event.target.value || undefined })
                  }
                />
              </Field>
              <Field label={t('pattern.editor.specimens.matrix')}>
                <Select
                  value={specimen.matrix}
                  options={MATRICES.map((matrix) => ({
                    value: matrix,
                    label: t(`pattern.editor.matrix.${matrix}`),
                  }))}
                  onChange={(event) =>
                    update({ ...specimen, matrix: event.target.value as PatternMatrix })
                  }
                />
              </Field>
              <NumberField
                label={t('pattern.editor.specimens.time')}
                onDraftProblem={noteDraft}
                value={specimen.relativeTimeHours}
                onChange={(hours) => update({ ...specimen, relativeTimeHours: hours })}
              />
              {/* Shown for a urine specimen, and for any specimen still
                  carrying urine data after its matrix changed: the schema
                  refuses that combination rather than deleting a measurement
                  behind the curator's back, so the fields have to stay
                  reachable for them to clear. */}
              {(specimen.matrix === 'urine' || specimen.urine !== undefined) && (
                <>
                  <NumberField
                    label={t('pattern.editor.specimens.creatinine')}
                    onDraftProblem={noteDraft}
                    value={specimen.urine?.creatinineMmolL}
                    onChange={(value) =>
                      update({
                        ...specimen,
                        urine: pruned({ ...specimen.urine, creatinineMmolL: value }),
                      })
                    }
                  />
                  <NumberField
                    label={t('pattern.editor.specimens.specificGravity')}
                    onDraftProblem={noteDraft}
                    value={specimen.urine?.specificGravity}
                    onChange={(value) =>
                      update({
                        ...specimen,
                        urine: pruned({ ...specimen.urine, specificGravity: value }),
                      })
                    }
                  />
                  <NumberField
                    label={t('pattern.editor.specimens.collectionDuration')}
                    onDraftProblem={noteDraft}
                    value={specimen.urine?.collectionDurationHours}
                    onChange={(value) =>
                      update({
                        ...specimen,
                        urine: pruned({ ...specimen.urine, collectionDurationHours: value }),
                      })
                    }
                  />
                  <NumberField
                    label={t('pattern.editor.specimens.lastVoid')}
                    onDraftProblem={noteDraft}
                    value={specimen.urine?.lastVoidRelativeHours}
                    onChange={(value) =>
                      update({
                        ...specimen,
                        urine: pruned({ ...specimen.urine, lastVoidRelativeHours: value }),
                      })
                    }
                  />
                </>
              )}
              {/* Only a postmortem case has an interval from death to
                  collection. Storage duration is not that: a sample from a
                  living patient can sit for weeks before analysis, and hiding
                  the field would leave the number stored where nobody could
                  correct it. */}
              {(caseData.context.postmortem ||
                specimen.postmortem?.postmortemIntervalHours !== undefined) && (
                <NumberField
                  label={t('pattern.editor.specimens.pmInterval')}
                  onDraftProblem={noteDraft}
                  value={specimen.postmortem?.postmortemIntervalHours}
                  onChange={(value) =>
                    update({
                      ...specimen,
                      postmortem: pruned({
                        ...specimen.postmortem,
                        postmortemIntervalHours: value,
                      }),
                    })
                  }
                />
              )}
              <NumberField
                label={t('pattern.editor.specimens.storageDuration')}
                onDraftProblem={noteDraft}
                value={specimen.postmortem?.storageDurationHours}
                onChange={(value) =>
                  update({
                    ...specimen,
                    postmortem: pruned({ ...specimen.postmortem, storageDurationHours: value }),
                  })
                }
              />
            </Row>
          );
        })}
      </Section>

      <Section
        title={t('pattern.editor.observations.title')}
        onAdd={
          caseData.specimens.length > 0
            ? () =>
                patch({
                  observations: [
                    ...caseData.observations,
                    {
                      id: freshId('obs', observationIds),
                      specimenId: caseData.specimens[0]!.id,
                      analyte: { pubchemCid: Number(analyteOptions[0]?.value ?? 0) },
                      qualifier: 'quantified',
                    },
                  ],
                })
            : undefined
        }
        addLabel={t('pattern.editor.observations.add')}
        addBlockedLabel={t('pattern.editor.observations.addBlocked')}
      >
        {caseData.observations.length === 0 && (
          <Empty>{t('pattern.editor.observations.none')}</Empty>
        )}
        {caseData.observations.map((observation, index) => {
          const update = (next: PatternObservation) =>
            patch({ observations: replaceAt(caseData.observations, index, next) });
          return (
            <Row
              key={observation.id}
              heading={observation.id}
              onRemove={() =>
                patch({ observations: caseData.observations.filter((_, i) => i !== index) })
              }
              removeLabel={t('pattern.editor.remove')}
            >
              <Field label={t('pattern.editor.observations.specimen')}>
                <Select
                  value={observation.specimenId}
                  options={caseData.specimens.map((specimen) => ({
                    value: specimen.id,
                    label: specimen.label || specimen.id,
                  }))}
                  onChange={(event) => update({ ...observation, specimenId: event.target.value })}
                />
              </Field>
              <Field label={t('pattern.editor.observations.analyte')}>
                <Select
                  value={String(observation.analyte.pubchemCid)}
                  options={analyteOptions}
                  onChange={(event) =>
                    update({ ...observation, analyte: { pubchemCid: Number(event.target.value) } })
                  }
                />
              </Field>
              {/* Which measurand this result is, and it is not decoration: the
                  hydrolysis question only reaches a case whose observations say
                  they were measured as a conjugate or after hydrolysis, and the
                  artefact rules that question exists for key on the same field.
                  Entered through a screen that could not say it, every
                  hand-typed case silently skipped both. */}
              <Field label={t('pattern.editor.observations.measurandMode')}>
                <Select
                  value={observation.assay?.measurandMode ?? ''}
                  options={[
                    { value: '', label: t('pattern.editor.observations.measurandUnset') },
                    ...MEASURAND_MODES.map((mode) => ({
                      value: mode,
                      label: t(`pattern.editor.observations.measurand.${mode}`),
                    })),
                  ]}
                  onChange={(event) =>
                    update({
                      ...observation,
                      assay: pruned({
                        ...observation.assay,
                        measurandMode: (event.target.value || undefined) as
                          | PatternMeasurandMode
                          | undefined,
                      }),
                    })
                  }
                />
              </Field>
              {/* Which substance's molecular weight the laboratory reported
                  this on. A conjugate quoted on its parent's basis converts
                  with the parent's weight, and using the analyte's own instead
                  is a systematically wrong molar concentration — a wrong ratio
                  with nothing on screen to show it. Shown for the modes where
                  that happens, and for any row that already carries one, so an
                  imported value is never active behind a hidden field. */}
              {(observation.assay?.measurandMode === 'direct_conjugate' ||
                observation.assay?.measurandMode === 'total_after_hydrolysis' ||
                observation.assay?.reportedAsDrugId !== undefined) && (
                <Field label={t('pattern.editor.observations.reportedAs')}>
                  <Select
                    value={
                      observation.assay?.reportedAsDrugId === undefined
                        ? ''
                        : String(observation.assay.reportedAsDrugId)
                    }
                    options={[
                      { value: '', label: t('pattern.editor.observations.reportedAsUnset') },
                      ...analyteOptions,
                    ]}
                    onChange={(event) =>
                      update({
                        ...observation,
                        assay: pruned({
                          ...observation.assay,
                          reportedAsDrugId: event.target.value
                            ? Number(event.target.value)
                            : undefined,
                        }),
                      })
                    }
                  />
                  {/* And anything else the catalog has: a laboratory can report
                      on a basis no module describes, and the list above only
                      knows the substances this case already names. */}
                  <DrugSearchDropdown
                    onSelect={(drug) => {
                      const name = drug.names.nb ?? drug.names.en ?? drug.id;
                      const scope = `observation-${observation.id}`;
                      if (drug.pubchemCid === undefined) {
                        setRefusedPick({ scope, name, reason: 'no_cid' });
                        return;
                      }
                      // A mass basis is only ever used for one thing: the
                      // molecular weight a mass result is converted with, and
                      // that comes from the embedded catalog rather than from
                      // the database (§7.2 — one copy, not two). A substance
                      // the catalog cannot weigh would take the conversion
                      // down with it and leave the row indeterminate, so it is
                      // refused here where the reason can be given, rather
                      // than accepted and silently unusable.
                      if (!catalogHasMolecularWeight({ pubchemCid: drug.pubchemCid })) {
                        setRefusedPick({ scope, name, reason: 'no_weight' });
                        return;
                      }
                      setRefusedPick(null);
                      update({
                        ...observation,
                        assay: pruned({
                          ...observation.assay,
                          reportedAsDrugId: drug.pubchemCid,
                        }),
                      });
                    }}
                  />
                  <RefusedPick
                    refused={refusedPick}
                    scope={`observation-${observation.id}`}
                  />
                </Field>
              )}
              <Field label={t('pattern.editor.observations.qualifier')}>
                <Select
                  value={observation.qualifier}
                  options={QUALIFIERS.map((qualifier) => ({
                    value: qualifier,
                    label: t(`pattern.editor.qualifier.${qualifier}`),
                  }))}
                  onChange={(event) => {
                    const qualifier = event.target.value as PatternObservationQualifier;
                    // A censored result has no quantified value — that is what
                    // the qualifier says — so the number, its unit and its
                    // reported precision go with the change rather than
                    // staying behind a hidden control, where the stored case
                    // would carry a concentration the result denies and a
                    // later switch back would resurrect it as though it had
                    // been reported.
                    //
                    // The threshold is not cleared in the other direction: a
                    // quantified result can legitimately state the method's
                    // limit beside it, so the limit fields stay on screen
                    // whenever one is there.
                    update(
                      qualifier === 'quantified'
                        ? { ...observation, qualifier }
                        : {
                            ...observation,
                            qualifier,
                            value: undefined,
                            reportedDecimals: undefined,
                            unit: undefined,
                          },
                    );
                  }}
                />
              </Field>
              {/* A number belongs to a quantified result and to no other. The
                  laboratory's answer for a censored one is the qualifier and
                  the threshold, and a value sitting beside them is a number the
                  arithmetic ignores — worse than none, because it hides what
                  was actually reported. */}
              {observation.qualifier === 'quantified' && (
                <>
                  <NumberField
                    label={t('pattern.editor.observations.value')}
                    onDraftProblem={noteDraft}
                    value={observation.value}
                    decimals={observation.reportedDecimals}
                    // The decimals travel with the value. `1,50` parses to 1.5,
                    // and the laboratory's last significant digit is a
                    // statement about the assay's precision — dropped here, a
                    // report reads as though the method were coarser than it
                    // is. Retyping the value replaces the old count rather than
                    // leaving it: `1,50` corrected to `2,5` is a two-decimal
                    // claim about a one-decimal number.
                    onChange={(value, decimals) =>
                      update({ ...observation, value, reportedDecimals: decimals })
                    }
                  />
                  <Field label={t('pattern.editor.observations.unit')}>
                    <Select
                      value={observation.unit ?? ''}
                      options={withStoredOption(
                        [
                          { value: '', label: t('pattern.editor.observations.unitUnset') },
                          ...getAvailableConcentrationUnits(true).map((unit) => ({
                            value: unit,
                            label: unit,
                          })),
                        ],
                        observation.unit,
                      )}
                      onChange={(event) =>
                        update({ ...observation, unit: event.target.value || undefined })
                      }
                    />
                  </Field>
                </>
              )}
              {(observation.qualifier !== 'quantified' || observation.limitRef !== undefined) && (
                <>
                  <Field label={t('pattern.editor.observations.limitLabel')}>
                    <Input
                      value={observation.limitRef?.label ?? ''}
                      placeholder={t('pattern.editor.observations.limitLabelPlaceholder')}
                      onChange={(event) =>
                        update({
                          ...observation,
                          // `source: 'manual'` is true here and nowhere else in
                          // the app: a person is typing it. An imported limit
                          // keeps whatever provenance it arrived with.
                          limitRef: nextLimit(observation.limitRef, { label: event.target.value }),
                        })
                      }
                    />
                  </Field>
                  <NumberField
                    label={t('pattern.editor.observations.limitValue')}
                    onDraftProblem={noteDraft}
                    value={observation.limitRef?.value}
                    decimals={observation.limitRef?.reportedDecimals}
                    onChange={(value, decimals) =>
                      update({
                        ...observation,
                        limitRef: nextLimit(observation.limitRef, {
                          value,
                          reportedDecimals: decimals,
                        }),
                      })
                    }
                  />
                  <Field label={t('pattern.editor.observations.limitUnit')}>
                    <Select
                      value={observation.limitRef?.unit ?? ''}
                      options={withStoredOption(
                        [
                          { value: '', label: t('pattern.editor.observations.unitUnset') },
                          ...getAvailableConcentrationUnits(true).map((unit) => ({
                            value: unit,
                            label: unit,
                          })),
                        ],
                        observation.limitRef?.unit,
                      )}
                      onChange={(event) =>
                        update({
                          ...observation,
                          limitRef: nextLimit(observation.limitRef, { unit: event.target.value }),
                        })
                      }
                    />
                  </Field>
                </>
              )}
            </Row>
          );
        })}
      </Section>
    </div>
  );
}

/**
 * What stands between this case and being filed.
 *
 * Rendered from the schema's own refusals, by code, so the screen and the save
 * path cannot disagree. Every refusal a curator can reach by typing has a code
 * and a Norwegian sentence; what is left is a field's own type refusing
 * imported data, and that is named by its path rather than by Zod's English
 * prose, which belongs in a log.
 */
function Problems({
  problems,
}: {
  problems: ReturnType<typeof patternCaseProblems>;
}) {
  const { t } = useTranslation();
  if (problems.length === 0) return null;

  return (
    <section
      className="rounded-lg border border-[hsl(var(--destructive))] p-3"
      aria-live="polite"
    >
      <h2 className="text-sm font-semibold">{t('pattern.editor.problems.title')}</h2>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {problems.map((problem, index) => (
          <li key={`${problem.path.join('.')}-${index}`}>
            {problem.code
              ? t(`pattern.editor.problem.${problem.code}`, {
                  ...problem.params,
                  defaultValue: t('pattern.editor.problem.unreadable', {
                    path: problem.path.join('.'),
                  }),
                })
              : // No code: a field's own type refused it, which the controls
                // above make unreachable by typing — so this is imported or
                // legacy data, and the honest thing to say is which field
                // cannot be read. The English prose behind it belongs in a log,
                // not in front of a Norwegian curator (AGENTS.md).
                t('pattern.editor.problem.unreadable', { path: problem.path.join('.') })}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Why the pick made *here* did nothing, and nowhere else. */
function RefusedPick({
  refused,
  scope,
}: {
  refused: { scope: string; name: string; reason: 'no_cid' | 'no_weight' } | null;
  scope: string;
}) {
  const { t } = useTranslation();
  if (refused === null || refused.scope !== scope) return null;

  return (
    <span className="text-xs text-[hsl(var(--destructive))]">
      {refused.reason === 'no_cid'
        ? t('pattern.editor.exposures.noCid', { name: refused.name })
        : t('pattern.editor.observations.reportedAsNoWeight', { name: refused.name })}
    </span>
  );
}

function Section({
  title,
  children,
  onAdd,
  addLabel,
  addBlockedLabel,
}: {
  title: string;
  children: React.ReactNode;
  onAdd?: () => void;
  addLabel?: string;
  addBlockedLabel?: string;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">{title}</h2>
        {addLabel && (
          <button
            type="button"
            className="text-sm underline disabled:no-underline disabled:opacity-50"
            disabled={!onAdd}
            title={onAdd ? undefined : addBlockedLabel}
            onClick={onAdd}
          >
            {addLabel}
          </button>
        )}
      </div>
      {children}
    </section>
  );
}

function Row({
  heading,
  children,
  onRemove,
  removeLabel,
  removeBlockedLabel,
}: {
  heading?: string;
  children: React.ReactNode;
  onRemove?: () => void;
  removeLabel: string;
  removeBlockedLabel?: string;
}) {
  return (
    <div className="rounded-lg border border-[hsl(var(--border-subtle))] p-3">
      <div className="flex items-center justify-between">
        {heading && (
          <span className="text-xs text-[hsl(var(--muted-foreground))]">{heading}</span>
        )}
        <button
          type="button"
          className="ml-auto text-sm underline disabled:no-underline disabled:opacity-50"
          disabled={!onRemove}
          title={onRemove ? undefined : removeBlockedLabel}
          onClick={onRemove}
        >
          {onRemove ? removeLabel : (removeBlockedLabel ?? removeLabel)}
        </button>
      </div>
      <div className="grid gap-3 md:grid-cols-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="text-[hsl(var(--muted-foreground))]">{label}</span>
      {children}
    </label>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-[hsl(var(--muted-foreground))]">{children}</p>;
}

/**
 * A number the case may not hold yet.
 *
 * The draft is the whole point: emptying the field is an editing state, not a
 * measurement of zero and not an error, and a control reading its value from
 * the case would refill it from the old number before the second keystroke.
 * `1,500` is refused rather than resolved, because it is 1.5 to one reader and
 * 1500 to another and the difference is a 1000× error on a concentration.
 */
function NumberField({
  label,
  value,
  decimals,
  onChange,
  onDraftProblem,
}: {
  label: string;
  value: number | undefined;
  /**
   * How many decimals the source reported, where the number cannot say.
   * `1,50` is stored as 1.5 beside a count of 2, and rendering the number
   * alone puts a coarser precision on screen than the case will keep — the
   * field would show one laboratory's result and save another's.
   */
  decimals?: number;
  /**
   * The second argument is how many decimals were *typed*, where that differs
   * from what the number carries: `1,50` parses to 1.5, and the laboratory's
   * last significant digit is a statement about the assay's precision that
   * JavaScript cannot hold beside the value. Fields that are not measurements
   * ignore it.
   */
  onChange: (value: number | undefined, decimals: number | undefined) => void;
  /** Whether this field is holding text the case cannot take. */
  onDraftProblem?: (id: string, problem: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language?.startsWith('en') ? 'en-GB' : 'nb-NO';
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<'invalid' | 'ambiguous' | null>(null);
  const messageId = useId();
  // `formatForEditing` rather than a formatter of this field's own: it is the
  // module's own precision ladder, and it already answers the two questions
  // this field has. No grouping, because a grouped number cannot be typed back
  // — the parser rejects the Norwegian space and calls the English comma
  // ambiguous. And scientific notation past twenty decimals, where a decimal
  // rendering does not lose precision so much as print `0` for a value the
  // case is still holding.
  const shown = value === undefined ? '' : formatForEditing(value, locale, decimals);
  // Two different things: what the reader is told, and whether the case can be
  // filed. A half-typed negative number is not worth an error message — it is
  // what `-5` looks like after one keystroke — but the case still holds the
  // number being replaced, so filing now would write that one under a field
  // showing something else.
  const report = (next: 'invalid' | 'ambiguous' | null, blocking = next !== null) => {
    setProblem(next);
    onDraftProblem?.(messageId, blocking);
  };
  // A field that goes away takes its complaint with it. Removing the row, or
  // switching a quantified result to a censored one, unmounts this input — and
  // without saying so, its id would sit in the parent's set forever, leaving
  // Save disabled over a field that no longer exists and nothing on screen to
  // fix.
  useEffect(
    () => () => onDraftProblem?.(messageId, false),
    [messageId, onDraftProblem],
  );

  return (
    // The message sits outside the `<label>`, not inside it: an element nested
    // in a label becomes part of the field's accessible *name*, so a screen
    // reader would announce the field as "Prøvetaking … Tvetydig — bruk
    // desimaltegn". It is a description, and `aria-describedby` is what says
    // so.
    <div className="block text-sm">
      <label className="block">
        <span className="text-[hsl(var(--muted-foreground))]">{label}</span>
        <Input
          type="text"
          inputMode="decimal"
          value={draft ?? shown}
          aria-invalid={problem !== null}
          aria-describedby={problem ? messageId : undefined}
          onChange={(event) => {
            const raw = event.target.value;
            setDraft(raw);
            const trimmed = raw.trim();
            if (trimmed === '') {
              report(null);
              onChange(undefined, undefined);
              return;
            }
            // A lone minus is what a negative number looks like halfway
            // through: no complaint on screen, but nothing to file either.
            if (trimmed === '-') {
              report(null, true);
              return;
            }
            const parsed = parseLocaleNumberDetailed(trimmed);
            if (!parsed.ok) {
              report(parsed.reason);
              return;
            }
            report(null);
            onChange(parsed.value, reportedDecimalsOf(trimmed));
          }}
          onBlur={() => {
            setDraft(null);
            report(null);
          }}
        />
      </label>
      {problem && (
        <span id={messageId} className="text-xs text-[hsl(var(--destructive))]">
          {t(`pattern.editor.number.${problem}`)}
        </span>
      )}
    </div>
  );
}
