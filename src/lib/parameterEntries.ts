/**
 * Validation for multi-value parameter ENTRIES. An entry is one source's
 * reported value for one summarizable drug parameter.
 *
 * The rules are driven by the parameter registry rather than hardcoded to
 * concentrations, because between-source spread is not a concentration-only
 * phenomenon: a half-life, logP, blood:plasma ratio or protein-binding figure
 * varies from paper to paper too, and that literature spread IS the parameter's
 * range. So per parameter:
 *   - `unit`     must be one of the parameter's own allowed units (the empty
 *                string for dimensionless ones like logP/pKa),
 *   - values     must sit inside the parameter's registry bounds — which for
 *                logP/logD/pKa includes NEGATIVE values,
 *   - `matrix`   is required only when the parameter is matrix-relevant
 *                (concentrations), and rejected otherwise,
 *   - `scenario` is required only for the interpretive concentrations, and
 *                rejected otherwise — a half-life has no "postmortem poly
 *                intoxication" reading; its study context goes in
 *                `observationContext`.
 *
 * LOQ/LOD and analyte stability stay out of the entry store: they are
 * matrix-specific analytical properties with no valid cross-matrix pool.
 */
import { z } from 'zod';
import {
  referenceMatrixSchema,
  referenceScenarioSchema,
} from './referenceConcentrations.js';
import {
  allowedValuesForParameter,
  getRangeSpec,
  isDrugParameterId,
  isModelStructureParameter,
  MODEL_STRUCTURE_PARAMETER_IDS,
  parameterDoseContextMode,
  parameterIsMatrixRelevant,
  parameterIsRouteOptional,
  parameterIsRouteScoped,
  parameterIsScenarioRelevant,
  ROUTE_SCOPED_PARAMETER_IDS,
  ENTRY_ONLY_PARAMETER_IDS,
  SUMMARIZED_PARAMETER_IDS,
  type DrugParameterId,
} from './drugParameters.js';
import { convertParameterValue, entryUnitsForParameter } from './parameterUnits.js';
import {
  ABSORPTION_KINDS,
  ROUTE_IDS,
  absorptionCoherentWithRoute,
  type AbsorptionKind,
  type RouteId,
} from './kinetics-core/index.js';
import { QUALIFIER_OPERATORS } from '../types/index.js';
import {
  ARITHMETIC_INTERVAL_KINDS,
  DOSE_CONTEXT_FIELD_KEYS_TUPLE,
  canonicalizeReportedStatistic,
  doseContextShape,
  NUMERIC_DOSE_CONTEXT_FIELDS,
  roundToScale,
  storedScaleOf,
  validateDoseContext,
  type DoseContextFields,
} from './entryDoseContext.js';

export const summarizedParameterSchema = z.enum(
  SUMMARIZED_PARAMETER_IDS as unknown as [string, ...string[]],
);

/**
 * Every parameter an entry may back: the summarized numeric parameters plus the
 * categorical model-structure axes (CV-1b). Both are stored as `parameter_entries`
 * rows — a numeric entry carries low/high/median + unit; a model-axis entry
 * carries a single `categoricalValue` and no numbers. `validateEntryForParameter`
 * branches on which kind the parameter is.
 */
export const entryParameterSchema = z.enum([
  ...SUMMARIZED_PARAMETER_IDS,
  ...MODEL_STRUCTURE_PARAMETER_IDS,
  // Route-scoped numeric parameters (CV-2c, e.g. `ka`) are entry-backed too:
  // their cited value is stored per administration route in `parameter_entries`.
  ...ROUTE_SCOPED_PARAMETER_IDS,
  // Entry-only parameters (Cmax): cited rows with no drug-level value. Accepted
  // here so an approval can parse a proposal for one; CREATING one is refused
  // by the producers while `parameterAuthoringGated` holds.
  ...ENTRY_ONLY_PARAMETER_IDS,
] as unknown as [string, ...string[]]);

/** The route vocabulary an entry's `route` may carry (CV-2c) — kinetics-core `RouteId`s. */
const routeSchema = z.enum(ROUTE_IDS as unknown as [string, ...string[]]);

/** The maximum length of the `categorical_value` column (migration 0109). */
const CATEGORICAL_VALUE_MAX = 40;

const qualifierSchema = z.enum(
  QUALIFIER_OPERATORS as unknown as [string, ...string[]],
);

/**
 * Coarse guard matching the `numeric(14, 6)` columns (|value| < 1e8). The real,
 * per-parameter bound is applied by `validateEntryForParameter`; this only stops
 * a value that could never be stored from reaching the database.
 */
const COLUMN_LIMIT = 99_999_999;

const entryNumber = z.number().finite().min(-COLUMN_LIMIT).max(COLUMN_LIMIT);

/** The maximum length of a stored source quote. */
export const SOURCE_QUOTE_MAX = 1000;

/**
 * A verbatim source quote: the words an entry's value was read off.
 *
 * Normalizing before validating, not after, is deliberate. A quote copied out
 * of a two-column PDF carries the line breaks of the page it was typeset on,
 * and a quote assembled by an agent may arrive padded. Neither is part of what
 * the source said, and leaving them in would make two records of the same
 * sentence compare unequal. Collapsing runs of whitespace to single spaces and
 * trimming the ends leaves the words — which is the whole point of the field —
 * while making it a stable thing to compare and display.
 *
 * Three states, and the distinction between the last two is load-bearing on an
 * update:
 *
 *   - **absent** (`undefined`) — this client said nothing about the quote. On a
 *     PATCH that means PRESERVE what is stored. Every integration and cached
 *     client written before this field existed sends exactly this, so treating
 *     it as "clear" would let an old client silently destroy provenance
 *     somebody else recorded — a quote nobody can reconstruct once it is gone.
 *   - **explicitly empty** (`null`, or a blank/whitespace-only string) — this
 *     client is clearing the quote, e.g. a curator emptying the textarea. A
 *     blank string normalizes to `null` rather than staying `''`, so a quote
 *     consisting of nothing is never stored as though it were evidence.
 *   - **text** — the words themselves.
 *
 * `.nullable()` wraps the transforms, so an explicit `null` passes straight
 * through without being normalized.
 */
/**
 * The canonical form of a quote: runs of whitespace collapsed to single spaces,
 * ends trimmed.
 *
 * Exported because more than one place has to agree on what "the same quote"
 * means. The schema normalizes on the way in, so a caller comparing RAW strings
 * to decide whether an author supplied a new quote would read a re-wrapped copy
 * of the same sentence as a replacement — and then store the sentence it
 * thought had been replaced. Two rules for one question is how that kind of gap
 * opens; this is the one rule.
 */
