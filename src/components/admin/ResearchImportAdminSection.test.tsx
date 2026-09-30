import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResearchImportAdminSection } from './ResearchImportAdminSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
});
