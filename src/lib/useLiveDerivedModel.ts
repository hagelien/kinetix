import { useEffect, useSyncExternalStore } from 'react';
import {
  awaitingLiveDerivedModel,
  liveDerivedModelExpiresAt,
  liveDerivedModelsVersion,
  refreshLiveDerivedModel,
  subscribeLiveDerivedModels,
} from '@/lib/liveDerivedModels';

/**
 * Load a catalogue drug's live derived model as soon as its panel is shown, and re-render when that
 * answer (or a later one fetched by a run) changes what the registry resolves.
 *
 * The run refreshes the live model before it resolves anything (`runComponent`), so a dose-route
 * picker read straight off the registry would otherwise show the committed snapshot's routes until
 * after the first run — and a new dose could start on a route the refreshed model then refuses.
 * Returns whether the drug is still waiting on its first live answer, so the panel can hold back a
 * new dose until the picker and the run resolve the same model (at most `LIVE_MODEL_TIMEOUT_MS`).
 *
 * While the panel stays open it asks again each time the trusted outcome ages out
 * (`LIVE_MODEL_TTL_MS`), so a route the catalogue has since dropped stops being offered without
 * waiting for a run to fetch the new model and refuse a dose the picker just allowed.
 */
export function useLiveDerivedModel(slug: string | undefined): boolean {
  useSyncExternalStore(subscribeLiveDerivedModels, liveDerivedModelsVersion);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // After each refresh settles (or finds the outcome still trusted, e.g. a run fetched it),
    // wait until that outcome ages out and ask again. Nothing to wait for (no slug, the reviewed
    // tier claims it, the derived tier is off) ends the loop.
    const scheduleNext = () => {
      if (cancelled) return;
      const expiresAt = liveDerivedModelExpiresAt(slug);
      const delay = expiresAt === undefined ? 0 : expiresAt - Date.now();
      // A refresh that has just settled leaves an outcome trusted into the future; anything else
      // would only spin, so stop rather than re-arm a zero-delay timer.
      if (delay <= 0) return;
      timer = setTimeout(() => {
        void refreshLiveDerivedModel(slug).then(scheduleNext);
      }, delay);
    };
    void refreshLiveDerivedModel(slug).then(scheduleNext);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [slug]);
  return awaitingLiveDerivedModel(slug);
}
