import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'nb' },
    t: (key: string, values?: Record<string, unknown>) => `${key}${values?.name ? ` ${values.name}` : ''}${values?.number ? ` ${values.number}` : ''}`,
  }),
}));
vi.mock('@/components/DrugSearchDropdown', () => ({
  DrugSearchDropdown: ({ onSelect }: { onSelect: (drug: unknown) => void }) => <button type="button"
    onClick={() => onSelect({ id: 'custom', pubchemCid: 98765, names: { nb: 'Custom' } })}>catalog pick</button>,
}));
vi.mock('@/lib/drugApi', () => ({ fetchDrugByCid: vi.fn() }));

import { fetchDrugByCid, type DrugRow } from '@/lib/drugApi';
import { PATTERN_MODULES } from '@/lib/pattern/modules';
import { emptyPatternCase } from '@/stores/patternCaseStore';
import type { PatternCaseData } from '@/types/patternCase';
import { GuidedCaseEntry } from './GuidedCaseEntry';

const DZP = 'pattern.profile.analyte.diazepam.label';
const MOR = 'pattern.profile.analyte.morphine.label';
const NDD = 'pattern.profile.analyte.nordazepam.label';
const sample = (number = 1) => within(screen.getByRole('region', { name: `pattern.guided.sampleNumber ${number}` }));
const settings = (number = 1) => within(screen.getByLabelText(`pattern.guided.settingsFor ${number}`));
const fetchDrug = vi.mocked(fetchDrugByCid);
const state = (): PatternCaseData => JSON.parse(screen.getByTestId('case').textContent ?? '{}');

function Harness({ initial = emptyPatternCase('benzodiazepines') }: { initial?: PatternCaseData }) {
  const [data, setData] = useState(initial);
  const [problem, setProblem] = useState(false);
  const [active, setActive] = useState<string>();
  return <><GuidedCaseEntry caseData={data} modules={PATTERN_MODULES} onChange={setData}
    onDraftProblem={setProblem} onSpecimenChange={setActive} />
    <pre data-testid="case">{JSON.stringify(data)}</pre><span data-testid="problem">{String(problem)}</span>
    <span data-testid="active">{active}</span></>;
}

async function choose(label = DZP) {
  fireEvent.click(screen.getByRole('button', { name: label }));
  await waitFor(() => expect(screen.queryByText('pattern.guided.loading')).toBeNull());
}

beforeEach(() => {
  fetchDrug.mockReset();
  fetchDrug.mockResolvedValue({ drug: { metabolism: { precursors: [], metabolites: [] } } as unknown as DrugRow });
});

