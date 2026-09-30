import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { drugParameters, parameterEntries } from '../../db/schema.js';
import {
  deleteReferenceConcentration,
  updateReferenceConcentration,
} from '../../api/_lib/reference-concentrations-helpers.js';
import {
  attachSourceQuoteIfMissing,
  quoteAfterUpdate,
  updateParameterEntryRow,
  type QuoteEvidenceSnapshot,
} from '../../api/_lib/parameter-entries-store.js';
import {
  resetIntegrationDb,
  setupIntegrationDb,
  teardownIntegrationDb,
  type IntegrationDb,
} from './setup/harness.js';
import { seedAdmissibleCitation, seedDrug, seedUser } from './setup/seed.js';

let db: IntegrationDb;

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Extract one statement from a migration file by a unique substring marker. */
function migrationStatement(tag: string, marker: string): string {
  const body = readFileSync(
    path.resolve(HERE, `../../drizzle/${tag}.sql`),
    'utf8',
  );
  const statements = body
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
  const match = statements.find((s) => s.includes(marker));
  if (!match) throw new Error(`No statement matching ${marker} in ${tag}`);
  return match;
}

beforeAll(async () => {
  db = await setupIntegrationDb();
});
afterAll(async () => {
  await teardownIntegrationDb();
});
beforeEach(async () => {
  await resetIntegrationDb(db);
});

async function seedEntry(over: Record<string, unknown>): Promise<number> {
  const [row] = await db
    .insert(parameterEntries)
    .values({
      parameter: 'therapeuticConcentration',
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      ...over,
    } as never)
    .returning({ id: parameterEntries.id });
  return row!.id;
}

describe('legacy endpoint refuses to mutate synthetic grandfather rows', () => {
  it('update returns not-found and leaves the row unchanged', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '100',
      matrix: 'whole_blood',
      origin: 'grandfathered',
    });

    const result = await updateReferenceConcentration({
      id,
      input: {
        low: 1,
        high: 2,
        unit: 'mg/L',
        matrix: 'serum',
        scenario: 'living_toxic',
      },
    });
    expect(result).toBeNull();

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    // Nothing was overwritten.
    expect(Number(row!.low)).toBe(10);
    expect(Number(row!.high)).toBe(100);
    expect(row!.matrix).toBe('whole_blood');
    expect(row!.parameter).toBe('therapeuticConcentration');
  });

  it('delete returns false and leaves the row in place', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '100',
      matrix: 'whole_blood',
      origin: 'grandfathered',
    });

    const deleted = await deleteReferenceConcentration(id);
    expect(deleted).toBe(false);

    const rows = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(rows).toHaveLength(1);
  });

  it('still updates and deletes genuine legacy rows', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '100',
      matrix: 'serum',
      origin: 'legacy',
    });

    const updated = await updateReferenceConcentration({
      id,
      input: {
        low: 5,
        high: 50,
        unit: 'mg/L',
        matrix: 'serum',
        scenario: 'living_toxic',
      },
    });
    expect(updated).not.toBeNull();
    // A representable legacy row is reclassified from the new scenario.
    expect(updated!.parameter).toBe('toxicConcentration');

    expect(await deleteReferenceConcentration(id)).toBe(true);
  });
});

