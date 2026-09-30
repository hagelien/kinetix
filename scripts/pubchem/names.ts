/**
 * Deciding whether two strings name the same substance.
 *
 * Split out of the audit because it is the part with judgement in it, and the
 * part whose mistakes are invisible: too strict and a Norwegian catalog reports
 * as entirely suspect, too loose and a CID naming a different drug is silently
 * cleared. Shared with `retarget-pubchem-cid.ts`, which must not accept a
 * replacement CID unless the substance actually answers to the drug's name.
 */
/**
 * Fold a substance name to a form that survives the trip between Norwegian and
 * English INN orthography.
 *
 * The two differ by a small, regular set of substitutions — `ph`/`f`, `c`/`k`,
 * `x`/`ks`, `y`/`i`, a trailing `-e` — so `Ephedrine` and `Efedrin` are the
 * same word spelled by two conventions, and a comparison that cannot see that
 * reports most of the catalog as suspect. Deliberately lossy: this decides
 * "close enough to be the same substance", never "these are distinct".
 */
export function foldName(raw: string): string {
  let s = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  // Stereo/charge decorations PubChem titles carry and catalog names do not.
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  s = s.replace(/[^a-z0-9]+/g, '');
  // Digraphs first: `ch` has to be spent before either `c` rule sees it.
  s = s.replace(/ph/g, 'f').replace(/th/g, 't').replace(/ch/g, 'k');
  // Latin `c` is two sounds, and Norwegian spells them apart: soft before
  // e/i/y becomes `s` (cetirizin → setirisin, cyklofosfamid → syklofosfamid),
  // hard becomes `k` (kodein, skopolamin). Folding both to `k` was wrong in
  // exactly the cases with a `cy-` prefix, which is a lot of them.
  s = s.replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k');
  s = s
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/w/g, 'v')
    .replace(/y/g, 'i');
  s = s.replace(/(.)\1+/g, '$1');
  s = s.replace(/e$/, '');
  return s;
}

/**
 * REMOVED: a bounded edit-distance "close enough" test.
 *
 * It existed to bridge elision — Latin `chloro-`/`fluoro-` against Norwegian
 * `klor-`/`fluor-` — by allowing two edits over a folded name of twelve
 * characters or more. The length gate was chosen on the belief that two
 * characters could not reach a neighbouring drug name at that length. That
 * belief is false, and this catalog holds the counter-examples:
 *
 *   fenobarbital  / pentobarbital    two barbiturates, distance 2
 *   flubromasepam / flubromasolam    two designer benzodiazepines, distance 2
 *
 * Both would have been cleared as the same substance, at stage 1, before the
 * synonym list or the connectivity check could object — and `retarget:cid`
 * would have accepted either as a replacement CID for the other. In a forensic
 * toxicology catalog those are the exact pairs a reader must not have confused
 * on their behalf.
 *
 * No threshold fixes this. The distance between two drug names carries no
 * information about whether they are the same molecule: INN stems are shared
 * deliberately, so pharmacologically adjacent substances have adjacent names by
 * design. What replaces it is nothing at the name layer — a name must match
 * exactly once folded — and the InChIKey connectivity comparison in the audit's
 * verdict, which is the check that actually knows chemistry.
 *
 * The cost is a longer review list: a name the fold cannot bridge falls through
 * to the synonym lookup and, failing that, to the report. That is the direction
 * this tool is allowed to be wrong in.
 */

/**
 * The counter-ion and hydrate words a PubChem title adds to the parent name.
 *
 * `Warfarin sodium` and `Sildenafil citrate` are the same substance the catalog
 * carries under the bare name, so the head of the title is compared too. Only
 * the head — dropping a word that is *not* in this list would let `Codeine
 * phosphate` match a drug named `Codeine N-oxide`.
 */
const COUNTER_ION = new Set([
  'sodium',
  'potassium',
  'calcium',
  'magnesium',
  'hydrochloride',
  'hcl',
  'hydrobromide',
  'hydroiodide',
  'citrate',
  'maleate',
  'tartrate',
  'bitartrate',
  'fumarate',
  'mesylate',
  'besylate',
  'tosylate',
  'nitrate',
  'oxalate',
  'malate',
  'lactate',
  'gluconate',
  'hemihydrate',
  'monohydrate',
  'dihydrate',
  'trihydrate',
  'pentahydrate',
  'hydrate',
  'anhydrous',
  'free',
  'base',
]);

