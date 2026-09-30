/**
 * Does this piece of Norwegian prose spell `æ`, `ø` and `å`, or did its author
 * transliterate them away?
 *
 * Kinetix's reader-facing content is Norwegian (bokmål), and every agent
 * prompt says so. What no prompt used to say is that the LETTERS have to
 * survive: a stretch of agent-authored prose reading "en aerlig
 * karakteristikk ... ikke ny malt, verdi" is grammatical Norwegian with the
 * three Norwegian vowels replaced by ASCII stand-ins. It reads as machine
 * output to exactly the clinicians and forensic toxicologists the text is
 * written for.
 *
 * The habit came from transport, not from the language: agent request bodies
 * were once mangled on a Windows runner (fixed in #1222 — the helpers stream
 * UTF-8 bytes on stdin), and an author who has seen `æ` come back broken will
 * reasonably start avoiding it. The instructions now forbid the workaround
 * (see `agents/drug-db-maintainer.md` §1), and this module is how already
 * stored prose gets found.
 *
 * Detection is a heuristic over a closed word list, because there is no way to
 * tell "malt" (transliterated "målt") from "malt" (the grain) by shape alone.
 * So each folded spelling carries a confidence:
 *
 *   STRONG  the ASCII form is not a word anyone would write on purpose in
 *           Norwegian or English prose ("ogsaa", "forste", "sporsmal"), so a
 *           hit is a transliteration with near-certainty and is safe to repair
 *           mechanically.
 *   LIKELY  the ASCII form IS a real word somewhere ("malt", "bade", "veske"),
 *           so a hit is a lead for a human or an agent to read in context and
 *           never something to rewrite automatically.
 *
 * `looksNorwegian` + `hasNorwegianLetters` carry the second, independent
 * signal: more than a sentence or two of Norwegian that contains not one
 * `æ`/`ø`/`å` is itself suspicious, whether or not a listed word appears.
 */

/** Confidence that an ASCII spelling really is a transliteration. */
export type OrthographyConfidence = 'strong' | 'likely';

export interface OrthographyHit {
  /** The word as written in the text, in its original case. */
  word: string;
  /** How it is spelled in Norwegian; several when the fold is ambiguous. */
  suggestions: string[];
  confidence: OrthographyConfidence;
}

export interface OrthographyReport {
  /** Every listed folded spelling found, in order of first appearance. */
  hits: OrthographyHit[];
  /** True when the text contains at least one æ/ø/å (either case). */
  hasNorwegianLetters: boolean;
  /** True when enough Norwegian function words appear to call it Norwegian. */
  looksNorwegian: boolean;
  /**
   * The headline judgement: Norwegian prose, no Norwegian letters anywhere in
   * it, and at least one listed folded spelling. This is the combination that
   * a repair pass acts on — a single ambiguous word inside prose that spells
   * `å` elsewhere is just that word, not a transliterated text.
   */
  transliterated: boolean;
}

/**
 * Folded spelling → correct spelling(s), for spellings that are not words in
 * their own right. Both the digraph convention (`aa`/`oe`/`ae`) and the
 * bare-vowel one (`a`/`o`/`a`) appear in practice, sometimes in one sentence,
 * so both are listed.
 *
 * `arlig` is the one entry with two answers: `årlig` (yearly) and `ærlig`
 * (honest) fold to the same ASCII, and only context separates them.
 */
