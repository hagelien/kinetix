import { describe, expect, it } from 'vitest';

import {
  canonicalSourceQuote,
  normalizeSourceQuote,
  sourceQuoteComparisonKey,
  sourceQuoteEvidenceUnchanged,
  sourceQuoteSchema,
} from '../../src/lib/parameterEntries.ts';

/**
 * A quote is the one field in the pipeline whose entire purpose is to be READ.
 * So "is there a quote?" has to mean "is there something visible to read", not
 * "is this string non-empty" — and the two come apart, because a good deal of
 * Unicode renders as nothing at all.
 *
 * The gap matters because of what sits downstream: an agent's own proposal can
 * clear the consensus gate on the strength of a quote that a reviewer, opening
 * the card, would see as blank. That is the #1201 failure with an extra step.
 */
describe('normalizeSourceQuote — invisible characters are not a sentence', () => {
  // `\s` covers none of these, so each one survived every earlier emptiness
  // check as a length-1 string.
  const INVISIBLE = [
    ['zero width space', '​'],
    ['zero width no-break space / BOM', '﻿'],
    ['word joiner', '⁠'],
    ['soft hyphen', '­'],
    ['left-to-right mark', '‎'],
    ['left-to-right override', '‭'],
    ['Hangul filler', 'ㅤ'],
    ['halfwidth Hangul filler', 'ﾠ'],
    ['zero width non-joiner', '‌'],
    ['zero width joiner', '‍'],
    // Default-ignorable COMBINING MARKS: category Mn, not Cf, so any list
    // built for the characters above misses them. The visibility test does not.
    ['combining grapheme joiner', '͏'],
    ['Mongolian free variation selector', '᠋'],
    ['variation selector-16', '️'],
    ['variation selector-1', '︀'],
  ] as const;

  for (const [name, char] of INVISIBLE) {
    it(`treats a quote of only ${name} as no quote`, () => {
      expect(normalizeSourceQuote(char.repeat(4))).toBe('');
      expect(canonicalSourceQuote(char.repeat(4))).toBeNull();
      // …and through the schema, which is what the write path actually runs.
      expect(sourceQuoteSchema.parse(char.repeat(4))).toBeNull();
    });
  }

  // Visible is not the same as substantive. Punctuation and symbols put ink on
  // the page while recording nothing — no sentence, no table value, nothing a
  // reviewer could check a number against — so they do not satisfy a
  // requirement whose whole purpose is that something was written down.
  it.each([['a full stop', '.'], ['an em dash', '\u2014'], ['an ellipsis of dots', '. . .'], ['brackets and a slash', '[/]']])(
    'treats a quote of only %s as no quote',
    (_name, value) => {
      expect(normalizeSourceQuote(value)).toBe('');
      expect(sourceQuoteSchema.parse(value)).toBeNull();
    },
  );

  // …while anything carrying a letter or a digit is a quote, including the
  // shortest real one: a figure with its unit.
  it('keeps a quote that is a bare figure', () => {
    expect(normalizeSourceQuote('2 h')).toBe('2 h');
  });

  it('treats a mix of invisible characters and ordinary spaces as no quote', () => {
    expect(normalizeSourceQuote(' ​ \t⁠\n﻿ ')).toBe('');
  });

  // The other half: hardening the check must not damage real text. A quote
  // stays in the source's own language, and joiners carry meaning in several of
  // them — deleting those would silently alter the words being attested.
  it('keeps combining marks that are part of the words they sit on', () => {
    // Arabic diacritics: the marks belong to the letters, and a quote stays in
    // the source's own language, so stripping them would alter what is attested.
    const arabic = 'بَلَغَ مُتَوَسِّطُ العُمْرِ ٢٤';
    expect(normalizeSourceQuote(arabic)).toBe(arabic);
  });

  it('keeps a joiner that is doing its job inside real text', () => {
    // ZWNJ between two Persian letters: the sequence is the word, not noise.
    const persian = 'می‌شود در ۲۴ داوطلب';
    expect(normalizeSourceQuote(persian)).toBe(persian);
  });

  it('closes a word that a zero-width space was splitting', () => {
    // Deleted rather than turned into a space: U+200B joins, so the word is
    // Tmax. A quote pasted out of a PDF routinely carries these.
    expect(normalizeSourceQuote('Median T​max was 2 h.')).toBe(
      'Median Tmax was 2 h.',
    );
  });

  it('still collapses ordinary whitespace, including line breaks', () => {
    expect(normalizeSourceQuote('  Median Tmax\n\twas 2 h.  ')).toBe(
      'Median Tmax was 2 h.',
    );
  });
});

