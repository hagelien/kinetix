/**
 * Seed drug_parameters.therapeuticConcentration with the Diakonhjemmet
 * serum therapeutic ranges from resources/referanseomrader_diakonhjemmet_serum.csv.
 *
 * Idempotent: for each drug the script upserts the normal reviewed drug
 * parameter. If the stored value already matches the CSV row, it skips the
 * write and does not duplicate revision history.
 *
 * CSV convention: `Lav = 0` means "no lower bound specified" (stored as
 * null `low`), producing an upper-bound-only therapeutic range.
 *
 * Usage:
 *   npm run seed:reference-concentrations
 *   DATABASE_URL=... npm run seed:reference-concentrations
 *   npm run seed:reference-concentrations -- --user-email=curator@example.com
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import { and, eq } from 'drizzle-orm';
import {
  citations,
  drugParameterRevisions,
  drugParameters,
  drugs,
  users,
} from '../db/schema';
import {
  blockedParametersFor,
  withDrugApplicabilityLock,
} from '../api/_lib/parameterApplicabilityStore';
import { getDb } from '../api/_lib/db';
import {
  REFERENCE_UNITS,
  type ReferenceUnit,
} from '../src/lib/referenceConcentrations';

// Same default as scripts/seed-pm-concentrations.ts, the nearest sibling: this
// seeder writes drug_parameter_revisions, and every revision needs an author.
const DEFAULT_USER_EMAIL =
  process.env.IMPORT_USER_EMAIL ?? 'agent@kinetix.internal';

const SOURCE_TAG = 'Diakonhjemmet';
const SOURCE_URL =
  'https://www.diakonhjemmetsykehus.no/avdelinger/klinikk-for-psykisk-helse-og-rus/senter-for-psykofarmakologi/senter-for-psykofarmakologi-sfp/legemiddelanalyser/';
const CSV_PATH = resolve(
  process.cwd(),
  'resources/referanseomrader_diakonhjemmet_serum.csv',
);

interface CsvRow {
  virkestoff: string;
  lav: number;
  hoy: number;
  enhet: string;
}

function parseCsv(contents: string): CsvRow[] {
  const lines = contents.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i]!.split(',').map((s) => s.trim());
    if (parts.length < 4) continue;
    const [virkestoff, lavRaw, hoyRaw, enhet] = parts;
    const lav = Number(lavRaw);
    const hoy = Number(hoyRaw);
    if (!virkestoff || !enhet || !Number.isFinite(lav) || !Number.isFinite(hoy)) {
      console.warn(`[skip] line ${i + 1}: malformed — ${lines[i]}`);
      continue;
    }
    rows.push({ virkestoff, lav, hoy, enhet });
  }
  return rows;
}

function normaliseUnit(raw: string): ReferenceUnit | null {
  const normalised = raw
    .replace(/μ/g, 'µ')  // Greek mu -> Latin micro
    .replace(/\bug\b/g, 'µg')
    .replace(/\bumol\b/g, 'µmol')
    .trim();
  return (REFERENCE_UNITS as readonly string[]).includes(normalised)
    ? (normalised as ReferenceUnit)
    : null;
}

function parseUserEmail(argv: string[]): string {
  let email = DEFAULT_USER_EMAIL;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--user-email') email = argv[++i] ?? email;
    else if (a.startsWith('--user-email=')) {
      email = a.slice('--user-email='.length);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return email;
}

async function resolveActorUserId(
  db: ReturnType<typeof drizzle>,
  email: string,
): Promise<number> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!row) {
    throw new Error(
      `No user with email "${email}". Pass --user-email <address> for an existing account.`,
    );
  }
  return row.id;
}

/**
 * Index every drug by every name it is known under, lowercased.
 *
 * `drugs.names` is per-language jsonb, so one drug contributes one key per
 * locale. A name that resolves to more than one drug is dropped rather than
 * resolved arbitrarily: the CSV gives a bare Norwegian substance name with no
 * disambiguator, and writing a therapeutic range onto the wrong substance is
 * the one outcome this seeder must not produce. Dropped names surface in the
 * ambiguous report alongside the missing ones.
 */
function indexDrugsByName(
  rows: readonly { id: number; names: Record<string, string> | null }[],
): { byName: Map<string, number>; ambiguous: Set<string> } {
  const byName = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const d of rows) {
    for (const name of Object.values(d.names ?? {})) {
      const key = name.trim().toLowerCase();
      if (!key) continue;
      const seen = byName.get(key);
      if (seen === undefined) byName.set(key, d.id);
      else if (seen !== d.id) ambiguous.add(key);
    }
  }
  for (const key of ambiguous) byName.delete(key);
  return { byName, ambiguous };
}

