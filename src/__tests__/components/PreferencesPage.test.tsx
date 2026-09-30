import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PreferencesPage } from '@/pages/PreferencesPage';
import { useAppStore } from '@/stores/appStore';
import { useAuthStore } from '@/stores/authStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

function setUser(user: ReturnType<typeof useAuthStore.getState>['user']) {
  useAuthStore.setState({
    user,
    isAuthenticated: !!user,
    isLoading: false,
  });
}

describe('PreferencesPage', () => {
  const fetchMock = vi.fn();
  const originalState = useAuthStore.getState();
  const originalAppState = useAppStore.getState();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    setUser({
      id: 1,
      email: 'a@b.com',
      username: 'alice',
      role: 'editor',
      displayName: null,
      enabledConcentrationUnits: ['µmol/L', 'mg/L'],
      notificationSettings: null,
      favoriteParameters: [],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState(originalState);
    useAppStore.setState(originalAppState);
  });

  function renderPage() {
    return render(
      <MemoryRouter>
        <PreferencesPage />
      </MemoryRouter>,
    );
  }

  it('hydrates the form from the auth store', () => {
    setUser({
      id: 1,
      email: 'a@b.com',
      username: 'alice',
      role: 'editor',
      displayName: 'Alice S.',
      enabledConcentrationUnits: ['mg/L', 'µmol/L'],
      notificationSettings: { emailWhenPendingEditReviewed: true },
      favoriteParameters: [],
    });

    renderPage();

    const nameInput = screen.getByPlaceholderText('alice') as HTMLInputElement;
    expect(nameInput.value).toBe('Alice S.');

    const primarySelect = screen.getByLabelText(
      'preferences.unitsPrimaryLabel',
    ) as HTMLSelectElement;
    expect(primarySelect.value).toBe('mg/L');

    const mgPerLBox = screen.getByLabelText('mg/L') as HTMLInputElement;
    expect(mgPerLBox.checked).toBe(true);
  });

  it('PATCHes preferences and applies the response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        preferences: {
          displayName: 'Alice S.',
          enabledConcentrationUnits: ['mg/L', 'µmol/L'],
          notificationSettings: {
            emailOnFeedback: true,
            emailAsReviewer: false,
            emailFrequency: 'weekly',
            emailLocale: 'nb',
          },
          favoriteParameters: [],
        },
      }),
    });

    renderPage();

    fireEvent.change(screen.getByPlaceholderText('alice'), {
      target: { value: 'Alice S.' },
    });
    fireEvent.change(screen.getByLabelText('preferences.unitsPrimaryLabel'), {
      target: { value: 'mg/L' },
    });
    // Opt in to feedback email and pick a weekly summary.
    const notifyLabel = screen
      .getByText('preferences.notify_feedback')
      .closest('label')!;
    fireEvent.click(notifyLabel.querySelector('input[type="checkbox"]')!);
    fireEvent.click(
      screen.getByLabelText('preferences.emailFrequency.weekly'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'preferences.save' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/preferences',
        expect.objectContaining({
          method: 'PATCH',
          body: expect.stringContaining('"displayName":"Alice S."'),
        }),
      );
    });

    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/preferences');
    expect(call).toBeDefined();
    const body = JSON.parse((call![1] as { body: string }).body);
    expect(body.enabledConcentrationUnits[0]).toBe('mg/L');
    expect(body.enabledConcentrationUnits).toContain('µmol/L');
    expect(body.notificationSettings).toEqual({
      emailOnFeedback: true,
      emailAsReviewer: false,
      emailFrequency: 'weekly',
      emailLocale: 'nb',
    });

    await waitFor(() => {
      const user = useAuthStore.getState().user;
      expect(user?.displayName).toBe('Alice S.');
      expect(user?.enabledConcentrationUnits[0]).toBe('mg/L');
      expect(user?.notificationSettings?.emailOnFeedback).toBe(true);
    });
  });

  it('starts with every email category off', () => {
    renderPage();
    const feedback = screen
      .getByText('preferences.notify_feedback')
      .closest('label')!
      .querySelector('input') as HTMLInputElement;
    expect(feedback.checked).toBe(false);
    const reviewer = screen
      .getByText('preferences.notify_reviewer')
      .closest('label')!
      .querySelector('input') as HTMLInputElement;
    expect(reviewer.checked).toBe(false);
    // Frequency is moot while nothing is switched on.
    expect(screen.getByLabelText('preferences.emailFrequency.daily')).toBeDisabled();
  });

  it('carries a legacy "email when reviewed" opt-in over to feedback email', () => {
    setUser({
      id: 1,
      email: 'a@b.com',
      username: 'alice',
      role: 'editor',
      displayName: null,
      enabledConcentrationUnits: ['µmol/L', 'mg/L'],
      notificationSettings: { emailWhenPendingEditReviewed: true },
      favoriteParameters: [],
    });
    renderPage();
    const feedback = screen
      .getByText('preferences.notify_feedback')
      .closest('label')!
      .querySelector('input') as HTMLInputElement;
    expect(feedback.checked).toBe(true);
  });

  it('keeps a stored reviewer-email opt-in when the reviewer control is not shown', async () => {
    setUser({
      id: 1,
      email: 'a@b.com',
      username: 'alice',
      role: 'contributor',
      displayName: null,
      enabledConcentrationUnits: ['µmol/L', 'mg/L'],
      notificationSettings: { emailAsReviewer: true, emailFrequency: 'daily' },
      favoriteParameters: [],
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        preferences: {
          displayName: null,
          enabledConcentrationUnits: ['µmol/L', 'mg/L'],
          notificationSettings: { emailAsReviewer: true, emailFrequency: 'daily' },
          favoriteParameters: [],
        },
      }),
    });

    renderPage();
    expect(screen.queryByText('preferences.notify_reviewer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'preferences.save' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/preferences', expect.anything());
    });
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/preferences');
    const body = JSON.parse((call![1] as { body: string }).body);
    expect(body.notificationSettings.emailAsReviewer).toBe(true);
  });

  it('updates the local theme preference', () => {
    useAppStore.setState({ themeMode: 'system' });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'theme.dark' }));

    expect(useAppStore.getState().themeMode).toBe('dark');
  });

  it('switches the fraction display to percent', () => {
    useAppStore.setState({ fractionDisplay: 'decimal' });

    renderPage();

    // The button label is the mocked translation key plus the worked example
    // ("30%"), which is what makes the choice self-explanatory in the UI.
    fireEvent.click(
      screen.getByRole('button', { name: 'preferences.fractionsPercent 30%' }),
    );

    expect(useAppStore.getState().fractionDisplay).toBe('percent');
  });

  it('marks the active fraction display with aria-pressed', () => {
    useAppStore.setState({ fractionDisplay: 'percent' });

    renderPage();

    expect(
      screen.getByRole('button', { name: 'preferences.fractionsPercent 30%' }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: 'preferences.fractionsDecimal 0.3' }),
    ).toHaveAttribute('aria-pressed', 'false');
  });

  it('clears displayName by sending null when the input is emptied', async () => {
    setUser({
      id: 1,
      email: 'a@b.com',
      username: 'alice',
      role: 'editor',
      displayName: 'Alice S.',
      enabledConcentrationUnits: ['µmol/L', 'mg/L'],
      notificationSettings: null,
      favoriteParameters: [],
    });

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        preferences: {
          displayName: null,
          enabledConcentrationUnits: ['µmol/L', 'mg/L'],
          notificationSettings: null,
          favoriteParameters: [],
        },
      }),
    });

    renderPage();

    const nameInput = screen.getByPlaceholderText('alice') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'preferences.save' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => c[0] === '/api/preferences',
      );
      expect(call).toBeDefined();
      const body = JSON.parse((call![1] as { body: string }).body);
      expect(body.displayName).toBeNull();
    });
  });

  it('surfaces the server error when the save fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: vi.fn().mockResolvedValue({ error: 'displayName: Too long' }),
    });

    renderPage();

    fireEvent.click(screen.getByRole('button', { name: 'preferences.save' }));

    expect(await screen.findByText('displayName: Too long')).toBeTruthy();
  });
});