/**
 * Storage and equality want different things from the same string.
 *
 * Storage keeps the source's own text, so a joiner inside a Persian word
 * survives. Equality cannot: appending one invisible character to the stored
 * sentence is the bypass — the string renders identically, compares unequal,
 * and is therefore taken as newly authored evidence, which skips the staleness
 * check and lets a changed value publish behind the old words.
 */
describe('sourceQuoteComparisonKey', () => {
  const QUOTE = 'The mean terminal half-life was 9 h.';

  it.each([
    ['a combining grapheme joiner', '\u034F'],
    ['a variation selector', '\uFE0F'],
    ['a zero width space', '\u200B'],
    ['a word joiner', '\u2060'],
    ['a zero width joiner', '\u200D'],
    ['a zero width non-joiner', '\u200C'],
    ['a soft hyphen', '\u00AD'],
  ])('sees through %s appended to the stored sentence', (_name, mark) => {
    expect(sourceQuoteComparisonKey(QUOTE + mark)).toBe(
      sourceQuoteComparisonKey(QUOTE),
    );
  });

  it('sees through one buried in the middle of it', () => {
    expect(
      sourceQuoteComparisonKey('The mean terminal\u034F half-life was 9 h.'),
    ).toBe(sourceQuoteComparisonKey(QUOTE));
  });

  // Storage is untouched by any of this: the text keeps the joiners it needs.
  it('is a comparison form only — storage keeps the source text', () => {
    const persian = 'می\u200Cشود';
    expect(normalizeSourceQuote(persian)).toBe(persian);
    expect(sourceQuoteComparisonKey(persian)).toBe('میشود');
  });

  // The same sentence, spelled two ways.
  //
  // Which spelling a quote arrives in is decided by the contributor's keyboard
  // and PDF viewer, not by intent: macOS hands out decomposed text, most web
  // forms hand out composed text. On screen they are the same characters, so a
  // reviewer comparing the card against the entry sees an exact copy — while a
  // byte comparison calls it newly authored evidence and lets the value move
  // behind a sentence nobody re-read.
  it.each([
    ['a French é', 'La demi-vie était de 9 h.'],
    ['a Norwegian å', 'Gjennomsnittlig Tmax var på 2 t.'],
    ['a German ü', 'Die mittlere Halbwertszeit über 24 h betrug 9 h.'],
  ])('sees one sentence where %s is composed differently', (_name, sentence) => {
    const composed = sentence.normalize('NFC');
    const decomposed = sentence.normalize('NFD');
    // The premise of the test: as strings these are not the same thing.
    expect(decomposed).not.toBe(composed);
    expect(sourceQuoteComparisonKey(decomposed)).toBe(
      sourceQuoteComparisonKey(composed),
    );
  });

  // Order matters: a ZWNJ between a base letter and its combining mark blocks
  // composition, so a key that normalized before stripping would still see two
  // different sentences — and an attacker who knows that has the bypass back.
  it('sees through a joiner wedged between a letter and its accent', () => {
    const decomposed = 'La demi-vie était de 9 h.'.normalize('NFD');
    const wedged = decomposed.replace('\u0301', '\u200C\u0301');
    expect(sourceQuoteComparisonKey(wedged)).toBe(
      sourceQuoteComparisonKey('La demi-vie était de 9 h.'.normalize('NFC')),
    );
  });

  // Storage is untouched by composition too: the row keeps the source's own
  // spelling, exactly as it keeps the source's own joiners.
  it('does not recompose the text that gets stored', () => {
    const decomposed = 'La demi-vie était de 9 h.'.normalize('NFD');
    expect(normalizeSourceQuote(decomposed)).toBe(decomposed);
  });

  // The third member of the family, and the one somebody has to choose to do.
  //
  // A Cyrillic а and a Latin a are one letter to every reader and two
  // characters to a byte comparison, so swapping one for the other inside a
  // carried sentence is the cheapest way to make an echo look newly authored —
  // after which the staleness rule never runs and a changed value publishes
  // behind words describing the value it used to be.
  it.each([
    ['a Cyrillic a', 'a', '\u0430'],
    ['a Cyrillic o', 'o', '\u043E'],
    ['a Cyrillic e', 'e', '\u0435'],
    ['a Cyrillic c', 'c', '\u0441'],
    ['a Cyrillic p', 'p', '\u0440'],
    ['a Greek Omicron', 'O', '\u039F'],
  ])('sees through %s substituted into an echo', (_name, latin, lookalike) => {
    // One sentence carrying every letter the cases below swap.
    const original = 'Observed oral peak concentration was 4 mg per L.';
    expect(original).toContain(latin);
    const swapped = original.replace(latin, lookalike);
    expect(swapped).not.toBe(original);
    expect(sourceQuoteComparisonKey(swapped)).toBe(
      sourceQuoteComparisonKey(original),
    );
  });

  // MICRO SIGN against GREEK SMALL LETTER MU: the same character to every
  // reader and to every µg/mL in the corpus, and deliberately left distinct by
  // NFC, which does not make compatibility mappings.
  it('sees one unit where micro sign meets mu', () => {
    expect(sourceQuoteComparisonKey('Cmax was 4.2 \u00B5g/mL.')).toBe(
      sourceQuoteComparisonKey('Cmax was 4.2 \u03BCg/mL.'),
    );
  });

  // The fold is per character, so text genuinely written in another script
  // keeps its distinctions — two different Russian sentences are still two
  // different keys, and the folding costs nothing real.
  it('still tells two genuinely different Cyrillic sentences apart', () => {
    expect(
      sourceQuoteComparisonKey('\u0421\u0440\u0435\u0434\u043D\u0438\u0439 \u043A\u043B\u0438\u0440\u0435\u043D\u0441 4.'),
    ).not.toBe(
      sourceQuoteComparisonKey('\u0421\u0440\u0435\u0434\u043D\u0438\u0439 \u043A\u043B\u0438\u0440\u0435\u043D\u0441 9.'),
    );
  });

  // Greek letters that are pharmacological notation rather than lookalikes are
  // deliberately left alone: the alpha phase of a curve is not the letter a,
  // and folding it would blur a real distinction for no security gain.
  it('leaves alpha and beta alone, which are notation and not lookalikes', () => {
    expect(sourceQuoteComparisonKey('The \u03B1-phase lasted 2 h.')).not.toBe(
      sourceQuoteComparisonKey('The a-phase lasted 2 h.'),
    );
    expect(sourceQuoteComparisonKey('The \u03B2-phase lasted 9 h.')).not.toBe(
      sourceQuoteComparisonKey('The B-phase lasted 9 h.'),
    );
  });

  // Storage is untouched by the fold too — the row keeps the source's own
  // letters, exactly as it keeps its joiners and its composition.
  it('does not rewrite the letters that get stored', () => {
    const cyrillic = '\u0421\u0440\u0435\u0434\u043D\u0438\u0439 T1/2 9 \u0447.';
    expect(normalizeSourceQuote(cyrillic)).toBe(cyrillic);
  });

  it('still distinguishes genuinely different sentences', () => {
    expect(sourceQuoteComparisonKey(QUOTE)).not.toBe(
      sourceQuoteComparisonKey('Corrected: the mean was 11 h.'),
    );
  });
});

