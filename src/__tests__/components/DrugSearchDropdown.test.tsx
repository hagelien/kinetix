import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DrugSearchDropdown } from '@/components/DrugSearchDropdown';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'nb' },
  }),
}));

describe('DrugSearchDropdown', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('queries the slim search endpoint and returns the selected drug', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        drugs: [
          {
            id: 42,
            slug: 'alprazolam',
            names: { nb: 'Alprazolam', en: 'Alprazolam' },
            nameShort: null,
            aliases: [],
            pubchemCid: 2118,
          },
        ],
      }),
    });

    const onSelect = vi.fn().mockResolvedValue(undefined);
    render(<DrugSearchDropdown onSelect={onSelect} maxResults={7} />);

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'alp' },
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/drugs?view=search&q=alp&limit=7',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    fireEvent.click(await screen.findByText('alprazolam'));

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          id: '2118',
          names: { nb: 'Alprazolam', en: 'Alprazolam' },
          _dbId: 42,
        }),
      );
    });
  });
});