/**
 * Characters that render as nothing and are not words.
 *
 * `\s` is not enough: U+200B ZERO WIDTH SPACE, U+2060 WORD JOINER, U+FEFF and
 * the bidi controls are all outside it, so a quote made only of them survives
 * every whitespace check as a non-empty string, stores, and satisfies a gate
 * that is asking whether a sentence was recorded. On screen it is blank.
 *
 * Control characters map to a SPACE (a line break separates words), while
 * zero-width formatting characters are DELETED (they join them: "T\u200Bmax" is
 * the word Tmax, not "T max").
 *
 * ZWNJ and ZWJ are deliberately exempt from the deletion: they are meaningful
 * in Persian, Devanagari and other scripts, and a quote stays in the source's
 * own language. A quote made only of them is still rejected, by the visibility
 * test rather than by mangling text that legitimately contains them.
 */
const CONTROL_CHARS = /\p{Cc}/gu;
/**
 * Everything that renders as nothing, by the Unicode property that means
 * exactly that — the zero-width spaces, the bidi controls, the variation
 * selectors, U+034F, the Hangul fillers, the soft hyphen, and whatever is added
 * to the set next. Hand-listing them failed twice in review: first the `Cf`
 * block, then the default-ignorable `Mn` marks that are not in it.
 *
 * ZWNJ and ZWJ are excluded from the deletion because they carry meaning in
 * Persian, Devanagari and other scripts, and a quote stays in the source's own
 * language. They are still discounted when quotes are COMPARED — see
 * `sourceQuoteComparisonKey` — because a joiner appended to a sentence renders
 * as nothing and must not make an echo look like a new one.
 */
const IGNORABLE = /(?![\u200C\u200D])\p{Default_Ignorable_Code_Point}/gu;
const JOINERS = /[\u200C\u200D]/gu;

/**
 * Does this string contain anything a reader could see?
 *
 * Stated as what a quote MUST have rather than as a list of what it must not
 * contain: a letter or a digit. Enumerating the invisible characters is a
 * losing game — after the zero-width and bidi controls come the
 * default-ignorable combining marks (U+034F, U+180B, the variation selectors),
 * which are `Mn` rather than `Cf` and slip past any list built for the previous
 * round. There is no such gap on this side.
 *
 * Punctuation and symbols are deliberately NOT enough on their own. They are
 * visible, so they pass a test for ink on the page, and a quote of `.` or `—`
 * would then satisfy the provenance requirement while recording nothing: no
 * sentence, no table value, nothing a reviewer could check a number against.
 * Every real quote — a sentence in any script, a figure with its unit, a cell
 * from a table — contains a letter or a digit.
 *
 * Combining marks are absent from the set on purpose, and are still preserved
 * in text that has them: Arabic diacritics, Hebrew niqqud and Devanagari
 * matras are part of the words they sit on, so they survive — but a string of
 * marks with nothing to combine WITH is not a sentence, and this says so.
 */
const SUBSTANTIVE_CHAR = /[\p{L}\p{N}]/u;