// The legacy Admin → Reference concentrations endpoint writes the same physical
// table through a different door, and it replaces the reading and its source
// outright. Before this, it left `source_quote` untouched — so words read off
// one paper could end up presented as provenance for a different number, or a
// different document, which is the fabricated attribution this whole change
// exists to expose.
describe('the legacy concentration updater and the stored quote', () => {
  const QUOTE = 'Serum levels of 10–100 mg/L were reported.';

  async function legacyRow(over: Record<string, unknown> = {}) {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '100',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote: QUOTE,
      ...over,
    });
    return id;
  }

  async function storedQuote(id: number) {
    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    return row!.sourceQuote;
  }

  it('detaches the quote when the reading changes', async () => {
    const id = await legacyRow();
    await updateReferenceConcentration({
      id,
      input: {
        low: 5,
        high: 50,
        unit: 'mg/L',
        matrix: 'serum',
        scenario: 'living_therapeutic',
      },
    });
    // The sentence describes 10–100; presenting it beside 5–50 would be words
    // from the source attached to a number the source does not state.
    expect(await storedQuote(id)).toBeNull();
  });

  it('detaches the quote when the cited source changes', async () => {
    const citationId = await seedAdmissibleCitation(db, {
      identifier: '24500275',
    });
    const id = await legacyRow();
    await updateReferenceConcentration({
      id,
      input: {
        low: 10,
        high: 100,
        unit: 'mg/L',
        matrix: 'serum',
        scenario: 'living_therapeutic',
        citationId,
      },
    });
    expect(await storedQuote(id)).toBeNull();
  });

  it('keeps the quote when only the notes change', async () => {
    const id = await legacyRow();
    await updateReferenceConcentration({
      id,
      input: {
        low: 10,
        high: 100,
        unit: 'mg/L',
        matrix: 'serum',
        scenario: 'living_therapeutic',
        comments: 'Typo fixed.',
      },
    });
    // Curator notes are commentary about the observation, not part of what the
    // sentence attests — the same exclusion the entry-update path makes.
    expect(await storedQuote(id)).toBe(QUOTE);
  });

  // The fields this endpoint does not write must not be compared: a stored
  // qualifier is not being changed, so it cannot stale anything.
  it('keeps the quote on a row carrying a qualifier it never touches', async () => {
    const id = await legacyRow({ qualifier: '<', high: '100', low: null });
    await updateReferenceConcentration({
      id,
      input: {
        high: 100,
        unit: 'mg/L',
        matrix: 'serum',
        scenario: 'living_therapeutic',
        comments: 'Typo fixed.',
      },
    });
    expect(await storedQuote(id)).toBe(QUOTE);
  });
});