const STRONG: Record<string, string[]> = {
  // på / må / når / nå / så / få / år / også
  pa: ['på'],
  paa: ['på'],
  ma: ['må'],
  maa: ['må'],
  nar: ['når'],
  naar: ['når'],
  na: ['nå'],
  naa: ['nå'],
  saa: ['så'],
  faa: ['få'],
  aar: ['år'],
  ogsa: ['også'],
  ogsaa: ['også'],
  // går / står / gjør / før / være
  gar: ['går'],
  gaar: ['går'],
  star: ['står'],
  staar: ['står'],
  gjor: ['gjør'],
  foer: ['før'],
  vaere: ['være'],
  vaer: ['vær'],
  // ærlig / årlig, and the øke family
  arlig: ['ærlig', 'årlig'],
  aerlig: ['ærlig'],
  aarlig: ['årlig'],
  oke: ['øke'],
  oker: ['øker'],
  okt: ['økt'],
  okning: ['økning'],
  oeke: ['øke'],
  oekning: ['økning'],
  // superlatives and sizes
  forste: ['første'],
  foerste: ['første'],
  storre: ['større'],
  stoerre: ['større'],
  storst: ['størst'],
  storrelse: ['størrelse'],
  stoerrelse: ['størrelse'],
  // høy / død / løsning / løpet
  hoy: ['høy'],
  hoye: ['høye'],
  hoyere: ['høyere'],
  hoyest: ['høyest'],
  hoyde: ['høyde'],
  hoey: ['høy'],
  hoeyere: ['høyere'],
  forhoyet: ['forhøyet'],
  forhoeyet: ['forhøyet'],
  dod: ['død'],
  dodelig: ['dødelig'],
  doed: ['død'],
  losning: ['løsning'],
  loesning: ['løsning'],
  lopet: ['løpet'],
  lopende: ['løpende'],
  loepet: ['løpet'],
  // prøve / spørsmål / nødvendig / øvrig / utført / årsak
  prove: ['prøve'],
  prover: ['prøver'],
  proven: ['prøven'],
  proeve: ['prøve'],
  blodprove: ['blodprøve'],
  blodproeve: ['blodprøve'],
  sporsmal: ['spørsmål'],
  spoersmaal: ['spørsmål'],
  nodvendig: ['nødvendig'],
  noedvendig: ['nødvendig'],
  ovrig: ['øvrig'],
  ovrige: ['øvrige'],
  oevrig: ['øvrig'],
  utfort: ['utført'],
  utfoert: ['utført'],
  arsak: ['årsak'],
  aarsak: ['årsak'],
  arsaken: ['årsaken'],
  // påvist / påvirker / oppnådd / overvåke / unngå / åpen
  pavist: ['påvist'],
  paavist: ['påvist'],
  pavirker: ['påvirker'],
  pavirkning: ['påvirkning'],
  paavirker: ['påvirker'],
  oppnadd: ['oppnådd'],
  oppnaadd: ['oppnådd'],
  overvake: ['overvåke'],
  overvaake: ['overvåke'],
  unnga: ['unngå'],
  unngaa: ['unngå'],
  apen: ['åpen'],
  aapen: ['åpen'],
  // søke / følge / gjennomføre — inflections seen across stored prose
  sok: ['søk'],
  sokt: ['søkt'],
  soke: ['søke'],
  soker: ['søker'],
  soket: ['søket'],
  folge: ['følge'],
  folger: ['følger'],
  folgende: ['følgende'],
  folgelig: ['følgelig'],
  gjennomfort: ['gjennomført'],
  gjennomfore: ['gjennomføre'],
  noyaktig: ['nøyaktig'],
  noyaktighet: ['nøyaktighet'],
  intravenos: ['intravenøs'],
  intravenost: ['intravenøst'],
  storste: ['største'],
  lope: ['løpe'],
  oyeblikk: ['øyeblikk'],
  forovrig: ['forøvrig'],
  tilfores: ['tilføres'],
  tilfort: ['tilført'],
  // foreløpig / tilstrekkelig-adjacent forms seen in agent prose
  forelopig: ['foreløpig'],
  foreloepig: ['foreløpig'],
};

/**
 * Folded spellings that are also ordinary words. A hit here is reported, never
 * repaired: only a reader who knows what the sentence is about can say whether
 * "malt" is a measurement or a grain.
 */
const LIKELY: Record<string, string[]> = {
  malt: ['målt'],
  malte: ['målte'],
  maling: ['måling'],
  malinger: ['målinger'],
  maler: ['måler'],
  mate: ['måte'],
  maten: ['måten'],
  matte: ['måtte'],
  bade: ['både'],
  veske: ['væske'],
  vesken: ['væsken'],
  tor: ['tør', 'tørr'],
};

/**
 * Letter sequences that are a fold wherever they appear inside a Norwegian
 * word and cannot be anything else, so they cover inflections the word list
 * does not enumerate (`paastand`, `paastanden`, `paastandene`).
 *
 * Kept deliberately short: a general `aa → å` rule would rewrite the surnames
 * that genuinely spell it (Haaland, Aasen), and a general `ae → æ` rule would
 * break `aerob` and every Latin term. Each entry below is a sequence no
 * correctly spelled Norwegian or English word contains.
 */
