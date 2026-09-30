/**
 * Does every drug's PubChem CID actually name that drug?
 *
 * A CID is not a label, it is the substance's identity: it seeds the offline
 * catalog, keys the PM concentration datasets, resolves analytical-method
 * components, is the id a saved simulator case pins, and is what a reader follows
 * out to PubChem. A wrong one is invisible in the UI — the monograph shows the
 * name somebody typed — and wrong in every direction at once.
 *
 * They exist. `sildenafil` carried CID 9793760 (*Methyl 1H-pyrazole-4-
 * carboxylate*, C5H6N2O2) and `telmisartan` carried 6940 (*2-Bromobenzoic
 * acid*) — two rows resolved by a name-to-CID lookup that returned a hit rather
 * than the right hit, then never checked. Nothing in the catalog notices,
 * because nothing else ever asks PubChem what that number means.
 *
 * This asks. It reads only, and its output is a review list rather than a fix:
 * deciding that a CID is wrong is a curation call, and the two failure classes
 * below want different answers.
 *
 *   WRONG COMPOUND    the CID is a different substance entirely (sildenafil,
 *                     telmisartan). Always a bug.
 *   VARIANT RECORD    the CID is a real record for this substance but not its
 *                     canonical parent — a stereoisomer, a tautomer, a
 *                     systematic-name duplicate (enalapril under its systematic
 *                     name). Defensible, but it is what produces two catalog
 *                     rows for one substance.
 *
 * The two are separated by CONNECTIVITY, not by molecular formula: the first
 * block of an InChIKey is the same across stereochemistry, tautomers and
 * charge, and different for a constitutional isomer. Formula equality would
 * clear an isomer into the benign group, which is the one call this must not
 * get wrong.
 *
 * **Known over-claim: a SALT reads as `wrong-compound`.** An InChIKey hashes the
 * whole record, and a hydrochloride is a two-component record, so its first
 * block bears no relation to the free base's. `2-Fluordesklorketamin` holds the
 * free base and its name resolves to the hydrochloride; the verdict says wrong
 * compound where the honest answer is variant record. The formulas printed
 * beside it say so plainly — `C13H16FNO` against `C13H17ClFNO` is an added HCl —
 * which is why the report tells a reader to look at the formula rather than the
 * verdict. Fixing it properly means asking PubChem for each record's PARENT cid,
 * a second request per suspect; deliberately not done by guessing at counter-ion
 * arithmetic, since a rule invented to make a verdict come out right is how the
 * name matcher went wrong.
 *
 * Two stages, because the cheap question answers most of it:
 *
 *   1. One batched property lookup per 100 CIDs asks PubChem for each one's
 *      title and formula, and compares the title to the drug's own names.
 *   2. Only what stage 1 could not match spends a request on that CID's full
 *      synonym list — where the Norwegian INN spelling usually is, if the CID
 *      is right at all.
 *
 * **The counts are not exactly reproducible, and that is PubChem's doing.** The
 * synonym endpoint returns a bounded, unordered list that varies between calls,
 * so a row whose Norwegian spelling sits near the tail can clear on one run and
 * fall through to the report on the next. Two rows changed places between
 * consecutive runs here with the total unchanged. Read a finding as "this row
 * needs a look", never a count as a measurement, and re-run before concluding
 * that something was fixed.
 *
 * Usage:
 *   npm run audit:pubchem-identity
 *   npm run audit:pubchem-identity -- --json report.json
 */
import 'dotenv/config';
import fs from 'node:fs';
import { sql } from 'drizzle-orm';
import { getDb } from '../api/_lib/db';
import {
  candidates,
  catalogForms,
  matchesAny,
  type NamedRow,
} from './pubchem/names';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const PUBCHEM = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid';
/** PubChem asks for ≤5 requests/second; stage 2 is one request per suspect. */
const SYNONYM_DELAY_MS = 250;
const BATCH = 100;

interface DrugRow extends NamedRow {
  id: number;
  slug: string;
  pubchemCid: number;
  source: string | null;
}