export function normalizeSourceQuote(value: string): string {
  const collapsed = value
    .replace(CONTROL_CHARS, ' ')
    .replace(IGNORABLE, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Nothing visible: this is the absence of a quote, not a quote. Returning ''
  // hands it to the same fold-to-null the blank-string case already goes
  // through, so every caller — the schema, the consensus gate, the comparisons
  // — agrees without each having to know.
  return SUBSTANTIVE_CHAR.test(collapsed) ? collapsed : '';
}

/**
 * Characters that RENDER as a different character, folded to the one they look
 * like — Cyrillic а to Latin a, Greek Ο to Latin O, and so on.
 *
 * Every pair is one code point to one code point, which is what lets the same
 * table drive `String.prototype.replace` here and Postgres `translate()` in
 * `sourceQuoteComparisonKeySql`. Postgres DELETES a source character with no
 * partner, so the two joined strings must stay the same length; the assertion
 * below enforces that rather than trusting the list to be edited carefully.
 *
 * ## What this is and is not
 *
 * It is a curated set covering the Cyrillic and Greek letters that are
 * confusable with ASCII, plus MICRO SIGN against GREEK SMALL LETTER MU, which
 * appear in the same unit and which NFC deliberately leaves distinct. It is NOT
 * the full UTS #39 confusables table — that is some six thousand mappings,
 * several of them one-to-many, and neither the size nor the one-to-many part
 * survives the `translate()` constraint above. So the gap is narrowed, not
 * closed, and the residue is the rarer scripts.
 *
 * ## Why folding at all, and why over-folding is the safe direction
 *
 * A comparison decides whether a stated quote is an ECHO of the stored one. Get
 * it wrong in one direction and a sentence is wrongly called new: the quote is
 * stored, the staleness rule never runs, and a changed value publishes behind
 * words describing the value it used to be. Get it wrong the other way and a
 * genuinely new sentence is wrongly called an echo: it goes through
 * preserve-or-clear, the quote is dropped, and the proposal is held for a
 * human. One direction publishes something wrong unattended; the other asks a
 * person to look. So where this table is imprecise, it should be imprecise
 * towards "the same" — and it is: two different Russian sentences still fold to
 * two different keys, because the fold is per character.
 *
 * Only the COMPARISON form is folded. Storage keeps the source's own text, as
 * it does with joiners and composition, so nothing about what a reader sees
 * changes.
 */
const CONFUSABLE_FOLD: ReadonlyArray<readonly [string, string]> = [
  // Cyrillic → Latin, lower case.
  ['\u0430', 'a'], ['\u0435', 'e'], ['\u043E', 'o'], ['\u0440', 'p'],
  ['\u0441', 'c'], ['\u0443', 'y'], ['\u0445', 'x'], ['\u0455', 's'],
  ['\u0456', 'i'], ['\u0458', 'j'], ['\u04BB', 'h'], ['\u051B', 'q'],
  ['\u051D', 'w'], ['\u0501', 'd'], ['\u04CF', 'l'],
  // Cyrillic → Latin, upper case.
  ['\u0410', 'A'], ['\u0412', 'B'], ['\u0415', 'E'], ['\u041A', 'K'],
  ['\u041C', 'M'], ['\u041D', 'H'], ['\u041E', 'O'], ['\u0420', 'P'],
  ['\u0421', 'C'], ['\u0422', 'T'], ['\u0423', 'Y'], ['\u0425', 'X'],
  ['\u0405', 'S'], ['\u0406', 'I'], ['\u0408', 'J'], ['\u04AE', 'Y'],
  // Greek → Latin. Deliberately NOT alpha or beta: they are pharmacological
  // notation (the α-phase of a curve) and are not confusable with any ASCII
  // letter in an ordinary font, so folding them would blur a real distinction
  // for no security gain.
  ['\u03BF', 'o'], ['\u03BD', 'v'], ['\u03C1', 'p'], ['\u03C7', 'x'],
  ['\u0391', 'A'], ['\u0392', 'B'], ['\u0395', 'E'], ['\u0396', 'Z'],
  ['\u0397', 'H'], ['\u0399', 'I'], ['\u039A', 'K'], ['\u039C', 'M'],
  ['\u039D', 'N'], ['\u039F', 'O'], ['\u03A1', 'P'], ['\u03A4', 'T'],
  ['\u03A5', 'Y'], ['\u03A7', 'X'],
  // MICRO SIGN to GREEK SMALL LETTER MU. The same character to every reader and
  // to every µg/mL in the corpus; distinct to NFC, which is a compatibility
  // mapping it deliberately does not make. Folded to mu rather than to Latin u,
  // which it does not look like.
  ['\u00B5', '\u03BC'],
] as const;

/** The two halves of the table, as `translate()` wants them. */
export const CONFUSABLE_FOLD_FROM = CONFUSABLE_FOLD.map(([from]) => from).join('');
export const CONFUSABLE_FOLD_TO = CONFUSABLE_FOLD.map(([, to]) => to).join('');

// A pair that is not one-to-one silently changes what `translate()` does — it
// drops the character instead of mapping it — and the JS and SQL forms would
// then disagree on exactly the input this table exists to catch.
if (
  [...CONFUSABLE_FOLD_FROM].length !== CONFUSABLE_FOLD.length ||
  [...CONFUSABLE_FOLD_TO].length !== CONFUSABLE_FOLD.length
) {
  throw new Error(
    'CONFUSABLE_FOLD entries must each be a single code point on both sides',
  );
}

const CONFUSABLE_MAP = new Map<string, string>(CONFUSABLE_FOLD);
const CONFUSABLE_PATTERN = new RegExp(`[${CONFUSABLE_FOLD_FROM}]`, 'gu');

function foldConfusables(value: string): string {
  return value.replace(CONFUSABLE_PATTERN, (ch) => CONFUSABLE_MAP.get(ch) ?? ch);
}

/**
 * The form two quotes are compared IN, which is not the form they are stored in.
 *
 * Storage keeps the source's own text: a joiner inside a Persian word is part
 * of that word, so `normalizeSourceQuote` leaves it. Equality cannot afford the
 * same generosity — a joiner appended to an otherwise identical sentence is
 * invisible on screen and would make an echo of the stored quote compare
 * unequal, which is the whole bypass: state the old sentence plus one unseen
 * character, and the staleness check treats it as newly authored evidence for a
 * changed value.
 *
 * So comparison discounts them and storage does not. The cost is that a quote
 * differing ONLY by a joiner reads as unchanged, and an author correcting
 * Persian orthography alone would find their edit treated as silence. That is
 * the safer direction by a wide margin: silence goes through preserve-or-clear,
 * which holds the proposal for a human rather than publishing it.
 *
 * Composition is the same problem wearing different clothes. Unicode lets the
 * SAME character be spelled two ways — `é` as one code point, or `e` followed
 * by a combining acute — and the two render identically by definition. Which
 * one a quote arrives in is decided by the contributor's keyboard, operating
 * system and PDF viewer, not by intent: macOS filesystems hand out decomposed
 * text, most web forms hand out composed text. Comparing the spellings rather
 * than the characters means an honest copy-paste of the stored sentence is
 * taken as newly authored evidence — the same bypass as the invisible joiner,
 * reachable by accident and, once known, on purpose. NFC settles on one
 * spelling before comparing. Storage is untouched, as above: the stored row
 * keeps whatever the source used.
 *
 * Order matters. The joiners come out first: a ZWNJ sitting between a base
 * letter and its combining mark blocks composition, so normalizing before
 * stripping would leave the two spellings still unequal.
 *
 * Confusables are the third member of the same family and fold LAST, once the
 * text is composed: a Cyrillic а and a Latin a are one letter to every reader,
 * and swapping one for the other in a carried sentence is the cheapest way to
 * make an echo look newly authored. See `CONFUSABLE_FOLD` for what is covered,
 * what is not, and why over-folding is the safe direction.
 */
export function sourceQuoteComparisonKey(value: string): string {
  return foldConfusables(
    normalizeSourceQuote(value).replace(JOINERS, '').normalize('NFC'),
  );
}

/**
 * A quote as it will be STORED, from whatever a caller is holding.
 *
 * `sourceQuoteSchema` normalizes and folds a blank to `null` on the way in, so
 * any code reading a quote BEFORE that parse — a gate deciding whether a
 * proposal is evidenced, a store writing a payload it did not parse itself —
 * must apply the same two steps or it is reasoning about a value that will not
 * be the one written. A whitespace-only quote is the sharp case: it is a
 * non-empty string until the schema sees it, and `null` afterwards.
 *
 * The three states are preserved exactly, because callers distinguish them:
 * `undefined` is silence (decide for yourself whether that preserves or
 * clears), `null` is an explicit removal, text is a statement.
 */
export function canonicalSourceQuote(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return normalizeSourceQuote(value) || null;
}

/**
 * The entry fields a source quote is evidence ABOUT.
 *
 * A quote survives a change to anything outside this list and is detached by a
 * change to anything in it. That rule is applied in three places — the update's
 * SQL (`preservedQuoteExpr`), the proposal-revision check
 * (`withoutStaleEntryQuote`) and the tests that pin both — so the membership
 * lives here rather than being restated at each. Three restatements of one list
 * is how they drift, and the drift is invisible: each site looks correct alone.
 *
 * `comments` is deliberately ABSENT. Curator notes are commentary about the
 * observation, not part of what the sentence attests, so editing them must not
 * cost the entry its provenance.
 *
 * `observationContext` is deliberately PRESENT, and for the opposite reason:
 * unlike `comments`, it holds facts about the reading itself (dose, fed/fasted
 * state, population, assay method) that are part of what the cited sentence
 * attests — a curator who changes "fasted" to "fed" has changed what the
 * observation IS, so a quote attached to the old text is no longer evidence
 * for it.
 */
export const SOURCE_QUOTE_EVIDENCE_FIELDS = [
  'citationId',
  'unit',
  'low',
  'high',
  'median',
  'qualifier',
  'categoricalValue',
  'route',
  'matrix',
  'scenario',
  'n',
  'observationContext',
  // Structured dose context (src/lib/entryDoseContext.ts): a sentence about a
  // 2 mg fasted single dose is not evidence for a reading filed at 4 mg fed,
  // any more than one about an oral dose is evidence for an IV one. Every
  // field, not a chosen few — see `DOSE_CONTEXT_FIELDS` for why enumerations
  // of these are not maintained by hand.
  ...DOSE_CONTEXT_FIELD_KEYS_TUPLE,
] as const;

/**
 * Does a quote attached to `before` still attest to `after`?
 *
 * The question three places have to answer the same way: the update's SQL
 * (`preservedQuoteExpr`, which decides whether an omitted quote survives), the
 * proposal-revision check (`withoutStaleEntryQuote`) and the review card, which
 * has to SHOW the reviewer the provenance the approval will actually leave on
 * the row rather than the sparse patch's silence. A card that omits an
 * inherited quote reads as "the quotation is being removed" — the opposite of
 * what approving it does.
 *
 * Compared field by field over `SOURCE_QUOTE_EVIDENCE_FIELDS`, through
 * `storedEvidenceValue` so the comparison sees each field the way the row will
 * hold it. Comparing the payload's spelling instead makes the answer depend on
 * how a client happened to say "nothing", which is not a fact about the
 * observation.
 *
 * `observationContext` is the one field this rule does not apply to UNCONDITIONALLY:
 * it is new (#1257), so an `after` that OMITS it is a writer saying nothing
 * about it — the same preserve-when-omitted rule `updateParameterEntryRow`
 * applies — not an assertion that it is now NULL. Read as an ordinary field
 * here, an omission on a proposal predating this column (or from an unaware
 * caller) would compare unequal against whatever `before` holds and this
 * predicate would disagree with the write it exists to agree with: the review
 * card would show a quote as lost that approval actually keeps.
 *
 * But that preserve rule is an UPDATE behavior — `insertParameterEntryRow`
 * writes an omitted `observationContext` as NULL, unconditionally, because a
 * create has no prior row to preserve from. `withoutStaleEntryQuote` calls
 * this same predicate for BOTH op kinds (comparing a revised `create` input
 * against its own prior submission), so it has to know which write it is
 * agreeing with: pass `isCreate: true` there, or a revision that drops
 * `observationContext` while echoing its quote reads as "nothing changed" and
 * keeps a quote attached to context the insert is about to erase.
 */
export function sourceQuoteEvidenceUnchanged(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  opts: { isCreate?: boolean } = {},
): boolean {
  // Compared in STORED form, as the write compares them: a dose-context
  // entry's `median` shorthand is written as `centralValue` +
  // `centralStatistic: 'median'` (`canonicalizeReportedStatistic`), so a patch
  // saying `median: 5` and a row holding `centralValue: 5` state the same
  // reading. Compared raw, the review card would call the quote lost on an
  // approval that keeps it.
  before = canonicalizeReportedStatistic(before);
  after = canonicalizeReportedStatistic(after);
  return SOURCE_QUOTE_EVIDENCE_FIELDS.every((field) => {
    if (
      field === 'observationContext' &&
      !opts.isCreate &&
      after[field] === undefined
    ) {
      return true;
    }
    return (
      atEvidenceScale(field, storedEvidenceValue(field, before[field])) ===
      atEvidenceScale(field, storedEvidenceValue(field, after[field]))
    );
  });
}

/** The evidence fields stored in `numeric` columns. */
const NUMERIC_EVIDENCE_FIELDS: ReadonlySet<string> = new Set([
  'low',
  'high',
  'median',
  ...NUMERIC_DOSE_CONTEXT_FIELDS,
]);

/**
 * A numeric evidence value rounded to its column's scale, as the write stores
 * it and as the SQL comparison (`quoteEvidenceMatches`) casts it. Compared raw,
 * `low: 0.0700000001` against a stored 0.07 reads as changed evidence, so a
 * revised create would drop an echoed quote and the review card would show a
 * kept quote as lost (Codex review on #1368).
 */
function atEvidenceScale(field: string, value: unknown): unknown {
  return typeof value === 'number' && NUMERIC_EVIDENCE_FIELDS.has(field)
    ? roundToScale(value, storedScaleOf(field))
    : value;
}

/**
 * Two ways to say "this observation has no route", and the row keeps one.
 *
 * `categorical_value` and `route` are written with `|| null`, so a blank string
 * lands as NULL; every other evidence field is written with `?? null` and keeps
 * a blank as a blank. That is the writer's rule, and anything comparing
 * evidence has to apply it or it is comparing spellings rather than
 * observations — a client sending `categoricalValue: ""` on a numeric entry
 * (generic clients and cached forms both do) then reads as having CHANGED the
 * field, while the write treats it as untouched.
 *
 * The consequences run in the dangerous direction. The review card decides
 * from this whether to show the reviewer the quote the approval will actually
 * leave on the row; a spurious "changed" hides it, so the card reads as though
 * the quotation is being removed while approving preserves it and the
 * consensus gate may auto-publish on it. The reviewer is then not looking at
 * the provenance they are approving.
 *
 * Stated once, here, and used by both the comparison and the writer
 * (`preservedQuoteExpr`) — the rule and its enforcement cannot drift if there
 * is only one of it.
 */
const BLANK_IS_ABSENT: ReadonlySet<string> = new Set([
  'categoricalValue',
  'route',
]);

export function storedEvidenceValue(field: string, value: unknown): unknown {
  if (BLANK_IS_ABSENT.has(field)) return value || null;
  return value ?? null;
}

export const sourceQuoteSchema = z
  .string()
  .max(SOURCE_QUOTE_MAX * 4)
  .transform(normalizeSourceQuote)
  .refine((value) => value.length <= SOURCE_QUOTE_MAX, {
    message: `A source quote may be at most ${SOURCE_QUOTE_MAX} characters`,
  })
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional();

const baseEntryShape = {
  parameter: entryParameterSchema,
  low: entryNumber.optional(),
  high: entryNumber.optional(),
  median: entryNumber.optional(),
  qualifier: qualifierSchema.optional(),
  // The categorical (pick-from-a-list) value for a model-structure axis entry;
  // absent for every numeric entry. Its vocabulary is checked per parameter by
  // validateEntryForParameter, and it is mutually exclusive with the numeric
  // fields (validateEntryValueInvariants + the DB CHECK in migration 0109).
  categoricalValue: z.string().max(CATEGORICAL_VALUE_MAX).optional(),
  // Checked against the parameter's own allowedUnits (see
  // validateEntryForParameter); '' is the dimensionless unit for logP/pKa and
  // the (unitless) model-structure axes.
  unit: z.string().max(20),
  // Optional at the shape level, then made required/forbidden per parameter.
  matrix: referenceMatrixSchema.optional(),
  scenario: referenceScenarioSchema.optional(),
  // Administration route (CV-2c) — required for a route-scoped parameter (`ka`),
  // forbidden for every other, enforced per parameter by validateEntryForParameter.
  route: routeSchema.optional(),
  // Sample size is stored in a PostgreSQL `integer` column; bound it to the
  // int4 max so an out-of-range request is rejected at the API boundary instead
  // of failing with a database error (or queuing a proposal that can never be
  // approved).
  n: z.number().int().positive().max(2_147_483_647).optional(),
  comments: z.string().max(2000).optional(),
  // Facts about the reading itself (dose, fed/fasted state, population, assay
  // method) — part of what the cited sentence attests, unlike `comments`
  // (curator commentary about the row). See `SOURCE_QUOTE_EVIDENCE_FIELDS`.
  //
  // Three states, same as `quote` (`sourceQuoteSchema`) and for the same
  // reason: this field is new, so every integration and cached client written
  // before it existed omits it on every update, and treating that omission as
  // "clear" would let one of them silently erase context a different caller
  // recorded.
  //   - **absent** (`undefined`) — PRESERVE what is stored.
  //   - **explicit `null`** (or a blank/whitespace-only string) — CLEAR it.
  //   - **text** — replace it.
  observationContext: z
    .string()
    .max(2000)
    .transform((v) => v.trim())
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  // The verbatim text the value was read off — the sentence, table cell or
  // figure caption in the cited document, in the source's own words.
  //
  // Optional at the shape level on purpose. Making it structurally required
  // would reject every queued proposal written before this field existed, and
  // would reject an honest human contributor mid-form. What it is required for
  // is UNATTENDED publication: `highRiskEditLacksSourceQuote` (api/_lib/
  // agent-verifications.ts) withholds agent-consensus auto-apply of a
  // calculation-driving parameter until a quote is present. A human reviewer
  // may still approve without one, and a stored entry without one stays valid.
  //
  // Whitespace is collapsed rather than preserved: a quote pasted out of a PDF
  // arrives with the column breaks of the page it was set in, and those are an
  // artefact of typesetting, not of the source's words.
  quote: sourceQuoteSchema,
  // Required: these parameters always cite a judged source (per-paper provenance).
  citationId: z.number().int().positive(),
  // Structured dose context and reported statistic (Cmax dose-context RFC,
  // src/lib/entryDoseContext.ts). Forbidden on every parameter whose registry
  // entry does not declare `doseContext`, so for all of today's parameters
  // these must be absent — but they are PARSED everywhere, because zod strips
  // unknown keys and a schema without them would silently truncate a payload
  // that carries them.
  ...doseContextShape,
};

/** The value-carrying fields `validateEntryForParameter` inspects. */
export interface EntryValueFields extends DoseContextFields {
  low?: number;
  high?: number;
  median?: number;
  unit?: string;
  matrix?: string | null;
  scenario?: string | null;
  categoricalValue?: string | null;
  route?: string | null;
  qualifier?: string | null;
  n?: number | null;
}

/**
 * Validate an entry's administration route against the parameter it backs (CV-2c / CV-2c-4).
 * Three cases: a route-SCOPED parameter (`ka`) REQUIRES a route; a route-OPTIONAL parameter
 * (`absorptionModel`; later `bioavailability`) ALLOWS one but does not require it (a drug-level
 * declaration stays valid); every other parameter FORBIDS one. The route's own vocabulary is
 * constrained to `ROUTE_IDS` by the zod enum at the write boundary and by the DB CHECK (migration
 * 0111), so this only enforces the presence rule. Returns null when valid.
 */
function validateRouteForParameter(
  parameter: DrugParameterId,
  route: string | null | undefined,
): string | null {
  const hasRoute = route != null && route !== '';
  if (hasRoute && !(ROUTE_IDS as readonly string[]).includes(route)) {
    return `Unknown administration route "${route}"; choose one of: ${ROUTE_IDS.join(', ')}`;
  }
  if (parameterIsRouteScoped(parameter)) {
    if (!hasRoute) {
      return `An administration route is required for ${parameter}; choose one of: ${ROUTE_IDS.join(', ')}`;
    }
    if (parameter === 'ka' && route === 'iv') {
      return 'ka is not compatible with the intravenous route; IV bolus and infusion have no first-order absorption phase';
    }
    return null;
  }
  if (parameterIsRouteOptional(parameter)) {
    // Route permitted with or without — nothing more to enforce here (the vocabulary is the
    // schema's/DB's concern).
    if (parameter === 'bioavailability' && route === 'iv') {
      return 'bioavailability is not compatible with the intravenous route; IV fixes F = 1';
    }
    return null;
  }
  if (hasRoute) {
    return `${parameter} is not route-specific and takes no administration route`;
  }
  return null;
}

/**
 * Validate a categorical model-structure entry (CV-1b). The value must be one of
 * the axis's kinetics-core words, and — because a model shape is asserted, not
 * measured — the numeric/observational dimensions of an entry must be absent:
 * no unit, no matrix, no interpretive scenario. (The numeric bounds are excluded
 * by validateEntryValueInvariants and the DB CHECK.) Returns null when valid.
 */
function validateCategoricalEntry(
  parameter: DrugParameterId,
  value: EntryValueFields,
): string | null {
  const allowed = allowedValuesForParameter(parameter);
  const declared = value.categoricalValue;
  if (declared == null || declared === '') {
    return `A model-structure value is required for ${parameter}; choose one of: ${allowed.join(', ')}`;
  }
  if (!allowed.includes(declared)) {
    return `Value "${declared}" is not valid for ${parameter}; expected one of: ${allowed.join(', ')}`;
  }
  if (
    parameter === 'absorptionModel' && value.route &&
    (ABSORPTION_KINDS as readonly string[]).includes(declared) &&
    !absorptionCoherentWithRoute(value.route as RouteId, declared as AbsorptionKind)
  ) {
    return `Absorption model "${declared}" is not compatible with the ${value.route} route`;
  }
  // A shape declaration is unitless and dimensionless: reject a stray unit,
  // matrix or scenario rather than silently storing it.
  if (value.unit != null && value.unit !== '') {
    return `${parameter} is a categorical model-structure axis and takes no unit`;
  }
  if (value.matrix) {
    return `${parameter} is a categorical model-structure axis and takes no matrix`;
  }
  if (value.scenario) {
    return `${parameter} is a categorical model-structure axis and takes no scenario`;
  }
  return null;
}

/**
 * Registry-driven validation of an entry's unit, bounds and matrix/scenario
 * dimensions against the parameter it backs.
 *
 * Kept separate from the zod schemas because an UPDATE payload carries no
 * `parameter` (drug + parameter are immutable on an entry, so the patch never
 * restates them, and older queued proposals would fail re-validation if it were
 * suddenly required). Both write paths call this with the parameter resolved
 * from the target row instead. Returns null when the entry is valid.
 */
export function validateEntryForParameter(
  parameter: string,
  value: EntryValueFields,
): string | null {
  // Administration route (CV-2c): required for a route-scoped parameter, forbidden
  // for every other. Checked first so a stray route on a categorical or ordinary
  // numeric entry is rejected before its own rules run.
  if (isDrugParameterId(parameter)) {
    const routeMessage = validateRouteForParameter(parameter, value.route);
    if (routeMessage) return routeMessage;
  }
  // Structured dose context (Cmax dose-context RFC): rejected outright on a
  // parameter that does not declare it, and held to the RFC's write-time
  // invariants on one that does. Checked on the canonical form, so a `median`
  // shorthand is judged as the `centralValue` it will be stored as.
  const doseContextMessage = validateDoseContext(
    parameter,
    parameterDoseContextMode(parameter),
    canonicalizeReportedStatistic(value),
  );
  if (doseContextMessage) return doseContextMessage;
  // Categorical model-structure axes (CV-1b) are entry-backed too, but carry a
  // pick-list value instead of a numeric range — validated on their own terms.
  if (isModelStructureParameter(parameter)) {
    return validateCategoricalEntry(parameter as DrugParameterId, value);
  }
  if (
    !isDrugParameterId(parameter) ||
    !(
      (SUMMARIZED_PARAMETER_IDS as readonly string[]).includes(parameter) ||
      parameterIsRouteScoped(parameter) ||
      (ENTRY_ONLY_PARAMETER_IDS as readonly string[]).includes(parameter)
    )
  ) {
    return `"${parameter}" is not a source-entry-backed parameter`;
  }
  const id = parameter as DrugParameterId;
  const spec = getRangeSpec(id);
  // A numeric entry must not smuggle in a categorical value.
  if (value.categoricalValue != null && value.categoricalValue !== '') {
    return `${parameter} is a numeric parameter and takes no categorical value`;
  }

  const allowedUnits = entryUnitsForParameter(id);
  const unit = value.unit ?? '';
  if (!allowedUnits.includes(unit)) {
    const shown = allowedUnits.map((u) => u || '(none)').join(', ');
    return `Unit "${unit || '(none)'}" is not valid for ${parameter}; expected one of: ${shown}`;
  }

  // Bound the value in the parameter's CANONICAL unit, not as typed: a large
  // number in a denser unit (1e6 µg/mL) passes a raw check but normalizes far
  // over the registry maximum and would then feed the table and simulator.
  // Unconvertible units (molar without a molecular weight at this boundary) keep
  // the raw check only.
  //
  // `centralValue` is a value-carrying field like the other three and gets the
  // same bound. For an arithmetic interval (`centre ± SD`, a CI) the endpoints
  // are calculated rather than observed and can legitimately fall below the
  // registry minimum — `1 ± 2 ng/mL` is `low: -1` — so there only the centre
  // is bounded, and `validateDoseContext` pins the endpoints to it instead.
  const arithmeticBounds =
    value.intervalKind != null && ARITHMETIC_INTERVAL_KINDS.has(value.intervalKind);
  const boundedValues = arithmeticBounds
    ? [value.median, value.centralValue]
    : [value.low, value.high, value.median, value.centralValue];
  for (const raw of boundedValues) {
    if (raw === undefined || raw === null) continue;
    const canonical =
      convertParameterValue(raw, unit, spec.canonicalUnit) ?? raw;
    if (canonical < spec.bounds.min || canonical > spec.bounds.max) {
      const shownUnit = spec.canonicalUnit || 'dimensionless';
      return `Value ${raw}${unit ? ` ${unit}` : ''} is outside the allowed range for ${parameter} (${spec.bounds.min}–${spec.bounds.max} ${shownUnit})`;
    }
  }

  // Mirrors the `requiresMinMax` branch in drugParameters.ts's rangeSchema
  // (the aggregate/UI write path): a median-only reading asserts a zero-width
  // range the source never reported, which is a curation decision the entry
  // store must not make silently. Entries carry this as low/high rather than
  // the registry's min/max naming.
  if (spec.requiresMinMax && (value.low === undefined || value.high === undefined)) {
    return `Both low and high are required for ${parameter}`;
  }

  if (parameterIsMatrixRelevant(id)) {
    if (!value.matrix) return `A biological matrix is required for ${parameter}`;
  } else if (value.matrix) {
    return `${parameter} is matrix-independent; a matrix must not be set`;
  }

  if (parameterIsScenarioRelevant(id)) {
    if (!value.scenario) return `A scenario is required for ${parameter}`;
  } else if (value.scenario) {
    return `${parameter} has no interpretive scenario; record the study context in the notes instead`;
  }

  return null;
}

/** The bound-carrying fields `validateEntryValueInvariants` inspects. */
export interface EntryBoundFields {
  low?: number;
  high?: number;
  median?: number;
  /** The reported central estimate of a dose-context entry (RFC 1a). */
  centralValue?: number | null;
  qualifier?: string;
  categoricalValue?: string | null;
}

/**
 * Parameter-independent invariants on an entry's reported bounds. Returns null
 * when the bounds are coherent, or the first violated rule's message.
 *
 * Split out of the zod refinement chain so every producer of an entry — the
 * write routes here, and the conversation-ingestion bundle in
 * `conversationIngestion.ts` — enforces one implementation. A second, hand-copied
 * set of these rules would drift the moment one of them changed.
 */
export function validateEntryValueInvariants(
  value: EntryBoundFields,
): string | null {
  const { low, high, median, qualifier, categoricalValue } = value;
  // A new value-carrying field joins every check the others get (RFC:
  // "a new value-carrying column must be added to every place that
  // enumerates the value-carrying columns"). Null and absent are the same.
  const centralValue = value.centralValue ?? undefined;

  // A categorical model-structure entry (CV-1b) carries a single pick-list value
  // and NO numeric bounds; the two are mutually exclusive (mirrored by the
  // `parameter_entries_categorical_excludes_numeric` CHECK in migration 0109).
  // The value's own vocabulary is checked by validateEntryForParameter.
  if (categoricalValue != null && categoricalValue !== '') {
    if (
      low !== undefined ||
      high !== undefined ||
      median !== undefined ||
      centralValue !== undefined ||
      qualifier !== undefined
    ) {
      return 'A categorical entry must not carry numeric bounds';
    }
    return null;
  }

  if (
    low === undefined &&
    high === undefined &&
    median === undefined &&
    centralValue === undefined
  ) {
    return 'At least one of low, high or median is required';
  }
  if (low !== undefined && high !== undefined && low > high) {
    return 'low cannot be greater than high';
  }
  // A central estimate must lie within its own reported interval.
  if (median !== undefined) {
    if (low !== undefined && median < low) return 'median must lie within low..high';
    if (high !== undefined && median > high) return 'median must lie within low..high';
  }
  if (centralValue !== undefined) {
    if (low !== undefined && centralValue < low) {
      return 'centralValue must lie within low..high';
    }
    if (high !== undefined && centralValue > high) {
      return 'centralValue must lie within low..high';
    }
  }
  // A qualifier ('<', '≥', …) marks a single CENSORED THRESHOLD, not an
  // interval. Aggregation excludes such rows from the pool and the formatters
  // render only one value, so a distinct low..high would be silently dropped.
  // Require every provided bound to agree (one threshold value, or equal bounds).
  if (qualifier !== undefined) {
    const vals = [low, high, median, centralValue].filter(
      (x): x is number => x !== undefined,
    );
    if (!vals.every((x) => x === vals[0])) {
      return 'A qualified (censored) entry must carry a single threshold value';
    }
  }
  return null;
}

function withValueInvariants<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((v, ctx) => {
    const message = validateEntryValueInvariants(v as EntryBoundFields);
    if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  });
}

