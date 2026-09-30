import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SiteSettingsAdminSection } from './SiteSettingsAdminSection';
import { SETTING } from '@/lib/siteSettings';

const translate = (key: string) => key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'en' } }),
}));

const { fetchMock, updateMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  updateMock: vi.fn(),
}));

vi.mock('@/lib/siteSettingsApi', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/siteSettingsApi')>(
      '@/lib/siteSettingsApi',
    );
  return {
    fetchSiteSettings: fetchMock,
    updateSiteSettings: updateMock,
    SiteSettingsApiError: actual.SiteSettingsApiError,
  };
});

const GATE = SETTING['referenceGate.blockUnreviewedCitations'];

function row(over: Record<string, unknown> = {}) {
  return {
    id: GATE,
    value: true,
    defaultValue: true,
    isDefault: true,
    group: 'review',
    enforcedAt: [],
    updatedAt: null,
    updatedBy: null,
    ...over,
  };
}

/** The provenance line is the last `<p>` in the switch's text column. */
function provenanceText(): string {
  const candidates = [
    'siteSettings.atDefault',
    'siteSettings.changedBy',
    'siteSettings.provenanceUnavailable',
  ];
  const found = candidates.filter((key) => screen.queryByText(key) !== null);
  // Exactly one of the three must render — they are mutually exclusive.
  expect(found).toHaveLength(1);
  return found[0]!;
}

describe('SiteSettingsAdminSection provenance line', () => {
  beforeEach(() => vi.clearAllMocks());

  it('says "at default" for an untouched switch', async () => {
    fetchMock.mockResolvedValue({ settings: { [GATE]: true }, rows: [row()] });
    render(<SiteSettingsAdminSection />);
    await waitFor(() => expect(provenanceText()).toBe('siteSettings.atDefault'));
  });

  it('names who changed a switch that deviates from its default', async () => {
    fetchMock.mockResolvedValue({
      settings: { [GATE]: false },
      rows: [
        row({
          value: false,
          isDefault: false,
          updatedAt: '2026-08-01T10:00:00.000Z',
          updatedBy: { id: 7, username: 'ada' },
        }),
      ],
    });
    render(<SiteSettingsAdminSection />);
    await waitFor(() =>
      expect(provenanceText()).toBe('siteSettings.changedBy'),
    );
  });

  it('does not claim "at default" when a save left provenance stale', async () => {
    // The save committed `false`, but its post-commit matrix read failed, so
    // the server answered `rows: null` and the component keeps the PRE-save
    // row — which still says isDefault. Trusting it would print "at its
    // shipped default" beside a toggle the admin can see is off.
    fetchMock.mockResolvedValue({ settings: { [GATE]: true }, rows: [row()] });
    updateMock.mockResolvedValue({ settings: { [GATE]: false }, rows: null });

    render(<SiteSettingsAdminSection />);
    await waitFor(() => expect(provenanceText()).toBe('siteSettings.atDefault'));

    screen.getByRole('checkbox').click();

    await waitFor(() =>
      expect(provenanceText()).toBe('siteSettings.provenanceUnavailable'),
    );
  });

  it('withholds the switches entirely when the initial load fails', async () => {
    // Falling back to the registry defaults would paint the gate in its `true`
    // position while the stored policy may be `false`, and the control would be
    // live. Nothing authoritative loaded, so nothing is asserted.
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));
    render(<SiteSettingsAdminSection />);

    await waitFor(() =>
      expect(screen.getByText('siteSettings.errors.unloaded')).toBeTruthy(),
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText('siteSettings.atDefault')).toBeNull();
    expect(screen.getByText('siteSettings.retry')).toBeTruthy();
  });

  it('shows the switches once a retry succeeds', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    fetchMock.mockResolvedValue({ settings: { [GATE]: false }, rows: [] });

    render(<SiteSettingsAdminSection />);
    await waitFor(() =>
      expect(screen.getByText('siteSettings.retry')).toBeTruthy(),
    );

    screen.getByText('siteSettings.retry').click();

    await waitFor(() =>
      expect(screen.getByRole('checkbox')).toHaveProperty('checked', false),
    );
  });

  it('withholds the switch when a save outcome is wholly indeterminate', async () => {
    // Gate off; admin toggles it on; the PATCH fails AND the re-read fails.
    // The optimistic `true` must not survive as if it were the live policy —
    // the guard may well still be disabled.
    fetchMock.mockResolvedValueOnce({ settings: { [GATE]: false }, rows: [] });
    updateMock.mockRejectedValue(new Error('ECONNRESET'));
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    render(<SiteSettingsAdminSection />);
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy());

    screen.getByRole('checkbox').click();

    await waitFor(() =>
      expect(screen.getByText('siteSettings.errors.unconfirmed')).toBeTruthy(),
    );
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('clears the error when a lost response turns out to have committed', async () => {
    // The PATCH response was lost after the write committed; the re-read shows
    // the requested value. Saying "could not be saved" would be as wrong as
    // reverting the toggle.
    fetchMock.mockResolvedValueOnce({ settings: { [GATE]: true }, rows: [] });
    updateMock.mockRejectedValue(new Error('ECONNRESET'));
    fetchMock.mockResolvedValue({ settings: { [GATE]: false }, rows: [] });

    render(<SiteSettingsAdminSection />);
    await waitFor(() =>
      expect(screen.getByRole('checkbox')).toHaveProperty('checked', true),
    );

    screen.getByRole('checkbox').click();

    await waitFor(() =>
      expect(screen.getByRole('checkbox')).toHaveProperty('checked', false),
    );
    expect(screen.queryByText('siteSettings.errors.generic')).toBeNull();
    expect(screen.queryByText('siteSettings.errors.notApplied')).toBeNull();
  });

  it('says the save did not apply when the re-read shows the old value', async () => {
    fetchMock.mockResolvedValueOnce({ settings: { [GATE]: true }, rows: [] });
    updateMock.mockRejectedValue(new Error('ECONNRESET'));
    fetchMock.mockResolvedValue({ settings: { [GATE]: true }, rows: [] });

    render(<SiteSettingsAdminSection />);
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeTruthy());

    screen.getByRole('checkbox').click();

    await waitFor(() =>
      expect(screen.getByText('siteSettings.errors.notApplied')).toBeTruthy(),
    );
    // And the switch shows the server's value, not the optimistic one.
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', true);
  });

  it('does not show a superseded changer after reverting to the default', async () => {
    // Mirror case: the switch was off with provenance; the admin turns it back
    // on and the provenance read fails. The old "changed by ada" row must not
    // survive as if it described the current state.
    fetchMock.mockResolvedValue({
      settings: { [GATE]: false },
      rows: [
        row({
          value: false,
          isDefault: false,
          updatedAt: '2026-08-01T10:00:00.000Z',
          updatedBy: { id: 7, username: 'ada' },
        }),
      ],
    });
    updateMock.mockResolvedValue({ settings: { [GATE]: true }, rows: null });

    render(<SiteSettingsAdminSection />);
    await waitFor(() =>
      expect(provenanceText()).toBe('siteSettings.changedBy'),
    );

    screen.getByRole('checkbox').click();

    await waitFor(() => expect(provenanceText()).toBe('siteSettings.atDefault'));
  });
});
