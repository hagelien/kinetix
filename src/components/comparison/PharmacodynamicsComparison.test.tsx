import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { PharmacodynamicsComparison } from './PharmacodynamicsComparison';
import type { DrugReceptorTargetSummary } from '@/lib/receptorTargets';

const translate = (key: string) => key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'nb' } }),
}));

const MOR = {
  id: 10,
  slug: 'oprm1',
  symbol: 'OPRM1',
  name: 'Mu opioid receptor',
  nameEn: 'Mu opioid receptor',
  targetClass: 'receptor',
  organism: 'Homo sapiens',
};

function mechanism(
  drugId: number,
  overrides: Partial<DrugReceptorTargetSummary>,
): DrugReceptorTargetSummary {
  return {
    id: drugId,
    drugId,
    receptorTargetId: MOR.id,
    interactionType: 'agonist',
    tier: 'primary',
    affinity: null,
    potency: null,
    efficacy: null,
    ki: null,
    ic50: null,
    ec50: null,
    emax: null,
    selectivityRatio: null,
    assaySpecies: null,
    referenceIds: [],
    evidenceNote: null,
    target: MOR,
    ...overrides,
  };
}

const { fetchDrugById } = vi.hoisted(() => ({ fetchDrugById: vi.fn() }));
vi.mock('@/lib/drugApi', () => ({ fetchDrugById }));

fetchDrugById.mockImplementation(async (id: number) => ({
  drug: {
    id,
    receptorTargets:
      id === 1
        ? [mechanism(1, { ki: { median: 0.49, unit: 'nM' } })]
        : [mechanism(2, { ki: { median: 0.0049, unit: 'µM' } })],
  },
}));

function Harness() {
  const [selected, setSelected] = useState<number[]>([]);
  return (
    <PharmacodynamicsComparison
      drugIds={[1, 2]}
      referenceDrugId={2}
      selectedTargetIds={selected}
      onToggleTarget={(id) => setSelected((s) => [...s, id])}
      drugName={(id) => (id === 1 ? 'isotonitazen' : 'morfin')}
    />
  );
}

describe('PharmacodynamicsComparison', () => {
  it('shows the receptor profile and compares a selected receptor', async () => {
    render(<Harness />);
    const chip = await screen.findByRole('button', { name: /OPRM1/ });
    // Matrix cells carry each drug's Ki in nM.
    expect(screen.getByText('Ki 0.49 nM')).toBeTruthy();
    expect(screen.getByText('Ki 4.9 nM')).toBeTruthy();

    fireEvent.click(chip);
    const card = (await screen.findByText('comparison.pd.relativeTo'))
      .closest('section') as HTMLElement;
    // isotonitazen binds 10x tighter than the reference (morfin).
    expect(within(card).getByText('10x')).toBeTruthy();
    expect(within(card).getByText('1x')).toBeTruthy();
  });

  it('draws no shared axis or ratio for values in incompatible units', async () => {
    fetchDrugById.mockImplementation(async (id: number) => ({
      drug: {
        id,
        receptorTargets: [
          mechanism(id, {
            potency:
              id === 1
                ? { median: 8.1, unit: 'pEC50' }
                : { median: 3, unit: 'nM' },
          }),
        ],
      },
    }));
    const { container } = render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /OPRM1/ }));
    const card = (await screen.findByText('comparison.pd.relativeTo'))
      .closest('section') as HTMLElement;
    expect(within(card).getByText('comparison.unitMismatch')).toBeTruthy();
    expect(container.querySelectorAll('.rounded-full.border-2')).toHaveLength(0);
    expect(within(card).queryByText(/\dx$/)).toBeNull();
  });

  it('keeps the loaded drugs when one basket drug can no longer be fetched', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchDrugById.mockImplementation(async (id: number) => {
      if (id === 1) throw new Error('Drug not found');
      return {
        drug: {
          id,
          receptorTargets: [mechanism(2, { ki: { median: 0.0049, unit: 'µM' } })],
        },
      };
    });
    render(<Harness />);
    expect(await screen.findByRole('button', { name: /OPRM1/ })).toBeTruthy();
    expect(screen.queryByText('comparison.pd.loadError')).toBeNull();
    consoleError.mockRestore();
  });

  it('falls back to a loaded drug when the reference drug fails to load', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchDrugById.mockImplementation(async (id: number) => {
      if (id === 2) throw new Error('Drug not found');
      return {
        drug: {
          id,
          receptorTargets: [mechanism(1, { ki: { median: 0.49, unit: 'nM' } })],
        },
      };
    });
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /OPRM1/ }));
    const card = (await screen.findByText('comparison.pd.relativeTo'))
      .closest('section') as HTMLElement;
    // Drug 2 (the chosen reference) is gone, so the loaded drug is the
    // reference and its own ratio is 1x rather than a dash.
    expect(within(card).getByText('1x')).toBeTruthy();
    consoleError.mockRestore();
  });

  it('shows a localized notice, not the raw error, when loading fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchDrugById.mockRejectedValue(new Error('Drug not found'));
    render(<Harness />);
    expect(await screen.findByText('comparison.pd.loadError')).toBeTruthy();
    expect(screen.queryByText('Drug not found')).toBeNull();
    consoleError.mockRestore();
  });
});