// A source quote is provenance nobody can reconstruct once it is gone: the
// sentence was read out of a paper by whoever recorded it, and a later editor
// has no way to recover it. So the update path has to distinguish a client
// CLEARING it from a client that simply never mentioned it — and the second is
// what every integration and cached client written before the field existed
// sends, which is most of them.
describe('updating an entry preserves a stored source quote', () => {
  const QUOTE = 'Therapeutic serum concentrations ranged from 10 to 30 mg/L.';

  it('keeps the quote when the patch does not mention it', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote: QUOTE,
    });

    // A pre-existing client's payload: complete in its own terms, and with no
    // idea the field exists. It edits the notes, leaving every dimension the
    // quote is evidence about untouched.
    //
    // This is also the mirror of every detach case below: the rule must not
    // block legitimate work. A proposal touching nothing the sentence attests
    // to keeps its provenance, which is what lets it still clear the consensus
    // gate rather than piling up in the human queue.
    const updated = await updateParameterEntryRow(id, {
      low: 10,
      high: 30,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      comments: 'Typo fixed.',
      citationId: null as never,
    } as never);
    expect(updated).not.toBeNull();

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    // The edit landed, and the provenance survived it.
    expect(row!.comments).toBe('Typo fixed.');
    expect(row!.sourceQuote).toBe(QUOTE);
  });

  // A whitespace-only quote is the absence of a quote wearing a coat, and it
  // is dangerous precisely because it is a non-empty STRING until
  // `sourceQuoteSchema` folds it to null at apply time. A pending edit's
  // payload is validated on submission but stored as sent, so anything reading
  // it earlier — above all the consensus gate deciding whether a
  // calculation-driving value may publish unattended — sees a quote where the
  // write will store none.
  it('stores a whitespace-only quote as no quote, and reports it as none', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote: QUOTE,
    });

    const patch = {
      low: 10,
      high: 30,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      quote: '   ',
      citationId: null as never,
    } as never;

    // What the gate is told BEFORE the write, and what the write then does:
    // the two have to agree, or an unquoted value publishes on an answer that
    // was never true.
    expect(await quoteAfterUpdate(id, patch)).toBeNull();
    await updateParameterEntryRow(id, patch);

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.sourceQuote).toBeNull();
  });

  // Presence is not assertion. A caller that changes the reading and copies the
  // stored sentence into the payload has stated nothing new — but because the
  // field is DEFINED, a presence test skips the staleness comparison entirely.
  // That is the guard's own bypass: an agent with submission access can move a
  // calculation-driving value and keep the old words behind it, and the quote
  // gate sees a quoted proposal.
  it('treats an echo of the stored quote as silence, not as a new assertion', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      median: '20',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote: QUOTE,
    });

    const patch = {
      low: 10,
      high: 30,
      // The reading moves; the sentence is copied over unchanged.
      median: 25,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      quote: QUOTE,
      citationId: null as never,
    } as never;

    // The gate and the write have to answer identically, or the gate authorizes
    // a publication the write leaves unquoted.
    expect(await quoteAfterUpdate(id, patch)).toBeNull();
    await updateParameterEntryRow(id, patch);

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.sourceQuote).toBeNull();
  });

  // The bypass in its sharpest form: the stored sentence plus one character
  // that renders as nothing. It compares unequal to a reader of bytes and
  // identically to a reader of text, so a raw comparison takes it as newly
  // authored evidence and never runs the staleness check at all.
  it('sees through an invisible character appended to an echo', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      median: '20',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote: QUOTE,
    });

    const patch = {
      low: 10,
      high: 30,
      median: 25,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      quote: `${QUOTE}\u034F`,
      citationId: null as never,
    } as never;

    expect(await quoteAfterUpdate(id, patch)).toBeNull();
    await updateParameterEntryRow(id, patch);

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.sourceQuote).toBeNull();
  });

  // The same bypass by accident. The stored row keeps whatever spelling its
  // source used — rows predating the comparison rule were never composed on the
  // way in — and the contributor's machine decides what spelling they send. So
  // the two sides of the comparison routinely disagree on how to spell a
  // character they both display identically, and a byte comparison calls an
  // honest copy-paste newly authored evidence.
  //
  // Both sides get normalized, and the SQL side is the one that matters here:
  // the JS normalization alone would still compare a composed key against a
  // decomposed column and see two sentences.
  it('sees through an echo composed differently from the stored row', async () => {
    const ACCENTED = 'Gjennomsnittlig Tmax var på 2 t hos friske.';
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      median: '20',
      matrix: 'serum',
      origin: 'legacy',
      // Stored decomposed, as a macOS paste or a legacy row would be.
      sourceQuote: ACCENTED.normalize('NFD'),
    });

    const patch = {
      low: 10,
      high: 30,
      median: 25,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      // Re-sent composed, as a browser form would.
      quote: ACCENTED.normalize('NFC'),
      citationId: null as never,
    } as never;

    expect(await quoteAfterUpdate(id, patch)).toBeNull();
    await updateParameterEntryRow(id, patch);

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.sourceQuote).toBeNull();
  });

  // The bypass somebody has to choose to do, and the one the SQL side has to
  // catch: the stored sentence with one Latin letter swapped for a Cyrillic
  // letter that renders identically. A byte comparison calls it newly authored,
  // so the staleness rule never runs and the changed reading publishes behind
  // words describing the reading it used to be.
  it('sees through a homoglyph swapped into an echo', async () => {
    const SENTENCE = 'Observed oral peak concentration was 20 mg per L.';
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      median: '20',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote: SENTENCE,
    });

    const patch = {
      low: 10,
      high: 30,
      median: 25,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      // Cyrillic small a for the Latin one in "oral".
      quote: SENTENCE.replace('oral', 'or\u0430l'),
      citationId: null as never,
    } as never;

    expect(await quoteAfterUpdate(id, patch)).toBeNull();
    await updateParameterEntryRow(id, patch);

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.sourceQuote).toBeNull();
  });

  // The mirror, and the case that pins the SQL half specifically. Above, the
  // STORED sentence is plain and the patch carries the lookalike, so folding the
  // stated key alone would have been enough. Here the lookalike is in the ROW —
  // a legacy paste, or a curator's keyboard — and only folding the column
  // recognises the plain re-send as the echo it is. Both sides fold, from the
  // same table, so neither case depends on which side happens to be odd.
  it('sees through a homoglyph already stored on the row', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      median: '20',
      matrix: 'serum',
      origin: 'legacy',
      // Micro sign, as a PDF paste leaves it.
      sourceQuote: 'Peak concentration was 20 \u00B5g/mL.',
    });

    const patch = {
      low: 10,
      high: 30,
      median: 25,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      // The same sentence with mu, as a web form leaves it.
      quote: 'Peak concentration was 20 \u03BCg/mL.',
      citationId: null as never,
    } as never;

    expect(await quoteAfterUpdate(id, patch)).toBeNull();
  });

  // …including an echo rewrapped on the way through, which is what a re-paste
  // out of a PDF produces: the schema stores both forms identically, so a raw
  // comparison would call it a replacement.
  it('sees through a rewrapped echo', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      median: '20',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote: QUOTE,
    });

    await updateParameterEntryRow(id, {
      low: 10,
      high: 30,
      median: 25,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      quote: `  ${QUOTE.replace(' ', '\n  ')}  `,
      citationId: null as never,
    } as never);

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.sourceQuote).toBeNull();
  });

  // The mirror: a genuinely NEW sentence is an assertion about the new payload
  // and must stand, or a curator correcting a value and its evidence together
  // could never record the corrected evidence.
  it('obeys a quote the author actually rewrote', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      median: '20',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote: QUOTE,
    });

    const replacement = 'Corrected: the median was 25 mg/L.';
    await updateParameterEntryRow(id, {
      low: 10,
      high: 30,
      median: 25,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      quote: replacement,
      citationId: null as never,
    } as never);

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.sourceQuote).toBe(replacement);
  });

  it('clears the quote when the patch says so explicitly', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote: QUOTE,
    });

    await updateParameterEntryRow(id, {
      low: 10,
      high: 30,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      quote: null,
      citationId: null as never,
    } as never);

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    // Curators must still be able to remove a quote they got wrong — the guard
    // above protects against silence, not against intent.
    expect(row!.sourceQuote).toBeNull();
  });

  // Preserving on silence is right only while the quote is still evidence for
  // what the row says. A quote belongs to a specific reading OF a specific
  // document; if the patch moves either and says nothing about the quote,
  // keeping it would present words copied from the old source as backing the
  // new value — a fabricated attribution, which is worse than no quote at all.
  it('detaches a preserved quote when the citation changes', async () => {
    const drugId = await seedDrug(db);
    const firstCitationId = await seedAdmissibleCitation(db, {
      identifier: '24500275',
    });
    const secondCitationId = await seedAdmissibleCitation(db, {
      identifier: '24500276',
    });
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote: QUOTE,
      citationId: firstCitationId,
    });

    await updateParameterEntryRow(id, {
      low: 10,
      high: 30,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      // The one thing that moved, and the client said nothing about the quote.
      citationId: secondCitationId as never,
    } as never);

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.sourceQuote).toBeNull();
  });

  it('detaches a preserved quote when the value changes', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote: QUOTE,
    });

    await updateParameterEntryRow(id, {
      low: 5,
      high: 50,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      citationId: null as never,
    } as never);

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    // The sentence said 10 to 30. It is not evidence for 5 to 50.
    expect(row!.sourceQuote).toBeNull();
  });

  // "What the row says" is every dimension that makes the reading the reading.
  // A sentence about an oral dose is not evidence for an intravenous one, and a
  // whole-blood concentration is not a plasma concentration — so moving any of
  // those detaches the quote exactly as moving the numbers does. This matters
  // more since the editor started omitting an untouched quote: the server's
  // comparison is now the operative check rather than a backstop.
  it('detaches a preserved quote when the matrix changes', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote: QUOTE,
    });

    await updateParameterEntryRow(id, {
      low: 10,
      high: 30,
      unit: 'mg/L',
      // The observation moved to a different sampled matrix.
      matrix: 'whole_blood',
      scenario: 'living_therapeutic',
      citationId: null as never,
    } as never);

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.sourceQuote).toBeNull();
  });

  it('detaches a preserved quote when the sample size changes', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      matrix: 'serum',
      origin: 'legacy',
      n: 12,
      sourceQuote: 'Therapeutic concentrations in 12 participants were 10–30 mg/L.',
    });

    await updateParameterEntryRow(id, {
      low: 10,
      high: 30,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      // The cohort changed; the sentence names the old one.
      n: 24,
      citationId: null as never,
    } as never);

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.sourceQuote).toBeNull();
  });

  it('replaces the quote when the patch carries a new one', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote: QUOTE,
    });

    await updateParameterEntryRow(id, {
      low: 10,
      high: 30,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      quote: 'Corrected: the reported range was 10 to 30 mg/L in plasma.',
      citationId: null as never,
    } as never);

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.sourceQuote).toBe(
      'Corrected: the reported range was 10 to 30 mg/L in plasma.',
    );
  });
});

