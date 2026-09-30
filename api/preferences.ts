/**
 * Per-user preferences endpoint.
 *   GET   — current user's prefs (display name, preferred unit, notifications)
 *   PATCH — update any subset; null clears, omitted leaves unchanged
 *
 * Auth-required (any role). The same preferences are surfaced as part of
 * `GET /api/auth?action=me` for the initial bootstrap; this endpoint exists
 * for the dedicated preferences page and any other surface that wants to
 * round-trip prefs without re-fetching the entire session.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  json,
  error,
  noStoreHeaders,
  withErrorHandling,
} from './_lib/response.js';
import { getDb, inTransaction } from './_lib/db.js';
import { getUserFromRequest } from './_lib/auth.js';
import { assertSameOrigin, parseAndValidate } from './_lib/validate.js';
import { notifications, users } from '../db/schema.js';
import {
  EMAIL_FREQUENCIES,
  EMAIL_LOCALES,
  enabledAudiences,
  resolveEmailPrefs,
  type NotificationSettings as EmailNotificationSettings,
} from '../src/lib/emailNotificationPrefs.js';

// Mass + molar concentration units the app understands. Mirrors the master
// list in src/lib/unitConversion.ts; duplicated here so the API doesn't have
// to import from src/.
const ALL_CONCENTRATION_UNITS = [
  'mg/L',
  'µg/mL',
  'ng/mL',
  'µg/L',
  'ng/L',
  'mg/dL',
  'µg/dL',
  'ng/dL',
  'mmol/L',
  'µmol/L',
  'nmol/L',
  'mmol/dL',
  'µmol/dL',
  'nmol/dL',
] as const;
type ConcentrationUnitName = (typeof ALL_CONCENTRATION_UNITS)[number];
const CONCENTRATION_UNIT_SET = new Set<string>(ALL_CONCENTRATION_UNITS);

// Concentration units that BOTH the drug-table row converter
// (src/lib/conversions.ts massUnits/molarUnits) AND the simulator
// worker (montecarlo.worker.ts:152) understand. Other units (per-dL,
// ng/mL, µg/mL, ng/L) stay enabled for tooltip + converter-modal
// display, but can't be the user's primary because the row converter
// has no matching <select> option and the simulator launch silently
// mis-scales (#317 P1 / P2 review).
const PRIMARY_ELIGIBLE_UNITS = new Set<string>([
  'mg/L',
  'µg/L',
  'mmol/L',
  'µmol/L',
  'nmol/L',
]);

const notificationSettingsSchema = z
  .object({
    emailOnFeedback: z.boolean().optional(),
    emailAsReviewer: z.boolean().optional(),
    emailFrequency: z.enum(EMAIL_FREQUENCIES).optional(),
    emailLocale: z.enum(EMAIL_LOCALES).optional(),
    // Legacy toggle, still accepted so an older client's save does not 400.
    emailWhenPendingEditReviewed: z.boolean().optional(),
  })
  .strict();

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

/**
 * What switching email settings changes besides the stored jsonb:
 *
 * - An audience switched ON must not receive the backlog that piled up while
 *   it was off, so its still-unhandled rows are marked handled. Email starts
 *   from the moment the user opted in.
 * - Switching email on, or changing the summary frequency, restarts the
 *   summary clock: the first summary waits for the next send slot rather
 *   than arriving minutes after the save.
 */
export function emailSettingsTransition(
  before: EmailNotificationSettings | null,
  after: EmailNotificationSettings | null,
): { newlyEnabledAudiences: ('author' | 'reviewer')[]; resetDigestClock: boolean } {
  const prev = resolveEmailPrefs(before);
  const next = resolveEmailPrefs(after);
  const prevAudiences = new Set(enabledAudiences(prev));
  const newlyEnabledAudiences = enabledAudiences(next).filter(
    (a) => !prevAudiences.has(a),
  );
  const resetDigestClock =
    newlyEnabledAudiences.length > 0 ||
    (enabledAudiences(next).length > 0 && prev.frequency !== next.frequency);
  return { newlyEnabledAudiences, resetDigestClock };
}

const preferencesUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).nullable().optional(),
    // Non-empty array; first element is the primary display unit, the rest
    // are alternatives the unit-conversion surfaces should expose. Each
    // element must be a recognized concentration unit.
    //
    // Validation messages emit stable i18n keys rather than English prose
    // so the React boundary can translate them (per AGENTS.md API
    // conventions). Both keys are defined in en.json + nb.json under
    // `errors.*`.
    enabledConcentrationUnits: z
      .array(z.string(), { message: 'errors.invalidEnabledUnits' })
      .min(1, 'errors.invalidEnabledUnits')
      .refine((units) => units.every((u) => CONCENTRATION_UNIT_SET.has(u)), {
        message: 'errors.unknownConcentrationUnit',
      })
      .refine(
        (units) => units.length === 0 || PRIMARY_ELIGIBLE_UNITS.has(units[0]!),
        { message: 'errors.primaryUnitNotSupported' },
      )
      .optional(),
    notificationSettings: notificationSettingsSchema.nullable().optional(),
    // #321 favorites. The list is validated as plain strings here
    // (canonical parameter ids live in src/lib/drugParameters.ts and
    // we don't want the API bundle to import the spec registry); the
    // list size is capped to keep the jsonb payload bounded. Order is
    // preserved as authored but the sidebar re-orders by registry.
    favoriteParameters: z.array(z.string().min(1).max(60)).max(40).optional(),
  })
  .strict();