interface PubchemProps {
  cid: number;
  title: string | null;
  formula: string | null;
  /** Full InChIKey; only its first block is ever compared. See `skeleton`. */
  inchiKey: string | null;
}

/**
 * The connectivity block of an InChIKey — what makes two records the same
 * *molecule* rather than merely the same *atom count*.
 *
 * A molecular formula cannot tell a substance from its constitutional isomer,
 * and the catalog is full of pairs that would collide on formula alone. The
 * first 14 characters of an InChIKey hash the skeleton and connectivity, so
 * they differ for a positional isomer and match across stereochemistry,
 * tautomers and charge — which is exactly the line between "wrong compound"
 * and "another record for this substance".
 */
function skeleton(key: string | null | undefined): string | null {
  if (!key) return null;
  const block = key.split('-')[0];
  return block && block.length === 14 ? block : null;
}

async function fetchProps(cids: number[]): Promise<Map<number, PubchemProps>> {
  const out = new Map<number, PubchemProps>();
  for (let i = 0; i < cids.length; i += BATCH) {
    const chunk = cids.slice(i, i + BATCH);
    const url = `${PUBCHEM}/${chunk.join(',')}/property/Title,MolecularFormula,InChIKey/JSON`;
    const res = await fetch(url);
    if (!res.ok) {
      // PubChem fails the WHOLE request when one CID in it is retired, and a
      // transient 5xx does the same. Skipping the chunk would then emit up to a
      // hundred perfectly good rows as `resolved: false` — reported to a
      // curator as "CID NOT FOUND" for numbers that were never asked about
      // individually. That is the audit inventing findings, which is worse than
      // it missing some.
      //
      // So the chunk is re-asked one CID at a time. Slow, and deliberately
      // reached only on failure: what survives is a genuine per-CID answer, and
      // what does not is genuinely missing.
      console.warn(
        `  ! batch of ${chunk.length} failed (${res.status}) — retrying individually`,
      );
      for (const cid of chunk) {
        const one = await fetch(`${PUBCHEM}/${cid}/property/Title,MolecularFormula,InChIKey/JSON`);
        await new Promise((r) => setTimeout(r, SYNONYM_DELAY_MS));
        if (!one.ok) continue;
        const single = (await one.json()) as {
          PropertyTable?: {
            Properties?: {
              CID: number;
              Title?: string;
              MolecularFormula?: string;
              InChIKey?: string;
            }[];
          };
        };
        const p = single.PropertyTable?.Properties?.[0];
        if (p) {
          out.set(p.CID, {
            cid: p.CID,
            title: p.Title ?? null,
            formula: p.MolecularFormula ?? null,
            inchiKey: p.InChIKey ?? null,
          });
        }
      }
      continue;
    }
    const body = (await res.json()) as {
      PropertyTable?: {
        Properties?: {
          CID: number;
          Title?: string;
          MolecularFormula?: string;
          InChIKey?: string;
        }[];
      };
    };
    for (const p of body.PropertyTable?.Properties ?? []) {
      out.set(p.CID, {
        cid: p.CID,
        title: p.Title ?? null,
        formula: p.MolecularFormula ?? null,
        inchiKey: p.InChIKey ?? null,
      });
    }
  }
  return out;
}

/**
 * What PubChem returns when asked for this NAME — the record the catalog should
 * probably be pointing at.
 *
 * This is what separates the two failure classes, and they want opposite
 * responses. Compare the formula of the stored CID against the formula of the
 * record the name resolves to: different formula means the stored CID is a
 * different substance (fix the CID); same formula means it is another record
 * for the same substance (a merge, or a deliberate choice of record).
 *
 * Tried against every spelling the catalog holds, because the Norwegian INN
 * resolves for some substances and only the English does for others.
 */