/**
 * Deliberately NOT in the set above: `sulfate`, `sulphate`, `bisulfate`,
 * `phosphate`, `acetate`, `succinate`, `propionate`, `valerate`, `benzoate`,
 * `decanoate`, `palmitate`, `stearate`, `salicylate`.
 *
 * Every one of them names an ESTER as often as a salt, and an ester is a
 * different molecule with a different formula — usually a prodrug with its own
 * pharmacokinetics, which in this catalog is the whole point of carrying it
 * separately. `Haloperidol decanoate` is not haloperidol with a counter-ion; it
 * is a depot ester with a half-life measured in weeks. Shortening it would have
 * cleared its CID against a drug named `Haloperidol` at stage 1, before either
 * the synonym or the connectivity check could object.
 *
 * `sulfate` and `phosphate` are the two that matter most HERE, whatever their
 * frequency as counter-ions elsewhere: they are the phase II conjugations. A
 * forensic toxicology catalog carries `Estrone sulfate` beside estrone, and the
 * conjugate is the analyte — a covalent metabolite with its own detection
 * window, not a packaging detail. `Morphine sulfate` is a salt and `Estrone
 * sulfate` is not, and the title alone cannot tell them apart, so neither gets
 * to shorten.
 *
 * The cost of leaving them out is that a genuine salt spelled with one of these
 * falls through to the synonym lookup, which usually resolves it anyway. The
 * cost of leaving them in is a wrong CID reported as confirmed. Those are not
 * comparable, so the ambiguous cases go to the slower path.
 */

/**
 * Strip trailing counter-ion words, and ONLY those.
 *
 * Written as a token walk rather than a regex tail because the regex form of
 * this had a hole that defeated the exclusion list above. `/\s+(sodium|…)\b.*$/`
 * consumes everything after the first recognised word, so
 * `Dexamethasone sodium phosphate` shortened to `Dexamethasone` — the `sodium`
 * arm ate the `phosphate` that was withheld from the list precisely so this
 * could not happen. Dexamethasone sodium phosphate is a phosphate ESTER
 * prodrug: different formula, different connectivity, different kinetics, and
 * it would have been reported as confirming a CID for plain dexamethasone at
 * stage 1, before the InChIKey comparison could object.
 *
 * So the walk stops at the first word it does not recognise and, crucially,
 * gives up entirely rather than returning what it managed to strip. Anything
 * left over is an unknown modifier, and an unknown modifier is exactly the case
 * that has to reach the slower checks.
 */
function counterIonHead(title: string): string | null {
  const parts = title.trim().split(/\s+/);
  let end = parts.length;
  while (end > 1 && COUNTER_ION.has(parts[end - 1]!.toLowerCase())) end--;
  if (end === parts.length) return null;
  const head = parts.slice(0, end).join(' ');
  return head || null;
}

/** A PubChem title, plus the shorter forms a catalog name might match. */
export function candidates(title: string): string[] {
  const out = [title];
  // ONLY a recognised tail. Taking the first word of any title instead — which
  // an earlier revision did — matches `Codeine N-oxide` against a drug named
  // `Codeine`, and a false match at this stage is the worst outcome the audit
  // has: the row skips the synonym and formula checks and is reported as
  // confirmed. A derivative sharing its parent's first word is exactly the
  // wrong-compound case this exists to find.
  const head = counterIonHead(title);
  if (head && head !== title) out.push(head);
  return out;
}

/** What a catalog row is called, in every field that names it. */
export interface NamedRow {
  names: Record<string, string> | null;
  aliases: string[] | null;
  nameShort: string | null;
}

/** Every spelling the catalog itself has for this drug, folded. */
export function catalogForms(d: NamedRow): Set<string> {
  const out = new Set<string>();
  const add = (v: string | null | undefined): void => {
    if (!v) return;
    const f = foldName(v);
    if (f) out.add(f);
  };
  for (const n of Object.values(d.names ?? {})) add(String(n));
  for (const a of d.aliases ?? []) add(a);
  add(d.nameShort);
  return out;
}

/** Does any spelling the catalog holds mean the same thing as `candidate`? */
export function matchesAny(forms: Set<string>, candidate: string): boolean {
  const folded = foldName(candidate);
  if (!folded) return false;
  return forms.has(folded);
}