// The same omission-preserve rule as `quote` above, and for the same reason:
// `observationContext` is new (#1257, migration 0120), so every caller built
// before it existed — a queued pending-edit payload, an unaware script — omits
// it on every update, and `?? null` would silently erase context a different
// (newer) caller recorded. Unlike `quote`, preservation carries no staleness
// condition of its own: there is nothing recursive here, just presence.
describe('updating an entry preserves observationContext when the patch omits it', () => {
  const QUOTE = 'Fasted, single dose; serum concentrations were 10 to 30 mg/L.';
  const CONTEXT = 'Dose: 30 mg · Populasjon: healthy volunteers';

  it('keeps the stored value and the quote when the patch does not mention it', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote: QUOTE,
      observationContext: CONTEXT,
    });

    // A pre-existing caller's payload: every OTHER evidence dimension stated,
    // `observationContext` never mentioned because it did not exist when this
    // caller was written.
    await updateParameterEntryRow(id, {
      low: 10,
      high: 30,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      citationId: null as never,
    } as never);

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    // Neither the context nor the quote it is evidence for was erased.
    expect(row!.observationContext).toBe(CONTEXT);
    expect(row!.sourceQuote).toBe(QUOTE);
  });

  it('replaces the value and detaches the quote when the patch states a new one', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote: QUOTE,
      observationContext: CONTEXT,
    });

    await updateParameterEntryRow(id, {
      low: 10,
      high: 30,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      observationContext: 'Dose: 30 mg · Populasjon: fed subjects',
      citationId: null as never,
    } as never);

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.observationContext).toBe('Dose: 30 mg · Populasjon: fed subjects');
    // The old sentence is no longer evidence for a different-context reading.
    expect(row!.sourceQuote).toBeNull();
  });

  it('clears the value and detaches the quote when the patch states an explicit null', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '30',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote: QUOTE,
      observationContext: CONTEXT,
    });

    await updateParameterEntryRow(id, {
      low: 10,
      high: 30,
      unit: 'mg/L',
      matrix: 'serum',
      scenario: 'living_therapeutic',
      observationContext: null,
      citationId: null as never,
    } as never);

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.observationContext).toBeNull();
    expect(row!.sourceQuote).toBeNull();
  });
});