/**
 * Apply the registry-driven rules to a schema that carries `parameter` (every
 * create/input payload). Update payloads have no parameter and are checked at
 * the write boundary against the target row's — see validateEntryForParameter.
 */
function withParameterRules<T extends z.ZodTypeAny>(schema: T) {
  return schema.superRefine((v, ctx) => {
    const o = v as EntryValueFields & { parameter?: string };
    if (!o.parameter) return;
    const message = validateEntryForParameter(o.parameter, o);
    if (message) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  });
}

/**
 * An entry's value fields WITHOUT the drug and citation it belongs to, under
 * exactly the same registry rules and interval invariants as a real entry.
 *
 * For callers that must validate a source value before those ids exist: the
 * deep-research importer validates its `sourceValues[]` while still pure and
 * DB-free, and only resolves `sourceId` → citation (and the drug) at write
 * time. Sharing the schema is the point — a value the importer accepts is one
 * the entry store will accept, with no second copy of the rules to drift.
 */
export const parameterEntrySourceValueSchema = withParameterRules(
  withValueInvariants(
    z.object({
      parameter: baseEntryShape.parameter,
      low: baseEntryShape.low,
      high: baseEntryShape.high,
      median: baseEntryShape.median,
      qualifier: baseEntryShape.qualifier,
      categoricalValue: baseEntryShape.categoricalValue,
      unit: baseEntryShape.unit,
      matrix: baseEntryShape.matrix,
      scenario: baseEntryShape.scenario,
      route: baseEntryShape.route,
      n: baseEntryShape.n,
      comments: baseEntryShape.comments,
      observationContext: baseEntryShape.observationContext,
      quote: baseEntryShape.quote,
      ...doseContextShape,
    }),
  ),
);
export type ParameterEntrySourceValue = z.infer<
  typeof parameterEntrySourceValueSchema