async function resolveByName(
  names: string[],
): Promise<{
  cid: number;
  title: string | null;
  formula: string | null;
  inchiKey: string | null;
} | null> {
  for (const name of names) {
    if (!name.trim()) continue;
    const res = await fetch(
      `${PUBCHEM.replace('/cid', '/name')}/${encodeURIComponent(name.trim())}` +
        '/property/Title,MolecularFormula,InChIKey/JSON',
    );
    await new Promise((r) => setTimeout(r, SYNONYM_DELAY_MS));
    if (!res.ok) continue;
    const body = (await res.json()) as {
      PropertyTable?: {
        Properties?: {
          CID: number;
          Title?: string;
          MolecularFormula?: string;
          InChIKey?: string;
        }[];
      };
    };
    const p = body.PropertyTable?.Properties?.[0];
    if (!p) continue;
    return {
      cid: p.CID,
      title: p.Title ?? null,
      formula: p.MolecularFormula ?? null,
      inchiKey: p.InChIKey ?? null,
    };
  }
  return null;
}

async function fetchSynonyms(cid: number): Promise<string[]> {
  const res = await fetch(`${PUBCHEM}/${cid}/synonyms/JSON`);
  if (!res.ok) return [];
  const body = (await res.json()) as {
    InformationList?: { Information?: { Synonym?: string[] }[] };
  };
  return body.InformationList?.Information?.[0]?.Synonym ?? [];
}

interface Finding {
  id: number;
  slug: string;
  cid: number;
  source: string | null;
  catalogNames: string[];
  pubchemTitle: string | null;
  formula: string | null;
  /** Absent when PubChem returned nothing for the CID at all. */
  resolved: boolean;
  verdict: Verdict;
  /** The record the drug's own name resolves to, when one does. */
  suggested: {
    cid: number;
    title: string | null;
    formula: string | null;
    inchiKey: string | null;
  } | null;
}

/**
 * Severity, and it is the whole point of the report.
 *
 * `wrong-compound` is a data error to fix. `variant-record` is the same
 * substance under another PubChem record — usually harmless on its own, and
 * exactly what produces a second catalog row when a CID-keyed seeder meets it.
 * `unverified` means PubChem could not resolve any spelling the catalog holds,
 * so nothing here is a claim about that row.
 */
type Verdict = 'wrong-compound' | 'variant-record' | 'unverified';

const VERDICT_ORDER: Verdict[] = ['wrong-compound', 'variant-record', 'unverified'];

