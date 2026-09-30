/**
 * A metabolite belongs on one row, and the form has to say so before the API
 * does. The API's duplicate rejection is a hardcoded English 400, so leaving
 * this to the server puts English on a Norwegian editor's screen — and the
 * duplicate shape that actually reaches this form is the mixed one, where one
 * row links the substance and another spells its name as free text.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MetabolismEditForm } from './MetabolismEditForm';
import type { DrugMetabolism, DrugMetaboliteLink } from '@/lib/metabolism';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'metabolismEdit.save': 'Lagre',
        'metabolismEdit.metaboliteDuplicate': `duplikat: ${String(
          opts?.name ?? '',
        )}`,
        'metabolismEdit.precursorDuplicate': 'duplikat forløper',
      };
      return labels[key] ?? key;
    },
    i18n: { language: 'nb' },
  }),
}));

const submitDrugMetabolism = vi.fn(async () => ({ ok: true as const }));

vi.mock('@/lib/drugApi', () => ({
  ApiError: class ApiError extends Error {
    code?: string;
  },
  submitDrugMetabolism: (...args: unknown[]) =>
    (submitDrugMetabolism as unknown as (...a: unknown[]) => unknown)(...args),
  searchDrugs: vi.fn(async () => []),
}));

vi.mock('@/components/DrugSearchDropdown', () => ({
  DrugSearchDropdown: () => <div data-testid="drug-search" />,
}));
vi.mock('@/components/EnzymeSearchDropdown', () => ({
  EnzymeSearchDropdown: () => <div data-testid="enzyme-search" />,
}));
vi.mock('./ReferenceInput', () => ({
  ReferenceInput: () => <div data-testid="reference-input" />,
}));
vi.mock('@/lib/usePermissions', () => ({ useCan: () => true }));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));

function metaboliteLink(over: Partial<DrugMetaboliteLink>): DrugMetaboliteLink {
  return {
    id: 1,
    parentDrugId: 100,
    metaboliteDrugId: null,
    metaboliteName: 'Metabolitt',
    conversionFraction: null,
    activity: 'unknown',
    sortOrder: 0,
    evidenceNote: null,
    referenceIds: null,
    drug: null,
    ...over,
  };
}

function renderForm(metabolites: DrugMetaboliteLink[]) {
  const metabolism: DrugMetabolism = {
    routes: [],
    evidenceNote: null,
    metabolites,
    precursors: [],
  };
  render(
    <MetabolismEditForm
      drugId={100}
      drugName="Kokain"
      metabolism={metabolism}
      onClose={() => {}}
      onSaved={() => {}}
    />,
  );
}

beforeEach(() => {
  submitDrugMetabolism.mockClear();
});

describe('MetabolismEditForm — one row per substance', () => {
  it('refuses a free-text row spelling a linked row and says so in the user language', () => {
    renderForm([
      metaboliteLink({
        id: 1,
        metaboliteDrugId: 7,
        metaboliteName: 'benzoylecgonin',
        drug: {
          id: 7,
          slug: 'benzoylecgonin',
          names: { nb: 'benzoylecgonin', en: 'Benzoylecgonine' },
          pubchemCid: 2337,
        },
        sortOrder: 0,
      }),
      // Same substance, written out rather than linked — the two would render
      // as one line on the monograph.
      metaboliteLink({ id: 2, metaboliteName: 'benzoylecgonin', sortOrder: 1 }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));

    expect(screen.getByText('duplikat: benzoylecgonin')).toBeInTheDocument();
    expect(submitDrugMetabolism).not.toHaveBeenCalled();
  });

  it('lets two genuinely different metabolites through', async () => {
    renderForm([
      metaboliteLink({ id: 1, metaboliteName: 'Ecgonine', sortOrder: 0 }),
      metaboliteLink({
        id: 2,
        metaboliteName: 'Ecgonine methyl ester',
        sortOrder: 1,
      }),
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));

    await waitFor(() => expect(submitDrugMetabolism).toHaveBeenCalledTimes(1));
  });
});
