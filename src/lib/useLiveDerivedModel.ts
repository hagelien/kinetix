import { useEffect, useSyncExternalStore } from 'react';
import {
  awaitingLiveDerivedModel,
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
 */
export function useLiveDerivedModel(slug: string | undefined): boolean {
  useSyncExternalStore(subscribeLiveDerivedModels, liveDerivedModelsVersion);
  useEffect(() => {
    void refreshLiveDerivedModel(slug);
  }, [slug]);
  return awaitingLiveDerivedModel(slug);
}
