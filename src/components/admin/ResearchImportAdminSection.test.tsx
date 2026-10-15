import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResearchImportAdminSection } from './ResearchImportAdminSection';

import en from '@/locales/en.json';
import nb from '@/locales/nb.json';
const errorLocale = vi.hoisted(() => ({ language: 'en' as 'en' | 'nb' }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key === 'errors.blockReferenceMissing' ? (errorLocale.language === 'nb' ? nb : en).errors.blockReferenceMissing : key }),
}));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));

const VALID_JSON = JSON.stringify({
  schemaVersion: 'kinetix-deep-research-output-v1',
  drugIdentity: { names: { nb: 'Kokain' }, pubchemCid: 446220 },
  kinetixParameterValues: [
    { parameter: 'halfLife', status: 'finalized', value: { min: 1, max: 2, unit: 'h' }, sourceIds: [] },
  ],
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function typeInto(value: string) {
  const textarea = screen.getByPlaceholderText('admin.researchImport.placeholder');
  fireEvent.change(textarea, { target: { value } });
}

describe('ResearchImportAdminSection', () => {
  it('renders the title and disables Import until a preview succeeds', () => {
    render(<ResearchImportAdminSection />);
    expect(screen.getByText('admin.researchImport.title')).toBeInTheDocument();
    const importBtn = screen.getByText('admin.researchImport.import');
    expect(importBtn).toBeDisabled();
  });

  it('shows an error for invalid JSON without calling the API', () => {
    render(<ResearchImportAdminSection />);
    typeInto('{ not json');
    fireEvent.click(screen.getByText('admin.researchImport.preview'));
    expect(screen.getByText('admin.researchImport.invalidJson')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('previews via the API and then enables Import', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        dryRun: true,
        plan: {
          drug: { nameNb: 'Kokain', nameEn: null, pubchemCid: 446220 },
          parameters: [{ parameter: 'halfLife', sourceCount: 0 }],
          counts: {
            parameters: 1,
            sources: 0,
            pharmacodynamicTargets: 0,
            eliminationRoutes: 0,
            metabolites: 0,
            enzymeInteractions: 0,
          },
        },
        warnings: [],
      }),
    });

    render(<ResearchImportAdminSection />);
    typeInto(VALID_JSON);
    fireEvent.click(screen.getByText('admin.researchImport.preview'));

    await waitFor(() => expect(screen.getByText('Kokain', { exact: false })).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith('/api/research-import', expect.objectContaining({ method: 'POST' }));
    expect(screen.getByText('admin.researchImport.import')).not.toBeDisabled();
  });

  // Codex P1 on #300 (#12): the import writes without review, and a scoped
  // value is kept out of the pooled figure — the plan names each scope.
  it('names the formulation and population of each scoped source value in the plan', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        dryRun: true,
        plan: {
          drug: { nameNb: 'Oksymorfon', nameEn: null, pubchemCid: 5284604 },
          parameters: [
            {
              parameter: 'tmax',
              sourceCount: 2,
              scopes: [{ releaseProfile: 'modified', pkPopulation: 'elderly' }],
            },
          ],
          counts: {
            parameters: 1,
            sources: 2,
            pharmacodynamicTargets: 0,
            eliminationRoutes: 0,
            metabolites: 0,
            enzymeInteractions: 0,
          },
        },
        warnings: [],
      }),
    });

    render(<ResearchImportAdminSection />);
    typeInto(VALID_JSON);
    fireEvent.click(screen.getByText('admin.researchImport.preview'));

    await waitFor(() =>
      expect(
        screen.getByText(
          'tmax [2] (doseContext.values.releaseProfile.modified, doseContext.values.pkPopulation.elderly)',
        ),
      ).toBeInTheDocument(),
    );
  });

  it('surfaces server validation errors', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false, errors: ['drugIdentity: name required'] }),
    });

    render(<ResearchImportAdminSection />);
    typeInto(VALID_JSON);
    fireEvent.click(screen.getByText('admin.researchImport.preview'));

    await waitFor(() =>
      expect(screen.getByText('admin.researchImport.validationFailed')).toBeInTheDocument(),
    );
    expect(screen.getByText('drugIdentity: name required')).toBeInTheDocument();
  });
  // The shadow check runs on the write, not the dry-run: the preview passes
  // and the import itself is refused with 409 + a stable code.
  it('localizes a PubChem CID that shadows another drug instead of showing the server prose', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          dryRun: true,
          plan: {
            drug: { nameNb: 'Kokain', nameEn: null, pubchemCid: 446220 },
            parameters: [],
            counts: {
              parameters: 0,
              sources: 0,
              pharmacodynamicTargets: 0,
              eliminationRoutes: 0,
              metabolites: 0,
              enzymeInteractions: 0,
            },
          },
          warnings: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          error:
            'PubChem CID 446220 is also the internal id of drug 446220, and saved cases key that drug by this number',
          code: 'pubchem_cid_shadows_drug_id',
        }),
      });

    render(<ResearchImportAdminSection />);
    typeInto(VALID_JSON);
    fireEvent.click(screen.getByText('admin.researchImport.preview'));
    await waitFor(() =>
      expect(screen.getByText('admin.researchImport.import')).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByText('admin.researchImport.import'));

    await waitFor(() =>
      expect(screen.getByText('errors.pubchemCidShadowsDrugId')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/internal id of drug/)).not.toBeInTheDocument();
  });

  it('falls back to the server message for a code it does not map', async () => {
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'Some other refusal', code: 'something_else' }),
    });

    render(<ResearchImportAdminSection />);
    typeInto(VALID_JSON);
    fireEvent.click(screen.getByText('admin.researchImport.preview'));

    await waitFor(() => expect(screen.getByText('Some other refusal')).toBeInTheDocument());
  });
});

it.each(['en', 'nb'] as const)('translates a missing block reference on import in %s', async (language) => {
  errorLocale.language = language;
  (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 400,
    json: async () => ({ error: 'Hardcoded English missing reference', code: 'block_reference_missing' }),
  });
  render(<ResearchImportAdminSection />);
  typeInto(VALID_JSON);
  fireEvent.click(screen.getByText('admin.researchImport.preview'));
  expect(await screen.findByText((language === 'nb' ? nb : en).errors.blockReferenceMissing)).toBeInTheDocument();
  expect(screen.queryByText('Hardcoded English missing reference')).not.toBeInTheDocument();
});
