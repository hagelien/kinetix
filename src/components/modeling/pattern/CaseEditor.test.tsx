/**
 * Entering a case (plan §10, Phase 1).
 *
 * What is pinned here is not the layout but the four places where an entry
 * screen can quietly lose or corrupt casework: removing a container taking its
 * contents with it, two rows ending up with one id, a number field refilling
 * itself mid-retype, and the screen falling silent about something the save
 * path will refuse.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import nb from '../../../locales/nb.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'nb' },
    t: (key: string, options?: Record<string, unknown>) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (node, part) =>
            node && typeof node === 'object' && part in node
              ? (node as Record<string, unknown>)[part]
              : undefined,
          nb,
        );
      // The editor passes the schema's English prose as `defaultValue` for a
      // refusal with no Norwegian string yet, so the stub has to honour it or
      // the fallback would test as a bare key.
      if (typeof value !== 'string') return (options?.defaultValue as string) ?? key;
      return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) =>
        String(options?.[name] ?? `{{${name}}}`),
      );
    },
  }),
}));

vi.mock('@/components/DrugSearchDropdown', () => ({
  // The real one is a debounced fetch; what matters here is which control the
  // selection came from.
  DrugSearchDropdown: ({ onSelect }: { onSelect: (drug: unknown) => void }) => (
    <button type="button" onClick={() => onSelect({ id: 'x', names: { nb: 'Ukjent stoff' } })}>
      velg uten CID
    </button>
  ),
}));

import { CaseEditor } from './CaseEditor';
import { DIAZEPAM_FIXTURE_CASE } from '../../../lib/pattern/fixtures';
import { BENZODIAZEPINE_MODULE } from '../../../lib/pattern/modules/benzodiazepines';
import { patternCaseProblems } from '../../../lib/patternCases';
import type { PatternCaseData } from '../../../types/patternCase';

const EMPTY: PatternCaseData = {
  ...DIAZEPAM_FIXTURE_CASE,
  specimens: [],
  observations: [],
};

/** The editor is controlled, so the test holds the case the way a page does. */
function Harness({ initial }: { initial: PatternCaseData }) {
  const [caseData, setCaseData] = useState(initial);
  const [draftProblem, setDraftProblem] = useState(false);
  return (
    <>
      <CaseEditor
        caseData={caseData}
        modules={[BENZODIAZEPINE_MODULE]}
        onChange={setCaseData}
        onDraftProblem={setDraftProblem}
      />
      <pre data-testid="state">{JSON.stringify(caseData)}</pre>
      <pre data-testid="draft-problem">{String(draftProblem)}</pre>
    </>
  );
}

const state = (): PatternCaseData => JSON.parse(screen.getByTestId('state').textContent ?? '{}');

