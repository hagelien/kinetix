import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ParameterEntryRow } from '@/lib/parameterEntriesApi';
import type { CmaxStratum, CmaxSummary, PoolableEntry } from '@/lib/cmaxNormalization';

// Same harness as ModelStructureSection.test: the entries client and the
// citation picker are mocked so the section and its editor run without a
// network.
const store: ParameterEntryRow[] = [];
const createParameterEntry = vi.fn().mockResolvedValue({ id: 99 });
let summary: CmaxSummary = { outcomes: [], strata: [], headline: { kind: 'none' } };
// The summary endpoint answers with the summary AND the rows it was computed
// from (one snapshot); by default those are the rows in the store.
let summaryItems: ParameterEntryRow[] | null = null;
const fetchCmaxSummary = vi.fn(async () => ({ summary, items: summaryItems ?? [...store] }));

vi.mock('@/lib/parameterEntriesApi', () => ({
  fetchParameterEntries: vi.fn(async (_drugId: number, opts?: { parameter?: string }) =>
    store.filter((e) => !opts?.parameter || e.parameter === opts.parameter),
  ),
  createParameterEntry: (...args: unknown[]) => createParameterEntry(...args),
  updateParameterEntry: vi.fn(),
  deleteParameterEntry: vi.fn(),
  fetchCmaxSummary: (...args: unknown[]) => fetchCmaxSummary(...(args as [])),
}));
vi.mock('@/components/wiki/ReferenceInput', () => ({
  ReferenceInput: ({ onReferenceCreated }: { onReferenceCreated: (r: { id: number }) => void }) => (
    <button type="button" onClick={() => onReferenceCreated({ id: 5 })}>
      pick-citation
    </button>
  ),
}));
vi.mock('@/components/DrugSearchDropdown', () => ({
  DrugSearchDropdown: ({ onSelect }: { onSelect: (c: { _dbId: number; names: Record<string, string> }) => void }) => (
    <button type="button" onClick={() => onSelect({ _dbId: 7, names: { nb: 'Kokain', en: 'Cocaine' } })}>
      pick-drug
    </button>
  ),
}));

import {
  CmaxSection,
  formatCmaxValue,
  formatCmaxValueIn,
  formatNormalized,
  stratumLabel,
} from '@/components/wiki/CmaxSection';
import { DrugUnitScope } from '@/components/ui/DrugUnitScope';
import { useAppStore } from '@/stores/appStore';
import type { TFunction } from 'i18next';
import { deleteParameterEntry, fetchParameterEntries } from '@/lib/parameterEntriesApi';

function cmaxRow(over: Partial<ParameterEntryRow> = {}): ParameterEntryRow {
  return {
    id: 1,
    parameter: 'cmax',
    low: 70,
    high: 98,
    median: null,
    qualifier: null,
    categoricalValue: null,
    unit: 'ng/mL',
    route: 'oral',
    matrix: 'plasma',
    scenario: null,
    n: 12,
    comments: null,
    observationContext: null,
    sourceQuote: 'Cmax was 84 ± 14 ng/mL.',
    origin: 'contributor',
    citationId: 5,
    citation: null,
    doseContext: {
      centralValue: 84,
      centralStatistic: 'arithmetic_mean',
      intervalKind: 'sd',
      valueBasis: 'concentration',
      doseValue: 2,
      doseUnit: 'mg',
      administeredDrugId: 42,
    },
    ...over,
  };
}

