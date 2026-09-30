/**
 * Migration 0118 — prose in `qualifier`, a field that takes only `<`/`>`/`≤`/`≥`.
 *
 * A qualifier marks a censored threshold, so the value renders as the operator
 * plus one figure: text there reads as part of the number AND hides the row's
 * min–max span. Six live rows predate the enum that now refuses it.
 *
 * What these tests pin is the judgement, not the syntax: that a qualifier
 * saying something the note does not is KEPT (in the note) rather than
 * deleted, that caffeine's wrong "amin" is not carried anywhere, that an
 * operator is left alone, and that an unforeseen row is folded verbatim rather
 * than silently dropped. As in the 0116/0117 tests the statements are pulled
 * out of the shipped .sql file and re-run against seeded rows — the harness
 * truncates every table between tests, so the migration's own pass ran against
 * an empty database and left nothing to observe.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { drugParameters } from '../../db/schema.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedDrug, seedUser } from './setup/seed.js';
import type { NumericRange } from '../../src/types/index.js';

let db: IntegrationDb;
let userId: number;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(
  HERE,
  '../../drizzle/0118_clear_free_text_parameter_qualifiers.sql',
);

/** Every statement of the real migration, in order. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runMigration(): Promise<void> {
  for (const statement of migrationStatements()) {
    await db.execute(sql.raw(statement));
  }
}

async function storedValue(
  forDrug: number,
  parameter: string,
): Promise<NumericRange | undefined> {
  const [row] = await db
    .select()
    .from(drugParameters)
    .where(
      and(
        eq(drugParameters.drugId, forDrug),
        eq(drugParameters.parameter, parameter),
      ),
    );
  return row?.value as NumericRange | undefined;
}

/** One drug + one parameter row, as the live table holds them. */
async function seedParameter(
  slug: string,
  parameter: string,
  value: Record<string, unknown>,
): Promise<number> {
  const drugId = await seedDrug(db, { slug });
  await db
    .insert(drugParameters)
    .values({ drugId, parameter, value, updatedBy: userId });
  return drugId;
}

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
  userId = await seedUser(db);
});