async function main(): Promise<void> {
  const jsonAt = (() => {
    const i = process.argv.indexOf('--json');
    return i >= 0 ? process.argv[i + 1] : null;
  })();

  const res = await getDb().execute(sql.raw(`
    SELECT id, slug, pubchem_cid AS "pubchemCid", names, aliases,
           name_short AS "nameShort", source
    FROM drugs WHERE pubchem_cid IS NOT NULL ORDER BY id`));
  const rows = (((res as { rows?: unknown[] }).rows ?? res) as unknown) as DrugRow[];
  console.log(`Auditing ${rows.length} drugs with a PubChem CID.\n`);

  const props = await fetchProps(rows.map((r) => r.pubchemCid));

  const suspects: DrugRow[] = [];
  let matched = 0;
  for (const drug of rows) {
    const p = props.get(drug.pubchemCid);
    const forms = catalogForms(drug);
    const hit =
      p?.title != null &&
      candidates(p.title).some((c) => matchesAny(forms, c));
    if (hit) matched++;
    else suspects.push(drug);
  }

  console.log(
    `  ${matched} matched on title alone; ${suspects.length} need the synonym list.\n`,
  );

  const findings: Finding[] = [];
  for (const [i, drug] of suspects.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, SYNONYM_DELAY_MS));
    const p = props.get(drug.pubchemCid);
    const forms = catalogForms(drug);
    const synonyms = await fetchSynonyms(drug.pubchemCid);
    if (synonyms.some((s) => matchesAny(forms, s))) {
      matched++;
      continue;
    }
    const catalogNames = [
      ...Object.values(drug.names ?? {}).map(String),
      ...(drug.aliases ?? []),
    ];
    const suggested = await resolveByName(catalogNames);
    // `variant-record` is a claim that the stored CID is ANOTHER RECORD FOR THE
    // SAME SUBSTANCE, and it can only be made when the stored CID resolved:
    // without `p` there is no formula to compare, and the row is exactly the
    // kind that most deserves attention — a retired CID, or one whose batch
    // lookup failed. Sorting it into the benign group on the strength of the
    // name lookup alone would contradict its own `resolved: false`.
    //
    // Connectivity decides it where both records offer an InChIKey, because
    // **matching formulas do not mean matching substances**: a constitutional
    // isomer of the intended drug has the same atom count and a different
    // molecule, and calling that a benign variant is the one mistake this
    // classification cannot afford. Skeleton equality is the right line — it
    // survives stereochemistry, tautomers and charge, which are what a genuine
    // variant record differs by, and breaks on connectivity, which is what a
    // different compound differs by.
    //
    // Formula is kept only for what it can prove: a formula MISMATCH is enough
    // to say wrong compound. Formula equality on its own proves nothing, so
    // without keys the row stays unverified rather than being cleared.
    const verdict: Verdict = ((): Verdict => {
      if (p == null || !suggested) return 'unverified';
      const here = skeleton(p.inchiKey);
      const there = skeleton(suggested.inchiKey);
      if (here && there) return here === there ? 'variant-record' : 'wrong-compound';
      if (p.formula != null && suggested.formula != null) {
        return p.formula !== suggested.formula ? 'wrong-compound' : 'unverified';
      }
      return 'unverified';
    })();

    findings.push({
      id: drug.id,
      slug: drug.slug,
      cid: drug.pubchemCid,
      source: drug.source,
      catalogNames,
      pubchemTitle: p?.title ?? null,
      formula: p?.formula ?? null,
      resolved: p != null,
      verdict,
      suggested,
    });
    process.stdout.write(`  checked ${i + 1}/${suspects.length}\r`);
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`Matched: ${matched}   Unmatched: ${findings.length}\n`);

  for (const verdict of VERDICT_ORDER) {
    const group = findings.filter((f) => f.verdict === verdict);
    if (group.length === 0) continue;
    console.log(`\n${verdict.toUpperCase()} — ${group.length}\n`);
    for (const f of group) {
      console.log(
        `  drug ${f.id} /${f.slug}  CID ${f.cid}${f.source ? `  (${f.source})` : ''}`,
      );
      console.log(`    catalog  : ${f.catalogNames.join(', ') || '(unnamed)'}`);
      console.log(
        f.resolved
          ? `    stored   : ${f.pubchemTitle ?? '(no title)'}  ${f.formula ?? ''}`
          : '    stored   : CID NOT FOUND — the number resolves to nothing',
      );
      if (f.suggested) {
        console.log(
          `    by name  : CID ${f.suggested.cid}  ${f.suggested.title ?? ''}  ` +
            `${f.suggested.formula ?? ''}`,
        );
      }
    }
  }

  if (jsonAt) {
    fs.writeFileSync(jsonAt, `${JSON.stringify(findings, null, 2)}\n`);
    console.log(`\nWrote ${findings.length} finding(s) to ${jsonAt}`);
  }

  console.log(
    '\nRe-run before concluding anything from a count: PubChem\'s synonym list is ' +
      'bounded and unordered, so a borderline row can clear on one run and appear ' +
      'on the next. A finding means "look at this row", not "this many are wrong".',
  );
  console.log(
    '\n`by name` is itself a PubChem name lookup and can miss the same way the ' +
      'importer did — an abbreviation like `DOC` or a trade name resolves to ' +
      'whatever PubChem indexes under it. Read the formula, not the number.',
  );
  console.log(
    '\nUnmatched is a review list, not a verdict. A CID whose title names a ' +
      'different substance is a bug; one that is a salt, an anion or a ' +
      'systematic-name duplicate of the right substance is the pattern that ' +
      'produces two catalog rows for one drug — see ' +
      'docs/ops/farmakologiportalen-links.md for merging those.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
