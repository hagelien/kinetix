/**
 * Fetch a catalogue drug's derived model live, before it is run.
 *
 * The committed derived artifact is a snapshot of what the catalogue built when it was last
 * regenerated. Asking the server for the drug's model as the catalogue builds it NOW
 * (`/api/derived-model`), and laying the answer over that snapshot (`installLiveDerivedEntry`),
 * means a value curated into the catalogue reaches the next run without a rebuilt artifact, a pull
 * request or a deploy.
 *
 * Failure keeps the committed snapshot: an unreachable server, a database outage or a malformed
 * answer leaves the drug resolving exactly as it would have before this existed. A slug the
 * reviewed tier claims is never fetched; an override always wins.
 */
import {
  derivedRegistryRolloutEnabled,
  findModel,
  installLiveDerivedEntry,
  type DerivedModelGrade,
  type DrugModelDefinition,
} from '@/lib/kinetics-core';

/** How long one answer is trusted before the next run asks again. The server's edge cache is a
 *  minute too, so a curator's edit reaches a run within about two. */
export const LIVE_MODEL_TTL_MS = 60_000;

/** A run waits at most this long for the live answer before going ahead on the committed one. */
export const LIVE_MODEL_TIMEOUT_MS = 5_000;

const fetchedAt = new Map<string, number>();
const inFlight = new Map<string, Promise<void>>();

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

async function fetchAndInstall(slug: string, fetchImpl: typeof fetch, now: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIVE_MODEL_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`/api/derived-model?slug=${encodeURIComponent(slug)}`, {
      signal: controller.signal,
    });
    // Not in the catalogue: nothing to lay over, and nothing the snapshot could hold either.
    if (res.status === 404) {
      fetchedAt.set(slug, now);
      return;
    }
    if (!res.ok) return;
    const answer = parseAnswer(slug, await res.json());
    if (!answer) return;
    if (answer.status === 'assembled') {
      installLiveDerivedEntry({ analyte: slug, definition: answer.definition, grade: answer.grade });
    } else if (answer.status === 'not-modelable') {
      installLiveDerivedEntry({ analyte: slug, definition: null, grade: null });
    }
    fetchedAt.set(slug, now);
  } catch {
    // Offline, too slow, or a bad answer: the committed snapshot stays in force, and the next run
    // asks again.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Make sure the registry holds a current live answer for `slug` before it is resolved. Resolves once
 * the answer is installed, or once fetching has failed and the committed snapshot stays in force —
 * never rejects, so a run is never blocked on the network.
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
  const request = fetchAndInstall(slug, fetchImpl, now).finally(() => inFlight.delete(slug));
  inFlight.set(slug, request);
  return request;
}

/** Forget when each slug was fetched (tests). */
export function resetLiveDerivedModelCache(): void {
  fetchedAt.clear();
  inFlight.clear();
}
