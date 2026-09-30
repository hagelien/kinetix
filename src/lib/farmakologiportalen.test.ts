import { describe, expect, it } from 'vitest';
import {
  FARMAKOLOGIPORTALEN_BASE_URL,
  farmakologiportalenUrl,
} from './farmakologiportalen';

describe('farmakologiportalenUrl', () => {
  it('builds an absolute URL from a stored content path', () => {
    expect(farmakologiportalenUrl('/content/757/Morfin-3-glukuronid-M3G')).toBe(
      `${FARMAKOLOGIPORTALEN_BASE_URL}/content/757/Morfin-3-glukuronid-M3G`,
    );
  });

  it('tolerates surrounding whitespace', () => {
    expect(farmakologiportalenUrl('  /content/1/Alimemazin  ')).toBe(
      `${FARMAKOLOGIPORTALEN_BASE_URL}/content/1/Alimemazin`,
    );
  });

  it('returns null when no path is stored', () => {
    expect(farmakologiportalenUrl(null)).toBeNull();
    expect(farmakologiportalenUrl(undefined)).toBeNull();
    expect(farmakologiportalenUrl('')).toBeNull();
    expect(farmakologiportalenUrl('   ')).toBeNull();
  });

  it('rejects the id-only path, which is not a substance page', () => {
    // https://farmakologiportalen.no/content/757 answers 200 with a shell page
    // that names no substance — linking there would look like a working link.
    expect(farmakologiportalenUrl('/content/757')).toBeNull();
    expect(farmakologiportalenUrl('/content/757/')).toBeNull();
  });

  it('refuses anything that would move the link off the portal', () => {
    // The value reaches an href and originates from a scraped third-party
    // page, so a non-content path must never become the destination.
    expect(
      farmakologiportalenUrl('https://evil.example/content/1/Morfin'),
    ).toBeNull();
    expect(farmakologiportalenUrl('//evil.example/content/1/Morfin')).toBeNull();
    expect(farmakologiportalenUrl('javascript:alert(1)')).toBeNull();
    expect(farmakologiportalenUrl('/farma/search/substances')).toBeNull();
    expect(farmakologiportalenUrl('/content/abc/Morfin')).toBeNull();
    expect(farmakologiportalenUrl('content/757/Morfin')).toBeNull();
  });
});
