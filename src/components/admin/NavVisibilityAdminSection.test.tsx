import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavVisibilityAdminSection } from './NavVisibilityAdminSection';
import { NAV_ITEM_DEFS } from '@/lib/navItems';
import { useAuthStore } from '@/stores/authStore';

const translate = (key: string) => key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'en' } }),
}));

const { fetchMock, updateMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('@/lib/navVisibilityApi', async () => {
  const actual = await vi.importActual<typeof import('@/lib/navVisibilityApi')>(
    '@/lib/navVisibilityApi',
  );
  return {
    fetchHiddenNavItems: fetchMock,
    updateHiddenNavItem: updateMock,
    NavVisibilityApiError: actual.NavVisibilityApiError,
  };
});

const FIRST = NAV_ITEM_DEFS[0]!.id;
const SECOND = NAV_ITEM_DEFS[1]!.id;

function response(over: Record<string, unknown> = {}) {
  return { hiddenItems: [], updatedAt: null, updatedBy: null, ...over };
}

describe('NavVisibilityAdminSection', () => {
  const originalAuthState = useAuthStore.getState();

  beforeEach(() => vi.clearAllMocks());
  afterEach(() => useAuthStore.setState(originalAuthState));

  it('lists every nav item, none hidden by default', async () => {
    fetchMock.mockResolvedValue(response());
    render(<NavVisibilityAdminSection />);
    await waitFor(() =>
      expect(screen.getAllByRole('checkbox')).toHaveLength(
        NAV_ITEM_DEFS.length,
      ),
    );
    for (const checkbox of screen.getAllByRole('checkbox')) {
      expect(checkbox).toHaveProperty('checked', false);
    }
  });

  it('shows a stored item as hidden', async () => {
    fetchMock.mockResolvedValue(response({ hiddenItems: [FIRST] }));
    render(<NavVisibilityAdminSection />);
    await waitFor(() =>
      expect(screen.getAllByRole('checkbox')[0]).toHaveProperty(
        'checked',
        true,
      ),
    );
  });

  it('hides an item: PATCHes just that item', async () => {
    fetchMock.mockResolvedValue(response({ hiddenItems: [] }));
    updateMock.mockResolvedValue(response({ hiddenItems: [FIRST] }));
    render(<NavVisibilityAdminSection />);
    await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(
      NAV_ITEM_DEFS.length,
    ));

    screen.getAllByRole('checkbox')[0]!.click();

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith(FIRST, true));
  });

  it('unhides an item: PATCHes just that item', async () => {
    fetchMock.mockResolvedValue(response({ hiddenItems: [FIRST, SECOND] }));
    updateMock.mockResolvedValue(response({ hiddenItems: [SECOND] }));
    render(<NavVisibilityAdminSection />);
    await waitFor(() =>
      expect(screen.getAllByRole('checkbox')[0]).toHaveProperty(
        'checked',
        true,
      ),
    );

    screen.getAllByRole('checkbox')[0]!.click();

    await waitFor(() => expect(updateMock).toHaveBeenCalledWith(FIRST, false));
  });

  it('syncs the shared store after a save, so the header updates without a reload (Codex, review comment 4062137158)', async () => {
    fetchMock.mockResolvedValue(response({ hiddenItems: [] }));
    updateMock.mockResolvedValue(response({ hiddenItems: [FIRST] }));
    render(<NavVisibilityAdminSection />);
    await waitFor(() =>
      expect(screen.getAllByRole('checkbox')).toHaveLength(
        NAV_ITEM_DEFS.length,
      ),
    );
    expect(useAuthStore.getState().hiddenNavItems).toEqual([]);

    screen.getAllByRole('checkbox')[0]!.click();

    await waitFor(() =>
      expect(useAuthStore.getState().hiddenNavItems).toEqual([FIRST]),
    );
  });

  it('disables every switch while a save is in flight, not only the one changed (Codex, review comment 4062137152)', async () => {
    fetchMock.mockResolvedValue(response({ hiddenItems: [] }));
    let resolveUpdate!: (value: ReturnType<typeof response>) => void;
    updateMock.mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    render(<NavVisibilityAdminSection />);
    await waitFor(() =>
      expect(screen.getAllByRole('checkbox')).toHaveLength(
        NAV_ITEM_DEFS.length,
      ),
    );

    screen.getAllByRole('checkbox')[0]!.click();

    await waitFor(() => {
      for (const checkbox of screen.getAllByRole('checkbox')) {
        expect(checkbox).toHaveProperty('disabled', true);
      }
    });

    resolveUpdate(response({ hiddenItems: [FIRST] }));
    await waitFor(() =>
      expect(screen.getAllByRole('checkbox')[0]).toHaveProperty(
        'disabled',
        false,
      ),
    );
  });

  it('ignores a second toggle while one is already in flight', async () => {
    fetchMock.mockResolvedValue(response({ hiddenItems: [] }));
    updateMock.mockReturnValue(new Promise(() => {}));
    render(<NavVisibilityAdminSection />);
    await waitFor(() =>
      expect(screen.getAllByRole('checkbox')).toHaveLength(
        NAV_ITEM_DEFS.length,
      ),
    );

    const [first, second] = screen.getAllByRole('checkbox');
    first!.click();
    await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));

    // A disabled Radix switch still receives a raw DOM click in jsdom; the
    // handler itself must be the guard against a second, overlapping PATCH.
    second!.click();
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('withholds the list entirely when the initial load fails', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    render(<NavVisibilityAdminSection />);
    await waitFor(() =>
      expect(screen.getByText('navVisibility.errors.unloaded')).toBeTruthy(),
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText('navVisibility.retry')).toBeTruthy();
  });

  it('withholds the list when a save outcome is wholly indeterminate', async () => {
    fetchMock.mockResolvedValueOnce(response({ hiddenItems: [] }));
    updateMock.mockRejectedValue(new Error('ECONNRESET'));
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    render(<NavVisibilityAdminSection />);
    await waitFor(() =>
      expect(screen.getAllByRole('checkbox')).toHaveLength(
        NAV_ITEM_DEFS.length,
      ),
    );

    screen.getAllByRole('checkbox')[0]!.click();

    await waitFor(() =>
      expect(
        screen.getByText('navVisibility.errors.unconfirmed'),
      ).toBeTruthy(),
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('says the save did not apply when the re-read shows the old list', async () => {
    fetchMock.mockResolvedValueOnce(response({ hiddenItems: [] }));
    updateMock.mockRejectedValue(new Error('ECONNRESET'));
    fetchMock.mockResolvedValue(response({ hiddenItems: [] }));

    render(<NavVisibilityAdminSection />);
    await waitFor(() =>
      expect(screen.getAllByRole('checkbox')).toHaveLength(
        NAV_ITEM_DEFS.length,
      ),
    );

    screen.getAllByRole('checkbox')[0]!.click();

    await waitFor(() =>
      expect(
        screen.getByText('navVisibility.errors.notApplied'),
      ).toBeTruthy(),
    );
    expect(screen.getAllByRole('checkbox')[0]).toHaveProperty(
      'checked',
      false,
    );
  });
});