describe('CmaxSection', () => {
  afterEach(() => {
    store.length = 0;
    createParameterEntry.mockClear();
    fetchCmaxSummary.mockClear();
    summary = { outcomes: [], strata: [], headline: { kind: 'none' } };
    summaryItems = null;
  });

  it('renders nothing for a reader when there are no values', async () => {
    const { container } = render(<CmaxSection drugId={42} drugName="Kokain" />);
    await waitFor(() => expect(container.querySelector('[data-testid="cmax-section"]')).toBeNull());
  });

  it('lists each value with its dose context', async () => {
    store.push(cmaxRow());
    render(<CmaxSection drugId={42} drugName="Kokain" />);
    expect(await screen.findByText('84 ng/mL (70–98)')).toBeTruthy();
    expect(screen.getByTestId('cmax-entry').textContent).toContain('Cmax was 84 ± 14 ng/mL.');
    // The dose-context rows from DoseContextDetails (keys, as the test
    // environment loads no translations).
    expect(screen.getByTestId('cmax-entry').textContent).toContain('doseContext.fields.dose');
    expect(screen.getByTestId('cmax-entry').textContent).toContain('doseContext.fields.valueBasis');
  });

  it('shows an ethanol reading in the reader\'s ethanol unit', async () => {
    useAppStore.setState({ ethanolUnit: '‰' });
    store.push(
      cmaxRow({
        unit: 'mg/dL',
        low: 70,
        high: 90,
        doseContext: { centralValue: 80, valueBasis: 'concentration' },
      }),
    );
    const { container } = render(
      <DrugUnitScope isEthanol>
        <CmaxSection drugId={702} drugName="Etanol" molecularWeight={46.07} />
      </DrugUnitScope>,
    );
    // 80 mg/dL = 0.8 g/L = 0.8 ‰; the unit sits in its own tooltip trigger.
    await waitFor(() =>
      expect(screen.getByTestId('cmax-entry').textContent).toContain('0.8 ‰ (0.7–0.9)'),
    );
    expect(container.textContent).not.toContain('80 mg/dL (70–90)');
  });

  it('keeps readings as authored outside an ethanol scope', async () => {
    useAppStore.setState({ ethanolUnit: '‰' });
    store.push(cmaxRow({ unit: 'mg/dL', low: 70, high: 90, doseContext: { centralValue: 80 } }));
    render(<CmaxSection drugId={42} drugName="Kokain" molecularWeight={303.35} />);
    expect(await screen.findByText('80 mg/dL (70–90)')).toBeTruthy();
  });

  it('leaves a reading as authored when it cannot convert', () => {
    // A molar reading without a molecular weight, and a per-dose unit, stay
    // as authored; with one, 84 mmol/L × 46.07 g/mol = 3.87 g/L = 3.87 ‰.
    expect(formatCmaxValueIn(cmaxRow({ unit: 'mmol/L' }), '‰', null)).toBeNull();
    expect(formatCmaxValueIn(cmaxRow({ unit: 'µmol/L/mg' }), '‰', 46.07)).toBeNull();
    expect(formatCmaxValueIn(cmaxRow({ unit: 'mmol/L' }), '‰', 46.07)).toBe(
      '3.87 ‰ (3.22–4.51)',
    );
  });

  it('formats a censored threshold with its operator', () => {
    expect(
      formatCmaxValue(
        cmaxRow({ qualifier: '<', low: null, high: null, doseContext: { centralValue: 5 } }),
      ),
    ).toBe('< 5 ng/mL');
  });

  it('submits a self-administered value with its full context', async () => {
    render(<CmaxSection drugId={42} drugName="Kokain" canEdit isAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: /cmax\.add/ }));
    fireEvent.change(screen.getByLabelText(/cmax\.editor\.centralValue/), { target: { value: '84' } });
    fireEvent.change(screen.getByLabelText(/doseContext\.fields\.statistic/), {
      target: { value: 'arithmetic_mean' },
    });
    fireEvent.change(screen.getByLabelText(/cmax\.editor\.doseValue/), { target: { value: '2' } });
    fireEvent.click(screen.getByText('pick-citation'));
    fireEvent.click(screen.getByRole('button', { name: /parameterEntries\.editor\.save/ }));

    await waitFor(() => expect(createParameterEntry).toHaveBeenCalledTimes(1));
    const body = createParameterEntry.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toMatchObject({
      drugId: 42,
      parameter: 'cmax',
      valueBasis: 'concentration',
      centralValue: 84,
      centralStatistic: 'arithmetic_mean',
      doseValue: 2,
      doseUnit: 'mg',
      administeredDrugId: 42,
      citationId: 5,
    });
  });

  it('names another substance as the dosed drug for a metabolite reading', async () => {
    render(<CmaxSection drugId={42} drugName="Benzoylekgonin" canEdit isAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: /cmax\.add/ }));
    fireEvent.change(screen.getByLabelText(/cmax\.editor\.centralValue/), { target: { value: '84' } });
    fireEvent.change(screen.getByLabelText(/doseContext\.fields\.statistic/), {
      target: { value: 'arithmetic_mean' },
    });
    fireEvent.change(screen.getByLabelText(/cmax\.editor\.doseValue/), { target: { value: '2' } });
    fireEvent.click(screen.getByText('pick-drug'));
    fireEvent.click(screen.getByText('pick-citation'));
    fireEvent.click(screen.getByRole('button', { name: /parameterEntries\.editor\.save/ }));

    await waitFor(() => expect(createParameterEntry).toHaveBeenCalledTimes(1));
    expect(createParameterEntry.mock.calls[0]![0]).toMatchObject({ administeredDrugId: 7 });
  });

  it('refuses an ill-formed value before sending it', async () => {
    render(<CmaxSection drugId={42} drugName="Kokain" canEdit isAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: /cmax\.add/ }));
    // A central value with no statistic label.
    fireEvent.change(screen.getByLabelText(/cmax\.editor\.centralValue/), { target: { value: '84' } });
    fireEvent.change(screen.getByLabelText(/cmax\.editor\.doseValue/), { target: { value: '2' } });
    fireEvent.click(screen.getByText('pick-citation'));
    fireEvent.click(screen.getByRole('button', { name: /parameterEntries\.editor\.save/ }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(createParameterEntry).not.toHaveBeenCalled();
  });

  describe('per-dose view', () => {
    function poolable(entryId: number, value: number): PoolableEntry {
      return {
        entryId,
        normalizedCentralValue: value,
        normalizedUnit: 'µmol/L per mg',
        normalizedMatrix: 'plasma',
        doseStratum: { kind: 'exact', value: 2, unit: 'mg' },
        doseBasis: 'base',
        doseSaltForm: null,
        centralStatistic: 'arithmetic_mean',
        intervalKind: null,
        qualifier: null,
        n: 12,
        reviewScore: null,
        citationId: 5,
        route: 'oral',
        releaseProfile: 'immediate',
        physicalForm: 'tablet_capsule',
        prandialState: 'fasted',
        coadministrationState: 'monotherapy',
        pkPopulation: 'healthy_adult',
        valueBasis: 'concentration',
        regimen: 'single',
        doseIntervalHours: null,
        doseNumber: null,
        regimenDurationHours: null,
        priorDosingRegular: null,
        ivInputMode: null,
        administrationDurationMin: null,
        administeredDrugId: 42,
      };
    }
    function stratum(members: PoolableEntry[], value: number): CmaxStratum {
      const values = members.map((m) => m.normalizedCentralValue);
      return {
        key: 'k',
        context: members[0]!,
        cohorts: members.length,
        value,
        spread: members.length > 1 ? { low: Math.min(...values), high: Math.max(...values) } : null,
        ownInterval: null,
        entryIds: members.map((m) => m.entryId),
      };
    }

    it('fetches the summary only once the per-dose view is chosen', async () => {
      store.push(cmaxRow());
      render(<CmaxSection drugId={42} drugName="Kokain" />);
      await screen.findByText('84 ng/mL (70–98)');
      expect(fetchCmaxSummary).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'cmax.modeNormalized' }));
      await waitFor(() => expect(fetchCmaxSummary).toHaveBeenCalledTimes(1));
      expect(await screen.findByTestId('cmax-headline')).toBeTruthy();
      expect(screen.getByTestId('cmax-headline').textContent).toContain('cmax.headlineNone');
    });

    // Issue #21: toggling must not refetch or lose the view.
    it('reuses the held summary when toggling back to the per-dose view', async () => {
      store.push(cmaxRow({ id: 1 }));
      render(<CmaxSection drugId={42} drugName="Kokain" />);
      await screen.findByText('84 ng/mL (70–98)');
      fireEvent.click(screen.getByRole('button', { name: 'cmax.modeNormalized' }));
      await screen.findByTestId('cmax-headline');
      expect(fetchCmaxSummary).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByRole('button', { name: 'cmax.modeObserved' }));
      fireEvent.click(screen.getByRole('button', { name: 'cmax.modeNormalized' }));
      expect(await screen.findByTestId('cmax-headline')).toBeTruthy();
      expect(fetchCmaxSummary).toHaveBeenCalledTimes(1);
    });

    it('shows one pooled headline, each normalized value, and why a reading is left out', async () => {
      store.push(cmaxRow({ id: 1 }), cmaxRow({ id: 2, sourceQuote: null }), cmaxRow({ id: 3, sourceQuote: null }));
      const a = poolable(1, 0.1387);
      const b = poolable(2, 0.15);
      summary = {
        outcomes: [
          { kind: 'poolable', entry: a },
          { kind: 'poolable', entry: b },
          { kind: 'ineligible', entryId: 3, reason: 'unknown_prandial_state' },
        ],
        strata: [stratum([a, b], 0.1387)],
        headline: { kind: 'single', stratum: stratum([a, b], 0.1387) },
      };
      render(<CmaxSection drugId={42} drugName="Kokain" />);
      await screen.findAllByTestId('cmax-entry');
      fireEvent.click(screen.getByRole('button', { name: 'cmax.modeNormalized' }));

      const headline = await screen.findByTestId('cmax-headline');
      expect(headline.textContent).toContain('cmax.headlineSingle');
      expect(headline.textContent).toContain('cmax.spread');
      expect(screen.getByTestId('cmax-stratum').textContent).toContain('doseContext.doseExact');
      const annotations = await screen.findAllByTestId('cmax-normalized');
      expect(annotations.map((n) => n.textContent)).toEqual([
        '→ 0.139 µmol/L per mg',
        '→ 0.15 µmol/L per mg',
        'cmax.excluded: cmax.reasons.unknown_prandial_state',
      ]);
    });

    it('never picks a number when readings come from different dosing contexts', async () => {
      store.push(cmaxRow({ id: 1 }), cmaxRow({ id: 2, sourceQuote: null }));
      const a = poolable(1, 0.14);
      const b = { ...poolable(2, 0.3), prandialState: 'fed' };
      summary = {
        outcomes: [
          { kind: 'poolable', entry: a },
          { kind: 'poolable', entry: b },
        ],
        strata: [stratum([a], 0.14), stratum([b], 0.3)],
        headline: { kind: 'multiple', strata: 2 },
      };
      render(<CmaxSection drugId={42} drugName="Kokain" />);
      await screen.findAllByTestId('cmax-entry');
      fireEvent.click(screen.getByRole('button', { name: 'cmax.modeNormalized' }));
      const headline = await screen.findByTestId('cmax-headline');
      // The headline itself names no number; each stratum carries its own.
      expect(headline.querySelector('p')!.textContent).toBe('cmax.headlineMultiple');
      // Each stratum is listed with what sets it apart and its own value.
      const strata = screen.getAllByTestId('cmax-stratum').map((n) => n.textContent);
      expect(strata).toHaveLength(2);
      expect(strata[0]).toContain('· fasted ·');
      expect(strata[0]).toContain('cmax.headlineSingleOne');
      expect(strata[1]).toContain('· fed ·');
      expect(strata[1]).toContain('cmax.headlineSingleOne');
    });

    // Codex on #1387: a listed stratum lost its estimator and its uncertainty
    // as soon as a second dosing context existed.
    it('keeps each listed stratum\'s estimator and uncertainty when there are several', async () => {
      store.push(cmaxRow({ id: 1 }), cmaxRow({ id: 2, sourceQuote: null }), cmaxRow({ id: 3, sourceQuote: null }));
      const a = poolable(1, 0.14);
      const b = poolable(2, 0.16);
      const c = { ...poolable(3, 0.3), prandialState: 'fed' };
      const pooled = stratum([a, b], 0.14);
      const single = { ...stratum([c], 0.3), ownInterval: { low: 0.25, high: 0.35, kind: 'sd' as const } };
      summary = {
        outcomes: [a, b, c].map((entry) => ({ kind: 'poolable' as const, entry })),
        strata: [pooled, single],
        headline: { kind: 'multiple', strata: 2 },
      };
      render(<CmaxSection drugId={42} drugName="Kokain" />);
      await screen.findAllByTestId('cmax-entry');
      fireEvent.click(screen.getByRole('button', { name: 'cmax.modeNormalized' }));
      await screen.findByTestId('cmax-headline');
      const strata = screen.getAllByTestId('cmax-stratum').map((n) => n.textContent);
      expect(strata[0]).toContain('cmax.headlineSingle; cmax.spread');
      expect(strata[1]).toContain('cmax.headlineSingleOne; sd 0.25–0.35');
    });

    // Codex on #1387: a failed refresh left the previous summary on screen,
    // unmarked, beside the refreshed rows.
    it('drops a stale summary when a refresh fails, and offers a retry', async () => {
      store.push(cmaxRow({ id: 1 }));
      const a = poolable(1, 0.14);
      summary = { outcomes: [{ kind: 'poolable', entry: a }], strata: [stratum([a], 0.14)], headline: { kind: 'single', stratum: stratum([a], 0.14) } };
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<CmaxSection drugId={42} drugName="Kokain" canEdit />);
      await screen.findAllByTestId('cmax-entry');
      fireEvent.click(screen.getByRole('button', { name: 'cmax.modeNormalized' }));
      expect((await screen.findByTestId('cmax-headline')).textContent).toContain('cmax.headlineSingleOne');

      // A change to the rows is what refreshes the summary; the refresh fails.
      fetchCmaxSummary.mockRejectedValueOnce(new Error('boom'));
      fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
      expect(await screen.findByText('cmax.summaryError')).toBeTruthy();
      confirm.mockRestore();
      expect(screen.queryByTestId('cmax-headline')).toBeNull();
      expect(screen.queryByText(/cmax\.headlineSingleOne/)).toBeNull();
    });

    it('shows a normalized value that is kept out of the pool, with its reason', async () => {
      store.push(cmaxRow({ id: 1, qualifier: '<' }));
      const censored = { ...poolable(1, 0.02), qualifier: '<', centralStatistic: null };
      summary = {
        outcomes: [{ kind: 'normalized_not_poolable', entry: censored, reason: 'censored_value' }],
        strata: [],
        headline: { kind: 'none' },
      };
      render(<CmaxSection drugId={42} drugName="Kokain" />);
      await screen.findByTestId('cmax-entry');
      fireEvent.click(screen.getByRole('button', { name: 'cmax.modeNormalized' }));
      expect((await screen.findByTestId('cmax-normalized')).textContent).toBe(
        '→ < 0.02 µmol/L per mg (cmax.notPooled: cmax.reasons.censored_value)',
      );
    });

    it('offers a retry when the summary cannot be computed', async () => {
      store.push(cmaxRow());
      fetchCmaxSummary.mockRejectedValueOnce(new Error('boom'));
      render(<CmaxSection drugId={42} drugName="Kokain" />);
      await screen.findByTestId('cmax-entry');
      fireEvent.click(screen.getByRole('button', { name: 'cmax.modeNormalized' }));
      expect((await screen.findByRole('alert')).textContent).toBe('cmax.summaryError');
      fireEvent.click(screen.getByRole('button', { name: 'common.retry' }));
      expect(await screen.findByTestId('cmax-headline')).toBeTruthy();
    });

    // Codex on #1387: a single cohort's own reported interval, converted like
    // its centre, was computed and then never shown.
    it("shows a single cohort's converted interval in the headline and on its reading", async () => {
      store.push(cmaxRow({ id: 1 }));
      const a = { ...poolable(1, 0.14), normalizedLow: 0.12, normalizedHigh: 0.16, intervalKind: 'sd' as const };
      const s = { ...stratum([a], 0.14), ownInterval: { low: 0.12, high: 0.16, kind: 'sd' as const } };
      summary = { outcomes: [{ kind: 'poolable', entry: a }], strata: [s], headline: { kind: 'single', stratum: s } };
      render(<CmaxSection drugId={42} drugName="Kokain" />);
      await screen.findAllByTestId('cmax-entry');
      fireEvent.click(screen.getByRole('button', { name: 'cmax.modeNormalized' }));
      const headline = await screen.findByTestId('cmax-headline');
      expect(headline.textContent).toContain('cmax.headlineSingleOne; sd 0.12–0.16');
      const [annotation] = await screen.findAllByTestId('cmax-normalized');
      expect(annotation!.textContent).toBe('→ 0.14 (sd 0.12–0.16) µmol/L per mg');
    });

    // Codex on #1387: strata split on a dimension the label left out read the
    // same. Every dimension of cmaxPoolingKey that can differ between two
    // poolable strata must change the label.
    it.each([
      ['dose basis', { doseBasis: 'salt' }],
      ['salt form', { doseBasis: 'salt', doseSaltForm: 'hydrochloride' }],
      ['IV input', { route: 'iv', ivInputMode: 'infusion' }],
      ['infusion time', { administrationDurationMin: 120 }],
      ['physical form', { physicalForm: 'solution' }],
      ['dosing interval', { regimen: 'steady_state', doseIntervalHours: 12 }],
      ['dose number', { doseNumber: 3 }],
      ['time on the regimen', { regimenDurationHours: 48 }],
      ['central statistic', { centralStatistic: 'geometric_mean' }],
      ['value basis', { valueBasis: 'dose_normalized' }],
      ['dosed substance', { administeredDrugId: 7 }],
    ] as const)('labels two strata that differ only in %s differently', (_label, over) => {
      const interp = ((key: string, o?: Record<string, unknown>) =>
        o && 'defaultValue' in o
          ? String(o.defaultValue)
          : `${key}${o ? JSON.stringify(o) : ''}`) as unknown as TFunction;
      const base = { ...poolable(1, 0.14), administrationDurationMin: null };
      const a = stratum([base], 0.14);
      const b = stratum([{ ...base, ...over } as PoolableEntry], 0.2);
      const labelA = stratumLabel(interp, a, { ownDrugId: 42, siblings: [a, b] });
      const labelB = stratumLabel(interp, b, { ownDrugId: 42, siblings: [a, b] });
      expect(labelA).not.toBe(labelB);
    });

    // Codex P1 on #1387: a source-reported ratio has no observed concentration,
    // so the Observed tab must not present it as one.
    it('lists a source-reported ratio only in the per-dose view', async () => {
      const ratio = cmaxRow({
        id: 2,
        unit: 'ng/mL/mg',
        low: null,
        high: null,
        sourceQuote: null,
        doseContext: { centralValue: 42, centralStatistic: 'arithmetic_mean', valueBasis: 'dose_normalized', administeredDrugId: 42 },
      });
      store.push(cmaxRow({ id: 1 }), ratio);
      render(<CmaxSection drugId={42} drugName="Kokain" />);
      await screen.findByText('84 ng/mL (70–98)');
      expect(screen.getAllByTestId('cmax-entry')).toHaveLength(1);
      expect(screen.queryByText('42 ng/mL/mg')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'cmax.modeNormalized' }));
      expect(await screen.findByText('42 ng/mL/mg')).toBeTruthy();
      expect(screen.getAllByTestId('cmax-entry')).toHaveLength(2);
    });

    it('says so when every value is a source-reported ratio', async () => {
      store.push(
        cmaxRow({
          unit: 'ng/mL/mg',
          low: null,
          high: null,
          doseContext: { centralValue: 42, centralStatistic: 'arithmetic_mean', valueBasis: 'dose_normalized', administeredDrugId: 42 },
        }),
      );
      render(<CmaxSection drugId={42} drugName="Kokain" />);
      expect(await screen.findByText('cmax.observedNone')).toBeTruthy();
      expect(screen.queryByTestId('cmax-entry')).toBeNull();
    });

    // Codex P1 on #1387: a derived ratio and a source-reported one are
    // different evidence; the label names which, even for a lone stratum.
    it('names the value basis of a stratum even when no other stratum differs', () => {
      const interp = ((key: string, o?: Record<string, unknown>) =>
        o && 'defaultValue' in o ? String(o.defaultValue) : key) as unknown as TFunction;
      const derived = stratum([poolable(1, 0.14)], 0.14);
      const reported = stratum([{ ...poolable(2, 0.14), valueBasis: 'dose_normalized' }], 0.14);
      expect(stratumLabel(interp, derived, { ownDrugId: 42 })).toContain('concentration');
      expect(stratumLabel(interp, reported, { ownDrugId: 42 })).toContain('dose_normalized');
    });

    // Codex P1 on #1387: after a committed delete whose reload fails, the old
    // rows and the old per-dose headline stayed up with no sign they were stale.
    it('drops the per-dose summary and flags the rows when the reload after a change fails', async () => {
      store.push(cmaxRow({ id: 1 }));
      const a = poolable(1, 0.14);
      summary = { outcomes: [{ kind: 'poolable', entry: a }], strata: [stratum([a], 0.14)], headline: { kind: 'single', stratum: stratum([a], 0.14) } };
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<CmaxSection drugId={42} drugName="Kokain" canEdit isAdmin />);
      await screen.findAllByTestId('cmax-entry');
      fireEvent.click(screen.getByRole('button', { name: 'cmax.modeNormalized' }));
      expect((await screen.findByTestId('cmax-headline')).textContent).toContain('cmax.headlineSingleOne');

      vi.mocked(fetchParameterEntries).mockRejectedValueOnce(new Error('boom'));
      fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
      expect(await screen.findByText('cmax.staleError')).toBeTruthy();
      expect(screen.queryByText(/cmax\.headlineSingleOne/)).toBeNull();
      expect(screen.getByText('cmax.summaryError')).toBeTruthy();
      confirm.mockRestore();
    });

    // Codex P1 on #1387: the list and the summary were cached separately, so
    // after an edit one could be newer than the other. The per-dose view now
    // lists the rows the summary itself was computed from.
    it('lists the rows the summary was computed from, not a separately fetched list', async () => {
      store.push(cmaxRow({ id: 1 }), cmaxRow({ id: 2, sourceQuote: null, doseContext: { ...cmaxRow().doseContext!, centralValue: 90 } }));
      summaryItems = [cmaxRow({ id: 1 })];
      const a = poolable(1, 0.14);
      summary = { outcomes: [{ kind: 'poolable', entry: a }], strata: [stratum([a], 0.14)], headline: { kind: 'single', stratum: stratum([a], 0.14) } };
      render(<CmaxSection drugId={42} drugName="Kokain" />);
      await screen.findAllByTestId('cmax-entry');
      expect(screen.getAllByTestId('cmax-entry')).toHaveLength(2);
      fireEvent.click(screen.getByRole('button', { name: 'cmax.modeNormalized' }));
      await screen.findByTestId('cmax-headline');
      await waitFor(() => expect(screen.getAllByTestId('cmax-entry')).toHaveLength(1));
      // Every listed row has its outcome from the same snapshot.
      expect(screen.getAllByTestId('cmax-normalized')).toHaveLength(1);
    });

    // Codex on #1387: a failed delete dropped the summary and nothing fetched
    // it again, leaving the headline on "loading".
    it('fetches the summary again when a delete fails', async () => {
      store.push(cmaxRow({ id: 1 }));
      const a = poolable(1, 0.14);
      summary = { outcomes: [{ kind: 'poolable', entry: a }], strata: [stratum([a], 0.14)], headline: { kind: 'single', stratum: stratum([a], 0.14) } };
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<CmaxSection drugId={42} drugName="Kokain" canEdit isAdmin />);
      await screen.findAllByTestId('cmax-entry');
      fireEvent.click(screen.getByRole('button', { name: 'cmax.modeNormalized' }));
      expect((await screen.findByTestId('cmax-headline')).textContent).toContain('cmax.headlineSingleOne');

      vi.mocked(deleteParameterEntry).mockRejectedValueOnce(new Error('boom'));
      fireEvent.click(screen.getByRole('button', { name: 'common.delete' }));
      expect(await screen.findByText('cmax.actionError')).toBeTruthy();
      await waitFor(() =>
        expect(screen.getByTestId('cmax-headline').textContent).toContain('cmax.headlineSingleOne'),
      );
      confirm.mockRestore();
    });

    // Codex P1 on #1387: a delete that committed but lost its response left
    // the deleted row in Observed mode, because only the summary was refetched.
    it('reloads the rows after a failed delete, in case it committed', async () => {
      store.push(cmaxRow({ id: 1 }), cmaxRow({ id: 2, sourceQuote: null, doseContext: { ...cmaxRow().doseContext!, centralValue: 90 } }));
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      render(<CmaxSection drugId={42} drugName="Kokain" canEdit isAdmin />);
      await screen.findAllByTestId('cmax-entry');
      expect(screen.getAllByTestId('cmax-entry')).toHaveLength(2);

      // The server deletes row 2, but the response never arrives.
      vi.mocked(deleteParameterEntry).mockImplementationOnce(async () => {
        store.splice(1, 1);
        throw new Error('network');
      });
      fireEvent.click(screen.getAllByRole('button', { name: 'common.delete' })[1]!);
      expect(await screen.findByText('cmax.actionError')).toBeTruthy();
      await waitFor(() => expect(screen.getAllByTestId('cmax-entry')).toHaveLength(1));
      confirm.mockRestore();
    });

    it('rounds normalized values to three significant digits', () => {
      expect(formatNormalized(0.013872)).toBe('0.0139');
      expect(formatNormalized(1.5)).toBe('1.5');
      expect(formatNormalized(240.4)).toBe('240');
    });
  });
});
