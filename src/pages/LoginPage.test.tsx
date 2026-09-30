import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import '@/i18n';
import { LoginPage } from './LoginPage';
import { useAuthStore } from '@/stores/authStore';

describe('LoginPage', () => {
  const requestMagicLink = vi.fn<() => Promise<string>>();

  beforeEach(() => {
    requestMagicLink.mockReset();
    requestMagicLink.mockResolvedValue('Check your inbox for a sign-in code.');

    useAuthStore.setState({
      user: null,
      isLoading: false,
      isAuthenticated: false,
      checkAuth: vi.fn().mockResolvedValue(undefined),
      requestMagicLink,
      verifyCode: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('escapes interpolated email content in the code-sent banner', async () => {
    const maliciousEmail = '\"><img src=x onerror=alert(1)>@example.com';
    const { container } = render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );

    const emailInput = container.querySelector('#email');
    expect(emailInput).not.toBeNull();

    fireEvent.change(emailInput as HTMLInputElement, {
      target: { value: maliciousEmail },
    });
    const form = container.querySelector('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    await waitFor(() => {
      expect(requestMagicLink).toHaveBeenCalledWith(maliciousEmail, false);
    });

    const escapedEmail = container.querySelector('strong');
    expect(escapedEmail).not.toBeNull();
    expect(escapedEmail?.textContent).toContain(
      '&lt;img src=x onerror=alert(1)>@example.com',
    );
    expect(escapedEmail?.textContent).not.toContain('<img');
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });

  it('returns the user to the originally-requested path after sign-in (#310 P2)', async () => {
    const verifyCode = vi.fn().mockResolvedValue(undefined);
    const checkAuth = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({
      verifyCode,
      checkAuth,
      requestMagicLink,
    });

    const { container } = render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/login',
            state: { from: { pathname: '/wiki/morphine', search: '?lang=en' } },
          },
        ]}
      >
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/wiki/:slug" element={<div>WIKI_PAGE</div>} />
          <Route path="/" element={<div>DRUG_TABLE</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.change(container.querySelector('#email') as HTMLInputElement, {
      target: { value: 'alice@kinetix.no' },
    });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);
    await waitFor(() => expect(requestMagicLink).toHaveBeenCalled());

    // Fill the 6-digit code; auto-submits on the last digit.
    const inputs = container.querySelectorAll('input[inputmode="numeric"]');
    expect(inputs.length).toBe(6);
    await act(async () => {
      for (let i = 0; i < 6; i++) {
        fireEvent.change(inputs[i] as HTMLInputElement, {
          target: { value: String(i) },
        });
      }
    });

    await waitFor(() => {
      expect(verifyCode).toHaveBeenCalledWith(
        'alice@kinetix.no',
        '012345',
        false,
      );
    });
    await waitFor(() => {
      expect(container.textContent).toContain('WIKI_PAGE');
    });
    expect(container.textContent).not.toContain('DRUG_TABLE');
  });

  it('redirects an already-authenticated visitor to state.from', async () => {
    useAuthStore.setState({ isAuthenticated: true, isLoading: false });

    const { container } = render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: '/login',
            state: { from: { pathname: '/simulator' } },
          },
        ]}
      >
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/simulator" element={<div>SIMULATOR</div>} />
          <Route path="/" element={<div>DRUG_TABLE</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(container.textContent).toContain('SIMULATOR');
    });
  });
});