describe('guided metabolite entry', () => {
  it('shows two urine samples together with separate values, creatinine and an optional interval', async () => {
    render(<Harness />);
    await choose();
    fireEvent.change(screen.getByLabelText('pattern.guided.medium'), { target: { value: 'urine' } });
    expect(state().specimens).toHaveLength(2);
    expect(state().specimens.map((item) => item.relativeTimeHours)).toEqual([0, undefined]);
    expect(sample(1).queryByLabelText(`pattern.guided.valueFor ${DZP}`)).toBeNull();
    expect(sample(2).queryByLabelText(`pattern.guided.valueFor ${DZP}`)).toBeNull();
    fireEvent.change(sample(1).getByLabelText(`pattern.guided.valueFor ${NDD}`), { target: { value: '0,6' } });
    fireEvent.change(sample(2).getByLabelText(`pattern.guided.valueFor ${NDD}`), { target: { value: '0,2' } });
    fireEvent.change(sample(1).getByLabelText('pattern.editor.specimens.creatinine'), { target: { value: '8' } });
    fireEvent.change(sample(2).getByLabelText('pattern.editor.specimens.creatinine'), { target: { value: '4' } });
    fireEvent.change(sample(2).getByLabelText('pattern.guided.hoursAfterFirst'), { target: { value: '72' } });
    const data = state();
    expect(data.specimens.map((item) => item.urine?.creatinineMmolL)).toEqual([8, 4]);
    expect(data.specimens.map((item) => item.relativeTimeHours)).toEqual([0, 72]);
    expect(data.observations.map((item) => [item.specimenId, item.value])).toEqual([
      [data.specimens[0]!.id, 0.6], [data.specimens[1]!.id, 0.2],
    ]);
    expect(data.observations.every((item) => item.assay?.measurandMode === 'unknown')).toBe(true);
  });

  it('places an interval on the existing time origin without rebasing either sample', () => {
    const initial: PatternCaseData = {
      ...emptyPatternCase('benzodiazepines'),
      context: { postmortem: false, timeOrigin: 'admission', fields: {} },
      specimens: [{ id: 'one', matrix: 'urine', relativeTimeHours: 12 }, { id: 'two', matrix: 'urine', relativeTimeHours: 24 }],
      observations: [{ id: 'result', analyte: { pubchemCid: 2997 }, specimenId: 'one', qualifier: 'quantified', value: 1, unit: 'µmol/L' }],
    };
    render(<Harness initial={initial} />);
    const interval = sample(2).getByLabelText('pattern.guided.hoursAfterFirst') as HTMLInputElement;
    expect(interval.value).toBe('12');
    fireEvent.change(interval, { target: { value: '36' } });
    expect(state().specimens.map((item) => item.relativeTimeHours)).toEqual([12, 48]);
    expect(state().context.timeOrigin).toBe('admission');
  });

  it('does not alter a reopened untimed case until its second visible input is edited', () => {
    const initial: PatternCaseData = {
      ...emptyPatternCase('benzodiazepines'),
      specimens: [{ id: 'original', matrix: 'urine' }],
      observations: [{ id: 'result', analyte: { pubchemCid: 2997 }, specimenId: 'original', qualifier: 'quantified', value: 1, unit: 'µmol/L' }],
    };
    render(<Harness initial={initial} />);
    expect(state()).toEqual(initial);
    expect((sample(2).getByLabelText('pattern.guided.hoursAfterFirst') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(sample(2).getByLabelText(`pattern.guided.valueFor ${NDD}`), { target: { value: '0,4' } });
    expect(state().specimens).toHaveLength(2);
    expect(state().specimens.every((item) => item.relativeTimeHours === undefined)).toBe(true);
    expect(state().observations[0]).toEqual(initial.observations[0]);
  });

  it('keeps additional saved specimens and only edits the selected sample', () => {
    const initial: PatternCaseData = {
      ...emptyPatternCase('benzodiazepines'),
      specimens: [
        { id: 'first', matrix: 'urine', relativeTimeHours: 0 },
        { id: 'second', matrix: 'urine', relativeTimeHours: 24 },
        { id: 'third', matrix: 'urine', relativeTimeHours: 48, label: 'Original label' },
        { id: 'blood', matrix: 'whole_blood' },
      ],
      observations: [{ id: 'result', analyte: { pubchemCid: 2997 }, specimenId: 'first', qualifier: 'quantified', value: 1, unit: 'µmol/L' }],
    };
    render(<Harness initial={initial} />);
    fireEvent.change(sample(3).getByLabelText(`pattern.guided.valueFor ${NDD}`), { target: { value: '0,1' } });
    expect(state().specimens).toEqual(initial.specimens);
    expect(state().observations[1]).toMatchObject({ specimenId: 'third', value: 0.1 });
  });

  it('changes the new-entry unit without relabelling already recorded measurements', async () => {
    render(<Harness />);
    await choose();
    fireEvent.change(screen.getByLabelText('pattern.guided.medium'), { target: { value: 'whole_blood' } });
    fireEvent.change(sample(1).getByLabelText(`pattern.guided.valueFor ${DZP}`), { target: { value: '0,5' } });
    fireEvent.change(sample(1).getByLabelText('pattern.guided.newUnitFor pattern.guided.sampleNumber 1'), { target: { value: 'ng/mL' } });
    fireEvent.change(sample(1).getByLabelText(`pattern.guided.valueFor ${NDD}`), { target: { value: '25' } });
    expect(state().observations.map((item) => [item.value, item.unit])).toEqual([[0.5, 'µmol/L'], [25, 'ng/mL']]);
  });

  it('starts with an explicit medium and keeps unentered analytes absent while accepting quantified zero', async () => {
    render(<Harness />);
    await choose();
    expect(state().specimens).toEqual([]);
    fireEvent.change(screen.getByLabelText('pattern.guided.medium'), { target: { value: 'whole_blood' } });
    expect(sample().getByLabelText(`pattern.guided.valueFor ${DZP}`)).toBeTruthy();
    expect(state().observations).toEqual([]);
    fireEvent.change(sample().getByLabelText(`pattern.guided.valueFor ${DZP}`), { target: { value: '0' } });
    expect(state().observations).toHaveLength(1);
    expect(state().observations[0]).toMatchObject({ value: 0, unit: 'µmol/L', assay: { measurandMode: 'unknown' } });
    fireEvent.change(sample().getByLabelText(`pattern.guided.valueFor ${DZP}`), { target: { value: '' } });
    expect(state().observations).toEqual([]);
  });

  it('keeps previous medium measurements and creatinine attached to their own specimens', async () => {
    render(<Harness />);
    await choose();
    fireEvent.change(screen.getByLabelText('pattern.guided.medium'), { target: { value: 'whole_blood' } });
    fireEvent.change(sample().getByLabelText(`pattern.guided.valueFor ${DZP}`), { target: { value: '0,32' } });
    const bloodId = state().specimens[0]!.id;
    fireEvent.change(screen.getByLabelText('pattern.guided.medium'), { target: { value: 'urine' } });
    expect(state().observations[0]).toMatchObject({ value: 0.32, specimenId: bloodId });
    fireEvent.change(sample().getByLabelText('pattern.editor.specimens.creatinine'), { target: { value: '7,5' } });
    expect(state().specimens.find((item) => item.matrix === 'urine')?.urine?.creatinineMmolL).toBe(7.5);
    fireEvent.change(screen.getByLabelText('pattern.guided.medium'), { target: { value: 'whole_blood' } });
    expect(screen.queryByLabelText('pattern.editor.specimens.creatinine')).toBeNull();
    expect(screen.getByTestId('active').textContent).toBe(bloodId);
    expect(state().specimens).toHaveLength(4);
    expect((sample().getByLabelText(`pattern.guided.valueFor ${DZP}`) as HTMLInputElement).value).toBe('0,32');
  });

  it('retains invalid drafts across blur and blocks saving or switching medium until corrected', async () => {
    render(<Harness />);
    await choose();
    fireEvent.change(screen.getByLabelText('pattern.guided.medium'), { target: { value: 'whole_blood' } });
    const input = sample().getByLabelText(`pattern.guided.valueFor ${DZP}`) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0,5' } });
    fireEvent.change(input, { target: { value: '1,500' } });
    fireEvent.blur(input);
    expect(input.value).toBe('1,500');
    expect(state().observations[0]!.value).toBe(0.5);
    expect(screen.getByTestId('problem').textContent).toBe('true');
    expect((screen.getByLabelText('pattern.guided.medium') as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(input, { target: { value: '1,50' } });
    expect(state().observations[0]).toMatchObject({ value: 1.5, reportedDecimals: 2 });
    expect(screen.getByTestId('problem').textContent).toBe('false');
  });

  it('preserves the chosen unit and measurement form when the value is entered later', async () => {
    render(<Harness />);
    await choose();
    fireEvent.change(screen.getByLabelText('pattern.guided.medium'), { target: { value: 'urine' } });
    fireEvent.change(settings().getByLabelText(`pattern.guided.unitFor ${NDD}`), { target: { value: 'ng/mL' } });
    fireEvent.change(settings().getByLabelText(`pattern.guided.formFor ${NDD}`), { target: { value: 'free' } });
    expect(state().observations).toEqual([]);
    fireEvent.change(sample().getByLabelText(`pattern.guided.valueFor ${NDD}`), { target: { value: '5' } });
    expect(state().observations[0]).toMatchObject({ value: 5, unit: 'ng/mL', assay: { measurandMode: 'free' } });
  });

  it('exposes all five priority opioid analytes through one selection', async () => {
    render(<Harness />);
    await choose(MOR);
    fireEvent.change(screen.getByLabelText('pattern.guided.medium'), { target: { value: 'urine' } });
    const module = PATTERN_MODULES.find((item) => item.id === 'morphine-codeine')!;
    expect(module.analytes).toHaveLength(5);
    for (const analyte of module.analytes) expect(sample().getByLabelText(`pattern.guided.valueFor ${analyte.labelKey}`)).toBeTruthy();
    expect(state().moduleIds).toEqual(['morphine-codeine']);
  });

  it('does not flatten a saved below-limit result to its threshold', () => {
    const initial: PatternCaseData = {
      ...emptyPatternCase('benzodiazepines'),
      specimens: [{ id: 'existing', matrix: 'urine' }],
      observations: [{ id: 'one', analyte: { pubchemCid: 3016 }, specimenId: 'existing', qualifier: 'below_limit',
        limitRef: { label: 'LOQ', value: 0.02, unit: 'µmol/L', source: 'manual' } }],
    };
    render(<Harness initial={initial} />);
    expect(screen.getByText('pattern.editor.qualifier.below_limit 0,02 µmol/L')).toBeTruthy();
    expect(sample().queryByLabelText(`pattern.guided.valueFor ${DZP}`)).toBeNull();
    expect(state()).toEqual(initial);
  });

  it('retains the mass basis, limits, note and identity when a result is cleared and retyped', () => {
    const initial: PatternCaseData = {
      ...emptyPatternCase('benzodiazepines'),
      specimens: [{ id: 'existing', matrix: 'urine' }],
      observations: [{ id: 'original-result', analyte: { pubchemCid: 3016 }, specimenId: 'existing', qualifier: 'quantified',
        value: 2, unit: 'ng/mL', note: 'original laboratory note', assay: {
          measurandMode: 'free', reportedAsDrugId: 2997,
          limits: [{ label: 'LOQ', value: 0.2, unit: 'ng/mL', source: 'manual' }],
        } }],
    };
    render(<Harness initial={initial} />);
    const input = sample().getByLabelText(`pattern.guided.valueFor ${DZP}`);
    fireEvent.change(input, { target: { value: '' } });
    expect(state().observations).toEqual([]);
    fireEvent.change(input, { target: { value: '3' } });
    expect(state().observations[0]).toEqual({ ...initial.observations[0], value: 3, reportedDecimals: 0 });
  });

  it('keeps repeated observations in independent input slots when the first is cleared', () => {
    const initial: PatternCaseData = {
      ...emptyPatternCase('benzodiazepines'),
      specimens: [{ id: 'existing', matrix: 'urine' }],
      observations: [
        { id: 'first', analyte: { pubchemCid: 3016 }, specimenId: 'existing', qualifier: 'quantified', value: 2, unit: 'ng/mL', assay: { measurandMode: 'free' } },
        { id: 'second', analyte: { pubchemCid: 3016 }, specimenId: 'existing', qualifier: 'quantified', value: 4, unit: 'µmol/L', assay: { measurandMode: 'total_after_hydrolysis' } },
      ],
    };
    render(<Harness initial={initial} />);
    const [firstInput, secondInput] = sample().getAllByLabelText(`pattern.guided.valueFor ${DZP}`) as HTMLInputElement[];
    fireEvent.change(firstInput!, { target: { value: '' } });
    expect(state().observations).toEqual([initial.observations[1]]);
    expect(secondInput!.value).toBe('4');
    const units = settings().getAllByLabelText(`pattern.guided.unitFor ${DZP}`) as HTMLSelectElement[];
    expect(units.map((input) => input.value)).toEqual(['ng/mL', 'µmol/L']);
    const modes = settings().getAllByLabelText(`pattern.guided.formFor ${DZP}`) as HTMLSelectElement[];
    expect(modes.map((input) => input.value)).toEqual(['free', 'total_after_hydrolysis']);
    fireEvent.change(firstInput!, { target: { value: '6' } });
    expect(state().observations.find((item) => item.id === 'first')).toMatchObject({ value: 6, unit: 'ng/mL', assay: { measurandMode: 'free' } });
    expect(state().observations.find((item) => item.id === 'second')).toEqual(initial.observations[1]);
  });

  it('ignores an older catalog response after another substance was chosen', async () => {
    let resolveFirst!: (value: { drug: DrugRow }) => void;
    fetchDrug.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: DZP }));
    await choose(MOR);
    await act(async () => resolveFirst({ drug: { metabolism: { precursors: [], metabolites: [{
      drug: { pubchemCid: 11111, names: { nb: 'Stale related drug' }, slug: 'stale' },
    }] } } as unknown as DrugRow }));
    fireEvent.change(screen.getByLabelText('pattern.guided.medium'), { target: { value: 'urine' } });
    expect(screen.queryByText('Stale related drug')).toBeNull();
    expect(state().moduleIds).toEqual(['morphine-codeine']);
  });
});