const STRONG_FRAGMENTS: Array<[RegExp, string]> = [
  [/paastand/g, 'påstand'],
  [/pastand/g, 'påstand'],
  [/primaer/g, 'primær'],
  [/sekundaer/g, 'sekundær'],
  [/tertiaer/g, 'tertiær'],
  [/foelge/g, 'følge'],
  [/noeyaktig/g, 'nøyaktig'],
  [/maaling/g, 'måling'],
  [/maalt/g, 'målt'],
];

/** Apply the fragment rules to one lowercase word, or return it unchanged. */
function repairFragments(lower: string): string {
  let out = lower;
  for (const [pattern, replacement] of STRONG_FRAGMENTS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Function words that mark a text as Norwegian. Deliberately words that do NOT
 * contain æ/ø/å themselves, so the marker never depends on the very letters
 * this module is looking for.
 */
const NORWEGIAN_MARKERS = new Set([
  'og',
  'er',
  'ikke',
  'som',
  'til',
  'av',
  'det',
  'den',
  'denne',
  'med',
  'men',
  'en',
  'et',
  'har',
  'ble',
  'kan',
  'ved',
  'om',
  'fra',
  'etter',
  'mot',
  'over',
  'under',
  'verdi',
  'verdien',
  'kilde',
  'kilden',
  'kilder',
  'studie',
  'studien',
  'ingen',
  'noen',
  'eller',
  'siden',
  'derfor',
  'samme',
  'andre',
  'hos',
  'både',
  'også',
]);

/** How many distinct marker words make a text Norwegian rather than a phrase. */
const MARKER_THRESHOLD = 3;

/** Word shape used by both passes; built per call so no `lastIndex` is shared. */
const wordPattern = () => /[\p{L}]+/gu;

/** Read a text and say whether its Norwegian letters were written or folded. */
export function inspectNorwegianOrthography(text: string): OrthographyReport {
  const hits: OrthographyHit[] = [];
  const seen = new Set<string>();
  const markers = new Set<string>();

  for (const match of text.matchAll(wordPattern())) {
    const word = match[0];
    const lower = word.toLowerCase();

    if (NORWEGIAN_MARKERS.has(lower)) markers.add(lower);

    if (seen.has(lower)) continue;

    const strong = STRONG[lower];
    if (strong) {
      seen.add(lower);
      hits.push({ word, suggestions: strong, confidence: 'strong' });
      continue;
    }
    const likely = LIKELY[lower];
    if (likely) {
      seen.add(lower);
      hits.push({ word, suggestions: likely, confidence: 'likely' });
      continue;
    }
    const byFragment = repairFragments(lower);
    if (byFragment !== lower) {
      seen.add(lower);
      hits.push({ word, suggestions: [byFragment], confidence: 'strong' });
    }
  }

  const hasNorwegianLetters = /[æøåÆØÅ]/.test(text);
  const looksNorwegian = markers.size >= MARKER_THRESHOLD;

  return {
    hits,
    hasNorwegianLetters,
    looksNorwegian,
    transliterated: looksNorwegian && !hasNorwegianLetters && hits.length > 0,
  };
}

/**
 * Restore æ/ø/å for the spellings that cannot be anything else.
 *
 * Case is preserved for the two shapes that occur in prose — all-lower and
 * Capitalised — and an ambiguous strong entry (`arlig`) is left alone, as is
 * every `likely` one. Returns the text unchanged when nothing qualifies, so a
 * caller can compare identity to see whether there is anything to write back.
 */
export function repairStrongTransliterations(text: string): string {
  return text.replace(wordPattern(), (word) => {
    const lower = word.toLowerCase();
    const entry = STRONG[lower];
    if (entry && entry.length > 1) return word; // ambiguous; a reader decides
    if (!entry && LIKELY[lower]) return word;
    const fixed = entry ? entry[0]! : repairFragments(lower);
    if (fixed === lower) return word;
    if (word === word.toLowerCase()) return fixed;
    if (
      word[0] === word[0]!.toUpperCase() &&
      word.slice(1) === word.slice(1).toLowerCase()
    ) {
      return fixed[0]!.toUpperCase() + fixed.slice(1);
    }
    // ALL CAPS or MiXeD — not a shape this prose uses; leave it for a human.
    return word;
  });
}
