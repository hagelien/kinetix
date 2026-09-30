import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ReviewPage } from '@/pages/ReviewPage';
import { useAuthStore } from '@/stores/authStore';
import { fetchPendingEdits } from '@/lib/pendingEditsApi';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values?.count != null ? `${key} ${values.count}` : key,
  }),
}));

vi.mock('@/lib/pendingEditsApi', () => ({
  fetchPendingEdits: vi.fn(),
}));

vi.mock('@/components/review/PendingEditCard', () => ({
  PendingEditCard: () => <div data-testid="pending-edit-card" />,
}));

function setEditorUser() {
  useAuthStore.setState({
    user: {
      id: 1,
      email: 'editor@example.com',
      username: 'editor',
      role: 'editor',
      displayName: null,
      enabledConcentrationUnits: ['mg/L', 'ng/mL'],
      notificationSettings: null,
      favoriteParameters: [],
    },
    isAuthenticated: true,
    isLoading: false,
  });
}

describe('ReviewPage', () => {
  const originalAuthState = useAuthStore.getState();
  const fetchMock = vi.mocked(fetchPendingEdits);

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ pendingEdits: [] });
    setEditorUser();
  });

  afterEach(() => {
    useAuthStore.setState(originalAuthState);
  });

  it('filters review queue to atomic fact edits', async () => {
    await act(async () => {
      render(
        <MemoryRouter>
          <ReviewPage />
        </MemoryRouter>,
      );
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'pending',
          editType: undefined,
        }),
      );
    });
    await screen.findByText('review.noMatch');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'review.newFacts' }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'pending',
          editType: 'wiki_fact',
        }),
      );
    });
  });
});