/**
 * There are two ways to say "this observation has no route", and the row keeps
 * one of them.
 *
 * `categorical_value` and `route` are written with `|| null`, so a blank string
 * lands as NULL; the other evidence fields keep a blank as a blank. Anything
 * comparing evidence has to apply the writer's rule or it is comparing
 * spellings rather than observations — and generic clients and cached forms
 * both send `categoricalValue: ""` on a numeric entry.
 *
 * The consequence runs the dangerous way. The review card decides from this
 * whether to show the reviewer the quote the approval will actually leave on
 * the row. A spurious "changed" hides it, so the card reads as though the
 * quotation is being removed — while approving preserves it and the consensus
 * gate may auto-publish on it. The reviewer is not shown the provenance they
 * are approving.
 */
describe('sourceQuoteEvidenceUnchanged — a blank is how a client says nothing', () => {
  const observation = (over: Record<string, unknown> = {}) => ({
    citationId: 5,
    unit: 'mg/L',
    low: 10,
    high: 30,
    matrix: 'serum',
    ...over,
  });

  it.each([['categoricalValue'], ['route']])(
    'reads a blank %s as the NULL the row stores',
    (field) => {
      expect(
        sourceQuoteEvidenceUnchanged(
          observation({ [field]: null }),
          observation({ [field]: '' }),
        ),
      ).toBe(true);
      // …and the same for a key that is simply absent.
      expect(
        sourceQuoteEvidenceUnchanged(observation(), observation({ [field]: '' })),
      ).toBe(true);
    },
  );

  it('still sees a real change to those fields', () => {
    expect(
      sourceQuoteEvidenceUnchanged(
        observation({ route: null }),
        observation({ route: 'oral' }),
      ),
    ).toBe(false);
  });

  it('leaves the fields that keep a blank alone', () => {
    // `scenario` is written with `?? null`, so a blank IS a change to it and
    // must not be folded away by a rule meant for the other two.
    expect(
      sourceQuoteEvidenceUnchanged(
        observation({ scenario: 'living_therapeutic' }),
        observation({ scenario: '' }),
      ),
    ).toBe(false);
  });

  it('still sees a moved reading', () => {
    expect(
      sourceQuoteEvidenceUnchanged(observation(), observation({ high: 50 })),
    ).toBe(false);
  });
});

