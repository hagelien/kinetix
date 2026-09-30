/**
 * The one thing this component must never do is show one drug's postmortem
 * percentiles under another drug's name. Monograph navigation goes drug → drug
 * without unmounting, so the guard has to be in the render path, not just in
 * the effect's cleanup.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import i18nApp from '@/i18n';
import { DrugPmConcentrations } from './DrugPmConcentrations';
import { useAuthStore } from '@/stores/authStore';
import { useAppStore } from '@/stores/appStore';
import {
  clearPmConcentrationCache,
  fetchPmConcentrationsByDrugIds,
} from '@/lib/pmConcentrationsApi';

vi.mock('@/lib/pmConcentrationsApi', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/pmConcentrationsApi')
  >('@/lib/pmConcentrationsApi');
  return {
    ...actual,
    fetchPmConcentrationsByDrugIds: vi.fn(),
  };
});

// Synthetic cohort: every name and number in this file is invented.
const SOURCE = {
  key: 'synthetic-test-cohort',
  citation: 'Syntetisk testkohort, oppdiktede tall (kun for tester)',
  shortLabel: 'Syntetisk',
  heading: 'Syntetiske postmortale testdata',
  matrix: 'postmortem_femoral_blood',
  unit: 'mg/L',
  description: '',
  caveats: [],
};

function distribution(drugId: number, analyte: string, median: number) {
  return {
    sourceKey: 'synthetic-test-cohort',
    drugId,
    pubchemCid: null,
    analyte,
    n: 100,
    loq: null,
    mean: null,
    median,
    p90: null,
    p95: null,
    p975: null,
    tcPlasma: null,
    medianOverTc: null,
    anomaly: null,
    undrawable: [],
    reviewNote: null,
    printed: {},
  };
}

function answer(drugId: number, analyte: string, median: number) {
  return {
    sources: [SOURCE],
    distributions: [distribution(drugId, analyte, median)],
    gated: false,
  };
}

const mocked = vi.mocked(fetchPmConcentrationsByDrugIds);

describe('DrugPmConcentrations', () => {
  // Per test, not once per file: another suite in this worker pins 'en' in
  // its own beforeEach, and i18n is a shared singleton — a beforeAll here is
  // silently undone by whatever runs in between.
  beforeEach(async () => {
    await i18nApp.changeLanguage('nb');
    clearPmConcentrationCache();
    mocked.mockReset();
    useAuthStore.setState({
      user: { id: 1, role: 'admin' },
    } as Parameters<typeof useAuthStore.setState>[0]);
    useAppStore.setState({ enabledUnits: ['mg/L'] });
  });

  afterEach(() => {
    useAuthStore.setState({ user: null } as Parameters<
      typeof useAuthStore.setState
    >[0]);
  });

  it('renders the cohort heading and the analyte row', async () => {
    mocked.mockResolvedValue(answer(1, 'Fictazepam', 0.125));

    render(<DrugPmConcentrations drugDbId={1} molecularWeight={250} />);

    await waitFor(() =>
      expect(
        screen.getByText('Syntetiske postmortale testdata'),
      ).toBeTruthy(),
    );
    expect(screen.getByText('Fictazepam')).toBeTruthy();
  });

  it('does not show the previous drug while the next one is loading', async () => {
    mocked.mockResolvedValue(answer(1, 'Fictazepam', 0.125));
    const { rerender } = render(
      <DrugPmConcentrations drugDbId={1} molecularWeight={250} />,
    );
    await waitFor(() => expect(screen.getByText('Fictazepam')).toBeTruthy());

    // Navigate to another monograph whose request never resolves.
    mocked.mockReturnValue(new Promise(() => {}));
    rerender(<DrugPmConcentrations drugDbId={2} molecularWeight={300} />);

    await waitFor(() => expect(screen.queryByText('Fictazepam')).toBeNull());
  });

  it('ignores a late answer that belongs to a drug we have navigated away from', async () => {
    type Answer = Awaited<ReturnType<typeof fetchPmConcentrationsByDrugIds>>;
    let resolveFirst: (value: Answer) => void = () => {};
    mocked.mockReturnValueOnce(
      new Promise<Answer>((resolve) => {
        resolveFirst = resolve;
      }),
    );
    const { rerender } = render(<DrugPmConcentrations drugDbId={1} />);

    mocked.mockResolvedValue(answer(2, 'Placebolol', 0.4));
    rerender(<DrugPmConcentrations drugDbId={2} />);
    await waitFor(() => expect(screen.getByText('Placebolol')).toBeTruthy());

    // The first drug's answer lands after we have moved on.
    resolveFirst(answer(1, 'Fictazepam', 0.125));

    await waitFor(() => expect(screen.getByText('Placebolol')).toBeTruthy());
    expect(screen.queryByText('Fictazepam')).toBeNull();
  });

  it("keeps the source's trailing zeros", async () => {
    // A float cannot carry them: 0.30 would render as 0,3 and quietly restate
    // the source's precision. The digits come from `printed`, the separator
    // from the locale.
    mocked.mockResolvedValue({
      sources: [SOURCE],
      distributions: [
        {
          ...distribution(1, 'Mockamine', 0.05),
          p95: 0.3,
          printed: { p95: '0.30' },
        },
      ],
      gated: false,
    });

    render(<DrugPmConcentrations drugDbId={1} />);

    await waitFor(() => expect(screen.getByText('Mockamine')).toBeTruthy());
    // Norwegian locale: the trailing zero is the source's, the comma is the
    // reader's. Both halves of the rule in one assertion.
    expect(screen.getByText('0,30 mg/L')).toBeTruthy();
  });

  it("shows concentrations in the reader's preferred unit with the source unit in the tooltip", async () => {
    useAppStore.setState({ enabledUnits: ['µmol/L', 'mg/L'] });
    mocked.mockResolvedValue({
      ...answer(1, 'Fictazepam', 0.125),
      distributions: [
        {
          ...distribution(1, 'Fictazepam', 0.125),
          printed: { median: '0.1250' },
        },
      ],
    });

    // 0.125 mg/L ÷ 300 g/mol × 1000 = 0.41667 µmol/L → 0,417 at three
    // significant figures.
    render(<DrugPmConcentrations drugDbId={1} molecularWeight={300} />);

    await waitFor(() => expect(screen.getByText('Fictazepam')).toBeTruthy());
    const preferredUnit = screen.getByText('µmol/L', { selector: '[tabindex="0"]' });
    expect(preferredUnit.closest('td')?.textContent).toContain('0,417 µmol/L');
    // The tooltip stacks each unit on its own row (split into separate spans
    // for decimal alignment), so the source figure is checked via the raw
    // DOM textContent rather than a single exact-text node.
    const tooltips = screen.getAllByRole('tooltip', { hidden: true });
    expect(
      tooltips.some((el) => el.textContent?.includes('0,1250 mg/L')),
    ).toBe(true);
  });

  it('suppresses source caveats only in the compact sidebar presentation', async () => {
    mocked.mockResolvedValue({
      ...answer(1, 'Fictazepam', 0.125),
      sources: [{ ...SOURCE, caveats: ['Skal ikke vises'] }],
    });

    render(<DrugPmConcentrations drugDbId={1} compact />);

    await waitFor(() => expect(screen.getByText('Fictazepam')).toBeTruthy());
    expect(screen.queryByText('Slik skal tallene leses')).toBeNull();
    expect(screen.queryByText('Skal ikke vises')).toBeNull();
  });

  it('retains source caveats in the full monograph presentation', async () => {
    mocked.mockResolvedValue({
      ...answer(1, 'Fictazepam', 0.125),
      sources: [{ ...SOURCE, caveats: ['Skal vises'] }],
    });

    render(<DrugPmConcentrations drugDbId={1} />);

    await waitFor(() => expect(screen.getByText('Fictazepam')).toBeTruthy());
    expect(screen.getByText('Slik skal tallene leses')).toBeTruthy();
    expect(screen.getByText('Skal vises')).toBeTruthy();
  });

  it('does not claim conversion when molecular weight is unavailable', async () => {
    useAppStore.setState({ enabledUnits: ['µmol/L', 'mg/L'] });
    mocked.mockResolvedValue(answer(1, 'Fictazepam', 0.125));

    render(<DrugPmConcentrations drugDbId={1} />);

    await waitFor(() => expect(screen.getByText('Fictazepam')).toBeTruthy());
    expect(screen.getByText('Enhet: mg/L')).toBeTruthy();
    expect(screen.queryByText('Enhet: mg/L → µmol/L')).toBeNull();
  });

  it('separates the postmortem and living-plasma column groups', async () => {
    // Flat, the TC cell reads as one more statistic from the autopsy cohort.
    mocked.mockResolvedValue(answer(1, 'Fictazepam', 0.125));

    render(<DrugPmConcentrations drugDbId={1} />);

    await waitFor(() => expect(screen.getByText('Fictazepam')).toBeTruthy());
    // The caption is sr-only and shares its wording with the group header, so
    // pick the header cell rather than the first match.
    const pm = screen
      .getAllByText('Postmortale konsentrasjoner (PM)')
      .find((el) => el.tagName === 'TH')!;
    const tc = screen.getByText('Terapeutisk konsentrasjon levende (TC)');
    expect(pm.getAttribute('colspan')).toBe('6');
    expect(tc.getAttribute('colspan')).toBe('2');
  });

  it('shows a readable matrix name, not the storage identifier', async () => {
    mocked.mockResolvedValue(answer(1, 'Fictazepam', 0.125));

    render(<DrugPmConcentrations drugDbId={1} />);

    await waitFor(() => expect(screen.getByText('Fictazepam')).toBeTruthy());
    expect(screen.getByText('Postmortalt femoralblod')).toBeTruthy();
    expect(screen.queryByText('postmortem_femoral_blood')).toBeNull();
  });

  it("does not file one cohort's numbers under another's heading", async () => {
    mocked.mockResolvedValue({
      sources: [
        SOURCE,
        {
          ...SOURCE,
          key: 'annen-kohort',
          heading: 'Annen postmortal kohort',
          citation: 'Annen kilde, 2024',
        },
      ],
      distributions: [
        distribution(1, 'Fictazepam', 0.125),
        { ...distribution(1, 'Fictazepam', 0.5), sourceKey: 'annen-kohort' },
      ],
      gated: false,
    });

    render(<DrugPmConcentrations drugDbId={1} />);

    // The section heading goes generic; each cohort states its own.
    await waitFor(() => expect(screen.getByText('Postmortale data')).toBeTruthy());
    expect(
      screen.getByText('Syntetiske postmortale testdata'),
    ).toBeTruthy();
    expect(screen.getByText('Annen postmortal kohort')).toBeTruthy();
  });

  it('renders nothing, and asks for nothing, without the capability', async () => {
    useAuthStore.setState({
      user: { id: 2, role: 'contributor' },
    } as Parameters<typeof useAuthStore.setState>[0]);

    const { container } = render(<DrugPmConcentrations drugDbId={1} />);

    expect(container.firstChild).toBeNull();
    expect(mocked).not.toHaveBeenCalled();
  });
});
