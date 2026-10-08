import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CitationMergeAdminSection } from './CitationMergeAdminSection';

const translate = (key: string) => key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'en' } }),
}));

const { searchMock } = vi.hoisted(() => ({ searchMock: vi.fn() }));

vi.mock('@/lib/citationMergeApi', async () => {
  const actual = await vi.importActual<typeof import('@/lib/citationMergeApi')>(
    '@/lib/citationMergeApi',
  );
  return { ...actual, searchCitationsForMerge: searchMock };
});

describe('CitationMergeAdminSection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });
  afterEach(() => vi.useRealTimers());

  it('clears the searching indicator when the query is emptied mid-request', async () => {
    // Never resolves: the request is still in flight when the input is cleared.
    searchMock.mockReturnValue(new Promise(() => {}));
    render(<CitationMergeAdminSection />);
    const input = screen.getByRole('textbox');

    fireEvent.change(input, { target: { value: 'aspirin' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByText('admin.citationMerge.searching')).toBeInTheDocument();

    fireEvent.change(input, { target: { value: '' } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByText('admin.citationMerge.searching')).not.toBeInTheDocument();
  });
});
