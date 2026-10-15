/**
 * Fetch a catalogue drug's derived model live, before it is run.
 *
 * The committed derived artifact is a snapshot of what the catalogue built when it was last
 * regenerated. Asking the server for the drug's model as the catalogue builds it NOW
 * (`/api/derived-model`), and laying the answer over that snapshot (`installLiveDerivedEntry`),
 * means a value curated into the catalogue reaches the next run without a rebuilt artifact, a pull
 * request or a deploy.
 *
 * A failed fetch (an unreachable server, a non-OK answer other than 404, a timeout or a malformed
 * answer) changes nothing that is installed, and is remembered for the same `LIVE_MODEL_TTL_MS` as
 * an answer: nothing asks again until it has aged out (see "one model per window" below). What the
 * drug then resolves through depends on whether a live answer has arrived before:
 *
 * - before the first successful fetch for a slug, the committed snapshot is in force, so the drug
 *   resolves exactly as it would have before this existed;
 * - after one, the last live answer stays in force (an assembled model, or a withdrawal). It is
 *   never older than the committed snapshot, and falling back to the snapshot could bring back a
 *   model the catalogue has since withdrawn: a drug that no longer builds a model stops resolving
 *   rather than running on what it used to have, and an outage does not undo that.
 *
 * A slug the reviewed tier claims is never fetched; an override always wins.
 *
 * One model per window. The dose-route picker asks as soon as a drug's panel is shown, and the run
 * asks again before it resolves; both go through `refreshLiveDerivedModel`, which shares one
 * request in flight and then trusts its outcome — an answer OR a failure — for `LIVE_MODEL_TTL_MS`.
 * So a run inside that window resolves exactly the model the picker was built from: if the panel's
 * request failed, the run does not quietly retry and install a model whose routes the picker never
 * offered. Only once the window has passed does a request ask again, and an answer that changes the
 * installed model notifies the picker (`subscribeLiveDerivedModels`), which redraws from it before
 * the run that fetched it resolves anything. `awaitingLiveDerivedModel` says whether a slug is still
 * waiting on its first outcome (`useLiveDerivedModel` wires both into React).
 */
import {
  derivedRegistryRolloutEnabled,
  findModel,
  installLiveDerivedEntry,
  type DerivedModelGrade,
  type DrugModelDefinition,
} from '@/lib/kinetics-core';

/** How long one outcome (an answer, or a failure) is trusted before anything asks again. The
 *  server's edge cache is a minute too, so a curator's edit reaches a run within about two. */
export const LIVE_MODEL_TTL_MS = 60_000;

/** A run waits at most this long for the live answer before going ahead on the committed one. */
export const LIVE_MODEL_TIMEOUT_MS = 5_000;

/** When each slug's last request settled — an answer or a failure; trusted for the TTL. */
const fetchedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();
/** Slugs whose first live request has settled (answered, failed or timed out). */
const settled = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

type LiveAnswer =
  | { status: 'reviewed' }
  | { status: 'assembled'; definition: DrugModelDefinition; grade: DerivedModelGrade | null }
  | { status: 'not-modelable' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The minimum an answer must hold to be laid over the registry; anything else is ignored. */
function parseAnswer(slug: string, body: unknown): LiveAnswer | null {
  if (!isRecord(body)) return null;
  if (body.status === 'reviewed' || body.status === 'not-modelable') {
    return { status: body.status };
  }
  if (body.status !== 'assembled') return null;
  const { definition, grade } = body;
  if (
    !isRecord(definition) ||
    definition.analyte !== slug ||
    typeof definition.modelId !== 'string' ||
    !isRecord(definition.routes)
  ) {
    return null;
  }
  if (grade !== null && (!isRecord(grade) || grade.analyte !== slug || !Array.isArray(grade.routes))) {
    return null;
  }
  return {
    status: 'assembled',
    definition: definition as unknown as DrugModelDefinition,
    grade: grade as DerivedModelGrade | null,
  };
}

/** Fetch and install the live answer for `slug`; resolves to whether what is installed changed. */
async function fetchAndInstall(slug: string, fetchImpl: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_MODEL_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`/api/derived-model?slug=${encodeURIComponent(slug)}`, {
      signal: controller.signal,
    });
    // No longer in the catalogue (deleted or renamed): withdraw whatever the snapshot, or an
    // earlier live answer, still holds for the slug, exactly as for a drug that builds no model.
    if (res.status === 404) {
      return installLiveDerivedEntry({ analyte: slug, definition: null, grade: null });
    }
    // A failed or unreadable answer leaves the overlay as it is (see the module comment): an
    // earlier live answer is kept, not reverted to the committed snapshot.
    if (!res.ok) return false;
    const answer = parseAnswer(slug, await res.json());
    if (!answer) return false;
    let changed = false;
    if (answer.status === 'assembled') {
      changed = installLiveDerivedEntry({ analyte: slug, definition: answer.definition, grade: answer.grade });
    } else if (answer.status === 'not-modelable') {
      changed = installLiveDerivedEntry({ analyte: slug, definition: null, grade: null });
    }
    return changed;
  } catch {
    // Offline, too slow, or a bad answer: nothing installed changes (the committed snapshot, or the
    // last live answer if one arrived earlier, stays in force) until the failure has aged out.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Make sure the registry holds a current live answer for `slug` before it is resolved. Resolves once
 * the answer is installed, or once fetching has failed and whatever was already in force stays so
 * (the committed snapshot, or the last live answer) — never rejects, so a run is never blocked on
 * the network.
 */
export async function refreshLiveDerivedModel(
  slug: string | undefined,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
): Promise<void> {
  if (!slug || !derivedRegistryRolloutEnabled() || findModel(slug)) return;
  const last = fetchedAt.get(slug);
  if (last !== undefined && now - last < LIVE_MODEL_TTL_MS) return;
  const pending = inFlight.get(slug);
  if (pending) return pending;
  const request = fetchAndInstall(slug, fetchImpl).then((changed) => {
    // Trust this outcome, a failure included, for the window: a run that follows the panel's
    // failed request resolves the same fallback the picker was built from instead of retrying.
    fetchedAt.set(slug, now);
    inFlight.delete(slug);
    const first = !settled.has(slug);
    settled.add(slug);
    // Tell a mounted picker when its first answer settles (it stops waiting) or when an answer
    // changes the installed model (its routes may have changed), whichever caller asked.
    if (first || changed) notify();
  });
  inFlight.set(slug, request);
  return request;
}

/**
 * Whether `slug` still waits on its first live answer: the derived tier is on, the reviewed tier
 * does not claim it, and no live request for it has settled yet. Until then the registry holds only
 * the committed snapshot, which the run is about to replace, so a picker built from it could offer
 * routes the run then refuses. False once a request has settled, even a failed one: that failure
 * is trusted for the window, so the run resolves the same snapshot (or last live answer) the
 * picker reads rather than retrying.
 */
export function awaitingLiveDerivedModel(slug: string | undefined): boolean {
  if (!slug || !derivedRegistryRolloutEnabled() || findModel(slug)) return false;
  return !settled.has(slug);
}

/** Be told when a live answer settles for the first time or changes what is installed. */
export function subscribeLiveDerivedModels(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Bumped on every notification: a `useSyncExternalStore` snapshot for the picker. */
export function liveDerivedModelsVersion(): number {
  return version;
}

/** Forget when each slug was fetched (tests). */
export function resetLiveDerivedModelCache(): void {
  fetchedAt.clear();
  inFlight.clear();
  settled.clear();
}
