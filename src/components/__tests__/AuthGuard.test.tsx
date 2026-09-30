import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthGuard } from '@/components/AuthGuard';
import { useAuthStore } from '@/stores/authStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));

function setAuthState(state: Partial<ReturnType<typeof useAuthStore.getState>>) {
  useAuthStore.setState({ ...useAuthStore.getState(), ...state });
}

function renderAt(path: string, requiredRole?: Parameters<typeof AuthGuard>[0]['requiredRole']) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/wiki"
          element={
            <AuthGuard requiredRole={requiredRole}>
              <div>WIKI_CONTENT</div>
            </AuthGuard>
          }
        />
        <Route path="/login" element={<div>LOGIN_PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AuthGuard route gating (#310 P2)', () => {
  const originalState = useAuthStore.getState();

  beforeEach(() => {
    setAuthState({ user: null, isAuthenticated: false, isLoading: false });
  });

  afterEach(() => {
    useAuthStore.setState(originalState);
  });

  it('redirects anonymous visitors to /login', () => {
    renderAt('/wiki');
    expect(screen.queryByText('WIKI_CONTENT')).toBeNull();
    expect(screen.getByText('LOGIN_PAGE')).toBeInTheDocument();
  });

  it('renders the protected route for authenticated users (no role gate)', () => {
    setAuthState({
      user: {
        id: 1,
        email: 'a@b.com',
        username: 'alice',
        role: 'authenticated',
        displayName: null,
        enabledConcentrationUnits: ['µmol/L', 'mg/L'],
        notificationSettings: null,
        favoriteParameters: [],
      },
      isAuthenticated: true,
      isLoading: false,
    });
    renderAt('/wiki');
    expect(screen.getByText('WIKI_CONTENT')).toBeInTheDocument();
  });

  it('blocks below-tier users when a requiredRole is set', () => {
    setAuthState({
      user: {
        id: 1,
        email: 'a@b.com',
        username: 'alice',
        role: 'authenticated',
        displayName: null,
        enabledConcentrationUnits: ['µmol/L', 'mg/L'],
        notificationSettings: null,
        favoriteParameters: [],
      },
      isAuthenticated: true,
      isLoading: false,
    });
    renderAt('/wiki', 'contributor');
    expect(screen.queryByText('WIKI_CONTENT')).toBeNull();
    expect(screen.getByText('auth.accessDenied')).toBeInTheDocument();
  });
});