>;

/** Full entry payload including the target drug (create). */
export const parameterEntryInputSchema = withParameterRules(
  withValueInvariants(
    z.object({ drugId: z.number().int().positive(), ...baseEntryShape }),
  ),
);
export type ParameterEntryInput = z.infer<typeof parameterEntryInputSchema>;

// Request-only extras: how the write should be applied. Stripped before the
// payload is stored/re-validated, matching the bio_entity write pattern.
const writeExtras = {
  editSummary: z.string().max(500).optional(),
  submitForReview: z.boolean().optional(),
};

/**
 * The POST body. Deliberately NOT wrapped in `withParameterRules`: a zod issue
 * surfaces as an uncoded 400 whose raw English message the editor would have to
 * print verbatim. The endpoint runs `validateEntryForParameter` itself and
 * returns `param_entry_invalid_for_parameter`, so a Norwegian contributor gets
 * the translated message — the same treatment the PATCH path already gives.
 * The STORED payload (`parameterEntryInputSchema`) keeps the rules inline, so a
 * queued proposal is still re-validated against the registry at approval.
 */
export const parameterEntryCreateRequestSchema = withValueInvariants(
  z.object({
    drugId: z.number().int().positive(),
    ...baseEntryShape,
    ...writeExtras,
  }),
);
export type ParameterEntryCreateRequest = z.infer<
  typeof parameterEntryCreateRequestSchema
