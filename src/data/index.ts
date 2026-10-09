import type { DrugComponent, AnalyticalMethod } from '@/types';
import type { RawComponent } from '../../data/components';
import { fetchDrugs, fetchMethods, drugRowToComponent } from '@/lib/drugApi';
import { buildDrugSearchKey } from '@/lib/drugNames';

let componentsCache: DrugComponent[] | null = null;
let methodsCache: AnalyticalMethod[] | null = null;
let componentsPromise: Promise<DrugComponent[]> | null = null;
let methodsPromise: Promise<AnalyticalMethod[]> | null = null;
// Bumped every time `clearMethodsCache()` runs (i.e. on every auth-state
// change). `loadMethods()` captures the epoch at the start of its fetch
// and discards the response if the cache was invalidated mid-flight, so
// an anonymous fetch already in flight when a user signs in can't
// overwrite the authenticated scope's data (and vice versa).
let methodsEpoch = 0;

function toComponentFromRaw(raw: RawComponent): DrugComponent {
  // The embedded fixture still uses the legacy `name` (Norwegian) +
  // `nameEn` shape. Project that into the new multilingual `names` map so
  // every consumer of `DrugComponent` sees the same structure regardless of
  // whether data came from the API or the fallback bundle.
  const names: Record<string, string> = {};
  if (raw.name) names.nb = raw.name;
  if (raw.nameEn) names.en = raw.nameEn;
  // The fixture's `RangeData` is structurally identical to `NumericRange`
  // ({ min, max, mean, median, unit, qualifier, note }), so each field
  // passes straight through. Carry every parameter the fixture holds —
  // including the forensic-toxicology concentration bands
  // (`therapeuticRange`/`toxicRange`/`lethalRange`), which map onto the
  // component's therapeutic/toxic/fatal concentrations. Dropping those
  // left the offline/degraded fallback showing PK params but none of the
  // interpretive tox thresholds this tool exists to surface.
  return {
    id: String(raw.pubchemCid),
    names,
    pubchemCid: raw.pubchemCid,
    molecularWeight: raw.molecularWeight,
    halfLife: raw.halfLife,
    volumeOfDistribution: raw.volumeOfDistribution,
    bioavailability: raw.bioavailability,
    proteinBinding: raw.proteinBinding,
    bloodPlasmaRatio: raw.bloodPlasmaRatio,
    tmax: raw.tmax,
    pKa: raw.pKa,
    therapeuticConcentration: raw.therapeuticRange,
    toxicConcentration: raw.toxicRange,
    fatalConcentration: raw.lethalRange,
    _searchKey: buildDrugSearchKey({
      names,
    }),
  };
}

async function fallbackComponents(): Promise<DrugComponent[]> {
  try {
    const { embeddedComponents } = await import('../../data/components');
    return embeddedComponents.map(toComponentFromRaw);
  } catch (err) {
    console.error('Failed to load embedded components fallback:', err);
    return [];
  }
}

export async function loadComponents(): Promise<DrugComponent[]> {
  if (componentsCache) return componentsCache;
  if (componentsPromise) return componentsPromise;

  componentsPromise = (async () => {
    try {
      const { drugs } = await fetchDrugs({ sort: 'popularity', limit: 1000 });
      if (drugs.length === 0) {
        componentsCache = await fallbackComponents();
      } else {
        componentsCache = drugs.map(drugRowToComponent);
      }
    } catch (err) {
      console.warn('Falling back to embedded components:', err);
      componentsCache = await fallbackComponents();
    }
    return componentsCache;
  })();
  const promise = componentsPromise;
  void promise.finally(() => {
    if (componentsPromise === promise) componentsPromise = null;
  });
  return promise;
}

export async function loadMethods(): Promise<AnalyticalMethod[]> {
  if (methodsCache) return methodsCache;
  if (methodsPromise) return methodsPromise;

  const epoch = methodsEpoch;
  methodsPromise = (async () => {
    let result: AnalyticalMethod[];
    try {
      const { methods, gated } = await fetchMethods();
      result =
        gated || methods.length === 0
          ? []
          : methods.map((m) => ({
              id: m.code,
              dbId: m.id,
              name: m.name,
              description: m.description ?? m.name,
              // DrugTable's method filter matches by component ids (drug.id which
              // we set to pubchemCid string); keep the same shape.
              components: m.pubchemCids.map(String),
              drugIds: m.drugIds,
              componentCount: m.componentCount,
              matrices: m.matrices,
            }));
    } catch (err) {
      console.warn('Failed to load analytical methods:', err);
      // Do NOT cache errors — a transient failure for an authorized user
      // would lock them into an empty filter until an auth-access flip or
      // hard reload, since `[]` is truthy and bypasses the early-return.
      if (epoch !== methodsEpoch) {
        return methodsCache ?? [];
      }
      return [];
    }
    // Auth state changed while this fetch was in flight — our result
    // reflects the previous scope and must not poison the cache. Return
    // whatever the current scope has produced (or `[]` until its own
    // fetch lands); the caller's subsequent setMethods call will be
    // superseded by the fresh-scope fetch's resolver.
    if (epoch !== methodsEpoch) {
      return methodsCache ?? [];
    }
    return (methodsCache = result);
  })();
  const promise = methodsPromise;
  void promise.finally(() => {
    if (methodsPromise === promise) methodsPromise = null;
  });
  return promise;
}

export function clearDataCache(): void {
  componentsCache = null;
  methodsCache = null;
  componentsPromise = null;
  methodsPromise = null;
}

// Methods are auth-gated (admin / group grant); the components catalog is not.
// Auth-state changes only need to drop the methods cache so a freshly
// signed-in (or signed-out) user re-fetches /api/methods instead of
// reusing the previous session's gated/ungated response. The epoch
// bump invalidates any fetch that's already in flight — see loadMethods.
export function clearMethodsCache(): void {
  methodsCache = null;
  methodsPromise = null;
  methodsEpoch += 1;
}
