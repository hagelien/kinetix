import { STORAGE_KEYS } from '@/types';

export function getStoredValue(key: string, legacyKeys: string[] = []): string | null {
  const candidates = [key, ...legacyKeys];

  try {
    for (const candidate of candidates) {
      const stored = localStorage.getItem(candidate);
      if (stored === null) continue;

      if (candidate !== key) {
        localStorage.setItem(key, stored);
        localStorage.removeItem(candidate);
      }

      for (const legacyKey of legacyKeys) {
        if (legacyKey !== candidate) {
          localStorage.removeItem(legacyKey);
        }
      }

      return stored;
    }
  } catch (err) {
    console.warn('Unable to read stored data', err);
  }

  return null;
}

export function setStoredValue(key: string, value: string, legacyKeys: string[] = []): void {
  try {
    localStorage.setItem(key, value);
    for (const legacyKey of legacyKeys) {
      localStorage.removeItem(legacyKey);
    }
  } catch (err) {
    console.warn('Unable to persist data', err);
  }
}

export function removeStoredValues(key: string, legacyKeys: string[] = []): void {
  try {
    localStorage.removeItem(key);
    for (const legacyKey of legacyKeys) {
      localStorage.removeItem(legacyKey);
    }
  } catch (err) {
    console.warn('Unable to clear stored data', err);
  }
}

export function loadJSON<T>(key: string, fallback: T, legacyKeys: string[] = []): T {
  try {
    const stored = getStoredValue(key, legacyKeys);
    if (!stored) return fallback;
    return JSON.parse(stored) as T;
  } catch (err) {
    console.warn('Unable to parse stored data', err);
    return fallback;
  }
}

export function persist<T>(key: string, value: T, legacyKeys: string[] = []): void {
  try {
    setStoredValue(key, JSON.stringify(value), legacyKeys);
  } catch (err) {
    console.warn('Unable to persist data', err);
  }
}

export function loadTextScale(): number {
  return loadJSON(STORAGE_KEYS.textScale, 0.95, ['fjelltox.textScale']);
}

export function saveTextScale(scale: number): void {
  persist(STORAGE_KEYS.textScale, scale, ['fjelltox.textScale']);
}

/**
 * The unit-conversion column is opt-in rather than part of the standard
 * substance-register view. Column sets persisted while it was still on by
 * default keep re-showing it, so strip it once — and remember that we did, so
 * a user who deliberately ticks it back on in the column picker keeps it.
 */
function retireConversionColumn(columns: string[]): string[] {
  // No persisted preference: the defaults already leave the column out.
  if (columns.length === 0) return columns;
  if (getStoredValue(STORAGE_KEYS.drugTableConversionColumnRetired) !== null) {
    return columns;
  }

  setStoredValue(STORAGE_KEYS.drugTableConversionColumnRetired, 'true');
  const kept = columns.filter((id) => id !== 'conversion');
  if (kept.length !== columns.length) saveTableColumns(kept);
  return kept;
}

export function loadTableColumns(): string[] {
  const stored = loadJSON<string[]>(STORAGE_KEYS.drugTableColumns, [], ['fjelltox.drugTable.columns']);
  if (!Array.isArray(stored)) return [];
  return retireConversionColumn(stored);
}

export function saveTableColumns(columns: string[]): void {
  persist(STORAGE_KEYS.drugTableColumns, columns, ['fjelltox.drugTable.columns']);
  // Anything written by this build already treats unit conversion as opt-in, so
  // the retirement above must never strip a later, deliberate opt-in.
  setStoredValue(STORAGE_KEYS.drugTableConversionColumnRetired, 'true');
}
