import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionsAdminSection } from './PermissionsAdminSection';
import { useAuthStore } from '@/stores/authStore';

const translate = (key: string, opts?: Record<string, unknown>) =>
  opts && 'count' in opts ? `${key}:${opts.count}` : key;
const i18nStub = { language: 'en' };
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: i18nStub }),
}));
vi.mock('@/lib/toast', () => ({ showToast: vi.fn() }));

const MATRIX = {
  overrides: {},
  rows: [
    {
      capability: 'review.edit.decide',
      minTier: 'editor',
      isDefault: true,
      updatedAt: null,
      updatedBy: null,
    },
    {
      capability: 'edit.directWrite',
      minTier: 'admin',
      isDefault: true,
      updatedAt: null,
      updatedBy: null,
    },
  ],
  history: [],
};

/** The cell button for one (capability, tier) pair. */
function cell(capability: string, tier: string): HTMLElement {
  return screen.getByLabelText(
    `admin.permissions.capabilities.${capability.replace(/\./g, '_')} — admin.permissions.tiers.${tier}`,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => MATRIX,
    })),
  );
  useAuthStore.setState({ permissionOverrides: {} });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PermissionsAdminSection', () => {
  it('renders every capability grouped, with the granted tiers checked', async () => {
    render(<PermissionsAdminSection />);

    await waitFor(() =>
      expect(
        screen.getByText('admin.permissions.capabilities.review_edit_decide'),
      ).toBeInTheDocument(),
    );

    // Default is editor: editor and admin hold it, contributor does not.
    expect(cell('review.edit.decide', 'editor')).toHaveTextContent('✓');
    expect(cell('review.edit.decide', 'admin')).toHaveTextContent('✓');
    expect(cell('review.edit.decide', 'contributor')).toHaveTextContent('—');
  });

  it('disables cells below the floor and every cell of a locked capability', async () => {
    render(<PermissionsAdminSection />);
    await waitFor(() =>
      expect(
        screen.getByText('admin.permissions.capabilities.edit_directWrite'),
      ).toBeInTheDocument(),
    );

    // edit.directWrite floors at editor.
    expect(cell('edit.directWrite', 'contributor')).toBeDisabled();
    expect(cell('edit.directWrite', 'editor')).toBeEnabled();

    // admin.permissions.manage is locked.
    expect(cell('admin.permissions.manage', 'editor')).toBeDisabled();
    expect(cell('admin.permissions.manage', 'admin')).toBeDisabled();
  });

  it('fills in every tier above the one clicked and counts the change', async () => {
    render(<PermissionsAdminSection />);
    await waitFor(() =>
      expect(
        screen.getByText('admin.permissions.capabilities.review_edit_decide'),
      ).toBeInTheDocument(),
    );

    fireEvent.click(cell('review.edit.decide', 'contributor'));

    expect(cell('review.edit.decide', 'contributor')).toHaveTextContent('✓');
    expect(cell('review.edit.decide', 'editor')).toHaveTextContent('✓');
    expect(cell('review.edit.decide', 'admin')).toHaveTextContent('✓');
    expect(cell('review.edit.decide', 'authenticated')).toHaveTextContent('—');
    expect(screen.getByText('admin.permissions.unsaved:1')).toBeInTheDocument();
  });

  it('does not save until asked, then sends only the changed rows', async () => {
    render(<PermissionsAdminSection />);
    await waitFor(() =>
      expect(
        screen.getByText('admin.permissions.capabilities.review_edit_decide'),
      ).toBeInTheDocument(),
    );

    fireEvent.click(cell('review.edit.decide', 'contributor'));
    expect(fetch).toHaveBeenCalledTimes(1); // the initial load only

    fireEvent.click(screen.getByText('admin.permissions.save'));

    await waitFor(() => {
      const patch = vi
        .mocked(fetch)
        .mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({
        changes: [
          { capability: 'review.edit.decide', minTier: 'contributor' },
        ],
      });
    });
  });

  it('sends null when a row is put back to its default', async () => {
    vi.mocked(fetch).mockImplementation(
      async () =>
        ({
          ok: true,
          json: async () => ({
            ...MATRIX,
            overrides: { 'review.edit.decide': 'contributor' },
            rows: MATRIX.rows.map((row) =>
              row.capability === 'review.edit.decide'
                ? {
                    ...row,
                    minTier: 'contributor',
                    isDefault: false,
                    updatedAt: '2026-02-01T10:00:00.000Z',
                    updatedBy: { id: 1, username: 'root' },
                  }
                : row,
            ),
          }),
        }) as unknown as Response,
    );

    render(<PermissionsAdminSection />);
    await waitFor(() =>
      expect(
        screen.getByText('admin.permissions.capabilities.review_edit_decide'),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getAllByText('admin.permissions.resetRow')[0]!);
    fireEvent.click(screen.getByText('admin.permissions.save'));

    await waitFor(() => {
      const patch = vi
        .mocked(fetch)
        .mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PATCH');
      expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual({
        changes: [{ capability: 'review.edit.decide', minTier: null }],
      });
    });
  });

  it('discards pending changes without calling the API', async () => {
    render(<PermissionsAdminSection />);
    await waitFor(() =>
      expect(
        screen.getByText('admin.permissions.capabilities.review_edit_decide'),
      ).toBeInTheDocument(),
    );

    fireEvent.click(cell('review.edit.decide', 'contributor'));
    fireEvent.click(screen.getByText('admin.permissions.discard'));

    expect(cell('review.edit.decide', 'contributor')).toHaveTextContent('—');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
