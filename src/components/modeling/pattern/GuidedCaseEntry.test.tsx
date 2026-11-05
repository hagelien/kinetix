import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'nb' },
    t: (key: string, values?: Record<string, unknown>) => `${key}${values?.name ? ` ${values.name}` : ''}`,
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
  it('starts with an explicit medium and keeps unentered analytes absent while accepting quantified zero', async () => {
    render(<Harness />);
    await choose();
    expect(state().specimens).toEqual([]);
    fireEvent.change(screen.getByLabelText('pattern.guided.medium'), { target: { value: 'whole_blood' } });
    expect(screen.getByLabelText(`pattern.guided.valueFor ${DZP}`)).toBeTruthy();
    expect(state().observations).toEqual([]);
    fireEvent.change(screen.getByLabelText(`pattern.guided.valueFor ${DZP}`), { target: { value: '0' } });
    expect(state().observations).toHaveLength(1);
    expect(state().observations[0]).toMatchObject({ value: 0, unit: 'µmol/L', assay: { measurandMode: 'unknown' } });
    fireEvent.change(screen.getByLabelText(`pattern.guided.valueFor ${DZP}`), { target: { value: '' } });
    expect(state().observations).toEqual([]);
  });

  it('keeps previous medium measurements and creatinine attached to their own specimens', async () => {
    render(<Harness />);
    await choose();
    fireEvent.change(screen.getByLabelText('pattern.guided.medium'), { target: { value: 'whole_blood' } });
    fireEvent.change(screen.getByLabelText(`pattern.guided.valueFor ${DZP}`), { target: { value: '0,32' } });
    const bloodId = state().specimens[0]!.id;
    fireEvent.change(screen.getByLabelText('pattern.guided.medium'), { target: { value: 'urine' } });
    expect(state().observations[0]).toMatchObject({ value: 0.32, specimenId: bloodId });
    fireEvent.change(screen.getByLabelText('pattern.editor.specimens.creatinine'), { target: { value: '7,5' } });
    expect(state().specimens.find((item) => item.matrix === 'urine')?.urine?.creatinineMmolL).toBe(7.5);
    fireEvent.change(screen.getByLabelText('pattern.guided.medium'), { target: { value: 'whole_blood' } });
    expect(screen.queryByLabelText('pattern.editor.specimens.creatinine')).toBeNull();
    expect(screen.getByTestId('active').textContent).toBe(bloodId);
    expect(state().specimens).toHaveLength(2);
    expect((screen.getByLabelText(`pattern.guided.valueFor ${DZP}`) as HTMLInputElement).value).toBe('0,32');
  });

  it('retains invalid drafts across blur and blocks saving or switching medium until corrected', async () => {
    render(<Harness />);
    await choose();
    fireEvent.change(screen.getByLabelText('pattern.guided.medium'), { target: { value: 'whole_blood' } });
    const input = screen.getByLabelText(`pattern.guided.valueFor ${DZP}`) as HTMLInputElement;
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
    fireEvent.change(screen.getByLabelText(`pattern.guided.unitFor ${DZP}`), { target: { value: 'ng/mL' } });
    fireEvent.change(screen.getByLabelText(`pattern.guided.formFor ${DZP}`), { target: { value: 'free' } });
    expect(state().observations).toEqual([]);
    fireEvent.change(screen.getByLabelText(`pattern.guided.valueFor ${DZP}`), { target: { value: '5' } });
    expect(state().observations[0]).toMatchObject({ value: 5, unit: 'ng/mL', assay: { measurandMode: 'free' } });
  });

  it('exposes all five priority opioid analytes through one selection', async () => {
    render(<Harness />);
    await choose(MOR);
    fireEvent.change(screen.getByLabelText('pattern.guided.medium'), { target: { value: 'urine' } });
    const module = PATTERN_MODULES.find((item) => item.id === 'morphine-codeine')!;
    expect(module.analytes).toHaveLength(5);
    for (const analyte of module.analytes) expect(screen.getByLabelText(`pattern.guided.valueFor ${analyte.labelKey}`)).toBeTruthy();
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
    expect(screen.queryByLabelText(`pattern.guided.valueFor ${DZP}`)).toBeNull();
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
    const input = screen.getByLabelText(`pattern.guided.valueFor ${DZP}`);
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
    const [firstInput, secondInput] = screen.getAllByLabelText(`pattern.guided.valueFor ${DZP}`) as HTMLInputElement[];
    fireEvent.change(firstInput!, { target: { value: '' } });
    expect(state().observations).toEqual([initial.observations[1]]);
    expect(secondInput!.value).toBe('4');
    const units = screen.getAllByLabelText(`pattern.guided.unitFor ${DZP}`) as HTMLSelectElement[];
    expect(units.map((input) => input.value)).toEqual(['ng/mL', 'µmol/L']);
    const modes = screen.getAllByLabelText(`pattern.guided.formFor ${DZP}`) as HTMLSelectElement[];
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