>;

/** Fields of an entry that can change (update); drug + parameter are immutable. */
export const parameterEntryPatchSchema = withValueInvariants(
  z.object({
    low: baseEntryShape.low,
    high: baseEntryShape.high,
    median: baseEntryShape.median,
    qualifier: baseEntryShape.qualifier,
    categoricalValue: baseEntryShape.categoricalValue,
    unit: baseEntryShape.unit,
    matrix: baseEntryShape.matrix,
    scenario: baseEntryShape.scenario,
    route: baseEntryShape.route,
    n: baseEntryShape.n,
    comments: baseEntryShape.comments,
    observationContext: baseEntryShape.observationContext,
    quote: baseEntryShape.quote,
    citationId: baseEntryShape.citationId,
    ...doseContextShape,
  }),
);
export type ParameterEntryPatch = z.infer<typeof parameterEntryPatchSchema>;

export const parameterEntryUpdateRequestSchema = withValueInvariants(
  z.object({
    low: baseEntryShape.low,
    high: baseEntryShape.high,
    median: baseEntryShape.median,
    qualifier: baseEntryShape.qualifier,
    categoricalValue: baseEntryShape.categoricalValue,
    unit: baseEntryShape.unit,
    matrix: baseEntryShape.matrix,
    scenario: baseEntryShape.scenario,
    route: baseEntryShape.route,
    n: baseEntryShape.n,
    comments: baseEntryShape.comments,
    observationContext: baseEntryShape.observationContext,
    quote: baseEntryShape.quote,
    citationId: baseEntryShape.citationId,
    ...doseContextShape,
    ...writeExtras,
  }),
);
export type ParameterEntryUpdateRequest = z.infer<
  typeof parameterEntryUpdateRequestSchema