describe('entering a case', () => {
  it('builds a case the schema accepts, and says so until it does', () => {
    render(<Harness initial={EMPTY} />);

    fireEvent.click(screen.getByText('Legg til prøve'));
    fireEvent.click(screen.getByText('Legg til måling'));

    // The measurement is attached to the specimen that exists, not to a name
    // typed twice — an observation naming a specimen the case does not carry
    // resolves to no matrix and disappears from the profile.
    expect(state().observations[0]!.specimenId).toBe(state().specimens[0]!.id);

    // And until it carries a value and a unit, the screen says so in Norwegian
    // rather than letting a save fail somewhere the curator cannot see.
    expect(screen.getByText(/er merket som kvantifisert, men mangler verdi/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Verdi'), { target: { value: '1,45' } });
    fireEvent.change(screen.getByLabelText('Enhet'), { target: { value: 'µmol/L' } });

    // The comma is what a Norwegian curator types, and it has to reach the case
    // as a number rather than as text or as 145.
    expect(state().observations[0]!.value).toBe(1.45);
    expect(patternCaseProblems(state())).toEqual([]);
  });

  it('will not delete measurements as a side effect of removing a specimen', () => {
    render(<Harness initial={DIAZEPAM_FIXTURE_CASE} />);

    const blocked = screen.getAllByTitle(/Kan ikke fjernes/);
    expect(blocked.length).toBeGreaterThan(0);
    fireEvent.click(blocked[0]!);

    // Nothing removed, and the button says what is in the way instead of
    // silently taking the results with it.
    expect(state().specimens).toHaveLength(DIAZEPAM_FIXTURE_CASE.specimens.length);
    expect(state().observations).toHaveLength(DIAZEPAM_FIXTURE_CASE.observations.length);
  });

  it('does not hand a removed row’s id to the next one', () => {
    render(<Harness initial={EMPTY} />);
    fireEvent.click(screen.getByText('Legg til prøve'));
    fireEvent.click(screen.getByText('Legg til prøve'));
    const second = state().specimens[1]!.id;

    // Remove the first, then add one. A count-based id would reissue the
    // second's id, and two specimens sharing one means every observation naming
    // it is read against whichever matrix won.
    fireEvent.click(screen.getAllByText('Fjern')[0]!);
    fireEvent.click(screen.getByText('Legg til prøve'));

    const ids = state().specimens.map((specimen) => specimen.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(second);
  });

  it('lets a number be emptied and retyped', () => {
    const urine: PatternCaseData = {
      ...EMPTY,
      specimens: [{ id: 'spm-1', matrix: 'urine', urine: { creatinineMmolL: 13.26 } }],
    };
    render(<Harness initial={urine} />);
    const field = screen.getByLabelText('Kreatinin (mmol/L)') as HTMLInputElement;

    fireEvent.change(field, { target: { value: '' } });

    // A control reading its value straight from the case would refill the old
    // number here, and the second keystroke would land after it — so retyping a
    // concentration would be impossible.
    expect(field.value).toBe('');
    expect(state().specimens[0]!.urine).toBeUndefined();

    fireEvent.change(field, { target: { value: '8,2' } });
    expect(state().specimens[0]!.urine?.creatinineMmolL).toBe(8.2);
  });

  it('refuses an ambiguous number instead of guessing which reader typed it', () => {
    render(<Harness initial={EMPTY} />);
    fireEvent.click(screen.getByText('Legg til prøve'));
    const field = screen.getByLabelText('Prøvetaking (timer fra nullpunkt)');

    fireEvent.change(field, { target: { value: '1,500' } });

    // 1.5 to one reader and 1500 to another. On a forensic quantity that guess
    // is a 1000× error, so the entry is rejected visibly and nothing reaches
    // the case.
    expect(screen.getByText('Tvetydig — bruk desimaltegn')).toBeTruthy();
    expect(state().specimens[0]!.relativeTimeHours).toBeUndefined();

    // And the page is told, because the case itself is *valid* — those
    // keystrokes never reached it. Without this the screen shows one number
    // while the case holds another, and saving files the one being replaced.
    expect(screen.getByTestId('draft-problem').textContent).toBe('true');
    fireEvent.change(field, { target: { value: '1,5' } });
    expect(screen.getByTestId('draft-problem').textContent).toBe('false');
  });

  it('will not file the old number while the field shows a half-typed one', () => {
    const started: PatternCaseData = {
      ...EMPTY,
      specimens: [{ id: 'spm-1', matrix: 'whole_blood', relativeTimeHours: 4 }],
    };
    render(<Harness initial={started} />);
    const field = screen.getByLabelText('Prøvetaking (timer fra nullpunkt)');

    fireEvent.change(field, { target: { value: '-' } });

    // No complaint on screen — a lone minus is what `-5` looks like after one
    // keystroke — but the case still holds the 4 being replaced, so filing
    // now would write a number the field is not showing.
    expect(screen.queryByText('Ikke et tall')).toBeNull();
    expect(state().specimens[0]!.relativeTimeHours).toBe(4);
    expect(screen.getByTestId('draft-problem').textContent).toBe('true');

    fireEvent.change(field, { target: { value: '-5' } });
    expect(state().specimens[0]!.relativeTimeHours).toBe(-5);
    expect(screen.getByTestId('draft-problem').textContent).toBe('false');
  });

  it('forgets a complaint from a field that no longer exists', () => {
    render(<Harness initial={EMPTY} />);
    fireEvent.click(screen.getByText('Legg til prøve'));
    fireEvent.click(screen.getByText('Legg til måling'));
    fireEvent.change(screen.getByLabelText('Verdi'), { target: { value: '1,500' } });
    expect(screen.getByTestId('draft-problem').textContent).toBe('true');

    // Switching to a censored qualifier unmounts the value field. Its
    // complaint has to go with it, or Save stays disabled over a field that is
    // not on screen and cannot be corrected.
    fireEvent.change(screen.getByLabelText('Resultattype'), { target: { value: 'below_limit' } });
    expect(screen.queryByLabelText('Verdi')).toBeNull();
    expect(screen.getByTestId('draft-problem').textContent).toBe('false');

    // And the same when the row itself goes.
    fireEvent.change(screen.getByLabelText('Grenseverdi'), { target: { value: '1,500' } });
    expect(screen.getByTestId('draft-problem').textContent).toBe('true');
    fireEvent.click(screen.getAllByText('Fjern').at(-1)!);
    expect(screen.getByTestId('draft-problem').textContent).toBe('false');
  });

  it('does not keep a concentration under a result that denies one', () => {
    render(<Harness initial={EMPTY} />);
    fireEvent.click(screen.getByText('Legg til prøve'));
    fireEvent.click(screen.getByText('Legg til måling'));
    fireEvent.change(screen.getByLabelText('Verdi'), { target: { value: '1,50' } });
    fireEvent.change(screen.getByLabelText('Enhet'), { target: { value: 'µmol/L' } });

    fireEvent.change(screen.getByLabelText('Resultattype'), { target: { value: 'below_limit' } });

    // The qualifier is the statement that there is no quantified value. Left
    // behind a hidden control, the stored case would carry a concentration the
    // result denies — and switching back would resurrect it as though a
    // laboratory had reported it.
    expect(state().observations[0]!.value).toBeUndefined();
    expect(state().observations[0]!.unit).toBeUndefined();
    expect(state().observations[0]!.reportedDecimals).toBeUndefined();

    fireEvent.change(screen.getByLabelText('Grensens navn'), { target: { value: 'MKK' } });
    fireEvent.change(screen.getByLabelText('Grenseverdi'), { target: { value: '0,01' } });
    fireEvent.change(screen.getByLabelText('Grenseenhet'), { target: { value: 'µmol/L' } });

    // A quantified result may legitimately state the method's limit beside it,
    // so that half is kept — and stays on screen, where it can be corrected.
    fireEvent.change(screen.getByLabelText('Resultattype'), { target: { value: 'quantified' } });
    expect(state().observations[0]!.limitRef?.label).toBe('MKK');
    expect(screen.getByLabelText('Grenseverdi')).toBeTruthy();
  });

  it('lets a case stop naming a module the app no longer ships', () => {
    // Without a control of its own the stored id could not be taken off, and
    // the profile stayed unavailable meanwhile: the graph endpoint has nothing
    // to answer for a module it does not know.
    const retired: PatternCaseData = {
      ...EMPTY,
      moduleIds: ['benzodiazepines', 'phenethylamines'],
    };
    render(<Harness initial={retired} />);

    const control = screen.getByLabelText(/phenethylamines/) as HTMLInputElement;
    expect(control.checked).toBe(true);
    fireEvent.click(control);

    expect(state().moduleIds).toEqual(['benzodiazepines']);
  });

  it('does not hand a removed exposure’s row to the one that follows it', () => {
    render(<Harness initial={EMPTY} />);
    fireEvent.click(screen.getByText('Legg til inntak'));
    fireEvent.click(screen.getByText('Legg til inntak'));

    const doses = screen.getAllByLabelText('Oppgitt dose');
    fireEvent.change(doses[0]!, { target: { value: '10' } });
    fireEvent.change(doses[1]!, { target: { value: '25' } });

    // Removing the first slides the second into index 0. Keyed by position,
    // React reuses the removed row's field state there, so the remaining
    // exposure shows a dose the case does not hold — and Save files the one it
    // does.
    fireEvent.click(screen.getAllByText('Fjern')[0]!);

    expect(state().context.knownExposures).toHaveLength(1);
    expect(state().context.knownExposures![0]!.amount).toBe(25);
    expect((screen.getByLabelText('Oppgitt dose') as HTMLInputElement).value).toBe('25');
  });

  it('keeps a postmortem interval reachable after the case says nobody died', () => {
    const postmortem: PatternCaseData = {
      ...EMPTY,
      context: { ...EMPTY.context, postmortem: true },
      specimens: [
        {
          id: 'spm-1',
          matrix: 'femoral_blood',
          relativeTimeHours: 0,
          postmortem: { postmortemIntervalHours: 36 },
        },
      ],
    };
    render(<Harness initial={postmortem} />);

    fireEvent.click(screen.getByLabelText('Postmortem sak'));

    // Death-to-collection belongs to a postmortem case, and the interval is a
    // duration that anchors nothing — so it is not deleted with the switch.
    // Hidden, though, it would sit in a living case with no way to clear it.
    const field = screen.getByLabelText('Postmortemintervall (timer)') as HTMLInputElement;
    expect(field.value).toBe('36');
    fireEvent.change(field, { target: { value: '' } });
    expect(state().specimens[0]!.postmortem).toBeUndefined();
  });

  it('lets a threshold started by accident be taken back out', () => {
    render(<Harness initial={EMPTY} />);
    fireEvent.click(screen.getByText('Legg til prøve'));
    fireEvent.click(screen.getByText('Legg til måling'));
    fireEvent.change(screen.getByLabelText('Resultattype'), { target: { value: 'below_limit' } });

    fireEvent.change(screen.getByLabelText('Grensens navn'), { target: { value: 'M' } });
    expect(state().observations[0]!.limitRef).toBeTruthy();
    // Half a threshold is refused twice over — a reporting limit is a
    // concentration a method can detect, and neither `0` nor an unstated unit
    // is one — so the row cannot be filed while it stands.
    expect(patternCaseProblems(state()).map((p) => p.code)).toEqual([
      'limit_not_positive',
      'unit_unreadable',
    ]);

    fireEvent.change(screen.getByLabelText('Grensens navn'), { target: { value: '' } });

    // And clearing the controls takes the object with them. A censored result
    // with no printed threshold is a state laboratories produce all the time;
    // deleting the whole observation was the only way back to it.
    expect(state().observations[0]!.limitRef).toBeUndefined();
    expect(patternCaseProblems(state())).toEqual([]);
  });

  it('keeps the dose and route an account states', () => {
    // Nothing computes from a milligram amount in this release. The account is
    // given once, though, and the plan asks Phase 1 for the stated dose — a
    // field that does not exist loses the evidence for good.
    const exposed: PatternCaseData = {
      ...EMPTY,
      context: {
        ...EMPTY.context,
        knownExposures: [{ drug: { pubchemCid: 3016 }, certainty: 'reported' }],
      },
    };
    render(<Harness initial={exposed} />);

    fireEvent.change(screen.getByLabelText('Administrasjonsmåte'), { target: { value: 'peroralt' } });
    fireEvent.change(screen.getByLabelText('Oppgitt dose'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('Doseenhet'), { target: { value: 'mg' } });

    expect(state().context.knownExposures![0]).toMatchObject({
      route: 'peroralt',
      amount: 10,
      amountUnit: 'mg',
    });
    expect(patternCaseProblems(state())).toEqual([]);

    // Including the unit the account actually used. A weight-normalised dose is
    // the ordinary way a paediatric or veterinary statement is given, the case
    // contract has this as free text for that reason, and a control offering
    // three absolute units would both refuse to record it and show a stored one
    // as an empty field while the case went on holding it.
    fireEvent.change(screen.getByLabelText('Doseenhet'), { target: { value: 'mg/kg' } });
    expect(state().context.knownExposures![0]!.amountUnit).toBe('mg/kg');
    expect((screen.getByLabelText('Doseenhet') as HTMLInputElement).value).toBe('mg/kg');
  });

  it('keeps the precision the laboratory reported', () => {
    render(<Harness initial={EMPTY} />);
    fireEvent.click(screen.getByText('Legg til prøve'));
    fireEvent.click(screen.getByText('Legg til måling'));

    // `1,50` parses to 1.5, and the trailing zero is a statement about the
    // assay's precision that the number cannot hold.
    fireEvent.change(screen.getByLabelText('Verdi'), { target: { value: '1,50' } });
    expect(state().observations[0]!.value).toBe(1.5);
    expect(state().observations[0]!.reportedDecimals).toBe(2);

    // Retyping replaces the count rather than leaving it: a two-decimal claim
    // about a one-decimal number is a precision nobody reported.
    fireEvent.change(screen.getByLabelText('Verdi'), { target: { value: '2,5' } });
    expect(state().observations[0]!.reportedDecimals).toBe(1);
  });

  it('shows a reopened result at the precision it was reported to', () => {
    // The metadata survives the round trip either way; what would not is the
    // agreement between the field and the case — the screen showing 1,5 while
    // the case holds a two-decimal claim about the same number.
    const stored: PatternCaseData = {
      ...EMPTY,
      specimens: [{ id: 'spm-1', matrix: 'whole_blood', relativeTimeHours: 0 }],
      observations: [
        {
          id: 'obs-1',
          specimenId: 'spm-1',
          analyte: { pubchemCid: 3016 },
          qualifier: 'quantified',
          value: 1.5,
          reportedDecimals: 2,
          unit: 'µmol/L',
        },
      ],
    };
    render(<Harness initial={stored} />);

    expect((screen.getByLabelText('Verdi') as HTMLInputElement).value).toBe('1,50');
    // And in the reader's own separator, which is what they will type back.
    expect((screen.getByLabelText('Kreatininreferanse (mmol/L)') as HTMLInputElement).value).toBe(
      '8,84',
    );
  });

  it('survives a precision no formatter can render', () => {
    // `Intl.NumberFormat` throws a RangeError past twenty fractional digits.
    // Reached by pasting a long value — the throw lands inside the input
    // handler and takes the editor down mid-keystroke — and by reopening a
    // stored case that carries the same count.
    const absurd: PatternCaseData = {
      ...EMPTY,
      specimens: [{ id: 'spm-1', matrix: 'whole_blood', relativeTimeHours: 0 }],
      observations: [
        {
          id: 'obs-1',
          specimenId: 'spm-1',
          analyte: { pubchemCid: 3016 },
          qualifier: 'quantified',
          value: 1.5,
          reportedDecimals: 40,
          unit: 'µmol/L',
        },
      ],
    };

    expect(() => render(<Harness initial={absurd} />)).not.toThrow();
    // Past the formatter's limit the number states itself, rather than being
    // padded to a precision no renderer can carry.
    expect((screen.getByLabelText('Verdi') as HTMLInputElement).value).toBe('1,5');

    // And through the keyboard, where the count comes from what was typed.
    fireEvent.change(screen.getByLabelText('Verdi'), {
      target: { value: `0,${'1'.repeat(30)}` },
    });
    expect(state().observations[0]!.reportedDecimals).toBe(30);
  });

  it('says why a catalog pick did nothing, beside the pick itself', () => {
    // One editor renders several search fields. A message kept for the whole
    // screen appears under every one of them at once — and where the row it
    // belongs to does not exist, nowhere at all, leaving a selection that
    // silently did nothing.
    const twoExposures: PatternCaseData = {
      ...EMPTY,
      context: {
        ...EMPTY.context,
        knownExposures: [
          { drug: { pubchemCid: 3016 }, certainty: 'reported' },
          { drug: { pubchemCid: 2519 }, certainty: 'suspected' },
        ],
      },
    };
    render(<Harness initial={twoExposures} />);

    const pickers = screen.getAllByText('velg uten CID');
    expect(pickers).toHaveLength(2);
    fireEvent.click(pickers[1]!);

    expect(screen.getAllByText(/ingen PubChem-CID/)).toHaveLength(1);
  });

  it('does not print zero for a value the case is still holding', () => {
    // Past twenty decimals a decimal rendering cannot state the number at all,
    // and rounding it to `0,000…` would put a zero on screen while the case
    // saves a real concentration. The exponential form is typeable back — the
    // parser accepts `1e-21` — which is why it is used here rather than
    // `Intl`'s scientific notation with its Unicode minus.
    const tiny: PatternCaseData = {
      ...EMPTY,
      specimens: [{ id: 'spm-1', matrix: 'whole_blood', relativeTimeHours: 0 }],
      observations: [
        {
          id: 'obs-1',
          specimenId: 'spm-1',
          analyte: { pubchemCid: 3016 },
          qualifier: 'quantified',
          value: 1e-21,
          reportedDecimals: 21,
          unit: 'µmol/L',
        },
      ],
    };
    render(<Harness initial={tiny} />);

    const field = screen.getByLabelText('Verdi') as HTMLInputElement;
    expect(field.value).not.toMatch(/^0[,.]0+$/);
    expect(field.value).toContain('e-21');
  });

  it('keeps a mass basis the modules never named', () => {
    // A laboratory can report on a basis no module describes. Left out of the
    // options, the select renders blank over an id that is very much in use —
    // the molecular weight every ratio from that row is computed with.
    const outside: PatternCaseData = {
      ...EMPTY,
      specimens: [{ id: 'spm-1', matrix: 'urine', relativeTimeHours: 0 }],
      observations: [
        {
          id: 'obs-1',
          specimenId: 'spm-1',
          analyte: { pubchemCid: 3016 },
          qualifier: 'quantified',
          value: 1,
          unit: 'µmol/L',
          assay: { measurandMode: 'direct_conjugate', reportedAsDrugId: 5284371 },
        },
      ],
    };
    render(<Harness initial={outside} />);

    const reportedAs = screen.getByLabelText('Rapportert som') as HTMLSelectElement;
    expect(reportedAs.value).toBe('5284371');
    expect([...reportedAs.options].map((option) => option.value)).toContain('5284371');
  });

  it('lets a conjugate say whose molecular weight it was reported on', () => {
    // A conjugate quoted on its parent's basis converts with the parent's
    // weight; using the analyte's own is a systematically wrong molar
    // concentration, and therefore a wrong ratio, with nothing on screen to
    // show it.
    render(<Harness initial={EMPTY} />);
    fireEvent.click(screen.getByText('Legg til prøve'));
    fireEvent.click(screen.getByText('Legg til måling'));

    // Not offered until the mode is one where it happens.
    expect(screen.queryByLabelText('Rapportert som')).toBeNull();
    fireEvent.change(screen.getByLabelText('Målt som'), {
      target: { value: 'total_after_hydrolysis' },
    });

    const reportedAs = screen.getByLabelText('Rapportert som') as HTMLSelectElement;
    const parent = [...reportedAs.options].find((option) => option.value)!;
    fireEvent.change(reportedAs, { target: { value: parent.value } });

    expect(state().observations[0]!.assay?.reportedAsDrugId).toBe(Number(parent.value));
  });

  it('keeps an exposure naming a substance no module describes', () => {
    // The interesting exposure for source ambiguity is precisely the one
    // outside the module — an upstream source drug is what the walk exists to
    // consider. Left out of the options, the select renders showing the first
    // substance in the list while the case says another, and the next change to
    // the row files that misreading.
    const outside: PatternCaseData = {
      ...EMPTY,
      context: {
        ...EMPTY.context,
        knownExposures: [
          { drug: { pubchemCid: 5284371, slug: 'oxycodone' }, certainty: 'reported' },
        ],
      },
    };
    render(<Harness initial={outside} />);

    const select = screen.getByLabelText('Analytt') as HTMLSelectElement;
    expect(select.value).toBe('5284371');
    expect([...select.options].map((option) => option.value)).toContain('5284371');
  });

  it('lets a result say what was actually measured', () => {
    // Not decoration: the hydrolysis question only reaches a case whose
    // observations say they were measured as a conjugate or after hydrolysis,
    // and the artefact rules that question exists for key on the same field. A
    // screen that could not say it left every hand-typed case skipping both.
    render(<Harness initial={EMPTY} />);
    fireEvent.click(screen.getByText('Legg til prøve'));
    fireEvent.click(screen.getByText('Legg til måling'));

    // Unset to begin with, because the alternative is asserting a protocol
    // nobody stated.
    expect(state().observations[0]!.assay?.measurandMode).toBeUndefined();

    fireEvent.change(screen.getByLabelText('Målt som'), {
      target: { value: 'total_after_hydrolysis' },
    });
    expect(state().observations[0]!.assay?.measurandMode).toBe('total_after_hydrolysis');
  });

  it('does not keep the hour of a death in a case that says nobody died', () => {
    const postmortem: PatternCaseData = {
      ...EMPTY,
      context: { ...EMPTY.context, postmortem: true, deathRelativeHours: -36 },
      specimens: [{ id: 'spm-1', matrix: 'femoral_blood', relativeTimeHours: 0 }],
    };
    render(<Harness initial={postmortem} />);

    fireEvent.click(screen.getByLabelText('Postmortem sak'));

    // The death is an instant on the case's axis, so it goes on anchoring the
    // timeline from a field the curator can no longer see — and therefore can
    // no longer put right.
    expect(state().context.deathRelativeHours).toBeUndefined();
    expect(state().context.postmortem).toBe(false);
  });

  it('can clear every urine field a specimen carries', () => {
    // The schema refuses urine data on a specimen that is not urine, and the
    // fields stay on screen so it can be cleared. A field with no control
    // makes that impossible: the case cannot be filed with the corrected
    // matrix and cannot be corrected back either.
    const moved: PatternCaseData = {
      ...EMPTY,
      specimens: [
        {
          id: 'spm-1',
          matrix: 'urine',
          relativeTimeHours: 0,
          urine: { creatinineMmolL: 8, specificGravity: 1.02, collectionDurationHours: 12 },
        },
      ],
    };
    render(<Harness initial={moved} />);

    for (const label of [
      'Kreatinin (mmol/L)',
      'Egenvekt',
      'Oppsamlingstid (timer)',
      'Forrige vannlating (timer fra nullpunkt)',
    ]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: '' } });
    }

    expect(state().specimens[0]!.urine).toBeUndefined();
    fireEvent.change(screen.getByLabelText('Matriks'), { target: { value: 'whole_blood' } });
    expect(patternCaseProblems(state())).toEqual([]);
  });

  it('keeps storage duration in view, since a living patient’s sample also waits', () => {
    // The postmortem interval is death to collection and belongs to a
    // postmortem case; storage duration is how long the tube sat before
    // analysis, which happens to samples from the living too. Hiding it would
    // leave a number stored where nobody could correct it.
    const living: PatternCaseData = {
      ...EMPTY,
      specimens: [{ id: 'spm-1', matrix: 'whole_blood', relativeTimeHours: 0 }],
    };
    render(<Harness initial={living} />);

    expect(screen.getByLabelText('Lagringstid (timer)')).toBeTruthy();
    expect(screen.queryByLabelText('Postmortemintervall (timer)')).toBeNull();
  });

  it('says a timeline contradicts its own origin while it is being typed', () => {
    render(<Harness initial={EMPTY} />);
    fireEvent.click(screen.getByText('Legg til prøve'));
    fireEvent.change(screen.getByLabelText('Prøvetaking (timer fra nullpunkt)'), {
      target: { value: '3' },
    });

    // The failure the §7.3 rules exist for, reported where it can still be
    // fixed in one keystroke rather than at save time.
    expect(screen.getByText(/Alle timer i saken forskyves like mye/)).toBeTruthy();
  });
});