// The gap-filling write, and what it reports. A caller that ignored a failed
// attach would tell its user the quote was stored when another request had
// filled the column with something else in between — and "we recorded your
// provenance" is not a claim to make on a guess.
describe('attachSourceQuoteIfMissing', () => {
  const QUOTE = 'Therapeutic serum concentrations ranged from 10 to 30 mg/L.';

  async function seedQuoted(sourceQuote: string | null): Promise<number> {
    const drugId = await seedDrug(db);
    return seedEntry({
      drugId,
      low: '10',
      high: '30',
      matrix: 'serum',
      origin: 'legacy',
      sourceQuote,
    });
  }

  /**
   * The whole observation, as the seeded row states it.
   *
   * A matcher has to pin EVERY evidence dimension, not the handful it happened
   * to think of: an unpinned one is one a concurrent direct write can move
   * while the guarded WHERE still matches, filing the sentence against a
   * different observation. `QuoteEvidenceSnapshot` makes leaving one out a type
   * error in production code; these fixtures state them all for the same
   * reason, so a test can only describe a matcher that could actually exist.
   */
  const wholeObservation = (
    overrides: Partial<QuoteEvidenceSnapshot> = {},
  ): QuoteEvidenceSnapshot => ({
    citationId: null,
    unit: 'mg/L',
    low: 10,
    high: 30,
    median: null,
    qualifier: null,
    categoricalValue: null,
    route: null,
    matrix: 'serum',
    scenario: 'living_therapeutic',
    n: null,
    observationContext: null,
    ...overrides,
  });

  it('fills an empty quote and says so', async () => {
    const id = await seedQuoted(null);
    expect(await attachSourceQuoteIfMissing(id, QUOTE)).toEqual({
      attached: true,
      current: QUOTE,
    });
  });

  // The id and a NULL quote identify a ROW, not the observation the caller
  // approved the sentence for. An ingestion plans the attach, and a direct
  // writer can move the row's citation, numbers or cohort before the write
  // runs — after which the admin-approved sentence would be filed against a
  // reading nobody checked it against.
  it('refuses when the reading moved since the caller matched it', async () => {
    const id = await seedQuoted(null);
    const expected = wholeObservation();

    // Somebody rewrites the reading first.
    await db
      .update(parameterEntries)
      .set({ low: '5', high: '50' })
      .where(eq(parameterEntries.id, id));

    expect(await attachSourceQuoteIfMissing(id, QUOTE, expected)).toEqual({
      attached: false,
      current: null,
    });
    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.sourceQuote).toBeNull();
  });

  // The ingestion records the observation's context (dose, route, population)
  // in `observationContext` and compares it before deciding to attach. The
  // locked write has to compare it too, or the check is only as good as the
  // gap between the two: a direct writer that changes ONLY the context leaves
  // every other predicate matching.
  it('refuses when only the study context moved since the caller matched it', async () => {
    const id = await seedQuoted(null);
    const expected = wholeObservation();

    await db
      .update(parameterEntries)
      .set({ observationContext: 'Dose: 30 mg' })
      .where(eq(parameterEntries.id, id));

    expect(await attachSourceQuoteIfMissing(id, QUOTE, expected)).toEqual({
      attached: false,
      current: null,
    });
    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.sourceQuote).toBeNull();
  });

  // `comments` is curator commentary, not evidence (#1257): a matcher has no
  // way to even state it any more (`QuoteEvidenceSnapshot` dropped the field),
  // so a direct writer changing only `comments` must not block the attach the
  // way changing `observationContext` above does.
  it('attaches when only comments moved since the caller matched it', async () => {
    const id = await seedQuoted(null);
    const expected = wholeObservation();

    await db
      .update(parameterEntries)
      .set({ comments: 'Double-checked against table 3.' })
      .where(eq(parameterEntries.id, id));

    expect(await attachSourceQuoteIfMissing(id, QUOTE, expected)).toEqual({
      attached: true,
      current: QUOTE,
    });
  });

  // Entries DO move between drugs: a merge reassigns every one of the loser's
  // rows to the winner. So the owner is whatever the row says at the moment of
  // the write, never a value cached from an earlier call — the lock has to be
  // over the drug that owns it now, or it serializes against nobody.
  //
  // This pins that the attach follows the row. The RETRY it guards (a move
  // landing between the read and the lock) is concurrency-only and has no
  // deterministic test; the re-read under the lock is what makes it safe.
  it('attaches against the drug that owns the row now, not the one it read', async () => {
    const id = await seedQuoted(null);
    const moved = await seedDrug(db, {
      slug: 'moved-owner',
      names: { nb: 'Flyttet' },
    });
    await db
      .update(parameterEntries)
      .set({ drugId: moved })
      .where(eq(parameterEntries.id, id));

    expect(await attachSourceQuoteIfMissing(id, QUOTE)).toEqual({
      attached: true,
      current: QUOTE,
    });
  });

  it('reports a no-op when the entry is gone', async () => {
    const id = await seedQuoted(null);
    await db.delete(parameterEntries).where(eq(parameterEntries.id, id));
    expect(await attachSourceQuoteIfMissing(id, QUOTE)).toEqual({
      attached: false,
      current: null,
    });
  });

  // Route is an evidence dimension like any other, and the one that was
  // omitted. For a route-optional parameter — `tmax`, `bioavailability` — a
  // curator scoping a drug-level row to `oral` is ordinary work, not a rare
  // event, and it turns the row into a different observation. A matcher that
  // did not pin route left every other predicate satisfied, so the guarded
  // write still fired and filed the admin's sentence against it.
  it('refuses when the row was scoped to a route since the caller matched it', async () => {
    const id = await seedQuoted(null);
    const expected = wholeObservation();

    await db
      .update(parameterEntries)
      .set({ route: 'oral' })
      .where(eq(parameterEntries.id, id));

    expect(await attachSourceQuoteIfMissing(id, QUOTE, expected)).toEqual({
      attached: false,
      current: null,
    });
    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.sourceQuote).toBeNull();
  });

  it('attaches when the reading is still the one the caller matched', async () => {
    const id = await seedQuoted(null);
    expect(
      await attachSourceQuoteIfMissing(id, QUOTE, wholeObservation()),
    ).toEqual({ attached: true, current: QUOTE });
  });

  it('leaves an occupied quote alone and reports what is really there', async () => {
    const occupied = 'A different reading of the same table.';
    const id = await seedQuoted(occupied);

    // Not attached, and the caller is handed the stored sentence rather than a
    // bare `false` it would have to go and interpret.
    expect(await attachSourceQuoteIfMissing(id, QUOTE)).toEqual({
      attached: false,
      current: occupied,
    });

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row!.sourceQuote).toBe(occupied);
  });

  it('reports the stored sentence when it is the same one', async () => {
    const id = await seedQuoted(QUOTE);
    // The caller compares in canonical form and treats this as an idempotent
    // re-run rather than a conflict.
    expect(await attachSourceQuoteIfMissing(id, QUOTE)).toEqual({
      attached: false,
      current: QUOTE,
    });
  });
});