>;

/**
 * The `proposed_value` stored on a `param_entry` pending edit and re-validated
 * on approval. Discriminated by `op` — matching the `pending_edits_open_entry_idx`
 * predicate that lets `create` proposals coexist while limiting update/delete to
 * one open edit per entry. `targetId` on the pending row carries the drug id
 * (create) or the entry id (update/delete).
 */
export const parameterEntryEditSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), input: parameterEntryInputSchema }),
  z.object({ op: z.literal('update'), patch: parameterEntryPatchSchema }),
  z.object({ op: z.literal('delete') }),
]);
export type ParameterEntryEdit = z.infer<typeof parameterEntryEditSchema>;

/**
 * The refusal codes a stored `param_entry` payload can earn on its way to
 * publication. They are the API's own error codes, so a caller can hand one
 * straight to the review UI's `REVIEW_ERROR_KEYS` map.
 */
export type ParameterEntryPayloadCode =
  | 'param_entry_invalid_payload'
  | 'param_entry_target_mismatch'
  | 'param_entry_invalid_for_parameter'
  | 'param_entry_citation_mismatch';

export interface ParameterEntryPayloadProblem {
  code: ParameterEntryPayloadCode;
  /**
   * English prose naming the broken rule, for an API error body. NOT for the
   * UI: a React caller renders the localized string its `code` maps to (see
   * the i18n rule in AGENTS.md) and `fields` beside it.
   */
  message: string;
  /**
   * The payload keys the schema rejected (`qualifier`, `unit`, …), when it can
   * say — language-neutral identifiers, so a Norwegian reviewer can be told
   * WHICH field to correct without English prose. Empty when the refusal is
   * about the payload as a whole (bounds that disagree, a mismatched target)
   * rather than a named key.
   */
  fields: string[];
}