describe('migration 0118 — free-text parameter qualifiers', () => {
  it("keeps a measurement condition the note never states", async () => {
    // Ethanol's real row: "25C" is the temperature the logP values were
    // measured at, and the note says nothing about it. Dropping the key alone
    // would lose the fact.
    const drugId = await seedParameter('ethanol', 'logPlogD', {
      min: -0.31,
      max: -0.24,
      note: 'Uionisert ved pH 7,4; logD er derfor tilnaermet logP.',
      qualifier: '25C',
    });

    await runMigration();

    const value = await storedValue(drugId, 'logPlogD');
    expect(value).not.toHaveProperty('qualifier');
    expect(value?.note).toBe(
      'Uionisert ved pH 7,4; logD er derfor tilnaermet logP. Verdiene er målt ved 25 °C.',
    );
    // The bounds are untouched — this migration corrects a label, not a number.
    expect(value?.min).toBe(-0.31);
    expect(value?.max).toBe(-0.24);
  });

  it('states the population and route caffeine’s tmax note left implicit', async () => {
    const drugId = await seedParameter('caffeine', 'tmax', {
      min: 0.5,
      max: 1.5,
      unit: 'h',
      note: 'Variasjon 0,5–1,5 t avhengig av formulering og fastestatus.',
      qualifier: 'adult PO',
    });

    await runMigration();

    const value = await storedValue(drugId, 'tmax');
    expect(value).not.toHaveProperty('qualifier');
    expect(value?.note).toBe(
      'Variasjon 0,5–1,5 t avhengig av formulering og fastestatus. Gjelder voksne etter peroral dosering.',
    );
  });

  it('drops a label the note already carries, without rewriting the note', async () => {
    const drugId = await seedParameter('alprazolam', 'logPlogD', {
      min: 2.1,
      max: 2.12,
      note: 'Lipofilisitet for alprazolam (logP oktanol/vann).',
      qualifier: 'logP',
    });

    await runMigration();

    const value = await storedValue(drugId, 'logPlogD');
    expect(value).toEqual({
      min: 2.1,
      max: 2.12,
      note: 'Lipofilisitet for alprazolam (logP oktanol/vann).',
    });
  });

  it('keeps the label when the note no longer carries it', async () => {
    // The "redundant" verdict is a claim about a note read at a point in time.
    // Edited since — another deployment, or between this file and its deploy —
    // the qualifier is the row's last remaining measurement label, so the named
    // drop stands down and the sweep preserves the text instead.
    const drugId = await seedParameter('alprazolam', 'logPlogD', {
      min: 2.1,
      max: 2.12,
      note: 'Konkordant med sekundærlitteratur.',
      qualifier: 'logP',
    });

    await runMigration();

    const value = await storedValue(drugId, 'logPlogD');
    expect(value).not.toHaveProperty('qualifier');
    expect(value?.note).toBe(
      'Konkordant med sekundærlitteratur. (kvalifikator: logP)',
    );
  });

  it("drops morphine's label against a note that spells it cLogP", async () => {
    // The check is case-insensitive on purpose: morphine's note names `cLogP`
    // and `cLogD7,4`, never the literal `logP/logD` its qualifier holds.
    const note =
      'Lattanzi et al. beregner cLogD7,4 -0,57 og cLogP 1,23; bruk som bred lipofilisitetsmarkør.';
    const drugId = await seedParameter('morphine', 'logPlogD', {
      min: -0.57,
      max: 1.42,
      note,
      qualifier: 'logP/logD',
    });

    await runMigration();

    expect(await storedValue(drugId, 'logPlogD')).toEqual({
      min: -0.57,
      max: 1.42,
      note,
    });
  });

  it("keeps morphine's combined label when the note dropped logD", async () => {
    // `logP/logD` claims the range spans both measurements, which a note that
    // now names only logP no longer carries — so this one needs both present.
    const note = 'DailyMed oppgir oktanol/vann-koeffisient 1,42 (logP).';
    const drugId = await seedParameter('morphine', 'logPlogD', {
      min: -0.57,
      max: 1.42,
      note,
      qualifier: 'logP/logD',
    });

    await runMigration();

    const value = await storedValue(drugId, 'logPlogD');
    expect(value).not.toHaveProperty('qualifier');
    expect(value?.note).toBe(`${note} (kvalifikator: logP/logD)`);
  });

  it("drops caffeine's wrong pKa qualifier whatever the note says", async () => {
    // The one row with no note check: "amin" names a group caffeine does not
    // have, so folding it under a label would preserve the error where a reader
    // sees it. It goes even when the note says nothing about the site.
    const drugId = await seedParameter('caffeine', 'pKa', {
      median: 0.7,
      note: 'Verdien er hentet fra HSDB.',
      qualifier: 'amin',
    });

    await runMigration();

    const value = await storedValue(drugId, 'pKa');
    expect(value).toEqual({ median: 0.7, note: 'Verdien er hentet fra HSDB.' });
  });

  it("does not carry caffeine's wrong pKa qualifier into the note", async () => {
    // "amin" names a group caffeine does not have; the note already states the
    // real protonation site. A generic fold would have preserved the error in
    // the one field a reader actually sees.
    const note =
      'Konjugert syre (caffeinium-kation); protonering ved N7/N9 i imidazolringen.';
    const drugId = await seedParameter('caffeine', 'pKa', {
      median: 0.7,
      note,
      qualifier: 'amin',
    });

    await runMigration();

    const value = await storedValue(drugId, 'pKa');
    expect(value).toEqual({ median: 0.7, note });
    expect(value?.note).not.toContain('amin');
  });

  it('leaves a real comparison operator alone', async () => {
    // The field's actual purpose: "< 0.05" is a censored threshold, not prose.
    const value = { median: 0.05, unit: 'mg/L', qualifier: '<' };
    const drugId = await seedParameter('test-lod', 'therapeuticConcentration', value);

    await runMigration();

    expect(await storedValue(drugId, 'therapeuticConcentration')).toEqual(value);
  });

  it('folds an unforeseen qualifier into the note rather than deleting it', async () => {
    // A row this file's author never saw — another environment, or one written
    // between here and deploy. The text survives, visibly, under a Norwegian
    // label: `note` is authored content, rendered verbatim and never localizable
    // afterwards, so a label wrapped around it follows the same rule.
    const drugId = await seedParameter('unseen-drug', 'halfLife', {
      min: 2,
      max: 4,
      unit: 'h',
      note: 'Voksne friske frivillige.',
      qualifier: 'β-fase',
    });

    await runMigration();

    const value = await storedValue(drugId, 'halfLife');
    expect(value).not.toHaveProperty('qualifier');
    expect(value?.note).toBe('Voksne friske frivillige. (kvalifikator: β-fase)');
  });

  it('folds an unforeseen qualifier on a row that has no note at all', async () => {
    const drugId = await seedParameter('unseen-noteless', 'clearance', {
      median: 30,
      unit: 'L/h',
      qualifier: 'voksen po',
    });

    await runMigration();

    const value = await storedValue(drugId, 'clearance');
    expect(value).not.toHaveProperty('qualifier');
    // btrim keeps the leading space out when there was nothing to append to.
    expect(value?.note).toBe('(kvalifikator: voksen po)');
  });

  it('leaves a row whose fold would break the note length bound', async () => {
    // `note` is capped at 500 characters by the registry schema, and every later
    // edit validates the whole value — so a fold that overshoots would swap one
    // unpublishable field for another instead of repairing the row. It keeps its
    // qualifier and stays on the audit's list for a curator.
    const note = 'A'.repeat(480);
    const drugId = await seedParameter('unseen-long-note', 'halfLife', {
      median: 3,
      unit: 'h',
      note,
      qualifier: 'voksen po',
    });

    await runMigration();

    const value = await storedValue(drugId, 'halfLife');
    expect(value?.qualifier).toBe('voksen po');
    expect(value?.note).toBe(note);
  });

  it('falls back to the short label when a NAMED row cannot fit its sentence', async () => {
    // The bound guards the bespoke rewrites too, not only the sweep: either row
    // may have been edited in another deployment since this file was written.
    // Here the written-out sentence (+28 chars) would overshoot but the sweep's
    // label (+20) still fits, so the row is repaired by the generic path rather
    // than left stuck — the qualifier text survives either way.
    const note = 'A'.repeat(476);
    const drugId = await seedParameter('ethanol', 'logPlogD', {
      min: -0.31,
      max: -0.24,
      note,
      qualifier: '25C',
    });

    await runMigration();

    const value = await storedValue(drugId, 'logPlogD');
    expect(value).not.toHaveProperty('qualifier');
    expect(value?.note).toBe(`${note} (kvalifikator: 25C)`);
  });

  it('leaves a NAMED row that no fold fits at all', async () => {
    // Nothing this migration could write keeps the note inside its bound, so
    // the row keeps its qualifier and stays on the audit's list for a curator.
    const note = 'A'.repeat(490);
    const drugId = await seedParameter('ethanol', 'logPlogD', {
      min: -0.31,
      max: -0.24,
      note,
      qualifier: '25C',
    });

    await runMigration();

    const value = await storedValue(drugId, 'logPlogD');
    expect(value?.qualifier).toBe('25C');
    expect(value?.note).toBe(note);
  });

  it('does not overshoot by a unit on the caffeine sentence', async () => {
    // The boundary the hand-counted version got wrong: ' Gjelder voksne etter
    // peroral dosering.' is 39 units, not 38, so a 462-unit note passed the
    // guard and produced a 501-unit note zod refuses. The named rewrite is now
    // skipped here and the sweep's shorter label repairs the row instead.
    const note = 'A'.repeat(462);
    expect(' Gjelder voksne etter peroral dosering.'.length).toBe(39);
    const drugId = await seedParameter('caffeine', 'tmax', {
      min: 0.5,
      max: 1.5,
      unit: 'h',
      note,
      qualifier: 'adult PO',
    });

    await runMigration();

    const value = await storedValue(drugId, 'tmax');
    expect(value).not.toHaveProperty('qualifier');
    expect(value?.note).not.toContain('Gjelder voksne');
    expect(value?.note).toBe(`${note} (kvalifikator: adult PO)`);
    expect(value!.note!.length).toBeLessThanOrEqual(500);
  });

  it('counts the note bound in UTF-16 units, as the schema does', async () => {
    // `char_length` counts code points; zod's `.max(500)` counts UTF-16 code
    // units, so a non-BMP character costs one in Postgres and two in
    // JavaScript. This note is 474 code points but 524 units — a code-point
    // guard would have folded it and written a note the API then refuses.
    const note = `${'A'.repeat(424)}${'😀'.repeat(50)}`;
    expect(note.length).toBeGreaterThan(500);
    const drugId = await seedParameter('unseen-emoji', 'halfLife', {
      median: 3,
      unit: 'h',
      note,
      qualifier: 'voksen po',
    });

    await runMigration();

    const value = await storedValue(drugId, 'halfLife');
    expect(value?.qualifier).toBe('voksen po');
    expect(value?.note).toBe(note);
  });

  it('still folds a non-BMP note that has room for the label', async () => {
    // The guard over-counts surrogate pairs rather than under-counting them,
    // but not so bluntly that an ordinary note carrying one is left stuck.
    const note = `${'A'.repeat(400)}😀`;
    const drugId = await seedParameter('unseen-emoji-ok', 'halfLife', {
      median: 3,
      unit: 'h',
      note,
      qualifier: 'voksen po',
    });

    await runMigration();

    const value = await storedValue(drugId, 'halfLife');
    expect(value).not.toHaveProperty('qualifier');
    expect(value?.note).toBe(`${note} (kvalifikator: voksen po)`);
    expect(value!.note!.length).toBeLessThanOrEqual(500);
  });

  it('is a no-op on a second pass', async () => {
    const drugId = await seedParameter('ethanol', 'logPlogD', {
      min: -0.31,
      max: -0.24,
      note: 'Uionisert ved pH 7,4.',
      qualifier: '25C',
    });

    await runMigration();
    const once = await storedValue(drugId, 'logPlogD');
    await runMigration();

    expect(await storedValue(drugId, 'logPlogD')).toEqual(once);
  });
});