describe('migration 0080 — qualifier-aware grandfather correction', () => {
  it('grandfathers a "< X" value suppressed by a bare-bounds whole-blood entry', async () => {
    const userId = await seedUser(db);
    const drugId = await seedDrug(db);
    // Authored strict threshold "< 120".
    await db.insert(drugParameters).values({
      drugId,
      parameter: 'toxicConcentration',
      value: { max: 120, qualifier: '<', unit: 'mg/L' },
      updatedBy: userId,
    });
    // A pre-existing whole-blood entry matching bounds/median/unit but with NO
    // qualifier — this is what 0078's guard used to suppress the synthetic.
    await seedEntry({
      drugId,
      parameter: 'toxicConcentration',
      low: null,
      high: '120',
      unit: 'mg/L',
      matrix: 'whole_blood',
      scenario: 'living_toxic',
      origin: 'legacy',
    });

    await db.execute(
      sql.raw(
        migrationStatement(
          '0080_grandfather_qualifier_fix',
          'INSERT INTO "parameter_entries"',
        ),
      ),
    );

    // The "< 120" value is now grandfathered as its own entry carrying the
    // operator, distinct from the bare-120 entry.
    const corrected = await db
      .select()
      .from(parameterEntries)
      .where(
        and(
          eq(parameterEntries.drugId, drugId),
          eq(parameterEntries.qualifier, '<'),
        ),
      );
    expect(corrected).toHaveLength(1);
    expect(corrected[0]!.origin).toBe('grandfathered');
    expect(Number(corrected[0]!.high)).toBe(120);

    // Idempotent: re-running does not add a second copy (now matches on qualifier).
    await db.execute(
      sql.raw(
        migrationStatement(
          '0080_grandfather_qualifier_fix',
          'INSERT INTO "parameter_entries"',
        ),
      ),
    );
    const afterRerun = await db
      .select()
      .from(parameterEntries)
      .where(
        and(
          eq(parameterEntries.drugId, drugId),
          eq(parameterEntries.qualifier, '<'),
        ),
      );
    expect(afterRerun).toHaveLength(1);
  });
});

