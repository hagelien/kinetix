/**
 * POST /api/wiki/pages answers a stable `code` next to its English `error`;
 * WikiNew turns the codes it knows into translated prose and throws that, so
 * the editor's error slot shows Norwegian to a Norwegian author. The editor
 * itself is stubbed: what is under test is the message WikiNew hands it.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WikiNew } from './WikiNew';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/AuthGuard', () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/lib/pendingEditsApi', () => ({
  fetchPendingEdits: vi.fn(),
  updatePendingEdit: vi.fn(),
}));

// Mirrors how WikiEditor reports a failed save: it renders the thrown
// Error's message.
vi.mock('@/components/wiki/WikiEditor', () => ({
  WikiEditor: ({
    onSave,
  }: {
    onSave: (
      title: string,
      content: unknown,
      editSummary: string | undefined,
      options: unknown,
      action: string,
    ) => Promise<void>;
  }) => {
    const [error, setError] = useState('');
    return (
      <div>
        <button
          type="button"
          onClick={() => {
            onSave(
              'Testolin',
              { type: 'doc', content: [] },
              undefined,
              {
                pageType: 'drug_monograph',
                newDrug: { names: { nb: 'Testolin' }, pubchemCid: 12 },
              },
              'publish',
            ).catch((err: Error) => setError(err.message));
          }}
        >
          save
        </button>
        {error && <p role="alert">{error}</p>}
      </div>
    );
  },
}));

function respond(status: number, body: unknown) {
  (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function renderAndSave() {
  render(
    <MemoryRouter initialEntries={['/wiki/new?type=drug_monograph']}>
      <WikiNew />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'save' }));
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WikiNew — create errors', () => {
  it('localizes a new drug whose PubChem CID shadows another drug', async () => {
    respond(409, {
      error:
        'PubChem CID 12 is also the internal id of drug 12, and saved cases key that drug by this number',
      code: 'pubchem_cid_shadows_drug_id',
    });
    renderAndSave();

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'errors.pubchemCidShadowsDrugId',
      ),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/api/wiki/pages',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('still maps the codes it already knew', async () => {
    respond(409, {
      error: 'Some parameters are not applicable',
      code: 'parameter_not_applicable',
    });
    renderAndSave();

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'wiki.parameterNotApplicable',
      ),
    );
  });

  it('falls back to the server message for a code it does not map', async () => {
    respond(409, { error: 'Some other refusal', code: 'something_else' });
    renderAndSave();

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Some other refusal'),
    );
  });
});