async function main(): Promise<void> {
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const userEmail = parseUserEmail(process.argv.slice(2));

  const csvRows = parseCsv(readFileSync(CSV_PATH, 'utf8'));
  console.log(`Parsed ${csvRows.length} rows from ${CSV_PATH}`);

  const client = neon(DATABASE_URL);
  const db = drizzle(client);

  const createdBy = await resolveActorUserId(db, userEmail);

  const allDrugs = await db
    .select({ id: drugs.id, names: drugs.names })
    .from(drugs);

  const { byName: nameToId, ambiguous } = indexDrugsByName(allDrugs);

  // Ensure the Diakonhjemmet citation exists exactly once and capture its id
  // so every seeded row links back to it. The unique index on
  // (type, identifier) makes onConflictDoNothing idempotent.
  await db
    .insert(citations)
    .values({ type: 'url', identifier: SOURCE_URL })
    .onConflictDoNothing({ target: [citations.type, citations.identifier] });
  const [citationRow] = await db
    .select({ id: citations.id })
    .from(citations)
    .where(and(eq(citations.type, 'url'), eq(citations.identifier, SOURCE_URL)))
    .limit(1);
  if (!citationRow) {
    throw new Error('Failed to upsert Diakonhjemmet citation row');
  }
  const citationId = citationRow.id;

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  const missing: string[] = [];
  // CSV names that match more than one drug — see indexDrugsByName.
  const collided: string[] = [];
  const badUnit: string[] = [];
  // Substances whose therapeuticConcentration is not a defined quantity for
  // them. Reported rather than dropped silently, like the two above.
  const notApplicable: string[] = [];

  for (const row of csvRows) {
    const key = row.virkestoff.trim().toLowerCase();
    const drugId = nameToId.get(key);
    if (drugId == null) {
      // Ambiguous names were deleted from the map, so report them apart from
      // the ones the catalog simply does not hold — the operator action differs.
      (ambiguous.has(key) ? collided : missing).push(row.virkestoff);
      continue;
    }

    const unit = normaliseUnit(row.enhet);
    if (!unit) {
      badUnit.push(`${row.virkestoff}: ${row.enhet}`);
      continue;
    }

    const lowVal = row.lav > 0 ? row.lav : null;
    const highVal = row.hoy > 0 ? row.hoy : null;
    if (lowVal == null && highVal == null) {
      console.warn(`[skip] ${row.virkestoff}: both bounds are 0/missing`);
      continue;
    }

    const value = {
      ...(lowVal != null ? { min: lowVal } : {}),
      ...(highVal != null ? { max: highVal } : {}),
      unit,
      note: SOURCE_TAG,
    };

    // Check and write as one locked unit, on the per-drug applicability lock.
    //
    // This seeder writes drug_parameters directly and so inherits nothing from
    // upsertDrugParameter's guard (see tests/parameter-write-guards.test.ts,
    // which requires every direct writer to carry its own check). The lock is
    // what makes that check mean something: without it the read and the upsert
    // are separate autocommit statements, so an editor marking the pair partway
    // through the CSV would see no conflict from its side either and both would
    // commit.
    const outcome = await withDrugApplicabilityLock(drugId, async () => {
      const tx = getDb();
      if (
        (await blockedParametersFor(tx, drugId, ['therapeuticConcentration']))
          .length
      ) {
        return 'not-applicable' as const;
      }

      const [existing] = await tx
        .select({ value: drugParameters.value })
        .from(drugParameters)
        .where(
          and(
            eq(drugParameters.drugId, drugId),
            eq(drugParameters.parameter, 'therapeuticConcentration'),
          ),
        )
        .limit(1);

      if (JSON.stringify(existing?.value ?? null) === JSON.stringify(value)) {
        return 'unchanged' as const;
      }

      await tx
        .insert(drugParameters)
        .values({
          drugId,
          parameter: 'therapeuticConcentration',
          value: value as never,
        })
        .onConflictDoUpdate({
          target: [drugParameters.drugId, drugParameters.parameter],
          set: {
            value: value as never,
            updatedAt: new Date(),
          },
        });

      await tx.insert(drugParameterRevisions).values({
        drugId,
        parameter: 'therapeuticConcentration',
        oldValue: (existing?.value ?? null) as never,
        newValue: value as never,
        editSummary: `Seedet terapeutisk serumkonsentrasjon fra ${SOURCE_TAG}`,
        referenceId: citationId,
        referenceIds: [citationId],
        createdBy,
      });

      return existing ? ('updated' as const) : ('inserted' as const);
    });

    if (outcome === 'not-applicable') notApplicable.push(row.virkestoff);
    else if (outcome === 'unchanged') unchanged += 1;
    else if (outcome === 'updated') updated += 1;
    else inserted += 1;
  }

  console.log('');
  console.log(`Inserted: ${inserted}`);
  console.log(`Updated:  ${updated}`);
  console.log(`Same:     ${unchanged}`);
  if (missing.length > 0) {
    console.warn(`Missing drug (${missing.length}): ${missing.join(', ')}`);
  }
  if (collided.length > 0) {
    console.warn(
      `Ambiguous name (${collided.length}), matches several drugs — resolve by hand: ${collided.join(', ')}`,
    );
  }
  if (notApplicable.length > 0) {
    console.warn(
      `Not applicable (${notApplicable.length}): ${notApplicable.join(', ')}`,
    );
  }
  if (badUnit.length > 0) {
    console.warn(`Bad unit  (${badUnit.length}): ${badUnit.join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