/**
 * The payload keys a zod failure blames, outermost wrapper dropped: an issue on
 * `input.qualifier` is a problem with `qualifier`, the key the author wrote.
 * Issues raised by the cross-field refinements carry no path and add nothing.
 */
function issueFields(issues: readonly z.ZodIssue[]): string[] {
  const fields: string[] = [];
  for (const issue of issues) {
    const path = issue.path.filter(
      (segment): segment is string =>
        typeof segment === 'string' && segment !== 'input' && segment !== 'patch',
    );
    const field = path.join('.');
    if (field && !fields.includes(field)) fields.push(field);
  }
  return fields;
}

/** What a `param_entry` pending row says its payload is allowed to publish. */
export interface ParameterEntryProposalTarget {
  /** The queued parameter (`pending_edits.parameter`). */
  parameter: string | null;
  /** The queued target: the drug for a `create`, the entry for update/delete. */
  targetId: number | null;
  /** Every reference the row advertises; the payload may cite only these. */
  referenceIds: number[];
}

/**
 * The references a queued row effectively advertises, for
 * `ParameterEntryProposalTarget.referenceIds`.
 *
 * An EMPTY `referenceIds` array means "never set", not "no references": every
 * reader on the server side falls back to the singular `referenceId` when the
 * array is missing OR empty (`readEffectiveReferenceIds` and the two queue
 * hydrations in `api/pending-edits.ts`). A plain `??` here keeps the empty
 * array instead, which hands the inspector an empty reference set and refuses
 * a payload the approval would accept — a legacy row (singular `reference_id`,
 * `reference_ids = '{}'`) would be labelled unpublishable on the card for
 * citing the very source it lists.
 */
export function effectiveProposalReferenceIds(row: {
  referenceIds?: number[] | null;
  referenceId?: number | null;
}): number[] {
  if (row.referenceIds && row.referenceIds.length > 0) return row.referenceIds;
  return row.referenceId != null ? [row.referenceId] : [];
}

/**
 * `param_entry` proposals are a discriminated union on `op`; read it back
 * loosely (never trust the JSON shape beyond that one string field).
 *
 * Lives here rather than beside one of its callers because the op decides
 * what `pending_edits.targetId` MEANS — the drug id for a create, the entry
 * id for an update or delete — and every reader that resolves that column has
 * to agree: the escalation feed's candidate scoping and the verification
 * queue's baseline hydration both key off it.
 */
export function paramEntryOp(
  proposedValue: unknown,
): 'create' | 'update' | 'delete' | null {
  if (proposedValue == null || typeof proposedValue !== 'object') return null;
  const op = (proposedValue as Record<string, unknown>).op;
  return op === 'create' || op === 'update' || op === 'delete' ? op : null;
}

/**
 * Every reason the approval would refuse a stored `param_entry` payload that
 * can be decided WITHOUT the database: the payload schema (which carries the
 * registry rules for a create), the create's drug/parameter target, the
 * registry rules for an update (resolved against the queued parameter, as an
 * update patch carries none), and the payload's citation against the
 * references the row lists.
 *
 * One implementation for three callers that must agree, or the same payload
 * would be accepted by one and refused by another: the submitter's PATCH gate
 * and the reviewer's return-with-changes gate in `api/pending-edits.ts`, and
 * the review card, which runs it as a preflight so a reviewer sees an
 * unpublishable proposal before pressing approve rather than after. The
 * DB-dependent refusals (duplicate, target still present, applicability, the
 * source-read gate) stay at approval.
 *
 * Returns the first problem, or null when nothing here would refuse it.
 */
export function inspectParameterEntryPayload(
  target: ParameterEntryProposalTarget,
  proposedValue: unknown,
): ParameterEntryPayloadProblem | null {
  const parsed = parameterEntryEditSchema.safeParse(proposedValue);
  if (!parsed.success) {
    return {
      code: 'param_entry_invalid_payload',
      message:
        'Invalid source-value payload: ' +
        parsed.error.issues
          .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
          .join('; '),
      fields: issueFields(parsed.error.issues),
    };
  }

  if (parsed.data.op === 'create') {
    if (
      parsed.data.input.drugId !== target.targetId ||
      parsed.data.input.parameter !== target.parameter
    ) {
      return {
        code: 'param_entry_target_mismatch',
        message:
          'Source-value payload no longer matches the queued drug/parameter.',
        fields: [],
      };
    }
  }

  // An update patch carries no `parameter` (drug + parameter are immutable on
  // an entry), so the registry rules are checked against the pending row's —
  // the same parameter the approval resolves from the live entry.
  if (parsed.data.op === 'update' && target.parameter) {
    const invalid = validateEntryForParameter(
      target.parameter,
      parsed.data.patch,
    );
    if (invalid) {
      return {
        code: 'param_entry_invalid_for_parameter',
        message: invalid,
        fields: [],
      };
    }
  }

  const citationId =
    parsed.data.op === 'create'
      ? parsed.data.input.citationId
      : parsed.data.op === 'update'
        ? parsed.data.patch.citationId
        : null;
  if (citationId != null && !target.referenceIds.includes(citationId)) {
    return {
      code: 'param_entry_citation_mismatch',
      message:
        `Source-value payload cites reference #${citationId}, which this ` +
        'proposal does not list. Send the same id in referenceIds.',
      fields: ['citationId'],
    };
  }

  return null;
}