// Codex P1 on #1452: a legacy concentration row labelled through the entry
// editor (migration 0135) and then edited through this endpoint must not keep
// the OLD centre, statistic and interval kind beside the new bounds — that
// would either publish a stale mean ± SD or trip the statistic CHECK.
describe('the legacy concentration updater and the reported statistic', () => {
  it('clears a labelled centre when it replaces the reading, and detaches the quote', async () => {
    const drugId = await seedDrug(db);
    const id = await seedEntry({
      drugId,
      low: '10',
      high: '100',
      centralValue: '40',
      centralStatistic: 'arithmetic_mean',
      intervalKind: 'range',
      origin: 'legacy',
      sourceQuote: 'Mean 40 mg/L (range 10–100).',
    });

    // The old centre (40) lies outside the new range: kept, it would violate
    // parameter_entries_reported_statistic.
    const updated = await updateReferenceConcentration({
      id,
      input: {
        low: 50,
        high: 80,
        unit: 'mg/L',
        matrix: 'serum',
        scenario: 'living_therapeutic',
      },
    });
    expect(updated).not.toBeNull();

    const [row] = await db
      .select()
      .from(parameterEntries)
      .where(eq(parameterEntries.id, id));
    expect(row).toMatchObject({
      low: '50.000000',
      high: '80.000000',
      median: null,
      centralValue: null,
      centralStatistic: null,
      intervalKind: null,
      sourceQuote: null,
    });
  });
});