export interface SerializedPreferences {
  displayName: string | null;
  enabledConcentrationUnits: ConcentrationUnitName[];
  notificationSettings: NotificationSettings | null;
  favoriteParameters: string[];
}

export default withErrorHandling(async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  switch (req.method) {
    case 'GET':
      return handleGet(req, res);
    case 'PATCH':
      assertSameOrigin(req);
      return handleUpdate(req, res);
    default:
      error(res, 405, 'Method not allowed');
  }
});

async function loadPreferences(
  userId: number,
): Promise<SerializedPreferences | null> {
  const db = getDb();
  const [row] = await db
    .select({
      displayName: users.displayName,
      enabledConcentrationUnits: users.enabledConcentrationUnits,
      notificationSettings: users.notificationSettings,
      favoriteParameters: users.favoriteParameters,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  return {
    displayName: row.displayName,
    enabledConcentrationUnits: (row.enabledConcentrationUnits as
      | ConcentrationUnitName[]
      | null) ?? ['µmol/L', 'mg/L'],
    notificationSettings:
      (row.notificationSettings as NotificationSettings | null) ?? null,
    favoriteParameters: (row.favoriteParameters as string[] | null) ?? [],
  };
}

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Not authenticated');
    return;
  }
  const prefs = await loadPreferences(auth.userId);
  if (!prefs) {
    error(res, 404, 'User not found');
    return;
  }
  json(res, 200, { preferences: prefs }, { headers: noStoreHeaders() });
}

async function handleUpdate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const auth = await getUserFromRequest(req);
  if (!auth) {
    error(res, 401, 'Not authenticated');
    return;
  }

  const parsed = await parseAndValidate(req, preferencesUpdateSchema);
  if ('error' in parsed) {
    error(res, 400, parsed.error);
    return;
  }

  const updates: Record<string, unknown> = {};
  if ('displayName' in parsed.data) {
    updates.displayName = parsed.data.displayName ?? null;
  }
  if (
    'enabledConcentrationUnits' in parsed.data &&
    parsed.data.enabledConcentrationUnits
  ) {
    // Dedupe while preserving order so the first occurrence stays primary.
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const u of parsed.data.enabledConcentrationUnits) {
      if (!seen.has(u)) {
        seen.add(u);
        cleaned.push(u);
      }
    }
    updates.enabledConcentrationUnits = cleaned;
  }
  if ('notificationSettings' in parsed.data) {
    updates.notificationSettings = parsed.data.notificationSettings ?? null;
  }
  if ('favoriteParameters' in parsed.data && parsed.data.favoriteParameters) {
    // Dedupe while preserving the user's order; first occurrence wins.
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const id of parsed.data.favoriteParameters) {
      if (!seen.has(id)) {
        seen.add(id);
        cleaned.push(id);
      }
    }
    updates.favoriteParameters = cleaned;
  }

  if (Object.keys(updates).length === 0) {
    const prefs = await loadPreferences(auth.userId);
    if (!prefs) {
      error(res, 404, 'User not found');
      return;
    }
    json(res, 200, { preferences: prefs }, { headers: noStoreHeaders() });
    return;
  }

  updates.updatedAt = new Date();

  if ('notificationSettings' in updates) {
    await inTransaction(async () => {
      const db = getDb();
      const [current] = await db
        .select({ notificationSettings: users.notificationSettings })
        .from(users)
        .where(eq(users.id, auth.userId))
        .for('update');
      const { newlyEnabledAudiences, resetDigestClock } = emailSettingsTransition(
        (current?.notificationSettings as EmailNotificationSettings | null) ?? null,
        updates.notificationSettings as EmailNotificationSettings | null,
      );
      const now = new Date();
      if (resetDigestClock) updates.lastEmailDigestAt = now;
      await db.update(users).set(updates).where(eq(users.id, auth.userId));
      if (newlyEnabledAudiences.length > 0) {
        await db
          .update(notifications)
          .set({ emailHandledAt: now })
          .where(
            and(
              eq(notifications.userId, auth.userId),
              inArray(notifications.audience, newlyEnabledAudiences),
              isNull(notifications.emailHandledAt),
            ),
          );
      }
    });
  } else {
    await getDb().update(users).set(updates).where(eq(users.id, auth.userId));
  }

  const prefs = await loadPreferences(auth.userId);
  if (!prefs) {
    error(res, 404, 'User not found');
    return;
  }
  json(res, 200, { preferences: prefs }, { headers: noStoreHeaders() });
}