// `observationContext` (#1257) is new, so an `after` that omits it is a caller
// saying nothing — the same rule `updateParameterEntryRow` applies when
// deciding whether an omitted quote survives — not an assertion that the row's
// context is now NULL. Unlike `categoricalValue`/`route` above, this holds
// even when `before` HAD a value and `after` says nothing at all: that is the
// exact shape of a proposal or reviewer payload built before this column
// existed, or a caller that never learned about it.
describe('sourceQuoteEvidenceUnchanged — observationContext omission always preserves', () => {
  const observation = (over: Record<string, unknown> = {}) => ({
    citationId: 5,
    unit: 'mg/L',
    low: 10,
    high: 30,
    matrix: 'serum',
    ...over,
  });

  it('is unchanged when `after` omits it, however `before` reads', () => {
    expect(
      sourceQuoteEvidenceUnchanged(
        observation({ observationContext: 'Fasted, single dose.' }),
        observation(),
      ),
    ).toBe(true);
  });

  it('still sees a real change when `after` states a different value', () => {
    expect(
      sourceQuoteEvidenceUnchanged(
        observation({ observationContext: 'Fasted, single dose.' }),
        observation({ observationContext: 'Fed, single dose.' }),
      ),
    ).toBe(false);
  });

  it('still sees a real change when `after` explicitly clears it', () => {
    expect(
      sourceQuoteEvidenceUnchanged(
        observation({ observationContext: 'Fasted, single dose.' }),
        observation({ observationContext: null }),
      ),
    ).toBe(false);
  });
});
