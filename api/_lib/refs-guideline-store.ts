/**
 * Read side of `refs_detection_guidelines` — the restricted guideline tables
 * that `api/refs-detection-times.ts` serves behind its gate.
 *
 * The table's contents never live in the source tree: an operator loads them
 * from the section's controlled document, outside the repository. This module
 * only reads the stored row back and refuses to hand on anything that does not
 * have the shape the client renders.
 *
 * Refusal is all-or-nothing. A forensic table with one row quietly dropped is
 * indistinguishable from a complete one, so a single malformed row fails the
 * whole read (and the route answers 500) rather than being filtered out.
 */
import { eq } from 'drizzle-orm';
import { refsDetectionGuidelines } from '../../db/schema.js';
import { getDb, withDbRetry } from './db.js';
import {
  isRefsGuidelineSource,
  isRefsUrineDetectionRow,
  type RefsGuidelineSource,
  type RefsUrineDetectionRow,
} from '../../src/lib/refsDetectionTimes.js';

/** Key of the urine detection-time table. */
export const REFS_URINE_GUIDELINE_KEY = 'urine';

export interface StoredRefsGuideline {
  source: RefsGuidelineSource;
  preamble: string;
  rows: RefsUrineDetectionRow[];
}

/**
 * The stored guideline for `key`, or `null` when none has been loaded.
 *
 * Throws when a row exists but does not validate — see the module comment.
 */
export async function loadRefsGuideline(
  key: string = REFS_URINE_GUIDELINE_KEY,
): Promise<StoredRefsGuideline | null> {
  const [stored] = await withDbRetry(() =>
    getDb()
      .select({
        source: refsDetectionGuidelines.source,
        preamble: refsDetectionGuidelines.preamble,
        rows: refsDetectionGuidelines.rows,
      })
      .from(refsDetectionGuidelines)
      .where(eq(refsDetectionGuidelines.key, key))
      .limit(1),
  );
  if (!stored) return null;

  const { source, preamble, rows } = stored;
  if (!isRefsGuidelineSource(source)) {
    throw new Error(`refs_detection_guidelines[${key}]: malformed source`);
  }
  if (!Array.isArray(rows)) {
    throw new Error(`refs_detection_guidelines[${key}]: rows is not an array`);
  }
  const bad = rows.findIndex((row) => !isRefsUrineDetectionRow(row));
  if (bad !== -1) {
    throw new Error(`refs_detection_guidelines[${key}]: malformed row ${bad}`);
  }
  return { source, preamble, rows: rows as RefsUrineDetectionRow[] };
}
