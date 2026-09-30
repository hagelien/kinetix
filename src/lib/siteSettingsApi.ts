import type { SiteSettingId, SiteSettings } from './siteSettings';

/** One switch as the admin panel sees it: value, default and provenance. */
export interface SiteSettingRow {
  id: SiteSettingId;
  value: boolean;
  defaultValue: boolean;
  isDefault: boolean;
  group: string;
  enforcedAt: string[];
  updatedAt: string | null;
  updatedBy: { id: number; username: string } | null;
}

export interface SiteSettingsResponse {
  settings: SiteSettings;
  /**
   * Provenance for every switch, or null when the server could not re-read it
   * after a save. Null means "unchanged, not unknown-and-empty" — the caller
   * should keep the rows it already has rather than clearing them.
   */
  rows: SiteSettingRow[] | null;
}

/**
 * A failed settings request, carrying the server's stable `code` rather than
 * its English prose (AGENTS.md i18n rule: server strings that reach the UI are
 * codes translated at the React boundary). `code` is null when the response
 * carried none — the caller falls back to a generic translated message.
 */
export class SiteSettingsApiError extends Error {
  constructor(
    readonly code: string | null,
    readonly status: number,
    /** English prose from the server, for the console — never rendered. */
    readonly detail: string | null,
  ) {
    super(detail ?? code ?? `Request failed (${status})`);
    this.name = 'SiteSettingsApiError';
  }
}

async function apiFetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new SiteSettingsApiError(
      typeof data.code === 'string' ? data.code : null,
      res.status,
      typeof data.error === 'string' ? data.error : null,
    );
  }
  return data as T;
}

export async function fetchSiteSettings(): Promise<SiteSettingsResponse> {
  return apiFetch('/api/admin?resource=settings');
}

/**
 * Patch only the switches that changed; the rest keep their stored value.
 * Answers with the same shape as {@link fetchSiteSettings}, so a save needs no
 * follow-up read to refresh the "changed by" line.
 */
export async function updateSiteSettings(
  changes: Partial<Record<SiteSettingId, boolean>>,
): Promise<SiteSettingsResponse> {
  return apiFetch('/api/admin?resource=settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings: changes }),
  });
}
